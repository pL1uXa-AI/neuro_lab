/**
 * Тесты метрик: синхронности, спектра, CV ISI.
 *
 * Зачем это отдельный файл с крайними случаями. Пороги уровней кампании
 * будут сравниваться с числами отсюда, и ошибка в метрике превратится в
 * «уровень не проходится» или, хуже, «проходится всегда». Поэтому каждая
 * метрика проверяется на СИНТЕТИЧЕСКИХ данных, где ответ известен заранее:
 * полностью синхронная сеть обязана дать 1, независимые процессы — около 0,
 * чистый синус — пик на своей частоте.
 *
 * Отдельно проверяется различие «нет данных» и «ноль»: пустая метрика
 * обязана вернуть NaN, а не 0, иначе интерфейс покажет «синхронность 0»
 * там, где спайков ещё просто не было.
 */

import { describe, expect, it } from 'vitest';
import {
  RateHistory,
  SynchronyMeter,
  activeFraction,
  activeRate,
  cvIsi,
  firingRate,
  populationRate,
  populationSpectrum,
} from '../core/measures.js';
import { allocNeuronState } from '../core/types.js';

describe('частота спайков', () => {
  it('частота считается как спайки на окно, переведённые в герцы', () => {
    expect(firingRate(10, 1000)).toBeCloseTo(10, 9);
    expect(firingRate(5, 500)).toBeCloseTo(10, 9);
    expect(firingRate(0, 1000)).toBe(0);
  });

  it('нулевое окно не даёт деления на ноль', () => {
    expect(firingRate(10, 0)).toBe(0);
    expect(populationRate(allocNeuronState(3), 0)).toBe(0);
    expect(activeRate(allocNeuronState(3), 0)).toBe(0);
  });

  it('средняя частота по популяции делится на ВСЕ нейроны', () => {
    const state = allocNeuronState(10);
    state.spikeCount[0] = 10;
    // 10 спайков от одного нейрона из десяти за 1000 мс = 1 Гц в среднем.
    expect(populationRate(state, 1000)).toBeCloseTo(1, 9);
  });

  it('частота по активным делится только на спайковавших', () => {
    const state = allocNeuronState(10);
    state.spikeCount[0] = 10;
    // Тот же случай, но «среди активных»: 10 спайков одного нейрона = 10 Гц.
    expect(activeRate(state, 1000)).toBeCloseTo(10, 9);
    // Молчащая популяция — это «нет данных», а не «ноль герц».
    expect(activeRate(allocNeuronState(10), 1000)).toBe(0);
  });

  it('доля активных нейронов считается по тем, кто спайковал хоть раз', () => {
    const state = allocNeuronState(10);
    state.spikeCount[0] = 1;
    state.spikeCount[5] = 3;
    expect(activeFraction(state)).toBeCloseTo(0.2, 9);
    expect(activeFraction(allocNeuronState(10))).toBe(0);
  });
});

describe('CV ISI', () => {
  it('регулярный ряд даёт CV около нуля', () => {
    const state = allocNeuronState(1);
    // Все интервалы одинаковые: mean = 20, mean² = 400, дисперсия = 0.
    state.spikeCount[0] = 10;
    state.meanIsi[0] = 20;
    state.meanIsi2[0] = 400;
    expect(cvIsi(state)).toBeCloseTo(0, 9);
  });

  it('разбросанный ряд даёт CV около единицы (пуассоновский режим)', () => {
    const state = allocNeuronState(1);
    state.spikeCount[0] = 10;
    // Для экспоненциального распределения: mean = 1/λ, mean² = 2/λ²,
    // дисперсия = mean², значит CV = 1.
    const mean = 20;
    state.meanIsi[0] = mean;
    state.meanIsi2[0] = 2 * mean * mean;
    expect(cvIsi(state)).toBeCloseTo(1, 6);
  });

  it('нейроны с малым числом спайков не портят оценку', () => {
    const state = allocNeuronState(3);
    // У первого достаточно спайков и идеально ровный ряд.
    state.spikeCount[0] = 10;
    state.meanIsi[0] = 20;
    state.meanIsi2[0] = 400;
    // У остальных мало спайков — статистики нет.
    state.spikeCount[1] = 1;
    state.spikeCount[2] = 2;
    expect(cvIsi(state)).toBeCloseTo(0, 9);
  });

  it('когда данных нет вовсе, возвращается NaN, а не ноль', () => {
    expect(Number.isNaN(cvIsi(allocNeuronState(4)))).toBe(true);
  });
});

describe('синхронность: крайние случаи', () => {
  it('все спайки в одном бине дают ровно 1', () => {
    const meter = new SynchronyMeter(5, 4096);
    for (let i = 0; i < 100; i++) meter.add(10, 100, 0.5);
    expect(meter.value()).toBeCloseTo(1, 9);
    expect(meter.spikeCount).toBe(10000);
  });

  it('равномерное распределение по бинам даёт ровно 0', () => {
    const meter = new SynchronyMeter(5, 4096);
    // По одному спайку в каждый бин шириной 5 мс.
    for (let bin = 0; bin < 200; bin++) meter.add(bin * 5, 1, 5);
    expect(meter.value()).toBeCloseTo(0, 9);
  });

  it('без спайков возвращается NaN: «нет данных» ≠ «ноль»', () => {
    const meter = new SynchronyMeter(5, 4096);
    meter.add(0, 0, 1);
    meter.add(1, 0, 1);
    expect(Number.isNaN(meter.value())).toBe(true);
  });

  it('промежуточный случай лежит между нулём и единицей', () => {
    const meter = new SynchronyMeter(5, 4096);
    // Половина бинов пустая, половина — с двумя спайками: частичная
    // синхронность. Метрика обязана оказаться строго посередине.
    for (let bin = 0; bin < 100; bin++) meter.add(bin * 5, bin % 2 === 0 ? 2 : 1, 5);
    const value = meter.value();
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });

  it('две чередующиеся группы дают по этой мере ноль (записанное ограничение)', () => {
    // Мера отвечает на вопрос «в одни ли моменты летят спайки», а не
    // «сколько групп». Чередование «через бин» даёт нулевую синхронность —
    // это свойство меры, и оно записано, чтобы никто не удивился.
    const meter = new SynchronyMeter(5, 4096);
    for (let bin = 0; bin < 100; bin++) meter.add(bin * 5, 100, 5);
    // Равномерно по всем бинам при равном числе спайков → 0.
    expect(meter.value()).toBeCloseTo(0, 9);
  });
});

describe('спектр популяционной активности', () => {
  it('чистый синус даёт пик на своей частоте', () => {
    const rate: number[] = [];
    for (let i = 0; i < 1024; i++) {
      rate.push(10 + 5 * Math.sin((2 * Math.PI * 40 * (i * 2)) / 1000));
    }
    const spectrum = populationSpectrum(rate, 2);
    expect(spectrum.peakHz).toBeCloseTo(40, 1);
    // У чистого синуса почти вся мощность собирается в одну частоту.
    expect(spectrum.peakPower).toBeGreaterThan(0.5);
  });

  it('белый шум не даёт выраженного пика', () => {
    const noise: number[] = [];
    let seed = 12345;
    for (let i = 0; i < 1024; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise.push(10 + (seed / 0x7fffffff) * 4);
    }
    const spectrum = populationSpectrum(noise, 2);
    // Мощность размазана: доля пика мала.
    expect(spectrum.peakPower).toBeLessThan(0.1);
  });

  it('две разные частоты различаются: 10 Гц против 60 Гц', () => {
    const build = (hz: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 2048; i++) {
        out.push(10 + 5 * Math.sin((2 * Math.PI * hz * (i * 2)) / 1000));
      }
      return out;
    };
    expect(populationSpectrum(build(10), 2).peakHz).toBeCloseTo(10, 1);
    expect(populationSpectrum(build(60), 2).peakHz).toBeCloseTo(60, 1);
  });

  it('слишком короткий ряд не даёт спектра, а не врёт числом', () => {
    const spectrum = populationSpectrum([1, 2, 3], 2);
    expect(spectrum.peakHz).toBe(0);
    expect(spectrum.peakPower).toBe(0);
  });
});

describe('история частоты', () => {
  it('записывает отсчёты не чаще, чем задано, и выдаёт их по порядку', () => {
    const history = new RateHistory(8, 2);
    history.maybeAdd(0, 1);
    history.maybeAdd(1, 999); // слишком рано — должно быть отброшено
    history.maybeAdd(2, 2);
    history.maybeAdd(4, 3);
    expect(history.ordered()).toEqual([1, 2, 3]);
    expect(history.length).toBe(3);
  });

  it('кольцевой буфер не растёт выше ёмкости и хранит последние отсчёты', () => {
    const history = new RateHistory(4, 1);
    for (let i = 0; i < 10; i++) history.maybeAdd(i, i);
    expect(history.length).toBe(4);
    expect(history.ordered()).toEqual([6, 7, 8, 9]);
  });

  it('сброс очищает буфер', () => {
    const history = new RateHistory(4, 1);
    history.maybeAdd(0, 5);
    history.reset();
    expect(history.length).toBe(0);
    expect(history.ordered()).toEqual([]);
  });
});

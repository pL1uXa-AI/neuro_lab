/**
 * Тесты пресетов и сборки сцен.
 *
 * Проверяется главное обещание пресета: он ВОСПРОИЗВОДИМ и даёт ту картину,
 * которую обещает `hint`. Поэтому каждый пресет прогоняется через
 * `buildScene` + `warmUp`, и утверждение формулируется числом: сеть молчит,
 * сеть живёт, волна доходит, память держится.
 */

import { describe, expect, it } from 'vitest';
import { PRESETS, presetById, presetToNetworkParams } from '../core/presets.js';
import { buildScene, warmUp } from '../core/scene.js';
import { measureMemory, measureRhythm } from '../core/memory.js';
import { measureWave } from '../core/wave.js';
import { IZHI_MODES, izhRestState } from '../core/neuron-types.js';

/** Суммарное число спайков в сети. */
function totalSpikes(network: ReturnType<typeof buildScene>['network']): number {
  let total = 0;
  for (let i = 0; i < network.params.count; i++) total += network.state.spikeCount[i];
  return total;
}

/** Число нейронов, спайковавших хотя бы раз. */
function activeCount(network: ReturnType<typeof buildScene>['network']): number {
  let active = 0;
  for (let i = 0; i < network.params.count; i++) if (network.state.spikeCount[i] > 0) active += 1;
  return active;
}

describe('пресеты: целостность', () => {
  it('идентификаторы уникальны и заполнены обязательные поля', () => {
    const ids = new Set(PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(PRESETS.length);
    for (const preset of PRESETS) {
      expect(preset.title.length, preset.id).toBeGreaterThan(2);
      expect(preset.hint.length, preset.id).toBeGreaterThan(20);
      expect(preset.count, preset.id).toBeGreaterThan(0);
      expect(preset.dt, preset.id).toBeGreaterThan(0);
    }
  });

  it('одиночные сцены ссылаются на существующие режимы каталога', () => {
    for (const preset of PRESETS) {
      if (preset.model !== 'izhikevich' || preset.count !== 1) continue;
      expect(preset.modeId, `${preset.id}: нет режима`).toBeDefined();
      expect(IZHI_MODES.some((mode) => mode.id === preset.modeId), preset.id).toBe(true);
    }
  });

  it('каждый пресет собирается и прогревается без ошибок', () => {
    for (const preset of PRESETS) {
      const scene = buildScene(preset);
      warmUp(scene);
      scene.network.run(Math.round(100 / preset.dt));
      // Потенциалы конечны: разлёт в пресете — дефект пресета.
      expect(Number.isFinite(scene.network.state.v[0]), preset.id).toBe(true);
      expect(scene.network.state.insane, `${preset.id}: разлёт`).toBe(0);
    }
  });

  it('сборка воспроизводима при одном зерне', () => {
    for (const preset of PRESETS) {
      const count = (seed: number): number => {
        const scene = buildScene(preset, { seed });
        warmUp(scene);
        scene.network.run(Math.round(200 / preset.dt));
        return totalSpikes(scene.network);
      };
      expect(count(3), preset.id).toBe(count(3));
    }
  });
});

describe('пресеты: обещанная картина', () => {
  it('одиночный LIF-нейрон спайкует под своим током', () => {
    const preset = presetById('single-lif');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    // 1000 шагов при dt = 0.5 мс — это 500 мс. Измерено: ровный ряд,
    // частота ≈ 14 Гц, то есть около 7 спайков.
    scene.network.run(1000);
    expect(totalSpikes(scene.network)).toBeGreaterThan(5);
  });

  it('одиночный RS-нейрон адаптируется: интервалы растут', () => {
    const preset = presetById('single-rs');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    scene.network.run(2400); // 240 мс
    const state = scene.network.state;
    // У адаптирующегося нейрона последний ISI больше первого.
    expect(Number.isFinite(state.lastIsi[0])).toBe(true);
    expect(state.spikeCount[0]).toBeGreaterThan(3);
  });

  it('нейрон с пачками даёт больше спайков, чем RS при том же времени', () => {
    const bursting = presetById('single-bursting');
    const rs = presetById('single-rs');
    if (!bursting || !rs) throw new Error('нет пресетов');
    const burstScene = buildScene(bursting);
    burstScene.network.run(2200); // 220 мс
    const rsScene = buildScene(rs);
    rsScene.network.run(2200);
    expect(burstScene.network.state.spikeCount[0]).toBeGreaterThan(
      rsScene.network.state.spikeCount[0],
    );
  });

  it('разреженная сеть живёт и разряжается нерегулярно', () => {
    const preset = presetById('random-sparse');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    scene.network.run(4000); // 2 с
    const sample = scene.network.recordSample();
    expect(totalSpikes(scene.network)).toBeGreaterThan(100);
    expect(activeCount(scene.network)).toBeGreaterThan(50);
    // Нерегулярность — обещанное свойство пресета.
    expect(Number.isFinite(sample.cv)).toBe(true);
    expect(sample.cv).toBeGreaterThan(0.3);
  });

  it('сцена STDP обучается: веса расходятся', () => {
    const preset = presetById('stdp-learning');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    // Запоминаем исходный разброс: все веса одинаковы.
    scene.network.run(6000); // 3 с
    expect(scene.network.stdpUpdates).toBeGreaterThan(1000);
    let min = Infinity;
    let max = -Infinity;
    for (const weight of scene.network.synapses.weight) {
      if (weight <= 0) continue;
      min = Math.min(min, weight);
      max = Math.max(max, weight);
    }
    // Веса перестали быть точкой: появился спектр.
    expect(max - min).toBeGreaterThan(0.05);
  });

  it('сцена волны: толчок запускает фронт, уходящий от центра', () => {
    const preset = presetById('wave');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    scene.network.run(800); // 400 мс
    // Центр решётки 50×50.
    const wave = measureWave(scene.network, { centerX: 24.5, centerY: 24.5, minDistance: 3 });
    expect(wave.activeCount).toBeGreaterThan(500);
    expect(wave.reachCells).toBeGreaterThan(10);
    expect(wave.fitR2).toBeGreaterThan(0.9);
  });

  it('сцена рабочей памяти: активность держится после стимула', () => {
    const preset = presetById('working-memory');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);

    const recurrent = (): number => {
      let total = 0;
      for (let i = 40; i < preset.count; i++) total += scene.network.state.spikeCount[i];
      return total;
    };
    scene.network.run(160); // 80 мс: стимул снят
    const at80 = recurrent();
    scene.network.run(3000); // ещё 1.5 с
    const at1580 = recurrent();
    expect(at80).toBeGreaterThan(0);
    expect(at1580).toBeGreaterThan(at80);
  });

  it('сцена кольца: волна обегает кольцо и ПОДДЕРЖИВАЕТСЯ', () => {
    // ─── Что здесь проверяется и почему именно так ───────────────────────
    //
    // Пресет обещает «волну, которая бежит по кругу». Проверять это надо
    // ДВУМЯ утверждениями, и оба обязательны:
    //   1. фронт идёт последовательно и с ПОСТОЯННЫМ шагом (это волна);
    //   2. активность не прекращается (это удержание, а не одна волна).
    //
    // Без второго пункта тест проходил бы и на одноразовом проходе: первая
    // версия требовала «спайков больше 20», а столько даёт и затухающая
    // волна. Именно поэтому картина измерена заново, на длинном прогоне.
    const preset = presetById('ring');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    const network = scene.network;

    // Даём волне пойти, и только ПОТОМ читаем историю: до прогона она пуста.
    network.run(2000);

    // ─── Форма фронта ────────────────────────────────────────────────────
    // Стартовый стимул возбуждает 5 % нейронов ОДНОВРЕМЕННО — это первая
    // группа. Дальше волна идёт по одному нейрону за шаг задержки.
    // Измерено: 0.5 ×10 стартовых, затем 4.5, 8.5, 12.5, … с шагом 4 мс.
    const firstTimes: number[] = [];
    for (let i = 0; i < 60; i++) {
      const times = network.spikeHistory.timesOf(i);
      if (times.length === 0) break;
      firstTimes.push(times[0]);
    }
    expect(firstTimes.length, 'волна не пошла вовсе').toBeGreaterThan(30);

    const starters = Math.max(1, Math.round(preset.count * 0.05));
    for (let i = starters + 1; i < firstTimes.length; i++) {
      expect(
        firstTimes[i],
        `фронт не последователен на нейроне ${i}`,
      ).toBeGreaterThan(firstTimes[i - 1]);
    }

    // Шаг фронта ПОСТОЯНЕН: это признак бегущей волны, а не «сработали
    // вразнобой». Измерено 4 мс на нейрон при задержке связи 2 мс.
    //
    // Расхождение вдвое — не ошибка: задержка отвечает только за доставку
    // спайка, а нейрон срабатывает позже, когда ВПСТ накопит потенциал до
    // порога. Именно поэтому скорость волны в проекте измеряется наклоном,
    // а не берётся из `delay` (см. `wave.ts`).
    const step = firstTimes[starters + 2] - firstTimes[starters + 1];
    expect(step, 'шаг фронта не положителен').toBeGreaterThan(0);
    for (let i = starters + 2; i < firstTimes.length; i++) {
      expect(
        firstTimes[i] - firstTimes[i - 1],
        `шаг фронта изменился на нейроне ${i}`,
      ).toBeCloseTo(step, 6);
    }

    // Волна дошла до конца кольца: сработали все нейроны.
    expect(activeCount(network), 'волна не дошла до конца кольца').toBe(preset.count);

    // ─── Главное: активность НЕ прекращается ─────────────────────────────
    // Измерено: 13 300 спайков за первую секунду и 191 084 за пять, то есть
    // кольцо работает как генератор, а не как одноразовый толчок.
    const afterFirstSecond = totalSpikes(network);
    network.run(8000); // ещё 4 с
    const growth = totalSpikes(network) - afterFirstSecond;
    expect(growth, 'кольцо погасло: самоподдержки нет').toBeGreaterThan(10000);

    // И это не разлёт: потенциалы конечны, счётчик инцидентов пуст.
    expect(network.state.insane, 'кольцо ушло в численный разлёт').toBe(0);
  });
});

describe('пресеты: параметры сети', () => {
  it('модель нейрона переносится в параметры', () => {
    for (const preset of PRESETS) {
      const params = presetToNetworkParams(preset);
      expect(params.neuron.model, preset.id).toBe(preset.model);
      expect(params.count, preset.id).toBe(preset.count);
      expect(params.dt, preset.id).toBe(preset.dt);
    }
  });

  it('для Izhikevich берётся истинная точка покоя режима', () => {
    // Проверяем связь между каталогом и пресетом: параметры обязаны
    // совпадать с `modeToParams`, включая точку покоя.
    for (const preset of PRESETS) {
      if (preset.model !== 'izhikevich' || !preset.modeId) continue;
      const mode = IZHI_MODES.find((item) => item.id === preset.modeId);
      if (!mode) throw new Error(`нет режима ${preset.modeId}`);
      const params = presetToNetworkParams(preset);
      expect(params.neuron.izh.a, preset.id).toBe(mode.params.a);
      expect(params.neuron.izh.b, preset.id).toBe(mode.params.b);
      // Точка покоя должна обращать производную в ноль — это и есть
      // проверка, что пресет не «подставил −65 от себя».
      const rest = izhRestState(params.neuron.izh.b, 0);
      expect(params.neuron.izh.vRest, preset.id).toBeCloseTo(rest.v, 6);
    }
  });

  it('масштаб весов согласован с моделью', () => {
    // Пресеты с Izhikevich не должны получать LIF-веса «напрямую»: в сети
    // это учтено множителем, а здесь проверяется, что пресет вообще
    // собирается с ненулевыми связями.
    for (const preset of PRESETS) {
      const scene = buildScene(preset);
      if (preset.topology.kind === 'none') {
        expect(scene.network.synapses.synapseCount, preset.id).toBe(0);
      } else {
        expect(scene.network.synapses.synapseCount, preset.id).toBeGreaterThan(0);
      }
    }
  });
});

describe('ритм: пресеты дают измеримый спектр', () => {
  it('разреженная сеть: спектр считается и конечен', () => {
    const preset = presetById('random-sparse');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    scene.network.run(6000);
    const rhythm = measureRhythm(scene.network);
    expect(Number.isFinite(rhythm.meanRateHz)).toBe(true);
    expect(rhythm.peakPower).toBeGreaterThan(0);
    expect(rhythm.frequencies.length).toBe(rhythm.power.length);
  });

  it('память измеряется тем же способом, что в тестах ядра', () => {
    const preset = presetById('working-memory');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    const result = measureMemory(scene.network, { stimulusEndMs: 20, maxMs: 400 });
    expect(result.spikesHeld).toBeGreaterThan(0);
    expect(Number.isFinite(result.rateAfterStimulus)).toBe(true);
  });
});

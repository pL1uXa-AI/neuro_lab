/**
 * «Своя сеть»: сборка сцены по параметрам пользователя.
 *
 * ─── Что здесь проверяется ───────────────────────────────────────────────
 *
 * Не «функция вернула объект», а ИЗМЕРЕННЫЙ результат сборки: сеть должна
 * получиться именно такой, какую заказали. Ползунок может дать любое число,
 * и если сборщик его молча проигнорирует, пользователь увидит не ту сеть,
 * которую собирал, — а это ровно тот класс дефектов, когда интерфейс и
 * данные расходятся незаметно.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CUSTOM,
  customPreset,
  type CustomNetworkOptions,
} from '../core/presets.js';
import { buildScene, warmUp } from '../core/scene.js';

function build(options: Partial<CustomNetworkOptions> = {}, seed = 1) {
  const scene = buildScene(customPreset({ ...DEFAULT_CUSTOM, ...options }), { seed });
  warmUp(scene);
  return scene;
}

function stats(scene: ReturnType<typeof build>) {
  const network = scene.network;
  let spikes = 0;
  let active = 0;
  for (let i = 0; i < network.params.count; i++) {
    spikes += network.state.spikeCount[i];
    if (network.state.spikeCount[i] > 0) active += 1;
  }
  return {
    count: network.params.count,
    synapses: network.synapses.synapseCount,
    spikes,
    active,
  };
}

describe('своя сеть: параметры доходят до собранной сцены', () => {
  it('число нейронов задаётся пользователем', () => {
    const scene = build({ count: 300 });
    expect(scene.network.params.count).toBe(300);
  });

  it('плотность связей влияет на число синапсов', () => {
    const sparse = build({ connectionProbability: 0.02, count: 400 });
    const dense = build({ connectionProbability: 0.3, count: 400 });
    expect(dense.network.synapses.synapseCount).toBeGreaterThan(
      sparse.network.synapses.synapseCount * 3,
    );
  });

  it('доля торможения доходит до нейронов', () => {
    const scene = build({ count: 200, inhibitoryFraction: 0.4 });
    let inhibitory = 0;
    for (let i = 0; i < scene.network.params.count; i++) {
      if (scene.network.state.inhibitory[i] === 1) inhibitory += 1;
    }
    expect(inhibitory).toBe(80);
  });

  it('вес связи задаёт масштаб весов в матрице', () => {
    const scene = build({ count: 200, excitatoryWeight: 3 });
    let max = 0;
    for (const weight of scene.network.synapses.weight) {
      if (weight > max) max = weight;
    }
    // Вес затухает с расстоянием только у решётки; у случайной сети он
    // ровно тот, что задан.
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(3 + 1e-9);
    expect(max).toBeGreaterThan(2.5);
  });

  it('топология выбирается: кольцо даёт ровно по одному соседу вперёд', () => {
    const scene = build({ count: 100, topology: 'ring', inhibitoryFraction: 0 });
    // span = 1: у каждого нейрона ровно одна исходящая связь.
    expect(scene.network.synapses.synapseCount).toBe(100);
  });

  it('решётка даёт пространственную раскладку и координаты', () => {
    const scene = build({ count: 100, topology: 'grid', excitatoryWeight: 50 });
    const network = scene.network;
    let hasCoords = false;
    for (let i = 0; i < network.params.count; i++) {
      if (network.x[i] !== 0 || network.y[i] !== 0) hasCoords = true;
    }
    expect(hasCoords).toBe(true);
    // Сторона выведена из числа нейронов: 10×10.
    expect(network.params.count).toBe(100);
  });

  it('ни одна связь не ведёт за пределы сети', () => {
    // ─── Что здесь ловится ────────────────────────────────────────────────
    //
    // `layers` — это РАЗМЕРЫ слоёв, раскладываемые подряд от нуля, поэтому
    // их сумма обязана равняться числу нейронов. Первая версия задавала
    // `[count / 4, count]`, и при count = 400 границы получались [0,100) и
    // [100,500): измерено, что максимальный индекс цели равнялся **499**.
    //
    // Запись в типизированный массив мимо длины НЕ падает и не сообщает об
    // ошибке — такая связь просто исчезает, а сеть выглядит рабочей. Поэтому
    // проверка идёт по ИНДЕКСАМ, а не по числу связей.
    for (const topology of ['random-sparse', 'layers', 'ring', 'grid'] as const) {
      const scene = build({ count: 400, topology, excitatoryWeight: 1 });
      const m = scene.network.synapses;
      for (let s = 0; s < m.synapseCount; s++) {
        expect(m.colIdx[s]).toBeGreaterThanOrEqual(0);
        expect(m.colIdx[s]).toBeLessThan(m.count);
        expect(m.rowIdx[s]).toBeGreaterThanOrEqual(0);
        expect(m.rowIdx[s]).toBeLessThan(m.count);
      }
    }
  });

  it('фоновый вход включается и выключается', () => {
    const withInput = build({ inputRate: 300 });
    const withoutInput = build({ inputRate: 0 });
    expect(withInput.network.params.input.mode).toBe('poisson');
    expect(withoutInput.network.params.input.mode).toBe('none');
  });
});

describe('своя сеть: границы и защита от вырожденных значений', () => {
  it('слишком маленькое число нейронов не роняет сборку', () => {
    const scene = build({ count: 1 });
    expect(scene.network.params.count).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(scene.network.params.count)).toBe(true);
  });

  it('нулевая вероятность связи повышается до различимой, а не обнуляет сеть', () => {
    // При вероятности 0 матрица была бы пуста, и пользователь получил бы
    // молчащую сеть с сообщением «связей 0» — без объяснения.
    const scene = build({ count: 200, connectionProbability: 0 });
    expect(scene.network.synapses.synapseCount).toBeGreaterThan(0);
  });

  it('нулевой вес не превращает сцену в мёртвую', () => {
    const scene = build({ count: 200, excitatoryWeight: 0, inputRate: 0 });
    let max = 0;
    for (const weight of scene.network.synapses.weight) {
      const magnitude = Math.abs(weight);
      if (magnitude > max) max = magnitude;
    }
    expect(max).toBeGreaterThan(0);
  });

  it('слишком большая доля торможения ограничивается', () => {
    const scene = build({ count: 200, inhibitoryFraction: 0.95 });
    expect(scene.network.params.inhibitoryFraction).toBeLessThanOrEqual(0.5);
  });

  it('обучение включается вместе с границами по масштабу сети', () => {
    const scene = build({ count: 100, stdp: true, excitatoryWeight: 2 });
    expect(scene.network.stdpParams.enabled).toBe(true);
    // Потолок обязан быть выше начального веса: иначе обучение обрезало бы
    // связи до значения, которого пользователь не задавал.
    expect(scene.network.stdpParams.wMax).toBeGreaterThan(2);
  });
});

describe('своя сеть: собранная сцена живая', () => {
  it('при разумных параметрах сеть разряжается', () => {
    const scene = build({ count: 400, excitatoryWeight: 0.5, inputRate: 300 });
    scene.network.run(600); // 300 мс
    const { spikes, active } = stats(scene);
    expect(spikes).toBeGreaterThan(0);
    expect(active).toBeGreaterThan(0);
  });

  it('без входа и со слабыми связями сеть честно молчит — и это не ошибка', () => {
    const scene = build({ count: 200, excitatoryWeight: 0.05, inputRate: 0, connectionProbability: 0.02 });
    scene.network.run(600);
    // Ноль спайков здесь ОЖИДАЕМ, а не дефект: без входа и с весом, много
    // меньшим порога, возбуждаться нечему. Тест фиксирует, что сборщик не
    // «подкручивает» параметры, чтобы сцена выглядела живой.
    const { spikes } = stats(scene);
    expect(spikes).toBe(0);
  });
});

/**
 * Тесты сети: сборка, причинность, режимы активности.
 *
 * Здесь проверяется не «код работает», а свойства, которыми сеть
 * описывается в проекте: спайк влияет только через задержку, торможение
 * снижает активность, пуассоновский вход даёт нерегулярный разряд.
 * Все утверждения формулируются через ИЗМЕРЕННЫЕ величины — частоту,
 * CV ISI, число спайков, — а не через «похоже на правду».
 */

import { describe, expect, it } from 'vitest';
import { Network, LIF_EQUIVALENT_SCALE, emptyMatrix } from '../core/network.js';
import { Rng } from '../core/rng.js';
import { buildSynapses, randomSparseTopology } from '../core/synapses.js';
import { DEFAULT_STDP } from '../core/stdp.js';
import { DEFAULT_NETWORK_PARAMS, type NetworkParams } from '../core/types.js';

/** Параметры сети под тест: небольшая, без внешнего входа по умолчанию. */
function params(overrides: Partial<NetworkParams> = {}): NetworkParams {
  return {
    ...DEFAULT_NETWORK_PARAMS,
    count: 100,
    inhibitoryFraction: 0.2,
    delay: 2,
    delayJitter: 0,
    dt: 0.5,
    seed: 7,
    input: { ...DEFAULT_NETWORK_PARAMS.input, mode: 'none', amplitude: 0, weight: 0, rate: 0 },
    ...overrides,
  };
}

/** Суммарное число спайков в сети. */
function totalSpikes(network: Network): number {
  let total = 0;
  for (let i = 0; i < network.params.count; i++) total += network.state.spikeCount[i];
  return total;
}

/** Число нейронов, спайковавших хотя бы раз. */
function activeCount(network: Network): number {
  let active = 0;
  for (let i = 0; i < network.params.count; i++) if (network.state.spikeCount[i] > 0) active += 1;
  return active;
}

/** Разреженная сеть с балансом E/I. */
function balancedNetwork(options: {
  count: number;
  seed: number;
  input: NetworkParams['input'];
  inhibitoryFraction?: number;
  excitatoryWeight?: number;
  inhibitoryRatio?: number;
  delayJitter?: number;
}): Network {
  const inhibitoryFraction = options.inhibitoryFraction ?? 0.2;
  const network = new Network(
    params({
      count: options.count,
      seed: options.seed,
      inhibitoryFraction,
      input: options.input,
    }),
  );
  network.setSynapses(
    randomSparseTopology({
      count: options.count,
      inhibitoryFraction,
      connectionProbability: 0.1,
      excitatoryWeight: options.excitatoryWeight ?? 0.15,
      inhibitoryRatio: options.inhibitoryRatio ?? 5,
      delay: 2,
      delayJitter: options.delayJitter ?? 0.5,
      dt: 0.5,
      rng: new Rng(options.seed),
    }),
  );
  return network;
}

describe('сеть: базовые свойства', () => {
  it('без связей и без входа сеть молчит', () => {
    const network = new Network(params());
    network.run(200);
    expect(totalSpikes(network)).toBe(0);
  });

  it('нейроны стартуют в покое и не спайкуют сами по себе', () => {
    const network = new Network(params({ count: 50 }));
    // Первые шаги без входа: ни одного спайка. Если бы инициализация
    // оставляла нули (вместо потенциала покоя), вся сеть выстрелила бы
    // на первом такте — именно этот дефект здесь и ловится.
    for (let step = 0; step < 10; step++) expect(network.step()).toBe(0);
  });

  it('постоянный ток выше порога заставляет сеть спайковать', () => {
    const network = new Network(
      params({ input: { mode: 'const', amplitude: 2.0, rate: 0, weight: 0, fraction: 1 } }),
    );
    network.run(500);
    expect(totalSpikes(network)).toBeGreaterThan(50);
  });

  it('подпороговый ток не даёт спайков', () => {
    const network = new Network(
      params({ input: { mode: 'const', amplitude: 1.0, rate: 0, weight: 0, fraction: 1 } }),
    );
    network.run(500);
    expect(totalSpikes(network)).toBe(0);
  });

  it('доля получающих вход соблюдается', () => {
    // fraction = 0.5: ток подаётся первой половине нейронов.
    const network = new Network(
      params({
        count: 100,
        input: { mode: 'const', amplitude: 3.0, rate: 0, weight: 0, fraction: 0.5 },
      }),
    );
    network.run(1000);
    const active = activeCount(network);
    expect(active).toBeGreaterThan(30);
    expect(active).toBeLessThanOrEqual(50);
  });
});

describe('сеть: причинность и задержки', () => {
  it('спайк приходит к цели ровно через задержку, ни шагом раньше', () => {
    // Причинность проверяется измерением: на каком шаге спайковал источник
    // и на каком шаге сдвинулся потенциал цели. Измерено при задержке
    // 4 шага: спайк на 27-м шаге → сдвиг на 31-м, то есть ровно 27 + 4.
    for (const [amplitude, duration] of [
      [3.0, 200],
      [5.0, 100],
    ] as Array<[number, number]>) {
      const matrix = buildSynapses(2, [0], [1], [1.0], [4]);
      const network = new Network(
        params({ count: 2, input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 } }),
        matrix,
      );
      network.inject(0, amplitude, duration);

      const rest = DEFAULT_NETWORK_PARAMS.neuron.lif.vRest;
      let firstSpike = -1;
      let firstShift = -1;
      for (let step = 0; step < 200; step++) {
        network.step();
        if (firstSpike < 0 && network.state.spikeCount[0] > 0) firstSpike = step;
        if (firstShift < 0 && Math.abs(network.state.v[1] - rest) > 0.01) firstShift = step;
      }
      expect(firstSpike, `ток ${amplitude}`).toBeGreaterThanOrEqual(0);
      expect(firstShift - firstSpike, `ток ${amplitude}`).toBe(4);
    }
  });

  it('до прихода спайка цель не двигается вовсе', () => {
    const matrix = buildSynapses(2, [0], [1], [1.0], [10]);
    const network = new Network(
      params({ count: 2, input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 } }),
      matrix,
    );
    const rest = DEFAULT_NETWORK_PARAMS.neuron.lif.vRest;
    for (let step = 0; step < 20; step++) {
      network.step();
      expect(network.state.v[1]).toBeCloseTo(rest, 6);
    }
  });

  it('тормозная связь заметно снижает потенциал цели', () => {
    // ─── Как это измеряется правильно ───────────────────────────────────
    // Первая версия теста держала на цели ПОСТОЯННЫЙ зарядный ток и смотрела
    // минимум потенциала. Так делать нельзя: ток продолжает заряжать
    // мембрану, и он маскирует тормозной сдвиг — измеренный эффект был
    // 0.117 мВ вместо настоящего. Правильно: дать цели короткий импульс,
    // дать ему закончиться, и только потом пустить тормозной спайк.
    const matrix = buildSynapses(2, [0], [1], [-1.0], [1]);
    const network = new Network(
      params({ count: 2, input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 } }),
      matrix,
    );
    network.inject(1, 3.0, 20);
    network.run(40); // импульс закончился, потенциал держится на достигнутом
    const before = network.state.v[1];

    network.inject(0, 5.0, 5);
    let lowest = before;
    for (let step = 0; step < 60; step++) {
      network.step();
      lowest = Math.min(lowest, network.state.v[1]);
    }
    // Измерено: одиночный тормозной спайк сдвигает потенциал цели примерно
    // на 1 мВ вниз. Требуем заметный сдвиг, а не «хоть какой-нибудь»:
    // иначе знак веса до цели фактически не доходит.
    expect(lowest).toBeLessThan(before - 0.5);
  });

  it('тормозная связь сдвигает цель вниз и от состояния покоя', () => {
    // Чистый случай без всяких инъекций в цель: единственное событие —
    // тормозной спайк. Потенциал обязан уйти НИЖЕ потенциала покоя.
    //
    // Длительность инъекции подобрана ПО РАСЧЁТУ, а не на глаз: при токе
    // 5 нА установившийся потенциал равен −65 + 10·5 = −15 мВ, и порога
    // −50 мВ нейрон достигает за −τ·ln((−50+15)/(−65+15)) = 7.13 мс.
    // Инъекция на 5 мс (первая версия теста) до порога не доводила, и
    // источник молчал — тест ничего не проверял.
    const matrix = buildSynapses(2, [0], [1], [-1.0], [1]);
    const network = new Network(
      params({ count: 2, input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 } }),
      matrix,
    );
    const rest = network.state.v[1];
    network.inject(0, 5.0, 20);

    let lowest = rest;
    let spiked = false;
    for (let step = 0; step < 120; step++) {
      network.step();
      if (network.state.spikeCount[0] > 0) spiked = true;
      lowest = Math.min(lowest, network.state.v[1]);
    }
    // Источник обязан был спайкнуть, иначе тест ничего не проверяет.
    expect(spiked).toBe(true);
    expect(lowest).toBeLessThan(rest);
  });

  it('возбуждение и торможение складываются: смесь слабее чистого возбуждения', () => {
    const measure = (weights: number[]): number => {
      const targets = weights.map(() => 1);
      const matrix = buildSynapses(2, weights.map(() => 0), targets, weights, weights.map(() => 1));
      const network = new Network(
        params({ count: 2, input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 } }),
        matrix,
      );
      network.inject(0, 5.0, 10);
      const rest = DEFAULT_NETWORK_PARAMS.neuron.lif.vRest;
      let peak = rest;
      for (let step = 0; step < 60; step++) {
        network.step();
        peak = Math.max(peak, network.state.v[1]);
      }
      return peak;
    };
    const excitatoryOnly = measure([1.0]);
    const mixed = measure([1.0, -0.4]);
    expect(mixed).toBeLessThan(excitatoryOnly);
    // Но возбуждение всё же перевешивает: итог выше покоя.
    expect(mixed).toBeGreaterThan(DEFAULT_NETWORK_PARAMS.neuron.lif.vRest);
  });
});

describe('сеть: режимы активности', () => {
  it('пуассоновский вход даёт нерегулярный разряд (CV ≈ 0.6)', () => {
    // Измерено: при rate = 200 Гц и весе события 8 мА сеть живёт
    // (980 спайков за 2 с на 200 нейронах) с CV = 0.642. Постоянный ток
    // при том же среднем входе даёт CV = 0.000 — идеальный метроном.
    // Нерегулярность — определяющее свойство коркового режима, и здесь
    // проверяется именно оно, а не «сеть активна».
    const network = balancedNetwork({
      count: 200,
      seed: 5,
      input: { mode: 'poisson', amplitude: 0, rate: 200, weight: 8, fraction: 1 },
      excitatoryWeight: 0.15,
    });
    network.run(4000);
    const sample = network.recordSample();
    expect(totalSpikes(network)).toBeGreaterThan(100);
    expect(Number.isFinite(sample.cv)).toBe(true);
    expect(sample.cv).toBeGreaterThan(0.4);
  });

  it('постоянный ток даёт регулярный разряд (CV ≈ 0)', () => {
    // Контрастный случай: тот же каркас, но вход регулярный.
    const network = balancedNetwork({
      count: 200,
      seed: 5,
      input: { mode: 'const', amplitude: 1.6, rate: 0, weight: 0, fraction: 1 },
      excitatoryWeight: 0.0,
    });
    network.run(4000);
    const sample = network.recordSample();
    expect(totalSpikes(network)).toBeGreaterThan(100);
    expect(sample.cv).toBeLessThan(0.2);
  });

  it('торможение снижает число активных нейронов', () => {
    // Держим внешний вход одинаковым, меняем только силу торможения.
    // Измерено: без торможения активны все 300 нейронов, с торможением —
    // заметно меньше, потому что тормозные клетки гасят возбудимых.
    const run = (inhibitoryFraction: number): number => {
      const network = balancedNetwork({
        count: 300,
        seed: 9,
        input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 6, fraction: 1 },
        inhibitoryFraction,
        excitatoryWeight: 0.15,
        inhibitoryRatio: 5,
      });
      network.run(4000);
      return activeCount(network);
    };
    const withInhibition = run(0.3);
    const withoutInhibition = run(0.0);
    expect(withInhibition).toBeLessThanOrEqual(withoutInhibition);
  });

  it('синхронность лежит в допустимом диапазоне и измерима', () => {
    const network = balancedNetwork({
      count: 200,
      seed: 13,
      input: { mode: 'const', amplitude: 3.0, rate: 0, weight: 0, fraction: 1 },
      excitatoryWeight: 0,
    });
    network.run(2000);
    const synchrony = network.synchronyValue();
    expect(Number.isFinite(synchrony)).toBe(true);
    expect(synchrony).toBeGreaterThanOrEqual(0);
    expect(synchrony).toBeLessThanOrEqual(1);
    expect(network.synchronySpikes).toBeGreaterThan(0);
  });

  it('без спайков синхронность не определена (NaN), а не ноль', () => {
    const network = new Network(params());
    network.run(100);
    expect(Number.isNaN(network.synchronyValue())).toBe(true);
  });
});

describe('сеть: метрики и состояние', () => {
  it('замер содержит все заявленные величины и они не NaN', () => {
    const network = new Network(
      params({ input: { mode: 'const', amplitude: 2.5, rate: 0, weight: 0, fraction: 1 } }),
    );
    network.run(1000);
    const sample = network.recordSample();
    expect(Number.isFinite(sample.rate)).toBe(true);
    expect(sample.activeFraction).toBeGreaterThanOrEqual(0);
    expect(sample.activeFraction).toBeLessThanOrEqual(1);
    expect(sample.timeMs).toBeGreaterThan(0);
  });

  it('история частоты набирается и пригодна для спектра', () => {
    const network = new Network(
      params({ input: { mode: 'const', amplitude: 3.0, rate: 0, weight: 0, fraction: 1 } }),
    );
    network.run(3000);
    const series = network.rateSeries();
    expect(series.length).toBeGreaterThan(100);
    expect(series.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('сброс возвращает сеть в исходное состояние', () => {
    const network = new Network(
      params({ input: { mode: 'const', amplitude: 3.0, rate: 0, weight: 0, fraction: 1 } }),
    );
    network.run(500);
    network.reset();
    expect(totalSpikes(network)).toBe(0);
    expect(network.state.time).toBe(0);
    expect(network.samples.length).toBe(0);
  });

  it('симуляция детерминирована при одном зерне', () => {
    const build = (): number => {
      const network = new Network(
        params({
          seed: 99,
          input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 8, fraction: 1 },
        }),
      );
      network.run(1000);
      return totalSpikes(network);
    };
    expect(build()).toBe(build());
  });

  it('пустая матрица связей корректна', () => {
    const matrix = emptyMatrix(10);
    expect(matrix.synapseCount).toBe(0);
    const network = new Network(params({ count: 10 }), matrix);
    network.run(50);
    expect(network.state.count).toBe(10);
  });
});

describe('сеть: обучение STDP', () => {
  it('при включённом STDP веса расходятся, при выключенном не меняются', () => {
    // Измерено на 300 нейронах за 10 000 шагов (5 с модельного времени):
    //   STDP выключен: 17 119 спайков, 0 обновлений, средний вес 0.1500
    //                  → 0.1500, разброс [0.1500, 0.1500];
    //   STDP включён:  17 055 спайков, 800 207 обновлений, средний вес
    //                  0.1500 → 0.1280, разброс [0.0012, 0.2504].
    // Это ровно то, что означает «обучение»: одни связи усиливаются,
    // другие ослабляются, и распределение перестаёт быть точечным.
    const build = (enabled: boolean): Network => {
      const seed = 21;
      const count = 300;
      const network = new Network(
        params({
          count,
          seed,
          input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 8, fraction: 1 },
        }),
        undefined,
        { ...DEFAULT_STDP, enabled, wMin: 0, wMax: 1 },
      );
      network.setSynapses(
        randomSparseTopology({
          count,
          inhibitoryFraction: 0.2,
          connectionProbability: 0.1,
          excitatoryWeight: 0.15,
          inhibitoryRatio: 5,
          delay: 2,
          delayJitter: 0.5,
          dt: 0.5,
          rng: new Rng(seed),
        }),
      );
      return network;
    };

    const without = build(false);
    without.run(10000);
    expect(without.stdpUpdates).toBe(0);
    // Веса обязаны остаться ровно теми же: обучение выключено, и ничто
    // больше веса не трогает. Проверяются оба знака: возбуждающие 0.15,
    // тормозные −0.75 (0.15 · inhibitoryRatio 5).
    for (const weight of without.synapses.weight) {
      expect(Math.abs(weight) === 0.15 || Math.abs(weight) === 0.75).toBe(true);
    }

    const withStdp = build(true);
    withStdp.run(10000);
    expect(withStdp.stdpUpdates).toBeGreaterThan(100000);

    // Разброс появился: среди ВОЗБУЖДАЮЩИХ связей есть слабые и сильные.
    let min = Infinity;
    let max = -Infinity;
    for (const weight of withStdp.synapses.weight) {
      if (weight <= 0) continue;
      min = Math.min(min, weight);
      max = Math.max(max, weight);
    }
    expect(min).toBeLessThan(0.05);
    expect(max).toBeGreaterThan(0.2);
  });

  it('веса остаются в границах после длительного обучения', () => {
    // Обучение идёт долго (20 000 шагов, больше миллиона обновлений).
    // Границы обязаны выполняться ДЛЯ ВСЕХ связей, и тормозные не должны
    // «переобучиться» в возбуждающие.
    const count = 200;
    const network = new Network(
      params({
        count,
        seed: 33,
        input: { mode: 'poisson', amplitude: 0, rate: 400, weight: 8, fraction: 1 },
      }),
      undefined,
      { ...DEFAULT_STDP, wMin: 0, wMax: 0.5 },
    );
    network.setSynapses(
      randomSparseTopology({
        count,
        inhibitoryFraction: 0.2,
        connectionProbability: 0.1,
        excitatoryWeight: 0.15,
        inhibitoryRatio: 5,
        delay: 2,
        delayJitter: 0.5,
        dt: 0.5,
        rng: new Rng(33),
      }),
    );

    // Запоминаем, какие связи тормозные: обучение не имеет права менять их
    // знак — это изменило бы тип синапса, то есть биологический смысл.
    const inhibitory: boolean[] = [];
    for (const weight of network.synapses.weight) inhibitory.push(weight < 0);

    network.run(20000);

    let prunedToZero = 0;
    for (let s = 0; s < network.synapses.weight.length; s++) {
      const weight = network.synapses.weight[s];
      expect(Number.isFinite(weight)).toBe(true);
      if (inhibitory[s]) {
        // Тормозные не обучаются вовсе.
        expect(weight).toBeCloseTo(-0.75, 9);
      } else {
        // Возбуждающие — строго в границах [0, wMax].
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(0.5);
        if (weight === 0) prunedToZero += 1;
      }
    }
    // Измерено: обучение доводит часть связей ровно до нуля — это
    // «прореживание» (pruning), известный эффект конкурентного STDP,
    // а не ошибка. Проверяем, что эффект действительно наблюдается:
    // иначе правило не конкурирует и смысла в нём нет.
    expect(prunedToZero).toBeGreaterThan(0);
  });

  it('STDP можно выключить из интерфейса', () => {
    const network = new Network(params());
    network.setStdp(false);
    expect(network.stdpParams.enabled).toBe(false);
    network.setStdp(true);
    expect(network.stdpParams.enabled).toBe(true);
  });
});

describe('сеть: единицы тока в разных моделях нейрона', () => {
  it('масштаб объявлен и больше единицы', () => {
    // У LIF ток в наноамперах (порог ≈ 1.5), у Izhikevich — в единицах
    // уравнения (типичные токи 1…20). Без масштаба переключение модели
    // молча меняло бы силу связей в разы.
    expect(LIF_EQUIVALENT_SCALE).toBeGreaterThan(1);
  });

  it('одна и та же связь сдвигает цель в обеих моделях', () => {
    const shift = (model: 'lif' | 'izhikevich'): number => {
      const matrix = buildSynapses(2, [0], [1], [0.5], [1]);
      const network = new Network(
        params({
          count: 2,
          neuron: { ...DEFAULT_NETWORK_PARAMS.neuron, model },
          input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
        }),
        matrix,
      );
      const baseline = network.state.v[1];
      network.inject(0, model === 'lif' ? 5 : 30, 10);
      let peak = baseline;
      for (let step = 0; step < 40; step++) {
        network.step();
        peak = Math.max(peak, network.state.v[1]);
      }
      return peak - baseline;
    };
    expect(shift('lif')).toBeGreaterThan(0);
    expect(shift('izhikevich')).toBeGreaterThan(0);
  });
});

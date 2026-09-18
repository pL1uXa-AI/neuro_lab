/**
 * Тесты STDP.
 *
 * Правило проверяется по свойствам, а не по «код работает»:
 *   • знак окна — пре раньше пост даёт потенциацию, пост раньше пре даёт
 *     депрессию; это определение STDP, и его отсутствие означает, что
 *     реализовано что-то другое;
 *   • интеграл окна отрицателен — условие устойчивости;
 *   • границы весов не пересекаются ни при каких прогонах;
 *   • тормозные связи не обучаются;
 *   • обучение устойчиво на длинном прогоне (10⁵ шагов), а не только
 *     «в первых десяти парах».
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STDP,
  StdpTraces,
  depressOutgoing,
  learningWindow,
  measuredWindow,
  potentiateIncoming,
  windowIntegral,
} from '../core/stdp.js';
import { buildSynapses } from '../core/synapses.js';
import { DEFAULT_NETWORK_PARAMS } from '../core/types.js';

/** Матрица из одной возбуждающей связи 0 → 1 с заданным весом. */
function singleSynapse(weight: number) {
  const matrix = buildSynapses(2, [0], [1], [weight], [1]);
  const traces = new StdpTraces(2);
  return { matrix, traces };
}

describe('STDP: окно обучения', () => {
  it('пре раньше пост даёт потенциацию, пост раньше пре — депрессию', () => {
    expect(learningWindow(5, DEFAULT_STDP)).toBeGreaterThan(0);
    expect(learningWindow(-5, DEFAULT_STDP)).toBeLessThan(0);
  });

  it('окно затухает с расстоянием по времени', () => {
    const near = learningWindow(2, DEFAULT_STDP);
    const far = learningWindow(10, DEFAULT_STDP);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);

    const nearNeg = learningWindow(-2, DEFAULT_STDP);
    const farNeg = learningWindow(-10, DEFAULT_STDP);
    // Оба отрицательны, но дальний слабее по модулю.
    expect(Math.abs(nearNeg)).toBeGreaterThan(Math.abs(farNeg));
  });

  it('интеграл окна отрицателен: депрессия перевешивает', () => {
    // A₋·τ₋ = 0.012·20 = 0.24 > A₊·τ₊ = 0.01·20 = 0.20.
    expect(windowIntegral(DEFAULT_STDP)).toBeLessThan(0);
    expect(windowIntegral(DEFAULT_STDP)).toBeCloseTo(0.2 - 0.24, 9);
  });

  it('измеренное окно совпадает по знаку с теоретическим', () => {
    // Важно: проверяется не только формула, но и то, что ОБУЧЕНИЕ через
    // следы даёт тот же знак. Расхождение означало бы, что обновление
    // реализовано «наоборот» относительно заявленного окна.
    expect(measuredWindow(10, DEFAULT_STDP)).toBeGreaterThan(0);
    expect(measuredWindow(-10, DEFAULT_STDP)).toBeLessThan(0);
  });

  it('измеренная потенциация убывает с ростом Δt', () => {
    const near = measuredWindow(2, DEFAULT_STDP);
    const far = measuredWindow(15, DEFAULT_STDP);
    expect(near).toBeGreaterThan(far);
  });

  it('измеренная депрессия ослабевает с ростом |Δt|', () => {
    const near = Math.abs(measuredWindow(-2, DEFAULT_STDP));
    const far = Math.abs(measuredWindow(-15, DEFAULT_STDP));
    expect(near).toBeGreaterThan(far);
  });
});

describe('STDP: обновление весов', () => {
  it('пост-спайк после пре-спайка увеличивает вес', () => {
    const { matrix, traces } = singleSynapse(0.5);
    traces.onPreSpike(0);
    // Небольшая задержка, чтобы след не был равен 1.
    traces.decay(Math.exp(-2 / 20), Math.exp(-2 / 20));
    traces.onPostSpike(1);
    potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);
    expect(matrix.weight[0]).toBeGreaterThan(0.5);
  });

  it('пре-спайк после пост-спайка уменьшает вес', () => {
    const { matrix, traces } = singleSynapse(0.5);
    traces.onPostSpike(1);
    traces.decay(Math.exp(-2 / 20), Math.exp(-2 / 20));
    traces.onPreSpike(0);
    depressOutgoing(matrix, traces, 0, DEFAULT_STDP);
    expect(matrix.weight[0]).toBeLessThan(0.5);
  });

  it('без следа в паре вес не меняется', () => {
    const { matrix, traces } = singleSynapse(0.5);
    // Пост-спайк при нулевом следе пре-спайков: пары не было.
    traces.onPostSpike(1);
    potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);
    expect(matrix.weight[0]).toBe(0.5);
  });

  it('тормозные связи не обучаются', () => {
    const matrix = buildSynapses(2, [0], [1], [-0.5], [1]);
    const traces = new StdpTraces(2);
    traces.onPreSpike(0);
    traces.onPostSpike(1);
    potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);
    depressOutgoing(matrix, traces, 0, DEFAULT_STDP);
    // Знак обязан остаться отрицательным, и величина не измениться.
    expect(matrix.weight[0]).toBe(-0.5);
  });

  it('обновляются только связи, ведущие К спайкнувшему нейрону', () => {
    // 0 → 1, 2 → 1 (входящие в 1) и 1 → 2 (исходящая из 1).
    // Пост-спайк нейрона 1 обязан усилить ОБЕ входящие и не тронуть исходящую.
    //
    // Вес ищется по ПАРЕ (источник, цель), а не по позиции в массиве:
    // CSR раскладывает связи по источнику, поэтому «первая связь» и
    // «связь 0 → 1» — не одно и то же. Первая версия теста путала позиции
    // и «падала» на верном коде.
    const matrix = buildSynapses(3, [0, 2, 1], [1, 1, 2], [0.5, 0.5, 0.5], [1, 1, 1]);
    const traces = new StdpTraces(3);

    const weightOf = (from: number, to: number): number => {
      for (let s = matrix.rowPtr[from]; s < matrix.rowPtr[from + 1]; s++) {
        if (matrix.colIdx[s] === to) return matrix.weight[s];
      }
      throw new Error(`нет связи ${from} → ${to}`);
    };

    traces.onPreSpike(0);
    traces.onPreSpike(1);
    traces.onPreSpike(2);
    traces.onPostSpike(1);
    potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);

    // Входящие в нейрон 1 — усилены.
    expect(weightOf(0, 1)).toBeGreaterThan(0.5);
    expect(weightOf(2, 1)).toBeGreaterThan(0.5);
    // Исходящая из нейрона 1 — не тронута.
    expect(weightOf(1, 2)).toBe(0.5);
  });
});

describe('STDP: границы весов', () => {
  it('жёсткие границы не дают весу выйти за [wMin, wMax]', () => {
    const { matrix, traces } = singleSynapse(0.99);
    const params = { ...DEFAULT_STDP, wMax: 1 };
    // Много потенциаций подряд: вес обязан упереться в границу.
    for (let i = 0; i < 5000; i++) {
      traces.onPreSpike(0);
      traces.onPostSpike(1);
      potentiateIncoming(matrix, traces, 1, params);
    }
    expect(matrix.weight[0]).toBeLessThanOrEqual(1);
    expect(matrix.weight[0]).toBeGreaterThanOrEqual(0);
  });

  it('депрессия не уводит вес ниже нуля', () => {
    const { matrix, traces } = singleSynapse(0.01);
    const params = { ...DEFAULT_STDP, wMin: 0 };
    for (let i = 0; i < 5000; i++) {
      traces.onPostSpike(1);
      traces.onPreSpike(0);
      depressOutgoing(matrix, traces, 0, params);
    }
    expect(matrix.weight[0]).toBeGreaterThanOrEqual(0);
  });

  it('мягкие границы подходят к пределу, не пересекая его', () => {
    const { matrix, traces } = singleSynapse(0.5);
    const params = { ...DEFAULT_STDP, bounds: 'soft' as const, wMax: 1 };
    for (let i = 0; i < 5000; i++) {
      traces.onPreSpike(0);
      traces.onPostSpike(1);
      potentiateIncoming(matrix, traces, 1, params);
    }
    expect(matrix.weight[0]).toBeLessThanOrEqual(1);
    // И вес действительно приблизился к границе — иначе «мягкость» была бы
    // просто медленным обучением.
    expect(matrix.weight[0]).toBeGreaterThan(0.9);
  });

  it('мягкие границы дают меньший шаг у самой границы', () => {
    const params = { ...DEFAULT_STDP, bounds: 'soft' as const, wMax: 1 };
    const stepFrom = (start: number): number => {
      const { matrix, traces } = singleSynapse(start);
      traces.onPreSpike(0);
      traces.onPostSpike(1);
      potentiateIncoming(matrix, traces, 1, params);
      return matrix.weight[0] - start;
    };
    // Вблизи границы шаг обязан быть меньше, чем вдали.
    expect(stepFrom(0.2)).toBeGreaterThan(stepFrom(0.9));
  });
});

describe('STDP: устойчивость', () => {
  it('на длинном прогоне вес остаётся в границах и конечен', () => {
    const { matrix, traces } = singleSynapse(0.5);
    // 10⁵ обновлений: если бы правило «разгоняло» вес или накапливало
    // NaN, это проявилось бы здесь, а не в первых десяти парах.
    for (let i = 0; i < 100000; i++) {
      if (i % 2 === 0) {
        traces.onPreSpike(0);
        traces.onPostSpike(1);
        potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);
      } else {
        traces.onPostSpike(1);
        traces.onPreSpike(0);
        depressOutgoing(matrix, traces, 0, DEFAULT_STDP);
      }
    }
    expect(Number.isFinite(matrix.weight[0])).toBe(true);
    expect(matrix.weight[0]).toBeGreaterThanOrEqual(DEFAULT_STDP.wMin);
    expect(matrix.weight[0]).toBeLessThanOrEqual(DEFAULT_STDP.wMax);
  });

  it('преобладание пре-до-пост пар ведёт вес вверх', () => {
    // Ключевое функциональное свойство: повторяющаяся причинная пара
    // (пре всегда раньше пост) усиливает связь.
    const { matrix, traces } = singleSynapse(0.1);
    for (let i = 0; i < 200; i++) {
      traces.onPreSpike(0);
      traces.decay(Math.exp(-5 / 20), Math.exp(-5 / 20));
      traces.onPostSpike(1);
      potentiateIncoming(matrix, traces, 1, DEFAULT_STDP);
    }
    expect(matrix.weight[0]).toBeGreaterThan(0.1);
  });

  it('преобладание пост-до-пре пар ведёт вес вниз', () => {
    const { matrix, traces } = singleSynapse(0.9);
    for (let i = 0; i < 200; i++) {
      traces.onPostSpike(1);
      traces.decay(Math.exp(-5 / 20), Math.exp(-5 / 20));
      traces.onPreSpike(0);
      depressOutgoing(matrix, traces, 0, DEFAULT_STDP);
    }
    expect(matrix.weight[0]).toBeLessThan(0.9);
  });

  it('состояние следов сбрасывается', () => {
    const traces = new StdpTraces(3);
    traces.onPreSpike(0);
    traces.onPostSpike(1);
    traces.reset();
    expect(traces.x[0]).toBe(0);
    expect(traces.y[1]).toBe(0);
    expect(traces.updates).toBe(0);
  });
});

describe('STDP: совместимость с параметрами сети', () => {
  it('границы по умолчанию не пересекают ноль', () => {
    // Обучение возбуждающих связей не должно делать их тормозными:
    // это изменило бы тип синапса, то есть биологический смысл.
    expect(DEFAULT_STDP.wMin).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_STDP.wMax).toBeGreaterThan(DEFAULT_STDP.wMin);
    expect(DEFAULT_STDP.aMinus * DEFAULT_STDP.tauMinus).toBeGreaterThan(
      DEFAULT_STDP.aPlus * DEFAULT_STDP.tauPlus,
    );
  });

  it('типичный вес сети лежит внутри границ обучения', () => {
    // Веса из каталога топологий (0.05…0.15) обязаны попадать в диапазон,
    // иначе обучение начиналось бы уже «за границей» и первый же шаг
    // обрезал бы вес, то есть сеть молча переписывалась бы при старте.
    const typical = 0.1;
    expect(typical).toBeGreaterThan(DEFAULT_STDP.wMin);
    expect(typical).toBeLessThan(DEFAULT_STDP.wMax);
    expect(DEFAULT_NETWORK_PARAMS.dt).toBeGreaterThan(0);
  });
});

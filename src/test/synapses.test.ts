/**
 * Тесты синапсов, задержек и топологий.
 *
 * Главный класс дефектов, который здесь ловится, — «тихо неверная динамика»:
 * потерянная связь или съехавшая задержка не роняют симуляцию, а незаметно
 * меняют её поведение. Поэтому каждая раскладка сверяется с ЧЕСТНЫМ
 * перебором, а задержка проверяется по времени прихода спайка, а не по
 * значению поля в структуре.
 */

import { describe, expect, it } from 'vitest';
import {
  DelayBuffer,
  buildSynapses,
  gridTopology,
  layeredTopology,
  randomSparseTopology,
  ringTopology,
  type SynapseMatrix,
  type TopologyOptions,
} from '../core/synapses.js';
import { Rng } from '../core/rng.js';

/**
 * Собрать параметры топологии со стандартными значениями.
 *
 * Возвращаемый тип — пересечение с произвольными дополнительными полями:
 * у `layeredTopology`, `gridTopology` и `ringTopology` свои обязательные
 * параметры (`layers`, `side`, `span`), и они приходят через `overrides`.
 */
function topologyOptions<T extends object = Record<string, never>>(
  overrides: T = {} as T,
): TopologyOptions & T {
  return {
    count: 64,
    inhibitoryFraction: 0.25,
    connectionProbability: 0.1,
    excitatoryWeight: 0.05,
    inhibitoryRatio: 4,
    delay: 2,
    delayJitter: 0,
    dt: 0.5,
    rng: new Rng(42),
    ...overrides,
  } as TopologyOptions & T;
}

/** Все связи матрицы в виде троек — для сравнения с перебором. */
function edges(matrix: SynapseMatrix): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < matrix.count; i++) {
    for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
      out.push([i, matrix.colIdx[s], matrix.weight[s]]);
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe('раскладка CSR', () => {
  it('сохраняет все связи и их веса', () => {
    const sources = [0, 0, 1, 2, 2, 2];
    const targets = [1, 2, 0, 0, 1, 2];
    const weights = [1, -2, 3, 4, -5, 6];
    const delays = [1, 2, 1, 3, 1, 2];
    const matrix = buildSynapses(3, sources, targets, weights, delays);

    expect(matrix.synapseCount).toBe(6);
    expect(edges(matrix)).toEqual([
      [0, 1, 1],
      [0, 2, -2],
      [1, 0, 3],
      [2, 0, 4],
      [2, 1, -5],
      [2, 2, 6],
    ]);
  });

  it('обратный индекс перечисляет ровно те же связи', () => {
    const sources = [0, 0, 1, 2, 2, 2];
    const targets = [1, 2, 0, 0, 1, 2];
    const matrix = buildSynapses(3, sources, targets, [1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 1, 1]);

    // Для каждой входящей связи её источник и вес должны совпадать
    // с тем, что лежит в прямом индексе по `reverseOf`.
    for (let i = 0; i < matrix.count; i++) {
      for (let s = matrix.colPtr[i]; s < matrix.colPtr[i + 1]; s++) {
        const forward = matrix.reverseOf[s];
        expect(matrix.rowIdx[s]).toBe(sourceOf(matrix, forward));
        expect(matrix.colIdx[forward]).toBe(i);
      }
    }
  });

  it('изоляция и пустая матрица не ломают раскладку', () => {
    const matrix = buildSynapses(4, [], [], [], []);
    expect(matrix.synapseCount).toBe(0);
    for (let i = 0; i <= 4; i++) {
      expect(matrix.rowPtr[i]).toBe(0);
      expect(matrix.colPtr[i]).toBe(0);
    }
    // Максимальная задержка минимум 1: буфер без слотов не имеет смысла.
    expect(matrix.maxDelaySteps).toBeGreaterThanOrEqual(1);
  });

  it('задержка в 0 шагов поднимается до 1', () => {
    // Нулевая задержка означала бы влияние внутри того же шага, то есть
    // потерю причинности: спайк в момент t не может влиять на нейрон,
    // который считается тем же проходом.
    const matrix = buildSynapses(2, [0], [1], [1], [0]);
    expect(matrix.delaySteps[0]).toBe(1);
  });

  it('rowPtr и colPtr согласованы с числом связей', () => {
    const matrix = randomSparseTopology(topologyOptions());
    expect(matrix.rowPtr[matrix.count]).toBe(matrix.synapseCount);
    expect(matrix.colPtr[matrix.count]).toBe(matrix.synapseCount);
    // Сумма исходящих степеней равна числу связей.
    let sum = 0;
    for (let i = 0; i < matrix.count; i++) sum += matrix.rowPtr[i + 1] - matrix.rowPtr[i];
    expect(sum).toBe(matrix.synapseCount);
  });
});

/** Источник связи по её позиции в прямом индексе. */
function sourceOf(matrix: SynapseMatrix, position: number): number {
  for (let i = 0; i < matrix.count; i++) {
    if (position >= matrix.rowPtr[i] && position < matrix.rowPtr[i + 1]) return i;
  }
  return -1;
}

describe('буфер задержек', () => {
  it('спайк приходит ровно через заданное число шагов', () => {
    // Проверяем ЧЕСТНО: считаем шаги до появления тока в цели.
    for (const delaySteps of [1, 2, 5]) {
      const matrix = buildSynapses(2, [0], [1], [1], [delaySteps]);
      const buffer = new DelayBuffer(2, matrix.maxDelaySteps);

      // Шаг 0: спайк у нейрона 0 рассылается.
      const first = buffer.beginStep();
      expect(first[1]).toBe(0);
      buffer.endStep();
      buffer.schedule(0, matrix, 1);

      // Шаги 1…delay-1: в цели тишина.
      let arrivedAt = -1;
      for (let step = 1; step <= delaySteps + 1; step++) {
        const arrived = buffer.beginStep();
        if (arrived[1] !== 0 && arrivedAt < 0) arrivedAt = step;
        buffer.endStep();
      }
      expect(arrivedAt, `задержка ${delaySteps}`).toBe(delaySteps);
    }
  });

  it('ток не остаётся в слоте: после чтения слот пуст', () => {
    const matrix = buildSynapses(2, [0], [1], [1], [1]);
    const buffer = new DelayBuffer(2, matrix.maxDelaySteps);
    buffer.beginStep();
    buffer.endStep();
    buffer.schedule(0, matrix, 1);

    // Шаг 1: ток пришёл.
    const step1 = buffer.beginStep();
    expect(step1[1]).toBe(1);
    buffer.endStep();
    // Шаг 2: тот же слот уже очищен — ток не может «залипнуть».
    const step2 = buffer.beginStep();
    expect(step2[1]).toBe(0);
    buffer.endStep();
  });

  it('несколько спайков в одну цель складываются', () => {
    const matrix = buildSynapses(2, [0, 0], [1, 1], [1, 2], [1, 1]);
    const buffer = new DelayBuffer(2, matrix.maxDelaySteps);
    buffer.beginStep();
    buffer.endStep();
    buffer.schedule(0, matrix, 1);
    const arrived = buffer.beginStep();
    expect(arrived[1]).toBe(3);
  });

  it('масштаб весов применяется при доставке', () => {
    const matrix = buildSynapses(2, [0], [1], [2], [1]);
    const buffer = new DelayBuffer(2, matrix.maxDelaySteps);
    buffer.beginStep();
    buffer.endStep();
    buffer.schedule(0, matrix, 8);
    expect(buffer.beginStep()[1]).toBe(16);
  });

  it('сброс очищает все слоты', () => {
    const matrix = buildSynapses(2, [0], [1], [1], [3]);
    const buffer = new DelayBuffer(2, matrix.maxDelaySteps);
    buffer.beginStep();
    buffer.endStep();
    buffer.schedule(0, matrix, 1);
    buffer.reset();
    for (let step = 0; step < 5; step++) {
      const arrived = buffer.beginStep();
      expect(arrived[1]).toBe(0);
      buffer.endStep();
    }
  });
});

describe('топологии', () => {
  it('разреженная случайная: нет самосвязей и степень близка к вероятности', () => {
    const matrix = randomSparseTopology(topologyOptions({ count: 200, connectionProbability: 0.1 }));
    for (let i = 0; i < matrix.count; i++) {
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
        expect(matrix.colIdx[s]).not.toBe(i);
      }
    }
    // Средняя исходящая степень ≈ p·(N−1) = 0.1·199 ≈ 20.
    const meanDegree = matrix.synapseCount / matrix.count;
    expect(meanDegree).toBeGreaterThan(14);
    expect(meanDegree).toBeLessThan(26);
  });

  it('разреженная случайная: знаки весов соответствуют типу нейрона', () => {
    const matrix = randomSparseTopology(topologyOptions({ count: 100, inhibitoryFraction: 0.2 }));
    const inhibitoryStart = 100 - 20;
    for (let i = 0; i < matrix.count; i++) {
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
        if (i >= inhibitoryStart) expect(matrix.weight[s]).toBeLessThan(0);
        else expect(matrix.weight[s]).toBeGreaterThan(0);
      }
    }
  });

  it('топология воспроизводится при одном и том же зерне', () => {
    const a = randomSparseTopology(topologyOptions());
    const b = randomSparseTopology(topologyOptions());
    expect(edges(a)).toEqual(edges(b));
    // И отличается при другом зерне — иначе зерно не работает.
    const c = randomSparseTopology(topologyOptions({ rng: new Rng(43) }));
    expect(edges(c)).not.toEqual(edges(a));
  });

  it('слоистая: связи идут только между соседними слоями', () => {
    const matrix = layeredTopology(
      topologyOptions({ count: 30, layers: [10, 10, 10], connectionProbability: 0.5 }),
    );
    for (let i = 0; i < matrix.count; i++) {
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
        const to = matrix.colIdx[s];
        const fromLayer = Math.floor(i / 10);
        const toLayer = Math.floor(to / 10);
        expect(toLayer).toBe(fromLayer + 1);
      }
    }
  });

  it('слоистая с рекуррентностью добавляет связи внутри скрытого слоя', () => {
    const withoutRec = layeredTopology(
      topologyOptions({ count: 30, layers: [10, 10, 10], connectionProbability: 0.3 }),
    );
    const withRec = layeredTopology(
      topologyOptions({
        count: 30,
        layers: [10, 10, 10],
        connectionProbability: 0.3,
        recurrentHidden: true,
      }),
    );
    expect(withRec.synapseCount).toBeGreaterThan(withoutRec.synapseCount);
  });

  it('сетка: задержка растёт с расстоянием', () => {
    const { matrix, x, y } = gridTopology(
      topologyOptions({
        count: 25,
        side: 5,
        radius: 4,
        speed: 4,
        dt: 0.5,
        connectionProbability: 1,
      }),
    );
    expect(x.length).toBe(25);
    expect(y.length).toBe(25);
    // Для каждой связи проверяем, что задержка соответствует расстоянию
    // и скорости: delay = round(distance / speed / dt).
    let checked = 0;
    for (let i = 0; i < matrix.count; i++) {
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
        const j = matrix.colIdx[s];
        const distance = Math.hypot(x[j] - x[i], y[j] - y[i]);
        const expected = Math.max(1, Math.round(distance / 4 / 0.5));
        expect(matrix.delaySteps[s], `связь ${i}->${j}`).toBe(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('кольцевая: каждая связь идёт вперёд по кольцу', () => {
    const matrix = ringTopology(topologyOptions({ count: 20, span: 2, delay: 1, dt: 1 }));
    for (let i = 0; i < matrix.count; i++) {
      const targets: number[] = [];
      for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) targets.push(matrix.colIdx[s]);
      expect(targets).toEqual([(i + 1) % 20, (i + 2) % 20]);
    }
  });
});

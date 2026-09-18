/**
 * Нагрузочные проверки производительности.
 *
 * Запуск: `npm run bench`
 *
 * Это НЕ обычные тесты. Их задача — поймать регрессию производительности, а не
 * проверить корректность. Пороги намеренно щедрые: они рассчитаны на самую
 * медленную машину, где проект вообще имеет смысл запускать, и падают только
 * при качественном ухудшении.
 *
 * Историческая справка (один поток Node, замеры на этой машине):
 *   800 нейронов, 64 000 синапсов, STDP:  0.05 мс/шаг
 *   2000 нейронов, 200 000 синапсов:      0.21 мс/шаг
 *   2500 нейронов (решётка), без STDP:    0.11 мс/шаг
 *
 * Пороги ниже этих чисел в разы: они должны ловить не «стало на 20 % медленнее»,
 * а возврат квадратичной сложности или отключение оптимизации обхода связей.
 */

import { describe, expect, it } from 'vitest';
import { Network } from '../core/network.js';
import { Rng } from '../core/rng.js';
import { gridTopology, randomSparseTopology } from '../core/synapses.js';
import { DEFAULT_STDP } from '../core/stdp.js';
import { DEFAULT_NETWORK_PARAMS, type NetworkParams } from '../core/types.js';

/** Параметры сети под замер. */
function params(count: number, overrides: Partial<NetworkParams> = {}): NetworkParams {
  return {
    ...DEFAULT_NETWORK_PARAMS,
    count,
    inhibitoryFraction: 0.2,
    dt: 0.5,
    delay: 2,
    delayJitter: 0.5,
    seed: 7,
    input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 8, fraction: 1 },
    ...overrides,
  };
}

/** Среднее время шага в миллисекундах. */
function timePerStep(network: Network, warmup: number, reps: number): number {
  // Прогрев: первый вызов строит списки и заполняет кэши, и без него замер
  // показал бы неустановившийся режим.
  network.run(warmup);
  const startedAt = performance.now();
  network.run(reps);
  return (performance.now() - startedAt) / reps;
}

/** Разреженная сеть заданного размера. */
function sparseNetwork(count: number, stdp: boolean): Network {
  const p = params(count);
  const network = new Network(p, undefined, { ...DEFAULT_STDP, enabled: stdp });
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
      rng: new Rng(7),
    }),
  );
  return network;
}

describe('производительность ядра', () => {
  it('шаг на 300 нейронах со STDP дешевле 2 мс', () => {
    const network = sparseNetwork(300, true);
    const ms = timePerStep(network, 200, 400);
    // eslint-disable-next-line no-console
    console.log(
      `        300 нейронов + STDP (${network.synapses.synapseCount} связей): ` +
        `${ms.toFixed(3)} мс/шаг`,
    );
    expect(ms).toBeLessThan(2);
  });

  it('шаг на 800 нейронах дешевле 3 мс', () => {
    const network = sparseNetwork(800, false);
    const ms = timePerStep(network, 200, 300);
    // eslint-disable-next-line no-console
    console.log(
      `        800 нейронов (${network.synapses.synapseCount} связей): ` +
        `${ms.toFixed(3)} мс/шаг`,
    );
    expect(ms).toBeLessThan(3);
  });

  it('рост стоимости линеен по числу связей, а не квадратичен', () => {
    // Ключевая проверка архитектуры: обход идёт по списку связей, значит
    // время шага растёт вместе с их числом. Квадратичный рост означал бы
    // возврат перебора всех пар.
    const small = sparseNetwork(400, false);
    const large = sparseNetwork(1600, false);
    const smallMs = timePerStep(small, 100, 200);
    const largeMs = timePerStep(large, 100, 150);
    const synapseRatio = large.synapses.synapseCount / small.synapses.synapseCount;
    const timeRatio = largeMs / Math.max(1e-6, smallMs);
    // eslint-disable-next-line no-console
    console.log(
      `        400 нейронов (${small.synapses.synapseCount} связей): ${smallMs.toFixed(3)} мс/шаг`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `        1600 нейронов (${large.synapses.synapseCount} связей): ${largeMs.toFixed(3)} мс/шаг`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `        связей ×${synapseRatio.toFixed(1)}, время ×${timeRatio.toFixed(1)}`,
    );
    // Время не должно расти быстрее, чем число связей, с запасом в 2.5 раза:
    // кэш-эффекты и постоянные накладные расходы дают разброс.
    expect(timeRatio).toBeLessThan(synapseRatio * 2.5);
  });

  it('пространственная сеть 2500 нейронов: шаг дешевле 2 мс', () => {
    const side = 50;
    const count = side * side;
    const network = new Network(params(count, { inhibitoryFraction: 0 }));
    const grid = gridTopology({
      count,
      inhibitoryFraction: 0,
      connectionProbability: 0.6,
      excitatoryWeight: 200,
      inhibitoryRatio: 4,
      delay: 1,
      delayJitter: 0,
      dt: 0.5,
      rng: new Rng(7),
      side,
      radius: 8,
      speed: 4,
    });
    network.setSynapses(grid.matrix);
    network.x = grid.x;
    network.y = grid.y;
    const ms = timePerStep(network, 200, 300);
    // eslint-disable-next-line no-console
    console.log(
      `        решётка ${side}×${side} (${network.synapses.synapseCount} связей): ` +
        `${ms.toFixed(3)} мс/шаг`,
    );
    expect(ms).toBeLessThan(2);
  });

  it('память не растёт со временем: нет утечки в буферах', () => {
    // Долгий прогон проверяет, что кольцевые буферы (история спайков,
    // задержки, следы) не накапливают данные бесконечно.
    const network = sparseNetwork(300, true);
    const before = process.memoryUsage().heapUsed;
    network.run(20000);
    const after = process.memoryUsage().heapUsed;
    const growthMb = (after - before) / (1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(`        рост кучи за 20 000 шагов: ${growthMb.toFixed(2)} МБ`);
    // Порог 80 МБ: сборщик может не успеть освободить мусор, но утечка
    // (например, массив, растущий на каждый спайк) дала бы гигабайты.
    expect(growthMb).toBeLessThan(80);
  });
});

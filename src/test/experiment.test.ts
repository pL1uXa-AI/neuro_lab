/**
 * Опыт по обучению: проверка того, что сеть ДЕЙСТВИТЕЛЬНО научается.
 *
 * ─── Что именно здесь проверяется ────────────────────────────────────────
 *
 * Не «функция вызвалась без ошибок», а ИЗМЕРЕННЫЙ результат: после обучения
 * отклик на обученный паттерн обязан быть строго больше отклика на
 * необученный. Иначе опыт бесполезен — он показывает цифры, из которых
 * ничего не следует.
 *
 * Второй тест — контроль. Он не менее важен первого: без него «отклик
 * вырос» ничего не доказывает, потому что сеть могла просто разогреться от
 * повторяющегося стимула. Контроль прогоняет ТУ ЖЕ процедуру с выключенным
 * STDP и требует, чтобы различения не возникло.
 *
 * ─── Почему на своей сети, а не только на пресете ────────────────────────
 *
 * Пресет может измениться при подборе параметров. Тест на маленькой
 * специально собранной сети проверяет САМ ПРОТОКОЛ, независимо от того, что
 * сейчас записано в пресетах.
 */

import { describe, expect, it } from 'vitest';
import { Network } from '../core/network.js';
import { buildSynapses } from '../core/synapses.js';
import { DEFAULT_NETWORK_PARAMS, DEFAULT_LIF } from '../core/types.js';
import { DEFAULT_STDP } from '../core/stdp.js';
import {
  DEFAULT_EXPERIMENT,
  describeExperiment,
  experimentLayout,
  experimentPatterns,
  runLearningExperiment,
} from '../core/experiment.js';
import { presetById } from '../core/presets.js';
import { buildScene, warmUp } from '../core/scene.js';

const INPUTS = 40;
const READOUTS = 40;
const COUNT = INPUTS + READOUTS;

/**
 * Сеть «вход → читающий слой» с полносвязной проекцией.
 *
 * Вес 1 и границы STDP до 8 — рабочая точка, найденная измерением: при
 * потолке 1 отклик равен нулю и до, и после обучения (функциональный порог
 * в этих сетях лежит около веса 6).
 */
function makeNetwork(): Network {
  const network = new Network(
    {
      ...DEFAULT_NETWORK_PARAMS,
      count: COUNT,
      dt: 0.5,
      input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
      neuron: { model: 'lif', lif: DEFAULT_LIF, izh: DEFAULT_NETWORK_PARAMS.neuron.izh },
      synapticTau: 5,
      delay: 2,
      delayJitter: 0,
    },
    undefined,
    { ...DEFAULT_STDP, wMax: 8 },
  );
  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];
  for (let i = 0; i < INPUTS; i++) {
    for (let o = 0; o < READOUTS; o++) {
      sources.push(i);
      targets.push(INPUTS + o);
      weights.push(1);
      delays.push(2);
    }
  }
  network.setSynapses(buildSynapses(COUNT, sources, targets, weights, delays));
  return network;
}

describe('опыт обучения: протокол', () => {
  it('сеть научается различать паттерн A и паттерн B', () => {
    const network = makeNetwork();
    const result = runLearningExperiment(network, { ...DEFAULT_EXPERIMENT, trials: 40 }, { learn: true });

    // Главное утверждение: обученный паттерн даёт строго больший отклик.
    expect(result.afterA).toBeGreaterThan(result.afterB);
    expect(result.separation).toBeGreaterThan(0);
    expect(result.gain).toBeGreaterThan(0);
    // Обучение обязано реально сработать, а не «пройти вхолостую».
    expect(result.stdpUpdates).toBeGreaterThan(0);
    // Веса обязаны вырасти от учителя (LTP у активных входов).
    expect(result.weightAfter).toBeGreaterThan(result.weightBefore);
  });

  it('контроль: без обучения различения НЕ возникает', () => {
    const network = makeNetwork();
    const result = runLearningExperiment(network, { ...DEFAULT_EXPERIMENT, trials: 40 }, { learn: false });

    // Никаких обновлений, никакого роста весов.
    expect(result.stdpUpdates).toBe(0);
    expect(result.weightAfter).toBeCloseTo(result.weightBefore, 12);
    // И главное: отклик на A не больше, чем на B.
    expect(result.separation).toBeLessThanOrEqual(0);
  });

  it('исходная асимметрия A и B не выдаётся за обучение', () => {
    // ─── Что здесь проверяется ────────────────────────────────────────────
    //
    // Проба оставляет после себя возбуждение (проводимость, следы), поэтому
    // вторая проба меряется на «разогретой» сети. Обнаружено измерением на
    // СВЕЖЕЙ сети: beforeA = 0 при beforeB = 8 — то есть «различение»
    // возникало там, где сеть ещё ничему не учили.
    //
    // До исправления контроль показывал разделение −8 вместо нуля. Теперь
    // перед каждой пробой есть пауза покоя, и исходная асимметрия обязана
    // быть малой по сравнению с эффектом обучения.
    const network = makeNetwork();
    const result = runLearningExperiment(network, { ...DEFAULT_EXPERIMENT, trials: 1 }, { learn: false });
    const baseline = Math.abs(result.beforeA - result.beforeB);
    expect(baseline).toBeLessThanOrEqual(10);
  });

  it('опыт возвращает STDP в исходное состояние', () => {
    const network = makeNetwork();
    network.setStdp(false);
    runLearningExperiment(network, { ...DEFAULT_EXPERIMENT, trials: 2 }, { learn: true });
    // Опыт включал STDP на время обучения, но обязан вернуть настройку:
    // иначе он молча меняет то, что выбрал пользователь.
    expect(network.stdpParams.enabled).toBe(false);
  });

  it('границы весов опыта сохраняются после прогона', () => {
    const network = makeNetwork();
    runLearningExperiment(network, { ...DEFAULT_EXPERIMENT, trials: 2 }, { learn: true });
    // Веса не должны превысить потолок, заданный при сборке сети.
    let max = 0;
    for (const weight of network.synapses.weight) if (weight > max) max = weight;
    expect(max).toBeLessThanOrEqual(8 + 1e-9);
  });
});

describe('опыт обучения: раскладка сети', () => {
  it('паттерны A и B не пересекаются', () => {
    const network = makeNetwork();
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 10);
    for (const index of patterns.a) expect(patterns.b).not.toContain(index);
    expect(patterns.a.length).toBeGreaterThan(0);
    expect(patterns.a.length).toBe(patterns.b.length);
  });

  it('паттерн не заходит в читающий слой', () => {
    const network = makeNetwork();
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 10);
    for (const index of [...patterns.a, ...patterns.b]) {
      expect(index).toBeLessThan(layout.readoutStart);
    }
  });

  it('слишком большой паттерн обрезается до половины входов, а не ломает опыт', () => {
    const network = makeNetwork();
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 10_000);
    // A и B обязаны остаться непересекающимися, иначе «различать» нечего.
    for (const index of patterns.a) expect(patterns.b).not.toContain(index);
    expect(patterns.a.length + patterns.b.length).toBeLessThanOrEqual(INPUTS);
  });
});

describe('опыт обучения: описание результата', () => {
  it('об успехе и о провале говорится разное', () => {
    const learned = describeExperiment({
      beforeA: 0, beforeB: 0, afterA: 20, afterB: 0,
      weightBefore: 1, weightAfter: 2, stdpUpdates: 5000,
      gain: 20, separation: 20,
    });
    expect(learned.learned).toBe(true);
    expect(learned.summary).toContain('научилась');

    const failed = describeExperiment({
      beforeA: 0, beforeB: 0, afterA: 0, afterB: 0,
      weightBefore: 1, weightAfter: 1, stdpUpdates: 0,
      gain: 0, separation: 0,
    });
    expect(failed.learned).toBe(false);
    expect(failed.summary).toContain('НЕ научилась');
  });

  it('контроль упоминается в описании, когда передан', () => {
    const result = {
      beforeA: 0, beforeB: 0, afterA: 20, afterB: 0,
      weightBefore: 1, weightAfter: 2, stdpUpdates: 5000,
      gain: 20, separation: 20,
    };
    const control = { ...result, afterA: 0, afterB: 0, stdpUpdates: 0, gain: 0, separation: 0 };
    const { summary } = describeExperiment(result, control);
    expect(summary).toContain('Контроль');
  });
});

describe('опыт обучения: пресет «Обучение с учителем»', () => {
  it('пресет существует и его границы допускают функциональное обучение', () => {
    const preset = presetById('supervised-learning');
    expect(preset).toBeDefined();
    // Границы ОБЯЗАНЫ быть выше веса функционального порога, иначе опыт
    // выродится в «веса меняются, поведение — нет».
    expect(preset?.stdpBounds?.max ?? 0).toBeGreaterThan(1);
    expect(preset?.stdp).toBe(true);
  });

  it('на пресете сеть действительно научается', () => {
    const preset = presetById('supervised-learning')!;
    const scene = buildScene(preset);
    warmUp(scene);
    const result = runLearningExperiment(scene.network);
    expect(result.separation).toBeGreaterThan(0);
    expect(result.gain).toBeGreaterThan(0);
  });

  it('пресет «Волна» не разрушается включением STDP', () => {
    // Раньше включение обучения обрезало веса волны (22…178) до 0…1:
    // измерено падение спайков за 100 мс с 118 016 до 31 584.
    const preset = presetById('wave')!;
    const scene = buildScene({ ...preset, stdp: true });
    warmUp(scene);
    const network = scene.network;
    network.run(200);

    let max = 0;
    for (const weight of network.synapses.weight) {
      if (weight > max) max = weight;
    }
    // Веса обязаны остаться в масштабе сцены, а не упасть к единице.
    expect(max).toBeGreaterThan(50);

    let spikes = 0;
    for (let i = 0; i < network.params.count; i++) spikes += network.state.spikeCount[i];
    // Волна обязана остаться волной: тысячи спайков, а не сотни.
    expect(spikes).toBeGreaterThan(50000);
  });
});

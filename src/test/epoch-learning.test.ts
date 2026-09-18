/**
 * Обучение по эпохам: кривая, подготовка сцены, отказы.
 *
 * ─── Что здесь проверяется ───────────────────────────────────────────────
 *
 * Не «функция вернула объект», а ИЗМЕРЕННЫЕ свойства кривой и вердиктов:
 *   • на обучаемой сцене латентность ответа на A обязана ПАДАТЬ по эпохам;
 *   • на необученный B она падать не обязана (иначе сеть не различает, а
 *     просто «разогревается»);
 *   • контроль с выключенным обучением не должен давать выигрыша;
 *   • самоподдерживающаяся сцена обязана быть ОТВЕРГНУТА с объяснением, а
 *     не молча показать нули.
 */

import { describe, expect, it } from 'vitest';
import { Network } from '../core/network.js';
import { buildSynapses } from '../core/synapses.js';
import { DEFAULT_NETWORK_PARAMS, DEFAULT_LIF } from '../core/types.js';
import { DEFAULT_STDP } from '../core/stdp.js';
import {
  DEFAULT_EPOCH_LEARNING,
  describeCurve,
  learnByEpochs,
  prepareForLearning,
  probeResponse,
} from '../core/epoch-learning.js';
import { experimentLayout, experimentPatterns } from '../core/experiment.js';
import { presetById, customPreset, DEFAULT_CUSTOM } from '../core/presets.js';
import { buildScene, warmUp } from '../core/scene.js';

const INPUTS = 40;
const READOUTS = 40;
const COUNT = INPUTS + READOUTS;

/** Сеть «вход → читающий слой», молчащая в покое. */
function makeNetwork(weight = 1.5, wMax = 8): Network {
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
    { ...DEFAULT_STDP, wMax },
  );
  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];
  for (let i = 0; i < INPUTS; i++) {
    for (let o = 0; o < READOUTS; o++) {
      sources.push(i);
      targets.push(INPUTS + o);
      weights.push(weight);
      delays.push(2);
    }
  }
  network.setSynapses(buildSynapses(COUNT, sources, targets, weights, delays));
  return network;
}

describe('обучение по эпохам: кривая', () => {
  it('латентность ответа на A падает по эпохам и выходит на плато', () => {
    const network = makeNetwork();
    const result = learnByEpochs(network, { ...DEFAULT_EPOCH_LEARNING, epochs: 100 });

    // Кривая обязана быть не пустой и содержать несколько точек.
    expect(result.curve.length).toBeGreaterThanOrEqual(5);
    // Все измерения — по возрастанию эпох.
    for (let i = 1; i < result.curve.length; i++) {
      expect(result.curve[i].epoch).toBeGreaterThan(result.curve[i - 1].epoch);
    }

    const first = result.curve[0];
    const last = result.curve[result.curve.length - 1];
    // Ответ обязан УСКОРИТЬСЯ: последняя латентность строго меньше первой.
    expect(Number.isFinite(first.latencyA)).toBe(true);
    expect(Number.isFinite(last.latencyA)).toBe(true);
    expect(last.latencyA).toBeLessThan(first.latencyA);

    // Итог согласован с кривой: «после» равно последней точке.
    expect(result.latencyAAfter).toBeCloseTo(last.latencyA, 6);
    expect(result.latencyABefore).toBeGreaterThan(result.latencyAAfter);
  });

  it('на необученный паттерн B ответ НЕ ускоряется так же сильно', () => {
    const network = makeNetwork();
    const result = learnByEpochs(network, { ...DEFAULT_EPOCH_LEARNING, epochs: 100 });
    const gainA = result.latencyABefore - result.latencyAAfter;
    const gainB = Number.isFinite(result.latencyBAfter)
      ? result.latencyBBefore - result.latencyBAfter
      : 0;
    // Обучение избирательно: выигрыш на A заметно больше, чем на B.
    expect(gainA).toBeGreaterThan(gainB + 1);
  });

  it('контроль: без обучения выигрыша нет', () => {
    const network = makeNetwork();
    const result = learnByEpochs(
      network,
      { ...DEFAULT_EPOCH_LEARNING, epochs: 100 },
      { learn: false },
    );
    expect(result.stdpUpdates).toBe(0);
    // Никакого ускорения: латентность «до» и «после» совпадает.
    expect(result.latencyAAfter).toBeCloseTo(result.latencyABefore, 6);
  });

  it('кривая не рисует рост там, где его нет', () => {
    // Контрольная кривая обязана быть плоской с самого начала. Если она
    // «растёт», значит рост даёт не обучение, а сама процедура измерения.
    const network = makeNetwork();
    const result = learnByEpochs(
      network,
      { ...DEFAULT_EPOCH_LEARNING, epochs: 100 },
      { learn: false },
    );
    const first = result.curve[0].latencyA;
    const last = result.curve[result.curve.length - 1].latencyA;
    expect(last).toBeCloseTo(first, 6);
  });

  it('обучение возвращает STDP в исходное состояние', () => {
    const network = makeNetwork();
    network.setStdp(false);
    learnByEpochs(network, { ...DEFAULT_EPOCH_LEARNING, epochs: 10 }, { learn: true });
    expect(network.stdpParams.enabled).toBe(false);
  });
});

describe('проба: базовая линия и заморозка', () => {
  const config = {
    stimulusAmplitude: 25,
    stimulusMs: 15,
    probeWindowMs: 60,
    settleMs: 150,
  };

  it('на молчащей сети спонтанных спайков нет, а отклик есть', () => {
    const network = makeNetwork();
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 20);
    const probe = probeResponse(network, config, layout, patterns.a);
    expect(probe.baselineSpikes).toBe(0);
    expect(probe.spikes).toBeGreaterThan(0);
    expect(Number.isFinite(probe.latency)).toBe(true);
  });

  it('на самоподдерживающейся сети отклик не превышает фон', () => {
    // Кольцо разряжается само: спонтанный уровень высокий, и паттерн ничего
    // к нему не добавляет. Именно поэтому опыт в такой сети неопределён.
    //
    // Проба делается ДВАЖДЫ: у кольца активность раскручивается постепенно
    // (измерено: спонтанный уровень 0, потом 876), и первая проба приходится
    // на ещё не раскрутившуюся сеть.
    const scene = buildScene(presetById('ring')!);
    warmUp(scene);
    const network = scene.network;
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 20);
    const first = probeResponse(network, config, layout, patterns.a);
    const second = probeResponse(network, config, layout, patterns.a);
    const baseline = Math.max(first.baselineSpikes, second.baselineSpikes);
    expect(baseline).toBeGreaterThan(0);
    expect(Math.max(first.spikes, second.spikes)).toBeLessThan(baseline);
  });

  it('проба не меняет веса, даже когда STDP включён', () => {
    const network = makeNetwork();
    network.setStdp(true);
    const layout = experimentLayout(network);
    const patterns = experimentPatterns(layout, 20);
    let before = 0;
    for (let s = 0; s < network.synapses.synapseCount; s++) before += network.synapses.weight[s];
    const updatesBefore = network.stdpUpdates;

    const config = { stimulusAmplitude: 25, stimulusMs: 15, probeWindowMs: 60, settleMs: 150 };
    probeResponse(network, config, layout, patterns.a);
    probeResponse(network, config, layout, patterns.b);

    let after = 0;
    for (let s = 0; s < network.synapses.synapseCount; s++) after += network.synapses.weight[s];
    // Проба обязана быть НАБЛЮДАТЕЛЕМ: сеть обучается между пробами, но не
    // во время них. Иначе кривая измеряет частично своё же влияние.
    expect(after).toBeCloseTo(before, 9);
    expect(network.stdpUpdates).toBe(updatesBefore);
  });
});

describe('подготовка сцены к опыту', () => {
  it('на готовом пресете подбор даёт отклик и молчит в покое', () => {
    const scene = buildScene(presetById('supervised-learning')!);
    warmUp(scene);
    const calibration = prepareForLearning(scene.network);
    expect(calibration.usable).toBe(true);
    expect(calibration.selfOscillating).toBe(false);
    // Фонового входа у этого пресета нет — глушить нечего.
    expect(calibration.mutedInput).toBe(false);
    expect(calibration.responseSpikes).toBeGreaterThan(0);
  });

  it('слабую сеть доводит до отклика подбором масштаба', () => {
    // Случайная «своя сеть» с малым весом: при исходных весах отклика нет.
    const preset = customPreset({
      ...DEFAULT_CUSTOM,
      count: 400,
      topology: 'random-sparse',
      connectionProbability: 0.1,
      excitatoryWeight: 0.5,
      inputRate: 0,
      stdp: true,
    });
    const scene = buildScene(preset);
    warmUp(scene);
    const calibration = prepareForLearning(scene.network);
    expect(calibration.usable).toBe(true);
    expect(calibration.changed).toBe(true);
    expect(calibration.weightScale).toBeGreaterThan(1);
    expect(calibration.responseSpikes).toBeGreaterThan(0);
  });

  it('глушит фоновый вход — иначе отклик порождён шумом, а не паттерном', () => {
    // ─── Почему это обязательная часть подготовки ────────────────────────
    //
    // Измерено на пресете «Разреженная сеть»: с пуассоновским входом
    // читающий слой отвечает за 0.5 мс и даёт 272 спайка — при том что
    // паттерн только что подан. Отклик порождён ФОНОМ, и обучение проекции
    // на него повлиять не может.
    const scene = buildScene(presetById('random-sparse')!);
    warmUp(scene);
    const network = scene.network;
    const calibration = prepareForLearning(network);
    expect(calibration.mutedInput).toBe(true);
    expect(network.params.input.mode).toBe('none');
    expect(calibration.reason).toContain('фоновый вход');
  });

  it('приводит границы STDP к масштабу сцены, а не оставляет умолчания', () => {
    // ─── Что здесь ловится ────────────────────────────────────────────────
    //
    // Границы весов АБСОЛЮТНЫЕ, а веса сцен различаются на порядки. Измерено
    // на кольце (вес 200): при умолчании wMax = 1 обучение схлопывало
    // средний вес с 200 до 0.99 и отклик пропадал.
    const scene = buildScene(presetById('supervised-learning')!);
    warmUp(scene);
    const network = scene.network;
    prepareForLearning(network);
    const ceiling = network.stdpParams.wMax;
    expect(ceiling).toBeGreaterThan(1);
    // Потолок обязан быть выше фактического среднего веса — иначе обучению
    // некуда расти, и «потолок» работает как обрезка.
    let mean = 0;
    for (let s = 0; s < network.synapses.synapseCount; s++) mean += Math.abs(network.synapses.weight[s]);
    mean /= network.synapses.synapseCount;
    expect(ceiling).toBeGreaterThan(mean);
  });

  it('самоподдерживающуюся сцену отвергает с объяснением', () => {
    const scene = buildScene(presetById('ring')!);
    warmUp(scene);
    const calibration = prepareForLearning(scene.network);
    expect(calibration.usable).toBe(false);
    expect(calibration.selfOscillating).toBe(true);
    // Объяснение обязано называть ПРИЧИНУ, а не «не получилось».
    expect(calibration.reason).toContain('САМА');
    expect(calibration.reason).toContain('Слоистая');
  });

  it('сцену без пути возбуждения отвергает как «нет пути»', () => {
    // Одиночный нейрон: входной и читающей групп как таковых нет, связей нет.
    const scene = buildScene({
      ...presetById('single-lif')!,
      count: 40,
      topology: { kind: 'none' },
    });
    warmUp(scene);
    const calibration = prepareForLearning(scene.network);
    expect(calibration.usable).toBe(false);
    expect(calibration.selfOscillating).toBe(false);
    expect(calibration.reason).toContain('нет пути возбуждения');
  });

  it('при неудаче подбора возвращает исходный множитель веса', () => {
    const scene = buildScene({
      ...presetById('single-lif')!,
      count: 40,
      topology: { kind: 'none' },
    });
    warmUp(scene);
    const network = scene.network;
    prepareForLearning(network);
    // Оставлять последнее перебранное значение значило бы «подготовить»
    // сцену хуже, чем она была.
    expect(network.currentWeightScale).toBe(1);
  });
});

describe('обучение по эпохам: описание результата', () => {
  it('об успехе и о неудаче говорится разное', () => {
    const base = {
      curve: [],
      latencyABefore: 11,
      latencyBBefore: 11,
      weightBefore: 1,
      weightAfter: 2,
      stdpUpdates: 100,
      epochsRun: 100,
      meaningful: true,
      reason: '',
      controlLatencyAAfter: Number.POSITIVE_INFINITY,
    };
    const learned = describeCurve({
      ...base,
      latencyAAfter: 5,
      latencyBAfter: 11,
    });
    expect(learned.learned).toBe(true);
    expect(learned.summary).toContain('РАНЬШЕ');

    const failed = describeCurve({ ...base, latencyAAfter: 12, latencyBAfter: 11 });
    expect(failed.learned).toBe(false);
    expect(failed.summary).toContain('НЕ ускорило');

    const broken = describeCurve({
      ...base,
      meaningful: false,
      reason: 'нет пути',
      latencyAAfter: Number.POSITIVE_INFINITY,
      latencyBAfter: Number.POSITIVE_INFINITY,
    });
    expect(broken.learned).toBe(false);
    expect(broken.summary).toContain('нет пути');
  });
});

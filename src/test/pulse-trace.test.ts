/**
 * Тесты следа импульсов.
 *
 * ─── Что здесь проверяется и почему именно так ───────────────────────────
 *
 * След импульсов существует ради ВИЗУАЛИЗАЦИИ, и соблазн проверять его
 * «нарисовалось ли что-нибудь» велик. Такой тест был бы бесполезен: он
 * прошёл бы и на следе, который показывает передачи не туда и не тогда.
 *
 * Поэтому главный тест — не про картинку, а про СООТВЕТСТВИЕ ФИЗИКЕ:
 * записанное время прихода сверяется с моментом, когда ток действительно
 * пришёл в нейрон. Если след разойдётся с буфером задержек, тест упадёт.
 *
 * Это тот же принцип, по которому проверяется задержка в `synapses.test.ts`:
 * сверять не поле в структуре, а наблюдаемое следствие.
 */

import { describe, expect, it } from 'vitest';
import { Network } from '../core/network.js';
import { PulseTrace } from '../core/pulse-trace.js';
import { buildSynapses } from '../core/synapses.js';
import { DEFAULT_NETWORK_PARAMS } from '../core/types.js';
import { initNeurons } from '../core/neuron.js';

/** Сеть из двух нейронов со связью 0 → 1 с заданной задержкой. */
function twoNeuronNetwork(delaySteps: number, weight: number): Network {
  const count = 2;
  const params = {
    ...DEFAULT_NETWORK_PARAMS,
    count,
    dt: 0.5,
    input: { mode: 'none' as const, amplitude: 0, rate: 0, weight: 0, fraction: 0 },
  };
  const matrix = buildSynapses(count, [0], [1], [weight], [delaySteps]);
  return new Network(params, matrix);
}

describe('PulseTrace: запись и вытеснение', () => {
  it('хранит записанные события и отдаёт их от свежих к старым', () => {
    const trace = new PulseTrace(4, 2);
    trace.record(0, 1, 0, 1, 5);
    trace.record(1, 2, 0, 1, -5);

    expect(trace.size).toBe(2);
    expect(trace.at(0)).toEqual({ from: 1, to: 2, departMs: 0, arriveMs: 1, weight: -5 });
    expect(trace.at(1)).toEqual({ from: 0, to: 1, departMs: 0, arriveMs: 1, weight: 5 });
  });

  it('вытесняет старые записи и считает вытесненные', () => {
    const trace = new PulseTrace(2, 2);
    for (let i = 0; i < 5; i++) trace.record(i, 0, 0, 1, 1);

    // Ёмкость 2, записано 5: в буфере две последние, вытеснено три.
    expect(trace.size).toBe(2);
    expect(trace.dropped).toBe(3);
    expect(trace.recorded).toBe(5);
    expect(trace.at(0)?.from).toBe(4);
    expect(trace.at(1)?.from).toBe(3);
    // Запись за пределами буфера недоступна, а не «читается мусором».
    expect(trace.at(2)).toBeNull();
  });

  it('сброс очищает буфер и счётчики', () => {
    const trace = new PulseTrace(4, 2);
    trace.record(0, 1, 0, 1, 1);
    trace.reset();
    expect(trace.size).toBe(0);
    expect(trace.recorded).toBe(0);
    expect(trace.dropped).toBe(0);
    expect(trace.at(0)).toBeNull();
  });
});

describe('PulseTrace: прореживание по числу связей', () => {
  it('с одного спайка пишет не больше maxPerSpike связей', () => {
    const count = 11; // 10 исходящих из нейрона 0
    const sources: number[] = [];
    const targets: number[] = [];
    for (let j = 1; j < count; j++) {
      sources.push(0);
      targets.push(j);
    }
    const matrix = buildSynapses(count, sources, targets, targets.map(() => 1), targets.map(() => 1));

    const trace = new PulseTrace(64, 3);
    const written = trace.recordFrom(
      0,
      matrix.rowPtr,
      matrix.colIdx,
      matrix.weight,
      matrix.delaySteps,
      0.5,
      0,
      0,
    );

    expect(written).toBe(3);
    expect(trace.size).toBe(3);
  });

  it('пишет ВСЕ связи, если их не больше предела', () => {
    const matrix = buildSynapses(3, [0, 0], [1, 2], [1, -1], [1, 2]);
    const trace = new PulseTrace(64, 4);
    const written = trace.recordFrom(
      0,
      matrix.rowPtr,
      matrix.colIdx,
      matrix.weight,
      matrix.delaySteps,
      0.5,
      0,
      0,
    );
    expect(written).toBe(2);
  });

  it('прореживание распределено по списку, а не берёт первые N', () => {
    // 10 связей, предел 2 → шаг 5 → выбираются позиции 0 и 5, то есть
    // цели 1 и 6, а НЕ цели 1 и 2.
    const sources: number[] = [];
    const targets: number[] = [];
    for (let j = 1; j <= 10; j++) {
      sources.push(0);
      targets.push(j);
    }
    const matrix = buildSynapses(sources.length + 1, sources, targets, targets.map(() => 1), targets.map(() => 1));
    const trace = new PulseTrace(64, 2);
    trace.recordFrom(0, matrix.rowPtr, matrix.colIdx, matrix.weight, matrix.delaySteps, 0.5, 0, 0);

    const recorded = [trace.at(1)?.to, trace.at(0)?.to].sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(recorded).toEqual([1, 6]);
  });
});

describe('PulseTrace: время жизни события', () => {
  it('событие живо в полёте и затухает после прихода', () => {
    const trace = new PulseTrace(8, 2);
    trace.record(0, 1, 10, 20, 1); // вышел в 10, придёт в 20

    // До прихода — живо.
    expect(trace.countActive(15, 5)).toBe(1);
    // Сразу после прихода — ещё живо (вспышка синапса держится).
    expect(trace.countActive(22, 5)).toBe(1);
    // Спустя holdMs — погасло.
    expect(trace.countActive(30, 5)).toBe(0);
  });

  it('доля пути считается от выхода к приходу', () => {
    const trace = new PulseTrace(8, 2);
    trace.record(0, 1, 10, 20, 1);

    const seen: number[] = [];
    trace.forEachActive(15, 100, (_f, _t, t) => seen.push(t));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeCloseTo(0.5, 9);

    // После прихода доля равна единице: импульс у цели.
    const after: number[] = [];
    trace.forEachActive(25, 100, (_f, _t, t) => after.push(t));
    expect(after[0]).toBe(1);
  });

  it('не зацикливается и не выдаёт лишнего при пустом буфере', () => {
    const trace = new PulseTrace(8, 2);
    expect(trace.countActive(0, 10)).toBe(0);
    expect(trace.forEachActive(0, 10, () => {})).toBe(0);
  });
});

describe('след импульсов соответствует РЕАЛЬНОЙ доставке', () => {
  it('записанное время прихода совпадает с моментом прихода тока', () => {
    // Главный тест модуля. Сеть из двух нейронов: 0 → 1 с задержкой 3 шага.
    // Заставляем нейрон 0 спайкнуть, затем следим, когда ток появится у
    // нейрона 1, и сверяем это с записанным `arriveMs`.
    const delaySteps = 3;
    const network = twoNeuronNetwork(delaySteps, 5);
    const dt = network.params.dt;

    // Инъекция в нейрон 0: гарантированный спайк на первом шаге.
    network.inject(0, 20, dt * 10);

    let spikeStep = -1;
    for (let i = 0; i < 20 && spikeStep < 0; i++) {
      if (network.step() > 0) spikeStep = i;
    }
    expect(spikeStep).toBeGreaterThanOrEqual(0);

    // Событие записано, и его приход — через задержку от НАЧАЛА того шага,
    // на котором спайк был разослан.
    const event = network.pulses.at(0);
    expect(event).not.toBeNull();
    if (!event) return;

    const dispatchedAtMs = spikeStep * dt;
    expect(event.arriveMs).toBeCloseTo(dispatchedAtMs + delaySteps * dt, 9);

    // Теперь доходим до этого момента и проверяем, что ток ДЕЙСТВИТЕЛЬНО
    // пришёл: сравниваем проводимость нейрона 1 до и после.
    let arrivedAtStep = -1;
    for (let i = spikeStep + 1; i <= spikeStep + delaySteps + 1; i++) {
      const before = network['conductance'].g[1];
      network.step();
      const after = network['conductance'].g[1];
      if (arrivedAtStep < 0 && after !== before) arrivedAtStep = i;
    }
    expect(arrivedAtStep).toBeGreaterThanOrEqual(0);

    // Приход по буферу задержек наступает в начале шага `spikeStep + delay`,
    // то есть в момент времени `(spikeStep + delay) · dt`.
    expect(arrivedAtStep).toBe(spikeStep + delaySteps);
    expect(event.arriveMs).toBeCloseTo(arrivedAtStep * dt, 9);
  });

  it('след пишется и при включённом, и при выключенном STDP', () => {
    // След не должен зависеть от обучения: это наблюдение за передачей,
    // а не часть пластичности.
    for (const enabled of [true, false]) {
      const network = twoNeuronNetwork(2, 5);
      network.setStdp(enabled);
      network.inject(0, 20, 5);
      network.run(10);
      expect(network.pulses.size).toBeGreaterThan(0);
    }
  });

  it('запись можно выключить, и это не меняет поведение сети', () => {
    // Ключевое свойство наблюдателя: он не наблюдаем.
    const withTrace = twoNeuronNetwork(2, 5);
    const withoutTrace = twoNeuronNetwork(2, 5);
    withoutTrace.pulseTraceEnabled = false;

    withTrace.inject(0, 20, 20);
    withoutTrace.inject(0, 20, 20);
    for (let i = 0; i < 60; i++) {
      expect(withTrace.step()).toBe(withoutTrace.step());
    }
    // У выключенной записи буфер пуст, у включённой — нет.
    expect(withoutTrace.pulses.recorded).toBe(0);
    expect(withTrace.pulses.recorded).toBeGreaterThan(0);
  });

  it('сброс сети очищает след', () => {
    const network = twoNeuronNetwork(2, 5);
    network.inject(0, 20, 10);
    network.run(20);
    expect(network.pulses.size).toBeGreaterThan(0);
    network.reset();
    expect(network.pulses.size).toBe(0);
  });
});

describe('«удар током» (poke)', () => {
  it('переводит амплитуду из единиц LIF в единицы модели', () => {
    const lif = twoNeuronNetwork(2, 5);
    expect(lif.stimulusScale).toBe(1);

    const izh = twoNeuronNetwork(2, 5);
    izh.params.neuron = { ...izh.params.neuron, model: 'izhikevich' };
    expect(izh.stimulusScale).toBeGreaterThan(1);
  });

  it('удар заставляет ближний нейрон спайкнуть, а дальний — нет', () => {
    // Пространственная сеть: удар в пятно радиуса 1 не должен доходить до
    // нейрона за пределами пятна. Это и есть «точечный» удар.
    const count = 4;
    const params = {
      ...DEFAULT_NETWORK_PARAMS,
      count,
      dt: 0.5,
      input: { mode: 'none' as const, amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    };
    const network = new Network(params, buildSynapses(count, [], [], [], []));
    // Точки вдоль оси X: 0 рядом с ударом, 3 — далеко.
    for (let i = 0; i < count; i++) {
      network.x[i] = i * 10;
      network.y[i] = 0;
    }
    initNeurons(network.state, network.params.neuron, 0);

    network.poke(0, 0, 1, 20, 5);
    network.run(10);

    expect(network.state.spikeCount[0]).toBeGreaterThan(0);
    expect(network.state.spikeCount[3]).toBe(0);
  });

  it('удар действует только заданное время', () => {
    const count = 2;
    const params = {
      ...DEFAULT_NETWORK_PARAMS,
      count,
      dt: 0.5,
      input: { mode: 'none' as const, amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    };
    const network = new Network(params, buildSynapses(count, [], [], [], []));
    network.x[0] = 0;
    network.y[0] = 0;
    network.x[1] = 0;
    network.y[1] = 0;

    network.poke(0, 0, 1, 20, 2);
    network.run(200); // намного дольше длительности удара

    // Пятно снялось: stimulusCurrent обнуляет его по истечении времени.
    const before = network.state.spikeCount[0];
    network.run(200);
    expect(network.state.spikeCount[0]).toBe(before);
  });
});

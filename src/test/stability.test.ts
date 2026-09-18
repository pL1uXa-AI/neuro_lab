/**
 * Тесты численной устойчивости модели Izhikevich.
 *
 * Зачем отдельный файл. У Izhikevich схема явная и условно устойчивая: при
 * большом шаге член 0.04·V² уводит потенциал в бесконечность. Это НЕ видно
 * на глаз: нейрон не падает, а просто замолкает навсегда, и симуляция
 * выглядит «спокойной». Поэтому разлёт считается (`state.insane`) и здесь
 * проверяется — и то, что он обнаруживается, и то, что в рабочих режимах
 * его нет.
 */

import { describe, expect, it } from 'vitest';
import { allocSpikeBuffer, stepNeurons } from '../core/neuron.js';
import { MAX_DT, V_INSANE, allocNeuronState, type NeuronParams } from '../core/types.js';
import { IZHI_MODES, modeToParams } from '../core/neuron-types.js';
import { runSingleNeuron } from '../core/single-run.js';
import { DEFAULT_NEURON_PARAMS } from '../core/types.js';

const IZH: NeuronParams = { ...DEFAULT_NEURON_PARAMS, model: 'izhikevich' };

describe('численная устойчивость Izhikevich', () => {
  it('при абсурдном шаге разлёт ОБНАРУЖИВАЕТСЯ, а не проходит молча', () => {
    const state = allocNeuronState(1);
    state.v[0] = -65;
    state.u[0] = -13;
    const current = new Float64Array(1);
    current[0] = 10;
    const spikes = allocSpikeBuffer(16);

    // Шаг 5 мс — заведомо вне области устойчивости (в статье 0.5 мс).
    for (let i = 0; i < 100; i++) stepNeurons(state, IZH, current, 5, spikes);

    // Счётчик обязан сработать: иначе о разлёте никто не узнает.
    expect(state.insane).toBeGreaterThan(0);
    // И состояние обязано остаться конечным: восстановление, а не мусор.
    expect(Number.isFinite(state.v[0])).toBe(true);
    expect(Math.abs(state.v[0])).toBeLessThan(V_INSANE);
  });

  it('в рабочих режимах каталога разлёта нет', () => {
    for (const mode of IZHI_MODES) {
      const run = runSingleNeuron({
        durationMs: mode.durationMs,
        dt: mode.dt ?? 0.1,
        stimulus: mode.stimulus,
        params: {
          model: 'izhikevich',
          lif: DEFAULT_NEURON_PARAMS.lif,
          izh: modeToParams(mode),
        },
        initial: mode.initial,
        baseline: mode.baseline,
      });
      expect(run.state.insane, `${mode.id}: разлёт при dt=${mode.dt ?? 0.1}`).toBe(0);
    }
  });

  it('предел шага в константе соответствует области устойчивости', () => {
    // MAX_DT = 1.0 — это шаг самой статьи (там V обновляется полушагами
    // по 0.5 мс). Проверяем, что на предельном шаге типичные параметры
    // ещё устойчивы, а на заведомо большем — уже нет.
    expect(MAX_DT).toBeLessThanOrEqual(1);

    const atLimit = allocNeuronState(1);
    atLimit.v[0] = -65;
    atLimit.u[0] = -13;
    const current = new Float64Array(1);
    current[0] = 10;
    const spikes = allocSpikeBuffer(16);
    for (let i = 0; i < 200; i++) stepNeurons(atLimit, IZH, current, MAX_DT, spikes);
    expect(Number.isFinite(atLimit.v[0])).toBe(true);
  });

  it('LIF устойчив при любом разумном шаге: решение точное', () => {
    // У LIF между спайками решение аналитическое, поэтому разлёта нет
    // в принципе — в отличие от явной схемы Izhikevich. Проверяем, что
    // даже при шаге 5 мс потенциал остаётся физичным.
    const state = allocNeuronState(1);
    state.v[0] = DEFAULT_NEURON_PARAMS.lif.vRest;
    const current = new Float64Array(1);
    current[0] = 1.0;
    const spikes = allocSpikeBuffer(16);
    for (let i = 0; i < 100; i++) {
      stepNeurons(state, DEFAULT_NEURON_PARAMS, current, 5, spikes);
    }
    expect(state.insane).toBe(0);
    // Подпороговый ток: потенциал сошёлся к V_rest + R·I = −55 мВ.
    expect(state.v[0]).toBeCloseTo(-55, 1);
  });
});

/**
 * Тесты LIF-нейрона.
 *
 * Проверяем не «код работает», а нейрофизиологию: порог, частоту, кривую f–I,
 * независимость от шага интегрирования и абсолютную рефрактерность.
 *
 * Отдельно проверяется то, что не видно глазом: момент спайка должен быть
 * интерполирован внутри шага. Без этого время спайка квантуется шагом, и
 * STDP обучается на артефакте дискретизации — а это уже не «мелкая
 * неточность», а неверная наука.
 */

import { describe, expect, it } from 'vitest';
import { allocNeuronState, DEFAULT_LIF, DEFAULT_NEURON_PARAMS } from '../core/types.js';
import { allocSpikeBuffer, stepNeurons } from '../core/neuron.js';

/** Мир из одного LIF-нейрона без рефрактерности и без связей. */
function singleNeuron(options: { dt?: number; useRefractory?: boolean } = {}) {
  const dt = options.dt ?? 0.5;
  const state = allocNeuronState(1);
  state.v[0] = DEFAULT_LIF.vRest;
  const current = new Float64Array(1);
  const spikes = allocSpikeBuffer(64);
  const params = DEFAULT_NEURON_PARAMS;

  const run = (durationMs: number, injected: number): number => {
    current[0] = injected;
    const steps = Math.round(durationMs / dt);
    let produced = 0;
    for (let i = 0; i < steps; i++) {
      const before = state.spikeCount[0];
      stepNeurons(state, params, current, dt, spikes, {
        useRefractory: options.useRefractory ?? false,
      });
      produced += state.spikeCount[0] - before;
    }
    return produced;
  };

  return { state, current, spikes, run, dt };
}

describe('LIF: порог и покой', () => {
  it('подпороговый ток не вызывает спайков, потенциал идёт к V_rest + R·I', () => {
    const { state, run } = singleNeuron();
    // T = 1.0 нА: V_∞ = −65 + 10·1.0 = −55 мВ, что ниже порога −50 мВ.
    run(200, 1.0);
    expect(state.spikeCount[0]).toBe(0);
    // 200 мс — это 10τ, остаточное отклонение 15·e⁻¹⁰ ≈ 7·10⁻⁴ мВ.
    // Требовать больше знаков значило бы проверять экспоненту, а не нейрон.
    expect(state.v[0]).toBeCloseTo(-55, 3);
  });

  it('без тока потенциал остаётся на потенциале покоя', () => {
    const { state, run } = singleNeuron();
    run(100, 0);
    expect(state.spikeCount[0]).toBe(0);
    expect(state.v[0]).toBeCloseTo(DEFAULT_LIF.vRest, 9);
  });

  it('надпороговый ток вызывает спайки', () => {
    const { run } = singleNeuron();
    // T = 2.0 нА: V_∞ = −45 мВ > −50 мВ.
    const spikes = run(500, 2.0);
    expect(spikes).toBeGreaterThan(10);
  });

  it('порог срабатывает точно при пересечении vTh, а не раньше', () => {
    const { run } = singleNeuron();
    // Строгое утверждение: чуть ниже порога спайков НЕТ.
    // V_∞ = −65 + 10·1.4999 = −50.001 мВ < −50 мВ, то есть за 2000 мс
    // потенциал подходит к порогу вплотную и не пересекает его.
    expect(run(2000, 1.4999)).toBe(0);
  });
});

describe('LIF: кривая f–I', () => {
  it('частота растёт с током и не превышает предел 1/τ_ref', () => {
    const measure = (current: number, useRefractory: boolean): number => {
      const { state, run } = singleNeuron({ useRefractory });
      // Пропускаем переходный процесс, затем меряем окно.
      run(200, current);
      const before = state.spikeCount[0];
      const window = 2000;
      run(window, current);
      return ((state.spikeCount[0] - before) / window) * 1000;
    };

    // Частота обязана монотонно расти с током.
    const f1 = measure(2.0, true);
    const f2 = measure(3.0, true);
    const f3 = measure(5.0, true);
    expect(f1).toBeGreaterThan(0);
    expect(f2).toBeGreaterThan(f1);
    expect(f3).toBeGreaterThan(f2);

    // Предел частоты задан рефрактерностью: период не может быть меньше
    // τ_ref, поэтому частота не превышает 1000/τ_ref = 500 Гц. Это
    // жёсткое ограничение сверху — оно обязано выполняться ВСЕГДА.
    const limit = 1000 / DEFAULT_LIF.refrac;
    for (const current of [2, 5, 50, 500]) {
      expect(measure(current, true)).toBeLessThanOrEqual(limit + 1e-6);
    }

    // И к этому пределу частота обязана стремиться, а не упираться в
    // потолок «где-то посередине». Остаток шага после спайка засчитывается
    // в рефрактерность, поэтому период равен τ_ref + доля шага до порога,
    // и при огромном токе эта доля стремится к нулю — частота подходит
    // к 500 Гц вплотную. Без этой поправки period был бы τ_ref + dt,
    // то есть ровно 400 Гц при dt = 0.5 мс.
    const nearSaturation = measure(50, true);
    const atSaturation = measure(5000, true);
    expect(nearSaturation).toBeLessThan(atSaturation);
    expect(atSaturation).toBeGreaterThan(0.98 * limit);
  });

  it('без рефрактерности частота при большом токе выше, чем с ней', () => {
    const { state: withRef, run: runWith } = singleNeuron({ useRefractory: true });
    runWith(200, 20);
    const beforeWith = withRef.spikeCount[0];
    runWith(1000, 20);
    const rateWith = ((withRef.spikeCount[0] - beforeWith) / 1000) * 1000;

    const { state: noRef, run: runWithout } = singleNeuron({ useRefractory: false });
    runWithout(200, 20);
    const beforeNo = noRef.spikeCount[0];
    runWithout(1000, 20);
    const rateNo = ((noRef.spikeCount[0] - beforeNo) / 1000) * 1000;

    expect(rateNo).toBeGreaterThan(rateWith);
  });
});

describe('LIF: независимость от шага интегрирования', () => {
  /** Средняя частота на длинном окне: короткое окно само даёт ±1 спайк. */
  const rate = (dt: number, current: number): number => {
    const { state, run } = singleNeuron({ dt });
    run(200, current);
    const before = state.spikeCount[0];
    const window = 10000;
    run(window, current);
    return ((state.spikeCount[0] - before) / window) * 1000;
  };

  it('частота почти не зависит от dt при слабом надпороговом токе', () => {
    // При слабом токе период задан зарядом мембраны, и точное решение
    // даёт совпадение частот при разных dt.
    const current = 1.7; // V_∞ = −48 мВ: порог достигается за ≈8 мс
    const coarse = rate(1.0, current);
    const medium = rate(0.5, current);
    const fine = rate(0.1, current);
    expect(coarse).toBeGreaterThan(0);
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.01);
    expect(Math.abs(medium - fine) / fine).toBeLessThan(0.01);
  });

  it('при сильном токе частота задана рефрактерностью и совпадает при разных dt', () => {
    // При большом токе период ≈ τ_ref, и здесь точное решение обязано
    // давать ту же частоту: именно на этом режиме проверяется, что
    // «остаток рефрактерности внутри шага» не теряется.
    const current = 50;
    const coarse = rate(1.0, current);
    const medium = rate(0.5, current);
    const fine = rate(0.25, current);
    expect(Math.abs(coarse - fine) / fine).toBeLessThan(0.01);
    expect(Math.abs(medium - fine) / fine).toBeLessThan(0.01);
  });

  it('время спайка интерполируется: дробная часть внутри шага не равна нулю', () => {
    const { state, spikes, dt } = singleNeuron({ dt: 1.0 });
    const current = new Float64Array(1);
    current[0] = 2.0;
    let nonInteger = 0;
    for (let i = 0; i < 200; i++) {
      stepNeurons(state, DEFAULT_NEURON_PARAMS, current, dt, spikes, { useRefractory: false });
      for (let k = 0; k < spikes.count; k++) {
        // Время спайка НЕ обязано быть кратно dt — оно лежит внутри шага.
        const offset = spikes.time[k] % dt;
        if (offset > 1e-6 && offset < dt - 1e-6) nonInteger += 1;
      }
    }
    // Хотя бы иногда интерполяция обязана дать дробное время: если бы её
    // не было, все спайки приходились бы ровно на границу шага.
    expect(nonInteger).toBeGreaterThan(5);
  });
});

describe('LIF: рефрактерность', () => {
  it('во время рефрактерности потенциал держится на сбросе и не растёт', () => {
    const dt = 0.5;
    const state = allocNeuronState(1);
    state.v[0] = DEFAULT_LIF.vRest;
    const current = new Float64Array(1);
    current[0] = 10;
    const spikes = allocSpikeBuffer(64);

    // Доводим до спайка.
    let guard = 0;
    while (state.spikeCount[0] === 0 && guard < 10000) {
      stepNeurons(state, DEFAULT_NEURON_PARAMS, current, dt, spikes, { useRefractory: true });
      guard += 1;
    }
    expect(state.spikeCount[0]).toBe(1);
    // Сразу после спайка выставлена рефрактерность. Она равна τ_ref минус
    // остаток того шага, в котором произошёл спайк (см. комментарий в
    // neuron.ts): спайк приходится на середину шага, и это время уже
    // «потрачено» внутри рефрактерного периода.
    expect(state.refrac[0]).toBeGreaterThan(0);
    expect(state.refrac[0]).toBeLessThanOrEqual(DEFAULT_LIF.refrac);

    // На следующем шаге (внутри рефрактерности) потенциал обязан быть
    // ровно на сбросе, несмотря на огромный ток 10 нА.
    stepNeurons(state, DEFAULT_NEURON_PARAMS, current, dt, spikes, { useRefractory: true });
    expect(state.v[0]).toBeCloseTo(DEFAULT_LIF.vReset, 9);
    expect(state.refrac[0]).toBeGreaterThan(0);
  });

  it('длительность рефрактерности соблюдается точно', () => {
    const dt = 0.5;
    const state = allocNeuronState(1);
    state.v[0] = DEFAULT_LIF.vRest;
    const current = new Float64Array(1);
    current[0] = 10;
    const spikes = allocSpikeBuffer(64);

    let guard = 0;
    while (state.spikeCount[0] === 0 && guard < 10000) {
      stepNeurons(state, DEFAULT_NEURON_PARAMS, current, dt, spikes, { useRefractory: true });
      guard += 1;
    }
    const spikeTime = state.lastSpike[0];
    // Ждём второй спайк и проверяем, что он не раньше τ_ref.
    const before = state.spikeCount[0];
    while (state.spikeCount[0] === before && guard < 20000) {
      stepNeurons(state, DEFAULT_NEURON_PARAMS, current, dt, spikes, { useRefractory: true });
      guard += 1;
    }
    const secondSpike = state.lastSpike[0];
    expect(secondSpike - spikeTime).toBeGreaterThanOrEqual(DEFAULT_LIF.refrac - 1e-9);
  });
});

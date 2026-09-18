/**
 * Прогон одиночного нейрона по протоколу стимула.
 *
 * Это «стенд» для каталога режимов: он не знает ни про синапсы, ни про сеть,
 * только про один нейрон и форму тока. Такой стенд нужен, чтобы:
 *   • тесты сигнатур могли гонять режимы без сборки сети;
 *   • интерфейс мог показать «один нейрон и его осциллограмму» как отдельный
 *     экран, не создавая сеть из 1000 клеток ради одной дорожки.
 *
 * Возвращает и времена спайков, и запись потенциала с шагом `recordEveryMs`,
 * чтобы осциллограф и тесты работали с одним и тем же прогоном.
 */

import { allocSpikeBuffer, stepNeurons } from './neuron.js';
import { stimulusCurrent, type StimulusPattern } from './neuron-types.js';
import { allocNeuronState, type NeuronParams } from './types.js';

/** Результат прогона одиночного нейрона. */
export interface SingleRun {
  /** Времена спайков, мс. */
  spikeTimes: number[];
  /** Записанные значения потенциала. */
  v: number[];
  /** Записанные времена. */
  times: number[];
  /** Записанный ток — полезно рисовать вместе с потенциалом. */
  current: number[];
  /** Состояние после прогона (для продолжения). */
  state: ReturnType<typeof allocNeuronState>;
}

/** Параметры прогона. */
export interface SingleRunOptions {
  /** Сколько миллисекунд моделировать. */
  durationMs: number;
  /** Шаг интегрирования, мс. */
  dt?: number;
  /** Через сколько миллисекунд записывать точку осциллограммы. */
  recordEveryMs?: number;
  /** Протокол стимула. */
  stimulus: StimulusPattern;
  /** Параметры нейрона (модель и её константы). */
  params: NeuronParams;
  /** Рефрактерность: для Izhikevich её нет, флаг существует для LIF. */
  useRefractory?: boolean;
  /**
   * Явное начальное состояние (v, u). Обычно не нужно: берётся точка покоя
   * из параметров. Задаётся для режимов, у которых равновесия не существует
   * (бистабильность) — см. поле `initial` в каталоге.
   */
  initial?: { v: number; u: number };
  /**
   * Постоянная составляющая тока поверх протокола. Приходит из каталога
   * (`mode.baseline`): часть режимов живёт на ненулевом фоне.
   */
  baseline?: number;
}

/**
 * Прогнать один нейрон.
 *
 * Времена спайков берутся из состояния нейрона (`lastSpike`), а не из
 * сетки шагов: `stepNeurons` записывает интерполированное время спайка,
 * и именно оно нужно STDP и анализам. Если бы мы собирали времена как
 * `step · dt`, весь смысл интерполяции потерялся бы.
 */
export function runSingleNeuron(options: SingleRunOptions): SingleRun {
  const dt = options.dt ?? 0.1;
  const recordEveryMs = options.recordEveryMs ?? 0.5;
  const params = options.params;
  const state = allocNeuronState(1);

  // Начальное состояние — из параметров модели (там лежит точка покоя,
  // посчитанная для конкретного b и тока) либо явно заданное.
  state.v[0] = options.initial?.v ?? params.izh.vRest;
  state.u[0] = options.initial?.u ?? params.izh.uRest;
  state.lastSpike[0] = Number.NEGATIVE_INFINITY;

  const current = new Float64Array(1);
  const spikes = allocSpikeBuffer(64);
  const spikeTimes: number[] = [];
  const vRecord: number[] = [];
  const timeRecord: number[] = [];
  const currentRecord: number[] = [];

  const steps = Math.max(1, Math.round(options.durationMs / dt));
  const recordEverySteps = Math.max(1, Math.round(recordEveryMs / dt));

  let lastRecordedCount = -1;

  for (let step = 0; step < steps; step++) {
    const t = step * dt;
    const injected = (options.baseline ?? 0) + stimulusCurrent(options.stimulus, t);
    current[0] = injected;

    stepNeurons(state, params, current, dt, spikes, {
      useRefractory: options.useRefractory ?? false,
    });

    // Спайки: `stepNeurons` мог записать несколько (для одного нейрона —
    // максимум один), поэтому проверяем счётчик, а не флаг.
    for (let k = 0; k < spikes.count; k++) {
      if (spikes.index[k] === 0) spikeTimes.push(spikes.time[k]);
    }

    if (step % recordEverySteps === 0 && spikeTimes.length !== lastRecordedCount) {
      // Точку записываем и после спайка: без этого на осциллограмме
      // «пик» спайка не виден — он приходится между отсчётами.
      lastRecordedCount = spikeTimes.length;
    }
    if (step % recordEverySteps === 0) {
      vRecord.push(state.v[0]);
      timeRecord.push(t);
      currentRecord.push(injected);
    }
  }

  return { spikeTimes, v: vRecord, times: timeRecord, current: currentRecord, state };
}

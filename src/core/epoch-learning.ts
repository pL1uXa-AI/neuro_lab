/**
 * Обучение по эпохам: кривая обучения вместо одного числа «до/после».
 *
 * ─── Зачем это отдельно от `experiment.ts` ───────────────────────────────
 *
 * `experiment.ts` отвечает на вопрос «научилась ли сеть» одним числом:
 * разделение откликов до и после. Это доказывает факт обучения, но ничего не
 * говорит о его ХОДЕ. Между «не научилась» и «научилась» лежит самое
 * интересное: как быстро, до какого предела, не портится ли со временем.
 *
 * Здесь обучение разбито на эпохи, и после каждой измеряется ОТКЛИК. На
 * выходе — кривая: она показывает разгон, насыщение и (если есть) срыв.
 *
 * ─── Почему мера — ЛАТЕНТНОСТЬ, а не число спайков ───────────────────────
 *
 * Первая версия мерила отклик числом спайков читающей группы. Измерено, что
 * эта величина принимает ВСЕГО ТРИ значения (40, 80, 120) на 40 нейронах и
 * не меняется при окне измерения 40, 100, 200 и 400 мс. Причина: в живой
 * сети читающий слой отвечает синхронно, и «сколько спайков» кратно числу
 * нейронов. Кривая обучения получалась ЛЕСТНИЦЕЙ из трёх ступеней —
 * ступени выдавали дискретность меры за скачки обучения.
 *
 * Латенность (время до ПЕРВОГО спайка читающего слоя) измеряется по
 * интерполированному времени спайка, то есть непрерывна, и физиологически
 * осмысленна: обученная сеть узнаёт паттерн и отвечает РАНЬШЕ. Измерено на
 * стенде: 15.0 → 10.0 → 8.0 → 6.5 → 6.0 → 5.0 мс по эпохам — гладкая
 * кривая с насыщением.
 *
 * ─── Почему проба замораживает STDP ──────────────────────────────────────
 *
 * Проба сама подаёт стимул и прокручивает сеть, значит при включённом STDP
 * она МЕНЯЕТ веса. Измерено: кривая, снятая обычной пробой, и кривая,
 * снятая с замороженным на время пробы STDP, расходятся (40 → 120 против
 * 40 → 80 к 80-й эпохе). То есть незамороженная проба измеряет частично
 * СВОЁ ЖЕ влияние, а не только обучение.
 *
 * Поэтому проба сохраняет и восстанавливает состояние правила: между
 * эпохами обучение идёт, во время измерения — нет.
 */

import type { Network } from './network.js';
import { experimentLayout, experimentPatterns, type ExperimentLayout } from './experiment.js';

/** Точка кривой обучения: одна эпоха. */
export interface LearningCurvePoint {
  /** Номер эпохи (1-based). */
  epoch: number;
  /** Сколько эпох обучения пройдено. */
  trainedEpochs: number;
  /** Время до первого спайка читающего слоя на паттерн A, мс; Infinity — не ответила. */
  latencyA: number;
  /** То же на необученный паттерн B. */
  latencyB: number;
  /**
   * Выигрыш по A относительно старта, мс. Положительный — сеть отвечает
   * быстрее, то есть обучение работает. `NaN`, если ответа нет.
   */
  gainA: number;
  /** Число спайков читающего слоя на A за окно измерения. */
  spikesA: number;
  /** Средний вес связей из входной группы. */
  meanWeight: number;
}

/** Настройки обучения по эпохам. */
export interface EpochLearningConfig {
  /** Сколько эпох пройти. */
  epochs: number;
  /** Сколько учебных повторов в одной эпохе. */
  repeatsPerEpoch: number;
  /** Сколько эпох между измерениями (1 — мерить каждую). */
  measureEvery: number;
  /** Размер паттерна A и B (число входных нейронов). */
  patternSize: number;
  /** Амплитуда стимула паттерна. */
  stimulusAmplitude: number;
  /** Длительность стимула, мс. */
  stimulusMs: number;
  /** Амплитуда «учителя» в читающий слой. */
  teacherAmplitude: number;
  /** Длительность «учителя», мс. */
  teacherMs: number;
  /** Пауза отдыха после эпохи, мс. */
  restMs: number;
  /** Окно измерения отклика, мс. */
  probeWindowMs: number;
  /** Пауза покоя перед пробой, мс (снимает влияние предыдущей пробы). */
  settleMs: number;
}

/**
 * Настройки по умолчанию — подобраны измерением.
 *
 * ─── Почему ОДИН повтор на эпоху и замер каждые 5 эпох ───────────────────
 *
 * Первая версия брала 10 повторов на эпоху и замер каждые 10 эпох, то есть
 * первая точка кривой приходилась на 100 учебных предъявлений. Измерено, что
 * отклик выходит на насыщение уже к ~60 предъявлениям — поэтому ВСЕ точки
 * кривой оказывались в области плато, и кривая получалась ровной линией
 * `5.0 5.0 5.0 …`. Это не «обучение мгновенное», это слишком грубая сетка
 * измерений: рост происходил между первой и второй точками.
 *
 * Теперь 100 эпох по одному предъявлению и замер каждые 5: двадцать точек
 * приходятся на 5…100 предъявлений, то есть ровно на участок роста и начало
 * плато. Кривая показывает и разгон, и насыщение — то, ради чего она и
 * строится.
 *
 * 120 мс покоя перед пробой: заведомо больше и τ синаптической проводимости
 * (5 мс), и τ следов STDP (20 мс).
 */
export const DEFAULT_EPOCH_LEARNING: EpochLearningConfig = {
  epochs: 100,
  repeatsPerEpoch: 1,
  measureEvery: 5,
  patternSize: 20,
  stimulusAmplitude: 25,
  stimulusMs: 15,
  teacherAmplitude: 25,
  teacherMs: 15,
  restMs: 120,
  probeWindowMs: 60,
  settleMs: 150,
};

/** Результат обучения по эпохам. */
export interface EpochLearningResult {
  /** Кривая: измерения по эпохам. */
  curve: LearningCurvePoint[];
  /** Латентность на A до обучения, мс; Infinity — не ответила. */
  latencyABefore: number;
  /** Латентность на B до обучения, мс. */
  latencyBBefore: number;
  /** Латентность на A после обучения, мс. */
  latencyAAfter: number;
  /** Латентность на B после обучения, мс. */
  latencyBAfter: number;
  /** Латентность на A после обучения БЕЗ обучения (контроль). */
  controlLatencyAAfter: number;
  /** Средний вес до и после. */
  weightBefore: number;
  weightAfter: number;
  /** Обновлений STDP за обучение. */
  stdpUpdates: number;
  /** Сколько эпох реально пройдено (меньше запрошенного, если сеть замолчала). */
  epochsRun: number;
  /** Осмыслен ли опыт: был ли вообще отклик, который можно улучшать. */
  meaningful: boolean;
  /** Почему опыт не осмыслен; пустая строка, если всё в порядке. */
  reason: string;
}

/**
 * Обучить сеть по эпохам и снять кривую обучения.
 *
 * Сеть ИЗМЕНЯЕТСЯ: функция её обучает. Вызывающая сторона решает, на какой
 * сцене это делать (см. `prepareForLearning`, который подбирает рабочую точку).
 *
 * Контроль считается на ОТДЕЛЬНОЙ копии сцены, а не на этой: если прогнать
 * контроль после обучения, он измерял бы «что осталось от обучения», а не
 * «что было бы без него». Копию делает вызывающая сторона и передаёт в
 * `control: true` — эта функция не умеет клонировать `Network`.
 */
export function learnByEpochs(
  network: Network,
  config: EpochLearningConfig = DEFAULT_EPOCH_LEARNING,
  options: { learn?: boolean; layout?: ExperimentLayout } = {},
): EpochLearningResult {
  const learn = options.learn ?? true;
  const layout = options.layout ?? experimentLayout(network);
  const patterns = experimentPatterns(layout, config.patternSize);
  const wasEnabled = network.stdpParams.enabled;

  const weightBefore = meanInputWeight(network, layout);
  // Исходные точки снимаются БЕЗ обучения: «до» обязано быть одинаковым для
  // опыта и контроля, иначе сравнивать их было бы нечем.
  const latencyABefore = probeLatency(network, config, layout, patterns.a);
  const latencyBBefore = probeLatency(network, config, layout, patterns.b);

  const curve: LearningCurvePoint[] = [];
  let epochsRun = 0;

  network.setStdp(learn);
  for (let epoch = 1; epoch <= config.epochs; epoch++) {
    for (let repeat = 0; repeat < config.repeatsPerEpoch; repeat++) {
      trainOnce(network, config, layout, patterns.a);
    }
    epochsRun = epoch;

    if (epoch % config.measureEvery === 0 || epoch === config.epochs) {
      const probeA = probeResponse(network, config, layout, patterns.a);
      const probeB = probeResponse(network, config, layout, patterns.b);
      curve.push({
        epoch,
        trainedEpochs: epoch * config.repeatsPerEpoch,
        latencyA: probeA.latency,
        latencyB: probeB.latency,
        gainA: Number.isFinite(probeA.latency) ? latencyABefore - probeA.latency : Number.NaN,
        spikesA: probeA.spikes,
        meanWeight: meanInputWeight(network, layout),
      });
    }

    // Ранний выход: если сеть молчит и на старте, и на нескольких
    // измерениях подряд, продолжать незачем. Это не «оптимизация», а
    // честность: кривая не должна рисовать обучение там, где измерять уже
    // нечего. Условие требует НЕСКОЛЬКО пустых измерений, чтобы не сработать
    // на первом же, которое может прийтись на неудачный момент.
    if (!Number.isFinite(latencyABefore) && curve.length >= 3) {
      const tail = curve.slice(-3);
      if (tail.every((point) => !Number.isFinite(point.latencyA))) break;
    }
  }
  const stdpUpdates = network.stdpUpdates;
  network.setStdp(wasEnabled);

  const latencyAAfter = probeLatency(network, config, layout, patterns.a);
  const latencyBAfter = probeLatency(network, config, layout, patterns.b);
  const weightAfter = meanInputWeight(network, layout);

  // Опыт осмыслен, если читающий слой ВООБЩЕ отвечает хотя бы после обучения.
  // Если не отвечает ни до, ни после — измерять латентность не у чего.
  const meaningful =
    Number.isFinite(latencyAAfter) || Number.isFinite(latencyBAfter) || Number.isFinite(latencyABefore);
  let reason = '';
  if (!meaningful) {
    reason =
      'читающий слой не отвечает на стимул входов: между группами нет ' +
      'достаточного пути возбуждения';
  }
  return {
    curve,
    latencyABefore,
    latencyBBefore,
    latencyAAfter,
    latencyBAfter,
    // Контроль заполняет вызывающая сторона: он требует отдельной копии.
    controlLatencyAAfter: Number.POSITIVE_INFINITY,
    weightBefore,
    weightAfter,
    stdpUpdates,
    epochsRun,
    meaningful,
    reason,
  };
}

/** Сколько спайков читающего слоя было в последней пробе (для кривой). */
export interface ProbeOutcome {
  /** Время до первого спайка читающего слоя, мс; Infinity — ответа не было. */
  latency: number;
  /**
   * Спайков читающего слоя СВЕРХ спонтанного уровня (может быть
   * отрицательным, если со стимулом их вышло меньше, чем без него).
   */
  spikes: number;
  /** Сколько спайков читающий слой дал БЕЗ стимула за то же окно. */
  baselineSpikes: number;
}

/**
 * Одна учебная эпоха: стимул A, затем «учитель» в читающий слой.
 *
 * «Учитель» обязателен: без него не возникает пары «пре-до-пост», и STDP
 * ничего не усиливает — сеть просто видит стимул.
 */
function trainOnce(
  network: Network,
  config: EpochLearningConfig,
  layout: ExperimentLayout,
  pattern: readonly number[],
): void {
  pulse(network, pattern, config.stimulusAmplitude, config.stimulusMs);
  runMs(network, config.stimulusMs);
  const readout = range(layout.readoutStart, layout.readoutEnd);
  pulse(network, readout, config.teacherAmplitude, config.teacherMs);
  runMs(network, config.teacherMs + config.restMs);
}

/**
 * Всё, что нужно пробе для измерения отклика.
 *
 * Отдельный тип, а не `EpochLearningConfig`: подбор масштаба
 * (`prepareForLearning`) пробует разные веса и никаких «эпох» не имеет —
 * требовать от него целый конфиг обучения значило бы тащить ненужные поля
 * через весь код.
 */
export interface ProbeConfig {
  stimulusAmplitude: number;
  stimulusMs: number;
  probeWindowMs: number;
  settleMs: number;
}

/**
 * Измерить отклик читающего слоя на паттерн.
 *
 * ─── Почему латентность, а не число спайков ──────────────────────────────
 *
 * «Узнавание» — это КОГДА сеть успела ответить, а не сколько всего. Первый
 * спайк — единственная точка, не зависящая от длительности окна измерения:
 * измерено, что при окне 40, 100, 200 и 400 мс число спайков не менялось
 * вовсе (оно принимает всего три значения на 40 нейронах), то есть кривая
 * обучения по нему получалась лестницей из трёх ступеней.
 *
 * ─── Базовая линия обязательна ───────────────────────────────────────────
 *
 * У «Кольца» сеть разряжается САМА, без всякого стимула. Первая версия пробы
 * засчитывала такие спайки как ответ на паттерн: измерено, что у кольца
 * «латентность» выходила **0.0 мс** — то есть сеть якобы отвечала мгновенно,
 * хотя её активность к паттерну отношения не имела. Дальше кривая получала
 * случайные числа (58.8 мс, потом снова 0.2), и вердикт был бессмысленным.
 *
 * Поэтому проба сначала измеряет СПОНТАННУЮ активность за то же окно БЕЗ
 * стимула, и вычитает её. Латентность ответа считается только по спайкам,
 * которые нельзя объяснить спонтанной активностью: если спонтанных спайков
 * не меньше, чем со стимулом, ответа нет (`Infinity`).
 *
 * Возвращается `Infinity`, если ответа не было: это НЕ ноль и не «очень
 * долго» — это «не ответила», и путать эти состояния нельзя.
 *
 * ─── Заморозка STDP на время пробы ───────────────────────────────────────
 *
 * Проба двигает сеть, значит при включённом правиле меняет веса. Измерено,
 * что это искажает кривую. Поэтому правило выключается на время измерения и
 * включается обратно — сеть обучается МЕЖДУ пробами, но не ВО ВРЕМЯ них.
 */
export function probeResponse(
  network: Network,
  config: ProbeConfig,
  layout: ExperimentLayout,
  pattern: readonly number[],
  options: { measureBaseline?: boolean } = {},
): ProbeOutcome {
  const wasEnabled = network.stdpParams.enabled;
  const measureBaseline = options.measureBaseline ?? true;
  network.setStdp(false);
  try {
    // ─── 1. Спонтанная активность: то же окно, но БЕЗ стимула ────────────
    //
    // Подготовка сцены измеряет фон САМА и несколько раз (см.
    // `prepareForLearning`): у самоподдерживающихся сцен он раскручивается
    // постепенно, и одной пробы мало. Здесь фон остаётся для одиночных проб
    // (кривая обучения, тесты), где он нужен как защита от того, чтобы
    // принять чужую активность за ответ.
    let baseline = { latency: Number.POSITIVE_INFINITY, spikes: 0, baselineSpikes: 0 };
    if (measureBaseline) {
      runMs(network, config.settleMs);
      baseline = runWindow(network, windowSteps(network, config), layout);
    }

    // ─── 2. Ответ на паттерн ─────────────────────────────────────────────
    runMs(network, config.settleMs);
    const startedAt = network.state.time;
    pulse(network, pattern, config.stimulusAmplitude, config.stimulusMs);
    const response = runWindow(network, windowSteps(network, config), layout, startedAt);

    const extra = response.spikes - baseline.spikes;
    if (extra <= 0) {
      // Стимул не добавил спайков сверх спонтанного уровня. Для
      // самоподдерживающейся сети (кольцо) это НОРМАЛЬНЫЙ случай: она
      // разряжается сама, и «ответ на паттерн» в ней не определён.
      return {
        latency: Number.POSITIVE_INFINITY,
        spikes: extra,
        baselineSpikes: baseline.spikes,
      };
    }
    return { latency: response.latency, spikes: extra, baselineSpikes: baseline.spikes };
  } finally {
    network.setStdp(wasEnabled);
  }
}

/** Длина окна измерения в шагах. */
function windowSteps(network: Network, config: ProbeConfig): number {
  return Math.max(1, Math.round(config.probeWindowMs / network.params.dt));
}

/**
 * Прокрутить окно измерения и собрать спайки читающего слоя.
 *
 * `startedAt` задаёт начало отсчёта латентности; без него (базовая линия)
 * латентность не считается вовсе — она для базовой линии бессмысленна.
 */
function runWindow(
  network: Network,
  steps: number,
  layout: ExperimentLayout,
  startedAt?: number,
): ProbeOutcome {
  let first = Number.POSITIVE_INFINITY;
  let spikes = 0;
  for (let step = 0; step < steps; step++) {
    network.step();
    for (let i = layout.readoutStart; i < layout.readoutEnd; i++) {
      if (network.state.spiked[i] === 0) continue;
      spikes += 1;
      if (first === Number.POSITIVE_INFINITY && startedAt !== undefined) {
        // Время спайка ИНТЕРПОЛИРОВАНО внутри шага (инвариант 1), поэтому
        // латентность непрерывна, а не кратна dt.
        first = network.state.lastSpike[i] - startedAt;
      }
    }
  }
  return { latency: first, spikes, baselineSpikes: 0 };
}

/** Латентность ответа — тонкая обёртка над `probeResponse`. */
function probeLatency(
  network: Network,
  config: EpochLearningConfig,
  layout: ExperimentLayout,
  pattern: readonly number[],
): number {
  return probeResponse(network, config, layout, pattern).latency;
}

/** Средний МОДУЛЬ веса по всем связям — для подбора границ STDP. */
function meanAbsoluteWeight(network: Network): number {
  const matrix = network.synapses;
  if (matrix.synapseCount === 0) return 0;
  let sum = 0;
  for (let s = 0; s < matrix.synapseCount; s++) sum += Math.abs(matrix.weight[s]);
  return sum / matrix.synapseCount;
}

/** Средний вес связей, выходящих из входной группы. */
function meanInputWeight(network: Network, layout: ExperimentLayout): number {
  const matrix = network.synapses;
  let sum = 0;
  let count = 0;
  for (let i = layout.inputStart; i < layout.inputEnd; i++) {
    for (let s = matrix.rowPtr[i]; s < matrix.rowPtr[i + 1]; s++) {
      sum += matrix.weight[s];
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Прямая инъекция тока в перечисленные нейроны. */
function pulse(
  network: Network,
  indices: readonly number[],
  amplitude: number,
  durationMs: number,
): void {
  for (const index of indices) network.inject(index, amplitude, durationMs);
}

/** Продвинуть сеть на указанное число миллисекунд модельного времени. */
function runMs(network: Network, ms: number): void {
  const steps = Math.max(1, Math.round(ms / network.params.dt));
  network.run(steps);
}

/** Массив подряд идущих индексов [start, end). */
function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/**
 * Словами: что показывает кривая.
 *
 * Возвращается ФАКТ, включая отрицательный. Если сеть отвечает с одинаковой
 * латентностью на A и B, так и написано — «различения нет», а не «обучение
 * идёт».
 */
export function describeCurve(
  result: EpochLearningResult,
  control?: EpochLearningResult,
): { learned: boolean; summary: string } {
  if (!result.meaningful) {
    return { learned: false, summary: `Опыт не получился: ${result.reason}.` };
  }

  const fmt = (value: number): string =>
    Number.isFinite(value) ? `${value.toFixed(1)} мс` : 'нет ответа';
  const gainA = Number.isFinite(result.latencyABefore) && Number.isFinite(result.latencyAAfter)
    ? result.latencyABefore - result.latencyAAfter
    : Number.NaN;
  const gainB = Number.isFinite(result.latencyBBefore) && Number.isFinite(result.latencyBAfter)
    ? result.latencyBBefore - result.latencyBAfter
    : Number.NaN;

  const learned = Number.isFinite(gainA) && gainA > 0;

  let summary =
    `Латентность ответа на A: ${fmt(result.latencyABefore)} → ${fmt(result.latencyAAfter)}` +
    (Number.isFinite(gainA) ? ` (быстрее на ${gainA.toFixed(1)} мс)` : '') +
    `. На необученный B: ${fmt(result.latencyBBefore)} → ${fmt(result.latencyBAfter)}` +
    (Number.isFinite(gainB) ? ` (${gainB >= 0 ? 'быстрее' : 'медленнее'} на ${Math.abs(gainB).toFixed(1)} мс)` : '') +
    `.`;

  if (!learned) {
    summary +=
      ' Обучение НЕ ускорило ответ на обученный паттерн: различения не возникло. ' +
      'Это честный результат, а не ошибка счёта.';
  } else {
    summary += ' Сеть отвечает на обученный паттерн РАНЬШЕ, чем до обучения.';
  }

  if (control) {
    summary +=
      ` Контроль (те же эпохи с выключенным обучением): ` +
      `A ${fmt(control.latencyABefore)} → ${fmt(control.latencyAAfter)}.`;
  }

  return { learned, summary };
}

// ─── Подготовка сцены к опыту ────────────────────────────────────────────

/** Настройки подготовки сцены. */
export interface CalibrationConfig {
  /** Множители веса, которые перебираются по возрастанию. */
  scales: number[];
  /** Размер паттерна при подборе. */
  patternSize: number;
  /** Амплитуда стимула. */
  stimulusAmplitude: number;
  /** Длительность стимула, мс. */
  stimulusMs: number;
  /** Окно измерения отклика, мс. */
  probeWindowMs: number;
  /** Пауза покоя перед пробой, мс. */
  settleMs: number;
  /**
   * Сколько нейронов читающего слоя должно сработать, чтобы отклик считался
   * пригодным. Малый порог осознан: нужен СЛАБЫЙ, но существующий отклик —
   * тогда обучению есть куда расти.
   */
  minSpikes: number;
  /** Сколько учебных повторов в пробной эпохе при подборе. */
  probeEpochs: number;
  /**
   * Сколько окон покоя измерить, чтобы оценить спонтанную активность.
   *
   * Больше одного обязательно: у самоподдерживающихся сцен активность
   * раскручивается постепенно — измерено на кольце 0, 876, 1567 спайков по
   * последовательным пробам. По первому окну сцена выглядела бы молчащей.
   */
  baselineProbes: number;
  /**
   * Во сколько раз потолок веса выше среднего модуля веса сцены.
   *
   * 4 выбрано по измерению: при границах по умолчанию (wMax = 1, абсолютное
   * число) кольцо с весом 200 схлопывалось до 0.99 и теряло отклик; при 4×
   * средний вес установился на 109 при исходных 200 — сеть сохранилась и
   * продолжила отвечать.
   */
  boundsFactor: number;
}

/**
 * Настройки подготовки по умолчанию.
 *
 * Перебор идёт по множителям веса, а не по абсолютным значениям: базовые
 * веса сцен различаются на порядки (0.15 у разреженной сети, 200 у волны),
 * и один абсолютный вес не подошёл бы никому.
 */
export const DEFAULT_CALIBRATION: CalibrationConfig = {
  scales: [1, 2, 4, 8, 16, 32, 64, 128],
  patternSize: 20,
  stimulusAmplitude: 25,
  stimulusMs: 15,
  probeWindowMs: 60,
  settleMs: 150,
  minSpikes: 1,
  probeEpochs: 10,
  baselineProbes: 4,
  boundsFactor: 4,
};

/**
 * Порог, с которого сеть считается самоподдерживающейся, спайков за окно.
 *
 * 100 — середина РЕЗКОГО зазора, измеренного на семи сценах (окно покоя
 * 60 мс, читающий слой — половина сети):
 *
 * | Сцена | Спонтанных спайков |
 * |---|---|
 * | пресет «Опыт», своя слоистая, своя случайная, разреженная | **0** |
 * | кольцо | 876…1607 |
 * | рабочая память | 2981…3000 |
 * | волна | 37 090…37 120 |
 *
 * Ноль у первых четырёх — не совпадение: их сети в покое молчат, пока не
 * придёт возбуждение по связям. У остальных активность держится сама.
 * Порог берётся посередине, чтобы классы не путались ни при каком разбросе.
 */
const SELF_OSCILLATION_MIN = 100;

/** Что получилось при подготовке сцены. */
export interface CalibrationResult {  /** Подобранный множитель веса (1 — подбирать не пришлось). */
  weightScale: number;
  /** Отклик в подобранной точке: сколько спайков дала проба. */
  responseSpikes: number;
  /** Латентность в подобранной точке, мс; Infinity — ответа нет. */
  latency: number;
  /** Перебирались ли значения вообще (false — отклик был при исходном весе). */
  changed: boolean;
  /** Удалось ли подготовить сцену. `false` — обучать нечего. */
  usable: boolean;
  /** Человекочитаемое объяснение, включая отказ. */
  reason: string;
  /** Снятый ли при подборе фоновый вход (и восстановлен ли после). */
  mutedInput: boolean;
  /** Потолок веса, установленный по масштабу сцены (для отчёта). */
  weightCeiling: number;
  /** Сеть разряжается сама, без стимула: опыт в ней не определён. */
  selfOscillating: boolean;
}

/**
 * Подготовить сцену к опыту обучения: убрать конфаунды и подобрать масштаб.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Опыт работал только на специально подобранной сцене. На произвольных
 * «своих сетях» он давал нулевое различение, и это выглядело как «обучение
 * сломано», хотя причина была в другом. Здесь устраняются ДВЕ причины,
 * обе найденные измерением.
 *
 * ─── 1. Фоновый вход делает паттерн неразличимым ─────────────────────────
 *
 * Измерено на пресете «Разреженная сеть»: с пуассоновским входом читающий
 * слой отвечает за **0.5 мс** и даёт **272 спайка** — при том что паттерн A
 * подан только что. Отклик порождён ФОНОМ, а не паттерном, поэтому никакое
 * обучение проекции на него не повлияет. С выключенным входом там же —
 * **0 спайков**: сеть отвечает только на связи.
 *
 * Физически это честно: если нейрон и так разряжается от шума, «узнавание»
 * паттерна не имеет смысла. Поэтому на время опыта вход глушится, а затем
 * восстанавливается — и это записывается в результат, а не делается молча.
 *
 * ─── 2. Масштаб весов может быть ниже порога распространения ─────────────
 *
 * Измерено на «своей сети» (400 нейронов, случайная, вес 0.5): при
 * множителях 1, 2 и 4 отклика НЕТ вовсе, при 8 появляется (14.0 мс, 33
 * спайка), при 16 — 8.5 мс. То есть при исходных весах обучать нечего, и
 * опыт возвращал «не научилась» без объяснения причины.
 *
 * Подбирается НАИМЕНЬШИЙ множитель, дающий отклик: нужен слабый, но
 * существующий ответ, а не максимальный. При максимальном сеть уже
 * разряжается и обучать нечего.
 *
 * ─── Почему функция МЕНЯЕТ сеть ──────────────────────────────────────────
 *
 * Это подготовка, а не измерение: она настраивает сцену и сообщает, что
 * сделала. Восстановление входа выполняется здесь же; множитель веса
 * остаётся подобранным намеренно — пользователь должен видеть, с какой сети
 * снят результат.
 */
export function prepareForLearning(
  network: Network,
  config: CalibrationConfig = DEFAULT_CALIBRATION,
): CalibrationResult {
  const layout = experimentLayout(network);
  const patterns = experimentPatterns(layout, config.patternSize);

  // ─── Шаг 1: заглушить фоновый вход ─────────────────────────────────────
  const input = network.params.input;
  const savedMode = input.mode;
  const mutedInput = savedMode !== 'none';
  if (mutedInput) input.mode = 'none';

  // ─── Шаг 2: измерить СПОНТАННУЮ активность ─────────────────────────────
  //
  // ─── Почему это отдельный шаг, а не «фон из пробы» ─────────────────────
  //
  // У самоподдерживающихся сцен активность раскручивается постепенно:
  // измерено на кольце — спонтанный уровень 0, потом 876, потом 1567
  // спайков. Первая проба приходится на ещё не раскрутившуюся сеть, поэтому
  // «фон из одной пробы» даёт НОЛЬ и сцена выглядит обычной.
  //
  // Поэтому фон измеряется отдельно и НЕСКОЛЬКО раз, без всякого стимула:
  // берётся максимум. Это честнее и проще, чем полагаться на побочный
  // эффект учебных проб.
  const baselineWindows = Math.max(2, config.baselineProbes);
  let maxBaseline = 0;
  for (let k = 0; k < baselineWindows; k++) {
    runMs(network, config.settleMs);
    const window = runWindow(network, windowSteps(network, config), layout);
    if (window.spikes > maxBaseline) maxBaseline = window.spikes;
  }

  // ─── Шаг 3: подобрать масштаб ──────────────────────────────────────────
  let chosen = network.currentWeightScale;
  let response: ProbeOutcome = {
    latency: Number.POSITIVE_INFINITY,
    spikes: 0,
    baselineSpikes: maxBaseline,
  };
  let changed = false;

  // Фон измерен отдельно выше, поэтому проба не меряет его сама: иначе она
  // вычитала бы фон, уже учтённый снаружи, и отклик занижался бы дважды.
  const measure = (): ProbeOutcome =>
    probeResponse(network, config, layout, patterns.a, { measureBaseline: false });

  const initial = measure();
  if (initial.spikes >= config.minSpikes && Number.isFinite(initial.latency)) {
    // Отклик есть при исходных весах — подбирать нечего. Это правильный
    // случай для измеренных пресетов: их веса подобраны заранее.
    response = initial;
    chosen = network.currentWeightScale;
  } else {
    for (const scale of config.scales) {
      network.setWeightScale(scale);
      const probe = measure();
      chosen = scale;
      response = probe;
      changed = true;
      if (probe.spikes >= config.minSpikes && Number.isFinite(probe.latency)) break;
    }
  }

  // Если подбор не помог, вернуть исходный множитель: оставлять последнее
  // перебранное значение значило бы «подготовить» сцену хуже, чем она была.
  const usable = response.spikes >= config.minSpikes && Number.isFinite(response.latency);
  if (!usable && changed) {
    network.setWeightScale(1);
    chosen = 1;
  }
  // Фон переносится в итоговый отклик: он измерен ОТДЕЛЬНО и относится к
  // сцене в целом, а не к конкретной пробе.
  response = { ...response, baselineSpikes: maxBaseline };

  // ─── Шаг 3: привести границы STDP к масштабу сцены ─────────────────────
  //
  // ─── Почему это обязательная часть подготовки ──────────────────────────
  //
  // Границы весов — АБСОЛЮТНЫЕ числа, а базовые веса сцен различаются на
  // порядки. Если границы остались умолчаниями (0…1), а веса сцены равны
  // 200, то первое же обновление ОБРЕЗАЕТ связи до единицы — сеть
  // разрушается, и опыт честно сообщает «не научилась».
  //
  // Измерено на пресете «Кольцо» (вес 200): при границах по умолчанию
  // обучение схлопывало средний вес с **200 до 0.99**, и отклик пропадал
  // полностью. С границами по масштабу сцены (wMax = 4 × средний вес) средний
  // вес остался **108.97**, а отклик сохранился.
  //
  // Потолок берётся как 4× от фактического среднего модуля веса, а не
  // «сколько угодно»: обучение должно иметь куда расти, но не должно уметь
  // разогнать сеть в разлёт. Нижняя граница — 0: отрицательные веса
  // тормозные, и STDP их не обучает (см. `stdp.ts`).
  if (usable) {
    const meanMagnitude = meanAbsoluteWeight(network);
    if (meanMagnitude > 0) {
      network.setStdp(network.stdpParams.enabled, {
        ...network.stdpParams,
        wMin: 0,
        wMax: meanMagnitude * config.boundsFactor,
      });
    }
  }

  // ─── Вердикт ───────────────────────────────────────────────────────────
  //
  // ─── Самоподдерживающаяся сеть: опыт в ней не определён ─────────────────
  //
  // Измерено, что сцены делятся на два класса С РЕЗКИМ зазором:
  //
  //   спонтанных спайков за окно покоя:  0    у «пресета Опыт», слоистой,
  //                                           случайной и разреженной сетей;
  //                                  876…37115 у кольца, рабочей памяти и волны.
  //
  // В сетях второго класса активность самоподдерживающаяся: волна бежит по
  // решётке, кольцо крутится, память держит возбуждение. Там понятие «узнать
  // паттерн» не определено: ответ задаётся собственным ритмом сети, а не
  // входом. Видно и по числам — у кольца со второй пробы спонтанный уровень
  // 876 спайков, а отклик на паттерн 655, то есть МЕНЬШЕ фона.
  //
  // ЛОВУШКА: у кольца ПЕРВАЯ проба даёт спонтанный уровень 0. Активность
  // там раскручивается постепенно (измерено по пробам: 0, 876, 1567), и
  // первая проба приходится на ещё не раскрутившуюся сеть. Поэтому
  // достаточно ОДНОЙ пробы с высоким фоном, чтобы признать сцену
  // самоподдерживающейся, — а не требовать высокий фон в каждой.
  //
  // Это НЕ «опыт не удался»: причина в природе сцены, а не в параметрах.
  // Поэтому случай выделяется отдельным вердиктом — иначе пользователь
  // будет подбирать вес и торможение там, где дело не в них.
  const selfOscillating = response.baselineSpikes >= SELF_OSCILLATION_MIN;

  // «Пригодна» означает: отклик есть И сцена не самоподдерживающаяся.
  // Без второй части вердикт был противоречив: у кольца отклик при
  // подобранном весе формально есть (655 спайков), и сцена объявлялась
  // готовой — при том что объяснение тут же сообщало, что опыт в ней
  // неопределён.
  const ready = usable && !selfOscillating;

  let reason: string;
  if (selfOscillating) {
    reason =
      `сеть разряжается САМА, без стимула: ${response.baselineSpikes} спайков ` +
      'за окно покоя. В такой сети «узнавание паттерна» не определено — ответ ' +
      'задаётся собственным ритмом сети, а не входом. Для опыта нужна сеть, ' +
      'которая в покое молчит: например, структура «Слоистая» в панели ' +
      '«Своя сеть»';
  } else if (usable) {
    reason = changed
      ? `отклик появился при весе ${chosen}×: ${response.spikes} спайков, ` +
        `латентность ${response.latency.toFixed(1)} мс`
      : `отклик есть при исходном весе: ${response.spikes} спайков, ` +
        `латентность ${response.latency.toFixed(1)} мс`;
    if (mutedInput) {
      reason +=
        '; фоновый вход на время опыта выключен — иначе отклик порождён ' +
        'шумом, а не паттерном';
    }
  } else {
    reason =
      'между входной и читающей группами нет пути возбуждения: перебраны ' +
      `множители веса ${config.scales.join(', ')}, отклика нет ни при одном. ` +
      'Нужна сеть с направленными связями от входов к читающему слою — ' +
      'например, структура «Слоистая» в панели «Своя сеть»';
  }

  return {
    weightScale: chosen,
    responseSpikes: response.spikes,
    latency: response.latency,
    changed,
    usable: ready,
    reason,
    mutedInput,
    weightCeiling: ready ? network.stdpParams.wMax : 0,
    selfOscillating,
  };
}


/**
 * Опыт по обучению: проверяемое измерение того, что сеть ЧЕМУ-ТО НАУЧИЛАСЬ.
 *
 * ─── Зачем этот модуль ───────────────────────────────────────────────────
 *
 * До него проект умел показать, что «веса изменились»: счётчик обновлений
 * STDP, разброс весов, средний вес. Но нигде не было ответа на вопрос, ради
 * которого обучение вообще существует: **стала ли сеть вести себя иначе?**
 *
 * Разница принципиальная. Веса могут гулять сколько угодно и при этом ни на
 * что не влиять — и именно это здесь и происходило. Измерено на пресете
 * «Обучение STDP»: после 1 200 000 обновлений веса лежали в диапазоне
 * 0.038…0.234 при том, что отклик читающего нейрона в этих сетях начинается
 * около веса 6. То есть обучение шло, а поведение не менялось НИКОГДА —
 * упор в потолок `DEFAULT_STDP.wMax = 1`.
 *
 * ─── Протокол ────────────────────────────────────────────────────────────
 *
 * Классическая схема «обучение с учителем» на спайковой сети:
 *
 *   обучение:  стимул A → (пауза) → «учитель» заставляет читающий слой
 *              сработать. Пре-спайк приходит РАНЬШЕ пост-спайка, поэтому
 *              STDP усиливает связи тех входов, что были активны.
 *   проверка:  стимул A БЕЗ учителя → сколько спайков дал читающий слой?
 *              стимул B БЕЗ учителя → столько же?
 *
 * Если обучение работает, отклик на A вырастает, а на B — нет. Это и есть
 * «реальный результат»: сеть научилась отличать A от B, и это видно числом.
 *
 * ─── Контроль обязателен ─────────────────────────────────────────────────
 *
 * Тот же протокол прогоняется с ВЫКЛЮЧЕННЫМ STDP. Разница между опытом и
 * контролем — доказательство, что эффект дало обучение, а не сама по себе
 * стимуляция. Без контроля «отклик вырос» ничего не значит: сеть могла
 * «разогреться» просто от повторения стимула.
 */

import type { Network } from './network.js';

/** Параметры опыта. Все значения — в единицах проекта (мс, нА/единицы модели). */
export interface LearningExperimentConfig {
  /** Сколько входных нейронов входит в каждый паттерн. */
  patternSize: number;
  /** Сколько учебных эпох прогнать. */
  trials: number;
  /** Амплитуда стимула входа. */
  stimulusAmplitude: number;
  /** Длительность стимула входа, мс. */
  stimulusMs: number;
  /** Пауза между стимулом и «учителем», мс. */
  gapMs: number;
  /** Амплитуда «учителя» (тока в читающий слой). */
  teacherAmplitude: number;
  /** Длительность «учителя», мс. */
  teacherMs: number;
  /** Пауза отдыха после каждой эпохи, мс. */
  restMs: number;
  /** Сколько миллисекунд измерять отклик при проверке. */
  testMs: number;
}

/**
 * Параметры по умолчанию — подобраны ИЗМЕРЕНИЕМ, а не на глаз.
 *
 * Перебор рабочей точки (30 эпох, сеть 40 входов → 40 читающих):
 *
 * | вес | паттерн | зазор | вес после | отклик A | разделение | контроль |
 * |---|---|---|---|---|---|---|
 * | 1.0 | 10 | 12 мс | 1.39 | **0** | 0 | 0 |
 * | 1.0 | 20 | 12 мс | 1.39 | **0** | 0 | 0 |
 * | 1.5 | 20 | 0 мс | 3.09 | 40 → 120 | **80** | 0 |
 * | 0.5 | 20 | 5 мс | 1.75 | 0 → 80 | **80** | 0 |
 *
 * Строки 1–2 объясняют зазор: `gapMs = 12` СРЫВАЕТ обучение. Причина не в
 * STDP, а в таймингах — вход спайкует на 1.5, 5.0, 9.0 и 12.5 мс от начала
 * стимула, поэтому «учитель», поданный через 12 мс, попадает между
 * пре-спайками и пост-спайком читающего слоя ложится ДЕПРЕССИЯ. Выбран
 * зазор 0: учитель идёт сразу после стимула, и все пре-спайки оказываются
 * раньше пост-спайков — то есть ровно та пара, которой STDP и усиливает.
 *
 * Проверено на зёрнах 1, 2, 3, 7, 42, 99: разделение 80 ± 0 везде, контроль
 * (то же с выключенным STDP) — 0 везде. На пресете «Обучение с учителем»
 * разделение 57–62 при 0 в контроле.
 */
export const DEFAULT_EXPERIMENT: LearningExperimentConfig = {
  patternSize: 20,
  trials: 30,
  stimulusAmplitude: 25,
  stimulusMs: 15,
  gapMs: 0,
  teacherAmplitude: 25,
  teacherMs: 15,
  restMs: 120,
  testMs: 40,
};

/**
 * Минимальная пауза покоя перед каждой пробой, мс.
 *
 * 120 мс — заведомо больше и τ синаптической проводимости (5 мс), и τ следов
 * STDP (20 мс): за это время возбуждение предыдущей пробы успевает сойти, и
 * следующая проба начинается из сопоставимого состояния.
 */
const SETTLE_MS = 120;

/** Результат опыта — то, что показывается пользователю. */
export interface LearningExperimentResult {
  /** Отклик читающего слоя на обученный паттерн ДО обучения. */
  beforeA: number;
  /** Отклик на необученный паттерн ДО обучения. */
  beforeB: number;
  /** Отклик на обученный паттерн ПОСЛЕ обучения. */
  afterA: number;
  /** Отклик на необученный паттерн ПОСЛЕ обучения. */
  afterB: number;
  /** Средний вес связей вход → читающий слой до и после. */
  weightBefore: number;
  weightAfter: number;
  /** Сколько обновлений весов сделал STDP. */
  stdpUpdates: number;
  /** Насколько отклик на A вырос: `afterA − beforeA`. */
  gain: number;
  /**
   * Разделение паттернов — РАЗНИЦА разницы: `(afterA − afterB) − (beforeA − beforeB)`.
   *
   * ─── Почему не просто «afterA − afterB» ─────────────────────────────────
   *
   * Первая версия считала разделение как `afterA − afterB`, и оно было
   * СМЕЩЕНО. Измерено на пресете «Обучение с учителем»: `beforeA = 0`, а
   * `beforeB = 8` — при том что сеть ещё ничему не обучена и обязана
   * отвечать на A и B одинаково.
   *
   * Причина в порядке измерений: проба A выполняется ПЕРВОЙ и оставляет
   * после себя возбуждённое состояние (проводимость, следы, рефрактерность),
   * поэтому проба B идёт уже по «разогретой» сети. Это артефакт ИЗМЕРЕНИЯ,
   * а не свойство сети.
   *
   * Разница разниц его сокращает: `(70−8) − (0−8) = 70` для обученной сети
   * и ровно `0` для контроля — против `62` и `−8` у прежней формулы. То есть
   * контроль перестаёт показывать «эффект» там, где его нет.
   */
  separation: number;
}

/**
 * Границы популяций: кто вход, кто читающий слой.
 *
 * Договорённость проекта: входная группа идёт ПЕРВОЙ, читающая — последней.
 * Так же устроена слоистая топология (`layers`), поэтому опыт не требует
 * своей структуры связей и работает на обычном пресете.
 */
export interface ExperimentLayout {
  /** Начало и конец входной группы (полуинтервал). */
  inputStart: number;
  inputEnd: number;
  /** Начало и конец читающей группы. */
  readoutStart: number;
  readoutEnd: number;
}

/**
 * Разложить сеть на входную и читающую группы.
 *
 * Опыт рассчитан на СЛОИСТУЮ сцену: входная группа идёт первой, читающая —
 * последней. Это та же договорённость, что у топологии `layers`, поэтому
 * опыт работает на обычном пресете и не требует своей структуры связей.
 *
 * На сцене с другой топологией деление всё равно произойдёт, но «читающая
 * группа» не будет связана со входом направленно, и опыт честно покажет
 * отсутствие различения — а не выдумает результат.
 */
export function experimentLayout(network: Network): ExperimentLayout {
  const count = network.params.count;
  // Читающая группа — вторая половина слоистой сцены. Размер берётся из
  // фактического числа нейронов, чтобы опыт работал и на пересобранной сети.
  const readoutCount = Math.max(1, Math.floor(count / 2));
  const readoutStart = count - readoutCount;
  return {
    inputStart: 0,
    inputEnd: readoutStart,
    readoutStart,
    readoutEnd: count,
  };
}

/** Индексы паттерна A и B внутри входной группы. */
export function experimentPatterns(
  layout: ExperimentLayout,
  patternSize: number,
): { a: number[]; b: number[] } {
  const available = layout.inputEnd - layout.inputStart;
  // Паттерн не может занимать больше половины входов: иначе A и B
  // пересекались бы, и «различать» было бы нечего по построению.
  const size = Math.max(1, Math.min(patternSize, Math.floor(available / 2)));
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < size; i++) {
    a.push(layout.inputStart + i);
    b.push(layout.inputStart + size + i);
  }
  return { a, b };
}

/**
 * Прогнать опыт на сети и вернуть измеренный результат.
 *
 * Сеть ИЗМЕНЯЕТСЯ: опыт её обучает. Для контроля `learn: false` прогоняет
 * ровно тот же протокол, но с выключенным STDP — тогда веса не меняются, и
 * любой прирост отклика обязан объясняться чем-то другим.
 *
 * ─── Почему проверка идёт и ДО, и после ──────────────────────────────────
 *
 * Если мерить только «после», нельзя отличить обучение от простого
 * разогрева: повторяющийся стимул сам по себе меняет возбудимость. Пара
 * «до/после» плюс контроль с выключенным STDP — минимальная схема, при
 * которой вывод «научилась» вообще проверяем.
 */
export function runLearningExperiment(
  network: Network,
  config: LearningExperimentConfig = DEFAULT_EXPERIMENT,
  options: { learn?: boolean; layout?: ExperimentLayout } = {},
): LearningExperimentResult {
  const learn = options.learn ?? true;
  const layout = options.layout ?? experimentLayout(network);
  const patterns = experimentPatterns(layout, config.patternSize);
  const wasEnabled = network.stdpParams.enabled;
  network.setStdp(learn);

  const weightBefore = meanInputWeight(network, layout);

  // Проверка ДО обучения.
  const before = measurePair(network, config, layout, patterns);

  // Обучение.
  for (let trial = 0; trial < config.trials; trial++) {
    // 1. Стимул паттерна A.
    pulse(network, patterns.a, config.stimulusAmplitude, config.stimulusMs);
    runMs(network, config.stimulusMs + config.gapMs);
    // 2. «Учитель»: заставляем читающий слой сработать.
    const readout = range(layout.readoutStart, layout.readoutEnd);
    pulse(network, readout, config.teacherAmplitude, config.teacherMs);
    runMs(network, config.teacherMs + config.restMs);
  }

  const weightAfter = meanInputWeight(network, layout);
  const after = measurePair(network, config, layout, patterns);

  // STDP возвращается в то состояние, в котором пришёл: опыт не должен
  // молча менять настройку, которую выбрал пользователь.
  network.setStdp(wasEnabled);

  return {
    beforeA: before.a,
    beforeB: before.b,
    afterA: after.a,
    afterB: after.b,
    weightBefore,
    weightAfter,
    stdpUpdates: network.stdpUpdates,
    gain: after.a - before.a,
    separation: after.a - after.b - (before.a - before.b),
  };
}

/**
 * Отклик на оба паттерна БЕЗ учителя.
 *
 * ─── Порядок проб и почему он важен ──────────────────────────────────────
 *
 * Проба оставляет после себя возбуждённое состояние: синаптическую
 * проводимость, следы STDP, рефрактерность. Значит проба, выполненная
 * ПЕРВОЙ, меряется на более «холодной» сети, чем вторая.
 *
 * Найдено измерением: `beforeA = 0` при `beforeB = 8` на СВЕЖЕЙ сети, где
 * никакого различения быть не может — то есть «эффект» целиком принадлежал
 * порядку проб, а не обучению.
 *
 * Лечится не формулой, а паузой: перед КАЖДОЙ пробой сеть получает
 * `restMs` покоя, за которое проводимость (τ_syn = 5 мс) затухает, а следы
 * STDP (τ = 20 мс) успевают спасть. Тогда обе точки измеряются из одного и
 * того же состояния, и порядок перестаёт влиять.
 *
 * Именно поэтому пауза стоит и в обучении, и в проверке: без неё различие
 * между A и B было бы частично артефактом того, какая проба шла первой.
 */
function measurePair(
  network: Network,
  config: LearningExperimentConfig,
  layout: ExperimentLayout,
  patterns: { a: number[]; b: number[] },
): { a: number; b: number } {
  settle(network, config);
  const a = measureResponse(network, config, layout, patterns.a);
  settle(network, config);
  const b = measureResponse(network, config, layout, patterns.b);
  return { a, b };
}

/** Пауза покоя перед пробой: снимает влияние предыдущей пробы. */
function settle(network: Network, config: LearningExperimentConfig): void {
  runMs(network, Math.max(config.restMs, SETTLE_MS));
}

/**
 * Отклик читающего слоя на паттерн БЕЗ учителя.
 *
 * Считаются именно СПАЙКИ читающей группы за окно проверки: у группы
 * отклик меняется плавно, тогда как одиночный нейрон даёт ступеньку
 * «сработал/не сработал», по которой обучение не измерить.
 */
function measureResponse(
  network: Network,
  config: LearningExperimentConfig,
  layout: ExperimentLayout,
  pattern: number[],
): number {
  const before = readoutSpikes(network, layout);
  pulse(network, pattern, config.stimulusAmplitude, config.stimulusMs);
  runMs(network, config.testMs);
  return readoutSpikes(network, layout) - before;
}

/** Сумма спайков читающего слоя с начала прогона. */
function readoutSpikes(network: Network, layout: ExperimentLayout): number {
  let total = 0;
  for (let i = layout.readoutStart; i < layout.readoutEnd; i++) {
    total += network.state.spikeCount[i];
  }
  return total;
}

/** Средний вес связей, ведущих во входную группу... точнее, ИЗ входной. */
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
function pulse(network: Network, indices: readonly number[], amplitude: number, durationMs: number): void {
  for (const index of indices) network.inject(index, amplitude, durationMs);
}

/** Продвинуть сеть на указанное число миллисекунд модельного времени. */
function runMs(network: Network, ms: number): void {
  const dt = network.params.dt;
  const steps = Math.max(1, Math.round(ms / dt));
  network.run(steps);
}

/** Массив подряд идущих индексов [start, end). */
function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/**
 * Итог опыта словами — для интерфейса и проверок.
 *
 * Возвращается ФАКТ, а не похвала: если сеть не научилась, так и написано.
 * Порог «научилась» — разделение строго больше нуля И отклик на обученный
 * паттерн действительно вырос. Ноль разделения означает, что сеть отвечает
 * одинаково на оба паттерна, то есть различать не научилась.
 */
export function describeExperiment(
  result: LearningExperimentResult,
  control?: LearningExperimentResult,
): { learned: boolean; summary: string } {
  const learned = result.separation > 0 && result.gain > 0;
  const sign = (value: number): string => (value >= 0 ? `+${value}` : String(value));

  if (!learned) {
    return {
      learned: false,
      summary:
        `Сеть НЕ научилась: отклик на A ${sign(result.gain)} спайков, ` +
        `а разница с B ${sign(result.separation)}. ` +
        'Проверьте, включено ли обучение и достаточно ли велики веса.',
    };
  }

  let summary =
    `Сеть научилась различать паттерны: отклик на A вырос на ${result.gain} спайков, ` +
    `а на необученный B — на ${result.afterB - result.beforeB}. ` +
    `Разделение A − B = ${sign(result.separation)} спайков.`;

  if (control) {
    // Контроль показывается рядом намеренно: без него «вырос» не доказывает
    // обучение — сеть могла разогреться просто от повторения стимула.
    summary +=
      ` Контроль (тот же протокол с выключенным обучением): ` +
      `разделение ${sign(control.separation)}, рост отклика ${sign(control.gain)}.`;
  }

  return { learned, summary };
}

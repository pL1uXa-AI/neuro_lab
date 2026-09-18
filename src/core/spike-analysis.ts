/**
 * Анализ спайковой последовательности.
 *
 * Нужен тестам на сигнатуры режимов и метрикам интерфейса. Всё, что здесь
 * есть, — это функции над МАССИВОМ времён спайков, а не над состоянием сети:
 * так их можно проверять на синтетических последовательностях, где ответ
 * известен заранее, и только потом применять к настоящей симуляции.
 *
 * Главное понятие — «группа» (burst). Определение сознательно простое и
 * воспроизводимое: группа начинается со спайка, за которым следует спайк
 * не позже чем через `maxIntraMs`; группа продолжается, пока интервалы
 * внутри неё короче порога. Это стандартное определение «burst detection»
 * (Cocatre-Zilgien & Delcomyn), и оно, в отличие от «порог по частоте»,
 * не зависит от абсолютной частоты разряда.
 */

/** Интервалы между соседними спайками. */
export function interSpikeIntervals(spikeTimes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < spikeTimes.length; i++) out.push(spikeTimes[i] - spikeTimes[i - 1]);
  return out;
}

/** Среднее значение; NaN на пустом массиве — «нет данных» ≠ «ноль». */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Стандартное отклонение по выборке. */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const value of values) sum += (value - m) * (value - m);
  return Math.sqrt(sum / (values.length - 1));
}

/** Коэффициент вариации; NaN, если данных мало. */
export function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  if (!Number.isFinite(m) || m === 0) return Number.NaN;
  return stdDev(values) / m;
}

/** Одна группа спайков. */
export interface Burst {
  /** Индексы спайков, входящих в группу (в исходном массиве). */
  indices: number[];
  /** Время первого спайка, мс. */
  startMs: number;
  /** Время последнего спайка, мс. */
  endMs: number;
  /** Число спайков в группе. */
  size: number;
  /** Средний интервал внутри группы, мс. */
  intraIsiMs: number;
}

/**
 * Разбить последовательность спайков на группы.
 *
 * `maxIntraMs` — максимальный интервал, при котором два спайка считаются
 * частью одной группы. `minSize` — сколько спайков должно быть в группе,
 * чтобы она считалась группой (обычно 2: одиночный спайк — не пачка).
 */
export function findBursts(
  spikeTimes: readonly number[],
  options: { maxIntraMs?: number; minSize?: number } = {},
): Burst[] {
  const maxIntraMs = options.maxIntraMs ?? 10;
  const minSize = options.minSize ?? 2;
  const bursts: Burst[] = [];
  let current: number[] = [];

  const flush = (): void => {
    if (current.length >= minSize) {
      const times = current.map((index) => spikeTimes[index]);
      bursts.push({
        indices: [...current],
        startMs: times[0],
        endMs: times[times.length - 1],
        size: current.length,
        intraIsiMs: mean(interSpikeIntervals(times)),
      });
    }
    current = [];
  };

  for (let i = 0; i < spikeTimes.length; i++) {
    if (current.length === 0) {
      current.push(i);
      continue;
    }
    const gap = spikeTimes[i] - spikeTimes[current[current.length - 1]];
    if (gap <= maxIntraMs) current.push(i);
    else {
      flush();
      current.push(i);
    }
  }
  flush();
  return bursts;
}

/** Сводка по спайковой последовательности — то, с чем сравниваются сигнатуры. */
export interface SpikeSummary {
  /** Общее число спайков. */
  count: number;
  /** Средняя частота, Гц, по указанному окну. */
  rateHz: number;
  /** Интервалы между спайками, мс. */
  isis: number[];
  /** Средний ISI, мс. */
  meanIsiMs: number;
  /** Коэффициент вариации ISI. */
  cv: number;
  /** Найденные группы. */
  bursts: Burst[];
  /** Первое и последнее время спайка, мс. */
  firstSpikeMs: number;
  lastSpikeMs: number;
}

/** Полная сводка по временам спайков. */
export function summarise(
  spikeTimes: readonly number[],
  windowMs: number,
  burstOptions: { maxIntraMs?: number; minSize?: number } = {},
): SpikeSummary {
  const isis = interSpikeIntervals(spikeTimes);
  return {
    count: spikeTimes.length,
    rateHz: windowMs > 0 ? (spikeTimes.length / windowMs) * 1000 : 0,
    isis,
    meanIsiMs: mean(isis),
    cv: coefficientOfVariation(isis),
    bursts: findBursts(spikeTimes, burstOptions),
    firstSpikeMs: spikeTimes.length > 0 ? spikeTimes[0] : Number.NaN,
    lastSpikeMs: spikeTimes.length > 0 ? spikeTimes[spikeTimes.length - 1] : Number.NaN,
  };
}

/**
 * Сравнить «начало» и «хвост» ISI — нужно для адаптации и пачек.
 *
 * Возвращает отношение среднего ISI в хвосте к среднему в начале. Значение
 * больше 1 означает, что спайки редеют (адаптация); около 1 — ровный ряд.
 */
export function isiTrend(isis: readonly number[], firstFraction = 0.3): number {
  if (isis.length < 4) return Number.NaN;
  const cut = Math.max(1, Math.floor(isis.length * firstFraction));
  const head = isis.slice(0, cut);
  const tail = isis.slice(isis.length - cut);
  const headMean = mean(head);
  const tailMean = mean(tail);
  if (!Number.isFinite(headMean) || headMean === 0) return Number.NaN;
  return tailMean / headMean;
}

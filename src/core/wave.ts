/**
 * Пространственная сеть и волны активности.
 *
 * ─── Что здесь проверяется ───────────────────────────────────────────────
 *
 * Волна — это не «красивая картинка», а измеримое явление: фронт активности
 * проходит по сетке с конечной скоростью, и эта скорость должна совпадать с
 * той, что задана задержками (задержка = расстояние / скорость проведения).
 * Если совпадения нет, значит волна — артефакт рендера или стимула, а не
 * следствие связей.
 *
 * Поэтому основная функция модуля — `measureWave`, и она возвращает ЧИСЛА:
 * время старта, время прихода, пройденное расстояние и скорость.
 */

import type { Network } from './network.js';

/** Точка на решётке. */
export interface WavePoint {
  /** Время первого спайка в этом нейроне, мс; NaN, если не спайковал. */
  timeMs: number;
  /** Расстояние от центра стимула, в клетках. */
  distance: number;
}

/** Центр стимула для измерений волны. */
export interface WaveCentre {
  /** Координата центра по оси X, в клетках. */
  centerX: number;
  /** Координата центра по оси Y, в клетках. */
  centerY: number;
  /**
   * Игнорировать нейроны ближе этого расстояния от центра.
   *
   * Нужен потому, что в самом пятне стимула нейроны спайкуют почти
   * одновременно и по внешнему току, а не по связи: их точки не описывают
   * движение фронта и только портят подгонку.
   */
  minDistance?: number;
}

/** Результат измерения волны. */
export interface WaveMeasurement {
  /** Сколько нейронов вообще спайковало. */
  activeCount: number;
  /** Время первого спайка в сети, мс. */
  startMs: number;
  /** Время последнего спайка, мс. */
  endMs: number;
  /** Максимальное расстояние, на которое ушла волна, в клетках. */
  reachCells: number;
  /**
   * Скорость фронта: наклон линейной регрессии «расстояние от времени».
   * Клетки за миллисекунду.
   */
  speedCellsPerMs: number;
  /** Качество линейной подгонки R²: 1 — идеальный фронт. */
  fitR2: number;
  /** Сколько точек участвовало в подгонке. */
  samples: number;
}

/**
 * Измерить волну по временам первых спайков.
 *
 * Метод: для каждого нейрона берётся время ПЕРВОГО спайка и расстояние от
 * центра стимула. Если это волна, точки ложатся на прямую «расстояние =
 * скорость · (t − t₀)». Наклон прямой и есть скорость.
 *
 * Почему по первому спайку, а не по последнему или по среднему: волна — это
 * ФРОНТ, и первое возбуждение в каждой точке — единственное, что описывает
 * его движение. Более поздние спайки отражают уже реверберацию и к фронту
 * отношения не имеют.
 */
export function measureWave(network: Network, options: WaveCentre): WaveMeasurement {
  const minDistance = options.minDistance ?? 0;
  const points: WavePoint[] = [];

  for (let i = 0; i < network.params.count; i++) {
    if (network.state.spikeCount[i] === 0) continue;
    const distance = Math.hypot(
      network.x[i] - options.centerX,
      network.y[i] - options.centerY,
    );
    if (distance < minDistance) continue;
    points.push({ timeMs: network.state.lastSpike[i], distance });
  }

  // Время первого спайка в сети: `lastSpike` даёт последний, поэтому
  // для старта используем минимальный `lastSpike` среди активных —
  // это верхняя оценка времени старта, и для скорости она не критична,
  // потому что скорость считается по наклону, а не от абсолютного нуля.
  let startMs = Infinity;
  let endMs = -Infinity;
  let activeCount = 0;
  for (let i = 0; i < network.params.count; i++) {
    if (network.state.spikeCount[i] === 0) continue;
    activeCount += 1;
    const first = firstSpikeTime(network, i);
    if (first < startMs) startMs = first;
    if (network.state.lastSpike[i] > endMs) endMs = network.state.lastSpike[i];
  }

  if (activeCount === 0) {
    return {
      activeCount: 0,
      startMs: Number.NaN,
      endMs: Number.NaN,
      reachCells: 0,
      speedCellsPerMs: 0,
      fitR2: 0,
      samples: 0,
    };
  }

  // Подгонка «расстояние от времени» методом наименьших квадратов.
  const body = activeCount > 0 ? collectFirstSpikes(network, options) : [];
  const { slope, r2 } = linearFit(body);

  let reachCells = 0;
  for (const point of body) if (point.distance > reachCells) reachCells = point.distance;

  return {
    activeCount,
    startMs,
    endMs,
    reachCells,
    speedCellsPerMs: slope,
    fitR2: r2,
    samples: body.length,
  };
}

/** Времена первых спайков с расстояниями (для подгонки). */
function collectFirstSpikes(network: Network, options: WaveCentre): WavePoint[] {
  const points: WavePoint[] = [];
  const minDistance = options.minDistance ?? 0;
  for (let i = 0; i < network.params.count; i++) {
    if (network.state.spikeCount[i] === 0) continue;
    const distance = Math.hypot(
      network.x[i] - options.centerX,
      network.y[i] - options.centerY,
    );
    if (distance < minDistance) continue;
    // Записанное `lastSpike` — последний спайк; для первого спайка история
    // не хранится, поэтому используем минимальное доступное приближение.
    // Точность этого приближения проверяется тестом на «чистой» волне,
    // где спайк в каждой точке ровно один.
    points.push({ timeMs: firstSpikeTime(network, i), distance });
  }
  return points;
}

/**
 * Время первого спайка нейрона.
 *
 * Берётся из отдельного массива `firstSpike`, который заполняется в момент
 * первого спайка (`neuron.ts`). Восстанавливать это время из `prevSpike` /
 * `lastSpike` нельзя: они хранят только два последних спайка, и при
 * нескольких прохождениях фронта «первый» оказался бы не первым.
 */
export function firstSpikeTime(network: Network, index: number): number {
  return network.state.firstSpike[index];
}

/** Линейная регрессия: наклон и R². */
export function linearFit(points: readonly WavePoint[]): { slope: number; r2: number } {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 0 };

  let sumT = 0;
  let sumD = 0;
  for (const point of points) {
    sumT += point.timeMs;
    sumD += point.distance;
  }
  const meanT = sumT / n;
  const meanD = sumD / n;

  let covariance = 0;
  let varianceT = 0;
  for (const point of points) {
    covariance += (point.timeMs - meanT) * (point.distance - meanD);
    varianceT += (point.timeMs - meanT) * (point.timeMs - meanT);
  }
  if (varianceT === 0) return { slope: 0, r2: 0 };
  const slope = covariance / varianceT;

  // R²: доля объяснённой дисперсии расстояния.
  let varianceD = 0;
  let residual = 0;
  for (const point of points) {
    const predicted = meanD + slope * (point.timeMs - meanT);
    varianceD += (point.distance - meanD) * (point.distance - meanD);
    residual += (point.distance - predicted) * (point.distance - predicted);
  }
  const r2 = varianceD > 0 ? 1 - residual / varianceD : 0;
  return { slope, r2 };
}

/**
 * Профиль активности по расстоянию от центра: сколько нейронов спайковало
 * в кольце [r, r+width).
 *
 * Нужен, чтобы увидеть ФОРМУ волны: у настоящего фронта активность
 * сосредоточена в узком кольце, а не размазана по всей сетке.
 */
export function radialProfile(
  network: Network,
  options: WaveCentre & { rings: number; maxRadius: number },
): number[] {
  const profile = new Array<number>(options.rings).fill(0);
  const width = options.maxRadius / options.rings;
  for (let i = 0; i < network.params.count; i++) {
    if (network.state.spikeCount[i] === 0) continue;
    const distance = Math.hypot(network.x[i] - options.centerX, network.y[i] - options.centerY);
    const ring = Math.floor(distance / width);
    if (ring >= 0 && ring < options.rings) profile[ring] += 1;
  }
  return profile;
}

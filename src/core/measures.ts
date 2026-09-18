/**
 * Метрики: то, по чему мы судим о явлениях.
 *
 * Зачем это отдельный модуль. «Сеть синхронизировалась» и «пошли волны» —
 * утверждения, которые нельзя проверить глазом: картинка выглядит живой и у
 * полностью асинхронной, и у полностью синхронной сети, а отличить одну от
 * другой нужно для автопроверки уровней. Поэтому каждое явление описывается
 * ЧИСЛОМ, и все пороги уровней сравниваются именно с числами отсюда.
 *
 * Общее правило: метрика — это функция от состояния и истории, а не от
 * кадров рендера. Метрики считаются в чистом Node и покрыты тестами на
 * крайних случаях (полностью синхронная сеть → 1, независимые пуассоновские
 * процессы → около 0).
 */

import type { NeuronState } from './types.js';

/** Частота спайков одного нейрона, Гц. */
export function firingRate(spikeCount: number, windowMs: number): number {
  if (windowMs <= 0) return 0;
  return (spikeCount / windowMs) * 1000;
}

/** Средняя частота по популяции, Гц. */
export function populationRate(state: NeuronState, windowMs: number): number {
  if (windowMs <= 0) return 0;
  let total = 0;
  for (let i = 0; i < state.count; i++) total += state.spikeCount[i];
  return (total / state.count / windowMs) * 1000;
}

/**
 * Частота по «активным» нейронам — тем, кто спайковал хотя бы раз.
 *
 * Нужна потому, что в разреженной сети при слабом входе большинство нейронов
 * молчит, и средняя по популяции частота ≈ 0 ничего не говорит о том, что
 * происходит с горсткой активных. Это тот же размен, что «подвижные частицы»
 * против средней температуры в phys-lab.
 */
export function activeRate(state: NeuronState, windowMs: number): number {
  if (windowMs <= 0) return 0;
  let total = 0;
  let active = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.spikeCount[i] > 0) {
      active += 1;
      total += state.spikeCount[i];
    }
  }
  if (active === 0) return 0;
  return (total / active / windowMs) * 1000;
}

/** Доля нейронов, спайковавших хотя бы раз за окно. */
export function activeFraction(state: NeuronState): number {
  if (state.count === 0) return 0;
  let active = 0;
  for (let i = 0; i < state.count; i++) if (state.spikeCount[i] > 0) active += 1;
  return active / state.count;
}

/**
 * Коэффициент вариации интервалов между спайками (CV ISI).
 *
 *     CV = σ(ISI) / mean(ISI)
 *
 * Это главный индикатор режима: регулярный «метрономный» нейрон даёт CV ≈ 0,
 * а нейрон, управляемый пуассоновским входом, — CV ≈ 1. Именно по CV
 * проверяется, что сеть работает в «балансном» режиме коры, а не превратилась
 * в генератор синхронных разрядов.
 *
 * Считается по экспоненциальным средним, накопленным в момент спайка:
 * хранить всю историю ISI для десятков тысяч нейронов нечем.
 */
export function cvIsi(state: NeuronState, minSpikes = 4): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < state.count; i++) {
    if (state.spikeCount[i] < minSpikes) continue;
    const mean = state.meanIsi[i];
    const mean2 = state.meanIsi2[i];
    if (!Number.isFinite(mean) || !Number.isFinite(mean2) || mean <= 0) continue;
    const variance = Math.max(0, mean2 - mean * mean);
    sum += Math.sqrt(variance) / mean;
    count += 1;
  }
  if (count === 0) return Number.NaN;
  return sum / count;
}

/**
 * Синхронность популяции по «бинам» времени.
 *
 * Задача: отличить сеть, где нейроны разряжаются вместе, от сети, где каждый
 * живёт сам по себе. Обе выглядят «живыми» на экране, поэтому нужна мера.
 *
 * Определение. Пусть спайки окна разложены по бинам шириной `binMs`, `n_k` —
 * число спайков в бине `k`, `N` — всего спайков, `K` — число бинов в окне.
 *
 *     Σn_k² при равномерном распределении = N²/K   (минимум)
 *     Σn_k² при полной синхронности      = N²     (максимум)
 *
 *     S = (Σn_k² − N²/K) / (N² − N²/K)
 *
 * Тогда S = 1, когда все спайки попали в один бин, и S = 0, когда они
 * размазаны ровно поровну. Оба края проверяются тестом явно: «примерно
 * синхронно» — не проверяемое утверждение, а крайние случаи проверяемы.
 *
 * Что мера НЕ различает (и это честно записано): идеально чередующиеся две
 * группы («половина в чётных бинах, половина в нечётных») дают S = 0 при
 * K = 2. Мера отвечает на вопрос «в одни ли моменты времени летят спайки», а
 * не «сколько групп». Для уровней проекта этого достаточно; если понадобится
 * различать группы, это будет отдельная метрика, а не подкрутка этой.
 *
 * Буфер накапливается до `reset()`: вызывающая сторона сама решает, какое
 * окно считать — метрика не знает про окна усреднения.
 */
export class SynchronyMeter {
  private readonly bins: Float64Array;
  private readonly binMs: number;
  /** Сколько миллисекунд покрыто бинами (растёт с каждым `add`). */
  private filledMs = 0;
  private totalSpikes = 0;

  constructor(binMs = 5, capacity = 200000) {
    this.binMs = binMs;
    this.bins = new Float64Array(capacity);
  }

  /** Добавить спайки одного шага: `count` спайков в момент времени `time`. */
  add(time: number, count: number, dt: number): void {
    this.filledMs += dt;
    if (count <= 0) return;
    const bin = Math.floor(time / this.binMs);
    if (bin < 0 || bin >= this.bins.length) return;
    this.bins[bin] += count;
    this.totalSpikes += count;
  }

  /**
   * Текущее значение синхронности, 0…1, или NaN, если спайков не было.
   *
   * NaN, а не 0: «спайков нет» и «спайки несинхронны» — разные состояния, и
   * интерфейс обязан их различать (инвариант 12: «нет данных» ≠ «ноль»).
   */
  value(): number {
    const spikes = this.totalSpikes;
    if (spikes <= 0) return Number.NaN;
    // Число бинов в окне: не больше, чем реально влезло по времени.
    const binsUsed = Math.max(1, Math.ceil(this.filledMs / this.binMs));

    let sumSquares = 0;
    for (let i = 0; i < this.bins.length; i++) {
      const value = this.bins[i];
      if (value > 0) sumSquares += value * value;
    }

    const minimum = (spikes * spikes) / binsUsed;
    const denominator = spikes * spikes - minimum;
    if (denominator <= 0) {
      // Все спайки в одном бине (K = 1) либо спайков слишком мало для
      // оценки: и то и другое — максимальная синхронность из возможных.
      return 1;
    }
    const value = (sumSquares - minimum) / denominator;
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  /** Сколько бинов содержат хотя бы один спайк (диагностика и проверки). */
  nonEmptyBins(): number {
    let count = 0;
    for (let i = 0; i < this.bins.length; i++) if (this.bins[i] > 0) count += 1;
    return count;
  }

  get spikeCount(): number {
    return this.totalSpikes;
  }

  /** Сколько времени покрыто бинами, мс. */
  get coveredMs(): number {
    return this.filledMs;
  }

  reset(): void {
    this.bins.fill(0);
    this.filledMs = 0;
    this.totalSpikes = 0;
  }
}

/**
 * Спектр популяционной активности (оценка спектральной плотности).
 *
 * Нужен ровно для одного вопроса: есть ли ритм. Гамма-осцилляции в коре —
 * это пик в области 30–80 Гц на спектре суммарной активности, и «на глаз»
 * его не отличить от просто шумной сетки.
 *
 * Реализация — наивная DFT по ограниченному числу частот (не FFT): нам нужны
 * десятки частот, а не тысячи, и простота здесь важнее скорости. Частоты
 * задаются сеткой до `maxHz`, шаг — `resolutionHz`.
 */
export interface SpectrumResult {
  /** Частоты, Гц. */
  frequencies: Float64Array;
  /** Мощность на каждой частоте, нормированная на максимум. */
  power: Float64Array;
  /** Частота максимального пика в полосе поиска, Гц. */
  peakHz: number;
  /** Мощность пика (доля от полной), 0…1. */
  peakPower: number;
}

export function populationSpectrum(
  rate: readonly number[],
  dtMs: number,
  options: { maxHz?: number; minHz?: number; stepHz?: number } = {},
): SpectrumResult {
  const maxHz = options.maxHz ?? 120;
  const minHz = options.minHz ?? 1;
  const stepHz = options.stepHz ?? 0.5;
  const n = rate.length;

  const frequencies: number[] = [];
  for (let f = minHz; f <= maxHz + 1e-9; f += stepHz) frequencies.push(f);
  const power = new Float64Array(frequencies.length);

  if (n < 8) {
    return {
      frequencies: Float64Array.from(frequencies),
      power,
      peakHz: 0,
      peakPower: 0,
    };
  }

  // Убираем постоянную составляющую: без этого нулевая частота «съедает»
  // всю нормировку, и пики становятся неразличимы.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += rate[i];
  mean /= n;

  const dtSec = dtMs / 1000;
  for (let k = 0; k < frequencies.length; k++) {
    const omega = 2 * Math.PI * frequencies[k] * dtSec;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const angle = omega * i;
      const value = rate[i] - mean;
      re += value * Math.cos(angle);
      im += value * Math.sin(angle);
    }
    power[k] = (re * re + im * im) / n;
  }

  let maxPower = 0;
  let sumPower = 0;
  for (let k = 0; k < power.length; k++) {
    sumPower += power[k];
    if (power[k] > maxPower) maxPower = power[k];
  }

  let peakIndex = 0;
  for (let k = 1; k < power.length; k++) if (power[k] > power[peakIndex]) peakIndex = k;

  return {
    frequencies: Float64Array.from(frequencies),
    power,
    peakHz: frequencies[peakIndex] ?? 0,
    // Доля пика во всей мощности, нормированная на «идеальный» случай:
    // у чистого синуса вся мощность собирается в одну частоту.
    peakPower: maxPower > 0 && sumPower > 0 ? maxPower / sumPower : 0,
  };
}

/**
 * Скользящий буфер популяционной активности для спектра.
 *
 * Хранит историю суммарной частоты популяции с шагом, кратным нескольким
 * шагам симуляции: спектру не нужны отсчёты на каждом шаге (0.5 мс), ему
 * достаточно 2 мс — иначе массив получается в тысячи элементов, а
 * наивная DFT становится заметной в кадре.
 */
export class RateHistory {
  readonly capacity: number;
  readonly sampleEveryMs: number;
  readonly values: Float64Array;
  private cursor = 0;
  private size = 0;
  /** Время последнего записанного отсчёта. */
  private lastTime = Number.NEGATIVE_INFINITY;

  constructor(capacity = 2048, sampleEveryMs = 2) {
    this.capacity = capacity;
    this.sampleEveryMs = sampleEveryMs;
    this.values = new Float64Array(capacity);
  }

  /** Добавить отсчёт, если с прошлого прошло достаточно времени. */
  maybeAdd(time: number, value: number): void {
    if (time - this.lastTime < this.sampleEveryMs - 1e-9) return;
    this.lastTime = time;
    this.values[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Отсчёты в хронологическом порядке. */
  ordered(): number[] {
    const out: number[] = [];
    const start = this.size < this.capacity ? 0 : this.cursor;
    for (let i = 0; i < this.size; i++) out.push(this.values[(start + i) % this.capacity]);
    return out;
  }

  get length(): number {
    return this.size;
  }

  /** Сколько времени покрывает буфер, мс. */
  get spanMs(): number {
    return this.size * this.sampleEveryMs;
  }

  reset(): void {
    this.values.fill(0);
    this.cursor = 0;
    this.size = 0;
    this.lastTime = Number.NEGATIVE_INFINITY;
  }
}

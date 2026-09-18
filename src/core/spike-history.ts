/**
 * История спайков: кольцевой буфер пар «время — нейрон».
 *
 * ─── Зачем это в ядре ────────────────────────────────────────────────────
 *
 * Состояние нейрона хранит только первый, предпоследний и последний спайк.
 * Этого достаточно для метрик (CV ISI копится в момент спайка), но НЕ
 * достаточно для двух важных задач:
 *
 *   • растровая диаграмма — ей нужны все спайки окна;
 *   • проверки уровней про пачки и адаптацию — им нужна последовательность
 *     времён спайков одного нейрона, а не только её крайние члены.
 *
 * Обе задачи обслуживает один буфер, а не два разных: расхождение между
 * «историей для картинки» и «историей для проверки» означало бы, что
 * уровень может проходиться, а картинка этого не показывать.
 *
 * Ёмкость конечна и задаётся осознанно: при 10 000 нейронов и 20 Гц полный
 * поток — это 200 000 спайков в секунду, и хранить всю историю нельзя.
 * Буфер рассчитан примерно на 10 секунд модельного времени при 1000 Гц
 * суммарной активности.
 */

/** Одна запись: когда и кто. */
export interface SpikeRecord {
  timeMs: number;
  index: number;
}

/** Кольцевой буфер истории спайков. */
export class SpikeHistory {
  readonly capacity: number;
  readonly times: Float64Array;
  readonly indices: Int32Array;
  /** Позиция следующей записи. */
  private cursor = 0;
  /** Сколько записей сделано (растёт до capacity). */
  private count = 0;
  /** Сколько спайков было всего с начала прогона — для статистики. */
  total = 0;

  constructor(capacity = 200000) {
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.indices = new Int32Array(capacity);
  }

  /** Записать спайки одного шага. */
  add(time: number, index: number): void {
    this.times[this.cursor] = time;
    this.indices[this.cursor] = index;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    this.total += 1;
  }

  /** Записать все спайки шага из буфера ядра. */
  addBatch(spikes: {
    count: number;
    index: Int32Array;
    time: Float64Array;
  }): void {
    for (let k = 0; k < spikes.count; k++) {
      this.add(spikes.time[k], spikes.index[k]);
    }
  }

  /** Сколько записей хранится. */
  get size(): number {
    return this.count;
  }

  /** Время самого раннего хранимого спайка, мс (NaN, если пусто). */
  get oldestMs(): number {
    if (this.count === 0) return Number.NaN;
    return this.times[this.startIndex()];
  }

  /** Время самого позднего хранимого спайка, мс (NaN, если пусто). */
  get newestMs(): number {
    if (this.count === 0) return Number.NaN;
    const last = (this.startIndex() + this.count - 1) % this.capacity;
    return this.times[last];
  }

  /** Индекс самой старой записи в кольце. */
  private startIndex(): number {
    return this.count < this.capacity ? 0 : this.cursor;
  }

  /**
   * Времена спайков указанного нейрона, отсортированные по возрастанию.
   *
   * Обход идёт по кольцу от самой старой записи: без этого порядок был бы
   * «завёрнут», и интервалы получились бы отрицательными.
   */
  timesOf(index: number): number[] {
    const out: number[] = [];
    const start = this.startIndex();
    for (let i = 0; i < this.count; i++) {
      const at = (start + i) % this.capacity;
      if (this.indices[at] === index) out.push(this.times[at]);
    }
    return out;
  }

  /**
   * Обойти все записи в хронологическом порядке.
   *
   * Возвращает записи, попавшие в окно [fromMs, toMs]: рендеру нужно именно
   * окно, а не весь буфер.
   */
  window(fromMs: number, toMs: number): SpikeRecord[] {
    const out: SpikeRecord[] = [];
    const start = this.startIndex();
    for (let i = 0; i < this.count; i++) {
      const at = (start + i) % this.capacity;
      const time = this.times[at];
      if (time < fromMs || time > toMs) continue;
      out.push({ timeMs: time, index: this.indices[at] });
    }
    return out;
  }

  /** Очистить. */
  reset(): void {
    this.cursor = 0;
    this.count = 0;
    this.total = 0;
  }
}

/**
 * След импульсов: какие синапсы и когда передали спайк.
 *
 * ─── Зачем это отдельный модуль ──────────────────────────────────────────
 *
 * Ядро уже знает всё о передаче: буфер задержек (`DelayBuffer`) кладёт спайк
 * в слот `шаг + delaySteps` и доставляет его ровно через задержку. Но наружу
 * это знание не выходит: после шага видно только «сколько спайков пришло», а
 * не «через какие связи». Поэтому проход импульса по синапсам невозможно
 * было нарисовать — и его не рисовали.
 *
 * Здесь доставка ЗАПИСЫВАЕТСЯ как событие: кто → кому, когда вышел, когда
 * придёт, с каким весом. Ядро от этого не зависит: если запись выключена или
 * буфер переполнен, симуляция считается ровно так же.
 *
 * ─── Это ПРОРЕЖЕННАЯ запись, и это осознанно ─────────────────────────────
 *
 * Записать все передачи нельзя и не нужно. При 2500 нейронах и 255 000 связей
 * волна за один шаг порождает десятки тысяч событий; нарисовать их все — это
 * сплошное пятно, в котором не видно ни структуры, ни фронта.
 *
 * Поэтому с каждого спайка записывается не более `maxPerSpike` связей,
 * выбранных равномерно по списку исходящих (`stride` в `recordFrom`). Числа
 * подобраны так, чтобы буфер покрывал окно визуализации: измерено на волне
 * 2500 нейронов — около 400 событий на шаг, при ёмкости 16 384 это ≈ 40 шагов
 * (20 мс модельного времени), то есть ровно время жизни вспышки синапса.
 *
 * Счётчик `dropped` показывает, сколько записей вытеснено. Он существует не
 * «для красоты»: если он растёт, значит окно визуализации КОРОЧЕ заявленного,
 * и об этом нужно знать, а не догадываться.
 *
 * ─── Почему модель хранит и выход, и приход ──────────────────────────────
 *
 * Время прохождения (0.5–2 мс на волне) в разы меньше одного кадра отрисовки
 * (≈20 мс модельного времени при 40 шагах на кадр). Честный вывод из этого:
 * **летящий импульс при обычной скорости счёта увидеть нельзя** — он выходит и
 * приходит внутри одного кадра. Поэтому записывается и момент прихода, и
 * рендер рисует затухающий след СИНАПСА, а не «мультик про полёт».
 *
 * Это не упрощение ради картинки: положение в полёте всё равно вычисляется
 * (`t` в `forEachActive`), и для длинных задержек (кольцо, слоистая сеть) оно
 * видно как движение. Для коротких — остаётся вспышка связи, что честно
 * описывает происходящее: импульс ПРОШЁЛ по этой связи в этот момент.
 */

/**
 * Одно событие передачи: спайк прошёл по синапсу.
 *
 * Времена — в миллисекундах МОДЕЛЬНОГО времени (не настенных), поэтому след
 * не зависит от скорости счёта: при паузе импульсы замирают вместе с сетью.
 */
export interface PulseEvent {
  /** Нейрон-источник. */
  from: number;
  /** Нейрон-цель. */
  to: number;
  /** Момент выхода спайка из сомы, мс. */
  departMs: number;
  /** Момент прихода в цель, мс. Это время доставки буфера задержек. */
  arriveMs: number;
  /** Вес связи: > 0 возбуждение, < 0 торможение. */
  weight: number;
}

/** Ёмкость по умолчанию: покрывает окно визуализации на волне (см. шапку). */
export const DEFAULT_PULSE_CAPACITY = 16384;

/** Сколько связей максимум записывается с одного спайка. */
export const DEFAULT_MAX_PER_SPIKE = 4;

/**
 * Кольцевой буфер прошедших импульсов.
 *
 * Структуры-объекты не создаются: события лежат в типизированных массивах, а
 * обход идёт через `forEachActive`. Иначе на каждой волне сборщик мусора
 * получал бы десятки тысяч короткоживущих объектов в секунду, и паузы GC
 * были бы видны как рывки анимации.
 */
export class PulseTrace {
  readonly capacity: number;
  maxPerSpike: number;

  private readonly from: Int32Array;
  private readonly to: Int32Array;
  private readonly depart: Float64Array;
  private readonly arrive: Float64Array;
  private readonly weight: Float64Array;

  /** Сколько записей лежит в буфере (не больше ёмкости). */
  private stored = 0;
  /** Куда писать следующую запись. */
  private cursor = 0;

  /** Сколько событий записано всего — метрика для проверок. */
  recorded = 0;
  /** Сколько записей вытеснено переполнением. */
  dropped = 0;

  constructor(capacity: number = DEFAULT_PULSE_CAPACITY, maxPerSpike: number = DEFAULT_MAX_PER_SPIKE) {
    this.capacity = Math.max(1, capacity);
    this.maxPerSpike = Math.max(1, maxPerSpike);
    this.from = new Int32Array(this.capacity);
    this.to = new Int32Array(this.capacity);
    this.depart = new Float64Array(this.capacity);
    this.arrive = new Float64Array(this.capacity);
    this.weight = new Float64Array(this.capacity);
  }

  /** Полная очистка (смена сцены). */
  reset(): void {
    this.stored = 0;
    this.cursor = 0;
    this.recorded = 0;
    this.dropped = 0;
  }

  /** Сколько событий лежит в буфере. */
  get size(): number {
    return this.stored;
  }

  /** Записать одно событие передачи. */
  record(from: number, to: number, departMs: number, arriveMs: number, weight: number): void {
    const slot = this.cursor;
    this.from[slot] = from;
    this.to[slot] = to;
    this.depart[slot] = departMs;
    this.arrive[slot] = arriveMs;
    this.weight[slot] = weight;

    this.cursor = (slot + 1) % this.capacity;
    if (this.stored < this.capacity) this.stored += 1;
    else this.dropped += 1;
    this.recorded += 1;
  }

  /**
   * Записать все исходящие связи спайка, прореженные до `maxPerSpike`.
   *
   * Возвращает число записанных событий. Прореживание — равномерное по списку
   * (`Math.ceil(degree / maxPerSpike)`), а не «первые N»: первые N смещены к
   * началу списка, а порядок в CSR отражает порядок генерации топологии, то
   * есть выборка была бы неоднородной по сети.
   */
  recordFrom(
    from: number,
    rowPtr: Int32Array,
    colIdx: Int32Array,
    weight: Float64Array,
    delaySteps: Int32Array,
    dt: number,
    spikeTimeMs: number,
    stepStartMs: number,
  ): number {
    const begin = rowPtr[from];
    const end = rowPtr[from + 1];
    const degree = end - begin;
    if (degree <= 0) return 0;

    const stride = Math.max(1, Math.ceil(degree / this.maxPerSpike));
    let written = 0;
    for (let s = begin; s < end; s += stride) {
      // Приход считается по ФАКТИЧЕСКОМУ слоту буфера задержек: доставка
      // происходит в начале шага `шаг + delaySteps`, то есть во время
      // `stepStart + delaySteps · dt`. Не «spikeTime + delay»: спайк
      // интерполирован внутри шага, и прибавлять задержку к нему значило бы
      // обещать точность, которой у буфера нет.
      const arriveMs = stepStartMs + delaySteps[s] * dt;
      this.record(from, colIdx[s], spikeTimeMs, arriveMs, weight[s]);
      written += 1;
    }
    return written;
  }

  /**
   * Сколько событий актуально на момент `nowMs`.
   *
   * Актуальным считается событие, которое либо ещё в пути (`arriveMs > nowMs`),
   * либо пришло не раньше `nowMs − holdMs`. Второе и есть «вспышка синапса»:
   * визуальная память о том, что импульс здесь только что прошёл.
   */
  countActive(nowMs: number, holdMs: number): number {
    const threshold = nowMs - holdMs;
    let active = 0;
    for (let i = 0; i < this.stored; i++) {
      if (this.arrive[i] > threshold) active += 1;
    }
    return active;
  }

  /**
   * Обойти актуальные события.
   *
   * `t` — доля пройденного пути от 0 (только что вышел) до 1 (пришёл). Для
   * уже пришедших событий `t` равен 1, и рисовать их нужно у цели.
   *
   * `stride` позволяет рисовать подвыборку, когда событий больше, чем
   * разумно отрисовать: иначе тысячи отрезков за кадр превращаются в пятно.
   */
  forEachActive(
    nowMs: number,
    holdMs: number,
    visit: (from: number, to: number, t: number, weight: number, ageMs: number) => void,
    stride = 1,
  ): number {
    const threshold = nowMs - holdMs;
    const step = Math.max(1, stride);
    let visited = 0;
    // Обход от САМЫХ СВЕЖИХ записей к старым: при прореживании рисования
    // важнее недавние события, а не произвольный срез буфера.
    for (let n = 0; n < this.stored; n++) {
      const i = (this.cursor - 1 - n + this.capacity * 2) % this.capacity;
      const arrive = this.arrive[i];
      if (arrive <= threshold) continue;
      if (visited % step !== 0) {
        visited += 1;
        continue;
      }
      const depart = this.depart[i];
      const flight = arrive - depart;
      const t = flight > 1e-9 ? Math.min(1, Math.max(0, (nowMs - depart) / flight)) : 1;
      visit(this.from[i], this.to[i], t, this.weight[i], nowMs - arrive);
      visited += 1;
    }
    return visited;
  }

  /**
   * Прочитать событие по порядковому номеру от свежего (для тестов).
   *
   * Возвращает `null`, если запись вытеснена или номер вне диапазона.
   */
  at(indexFromNewest: number): PulseEvent | null {
    if (indexFromNewest < 0 || indexFromNewest >= this.stored) return null;
    const i = (this.cursor - 1 - indexFromNewest + this.capacity * 2) % this.capacity;
    return {
      from: this.from[i],
      to: this.to[i],
      departMs: this.depart[i],
      arriveMs: this.arrive[i],
      weight: this.weight[i],
    };
  }
}

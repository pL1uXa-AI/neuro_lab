/**
 * Синапсы: разреженная матрица связей и доставка спайков с задержкой.
 *
 * ─── Формат хранения ─────────────────────────────────────────────────────
 *
 * CSR (compressed sparse row) — тот же приём, что список соседей Верле в
 * phys-lab: связи хранятся подряд по источнику, а `rowPtr[i]` говорит, где
 * начинается список исходящих связей нейрона i. Плотной матрицы нет: при
 * 10 000 нейронов она заняла бы 100 млн ячеек, тогда как реальная сеть
 * разрежена на 1–5 %.
 *
 * Дополнительно строится ОБРАТНЫЙ индекс (post → список входящих связей).
 * Он нужен STDP: правило обновляет вес в момент события, но чтобы найти
 * веса, ведущие К спайкнувшему нейрону, нужен обход входящих связей, а не
 * исходящих. Без обратного индекса пришлось бы сканировать всю матрицу.
 *
 * ─── Задержки ────────────────────────────────────────────────────────────
 *
 * Спайк, отправленный в такте t, приходит в такте t + delaySteps. Задержка —
 * свойство СИНАПСА, а не шага: в коре аксоны разной длины, и именно разброс
 * задержек создаёт волны и фазовые сдвиги.
 *
 * Реализация — кольцевой буфер ожидающих токов: массив
 * `pending[slot * count + target]`, где `slot = (step + delay) % slots`.
 * На каждом шаге читается текущий слот и обнуляется под будущие записи.
 * Память O(count · maxDelaySteps), что при 10 000 нейронов и 20 шагах
 * задержки даёт 200 000 чисел — дешевле, чем список событий.
 */

import type { Rng } from './rng.js';

/** Разреженная матрица связей в формате CSR плюс обратный индекс. */
export interface SynapseMatrix {
  /** Число нейронов (и строк, и столбцов). */
  count: number;
  /** Начало списка исходящих связей: длина count + 1. */
  rowPtr: Int32Array;
  /** Индекс нейрона-цели для каждой связи. */
  colIdx: Int32Array;
  /** Вес связи: > 0 возбуждение, < 0 торможение, единицы тока. */
  weight: Float64Array;
  /** Задержка в ШАГАХ интегрирования (не в миллисекундах). */
  delaySteps: Int32Array;

  /** Обратный индекс: начало списка входящих связей, длина count + 1. */
  colPtr: Int32Array;
  /** Индекс нейрона-ИСТОЧНИКА для каждой связи, в порядке обратного индекса. */
  rowIdx: Int32Array;
  /** Позиция связи в прямом массиве — чтобы обновлять вес из обратного обхода. */
  reverseOf: Int32Array;

  /** Число связей. */
  synapseCount: number;
  /** Максимальная задержка в шагах (размер кольцевого буфера). */
  maxDelaySteps: number;
}

/**
 * Построить CSR из списка связей.
 *
 * Списки `sources`/`targets`/`weights`/`delays` — «сырое» описание; функция
 * раскладывает их в CSR и строит обратный индекс. Отдельный шаг нужен
 * потому, что топологии генерируют связи разными способами, а формат
 * хранения у всех один — и тест «CSR совпадает с перебором» проверяет
 * именно раскладку, а не генерацию.
 */
export function buildSynapses(
  count: number,
  sources: ArrayLike<number>,
  targets: ArrayLike<number>,
  weights: ArrayLike<number>,
  delays: ArrayLike<number>,
): SynapseMatrix {
  const synapseCount = sources.length;

  // Первый проход: считаем степени исходящих и входящих связей.
  const outDegree = new Int32Array(count);
  const inDegree = new Int32Array(count);
  for (let s = 0; s < synapseCount; s++) {
    outDegree[sources[s]] += 1;
    inDegree[targets[s]] += 1;
  }

  // Префиксные суммы — начало списков.
  const rowPtr = new Int32Array(count + 1);
  const colPtr = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) {
    rowPtr[i + 1] = rowPtr[i] + outDegree[i];
    colPtr[i + 1] = colPtr[i] + inDegree[i];
  }

  const colIdx = new Int32Array(synapseCount);
  const weight = new Float64Array(synapseCount);
  const delaySteps = new Int32Array(synapseCount);
  const rowIdx = new Int32Array(synapseCount);
  const reverseOf = new Int32Array(synapseCount);

  // Второй проход: раскладываем связи. `cursorOut`/`cursorIn` — позиции
  // следующей записи в каждом списке.
  const cursorOut = Int32Array.from(rowPtr.subarray(0, count));
  const cursorIn = Int32Array.from(colPtr.subarray(0, count));

  let maxDelaySteps = 1;
  for (let s = 0; s < synapseCount; s++) {
    const from = sources[s];
    const to = targets[s];
    const position = cursorOut[from]++;
    colIdx[position] = to;
    weight[position] = weights[s];
    const delay = Math.max(1, Math.round(delays[s]));
    delaySteps[position] = delay;
    if (delay > maxDelaySteps) maxDelaySteps = delay;

    const reversePos = cursorIn[to]++;
    rowIdx[reversePos] = from;
    reverseOf[reversePos] = position;
  }

  return {
    count,
    rowPtr,
    colIdx,
    weight,
    delaySteps,
    colPtr,
    rowIdx,
    reverseOf,
    synapseCount,
    maxDelaySteps,
  };
}

/**
 * Проводящая среда: затухающий синаптический ток.
 *
 * ─── Зачем это нужно ─────────────────────────────────────────────────────
 *
 * Первая версия прибавляла вес спайка к току ровно на один шаг и на
 * следующем шаге ток исчезал. Это неверная биофизика: постсинаптический ток
 * (ВПСТ) длится несколько миллисекунд, и именно поэтому вклады близких по
 * времени спайков СКЛАДЫВАЮТСЯ. Без суммирования рекуррентная сеть не может
 * поддержать активность: измерено, что при любой силе связи (от 0.5 до 16)
 * активность гасла за 100–300 мс, то есть рабочей памяти не возникало.
 *
 * ─── Модель ──────────────────────────────────────────────────────────────
 *
 * Стандартный «экспоненциальный синапс». Для каждого нейрона ведётся
 * проводимость g, которая:
 *
 *     при приходе спайка:  g ← g + вес
 *     каждый шаг:          g ← g · exp(−dt/τ_syn)
 *     ток на нейрон:       I_syn = g
 *
 * Такая схема даёт правильное суммирование и корректно масштабируется:
 * площадь под ВПСТ равна w·τ_syn, то есть сила синапса задаётся весом,
 * а длительность — τ_syn, независимо друг от друга.
 *
 * ─── Важная тонкость с шагом ─────────────────────────────────────────────
 *
 * Амплитуда одного ВПСТ зависит от произведения w·dt/τ_syn: при уменьшении
 * шага вдвое вклад одного спайка тоже падает вдвое. Это НЕ ошибка, а
 * свойство непрерывной модели (площадь сохраняется, амплитуда — нет).
 * Поэтому вес связи и τ_syn задаются независимо от dt, а тесты, сравнивающие
 * поведение при разных dt, должны это учитывать. Если бы мы этого не
 * сделали, «сила связи» менялась бы при смене шага — а это ровно тот класс
 * дефектов, который проект старается исключать.
 */
export class SynapticConductance {
  readonly count: number;
  readonly g: Float64Array;
  private decayFactor: number;

  constructor(count: number, dt: number, tauMs: number) {
    this.count = count;
    this.g = new Float64Array(count);
    const tau = Math.max(1e-6, tauMs);
    this.decayFactor = Math.exp(-dt / tau);
  }

  /** Обновить постоянную затухания (при смене шага или τ_syn). */
  setTimeConstants(dt: number, tauMs: number): void {
    const tau = Math.max(1e-6, tauMs);
    this.decayFactor = Math.exp(-dt / tau);
  }

  /** Добавить спайк: проводимость цели растёт на вес. */
  add(target: number, amount: number): void {
    this.g[target] += amount;
  }

  /** Затухание на шаг. */
  decay(): void {
    for (let i = 0; i < this.count; i++) this.g[i] *= this.decayFactor;
  }

  /** Очистить. */
  reset(): void {
    this.g.fill(0);
  }
}

/**
 * Кольцевой буфер доставки спайков.
 *
 * На шаге `t`:
 *   1. читается слот текущего шага — это токи, пришедшие именно сейчас;
 *   2. спайки этого шага записываются в слот `(шаг + delay) % slots`;
 *   3. слот текущего шага обнуляется, курсор сдвигается.
 *
 * ─── Почему слот шага хранится отдельным полем ───────────────────────────
 *
 * Первая версия использовала курсор напрямую, и `schedule` после `endStep`
 * попадал уже в СЛЕДУЮЩИЙ слот: задержка в 1 шаг превращалась в 2. Причина
 * в том, что `endStep` двигает курсор, и порядок вызовов начинал влиять на
 * результат — а порядок в горячем цикле легко случайно поменять.
 * Поэтому база слота фиксируется в `beginStep` и не зависит от того,
 * вызван `schedule` до или после `endStep`.
 */
export class DelayBuffer {
  readonly count: number;
  readonly slots: number;
  /** Ожидающие токи: [слот][нейрон]. */
  readonly pending: Float64Array;
  private cursor = 0;
  /** Слот, соответствующий текущему шагу симуляции. */
  private stepSlot = 0;

  constructor(count: number, maxDelaySteps: number) {
    this.count = count;
    // Минимум 1 слот: задержка в 1 шаг тоже требует отдельного слота.
    this.slots = Math.max(1, maxDelaySteps + 1);
    this.pending = new Float64Array(this.slots * count);
  }

  /**
   * Начать шаг: зафиксировать слот шага и вернуть буфер пришедших токов.
   *
   * Возвращается ПРЕДСТАВЛЕНИЕ на массив, а не копия: слот обнуляется
   * только в `endStep`, поэтому вызывающая сторона обязана прочитать
   * значения до его вызова. В `Network.step` они сразу копируются.
   */
  beginStep(): Float64Array {
    this.stepSlot = this.cursor;
    const start = this.stepSlot * this.count;
    return this.pending.subarray(start, start + this.count);
  }

  /** Закончить шаг: обнулить слот шага и сдвинуть курсор. */
  endStep(): void {
    const start = this.stepSlot * this.count;
    this.pending.fill(0, start, start + this.count);
    this.cursor = (this.stepSlot + 1) % this.slots;
  }

  /**
   * Отложить спайк от нейрона `from` во все его цели.
   *
   * `scale` переводит вес в единицы тока конкретной модели нейрона: у LIF
   * это наноамперы, у Izhikevich — единицы уравнения. Масштаб приходит
   * снаружи, потому что буфер не знает, какая модель считается.
   */
  schedule(from: number, matrix: SynapseMatrix, scale: number): void {
    const begin = matrix.rowPtr[from];
    const end = matrix.rowPtr[from + 1];
    for (let s = begin; s < end; s++) {
      const slot = (this.stepSlot + matrix.delaySteps[s]) % this.slots;
      this.pending[slot * this.count + matrix.colIdx[s]] += matrix.weight[s] * scale;
    }
  }

  /** Слот текущего шага — для отладки и проверок. */
  get currentSlot(): number {
    return this.stepSlot;
  }

  /** Очистить всё (при пересборке сети). */
  reset(): void {
    this.pending.fill(0);
    this.cursor = 0;
    this.stepSlot = 0;
  }
}

/** Параметры генерации топологии. */
export interface TopologyOptions {
  /** Число нейронов. */
  count: number;
  /** Доля тормозных нейронов (они идут «хвостом» массива). */
  inhibitoryFraction: number;
  /** Средняя вероятность связи между двумя нейронами. */
  connectionProbability: number;
  /** Вес возбуждающей связи. */
  excitatoryWeight: number;
  /**
   * Отношение тормозного веса к возбуждающему.
   *
   * Держится отдельным множителем, а не «просто отрицательным числом»:
   * баланс E/I в коре задаётся именно отношением, и его нужно уметь менять
   * одним ползунком, не пересчитывая все веса.
   */
  inhibitoryRatio: number;
  /** Базовая задержка, мс. */
  delay: number;
  /** Разброс задержек как доля от базовой (0 — все одинаковы). */
  delayJitter: number;
  /** Шаг интегрирования, мс — переводит задержку в шаги. */
  dt: number;
  /** Источник случайности: топология обязана воспроизводиться. */
  rng: Rng;
}

/**
 * Топология «разреженная случайная»: каждая пара соединяется с вероятностью p.
 *
 * Это базовая сеть проекта. При доле торможения 20 % и сбалансированных весах
 * она воспроизводит главное явление коры: нерегулярный асинхронный режим
 * (CV ISI ≈ 1), в котором нейроны разряжаются редко и без общего ритма.
 *
 * Самосвязи исключаются: в этой модели автопсис не имеет смысла, потому что
 * спайк доставляется со следующего шага и «подкреплял» бы сам себя.
 */
export function randomSparseTopology(options: TopologyOptions): SynapseMatrix {
  const { count, rng, connectionProbability } = options;
  const inhibitoryStart = count - Math.round(count * options.inhibitoryFraction);

  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];

  for (let i = 0; i < count; i++) {
    const inhibitory = i >= inhibitoryStart;
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      if (rng.next() >= connectionProbability) continue;
      sources.push(i);
      targets.push(j);
      const magnitude = inhibitory
        ? options.excitatoryWeight * options.inhibitoryRatio
        : options.excitatoryWeight;
      weights.push(inhibitory ? -magnitude : magnitude);
      delays.push(delayInSteps(options.delay, options.delayJitter, options.dt, rng));
    }
  }

  return buildSynapses(count, sources, targets, weights, delays);
}

/** Задержка в шагах с учётом разброса. Минимум 1 шаг. */
function delayInSteps(delayMs: number, jitter: number, dt: number, rng: Rng): number {
  const factor = jitter > 0 ? 1 + rng.range(-jitter, jitter) : 1;
  const value = (delayMs * factor) / dt;
  return Math.max(1, Math.round(value));
}

/**
 * Слоистая топология: вход → скрытый слой → выход.
 *
 * Нужна для конкурентного обучения и рабочей памяти: там важна не
 * однородность, а направленность потока.
 */
export function layeredTopology(
  options: TopologyOptions & { layers: number[]; recurrentHidden?: boolean },
): SynapseMatrix {
  const { count, rng, layers } = options;
  const inhibitoryStart = count - Math.round(count * options.inhibitoryFraction);
  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];

  const bounds: Array<[number, number]> = [];
  let offset = 0;
  for (const size of layers) {
    bounds.push([offset, offset + size]);
    offset += size;
  }

  const push = (from: number, to: number): void => {
    if (from === to) return;
    sources.push(from);
    targets.push(to);
    const inhibitory = from >= inhibitoryStart;
    const magnitude = inhibitory
      ? options.excitatoryWeight * options.inhibitoryRatio
      : options.excitatoryWeight;
    weights.push(inhibitory ? -magnitude : magnitude);
    delays.push(delayInSteps(options.delay, options.delayJitter, options.dt, rng));
  };

  for (let layer = 0; layer < bounds.length - 1; layer++) {
    const [fromStart, fromEnd] = bounds[layer];
    const [toStart, toEnd] = bounds[layer + 1];
    for (let i = fromStart; i < fromEnd; i++) {
      for (let j = toStart; j < toEnd; j++) {
        if (rng.next() >= options.connectionProbability) continue;
        push(i, j);
      }
    }
  }

  // Рекуррентные связи внутри скрытого слоя — то, из чего возникает
  // рабочая память: активность поддерживает сама себя.
  if (options.recurrentHidden === true && bounds.length >= 2) {
    const [start, end] = bounds[1];
    for (let i = start; i < end; i++) {
      for (let j = start; j < end; j++) {
        if (rng.next() >= options.connectionProbability) continue;
        push(i, j);
      }
    }
  }

  return buildSynapses(count, sources, targets, weights, delays);
}

/**
 * Пространственная топология: нейроны на решётке, связь по расстоянию.
 *
 * Задержка пропорциональна расстоянию — это единственное отличие от
 * случайной сети, и именно оно даёт ВОЛНУ: фронт активности бежит по сетке
 * с конечной скоростью, потому что близкие нейроны получают спайк раньше
 * далёких.
 *
 * Возвращает также координаты: рендеру и стимулу «в пятно» они нужны, а
 * вычислять их второй раз значило бы рисковать расхождением.
 */
export function gridTopology(
  options: TopologyOptions & {
    /** Размер решётки: side × side нейронов. */
    side: number;
    /** Радиус связи в клетках. */
    radius: number;
    /** Скорость проведения, клеток за мс. */
    speed: number;
  },
): { matrix: SynapseMatrix; x: Float64Array; y: Float64Array } {
  const { side, radius, speed, rng } = options;
  const count = Math.min(options.count, side * side);
  const inhibitoryStart = count - Math.round(count * options.inhibitoryFraction);

  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    x[i] = i % side;
    y[i] = Math.floor(i / side);
  }

  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];

  const radiusSquared = radius * radius;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radiusSquared) continue;
      if (rng.next() >= options.connectionProbability) continue;

      const distance = Math.sqrt(distanceSquared);
      const inhibitory = i >= inhibitoryStart;
      // Вес затухает с расстоянием: иначе волна не имеет фронта, а
      // «включается» вся сразу.
      const falloff = 1 - distance / (radius + 1);
      const magnitude = options.excitatoryWeight * falloff * (inhibitory ? options.inhibitoryRatio : 1);
      sources.push(i);
      targets.push(j);
      weights.push(inhibitory ? -magnitude : magnitude);
      // Задержка = расстояние / скорость. Это и есть механизм волны.
      delays.push(Math.max(1, Math.round(distance / speed / options.dt)));
    }
  }

  return { matrix: buildSynapses(count, sources, targets, weights, delays), x, y };
}

/**
 * Кольцевая топология: нужна для ритмов и фазовой синхронизации.
 *
 * Каждый нейрон соединяется с `span` соседями вперёд по кольцу. Такая сеть
 * при достаточной связи переходит в бегущую волну возбуждения — прообраз
 * центрального генератора ритма.
 */
export function ringTopology(
  options: TopologyOptions & { span: number },
): SynapseMatrix {
  const { count, span } = options;
  const inhibitoryStart = count - Math.round(count * options.inhibitoryFraction);
  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const delays: number[] = [];

  for (let i = 0; i < count; i++) {
    for (let k = 1; k <= span; k++) {
      const j = (i + k) % count;
      if (i === j) continue;
      const inhibitory = i >= inhibitoryStart;
      const magnitude = inhibitory
        ? options.excitatoryWeight * options.inhibitoryRatio
        : options.excitatoryWeight;
      sources.push(i);
      targets.push(j);
      weights.push(inhibitory ? -magnitude : magnitude);
      delays.push(Math.max(1, Math.round((options.delay * k) / options.dt)));
    }
  }

  return buildSynapses(count, sources, targets, weights, delays);
}

/**
 * Модели нейронов: LIF и Izhikevich.
 *
 * ─── Почему именно эти две ───────────────────────────────────────────────
 *
 * LIF (Leaky Integrate-and-Fire) — одна переменная, точное решение, десятки
 * тысяч нейронов в реальном времени. Годится для сетей и для всех явлений,
 * где важна коллективная динамика, а не форма спайка.
 *
 * Izhikevich — две переменные и четыре параметра, но воспроизводит 20+ типов
 * нейронов: regular spiking, fast spiking, bursting, chattering. Это тот
 * уровень, где уже видно, что «нейроны бывают разные».
 *
 * Hodgkin-Huxley сознательно не реализован: он требует ионных каналов и
 * жёсткой системы уравнений, а все явления уровня 1 воспроизводятся и без
 * него. Он оставлен на уровень 2 (см. ROADMAP.md).
 *
 * ─── Как устроен шаг ─────────────────────────────────────────────────────
 *
 * Модуль НЕ решает, что делать со спайком: он только продвигает потенциалы и
 * записывает, кто и когда спайковал. Доставка спайков по связям, обучение
 * STDP и метрики — забота `network.ts`. Это разделение нужно потому, что
 * один и тот же нейрон гоняется и в сети из 10 000 клеток, и в одиночном
 * эксперименте «генератор спайков», а поведение обязано совпадать.
 */

import { V_INSANE, type NeuronParams, type NeuronState } from './types.js';

/**
 * Постоянная времени затухания «вспышки» для рендера, мс.
 *
 * Не физика: это чисто визуальная величина. Подбиралась по картинке, а не
 * по формуле.
 *
 * Было 25 мс — и на живой сети, где нейрон разряжается каждые 20–40 мс,
 * вспышка НЕ УСПЕВАЛА погаснуть между спайками. В результате светились
 * почти все нейроны одновременно (измерено: 788 из 800), сеть выглядела
 * ровным жёлтым блином, и ни частота разрядов, ни отдельные спайки не
 * читались.
 *
 * 8 мс короче типичного межимпульсного интервала, поэтому вспышка успевает
 * угаснуть и остаётся читаемой как СОБЫТИЕ.
 */
export const FLASH_TAU = 8;

/** Буфер записанных спайков одного шага. Переиспользуется, чтобы не аллоцировать. */
export interface SpikeBuffer {
  count: number;
  /** Индексы нейронов, спайковавших на этом шаге. */
  index: Int32Array;
  /** Точное время спайка внутри шага, мс. */
  time: Float64Array;
}

/** Выделение буфера спайков. */
export function allocSpikeBuffer(capacity: number): SpikeBuffer {
  return {
    count: 0,
    index: new Int32Array(capacity),
    time: new Float64Array(capacity),
  };
}

/**
 * Снимок мембранного потенциала для осциллографа.
 *
 * Кольцевой буфер на несколько каналов: осциллограф показывает не историю
 * всех нейронов (это гигабайты), а выбранные пользователем дорожки.
 */
export class TraceRecorder {
  readonly capacity: number;
  readonly channels: number;
  /** Значения: [канал][отсчёт], плоским массивом. */
  readonly values: Float64Array;
  /** Времена отсчётов, общие для всех каналов. */
  readonly times: Float64Array;
  /** Индекс следующей записи. */
  cursor = 0;
  /** Сколько отсчётов записано (растёт до capacity). */
  size = 0;
  /** Времена записанных спайков по каналам — для отметок на осциллограмме. */
  readonly spikeMarks: number[][];

  constructor(channels: number, capacity: number) {
    this.channels = channels;
    this.capacity = capacity;
    this.values = new Float64Array(channels * capacity);
    this.times = new Float64Array(capacity);
    this.spikeMarks = Array.from({ length: channels }, () => []);
  }

  /** Записать отсчёт по всем каналам. */
  push(time: number, neuronIndices: readonly number[], state: NeuronState): void {
    const at = this.cursor;
    this.times[at] = time;
    for (let c = 0; c < this.channels; c++) {
      const neuron = neuronIndices[c];
      this.values[c * this.capacity + at] =
        neuron === undefined || neuron < 0 ? Number.NaN : state.v[neuron];
    }
    this.cursor = (at + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /** Отметить спайк на канале. */
  markSpike(channel: number, time: number): void {
    const marks = this.spikeMarks[channel];
    if (marks) marks.push(time);
  }

  /** Очистить всё. */
  reset(): void {
    this.values.fill(Number.NaN);
    this.times.fill(0);
    this.cursor = 0;
    this.size = 0;
    for (const marks of this.spikeMarks) marks.length = 0;
  }

  /**
   * Развернуть буфер в хронологическом порядке.
   *
   * Возвращает индексы от самого старого отсчёта к самому новому: без этого
   * осциллограф рисовал бы «шов» там, где кольцевой буфер завернулся.
   */
  order(): number[] {
    const out: number[] = [];
    const start = this.size < this.capacity ? 0 : this.cursor;
    for (let i = 0; i < this.size; i++) {
      out.push((start + i) % this.capacity);
    }
    return out;
  }
}

/**
 * Инициализация нейронов перед прогоном.
 *
 * Возбуждение/торможение раздаётся по индексам, а не случайно: при
 * `inhibitoryFraction = 0.2` ровно каждый пятый нейрон тормозной. Случайная
 * раздача давала бы на маленьких сетях колебания доли от запуска к запуску,
 * и метрики E/I баланса «дрожали» бы без причины.
 *
 * ─── Почему потенциал берётся по модели ──────────────────────────────────
 *
 * Первая версия ставила всем нейронам `params.izh.vRest`. Это работало
 * РОВНО ДО ТЕХ ПОР, пока `lif.vRest` и `izh.vRest` совпадали числом (−65):
 * совпадение констант маскировало ошибку. Как только точка покоя Izhikevich
 * была исправлена на истинную (−70, см. `DEFAULT_IZH`), LIF-сеть начала
 * стартовать с −70 вместо −65. Ошибка была не в константе, а в том, что
 * модель не спрашивали о её собственном покое.
 */
export function initNeurons(
  state: NeuronState,
  params: NeuronParams,
  inhibitoryFraction: number,
): void {
  const count = state.count;
  const inhibitoryCount = Math.round(count * inhibitoryFraction);
  // Тормозные — «хвост» массива: индекс >= count - inhibitoryCount.
  const firstInhibitory = count - inhibitoryCount;

  // Потенциал покоя и начальное значение восстановления — свои у каждой
  // модели. Для LIF переменная u не используется, но массив заполняется
  // единообразно, чтобы переключение модели не требовало пересборки.
  const restV = params.model === 'lif' ? params.lif.vRest : params.izh.vRest;
  const restU = params.model === 'lif' ? 0 : params.izh.uRest;

  for (let i = 0; i < count; i++) {
    state.inhibitory[i] = i >= firstInhibitory ? 1 : 0;
    state.v[i] = restV;
    state.u[i] = restU;
    state.refrac[i] = 0;
    state.lastSpike[i] = Number.NEGATIVE_INFINITY;
    state.prevSpike[i] = Number.NEGATIVE_INFINITY;
    state.firstSpike[i] = Number.NEGATIVE_INFINITY;
    state.lastIsi[i] = Number.NaN;
    state.meanIsi[i] = Number.NaN;
    state.meanIsi2[i] = Number.NaN;
    state.spikeCount[i] = 0;
    state.spiked[i] = 0;
    state.flash[i] = 0;
  }
  state.step = 0;
  state.time = 0;
  state.insane = 0;
}

/**
 * Записать факт спайка: обновить счётчики и интервалы.
 *
 * ISI обновляется именно здесь, в момент спайка, а не при чтении метрик.
 * Иначе пришлось бы хранить историю всех спайков каждого нейрона, а средний
 * ISI считается по определению через интервалы, а не через время наблюдения.
 */
function recordSpike(state: NeuronState, i: number, time: number): void {
  const previous = state.lastSpike[i];
  state.prevSpike[i] = previous;
  state.lastSpike[i] = time;
  // Первый спайк фиксируется один раз и больше не меняется: по нему
  // измеряется движение фронта волны (см. `wave.ts`).
  if (!Number.isFinite(state.firstSpike[i])) state.firstSpike[i] = time;
  state.spikeCount[i] += 1;
  state.spiked[i] = 1;
  state.flash[i] = 1;

  if (Number.isFinite(previous)) {
    const isi = time - previous;
    if (isi > 0) {
      state.lastIsi[i] = isi;
      // Экспоненциальное среднее: помнит последние несколько интервалов,
      // чего достаточно для CV, и не требует хранить всю историю.
      const alpha = 0.2;
      if (Number.isNaN(state.meanIsi[i])) {
        state.meanIsi[i] = isi;
        state.meanIsi2[i] = isi * isi;
      } else {
        state.meanIsi[i] = (1 - alpha) * state.meanIsi[i] + alpha * isi;
        state.meanIsi2[i] = (1 - alpha) * state.meanIsi2[i] + alpha * isi * isi;
      }
    }
  }
}

/**
 * Непрерывная часть шага LIF: интегрирование до порога и обработка спайка.
 *
 * Уравнение `τ dV/dt = −(V − V_rest) + R·I` решается аналитически:
 *
 *     V_inf = V_rest + R·I
 *     V(t)  = V_inf + (V₀ − V_inf)·exp(−t/τ)
 *
 * Это не украшение: при явном Эйлере частота спайков зависит от шага (тест
 * «частота не зависит от dt» это ловит), потому что ошибка Эйлера
 * систематически занижает рост потенциала. Точное решение убирает
 * зависимость от dt вплоть до момента пересечения порога.
 */
function integrateLif(
  state: NeuronState,
  params: NeuronParams,
  i: number,
  current: number,
  duration: number,
  startTime: number,
  useRefractory: boolean,
): boolean {
  if (duration <= 0) return false;
  const lif = params.lif;
  const v0 = state.v[i];
  const vInf = lif.vRest + lif.rIn * current;
  const decay = Math.exp(-duration / lif.tauM);
  const v1 = vInf + (v0 - vInf) * decay;

  if (v1 < lif.vTh) {
    state.v[i] = v1;
    return false;
  }

  // Пересечение порога: решаем V(t*) = vTh и берём долю шага.
  //
  //     (vTh − vInf) / (v0 − vInf) = exp(−t*/τ)   ⇒   t* = −τ·ln(ratio)
  //
  // Если знаки числителя и знаменателя разные (порог лежит между v0 и vInf),
  // ratio < 0 и логарифм не определён: роста «сквозь» порог в этом шаге нет
  // в том смысле, в каком его даёт экспонента, поэтому берём конец шага.
  let fraction = 1;
  const denom = v0 - vInf;
  if (Math.abs(denom) > 1e-12) {
    const ratio = (lif.vTh - vInf) / denom;
    if (ratio > 0 && ratio < 1) {
      fraction = (-lif.tauM * Math.log(ratio)) / duration;
    }
  }
  if (!Number.isFinite(fraction)) fraction = 1;
  if (fraction < 0) fraction = 0;
  if (fraction > 1) fraction = 1;

  const spikeTime = startTime + fraction * duration;
  recordSpike(state, i, spikeTime);
  state.v[i] = lif.vReset;
  // Остаток шага ПОСЛЕ спайка засчитывается в рефрактерность.
  //
  // Это не мелочь: спайк приходится на середину шага, а не на его границу.
  // Если отсчитывать рефрактерность от следующего шага, каждый спайк теряет
  // до dt мёртвого времени, и предельная частота падает. Измерено на
  // τ_ref = 2 мс: без поправки при dt = 0.5 мс выходило 400 Гц вместо 498,
  // и — хуже — эта частота ЗАВИСЕЛА от dt, что ломает инвариант
  // «поведение нейрона не зависит от шага интегрирования».
  const remainder = duration - fraction * duration;
  state.refrac[i] = useRefractory ? Math.max(0, lif.refrac - remainder) : 0;
  return true;
}

/**
 * Шаг LIF одного нейрона.
 *
 * Отдельная функция нужна из-за рефрактерности: она накладывается маской на
 * КАЖДОМ шаге, а не однократно в момент спайка (инвариант 2). Если бы сброс
 * потенциала происходил один раз, уже на следующем шаге вход вернул бы
 * нейрон к порогу, и «абсолютная рефрактерность» превратилась бы в
 * фикцию — ровно этот класс ошибок давал дефект 27 в phys-lab.
 */
function stepLifNeuron(
  state: NeuronState,
  params: NeuronParams,
  i: number,
  current: number,
  dt: number,
  time: number,
  useRefractory: boolean,
): boolean {
  const lif = params.lif;
  const leftover = state.refrac[i];

  if (useRefractory && leftover > 0) {
    state.v[i] = lif.vReset;
    if (leftover >= dt) {
      state.refrac[i] = leftover - dt;
      return false;
    }
    // Рефрактерность истекла ВНУТРИ шага: оставшееся время интегрируем.
    // Иначе частота занижалась бы на целый шаг на каждый спайк, и при
    // τ_ref = 2 мс ошибка составляла бы несколько процентов.
    state.refrac[i] = 0;
    return integrateLif(state, params, i, current, dt - leftover, time + leftover, useRefractory);
  }

  state.refrac[i] = 0;
  return integrateLif(state, params, i, current, dt, time, useRefractory);
}

/**
 * Шаг Izhikevich.
 *
 * Уравнения (Izhikevich, 2003):
 *
 *     dV/dt = 0.04·V² + 5·V + 140 − u + I
 *     du/dt = a·(b·V − u)
 *     если V ≥ V_peak:  V ← c,  u ← u + d
 *
 * Численная схема — из статьи, а не обычный Эйлер: `u` считается по НОВОМУ
 * значению V, а V обновляется двумя полушагами. Это воспроизводит сигнатуры
 * из Figure 1 (bursting, chattering, адаптация); обычный Эйлер их искажает,
 * и каталог режимов перестаёт совпадать со статьёй (инвариант 3).
 *
 * Схема условно устойчива: при dt > 1 мс член 0.04·V² разгоняет потенциал
 * до бесконечности. Отсюда MAX_DT и проверка на разлёт.
 */
function stepIzhNeuron(
  state: NeuronState,
  params: NeuronParams,
  i: number,
  current: number,
  dt: number,
  time: number,
): boolean {
  const izh = params.izh;
  const vBefore = state.v[i];
  let v = vBefore;
  let u = state.u[i];
  const half = dt / 2;

  // Два полушага по V. u внутри полушага берётся старым — так в статье.
  v += half * (0.04 * v * v + 5 * v + 140 - u + current);
  v += half * (0.04 * v * v + 5 * v + 140 - u + current);
  // u — по новому V.
  u += dt * izh.a * (izh.b * v - u);

  // Разлёт: у Izhikevich потенциал при большом dt уходит в бесконечность
  // скачком, и «доигрывать» такой сценарий нельзя — восстановим нейрон
  // в покое и посчитаем инцидент.
  if (!Number.isFinite(v) || Math.abs(v) > V_INSANE) {
    state.v[i] = izh.vRest;
    state.u[i] = izh.uRest;
    state.refrac[i] = 0;
    state.insane += 1;
    return false;
  }

  if (v >= izh.vPeak) {
    // Время спайка: линейная интерполяция между потенциалом в начале шага
    // и только что полученным. Порядок величины тот же, что у LIF (доли dt).
    const span = v - vBefore;
    const fraction = span > 1e-9 ? (izh.vPeak - vBefore) / span : 1;
    const spikeTime = time + Math.min(1, Math.max(0, fraction)) * dt;

    recordSpike(state, i, spikeTime);
    // Сброс: V ← c, u ← u + d. Знак d в разных источниках различается;
    // здесь d прибавляется к u, как в статье и в NEST.
    state.v[i] = izh.c;
    state.u[i] = u + izh.d;
    state.refrac[i] = 0;
    return true;
  }

  state.v[i] = v;
  state.u[i] = u;
  return false;
}

/** Настройки шага, не относящиеся к модели нейрона. */
export interface StepOptions {
  /**
   * Учитывать рефрактерность. Выключается только в тестах: с ней связано
   * утверждение о максимальной частоте, и его нужно уметь проверять «без неё».
   */
  useRefractory?: boolean;
}

/**
 * Продвинуть все нейроны на один шаг.
 *
 * `current` — входной ток на нейрон (уже с учётом синаптических приходов этого
 * шага). Спайки пишутся в `out`, и НЕ доставляются здесь: доставка должна
 * учитывать задержки и тип синапса, а это знание живёт в `network.ts`.
 */
export function stepNeurons(
  state: NeuronState,
  params: NeuronParams,
  current: Float64Array,
  dt: number,
  out: SpikeBuffer,
  options: StepOptions = {},
): void {
  const useRefractory = options.useRefractory ?? true;
  out.count = 0;
  const count = state.count;
  const decay = Math.exp(-dt / FLASH_TAU);

  for (let i = 0; i < count; i++) {
    // Вспышка гаснет ДО обработки спайка: тогда свежий спайк получает
    // ровно 1, а не 1·decay, и вспышка одинакова на любом шаге.
    let flash = state.flash[i] * decay;
    if (flash < 1e-4) flash = 0;
    state.flash[i] = flash;
    // `spiked` живёт ровно один шаг: сбрасываем перед обработкой нейрона.
    state.spiked[i] = 0;

    let spiked: boolean;
    if (params.model === 'lif') {
      spiked = stepLifNeuron(state, params, i, current[i], dt, state.time, useRefractory);
    } else {
      spiked = stepIzhNeuron(state, params, i, current[i], dt, state.time);
    }
    if (spiked && out.count < out.index.length) {
      out.index[out.count] = i;
      out.time[out.count] = state.lastSpike[i];
      out.count += 1;
    }
  }

  state.step += 1;
  state.time += dt;
}

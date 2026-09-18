/**
 * Сеть: ядро симуляции спайковых нейронов.
 *
 * Один шаг устроен так:
 *
 *   1. собрать входящий ток: пришедшие по связям + внешний вход + стимулы;
 *   2. продвинуть нейроны на шаг (`stepNeurons`), получить спайки этого шага;
 *   3. отложить спайки в буфер задержек (они придут через `delay` шагов);
 *   4. обновить метрики: синхронность по числу спайков, история частоты.
 *
 * Порядок «сначала ток, потом нейроны, потом рассылка» — не произволен:
 * спайк, отправленный на шаге t, не может влиять на нейроны того же шага,
 * иначе задержка в 1 шаг превратилась бы в 0 и сеть потеряла бы причинность.
 *
 * Класс, как и всё в `core/`, ничего не знает про DOM и Pixi: то же ядро
 * гоняют тесты в чистом Node, и его же можно вынести в Web Worker.
 */

import { allocSpikeBuffer, initNeurons, stepNeurons, type SpikeBuffer } from './neuron.js';
import { DelayBuffer, SynapticConductance, buildSynapses, type SynapseMatrix } from './synapses.js';
import { Rng } from './rng.js';
import { SpikeHistory } from './spike-history.js';
import { PulseTrace } from './pulse-trace.js';
import {
  DEFAULT_STDP,
  StdpTraces,
  depressOutgoing,
  potentiateIncoming,
  type StdpParams,
} from './stdp.js';
import {
  RateHistory,
  SynchronyMeter,
  activeFraction as activeFractionOf,
  activeRate as activeRateOf,
  cvIsi as cvOf,
  populationRate,
} from './measures.js';
import {
  DEFAULT_NETWORK_PARAMS,
  MAX_DT,
  allocNeuronState,
  type InputMode,
  type NetworkParams,
  type NeuronState,
} from './types.js';

/** Пространственный стимул: ток в пятно заданного радиуса. */
export interface SpotStimulus {
  /** Координаты центра (в клетках решётки или условных единицах). */
  x: number;
  y: number;
  /** Радиус пятна. */
  radius: number;
  /** Амплитуда добавленного тока. */
  amplitude: number;
  /** Пока какой момент времени (мс) стимул действует. */
  untilMs: number;
}

/** Один замер для графиков. */
export interface NetworkSample {
  timeMs: number;
  /** Средняя частота по популяции, Гц. */
  rate: number;
  /** Частота по активным нейронам, Гц. */
  activeRate: number;
  /** Доля нейронов, спайковавших за окно. */
  activeFraction: number;
  /** CV ISI усреднённый по нейронам с достаточной статистикой. */
  cv: number;
  /** Синхронность по бинам. */
  synchrony: number;
}

/** Ёмкость истории графиков: при dt = 0.5 мс это 20 000 шагов ≈ 10 с. */
const HISTORY_CAPACITY = 8192;

/**
 * Отношение тормозного веса к возбуждающему — то же, что
 * `TopologyOptions.inhibitoryRatio` при генерации топологии.
 *
 * Держится константой модуля, чтобы правка торможения в работающей сети
 * давала ТУ ЖЕ картину, что и торможение, заданное пресетом: иначе
 * ползунок «торможение» молча менял бы не только долю, но и силу.
 */
const INHIBITORY_RATIO = 4;

/**
 * Сколько нейронов опрашивается при оценке шага между ними.
 *
 * Оценка ищет ближайшего соседа перебором, то есть стоит O(выборка · count).
 * 256 даёт ~640 тысяч операций даже на решётке 2500 — единицы миллисекунд,
 * которые платятся ОДИН раз (результат кэшируется). Больше брать незачем:
 * медиана по 256 значениям устойчива, а точность важна до процентов, а не
 * до долей.
 */
const SPACING_SAMPLE = 256;

export class Network {
  params: NetworkParams;
  state: NeuronState;
  synapses: SynapseMatrix;
  /**
   * Координаты нейронов для пространственных топологий (иначе пусто).
   *
   * Доступны через геттер/сеттер, а не как обычные поля: при ПРИСВАИВАНИИ
   * массива целиком (так делает сборка сцены: `network.x = matrix.x`)
   * сбрасывается кэш `neuronSpacing`. Без этого радиус кисти считался бы по
   * геометрии ПРЕДЫДУЩЕЙ сцены — ошибка, которую легко не заметить.
   *
   * Поэлементная запись (`network.x[i] = …`) кэш не сбрасывает: она
   * встречается в тестах и в раскладке диска, где вызывается до первого
   * обращения к оценке.
   */
  private coordsX: Float64Array = new Float64Array(0);
  private coordsY: Float64Array = new Float64Array(0);
  /** Кэш шага между нейронами; null — ещё не считали. */
  private spacingCache: number | null = null;

  /**
   * Исходные веса связей (до множителя и смены торможения).
   *
   * `null` — снимок ещё не делался. Заполняется при ПЕРВОЙ правке весов
   * лениво: так сцена, которую не трогали, не платит за копию массива.
   */
  private baseWeights: Float64Array | null = null;
  /** Текущий множитель веса связей. */
  private weightScale = 1;

  get x(): Float64Array {
    return this.coordsX;
  }

  set x(value: Float64Array) {
    this.coordsX = value;
    this.spacingCache = null;
  }

  get y(): Float64Array {
    return this.coordsY;
  }

  set y(value: Float64Array) {
    this.coordsY = value;
    this.spacingCache = null;
  }

  private rng: Rng;
  private delays: DelayBuffer;
  /** Затухающая синаптическая проводимость — входной ток нейронов. */
  private conductance: SynapticConductance;
  private incoming: Float64Array;
  private external: Float64Array;
  private spikeBuffer: SpikeBuffer;
  private synchrony: SynchronyMeter;
  private rateHistory: RateHistory;
  private history: NetworkSample[] = [];
  /** Параметры STDP. */
  private stdp: StdpParams;
  /** Следы STDP — состояние обучения, а не нейрона. */
  private traces: StdpTraces;
  /**
   * След прошедших импульсов — для визуализации передачи по синапсам.
   *
   * Ведётся ВСЕГДА (запись дешёвая: несколько массивов и курсор), но
   * выключить её можно полем `pulseTraceEnabled`, а рендер решает сам,
   * показывать ли связи. Ядро от этого не зависит: запись не влияет ни на
   * ток, ни на спайки, ни на метрики.
   */
  readonly pulses: PulseTrace = new PulseTrace();
  /** Вести ли запись импульсов (по умолчанию — да, это часть наблюдения). */
  pulseTraceEnabled = true;
  /** История спайков для растровой диаграммы и проверок уровней. */
  readonly spikeHistory: SpikeHistory;
  /** Множители затухания следов на шаг (считаются один раз). */
  private traceXDecay: number;
  private traceYDecay: number;
  /** Пространственный стимул, если задан. */
  private spot: SpotStimulus | null = null;
  /** Собственные временные стимулы (прямая инъекция тока в нейрон). */
  private injections: Array<{ index: number; amplitude: number; untilMs: number }> = [];

  constructor(
    params: NetworkParams = DEFAULT_NETWORK_PARAMS,
    matrix?: SynapseMatrix,
    stdp: StdpParams = DEFAULT_STDP,
  ) {
    this.params = { ...params };
    // Исходная доля торможения запоминается ДО любых правок: с ней
    // сравнивает уровень «Своя сеть», чтобы понять, изменена ли сеть.
    this.presetInhibitoryFraction = params.inhibitoryFraction;
    this.stdp = { ...stdp };
    this.rng = new Rng(params.seed);
    this.state = allocNeuronState(params.count);
    this.synapses = matrix ?? emptyMatrix(params.count);
    this.x = new Float64Array(params.count);
    this.y = new Float64Array(params.count);
    // Инициализация обязательна: `allocNeuronState` оставляет нули, а нуль
    // для LIF — это −0 мВ, то есть ВЫШЕ порога −50 мВ. Без этого шага вся
    // сеть выдавала бы по спайку на первом же такте.
    initNeurons(this.state, params.neuron, params.inhibitoryFraction);

    this.delays = new DelayBuffer(params.count, this.synapses.maxDelaySteps);
    this.conductance = new SynapticConductance(params.count, params.dt, params.synapticTau);
    this.incoming = new Float64Array(params.count);
    this.external = new Float64Array(params.count);
    // Буфер спайков с запасом: разреженная случайная сеть при p = 0.02
    // даёт в пике несколько процентов нейронов за шаг, но при синхронном
    // разряде спайкуют почти все — берём по числу нейронов.
    this.spikeBuffer = allocSpikeBuffer(params.count + 8);
    this.synchrony = new SynchronyMeter(5, 100000);
    this.rateHistory = new RateHistory(2048, 2);
    this.traces = new StdpTraces(params.count);
    this.spikeHistory = new SpikeHistory();
    // Затухание следов не зависит от шага: экспонента на dt.
    this.traceXDecay = Math.exp(-params.dt / this.stdp.tauPlus);
    this.traceYDecay = Math.exp(-params.dt / this.stdp.tauMinus);
  }

  /** Включить или выключить STDP. */
  setStdp(enabled: boolean): void {
    this.stdp.enabled = enabled;
  }

  /** Параметры STDP (для интерфейса и проверок). */
  get stdpParams(): StdpParams {
    return this.stdp;
  }

  /** Сколько обновлений весов сделано — метрика обучения. */
  get stdpUpdates(): number {
    return this.traces.updates;
  }

  /** Заменить матрицу связей (после смены топологии). */
  setSynapses(matrix: SynapseMatrix): void {
    this.synapses = matrix;
    this.delays = new DelayBuffer(this.params.count, matrix.maxDelaySteps);
    // Снимок исходных весов сбрасывается: новая матрица — новая база.
    this.baseWeights = null;
    this.weightScale = 1;
  }

  /** Сбросить состояние нейронов и метрик, сохранив топологию. */
  reset(): void {
    this.state = allocNeuronState(this.params.count);
    initNeurons(this.state, this.params.neuron, this.params.inhibitoryFraction);
    this.delays.reset();
    this.conductance.reset();
    this.incoming.fill(0);
    this.synchrony.reset();
    this.rateHistory.reset();
    this.traces.reset();
    this.spikeHistory.reset();
    this.pulses.reset();
    this.history = [];
    this.injections = [];
    this.spot = null;
  }

  /** Задать пространственный стимул. */
  setSpot(spot: SpotStimulus | null): void {
    this.spot = spot;
  }

  /**
   * Масштаб внешнего тока для текущей модели.
   *
   * У LIF единица тока — наноампер (пороговый ток ≈ 1.5), у Izhikevich —
   * единицы самого уравнения (характерные токи 10…20). Это ТОТ ЖЕ множитель,
   * которым переводятся веса связей (`LIF_EQUIVALENT_SCALE`), и берётся он
   * здесь намеренно, а не свой собственный: иначе вес связи и «удар током»
   * масштабировались бы по-разному, и переключение модели меняло бы
   * соотношение между ними.
   */
  get stimulusScale(): number {
    return this.params.neuron.model === 'lif' ? 1 : LIF_EQUIVALENT_SCALE;
  }

  /**
   * Действует ли сейчас пространственный стимул.
   *
   * Нужно проверкам: «стимул снят» — это состояние, которое обязано быть
   * наблюдаемым, иначе отпускание кнопки мыши проверяется косвенно (по
   * росту спайков), и проверка проходит даже когда стимул не снят.
   */
  get spotActive(): boolean {
    return this.spot !== null;
  }

  /**
   * Типичное расстояние до БЛИЖАЙШЕГО нейрона, в мировых единицах.
   *
   * ─── Зачем это нужно ─────────────────────────────────────────────────────
   *
   * Масштаб мира у пресетов РАЗНЫЙ, а радиус стимула задавался прямо в
   * мировых единицах. Измерено: при радиусе 2.5 в решётку волны (шаг 0.98)
   * попадало 16 нейронов, а в разреженную сеть (шаг 1.78) — только 8. То
   * есть один и тот же «радиус» означал разное воздействие, и на основных
   * сетях удар был почти незаметен.
   *
   * ─── Почему не «площадь / число нейронов» ───────────────────────────────
   *
   * Первая версия считала шаг как √(площадь / count) по габаритной рамке.
   * Тест показал, что оценка СИСТЕМАТИЧЕСКИ занижена: у решётки 10×10 с
   * шагом 1 она давала 0.9, потому что рамка занимает (N−1)² клеток, а не
   * N². На диске Ван дер Корпута ошибка противоположная — рамка включает
   * пустые углы, и оценка завышается.
   *
   * Здесь расстояние измеряется НАПРЯМУЮ: у выборки нейронов ищется
   * ближайший сосед, берётся медиана. Это ровно то, что подразумевается под
   * «шагом сетки», и определение работает одинаково для решётки, кольца и
   * диска. Медиана, а не среднее: у краевых нейронов соседей меньше, и
   * среднее «поехало» бы от геометрии границы.
   *
   * ─── Стоимость и кэш ────────────────────────────────────────────────────
   *
   * Перебор — O(выборка · count): при 2500 нейронах и выборке 256 это
   * ~640 тысяч операций. Вызывается оценка на каждое движение кисти, поэтому
   * результат кэшируется. Кэш сбрасывается в сеттере координат: они
   * задаются целым массивом при сборке сцены (`network.x = matrix.x`), и
   * забыть сбросить кэш было бы легко — а это дало бы радиус от ПРЕДЫДУЩЕЙ
   * сцены.
   */
  neuronSpacing(): number {
    const count = this.params.count;
    if (count <= 1) return 1;
    if (this.spacingCache !== null) return this.spacingCache;

    // Выборка идёт с равномерным шагом по индексам, а не по первым N:
    // порядок нейронов в решётке — построчный, и «первые 256» оказались бы
    // в одном углу, то есть не выборкой, а срезом.
    const sampleSize = Math.min(SPACING_SAMPLE, count);
    const stride = Math.max(1, Math.floor(count / sampleSize));
    const distances: number[] = [];

    for (let s = 0; s < count && distances.length < sampleSize; s += stride) {
      const x = this.x[s];
      const y = this.y[s];
      let best = Infinity;
      for (let j = 0; j < count; j++) {
        if (j === s) continue;
        const dx = this.x[j] - x;
        const dy = this.y[j] - y;
        const squared = dx * dx + dy * dy;
        if (squared < best) best = squared;
      }
      if (Number.isFinite(best)) distances.push(Math.sqrt(best));
    }

    if (distances.length === 0) return 1;
    distances.sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];

    // Вырожденная раскладка (все точки совпали): расстояние 0, и радиус
    // обратился бы в ноль. Единица — безопасное значение по умолчанию.
    this.spacingCache = median > 0 && Number.isFinite(median) ? median : 1;
    return this.spacingCache;
  }

  /**
   * «Удар током»: короткий стимул в пятно вокруг точки.
   *
   * ─── Радиус задаётся в «шагах между нейронами», а не в мировых единицах ──
   *
   * Это принципиально и появилось по измерению. Мировой масштаб у пресетов
   * разный: у волны шаг между нейронами 0.98, у разреженной сети — 1.78.
   * При радиусе, заданном прямо в мировых единицах, одно и то же число
   * означало разное воздействие: измерено, что радиус 2.5 накрывал 16
   * нейронов на волне и 8 в разреженной сети. Пользователь не может этого
   * знать, а «одинаковый на вид удар» обязан действовать одинаково.
   *
   * Теперь `radiusInSpacings` умножается на измеренный `neuronSpacing()`,
   * поэтому радиус 2.5 всюду означает «примерно 19 ближайших нейронов».
   *
   * Амплитуда задаётся в единицах LIF и переводится в единицы модели через
   * `stimulusScale`. Время отсчитывается от ТЕКУЩЕГО момента: удар наносится
   * по живой сети, а не по её началу.
   */
  poke(x: number, y: number, radiusInSpacings: number, amplitudeLifUnits: number, durationMs: number): void {
    const spacing = this.neuronSpacing();
    this.setSpot({
      x,
      y,
      radius: Math.max(0.5, radiusInSpacings) * spacing,
      amplitude: amplitudeLifUnits * this.stimulusScale,
      untilMs: this.state.time + Math.max(0.1, durationMs),
    });
  }

  /** Радиус последнего удара в мировых единицах (для отрисовки кольца). */
  pokeRadiusWorld(radiusInSpacings: number): number {
    return Math.max(0.5, radiusInSpacings) * this.neuronSpacing();
  }

  /**
   * Множитель веса связей.
   *
   * ─── Зачем множитель, а не правка весов ────────────────────────────────
   *
   * Веса заданы топологией (у волны 200, у разреженной сети 0.15) и
   * РАЗЛИЧАЮТСЯ на порядки. Ползунок «вес связей», который писал бы число
   * прямо в матрицу, был бы бесполезен: одно значение не подходит разным
   * сценам. Множитель же означает одно и то же везде — «во сколько раз
   * усилить то, что есть».
   *
   * ─── Почему базовые веса хранятся отдельно ─────────────────────────────
   *
   * Без этого повторное применение ползунка УМНОЖАЛО бы уже умноженное:
   * провели три раза — получили куб. Поэтому при сборке сцены копия
   * исходных весов сохраняется, а ползунок всегда считает от неё.
   */
  setWeightScale(scale: number): void {
    if (this.baseWeights === null) this.baseWeights = Float64Array.from(this.synapses.weight);
    const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const base = this.baseWeights;
    for (let s = 0; s < this.synapses.weight.length; s++) {
      this.synapses.weight[s] = base[s] * factor;
    }
    this.weightScale = factor;
  }

  /** Текущий множитель веса. */
  get currentWeightScale(): number {
    return this.weightScale;
  }

  /**
   * Доля тормозных нейронов, ЗАДАННАЯ пресетом (до правок игрока).
   *
   * Хранится отдельно от `params.inhibitoryFraction`, потому что тот
   * меняется при движении ползунка. Уровню «Своя сеть» нужно сравнивать
   * текущее значение именно с ИСХОДНЫМ: иначе условие «сеть изменена»
   * невозможно было бы выполнить — оно сравнивало бы значение с самим
   * собой и всегда давало бы ноль.
   */
  readonly presetInhibitoryFraction: number;

  /**
   * Доля тормозных нейронов.
   *
   * Меняет ЗНАК весов исходящих связей: по соглашению проекта тормозные —
   * это «хвост» массива (`initNeurons`), и их вес отрицателен. Сама матрица
   * связей при этом не перестраивается — меняется только знак, что дёшево и
   * не теряет топологию.
   */
  setInhibitoryFraction(fraction: number): void {
    const clamped = Math.min(0.9, Math.max(0, fraction));
    if (this.baseWeights === null) this.baseWeights = Float64Array.from(this.synapses.weight);

    const count = this.params.count;
    const inhibitoryCount = Math.round(count * clamped);
    const firstInhibitory = count - inhibitoryCount;

    for (let i = 0; i < count; i++) {
      const isInhibitory = i >= firstInhibitory;
      // Знак берётся по ИСХОДНОЙ величине связи, а множитель веса
      // применяется сверху: иначе смена торможения затирала бы ползунок веса.
      const begin = this.synapses.rowPtr[i];
      const end = this.synapses.rowPtr[i + 1];
      for (let s = begin; s < end; s++) {
        const magnitude = Math.abs(this.baseWeights[s]) * this.weightScale;
        this.synapses.weight[s] = isInhibitory ? -magnitude * INHIBITORY_RATIO : magnitude;
      }
      this.state.inhibitory[i] = isInhibitory ? 1 : 0;
    }
    this.params.inhibitoryFraction = clamped;
  }

  /** Прямая инъекция тока в один нейрон на время. */
  inject(index: number, amplitude: number, durationMs: number): void {
    if (index < 0 || index >= this.params.count) return;
    this.injections.push({ index, amplitude, untilMs: this.state.time + durationMs });
  }

  /** Внешний вход: постоянный ток или пуассоновский поток. */
  private externalCurrent(): void {
    const input = this.params.input;
    this.external.fill(0);
    if (input.mode === 'none') return;

    const targetCount = Math.round(this.params.count * input.fraction);
    if (input.mode === 'const') {
      for (let i = 0; i < targetCount; i++) this.external[i] = input.amplitude;
      return;
    }

    // Пуассоновский поток: на каждом шаге решаем, сколько событий пришло.
    // Частота событий на нейрон — `rate` Гц, то есть в среднем
    // rate·dt/1000 событий за шаг. Каждое событие добавляет `weight` тока.
    const lambda = (input.rate * this.params.dt) / 1000;
    for (let i = 0; i < targetCount; i++) {
      const events = this.rng.poisson(lambda);
      if (events > 0) this.external[i] = events * input.weight;
    }
  }

  /** Пространственный стимул и прямые инъекции. */
  private stimulusCurrent(): void {
    const time = this.state.time;
    if (this.spot) {
      if (time > this.spot.untilMs) {
        this.spot = null;
      } else {
        const { x, y, radius, amplitude } = this.spot;
        const radiusSquared = radius * radius;
        for (let i = 0; i < this.params.count; i++) {
          const dx = this.x[i] - x;
          const dy = this.y[i] - y;
          if (dx * dx + dy * dy <= radiusSquared) this.incoming[i] += amplitude;
        }
      }
    }
    if (this.injections.length > 0) {
      this.injections = this.injections.filter((item) => {
        if (time > item.untilMs) return false;
        this.incoming[item.index] += item.amplitude;
        return true;
      });
    }
  }

  /**
   * Один шаг симуляции.
   *
   * Возвращает число спайков на этом шаге — это дешёвый способ узнать
   * «что-то произошло», не разбирая буфер.
   */
  step(): number {
    const dt = Math.min(this.params.dt, MAX_DT);
    // Время в начале шага. Нужно следу импульсов: доставка происходит в
    // начале шага `шаг + delaySteps`, и чтобы нарисованный приход совпал с
    // настоящим, отсчитывать надо от НАЧАЛА шага, а не от его конца
    // (`state.time` увеличится в конце, см. `stepNeurons`).
    const stateTimeAtStepStart = this.state.time;

    // 1. Входящий ток из буфера задержек.
    //
    // Пришедшие спайки складываются в ПРОВОДИМОСТЬ (затухающий
    // синаптический ток), а не прибавляются к току на один шаг: именно
    // суммирование вкладов за время τ_syn позволяет рекуррентной сети
    // поддерживать активность. См. `SynapticConductance`.
    const arrived = this.delays.beginStep();
    for (let i = 0; i < this.params.count; i++) {
      const amount = arrived[i];
      if (amount !== 0) this.conductance.g[i] += amount;
    }
    this.delays.endStep();
    this.conductance.decay();

    // Входной ток нейрона — это его проводимость.
    this.incoming.set(this.conductance.g);

    // 2. Внешний вход и стимулы.
    this.externalCurrent();
    for (let i = 0; i < this.params.count; i++) {
      this.incoming[i] += this.external[i];
    }
    this.stimulusCurrent();

    // 3. Шаг нейронов.
    stepNeurons(this.state, this.params.neuron, this.incoming, dt, this.spikeBuffer, {
      useRefractory: this.params.useRefractory,
    });

    // 4. Рассылка спайков с их задержками и обучение STDP.
    //
    // Масштаб переводит вес в единицы тока конкретной модели нейрона.
    // Множитель dt/τ_syn нормирует ВПСТ: без него амплитуда одного
    // синаптического события зависела бы от шага интегрирования (при
    // уменьшении dt вдвое она падала бы вдвое), и «сила связи» переставала
    // быть свойством связи. С нормировкой площадь ВПСТ равна весу
    // независимо от dt.
    const modelScale = this.params.neuron.model === 'lif' ? 1 : LIF_EQUIVALENT_SCALE;
    const synapticScale = modelScale * (dt / Math.max(1e-6, this.params.synapticTau));
    if (this.stdp.enabled) {
      // Затухание следов — ДО обработки спайков шага: тогда след, оставленный
      // спайком прошлого шага, успевает «постареть» ровно на dt.
      this.traces.decay(this.traceXDecay, this.traceYDecay);

      // Порядок обработки фиксирован: сначала пре-спайки (депрессия по
      // следам пост-спайков), затем пост-спайки (потенциация по следам
      // пре-спайков). Это описано в NEXT-SESSION как инвариант: если
      // поменять порядок, пары одного такта учтутся с неверным знаком.
      for (let k = 0; k < this.spikeBuffer.count; k++) {
        const index = this.spikeBuffer.index[k];
        depressOutgoing(this.synapses, this.traces, index, this.stdp);
        this.traces.onPreSpike(index);
      }
      // Пост-спайк — это тот же спайк: он и пре для своих исходящих,
      // и пост для своих входящих. Поэтому второй проход.
      for (let k = 0; k < this.spikeBuffer.count; k++) {
        const index = this.spikeBuffer.index[k];
        this.traces.onPostSpike(index);
        potentiateIncoming(this.synapses, this.traces, index, this.stdp);
      }
    }

    for (let k = 0; k < this.spikeBuffer.count; k++) {
      const index = this.spikeBuffer.index[k];
      this.delays.schedule(index, this.synapses, synapticScale);

      // Запись следа — РЯДОМ с рассылкой, по тем же данным. Считается по
      // фактическому слоту буфера задержек, поэтому нарисованный приход не
      // может разойтись с настоящим: источник истины один.
      if (this.pulseTraceEnabled) {
        this.pulses.recordFrom(
          index,
          this.synapses.rowPtr,
          this.synapses.colIdx,
          this.synapses.weight,
          this.synapses.delaySteps,
          dt,
          this.spikeBuffer.time[k],
          stateTimeAtStepStart,
        );
      }
    }

    // 5. Метрики.
    const spikes = this.spikeBuffer.count;
    this.synchrony.add(this.state.time, spikes, dt);
    // История спайков: нужна растровой диаграмме и проверкам уровней.
    // Ведётся ЗДЕСЬ, а не в рендере, потому что те же данные нужны ядру.
    this.spikeHistory.addBatch(this.spikeBuffer);
    const rate = populationRate(this.state, this.state.time || dt);
    this.rateHistory.maybeAdd(this.state.time, rate);

    return spikes;
  }

  /** Продвинуть сеть на `count` шагов. */
  run(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  /** Текущее значение синхронности (NaN, если спайков ещё не было). */
  synchronyValue(): number {
    return this.synchrony.value();
  }

  /** Сколько спайков попало в бины синхронности. */
  get synchronySpikes(): number {
    return this.synchrony.spikeCount;
  }

  /** История средней частоты для спектра. */
  rateSeries(): number[] {
    return this.rateHistory.ordered();
  }

  /** Шаг дискретизации истории частоты, мс. */
  get rateSampleMs(): number {
    return this.rateHistory.sampleEveryMs;
  }

  /** Добавить замер в историю графиков. */
  recordSample(): NetworkSample {
    const windowMs = Math.max(1, this.state.time);
    const sample: NetworkSample = {
      timeMs: this.state.time,
      rate: populationRate(this.state, windowMs),
      activeRate: activeRateOf(this.state, windowMs),
      activeFraction: activeFractionOf(this.state),
      cv: cvOf(this.state),
      synchrony: this.synchrony.value(),
    };
    this.history.push(sample);
    if (this.history.length > HISTORY_CAPACITY) this.history.shift();
    return sample;
  }

  /** История замеров. */
  get samples(): readonly NetworkSample[] {
    return this.history;
  }

  /** Счётчики спайков по нейронам (для раскраски и метрик). */
  spikeCounts(): Uint32Array {
    return this.state.spikeCount;
  }
}

/**
 * Масштаб для перевода весов в ток Izhikevich.
 *
 * У LIF единица тока — наноампер (пороговый ток ≈ 1.5), у Izhikevich —
 * единицы самого уравнения (типичные токи 1…20). Чтобы ОДНИ И ТЕ ЖЕ веса
 * давали сопоставимый эффект в обеих моделях, веса умножаются на этот
 * множитель при модели Izhikevich. Иначе переключение модели молча меняло
 * бы силу связей в десять раз.
 */
export const LIF_EQUIVALENT_SCALE = 8;

/** Пустая матрица связей — мир без синапсов (одиночный нейрон). */
export function emptyMatrix(count: number): SynapseMatrix {
  return buildSynapses(count, new Int32Array(0), new Int32Array(0), new Float64Array(0), new Int32Array(0));
}

// Импорты метрик — в шапке файла, рядом с остальными: держать `import`
// в середине модуля нельзя, он поднимается в начало и читается как ошибка.

/** Режим внешнего входа по умолчанию для интерфейса. */
export function defaultInputMode(): InputMode {
  return DEFAULT_NETWORK_PARAMS.input.mode;
}

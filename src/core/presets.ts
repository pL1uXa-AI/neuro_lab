/**
 * Пресеты — сцены проекта как данные.
 *
 * Пресет фиксирует ВСЮ конфигурацию целиком: нейрон, топологию, вход, веса
 * и стимул. Слайдеры удобны, но воспроизвести «то, что было на картинке в
 * README» по памяти невозможно — а витринные кадры и уровни кампании
 * обязаны воспроизводиться.
 *
 * ─── Откуда взялись числа ────────────────────────────────────────────────
 *
 * Ни одно значение здесь не выставлено «на глаз»: веса, плотности и
 * амплитуды подобраны ИЗМЕРЕНИЯМИ (см. docs/NEXT-SESSION.md, дефекты 17–20),
 * и в комментариях указано, что именно было измерено. Если правишь
 * параметры — прогони пресет и сверься с подсказкой `hint`: расхождение
 * между обещанием и фактом считается дефектом документации.
 */

import type { InputParams, NeuronModelKind, NetworkParams } from './types.js';
import { DEFAULT_NETWORK_PARAMS } from './types.js';
import { IZHI_MODES, modeToParams } from './neuron-types.js';

/** Какая топология строится для сцены. */
export type TopologyKind =
  /** Разреженная случайная: базовая сеть, E/I-баланс. */
  | 'random-sparse'
  /** Слоистая с рекуррентным скрытым слоем: рабочая память. */
  | 'layers'
  /** Пространственная решётка: волны. */
  | 'grid'
  /** Кольцо: ритмы и бегущая волна по кругу. */
  | 'ring'
  /** Без связей: одиночный нейрон. */
  | 'none';

/** Параметры топологии пресета. */
export interface PresetTopology {
  kind: TopologyKind;
  /** Вероятность связи. */
  connectionProbability?: number;
  /** Вес возбуждающей связи. */
  excitatoryWeight?: number;
  /** Отношение тормозного веса к возбуждающему. */
  inhibitoryRatio?: number;
  /** Размер стороны решётки (для 'grid'). */
  side?: number;
  /** Радиус связи в клетках (для 'grid'). */
  radius?: number;
  /** Скорость проведения, клеток за мс (для 'grid'). */
  speed?: number;
  /** Размеры слоёв (для 'layers'). */
  layers?: number[];
  /** Рекуррентные связи внутри скрытого слоя (для 'layers'). */
  recurrentHidden?: boolean;
  /** Сколько соседей вперёд по кольцу (для 'ring'). */
  span?: number;
}

/** Сцена проекта. */
export interface Preset {
  id: string;
  title: string;
  /** Одна строка: что должно быть видно. */
  hint: string;
  /** Модель нейрона. */
  model: NeuronModelKind;
  /** Идентификатор режима Izhikevich (для одиночных сцен). */
  modeId?: string;
  /** Число нейронов. */
  count: number;
  inhibitoryFraction: number;
  dt: number;
  delay: number;
  delayJitter: number;
  synapticTau: number;
  input: InputParams;
  topology: PresetTopology;
  /** Включён ли STDP в этой сцене. */
  stdp: boolean;
  /**
   * Границы весов для STDP этой сцены.
   *
   * ─── Почему границы нельзя задавать одной константой на проект ───────────
   *
   * `DEFAULT_STDP.wMax = 1` — АБСОЛЮТНОЕ число, а базовые веса пресетов
   * различаются на порядки: 0.15 у разреженной сети, 200 у волны. Измерено,
   * что при включённом STDP на пресете «Волна» веса связей обрезались с
   * 22…178 до **0.76…1.00**, то есть сеть разрушалась: число спайков за
   * 100 мс падало с 118 016 до 31 584, а 5611 связей упирались ровно в 1.
   *
   * Обратный случай не менее важен: для сети с базовым весом 0.15 потолок 1
   * ФУНКЦИОНАЛЬНО недостижим. Измерено: отклик читающего слоя в этих сетях
   * начинается около веса 6, поэтому обучение могло крутить веса
   * бесконечно (1 200 000 обновлений) и не менять поведение НИКОГДА.
   *
   * Поэтому границы задаются там, где известен масштаб весов, — в пресете.
   * Если поле не задано, берутся значения по умолчанию.
   */
  stdpBounds?: { min: number; max: number };
  /**
   * Режим раскраски, при котором сцена читается лучше всего.
   *
   * Часть описания сцены, а не настройка интерфейса: у волны надо видеть
   * вспышки, у сети в покое — кто разряжается чаще. Пользователь может
   * переключить раскраску, но по умолчанию сцена должна открываться в том
   * виде, в котором она что-то показывает.
   */
  colorMode: 'potential' | 'spike' | 'type' | 'rate';
  /**
   * Стимул, запускаемый вместе с пресетом: пятно или инъекция.
   * Пространственные сцены без стартового толчка просто молчат.
   */
  starter?: {
    kind: 'spot' | 'inject';
    /** Для пятна: координаты и радиус; для инъекции — доля нейронов. */
    radius?: number;
    amplitude: number;
    durationMs: number;
    /** Доля нейронов для инъекции (0…1). */
    fraction?: number;
  };
  /** Сколько миллисекунд «прогреть» сцену перед показом. */
  warmupMs: number;
}

/**
 * Пресеты проекта.
 *
 * Порядок = порядок кнопок в интерфейсе: от простого к сложному, как в
 * phys-lab и logic-lab.
 */
export const PRESETS: Preset[] = [
  {
    id: 'single-lif',
    title: 'Один нейрон (LIF)',
    hint:
      'Постоянный ток 1.6 нА чуть выше порога: спайки идут ровным рядом, ' +
      'осциллограф показывает пилу мембранного потенциала',
    model: 'lif',
    count: 1,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'const', amplitude: 1.7, rate: 0, weight: 0, fraction: 1 },
    topology: { kind: 'none' },
    stdp: false,
    colorMode: 'potential',
    warmupMs: 0,
  },
  {
    id: 'single-rs',
    title: 'Один нейрон (Izhikevich RS)',
    hint:
      'Regular spiking: частота спайков падает со временем — работает ' +
      'переменная восстановления u',
    model: 'izhikevich',
    modeId: 'rs',
    count: 1,
    inhibitoryFraction: 0,
    dt: 0.1,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'const', amplitude: 10, rate: 0, weight: 0, fraction: 1 },
    topology: { kind: 'none' },
    stdp: false,
    colorMode: 'potential',
    warmupMs: 0,
  },
  {
    id: 'single-bursting',
    title: 'Один нейрон (пачки)',
    hint: 'Тонические пачки: группы из 2–3 спайков с паузами между ними',
    model: 'izhikevich',
    modeId: 'tonic-bursting',
    count: 1,
    inhibitoryFraction: 0,
    dt: 0.1,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'const', amplitude: 15, rate: 0, weight: 0, fraction: 1 },
    topology: { kind: 'none' },
    stdp: false,
    colorMode: 'potential',
    warmupMs: 0,
  },
  {
    id: 'random-sparse',
    title: 'Разреженная сеть',
    hint:
      'Баланс возбуждения и торможения: нейроны разряжаются нерегулярно ' +
      '(CV ISI ≈ 0.6), общего ритма нет — так выглядит кора в покое',
    model: 'lif',
    count: 800,
    inhibitoryFraction: 0.2,
    dt: 0.5,
    delay: 2,
    delayJitter: 0.5,
    synapticTau: 5,
    // Измерено: при rate = 200 Гц и весе события 8 мА сеть живёт
    // (980 спайков за 2 с на 200 нейронах) с CV = 0.642. Пуассоновский
    // вход — единственный способ получить нерегулярный режим: постоянный
    // ток даёт CV = 0.000.
    input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 8, fraction: 1 },
    topology: {
      kind: 'random-sparse',
      connectionProbability: 0.1,
      excitatoryWeight: 0.15,
      inhibitoryRatio: 5,
    },
    stdp: false,
    colorMode: 'rate',
    warmupMs: 1000,
  },
  {
    id: 'stdp-learning',
    title: 'Обучение STDP',
    hint:
      'Связи усиливаются и ослабляются в реальном времени: за секунды ' +
      'распределение весов из точки превращается в широкий спектр',
    model: 'lif',
    count: 500,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 2,
    delayJitter: 0.5,
    synapticTau: 5,
    // Торможение выключено: STDP обучает только возбуждающие связи, и с
    // тормозными клетками картина весов читалась бы хуже.
    input: { mode: 'poisson', amplitude: 0, rate: 300, weight: 8, fraction: 1 },
    topology: {
      kind: 'random-sparse',
      connectionProbability: 0.1,
      excitatoryWeight: 0.15,
      inhibitoryRatio: 5,
    },
    stdp: true,
    colorMode: 'potential',
    warmupMs: 2000,
  },
  {
    id: 'wave',
    title: 'Волна активности',
    hint:
      'Толчок в центр запускает волну, которая бежит к краю со скоростью ' +
      '≈3.7 клетки за мс — ровно той, что задана задержками',
    model: 'lif',
    count: 2500,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 1,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    topology: {
      kind: 'grid',
      side: 50,
      radius: 8,
      speed: 4,
      // Измерено: вес 200 даёт наклон 3.73 при заданной скорости 4, а
      // вес 20 — только 1.59. При весе ниже ≈50 волна вообще затухает.
      excitatoryWeight: 200,
      connectionProbability: 0.6,
    },
    // Границы STDP заданы по масштабу ЭТОЙ сцены, хотя STDP здесь обычно
    // выключен. Без них включение обучения обрезало бы веса 22…178 до
    // диапазона 0…1: измерено падение спайков за 100 мс с 118 016 до
    // 31 584, то есть волна перестала бы распространяться.
    stdpBounds: { min: 0, max: 400 },
    stdp: false,
    colorMode: 'spike',
    starter: { kind: 'spot', radius: 3, amplitude: 40, durationMs: 20 },
    warmupMs: 0,
  },
  {
    id: 'working-memory',
    title: 'Рабочая память',
    hint:
      'Короткий стимул — и активность держится: рекуррентная сеть ' +
      'удерживает спайки после того, как вход исчез. Убери связи до 0.6 — ' +
      'и память пропадёт',
    model: 'lif',
    count: 200,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    topology: {
      kind: 'layers',
      layers: [40, 160],
      // Измерено: порог удержания лежит между p = 0.6 (гаснет за 100 мс)
      // и p = 0.7 (держится неограниченно, счётчик стабилизируется ровно
      // на 735 спайках). В пресете стоит 0.7 — выше порога, с запасом.
      connectionProbability: 0.7,
      excitatoryWeight: 400,
      recurrentHidden: true,
    },
    stdp: false,
    colorMode: 'spike',
    starter: { kind: 'inject', fraction: 0.2, amplitude: 3.0, durationMs: 20 },
    warmupMs: 0,
  },
  {
    id: 'supervised-learning',
    title: 'Опыт: обучение с учителем',
    hint:
      'Классический опыт STDP: сеть предъявляют паттерн A, затем «учитель» ' +
      'заставляет выход сработать. После обучения сеть отвечает на A сильнее, ' +
      'чем на необученный B — это и видно на панели «Опыт»',
    model: 'lif',
    count: 80,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    topology: {
      kind: 'layers',
      // 40 входов → 40 читающих. Первая половина стимулируется как паттерн,
      // вторая — «учитель», который заставляет выход сработать.
      layers: [40, 40],
      connectionProbability: 0.7,
      // ─── Почему вес именно 1.5 ──────────────────────────────────────────
      //
      // Измерено (30 эпох, паттерн 20 входов, пауза отдыха 120 мс):
      //   вес 1.0 → после обучения отклик на A = 0,  разделение 0;
      //   вес 1.5 → отклик A 40 → 120, разделение 80, в контроле 0.
      //
      // При весе 1.0 обучение поднимает средний вес до 2.53, но этого ВСЁ
      // ЕЩЁ мало: функциональный порог отклика лежит выше 2.5. Поэтому
      // стартовое значение выбрано так, чтобы обучение переводило сеть
      // ЧЕРЕЗ порог, а не подводило к нему вплотную.
      excitatoryWeight: 1.5,
      inhibitoryRatio: 4,
    },
    stdp: true,
    // Границы подняты до функционального порога: см. комментарий к
    // `stdpBounds` в интерфейсе `Preset`. При wMax = 1 (значение по
    // умолчанию) этот опыт не работает вообще — измерено 0 отклика после
    // 40 эпох обучения.
    stdpBounds: { min: 0, max: 8 },
    colorMode: 'rate',
    warmupMs: 0,
  },
  {
    id: 'ring',
    title: 'Кольцо',
    hint:
      'Волна бежит по кольцу и, вернувшись, запускает следующий круг: ' +
      'простейший генератор ритма, прообраз центрального генератора',
    model: 'lif',
    count: 200,
    inhibitoryFraction: 0,
    dt: 0.5,
    delay: 2,
    delayJitter: 0,
    synapticTau: 5,
    input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    topology: {
      kind: 'ring',
      // ─── span 1, вес 200, торможение 0 выбраны ИЗМЕРЕНИЕМ ───────────────
      //
      // При этих значениях кольцо работает как генератор: измерено
      // 13 300 спайков за первую секунду и 191 084 за пять, все 200
      // нейронов разряжаются многократно (у #0 около 940 спайков).
      //
      // Что было НЕ так в первой версии (span 3, вес 40, торможение 20 %):
      // волна обегала кольцо РОВНО ОДИН раз и гасла навсегда. Измерено по
      // окнам 50 мс: 28 11 11 11 12 11 … 11 4 0 0 0 0 0 — то есть подсказка
      // обещала «генератор ритма», а пресет показывал одноразовый толчок.
      //
      // ─── Что именно обрывало петлю: проверено разложением ───────────────
      //
      // Параметры и стартовый стимул менялись ПО ОТДЕЛЬНОСТИ:
      //   старые параметры + старый стимул: прирост 0     — мёртвое
      //   новые параметры + старый стимул: прирост 178 013 — живое
      //   старые параметры + новый стимул: прирост 888     — мёртвое
      // Значит дело в ПАРАМЕТРАХ, а не в стимуле, и главный из них —
      // ТОРМОЖЕНИЕ. При доле тормозных 20 % вернувшаяся волна попадала в
      // заторможенную область и обрывалась; при 0 % петля замыкается.
      // Вклад веса и span — вспомогательный (вес 40 не запускает волну
      // вовсе: срабатывают 2 нейрона из 200).
      span: 1,
      excitatoryWeight: 200,
      inhibitoryRatio: 4,
      connectionProbability: 1,
    },
    stdp: false,
    colorMode: 'spike',
    starter: { kind: 'inject', fraction: 0.05, amplitude: 60, durationMs: 1 },
    warmupMs: 0,
  },
];

/** Пресет по идентификатору. */
export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * Параметры «своей сети» — то, что пользователь задаёт сам.
 *
 * ─── Почему это не ползунки поверх пресета ───────────────────────────────
 *
 * Панель «Сеть» (вес, торможение, вход) правит УЖЕ СОБРАННУЮ сцену: она
 * меняет числа связей, но не структуру. Собрать сеть — значит выбрать и
 * СТРУКТУРУ: сколько нейронов, как они соединены, с какой плотностью.
 * Поэтому здесь строится новый пресет целиком, а не подкручивается старый.
 *
 * ─── Чем это отличается от пресетов в `PRESETS` ─────────────────────────
 *
 * Пресеты — ИЗМЕРЕННЫЕ конфигурации с проверенными подсказками. «Своя сеть»
 * ничего не обещает: она честно собирает то, что задал пользователь, и
 * показывает, что получилось. Обещать явления здесь нельзя — при
 * произвольных числах их может и не быть.
 */
export interface CustomNetworkOptions {
  /** Число нейронов. */
  count: number;
  /** Топология: как нейроны соединены. */
  topology: 'random-sparse' | 'ring' | 'layers' | 'grid';
  /** Доля тормозных нейронов, 0…0.5. */
  inhibitoryFraction: number;
  /** Доля существующих связей, 0…1. */
  connectionProbability: number;
  /** Вес возбуждающей связи. */
  excitatoryWeight: number;
  /** Во сколько раз тормозной вес больше возбуждающего. */
  inhibitoryRatio: number;
  /** Частота пуассоновского фонового входа, Гц (0 — без входа). */
  inputRate: number;
  /** Включено ли обучение. */
  stdp: boolean;
}

/** Значения по умолчанию для «своей сети». */
export const DEFAULT_CUSTOM: CustomNetworkOptions = {
  count: 400,
  topology: 'random-sparse',
  inhibitoryFraction: 0.2,
  connectionProbability: 0.1,
  excitatoryWeight: 0.5,
  inhibitoryRatio: 5,
  inputRate: 300,
  stdp: false,
};

/** Описание топологии для интерфейса. */
export const CUSTOM_TOPOLOGIES: ReadonlyArray<{
  id: CustomNetworkOptions['topology'];
  label: string;
  hint: string;
}> = [
  { id: 'random-sparse', label: 'Случайная', hint: 'Каждая пара связана с заданной вероятностью' },
  { id: 'layers', label: 'Слоистая', hint: 'Вход → скрытый слой; годится для опыта обучения' },
  { id: 'ring', label: 'Кольцо', hint: 'Цикл: нейрон связан со следующими по кругу' },
  { id: 'grid', label: 'Решётка', hint: 'Пространственная сетка; задержка растёт с расстоянием' },
];

/**
 * Собрать пресет «своей сети» из параметров пользователя.
 *
 * Числа нормируются в допустимые диапазоны: ползунок может дать что угодно,
 * а топология с нулевой вероятностью связи или нулевым числом нейронов
 * уронила бы сборку сцены.
 */
export function customPreset(options: CustomNetworkOptions): Preset {
  const count = Math.max(2, Math.round(options.count));
  const probability = Math.min(1, Math.max(0.005, options.connectionProbability));
  const inhibitory = Math.min(0.5, Math.max(0, options.inhibitoryFraction));
  const weight = Math.max(0.01, options.excitatoryWeight);
  const ratio = Math.max(1, options.inhibitoryRatio);

  const topology: PresetTopology = { kind: options.topology };
  if (options.topology === 'random-sparse' || options.topology === 'layers') {
    topology.connectionProbability = probability;
    topology.excitatoryWeight = weight;
    topology.inhibitoryRatio = ratio;
    if (options.topology === 'layers') {
      // ─── Почему [вход, скрытый], а не [вход, count] ─────────────────────
      //
      // `layeredTopology` трактует `layers` как РАЗМЕРЫ слоёв и раскладывает
      // их подряд от нуля. Значит сумма обязана равняться числу нейронов —
      // иначе индексы целей выходят за границу массива.
      //
      // Измерено на первой версии, где стояло `[count / 4, count]`: при
      // count = 400 получались границы [0,100) и [100,500), то есть связи
      // вели на нейроны 400…499, которых в сети нет. В типизированном
      // массиве это молча писалось мимо (или терялось), и сеть выглядела
      // рабочей.
      //
      // Входная группа — четверть сети, скрытый слой — остальное.
      const input = Math.max(1, Math.round(count / 4));
      topology.layers = [input, count - input];
    }
  } else if (options.topology === 'ring') {
    topology.connectionProbability = 1;
    topology.excitatoryWeight = weight;
    topology.inhibitoryRatio = ratio;
    topology.span = 1;
  } else {
    // Решётка: сторона выводится из числа нейронов, скорость проведения и
    // радиус связи — те же, что у измеренного пресета «Волна».
    const side = Math.max(2, Math.round(Math.sqrt(count)));
    topology.side = side;
    topology.radius = 8;
    topology.speed = 4;
    topology.connectionProbability = Math.max(0.2, probability);
    topology.excitatoryWeight = weight;
    topology.inhibitoryRatio = ratio;
  }

  return {
    id: 'custom',
    title: 'Своя сеть',
    hint: 'Сеть, собранная вашими параметрами: структура, плотность и веса — ваши',
    model: 'lif',
    count,
    inhibitoryFraction: inhibitory,
    dt: 0.5,
    delay: 2,
    delayJitter: 0.5,
    synapticTau: 5,
    input:
      options.inputRate > 0
        ? { mode: 'poisson', amplitude: 0, rate: options.inputRate, weight: 8, fraction: 1 }
        : { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
    topology,
    stdp: options.stdp,
    // Границы STDP берутся по масштабу СОБРАННОЙ сети: потолок не ниже
    // удвоенного начального веса, иначе обучение обрезало бы связи до
    // значения, которое пользователь не задавал.
    ...(options.stdp ? { stdpBounds: { min: 0, max: weight * 8 } } : {}),
    colorMode: options.topology === 'grid' ? 'spike' : 'rate',
    warmupMs: 200,
  };
}

/**
 * Параметры сети из пресета.
 *
 * Отдельная функция нужна потому, что `NetworkParams` и `Preset` — разные
 * сущности: пресет описывает СЦЕНУ (включая топологию и стартовый стимул),
 * а параметры сети — только то, что нужно ядру.
 */
export function presetToNetworkParams(preset: Preset): NetworkParams {
  const base: NetworkParams = {
    ...DEFAULT_NETWORK_PARAMS,
    count: preset.count,
    inhibitoryFraction: preset.inhibitoryFraction,
    dt: preset.dt,
    delay: preset.delay,
    delayJitter: preset.delayJitter,
    synapticTau: preset.synapticTau,
    input: preset.input,
    seed: 1,
    useRefractory: true,
    // Соотношение тормозного и возбуждающего веса берётся из ТОПОЛОГИИ
    // пресета, а не из умолчания: у сетей оно разное (5 у разреженной, 4 у
    // кольца). Сеть «на живу» использует его, когда восстанавливает веса
    // после правки доли торможения.
    inhibitoryRatio: preset.topology.inhibitoryRatio ?? DEFAULT_NETWORK_PARAMS.inhibitoryRatio,
  };

  if (preset.model === 'lif') {
    return {
      ...base,
      neuron: { ...DEFAULT_NETWORK_PARAMS.neuron, model: 'lif' },
    };
  }

  // Для Izhikevich берём параметры режима из каталога ВМЕСТЕ с его точкой
  // покоя: `modeToParams` считает истинное равновесие для конкретного `b`
  // (см. `izhRestState`), а не подставляет «характерное» −65. Именно на
  // этом уже спотыкались: см. дефект 12 в docs/NEXT-SESSION.md.
  const mode = IZHI_MODES.find((item) => item.id === preset.modeId);
  if (!mode) {
    return { ...base, neuron: { ...DEFAULT_NETWORK_PARAMS.neuron, model: 'izhikevich' } };
  }
  return {
    ...base,
    neuron: {
      ...DEFAULT_NETWORK_PARAMS.neuron,
      model: 'izhikevich',
      izh: modeToParams(mode),
    },
  };
}

/**
 * STDP — обучение по времени спайков (spike-timing-dependent plasticity).
 *
 * ─── Правило ─────────────────────────────────────────────────────────────
 *
 * Вес связи усиливается, если пре-спайк пришёл НЕЗАДОЛГО ДО пост-спайка,
 * и ослабляется, если после. Окно обучения (Gerstner и соавторы):
 *
 *     W(Δt) = +A₊ · exp(−Δt/τ₊)   при Δt > 0   (пре раньше пост — LTP)
 *     W(Δt) = −A₋ · exp( Δt/τ₋)   при Δt < 0   (пост раньше пре — LTD)
 *
 * где Δt = t_пост − t_пре.
 *
 * ─── Онлайн-реализация через следы ───────────────────────────────────────
 *
 * Считать пары спайков постфактум нельзя: пришлось бы хранить историю всех
 * спайков и обходить её на каждом событии. Вместо этого каждый нейрон
 * оставляет «след», который затухает экспоненциально:
 *
 *     при пре-спайке:  w += A₊ · y     (y — след пост-спайков)
 *     при пост-спайке: w −= A₋ · x     (x — след пре-спайков)
 *
 * где x и y затухают с постоянными τ₊ и τ₋. Это ровно то, что описано в
 * Scholarpedia (STDP, раздел «Online implementation»), и математически
 * эквивалентно суммированию по всем парам.
 *
 * ─── Константы ───────────────────────────────────────────────────────────
 *
 * A₊ = 0.01, A₋ = 0.012, τ = 20 мс — набор из работы Song, Miller & Abbott
 * (Nature Neuroscience, 2000), посвящённой конкурентному обучению по STDP.
 * Существенно, что **A₋ > A₊**: при равных амплитудах и одинаковых τ
 * интеграл окна равен нулю, и сеть не имеет предпочтения — тогда связи
 * «дрейфуют». Отрицательный интеграл окна (депрессия чуть сильнее) даёт
 * устойчивость: редкие случайные совпадения не разгоняют сеть.
 *
 * ─── Границы весов ───────────────────────────────────────────────────────
 *
 * Аддитивное STDP без границ уходит в насыщение: вес либо растёт до
 * бесконечности, либо падает ниже нуля и меняет знак синапса (тормозной
 * становится возбуждающим — грубая биологическая ошибка). Поэтому границы
 * обязательны, и есть два режима:
 *
 *   • «жёсткие» (hard bounds): обновление идёт с постоянной амплитудой,
 *     но результат обрезается по [wMin, wMax]. Даёт сильную конкуренцию
 *     синапсов, но требует границ для устойчивости.
 *   • «мягкие» (soft bounds): амплитуда сама затухает у границ —
 *     A₊(w) = η₊·(wMax − w), A₋(w) = η₋·(w − wMin). Вес подходит к границе
 *     асимптотически и никогда её не пересекает.
 *
 * Оба режима описаны в Scholarpedia (раздел «Weight dependence: hard bounds
 * and soft bounds»); жёсткие — вариант Song и соавторов, мягкие —
 * Kistler & van Hemmen / van Rossum.
 */

import { buildSynapses, type SynapseMatrix } from './synapses.js';

/** Тип границ веса. */
export type StdpBounds = 'hard' | 'soft';

/** Параметры STDP. */
export interface StdpParams {
  enabled: boolean;
  /** Амплитуда потенциации A₊. */
  aPlus: number;
  /** Амплитуда депрессии A₋. Обычно чуть больше A₊. */
  aMinus: number;
  /** Постоянная времени следа пре-спайков τ₊, мс. */
  tauPlus: number;
  /** Постоянная времени следа пост-спайков τ₋, мс. */
  tauMinus: number;
  /** Нижняя граница веса. */
  wMin: number;
  /** Верхняя граница веса. */
  wMax: number;
  /** Режим границ. */
  bounds: StdpBounds;
}

/**
 * Параметры STDP по умолчанию: набор Song, Miller & Abbott (2000).
 *
 * Веса по умолчанию — вне [0, wMax], потому что в проекте часть синапсов
 * ТОРМОЗНЫЕ (отрицательные). STDP применяется только к возбуждающим связям:
 * обучать тормозные по этому правилу было бы биологически неверно, а
 * математически — уводило бы их в ноль. Границы задаются в единицах
 * магнитуды веса и не пересекают ноль.
 */
export const DEFAULT_STDP: StdpParams = {
  enabled: true,
  aPlus: 0.01,
  aMinus: 0.012,
  tauPlus: 20,
  tauMinus: 20,
  wMin: 0,
  wMax: 1,
  bounds: 'hard',
};

/**
 * Следы STDP по нейронам.
 *
 * Отдельный объект, потому что следы — состояние ОБУЧЕНИЯ, а не нейрона:
 * при выключенном STDP их можно не считать вовсе (экономия на горячем пути),
 * и они не входят в сериализацию состояния нейрона.
 */
export class StdpTraces {
  readonly count: number;
  /** След пре-спайков: растёт при спайке, затухает с τ₊. */
  readonly x: Float64Array;
  /** След пост-спайков: растёт при спайке, затухает с τ₋. */
  readonly y: Float64Array;
  /** Сколько обновлений весов сделано — для метрик и проверок. */
  updates = 0;

  constructor(count: number) {
    this.count = count;
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
  }

  /** Затухание следов на шаг dt. */
  decay(xFactor: number, yFactor: number): void {
    for (let i = 0; i < this.count; i++) {
      this.x[i] *= xFactor;
      this.y[i] *= yFactor;
    }
  }

  /** Пре-спайк: след пре-спайков растёт; вес связей к цели обновляется. */
  onPreSpike(index: number): void {
    this.x[index] += 1;
  }

  /** Пост-спайк: след пост-спайков растёт. */
  onPostSpike(index: number): void {
    this.y[index] += 1;
  }

  reset(): void {
    this.x.fill(0);
    this.y.fill(0);
    this.updates = 0;
  }
}

/**
 * Обновить веса входящих связей нейрона в момент ЕГО пост-спайка.
 *
 *     w += A₊ · x_источника
 *
 * Читается след ПРЕ-спайков (`x`) каждого ИСТОЧНИКА — это и есть «как давно
 * приходил пре-спайк». Обновляются только ВОЗБУЖДАЮЩИЕ связи (вес > 0):
 * у тормозных знак противоположен, и «потенциация» по этому правилу сделала
 * бы их сильнее тормозящими, что к правилу отношения не имеет.
 *
 * ─── Здесь была ошибка ───────────────────────────────────────────────────
 *
 * Первая версия читала `traces.y[postIndex]` — след ПОСТ-спайков самого
 * нейрона. Это неверно дважды: во-первых, след пост-спайков только что
 * увеличен самим событием, поэтому вес обновлялся бы по собственной
 * вспышке; во-вторых, терялась зависимость от времени прихода ПРЕ-спайка,
 * то есть правило переставало быть STDP и превращалось в «усилить всё
 * входящее при каждом спайке». Тест «без следа в паре вес не меняется»
 * поймал это сразу: вес рос там, где пары не было.
 *
 * Используется ОБРАТНЫЙ индекс (`colPtr`/`rowIdx`): чтобы найти веса,
 * ведущие К спайкнувшему нейрону, нужен обход входящих связей. Обход
 * исходящих нашёл бы связи ОТ него, то есть ровно противоположные.
 */
export function potentiateIncoming(
  matrix: SynapseMatrix,
  traces: StdpTraces,
  postIndex: number,
  params: StdpParams,
): void {
  for (let s = matrix.colPtr[postIndex]; s < matrix.colPtr[postIndex + 1]; s++) {
    const position = matrix.reverseOf[s];
    const current = matrix.weight[position];
    if (current <= 0) continue;
    const source = matrix.rowIdx[s];
    const preTrace = traces.x[source];
    if (preTrace <= 0) continue;
    const amplitude =
      params.bounds === 'soft' ? params.aPlus * (params.wMax - current) : params.aPlus;
    let next = current + amplitude * preTrace;
    if (next > params.wMax) next = params.wMax;
    if (next < params.wMin) next = params.wMin;
    matrix.weight[position] = next;
    traces.updates += 1;
  }
}

/**
 * Обновить веса исходящих связей нейрона в момент ЕГО пре-спайка.
 *
 *     w −= A₋ · y_цели
 *
 * Читается след ПОСТ-спайков (`y`) каждой ЦЕЛИ — это «спайковала ли цель
 * недавно». Используется ПРЯМОЙ индекс: пре-спайк ослабляет связи ОТ этого
 * нейрона.
 */
export function depressOutgoing(
  matrix: SynapseMatrix,
  traces: StdpTraces,
  preIndex: number,
  params: StdpParams,
): void {
  for (let s = matrix.rowPtr[preIndex]; s < matrix.rowPtr[preIndex + 1]; s++) {
    const target = matrix.colIdx[s];
    const postTrace = traces.y[target];
    if (postTrace <= 0) continue;
    const current = matrix.weight[s];
    if (current <= 0) continue;
    const amplitude =
      params.bounds === 'soft' ? params.aMinus * (current - params.wMin) : params.aMinus;
    let next = current - amplitude * postTrace;
    if (next > params.wMax) next = params.wMax;
    if (next < params.wMin) next = params.wMin;
    matrix.weight[s] = next;
    traces.updates += 1;
  }
}

/**
 * Теоретическое окно обучения W(Δt) — для графиков и тестов.
 *
 * Не участвует в симуляции (обучение идёт через следы), но нужно, чтобы
 * можно было ПОКАЗАТЬ окно и проверить его свойства: знак, интеграл,
 * положение нуля.
 */
export function learningWindow(deltaT: number, params: StdpParams): number {
  if (deltaT > 0) return params.aPlus * Math.exp(-deltaT / params.tauPlus);
  if (deltaT < 0) return -params.aMinus * Math.exp(deltaT / params.tauMinus);
  // В нуле окно разрывно: берётся полусумма, чтобы функция была определена.
  return (params.aPlus - params.aMinus) / 2;
}

/**
 * Интеграл окна обучения: ∫W(Δt)dΔt по всей оси.
 *
 *     ∫ = A₊·τ₊ − A₋·τ₋
 *
 * При A₋·τ₋ > A₊·τ₊ интеграл ОТРИЦАТЕЛЕН — это условие устойчивости:
 * сеть не саморазогревается за счёт одних только случайных совпадений.
 * Инвариант проекта: интеграл обязан быть отрицательным при настройках
 * по умолчанию; тест это проверяет.
 */
export function windowIntegral(params: StdpParams): number {
  return params.aPlus * params.tauPlus - params.aMinus * params.tauMinus;
}

/**
 * Окно, снятое ЧИСЛЕННО прогоном пары спайков.
 *
 * Нужно тестам: сравнение теоретической формулы с фактическим изменением
 * веса ловит расхождение между тем, что заявлено, и тем, что считается.
 *
 * `deltaT > 0` означает, что пре-спайк пришёл РАНЬШЕ пост-спайка на `deltaT`
 * миллисекунд (то есть Δt = t_пост − t_пре = deltaT > 0 → потенциация).
 * Возвращает фактическое Δw для такой пары.
 *
 * Границы намеренно сняты: иначе у самой границы и результат, и сравнение
 * с формулой были бы искажены насыщением, а не свойством правила.
 */
export function measuredWindow(deltaT: number, params: StdpParams, dt = 0.1): number {
  const traces = new StdpTraces(2);
  const xFactor = Math.exp(-dt / params.tauPlus);
  const yFactor = Math.exp(-dt / params.tauMinus);
  const start = 0.5;
  const matrix = buildSynapses(2, [0], [1], [start], [1]);
  // Границы снимаются: проверяем САМО правило, а не насыщение.
  const open = { ...params, bounds: 'hard' as const, wMin: -1e9, wMax: 1e9 };

  const gap = Math.max(1, Math.round(Math.abs(deltaT) / dt));
  const preFirst = deltaT > 0;

  if (preFirst) {
    // Пре-спайк, затем пауза, затем пост-спайк.
    traces.onPreSpike(0);
    for (let step = 0; step < gap; step++) traces.decay(xFactor, yFactor);
    traces.onPostSpike(1);
    potentiateIncoming(matrix, traces, 1, open);
  } else {
    // Пост-спайк, затем пауза, затем пре-спайк.
    traces.onPostSpike(1);
    for (let step = 0; step < gap; step++) traces.decay(xFactor, yFactor);
    traces.onPreSpike(0);
    depressOutgoing(matrix, traces, 0, open);
  }

  return matrix.weight[0] - start;
}

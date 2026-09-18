/**
 * Вычисление условий уровней.
 *
 * Каждое условие — сравнение ИЗМЕРЕННОЙ величины с порогом. Здесь важно не
 * ошибиться в двух местах:
 *
 *   1. ЧТО измеряется. «Доля подвижных» в phys-lab считалась не по той
 *      величине, и уровень не проходился. Аналог здесь: CV ISI считается по
 *      нейронам с достаточной статистикой, а не по всем, иначе молчащие
 *      нейроны «разбавляют» среднее и режим выглядит регулярнее, чем он есть.
 *
 *   2. ГДЕ измеряется. Система сразу после сборки не в равновесии: метрики
 *      на первых десятках миллисекунд не отражают режим. Отсюда `observeMs`
 *      у уровня — сколько модельного времени набрать ПЕРЕД проверкой.
 */

import type { Network } from '../core/network.js';
import { cvIsi } from '../core/measures.js';
import { findBursts, interSpikeIntervals, isiTrend, mean } from '../core/spike-analysis.js';
import { measureWave } from '../core/wave.js';
import type { LevelCheck } from './levels.js';

/** Один измеренный признак. */
export interface CheckResult {
  check: LevelCheck;
  /** Значение величины. */
  value: number;
  /** Выполнено ли условие. */
  passed: boolean;
  /** Человекочитаемое пояснение: что получилось и что нужно. */
  detail: string;
}

/** Контекст проверки: сеть и её параметры, нужные условиям. */
export interface CheckContext {
  network: Network;
  /** Центр стимула для измерения волны (координаты решётки). */
  waveCentre: { centerX: number; centerY: number } | null;
  /** Когда был снят стимул (для условий памяти). */
  stimulusEndMs: number;
  /**
   * Окно наблюдения уровня, мс: измерять только спайки до этого момента.
   *
   * ─── Зачем ограничивать окно ──────────────────────────────────────────
   *
   * Пока проверки смотрели на ВСЮ накопленную историю, `observeMs` уровня
   * ничего не значил. Измерено на уровне «Адаптация»: мера роста интервалов
   * равна 2.53 на 250 мс, 1.43 на 400 мс и **1.25 после 430 мс** — то есть
   * падает ниже порога 1.4 и остаётся там навсегда.
   *
   * Причина в самой мере: адаптация — это ПЕРЕХОДНЫЙ процесс. Первые
   * интервалы короткие, дальше нейрон выходит на стационар, и отношение
   * «хвост к началу» стремится к единице. Чем дольше смотреть, тем слабее
   * виден эффект — это свойство явления, а не ошибка расчёта.
   *
   * А проверка выполнялась после того, как приложение накрутит тысячи шагов
   * (сводка обновляется раз в 500 мс, и за это время проходит ~2000 мс
   * модельного времени). Итог: **уровень проходился или нет в зависимости
   * от того, как долго игрок смотрел** — при формально верных числах.
   *
   * Теперь измерение ограничено окном уровня: ровно те спайки, которые
   * игрок должен был увидеть за `observeMs`. Решение перестаёт зависеть от
   * момента проверки, а `observeMs` наконец означает то, что написано в его
   * комментарии.
   */
  windowMs: number;
}

/** Все проверки уровня одним проходом. */
export function evaluateChecks(
  checks: readonly LevelCheck[],
  context: CheckContext,
): CheckResult[] {
  return checks.map((check) => evaluateCheck(check, context));
}

/** Одна проверка. */
export function evaluateCheck(check: LevelCheck, context: CheckContext): CheckResult {
  const { network } = context;
  const timeMs = Math.max(1, network.state.time);

  switch (check.kind) {
    case 'spikeCount': {
      const value = network.state.spikeCount[check.neuron] ?? 0;
      return range(check, value, `спайков у нейрона ${check.neuron}`);
    }
    case 'rate': {
      let total = 0;
      for (let i = 0; i < network.params.count; i++) total += network.state.spikeCount[i];
      const value = (total / network.params.count / timeMs) * 1000;
      return range(check, value, 'частота популяции, Гц');
    }
    case 'activeNeurons': {
      let active = 0;
      for (let i = 0; i < network.params.count; i++) {
        if (network.state.spikeCount[i] > 0) active += 1;
      }
      return range(check, active, 'нейронов разряжалось');
    }
    case 'cv': {
      const value = cvIsi(network.state);
      // NaN означает «данных мало» — это НЕ «ноль»: проверка не пройдена,
      // но пояснение обязано сказать почему.
      if (Number.isNaN(value)) {
        return {
          check,
          value: Number.NaN,
          passed: false,
          detail: 'пока недостаточно спайков, чтобы измерить нерегулярность',
        };
      }
      return range(check, value, 'CV ISI');
    }
    case 'bursts': {
      const times = spikesOf(network, check.neuron, windowEnd(context));
      const bursts = findBursts(times, { maxIntraMs: 10, minSize: 2 });
      return range(check, bursts.length, 'групп спайков');
    }
    case 'isiTrend': {
      const times = spikesOf(network, check.neuron, windowEnd(context));
      const trend = isiTrend(interSpikeIntervals(times));
      if (Number.isNaN(trend)) {
        return {
          check,
          value: Number.NaN,
          passed: false,
          detail: 'слишком мало спайков для оценки адаптации',
        };
      }
      return range(check, trend, 'рост интервалов, раз');
    }
    case 'synchrony': {
      const value = network.synchronyValue();
      if (Number.isNaN(value)) {
        return {
          check,
          value: Number.NaN,
          passed: false,
          detail: 'спайков ещё не было — синхронность не определена',
        };
      }
      return range(check, value, 'синхронность');
    }
    case 'weightSpread': {
      let min = Infinity;
      let max = -Infinity;
      for (const weight of network.synapses.weight) {
        if (weight <= 0) continue;
        if (weight < min) min = weight;
        if (weight > max) max = weight;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { check, value: 0, passed: false, detail: 'возбуждающих связей нет' };
      }
      return range(check, max - min, 'разброс весов');
    }
    case 'stdpUpdates': {
      return range(check, network.stdpUpdates, 'обновлений весов');
    }
    case 'waveReach':
    case 'waveFit': {
      if (!context.waveCentre) {
        return {
          check,
          value: 0,
          passed: false,
          detail: 'пространственная сцена не активна',
        };
      }
      const wave = measureWave(network, { ...context.waveCentre, minDistance: 3 });
      const value = check.kind === 'waveReach' ? wave.reachCells : wave.fitR2;
      const label = check.kind === 'waveReach' ? 'волна дошла, клеток' : 'линейность фронта R²';
      if (value === 0 && wave.activeCount === 0) {
        return { check, value: 0, passed: false, detail: 'волны нет: спайков не было' };
      }
      return range(check, value, label);
    }
    case 'networkEdited': {
      // ─── Что здесь измеряется ───────────────────────────────────────────
      //
      // Отклонение ПАРАМЕТРОВ СЕТИ от того, что задал пресет. Берётся сумма
      // двух относительных отклонений:
      //
      //   • множитель веса: |scale − 1| — при 1.0 сеть ровно такая, какой
      //     её собрал пресет;
      //   • доля торможения: |current − preset|, делённая на шкалу ползунка
      //     (0.5), чтобы вклад был сопоставим с весом.
      //
      // Отклонения складываются, а не берётся максимум: сдвинуть оба
      // параметра — тоже «собрать сеть», и это не должно наказываться.
      const weightDelta = Math.abs(network.currentWeightScale - 1);
      const inhibitionDelta = Math.abs(network.presetInhibitoryFraction - network.params.inhibitoryFraction) / 0.5;
      return range(check, weightDelta + inhibitionDelta, 'изменение параметров сети');
    }
    case 'memoryHold':
    case 'memoryGrowth': {
      // ─── Что здесь измеряется и почему ИМЕННО ТАК ──────────────────────
      //
      // Рабочая память — это «сеть продолжает разряжаться после того, как
      // стимул снят». Формулировать это числом оказалось неочевидно, и обе
      // крайности давали дефекты:
      //
      //   1. Вся накопленная история (`to = timeMs`) — величина РАСТЁТ СО
      //      ВРЕМЕНЕМ НАБЛЮДЕНИЯ. Измерено для «удержания»: 578 мс на
      //      600 мс наблюдения, 1180 на 1200, 2380 на 2400, 4780 на 4800.
      //      Условие «удержание ≥ 200 мс» выполнялось бы ВСЕГДА, даже если
      //      активность погасла на 30-й мс. Это тот же класс, что дефект 33:
      //      проверка измеряла терпение наблюдателя, а не свойство сети.
      //
      //   2. Фиксированное окно [снятие стимула, снятие + observeMs] —
      //      растёт правильно, но упирается в ЁМКОСТЬ КОЛЬЦЕВОГО БУФЕРА
      //      истории. Измерено на сцене памяти: при 382 000 спайков буфер
      //      (200 000 записей) вытеснил начало окна, и проверка получала
      //      0 спайков — «память пропала» там, где сеть работала вовсю.
      //
      // Рабочее определение — СКОЛЬЗЯЩЕЕ окно шириной `observeMs`,
      // прижатое к моменту проверки: [now − W, now], но не раньше снятия
      // стимула. Оно:
      //   • не растёт со временем наблюдения (ширина фиксирована);
      //   • не может быть вытеснено буфером (окно всегда у свежих записей);
      //   • измеряет ровно то, что нужно: «сеть разряжается СЕЙЧАС?».
      //
      // Именно это и есть рабочая память: не «сколько всего накопилось», а
      // «держится ли активность в текущем окне».
      const now = timeMs;
      const W = windowEnd(context) > 0 ? windowEnd(context) : now;
      const from = Math.max(context.stimulusEndMs, now - W);
      const to = now;

      if (to <= context.stimulusEndMs) {
        return {
          check,
          value: 0,
          passed: false,
          detail: 'стимул ещё не снят — измерять удержание рано',
        };
      }

      if (check.kind === 'memoryHold') {
        // Удержание: сколько мс активности в окне ПРИСУТСТВУЕТ, не больше
        // ширины окна. Ограничение сверху обязательно: без него величина
        // снова начала бы расти с временем наблюдения.
        const last = network.spikeHistory.lastTimeIn(from, to);
        const value = Number.isNaN(last) ? 0 : Math.min(W, Math.max(0, last - from));
        return range(check, value, 'удержание, мс');
      }

      // Прирост: сколько спайков случилось в окне после снятия стимула.
      return range(check, network.spikeHistory.countIn(from, to), 'спайков в окне после стимула');
    }
  }
}

/**
 * Сравнить значение с границами условия.
 *
 * Пояснение всегда содержит и полученное значение, и требуемое: игрок должен
 * видеть, ЧТО именно не выполнено, а не «неправильно».
 */
function range(
  check: LevelCheck,
  value: number,
  label: string,
): CheckResult {
  const limits = check as { min?: number; max?: number };
  let passed = true;
  const parts: string[] = [`${label} = ${formatValue(value)}`];

  if (limits.min !== undefined) {
    const ok = value >= limits.min;
    passed = passed && ok;
    parts.push(`нужно не меньше ${formatValue(limits.min)}`);
  }
  if (limits.max !== undefined) {
    const ok = value <= limits.max;
    passed = passed && ok;
    parts.push(`нужно не больше ${formatValue(limits.max)}`);
  }
  void check;
  return { check, value, passed, detail: parts.join(', ') + (passed ? '' : ' — пока нет') };
}

/** Форматирование числа для пояснения. */
function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(3);
}

/**
 * Граница окна наблюдения: до какого момента брать спайки.
 *
 * `Infinity`, если окно не задано (старые вызовы и тесты): тогда поведение
 * прежнее — вся история.
 */
function windowEnd(context: CheckContext): number {
  return context.windowMs > 0 ? context.windowMs : Infinity;
}

/**
 * Времена спайков одного нейрона из истории ядра, до момента `untilMs`.
 *
 * История ведётся в `Network.spikeHistory` (кольцевой буфер), а не
 * собирается здесь: те же данные нужны растровой диаграмме, и держать две
 * независимые истории означало бы, что уровень может проходиться, а
 * картинка этого не показывать.
 *
 * `untilMs` ограничивает выборку окном наблюдения уровня. Это не
 * косметика: мера адаптации падает со временем наблюдения (измерено
 * 2.53 → 1.43 → 1.25), и без ограничения вердикт зависел от того, как
 * долго игрок смотрел на сцену.
 */
function spikesOf(network: Network, neuron: number, untilMs = Infinity): number[] {
  const all = network.spikeHistory.timesOf(neuron);
  if (!Number.isFinite(untilMs)) return all;
  return all.filter((time) => time <= untilMs);
}

/** Средний ISI по последовательности (для отладки и тестов). */
export function meanIsiOf(times: readonly number[]): number {
  return mean(interSpikeIntervals(times));
}

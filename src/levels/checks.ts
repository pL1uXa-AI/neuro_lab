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
import { measureMemory } from '../core/memory.js';
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
      const times = spikesOf(network, check.neuron);
      const bursts = findBursts(times, { maxIntraMs: 10, minSize: 2 });
      return range(check, bursts.length, 'групп спайков');
    }
    case 'isiTrend': {
      const times = spikesOf(network, check.neuron);
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
    case 'memoryHold':
    case 'memoryGrowth': {
      // Память измеряется по УЖЕ прошедшему времени: сеть уже прожила
      // observeMs, и надо понять, держится ли активность.
      const result = measureMemory(network, {
        stimulusEndMs: context.stimulusEndMs,
        maxMs: 0,
      });
      if (check.kind === 'memoryHold') {
        return range(check, result.holdMs, 'удержание, мс');
      }
      // Прирост: сколько спайков случилось ПОСЛЕ снятия стимула.
      const elapsed = Math.max(0, timeMs - context.stimulusEndMs);
      const value = elapsed > 0 ? result.spikesHeld : 0;
      return range(check, value, 'спайков после стимула');
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
 * Времена спайков одного нейрона из истории ядра.
 *
 * История ведётся в `Network.spikeHistory` (кольцевой буфер), а не
 * собирается здесь: те же данные нужны растровой диаграмме, и держать две
 * независимые истории означало бы, что уровень может проходиться, а
 * картинка этого не показывать.
 */
function spikesOf(network: Network, neuron: number): number[] {
  return network.spikeHistory.timesOf(neuron);
}

/** Средний ISI по последовательности (для отладки и тестов). */
export function meanIsiOf(times: readonly number[]): number {
  return mean(interSpikeIntervals(times));
}

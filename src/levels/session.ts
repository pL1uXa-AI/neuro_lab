/**
 * Сессия уровня: наблюдение и проверка.
 *
 * ─── Зачем отдельный объект ──────────────────────────────────────────────
 *
 * Проверять уровень сразу после его запуска нельзя: сеть ещё не вышла на
 * режим, статистики нет, и решение было бы случайным. Сессия ведёт отсчёт
 * наблюдения (`observeMs` у уровня), и только когда время набрано, разрешает
 * проверку.
 *
 * Тот же приём, что в phys-lab: «выход на режим» плюс окно усреднения. Здесь
 * он проще, потому что метрики ядра (CV ISI, синхронность) и так накопительные.
 */

import type { Network } from '../core/network.js';
import type { Level } from './levels.js';
import { evaluateChecks, type CheckResult, type CheckContext } from './checks.js';

/** Отчёт по уровню. */
export interface LevelReport {
  levelId: string;
  /** Все ли условия выполнены. */
  passed: boolean;
  /** Результаты по каждому условию. */
  results: CheckResult[];
  /** Сколько модельного времени накоплено, мс. */
  elapsedMs: number;
  /** Хватило ли времени наблюдения. */
  ready: boolean;
}

/** Сессия уровня. */
export class LevelSession {
  readonly level: Level;
  private network: Network;
  /** Сколько модельного времени нужно набрать перед проверкой. */
  private readonly observeMs: number;
  /** Момент снятия стимула — нужен условиям памяти. */
  private stimulusEndMs: number;
  private waveCentre: { centerX: number; centerY: number } | null = null;
  private completed = false;

  constructor(level: Level, network: Network) {
    this.level = level;
    this.network = network;
    this.observeMs = level.observeMs;
    this.stimulusEndMs = 0;
  }

  /**
   * Наблюдение за сессией на каждом шаге приложения.
   *
   * Здесь отслеживается момент снятия стимула: у пространственных сцен это
   * конец пятна, у сцен памяти — конец инъекции. Без этого условия памяти
   * считали бы «удержанием» сам стимул.
   */
  tick(): void {
    if (this.completed) return;
    // Оценка момента снятия стимула: у пространственных сцен — короткий
    // стартовый импульс (20 мс), у сцен памяти — тоже стартовый.
    if (this.stimulusEndMs === 0 && this.network.state.time > 30) {
      this.stimulusEndMs = 20;
    }
  }

  /** Задать центр волны (для пространственных уровней). */
  setWaveCentre(centre: { centerX: number; centerY: number } | null): void {
    this.waveCentre = centre;
  }

  /** Сколько модельного времени накоплено. */
  get elapsedMs(): number {
    return this.network.state.time;
  }

  /** Набрано ли время наблюдения. */
  get ready(): boolean {
    return this.network.state.time >= this.observeMs;
  }

  /** Прогресс наблюдения 0…1. */
  get progress(): number {
    if (this.observeMs <= 0) return 1;
    return Math.min(1, this.network.state.time / this.observeMs);
  }

  /** Проверить условия уровня. Возвращает null, если время ещё не набрано. */
  check(): LevelReport | null {
    if (!this.ready) return null;
    const context: CheckContext = {
      network: this.network,
      waveCentre: this.waveCentre,
      stimulusEndMs: this.stimulusEndMs,
    };
    const results = evaluateChecks(this.level.checks, context);
    const passed = results.every((result) => result.passed);
    if (passed) this.completed = true;
    return {
      levelId: this.level.id,
      passed,
      results,
      elapsedMs: this.elapsedMs,
      ready: true,
    };
  }

  /** Проверить условия принудительно, даже если время не набрано. */
  checkNow(): LevelReport {
    const context: CheckContext = {
      network: this.network,
      waveCentre: this.waveCentre,
      stimulusEndMs: this.stimulusEndMs,
    };
    const results = evaluateChecks(this.level.checks, context);
    const passed = results.every((result) => result.passed);
    if (passed) this.completed = true;
    return {
      levelId: this.level.id,
      passed,
      results,
      elapsedMs: this.elapsedMs,
      ready: this.ready,
    };
  }

  /** Пройден ли уровень. */
  get isCompleted(): boolean {
    return this.completed;
  }

  /** Сменить сеть (после перезапуска того же уровня). */
  rebind(network: Network): void {
    this.network = network;
    this.stimulusEndMs = 0;
    this.completed = false;
  }
}

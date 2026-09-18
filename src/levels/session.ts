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
import { presetById } from '../core/presets.js';
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
  /** Момент снятия стимула — нужен условиям памяти. `null` — ещё не наступил. */
  private stimulusEndMs: number | null = null;
  private waveCentre: { centerX: number; centerY: number } | null = null;
  private completed = false;

  constructor(level: Level, network: Network) {
    this.level = level;
    this.network = network;
    this.observeMs = level.observeMs;
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
    if (this.stimulusEndMs !== null) return;
    // ─── Почему длительность берётся из пресета, а не из константы ──────
    //
    // Первая версия ждала «время > 30» и записывала жёсткое `20` — «короткий
    // стартовый импульс». Числа совпадали с пресетами волны и памяти, и
    // дефект был невидим. Но у кольца стартовый импульс длится **1 мс**
    // (`durationMs: 1`), а не 20: если бы у уровня с этим пресетом появилось
    // условие памяти, окно измерения начиналось бы на 19 мс позже стимула,
    // то есть часть удержания молча выпала бы из подсчёта.
    //
    // Поэтому длительность читается у САМОГО пресета. Значение `null` —
    // «ещё не зафиксировано»; ждём, пока стимул гарантированно пройдёт, и
    // записываем его фактический конец.
    const starter = presetById(this.level.presetId)?.starter;
    if (starter === undefined) {
      // У уровня нет стартового стимула: считать начало удержания не от
      // чего, поэтому окно открывается с нуля.
      this.stimulusEndMs = 0;
      return;
    }
    // Ждём, пока стимул гарантированно пройдёт: он действует ровно
    // `durationMs` от начала прогона.
    if (this.network.state.time >= starter.durationMs) {
      this.stimulusEndMs = starter.durationMs;
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
      stimulusEndMs: this.stimulusEndMs ?? 0,
      windowMs: this.windowEndMs(),
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
      stimulusEndMs: this.stimulusEndMs ?? 0,
      windowMs: this.windowEndMs(),
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

  /**
   * Граница окна наблюдения, мс.
   *
   * ─── Почему окно НЕ растёт со временем ─────────────────────────────────
   *
   * Оно фиксируется на `observeMs` — ровно том времени, которое уровень
   * просит набрать. Пока проверки смотрели всю историю, вердикт зависел от
   * того, как долго игрок смотрел на сцену: измерено на уровне
   * «Адаптация» — мера роста интервалов 2.53 на 250 мс и 1.25 после 430,
   * то есть уровень «ломался» от простого ожидания.
   *
   * Условия, требующие всей накопленной статистики (число спайков, доля
   * активных, обучение), окном не ограничиваются: накопление — их смысл.
   */
  private windowEndMs(): number {
    return Math.max(1, this.observeMs);
  }

  /** Пройден ли уровень. */
  get isCompleted(): boolean {
    return this.completed;
  }

  /** Сменить сеть (после перезапуска того же уровня). */
  rebind(network: Network): void {
    this.network = network;
    this.stimulusEndMs = null;
    this.completed = false;
  }
}

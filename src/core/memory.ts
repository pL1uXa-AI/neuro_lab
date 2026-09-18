/**
 * Рабочая память и ритмы.
 *
 * ─── Рабочая память ──────────────────────────────────────────────────────
 *
 * Это не метафора. В коре есть сеть, которая удерживает активность после
 * того, как стимул исчез: рекуррентное возбуждение поддерживает само себя.
 * Условие существования такого режима — достаточная сила рекуррентной связи:
 * при слабой активности гаснет за время τ_m, при сильной держится
 * неограниченно долго. Между ними лежит ПОРОГ, и его надо измерить.
 *
 * ─── Две меры удержания, и почему их две ────────────────────────────────
 *
 * 1. **`measureMemory` — эта функция.** ПРОДВИГАЕТ симуляцию на `maxMs` и
 *    следит за частотой в скользящем окне. Нужна, когда надо ИЗМЕРИТЬ
 *    порог: перебрать силу связей и найти, где память возникает.
 *
 * 2. **Условие уровня `memoryHold`** (см. `levels/checks.ts`). НЕ двигает
 *    сеть, а читает уже накопленную историю спайков в скользящем окне
 *    шириной `observeMs`. Нужна, когда надо ОЦЕНИТЬ уже идущую сцену —
 *    в горячем цикле интерфейса проверка обязана быть наблюдателем.
 *
 * Две меры существуют не по недосмотру: одна измеряет явление, другая
 * судит о нём, и смешивать их нельзя — проверка, двигающая симуляцию за
 * игрока, делала бы вердикт зависимым от частоты обновления сводки.
 *
 * ─── О числе в условии ───────────────────────────────────────────────────
 *
 * Уровень «Рабочая память» требует удержания **не меньше 200 мс** — это
 * чуть меньше ширины окна наблюдения сцены (600 мс), то есть «активность
 * держится заметную часть окна, а не вспыхивает один раз». Здесь раньше
 * было написано «300 мс», и это разошлось с уровнем: комментарий обещал
 * одно, а проверялось другое. Порог 200 мс выбран по измерению — сцена
 * держит активность всё окно, поэтому запас есть.
 *
 * ─── Ритмы ───────────────────────────────────────────────────────────────
 *
 * Гамма-осцилляции (30–80 Гц) возникают из взаимодействия возбуждения и
 * торможения: E-клетки разгоняют друг друга, I-клетки их притормаживают с
 * задержкой, и система начинает колебаться. Это «E/I-ритм» (PING —
 * pyramidal-interneuron network gamma), и он воспроизводится в модели без
 * каких-либо генераторов: ритм — эмерджентное явление.
 *
 * Измеряется спектром популяционной активности: у ритма есть пик, у
 * асинхронной сети спектр плоский.
 */

import type { Network } from './network.js';
import { populationSpectrum, type SpectrumResult } from './measures.js';

/** Результат измерения удержания активности. */
export interface MemoryResult {
  /** Частота в окне сразу после снятия стимула, Гц. */
  rateAfterStimulus: number;
  /** Частота в конце окна наблюдения, Гц. */
  rateAtEnd: number;
  /** Во сколько раз упала частота (1 — не упала вовсе). */
  decayRatio: number;
  /** Сколько миллисекунд активность держалась выше порога. */
  holdMs: number;
  /** Число спайков в окне удержания. */
  spikesHeld: number;
}

/**
 * Измерить, как долго сеть удерживает активность после снятия стимула.
 *
 * Метод: считаем спайки в скользящем окне `windowMs`, начиная с момента
 * `stimulusEndMs`. Удержание длится, пока частота в окне не упадёт ниже
 * `thresholdHz`. Возвращаются и время удержания, и отношение конечной
 * частоты к начальной — второй показатель различает «активность держится
 * ровно» и «активность медленно затухает».
 *
 * Почему окно, а не мгновенная частота: одиночные спайки случаются и в
 * погасшей сети, и по ним нельзя судить о режиме. Окно сглаживает.
 */
export function measureMemory(
  network: Network,
  options: {
    /** С какого момента считать удержание (мс). */
    stimulusEndMs: number;
    /** Ширина окна усреднения, мс. */
    windowMs?: number;
    /** Порог частоты, ниже которого активность считается погасшей, Гц. */
    thresholdHz?: number;
    /** Через сколько шагов делать замер, мс. */
    sampleEveryMs?: number;
    /** Максимальное время наблюдения, мс. */
    maxMs: number;
  },
): MemoryResult {
  const windowMs = options.windowMs ?? 50;
  const thresholdHz = options.thresholdHz ?? 1;
  const sampleEveryMs = options.sampleEveryMs ?? 10;
  const dt = network.params.dt;
  const count = network.params.count;

  // Запоминаем счётчики, чтобы считать спайки ЗА окно, а не с начала прогона.
  const beforeCounts = Uint32Array.from(network.state.spikeCount);

  const samples: Array<{ timeMs: number; rateHz: number }> = [];
  const windowSteps = Math.max(1, Math.round(windowMs / dt));
  const sampleSteps = Math.max(1, Math.round(sampleEveryMs / dt));

  // Кольцо счётчиков для окна: сколько спайков случилось на каждом шаге.
  const perStep = new Uint32Array(windowSteps);
  let cursor = 0;
  let windowSpikes = 0;

  const totalSpikes = (): number => {
    let total = 0;
    for (let i = 0; i < count; i++) total += network.state.spikeCount[i] - beforeCounts[i];
    return total;
  };

  const startStep = network.state.step;
  const totalSteps = Math.round(options.maxMs / dt);

  let rateAfterStimulus = Number.NaN;
  let rateAtEnd = Number.NaN;
  let holdMs = 0;
  let spikesHeld = 0;

  for (let step = 0; step < totalSteps; step++) {
    const spikes = network.step();
    const now = network.state.time;
    if (now < options.stimulusEndMs) {
      // До снятия стимула наблюдаем, но в окно удержания не засчитываем.
      continue;
    }

    // Обновляем кольцо: входящий шаг, выходящий шаг.
    windowSpikes -= perStep[cursor];
    perStep[cursor] = spikes;
    windowSpikes += spikes;
    cursor = (cursor + 1) % windowSteps;

    if ((step - startStep) % sampleSteps !== 0) continue;

    const rateHz = windowSpikes / ((windowSteps * dt) / 1000) / count;
    samples.push({ timeMs: now - options.stimulusEndMs, rateHz });

    if (Number.isNaN(rateAfterStimulus)) rateAfterStimulus = rateHz;
    rateAtEnd = rateHz;

    if (rateHz >= thresholdHz) {
      holdMs = now - options.stimulusEndMs;
      spikesHeld += windowSpikes;
    }
  }

  // Спайки в окне удержания считаются по разнице счётчиков: это устойчивее,
  // чем накопление по шагам, где легко потерять дробные события.
  spikesHeld = totalSpikes();
  const decayRatio =
    Number.isFinite(rateAfterStimulus) && rateAfterStimulus > 0 && Number.isFinite(rateAtEnd)
      ? rateAfterStimulus / Math.max(rateAtEnd, 1e-9)
      : Number.NaN;

  return { rateAfterStimulus, rateAtEnd, decayRatio, holdMs, spikesHeld };
}

/** Результат измерения ритма. */
export interface RhythmResult extends SpectrumResult {
  /** Средняя частота популяции за окно, Гц. */
  meanRateHz: number;
  /** Есть ли выраженный пик в полосе гамма-диапазона. */
  gammaPeak: boolean;
}

/**
 * Найти ритм в популяционной активности.
 *
 * Гамма-диапазон определён как 25–90 Гц: нижняя граница отделяет его от
 * тета- и бета-колебаний, верхняя — от высокочастотного «звона» отдельных
 * клеток. Пик считается выраженным, если он попал в этот диапазон и его
 * мощность заметна на фоне остальных частот.
 */
export function measureRhythm(
  network: Network,
  options: { maxHz?: number; minPeakPower?: number } = {},
): RhythmResult {
  const series = network.rateSeries();
  const sampleMs = network.rateSampleMs;
  const spectrum = populationSpectrum(series, sampleMs, { maxHz: options.maxHz ?? 120 });

  let meanRateHz = 0;
  if (series.length > 0) {
    for (const value of series) meanRateHz += value;
    meanRateHz /= series.length;
  }

  const minPeakPower = options.minPeakPower ?? 0.05;
  const gammaPeak =
    spectrum.peakHz >= 25 && spectrum.peakHz <= 90 && spectrum.peakPower >= minPeakPower;

  return { ...spectrum, meanRateHz, gammaPeak };
}

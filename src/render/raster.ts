/**
 * Растровая диаграмма (spike raster) — главный научный вид проекта.
 *
 * ─── Почему это важнее «красивой сцены» ──────────────────────────────────
 *
 * Сцена показывает нейроны в пространстве, но по ней трудно судить о
 * ВРЕМЕНИ: вспышка живёт 25 мс, и разглядеть в ней ритм или синхронный
 * разряд невозможно. Растровая диаграмма — это время по горизонтали и
 * номер нейрона по вертикали; каждая точка — спайк. На ней видно сразу:
 *
 *   • вертикальная полоса — синхронный разряд всей популяции;
 *   • наклонная полоса — волна, бегущая по сети;
 *   • ровные горизонтальные штрихи — регулярно разряжающиеся нейроны;
 *   • однородный «ковёр» — асинхронный режим.
 *
 * ─── Почему используется история ЯДРА ────────────────────────────────────
 *
 * Первая версия держала собственную копию истории спайков. Это плохо по
 * двум причинам: лишняя память и — главное — расхождение между тем, что
 * видит игрок, и тем, по чему проверяется уровень. Теперь у истории один
 * владелец (`Network.spikeHistory`), а этот модуль только рисует.
 */

import type { SpikeHistory } from '../core/spike-history.js';

/** Настройки отрисовки растровой диаграммы. */
export interface RasterOptions {
  /** Модельное время начала окна, мс. */
  fromMs: number;
  /** Модельное время конца окна, мс. */
  toMs: number;
  /** Число нейронов (по вертикали). */
  neuronCount: number;
}

/**
 * Нарисовать растровую диаграмму.
 *
 * Возвращает число нарисованных точек — это позволяет сквозной проверке
 * убедиться, что панель действительно что-то рисует, а не пустует.
 */
export function drawRaster(
  canvas: HTMLCanvasElement,
  history: SpikeHistory,
  options: RasterOptions,
): number {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 160;
  if (
    canvas.width !== Math.round(cssWidth * ratio) ||
    canvas.height !== Math.round(cssHeight * ratio)
  ) {
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = 4;
  const left = padding + 30;
  const right = cssWidth - padding;
  const top = padding + 12;
  const bottom = cssHeight - padding - 10;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);

  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, plotWidth, plotHeight);

  const span = Math.max(1e-6, options.toMs - options.fromMs);
  const rows = Math.max(1, options.neuronCount);

  // Рисуем только точки, попавшие в окно.
  ctx.fillStyle = '#ffd97a';
  const records = history.window(options.fromMs, options.toMs);
  const dotSize = rows > 400 ? 1 : 1.5;
  for (const record of records) {
    const screenX = left + ((record.timeMs - options.fromMs) / span) * plotWidth;
    // Нейроны идут снизу вверх, как принято на растровых диаграммах.
    const screenY = bottom - (record.index / rows) * plotHeight;
    ctx.fillRect(screenX, screenY, dotSize, dotSize);
  }

  ctx.strokeStyle = '#1e2a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth - 1, plotHeight - 1);

  ctx.fillStyle = '#7a8aa0';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(options.neuronCount), left - 4, top + 4);
  ctx.fillText('0', left - 4, bottom - 4);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${options.fromMs.toFixed(0)} мс`, left, top - 11);
  ctx.textAlign = 'right';
  ctx.fillText(`${options.toMs.toFixed(0)} мс`, right, top - 11);

  return records.length;
}

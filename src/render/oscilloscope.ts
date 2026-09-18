/**
 * Осциллограф: мембранный потенциал выбранных нейронов во времени.
 *
 * Идея взята из logic-lab (там осциллограф показывал сигналы по тактам), но
 * предмет другой: здесь непрерывные кривые потенциала. Общий остаётся
 * принцип — панель рисует то, что ей дали, ничего не зная о симуляции.
 *
 * ─── Что важно показать ──────────────────────────────────────────────────
 *
 *   1. Порог. Без горизонтальной линии порога кривая ничего не говорит:
 *      спайк — это пересечение, и его надо видеть.
 *   2. Отметки спайков. Кривая при dt = 0.5 мс может «проскочить» пик между
 *      отсчётами, поэтому момент спайка отмечается отдельно.
 *   3. Масштаб по времени. Окно всегда показывает последние N мс — иначе
 *      осциллограф «уползает» и перестаёт читаться.
 */

/** Одна дорожка осциллографа. */
export interface Trace {
  /** Подпись для легенды. */
  label: string;
  /** Цвет линии. */
  color: string;
  /** Значения потенциала, мВ. */
  values: number[];
  /** Времена отсчётов, мс — общие для всех дорожек. */
  times: number[];
  /** Времена спайков этой дорожки, мс. */
  spikeTimes: number[];
}

/** Настройки отрисовки. */
export interface OscilloscopeOptions {
  /** Уровень порога, мВ: рисуется горизонтальной линией. */
  threshold?: number;
  /** Уровень сброса, мВ: вторая опорная линия. */
  reset?: number;
  /** Подпись оси Y. */
  unit?: string;
  /** Сколько последних миллисекунд показывать. */
  windowMs?: number;
}

/**
 * Нарисовать осциллограмму.
 *
 * Возвращает число нарисованных точек — это позволяет сквозной проверке
 * убедиться, что панель действительно что-то рисует, а не пустует.
 */
export function drawOscilloscope(
  canvas: HTMLCanvasElement,
  traces: readonly Trace[],
  options: OscilloscopeOptions = {},
): number {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 140;
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

  const padding = 6;
  const left = padding + 36;
  const right = cssWidth - padding;
  const top = padding + 14;
  const bottom = cssHeight - padding - 12;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);

  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, plotWidth, plotHeight);

  if (traces.length === 0 || traces[0].times.length < 2) {
    drawEmpty(ctx, left, top, plotWidth, plotHeight, 'нет данных');
    drawFrame(ctx, left, top, plotWidth, plotHeight);
    return 0;
  }

  // Окно по времени: последние `windowMs` миллисекунд.
  const firstTrace = traces[0];
  const lastTime = firstTrace.times[firstTrace.times.length - 1];
  const windowMs = options.windowMs ?? 200;
  const fromTime = lastTime - windowMs;

  // Диапазон по Y: по всем дорожкам, с запасом под порог и сброс.
  let minV = Infinity;
  let maxV = -Infinity;
  for (const trace of traces) {
    for (let i = 0; i < trace.values.length; i++) {
      const value = trace.values[i];
      if (!Number.isFinite(value)) continue;
      if (value < minV) minV = value;
      if (value > maxV) maxV = value;
    }
  }
  if (options.threshold !== undefined) maxV = Math.max(maxV, options.threshold);
  if (options.reset !== undefined) minV = Math.min(minV, options.reset);
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    minV = -80;
    maxV = 40;
  }
  if (maxV - minV < 1) {
    minV -= 1;
    maxV += 1;
  }
  const pad = (maxV - minV) * 0.08;
  minV -= pad;
  maxV += pad;
  const spanV = maxV - minV;

  const toX = (time: number): number => left + ((time - fromTime) / windowMs) * plotWidth;
  const toY = (value: number): number => bottom - ((value - minV) / spanV) * plotHeight;

  // Опорные линии порога и сброса.
  if (options.threshold !== undefined) {
    drawGuide(ctx, left, right, toY(options.threshold), '#f2705a', 'порог', cssWidth);
  }
  if (options.reset !== undefined) {
    drawGuide(ctx, left, right, toY(options.reset), '#5a7fb0', 'сброс', cssWidth);
  }

  // Кривые.
  let drawn = 0;
  for (const trace of traces) {
    ctx.strokeStyle = trace.color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < trace.values.length; i++) {
      const time = trace.times[i];
      if (time < fromTime) continue;
      const value = trace.values[i];
      if (!Number.isFinite(value)) {
        started = false;
        continue;
      }
      const x = toX(time);
      const y = toY(value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
      drawn += 1;
    }
    ctx.stroke();

    // Отметки спайков: пик может оказаться между отсчётами, и без отметки
    // осциллограмма выглядела бы так, будто спайка не было.
    ctx.fillStyle = trace.color;
    for (const spikeTime of trace.spikeTimes) {
      if (spikeTime < fromTime) continue;
      const x = toX(spikeTime);
      ctx.beginPath();
      ctx.arc(x, top + 4, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawFrame(ctx, left, top, plotWidth, plotHeight);
  drawAxisLabels(ctx, left, top, bottom, minV, maxV, cssWidth, options.unit);

  return drawn;
}

/** Рамка области построения. */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  ctx.strokeStyle = '#1e2a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
}

/** Сообщение вместо пустой области. */
function drawEmpty(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  width: number,
  height: number,
  text: string,
): void {
  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = '#5a6b85';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + width / 2, top + height / 2);
}

/** Горизонтальная опорная линия с подписью. */
function drawGuide(
  ctx: CanvasRenderingContext2D,
  left: number,
  right: number,
  y: number,
  color: string,
  label: string,
  cssWidth: number,
): void {
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = color;
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(label, cssWidth - 8, y - 2);
}

/** Подписи осей. */
function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  left: number,
  top: number,
  bottom: number,
  minV: number,
  maxV: number,
  cssWidth: number,
  unit?: string,
): void {
  ctx.fillStyle = '#7a8aa0';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${maxV.toFixed(0)}`, left - 4, top + 6);
  ctx.fillText(`${minV.toFixed(0)}`, left - 4, bottom - 6);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(unit ?? 'мВ', 2, top + 2);
  void cssWidth;
}

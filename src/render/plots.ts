/**
 * Графики непрерывных величин: частота популяции, средний вес, синхронность.
 *
 * Идея взята из phys-lab (там это были температура, энергия и g(r)): панель
 * рисует то, что ей дали, ничего не зная о симуляции, а масштаб подбирается
 * автоматически по данным.
 *
 * Почему Canvas2D, а не Pixi: графики обновляются раз в несколько кадров,
 * линий мало, и WebGL здесь дал бы только лишнюю сложность. Тот же выбор,
 * что в phys-lab и logic-lab.
 */

/** Серия данных для графика. */
export interface Series {
  label: string;
  color: string;
  values: number[];
  /** Времена (общая шкала для всех серий панели). */
  times: number[];
  /** Толщина линии. */
  width?: number;
  /** Рисовать ли заливку под линией. */
  fill?: boolean;
}

/** Описание графика. */
export interface PlotSpec {
  title: string;
  series: Series[];
  /** Подпись оси Y. */
  unit?: string;
  /** Фиксированный диапазон по Y: [min, max]. */
  range?: [number, number];
  /** Опорная линия. */
  guide?: { value: number; label: string; color: string };
}

/** Цвета линий графиков. */
export const PLOT_COLORS = {
  rate: '#6fb3e0',
  activeRate: '#7fd6c0',
  weight: '#f2a65a',
  synchrony: '#c99ae0',
  cv: '#f2d06a',
  guide: '#5a6b85',
};

/**
 * Отрисовка графика в канвас.
 *
 * Возвращает число нарисованных точек: это позволяет сквозной проверке
 * убедиться, что панель действительно рисует.
 */
export function drawPlot(canvas: HTMLCanvasElement, spec: PlotSpec): number {
  const ratio = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 300;
  const cssHeight = canvas.clientHeight || 110;
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
  const left = padding + 38;
  const right = cssWidth - padding - 4;
  const top = padding + 14;
  const bottom = cssHeight - padding - 10;
  const plotWidth = Math.max(1, right - left);
  const plotHeight = Math.max(1, bottom - top);

  ctx.fillStyle = '#0e1520';
  ctx.fillRect(left, top, plotWidth, plotHeight);

  const bounds = computeBounds(spec);
  const tMin = bounds.tMin;
  const tMax = bounds.tMax;
  const vMin = bounds.vMin;
  const vMax = bounds.vMax;
  const tSpan = Math.max(1e-6, tMax - tMin);
  const vSpan = Math.max(1e-6, vMax - vMin);

  const toX = (time: number): number => left + ((time - tMin) / tSpan) * plotWidth;
  const toY = (value: number): number => bottom - ((value - vMin) / vSpan) * plotHeight;

  // Сетка по горизонтали: три линии.
  ctx.strokeStyle = '#161f2c';
  ctx.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    const y = top + (plotHeight * i) / 3;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  if (spec.guide) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = spec.guide.color;
    ctx.beginPath();
    ctx.moveTo(left, toY(spec.guide.value));
    ctx.lineTo(right, toY(spec.guide.value));
    ctx.stroke();
    ctx.restore();
  }

  let drawn = 0;
  for (const series of spec.series) {
    if (series.values.length < 2) continue;
    ctx.strokeStyle = series.color;
    ctx.lineWidth = series.width ?? 1.3;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < series.values.length; i++) {
      const value = series.values[i];
      const time = series.times[i];
      if (!Number.isFinite(value) || !Number.isFinite(time)) {
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
  }

  // Рамка.
  ctx.strokeStyle = '#1e2a3a';
  ctx.strokeRect(left + 0.5, top + 0.5, plotWidth - 1, plotHeight - 1);

  // Заголовок и подписи осей.
  ctx.fillStyle = '#9fb0c8';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(spec.title, left, 2);

  ctx.fillStyle = '#7a8aa0';
  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatAxis(vMax), left - 4, top + 4);
  ctx.fillText(formatAxis(vMin), left - 4, bottom - 4);
  if (spec.unit) {
    ctx.textAlign = 'left';
    ctx.fillText(spec.unit, 2, top + 2);
  }

  return drawn;
}

/** Границы по времени и значению. */
function computeBounds(spec: PlotSpec): {
  tMin: number;
  tMax: number;
  vMin: number;
  vMax: number;
} {
  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;

  for (const series of spec.series) {
    for (let i = 0; i < series.values.length; i++) {
      const value = series.values[i];
      const time = series.times[i];
      if (!Number.isFinite(value) || !Number.isFinite(time)) continue;
      if (time < tMin) tMin = time;
      if (time > tMax) tMax = time;
      if (value < vMin) vMin = value;
      if (value > vMax) vMax = value;
    }
  }

  if (spec.range) {
    vMin = spec.range[0];
    vMax = spec.range[1];
  }
  if (spec.guide) {
    vMin = Math.min(vMin, spec.guide.value);
    vMax = Math.max(vMax, spec.guide.value);
  }
  if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) {
    tMin = 0;
    tMax = 1;
  }
  if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
    vMin = 0;
    vMax = 1;
  }
  if (vMax - vMin < 1e-9) {
    vMin -= 0.5;
    vMax += 0.5;
  } else {
    const pad = (vMax - vMin) * 0.08;
    vMin -= pad;
    vMax += pad;
  }
  return { tMin, tMax, vMin, vMax };
}

/** Короткое форматирование значения оси. */
function formatAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

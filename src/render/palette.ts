/**
 * Цветовые шкалы и палитра.
 *
 * ─── Правило, которое здесь соблюдается ──────────────────────────────────
 *
 * Верхняя граница шкалы берётся КВАНТИЛЕМ, а не максимумом. Это не
 * придирка: одна аномальная величина (нейрон с абсурдным потенциалом,
 * вес-выброс) превратила бы всех остальных в один цвет, и картинка
 * перестала бы реагировать на изменения. В phys-lab этот дефект реально
 * случался (дефект 30), и здесь он закрыт заранее.
 */

/** Разложение цвета на составляющие 0…1. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Фон сцены. */
export const BACKGROUND = '#0b1018';

/**
 * Цвет покоящегося нейрона.
 *
 * ─── Почему не «почти чёрный» ────────────────────────────────────────────
 *
 * Первая версия красила покой в (0.18, 0.24, 0.34) — тёмно-синий, почти
 * сливающийся с фоном (#0b1018). В режиме раскраски «спайки» покоящиеся
 * нейроны выглядят как пустое поле: глазу не за что зацепиться, и сцена
 * кажется неработающей, хотя спайки идут. Это подтвердили витринные кадры:
 * сеть из 2500 нейронов выглядела пустым прямоугольником с редкими
 * вспышками.
 *
 * Теперь покой заметно светлее фона: рисунок сети виден всегда, а вспышки
 * спайков читаются на нём как яркие точки.
 */
const REST_COLOR: Rgb = { r: 0.36, g: 0.45, b: 0.6 };

/** Цвет возбуждённого нейрона (вспышка спайка). */
const SPIKE_COLOR: Rgb = { r: 1.0, g: 0.92, b: 0.55 };

/** Цвет тормозного нейрона (подсветка типа). */
const INHIBITORY_TINT: Rgb = { r: 0.42, g: 0.62, b: 0.95 };

/** Цвет возбуждающего нейрона (подсветка типа). */
const EXCITATORY_TINT: Rgb = { r: 0.95, g: 0.55, b: 0.42 };

/** Линейная интерполяция двух цветов. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
  };
}

/** Цвет в формат, который понимает Pixi (`0xRRGGBB`). */
export function toHex(color: Rgb): number {
  const clamp = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
  const r = Math.round(clamp(color.r) * 255);
  const g = Math.round(clamp(color.g) * 255);
  const b = Math.round(clamp(color.b) * 255);
  return (r << 16) | (g << 8) | b;
}

/**
 * Квантиль по массиву значений.
 *
 * Реализация через копию и сортировку: значения берутся раз в кадр на
 * выборке, а не на каждом нейроне, поэтому цена приемлема, а простота
 * важнее. При большом числе нейронов выборка прореживается вызывающей
 * стороной.
 */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * (q < 0 ? 0 : q > 1 ? 1 : q);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Шкала «значение → цвет» с устойчивой верхней границей.
 *
 * Границы задаются явно (`scaleRange`) или подбираются квантилями. Второй
 * режим — рабочий: он не даёт выбросу управлять палитрой.
 */
export class ColorScale {
  private low = 0;
  private high = 1;

  /** Обновить границы по выборке значений. */
  fit(values: readonly number[], options: { lowQ?: number; highQ?: number } = {}): void {
    if (values.length === 0) return;
    const lowQ = options.lowQ ?? 0.02;
    const highQ = options.highQ ?? 0.995;
    const low = quantile(values, lowQ);
    const high = quantile(values, highQ);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return;
    this.low = low;
    // Вырожденная выборка (все значения равны) не должна давать деление на
    // ноль: в этом случае оставляем прежний диапазон.
    this.high = high > low ? high : low + 1e-9;
  }

  /** Задать границы вручную. */
  setRange(low: number, high: number): void {
    this.low = low;
    this.high = high > low ? high : low + 1e-9;
  }

  /** Доля от 0 до 1 для значения. */
  normalise(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return (value - this.low) / (this.high - this.low);
  }

  get range(): [number, number] {
    return [this.low, this.high];
  }
}

/** Что кодирует цвет нейрона. */
export type ColorMode =
  /** Потенциал: тёмный покой → яркое возбуждение. */
  | 'potential'
  /** Вспышка спайка: сразу после разряда нейрон светится. */
  | 'spike'
  /** Тип нейрона: возбуждающий или тормозной. */
  | 'type'
  /** Число спайков за прогон: кто активнее. */
  | 'rate';

/**
 * Цвет нейрона по режиму раскраски.
 *
 * Возвращает `0xRRGGBB`. Функция чистая: тесты проверяют её на крайних
 * значениях без всякого рендера.
 */
export function neuronColor(options: {
  mode: ColorMode;
  /** Нормализованный потенциал 0…1 (уже через ColorScale). */
  potential01: number;
  /** Вспышка 0…1. */
  flash: number;
  inhibitory: boolean;
  /** Нормализованная частота 0…1. */
  rate01: number;
}): number {
  switch (options.mode) {
    case 'potential': {
      const base = mix(REST_COLOR, SPIKE_COLOR, options.potential01);
      // Вспышка добавляет яркости ПОВЕРХ раскраски, но слабо (0.3): при
      // 0.6 и живой сети, где разряжается большинство нейронов, все точки
      // окрашивались в цвет спайка, и раскраска по потенциалу исчезала —
      // сцена становилась ровно-жёлтой.
      return toHex(mix(base, SPIKE_COLOR, options.flash * 0.3));
    }
    case 'spike':
      return toHex(mix(REST_COLOR, SPIKE_COLOR, options.flash));
    case 'type':
      return toHex(options.inhibitory ? INHIBITORY_TINT : EXCITATORY_TINT);
    case 'rate':
      return toHex(mix(REST_COLOR, SPIKE_COLOR, options.rate01));
  }
}

/** Цвет связи по её весу. */
export function synapseColor(weight: number, maxMagnitude: number): number {
  const magnitude = Math.abs(weight);
  const t = maxMagnitude > 0 ? magnitude / maxMagnitude : 0;
  if (weight < 0) {
    // Тормозные — синеватые, возбуждающие — тёплые: знак виден сразу.
    return toHex(mix(REST_COLOR, { r: 0.35, g: 0.6, b: 1.0 }, t));
  }
  return toHex(mix(REST_COLOR, { r: 1.0, g: 0.7, b: 0.35 }, t));
}

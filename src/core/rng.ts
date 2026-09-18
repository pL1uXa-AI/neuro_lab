/**
 * Детерминированный генератор случайных чисел.
 *
 * Почему не Math.random: симуляция должна воспроизводиться. Один и тот же
 * seed обязан давать одну и ту же траекторию — иначе нельзя ни отладить
 * редкий дефект, ни сравнить два запуска, ни написать регрессионный тест.
 *
 * Алгоритм — xoshiro128** : быстрый, с хорошим качеством и состоянием всего
 * из четырёх 32-битных слов, которое легко сериализуется.
 *
 * Перенесён из phys-lab без изменений: там он проверен на больших объёмах
 * (термостат Ланжевена требует миллионы нормальных чисел за прогон), и здесь
 * от него требуется то же — воспроизводимость снимков.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed = 0x9e3779b9) {
    // Расширение seed через splitmix32: плохой seed не должен давать
    // вырожденную последовательность (например, все нули).
    let state = seed >>> 0;
    const next = (): number => {
      state = (state + 0x9e3779b9) >>> 0;
      let z = state;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Следующее 32-битное беззнаковое целое. */
  nextUint32(): number {
    // xoshiro128**: result = rotl(s1 * 5, 7) * 9
    const rotated = ((this.s1 * 5) << 7) | ((this.s1 * 5) >>> 25);
    const result = Math.imul(rotated >>> 0, 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return result;
  }

  /** Равномерное число в [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Равномерное число в [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Равномерное целое в [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }

  /**
   * Нормальное распределение (Marsaglia, полярный метод).
   *
   * Точное, но дорогое: около 1.6 вызова `next()` на число из-за отбраковки.
   * Для пуассоновского входа, где нормальные числа нужны миллионами, есть
   * вариант `normalFast`.
   *
   * Парность намеренно не хранится: состояние должно оставаться чисто
   * сериализуемым, иначе восстановление снимка даст другую траекторию.
   */
  normal(): number {
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.next() * 2 - 1;
      v = this.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  }

  /**
   * Быстрое нормальное распределение (Бокс — Мюллер).
   *
   * Ровно два вызова `next()` и один `log`/`sqrt`/`cos` на число, без
   * отбраковки. Второе число пары отбрасывается: кэшировать его нельзя —
   * тогда состояние генератора перестанет быть самодостаточным.
   */
  normalFast(): number {
    const u1 = this.next() || 1e-12;
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Целое из распределения Пуассона (метод Кнута).
   *
   * Нужен для пуассоновского внешнего входа: именно он даёт нерегулярный
   * режим с CV ISI ≈ 1, по которому в проекте проверяется «балансный»
   * режим коры.
   *
   * Для λ > 30 метод Кнута вырождается (экспонента подтекает), поэтому там
   * используется нормальная аппроксимация — этого достаточно, потому что
   * проверяемые величины (частота, CV) от хвоста распределения не зависят.
   */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 30) {
      const value = Math.round(lambda + Math.sqrt(lambda) * this.normalFast());
      return value < 0 ? 0 : value;
    }
    const limit = Math.exp(-lambda);
    let product = this.next();
    let count = 0;
    while (product > limit) {
      count += 1;
      product *= this.next();
    }
    return count;
  }

  /** Снимок состояния — для сохранения воспроизводимости в файле проекта. */
  save(): [number, number, number, number] {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Восстановление состояния. */
  restore(state: readonly [number, number, number, number]): void {
    this.s0 = state[0] >>> 0;
    this.s1 = state[1] >>> 0;
    this.s2 = state[2] >>> 0;
    this.s3 = state[3] >>> 0;
  }
}

/** Ограничение значения отрезком. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Ближайшее целое, лежащее в [0, n). */
export function wrapInt(value: number, n: number): number {
  const m = value % n;
  return m < 0 ? m + n : m;
}

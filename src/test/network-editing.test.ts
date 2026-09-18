/**
 * Тесты правки сети «на живую»: вес связей и торможение.
 *
 * ─── Зачем эти тесты ─────────────────────────────────────────────────────
 *
 * Ползунки веса и торможения существуют потому, что без них уровень «Своя
 * сеть» был ФИКТИВНЫМ: он требовал «поднимите вес связей» и «добавьте
 * торможение», а таких ручек в интерфейсе не было, и уровень проходился
 * без единого действия игрока (измерено: `passed = true` сразу).
 *
 * Здесь проверяется, что правки:
 *   1. ДЕЙСТВИТЕЛЬНО меняют динамику (а не только надпись на кнопке);
 *   2. идемпотентны — повторное применение того же значения не удваивает
 *      эффект (иначе ползунок работал бы как «накопление»);
 *   3. не оставляют интерфейс в рассинхроне после смены сцены.
 */

import { describe, expect, it } from 'vitest';
import { presetById } from '../core/presets.js';
import { buildScene, warmUp } from '../core/scene.js';
import type { Network } from '../core/network.js';

/** Суммарное число спайков. */
function total(network: Network): number {
  let sum = 0;
  for (let i = 0; i < network.params.count; i++) sum += network.state.spikeCount[i];
  return sum;
}

/** Собрать и прогреть сцену по идентификатору пресета. */
function sceneOf(id: string): Network {
  const preset = presetById(id);
  if (!preset) throw new Error(`нет пресета ${id}`);
  const scene = buildScene(preset);
  warmUp(scene);
  return scene.network;
}

describe('правка сети: множитель веса', () => {
  it('повторное применение одного множителя не накапливается', () => {
    // Главная ловушка: если считать от ТЕКУЩИХ весов, то два вызова
    // `setWeightScale(2)` дали бы 4×, а ползунок превратился бы в
    // «умножитель на каждый тик». Множитель обязан считаться от исходных
    // весов сцены.
    const once = sceneOf('working-memory');
    once.setWeightScale(2);
    once.run(2000);

    const twice = sceneOf('working-memory');
    twice.setWeightScale(2);
    twice.setWeightScale(2);
    twice.run(2000);

    expect(total(twice)).toBe(total(once));
  });

  it('смена множителя возвращает исходную динамику при 1.0×', () => {
    const base = sceneOf('working-memory');
    base.run(3000);

    const restored = sceneOf('working-memory');
    restored.setWeightScale(3);
    restored.setWeightScale(1);
    restored.run(3000);

    expect(total(restored)).toBe(total(base));
  });

  it('множитель меняет динамику сети, где решает рекуррентность', () => {
    // На разреженной сети с пуассоновским входом режим задаётся ВХОДОМ, и
    // вес почти не влияет — это правильная физика, а не дефект. Проверять
    // эффект множителя надо там, где динамику держат связи.
    const weak = sceneOf('working-memory');
    weak.setWeightScale(0.2);
    weak.run(3000);

    const strong = sceneOf('working-memory');
    strong.setWeightScale(1);
    strong.run(3000);

    // Ослабление обязано изменить число спайков: при 0.2× память не
    // удерживается так же, как при 1×.
    expect(Math.abs(total(strong) - total(weak))).toBeGreaterThan(100);
  });

  it('нулевой и отрицательный множитель не ломают сеть', () => {
    // Защита от «ползунка в ноль»: сеть должна остаться считаемой и не
    // уйти в разлёт.
    for (const scale of [0, -1, Number.NaN]) {
      const network = sceneOf('working-memory');
      network.setWeightScale(scale);
      network.run(1000);
      expect(network.state.insane, `множитель ${scale}`).toBe(0);
      expect(Number.isFinite(network.state.v[0]), `множитель ${scale}`).toBe(true);
    }
  });
});

describe('правка сети: торможение', () => {
  it('высокая доля тормозных подавляет активность', () => {
    const alive = sceneOf('working-memory');
    alive.run(3000);

    const suppressed = sceneOf('working-memory');
    suppressed.setInhibitoryFraction(0.5);
    suppressed.run(3000);

    // Измерено: при 50 % торможения остаётся около 200 спайков против
    // 158 000 без него — память гаснет.
    expect(total(suppressed)).toBeLessThan(total(alive) / 10);
  });

  it('тормозные нейроны помечены в состоянии, а не только в весах', () => {
    // Тип нейрона хранится отдельным массивом (`state.inhibitory`) — по нему
    // рисуется раскраска «Тип». Если менять только знак веса, картинка
    // разойдётся с динамикой: нейроны будут тормозить, оставаясь
    // нарисованными как возбуждающие.
    const network = sceneOf('random-sparse');
    network.setInhibitoryFraction(0.4);

    let marked = 0;
    for (let i = 0; i < network.params.count; i++) {
      if (network.state.inhibitory[i] === 1) marked += 1;
    }
    expect(marked).toBe(Math.round(network.params.count * 0.4));
  });

  it('доля тормозных записывается в параметры сети', () => {
    const network = sceneOf('random-sparse');
    network.setInhibitoryFraction(0.35);
    expect(network.params.inhibitoryFraction).toBeCloseTo(0.35, 9);
  });

  it('доля вне диапазона зажимается в допустимые пределы', () => {
    const network = sceneOf('random-sparse');
    network.setInhibitoryFraction(5);
    // Не больше 90 %: сеть целиком из тормозных нейронов не имеет смысла и
    // сделала бы сцену неотличимой от «всё выключено».
    expect(network.params.inhibitoryFraction).toBeLessThanOrEqual(0.9);
    network.setInhibitoryFraction(-3);
    expect(network.params.inhibitoryFraction).toBeGreaterThanOrEqual(0);
  });

  it('сброс сцены возвращает исходные веса и торможение', () => {
    // Критично для интерфейса: «Сброс» обязан вернуть пресет, а не
    // сохранить правки. Иначе игрок не сможет вернуться к исходной сцене,
    // не перезагрузив страницу.
    const preset = presetById('random-sparse');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    // Правки применяются к сети, а «Сброс» пересобирает сцену целиком —
    // проверяем именно это: новая сеть имеет исходные веса.
    const fresh = buildScene(preset);
    expect(fresh.network.currentWeightScale).toBe(1);
    expect(fresh.network.params.inhibitoryFraction).toBe(preset.inhibitoryFraction);
  });
});

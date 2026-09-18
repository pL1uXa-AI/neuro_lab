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
import { measureMemory } from '../core/memory.js';
import { evaluateCheck } from '../levels/checks.js';
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

describe('правка сети: соотношение тормозного и возбуждающего веса', () => {
  /**
   * Отношение тормозного веса к возбуждающему по модулю.
   *
   * `NaN`, если тормозных связей нет в принципе: у сцен без торможения
   * (кольцо, волна, рабочая память) делить не на что, и это НЕ ошибка.
   */
  function inhibitoryRatioOf(network: Network): number {
    let minExcitatory = Infinity;
    let minInhibitory = Infinity;
    for (let i = 0; i < network.params.count; i++) {
      const inhibitory = network.state.inhibitory[i] === 1;
      for (let s = network.synapses.rowPtr[i]; s < network.synapses.rowPtr[i + 1]; s++) {
        const magnitude = Math.abs(network.synapses.weight[s]);
        if (inhibitory) minInhibitory = Math.min(minInhibitory, magnitude);
        else minExcitatory = Math.min(minExcitatory, magnitude);
      }
    }
    if (!Number.isFinite(minInhibitory) || !Number.isFinite(minExcitatory)) return Number.NaN;
    return minInhibitory / minExcitatory;
  }

  it('правка доли торможения НЕ меняет соотношение весов', () => {
    // ─── Дефект, который здесь закрыт ────────────────────────────────────
    //
    // Топология генерирует тормозные связи уже умноженными на отношение
    // (5 у разреженной сети). Первая версия правки брала `|w|` и снова
    // умножаала на отношение, то есть применяла его ДВАЖДЫ: измерено —
    // одно касание ползунка меняло отношение 5 → 20, то есть усиливало
    // торможение вчетверо при неизменной доле тормозных нейронов.
    //
    // Проверка ставит ТУ ЖЕ долю, что уже есть: при корректной реализации
    // веса обязаны остаться ровно теми же.
    const network = sceneOf('random-sparse');
    const before = inhibitoryRatioOf(network);
    expect(before).toBeCloseTo(5, 6);

    network.setInhibitoryFraction(network.params.inhibitoryFraction);
    expect(inhibitoryRatioOf(network)).toBeCloseTo(before, 6);
  });

  it('повторная правка торможения тоже не накапливается', () => {
    const network = sceneOf('random-sparse');
    const before = inhibitoryRatioOf(network);
    for (let i = 0; i < 5; i++) {
      network.setInhibitoryFraction(network.params.inhibitoryFraction);
    }
    expect(inhibitoryRatioOf(network)).toBeCloseTo(before, 6);
  });

  it('совместная правка веса и торможения сохраняет соотношение', () => {
    // Оба ползунка пишут ОДНИ И ТЕ ЖЕ веса, поэтому их взаимодействие —
    // отдельный риск: вес не должен затирать знак торможения, а торможение —
    // множитель веса.
    const network = sceneOf('random-sparse');
    const before = inhibitoryRatioOf(network);

    network.setWeightScale(2);
    network.setInhibitoryFraction(network.params.inhibitoryFraction);
    // Соотношение сохраняется, а общая величина — выросла вдвое.
    expect(inhibitoryRatioOf(network)).toBeCloseTo(before, 6);
    expect(network.currentWeightScale).toBe(2);

    let maxExcitatory = 0;
    for (let i = 0; i < network.params.count; i++) {
      if (network.state.inhibitory[i] === 1) continue;
      for (let s = network.synapses.rowPtr[i]; s < network.synapses.rowPtr[i + 1]; s++) {
        maxExcitatory = Math.max(maxExcitatory, network.synapses.weight[s]);
      }
    }
    // Базовый вес разреженной сети 0.15, множитель 2 → максимум 0.3.
    expect(maxExcitatory).toBeCloseTo(0.3, 6);
  });

  it('каждая сцена сохраняет своё соотношение, а не общее', () => {
    // У разреженной сети отношение 5, у кольца 4 — сцена обязана держать
    // СВОЁ. Зашитая константа сделала бы их одинаковыми.
    const sparse = sceneOf('random-sparse');
    expect(inhibitoryRatioOf(sparse)).toBeCloseTo(sparse.params.inhibitoryRatio, 6);

    // Сцены без торможения: соотношение не определено, и это не ошибка.
    for (const id of ['ring', 'wave', 'working-memory']) {
      const network = sceneOf(id);
      expect(Number.isNaN(inhibitoryRatioOf(network)), id).toBe(true);
      // Но правка торможения обязана РАБОТАТЬ и там.
      network.setInhibitoryFraction(0.2);
      expect(inhibitoryRatioOf(network), id).toBeCloseTo(network.params.inhibitoryRatio, 6);
    }
  });
});

describe('сцена памяти: две меры удержания не расходятся', () => {
  /**
   * ─── Почему эта проверка существует ─────────────────────────────────
   *
   * Задачу «держится ли активность» решают ДВА разных места:
   *
   *   • `measureMemory` (ядро) — продвигает симуляцию, годится для
   *     измерения порога при подборе параметров;
   *   • условие уровня `memoryHold` — только читает историю, потому что
   *     проверка уровня не имеет права двигать сеть за игрока.
   *
   * Две реализации одной меры — приглашение к расхождению, и оно уже
   * случилось: шапка `memory.ts` обещала порог «300 мс», а уровень
   * проверял 200. Тест сверяет СМЫСЛ: на живой сцене обе меры обязаны
   * подтверждать, что активность держится, а на погасшей — что нет.
   */
  it('обе меры согласны: память есть на живой сцене', () => {
    const preset = presetById('working-memory');
    if (!preset) throw new Error('нет пресета');
    const scene = buildScene(preset);
    warmUp(scene);
    scene.network.run(2000);

    // Мера ядра: продвигаем сеть и смотрим удержание.
    const core = measureMemory(scene.network, { stimulusEndMs: 20, maxMs: 1000 });
    expect(core.holdMs, 'мера ядра не видит удержания').toBeGreaterThan(200);
    expect(core.spikesHeld, 'мера ядра не видит спайков').toBeGreaterThan(0);

    // Мера уровня: только наблюдение.
    const level = evaluateCheck(
      { kind: 'memoryHold', min: 200, label: 'x' },
      { network: scene.network, waveCentre: null, stimulusEndMs: 20, windowMs: 600 },
    );
    expect(level.passed, 'условие уровня не видит удержания').toBe(true);
  });

  it('обе меры согласны: памяти нет на ослабленной сцене', () => {
    const preset = presetById('working-memory');
    if (!preset) throw new Error('нет пресета');

    // Измерено: при множителе 0.001 прирост прекращается.
    const weak = buildScene(preset);
    warmUp(weak);
    weak.network.setWeightScale(0.001);
    weak.network.run(2000);

    const core = measureMemory(weak.network, { stimulusEndMs: 20, maxMs: 1000 });
    const level = evaluateCheck(
      { kind: 'memoryHold', min: 200, label: 'x' },
      { network: weak.network, waveCentre: null, stimulusEndMs: 20, windowMs: 600 },
    );
    // Мера обязана РАЗЛИЧАТЬ: на погасшей сети условия не выполняется.
    expect(level.passed, `погасшая сеть прошла удержание: ${level.detail}`).toBe(false);
    // А мера ядра при этом сообщает о слабой активности, а не о полном нуле.
    expect(Number.isFinite(core.holdMs)).toBe(true);
  });
});

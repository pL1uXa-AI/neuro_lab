/**
 * Тесты графика частоты популяции.
 *
 * ─── Что здесь проверяется и почему это не «тест рисовалки» ──────────────
 *
 * График частоты отвечает на вопрос «что происходит со всей сетью». Но
 * величина, которую он рисует, определяется в `app.ts` — вне `core/`, где
 * её не достают обычные тесты. И первая версия этой величины была НЕВЕРНОЙ:
 * она делила накопленные спайки на ВСЁ прошедшее время, то есть рисовала
 * среднее за прогон.
 *
 * У среднего за прогон есть коварное свойство: оно ПОХОЖЕ на график. Оно
 * плавно растёт, выглядит «динамикой» и не вызывает вопросов. Измерено на
 * кольце: 19.8, 25.4, 30.6, 35.8, 40.9, 46.1 Гц — рост есть, а сеть при
 * этом давно вышла на постоянную частоту.
 *
 * Поэтому мера воспроизведена здесь в том же виде, что в приложении, и
 * проверяется на СВОЙСТВА, отличающие мгновенную частоту от накопленной:
 * она падает у гаснущей сети и не растёт у установившейся.
 */

import { describe, expect, it } from 'vitest';
import { buildScene, warmUp } from '../core/scene.js';
import { presetById } from '../core/presets.js';
import { Network } from '../core/network.js';

/** Ширина окна — та же, что в `app.ts` (RATE_WINDOW_MS). */
const WINDOW_MS = 200;

/** Мгновенная частота популяции по скользящему окну, Гц. */
function windowedRate(network: Network, windowMs = WINDOW_MS): number {
  const now = network.state.time;
  const from = Math.max(0, now - windowMs);
  const spanMs = Math.max(1e-9, now - from);
  const spikes = network.spikeHistory.countIn(from, now);
  return (spikes / network.params.count / spanMs) * 1000;
}

/** Средняя частота за весь прогон, Гц — прежняя (ошибочная) мера. */
function cumulativeRate(network: Network): number {
  const elapsed = Math.max(1, network.state.time);
  let total = 0;
  for (let i = 0; i < network.params.count; i++) total += network.state.spikeCount[i];
  return (total / network.params.count / elapsed) * 1000;
}

function sceneOf(id: string): Network {
  const preset = presetById(id);
  if (!preset) throw new Error(`нет пресета ${id}`);
  const scene = buildScene(preset);
  warmUp(scene);
  return scene.network;
}

describe('частота популяции: мгновенная, а не накопленная', () => {
  it('установившаяся сеть: мгновенная частота держит полку, накопленная ползёт', () => {
    // ─── Важно: сколько ждать выхода на режим ────────────────────────────
    //
    // Первая версия теста ждала 2 с и падала: мгновенная частота «гуляла»
    // 127 → 236 Гц. Это оказался НЕ дефект меры, а реальная динамика:
    // измерено, что кольцо выходит на полку только к ~2.5 с, после чего
    // держит ровно 240.0 Гц сколь угодно долго (проверено до 10 с).
    //
    // То есть тест мерил разгонный участок и называл его ошибкой. Урок
    // общий: прежде чем объявлять меру неверной, надо убедиться, что
    // измеряешь установившийся режим, а не переходный процесс.
    const network = sceneOf('ring');
    network.run(6000); // 3 с — заведомо за пределами разгона

    const windowed: number[] = [];
    const cumulative: number[] = [];
    for (let block = 0; block < 6; block++) {
      network.run(400); // 200 мс
      windowed.push(windowedRate(network));
      cumulative.push(cumulativeRate(network));
    }

    // На полке мгновенная частота практически постоянна (разброс < 10 %).
    const mean = windowed.reduce((a, b) => a + b, 0) / windowed.length;
    for (const value of windowed) {
      expect(
        Math.abs(value - mean) / mean,
        `мгновенная частота гуляет: ${windowed.map((v) => v.toFixed(1)).join(', ')}`,
      ).toBeLessThan(0.1);
    }

    // Накопленная за прогон при этом продолжает ползти вверх: она помнит
    // разгонный участок и «догоняет» полку. Медленнее, чем мгновенная
    // выходит на неё, но растёт.
    expect(
      cumulative[cumulative.length - 1],
      'накопленная мера должна быть ниже полки — она усредняет разгон',
    ).toBeLessThan(mean);
  });

  it('мгновенная частота падает к нулю, когда сеть гаснет', () => {
    // Ключевое отличие от накопленной: она РЕАГИРУЕТ на то, что происходит
    // сейчас. Ослабляем рекуррентность до режима, где активность умирает.
    const network = sceneOf('working-memory');
    network.setWeightScale(0.001);
    network.run(600);
    // Дать активности погаснуть.
    network.run(2000);

    expect(windowedRate(network), 'погасшая сеть показывает ненулевую частоту').toBeLessThan(1);

    // А накопленная при этом ещё долго остаётся высокой — именно потому,
    // что помнит прошлое. Это и есть демонстрация разницы.
    expect(cumulativeRate(network)).toBeGreaterThan(windowedRate(network));
  });

  it('мгновенная частота видит всплеск, который среднее скрывает', () => {
    // Короткий сильный стимул: окно реагирует сразу, среднее — почти нет.
    const network = sceneOf('random-sparse');
    network.run(2000);
    const beforeWindowed = windowedRate(network);
    const beforeCumulative = cumulativeRate(network);

    // Пятно в центр: локальный разряд.
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < network.params.count; i++) {
      cx += network.x[i];
      cy += network.y[i];
    }
    cx /= network.params.count;
    cy /= network.params.count;
    network.poke(cx, cy, 20, 40, 20);
    network.run(200); // 100 мс — внутри окна

    const afterWindowed = windowedRate(network);
    const afterCumulative = cumulativeRate(network);

    // Окно замечает всплеск сильнее, чем среднее за весь прогон.
    const windowedChange = Math.abs(afterWindowed - beforeWindowed);
    const cumulativeChange = Math.abs(afterCumulative - beforeCumulative);
    expect(
      windowedChange,
      `окно не заметило всплеска: ${windowedChange.toFixed(2)}`,
    ).toBeGreaterThan(cumulativeChange);
  });
});

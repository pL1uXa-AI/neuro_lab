/**
 * Витринные кадры и проверка того, что сцена НЕ пуста.
 *
 * Запуск: node scripts/showcase.mjs
 * Требует запущенного предпросмотра (`npm run preview`) на http://localhost:4175.
 *
 * ─── Зачем это отдельно от смоука ────────────────────────────────────────
 *
 * Смоук отвечает на вопрос «работает ли». Здесь мы смотрим, как это
 * ВЫГЛЯДИТ: снимаем кадры каждой сцены и сохраняем в `docs/images/`.
 * Кадры попадают в README, поэтому их вид — часть результата, а не
 * побочный продукт.
 *
 * ─── Почему проверяется ЯРКОСТЬ, а не только «нет ошибок» ────────────────
 *
 * Скрипт падает, если сцена оказалась почти пустой. Это не перестраховка:
 * именно так был найден реальный дефект — в режиме раскраски «спайки»
 * покоящиеся нейроны рисовались почти чёрным на чёрном фоне, и сцена
 * выглядела пустой, хотя все остальные проверки проходили.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { findBrowser, launchBrowser, stopBrowser, waitForTarget } from './browser.mjs';
import { connectCdp } from './cdp.mjs';
import { brightFraction, decodePng } from './png.mjs';

const TARGET_URL = process.env['SHOWCASE_URL'] ?? 'http://localhost:4175/';
const DEBUG_PORT = 9339;
const OUT_DIR = 'docs/images';

/**
 * Что снимаем.
 *
 * `minFillPercent` — минимальная доля заметно светящихся пикселей сцены.
 * Пороги выставлены по ФАКТИЧЕСКИМ замерам (см. вывод скрипта), а не на
 * глаз: у одиночного нейрона на экране мало точек, у волны и сети — много.
 */
const SHOTS = [
  { name: 'single-neuron', preset: 'single-lif', steps: 900, title: 'Один нейрон', minFillPercent: 0.05 },
  { name: 'bursting', preset: 'single-bursting', steps: 600, title: 'Пачки', minFillPercent: 0.05 },
  { name: 'network', preset: 'random-sparse', steps: 3000, title: 'Разреженная сеть', minFillPercent: 0.5 },
  { name: 'stdp', preset: 'stdp-learning', steps: 4000, title: 'Обучение STDP', minFillPercent: 0.5 },
  {
    name: 'wave',
    preset: 'wave',
    // ВАЖНО: волна снимается РАНО. Задержка связи задана как
    // расстояние / скорость (≈3.8 клетки за мс), поэтому на решётке 50×50
    // фронт проходит всю сеть примерно за 13 мс. При 260 шагах (130 мс)
    // кадр снимался уже ПОСЛЕ того, как волна ушла за край, и сцена
    // выглядела пустой. 24 шага — это 12 мс, фронт в середине пути.
    steps: 24,
    title: 'Волна активности',
    minFillPercent: 1.0,
  },
  { name: 'memory', preset: 'working-memory', steps: 2500, title: 'Рабочая память', minFillPercent: 0.3 },
  {
    name: 'pulses',
    preset: 'wave',
    // Кадр визуализации импульсов. Волна снимается рано (24 шага = 12 мс):
    // за это время фронт проходит половину решётки, и следы передач видны
    // как поток вдоль связей. Позже они сливаются — решётка разряжается
    // целиком, и яркость приглушается по плотности (см. `drawPulses`).
    steps: 30,
    title: 'Проход импульсов по синапсам',
    minFillPercent: 1.0,
  },
];

async function main() {
  const browser = findBrowser();
  mkdirSync(OUT_DIR, { recursive: true });

  const child = launchBrowser({
    browser,
    port: DEBUG_PORT,
    profileDir: '.verify/chrome-profile-showcase',
    url: TARGET_URL,
  });

  const results = [];
  let cdp = null;
  try {
    const target = await waitForTarget(DEBUG_PORT);
    cdp = await connectCdp(target);
    await cdp.send('Runtime.enable');

    for (let attempt = 0; attempt < 60; attempt++) {
      if (await cdp.evaluate('Boolean(window.__neuroLab)')) break;
      await delay(500);
    }

    // При первом запуске приложение само показывает справку, и она
    // НАКРЫВАЕТ сцену: витринные кадры получались пустыми — на них был
    // диалог вместо сети. Закрываем её перед съёмкой.
    //
    // Ждём дольше задержки показа (800 мс в `main.ts`) и закрываем ПОСЛЕ
    // неё: иначе справка появлялась уже во время съёмки и накрывала сцену.
    // Дефект не проявлялся только потому, что профиль `.verify` сохранялся
    // между прогонами вместе с флагом «справку уже видели» — на чистом
    // профиле кадры получались с диалогом.
    await delay(1200);
    await cdp.evaluate('window.__neuroLab.actions.closeHelp()');
    await delay(200);

    // Симуляция ставится на паузу: иначе между постановкой сцены и снятием
    // кадра живой цикл продолжает считать, и волна успевает уйти за край.
    await cdp.evaluate('window.__neuroLab.actions.toggleRun()');
    await delay(200);

    for (const shot of SHOTS) {
      await cdp.evaluate(`window.__neuroLab.actions.applyPreset(${JSON.stringify(shot.preset)})`);
      await cdp.evaluate(`window.__neuroLab.actions.runSteps(${shot.steps})`);
      await delay(350);

      // ─── Что измеряется и что сохраняется ─────────────────────────────
      // ИЗМЕРЯЕТСЯ область сцены: доля светящихся пикселей отвечает на
      // вопрос «видна ли сеть», и панели интерфейса в неё попадать не
      // должны — иначе проверка меряет вёрстку, а не нейроны.
      //
      // СОХРАНЯЕТСЯ вся страница: приборы (осциллограф и растровая
      // диаграмма) — половина смысла проекта. Первая версия сохраняла
      // только сцену, и кадр одиночного нейрона выглядел пустым
      // прямоугольником с одной точкой, хотя подпись в README обещала
      // «осциллограф внизу».
      const clip = await cdp.evaluate(`(() => {
        const host = document.querySelector('.stage');
        const rect = host.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
      })()`);
      const sceneShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
      const image = decodePng(Buffer.from(sceneShot.data, 'base64'));
      const fill = brightFraction(image);

      const probe = JSON.parse(await cdp.evaluate('JSON.stringify(window.__neuroLab.probe())'));
      const ok = fill >= shot.minFillPercent;

      let file = '';
      if (ok) {
        const fullShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        file = `${OUT_DIR}/${shot.name}.png`;
        writeFileSync(file, Buffer.from(fullShot.data, 'base64'));
      }

      results.push({
        title: shot.title,
        ok,
        fill,
        required: shot.minFillPercent,
        neurons: probe.neuronCount,
        spikes: probe.spikesTotal,
        bright: `${image.width}×${image.height}`,
      });
    }
  } finally {
    if (cdp) cdp.close();
    // Останавливается ТОЛЬКО свой экземпляр, вместе с потомками.
    stopBrowser(child);
  }

  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    process.stdout.write(
      `${result.ok ? '  ✓' : '  ×'} ${result.title} — ${result.fill.toFixed(2)} % ` +
        `светящихся (нужно ≥ ${result.required} %), нейронов ${result.neurons}, ` +
        `спайков ${result.spikes}\n`,
    );
  }  process.stdout.write(
    `\nКадров: ${results.length}, снято: ${results.filter((r) => r.ok).length}, провалено: ${failed}\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Витрина не запустилась: ${String(error)}\n`);
  process.exitCode = 1;
});

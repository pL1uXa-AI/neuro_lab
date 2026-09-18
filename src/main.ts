/**
 * Точка входа приложения.
 *
 * Задачи: создать Pixi-приложение, поднять интерфейс, выставить публичный
 * API и перехватить ошибки. Перехват ошибок нужен не «на всякий случай»:
 * сквозная проверка в браузере (`npm run smoke`) читает их список, и без
 * этого любая ошибка в кадре осталась бы незамеченной — юнит-тесты её не
 * увидят, потому что они не запускают браузер.
 */

import './ui/styles.css';
import { Application } from 'pixi.js';
import { App } from './app/app.js';
import { BACKGROUND } from './render/palette.js';

/** Глобальные объекты, которые читает смоук-тест. */
interface SmokeSink {
  __smokeErrors?: string[];
  __neuroLab?: unknown;
}

async function main(): Promise<void> {
  const sink = window as unknown as SmokeSink;
  sink.__smokeErrors = sink.__smokeErrors ?? [];

  window.addEventListener('error', (event) => {
    sink.__smokeErrors?.push(String(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    sink.__smokeErrors?.push(`unhandledrejection: ${String(event.reason)}`);
  });

  const host = document.getElementById('app');
  if (!host) throw new Error('Не найден контейнер #app');

  const pixi = new Application();
  await pixi.init({
    // Размер выставит SceneRenderer при первой подгонке под сцену.
    width: 800,
    height: 600,
    background: BACKGROUND,
    antialias: true,
    // Canvas-фолбэк оставляем: приложение должно работать и там, где WebGL
    // отключён (например, в headless-проверке).
    preference: 'webgl',
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
  });

  const app = new App(host, pixi);
  await app.init();
  sink.__neuroLab = app.api();

  // Первый запуск: показать справку. Она же объясняет, что вообще происходит.
  const seen = localStorage.getItem('neuro-lab.seen-help');
  if (!seen) {
    localStorage.setItem('neuro-lab.seen-help', '1');
    // Небольшая задержка: дать сцене отрисоваться, чтобы справка не
    // перекрывала пустой экран.
    setTimeout(() => app.api().actions.openHelp(), 800);
  }
}

main().catch((error: unknown) => {
  const sink = window as unknown as SmokeSink;
  sink.__smokeErrors?.push(`boot: ${String(error)}`);
  const host = document.getElementById('app');
  if (host) host.textContent = `Не удалось запустить приложение: ${String(error)}`;
  console.error(error);
});

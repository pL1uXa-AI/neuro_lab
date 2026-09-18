/**
 * Запуск и остановка своего headless-браузера для проверок.
 *
 * ─── Зачем отдельный модуль ──────────────────────────────────────────────
 *
 * Здесь собраны два правила, каждое из которых появилось после реальной
 * ошибки, а не «на всякий случай».
 *
 * ─── 1. Останавливать ТОЛЬКО свой процесс, и вместе с потомками ──────────
 *
 * `child.kill()` в Windows убивает лишь сам процесс, но не дерево: Chrome
 * запускает по десятку дочерних процессов на окно, и они остаются висеть.
 * За несколько прогонов накопилось 72 процесса — при том что проверок было
 * всего две.
 *
 * Лечить это «убить все chrome.exe» КАТЕГОРИЧЕСКИ НЕЛЬЗЯ: на машине
 * разработчика открыт его собственный браузер, и такая «уборка» закрывает
 * пользователю окна вместе с его работой. Это уже произошло однажды.
 * Поэтому используется `taskkill /PID <свой> /T /F` — только своё дерево.
 *
 * ─── 2. Свой профиль и свой порт отладки ────────────────────────────────
 *
 * Отдельный `--user-data-dir` не даёт задеть профиль пользователя, а
 * отдельный порт — подключиться к его окну. Именно это позволяет проверкам
 * работать, не мешая человеку за той же машиной.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

/** Где искать браузер. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** Найти установленный браузер. */
export function findBrowser() {
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  throw new Error('Не найден Chrome/Edge для сквозной проверки');
}

/** HTTP-запрос к протоколу DevTools. */
export function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('таймаут запроса к DevTools')));
  });
}

/** Дождаться цели отладки. */
export async function waitForTarget(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await httpJson(port, '/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Браузер ещё не поднялся — ждём дальше.
    }
    if (Date.now() > deadline) throw new Error('Браузер не открыл порт отладки');
    await delay(300);
  }
}

/**
 * Запустить только свой headless-браузер.
 *
 * Флаги повторяют проверенную связку из соседнего проекта: без
 * `--no-sandbox` браузер в этой среде завершается с кодом 21 и порт
 * отладки не открывает, а `--use-gl=swiftshader` даёт программный
 * рендеринг, без которого WebGL в headless может не подняться.
 */
export function launchBrowser(options) {
  const { port, profileDir, url, browser } = options;
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--no-first-run',
      '--disable-extensions',
      // Отдельный профиль: профиль пользователя не трогаем.
      `--user-data-dir=${resolve(profileDir)}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1600,1000',
      url,
    ],
    { stdio: 'ignore' },
  );
  return child;
}

/**
 * Остановить ТОЛЬКО запущенный этим скриптом браузер, вместе с потомками.
 *
 * `taskkill /T` снимает дерево процессов, `/F` — без диалогов. Порт и PID
 * берутся свои, поэтому чужие окна не задеваются. На не-Windows `taskkill`
 * отсутствует — там достаточно `kill`.
 */
export function stopBrowser(child) {
  if (!child || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Если taskkill недоступен, пробуем обычный kill.
      try {
        child.kill();
      } catch {
        /* процесс уже завершился */
      }
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* процесс уже завершился */
  }
}

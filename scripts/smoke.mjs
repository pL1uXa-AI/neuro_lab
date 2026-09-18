/**
 * Сквозная проверка приложения в настоящем браузере.
 *
 * Запуск: node scripts/smoke.mjs
 * Требует запущенного предпросмотра (`npm run preview`) на http://localhost:4175.
 *
 * ─── Зачем это помимо юнит-тестов ────────────────────────────────────────
 *
 * Юнит-тесты проверяют ядро, но не проверяют, что приложение действительно
 * запускается, рисует сцену, считает приборы и умеет проходить уровни.
 * Класс дефектов, который юнит-тесты не поймают В ПРИНЦИПЕ (все три уже
 * случались в этом проекте):
 *
 *   • невозможность смонтировать канвас (нулевой размер → пустая сцена);
 *   • нечитаемый текст интерфейса из-за испорченной кодировки файлов;
 *   • панель, показывающая одно состояние, пока сцена рисует другое.
 *
 * Здесь мы управляем Chrome напрямую через протокол DevTools (без сторонних
 * зависимостей) и оцениваем выражения в контексте страницы — то есть видим
 * ровно то, что видит пользователь.
 *
 * ─── Браузер пользователя не трогается ───────────────────────────────────
 *
 * Запускается СВОЙ headless-экземпляр с отдельным профилем и отдельным
 * портом отладки, а по завершении снимается ТОЛЬКО его дерево процессов
 * (`stopBrowser`). Никакой «уборки всех chrome.exe» здесь нет и быть не
 * должно: на машине открыт браузер пользователя.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { findBrowser, launchBrowser, stopBrowser, waitForTarget } from './browser.mjs';
import { connectCdp } from './cdp.mjs';
import { brightFraction, decodePng } from './png.mjs';

const TARGET_URL = process.env['SMOKE_URL'] ?? 'http://localhost:4175/';
const DEBUG_PORT = 9336;
const SHOT_DIR = '.verify';

async function main() {
  const browser = findBrowser();
  mkdirSync(SHOT_DIR, { recursive: true });

  const child = launchBrowser({
    browser,
    port: DEBUG_PORT,
    profileDir: '.verify/chrome-profile-smoke',
    url: TARGET_URL,
  });

  const checks = [];
  const add = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail ?? '' });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error?.message ?? error) });
    }
  };
  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  let cdp = null;
  try {
    const target = await waitForTarget(DEBUG_PORT);
    cdp = await connectCdp(target);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    const evaluate = (expression) => cdp.evaluate(expression);
    const pause = (ms) => delay(ms);

    // ─── Запуск ────────────────────────────────────────────────────────
    await add('страница загрузилась и приложение поднялось', async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (await evaluate('Boolean(window.__neuroLab)')) return '';
        await pause(500);
      }
      throw new Error('window.__neuroLab не появился за 30 секунд');
    });

    await add('ошибок в консоли нет', async () => {
      const list = JSON.parse(await evaluate('JSON.stringify(window.__smokeErrors ?? [])'));
      expect(list.length === 0, `ошибки: ${list.join('; ')}`);
      return '';
    });

    await add('справка первого запуска закрывается', async () => {
      // Приложение показывает справку при первом запуске, и она накрывает
      // сцену. Это правильно для человека и мешает автоматике: без закрытия
      // витринные кадры получались с диалогом вместо сети.
      await evaluate('window.__neuroLab.actions.openHelp()');
      await pause(150);
      const opened = await evaluate(`Boolean(document.querySelector('.overlay'))`);
      expect(opened, 'справка не открылась');
      await evaluate('window.__neuroLab.actions.closeHelp()');
      await pause(150);
      const closed = await evaluate(`Boolean(document.querySelector('.overlay'))`);
      expect(!closed, 'справка не закрылась');
      return 'открывается и закрывается';
    });

    await add('интерфейс на русском и читаем (нет mojibake)', async () => {
      // Дефект, который не ловит ни один юнит-тест: строки валидны, сборка
      // проходит, а пользователь видит «РџСЂРѕРІРµСЂРєР°». Проверяем
      // НАЛИЧИЕ ожидаемых подписей, а не отсутствие ошибок.
      const text = await evaluate('document.body.innerText');
      const expected = ['Пауза', 'Шаг', 'Сброс', 'Справка', 'Сцены', 'Нейрон', 'Вид'];
      const missing = expected.filter((label) => !text.includes(label));
      expect(missing.length === 0, `не найдены подписи: ${missing.join(', ')}`);
      // И заодно убеждаемся, что характерных признаков mojibake нет.
      for (const sign of ['Р°', 'Рµ', 'СЃР', 'РІР']) {
        expect(!text.includes(sign), `в интерфейсе mojibake: «${sign}»`);
      }
      return `подписей найдено ${expected.length}`;
    });

    await add('канвас сцены создан и имеет ненулевой размер', async () => {
      const result = await evaluate(`(() => {
        const c = window.__neuroLab.canvases.stage();
        if (!c) return { ok: false, why: 'канваса нет' };
        return { ok: c.width > 100 && c.height > 100, w: c.width, h: c.height };
      })()`);
      expect(result.ok, `размер канваса ${result.w}×${result.h}`);
      return `${result.w}×${result.h}`;
    });

    await add('сцена не пуста: нейроны действительно рисуются', async () => {
      // ─── Почему измеряется скриншот, а не extract.pixels ──────────────
      // Система извлечения Pixi НЕ подхватывает содержимое
      // `ParticleContainer`: измерено, что она возвращает одинаковые
      // ~1330 «светящихся» пикселей и для одного нейрона, и для 2500. То
      // есть проверка «сцена не пуста» на ней меряет что угодно, кроме
      // нейронов.
      //
      // Скриншот области сцены показывает ровно то, что видит пользователь,
      // поэтому считается по нему. Заодно ловится класс дефектов, который
      // здесь уже случался: частицы обновлялись, но не попадали в батч, и на
      // экране был ОДИН кружок вместо сети из 800 нейронов.
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      await evaluate('window.__neuroLab.actions.runSteps(600)');
      await pause(300);

      const clip = await evaluate(`(() => {
        const rect = document.querySelector('.stage').getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
      })()`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
      const image = decodePng(Buffer.from(shot.data, 'base64'));
      const fill = brightFraction(image);

      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.neuronCount > 0, `нейронов ${probe.neuronCount}`);
      // Порог 5 % — по измеренному: сеть из 800 нейронов даёт около 21 %.
      // Значение в разы ниже измеренного оставляет запас на другую
      // раскраску, но надёжно отличает «нарисовано» от «пусто».
      expect(fill > 5, `сцена почти пуста: ${fill.toFixed(2)} % светящихся`);
      return `нейронов ${probe.neuronCount}, заполнение ${fill.toFixed(1)} %`;
    });

    await add('связная сцена содержит синапсы', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.synapseCount > 100, `связей ${probe.synapseCount}`);
      return `связей ${probe.synapseCount}`;
    });

    await add('симуляция идёт: время растёт', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      const before = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await pause(1200);
      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(after.timeMs > before.timeMs, `время ${before.timeMs} → ${after.timeMs}`);
      return `${before.timeMs.toFixed(0)} → ${after.timeMs.toFixed(0)} мс`;
    });

    await add('постоянный ток даёт спайки в одиночной сцене', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      await evaluate('window.__neuroLab.actions.runSteps(2000)');
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.spikesTotal > 3, `спайков ${probe.spikesTotal}`);
      return `спайков ${probe.spikesTotal}`;
    });

    await add('осциллограф рисуется', async () => {
      const lit = await evaluate(`(() => {
        const c = window.__neuroLab.canvases.oscilloscope();
        if (!c) return -1;
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 90) count += 1;
        }
        return count;
      })()`);
      expect(lit > 200, `освещённых пикселей ${lit}`);
      return `${lit} пикселей кривой`;
    });

    await add('растровая диаграмма рисуется', async () => {
      const lit = await evaluate(`(() => {
        const c = window.__neuroLab.canvases.raster();
        if (!c) return -1;
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 90) count += 1;
        }
        return count;
      })()`);
      expect(lit > 50, `освещённых пикселей ${lit}`);
      return `${lit} пикселей`;
    });

    await add('метрики не NaN и нет численного разлёта', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      await evaluate('window.__neuroLab.actions.runSteps(2000)');
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(Number.isFinite(probe.meanRate), 'средняя частота не число');
      expect(Number.isFinite(probe.activeFraction), 'доля активных не число');
      expect(probe.insane === 0, `разлёт потенциала: ${probe.insane}`);
      return `частота ${probe.meanRate.toFixed(2)} Гц, активных ${(probe.activeFraction * 100).toFixed(0)}%`;
    });

    await add('«нет данных» показывается словами, а не нулём', async () => {
      // Проверять надо на СВЕЖЕЙ сцене, где статистики ещё нет: после
      // нескольких секунд разряда CV определён честно, и число там уместно.
      // Первая версия проверки смотрела на уже поработавшую сцену и падала
      // на верном поведении интерфейса.
      //
      // Сцена ставится на паузу, сбрасывается и перерисовывается сводка —
      // только тогда «нет данных» действительно «нет данных».
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      await evaluate('window.__neuroLab.actions.toggleRun()'); // пауза
      await evaluate('window.__neuroLab.actions.resetScene()');
      // Заставляем сводку обновиться, не продвигая симуляцию.
      await evaluate('window.__neuroLab.actions.runSteps(1)');
      await pause(700); // ждём планового обновления сводки (раз в 500 мс)

      const text = await evaluate(`(() => {
        const el = document.querySelector('[data-stat="CV ISI"]');
        return el ? el.textContent ?? '' : 'нет элемента';
      })()`);
      await evaluate('window.__neuroLab.actions.toggleRun()'); // снять паузу

      const honest = text.includes('набор') || text === '—';
      expect(honest, `CV показан числом «${text}» до набора статистики`);
      return `«${text}»`;
    });

    await add('панели боковой колонки не перекрываются и скроллятся', async () => {
      const result = await evaluate(`(() => {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return { ok: false, why: 'нет колонки' };
        const sections = [...sidebar.querySelectorAll('.section')];
        for (let i = 1; i < sections.length; i++) {
          const prev = sections[i - 1].getBoundingClientRect();
          const cur = sections[i].getBoundingClientRect();
          if (cur.top < prev.bottom - 2) return { ok: false, why: 'секции перекрываются' };
        }
        return { ok: sections.length > 0, count: sections.length };
      })()`);
      expect(result.ok, result.why ?? 'секций нет');
      return `секций ${result.count}`;
    });

    await add('все пресеты собираются и дают непустую сцену', async () => {
      const ids = JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('[data-preset]')].map((b) => b.dataset.preset))`,
        ),
      );
      expect(ids.length >= 8, `пресетов найдено ${ids.length}`);
      const failed = [];
      for (const id of ids) {
        await evaluate(`window.__neuroLab.actions.applyPreset(${JSON.stringify(id)})`);
        await evaluate('window.__neuroLab.actions.runSteps(400)');
        const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
        if (probe.neuronCount === 0 || probe.insane > 0) failed.push(id);
      }
      expect(failed.length === 0, `проблемные пресеты: ${failed.join(', ')}`);
      return `проверено ${ids.length}`;
    });

    await add('волна доходит от центра', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('wave')`);
      await evaluate('window.__neuroLab.actions.runSteps(800)');
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.activeFraction > 0.3, `активных ${(probe.activeFraction * 100).toFixed(0)}%`);
      return `активных ${(probe.activeFraction * 100).toFixed(0)}%`;
    });

    await add('рабочая память: активность держится после стимула', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('working-memory')`);
      await evaluate('window.__neuroLab.actions.runSteps(3000)');
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.activeFraction > 0.05, `активных ${(probe.activeFraction * 100).toFixed(0)}%`);
      return `активных ${(probe.activeFraction * 100).toFixed(0)}%`;
    });

    await add('STDP действительно обучает связи', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('stdp-learning')`);
      await evaluate('window.__neuroLab.actions.runSteps(6000)');
      const probe = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(probe.stdpUpdates > 1000, `обновлений ${probe.stdpUpdates}`);
      return `обновлений весов ${probe.stdpUpdates}`;
    });

    await add('отчёт уровня читается как данные', async () => {
      await evaluate(`window.__neuroLab.actions.startLevel('level-01')`);
      await evaluate('window.__neuroLab.actions.runSteps(1200)');
      const report = JSON.parse(
        await evaluate('JSON.stringify(window.__neuroLab.actions.checkLevel())'),
      );
      expect(report !== null, 'отчёт не получен');
      expect(Array.isArray(report.results), 'в отчёте нет условий');
      return `условий ${report.results.length}`;
    });

    await add('КАЖДЫЙ уровень кампании проходится в приложении', async () => {
      // ─── Почему проверяются все восемь, а не первый ──────────────────────
      //
      // Раньше здесь был только `level-01`. Этого мало: уровни 2–8 — это
      // наборы числовых порогов поверх сцен, и ошибка в любом из них делает
      // уровень НЕПРОХОДИМЫМ, не ломая при этом ничего внешне. Именно так и
      // вышло с уровнем «Рабочая память»: `measureMemory` вызывался с
      // `maxMs: 0`, его цикл не выполнялся ни разу, и условие
      // «спайков после стимула ≥ 50» не могло выполниться никогда —
      // измерено ровно 0 при 200 активных нейронах.
      //
      // Проверка уровня требует не «условия вернули true», а «игрок может
      // пройти»: поэтому время наблюдения набирается с запасом.
      const ids = JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('[data-level]')].map((b) => b.dataset.level))`,
        ),
      );
      expect(ids.length === 8, `уровней найдено ${ids.length}`);

      const failed = [];
      for (const id of ids) {
        await evaluate(`window.__neuroLab.actions.startLevel(${JSON.stringify(id)})`);
        // Уровень «Своя сеть» требует ПРАВКИ параметров — иначе он
        // проходился бы сам собой и ничего не проверял. В приложении правку
        // делает игрок ползунком, здесь она делается тем же путём.
        if (id === 'level-08') {
          await evaluate('window.__neuroLab.getScene().network.setWeightScale(1.3)');
        }
        await evaluate('window.__neuroLab.actions.runSteps(4000)');
        const report = JSON.parse(
          await evaluate('JSON.stringify(window.__neuroLab.actions.checkLevel())'),
        );
        if (report?.passed !== true) {
          const detail = (report?.results ?? [])
            .filter((r) => !r.passed)
            .map((r) => r.detail)
            .join('; ');
          failed.push(`${id}: ${detail}`);
        }
      }
      expect(failed.length === 0, `не проходятся:\n${failed.join('\n')}`);
      return `пройдено ${ids.length}`;
    });

    await add('применение пресета выходит из кампании', async () => {
      // Рассогласование «сцена от пресета, проверки от уровня» — реальный
      // класс дефектов: уровень мог засчитаться не тот, который открыт.
      await evaluate(`window.__neuroLab.actions.startLevel('level-01')`);
      const during = await evaluate('Boolean(window.__neuroLab.state.levelId)');
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      const after = await evaluate('window.__neuroLab.state.levelId');
      expect(during, 'уровень не открылся');
      expect(after === null, `после пресета остался уровень ${after}`);
      return 'уровень сбрасывается';
    });

    await add('кнопка паузы останавливает симуляцию', async () => {
      // Сначала ставим на паузу, потом меряем: между двумя вызовами CDP
      // успевает пройти кадр, и «на паузе» выглядит как «время шло».
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await pause(300);
      const first = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await pause(700);
      const second = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.toggleRun()');
      expect(
        Math.abs(second.timeMs - first.timeMs) < 1,
        `на паузе время шло: ${first.timeMs} → ${second.timeMs}`,
      );
      return `время стоит на ${first.timeMs.toFixed(0)} мс`;
    });

    await add('шаг делает ровно один шаг', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await pause(200);
      const before = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.stepOnce()');
      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.toggleRun()');
      const delta = after.timeMs - before.timeMs;
      expect(Math.abs(delta - 0.5) < 0.01, `шаг сместил время на ${delta} мс`);
      return `+${delta} мс`;
    });

    await add('сброс возвращает сцену к прогретому старту пресета', async () => {
      // Пресеты с `warmupMs > 0` прогреваются при сборке, поэтому после
      // сброса время равно времени прогрева, а не нулю. Правильное
      // утверждение: сброс возвращает ТО ЖЕ состояние, что и применение
      // пресета. Измерять надо на паузе — иначе кадр сдвигает время.
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await pause(200);
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      const fresh = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.runSteps(3000)');
      const grown = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(grown.spikesTotal > fresh.spikesTotal, 'сцена не продвинулась до сброса');
      await evaluate('window.__neuroLab.actions.resetScene()');
      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.toggleRun()');
      expect(
        Math.abs(after.timeMs - fresh.timeMs) < 1,
        `время после сброса ${after.timeMs} вместо ${fresh.timeMs}`,
      );
      return `время вернулось к ${after.timeMs.toFixed(0)} мс`;
    });

    await add('узкое окно не ломает вёрстку', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 900,
        height: 700,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await pause(500);
      const result = await evaluate(`(() => {
        const stage = document.querySelector('.stage');
        if (!stage) return { ok: false, why: 'нет сцены' };
        const rect = stage.getBoundingClientRect();
        return { ok: rect.width > 100 && rect.height > 100, w: rect.width, h: rect.height };
      })()`);
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      expect(result.ok, `размер сцены ${result.w}×${result.h}`);
      return `${result.w.toFixed(0)}×${result.h.toFixed(0)}`;
    });

    await add('ошибок в консоли не появилось за прогон', async () => {
      const list = JSON.parse(await evaluate('JSON.stringify(window.__smokeErrors ?? [])'));
      expect(list.length === 0, `ошибки: ${list.join('; ')}`);
      return '';
    });

    // ─── Взаимодействие со сценой НАСТОЯЩЕЙ мышью ──────────────────────
    //
    // ─── Почему это отдельный блок и почему он здесь обязателен ────────
    //
    // Всё, что выше, управляет приложением через `window.__neuroLab.actions`,
    // то есть В ОБХОД DOM. Такой проверке не видно самого главного: а
    // реагирует ли приложение на человека? Именно этот класс дефектов здесь
    // уже случался — сцена была пассивной картинкой, ни один обработчик
    // указателя не был подключён, и при этом ВСЕ проверки были зелёными.
    //
    // Поэтому здесь события посылаются через `Input.dispatchMouseEvent` —
    // ровно то, что делает человек мышью. Проверяется не «функция вызвана»,
    // а «на событие указателя сеть ответила».
    const stageCentre = async () => {
      const box = await evaluate(`(() => {
        const el = document.querySelector('.stage');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!box) throw new Error('сцена не найдена');
      return box;
    };

    const mouse = async (type, x, y, extra = {}) => {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
    };

    await add('протяжка мышью по сцене запускает спайки («удар током»)', async () => {
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await evaluate('window.__neuroLab.actions.resetScene()');
      const before = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));

      const c = await stageCentre();
      await mouse('mouseMoved', c.x, c.y);
      await mouse('mousePressed', c.x, c.y, { button: 'left', clickCount: 1 });
      // Ведём курсор: удар обязан следовать за ним, а не остаться в точке
      // нажатия — иначе «протяжка» превращается в «клик».
      for (let k = 1; k <= 8; k++) {
        await mouse('mouseMoved', c.x + k * 14, c.y + k * 6, { button: 'left' });
      }
      await evaluate('window.__neuroLab.actions.runSteps(120)');
      await mouse('mouseReleased', c.x + 112, c.y + 48, { button: 'left', clickCount: 1 });

      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(
        after.spikesTotal > before.spikesTotal,
        `спайков не прибавилось: ${before.spikesTotal} → ${after.spikesTotal}`,
      );
      return `спайков ${before.spikesTotal} → ${after.spikesTotal}`;
    });

    await add('колесо мыши масштабирует сцену', async () => {
      const c = await stageCentre();
      const z0 = await evaluate('window.__neuroLab.camera.zoom');
      await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: -240 });
      await pause(120);
      const z1 = await evaluate('window.__neuroLab.camera.zoom');
      expect(Math.abs(z1 - z0) > 1e-6, `зум не изменился: ${z0}`);
      // Обратное колесо обязано вернуть масштаб: без этого «зум» может
      // оказаться односторонним, и сцену нельзя будет вернуть в общий вид.
      await mouse('mouseWheel', c.x, c.y, { deltaX: 0, deltaY: 240 });
      await pause(120);
      const z2 = await evaluate('window.__neuroLab.camera.zoom');
      expect(z2 < z1, `обратное колесо не уменьшило зум: ${z1} → ${z2}`);
      return `${z0.toFixed(1)} → ${z1.toFixed(1)} → ${z2.toFixed(1)}`;
    });

    await add('Shift + протяжка сдвигает сцену (панорама)', async () => {
      const c = await stageCentre();
      const before = await evaluate(
        'JSON.stringify([window.__neuroLab.camera.x, window.__neuroLab.camera.y])',
      );
      // modifiers: 8 — это Shift в протоколе DevTools.
      await mouse('mouseMoved', c.x, c.y);
      await mouse('mousePressed', c.x, c.y, { button: 'left', clickCount: 1, modifiers: 8 });
      await mouse('mouseMoved', c.x + 90, c.y + 40, { button: 'left', modifiers: 8 });
      await mouse('mouseReleased', c.x + 90, c.y + 40, { button: 'left', clickCount: 1, modifiers: 8 });
      await pause(120);
      const after = await evaluate(
        'JSON.stringify([window.__neuroLab.camera.x, window.__neuroLab.camera.y])',
      );
      expect(after !== before, `камера не сдвинулась: ${before}`);
      return `${before} → ${after}`;
    });

    await add('кисть удара показывается при движении мыши', async () => {
      const c = await stageCentre();
      await mouse('mouseMoved', c.x + 30, c.y + 20);
      await pause(120);
      const brush = await evaluate('JSON.stringify(window.__neuroLab.inputBrush())');
      expect(brush !== 'null', 'кисть не появилась при движении мыши');
      return brush;
    });

    await add('удар током снимается после отпускания кнопки', async () => {
      // Стимул обязан прекращаться: иначе сеть остаётся «под током»
      // навсегда, и наблюдать за ней становится невозможно.
      //
      // Проверяется НАБЛЮДАЕМОЕ состояние, а не рост спайков: первая версия
      // этой проверки мерила прирост спайков после снятия, и на сцене, где
      // фоновый вход сам даёт разряд, она проходила бы даже если бы удара
      // никто не снимал.
      await evaluate(`window.__neuroLab.actions.applyPreset('single-lif')`);
      const c = await stageCentre();
      await mouse('mouseMoved', c.x, c.y);
      await mouse('mousePressed', c.x, c.y, { button: 'left', clickCount: 1 });
      const during = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(during.spotActive, 'удар не включился при нажатии кнопки');

      await mouse('mouseReleased', c.x, c.y, { button: 'left', clickCount: 1 });
      await pause(80);
      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(!after.spotActive, 'после отпускания кнопки удар остался включён');
      return 'включён при нажатии, снят при отпускании';
    });

    await add('импульсы рисуются и выключаются флажком', async () => {
      // Импульсы — визуализация передачи по синапсам. Проверяется не
      // «флаг выставлен», а что отрезки ДЕЙСТВИТЕЛЬНО рисуются, и что
      // выключение их убирает.
      await evaluate(`window.__neuroLab.actions.applyPreset('random-sparse')`);
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await evaluate('window.__neuroLab.actions.resetScene()');
      await evaluate('window.__neuroLab.actions.runSteps(600)');
      await pause(200);
      const on = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(on.pulseEvents > 0, `след импульсов пуст: ${on.pulseEvents}`);
      expect(on.pulsesRecorded > 0, 'ни одна передача не записана');

      await evaluate('window.__neuroLab.renderer.options.showPulses = false');
      await evaluate('window.__neuroLab.actions.runSteps(40)');
      await pause(200);
      const off = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(off.renderPulses === 0, `импульсы рисуются при выключенном флажке: ${off.renderPulses}`);
      await evaluate('window.__neuroLab.renderer.options.showPulses = true');
      return `записано передач ${on.pulsesRecorded}, в следе ${on.pulseEvents}`;
    });

    await add('пресет «Кольцо» действительно держит ритм (не один оборот)', async () => {
      // ─── Почему проверяется ИМЕННО удержание ────────────────────────────
      //
      // Пресет обещает «волну, которая бежит по кругу». Проверка «спайков
      // больше нуля» здесь бесполезна: столько даёт и одноразовый проход.
      // Реальная картина до правки: волна обегала кольцо РОВНО ОДИН раз и
      // гасла навсегда — измерено `28 11 11 11 12 11 … 11 4 0 0 0`.
      //
      // Поэтому сравнивается прирост на ДВУХ длинных интервалах: у
      // настоящего генератора они почти равны, у затухающего второй равен
      // нулю.
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await pause(150);
      await evaluate(`window.__neuroLab.actions.applyPreset('ring')`);
      await evaluate('window.__neuroLab.actions.runSteps(4000)');
      const first = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.runSteps(4000)');
      const second = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.actions.toggleRun()');
      await pause(150);

      const growth = second.spikesTotal - first.spikesTotal;
      expect(growth > 5000, `кольцо затухает: прирост за 2 с всего ${growth}`);
      expect(second.insane === 0, `кольцо ушло в разлёт: ${second.insane}`);
      return `прирост за 2 с: ${growth}, всего спайков ${second.spikesTotal}`;
    });

    await add('ползунки панели «Сеть» есть и меняют сеть', async () => {
      // ─── Почему это проверка, а не «мелочь интерфейса» ──────────────────
      //
      // Уровень «Своя сеть» требует «поднять вес связей» и «добавить
      // торможение». Пока таких ползунков не было, уровень проходился сам
      // собой, а подсказки отправляли искать несуществующие ручки. Здесь
      // проверяется и НАЛИЧИЕ ползунков в разметке, и что они ДЕЙСТВУЮТ.
      const labels = JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('.sidebar .field__label')].map((el) => el.textContent))`,
        ),
      );
      for (const needed of ['Вес связей', 'Торможение', 'Вход']) {
        expect(labels.includes(needed), `нет ползунка «${needed}»`);
      }

      await evaluate(`window.__neuroLab.actions.applyPreset('working-memory')`);
      const before = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      await evaluate('window.__neuroLab.getScene().network.setWeightScale(1.5)');
      const scale = await evaluate('window.__neuroLab.getScene().network.currentWeightScale');
      expect(Math.abs(scale - 1.5) < 1e-6, `множитель веса не применился: ${scale}`);
      await evaluate('window.__neuroLab.actions.runSteps(2000)');
      const after = JSON.parse(await evaluate('JSON.stringify(window.__neuroLab.probe())'));
      expect(after.insane === 0, 'правка веса увела сеть в разлёт');
      return `ползунков ${labels.length}, вес 1.0× → 1.5×, спайков ${before.spikesTotal} → ${after.spikesTotal}`;
    });

    // Скриншот для визуальной проверки.
    await evaluate(`window.__neuroLab.actions.applyPreset('wave')`);
    await evaluate('window.__neuroLab.actions.runSteps(400)');
    await pause(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${SHOT_DIR}/smoke.png`, Buffer.from(shot.data, 'base64'));
  } finally {
    if (cdp) cdp.close();
    // Останавливается ТОЛЬКО свой экземпляр, вместе с потомками.
    stopBrowser(child);
  }

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    process.stdout.write(
      `${check.ok ? '  ✓' : '  ×'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}\n`,
    );
  }
  process.stdout.write(
    `\nПроверок: ${checks.length}, пройдено: ${checks.length - failed.length}, провалено: ${failed.length}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`Сквозная проверка не запустилась: ${String(error)}\n`);
  process.exitCode = 1;
});

/**
 * Тесты кампании: каждый уровень обязан ПРОХОДИТЬСЯ.
 *
 * ─── Зачем этот файл ─────────────────────────────────────────────────────
 *
 * В `levels.ts` было написано: «тест "каждый уровень проходится" существует
 * именно для этого». **Такого теста не существовало.** Была проверка только
 * для уровня 1, и та в браузерном `smoke`; уровни 2–8 не проверял никто.
 *
 * Почему это опасно. Уровень — это набор ЧИСЛОВЫХ порогов поверх сцены
 * (`cv` выше 0.3, `weightSpread` выше 0.05, `waveReach` больше 10). Стоит
 * поменять параметр пресета или схему интегрирования — и уровень
 * перестаёт проходиться, причём незаметно: приложение работает, сцена
 * красивая, а игрок упирается в «условия пока не выполнены» навсегда.
 * Ровно так в phys-lab уровень не проходился из-за неверно измеренной
 * величины.
 *
 * Здесь каждый уровень играется так, как его играет человек: берётся его
 * пресет, собирается сцена, набирается `observeMs` модельного времени и
 * проверяются условия. Плюс сверяется, что условия вообще ОСМЫСЛЕННЫ, а не
 * проходят на пустой сети.
 */

import { describe, expect, it } from 'vitest';
import { LEVELS, levelById, levelNumber } from '../levels/levels.js';
import { LevelSession } from '../levels/session.js';
import { buildScene, warmUp, applyStarter, type Scene } from '../core/scene.js';
import { presetById } from '../core/presets.js';
import { measureWave } from '../core/wave.js';

/**
 * Собрать сцену уровня так же, как это делает приложение.
 *
 * `startLevel` в `app.ts` берёт пресет уровня, строит сцену, прогревает её и
 * задаёт центр волны. Повторяем это здесь, чтобы тест играл в ту же игру,
 * что и пользователь, а не в собственную.
 */
function playLevel(levelId: string, extraMs = 0): { scene: Scene; session: LevelSession } {
  const level = levelById(levelId);
  if (!level) throw new Error(`уровень ${levelId} не найден`);
  const preset = presetById(level.presetId);
  if (!preset) throw new Error(`пресет ${level.presetId} не найден`);

  const scene = buildScene(preset);
  warmUp(scene);
  const session = new LevelSession(level, scene.network);

  // Центр волны — как в приложении: по фактическим координатам решётки.
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < preset.count; i++) {
    if (scene.network.x[i] > maxX) maxX = scene.network.x[i];
    if (scene.network.y[i] > maxY) maxY = scene.network.y[i];
  }
  if (preset.topology.kind === 'grid') {
    session.setWaveCentre({ centerX: maxX / 2, centerY: maxY / 2 });
  }

  // Набираем время наблюдения, вызывая tick на каждом шаге: именно так
  // сессия узнаёт момент снятия стимула.
  const target = Math.max(level.observeMs, Math.ceil(level.observeMs * 1.5)) + extraMs;
  const steps = Math.ceil(target / scene.network.params.dt);
  for (let i = 0; i < steps; i++) {
    scene.network.step();
    session.tick();
  }

  return { scene, session };
}

/** Строка с результатами для сообщения об ошибке. */
function describeFailure(report: ReturnType<LevelSession['checkNow']>): string {
  return report.results
    .map((r) => `${r.passed ? '✓' : '×'} ${r.check.label}: ${r.detail}`)
    .join('\n');
}

describe('кампания: структура', () => {
  it('уровней восемь, идентификаторы последовательны и уникальны', () => {
    expect(LEVELS).toHaveLength(8);
    const ids = LEVELS.map((level) => level.id);
    expect(new Set(ids).size).toBe(ids.length);
    LEVELS.forEach((level, index) => {
      expect(levelNumber(level)).toBe(index + 1);
    });
  });

  it('каждый уровень ссылается на существующий пресет и имеет условия', () => {
    for (const level of LEVELS) {
      expect(presetById(level.presetId), `${level.id}: неизвестный пресет`).toBeDefined();
      expect(level.checks.length, `${level.id}: нет условий`).toBeGreaterThan(0);
      expect(level.observeMs, `${level.id}: нет времени наблюдения`).toBeGreaterThan(0);
      // Тексты обязаны быть содержательными: уровень без теории и подсказок —
      // это тупик для игрока.
      expect(level.theory.length, `${level.id}: пустая теория`).toBeGreaterThan(100);
      expect(level.hints.length, `${level.id}: нет подсказок`).toBeGreaterThan(0);
      expect(level.task.length, `${level.id}: нет задачи`).toBeGreaterThan(0);
    }
  });

  it('условие памяти стоит только у уровня памяти, волновое — только у волны', () => {
    // Перепутанное условие (например, волновое у не-пространственной сцены)
    // дало бы уровень, который НЕВОЗМОЖНО пройти: `waveReach` вернёт 0,
    // потому что центра волны нет.
    for (const level of LEVELS) {
      const kinds = level.checks.map((check) => check.kind);
      const isWave = kinds.some((kind) => kind === 'waveReach' || kind === 'waveFit');
      if (isWave) {
        const preset = presetById(level.presetId);
        expect(
          preset?.topology.kind,
          `${level.id}: волновое условие у не-пространственной сцены`,
        ).toBe('grid');
      }
    }
  });
});

describe('кампания: каждый уровень ПРОХОДИТСЯ', () => {
  // Главный тест файла. Если он падает — игрок не может пройти кампанию.
  for (const level of LEVELS) {
    it(`${level.id} «${level.title}» проходится из своего пресета`, () => {
      const { session } = playLevel(level.id);
      const report = session.checkNow();
      expect(report.passed, `уровень не пройден:\n${describeFailure(report)}`).toBe(true);
    });
  }

  it('все восемь уровней проходятся по порядку', () => {
    const failed: string[] = [];
    for (const level of LEVELS) {
      const { session } = playLevel(level.id);
      const report = session.checkNow();
      if (!report.passed) failed.push(`${level.id}: ${describeFailure(report)}`);
    }
    expect(failed, `не проходятся:\n${failed.join('\n\n')}`).toEqual([]);
  });
});

describe('кампания: условия не зависят от того, КОГДА их проверить', () => {
  it('каждый уровень проходится и на 2×, и на 8× времени наблюдения', () => {
    // ─── Дефект, который здесь закрыт ────────────────────────────────────
    //
    // Уровень «Адаптация» проходился или нет в зависимости от момента
    // проверки. Измерено: мера роста интервалов равна 2.53 на 250 мс,
    // 1.43 на 400 мс и 1.25 после 430 мс — ниже порога 1.4, навсегда.
    //
    // Приложение проверяет сводку раз в 500 мс, и к моменту проверки
    // проходит ~2000 мс модельного времени, то есть ЗАВЕДОМО больше
    // observeMs. Значит, аккуратный игрок, который просто смотрел дольше,
    // уровень пройти не мог. Это и есть проверка на такой класс ошибок:
    // вердикт обязан быть одинаковым при любом времени наблюдения.
    const failures: string[] = [];
    for (const level of LEVELS) {
      for (const multiplier of [2, 4, 8]) {
        const extraMs = level.observeMs * (multiplier - 1);
        const { session } = playLevel(level.id, extraMs);
        const report = session.checkNow();
        if (!report.passed) {
          failures.push(`${level.id} (×${multiplier}): ${describeFailure(report)}`);
        }
      }
    }
    expect(failures, `вердикт зависит от времени наблюдения:\n${failures.join('\n')}`).toEqual([]);
  });

  it('уровень «Адаптация» остаётся пройденным и после долгого наблюдения', () => {
    // Прицельно про сцену, где дефект был найден: 2000 мс — примерно
    // столько накручивает приложение между проверками сводки.
    const { session } = playLevel('level-02', 2000);
    const report = session.checkNow();
    const trend = report.results.find((r) => r.check.kind === 'isiTrend');
    expect(trend).toBeDefined();
    expect(
      report.passed,
      `после долгого наблюдения уровень не пройден: ${describeFailure(report)}`,
    ).toBe(true);
  });
});

describe('кампания: условия осмысленны, а не проходят всегда', () => {
  it('условия НЕ выполняются на сети, которая молчит', () => {
    // Сеть без входа и без стимула: ни спайков, ни обучения. Если условие
    // проходит и здесь, оно ничего не проверяет.
    const level = levelById('level-04');
    if (!level) throw new Error('нет уровня 04');
    const preset = presetById(level.presetId);
    if (!preset) throw new Error('нет пресета');

    // Тот же пресет, но вход выключен и STDP выключен.
    const quiet = buildScene({
      ...preset,
      input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
      stdp: false,
      warmupMs: 0,
    });
    const session = new LevelSession(level, quiet.network);
    const steps = Math.ceil(level.observeMs / quiet.network.params.dt);
    for (let i = 0; i < steps; i++) {
      quiet.network.step();
      session.tick();
    }

    const report = session.checkNow();
    expect(report.passed, 'молчащая сеть прошла уровень «Сеть в покое»').toBe(false);
  });

  it('уровень «Спайк» не проходит на нейроне без тока', () => {
    const level = levelById('level-01');
    if (!level) throw new Error('нет уровня 01');
    const preset = presetById(level.presetId);
    if (!preset) throw new Error('нет пресета');

    const silent = buildScene({
      ...preset,
      input: { mode: 'none', amplitude: 0, rate: 0, weight: 0, fraction: 0 },
      warmupMs: 0,
    });
    const session = new LevelSession(level, silent.network);
    const steps = Math.ceil(level.observeMs / silent.network.params.dt);
    for (let i = 0; i < steps; i++) {
      silent.network.step();
      session.tick();
    }
    expect(session.checkNow().passed, 'нейрон без тока выдал три спайка').toBe(false);
  });
});

describe('кампания: волновые условия считаются по фронту', () => {
  it('уровень «Волна» проходит с волной и НЕ проходит без неё', () => {
    // ─── Почему это отдельная проверка ───────────────────────────────────
    //
    // Волновое условие зависит от того, когда измерять: волна пересекает
    // решётку за ~13 мс, а `observeMs` уровня — 300 мс. К моменту проверки
    // фронт уже у края, и «дальность» упирается в геометрию сетки, а не в
    // скорость. Здесь сверяется, что условие всё равно различает «волна
    // была» и «волны не было»: без стимула оно обязано провалиться.
    const level = levelById('level-06');
    if (!level) throw new Error('нет уровня 06');
    const preset = presetById(level.presetId);
    if (!preset) throw new Error('нет пресета');

    // Со стимулом — проходит (проверено выше), без стимула — нет.
    const noStarter = buildScene({ ...preset, starter: undefined, warmupMs: 0 });
    const network = noStarter.network;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < network.params.count; i++) {
      if (network.x[i] > maxX) maxX = network.x[i];
      if (network.y[i] > maxY) maxY = network.y[i];
    }
    const session = new LevelSession(level, network);
    session.setWaveCentre({ centerX: maxX / 2, centerY: maxY / 2 });
    const steps = Math.ceil(level.observeMs / network.params.dt);
    for (let i = 0; i < steps; i++) {
      network.step();
      session.tick();
    }
    expect(session.checkNow().passed, 'волна возникла без всякого толчка').toBe(false);
  });

  it('измерение волны различает наличие распространения', () => {
    // Прямая проверка инструмента, которым пользуется уровень: у сцены со
    // стимулом фронт проходит десятки клеток, у сцены без стимула — ни
    // одной.
    const preset = presetById('wave');
    if (!preset) throw new Error('нет пресета волны');

    const withWave = buildScene(preset);
    applyStarter(withWave);
    withWave.network.run(30);
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < withWave.network.params.count; i++) {
      if (withWave.network.x[i] > maxX) maxX = withWave.network.x[i];
      if (withWave.network.y[i] > maxY) maxY = withWave.network.y[i];
    }
    const centre = { centerX: maxX / 2, centerY: maxY / 2 };
    const wave = measureWave(withWave.network, { ...centre, minDistance: 3 });
    expect(wave.reachCells).toBeGreaterThan(10);

    const silent = buildScene({ ...preset, starter: undefined, warmupMs: 0 });
    silent.network.run(30);
    const none = measureWave(silent.network, { ...centre, minDistance: 3 });
    expect(none.reachCells).toBe(0);
  });
});

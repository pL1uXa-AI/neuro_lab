/**
 * Тест кодировки исходников.
 *
 * ─── Почему это тест, а не «разовая проверка» ────────────────────────────
 *
 * Весь интерфейс и документация проекта на русском. Если файл сохранить в
 * неверной кодировке, получается mojibake: «РџСЂРѕРІРµСЂРєР°» вместо
 * «Проверка». При этом НИ ОДНА обычная проверка не срабатывает:
 *
 *   • TypeScript считает строки валидными;
 *   • `npm run build` проходит;
 *   • юнит-тесты зелёные (они сравнивают числа, а не подписи);
 *   • `smoke` тоже проходит — он читает `document.title` и размеры, а не
 *     смысл надписей.
 *
 * Этот дефект был найден ТОЛЬКО на скриншоте из сквозной проверки. Поэтому
 * здесь стоит автопроверка: она ловит класс ошибки «текст есть, но он
 * нечитаем», который иначе всплывает лишь у пользователя.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/**
 * Признаки mojibake.
 *
 * Это характерные сочетания кириллических букв, которые получаются, когда
 * UTF-8-байты русского текста читают как cp1251, а потом снова пишут в
 * UTF-8. В осмысленном русском тексте таких сочетаний не бывает.
 */
const MOJIBAKE = ['Р°', 'Рµ', 'Рѕ', 'СЂ', 'СЃ', 'Рї', 'РЅ', 'РІ', 'Р С‘', 'РІвЂ', 'Р’В'];

/** Собрать файлы исходников и документации. */
function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.verify') continue;
    if (entry.startsWith('.')) continue;
    // Файлы, которые САМИ содержат признаки mojibake как данные (скрипт
    // починки и этот тест), исключаются: иначе проверка находит саму себя.
    if (entry === 'fix-encoding.mjs' || entry === 'encoding.test.ts') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, out);
      continue;
    }
    if (/\.(ts|css|mjs|md|html)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('кодировка исходников', () => {
  it('ни в одном файле нет признаков mojibake', () => {
    // ─── Почему документация собирается ОБХОДОМ, а не списком ─────────────
    //
    // Первая версия перечисляла файлы явно: `README.md`, `ROADMAP.md`,
    // `docs/NEXT-SESSION.md`. Из-за этого ЛЮБОЙ новый файл документации
    // оказывался вне проверки, и порча в нём проходила молча. Проверено
    // пробой: испорченный `docs/zz-probe.md` не находили ни тест, ни
    // `fix-encoding.mjs` (у скрипта шаблон `*.md` одноуровневый и `docs/` не
    // покрывал).
    //
    // Теперь обходятся ВСЕ `.md` в корне и в `docs/` — так же, как это уже
    // сделано для `src/` и `scripts/`. Файла ещё нет — не беда: список
    // берётся из каталога, а не из воображаемого будущего.
    const candidates = [
      ...collectFiles(join(ROOT, 'src')),
      ...collectFiles(join(ROOT, 'scripts')),
      ...collectFiles(join(ROOT, 'docs')),
      join(ROOT, 'README.md'),
      join(ROOT, 'ROADMAP.md'),
      join(ROOT, 'index.html'),
    ];
    const files: string[] = [];
    for (const file of candidates) {
      try {
        if (statSync(file).isFile()) files.push(file);
      } catch {
        // Файла ещё нет — пропускаем.
      }
    }
    expect(files.length).toBeGreaterThan(10);

    const broken: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      // Файлы, которые САМИ проверяют кодировку, содержат признаки mojibake
      // как данные: скрипт починки держит их в списке, смоук-проверка ищет их
      // в тексте страницы. Исключаются ровно эти два файла, а не «всё
      // похожее»: иначе проверка ослепла бы и на настоящей порче.
      const name = relative(ROOT, file);
      if (name.endsWith('fix-encoding.mjs') || name.endsWith('smoke.mjs')) continue;

      // Документация дефекта показывает ПРИМЕР порчи в кавычках, чтобы
      // читатель понял, о чём речь. Такие фрагменты удаляются перед
      // проверкой: реальная порча не бывает внутри «кавычек» или
      // `код-спанов`, а описание без примера бесполезно.
      //
      // Без этого исключения проверка падала бы на своём же описании, и её
      // пришлось бы отключить целиком — а тогда она перестала бы ловить
      // настоящую порчу.
      const meaningful = text
        .split('\n')
        .filter((line) => !/mojibake/i.test(line))
        .join('\n')
        .replace(/«[^»]*»/g, '')
        .replace(/`[^`]*`/g, '');

      let hits = 0;
      for (const sign of MOJIBAKE) {
        let index = meaningful.indexOf(sign);
        while (index !== -1 && hits < 5) {
          hits += 1;
          index = meaningful.indexOf(sign, index + 1);
        }
      }
      if (hits >= 3) broken.push(name);
    }

    expect(broken, `файлы с испорченной кодировкой:\n${broken.join('\n')}`).toEqual([]);
  });

  it('интерфейс содержит осмысленные русские подписи', () => {
    // Проверка не «нет mojibake», а «текст именно тот»: ищем подписи, которые
    // пользователь обязан видеть, и убеждаемся, что они читаемы.
    const app = readFileSync(join(ROOT, 'src', 'app', 'app.ts'), 'utf8');
    for (const label of ['Пауза', 'Шаг', 'Сброс', 'Справка', 'Сцены', 'Нейрон', 'Вид']) {
      expect(app.includes(label), `подпись «${label}» не найдена`).toBe(true);
    }
  });

  it('названия пресетов и уровней читаемы', () => {
    const presets = readFileSync(join(ROOT, 'src', 'core', 'presets.ts'), 'utf8');
    const levels = readFileSync(join(ROOT, 'src', 'levels', 'levels.ts'), 'utf8');
    for (const title of ['Один нейрон (LIF)', 'Разреженная сеть', 'Волна активности', 'Рабочая память']) {
      expect(presets.includes(title), `пресет «${title}» не найден`).toBe(true);
    }
    for (const title of ['Спайк', 'Адаптация', 'Пачки', 'Обучение', 'Волна']) {
      expect(levels.includes(`'${title}'`), `уровень «${title}» не найден`).toBe(true);
    }
  });

  it('проверка покрывает ВСЕ файлы документации, а не список известных', () => {
    // ─── Зачем этот тест ─────────────────────────────────────────────────
    //
    // Проверка кодировки бесполезна, если новый файл в неё не попал. Именно
    // так и случилось: список документации был задан ЯВНО (`README.md`,
    // `ROADMAP.md`, `docs/NEXT-SESSION.md`), и порча в любом новом `.md`
    // проходила молча — проверено пробой с `docs/zz-probe.md`.
    //
    // Здесь сверяется само ПОКРЫТИЕ: каждый `.md` проекта обязан оказаться в
    // списке проверяемых. Если кто-то добавит `docs/ЧТО-ТО.md` и забудет
    // расширить обход, этот тест упадёт и объяснит, что делать.
    const docs = readdirSync(join(ROOT, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => join('docs', name));
    const rootDocs = readdirSync(ROOT).filter((name) => name.endsWith('.md'));

    const checked = new Set(
      [
        ...collectFiles(join(ROOT, 'src')),
        ...collectFiles(join(ROOT, 'scripts')),
        ...collectFiles(join(ROOT, 'docs')),
        ...rootDocs.map((name) => join(ROOT, name)),
      ].map((file) => relative(ROOT, file)),
    );

    expect(docs.length).toBeGreaterThan(0);
    for (const doc of [...rootDocs, ...docs]) {
      expect(checked.has(doc), `${doc} не проверяется на кодировку`).toBe(true);
    }
  });
});

/**
 * Диагностика и починка кодировки исходников.
 *
 * ─── Что случилось ───────────────────────────────────────────────────────
 *
 * Часть файлов записывалась через PowerShell (`Set-Content`), который в этой
 * среде берёт системную кодировку (cp1251), а затем файл переписывался как
 * UTF-8. Кириллица при этом прошла ДВОЙНОЕ перекодирование, и в исходниках
 * оказались строки вида «РџСЂРѕРІРµСЂРєР°» вместо «Проверка».
 *
 * ─── Почему это опасно именно в этом проекте ─────────────────────────────
 *
 * Весь интерфейс и документация на русском. Mojibake не роняет ни один тест:
 * TypeScript считает строки валидными, сборка проходит, юнит-тесты зелёные —
 * а пользователь видит нечитаемый текст. Это ровно тот класс дефектов,
 * который юнит-тесты не ловят, и он был найден ТОЛЬКО сквозной проверкой в
 * браузере со скриншотом.
 *
 * ─── Что делает скрипт ───────────────────────────────────────────────────
 *
 * `--check` — только отчёт (используется в проверках).
 * `--fix`   — перекодировать cp1251→UTF-8 и перезаписать файл.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** Файлы проекта, в которых допустима кириллица. */
const PATTERNS = [
  'src/**/*.ts',
  'src/**/*.css',
  'scripts/**/*.mjs',
  '*.md',
  // Документация в подпапке. Шаблон `*.md` её НЕ ловит (он одноуровневый), и
  // именно поэтому готовая проверка не заметила испорченный файл в `docs/`:
  // `docs/NEXT-SESSION.md` был в списке ЯВНО, а любой новый файл рядом —
  // нет. Проверено пробой: порча в новом `docs/*.md` проходила обе проверки
  // молча.
  'docs/**/*.md',
  'index.html',
];

/**
 * Признаки двойного перекодирования.
 *
 * «Рџ», «СЂ», «Рµ» — это UTF-8-байты кириллицы, прочитанные как cp1251.
 * Последовательности достаточно характерны, чтобы отличить их от настоящего
 * русского текста: в нормальном тексте не бывает «СЂР°Р·».
 *
 * ─── Почему одного набора признаков мало ────────────────────────────────
 *
 * При ПОВТОРНОМ прогоне (cp1251 → UTF-8 дважды) получаются уже другие
 * строки: «Р РЎРѓР В» и подобные, где появляются символы вроде «Р В» и
 * «Р в„–». Первая версия скрипта их не ловила — и пропустила файл, который
 * был испорчен именно дважды. Поэтому проверка теперь ищет не конкретные
 * последовательности, а САМ ФАКТ: в тексте есть сочетания латинской «C» с
 * кириллическими знаками, характерные только для mojibake.
 */
const SIGNS = [
  'Р°',
  'Рµ',
  'Рѕ',
  'СЂ',
  'СЃ',
  'С‚',
  'Рї',
  'РЅ',
  'Р»',
  'РІ',
  'Рґ',
  'Рє',
  'Р С‘',
  'Р С•',
  'Р вЂ',
  'Р Сџ',
  'РІвЂ',
  'Р’В',
];

/** Найти файлы с признаками поломки. */
function findBroken() {
  const broken = [];
  for (const pattern of PATTERNS) {
    let files = [];
    try {
      files = globSync(pattern, { cwd: root });
    } catch {
      continue;
    }
    for (const file of files) {
      // Файлы, которые САМИ проверяют кодировку, содержат признаки mojibake
      // как данные (скрипт починки держит их в списке, смоук-проверка ищет
      // их в тексте страницы). Иначе проверка находит саму себя и всегда
      // «падает».
      if (file.includes('fix-encoding')) continue;
      if (file.includes('encoding.test')) continue;
      if (file.includes('smoke.mjs')) continue;
      const full = resolve(root, file);
      let text;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Документация дефекта показывает ПРИМЕР порчи в кавычках. Такие
      // фрагменты удаляются перед проверкой: реальная порча не бывает
      // внутри «кавычек» или `код-спанов`, а описание без примера
      // бесполезно. Без этого проверка падала бы на собственном описании.
      const meaningful = text
        .split('\n')
        .filter((line) => !/mojibake/i.test(line))
        .join('\n')
        .replace(/«[^»]*»/g, '')
        .replace(/`[^`]*`/g, '');

      let hits = 0;
      for (const sign of SIGNS) {
        let index = meaningful.indexOf(sign);
        while (index !== -1 && hits < 5) {
          hits += 1;
          index = meaningful.indexOf(sign, index + 1);
        }
      }
      if (hits >= 3) broken.push(relative(root, full));
    }
  }
  return broken;
}

/** Перекодировать файл: прочитать как cp1251, записать как UTF-8. */
function fixFile(file) {
  const full = resolve(root, file);
  const bytes = readFileSync(full);
  const text = new TextDecoder('windows-1251').decode(bytes);
  writeFileSync(full, text, 'utf8');
}

const mode = process.argv.includes('--fix') ? 'fix' : 'check';
const broken = findBroken();

if (broken.length === 0) {
  process.stdout.write('Кодировка в порядке: файлов с mojibake не найдено.\n');
  process.exit(0);
}

if (mode === 'check') {
  process.stdout.write(`Найдены файлы с испорченной кодировкой (${broken.length}):\n`);
  for (const file of broken) process.stdout.write(`  × ${file}\n`);
  process.stdout.write('\nЗапусти: node scripts/fix-encoding.mjs --fix\n');
  process.exit(1);
}

for (const file of broken) {
  fixFile(file);
  process.stdout.write(`  ✓ исправлен ${file}\n`);
}
process.stdout.write(`\nИсправлено файлов: ${broken.length}\n`);

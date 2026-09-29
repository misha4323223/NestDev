"use strict";

/* ─── «Визитка» проекта для системного промпта ────────────────────────────────
   Раньше жила в main.js (этап B, часть 27). Это то, что агент получает в
   САММАРИ ПРОЕКТА на старте сессии: имя и скрипты package.json, двухуровневая
   структура папок, начало README, доступные оболочки и строка Yandex Cloud.
   Благодаря ей агенту не нужно осматриваться с нуля, а истории хватает дольше.

   Пределы структуры считаются по ЗНАКАМ, а не по числу записей (часть 82:
   длинные имена одной полки сворачиваются в строку со счётчиком) — визитка идёт
   в каждый запрос, и её размер обязан быть в символах.

   Ошибается это тихо и дорого:
     • в структуру попадает мусор (node_modules, .git, dist) — визитка
       раздувается и вытесняет из промпта настоящую работу;
     • визитка не ограничена по размеру — на большом проекте она съедает
       контекст целиком;
     • битый package.json или недоступная папка роняют сборку промпта — прогон
       не начинается вовсе, хотя без визитки он бы работал;
     • устаревшая строка Yandex Cloud говорит «каталог не выбран», когда он уже
       выбран (ровно жалоба «агент не видит каталог»), поэтому настройки
       читаются В МОМЕНТ сбора визитки, а не копией.

   Живые значения приходят аргументами: доступные оболочки и строка Yandex Cloud
   считаются в main.js (там лежат их данные и настройки облака), а чтение настроек
   приходит функцией — визитка собирается на каждый прогон.

   Текст перенесён ПОБАЙТОВО (переотступа при выносе не было: так же сделано и в
   src/mail-ipc.js), поэтому поведение не менялось ни на строку. */

function createProjectBrief(deps) {
  const { fs, path, SKIP_DIRS, shellsBrief, loadSettings, ycBriefLine } = deps;

// Пределы структуры. Считаются по ЗНАКАМ, а не по числу записей (часть 82): имена
// бывают по 70+ знаков (docs/notes/chast-*.md), и 80 таких записей весят почти
// 6 КБ — а визитка уходит в КАЖДЫЙ запрос, то есть её бюджет обязан быть в
// символах. Отдельно ограничено число ФАЙЛОВ из одной папки: иначе длинные имена
// одной полки съедали весь бюджет и вытесняли src/ — единственное, что агенту
// нужнее всего. Папки показываются всегда: бюджет тратят имена файлов, а не
// «где лежит код». Отдаются наружу, чтобы набор и живой прогон сверяли тот же
// предел, а не свои копии числа.
const BRIEF_TREE_CHARS = 3000;
// Число записей — только страховка на случай очень коротких имён (по знакам бюджет
// уже ограничен): раньше это и был единственный предел, и 80 длинных имён весили
// больше, чем весь бюджет визитки.
const BRIEF_TREE_MAX = 120;
const BRIEF_DIR_FILES = 12;

// Краткая «визитка» проекта для старта сессии: имя, скрипты, двухуровневая структура,
// первые строки README. Подмешивается к системному промпту в runAi — агенту не нужно
// осматриваться с нуля, а истории хватает дольше. Чисто синхронная и дешёвая.
function buildProjectBrief(root) {
  if (!root || !fs.existsSync(root)) return "";
  const parts = [];
  // package.json: имя и скрипты
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const name = (pkg.name && String(pkg.name)) || path.basename(root);
    parts.push("Проект: " + name + " (каталог: " + root + ")");
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const scriptList = Object.keys(scripts).slice(0, 12).map((k) => k + ": " + String(scripts[k]).slice(0, 50));
    if (scriptList.length) parts.push("Скрипты package.json: " + scriptList.join("; "));
  } catch {}
  // Двухуровневая структура (без node_modules/.git и прочего мусора) с бюджетом
  // по знакам (BRIEF_TREE_CHARS) и пределом файлов из одной папки.
  const tree = [];
  let treeChars = 0;
  const addBriefLine = (line) => {
    tree.push(line);
    treeChars += line.length + 1; // + перевод строки
  };
  const walkBrief = (dir, depth) => {
    if (depth > 2 || tree.length >= BRIEF_TREE_MAX || treeChars >= BRIEF_TREE_CHARS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let filesShown = 0;
    let filesHidden = 0;
    for (const e of entries) {
      if (tree.length >= BRIEF_TREE_MAX || treeChars >= BRIEF_TREE_CHARS) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      // На последнем уровне папку не показываем: её содержимое уже не влезет, а имя
      // без содержимого — обманка (и запись третьего уровня, которой в визитке быть
      // не должно). Так структура остаётся честно двухуровневой.
      if (e.isDirectory() && depth >= 2) continue;
      if (!e.isDirectory()) {
        if (filesShown >= BRIEF_DIR_FILES) {
          filesHidden++;
          continue;
        }
        filesShown++;
      }
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
      addBriefLine((e.isDirectory() ? "📁 " : "📄 ") + rel + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walkBrief(path.join(dir, e.name), depth + 1);
    }
    // Хвост длинной полки — одной строкой со счётчиком: и видно, что там есть ещё,
    // и не стоит килобайта знаков (у журнала работ таких имён семь десятков).
    if (filesHidden) {
      const dirRel = path.relative(root, dir).split(path.sep).join("/");
      addBriefLine("📄 " + (dirRel ? dirRel + "/" : "") + "… ещё " + filesHidden + " файлов");
    }
  };
  walkBrief(root, 0);
  if (tree.length) parts.push("Структура (" + tree.length + " записей):\n" + tree.join("\n"));
  // README: первые непустые строки без разметки заголовков
  const readme = ["README.md", "readme.md", "Readme.md", "README.MD"]
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  if (readme) {
    try {
      const head = fs.readFileSync(readme, "utf8")
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .filter((l) => l && !/^```/.test(l))
        .slice(0, 10)
        .join(" · ");
      if (head) parts.push("README (начало): " + head);
    } catch {}
  }
  // Оболочки: агент сразу видит, что доступно (bash/sh появляются с Git for Windows),
  // и не тратит попытки на «а вдруг bash есть».
  try {
    parts.push("Оболочки: " + shellsBrief());
  } catch {}
  // Yandex Cloud: актуальный каталог и разрешения прямо в системном промпте.
  try {
    const ycLine = ycBriefLine(loadSettings());
    if (ycLine) parts.push(ycLine);
  } catch {}
  return parts.join("\n\n");
}

  return { buildProjectBrief, BRIEF_LIMITS: { treeChars: BRIEF_TREE_CHARS, treeMax: BRIEF_TREE_MAX, dirFiles: BRIEF_DIR_FILES } };
}

module.exports = { createProjectBrief };

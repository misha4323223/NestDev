"use strict";

/* ─── Поиск по всему проекту и обзор файлов ───────────────────────────────────
   Вынесено из main.js (этап B, часть 7): walkProject (общий обход проекта),
   listProjectFiles (список файлов для «осмотра») и searchProjectFiles (поиск по
   содержимому, как grep -r). Ими пользуется инструмент агента, поэтому важно,
   чтобы обход был один на всех: свой обход в каждом инструменте уже приводил к
   тому, что поиск не видел файлы в пропускаемых папках и наоборот.

   Из общего состояния модулю нужны: пути (resolvePath, agentWorkDir), список
   пропускаемых папок и предел размера файла — они приходят через deps, поэтому
   правило обхода остаётся одно и живёт на виду.

   Отдельная тонкость — BINARY_EXT. Таблица расширений создаётся позже модуля
   (её отдаёт регистрация файловых каналов), поэтому значение передаётся НЕ копией,
   а живой обёрткой с одним методом has(): код внутри перенесён дословно, а список
   расширений всегда берётся из общего места. */

function createProjectSearch(deps) {
  const { fs, path, resolvePath, agentWorkDir, SKIP_DIRS, MAX_FILE_SCAN, BINARY_EXT } = deps;

// Рекурсивный обход проекта: вызывает onFile(relPath, absPath); останавливается по лимитам.
function walkProject(root, opts, onFile) {
  const maxDepth = opts.maxDepth || 8;
  const maxFiles = opts.maxFiles || 4000;
  let visited = 0;
  (function walk(dir, depth) {
    if (depth > maxDepth || visited >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= maxFiles) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        visited++;
        onFile(rel, abs);
      }
    }
  })(root, 0);
}

// Список файлов проекта для «осмотра» (listFiles).
function listProjectFiles(settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  const out = [];
  const cap = 300;
  walkProject(root, { maxFiles: cap + 100 }, (rel) => {
    if (out.length < cap) out.push(rel.replace(/\\/g, "/"));
  });
  if (!out.length) return "В папке " + root + " нет файлов (или только в пропускаемых папках: node_modules, .git и т.п.).";
  const base = sub ? root : agentWorkDir(settings);
  const prefix = path.relative(agentWorkDir(settings), base) || "";
  const lines = out.map((f) => (prefix ? prefix.replace(/\\/g, "/") + "/" + f : f));
  const more = out.length >= cap ? "\n… (показаны первые " + cap + " записей)" : "";
  return "Файлы проекта (" + out.length + "):\n" + lines.join("\n") + more;
}

// Поиск по всем файлам проекта (searchProject), как grep -r.
function searchProjectFiles(pattern, settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  let re = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {}
  const maxResults = 40;
  const hits = [];
  walkProject(root, {}, (rel, abs) => {
    if (hits.length >= maxResults) return;
    if (BINARY_EXT.has(path.extname(abs).toLowerCase().replace(".", ""))) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_SCAN) return;
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (content.includes("\u0000")) return;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re ? re.test(lines[i]) : lines[i].includes(pattern)) {
        hits.push({ file: rel.replace(/\\/g, "/"), n: i + 1, text: lines[i].trim().slice(0, 220) });
      }
    }
  });
  if (!hits.length) return "Совпадений по «" + pattern + "» в проекте нет (каталог: " + root + ").";
  return (
    "Совпадения «" + pattern + "» (" + hits.length + "):\n" +
    hits.map((h) => h.file + ":" + h.n + "  " + h.text).join("\n") +
    "\n\nЧтобы посмотреть строки вокруг, используй readFileLines (path, start, count)."
  );
}
  return { walkProject, listProjectFiles, searchProjectFiles };
}

module.exports = { createProjectSearch };

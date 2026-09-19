"use strict";

/* ─── Анализ проекта: исходники, структура файла, переименование, ссылки ───────
   Вынесено из main.js (этап B, часть 10). На этих четырёх помощниках стоят
   инструменты «осмотреть проект», «структура файла», «переименовать» и «найти
   все ссылки»:

     • projectSourceFiles — собрать исходники проекта, не заходя в node_modules,
       .git, dist и прочий мусор (иначе любой осмотр утонет в чужих файлах);
     • buildFileStructure — импорты, экспорты и объявления верхнего уровня
       с номерами строк (с пределом строк, чтобы ответ не разросся);
     • refactorRenameFiles — переименование идентификатора ПО ГРАНИЦАМ СЛОВА
       во всех исходниках или в одном файле/папке; бинарные файлы пропускаются,
       поддерживается сухой прогон (dryRun);
     • findSymbolReferences — где символ определён, импортирован, вызван или просто
       упомянут, с классификацией каждой строки.

   Живого состояния нет: корень проекта и настройки приходят аргументами. */

function createProjectAnalysis(deps) {
  const { fs, path } = deps;

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Собирает исходники проекта, исключая node_modules/.git/dist и прочий мусор.
function projectSourceFiles(root) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", "__pycache__", ".venv", "venv", "target", "vendor", ".idea", ".vscode", ".cache", ".turbo", "node_modules"]);
  const EXT_OK = /\.(js|jsx|ts|tsx|mjs|cjs|json|css|scss|sass|less|html|htm|vue|svelte|py|go|rs|java|kt|kts|rb|php|cs|dart|md|markdown|yml|yaml|toml|sh|sql)$/i;
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 3000) return;
      if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".env.local") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (EXT_OK.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// Структура файла: импорты, экспорты и объявления верхнего уровня с номерами строк.
function buildFileStructure(abs, filter) {
  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { error: "не удалось прочитать файл: " + (e.message || String(e)) };
  }
  if (content.includes("\u0000")) return { error: "файл бинарный — структуру не показать" };
  const lines = content.split("\n");
  const filterRe = filter ? (() => { try { return new RegExp(String(filter), "i"); } catch { return null; } })() : null;
  const rows = [];
  const push = (lineNo, kind, text) => {
    const t = String(text || "").trim().slice(0, 110);
    if (!t) return;
    if (filterRe && !filterRe.test(kind + " " + t)) return;
    if (rows.length < 400) rows.push({ line: lineNo, kind, text: t });
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (rows.length >= 400) break;
    // импорты: import ... from 'x' / import 'x' / require('x')
    const imp = ln.match(/^\s*import\s+[^"']+?\s+from\s+["']([^"']+)["']/) ||
      ln.match(/^\s*import\s+\("?\s*["']([^"']+)["']/) ||
      ln.match(/^\s*import\s+["']([^"']+)["']\s*;?/) ||
      ln.match(/^\s*(?:const|let|var)\s+[\w$,\s{}*]+\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/);
    if (imp) { push(i + 1, "import", imp[1]); continue; }
    // экспорты
    const exp = ln.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/) ||
      ln.match(/^\s*export\s*\{[^}]*\}/) ||
      ln.match(/^\s*export\s+\*\s+from\s+["'][^"']+["']/);
    if (exp) { push(i + 1, "export", exp[1] || ln.trim().slice(0, 80)); continue; }
    // объявления верхнего уровня (без отступа)
    if (!/^\s/.test(ln)) {
      const dec = ln.match(/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func|fn|public|private|internal|static)\b[^;{=]*/);
      if (dec) push(i + 1, "decl", dec[0].trim());
    }
  }
  return { rows, totalLines: lines.length };
}

// Переименование идентификатора по границам слова во всех исходниках проекта (или в одном файле/папке).
function refactorRenameFiles(root, oldName, newName, dryRun) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(oldName)) return { error: "oldName должен быть валидным идентификатором (буквы/цифры/_/$)" };
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) return { error: "newName должен быть валидным идентификатором (буквы/цифры/_/$)" };
  if (oldName === newName) return { error: "oldName и newName совпадают" };
  const rootIsFile = argsPathIsFile(root);
  const files = rootIsFile ? [root] : projectSourceFiles(root);
  const re = new RegExp("(?<![A-Za-z0-9_$])" + escRe(oldName) + "(?![A-Za-z0-9_$])", "g");
  const changed = [];
  let total = 0;
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // бинарный файл
    let content;
    try { content = buf.toString("utf8"); } catch { continue; }
    const m = content.match(re);
    if (!m) continue;
    const count = m.length;
    total += count;
    const sampleLines = content.split("\n").filter((l) => new RegExp("(?<![A-Za-z0-9_$])" + escRe(oldName) + "(?![A-Za-z0-9_$])").test(l)).slice(0, 2).map((l) => l.trim().slice(0, 120));
    if (!dryRun) {
      try { fs.writeFileSync(f, content.replace(re, newName), "utf8"); } catch { continue; }
    }
    const relBase = rootIsFile ? path.dirname(root) : root;
    changed.push({ rel: path.relative(relBase, f).split(path.sep).join("/"), count, sample: sampleLines.join(" | ") });
  }
  return { dryRun, changed, total };
}
function argsPathIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Поиск использований символа по границам слова (аналог «Найти все ссылки» в IDE).
// root — рабочая папка проекта или конкретный файл/папка. Каждая строка-совпадение
// классифицируется: определение / импорт / вызов / ссылка.
function findSymbolReferences(root, symbol) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return { error: "symbol должен быть валидным идентификатором (буквы/цифры/_/$)" };
  const isFile = argsPathIsFile(root);
  const files = isFile ? [root] : projectSourceFiles(root);
  const re = new RegExp("(?<![A-Za-z0-9_$])" + escRe(symbol) + "(?![A-Za-z0-9_$])");
  const esc = escRe(symbol);
  const hits = [];
  for (const f of files) {
    if (hits.length >= 100) break;
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // бинарный файл
    const lines = buf.toString("utf8").split("\n");
    const rel = path.relative(isFile ? path.dirname(root) : root, f).split(path.sep).join("/") || path.basename(f);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 25 && hits.length < 100; i++) {
      const raw = lines[i];
      if (!re.test(raw)) continue;
      const t = raw.trim();
      let kind = "ссылка";
      const mods = "(?:async\\s+|static\\s+|get\\s+|set\\s+)*";
      if (/(^|[^A-Za-z0-9_$])(import\b|require\s*\()/.test(t) && !/^\s*(?:const|let|var)\s/.test(t)) kind = "импорт";
      else if (new RegExp("^(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|def|func|fn)\\s+" + esc + "\\b").test(t)) kind = "определение";
      else if (new RegExp("^(?:export\\s+)?(?:const|let|var)\\s+" + esc + "\\s*(?:=|:)").test(t)) kind = "определение";
      else if (new RegExp("^" + esc + "\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>").test(t)) kind = "определение";
      else if (new RegExp("^\\s{1,}" + mods + esc + "\\s*\\(").test(raw) && /\{\s*$/.test(raw)) kind = "определение";
      else if (new RegExp("(?:^|[^A-Za-z0-9_$])(?:new\\s+)?" + esc + "\\s*\\(").test(t)) kind = "вызов";
      else if (new RegExp("(^|[^A-Za-z0-9_$])new\\s+" + esc + "\\b").test(t)) kind = "вызов";
      hits.push({ file: rel, n: i + 1, kind, text: t.slice(0, 140) });
      perFile++;
    }
  }
  return { error: null, hits, truncated: hits.length >= 100 };
}
// ── Чтение файлов: нумерация строк, язык, структура ──────────────────────────
// Вынесено из main.js (этап B, часть 21). На этих помощниках стоят инструменты
// чтения файла и «структура файла»: без нумерации агент не может сослаться на
// строку, а без карты определений — осмотреть большой файл, не читая его целиком.
// Ошибка здесь тихая и дорогая: сбитая нумерация уводит правку на чужую строку,
// а потерянный предел раздувает ответ так, что агент его не прочтёт.

// Строки файла с номерами (pad по числу строк всего файла): « 12 | код».
function numberedLines(all, fromLine, toLine, total) {
  const pad = String(total).length;
  const out = [];
  for (let i = fromLine - 1; i < Math.min(toLine, all.length); i++) {
    out.push(String(i + 1).padStart(pad, " ") + " | " + all[i]);
  }
  return out.join("\n");
}

function langFromExt(p) {
  const ext = path.extname(p || "").toLowerCase();
  const map = {
    ".js": "JavaScript", ".jsx": "JavaScript/React", ".ts": "TypeScript", ".tsx": "TypeScript/React",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".c": "C",
    ".cpp": "C++", ".h": "C/C++ header", ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift",
    ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".md": "Markdown",
    ".sh": "Shell", ".bash": "Bash", ".sql": "SQL", ".dart": "Dart", ".lua": "Lua",
  };
  return map[ext] || "текст";
}

// Карта структуры файла: определения с номерами строк (языконезависимые эвристики)
const OUTLINE_RULES = [
  { kind: "функция", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "функция", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/ },
  { kind: "класс", re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "класс", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "метод", re: /^\s{2,}(?:async\s+)?(?:get|set\s+)?(?!(?:for|while|if|switch|catch|return)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  { kind: "функция", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "класс", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: "функция", re: /^\s*func\s+([A-Za-z_]\w*)/ },
  { kind: "функция", re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:fn|function)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "функция", re: /^\s*(?:def|pub\s+fn)\s+([A-Za-z_]\w*)/ },
  { kind: "заголовок", re: /^(#{1,4})\s+(.*)$/, nameOf: (m) => "#".repeat(m[1].length) + " " + m[2].slice(0, 80) },
  { kind: "css", re: /^([.#][\w-]+)\s*\{/ },
  { kind: "html", re: /^\s*<([a-zA-Z][\w-]*)([^>]*)>/, nameOf: (m) => {
      const id = /id=["']([^"']+)["']/.exec(m[2]);
      const cls = /class=["']([^"']+)["']/.exec(m[2]);
      return "<" + m[1] + (id ? " #" + id[1] : "") + (cls ? " ." + cls[1].split(/\s+/)[0] : "") + ">";
    } },
];

function buildFileOutline(content, filter, cap) {
  const all = content.split("\n");
  const entries = [];
  const filterRe = filter ? (() => { try { return new RegExp(filter, "i"); } catch { return null; } })() : null;
  const pad = String(all.length).length;
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    for (const rule of OUTLINE_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = rule.nameOf ? rule.nameOf(m) : m[1];
      if (filterRe && !filterRe.test(name) && !filterRe.test(rule.kind)) continue;
      entries.push({ line: i + 1, kind: rule.kind, name: String(name).slice(0, 90) });
      break; // одна запись на строку
    }
    if (entries.length >= cap) break;
  }
  const text = entries.map((e) => String(e.line).padStart(pad, " ") + " | " + e.kind.padEnd(8, " ") + " | " + e.name).join("\n");
  return { entries, text };
}

// Диапазоны определений файла (start..end) по тем же правилам, что и fileOutline.
// end = строка перед началом следующего определения (или последняя строка файла) —
// приблизительные, но достаточные границы «блока» для режима searchFile blocks:true.
function buildBlockRanges(all) {
  const ranges = [];
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    for (const rule of OUTLINE_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = rule.nameOf ? rule.nameOf(m) : m[1];
      ranges.push({ start: i + 1, kind: rule.kind, name: String(name).slice(0, 90) });
      break; // одна запись на строку
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    ranges[i].end = i + 1 < ranges.length ? ranges[i + 1].start - 1 : all.length;
  }
  return ranges;
}

  return { projectSourceFiles, buildFileStructure, refactorRenameFiles, findSymbolReferences, argsPathIsFile, escRe, numberedLines, langFromExt, buildFileOutline, buildBlockRanges };
}

module.exports = { createProjectAnalysis };

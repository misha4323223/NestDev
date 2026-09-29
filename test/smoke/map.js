"use strict";
/* ─── Карта набора smoke: чтение, проверка и пересборка ──────────────────────
   Что это. Карта (что где лежит) живёт в шапке test/smoke.test.js между
   маркерами КАРТА:START и КАРТА:END. С части 81 наборы разъехались по файлам
   (test/smoke/*.js), поэтому в строке карты назван и файл:

     | файл | строка | набор | что проверяет |

   Карта стареет молча: набор переехал, а номер строки остался — и она врёт хуже,
   чем её отсутствие. Поэтому карту проверяет сторож (testSelfIndex в наборе), а
   пересобирает scripts/smoke-map.js — оба одним разбором отсюда.

   Почему отдельный файл. Разбор карты нужен трём местам сразу: основе набора
   (проверки), scripts/smoke-map.js (пересборка) и test/smoke/source.js (текст
   всего набора читателям). В основе за разбором стоят дом помощников и
   стендовые ключи OTA — пересборщику карты они ни к чему. Здесь только fs и
   path: ни одного тяжёлого модуля.

   Разбор вынесен в чистые функции, чтобы их можно было проверить подложным
   текстом: страж без негативного контроля неотличим от «всегда молчит». */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", ".."); // корень проекта
const SET_FILE = path.join(ROOT, "test", "smoke.test.js"); // точка входа набора
const GROUP_DIR = __dirname; // файлы-группы набора лежат рядом

// Имя файла от корня проекта — так его называет и карта.
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

// Файлы набора: сначала точка входа, затем группы по имени. Сам source.js не
// входит: это не набор, а способ отдать его текст читателям.
function setFiles() {
  const groups = fs
    .readdirSync(GROUP_DIR)
    .filter((f) => f.endsWith(".js") && f !== "source.js")
    .sort();
  return [SET_FILE].concat(groups.map((f) => path.join(GROUP_DIR, f)));
}

// Тот же список, но с текстами — для читателей и проверок.
function setSources() {
  return setFiles().map((p) => ({ file: rel(p), text: fs.readFileSync(p, "utf8") }));
}

// Строки карты: файл, номер строки, имя набора, описание. Заголовок таблицы и
// её разделитель не подходят под разбор — у них в колонке номера не число.
function mapRows(src) {
  const a = src.indexOf("КАРТА:START");
  const b = src.indexOf("КАРТА:END");
  const block = a >= 0 && b > a ? src.slice(a, b) : "";
  return block
    .split("\n")
    .map((l) => /^\s*\|\s*([A-Za-z0-9_./-]+)\s*\|\s*(\d+)\s*\|\s*(test[A-Za-z0-9_]+)\s*\|\s*(.*?)\s*\|\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ file: m[1], line: Number(m[2]), name: m[3], desc: m[4] }));
}

// Наборы одного текста: имя и строка объявления.
function declaredSuites(src) {
  return [...src.matchAll(/^(?:async )?function (test[A-Za-z0-9_]+)\(/gm)].map((m) => ({
    name: m[1],
    line: src.slice(0, m.index).split("\n").length,
  }));
}

// Все наборы набора: файл, имя, строка. Карта и бегунок меряются ЭТИМ списком —
// тогда набор из забытого файла не может выпасть молча.
function declaredAll(sources) {
  const out = [];
  for (const s of sources) {
    for (const d of declaredSuites(s.text)) out.push({ file: s.file, name: d.name, line: d.line });
  }
  return out;
}

// Вызовы бегунка: `await testXxx();` в последнем блоке (async () => { ... })().
function runnerCalls(src) {
  const at = src.lastIndexOf("(async () => {");
  const block = at < 0 ? "" : src.slice(at);
  return [...block.matchAll(/^\s*await (test[A-Za-z0-9_]+)\(\);\s*$/gm)].map((m) => m[1]);
}

// Строка файла по номеру из карты (номер считается с единицы).
function lineAt(text, n) {
  return (text.split("\n")[n - 1] || "").trim();
}

// Последняя непустая строка текста — по ней видно, чем файл кончается.
function lastNonEmpty(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : "";
}

// Проблемы карты: пусто — карта верна. Возвращается список строк, а не boolean,
// чтобы падение говорило, ЧТО именно разъехалось. Без второго довода набором
// считается один текст: так проверку можно прогнать на подложном теле.
function mapProblems(src, sources) {
  const set = sources || [{ file: rel(SET_FILE), text: src }];
  const problems = [];
  const rows = mapRows(src);
  if (!rows.length) problems.push("карта не найдена (маркеры КАРТА:START / КАРТА:END)");
  const byFile = new Map(set.map((s) => [s.file, s.text]));
  for (const r of rows) {
    const text = byFile.get(r.file);
    if (text === undefined) {
      problems.push("в карте файл, которого нет в наборе: " + r.file);
      continue;
    }
    const head = lineAt(text, r.line).replace("async ", "");
    if (!head.startsWith("function " + r.name + "(")) {
      problems.push(r.file + ":" + r.line + " — там не объявление " + r.name);
    }
  }
  const declared = declaredAll(set);
  const key = (f, n) => f + " :: " + n;
  const rowKeys = rows.map((r) => key(r.file, r.name)).sort();
  const declKeys = declared.map((d) => key(d.file, d.name)).sort();
  if (new Set(rowKeys).size !== rowKeys.length) problems.push("в карте набор повторяется");
  const missing = declKeys.filter((k) => rowKeys.indexOf(k) < 0);
  const extra = rowKeys.filter((k) => declKeys.indexOf(k) < 0);
  if (missing.length) problems.push("в карте нет наборов: " + missing.join(", "));
  if (extra.length) problems.push("в карте лишние: " + extra.join(", "));
  const calls = runnerCalls(src);
  if (calls.length !== new Set(calls).size) problems.push("бегунок зовёт набор дважды");
  const notCalled = declared.map((d) => d.name).filter((n) => calls.indexOf(n) < 0);
  if (notCalled.length) problems.push("бегунок не зовёт: " + notCalled.join(", "));
  if (calls.length !== declared.length) {
    problems.push("вызовов в бегунке " + calls.length + ", наборов " + declared.length);
  }
  if (lastNonEmpty(src) !== "})();") problems.push("бегунок не последний в файле: " + lastNonEmpty(src).slice(0, 40));
  return problems;
}

module.exports = {
  ROOT,
  rel,
  SET_FILE,
  GROUP_DIR,
  setFiles,
  setSources,
  mapRows,
  declaredSuites,
  declaredAll,
  runnerCalls,
  lineAt,
  lastNonEmpty,
  mapProblems,
};

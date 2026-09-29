#!/usr/bin/env node
"use strict";
/* ─── Пересборка карты набора smoke ──────────────────────────────────────────
   Карта (что где лежит) живёт в шапке test/smoke.test.js между маркерами
   КАРТА:START и КАРТА:END. С части 81 наборы разъехались по файлам
   (test/smoke/*.js), поэтому в строке карты назван и файл:

     | файл | строка | набор | что проверяет |

   Зачем скрипт. Карту руками не поддерживают: при переносе набора меняются
   номера строк, и ручная правка врёт молча. Скрипт собирает карту из самих
   файлов, а описания берёт из прежней карты (новому набору — ближайший
   заголовок «// ── …» над объявлением, иначе имя первой проверки).

   Проверяет карту не он, а сторож набора (testSelfIndex) — и оба смотрят одним
   разбором из test/smoke/map.js, поэтому пересборка и проверка не разъедутся.

   Запуск:  node scripts/smoke-map.js           — пересобрать карту
            node scripts/smoke-map.js --check   — только проверить, не записывая
   Через npm флаг передаётся с двумя дефисами: npm run smoke:map -- --check
   (без «--» npm забирает --check себе, и скрипт молча пересоберёт карту). */

const fs = require("fs");
const path = require("path");

const map = require("../test/smoke/map.js");

const CHECK = process.argv.includes("--check");
const SET = map.SET_FILE;

// Описания из карты, какой бы она ни была: при первом прогоне новой карты её
// строки ещё без колонки файла, а описания терять нельзя.
function oldRows(text) {
  const a = text.indexOf("КАРТА:START");
  const b = text.indexOf("КАРТА:END");
  const block = a >= 0 && b > a ? text.slice(a, b) : "";
  const out = [];
  for (const l of block.split("\n")) {
    const m = /^\s*\|\s*(?:([A-Za-z0-9_./-]+)\s*\|\s*)?(\d+)\s*\|\s*(test[A-Za-z0-9_]+)\s*\|\s*(.*?)\s*\|\s*$/.exec(l);
    if (m) out.push({ file: m[1] || map.rel(SET), line: Number(m[2]), name: m[3], desc: m[4] });
  }
  return out;
}

// Описания прежней карты по именам наборов: при первом прогоне карта может быть
// ещё без колонки файла, а описания терять нельзя.
function oldDescriptions(rows) {
  const out = new Map();
  for (const r of rows) if (!out.has(r.name)) out.set(r.name, r.desc);
  return out;
}

// Описание набора: из прежней карты, иначе ближайший заголовок над объявлением,
// иначе имя первой проверки внутри набора.
function describe(text, line, name, old) {
  if (old.has(name)) return old.get(name);
  const lines = text.split("\n");
  for (let i = line - 2; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.startsWith("// ──")) return t.slice(t.indexOf("──") + 2).replace(/─+$/, "").trim();
    if (/^(?:async )?function |^(?:const|let|var) /.test(t)) break;
  }
  for (let i = line - 1; i < lines.length; i++) {
    const m = /test\(\s*"([^"]+)"/.exec(lines[i]);
    if (m) return m[1];
    if (lines[i] === "}") break;
  }
  return name;
}

// Таблица карты: колонки «файл», «строка» и «набор» выровнены, описание — нет
// (оно длинное и разной длины).
function buildBlock(rows) {
  const w = (head, vals) => Math.max(head.length, ...vals.map((v) => String(v).length));
  const wFile = w("файл", rows.map((r) => r.file));
  const wNum = w("строка", rows.map((r) => r.line));
  const wName = w("набор", rows.map((r) => r.name));
  const pad = (s, n) => s + " ".repeat(Math.max(0, n - s.length));
  const num = (n, width) => " ".repeat(Math.max(0, width - String(n).length)) + String(n);
  const out = [
    "   | " + pad("файл", wFile) + " | " + pad("строка", wNum) + " | " + pad("набор", wName) + " | что проверяет |",
    "   |" + "-".repeat(wFile + 2) + "|" + "-".repeat(wNum + 1) + ":|" + "-".repeat(wName + 2) + "|" + "-".repeat(16) + "|",
  ];
  for (const r of rows) {
    out.push("   | " + pad(r.file, wFile) + " | " + num(r.line, wNum) + " | " + pad(r.name, wName) + " | " + r.desc + " |");
  }
  return out.join("\n");
}

const setText = fs.readFileSync(SET, "utf8");
const was = oldRows(setText);
const old = oldDescriptions(was);

const lines = setText.split("\n");
const at = lines.findIndex((l) => l.trim() === "КАРТА:START");
const to = lines.findIndex((l) => l.trim() === "КАРТА:END");
if (at < 0 || to < at) {
  console.error("не нашёл маркеры КАРТА:START / КАРТА:END в " + map.rel(SET));
  process.exit(2);
}

// Наборы читаются с диска, но точка входа — тем текстом, который собираемся
// записать: иначе номера строк в ней считаются по СТАРОЙ карте, и стоит карте
// изменить число строк (набор добавился или уехал), как все наборы ниже карты
// разъедутся ровно на эту разницу.
const files = map.setFiles();
function rowsFor(entryText) {
  const rows = [];
  for (const p of files) {
    const text = p === SET ? entryText : fs.readFileSync(p, "utf8");
    for (const d of map.declaredSuites(text)) {
      rows.push({ file: map.rel(p), line: d.line, name: d.name, desc: describe(text, d.line, d.name, old) });
    }
  }
  return rows;
}
function substitute(text, rows) {
  const ls = text.split("\n");
  return ls.slice(0, at + 1).concat(buildBlock(rows).split("\n"), ls.slice(to)).join("\n");
}

// Сборка сходится в два прохода: сначала карта (по ней видно, сколько в ней
// строк), затем номера строк по уже подставленной карте. Цикл останавливается,
// как только текст перестал меняться.
let rows = rowsFor(setText);
if (!rows.length) {
  console.error("в наборе не нашлось ни одного набора — карту не собираю");
  process.exit(2);
}
let next = substitute(setText, rows);
for (let i = 0; i < 3 && next !== setText; i++) {
  const text = next;
  rows = rowsFor(text);
  next = substitute(text, rows);
}

const withSuites = new Set(rows.map((r) => r.file));
if (next === setText) {
  console.log("карта свежая: " + rows.length + " наборов в " + withSuites.size + " файл(ах)");
  process.exit(0);
}

if (CHECK) {
  const byName = new Map(was.map((r) => [r.file + " :: " + r.name, r]));
  const shown = [];
  for (const r of rows) {
    const o = byName.get(r.file + " :: " + r.name);
    if (!o) shown.push("  новый набор: " + r.file + " :: " + r.name);
    else if (o.line !== r.line) shown.push("  " + r.name + ": " + o.line + " → " + r.line);
  }
  const names = new Set(rows.map((r) => r.file + " :: " + r.name));
  for (const r of was) if (!names.has(r.file + " :: " + r.name)) shown.push("  пропал из набора: " + r.file + " :: " + r.name);
  console.error("карта устарела — пересоберите: npm run smoke:map");
  for (const l of shown.slice(0, 20)) console.error(l);
  if (shown.length > 20) console.error("  … всего расхождений: " + shown.length);
  process.exit(1);
}

fs.writeFileSync(SET, next);
console.log("карта пересобрана: " + rows.length + " наборов в " + withSuites.size + " файл(ах)");

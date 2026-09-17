"use strict";
/* ─── Аудит выносов из оболочки окна ─────────────────────────────────────────
   Зачем: при выносе куска кода из app.js в модуль важно, чтобы вызовы в оболочке
   только ПЕРЕИМЕНОВЫВАЛИСЬ (`scrollBottom()` → `ChatFeed.scrollBottom()`), а не
   подменялись другим вызовом. Один такой случай уже был: две строки подлинника
   (`pinnedToBottom = true; scrollBottom();`) превратились в `ChatFeed.jumpToBottom()`,
   который дополнительно трогает кнопку «↓» — и падал на удалённом элементе.

   Что делает: берёт две ревизии app.js (до и после выноса) и список модулей, куда
   код переехал, и раскладывает ушедшие из оболочки строки на четыре группы:
     • перенесено как есть — строка нашлась в модуле дословно;
     • перенесено с живым доступом — совпала после приведения подстановок состояния
       (`settings.x` → `getSettings().x`, `currentPreset` → `getPreset()`,
       `sbVersion = v` → `setSbVersion(v)`, `MobilePanel.x` → `getMobilePanel().x`,
       `SettingsSearch.y()` → `search.y()`);
     • переименование вызова — совпала со строкой оболочки или модуля после снятия
       имён модулей (`setSettingsMsg(` → `SettingsPanel.setSettingsMsg(`);
     • требует глаз — всё остальное (замены нескольких строк одним вызовом и прочее).

   Больше одной подстановки в одной строке аудит не разбирает намеренно: он должен
   ошибаться в сторону «покажи человеку», а не «объясню сам».

   Запуск:  node scripts/audit-extractions.js <до> <после> <модуль.js> [модуль.js ...]
   Пример:  node scripts/audit-extractions.js 1fc073e^ 1fc073e chat-feed.js chat-render.js
   Вместо ревизии «после» можно указать WORKTREE — тогда берётся файл с диска
   (аудит до коммита). */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODULES = ["ChatFeed", "ChatThinking", "ChatSegments", "ChatRender", "ChatWork", "ChatActions",
  "SettingsSearch", "SettingsPanel", "OpenaiProfiles", "MobilePanel", "TasksMission", "SecretsPanel",
  "YcPanel", "DevRun", "WebChat", "ProjectPanel"];

const [before, after, ...modules] = process.argv.slice(2);
if (!before || !after || !modules.length) {
  console.error("Нужно: node scripts/audit-extractions.js <до> <после> <модуль.js> [...]");
  process.exit(2);
}

// WORKTREE — текущее содержимое файла на диске: аудит можно гнать до коммита.
const show = (rev, file) =>
  rev === "WORKTREE"
    ? fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    : execSync("git show " + rev + ":" + file, { encoding: "utf8", maxBuffer: 1 << 28 });
const lines = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const countMap = (arr) => {
  const m = new Map();
  for (const l of arr) m.set(l, (m.get(l) || 0) + 1);
  return m;
};
// Снимаем имена модулей: `SettingsPanel.setSettingsMsg(` и `setSettingsMsg(` — одно и то же действие.
const stripModules = (line) => {
  let out = line;
  for (const m of MODULES) out = out.split(m + ".").join("");
  return out;
};
// Приводим подстановки живого доступа к общему виду, чтобы строка до и после выноса
// сравнивалась по действию, а не по способу достать состояние.
const canon = (line) =>
  stripModules(line)
    .replace(/\bgetSettings\(\)/g, "@cfg@")
    .replace(/\bgetPreset\(\)/g, "@preset@")
    .replace(/\bsetCurrentPreset\b/g, "@wpreset@")
    .replace(/\bcurrentPreset\b/g, "@preset@")
    .replace(/\bgetLastTab\(\)/g, "@tab@")
    .replace(/\bsetLastTab\b/g, "@wtab@")
    .replace(/\blastSettingsTab\b/g, "@tab@")
    .replace(/\bsetSbVersion\b/g, "@wver@")
    .replace(/\bsbVersion\b/g, "@ver@")
    .replace(/\bgetMobilePanel\(\)\./g, "@mobile@.")
    .replace(/\bsettings\b/g, "@cfg@");

const beforeMap = countMap(lines(show(before, "src/renderer/app.js")));
const afterLines = lines(show(after, "src/renderer/app.js"));
const afterMap = countMap(afterLines);
const afterCanon = countMap(afterLines.map(canon));
const moduleText = modules.map((m) => show(after, "src/renderer/" + m)).join("\n");
const moduleLines = lines(moduleText);
const moduleMap = countMap(moduleLines);
const moduleCanon = countMap(moduleLines.map(canon));

// Строки, которых в app.js стало меньше (то есть ушли из оболочки).
const gone = [];
for (const [line, n] of beforeMap) {
  const left = n - (afterMap.get(line) || 0);
  for (let i = 0; i < left; i++) gone.push(line);
}

const take = (map, key) => {
  const got = map.get(key) || 0;
  if (!got) return false;
  map.set(key, got - 1);
  return true;
};

const moved = [];
const liveAccess = [];
const renamed = [];
const manual = [];
for (const line of gone) {
  if (take(moduleMap, line)) { moved.push(line); continue; }
  if (take(moduleCanon, canon(line))) { liveAccess.push(line); continue; }
  if (take(afterCanon, canon(line))) { renamed.push(line); continue; }
  manual.push(line);
}

console.log("Аудит выноса " + before + " → " + after);
console.log("  модули: " + modules.join(", "));
console.log("  ушло из оболочки: " + gone.length);
console.log("  перенесено как есть: " + moved.length);
console.log("  перенесено с живым доступом: " + liveAccess.length);
console.log("  переименование вызова: " + renamed.length);
console.log("  требует глаз: " + manual.length);
for (const line of manual) console.log("    • " + line.slice(0, 130));
if (manual.length) {
  console.log("\nКаждую строку из «требует глаз» надо объяснить вручную: посмотреть, чем она");
  console.log("заменена в оболочке, и убедиться, что это то же действие (или осознанная замена).");
}
process.exit(manual.length ? 1 : 0);

"use strict";
/* ─── Аудит выносов из оболочки окна ─────────────────────────────────────────
   Зачем: при выносе куска кода из app.js в модуль важно, чтобы вызовы в оболочке
   только ПЕРЕИМЕНОВЫВАЛИСЬ (`scrollBottom()` → `ChatFeed.scrollBottom()`), а не
   подменялись другим вызовом. Один такой случай уже был: две строки подлинника
   (`pinnedToBottom = true; scrollBottom();`) превратились в `ChatFeed.jumpToBottom()`,
   который дополнительно трогает кнопку «↓» — и падал на удалённом элементе.

   Что делает: берёт две ревизии app.js (до и после выноса) и список модулей, куда
   код переехал, и раскладывает ушедшие из оболочки строки на три группы:
     • перенесено как есть — строка нашлась в модуле дословно;
     • переименование вызова — после снятия имён модулей строка совпала с модулем;
     • требует глаз — всё остальное (замены нескольких строк одним вызовом и прочее).

   Запуск:  node scripts/audit-extractions.js <до> <после> <модуль.js> [модуль.js ...]
   Пример:  node scripts/audit-extractions.js 1fc073e^ 1fc073e chat-feed.js chat-render.js
*/
const { execSync } = require("child_process");

const MODULES = ["ChatFeed", "ChatThinking", "ChatSegments", "ChatRender", "ChatWork", "ChatActions",
  "SettingsSearch", "OpenaiProfiles", "MobilePanel", "TasksMission", "SecretsPanel", "YcPanel", "DevRun", "WebChat"];

const [before, after, ...modules] = process.argv.slice(2);
if (!before || !after || !modules.length) {
  console.error("Нужно: node scripts/audit-extractions.js <до> <после> <модуль.js> [...]");
  process.exit(2);
}

const show = (rev, file) => execSync("git show " + rev + ":" + file, { encoding: "utf8", maxBuffer: 1 << 28 });
const lines = (t) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const countMap = (arr) => {
  const m = new Map();
  for (const l of arr) m.set(l, (m.get(l) || 0) + 1);
  return m;
};
const strip = (line) => {
  let out = line;
  for (const m of MODULES) out = out.split(m + ".").join("");
  return out;
};

const beforeMap = countMap(lines(show(before, "src/renderer/app.js")));
const afterMap = countMap(lines(show(after, "src/renderer/app.js")));
const moduleText = modules.map((m) => show(after, "src/renderer/" + m)).join("\n");
const moduleMap = countMap(lines(moduleText));
const moduleStripped = new Set([...moduleMap.keys()].map(strip));

// Строки, которых в app.js стало меньше (то есть ушли из оболочки).
const gone = [];
for (const [line, n] of beforeMap) {
  const left = n - (afterMap.get(line) || 0);
  for (let i = 0; i < left; i++) gone.push(line);
}

const moved = [];
const renamed = [];
const manual = [];
for (const line of gone) {
  const got = moduleMap.get(line) || 0;
  if (got > 0) { moduleMap.set(line, got - 1); moved.push(line); continue; }
  if (moduleStripped.has(strip(line))) { renamed.push(line); continue; }
  manual.push(line);
}

console.log("Аудит выноса " + before + " → " + after);
console.log("  модули: " + modules.join(", "));
console.log("  ушло из оболочки: " + gone.length);
console.log("  перенесено как есть: " + moved.length);
console.log("  переименование вызова: " + renamed.length);
console.log("  требует глаз: " + manual.length);
for (const line of manual) console.log("    • " + line.slice(0, 130));
if (manual.length) {
  console.log("\nКаждую строку из «требует глаз» надо объяснить вручную: посмотреть, чем она");
  console.log("заменена в оболочке, и убедиться, что это то же действие (или осознанная замена).");
}
process.exit(manual.length ? 1 : 0);

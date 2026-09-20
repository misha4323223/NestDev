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

   С 1.5.184 аудит умеет и бэкенд-модули (этап B): если модуль лежит в `src/`, а не
   в `src/renderer/`, оболочкой считается `src/main.js`. Смешивать окно и бэкенд в
   одном вызове нельзя — это две разные оболочки.

   Запуск:  node scripts/audit-extractions.js <до> <после> <модуль.js> [модуль.js ...]
   Пример:  node scripts/audit-extractions.js 1fc073e^ 1fc073e chat-feed.js chat-render.js
   Вместо ревизии «после» можно указать WORKTREE — тогда берётся файл с диска
   (аудит до коммита). */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODULES = ["ChatFeed", "ChatThinking", "ChatSegments", "ChatRender", "ChatWork", "ChatActions",
  "SettingsSearch", "SettingsPanel", "OpenaiProfiles", "MobilePanel", "TasksMission", "SecretsPanel",
  "YcPanel", "DevRun", "WebChat", "ProjectPanel", "ChatEvents", "G4fPanel", "AutoTasks", "ModelPopup", "AskModal", "ChatRename", "ChatStore", "ChatRun", "ChatSend", "ChatContinue", "PlanPanel"];

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

/* Модуль лежит либо в окне (`src/renderer/`), либо в главном процессе (`src/`).
   До 1.5.184 аудит знал только окно и на бэкенд-модуле падал с ENOENT — то есть
   правило «перенос проверяется аудитом» для этапа B выполнить было нечем.
   Оболочку берём по месту модуля: app.js для окна, main.js для бэкенда.

   ВАЖНО: этот блок обязан стоять ПОСЛЕ объявления `show`. На первой попытке он стоял
   выше, ошибка «Cannot access before initialization» попала в `catch` и выглядела как
   «модуль не найден» — то есть проверка тихо обвинила невиновного. Поэтому ловим
   строго ошибки файловой системы и git, а не что попало. */
const fileMissing = (e) => {
  const msg = String((e && (e.stderr || e.message)) || e);
  return /ENOENT|could not|bad revision|exists on disk, but not in|did not match|fatal: path/i.test(msg);
};
const has = (rev, file) => {
  try {
    show(rev, file);
    return true;
  } catch (e) {
    if (!fileMissing(e)) throw e;
    return false;
  }
};
const moduleRel = (m) => {
  if (has(after, "src/renderer/" + m)) return "src/renderer/" + m;
  if (has(after, "src/" + m)) return "src/" + m;
  console.error("Модуль не найден ни в src/renderer/, ни в src/: " + m);
  process.exit(2);
};
const moduleRels = modules.map(moduleRel);
const SHELLS = [...new Set(moduleRels.map((rel) => (rel.startsWith("src/renderer/") ? "src/renderer/app.js" : "src/main.js")))];
if (SHELLS.length !== 1) {
  console.error("Модули из разных оболочек (окно и главный процесс) — аудит ведётся по одной за раз: " + SHELLS.join(" + "));
  process.exit(2);
}
const SHELL = SHELLS[0];
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
    // Этап A, часть 1: события агента и оверлеи — свои живые доступы.
    .replace(/\bgetChatsData\(\)/g, "@chats@")
    .replace(/\bchatsData\b/g, "@chats@")
    .replace(/\bgetSession\(\)/g, "@sess@")
    .replace(/\bsession\b/g, "@sess@")
    // Этап A, часть 8: прогон ответа — счётчик отката, признак показанной кнопки
    // и объект остановки читаются живьём (их меняют и разбор событий агента, и
    // загрузка истории, и старт прогона). Правила стоят ДО замены самих имён,
    // иначе модульные формы не свелись бы к виду оболочки.
    .replace(/\bgetLastUndoCount\(\)/g, "lastUndoCount")
    .replace(/\bgetUndoRestoreShown\(\)/g, "undoRestoreShown")
    .replace(/\bgetWebAbort\(\)/g, "webAbort")
    .replace(/\bsetLastUndoCount\b/g, "@wundo@")
    .replace(/\blastUndoCount\b/g, "@undo@")
    .replace(/\bsetPlanCollapsed\b/g, "@wplanc@")
    .replace(/\bplanCollapsed\b/g, "@planc@")
    .replace(/\bsetRemoteRunNotified\b/g, "@wremn@")
    .replace(/\bremoteRunNotified\b/g, "@remn@")
    .replace(/\bgetSidePanel\(\)\./g, "@side@.")
    // Панель дел зовётся отложенной стрелкой (getTasksMission().renderTasks()), а в
    // оболочке стояло TasksMission.renderTasks(). Имя модуля снято выше, как и у
    // остальных панелей: сравниваем действие, а не способ достать панель.
    .replace(/\bgetTasksMission\(\)\./g, "")
    // Панель настроек тоже зовётся отложенной стрелкой (getSettingsPanel().updateBadge()).
    .replace(/\bgetSettingsPanel\(\)\./g, "")
    // Этап A, часть 7: хранилище — предел истории планов объявлен в оболочке ниже
    // точки сбора, поэтому читается стрелкой (иначе окно падало бы на загрузке).
    .replace(/\bgetPlanArchiveLimit\(\)/g, "PLAN_ARCHIVE_LIMIT")
    // Этап A, часть 9: отправка — свои живые доступы. Стрелки к модулям, собранным
    // НИЖЕ точки выноса, снимаются так же, как у панелей выше: сравниваем действие.
    .replace(/\bgetChatFeed\(\)\./g, "")
    .replace(/\bgetPlanPanel\(\)\./g, "")
    .replace(/\bgetChatEvents\(\)\./g, "")
    .replace(/\bgetChatRun\(\)\./g, "")
    .replace(/\bgetAutoTasks\(\)\./g, "")
    .replace(/\bgetWebChat\(\)\./g, "")
    .replace(/\bgetPlanToggleOn\(\)/g, "planToggleOn")
    .replace(/\bplanToggleOn\b/g, "@plan@")
    .replace(/\bgetPendingImage\(\)/g, "pendingImage")
    .replace(/\bpendingImage\b/g, "@img@")
    // Этап A, часть 4: автозадачи — свой живой доступ к идущему прогону.
    .replace(/\bgetStreaming\(\)/g, "@run@")
    .replace(/\bstreaming\b/g, "@run@")
    .replace(/\bgetProjectPanel\(\)\./g, "@proj@.")
    .replace(/\bsettings\b/g, "@cfg@");

const beforeMap = countMap(lines(show(before, SHELL)));
const afterLines = lines(show(after, SHELL));
const afterMap = countMap(afterLines);
const afterCanon = countMap(afterLines.map(canon));
const moduleText = moduleRels.map((rel) => show(after, rel)).join("\n");
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
console.log("  оболочка: " + SHELL);
console.log("  модули: " + moduleRels.join(", "));
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

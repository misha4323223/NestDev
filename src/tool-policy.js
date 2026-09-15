"use strict";

/* ── Политика инструментов агента: что инструмент делает и чем рискует ──────────
   Одна точка правды о правах инструментов. До этого знание об опасности было
   размазано по коду: регулярка опасных команд, набор DANGEROUS_TOOLS, чекбоксы
   в настройках. Теперь у каждого инструмента есть capability (что он делает)
   и risk (насколько опасно) — на этом строятся:

   - подтверждение опасных действий (needsConfirm / isDangerousCommand);
   - журнал действий (audit-log.js берёт отсюда capability и risk);
   - профили автономности (Safe / Developer / Autonomous / DevOps) — им нужен
     только список capability, который уже есть здесь.

   Формат: capability → { risk, confirm, tools: [...] }. Инструмент, которого нет
   в таблице, получает capability "unknown" и risk "medium": он НЕ блокируется, но
   попадает в журнал — видно, что про него забыли.

   ВАЖНО: это метаданные, а не замена существующим запретам. Чекбоксы в настройках
   («разрешить агенту пушить», «создавать ресурсы в YC», «отправлять письма»)
   остаются главными: политика только ДОБАВЛЯЕТ подтверждение и запись в журнал.
   Модуль не требует electron и тестируется в plain-node.
*/

const RISK = { LOW: "low", MEDIUM: "medium", HIGH: "high" };
const RISK_WEIGHT = { low: 1, medium: 2, high: 3 };

// Команды, которые агент может выполнять только после явного подтверждения
// пользователя (удаление данных, принудительный push, очистка истории и т.п.).
// Раньше регулярка жила в main.js — перенесена сюда без изменений.
const DANGEROUS_CMD_RE =
  /(^|\s)(rm\s+-[a-z]*r|rmdir\s+\/s|rd\s+\/s|del\s+\/f|format\s+[a-z]:|mkfs\.|dd\s+if=|git\s+push([\s;&|()]|$)|git\s+reset\s+--hard|git\s+clean\s+-f|git\s+checkout\s+--|shutdown\s|taskkill\s+\/f|:?\(\)\s*\{|chmod\s+-R\s+777|sudo\s+rm|powershell\s+.*remove-item|Remove-Item\s+-Recurse|\bdel\b.*\/s)/i;

// Команды, которые существуют только чтобы напечатать ВСЁ окружение.
// Им секреты не выдаём: иначе модель одной строкой вываливает пароли пользователя
// в чат (и в контекст модели). Окружение при этом остаётся рабочим — без секретов.
// Ловим только «голый» дамп (env, printenv, set, Get-ChildItem Env:): явный запрос
// конкретной переменной (printenv MY_KEY) — это осознанное действие, оно работает
// и остаётся видимым в переписке.
const ENV_DUMP_RE =
  /(^|[\s;&|(])(env|printenv|export\s+-p|declare\s+-x|set)(\s*($|\||>|;))|env:|\[environment\]::|\/proc\/self\/environ|GetEnvironmentVariable|Get-ChildItem\s+(Env|Environment)/i;

// ── Таблица прав ──────────────────────────────────────────────────────────────
// risk:    low — чтение и безобидные операции; medium — изменения на диске/системе;
//          high — необратимое, приватное или выходящее наружу.
// confirm: спрашивать пользователя. Ставим ТОЛЬКО там, где сейчас нет другой
//          защиты — иначе получаются двойные диалоги на каждый чих.
const CAPABILITIES = [
  // ── чтение проекта ──
  { cap: "files.read", risk: RISK.LOW, tools: [
    "readFile", "readFileLines", "readFileStructure", "listFiles", "listDirectory", "searchFile",
    "searchProject", "fileOutline", "semanticSearch", "findReferences", "explainCode", "explainError",
    "getDependencies", "diffView", "memoryList", "memorySearch", "noteRead", "noteList",
    "checkpointList", "findTools", "agentGuide", "listPorts", "checkPort", "checkUrl",
    "listProcesses", "getSystemInfo", "checkInstalledProgram", "canExecute", "shellsStatus",
    "listBackground", "backgroundOutput", "todoWrite", "askUser",
  ]},
  // ── запись в проект ──
  { cap: "files.write", risk: RISK.MEDIUM, tools: [
    "writeFile", "editFile", "applyPatch", "createFolder", "undoEdit", "refactorRename",
    "formatCode", "downloadAndExtract",
  ]},
  // ── команды оболочки ──
  { cap: "terminal.execute", risk: RISK.MEDIUM, tools: [
    "runCommand", "runCommandOutput", "retryCommand", "timeoutCommand", "startBackground",
    "stopBackground", "sendInput", "shellStart", "shellSend", "runScript",
  ]},
  { cap: "terminal.admin", risk: RISK.HIGH, confirm: true, tools: ["runCommandAsAdmin"] },
  // ── git ──
  { cap: "git.read", risk: RISK.LOW, tools: ["gitStatus", "gitDiff", "gitLog", "gitBranch", "gitBlame"] },
  { cap: "git.clone", risk: RISK.MEDIUM, tools: ["gitClone", "gitPull"] },
  { cap: "git.commit", risk: RISK.MEDIUM, tools: [
    "gitCommit", "gitInit", "gitStash", "gitCheckout", "gitCherryPick", "gitRevert", "gitUndoLastCommit",
  ]},
  // push наружу: свой чекбокс allowAgentPush в настройках, подтверждение не дублируем.
  { cap: "git.push", risk: RISK.HIGH, tools: ["gitPush", "gitPublish"] },
  // ── браузер ──
  { cap: "browser.read", risk: RISK.LOW, tools: [
    "browserStatus", "browserSnapshot", "browserText", "browserDOM", "browserOverlays",
    "browserNetwork", "browserScreenshot", "browserWait", "waitForIdle",
  ]},
  { cap: "browser.act", risk: RISK.MEDIUM, tools: [
    "browserOpen", "browserClick", "browserFill", "browserPress", "browserSelect", "browserAct",
    "browserEval", "browserScroll", "browserHover", "browserClose",
  ]},
  // Вход в СВОЙ Chrome — свой чекбокс browserConnect в настройках.
  { cap: "browser.account", risk: RISK.HIGH, tools: ["browserConnect"] },
  { cap: "browser.profile.delete", risk: RISK.MEDIUM, confirm: true, tools: ["browserClearProfile"] },
  // ── окно приложения ──
  { cap: "app.read", risk: RISK.LOW, tools: ["appRead", "appScreenshot", "screenshotCapture"] },
  { cap: "app.control", risk: RISK.MEDIUM, tools: [
    "appClick", "appFill", "appSelect", "appPress", "appWait",
  ]},
  // ── превью и внешние ссылки ──
  { cap: "preview.run", risk: RISK.MEDIUM, tools: ["previewUI", "openUrl"] },
  // ── сеть ──
  { cap: "web.read", risk: RISK.LOW, tools: ["webSearch", "webFetch"] },
  { cap: "agent.wait", risk: RISK.LOW, tools: ["waitUntil"] },
  { cap: "media.analyze", risk: RISK.LOW, tools: ["analyzeImage", "showImage"] },
  { cap: "media.generate", risk: RISK.MEDIUM, tools: ["generateImage"] },
  // ── дела и заметки ──
  { cap: "tasks.read", risk: RISK.LOW, tools: ["taskList"] },
  { cap: "tasks.write", risk: RISK.LOW, tools: ["taskAdd", "taskUpdate", "taskDone", "taskDelete"] },
  { cap: "notes.write", risk: RISK.LOW, tools: ["noteSave", "noteDelete", "checkpointSave"] },
  // Откат чекпоинта перезаписывает файлы проекта — спрашиваем.
  { cap: "notes.restore", risk: RISK.MEDIUM, confirm: true, tools: ["checkpointRollback"] },
  // ── почта ──
  { cap: "mail.read", risk: RISK.LOW, tools: ["mailList", "mailCode"] },
  // Отправка писем: свой чекбокс mailAllowAgentSend, подтверждение не дублируем.
  { cap: "mail.send", risk: RISK.HIGH, tools: ["mailSend"] },
  // ── пароли сайтов ──
  { cap: "vault.read", risk: RISK.HIGH, tools: ["vaultList"] },
  { cap: "vault.fill", risk: RISK.HIGH, tools: ["vaultFill"] },
  // ── сборка, тесты, зависимости, БД ──
  { cap: "project.build", risk: RISK.MEDIUM, tools: [
    "runTests", "lintProject", "validateProject", "installPackage", "dockerBuild", "dockerRun",
    "dockerExec",
  ]},
  // Произвольный SQL может дропнуть таблицы — риск высокий, но подтверждение
  // дублировало бы обычный диалог; запись в журнал обязательна.
  { cap: "db.query", risk: RISK.HIGH, tools: ["dbQuery"] },
  { cap: "api.request", risk: RISK.MEDIUM, tools: ["apiRequest"] },
  // ── переменные окружения агента (секреты) ──
  { cap: "secrets.read", risk: RISK.LOW, tools: ["envList"] },
  { cap: "secrets.write", risk: RISK.MEDIUM, tools: ["envSet", "envUnset"] },
  // ── система ──
  { cap: "system.process.kill", risk: RISK.HIGH, confirm: true, tools: ["killProcess"] },
  { cap: "system.registry.write", risk: RISK.HIGH, confirm: true, tools: ["registryWrite"] },
  { cap: "system.registry.read", risk: RISK.MEDIUM, tools: ["registryRead"] },
  { cap: "system.install", risk: RISK.HIGH, confirm: true, tools: ["installExe", "installSystemPackage"] },
  { cap: "system.packages.search", risk: RISK.LOW, tools: ["wingetSearch"] },
  { cap: "system.shell", risk: RISK.MEDIUM, tools: ["openPath", "refreshEnv"] },
  { cap: "screen.read", risk: RISK.MEDIUM, tools: ["screenshotDesktop"] },
  { cap: "clipboard.read", risk: RISK.MEDIUM, tools: ["clipboardRead"] },
  { cap: "clipboard.write", risk: RISK.MEDIUM, tools: ["clipboardWrite"] },
  // ── Yandex Cloud ──
  { cap: "cloud.read", risk: RISK.LOW, tools: ["ycStatus", "ycList", "ycContainer", "ycLogs", "ycCosts"] },
  // Создание/удаление/деплой в облаке: свои чекбоксы ycAllowAgent*, подтверждение не дублируем.
  { cap: "cloud.create", risk: RISK.HIGH, tools: ["ycCreate"] },
  { cap: "cloud.delete", risk: RISK.HIGH, tools: ["ycDelete"] },
  { cap: "cloud.deploy", risk: RISK.HIGH, tools: ["ycDeploy"] },
  { cap: "cloud.cli.install", risk: RISK.MEDIUM, tools: ["ycInstall"] },
  // ── самообновление приложения ──
  { cap: "self.update", risk: RISK.MEDIUM, tools: ["otaCheck"] },
  { cap: "self.status", risk: RISK.LOW, tools: ["otaStatus"] },
  { cap: "self.rollback", risk: RISK.HIGH, confirm: true, tools: ["otaRollback"] },
];

// Индексы: имя инструмента → политика; capability → имена инструментов.
const _byTool = new Map();
const _byCap = new Map();
for (const entry of CAPABILITIES) {
  const names = [];
  for (const t of entry.tools || []) {
    if (_byTool.has(t)) continue;
    _byTool.set(t, { capability: entry.cap, risk: entry.risk, confirm: !!entry.confirm });
    names.push(t);
  }
  _byCap.set(entry.cap, names);
}

// Инструменты, требующие подтверждения (для совместимости с прежним DANGEROUS_TOOLS).
const CONFIRM_TOOLS = new Set(
  CAPABILITIES.filter((c) => c.confirm).reduce((acc, c) => acc.concat(c.tools || []), [])
);

// Инструменты конкретной capability (копия — вызывающий не должен править индекс).
function toolsForCapability(cap) {
  return (_byCap.get(String(cap)) || []).slice();
}

const UNKNOWN = { capability: "unknown", risk: RISK.MEDIUM, confirm: false };

// Политика инструмента. Неизвестный инструмент не блокируется — но помечается
// как unknown/medium, чтобы он был виден в журнале.
function policy(name) {
  const base = _byTool.get(String(name || ""));
  if (!base) return { name: String(name || ""), ...UNKNOWN };
  return { name: String(name || ""), ...base };
}

function capabilityOf(name) {
  return policy(name).capability;
}

function riskOf(name) {
  return policy(name).risk;
}

function riskWeight(name) {
  return RISK_WEIGHT[riskOf(name)] || RISK_WEIGHT.medium;
}

// Нужно ли подтверждение пользователя перед вызовом инструмента.
function needsConfirm(name) {
  return policy(name).confirm === true;
}

// Опасная ли команда оболочки (та же регулярка, что и раньше в main.js).
function isDangerousCommand(command) {
  return DANGEROUS_CMD_RE.test(String(command || ""));
}

// Команда только печатает окружение — секреты ей не выдаём.
function commandDumpsEnv(command) {
  return ENV_DUMP_RE.test(String(command || ""));
}

// Человеческое описание действия для диалога подтверждения.
function describe(name, args) {
  const x = args || {};
  if (name === "killProcess") return "завершить процесс «" + (x.name || x.pid || "?") + "»" + (x.force ? " (принудительно)" : "");
  if (name === "registryWrite") return "записать значение реестра «" + (x.name || "") + "» в " + (x.path || "?");
  if (name === "installExe") return "скачать и запустить установщик: " + String(x.url || "").slice(0, 120);
  if (name === "installSystemPackage") return "установить программу: " + String(x.name || x.package || x.id || "?");
  if (name === "runCommandAsAdmin") return "выполнить с правами администратора: " + String(x.command || "").slice(0, 160);
  if (name === "otaRollback") return "откатить приложение на предыдущую версию (OTA)";
  if (name === "browserClearProfile") return "очистить профиль браузера агента (входы на сайты и куки будут удалены)";
  if (name === "checkpointRollback") return "восстановить файлы из чекпоинта: " + String(x.name || x.id || "?");
  return name + " " + JSON.stringify(x).slice(0, 120);
}

// ── Редакция секретов ────────────────────────────────────────────────────────
// Журнал не должен содержать ни паролей, ни ключей, ни токенов — ни в ключах
// аргументов, ни в значениях, ни в строке результата.
const SECRET_KEY_PARTS = [
  "password", "passwd", "secret", "token", "apikey", "accesskey", "privatekey",
  "credential", "cookie", "session", "oauth", "bearer", "iamtoken", "refresh",
];

function looksSecretKey(key) {
  const n = String(key == null ? "" : key).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return false;
  if (n === "pin" || n.endsWith("pin")) return true;
  return SECRET_KEY_PARTS.some((p) => n.includes(p));
}

// Ключи-отпечатки популярных провайдеров + длинные токены вида «eyJ...».
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9_-]{8,}|rk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9_-]{10,}|y0_[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{10,}|xox[bap]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\d{8,12}:[A-Za-z0-9_-]{30,})/g;

const MAX_STR = 300;
const MAX_ITEMS = 20;
const MAX_KEYS = 30;

// Вычистить секреты из произвольного текста (результат инструмента, сообщение).
// secrets — конкретные значения (например переменные агента): их вырезаем по
// подстроке, потому что по виду такое значение ничем не выдаёт себя.
function scrub(text, limit, secrets) {
  let t = String(text == null ? "" : text);
  if (Array.isArray(secrets)) {
    for (const v of secrets) {
      const sv = String(v == null ? "" : v);
      if (sv.length >= 6) t = t.split(sv).join("***");
    }
  }
  // «TOKEN=...», «password: ...» — значение не показываем.
  t = t.replace(/((?:token|secret|password|passwd|api[_-]?key|apikey|authorization)\s*[=:]\s*)("[^"]*"|\S+)/gi, "$1***");
  t = t.replace(SECRET_VALUE_RE, "***");
  t = t.replace(/\s+/g, " ").trim();
  const cap = limit || MAX_STR;
  return t.length > cap ? t.slice(0, cap) + "…" : t;
}

// Глубокая редакция объекта (аргументы инструмента).
function redact(value, depth, secrets) {
  const d = depth || 0;
  if (value == null || d > 3) return value == null ? value : "…";
  if (typeof value === "string") {
    // Длинные тексты (содержимое файла, патч, SQL) целиком в журнале не нужны:
    // храним только начало — иначе журнал раздувается на ровном месте.
    if (value.length > MAX_STR) return scrub(value.slice(0, 200), 0, secrets) + " …(всего " + value.length + " символов)";
    return scrub(value, 0, secrets);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => redact(v, d + 1, secrets));
    if (value.length > MAX_ITEMS) out.push("…ещё " + (value.length - MAX_ITEMS));
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    const keys = Object.keys(value).slice(0, MAX_KEYS);
    for (const k of keys) out[k] = looksSecretKey(k) ? "***" : redact(value[k], d + 1, secrets);
    return out;
  }
  return String(value);
}

// ── Выдача секретов по назначению ─────────────────────────────────────────────
// Переменные агента (`settings.agentEnv`) — это ключи, пароли и токены
// пользователя. Раньше их получала ЛЮБАЯ команда агента: и сборка проекта, и git,
// и облако, и браузер. Теперь переменную можно выдать конкретному инструменту —
// вернее, его capability или целой группе (`terminal`, `git`, `cloud`, …).
//
// Правила (совместимость важнее красоты):
// - переменной нет в списке ограничений — она доходит всюду, как раньше;
// - переменная ограничена — доходит только до названных capability/групп и до
//   помеченного `*`;
// - список ограничений есть, но после чистки пуст (опечатка, чужое имя) —
//   переменная не выдаётся НИКОМУ. Так опечатка сужает выдачу, а не расширяет
//   её: молча отдать секрет всем командам — худший из возможных исходов.
const SCOPE_ALL = "*";

// Группа capability: `git.push` → `git`, `terminal.execute` → `terminal`.
// Односегментные capability (`unknown`) группы не имеют.
function capabilityGroup(cap) {
  const c = String(cap || "").trim().toLowerCase();
  const dot = c.indexOf(".");
  return dot > 0 ? c.slice(0, dot) : c;
}

// Допустимые имена ограничений: capability, их группы и «все» (*).
const _scopeNames = new Set([SCOPE_ALL]);
for (const cap of _byCap.keys()) {
  _scopeNames.add(cap);
  const g = capabilityGroup(cap);
  if (g.indexOf(".") === -1 && g) _scopeNames.add(g);
}

// Группы для интерфейса собираются из самой таблицы прав: отдельного списка
// нет — UI и политика не могут разойтись. Инструменты считаются по capability.
function scopeGroups() {
  const byGroup = new Map();
  for (const cap of _byCap.keys()) {
    const g = capabilityGroup(cap);
    if (!g || g === cap) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(cap);
  }
  return Array.from(byGroup.entries())
    .map(([group, caps]) => ({
      group,
      caps: caps.slice().sort(),
      tools: caps.reduce((n, c) => n + toolsForCapability(c).length, 0),
    }))
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

// Приводит пользовательский список ограничений к предсказуемому виду.
// Ключ в результате ЕСТЬ всегда, если он был во входе: «нет записи» и «запись
// без допустимых имён» — разные состояния (см. правило про опечатку выше).
function normalizeScopes(scopes) {
  const out = {};
  if (!scopes || typeof scopes !== "object") return out;
  for (const key of Object.keys(scopes)) {
    const name = String(key || "").trim();
    if (!name) continue;
    const raw = Array.isArray(scopes[key]) ? scopes[key] : scopes[key] == null ? [] : [scopes[key]];
    const list = [];
    for (const s of raw) {
      const v = String(s || "").trim().toLowerCase();
      if (!v || !_scopeNames.has(v) || list.indexOf(v) !== -1) continue;
      list.push(v);
    }
    out[name] = list;
  }
  return out;
}

// Дойдёт ли ограничение scope до названного назначения.
// Назначение пустое или незнакомое (действие не от инструмента, новый
// инструмент без политики) — ограниченная переменная не выдаётся.
function scopeAllows(scope, capability) {
  const s = String(scope || "").trim().toLowerCase();
  if (!s) return false;
  if (s === SCOPE_ALL) return true;
  const cap = String(capability || "").trim().toLowerCase();
  if (!cap || cap === "unknown") return false;
  return s === cap || s === capabilityGroup(cap);
}

// Подмножество переменных, которое можно отдать названному назначению.
function envForCapability(values, scopes, capability) {
  const out = {};
  const vals = values && typeof values === "object" ? values : {};
  const sc = normalizeScopes(scopes);
  for (const k of Object.keys(vals)) {
    if (!(k in sc)) {
      out[k] = vals[k]; // ограничения нет — как раньше, доходит всюду
      continue;
    }
    const list = sc[k];
    if (list.indexOf(SCOPE_ALL) !== -1 || list.some((s) => scopeAllows(s, capability))) out[k] = vals[k];
  }
  return out;
}

// Объяснение выдачи для интерфейса и инструмента envList: кто получит значение.
function scopeSummary(scopes, name) {
  const sc = normalizeScopes(scopes);
  if (!(name in sc)) return "всем командам";
  const list = sc[name];
  if (!list.length) return "ни одному инструменту";
  if (list.indexOf(SCOPE_ALL) !== -1) return "всем командам";
  return list.join(", ");
}

module.exports = {
  RISK,
  RISK_WEIGHT,
  CAPABILITIES,
  SCOPE_ALL,
  scopeGroups,
  normalizeScopes,
  scopeAllows,
  envForCapability,
  scopeSummary,
  capabilityGroup,
  CONFIRM_TOOLS,
  DANGEROUS_CMD_RE,
  ENV_DUMP_RE,
  policy,
  capabilityOf,
  riskOf,
  riskWeight,
  needsConfirm,
  isDangerousCommand,
  commandDumpsEnv,
  describe,
  looksSecretKey,
  scrub,
  redact,
  allCapabilities: () => Array.from(_byCap.keys()),
  toolsForCapability,
};

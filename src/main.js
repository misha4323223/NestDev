"use strict";

// Держатели темпа для провайдеров: лимит считается на ключ, но привязка к
// провайдеру+модели даёт то же поведение и не хранит секрет в ключе карты.
const rateLimiters = new Map(); // rateLimiterFor: один лимитер на провайдера
function rateLimiterFor(settings) {
  const s = settings || {};
  const key = String(s.provider || "openai") + "|" + String(s.model || "");
  if (!rateLimiters.has(key)) rateLimiters.set(key, createRateLimiter());
  return rateLimiters.get(key);
}

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, desktopCapturer } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { execFile, spawn } = require("child_process");
const {
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  rolePlan,
  createThinkingStripper,
  extractToolCallsFromText,
  normalizeToolName,
  buildChatRequest,
  consumeProviderStream,
  listModels,
  readApiError,
  friendlyRateLimitError,
  rateLimitInfo,
  createRateLimiter,
  genCallId,
  contextBudget,
  windowBudget,
  trimConversation,
  sanitizeToolPairs,
  truncateText,
  webSearchDDG,
  webSearch,
  classifyKeyError,
  webFetchPage,
  // вспомогательная модель: зрение + генерация изображений
  auxConfig,
  fmtError,
  describeImageRemote,
  generateImageRemote,
  routeTools,
  routerTaskText,
  coldCacheInfo,
  UNAVAILABLE_MAX,
  searchTools,
  ROUTER_MAX_TOKENS,
  routerMaxTokens,
  groupOfTool,
  PLAN_MODE_TOOL_DEFINITIONS,
  modelWindow,
  ollamaModelInfo,
  ollamaNumCtx,
  probeLocalModel,
  isLocalEndpoint,
  toolsAsText,
  // инструменты ОС (парсеры, whitelist)
  parseProcessesCsv,
  registryPathAllowed,
  parseSysInfoJson,
  createContextManager,
  estimateTokens,
  normalizePlanTasks,
  planSummary,
} = require("./renderer/agent-core.js");

// ─────────────────────────── Мобильный мост (LAN + PWA + PIN) ───────────────────────────
// Мост отдаёт интерфейс и дублирует IPC по WebSocket для телефона/планшета в той же сети.
// Прокси ipcMain.handle: каждый зарегистрированный обработчик сохраняется в карту —
// мобильный мост вызывает те же функции, что и окно приложения (никакого дублирования логики).
const MobileBridge = require("./mobile-bridge.js");
const browserTools = require("./browser-tools.js"); // браузерные инструменты агента (Playwright)
const appUi = require("./app-ui-tools.js"); // инструменты управления собственным окном приложения (app-*)
const secrets = require("./secrets.js"); // секреты: ключи, токены, PIN, agentEnv (safeStorage)
const agentStore = require("./agent-store.js"); // память проекта (заметки) и точки отката (чекпоинты)
const missionStore = require("./mission-store.js"); // миссии: цель, план, журнал и отчёт файлами в .agent/
const missionGuard = require("./mission-guard.js"); // сторож миссий: кого продолжать и когда перестать приставать
const { createRunMission } = require("./run-mission.js"); // миссия прогона: батчи, журнал, цикл, призывы (своим модулем)
const { createRunTools } = require("./run-tools.js"); // роутер инструментов и справочники прогона: группы, предохранители, вес схем, гайды
const { createRunRetry } = require("./run-retry.js"); // восстановление прогона после отказа запроса: лимиты, сбои пула, переполнение контекста
const { createRunRound } = require("./run-round.js"); // один раунд прогона: сборка запроса, поток ответа, метрики
const { createRunCalls } = require("./run-calls.js"); // вызовы раунда: текстовые, нормализация, история, пачка read-only
const unifiedPatch = require("./unified-patch.js"); // применение unified diff (applyPatch)
const codeIndex = require("./code-index.js"); // семантический индекс кода (BM25 + стемминг)
const yandexCloud = require("./yandex-cloud.js"); // Yandex Cloud REST API: авторизация, дашборд, создание ресурсов
const ycConsole = require("./yc-console.js"); // Консоль YC: карточка ресурса и связанные объекты (своим модулем)
const vault = require("./vault.js"); // пароли сайтов: поиск записи, безопасный текст, подстановка в форму
const mail = require("./mail.js"); // почта агента: SMTP (отправка КП) + IMAP (коды подтверждения), на встроенных модулях
const ycCli = require("./yc-cli.js"); // официальный yc CLI внутрь папки приложения: загрузка + PATH (без системных прав)
const ycCosts = require("./yc-costs.js"); // стоимость облака: проверенные тарифы и оценка ДО создания
const ycLogs = require("./yc-logs.js"); // логи Cloud Logging внутренним API (REST + gRPC) — внешний yc CLI не нужен
const winPs = require("./win-ps.js"); // живая сессия PowerShell: системные справки без холодного старта
const toolPolicy = require("./tool-policy.js"); // политика инструментов: capability/риск/подтверждение (одна точка правды)
const { createAgentTools } = require("./agent-tools.js"); // агентские инструменты: 154 обработчиков своим модулем

const audit = require("./audit-log.js");
const deployRecipes = require("./deploy-recipes.js"); // рецепты сборки: тип проекта → Dockerfile, порт, путь проверки
const cloudState = require("./cloud-state.js"); // состояние облака проекта: .cloud/project.json, infrastructure.json, deployments.json
const { createDeployEngine } = require("./deploy-engine.js"); // конвейер деплоя: стадии, проверка после выката, откат // журнал действий агента (JSONL, без секретов)
secrets.init(path.join(app.getPath("userData"), "secrets.json"));
audit.init(path.join(app.getPath("userData"), "audit.log")); // журнал действий: подключается к userData
const _ipcHandleOrig = ipcMain.handle.bind(ipcMain);
const ipcHandlerMap = new Map();
ipcMain.handle = (channel, fn) => {
  ipcHandlerMap.set(channel, fn);
  return _ipcHandleOrig(channel, fn);
};
const mobileBridge = new MobileBridge({ handlerMap: ipcHandlerMap });

// Кто запустил текущий прогон агента: "desktop" (окно на ПК), "mobile" (клиент
// мобильного моста — у него фиктивное событие IPC с sender.id = 0). Клиентов
// теперь несколько, и события чужого прогона нельзя подмешивать в свой чат.
let activeRunOrigin = "desktop";
// Роль и чат текущего прогона: у миссии есть хозяин (роль и чат), иначе её журнал
// некуда показать. Значения приходят из интерфейса вместе с сообщением.
let activeRunRole = "";
let activeRunChatId = "";
let runMissionId = ""; // миссия текущего прогона: по ней инструменты находят «свою» миссию
let missionClaim = ""; // id миссии, которую человек вернул в работу кнопкой «▶ Продолжить»
const ota = require("./ota.js"); // локальный self-update (OTA)
const selfDev = require("./self-dev.js"); // защита критичной инфраструктуры самообновления

// ─────────────────────────── Настройки ───────────────────────────
// ── Настройки, подключения и история чатов — код в src/settings-store.js ──
// Модуль собран на прежнем месте куска, и имена те же: вызовы ниже (loadSettings,
// saveSettings, loadChats…) дословно прежние — берём их деструктуризацией.
// Применение настроек к живым подсистемам (окружение агента, профиль браузера,
// журнал) остаётся здесь и передано значениями: это объявления функций, подъём работает.
const { createSettingsStore } = require("./settings-store.js");
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  loadSettings,
  saveSettings,
  loadChats,
  saveChats,
  openaiProfilesList,
  switchOpenaiProfile,
} = createSettingsStore({
  fs,
  path,
  os,
  app,
  secrets,
  audit,
  toolPolicy,
  vault,
  applyAgentEnv,
  applyBrowserSettings,
});

// Переменные окружения агента (envSet/envList/envUnset). Значения хранятся в settings.json
// (settings.agentEnv) и подмешиваются во все команды: runCommand, фоновые процессы, shell, git, docker.
let agentEnv = {}; // итоговый набор: пользовательский + автоматический (Yandex Cloud)
let userAgentEnv = {}; // только то, что задал пользователь — это и сохраняется в настройках
// Кому какая переменная выдана: { ИМЯ: ["terminal", "git"] } (settings.agentEnvScopes).
// Пусто для переменной — как раньше: доходит до всех команд агента. Заполнено —
// только до названных инструментов и групп (см. tool-policy.js).
let agentEnvScopes = {};
// Инструмент, который выполняется СЕЙЧАС (его capability). Команды внутри одного
// вызова получают выданное этому инструменту; действие без инструмента (кнопка
// «Запустить», авто-коммит, сборка бандла) назначения не имеет и объявляет его само.
let activeToolCapability = "";
function activeCapability() {
  return activeToolCapability;
}

// Выполнить операцию под названным назначением. Нужно действиям НЕ от инструмента:
// кнопка «Загрузить» в панели git, «Опубликовать на GitHub». Внутри вложенных вызовов
// это назначение видят все помощники — runGit, commandEnv, spawnRaw.
async function withCapability(capability, fn) {
  const prev = activeToolCapability;
  activeToolCapability = capability;
  try {
    return await fn();
  } finally {
    activeToolCapability = prev;
  }
}

// Автоматические переменные Yandex Cloud для команд агента. yc CLI читает их прямо
// из окружения, поэтому подключённый аккаунт работает без интерактивного `yc init`.
// ВАЖНО: YC_TOKEN и YC_IAM_TOKEN должны содержать IAM-токен — OAuth там не
// принимается (yc отвечает «The token is invalid»). IAM живёт ~1 час, поэтому
// держим свежий снимок (ycIamEnv) и продлеваем его в фоне до истечения.
// В чат значения не выводятся: envList показывает только имя и длину.
let ycIamEnv = null; // { token, expiresAtMs, forOauth }
let ycIamTimer = null;
let ycIamTimerAt = 0;
let ycIamLastTryTs = 0;
let lastAgentEnvSettings = null;
const YC_IAM_REFRESH_MARGIN = 5 * 60 * 1000;

function ycIamEnvToken(cfg) {
  if (!ycIamEnv || !cfg || !cfg.oauth || ycIamEnv.forOauth !== cfg.oauth) return "";
  if (Date.now() >= ycIamEnv.expiresAtMs - 60 * 1000) return "";
  return ycIamEnv.token;
}

function ycAutoEnv(s) {
  const out = {};
  try {
    const cfg = ycConfig(s);
    if (cfg.cloudId) out.YC_CLOUD_ID = cfg.cloudId;
    if (cfg.folderId) out.YC_FOLDER_ID = cfg.folderId;
    const iam = ycIamEnvToken(cfg);
    if (iam) {
      out.YC_IAM_TOKEN = iam;
      out.YC_TOKEN = iam;
    }
  } catch {}
  return out;
}

// Пересобрать окружение без сети (зовётся и по таймеру продления токена).
function rebuildAgentEnv() {
  agentEnv = { ...userAgentEnv, ...ycAutoEnv(lastAgentEnvSettings) };
  // Значения переменных агента не должны попадать в журнал действий — даже если
  // команда честно их напечатала (printenv MY_KEY): журнал вырезает эти значения
  // по подстроке из любой своей строки.
  audit.setSecrets(Object.values(agentEnv));
}

// Ключи окружения, которые можно отдавать даже «слепым» процессам: это пути,
// а не секреты. Всё остальное (ключи, пароли, токены) — только по назначению.
function pathOnlyEnv() {
  const safe = {};
  for (const k of Object.keys(agentEnv)) {
    if (/^(path|pathext|comspec|systemroot|temp|tmp)$/i.test(k)) safe[k] = agentEnv[k];
  }
  return safe;
}

// Окружение для названного назначения: инструмент получает ТОЛЬКО те переменные
// агента, которые ему выданы (или все неограниченные — как раньше). Назначения:
// capability инструмента в работе, а для действий без инструмента — явное имя
// (кнопка «Запустить» → terminal.execute, авто-коммит → git.commit).
function envFor(capability) {
  const cap = capability || activeToolCapability;
  return { ...process.env, ...toolPolicy.envForCapability(agentEnv, agentEnvScopes, cap) };
}

// Окружение для команды, которую СОЧИНИЛ агент (runCommand, фоновые процессы, shell).
// Обычные команды (npm, docker, yc, git) получают выданные переменные агента, но
// команда, которая просто печатает всё окружение (env, printenv, set, Get-ChildItem Env:),
// секретов не получает — иначе модель одной строкой выводит пароли пользователя в чат.
function commandEnv(command, capability) {
  const base = { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" };
  if (toolPolicy.commandDumpsEnv(command)) return { ...base, ...pathOnlyEnv() };
  // Инструмент в работе важнее: команда внутри cloud-инструмента получает выданное
  // облаку, а не терминалу. «terminal.execute» объявляется только тогда, когда
  // инструмента нет вовсе (терминал пользователя, кнопка запуска превью).
  return { ...base, ...envFor(capability || activeToolCapability || "terminal.execute") };
}

// Служебные пробы (поиск программы в PATH, проверка версии) секретов не требуют.
function probeEnv() {
  return { ...process.env, ...pathOnlyEnv() };
}

// Фоновая синхронизация IAM-токена: обмен OAuth→IAM и продление за 5 минут до
// истечения. Не бросает и не ждёт: команды агента никогда не стоят из-за токена.
// Повторы ограничены (не чаще раза в минуту), иначе каждая команда дёргала бы IAM.
function ycIamSync(s) {
  try {
    const cfg = ycConfig(s);
    if (!cfg.oauth) {
      if (ycIamTimer) { clearTimeout(ycIamTimer); ycIamTimer = null; ycIamTimerAt = 0; }
      if (ycIamEnv) { ycIamEnv = null; rebuildAgentEnv(); }
      return;
    }
    if (ycIamEnv && ycIamEnv.forOauth === cfg.oauth && Date.now() < ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN) {
      const at = ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN;
      if (ycIamTimerAt !== at) {
        if (ycIamTimer) clearTimeout(ycIamTimer);
        ycIamTimerAt = at;
        ycIamTimer = setTimeout(() => {
          ycIamTimer = null;
          ycIamTimerAt = 0;
          ycIamSync(lastAgentEnvSettings);
        }, Math.max(30 * 1000, at - Date.now()));
        if (ycIamTimer.unref) ycIamTimer.unref();
      }
      return;
    }
    if (ycIamEnv && ycIamEnv.forOauth !== cfg.oauth) { ycIamEnv = null; rebuildAgentEnv(); }
    if (Date.now() - ycIamLastTryTs < 60 * 1000) return;
    ycIamLastTryTs = Date.now();
    yandexCloud
      .getIamTokenInfo(cfg.oauth)
      .then((info) => {
        ycIamEnv = { token: info.token, expiresAtMs: info.expiresAtMs || Date.now() + 3600 * 1000, forOauth: cfg.oauth };
        rebuildAgentEnv();
        ycIamSync(lastAgentEnvSettings);
      })
      .catch(() => {
        /* нет сети или токен не принят — команды отработают без YC_*, без падения */
      });
  } catch {}
}

// Папка со встроенным yc CLI — в PATH всех команд агента (как node).
function ycEnsurePath() {
  try {
    const dir = ycCli.binDir(app.getPath("userData"));
    if (!dir) return;
    const before = envPathInfo().value;
    if (!String(before || "").split(path.delimiter).map((x) => x.trim()).includes(dir)) setMergedPath(before, dir);
  } catch {}
}

// Пересобрать окружение агента: пользовательские переменные + автоматические YC.
function applyAgentEnv(s) {
  userAgentEnv = (s && typeof s.agentEnv === "object" && s.agentEnv) || {};
  agentEnvScopes = toolPolicy.normalizeScopes(s && s.agentEnvScopes);
  lastAgentEnvSettings = s || lastAgentEnvSettings;
  rebuildAgentEnv();
  ycEnsurePath();
  // Фоновая подстановка свежего IAM в YC_IAM_TOKEN/YC_TOKEN (без await).
  ycIamSync(lastAgentEnvSettings);
}

// ── Пути и git — код в src/paths-git.js ──
// Модуль собран на прежнем месте куска, и имена те же: вызовы в оболочке и проводка
// в другие модули (runGit, agentWorkDir, sanitizeDir…) остались дословно прежними.
// Живые значения (папка последнего клона, окружение прогона, назначение инструмента) — мостом live.
const { createPathsGit } = require("./paths-git.js");
const {
  resolvePath,
  runGit,
  gitDirOrHome,
  agentWorkDir,
  repoNameFromUrl,
  stripUrlCreds,
  sanitizeDir,
  sanitizePath,
} = createPathsGit({
  fs,
  path,
  os,
  execFile,
  envFor,
  live: {
    lastAgentRepoDir: () => lastAgentRepoDir,
    agentEnv: () => agentEnv,
    activeToolCapability: () => activeToolCapability,
  },
});


// Директория, в которой агент выполняет git и команды: если недавно клонировали репозиторий — там,
// иначе в рабочей директории (если она сама — репозиторий), иначе в рабочей папке.
let lastAgentRepoDir = null; // путь, куда агент последний раз клонировал репозиторий
let clonedRepoPending = false; // одноразовый флаг: после клона/смены репозитория следующий ответ агента начнётся с анализа проекта
let activeRunUndo = []; // undo-снимки файлов последнего запуска агента
let lastUndoLog = [];
let pendingAsk = null; // ожидание ответа пользователя (askUser)


// Что опасно, а что нет — решает политика инструментов (src/tool-policy.js):
// там же capability и риск каждого инструмента, оттуда их читает журнал действий.
// Здесь остались только имена для совместимости с прежним кодом.
const DANGEROUS_CMD_RE = toolPolicy.DANGEROUS_CMD_RE; // опасные команды оболочки
const DANGEROUS_TOOLS = toolPolicy.CONFIRM_TOOLS; // инструменты, требующие подтверждения

// Батчинг (правило 35): инструменты, которые безопасно выполнять ПАРАЛЛЕЛЬНО —
// только чтение без побочных эффектов и без диалогов с пользователем. Если в одном
// раунде модель прислала несколько таких вызовов, они идут одновременно.
const PARALLEL_SAFE_TOOLS = new Set([
  "readFile", "readFileLines", "listFiles", "listDirectory", "searchFile", "searchProject",
  "fileOutline", "readFileStructure", "semanticSearch", "findReferences", "explainCode",
  "getDependencies", "gitStatus", "gitLog", "gitDiff", "gitBranch", "gitBlame",
  "listProcesses", "getSystemInfo", "listPorts", "checkPort", "checkUrl",
  "checkInstalledProgram", "canExecute", "shellsStatus", "envList",
  "webSearch", "webFetch", "apiRequest", "memoryList", "memorySearch",
  "noteRead", "noteList", "checkpointList", "agentGuide", "vaultList",
]);

// Короткое описание аргументов для подтверждения опасного действия.
// Тексты живут в политике (tool-policy.js) — здесь только обёртка.
function describeToolArgs(name, a) {
  return toolPolicy.describe(name, a);
}

// Чистит ANSI-escape-последовательности (цвета npm-сборок и т.п.) из вывода терминала.
function stripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

// Кодировка консоли Windows: cmd по умолчанию отдаёт CP866, и кириллица в выводе
// команд превращается в кашу («set | findstr», git, сборки). Переключаем страницу
// кода на UTF-8 прямо в команде. На других ОС аргументы как были.
function shellArgsFor(command) {
  if (process.platform === "win32") return ["/d", "/s", "/c", "chcp 65001>nul & " + command];
  return ["-c", command];
}

// Оболочка для runCommand/startBackground: cmd (по умолчанию на Windows),
// powershell/pwsh, bash, sh. Псевдонимы принимаются и по-русски.
const SHELL_KINDS = {
  cmd: "cmd", "командная строка": "cmd", консоль: "cmd", dos: "cmd",
  powershell: "powershell", ps: "powershell", ps1: "powershell", "пс": "powershell",
  pwsh: "pwsh", powershell7: "pwsh", ps7: "pwsh",
  bash: "bash", gitbash: "bash", "git-bash": "bash", "баш": "bash",
  sh: "sh", zsh: "sh", dash: "sh",
};

function normalizeShell(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  if (!key) return "";
  return SHELL_KINDS[key] || "";
}

// PowerShell: включаем UTF-8 на выходе (иначе кириллица в pipe превращается в
// кашу, как в cmd с CP866) и запрещаем прогресс-бар, который ломает парсинг.
// Команда передаётся через -EncodedCommand (UTF-16LE base64): это снимает ВСЕ
// проблемы с кавычками, $ и 2>$null, из-за которых раньше приходилось писать
// .ps1-файлы на каждое действие.
const PS_PRELUDE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$ProgressPreference='SilentlyContinue'; ";

function powershellArgs(command) {
  const script = PS_PRELUDE + String(command || "");
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc];
}

// bash/sh из Git for Windows (там же, где git) — чтобы shell: "bash"/"sh" работали
// без PATH. Возвращает абсолютный путь или "" (не найдено нигде).
function findGitShell(which) {
  const name = which === "sh" ? "sh" : "bash";
  if (process.platform !== "win32") {
    const inPath = findProgram(name).path;
    if (inPath) return inPath;
    const direct = name === "sh" ? "/bin/sh" : "/bin/bash";
    try { if (fs.existsSync(direct)) return direct; } catch {}
    return "";
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const home = process.env.USERPROFILE || "";
  const roots = [
    path.join(pf, "Git"),
    path.join(pf86, "Git"),
    home ? path.join(home, "AppData", "Local", "Programs", "Git") : "",
  ].filter(Boolean);
  // Порядок как у самого Git: сначала bin, затем usr/bin (там же лежит sh).
  const subs = name === "sh"
    ? [["usr", "bin", "sh.exe"], ["bin", "sh.exe"]]
    : [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]];
  for (const root of roots) {
    for (const sub of subs) {
      const cand = path.join(root, ...sub);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return findProgram(name).path || "";
}

// Человеческое объяснение, почему оболочки нет (попадает в ответ инструмента).
function shellMissingHint(which) {
  if (process.platform === "win32") {
    return (
      which + " не найден. Поставь Git for Windows (installSystemPackage(\"git\")) — " + which +
      " идёт вместе с ним; либо используй shell: \"powershell\" или \"cmd\"."
    );
  }
  return which + " не найден: ни в PATH, ни в /bin. Проверь установку (installSystemPackage).";
}

// Единая точка выбора оболочки → { kind, shell, args, shellHint }.
// shellHint — человеческое объяснение, если оболочки нет в системе.
function resolveShell(command, shellName) {
  const kind = normalizeShell(shellName) || (process.platform === "win32" ? "cmd" : "sh");
  if (kind === "cmd") {
    return { kind, shell: process.env.ComSpec || "cmd.exe", args: shellArgsFor(command), shellHint: "", missing: false };
  }
  if (kind === "powershell" || kind === "pwsh") {
    const probe = findProgram(kind === "pwsh" ? "pwsh" : "powershell");
    return {
      kind,
      shell: probe.found ? probe.path : kind === "pwsh" ? "pwsh" : "powershell",
      args: powershellArgs(command),
      shellHint: probe.found
        ? ""
        : "PowerShell не найден в PATH. Варианты: installSystemPackage(\"pwsh\") для PowerShell 7 или shell: \"cmd\".",
      // missing намеренно false: Windows ищет powershell.exe в System32 независимо
      // от PATH, и жёсткая блокировка дала бы ложный отказ на рабочей машине.
      missing: false,
    };
  }
  if (kind === "bash" || kind === "sh") {
    // На Windows sh живёт там же, где bash (Git for Windows). Раньше sh молча
    // уходил в /bin/sh, которого на Windows нет: агент получал ENOENT вообще
    // без объяснения. Теперь и sh ищется как Git-оболочка и получает подсказку.
    const found = findGitShell(kind);
    return {
      kind,
      shell: found || kind,
      args: kind === "sh" ? ["-c", command] : ["-lc", command],
      shellHint: found ? "" : shellMissingHint(kind),
      missing: !found,
    };
  }
  return { kind: "sh", shell: "/bin/sh", args: ["-c", command], shellHint: "", missing: false };
}

// Какие оболочки реально есть на этой машине: агент спрашивает один раз
// (инструмент shellsStatus), а не выясняет методом тыка.
function shellsStatus() {
  const win = process.platform === "win32";
  const defKind = win ? "cmd" : "sh";
  const defPath = win ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  let defOk = true;
  if (!win) {
    try { defOk = fs.existsSync("/bin/sh"); } catch { defOk = false; }
  }
  const list = [{ kind: defKind, available: defOk, path: defPath, def: true, hint: defOk ? "" : shellMissingHint("sh") }];
  const seen = { [defKind]: true };
  for (const k of ["powershell", "pwsh"]) {
    const p = findProgram(k);
    if (seen[k]) continue;
    seen[k] = true;
    list.push({ kind: k, available: !!p.found, path: p.path || "", def: false, hint: p.found ? "" : "Установи PowerShell 7: installSystemPackage(\"pwsh\")." });
  }
  for (const k of ["bash", "sh"]) {
    if (seen[k]) continue;
    seen[k] = true;
    const f = findGitShell(k);
    list.push({ kind: k, available: !!f, path: f || "", def: false, hint: f ? "" : shellMissingHint(k) });
  }
  return list;
}

// Строка про Yandex Cloud для САММАРИ ПРОЕКТА: агент всегда видит АКТУАЛЬНЫЙ
// каталог и разрешения, а не полагается на устаревшие результаты инструментов
// в истории переписки («каталог не выбран», хотя он уже выбран).
function ycBriefLine(s) {
  try {
    const cfg = ycConfig(s);
    if (!cfg.oauth) return "";
    if (!cfg.folderId) return "Yandex Cloud: подключён, каталог НЕ выбран — попроси пользователя выбрать каталог в Настройках → «☁️ Yandex Cloud».";
    return (
      "Yandex Cloud: каталог «" + (cfg.folderName || cfg.folderId) + "» (" + cfg.folderId + ")" +
      (cfg.cloudId ? ", облако " + cfg.cloudId : "") +
      "; создание ресурсов агентом " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО") +
      ", удаление " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО") + ". "
    );
  } catch {
    return "";
  }
}

// Короткая строка для САММАРИ ПРОЕКТА: что доступно, чтобы агент не гадал.
function shellsBrief() {
  const win = process.platform === "win32";
  const names = [win ? "cmd" : "sh"];
  for (const k of ["powershell", "pwsh"]) if (findProgram(k).found) names.push(k);
  for (const k of ["bash", "sh"]) if (findGitShell(k)) names.push(k);
  const uniq = names.filter((n, i) => names.indexOf(n) === i);
  return "по умолчанию " + (win ? "cmd" : "sh") + "; доступно: " + uniq.join(", ") + " (параметр shell у runCommand/startBackground)";
}

// Запуск произвольной команды в терминале (без интерактива).
// Возвращает текст с кодом завершения и временем выполнения.
function runTerminalCommand(command, cwd, timeoutMs, shellName) {
  return new Promise((resolve) => {
    const sh = resolveShell(command, shellName);
    const shell = sh.shell;
    const args = sh.args;
    const start = Date.now();
    execFile(shell, args, {
      cwd,
      timeout: timeoutMs || 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: commandEnv(command),
    }, (err, stdout, stderr) => {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      const timeNote = " (" + secs + " с)";
      const out = stripAnsi(stdout || "").trim();
      const errText = stripAnsi(stderr || "").trim();
      if (!err) {
        if (out && errText) resolve(out + "\n\n[stderr]\n" + errText + timeNote);
        else resolve((out || errText || "Готово (без вывода).") + timeNote);
      } else {
        const code = err.killed ? "таймаут" : err.code == null ? 1 : err.code;
        const parts = [];
        if (out) parts.push(out);
        if (errText) parts.push(errText);
        // Ошибки запуска (ENOENT/EACCES/EINVAL) не пишут в stderr — без этого
        // агент видел пустой вывод и не мог понять причину.
        if (!errText && err.message) parts.push(String(err.message));
        if (!parts.length) parts.push(err.message || String(err));
        const shHint = (err.code === "ENOENT" || sh.missing === true) && sh.shellHint ? "\n\n" + sh.shellHint : "";
        resolve("Команда завершилась с кодом " + code + timeNote + ":\n" + parts.join("\n").slice(0, 6000) + shHint);
      }
    });
  });
}

// ── Помощники инструментов — код в src/tool-helpers.js ──
// Имена те же: вызовы в инструментах и каналах остались дословно прежними.
const { createToolHelpers } = require("./tool-helpers.js");
const { detectPackageManager, hasLock, summarizeTestOutput, unifiedDiff } = createToolHelpers({
  fs,
  path,
  execFile,
  envFor,
  stripAnsi,
  agentWorkDir,
  loadSettings,
});


// ── Анализ проекта: структура, переименование, ссылки — код в src/project-analysis.js ──
const { createProjectAnalysis } = require("./project-analysis.js");
const { projectSourceFiles, buildFileStructure, refactorRenameFiles, findSymbolReferences, argsPathIsFile, escRe } = createProjectAnalysis({ fs, path });


// Запуск команды со сбором вывода, пока не появится waitFor / процесс не завершится / не выйдет таймаут.
function spawnCollect(command, cwd, timeoutMs, waitFor) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = shellArgsFor(command);
    let out = "";
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      payload.out = out;
      resolve(payload);
    };
    const timer = setTimeout(() => {
      // Убиваем ДЕРЕВО (taskkill /T /F), а не только оболочку — иначе node/expo-сирота держит порт.
      killProcessTree(child);
      finish({ ok: false, timedOut: true, matched: false, code: "timeout" });
    }, timeoutMs || 120000);
    const child = spawn(shell, args, {
      cwd,
      detached: !(process.platform === "win32"),
      windowsHide: true,
      env: commandEnv(command),
    });
    const onData = (d) => {
      out += stripAnsi((d || "").toString());
      if (waitFor && out.includes(waitFor)) finish({ ok: true, matched: true, code: 0 });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => finish({ ok: false, timedOut: false, matched: false, code: e && e.code }));
    child.on("close", (code) => finish({ ok: code === 0, timedOut: false, matched: false, code }));
  });
}

// Скриншот страницы: невидимое окно, ждём загрузку и отрисовку, снимаем capturePage.
function screenshotUrl(url) {
  return new Promise((resolve) => {
    let win = null;
    let timer = null;
    const done = (payload) => {
      if (timer) clearTimeout(timer);
      if (win && !win.isDestroyed()) { win.destroy(); win = null; }
      resolve(payload);
    };
    const fail = (msg) => done({ ok: false, err: msg });
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
    } catch (e) {
      return fail(e.message);
    }
    timer = setTimeout(() => fail("таймаут загрузки " + url + " (30 с)"), 30000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const shot = encodeShot(img, {});
          done({ ok: true, dataUrl: "data:" + shot.mime + ";base64," + shot.buf.toString("base64"), mime: shot.mime });
        } catch (e) {
          fail(e.message);
        }
      }, 2500);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => fail(code + " " + String(desc || "").slice(0, 300)));
    win.loadURL(url).catch((e) => fail(e.message));
  });
}

// Сохранение скриншота на диск: скриншоты хранятся в userData/screenshots, чтобы
// агент мог проанализировать их vision-моделью через analyzeImage(path).
// Кодирование скриншота: JPEG по умолчанию (быстро, компактно, вдвое дешевле для
// vision-модели), PNG — по флагу png:true (точные задачи, чтение мелкого текста).
// Длинная сторона при необходимости ужимается до MAX_SHOT_SIDE.
const MAX_SHOT_SIDE = 1440;
function encodeShot(img, args) {
  const a = args || {};
  const wantPng = a.png === true || a.format === "png";
  let out = img;
  try {
    const sz = img.getSize();
    const longest = Math.max(sz.width || 0, sz.height || 0);
    const cap = Math.min(Math.max(parseInt(a.maxWidth, 10) || MAX_SHOT_SIDE, 480), 2560);
    if (longest > cap) {
      const k = cap / longest;
      out = img.resize({ width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k)), quality: "good" });
    }
  } catch {}
  if (!wantPng) {
    try {
      const q = Math.min(Math.max(parseInt(a.quality, 10) || 72, 30), 100);
      const jpg = out.toJPEG(q);
      if (jpg && jpg.length) return { buf: jpg, mime: "image/jpeg", ext: ".jpg" };
    } catch {}
  }
  const png = out.toPNG();
  return { buf: png, mime: "image/png", ext: ".png" };
}

// Сохранить скриншот на диск (расширение — по типу картинки). Агент читает его
// через analyzeImage(path).
function saveScreenshotPng(buf, baseName, mime) {
  const dir = path.join(app.getPath("userData"), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const ext = String(mime || "").indexOf("jpeg") !== -1 ? ".jpg" : ".png";
  const file = path.join(dir, String(baseName || "shot").replace(/[^\w.-]+/g, "_") + "-" + Date.now() + ext);
  fs.writeFileSync(file, buf);
  return file;
}

// ── Фоновые процессы, оболочки и dev-серверы — код в src/bg-processes.js ──
// Имена те же, поэтому вызовы в инструментах, каналах и панели проекта не менялись.
// Сборка стоит на прежнем месте куска: все зависимости (запуск команды, окружение,
// оболочка и очистка вывода) объявлены ВЫШЕ — стрелок в проводке не появилось.
const { createBgProcesses } = require("./bg-processes.js");
const {
  bgProcesses,
  bgSpawn,
  bgKill,
  killProcessTree,
  bgWaitFor,
  parsePortFromUrl,
  killProcessesOnPort,
  waitOutputQuiet,
  bgTail,
  checkUrlStatus,
  SERVER_CMD_RE,
} = createBgProcesses({ spawn, os, stripAnsi, shellArgsFor, commandEnv, runTerminalCommand });


// ── Поиск по всему проекту (grep) и обзор структуры ──
// Веб-поиск и чтение страниц (webSearchDDG / webFetchPage) — в renderer/web-tools.js.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".output",
  ".venv", "venv", "env", "__pycache__", ".idea", ".vscode", ".dart_tool", ".flutter-plugins",
  ".gradle", "target", "vendor", "bower_components", "Pods", ".cache", ".parcel-cache", "lib-cov",
]);
const MAX_FILE_SCAN = 2 * 1024 * 1024; // файлы больше 2 МБ не сканируем поиском

// ── Поиск по проекту — код в src/project-search.js ──
// Имена те же: вызовы в инструментах и в каналах остались дословно прежними.
// BINARY_EXT создаётся позже (его отдаёт регистрация файловых каналов), поэтому
// передаём живой обёрткой, а не копией — иначе список расширений был бы пустым.
const { createProjectSearch } = require("./project-search.js");
const { walkProject, listProjectFiles, searchProjectFiles } = createProjectSearch({
  fs,
  path,
  resolvePath,
  agentWorkDir,
  SKIP_DIRS,
  MAX_FILE_SCAN,
  BINARY_EXT: { has: (ext) => BINARY_EXT.has(ext) },
});


// ── Снимки отката и чекпоинт — код в src/undo-store.js ──
// Имена те же: вызовы в инструментах, каналах и панели проекта не менялись.
// Живые значения (снимки запуска и журнал отката) — мостом live со сеттерами: их
// пишет и разбор правок, и каналы отката, копия «застыла» бы на пустом массиве.
const { createUndoStore } = require("./undo-store.js");
const { snapshotFileForUndo, persistUndo, loadPersistedUndo, undoFile } = createUndoStore({
  fs,
  path,
  userDataDir: () => app.getPath("userData"),
  live: {
    activeRunUndo: () => activeRunUndo,
    setActiveRunUndo: (v) => {
      activeRunUndo = v;
    },
    lastUndoLog: () => lastUndoLog,
    setLastUndoLog: (v) => {
      lastUndoLog = v;
    },
  },
});


// ─────────────────────────── Выполнение инструментов ───────────────────────────
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
  // Двухуровневая структура (без node_modules/.git и прочего мусора)
  const tree = [];
  const walkBrief = (dir, depth) => {
    if (depth > 2 || tree.length >= 80) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (tree.length >= 80) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
      tree.push((e.isDirectory() ? "📁 " : "📄 ") + rel + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walkBrief(path.join(dir, e.name), depth + 1);
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

// ═══════════════════ Системные программы и окружение ═══════════════════
// Раздел вынесен в src/system-stack.js (1.5.78): PATH и поиск программ, живая
// сессия PowerShell с кэшем справок, системные менеджеры пакетов, загрузка
// файлов и архивов, запуск от администратора. Окружение агента (agentEnv)
// меняется по ходу работы, поэтому модуль читает его живым: копия «застыла» бы
// на пустом объекте, и команды остались бы без токенов и PATH.
const { createSystemStack } = require("./system-stack.js");
const systemStack = createSystemStack({
  fs,
  path,
  os,
  execFile,
  winPs,
  probeEnv,
  stripAnsi,
  runTerminalCommand,
  live: {
    get agentEnv() {
      return agentEnv;
    },
    // Системный раздел получает не «всё подряд», а выданное назначению:
    // установщики, архивы и админ-запуск работают под своим инструментом.
    envFor,
  },
});
const {
  envPathInfo,
  setMergedPath,
  findProgram,
  runProgVersion,
  spawnRaw,
  psScript,
  _sysCache,
  cachedPs,
  invalidatePsCache,
  refreshEnvFromOS,
  WINGET_IDS,
  EXIT_HINTS,
  explainExit,
  installSystemPkg,
  downloadFileTo,
  verifyInstaller,
  installerFacts,
  installerGate,
  findInstallersIn,
  downloadAndExtractTo,
  runAsAdmin,
} = systemStack;

// git add -A, но БЕЗ файлов секретов (env-файлы вида DOTENV*): агент
// (авто-чекпоинт, gitCommit, публикация) не должен закоммитить ключи в git.
async function stageAllSafe(dir, settings) {
  const r = await runGit(dir, ["add", "-A", "--", ".", ":(exclude,glob)**/" + ".env" + "*"], settings);
  if (!r.ok) return r;
  // Страховка: снимаем с индекса всё, что всё же проскочило (имя с DOTENV).
  try {
    const cached = await runGit(dir, ["diff", "--cached", "--name-only"], settings);
    if (cached.ok && cached.out) {
      const secret = cached.out.split("\n").map((l) => l.trim()).filter((l) => {
        const base = l.split("/").pop() || l;
        return /^\.env(\..*)?$/i.test(base) || /\.env$/i.test(base);
      });
      if (secret.length) await runGit(dir, ["restore", "--staged", "--", ...secret], settings);
    }
  } catch {}
  return r;
}

// ── Справочники по сайтам (agent-guides) — код в src/site-guides.js ──
// Имена те же: инструмент agentGuide и readFile("agent-guide:…") зовут их дословно.
// Папка приложения приходит функцией — она известна только после старта Electron.
const { createSiteGuides } = require("./site-guides.js");
const { guideSafeName, guideFilePath, guideIndex, guideForUrl, guideReadText, agentGuideCall } = createSiteGuides({
  fs,
  path,
  userDataDir: userDataDir,
  builtinDir: path.join(__dirname, "agent-guides"),
});

// Хранилище приложения (дела, заметки): вне рабочей папки, поэтому в git не попадает.
function userDataDir() {
  return app.getPath("userData");
}

// Дела изменились (агент, панель в окне или телефон) — обновляем панель везде.
function emitTasksChanged() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("tasks:changed", { ts: Date.now() });
  } catch {}
  // Зеркало в рабочей папке (.agent/tasks.md): человек видит список дел файлом
  // рядом с проектом, а не только в панели приложения.
  try {
    const s = loadSettings();
    if (s.agentWorkFiles === false) return;
    const brief = agentStore.tasksBrief(userDataDir(), 40);
    const board = agentStore.tasksBoard(userDataDir());
    const sum = (board && board.summary) || {};
    missionStore.tasksMirror(
      agentWorkDir(s),
      "# Дела (зеркало списка приложения, обновлено " + new Date().toLocaleString() + ")\n\n" +
        "Активных: " + (sum.active || 0) + ", просрочено: " + (sum.overdue || 0) + ", сегодня: " + (sum.today || 0) + ", выполнено: " + (sum.done || 0) + "\n\n" +
        (brief || "Список пуст.")
    );
  } catch {}
}

// Напоминания о делах: раз в минуту смотрим, не подошёл ли срок. Уведомление Windows
// (Notification) + тост в ленте чата. Дело помечается напомненным — пристаём один раз,
// повторно только после смены срока. Отключается галочкой в настройках.
// Уведомление пользователю — только если канал уведомлений действительно есть.
// В контейнерах и headless-сборках уведомление через libnotify завершает процесс
// (D-Bus недоступен), а это фон: он обязан выживать.
function canNotify() {
  try {
    if (!Notification || !Notification.isSupported()) return false;
    if (process.platform === "linux") {
      const bus = String(process.env.DBUS_SESSION_BUS_ADDRESS || "");
      return /^(unix:path=|unix:abstract=)/.test(bus);
    }
    return true;
  } catch {
    return false;
  }
}

function notifyUser(title, body) {
  if (!canNotify()) return false;
  try {
    new Notification({ title: String(title || ""), body: String(body || "") }).show();
    return true;
  } catch {
    return false;
  }
}

// Точный будильник: таймер ровно на ближайший срок. Опрос раз в минуту остаётся
// страховкой (сон, перевод часов, смена дел), но к сроку приложение приходит вовремя.
let taskWakeTimer = null;
function armTaskWake() {
  if (taskWakeTimer) { clearTimeout(taskWakeTimer); taskWakeTimer = null; }
  let ms = 0;
  try { ms = agentStore.tasksNextDue(userDataDir()); } catch { ms = 0; }
  if (!ms) return;
  const delay = Math.max(1000, Math.min(ms + 250, 6 * 60 * 60 * 1000));
  taskWakeTimer = setTimeout(() => { taskWakeTimer = null; checkTaskReminders(); }, delay);
}

function checkTaskReminders() {
  let due = [];
  let auto = [];
  let failed = [];
  let remindOn = true;
  let autoOn = true;
  // Доставить дело некому (окна нет — свёрнуто в трей, закрыто): дела НЕ «берём»,
  // иначе автозадача сгорела бы впустую. Возьмём их, когда окно вернётся.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const s = loadSettings();
    remindOn = s.taskReminders !== false;
    autoOn = s.taskAuto !== false;
    // Автозадачи выключены галочкой — дело не должно молчать совсем: напоминаем
    // тостом, как обычное (иначе «ставлю время, и не происходит ничего»).
    if (remindOn) due = agentStore.tasksTakeReminders(userDataDir(), undefined, { includeAuto: !autoOn }).tasks;
    // Автозадачи — это работа агента, а не тост: галочка напоминаний их не глушит.
    if (autoOn) {
      const take = agentStore.tasksTakeAuto(userDataDir());
      auto = take.tasks;
      failed = take.failed || [];
    }
  } catch {
    return;
  }
  const now = Date.now();
  for (const t of due) {
    const at = new Date(t.due).getTime();
    const late = at < now;
    notifyUser((late ? "⚠ Дело просрочено: " : "⏰ Дело: ") + t.title, agentStore.humanDue(t, now));
  }
  // Автозадача не подтвердилась после всех попыток: молчать нельзя — человек ждал,
  // что агент сработает сам.
  for (const t of failed) {
    notifyUser("⚠ Автозадача не запустилась: " + t.title, t.error || "прогон не подтвердился");
  }
  if (due.length || auto.length || failed.length) emitTasksChanged();
  try {
    if (due.length) {
      mainWindow.webContents.send("ai:event", {
        type: "task-reminder",
        tasks: due.map((t) => ({ id: t.id, title: t.title, due: t.due, late: new Date(t.due).getTime() < now })),
      });
    }
    if (auto.length) {
      // from: "desktop" — событие уходит и на телефон, но запускать автозадачу
      // должен только ПК-клиент: у чатов один хозяин, иначе прогон удвоится.
      mainWindow.webContents.send("ai:event", { type: "task-due", from: "desktop", tasks: auto });
    }
    // Автозадача не пошла: окно говорит об этом человеку тостом в ленте.
    if (failed.length) {
      mainWindow.webContents.send("ai:event", { type: "task-auto-failed", tasks: failed });
    }
  } catch {}
  armTaskWake();
}

async function executeTool(name, args, settings) {
  args = args || {};
  // Инструмент в работе: его capability решает, какие переменные агента дойдут до
  // команд внутри него. Вызовы инструментов идут по очереди (цикл runAi), поэтому
  // одного «текущего назначения» достаточно; вложенный вызов вернёт своё.
  const prevCapability = activeToolCapability;
  activeToolCapability = toolPolicy.capabilityOf(name);
  try {
    // Пользователь нажал Esc/«Стоп» — агент должен немедленно остановиться.
    if (global.__agentStopRequested) {
      return "⏹ Остановлено пользователем (Esc / Стоп). Немедленно прекрати вызовы инструментов и заверши ответ КРАТКИМ итогом: что успел сделать и что осталось.";
    }
    // Обработчики вынесены в src/agent-tools.js (1.5.77): здесь только выбор
    // инструмента и единая обработка ошибок — как и раньше.
    const handler = agentToolHandlers[name];
    if (!handler) return "Ошибка: неизвестный инструмент " + name;
    return await handler(args, settings);
  } catch (e) {
    return "Ошибка: " + fmtError(e);
  } finally {
    activeToolCapability = prevCapability;
  }
}

// ─────────────────────────── AI: список моделей ───────────────────────────
async function fetchModels(settings) {
  return listModels(settings);
}

// ─────────────────────────── AI: чат с инструментами ───────────────────────────
let activeAbort = null;
let activeEmit = null; // отправка ai:event из executeTool (showImage и т.п.)
// Последний план работ (todoWrite) текущего прогона. Нужен предохранителю,
// который ловит обрыв: модель ответила текстом, а пункты плана не закрыты.
let activePlanSummary = null;
// Роутер инструментов текущего запуска: findTools по нему включает группы на лету.
let activeToolRouter = null;

// Авто-чекпоинт (как в Replit): после завершённого задания агента, если он менял файлы
// в git-репозитории — создаём один локальный коммит-точку возврата. Никогда не пушит.
async function autoCheckpointCommit(settings, messages) {
  try {
    if (settings && settings.agentAutoCommit === false) return { committed: false };
    const dir = agentWorkDir(settings);
    if (!dir || !fs.existsSync(dir)) return { committed: false };
    // Не git-репозиторий или нет изменений — пропускаем тихо.
    const st = await runGit(dir, ["status", "--porcelain"], settings);
    if (!st.ok || !st.out.trim()) return { committed: false };
    // Заголовок коммита — из последнего сообщения пользователя (первая строка).
    let title = "";
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          const lines = m.content.replace(/```[\s\S]*?```/g, " ").split("\n");
          title = lines.find(function (l) { return l.trim(); }) || "";
          break;
        }
      }
    }
    title = String(title).replace(/\s+/g, " ").trim().slice(0, 70);
    if (!title) title = "Работа агента";
    const add = await stageAllSafe(dir, settings);
    if (!add.ok) return { committed: false };
    const commit = await runGit(
      dir,
      ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", "Авто-коммит агента: " + title],
      settings
    );
    if (!commit.ok) return { committed: false };
    return { committed: true, message: "💾 Авто-коммит агента: " + title };
  } catch (e) {
    return { committed: false };
  }
}

// Память диалогов: сохраняем сжатую памятку в локальный дневник по датам, но
// ТОЛЬКО если пользователь включил галочку «Память диалогов» (иначе — тишина).
// Отдельно от дневника памяти работает зеркало рядом с проектом
// (.agent/context/<дата>.md): долгая работа обязана оставлять следы файлами на ПК,
// даже когда галочка «Память диалогов» выключена — поэтому зеркало решает своё
// условие («файлы работы агента»), а не эту галочку.
function saveContextMemo(settings, entry, emit) {
  if (!settings || !entry || !String(entry.text || "").trim()) return null;
  if (settings.agentWorkFiles !== false) {
    try {
      missionStore.contextMirror(agentWorkDir(settings), entry.ts, entry.text);
    } catch {}
  }
  if (!settings.contextMemory) return null;
  try {
    const r = agentStore.contextMemorySave(app.getPath("userData"), {
      ts: entry.ts,
      memo: entry.text,
      messages: entry.messages,
      provider: entry.provider,
      model: entry.model,
      workDir: agentWorkDir(settings),
      keepDays: Number(settings.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
    });
    if (r && r.ok && emit) {
      emit({
        type: "memory",
        text: "🧠 Память диалогов: сохранена памятка за " + r.day + " (памяток за день: " + r.count + "). Спросить прошлые сессии — memoryList / memorySearch.",
      });
    }
    return r;
  } catch {
    return null;
  }
}

async function runAi(settings, messages, win, opts) {
  opts = opts || {};
  const planMode = !!(opts.plan || opts.planMode); // режим «сначала план»: инструменты не выполняются
  // Роль чата (Разработчик / Ассистент / Менеджер / Исследователь). Текст роли уходит
  // в системный промпт каждый раунд, а её группы инструментов включены с первого раунда:
  // набор схем не меняется на ходу, префикс запроса стабилен, каждый раунд дешевле.
  const role = rolePlan(opts.role);
  const roleNote = role.prompt ? "\n\n" + role.prompt : "";

  // Менеджеру сразу даём свежую сводку дел — чтобы он не гадал и не звал taskList впустую.
  let tasksNote = "";
  if (role.id === "manager" && !planMode) {
    try {
      tasksNote = "\n\n=== МОИ ДЕЛА (актуально на " + new Date().toLocaleString() + ") ===\n" + agentStore.tasksBrief(userDataDir(), 8);
    } catch {}
  }
  const emit = (ev) => {
    if (!win.isDestroyed()) win.webContents.send("ai:event", ev);
  };
  activeEmit = emit;
  const abort = new AbortController();
  activeAbort = abort;
  activeRunUndo = [];
  const provider = settings.provider || "openai";
  // Рассуждения модели (текст из <think>...</think> и нативные reasoning_content / thinking_delta)
  const emitThink = (text) => {
    if (text) emit({ type: "thinking", text });
  };

  // ── Миссия: долгая работа, которая переживает перезапуск — код в src/run-mission.js ──
  // Агент «на 8 часов» не имеет права терять задачу: цель, план, шаги и журнал лежат
  // файлами в .agent/missions/<id>/, а прогон идёт БАТЧАМИ (25 раундов, затем
  // «миссия жива? лимиты? был ли прогресс?» и новый батч с тем же контекстом).
  // Живые значения приходят мостами: emit определён выше, «▶ Продолжить» из панели
  // отдаёт свою просьбу через missionClaim, а инструменты агента видят миссию
  // прогона по runMissionId. Показ (чат, откат, «готово») остаётся здесь.
  const mission = createRunMission({
    settings,
    planMode,
    messages,
    roleId: role.id,
    dir: agentWorkDir(settings),
    chatId: activeRunChatId,
    emit,
    missionStore,
    missionGuard,
    live: {
      get missionClaim() {
        return missionClaim;
      },
      set missionClaim(v) {
        missionClaim = v;
      },
      set missionId(v) {
        runMissionId = v;
      },
    },
  });

  // Пауза по кнопке: работа не теряется — миссия гасится на диске модулем, а
  // показ, откат и «готово» делает оболочка. Порядок событий прежний.
  const stopForPause = () => {
    const paused = mission.pause();
    global.__agentPauseRequested = false;
    finalText = paused.text;
    emit({ type: "chunk", text: finalText });
    mission.emitState("paused");
    lastUndoLog = activeRunUndo.slice();
    persistUndo();
    if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  if (!settings.model) {
    throw new Error("Не выбрана модель. Открой Настройки и обнови список моделей (кнопка ↻).");
  }

  // Локальный ли сервер — по АДРЕСУ, а не по имени семейства: LM Studio, vLLM,
  // llama.cpp и g4f живут на своём ПК, и правила у них локальные (потолок по памяти,
  // неспешные таймауты), хотя говорят они на OpenAI-совместимом API.
  const localEndpoint = isLocalEndpoint(settings);
  // Контекст-окно: бюджет = реальное окно модели (если известно) минус резерв на вывод.
  let budget = contextBudget(provider, settings.model);
  let modelWin = 0; // реальное окно модели (0 — сервер не ответил)
  try {
    modelWin = await modelWindow(settings, settings.model);
    // Потолок бюджета. У облака это «сколько не жалко токенов», у локальной модели —
    // её окно: локальные токены бесплатны, платим памятью (KV-кэш) и временем. Прежний
    // общий потолок 14 000 душил локальную модель с окном 40–130k, а вместе с ним
    // выключался и роутер инструментов (см. tools.refresh).
    if (modelWin > 0) budget = windowBudget(provider, budget, modelWin, { local: localEndpoint });
    // Нижний предел — 3000 токенов, но НИКОГДА больше реального окна: у модели с
    // окном 2048 «пол» в 3000 гарантировал переполнение на каждом запросе.
    budget = Math.max(budget, modelWin > 0 ? Math.min(3000, modelWin) : 3000);
  } catch {}
  // Возможности локальной модели (tools) — не «информация к сведению»: без capability
  // «tools» схемы в запросе бесполезны, а часть сборок Ollama отвечает на них ошибкой и
  // роняет весь раунд. Ниже это переключает протокол вызова инструментов.
  let ollamaInfo = null;
  if (provider === "ollama") {
    try {
      ollamaInfo = await ollamaModelInfo(settings, settings.model);
    } catch {}
  }
  // Ollama сама сообщает о поддержке инструментов (/api/show → capabilities).
  // У совместимых серверов (LM Studio, vLLM, g4f) спросить негде, поэтому там это
  // осознанная галочка в настройках — угадывать по имени модели мы не будем.
  const noToolsDetected = !!(ollamaInfo && ollamaInfo.known && !ollamaInfo.tools);
  const noTools = noToolsDetected || !!settings.noToolsModel;
  if (noTools) {
    // Говорим и в «Консоль», и в чат: раньше сообщение жило только в консоли,
    // а пользователь видел «модель ничего не делает» без объяснения причины.
    const noToolsNote = noToolsDetected
      ? "⚠ Модель «" + settings.model + "» не объявила поддержку инструментов (нет capability «tools»). " +
        "Схемы в таком запросе бесполезны, поэтому работаю по текстовому протоколу: в системное " +
        "сообщение ушёл компактный каталог, а инструменты вызываются JSON-блоком " +
        "{\"name\": ..., \"arguments\": {...}}. Для файлов и git надёжнее модель с инструментами " +
        "(qwen3, llama3.1, mistral-nemo)."
      : "⚠ Включена настройка «Модель без поддержки инструментов»: схемы не отправляю, " +
        "вместо них в системном сообщении компактный каталог, а инструменты вызываются " +
        "JSON-блоком {\"name\": ..., \"arguments\": {...}}. Выключи галочку, если модель " +
        "умеет нативные вызовы — тогда вернутся схемы и точность вызовов будет выше.";
    termEmit({ type: "metrics", text: noToolsNote });
    emit({ type: "notice", text: noToolsNote });
  }
  // Счётчики повторов, ожидание лимита и лимитер провайдера живут в src/run-retry.js,
  // который собирается ниже (после истории: ему нужно уметь ужимать контекст).
  let reportRetried = false; // пустой финальный текст — один раз просим итоговый отчёт
  let planNudges = 0; // «план не закрыт, а модель замолчала» — просим продолжить делом (макс. 2)
  activePlanSummary = null; // план прошлого прогона не должен влиять на этот
  // ── Роутер инструментов и справочники ──────────────────────────────────────
  // Состав схем, липкость групп, предохранители A и C, вес схем и автоподключение
  // справочников живут в src/run-tools.js — там же объяснено, почему группа не
  // гаснет на середине задачи и почему вес считается по тому, что РЕАЛЬНО уйдёт в
  // запрос. Здесь — только сборка и чтение состояния прогона.
  const tools = createRunTools({
    settings,
    planMode,
    messages,
    role,
    noTools,
    emit,
    termEmit,
    getBudget: () => budget, // бюджет пересчитывается при переполнении — считаем по живому
    systemPrompt: SYSTEM_PROMPT,
    routeTools,
    routerMaxTokens,
    routerTaskText,
    estimateTokens,
    toolsAsText,
    guideReadText,
    groupOfTool,
    PLAN_MODE_TOOL_DEFINITIONS,
  });
  activeToolRouter = tools.router;
  tools.refresh();
  const ctxManager = createContextManager({
    settings,
    emit,
    planMode,
    // Сжатие идёт тем же сервером: локальной модели нужен тот же num_ctx, иначе Ollama
    // возьмёт дефолт 2048 (памятка соберётся из обрезанного текста) и перезагрузит модель.
    localCtx: provider === "ollama" ? ollamaNumCtx(budget, modelWin) : 0,
    // Тот же признак, что и для бюджета: у местного сервера сжатие может идти минутами.
    local: localEndpoint,
    // Память диалогов: при сжатии контекста пишем памятку в локальный дневник (по датам).
    onMemo: (m) => saveContextMemo(settings, m, emit),
  });
  // Индикатор контекста: сколько токенов занимают история + схема инструментов.
  // Отправляется в интерфейс полоской под полем ввода (видно, когда контекст подходит к концу).
  const emitContext = (hist) => {
    try {
      const histTokens = hist && hist.length ? estimateTokens(JSON.stringify(hist)) : 0;
      const used = histTokens + tools.state.weight + tools.state.systemWeight;
      const percent = budget > 0 ? Math.max(0, Math.min(100, Math.round((used / budget) * 100))) : 0;
      emit({ type: "context", used, budget, percent, history: histTokens, tools: tools.state.weight, system: tools.state.systemWeight });
    } catch {}
  };


  // ── Завершение прогона — одна точка входа ──────────────────────────────────
  // И обычный финал, и мягкая остановка миссии (лимит раундов/времени, зацикливание)
  // проходят здесь: пользователь получает объяснение, а не «ошибку API».
  const endRun = async (fallbackText) => {
    // Мягкая остановка миссии (лимит раундов/времени, зацикливание, закрытие) —
    // это объяснение человеку, а не «ошибка API». Раньше оно подставлялось только
    // вместо ПУСТОГО ответа: если модель успела напечатать текст в последнем раунде,
    // человек видел обрыв на полуслове и без причины. Теперь объяснение дописывается
    // в конец ответа, а сам ответ не затирается.
    const stopNote = String(fallbackText || "").trim();
    const said = String(finalText || "").trim();
    if (stopNote && stopNote !== said) {
      finalText = said ? finalText + "\n\n" + stopNote : stopNote;
      emit({ type: "chunk", text: (said ? "\n\n" : "") + stopNote });
    }
    if (!String(finalText || "").trim() && !abort.signal.aborted) {
      finalText =
        "⚠ Модель не прислала итоговый текст (вероятно, переполнен контекст). Изменения сохранены; нажми «↻ Перегенерировать» или напиши «продолжай».";
      emit({ type: "chunk", text: finalText });
    }
    lastUndoLog = activeRunUndo.slice();
    persistUndo();
    if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
    // Авто-чекпоинт: агент менял файлы — фиксируем локальный коммит-точку возврата (без пуша).
    if (!planMode && lastUndoLog.length) {
      const cp = await autoCheckpointCommit(settings, messages);
      if (cp && cp.committed) emit({ type: "checkpoint", message: cp.message });
    }
    // Системное уведомление, если окно не в фокусе (долгий ответ закончился)
    if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
      try {
        const snippet = String(finalText || "").trim().slice(0, 140);
        new Notification({
          title: "AI Developer Agent",
          body: "Ответ агента готов" + (snippet ? ": " + snippet : ""),
        }).show();
      } catch {}
    }
    mission.emitState("end");
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  const askUserWait = (question) => {
    emit({ type: "ask", question });
    return new Promise((resolve) => {
      pendingAsk = resolve;
      // Если пользователь не ответит за 5 минут — продолжаем без ответа
      setTimeout(() => {
        if (pendingAsk) {
          const r = pendingAsk;
          pendingAsk = null;
          r("");
        }
      }, 300000);
    });
  };
  const trimmedHistory = await ctxManager.manage(messages, tools.state.histBudget);
  emitContext(trimmedHistory);
  // Авто-разбор присланных картинок вспомогательной vision-моделью (второй ключ):
  // скриншот → описание → кодер работает с текстом (его модель может не видеть картинки).
  let runHistory = trimmedHistory;
  const vcfg = auxConfig(settings);
  if (vcfg.enabled && vcfg.auto && vcfg.visionModel && vcfg.url && !planMode) {
    let target = -1;
    for (let i = runHistory.length - 1; i >= 0; i--) {
      const m = runHistory[i];
      if (m && m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p && p.type === "image_url")) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      const msg = runHistory[target];
      const text = (msg.content || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
      const imgs = (msg.content || []).filter((p) => p && p.type === "image_url" && p.image_url && p.image_url.url).slice(0, 3);
      emit({ type: "vision", text: "👁 Разбираю присланные изображения вспомогательной моделью…" });
      try {
        const descs = [];
        for (const part of imgs) {
          const desc = await describeImageRemote(vcfg, part.image_url.url, "Опиши подробно, что изображено на картинке: объекты, текст, интерфейс, цвета, расположение. Это описание уйдёт программисту вместо картинки.", vcfg.visionModel);
          descs.push(desc || "(описание пустое)");
        }
        const note = "\n\n[Описание присланного изображения (сделано вспомогательной vision-моделью на отдельном ключе):]\n" + descs.join("\n\n---\n\n");
        runHistory = runHistory.slice();
        runHistory[target] = { ...msg, content: text ? text + note : note.trim() };
        emit({ type: "vision", text: "✓ Изображения разобраны — описание передано основной модели." });
      } catch (e) {
        emit({ type: "vision", text: "⚠ Не удалось разобрать изображение: " + ((e && e.message) || e) + " — картинка отправлена как есть." });
      }
    }
  }
  // Канонические сообщения (OpenAI-стиль). Провайдер-специфику применяем на лету в buildChatRequest.
  const workDir = agentWorkDir(settings);
  const wdNote =
    "\n\nРабочая директория приложения (туда создаются файлы и там выполняются команды): " +
    workDir +
    (lastAgentRepoDir && lastAgentRepoDir !== workDir ? "\nАктивный репозиторий: " + lastAgentRepoDir : "") +
    '\nОтносительные пути вроде "test.txt" или "src/utils/helper.txt" резолвятся относительно рабочей директории.';
  // Краткая «визитка» проекта — чтобы агент не начинал сессию вслепую
  // (buildProjectBrief: имя, скрипты, структура, начало README).
  const projectBrief = buildProjectBrief(workDir);
  const briefNote = projectBrief
    ? "\n\n=== САММАРИ ПРОЕКТА (сгенерировано автоматически; детали — через listFiles / fileOutline / readFileLines) ===\n" + projectBrief
    : "";
  // Одноразовый толчок после клонирования/выбора репозитория: без него агент может
  // не догадаться, что пользователь ждёт разбора нового проекта. Флаг сбрасывается
  // сразу после первого ответа — постоянной нагрузки на контекст нет.
  let cloneNote = "";
  if (clonedRepoPending && !planMode) {
    clonedRepoPending = false;
    cloneNote =
      "\n\nПроект только что склонирован (рабочая директория сменилась). Пользователь ждёт: краткий анализ проекта и инструкцию, как его запустить — команда запуска (скрипты — в САММАРИ ПРОЕКТА), порт, как проверить (startBackground + checkUrl/checkPort; для веб-интерфейса — previewUI). Файлы целиком не читай — fileOutline / readFileLines / searchProject.";
  }
  let canonical = [
    {
      role: "system",
      content: SYSTEM_PROMPT + roleNote + tasksNote + wdNote + briefNote + cloneNote + (planMode ? "\n\nРЕЖИМ ПЛАНА: доступен только todoWrite — вызови его с планом работ (3–7 пунктов) и в тексте перечисли файлы, которые затронешь. НЕ изменяй файлы и НЕ выполняй другие инструменты. Жди команды пользователя." : ""),
    },
    ...sanitizeToolPairs(runHistory.map((m) => ({ role: m.role, content: m.content }))),
  ];

  // Ужать историю при переполнении контекста: бюджет уменьшается, список пересобирается.
  // Ровно та же работа нужна и при сжатии между раундами, поэтому — одной точкой входа.
  const shrinkContext = async () => {
    budget = Math.max(3000, Math.floor(budget * 0.4));
    tools.state.histBudget = tools.histBudgetAfterOverflow();
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), tools.state.histBudget))];
      emitContext(canonical);
    }
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }
  };

  // Восстановление после отказа запроса (лимиты 429, «холодный» пул 503, переполнение
  // контекста, отказ строгого сервера) живёт в src/run-retry.js: там же объяснено,
  // почему ждём сами и что сбрасывает счётчики. Здесь — сборка с живыми значениями.
  const retry = createRunRetry({
    settings,
    provider,
    emit,
    termEmit,
    rateLimiter: rateLimiterFor(settings),
    getBudget: () => budget,
    shrinkContext: shrinkContext,
    friendlyRateLimitError,
    rateLimitInfo,
    coldCacheInfo,
    UNAVAILABLE_MAX,
  });

  // Один раунд общения с провайдером (запрос, поток ответа, метрики) — своим модулем
  // (src/run-round.js). Бюджет и окно модели идут функциями: их меняет ужатие
  // контекста, и копия застыла бы на старом числе.
  const roundRunner = createRunRound({
    settings,
    provider,
    emit,
    termEmit,
    emitThink,
    getBudget: () => budget,
    getModelWindow: () => modelWin,
    getCompactions: () => ctxManager.compactions(),
    noTools: noTools,
    localEndpoint: localEndpoint,
    tools: tools,
    retry: retry,
    mission: mission,
    abort: abort,
    SYSTEM_PROMPT,
    buildChatRequest,
    consumeProviderStream,
    createThinkingStripper,
    readApiError,
    estimateTokens,
  });

  // Вызовы раунда (текстовые, нормализация, история, параллельная пачка) — своим
  // модулем (src/run-calls.js). Список безопасных для параллели инструментов
  // остаётся здесь: он собран из инструментов всего приложения.
  const callPrep = createRunCalls({
    settings,
    emit,
    extractToolCallsFromText,
    genCallId,
    normalizeToolName,
    executeTool,
    truncateText,
    fmtError,
    PARALLEL_SAFE_TOOLS,
  });

  const maxRounds = planMode ? 3 : 25;
  let finalText = "";

  const stopGraceful = () => {
    if (!String(finalText || "").trim()) {
      finalText = "⏹ Остановлено пользователем. Изменения сохранены; напиши «продолжай», чтобы доработать.";
      emit({ type: "chunk", text: finalText });
    }
    lastUndoLog = activeRunUndo.slice();
    persistUndo();
    if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  // Авто-повтор после сбоя: при любой ошибке (сеть/API/провайдер/инструмент) делаем ещё
  // попытку с продолжением контекста (история canonical сохраняется) — до AUTO_RETRY_LIMIT повторов.
  const AUTO_RETRY_LIMIT = 2;
  for (let attemptNum = 1; ; attemptNum++) {
  try {
  // Батчи: 25 раундов работы, затем проверка «миссия жива? лимиты? был ли прогресс?»
  // и следующий батч с тем же контекстом. Долгая работа перестаёт быть одной
  // длинной попыткой, которую обрывает счётчик раундов.
  for (let batch = 1; ; batch++) {
  for (let round = 0; round < maxRounds; round++) {
    mission.state.rounds++;
    // Незакрытая миссия (в том числе с прошлого запуска приложения) — продолжаем её,
    // а не начинаем работу заново: файлы и журнал лежат на диске.
    if (mission.state.rounds === 1) {
      const resumed = mission.resume();
      if (resumed) {
        emit({ type: "notice", text: resumed.notice });
        mission.emitState(resumed.phase);
      }
    }
    // Длинная работа видна по делу: если модель много раундов работает инструментами,
    // заводим миссию — файлы, журнал и защита от обрыва появляются вовремя.
    mission.autoStart();
    // Пауза из панели «Миссия»: не начинаем новый раунд, работу не теряем.
    if (global.__agentPauseRequested) return stopForPause();
    // Пользователь остановил агента (Esc/Стоп) — не начинаем новый раунд.
    if (global.__agentStopRequested) return stopGraceful();
    // Роутер: пересобираем набор схем (группы могли добавиться в прошлом раунде).
    tools.refresh();
    // Контекст-менеджмент: между раундами держим историю в рамках бюджета токенов.
    // Хвост (текущий виток с tool-результатами) сохраняется целиком.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), tools.state.histBudget))];
      emitContext(canonical);
    }
    // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
    // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }

    // Один раунд (запрос, поток ответа, метрики) живёт в src/run-round.js: там же
    // объяснено, почему состав схем, бюджет и usage ошибаются тихо. Хозяином цикла
    // остаётся прогон: и повтор раунда, и фатальная ошибка — его решение.
    const roundOut = await roundRunner.run({ n: round, maxRounds: maxRounds, messages: canonical });
    if (roundOut.kind === "repeat") {
      round--;
      continue;
    }
    if (roundOut.kind === "error") throw roundOut.error;
    const toolCalls = roundOut.toolCalls;
    finalText = roundOut.text;

    // Запасной способ живёт в src/run-calls.js. Он стоит здесь, ДО призывов и
    // «пустого отчёта»: найденный в тексте вызов обязан выполниться, а не уйти
    // в призыв «план не закрыт».
    callPrep.fromText({ toolCalls: toolCalls, text: finalText, planMode: planMode });

    // Модель ответила текстом без вызова инструментов, но план работ не закрыт —
    // это обрыв, а не финал. На выросшем/сжатом контексте слабые модели (особенно
    // локальные) «забывают» вызвать инструмент и просто описывают, что осталось, —
    // раньше прогон на этом заканчивался, и агент выглядел отключившимся.
    if (
      toolCalls.length === 0 &&
      !planMode &&
      !abort.signal.aborted &&
      planNudges < 2 &&
      activePlanSummary &&
      activePlanSummary.total > 0 &&
      activePlanSummary.done + activePlanSummary.failed < activePlanSummary.total
    ) {
      planNudges++;
      const left = activePlanSummary.total - activePlanSummary.done - activePlanSummary.failed;
      termEmit({
        type: "metrics",
        text: "📋 План не закрыт (" + left + " из " + activePlanSummary.total + " пунктов) — прошу агента продолжить делом (попытка " + planNudges + "/2).",
      });
      canonical.push({
        role: "user",
        content:
          "Ты ответил текстом, но план работ не закрыт: " + activePlanSummary.done + " из " + activePlanSummary.total + " готово" +
          (activePlanSummary.failed ? ", сбоев: " + activePlanSummary.failed : "") +
          ". Работа не окончена — не описывай, что осталось, а ВЫПОЛНЯЙ: вызови следующий инструмент. " +
          "Если пункт выполнить нельзя — отметь его failed через todoWrite (с причиной в note) и переходи к следующему. " +
          "После каждого шага присылай todoWrite с ПОЛНЫМ списком.",
      });
      continue;
    }

    // Миссия не закрыта, а модель ответила текстом. Призывать ли дальше — решает
    // сторож (src/mission-guard.js): один призыв на первый текстовый ответ, дальше —
    // только если работа сдвинулась. Повтор того же ответа или стояние на месте
    // прекращает призывы и уводит миссию в паузу: раньше приложение подталкивало
    // модель трижды подряд, и человек получал три одинаковых отчёта по кругу.
    if (toolCalls.length === 0 && !planMode && !abort.signal.aborted && mission.canNudge()) {
      const nudge = mission.nudge(finalText);
      if (nudge.action === "nudge") {
        emit({ type: "notice", text: nudge.notice });
        canonical.push({ role: "user", content: nudge.historyMessage });
        continue;
      }
      if (nudge.action === "pause") {
        // Призывы прекращены: миссия встаёт на паузу и ждёт человека. Пауза сама
        // не подхватывается следующим прогоном — на этом петля и кончается.
        emit({ type: "notice", text: nudge.notice });
        mission.emitState(nudge.phase);
        mission.refresh(); // пауза не подхватывается сама: дальше работа идёт как обычная
      }
    }

    // Пустой финальный ответ — не молчим. Один раз просим итоговый отчёт.
    if (toolCalls.length === 0 && !planMode && !reportRetried && !String(finalText || "").trim() && !abort.signal.aborted) {
      reportRetried = true;
      canonical.push({
        role: "user",
        content:
          "Ты завершил действия, но итоговый ответ получился пустым. Напиши структурированный итоговый отчёт: что сделано, какие файлы созданы/изменены, какие команды выполнялись, как проверить результат.",
      });
      continue;
    }

    if (toolCalls.length === 0) return await endRun("");

    // Нормализация имён, стабильные id, дедупликация и запись в историю —
    // в src/run-calls.js: там же объяснено, почему дубль вызова и потерянная
    // подпись мысли (Gemini) стоят дорого.
    const calls = callPrep.normalize(toolCalls);
    // Предохранитель A: модель вызвала реальный инструмент, которого нет в текущем
    // наборе схем (группа не была активирована). Дотягиваем его группу — в этом и
    // следующих раундах схема будет на месте; сам вызов выполняем как обычно.
    tools.ensureGroupsFor(calls);

    // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
    if (!calls.length) {
      if (!String(finalText || "").trim()) finalText = "Готово.";
      emit({ type: "chunk", text: finalText });
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    callPrep.recordAssistant(canonical, finalText, calls);

    // Батчинг (правило 35 промпта): read-only вызовы раунда идут параллельно,
    // любая запись или вопрос человеку возвращает строгую очередь. Решение и
    // порядок событий — в src/run-calls.js, остановка остаётся за прогоном.
    if (callPrep.canRunParallel(calls, planMode)) {
      await callPrep.runParallel(calls, canonical);
      if (global.__agentStopRequested) return stopGraceful();
      continue;
    }

    for (const c of calls) {
      // План-режим: выполняем только todoWrite. Если модель по привычке вызвала
      // другой инструмент — не выполняем его и говорим об этом прямо.
      if (planMode && c.name !== "todoWrite") {
        const blocked =
          "Режим плана: инструменты не выполняются. Составь план через todoWrite и дождись команды пользователя.";
        canonical.push({ role: "tool", tool_call_id: c.id, content: blocked });
        continue;
      }
      emit({ type: "tool_start", name: c.name, args: c.args });
      let result;
      // Как обошлось действие: auto — без вопросов, approved/denied — решал пользователь.
      // Нужно журналу действий: подтверждения и отказы пишутся всегда.
      let decision = "auto";
      const confirmYes = (answer) =>
        /^(да|yes|y|ok|го|ага|точно|конечно|давай|выполн)/i.test(String(answer || "").trim());
      if (c.name === "askUser") {
        const question = (c.args && c.args.question) || "Уточни, пожалуйста";
        const answer = await askUserWait(question);
        result = answer && String(answer).trim() ? String(answer).trim() : "(пользователь не дал ответ)";
      } else if (c.name === "runCommand" && toolPolicy.isDangerousCommand((c.args && c.args.command) || "")) {
        // Потенциально опасные команды выполняем только после явного подтверждения
        // (что считать опасным — решает политика: src/tool-policy.js).
        const cmd = String((c.args && c.args.command) || "");
        const answer = await askUserWait(
          "⚠️ Команда потенциально опасна: «" + cmd.slice(0, 160) + "»\nВыполнить? (да / нет)"
        );
        if (confirmYes(answer)) {
          decision = "approved";
          result = await executeTool(c.name, c.args, settings);
        } else {
          decision = "denied";
          result =
            "Команда НЕ выполнена: пользователь не подтвердил опасную операцию. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
        }
      } else if (toolPolicy.needsConfirm(c.name)) {
        // Инструмент с высоким риском и без своей защиты — спрашиваем пользователя.
        const desc = describeToolArgs(c.name, c.args);
        const answer = await askUserWait("⚠️ Действие потенциально опасно: " + desc + "\nВыполнить? (да / нет)");
        if (confirmYes(answer)) {
          decision = "approved";
          result = await executeTool(c.name, c.args, settings);
        } else {
          decision = "denied";
          result = "Действие НЕ выполнено: пользователь не подтвердил. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
        }
      } else {
        // Чекпоинт: до правки файла запоминаем его состояние (для отката изменений агента)
        if (c.name === "writeFile" || c.name === "editFile") {
          try { snapshotFileForUndo(resolvePath(c.args && c.args.path, settings)); } catch {}
        }
        result = await executeTool(c.name, c.args, settings);
      }
      // Журнал действий: подтверждения, отказы, риск medium/high и незнакомые
      // инструменты. Секреты в журнал не попадают (редакция в tool-policy.js).
      audit.record({ tool: c.name, args: c.args, decision, result, source: activeRunOrigin });
      // Миссия: журнал по значимым действиям (в журнале видно, чем агент занят) и
      // счётчик повторов одного и того же вызова — по нему ловится цикл.
      mission.noteCall(c.name, c.args);
      // Держим контекст в рамках бюджета: длинный вывод инструмента ужимаем
      const capped = truncateText(result, 8000);
      emit({ type: "tool_result", name: c.name, result: capped });
      canonical.push({ role: "tool", tool_call_id: c.id, content: capped });
    }
    // Остановка во время выполнения инструментов — завершаем без нового раунда.
    if (global.__agentStopRequested) return stopGraceful();
    mission.trackProgress(calls);
  }
  // Конец батча: миссия жива — продолжаем следующим батчом (тот же контекст),
  // лимиты/зацикливание — мягкая остановка с сохранением работы, без ошибки в чате.
  const afterBatch = await mission.afterBatch();
  if (afterBatch.finish) {
    mission.emitState(afterBatch.phase);
    return await endRun(afterBatch.message);
  }
  if (!afterBatch.continue) {
    // Миссия закрыта — это НЕ исчерпание счётчика раундов: завершаем обычным
    // финалом. Иначе успешная работа обрывалась бы грозным «превышено число
    // раундов», и это выглядело бы как «агент ни с того ни с сего отвалился».
    if (afterBatch.closed) {
      const mDone = mission.refresh();
      return await endRun(
        "🏁 Работа закончена" + (mDone ? " — миссия «" + mDone.title + "» закрыта" : "") +
          ". Цель, план, журнал и отчёт: .agent/missions/."
      );
    }
    break;
  }
  // Продолжаем батч: напоминание в чат и в историю, событие миссии — и короткая
  // пауза, чтобы провайдер и интерфейс вздохнули (история при этом не меняется).
  emit({ type: "notice", text: afterBatch.notice });
  mission.emitState(afterBatch.phase);
  canonical.push({ role: "user", content: afterBatch.historyMessage });
  await new Promise((r) => setTimeout(r, 1500));
  }
  throw Object.assign(
    new Error(
      "Превышено максимальное число раундов вызова инструментов (" + maxRounds + "). " +
      "(Действия на диске сохранены.) Напиши «продолжай» — агент получит тот же контекст и продолжит с текущего места."
    ),
    { fatal: true }
  );
  } catch (e) {
    const fatal = (e && e.name === "AbortError") || (e && e.fatal) || global.__agentStopRequested || (e && e.message && /Не выбрана модель/.test(e.message));
    // Миссия и сбой: обычные ошибки (сеть, 5xx, обрыв) не повод бросать долгую работу.
    // Ждём и продолжаем, пока миссия жива и не исчерпан запас авто-продолжений.
    const mAlive = !fatal && mission.alive();
    const mContinues = mAlive && mission.canAutoContinue();
    if (fatal || (attemptNum > AUTO_RETRY_LIMIT && !mContinues)) throw e;
    if (mContinues) mission.recordError(e);
    const errText = String((e && e.message) || e).slice(0, 800);
    // Провайдер отверг stream_options уже внутри ответа (не ошибкой на заголовках) —
    // снимаем флаг: авто-повтор ниже пойдёт без него.
    if (retry.state.includeUsage && /stream_options|include_usage/i.test(errText)) {
      retry.state.includeUsage = false;
      termEmit({
        type: "metrics",
        text: "Провайдер отверг stream_options — повторяю запрос без метрик токенов.",
      });
    }
    // Авто-переключение на следующее сохранённое OpenAI-подключение: ошибка ключа/
    // баланса/лимита/сети — пробуем другой ключ вместо бессмысленных повторов.
    let switchedProfile = null;
    if (settings.provider === "openai" && settings.autoSwitchProfiles) {
      try {
        // Меняем ключ только когда ошибка действительно про ключ/баланс/лимит,
        // и откладываем провинившийся ключ на cooldown (не долбим провайдера).
        const cls = classifyKeyError(errText);
        if (cls.key) switchedProfile = switchOpenaiProfile(settings, { penalizeCurrentMs: cls.cooldownMs });
        if (switchedProfile) {
          saveSettings(settings); // активное подключение сохраняется (ключи — в secrets.json)
          emit({
            type: "profile_switched",
            name: switchedProfile.name || switchedProfile.id || "?",
            id: switchedProfile.id,
            error: errText,
          });
        }
      } catch {}
    }
    emit({ type: "text_override", text: "" }); // стираем частичный текст упавшей попытки в UI
    emit({
      type: "retry",
      attempt: attemptNum + 1,
      total: AUTO_RETRY_LIMIT + 1,
      error: errText + (switchedProfile ? " — переключено на подключение «" + (switchedProfile.name || switchedProfile.id) + "»" : ""),
    });
    finalText = "";
    await new Promise((r) => setTimeout(r, 3000)); // пауза: провайдеры сбрасывают лимиты за секунды
    canonical.push({
      role: "system",
      content:
        "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА — авто-повтор " + (attemptNum + 1) + " из " + (AUTO_RETRY_LIMIT + 1) + ".\n" +
        "Ошибка: " + errText + (switchedProfile ? " (выполнено переключение на другое подключение — ключ «" + (switchedProfile.name || switchedProfile.id) + "»)" : "") + "\n" +
        "Продолжай с того места, где остановился, опираясь на уже сделанное (инструменты, файлы, результаты выше). " +
        "Не начинай заново и не повторяй выполненные шаги: сначала быстро оцени текущее состояние (например git status или чтение ключевых файлов), затем продолжи. " +
        "Если ошибка про лимиты/токены — работай компактнее: меньше файлов целиком, чаще searchFile/semanticSearch, короче выводы.",
    });
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }
    continue;
  }
  }
}

// ─────────────────────────── Окно ───────────────────────────
let mainWindow = null;

// ── Окно — код в src/app-window.js ──
// Живые значения — мостами: окно создаётся позже и закрывается (setWindow),
// а метку запуска (чей прогон — ПК или телефон) пишет прогон агента (getRunOrigin).
const { createAppWindow } = require("./app-window.js");
const { createWindow } = createAppWindow({
  app,
  path,
  shell,
  mobileBridge,
  BrowserWindow,
  checkTaskReminders,
  getRunOrigin: () => activeRunOrigin,
  setWindow: (w) => { mainWindow = w; },
  appDir: __dirname,
});

// ── Пользовательский терминал (нижняя панель, как в Replit) — код в src/terminal-panel.js ──
// Имена те же: панель, каналы term:* и инструменты агента зовут их дословно.
// Окно приходит функцией — оно создаётся позже сборки модуля и может быть закрыто.
const { createTerminalPanel } = require("./terminal-panel.js");
const { termEmit, termAgentEcho, termStart, termInput, termStop, termStatus, termShutdown, termComplete } = createTerminalPanel({
  fs,
  path,
  os,
  spawn,
  stripAnsi,
  envFor,
  bgKill,
  agentWorkDir,
  loadSettings,
  getWindow: () => mainWindow,
});

// ─────────────────────────── IPC ───────────────────────────
ipcMain.handle("settings:get", () => loadSettings());
// Группы выдачи секретов (terminal, git, cloud …) для настроек: собираются из
// таблицы прав (tool-policy.js) — рендерер ничего не дублирует у себя.
ipcMain.handle("policy:groups", () => toolPolicy.scopeGroups());
ipcMain.handle("settings:set", (_e, s) => {
  const prev = loadSettings();
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    lastAgentRepoDir = null; // рабочая папка сменилась — сбрасываем «активный репозиторий»
  }
  const merged = normalizeSettings({ ...prev, ...(s || {}) });
  // Защита хранилища паролей: если сохранение пришло без массива sitePasswords
  // (старая версия интерфейса, обрезанный объект, мобильный клиент) — не затираем
  // уже сохранённые записи. Пустой массив — это осознанная очистка, её пропускаем.
  if (!s || !Array.isArray(s.sitePasswords)) merged.sitePasswords = prev.sitePasswords || [];
  // Защита пароля почты: сохранение без ключа mailPassword (мобильный клиент,
  // старый интерфейс) не должно стирать уже сохранённый пароль приложения.
  if (!s || s.mailPassword === undefined) merged.mailPassword = prev.mailPassword || "";
  // Защита выбора Yandex Cloud: каталог/облако меняются ТОЛЬКО своими IPC
  // (yc:setToken, yc:setFolder, автовыбор внутри yc:status, сброс в yc:logout) —
  // в форме настроек такого поля нет. Объект интерфейса, загруженный ДО автовыбора
  // каталога, приносил пустой (или устаревший) ycFolderId и стирал выбор: агент
  // снова видел «каталог не выбран», и каталог приходилось выбирать заново.
  // Та же болезнь, что у sitePasswords и mailPassword. Поэтому поля Yandex Cloud
  // берём из текущих настроек, а не из присланного объекта.
  merged.ycFolderId = prev.ycFolderId || "";
  merged.ycFolderName = prev.ycFolderName || "";
  merged.ycCloudId = prev.ycCloudId || "";
  // При смене рабочей папки — сбрасываем локальную папку выбранного GitHub-репозитория,
  // чтобы не подхватывать старый путь от прошлой локации.
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    merged.githubRepoDir = "";
    // Рабочая папка сменилась вручную — обновляем папку активного проекта, чтобы список не расходился.
    if (Array.isArray(merged.projects) && merged.activeProjectId) {
      const pr = merged.projects.find((p) => p.id === merged.activeProjectId);
      if (pr) pr.dir = merged.workingDir;
    }
  }
  applyAgentEnv(merged);
  // Мобильный доступ: при включении без PIN — генерируем его, затем применяем к мосту.
  if (merged.mobileEnabled && !merged.mobilePin) {
    merged.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  }
  applyBrowserSettings(merged);
  saveSettings(merged);
  mobileBridge.applySettings(merged);
  return merged;
});

// ─────────────────────────── Браузер агента (постоянный профиль) ───────────────────────────
// Сессии ВК и других сайтов хранятся в userData/browser-profile — вход переживает перезапуск.
// Единая точка применения браузерных настроек: своя папка профиля и режим «свой Chrome» (CDP).
function applyBrowserSettings(s) {
  const dir = path.join(app.getPath("userData"), "browser-profile");
  try {
    browserTools.setProfileDir(s && s.browserProfile === false ? "" : dir);
    browserTools.setConnectMode({
      enabled: !!(s && s.browserConnect === true),
      port: s && s.browserConnectPort,
      dataDir: dir,
    });
  } catch {}
}

ipcMain.handle("browser:profileInfo", () => {
  const s = loadSettings();
  const dir = browserTools.profilePath();
  let exists = false;
  try { exists = !!(dir && fs.existsSync(dir)); } catch {}
  return { enabled: s.browserProfile !== false, dir: dir || "", exists };
});
ipcMain.handle("browser:clearProfile", async () => {
  const message = await browserTools.clearProfile();
  return { ok: !/^Не удалось/.test(message), message };
});
// Подключение к своему Chrome по CDP (кнопка в Настройках и инструмент агента).
ipcMain.handle("browser:connect", async (_e, opts) => {
  const message = await browserTools.connect(opts || {});
  return { ok: !/^Ошибка/.test(message), message, info: browserTools.connectInfo() };
});
ipcMain.handle("browser:connectInfo", () => browserTools.connectInfo());

// ─────────────────────────── Почта (SMTP/IMAP) ───────────────────────────
// Настройка подключения и каналы почты живут в src/mail-ipc.js (1.5.75): протокол
// остаётся в чистом src/mail.js, а мост к интерфейсу — рядом с ним. Здесь только
// подключение: mailConfig нужен агентским инструментам mailSend/mailRead.
const { registerMailIpc } = require("./mail-ipc.js");
const { mailConfig } = registerMailIpc({ ipcMain, mail, loadSettings });
// ─────────────────────────── Мобильный доступ (LAN + PWA + PIN) ───────────────────────────
ipcMain.handle("mobile:status", () => mobileBridge.status());
ipcMain.handle("mobile:pinRegen", () => {
  const s = loadSettings();
  s.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  saveSettings(s);
  mobileBridge.applySettings(s);
  return mobileBridge.status();
});

// ─── Дела, миссии и файлы работы агента — код в src/mission-ipc.js ───────────
// Модуль собирается на прежнем месте куска и регистрирует каналы tasks:*,
// mission:* и agentfiles:*. Хранилища передаются напрямую, а живое значение —
// мостом live: missionClaim переписывает и модуль («▶ Продолжить», удаление), и
// прогон агента (отбор миссии), поэтому нужны и чтение, и запись.
const { registerMissionIpc } = require("./mission-ipc.js");
registerMissionIpc({
  ipcMain,
  fs,
  shell,
  agentStore,
  missionStore,
  loadSettings,
  agentWorkDir,
  userDataDir,
  emitTasksChanged,
  armTaskWake,
  live: {
    missionClaim: () => missionClaim,
    setMissionClaim: (v) => { missionClaim = v; },
  },
});

// ─────────────────────────── Проекты (до 10, переключение) ───────────────────────────
// Возвращает список проектов (свежие сверху) и id активного.
ipcMain.handle("projects:list", () => {
  const s = loadSettings();
  const list = (Array.isArray(s.projects) ? s.projects : [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      exists: !!(p.dir && fs.existsSync(p.dir)),
      lastOpened: p.lastOpened || 0,
    }))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  return { ok: true, projects: list, activeId: s.activeProjectId || "" };
});

// Создаёт проект: имя + папка (если не указана — ~/Имя). Становится активным. Максимум 10.
ipcMain.handle("projects:create", async (_e, name, dir) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  if (list.length >= 10) return { ok: false, error: "Достигнут лимит: максимум 10 проектов. Удали один из списка (🗑 — папка не удаляется)." };
  const nm = String(name || "").trim();
  if (!nm) return { ok: false, error: "Введи название проекта." };
  if (nm.length > 60) return { ok: false, error: "Название слишком длинное (до 60 символов)." };
  const safe = nm.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "Проект";
  const target = (typeof dir === "string" && dir.trim()) ? dir.trim() : path.join(os.homedir(), safe);
  const prep = ensureWritableDir(target);
  if (!prep.ok) return prep;
  const abs = prep.dir;
  const dup = list.find((p) => p.dir && path.resolve(p.dir) === abs);
  if (dup) return { ok: false, error: "Эта папка уже используется проектом «" + dup.name + "»." };
  const id = "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { id, name: nm, dir: abs, createdAt: Date.now(), lastOpened: Date.now() };
  const merged = { ...s, projects: [...list, entry], activeProjectId: id, workingDir: abs, githubRepoDir: "" };
  saveSettings(merged);
  lastAgentRepoDir = null; // рабочая папка сменилась — сбрасываем «активный репозиторий»
  return { ok: true, project: entry };
});

// Переключает активный проект: его папка становится workingDir.
ipcMain.handle("projects:activate", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, error: "Проект не найден." };
  if (!p.dir || !fs.existsSync(p.dir)) {
    return { ok: false, error: "Папка проекта больше не существует: " + (p.dir || "?") + " — убери проект из списка (🗑) и создай заново." };
  }
  p.lastOpened = Date.now();
  const merged = { ...s, projects: list, activeProjectId: id, workingDir: p.dir, githubRepoDir: "" };
  saveSettings(merged);
  lastAgentRepoDir = null;
  clonedRepoPending = false; // флаг «только что склонирован» не переносится между проектами
  activeRunUndo = []; // undo-снимки предыдущего проекта не применяются в новом
  return { ok: true, project: p };
});

// Убирает проект из списка (папка на диске НЕ удаляется).
ipcMain.handle("projects:remove", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const rest = list.filter((p) => p.id !== id);
  if (rest.length === list.length) return { ok: false, error: "Проект не найден." };
  let activeId = s.activeProjectId;
  const merged0 = { ...s, projects: rest };
  if (activeId === id) {
    const next = [...rest].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0];
    if (next) {
      activeId = next.id;
      merged0.workingDir = next.dir;
    } else {
      activeId = "";
      merged0.workingDir = s.workingDir; // текущая папка не выдёргивается, просто список пуст
    }
  }
  const merged = { ...merged0, activeProjectId: activeId };
  if (!activeId) merged.githubRepoDir = "";
  saveSettings(merged);
  if (!activeId) lastAgentRepoDir = null;
  return { ok: true, activeId };
});

ipcMain.handle("term:start", () => termStart(agentWorkDir(loadSettings())));
ipcMain.handle("term:input", (_e, text) => termInput(text));
ipcMain.handle("term:stop", () => termStop());
ipcMain.handle("term:status", () => termStatus());
ipcMain.handle("term:complete", (_e, line) => termComplete(line));

// ─────────────────────────── Быстрый запуск проекта (превью) ───────────────────────────
// Пользователь сам запускает dev-сервер проекта и останавливает его (освобождая порт).
let devRun = null; // { rec, command, cwd }

function devEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("dev:event", ev);
}

// Автоопределение команды запуска по package.json проекта.
function detectDevCommand(dir) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {}
  const scripts = (pkg && pkg.scripts) || {};
  const hasBun =
    fs.existsSync(path.join(dir, "bun.lockb")) ||
    fs.existsSync(path.join(dir, "bun.lock")) ||
    fs.existsSync(path.join(dir, "bunfig.toml"));
  if (scripts.dev) return hasBun ? "bun run dev" : "npm run dev";
  if (scripts.start) return hasBun ? "bun run start" : "npm start";
  if (scripts.serve) return "npm run serve";
  return "";
}

function devStart(dir, command) {
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  if (!d || !fs.existsSync(d)) return { ok: false, error: "Папка проекта не найдена" };
  if (devRun && devRun.rec && !devRun.rec.exited) {
    return { ok: false, error: "Проект уже запущен — сначала останови его (⏹)." };
  }
  const cmd = String(command || "").trim() || detectDevCommand(d);
  if (!cmd) return { ok: false, error: "Не найден скрипт запуска (dev/start в package.json). Укажи команду вручную." };
  let rec;
  try {
    rec = bgSpawn(cmd, { cwd: d, name: "dev:" + cmd.slice(0, 50) });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  devRun = { rec, command: cmd, cwd: d };
  const push = (chunk) => devEmit({ type: "out", text: stripAnsi(chunk.toString()) });
  rec.child.stdout.on("data", push);
  rec.child.stderr.on("data", push);
  rec.child.on("exit", (code) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code });
  });
  rec.child.on("error", (e) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code: null, error: e.message });
  });
  devEmit({ type: "start", command: cmd, cwd: d });
  return { ok: true, command: cmd, cwd: d };
}

async function devStop() {
  const stopped = [];
  if (devRun && devRun.rec && !devRun.rec.exited) {
    const rec = devRun.rec;
    devRun = null;
    bgKill(rec);
    stopped.push(rec.name || rec.command);
  }
  // Порт тоже освобождаем: процесс мог быть запущен агентом (startBackground /
  // runCommandOutput для сервера) или остаться сиротой от прошлого запуска.
  const port = parsePortFromUrl(loadSettings().previewUrl);
  if (port) {
    const r = await killProcessesOnPort(port);
    if (r && r.ok && r.killed && r.killed.length) stopped.push("порт " + port + " (PID " + r.killed.join(", ") + ")");
  }
  if (!stopped.length) return { ok: false, error: "Проект не запущен (процесс и порт свободны)" };
  devEmit({ type: "stopped" });
  return { ok: true, stopped };
}

function devStatus(dir) {
  if (devRun && devRun.rec && devRun.rec.exited) devRun = null;
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  return {
    ok: true,
    running: !!(devRun && devRun.rec && !devRun.rec.exited),
    command: devRun ? devRun.command : "",
    cwd: devRun ? devRun.cwd : "",
    detected: d && fs.existsSync(d) ? detectDevCommand(d) : "",
  };
}

ipcMain.handle("dev:start", (_e, dir, command) => devStart(dir, command));
ipcMain.handle("dev:stop", () => devStop());
ipcMain.handle("dev:status", (_e, dir) => devStatus(dir));

// Локальный self-update (OTA): статус, проверка, откат, открыть папку
ipcMain.handle("ota:status", () => ota.status(loadSettings()));
ipcMain.handle("ota:check", async () => {
  try {
    return await ota.check(loadSettings());
  } catch (e) {
    return { status: "error", message: e.message || String(e) };
  }
});
ipcMain.handle("ota:rollback", () => ota.rollback());
ipcMain.handle("ota:openDir", () => ota.openDir());
ipcMain.handle("ota:reset", (_e, removeSource) => ota.reset(!!removeSource, loadSettings()));

ipcMain.handle("chats:load", () => loadChats());
ipcMain.handle("chats:save", (e, d) => {
  saveChats(d);
  notifyChatsSaved(e);
  return true;
});

// История чатов — ОДИН файл на всех клиентов (окно на ПК + телефоны). Раньше, когда
// историю сохранял телефон, окно на ПК продолжало показывать свою копию: ответ,
// написанный с телефона, появлялся на ПК только после перезапуска окна.
// Просим остальные клиенты перечитать файл; тому, кто сохранил, сигнал не шлём.
// Клиент мобильного моста приходит с фиктивным sender (id = 0) — это и есть «не ПК».
function notifyChatsSaved(e) {
  try {
    const senderId = e && e.sender && typeof e.sender.id === "number" ? e.sender.id : 0;
    if (senderId && mainWindow && senderId === mainWindow.webContents.id) return;
    if (mainWindow) mainWindow.webContents.send("chats:reload", { at: Date.now() });
  } catch {}
}

// Синхронное сохранение при закрытии окна: renderer успевает записать данные на диск.
ipcMain.on("chats:saveSync", (e, d) => {
  try { saveChats(d); } catch {}
  e.returnValue = true;
});

ipcMain.handle("ai:send", async (e, messages, opts) => {
  const settings = loadSettings();
  activeRunOrigin = e && e.sender && e.sender.id ? "desktop" : "mobile";
  activeRunRole = String((opts && opts.role) || "") || activeRunRole;
  activeRunChatId = String((opts && opts.chatId) || "");
  runMissionId = ""; // прогон начинается с чистого листа: миссию выберет missionRead
  global.__agentStopRequested = false;
  global.__agentRunning = true;
  try {
    await runAi(settings, messages || [], mainWindow, opts || {});
    return { ok: true };
  } catch (e) {
    const msg = e.name === "AbortError" ? "⏹ Генерация остановлена" : e.message || String(e);
    // Даже при ошибке изменения файлов, сделанные до неё, должны откатываться
    if (activeRunUndo.length) {
      lastUndoLog = activeRunUndo.slice();
      persistUndo();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ai:event", { type: "undo_available", count: lastUndoLog.length });
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ai:event", { type: "error", message: msg });
    }
    return { ok: false, error: msg };
  } finally {
    global.__agentStopRequested = false;
    global.__agentPauseRequested = false;
    global.__agentRunning = false;
  }
});

// Ответ пользователя на вопрос агента (askUser)
ipcMain.handle("ai:answer", (_e, text) => {
  if (pendingAsk) {
    const r = pendingAsk;
    pendingAsk = null;
    r(text);
    return true;
  }
  return false;
});

// ─── Откат изменений агента (чекпоинт последнего запуска) ───
ipcMain.handle("undo:status", () => {
  loadPersistedUndo(); // чекпоинт мог остаться после перезапуска приложения
  return {
    ok: true,
    count: lastUndoLog.length,
    files: lastUndoLog.map((u) => u.path),
  };
});

ipcMain.handle("undo:rollback", () => {
  loadPersistedUndo();
  const restored = [];
  for (let i = lastUndoLog.length - 1; i >= 0; i--) {
    const u = lastUndoLog[i];
    try {
      if (u.content === null) {
        if (fs.existsSync(u.path)) fs.unlinkSync(u.path); // файл создан агентом — удаляем
      } else {
        fs.writeFileSync(u.path, u.content, "utf8"); // возвращаем прежнее содержимое
      }
      restored.push(u.path);
    } catch (e) {
      restored.push(u.path + " (ошибка: " + (e.message || String(e)) + ")");
    }
  }
  const count = restored.length;
  lastUndoLog = [];
  activeRunUndo = [];
  try { fs.unlinkSync(undoFile()); } catch {} // чекпоинт израсходован
  return { ok: true, count, restored };
});

ipcMain.handle("ai:stop", () => {
  global.__agentStopRequested = true;
  if (activeAbort) activeAbort.abort();
  if (pendingAsk) {
    const r = pendingAsk;
    pendingAsk = null;
    r("");
  }
  return true;
});

ipcMain.handle("ai:test", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  try {
    const models = await fetchModels(s);
    return { ok: true, message: "Подключено! Найдено моделей: " + models.length, models };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});

// ── Модели, замер локальной модели и G4F — код в src/model-ipc.js ──
// Модуль собран на прежнем месте куска и регистрирует каналы g4f:probe, g4f:test,
// ai:models и ai:probeLocal. Живого состояния у него нет: настройки читаются в момент
// вызова, а помощники ядра и список моделей переданы значениями.
const { registerModelIpc } = require("./model-ipc.js");
registerModelIpc({
  ipcMain,
  loadSettings,
  normalizeSettings,
  fetchModels,
  SYSTEM_PROMPT,
  ROUTER_MAX_TOKENS,
  estimateTokens,
  contextBudget,
  windowBudget,
  modelWindow,
  ollamaNumCtx,
  isLocalEndpoint,
  probeLocalModel,
});

ipcMain.handle("dialog:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Выберите рабочую директорию",
  });
  return r.canceled ? null : r.filePaths[0];
});

// ─────────────────────────── GitHub OAuth (device flow) + repo picker ───────────────────────────
/** Гарантирует, что папка существует и доступна на запись (клонирование, создание файлов).
 *  Возвращает { ok:true, dir } или { ok:false, error } с понятной подсказкой. */
function ensureWritableDir(dir) {
  const abs = dir && typeof dir === "string" && dir.trim() ? path.resolve(String(dir).trim()) : "";
  if (!abs) return { ok: false, error: "Не указана рабочая директория — выбери её в Настройках → Проект (📁) или в панели проекта." };
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (e) {
    return { ok: false, error: "Не удалось создать папку: " + abs + " — " + (e.message || String(e)) };
  }
  try {
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (e) {
    return {
      ok: false,
      error: "Нет прав на запись в папку: " + abs + " (Permission denied). " +
        "Клонирование и создание файлов в ней невозможны — выбери другую рабочую директорию " +
        "(📁 в панели проекта или Настройки → Проект): обычную папку на диске, а не защищённую системную.",
    };
  }
  // Реальная проверка записи: git падает с «could not create work tree dir ... Permission denied»,
  // даже когда accessSync(W_OK) проходит (OneDrive Files On-Demand, защищённые/сетевые/системные папки).
  // Поэтому создаём и удаляем временную подпапку — точно как это сделает git при клонировании.
  const probe = path.join(abs, ".ai-agent-write-test");
  try {
    fs.mkdirSync(probe);
  } catch (e) {
    if (e.code !== "EEXIST") {
      return {
        ok: false,
        error: "В папке нет прав на запись — git не сможет создать тут репозиторий: " + abs + " (" + (e.message || String(e)) + "). " +
          "Выбери другую рабочую директорию (📁 в панели проекта): обычную локальную папку на диске " +
          "(например, C:\\Users\\<имя>\\projects) — не системную, не сетевую и не синхронизируемую OneDrive.",
      };
    }
  }
  try {
    fs.rmdirSync(probe);
  } catch {}
  return { ok: true, dir: abs };
}

// ── GitHub: каналы и клонирование — код в src/github-ipc.js ──
// Модуль собран на прежнем месте куска и отдаёт наружу клон-помощники: их же
// берут агентские инструменты (gitClone). Живые значения (окно и два флага
// репозитория) переданы мостом live — окно создаётся позже, а флаги меняет
// не только этот модуль.
const { registerGithubIpc } = require("./github-ipc.js");
const githubIpc = registerGithubIpc({
  ipcMain,
  fs,
  path,
  os,
  app,
  loadSettings,
  saveSettings,
  withCapability,
  agentWorkDir,
  ensureWritableDir,
  runGit,
  repoNameFromUrl,
  sanitizeDir,
  stageAllSafe,
  stripUrlCreds,
  live: {
    window: () => mainWindow,
    lastAgentRepoDir: () => lastAgentRepoDir,
    setLastAgentRepoDir: (v) => { lastAgentRepoDir = v; },
    clonedRepoPending: () => clonedRepoPending,
    setClonedRepoPending: (v) => { clonedRepoPending = v; },
  },
});

// ─────────────────────────── Yandex Cloud (REST API) ───────────────────────────
// Служебный слой и IPC-мост вынесены отдельными модулями (1.5.74): знание про
// YC API живёт в src/yc-service.js, каналы «yc:*» — в src/yc-ipc.js. Здесь
// остаётся только подключение, поэтому агентские инструменты и деплой видят те
// же имена, что и раньше, и работают без изменений.
const { createYcService } = require("./yc-service.js");
const { registerYcIpc } = require("./yc-ipc.js");
const ycService = createYcService({ app, path, net, secrets, yandexCloud, ycCli, ycLogs, ycEnsurePath, loadSettings });
const {
  ycConfig,
  ycRequireAuth,
  ycFindContainerByRef,
  ycActiveRevision,
  ycJsonArg,
  ycRevisionLine,
  ycRevisionDetails,
  readYcLogsText,
  ycCliStatus,
  ycCliInstall,
} = ycService;
registerYcIpc({ ipcMain, yandexCloud, ycConsole, ycCosts, loadSettings, saveSettings, svc: ycService });

// ── 🧠 Память диалогов: локальный дневник сжатых памяток (папка по датам) ──────
ipcMain.handle("memory:stats", () => {
  const s = loadSettings();
  const st = agentStore.contextMemoryStats(app.getPath("userData"));
  return {
    ...st,
    enabled: !!s.contextMemory,
    keepDays: Number(s.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
  };
});

ipcMain.handle("memory:days", () => {
  const s = loadSettings();
  if (!s.contextMemory) return { ok: false, error: "Память диалогов выключена." };
  const days = agentStore.contextMemoryDays(app.getPath("userData"));
  return { ok: true, days, dir: agentStore.contextMemoryDir(app.getPath("userData")) };
});

ipcMain.handle("memory:openDir", async () => {
  const dir = agentStore.contextMemoryDir(app.getPath("userData"));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const err = await shell.openPath(dir);
  return { ok: !err, dir, error: err || "" };
});

ipcMain.handle("memory:clear", (_e, date) => {
  const d = String(date || "").trim();
  const r = agentStore.contextMemoryClear(app.getPath("userData"), d);
  return {
    ...r,
    message: r.ok
      ? "Удалено дней: " + r.removedDays + ", памяток: " + r.removedMemos + "."
      : "Ошибка: " + r.error,
  };
});

// ───────────────────── Деплой: рецепты, состояние, конвейер ─────────────────────
// Мост деплоя вынесен в src/deploy-ipc.js (1.5.75): конвейер остаётся чистым в
// deploy-engine.js, а здесь — подключение и две функции, которые нужны агентским
// инструментам: сам запуск (ycDeploy) и сводка состояния облака проекта.
const { registerDeployIpc } = require("./deploy-ipc.js");
const { runCloudDeploy, cloudDeployBrief } = registerDeployIpc({
  ipcMain,
  path,
  fs,
  execFile,
  browserTools,
  cloudState,
  deployRecipes,
  createDeployEngine,
  yandexCloud,
  ycCosts,
  audit,
  commandEnv,
  loadSettings,
  agentWorkDir,
  stripAnsi,
  resolveShell,
  findProgram,
  ycConfig,
  ycRequireAuth,
  getEmit: () => activeEmit,
  getWindow: () => mainWindow,
});
// ─────────────────────────── Файлы (панель проекта) ───────────────────────────
// Каналы файловой панели вынесены в src/fs-ipc.js (1.5.76). Список бинарных
// расширений оттуда же — чтобы не держать вторую копию (её использует агент).
const { registerFsIpc } = require("./fs-ipc.js");
const { BINARY_EXT } = registerFsIpc({ ipcMain, shell, path, fs, sanitizeDir, sanitizePath });
// ─────────────────────────── Git (панель проекта) ───────────────────────────
// Каналы git-панели вынесены в src/git-ipc.js (1.5.76). Состояние агента (папка
// последнего клона и флаг «после клона») остаётся здесь — модуль пишет в него
// сеттерами, поэтому значение не «застывает» на null.
const { registerGitIpc } = require("./git-ipc.js");
registerGitIpc({
  ipcMain,
  path,
  fs,
  loadSettings,
  runGit,
  sanitizeDir,
  cloneRepoTo: githubIpc.cloneRepoTo,
  pickCloneBase: githubIpc.pickCloneBase,
  stageAllSafe,
  setLastAgentRepoDir: (v) => {
    lastAgentRepoDir = v;
  },
  setClonedRepoPending: (v) => {
    clonedRepoPending = v;
  },
});
// ─────────────────────────── Жизненный цикл ───────────────────────────
// ─────────────────────────── Auto Updater ───────────────────────────
// Показываем прогресс в строке заголовка и уведомляем, когда обновление готово.
function initAutoUpdater() {
  autoUpdater.autoDownload = false;           // спросим пользователя перед загрузкой
  autoUpdater.autoInstallOnAppQuit = true;    // установить при закрытии, если уже скачан

  autoUpdater.on("checking-for-update", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent — проверка обновлений…");
  });
  autoUpdater.on("update-available", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("AI Developer Agent — доступно обновление");
      mainWindow.webContents.send("ai:event", { type: "update:available", info });
    }
    // Спрашиваем: скачать?
    new Notification({
      title: "AI Developer Agent",
      body: `Доступна версия ${info.version}. Скачать и установить?`,
    }).show();
    autoUpdater.downloadUpdate().catch((e) => console.error("[updater] download error", e));
  });
  autoUpdater.on("update-not-available", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent");
  });
  autoUpdater.on("download-progress", (p) => {
    const pct = Math.round(p.percent);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.setTitle(`AI Developer Agent — загрузка ${pct}%`);
  });
  autoUpdater.on("update-downloaded", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("AI Developer Agent — обновление готово");
      mainWindow.webContents.send("ai:event", { type: "update:downloaded" });
    }
    new Notification({
      title: "AI Developer Agent",
      body: "Обновление скачано. Применится при следующем перезапуске.",
    }).show();
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater]", e.message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent");
  });

  // Проверка раз в час
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  mobileBridge.applySettings(loadSettings());
  initAutoUpdater();
  // Локальный self-update (OTA): проверка при старте и каждые 60 секунд
  const otaTick = () => {
    ota.check(loadSettings()).catch(() => {});
  };
  setTimeout(otaTick, 5000);
  setInterval(otaTick, 60000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// При выходе — останавливаем все фоновые процессы.
app.on("before-quit", () => {
  browserTools.stop().catch(() => {}); // закрываем окно Chromium агента
  for (const rec of bgProcesses.values()) bgKill(rec);
  bgProcesses.clear();
  termShutdown();
  if (devRun) {
    const rec = devRun.rec;
    devRun = null;
    bgKill(rec);
  }
  mobileBridge.stop();
});

// ─────────────────────── Реестр агентских инструментов ───────────────────────
// Собираем обработчики один раз при загрузке: к этому месту все константы уже
// инициализированы, а функции поднимаются объявлениями. Вызов инструментов идёт
// только после старта приложения, поэтому порядок безопасен.
const agentToolHandlers = createAgentTools({
  shell,
  path,
  fs,
  os,
  net,
  browserTools,
  appUi,
  secrets,
  yandexCloud,
  vault,
  mail,
  ycLogs,
  ota,
  selfDev,
  ycIamEnvToken,
  ycAutoEnv,
  applyAgentEnv,
  loadSettings,
  saveSettings,
  resolvePath,
  runGit,
  envFor, // окружение по назначению: инструментам — своё, а не всё сразу
  agentWorkDir,
  repoNameFromUrl,
  stripUrlCreds,
  normalizeShell,
  resolveShell,
  shellsStatus,
  runTerminalCommand,
  detectPackageManager,
  hasLock,
  summarizeTestOutput,
  unifiedDiff,
  buildFileStructure,
  screenshotUrl,
  saveScreenshotPng,
  bgProcesses,
  bgSpawn,
  bgKill,
  SERVER_CMD_RE,
  waitOutputQuiet,
  bgTail,
  checkUrlStatus,
  listProjectFiles,
  searchProjectFiles,
  snapshotFileForUndo,
  numberedLines,
  langFromExt,
  buildFileOutline,
  buildBlockRanges,
  stageAllSafe,
  guideSafeName,
  guideFilePath,
  guideIndex,
  guideForUrl,
  agentGuideCall,
  termAgentEcho,
  mailConfig,
  // Реестр инструментов работает в своём модуле: всё, что он использует из main.js,
  // приходит сюда аргументами. Пропустить имя здесь — значит получить у пользователя
  // «X is not defined» в конкретном инструменте, поэтому список сверяется разбором.
  // окно и система: скриншот экрана, буфер обмена, установка программ
  app,
  clipboard,
  desktopCapturer,
  execFile,
  // пояс проекта: заметки и дела, индекс кода, откат правок, журнал действий
  agentStore,
  missionStore,
  unifiedPatch,
  codeIndex,
  audit,
  // стоимость облака до создания ресурса
  ycCosts,
  // терминал: запуск процессов, разбор вывода, помощь при коде возврата
  stripAnsi,
  spawnCollect,
  spawnRaw,
  explainExit,
  installSystemPkg,
  downloadFileTo,
  verifyInstaller,
  installerFacts,
  installerGate,
  findInstallersIn,
  downloadAndExtractTo,
  runAsAdmin,
  envPathInfo,
  findProgram,
  runProgVersion,
  psScript,
  cachedPs,
  invalidatePsCache,
  refreshEnvFromOS,
  userDataDir,
  emitTasksChanged,
  // фоновые процессы и снимки экрана
  bgWaitFor,
  encodeShot,
  // откат изменений
  persistUndo,
  loadPersistedUndo,
  // разбор кода
  refactorRenameFiles,
  findSymbolReferences,
  // вспомогательная модель и поиск
  auxConfig,
  describeImageRemote,
  generateImageRemote,
  webSearch,
  webFetchPage,
  fmtError,
  truncateText,
  searchTools,
  // планирование и системные сведения
  normalizePlanTasks,
  planSummary,
  parseProcessesCsv,
  parseSysInfoJson,
  registryPathAllowed,
  // облако: конфигурация, контейнеры, ревизии, логи
  ycConfig,
  ycFindContainerByRef,
  ycActiveRevision,
  ycJsonArg,
  ycRevisionLine,
  ycRevisionDetails,
  readYcLogsText,
  ycCliStatus,
  ycCliInstall,
  runCloudDeploy,
  cloudDeployBrief,
  live: {
    agentEnv: () => agentEnv,
    userAgentEnv: () => userAgentEnv,
    // Что и кому выдано — envList показывает это честно, чтобы агент не искал
    // переменную, которой у него нет.
    scopeSummary: (name) => toolPolicy.scopeSummary(agentEnvScopes, name),
    lastAgentRepoDir: () => lastAgentRepoDir,
    setLastAgentRepoDir: (v) => {
      lastAgentRepoDir = v;
    },
    clonedRepoPending: () => clonedRepoPending,
    setClonedRepoPending: (v) => {
      clonedRepoPending = v;
    },
    activeEmit: () => activeEmit,
    activeToolRouter: () => activeToolRouter,
    // Роль и чат текущего прогона: инструменты миссий записывают их в mission.json,
    // чтобы панель «Миссия» знала, к какой работе относится журнал.
    activeRunRole: () => activeRunRole,
    activeRunChatId: () => activeRunChatId,
    // Миссия текущего прогона: инструменты без id отмечают и закрывают именно её.
    activeRunMissionId: () => runMissionId,
    mainWindow: () => mainWindow,
    // Откат правок и сводка плана: инструменты их не только читают, но и меняют —
    // поэтому запись идёт через сеттер, а не копией значения.
    activeRunUndo: () => activeRunUndo,
    setActiveRunUndo: (v) => {
      activeRunUndo = v;
    },
    lastUndoLog: () => lastUndoLog,
    setLastUndoLog: (v) => {
      lastUndoLog = v;
    },
    activePlanSummary: () => activePlanSummary,
    setActivePlanSummary: (v) => {
      activePlanSummary = v;
    },
  },
});

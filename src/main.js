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
const { createRunStrict } = require("./run-strict.js"); // строгая очередь вызовов: подтверждения, чекпоинт, аудит, журнал миссии
const { createRunBatch } = require("./run-batch.js"); // решения после раунда: пустой отчёт, граница батча, закрытие работы
const { createRunNudge } = require("./run-nudge.js"); // призывы по текстовому ответу: план не закрыт, сторож миссии
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

// ─────────────────────── Окружение агента и назначения ───────────────────────
// Раздел вынесен в src/agent-env.js (часть 22): переменные окружения агента,
// автоматические YC_* со свежим IAM, правила выдачи по назначению и окружение
// команды (команда-дамп секретов не получает). Состояние живёт в модуле, поэтому
// наружу берём чтение (getAgentEnv/getScopes/getCapability) и постановку
// назначения (setCapability) — копия «застыла» бы на пустом объекте, и команды
// остались бы без токенов и PATH.
// ycConfig создаётся служебным слоем облака ниже по файлу, envPathInfo/setMergedPath —
// системным разделом: модуль читает их в момент вызова, поэтому к моменту сборки
// они ещё не объявлены, и это нормально.
const { createAgentEnv } = require("./agent-env.js");
const agentEnvState = createAgentEnv({
  toolPolicy,
  audit,
  app,
  path,
  yandexCloud,
  ycCli,
  live: {
    getYcConfig: () => ycConfig,
    envPathInfo: () => envPathInfo(), // результат, а не функция: модуль зовёт её сам
    setMergedPath: (before, extra) => setMergedPath(before, extra),
  },
});
const {
  activeCapability,
  withCapability,
  getAgentEnv,
  getUserAgentEnv,
  getScopes,
  getCapability,
  setCapability,
  pathOnlyEnv,
  envFor,
  commandEnv,
  probeEnv,
  ycIamEnvToken,
  ycAutoEnv,
  rebuildAgentEnv,
  ycIamSync,
  ycEnsurePath,
  applyAgentEnv,
} = agentEnvState;

// ──────────────────────── Браузер агента: настройки и каналы ────────────────────────
// Раздел вынесен в src/browser-ipc.js (часть 26): единая точка применения браузерных
// настроек и каналы browser:* для окна и телефона. Сборка стоит ВЫШЕ хранилища
// настроек, потому что хранилище берёт applyBrowserSettings себе. Чтение настроек
// идёт мостом live: хранилище собирается ниже, и прямой вызов до его сборки упал бы
// на «cannot access before initialization», оборвав загрузку всего бэкенда.
const { registerBrowserIpc } = require("./browser-ipc.js");
const { applyBrowserSettings } = registerBrowserIpc({
  ipcMain,
  app,
  fs,
  path,
  browserTools,
  live: { loadSettings: () => loadSettings() },
});

// ─────────────────────────── Настройки ───────────────────────────
// ── Настройки, подключения и история чатов — код в src/settings-store.js ──
// Модуль собран на прежнем месте куска, и имена те же: вызовы ниже (loadSettings,
// saveSettings, loadChats…) дословно прежние — берём их деструктуризацией.
// Применение настроек к живым подсистемам: окружение агента в src/agent-env.js,
// профиль браузера — в src/browser-ipc.js, журнал остаётся здесь объявлением
// функции — подъём работает.
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
    agentEnv: getAgentEnv,
    activeToolCapability: getCapability,
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

// ── Оболочки и запуск команд — код в src/shell-tools.js ──
// Имена те же: инструменты, фоновые процессы, терминал и САММАРИ проекта зовут
// их дословно. findProgram приходит стрелкой: системный раздел (system-stack.js)
// собирается НИЖЕ по файлу, а оболочки нужны уже здесь — их берут tool-helpers,
// фоновые процессы и обзор проекта.
const { createShellTools } = require("./shell-tools.js");
const { stripAnsi, shellArgsFor, normalizeShell, powershellArgs, findGitShell, shellMissingHint,
  resolveShell, shellsStatus, shellsBrief, runTerminalCommand } = createShellTools({
  fs,
  path,
  execFile,
  commandEnv,
  findProgram: (name) => findProgram(name),
  truncateText,
});
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
// Оттуда же — чтение файлов инструментами: нумерация строк, язык, карта
// определений (fileOutline) и диапазоны блоков (searchFile blocks).
const { createProjectAnalysis } = require("./project-analysis.js");
const { projectSourceFiles, buildFileStructure, refactorRenameFiles, findSymbolReferences, argsPathIsFile, escRe,
  numberedLines, langFromExt, buildFileOutline, buildBlockRanges } = createProjectAnalysis({ fs, path });


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


// ─────────────────────── Визитка проекта для системного промпта ───────────────────────
// Раздел вынесен в src/project-brief.js (часть 27): имя и скрипты package.json,
// двухуровневая структура (без node_modules и прочего мусора), начало README,
// доступные оболочки и строка Yandex Cloud. Визитка собирается на КАЖДЫЙ прогон
// (настройки приходят функцией), поэтому сборка модуля стоит выше проводки прогона,
// а считают оболочки и строку облака по-прежнему в main.js — они приходят значениями.
const { createProjectBrief } = require("./project-brief.js");
const { buildProjectBrief } = createProjectBrief({
  fs,
  path,
  SKIP_DIRS,
  shellsBrief,
  loadSettings,
  ycBriefLine,
});

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
      return getAgentEnv();
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

// git add -A, но БЕЗ файлов секретов — код в src/git-stage.js (часть 28).
// Имена те же: их зовут инструмент gitCommit (agent-tools), публикация и «Изменения»
// (git-ipc, github-ipc) и авто-чекпоинт прогона (run-ai) — дословно. Сборка стоит на
// прежнем месте куска и ВЫШЕ всех потребителей: проводки панелей и прогона читают эти
// имена значениями, поэтому отложенная стрелка здесь была бы подменой вызова.
const { createGitStage } = require("./git-stage.js");
const { stageAllSafe, autoCheckpointCommit } = createGitStage({
  fs,
  runGit,
  agentWorkDir,
});

// ── Дела: зеркало, напоминания и точный будильник — код в src/tasks-reminders.js ──
// Имена те же: панели, инструменты, миссия и окно зовут их дословно. Окно приходит
// функцией — оно создаётся позже сборки модуля и может быть закрыто; сборка стоит
// ВЫШЕ справочников, потому что site-guides получает userDataDir значением.
const { createTasksReminders } = require("./tasks-reminders.js");
const { userDataDir, emitTasksChanged, canNotify, notifyUser, armTaskWake,
  checkTaskReminders } = createTasksReminders({
  app,
  Notification,
  agentStore,
  missionStore,
  loadSettings,
  agentWorkDir,
  getWindow: () => mainWindow,
});
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

// ── Реестр агентских инструментов и вызов инструмента — код в src/tool-registry.js ──
// Модуль берём ЗДЕСЬ, а собираем ниже (в конце файла): его обработчики живут всем,
// что построено в оболочке, а прогону уже сейчас нужны описание аргументов
// (describeToolArgs) и сам вызов инструмента. Поэтому require стоит до прогона, а
// createToolRegistry({...}) — после всей сборки; executeTool уходит прогону
// отложенной стрелкой, как termEmit у панели терминала.
const { createToolRegistry, describeToolArgs } = require("./tool-registry.js");

// ── Прогон агента: цикл раундов, миссия и восстановление — код в src/run-ai.js ──
// Модули частей 14–20 (миссия, роутер, повтор, раунд, вызовы, строгая очередь, батч,
// призывы) прогон собирает сам — они переданы ему готовыми.
// Живые значения (откат и журнал отката, ответ на askUser, признак клона, выбранная
// миссия, окно) уходят мостом live: их пишут и другие части оболочки, а копия
// застыла бы на первом значении — тосты уходили бы в закрытое окно.
const { createRunAi } = require("./run-ai.js");
const { runAi } = createRunAi({
  Notification,
  PARALLEL_SAFE_TOOLS,
  PLAN_MODE_TOOL_DEFINITIONS,
  SYSTEM_PROMPT,
  UNAVAILABLE_MAX,
  agentStore,
  agentWorkDir,
  audit,
  autoCheckpointCommit,
  auxConfig,
  buildChatRequest,
  buildProjectBrief,
  classifyKeyError,
  coldCacheInfo,
  consumeProviderStream,
  contextBudget,
  createContextManager,
  createRunBatch,
  createRunCalls,
  createRunMission,
  createRunNudge,
  createRunRetry,
  createRunRound,
  createRunStrict,
  createRunTools,
  createThinkingStripper,
  describeImageRemote,
  describeToolArgs,
  estimateTokens,
  // Сам вызов инструмента собирается НИЖЕ (весь реестр — в конце файла), поэтому
  // уходит отложенной стрелкой: к первому вызову прогона он уже готов.
  executeTool: (...toolArgs) => executeTool(...toolArgs),
  extractToolCallsFromText,
  fmtError,
  friendlyRateLimitError,
  genCallId,
  groupOfTool,
  guideReadText,
  isLocalEndpoint,
  missionGuard,
  missionStore,
  modelWindow,
  normalizeToolName,
  ollamaModelInfo,
  ollamaNumCtx,
  persistUndo,
  rateLimitInfo,
  rateLimiterFor,
  readApiError,
  resolvePath,
  rolePlan,
  routeTools,
  routerMaxTokens,
  routerTaskText,
  sanitizeToolPairs,
  saveContextMemo,
  saveSettings,
  snapshotFileForUndo,
  switchOpenaiProfile,
  // Панель терминала собирается НИЖЕ прогона — передаём с отложенным чтением:
  // к первому вызову прогона она уже готова, и значение по-прежнему одно на всё приложение.
  termEmit: (...termArgs) => termEmit(...termArgs),
  toolPolicy,
  toolsAsText,
  truncateText,
  userDataDir,
  windowBudget,
  live: {
    get activeAbort() { return activeAbort; },
    set activeAbort(v) { activeAbort = v; },
    get activeEmit() { return activeEmit; },
    set activeEmit(v) { activeEmit = v; },
    get activePlanSummary() { return activePlanSummary; },
    set activePlanSummary(v) { activePlanSummary = v; },
    get activeToolRouter() { return activeToolRouter; },
    set activeToolRouter(v) { activeToolRouter = v; },
    get activeRunUndo() { return activeRunUndo; },
    set activeRunUndo(v) { activeRunUndo = v; },
    get lastUndoLog() { return lastUndoLog; },
    set lastUndoLog(v) { lastUndoLog = v; },
    get activeRunChatId() { return activeRunChatId; },
    get activeRunOrigin() { return activeRunOrigin; },
    get lastAgentRepoDir() { return lastAgentRepoDir; },
    get mainWindow() { return mainWindow; },
    get pendingAsk() { return pendingAsk; },
    set pendingAsk(v) { pendingAsk = v; },
    get clonedRepoPending() { return clonedRepoPending; },
    set clonedRepoPending(v) { clonedRepoPending = v; },
    get missionClaim() { return missionClaim; },
    set missionClaim(v) { missionClaim = v; },
    get runMissionId() { return runMissionId; },
    set runMissionId(v) { runMissionId = v; },
    // Модуль миссии зовёт это значение missionId — тот же живой runMissionId.
    get missionId() { return runMissionId; },
    set missionId(v) { runMissionId = v; },
  },
});


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
const { termEmit, termAgentEcho, termStart, termInput, termStop, termStatus, termShutdown, termComplete, registerTermIpc } = createTerminalPanel({
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
// ── Каналы панели терминала (term:start/input/stop/status/complete) ──
// Раньше стояли в main.js (часть 32). Рабочую папку и настройки модуль уже получил
// сборкой выше, и терминал читает папку в МОМЕНТ запуска — проект мог переключиться,
// пока панель была закрыта.
registerTermIpc(ipcMain);

// ─────────────────────────── IPC ───────────────────────────
// ── Настройки и группы выдачи — код в src/settings-ipc.js ──
// Каналы settings:get, settings:set и policy:groups — код в src/settings-ipc.js
// (часть 30). Сборка стоит на прежнем месте куска: всё, что модулю нужно (хранилище
// настроек, применение к окружению и браузеру, мобильный мост, политика) объявлено
// ВЫШЕ, поэтому стрелок в проводке нет. Живое здесь одно: смена рабочей папки
// сбрасывает «активный репозиторий» — переменная принадлежит оболочке, поэтому
// уходит сеттером моста live (копия «застыла» бы, и агент остался бы в старой папке).
const { registerSettingsIpc } = require("./settings-ipc.js");
registerSettingsIpc({
  ipcMain,
  loadSettings,
  saveSettings,
  normalizeSettings,
  applyAgentEnv,
  applyBrowserSettings,
  mobileBridge,
  toolPolicy,
  // dialog:pickDir — выбор рабочей папки в системном диалоге. Родитель — окно
  // приложения: спрашиваем его в момент вызова, оно могло быть закрыто или пересоздано.
  dialog,
  getWindow: () => mainWindow,
  live: {
    setLastAgentRepoDir: (v) => {
      lastAgentRepoDir = v;
    },
  },
});

// ─────────────────────────── Почта (SMTP/IMAP) ───────────────────────────
// Настройка подключения и каналы почты живут в src/mail-ipc.js (1.5.75): протокол
// остаётся в чистом src/mail.js, а мост к интерфейсу — рядом с ним. Здесь только
// подключение: mailConfig нужен агентским инструментам mailSend/mailRead.
const { registerMailIpc } = require("./mail-ipc.js");
const { mailConfig } = registerMailIpc({ ipcMain, mail, loadSettings });
// ─────────────────────────── Мобильный доступ (LAN + PWA + PIN) ───────────────────────────
// Каналы панели (mobile:status, mobile:pinRegen) — код в src/mobile-ipc.js (часть 30).
// Смена PIN обязана быть применена к ЖИВОМУ мосту: иначе окно показало бы новый PIN,
// а телефон остался бы подключён по старому — и «сменить PIN» молча ничего не менял.
const { registerMobileIpc } = require("./mobile-ipc.js");
registerMobileIpc({ ipcMain, mobileBridge, loadSettings, saveSettings });

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
// Каналы projects:list/create/activate/remove — код в src/projects-ipc.js (часть 31).
// Переключение проекта сбрасывает три живых значения оболочки: папку последнего клона,
// флаг «только что склонирован» и снимки отката — их читают пути-и-git, GitHub-каналы,
// прогон и инструменты, поэтому в модуль уходят СЕТТЕРЫ моста live (копия «застыла» бы,
// и агент остался бы в папке прошлого проекта). ensureWritableDir объявлен ниже обычной
// функцией — подъём работает, и к моменту вызова канал его видит.
const { registerProjectsIpc } = require("./projects-ipc.js");
registerProjectsIpc({
  ipcMain,
  fs,
  path,
  os,
  loadSettings,
  saveSettings,
  ensureWritableDir,
  live: {
    setLastAgentRepoDir: (v) => {
      lastAgentRepoDir = v;
    },
    setClonedRepoPending: (v) => {
      clonedRepoPending = v;
    },
    setActiveRunUndo: (v) => {
      activeRunUndo = v;
    },
  },
});

// ─────────────────────────── Быстрый запуск проекта (превью) ───────────────────────────
// Запуск dev-сервера проекта, остановка с освобождением порта, статус и автоопределение
// команды — код в src/preview-ipc.js (часть 31); каналы dev:start/stop/status регистрирует
// он сам. Состояние запуска (devRun) переехало внутрь модуля: снаружи его читала только
// остановка при выходе приложения, и она теперь зовёт devShutdown(). Окно приходит
// функцией — оно создаётся позже сборки модуля и может быть пересоздано.
const { registerPreviewIpc } = require("./preview-ipc.js");
const { devShutdown } = registerPreviewIpc({
  ipcMain,
  fs,
  path,
  loadSettings,
  sanitizeDir,
  agentWorkDir,
  bgSpawn,
  bgKill,
  stripAnsi,
  parsePortFromUrl,
  killProcessesOnPort,
  getWindow: () => mainWindow,
});

// ─────────────────────────── Самообновление: каналы OTA и штатный апдейтер ───────────────────────────
// OTA-каналы и подписка electron-updater — код в src/ota-ipc.js (часть 32). Сам
// локальный self-update — в src/ota.js. Настройки модуль читает в момент вызова:
// в них лежит выключатель self-update, и снимок «застыл» бы на прежнем значении.
const { registerOtaIpc, initAutoUpdater } = require("./ota-ipc.js");
registerOtaIpc({ ipcMain, ota, loadSettings });

const { registerChatsIpc } = require("./chats-ipc.js"); // история чатов: каналы и сигнал «перечитай файл»
registerChatsIpc({ ipcMain, loadChats, saveChats, getWindow: () => mainWindow });

// ────────────────── Прогон агента и откат правок ──────────────────
// Каналы ai:send / ai:answer / ai:stop / ai:test и undo:status / undo:rollback —
// код в src/run-ipc.js (часть 34). Живого состояния у них много, и оно общее с
// другими частями оболочки: источник и роль прогона, чат и миссия, снимки отката и
// журнал, ожидание ответа askUser, прерывание запроса и окно. Всё это уходит мостом
// live (чтение И запись) — копия «застыла» бы: прогон с телефона пометился бы как
// «с ПК», события уехали бы не в тот чат, а «Откатить» не нашёл бы ни одной правки.
// Помощники (runAi, хранилище отката, настройки и список моделей) — значениями.
const { registerRunIpc } = require("./run-ipc.js");
registerRunIpc({
  ipcMain,
  fs,
  loadSettings,
  normalizeSettings,
  fetchModels,
  runAi,
  persistUndo,
  loadPersistedUndo,
  undoFile,
  live: {
    get mainWindow() { return mainWindow; },
    get activeAbort() { return activeAbort; },
    get activeRunOrigin() { return activeRunOrigin; },
    set activeRunOrigin(v) { activeRunOrigin = v; },
    get activeRunRole() { return activeRunRole; },
    set activeRunRole(v) { activeRunRole = v; },
    set activeRunChatId(v) { activeRunChatId = v; },
    set runMissionId(v) { runMissionId = v; },
    get activeRunUndo() { return activeRunUndo; },
    set activeRunUndo(v) { activeRunUndo = v; },
    get lastUndoLog() { return lastUndoLog; },
    set lastUndoLog(v) { lastUndoLog = v; },
    get pendingAsk() { return pendingAsk; },
    set pendingAsk(v) { pendingAsk = v; },
  },
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

const { registerMemoryIpc } = require("./memory-ipc.js"); // память диалогов: каналы дневника памяток
registerMemoryIpc({ ipcMain, app, fs, shell, agentStore, loadSettings });

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
app.whenReady().then(() => {
  createWindow();
  mobileBridge.applySettings(loadSettings());
  // Штатный апдейтер сборки: подписка и проверка по таймеру — код в src/ota-ipc.js.
  initAutoUpdater({ autoUpdater, Notification, getWindow: () => mainWindow });
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
  devShutdown(); // превью (dev-сервер проекта) — состояние и остановка в src/preview-ipc.js
  mobileBridge.stop();
});

// ─────────────────────── Реестр агентских инструментов ───────────────────────
// Собираем обработчики один раз при загрузке: к этому месту все константы уже
// инициализированы, а функции поднимаются объявлениями. Вызов инструментов идёт
// только после старта приложения, поэтому порядок безопасен.
// Весь список имён уходит в src/tool-registry.js тем же плоским объектом, что и
// раньше: модуль сам передаёт его в createAgentTools, а для себя берёт четыре
// значения — сборщик обработчиков, обёртку ошибки fmtError и живое назначение
// окружения (get/setCapability принадлежат экземпляру src/agent-env.js выше).
const { executeTool } = createToolRegistry({
  createAgentTools,
  fmtError,
  getCapability,
  setCapability,
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
  // Публикация проекта в GitHub — ТА ЖЕ функция, что зовёт канал github:publish:
  // без неё инструмент gitPublish падал с «is not defined» (находка части 35).
  publishLocalToGithub: githubIpc.publishLocalToGithub,
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
    agentEnv: getAgentEnv,
    userAgentEnv: getUserAgentEnv,
    // Что и кому выдано — envList показывает это честно, чтобы агент не искал
    // переменную, которой у него нет.
    scopeSummary: (name) => toolPolicy.scopeSummary(getScopes(), name),
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

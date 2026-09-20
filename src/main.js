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

// Короткое описание аргументов для подтверждения опасного действия.
// Тексты живут в политике (tool-policy.js) — здесь только обёртка.
function describeToolArgs(name, a) {
  return toolPolicy.describe(name, a);
}

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


// ─────────────────────────── Выполнение инструментов ───────────────────────────
// Чтение файлов для инструментов (нумерация строк, язык, карта определений и
// диапазоны блоков) переехало в src/project-analysis.js (этап B, часть 21):
// имена те же, инструменты получают их прежним списком аргументов.

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

async function executeTool(name, args, settings) {
  args = args || {};
  // Инструмент в работе: его capability решает, какие переменные агента дойдут до
  // команд внутри него. Вызовы инструментов идут по очереди (цикл runAi), поэтому
  // одного «текущего назначения» достаточно; вложенный вызов вернёт своё.
  const prevCapability = getCapability();
  setCapability(toolPolicy.capabilityOf(name));
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
    setCapability(prevCapability);
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
  executeTool,
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

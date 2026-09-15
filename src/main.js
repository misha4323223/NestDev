"use strict";

// Держатели темпа для провайдеров: лимит считается на ключ, но привязка к
// провайдеру+модели даёт то же поведение и не хранит секрет в ключе карты.
const rateLimiters = new Map();
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
  groupOfTool,
  PLAN_MODE_TOOL_DEFINITIONS,
  modelWindow,
  ollamaModelInfo,
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
const ota = require("./ota.js"); // локальный self-update (OTA)
const selfDev = require("./self-dev.js"); // защита критичной инфраструктуры самообновления

// ─────────────────────────── Настройки ───────────────────────────
// Клонирование репозиториев: явная кнопка «⬇ Выгрузить» в списке GitHub-репозиториев
// (клик по строке — только выбор; клонирует «Выгрузить»), поле «Клонировать» в панели проекта
// и инструмент агента gitClone используют единый robust-код (cloneRepoTo).
// Команды агента (runCommand/shell) дублируются в нижний терминал приложения через termAgentEcho.
// provider: "ollama" (локально) | "openai" (OpenAI-совместимые: Groq/GPT/DeepSeek/OpenRouter/свой) | "anthropic" (Claude)
const DEFAULT_SETTINGS = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  openaiUrl: "https://api.groq.com/openai/v1",
  openaiApiKey: "",
  anthropicUrl: "https://api.anthropic.com",
  anthropicApiKey: "",
  model: "",
  workingDir: os.homedir(),
  githubToken: "",
  githubClientId: "",
  githubLogin: "",
  githubAvatarUrl: "",
  githubRepoSlug: "",
  githubRepoDir: "",
  allowAgentPush: false, // агенту ЗАПРЕЩЕНО пушить в GitHub, пока пользователь явно не включит
  agentAutoCommit: true, // авто-чекпоинт: локальный коммит после каждого завершённого задания агента
  projects: [], // список проектов (до 10): { id, name, dir, createdAt, lastOpened }

  // Мобильный доступ: мост по LAN с PIN-кодом (телефон в той же Wi-Fi сети).
  mobileEnabled: false,
  mobilePort: 9090,
  mobilePin: "",
  // Вспомогательная модель (второй ключ OpenRouter): зрение + генерация картинок
  visionEnabled: false,
  visionAuto: true,
  visionUrl: "https://openrouter.ai/api/v1",
  visionKey: "",
  visionModel: "",
  imageModel: "",
  defaultRole: "dev", // роль новых чатов: dev / assistant / manager / researcher
  taskReminders: true, // напоминать о делах в срок, пока приложение открыто
  serperApiKey: "", // ключ Serper — усиленный Google-поиск для агента (webSearch)
  // Браузер агента: постоянный профиль (куки и входы на сайты переживают перезапуск приложения)
  browserProfile: true,
  // Работа в СВОЁМ Chrome через порт отладки (CDP): агент действует в твоих
  // вкладках с твоими входами на сайты. По умолчанию выключено.
  browserConnect: false,
  browserConnectPort: 9222,
  // Менеджер паролей: записи { id, name, url, login, password, note } — шифруются как остальные секреты
  sitePasswords: [],
  // Почта (SMTP/IMAP): агент отправляет КП и читает коды подтверждения. Пароль — в secrets.json.
  mailAddress: "", // адрес ящика (он же логин по умолчанию)
  mailUser: "", // логин, если провайдер требует отдельный (обычно пусто)
  mailFromName: "", // имя отправителя в письмах
  mailImapHost: "", // пусто — определится по адресу
  mailImapPort: 993,
  mailSmtpHost: "", // пусто — определится по адресу
  mailSmtpPort: 465,
  mailStarttls: false, // SMTP через STARTTLS (587) вместо неявного TLS (465)
  mailAllowAgentSend: false, // агенту ЗАПРЕЩЕНО отправлять письма, пока пользователь не включит
  activeProjectId: "", // id активного проекта (его dir = workingDir)
  // Локальный self-update (OTA): агент собирает бандл (scripts/make-ota.js), приложение применяет на ходу
  otaEnabled: true,
  otaDir: "", // необязательная папка-источник OTA (пусто — userData/ota + ota/ рядом с кодом)
  // Сохранённые OpenAI-совместимые подключения (несколько ключей): { id, name, url, apiKey, model, project }
  openaiProfiles: [],
  openaiActiveProfile: "", // id активного подключения ("" — не выбрано)
  autoSwitchProfiles: false, // при ошибке ключа/баланса/лимита — авто-переключение на следующее подключение

  // Yandex Cloud (REST API): авторизация (OAuth-токен — в secrets.json), каталог, разрешения агента
  ycCloudId: "", // id облака
  ycFolderId: "", // id каталога (folder), с которым работает дашборд и агент
  ycFolderName: "", // имя каталога для отображения
  ycAllowAgentCreate: false, // агенту ЗАПРЕЩЕНО создавать ресурсы, пока пользователь явно не включит
  ycAllowAgentDelete: false, // удаление ресурсов агентом — только с явного разрешения
  ycAllowAgentUpdate: false, // менять настройки контейнеров, деплоить ревизии и откатывать их — тоже только с явного разрешения

  // Память диалогов: когда контекст переполняется, агент сворачивает старые шаги
  // в памятку — здесь такая памятка сохраняется локально по датам в
  // <userData>/context-memory/ГГГГ-ММ-ДД/. Потом можно спросить «что мы делали 5-го числа»
  // (инструменты memoryList / memorySearch). По умолчанию ВЫКЛЮЧЕНО — без явного
  // согласия пользователя на диск ничего не пишется.
  contextMemory: false,
  contextMemoryDays: 30, // сколько дней хранить (старые дни удаляются автоматически)

  // Журнал действий агента: опасные и требующие подтверждения действия пишутся
  // в userData/audit.log (JSONL). Секреты в журнал не попадают. Включён по умолчанию.
  auditLog: true,
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const chatsFile = () => path.join(app.getPath("userData"), "chats.json");

// Миграция старых настроек (provider:"external" / externalUrl / apiKey) в новую схему.
function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (s.provider === "external") s.provider = "openai";
  if (!raw || raw.openaiUrl === undefined) {
    if (raw && raw.externalUrl !== undefined) s.openaiUrl = raw.externalUrl;
  }
  if (!raw || raw.openaiApiKey === undefined) {
    if (raw && raw.apiKey !== undefined) s.openaiApiKey = raw.apiKey;
  }
  // Миграция на сохранённые OpenAI-подключения: единственный URL+ключ → первый профиль.
  // (Только если поля openaiProfiles ещё не было вовсе — удалённые вручную профили не воскрешаем.)
  if (!raw || !Array.isArray(raw.openaiProfiles)) {
    const profUrl = String(s.openaiUrl || "").trim();
    if (profUrl) {
      s.openaiProfiles = [
        {
          id: "p-main",
          name: openaiProfileNameFromUrl(profUrl),
          url: profUrl,
          apiKey: s.openaiApiKey || "",
          model: s.openaiModel || "",
          project: s.openaiProject || "",
        },
      ];
      s.openaiActiveProfile = "p-main";
    } else {
      s.openaiProfiles = [];
      s.openaiActiveProfile = "";
    }
  }
  // Миграция на проекты: если списка ещё нет — заводим один проект из рабочей директории.
  if (!Array.isArray(raw.projects)) {
    const wd = s.workingDir && typeof s.workingDir === "string" ? s.workingDir.trim() : "";
    if (wd) {
      const base = path.basename(wd) || "Рабочая папка";
      s.projects = [{ id: "p-main", name: base, dir: wd, createdAt: Date.now(), lastOpened: Date.now() }];
      s.activeProjectId = "p-main";
    } else {
      s.projects = [];
      s.activeProjectId = "";
    }
  }
  if (!Array.isArray(s.projects)) s.projects = [];
  // Пароли сайтов: чистка мусора и дублей (пустые/битые записи отбрасываются).
  s.sitePasswords = vault.sanitizeList(s.sitePasswords);
  return s;
}

// Переменные окружения агента (envSet/envList/envUnset). Значения хранятся в settings.json
// (settings.agentEnv) и подмешиваются во все команды: runCommand, фоновые процессы, shell, git, docker.
let agentEnv = {}; // итоговый набор: пользовательский + автоматический (Yandex Cloud)
let userAgentEnv = {}; // только то, что задал пользователь — это и сохраняется в настройках

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

// Окружение для команды, которую СОЧИНИЛ агент (runCommand, фоновые процессы, shell).
// Обычные команды (npm, docker, yc, git) получают переменные агента как раньше, но
// команда, которая просто печатает всё окружение (env, printenv, set, Get-ChildItem Env:),
// секретов не получает — иначе модель одной строкой выводит пароли пользователя в чат.
function commandEnv(command) {
  const base = { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" };
  if (toolPolicy.commandDumpsEnv(command)) return { ...base, ...pathOnlyEnv() };
  return { ...base, ...agentEnv };
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
  lastAgentEnvSettings = s || lastAgentEnvSettings;
  rebuildAgentEnv();
  ycEnsurePath();
  // Фоновая подстановка свежего IAM в YC_IAM_TOKEN/YC_TOKEN (без await).
  ycIamSync(lastAgentEnvSettings);
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    const s = normalizeSettings(raw);
    // Секреты (ключи, токены, PIN, agentEnv) живут в зашифрованном secrets.json.
    const sec = secrets.loadSecrets();
    for (const k of secrets.SECRET_KEYS) {
      if (sec[k] !== undefined) s[k] = sec[k];
    }
    applyAgentEnv(s);
    audit.setEnabled(s.auditLog !== false); // журнал действий: по умолчанию включён
    // Постоянный профиль браузера агента: отдельная папка внутри userData.
    // Выключено — работаем как раньше, с чистым профилем на каждый запуск.
    applyBrowserSettings(s);
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  // Секреты — в отдельный зашифрованный файл, в settings.json их не остаётся.
  const { rest, sec } = secrets.splitSecrets(s);
  secrets.saveSecrets(sec);
  fs.writeFileSync(settingsFile(), JSON.stringify(rest, null, 2), "utf8");
}

// Имя подключения из URL: https://api.deepseek.com/v1 → deepseek.com
function openaiProfileNameFromUrl(url) {
  try {
    const m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
    return m ? m[1].replace(/^www\./, "") : "OpenAI";
  } catch {
    return "OpenAI";
  }
}

// Список OpenAI-подключений, которые реально можно использовать (есть id и ключ).
function openaiProfilesList(s) {
  const arr = Array.isArray(s && s.openaiProfiles) ? s.openaiProfiles : [];
  return arr.filter((p) => p && typeof p === "object" && p.id && String(p.apiKey || "").trim());
}

// Кулдаун подключений: после ошибки ключа/баланса/лимита не возвращаемся к этому
// ключу раньше времени — защита от «долбления» ограниченного ключа и лишних ротаций.
const profileCooldown = new Map(); // profileId → timestamp (мс), до которого не используем

function markProfileCooldown(id, ms) {
  if (!id) return;
  profileCooldown.set(id, Date.now() + Math.max(0, Number(ms) || 0));
}

// Переключает активное OpenAI-подключение на следующее по кругу и зеркалит его
// значения в основные поля настроек (их читает весь остальной код: чат, модели, тест).
// opts.penalizeCurrentMs — на сколько отложить текущий (провинившийся) ключ.
// Подключения в кулдауне пропускаются. Возвращает новый профиль или null.
function switchOpenaiProfile(s, opts) {
  const o = opts || {};
  const profs = openaiProfilesList(s);
  if (profs.length < 2) return null;
  const now = Date.now();
  const cur = s.openaiActiveProfile;
  const idx = Math.max(0, profs.findIndex((p) => p.id === cur));
  if (o.penalizeCurrentMs) markProfileCooldown(cur, o.penalizeCurrentMs);
  for (let step = 1; step <= profs.length; step++) {
    const next = profs[(idx + step) % profs.length];
    if (!next || next.id === cur) continue;
    if ((profileCooldown.get(next.id) || 0) > now) continue; // ещё не отлежался
    s.openaiActiveProfile = next.id;
    s.openaiUrl = next.url || s.openaiUrl;
    s.openaiApiKey = next.apiKey || "";
    if (next.model) s.openaiModel = next.model;
    if (next.project !== undefined) s.openaiProject = next.project || "";
    return next;
  }
  return null; // все подключения в кулдауне — переключать некуда
}

// Чтение чатов: основной файл, при повреждении — резервная копия .bak.
function loadChats() {
  const readOne = (file) => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d && Array.isArray(d.chats)) return d;
    } catch {}
    return null;
  };
  return readOne(chatsFile()) || readOne(chatsFile() + ".bak") || { chats: [], activeId: null };
}

// Запись чатов атомарная: сначала во временный файл, потом подмена.
// Внезапное закрытие/падение во время записи больше не оставит обрезанный
// chats.json (из-за него вся история выглядела как «всё удалилось»).
function saveChats(d) {
  const file = chatsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
  try {
    if (fs.existsSync(file)) fs.renameSync(file, file + ".bak");
  } catch {}
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: подмена может не пройти, если файл залочен — тогда копируем.
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); } catch {}
  }
}

// ─────────────────────────── Пути и файлы ───────────────────────────
function resolvePath(p, settings) {
  const base = agentWorkDir(settings);
  if (!p) return base;
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

// ─────────────────────────── Git ───────────────────────────
// cwd — директория, в которой выполняется git; settings — для токена авторизации (OAuth / PAT).
function runGit(cwd, args, settings) {
  return new Promise((resolve) => {
    const opts = { cwd, timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    if (settings && settings.githubToken) {
      opts.env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv };
      // GitHub принимает на git-эндпоинте только Basic-авторизацию (Bearer отклоняет
      // с «remote: invalid credentials»). Схема как в GitHub Actions:
      // Authorization: Basic base64(<login или x-access-token>:<token>).
      const ghUser = ((settings.githubLogin || "").trim() || "x-access-token");
      const ghAuth = Buffer.from(ghUser + ":" + settings.githubToken).toString("base64");
      args = ["-c", "http.extraheader=Authorization: Basic " + ghAuth, ...args];
    } else if (Object.keys(agentEnv).length) {
      opts.env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv };
    }
    execFile("git", args, opts, (err, stdout, stderr) => {
      const out = (stdout || "").toString();
      const errText = (stderr || "").toString();
      if (err) {
        let msg = (errText || err.message).toString().trim().slice(0, 4000);
        if (err.code === "ENOENT" || /not found|не является внутренней или внешней командой/i.test(msg)) {
          msg = "Git не найден в PATH. Установи Git (git-scm.com/downloads), перезапусти приложение и обнови PATH через инструмент refreshEnv. Ошибка: " + msg;
        }
        resolve({ ok: false, out, err: msg });
      } else {
        resolve({ ok: true, out: out.trim(), err: errText.trim() });
      }
    });
  });
}

// Рабочая директория приложения (или домашняя, если её нет)
function gitDirOrHome(settings) {
  return settings.workingDir && fs.existsSync(settings.workingDir) ? settings.workingDir : os.homedir();
}

// Директория, в которой агент выполняет git и команды: если недавно клонировали репозиторий — там,
// иначе в рабочей директории (если она сама — репозиторий), иначе в рабочей папке.
let lastAgentRepoDir = null; // путь, куда агент последний раз клонировал репозиторий
let clonedRepoPending = false; // одноразовый флаг: после клона/смены репозитория следующий ответ агента начнётся с анализа проекта
let activeRunUndo = []; // undo-снимки файлов последнего запуска агента
let lastUndoLog = [];
let pendingAsk = null; // ожидание ответа пользователя (askUser)

function agentWorkDir(settings) {
  const base = gitDirOrHome(settings);
  // Если выбран GitHub-репозиторий и его локальная папка ещё есть — работать в ней.
  if (settings.githubRepoSlug && settings.githubRepoDir && fs.existsSync(settings.githubRepoDir)) {
    return settings.githubRepoDir;
  }
  if (lastAgentRepoDir && fs.existsSync(lastAgentRepoDir)) return lastAgentRepoDir;
  return base;
}

// Вынимает имя репозитория из URL (https://github.com/user/repo.git, git@github.com:user/repo.git и т.п.)
// Имя используется как имя папки — чистим от того, что Windows не разрешает (точка/пробел в конце,
// служебные имена CON/PRN/AUX/NUL/COM1...), иначе git упадёт с «could not create work tree dir».
function repoNameFromUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (u.includes("git@") && u.includes(":")) u = "https://" + u.slice(u.indexOf(":") + 1);
  let name = (u.split("/").pop() || "repo").replace(/\.git$/i, "").replace(/[. ]+$/g, "").trim();
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "repo";
  return name;
}

// Убирает учётные данные из git-URL: https://user:TOKEN@github.com/... -> https://github.com/...
// Нужно, чтобы токен не хранился в .git/config и не мешал сравнению remote-URL.
function stripUrlCreds(u) {
  const s = String(u || "").trim();
  return s.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

function sanitizeDir(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  return abs;
}

function sanitizePath(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs)) return null;
  return abs;
}

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

// ─────────────────────────── Помощники новых инструментов ───────────────────────────
// Определяет пакетный менеджер проекта по lockfile.
function detectPackageManager(cwd) {
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (has("bun.lockb") || has("bun.lock")) return { name: "bun", bin: "bun", add: "add", flagDev: "-d" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", bin: "pnpm", add: "add", flagDev: "-D" };
  if (has("yarn.lock")) return { name: "yarn", bin: "yarn", add: "add", flagDev: "-D" };
  return { name: "npm", bin: "npm", add: "install", flagDev: "-D" };
}

function hasLock(kind) {
  const cwd = agentWorkDir(loadSettings());
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (kind === "bun") return has("bun.lockb") || has("bun.lock");
  return has("package-lock.json") || has("npm-shrinkwrap.json");
}

// Выжимает из вывода тестового раннера краткий итог: сколько прошло/упало и какие тесты упали.
function summarizeTestOutput(out) {
  const s = String(out || "");
  const summary = [];
  const passMatch = s.match(/Tests:?\s+(\d+)\s+(passed|passing|пройден)/i) || s.match(/(\d+)\s*(passed|passing|пройден)/i) || s.match(/passed\s*(\d+)/i);
  const failMatch = s.match(/Tests:?\s+.*?(\d+)\s+(failed|failing|упал)/i) || s.match(/(\d+)\s*(failed|failing|упал)/i) || s.match(/failed\s*(\d+)/i);
  if (passMatch) summary.push("✅ прошло: " + passMatch[1]);
  if (failMatch) summary.push("❌ упало: " + failMatch[1]);
  const failLines = s.split("\n").map((l) => l.trim()).filter((l) => l && l.length < 200 && /^(✕|✗|×|FAIL\b|●|✖|❌)/.test(l)).slice(0, 15);
  if (failLines.length) summary.push("Упавшие тесты:\n" + failLines.join("\n"));
  if (!summary.length && /(fail|error)/i.test(s)) summary.push("В выводе есть ошибки/упавшие тесты — смотри полный вывод.");
  return summary.join("\n");
}

// Unified-дифф двух файлов/папок через git diff --no-index (git уже есть в системе).
function unifiedDiff(p1, p2) {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-index", "--", p1, p2], {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...agentEnv },
    }, (err, stdout, stderr) => {
      // git diff --no-index возвращает код 1 при различиях — это норма, патч в stdout.
      resolve({ patch: stripAnsi((stdout || "") + (stderr || "")).trim() });
    });
  });
}

// ─────────────────────────── Помощники: анализ/рефакторинг/API/БД ───────────────────────────
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

// ─────────────────────────── Фоновые процессы и постоянные shell-сессии ───────────────────────────
// Процессы живут между вызовами инструментов; вывод копится в кольцевой буфер.
const bgProcesses = new Map();
let bgSeq = 0;

function bgPushLines(rec, chunk) {
  const lines = stripAnsi(chunk.toString()).split("\n");
  for (const l of lines) rec.output.push(l);
  if (rec.output.length > 1000) rec.output.splice(0, rec.output.length - 1000);
}

function bgSpawn(command, opts) {
  opts = opts || {};
  const isWin = process.platform === "win32";
  const shell = opts.shell || (isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
  const args = opts.shellArgs || shellArgsFor(command);
  const child = spawn(shell, args, {
    cwd: opts.cwd || os.homedir(),
    detached: !isWin,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: commandEnv(command),
  });
  const rec = {
    id: "bg" + (++bgSeq).toString(36) + "-" + Date.now().toString(36),
    command: String(command || ""),
    name: opts.name || String(command || "").slice(0, 60),
    cwd: opts.cwd || os.homedir(),
    startedAt: Date.now(),
    output: [],
    exited: false,
    exitCode: null,
    child,
  };
  bgProcesses.set(rec.id, rec);
  child.stdout.on("data", (d) => bgPushLines(rec, d));
  child.stderr.on("data", (d) => bgPushLines(rec, d));
  child.on("exit", (code) => { rec.exited = true; rec.exitCode = code; });
  child.on("error", (e) => { rec.exited = true; rec.error = e.message; });
  return rec;
}

function bgKill(rec) {
  if (!rec || !rec.child) return;
  const pid = rec.child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { rec.child.kill(); } catch {}
}

// ─────────────────────────── Dev-серверы: распознавание и освобождение порта ───────────────────────────
// Команды, похожие на запуск длительного dev-сервера (не завершаются сами по себе).
// Сознательно НЕ ловим «vite build» и «npm run build» — это короткие команды.
const SERVER_CMD_RE =
  /(?:^|[\s;&|])(?:npx\s+)?expo\s+start\b|(?:^|[\s;&|])(?:npm|npx|bun|yarn|pnpm)\s+run\s+(dev|dev:[\w:.-]+|start|start:[\w:.-]+|serve|watch|preview)\b|(?:^|[\s;&|])(?:npm|bun|yarn|pnpm)\s+(start|serve|dev)\b|(?:^|[\s;&|])vite\b(?!\s+(build|optimize)\b)|(?:^|[\s;&|])next\s+dev\b|(?:^|[\s;&|])ng\s+serve\b|(?:^|[\s;&|])nodemon\b|(?:^|[\s;&|])tsx\s+watch\b|(?:^|[\s;&|])uvicorn\b|(?:^|[\s;&|])gunicorn\b|(?:^|[\s;&|])dotnet\s+run\b|(?:^|[\s;&|])flutter\s+run\b|(?:^|[\s;&|])(?:node|bun)\s+\S*(server|app|index|main)\.(js|ts|mjs|cjs)\b|(?:^|[\s;&|])python3?\s+\S*manage\.py\s+runserver\b/i;

// Убивает процесс вместе со ВСЕМ деревом (Windows — taskkill /T /F, иначе — группа процессов).
// Простой child.kill() на Windows убивает только cmd.exe, а node/expo-дети остаются и держат порт.
function killProcessTree(child) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { child.kill(); } catch {}
}

// Ждёт появления маркера в выводе фонового процесса (не убивая его и не дожидаясь выхода).
function bgWaitFor(rec, needle, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (needle && rec.output.join("\n").includes(needle)) return resolve({ matched: true });
      if (rec.exited) return resolve({ matched: false, exited: true, code: rec.exitCode });
      if (Date.now() - t0 > (timeoutMs || 120000)) return resolve({ matched: false, timedOut: true });
      setTimeout(tick, 300);
    };
    tick();
  });
}

// Достаёт порт из URL вида http://localhost:5000/path.
function parsePortFromUrl(url) {
  const m = String(url || "").match(/:(\d{1,5})(\/|$)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Находит процессы, слушающие порт, и убивает их (освобождает порт).
async function killProcessesOnPort(port) {
  const p = parseInt(port, 10);
  if (!p || p < 1 || p > 65535) return { ok: false, error: "Некорректный порт: " + port };
  const killed = [];
  if (process.platform === "win32") {
    const out = await runTerminalCommand("netstat -ano -p tcp", os.homedir(), 15000);
    const pidSet = new Set();
    for (const line of String(out).split("\n")) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = parts[parts.length - 1] || "";
      const pm = local.match(/:(\d{1,5})$/);
      if (pm && pm[1] === String(p) && /^\d+$/.test(pid)) pidSet.add(pid);
    }
    for (const pid of pidSet) {
      await new Promise((r) => {
        const k = spawn("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true });
        k.on("close", () => r());
        k.on("error", () => r());
      });
      killed.push(pid);
    }
  } else {
    const out = await runTerminalCommand("lsof -ti tcp:" + p + " 2>/dev/null || fuser " + p + "/tcp 2>/dev/null", os.homedir(), 15000);
    const pids = (String(out).match(/\d+/g) || []).filter((x) => Number(x) > 1);
    for (const pid of pids) {
      try { process.kill(Number(pid), "SIGTERM"); } catch {}
      killed.push(pid);
    }
  }
  return { ok: killed.length > 0, killed };
}

// Ждём, пока вывод процесса «затихнет» (для shellSend: команда отработала).
function waitOutputQuiet(rec, maxMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let lastLen = rec.output.length;
    const tick = () => {
      if (rec.exited || Date.now() - t0 > (maxMs || 6000)) return resolve();
      if (rec.output.length !== lastLen) {
        lastLen = rec.output.length;
        return setTimeout(tick, 150);
      }
      if (Date.now() - t0 > 700) return resolve();
      setTimeout(tick, 150);
    };
    setTimeout(tick, 250);
  });
}

function bgTail(rec, lines) {
  const n = Math.min(Math.max(lines || 50, 1), 500);
  return rec.output.slice(-n).join("\n");
}

// Проверка HTTP(S)-URL: статус, заголовки, начало тела.
async function checkUrlStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "AI-Developer-Agent" },
    });
    const body = await res.text().catch(() => "");
    const ct = res.headers.get("content-type") || "";
    const head = body.replace(/\s+/g, " ").trim().slice(0, 400);
    const lines = [
      "URL: " + url,
      "Статус: " + res.status + " " + (res.statusText || ""),
      "Content-Type: " + ct,
      "Размер тела: " + body.length + " символов",
    ];
    if (head) lines.push("Начало тела: " + head);
    return lines.join("\n");
  } catch (e) {
    return "Ошибка: сервер не ответил — " + (e.name === "AbortError" ? "таймаут 8 с" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Поиск по всему проекту (grep) и обзор структуры ──
// Веб-поиск и чтение страниц (webSearchDDG / webFetchPage) — в renderer/web-tools.js.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".output",
  ".venv", "venv", "env", "__pycache__", ".idea", ".vscode", ".dart_tool", ".flutter-plugins",
  ".gradle", "target", "vendor", "bower_components", "Pods", ".cache", ".parcel-cache", "lib-cov",
]);
const MAX_FILE_SCAN = 2 * 1024 * 1024; // файлы больше 2 МБ не сканируем поиском

// Рекурсивный обход проекта: вызывает onFile(relPath, absPath); останавливается по лимитам.
function walkProject(root, opts, onFile) {
  const maxDepth = opts.maxDepth || 8;
  const maxFiles = opts.maxFiles || 4000;
  let visited = 0;
  (function walk(dir, depth) {
    if (depth > maxDepth || visited >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= maxFiles) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        visited++;
        onFile(rel, abs);
      }
    }
  })(root, 0);
}

// Список файлов проекта для «осмотра» (listFiles).
function listProjectFiles(settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  const out = [];
  const cap = 300;
  walkProject(root, { maxFiles: cap + 100 }, (rel) => {
    if (out.length < cap) out.push(rel.replace(/\\/g, "/"));
  });
  if (!out.length) return "В папке " + root + " нет файлов (или только в пропускаемых папках: node_modules, .git и т.п.).";
  const base = sub ? root : agentWorkDir(settings);
  const prefix = path.relative(agentWorkDir(settings), base) || "";
  const lines = out.map((f) => (prefix ? prefix.replace(/\\/g, "/") + "/" + f : f));
  const more = out.length >= cap ? "\n… (показаны первые " + cap + " записей)" : "";
  return "Файлы проекта (" + out.length + "):\n" + lines.join("\n") + more;
}

// Поиск по всем файлам проекта (searchProject), как grep -r.
function searchProjectFiles(pattern, settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  let re = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {}
  const maxResults = 40;
  const hits = [];
  walkProject(root, {}, (rel, abs) => {
    if (hits.length >= maxResults) return;
    if (BINARY_EXT.has(path.extname(abs).toLowerCase().replace(".", ""))) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_SCAN) return;
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (content.includes("\u0000")) return;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re ? re.test(lines[i]) : lines[i].includes(pattern)) {
        hits.push({ file: rel.replace(/\\/g, "/"), n: i + 1, text: lines[i].trim().slice(0, 220) });
      }
    }
  });
  if (!hits.length) return "Совпадений по «" + pattern + "» в проекте нет (каталог: " + root + ").";
  return (
    "Совпадения «" + pattern + "» (" + hits.length + "):\n" +
    hits.map((h) => h.file + ":" + h.n + "  " + h.text).join("\n") +
    "\n\nЧтобы посмотреть строки вокруг, используй readFileLines (path, start, count)."
  );
}

// Снимок файла для «отката изменений агента». Снимок делается ПЕРЕД каждой правкой,
// поэтому undoEdit(path, steps) умеет откатывать на несколько шагов назад.
// На файл хранится не более UNDO_MAX_PER_FILE последних снимков (старые вытесняются).
// content === null означает, что файл был создан агентом (откат = удалить).
const UNDO_MAX_PER_FILE = 5;
function snapshotFileForUndo(p) {
  try {
    let content;
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 10 * 1024 * 1024) return; // очень большие файлы не копируем
      content = fs.readFileSync(p, "utf8");
    } else {
      content = null; // создан агентом
    }
    activeRunUndo.push({ path: p, content, ts: Date.now() });
    // вытесняем самые старые снимки этого файла, оставляя UNDO_MAX_PER_FILE
    let total = 0;
    for (const u of activeRunUndo) if (u.path === p) total++;
    let drop = total - UNDO_MAX_PER_FILE;
    if (drop > 0) {
      const kept = [];
      for (let i = 0; i < activeRunUndo.length; i++) {
        const u = activeRunUndo[i];
        if (u.path === p && drop > 0) { drop--; continue; }
        kept.push(u);
      }
      activeRunUndo = kept;
    }
  } catch {}
}

// ── Чекпоинт: снимок изменений последнего запуска сохраняется на диск, ──
// ── чтобы откат пережил перезапуск приложения. ──
const undoFile = () => path.join(app.getPath("userData"), "undo.json");

function persistUndo() {
  try {
    fs.mkdirSync(path.dirname(undoFile()), { recursive: true });
    fs.writeFileSync(undoFile(), JSON.stringify(lastUndoLog), "utf8");
  } catch {}
}

function loadPersistedUndo() {
  if (lastUndoLog.length) return;
  try {
    const d = JSON.parse(fs.readFileSync(undoFile(), "utf8"));
    if (Array.isArray(d)) lastUndoLog = d;
  } catch {}
}

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

// ── Справочники по сайтам (agent-guides) ────────────────────────────────────
// Встроенные лежат рядом с кодом (src/agent-guides/*.md), выученные агентом —
// в userData/agent-guides. В шапке файла может быть строка
// <!-- sites: console.cloud.google.com, cloud.google.com --> — по ней гайд
// подхватывается автоматически, когда агент открывает такой адрес.
function guideDirs() {
  return [path.join(app.getPath("userData"), "agent-guides"), path.join(__dirname, "agent-guides")];
}
function guideSafeName(raw) {
  return String(raw || "").trim().replace(/^agent-guide:/i, "").replace(/[^a-z0-9-_]/gi, "").toLowerCase();
}
function guideFilePath(name, forWrite) {
  const safe = guideSafeName(name);
  if (!safe) return "";
  if (forWrite) return path.join(guideDirs()[0], safe + ".md");
  for (const dir of guideDirs()) {
    const p = path.join(dir, safe + ".md");
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function guideSitesOf(text) {
  const m = String(text || "").match(/<!--\s*sites:\s*([^>]+?)-->/i);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function guideTitleOf(text) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 80) : "";
}
function guideIndex() {
  const out = [];
  for (const dir of guideDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (out.some((g) => g.name === name)) continue; // выученный важнее встроенного
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { continue; }
      out.push({ name: name, title: guideTitleOf(text), sites: guideSitesOf(text), learned: dir === guideDirs()[0] });
    }
  }
  return out;
}
function guideReadText(name) {
  const p = guideFilePath(name, false);
  if (!p) return "";
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; }
}
// Гайд по адресу: точный домен, затем по вхождению (console.cloud.google.com ← cloud.google.com).
function guideForUrl(url) {
  let host = "";
  try { host = String(new URL(url).hostname || "").toLowerCase().replace(/^www\./, ""); } catch (e) { host = ""; }
  if (!host) return null;
  const list = guideIndex();
  for (const g of list) {
    for (const s of g.sites) {
      if (host === s) return g;
    }
  }
  for (const g of list) {
    for (const s of g.sites) {
      if (host.endsWith("." + s) || s.endsWith("." + host)) return g;
    }
  }
  return null;
}
function agentGuideCall(args) {
  args = args || {};
  const action = String(args.action || (args.save ? "save" : args.name ? "read" : args.url ? "match" : "list")).toLowerCase();
  if (action === "list") {
    const list = guideIndex();
    if (!list.length) return "Справочников пока нет.";
    return (
      "Справочники агента (сайты и темы):\n" +
      list
        .map((g) => "• " + g.name + (g.title ? " — " + g.title : "") + (g.sites.length ? " [" + g.sites.join(", ") + "]" : "") + (g.learned ? " (мой, сохранён)" : ""))
        .join("\n") +
      "\nЧитать: agentGuide { name: \"google-cloud\" } — или readFile(path: \"agent-guide:google-cloud\").\n" +
      "Свой маршрут: after удачного прохода — agentGuide { save: \"сайт\", title: \"…\", steps: \"1) … 2) …\" }."
    );
  }
  if (action === "match") {
    const g = guideForUrl(args.url || args.site || "");
    if (!g) return "Для этого адреса справочника нет — ищи по DOM (browserSnapshot) и, пройдя путь, сохрани его: agentGuide { save: … }.";
    return "К этому сайту есть справочник «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") + ". Читай: agentGuide { name: \"" + g.name + "\" }.";
  }
  if (action === "read") {
    const name = guideSafeName(args.name || args.site || args.id);
    const text = guideReadText(name);
    if (!text) {
      const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
      return "Ошибка: справочник «" + (name || "?") + "» не найден. Есть: " + list + ".";
    }
    return "СПРАВОЧНИК АГЕНТА: «" + name + "» (читай и следуй ему):\n\n" + text;
  }
  if (action === "save") {
    const name = guideSafeName(args.save === true || args.save === "true" ? args.name : args.name || args.save || args.site);
    const steps = String(args.steps || args.text || args.notes || "").trim();
    if (!name || !steps) {
      return "Ошибка agentGuide: для сохранения нужны name (сайт, латиницей) и steps — что и в каком порядке сработало (селекторы, подписи кнопок, подводные камни).";
    }
    const old = guideReadText(name);
    const body =
      "# " + (String(args.title || "").trim() || "Маршрут: " + name) + "\n" +
      (args.sites ? "<!-- sites: " + String(args.sites) + " -->\n" : "") +
      (old ? old.replace(/^[\s\S]*?\n---\n/, "") + "\n" : "") +
      "---\n## " + new Date().toISOString().slice(0, 10) + " — пройдено успешно\n" + steps + "\n";
    try {
      fs.mkdirSync(guideDirs()[0], { recursive: true });
      fs.writeFileSync(guideFilePath(name, true), body, "utf8");
    } catch (e) {
      return "Ошибка: не удалось сохранить справочник: " + String((e && e.message) || e).slice(0, 140);
    }
    return "OK — маршрут сохранён: agent-guides/" + name + ".md. В следующий раз я прочитаю его сразу (agentGuide { name: \"" + name + "\" }).";
  }
  return "agentGuide: неизвестное действие «" + action + "». Доступно: list, read (name), match (url), save (name + steps).";
}

// Хранилище приложения (дела, заметки): вне рабочей папки, поэтому в git не попадает.
function userDataDir() {
  return app.getPath("userData");
}

// Дела изменились (агент, панель в окне или телефон) — обновляем панель везде.
function emitTasksChanged() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("tasks:changed", { ts: Date.now() });
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

function checkTaskReminders() {
  let due = [];
  try {
    if (loadSettings().taskReminders === false) return;
    due = agentStore.tasksTakeReminders(userDataDir()).tasks;
  } catch {
    return;
  }
  if (!due.length) return;
  const now = Date.now();
  for (const t of due) {
    const at = new Date(t.due).getTime();
    const late = at < now;
    notifyUser((late ? "⚠ Дело просрочено: " : "⏰ Дело: ") + t.title, agentStore.humanDue(t, now));
  }
  emitTasksChanged();
  try {
    mainWindow.webContents.send("ai:event", {
      type: "task-reminder",
      tasks: due.map((t) => ({ id: t.id, title: t.title, due: t.due, late: new Date(t.due).getTime() < now })),
    });
  } catch {}
}

async function executeTool(name, args, settings) {
  args = args || {};
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
function saveContextMemo(settings, entry, emit) {
  if (!settings || !settings.contextMemory) return null;
  if (!entry || !String(entry.text || "").trim()) return null;
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

  if (!settings.model) {
    throw new Error("Не выбрана модель. Открой Настройки и обнови список моделей (кнопка ↻).");
  }

  // Контекст-окно: бюджет = реальное окно модели (если известно) минус резерв на вывод.
  let budget = contextBudget(provider, settings.model);
  let modelWin = 0; // реальное окно модели (0 — сервер не ответил)
  try {
    modelWin = await modelWindow(settings, settings.model);
    if (modelWin > 0) budget = Math.min(budget, modelWin - 4096);
    // Нижний предел — 3000 токенов, но НИКОГДА больше реального окна: у модели с
    // окном 2048 «пол» в 3000 гарантировал переполнение на каждом запросе.
    budget = Math.max(budget, modelWin > 0 ? Math.min(3000, modelWin) : 3000);
  } catch {}
  // Локальная модель без поддержки инструментов не сможет позвать ни один инструмент:
  // агент молча «разговаривал бы» и ничего не делал. Говорим об этом заранее и честно.
  if (provider === "ollama") {
    try {
      const oi = await ollamaModelInfo(settings, settings.model);
      if (oi.known && !oi.tools) {
        termEmit({
          type: "metrics",
          text:
            "⚠ Модель «" + settings.model + "» не умеет вызывать инструменты (нет capability «tools»): " +
            "она сможет только отвечать текстом, а не работать с файлами и git. " +
            "Возьми модель с поддержкой инструментов (например qwen3, llama3.1, mistral-nemo).",
        });
      }
    } catch {}
  }
  let contextRetried = false; // при переполнении контекста пробуем ещё раз с меньшим бюджетом
  // Лимит 429: не роняем раунд — ждём столько, сколько просит провайдер, и повторяем.
  let rateRetries = 0;
  // 5xx и «холодный» отказ пула: тоже повторяем ТОТ ЖЕ раунд, но с растущей паузой.
  let unavailableRetries = 0;
  // Сколько всего разрешено простоять в ожидании лимита (429) за один запуск.
  // Три паузы по 5 с лимит «8 запросов в минуту» не лечат: раньше прогон падал, и пользователь
  // писал «продолжай» руками. Ждём сами, но с потолком — чтобы не висеть вечно.
  const RATE_WAIT_BUDGET_MS = Math.max(60000, Number(process.env.AI_AGENT_RATE_WAIT_MS) || 10 * 60 * 1000);
  let rateWaitedMs = 0;
  const rateLimiter = rateLimiterFor(settings);
  let reportRetried = false; // пустой финальный текст — один раз просим итоговый отчёт
  let planNudges = 0; // «план не закрыт, а модель замолчала» — просим продолжить делом (макс. 2)
  activePlanSummary = null; // план прошлого прогона не должен влиять на этот
  // ── Роутер инструментов ──────────────────────────────────────────────────
  // Вместо «все 146 схем в каждом раунде» шлём базу + группы, нужные этой задаче
  // (routeTools из agent-core). Состав ЛИПКИЙ на всю задачу: группа, однажды
  // включённая, не исчезает на середине работы. Порядок схем всегда канонический —
  // иначе промахивается кэш префикса промпта (см. 1.5.46).
  // Роутер видит не одну последнюю фразу, а историю работы (см. 1.5.63): в «продолжай»
  // ключевых слов нет вовсе, и раньше группа прошлой задачи выпадала — набор схем
  // менялся на ходу, префикс запроса ломался и провайдер отвечал 503 cache_only_cold.
  const routerTask = routerTaskText(messages);
  // Группа → справочник агента: подключается сам, когда группа активна. Так «диета»
  // промпта ничего не теряет: длинные правила живут в гайдах и приходят ровно тогда,
  // когда нужны (браузер, система, окно приложения, облако).
  const GROUP_GUIDES = { browser: "browser", system: "system", app: "app", cloud: "yc" };
  const injectedGuides = new Set();
  const guideNotes = []; // system-сообщения с текстом гайдов (стабильный префикс)
  const stickyGroups = new Set(); // id групп, включённых в этой задаче
  const forceAllTools = !!settings.sendAllTools; // предохранитель C: «отправлять все инструменты»
  let routeInfo = null; // последний результат routeTools (метрики + предохранители)
  let activeTools = [];
  let toolsWeight = 0;
  let histBudget = 1500;
  let budgetWarned = false; // предупреждаем один раз за запуск, а не каждый раунд
  // Вес системного промпта (~8k токенов) — раньше в бюджет не входил, поэтому индикатор
  // контекста занижал заполнение и сжатие срабатывало позже, чем нужно.
  const systemWeight = estimateTokens(SYSTEM_PROMPT);
  // Объект для executeTool (findTools): включить группу на лету и посмотреть состав.
  activeToolRouter = {
    addGroups(ids) {
      let changed = false;
      for (const id of ids || []) {
        if (!id || stickyGroups.has(id)) continue;
        stickyGroups.add(id);
        changed = true;
      }
      if (changed) refreshTools();
    },
    has(id) {
      return stickyGroups.has(id);
    },
    names() {
      return activeTools.map((t) => t.function && t.function.name).filter(Boolean);
    },
    groups() {
      return [...stickyGroups];
    },
  };
  const refreshTools = () => {
    if (planMode) {
      routeInfo = null;
      activeTools = PLAN_MODE_TOOL_DEFINITIONS;
    } else {
      const baseWeight = routeTools({ text: "" }).tokens;
      // Потолок: не больше ROUTER_MAX_TOKENS и не больше того, что оставляет место
      // истории (system-промпт ~8k + минимум на диалог).
      const maxTokens = Math.max(baseWeight, Math.min(ROUTER_MAX_TOKENS, Math.max(baseWeight, budget - 12000)));
      routeInfo = routeTools({ text: routerTask, sticky: [...stickyGroups], roleGroups: role.groups, forceAll: forceAllTools, maxTokens: maxTokens });
      for (const id of routeInfo.groups) stickyGroups.add(id);
      activeTools = routeInfo.tools;
    }
    toolsWeight = activeTools.length ? estimateTokens(JSON.stringify(activeTools)) : 0;
    // Тесное окно: схемы + промпт уже занимают почти всё. Честно говорим об этом
    // один раз — иначе агент «тупеет» без объяснений (модель видит обрезанный хвост).
    if (!budgetWarned && !planMode && budget > 0 && toolsWeight + systemWeight > budget * 0.9) {
      budgetWarned = true;
      termEmit({
        type: "metrics",
        text: "⚠ Окно модели мало: схемы (~" + Math.round(toolsWeight / 1000) + "k) + системный промпт (~" + Math.round(systemWeight / 1000) + "k) занимают почти всё окно (" + budget + " т.). Возьми модель с окном побольше — иначе агент видит обрезанный контекст и работает вслепую.",
      });
    }
    histBudget = Math.max(1500, Math.floor((budget - toolsWeight - systemWeight) * 0.85)); // история + резерв 15%: сжатие успевает до переполнения
    // Справочник группы: подключаем один раз за задачу, дальше он просто едет в запросе.
    if (!planMode && routeInfo) {
      for (const gid of routeInfo.groups) {
        const gname = GROUP_GUIDES[gid];
        if (!gname || injectedGuides.has(gname)) continue;
        const text = guideReadText(gname);
        if (!text.trim()) continue;
        injectedGuides.add(gname);
        guideNotes.push({
          role: "system",
          content:
            "=== СПРАВОЧНИК АГЕНТА: \"" + gname + "\" (группа \"" + gid + "\") — следуй ему в этой задаче ===\n" + text,
        });
        termEmit({ type: "metrics", text: "📘 Подключён справочник «" + gname + "» (группа «" + gid + "»)." });
      }
    }
  };
  refreshTools();
  const ctxManager = createContextManager({
    settings,
    emit,
    planMode,
    // Память диалогов: при сжатии контекста пишем памятку в локальный дневник (по датам).
    onMemo: (m) => saveContextMemo(settings, m, emit),
  });
  // Индикатор контекста: сколько токенов занимают история + схема инструментов.
  // Отправляется в интерфейс полоской под полем ввода (видно, когда контекст подходит к концу).
  const emitContext = (hist) => {
    try {
      const histTokens = hist && hist.length ? estimateTokens(JSON.stringify(hist)) : 0;
      const used = histTokens + toolsWeight + systemWeight;
      const percent = budget > 0 ? Math.max(0, Math.min(100, Math.round((used / budget) * 100))) : 0;
      emit({ type: "context", used, budget, percent, history: histTokens, tools: toolsWeight, system: systemWeight });
    } catch {}
  };

  // Вопрос пользователю (askUser / подтверждение опасной команды).
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
  const trimmedHistory = await ctxManager.manage(messages, histBudget);
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
  // Метрики раунда: токены/кэш/TTFB. Провайдер отдаёт их только по флагу
  // stream_options.include_usage; строгий сервер может его не знать — тогда
  // выключаем флаг на весь запуск и повторяем раунд (см. обработку !res.ok).
  let includeUsage = true;
  let roundUsage = null; // { prompt, completion, cached } текущего раунда
  for (let attemptNum = 1; ; attemptNum++) {
  try {
  for (let round = 0; round < maxRounds; round++) {
    roundUsage = null; // аккумулятор токенов текущего раунда
    const roundStartedAt = Date.now();
    let roundTtfbMs = 0;
    // Пользователь остановил агента (Esc/Стоп) — не начинаем новый раунд.
    if (global.__agentStopRequested) return stopGraceful();
    // Роутер: пересобираем набор схем (группы могли добавиться в прошлом раунде).
    refreshTools();
    let collected = "";
    const toolCalls = [];
    const stripper = createThinkingStripper({ onHidden: emitThink });

    // Контекст-менеджмент: между раундами держим историю в рамках бюджета токенов.
    // Хвост (текущий виток с tool-результатами) сохраняется целиком.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
      emitContext(canonical);
    }
    // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
    // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }

    const req = buildChatRequest(settings, {
      model: settings.model,
      messages: guideNotes.length ? [canonical[0], ...guideNotes, ...canonical.slice(1)] : canonical,
      tools: activeTools,
      // Статичный префикс промпта: до этой границы ставится точка кэша, чтобы
      // динамический «паспорт проекта» не обнулял кэш на каждом витке.
      staticSystem: SYSTEM_PROMPT,
      includeUsage: includeUsage,
      // Ollama: сколько контекста выделить (num_ctx) — считает agent-core из бюджета
      // и реального окна модели, чтобы сервер не резал запрос молча.
      numCtxBudget: budget,
      modelWindow: modelWin,
    });
    // Темп: если лимит провайдера уже известен, выдерживаем паузу ЗАРАНЕЕ, а не
    // после отказа. Это главный выигрыш по времени: 429 — потерянный раунд.
    const paced = await rateLimiter.take();
    if (paced > 800) {
      termEmit({
        type: "metrics",
        text: "⏳ Держу темп провайдера: пауза " + Math.round(paced / 1000) + " с перед запросом (лимит уже известен).",
      });
    }
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: abort.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Сетевая ошибка при запросе к " + provider + ": " + e.message);
    }
    roundTtfbMs = Date.now() - roundStartedAt; // заголовки ответа = первый байт
    if (res.ok) {
      rateRetries = 0;
      unavailableRetries = 0;
    }
    if (!res.ok) {
      const detail = await readApiError(res);
      // Строгий OpenAI-совместимый сервер может не знать stream_options (мы просили им
      // токены и кэш). Это не ошибка пользователя: выключаем флаг и повторяем раунд.
      if (
        includeUsage &&
        (res.status === 400 || res.status === 422) &&
        /stream_options|include_usage|unknown|unrecognized|unsupported|extra|invalid/i.test(detail) &&
        !/context|too long|maximum|num_ctx/i.test(detail)
      ) {
        includeUsage = false;
        termEmit({
          type: "metrics",
          text: "Провайдер не понял stream_options.include_usage — отключаю (запрос без метрик токенов).",
        });
        round--;
        continue;
      }
      // Лимиты провайдера (Groq free ~7K токенов/мин): понятное объяснение вместо сырого JSON.
      // Проверяем ДО повтора: у Groq лимит по токенам, повтор бессмысленен — там свой совет.
      const friendly = friendlyRateLimitError(res.status, detail, settings);
      if (friendly) throw new Error(friendly);
      // 429 (лимит запросов): ждём столько, сколько просил провайдер, и повторяем ТОТ ЖЕ раунд.
      // Ждём САМИ — до потолка RATE_WAIT_BUDGET_MS. Раньше после трёх коротких пауз прогон
      // падал с ошибкой, и пользователю приходилось писать «продолжай» вручную — хотя всё,
      // что нужно, это подождать окно лимита.
      if (res.status === 429) {
        const info = rateLimitInfo(res.status, res.headers, detail);
        rateLimiter.note(info);
        const wantMs = Math.max(2000, Math.min(info.retryMs || 5000, 60000));
        const leftMs = RATE_WAIT_BUDGET_MS - rateWaitedMs;
        if (leftMs < 1000) {
          throw new Error(
            "API error 429: лимит провайдера на запросы. Ждал сам " + Math.round(rateWaitedMs / 1000) +
            " с, но лимит не отпускает — подожди минуту и напиши «продолжай» или выбери модель " +
            "с большим лимитом в настройках."
          );
        }
        const waitMs = Math.min(wantMs, leftMs);
        rateRetries++;
        rateWaitedMs += waitMs;
        const sec = Math.max(1, Math.round(waitMs / 1000));
        const note =
          "⏳ Лимит провайдера на запросы: жду " + sec + " с и повторю сам (попытка " + rateRetries + ")" +
          (info.rpm ? ", лимит ≈" + Math.round(info.rpm) + " запросов/мин" : "") +
          ". Писать ничего не нужно.";
        termEmit({ type: "metrics", text: note + " Всего в ожидании: " + Math.round(rateWaitedMs / 1000) + " с." });
        emit({ type: "notice", text: note });
        await new Promise((r) => setTimeout(r, waitMs));
        if (waitMs >= 15000) emit({ type: "notice", text: "▶ Продолжаю работу после лимита." });
        round--;
        continue;
      }
      // 503 и cache_only_cold: пул провайдера отклонил «холодный» запрос (принимает
      // только попадание в кэш) или перегружен. Раньше это падало сырым JSON провайдера,
      // хотя лечится повтором того же раунда: историю мы не переписываем, поэтому
      // повтор уже может попасть в кэш. Смена ключа внутри того же пула не поможет.
      {
        const cold = coldCacheInfo(res.status, detail, unavailableRetries + 1);
        if (cold) {
          if (unavailableRetries < UNAVAILABLE_MAX) {
            unavailableRetries++;
            termEmit({ type: "metrics", text: cold.text });
            await new Promise((r) => setTimeout(r, cold.waitMs));
            round--;
            continue;
          }
          throw new Error(
            cold.cold
              ? "API error 503 cache_only_cold: провайдер принимает только запрос с готовым кэшем. " +
                "Повторил " + UNAVAILABLE_MAX + " раза — пул всё ещё отказывает. Подожди 10–30 с и напиши «продолжай» " +
                "или выбери другую модель/тариф: смена ключа внутри того же бесплатного пула не поможет."
              : "API error " + res.status + ": провайдер временно недоступен. Повторил " + UNAVAILABLE_MAX +
                " раза — подожди немного и напиши «продолжай»."
          );
        }
      }
      // Переполнение контекста (частая беда локальных моделей Ollama с малым окном):
      // один раз повторяем запрос с резко урезанной историей, чтобы не падать.
      if (
        !contextRetried &&
        /context|too long|maximum|num_ctx|token/i.test(detail) &&
        budget > 3000
      ) {
        contextRetried = true;
        budget = Math.max(3000, Math.floor(budget * 0.4));
        histBudget = Math.max(1500, budget - toolsWeight - systemWeight);
        if (canonical.length > 1) {
          const sys = canonical[0];
          canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
          emitContext(canonical);
        }
        if (canonical.length > 1) {
          const sys = canonical[0];
          canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
        }
        round--;
        continue;
      }
      // 402 = Insufficient Balance: у провайдера кончились деньги. Подсказываем по-русски.
      if (res.status === 402) {
        throw new Error(
          "API error 402: Недостаточно средств на балансе провайдера (" + (settings.provider || "openai") + "). Пополни счёт или выбери другого провайдера/модель в настройках."
        );
      }
      throw new Error("API error " + res.status + ": " + detail);
    }

    await consumeProviderStream({
      response: res,
      provider,
      onText: (text) => {
        const vis = stripper.push(text);
        if (vis) {
          collected += vis;
          emit({ type: "chunk", text: vis });
        }
      },
      onToolCall: (tc) => toolCalls.push(tc),
      onThinking: emitThink,
      onUsage: (u) => {
        if (!u) return;
        roundUsage = roundUsage || { prompt: 0, completion: 0, cached: 0 };
        // Провайдеры шлют usage частями (Anthropic: вход в message_start, выход в
        // message_delta) — по каждому полю берём максимум.
        roundUsage.prompt = Math.max(roundUsage.prompt, u.prompt || 0);
        roundUsage.completion = Math.max(roundUsage.completion, u.completion || 0);
        roundUsage.cached = Math.max(roundUsage.cached, u.cached || 0);
      },
    });

    // Метрики раунда в «Консоль» (вкладка «Консоль» правой панели): без цифр
    // любая оптимизация контекста — гадание.
    {
      const estPrompt = toolsWeight + estimateTokens(JSON.stringify(canonical));
      const totalMs = Date.now() - roundStartedAt;
      const tokens =
        roundUsage && roundUsage.prompt
          ? roundUsage.prompt + "→" + roundUsage.completion
          : "≈" + estPrompt + " (провайдер не прислал)";
      const cache =
        roundUsage && roundUsage.prompt
          ? roundUsage.cached + " (" + Math.round((roundUsage.cached / roundUsage.prompt) * 100) + "%)"
          : "нет данных";
      termEmit({
        type: "metrics",
        text:
          "раунд " + (round + 1) + "/" + maxRounds +
          " · схем " + activeTools.length + " (~" + toolsWeight + " т.)" +
          (routeInfo && routeInfo.groups.length ? " · групп " + routeInfo.groups.length : "") +
          (routeInfo && routeInfo.dropped.length ? " · срезано: " + routeInfo.dropped.join(",") : "") +
          " · токены " + tokens +
          " · кэш " + cache +
          " · TTFB " + (roundTtfbMs / 1000).toFixed(1) + " с" +
          " · всего " + (totalMs / 1000).toFixed(1) + " с",
      });
    }

    const tail = stripper.finish();
    if (tail) {
      collected += tail;
      emit({ type: "chunk", text: tail });
    }
    finalText = collected;

    // Запасной способ: модель могла напечатать JSON-вызов инструмента текстом,
    // а не через tool_calls. Находим такие вызовы и выполняем их.
    // В режиме плана инструменты не выполняются вовсе — план только составляется.
    if (toolCalls.length === 0 && !planMode) {
      const fallbackCalls = extractToolCallsFromText(finalText);
      if (fallbackCalls.length) {
        for (const fc of fallbackCalls) {
          toolCalls.push({ id: genCallId(), name: fc.name, args: fc.args });
        }
        // Убираем JSON-мусор из показанного пользователю текста
        let cleaned = finalText;
        for (const fc of fallbackCalls) {
          cleaned = cleaned.split(fc.raw).join("");
        }
        cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
        if (cleaned) emit({ type: "text_override", text: cleaned });
      }
    }

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

    if (toolCalls.length === 0) {
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
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    // Нормализуем имена, назначаем стабильные id (нужны для tool-сообщений)
    // и убираем дубли: одинаковый вызов в одном раунде выполняется один раз.
    const seenCalls = new Set();
    const calls = [];
    for (const tc of toolCalls) {
      const norm = {
        id: tc.id || genCallId(),
        name: normalizeToolName(tc.name),
        args: tc.args && typeof tc.args === "object" ? tc.args : {},
        // Gemini 3.x: extra_content с thought signature нужно вернуть дословно,
        // иначе следующий раунд упадёт с 400 (missing thought_signature).
        ...(tc.extraContent ? { extraContent: tc.extraContent } : {}),
      };
      const sig = norm.name + "|" + JSON.stringify(norm.args);
      if (seenCalls.has(sig)) continue;
      seenCalls.add(sig);
      calls.push(norm);
    }
    // Предохранитель A: модель вызвала реальный инструмент, которого нет в текущем
    // наборе схем (группа не была активирована). Дотягиваем его группу — в этом и
    // следующих раундах схема будет на месте; сам вызов выполняем как обычно.
    if (!planMode && routeInfo) {
      for (const c of calls) {
        const gid = groupOfTool(c.name);
        if (!gid || stickyGroups.has(gid)) continue;
        stickyGroups.add(gid);
        refreshTools();
        termEmit({
          type: "metrics",
          text: "🔧 «" + c.name + "» вне набора схем — добавляю группу «" + gid + "» (схем станет " + activeTools.length + ").",
        });
      }
    }

    // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
    if (!calls.length) {
      if (!String(finalText || "").trim()) finalText = "Готово.";
      emit({ type: "chunk", text: finalText });
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    canonical.push({
      role: "assistant",
      content: finalText || null,
      tool_calls: calls.map((c) => {
        const call = {
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        };
        if (c.extraContent) call.extra_content = c.extraContent;
        return call;
      }),
    });

    // Батчинг: если раунд целиком состоит из независимых read-only вызовов —
    // выполняем их параллельно (экономит по раунду на каждый вызов). Любой
    // пишущий/интерактивный инструмент в раунде возвращает строгую очередь.
    if (!planMode && calls.length > 1 && calls.every((c) => PARALLEL_SAFE_TOOLS.has(c.name))) {
      for (const c of calls) emit({ type: "tool_start", name: c.name, args: c.args });
      const results = await Promise.all(
        calls.map((c) =>
          executeTool(c.name, c.args, settings).catch((e) => "Ошибка инструмента " + c.name + ": " + fmtError(e))
        )
      );
      calls.forEach((c, i) => {
        const capped = truncateText(results[i], 8000);
        emit({ type: "tool_result", name: c.name, result: capped });
        canonical.push({ role: "tool", tool_call_id: c.id, content: capped });
      });
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
      // Держим контекст в рамках бюджета: длинный вывод инструмента ужимаем
      const capped = truncateText(result, 8000);
      emit({ type: "tool_result", name: c.name, result: capped });
      canonical.push({ role: "tool", tool_call_id: c.id, content: capped });
    }
    // Остановка во время выполнения инструментов — завершаем без нового раунда.
    if (global.__agentStopRequested) return stopGraceful();
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
    if (fatal || attemptNum > AUTO_RETRY_LIMIT) throw e;
    const errText = String((e && e.message) || e).slice(0, 800);
    // Провайдер отверг stream_options уже внутри ответа (не ошибкой на заголовках) —
    // снимаем флаг: авто-повтор ниже пойдёт без него.
    if (includeUsage && /stream_options|include_usage/i.test(errText)) {
      includeUsage = false;
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "AI Developer Agent",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Напоминания о делах: проверяем раз в минуту (плюс сразу после старта, если что-то
  // уже просрочено). Таймер живёт вместе с приложением, окно может быть свёрнуто.
  // Интервал можно укоротить для живого теста: AI_AGENT_TASK_REMINDER_MS.
  const taskReminderEvery = Math.max(2000, Number(process.env.AI_AGENT_TASK_REMINDER_MS) || 60000);
  setTimeout(checkTaskReminders, Math.min(8000, taskReminderEvery));
  setInterval(checkTaskReminders, taskReminderEvery);

  // Прокси webContents.send: все события (ai:event, term:event, dev:event, github:event)
  // дополнительно транслируются клиентам мобильного моста по WebSocket.
  // Windows: без AppUserModelID уведомления приходят «от Electron» (или не приходят).
  if (process.platform === "win32") {
    try { app.setAppUserModelId("AI Developer Agent"); } catch {}
  }

  const _wcSend = mainWindow.webContents.send.bind(mainWindow.webContents);
  mainWindow.webContents.send = (ch, ev) => {
    // Клиентов теперь несколько (окно на ПК + телефоны), и прогон агента может
    // быть чужим. У событий нет привязки к переписке, поэтому помечаем их тем,
    // кто запустил прогон: иначе ответ с телефона подмешивался бы в открытый чат
    // на ПК, а плашки «сжатие контекста» и превью всплывали бы не там.
    if (ch === "ai:event" && ev && typeof ev === "object" && ev.from === undefined) {
      ev = { ...ev, from: activeRunOrigin };
    }
    try {
      mobileBridge.broadcast(ch, ev);
    } catch {}
    return _wcSend(ch, ev);
  };
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Кликабельные ссылки из чата: http(s) открываются в браузере пользователя,
  // а не в новом окне Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─────────────────────────── Пользовательский терминал (нижняя панель, как в Replit) ───────────────────────────
let userTerm = null; // { child, buf, exited, startedAt }

function termEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("term:event", ev);
}

// Показывает команду и вывод агента в нижнем терминале приложения (как Replit Agent):
// пользователь видит, что агент выполняет, даже если панель откроют позже.
function termAgentEcho(text) {
  const clean = stripAnsi(String(text || ""));
  if (!clean) return;
  if (userTerm && !userTerm.exited) {
    const lines = clean.split("\n");
    userTerm.buf.push(...lines);
    if (userTerm.buf.length > 2000) userTerm.buf.splice(0, userTerm.buf.length - 2000);
  }
  termEmit({ type: "agent", text: clean });
}

function termStart(cwd) {
  if (userTerm && !userTerm.exited) return { ok: false, error: "Терминал уже запущен" };
  const isWin = process.platform === "win32";
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/Q"] : [];
  let child = null;
  try {
    child = spawn(shell, args, {
      cwd: cwd || os.homedir(),
      detached: !isWin,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", ...agentEnv },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const rec = { child, buf: [], exited: false, startedAt: Date.now() };
  userTerm = rec;
  const push = (chunk) => {
    const text = stripAnsi(chunk.toString());
    rec.buf.push(text);
    if (rec.buf.length > 2000) rec.buf.splice(0, rec.buf.length - 2000);
    termEmit({ type: "out", text });
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code) => {
    rec.exited = true;
    termEmit({ type: "exit", code });
  });
  child.on("error", (e) => {
    rec.exited = true;
    termEmit({ type: "exit", code: null, error: e.message });
  });
  termEmit({ type: "start", cwd });
  return { ok: true, cwd };
}

function termInput(text) {
  if (!userTerm || userTerm.exited) return { ok: false, error: "Терминал не запущен. Перезапусти панель." };
  try {
    userTerm.child.stdin.write(String(text) + "\n");
    termEmit({ type: "in", text: String(text) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function termStop() {
  if (!userTerm) return { ok: false, error: "Терминал не запущен" };
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
  return { ok: true };
}

// Автодополнение команды в терминале (Tab): команды из PATH или файлы рабочей папки.
function termComplete(line) {
  const text = String(line || "");
  const cwd = agentWorkDir(loadSettings());
  const sp = text.lastIndexOf(" ");
  const token = sp >= 0 ? text.slice(sp + 1) : text;
  const base = sp >= 0 ? text.slice(0, sp + 1) : "";
  const matches = [];
  const listDir = (dir, prefix, fullPrefix) => {
    try {
      for (const e of fs.readdirSync(dir)) {
        if (!e.startsWith(prefix)) continue;
        let isDir = false;
        try { isDir = fs.statSync(path.join(dir, e)).isDirectory(); } catch {}
        matches.push(fullPrefix + e + (isDir ? "/" : ""));
      }
    } catch {}
  };
  if (!token) {
    listDir(cwd, "", ""); // пустой токен — файлы рабочей папки
  } else if (token.includes("/") || token.startsWith(".")) {
    const isAbs = path.isAbsolute(token);
    const slash = token.lastIndexOf("/");
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const filePart = slash >= 0 ? token.slice(slash + 1) : token;
    const searchDir = isAbs ? (dirPart || "/") : path.join(cwd, dirPart);
    listDir(searchDir, filePart, dirPart);
  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
    // Команд с таким префиксом нет — дополняем файлами рабочей папки (как в bash)
    if (!matches.length) listDir(cwd, token, "");
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };
}

// ─────────────────────────── IPC ───────────────────────────
ipcMain.handle("settings:get", () => loadSettings());
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

// ─────────────────────────── Проекты (до 10, переключение) ───────────────────────────
// Возвращает список проектов (свежие сверху) и id активного.
// Дела (личный список задач со сроками): панель в окне и на телефоне работают через это.
ipcMain.handle("tasks:board", () => agentStore.tasksBoard(userDataDir()));
ipcMain.handle("tasks:list", (_e, opts) => agentStore.tasksList(userDataDir(), opts || {}));
ipcMain.handle("tasks:add", (_e, input) => {
  const r = agentStore.tasksAdd(userDataDir(), input || {});
  if (r.ok) emitTasksChanged();
  return r;
});
ipcMain.handle("tasks:update", (_e, key, patch) => {
  const r = agentStore.tasksUpdate(userDataDir(), key, patch || {});
  if (r.ok) emitTasksChanged();
  return r;
});
ipcMain.handle("tasks:done", (_e, key, done) => {
  const r = agentStore.tasksDone(userDataDir(), key, done !== false);
  if (r.ok) emitTasksChanged();
  return r;
});
ipcMain.handle("tasks:delete", (_e, key) => {
  const r = agentStore.tasksDelete(userDataDir(), key);
  if (r.ok) emitTasksChanged();
  return r;
});

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
ipcMain.handle("term:status", () => ({ running: !!(userTerm && !userTerm.exited) }));
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

// ── G4F: поиск живого инстанса — указанный URL, затем типовые порты 1337 / 8080 ──
// Современный interference-API g4f живёт на 1337, старые сборки — на 8080.
// Используется кнопкой ▶ (подсказка при ошибке) и авто-подбором порта в настройках.
async function probeG4fBase(configuredBase, timeoutMs) {
  const t = timeoutMs || 2500;
  const candidates = [];
  const base = String(configuredBase || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(base)) candidates.push(base);
  for (const port of [1337, 8080]) {
    const u = "http://localhost:" + port + "/v1";
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    try {
      const res = await fetch(u + "/models", { signal: ctrl.signal });
      if (res.ok) {
        const body = await res.text().catch(() => "");
        let count = 0;
        try {
          const j = JSON.parse(body);
          const list = Array.isArray(j) ? j : (j.data || j.models || []);
          count = Array.isArray(list) ? list.length : 0;
        } catch {}
        return { base: u, count };
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  return null;
}

ipcMain.handle("g4f:probe", async (_e, opts) => {
  const found = await probeG4fBase(opts && opts.url);
  return found ? { ok: true, ...found } : { ok: false };
});

// ── G4F: тест провайдера (кнопка ▶ в настройках) — логи в консоль приложения ──
// Делается в главном процессе: здесь нет CORS и видно сырые статусы/тела ответов g4f.
ipcMain.handle("g4f:test", async (_e, opts) => {
  const log = [];
  const push = (level, text) => log.push({ level, text });
  const t0 = Date.now();
  const base = String((opts && opts.url) || "").trim().replace(/\/+$/, "");
  const provider = String((opts && opts.provider) || "").trim();
  const model = String((opts && opts.model) || "").trim();
  const fetchT = (url, init, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    return fetch(url, Object.assign({ signal: ctrl.signal, redirect: "follow" }, init || {})).finally(() => clearTimeout(t));
  };
  const textT = (res) => res.text().catch(() => "");
  push("info", "Проверка G4F: провайдер «" + (provider || "?") + "» → " + (base || "URL пуст"));
  if (!/^https?:\/\//i.test(base)) {
    push("err", "Базовый URL не заполнен или не похож на http://localhost:1337/v1 — поправь поле URL.");
    return { ok: false, log };
  }
  // 1) Список моделей
  const mUrl = base + "/models";
  try {
    const res = await fetchT(mUrl, {}, 15000);
    const body = await textT(res);
    push("info", "GET " + mUrl + " → HTTP " + res.status + " (" + (Date.now() - t0) + " мс)");
    if (!res.ok) {
      push("err", "Ответ не 2xx: " + body.slice(0, 300));
    } else {
      let arr = [];
      try {
        const j = JSON.parse(body);
        const list = Array.isArray(j) ? j : (j.data || j.models || []);
        arr = list.map((m) => (typeof m === "string" ? m : (m && (m.id || m.name)) || "")).filter(Boolean);
      } catch {}
      if (arr.length) push("ok", "Моделей отдаёт: " + arr.length + ". Первые: " + arr.slice(0, 8).join(", "));
      else push("warn", "Список моделей пуст или в неожиданном формате: " + body.slice(0, 200));
    }
  } catch (e) {
    push("err", "GET /models не прошёл: " + (e.message || String(e)) + ". Проверь, что g4f запущен («g4f api»).");
    // Подсказка: а не отвечает ли живой g4f на другом порту (1337 вместо 8080 и наоборот)?
    const alt = await probeG4fBase(base, 2500);
    if (alt && alt.base !== base) {
      push("ok", "Живой g4f найден на «" + alt.base + "» (моделей: " + alt.count + ") — а в поле URL указан «" + (base || "пусто") + "». Поправь URL, сохрани настройки и повтори тест.");
    } else if (!alt) {
      push("warn", "Живой g4f не найден ни на одном порту (1337 / 8080). Проверь, что запущен: `g4f api` (или `python -m g4f api`).");
    }
  }
  // 2) Минимальный чат-запрос: что РЕАЛЬНО отвечает провайдер
  if (provider && provider !== "default" && model) {
    const cUrl = base + "/chat/completions";
    push("info", "POST " + cUrl + " — модель «" + model + "» через провайдера «" + provider + "» (max_tokens 8)");
    const t1 = Date.now();
    try {
      const res = await fetchT(cUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider,
          messages: [{ role: "user", content: "Ответь одним словом: пинг" }],
          max_tokens: 8,
          stream: false,
        }),
      }, 30000);
      const body = await textT(res);
      if (!res.ok) {
        push("err", "HTTP " + res.status + " (" + (Date.now() - t1) + " мс): " + body.slice(0, 400));
      } else {
        let snippet = "";
        try {
          const j = JSON.parse(body);
          const c0 = j.choices && j.choices[0];
          snippet = c0 && c0.message && c0.message.content
            ? String(c0.message.content).trim().slice(0, 140)
            : (c0 && c0.text ? String(c0.text).trim().slice(0, 140) : "");
        } catch {}
        if (snippet) push("ok", "Ответ получен (" + (Date.now() - t1) + " мс): «" + snippet + "» — провайдер отвечает.");
        else push("warn", "HTTP 200, но текста в ответе нет (" + (Date.now() - t1) + " мс). Сырой ответ: " + body.slice(0, 300));
      }
    } catch (e) {
      push("err", "POST /chat/completions не прошёл: " + (e.message || String(e)));
    }
  } else if (provider === "default") {
    push("warn", "Провайдер «default» — авто-режим: проверяется только список моделей, чат-тест пропущен.");
  } else {
    push("warn", "Модель не указана — чат-тест пропущен. Выбери модель провайдера (чипы ниже) и повтори.");
  }
  push("info", "— Проверка завершена за " + (Date.now() - t0) + " мс —");
  return { ok: true, log };
});


ipcMain.handle("ai:models", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  try {
    return { ok: true, models: await fetchModels(s) };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});

ipcMain.handle("dialog:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Выберите рабочую директорию",
  });
  return r.canceled ? null : r.filePaths[0];
});

// ─────────────────────────── GitHub OAuth (device flow) + repo picker ───────────────────────────
let githubPollTimer = null;
let githubPollActive = false;
const GITHUB_API = "https://api.github.com";

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

/** Клонирует URL в workersDir и возвращает путь к папке репозитория. */
async function cloneRepoTo(url, workersDir, settings) {
  const prep = ensureWritableDir(workersDir);
  if (!prep.ok) return prep;
  workersDir = prep.dir;
  const name = repoNameFromUrl(url);
  const target = path.join(workersDir, name);
  if (fs.existsSync(target)) {
    // Пустая папка (например, от прошлой неудачной попытки клонирования) — убираем и клонируем заново.
    let empty = false;
    try {
      empty = fs.readdirSync(target).length === 0;
    } catch {}
    if (empty) {
      try {
        fs.rmdirSync(target);
      } catch (e) {
        return { ok: false, error: "Папка " + target + " пустая, но не удалось её очистить: " + (e.message || String(e)) };
      }
    } else {
      const info = await runGit(target, ["remote", "get-url", "origin"], settings);
      if (info.ok) {
        const cleanOrigin = stripUrlCreds(info.out.trim());
        if (cleanOrigin === stripUrlCreds(url)) {
          // В origin мог застрять токен (клон вручную с https://user:TOKEN@...) — убираем его из .git/config.
          if (info.out.trim() !== cleanOrigin) {
            await runGit(target, ["remote", "set-url", "origin", cleanOrigin], settings);
          }
          return { ok: true, dir: target, cloned: false, message: "Репозиторий уже есть: " + target };
        }
      }
      return { ok: false, error: "В рабочей папке уже есть папка \"" + name + "\". Удали её или выбери другую рабочую папку." };
    }
  }
  const r = await runGit(workersDir, ["clone", url, name], settings);
  if (!r.ok) {
    const denied = /permission denied|отказано в доступе|could not create work tree dir|eacces/i.test(r.err);
    if (denied) {
      // Приложение пишет в папку, а git — нет (антивирус или «Контролируемый доступ к папкам»
      // Windows блокирует именно git.exe). Пробуем запасные записываемые папки.
      const mainKey = path.resolve(workersDir).toLowerCase();
      for (const cand of cloneBaseCandidates("", settings)) {
        const prep = ensureWritableDir(cand);
        if (!prep.ok) continue;
        if (path.resolve(prep.dir).toLowerCase() === mainKey) continue;
        const fbTarget = path.join(prep.dir, name);
        if (fs.existsSync(fbTarget)) continue;
        const r2 = await runGit(prep.dir, ["clone", url, name], settings);
        if (r2.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(fbTarget, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          return {
            ok: true,
            dir: fbTarget,
            cloned: true,
            message: "Клонировано: " + fbTarget + " (в рабочей папке «" + workersDir + "» git не смог создать файлы — использована записываемая папка)",
          };
        }
      }
    }
    return {
      ok: false,
      error: r.err + (denied
        ? "\n\nGit не смог создать папку репозитория в «" + workersDir + "». Папка защищена от записи " +
          "(или доступ блокирует антивирус/OneDrive). Выбери другую рабочую директорию (📁 в панели проекта) " +
          "— например C:\\Users\\<имя>\\projects — и нажми «Выгрузить» ещё раз."
        : ""),
    };
  }
  if (stripUrlCreds(url) !== url) {
    await runGit(target, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
  }
  return { ok: true, dir: target, cloned: true, message: "Клонировано: " + target };
}

function isGitHubRepoSlug(v) {
  const s = String(v || "").trim();
  return /^[\w.-]+\/[\w.-]+$/i.test(s) && !s.includes("/") === false && s.indexOf("/") > 0;
}

function githubEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("github:event", ev);
}

async function githubApiFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function fetchGithubUser(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "AI-Developer-Agent",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

ipcMain.handle("github:user", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const u = await fetchGithubUser(s.githubToken);
  if (!u) return { ok: false, error: "Не удалось получить профиль GitHub (токен мог быть отозван)" };
  const merged = { ...s, githubLogin: u.login || s.githubLogin, githubAvatarUrl: u.avatar_url || s.githubAvatarUrl };
  saveSettings(merged);
  return { ok: true, login: u.login, avatar: u.avatar_url };
});

// ── Репозитории GitHub: список >100 шт. через пагинацию, поиск — через search API ──
function mapGithubRepo(r) {
  if (!r || typeof r.name !== "string" || !r.owner || typeof r.owner.login !== "string") return null;
  const currentLogin = loadSettings().githubLogin || "";
  return {
    slug: r.owner.login + "/" + r.name,
    name: r.name,
    owner: r.owner.login,
    full_name: r.full_name || (r.owner.login + "/" + r.name),
    url: (r.clone_url || "https://github.com/" + r.owner.login + "/" + r.name + ".git"),
    description: r.description || "",
    isPrivate: r.private || false,
    default_branch: r.default_branch || "main",
    language: r.language || "",
    updated: r.updated_at || "",
    own: currentLogin === r.owner.login,
  };
}

function ghApiHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "AI-Developer-Agent",
  };
}

async function ghApiJson(url, token) {
  try {
    const res = await fetch(url, { headers: ghApiHeaders(token) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text: (text || "").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: (e && e.message) || String(e) };
  }
}

// Страница списка «мои репозитории» (аккаунт + коллаборации + организации).
async function githubReposPage(token, page) {
  const n = Math.max(1, parseInt(page, 10) || 1);
  const url = GITHUB_API + "/user/repos?per_page=100&page=" + n + "&sort=updated&affiliation=owner,collaborator,organization_member";
  const res = await ghApiJson(url, token);
  if (!res.ok) return { ok: false, error: "GitHub API " + res.status + ": " + (res.text || res.status) };
  const data = Array.isArray(res.json) ? res.json : [];
  const repos = data.map(mapGithubRepo).filter(Boolean);
  return { ok: true, repos, hasMore: repos.length === 100 };
}

let githubOrgsCache = { at: 0, list: [] };
async function githubUserOrgs(token) {
  if (Date.now() - githubOrgsCache.at < 5 * 60 * 1000) return githubOrgsCache.list;
  try {
    const res = await ghApiJson(GITHUB_API + "/user/orgs?per_page=100", token);
    if (res.ok && Array.isArray(res.json)) {
      githubOrgsCache = { at: Date.now(), list: res.json.map((o) => o && o.login).filter(Boolean) };
    }
  } catch {}
  return githubOrgsCache.list;
}

async function githubLoginFor(token) {
  const s = loadSettings();
  if (s.githubLogin) return s.githubLogin;
  const u = await fetchGithubUser(token);
  if (u && u.login) {
    try { saveSettings({ ...loadSettings(), githubLogin: u.login }); } catch {}
    return u.login;
  }
  return "";
}

// Поиск по имени: ищем параллельно по аккаунту и его организациям (приватные репозитории
// видны в поиске только со scope-квалификатором user:/org:), затем сливаем и сортируем.
const ghSearchCache = new Map(); // key: нормализованный запрос -> { at, res } (кэш 45 c)
async function githubReposSearch(token, q) {
  const key = String(q || "").trim().toLowerCase();
  const hit = ghSearchCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.res;
  const login = await githubLoginFor(token);
  const orgs = (await githubUserOrgs(token)).slice(0, 8);
  const scopes = [];
  if (login) scopes.push("user:" + login);
  for (const o of orgs) scopes.push("org:" + o);
  const collected = [];
  const jobs = scopes.map(async (scope) => {
    const url = GITHUB_API + "/search/repositories?q=" + encodeURIComponent(String(q).trim() + " in:name " + scope) +
      "&per_page=100&sort=updated&order=desc";
    const res = await ghApiJson(url, token);
    if (res.ok && res.json && Array.isArray(res.json.items)) {
      for (const it of res.json.items) collected.push(it);
    }
    return res.status;
  });
  await Promise.all(jobs);
  const seen = new Set();
  const repos = [];
  for (const it of collected) {
    const r = mapGithubRepo(it);
    if (!r || seen.has(r.slug)) continue;
    seen.add(r.slug);
    repos.push(r);
  }
  repos.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const capped = repos.slice(0, 150);
  const res = { ok: true, repos: capped, hasMore: false, total: repos.length, searched: true };
  ghSearchCache.set(key, { at: Date.now(), res });
  return res;
}

// Точный slug owner/repo — одним запросом (не зависит от списка из 100 и от принадлежности).
async function githubRepoBySlug(token, slug) {
  const res = await ghApiJson(GITHUB_API + "/repos/" + String(slug).trim(), token);
  if (!res.ok) return { ok: false, error: "Репозиторий не найден или нет к нему доступа: " + slug + " (GitHub API " + res.status + ")" };
  const r = mapGithubRepo(res.json);
  return r ? { ok: true, repo: r } : { ok: false, error: "Неожиданный ответ GitHub API" };
}

// База для клонирования: явно указанная папка (создаётся, если её ещё нет) → сохранённая
// рабочая директория → домашняя. Никогда не «теряем» клон в неожиданном месте.
// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
// Кандидаты папок для клонирования по порядку предпочтения (без повторов).
function cloneBaseCandidates(workingDir, s) {
  const candidates = [];
  const push = (d) => {
    const t = typeof d === "string" && d.trim() ? d.trim() : "";
    if (t) candidates.push(t);
  };
  push(workingDir);
  if (s) push(s.workingDir);
  push(os.homedir());
  try { push(app.getPath("documents")); } catch {}
  push(os.tmpdir());
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
function pickCloneBase(workingDir, s) {
  for (const c of cloneBaseCandidates(workingDir, s)) {
    const prep = ensureWritableDir(c);
    if (prep.ok) return prep; // { ok: true, dir }
  }
  return {
    ok: false,
    error: "Не нашлось ни одной папки, куда можно писать, для клонирования. Проверены: " + cloneBaseCandidates(workingDir, s).join(", "),
  };
}

// Публикация локальной папки как НОВОГО репозитория GitHub: создать репозиторий + первый push.
// dir — папка проекта (создаётся, если её ещё нет). opts: { name, description, private, message }.
async function publishLocalToGithub(dir, s, opts) {
  opts = opts || {};
  const name = String(opts.name || "").trim();
  const description = String(opts.description || "").trim().slice(0, 300);
  const isPrivate = opts.private !== false; // приватный по умолчанию — безопаснее
  if (!s || !s.githubToken) return { ok: false, error: "GitHub не подключён — подключи аккаунт в Настройках → GitHub." };
  if (!name) return { ok: false, error: "Укажи имя нового репозитория." };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.length > 100) {
    return { ok: false, error: "Недопустимое имя репозитория «" + name + "»: только буквы, цифры, точка, дефис и подчёркивание (без пробелов, не начинается с точки)." };
  }
  const prep = ensureWritableDir(dir);
  if (!prep.ok) return prep;
  dir = prep.dir;
  // Если в папке уже есть origin — это существующий репозиторий, а не «новый»: пусть используют Push.
  const originR = await runGit(dir, ["remote", "get-url", "origin"], s);
  if (originR.ok && String(originR.out || "").trim()) {
    return { ok: false, error: "В папке уже настроен удалённый репозиторий origin: " + stripUrlCreds(String(originR.out).trim()) + ". Используй Push во вкладке «Изменения», а не публикацию нового репозитория." };
  }
  // Владелец (аккаунт, куда создаём)
  let login = String(s.githubLogin || "").trim();
  if (!login) {
    const u = await fetchGithubUser(s.githubToken);
    if (u && u.login) login = String(u.login).trim();
  }
  if (!login) return { ok: false, error: "Не удалось определить GitHub-логин — токен мог быть отозван. Подключи GitHub заново в Настройках." };
  // git init, если папка ещё не репозиторий
  const inRepo = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
  if (!inRepo.ok) {
    let initR = await runGit(dir, ["init", "-b", "main"], s);
    if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые версии git без -b
    if (!initR.ok) return { ok: false, error: "git init не удался: " + initR.err };
  }
  // Ветка для публикации: текущая (если репозиторий с коммитами), иначе создаём main.
  let branch = "main";
  const brR = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], s);
  const curBranch = brR.ok ? String(brR.out || "").trim() : "";
  if (curBranch && curBranch !== "HEAD") {
    branch = curBranch;
    if (branch === "master") {
      const rn = await runGit(dir, ["branch", "-M", "main"], s); // переименовываем в main
      if (rn.ok) branch = "main";
    }
  } else {
    const co = await runGit(dir, ["checkout", "-b", "main"], s);
    if (!co.ok && !(await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok) {
      return { ok: false, error: "Не удалось создать ветку main: " + co.err };
    }
  }
  // Создаём репозиторий на GitHub (POST /user/repos)
  let createRes;
  try {
    createRes = await fetch(GITHUB_API + "/user/repos", {
      method: "POST",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ name, description, private: isPrivate, auto_init: false }),
    });
  } catch (e) {
    return { ok: false, error: "Ошибка запроса к GitHub API: " + (e && e.message ? e.message : String(e)) };
  }
  const createText = await createRes.text().catch(() => "");
  let createJson = null;
  try { createJson = JSON.parse(createText); } catch {}
  if (createRes.status !== 201) {
    let reason = "GitHub API " + createRes.status + ": " + String(createText || "").slice(0, 200);
    if (createJson && createJson.message) reason = String(createJson.message);
    if (createRes.status === 422) {
      reason = "Не удалось создать репозиторий «" + name + "»: он уже существует на этом аккаунте или имя недопустимо.";
    }
    return { ok: false, error: reason };
  }
  const repoUrl = (createJson && createJson.html_url) || ("https://github.com/" + login + "/" + name);
  const cloneUrl = (createJson && createJson.clone_url) || ("https://github.com/" + login + "/" + name + ".git");
  // remote origin (в URL нет токена — авторизация идёт заголовком Basic в runGit)
  const addR = await runGit(dir, ["remote", "add", "origin", cloneUrl], s);
  if (!addR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо не удалось добавить remote origin: " + addR.err };
  // Коммитим файлы, если есть что коммитить (первый коммит или незакоммиченные изменения)
  const stR = await runGit(dir, ["status", "--porcelain"], s);
  const headOk = (await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok;
  const changes = stR.ok && !!String(stR.out || "").trim();
  if (changes) {
    const addAll = await stageAllSafe(dir, s);
    if (!addAll.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\ngit add не удался: " + addAll.err };
    const msg = String(opts.message || "").trim() || "Initial commit";
    const cm = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
    if (!cm.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНе удалось создать коммит: " + cm.err };
  } else if (!headOk) {
    return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо в папке нет файлов — нечего коммитить. Добавь файлы и нажми «Опубликовать» снова." };
  }
  // Пуш (авторизация — заголовок Basic, который runGit подставляет из githubToken)
  const pushR = await runGit(dir, ["push", "-u", "origin", branch], s);
  if (!pushR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nPush не удался: " + pushR.err };
  // Новый пустой репозиторий GitHub по умолчанию может указывать на master —
  // переключаем ветку по умолчанию на опубликованную (иначе репозиторий откроется «пустым»).
  try {
    await fetch(GITHUB_API + "/repos/" + encodeURIComponent(login + "/" + name), {
      method: "PATCH",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ default_branch: branch }),
    });
  } catch {}
  // Запоминаем как активный репозиторий (панель проекта следует за ним)
  try { saveSettings({ ...loadSettings(), githubRepoSlug: login + "/" + name, githubRepoDir: dir }); } catch {}
  lastAgentRepoDir = dir;
  clonedRepoPending = true; // следующий ответ агента начнётся с анализа опубликованного проекта
  return {
    ok: true,
    slug: login + "/" + name,
    url: repoUrl,
    dir,
    message: "Создан репозиторий " + login + "/" + name + (isPrivate ? " (приватный)" : "") + " и выгружено на GitHub:\n" + repoUrl + "\nВетка: " + branch + ".",
  };
}

// Создать НОВЫЙ репозиторий на GitHub и выгрузить в него папку проекта (первый push).
ipcMain.handle("github:publish", async (_e, opts) => {
  const s = loadSettings();
  opts = opts || {};
  const reqDir = opts.dir && typeof opts.dir === "string" ? opts.dir.trim() : "";
  const dir = reqDir ? (sanitizeDir(reqDir) || reqDir) : agentWorkDir(s);
  const res = await publishLocalToGithub(dir, s, opts);
  if (res.ok) githubEmit({ type: "published", slug: res.slug, dir: res.dir, url: res.url });
  return res;
});

ipcMain.handle("github:repos", async (_e, opts) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  opts = opts || {};
  const query = String(opts.query || "").trim();
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const res = query ? await githubReposSearch(s.githubToken, query) : await githubReposPage(s.githubToken, page);
  if (!res.ok) return res;
  return { ok: true, repos: res.repos, query, page: query ? 1 : page, hasMore: !query && !!res.hasMore, total: res.total || res.repos.length };
});

ipcMain.handle("github:selectRepo", async (_e, repoSlug, workingDir) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  const base = pickCloneBase(workingDir, s);
  if (!base.ok) return base;
  const cloneResult = await cloneRepoTo(bySlug.repo.url, base.dir, s);
  if (!cloneResult.ok) return cloneResult;
  const merged = { ...s, githubRepoSlug: slug, githubRepoDir: cloneResult.dir };
  saveSettings(merged);
  clonedRepoPending = true; // следующий ответ агента начнётся с анализа выбранного репозитория
  return { ok: true, slug: slug, dir: cloneResult.dir, cloned: cloneResult.cloned, message: cloneResult.message };
});

// Выбор репозитория БЕЗ клонирования: строка помечается, а клонирует уже явная кнопка «⬇ Выгрузить»
// (github:selectRepo) в рабочую директорию.
ipcMain.handle("github:pickRepo", async (_e, repoSlug) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  saveSettings({ ...s, githubRepoSlug: slug, githubRepoDir: "" });
  return { ok: true, slug, repo: { name: bySlug.repo.name, owner: bySlug.repo.owner } };
});

ipcMain.handle("github:selectedRepo", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  if (!s.githubRepoSlug) return { ok: true, slug: null, dir: null };
  let dir = s.githubRepoDir && fs.existsSync(s.githubRepoDir) ? s.githubRepoDir : null;
  if (!dir) {
    // Репозиторий может быть только «выбран» (кнопка «⬇ Выгрузить» ещё не нажата) — папки нет,
    // тогда возвращаем null, и интерфейс покажет кнопку «⬇ Выгрузить».
    const base = s.workingDir && fs.existsSync(s.workingDir) ? s.workingDir : os.homedir();
    const name = repoNameFromUrl("https://github.com/" + s.githubRepoSlug + ".git");
    const cand = path.join(base, name);
    if (fs.existsSync(cand)) dir = cand;
  }
  return { ok: true, slug: s.githubRepoSlug, dir };
});

ipcMain.handle("github:unselectRepo", async () => {
  const merged = { ...loadSettings(), githubRepoSlug: "", githubRepoDir: "" };
  saveSettings(merged);
  return { ok: true };
});

async function readBody(res) { return (await res.text().catch(() => "")); }

ipcMain.handle("github:disconnect", () => {
  const merged = { ...loadSettings(), githubToken: "", githubLogin: "", githubAvatarUrl: "" };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("github:deviceCancel", () => {
  githubPollActive = false;
  if (githubPollTimer) { clearTimeout(githubPollTimer); githubPollTimer = null; }
  return true;
});

ipcMain.handle("github:deviceStart", async () => {
  const s = loadSettings();
  const clientId = (s.githubClientId || "").trim();
  if (!clientId) {
    return {
      ok: false,
      error:
        "Не указан Client ID OAuth-приложения. Создай приложение на github.com/settings/applications/new и вставь Client ID в настройки.",
    };
  }
  if (githubPollActive) return { ok: false, error: "Авторизация уже запущена. Сначала закрой текущее окно кода." };

  const { status, json } = await githubApiFetch("https://github.com/login/device/code", {
    client_id: clientId,
    scope: "repo",
  });
  if (status !== 200 || !json || !json.device_code) {
    return {
      ok: false,
      error: "GitHub не выдал код устройства: " + ((json && (json.error_description || json.error)) || "HTTP " + status),
    };
  }

  githubPollActive = true;
  const { device_code, user_code, verification_uri, expires_in, interval } = json;
  const deadline = Date.now() + (expires_in || 900) * 1000;

  const poll = async () => {
    if (!githubPollActive) return;
    if (Date.now() > deadline) {
      githubPollActive = false;
      githubEmit({ type: "expired", message: "Код истёк" });
      return;
    }
    const r = await githubApiFetch("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (!githubPollActive) return;
    if (r.json && r.json.access_token) {
      githubPollActive = false;
      const token = r.json.access_token;
      const u = await fetchGithubUser(token);
      const merged = {
        ...loadSettings(),
        githubToken: token,
        githubLogin: (u && u.login) || "",
        githubAvatarUrl: (u && u.avatar_url) || "",
      };
      saveSettings(merged);
      githubEmit({ type: "done", login: merged.githubLogin, avatar: merged.githubAvatarUrl });
      return;
    }
    const err = r.json && r.json.error;
    if (err === "authorization_pending" || err === "slow_down") {
      const wait = ((r.json && r.json.interval) || interval || 5) * 1000 + (err === "slow_down" ? 5000 : 0);
      githubPollTimer = setTimeout(poll, wait);
      return;
    }
    githubPollActive = false;
    githubEmit({
      type: "error",
      message: (r.json && (r.json.error_description || r.json.error)) || "Ошибка авторизации",
    });
  };

  githubPollTimer = setTimeout(poll, 1000);
  return { ok: true, user_code, verification_uri, expires_in: expires_in || 900 };
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
  cloneRepoTo,
  pickCloneBase,
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
  if (userTerm) {
    const rec = userTerm;
    userTerm = null;
    bgKill(rec);
  }
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

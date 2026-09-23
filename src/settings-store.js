"use strict";

/* ─── Настройки, подключения и история чатов ──────────────────────────────────
   Вынесено из main.js (этап B, часть 5). Здесь лежит всё, что описывает состояние
   приложения на диске:

     • схема настроек (DEFAULT_SETTINGS) и миграции старых версий (normalizeSettings):
       provider "external" → "openai", единственный URL с ключом → первое подключение,
       рабочая папка → первый проект;
     • чтение и запись: loadSettings/saveSettings — секреты уезжают в зашифрованный
       secrets.json, в settings.json остаётся всё прочее;
     • OpenAI-совместимые подключения: список рабочих, кулдаун провинившегося ключа
       и переключение по кругу при ошибке баланса или лимита;
     • история чатов: loadChats/saveChats с резервной копией и атомарной записью —
       внезапное закрытие приложения больше не оставляет обрезанный chats.json.

   Наружу отдаются только функции: состояние на диске, а не в памяти, поэтому
   замороженных копий здесь нет. Применение настроек к живым подсистемам (окружение
   агента, профиль браузера, журнал действий) остаётся в оболочке и приходит
   аргументами — этот модуль только читает и пишет файлы.

   Путь к папке приложения (app) приходит снаружи: в тестах он подставной. */

function createSettingsStore(deps) {
  const { fs, path, os, app, secrets, audit, toolPolicy, vault, applyAgentEnv, applyBrowserSettings } = deps;

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
  // Кому выдана каждая переменная агента: { ИМЯ: ["terminal", "git", "*"] }.
  // Пусто (нет записи) — переменная доходит до всех команд агента, как раньше.
  agentEnvScopes: {},
  projects: [], // список проектов (до 10): { id, name, dir, createdAt, lastOpened }

  // Мобильный доступ: мост по LAN с PIN-кодом (телефон в той же Wi-Fi сети).
  mobileEnabled: false,
  mobilePort: 9090,
  mobilePin: "",
  // Какой адрес показывать телефону (QR-код и список адресов). Автоопределение берёт
  // первый LAN-адрес ПК, а у машины их обычно несколько (Hyper-V, WSL, Docker) — и
  // телефон уходит на недостижимый. Здесь адрес задаётся явно.
  mobileHost: "192.168.1.72",
  // Вспомогательная модель (второй ключ OpenRouter): зрение + генерация картинок
  visionEnabled: false,
  visionAuto: true,
  visionUrl: "https://openrouter.ai/api/v1",
  visionKey: "",
  visionModel: "",
  imageModel: "",
  defaultRole: "dev", // роль новых чатов: dev / assistant / manager / researcher
  taskReminders: true, // напоминать о делах в срок, пока приложение открыто
  taskAuto: true, // дела с отметкой «выполняет агент» запускаются сами по сроку
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
  // Долгая работа миссиями: цель, план, шаги и журнал лежат файлами в рабочей папке
  // (.agent/missions/<id>/), прогон идёт батчами по 25 раундов и переживает перезапуск.
  longWork: true, // по умолчанию включено: без этого агент умирает на 26-м раунде
  longWorkHours: 8, // часов на одну миссию — как рабочий день, потом пауза и продолжение
  longWorkRounds: 600, // раундов на миссию (батчами)
  longWorkAutoContinue: 6, // сколько раз приложение само продолжает после обрыва/ошибки
  // Файлы работы рядом с проектом (.agent/): задачи и контекст агент ведёт сам.
  // Работа на 8 часов не имеет права жить только в памяти процесса — по этим файлам
  // человек видит, чем занят агент, и по ним же работу можно поднять заново.
  agentWorkFiles: true,

  // Куда класть работу агента. Пусто — ПРЕЖНИЕ места: миссии и прогоны в `.agent/`
  // рядом с проектом, дела — в папке приложения. Выбрана папка — файлы уезжают туда,
  // а у миссий внутри заводится подпапка проекта (иначе миссии двух проектов
  // смешались бы). Существующие файлы приложение НИКОГДА не переносит: обновление
  // не имеет права потерять работу на ровном месте, человек сам решает, что со
  // старым делать. Раскладку считает src/agent-data.js — единственная точка правды.
  missionsDir: "",
  tasksDir: "",
  // При первом запуске приложение ОДИН раз спрашивает, где держать миссии, прогоны и
  // дела (окно «Куда класть работу агента?»). "ask" — ещё не спросили, "done" —
  // человек ответил (выбрал папки или сказал «оставить как было»). Больше не
  // пристаём: повторный вопрос после каждого запуска — это не забота, а помеха.
  firstRunSetup: "ask",

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
  // Папки работы агента: путь из настроек уезжает в path.join, поэтому не-строка
  // (число, объект, обрезанный файл настроек) превратила бы раскладку в «папку с
  // именем [object Object]». Лишние пробелы и хвостовые разделители снимаем здесь
  // же: иначе в панели настроек путь выглядел бы сломанным («D:\\work\\»).
  s.missionsDir = typeof s.missionsDir === "string" ? s.missionsDir.trim().replace(/[\\/]+$/, "") : "";
  s.tasksDir = typeof s.tasksDir === "string" ? s.tasksDir.trim().replace(/[\\/]+$/, "") : "";
  // Приглашение первого запуска: значение — только "ask" или "done"; всё прочее
  // (мусор из файла, старые версии) читается как «ещё не спросили».
  if (s.firstRunSetup !== "done") s.firstRunSetup = "ask";
  // Кому выданы переменные агента: мусор и опечатки в именах ограничений
  // отбрасываются политикой (и тогда переменная не выдаётся никому — см. tool-policy.js).
  s.agentEnvScopes = toolPolicy.normalizeScopes(s.agentEnvScopes);
  // Пароли сайтов: чистка мусора и дублей (пустые/битые записи отбрасываются).
  s.sitePasswords = vault.sanitizeList(s.sitePasswords);
  return s;
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
    // Модель — принадлежность подключения: берём её как есть, в том числе пустой.
    // Раньше пустая модель нового подключения оставляла модель прошлого — и запрос
    // уходил с чужой моделью («сохранённая модель подменилась на другую»). Так же
    // поступает ручной выбор в окне (applyOpenaiProfile).
    s.openaiModel = next.model || "";
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
  return {
    DEFAULT_SETTINGS,
    normalizeSettings,
    loadSettings,
    saveSettings,
    loadChats,
    saveChats,
    openaiProfilesList,
    switchOpenaiProfile,
  };
}

module.exports = { createSettingsStore };

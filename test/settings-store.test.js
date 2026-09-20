"use strict";

/* ── Хранилище настроек, подключений и истории чатов (src/settings-store.js) ───
   Запуск: node test/settings-store.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 5). Здесь лежит всё, что описывает
   состояние приложения на диске: схема настроек и миграции старых версий, чтение
   и запись (секреты — отдельным зашифрованным файлом), OpenAI-подключения с
   кулдауном и история чатов с резервной копией.

   Почему проверки поведенческие, а не «строка на месте»: ошибки тут тихие и
   дорогие. Миграция, срабатывающая при каждом чтении, воскрешает профили и
   подключения, которые человек удалил. Забытый разделитель секретов оставляет
   API-ключ в открытом settings.json. Неатомарная запись чатов при падении
   приложения оставляет обрезанный chats.json — и вся история выглядит удалённой.
   Поэтому модуль водится по-настоящему: настоящие файлы на диске, настоящий
   модуль секретов, настоящие политика и хранилище паролей. Сети в тесте нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MAIN_SRC = read("src", "main.js");
// Единственное прямое чтение модуля здесь — проверка «код живёт там, где сказано».
const STORE_SRC = read("src", "settings-store.js");

const secrets = require(path.join(ROOT, "src", "secrets.js"));
const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));
const vault = require(path.join(ROOT, "src", "vault.js"));

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* Собираем НАСТОЯЩИЙ модуль его же фабрикой: так же, как это делает main.js.
   Файлы — настоящие, в отдельной временной папке. */
function build(o) {
  const opts = o || {};
  const dir = opts.dir || tmp("settings-store-");
  // Как в приложении: и настройки, и секреты лежат в папке приложения.
  const appDir = path.join(dir, "userData");
  if (!opts.noDir) fs.mkdirSync(appDir, { recursive: true });
  secrets.init(path.join(appDir, "secrets.json"));
  const seen = { agentEnv: [], browser: [], audit: [] };
  const { createSettingsStore } = require(path.join(ROOT, "src", "settings-store.js"));
  const store = createSettingsStore({
    fs,
    path,
    os,
    app: { getPath: (what) => path.join(dir, String(what || "userData")) },
    secrets,
    audit: { setEnabled: (v) => seen.audit.push(v) },
    toolPolicy,
    vault,
    applyAgentEnv: (s) => seen.agentEnv.push(s),
    applyBrowserSettings: (s) => seen.browser.push(s),
  });
  return {
    store,
    dir,
    appDir,
    seen,
    settingsFile: path.join(appDir, "settings.json"),
    chatsFile: path.join(appDir, "chats.json"),
    secretsFile: path.join(appDir, "secrets.json"),
  };
}

const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
const readRaw = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

(async () => {
  console.log("\n[1] Схема настроек и миграции старых версий");

  await test("пустая папка: настройки по умолчанию и рабочая папка — домашняя", () => {
    const env = build();
    const s = env.store.loadSettings();
    assert.strictEqual(s.provider, "ollama", "провайдер по умолчанию не тот: " + s.provider);
    assert.strictEqual(s.workingDir, os.homedir(), "рабочая папка по умолчанию не домашняя: " + s.workingDir);
    assert.strictEqual(s.auditLog, true, "журнал действий по умолчанию выключен");
    assert.strictEqual(s.contextMemory, false, "память диалогов включена без согласия пользователя");
    assert.strictEqual(s.longWork, true, "долгая работа выключена по умолчанию — агент умрёт на 26-м раунде");
    assert.strictEqual(s.allowAgentPush, false, "агенту разрешён push в GitHub по умолчанию");
    assert.strictEqual(s.mailAllowAgentSend, false, "агенту разрешена отправка писем по умолчанию");
    assert.strictEqual(s.ycAllowAgentCreate, false, "агенту разрешено создавать ресурсы в облаке по умолчанию");
    assert.ok(fs.existsSync(env.settingsFile) === false, "чтение настроек создало файл");
  });

  await test("миграция: provider «external» и старые поля становятся openai-подключением", () => {
    const env = build();
    writeJson(env.settingsFile, { provider: "external", externalUrl: "https://api.deepseek.com/v1", apiKey: "sk-old" });
    const s = env.store.loadSettings();
    assert.strictEqual(s.provider, "openai", "старый провайдер не переехал: " + s.provider);
    assert.strictEqual(s.openaiUrl, "https://api.deepseek.com/v1", "старый URL потерян: " + s.openaiUrl);
    assert.strictEqual(s.openaiApiKey, "sk-old", "старый ключ потерян");
    assert.strictEqual(s.openaiProfiles.length, 1, "подключение не заведено: " + JSON.stringify(s.openaiProfiles));
    assert.strictEqual(s.openaiProfiles[0].name, "api.deepseek.com", "имя подключения собрано не из адреса: " + s.openaiProfiles[0].name);
    assert.strictEqual(s.openaiActiveProfile, "p-main", "активное подключение не выбрано");
  });

  await test("миграция: рабочая папка становится первым проектом, имя — из папки", () => {
    const env = build();
    writeJson(env.settingsFile, { workingDir: path.join(os.homedir(), "projects", "мой-проект") });
    const s = env.store.loadSettings();
    assert.strictEqual(s.projects.length, 1, "проект не заведён: " + JSON.stringify(s.projects));
    assert.strictEqual(s.projects[0].name, "мой-проект", "имя проекта не из папки: " + s.projects[0].name);
    assert.strictEqual(s.activeProjectId, "p-main", "активный проект не выбран");
    assert.strictEqual(s.projects[0].dir, path.join(os.homedir(), "projects", "мой-проект"), "папка проекта потеряна");
  });

  await test("миграция не воскрешает удалённое: пустой список подключений остаётся пустым", () => {
    // Если бы миграция срабатывала при каждом чтении, удалённые человеком
    // подключения возвращались бы после каждого перезапуска.
    const env = build();
    writeJson(env.settingsFile, { openaiUrl: "https://api.groq.com/openai/v1", openaiApiKey: "sk-1", openaiProfiles: [], openaiActiveProfile: "" });
    const s = env.store.loadSettings();
    assert.deepStrictEqual(s.openaiProfiles, [], "удалённое подключение воскресло: " + JSON.stringify(s.openaiProfiles));
    assert.strictEqual(s.openaiActiveProfile, "", "активное подключение вернулось само");
  });

  await test("мусор в настройках: выдача переменных чистится политикой, пароли — хранилищем", () => {
    const env = build();
    writeJson(env.settingsFile, {
      agentEnvScopes: { KEY: ["terminal", "выдумка", 42], OTHER: "не массив" },
      sitePasswords: [{ id: "", name: "", password: "" }, { id: "1", name: "сайт", url: "https://x", login: "", password: "p", note: "" }],
    });
    const s = env.store.loadSettings();
    assert.deepStrictEqual(s.agentEnvScopes.KEY, ["terminal"], "мусор в выдаче остался: " + JSON.stringify(s.agentEnvScopes));
    // Пустой список — это «переменная не доходит ни до кого» (правило политики),
    // а не «доходит до всех»: опечатка не должна выдавать секрет всем подряд.
    assert.deepStrictEqual(s.agentEnvScopes.OTHER, [], "битая выдача не сведена к «никому»: " + JSON.stringify(s.agentEnvScopes.OTHER));
    assert.strictEqual(s.sitePasswords.length, 1, "пустые записи паролей не отброшены: " + JSON.stringify(s.sitePasswords));
  });

  await test("битый файл настроек: читаются умолчания, а не пустой объект", () => {
    const env = build();
    fs.writeFileSync(env.settingsFile, "{ это не json", "utf8");
    const s = env.store.loadSettings();
    assert.strictEqual(s.provider, "ollama", "битый файл сломал чтение: " + JSON.stringify(s).slice(0, 120));
    assert.strictEqual(s.futureKey, undefined, "в умолчаниях появился мусор");
  });

  await test("чтение настроек применяет их к живым подсистемам (окружение, браузер, журнал)", () => {
    const env = build();
    writeJson(env.settingsFile, { auditLog: false, browserProfile: false });
    env.store.loadSettings();
    assert.deepStrictEqual(env.seen.audit, [false], "журнал действий не выключен по настройке: " + JSON.stringify(env.seen.audit));
    assert.strictEqual(env.seen.agentEnv.length, 1, "окружение агента не пересобрано при чтении настроек");
    assert.strictEqual(env.seen.browser.length, 1, "профиль браузера не применён при чтении настроек");
  });

  console.log("\n[2] Секреты не остаются в открытом файле");

  await test("запись: ключи, токены и PIN уходят в secrets.json, в settings.json их нет", () => {
    const env = build();
    const s = env.store.loadSettings();
    env.store.saveSettings({
      ...s,
      openaiApiKey: "sk-secret-key",
      githubToken: "ghp_secret_token",
      mobilePin: "4821",
      sitePasswords: [{ id: "1", name: "сайт", url: "https://x", login: "u", password: "пароль-наружу-нельзя", note: "" }],
    });
    const raw = readRaw(env.settingsFile);
    assert.ok(raw.length > 0, "настройки не записались");
    for (const secret of ["sk-secret-key", "ghp_secret_token", "4821", "пароль-наружу-нельзя"]) {
      assert.strictEqual(raw.indexOf(secret), -1, "секрет остался в открытом settings.json: " + secret);
    }
    assert.ok(readRaw(env.secretsFile).length > 0, "секреты не записались в свой файл");
    assert.ok(/"provider": "ollama"/.test(raw), "в открытом файле не осталось обычных настроек");
  });

  await test("чтение: секреты возвращаются на место, обычные настройки не подменяются", () => {
    const env = build();
    env.store.saveSettings({ ...env.store.loadSettings(), openaiApiKey: "sk-secret-key", githubToken: "ghp_tok", model: "qwen3:8b" });
    const s = env.store.loadSettings();
    assert.strictEqual(s.openaiApiKey, "sk-secret-key", "ключ не вернулся из секретов: " + s.openaiApiKey);
    assert.strictEqual(s.githubToken, "ghp_tok", "токен не вернулся из секретов");
    assert.strictEqual(s.model, "qwen3:8b", "обычная настройка потеряна: " + s.model);
  });

  await test("секреты-объекты: переменные агента и подключения переживают запись и чтение", () => {
    const env = build();
    const s = env.store.loadSettings();
    const profiles = [{ id: "p1", name: "groq", url: "https://api.groq.com/openai/v1", apiKey: "gsk_1", model: "llama", project: "" }];
    env.store.saveSettings({ ...s, agentEnv: { MY_KEY: "значение-1" }, openaiProfiles: profiles, openaiActiveProfile: "p1" });
    const back = env.store.loadSettings();
    assert.deepStrictEqual(back.agentEnv, { MY_KEY: "значение-1" }, "переменные агента потерялись: " + JSON.stringify(back.agentEnv));
    assert.strictEqual(back.openaiProfiles.length, 1, "подключения потерялись");
    assert.strictEqual(back.openaiProfiles[0].apiKey, "gsk_1", "ключ подключения потерялся");
    assert.strictEqual(readRaw(env.settingsFile).indexOf("gsk_1"), -1, "ключ подключения остался в открытом файле");
  });

  console.log("\n[3] История чатов: атомарная запись и резервная копия");

  await test("запись: нет .tmp, есть .bak, основной файл читается", () => {
    const env = build();
    const data = { chats: [{ id: "a", messages: [{ role: "user", content: "1" }] }], activeId: "a" };
    env.store.saveChats(data);
    assert.ok(fs.existsSync(env.chatsFile), "нет chats.json");
    assert.ok(!fs.existsSync(env.chatsFile + ".tmp"), "остался временный файл chats.json.tmp");
    assert.deepStrictEqual(env.store.loadChats(), data, "прочиталось не то, что записали");
    env.store.saveChats({ chats: [{ id: "b", messages: [] }], activeId: "b" });
    assert.ok(fs.existsSync(env.chatsFile + ".bak"), "нет резервной копии после второй записи");
    assert.strictEqual(env.store.loadChats().activeId, "b", "после второй записи читается старое");
  });

  await test("битый основной файл: история восстанавливается из .bak", () => {
    const env = build();
    env.store.saveChats({ chats: [{ id: "a", messages: [] }], activeId: "a" });
    env.store.saveChats({ chats: [{ id: "b", messages: [] }], activeId: "b" });
    fs.writeFileSync(env.chatsFile, "{\"chats\": [ обрезано", "utf8");
    const back = env.store.loadChats();
    assert.strictEqual(back.activeId, "a", "история не поднялась из резервной копии: " + JSON.stringify(back));
  });

  await test("оба файла битые: пустое хранилище, а не падение окна", () => {
    const env = build();
    fs.writeFileSync(env.chatsFile, "мусор", "utf8");
    fs.writeFileSync(env.chatsFile + ".bak", "тоже мусор", "utf8");
    assert.deepStrictEqual(env.store.loadChats(), { chats: [], activeId: null }, "битые файлы дали не пустое хранилище");
  });

  await test("папки приложения ещё нет: запись настроек и чатов создаёт её сама", () => {
    // Первый запуск (или перенесённая папка приложения): писать надо, а папки нет.
    const env = build({ noDir: true });
    assert.ok(!fs.existsSync(env.appDir), "папка приложения уже существует — проверка пустая");
    env.store.saveChats({ chats: [{ id: "a", messages: [] }], activeId: "a" });
    env.store.saveSettings({ ...env.store.loadSettings(), model: "qwen3:8b" });
    assert.ok(fs.existsSync(env.chatsFile), "запись чатов не создала папку и файл");
    assert.ok(fs.existsSync(env.settingsFile), "запись настроек не создала папку и файл");
    assert.strictEqual(env.store.loadChats().activeId, "a", "чаты не читаются после создания папки");
  });

  console.log("\n[4] Подключения: кулдаун и переключение по кругу");

  await test("список рабочих подключений: без ключа или без id не годится", () => {
    const env = build();
    const s = { openaiProfiles: [{ id: "p1", url: "u", apiKey: "k" }, { id: "", url: "u", apiKey: "k" }, { id: "p3", url: "u", apiKey: "  " }] };
    assert.deepStrictEqual(env.store.openaiProfilesList(s).map((p) => p.id), ["p1"], "в список попали нерабочие подключения");
    assert.deepStrictEqual(env.store.openaiProfilesList({}), [], "пустые настройки дали непустой список");
  });

  await test("переключение: следующий ключ и его настройки уезжают в основные поля", () => {
    const env = build();
    const s = {
      openaiProfiles: [
        { id: "p1", url: "https://one/v1", apiKey: "k1", model: "m1", project: "pr1" },
        { id: "p2", url: "https://two/v1", apiKey: "k2", model: "m2", project: "pr2" },
      ],
      openaiActiveProfile: "p1",
      openaiUrl: "https://one/v1",
      openaiApiKey: "k1",
    };
    const next = env.store.switchOpenaiProfile(s, {});
    assert.ok(next && next.id === "p2", "переключение не случилось: " + JSON.stringify(next));
    assert.strictEqual(s.openaiUrl, "https://two/v1", "адрес не переехал в основные поля: " + s.openaiUrl);
    assert.strictEqual(s.openaiApiKey, "k2", "ключ не переехал в основные поля");
    assert.strictEqual(s.openaiModel, "m2", "модель не переехала: " + s.openaiModel);
    assert.strictEqual(s.openaiProject, "pr2", "проект не переехал: " + s.openaiProject);
  });

  await test("провинившийся ключ отлеживается: следующий раз берётся другой, а не он же", () => {
    const env = build();
    const s = {
      openaiProfiles: [
        { id: "p1", url: "u1", apiKey: "k1" },
        { id: "p2", url: "u2", apiKey: "k2" },
      ],
      openaiActiveProfile: "p1",
      openaiUrl: "u1",
      openaiApiKey: "k1",
    };
    // Первое переключение — из-за ошибки ключа p1: он должен отлежаться.
    const first = env.store.switchOpenaiProfile(s, { penalizeCurrentMs: 60 * 1000 });
    assert.strictEqual(first.id, "p2", "провинившийся ключ не отложен");
    // Второе — сразу же: пока p1 в кулдауне, а p2 единственный рабочий, переключать некуда.
    const second = env.store.switchOpenaiProfile(s, { penalizeCurrentMs: 60 * 1000 });
    assert.strictEqual(second, null, "вернулись к отложенному ключу: " + JSON.stringify(second));
  });

  await test("одно подключение: переключать некуда", () => {
    const env = build();
    const s = { openaiProfiles: [{ id: "p1", url: "u", apiKey: "k" }], openaiActiveProfile: "p1" };
    assert.strictEqual(env.store.switchOpenaiProfile(s, {}), null, "переключение при одном подключении");
    assert.strictEqual(env.store.switchOpenaiProfile({ openaiProfiles: [] }, {}), null, "переключение без подключений");
  });

  console.log("\n[5] Расположение кода и проводка");

  await test("вынос: определений в main.js больше нет, а в модуле они есть", () => {
    for (const gone of ["function loadSettings() {", "function saveSettings(s) {", "function normalizeSettings(raw) {",
      "function loadChats() {", "function saveChats(d) {", "function switchOpenaiProfile(s, opts) {",
      "const DEFAULT_SETTINGS = {", "const profileCooldown = new Map()"]) {
      assert.strictEqual(MAIN_SRC.indexOf(gone), -1, "код остался в main.js: " + gone);
      assert.ok(STORE_SRC.indexOf(gone) >= 0, "код не найден в модуле: " + gone);
    }
  });

  await test("проводка: имена взяты деструктуризацией — вызовы в оболочке не переписывались", () => {
    const at = MAIN_SRC.indexOf('const { createSettingsStore } = require("./settings-store.js");');
    assert.ok(at > 0, "main.js не собирает хранилище настроек");
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["DEFAULT_SETTINGS,", "normalizeSettings,", "loadSettings,", "saveSettings,",
      "loadChats,", "saveChats,", "openaiProfilesList,", "switchOpenaiProfile,",
      "fs,", "path,", "os,", "app,", "secrets,", "audit,", "toolPolicy,", "vault,",
      "applyAgentEnv,", "applyBrowserSettings,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    // Прежние вызовы на месте: это переезд, а не переписывание.
    const calls = MAIN_SRC.match(/(^|[^.\w$])loadSettings\(\)/g) || [];
    assert.ok(calls.length >= 20, "вызовы loadSettings() в оболочке переписаны: " + calls.length);
    assert.ok(/^\s+loadSettings,$/m.test(MAIN_SRC), "модули больше не получают свежие настройки");
  });

  await test("применение настроек живое: окружение в модуле, профиль браузера в оболочке", () => {
    // Окружение агента применяет модуль src/agent-env.js (часть 22): он отдаёт
    // applyAgentEnv в проводку, а состояние держит у себя. Профиль браузера остаётся
    // объявлением функции в оболочке — подъём работает, поэтому мост не нужен.
    const ENV_SRC = read("src", "agent-env.js");
    assert.ok(ENV_SRC.indexOf("function applyAgentEnv(s) {") >= 0, "применение окружения уехало из модуля");
    assert.ok(ENV_SRC.indexOf("ycEnsurePath();") >= 0, "окружение больше не получает PATH yc CLI");
    assert.ok(MAIN_SRC.indexOf("function applyBrowserSettings(s) {") >= 0, "применение профиля браузера уехало из оболочки");
    assert.ok(STORE_SRC.indexOf("applyAgentEnv(") >= 0 && STORE_SRC.indexOf("applyBrowserSettings(") >= 0,
      "модуль не применяет настройки к живым подсистемам");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

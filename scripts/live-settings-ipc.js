"use strict";
/* ─── Живой прогон каналов настроек и мобильного доступа ──────────────────────
   Запуск: bun run test:live:settings   (node scripts/live-settings-ipc.js)

   Зачем отдельный прогон. Наборы (test/settings-ipc.test.js,
   test/mobile-ipc.test.js) собирают модули сами, с поддельными соседями — но они
   НЕ проверяют главного: что настоящий main.js собирает эти модули на своём месте
   и с рабочими зависимостями. Ошибка там тихая: передай в проводку копию
   настроек вместо функции чтения — каналы продолжат отвечать, но будут отдавать
   устаревшее; забудь сеттер «активного репозитория» — агент останется в папке
   прошлой локации, и заметить это можно только по его работе.

   Поэтому здесь всё настоящее: хранилище настроек на диске, политика выдачи,
   живой мобильный мост и настоящий main.js в Node с поддельным Electron (окна в
   песочнице нет). Перехвачена сборка модулей — видно, ЧТО именно в них пришло, —
   а «активный репозиторий» читается через мост GitHub-каналов: это то же самое
   живое значение, что видит агент.

   Разделы:
     [1] main.js сам собрал оба модуля и с рабочими зависимостями;
     [2] каналы стоят на месте и работают НАСКВОЗЬ через настоящее хранилище;
     [3] защиты settings:set работают на настоящих настройках (пароли, каталог);
     [4] смена рабочей папки сбрасывает «активный репозиторий» — видно через
         чужой мост (GitHub-каналы), то есть ровно то значение, что у агента;
     [5] мобильный доступ: статус живого моста и смена PIN, применённая к нему;
     [6] ни один канал не пишет в папку приложения;
     [7] проводка стоит ниже зависимостей, а каналов в main.js не осталось.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-settings-ipc-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-settings-ipc-work-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "live-settings-ipc-other-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = path.join(userData, "settings.json");
const readSettingsFile = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));

// Настройки — на диске: их прочитает настоящий loadSettings() внутри main.js.
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      workingDir: work,
      provider: "ollama",
      model: "live-model",
      mobileEnabled: false,
      mobilePin: "111111",
      ycFolderId: "live-folder",
      ycFolderName: "live-prod",
      ycCloudId: "live-cloud",
    },
    null,
    2
  )
);

const handlers = new Map();
const listeners = new Map();
const windows = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => { w.webContents.sent.push({ ch, ev }); },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
    },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    on: () => {},
    once: () => {},
    loadFile: () => Promise.resolve(),
    show: () => {},
    focus: () => {},
    restore: () => {},
    maximize: () => {},
    setTitle: () => {},
    close: () => {},
  };
  windows.push(w);
  return w;
};

// Перехватываем сборку модулей: видим, с чем их позвал НАСТОЯЩИЙ main.js.
// GitHub-каналы нужны отдельно: через их мост читается «активный репозиторий» —
// то же живое значение, что видит агент.
const seen = { settings: 0, settingsDeps: null, mobile: 0, mobileDeps: null, githubDeps: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.186",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => listeners.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: stub("Notification"),
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
    };
  }
  const t = String(req);
  if (t.indexOf("settings-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerSettingsIpc: (deps) => {
        seen.settings++;
        seen.settingsDeps = deps;
        return real.registerSettingsIpc(deps);
      },
    };
  }
  if (t.indexOf("mobile-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerMobileIpc: (deps) => {
        seen.mobile++;
        seen.mobileDeps = deps;
        return real.registerMobileIpc(deps);
      },
    };
  }
  if (t.indexOf("github-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerGithubIpc: (deps) => {
        seen.githubDeps = deps;
        return real.registerGithubIpc(deps);
      },
    };
  }
  return origin.apply(this, arguments);
};
// Фоновые отказы main.js прогон не роняют, а падение САМОГО прогона обязано быть
// громким: иначе «молчаливый ноль» в цепочке тестов выглядел бы успехом.
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 90 секунд");
  process.exit(1);
}, 90000);
watchdog.unref();

(async () => {
  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон каналов настроек (настоящий main.js без окна)");
  await sleep(500);

  const call = (ch, ...args) => handlers.get(ch)(null, ...args);

  console.log("\n[1] настоящий main.js сам собрал оба модуля — и с рабочими зависимостями");
  ok(seen.settings === 1, "registerSettingsIpc вызван main.js " + seen.settings + " раз(а)");
  ok(seen.mobile === 1, "registerMobileIpc вызван main.js " + seen.mobile + " раз(а)");
  const sd = seen.settingsDeps;
  const md = seen.mobileDeps;
  ok(!!sd && typeof sd.loadSettings === "function", "настройки пришли функцией чтения (а не копией)");
  ok(!!sd && typeof sd.saveSettings === "function", "запись настроек пришла функцией");
  ok(!!sd && typeof sd.normalizeSettings === "function", "схема настроек пришла из хранилища");
  ok(!!sd && typeof sd.applyAgentEnv === "function", "окружение агента приходит настоящей функцией");
  ok(!!sd && typeof sd.applyBrowserSettings === "function", "применение браузера приходит функцией");
  ok(!!sd && !!sd.mobileBridge && typeof sd.mobileBridge.applySettings === "function", "мобильный мост пришёл настоящим");
  ok(!!sd && !!sd.toolPolicy && typeof sd.toolPolicy.scopeGroups === "function", "политика инструментов пришла настоящей");
  ok(!!sd && !!sd.live && typeof sd.live.setLastAgentRepoDir === "function", "папка агента пришла сеттером моста");
  ok(!!md && typeof md.loadSettings === "function" && typeof md.saveSettings === "function", "модуль PIN получил настройки функциями");
  ok(!!md && md.mobileBridge === sd.mobileBridge, "оба модуля держат ОДИН и тот же мост");
  ok(!!seen.githubDeps && typeof seen.githubDeps.live.lastAgentRepoDir === "function", "GitHub-каналы дают читать «активный репозиторий»");

  console.log("\n[2] каналы стоят на месте и работают насквозь через настоящее хранилище");
  for (const ch of ["settings:get", "settings:set", "policy:groups", "mobile:status", "mobile:pinRegen"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
  }
  const got = await handlers.get("settings:get")();
  ok(got.workingDir === work, "settings:get отдал рабочую папку из настоящих настроек");
  const merged = await call("settings:set", { model: "live-changed" });
  ok(merged.model === "live-changed", "settings:set вернул объединённые настройки");
  ok(readSettingsFile().model === "live-changed", "настройка легла на диск настоящим хранилищем");
  const again = await handlers.get("settings:get")();
  ok(again.model === "live-changed", "тот же канал прочитал изменение обратно");
  // Группы выдачи считает политика инструментов (src/tool-policy.js): канал обязан
  // отдавать ровно её ответ, а не свою копию или пустой список — иначе в настройках
  // исчезнет выбор, кого пускать (terminal, git, cloud), и окно покажет пустоту.
  const toolPolicy = require(path.join(ROOT, "src", "tool-policy.js"));
  const groups = await handlers.get("policy:groups")();
  ok(Array.isArray(groups) && groups.length > 0, "группы выдачи не пусты: " + (Array.isArray(groups) ? groups.length : "не массив"));
  ok(
    groups.every((g) => typeof g.group === "string" && Array.isArray(g.caps) && typeof g.tools === "number"),
    "у каждой группы есть имя, назначения и число инструментов"
  );
  ok(JSON.stringify(groups) === JSON.stringify(toolPolicy.scopeGroups()), "канал отдаёт ровно то, что считает политика");

  console.log("\n[3] защиты settings:set работают на настоящих настройках");
  await call("settings:set", { sitePasswords: [{ id: "x", name: "сайт", password: "пароль" }], mailPassword: "live-mail-secret" });
  // Ключ с негодным значением — это и есть «обрезанный объект» от старого окна
  // или мобильного клиента: при сборке { ...prev, ...s } он затирает сохранённое.
  const keep = await call("settings:set", { model: "live-model-2", sitePasswords: null, mailPassword: undefined });
  ok(Array.isArray(keep.sitePasswords) && keep.sitePasswords.length === 1, "пароли сайтов не затёрты обрезанным объектом");
  ok(keep.mailPassword === "live-mail-secret", "пароль почты не затёрт обрезанным объектом");
  ok((await handlers.get("settings:get")()).mailPassword === "live-mail-secret", "пароль почты лежит в хранилище секретов и читается обратно");
  const wiped = await call("settings:set", { ycFolderId: "", ycFolderName: "", ycCloudId: "" });
  ok(wiped.ycFolderId === "live-folder", "каталог Yandex Cloud не стёрт устаревшим объектом интерфейса");
  ok(wiped.ycFolderName === "live-prod", "имя каталога сохранено");
  ok(readSettingsFile().ycFolderId === "live-folder", "каталог остался и на диске");
  const cleared = await call("settings:set", { sitePasswords: [] });
  ok(Array.isArray(cleared.sitePasswords) && cleared.sitePasswords.length === 0, "осознанная очистка списка паролей проходит");

  console.log("\n[4] смена рабочей папки сбрасывает «активный репозиторий» (видно через мост GitHub-каналов)");
  const repoDir = seen.githubDeps.live;
  repoDir.setLastAgentRepoDir("/tmp/live-clone");
  ok(repoDir.lastAgentRepoDir() === "/tmp/live-clone", "стенд выставил папку агента (иначе проверка ниже пустая)");
  const moved = await call("settings:set", { workingDir: other });
  ok(repoDir.lastAgentRepoDir() === null, "смена рабочей папки сбросила папку агента через мост");
  ok(moved.workingDir === other, "рабочая папка сменилась");
  ok(moved.githubRepoDir === "", "локальная папка выбранного репозитория сброшена");
  repoDir.setLastAgentRepoDir("/tmp/live-clone-2");
  await call("settings:set", { workingDir: other, model: "live-model-3" });
  ok(repoDir.lastAgentRepoDir() === "/tmp/live-clone-2", "папка агента сбрасывается без смены рабочей папки");

  console.log("\n[5] мобильный доступ: статус живого моста и смена PIN, применённая к нему");
  const st0 = await handlers.get("mobile:status")();
  ok(st0.pin === "111111", "статус взял PIN из настоящих настроек: " + st0.pin);
  const st1 = await handlers.get("mobile:pinRegen")();
  // PIN — секрет: он лежит не в открытом settings.json, а в secrets.json,
  // поэтому читаем его тем же каналом, каким его видит окно и телефон.
  const stored = await handlers.get("settings:get")();
  const pinOnDisk = stored.mobilePin;
  ok(/^\d{6}$/.test(String(pinOnDisk)), "новый PIN сохранён в хранилище: " + pinOnDisk);
  ok(pinOnDisk !== "111111", "сохранён именно новый PIN");
  ok(st1.pin === pinOnDisk, "живой мост принял новый PIN (иначе телефон остался бы на старом)");
  ok(st1.pin !== "111111", "PIN действительно сменился");
  const enabled = await call("settings:set", { mobileEnabled: true, mobilePort: 9189, mobilePin: "" });
  ok(/^\d{6}$/.test(String(enabled.mobilePin)), "при включении без PIN он генерируется: " + enabled.mobilePin);
  ok(enabled.mobilePin !== pinOnDisk, "сгенерирован НОВЫЙ PIN, а не остался прежний");
  ok((await handlers.get("mobile:status")()).pin === enabled.mobilePin, "мост видит сгенерированный PIN");
  await call("settings:set", { mobileEnabled: false });

  console.log("\n[6] ни один канал не пишет в папку приложения");
  const appFilesAfter = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  ok(appFilesBefore === appFilesAfter, "папка src не изменилась после работы каналов");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")), "настройки не легли в папку приложения");
  ok(!fs.existsSync(path.join(ROOT, "secrets.json")), "секреты не легли в папку приложения");

  console.log("\n[7] проводка стоит ниже зависимостей, а каналов в main.js не осталось");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(mainSrc.indexOf('require("./settings-store.js")') < mainSrc.indexOf('require("./settings-ipc.js")'), "модуль настроек собран после хранилища настроек");
  ok(mainSrc.indexOf('require("./agent-env.js")') < mainSrc.indexOf('require("./settings-ipc.js")'), "модуль настроек собран после окружения агента");
  ok(mainSrc.indexOf('require("./browser-ipc.js")') < mainSrc.indexOf('require("./settings-ipc.js")'), "модуль настроек собран после браузерных настроек");
  ok(mainSrc.indexOf("new MobileBridge(") < mainSrc.indexOf('require("./mobile-ipc.js")'), "модуль PIN собран после мобильного моста");
  ok(mainSrc.indexOf('require("./settings-store.js")') < mainSrc.indexOf('require("./mobile-ipc.js")'), "модуль PIN собран после хранилища настроек");
  ok(!/ipcMain\.(handle|on)\("settings:/.test(mainSrc), "в main.js не осталось каналов настроек");
  ok(!/ipcMain\.(handle|on)\("policy:/.test(mainSrc), "в main.js не осталось канала policy:groups");
  ok(!/ipcMain\.(handle|on)\("mobile:/.test(mainSrc), "в main.js не осталось мобильных каналов");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

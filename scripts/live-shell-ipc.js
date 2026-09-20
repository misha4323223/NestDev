"use strict";
/* ─── Живой прогон служебных каналов: терминал, самообновление, выбор папки ───
   Запуск: bun run test:live:shell-ipc   (node scripts/live-shell-ipc.js)

   Зачем отдельный прогон. Наборы (test/ota-ipc.test.js, test/terminal-panel.test.js,
   test/settings-ipc.test.js) собирают модули сами, с поддельными соседями — но они
   НЕ проверяют главного: что настоящий main.js собирает эти модули на своём месте и
   передаёт им рабочие зависимости. Ошибки тут тихие:

     • канал не зарегистрирован — окно зовёт кнопку, а в ответ приходит ошибка
       «No handler registered», и человек видит нерабочую панель;
     • настройки переданы снимком — выключатель self-update перестаёт действовать,
       а терминал открывается в папке прошлого проекта;
     • диалог выбора папки теряет окно-родителя — он открывается отдельным окном.

   Здесь всё настоящее: main.js грузится в Node с поддельным electron, настройки
   лежат на диске и читаются настоящим loadSettings(), терминал — это НАСТОЯЩАЯ
   оболочка, а OTA — настоящий модуль src/ota.js со своим корнем в temp.

   Разделы:
     [1] main.js сам собрал модули и передал рабочие зависимости;
     [2] каналы терминала: настоящая оболочка, вывод в окно, статус, остановка;
     [3] старт терминала берёт ТЕКУЩУЮ рабочую папку (проект мог переключиться);
     [4] OTA: настройки читаются в момент вызова, выключатель действует сразу;
     [5] dialog:pickDir: родитель — настоящее окно, отмена — null;
     [6] каналов в оболочке не осталось, проводка ниже зависимостей.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-work-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-other-"));
const otaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-ota-"));
// В рабочей папке — файл для автодополнения терминала (оно читает настоящий каталог).
fs.writeFileSync(path.join(work, "marker.txt"), "x", "utf8");
// Корень OTA — в temp: настоящий ota.js читает и пишет только туда.
process.env.AI_AGENT_OTA_ROOT = otaRoot;

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = path.join(userData, "settings.json");
const writeSettings = (extra) =>
  fs.writeFileSync(settingsFile, JSON.stringify(Object.assign({ workingDir: work, otaEnabled: true }, extra || {}), null, 2));
const readSettingsFile = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
writeSettings();

const handlers = new Map();
const listeners = new Map();
const windows = [];
const sent = [];
const opened = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
// Окно той же формы, что настоящее: id и send лежат в webContents, а send окно
// оборачивает мобильным мостом — здесь это видно, значит мост на месте.
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => {
        sent.push({ ch, ev });
        w.webContents.sent.push({ ch, ev });
      },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
      // Окно вешает обработчик ссылок и «will-navigate»: без них createWindow
      // падал бы посреди работы и подписка апдейтера не дошла бы до нас.
      setWindowOpenHandler: () => {},
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
    setTitle: (t) => { w.title = t; },
    close: () => {},
  };
  windows.push(w);
  return w;
};

// Перехватываем сборку модулей: видим, с чем их позвал НАСТОЯЩИЙ main.js.
const seen = { ota: 0, otaDeps: null, updaterDeps: null, term: 0, termDeps: null, termIpc: 0 };
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
        getVersion: () => "1.5.188",
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
      dialog: {
        showOpenDialog: async (parent, opts) => {
          opened.push({ parent, opts });
          return { canceled: true, filePaths: [] };
        },
      },
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
  if (t.indexOf("ota-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerOtaIpc: (deps) => {
        seen.ota++;
        seen.otaDeps = deps;
        return real.registerOtaIpc(deps);
      },
      initAutoUpdater: (deps) => {
        seen.updaterDeps = deps;
        return real.initAutoUpdater(deps);
      },
    };
  }
  if (t.indexOf("terminal-panel") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createTerminalPanel: (deps) => {
        seen.term++;
        seen.termDeps = deps;
        const panel = real.createTerminalPanel(deps);
        const reg = panel.registerTermIpc;
        return Object.assign({}, panel, {
          registerTermIpc: (ipcMain) => {
            seen.termIpc++;
            return reg(ipcMain);
          },
        });
      },
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 120 секунд");
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон служебных каналов (настоящий main.js без окна)");
  await sleep(500);

  const win = windows[0];
  const otaModule = require(path.join(ROOT, "src", "ota.js"));

  console.log("\n[1] настоящий main.js сам собрал модули — и с рабочими зависимостями");
  ok(seen.ota === 1, "registerOtaIpc вызван main.js " + seen.ota + " раз(а)");
  ok(seen.term === 1, "createTerminalPanel вызван main.js " + seen.term + " раз(а)");
  ok(seen.termIpc === 1, "каналы терминала отданы модулю " + seen.termIpc + " раз(а)");
  ok(!!seen.otaDeps && seen.otaDeps.ota === otaModule, "каналы OTA получили НАСТОЯЩИЙ модуль src/ota.js");
  ok(!!seen.otaDeps && typeof seen.otaDeps.loadSettings === "function", "настройки пришли функцией чтения");
  ok(!!seen.updaterDeps && typeof seen.updaterDeps.autoUpdater.checkForUpdates === "function", "апдейтер получил настоящий объект");
  ok(!!seen.updaterDeps && typeof seen.updaterDeps.getWindow === "function" && seen.updaterDeps.getWindow() === win, "апдейтер получает окно мостом");
  ok(!!seen.termDeps && typeof seen.termDeps.agentWorkDir === "function" && typeof seen.termDeps.loadSettings === "function", "терминал получил рабочую папку и настройки");
  ok(!!seen.termDeps && typeof seen.termDeps.bgKill === "function" && seen.termDeps.getWindow() === win, "терминал получил остановку процессов и живое окно");

  console.log("\n[2] каналы терминала: настоящая оболочка, вывод в окно, статус, остановка");
  for (const ch of ["term:start", "term:input", "term:stop", "term:status", "term:complete"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
  }
  sent.length = 0;
  const started = await handlers.get("term:start")();
  ok(started.ok === true, "терминал запущен настоящей оболочкой: " + JSON.stringify(started.error));
  ok(started.cwd === work, "терминал открылся в рабочей папке из настроек: " + started.cwd);
  ok((await handlers.get("term:status")()).running === true, "статус видит запущенный терминал");
  const comp = await handlers.get("term:complete")(null, "");
  ok(Array.isArray(comp.matches) && comp.matches.indexOf("marker.txt") >= 0, "автодополнение читает настоящую рабочую папку: " + JSON.stringify(comp.matches).slice(0, 120));
  const inputOk = await handlers.get("term:input")(null, "echo ТЕРМИНАЛ-ЖИВОЙ");
  ok(inputOk.ok === true, "команда принята терминалом");
  let outs = [];
  for (let i = 0; i < 30 && !outs.some((t) => t.indexOf("ТЕРМИНАЛ-ЖИВОЙ") >= 0); i++) {
    await sleep(120);
    outs = sent.filter((s) => s.ch === "term:event" && s.ev.type === "out").map((s) => s.ev.text);
  }
  ok(outs.some((t) => t.indexOf("ТЕРМИНАЛ-ЖИВОЙ") >= 0), "вывод оболочки дошёл до окна: " + JSON.stringify(outs).slice(0, 160));
  ok((await handlers.get("term:stop")()).ok === true, "терминал остановлен каналом");
  ok((await handlers.get("term:status")()).running === false, "статус сбросился после остановки");

  console.log("\n[3] старт терминала берёт ТЕКУЩУЮ рабочую папку, а не папку времени сборки");
  writeSettings({ workingDir: other });
  const started2 = await handlers.get("term:start")();
  ok(started2.ok === true && started2.cwd === other, "терминал открылся в новой рабочей папке: " + started2.cwd);
  ok(readSettingsFile().workingDir === other, "настройки на диске действительно сменились (иначе проверка пустая)");
  await handlers.get("term:stop")();
  writeSettings();

  console.log("\n[4] OTA: настройки читаются в момент вызова, выключатель действует сразу");
  const stOn = await handlers.get("ota:status")();
  ok(stOn && stOn.enabled === true, "статус OTA видит включённое самообновление: " + JSON.stringify(stOn && stOn.enabled));
  ok(otaRoot.indexOf(path.basename(stOn.dir)) >= 0 || stOn.dir.indexOf("live-shell-ota-") >= 0, "OTA-корень взят из окружения: " + stOn.dir);
  writeSettings({ otaEnabled: false });
  const stOff = await handlers.get("ota:status")();
  ok(stOff && stOff.enabled === false, "выключенный self-update виден сразу, без перезапуска: " + JSON.stringify(stOff && stOff.enabled));
  const chkOff = await handlers.get("ota:check")();
  ok(chkOff && chkOff.status === "disabled", "проверка обновления при выключенном self-update не применяет набор: " + JSON.stringify(chkOff));
  writeSettings({ otaEnabled: true });
  const chkOn = await handlers.get("ota:check")();
  ok(chkOn && chkOn.status && chkOn.status !== "error", "при включённом self-update проверка отвечает понятным состоянием: " + JSON.stringify(chkOn));
  for (const ch of ["ota:status", "ota:check", "ota:rollback", "ota:openDir", "ota:reset"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
  }

  console.log("\n[5] dialog:pickDir: родитель — настоящее окно, отмена — null");
  opened.length = 0;
  const picked = await handlers.get("dialog:pickDir")();
  ok(picked === null, "отмена системного диалога отдана окну как null: " + JSON.stringify(picked));
  ok(opened.length === 1 && opened[0].parent === win, "родителем диалога передано настоящее окно запуска");
  ok(!!opened[0].opts && opened[0].opts.properties.indexOf("openDirectory") >= 0, "диалог спрашивает именно папку: " + JSON.stringify(opened[0].opts));

  console.log("\n[6] каналов в оболочке не осталось, проводка ниже зависимостей");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(!/ipcMain\.(handle|on)\("term:/.test(mainSrc), "в main.js не осталось каналов терминала");
  ok(!/ipcMain\.(handle|on)\("ota:/.test(mainSrc), "в main.js не осталось каналов OTA");
  ok(!/ipcMain\.(handle|on)\("dialog:/.test(mainSrc), "в main.js не осталось канала выбора папки");
  ok(mainSrc.indexOf("createTerminalPanel({") < mainSrc.indexOf("registerTermIpc(ipcMain);"), "каналы терминала отданы модулю после его сборки");
  ok(mainSrc.indexOf("createSettingsStore({") < mainSrc.indexOf('require("./settings-ipc.js")'), "выбор папки собран после хранилища настроек");
  ok(mainSrc.indexOf("const ota = require(\"./ota.js\")") < mainSrc.indexOf('require("./ota-ipc.js")'), "каналы OTA собраны после самого модуля OTA");
  ok(!/function initAutoUpdater\(/.test(mainSrc), "подписка апдейтера осталась в оболочке");

  console.log("\n[7] ни один канал не пишет в папку приложения");
  const appFilesAfter = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  ok(appFilesBefore === appFilesAfter, "папка src не изменилась после работы каналов");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")), "настройки не легли в папку приложения");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

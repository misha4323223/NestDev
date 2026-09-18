"use strict";
/* ─── Живой прогон окна приложения (main.js без окна Electron) ────────────────
   Запуск: bun run test:live:window   (node scripts/live-window.js)

   Зачем. С этапа B, части 13 окно собирается в своём модуле, а оболочка держит
   его у себя и отдаёт/забирает мостом (setWindow). Здесь проверяется ПРОВОДКА
   на настоящем main.js: окно поднимает ЖИВОЙ код (whenReady → createWindow), а
   его поведение ловит поддельное окно.

   Что проверяется по-настоящему:
     • окно собирается и грузит настоящий preload и настоящую разметку;
     • события доходят до окна (значит, оболочка держит именно это окно);
     • ai:event получает метку запуска, а чужая метка не перетирается;
     • ссылки из чата открываются в браузере пользователя, а не в новом окне;
     • закрытие окна обнуляет его у оболочки — события больше не отправляются;
     • активация приложения поднимает окно заново. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-window-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-window-work-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

// ── Поддельное окно: события, ссылки, закрытие ──────────────────────────────
const events = [];
const windows = [];
const opened = [];
function FakeWindow(opts) {
  this.opts = opts;
  this.handlers = {};
  this.openHandler = null;
  this.loadedFile = "";
  this.webContents = {
    send: (ch, ev) => events.push({ ch, ev }),
    setWindowOpenHandler: (fn) => { this.openHandler = fn; },
    on: (name, fn) => { this.handlers[name] = fn; },
  };
  this.on = (name, fn) => { this.handlers[name] = fn; };
  this.isDestroyed = () => false;
  this.loadFile = (p) => { this.loadedFile = p; };
  this.setTitle = () => {};
  windows.push(this);
}
FakeWindow.getAllWindows = () => windows.filter((w) => !w.closed);

const handlers = new Map();
const appHandlers = new Map();
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: (name, fn) => appHandlers.set(name, fn),
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.163",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async (url) => { opened.push(url); }, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: FakeWindow,
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
    };
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});
require(path.join(ROOT, "src", "main.js"));

(async () => {
  console.log("Живой прогон окна (main.js без окна Electron)");
  await sleep(600); // окно создаётся живым кодом в whenReady

  const call = (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
    return Promise.resolve(fn(null, ...args));
  };

  console.log("\n[1] Окно, собранное живым кодом");
  ok(windows.length === 1, "whenReady поднял ровно одно окно (окон: " + windows.length + ")");
  const win = windows[0];
  if (!win) {
    console.log("\nИтог: провал");
    process.exit(1);
  }
  ok(fs.existsSync(win.opts.webPreferences.preload), "окно грузит настоящий preload: " + win.opts.webPreferences.preload);
  ok(/src[\\/]preload\.js$/.test(win.opts.webPreferences.preload), "preload взят из папки кода");
  ok(fs.existsSync(win.loadedFile), "окно грузит настоящую разметку: " + win.loadedFile);
  ok(/renderer[\\/]index\.html$/.test(win.loadedFile), "разметка взята из папки окна");
  ok(win.opts.webPreferences.contextIsolation === true && win.opts.webPreferences.nodeIntegration === false, "изоляция окна на месте");
  ok(win.opts.title === "AI Developer Agent" && win.opts.minWidth === 900, "параметры окна на месте: " + win.opts.title + ", минимум " + win.opts.minWidth);

  console.log("\n[2] События доходят до окна, ai:event получает метку запуска");
  events.length = 0;
  win.webContents.send("dev:event", { type: "out", text: "лог" });
  ok(events.length === 1 && events[0].ch === "dev:event", "событие дошло до окна");
  events.length = 0;
  win.webContents.send("ai:event", { type: "text", text: "ответ" });
  ok(events.length === 1 && events[0].ev.from === "desktop", "метка запуска поставлена: " + JSON.stringify(events[0] && events[0].ev));
  events.length = 0;
  win.webContents.send("ai:event", { type: "text", from: "mobile" });
  ok(events.length === 1 && events[0].ev.from === "mobile", "чужая метка запуска перетёрта: " + JSON.stringify(events[0] && events[0].ev));

  console.log("\n[3] Ссылки из чата — в браузере пользователя");
  const denied = win.openHandler ? win.openHandler({ url: "https://github.com/x/y" }) : null;
  ok(!!denied && denied.action === "deny", "новое окно Electron запрещено: " + JSON.stringify(denied));
  ok(opened.includes("https://github.com/x/y"), "ссылка открыта в браузере пользователя: " + JSON.stringify(opened));
  const before = opened.length;
  if (win.openHandler) win.openHandler({ url: "file:///etc/passwd" });
  ok(opened.length === before, "локальный путь в браузер не попал");
  let prevented = 0;
  if (win.handlers["will-navigate"]) win.handlers["will-navigate"]({ preventDefault: () => { prevented++; } }, "http://example.com/p");
  ok(prevented === 1 && opened.length === before + 1, "переход внутри окна перехвачен и открыт в браузере");

  console.log("\n[4] Закрытие окна обнуляет его у оболочки");
  events.length = 0;
  const added = await call("tasks:add", { title: "Проверка окна", due: "", priority: "normal" });
  ok(added && added.ok === true, "дело добавлено (событие панели ждём): " + JSON.stringify(added));
  const sawChanged = events.some((e) => e.ch === "tasks:changed");
  ok(sawChanged, "до закрытия окно получает события панели");
  ok(typeof win.handlers["closed"] === "function", "закрытие окна обрабатывается");
  events.length = 0;
  if (win.handlers["closed"]) win.handlers["closed"]();
  win.closed = true;
  await call("tasks:add", { title: "После закрытия", due: "", priority: "normal" });
  ok(events.filter((e) => e.ch === "tasks:changed").length === 0, "после закрытия события в мёртвое окно не идут");

  console.log("\n[5] Активация приложения поднимает окно заново");
  const act = appHandlers.get("activate");
  ok(!!act, "обработчик активации приложения зарегистрирован");
  if (act) {
    act();
    await sleep(100);
    ok(windows.length === 2, "активация подняла второе окно (окон: " + windows.length + ")");
    const fresh = windows[1];
    if (fresh) {
      events.length = 0;
      fresh.webContents.send("ai:event", { type: "text" });
      ok(events.length === 1 && events[0].ev.from === "desktop", "новое окно получает события и метку запуска");
    }
  }

  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log("  ❌ прогон сорвался: " + String((e && e.stack) || e).split("\n")[0]);
  console.log("\nИтог: провал");
  process.exit(1);
});

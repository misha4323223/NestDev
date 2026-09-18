"use strict";
/* ─── Живой прогон пользовательского терминала (main.js без окна Electron) ────
   Запуск: bun run test:live:terminal   (node scripts/live-terminal.js)

   Зачем. С этапа B, части 12 постоянная оболочка рабочей папки живёт в своём
   модуле, а оболочка отдаёт её каналам и инструментам агента. Модульный набор
   проверяет модуль; здесь проверяется ПРОВОДКА в настоящем main.js: он грузится
   в Node с поддельным electron, окно создаётся ЖИВЫМ кодом (createWindow), а
   события терминала ловит поддельное окно.

   Что проверяется по-настоящему:
     • каналы term:* зарегистрированы и работают на настоящей оболочке;
     • вывод команды доезжает до окна событием (терминал и делали, чтобы видеть работу);
     • рабочая папка и выданные переменные доходят до процесса;
     • команда агента дублируется в терминал (тот же путь, что у инструмента runCommand);
     • term:stop действительно убивает процесс (проверяется по pid);
     • выход приложения (before-quit) гасит терминал.

   Платформа учитывается: команды печати/каталога/pid — свои для cmd и sh. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-term-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-term-work-"));
fs.writeFileSync(path.join(work, "live-alpha.txt"), "a", "utf8");
fs.mkdirSync(path.join(work, "live-dir"), { recursive: true });
fs.writeFileSync(path.join(work, "live-dir", "inside.txt"), "b", "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sayEcho = (w) => "echo " + w;
const sayPwd = () => (WIN ? "cd" : "pwd");
const sayVar = (n) => (WIN ? "echo %" + n + "%" : "echo $" + n);
const shellPidCmd = () => (WIN ? "" : "echo $$");

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

async function waitFor(cond, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (cond()) return true;
    await sleep(60);
  }
  return false;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

// ── Поддельное окно: события терминала ловим здесь ─────────────────────────
const events = [];
const windows = [];
function FakeWindow(opts) {
  this.opts = opts;
  this.webContents = {
    send: (ch, ev) => events.push({ ch, ev }),
    setWindowOpenHandler: () => {},
    on: () => {},
  };
  this.isDestroyed = () => false;
  this.loadFile = () => {};
  this.setTitle = () => {};
  this.on = () => {};
  windows.push(this);
}
FakeWindow.getAllWindows = () => windows;

const handlers = new Map();
const appHandlers = new Map();
const captured = {};
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
        getVersion: () => "1.5.162",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
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
  if (/agent-tools\.js$/.test(String(req))) {
    const mod = origin.call(this, req, parent, isMain);
    return {
      createAgentTools: (deps) => {
        captured.deps = deps;
        captured.tools = mod.createAgentTools(deps);
        return captured.tools;
      },
    };
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});
require(path.join(ROOT, "src", "main.js"));

(async () => {
  console.log("Живой прогон терминала (main.js без окна Electron)");
  await sleep(600); // окно создаётся живым кодом в whenReady

  const call = (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
    return Promise.resolve(fn(null, ...args));
  };
  const last = (type) => [...events].reverse().find((e) => e.ev && e.ev.type === type);

  console.log("\n[1] Проводка: каналы и окно");
  for (const ch of ["term:start", "term:input", "term:stop", "term:status", "term:complete"]) {
    ok(handlers.has(ch), "канал " + ch + " зарегистрирован");
  }
  ok(windows.length >= 1, "живой createWindow поднял окно (окон: " + windows.length + ")");
  ok(events.every((e) => !!e.ch), "все события ушли по каналу");

  const settingsSet = handlers.get("settings:set");
  ok(!!settingsSet, "канал настроек на месте");
  await settingsSet(null, { workingDir: work, agentEnv: { LIVE_TERM_VAR: "term-42" } });

  console.log("\n[2] Запуск, ввод и вывод: настоящая оболочка");
  events.length = 0;
  const started = await call("term:start");
  ok(started && started.ok === true, "терминал запущен: " + JSON.stringify(started));
  ok(started && started.cwd === work, "терминал поднят в рабочей папке: " + (started && started.cwd));
  ok(!!last("start"), "окну пришло событие запуска");
  ok((await call("term:status")).running === true, "состояние: терминал работает");

  events.length = 0;
  await call("term:input", sayEcho("LIVE-TERM-MARK"));
  const echoed = await waitFor(() => events.some((e) => e.ev.type === "out" && /LIVE-TERM-MARK/.test(e.ev.text)));
  ok(echoed, "вывод команды доехал до окна событием");
  ok(!!last("in"), "окну показана введённая команда");

  events.length = 0;
  await call("term:input", sayPwd());
  const pwd = await waitFor(() => events.some((e) => e.ev.type === "out" && e.ev.text.includes(path.basename(work))));
  ok(pwd, "оболочка действительно в рабочей папке");

  events.length = 0;
  await call("term:input", sayVar("LIVE_TERM_VAR"));
  const env = await waitFor(() => events.some((e) => e.ev.type === "out" && /term-42/.test(e.ev.text)));
  ok(env, "выданная переменная агента дошла до команды терминала");

  console.log("\n[3] Команда агента дублируется в терминал (тот же путь, что у runCommand)");
  events.length = 0;
  const tools = captured.tools;
  ok(!!(tools && tools.runCommand), "инструменты агента собраны");
  if (tools && tools.runCommand) {
    const out = String(await tools.runCommand({ command: sayEcho("LIVE-FROM-AGENT") }, { workingDir: work }));
    ok(/LIVE-FROM-AGENT/.test(out), "агент получил вывод команды");
    const agentEvents = events.filter((e) => e.ev.type === "agent");
    ok(agentEvents.length >= 2, "команда и вывод агента показаны в терминале (событий: " + agentEvents.length + ")");
    ok(agentEvents.some((e) => /^\$ /.test(e.ev.text)), "команда агента показана со знаком $");
    ok(agentEvents.some((e) => /LIVE-FROM-AGENT/.test(e.ev.text)), "вывод агента показан в терминале");
  }

  console.log("\n[4] Автодополнение и остановка по-настоящему");
  const complete = await call("term:complete", "live-");
  ok(complete && Array.isArray(complete.matches) && complete.matches.includes("live-alpha.txt"),
    "автодополнение берёт файлы рабочей папки: " + JSON.stringify(complete && complete.matches));

  if (!WIN) {
    events.length = 0;
    await call("term:input", shellPidCmd());
    await waitFor(() => events.some((e) => e.ev.type === "out" && /\d{2,}/.test(e.ev.text)));
    const m = events.filter((e) => e.ev.type === "out").map((e) => e.ev.text).join(" ").match(/\b(\d{2,})\b/);
    ok(!!m, "pid оболочки получен из терминала");
    if (m) {
      const pid = Number(m[1]);
      ok(pidAlive(pid), "оболочка жива до остановки (pid " + pid + ")");
      const stopped = await call("term:stop");
      ok(stopped && stopped.ok === true, "остановка принята: " + JSON.stringify(stopped));
      const dead = await waitFor(() => !pidAlive(pid), 6000);
      ok(dead, "процесс оболочки убит, а не остался сиротой (pid " + pid + ")");
    }
  } else {
    ok((await call("term:stop")).ok === true, "остановка принята");
  }
  ok((await call("term:status")).running === false, "состояние: терминал остановлен");

  console.log("\n[5] Выход приложения гасит терминал");
  await call("term:start");
  ok((await call("term:status")).running === true, "терминал снова запущен");
  const quit = appHandlers.get("before-quit");
  ok(!!quit, "обработчик выхода приложения зарегистрирован");
  if (quit) {
    events.length = 0;
    quit();
    ok((await call("term:status")).running === false, "выход приложения погасил терминал модулем");
    ok(events.filter((e) => e.ev.type === "agent").length === 0, "при выходе окну ничего лишнего не отправлено");
  }

  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log("  ❌ прогон сорвался: " + String((e && e.stack) || e).split("\n")[0]);
  console.log("\nИтог: провал");
  process.exit(1);
});

"use strict";

/* ── Окно приложения (src/app-window.js) ──────────────────────────────────────
   Запуск: node test/app-window.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 13). Здесь собирается главное окно и
   навешивается то, что легко сделать «на вид работает»:

     • прокси webContents.send — событие уходит И в окно, И в мобильный мост:
       потеряешь мост — телефон не увидит ответ агента с ПК;
     • метка from у ai:event — без неё ответ с телефона подмешивается в открытый
       чат на ПК (прогон-то чужой), а плашки всплывают не там;
     • ссылки из чата открываются в браузере пользователя;
     • закрытие окна обнуляет его у оболочки — иначе таймеры пишут в мёртвый объект.

   Окно поддельное (настоящего Electron в песочнице нет), но проверяется не
   «строка на месте», а поведение: что именно отдано окну, что ушло в мост и что
   случилось при закрытии. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createAppWindow } = require(path.join(ROOT, "src", "app-window.js"));
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
const MODULE_SRC = read("src", "app-window.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

const APP_DIR = path.join(ROOT, "src");

function makeEnv(over) {
  const env = {
    windows: [],
    broadcasts: [],
    opened: [],
    sendCalls: [],
    timers: { timeouts: [], intervals: [] },
    win: null,
    origin: "desktop",
  };
  function FakeWindow(opts) {
    this.opts = opts;
    this.handlers = {};
    this.openHandler = null;
    this.loadedFile = "";
    this._send = (ch, ev) => env.sendCalls.push({ ch, ev });
    this.webContents = {
      send: this._send,
      setWindowOpenHandler: (fn) => { this.openHandler = fn; },
      on: (name, fn) => { this.handlers[name] = fn; },
    };
    this.on = (name, fn) => { this.handlers["win:" + name] = fn; };
    this.isDestroyed = () => false;
    this.loadFile = (p) => { this.loadedFile = p; };
    env.windows.push(this);
  }
  const deps = {
    app: { setAppUserModelId: (id) => { env.appUserModelId = id; } },
    path,
    shell: { openExternal: (url) => { env.opened.push(url); return Promise.resolve(); } },
    mobileBridge: { broadcast: (ch, ev) => { env.broadcasts.push({ ch, ev }); } },
    BrowserWindow: FakeWindow,
    checkTaskReminders: () => { env.reminders = (env.reminders || 0) + 1; },
    getRunOrigin: () => env.origin,
    setWindow: (w) => { env.win = w; },
    appDir: APP_DIR,
  };
  Object.assign(deps, over || {});
  const api = createAppWindow(deps);
  env.create = api.createWindow;
  env.FakeWindow = FakeWindow;
  return env;
}

// Таймеры подменяем на время проверки: модуль ставит их глобально, как и раньше.
function withTimers(fn) {
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  global.setTimeout = (cb, ms) => { global.setTimeout.calls.push({ cb, ms }); return 0; };
  global.setInterval = (cb, ms) => { global.setInterval.calls.push({ cb, ms }); return 0; };
  global.setTimeout.calls = [];
  global.setInterval.calls = [];
  try {
    return fn();
  } finally {
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
  }
}

(async () => {
  await test("окно собирается с рабочими параметрами и отдаётся оболочке", () => {
    const env = withTimers(() => makeEnv());
    env.create();
    assert.strictEqual(env.windows.length, 1, "окно не создано");
    const w = env.windows[0];
    assert.strictEqual(env.win, w, "собранное окно не отдано оболочке");
    assert.strictEqual(w.opts.width, 1280, "ширина окна не та");
    assert.strictEqual(w.opts.minWidth, 900, "минимальная ширина не та");
    assert.strictEqual(w.opts.title, "AI Developer Agent", "заголовок окна не тот");
    assert.strictEqual(w.opts.autoHideMenuBar, true, "меню окна больше не скрыто");
    assert.strictEqual(w.opts.webPreferences.contextIsolation, true, "изоляция контекста выключена");
    assert.strictEqual(w.opts.webPreferences.nodeIntegration, false, "в окно пущен node");
    assert.strictEqual(w.opts.webPreferences.preload, path.join(APP_DIR, "preload.js"), "мост подключён не тот: " + w.opts.webPreferences.preload);
    assert.ok(fs.existsSync(w.opts.webPreferences.preload), "по указанному пути нет preload.js");
    assert.strictEqual(w.loadedFile, path.join(APP_DIR, "renderer", "index.html"), "окно грузит не ту разметку: " + w.loadedFile);
    assert.ok(fs.existsSync(w.loadedFile), "по указанному пути нет index.html");
  });

  await test("второе окно (активация приложения) собирается так же", () => {
    const env = withTimers(() => makeEnv());
    env.create();
    env.create();
    assert.strictEqual(env.windows.length, 2, "второе окно не создано");
    assert.strictEqual(env.win, env.windows[1], "оболочке отдано не последнее окно");
  });

  await test("напоминания о делах: первый запуск сразу, дальше по таймеру", () => {
    const timerCalls = (env, envValue) => {
      const prev = process.env.AI_AGENT_TASK_REMINDER_MS;
      if (envValue === undefined) delete process.env.AI_AGENT_TASK_REMINDER_MS;
      else process.env.AI_AGENT_TASK_REMINDER_MS = envValue;
      let first = null;
      let every = null;
      // Таймеры подменяются только на время вызова: модуль ставит их глобально, как и раньше.
      withTimers(() => {
        env.create();
        first = global.setTimeout.calls[0];
        every = global.setInterval.calls[0];
        assert.strictEqual(global.setTimeout.calls.length, 1, "напоминание не поставлено сразу после старта");
        assert.strictEqual(global.setInterval.calls.length, 1, "периодическая проверка дел не поставлена");
      });
      if (prev === undefined) delete process.env.AI_AGENT_TASK_REMINDER_MS;
      else process.env.AI_AGENT_TASK_REMINDER_MS = prev;
      return { first, every };
    };

    const t = timerCalls(makeEnv(), "5000");
    assert.strictEqual(t.first.ms, 5000, "первая проверка не через объявленный срок: " + t.first.ms);
    assert.strictEqual(t.every.ms, 5000, "интервал проверки дел не тот: " + t.every.ms);
    assert.strictEqual(t.every.cb, t.first.cb, "по таймеру и интервалу ходят разные проверки");

    // Без настройки — раз в минуту, но первая проверка не позже восьми секунд после старта.
    const def = timerCalls(makeEnv(), undefined);
    assert.strictEqual(def.every.ms, 60000, "интервал по умолчанию не минута: " + def.every.ms);
    assert.strictEqual(def.first.ms, 8000, "первая проверка отложена дальше восьми секунд: " + def.first.ms);

    // Совсем короткий интервал не принимается: слишком часто — это нагрузка на диск.
    const tiny = timerCalls(makeEnv(), "10");
    assert.strictEqual(tiny.every.ms, 2000, "нижний предел интервала не держится: " + tiny.every.ms);
    assert.strictEqual(tiny.first.ms, 2000, "первая проверка при коротком интервале не та: " + tiny.first.ms);
  });

  await test("событие уходит и в окно, и в мобильный мост", () => {
    const env = withTimers(() => makeEnv());
    env.create();
    const w = env.windows[0];
    w.webContents.send("dev:event", { type: "out", text: "лог" });
    assert.strictEqual(env.sendCalls.length, 1, "событие не дошло до окна");
    assert.deepStrictEqual(env.sendCalls[0], { ch: "dev:event", ev: { type: "out", text: "лог" } }, "событие изменилось по дороге в окно");
    assert.strictEqual(env.broadcasts.length, 1, "событие не транслировано телефону");
    assert.deepStrictEqual(env.broadcasts[0], { ch: "dev:event", ev: { type: "out", text: "лог" } }, "в мост ушло не то же событие");
  });

  await test("ai:event получает метку запуска, а чужая метка не перетирается", () => {
    const env = withTimers(() => makeEnv());
    env.create();
    const w = env.windows[0];
    env.origin = "mobile";
    w.webContents.send("ai:event", { type: "text", text: "ответ" });
    assert.strictEqual(env.sendCalls[0].ev.from, "mobile", "метка запуска не поставлена: " + JSON.stringify(env.sendCalls[0].ev));
    assert.strictEqual(env.broadcasts[0].ev.from, "mobile", "в мост ушло событие без метки");
    assert.strictEqual(env.sendCalls[0].ev.text, "ответ", "текст события потерян");

    const marked = { type: "text", from: "desktop" };
    w.webContents.send("ai:event", marked);
    assert.strictEqual(env.sendCalls[1].ev.from, "desktop", "уже поставленная метка перетёрта");
    assert.strictEqual(marked.from, "desktop", "чужой объект события изменён на месте");

    // Событие другого канала метку не получает: она нужна только прогону агента.
    w.webContents.send("term:event", { type: "out" });
    assert.strictEqual(env.sendCalls[2].ev.from, undefined, "метка поставлена чужому каналу");
  });

  await test("мост упал — окно всё равно получает событие", () => {
    const env = withTimers(() => makeEnv({ mobileBridge: { broadcast: () => { throw new Error("мост лёг"); } } }));
    env.create();
    env.windows[0].webContents.send("ai:event", { type: "text" });
    assert.strictEqual(env.sendCalls.length, 1, "сбой моста унёс событие из окна");
    assert.strictEqual(env.sendCalls[0].ev.from, "desktop", "метка запуска не поставлена");
  });

  await test("ссылки из чата: http открывается в браузере, остальное просто не пускается", async () => {
    const env = withTimers(() => makeEnv());
    env.create();
    const w = env.windows[0];
    const openRes = w.openHandler({ url: "https://github.com/x/y" });
    assert.deepStrictEqual(openRes, { action: "deny" }, "новое окно Electron не запрещено: " + JSON.stringify(openRes));
    assert.deepStrictEqual(env.opened, ["https://github.com/x/y"], "ссылка не открыта в браузере: " + JSON.stringify(env.opened));
    w.openHandler({ url: "file:///etc/passwd" });
    assert.strictEqual(env.opened.length, 1, "локальный путь ушёл в браузер");
    assert.deepStrictEqual(w.openHandler({ url: "ftp://example.com" }), { action: "deny" }, "чужая схема не запрещена");

    // Переход внутри окна: http перехватывается, локальный адрес — нет.
    let prevented = 0;
    w.handlers["will-navigate"]({ preventDefault: () => { prevented++; } }, "http://example.com/page");
    assert.strictEqual(prevented, 1, "переход по ссылке не перехвачен");
    assert.strictEqual(env.opened.length, 2, "переход не открыт в браузере");
    w.handlers["will-navigate"]({ preventDefault: () => { prevented++; } }, "file:///index.html");
    assert.strictEqual(prevented, 1, "локальный переход перехвачен зря");
  });

  await test("закрытие окна обнуляет его у оболочки", () => {
    const env = withTimers(() => makeEnv());
    env.create();
    const w = env.windows[0];
    assert.strictEqual(env.win, w, "окно не отдано оболочке");
    assert.ok(typeof w.handlers["win:closed"] === "function", "закрытие окна не обрабатывается");
    w.handlers["win:closed"]();
    assert.strictEqual(env.win, null, "после закрытия окна оболочка держит мёртвый объект");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    assert.ok(MAIN_SRC.indexOf("function createWindow(") < 0, "создание окна осталось в main.js");
    assert.ok(MAIN_SRC.includes("let mainWindow = null;"), "оболочка потеряла своё окно");
    assert.ok(/const \{ createAppWindow \} = require\("\.\/app-window\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(
      /const \{ createWindow \} = createAppWindow\(\{/.test(MAIN_SRC),
      "окно больше не берётся из модуля"
    );
    for (const dep of ["  app,", "  path,", "  shell,", "  mobileBridge,", "  BrowserWindow,", "  checkTaskReminders,", "  getRunOrigin: () => activeRunOrigin,", "  setWindow: (w) => { mainWindow = w; },", "  appDir: __dirname,"]) {
      assert.ok(MAIN_SRC.includes(dep), "в проводку не передано: " + dep);
    }
    // С части 37 стартовое создание окна идёт из src/lifecycle.js: там шаг «окно»,
    // и его отказ не обрывает подписку апдейтера и тик OTA.
    const LIFECYCLE_SRC = read("src", "lifecycle.js");
    assert.ok(/runStep\("окно", \(\) => createWindow\(\)\)/.test(LIFECYCLE_SRC), "окно больше не создаётся при старте");
    assert.ok(/^  createWindow,$/m.test(MAIN_SRC), "жизненный цикл не получает создание окна");
    // Модуль не вычисляет пути и не держит чужого состояния сам.
    assert.ok(!/__dirname/.test(MODULE_SRC), "модуль сам догадывается о своей папке");
    assert.ok(!/mainWindow|activeRunOrigin/.test(MODULE_SRC), "модуль держит состояние оболочки напрямую");
    assert.ok(MODULE_SRC.includes("getRunOrigin()") && MODULE_SRC.includes("setWindow(win)") && MODULE_SRC.includes("setWindow(null)"), "мосты окна и метки запуска не задействованы");
    // Windows-специфика осталась в модуле, а не потерялась при выносе.
    assert.ok(MODULE_SRC.includes("setAppUserModelId"), "пропала настройка AppUserModelID для Windows");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

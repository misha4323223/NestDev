"use strict";

/* ── Жизненный цикл приложения (src/lifecycle.js) ─────────────────────────────
   Запуск: node test/lifecycle.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 37). Раньше этот код жил в оболочке и
   не был ничем прикрыт, хотя именно здесь уже случилась живая находка: падающий
   createWindow() обрывал цепочку `whenReady`, и подписка апдейтера не ставилась —
   приложение молча перестаёт видеть обновления. Проверяется не «строка на месте»,
   а поведение:

     • порядок шагов остановки (дети приложения гасятся до моста телефона);
     • отказ ЛЮБОГО шага не отменяет остальные — и при старте, и при остановке;
     • мост телефона с негодным портом больше не выключает проверку обновлений;
     • повторный before-quit и отклонённое обещание браузера не всплывают наружу;
     • проводка в main.js: каждое переданное имя существует (обратная проверка). */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createLifecycle } = require(path.join(ROOT, "src", "lifecycle.js"));
const { mainTopNames } = require(path.join(__dirname, "backend-wiring.js"));
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
const MODULE_SRC = read("src", "lifecycle.js");
const MAIN_SRC = read("src", "main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Отказы шагов модуль пишет в console.error — ловим их, чтобы проверять смысл
// сообщения, а не факт «что-то напечаталось» (и чтобы прогон не был шумным).
async function withErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.error = orig;
  }
}

function makeEnv(over) {
  const o = over || {};
  const settings = o.settings || { mobileEnabled: true, mobilePort: 9090 };
  const env = {
    settings,
    openWindows: [], // что вернёт BrowserWindow.getAllWindows()
    window: { id: 7 }, // «живое окно» для getWindow
    order: [],
    timers: [],
    appHandlers: new Map(),
    quit: 0,
    bgKilled: [],
    otaChecks: [],
    updaterDeps: null,
    bridgeSettings: null,
    windows: 0,
  };
  env.bgProcesses = new Map([
    ["bg1", { name: "bg1" }],
    ["bg2", { name: "bg2" }],
  ]);
  env.bgProcessesSize = () => env.bgProcesses.size;
  env.createWindowThrows = !!o.createWindowThrows;
  env.deps = {
    app: {
      whenReady: () => (o.readyRejects ? Promise.reject(new Error("нет готовности")) : Promise.resolve()),
      on: (name, fn) => env.appHandlers.set(name, fn),
      quit: () => {
        env.quit++;
      },
    },
    BrowserWindow: { getAllWindows: () => env.openWindows.slice() },
    createWindow: () => {
      // Флаг, а не снимок опции: проверки включают падение УЖЕ СОБРАННОМУ модулю —
      // внутри фабрики createWindow захвачен замыканием, и подмена депса после сборки
      // на него не влияет (на этом падала первая версия проверки 5).
      if (env.createWindowThrows) throw new Error("окно не создалось");
      env.windows++;
      env.order.push("окно");
    },
    mobileBridge: {
      applySettings: (s) => {
        if (o.bridgeThrows) throw new Error("listen EADDRINUSE 99999");
        env.bridgeSettings = s;
        env.order.push("мост:настройки");
      },
      stop: () => {
        env.order.push("мост телефона");
      },
    },
    loadSettings: () => settings,
    initAutoUpdater: (d) => {
      if (o.updaterThrows) throw new Error("апдейтер не подписался");
      env.updaterDeps = d;
      env.order.push("апдейтер");
    },
    autoUpdater: { marker: "autoUpdater" },
    Notification: function FakeNotification() {},
    ota: {
      check: (s) => {
        env.otaChecks.push(s);
        if (o.otaThrows) throw new Error("OTA недоступен");
        return o.otaRejects ? Promise.reject(new Error("нет сети")) : Promise.resolve();
      },
    },
    browserTools: {
      stop: () => {
        env.order.push("браузер агента");
        if (o.browserStopThrows) throw new Error("Chromium не закрылся");
        return o.browserStopRejects ? Promise.reject(new Error("Chromium не закрылся")) : Promise.resolve();
      },
    },
    bgProcesses: env.bgProcesses,
    bgKill: (rec) => {
      if (o.bgKillThrows) throw new Error("не погасился " + (rec && rec.name));
      env.bgKilled.push(rec && rec.name);
    },
    termShutdown: () => {
      if (o.termThrows) throw new Error("терминал не погас");
      env.order.push("терминал");
    },
    devShutdown: () => {
      if (o.devThrows) throw new Error("превью не погасло");
      env.order.push("превью проекта");
    },
    getWindow: () => env.window,
    platform: o.platform || "linux",
    setTimer: (fn, ms) => {
      env.timers.push({ kind: "once", ms, fn });
      return 1;
    },
    everyTimer: (fn, ms) => {
      env.timers.push({ kind: "every", ms, fn });
      return 2;
    },
  };
  return env;
}

(async () => {
  await test("1. старт: окно, настройки моста, подписка апдейтера и оба таймера OTA", async () => {
    const env = makeEnv();
    const lc = createLifecycle(env.deps);
    const { value: failures } = await withErrors(() => lc.startLifecycle());
    assert.deepStrictEqual(failures, [], "старт с отказом шага: " + JSON.stringify(failures));
    assert.deepStrictEqual(env.order, ["окно", "мост:настройки", "апдейтер"], "порядок старта не тот: " + env.order.join(" → "));
    assert.strictEqual(env.bridgeSettings, env.settings, "мосту отдали не настройки приложения");
    assert.strictEqual(env.updaterDeps.autoUpdater, env.deps.autoUpdater, "апдейтер собран без autoUpdater");
    assert.strictEqual(typeof env.updaterDeps.Notification, "function", "апдейтер собран без Notification");
    assert.strictEqual(env.updaterDeps.getWindow(), env.window, "окно апдейтеру приходит не тем мостом");
    assert.deepStrictEqual(env.timers.map((t) => [t.kind, t.ms]), [["once", 5000], ["every", 60000]],
      "таймеры OTA не те: " + JSON.stringify(env.timers.map((t) => t.ms)));
    assert.strictEqual(env.timers[0].fn, env.timers[1].fn, "у тика OTA две разные функции");

    // Тик спрашивает OTA с текущими настройками (а не со снимком времени старта).
    env.timers[1].fn();
    await sleep(5);
    assert.deepStrictEqual(env.otaChecks, [env.settings], "тик OTA не спросил обновления: " + env.otaChecks.length);

    // activate доносит окно, только когда окон нет.
    const activate = env.appHandlers.get("activate");
    assert.ok(!!activate, "activate не подписан");
    activate();
    assert.strictEqual(env.windows, 2, "activate не создал окно на пустом списке окон");
    env.openWindows = [{}];
    activate();
    assert.strictEqual(env.windows, 2, "activate создал второе окно поверх живого");
  });

  await test("2. окно не создалось — мост, апдейтер и тик OTA всё равно подняты", async () => {
    const env = makeEnv({ createWindowThrows: true });
    const lc = createLifecycle(env.deps);
    const { value: failures, lines } = await withErrors(() => lc.startLifecycle());
    assert.deepStrictEqual(env.order, ["мост:настройки", "апдейтер"], "падение окна оборвало цепочку: " + env.order.join(" → "));
    assert.deepStrictEqual(env.timers.map((t) => t.ms), [5000, 60000], "тик OTA не завелся после падения окна");
    assert.deepStrictEqual(failures.map((f) => f.step), ["окно"], "отказ окна не записан: " + JSON.stringify(failures));
    assert.ok(lines.some((l) => /шаг «окно»/.test(l)), "отказ окна не сказан в лог: " + JSON.stringify(lines));
    assert.ok(!!env.appHandlers.get("activate"), "activate не подписан после падения окна");
  });

  await test("3. мост телефона не поднялся (негодный порт) — проверка обновлений работает", async () => {
    // Живой случай: в настройках мобильного моста порт 99999 — listen бросает
    // синхронно. Раньше это обрывало цепочку whenReady, и подписка апдейтера не
    // ставилась: приложение молча перестаёт видеть обновления сборки.
    const env = makeEnv({ bridgeThrows: true });
    const lc = createLifecycle(env.deps);
    const { value: failures, lines } = await withErrors(() => lc.startLifecycle());
    assert.deepStrictEqual(env.order, ["окно", "апдейтер"], "падение моста оборвало цепочку: " + env.order.join(" → "));
    assert.deepStrictEqual(env.timers.map((t) => t.ms), [5000, 60000], "тик OTA потерялся вместе с мостом");
    assert.deepStrictEqual(failures.map((f) => f.step), ["настройки мобильного моста"], "отказ моста не записан");
    assert.ok(lines.some((l) => /настройки мобильного моста/.test(l)), "отказ моста не сказан в лог");
    assert.strictEqual(env.updaterDeps.autoUpdater, env.deps.autoUpdater, "апдейтер всё-таки потерялся");
  });

  await test("4. отказ тика OTA не вылетает из таймера и не считается отказом раунда", async () => {
    const env = makeEnv({ otaThrows: true });
    const lc = createLifecycle(env.deps);
    await withErrors(() => lc.startLifecycle());
    const tick = env.timers[0].fn;
    const first = await withErrors(() => tick());
    assert.deepStrictEqual(first.lines.filter((l) => /тик OTA/.test(l)).length, 1, "бросок OTA не пойман таймером");
    assert.deepStrictEqual(lc.failures().map((f) => f.step), ["тик OTA"], "отказ тика не записан");
    // Отклонённое обещание — не отказ: у ota.check есть свой catch.
    const second = makeEnv({ otaRejects: true });
    const lc2 = createLifecycle(second.deps);
    await withErrors(() => lc2.startLifecycle());
    const quiet = await withErrors(() => second.timers[0].fn());
    await sleep(5);
    assert.deepStrictEqual(quiet.lines, [], "отклонённый ota.check напечатал отказ: " + JSON.stringify(quiet.lines));
    assert.deepStrictEqual(lc2.failures(), [], "отклонённый ota.check записан как отказ шага");
  });

  await test("5. отказ окна по activate не вылетает наружу", async () => {
    const env = makeEnv();
    const lc = createLifecycle(env.deps);
    await withErrors(() => lc.startLifecycle());
    env.createWindowThrows = true;
    const activate = env.appHandlers.get("activate");
    const { lines } = await withErrors(() => activate());
    assert.ok(lines.some((l) => /окно \(activate\)/.test(l)), "отказ activate не сказан в лог");
  });

  await test("6. window-all-closed: на не-дарвине выходим, на дарвине — нет", async () => {
    const lin = makeEnv({ platform: "linux" });
    const lcLin = createLifecycle(lin.deps);
    await withErrors(() => lcLin.startLifecycle());
    lin.appHandlers.get("window-all-closed")();
    assert.strictEqual(lin.quit, 1, "на linux закрытие окон не вышло из приложения");

    const mac = makeEnv({ platform: "darwin" });
    const lcMac = createLifecycle(mac.deps);
    await withErrors(() => lcMac.startLifecycle());
    mac.appHandlers.get("window-all-closed")();
    assert.strictEqual(mac.quit, 0, "на macOS приложение вышло, хотя не должно");
  });

  await test("7. остановка: порядок шагов и полный обход", async () => {
    const env = makeEnv();
    const lc = createLifecycle(env.deps);
    assert.deepStrictEqual(lc.shutdownOrder(),
      ["браузер агента", "фоновые процессы", "терминал", "превью проекта", "мост телефона"],
      "порядок остановки изменился: " + lc.shutdownOrder().join(" → "));
    const fails = lc.runShutdown();
    assert.deepStrictEqual(fails, [], "остановка на живых зависимостях с отказами: " + JSON.stringify(fails));
    assert.deepStrictEqual(env.order, ["браузер агента", "терминал", "превью проекта", "мост телефона"],
      "шаги остановки шли не в этом порядке или не все: " + env.order.join(" → "));
    assert.deepStrictEqual(env.bgKilled, ["bg1", "bg2"], "фоновые процессы погашены не все: " + env.bgKilled.join(", "));
    assert.strictEqual(env.bgProcessesSize(), 0, "карта фоновых процессов не очищена");
    // before-quit может прийти дважды (штатный выход и выход на установку обновления):
    // второй проход обязан быть безопасным.
    env.order.length = 0;
    assert.deepStrictEqual(lc.runShutdown(), [], "повторная остановка упала");
    assert.deepStrictEqual(env.order, ["браузер агента", "терминал", "превью проекта", "мост телефона"],
      "повторная остановка прошла не по всем шагам");
    assert.deepStrictEqual(env.bgKilled, ["bg1", "bg2"], "повторная остановка гасила уже погашенное");
  });

  await test("8. упавший шаг остановки не отменяет остальные", async () => {
    const env = makeEnv({ termThrows: true });
    const lc = createLifecycle(env.deps);
    const { value: fails, lines } = await withErrors(async () => lc.runShutdown());
    assert.deepStrictEqual(fails.map((f) => f.step), ["терминал"], "отказ терминала не записан: " + JSON.stringify(fails));
    assert.ok(lines.some((l) => /шаг «терминал»/.test(l)), "отказ терминала не сказан в лог");
    assert.deepStrictEqual(env.order, ["браузер агента", "превью проекта", "мост телефона"],
      "после упавшего шага остальные не выполнены: " + env.order.join(" → "));
    assert.deepStrictEqual(env.bgKilled, ["bg1", "bg2"], "гашение фоновых процессов пропущено");
  });

  await test("9. браузер агента: и бросок, и отклонённое обещание не всплывают наружу", async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const threw = makeEnv({ browserStopThrows: true });
      const lcThrew = createLifecycle(threw.deps);
      const { value: fails, lines } = await withErrors(async () => lcThrew.runShutdown());
      assert.deepStrictEqual(fails.map((f) => f.step), ["браузер агента"], "бросок браузера не записан");
      assert.ok(lines.some((l) => /браузер агента/.test(l)), "бросок браузера не сказан в лог");
      const afterBrowser = threw.order.filter((s) => s !== "браузер агента");
      assert.deepStrictEqual(afterBrowser, ["терминал", "превью проекта", "мост телефона"],
        "после броска браузера остановка оборвалась: " + threw.order.join(" → "));

      const rejected = makeEnv({ browserStopRejects: true });
      const lcRejected = createLifecycle(rejected.deps);
      await withErrors(async () => lcRejected.runShutdown());
      await sleep(20);
      assert.deepStrictEqual(unhandled, [], "отклонённое обещание браузера осталось необработанным");
      assert.deepStrictEqual(rejected.order, ["браузер агента", "терминал", "превью проекта", "мост телефона"],
        "после отказа браузера остальные шаги не выполнены");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  await test("10. before-quit гасит всё тем же списком", async () => {
    const env = makeEnv();
    const lc = createLifecycle(env.deps);
    await withErrors(() => lc.startLifecycle());
    const quit = env.appHandlers.get("before-quit");
    assert.ok(!!quit, "обработчик выхода приложения не зарегистрирован");
    env.order.length = 0;
    quit();
    assert.deepStrictEqual(env.order, ["браузер агента", "терминал", "превью проекта", "мост телефона"],
      "выход приложения прошёл не по шагам: " + env.order.join(" → "));
    assert.deepStrictEqual(env.bgKilled, ["bg1", "bg2"], "выход приложения не погасил фоновые процессы");
    assert.strictEqual(env.bgProcessesSize(), 0, "выход приложения не очистил карту процессов");
  });

  await test("11. проводка в main.js: шагов в оболочке нет, каждое имя существует", () => {
    for (const gone of [
      "app.whenReady()",
      'app.on("before-quit"',
      'app.on("window-all-closed"',
      "for (const rec of bgProcesses.values()) bgKill(rec);",
      "initAutoUpdater({ autoUpdater, Notification, getWindow: () => mainWindow })",
      "setInterval(otaTick, 60000)",
    ]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "жизненный цикл остался в оболочке: " + gone);
    }
    assert.ok(MAIN_SRC.includes('const { createLifecycle } = require("./lifecycle.js");'), "модуль не подключён");
    assert.ok(MAIN_SRC.includes("startLifecycle();"), "жизненный цикл не запущен");
    assert.ok(/getWindow: \(\) => mainWindow,/.test(MAIN_SRC), "окно уходит в модуль не мостом");
    for (const dep of [
      "  app,", "  BrowserWindow,", "  createWindow,", "  mobileBridge,", "  loadSettings,",
      "  initAutoUpdater,", "  autoUpdater,", "  Notification,", "  ota,", "  browserTools,",
      "  bgProcesses,", "  bgKill,", "  termShutdown,", "  devShutdown,",
    ]) {
      assert.ok(MAIN_SRC.includes(dep), "в проводку не передано: " + dep);
    }

    // Обратная проверка (та же, что поймала бы дыру publishLocalToGithub): имя,
    // переданное в модуль сокращённой записью, обязано существовать в main.js —
    // иначе депс придёт undefined, и шаг тихо не сделает ничего.
    const block = MAIN_SRC.match(/createLifecycle\(\{([\s\S]*?)\}\);/);
    assert.ok(!!block, "проводка createLifecycle не разобралась");
    const top = mainTopNames(MAIN_SRC);
    for (const line of block[1].split("\n")) {
      const m = line.match(/^\s*([A-Za-z_$][\w$]*),\s*$/);
      if (m) assert.ok(top.has(m[1]), "в проводку передано имя, которого нет в main.js: " + m[1]);
    }

    // Модуль ничего не берёт сам: ни require, ни глобального состояния уровня файла.
    assert.ok(!/require\(/.test(MODULE_SRC), "модуль сам что-то требует");
    assert.ok(MODULE_SRC.includes("const SHUTDOWN_STEPS = ["), "список шагов остановки потерялся");
    assert.ok(!/\bmainWindow\b/.test(MODULE_SRC), "модуль держит окно оболочки напрямую");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

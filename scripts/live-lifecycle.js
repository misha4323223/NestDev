"use strict";
/* ─── Живой прогон жизненного цикла: настоящий main.js, настоящие дети ─────────
   Запуск: bun run test:live:lifecycle   (node scripts/live-lifecycle.js)

   Зачем. Набор (test/lifecycle.test.js) проверяет модуль на подставных зависимостях
   и порядок вызовов. Здесь проверяется то, чего в наборе быть не может: НАСТОЯЩИЙ
   main.js грузится в Node с поддельным Electron, поднимает НАСТОЯЩИЙ мобильный мост
   по https, ставит подписку апдейтера и тик OTA, а затем по before-quit гасит
   НАСТОЯЩИХ детей приложения — фоновый процесс, оболочку терминала и dev-сервер
   превью. Проверяется не «функция вызвана», а что процессы действительно мертвы,
   а порты действительно свободны.

   Разделы (полный прогон):
     [1] старт: окно создано, мост отвечает по https, апдейтер подписан, тик OTA стоит;
     [2] настоящие дети: фоновый процесс, терминал и превью-сервер живы;
     [3] выход приложения: порядок шагов тот же, а дети и порты действительно погашены;
     [4] (ребёнок) мост с негодным портом: подписка апдейтера и тик OTA всё равно есть;
     [5] (ребёнок) упавший шаг остановки не отменяет остальные шаги.

   Режимы: --brokenport (раздел 4), --quick --break=term (раздел 5). Пишет только
   во временные папки; настройки кладёт в свой userData. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const { execFileSync } = require("child_process");

// Мост поднимается по https с самоподписанным сертификатом (src/bridge-tls.js), а
// прогон — про жизненный цикл, а не про проверку сертификата: она отдельно, в
// test/bridge-tls.test.js. Здесь важно, что канал идёт по TLS.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
const BROKEN_PORT = process.argv.includes("--brokenport"); // раздел 4 (ребёнок)
const QUICK = process.argv.includes("--quick"); // раздел 5 (ребёнок)
const BREAK = (() => {
  const a = process.argv.find((s) => s.startsWith("--break="));
  return a ? a.slice("--break=".length) : "";
})();

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-life-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-life-work-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const finish = () => {
  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
};

const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: port });
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
    setTimeout(() => end(false), 900);
  });

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const psHas = (marker) => {
  if (WIN) return [];
  try {
    return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(marker));
  } catch {
    return [];
  }
};

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(cond, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 6000)) {
    if (await cond()) return true;
    await sleep(80);
  }
  return false;
}

// ── Наблюдение за настоящими шагами: перехват require, а не подмена кода ──────
// Обёртки стоят на ЖИВЫХ модулях: прогон видит те же функции, что вызывает
// приложение, и записывает порядок их вызова.
const order = [];
const otaCalls = [];
const timers = [];
const realSetTimeout = global.setTimeout;
const realSetInterval = global.setInterval;
// Кто поставил таймер — по месту вызова, а не по числу миллисекунд: такое же
// "каждые 60 секунд" ставит себе окно (напоминания о делах, src/app-window.js), и
// проверка по одному числу была бы ложной (на этом упала первая версия проверки).
const timerHere = (fn, ms, kind) => {
  // «Кто поставил» — ПЕРВЫЙ чужой кадр стека. Стек целиком не годится: и окно
  // (app-window.js), и мост, и апдейтер ставятся из тех же шагов жизненного цикла,
  // и по полному стеку они выглядят как таймеры самого lifecycle.js.
  const frames = String(new Error().stack || "")
    .split("\n")
    .slice(1)
    .filter((l) => l.indexOf("live-lifecycle.js") < 0);
  return { kind: kind, ms: ms, fn: fn, from: frames.length ? frames[0] : "" };
};
global.setTimeout = (fn, ms, ...rest) => {
  timers.push(timerHere(fn, ms, "once"));
  return realSetTimeout(fn, ms, ...rest);
};
global.setInterval = (fn, ms, ...rest) => {
  timers.push(timerHere(fn, ms, "every"));
  return realSetInterval(fn, ms, ...rest);
};

const stub = (name) => {
  const f = function () {
    return stub(name + "()");
  };
  return new Proxy(f, {
    get(t, k) {
      if (k === "then") return undefined;
      return stub(name + "." + String(k));
    },
    apply() {
      return stub(name + "()");
    },
    construct() {
      return stub("new " + name);
    },
  });
};

const windows = [];
function FakeWindow(opts) {
  this.opts = opts;
  this.webContents = {
    send: () => {},
    setWindowOpenHandler: () => {},
    on: () => {},
    id: windows.length + 1,
    openDevTools: () => {},
  };
  this.isDestroyed = () => false;
  this.loadFile = () => {};
  this.setTitle = () => {};
  this.on = () => {};
  this.show = () => {};
  this.focus = () => {};
  this.maximize = () => {};
  windows.push(this);
}
FakeWindow.getAllWindows = () => windows;

// Подписка апдейтера: настоящий initAutoUpdater работает с поддельным autoUpdater —
// ни сборки, ни сети к GitHub в прогоне нет.
const updater = {
  subs: [],
  checks: 0,
  on: (name) => updater.subs.push(name),
  checkForUpdates: () => {
    updater.checks++;
    return Promise.resolve(null);
  },
  downloadUpdate: () => Promise.resolve(null),
};
function FakeNotification() {
  this.show = () => {};
}

const handlers = new Map();
const appHandlers = new Map();
const captured = {};
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  const name = String(req);
  if (name === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: (n, fn) => appHandlers.set(n, fn),
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.191",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: FakeWindow,
      Notification: FakeNotification,
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
  if (name === "electron-updater") return { autoUpdater: updater };
  // Инструменты агента собираются живым кодом — фоновый сервер запускаем ими же,
  // иначе проверялась бы не та проводка, что у пользователя.
  if (/agent-tools\.js$/.test(name)) {
    const mod = origin.call(this, req, parent, isMain);
    return {
      createAgentTools: (deps) => {
        captured.deps = deps;
        captured.tools = mod.createAgentTools(deps);
        return captured.tools;
      },
    };
  }

  const mod = origin.apply(this, arguments);
  // Сам модуль жизненного цикла: держим его ответ, чтобы спросить список отказов
  // после выхода (а не верить, что «всё прошло»).
  if (/[\\/]lifecycle\.js$/.test(name)) {
    return {
      createLifecycle: (deps) => {
        const api = mod.createLifecycle(deps);
        captured.lifecycle = api;
        return api;
      },
    };
  }
  // ── Обёртки шагов жизни: те же функции, но видно, кто и когда позван ──
  if (/[\\/]browser-tools\.js$/.test(name)) {
    return Object.assign({}, mod, {
      stop: () => {
        order.push("браузер агента");
        const r = mod.stop();
        return r && typeof r.catch === "function" ? r : Promise.resolve();
      },
    });
  }
  if (/[\\/]ota\.js$/.test(name)) {
    return Object.assign({}, mod, {
      check: (s) => {
        otaCalls.push(Date.now());
        return mod.check(s);
      },
    });
  }
  if (/[\\/]terminal-panel\.js$/.test(name)) {
    return {
      createTerminalPanel: (deps) => {
        const panel = mod.createTerminalPanel(deps);
        const inner = panel.termShutdown;
        panel.termShutdown = () => {
          order.push("терминал");
          if (BREAK === "term") throw new Error("терминал не погас (контроль)");
          return inner();
        };
        return panel;
      },
    };
  }
  if (/[\\/]preview-ipc\.js$/.test(name)) {
    return {
      registerPreviewIpc: (deps) => {
        const api = mod.registerPreviewIpc(deps);
        const inner = api.devShutdown;
        api.devShutdown = () => {
          order.push("превью проекта");
          return inner();
        };
        return api;
      },
    };
  }
  if (/[\\/]mobile-bridge\.js$/.test(name)) {
    const Base = mod;
    return class LiveMobileBridge extends Base {
      stop() {
        order.push("мост телефона");
        return super.stop();
      }
    };
  }
  return mod;
};

process.on("unhandledRejection", (e) => {
  console.log("  ❌ необработанный отказ: " + ((e && e.message) || e));
  failures++;
});

// ── Дети приложения: настоящие процессы во временной папке ────────────────────
const BG_MARKER = "live-bg-server.js";
const DEV_MARKER = "live-dev-server.js";
const BG_SRC =
  'const http = require("http");\n' +
  'http.createServer((q, s) => s.end("LIVE-BG-MARKER")).listen(Number(process.argv[2]), "127.0.0.1", () => console.log("BG-READY " + process.argv[2]));\n';
const DEV_SRC =
  'const http = require("http");\n' +
  'http.createServer((q, s) => s.end("LIVE-DEV-MARKER")).listen(Number(process.argv[2]), "127.0.0.1", () => console.log("DEV-READY " + process.argv[2]));\n';

// Ребёнка запускаем тем же node и тем же файлом: так контроль проходит ровно ту же
// дорогу (main.js → whenReady → before-quit), а не поддельный её вид.
function runChild(args) {
  try {
    const out = execFileSync(process.execPath, [__filename, ...args], { encoding: "utf8", timeout: 180000 });
    return { code: 0, out: out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

(async () => {
  const bridgePort = await freePort();
  const devPort = await freePort();
  const bgPort = await freePort();
  fs.writeFileSync(path.join(work, BG_MARKER), BG_SRC, "utf8");
  fs.writeFileSync(path.join(work, DEV_MARKER), DEV_SRC, "utf8");
  // Настройки читает loadSettings ВНУТРИ настоящего main.js: мобильный мост обязан
  // подняться на своём порту сам, иначе прогон проверял бы не то.
  fs.writeFileSync(
    path.join(userData, "settings.json"),
    JSON.stringify({
      workingDir: work,
      mobileEnabled: true,
      mobilePort: BROKEN_PORT ? 99999 : bridgePort,
      previewUrl: "http://127.0.0.1:" + devPort,
      otaEnabled: false, // локальное самообновление в прогоне не применяем
      agentWorkFiles: false,
      contextMemory: false,
    }),
    "utf8"
  );

  require(path.join(ROOT, "src", "main.js"));
  await sleep(900); // окно, мост и подписки ставятся живым кодом в whenReady

  const call = (channel, ...args) => {
    const fn = handlers.get(channel);
    if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
    return Promise.resolve(fn(null, ...args));
  };
  const otaTimers = () =>
    timers.filter((t) => /lifecycle\.js/.test(t.from) && (t.ms === 5000 || t.ms === 60000));

  if (BROKEN_PORT) {
    // ── [4] Мост с негодным портом: цепочка старта НЕ имеет права оборваться ──
    console.log("Живой прогон: мост телефона с негодным портом (99999)");
    ok(windows.length >= 1, "окно создано до сбоя моста (окон: " + windows.length + ")");
    ok(updater.subs.length >= 5, "апдейтер подписан, несмотря на сбой моста (событий: " + updater.subs.length + ")");
    ok(updater.autoDownload === false && updater.autoInstallOnAppQuit === true,
      "настройки апдейтера выставлены (autoDownload=" + updater.autoDownload + ")");
    ok(
      otaTimers().length === 2 && otaTimers().some((t) => t.ms === 5000) && otaTimers().some((t) => t.ms === 60000),
      "тик OTA стоит: " + otaTimers().map((t) => t.kind + ":" + t.ms).join(", ")
    );
    await call("term:stop");
    finish();
    return;
  }

  if (QUICK) {
    // ── [5] Упавший шаг остановки не отменяет остальные: настоящий dev-сервер ──
    console.log("Живой прогон: упавший шаг остановки (контроль --break=term)");
    const started = await call("dev:start", work, "node " + DEV_MARKER + " " + devPort);
    ok(started && started.ok === true, "dev-сервер превью запущен: " + JSON.stringify(started));
    ok(await waitFor(() => portOpen(devPort)), "dev-сервер слушает порт " + devPort);
    order.length = 0;
    appHandlers.get("before-quit")();
    ok(order.join(" → ") === "браузер агента → терминал → превью проекта → мост телефона",
      "порядок шагов сохранён: " + order.join(" → "));
    ok(order.indexOf("превью проекта") > order.indexOf("терминал"), "превью остановлено после упавшего шага");
    ok(order.includes("мост телефона"), "мост телефона остановлен последним шагом");
    ok(await waitFor(() => !psHas(DEV_MARKER).length, 6000), "dev-сервер действительно убит, несмотря на упавший шаг");
    ok(await waitFor(async () => !(await portOpen(devPort)), 4000), "порт превью освобождён");
    ok(await waitFor(async () => !(await portOpen(bridgePort)), 4000), "мост телефона остановлен");
    finish();
    return;
  }

  console.log("Живой прогон жизненного цикла (настоящий main.js без окна Electron)");

  console.log("\n[1] Старт: окно, мост по https, подписка апдейтера, тик OTA");
  ok(windows.length >= 1, "живой createWindow поднял окно (окон: " + windows.length + ")");
  const bridgeRes = await fetch("https://127.0.0.1:" + bridgePort + "/").then(
    (r) => ({ status: r.status }),
    (e) => ({ status: 0, error: e.message })
  );
  ok(bridgeRes.status === 200, "мост телефона отвечает по https: " + bridgeRes.status + " " + (bridgeRes.error || ""));
  ok(updater.subs.length >= 5, "апдейтер подписан на события сборки: " + updater.subs.join(", "));
  ok(updater.autoDownload === false && updater.autoInstallOnAppQuit === true, "настройки апдейтера выставлены");
  ok(otaTimers().some((t) => t.kind === "once" && t.ms === 5000), "первый тик OTA стоит через 5 с");
  ok(otaTimers().some((t) => t.kind === "every" && t.ms === 60000), "тик OTA повторяется каждые 60 с");
  const otaBefore = otaCalls.length;
  otaTimers().find((t) => t.ms === 5000).fn();
  await sleep(60);
  ok(otaCalls.length === otaBefore + 1, "тик OTA действительно доходит до модуля обновления");

  console.log("\n[2] Настоящие дети: фоновый процесс, терминал и превью живы");
  const tools = captured.tools;
  ok(!!(tools && tools.runCommandOutput), "агентские инструменты собраны живым main.js");
  const bgOut = String(
    await tools.runCommandOutput({ command: "node " + BG_MARKER + " " + bgPort, waitFor: "BG-READY" }, { workingDir: work })
  );
  const bgPid = Number((bgOut.match(/PID: (\d+)/) || [])[1]);
  ok(/BG-READY/.test(bgOut), "фоновый процесс поднялся и ответил маркером");
  ok(bgPid > 0 && pidAlive(bgPid), "фоновый процесс жив (PID " + bgPid + ")");
  const bgHttp = await fetch("http://127.0.0.1:" + bgPort + "/").then((r) => r.text(), () => "");
  ok(/LIVE-BG-MARKER/.test(bgHttp), "фоновый сервер отвечает по своему порту");
  ok(psHas(BG_MARKER).length > 0, "процесс виден в списке процессов (ps)");

  const termStarted = await call("term:start");
  ok(termStarted && termStarted.ok === true, "терминал запущен настоящей оболочкой");
  ok((await call("term:status")).running === true, "состояние: терминал работает");

  const devStarted = await call("dev:start", work, "node " + DEV_MARKER + " " + devPort);
  ok(devStarted && devStarted.ok === true, "превью проекта запущено: " + JSON.stringify(devStarted));
  ok(await waitFor(() => portOpen(devPort)), "dev-сервер превью слушает порт " + devPort);
  const devHttp = await fetch("http://127.0.0.1:" + devPort + "/").then((r) => r.text(), () => "");
  ok(/LIVE-DEV-MARKER/.test(devHttp), "dev-сервер превью отвечает по своему порту");

  console.log("\n[3] Выход приложения: порядок шагов и что действительно погашено");
  order.length = 0;
  const quit = appHandlers.get("before-quit");
  ok(!!quit, "обработчик выхода зарегистрирован живым main.js");
  quit();
  ok(order.join(" → ") === "браузер агента → терминал → превью проекта → мост телефона",
    "шаги остановки шли в порядке: " + order.join(" → "));
  const fails = captured.lifecycle ? captured.lifecycle.failures() : [{ step: "модуль не собран", error: "" }];
  ok(fails.length === 0, "ни один шаг остановки не отказал: " + JSON.stringify(fails));
  ok(
    await waitFor(() => !pidAlive(bgPid) && psHas(BG_MARKER).length === 0, 6000),
    "фоновый процесс действительно убит (PID " + bgPid + ")"
  );
  ok((await call("term:status")).running === false, "терминал действительно погашен");
  ok(await waitFor(() => !psHas(DEV_MARKER).length, 6000), "dev-сервер превью действительно убит");
  ok(await waitFor(async () => !(await portOpen(devPort)), 4000), "порт превью освобождён (" + devPort + ")");
  ok(await waitFor(async () => !(await portOpen(bgPort)), 4000), "порт фонового сервера освобождён (" + bgPort + ")");
  ok(await waitFor(async () => !(await portOpen(bridgePort)), 4000), "мост телефона остановлен (порт " + bridgePort + " свободен)");

  console.log("\n[4] Ребёнок: мост телефона с негодным портом (99999)");
  const broken = runChild(["--brokenport"]);
  ok(broken.code === 0 && !/❌/.test(broken.out), "в сломанном мосте апдейтер и тик OTA остались живы (код " + broken.code + ")");
  if (broken.code !== 0 || /❌/.test(broken.out)) console.log(broken.out.split("\n").map((l) => "    " + l).join("\n"));

  console.log("\n[5] Ребёнок: упавший шаг остановки не отменяет остальные");
  const control = runChild(["--quick", "--break=term"]);
  ok(control.code === 0 && !/❌/.test(control.out), "упавший терминал не отменил превью и мост (код " + control.code + ")");
  if (control.code !== 0 || /❌/.test(control.out)) console.log(control.out.split("\n").map((l) => "    " + l).join("\n"));

  finish();
})().catch((e) => {
  console.log("  ❌ прогон сорвался: " + String((e && e.stack) || e).split("\n")[0]);
  console.log("\nИтог: провал");
  process.exit(1);
});

"use strict";
/* ─── Живой прогон браузерных инструментов агента ─────────────────────────────
   Запуск: npm run test:live:tools-browser   (node scripts/live-tools-browser.js)

   Зачем этот прогон. Двадцать один обработчик браузера (browserConnect …
   browserClearProfile) уехали своим модулем (часть 40, заход 13). Здесь
   проверяется ПРОВОДКА и поведение на живой сборке:

     • модуль собран ОДИН раз, получил тот же deps и ЖИВОЙ мост, а в реестре лежат
       ССЫЛКИ на него (а не копии);
     • каждый обработчик зовёт СВОЙ метод браузерного набора и передаёт доводы как
       есть (доводы сверяются по записи вызова), а ответ отдаёт не меняя;
     • browserStatus и browserClearProfile зовутся БЕЗ доводов — как в приложении;
     • подсказка о справочнике в browserOpen появляется только там, где надо, а
       сам справочник ищется НАСТОЯЩИМ guideForUrl (в шапке vk.md есть sites:);
     • снимок ложится файлом, картинка уходит в ленту ЧЕРЕЗ ЖИВОЙ МОСТ, а на
       отказе браузера ни файла, ни события нет;
     • зрение не настроено — сказано, где включить.

   Chromium НЕ поднимается: прогон проверяет проводку, а не сайт (замер: в этой
   среде запуск браузера не удаётся — «browserType.launchPersistentContext: Target
   page, context or browser has been closed», поэтому настоящие отказы набора для
   прогона и есть тот случай, который видит человек без запущенного браузера).
   В сеть прогон не ходит. Ветка зрения с настоящей вспомогательной моделью не
   проверяется — это поход в сеть, её сторожит набор (`test/smoke.test.js`). */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-browser-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-browser-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 2).join(" | ").slice(0, 170);

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const settingsPath = path.join(userData, "settings.json");
fs.writeFileSync(
  settingsPath,
  JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2)
);

// Настоящий браузерный набор: прогон его НЕ подменяет, а оборачивает — каждая
// функция записывает вызов и работает по-настоящему. Отдельные методы прогон
// ненадолго «заговаривает» (scripted), чтобы проверить решения самого обработчика
// (подсказка справочника, снимок) там, где настоящий браузер не поднимается.
const real = require(path.join(ROOT, "src", "browser-tools.js"));
const calls = [];
const scripted = {};
const fake = { __real: real };
for (const k of Object.keys(real)) {
  const fn = real[k];
  if (typeof fn !== "function") { fake[k] = fn; continue; }
  fake[k] = function (...a) {
    calls.push(k + ":" + JSON.stringify(a));
    if (scripted[k]) return scripted[k].apply(null, a);
    return fn.apply(real, a);
  };
}

const rendererEvents = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: {
    id,
    send: (ch, ev) => { rendererEvents.push({ ch: String(ch), ev: ev }); },
    on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {},
  },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

const handlers = new Map();
const seen = { browser: 0, browserDeps: null, browserLive: null, browserArgs: 0, browserTools: null, toolDeps: null, api: null, tools: null, runLive: null };
const origin = Module._load;
Module._load = function (req) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.207", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
      BrowserWindow: function () { return mkWin(31); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  // Точный перехват по имени файла: подстрока «browser-tools» загладила бы
  // agent-tools-browser.js, а подстрока «agent-tools» — соседей по дому
  // (ловушки 0 и 4.1 в HANDOFF §4).
  if (/^\.\.?\/browser-tools\.js$/.test(t) || /(^|[\\/])browser-tools\.js$/.test(t)) return fake;
  if (/agent-tools-browser\.js$/.test(t)) {
    const realMod = origin.apply(this, arguments);
    return {
      createBrowserTools: function (deps, live) {
        seen.browser++;
        seen.browserDeps = deps;
        seen.browserLive = live;
        seen.browserArgs = arguments.length;
        seen.browserTools = realMod.createBrowserTools(deps, live);
        return seen.browserTools;
      },
    };
  }
  // Мост прогона (run-ai.js): прогон ставит через него отправку событий в окно —
  // встаём на его место ровно тем же движением.
  if (/run-ai\.js$/.test(t)) {
    const realRun = origin.apply(this, arguments);
    return {
      createRunAi: (deps) => {
        seen.runLive = deps.live;
        return realRun.createRunAi(deps);
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const realShell = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolDeps = deps;
        seen.tools = realShell.createAgentTools(deps);
        return seen.tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const realReg = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seen.api = realReg.createToolRegistry(deps);
        return seen.api;
      },
      describeToolArgs: realReg.describeToolArgs,
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

const NAMES = ["browserConnect", "browserOpen", "browserSnapshot", "browserFill", "browserClick", "browserAct", "browserSelect", "browserPress", "browserText", "browserScreenshot", "browserEval", "browserDOM", "browserOverlays", "browserWait", "browserScroll", "browserHover", "browserNetwork", "browserReplay", "browserClose", "browserStatus", "browserClearProfile"];
// Обработчик → метод набора → доводы (null — звать без доводов, как в приложении).
const CALLS = [
  ["browserConnect", "connect", { port: 9222 }],
  ["browserSnapshot", "snapshot", { limit: 5, filter: "войти" }],
  ["browserFill", "fill", { ref: "e1", text: "привет" }],
  ["browserClick", "click", { ref: "e2" }],
  ["browserAct", "act", { steps: [{ op: "click", ref: "e3" }] }],
  ["browserSelect", "select", { ref: "e4", value: "раз" }],
  ["browserPress", "press", { key: "Enter" }],
  ["browserText", "text", { limit: 4 }],
  ["browserEval", "evalJs", { code: "1+1" }],
  ["browserDOM", "domHtml", { ref: "e5" }],
  ["browserOverlays", "overlays", { dismiss: false }],
  ["browserWait", "wait", { ms: 10 }],
  ["browserScroll", "scroll", { direction: "down" }],
  ["browserHover", "hover", { ref: "e6" }],
  ["browserNetwork", "network", { since: false }],
  ["browserReplay", "replay", { match: "попроб" }],
  ["browserClose", "close", {}],
  ["browserStatus", "status", null],
  ["browserClearProfile", "clearProfile", null],
];

(async () => {
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон браузерных инструментов агента (настоящий main.js)");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = async (name, args) => {
    try { return plain(await executeTool(name, args || {}, settings)); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };

  try {
    console.log("\n[1] проводка: модуль собран один раз, с тем же deps и живым мостом");
    ok(seen.browser === 1, "createBrowserTools вызван " + seen.browser + " раз(а)");
    ok(seen.browserDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.browserArgs === 2, "модулю передан и живой мост (аргументов: " + seen.browserArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.browserTools || {})[n] !== "function");
    ok(missing.length === 0, "все двадцать один обработчик на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.browserTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    ok(d.browserTools === fake, "модуль взял браузерный набор из main.js (тот же объект)");
    ok(fake.__real === real, "набор прогона — обёртка вокруг НАСТОЯЩЕГО browser-tools.js");
    // У каждого модуля СВОЙ объект моста (одноимённые геттеры к одним переменным
    // main.js), поэтому сравнивать объекты бессмысленно — важен общий живой ход:
    // отправитель, поставленный прогоном, обязан быть виден мосту модуля (шаг [5]).
    ok(!!seen.browserLive && "activeEmit" in seen.browserLive, "мост модуля отдаёт активного отправителя: " + String(seen.browserLive && seen.browserLive.activeEmit));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"browserOpen": async') < 0, "тела обработчиков не остались в файле-оболочке");
    ok(/const agentBrowser = createBrowserTools\(deps, live\);/.test(shellSrc), "сборка модуля на месте — с живым мостом");
    ok(shellSrc.indexOf("const browserTools = createBrowserTools") < 0, "модуль назван browserTools — имя занято настоящим набором");

    console.log("\n[2] каждый обработчик зовёт СВОЙ метод набора, и доводы не меняются");
    for (const [tool, method, args] of CALLS) {
      calls.length = 0;
      scripted[method] = () => "ответ " + method;
      const via = await call(tool, args === null ? {} : args);
      delete scripted[method];
      const want = method + ":" + JSON.stringify(args === null ? [] : [args]);
      ok(via === "ответ " + method, "ответ «" + tool + "» отдан как есть: " + oneLine(via));
      ok(calls.length === 1 && calls[0] === want, "доводы «" + tool + "» дошли как есть" + (calls.length === 1 ? (calls[0] === want ? "" : ", а пришли: " + calls[0].slice(0, 120)) : ", вызовов: " + calls.length));
    }

    console.log("\n[3] настоящий набор отвечает как есть (браузер не запущен)");
    const realText = plain(await real.text({}));
    ok(/^Браузер не запущен/.test(realText), "настоящий набор без браузера отвечает честным отказом: " + oneLine(realText));
    calls.length = 0;
    const viaText = await call("browserText", { limit: 4 });
    ok(viaText === realText, "ответ настоящего набора отдан как есть");
    ok(calls.length === 1 && calls[0] === 'text:[{"limit":4}]', "до настоящего набора дошёл именно text с теми же доводами");
    calls.length = 0;
    const viaStatus = await call("browserStatus", {});
    ok(viaStatus === plain(await real.status()), "browserStatus назвал состояние настоящего набора: " + oneLine(viaStatus, 2));
    ok(calls.length === 1 && calls[0] === "status:[]", "browserStatus позвал набор БЕЗ доводов: " + (calls[0] || "вызова не было"));

    console.log("\n[4] справочник по адресу: настоящий guideForUrl и подсказка к месту");
    const g = d.guideForUrl("https://vk.com/лента");
    ok(!!g && g.name === "vk", "настоящий guideForUrl находит справочник по vk.com: " + JSON.stringify(g));
    scripted.open = () => "Вкладка tab1 открыта (движок: Chromium)";
    const guided = await call("browserOpen", { url: "https://vk.com/лента" });
    scripted.open = () => "Вкладка tab2 открыта (движок: Chromium)";
    const noGuide = await call("browserOpen", { url: "https://example.com/проба" });
    delete scripted.open;
    ok(guided.indexOf("📘 По этому сайту есть справочник агента «vk»") > 0, "подсказка о справочнике не добавлена: " + oneLine(guided));
    ok(guided.indexOf('agentGuide { name: "vk" }') > 0, "подсказка не зовёт справочник: " + oneLine(guided, 3));
    ok(noGuide === "Вкладка tab2 открыта (движок: Chromium)", "к адресу без справочника ответ изменён: " + oneLine(noGuide));
    scripted.open = () => "Ошибка: браузер не запущен";
    const refusedOpen = await call("browserOpen", { url: "https://vk.com/лента" });
    scripted.open = () => realText;
    const decorated = await call("browserOpen", { url: "https://vk.com/лента" });
    delete scripted.open;
    ok(refusedOpen === "Ошибка: браузер не запущен", "к отказу «Ошибка: …» подсказка приклеена: " + oneLine(refusedOpen));
    ok(decorated.indexOf("📘") > 0, "к настоящему отказу набора подсказка не приклеивается");
    const realError = String((await real.screenshotFile({})).error || "");
    ok(/^Браузер не запущен/.test(realError) && !/^Ошибка/.test(realError), "и снимок набора отказывает тем же честным текстом, без «Ошибка»: " + oneLine(realError));
    console.log("    └ ЗАПИСЬ (не исправлено): отказы набора не начинаются с «Ошибка», а сторож подсказки — только этот префикс, поэтому отказ («" + oneLine(realText) + "») выглядит как успех и подсказка приклеивается. Та же болезнь у vaultFill (HANDOFF §6.1); правильный список префиксов у browser-tools.js есть (isBrowserFailure), но не экспортируется.");

    console.log("\n[5] снимок: файл, событие через живой мост и честный отказ");
    ok(seen.runLive.activeEmit === null, "без прогона отправителя нет: " + String(seen.runLive.activeEmit));
    seen.runLive.activeEmit = (ev) => rendererEvents.push({ ch: "ai:event", ev: ev });
    ok(!!seen.browserLive && seen.browserLive.activeEmit === seen.runLive.activeEmit, "мост модуля видит отправителя, поставленного прогоном" + (seen.browserLive ? "" : " (моста нет)"));
    const shotPath = path.join(userData, "снимок.png");
    fs.writeFileSync(shotPath, Buffer.from(PNG, "base64"));
    const shotDir = path.join(os.tmpdir(), "ai-agent-shots");
    calls.length = 0;
    scripted.screenshotFile = () => ({ buf: fs.readFileSync(shotPath), path: shotPath, url: "http://127.0.0.1:1/проба", title: "Проба" });
    const shot = await call("browserScreenshot", { analyze: false });
    ok(/OK — скриншот сохранён/.test(shot) && shot.indexOf(shotPath) > 0, "снимок назван файлом: " + oneLine(shot));
    ok(/Дальше: analyzeImage \{ path: /.test(shot), "агент не отправлен разбирать файл: " + oneLine(shot, 3));
    ok((calls[0] || "").indexOf(JSON.stringify(shotDir)) > 0, "снимок просят в папку снимков системы: " + (calls[0] || "").slice(0, 170));
    ok(rendererEvents.length === 1 && rendererEvents[0].ev && rendererEvents[0].ev.type === "image" && rendererEvents[0].ev.path === shotPath, "событие картинки не доехало через живой мост: " + JSON.stringify(rendererEvents).slice(0, 150));
    ok(String((rendererEvents[0].ev || {}).dataUrl).indexOf("data:image/png;base64,") === 0, "в событии не картинка data-URL");
    const blind = await call("browserScreenshot", {});
    ok(/Зрение не настроено — работай по DOM/.test(blind) && /Настройки → вкладка «Зрение»/.test(blind), "не сказано, где включить зрение: " + oneLine(blind, 4));
    delete scripted.screenshotFile;
    const beforeShots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).length : 0;
    rendererEvents.length = 0;
    const refusedShot = await call("browserScreenshot", { analyze: false });
    ok(/^Браузер не запущен/.test(refusedShot), "на отказе агент получает причину: " + oneLine(refusedShot));
    ok(rendererEvents.length === 0, "на отказе ушло событие картинки");
    ok((fs.existsSync(shotDir) ? fs.readdirSync(shotDir).length : 0) === beforeShots, "на отказе появился файл снимка");

    console.log("\n[6] гигиена прогона");
    ok(fs.readdirSync(work).filter((f) => f !== ".agent").length === 0, "в рабочую папку ничего не написали: " + fs.readdirSync(work).join(", "));
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки браузерных инструментов пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон оборвался: " + ((e && e.stack) || e));
  process.exit(1);
});

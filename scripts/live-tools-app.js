"use strict";
/* ─── Живой прогон инструментов окна и рабочего стола ────────────────────────
   Запуск: npm run test:live:tools-app   (node scripts/live-tools-app.js)

   Зачем этот прогон. Двенадцать обработчиков (окно САМОГО приложения, askUser,
   буфер обмена, скриншот экрана, открытие пути) уехали своим модулем (часть 40,
   заход 8). Здесь проверяется ПРОВОДКА и поведение на живой сборке:

     • модуль собран ОДИН раз, получил тот же deps и живой мост, а в реестре лежат
       ССЫЛКИ на него (а не копии);
     • окно приложения инструменты берут ЖИВЫМ мостом: `live.mainWindow` отдаёт ТО
       ЖЕ окно, которое создал main.js (иначе агент работал бы с копией и после
       перезапуска окна «слеп»);
     • appRead/appClick работают на настоящем окне через настоящий app-ui-tools;
     • скриншот окна и экрана доезжает событием до ОКНА (webContents.send), а
       скриншот экрана ложится ФАЙЛОМ в настоящую папку скриншотов;
     • буфер обмена и открытие пути — через тот же electron, что у приложения.

   Ничего наружу не уходит: всё в своей временной папке. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-app-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-app-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 1).join(" | ").slice(0, 120);
const info = (msg) => console.log("  · " + msg);

fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2)
);
info("рабочая папка: " + path.basename(work));

/* ── Поддельное окно с настоящим DOM-фейком ─────────────────────────────────
   app-ui-tools вставляет в окно скрипт и читает ответ: значит окно обязано
   исполнять его по-настоящему (new Function), иначе проверка была бы про заглушку. */
const matches = (el, sel) => {
  sel = String(sel).trim();
  // Список через запятую — обычное дело: app-ui-tools ищет 'button, a, input, …'.
  if (sel.indexOf(",") !== -1) return sel.split(",").some((s) => matches(el, s));
  const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    const v = el.getAttribute(attr[1]);
    return attr[2] === undefined ? v !== null : v === attr[2];
  }
  const tag = sel.match(/^[a-zA-Z][\w-]*/);
  const id = sel.match(/#([\w-]+)/);
  const cls = sel.match(/\.([\w-]+)/);
  if (!tag && !id && !cls) return false;
  if (tag && String(el.tagName).toLowerCase() !== tag[0].toLowerCase()) return false;
  if (id && el.id !== id[1]) return false;
  if (cls && String(el.className).split(/\s+/).indexOf(cls[1]) < 0) return false;
  return true;
};
class El {
  constructor(tag, attrs, opts) {
    const a = Object.assign({}, attrs || {});
    const o = opts || {};
    this.tagName = tag.toUpperCase();
    this._attrs = a;
    this.id = a.id || "";
    this.className = a.class || "";
    this.innerText = o.text != null ? o.text : a.__text || "";
    this.textContent = this.innerText;
    this.placeholder = a.placeholder || "";
    this.title = a.title || "";
    this.type = a.type || "";
    this._v = a.value || "";
    this.disabled = !!o.disabled;
    this.checked = !!o.checked;
    this.isContentEditable = !!o.ce;
    this.labels = o.labels || [];
    this.onclick = o.onclick || null;
    this.clicks = 0;
    this.events = [];
    this._parent = o.parent || null;
    this._gone = !!o.gone;
    this.rect = o.rect || { width: 90, height: 24, top: 10, left: 10, bottom: 34, right: 100 };
  }
  get value() { return this._v; }
  set value(v) { this._v = v; }
  getAttribute(n) { return n in this._attrs ? String(this._attrs[n]) : null; }
  setAttribute(n, v) { this._attrs[n] = String(v); }
  getBoundingClientRect() { return Object.assign({}, this.rect); }
  scrollIntoView() { this.scrolled = true; }
  click() { this.clicks++; }
  dispatchEvent(e) { this.events.push(e && e.type); return true; }
  closest(sel) {
    let n = this._parent;
    while (n) {
      if (matches(n, sel)) return n;
      n = n._parent;
    }
    return null;
  }
}
function Proto() {}
Object.defineProperty(Proto.prototype, "value", { get() { return this._v; }, set(v) { this._v = v; }, configurable: true });
class FakeEvent { constructor(type) { this.type = type; } }

const nativeImage = (w, h, tag) => ({
  __tag: tag,
  isEmpty: () => false,
  getSize: () => ({ width: w, height: h }),
  resize: () => nativeImage(w, h, tag),
  toJPEG: () => Buffer.from("jpeg-" + tag),
  toPNG: () => Buffer.from("png-" + tag),
});

const elements = [
  new El("button", { id: "btn-settings", __text: "Настройки" }),
  new El("button", { id: "btn-secrets", __text: "Секреты" }),
  new El("input", { id: "s-model", placeholder: "Модель", value: "gpt-4o" }),
];
const rendererEvents = [];
const shotSources = [{ name: "Панель Спуник — Chrome", thumbnail: nativeImage(1280, 800, "panel") }];
let captureThrows = null;
let openPathAnswer = "";

const createdWins = [];
function makeWin() {
  const doc = {
    title: "AI Developer Agent",
    body: { innerText: "Текст окна для агента" },
    activeElement: null,
    querySelectorAll: (sel) => elements.filter((el) => !el._gone && matches(el, sel)),
    querySelector: (sel) => elements.filter((el) => !el._gone && matches(el, sel))[0] || null,
  };
  const win = {
    __aiAppRefSeq: 0,
    document: doc,
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    show: () => {}, focus: () => {}, restore: () => {}, setTitle: () => {}, loadFile: () => Promise.resolve(),
    on: () => {}, once: () => {},
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send: (ch, ev) => rendererEvents.push({ ch: ch, ev: ev }),
      on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {},
      executeJavaScript: (code) =>
        Promise.resolve(
          new Function(
            "document", "window", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "Event",
            "return " + code + ";"
          )(doc, win, () => ({ display: "block", visibility: "visible", opacity: "1" }), Proto, Proto, FakeEvent)
        ),
      capturePage: async () => {
        if (captureThrows) throw new Error(captureThrows);
        return nativeImage(1200, 800, "window");
      },
    },
  };
  createdWins.push(win);
  return win;
}

// Буфер обмена как в Electron 44: методы асинхронные (на них и наткнулись в 1.5.19x).
let clipText = "";
const clipboard = {
  writeText: async (text) => { clipText = String(text); },
  readText: async () => clipText,
};

const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const seen = { app: 0, appDeps: null, appLive: null, appArgs: 0, appTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.203", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async (p) => { info("shell.openPath: " + p); return openPathAnswer; } },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return makeWin(); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: clipboard,
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: {
        getSources: async () => {
          if (captureThrows) throw new Error(captureThrows);
          return shotSources;
        },
      },
      globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  // Перехват ровно по имени файла: подстрока «agent-tools» заглатывала бы соседей по
  // дому (эта ошибка уже стоила двух молчавших прогонов — см. заход 4.1).
  if (/agent-tools-app\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAppTools: function (deps, live) {
        seen.app++;
        seen.appDeps = deps;
        seen.appLive = live;
        seen.appArgs = arguments.length;
        seen.appTools = real.createAppTools(deps, live);
        return seen.appTools;
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolDeps = deps;
        seen.tools = real.createAgentTools(deps);
        return seen.tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seen.api = real.createToolRegistry(deps);
        return seen.api;
      },
      describeToolArgs: real.describeToolArgs,
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

const NAMES = ["appRead", "appClick", "appFill", "appSelect", "appPress", "appWait", "appScreenshot", "askUser",
  "clipboardWrite", "clipboardRead", "screenshotDesktop", "openPath"];

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон инструментов окна и рабочего стола (настоящий main.js)");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = async (name, args) => {
    try { return await executeTool(name, args || {}, settings); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };

  try {
    console.log("\n[1] проводка: модуль собран один раз, с тем же deps и живым мостом");
    ok(seen.app === 1, "createAppTools вызван " + seen.app + " раз(а)");
    ok(seen.appDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.appArgs === 2, "модулю передан и живой мост (аргументов: " + seen.appArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.appTools || {})[n] !== "function");
    ok(missing.length === 0, "все двенадцать обработчиков на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.appTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"appRead": async') < 0 && shellSrc.indexOf('"clipboardRead": async') < 0,
      "тела обработчиков не остались в файле-оболочке");

    console.log("\n[2] окно берётся ЖИВЫМ мостом, а не копией");
    // Формы разные, и это не описка: у deps.live окно берёт ФУНКЦИЯ из main.js, а в
    // live-мосте модуля это уже ЖИВОЕ свойство окна (геттер в agent-tools.js).
    ok(!!d.live && typeof d.live.mainWindow === "function", "main.js отдаёт функцию mainWindow");
    const liveWin = seen.appLive.mainWindow;
    ok(!!liveWin && createdWins.indexOf(liveWin) >= 0, "мост отдаёт ТО ЖЕ окно, которое создал main.js");
    // Свойство ЖИВОЕ, а не копия: каждое чтение спрашивает окно у main.js заново.
    // Проверяем именно это — а не то, что значения «совпали один раз».
    ok(d.live.mainWindow() === liveWin && seen.appLive.mainWindow === d.live.mainWindow(),
      "чтение окна идёт мостом: одно и то же окно с двух сторон");

    console.log("\n[3] appRead/appClick/appScreenshot — на настоящем окне через настоящий app-ui-tools");
    // Вне прогона main.js отдаёт пустой отправитель событий (лента живёт только во время
    // работы), поэтому подменяем ИМЕННО значение моста: так видно, что картинка уходит
    // через live.activeEmit, а не своим путём. Настоящую доставку в окно проверяет
    // test:live:desktop (там окно и панели настоящие).
    const emitted = [];
    d.live.activeEmit = () => (ev) => emitted.push(ev);
    const read = plain(await call("appRead", {}));
    ok(/Настройки/.test(read) && /btn-settings/.test(read), "карта окна получена: " + oneLine(read));
    ok(!/gpt-4o/.test(read), "значение поля утекло в карту окна");
    const click = plain(await call("appClick", { ref: "e1" }));
    ok(/^OK/.test(click), "клик по ref прошёл: " + oneLine(click));
    ok(elements[0].clicks === 1, "клик дошёл до настоящего элемента (кликов: " + elements[0].clicks + ")");
    emitted.length = 0;
    const shot = plain(await call("appScreenshot", {}));
    ok(/^OK — скриншот окна приложения снят/.test(shot), "скриншот окна снят: " + oneLine(shot));
    const shotEvent = emitted.find((e) => e && e.type === "image");
    ok(!!shotEvent, "картинка ушла событием через живой мост" + (shotEvent ? "" : ": " + JSON.stringify(emitted).slice(0, 160)));
    ok(!!shotEvent && shotEvent.path === "app:window", "событие назвало источник картинки: " + (shotEvent && shotEvent.path));
    ok(!!shotEvent && /^data:image\//.test(String(shotEvent.dataUrl)), "картинка в событии — настоящий data-URL");

    console.log("\n[4] буфер обмена и askUser через реестр");
    const wrote = plain(await call("clipboardWrite", { text: "строка-в-буфер" }));
    ok(/^OK — текст скопирован в буфер обмена \(14 симв\.\)/.test(wrote), "запись в буфер подтверждена: " + oneLine(wrote));
    ok(clipText === "строка-в-буфер", "текст действительно лёг в буфер: " + JSON.stringify(clipText));
    const readBack = plain(await call("clipboardRead", {}));
    ok(/строка-в-буфер/.test(readBack), "буфер прочитан обратно: " + oneLine(readBack));
    const asked = plain(await call("askUser", { question: "Какой порт?" }));
    ok(/askUser обрабатывается отдельно/.test(asked), "askUser объяснил, что обрабатывается отдельно: " + oneLine(asked));

    console.log("\n[5] скриншот ЭКРАНА: файл на диске и событие в ленту");
    emitted.length = 0;
    const desk = plain(await call("screenshotDesktop", {}));
    ok(/скриншот «Панель Спуник — Chrome» \(1280×800\)/.test(desk), "скриншот экрана снят: " + oneLine(desk));
    const deskEvent = emitted.find((e) => e && e.type === "image");
    ok(!!deskEvent && deskEvent.path === "desktop:Панель Спуник — Chrome", "картинка экрана ушла событием");
    const saved = (/сохранён: ([^\s]+\.(?:jpg|png))/.exec(desk) || [])[1] || "";
    ok(!!saved && fs.existsSync(saved), "скриншот лёг ФАЙЛОМ: " + saved);
    ok(!!saved && fs.statSync(saved).size > 0, "файл скриншота не пустой: " + (saved ? fs.statSync(saved).size + " байт" : "файла нет"));

    console.log("\n[6] openPath: настоящий путь и честный отказ");
    const target = path.join(work, "проверить-открытие.txt");
    fs.writeFileSync(target, "проверка", "utf8");
    const opened = plain(await call("openPath", { path: target }));
    ok(/^OK — открыто системным приложением/.test(opened), "путь открыт: " + oneLine(opened));
    openPathAnswer = "нет приложения";
    const denied = plain(await call("openPath", { path: target }));
    ok(/Не удалось открыть: нет приложения/.test(denied), "отказ системы назван: " + oneLine(denied));
    openPathAnswer = "";
    const gone = plain(await call("openPath", { path: path.join(work, "нет-такого-файла-77.txt") }));
    ok(/путь не найден/.test(gone), "несуществующий путь отвергнут: " + oneLine(gone));

    console.log("\n[7] отказ окна и отказ захвата не молчат");
    captureThrows = "окно недоступно";
    const shotFail = plain(await call("appScreenshot", {}));
    ok(/Ошибка вызова appScreenshot|недоступно|Пустой/.test(shotFail), "отказ скриншота окна назван: " + oneLine(shotFail));
    const deskFail = plain(await call("screenshotDesktop", {}));
    ok(/Ошибка захвата экрана: окно недоступно/.test(deskFail), "отказ захвата экрана назван: " + oneLine(deskFail));
    captureThrows = null;

    console.log("\n[8] гигиена прогона");
    ok(fs.readdirSync(work).filter((f) => f !== ".agent").length === 1, "в рабочей папке только наш файл: " + fs.readdirSync(work).join(", "));
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки окна и рабочего стола пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон оборвался: " + ((e && e.stack) || e));
  process.exit(1);
});

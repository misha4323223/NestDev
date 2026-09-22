"use strict";
/* ─── Живой прогон медиа, просмотра и справки ─────────────────────────────────
   Запуск: npm run test:live:tools-media   (node scripts/live-tools-media.js)

   Зачем этот прогон. Десять обработчиков (поиск инструментов, открытие ссылки,
   показ и разбор картинок, генерация картинки, дифф, предпросмотр, скриншот
   страницы, ожидание покоя и справочники) уехали своим модулем (часть 40,
   заход 10). Половина из них ничего не возвращает словами, а ШЛЁТ СОБЫТИЕ в
   окно — этого текстовый сторож не видит вовсе.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельные только `electron` и окно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящие src/agent-tools.js и src/agent-tools-media.js;
     • настоящее окно-свидетель: `webContents.send` записывает события, поэтому
       видно, доехала ли картинка/дифф/предпросмотр до человека;
     • настоящие файлы картинок в рабочей папке и настоящий поиск инструментов
       (`findTools` ищет по тем же описаниям, что у схем).

   Чего прогон НЕ делает: не ходит в сеть и не зовёт вспомогательную модель
   (её ветки проверяются по честному отказу), не открывает браузер. Настоящий
   захват страницы живёт в `npm run test:live:screens` — здесь только ветка отказа. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-media-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-media-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const lines = (t, n) => plain(t).split("\n").slice(0, n || 3).join(" | ").slice(0, 170);

// Картинки и файлы для просмотра.
const pngB64 = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const pngB64b = Buffer.from("89504e470d0a1a0b0000000d49484452", "hex").toString("base64");
fs.writeFileSync(path.join(work, "кадр.png"), Buffer.from(pngB64, "base64"));
fs.writeFileSync(path.join(work, "второй.png"), Buffer.from(pngB64b, "base64"));
fs.writeFileSync(path.join(work, "заметки.txt"), "это не картинка, а текст\n", "utf8");
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2));

// ── Окно-свидетель: события из main.js доезжают сюда ───────────────────────
const rendererEvents = [];
const openedUrls = [];
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
const seen = { media: 0, mediaDeps: null, mediaLive: null, mediaArgs: 0, mediaTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.205", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: {
        openExternal: async (u) => { openedUrls.push(String(u)); },
        showItemInFolder: () => {},
        openPath: async () => "",
      },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(21); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  // Точный перехват по имени файла (ловушка захода 4.1: подстрока «agent-tools»
  // заглатывала соседей по дому и роняла прогоны).
  if (/agent-tools-media\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createMediaTools: function (deps, live) {
        seen.media++;
        seen.mediaDeps = deps;
        seen.mediaLive = live;
        seen.mediaArgs = arguments.length;
        seen.mediaTools = real.createMediaTools(deps, live);
        return seen.mediaTools;
      },
    };
  }
  // Мост прогона (run-ai.js): через него прогон ставит отправку событий в окно —
  // в этом прогоне мы встаём на его место ровно тем же движением.
  if (/run-ai\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createRunAi: (deps) => {
        seen.runLive = deps.live;
        return real.createRunAi(deps);
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

const NAMES = ["findTools", "openUrl", "showImage", "analyzeImage", "generateImage",
  "diffView", "previewUI", "screenshotCapture", "waitForIdle", "agentGuide"];

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон медиа, просмотра и справки (настоящий main.js, окно-свидетель)");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = async (name, args) => {
    try { return plain(await executeTool(name, args || {}, settings)); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };
  const eventFor = (type) => rendererEvents.filter((e) => e.ev && e.ev.type === type).map((e) => e.ev);
  const lastEvents = () => rendererEvents.slice(-3).map((e) => e.ch + "/" + (e.ev && e.ev.type)).join(", ");

  try {
    console.log("\n[1] проводка: модуль собран один раз, с живым мостом, ссылками");
    ok(seen.media === 1, "createMediaTools вызван " + seen.media + " раз(а)");
    ok(seen.mediaDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.mediaArgs === 2, "модулю передан и живой мост (аргументов: " + seen.mediaArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.mediaTools || {})[n] !== "function");
    ok(missing.length === 0, "все десять обработчиков на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.mediaTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"showImage": async') < 0 && shellSrc.indexOf('"findTools": async') < 0 && shellSrc.indexOf('"agentGuide": async') < 0,
      "тела обработчиков не остались в файле-оболочке");
    ok(/const media = createMediaTools\(deps, live\);/.test(shellSrc), "сборка модуля на месте — с живым мостом");

    console.log("\n[2] findTools: настоящий поиск и честное слово про схемы");
    const empty = await call("findTools", {});
    ok(/Укажи query/.test(empty), "пустой запрос объяснён: " + lines(empty, 1));
    const none = await call("findTools", { query: "зыбучий-песок-на-марсе-xyz" });
    ok(/Ничего не нашлось/.test(none), "пустой поиск назван честно: " + lines(none, 1));
    const foundMail = await call("findTools", { query: "отправить письмо" });
    ok(/Нашёл инструменты по запросу/.test(foundMail), "поиск нашёл инструменты по словам: " + lines(foundMail, 1));
    ok(/mailSend|sendMail/.test(foundMail), "среди найденных есть отправка письма: " + lines(foundMail, 2));
    // Без прогона роутера в живом мосте модуля нет (он ставится на время прогона) — и ответ
    // НЕ должен говорить, что схемы уже в запросе: именно на этом обещании модель ждала вызова.
    // Строку «Включены группы» трогать нельзя: она печатается всегда и уехала байт в байт из
    // дома (findTools не зовётся агентом вне прогона) — здесь сторожится именно число схем.
    ok(!/Сейчас в запросе/.test(foundMail), "без прогона не сказано, что схемы уже в запросе: " + lines(foundMail, 2));
    ok(/не поместились/.test(foundMail), "честно названо, что схемы не отправлены: " + lines(foundMail, 3));
    const foundPic = await call("findTools", { query: "картинка" });
    ok(/showImage|analyzeImage|generateImage|appScreenshot/.test(foundPic), "поиск по картинкам ведёт к инструментам картинок: " + lines(foundPic, 2));

    console.log("\n[3] отправка событий: её ставит прогон — и только тогда она есть");
    ok(!!seen.runLive, "мост прогона найден (run-ai.js получил свой live)");
    ok(/^Ошибка/.test(await call("showImage", { path: "кадр.png" })) === false, "показ картинки без отправителя не падает");
    ok(seen.runLive.activeEmit === null, "без прогона отправителя нет: " + String(seen.runLive.activeEmit));
    // Ровно то, что делает прогон на старте (run-ai.js: `live.activeEmit = emit`).
    rendererEvents.length = 0;
    seen.runLive.activeEmit = (ev) => rendererEvents.push({ ch: "ai:event", ev: ev });
    ok(typeof seen.runLive.activeEmit === "function", "после установки прогоном отправитель виден инструментам");

    console.log("\n[4] openUrl: ссылка уходит системному браузеру, мусор отклоняется");
    ok(/укажи полный URL/.test(await call("openUrl", { url: "пример.рф" })), "без схемы — понятный отказ");
    openedUrls.length = 0;
    ok(/OK — открыто в браузере/.test(await call("openUrl", { url: "https://example.com/живой" })), "ссылка открыта");
    ok(openedUrls.length === 1 && openedUrls[0] === "https://example.com/живой", "до браузера дошла именно эта ссылка: " + openedUrls.join(", "));

    console.log("\n[5] showImage/analyzeImage: картинка доезжает до окна, разбор честен");
    const notImg = await call("showImage", { path: "заметки.txt" });
    ok(/это не изображение/.test(notImg), "не-картинка отклонена и объяснена: " + lines(notImg, 1));
    const nowhere = await call("showImage", { path: "нет-такой.png" });
    ok(/файл не найден/.test(nowhere), "несуществующий файл назван: " + lines(nowhere, 1));
    rendererEvents.length = 0;
    const shown = await call("showImage", { path: "кадр.png" });
    const imgEvents = eventFor("image");
    ok(/OK — изображение показано пользователю/.test(shown), "картинка показана: " + lines(shown, 1));
    ok(imgEvents.length === 1, "в окно ушло ровно одно событие картинки (события: " + lastEvents() + ")");
    ok(imgEvents[0] && String(imgEvents[0].dataUrl).indexOf("data:image/png;base64,") === 0, "картинка ушла в окно как data-URL: " + String((imgEvents[0] || {}).dataUrl).slice(0, 40));
    ok(String((imgEvents[0] || {}).dataUrl).indexOf(pngB64.slice(0, 24)) > 0, "в окно ушли байты ИМЕННО этого файла");
    const off = await call("analyzeImage", { path: "кадр.png" });
    ok(/вспомогательная модель выключена/.test(off), "выключенная вспомогательная модель объяснена: " + lines(off, 1));
    ok(/Настройках/.test(off), "сказано, где включить: " + lines(off, 1));

    console.log("\n[6] generateImage: без модели — отказ, а не выдуманная картинка");
    ok(/укажи prompt/.test(await call("generateImage", {})), "пустое описание отклонено");
    const gen = await call("generateImage", { prompt: "кот в шапке" });
    ok(/вспомогательная модель выключена/.test(gen), "генерация без модели честно отказана: " + lines(gen, 1));
    ok(!fs.readdirSync(work).some((f) => /^generated-/.test(f)), "файл-пустышка при отказе не создан");

    console.log("\n[7] diffView: дифф открывается в просмотрщике приложения");
    rendererEvents.length = 0;
    const diff = await call("diffView", { path1: "кадр.png", path2: "второй.png" });
    const diffEvents = eventFor("diff");
    ok(/^Дифф /.test(diff), "дифф посчитан: " + lines(diff, 1));
    ok(diffEvents.length === 1, "в окно ушло событие диффа (события: " + lastEvents() + ")");
    ok(diffEvents[0] && /@@|Binary files/.test(String(diffEvents[0].patch)), "в событии есть настоящий патч: " + String((diffEvents[0] || {}).patch).slice(0, 60).replace(/\n/g, " "));
    const same = await call("diffView", { path1: "кадр.png", path2: "кадр.png" });
    ok(/Файлы идентичны/.test(same), "одинаковые файлы названы одинаковыми: " + lines(same, 1));

    console.log("\n[8] previewUI: встроенный предпросмотр открывается событием");
    ok(/укажи полный URL/.test(await call("previewUI", { url: "localhost:3000" })), "адрес без схемы отклонён");
    rendererEvents.length = 0;
    const prev = await call("previewUI", { url: "http://localhost:3000" });
    const prevEvents = eventFor("preview");
    ok(prevEvents.length === 1 && prevEvents[0].url === "http://localhost:3000", "предпросмотр открыт событием: " + lastEvents());
    ok(/OK — открыт встроенный предпросмотр/.test(prev), "агент получил ответ: " + lines(prev, 1));

    console.log("\n[9] screenshotCapture: ветка отказа (настоящий захват — в live:screens)");
    ok(/укажи полный URL/.test(await call("screenshotCapture", { url: "ftp://пример" })), "неподдерживаемый адрес отклонён");
    const shotMissing = seen.mediaTools.screenshotCapture ? "есть" : "нет";
    ok(shotMissing === "есть", "обработчик скриншота страницы на месте");

    console.log("\n[10] waitForIdle и agentGuide: помощники живут в своих модулях");
    const idle = await call("waitForIdle", {});
    ok(typeof idle === "string" && idle.length > 0, "покой спрошен у настоящего browser-tools и ответил: " + lines(idle, 1));
    const guide = await call("agentGuide", {});
    ok(/agentGuide \{ name:/.test(guide), "справочник агента отдал маршруты: " + lines(guide, 1));
    const guideMatch = await call("agentGuide", { url: "https://console.cloud.google.com/" });
    ok(/справочник|Для этого адреса справочника нет/.test(guideMatch), "подбор справочника по адресу отвечает по делу: " + lines(guideMatch, 1));
  } catch (e) {
    fail++;
    console.error("❌ Прогон упал: " + ((e && e.stack) || e));
  }

  console.log("\nЖивой прогон медиа, просмотра и справки: " + pass + " ✅ / " + fail + " ❌");
  clearTimeout(watchdog);
  process.exit(fail ? 1 : 0);
})();

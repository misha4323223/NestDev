"use strict";
/* ─── Живой прогон справочников по сайтам (без окна, но с настоящим main.js) ──
   Запуск: bun run test:live:guides   (node scripts/live-guides.js)

   Зачем. С этапа B, части 11 логика справочников (guideForUrl / guideReadText /
   agentGuideCall) живёт в своём модуле, а оболочка отдаёт её инструментам.
   Модульный набор проверяет сам модуль; здесь проверяется ПРОВОДКА в настоящем
   main.js: он грузится в Node с поддельным electron (окна в песочнице нет),
   инструменты — живые, справочники — настоящие файлы.

   Что проверяется по-настоящему:
     • агент получает все шесть имён справочников (пропажа любого — падение на вызове);
     • встроенный набор находится из папки кода, а не из пустого пути;
     • инструмент agentGuide и readFile(path: "agent-guide:vk") читают настоящий гайд;
     • browserOpen подсказывает справочник по адресу;
     • выученный маршрут сохраняется в папку приложения, НЕ в код (папка
       src/agent-guides сверяется по хэшам до и после) и сразу перекрывает встроенный.

   Папка приложения — временная: прогон не трогает ни настройки, ни справочники
   рабочего ПК. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-guides-userData-"));
const guidesInCode = path.join(ROOT, "src", "agent-guides");

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

// Снимок встроенного набора: прогон не имеет права его менять.
const snapshot = (dir) => {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    out[f] = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, f))).digest("hex");
  }
  return out;
};
const before = snapshot(guidesInCode);

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

// main.js берём как есть, подделываем только то, чего в Node нет.
const handlers = new Map();
const captured = {};
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
        getVersion: () => "1.5.161",
        setName: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return stub("BrowserWindow"); },
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
  // Браузер в песочнице не поднимаем: страницу изображает заглушка, а подсказка
  // о справочнике («📘 По этому сайту есть справочник…») — настоящая, из main.js.
  if (/browser-tools\.js$/.test(String(req))) {
    const mod = origin.call(this, req, parent, isMain);
    return Object.assign({}, mod, {
      open: async (args) => "Открыл " + String((args || {}).url || "") + " (заглушка прогона: браузер не поднимаем)",
    });
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});
require(path.join(ROOT, "src", "main.js"));

(async () => {
  console.log("Живой прогон справочников по сайтам (main.js без окна)");
  await new Promise((r) => setTimeout(r, 300));

  const tools = captured.tools;
  const deps = captured.deps || {};
  if (!tools || !tools.agentGuide || !tools.readFile) {
    console.log("  ❌ main.js не собрал инструменты — прогон невозможен");
    process.exit(1);
  }

  console.log("\n[1] Проводка: оболочка отдаёт справочники инструментам");
  // Инструменты получают пять имён: чтение конкретного файла берёт на себя их
  // же guideFilePath (сам guideReadText зовёт оболочка — им читается гайд,
  // который уезжает в контекст модели).
  for (const name of ["guideSafeName", "guideFilePath", "guideIndex", "guideForUrl", "agentGuideCall"]) {
    ok(typeof deps[name] === "function", "в проводке есть " + name + " (" + typeof deps[name] + ")");
  }
  ok(deps.guideSafeName("agent-guide:Google-Cloud") === "google-cloud", "имя справочника приводится к безопасному виду");
  const vkPath = deps.guideFilePath("agent-guide:vk", false);
  ok(!!vkPath && /ВК-мессенджер/.test(fs.readFileSync(vkPath, "utf8")), "дорожка к справочнику ведёт к настоящему файлу: " + vkPath);

  console.log("\n[2] Встроенный набор: настоящая папка кода, а не пустой путь");
  const list = deps.guideIndex();
  ok(list.length >= 8, "встроенных справочников найдено: " + list.length);
  for (const need of ["vk", "google-cloud", "github", "chat-analysis", "app", "browser", "system", "yc"]) {
    ok(list.some((g) => g.name === need), "справочник «" + need + "» на месте");
  }
  ok(list.every((g) => g.learned === false), "встроенные справочники не помечены выученными");
  ok((deps.guideForUrl("https://www.vk.com/im") || {}).name === "vk", "адрес ВК подхватывает справочник «vk»");
  ok((deps.guideForUrl("https://console.cloud.google.com/apis") || {}).name === "google-cloud", "адрес Google Cloud подхватывает справочник");

  console.log("\n[3] Инструменты агента читают настоящий гайд");
  const viaTool = String(await tools.agentGuide({ name: "vk" }, {}));
  ok(/ВК-мессенджер/.test(viaTool), "agentGuide { name: \"vk\" } отдал гайд по ВК");
  const viaRead = String(await tools.readFile({ path: "agent-guide:vk" }, {}));
  ok(/ВК-мессенджер/.test(viaRead), "readFile(path: \"agent-guide:vk\") отдал гайд по ВК");
  const missing = String(await tools.agentGuide({ name: "нет-такого" }, {}));
  ok(/не найден/.test(missing) && /vk/.test(missing), "отсутствующий справочник назван, список доступных показан");
  const unknown = String(await tools.agentGuide({ action: "телепорт" }, {}));
  ok(/неизвестное действие/.test(unknown), "неизвестное действие объяснено");

  console.log("\n[4] Подсказка при открытии адреса (настоящая проводка guideForUrl)");
  const opened = String(await tools.browserOpen({ url: "https://vk.com/im" }, {}));
  ok(/справочник агента «vk»/.test(opened), "browserOpen подсказал справочник по адресу:\n    " + opened.replace(/\n/g, "\n    "));
  const other = String(await tools.browserOpen({ url: "https://example.org" }, {}));
  ok(!/справочник агента/.test(other), "для чужого адреса подсказки нет");

  console.log("\n[5] Выученный маршрут: в папку приложения, и он сразу перекрывает встроенный");
  const saved = String(await tools.agentGuide({ save: "live-test", title: "Живой прогон", sites: "live.example.com", steps: "1) открыть 2) нажать" }, {}));
  ok(/^OK — маршрут сохранён/.test(saved), "сохранение подтверждено");
  const savedFile = path.join(userData, "agent-guides", "live-test.md");
  ok(fs.existsSync(savedFile), "маршрут лёг в папку приложения: " + savedFile);
  const after = snapshot(guidesInCode);
  ok(JSON.stringify(before) === JSON.stringify(after), "встроенные справочники не изменились (файлов: " + Object.keys(after).length + ")");
  const learned = deps.guideIndex().find((g) => g.name === "live-test");
  ok(!!learned && learned.learned === true, "выученный маршрут виден как свой");
  ok((deps.guideForUrl("https://live.example.com/page") || {}).name === "live-test", "адрес выученного маршрута находит его");
  const readBack = String(await tools.readFile({ path: "agent-guide:live-test" }, {}));
  ok(/нажать/.test(readBack), "выученный маршрут читается инструментом");

  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  // Упавшая посреди прогона проверка не должна оставлять процесс висеть:
  // у main.js есть свои таймеры (обновления, дела), и без явного выхода
  // прогон превратился бы в молчаливое зависание вместо честного провала.
  console.log("  ❌ прогон сорвался: " + String((e && e.stack) || e).split("\n")[0]);
  console.log("\nИтог: провал");
  process.exit(1);
});

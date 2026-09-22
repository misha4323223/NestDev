"use strict";
/* ─── Живой прогон файловых инструментов агента (чтение и поиск) ─────────────
   Запуск: bun run test:live:tools-files   (node scripts/live-tools-files.js)

   Зачем этот прогон. Десять инструментов чтения и поиска (readFile, readFileLines,
   fileOutline, listFiles, listDirectory, searchProject, searchFile,
   readFileStructure, explainCode, findReferences) до сих пор проверялись только по
   тексту — а после того как они уехали своим модулем (часть 40, заход 3a), «по
   тексту» значит: потерянная ветка не видна никому.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-files.js;
     • настоящие файлы в temp-папке: маленький исходник, большой (900 строк для
       ветки «файл большой»), папка, модуль для поиска ссылок, а также настоящий
       справочник агента из src/agent-guides.

   Проверки:
     [1] проводка: модуль собран один раз с тем же объектом состояния;
     [2] readFile: маленький файл, отсутствующий, большой (обзор вместо выгрузки);
     [3] readFile(category agent-guide:) — настоящий справочник приложения;
     [4] readFileLines: диапазон и выход за конец файла;
     [5] fileOutline: определения и фильтр;
     [6] searchFile: регулярка, контекст, режим блоками, мусорный шаблон;
     [7] listDirectory / listFiles / searchProject / readFileStructure;
     [8] explainCode: по символу, по строке и маркеры TODO;
     [9] findReferences: определение и вызовы по настоящему проекту.

   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-files-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-files-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));

// ── Проект для прогона: настоящие файлы на диске ───────────────────────────
const src = path.join(work, "src");
fs.mkdirSync(path.join(src, "util"), { recursive: true });
fs.writeFileSync(
  path.join(src, "app.js"),
  [
    '"use strict";',
    'const { helper } = require("./util/helper.js");',
    "",
    "// TODO: вынести настройки в отдельный файл",
    "function greet(name) {",
    '  return "привет, " + name;',
    "}",
    "",
    "function startApp() {",
    "  const text = greet(\"мир\");",
    "  const more = helper(text);",
    "  return more;",
    "}",
    "",
    "module.exports = { greet, startApp };",
    "",
  ].join("\n")
);
fs.writeFileSync(
  path.join(src, "util", "helper.js"),
  [
    '"use strict";',
    "// helper дописывает восклицательный знак",
    "function helper(text) {",
    '  return text + "!";',
    "}",
    "",
    "module.exports = { helper };",
    "",
  ].join("\n")
);
// Большой файл: ветка readFile «не читай целиком» включается на 800+ строк.
fs.writeFileSync(
  path.join(src, "big.js"),
  Array.from({ length: 900 }, (_, i) => (i === 0 ? 'function big() {' : "  // строка " + (i + 1))).join("\n") + "\n  return 1;\n}\n"
);
fs.writeFileSync(path.join(work, "README.md"), "# проект прогона\n\nОписание.\n");

function writeSettings(over) {
  const s = Object.assign({ workingDir: work, model: "test-model", provider: "openai" }, over || {});
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Поддельный electron: окно в прогоне не нужно ───────────────────────────
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: { id, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

const seenWiring = { files: 0, filesDeps: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.194", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (/agent-tools-files\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createFileTools: (deps) => {
        seenWiring.files++;
        seenWiring.filesDeps = deps;
        return real.createFileTools(deps);
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seenWiring.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seenWiring.tools = tools;
        return tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seenWiring.api = real.createToolRegistry(deps);
        return seenWiring.api;
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

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон файловых инструментов агента (настоящий main.js, настоящие файлы)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);
  const rel = (p) => path.relative(work, p);

  console.log("\n[1] проводка: модуль собран один раз и с тем же состоянием");
  ok(seenWiring.files === 1, "createFileTools вызван " + seenWiring.files + " раз(а)");
  ok(seenWiring.filesDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
  const names = ["readFile", "readFileLines", "fileOutline", "listFiles", "listDirectory", "searchProject",
    "searchFile", "readFileStructure", "explainCode", "findReferences"];
  const missing = names.filter((n) => typeof seenWiring.tools[n] !== "function");
  ok(missing.length === 0, "все десять инструментов отвечают через реестр" + (missing.length ? ": нет " + missing.join(", ") : ""));

  console.log("\n[2] readFile: маленький, отсутствующий, большой");
  // Число строк берём с диска, а не зашиваем: проверка должна ловить расхождение
  // «инструмент сказал N» и «в файле на самом деле N», а не совпадение с литералом.
  const appLines = fs.readFileSync(path.join(src, "app.js"), "utf8").split("\n").length;
  const bigLines = fs.readFileSync(path.join(src, "big.js"), "utf8").split("\n").length;
  const small = plain(await call("readFile", { path: "src/app.js" }));
  const smallComplete = /function greet/.test(small) && /module\.exports = \{ greet, startApp \};/.test(small);
  ok(smallComplete && new RegExp("\\(" + appLines + " строк\\)").test(small),
    "маленький файл прочитан целиком и назван числом строк файла (" + appLines + "): " + small.split("\n")[0]);
  const noFile = plain(await call("readFile", { path: "src/нет-такого.js" }));
  ok(/файл не найден/.test(noFile), "отсутствующий файл объяснён: " + noFile.slice(0, 60));
  const big = plain(await call("readFile", { path: "src/big.js" }));
  ok(new RegExp("Файл большой: " + bigLines + " строк").test(big) && bigLines > 800,
    "большой файл назван числами и числом строк файла (" + bigLines + "): " + big.split("\n")[0]);
  ok(/─ СТРУКТУРА/.test(big) && /─ НАЧАЛО ФАЙЛА:/.test(big) && /─ КОНЕЦ ФАЙЛА:/.test(big), "обзор содержит структуру, начало и конец");
  ok(!/строка 450/.test(big), "середина большого файла НЕ выгружена (экономия токенов)");

  console.log("\n[3] readFile: справочник агента из самого приложения");
  const guide = plain(await call("readFile", { path: "agent-guide:github" }));
  ok(/СПРАВОЧНИК АГЕНТА: «github»/.test(guide) && guide.length > 500, "настоящий справочник прочитан (" + guide.length + " символов)");
  const noGuide = plain(await call("readFile", { path: "agent-guide:нетТакого" }));
  ok(/не найден\. Есть: /.test(noGuide), "отсутствующий справочник назван вместе со списком: " + noGuide.slice(0, 90));

  console.log("\n[4] readFileLines: диапазон и выход за конец");
  const chunk = plain(await call("readFileLines", { path: "src/app.js", start: 5, count: 3 }));
  ok(new RegExp("Строки 5–7 из " + appLines + "").test(chunk), "диапазон назван по числу строк файла: " + chunk.split("\n")[0]);
  ok(/5 \| function greet/.test(chunk) && /7 \| \}/.test(chunk), "строки пронумерованы и совпадают с файлом");
  const beyond = plain(await call("readFileLines", { path: "src/app.js", start: 999, count: 5 }));
  ok(/Файл закончился раньше строки 999/.test(beyond), "выход за конец файла объяснён, а не пустой ответ");

  console.log("\n[5] fileOutline: структура и фильтр");
  const outline = plain(await call("fileOutline", { path: "src/app.js" }));
  ok(/2 определений/.test(outline) && /greet/.test(outline) && /startApp/.test(outline), "обе функции найдены: " + outline.split("\n")[0]);
  const filtered = plain(await call("fileOutline", { path: "src/app.js", pattern: "start" }));
  ok(/1 определений/.test(filtered) && !/greet\(/.test(filtered.split("\n").slice(1).join("\n")), "фильтр сузил структуру: " + filtered.split("\n")[0]);
  const emptyOutline = plain(await call("fileOutline", { path: "src/app.js", pattern: "яяя" }));
  ok(/нет определений, совпадающих/.test(emptyOutline), "пустой фильтр объяснён");

  console.log("\n[6] searchFile: регулярка, контекст, блоки, мусорный шаблон");
  const found = plain(await call("searchFile", { path: "src/app.js", pattern: "greet", context: 1 }));
  ok(/всего 3/.test(found) && /контекст ±1/.test(found), "совпадения с контекстом: " + found.split("\n")[0]);
  const blocks = plain(await call("searchFile", { path: "src/app.js", pattern: "helper", blocks: true }));
  ok(/показано блоков: /.test(blocks) && /──/.test(blocks), "режим блоками показал enclosing-определение: " + blocks.split("\n")[0]);
  const none = plain(await call("searchFile", { path: "src/app.js", pattern: "яяя" }));
  ok(/Совпадений по «яяя» .* нет/.test(none), "отсутствие совпадений названо прямо");
  const broken = plain(await call("searchFile", { path: "src/app.js", pattern: "funсtion(" }));
  ok(typeof broken === "string" && !/throw|undefined/.test(broken), "мусорный шаблон не сломал инструмент: " + broken.split("\n")[0]);
  const noPattern = plain(await call("searchFile", { path: "src/app.js" }));
  ok(/укажи pattern/.test(noPattern), "поиск без шаблона объяснён");

  console.log("\n[7] listDirectory / listFiles / searchProject / readFileStructure");
  const dir = plain(await call("listDirectory", { path: "src" }));
  ok(/\[папка\] util/.test(dir) && /\[файл\]  app\.js/.test(dir), "папки и файлы помечены: " + dir.split("\n")[0]);
  const files = plain(await call("listFiles", {}));
  ok(/app\.js/.test(files) && /big\.js/.test(files), "список файлов проекта содержит исходники");
  const project = plain(await call("searchProject", { pattern: "helper" }));
  ok(/helper/.test(project), "поиск по проекту нашёл файл: " + project.split("\n")[0].slice(0, 80));
  const structure = plain(await call("readFileStructure", { path: "src/app.js" }));
  ok(new RegExp("\\(" + appLines + " строк, показано").test(structure) && /require|function/.test(structure),
    "структура файла с видами строк: " + structure.split("\n")[0]);

  console.log("\n[8] explainCode: символ, строка, маркеры");
  const bySymbol = plain(await call("explainCode", { path: "src/app.js", symbol: "startApp" }));
  ok(/символ «startApp» → блок «startApp»/.test(bySymbol), "блок по имени найден: " + bySymbol.split("\n")[0]);
  const byLine = plain(await call("explainCode", { path: "src/app.js", line: 11 }));
  ok(/Запрос: строка 11 → внутри блока «startApp»/.test(byLine), "по строке показан enclosing-блок: " + (byLine.split("\n")[1] || ""));
  // Маркер TODO стоит на строке 4 — вне определений, поэтому окно запрашиваем по ней
  // (проверка «ждала маркер в окне ЧУЖОЙ строки» ничего не измеряла).
  const aroundTodo = plain(await call("explainCode", { path: "src/app.js", line: 4 }));
  ok(/Маркеры TODO\/FIXME в окне/.test(aroundTodo) && /вынести настройки/.test(aroundTodo),
    "маркер TODO в своём окне назван: " + (aroundTodo.split("\n").find((l) => /Маркеры/.test(l)) || "нет строки маркеров"));
  const noSymbol = plain(await call("explainCode", { path: "src/app.js", symbol: "нетТакойФункции" }));
  ok(/Не нашёл определение по имени/.test(noSymbol), "неизвестный символ объяснён со структурой файла");

  console.log("\n[9] findReferences: по настоящему проекту");
  const refs = plain(await call("findReferences", { symbol: "helper", path: "src" }));
  ok(/Символ «helper» — \d+ вхожд/.test(refs), "ссылки найдены: " + refs.split("\n")[0]);
  ok(/helper\.js/.test(refs) && /определение/.test(refs), "определение названо файлом и видом строки");
  ok(/вызов/.test(refs), "вызовы отличимы от определения");
  const noRefs = plain(await call("findReferences", { symbol: "noSuchSymbol12345", path: "src" }));
  ok(/Использований «noSuchSymbol12345» не найдено/.test(noRefs), "отсутствие использований названо прямо: " + noRefs.slice(0, 70));
  // Отдельная честная ветка: имя не идентификатор (кириллица) — инструмент обязан
  // объяснить это, а не молча искать. Проверка на настоящем вызове, а не по тексту.
  const badSymbol = plain(await call("findReferences", { symbol: "нетТакогоСимвола", path: "src" }));
  ok(/должен быть валидным идентификатором/.test(badSymbol), "негодное имя объяснено, а не проглочено: " + badSymbol.slice(0, 70));
  const noSymbolRefs = plain(await call("findReferences", {}));
  ok(/укажи symbol/.test(noSymbolRefs), "поиск ссылок без символа объяснён");

  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки файловых инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

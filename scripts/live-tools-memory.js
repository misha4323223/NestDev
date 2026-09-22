"use strict";
/* ─── Живой прогон пояса проекта (без окна) ───────────────────────────────────
   Запуск: npm run test:live:tools-memory   (node scripts/live-tools-memory.js)

   Зачем этот прогон. Пятнадцать обработчиков (note*, task*, memory*, checkpoint*,
   semanticSearch) уехали своим модулем (часть 40, заход 6b). Это инструменты про
   ПАМЯТЬ РАБОТЫ: заметки проекта, дела со сроками, памятки диалогов, точки отката
   и поиск по смыслу. Текстовый сторож здесь не значит ничего: важно, что файлы
   ЛОЖАТСЯ НА ДИСК, читаются обратно и откат действительно возвращает содержимое.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-memory.js;
     • настоящее хранилище (src/agent-store.js), настоящий индекс (src/code-index.js)
       и настоящие файлы на диске.

   Ничего наружу не уходит: всё в своей временной папке. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-memory-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-memory-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 1).join(" | ").slice(0, 120);
const info = (msg) => console.log("  · " + msg);

// Проект: один настоящий исходник, который найдёт поиск по смыслу и вернёт откат.
const SOURCE = "function validateLogin(user, password) {\n  return !!user && !!password;\n}\n";
const target = path.join(work, "сервер.js");
fs.writeFileSync(target, SOURCE, "utf8");

function writeSettings(over, quiet) {
  const s = Object.assign({ workingDir: work, model: "test-model", provider: "openai", contextMemory: false }, over || {});
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
  if (!quiet) info("настройки: " + JSON.stringify(s));
}
writeSettings({}, true);

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

const seen = { mem: 0, memDeps: null, memArgs: 0, memTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.199", setName: () => {}, setAppUserModelId: () => {},
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
  // Перехват только по имени файла: подстрока «agent-tools» заглатывала бы соседей
  // по дому (эта ошибка уже стоила двух молчавших прогонов — см. заход 4.1).
  if (/agent-tools-memory\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createMemoryTools: function (deps) {
        seen.mem++;
        seen.memDeps = deps;
        seen.memArgs = arguments.length;
        seen.memTools = real.createMemoryTools(deps);
        return seen.memTools;
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
  console.error("❌ Живой прогон не завершился за 180 секунд");
  process.exit(1);
}, 180000);
watchdog.unref();

const NAMES = ["noteSave", "noteRead", "noteList", "noteDelete",
  "taskAdd", "taskList", "taskUpdate", "taskDone", "taskDelete",
  "memoryList", "memorySearch",
  "checkpointSave", "checkpointList", "checkpointRollback",
  "semanticSearch"];
const memoryDir = () => path.join(userData, "project-memory");

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон пояса проекта (настоящий main.js, настоящие файлы в " + path.basename(work) + ")");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);

  try {
    console.log("\n[1] проводка: модуль собран один раз с тем же состоянием");
    ok(seen.mem === 1, "createMemoryTools вызван " + seen.mem + " раз(а)");
    ok(seen.memDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
    ok(seen.memArgs === 1, "модулю передан только deps (живого моста не нужно): аргументов " + seen.memArgs);
    const missing = NAMES.filter((n) => typeof (seen.memTools || {})[n] !== "function");
    ok(missing.length === 0, "все пятнадцать инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const refs = NAMES.filter((n) => seen.tools[n] !== seen.memTools[n]);
    ok(refs.length === 0, "в реестре именно ссылки на модуль, а не копии" + (refs.length ? ": расходятся " + refs.join(", ") : ""));

    console.log("\n[2] заметки проекта: файлы на диске, ВНЕ проекта");
    const saved = plain(await call("noteSave", { key: "Клиенты ВК", content: "Адрес: app.local, вход по токену" }));
    ok(/^OK — /.test(saved), "заметка сохранена: " + oneLine(saved));
    ok(saved.indexOf("klienty-vk") >= 0, "кириллический ключ переведён в латиницу: " + oneLine(saved));
    ok(fs.existsSync(memoryDir()) && fs.readdirSync(memoryDir()).length > 0, "память проекта лежит в userData/project-memory");
    ok(!fs.readdirSync(work).some((f) => f.indexOf("project-memory") >= 0), "в проект память не попала (git её не увидит)");
    const read = plain(await call("noteRead", { key: "klienty-vk" }));
    ok(read.indexOf("app.local") >= 0 && read.indexOf("Заметка «klienty-vk»") >= 0, "заметка прочитана по переведённому ключу");
    const list = plain(await call("noteList", {}));
    ok(/Заметки проекта \(1\)/.test(list) && list.indexOf("klienty-vk") >= 0, "список заметок называет ключ: " + oneLine(list));
    ok(/не найдена/.test(plain(await call("noteRead", { key: "нет-такой" }))), "отсутствующая заметка честно не найдена");
    ok(/кую ключ|латиницу|key/.test(plain(await call("noteDelete", {}))), "удаление без key объяснено");
    ok(/удалена/.test(plain(await call("noteDelete", { key: "klienty-vk" }))), "заметка удалена");
    ok(/пока нет/.test(plain(await call("noteList", {}))), "после удаления список честно пуст");

    console.log("\n[3] дела: срок, повтор и автозапуск доходят до хранилища");
    const added = plain(await call("taskAdd", { title: "Полить цветы", due: "завтра 10:00", priority: "high", repeat: "каждый день", auto: true, prompt: "полей цветы" }));
    ok(/^OK — /.test(added), "дело создано: " + oneLine(added));
    ok(fs.existsSync(path.join(userData, "tasks.json")), " дела легли файлом в userData");
    const tasks = plain(await call("taskList", {}));
    ok(tasks.indexOf("Полить цветы") >= 0, "дело видно в списке");
    ok(tasks.indexOf("🔁 каждый день") >= 0, "повтор доехал до хранилища: " + oneLine(tasks, 3));
    ok(tasks.indexOf("▶ выполняет агент") >= 0, "автозапуск доехал до хранилища");
    ok(/выполнено/.test(plain(await call("taskDone", { key: "Полить" }))), "дело отмечено выполненным");
    const afterDone = plain(await call("taskList", { status: "all" }));
    ok(/выполнено/.test(afterDone), "состояние «выполнено» видно списку: " + oneLine(afterDone, 2));
    ok(/удалено/.test(plain(await call("taskDelete", { key: "Полить" }))), "дело удалено");
    ok(/не найдено/.test(plain(await call("taskUpdate", { key: "Полить", title: "иное" }))), "правка удалённого дела не выдумывает успех");

    console.log("\n[4] память диалогов: галочка, дни и поиск");
    const off = plain(await call("memoryList", {}));
    ok(/выключена/.test(off), "выключенная память честно об этом говорит: " + oneLine(off));
    ok(/выключена/.test(plain(await call("memorySearch", { query: "что угодно" }))), "поиск по выключенной памяти тоже объяснён");
    const s2 = Object.assign({}, d.loadSettings(), { contextMemory: true });
    d.saveSettings(s2);
    const store = d.agentStore;
    const memo = store.contextMemorySave(userData, { memo: "Разбирали валидацию входа и повтор задач", provider: "openai", model: "test-model", workDir: work });
    ok(memo && memo.ok, "памятка диалога записана настоящим хранилищем" + (memo && memo.ok ? "" : ": " + oneLine(memo && memo.error)));
    const days = plain(await call("memoryList", {}));
    ok(/Дни в памяти диалогов/.test(days), "дни названы: " + oneLine(days, 2));
    const found = plain(await call("memorySearch", { query: "валидацию" }));
    ok(/Найдено в памяти диалогов/.test(found), "поиск нашёл памятку: " + oneLine(found, 2));
    ok(found.indexOf(work) >= 0 || /совпадений/.test(found), "в находке названы место и совпадения");
    ok(/ничего не найдено/.test(plain(await call("memorySearch", { query: "заведомо-нет-такого" }))), "пустой поиск объяснён, а не выдуман");
    ok(/укажи query/.test(plain(await call("memorySearch", {}))), "поиск без query отвергнут");

    console.log("\n[5] чекпоинты: снимок — правка — ОТКАТ на диске");
    const shot = plain(await call("checkpointSave", { label: "перед правками" }));
    ok(/^OK — /.test(shot), "чекпоинт создан: " + oneLine(shot));
    const id = (/checkpointRollback\(id: ([a-z0-9-]+)\)/.exec(shot) || [])[1];
    ok(!!id, "в ответе назван id для отката");
    fs.writeFileSync(target, "испорчено правкой\n", "utf8");
    const rolled = plain(await call("checkpointRollback", { id }));
    ok(/^OK — /.test(rolled), "откат прошёл: " + oneLine(rolled));
    ok(fs.readFileSync(target, "utf8") === SOURCE, "файл на диске вернулся к прежнему содержимому");
    const cps = plain(await call("checkpointList", {}));
    ok(cps.indexOf("перед правками") >= 0, "чекпоинт виден в списке: " + oneLine(cps, 2));
    // Идентификатор — латиницей: кириллический отвергается раньше, проверкой формата,
    // и тогда проверялось бы не то («не найден» требует годного id).
    ok(/не найден/.test(plain(await call("checkpointRollback", { id: "zzzz-nope-000" }))), "несуществующий чекпоинт отвергнут");
    ok(/Недопустимый идентификатор/.test(plain(await call("checkpointRollback", { id: "нет-такого" }))), "негодный идентификатор отвергнут раньше поиска"),
    ok(/укажи id/.test(plain(await call("checkpointRollback", {}))), "откат без id объяснён");
    // Пустая папка — честный отказ, а не пустой снимок.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-memory-empty-"));
    ok(/нет файлов/.test(plain(await seen.memTools.checkpointSave({ label: "пустая" }, { workingDir: emptyDir }))), "пустая папка не даёт пустого чекпоинта");
    fs.rmSync(emptyDir, { recursive: true, force: true });

    console.log("\n[6] поиск по смыслу: настоящий индекс по настоящей папке");
    // Запрос — по имени из кода: индекс ищет по словам и основам (auth → authenticate),
    // а не по переводу. Русская формулировка «валидация входа» честно не находит
    // английское имя — это не сбой, а граница поиска (проверяем и её тоже).
    const hits = plain(await call("semanticSearch", { query: "validateLogin" }));
    ok(/Семантический поиск/.test(hits), "ответ с находками получен: " + oneLine(hits, 2));
    ok(hits.indexOf("сервер.js") >= 0, "нашёлся настоящий файл проекта: " + oneLine(hits, 2));
    ok(hits.indexOf("validateLogin") >= 0, "в ответе виден сам код из файла: " + oneLine(hits.split("\n").slice(1), 1));
    const noHits = plain(await call("semanticSearch", { query: "валидация входа" }));
    ok(/ничего не найдено/.test(noHits), "поиск без совпадений объяснён, а не выдуман: " + oneLine(noHits, 1));
    ok(/укажи query/.test(plain(await call("semanticSearch", {}))), "пустой запрос отвергнут до поиска");
    ok(/директория не найдена/.test(plain(await call("semanticSearch", { query: "x", path: path.join(work, "нет-такой") }))), "несуществующая папка объяснена");

    console.log("\n[7] гигиена прогона");
    ok(fs.existsSync(target), "подопытный файл на месте (откат его не удалил)");
    // В рабочей папке приложение держит СВОЮ служебную папку .agent (журналы и
    // памятки) — это не мусор прогона. Мусором были бы файлы памяти проекта или дел.
    const leftovers = fs.readdirSync(work).filter((f) => f !== "сервер.js" && f !== ".agent");
    ok(leftovers.length === 0, "в проекте не осталось чужого мусора: " + (leftovers.join(", ") || "чисто"));
    const agentDir = path.join(work, ".agent");
    const agentFiles = fs.existsSync(agentDir) ? fs.readdirSync(agentDir, { recursive: true }).join(", ") : "";
    ok(info("служебная папка .agent: " + (agentFiles || "пусто")) || true, "служебное названо");
    ok(!agentFiles.includes("project-memory") && !agentFiles.includes("tasks.json"), "память и дела в проект НЕ легли");
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки пояса проекта пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})();

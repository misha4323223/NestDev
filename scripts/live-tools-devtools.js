"use strict";
/* ─── Живой прогон вложений и разработки ──────────────────────────────────────
   Запуск: npm run test:live:tools-devtools   (node scripts/live-tools-devtools.js)

   Зачем этот прогон. Тринадцать обработчиков (докер, установка пакетов, проверки
   проекта, зависимости, prettier, разбор кода выхода и запрос в БД) уехали своим
   модулем (часть 40, заход 9). Они ЗАПУСКАЮТ КОМАНДЫ на машине и решают по
   файлам проекта, поэтому текстовый сторож здесь не значит ничего: проверять
   надо на живой сборке и на настоящей папке проекта.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящие src/agent-tools.js и src/agent-tools-devtools.js;
     • настоящая папка проекта во временном каталоге: настоящий package.json,
       настоящие node_modules и настоящий `npm test`, который прогон и запускает.

   Чего прогон НЕ делает НИКОГДА: не ставит системное ПО, не запускает контейнеры
   и не стучится в чужие базы. Докер проверяется только командами и отказами,
   установка пакета — локальным пакетом из своей же папки (без сети), а запрос в
   БД — заведомо отсутствующим клиентом psql/mysql. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-dev-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-dev-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const info = (msg) => console.log("  · " + msg);

/* Проект, на котором работают инструменты: настоящий package.json с настоящим
   test-скриптом и одним уже установленным пакетом в node_modules. Пакет-сосед
   (mini-pkg) лежит рядом: его ставим локально, чтобы проверка не ходила в сеть. */
const mini = path.join(work, "mini-pkg");
fs.mkdirSync(mini, { recursive: true });
fs.writeFileSync(path.join(mini, "package.json"), JSON.stringify({ name: "mini-pkg", version: "1.0.0" }), "utf8");
fs.writeFileSync(path.join(mini, "index.js"), "module.exports = 1;\n", "utf8");
fs.mkdirSync(path.join(work, "node_modules", "lodash"), { recursive: true });
fs.writeFileSync(path.join(work, "node_modules", "lodash", "package.json"), JSON.stringify({ name: "lodash", version: "4.17.21" }), "utf8");
// Скрипт тестов печатает то же, что настоящий раннер: сводка должна собраться.
fs.writeFileSync(
  path.join(work, "t.js"),
  'console.log("проверка проекта: тесты прошли");\nconsole.log("Tests: 2 passed, 2 total");\n',
  "utf8"
);
fs.writeFileSync(
  path.join(work, "package.json"),
  JSON.stringify(
    {
      name: "mini-project",
      version: "0.0.1",
      private: true,
      scripts: { test: "node t.js" },
      dependencies: { lodash: "^4.17.21", "mini-pkg": "file:./mini-pkg" },
      devDependencies: { prettier: "^3.0.0" },
    },
    null,
    2
  ),
  "utf8"
);
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2));
info("рабочая папка проекта: " + work);

// ── Поддельный electron: окно в этом прогоне не нужно ──────────────────────
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

// ── Перехват: видим, кто кого собрал и с чем ───────────────────────────────
const seen = { dev: 0, devDeps: null, devArgs: 0, devTools: null, toolDeps: null, api: null, tools: null };
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
  // Точный перехват по имени файла: подстрока «agent-tools» заглатывала бы соседей
  // по дому (та ошибка уже стоила молчавших прогонов — см. заход 4.1).
  if (/agent-tools-devtools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createDevTools: function (deps) {
        seen.dev++;
        seen.devDeps = deps;
        seen.devArgs = arguments.length;
        seen.devTools = real.createDevTools(deps);
        return seen.devTools;
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

const NAMES = ["dockerBuild", "dockerRun", "dockerExec", "installPackage", "lintProject", "runTests",
  "checkInstalledProgram", "canExecute", "explainError", "validateProject", "getDependencies", "formatCode", "dbQuery"];

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон инструментов разработки (настоящий main.js, настоящий проект)");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = async (name, args) => {
    try { return plain(await executeTool(name, args || {}, settings)); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };
  const lines = (t, n) => plain(t).split("\n").slice(0, n || 3).join(" | ").slice(0, 160);

  try {
    console.log("\n[1] проводка: модуль собран один раз, без живого моста, ссылками");
    ok(seen.dev === 1, "createDevTools вызван " + seen.dev + " раз(а)");
    ok(seen.devDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.devArgs === 1, "живой мост этому набору не нужен (аргументов: " + seen.devArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.devTools || {})[n] !== "function");
    ok(missing.length === 0, "все тринадцать обработчиков на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.devTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"dockerBuild": async') < 0 && shellSrc.indexOf('"runTests": async') < 0 && shellSrc.indexOf('"dbQuery": async') < 0,
      "тела обработчиков не остались в файле-оболочке");
    ok(/const devtools = createDevTools\(deps\);/.test(shellSrc), "сборка модуля на месте и без лишних аргументов");

    console.log("\n[2] докер: команды собираются по аргументам, отказы честные");
    ok(/укажи image/.test(await call("dockerRun", {})), "dockerRun без образа объясняет, что нужно");
    ok(/укажи container и command/.test(await call("dockerExec", { container: "c" })), "dockerExec без команды объясняет, что нужно");
    const noDir = await call("dockerBuild", { directory: path.join(work, "нет-такой-папки") });
    ok(/папка не найдена/.test(noDir), "dockerBuild в несуществующей папке назван честно: " + lines(noDir, 1));
    const built = await call("dockerBuild", { tag: "мини-образ" });
    ok(/мини-образ|docker|Команда завершилась/i.test(built), "dockerBuild отчитался по делу: " + lines(built, 1));
    ok(!/is not defined|не найдена функция/.test(built), "dockerBuild не упал на отсутствующей зависимости");

    console.log("\n[3] installPackage: пакет ставится менеджером проекта, а не наугад");
    const noName = await call("installPackage", {});
    ok(/укажи packageName/.test(noName), "без имени пакета — понятный отказ: " + lines(noName, 1));
    const put = await call("installPackage", { packageName: "file:./mini-pkg" });
    ok(/менеджер пакетов: /.test(put), "сказано, каким менеджером и в каком каталоге ставится: " + lines(put, 2));
    const installedNow = fs.existsSync(path.join(work, "node_modules", "mini-pkg", "package.json"));
    ok(installedNow || /команда завершилась|не найден|ошибка/i.test(put), "пакет либо поставлен по-настоящему, либо отказ назван: " + (installedNow ? "поставлен" : lines(put, 1)));

    console.log("\n[4] runTests: настоящий npm test из package.json проекта");
    const tests = await call("runTests", {});
    ok(/npm test \(каталог: /.test(tests), "тесты запущены скриптом проекта, а не наугад: " + lines(tests, 1));
    ok(/тесты прошли/.test(tests), "вывод настоящего прогона тестов доехал до агента");
    ok(/--- Итог ---/.test(tests) && /✅ прошло: 2/.test(tests), "итог прогона сведён по-настоящему: " + lines(tests.split("--- Итог ---")[1] || "", 1));

    console.log("\n[5] проверки проекта: когда проверять нечего — сказано, а не выдумано");
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "live-dev-empty-"));
    const s2 = Object.assign({}, settings, { workingDir: empty });
    const at = async (name, args) => {
      try { return plain(await executeTool(name, args || {}, s2)); }
      catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
    };
    const lint = await at("lintProject", {});
    ok(/Не нашёл конфигов проверки/.test(lint), "lintProject в пустой папке назван честно: " + lines(lint, 1));
    const valid = await at("validateProject", {});
    ok(/Не нашёл, что проверять/.test(valid), "validateProject в пустой папке назван честно: " + lines(valid, 1));
    const noDeps = await at("getDependencies", {});
    ok(/package.json не найден/.test(noDeps), "getDependencies без package.json назван честно: " + lines(noDeps, 1));
    const badFmt = await at("formatCode", { path: path.join(empty, "нет-файла.txt") });
    ok(/укажи существующий path/.test(badFmt), "formatCode по несуществующему пути назван честно: " + lines(badFmt, 1));

    console.log("\n[6] зависимости и prettier — по настоящей папке проекта");
    const deps = await call("getDependencies", {});
    ok(/lodash@\^4\.17\.21 → установлено 4\.17\.21/.test(deps), "установленная зависимость названа по node_modules: " + lines(deps, 2));
    ok(/prettier@\^3\.0\.0 → (НЕ установлено|установлено)/.test(deps), "devDependencies перечислены: " + (deps.match(/prettier@[^\n]*/) || [""])[0].slice(0, 90));
    const fmt = await call("formatCode", { path: path.join(work, "t.js"), check: true });
    ok(/prettier|Prettier/.test(fmt), "formatCode отвечает по делу (prettier проверен по node_modules): " + lines(fmt, 1));

    console.log("\n[7] программы: git есть, выдуманной нет; встроенная команда оболочки");
    const git = await call("checkInstalledProgram", { programName: "git" });
    ok(/Установлено: да/.test(git) && /Путь: /.test(git), "git найден по-настоящему: " + lines(git, 2));
    ok(/Версия: /.test(git), "версия git спрошена у программы: " + (git.match(/Версия: [^\n]*/) || [""])[0].slice(0, 80));
    const ghost = await call("checkInstalledProgram", { programName: "такой-программы-нет-xyz" });
    ok(/Установлено: нет/.test(ghost) && /installSystemPackage\("такой-программы-нет-xyz"\)/.test(ghost), "несуществующая программа названа честно: " + lines(ghost, 2));
    const canGit = await call("canExecute", { command: "git status" });
    ok(/Можно выполнить: да/.test(canGit) && /Путь: /.test(canGit), "canExecute нашёл git в PATH: " + lines(canGit, 2));
    const builtin = await call("canExecute", { programName: "cd" });
    ok(/встроенная команда оболочки/.test(builtin), "встроенная команда оболочки не ищется в PATH: " + lines(builtin, 1));
    const explain = await call("explainError", { exitCode: 127, command: "git пуш" });
    ok(explain.trim().length > 10 && /127/.test(explain), "разбор кода выхода доехал до помощника: " + lines(explain, 1));

    console.log("\n[8] dbQuery: чужие базы не трогаем, отказы и клиент названы");
    const bad = await call("dbQuery", { connectionString: "sqlite://файл", sql: "select 1" });
    ok(/поддерживаются строки подключения postgres:\/\/\.\.\. и mysql:\/\/\.\.\./.test(bad), "неподдерживаемая строка подключения отклонена: " + lines(bad, 1));
    const noSql = await call("dbQuery", { connectionString: "postgres://u@хост/бд" });
    ok(/укажи connectionString и sql/.test(noSql), "без sql — понятный отказ: " + lines(noSql, 1));
    const pg = await call("dbQuery", { connectionString: "postgres://u@127.0.0.1:1/бд", sql: "select 1" });
    ok(/Клиент psql не найден|Ошибка psql|psql OK/.test(pg), "postgres-ветка дошла до настоящего клиента: " + lines(pg, 1));
    const my = await call("dbQuery", { connectionString: "mysql://u@127.0.0.1:1/бд", sql: "select 1" });
    ok(/mysql|Клиент mysql не найден|Ошибка mysql/.test(my), "mysql-ветка дошла до настоящего клиента: " + lines(my, 1));
  } catch (e) {
    fail++;
    console.error("❌ Прогон упал: " + ((e && e.stack) || e));
  }

  console.log("\nЖивой прогон инструментов разработки: " + pass + " ✅ / " + fail + " ❌");
  clearTimeout(watchdog);
  process.exit(fail ? 1 : 0);
})();

"use strict";
/* ─── Живой прогон окружения агента и выдачи переменных (без окна) ────────────
   Запуск: bun run test:live:env     (node scripts/live-agent-env.js)

   Зачем. Проверки «дамп окружения не показывает секрет агента» и «явный запрос
   переменной работает как раньше» жили только в десктопном прогоне — тому нужно
   настоящее окно Electron. Здесь тот же путь проверяется на НАСТОЯЩЕМ main.js:
   он грузится в Node с поддельным electron (окна в песочнице нет), настройки и
   инструменты — живые, команды — настоящие процессы в настоящей оболочке.

   Что проверяется по-настоящему:
     • переменная агента доходит до команды, когда её спрашивают явно;
     • голый дамп окружения (printenv / set) секрета НЕ показывает;
     • переменная, выданная только git, до терминала не доходит;
     • envSet от самого агента тоже подставляет значение в команды;
     • envList показывает имена, но не значения;
     • в журнале действий нет значения секрета.

   Платформа учитывается: на Windows команды агента идут в cmd, где printenv нет —
   поэтому дамп спрашивается через `set`, а явный запрос через `set ИМЯ`. На POSIX
   самого printenv в образе может не быть (в busybox его нет): тогда дамп
   спрашивается встроенной командой `set` (её знает любая оболочка), а явный запрос —
   раскрытием переменной оболочкой. Проверяем ровно то же («переменная дошла до
   команды»), а не наличие конкретной программы в образе. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const WIN = process.platform === "win32";
// Имена команд подставляются ниже по факту: если в образе нет printenv (в busybox
// его нет), берём то, что есть в любой оболочке — встроенный `set` для дампа и
// раскрытие переменной для явного запроса.
let dumpCmd = WIN ? "set" : "printenv";
let explicitCmd = (name) => (WIN ? "set " + name : "printenv " + name);
// Команда не нашла саму программу (127 / «not found»): вывод при этом не пустой,
// а проверка «секрета не видно» прошла бы на ошибке вместо дампа.
const cmdFailed = (out) => /not found|not recognized|кодом 127/.test(String(out));

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-env-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-env-work-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

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
        getVersion: () => "1.5.152",
        setName: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false }, // секреты лягут открыто — это временная папка
      BrowserWindow: function () { return stub("BrowserWindow"); },
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
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
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});
require(path.join(ROOT, "src", "main.js"));

const SECRET = "live-secret-value-42";
const GIT_ONLY = "live-git-only-77";
const BY_AGENT = "live-by-agent-9";
// Тот же модуль журнала, что у main.js: запись делается так же, как её делал бы
// прогон агента, — с результатом команды внутри.
const audit = require(path.join(ROOT, "src", "audit-log.js"));
const logTool = (tool, args, result) => audit.record({ tool: tool, args: args, decision: "auto", result: result, source: "desktop" });

(async () => {
  console.log("Живой прогон окружения агента (main.js без окна)");
  await new Promise((r) => setTimeout(r, 300));

  const settingsSet = handlers.get("settings:set");
  const settingsGet = handlers.get("settings:get");
  const tools = captured.tools;
  if (!settingsSet || !tools || !tools.runCommand) {
    console.log("  ❌ main.js не собрал настройки и инструменты — прогон невозможен");
    process.exit(1);
  }

  console.log("\n[1] Переменная агента и голый дамп окружения");
  await settingsSet(null, {
    workingDir: work,
    agentEnv: { LIVE_LIVE_SECRET: SECRET, LIVE_GIT_ONLY: GIT_ONLY },
  });
  const settings = await settingsGet(null);
  ok(!!(settings && settings.agentEnv && settings.agentEnv.LIVE_LIVE_SECRET), "настройки приняли переменную агента");

  // Один вопрос оболочке: есть ли в образе printenv. Нет — переходим на встроенные
  // средства, иначе проверки проходили бы на ошибке команды, а не на дампе.
  if (!WIN) {
    const probe = String(await tools.runCommand({ command: "printenv __LIVE_PROBE__" }, settings));
    if (cmdFailed(probe)) {
      dumpCmd = "set";
      explicitCmd = (name) => 'printf %s "$' + name + '"';
      console.log("  · в образе нет printenv: дамп спрашиваем через set, значение — раскрытием оболочки");
    }
  }

  const dump = String(await tools.runCommand({ command: dumpCmd }, settings));
  ok(!dump.includes(SECRET) && !dump.includes(GIT_ONLY), "дамп окружения («" + dumpCmd + "») секретов не показывает (вывод: " + dump.length + " симв.)");
  // Проверка выше бессмысленна, если команда дампа не выполнилась вовсе: пустой
  // вывод и текст ошибки секретов тоже «не показывают».
  ok(dump.length > 0 && !cmdFailed(dump), "дамп вообще отработал (иначе проверка выше пустая): " + dump.slice(0, 80).replace(/\n/g, " "));

  logTool("runCommand", { command: dumpCmd }, dump);
  const explicit = String(await tools.runCommand({ command: explicitCmd("LIVE_LIVE_SECRET") }, settings));
  ok(explicit.includes(SECRET), "явный запрос переменной дошёл до команды" + (explicit.includes(SECRET) ? "" : ": " + explicit.slice(0, 200).replace(/\n/g, " ")));
  logTool("runCommand", { command: explicitCmd("LIVE_LIVE_SECRET") }, explicit);

  console.log("\n[2] Выдача переменной: только git");
  await settingsSet(null, { agentEnvScopes: { LIVE_GIT_ONLY: ["git"] } });
  const scoped = await settingsGet(null);
  ok(captured.deps.live.scopeSummary("LIVE_GIT_ONLY") === "git", "выдача запомнена: " + captured.deps.live.scopeSummary("LIVE_GIT_ONLY"));
  const scopedRun = String(await tools.runCommand({ command: explicitCmd("LIVE_GIT_ONLY") }, scoped));
  ok(!scopedRun.includes(GIT_ONLY), "переменная, выданная только git, до терминала не дошла");
  const free = String(await tools.runCommand({ command: explicitCmd("LIVE_LIVE_SECRET") }, scoped));
  ok(free.includes(SECRET), "без ограничения переменная по-прежнему доходит");

  console.log("\n[3] Агент сам задаёт и снимает переменную (envSet / envUnset)");
  const setOut = String(await tools.envSet({ key: "LIVE_BY_AGENT", value: BY_AGENT }, scoped));
  ok(!setOut.includes(BY_AGENT), "envSet не печатает значение в ответ: " + setOut.slice(0, 90));
  logTool("envSet", { key: "LIVE_BY_AGENT", value: BY_AGENT }, setOut);
  const runByAgent = String(await tools.runCommand({ command: explicitCmd("LIVE_BY_AGENT") }, await settingsGet(null)));
  ok(runByAgent.includes(BY_AGENT), "значение, заданное агентом, дошло до команды");
  logTool("runCommand", { command: explicitCmd("LIVE_BY_AGENT") }, runByAgent);
  const list = String(await tools.envList({}, await settingsGet(null)));
  ok(list.includes("LIVE_BY_AGENT") && !list.includes(BY_AGENT), "envList показывает имя, но не значение");
  await tools.envUnset({ key: "LIVE_BY_AGENT" }, await settingsGet(null));
  const afterUnset = String(await tools.runCommand({ command: explicitCmd("LIVE_BY_AGENT") }, await settingsGet(null)));
  ok(!afterUnset.includes(BY_AGENT), "снятая переменная больше не подставляется");

  console.log("\n[4] Журнал действий");
  // Записи сделаны выше — ровно в те моменты, когда их делал бы прогон агента
  // (сразу после выполнения инструмента, с его выводом внутри).
  const auditFile = path.join(userData, "audit.log");
  ok(audit.file() === auditFile, "журнал пишется в папку приложения: " + audit.file());
  const auditText = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "";
  ok(auditText.length > 0, "журнал создан и заполняется");
  ok(auditText.indexOf(SECRET) === -1, "в журнале нет значения секрета агента");
  ok(auditText.indexOf(BY_AGENT) === -1, "в журнале нет значения, заданного агентом");
  ok(auditText.indexOf("agentEnv") === -1, "в журнале нет объекта настроек с секретами");
  ok(/runCommand/.test(auditText) && /envSet/.test(auditText), "в журнале видно, какие инструменты работали");

  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})();

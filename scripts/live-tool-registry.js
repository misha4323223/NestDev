"use strict";
/* ─── Живой прогон реестра агентских инструментов и вызова инструмента ─────────
   Запуск: bun run test:live:tool-registry   (node scripts/live-tool-registry.js)

   Зачем отдельный прогон. Набор (test/tool-registry.test.js) водит модуль с
   поддельными соседями и разбирает проводку по ТЕКСТУ. Он не видит главного: что
   настоящий main.js построил список из ~120 имён так, что у каждого имени есть
   ЗНАЧЕНИЕ. Именно там нашлась настоящая дыра (этап B, часть 35): агентский
   инструмент gitPublish звал `publishLocalToGithub`, а в проводку это имя не
   попадало — «создай репозиторий и выложи проект» падало с «is not defined», и ни
   страж связи, ни наборы этого не замечали (имени нет ни в main.js, ни в
   распаковке — искать нечего).

   Здесь всё настоящее: main.js грузится в Node с поддельным electron, перехвачена
   сборка реестра и github-ipc (видно, ЧТО именно пришло), вызов идёт через
   настоящий executeTool в настоящие обработчики: файлы пишутся и читаются на
   диске, оболочка запускается по-настоящему, а выдача окружения зависит от
   назначения выбранного инструмента.

   Разделы:
     [1] main.js собрал реестр на своём месте и передал рабочие зависимости;
     [2] у КАЖДОГО имени из распаковки инструментов есть значение (обратный страж);
     [3] настоящие инструменты через executeTool: чтение, запись, незнакомый;
     [4] «Стоп» останавливает ДО вызова: файл не создаётся;
     [5] назначение: секрет выдаётся по назначению инструмента и возвращается после;
     [6] в оболочке этого больше нет, проводка стоит вовремя.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-registry-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-registry-work-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2)
);

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
  isDestroyed: () => false,
  isFocused: () => true,
  isMinimized: () => false,
  on: () => {},
  once: () => {},
  loadFile: () => Promise.resolve(),
  show: () => {},
  focus: () => {},
  restore: () => {},
  maximize: () => {},
  setTitle: () => {},
  close: () => {},
});

// Перехватываем сборку: видим, с чем НАСТОЯЩИЙ main.js позвал реестр и github-ipc.
const seen = { registry: 0, deps: null, github: null };
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
        getVersion: () => "1.5.190",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
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
  const t = String(req);
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seen.registry++;
        seen.deps = deps;
        // Сам вызов инструмента отдаётся НАРУЖУ (его берут прогон и строгая очередь) —
        // значит, и в живом прогоне его надо взять у реестра, а не из списка имён.
        seen.api = real.createToolRegistry(deps);
        return seen.api;
      },
      describeToolArgs: real.describeToolArgs,
    };
  }
  if (t.indexOf("github-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerGithubIpc: (deps) => {
        const api = real.registerGithubIpc(deps);
        seen.github = api;
        return api;
      },
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 150 секунд");
  process.exit(1);
}, 150000);
watchdog.unref();

// Имена, которые распаковывает реестр инструментов: тот же разбор, что в наборе.
function destructured(src) {
  const at = src.indexOf("} = deps;");
  const open = src.lastIndexOf("const {", at);
  const block = src.slice(open + "const {".length, at);
  return block
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n")
    .split(",")
    .map((s) => s.trim().split(":").pop().trim().replace(/=.*$/, "").trim())
    .filter((s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s));
}

(async () => {
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон реестра инструментов (настоящий main.js без окна)");
  await sleep(400);

  console.log("\n[1] main.js собрал реестр на своём месте и передал рабочие зависимости");
  ok(seen.registry === 1, "createToolRegistry вызван main.js " + seen.registry + " раз(а)");
  const d = seen.deps || {};
  ok(d.fs === fs, "модулю передан настоящий fs");
  ok(d.path === path && d.os === os, "пути и система пришли настоящими модулями");
  ok(typeof d.createAgentTools === "function", "сборщик обработчиков пришёл функцией");
  ok(typeof d.fmtError === "function", "обёртка ошибки пришла функцией");
  ok(typeof d.getCapability === "function" && typeof d.setCapability === "function", "назначение пришло чтением и записью");
  ok(d.loadSettings() && d.loadSettings().workingDir === work, "настройки читаются из рабочей папки: " + (d.loadSettings() && d.loadSettings().workingDir));
  ok(!!seen.github, "github-ipc собран (сверяем общие функции)");
  ok(d.publishLocalToGithub === seen.github.publishLocalToGithub, "публикация в GitHub — ТА ЖЕ функция, что у канала github:publish");
  ok(!!seen.api && typeof seen.api.executeTool === "function", "реестр отдал наружу вызов инструмента");
  ok(!!d.live && typeof d.live.lastAgentRepoDir === "function", "мост живых значений реестра собран");
  const executeTool = seen.api.executeTool;

  console.log("\n[2] у каждого имени из распаковки инструментов есть значение");
  // Распаковку спрашиваем у ВСЕХ модулей дома инструментов: обработчики разошлись
  // по своим файлам (часть 40: облачные — agent-tools-cloud.js, git и GitHub —
  // agent-tools-git.js, чтение и поиск — agent-tools-files.js, запись и правки —
  // agent-tools-write.js, команды и оболочка — agent-tools-run.js), и сторож
  // обязан видеть каждый — иначе пропущенное в main.js значение снова станет невидимым.
  const needed = [...new Set(
    ["agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js"]
      .flatMap((f) => destructured(fs.readFileSync(path.join(ROOT, "src", f), "utf8")))
  )];
  ok(needed.length > 100, "имён в распаковке: " + needed.length);
  const missing = needed.filter((n) => typeof d[n] === "undefined");
  ok(missing.length === 0, "имена без значения (инструмент ответит «is not defined»): " + (missing.join(", ") || "нет"));

  console.log("\n[3] настоящие инструменты через executeTool");
  const settings = d.loadSettings();
  const target = path.join(work, "проверка-реестра.txt");
  fs.writeFileSync(target, "прежнее содержимое", "utf8");
  const read = await executeTool("readFile", { path: target }, settings);
  ok(typeof read === "string" && read.indexOf("прежнее содержимое") >= 0, "readFile через реестр прочитал настоящий файл: " + JSON.stringify(String(read).slice(0, 80)));
  const made = path.join(work, "созданный-реестром.txt");
  const wrote = await executeTool("writeFile", { path: made, content: "записано реестром" }, settings);
  ok(/OK — файл создан/.test(String(wrote)), "writeFile через реестр ответил по-человечески: " + JSON.stringify(String(wrote).slice(0, 80)));
  ok(fs.existsSync(made) && fs.readFileSync(made, "utf8") === "записано реестром", "файл действительно создан на диске");
  const unknown = await executeTool("такого-инструмента-нет", {}, settings);
  ok(unknown === "Ошибка: неизвестный инструмент такого-инструмента-нет", "незнакомый инструмент объяснён, а не брошен исключением: " + unknown);
  const edited = await executeTool("editFile", { path: target, oldText: "прежнее содержимое", newText: "исправлено" }, settings);
  ok(/OK/.test(String(edited)) && fs.readFileSync(target, "utf8") === "исправлено", "editFile через реестр правит настоящий файл: " + JSON.stringify(String(edited).slice(0, 80)));

  console.log("\n[4] «Стоп» останавливает ДО вызова инструмента");
  const stoppedFile = path.join(work, "не-должен-появиться.txt");
  global.__agentStopRequested = true;
  const stopped = await executeTool("writeFile", { path: stoppedFile, content: "нет" }, settings);
  global.__agentStopRequested = false;
  ok(/Остановлено пользователем/.test(String(stopped)), "остановка объяснена модели: " + JSON.stringify(String(stopped).slice(0, 60)));
  ok(!fs.existsSync(stoppedFile), "после «Стоп» инструмент всё-таки выполнился — файл создан");
  const afterStop = await executeTool("writeFile", { path: stoppedFile, content: "да" }, settings);
  ok(/OK — файл создан/.test(String(afterStop)) && fs.existsSync(stoppedFile), "после снятия флага реестр работает снова: " + JSON.stringify(String(afterStop).slice(0, 60)));

  console.log("\n[5] назначение: секрет выдаётся по инструменту и возвращается после вызова");
  const before = d.getCapability();
  ok(before === "", "назначение оболочки до вызова пустое: " + JSON.stringify(before));
  const TERM_VALUE = "значение-для-терминала-35";
  const GIT_VALUE = "значение-только-для-git-35";
  const set1 = await executeTool("envSet", { key: "LIVE_TERM_TOKEN", value: TERM_VALUE, scopes: ["terminal"] }, settings);
  ok(/OK — переменная/.test(String(set1)), "переменная с выдачей terminal задана: " + JSON.stringify(String(set1).slice(0, 80)));
  const set2 = await executeTool("envSet", { key: "LIVE_GIT_TOKEN", value: GIT_VALUE, scopes: ["git"] }, settings);
  ok(/OK — переменная/.test(String(set2)), "переменная с выдачей git задана");
  const cmd = await executeTool("runCommand", { command: "echo TERM=$LIVE_TERM_TOKEN GIT=$LIVE_GIT_TOKEN" }, settings);
  ok(String(cmd).indexOf(TERM_VALUE) >= 0, "во время вызова назначение было terminal.execute: переменная terminal подставлена");
  ok(String(cmd).indexOf(GIT_VALUE) < 0, "переменная чужого назначения подставлена быть не должна");
  ok(d.getCapability() === before, "после вызова назначение вернулось к прежнему: " + JSON.stringify(d.getCapability()));

  console.log("\n[6] в оболочке этого больше нет, проводка стоит вовремя");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(mainSrc.indexOf("async function executeTool(") < 0, "тело executeTool осталось в main.js");
  ok(mainSrc.indexOf("const agentToolHandlers =") < 0, "сборка обработчиков осталась в main.js");
  ok(mainSrc.indexOf("function describeToolArgs(") < 0, "описание аргументов осталось в main.js");
  ok(mainSrc.indexOf("= createToolRegistry({") > mainSrc.indexOf("const { runAi } = createRunAi({"), "реестр собран раньше прогона");
  ok(mainSrc.indexOf('require("./tool-registry.js")') < mainSrc.indexOf("const { runAi } = createRunAi({"), "модуль взят ниже прогона — описание аргументов не дошло бы");
  ok(mainSrc.indexOf("const agentEnvState = createAgentEnv({") < mainSrc.indexOf("= createToolRegistry({"), "реестр собран раньше живого окружения");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")), "настройки не легли в папку приложения");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

"use strict";
/* ─── Живой прогон: куда приложение кладёт работу агента ──────────────────────
   Запуск: npm run test:live:folders   (node scripts/live-folders.js)

   Зачем отдельный прогон. Набор (test/agent-folders.test.js) проверяет раскладку и
   панель, собирая модули сам. Он НЕ проверяет главного: что настоящий main.js
   поставил раскладку (agentData.install) и что ВСЕ настоящие потребители —
   хранилище миссий, прогон, каналы дел и зеркало списка — спрашивают путь у неё,
   а не считают сами. Ошибка здесь тихая и дорогая: человек выбирает свою папку,
   панель говорит «файлы будут писаться туда», а миссия ложится рядом с проектом
   (или наоборот — в папку приложения уезжает чужой проект), и заметить это можно
   только по потерянной работе.

   Поэтому здесь всё настоящее: настройки на диске, настоящий main.js в Node с
   поддельным Electron, настоящие файлы в temp-папках, настоящие каналы IPC и
   настоящий реестр инструментов (миссию заводит сам инструмент агента).

   Разделы:
     [1] раскладка поставлена, а без выбора человека всё лежит как лежало;
     [2] окно первого запуска: состояние, сохранение выбора, вопрос закрыт;
     [3] после выбора миссии, дела и их зеркало уезжают, старое не трогается;
     [4] смена папок в ОТКРЫТОМ приложении видна сразу (следующая миссия — там);
     [5] прогоны рядом с миссиями, панель называет те же пути;
     [6] устаревший объект настроек не стирает выбор и не возвращает вопрос;
     [7] ничего не пишется в репозиторий приложения, каналов в main.js нет.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-userData-"));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-project-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-project2-"));
const missionsStore = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-missions-"));
const tasksStore = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-tasks-"));
const missionsStore2 = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-missions2-"));
const tasksStore2 = fs.mkdtempSync(path.join(os.tmpdir(), "live-folders-tasks2-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = path.join(userData, "settings.json");
const readSettingsFile = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const dirs = (p) => (fs.existsSync(p) ? fs.readdirSync(p).sort() : []);

// Настройки — на диске: их прочитает настоящий loadSettings() внутри main.js.
// workingDir — существующая temp-папка (иначе миссия не заведётся), длинная работа
// и файлы работы включены: иначе приложение честно не спрашивает про папки вовсе.
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ workingDir: project, provider: "ollama", model: "live-model", longWork: true, agentWorkFiles: true }, null, 2)
);
// Работа «прошлой версии»: она обязана остаться ровно там, где лежала.
fs.mkdirSync(path.join(project, ".agent", "missions"), { recursive: true });
fs.writeFileSync(path.join(project, ".agent", "старое.txt"), "работа прошлой версии");
fs.writeFileSync(path.join(project, ".agent", "missions", "old-mission.txt"), "миссия прошлой версии");

const handlers = new Map();
const listeners = new Map();
const windows = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => { w.webContents.sent.push({ ch, ev }); },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
      // Поддельное окно обязано иметь всё, что имеет настоящее (HANDOFF §4, ловушка 9):
      // иначе создание окна падает на середине и шаг старта «окно» не выполняется.
      setWindowOpenHandler: () => {},
      setZoomFactor: () => {},
      executeJavaScript: () => Promise.resolve(),
    },
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
  };
  windows.push(w);
  return w;
};

// Перехват ТОЛЬКО по имени файла: подстрока «agent-tools» заглатывала бы соседей по
// дому (эта ошибка уже стоила двух молчавших прогонов — HANDOFF, ловушка 0).
const seen = { toolDeps: null, tools: null, api: null, missionDeps: null };
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
        getVersion: () => "1.5.213",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => listeners.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: stub("Notification"),
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
    };
  }
  const t = String(req);
  if (/agent-tools-mission\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createMissionTools: function (deps, live) {
        seen.missionDeps = deps;
        return real.createMissionTools(deps, live);
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
  if (/tool-registry\.js$/.test(t)) {
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
// Фоновые отказы main.js прогон не роняют, а падение САМОГО прогона обязано быть
// громким: иначе «молчаливый ноль» в цепочке тестов выглядел бы успехом.
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 120 секунд");
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон папок работы агента (настоящий main.js, настоящие файлы)");
  await sleep(500);

  const call = (ch, ...args) => handlers.get(ch)(null, ...args);
  const settings = () => seen.toolDeps.loadSettings();
  const exec = async (name, args) => {
    try { return await seen.api.executeTool(name, args || {}, settings()); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };

  // Куда приложение кладёт миссии прямо сейчас: подпапку проекта считает раскладка,
  // поэтому спрашиваем её тем же вызовом, что и приложение (agent-data.js).
  const agentData = require(path.join(ROOT, "src", "agent-data.js"));
  const layoutNow = () => agentData.layout(settings(), project, userData);

  console.log("\n[1] раскладка поставлена, а без выбора человека всё лежит как лежало");
  ok(!!seen.toolDeps && typeof seen.toolDeps.tasksDataDir === "function", "реестр инструментов получил папку дел функцией (а не путём)");
  ok(!!seen.missionDeps && seen.missionDeps.missionStore === require(path.join(ROOT, "src", "mission-store.js")),
    "инструменты миссий работают с настоящим хранилищем");
  ok(typeof handlers.get("setup:state") === "function" && typeof handlers.get("setup:save") === "function",
    "каналы окна первого запуска зарегистрированы");
  const st0 = await call("setup:state");
  ok(st0 && st0.ok === true && st0.setupDone === false, "приложение ещё не спрашивало про папки: " + JSON.stringify(st0));
  const L0 = layoutNow();
  ok(L0.missionsRoot === path.join(project, ".agent"), "без выбора миссии лежат в .agent/ проекта: " + L0.missionsRoot);
  ok(L0.tasksRoot === userData, "без выбора дела лежат в папке приложения: " + L0.tasksRoot);

  const firstTask = await call("tasks:add", { title: "позвонить в сервис" });
  ok(firstTask && firstTask.ok === true, "дело добавлено каналом: " + JSON.stringify(firstTask && firstTask.error));
  ok(fs.existsSync(path.join(userData, "tasks.json")), "дела легли в папку приложения, как и лежали");
  ok(fs.existsSync(path.join(project, ".agent", "tasks.md")), "зеркало списка лежит рядом с проектом, как и лежало");

  const firstMission = await exec("missionStart", { goal: "разобрать входящие", steps: ["прочитать", "свести"] });
  const firstId = (/миссия создана: ([^\s]+)/.exec(firstMission) || [])[1];
  ok(!!firstId, "миссия заведена настоящим инструментом: " + String(firstMission).slice(0, 120));
  ok(fs.existsSync(path.join(project, ".agent", "missions", firstId, "mission.json")),
    "папка миссии появилась в .agent/ проекта");

  console.log("\n[2] окно первого запуска: выбор сохраняется, вопрос закрывается навсегда");
  const saved = await call("setup:save", { missionsDir: "  " + missionsStore + "/  ", tasksDir: tasksStore });
  ok(saved && saved.ok === true, "выбор папок сохранён: " + JSON.stringify(saved && saved.error));
  ok(saved.missionsDir === missionsStore && saved.tasksDir === tasksStore, "пути почищены от пробелов и хвостовых слэшей: " + JSON.stringify(saved));
  ok(readSettingsFile().missionsDir === missionsStore, "настройка миссий легла на диск настоящим хранилищем");
  ok(readSettingsFile().tasksDir === tasksStore, "настройка дел легла на диск");
  ok(readSettingsFile().firstRunSetup === "done", "вопрос первого запуска закрыт");
  const st1 = await call("setup:state");
  ok(st1.setupDone === true && st1.missionsDir === missionsStore && st1.tasksDir === tasksStore,
    "состояние окна отвечает выбором человека: " + JSON.stringify(st1));

  console.log("\n[3] после выбора миссии, дела и зеркало уезжают; старое остаётся где было");
  const L1 = layoutNow();
  ok(L1.missionsRoot.startsWith(missionsStore + path.sep), "миссии уехали в выбранную папку: " + L1.missionsRoot);
  ok(L1.missionsRoot !== L0.missionsRoot && L1.missionsRoot !== project, "миссии больше не лежат рядом с проектом");
  const secondMission = await exec("missionStart", { goal: "разобрать вторую пачку", steps: ["прочитать"] });
  const secondId = (/миссия создана: ([^\s]+)/.exec(secondMission) || [])[1];
  ok(!!secondId, "вторая миссия заведена: " + String(secondMission).slice(0, 120));
  ok(fs.existsSync(path.join(L1.missionsRoot, "missions", secondId, "mission.json")),
    "файлы миссии НА ДИСКЕ в выбранной папке: " + path.join(L1.missionsRoot, "missions", secondId));
  ok(dirs(missionsStore).indexOf("README.md") < 0 && dirs(missionsStore).indexOf(".gitignore") < 0,
    "README и .gitignore остались только у .agent/, в папке человека приложение не мусорит: " + dirs(missionsStore).join(", "));
  ok(fs.existsSync(path.join(project, ".agent", "README.md")), "README у .agent/ на месте — папка по-прежнему объясняет себя");
  const secondTask = await call("tasks:add", { title: "оплатить хостинг" });
  ok(secondTask && secondTask.ok === true, "второе дело добавлено: " + JSON.stringify(secondTask && secondTask.error));
  ok(fs.existsSync(path.join(tasksStore, "tasks.json")), "дела уехали в выбранную папку дел");
  ok(fs.existsSync(path.join(tasksStore, "tasks.md")), "зеркало списка уехало туда же, где дела");

  // Миграции НЕТ: старое на месте байт в байт, и копий не появилось.
  ok(fs.existsSync(path.join(project, ".agent", "старое.txt")), "работа прошлой версии не тронута");
  ok(fs.existsSync(path.join(project, ".agent", "missions", firstId, "mission.json")), "миссия прошлой версии осталась в .agent/");
  ok(fs.readFileSync(path.join(project, ".agent", "missions", firstId, "mission.json"), "utf8").indexOf("разобрать входящие") >= 0,
    "старая миссия не переписана приложением");
  ok(!fs.existsSync(path.join(missionsStore, "missions", firstId)), "старая миссия не скопирована в новую папку");

  console.log("\n[4] смена папок в ОТКРЫТОМ приложении видна сразу (раскладка не застыла)");
  const moved = await call("setup:save", { missionsDir: missionsStore2, tasksDir: tasksStore2 });
  ok(moved.ok === true && moved.missionsDir === missionsStore2, "выбор сменён без перезапуска: " + JSON.stringify(moved));
  const L2 = layoutNow();
  ok(L2.missionsRoot.startsWith(missionsStore2 + path.sep), "раскладка посчитана по НОВОЙ настройке: " + L2.missionsRoot);
  const thirdMission = await exec("missionStart", { goal: "работа после смены папок", steps: ["сделать"] });
  const thirdId = (/миссия создана: ([^\s]+)/.exec(thirdMission) || [])[1];
  ok(!!thirdId && fs.existsSync(path.join(L2.missionsRoot, "missions", thirdId, "mission.json")),
    "следующая миссия легла сразу в новую папку (настройка читается в момент вызова)");
  // Два проекта в одной выбранной папке не смешиваются: у каждого своя подпапка.
  const otherLayout = agentData.layout(settings(), other, userData);
  ok(otherLayout.missionsRoot !== L2.missionsRoot && otherLayout.missionsRoot.startsWith(missionsStore2 + path.sep),
    "второй проект получил свою подпапку в выбранной папке: " + otherLayout.missionsRoot);

  console.log("\n[5] прогоны рядом с миссиями, и панель называет те же пути");
  // Прогон спрашивает корень у того же хранилища (src/run-context.js → mission-store.js
  // → agent-data.js), поэтому незавершённая работа ложится рядом с миссиями.
  const { createRunContext } = require(path.join(ROOT, "src", "run-context.js"));
  const ctx = createRunContext({ dir: () => project, id: "live-folders-chat" });
  const wrote = ctx.save([{ role: "user", content: "разбери письма" }]);
  ok(wrote.ok === true, "чекпоинт прогона записан: " + JSON.stringify(wrote));
  ok(String(ctx.file).startsWith(path.join(L2.missionsRoot, "runs") + path.sep),
    "чекпоинт прогона лежит рядом с миссиями: " + ctx.file);
  ok(fs.existsSync(ctx.file), "файл чекпоинта действительно на диске");
  ok(!fs.existsSync(path.join(project, ".agent", "runs", "live-folders-chat.json")),
    "чекпоинт не остался в .agent/ проекта, хотя папка выбрана");
  ctx.close();

  const filesStatus = await call("agentfiles:status");
  ok(filesStatus.missionsCustom === true && filesStatus.tasksCustom === true, "панель видит, что папки выбраны человеком");
  ok(filesStatus.missionsRoot === L2.missionsRoot, "панель называет настоящий корень миссий: " + filesStatus.missionsRoot);
  ok(filesStatus.tasksRoot === tasksStore2, "панель называет настоящую папку дел: " + filesStatus.tasksRoot);
  const insideLayout = agentData.layout({ missionsDir: path.join(project, "work"), tasksDir: "" }, project, userData);
  ok(insideLayout.missionsInsideProject === true, "выбор папки внутри проекта распознаётся как «осталось в проекте»");

  console.log("\n[6] устаревший объект настроек не стирает выбор и не возвращает вопрос");
  const stale = await call("settings:set", { model: "live-model-2", missionsDir: "", tasksDir: "", firstRunSetup: "ask" });
  ok(stale.missionsDir === missionsStore2 && stale.tasksDir === tasksStore2, "выбор папок не стёрт старым окном: " + JSON.stringify({ m: stale.missionsDir, t: stale.tasksDir }));
  ok(stale.firstRunSetup === "done", "вопрос первого запуска не вернулся");
  const stillChosen = await call("setup:state");
  ok(stillChosen.missionsDir === missionsStore2 && stillChosen.setupDone === true, "состояние окна осталось прежним");
  const afterStale = await exec("missionStart", { goal: "работа после сохранения настроек", steps: ["шаг"] });
  const staleId = (/миссия создана: ([^\s]+)/.exec(afterStale) || [])[1];
  ok(!!staleId && fs.existsSync(path.join(L2.missionsRoot, "missions", staleId, "mission.json")),
    "миссия после обычного сохранения настроек легла в выбранную папку");

  // «Оставить как было» (пустой запрос) — тоже ответ: папки прежние, вопрос закрыт.
  const asIs = await call("setup:save", {});
  ok(asIs.ok === true && asIs.missionsDir === missionsStore2 && asIs.tasksDir === tasksStore2,
    "«оставить как было» ничего не стёрло: " + JSON.stringify(asIs));
  ok(readSettingsFile().firstRunSetup === "done", "вопрос остался закрытым");

  console.log("\n[7] ничего не пишется в репозиторий, каналов в main.js нет");
  ok(fs.readdirSync(path.join(ROOT, "src")).sort().join(",") === appFilesBefore, "папка src не изменилась после работы каналов");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")) && !fs.existsSync(path.join(ROOT, "tasks.json")),
    "настройки и дела не легли в репозиторий приложения");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(mainSrc.indexOf('require("./agent-data.js")') > 0 && mainSrc.indexOf("agentData.install(agentLayoutFor)") > 0,
    "main.js ставит раскладку одной подстановкой");
  ok(!/ipcMain\.(handle|on)\("setup:/.test(mainSrc) && !/ipcMain\.(handle|on)\("tasks:/.test(mainSrc),
    "каналов раскладки и дел в main.js не осталось");
  for (const f of ["mission-ipc.js", "tasks-reminders.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "src", f), "utf8");
    ok(src.indexOf("tasksDataDir") > 0 && !/tasksBoard\(userDataDir\(\)\)/.test(src),
      f + " спрашивает папку дел, а не папку приложения");
  }
  const storeSrc = fs.readFileSync(path.join(ROOT, "src", "mission-store.js"), "utf8");
  ok(storeSrc.indexOf('require("./agent-data.js")') > 0 && storeSrc.indexOf("layoutOf(workDir).missionsRoot") > 0,
    "корень миссий приходит из раскладки, а не считается в хранилище");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

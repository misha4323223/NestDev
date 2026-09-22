"use strict";
/* ─── Живой прогон миссий и плана (без окна) ─────────────────────────────────
   Запуск: npm run test:live:tools-mission   (node scripts/live-tools-mission.js)

   Зачем этот прогон. Четыре обработчика длинной работы и один — плана
   (missionStart, missionStep, missionStatus, missionFinish, todoWrite) уехали
   своим модулем (часть 40, заход 6c) вместе с двумя помощниками замыкания —
   notifyMission и missionOfRun. Текстовый сторож здесь не значит ничего: важно,
   что цель, план, журнал и отчёт ЛОЖАТСЯ ФАЙЛАМИ, что инструмент без id берёт
   именно миссию прогона, а сводка плана доезжает до настоящего состояния main.js.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-mission.js;
     • настоящее хранилище миссий (src/mission-store.js) и настоящие файлы.

   Ничего наружу не уходит: всё в своей временной папке. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-mission-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-mission-work-"));

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

const seen = { mission: 0, missionDeps: null, missionLive: null, missionArgs: 0, missionTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.201", setName: () => {}, setAppUserModelId: () => {},
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
  if (/agent-tools-mission\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createMissionTools: function (deps, live) {
        seen.mission++;
        seen.missionDeps = deps;
        seen.missionLive = live;
        seen.missionArgs = arguments.length;
        seen.missionTools = real.createMissionTools(deps, live);
        return seen.missionTools;
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

const NAMES = ["missionStart", "missionStep", "missionStatus", "missionFinish", "todoWrite"];
const missionsDir = () => path.join(work, ".agent", "missions");

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон миссий и плана (настоящий main.js, настоящие файлы в " + path.basename(work) + ")");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  // Отказ обработчика не должен ВЕШАТЬ прогон: без этого брошенное исключение
  // уходило в отклонённое обещание, а прогон молчал до самого сторожа (проверено
  // негативным контролем с пустой проводкой). Теперь отказ виден строкой.
  const call = async (name, args) => {
    try { return await executeTool(name, args || {}, settings); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };

  try {
    console.log("\n[1] проводка: модуль собран один раз, с тем же состоянием и живым мостом");
    ok(seen.mission === 1, "createMissionTools вызван " + seen.mission + " раз(а)");
    ok(seen.missionDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.missionArgs === 2, "модулю передан и живой мост (аргументов: " + seen.missionArgs + ")");
    ok(!!seen.missionLive && typeof seen.missionLive.activeRunMissionId === "string", "живой мост отвечает на activeRunMissionId");
    ok(!!seen.missionLive && (typeof seen.missionLive.activeEmit === "function" || seen.missionLive.activeEmit === null),
      "мост отдаёт отправителя событий (сейчас: " + (seen.missionLive ? typeof seen.missionLive.activeEmit : "моста нет") + ")");
    const missing = NAMES.filter((n) => typeof (seen.missionTools || {})[n] !== "function");
    ok(missing.length === 0, "все пять инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const refs = NAMES.filter((n) => seen.tools[n] !== seen.missionTools[n]);
    ok(refs.length === 0, "в реестре именно ссылки на модуль, а не копии" + (refs.length ? ": расходятся " + refs.join(", ") : ""));
    const agentToolsSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(agentToolsSrc.indexOf("const notifyMission = () => {") < 0 && agentToolsSrc.indexOf("const missionOfRun = (dir) => {") < 0,
      "помощники не остались мёртвыми в оболочке (они уехали вместе с обработчиками)");
    const moduleSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools-mission.js"), "utf8");
    ok(moduleSrc.indexOf("const notifyMission = () => {") > 0 && moduleSrc.indexOf("const missionOfRun = (dir) => {") > 0,
      "оба помощника живут в модуле");

    console.log("\n[2] план: ответ, панель и сводка в НАСТОЯЩЕМ состоянии main.js");
    const plan = plain(await call("todoWrite", { tasks: [{ text: "прочитать", status: "done" }, { text: "свести" }], title: "Разбор" }));
    ok(/^OK — план показан пользователю: 1 из 2 готово/.test(plan), "план подан не так: " + oneLine(plan));
    const bridge = d.live;
    const summary = bridge.activePlanSummary();
    ok(summary && summary.total === 2 && summary.done === 1 && summary.failed === 0,
      "сводка плана доехала до main.js: " + JSON.stringify(summary));
    ok(/план пуст/.test(plain(await call("todoWrite", { tasks: [] }))), "пустой план отвергнут");

    console.log("\n[3] миссия: файлы, план и журнал на диске");
    const started = plain(await call("missionStart", { goal: "разобрать заявки", steps: ["прочитать", "свести"], minutes: 30 }));
    const id = (/миссия создана: ([^\s]+)/.exec(started) || [])[1];
    ok(!!id, "в ответе назван id миссии: " + oneLine(started));
    ok(fs.existsSync(path.join(missionsDir(), id)), "папка миссии лежит в рабочей папке проекта");
    const rec = JSON.parse(fs.readFileSync(path.join(missionsDir(), id, "mission.json"), "utf8"));
    ok(rec.goal === "разобрать заявки" && (rec.steps || []).length === 2, "цель и план миссии записаны: " + JSON.stringify({ goal: rec.goal, steps: rec.steps.length }));
    ok(fs.readFileSync(path.join(missionsDir(), id, "journal.md"), "utf8").indexOf("Миссия начата") >= 0, "журнал миссии начат на диске");
    ok(/ПЕРВЫМ ДЕЛОМ вызови todoWrite/.test(started), "ответ требует план — иначе панель пуста");

    console.log("\n[3Б] план панели становится планом миссии (как в жизни: миссию завело приложение без steps)");
    // Живая беда 1.5.20x: миссию создаёт само приложение без steps, агент пишет план
    // через todoWrite — и карточка миссии говорила «План не составлен», хотя план есть.
    const auto = plain(await call("missionStart", { goal: "навести порядок в папке загрузок" }));
    const autoId = (/миссия создана: ([^\s]+)/.exec(auto) || [])[1];
    ok(!!autoId, "миссия без steps создалась: " + oneLine(auto));
    const autoFile = () => JSON.parse(fs.readFileSync(path.join(missionsDir(), autoId, "mission.json"), "utf8"));
    ok((autoFile().steps || []).length === 0, "проверка не о том: у миссии уже был план");
    const autoJournal = () => fs.readFileSync(path.join(missionsDir(), autoId, "journal.md"), "utf8");
    const plainAuto = plain(await call("missionStatus", {}));
    ok(plainAuto.indexOf(autoId) >= 0 && !/План:/.test(plainAuto), "до плана миссия честно без плана: " + oneLine(plainAuto));

    const mirrored = plain(await call("todoWrite", {
      tasks: [{ text: "прочитать загрузки", status: "done" }, { text: "сложить по папкам", status: "in_progress" }, { text: "отчитаться" }],
    }));
    ok(/План миссии «/.test(mirrored), "агент не видит, что план лёг в миссию: " + oneLine(mirrored.slice(-140)));
    ok(autoFile().steps.map((s) => s.state).join(",") === "done,doing,todo", "шаги миссии не совпали с планом: " + JSON.stringify((autoFile().steps || []).map((s) => s.state)));
    ok(autoFile().next === "сложить по папкам", "«дальше» миссии не следует за планом: " + autoFile().next);
    ok(/План \(3\): прочитать загрузки · сложить по папкам · отчитаться/.test(autoJournal()), "план не записан в журнал миссии");
    ok(/✅ Шаг выполнен: прочитать загрузки/.test(autoJournal()), "закрытый пункт плана не отмечен в журнале миссии");
    const withPlan = plain(await call("missionStatus", {}));
    ok(withPlan.indexOf(autoId) >= 0 && /Прогресс: 1\/3/.test(withPlan), "панель миссии не увидела план: " + oneLine(withPlan));
    ok(/\[x\] 1\. прочитать загрузки/.test(withPlan), "в плане миссии нет отметки о готовом пункте: " + oneLine(withPlan.slice(0, 200)));
    // Панель отвечает на план живым событием, а не только опросом.
    ok(!!d.live && typeof d.live.activeEmit === "function", "живой мост не отдаёт отправителя событий");
    // Миссию закрываем: иначе она «своя» для следующих шагов, и набор упадёт не по делу.
    const autoFin = plain(await call("missionFinish", { report: "загрузки разобраны", status: "done" }));
    ok(/^OK — миссия /.test(autoFin) && autoFile().status === "done", "миссия с планом не закрылась: " + oneLine(autoFin));
    ok(/✅ Шаг выполнен/.test(autoJournal()) && /разобраны/.test(fs.readFileSync(path.join(missionsDir(), autoId, "report.md"), "utf8")), "отчёт миссии не лёг файлом");

    console.log("\n[4] «своя» миссия: инструмент без id берёт незакрытую, а не выдумывает");
    const status = plain(await call("missionStatus", {}));
    ok(status.indexOf(id) >= 0 && /Прогресс: 0\/2/.test(status), "без id названа именно эта миссия: " + oneLine(status));
    ok(/не найдена/.test(plain(await call("missionStatus", { id: "нет-такой-миссии" }))), "несуществующая миссия объяснена");
    ok(/укажи query|Незакрытых миссий нет|Ошибка/.test(plain(await call("missionStatus", { id: "" }))) === false, "пустой id не считается ошибкой (берётся миссия прогона)");
    ok(/Журнал \(хвост\)/.test(status), "статус показывает хвост журнала");

    console.log("\n[5] шаг: прогресс, «дальше» и заметка — на диске");
    const step = plain(await call("missionStep", { done: "прочитать", next: "свести", note: "прочитано 12 писем" }));
    ok(/OK — миссия/.test(step) && /1\/2 готово/.test(step), "шаг отмечен и прогресс назван: " + oneLine(step));
    const journal = fs.readFileSync(path.join(missionsDir(), id, "journal.md"), "utf8");
    ok(journal.indexOf("прочитано 12 писем") >= 0, "заметка шага в журнале");
    ok(journal.indexOf("Дальше: свести") >= 0 || journal.indexOf("Шаг выполнен: прочитать") >= 0, "следующий шаг записан в журнал");
    const status2 = plain(await call("missionStatus", {}));
    ok(/Прогресс: 1\/2/.test(status2), "статус видит выполненный шаг: " + oneLine(status2.split("\n").slice(1), 1));

    console.log("\n[6] закрытие: отчёт файлом, повтор — честно «уже закрыта»");
    const fin = plain(await call("missionFinish", { report: "всё сделано", status: "done" }));
    ok(/^OK — миссия /.test(fin), "закрытие названо: " + oneLine(fin));
    ok(fs.readFileSync(path.join(missionsDir(), id, "report.md"), "utf8").indexOf("всё сделано") >= 0, "отчёт лёг файлом");
    ok(/Незакрытых миссий нет/.test(plain(await call("missionStatus", {}))), "после закрытия незакрытых нет");
    const again = plain(await call("missionFinish", { report: "ещё раз" }));
    ok(/уже закрыта/.test(again) && /Отчёт: .agent\/missions\//.test(again), "повторное закрытие назвало прежнюю работу: " + oneLine(again));

    console.log("\n[7] гигиена прогона");
    ok(fs.readdirSync(work).filter((f) => f !== ".agent").length === 0, "в проекте не осталось чужого мусора: " + (fs.readdirSync(work).join(", ") || "чисто"));
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки миссий и плана пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  // Последний предохранитель: любой обрыв прогона обязан быть НАЗВАН и завершиться
  // кодом 1. Без этого процесс оставался жить на таймерах main.js и молчал.
  console.error("❌ Живой прогон оборвался: " + ((e && e.stack) || e));
  process.exit(1);
});

"use strict";

/* ── Куда класть работу агента: миссии, прогоны и дела ────────────────────────
   Запуск: node test/agent-folders.test.js   (входит в общий `npm test`)

   Человек выбрал: объём — миссии, прогоны и дела; структура — ОТДЕЛЬНЫЕ настройки
   для миссий и для дел; по умолчанию — СПРОСИТЬ при первом запуске; миграции нет
   (существующие файлы приложение НИКОГДА не переносит).

   Раскладку считает один модуль (src/agent-data.js), и здесь проверяется ровно то,
   что ошибается тихо:

     • пустая настройка — ПРЕЖНИЕ места (.agent/ рядом с проектом и папка
       приложения): обновление не имеет права разложить старую работу по-новому;
     • своя папка миссий получает ПОДПАПКУ ПРОЕКТА, иначе миссии двух проектов
       смешались бы в одной папке и кнопка «▶ Продолжить» вернула бы чужую задачу;
     • дела общие для всех проектов — уезжают в выбранную папку без подпапки;
     • уже лежащие файлы не переносятся: старая папка остаётся как была, копий не
       появляется (перенос на ровном месте — это потеря работы);
     • окно первого запуска спрашивает ОДИН раз и закрывает вопрос навсегда, а
       обычное сохранение настроек не имеет права вернуть вопрос или стереть выбор. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const agentData = require(path.join(ROOT, "src", "agent-data.js"));
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));

let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const APP_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
const STORE_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-store.js"), "utf8");
const PANEL_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings-panel.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");

// Временная папка на каждый стенд: все файлы настоящие, но в стороне от репозитория.
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fb-folders-" + tag + "-"));
}

// Раскладка, как её ставит main.js: настройки читаются в МОМЕНТ вызова.
function installLayout(settings, userDataDir) {
  agentData.install((workDir) => agentData.layout(settings, workDir, userDataDir));
  return settings;
}

(async () => {
  console.log("Куда класть работу агента: миссии, прогоны и дела");

  // ── Раскладка ──────────────────────────────────────────────────────────────
  await test("пустая настройка — прежние места: .agent/ рядом с проектом и папка приложения", () => {
    const wd = path.join(tmpDir("default"), "project");
    const ud = path.join(tmpDir("default"), "userData");
    const L = agentData.layout({}, wd, ud);
    assert.strictEqual(L.missionsRoot, path.join(wd, ".agent"), "миссии уехали из проекта без выбора человека");
    assert.strictEqual(L.runsRoot, path.join(wd, ".agent", "runs"), "прогоны не рядом с миссиями");
    assert.strictEqual(L.tasksRoot, ud, "дела уехали из папки приложения");
    assert.strictEqual(L.tasksMirrorRoot, path.join(wd, ".agent"), "зеркало дел потеряло прежнее место");
    assert.strictEqual(L.missionsCustom, false);
    assert.strictEqual(L.tasksCustom, false);
  });

  await test("своя папка миссий: внутри — подпапка проекта, два проекта не смешиваются", () => {
    const store = tmpDir("missions");
    const a = path.join(tmpDir("projA"), "site");
    const b = path.join(tmpDir("projB"), "site");
    const s = { missionsDir: store };
    const LA = agentData.layout(s, a, "/ud");
    const LB = agentData.layout(s, b, "/ud");
    assert.strictEqual(LA.missionsCustom, true);
    assert.ok(LA.missionsRoot.startsWith(store + path.sep), "миссии не легли в выбранную папку: " + LA.missionsRoot);
    assert.strictEqual(path.dirname(LA.missionsRoot), store, "подпапка проекта завелась не прямо в выбранной папке");
    assert.notStrictEqual(LA.missionsRoot, LB.missionsRoot, "миссии двух проектов попали в одну папку");
    assert.ok(LA.missionsRoot.indexOf("site-") > 0, "имя подпапки проекта не читается человеком: " + LA.missionsRoot);
    // Отпечаток пути различает ОДИНАКОВЫЕ имена папок: иначе подпапка была бы одна.
    assert.ok(/site-[0-9a-f]{8}$/.test(LA.missionsRoot), "в имени подпапки нет отпечатка пути: " + LA.missionsRoot);
  });

  await test("своя папка дел: без подпапки проекта, и туда же идёт зеркало tasks.md", () => {
    const store = tmpDir("tasks");
    const L = agentData.layout({ tasksDir: store }, "/proj", "/ud");
    assert.strictEqual(L.tasksRoot, store, "дела не легли в выбранную папку");
    assert.strictEqual(L.tasksMirrorRoot, store, "зеркало дел ушло не туда, где сами дела");
    assert.ok(path.dirname(L.tasksRoot) !== L.tasksRoot, "папка дел посчитана как корень диска");
  });

  await test("папка внутри проекта — это видно и говорится честно", () => {
    const wd = path.join(tmpDir("inside"), "project");
    const L = agentData.layout({ missionsDir: path.join(wd, "work"), tasksDir: path.join(wd, "work", "t") }, wd, "/ud");
    assert.strictEqual(L.missionsInsideProject, true, "выбор внутри проекта не замечен");
    assert.strictEqual(L.tasksInsideProject, true, "папка дел внутри проекта не замечена");
    const outside = agentData.layout({ missionsDir: tmpDir("outside") }, wd, "/ud");
    assert.strictEqual(outside.missionsInsideProject, false, "чужая папка названа своей");
  });

  await test("хвостовые разделители и пробелы в пути не ломают раскладку", () => {
    const store = tmpDir("clean");
    const L = agentData.layout({ missionsDir: "  " + store + "\\\\  " }, "/proj", "/ud");
    assert.strictEqual(L.missionsDir, store, "путь из настроек не почищен: " + L.missionsDir);
    assert.strictEqual(path.dirname(L.missionsRoot), store);
  });

  // ── Хранилища на выбранной раскладке ───────────────────────────────────────
  await test("миссии и прогоны пишутся в выбранную папку, старый .agent/ не трогается", () => {
    const wd = path.join(tmpDir("store"), "project");
    const userData = path.join(tmpDir("store"), "userData");
    fs.mkdirSync(path.join(wd, ".agent"), { recursive: true });
    fs.writeFileSync(path.join(wd, ".agent", "старое.txt"), "работа прошлой версии");
    const store = tmpDir("storeMissions");
    installLayout({ missionsDir: store }, userData);

    const created = missionStore.missionCreate(wd, { goal: "Разобрать входящие", title: "Разбор" });
    assert.strictEqual(created.ok, true, "миссия не создалась: " + created.error);
    const root = agentData.layout({ missionsDir: store }, wd, userData).missionsRoot;
    assert.ok(created.dir.startsWith(root + path.sep), "папка миссии не в выбранной папке: " + created.dir);
    assert.ok(fs.existsSync(path.join(created.dir, "mission.json")), "mission.json не записан");
    assert.ok(fs.existsSync(path.join(created.dir, "journal.md")), "журнал миссии не записан");

    // Список миссий читается оттуда же — иначе панель показала бы пустоту.
    assert.strictEqual(missionStore.missionList(wd, { limit: 10 }).length, 1, "миссия не найдена в своей папке");

    // Миграции НЕТ: в проекте остался ровно тот файл, что был, и появиться копии не могло.
    const projectFiles = fs.readdirSync(path.join(wd, ".agent"));
    assert.deepStrictEqual(projectFiles, ["старое.txt"], "в проекте появились файлы после выбора папки: " + projectFiles.join(", "));
    agentData.install(null);
  });

  await test("дела и их зеркало уезжают в свою папку, памятки контекста остаются у проекта", () => {
    const wd = path.join(tmpDir("mirror"), "project");
    const userData = path.join(tmpDir("mirror"), "userData");
    const store = tmpDir("mirrorTasks");
    installLayout({ tasksDir: store }, userData);

    const r = missionStore.tasksMirror(wd, "# Дела\n- позвонить\n");
    assert.strictEqual(r.ok, true, "зеркало дел не записано: " + r.error);
    assert.strictEqual(r.file, path.join(store, "tasks.md"), "зеркало легло не в выбранную папку: " + r.file);
    assert.ok(fs.existsSync(path.join(store, "tasks.md")), "файла зеркала нет на диске");

    // Своя папка дел делает зеркало независимым от проекта: рабочей папки нет — пишем.
    const noProject = missionStore.tasksMirror("", "# Дела\n");
    assert.strictEqual(noProject.ok, true, "без рабочей папки зеркало не записалось, хотя папка дел выбрана: " + noProject.error);

    // Памятки контекста — зеркало разговора О ПРОЕКТЕ: уезжать вместе с делами они не просились.
    missionStore.contextMirror(wd, Date.now(), "разобрали структуру");
    const ctxDir = path.join(wd, ".agent", "context");
    assert.ok(fs.existsSync(ctxDir), "памятки контекста потеряли прежнее место");
    assert.ok(!fs.existsSync(path.join(store, "context")), "памятки контекста уехали вместе с делами");
    agentData.install(null);
  });

  await test("состояние раскладки для настроек: где файлы лежат НА САМОМ ДЕЛЕ", () => {
    const wd = path.join(tmpDir("status"), "project");
    fs.mkdirSync(wd, { recursive: true });
    const userData = path.join(tmpDir("status"), "userData");
    const store = tmpDir("statusMissions");
    installLayout({ missionsDir: store, tasksDir: "" }, userData);
    const st = missionStore.mirrorStatus(wd);
    assert.strictEqual(st.missionsCustom, true, "своя папка миссий не отражена");
    assert.ok(st.missionsRoot.startsWith(store), "панель получила чужой путь миссий: " + st.missionsRoot);
    assert.strictEqual(st.tasksCustom, false, "невыбранные дела названы выбранными");
    assert.strictEqual(st.tasksRoot, userData, "дела потеряли папку приложения");
    agentData.install(null);
  });

  await test("без своей папки всё работает как раньше: миссия ложится в .agent/ проекта", () => {
    const wd = path.join(tmpDir("legacy"), "project");
    fs.mkdirSync(wd, { recursive: true });
    installLayout({}, tmpDir("legacyUserData"));
    const created = missionStore.missionCreate(wd, { goal: "Проверить прежнее место" });
    assert.strictEqual(created.ok, true, "миссия не создалась: " + created.error);
    assert.ok(created.dir.startsWith(path.join(wd, ".agent", "missions")), "миссия ушла не в .agent/: " + created.dir);
    assert.ok(fs.existsSync(path.join(wd, ".agent", "README.md")), "папка .agent/ перестала объяснять себя человеку");
    agentData.install(null);
  });

  // ── Настройки: схема и защита выбора ───────────────────────────────────────
  await test("схема настроек знает поля выбора и чистит мусор", () => {
    assert.ok(/missionsDir: ""/.test(fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8")), "нет поля папки миссий");
    assert.ok(/tasksDir: ""/.test(fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8")), "нет поля папки дел");
    assert.ok(/firstRunSetup: "ask"/.test(fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8")), "нет поля приглашения первого запуска");
    // Проверяем чистку на настоящем хранилище: путь уезжает в path.join, и не-строка
    // превратила бы раскладку в папку с именем «[object Object]».
    const store = require(path.join(ROOT, "src", "settings-store.js"));
    const made = store.createSettingsStore({
      fs, path, os,
      app: { getPath: () => tmpDir("cfg") },
      secrets: { SECRET_KEYS: [], loadSecrets: () => ({}), splitSecrets: (s) => ({ rest: s, sec: {} }), saveSecrets: () => {} },
      audit: { setEnabled: () => {} },
      toolPolicy: { normalizeScopes: (v) => v || {} },
      vault: { sanitizeList: (v) => (Array.isArray(v) ? v : []) },
      applyAgentEnv: () => {},
      applyBrowserSettings: () => {},
    });
    const n = made.normalizeSettings({
      missionsDir: "  D:\\\\work\\\\  ",
      tasksDir: 42,
      firstRunSetup: "что-то своё",
    });
    assert.strictEqual(n.missionsDir, "D:\\\\work", "путь не почищен: " + n.missionsDir);
    assert.strictEqual(n.tasksDir, "", "не-строка попала в настройки как путь: " + JSON.stringify(n.tasksDir));
    assert.strictEqual(n.firstRunSetup, "ask", "мусор в приглашении принят за ответ человека: " + n.firstRunSetup);
  });

  // ── Окно «Куда класть работу агента?» ──────────────────────────────────────
  await test("окно первого запуска есть в разметке: папки миссий и дел, сохранение и отказ", () => {
    for (const id of [
      "setup-overlay", "setup-missions-dir", "setup-tasks-dir",
      "btn-setup-missions-pick", "btn-setup-tasks-pick",
      "btn-setup-missions-clear", "btn-setup-tasks-clear",
      "btn-setup-save", "btn-setup-skip", "setup-hint",
    ]) {
      assert.ok(HTML.indexOf('id="' + id + '"') > 0, "в разметке нет окна выбора папок: " + id);
    }
    assert.ok(/переносит/.test(HTML), "в окне не сказано, что файлы не переносятся");
  });

  await test("проводка: окно собирается из интерфейса, вопрос задаётся после загрузки настроек", () => {
    assert.ok(/wireSetupFolders: wireSetupFolders/.test(PANEL_SRC), "панель настроек не отдаёт сборку окна");
    assert.ok(/maybeAskFolders: maybeAskFolders/.test(PANEL_SRC), "панель настроек не отдаёт вопрос первого запуска");
    assert.ok(/SettingsPanel\.wireSetupFolders\(\);/.test(APP_SRC), "окно выбора папок не собирается при запуске окна");
    assert.ok(/afterLoad: \(\) => \{ if \(SettingsPanel && SettingsPanel\.maybeAskFolders\)/.test(APP_SRC),
      "вопрос первого запуска не задаётся после загрузки настроек");
    assert.ok(/fireAfterLoad\(\)/.test(STORE_SRC), "мост «после загрузки» не зовётся хранилищем");
    for (const ch of ["setup:state", "setup:save"]) {
      assert.ok(PRELOAD_SRC.includes('"' + ch + '"'), "preload.js не знает канал " + ch);
      assert.ok(MOBILE_SRC.includes('"' + ch + '"'), "mobile-api.js не знает канал " + ch);
    }
    assert.ok(PANEL_SRC.indexOf('api.setupState') > 0 && PANEL_SRC.indexOf('api.setupSave') > 0, "панель не ходит своими каналами");
  });

  await test("панель: окно показывает текущий выбор и сохраняет папки своим каналом", async () => {
    const env = buildPanel({ settings: { firstRunSetup: "ask", missionsDir: "", tasksDir: "" } });
    await env.panel.openSetupFolders(true);
    assert.ok(!env.el("setup-overlay").classList.contains("hidden"), "окно первого запуска не показалось");
    assert.ok(/Куда класть/.test(env.el("setup-title").textContent), "заголовок первого запуска потерян: " + env.el("setup-title").textContent);

    env.el("setup-missions-dir").value = "D:/work/missions";
    env.el("setup-tasks-dir").value = "D:/work/tasks";
    await env.panel.saveSetupFolders(false);
    assert.deepStrictEqual(env.calls.saved, [{ missionsDir: "D:/work/missions", tasksDir: "D:/work/tasks" }],
      "папки сохранены не тем, что в окне: " + JSON.stringify(env.calls.saved));
    assert.ok(env.el("setup-overlay").classList.contains("hidden"), "окно не закрылось после сохранения");
    assert.strictEqual(env.settings.missionsDir, "D:/work/missions", "настройки окна не обновились");
    assert.strictEqual(env.settings.firstRunSetup, "done", "вопрос остался открытым");
    assert.ok(env.calls.toasts.length > 0, "человеку не сказали, что выбор сохранён");
  });

  await test("панель: «оставить как было» закрывает вопрос, не трогая папки", async () => {
    const env = buildPanel({ settings: { firstRunSetup: "ask", missionsDir: "D:/old", tasksDir: "" } });
    await env.panel.openSetupFolders(true);
    await env.panel.saveSetupFolders(true);
    assert.deepStrictEqual(env.calls.saved, [{}], "«оставить как было» ушло с правкой папок: " + JSON.stringify(env.calls.saved));
    assert.strictEqual(env.settings.missionsDir, "D:/old", "папка стёрта ответом «оставить как было»");
    assert.strictEqual(env.settings.firstRunSetup, "done", "вопрос не закрылся — он вернётся при следующем запуске");
  });

  await test("панель: вопрос задаётся один раз и только пока человек не ответил", async () => {
    const ask = buildPanel({ settings: { firstRunSetup: "ask" } });
    await ask.panel.maybeAskFolders();
    assert.ok(!ask.el("setup-overlay").classList.contains("hidden"), "при первом запуске вопрос не задан");
    await ask.panel.maybeAskFolders();
    assert.strictEqual(ask.calls.states, 1, "вопрос задаётся повторно в том же запуске: " + ask.calls.states);

    const answered = buildPanel({ settings: { firstRunSetup: "done" } });
    await answered.panel.maybeAskFolders();
    assert.ok(answered.el("setup-overlay").classList.contains("hidden"), "отвеченный вопрос задан снова");
    assert.strictEqual(answered.calls.states, 0, "окно даже не спрашивало состояние: зря сходило на диск");

    const off = buildPanel({ settings: { firstRunSetup: "ask", agentWorkFiles: false, longWork: false } });
    await off.panel.maybeAskFolders();
    assert.ok(off.el("setup-overlay").classList.contains("hidden"), "спрашивали про папки, когда файлы работы выключены целиком");

    const web = buildPanel({ electron: false, settings: { firstRunSetup: "ask" } });
    await web.panel.maybeAskFolders();
    assert.strictEqual(web.calls.states, 0, "в веб-превью полезли к папкам на ПК");
  });

  await test("панель: Esc и клик мимо окна — это ответ, а не «спросить снова»", async () => {
    const env = buildPanel({ settings: { firstRunSetup: "ask" } });
    env.panel.wireSetupFolders();
    await env.panel.openSetupFolders(true);
    env.fireEsc();
    await tick(); // ответ уходит своим каналом асинхронно — даём ему дойти
    assert.strictEqual(env.settings.firstRunSetup, "done", "Esc оставил вопрос открытым — окно вернётся при перезапуске");
    assert.deepStrictEqual(env.calls.saved, [{}], "Esc что-то поменял в папках: " + JSON.stringify(env.calls.saved));
    assert.ok(env.el("setup-overlay").classList.contains("hidden"), "Esc не закрыл окно");
  });

  await test("панель: кнопка «Папки работы» добавляется к строке файлов работы, и только одна", async () => {
    const env = buildPanel({ settings: { firstRunSetup: "done" } });
    env.panel.wireSetupFolders();
    env.panel.wireSetupFolders();
    const row = env.el("btn-agent-files-open").parentNode;
    const buttons = row.children.filter((c) => c.id === "btn-setup-folders");
    assert.strictEqual(buttons.length, 1, "кнопок входа в окно получилось " + buttons.length);
    assert.ok(/Папки работы/.test(buttons[0].textContent), "кнопка подписана не по-человечески: " + buttons[0].textContent);
    buttons[0].onclick();
    await tick(); // состояние спрашивается у главного процесса — окно открывается после ответа
    assert.ok(!env.el("setup-overlay").classList.contains("hidden"), "кнопка не открыла окно выбора папок");
    // Открытое вручную окно — это смена выбора, а не первый запуск: вопрос уже отвечен.
    assert.ok(/Папки работы агента/.test(env.el("setup-title").textContent), "заголовок смены папок потерян: " + env.el("setup-title").textContent);
  });

  // ── Пути в ответах агента и в ленте ────────────────────────────────────────
  await test("ответ инструмента миссии называет настоящую папку, а не .agent/ по памяти", async () => {
    const wd = path.join(tmpDir("toolpath"), "project");
    fs.mkdirSync(wd, { recursive: true });
    const store = tmpDir("toolpathStore");
    installLayout({ missionsDir: store }, tmpDir("toolpathUserData"));

    // Собираем НАСТОЯЩИЙ дом инструментов миссий (src/agent-tools-mission.js) с
    // настоящим хранилищем: проверяем ответ агента, а не наличие строки в файле.
    const { createMissionTools } = require(path.join(ROOT, "src", "agent-tools-mission.js"));
    const tools = createMissionTools(
      {
        agentWorkDir: () => wd,
        missionStore: missionStore,
        normalizePlanTasks: () => [],
        planSummary: () => ({}),
        live: { activeEmit: () => null },
      },
      { activeRunMissionId: "", activeRunRole: "", activeRunChatId: "", activeEmit: () => null }
    );

    const created = missionStore.missionCreate(wd, { goal: "Разобрать входящие", steps: ["собрать письма"] });
    assert.strictEqual(created.ok, true, "миссия не создалась: " + created.error);
    const root = agentData.layout({ missionsDir: store }, wd, "/ud").missionsRoot;
    const realDir = path.join(root, "missions", created.mission.id);

    const status = await tools.missionStatus({}, {});
    assert.ok(status.indexOf(realDir) >= 0, "ответ не назвал настоящую папку миссии: " + status.slice(0, 200));
    assert.ok(status.indexOf(".agent/missions/") < 0, "ответ отправил агента в .agent/, которого рядом с проектом нет");

    const step = await tools.missionStep({ done: "собрать письма" }, {});
    assert.ok(step.indexOf(path.join(realDir, "journal.md")) >= 0, "журнал назван не там, где он лежит: " + step.slice(0, 200));

    const finish = await tools.missionFinish({ report: "готово" }, {});
    assert.ok(finish.indexOf(path.join(realDir, "report.md")) >= 0, "отчёт назван не там, где он лежит: " + finish.slice(0, 200));
    agentData.install(null);
  });

  await test("лента и ответы не вписывают путь миссии руками — его даёт раскладка", () => {
    // Сторож текстовый: у ленты прогона свой стенд (test/run-mission.test.js), и он
    // проверяет поведение. Здесь — предохранитель от возврата жёсткой приписки
    // «.agent/missions/…» в текст, который читает человек или модель: при выбранной
    // папке она ложна, а заметить это в приложении нечем.
    for (const f of ["agent-tools-mission.js", "run-mission.js", "run-batch.js"]) {
      const src = fs.readFileSync(path.join(ROOT, "src", f), "utf8");
      assert.ok(src.indexOf('\".agent/missions/') < 0, "в " + f + " путь миссии вписан руками вместо раскладки");
    }
    assert.ok(/missionsPathText/.test(fs.readFileSync(path.join(ROOT, "src", "agent-tools-mission.js"), "utf8")),
      "ответы инструментов миссии не спрашивают путь у раскладки");
    assert.ok(/folderText/.test(fs.readFileSync(path.join(ROOT, "src", "run-mission.js"), "utf8")),
      "лента прогона не спрашивает путь у раскладки");
  });

  agentData.install(null);
  console.log("\nПапки работы агента: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

/* Стенд панели настроек: настоящий модуль (src/renderer/settings-panel.js) на поддельном
   DOM. Проверяем поведение — каким каналом сохраняется выбор, что происходит с
   настройками окна и сколько раз задаётся вопрос, — а не наличие строк. */
const tick = () => new Promise((r) => setImmediate(r));

function buildPanel(opts) {
  const o = opts || {};
  const settings = o.settings || {};
  const calls = { saved: [], states: 0, toasts: [], esc: [], overlayClicks: [] };
  const els = new Map();
  const makeEl = (id) => {
    const e = {
      id: id,
      value: "",
      textContent: "",
      title: "",
      className: "",
      type: "",
      children: [],
      parentNode: null,
      onclick: null,
      listeners: {},
      classList: {
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
        contains() { return !!this.hidden; },
      },
      appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    };
    if (id) els.set(id, e);
    return e;
  };
  // Поиск элемента по id — как в окне: чего в разметке нет, того нет (а не
  // «создалось само»). Иначе проверка «кнопку добавляем, только если её нет»
  // проходила бы на любом поведении.
  const el = (id) => els.get(id);

  // Разметка, без которой окно не собирается: окно выбора папок и поля в нём.
  // Окно в разметке лежит СКРЫТЫМ — стенд обязан начинать так же.
  makeEl("setup-overlay").classList.add("hidden");
  makeEl("setup-title");
  makeEl("setup-text");
  makeEl("setup-hint");
  makeEl("setup-missions-dir");
  makeEl("setup-tasks-dir");
  makeEl("agent-files-status");
  makeEl("s-agent-files");
  makeEl("btn-setup-save");
  makeEl("btn-setup-skip");
  makeEl("btn-setup-missions-pick");
  makeEl("btn-setup-tasks-pick");
  makeEl("btn-setup-missions-clear");
  makeEl("btn-setup-tasks-clear");
  const row = makeEl("files-row");
  row.appendChild(makeEl("btn-agent-files-open"));
  row.appendChild(makeEl("btn-agent-files-clear"));

  global.document = {
    _keydown: [],
    _els: els,
    addEventListener(ev, fn) { if (ev === "keydown") this._keydown.push(fn); },
    createElement() { return makeEl(""); },
    querySelectorAll() { return []; },
  };
  global.window = o.mobile ? { __mobileBridge: true } : {};

  const api = {
    setupState: () => { calls.states++; return Promise.resolve({ ok: true, setupDone: false, missionsDir: settings.missionsDir || "", tasksDir: settings.tasksDir || "" }); },
    setupSave: (p) => {
      calls.saved.push(p || {});
      const r = { ok: true, missionsDir: p && p.missionsDir !== undefined ? p.missionsDir : settings.missionsDir || "", tasksDir: p && p.tasksDir !== undefined ? p.tasksDir : settings.tasksDir || "" };
      return Promise.resolve(r);
    },
    pickDirectory: () => Promise.resolve("/picked/dir"),
    agentFilesStatus: () => Promise.resolve({ enabled: true, exists: true, tasks: null, contextDays: [], missions: 0, bytes: 0, missionsRoot: "", missionsCustom: false, tasksRoot: "", tasksCustom: false, insideProject: false }),
  };
  const panel = require(path.join(ROOT, "src", "renderer", "settings-panel.js"))({
    $: el,
    api: api,
    isElectron: o.electron !== false,
    getSettings: () => settings,
    toast: (t) => calls.toasts.push(t),
    esc: (t) => String(t),
    persistSettings: () => {},
    setSettingsMsg: () => {},
    updateStatusBar: () => {},
    search: { active: () => false, reset: () => {} },
  });
  return {
    panel: panel,
    el: el,
    settings: settings,
    calls: calls,
    // Esc и клик мимо окна: обработчики сами подписаны при сборке окна.
    fireEsc: () => { for (const fn of global.document._keydown) fn({ key: "Escape" }); },
  };
}

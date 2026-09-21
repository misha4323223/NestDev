"use strict";
/* ─── Живой прогон проектов и быстрого запуска (превью) ──────────────────────
   Запуск: bun run test:live:projects   (node scripts/live-projects-preview.js)

   Зачем отдельный прогон. Наборы (test/projects-ipc.test.js,
   test/preview-ipc.test.js) собирают модули сами, с поддельными соседями — но они
   НЕ проверяют главного: что настоящий main.js собирает их на своём месте и с
   рабочими зависимостями. Ошибки тут тихие: сбросы «активного репозитория»,
   флага «только что склонирован» и снимков отката видно только по работе агента,
   а вывод dev-сервера — только в панели превью.

   Здесь всё настоящее: хранилище настроек на диске, настоящие живые значения
   оболочки (читаем их через мосты GitHub-каналов и реестра инструментов — это то
   же, что видит агент), настоящий запуск процесса dev-сервера и настоящее окно,
   созданное запуском.

   Разделы:
     [1] main.js сам собрал оба модуля и с рабочими зависимостями;
     [2] каналы проектов работают насквозь через настоящее хранилище;
     [3] переключение и удаление проекта сбрасывают живые значения — это видно
         через ЧУЖИЕ мосты (GitHub-каналы, реестр инструментов);
     [4] превью: настоящий запуск процесса, вывод в окно, остановка;
     [5] остановка при выходе приложения (before-quit) действительно убивает сервер;
     [6] ни один канал не пишет в папку приложения;
     [7] проводка ниже зависимостей, каналов в main.js не осталось;
     [8] освобождение порта: РАЗБОР настоящего lsof на настоящем слушателе —
         в «убитые» не попадают ни номер порта, ни 127.0.0.1 (убийца подставной,
         иначе ошибка разбора погасила бы посторонние процессы прямо в прогоне).

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-pp-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-pp-work-"));
const second = fs.mkdtempSync(path.join(os.tmpdir(), "live-pp-second-"));
const third = fs.mkdtempSync(path.join(os.tmpdir(), "live-pp-third-"));
const freePort = 5199;

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settingsFile = path.join(userData, "settings.json");
const readSettingsFile = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));

// Настройки — на диске: их прочитает настоящий loadSettings() внутри main.js.
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      workingDir: work,
      provider: "ollama",
      model: "live-model",
      previewUrl: "http://localhost:" + freePort,
      projects: [
        { id: "p-old", name: "старый", dir: second, lastOpened: 100 },
        { id: "p-active", name: "активный", dir: work, lastOpened: 200 },
      ],
      activeProjectId: "p-active",
    },
    null,
    2
  )
);

const handlers = new Map();
const listeners = new Map();
const appHandlers = new Map();
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

// Перехватываем сборку модулей: видим, с чем их позвал НАСТОЯЩИЙ main.js.
// GitHub-каналы и реестр инструментов нужны отдельно: через их мосты читаются живые
// значения оболочки («активный репозиторий», флаг клона, снимки отката) — те же,
// что видит агент.
const seen = { projects: 0, projectsDeps: null, preview: 0, previewDeps: null, shutdownCalls: 0, githubDeps: null, toolsDeps: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: (ev, fn) => appHandlers.set(ev, fn),
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.187",
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
  if (t.indexOf("projects-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerProjectsIpc: (deps) => {
        seen.projects++;
        seen.projectsDeps = deps;
        return real.registerProjectsIpc(deps);
      },
    };
  }
  if (t.indexOf("preview-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerPreviewIpc: (deps) => {
        seen.preview++;
        seen.previewDeps = deps;
        const api = real.registerPreviewIpc(deps);
        // Считаем вызовы остановки: так живой прогон видит, что оболочка ЗОВЁТ
        // devShutdown при выходе (сам процесс всё равно остановится и общим
        // закрытием фоновых процессов, поэтому счётчик — единственный способ
        // различить эти две причины).
        const shutdown = api.devShutdown;
        api.devShutdown = () => {
          seen.shutdownCalls++;
          return shutdown();
        };
        return api;
      },
    };
  }
  if (t.indexOf("github-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerGithubIpc: (deps) => {
        seen.githubDeps = deps;
        return real.registerGithubIpc(deps);
      },
    };
  }
  if (t.indexOf("agent-tools") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolsDeps = deps;
        return real.createAgentTools(deps);
      },
    };
  }
  return origin.apply(this, arguments);
};
// Фоновые отказы main.js прогон не роняют, а падение САМОГО прогона обязано быть
// громким: иначе «молчаливый ноль» в цепочке тестов выглядел бы успехом.
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 90 секунд");
  process.exit(1);
}, 90000);
watchdog.unref();

(async () => {
  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон проектов и превью (настоящий main.js без окна)");
  await sleep(500);

  const call = (ch, ...args) => handlers.get(ch)(null, ...args);
  const win = windows[0];
  const repoDir = seen.githubDeps.live;
  const undoLive = seen.toolsDeps.live;

  console.log("\n[1] настоящий main.js сам собрал оба модуля — и с рабочими зависимостями");
  ok(seen.projects === 1, "registerProjectsIpc вызван main.js " + seen.projects + " раз(а)");
  ok(seen.preview === 1, "registerPreviewIpc вызван main.js " + seen.preview + " раз(а)");
  const pd = seen.projectsDeps;
  const vd = seen.previewDeps;
  ok(!!pd && typeof pd.loadSettings === "function" && typeof pd.saveSettings === "function", "настройки проектов пришли функциями");
  ok(!!pd && typeof pd.ensureWritableDir === "function", "проверка папки пришла настоящей функцией");
  ok(!!pd && !!pd.live && typeof pd.live.setLastAgentRepoDir === "function", "«активный репозиторий» приходит сеттером");
  ok(!!pd && typeof pd.live.setClonedRepoPending === "function" && typeof pd.live.setActiveRunUndo === "function", "флаг клона и снимки отката приходят сеттерами");
  ok(!!vd && typeof vd.bgSpawn === "function" && typeof vd.bgKill === "function", "запуск процессов пришёл настоящим");
  ok(!!vd && typeof vd.killProcessesOnPort === "function" && typeof vd.parsePortFromUrl === "function", "освобождение порта пришло настоящим");
  ok(!!vd && typeof vd.stripAnsi === "function" && typeof vd.sanitizeDir === "function" && typeof vd.agentWorkDir === "function", "обрезка вывода, папки и рабочая папка пришли настоящими");
  ok(!!vd && typeof vd.getWindow === "function" && vd.getWindow() === win, "окно приходит мостом и это окно запуска");
  ok(!!seen.toolsDeps && typeof undoLive.activeRunUndo === "function", "реестр инструментов даёт читать снимки отката");
  ok(typeof repoDir.lastAgentRepoDir === "function" && typeof repoDir.clonedRepoPending === "function", "GitHub-каналы дают читать живые значения репозитория");

  console.log("\n[2] каналы проектов работают насквозь через настоящее хранилище");
  for (const ch of ["projects:list", "projects:create", "projects:activate", "projects:remove", "dev:start", "dev:stop", "dev:status"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
  }
  const list = await handlers.get("projects:list")();
  ok(list.ok === true && list.activeId === "p-active", "активный проект из настроек: " + list.activeId);
  ok(list.projects[0].id === "p-active", "список отсортирован по свежести");
  const created = await call("projects:create", "новый", third);
  ok(created.ok === true, "проект создан: " + JSON.stringify(created.error || created.project.name));
  ok(readSettingsFile().activeProjectId === created.project.id, "новый проект лёг в настройки на диске активным");
  ok(readSettingsFile().workingDir === fs.realpathSync(third) || readSettingsFile().workingDir === third, "рабочая папка в настройках — папка нового проекта: " + readSettingsFile().workingDir);
  const dup = await call("projects:create", "дубль", third);
  ok(dup.ok === false && /уже используется/.test(dup.error), "вторая папка того же проекта отклонена");
  // Проверка «можно ли писать» приходит сюда из модуля путей (src/paths-git.js) и
  // делает НАСТОЯЩУЮ пробу записи: папки проекта ещё нет на диске — канал обязан
  // её создать и НЕ оставить пробную подпапку в папке пользователя.
  const freshDir = path.join(work, "проект-с-нуля");
  ok(!fs.existsSync(freshDir), "стенд: папки нового проекта на диске ещё нет");
  const fresh = await call("projects:create", "с нуля", freshDir);
  ok(fresh.ok === true, "проект в несуществующей папке создан: " + JSON.stringify(fresh.error));
  ok(fs.existsSync(freshDir), "канал не создал папку проекта на диске — клон и запись файлов упадут");
  ok(fs.readdirSync(freshDir).length === 0, "пробная подпапка проверки записи осталась в папке проекта: " + JSON.stringify(fs.readdirSync(freshDir)));
  // Недоступное место (путь под ФАЙЛОМ): отказ обязан дойти до человека ПРИЧИНОЙ,
  // а не всплыть позже как «git не работает».
  fs.writeFileSync(path.join(work, "файл-не-папка"), "x");
  const bad = await call("projects:create", "некуда", path.join(work, "файл-не-папка", "проект"));
  ok(bad.ok === false, "недоступная папка принята как рабочая");
  ok(/Не удалось создать папку/.test(bad.error || ""), "в отказе нет причины и пути: " + bad.error);

  console.log("\n[3] переключение и удаление проекта сбрасывают живые значения (видно через чужие мосты)");
  repoDir.setLastAgentRepoDir("/tmp/live-clone");
  repoDir.setClonedRepoPending(true);
  undoLive.setActiveRunUndo([{ path: "/tmp/live-clone/file.js" }]);
  ok(repoDir.lastAgentRepoDir() === "/tmp/live-clone" && repoDir.clonedRepoPending() === true, "стенд выставил живые значения (иначе проверки ниже пустые)");
  const act = await call("projects:activate", "p-old");
  ok(act.ok === true && act.project.dir === second, "проект переключился на свой каталог");
  ok(repoDir.lastAgentRepoDir() === null, "переключение сбросило «активный репозиторий»");
  ok(repoDir.clonedRepoPending() === false, "переключение сбросило флаг «только что склонирован»");
  ok(undoLive.activeRunUndo().length === 0, "переключение очистило снимки отката прошлого проекта");
  ok(readSettingsFile().githubRepoDir === "", "локальная папка выбранного репозитория сброшена");
  // Удаление АКТИВНОГО проекта: следующий становится активным, и сбросы обязаны быть теми же.
  repoDir.setLastAgentRepoDir("/tmp/live-clone-2");
  repoDir.setClonedRepoPending(true);
  undoLive.setActiveRunUndo([{ path: "/tmp/live-clone-2/file.js" }]);
  const removed = await call("projects:remove", "p-old");
  const afterRemove = readSettingsFile();
  ok(removed.ok === true && removed.activeId !== "", "активным стал следующий проект: " + removed.activeId);
  ok(afterRemove.workingDir !== second, "рабочая папка ушла из удалённого проекта: " + afterRemove.workingDir);
  ok(afterRemove.workingDir === (afterRemove.projects.find((p) => p.id === removed.activeId) || {}).dir, "рабочая папка совпадает с папкой активного проекта");
  ok(repoDir.lastAgentRepoDir() === null, "удаление активного проекта не оставило агента в папке удалённого");
  ok(repoDir.clonedRepoPending() === false, "флаг «только что склонирован» не уехал в новый проект");
  ok(undoLive.activeRunUndo().length === 0, "снимки отката удалённого проекта не остались");
  // Удаление НЕактивного проекта ничего не сбрасывает.
  repoDir.setLastAgentRepoDir("/tmp/live-clone-3");
  const removed2 = await call("projects:remove", (readSettingsFile().projects.find((p) => p.id !== readSettingsFile().activeProjectId) || {}).id);
  ok(removed2.ok === true, "неактивный проект не удалился");
  ok(repoDir.lastAgentRepoDir() === "/tmp/live-clone-3", "удаление неактивного проекта папку агента не тронуло");

  console.log("\n[4] превью: настоящий запуск процесса, вывод в окно, остановка");
  // Процесс печатает строку и живёт, пока его не остановят: иначе проверка
  // «статус сбросился после остановки» проходила бы на естественном выходе сервера.
  const cmd = 'node -e "console.log(\'preview-alive\'); setInterval(function(){}, 1000)"';
  win.webContents.sent.length = 0;
  const started = await call("dev:start", work, cmd);
  ok(started.ok === true, "сервер запущен: " + JSON.stringify(started.error || started.command));
  const running = await call("dev:status", work);
  ok(running.running === true, "статус видит запущенный сервер");
  ok(running.command === cmd && running.cwd === work, "статус помнит команду и папку проекта");
  const again = await call("dev:start", work, cmd);
  ok(again.ok === false && /уже запущен/.test(again.error), "второй сервер на том же порту отвергнут");
  let outs = [];
  for (let i = 0; i < 20 && !outs.length; i++) {
    await sleep(150);
    outs = win.webContents.sent.filter((s) => s.ch === "dev:event" && s.ev.type === "out").map((s) => s.ev.text);
  }
  ok(outs.some((t) => t.indexOf("preview-alive") >= 0), "вывод сервера дошёл до окна: " + JSON.stringify(outs).slice(0, 120));
  const stopped = await call("dev:stop");
  ok(stopped.ok === true, "сервер остановлен: " + JSON.stringify(stopped));
  ok((await call("dev:status", work)).running === false, "статус сбросился после остановки");
  ok(stopped.stopped.join(" ").indexOf("dev:") >= 0, "человеку сказано, что именно остановлено: " + JSON.stringify(stopped.stopped));

  console.log("\n[5] остановка при выходе приложения действительно убивает сервер");
  const started2 = await call("dev:start", work, cmd);
  ok(started2.ok === true, "сервер снова запущен для проверки выхода");
  ok((await call("dev:status", work)).running === true, "он действительно работает");
  ok(typeof appHandlers.get("before-quit") === "function", "main.js подписал выход приложения");
  const callsBefore = seen.shutdownCalls;
  appHandlers.get("before-quit")();
  ok(seen.shutdownCalls === callsBefore + 1, "выход приложения зовёт devShutdown (мост на месте)");
  // Живёт он сам — ждать его естественного выхода бессмысленно: проверяем сразу.
  await sleep(200);
  ok((await call("dev:status", work)).running === false, "dev-сервер остановлен выходом приложения (порт не держит)");

  console.log("\n[6] ни один канал не пишет в папку приложения");
  const appFilesAfter = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  ok(appFilesBefore === appFilesAfter, "папка src не изменилась после работы каналов");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")), "настройки не легли в папку приложения");

  console.log("\n[7] проводка стоит ниже зависимостей, а каналов в main.js не осталось");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(mainSrc.indexOf("createSettingsStore({") < mainSrc.indexOf('require("./projects-ipc.js")'), "модуль проектов собран после хранилища настроек");
  ok(mainSrc.indexOf('require("./paths-git.js")') < mainSrc.indexOf('require("./projects-ipc.js")'), "модуль проектов собран после путей и git");
  ok(mainSrc.indexOf("new MobileBridge(") < mainSrc.indexOf('require("./projects-ipc.js")'), "модуль проектов собран после мобильного моста");
  ok(mainSrc.indexOf("createBgProcesses({") < mainSrc.indexOf('require("./preview-ipc.js")'), "модуль превью собран после фоновых процессов");
  ok(mainSrc.indexOf("createTerminalPanel({") < mainSrc.indexOf('require("./preview-ipc.js")'), "модуль превью собран после терминала");
  ok(mainSrc.indexOf("let mainWindow = null;") < mainSrc.indexOf('require("./preview-ipc.js")'), "модуль превью собран после объявления окна");
  ok(!/ipcMain\.(handle|on)\("(projects|dev):/.test(mainSrc), "в main.js не осталось каналов проектов и превью");

  console.log("\n[8] освобождение порта: разбор настоящего lsof не путает порт и 127.0.0.1");
  // Находка живой проверки части 31: раньше из вывода lsof брались ВСЕ числа, поэтому
  // в «убитые» попадали номер порта и 127.0.0.1, и «⏹ Остановить» на macOS/Linux мог
  // погасить посторонний процесс. Здесь настоящий lsof, настоящий слушатель и НАСТОЯЩИЙ
  // разбор, но убийца подставной — сигналы никуда не уходят, пока разбор не сойдётся.
  const { createBgProcesses } = require(path.join(ROOT, "src", "bg-processes.js"));
  const cp = require("child_process");
  const realRun = (cmd, cwd, ms) =>
    new Promise((resolve) => {
      cp.execFile("/bin/sh", ["-c", cmd], { cwd: cwd || os.homedir(), timeout: ms || 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve(String(stdout || "") + String(stderr || "") + (err && !stdout && !stderr ? String(err.message) : ""))
      );
    });
  const killCalls = [];
  const parser = createBgProcesses({
    spawn: cp.spawn,
    os,
    stripAnsi: (s) => String(s).replace(/\u001b\[[0-9;]*m/g, ""),
    shellArgsFor: (c) => ["-c", c],
    commandEnv: () => ({}),
    runTerminalCommand: realRun,
    killPid: (pid) => killCalls.push(pid),
  });
  const lsPort = 5221;
  const listener = cp.spawn(process.execPath, ["-e", "require('net').createServer().listen(" + lsPort + ", '127.0.0.1')"]);
  try {
    let busy = false;
    for (let i = 0; i < 40 && !busy; i++) {
      busy = await new Promise((r) => {
        const s = require("net").connect(lsPort, "127.0.0.1");
        s.on("connect", () => { s.destroy(); r(true); });
        s.on("error", () => r(false));
      });
      if (!busy) await sleep(100);
    }
    ok(busy, "настоящий слушатель занял порт " + lsPort + " (PID " + listener.pid + ")");
    const raw = await realRun("lsof -ti tcp:" + lsPort + " 2>/dev/null || fuser " + lsPort + "/tcp 2>/dev/null");
    const r = await parser.killProcessesOnPort(lsPort);
    const nums = r.killed.map(String);
    ok(raw.indexOf(String(listener.pid)) >= 0, "система видит слушателя: " + JSON.stringify(String(raw).trim().split("\n").slice(0, 2)));
    ok(nums.indexOf(String(listener.pid)) >= 0, "слушатель попал в «убитые»: " + JSON.stringify(nums));
    ok(nums.indexOf(String(lsPort)) < 0, "номер порта не принят за процесс: " + JSON.stringify(nums));
    ok(nums.indexOf("127") < 0 && nums.indexOf("1") < 0, "адрес 127.0.0.1 не принят за процессы: " + JSON.stringify(nums));
    ok(killCalls.length === nums.length && killCalls.every((n) => Number(n) > 1), "подставному убийце ушли только настоящие PID: " + JSON.stringify(killCalls));
  } finally {
    try { listener.kill("SIGKILL"); } catch {}
  }

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

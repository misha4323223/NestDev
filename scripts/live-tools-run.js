"use strict";
/* ─── Живой прогон команд, оболочки и фоновых процессов (без окна) ────────────
   Запуск: bun run test:live:tools-run   (node scripts/live-tools-run.js)

   Зачем этот прогон. Пятнадцать обработчиков (shellsStatus, runCommand,
   runCommandOutput, runCommandAsAdmin, runScript, startBackground, listBackground,
   backgroundOutput, sendInput, stopBackground, shellStart, shellSend, waitUntil,
   timeoutCommand, retryCommand) уехали своим модулем (часть 40, заход 4). Эти
   инструменты РАБОТАЮТ С ЖИВОЙ МАШИНОЙ: запускают процессы, держат порты, убивают
   деревья процессов. Текстовый сторож здесь не значит ничего — проверять надо
   настоящим запуском.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-run.js;
     • настоящие команды оболочки, настоящие фоновые процессы (их видно в списке
       процессов и в живом PID), настоящий вывод, настоящая остановка.

   Проверки:
     [1] проводка: модуль собран один раз с тем же объектом состояния;
     [2] shellsStatus: список оболочек этой машины и выбор оболочки;
     [3] runCommand: настоящая команда, каталог, отказы, подсказка про dev-сервер,
         и ТАЙМАУТ ГАСИТ ВСЁ ДЕРЕВО (проверка по живым процессам, а не по тексту);
     [4] startBackground / listBackground / backgroundOutput / stopBackground:
         живой процесс, его вывод, его PID и настоящая остановка;
     [5] shellStart / shellSend: постоянная сессия сохраняет состояние между командами;
     [6] runCommandOutput: сбор вывода, маркер готовности и ветка dev-сервера;
     [7] timeoutCommand и retryCommand: лимит времени, повторы, объяснение кода;
     [8] runScript и waitUntil: настоящий скрипт из package.json и настоящее ожидание.

   Свои процессы прогон останавливает сам (иначе следующий запуск упрётся в порт).
   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// Процессы-заглушки ЭТОГО прогона, которые остались жить (ищем по своему каталогу в /proc).
const myLeftovers = () => {
  let rows = [];
  try { rows = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).split("\n"); } catch { return []; }
  const pids = rows
    .filter((l) => /node server\.js\s*$/.test(l))
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isInteger(n) && n > 0);
  return pids.filter((pid) => {
    try { return fs.realpathSync("/proc/" + pid + "/cwd") === work; } catch { return false; }
  });
};
const info = (msg) => console.log("  · " + msg);

// Файлы прогона: скрипт-сервер (живёт, пока его не остановят) и package.json со скриптом.
fs.writeFileSync(path.join(work, "server.js"), "console.log('сервер готов');\nsetInterval(() => {}, 1000);\n", "utf8");
fs.writeFileSync(
  path.join(work, "package.json"),
  JSON.stringify({ name: "прогон", version: "1.0.0", scripts: { hello: 'node -e "console.log(\'скрипт ок\')"' } }, null, 2),
  "utf8"
);

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

// ── Перехват: видим, кто кого собрал и с чем ───────────────────────────────
const seenWiring = { run: 0, runDeps: null, runArgs: 0, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.196", setName: () => {}, setAppUserModelId: () => {},
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
  if (/agent-tools-run\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createRunTools: function (deps) {
        seenWiring.run++;
        seenWiring.runDeps = deps;
        seenWiring.runArgs = arguments.length;
        return real.createRunTools(deps);
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
  console.error("❌ Живой прогон не завершился за 180 секунд");
  process.exit(1);
}, 180000);
watchdog.unref();

// Процессы, которые прогон поднял сам: их надо погасить в любом случае.
const started = new Set();
const stopAll = async () => {
  for (const id of started) {
    try { await seenWiring.api.executeTool("stopBackground", { id }, seenWiring.toolDeps.loadSettings()); } catch {}
  }
  started.clear();
};

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон команд, оболочки и фоновых процессов (настоящий main.js, настоящие процессы)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);

  try {
    console.log("\n[1] проводка: модуль собран один раз с тем же состоянием");
    ok(seenWiring.run === 1, "createRunTools вызван " + seenWiring.run + " раз(а)");
    ok(seenWiring.runDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
    ok(seenWiring.runArgs === 1, "модулю передан только deps (живого моста этим инструментам не нужно): аргументов " + seenWiring.runArgs);
    const names = ["shellsStatus", "runCommand", "runCommandOutput", "runCommandAsAdmin", "runScript", "startBackground",
      "listBackground", "backgroundOutput", "sendInput", "stopBackground", "shellStart", "shellSend", "waitUntil",
      "timeoutCommand", "retryCommand"];
    const missing = names.filter((n) => typeof seenWiring.tools[n] !== "function");
    ok(missing.length === 0, "все пятнадцать инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));

    console.log("\n[2] shellsStatus: оболочки этой машины");
    const shells = plain(await call("shellsStatus", {}));
    ok(/Оболочки на этой машине/.test(shells), "список оболочек отдан: " + shells.split("\n")[0].slice(0, 70));
    ok(/По умолчанию команды идут в (sh|cmd)/.test(shells), "сказано, куда идут команды по умолчанию");
    ok(/shell у runCommand и startBackground/.test(shells), "сказано, чем выбирать оболочку");
    ok(/✅|❌/.test(shells), "у каждой оболочки есть состояние (найдена/нет)");

    console.log("\n[3] runCommand: настоящая команда и отказы");
    const echo = plain(await call("runCommand", { command: "echo привет-прогон" }));
    ok(/привет-прогон/.test(echo), "вывод настоящей команды доехал: " + echo.split("\n").slice(0, 2).join(" | ").slice(0, 90));
    ok(echo.indexOf(work) >= 0, "назван рабочий каталог: " + work);
    const noCmd = plain(await call("runCommand", {}));
    ok(/укажи команду/.test(noCmd), "пустая команда объяснена");
    const badShell = plain(await call("runCommand", { command: "echo x", shell: "такойНет" }));
    ok(/неизвестная оболочка/.test(badShell) && /cmd, powershell, pwsh, bash, sh/.test(badShell), "негодная оболочка названа вместе со списком: " + badShell.slice(0, 80));
    // Длительный dev-сервер через runCommand: команда не завершается сама — инструмент
    // обязан не молчать, а объяснить, что для такого есть startBackground.
    const stuck = plain(await call("runCommand", { command: "node server.js", timeoutMs: 1500 }));
    ok(/кодом таймаут/.test(stuck), "таймаут назван: " + stuck.split("\n").slice(0, 3).join(" | ").slice(0, 90));
    ok(/startBackground\(/.test(stuck) && /НЕ жди завершения сервера/.test(stuck), "подсказан startBackground, а не молчание");
    // Таймаут обязан погасить ДЕРЕВО, а не одну оболочку (часть 40, заход 4.1).
    // Раньше здесь стоял execFile, который молча теряет `detached`: своей группы
    // процессов у команды не было, ребёнок (сервер) оставался жив и держал порт,
    // а в фоновых процессах его не было — остановить его агенту было нечем.
    // Проверка настоящая: смотрим факт по процессам, а не по тексту ответа.
    await sleep(1600); // догоняющему SIGKILL нужно ~1.2 с после SIGTERM
    const leaked = myLeftovers();
    for (const pid of leaked) { try { process.kill(pid, "SIGKILL"); } catch {} }
    ok(
      leaked.length === 0,
      "после таймаута runCommand детей оболочки не осталось" + (leaked.length ? ": живо " + leaked.length + " (" + leaked.join(", ") + ") — держат порт" : "")
    );

    console.log("\n[4] фоновый процесс: запуск, вывод, PID, остановка");
    const startedBg = plain(await call("startBackground", { command: "node server.js", name: "прогон-сервер" }));
    ok(/OK — фоновый процесс запущен/.test(startedBg), "процесс запущен: " + startedBg.split("\n")[0]);
    const id = (startedBg.match(/id: ([^\n]+)/) || [])[1];
    const pid = Number((startedBg.match(/PID: (\d+)/) || [])[1]);
    ok(!!id, "назван id процесса: " + id);
    ok(pid > 0 && alive(pid), "процесс действительно жив (PID " + pid + ")");
    if (id) started.add(id);
    const list = plain(await call("listBackground", {}));
    ok(list.indexOf(id) >= 0 && /работает/.test(list), "процесс виден в списке как работающий");
    // Вывод появляется не мгновенно: ждём маркер, а не «правильное время».
    let out = "";
    for (let i = 0; i < 20; i++) {
      out = plain(await call("backgroundOutput", { id }));
      if (/сервер готов/.test(out)) break;
      await sleep(150);
    }
    ok(/сервер готов/.test(out), "вывод процесса прочитан: " + out.replace(/\n/g, " | ").slice(0, 80));
    ok(/РАБОТАЕТ \(PID \d+\)/.test(out), "состояние процесса названо вместе с PID");
    const noId = plain(await call("backgroundOutput", { id: "нет-такого" }));
    ok(/не найден/.test(noId) && /listBackground/.test(noId), "чужой id объяснён со ссылкой на список");
    const stopped = plain(await call("stopBackground", { id }));
    ok(/остановлен/.test(stopped), "процесс остановлен: " + stopped.slice(0, 60));
    started.delete(id);
    await sleep(400);
    ok(!alive(pid), "PID " + pid + " действительно мёртв (порт освобождён)");

    console.log("\n[5] shellStart / shellSend: состояние сессии сохраняется");
    const shell = plain(await call("shellStart", { name: "прогон-shell" }));
    ok(/shell-сессия запущена/.test(shell), "сессия запущена: " + shell.split("\n")[0]);
    const sid = (shell.match(/id: ([^\n]+)/) || [])[1];
    if (sid) started.add(sid);
    // Имя переменной — ASCII: POSIX-оболочка считает кириллическое имя командой, и
    // проверка ловила бы ошибку самой проверки, а не состояния сессии.
    const first = plain(await call("shellSend", { id: sid, command: "PROGON_VAR=42" }));
    ok(/PROGON_VAR=42/.test(first) && !/not found/.test(first), "команда принята сессией без ошибки: " + first.replace(/\n/g, " | ").slice(0, 70));
    const second = plain(await call("shellSend", { id: sid, command: "echo значение=$PROGON_VAR" }));
    ok(/значение=42/.test(second), "состояние сессии сохранилось между командами: " + second.replace(/\n/g, " | ").slice(0, 90));
    const shellNoId = plain(await call("shellSend", { id: "нет-сессии", command: "echo x" }));
    ok(/не найдена/.test(shellNoId) && /shellStart/.test(shellNoId), "чужая сессия объяснена со ссылкой на shellStart");
    await call("stopBackground", { id: sid });
    started.delete(sid);

    console.log("\n[6] runCommandOutput: сбор вывода, маркер и ветка dev-сервера");
    const simple = plain(await call("runCommandOutput", { command: 'node -e "console.log(\'вывод-ок\')"' }));
    ok(/вывод-ок/.test(simple) && /попыток: 1/.test(simple), "вывод собран с первой попытки: " + simple.split("\n").slice(0, 2).join(" | ").slice(0, 80));
    const marked = plain(await call("runCommandOutput", { command: 'node -e "console.log(\'маркер-готовности\')"', waitFor: "маркер-готовности" }));
    ok(/появился текст «маркер-готовности»/.test(marked), "маркер готовности найден: " + marked.split("\n").slice(0, 3).join(" | ").slice(0, 90));
    const dev = plain(await call("runCommandOutput", { command: "node server.js", waitFor: "сервер готов" }));
    ok(/похожа на длительный dev-сервер/.test(dev) && /в фоне БЕЗ ожидания завершения/.test(dev), "dev-сервер ушёл в фон: " + dev.split("\n")[0].slice(0, 80));
    ok(/✅ в выводе появился маркер «сервер готов»/.test(dev), "готовность сервера дождались по маркеру");
    const devId = (dev.match(/id: ([^\n]+)/) || [])[1];
    if (devId) started.add(devId);
    await call("stopBackground", { id: devId });
    started.delete(devId);
    await sleep(400);
    info("после остановки dev-сервера процессов-заглушек живо: " + myLeftovers().length);

    console.log("\n[7] timeoutCommand и retryCommand");
    const quick = plain(await call("timeoutCommand", { command: 'node -e "console.log(\'быстро\')"' }));
    ok(/быстро/.test(quick) && /лимит \d+ мс/.test(quick), "быстрая команда отдана с названным лимитом: " + quick.split("\n")[0].slice(0, 70));
    const slow = plain(await call("timeoutCommand", { command: 'node -e "setTimeout(()=>{}, 8000)"', timeoutMs: 1200 }));
    ok(/не уложилась в \d+ мс и остановлена принудительно/.test(slow), "таймаут назван, команда остановлена: " + slow.split("\n")[0].slice(0, 80));
    ok(/Увеличь timeoutMs или разбей команду/.test(slow), "сказано, что делать с таймаутом");
    const failed = plain(await call("timeoutCommand", { command: 'node -e "process.exit(4)"' }));
    ok(/Команда упала \(код 4\)/.test(failed) && /Объяснение: /.test(failed), "код возврата объяснён: " + failed.split("\n")[0].slice(0, 70));
    const retried = plain(await call("retryCommand", { command: 'node -e "process.exit(5)"', maxRetries: 1, pauseMs: 200 }));
    ok(/Не удалось после 2 попыток/.test(retried) && /попытка #1/.test(retried) && /попытка #2/.test(retried), "обе попытки видны в ответе");
    ok(/Объяснение: /.test(retried), "у повторов есть объяснение кода");
    const retryOk = plain(await call("retryCommand", { command: 'node -e "console.log(\'успех-повтора\')"' }));
    ok(/успех с попытки #1/.test(retryOk) && /успех-повтора/.test(retryOk), "успешная команда не повторяется зря");

    console.log("\n[8] runScript и waitUntil");
    const script = plain(await call("runScript", { scriptName: "hello" }));
    ok(/скрипт ок/.test(script), "настоящий скрипт из package.json выполнен: " + script.split("\n").slice(0, 2).join(" | ").slice(0, 90));
    const noScript = plain(await call("runScript", { scriptName: "нет-такого" }));
    ok(/Скрипта «нет-такого» нет/.test(noScript) && /hello/.test(noScript), "отсутствующий скрипт назван вместе со списком: " + noScript.slice(0, 90));
    const noName = plain(await call("runScript", {}));
    ok(/укажи scriptName/.test(noName), "скрипт без имени объяснён");
    const t0 = Date.now();
    const waited = plain(await call("waitUntil", { seconds: 1, reason: "проверка ожидания" }));
    const elapsed = Date.now() - t0;
    ok(/подождал 1 с/.test(waited) && /проверка ожидания/.test(waited), "ожидание отчиталось: " + waited.slice(0, 70));
    ok(elapsed >= 900, "ожидание было настоящим (" + elapsed + " мс), а не на словах");

    console.log("\n[9] runCommandAsAdmin: без прав — честный отказ, а не молчание");
    const admin = plain(await call("runCommandAsAdmin", { command: "echo x" }));
    ok(/администрат|pkexec|sudo|UAC|Не удалось/i.test(admin), "отказ или отчёт по правам назван честно: " + admin.split("\n")[0].slice(0, 90));
  } finally {
    await stopAll();
    // Гигиена прогона: гасим всё, что осталось от заглушек, и говорим, сколько было.
    await sleep(500);
    const rest = myLeftovers();
    for (const pid of rest) { try { process.kill(pid, "SIGKILL"); } catch {} }
    if (rest.length) info("погашено заглушек после прогона: " + rest.length + " (след находки про таймаут)");
  }

  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки команд и оболочки пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  await stopAll();
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

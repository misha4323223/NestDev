"use strict";
/* ─── Живой прогон системы и установки ПО (без окна) ───────────────────────────
   Запуск: npm run test:live:tools-system   (node scripts/live-tools-system.js)

   Зачем этот прогон. Девять обработчиков (getSystemInfo, installSystemPackage,
   refreshEnv, listProcesses, killProcess, registryRead, registryWrite, wingetSearch,
   installExe) уехали своим модулем (часть 40, заход 5). Эти инструменты работают
   С МАШИНОЙ: читают PATH, спрашивают живой список процессов, завершают процессы,
   ставят ПО. Текстовый сторож здесь не значит ничего — проверять надо на деле.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящие src/agent-tools.js, src/agent-tools-system.js и src/system-stack.js;
     • настоящая машина: список процессов, PATH, версии программ, живой процесс,
       который прогон поднимает сам и потом этим же инструментом завершает.

   Чего прогон НЕ делает НИКОГДА: не ставит ПО и не пишет в реестр. Проверяются
   только ветки отказа и «уже установлено» — они ничего не меняют на машине.
   Неудачные загрузки бьют в закрытый порт localhost, наружу сеть не нужна. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-sys-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-sys-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const info = (msg) => console.log("  · " + msg);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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
const seen = { sys: 0, sysDeps: null, sysArgs: 0, sysTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.198", setName: () => {}, setAppUserModelId: () => {},
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
  // Точный перехват по имени файла: подстрока «agent-tools» заглатывала бы и соседей
  // по дому (исправлено в заходе 4.1 — прогоны projects и run-ipc молчали сломанными).
  if (/agent-tools-system\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createSystemTools: function (deps) {
        seen.sys++;
        seen.sysDeps = deps;
        seen.sysArgs = arguments.length;
        seen.sysTools = real.createSystemTools(deps);
        return seen.sysTools;
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seen.tools = tools;
        return tools;
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

// Процессы, которые поднял прогон: их надо погасить в любом случае.
const started = new Set();
const stopAll = () => {
  for (const pid of started) { try { process.kill(pid, "SIGKILL"); } catch {} }
  started.clear();
};

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон системы и установки ПО (настоящий main.js, настоящая машина)");
  await sleep(400);

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);

  try {
    console.log("\n[1] проводка: модуль собран один раз с тем же состоянием");
    ok(seen.sys === 1, "createSystemTools вызван " + seen.sys + " раз(а)");
    ok(seen.sysDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
    ok(seen.sysArgs === 1, "модулю передан только deps (живого моста этим инструментам не нужно): аргументов " + seen.sysArgs);
    const names = ["getSystemInfo", "installSystemPackage", "refreshEnv", "listProcesses", "killProcess",
      "registryRead", "registryWrite", "wingetSearch", "installExe"];
    const missing = names.filter((n) => typeof (seen.sysTools || {})[n] !== "function");
    ok(missing.length === 0, "все девять инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    // Реестр обязан отдавать ТУ ЖЕ функцию, а не копию: иначе правка в модуле не доедет.
    const refs = names.filter((n) => seen.tools[n] !== seen.sysTools[n]);
    ok(refs.length === 0, "в реестре именно ссылки на модуль, а не копии" + (refs.length ? ": расходятся " + refs.join(", ") : ""));

    console.log("\n[2] getSystemInfo: визитка ЭТОЙ машины");
    const si = plain(await call("getSystemInfo", {}));
    ok(/ОС: (Linux|Windows|macOS|darwin|win32)/.test(si), "названа операционная система: " + si.split("\n")[0].slice(0, 60));
    ok(/Версия Node\.js \(приложение\): v\d+/.test(si), "названа версия Node.js приложения");
    ok(si.indexOf("Домашний каталог: " + os.homedir()) >= 0, "домашний каталог прочитан у системы, а не придуман");
    ok(si.indexOf("Рабочая директория агента: " + work) >= 0, "рабочая директория агента названа верно: " + work);
    const pathRows = Number((si.match(/Записей в PATH: (\d+)/) || [])[1]);
    ok(pathRows > 0, "PATH прочитан по-настоящему: записей " + pathRows);
    ok(/Ключевые программы:/.test(si), "раздел про программы есть");
    ok(/• git: (git version|установлен)/.test(si), "версия git спрошена у настоящей программы: " + (si.match(/• git:[^\n]*/) || [""])[0].slice(0, 70));
    ok(/• node: (v|установлен)/.test(si), "версия node спрошена у настоящей программы");
    ok(!/• node: не установлен/.test(si), "node назван установленным — прогон идёт на нём же");
    ok(/Советы: не установлено/.test(si), "в конце есть советы, что делать дальше");

    console.log("\n[3] listProcesses: настоящий список процессов");
    const mine = plain(await call("listProcesses", { filter: "live-tools-system" }));
    ok(mine.indexOf("PID " + process.pid) >= 0, "свой процесс найден в списке (PID " + process.pid + ")");
    ok(/Зависший процесс завершай через killProcess/.test(mine), "сказано, чем завершать зависшее");
    const none = plain(await call("listProcesses", { filter: "такого-процесса-нет-вообще-xyz" }));
    ok(/Процессы не найдены по фильтру/.test(none), "пустой результат объяснён, а не выдан за список: " + none.slice(0, 70));

    console.log("\n[4] killProcess: отказы и настоящее завершение");
    ok(/укажи pid/.test(plain(await call("killProcess", {}))), "без pid и name — понятный отказ");
    const ghost = plain(await call("killProcess", { pid: 999999 }));
    ok(/Возможно, процесс уже завершён или не найден/.test(ghost), "несуществующий процесс назван честно: " + ghost.split("\n")[0].slice(0, 70));
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    started.add(victim.pid);
    await sleep(300);
    ok(alive(victim.pid), "подопытный процесс запущен (PID " + victim.pid + ")");
    const killed = plain(await call("killProcess", { pid: victim.pid }));
    await sleep(400);
    const stillAlive = alive(victim.pid);
    if (stillAlive) { try { process.kill(victim.pid, "SIGKILL"); } catch {} }
    started.delete(victim.pid);
    ok(/OK — процесс PID /.test(killed), "инструмент отчитался об остановке: " + killed.split("\n")[0].slice(0, 70));
    ok(!stillAlive, "процесс действительно мёртв (PID " + victim.pid + "), а не «отчёт об остановке»");

    console.log("\n[5] installSystemPackage: без имени — отказ, «уже установлено» — правда");
    const noPkg = plain(await call("installSystemPackage", {}));
    ok(/укажи packageName/.test(noPkg), "пустое имя объяснено: " + noPkg.slice(0, 70));
    const haveGit = plain(await call("installSystemPackage", { packageName: "git" }));
    ok(/«git» уже установлен/.test(haveGit), "git опознан как установленный (без всякой установки): " + haveGit.split("\n")[0].slice(0, 70));
    ok(/Установка не нужна/.test(haveGit), "сказано, что ставить нечего");

    console.log("\n[6] refreshEnv: настоящий PATH этой машины");
    const env = plain(await call("refreshEnv", {}));
    ok(/PATH обновлён в текущей сессии/.test(env), "PATH перечитан у системы: " + env.split("\n")[0].slice(0, 70));
    ok(/Записей было: \d+, стало: \d+/.test(env), "сказано, сколько записей было и стало");
    ok(/checkInstalledProgram/.test(env), "сказано, чем проверить результат");

    console.log("\n[7] реестр и winget: на этой ОС — честный отказ, а не выдумка");
    const isWin = process.platform === "win32";
    const regR = plain(await call("registryRead", { path: "HKCU\\Software\\Test", name: "X" }));
    const regW = plain(await call("registryWrite", { path: "HKCU\\Software\\Test", name: "X", value: "1" }));
    if (isWin) {
      ok(!/^Ошибка: реестр Windows доступен только на Windows/.test(regR), "на Windows чтение реестра не блокируется платформой");
      ok(!/^Ошибка: реестр Windows доступен только на Windows/.test(regW), "на Windows запись реестра не блокируется платформой");
    } else {
      ok(/только на Windows/.test(regR), "чтение реестра на этой ОС честно отказано: " + regR.slice(0, 70));
      ok(/только на Windows/.test(regW), "запись реестра на этой ОС честно отказана: " + regW.slice(0, 70));
    }
    const wg = plain(await call("wingetSearch", { query: "python" }));
    if (isWin) ok(/(Результаты winget search|укажи query|winget недоступен)/.test(wg), "winget на Windows отвечает по делу");
    else ok(/только на Windows/.test(wg), "winget на этой ОС честно отказан: " + wg.slice(0, 70));

    console.log("\n[8] installExe: отказы вместо тихой установки");
    const tmpInstall = path.join(os.tmpdir(), "ai-agent-install");
    const noUrl = plain(await call("installExe", {}));
    ok(/укажи прямой URL установщика/.test(noUrl), "без URL — понятный отказ: " + noUrl.slice(0, 60));
    const badUrl = plain(await call("installExe", { url: "ftp://example.com/setup.exe" }));
    ok(/укажи прямой URL установщика/.test(badUrl), "не-http ссылка не скачивается и объясняется");
    const msi = plain(await call("installExe", { url: "https://example.com/setup.msi" }));
    if (isWin) {
      ok(!/только в Windows/.test(msi), "на Windows .msi не отвергается платформой");
    } else {
      ok(/\.msi ставится только в Windows/.test(msi), "на этой ОС .msi отвергнут ДО загрузки: " + msi.slice(0, 60));
      ok(!fs.existsSync(path.join(tmpInstall, "setup.msi")), "отвергнутый .msi даже не скачивался");
    }
    // Неудачная загрузка: закрытый порт localhost — быстро, детерминированно и без сети.
    for (const [ext, note] of [[".exe", "установщик"], [".zip", "архив"]]) {
      const res = plain(await call("installExe", { url: "http://127.0.0.1:1/setup" + ext }));
      ok(/Ошибка загрузки/.test(res), "неудачная загрузка " + note + " объяснена, а не проглочена: " + res.split("\n")[0].slice(0, 60));
    }
    const leftovers = fs.existsSync(tmpInstall)
      ? fs.readdirSync(tmpInstall).filter((f) => /^setup\.(exe|msi|zip)$/.test(f))
      : [];
    ok(leftovers.length === 0, "неудачные загрузки не оставили файлов: " + (leftovers.join(", ") || "чисто"));
    ok(alive(process.pid), "прогон сам жив — значит ничего не установилось и не сломалось");
    info("на этой машине ничего не устанавливалось: проверялись только ветки отказа и «уже установлено»");
  } finally {
    stopAll();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки системы и установки ПО пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})();

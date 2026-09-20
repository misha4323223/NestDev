"use strict";

/* ── Быстрый запуск проекта: превью (src/preview-ipc.js) ──────────────────────
   Запуск: node test/preview-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 31) вместе со своим состоянием
   запуска (devRun). Ошибается он тихо в трёх местах, и все три человек видит
   не как ошибку, а как «ничего не произошло»:

     • вывод сервера не доходит до окна: события dev:event уходят в окно, взятое
       ФУНКЦИЕЙ (getWindow) — оно создаётся после сборки модуля и может быть
       пересоздано, а копия «застыла» бы на null и лог превью остался бы пустым;
     • порт остаётся занятым после остановки: процесс мог запустить агент
       (startBackground) или он остался от прошлого запуска, поэтому остановка
       освобождает и порт из настроек, а не только свой процесс;
     • «Проект уже запущен» вместо второго dev-сервера: два сервера на одном
       порту — это непонятный отказ запуска у человека.

   Стенд: настоящий модуль, поддельные процессы и окно. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerPreviewIpc } = require(path.join(ROOT, "src", "preview-ipc.js"));

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

const WORK = path.join(path.sep, "work", "project");

function emitter() {
  const handlers = {};
  return {
    on: (ev, fn) => {
      (handlers[ev] = handlers[ev] || []).push(fn);
    },
    emit: (ev, ...args) => (handlers[ev] || []).forEach((f) => f(...args)),
  };
}

function mkWin(id) {
  const sent = [];
  return {
    id,
    sent,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { send: (ch, ev) => sent.push({ ch, ev }) },
  };
}

/* Стенд: настоящий модуль. Файловая система — карты существующих папок и
   содержимого package.json; процессы — записываемые заглушки; окно — с живым
   флагом «уничтожено» (окно пересоздаётся, и копия значения «застыла» бы). */
function mk(over) {
  const o = over || {};
  const handlers = new Map();
  const listeners = new Map();
  const dirs = new Set(o.dirs || [WORK]);
  const files = o.files || {};
  const spawned = [];
  const killed = [];
  const ports = o.ports || {};
  const askedPorts = [];
  let win = o.window === undefined ? mkWin(7) : o.window;
  const settings = { previewUrl: o.previewUrl === undefined ? "http://localhost:5199" : o.previewUrl };

  const api = registerPreviewIpc({
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => listeners.set(ch, fn),
    },
    fs: {
      // Папки — из dirs, файлы — из files: existenceSync должен видеть и те, и другие
      // (иначе проверка lockfile считала бы, что файла нет).
      existsSync: (p) => dirs.has(p) || p in files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error("ENOENT: " + p);
        return files[p];
      },
    },
    path,
    loadSettings: () => ({ ...settings }),
    sanitizeDir: (d) => String(d || "").trim(),
    agentWorkDir: () => (o.workDir === undefined ? WORK : o.workDir),
    bgSpawn: (cmd, opts) => {
      if (o.spawnThrows) throw new Error("не удалось запустить процесс");
      const rec = {
        name: opts.name,
        command: cmd,
        cwd: opts.cwd,
        exited: false,
        child: Object.assign(emitter(), { stdout: emitter(), stderr: emitter() }),
      };
      spawned.push(rec);
      return rec;
    },
    bgKill: (rec) => {
      killed.push(rec);
      rec.exited = true;
    },
    stripAnsi: (s) => String(s).replace(/\u001b\[[0-9;]*m/g, ""),
    parsePortFromUrl: (u) => {
      const m = String(u || "").match(/:(\d+)/);
      return m ? Number(m[1]) : 0;
    },
    killProcessesOnPort: async (port) => {
      askedPorts.push(port);
      return ports[port] || { ok: true, killed: [] };
    },
    getWindow: () => win,
  });

  return {
    handlers,
    listeners,
    spawned,
    killed,
    askedPorts,
    settings,
    dirs,
    shutdown: () => api.devShutdown(),
    setWindow: (w) => {
      win = w;
    },
    window: () => win,
    call: (ch, ...args) => handlers.get(ch)(null, ...args),
  };
}

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "preview-ipc.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

(async () => {
  console.log("Быстрый запуск проекта (превью)");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual([...h.handlers.keys()].sort(), ["dev:start", "dev:status", "dev:stop"]);
    assert.deepStrictEqual([...h.listeners.keys()], [], "модуль завёл лишние слушатели");
    for (const ch of ["dev:start", "dev:stop", "dev:status"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
    assert.ok(PRELOAD.includes('"dev:event"') && MOBILE.includes('"dev:event"'), "событие вывода сервера не подключено");
  });

  await test("автоопределение команды: dev, start, serve и запуск через bun", async () => {
    // Файлы проекта лежат в рабочей папке: её же читает модуль (path.join(dir, …)).
    const withPkg = (scripts, locks) => {
      const files = {};
      if (scripts !== null) files[path.join(WORK, "package.json")] = JSON.stringify({ scripts });
      for (const l of locks || []) files[path.join(WORK, l)] = "";
      return files;
    };
    const cases = [
      [withPkg({ dev: "vite" }), "npm run dev"],
      [withPkg({ dev: "vite" }, ["bun.lock"]), "bun run dev"],
      [withPkg({ dev: "vite" }, ["bunfig.toml"]), "bun run dev"],
      [withPkg({ start: "node server.js" }), "npm start"],
      [withPkg({ start: "node server.js" }, ["bun.lockb"]), "bun run start"],
      [withPkg({ serve: "serve dist" }), "npm run serve"],
      [withPkg({ test: "node t.js" }), ""],
      [{ [path.join(WORK, "package.json")]: "{ это не json" }, ""],
      [{}, ""],
    ];
    for (const [files, expected] of cases) {
      const h = mk({ files });
      const st = await h.call("dev:status", WORK);
      assert.strictEqual(st.detected, expected, "определилось «" + st.detected + "» вместо «" + expected + "» (" + JSON.stringify(Object.keys(files)) + ")");
    }
  });

  await test("dev:status: папки нет — команда не выдумывается, состояние «не запущен»", async () => {
    const h = mk({ dirs: [], workDir: "" });
    const st = await h.call("dev:status", "");
    assert.strictEqual(st.ok, true, "статус должен отвечать даже без папки");
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.detected, "", "команда выдумана для несуществующей папки");
  });

  await test("dev:start: папки нет или команды нет — понятные отказы", async () => {
    const noDir = mk({ dirs: [], workDir: "" });
    const r1 = await noDir.call("dev:start", "", "");
    assert.strictEqual(r1.ok, false);
    assert.ok(/Папка проекта не найдена/.test(r1.error), "отказ о папке потерян: " + r1.error);
    assert.deepStrictEqual(noDir.spawned, [], "процесс запущен без папки");

    const noCmd = mk({ files: {} });
    const r2 = await noCmd.call("dev:start", WORK, "");
    assert.strictEqual(r2.ok, false);
    assert.ok(/Не найден скрипт запуска/.test(r2.error), "отказ о команде потерян: " + r2.error);
    assert.deepStrictEqual(noCmd.spawned, [], "процесс запущен без команды");
  });

  await test("dev:start: запускает команду в папке проекта и сообщает об этом окну", async () => {
    const h = mk({ files: { [path.join(WORK, "package.json")]: JSON.stringify({ scripts: { dev: "vite" } }) } });
    const r = await h.call("dev:start", WORK, "");
    assert.strictEqual(r.ok, true, "запуск не прошёл: " + JSON.stringify(r));
    assert.strictEqual(r.command, "npm run dev", "команда не определена по package.json");
    assert.strictEqual(r.cwd, WORK, "запуск не в папке проекта");
    assert.strictEqual(h.spawned.length, 1, "процесс не запущен");
    assert.strictEqual(h.spawned[0].cwd, WORK, "рабочая папка процесса не та");
    assert.ok(h.spawned[0].name.indexOf("dev:") === 0, "имя процесса не помечено превью");
    const st = await h.call("dev:status", WORK);
    assert.strictEqual(st.running, true, "статус не увидел запущенный сервер");
    assert.strictEqual(st.command, "npm run dev");
    assert.deepStrictEqual(h.window().sent.map((s) => s.ev.type), ["start"], "окну не сообщили о запуске");
    assert.deepStrictEqual(h.window().sent[0].ch, "dev:event");
  });

  await test("dev:start: свой же повтор отвергается — двух серверов на одном порту не бывает", async () => {
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    const again = await h.call("dev:start", WORK, "npm run dev");
    assert.strictEqual(again.ok, false, "запущен второй сервер");
    assert.ok(/уже запущен/.test(again.error), "отказ не объясняет причину: " + again.error);
    assert.strictEqual(h.spawned.length, 1, "процессов стало больше одного");
  });

  await test("dev:start: запуск упал — мягкий отказ, состояние не «запущен»", async () => {
    const h = mk({ spawnThrows: true });
    const r = await h.call("dev:start", WORK, "npm run dev");
    assert.strictEqual(r.ok, false, "отказ запуска проглочен");
    assert.ok(/не удалось запустить процесс/.test(r.error), "причина потеряна: " + r.error);
    assert.strictEqual((await h.call("dev:status", WORK)).running, false, "состояние осталось «запущен»");
  });

  await test("вывод сервера уходит в окно, а его выход сбрасывает состояние", async () => {
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    const rec = h.spawned[0];
    h.window().sent.length = 0;
    rec.child.stdout.emit("data", Buffer.from("\u001b[32mготово\u001b[0m на порту 5173"));
    rec.child.stderr.emit("data", Buffer.from("предупреждение"));
    const outs = h.window().sent.filter((s) => s.ev.type === "out").map((s) => s.ev.text);
    assert.deepStrictEqual(outs, ["готово на порту 5173", "предупреждение"], "вывод сервера не дошёл до окна: " + JSON.stringify(outs));
    assert.strictEqual((await h.call("dev:status", WORK)).running, true);
    rec.exited = true;
    rec.child.emit("exit", 0);
    assert.deepStrictEqual(h.window().sent[h.window().sent.length - 1].ev, { type: "exit", code: 0 }, "окну не сообщили о выходе");
    assert.strictEqual((await h.call("dev:status", WORK)).running, false, "статус не сбросился после выхода сервера");
  });

  await test("падение процесса тоже доходит до окна, а не теряется", async () => {
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    const rec = h.spawned[0];
    h.window().sent.length = 0;
    rec.child.emit("error", new Error("порт занят"));
    const last = h.window().sent[h.window().sent.length - 1].ev;
    assert.deepStrictEqual(last, { type: "exit", code: null, error: "порт занят" }, "ошибка процесса потеряна: " + JSON.stringify(last));
    assert.strictEqual((await h.call("dev:status", WORK)).running, false);
  });

  await test("dev:stop: не запущено и порт свободен — честный отказ", async () => {
    const h = mk({ previewUrl: "" });
    const r = await h.call("dev:stop");
    assert.strictEqual(r.ok, false, "остановка «прошла» без запущенного проекта");
    assert.ok(/Проект не запущен/.test(r.error), "отказ не объясняет причину: " + r.error);
    assert.deepStrictEqual(h.killed, [], "что-то убито без запущенного проекта");
  });

  await test("dev:stop: освобождает порт, даже если процесс запустил агент", async () => {
    // Сирота от прошлого запуска или сервер, поднятый агентом (startBackground):
    // своего процесса у превью нет, но порт из настроек занят и должен освободиться.
    const h = mk({ ports: { 5199: { ok: true, killed: [4242] } } });
    const r = await h.call("dev:stop");
    assert.strictEqual(r.ok, true, "порт не освобождён: " + JSON.stringify(r));
    assert.deepStrictEqual(h.askedPorts, [5199], "спросили не тот порт");
    assert.ok(/порт 5199 \(PID 4242\)/.test(r.stopped.join("; ")), "человеку не сказано про освобождённый порт: " + JSON.stringify(r.stopped));
    assert.ok(h.window().sent.some((s) => s.ev.type === "stopped"), "окну не сообщили об остановке");
  });

  await test("dev:stop: останавливает свой сервер и сбрасывает состояние", async () => {
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    const rec = h.spawned[0];
    const r = await h.call("dev:stop");
    assert.strictEqual(r.ok, true, "остановка не прошла: " + JSON.stringify(r));
    assert.deepStrictEqual(h.killed, [rec], "убит не тот процесс");
    assert.ok(r.stopped.join(" ").indexOf("dev:npm run dev") >= 0, "человеку не сказано, что остановлено: " + JSON.stringify(r.stopped));
    assert.strictEqual((await h.call("dev:status", WORK)).running, false, "статус остался «запущен»");
    // И запуск после остановки снова проходит (порт не «залип»).
    const again = await h.call("dev:start", WORK, "npm run dev");
    assert.strictEqual(again.ok, true, "после остановки запуск не проходит");
  });

  await test("события идут в ЖИВОЕ окно: закрытое молчит, пересозданное получает", async () => {
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    h.window().destroyed = true; // окно закрыли — писать некуда и падать нельзя
    assert.doesNotThrow(() => h.spawned[0].child.stdout.emit("data", Buffer.from("после закрытия")));
    assert.deepStrictEqual(h.window().sent.filter((s) => s.ev.type === "out"), [], "событие ушло в уничтоженное окно");
    const fresh = mkWin(99);
    h.setWindow(fresh);
    h.spawned[0].child.stdout.emit("data", Buffer.from("в новое окно"));
    assert.deepStrictEqual(fresh.sent.filter((s) => s.ev.type === "out").map((s) => s.ev.text), ["в новое окно"], "событие ушло в старое окно (значение взято копией)");
  });

  await test("devShutdown: остановка при выходе приложения убивает сервер и не падает без него", async () => {
    const empty = mk();
    assert.strictEqual(typeof empty.shutdown, "function", "модуль не отдал devShutdown");
    assert.doesNotThrow(() => empty.shutdown(), "остановка без запущенного сервера упала");
    const h = mk();
    await h.call("dev:start", WORK, "npm run dev");
    const rec = h.spawned[0];
    h.shutdown();
    assert.deepStrictEqual(h.killed, [rec], "сервер пережил закрытие приложения (держит порт)");
    assert.doesNotThrow(() => h.shutdown(), "повторная остановка упала");
  });

  await test("состояние живёт в модуле: в main.js не осталось ни devRun, ни каналов dev:*", () => {
    // Комментарии в оболочке объясняют переезд и называют имена — код считаем без них.
    const code = MAIN_SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    for (const gone of ["devRun", "detectDevCommand", "devEmit", "devStart", "devStop", "devStatus"]) {
      assert.ok(code.indexOf(gone) === -1, "в main.js осталось: " + gone);
    }
    assert.ok(!/ipcMain\.(handle|on)\("dev:/.test(MAIN_SRC), "в main.js остались каналы превью");
    // Своё состояние модуль держит сам — но не значение оболочки.
    assert.ok(/^let devRun = null;/m.test(MODULE_SRC), "состояние запуска не переехало в модуль");
  });

  await test("проводка в main.js: зависимости, окно стрелкой и devShutdown при выходе", () => {
    assert.ok(MAIN_SRC.includes('require("./preview-ipc.js")'), "main.js не собирает модуль превью");
    const at = MAIN_SRC.indexOf('require("./preview-ipc.js")');
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["ipcMain,", "fs,", "path,", "loadSettings,", "sanitizeDir,", "agentWorkDir,",
      "bgSpawn,", "bgKill,", "stripAnsi,", "parsePortFromUrl,", "killProcessesOnPort,", "getWindow:"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
    assert.ok(wiring.includes("getWindow: () => mainWindow"), "окно передано не стрелкой — «застынет» на null");
    assert.ok(/\bdevShutdown\(\);/.test(MAIN_SRC), "остановка при выходе приложения не подключена");
    for (const before of ["new MobileBridge(", "createBgProcesses({", "createTerminalPanel({"]) {
      assert.ok(MAIN_SRC.indexOf(before) < at, "модуль превью собран раньше зависимости: " + before);
    }
  });

  console.log("\nПревью: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

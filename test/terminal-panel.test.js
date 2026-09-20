"use strict";

/* ── Пользовательский терминал (src/terminal-panel.js) ────────────────────────
   Запуск: node test/terminal-panel.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 12): постоянная оболочка рабочей
   папки, в которую агент дублирует свои команды и их вывод.

   Почему проверки поведенческие: ошибки тут тихие и дорогие.
     • Оболочка не поднялась — панель молчит, а человек думает, что «зависло».
     • Вывод не доехал до окна — работа агента не видна (ровно то, ради чего
       терминал и делали).
     • Остановка не погасила дерево процессов — рабочие процессы остаются
       сиротами и держат порт.

   Поэтому модуль водится НАСТОЯЩЕЙ оболочкой: команды исполняются, вывод
   читается из события, а процесс проверяется по pid. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const spawn = require("child_process").spawn;

const ROOT = path.join(__dirname, "..");
const { createTerminalPanel } = require(path.join(ROOT, "src", "terminal-panel.js"));
const { createBgProcesses } = require(path.join(ROOT, "src", "bg-processes.js"));
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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "terminal-panel.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === "win32";
// Одна и та же мысль для sh и cmd: печать строки / печать рабочей папки / pid оболочки.
const sayEcho = (word) => "echo " + word;
const sayPwd = () => (WIN ? "cd" : "pwd");
const sayVar = (name) => (WIN ? "echo %" + name + "%" : "echo $" + name);
const sayShellPid = () => (WIN ? "" : "echo $$");

async function waitFor(cond, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 5000)) {
    if (await cond()) return true;
    await sleep(60);
  }
  return false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Настоящий bgKill из своего модуля — тот же, что получает приложение.
const bg = createBgProcesses({
  spawn,
  os,
  stripAnsi: (s) => String(s).replace(/\u001b\[[0-9;]*m/g, ""),
  shellArgsFor: (cmd) => ["-c", cmd],
  commandEnv: () => ({}),
  runTerminalCommand: () => Promise.resolve(""),
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "term-panel-"));
const work = path.join(root, "work");
fs.mkdirSync(path.join(work, "beta"), { recursive: true });
fs.writeFileSync(path.join(work, "alpha.txt"), "a", "utf8");
fs.writeFileSync(path.join(work, "alpine.txt"), "b", "utf8");
fs.writeFileSync(path.join(work, "beta", "inside.txt"), "c", "utf8");
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(work, "many-" + String(i).padStart(2, "0") + ".txt"), "x", "utf8");

const state = { settings: { workingDir: work } };
const events = [];
let win = { isDestroyed: () => false, webContents: { send: (ch, ev) => events.push({ ch, ev }) } };

function makePanel(over) {
  return createTerminalPanel(Object.assign({
    fs,
    path,
    os,
    spawn,
    stripAnsi: (s) => String(s).replace(/\u001b\[[0-9;]*m/g, ""),
    envFor: () => ({ ...process.env, TERM_TEST_VAR: "term-42", GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0" }),
    bgKill: bg.bgKill,
    agentWorkDir: (s) => s.workingDir,
    loadSettings: () => state.settings,
    getWindow: () => win,
  }, over || {}));
}

const panel = makePanel();
const last = (type) => [...events].reverse().find((e) => e.ev && e.ev.type === type);

(async () => {
  await test("событие уходит окну, а без окна просто не шлётся", () => {
    events.length = 0;
    panel.termEmit({ type: "metrics", text: "проверка" });
    assert.strictEqual(events.length, 1, "событие не ушло окну");
    assert.strictEqual(events[0].ch, "term:event", "не тот канал: " + events[0].ch);
    assert.deepStrictEqual(events[0].ev, { type: "metrics", text: "проверка" }, "событие изменилось по дороге");

    const noWin = makePanel({ getWindow: () => null });
    noWin.termEmit({ type: "metrics", text: "в пустоту" });
    assert.strictEqual(events.length, 1, "без окна что-то отправлено");

    const deadWin = makePanel({ getWindow: () => ({ isDestroyed: () => true, webContents: { send: () => events.push({ ch: "мусор" }) } }) });
    deadWin.termEmit({ type: "metrics", text: "в закрытое окно" });
    assert.strictEqual(events.length, 1, "событие ушло в закрытое окно");
  });

  await test("запуск: настоящая оболочка в рабочей папке", (t) => {
    events.length = 0;
    const r = panel.termStart(work);
    assert.strictEqual(r.ok, true, "терминал не запустился: " + JSON.stringify(r));
    assert.strictEqual(r.cwd, work, "рабочая папка не та: " + r.cwd);
    const ev = last("start");
    assert.ok(ev && ev.ev.cwd === work, "окну не сказали о запуске: " + JSON.stringify(ev && ev.ev));
    assert.deepStrictEqual(panel.termStatus(), { running: true }, "терминал не считается запущенным");
    const again = panel.termStart(work);
    assert.strictEqual(again.ok, false, "второй терминал запустился поверх первого");
    assert.ok(/уже запущен/.test(again.error), "нет понятного отказа: " + again.error);
  });

  await test("ввод: команда доходит до оболочки, а вывод — до окна", async () => {
    events.length = 0;
    const sent = panel.termInput(sayEcho("VERBOSE-MARK-1"));
    assert.strictEqual(sent.ok, true, "ввод не принят: " + JSON.stringify(sent));
    assert.ok(last("in") && /VERBOSE-MARK-1/.test(last("in").ev.text), "окну не показали введённую команду");
    const got = await waitFor(() => events.some((e) => e.ev.type === "out" && /VERBOSE-MARK-1/.test(e.ev.text)));
    assert.ok(got, "вывод команды не пришёл в окно: " + JSON.stringify(events.map((e) => e.ev)));

    // Оболочка действительно работает в рабочей папке, а не где попало.
    events.length = 0;
    panel.termInput(sayPwd());
    const pwd = await waitFor(() => events.some((e) => e.ev.type === "out" && e.ev.text.includes(path.basename(work))));
    assert.ok(pwd, "оболочка не видит рабочую папку: " + JSON.stringify(events.map((e) => e.ev)));
  });

  await test("окружение терминала: выданная переменная доходит до команды", async () => {
    events.length = 0;
    panel.termInput(sayVar("TERM_TEST_VAR"));
    const got = await waitFor(() => events.some((e) => e.ev.type === "out" && /term-42/.test(e.ev.text)));
    assert.ok(got, "переменная окружения не дошла до оболочки: " + JSON.stringify(events.map((e) => e.ev)));
  });

  await test("ввод без запуска — честный отказ, а не тишина", () => {
    const stopped = makePanel();
    // Терминал этого экземпляра не запускался вовсе.
    const r = stopped.termInput(sayEcho("no"));
    assert.strictEqual(r.ok, false, "ввод принят без запущенного терминала");
    assert.ok(/Перезапусти панель/.test(r.error), "нет объяснения для человека: " + r.error);
  });

  await test("status: до запуска, в работе и после выхода оболочки", async () => {
    const p = makePanel();
    assert.deepStrictEqual(p.termStatus(), { running: false }, "до запуска терминал «работает»");
    p.termStart(work);
    assert.deepStrictEqual(p.termStatus(), { running: true }, "после запуска терминал не работает");
    events.length = 0;
    p.termInput("exit");
    const exited = await waitFor(() => p.termStatus().running === false, 8000);
    assert.ok(exited, "выход оболочки не замечен: " + JSON.stringify(events.map((e) => e.ev)));
    assert.ok(last("exit"), "окну не сказали о выходе оболочки");
  });

  await test("stop: гасит оболочку по-настоящему и позволяет запустить снова", async () => {
    const p = makePanel();
    p.termStart(work);
    if (!WIN) {
      // pid оболочки узнаём у неё самой: `echo $$` — иначе нечем проверить, что она мертва.
      events.length = 0;
      p.termInput(sayShellPid());
      await waitFor(() => events.some((e) => e.ev.type === "out" && /\d{2,}/.test(e.ev.text)), 8000);
      const pidText = events.filter((e) => e.ev.type === "out").map((e) => e.ev.text).join(" ");
      const m = pidText.match(/\b(\d{2,})\b/);
      assert.ok(m, "не удалось узнать pid оболочки: " + pidText.trim());
      const pid = Number(m[1]);
      assert.ok(pidAlive(pid), "оболочка не работает до остановки");
      const r = p.termStop();
      assert.strictEqual(r.ok, true, "остановка не принята: " + JSON.stringify(r));
      const dead = await waitFor(() => !pidAlive(pid), 6000);
      assert.ok(dead, "процесс оболочки остался жить после остановки (pid " + pid + ")");
    } else {
      assert.strictEqual(p.termStop().ok, true, "остановка не принята");
    }
    assert.deepStrictEqual(p.termStatus(), { running: false }, "после остановки терминал «работает»");
    assert.strictEqual(p.termStop().ok, false, "повторная остановка прошла как успех");
    assert.strictEqual(p.termStart(work).ok, true, "после остановки терминал не запускается снова");
    p.termStop();
  });

  await test("shutdown: гасит молча и не падает без терминала", async () => {
    const p = makePanel();
    p.termShutdown(); // терминала нет — тишина, а не падение
    assert.deepStrictEqual(p.termStatus(), { running: false }, "пустая остановка что-то сломала");
    p.termStart(work);
    assert.deepStrictEqual(p.termStatus(), { running: true }, "терминал не запустился");
    events.length = 0;
    p.termShutdown();
    assert.deepStrictEqual(p.termStatus(), { running: false }, "выход приложения не погасил терминал");
    assert.strictEqual(events.length, 0, "при выходе приложения окну что-то отправлено");
  });

  await test("agentEcho: чистит ANSI, показывает агенту своё и молчит на пустом", () => {
    const p = makePanel();
    p.termStart(work);
    events.length = 0;
    p.termAgentEcho("$ npm test\n\u001b[32m✓ прошло\u001b[0m");
    assert.strictEqual(events.length, 1, "команда агента не показана в терминале");
    assert.strictEqual(events[0].ev.type, "agent", "не тот вид события: " + events[0].ev.type);
    assert.ok(!/\u001b/.test(events[0].ev.text), "в терминал ушли служебные коды цвета");
    assert.ok(/npm test/.test(events[0].ev.text) && /прошло/.test(events[0].ev.text), "текст агента потерян: " + events[0].ev.text);
    events.length = 0;
    p.termAgentEcho("");
    p.termAgentEcho(null);
    assert.strictEqual(events.length, 0, "пустое вместо текста агента ушло в терминал");
    p.termAgentEcho("   \n  "); // строка из пробелов — как и было: в терминал уходит
    assert.strictEqual(events.length, 1, "строка агента потеряна");
    p.termStop();
  });

  await test("autocomplete: файлы рабочей папки, путь и команды из PATH", () => {
    const empty = panel.termComplete("");
    assert.ok(empty.matches.includes("alpha.txt"), "нет файла рабочей папки: " + empty.matches.join(", "));
    assert.ok(empty.matches.includes("beta/"), "папка показана без слэша: " + empty.matches.join(", "));
    assert.strictEqual(empty.base, "", "база не пуста для пустого ввода");
    assert.strictEqual(empty.tokenLen, 0, "длина токена не ноль");

    const byPrefix = panel.termComplete("al");
    assert.deepStrictEqual(byPrefix.matches, ["alpha.txt", "alpine.txt"], "префикс разобрал не то: " + byPrefix.matches.join(", "));

    const inDir = panel.termComplete("beta/");
    assert.deepStrictEqual(inDir.matches, ["beta/inside.txt"], "внутрь папки не заглянули: " + inDir.matches.join(", "));

    const afterSpace = panel.termComplete("npm ru");
    assert.strictEqual(afterSpace.base, "npm ", "база команды потеряна: " + JSON.stringify(afterSpace.base));
    assert.strictEqual(afterSpace.tokenLen, 2, "длина последнего токена не та: " + afterSpace.tokenLen);

    const limit = panel.termComplete("many-");
    assert.strictEqual(limit.matches.length, 30, "предел подсказок не 30: " + limit.matches.length);
  });

  await test("команд из PATH хватает, а мусорный префикс даёт пусто", () => {
    const cmd = panel.termComplete("nod");
    assert.ok(cmd.matches.some((m) => /^node/i.test(m)), "команда из PATH не подсказана: " + cmd.matches.join(", "));
    const none = panel.termComplete("яяя-нет-такого");
    assert.deepStrictEqual(none.matches, [], "мусорный префикс что-то нашёл: " + none.matches.join(", "));
  });

  await test("оболочка не поднялась — отказ, а не падение", () => {
    const broken = makePanel({ spawn: () => { throw new Error("нет оболочки"); } });
    const r = broken.termStart(work);
    assert.strictEqual(r.ok, false, "падение запуска выдано за успех");
    assert.ok(/нет оболочки/.test(r.error), "причина отказа не названа: " + r.error);
    assert.deepStrictEqual(broken.termStatus(), { running: false }, "сломанный запуск оставил терминал «работающим»");
  });

  await test("каналы панели: имена ровно как у окна и телефона, старт берёт ТЕКУЩУЮ папку", async () => {
    const handlers = new Map();
    // Свой экземпляр панели — со своим терминалом: чужое состояние соседей не трогаем.
    const chan = makePanel();
    chan.registerTermIpc({ handle: (ch, fn) => handlers.set(ch, fn) });
    assert.deepStrictEqual([...handlers.keys()].sort(), ["term:complete", "term:input", "term:start", "term:status", "term:stop"]);
    // Имена сверяем с клиентами: разъехавшееся имя молча ломает панель.
    const PRELOAD = read("src", "preload.js");
    const MOBILE = read("src", "renderer", "mobile-api.js");
    for (const ch of handlers.keys()) {
      assert.ok(PRELOAD.includes('invoke("' + ch + '"'), "окно не зовёт " + ch);
      assert.ok(MOBILE.includes('"' + ch + '"'), "телефон не зовёт " + ch);
    }
    // Дополнение идёт через канал точно так же, как из панели.
    const comp = await handlers.get("term:complete")(null, "alph");
    assert.ok(comp.matches.indexOf("alpha.txt") >= 0 || comp.tokenLen === 4, "term:complete отвечает не как модуль: " + JSON.stringify(comp));

    // Проект переключили, пока панель была закрыта: терминал обязан открыться
    // в НЫНЕШНЕЙ папке. Иначе команды человека уходят в папку прошлого проекта.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "term-panel-other-"));
    const before = state.settings.workingDir;
    state.settings = { workingDir: other };
    try {
      const started = await handlers.get("term:start")();
      assert.strictEqual(started.ok, true, "терминал не запустился: " + JSON.stringify(started.error));
      assert.strictEqual(started.cwd, other, "старт получил не текущую папку: " + started.cwd);
      assert.deepStrictEqual(await handlers.get("term:status")(), { running: true }, "статус не видит запущенный терминал");
      events.length = 0;
      await handlers.get("term:input")(null, sayPwd());
      await waitFor(() => events.some((e) => e.ev && e.ev.type === "out" && e.ev.text.indexOf(other) >= 0));
      const out = events.filter((e) => e.ev && e.ev.type === "out").map((e) => e.ev.text).join("\n");
      assert.ok(
        out.indexOf(other) >= 0 || out.indexOf(fs.realpathSync(other)) >= 0,
        "терминал открылся не в текущей папке: " + JSON.stringify(out.slice(0, 160))
      );
      assert.deepStrictEqual(await handlers.get("term:stop")(), { ok: true }, "остановка через канал не ответила как модуль");
      assert.deepStrictEqual(await handlers.get("term:status")(), { running: false }, "статус после остановки не сбросился");
    } finally {
      state.settings = { workingDir: before };
      try { chan.termStop(); } catch {}
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["let userTerm = null;", "function termEmit(", "function termAgentEcho(", "function termStart(", "function termInput(", "function termStop(", "function termComplete("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createTerminalPanel \} = require\("\.\/terminal-panel\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(
      /const \{ termEmit, termAgentEcho, termStart, termInput, termStop, termStatus, termShutdown, termComplete, registerTermIpc \} = createTerminalPanel\(\{/.test(MAIN_SRC),
      "состав имён в проводке модуля изменился"
    );
    for (const dep of ["fs,", "path,", "os,", "spawn,", "stripAnsi,", "envFor,", "bgKill,", "agentWorkDir,", "loadSettings,", "getWindow: () => mainWindow,"]) {
      assert.ok(MAIN_SRC.includes(dep), "в проводку не передано: " + dep);
    }
    // Каналы и выход приложения зовут модуль, а не держат кусок его состояния.
    // С части 32 каналы регистрирует сам модуль — в оболочке остаётся один вызов.
    assert.ok(MAIN_SRC.includes("registerTermIpc(ipcMain);"), "оболочка не передаёт каналы модулю");
    assert.ok(!/ipcMain\.(handle|on)\("term:/.test(MAIN_SRC), "в main.js остались каналы терминала");
    assert.ok(/ipcMain\.handle\("term:start", \(\) => termStart\(agentWorkDir\(loadSettings\(\)\)\)\);/.test(MODULE_SRC), "модуль не регистрирует term:start");
    assert.ok(MAIN_SRC.includes("termShutdown();"), "выход приложения не гасит терминал модулем");
    assert.ok(!/userTerm/.test(MAIN_SRC), "в оболочке осталось чужое состояние: userTerm");
    assert.ok(/termAgentEcho,\n  mailConfig,/.test(MAIN_SRC), "инструменты больше не получают терминал агента");
    assert.ok(
      /function termEmit\(ev\) \{\n  const mainWindow = getWindow\(\);\n  if \(mainWindow && !mainWindow\.isDestroyed\(\)\) mainWindow\.webContents\.send\("term:event", ev\);/.test(MODULE_SRC),
      "событие терминала уходит не в живое окно, взятое функцией"
    );
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

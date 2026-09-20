"use strict";

/* ── Фоновые процессы, постоянные оболочки и dev-серверы (src/bg-processes.js) ──
   Запуск: node test/bg-processes.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 9): запуск длительных команд, накопление
   вывода в кольцевом буфере, остановка вместе со всем деревом процессов, ожидание
   маркера/затишья, освобождение порта и живая HTTP-проверка адреса превью.

   Почему проверки поведенческие, а не «строка на месте»: ошибки здесь тихие и
   дорогие, и почти все — про НАСТОЯЩИЕ процессы.
     • Если остановка убьёт только оболочку, node/expo-сирота останется и будет
       держать порт: следующий запуск упадёт с «порт занят», а в панели процессов
       будет пусто.
     • Если освобождение порта перестанет находить слушателя, dev-сервер вообще
       не поднимется — без единого сообщения.
     • Если кольцевой буфер перестанет обрезаться, долгий watch съест память.
   Поэтому модуль водится по-настоящему: настоящие процессы, настоящие порты,
   настоящий HTTP-сервер, настоящий lsof. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
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
const MODULE_SRC = read("src", "bg-processes.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Настоящий запуск команды: как в приложении — через оболочку, с таймаутом.
function realRun(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd: cwd || os.homedir(), timeout: timeoutMs || 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(String(stdout || "") + String(stderr || "") + (err && !stdout && !stderr ? String(err.message) : ""));
    });
  });
}

// Настоящий ANSI-стриппер и настоящие аргументы оболочки — то же, что даёт оболочка.
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");
const shellArgsFor = (cmd) => ["-c", cmd];

function makeBg(over) {
  return createBgProcesses(Object.assign({
    spawn: require("child_process").spawn,
    os,
    stripAnsi,
    shellArgsFor,
    commandEnv: () => ({}),
    runTerminalCommand: realRun,
  }, over || {}));
}

// Ждём условие: процессы завершаются не мгновенно, проверять сразу — значит гадать.
async function waitFor(cond, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (await cond()) return true;
    await sleep(100);
  }
  return false;
}

function pidAlive(pid) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "ps -o pid= -p " + pid], (err, stdout) => resolve(String(stdout || "").trim().length > 0));
  });
}

function childrenOf(pid) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", "ps -o pid= --ppid " + pid], (err, stdout) =>
      resolve(String(stdout || "").trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number))
    );
  });
}

const bg = makeBg();

(async () => {
  console.log("Фоновые процессы, оболочки и dev-серверы (src/bg-processes.js)");

  await test("запуск: настоящий процесс печатает, вывод собирается, код выхода записан", async () => {
    const rec = bg.bgSpawn("echo привет-из-процесса; echo вторая-строка");
    assert.ok(rec.id.startsWith("bg"), "идентификатор процесса не выдан: " + rec.id);
    assert.strictEqual(rec.exited, false, "процесс «завершён» сразу после запуска");
    const done = await waitFor(() => rec.exited, 5000);
    assert.ok(done, "процесс не завершился за 5 с");
    assert.strictEqual(rec.exitCode, 0, "код выхода: " + rec.exitCode);
    const text = bg.bgTail(rec, 50);
    assert.ok(/привет-из-процесса/.test(text) && /вторая-строка/.test(text), "вывод процесса не собран: " + JSON.stringify(text));
    assert.ok(rec.startedAt > 0 && rec.command.includes("echo"), "у записи процесса нет команды или времени");
  });

  await test("вывод: кольцевой буфер держит последнюю тысячу строк, а не всё подряд", async () => {
    const rec = bg.bgSpawn("node -e \"for (let i = 1; i <= 1400; i++) console.log('строка-' + i)\"");
    const done = await waitFor(() => rec.exited, 15000);
    assert.ok(done, "процесс не завершился");
    assert.strictEqual(rec.output.length, 1000, "строк в буфере: " + rec.output.length);
    assert.ok(rec.output.includes("строка-1400"), "в буфере нет последней строки процесса");
    assert.ok(!rec.output.some((l) => /строка-1$/.test(l)), "в буфере осталась первая строка — обрезки нет");
  });

  await test("остановка: bgKill завершает процесс и всех его детей", async () => {
    const rec = bg.bgSpawn("sleep 45 & wait");
    await waitFor(async () => (await childrenOf(rec.child.pid)).length > 0, 3000);
    const kids = await childrenOf(rec.child.pid);
    assert.ok(kids.length > 0, "у оболочки не появилось детей — проверять дерево не на чем");
    bg.bgKill(rec);
    const gone = await waitFor(async () => !(await pidAlive(kids[0])), 4000);
    assert.ok(gone, "процесс-ребёнок остался жив после остановки (сирота держит порт)");
    const shellGone = await waitFor(async () => !(await pidAlive(rec.child.pid)), 4000);
    assert.ok(shellGone, "сама оболочка осталась жива");
  });

  await test("остановка: без процесса и на уже убитом не падает", () => {
    assert.doesNotThrow(() => bg.bgKill(null), "остановка без процесса упала");
    assert.doesNotThrow(() => bg.bgKill({}), "остановка записи без child упала");
    assert.doesNotThrow(() => bg.killProcessTree(null), "убийство дерева без процесса упало");
  });

  await test("порт из адреса: разбор форм, мусор — ноль", () => {
    assert.strictEqual(bg.parsePortFromUrl("http://localhost:5000/path"), 5000);
    assert.strictEqual(bg.parsePortFromUrl("https://127.0.0.1:8080"), 8080);
    assert.strictEqual(bg.parsePortFromUrl("http://localhost:5173/"), 5173);
    assert.strictEqual(bg.parsePortFromUrl("http://localhost"), 0, "адрес без порта не должен давать число");
    assert.strictEqual(bg.parsePortFromUrl(""), 0);
    assert.strictEqual(bg.parsePortFromUrl(null), 0);
    assert.strictEqual(bg.parsePortFromUrl("не адрес"), 0);
  });

  await test("освобождение порта: находит НАСТОЯЩЕГО слушателя и убивает его", async () => {
    // Слушатель — ОТДЕЛЬНЫЙ процесс (как dev-сервер в приложении): убивать себя
    // в этой проверке нельзя, а именно это и делает освобождение порта.
    const listener = require("child_process").spawn(process.execPath, ["-e",
      'const http=require("http");const s=http.createServer((q,r)=>r.end("занят"));s.listen(0,"127.0.0.1",()=>console.log("PORT="+s.address().port));'
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise((resolve, reject) => {
      let out = "";
      const t = setTimeout(() => reject(new Error("слушатель не назвал порт: " + JSON.stringify(out))), 8000);
      listener.stdout.on("data", (d) => {
        out += d;
        const m = out.match(/PORT=(\d+)/);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    const childPid = listener.pid;
    // Убеждаемся, что порт действительно занят и виден системе.
    const busy = await new Promise((r) => {
      const s = require("net").connect(port, "127.0.0.1");
      s.on("connect", () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    assert.ok(busy, "порт не занялся — проверять нечего");
    const seen = await realRun("lsof -ti tcp:" + port);
    assert.ok(String(seen).trim().length > 0, "lsof не видит слушателя: " + JSON.stringify(String(seen).slice(0, 120)));

    const r = await bg.killProcessesOnPort(port);
    assert.strictEqual(r.ok, true, "порт не освобождён: " + JSON.stringify(r));
    assert.ok(r.killed.map(String).includes(String(childPid)), "в списке убитых нет слушателя: " + JSON.stringify(r.killed));
    assert.ok(!(await pidAlive(childPid)), "слушатель остался жив после освобождения порта");
    // Порт снова свободен — на этом и держится «перезапуск превью».
    const free = await waitFor(
      () => new Promise((r2) => {
        const s = require("net").connect(port, "127.0.0.1");
        s.on("connect", () => { s.destroy(); r2(false); });
        s.on("error", () => r2(true));
      }),
      5000
    );
    assert.ok(free, "порт остался занят после освобождения");
  });

  await test("освобождение порта: мусорный номер — понятный отказ, а не попытка убить что попало", async () => {
    for (const bad of [0, -1, 70000, "abc", "", null]) {
      const r = await bg.killProcessesOnPort(bad);
      assert.strictEqual(r.ok, false, "мусорный порт «" + bad + "» принят за рабочий");
      assert.ok(/Некорректный порт/.test(r.error), "нет понятного объяснения: " + r.error);
    }
  });

  await test("разбор слушателей порта: lsof построчно, fuser после двоеточия, чужая брехня — не PID", () => {
    // lsof -ti: по одному PID в строке.
    assert.deepStrictEqual(bg.parsePortOwners("12345\n67890\n"), ["12345", "67890"]);
    // fuser: число ДО слэша — это порт, PID идут ПОСЛЕ «<порт>/tcp:».
    assert.deepStrictEqual(bg.parsePortOwners("5199/tcp:            12345 67890"), ["12345", "67890"]);

    // Та самая находка живого прогона: раньше из текста брались ВСЕ числа, и в список
    // «убитых» попадали номер порта и адрес 127.0.0.1 — «⏹ Остановить» мог погасить
    // посторонний процесс. Здесь регрессия закреплена вместе со старым разбором.
    const mix = "127.0.0.1:5199\n5199/tcp: 12345\n";
    const old = (String(mix).match(/\d+/g) || []).filter((x) => Number(x) > 1);
    assert.ok(old.includes("127") && old.includes("5199"), "старый разбор перестал быть виден — регрессию не с чем сверять");
    assert.deepStrictEqual(bg.parsePortOwners(mix), ["12345"], "в PID снова попали порт или 127.0.0.1");

    // Ни пустой ответ, ни объяснения оболочки, ни заголовки PID не рождают.
    assert.deepStrictEqual(bg.parsePortOwners(""), []);
    assert.deepStrictEqual(bg.parsePortOwners(null), []);
    assert.deepStrictEqual(bg.parsePortOwners("commands: lsof not found\n/usr/bin/fuser\n"), []);
    // Один и тот же PID из двух источников убивается один раз.
    assert.deepStrictEqual(bg.parsePortOwners("12345\n12345\n"), ["12345"]);
  });

  await test("освобождение порта: подставной убийца получает только настоящие PID", async () => {
    const killed = [];
    const fake = makeBg({
      killPid: (pid) => killed.push(pid),
      runTerminalCommand: async () => "127.0.0.1:5199\n5199/tcp: 12345 67890\n",
    });
    const r = await fake.killProcessesOnPort(5199);
    assert.deepStrictEqual(killed, [12345, 67890], "убийце достались не те номера: " + JSON.stringify(killed));
    assert.deepStrictEqual(r, { ok: true, killed: ["12345", "67890"] }, "отчёт об освобождении порта не тот: " + JSON.stringify(r));

    // Никого не нашли — и не убиваем никого: отчёт честно говорит, что освобождать было нечего.
    let called = 0;
    const empty = makeBg({ killPid: () => called++, runTerminalCommand: async () => "" });
    assert.deepStrictEqual(await empty.killProcessesOnPort(5199), { ok: false, killed: [] }, "на пустом выводе кого-то убили");
    assert.strictEqual(called, 0, "на пустом выводе убийца всё равно вызван");
  });

  await test("ожидание маркера: появился, процесс вышел, таймаут — три разных ответа", async () => {
    const rec = bg.bgSpawn("sleep 0.6; echo ГОТОВО; sleep 5");
    const matched = await bg.bgWaitFor(rec, "ГОТОВО", 5000);
    assert.deepStrictEqual(matched, { matched: true }, "маркер в выводе не найден: " + JSON.stringify(matched));
    bg.bgKill(rec);

    const exited = await bg.bgWaitFor(bg.bgSpawn("echo без-маркера"), "нет-такого", 5000);
    assert.strictEqual(exited.matched, false, "найден маркер, которого нет");
    assert.strictEqual(exited.exited, true, "выход процесса не замечен");
    assert.strictEqual(exited.code, 0, "код выхода не донесён");

    const timedOut = await bg.bgWaitFor(bg.bgSpawn("sleep 5"), "нет-такого", 700);
    assert.strictEqual(timedOut.timedOut, true, "таймаут не отработал: " + JSON.stringify(timedOut));
  });

  await test("ожидание затишья: возвращается после остановки вывода и не висит дольше предела", async () => {
    const quiet = bg.bgSpawn("echo раз; sleep 5");
    const t0 = Date.now();
    await bg.bgWaitFor(quiet, "раз", 3000);
    await bg.waitOutputQuiet(quiet, 2000);
    const spent = Date.now() - t0;
    assert.ok(spent < 4000, "ожидание затишья затянулось: " + spent + " мс");
    bg.bgKill(quiet);

    const noisy = bg.bgSpawn("while true; do echo шум; sleep 0.1; done");
    const t1 = Date.now();
    await bg.waitOutputQuiet(noisy, 800);
    const spent2 = Date.now() - t1;
    assert.ok(spent2 < 3000, "на «шумном» процессе ожидание не ограничено: " + spent2 + " мс");
    bg.bgKill(noisy);
  });

  await test("хвост вывода: последние строки, предел от 1 до 500", () => {
    const rec = { output: ["1", "2", "3", "4", "5"] };
    assert.strictEqual(bg.bgTail(rec, 2), "4\n5");
    // Ноль читается как «сколько по умолчанию» (50), а не как «ничего»: иначе хвост
    // вывода был бы пустым и агент видел бы пустой ответ вместо последних строк.
    assert.strictEqual(bg.bgTail(rec, 0), "1\n2\n3\n4\n5", "ноль должен означать предел по умолчанию");
    assert.strictEqual(bg.bgTail(rec, 99), "1\n2\n3\n4\n5");
    const big = { output: Array.from({ length: 600 }, (_, i) => "с" + i) };
    assert.strictEqual(bg.bgTail(big, 100000).split("\n").length, 500, "хвост не ограничен пятьюстами строками");
  });

  await test("проверка адреса: настоящий сервер — статус, тип, начало тела; мёртвый — честная ошибка", async () => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body>страница превью</body></html>");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      const out = await bg.checkUrlStatus("http://127.0.0.1:" + port + "/");
      assert.ok(/Статус: 200/.test(out), "статус не показан: " + JSON.stringify(out.slice(0, 120)));
      assert.ok(/Content-Type: text\/html/.test(out), "тип содержимого не показан");
      assert.ok(/страница превью/.test(out), "начало тела не показано");
    } finally {
      await new Promise((r) => srv.close(r));
    }
    const dead = await bg.checkUrlStatus("http://127.0.0.1:1/");
    assert.ok(/Ошибка: сервер не ответил/.test(dead), "мёртвый адрес описан не как ошибка: " + dead);
  });

  await test("распознавание dev-команд: серверные ловятся, сборки — нет", () => {
    const yes = ["npm run dev", "npm run start", "yarn dev", "bun run serve", "vite", "next dev", "nodemon server.js", "uvicorn app:app", "python3 manage.py runserver", "expo start", "tsx watch src/index.ts"];
    const no = ["vite build", "npm run build", "next build", "npm run test", "node scripts/make-ota.js", "git status"];
    for (const cmd of yes) assert.ok(bg.SERVER_CMD_RE.test(cmd), "серверная команда не распознана: " + cmd);
    for (const cmd of no) assert.ok(!bg.SERVER_CMD_RE.test(cmd), "короткая команда принята за сервер: " + cmd);
  });

  await test("в оболочке этого больше нет, а карта процессов отдана тем же объектом", () => {
    for (const gone of ["function bgSpawn(", "function bgKill(", "function killProcessTree(", "async function checkUrlStatus(", "const bgProcesses = new Map();"]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createBgProcesses \} = require\("\.\/bg-processes\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(/= createBgProcesses\(\{ spawn, os, stripAnsi, shellArgsFor, commandEnv, runTerminalCommand \}\)/.test(MAIN_SRC), "проводка модуля не та");
    // Закрытие приложения гасит все фоновые процессы — значит карта обязана быть ЖИВОЙ.
    assert.ok(MAIN_SRC.includes("for (const rec of bgProcesses.values()) bgKill(rec);"), "оболочка перестала гасить фоновые процессы");
    assert.ok(MAIN_SRC.includes("bgProcesses,") && MAIN_SRC.includes("SERVER_CMD_RE,"), "карта процессов или правило dev-команд не переданы дальше");
    assert.ok(/stripAnsi/.test(MODULE_SRC) && /commandEnv/.test(MODULE_SRC), "окружение команды пропало из модуля");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

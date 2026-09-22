"use strict";

/* ── Оболочки и запуск команд (src/shell-tools.js) ─────────────────────────────
   Запуск: node test/shell-tools.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 23). Ошибки здесь тихие и дорогие:

     • не та оболочка — модель пишет shell: "Bash", а команда уходит в cmd и
       падает непонятно почему;
     • нет кодировки — вывод сборки приходит кашей вместо текста ошибки;
     • оболочки нет в системе, а ответ — «код 1» без объяснения: раньше sh молча
       уходил в /bin/sh, которого на Windows нет;
     • команда вроде «git status» запускается без окружения команды вовсе.

   Проверки трёх видов: поддельный spawn (что именно передано в запуск),
   поддельный процесс (что агент увидит в ответе на каждый случай) и НАСТОЯЩИЙ
   процесс (что происходит на самом деле — включая таймаут, который обязан гасить
   дерево, а не одну оболочку). */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { createShellTools } = require(path.join(ROOT, "src", "shell-tools.js"));
// Обрезка вывода — общее правило проекта: берём НАСТОЯЩУЮ функцию ядра, чтобы
// проверка падала и на чужом пределе, и на переписанном тексте пометки.
const { truncateText } = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const SHELL_SRC = fs.readFileSync(path.join(ROOT, "src", "shell-tools.js"), "utf8");
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Поддельный процесс: ровно те потоки и события, что даёт настоящий spawn.
// Описание ответа: { stdout, stderr, code, signal, error, never }.
// never: true — процесс «не завершается сам» (ветка таймаута).
// Ошибка запуска (ENOENT) у настоящего spawn приходит СОБЫТИЕМ, а не кодом
// возврата — здесь так же, вместе с «close», как в жизни.
function makeChild(plan) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (plan.error) {
      child.emit("error", plan.error);
      child.emit("close", null, null);
      return;
    }
    if (plan.stdout) child.stdout.emit("data", Buffer.from(plan.stdout, "utf8"));
    if (plan.stderr) child.stderr.emit("data", Buffer.from(plan.stderr, "utf8"));
    for (const chunk of plan.chunks || []) child.stdout.emit("data", chunk);
    if (plan.never) return;
    // Код null (смерть от сигнала) НЕ превращает в ноль: в жизни это разные вещи.
    child.emit("close", plan.code === undefined ? 0 : plan.code, plan.signal || null);
  });
  return child;
}

// Модуль с подменённым spawn: видно, что именно уходит в запуск, а что возвращает
// поддельный процесс. killTree тоже подменяется: сторож не должен посылать
// настоящих сигналов чужим процессам из-за выдуманного pid.
function mk(over) {
  const calls = [];
  const kills = [];
  const o = over || {};
  const tools = createShellTools({
    fs: o.fs || fs,
    path,
    spawn: (shell, args, opts) => {
      calls.push({ shell, args, opts });
      const plan = o.spawn ? o.spawn(shell, args, opts) : { stdout: "готово\n", code: 0 };
      return makeChild(plan);
    },
    killTree: o.killTree || ((child) => kills.push(child.pid)),
    commandEnv: o.commandEnv || (() => ({})),
    findProgram: o.findProgram || ((name) => ({ found: true, path: "/usr/bin/" + name })),
    truncateText,
  });
  return { ...tools, calls, kills };
}

// Настоящий запуск: findProgram молчит, поэтому берётся системная оболочка.
function mkReal(over) {
  return createShellTools({
    fs,
    path,
    spawn,
    commandEnv: (over && over.commandEnv) || (() => ({})),
    findProgram: (over && over.findProgram) || (() => ({ found: false, reason: "нет" })),
    truncateText,
  });
}

(async () => {
  await test("stripAnsi: цвета, osc-ссылки и возврат каретки убраны, текст цел", () => {
    const t = mk();
    assert.strictEqual(t.stripAnsi("\x1b[31mошибка\x1b[0m"), "ошибка");
    assert.strictEqual(t.stripAnsi("\x1b[1;38;5;2mсборка\x1b[m прошла"), "сборка прошла");
    assert.strictEqual(t.stripAnsi("\x1b]8;;http://x\x07ссылка\x1b]8;;\x07"), "ссылка");
    assert.strictEqual(t.stripAnsi("строка1\r\nстрока2"), "строка1\nстрока2");
    assert.strictEqual(t.stripAnsi(undefined), "", "пустой ввод должен давать пустую строку");
    assert.strictEqual(t.stripAnsi("обычный текст (2 из 3)"), "обычный текст (2 из 3)", "текст испорчен");
  });

  await test("shellArgsFor: на Windows кодировка cp866→UTF-8, на других ОС — как было", () => {
    const t = mk();
    const args = t.shellArgsFor("npm test");
    if (process.platform === "win32") {
      assert.deepStrictEqual(args, ["/d", "/s", "/c", "chcp 65001>nul & npm test"]);
      assert.ok(args[3].endsWith("npm test"), "команда не доехала целиком: " + args[3]);
    } else {
      assert.deepStrictEqual(args, ["-c", "npm test"]);
    }
  });

  await test("normalizeShell: псевдонимы (в том числе русские), мусор — не оболочка", () => {
    const t = mk();
    assert.strictEqual(t.normalizeShell("PS"), "powershell");
    assert.strictEqual(t.normalizeShell(" pwsh "), "pwsh");
    assert.strictEqual(t.normalizeShell("powershell7"), "pwsh");
    assert.strictEqual(t.normalizeShell("git-bash"), "bash");
    assert.strictEqual(t.normalizeShell("КОМАНДНАЯ СТРОКА"), "cmd");
    assert.strictEqual(t.normalizeShell("баш"), "bash");
    assert.strictEqual(t.normalizeShell("zsh"), "sh");
    assert.strictEqual(t.normalizeShell("calc.exe"), "", "мусор стал оболочкой");
    assert.strictEqual(t.normalizeShell(null), "");
    assert.strictEqual(t.normalizeShell(""), "");
  });

  await test("powershellArgs: команда доезжает без искажений и с UTF-8 на выходе", () => {
    const t = mk();
    const cmd = 'Get-Process | Where-Object { $_.Name -eq "node" } 2>$null';
    const args = t.powershellArgs(cmd);
    assert.deepStrictEqual(args.slice(0, 6), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", args[5]]);
    const decoded = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    assert.ok(/OutputEncoding=\[System\.Text\.Encoding\]::UTF8/.test(decoded), "нет UTF-8 на выходе PowerShell");
    assert.ok(/ProgressPreference/.test(decoded), "прогресс-бар останется и сломает разбор");
    assert.ok(decoded.includes(cmd), "команда искажена: " + decoded);
    assert.strictEqual(t.powershellArgs(undefined).length, 6, "undefined сломал сборку аргументов");
  });

  await test("resolveShell: cmd по умолчанию, powershell без PATH не блокируется, bash ищется как Git", () => {
    const t = mk();
    const def = t.resolveShell("echo hi", "");
    assert.strictEqual(def.kind, process.platform === "win32" ? "cmd" : "sh");
    assert.strictEqual(def.missing, false, "оболочка по умолчанию не может быть missing");

    const ps = t.resolveShell("x", "powershell");
    assert.strictEqual(ps.shell, "/usr/bin/powershell", "найденный powershell не подставлен");
    assert.strictEqual(ps.shellHint, "");
    assert.strictEqual(ps.missing, false);

    const noPs = mk({ findProgram: () => ({ found: false, reason: "нет" }) });
    const psNo = noPs.resolveShell("x", "powershell");
    assert.ok(/installSystemPackage/.test(psNo.shellHint), "нет подсказки про установку PowerShell");
    assert.ok(/shell: "cmd"/.test(psNo.shellHint), "нет альтернативы cmd");
    assert.strictEqual(psNo.missing, false, "powershell нельзя блокировать по PATH: System32 ищется сам");

    const bash = t.resolveShell("echo $HOME", "bash");
    assert.strictEqual(bash.shell, "/usr/bin/bash", "Git-оболочка не подставлена");
    assert.deepStrictEqual(bash.args, ["-lc", "echo $HOME"]);
    assert.strictEqual(bash.missing, false);

    const sh = t.resolveShell("echo hi", "sh");
    assert.deepStrictEqual(sh.args, ["-c", "echo hi"]);
    assert.strictEqual(sh.missing, false);

    const none = mk({ findProgram: () => ({ found: false }), fs: { existsSync: () => false } });
    for (const kind of ["bash", "sh"]) {
      const r = none.resolveShell("x", kind);
      assert.strictEqual(r.kind, kind);
      assert.strictEqual(r.shell, kind, "при отсутствии не должно быть молчаливого отката");
      assert.strictEqual(r.missing, true, "нет флага missing у " + kind);
      assert.ok(r.shellHint.includes(kind), "подсказка не называет оболочку: " + r.shellHint);
    }
    if (process.platform === "win32") {
      assert.ok(none.resolveShell("x", "sh").shellHint.includes("Git for Windows"), "нет совета про Git for Windows");
    } else {
      const unix = mk({ findProgram: () => ({ found: false }), fs: { existsSync: (p) => p === "/bin/sh" } });
      const r = unix.resolveShell("echo hi", "sh");
      assert.strictEqual(r.shellHint, "", "на Unix /bin/sh не должен считаться отсутствующим");
      assert.ok(/bin\/sh/.test(r.shell), "нет пути к sh: " + r.shell);
    }
  });

  await test("findGitShell: PATH важнее догадки, sh и bash не путаются", () => {
    const t = mk();
    assert.strictEqual(t.findGitShell("bash"), "/usr/bin/bash");
    assert.strictEqual(t.findGitShell("sh"), "/usr/bin/sh");
    const none = mk({ findProgram: () => ({ found: false }), fs: { existsSync: (p) => p === "/bin/bash" || p === "/bin/sh" } });
    if (process.platform !== "win32") {
      assert.strictEqual(none.findGitShell("bash"), "/bin/bash", "нет отката на /bin/bash");
      assert.strictEqual(none.findGitShell("sh"), "/bin/sh", "нет отката на /bin/sh");
      // Ни PATH, ни /bin: путь пустой, и вызывающий получит подсказку, а не «код 1».
      const nothing = mk({ findProgram: () => ({ found: false }), fs: { existsSync: () => false } });
      assert.strictEqual(nothing.findGitShell("bash"), "", "выдуман путь к несуществующей оболочке");
    }
    const winLike = mk({ findProgram: () => ({ found: false }), fs: { existsSync: (p) => /Git[\\/]bin[\\/]bash\.exe$/.test(p) } });
    if (process.platform === "win32") {
      assert.ok(/bash\.exe$/.test(winLike.findGitShell("bash")), "нет поиска bash.exe внутри Git for Windows");
    }
  });

  await test("shellsStatus: состав отчёта, одна оболочка по умолчанию, советы для отсутствующих", () => {
    const win = process.platform === "win32";
    const all = mk();
    const st = all.shellsStatus();
    assert.deepStrictEqual(st.map((s) => s.kind), win ? ["cmd", "powershell", "pwsh", "bash", "sh"] : ["sh", "powershell", "pwsh", "bash"],
      "состав отчёта: " + st.map((s) => s.kind).join(","));
    assert.strictEqual(st.filter((s) => s.def).length, 1, "должна быть ровно одна оболочка по умолчанию");
    assert.strictEqual(st[0].def, true, "оболочка по умолчанию идёт первой");
    assert.ok(st.every((s) => s.available), "всё найдено, а отчёт говорит иначе");
    assert.ok(st.every((s) => s.hint === ""), "найденная оболочка получила совет: " + JSON.stringify(st));

    const none = mk({ findProgram: () => ({ found: false }), fs: { existsSync: () => false } });
    const st2 = none.shellsStatus();
    assert.ok(st2.every((s) => !s.available), "ничего не найдено, а отчёт говорит обратное");
    for (const s of st2) assert.ok(s.hint.length > 5, "нет совета для отсутствующей " + s.kind);

    const brief = all.shellsBrief();
    assert.ok(/^по умолчанию /.test(brief), "строка САММАРИ не начинается с «по умолчанию»: " + brief);
    assert.ok(brief.includes("доступно: "), "нет списка доступного: " + brief);
    assert.ok(brief.includes("powershell"), "в САММАРИ нет powershell");
    assert.ok(/параметр shell у runCommand\/startBackground/.test(brief), "агент не узнает, как выбрать оболочку");
    assert.ok(!none.shellsBrief().includes("powershell"), "отсутствующая оболочка попала в САММАРИ: " + none.shellsBrief());
  });

  await test("runTerminalCommand: в запуск уходит оболочка, окружение команды, СВОЯ ГРУППА и лимиты", async () => {
    const env = { PATH: "/usr/bin", MY_TOKEN: "с" };
    const t = mk({ commandEnv: () => env });
    await t.runTerminalCommand("npm test", "/tmp", 5000, "sh");
    assert.strictEqual(t.calls.length, 1, "запуск не один: " + t.calls.length);
    const c = t.calls[0];
    assert.strictEqual(c.shell, "/usr/bin/sh", "запуск ушёл не в выбранную оболочку: " + c.shell);
    assert.deepStrictEqual(c.args, ["-c", "npm test"], "аргументы оболочки неверны");
    assert.strictEqual(c.opts.cwd, "/tmp", "рабочая папка не передана");
    assert.strictEqual(c.opts.timeout, undefined, "таймаут теперь наш: у spawn его нет");
    assert.strictEqual(c.opts.env, env, "команда запущена без окружения команды");
    assert.strictEqual(c.opts.windowsHide, true, "окно консоли будет мелькать");
    // Своя группа процессов — условие, по которому таймаут гасит ДЕРЕВО. Без неё
    // сигнал уходит не туда и ребёнок оболочки остаётся жить (это и был баг).
    assert.strictEqual(c.opts.detached, process.platform !== "win32", "у команды нет своей группы процессов");
    assert.strictEqual(c.opts.stdio[1], "pipe", "вывод команды не читается: " + JSON.stringify(c.opts.stdio));
    assert.strictEqual(c.opts.stdio[2], "pipe", "stderr команды не читается: " + JSON.stringify(c.opts.stdio));
    assert.strictEqual(c.opts.stdio[0], "ignore", "stdin не закрыт: «cat» будет ждать ввода до таймаута");
    assert.strictEqual(c.opts.maxBuffer, undefined, "maxBuffer у spawn не действует — вводит в заблуждение");
    const def = mk();
    await def.runTerminalCommand("x", "/tmp");
    assert.strictEqual(def.calls.length, 1, "запуск по умолчанию не один");
  });

  await test("runTerminalCommand: таймаут гасит ДЕРЕВО, а если процесс не умер — отвечает всё равно", async () => {
    // Обычный случай: команда не завершается сама, таймаут гасит её дерево, и на
    // этом же сигнале приходит закрытие процесса.
    const kills = [];
    const t = mk({
      spawn: () => ({ stdout: "сервер пошёл\n", never: true }),
      killTree: (child) => { kills.push(child.pid); child.emit("close", null, "SIGTERM"); },
    });
    const r = await t.runTerminalCommand("node server.js", "/tmp", 40);
    assert.deepStrictEqual(kills, [4242], "таймаут не погасил дерево процесса: " + JSON.stringify(kills));
    assert.ok(/^Команда завершилась с кодом таймаут \(/.test(r), "таймаут назван не так: " + JSON.stringify(r));
    assert.ok(r.includes("сервер пошёл"), "вывод, который успел прийти, потерян: " + r);
    assert.ok(/вместе с дочерними процессами/.test(r), "не сказано, что дерево погашено: " + r);

    // Процесс, который не умер даже после сигнала: инструмент агента обязан ответить,
    // а не висеть вечно (иначе агент ждёт до остановки приложения).
    const stuck = mk({ spawn: () => ({ never: true }), killTree: (child) => kills.push(child.pid) });
    const t0 = Date.now();
    const r2 = await stuck.runTerminalCommand("node server.js", "/tmp", 40);
    const spent = Date.now() - t0;
    assert.ok(/кодом таймаут/.test(r2), "зависший процесс не объяснён: " + JSON.stringify(r2));
    assert.ok(spent < 3000, "ответ ждал слишком долго: " + spent + " мс (инструмент повиснет)");
    assert.strictEqual(kills.length, 2, "дерево зависшего процесса не гасили: " + JSON.stringify(kills));
  });

  await test("runTerminalCommand: вывод сверх предела останавливает команду, а не память", async () => {
    // Раньше предел держал maxBuffer у execFile. Теперь накопитель наш, и предел
    // обязан работать: иначе одна болтливая сборка съест память приложения.
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    const kills = [];
    const t = mk({
      spawn: () => ({ chunks: Array.from({ length: 34 }, () => chunk), never: true }),
      killTree: (child) => { kills.push(child.pid); child.emit("close", null, "SIGTERM"); },
    });
    const r = await t.runTerminalCommand("болтливая сборка", "/tmp", 5000);
    assert.strictEqual(kills.length, 1, "предел вывода не остановил команду");
    assert.ok(/превысил 32 МБ/.test(r), "предел вывода не назван: " + r.slice(0, 140));
    assert.ok(r.length < 4000, "многоточие балласта уехало в ответ: " + r.length);
  });

  await test("runTerminalCommand: ответ агента — вывод, код возврата и время", async () => {
    const ok = mk({ spawn: () => ({ stdout: "собрано\n", code: 0 }) });
    const r1 = await ok.runTerminalCommand("build", "/tmp");
    assert.ok(/^собрано \([\d.]+ с\)$/.test(r1), "успех подан не так: " + JSON.stringify(r1));

    const both = mk({ spawn: () => ({ stdout: "вывод", stderr: "предупреждение", code: 0 }) });
    const r2 = await both.runTerminalCommand("build", "/tmp");
    assert.ok(/^вывод\n\n\[stderr\]\nпредупреждение \(/.test(r2), "stderr не отделён: " + JSON.stringify(r2));

    const quiet = mk({ spawn: () => ({ stdout: "", stderr: "", code: 0 }) });
    assert.ok(/^Готово \(без вывода\)\. \(/.test(await quiet.runTerminalCommand("x", "/tmp")), "пустой вывод не объяснён");

    const bad = mk({ spawn: () => ({ stdout: "часть вывода", stderr: "ошибка компиляции", code: 2 }) });
    const r3 = await bad.runTerminalCommand("build", "/tmp");
    assert.ok(/^Команда завершилась с кодом 2 \(/.test(r3), "код возврата не назван: " + JSON.stringify(r3));
    assert.ok(r3.includes("часть вывода") && r3.includes("ошибка компиляции"), "вывод потерян: " + r3);

    // Отказ без вывода: агент обязан понять, что дело в коде возврата, а не в обрыве.
    const silent = mk({ spawn: () => ({ code: 3 }) });
    const rSilent = await silent.runTerminalCommand("x", "/tmp");
    assert.ok(/^Команда завершилась с кодом 3 \(/.test(rSilent), "код возврата не назван: " + JSON.stringify(rSilent));
    assert.ok(/завершилась молча/.test(rSilent), "отказ без вывода не объяснён: " + rSilent);

    // Смерть от чужого сигнала: говорим сигналом, а не выдуманным кодом.
    const signalled = mk({ spawn: () => ({ code: null, signal: "SIGSEGV" }) });
    const rSig = await signalled.runTerminalCommand("x", "/tmp");
    assert.ok(/SIGSEGV/.test(rSig), "сигнал не назван: " + rSig);

    // Ошибки запуска (ENOENT) не пишут в stderr — они обязаны попасть в ответ.
    const enoent = mk({ spawn: () => ({ error: Object.assign(new Error("spawn нет ENOENT"), { code: "ENOENT" }) }) });
    const r4 = await enoent.runTerminalCommand("x", "/tmp");
    assert.ok(/ENOENT/.test(r4), "причина запуска не попала в ответ: " + r4);
    assert.ok(!/не найден/.test(r4), "оболочка найдена — подсказки про установку быть не должно: " + r4);

    // Оболочки нет: к отказу приклеивается человеческое объяснение, а не «код 1».
    const noShell = createShellTools({
      fs: { existsSync: () => false },
      path,
      spawn: () => makeChild({ error: Object.assign(new Error("spawn bash ENOENT"), { code: "ENOENT" }) }),
      killTree: () => {},
      commandEnv: () => ({}),
      findProgram: () => ({ found: false, reason: "нет" }),
      truncateText,
    });
    const r5 = await noShell.runTerminalCommand("x", "/tmp", 1000, "bash");
    assert.ok(r5.includes("bash не найден"), "нет подсказки про отсутствующую оболочку: " + r5);
    assert.ok(/installSystemPackage/.test(r5), "подсказка не говорит, что делать: " + r5);

    // Обрезка — общее правило проекта (truncateText), и оно одинаково для успеха и
    // ошибки: предел 6000 символов ПЛЮС честная пометка, сколько было всего.
    // Молчаливо обрезанный вывод модель читает как закончившийся на середине.
    const long = mk({ spawn: () => ({ stdout: "я".repeat(20000), code: 0 }) });
    const r6 = await long.runTerminalCommand("x", "/tmp");
    assert.ok(r6.length < 6200, "длинный успешный вывод уедет в контекст целиком: " + r6.length);
    assert.ok(/… \(обрезано: 20000 символов\)/.test(r6), "обрезка не названа честно: " + r6.slice(-90));
    assert.ok(/^я/.test(r6), "начало вывода потеряно: " + r6.slice(0, 40));
    assert.ok(/\(\d+\.\d с\)$/.test(r6), "время выполнения потерялось при обрезке: " + r6.slice(-40));

    const shortOut = mk({ spawn: () => ({ stdout: "короткий вывод\n", code: 0 }) });
    const rShort = await shortOut.runTerminalCommand("x", "/tmp");
    assert.ok(!/обрезано/.test(rShort), "короткий вывод помечен обрезанным: " + rShort);

    // Длинный stdout ВМЕСТЕ с длинным stderr: обрезка идёт по каждому потоку
    // отдельно, иначе stdout съел бы stderr — а ошибка сборки как раз там.
    const bothLong = mk({ spawn: () => ({ stdout: "в".repeat(9000), stderr: "о".repeat(9000), code: 0 }) });
    const rBoth = await bothLong.runTerminalCommand("x", "/tmp");
    assert.ok(rBoth.length < 6300, "вывод со stderr уехал целиком: " + rBoth.length);
    assert.ok(/\[stderr\]/.test(rBoth), "раздел stderr пропал при обрезке: " + rBoth.slice(-90));
    assert.ok(/в{5}[\s\S]*… \(обрезано: 9000 символов\)[\s\S]*\n\n\[stderr\]\n[\s\S]*о{5}/.test(rBoth),
      "порядок «stdout → пометка → [stderr] → stderr» нарушен: " + rBoth.slice(0, 120) + " … " + rBoth.slice(-120));
    assert.ok((rBoth.match(/… \(обрезано: 9000 символов\)/g) || []).length === 2, "пометки есть не у обоих потоков");
    assert.ok(/\(\d+\.\d с\)$/.test(rBoth), "время выполнения потерялось: " + rBoth.slice(-40));

    // Ошибка: вывод обрезан, а текст исключения и код возврата на месте.
    const longErr = mk({ spawn: () => ({ stdout: "я".repeat(20000), code: 1 }) });
    const r7 = await longErr.runTerminalCommand("x", "/tmp");
    assert.ok(r7.length < 4000, "длинный вывод ошибки не обрезан: " + r7.length);
    assert.ok(/… \(обрезано: 20000 символов\)/.test(r7), "обрезка ошибки не названа честно: " + r7.slice(-90));
    assert.ok(/^Команда завершилась с кодом 1/.test(r7), "код возврата потерялся при обрезке: " + r7.slice(0, 60));

    // Ошибка со stderr: в отказ обязан доехать именно stderr (там текст ошибки),
    // даже если stdout в десять раз длиннее.
    const errBoth = mk({ spawn: () => ({ stdout: "п".repeat(20000), stderr: "ОШИБКА КОМПИЛЯЦИИ", code: 2 }) });
    const r8 = await errBoth.runTerminalCommand("x", "/tmp");
    assert.ok(r8.includes("ОШИБКА КОМПИЛЯЦИИ"), "stderr потерялся в отказе: " + r8.slice(-160));
    assert.ok(r8.length < 4000, "отказ со stderr уехал целиком: " + r8.length);

    // Длинный stderr в ветке ошибки режется так же, и пометка называет его длину.
    const errLong = mk({ spawn: () => ({ stdout: "кратко", stderr: "е".repeat(20000), code: 3 }) });
    const r9 = await errLong.runTerminalCommand("x", "/tmp");
    assert.ok(r9.length < 4000, "длинный stderr в отказе уехал целиком: " + r9.length);
    assert.ok(/… \(обрезано: 20000 символов\)/.test(r9), "обрезка stderr в отказе не названа: " + r9.slice(-90));
  });

  await test("runTerminalCommand: настоящие процессы — успех, отказ и время", async () => {
    const t = mkReal();
    const ok = await t.runTerminalCommand('node -e "console.log(1+1)"', ROOT);
    assert.ok(/^2 \(/.test(ok), "настоящий успех подан не так: " + JSON.stringify(ok));
    const bad = await t.runTerminalCommand('node -e "process.exit(7)"', ROOT);
    assert.ok(/^Команда завершилась с кодом 7 \(/.test(bad), "настоящий код возврата не назван: " + JSON.stringify(bad));
    const { execFileSync } = require("child_process");
    const echo = execFileSync(process.platform === "win32" ? "cmd" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/s", "/c", "echo привет"] : ["-c", "echo привет"], { encoding: "utf8" });
    assert.ok(echo.includes("привет"), "оболочка хоста не работает — проверка бессмысленна");
  });

  await test("runTerminalCommand: таймаут гасит ДЕРЕВО настоящих процессов, а не только оболочку", async () => {
    // Это и есть та находка, из-за которой execFile заменён на spawn: у команды
    // агента бывают дети (node/tsc/dev-сервер). Если таймаут гасит только оболочку,
    // ребёнок остаётся жить и держит порт, а в фоновых процессах его нет — значит,
    // остановить его агенту нечем, и следующая попытка получает «порт занят».
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-tree-"));
    const pidFile = path.join(dir, "child.pid");
    fs.writeFileSync(
      path.join(dir, "child.js"),
      "const fs=require('fs');fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);",
      "utf8"
    );
    const t = mkReal();
    const r = await t.runTerminalCommand('node child.js "' + pidFile + '"', dir, 1200);
    assert.ok(/кодом таймаут/.test(r), "таймаут не назван: " + JSON.stringify(r));
    // SIGKILL догоняющему сигналу нужна секунда с небольшим — ждём и смотрим на факт.
    await sleep(1600);
    const pid = Number(String(fs.readFileSync(pidFile, "utf8")).trim());
    assert.ok(pid > 0, "ребёнок не записал свой pid — проверка бессмысленна");
    const stillAlive = alive(pid);
    if (stillAlive) { try { process.kill(pid, "SIGKILL"); } catch {} }   // своя уборка
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(!stillAlive, "после таймаута ребёнок оболочки жив (PID " + pid + ") — держит порт, и остановить его нечем");
  });

  await test("живое окружение команды: секрет не уходит в команду-дамп", async () => {
    // Модуль обязан звать commandEnv в момент запуска (окружение меняется по ходу
    // работы), а не брать снимок один раз при сборке.
    let calls = 0;
    const env = { PATH: "/usr/bin" };
    const t = mk({ commandEnv: () => { calls++; return env; } });
    await t.runTerminalCommand("env", "/tmp");
    await t.runTerminalCommand("env", "/tmp");
    assert.strictEqual(calls, 2, "окружение команды взято не в момент запуска: " + calls);
    assert.strictEqual(t.calls[1].opts.env, env, "в запуск ушёл не тот набор переменных");
  });

  await test("в main.js этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["function stripAnsi(", "function shellArgsFor(", "function SHELL_KINDS",
      "function normalizeShell(", "function powershellArgs(", "function findGitShell(",
      "function shellMissingHint(", "function resolveShell(", "function shellsStatus(",
      "function shellsBrief(", "function runTerminalCommand("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createShellTools \} = require\("\.\/shell-tools\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    // Список имён сверяем ЦЕЛИКОМ: проверка «подстрока где-то есть» пропустила бы
    // закомментированное имя внутри той же строки.
    assert.ok(
      /const \{ stripAnsi, shellArgsFor, normalizeShell, powershellArgs, findGitShell, shellMissingHint,\n  resolveShell, shellsStatus, shellsBrief, runTerminalCommand \} = createShellTools\(\{/.test(MAIN_SRC),
      "из модуля взяты не все имена или проводка переписана"
    );
    const wiring = /const \{ createShellTools \} = require\("\.\/shell-tools\.js"\);[\s\S]*?\n\}\);/.exec(MAIN_SRC);
    assert.ok(wiring, "не нашёл проводку модуля оболочек");
    for (const dep of ["  fs,", "  path,", "  spawn,", "  commandEnv,", "  findProgram: (name) => findProgram(name),", "  truncateText,"]) {
      assert.ok(wiring[0].includes(dep), "в проводку не передано: " + dep);
    }
    assert.ok(/findProgram: \(name\) => findProgram\(name\)/.test(MAIN_SRC),
      "без отложенной стрелки оболочки упадут на сборке: system-stack собирается ниже");
    assert.ok(/const \{ createShellTools \} = require\("\.\/shell-tools\.js"\);\n/.test(MAIN_SRC), "подключение не отдельной строкой");
    // Таймаут по умолчанию (120 с) поведенчески не проверить — ждать две минуты.
    // Агент полагается на это число, поэтому сторожится дословно.
    assert.ok(/timeoutMs \|\| 120000/.test(SHELL_SRC), "таймаут команды по умолчанию изменился");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

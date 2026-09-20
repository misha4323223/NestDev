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

   Проверки двух видов: поддельный execFile (что именно передано в запуск) и
   настоящий процесс (что агент увидит в ответе). */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { createShellTools } = require(path.join(ROOT, "src", "shell-tools.js"));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
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

// Модуль с подменённым execFile: видно, что именно уходит в запуск.
function mk(over) {
  const calls = [];
  const o = over || {};
  const tools = createShellTools({
    fs: o.fs || fs,
    path,
    execFile: (shell, args, opts, cb) => {
      calls.push({ shell, args, opts });
      if (o.execFile) return o.execFile(shell, args, opts, cb);
      cb(null, "готово\n", "");
    },
    commandEnv: o.commandEnv || (() => ({})),
    findProgram: o.findProgram || ((name) => ({ found: true, path: "/usr/bin/" + name })),
  });
  return { ...tools, calls };
}

// Настоящий запуск: findProgram молчит, поэтому берётся системная оболочка.
function mkReal(over) {
  return createShellTools({
    fs,
    path,
    execFile,
    commandEnv: (over && over.commandEnv) || (() => ({})),
    findProgram: (over && over.findProgram) || (() => ({ found: false, reason: "нет" })),
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

  await test("runTerminalCommand: в запуск уходит оболочка, окружение команды и лимиты", async () => {
    const env = { PATH: "/usr/bin", MY_TOKEN: "с" };
    const t = mk({ commandEnv: () => env });
    await t.runTerminalCommand("npm test", "/tmp", 5000, "sh");
    assert.strictEqual(t.calls.length, 1, "запуск не один: " + t.calls.length);
    const c = t.calls[0];
    assert.strictEqual(c.shell, "/usr/bin/sh", "запуск ушёл не в выбранную оболочку: " + c.shell);
    assert.deepStrictEqual(c.args, ["-c", "npm test"], "аргументы оболочки неверны");
    assert.strictEqual(c.opts.cwd, "/tmp", "рабочая папка не передана");
    assert.strictEqual(c.opts.timeout, 5000, "таймаут не передан");
    assert.strictEqual(c.opts.env, env, "команда запущена без окружения команды");
    assert.strictEqual(c.opts.windowsHide, true, "окно консоли будет мелькать");
    assert.ok(c.opts.maxBuffer >= 1024 * 1024, "буфер вывода слишком мал: " + c.opts.maxBuffer);
    const def = mk();
    await def.runTerminalCommand("x", "/tmp");
    assert.strictEqual(def.calls[0].opts.timeout, 120000, "таймаут по умолчанию изменился");
  });

  await test("runTerminalCommand: ответ агента — вывод, код возврата и время", async () => {
    const ok = mk({ execFile: (s, a, o, cb) => cb(null, "собрано\n", "") });
    const r1 = await ok.runTerminalCommand("build", "/tmp");
    assert.ok(/^собрано \([\d.]+ с\)$/.test(r1), "успех подан не так: " + JSON.stringify(r1));

    const both = mk({ execFile: (s, a, o, cb) => cb(null, "вывод", "предупреждение") });
    const r2 = await both.runTerminalCommand("build", "/tmp");
    assert.ok(/^вывод\n\n\[stderr\]\nпредупреждение \(/.test(r2), "stderr не отделён: " + JSON.stringify(r2));

    const quiet = mk({ execFile: (s, a, o, cb) => cb(null, "", "") });
    assert.ok(/^Готово \(без вывода\)\. \(/.test(await quiet.runTerminalCommand("x", "/tmp")), "пустой вывод не объяснён");

    const bad = mk({ execFile: (s, a, o, cb) => { const e = new Error("провал"); e.code = 2; cb(e, "часть вывода", "ошибка компиляции"); } });
    const r3 = await bad.runTerminalCommand("build", "/tmp");
    assert.ok(/^Команда завершилась с кодом 2 \(/.test(r3), "код возврата не назван: " + JSON.stringify(r3));
    assert.ok(r3.includes("часть вывода") && r3.includes("ошибка компиляции"), "вывод потерян: " + r3);

    const killed = mk({ execFile: (s, a, o, cb) => { const e = new Error("killed"); e.killed = true; cb(e, "", ""); } });
    assert.ok(/кодом таймаут/.test(await killed.runTerminalCommand("x", "/tmp")), "таймаут не назван таймаутом");

    // Ошибки запуска (ENOENT) не пишут в stderr — они обязаны попасть в ответ.
    const enoent = mk({ execFile: (s, a, o, cb) => { const e = new Error("spawn нет ENOENT"); e.code = "ENOENT"; cb(e, "", ""); } });
    const r4 = await enoent.runTerminalCommand("x", "/tmp");
    assert.ok(/ENOENT/.test(r4), "причина запуска не попала в ответ: " + r4);
    assert.ok(!/не найден/.test(r4), "оболочка найдена — подсказки про установку быть не должно: " + r4);

    // Оболочки нет: к отказу приклеивается человеческое объяснение, а не «код 1».
    const noShell = createShellTools({
      fs: { existsSync: () => false },
      path,
      execFile: (s, a, o, cb) => { const e = new Error("spawn bash ENOENT"); e.code = "ENOENT"; cb(e, "", ""); },
      commandEnv: () => ({}),
      findProgram: () => ({ found: false, reason: "нет" }),
    });
    const r5 = await noShell.runTerminalCommand("x", "/tmp", 1000, "bash");
    assert.ok(r5.includes("bash не найден"), "нет подсказки про отсутствующую оболочку: " + r5);
    assert.ok(/installSystemPackage/.test(r5), "подсказка не говорит, что делать: " + r5);

    // Граница обрезки: у ОШИБКИ вывод режется (6000 символов), у успеха — нет.
    // Это прежнее поведение, а не следствие выноса: записываем как есть, чтобы
    // правка обрезки была отдельным решением, а не проехала молча.
    const long = mk({ execFile: (s, a, o, cb) => cb(null, "я".repeat(20000), "") });
    const r6 = await long.runTerminalCommand("x", "/tmp");
    assert.ok(r6.length > 6000, "успех начал обрезаться — это уже другое поведение: " + r6.length);
    const longErr = mk({ execFile: (s, a, o, cb) => { const e = new Error("провал"); e.code = 1; cb(e, "я".repeat(20000), ""); } });
    const r7 = await longErr.runTerminalCommand("x", "/tmp");
    assert.ok(r7.length < 7000, "длинный вывод ошибки не обрезан: " + r7.length);
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
    for (const dep of ["  fs,", "  path,", "  execFile,", "  commandEnv,", "  findProgram: (name) => findProgram(name),"]) {
      assert.ok(wiring[0].includes(dep), "в проводку не передано: " + dep);
    }
    assert.ok(/findProgram: \(name\) => findProgram\(name\)/.test(MAIN_SRC),
      "без отложенной стрелки оболочки упадут на сборке: system-stack собирается ниже");
    assert.ok(/const \{ createShellTools \} = require\("\.\/shell-tools\.js"\);\n/.test(MAIN_SRC), "подключение не отдельной строкой");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

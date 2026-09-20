"use strict";

/* ─── Оболочки и запуск команд ───────────────────────────────────────────────
   Вынесено из main.js (этап B, часть 23 — заход в «Выполнение инструментов»).

   Здесь живёт ОДНА точка правды о том, ЧЕМ запускается команда агента:

     • какой диалект выбран (cmd / powershell / pwsh / bash / sh) и как он
       принимается по-русски («командная строка», «баш») — иначе модель пишет
       shell: "Bash", а запуск уходит в cmd;
     • кодировка. cmd по умолчанию отдаёт CP866, PowerShell — свою страницу
       кода; без переключения кириллица в выводе превращается в кашу, и агент
       читает мусор вместо ошибки сборки. Команда для PowerShell передаётся
       -EncodedCommand (UTF-16LE base64) — это снимает ВСЕ проблемы с кавычками,
       $ и 2>$null;
     • есть ли оболочка в системе. Нет bash без Git for Windows — оболочка
       возвращает { missing: true } и человеческую подсказку, а не «код 1» без
       объяснения: раньше sh молча уходил в /bin/sh, которого на Windows нет;
     • что вообще доступно на машине (shellsStatus) — агент спрашивает один раз,
       а не выясняет методом тыка.

   Запуск произвольной команды: текстом, с кодом завершения и временем.
   Ошибки запуска (ENOENT/EACCES/EINVAL) не пишут в stderr — они попадают в
   ответ отдельно, иначе агент видел пустой вывод и не понимал причину.

     • **вывод команды уехал в контекст целиком.** Сборка или тесты печатают
       мегабайты, и без обрезки они вытесняют всю переписку. Режем тем же правилом,
       что и остальные инструменты (`truncateText`), и ЧЕСТНО говорим, сколько было:
       молчаливо обрезанный вывод модель читает как закончившийся на середине.
       Раньше это правило стояло только в ветке ошибки — успешный вывод уходил
       целиком (исправлено 1.5.178, отдельным решением, не за выносом).

   findProgram приходит функцией-обёрткой: системный раздел (system-stack.js)
   собирается НИЖЕ по файлу оболочки, а оболочки нужны уже здесь — модулю их
   берёг tool-helpers, фоновые процессы и САММАРИ проекта. */

function createShellTools(deps) {
  const { fs, path, execFile, commandEnv, findProgram, truncateText } = deps;

// Предел вывода, который уезжает в контекст. Правило то же, что у инструментов
// (truncateText из ядра): обрезать и назвать, сколько символов было всего.
// Обрезаем НЕ склейку, а каждый поток отдельно: иначе длинный stdout съел бы
// stderr, а ошибка сборки как раз там, и модель увидела бы только прогресс.
const MAX_OUT = 6000;
const PART_OUT = 3000;
const clip = (text, cap) => truncateText(text, cap || MAX_OUT);

// Чистит ANSI-escape-последовательности (цвета npm-сборок и т.п.) из вывода терминала.
function stripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

// Кодировка консоли Windows: cmd по умолчанию отдаёт CP866, и кириллица в выводе
// команд превращается в кашу («set | findstr», git, сборки). Переключаем страницу
// кода на UTF-8 прямо в команде. На других ОС аргументы как были.
function shellArgsFor(command) {
  if (process.platform === "win32") return ["/d", "/s", "/c", "chcp 65001>nul & " + command];
  return ["-c", command];
}

// Оболочка для runCommand/startBackground: cmd (по умолчанию на Windows),
// powershell/pwsh, bash, sh. Псевдонимы принимаются и по-русски.
const SHELL_KINDS = {
  cmd: "cmd", "командная строка": "cmd", консоль: "cmd", dos: "cmd",
  powershell: "powershell", ps: "powershell", ps1: "powershell", "пс": "powershell",
  pwsh: "pwsh", powershell7: "pwsh", ps7: "pwsh",
  bash: "bash", gitbash: "bash", "git-bash": "bash", "баш": "bash",
  sh: "sh", zsh: "sh", dash: "sh",
};

function normalizeShell(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  if (!key) return "";
  return SHELL_KINDS[key] || "";
}

// PowerShell: включаем UTF-8 на выходе (иначе кириллица в pipe превращается в
// кашу, как в cmd с CP866) и запрещаем прогресс-бар, который ломает парсинг.
// Команда передаётся через -EncodedCommand (UTF-16LE base64): это снимает ВСЕ
// проблемы с кавычками, $ и 2>$null, из-за которых раньше приходилось писать
// .ps1-файлы на каждое действие.
const PS_PRELUDE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$ProgressPreference='SilentlyContinue'; ";

function powershellArgs(command) {
  const script = PS_PRELUDE + String(command || "");
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc];
}

// bash/sh из Git for Windows (там же, где git) — чтобы shell: "bash"/"sh" работали
// без PATH. Возвращает абсолютный путь или "" (не найдено нигде).
function findGitShell(which) {
  const name = which === "sh" ? "sh" : "bash";
  if (process.platform !== "win32") {
    const inPath = findProgram(name).path;
    if (inPath) return inPath;
    const direct = name === "sh" ? "/bin/sh" : "/bin/bash";
    try { if (fs.existsSync(direct)) return direct; } catch {}
    return "";
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const home = process.env.USERPROFILE || "";
  const roots = [
    path.join(pf, "Git"),
    path.join(pf86, "Git"),
    home ? path.join(home, "AppData", "Local", "Programs", "Git") : "",
  ].filter(Boolean);
  // Порядок как у самого Git: сначала bin, затем usr/bin (там же лежит sh).
  const subs = name === "sh"
    ? [["usr", "bin", "sh.exe"], ["bin", "sh.exe"]]
    : [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]];
  for (const root of roots) {
    for (const sub of subs) {
      const cand = path.join(root, ...sub);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return findProgram(name).path || "";
}

// Человеческое объяснение, почему оболочки нет (попадает в ответ инструмента).
function shellMissingHint(which) {
  if (process.platform === "win32") {
    return (
      which + " не найден. Поставь Git for Windows (installSystemPackage(\"git\")) — " + which +
      " идёт вместе с ним; либо используй shell: \"powershell\" или \"cmd\"."
    );
  }
  return which + " не найден: ни в PATH, ни в /bin. Проверь установку (installSystemPackage).";
}

// Единая точка выбора оболочки → { kind, shell, args, shellHint }.
// shellHint — человеческое объяснение, если оболочки нет в системе.
function resolveShell(command, shellName) {
  const kind = normalizeShell(shellName) || (process.platform === "win32" ? "cmd" : "sh");
  if (kind === "cmd") {
    return { kind, shell: process.env.ComSpec || "cmd.exe", args: shellArgsFor(command), shellHint: "", missing: false };
  }
  if (kind === "powershell" || kind === "pwsh") {
    const probe = findProgram(kind === "pwsh" ? "pwsh" : "powershell");
    return {
      kind,
      shell: probe.found ? probe.path : kind === "pwsh" ? "pwsh" : "powershell",
      args: powershellArgs(command),
      shellHint: probe.found
        ? ""
        : "PowerShell не найден в PATH. Варианты: installSystemPackage(\"pwsh\") для PowerShell 7 или shell: \"cmd\".",
      // missing намеренно false: Windows ищет powershell.exe в System32 независимо
      // от PATH, и жёсткая блокировка дала бы ложный отказ на рабочей машине.
      missing: false,
    };
  }
  if (kind === "bash" || kind === "sh") {
    // На Windows sh живёт там же, где bash (Git for Windows). Раньше sh молча
    // уходил в /bin/sh, которого на Windows нет: агент получал ENOENT вообще
    // без объяснения. Теперь и sh ищется как Git-оболочка и получает подсказку.
    const found = findGitShell(kind);
    return {
      kind,
      shell: found || kind,
      args: kind === "sh" ? ["-c", command] : ["-lc", command],
      shellHint: found ? "" : shellMissingHint(kind),
      missing: !found,
    };
  }
  return { kind: "sh", shell: "/bin/sh", args: ["-c", command], shellHint: "", missing: false };
}

// Какие оболочки реально есть на этой машине: агент спрашивает один раз
// (инструмент shellsStatus), а не выясняет методом тыка.
function shellsStatus() {
  const win = process.platform === "win32";
  const defKind = win ? "cmd" : "sh";
  const defPath = win ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  let defOk = true;
  if (!win) {
    try { defOk = fs.existsSync("/bin/sh"); } catch { defOk = false; }
  }
  const list = [{ kind: defKind, available: defOk, path: defPath, def: true, hint: defOk ? "" : shellMissingHint("sh") }];
  const seen = { [defKind]: true };
  for (const k of ["powershell", "pwsh"]) {
    const p = findProgram(k);
    if (seen[k]) continue;
    seen[k] = true;
    list.push({ kind: k, available: !!p.found, path: p.path || "", def: false, hint: p.found ? "" : "Установи PowerShell 7: installSystemPackage(\"pwsh\")." });
  }
  for (const k of ["bash", "sh"]) {
    if (seen[k]) continue;
    seen[k] = true;
    const f = findGitShell(k);
    list.push({ kind: k, available: !!f, path: f || "", def: false, hint: f ? "" : shellMissingHint(k) });
  }
  return list;
}

// Короткая строка для САММАРИ ПРОЕКТА: что доступно, чтобы агент не гадал.
function shellsBrief() {
  const win = process.platform === "win32";
  const names = [win ? "cmd" : "sh"];
  for (const k of ["powershell", "pwsh"]) if (findProgram(k).found) names.push(k);
  for (const k of ["bash", "sh"]) if (findGitShell(k)) names.push(k);
  const uniq = names.filter((n, i) => names.indexOf(n) === i);
  return "по умолчанию " + (win ? "cmd" : "sh") + "; доступно: " + uniq.join(", ") + " (параметр shell у runCommand/startBackground)";
}

// Запуск произвольной команды в терминале (без интерактива).
// Возвращает текст с кодом завершения и временем выполнения.
function runTerminalCommand(command, cwd, timeoutMs, shellName) {
  return new Promise((resolve) => {
    const sh = resolveShell(command, shellName);
    const shell = sh.shell;
    const args = sh.args;
    const start = Date.now();
    execFile(shell, args, {
      cwd,
      timeout: timeoutMs || 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: commandEnv(command),
    }, (err, stdout, stderr) => {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      const timeNote = " (" + secs + " с)";
      const out = stripAnsi(stdout || "").trim();
      const errText = stripAnsi(stderr || "").trim();
      if (!err) {
        // Обрезка — ДО времени: отметка «(0.4 с)» обязана остаться видимой,
        // иначе по ответу не понять, сколько команда работала.
        if (out && errText) resolve(clip(out, PART_OUT) + "\n\n[stderr]\n" + clip(errText, PART_OUT) + timeNote);
        else resolve(clip(out || errText || "Готово (без вывода).") + timeNote);
      } else {
        const code = err.killed ? "таймаут" : err.code == null ? 1 : err.code;
        const parts = [];
        if (out) parts.push(clip(out, PART_OUT));
        if (errText) parts.push(clip(errText, PART_OUT));
        // Ошибки запуска (ENOENT/EACCES/EINVAL) не пишут в stderr — без этого
        // агент видел пустой вывод и не мог понять причину.
        if (!errText && err.message) parts.push(String(err.message));
        if (!parts.length) parts.push(err.message || String(err));
        const shHint = (err.code === "ENOENT" || sh.missing === true) && sh.shellHint ? "\n\n" + sh.shellHint : "";
        // Части уже обрезаны по отдельности (см. выше) — здесь только склейка:
        // второй обрезки нет, иначе хвост терял бы пометку о своей длине.
        resolve("Команда завершилась с кодом " + code + timeNote + ":\n" + parts.join("\n") + shHint);
      }
    });
  });
}

  return {
    stripAnsi,
    shellArgsFor,
    normalizeShell,
    powershellArgs,
    findGitShell,
    shellMissingHint,
    resolveShell,
    shellsStatus,
    shellsBrief,
    runTerminalCommand,
  };
}

module.exports = { createShellTools };

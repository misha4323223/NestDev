"use strict";

/* ─── Инструменты агента: команды, оболочка и фоновые процессы ───────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 4): shellsStatus, runCommand, runCommandOutput, runCommandAsAdmin,
   runScript, startBackground, listBackground, backgroundOutput, sendInput,
   stopBackground, shellStart, shellSend, waitUntil, timeoutCommand, retryCommand.

   ЖИВОЙ МОСТ НЕ НУЖЕН: ни один из этих обработчиков не читает состояние прогона —
   всё, что им нужно, приходит в `deps` тем же плоским объектом, что и в
   agent-tools.js. Поэтому модуль собирается в обычном Node и проверяется живым
   прогоном на настоящем main.js с настоящими командами.

   ПОЧЕМУ ССЫЛКИ, А НЕ СПРЕД. Записи идут в реестре несколькими несмежными кусками
   (shellsStatus перед runCommand; фоновые подряд; runCommandOutput отдельно;
   runCommandAsAdmin/timeoutCommand/retryCommand и runScript — своими местами;
   waitUntil — ближе к концу реестра), поэтому в реестре на прежнем месте каждой
   записи осталась ссылка `"runCommand": run.runCommand,`. Тела перенесены ПОБАЙТОВО
   (сверка `fn.toString()` до/после), порядок инструментов сохранён ровно. */
function createRunTools(deps) {
  const {
    path,
    fs,
    resolvePath,
    agentWorkDir,
    normalizeShell,
    resolveShell,
    shellsStatus,
    runTerminalCommand,
    detectPackageManager,
    bgProcesses,
    bgSpawn,
    bgKill,
    SERVER_CMD_RE,
    waitOutputQuiet,
    bgTail,
    termAgentEcho,
    stripAnsi,
    spawnCollect,
    explainExit,
    runAsAdmin,
    bgWaitFor,
    truncateText,
  } = deps;

  return {
    "shellsStatus": async (args, settings) => {
        const rows = shellsStatus().map((s) => {
          if (s.available) return "✅ " + s.kind + (s.def ? " (по умолчанию)" : "") + " — " + (s.path || "найден в PATH");
          return "❌ " + s.kind + " — " + (s.hint || "не найден");
        });
        const defLine = process.platform === "win32" ? "По умолчанию команды идут в cmd." : "По умолчанию команды идут в sh.";
        const tip =
          process.platform === "win32"
            ? '\n\nПодсказка: PowerShell есть всегда — shell: "powershell" (кавычки, $ и 2>$null работают как в консоли). bash и sh появляются вместе с Git for Windows: installSystemPackage("git").'
            : "";
        return "Оболочки на этой машине:\n" + rows.join("\n") + "\n\n" + defLine + ' Выбор — параметр shell у runCommand и startBackground.' + tip;
    },
    "runCommand": async (args, settings) => {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const shellRaw = String(args.shell == null ? "" : args.shell).trim();
        const shellName = normalizeShell(shellRaw);
        if (shellRaw && !shellName) {
          return "Ошибка: неизвестная оболочка «" + shellRaw + "». Доступно: cmd, powershell, pwsh, bash, sh.";
        }
        const cwd = agentWorkDir(settings);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 300000);
        termAgentEcho("$ " + cmd + "   (каталог: " + cwd + (shellName ? ", оболочка: " + shellName : "") + ")");
        const out = await runTerminalCommand(cmd, cwd, timeoutMs, shellName);
        termAgentEcho(out);
        let out2 = out;
        if (out.includes("кодом таймаут") && SERVER_CMD_RE.test(cmd)) {
          out2 +=
            "\n\n⏱ Команда не завершилась за " + timeoutMs + " мс — похоже, это длительный dev-сервер (он не завершается сам). Правильно: startBackground(\"" +
            cmd.slice(0, 80) +
            "\") — вернёт id БЕЗ блокировки; затем checkUrl/checkPort для проверки готовности, backgroundOutput(id) для логов, stopBackground(id) для остановки (освободит порт). НЕ жди завершения сервера через runCommand.";
        }
        return truncateText("$ " + cmd + "\n(каталог: " + cwd + ")\n\n" + out2, 9000);
    },
    "startBackground": async (args, settings) => {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи command";
        const shellRaw = String(args.shell == null ? "" : args.shell).trim();
        const shellName = normalizeShell(shellRaw);
        if (shellRaw && !shellName) {
          return "Ошибка: неизвестная оболочка «" + shellRaw + "». Доступно: cmd, powershell, pwsh, bash, sh.";
        }
        const cwd = args.cwd ? resolvePath(args.cwd, settings) : agentWorkDir(settings);
        const bgShell = resolveShell(cmd, shellName);
        // Нет оболочки — spawn упадёт асинхронно, а инструмент успел бы отрапортовать
        // «OK … PID: undefined». Отвечаем честно и сразу.
        if (bgShell.missing) {
          return (
            "Ошибка: оболочка «" + (shellName || "?") + "» не найдена — фоновый процесс НЕ запущен.\n" +
            bgShell.shellHint +
            '\n\nПроверь доступные оболочки через shellsStatus, затем используй shell: "powershell" или "cmd".'
          );
        }
        const rec = bgSpawn(cmd, { name: args.name, cwd, shell: bgShell.shell, shellArgs: bgShell.args });
        termAgentEcho("$ " + cmd + "   (фоновый процесс " + rec.id + ", каталог: " + cwd + (shellName ? ", оболочка: " + shellName : "") + ")");
        return "OK — фоновый процесс запущен:\nid: " + rec.id + "\nкоманда: " + cmd + "\nPID: " + rec.child.pid + "\n\nДальше: backgroundOutput(id) — логи, sendInput(id, текст) — ввод в процесс, stopBackground(id) — остановить, checkUrl/checkPort — проверить готовность сервера.";
    },
    "listBackground": async (args, settings) => {
        if (!bgProcesses.size) return "Фоновых процессов нет.";
        const rows = [];
        for (const rec of bgProcesses.values()) {
          const alive = !rec.exited;
          const pid = rec.child && rec.child.pid ? rec.child.pid : "—";
          const secs = Math.round((Date.now() - rec.startedAt) / 1000);
          const tail = bgTail(rec, 3).trim().slice(0, 140);
          rows.push(
            "• " + rec.id + " [" + (alive ? "работает" : "завершён, код " + rec.exitCode) + ", PID " + pid + ", " + secs + " c] " + rec.name +
              (tail ? "\n    → " + tail : "")
          );
        }
        return "Фоновые процессы (" + bgProcesses.size + "):\n" + rows.join("\n");
    },
    "backgroundOutput": async (args, settings) => {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        const status = rec.exited ? "ЗАВЕРШЁН (код " + rec.exitCode + ")" : "РАБОТАЕТ (PID " + (rec.child && rec.child.pid) + ")";
        return "Фоновый процесс " + rec.id + " — " + status + "\nКоманда: " + rec.command + "\n\n" + (bgTail(rec, args.lines) || "(вывода пока нет)");
    },
    "sendInput": async (args, settings) => {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        if (rec.exited || !rec.child.stdin || !rec.child.stdin.writable) return "Ошибка: процесс завершён или его stdin закрыт.";
        const input = String(args.input ?? "");
        try {
          rec.child.stdin.write(input + "\n");
        } catch (e) {
          return "Ошибка записи в процесс: " + e.message;
        }
        return "OK — отправлено в процесс " + rec.id + ": " + input;
    },
    "stopBackground": async (args, settings) => {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        bgKill(rec);
        return "OK — процесс " + rec.id + " остановлен.";
    },
    "shellStart": async (args, settings) => {
        const isWin = process.platform === "win32";
        const rec = bgSpawn("", {
          shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
          shellArgs: isWin ? ["/Q"] : [],
          name: args.name || "shell",
          cwd: agentWorkDir(settings),
        });
        return "OK — постоянная shell-сессия запущена:\nid: " + rec.id + "\nPID: " + rec.child.pid + "\n\nОтправляй команды через shellSend(id, команда), смотри вывод через backgroundOutput(id), останови через stopBackground(id). Состояние (переменные, текущая папка) сохраняется между командами.";
    },
    "shellSend": async (args, settings) => {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: shell-сессия с id «" + args.id + "» не найдена. Запусти её через shellStart.";
        if (rec.exited) return "Ошибка: shell-сессия завершена.";
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи command";
        termAgentEcho("$ " + cmd + "   (shell-сессия " + rec.id + ")");
        const from = rec.output.length;
        try {
          rec.child.stdin.write(cmd + "\n");
        } catch (e) {
          return "Ошибка записи в shell: " + e.message;
        }
        await waitOutputQuiet(rec, 8000);
        const out = rec.output.slice(from).join("\n").trim();
        termAgentEcho(out);
        return "$ " + cmd + "\n" + (out || "(нет вывода)");
    },
    "runCommandOutput": async (args, settings) => {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const cwd = agentWorkDir(settings);
        const waitFor = args.waitFor ? String(args.waitFor) : "";
        const retries = Math.min(Math.max(parseInt(args.retries, 10) || 0, 0), 5);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 600000);
        // Длительный dev-сервер (expo start, npm run dev, vite…): он не завершается сам,
        // поэтому запускаем через bgSpawn — не блокируемся, регистрируем в bgProcesses
        // (агент сможет остановить его через stopBackground и освободить порт) и ждём
        // только маркер готовности, если waitFor задан. Сервер по таймауту НЕ убиваем.
        if (SERVER_CMD_RE.test(cmd)) {
          const rec = bgSpawn(cmd, { name: args.name || cmd.slice(0, 50), cwd });
          termAgentEcho("$ " + cmd + "   (фоновый процесс " + rec.id + ", каталог: " + cwd + ")");
          let head =
            "OK — команда похожа на длительный dev-сервер, запущена в фоне БЕЗ ожидания завершения.\n" +
            "id: " + rec.id + "\nкоманда: " + cmd + "\nPID: " + rec.child.pid + "\n";
          if (waitFor) {
            const r = await bgWaitFor(rec, waitFor, timeoutMs);
            head += r.matched
              ? "✅ в выводе появился маркер «" + waitFor + "» — сервер готов.\n"
              : r.exited
                ? "❌ процесс завершился раньше маркера (код " + r.code + ").\n"
                : "⏱ маркер «" + waitFor + "» не появился за " + timeoutMs + " мс (сервер продолжает работать в фоне).\n";
          } else {
            head += "Дальше: checkUrl/checkPort — проверить готовность, backgroundOutput(id) — логи, stopBackground(id) — остановить (освободит порт).\n";
          }
          const tail = truncateText(bgTail(rec, args.lines) || "(вывода пока нет)", 6000);
          return head + "\n--- вывод ---\n" + tail;
        }
        const log = [];
        let last = null;
        let attempt = 0;
        for (; attempt <= retries; attempt++) {
          if (attempt > 0) {
            await new Promise((r2) => setTimeout(r2, 2000));
            log.push("→ повторная попытка #" + (attempt + 1));
          }
          const res = await spawnCollect(cmd, cwd, timeoutMs, waitFor);
          last = res;
          if (res.matched) {
            log.push("✅ в выводе появился текст «" + waitFor + "» (попытка #" + (attempt + 1) + ")");
            break;
          }
          if (res.ok) {
            log.push("✅ команда завершилась успешно (попытка #" + (attempt + 1) + ")");
            break;
          }
          log.push((res.timedOut ? "⏱ таймаут (" + timeoutMs + " мс)" : "❌ команда упала (код " + res.code + ")") + " — попытка #" + (attempt + 1));
        }
        const tail = truncateText((last && stripAnsi(last.out || "")) || "(без вывода)", 8000);
        return "$ " + cmd + "\n(каталог: " + cwd + ", попыток: " + (attempt + 1) + ")\n\n" + log.join("\n") + "\n\n--- вывод последней попытки ---\n" + tail;
    },
    "runCommandAsAdmin": async (args, settings) => {
        return await runAsAdmin(args.command);
    },
    "timeoutCommand": async (args, settings) => {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const ms = Math.min(Math.max(parseInt(args.timeoutMs, 10) || 15000, 1000), 600000);
        const res = await spawnCollect(cmd, agentWorkDir(settings), ms, "");
        const body = (res.out || "").trim();
        if (res.ok) return "$ " + cmd + " (лимит " + ms + " мс)\n\n" + (body || "Готово (без вывода).");
        if (res.timedOut) return "⏱ Команда не уложилась в " + ms + " мс и остановлена принудительно:\n$ " + cmd + "\n\n" + (body.slice(0, 3000) || "(вывода не было)") + "\n\nУвеличь timeoutMs или разбей команду на шаги.";
        return "$ " + cmd + "\nКоманда упала (код " + res.code + "):\n" + (body.slice(0, 4000) || "(без вывода)") + "\n\nОбъяснение: " + explainExit(res.code, cmd);
    },
    "retryCommand": async (args, settings) => {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const retries = Math.min(Math.max(parseInt(args.maxRetries, 10) || 2, 0), 5);
        const pauseMs = Math.min(Math.max(parseInt(args.pauseMs, 10) || 2000, 200), 30000);
        const timeoutMs = Math.min(Math.max(parseInt(args.timeoutMs, 10) || 60000, 1000), 300000);
        const log = [];
        let last = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const res = await spawnCollect(cmd, agentWorkDir(settings), timeoutMs, "");
          last = res;
          if (res.ok) {
            return "$ " + cmd + "\n(попыток: " + (attempt + 1) + ")\n\n✅ успех с попытки #" + (attempt + 1) + "\n\n--- вывод ---\n" + ((res.out || "").trim().slice(0, 6000) || "(пусто)");
          }
          log.push("❌ попытка #" + (attempt + 1) + (res.timedOut ? " — таймаут " + timeoutMs + " мс" : " — код " + res.code) + (attempt < retries ? " → повтор через " + pauseMs + " мс" : ""));
          if (attempt < retries) await new Promise((r2) => setTimeout(r2, pauseMs));
        }
        return "$ " + cmd + "\nНе удалось после " + (retries + 1) + " попыток:\n" + log.join("\n") + "\n\n--- вывод последней попытки ---\n" + ((last && (last.out || "").trim().slice(0, 5000)) || "(пусто)") + "\n\nОбъяснение: " + explainExit(last ? last.code : 1, cmd);
    },
    "runScript": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const name = String(args.scriptName || "").trim();
        if (!name) return "Ошибка: укажи scriptName (имя скрипта из package.json)";
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (!pkg) return "В каталоге " + cwd + " нет package.json.";
        const scripts = pkg.scripts || {};
        if (!(name in scripts)) return "Скрипта «" + name + "» нет. Доступные скрипты: " + (Object.keys(scripts).join(", ") || "нет");
        const pm = detectPackageManager(cwd);
        const extra = String(args.args || "");
        const cmd = pm.name === "npm" ? "npm run " + name + (extra ? " " + extra : "") : pm.bin + " run " + name + (extra ? " " + extra : "");
        const out = await runTerminalCommand(cmd, cwd, 300000);
        return truncateText("$ " + cmd + "\n(каталог: " + cwd + ")\n\n" + out, 9000);
    },
    "waitUntil": async (args, settings) => {
        const secs = Math.max(1, Math.min(parseInt(args.seconds, 10) || 5, 300));
        if (args.reason) termAgentEcho("⏳ " + args.reason + " (жду " + secs + " с)");
        await new Promise((res) => setTimeout(res, secs * 1000));
        return "OK — подождал " + secs + " с" + (args.reason ? " (" + args.reason + ")" : "") + ". Теперь перепроверь состояние (например checkPort/checkUrl/backgroundOutput).";
    },
  };
}

module.exports = { createRunTools };

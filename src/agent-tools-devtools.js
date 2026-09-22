"use strict";

/* ─── Инструменты вложений и разработки ──────────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 9). Здесь тринадцать обработчиков,
   которыми агент собирает, проверяет и обхаживает проект:

     • докер — dockerBuild (сборка образа в папке проекта), dockerRun (запуск
       образа, по умолчанию отсоединённый) и dockerExec (команда внутри
       контейнера);
     • установка и проверка программ — installPackage (менеджер пакетов проекта
       определяется сам: bun/npm/pnpm/yarn) и checkInstalledProgram/canExecute
       (программа в PATH есть? что вернёт за --version?);
     • проверки проекта — lintProject (что нашлось: tsconfig / eslint),
       runTests (npm test или bun test из package.json), validateProject
       (tsc + eslint + тесты с итогом «сколько этапов успешно»), formatCode
       (prettier из node_modules проекта) и getDependencies (зависимости и
       что из них реально установлено, плюс npm audit по просьбе);
     • explainError (расшифровка кода выхода с учётом команды) и dbQuery
       (psql/mysql: запрос по строке подключения, клиент получает выданное ему
       окружение db.query, а не весь набор переменных агента).

   Живой мост не нужен: всё, что обработчикам нужно, приходит в deps, а рабочая
   папка берётся на момент вызова через agentWorkDir(settings).
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createDevTools(deps) {
  const {
    agentWorkDir,
    detectPackageManager,
    envFor,
    execFile,
    explainExit,
    findProgram,
    hasLock,
    resolvePath,
    runProgVersion,
    runTerminalCommand,
    stripAnsi,
    summarizeTestOutput,
    truncateText,
    fs,
    path,
  } = deps;

  return {
    "dockerBuild": async (args, settings) => {
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir)) return "Ошибка: папка не найдена: " + dir;
        const tag = String(args.tag || "").trim();
        const cmd = "docker build" + (tag ? " -t " + tag : "") + " .";
        const out = await runTerminalCommand(cmd, dir, 300000);
        return truncateText(out, 6000);
    },
    "dockerRun": async (args, settings) => {
        const image = String(args.image || "").trim();
        if (!image) return "Ошибка: укажи image";
        const extra = String(args.args || "").trim();
        const detached = args.detached !== false;
        const cmd = "docker run " + (detached ? "-d " : "") + (extra ? extra + " " : "") + image;
        const out = await runTerminalCommand(cmd, agentWorkDir(settings), 120000);
        return truncateText(out, 4000);
    },
    "dockerExec": async (args, settings) => {
        const container = String(args.container || "").trim();
        const command = String(args.command || "").trim();
        if (!container || !command) return "Ошибка: укажи container и command";
        const out = await runTerminalCommand("docker exec " + container + " " + command, agentWorkDir(settings), 60000);
        return truncateText(out, 4000);
    },
    "installPackage": async (args, settings) => {
        const pkg = String(args.packageName || "").trim();
        if (!pkg) return "Ошибка: укажи packageName (например «express» или «react@18.3.1»)";
        const cwd = agentWorkDir(settings);
        const pm = detectPackageManager(cwd);
        const dev = !!args.dev;
        const cmd = pm.bin + " " + pm.add + (dev ? " " + pm.flagDev : "") + " " + pkg;
        const out = await runTerminalCommand(cmd, cwd, 300000);
        return truncateText("$ " + cmd + "\n(менеджер пакетов: " + pm.name + ", каталог: " + cwd + ")\n\n" + out, 6000);
    },
    "lintProject": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const parts = [];
        const has = (name) => fs.existsSync(path.join(cwd, name));
        if (has("tsconfig.json")) {
          parts.push("$ npx -y tsc --noEmit\n" + (await runTerminalCommand("npx -y tsc --noEmit", cwd, 300000)));
        }
        if (has("eslint.config.js") || has("eslint.config.mjs") || has("eslint.config.cjs") || has(".eslintrc") || has(".eslintrc.json") || has(".eslintrc.js")) {
          parts.push("$ npx -y eslint .\n" + (await runTerminalCommand("npx -y eslint .", cwd, 300000)));
        }
        if (!parts.length) {
          return "Не нашёл конфигов проверки в " + cwd + " (tsconfig.json или eslint.config.* / .eslintrc). Можно запустить проверку вручную через runCommand.";
        }
        return truncateText(parts.join("\n\n"), 9000);
    },
    "runTests": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 180000, 600000);
        let cmd = null;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
          if (pkg.scripts && pkg.scripts.test) cmd = "npm test";
        } catch {}
        if (!cmd) {
          cmd = hasLock("bun") ? "bun test" : "npm test";
        }
        const out = await runTerminalCommand(cmd, cwd, timeoutMs);
        const summary = summarizeTestOutput(out);
        return truncateText("$ " + cmd + " (каталог: " + cwd + ")\n\n" + out + (summary ? "\n\n--- Итог ---\n" + summary : ""), 9000);
    },
    "checkInstalledProgram": async (args, settings) => {
        const prog = String(args.programName || "").trim();
        if (!prog) return "Ошибка: укажи programName (например git).";
        const info = findProgram(prog);
        if (!info.found) {
          return "Установлено: нет\n" + info.reason + "\n\nУстанови через installSystemPackage(\"" + prog + "\"), затем вызови refreshEnv() и повтори проверку.";
        }
        const v = await runProgVersion(info.path);
        return "Установлено: да\nПуть: " + info.path + "\nВерсия: " + (v || "не определилась (нет --version)") + "\n\nТочную проверку из командной строки: canExecute(\"" + prog + "\").";
    },
    "canExecute": async (args, settings) => {
        const prog = String(args.programName || args.command || "").trim().split(/\s+/)[0] || "";
        if (!prog) return "Ошибка: укажи programName или command.";
        const builtins = ["cd", "echo", "set", "exit", "cls", "dir", "type", "pwd", "export", "source", "alias", "if", "for", "while", "test", "true", "false"];
        if (builtins.includes(prog.toLowerCase())) {
          return "Можно выполнить: да\n«" + prog + "» — встроенная команда оболочки, отдельная программа не нужна.";
        }
        const info = findProgram(prog);
        if (info.found) return "Можно выполнить: да\nПрограмма: " + prog + "\nПуть: " + info.path;
        return "Можно выполнить: нет — «" + prog + "» не найден в PATH.\nУстанови: installSystemPackage(\"" + prog + "\"), затем refreshEnv().\nТочная проверка: checkInstalledProgram(\"" + prog + "\").";
    },
    "explainError": async (args, settings) => {
        const codeRaw = args.exitCode;
        const code = codeRaw == null || codeRaw === "" ? NaN : parseInt(codeRaw, 10);
        return explainExit(Number.isNaN(code) ? NaN : code, args.command);
    },
    "validateProject": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const has = (n) => fs.existsSync(path.join(cwd, n));
        const steps = [];
        if (has("tsconfig.json")) {
          const out = await runTerminalCommand("npx -y tsc --noEmit", cwd, 300000);
          steps.push({ name: "TypeScript (tsc --noEmit)", ok: !out.startsWith("Команда завершилась"), out });
        }
        if (has("eslint.config.js") || has("eslint.config.mjs") || has("eslint.config.cjs") || has(".eslintrc") || has(".eslintrc.json") || has(".eslintrc.js") || has(".eslintrc.cjs")) {
          const out = await runTerminalCommand("npx -y eslint .", cwd, 300000);
          steps.push({ name: "ESLint", ok: !out.startsWith("Команда завершилась"), out });
        }
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (pkg && pkg.scripts && pkg.scripts.test) {
          const out = await runTerminalCommand("npm test", cwd, 300000);
          const s = summarizeTestOutput(out);
          steps.push({ name: "Тесты (npm test)", ok: !out.startsWith("Команда завершилась") && !/(failed|failing|упало)/i.test(s), out });
        }
        if (!steps.length) {
          return "Не нашёл, что проверять в " + cwd + ": нет tsconfig.json, eslint-конфига и test-скрипта. Укажи задачи через runCommand или установи инструменты.";
        }
        const okCount = steps.filter((s) => s.ok).length;
        const body = steps.map((s) => {
          const icon = s.ok ? "✅" : "❌";
          return icon + " " + s.name + (s.ok ? " — ок" : "") + "\n" + truncateText(s.out, 1400);
        }).join("\n\n");
        return "Проверка проекта (" + cwd + "): " + okCount + " из " + steps.length + " этапов успешно\n\n" + body;
    },
    "getDependencies": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (!pkg) return "package.json не найден в " + cwd;
        const deps = pkg.dependencies || {};
        const dev = pkg.devDependencies || {};
        const installed = (n) => {
          try { return JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", n, "package.json"), "utf8")).version; } catch { return null; }
        };
        const fmt = (o) => Object.keys(o).length
          ? Object.keys(o).map((n) => "• " + n + "@" + o[n] + " → " + (installed(n) ? "установлено " + installed(n) : "НЕ установлено")).join("\n")
          : "— пусто";
        let out = "📦 dependencies (" + Object.keys(deps).length + ") в " + cwd + ":\n" + fmt(deps);
        out += "\n\n🛠 devDependencies (" + Object.keys(dev).length + "):\n" + fmt(dev);
        if (args.audit) {
          if (!fs.existsSync(path.join(cwd, "package-lock.json"))) {
            out += "\n\nnpm audit требует package-lock.json (создаётся npm install). Для bun/pnpm используй их audit-команды через runCommand.";
          } else {
            out += "\n\n--- npm audit (omit dev) ---\n" + truncateText(await runTerminalCommand("npm audit --omit=dev", cwd, 120000), 4000);
          }
        }
        return truncateText(out, 9000);
    },
    "formatCode": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const target = args.path ? resolvePath(args.path, settings) : "";
        if (!target || !fs.existsSync(target)) return "Ошибка: укажи существующий path (файл или папка)";
        const bin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
        if (!fs.existsSync(bin)) return "Prettier не установлен в проекте. Установи его: installPackage(\"prettier\", true), затем повтори formatCode.";
        const check = !!args.check;
        const out = await runTerminalCommand(bin + (check ? " --check " : " --write ") + "\"" + target + "\"", cwd, 120000);
        return truncateText("$ prettier " + (check ? "--check" : "--write") + " " + path.relative(cwd, target) + "\n\n" + out, 6000);
    },
    "dbQuery": async (args, settings) => {
        const conn = String(args.connectionString || "").trim();
        const sql = String(args.sql || "").trim();
        if (!conn || !sql) return "Ошибка: укажи connectionString и sql";
        let kind = "";
        try {
          const u = new URL(conn);
          if (u.protocol === "postgres:" || u.protocol === "postgresql:") kind = "postgres";
          else if (u.protocol === "mysql:") kind = "mysql";
        } catch {}
        if (!kind) return "Ошибка: поддерживаются строки подключения postgres://... и mysql://...";
        return await new Promise((resolve) => {
          // Клиент БД получает выданное ему (db.query), а не весь набор переменных агента.
          const baseEnv = { ...envFor("db.query") };
          if (kind === "postgres") {
            execFile("psql", [conn, "-v", "ON_ERROR_STOP=1", "-c", sql], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: baseEnv }, (err, stdout, stderr) => {
              const o = stripAnsi((stdout || "").toString());
              const e = stripAnsi((stderr || "").toString());
              if (err) {
                if (err.code === "ENOENT") return resolve("Клиент psql не найден в системе. Установи PostgreSQL-клиент и добавь в PATH, затем повтори.");
                return resolve(truncateText("Ошибка psql:\n" + (e || err.message || String(err)), 7000));
              }
              resolve(truncateText("psql OK:\n" + (o || "(без вывода)") + (e ? "\n[stderr]\n" + e : ""), 7000));
            });
          } else {
            let u = null;
            try { u = new URL(conn); } catch {}
            if (!u) return resolve("Ошибка парсинга строки подключения");
            const a = [];
            if (u.hostname) a.push("--host=" + u.hostname);
            if (u.port) a.push("--port=" + u.port);
            if (u.username) a.push("--user=" + decodeURIComponent(u.username));
            const db = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
            if (db) a.push(db);
            a.push("-e", sql);
            const menv = { ...baseEnv };
            if (u.password) menv.MYSQL_PWD = decodeURIComponent(u.password);
            execFile("mysql", a, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: menv }, (err, stdout, stderr) => {
              const o = stripAnsi((stdout || "").toString());
              const e = stripAnsi((stderr || "").toString());
              if (err) {
                if (err.code === "ENOENT") return resolve("Клиент mysql не найден в системе. Установи MySQL-клиент и добавь в PATH, затем повтори.");
                return resolve(truncateText("Ошибка mysql:\n" + (e || err.message || String(err)), 7000));
              }
              resolve(truncateText("mysql OK:\n" + (o || "(без вывода)") + (e ? "\n[stderr]\n" + e : ""), 7000));
            });
          }
        });
    },
  };
}

module.exports = { createDevTools };

"use strict";

/* ─── Агентские инструменты: реестр из 154 обработчиков ───────────────────
   Раньше это был один switch на 2,3 тысячи строк внутри executeTool в main.js:
   файл дорос до семи тысяч строк, а чтобы найти инструмент, нужен был поиск по
   имени. Теперь каждый инструмент — отдельная функция, а executeTool только
   выбирает обработчик и ловит ошибки. Список инструментов, их описания и права
   по-прежнему живут в agent-core.js и tool-policy.js: здесь ТОЛЬКО исполнение.

   Тело каждой ветки перенесено ПОБАЙТОВО (скрипт извлечения сверял круг
   «туда-обратно»), поэтому поведение не менялось ни на строку.

   Живые значения main.js (окружение агента, окно, отправитель событий, роутер
   инструментов, папка последнего клона и флаг «после клона») читаются через
   `live`: они меняются по ходу работы приложения, и копия значения «застыла» бы
   на null. Запись идёт через сеттеры — там, где ветка действительно присваивает.

   Зависимости приходят снаружи (та же конвенция, что у createYcService и
   createDeployEngine): модуль чистый и проверяется в plain-node. */

// ── Проверка записанного файла ────────────────────────────────────────────
// Проверяем то, что действительно проверяется на этой машине: синтаксис JS (тем
// же Node, что запущен) и разбор JSON. Картинки и архивы проверять нечем —
// честно молчим, а не делаем вид, что проверили.
const CHECK_CODE_EXT = { ".js": 1, ".mjs": 1, ".cjs": 1, ".jsx": 1 };

function checkWrittenFile(file, content) {
  const pathMod = require("path");
  const ext = pathMod.extname(String(file || "")).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(String(content == null ? "" : content));
      return { checked: true, problem: "" };
    } catch (e) {
      return { checked: true, problem: "JSON не разбирается: " + String((e && e.message) || e).slice(0, 200) };
    }
  }
  if (!CHECK_CODE_EXT[ext]) return { checked: false, problem: "" };
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, ["--check", file], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (r.status === 0) return { checked: true, problem: "" };
    const msg = String(r.stderr || r.stdout || "").trim().split("\n").slice(0, 4).join(" ");
    return { checked: true, problem: "синтаксис не проходит (node --check): " + msg.slice(0, 300) };
  } catch (e) {
    return { checked: false, problem: "" }; // проверка не запустилась — не выдумываем ошибку
  }
}

// Что нужно, чтобы файл вообще запустился: без этой строки агент считает работу
// законченной, а скрипт падает на машине без нужного окружения.
function envNoteFor(file) {
  const pathMod = require("path");
  const fsMod = require("fs");
  const ext = pathMod.extname(String(file || "")).toLowerCase();
  if (!CHECK_CODE_EXT[ext] && ext !== ".py" && ext !== ".sh") return "";
  if (ext === ".py") {
    return "\nДля запуска нужен Python 3; библиотеки ставить через pip, список — в requirements.txt. Секреты и ключи — в Настройки → Секреты (не в код). Запуск: runCommand.";
  }
  if (ext === ".sh") {
    return "\nДля запуска нужен bash/sh (на Windows — Git Bash или WSL). Запуск: runCommand.";
  }
  let hasDeps = false;
  try {
    hasDeps = fsMod.existsSync(pathMod.join(pathMod.dirname(file), "node_modules"));
  } catch (e) {}
  return (
    "\nДля запуска нужен Node.js (или bun)." +
    (hasDeps
      ? " Зависимости рядом есть (node_modules)."
      : " Зависимостей рядом нет (node_modules): если скрипту нужны библиотеки — сначала installPackage; ключи и токены — в Настройки → Секреты, а не в код.") +
    (/\.jsx$/.test(ext) ? " Файл .jsx без сборки Node не запустит — нужен инструмент сборки." : " Запуск: runCommand.")
  );
}

function createAgentTools(deps) {
  // Панель «Миссия» обновляется сразу: шаг агента видно без ожидания опроса.
  const notifyMission = () => {
    try {
      const em = deps.live && deps.live.activeEmit ? deps.live.activeEmit() : null;
      if (em) em({ type: "mission", phase: "changed" });
    } catch {}
  };
  const {
    shell,
    path,
    fs,
    os,
    net,
    browserTools,
    appUi,
    secrets,
    yandexCloud,
    vault,
    mail,
    ycLogs,
    ota,
    selfDev,
    ycIamEnvToken,
    ycAutoEnv,
    applyAgentEnv,
    loadSettings,
    saveSettings,
    resolvePath,
    runGit,
    envFor, // выдача окружения по назначению (мост к main.js)
    agentWorkDir,
    repoNameFromUrl,
    stripUrlCreds,
    normalizeShell,
    resolveShell,
    shellsStatus,
    runTerminalCommand,
    detectPackageManager,
    hasLock,
    summarizeTestOutput,
    unifiedDiff,
    buildFileStructure,
    screenshotUrl,
    saveScreenshotPng,
    bgProcesses,
    bgSpawn,
    bgKill,
    SERVER_CMD_RE,
    waitOutputQuiet,
    bgTail,
    checkUrlStatus,
    listProjectFiles,
    searchProjectFiles,
    snapshotFileForUndo,
    numberedLines,
    langFromExt,
    buildFileOutline,
    buildBlockRanges,
    stageAllSafe,
    guideSafeName,
    guideFilePath,
    guideIndex,
    guideForUrl,
    agentGuideCall,
    termAgentEcho,
    mailConfig,
    // Окно и системные возможности Electron: инструменты делают скриншот экрана,
    // читают и пишут буфер обмена, открывают папки — всё это живёт в главном процессе.
    app,
    clipboard,
    desktopCapturer,
    execFile,
    // Пояс проекта: заметки и дела, семантический индекс, откат правок, журнал действий.
    agentStore,
    missionStore,
    unifiedPatch,
    codeIndex,
    audit,
    // Стоимость облака до создания ресурса.
    ycCosts,
    // Терминал и системные справки: запуск процессов, разбор вывода, установка программ.
    stripAnsi,
    spawnCollect,
    spawnRaw,
    explainExit,
    installSystemPkg,
    downloadFileTo,
    verifyInstaller,
    installerFacts,
    installerGate,
    findInstallersIn,
    downloadAndExtractTo,
    runAsAdmin,
    envPathInfo,
    findProgram,
    runProgVersion,
    psScript,
    cachedPs,
    invalidatePsCache,
    refreshEnvFromOS,
    userDataDir,
    emitTasksChanged,
    // Фоновые процессы и снимки экрана.
    bgWaitFor,
    encodeShot,
    // Откат изменений: снимки файлов и их восстановление.
    persistUndo,
    loadPersistedUndo,
    // Разбор кода: переименование и поиск ссылок.
    refactorRenameFiles,
    findSymbolReferences,
    // Вспомогательная модель и поиск: зрение, картинки, веб.
    auxConfig,
    describeImageRemote,
    generateImageRemote,
    webSearch,
    webFetchPage,
    fmtError,
    truncateText,
    searchTools,
    // Планирование и системные сведения.
    normalizePlanTasks,
    planSummary,
    parseProcessesCsv,
    parseSysInfoJson,
    registryPathAllowed,
    // Облако: конфигурация, контейнеры, ревизии, логи, yc CLI.
    ycConfig,
    ycFindContainerByRef,
    ycActiveRevision,
    ycJsonArg,
    ycRevisionLine,
    ycRevisionDetails,
    readYcLogsText,
    ycCliStatus,
    ycCliInstall,
    runCloudDeploy,
    cloudDeployBrief,
    publishLocalToGithub,
  } = deps;


  // Живые значения: чтение в момент вызова, запись — через сеттеры main.js.
  const live = {
    get agentEnv() {
      return deps.live.agentEnv();
    },
    // Сводка «кому выдана переменная» — через мост, как и остальные живые значения.
    scopeSummary(name) {
      return deps.live.scopeSummary(name);
    },
    get userAgentEnv() {
      return deps.live.userAgentEnv();
    },
    get lastAgentRepoDir() {
      return deps.live.lastAgentRepoDir();
    },
    set lastAgentRepoDir(v) {
      deps.live.setLastAgentRepoDir(v);
    },
    get clonedRepoPending() {
      return deps.live.clonedRepoPending();
    },
    set clonedRepoPending(v) {
      deps.live.setClonedRepoPending(v);
    },
    get activeEmit() {
      return deps.live.activeEmit();
    },
    // Роль и чат текущего прогона: миссия запоминает, кто её ведёт, — панель
    // показывает работу в том чате, где она начата.
    get activeRunRole() {
      return deps.live.activeRunRole ? deps.live.activeRunRole() : "";
    },
    get activeRunChatId() {
      return deps.live.activeRunChatId ? deps.live.activeRunChatId() : "";
    },
    get activeToolRouter() {
      return deps.live.activeToolRouter();
    },
    get mainWindow() {
      return deps.live.mainWindow();
    },
    get activeRunUndo() {
      return deps.live.activeRunUndo();
    },
    set activeRunUndo(v) {
      deps.live.setActiveRunUndo(v);
    },
    get lastUndoLog() {
      return deps.live.lastUndoLog();
    },
    set lastUndoLog(v) {
      deps.live.setLastUndoLog(v);
    },
    get activePlanSummary() {
      return deps.live.activePlanSummary();
    },
    set activePlanSummary(v) {
      deps.live.setActivePlanSummary(v);
    },
  };

  return {
    "findTools": async (args, settings) => {
        const query = String(args.query || "").trim();
        if (!query) return "Укажи query — что нужно сделать словами (например «отправить письмо»).";
        const found = searchTools(query, args.limit);
        if (!found.length) {
          return "Ничего не нашлось по запросу «" + query + "». Сформулируй иначе (действие + объект: «клик по элементу страницы», «запуш ветки») или используй runCommand.";
        }
        const groups = [...new Set(found.map((f) => f.group).filter(Boolean))];
        if (live.activeToolRouter && groups.length) live.activeToolRouter.addGroups(groups);
        // Схемы могут НЕ поместиться в узкое окно модели (группа включается, а вес не лезет).
        // Раньше ответ безусловно обещал «схемы уже добавлены», и модель ждала, что вызов
        // сработает сам. Говорим, что реально в запросе сейчас, а что видно только по имени.
        const inSchemas = live.activeToolRouter ? live.activeToolRouter.names() : [];
        const missing = found.filter((f) => inSchemas.indexOf(f.name) < 0).map((f) => f.name);
        return (
          "Нашёл инструменты по запросу «" + query + "»:\n" +
          found.map((f) => "• " + f.name + (f.group ? " [" + f.group + "]" : "") + " — " + truncateText(f.description, 160)).join("\n") +
          (groups.length ? "\nВключены группы: " + groups.join(", ") + "." : "") +
          (missing.length
            ? "\n⚠ В набор схем не поместились (узкое окно модели): " + missing.join(", ") +
              ". Вызывай их так же по имени — вызов выполнится, просто схема не отправлена."
            : "\nВсе найденные инструменты уже в запросе — вызывай как обычно.") +
          (live.activeToolRouter ? "\nСейчас в запросе " + inSchemas.length + " инструментов." : "")
        );
    },
    "createFolder": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        fs.mkdirSync(p, { recursive: true });
        return "OK — папка создана: " + p;
    },
    "readFile": async (args, settings) => {
        // Специальный путь для встроенных справочников агента (не файлы проекта):
        // readFile(path: "agent-guide:vk") → полный гайд по работе с ВКонтакте.
        const guidePath = String(args.path || "").trim();
        if (guidePath.startsWith("agent-guide:")) {
          const guideName = guideSafeName(guidePath);
          const guideFile = guideFilePath(guideName, false);
          if (guideFile) {
            return "СПРАВОЧНИК АГЕНТА: «" + guideName + "» (прочитай перед работой и следуй ему):\n\n" + fs.readFileSync(guideFile, "utf8");
          }
          const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
          return "Ошибка: справочник «" + guideName + "» не найден. Есть: " + list + ". Список в любой момент: agentGuide {}.";
        }
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Используй fileOutline для структуры и readFileLines для чтения по частям.";
        let content = fs.readFileSync(p, "utf8");
        const lines = content.split("\n");
        // Большой файл — краткий обзор вместо выгрузки целиком (экономия токенов)
        if (lines.length > 800) {
          const head = numberedLines(lines, 1, Math.min(60, lines.length), lines.length);
          const tail = numberedLines(lines, Math.max(1, lines.length - 14), lines.length, lines.length);
          const outline = buildFileOutline(content, null, 200);
          return (
            "Файл большой: " + lines.length + " строк, " + st.size + " байт (" + langFromExt(p) + ").\n" +
            "Не читай его целиком: используй fileOutline (структура), searchFile (поиск с context) и readFileLines (диапазон).\n\n" +
            "─ СТРУКТУРА (первые " + outline.entries.length + " определений):\n" + outline.text + "\n\n" +
            "─ НАЧАЛО ФАЙЛА:\n" + head + "\n\n" +
            "─ КОНЕЦ ФАЙЛА:\n" + tail
          );
        }
        return "Содержимое " + p + " (" + lines.length + " строк):\n" + content;
    },
    "readFileLines": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const start = Math.max(1, parseInt(args.start, 10) || 1);
        const count = Math.min(500, Math.max(1, parseInt(args.count, 10) || 100));
        const from = start - 1;
        const chunk = all.slice(from, from + count);
        if (!chunk.length) return "Файл закончился раньше строки " + start + ". Всего строк: " + all.length;
        const numbered = chunk.map((line, i) => {
          const n = start + i;
          return String(n).padStart(String(all.length).length, " ") + " | " + line;
        });
        return "Строки " + start + "–" + (start + chunk.length - 1) + " из " + all.length + " файла " + p + ":\n" + numbered.join("\n");
    },
    "editFile": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
        const newText = String(args.newText ?? "");
        const content = fs.readFileSync(p, "utf8");
        // Режим 2: замена диапазона строк по номерам (startLine..endLine) — для больших файлов
        const startLine = parseInt(args.startLine, 10);
        if (Number.isInteger(startLine) && startLine >= 1) {
          const endLine = Number.isInteger(parseInt(args.endLine, 10)) ? Math.max(startLine, parseInt(args.endLine, 10)) : startLine;
          const all = content.split("\n");
          if (startLine > all.length) return "Ошибка: startLine=" + startLine + " больше числа строк файла (" + all.length + ").";
          if (endLine > all.length) return "Ошибка: endLine=" + endLine + " больше числа строк файла (" + all.length + ").";
          snapshotFileForUndo(p);
          const before = all.slice(0, startLine - 1);
          const after = all.slice(endLine); // endLine включительно — берём всё после неё
          const updated = before.concat(newText === "" ? [] : newText.split("\n"), after).join("\n");
          fs.writeFileSync(p, updated, "utf8");
          const replaced = endLine === startLine ? "строку " + startLine : "строки " + startLine + "–" + endLine;
          return "OK — заменены " + replaced + " (" + (endLine - startLine + 1) + " стр." + (endLine === startLine ? "а" : "") + " → " + newText.split("\n").length + " стр.) в " + p;
        }
        const oldText = String(args.oldText ?? "");
        if (!oldText) return "Ошибка: укажи oldText (режим точной замены) или startLine (режим замены строк по номерам).";
        const lineOf = (idx) => content.slice(0, idx).split("\n").length;
        const positions = [];
        let from = 0;
        while (from <= content.length - oldText.length) {
          const idx = content.indexOf(oldText, from);
          if (idx === -1) break;
          positions.push(idx);
          from = idx + oldText.length;
        }
        if (!positions.length) {
          return "Ошибка: фрагмент для замены не найден в файле. Перечитай файл (readFile / readFileLines) и повтори с точным текстом, включая отступы.";
        }
        const occurrence = parseInt(args.occurrence, 10);
        if (positions.length > 1 && !args.replaceAll && !Number.isInteger(occurrence)) {
          const lines = positions.map(lineOf).join(", ");
          return "Ошибка: фрагмент встречается " + positions.length + " раз (строки: " + lines + "). Уточни контекст в oldText (добавь окружающие строки), укажи occurrence (номер вхождения, например 2) или replaceAll=true.";
        }
        snapshotFileForUndo(p);
        let updated, where;
        if (args.replaceAll) {
          updated = content.split(oldText).join(newText);
          where = "вхождений: " + positions.length;
        } else {
          const idx = Number.isInteger(occurrence) && occurrence >= 1
            ? positions[Math.min(occurrence, positions.length) - 1]
            : positions[0];
          updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
          where = "строка " + lineOf(idx) + (positions.length > 1 ? " (вхождение " + (positions.indexOf(idx) + 1) + " из " + positions.length + ")" : "");
        }
        fs.writeFileSync(p, updated, "utf8");
        return "OK — заменено (" + where + ") в " + p;
    },
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
    "checkUrl": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL, начинающийся с http:// или https:// (например http://localhost:3000)";
        return await checkUrlStatus(url);
    },
    "openUrl": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^(https?|file):\/\//i.test(url)) return "Ошибка: укажи полный URL";
        shell.openExternal(url).catch(() => {});
        return "OK — открыто в браузере: " + url;
    },
    "showImage": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
        if (!IMG_EXTS.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
        const dataUrl = "data:" + (IMG_MIME[ext] || "image/png") + ";base64," + fs.readFileSync(p).toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: p, dataUrl });
        return "OK — изображение показано пользователю: " + p + " (" + st.size + " байт)";
    },
    "analyzeImage": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS_AN = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"];
        if (!IMG_EXTS_AN.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS_AN.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const dataUrl = "data:image/" + (ext === ".svg" ? "svg+xml" : ext.slice(1)) + ";base64," + fs.readFileSync(p).toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: p, dataUrl });
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.visionModel) return "Ошибка: не указана модель для чтения изображений (поле «Модель-зрение» в Настройках).";
        const question = args.question || "Опиши подробно, что изображено на картинке: объекты, текст, UI, цвета, расположение. Это описание пойдёт программисту.";
        try {
          const desc = await describeImageRemote(cfg, dataUrl, question, cfg.visionModel);
          return "Описание изображения (" + p + "):\n" + (desc || "(пусто)") + "\n\nЕсли пользователь ждёт правок по этой картинке — вноси изменения и сообщи итог.";
        } catch (e) {
          return "Ошибка анализа изображения: " + fmtError(e) + ". Проверь ключ и модель-зрение в Настройках → «🖼 Зрение и генерация».";
        }
    },
    "generateImage": async (args, settings) => {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return "Ошибка: укажи prompt — текстовое описание картинки.";
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.imageModel) return "Ошибка: не указана модель для генерации картинок (поле «Модель-генерация» в Настройках).";
        let name = String(args.filename || "").trim();
        if (!name) name = "generated-" + Date.now() + ".png";
        name = path.basename(name).replace(/[^\w.\-]+/g, "_");
        const extG = path.extname(name).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(extG)) name += ".png";
        const out = path.join(agentWorkDir(settings), name);
        try {
          // Ядро отдаёт base64 (оно же работает в браузере, где нет Buffer),
          // файл на диск пишет главный процесс.
          const img = await generateImageRemote(cfg, prompt, cfg.imageModel, { aspectRatio: args.aspect_ratio });
          const buf = Buffer.from(img.b64, "base64");
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, buf);
          const dataUrl = "data:" + img.mediaType + ";base64," + img.b64;
          if (live.activeEmit) live.activeEmit({ type: "image", path: out, dataUrl });
          return "OK — изображение сгенерировано и сохранено: " + out + " (" + buf.length + " байт, " + img.mediaType + ", провайдер: " + img.label + "). Превью уже показано пользователю. Встраивай файл в проект (относительный путь: " + name + ")."
        } catch (e) {
          // Подробности (адрес, все попытки, код и тело ответа) уже внутри ошибки
          // из ядра — здесь только напоминаем, где смотреть настройки.
          return (
            "Ошибка генерации изображения: " + fmtError(e) +
            "\nВспомогательная модель: " + (cfg.url || "адрес не задан") + " · модель «" + (cfg.imageModel || "не задана") + "». Тип подключения приложение определяет по адресу само."
          );
        }
    },
    "checkPort": async (args, settings) => {
        const port = parseInt(args.port, 10);
        if (!port || port < 1 || port > 65535) return "Ошибка: укажи корректный порт (1–65535)";
        return await new Promise((resolve) => {
          const sock = net.connect({ port, host: "127.0.0.1" });
          sock.setTimeout(2000);
          sock.once("connect", () => { sock.destroy(); resolve("Порт " + port + " занят — на нём что-то слушает."); });
          sock.once("timeout", () => { sock.destroy(); resolve("Порт " + port + " свободен."); });
          sock.once("error", () => { sock.destroy(); resolve("Порт " + port + " свободен (соединение отклонено)."); });
        });
    },
    "listPorts": async (args, settings) => {
        const cmd = process.platform === "win32"
          ? "netstat -ano -p tcp"
          : "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null";
        const out = await runTerminalCommand(cmd, os.homedir(), 15000);
        const lines = String(out)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /LISTEN|LISTENING/i.test(l))
          .slice(0, 40);
        return "Слушающие порты:\n" + (lines.join("\n") || "не удалось получить список портов:\n" + String(out).slice(0, 1000));
    },
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
    "diffView": async (args, settings) => {
        const p1 = resolvePath(args.path1, settings);
        const p2 = resolvePath(args.path2, settings);
        if (!fs.existsSync(p1)) return "Ошибка: не найден путь: " + p1;
        if (!fs.existsSync(p2)) return "Ошибка: не найден путь: " + p2;
        const r = await unifiedDiff(p1, p2);
        if (!r.patch) return "Файлы идентичны: " + p1 + " = " + p2;
        if (live.activeEmit) live.activeEmit({ type: "diff", a: p1, b: p2, patch: r.patch });
        return "Дифф " + p1 + " ↔ " + p2 + " (открыт в просмотрщике приложения):\n\n" + truncateText(r.patch, 8000);
    },
    "previewUI": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        if (live.activeEmit) live.activeEmit({ type: "preview", url });
        return "OK — открыт встроенный предпросмотр: " + url + " (закрывается кнопкой ✕ в углу окна предпросмотра)";
    },
    "screenshotCapture": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        const shot = await screenshotUrl(url);
        if (!shot.ok) return "Ошибка скриншота: " + shot.err;
        if (live.activeEmit) live.activeEmit({ type: "image", path: url, dataUrl: shot.dataUrl });
        let saved = null;
        try {
          const buf = Buffer.from(String(shot.dataUrl).split(",")[1] || "", "base64");
          if (buf.length) saved = saveScreenshotPng(buf, "page", shot.mime);
        } catch {}
        return "OK — скриншот " + url + " снят (1280×800), показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
    },
    "envSet": async (args, settings) => {
        const key = String(args.key || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return "Ошибка: имя переменной должно быть вида DATABASE_URL (латиница, цифры, подчёркивание)";
        }
        const value = String(args.value ?? "");
        const s = loadSettings();
        live.userAgentEnv[key] = value;
        // Читаем ИМЕННО через мост: после разреза модуля «голое» имя main.js здесь
        // недоступно — было ReferenceError, и envSet отвечал ошибкой вместо работы.
        s.agentEnv = { ...live.userAgentEnv };
        // Выдача: вручную ограничить, кому переменная подставляется. Без scopes —
        // как раньше, всем командам агента. Имена проверяет политика при сохранении.
        const askedScope = args.scopes !== undefined;
        if (askedScope) {
          const list = Array.isArray(args.scopes) ? args.scopes : [args.scopes];
          s.agentEnvScopes = { ...(s.agentEnvScopes || {}), [key]: list };
        }
        saveSettings(s);
        applyAgentEnv(s);
        const scopeNote = askedScope ? " Выдача: " + live.scopeSummary(key) + "." : "";
        const who = askedScope
          ? " Значение получат только названные команды."
          : " Она подставляется командам агента (всем, пока не ограничишь выдачу).";
        return "OK — переменная " + key + " задана." + scopeNote + who + " Значение в чат не выводится.";
    },
    "envList": async (args, settings) => {
        const keys = Object.keys(live.agentEnv);
        if (!keys.length) return "Переменные окружения агента не заданы. Задай через envSet(key, value).";
        const auto = ycAutoEnv(loadSettings());
        return "Доступные переменные (" + keys.length + "):\n" +
          keys.map((k) => {
            const v = String(live.agentEnv[k] || "");
            const scope = live.scopeSummary ? live.scopeSummary(k) : "";
            return "• " + k + " — установлена (" + v.length + " симв.)" + (k in auto ? " [авто: Yandex Cloud]" : "") + (scope ? " [выдача: " + scope + "]" : "");
          }).join("\n") +
          "\n\nЗначения скрыты — их получают только те команды, которым переменная выдана.";
    },
    "envUnset": async (args, settings) => {
        const key = String(args.key || "").trim();
        if (!key) return "Ошибка: укажи key";
        const auto = ycAutoEnv(loadSettings());
        if (!(key in live.userAgentEnv)) {
          if (key in auto) {
            return "Переменная " + key + " подставляется автоматически из настроек Yandex Cloud (Настройки → Yandex Cloud) — вручную её убрать нельзя.";
          }
          return "Переменная «" + key + "» не задана.";
        }
        const s = loadSettings();
        delete live.userAgentEnv[key];
        s.agentEnv = { ...live.userAgentEnv };
        saveSettings(s);
        applyAgentEnv(s);
        return "OK — переменная " + key + " удалена.";
    },
    "writeFile": async (args, settings) => {
        if (!args.path) return "Ошибка: укажи path";
        const p = resolvePath(args.path, settings);
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
        const content = String(args.content ?? "");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const existed = fs.existsSync(p);
        fs.writeFileSync(p, content, "utf8");
        const lines = content ? content.split("\n").length : 0;
        const sizeNote = content ? ", " + content.length + " символов" : "";
        // Проверка сразу после записи: «успешно сохранённый» сломанный файл агент
        // находит через десять шагов, когда что-то не запускается.
        const check = args.check === false ? { checked: false, problem: "" } : checkWrittenFile(p, content);
        const checkNote =
          args.check === false
            ? ""
            : check.problem
              ? "\n⚠ Проверка после записи: " + check.problem + "\nФайл записан, но он сломан — почини его следующим writeFile и только потом запускай."
              : check.checked
                ? "\nПроверка после записи: ок."
                : "";
        return "OK — файл " + (existed ? "перезаписан" : "создан") + ": " + p + " (" + lines + " строк" + sizeNote + ")" + checkNote + envNoteFor(p);
    },
    "webSearch": async (args, settings) => {
        const q = String(args.query || args.q || "").trim();
        // Serper (Google), если ключ задан в настройках; иначе — DuckDuckGo
        return await webSearch(q, settings && settings.serperApiKey);
    },
    "webFetch": async (args, settings) => {
        return await webFetchPage(args.url);
    },
    "browserConnect": async (args, settings) => {
        return await browserTools.connect(args);
    },
    "browserOpen": async (args, settings) => {
        const opened = await browserTools.open(args);
        // Есть справочник по этому сайту — говорим сразу, а не после блужданий.
        if (typeof opened === "string" && !/^Ошибка/.test(opened)) {
          const g = guideForUrl(args && args.url);
          if (g) {
            return (
              opened +
              "\n📘 По этому сайту есть справочник агента «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") +
              " — прочитай ПЕРЕД действиями: agentGuide { name: \"" + g.name + "\" } (маршруты, подводные камни, селекторы)."
            );
          }
        }
        return opened;
    },
    "browserSnapshot": async (args, settings) => {
        return await browserTools.snapshot(args);
    },
    "browserFill": async (args, settings) => {
        return await browserTools.fill(args);
    },
    "browserClick": async (args, settings) => {
        return await browserTools.click(args);
    },
    "browserAct": async (args, settings) => {
        return await browserTools.act(args);
    },
    "browserSelect": async (args, settings) => {
        return await browserTools.select(args);
    },
    "browserPress": async (args, settings) => {
        return await browserTools.press(args);
    },
    "browserText": async (args, settings) => {
        return await browserTools.text(args);
    },
    "browserScreenshot": async (args, settings) => {
        // Скриншот сохраняем ФАЙЛОМ (data URL в контексте агента — это десятки
        // тысяч токенов). Файл показываем пользователю и, если настроено зрение,
        // разбираем vision-моделью. Модель может не ответить — тогда честно
        // говорим об этом и оставляем агенту пути по DOM.
        const shotDir = path.join(os.tmpdir(), "ai-agent-shots");
        const shot = await browserTools.screenshotFile(Object.assign({}, args, { dir: shotDir }));
        if (shot.error) return shot.error;
        const shotData = "data:image/png;base64," + shot.buf.toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: shot.path, dataUrl: shotData });
        let shotOut =
          "OK — скриншот сохранён" + (shot.path ? ": " + shot.path : " (файл записать не удалось, картинка показана в чате)") +
          "\nСтраница: " + (shot.url || "—") + (shot.title ? " («" + shot.title + "»)" : "");
        const vcfg = auxConfig(settings);
        if (args && args.analyze === false) {
          shotOut += "\nДальше: analyzeImage { path: \"" + shot.path + "\" } при необходимости.";
        } else if (vcfg.visionModel && vcfg.key) {
          // Зрение включается, как только указана модель и есть ключ (галочка «Зрение»
          // лишь разрешает авто-пре-пасс присланных картинок). Спрашиваем про кликабельное:
          // карта DOM врёт на кастомных компонентах, а разбор скриншота — нет.
          try {
            const q =
              args && args.question
                ? String(args.question)
                : "Разбери скриншот страницы как инструкцию к действию, коротко и по делу: 1) что это за экран (сайт, диалог, шаг); 2) какие элементы КЛИКАБЕЛЬНЫ (кнопки, ссылки, вкладки, чекбоксы) — их точные подписи; 3) какие поля ввода и что в них; 4) что мешает (баннеры, согласия, перекрытия) и что нажать, чтобы их убрать; 5) что находится ЗА пределами экрана (видно начало списка/край элемента). Без воды — это уйдёт программисту, который видит только текст.";
            const desc = await describeImageRemote(vcfg, shotData, q, vcfg.visionModel);
            shotOut += "\n\nЧто видно (vision-модель):\n" + (desc || "(пусто)");
          } catch (e) {
            shotOut +=
              "\n\nVision-модель не ответила (" + String((e && e.message) || e).slice(0, 120) + ") — это не блокер: работай по DOM." +
              "\nbrowserSnapshot (карта с ref) · browserDOM (HTML слоя) · browserEval (JS на странице) · browserOverlays (слои и помехи).";
          }
        } else {
          shotOut +=
            "\n\nЗрение не настроено — работай по DOM: browserSnapshot, browserDOM, browserEval, browserOverlays." +
            "\nЧтобы я видел страницу: Настройки → вкладка «Зрение» → включи и укажи модель (например gemini-2.5-flash), затем повтори скриншот.";
        }
        return shotOut;
    },
    "browserEval": async (args, settings) => {
        return await browserTools.evalJs(args);
    },
    "browserDOM": async (args, settings) => {
        return await browserTools.domHtml(args);
    },
    "browserOverlays": async (args, settings) => {
        return await browserTools.overlays(args);
    },
    "browserWait": async (args, settings) => {
        return await browserTools.wait(args);
    },
    "browserScroll": async (args, settings) => {
        return await browserTools.scroll(args);
    },
    "browserHover": async (args, settings) => {
        return await browserTools.hover(args);
    },
    "browserNetwork": async (args, settings) => {
        return await browserTools.network(args);
    },
    "browserReplay": async (args, settings) => {
        return await browserTools.replay(args);
    },
    "waitForIdle": async (args, settings) => {
        return await browserTools.waitForIdle(args);
    },
    "agentGuide": async (args, settings) => {
        return agentGuideCall(args);
    },
    "browserClose": async (args, settings) => {
        return await browserTools.close(args);
    },
    "browserStatus": async (args, settings) => {
        return await browserTools.status();
    },
    "browserClearProfile": async (args, settings) => {
        return await browserTools.clearProfile();
    },
    "vaultList": async (args, settings) => {
        return vault.listText(loadSettings().sitePasswords);
    },
    "vaultFill": async (args, settings) => {
        const site = args.site || args.name || args.url || "";
        const entry = vault.findEntry(loadSettings().sitePasswords, site);
        if (!entry) return vault.notFoundText(loadSettings().sitePasswords, site);
        return await vault.fillLogin(entry, args, browserTools);
    },
    "mailSend": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.allowSend) {
          return "⛔ Отправка писем агентом ЗАПРЕЩЕНА. Скажи пользователю включить Настройки → «✉️ Почта» → чекбокс «Разрешить агенту отправлять письма».";
        }
        if (!cfg.address || !cfg.password || !cfg.smtpHost) {
          return "Почта не настроена. Скажи пользователю: Настройки → «✉️ Почта» → адрес, пароль приложения, затем кнопка «Определить по адресу».";
        }
        const r = await mail.sendMail(
          { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.user, password: cfg.password, secure: !cfg.starttls, starttls: cfg.starttls },
          { fromName: cfg.fromName, to: args.to || args.recipient, subject: args.subject, text: args.text, html: args.html }
        );
        if (!r.ok) return "Ошибка отправки: " + r.error;
        return "OK — письмо отправлено: " + (Array.isArray(r.to) ? r.to.join(", ") : r.to) + ". Тема: " + String(args.subject || "").slice(0, 120);
    },
    "mailList": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: args.limit, unseenOnly: args.unseenOnly === true }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        if (!r.messages.length) return "Входящих писем нет (ящик пуст).";
        const rows = r.messages.map((m) => {
          const code = mail.extractCode(m.text);
          const preview = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
          return "• " + m.from + "\n  Тема: " + m.subject + "\n  Дата: " + m.date + (code ? "\n  Код: " + code : "") + "\n  " + preview;
        });
        return "Последние письма (" + r.messages.length + " из " + r.total + "):\n\n" + rows.join("\n\n") + "\n\nОтправить письмо: mailSend(to, subject, text).";
    },
    "mailCode": async (args, settings) => {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: Math.min(parseInt(args.limit, 10) || 5, 10) }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        const want = String(args.from || args.query || "").trim().toLowerCase();
        const list = want ? r.messages.filter((m) => (m.from + " " + m.subject).toLowerCase().includes(want)) : r.messages;
        for (const m of list) {
          const code = mail.extractCode(m.text);
          if (code) return "Код подтверждения: " + code + "\nИз письма: " + m.subject + " (" + m.from + ", " + m.date + ")";
        }
        return "Код подтверждения не найден в последних " + r.messages.length + " письмах" + (want ? " от «" + want + "»" : "") + ". Вызови mailList — возможно, письмо ещё не пришло.";
    },
    "appRead": async (args, settings) => {
        return await appUi.read(args, live.mainWindow);
    },
    "appClick": async (args, settings) => {
        return await appUi.click(args, live.mainWindow);
    },
    "appFill": async (args, settings) => {
        return await appUi.fill(args, live.mainWindow);
    },
    "appSelect": async (args, settings) => {
        return await appUi.select(args, live.mainWindow);
    },
    "appPress": async (args, settings) => {
        return await appUi.press(args, live.mainWindow);
    },
    "appWait": async (args, settings) => {
        return await appUi.wait(args, live.mainWindow);
    },
    "appScreenshot": async (args, settings) => {
        const dataUrl = await appUi.screenshot(args, live.mainWindow);
        if (live.activeEmit) live.activeEmit({ type: "image", path: "app:window", dataUrl });
        return "OK — скриншот окна приложения снят и показан во встроенном просмотрщике. Детали разбирай через analyzeImage.";
    },
    "searchFile": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const pattern = String(args.pattern || args.regex || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 40, 100);
        const context = Math.min(Math.max(parseInt(args.context, 10) || 0, 0), 40);
        const blocks = args.blocks === true || args.blocks === "true" || args.blocks === "1" || args.blocks === 1;
        let re = null;
        try {
          re = new RegExp(pattern, args.caseSensitive ? "" : "i");
        } catch {}
        const all = fs.readFileSync(p, "utf8").split("\n");
        const hits = [];
        let total = 0;
        for (let i = 0; i < all.length; i++) {
          const line = all[i];
          if (re ? re.test(line) : line.includes(pattern)) {
            total++;
            if (hits.length < maxResults) hits.push({ n: i + 1, text: line.trim().slice(0, 300) });
          }
        }
        if (!total) return "Совпадений по «" + pattern + "» в " + p + " нет.";
        const pad = String(all.length).length;
        let shown;
        if (blocks) {
          // Режим «блоками»: вместо отдельных строк показываем целиком enclosing-определения
          // (функции/классы/методы и т.п. по OUTLINE_RULES) с диапазоном строк.
          const ranges = buildBlockRanges(all);
          const byBlock = new Map();
          for (const h of hits) {
            let owner = null;
            for (const r of ranges) {
              if (r.start > h.n) break;
              if (h.n <= r.end) owner = r; // последний подходящий = самый вложенный
            }
            if (!owner) owner = { start: h.n, end: h.n, kind: "строка", name: "строка " + h.n };
            const key = owner.start + "|" + owner.name;
            if (!byBlock.has(key)) byBlock.set(key, { owner, hits: [] });
            byBlock.get(key).hits.push(h);
          }
          const MAX_BLOCK_LINES = 120;
          const blockCap = Math.min(maxResults, 20); // блоки крупнее строк — лимит строже
          const lines = [];
          let blocksShown = 0;
          for (const { owner, hits: hh } of byBlock.values()) {
            if (blocksShown >= blockCap) break;
            blocksShown++;
            const from = owner.start;
            const to = Math.min(owner.end, from + MAX_BLOCK_LINES - 1);
            const hitSet = new Set(hh.map((x) => x.n));
            lines.push("── " + owner.kind + " " + owner.name + " (строки " + owner.start + "–" + to + (to < owner.end ? "+" : "") + ") ──");
            for (let i = from; i <= to; i++) {
              lines.push((hitSet.has(i) ? ">" : " ") + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            if (to < owner.end) lines.push("        … (блок обрезан: ещё " + (owner.end - to) + " строк)");
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано блоков: " + blocksShown + " (blocks: true):\n" + truncateText(lines.join("\n"), 9000) + more;
        }
        if (context > 0) {
          // Окна вокруг совпадений: строки context до и после, с отметкой > для самой строки
          shown = [];
          let prevEnd = 0;
          for (const h of hits) {
            const from = Math.max(1, h.n - context);
            const to = Math.min(all.length, h.n + context);
            if (from > prevEnd + 1) shown.push("        … (пропущено)");
            for (let i = from; i <= to; i++) {
              const mark = i === h.n ? ">" : " ";
              shown.push(mark + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            prevEnd = to;
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + " (контекст ±" + context + " строк):\n" + shown.join("\n") + more;
        }
        shown = hits.map((h) => String(h.n).padStart(pad, " ") + " | " + h.text);
        const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
        return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + ":\n" + shown.join("\n") + more;
    },
    "fileOutline": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const content = fs.readFileSync(p, "utf8");
        const filter = String(args.pattern || "").trim();
        const res = buildFileOutline(content, filter || null, 300);
        if (!res.entries.length) {
          return filter
            ? "В структуре " + p + " нет определений, совпадающих с «" + filter + "»."
            : "Определений (функции/классы/заголовки) в " + p + " не найдено. Файл: " + content.split("\n").length + " строк, " + st.size + " байт.";
        }
        return "Структура " + p + " (" + content.split("\n").length + " строк) — " + res.entries.length + " определений" + (filter ? " по фильтру «" + filter + "»" : "") + ":\n" + res.text;
    },
    "listFiles": async (args, settings) => {
        return listProjectFiles(settings, args.path);
    },
    "searchProject": async (args, settings) => {
        const pattern = String(args.pattern || args.regex || args.query || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        return searchProjectFiles(pattern, settings, args.path);
    },
    "askUser": async (args, settings) => {
        return "Ошибка: askUser обрабатывается отдельно — дождись ответа пользователя.";
    },
    "listDirectory": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: папка не найдена: " + p;
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? "[папка] " : "[файл]  ") + e.name);
        return "Содержимое " + p + " (" + entries.length + "):\n" + lines.slice(0, 500).join("\n");
    },
    "gitClone": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!url) return "Ошибка: укажи url репозитория";
        const base = settings.workingDir || os.homedir();
        const dir = args.directory
          ? resolvePath(args.directory, settings)
          : path.join(base, repoNameFromUrl(url));
        const r = await runGit(base, ["clone", url, dir], settings);
        if (r.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(dir, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          live.lastAgentRepoDir = dir; // все следующие git/команды — внутри склонированного репозитория
          live.clonedRepoPending = true; // следующий ответ агента начнётся с анализа нового проекта
          return "OK — репозиторий клонирован: " + dir + "\nТеперь git-команды и терминал работают внутри этого репозитория.";
        }
        return "Ошибка git: " + r.err;
    },
    "gitStatus": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["status"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitCommit": async (args, settings) => {
        if (!args.message) return "Ошибка: укажи message для коммита";
        const cwd = agentWorkDir(settings);
        const add = await stageAllSafe(cwd, settings);
        if (!add.ok) return "Ошибка git add: " + add.err;
        const commit = await runGit(
          cwd,
          ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", String(args.message)],
          settings
        );
        return "git add -A:\n" + add.out + "\n\ngit commit:\n" + (commit.ok ? commit.out : "Ошибка git: " + commit.err);
    },
    "gitPush": async (args, settings) => {
        if (!settings.allowAgentPush) {
          return (
            "⛔ git push заблокирован: пользователь не разрешил агенту отправлять коммиты на GitHub.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push» — после этого инструмент заработает;\n" +
            "2. либо пользователь сам нажимает «Push» во вкладке «Изменения» панели проекта.\n" +
            "Сообщи пользователю, что пуш не выполнен и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const r = await runGit(agentWorkDir(settings), ["push"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitPublish": async (args, settings) => {
        // Создание репозитория + push — та же политика безопасности, что и у gitPush.
        if (!settings.allowAgentPush) {
          return (
            "⛔ gitPublish заблокирован: создание репозитория и отправка кода на GitHub запрещены, пока пользователь не разрешит.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push»;\n" +
            "2. либо пользователь сам нажимает «⬆ Опубликовать на GitHub» в панели проекта.\n" +
            "Сообщи пользователю, что публикация не выполнена и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const cwdP = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        // Не-GitHub хостинг (GitLab, Bitbucket, свой сервер): создание репозитория
        // делается на сайте хостинга, а мы сами прописываем remote и пушим ветку —
        // без GitHub API и без ручных команд в терминале.
        const remoteUrl = String(args.remoteUrl || "").trim();
        if (remoteUrl) {
          if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(remoteUrl)) {
            return "Ошибка: remoteUrl должен быть git-адресом — https://gitlab.com/you/repo.git или git@bitbucket.org:you/repo.git.";
          }
          const remoteName = String(args.remoteName || "origin").trim() || "origin";
          const existR = await runGit(cwdP, ["remote"], settings);
          const hasRemote = String(existR.out || "").split("\n").map((x) => x.trim()).includes(remoteName);
          const setR = await runGit(cwdP, hasRemote ? ["remote", "set-url", remoteName, remoteUrl] : ["remote", "add", remoteName, remoteUrl], settings);
          if (!setR.ok) return "Ошибка git remote: " + setR.err;
          const brR = await runGit(cwdP, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
          const branch = String(brR.out || "").trim() || "main";
          const pushR = await runGit(cwdP, ["push", "-u", remoteName, branch], settings);
          if (!pushR.ok) {
            return (
              "Remote «" + remoteName + "» → " + remoteUrl + " прописан, но push не прошёл:\n" + pushR.err +
              "\n\nЧастые причины: репозиторий ещё не создан на сайте хостинга; нужен токен (для GitLab/Bitbucket — personal access token в адресе вида https://oauth2:TOKEN@host/…) или у аккаунта нет прав на запись."
            );
          }
          return "✅ Отправлено на «" + remoteName + "» (" + remoteUrl + "), ветка " + branch + ".\n" + (pushR.out || "Готово (без вывода).");
        }
        const resP = await publishLocalToGithub(cwdP, settings, {
          name: args.name,
          description: args.description,
          private: args.private !== false,
          message: args.message,
        });
        return resP.ok
          ? "✅ " + resP.message
          : "Ошибка публикации: " + resP.error;
    },
    "gitInit": async (args, settings) => {
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка не найдена: " + dir;
        const s = loadSettings();
        const check = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
        if (check.ok && String(check.out || "").trim() === "true") {
          return "Эта папка уже git-репозиторий: " + dir + "\nСостояние смотри через gitStatus.";
        }
        let initR = await runGit(dir, ["init", "-b", "main"], s);
        if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые git без -b
        if (!initR.ok) return "Ошибка git init: " + initR.err;
        const msg = String(args.message || "").trim();
        if (msg) {
          const addR = await runGit(dir, ["add", "-A"], s);
          if (!addR.ok) return "Репозиторий создан, но первый коммит не удался: " + addR.err;
          const commitR = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
          if (!commitR.ok) return "Репозиторий создан, но первый коммит не удался: " + commitR.err;
          return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main), первый коммит «" + msg + "» сделан.\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit — новые коммиты, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
        }
        return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main).\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit(message) — сделать первый коммит, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
    },
    "gitPull": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["pull"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitLog": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["log", "--oneline", "-n", "30", "--decorate"], settings);
        return r.ok ? (r.out || "Коммитов пока нет.") : "Ошибка git: " + r.err;
    },
    "gitRevert": async (args, settings) => {
        if (!args.commit) return "Ошибка: укажи commit (хэш, например HEAD~1)";
        const r = await runGit(agentWorkDir(settings), ["revert", "--no-edit", String(args.commit)], settings);
        return r.ok ? "OK — коммит отменён:\n" + (r.out || "") : "Ошибка git: " + r.err;
    },
    "readFileStructure": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const r = buildFileStructure(p, args.pattern);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.rows.length) return "В файле не найдено импортов/экспортов/объявлений" + (args.pattern ? " по фильтру «" + args.pattern + "»" : "") + ": " + p;
        const pad = String(r.totalLines).length;
        const text = r.rows.map((x) => String(x.line).padStart(pad, " ") + " | " + x.kind.padEnd(6, " ") + " | " + x.text).join("\n");
        return "Структура " + p + " (" + r.totalLines + " строк, показано " + r.rows.length + "):\n" + truncateText(text, 9000) + "\n\nФрагмент читай через readFileLines(path, start, count).";
    },
    "explainCode": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Смотри структуру через fileOutline, фрагменты — readFileLines.";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const total = all.length;
        const blocks = buildBlockRanges(all);
        const pad = String(total).length;
        const capWindow = 220; // максимум строк в одном окне
        const focus = { how: "весь файл (по умолчанию — начало)", start: 1, end: Math.min(total, 120) };
        if (args.symbol) {
          const sym = String(args.symbol).trim();
          const hits = blocks.filter((b) => sym && b.name && b.name.toLowerCase().includes(sym.toLowerCase()));
          if (!hits.length) {
            const outline = buildFileOutline(all.join("\n"), null, 300);
            return "Не нашёл определение по имени «" + sym + "» в " + p + ". Структура файла:\n" + outline.text +
              "\n\nУкажи точное имя (fileOutline / searchFile blocks:true помогут найти) или строку через line.";
          }
          const b = hits[0];
          focus.how = "символ «" + sym + "» → блок «" + b.name + "» (" + b.kind + ", строки " + b.start + "–" + b.end + ")" +
            (hits.length > 1 ? "; есть ещё совпадения на строках " + hits.slice(1).map((x) => x.start).join(", ") : "");
          focus.start = b.start;
          focus.end = b.end;
        } else if (args.line != null || args.start != null) {
          const raw = parseInt(args.line != null ? args.line : args.start, 10);
          const want = Math.max(1, Math.min(raw || 1, total));
          if (args.endLine != null) {
            focus.how = "строки " + want + "–" + Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
            focus.start = want;
            focus.end = Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
          } else {
            // Без endLine расширяем до границ enclosing-блока (функция/класс/метод по OUTLINE_RULES)
            let enc = null;
            for (const b of blocks) if (b.start <= want) enc = b;
            if (enc) {
              focus.how = "строка " + want + " → внутри блока «" + enc.name + "» (" + enc.kind + ", строки " + enc.start + "–" + enc.end + ")";
              focus.start = enc.start;
              focus.end = enc.end;
            } else {
              focus.how = "строка " + want + " (вне определений — показано ±24 строки)";
              focus.start = want;
              focus.end = Math.min(total, want + 24);
            }
          }
        }
        if (focus.end - focus.start + 1 > capWindow) {
          focus.end = focus.start + capWindow - 1;
          focus.how += " (обрезано до " + capWindow + " строк — сузь диапазон endLine)";
        }
        // Импорты в шапке файла — до первой «рабочей» строки кода
        const imports = [];
        for (let i = 0; i < Math.min(total, 80); i++) {
          const t = all[i].trim();
          if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#") || t.startsWith("<!--")) continue;
          if (/^(import\b|from\s+["']|require\(|#include|use\s+[A-Za-z_:]+;|package\s+[A-Za-z_])/.test(t)) {
            imports.push(String(i + 1).padStart(pad, " ") + " | " + all[i].trim().slice(0, 110));
            if (imports.length >= 25) break;
          } else if (imports.length) {
            break; // импорты кончились
          }
        }
        const inside = buildFileOutline(all.join("\n"), null, 400).entries.filter((e) => e.line >= focus.start && e.line <= focus.end);
        const win = numberedLines(all, focus.start, focus.end, total);
        const out = [];
        out.push("Файл " + p + " (" + langFromExt(p) + ", " + total + " строк, " + st.size + " байт)");
        out.push("Запрос: " + focus.how);
        if (imports.length) out.push("\nИмпорты/зависимости (шапка файла, " + imports.length + "):\n" + imports.join("\n"));
        out.push("\nКод (строки " + focus.start + "–" + focus.end + "):\n" + win);
        if (inside.length) {
          out.push("\nВ этом окне определено:\n" + inside.map((e) => String(e.line).padStart(pad, " ") + " | " + e.kind.padEnd(8, " ") + " | " + e.name).join("\n"));
        }
        const markers = [];
        for (let i = focus.start - 1; i < focus.end && i < all.length; i++) {
          const t = all[i] || "";
          if (/TODO|FIXME|HACK|XXX/.test(t)) markers.push(String(i + 1).padStart(pad, " ") + " | " + t.trim().slice(0, 100));
        }
        if (markers.length) out.push("\nМаркеры TODO/FIXME в окне:\n" + markers.join("\n"));
        out.push("\nОбъясни пользователю этот код своими словами. Больше контекста: fileOutline (структура), readFileLines (другой диапазон), searchFile с blocks:true, findReferences (где используется).");
        return truncateText(out.join("\n"), 16000);
    },
    "undoEdit": async (args, settings) => {
        loadPersistedUndo();
        const p = args.path ? resolvePath(args.path, settings) : null;
        if (!p) {
          if (!live.lastUndoLog.length && !live.activeRunUndo.length) return "Нет изменений для отката (undo-журнал пуст).";
          const counts = new Map();
          for (const u of [...activeRunUndo, ...lastUndoLog]) counts.set(u.path, (counts.get(u.path) || 0) + 1);
          return "Можно откатить (по одному — undoEdit(path), шагами — undoEdit(path, steps: N)):\n" +
            [...counts.entries()].map(([f, c]) => "• " + f + (c > 1 ? " — шагов в истории: " + c : "")).join("\n");
        }
        // Снимки файла: сначала свежие из текущего запуска, затем из сохранённого журнала.
        const snaps = [];
        for (let i = live.activeRunUndo.length - 1; i >= 0; i--) if (live.activeRunUndo[i].path === p) snaps.push(live.activeRunUndo[i]);
        for (let i = live.lastUndoLog.length - 1; i >= 0; i--) if (live.lastUndoLog[i].path === p) snaps.push(live.lastUndoLog[i]);
        if (!snaps.length) return "Нет снимка для отката: " + p + " (агент не менял этот файл в последних запусках).";
        const steps = Math.min(Math.max(parseInt(args.steps, 10) || 1, 1), snaps.length);
        const popped = snaps.slice(0, steps); // снимаем steps самых свежих
        const target = popped[popped.length - 1]; // возвращаемся к состоянию до самой ранней из откатываемых правок
        try {
          if (target.content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } else {
            fs.writeFileSync(p, target.content, "utf8");
          }
        } catch (e) {
          return "Ошибка отката: " + (e.message || String(e));
        }
        const gone = new Set(popped);
        live.activeRunUndo = live.activeRunUndo.filter((u) => !gone.has(u));
        live.lastUndoLog = live.lastUndoLog.filter((u) => !gone.has(u));
        persistUndo();
        const how = popped.length === 1 ? "последнюю правку агента" : popped.length + " правки агента";
        return target.content === null
          ? "OK — файл удалён (он был создан агентом): " + p
          : "OK — файл откачен на " + how + " назад: " + p + " (снимков осталось: " + Math.max(0, snaps.length - popped.length) + ")";
    },
    "refactorRename": async (args, settings) => {
        const oldName = String(args.oldName || "").trim();
        const newName = String(args.newName || "").trim();
        const dryRun = !!args.dryRun;
        const root = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(root)) return "Ошибка: не найден путь: " + root;
        const r = refactorRenameFiles(root, oldName, newName, dryRun);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.changed.length) return "Совпадений «" + oldName + "» не найдено" + (args.path ? " в " + args.path : " по проекту") + ".";
        const head = dryRun
          ? "🔍 dryRun — ничего не изменено. Будет заменено «" + oldName + "» → «" + newName + "» (" + r.total + " вхожд.):"
          : "OK — заменено " + r.total + " вхожд. «" + oldName + "» → «" + newName + "» в " + r.changed.length + " файлах:";
        const lines = r.changed.slice(0, 40).map((c) => "• " + c.rel + " — " + c.count + " вхожд." + (c.sample ? "\n    " + c.sample : ""));
        return truncateText(head + "\n" + lines.join("\n") + (r.changed.length > 40 ? "\n… и ещё " + (r.changed.length - 40) + " файлов" : ""), 9000);
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
    "getSystemInfo": async (args, settings) => {
        const rows = [];
        const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
        rows.push("ОС: " + osName + (process.arch ? " (" + process.arch + ")" : ""));
        rows.push("Версия Node.js (приложение): " + (process.version || ""));
        rows.push("Домашний каталог: " + os.homedir());
        rows.push("Рабочая директория агента: " + agentWorkDir(settings));
        rows.push("Записей в PATH: " + (envPathInfo().value || "").split(path.delimiter).filter(Boolean).length);
        rows.push("");
        // Расширенная информация: Windows — PowerShell/CIM, остальные — os.*
        if (process.platform === "win32") {
          const ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$os=Get-CimInstance Win32_OperatingSystem; " +
            "$cpu=Get-CimInstance Win32_Processor; " +
            "$gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1; " +
            "$ips=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }); " +
            "$disks=@(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Root=$_.Root; UsedGB=[math]::Round($_.Used/1GB,1); FreeGB=[math]::Round($_.Free/1GB,1) } }); " +
            "[pscustomobject]@{ os=$os.Caption; build=$os.Version; cpu=$cpu.Name; gpu=$gpu.Name; ramGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); ips=$ips; disks=$disks } | ConvertTo-Json -Compress -Depth 3";
          // CIM-запрос конфигурации ПК — самый дорогой в инструменте, а меняется
          // он раз в жизни машины: 30 с кэша снимают повторный обход системы.
          const siRaw = await cachedPs("sysinfo", 30000, async () => {
            const r = await psScript(ps, 30000);
            return r.ok ? r.out : "";
          });
          const si = parseSysInfoJson(siRaw);
          if (si.os) rows.push("Windows: " + si.os + (si.build ? " (build " + si.build + ")" : ""));
          if (si.cpu) rows.push("CPU: " + truncateText(si.cpu, 100));
          if (si.gpu) rows.push("GPU: " + truncateText(si.gpu, 100));
          if (si.ramGB) rows.push("RAM: " + si.ramGB + " ГБ");
          if (Array.isArray(si.ips) && si.ips.length) rows.push("IP-адреса (LAN): " + si.ips.join(", "));
          if (Array.isArray(si.disks) && si.disks.length) {
            rows.push("Диски:");
            for (const d of si.disks) {
              rows.push("• " + (d.Root || "?") + " — свободно " + (d.FreeGB != null ? d.FreeGB : "?") + " ГБ, занято " + (d.UsedGB != null ? d.UsedGB : "?") + " ГБ");
            }
          }
        } else {
          const cpus = os.cpus();
          if (cpus && cpus.length) rows.push("CPU: " + truncateText(cpus[0].model, 100) + " (" + cpus.length + " ядер)");
          rows.push("RAM: " + Math.round(os.totalmem() / 1024 / 1024 / 1024) + " ГБ всего, свободно " + Math.round(os.freemem() / 1024 / 1024 / 1024) + " ГБ");
          const ips = [];
          for (const k of Object.keys(os.networkInterfaces())) {
            for (const a of os.networkInterfaces()[k] || []) {
              if (a && a.family === "IPv4" && !a.internal && a.address && a.address.indexOf("127.") !== 0) ips.push(a.address);
            }
          }
          if (ips.length) rows.push("IP-адреса (LAN): " + ips.join(", "));
        }
        rows.push("");
        rows.push("Ключевые программы:");
        for (const n of ["git", "node", "npm", "python", "docker"]) {
          const f = findProgram(n);
          if (!f.found) rows.push("• " + n + ": не установлен");
          else {
            const v = await runProgVersion(f.path);
            rows.push("• " + n + ": " + (v || "установлен — " + f.path));
          }
        }
        // Установленные программы через winget (кратко: количество + первые 10)
        if (process.platform === "win32") {
          const w = await spawnRaw(["winget", "list", "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 25000 });
          const wl = (w.out || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Name[ ]+Id[ ]+Version/i.test(l) && l.indexOf("---") !== 0 && !/^[0-9]+ package/i.test(l));
          if (wl.length) {
            rows.push("");
            rows.push("Установленные программы (winget, всего ~" + wl.length + "):");
            for (const l of wl.slice(0, 10)) rows.push("• " + l);
          }
        }
        rows.push("");
        rows.push("Советы: не установлено → installSystemPackage(имя) или wingetSearch(имя); не видно после установки → refreshEnv(); нужны права администратора → runCommandAsAdmin(команда); зависший процесс → listProcesses + killProcess; непонятная ошибка → explainError(код).");
        return rows.join("\n");
    },
    "installSystemPackage": async (args, settings) => {
        return await installSystemPkg(args.packageName);
    },
    "runCommandAsAdmin": async (args, settings) => {
        return await runAsAdmin(args.command);
    },
    "refreshEnv": async (args, settings) => {
        return await refreshEnvFromOS();
    },
    "explainError": async (args, settings) => {
        const codeRaw = args.exitCode;
        const code = codeRaw == null || codeRaw === "" ? NaN : parseInt(codeRaw, 10);
        return explainExit(Number.isNaN(code) ? NaN : code, args.command);
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
    "downloadAndExtract": async (args, settings) => {
        const dest = args.path ? resolvePath(args.path, settings) : path.join(agentWorkDir(settings), "downloads");
        return await downloadAndExtractTo(args.url, dest);
    },
    "apiRequest": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL (http/https)";
        const method = String(args.method || "GET").toUpperCase();
        const headers = args.headers && typeof args.headers === "object" ? { ...args.headers } : {};
        let body = args.body;
        if (body && typeof body === "object") {
          body = JSON.stringify(body);
          if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const res = await fetch(url, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : String(body),
            signal: ctrl.signal,
            redirect: "follow",
          });
          const text = await res.text();
          const ct = res.headers.get("content-type") || "";
          const isText = /text|json|xml|javascript|html|urlencoded/i.test(ct) || text.length === 0;
          const shown = isText
            ? truncateText(text, 6000)
            : "(" + text.length + " байт, тип " + (ct || "неизвестен") + " — бинарное тело не показываю)";
          return "HTTP " + res.status + " " + res.statusText + " — " + method + " " + url + "\n" +
            "Content-Type: " + (ct || "—") + "\n" +
            "Объём тела: " + Buffer.byteLength(text, "utf8") + " байт\n\n" + shown;
        } catch (e) {
          return "Ошибка " + method + " " + url + ": " + ((e && e.name === "AbortError") ? "таймаут (30 с)" : (e && e.message) || String(e));
        } finally {
          clearTimeout(timer);
        }
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
    "gitBranch": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const cur = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
        const list = await runGit(cwd, ["branch", "-a", "--no-color"], settings);
        if (!cur.ok && !list.ok) return "Ошибка git: " + (cur.err || list.err);
        return "Текущая ветка: " + (cur.ok ? cur.out : "(не git-репозиторий)") + "\n\nВсе ветки:\n" + (list.ok ? list.out : "(веток нет)");
    },
    "gitCheckout": async (args, settings) => {
        const cwdCh = agentWorkDir(settings);
        const branch = String(args.branch || args.name || "").trim();
        if (!branch) return "Ошибка: укажи branch — имя ветки (create: true, чтобы создать новую)";
        const create = !!args.create;
        const r = await runGit(cwdCh, ["checkout", ...(create ? ["-b", branch] : [branch])], settings);
        if (!r.ok) {
          const hint = create
            ? ""
            : "\n(Если ветки ещё нет — повтори с create: true. Если есть незакоммиченные изменения, мешающие переключению, — сначала закоммить их или отложи через git stash.)";
          return "Ошибка git: " + r.err + hint;
        }
        return "OK — " + (create ? "создана и активирована ветка «" : "переключение на ветку «") + branch + "»:\n" + r.out;
    },
    "findReferences": async (args, settings) => {
        const symbol = String(args.symbol || "").trim();
        if (!symbol) return "Ошибка: укажи symbol (имя функции/переменной/класса)";
        let root = agentWorkDir(settings);
        if (args.path) {
          const rp = resolvePath(args.path, settings);
          if (!fs.existsSync(rp)) return "Ошибка: путь не найден: " + rp;
          root = rp;
        }
        const r = findSymbolReferences(root, symbol);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.hits.length) return "Использований «" + symbol + "» не найдено в " + root + ".";
        const files = new Set(r.hits.map((h) => h.file));
        const defs = r.hits.filter((h) => h.kind === "определение").length;
        const calls = r.hits.filter((h) => h.kind === "вызов").length;
        const mark = { "определение": "◈", "импорт": "⤓", "вызов": "▸", "ссылка": "·" };
        const pad = String(Math.max(...r.hits.map((h) => h.n))).length;
        const text = r.hits.map((h) => (mark[h.kind] || "·") + " " + h.file + ":" + String(h.n).padStart(pad, " ") + "  [" + h.kind + "] " + h.text).join("\n");
        return "Символ «" + symbol + "» — " + r.hits.length + " вхожд. в " + files.size + " файл. (◈ определений: " + defs + ", ▸ вызовов: " + calls + ")\n\n" + truncateText(text, 9000);
    },
    "gitDiff": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const b1 = String(args.branch1 || "").trim();
        const b2 = String(args.branch2 || "").trim();
        const spec = b1 && b2 ? [b1, b2] : b1 ? [b1] : [];
        if (!spec.length) {
          const d = await runGit(cwd, ["diff", "--stat"], settings);
          return d.ok ? (d.out || "Рабочее дерево чистое — нет незакоммиченных изменений.") : "Ошибка git: " + d.err;
        }
        const st = await runGit(cwd, ["diff", "--stat", ...spec], settings);
        const ns = await runGit(cwd, ["diff", "--name-status", ...spec], settings);
        const stat = st.ok ? st.out : "";
        const names = ns.ok ? ns.out : "";
        if (!stat && !names) return "Различий нет: " + spec.join(" … ") + " — ветки идентичны (или ветка не найдена).";
        return "Сравнение " + spec.join(" … ") + " — изменено файлов: " + names.split("\n").filter(Boolean).length + "\n\n" + stat + "\n\n--- Файлы ---\n" + truncateText(names, 3000);
    },
    "gitUndoLastCommit": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const r = await runGit(cwd, ["reset", "--soft", "HEAD~1"], settings);
        if (!r.ok) return "Ошибка git: " + r.err + "\n(Частая причина — в истории нет коммитов для отмены.)";
        return "OK — последний коммит отменён (git reset --soft HEAD~1): его изменения вернулись в рабочее дерево как незакоммиченные, ничего не потеряно.\n" + r.out;
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
    "listProcesses": async (args, settings) => {
        const filter = String(args.filter || "").trim().toLowerCase();
        let out = "";
        if (process.platform === "win32") {
          // Список процессов спрашивают подряд («сервер ещё жив?»): 2 с кэша
          // снимают повторный tasklist, а короткий TTL не показывает мёртвое.
          out = await cachedPs("proc:win", 2000, async () => {
            const r = await spawnRaw(["tasklist", "/FO", "CSV", "/NH"], { cwd: os.homedir(), timeoutMs: 20000 });
            return r.ok ? r.out : "";
          });
        } else {
          const r = await spawnRaw(["ps", "-eo", "pid=,comm=,%cpu=,rss=,args="], { cwd: os.homedir(), timeoutMs: 20000 });
          out = r.ok ? r.out : "";
        }
        let procs = parseProcessesCsv(out);
        if (filter) {
          procs = procs.filter((p) => (p.name || "").toLowerCase().indexOf(filter) !== -1 || (p.args || "").toLowerCase().indexOf(filter) !== -1);
        }
        procs = procs.slice(0, 60);
        if (!procs.length) return "Процессы не найдены" + (filter ? " по фильтру «" + filter + "»" : "") + ".";
        const head = "Процессы" + (filter ? " (фильтр «" + filter + "»)" : "") + " (" + procs.length + " из списка):\n";
        return head + procs.map((p) => {
          const mem = p.mem ? " " + p.mem : p.rss ? " " + Math.round(Number(p.rss) / 1024) + " КБ" : "";
          const argsPart = p.args ? "  «" + truncateText(p.args, 110) + "»" : "";
          return "• PID " + p.pid + " — " + (p.name || "") + mem + argsPart;
        }).join("\n") + "\n\nЗависший процесс завершай через killProcess(pid или name).";
    },
    "killProcess": async (args, settings) => {
        const pid = parseInt(args.pid, 10);
        const name = String(args.name || "").trim();
        const force = args.force === true || args.force === "true" || args.force === 1;
        if (!pid && !name) return "Ошибка: укажи pid (число из listProcesses) или name (например node).";
        let cmd, label;
        if (process.platform === "win32") {
          cmd = "taskkill " + (pid ? "/PID " + pid : "/IM " + name) + " /T" + (force ? " /F" : "");
          label = pid ? "PID " + pid : name;
        } else if (pid) {
          cmd = "kill " + (force ? "-9 " : "") + pid;
          label = "PID " + pid;
        } else {
          cmd = "pkill " + (force ? "-9 " : "-TERM ") + JSON.stringify(name);
          label = name;
        }
        const out = await runTerminalCommand(cmd, os.homedir(), 20000);
        invalidatePsCache("proc:"); // мы только что убили процесс — старый список не отдаём
        const failed = /не найден|ERROR|not found|No matching|No processes|кодом (1|128)/i.test(out);
        return (failed ? "Возможно, процесс уже завершён или не найден:\n" : "OK — процесс " + label + " завершён.\n") + "$ " + cmd + "\n\n" + out;
    },
    "clipboardWrite": async (args, settings) => {
        const text = String(args.text == null ? "" : args.text);
        try {
          clipboard.writeText(text);
        } catch (e) {
          return "Ошибка: не удалось записать в буфер обмена: " + (e.message || String(e));
        }
        return "OK — текст скопирован в буфер обмена (" + text.length + " симв.).";
    },
    "clipboardRead": async (args, settings) => {
        let text = "";
        try {
          text = clipboard.readText() || "";
        } catch (e) {
          return "Ошибка: не удалось прочитать буфер обмена: " + (e.message || String(e));
        }
        if (!text.trim()) return "Буфер обмена пуст (текста нет).";
        return "Содержимое буфера обмена:\n\n" + truncateText(text, 4000);
    },
    "screenshotDesktop": async (args, settings) => {
        const winFilter = String(args.window || "").trim().toLowerCase();
        let sources = [];
        try {
          sources = await desktopCapturer.getSources({
            types: winFilter ? ["window"] : ["screen"],
            thumbnailSize: { width: 1920, height: 1080 },
            fetchWindowIcons: false,
          });
        } catch (e) {
          return "Ошибка захвата экрана: " + (e.message || String(e)) + " (работает только в десктоп-приложении).";
        }
        let src = sources[0];
        if (winFilter) src = sources.find((s) => s.name.toLowerCase().indexOf(winFilter) !== -1) || sources[0];
        if (!src) return "Не удалось получить источники экрана/окон.";
        const shot = encodeShot(src.thumbnail, args);
        if (!shot.buf || !shot.buf.length) return "Пустой скриншот «" + src.name + "» — не удалось захватить.";
        const sz = src.thumbnail.getSize();
        const dataUrl = "data:" + shot.mime + ";base64," + shot.buf.toString("base64");
        if (live.activeEmit) live.activeEmit({ type: "image", path: "desktop:" + src.name, dataUrl });
        let saved = null;
        try {
          if (shot.buf.length) saved = saveScreenshotPng(shot.buf, "screen", shot.mime);
        } catch {}
        return "OK — скриншот «" + src.name + "» (" + sz.width + "×" + sz.height + ") снят, показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
    },
    "registryRead": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        const chk = registryPathAllowed(regPath, false);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        let ps;
        if (name) {
          const escName = name.replace(/'/g, "''");
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "try { $v = Get-ItemPropertyValue -Path '" + esc + "' -Name '" + escName + "' -ErrorAction Stop; Write-Output (($v | Out-String).Trim()) } catch { Write-Output '__ERR__' }";
        } else {
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$i = Get-Item -Path '" + esc + "' -ErrorAction SilentlyContinue; " +
            "if ($null -eq $i) { Write-Output '__ERR__' } else { $d = $i.GetValue(''); if ($null -eq $d) { Write-Output '(раздел без значения по умолчанию)' } else { Write-Output ('Значение по умолчанию: ' + $d) } }";
        }
        // Реестр читают часто, а пишут редко — 5 с кэша на путь+значение;
        // ошибку (нет раздела/нет прав) не кэшируем: её могут исправить сразу.
        const rr = await cachedPs(
          "reg:" + regPath + "|" + name,
          5000,
          async () => {
            const r = await psScript(ps, 20000);
            return { out: (r.out || "").trim(), err: r.err || "" };
          },
          (v) => /__ERR__|Cannot find|не найден|отказано/i.test(v.out)
        );
        const out = rr.out;
        if (out.indexOf("__ERR__") !== -1 || /Cannot find|не найден|отказано/i.test(out + rr.err)) {
          return "Раздел или значение не найдено: " + regPath + (name ? " → " + name : "") + ". Проверь путь — чтение разрешено только из SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY.";
        }
        return "Реестр " + regPath + (name ? " → " + name : "") + ":\n" + out;
    },
    "registryWrite": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        if (!name) return "Ошибка: укажи name (имя значения).";
        const value = String(args.value == null ? "" : args.value);
        const type = String(args.type || "REG_SZ").toUpperCase();
        if (["REG_SZ", "REG_DWORD", "REG_EXPAND_SZ"].indexOf(type) === -1) {
          return "Ошибка: type должен быть REG_SZ, REG_DWORD или REG_EXPAND_SZ.";
        }
        const chk = registryPathAllowed(regPath, true);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        const escName = name.replace(/'/g, "''");
        const valPs = type === "REG_DWORD" ? String(Number(value) || 0) : value.replace(/'/g, "''");
        const ps =
          "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
          "$p = '" + esc + "';" +
          "New-Item -Path $p -Force | Out-Null;" +
          "New-ItemProperty -Path $p -Name '" + escName + "' -Value '" + valPs + "' -PropertyType " + type + " -Force | Out-Null;" +
          "Write-Output 'OK'";
        const r = await psScript(ps, 20000);
        if (!r.ok || (r.out || "").indexOf("OK") === -1) {
          return "Ошибка записи: " + (((r.err || "") + " " + (r.out || "")).trim() || "неизвестная причина") + " — проверь права (HKCU не требует админа) или путь.";
        }
        invalidatePsCache("reg:"); // запись сделана — кэш чтения реестра больше не верен
        return "OK — значение «" + name + "» = «" + value + "» (" + type + ") записано в " + regPath;
    },
    "openPath": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: путь не найден: " + p;
        const err = await shell.openPath(p);
        return err ? "Не удалось открыть: " + err : "OK — открыто системным приложением: " + p;
    },
    "wingetSearch": async (args, settings) => {
        if (process.platform !== "win32") return "Ошибка: winget доступен только на Windows.";
        const q = String(args.query || "").trim();
        if (!q) return "Ошибка: укажи query (например python, ffmpeg, ollama).";
        const r = await spawnRaw(["winget", "search", q, "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 60000 });
        const out = (r.out || "").trim();
        if (!r.ok && !out) {
          return "winget недоступен: " + ((r.err || "").trim() || "код " + r.code) + ". Установи winget (Microsoft Store: «App Installer») или используй installSystemPackage — при отсутствии winget попробует choco/scoop.";
        }
        const lines = out.split("\n").filter((l) => l.trim() && !/^Name\s+Id\s+Version\s+Source/i.test(l));
        return "Результаты winget search «" + q + "»:\n\n" + (lines.slice(0, 25).join("\n") || out || "ничего не найдено") + "\n\nУстановка: installSystemPackage(\"" + q + "\") — если ID уникален, или укажи полный ID вида Vendor.Name из списка.";
    },
    "installExe": async (args, settings) => {
        const url = String(args.url || "").trim();
        const name = String(args.name || "").trim();
        if (!/^https?:\/\//i.test(url)) {
          return "Ошибка: укажи прямой URL установщика — .exe, .msi или .zip (https://...).";
        }
        const tmpDir = path.join(os.tmpdir(), "ai-agent-install");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { return "Ошибка: не удалось создать временную папку: " + (e.message || String(e)); }
        // Расширение берём из URL без строки запроса и #якоря. Имя файла больше
        // НЕ форсируется в .exe — иначе .msi и .zip скачивались как «installer.exe».
        const pathOnly = url.split("#")[0].split("?")[0];
        const ext = (path.extname(pathOnly) || "").toLowerCase();
        const rawBase = (name || path.basename(pathOnly) || "installer").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+$/, "") || "installer";
        const withExt = /\.(exe|msi|zip|msix|appx)$/i.test(rawBase) ? rawBase : rawBase + (ext || ".exe");

        // .zip — не установщик, а архив (portable-сборки): распаковываем и ищем
        // внутри .exe/.msi, чтобы сразу предложить (или выполнить) установку.
        if (ext === ".zip") {
          const destDir = path.join(tmpDir, withExt.replace(/\.zip$/i, "") + "-files");
          const res0 = await downloadAndExtractTo(url, destDir);
          if (/^Ошибка/.test(res0)) return res0;
          const found = findInstallersIn(destDir);
          if (!found.length) {
            return "Архив распакован: " + destDir + "\nУстановщика (.exe/.msi/.bat/.cmd) внутри не нашлось — это portable-сборка, запускай файлы прямо оттуда.\n" + res0;
          }
          const first = found[0];
          if (args.run !== true) {
            return (
              "Архив распакован: " + destDir + "\nНайдены установщики:\n" +
              found.slice(0, 10).map((f, i) => "  " + (i + 1) + ") " + f).join("\n") +
              "\n\nЗапустить первый: installExe({ url: ..., run: true }) — или запусти нужный файл сам через runCommand."
            );
          }
          const vZip = await verifyInstaller(first, args.sha256);
          if (!vZip.ok) return vZip.error;
          const factsZip = installerFacts(first, vZip);
          const stopZip = installerGate(vZip, args);
          if (stopZip) return factsZip + "\n\n" + stopZip + "\n\nФайл остался лежать: " + first;
          const outZ = await runTerminalCommand('"' + first + '"', os.homedir(), 300000);
          return "Архив распакован: " + destDir + "\n" + factsZip + "\n$ \"" + first + "\"\n\n" + outZ;
        }

        // .msi ставится только msiexec (прямой запуск даёт «не является приложением»).
        if (ext === ".msi") {
          if (process.platform !== "win32") return "Ошибка: .msi ставится только в Windows (msiexec). Возьми .zip или сборку для этой ОС.";
          const destMsi = path.join(tmpDir, withExt);
          const dl = await downloadFileTo(url, destMsi);
          if (!dl.ok) return dl.error;
          const vMsi = await verifyInstaller(destMsi, args.sha256);
          if (!vMsi.ok) return vMsi.error;
          const factsMsi = installerFacts(destMsi, vMsi);
          const stopMsi = installerGate(vMsi, args);
          if (stopMsi) return factsMsi + "\n\n" + stopMsi;
          const silentMsi = String(args.silentArgs || "").trim() || "/passive /norestart";
          const cmdMsi = "msiexec /i \"" + destMsi + "\" " + silentMsi;
          const outM = await runTerminalCommand(cmdMsi, os.homedir(), 300000, "cmd");
          const looksFailedM = /кодом (?!0$)[0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator|1603|1722/i.test(outM);
          return (
            "Установщик скачан: " + destMsi + " (" + Math.round(dl.size / 1024 / 1024) + " МБ)\n" +
            factsMsi + "\n" +
            "$ " + cmdMsi + "\n\n" + outM +
            (looksFailedM
              ? "\n\nmsiexec вернул ошибку (1603/1722 — установка не прошла). Часто нужны права администратора: runCommandAsAdmin(\"" + cmdMsi.replace(/"/g, "") + "\")."
              : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
          );
        }

        // .exe и всё остальное — как раньше: скачать и запустить с тихими ключами.
        const silent = String(args.silentArgs || "").trim() || "/S";
        const dest = path.join(tmpDir, withExt);
        const dlx = await downloadFileTo(url, dest);
        if (!dlx.ok) return dlx.error;
        const vExe = await verifyInstaller(dest, args.sha256);
        if (!vExe.ok) return vExe.error;
        const factsExe = installerFacts(dest, vExe);
        const stopExe = installerGate(vExe, args);
        if (stopExe) return factsExe + "\n\n" + stopExe;
        const cmd = '"' + dest + '" ' + silent;
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        const looksFailed = /кодом [0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator/i.test(out);
        return (
          "Установщик скачан: " + dest + " (" + Math.round(dlx.size / 1024 / 1024) + " МБ)\n" +
          factsExe + "\n" +
          "$ " + cmd + "\n\n" + out +
          (looksFailed
            ? "\n\nЕсли установка требует прав администратора — повтори через runCommandAsAdmin(\"" + cmd.replace(/"/g, "") + "\")."
            : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
        );
    },
    "noteSave": async (args, settings) => {
        const nKey = String(args.key || "").trim();
        const nContent = String(args.content ?? "");
        const nR = agentStore.noteSave(app.getPath("userData"), agentWorkDir(settings), nKey, nContent);
        return nR.ok ? "OK — " + nR.message : "Ошибка: " + nR.error;
    },
    "noteRead": async (args, settings) => {
        const nrKey = String(args.key || "").trim();
        const nrR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), nrKey);
        if (!nrR.ok) return "Ошибка: " + nrR.error;
        if (nrR.key) return "Заметка «" + nrR.key + "»:\n" + nrR.content;
        if (!nrR.notes.length) {
          return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content) — они переживают перезапуск и помогают продолжать работу в новых сессиях.";
        }
        const nrRows = nrR.notes.map((n) => "• " + n.key + " (" + new Date(n.ts).toLocaleString() + "):\n  " + n.content.replace(/\n/g, "\n  "));
        return "Заметки проекта (" + nrR.notes.length + "):\n" + nrRows.join("\n\n");
    },
    "noteList": async (args, settings) => {
        const nlR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), "");
        if (!nlR.ok) return "Ошибка: " + nlR.error;
        if (!nlR.notes.length) return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content).";
        return "Заметки проекта (" + nlR.notes.length + "):\n" + nlR.notes.map((n) => "• " + n.key).join("\n");
    },
    "noteDelete": async (args, settings) => {
        const ndKey = String(args.key || "").trim();
        const ndR = agentStore.noteDelete(app.getPath("userData"), agentWorkDir(settings), ndKey);
        return ndR.ok ? "OK — " + ndR.message : "Ошибка: " + ndR.error;
    },
    "taskAdd": async (args, settings) => {
        const taR = agentStore.tasksAdd(userDataDir(), {
          title: args.title, due: args.due, priority: args.priority, project: args.project, note: args.note,
          repeat: args.repeat, auto: args.auto, prompt: args.prompt,
        });
        if (!taR.ok) return "Ошибка: " + taR.error;
        emitTasksChanged();
        return "OK — " + taR.message + " Актуальный список — taskList.";
    },
    "taskList": async (args, settings) => {
        const tlR = agentStore.tasksList(userDataDir(), { status: args.status, due: args.due, project: args.project });
        const tlS = tlR.summary.summary;
        const tlHead = "Дела: активных " + tlS.active + " · просрочено " + tlS.overdue + " · сегодня " + tlS.today +
          " · завтра " + tlS.tomorrow + " · на неделе " + tlS.week + " · без срока " + tlS.noDue + " · выполнено " + tlS.done;
        if (!tlR.tasks.length) return tlHead + "\nСписок пуст — занеси первое дело через taskAdd.";
        return tlHead + "\n" + agentStore.tasksFormatText(tlR.tasks, Date.now());
    },
    "taskUpdate": async (args, settings) => {
        const tuR = agentStore.tasksUpdate(userDataDir(), args.key, {
          title: args.title, due: args.due, priority: args.priority, status: args.status, project: args.project, note: args.note,
          repeat: args.repeat, auto: args.auto, prompt: args.prompt, snooze: args.snooze,
        });
        if (!tuR.ok) return "Ошибка: " + tuR.error;
        emitTasksChanged();
        return "OK — " + tuR.message;
    },
    "taskDone": async (args, settings) => {
        const tdR = agentStore.tasksDone(userDataDir(), args.key, args.done !== false);
        if (!tdR.ok) return "Ошибка: " + tdR.error;
        emitTasksChanged();
        return "OK — " + (args.done === false ? "отметка снята: " : "выполнено: ") + agentStore.taskLine(tdR.task, Date.now());
    },
    "taskDelete": async (args, settings) => {
        const txR = agentStore.tasksDelete(userDataDir(), args.key);
        if (!txR.ok) return "Ошибка: " + txR.error;
        emitTasksChanged();
        return "OK — " + txR.message;
    },
    "missionStart": async (args, settings) => {
        // Долгая работа: цель, план и журнал ложатся файлами в рабочую папку
        // (.agent/missions/<id>/). Прогон после этого идёт батчами и переживает
        // перезапуск — состояние миссии читается с диска, а не из памяти окна.
        const msDir = agentWorkDir(settings);
        const msMinutes = Number(args.minutes) || 0;
        const msRole = live.activeRunRole || "";
        const msChat = live.activeRunChatId || "";
        const msR = missionStore.missionCreate(msDir, {
          goal: args.goal, title: args.title, steps: args.steps,
          role: msRole, chatId: msChat,
          limits: msMinutes ? { minutes: msMinutes } : null,
        });
        if (!msR.ok) return "Ошибка: " + msR.error;
        notifyMission();
        const msP = missionStore.missionProgress(msR.mission);
        const msPlanText = msR.mission.steps.length
          ? msR.mission.steps.map((s, i) => (i + 1) + ") " + s.title).join("; ")
          : "не задан";
        return "OK — миссия создана: " + msR.mission.id +
          "\nПапка: " + msR.dir +
          "\nЦель: " + msR.mission.goal +
          "\nПлан (" + msP.total + "): " + msPlanText +
          "\nЛимит: " + msR.mission.limits.rounds + " раундов, " + Math.round(msR.mission.limits.minutes / 60) + " ч" +
          "\nПЕРВЫМ ДЕЛОМ вызови todoWrite с планом миссии (3–7 пунктов): план видно человеку в панели, и он не теряется при перезапуске." +
          "\nДальше работай по шагам и после КАЖДОГО шага вызывай missionStep(done, next, note) — журнал читает человек." +
          " Когда закончишь — missionFinish(report).";
    },
    "missionStep": async (args, settings) => {
        const msDir2 = agentWorkDir(settings);
        const msCur = missionStore.missionActive(msDir2);
        if (!msCur) return "Ошибка: незакрытой миссии нет. Для длинной работы сначала missionStart(goal, steps).";
        const msR2 = missionStore.missionStep(msDir2, msCur.id, {
          done: args.done, fail: args.fail, next: args.next, note: args.note,
        });
        if (!msR2.ok) return "Ошибка: " + msR2.error;
        notifyMission();
        const msP2 = msR2.progress;
        return "OK — миссия " + msCur.id + ": " + msP2.done + "/" + msP2.total + " готово" +
          (msP2.failed ? ", сбоев " + msP2.failed : "") +
          (msP2.current ? ". Сейчас: " + msP2.current : "") +
          "\nЖурнал: .agent/missions/" + msCur.id + "/journal.md";
    },
    "missionStatus": async (args, settings) => {
        const msDir3 = agentWorkDir(settings);
        const msWanted = String(args.id || "").trim();
        const msRec = msWanted ? missionStore.missionLoad(msDir3, msWanted) : missionStore.missionActive(msDir3);
        if (!msRec) return msWanted ? "Ошибка: миссия " + msWanted + " не найдена." : "Незакрытых миссий нет.";
        const msP3 = missionStore.missionProgress(msRec);
        const msElapsed = Math.round((Date.now() - (msRec.startedAt || msRec.createdAt || Date.now())) / 60000);
        const msHead = "Миссия «" + msRec.title + "» (" + msRec.id + ", состояние: " + msRec.status + ")\n" +
          "Цель: " + msRec.goal + "\n" +
          "Прогресс: " + msP3.done + "/" + msP3.total + (msP3.failed ? " (сбоев " + msP3.failed + ")" : "") +
          (msP3.current ? ", сейчас: " + msP3.current : "") + "\n" +
          "В работе " + msElapsed + " мин, раундов " + msRec.rounds + ", батчей " + msRec.batches +
          ", токенов " + msRec.metrics.tokens + (msRec.next ? "\nДальше: " + msRec.next : "");
        const msPlan = msRec.steps.length
          ? "\nПлан:\n" + msRec.steps.map((s, i) => (s.state === "done" ? "  [x] " : s.state === "failed" ? "  [!] " : s.state === "doing" ? "  [→] " : "  [ ] ") + (i + 1) + ". " + s.title + (s.note ? " — " + s.note : "")).join("\n")
          : "";
        const msJ = missionStore.missionJournalText(msDir3, msRec.id, { limit: Number(args.journal) || 20 });
        return msHead + msPlan + "\nЖурнал (хвост):\n" + msJ + "\nФайлы: .agent/missions/" + msRec.id + "/";
    },
    "missionFinish": async (args, settings) => {
        const msDir4 = agentWorkDir(settings);
        const msRec4 = missionStore.missionActive(msDir4);
        if (!msRec4) {
          // Это не ошибка: чаще всего миссию закрыли в прошлом раунде. Ответ
          // должен сказать, что закрыто, когда и с каким итогом, — иначе агент
          // считает, что «закрывать нечего», и повторяет вызов.
          const msDone = missionStore.missionList(msDir4, { limit: 1 })[0];
          if (!msDone) {
            return "Незакрытой миссии нет и закрытых тоже: эта работа не начиналась. Для длинной работы сначала missionStart(goal, steps).";
          }
          const msDP = missionStore.missionProgress(msDone);
          return (
            "Миссия «" + msDone.title + "» (" + msDone.id + ") уже закрыта" +
            (msDone.finishedAt ? " " + new Date(msDone.finishedAt).toLocaleString() : "") +
            " — состояние: " + msDone.status + ", шагов: " + msDP.done + "/" + msDP.total + "." +
            "\nОтчёт: .agent/missions/" + msDone.id + "/report.md" +
            (msDone.reason ? "\nИтог: " + String(msDone.reason).slice(0, 300) : "") +
            "\nЕсли нужна новая работа — missionStart(goal, steps)."
          );
        }
        const msR4 = missionStore.missionFinish(msDir4, msRec4.id, {
          report: args.report, status: args.status, next: args.next,
        });
        if (!msR4.ok) return "Ошибка: " + msR4.error;
        notifyMission();
        const msP4 = missionStore.missionProgress(msR4.mission);
        return "OK — миссия " + msRec4.id + " закрыта (" + msR4.mission.status + "): " + msP4.done + "/" + msP4.total +
          " шагов. Итог записан в .agent/missions/" + msRec4.id + "/report.md";
    },
    "todoWrite": async (args, settings) => {
        // План работ: приложение только нормализует и показывает его панелью-
        // чеклистом — состояние (статусы, переживание перезапуска) хранит интерфейс.
        const planTasks = normalizePlanTasks(args.tasks != null ? args.tasks : args.items != null ? args.items : args);
        if (!planTasks.length) {
          return "Ошибка: план пуст. Пришли непустой tasks — массив до 7 пунктов (строка или { text, status }).";
        }
        const planTitle = String(args.title || "").trim().slice(0, 80);
        if (live.activeEmit) live.activeEmit({ type: "plan", tasks: planTasks, title: planTitle });
        const ps = planSummary(planTasks);
        live.activePlanSummary = { total: ps.total, done: ps.done, failed: ps.failed };
        const planRows = planTasks.map((t) =>
          (t.status === "done" ? "✅ " : t.status === "failed" ? "⚠️ " : t.status === "in_progress" ? "🔄 " : "⬜ ") +
          t.text + (t.note ? " — " + t.note : "")
        );
        return (
          "OK — план показан пользователю: " + ps.done + " из " + ps.total + " готово" +
          (ps.failed ? ", сбоев: " + ps.failed : "") + ".\n" +
          planRows.join("\n") + "\n" +
          (ps.done === ps.total
            ? "Все пункты готовы — подведи короткий итог без пересказа плана."
            : "Продолжай со следующего пункта; после каждого шага вызывай todoWrite заново с ПОЛНЫМ списком.")
        );
    },
    "memoryList": async (args, settings) => {
        // Настройки читаем в момент вызова: галочку могли включить только что.
        const ms = loadSettings();
        const memDir = agentStore.contextMemoryDir(app.getPath("userData"));
        if (!ms.contextMemory) {
          return (
            "Память диалогов выключена. Включи галочку «Память диалогов» в Настройках → 🧠 Память диалогов: тогда сжатые памятки будут сохраняться локально по датам, и я смогу вспоминать прошлые сессии.\n" +
            "Папка дневника: " + memDir
          );
        }
        const mmDate = String(args.date || "").trim();
        if (mmDate) {
          const mr = agentStore.contextMemoryRead(app.getPath("userData"), mmDate);
          if (!mr.ok) return "Ошибка: " + mr.error;
          const rows = mr.memos.map((m) =>
            "• " + m.time + " — " + (m.provider || "?") + (m.model ? "/" + m.model : "") +
            (m.workDir ? "\n  папка: " + m.workDir : "") + "\n" + String(m.memo || "").replace(/^/gm, "  ")
          );
          return "Памятки контекста за " + mmDate + " (" + mr.count + "):\n\n" + rows.join("\n\n");
        }
        const md = agentStore.contextMemoryDays(app.getPath("userData"));
        if (!md.length) {
          return "Память диалогов включена, но памяток пока нет: они появляются, когда контекст переполняется и старые шаги сворачиваются в памятку.";
        }
        const mrows = md.map((d) =>
          "• " + d.date + " — " + d.count + " памяток" + (d.last ? ", последняя в " + new Date(d.last).toLocaleTimeString() : "")
        );
        return (
          "Дни в памяти диалогов (" + md.length + "):\n" + mrows.join("\n") +
          '\n\nПамятки за конкретный день — memoryList(date: "ГГГГ-ММ-ДД"); поиск — memorySearch(query: "...").'
        );
    },
    "memorySearch": async (args, settings) => {
        const ms2 = loadSettings();
        if (!ms2.contextMemory) {
          return "Память диалогов выключена — включи галочку «Память диалогов» в настройках (Настройки → 🧠).";
        }
        const mq = String(args.query || "").trim();
        if (!mq) return "Ошибка: укажи query — что искать в памятках.";
        const msr = agentStore.contextMemorySearch(app.getPath("userData"), {
          query: mq,
          date: String(args.date || "").trim(),
          limit: Number(args.limit) || 20,
        });
        if (!msr.ok) return "Ошибка: " + msr.error;
        if (!msr.matches.length) {
          return "По запросу «" + mq + "» в памяти диалогов ничего не найдено. Список дней — memoryList.";
        }
        const srows = msr.matches.map((m) => "• " + m.date + " " + m.time + " (совпадений: " + m.hits + "): " + m.snippet);
        return "Найдено в памяти диалогов (" + msr.count + "):\n" + srows.join("\n");
    },
    "checkpointSave": async (args, settings) => {
        const csR = agentStore.checkpointSave(app.getPath("userData"), agentWorkDir(settings), args.label);
        return csR.ok ? "OK — " + csR.message : "Ошибка: " + csR.error;
    },
    "checkpointList": async (args, settings) => {
        const clR = agentStore.checkpointList(app.getPath("userData"));
        if (!clR.checkpoints.length) {
          return "Чекпоинтов пока нет. Создай первый через checkpointSave(label) перед серией правок — потом можно откатиться через checkpointRollback(id).";
        }
        const clRows = clR.checkpoints.map((c) => "• " + c.id + " — «" + c.label + "», " + c.files + " файлов, " + new Date(c.createdAt).toLocaleString());
        return "Чекпоинты (" + clR.checkpoints.length + "):\n" + clRows.join("\n");
    },
    "checkpointRollback": async (args, settings) => {
        const crId = String(args.id || "").trim();
        if (!crId) return "Ошибка: укажи id чекпоинта (смотри checkpointList).";
        const crR = agentStore.checkpointRollback(app.getPath("userData"), crId);
        if (!crR.ok) return "Ошибка: " + crR.error;
        return "OK — " + crR.message + (crR.errors && crR.errors.length ? "\nОшибки: " + crR.errors.join("; ") : "");
    },
    "otaStatus": async (args, settings) => {
        const os = ota.status(loadSettings());
        return (
          "OTA-статус:\n" +
          "• Включено: " + (os.enabled ? "да" : "нет — включи в настройках «🔄 Самосовершенствование (OTA)»\n") +
          "• Установленная версия кода: " + os.installed + "\n" +
          "• Папка OTA: " + os.dir + "\n" +
          "• Источники бандлов: " + (os.sources && os.sources.length ? "\n  " + os.sources.join("\n  ") : "—")
        );
    },
    "otaCheck": async (args, settings) => {
        const oc = await ota.check(loadSettings());
        if (oc.status === "disabled") return "OTA отключено в настройках (галочка «Разрешить локальные обновления на ходу»).";
        if (oc.status === "busy") return "Сейчас идёт работа агента — применять обновление нельзя. Бандл применится автоматически в течение минуты после завершения задачи.";
        if (oc.status === "applied") return "✅ Обновление применено до версии " + oc.version + " — приложение перезапускается с новым кодом.";
        if (oc.status === "error") return "Ошибка применения OTA: " + (oc.message || "неизвестная") + "\nПроверь синтаксис изменённых файлов (node --check) и пересобери бандл (node scripts/make-ota.js).";
        return "Обновлений нет — код актуален.";
    },
    "otaRollback": async (args, settings) => {
        if (global.__agentRunning) return "Нельзя откатываться во время работы агента — дождись завершения текущей задачи.";
        const or = ota.rollback();
        return or.ok ? "↩ Откат выполнен — приложение перезапускается с предыдущей версией кода." : "Ошибка отката: " + (or.message || "предыдущей версии нет");
    },
    "applyPatch": async (args, settings) => {
        const patch = String(args.patch ?? "");
        if (!patch.trim()) return "Ошибка: укажи patch — unified diff (формат git diff) с изменениями файлов.";
        const base = args.basePath ? resolvePath(args.basePath, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: базовой директории нет: " + base;
        // Снимаем undo-снимки для всех файлов, которые затронет патч.
        for (const f of unifiedPatch.parsePatch(patch)) {
          const rel = unifiedPatch.safeRel(base, f.b || f.a);
          if (!rel) continue;
          const abs = path.join(base, rel);
          if (selfDev.protectedSelfPath(abs, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
            return "⛔ Патч затрагивает защищённый файл самообновления: " + abs + "\nПравка src/bootstrap.js, src/ota.js или папки применённого OTA-бандла заблокирована — убери этот файл из патча.";
          }
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) snapshotFileForUndo(abs);
        }
        const r = unifiedPatch.applyUnifiedPatch(base, patch);
        if (!r.ok) {
          return "Ошибка применения патча:\n" + r.errors.map((e) => "• " + e.path + " — " + e.error).join("\n") +
            "\n\nПеречитай файлы (readFile) и сгенерируй патч заново с точным контекстом, либо правь файлы по одному через editFile.";
        }
        return "OK — патч применён, изменено файлов: " + r.changed.length + (r.changed.length ? "\n" + r.changed.map((f) => "• " + f).join("\n") : "");
    },
    "waitUntil": async (args, settings) => {
        const secs = Math.max(1, Math.min(parseInt(args.seconds, 10) || 5, 300));
        if (args.reason) termAgentEcho("⏳ " + args.reason + " (жду " + secs + " с)");
        await new Promise((res) => setTimeout(res, secs * 1000));
        return "OK — подождал " + secs + " с" + (args.reason ? " (" + args.reason + ")" : "") + ". Теперь перепроверь состояние (например checkPort/checkUrl/backgroundOutput).";
    },
    "gitStash": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const action = String(args.action || "push").toLowerCase();
        const isList = action === "list";
        const isPop = action === "pop";
        const isPush = action === "push";
        if (!isList && !isPop && !isPush) return "Ошибка: action может быть push (сохранить изменения), pop (вернуть) или list (показать).";
        if (isList) {
          const r = await runGit(cwd, ["stash", "list"], settings);
          return r.ok ? (r.out || "Стеков stash нет.") : "Ошибка git: " + r.err;
        }
        if (isPop) {
          const r = await runGit(cwd, ["stash", "pop"], settings);
          if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — проверь gitStatus и разбери изменения вручную).";
          return "OK — изменения возвращены из stash:\n" + r.out;
        }
        const msg = String(args.message || "").trim() || "Авто-stash агента";
        const r = await runGit(cwd, ["stash", "push", "-m", msg], settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "OK — изменения спрятаны в stash («" + msg + "»). Вернуть: gitStash(action: pop). Рабочее дерево теперь чистое.";
    },
    "gitCherryPick": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const commit = String(args.commit || "").trim();
        if (!commit) return "Ошибка: укажи commit — хэш или ссылку (например HEAD~1 или abc123).";
        const r = await runGit(cwd, ["cherry-pick", commit], settings);
        if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — разбери его, затем gitCherryPick не нужен, просто gitCommit после разрешения).";
        return "OK — коммит " + commit + " перенесён на текущую ветку:\n" + r.out;
    },
    "gitBlame": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const rel = path.relative(cwd, p) || path.basename(p);
        const lines = parseInt(args.lines, 10);
        const gitArgs = ["blame"];
        if (Number.isInteger(lines) && lines >= 1) gitArgs.push("-L", "1," + Math.min(lines, 500));
        gitArgs.push("--", rel);
        const r = await runGit(cwd, gitArgs, settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "История строк файла " + rel + " (git blame):\n" + truncateText(r.out, 9000);
    },
    "semanticSearch": async (args, settings) => {
        const query = String(args.query || "").trim();
        if (!query) return "Ошибка: укажи query — что ищем по смыслу (например «валидация входа», «db подключение»).";
        const base = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: директория не найдена: " + base;
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 8, 20);
        const index = codeIndex.getIndex(app.getPath("userData"), base);
        if (!index.docsCount) return "Нечего искать в " + base + " — текстовых файлов не найдено.";
        const hits = codeIndex.searchIndex(index, query, maxResults);
        if (!hits.length) {
          return "По запросу «" + query + "» ничего не найдено в " + index.docsCount + " файлах (индекс: " + base + ").\nПопробуй другие слова (поиск работает по смыслу: auth → authenticate) или searchFile для точного регулярного поиска.";
        }
        const rows = hits.map((h, i) => {
          const sn = codeIndex.snippetForFile(base, h.rel, query, 3);
          return "#" + (i + 1) + " " + h.rel + " (релевантность " + h.score.toFixed(2) + ")\n" + sn.text;
        });
        return (
          "Семантический поиск «" + query + "» — индексировано файлов: " + index.docsCount + ", топ-" + hits.length + ":\n\n" +
          rows.join("\n\n") +
          "\n\nДальше: readFileLines(path, start, count) — читать найденное, searchFile — точный регулярный поиск."
        );
    },
    "ycStatus": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) {
          return "Yandex Cloud не подключён. Скажи пользователю: Настройки → «☁️ Yandex Cloud» → получить OAuth-токен и вставить его. После авторизации инструмент заработает.";
        }
        if (!cfg.folderId) return "Авторизация есть, но не выбран каталог. Открой Настройки → Yandex Cloud и выбери каталог (или дождись, пока приложение выберет первый автоматически).";
        try {
          const svcs = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          const rows = svcs.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 120)));
          return (
            "Yandex Cloud · каталог «" + cfg.folderName + "» (" + cfg.folderId + ")\n" +
            "Создание агентом: " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n" +
            "Удаление агентом: " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n" +
            "Правка контейнеров (ycContainer: ревизии, откат, настройки): " + (cfg.allowUpdate ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n\nРесурсы:\n" +
            rows.join("\n") +
            cloudDeployBrief(agentWorkDir(loadSettings())) +
            "\n\nСоздание: ycCreate(service, name). Доступны: " + yandexCloud.creatableKeys().join(", ") + ". Удаление: ycDelete(service, id) — id виден в ycList." +
    "\nСтоимость: ycCosts(service) — проверь ДО создания и назови ориентир пользователю. Платное создаётся только с confirm: true после его согласия."
          );
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
    },
    "ycList": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        const serviceKey = String(args.service || args.key || "").trim();
        const svcDef = serviceKey ? yandexCloud.serviceByKey(serviceKey) : null;
        if (serviceKey && !svcDef) return "Неизвестный сервис: " + serviceKey + ". Доступны: " + yandexCloud.SERVICES.map((s) => s.key).join(", ") + ".";
        try {
          if (svcDef) {
            const r = await yandexCloud.listService(cfg.oauth, cfg.folderId, svcDef);
            // Каталог отдаёт объекты { id, name }, а Postbox (SES) — просто строки.
            const items = r.items.slice(0, 30).map((it) => {
              if (it == null) return "• —";
              if (typeof it !== "object") return "• " + String(it);
              return "• " + (it.name || it.id || "—") + (it.id ? "  (" + it.id + ")" : "");
            });
            return "«" + svcDef.title + "» в каталоге «" + cfg.folderName + "»: всего " + r.count + (r.count ? ":\n" + items.join("\n") : " — пусто.");
          }
          const all = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          return all.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 100))).join("\n");
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
    },
    "ycCreate": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        if (!cfg.allowCreate) {
          return "⛔ Создание ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». (Удаление — отдельным чекбоксом.)";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const name = String(args.name || "").trim();
        if (!serviceKey || !name) return "Ошибка: укажи service (например ydb, serverlessContainers, storage, lockbox, containerRegistry, dns, vpc) и name. Создание платных ресурсов — только по явной просьбе пользователя.";
        // Платный ресурс агентом — только после согласия пользователя: сначала
        // называем цену, потом создаём. Иначе счёт появляется вслепую.
        const est = ycCosts.estimate(serviceKey, {});
        if (est && est.needsConfirm && args.confirm !== true) {
          return (
            "⛔ Не создаю без согласия: «" + est.title + "» платный.\n" +
            ycCosts.formatLines(est).join("\n") +
            "\n\nНазови пользователю ориентир цены и получи согласие (askUser), затем повтори вызов с confirm: true."
          );
        }
        try {
          const r = await yandexCloud.createResource(cfg.oauth, cfg.folderId, serviceKey, name);
          const priceNote = est ? " Ориентир стоимости: " + ycCosts.formatLines(est)[0] : "";
          return "OK — " + r.message + " (service=" + serviceKey + ", каталог «" + cfg.folderName + "»)." + priceNote + " Проверить список: ycList(service: \"" + serviceKey + "\").";
        } catch (e) {
          return "Ошибка создания: " + ((e && e.message) || String(e));
        }
    },
    "ycCosts": async (args, settings) => {
        const key = String(args.service || args.key || "").trim();
        if (!key) {
          const rows = ycCosts.keys().map((k) => "• " + k + ": " + ycCosts.hint(k));
          return (
            "Ориентир по стоимости ресурсов Yandex Cloud (тарифы на " + ycCosts.PRICED_AT + ", ₽ с НДС):\n" +
            rows.join("\n") +
            "\n\nДорого, если понадобится (мы это не создаём): " + ycCosts.EXPENSIVE.map((e) => e.title + " — " + e.why).join("; ") +
            "\nДетали по ресурсу: ycCosts(service: \"storage\", gb: 10). Ревизия контейнера: ycCosts(service: \"serverlessContainers\", memoryMb: 512, cores: 1)." +
            "\nЭто ориентир, а не счёт: регион и договор у всех разные, точная цифра — в калькуляторе " + ycCosts.CALCULATOR + "."
          );
        }
        const est = ycCosts.estimate(key, Object.assign({}, args.params || {}, args));
        if (!est) return "Неизвестный ресурс: " + key + ". Доступны: " + ycCosts.keys().join(", ") + ".";
        return "Стоимость (ориентир, тарифы на " + ycCosts.PRICED_AT + "):\n" + ycCosts.formatLines(est).join("\n");
    },
    "ycDelete": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.allowDelete) {
          return "⛔ Удаление ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы».";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const id = String(args.id || args.resourceId || "").trim();
        if (!serviceKey || !id) return "Ошибка: укажи service и id (id ресурса виден в ycList). Удаление необратимо — только по явной просьбе пользователя.";
        try {
          const r = await yandexCloud.deleteResource(cfg.oauth, serviceKey, id);
          return "OK — " + r.message + " (" + serviceKey + ").";
        } catch (e) {
          return "Ошибка удаления: " + ((e && e.message) || String(e));
        }
    },
    "ycDeploy": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → «☁️ Yandex Cloud».";
        if (!cfg.allowCreate) {
          return "⛔ Деплой создаёт ресурсы в Yandex Cloud (реестр, контейнер, SA). Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Деплой платный (Serverless Containers).";
        }
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка проекта не найдена: " + dir;
        const appName = String(args.name || "").trim() || path.basename(dir);
        // Порядок стадий, проверка после выката и откат — в src/deploy-engine.js.
        // Агент это не придумывает: конвейер детерминированный, как у кнопки.
        const r = await runCloudDeploy(dir, appName, {
          env: args.env || {},
          memoryMb: args.memoryMb,
          cores: args.cores,
          timeoutSec: args.timeoutSec,
          public: args.public,
          runTests: args.runTests,
          // Значения секретов через агента не проходят: он передаёт готовый
          // секрет ссылкой (secretId + secretKeys — только имена ключей), а
          // значения человек вводит в панели деплоя, и они сразу уходят в Lockbox.
          secretId: args.secretId,
          secretKeys: args.secretKeys,
          triggeredBy: "agent",
        });
        const head = r.ok
          ? "✅ Задеплоено (#" + r.number + "). URL: " + (r.url || "—")
          : r.rolledBack
            ? "⚠️ Деплой #" + r.number + " не прошёл, я откатил на прошлую рабочую версию (#" + r.rolledBackTo + "). URL: " + (r.url || "—")
            : "❌ Деплой #" + r.number + " не завершился.";
        const body = [head];
        if (r.error) body.push("", "Причина: " + r.error);
        if (r.warnings && r.warnings.length) body.push("", "Замечания:", "• " + r.warnings.join("\n• "));
        if (r.steps && r.steps.length) body.push("", "Стадии:", "• " + r.steps.join("\n• "));
        if (r.ok) {
          body.push("", "Проверка после деплоя: HTTP " + (r.health && r.health.status) + (r.health && r.health.path ? " по " + r.health.path : "") + ".");
          if (r.browserCheck && r.browserCheck.metrics) {
            body.push("Страница в браузере: HTTP " + r.browserCheck.metrics.status + ", текста " + r.browserCheck.metrics.textLen + " символов" + (r.browserCheck.metrics.title ? ", заголовок «" + r.browserCheck.metrics.title + "»" : "") + ".");
          }
          body.push("Образ: " + r.image + (r.revisionId ? ", ревизия " + r.revisionId : ""));
          if (r.secretKeys && r.secretKeys.length) {
            // Наружу — только имена ключей: значения секретов не отдаём.
            body.push("Секреты (Lockbox " + r.secretId + "): " + r.secretKeys.join(", "));
          }
          body.push('Логи: ycLogs(service: "serverlessContainers", id: "' + (r.containerId || "") + '").');
        }
        body.push("", "История и текущее состояние — в панели «☁️ Cloud» → Деплой.");
        return body.join("\n");
    },
    "ycContainer": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».";
        const action = String(args.action || "overview").trim().toLowerCase();
        const ref = String(args.container || args.id || "").trim();
        if (!ref) return "Ошибка: укажи container — имя или id контейнера. Список: ycList(service: \"serverlessContainers\").";
        // Чтение разрешено всегда; смена настроек и ревизии — только с чекбоксом.
        if ((action === "deploy" || action === "rollback" || action === "update") && !cfg.allowUpdate) {
          return "⛔ Менять контейнеры и деплоить ревизии агенту ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту менять контейнеры». Чтение доступно и сейчас: action overview / revisions / revision.";
        }
        try {
          const cont = await ycFindContainerByRef(cfg, ref);
          const who = "Контейнер «" + (cont.name || cont.id) + "» (" + cont.id + ")";
          const line = "URL: " + (cont.url || "— (публичный доступ не настроен)");
          const logsHint = "Логи: ycLogs(service: \"serverlessContainers\", id: \"" + cont.id + "\").";

          if (action === "overview") {
            const { revs, active } = await ycActiveRevision(cfg, cont.id);
            const head = [
              who,
              "Статус: " + (cont.status || "—") + (cont.description ? " · " + cont.description : ""),
              "Создан: " + (cont.createdAt || "—"),
              line,
              logsHint,
            ];
            if (!revs.length) {
              return head.join("\n") + "\n\nРевизий нет: контейнер создан, но ни разу не деплоился. Создать ревизию: ycContainer { action: \"deploy\", container: \"" + (cont.name || cont.id) + "\", image: \"cr.yandex/<registry-id>/<image>:tag\" }.";
            }
            head.push("Ревизий: " + revs.length + " · активная — " + (active ? active.id : "—"));
            return head.join("\n") + "\n\nНастройки активной ревизии (вкладка «Редактор»):\n" + ycRevisionDetails(yandexCloud.revisionSummary(active)) +
              "\n\nСписок ревизий: ycContainer { action: \"revisions\", container: \"" + (cont.name || cont.id) + "\" }.";
          }

          if (action === "revisions") {
            const revs = await yandexCloud.listRevisions(cfg.oauth, {
              containerId: cont.id,
              pageSize: 100,
              filter: args.filter ? String(args.filter) : "",
            });
            if (!revs.length) return who + "\n\nРевизий нет (фильтр: " + (args.filter || "нет") + ").";
            const activeId = (revs.find((r) => r.status === "ACTIVE") || revs[0]).id;
            const limit = Math.min(Math.max(parseInt(args.limit, 10) || 15, 1), 100);
            const rows = revs.slice(0, limit).map((r) => ycRevisionLine(yandexCloud.revisionSummary(r), r.id === activeId));
            return who + "\n" + line + "\n\nРевизии (свежие сверху), всего " + revs.length + ":\n" + rows.join("\n") +
              "\n\nДетали: ycContainer { action: \"revision\", container: \"…\", revisionId: \"…\" }. Откат: action \"rollback\" (нужно разрешение).";
          }

          if (action === "revision") {
            const rid = String(args.revisionId || args.revision || "").trim();
            if (!rid) return "Ошибка: укажи revisionId — id виден в action: revisions.";
            const rev = await yandexCloud.getRevision(cfg.oauth, rid);
            return who + "\n\n" + ycRevisionDetails(yandexCloud.revisionSummary(rev));
          }

          if (action === "deploy") {
            const { active } = await ycActiveRevision(cfg, cont.id);
            const opts = yandexCloud.revisionToDeployOpts(active, {
              imageUrl: args.image || args.imageUrl,
              memoryMb: args.memoryMb,
              cores: args.cores,
              coreFraction: args.coreFraction,
              timeoutSec: args.timeoutSec,
              concurrency: args.concurrency,
              serviceAccountId: args.serviceAccountId,
              networkId: args.networkId,
              minInstances: args.minInstances,
              maxInstancesPerZone: args.maxInstancesPerZone,
              env: ycJsonArg(args.env),
              envReplace: args.envReplace === true,
              command: ycJsonArg(args.command),
              args: ycJsonArg(args.args),
              secrets: ycJsonArg(args.secrets),
              mounts: ycJsonArg(args.mounts),
              storageMounts: ycJsonArg(args.storageMounts),
              runtime: args.runtime,
              logGroupId: args.logGroupId,
              logMinLevel: args.logMinLevel,
              description: args.description,
              folderId: cfg.folderId,
            });
            if (!opts.imageUrl) {
              return "Ошибка: у новой ревизии нет образа. Контейнер «" + (cont.name || cont.id) + "» ещё не деплоился — укажи image, например cr.yandex/<registry-id>/<image>:latest (реестр: ycList(service: \"containerRegistry\")).";
            }
            await yandexCloud.deployContainerRevision(cfg.oauth, Object.assign({ containerId: cont.id }, opts));
            const after = await ycActiveRevision(cfg, cont.id);
            const src = active ? "настройки взяты из активной ревизии " + active.id + " (указанные поля переопределены)" : "первая ревизия контейнера";
            return "✅ Ревизия контейнера «" + (cont.name || cont.id) + "» развёрнута: " + src + ".\n" + line + "\n\n" + ycRevisionDetails(yandexCloud.revisionSummary(after.active || {})) +
              "\n\n" + logsHint + " Проверь вызов по URL. Откат: ycContainer { action: \"rollback\", container: \"" + (cont.name || cont.id) + "\", revisionId: \"" + (active ? active.id : "") + "\" }.";
          }

          if (action === "rollback") {
            const rid = String(args.revisionId || args.revision || "").trim();
            if (!rid) return "Ошибка: укажи revisionId, на которую откатить (список: action: revisions).";
            await yandexCloud.rollbackContainer(cfg.oauth, cont.id, rid);
            const after = await ycActiveRevision(cfg, cont.id);
            return "✅ Контейнер «" + (cont.name || cont.id) + "» откачен на ревизию " + rid + ".\nАктивная ревизия теперь: " + ((after.active && after.active.id) || "—") + "\n" + line + "\n\n" + logsHint;
          }

          if (action === "update") {
            const patchObj = {};
            if (args.name != null) patchObj.name = args.name;
            if (args.description != null) patchObj.description = args.description;
            const labels = ycJsonArg(args.labels);
            if (labels) patchObj.labels = labels;
            const updated = await yandexCloud.updateContainer(cfg.oauth, cont.id, patchObj);
            const labelKeys = Object.keys(updated.labels || {});
            return "✅ Контейнер обновлён: «" + (updated.name || cont.name) + "»" + (updated.description ? " — " + updated.description : "") +
              (labelKeys.length ? "\nМетки: " + labelKeys.map((k) => k + "=" + updated.labels[k]).join(", ") : "") +
              "\n\nВажно: образ, переменные окружения и ресурсы правятся ТОЛЬКО новой ревизией — action \"deploy\" (текущие настройки подставятся сами). " + line;
          }

          return "Ошибка: неизвестное действие ycContainer «" + action + "». Доступно: overview, revisions, revision, deploy, rollback, update.";
        } catch (e) {
          return "Yandex Cloud (ycContainer, action=" + action + "): " + ((e && e.message) || String(e));
        }
    },
    "ycLogs": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const id = String(args.id || args.resourceId || "").trim();
        if (!id) return "Ошибка: укажи id ресурса (виден в ycList).";
        try {
          return await readYcLogsText(cfg, String(args.service || "").trim(), id, args);
        } catch (e) {
          return "Логи (" + (args.service || "ресурс") + "): " + ((e && e.message) || String(e));
        }
    },
    "ycInstall": async (args, settings) => {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        const st = ycCliStatus();
        if (st.installed && !args.force) {
          // Пересобираем окружение: PATH и свежий YC_IAM_TOKEN — без перезапуска.
          applyAgentEnv(loadSettings());
          return "yc CLI уже встроен: " + st.path + " — доступен всем командам как «yc». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Переустановить: ycInstall(force: true).";
        }
        try {
          const r = await ycCliInstall();
          if (!r.ok) return "Не удалось установить yc CLI: " + r.error;
          applyAgentEnv(loadSettings());
          const iamReady = !!ycIamEnvToken(ycConfig(loadSettings()));
          return "yc CLI установлен: " + r.path + " (версия " + r.version + ", " + r.os + "/" + r.arch + ", " + r.sizeMb + " МБ).\n" +
            "Папка добавлена в PATH всех команд агента — вызывай просто «yc ...». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Проверка: yc config list" +
            (iamReady ? "" : "\n⚠ Свежий IAM-токен ещё не получен (нет сети или токен не принят) — если первая команда yc скажет «The token is invalid», повтори её через минуту.");
        } catch (e) {
          return "Не удалось установить yc CLI: " + ((e && e.message) || String(e));
        }
    },
  };
}

module.exports = { createAgentTools };

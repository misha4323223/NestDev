"use strict";

/* ─── Агентские инструменты: реестр из 159 обработчиков ───────────────────
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

   Облачные инструменты (девять yc*) вынесены своим модулем —
   src/agent-tools-cloud.js, часть 40, заход 1; они подмешиваются в реестр
   `...createCloudTools(deps)` и получают тот же объект состояния.

   Зависимости приходят снаружи (та же конвенция, что у createYcService и
   createDeployEngine): модуль чистый и проверяется в plain-node. */

const { createCloudTools } = require("./agent-tools-cloud.js"); // облачные инструменты агента (Yandex Cloud)
const { createGitTools } = require("./agent-tools-git.js"); // инструменты git и GitHub
const { createFileTools } = require("./agent-tools-files.js"); // файлы: чтение, поиск и правки
const { createWriteTools } = require("./agent-tools-write.js"); // файлы: запись и правки
const { createRunTools } = require("./agent-tools-run.js"); // команды, оболочка и фоновые процессы
const { createSystemTools } = require("./agent-tools-system.js"); // система и установка ПО
const { createNetTools } = require("./agent-tools-net.js"); // сеть и проверки доступности
const { createMemoryTools } = require("./agent-tools-memory.js"); // пояс проекта: заметки, дела, память диалогов, чекпоинты
const { createMissionTools } = require("./agent-tools-mission.js"); // миссии и план (живой мост: роль, чат, лента, сводка плана)


function createAgentTools(deps) {
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
    // Миссия текущего прогона: инструменты без id работают именно с ней.
    get activeRunMissionId() {
      return deps.live.activeRunMissionId ? deps.live.activeRunMissionId() : "";
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

  // git и GitHub: своим модулем (часть 40, заход 2). Порядок инструментов в реестре
  // сохранён ссылками — сборка идёт один раз, тем же объектом состояния.
  const git = createGitTools(deps, live);
  // Файлы — своим модулем (часть 40, заход 3a). Порядок инструментов сохранён
  // ссылками; мост живых значений этому набору не нужен.
  const files = createFileTools(deps);
  // Файлы: запись и правки — своим модулем (часть 40, заход 3b). Живой мост нужен
  // только undoEdit: журнал отката живёт в main.js, копии у модуля нет.
  const write = createWriteTools(deps, live);
  // Команды, оболочка и фоновые процессы — своим модулем (часть 40, заход 4).
  // Живого моста модулю не нужно: обработчики живут на deps.
  const run = createRunTools(deps);
  // Система и установка ПО — своим модулем (часть 40, заход 5). Живого моста не
  // нужно: все помощники (system-stack) уже приходят в deps.
  const system = createSystemTools(deps);
  // Сеть и проверки доступности — своим модулем (часть 40, заход 6a). Живого моста
  // не нужно: всё приходит в deps.
  // Имя netTools, а не net: net уже занято распакованным модулем node.
  const netTools = createNetTools(deps);
  // Пояс проекта: заметки, дела, память диалогов, чекпоинты и семантический
  // поиск — своим модулем (часть 40, заход 6b). Живого моста не нужно: всё
  // приходит в deps (папка заметок — app.getPath, журнал дел — userDataDir).
  const memory = createMemoryTools(deps);
  // Миссии и план — своим модулем (часть 40, заход 6c). Живой мост нужен: роль и
  // чат текущего прогона, лента событий и сводка плана живут в main.js, а у
  // missionOfRun без моста не было бы «своей» миссии прогона.
  const mission = createMissionTools(deps, live);
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
    "createFolder": write.createFolder,
    "readFile": files.readFile,
    "readFileLines": files.readFileLines,
    "editFile": write.editFile,
    "shellsStatus": run.shellsStatus,
    "runCommand": run.runCommand,
    "startBackground": run.startBackground,
    "listBackground": run.listBackground,
    "backgroundOutput": run.backgroundOutput,
    "sendInput": run.sendInput,
    "stopBackground": run.stopBackground,
    "shellStart": run.shellStart,
    "shellSend": run.shellSend,
    "checkUrl": netTools.checkUrl,
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
    "checkPort": netTools.checkPort,
    "listPorts": netTools.listPorts,
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
    "writeFile": write.writeFile,
    "webSearch": netTools.webSearch,
    "webFetch": netTools.webFetch,
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
    "searchFile": files.searchFile,
    "fileOutline": files.fileOutline,
    "listFiles": files.listFiles,
    "searchProject": files.searchProject,
    "askUser": async (args, settings) => {
        return "Ошибка: askUser обрабатывается отдельно — дождись ответа пользователя.";
    },
    "listDirectory": files.listDirectory,
    "gitClone": git.gitClone,
    "gitStatus": git.gitStatus,
    "gitCommit": git.gitCommit,
    "gitPush": git.gitPush,
    "gitPublish": git.gitPublish,
    "gitInit": git.gitInit,
    "gitPull": git.gitPull,
    "gitLog": git.gitLog,
    "gitRevert": git.gitRevert,
    "readFileStructure": files.readFileStructure,
    "explainCode": files.explainCode,
    "undoEdit": write.undoEdit,
    "refactorRename": write.refactorRename,
    "runCommandOutput": run.runCommandOutput,
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
    "getSystemInfo": system.getSystemInfo,
    "installSystemPackage": system.installSystemPackage,
    "runCommandAsAdmin": run.runCommandAsAdmin,
    "refreshEnv": system.refreshEnv,
    "explainError": async (args, settings) => {
        const codeRaw = args.exitCode;
        const code = codeRaw == null || codeRaw === "" ? NaN : parseInt(codeRaw, 10);
        return explainExit(Number.isNaN(code) ? NaN : code, args.command);
    },
    "timeoutCommand": run.timeoutCommand,
    "retryCommand": run.retryCommand,
    "downloadAndExtract": netTools.downloadAndExtract,
    "apiRequest": netTools.apiRequest,
    "runScript": run.runScript,
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
    "gitBranch": git.gitBranch,
    "gitCheckout": git.gitCheckout,
    "findReferences": files.findReferences,
    "gitDiff": git.gitDiff,
    "gitUndoLastCommit": git.gitUndoLastCommit,
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
    "listProcesses": system.listProcesses,
    "killProcess": system.killProcess,
    // Буфер обмена: в Electron 44 модуль переделали под W3C — readText и
    // writeText теперь возвращают Promise. Без await инструмент отдал бы модели
    // "[object Promise]" вместо текста, а отказ записи улетел бы в необработанный
    // reject вместо честной ошибки: обе ветки обязаны ЖДАТЬ результат.
    "clipboardWrite": async (args, settings) => {
        const text = String(args.text == null ? "" : args.text);
        try {
          await clipboard.writeText(text);
        } catch (e) {
          return "Ошибка: не удалось записать в буфер обмена: " + (e.message || String(e));
        }
        return "OK — текст скопирован в буфер обмена (" + text.length + " симв.).";
    },
    "clipboardRead": async (args, settings) => {
        let text = "";
        try {
          text = String((await clipboard.readText()) || "");
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
    "registryRead": system.registryRead,
    "registryWrite": system.registryWrite,
    "openPath": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: путь не найден: " + p;
        const err = await shell.openPath(p);
        return err ? "Не удалось открыть: " + err : "OK — открыто системным приложением: " + p;
    },
    "wingetSearch": system.wingetSearch,
    "installExe": system.installExe,
    "noteSave": memory.noteSave,
    "noteRead": memory.noteRead,
    "noteList": memory.noteList,
    "noteDelete": memory.noteDelete,
    "taskAdd": memory.taskAdd,
    "taskList": memory.taskList,
    "taskUpdate": memory.taskUpdate,
    "taskDone": memory.taskDone,
    "taskDelete": memory.taskDelete,
    "missionStart": mission.missionStart,
    "missionStep": mission.missionStep,
    "missionStatus": mission.missionStatus,
    "missionFinish": mission.missionFinish,
    "todoWrite": mission.todoWrite,
    "memoryList": memory.memoryList,
    "memorySearch": memory.memorySearch,
    "checkpointSave": memory.checkpointSave,
    "checkpointList": memory.checkpointList,
    "checkpointRollback": memory.checkpointRollback,
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
    "applyPatch": write.applyPatch,
    "waitUntil": run.waitUntil,
    "gitStash": git.gitStash,
    "gitCherryPick": git.gitCherryPick,
    "gitBlame": git.gitBlame,
    "semanticSearch": memory.semanticSearch,
    ...createCloudTools(deps),
  };
}

module.exports = { createAgentTools };

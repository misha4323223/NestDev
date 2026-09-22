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
const { createAppTools } = require("./agent-tools-app.js"); // окно приложения, буфер обмена, скриншот экрана (живой мост: окно и лента)
const { createDevTools } = require("./agent-tools-devtools.js"); // вложения и разработка: докер, пакеты, проверки проекта
const { createMediaTools } = require("./agent-tools-media.js"); // медиа, просмотр и справка (живой мост: роутер инструментов и лента)


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
  // Окно и рабочий стол — своим модулем (часть 40, заход 8). Живой мост нужен:
  // окно приложения меняется, а скриншот уходит событием в ленту.
  // Имя appTools, а не app: app уже занято распакованным deps.app (окно Electron).
  const appTools = createAppTools(deps, live);
  // Вложения и разработка — своим модулем (часть 40, заход 9). Живого моста не
  // нужно: рабочая папка берётся на момент вызова, окружение — через envFor.
  const devtools = createDevTools(deps);
  // Медиа, просмотр и справка — своим модулем (часть 40, заход 10). Живой мост
  // нужен: роутер инструментов и лента событий живут в main.js.
  const media = createMediaTools(deps, live);
  return {
    "findTools": media.findTools,
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
    "openUrl": media.openUrl,

    "showImage": media.showImage,

    "analyzeImage": media.analyzeImage,

    "generateImage": media.generateImage,
    "checkPort": netTools.checkPort,
    "listPorts": netTools.listPorts,
    "dockerBuild": devtools.dockerBuild,

    "dockerRun": devtools.dockerRun,

    "dockerExec": devtools.dockerExec,

    "installPackage": devtools.installPackage,

    "lintProject": devtools.lintProject,

    "runTests": devtools.runTests,
    "diffView": media.diffView,

    "previewUI": media.previewUI,

    "screenshotCapture": media.screenshotCapture,
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
    "waitForIdle": media.waitForIdle,

    "agentGuide": media.agentGuide,
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
    "appRead": appTools.appRead,
    "appClick": appTools.appClick,
    "appFill": appTools.appFill,
    "appSelect": appTools.appSelect,
    "appPress": appTools.appPress,
    "appWait": appTools.appWait,
    "appScreenshot": appTools.appScreenshot,
    "searchFile": files.searchFile,
    "fileOutline": files.fileOutline,
    "listFiles": files.listFiles,
    "searchProject": files.searchProject,
    "askUser": appTools.askUser,
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
    "checkInstalledProgram": devtools.checkInstalledProgram,

    "canExecute": devtools.canExecute,
    "getSystemInfo": system.getSystemInfo,
    "installSystemPackage": system.installSystemPackage,
    "runCommandAsAdmin": run.runCommandAsAdmin,
    "refreshEnv": system.refreshEnv,
    "explainError": devtools.explainError,
    "timeoutCommand": run.timeoutCommand,
    "retryCommand": run.retryCommand,
    "downloadAndExtract": netTools.downloadAndExtract,
    "apiRequest": netTools.apiRequest,
    "runScript": run.runScript,
    "validateProject": devtools.validateProject,
    "gitBranch": git.gitBranch,
    "gitCheckout": git.gitCheckout,
    "findReferences": files.findReferences,
    "gitDiff": git.gitDiff,
    "gitUndoLastCommit": git.gitUndoLastCommit,
    "getDependencies": devtools.getDependencies,

    "formatCode": devtools.formatCode,

    "dbQuery": devtools.dbQuery,
    "listProcesses": system.listProcesses,
    "killProcess": system.killProcess,
    // Буфер обмена: в Electron 44 модуль переделали под W3C — readText и
    // writeText теперь возвращают Promise. Без await инструмент отдал бы модели
    // "[object Promise]" вместо текста, а отказ записи улетел бы в необработанный
    // reject вместо честной ошибки: обе ветки обязаны ЖДАТЬ результат.
    "clipboardWrite": appTools.clipboardWrite,
    "clipboardRead": appTools.clipboardRead,
    "screenshotDesktop": appTools.screenshotDesktop,
    "registryRead": system.registryRead,
    "registryWrite": system.registryWrite,
    "openPath": appTools.openPath,
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

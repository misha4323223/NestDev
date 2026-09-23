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
const { createVaultTools } = require("./agent-tools-vault.js"); // пароли сайтов и почта (хранилище, отправка и чтение писем)
const { createEnvTools } = require("./agent-tools-env.js"); // окружение агента и OTA (живой мост: выданные переменные)
const { createBrowserTools } = require("./agent-tools-browser.js"); // браузер агента (живой мост: снимок уходит событием)


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
  // Пароли сайтов и почта — своим модулем (часть 40, заход 11). Живого моста не
  // нужно: настройки читаются в момент вызова, браузерный набор приходит в deps.
  // Имя vaultTools, а не vault: vault уже занято хранилищем паролей из deps.
  const vaultTools = createVaultTools(deps);
  // Окружение агента и OTA — своим модулем (часть 40, заход 12). Живой мост нужен
  // ветке окружения: выданные переменные меняются на ходу и живут в main.js.
  const envTools = createEnvTools(deps, live);
  // Браузер агента — своим модулем (часть 40, заход 13). Живой мост нужен снимку:
  // картинка уходит человеку событием. Имя agentBrowser: browserTools занято депом.
  const agentBrowser = createBrowserTools(deps, live);
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
    "envSet": envTools.envSet,

    "envList": envTools.envList,

    "envUnset": envTools.envUnset,

    "writeFile": write.writeFile,
    "webSearch": netTools.webSearch,
    "webFetch": netTools.webFetch,
    "browserConnect": agentBrowser.browserConnect,

    "browserOpen": agentBrowser.browserOpen,

    "browserSnapshot": agentBrowser.browserSnapshot,

    "browserFill": agentBrowser.browserFill,

    "browserClick": agentBrowser.browserClick,

    "browserAct": agentBrowser.browserAct,

    "browserSelect": agentBrowser.browserSelect,

    "browserPress": agentBrowser.browserPress,

    "browserText": agentBrowser.browserText,

    "browserScreenshot": agentBrowser.browserScreenshot,

    "browserEval": agentBrowser.browserEval,

    "browserDOM": agentBrowser.browserDOM,

    "browserOverlays": agentBrowser.browserOverlays,

    "browserWait": agentBrowser.browserWait,

    "browserScroll": agentBrowser.browserScroll,

    "browserHover": agentBrowser.browserHover,

    "browserNetwork": agentBrowser.browserNetwork,

    "browserReplay": agentBrowser.browserReplay,

    "waitForIdle": media.waitForIdle,

    "agentGuide": media.agentGuide,
    "browserClose": agentBrowser.browserClose,

    "browserStatus": agentBrowser.browserStatus,

    "browserClearProfile": agentBrowser.browserClearProfile,

    "vaultList": vaultTools.vaultList,
    "vaultFill": vaultTools.vaultFill,
    "mailSend": vaultTools.mailSend,
    "mailList": vaultTools.mailList,
    "mailCode": vaultTools.mailCode,
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
    "suggestRole": appTools.suggestRole,
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
    "diaryWrite": memory.diaryWrite,
    "diaryRead": memory.diaryRead,
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
    "otaStatus": envTools.otaStatus,

    "otaCheck": envTools.otaCheck,

    "otaRollback": envTools.otaRollback,

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

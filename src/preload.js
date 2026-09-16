"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  isElectron: true,
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (s) => ipcRenderer.invoke("settings:set", s),
  policyGroups: () => ipcRenderer.invoke("policy:groups"), // группы выдачи секретов для настроек
  loadChats: () => ipcRenderer.invoke("chats:load"),
  saveChats: (d) => ipcRenderer.invoke("chats:save", d),
  saveChatsSync: (d) => ipcRenderer.sendSync("chats:saveSync", d),
  sendMessage: (messages, opts) => ipcRenderer.invoke("ai:send", messages, opts || {}),
  answerQuestion: (text) => ipcRenderer.invoke("ai:answer", text),
  undoStatus: () => ipcRenderer.invoke("undo:status"),
  undoRollback: () => ipcRenderer.invoke("undo:rollback"),
  stopMessage: () => ipcRenderer.invoke("ai:stop"),
  testConnection: (ui) => ipcRenderer.invoke("ai:test", ui),
  listModels: (ui) => ipcRenderer.invoke("ai:models", ui),
  probeLocalModel: (ui) => ipcRenderer.invoke("ai:probeLocal", ui),
  g4fTest: (opts) => ipcRenderer.invoke("g4f:test", opts),
  g4fProbe: (opts) => ipcRenderer.invoke("g4f:probe", opts),
  pickDirectory: () => ipcRenderer.invoke("dialog:pickDir"),
  onAiEvent: (cb) => {
    ipcRenderer.on("ai:event", (_e, ev) => cb(ev));
  },
  // История чатов изменилась на другом устройстве (телефон сохранил переписку).
  onChatsReload: (cb) => {
    ipcRenderer.on("chats:reload", (_e, d) => cb(d));
  },

  // GitHub OAuth (device flow)
  githubDeviceStart: () => ipcRenderer.invoke("github:deviceStart"),
  githubDeviceCancel: () => ipcRenderer.invoke("github:deviceCancel"),
  githubDisconnect: () => ipcRenderer.invoke("github:disconnect"),
  githubUser: () => ipcRenderer.invoke("github:user"),
  onGithubEvent: (cb) => {
    ipcRenderer.on("github:event", (_e, ev) => cb(ev));
  },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),

  // Файлы (панель проекта)
  fsListTree: (dir) => ipcRenderer.invoke("fs:listTree", dir),
  fsReadFile: (p) => ipcRenderer.invoke("fs:readFile", p),
  fsReadImage: (p) => ipcRenderer.invoke("fs:readImage", p),
  fsCreateFile: (dir, name, content) => ipcRenderer.invoke("fs:createFile", dir, name, content),
  fsCreateFolder: (dir, name) => ipcRenderer.invoke("fs:createFolder", dir, name),
  fsWriteFile: (p, content) => ipcRenderer.invoke("fs:writeFile", p, content),
  fsDelete: (p) => ipcRenderer.invoke("fs:delete", p),
  fsImportDropped: (dir, items) => ipcRenderer.invoke("fs:importDropped", dir, items),
  fsPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return (file && file.path) || "";
    }
  },
  fsOpenInExplorer: (p) => ipcRenderer.invoke("fs:openInExplorer", p),

  // Проекты (панель проекта, до 10)
  // Дела (личный список задач со сроками).
  tasksBoard: () => ipcRenderer.invoke("tasks:board"),
  // Миссии (долгая работа): состояние для панели, пауза, продолжение, папка.
  missionState: () => ipcRenderer.invoke("mission:state"),
  missionPause: () => ipcRenderer.invoke("mission:pause"),
  missionStop: () => ipcRenderer.invoke("mission:stop"),
  missionResume: () => ipcRenderer.invoke("mission:resume"),
  missionOpen: (id) => ipcRenderer.invoke("mission:open", id || ""),
  // Закрыть миссию руками: без этого незакрытая работа могла висеть в панели вечно.
  missionFinish: (id) => ipcRenderer.invoke("mission:finish", id || ""),
  // Файлы работы агента (.agent/ рядом с проектом): задачи и контекст
  agentFilesStatus: () => ipcRenderer.invoke("agentfiles:status"),
  agentFilesOpen: (id) => ipcRenderer.invoke("agentfiles:openDir", id || ""),
  agentFilesClear: () => ipcRenderer.invoke("agentfiles:clear"),
  tasksList: (opts) => ipcRenderer.invoke("tasks:list", opts || {}),
  tasksAdd: (input) => ipcRenderer.invoke("tasks:add", input || {}),
  tasksUpdate: (key, patch) => ipcRenderer.invoke("tasks:update", key, patch || {}),
  tasksDone: (key, done) => ipcRenderer.invoke("tasks:done", key, done !== false),
  tasksDelete: (key) => ipcRenderer.invoke("tasks:delete", key),
  // Планировщик ↔ окно: подтверждение, что автозадача действительно пошла в прогон.
  // Без него приложение считало запуск состоявшимся и к делу больше не подходило.
  tasksAutoAck: (key, ok, error) => ipcRenderer.invoke("tasks:auto-ack", key, ok !== false, error || ""),
  tasksAutoRearm: (key) => ipcRenderer.invoke("tasks:auto-rearm", key),
  onTasksChanged: (cb) => {
    ipcRenderer.on("tasks:changed", (_e, payload) => cb(payload || {}));
  },
  projectsList: () => ipcRenderer.invoke("projects:list"),
  projectsCreate: (name, dir) => ipcRenderer.invoke("projects:create", name, dir || ""),
  projectsActivate: (id) => ipcRenderer.invoke("projects:activate", id),
  projectsRemove: (id) => ipcRenderer.invoke("projects:remove", id),

  // Git (панель проекта)
  gitRepoInfo: (dir) => ipcRenderer.invoke("git:repoInfo", dir),
  gitStatus: (dir) => ipcRenderer.invoke("git:status", dir),
  gitLog: (dir, n) => ipcRenderer.invoke("git:log", dir, n),
  gitCommitDetail: (dir, hash) => ipcRenderer.invoke("git:commitDetail", dir, hash),
  gitRevert: (dir, hash) => ipcRenderer.invoke("git:revert", dir, hash),
  gitResetHard: (dir, hash) => ipcRenderer.invoke("git:resetHard", dir, hash),
  gitRestore: (dir) => ipcRenderer.invoke("git:restore", dir),
  gitUndoLastCommit: (dir) => ipcRenderer.invoke("git:undoLastCommit", dir),
  gitClone: (base, url) => ipcRenderer.invoke("git:clone", base, url),
  gitDiff: (dir, file) => ipcRenderer.invoke("git:diff", dir, file),
  gitCommit: (dir, message) => ipcRenderer.invoke("git:commit", dir, message),
  gitPush: (dir) => ipcRenderer.invoke("git:push", dir),
  gitPull: (dir) => ipcRenderer.invoke("git:pull", dir),
  gitUnstage: (dir, file) => ipcRenderer.invoke("git:unstage", dir, file),
  gitRm: (dir, file) => ipcRenderer.invoke("git:rm", dir, file),

  // GitHub repo picker (opts: { query, page })
  githubPickRepo: (repoSlug) => ipcRenderer.invoke("github:pickRepo", repoSlug),
  githubRepos: (opts) => ipcRenderer.invoke("github:repos", opts || {}),
  githubSelectRepo: (repoSlug, workingDir) => ipcRenderer.invoke("github:selectRepo", repoSlug, workingDir),
  githubSelectedRepo: () => ipcRenderer.invoke("github:selectedRepo"),
  githubUnselectRepo: () => ipcRenderer.invoke("github:unselectRepo"),
  // Создать НОВЫЙ репозиторий и выгрузить в него папку проекта (opts: { dir, name, description, private })
  githubPublish: (opts) => ipcRenderer.invoke("github:publish", opts || {}),

  // Пользовательский терминал (нижняя панель)
  termStart: () => ipcRenderer.invoke("term:start"),
  termInput: (text) => ipcRenderer.invoke("term:input", text),
  termStop: () => ipcRenderer.invoke("term:stop"),
  termStatus: () => ipcRenderer.invoke("term:status"),
  termComplete: (prefix) => ipcRenderer.invoke("term:complete", prefix),
  onTermEvent: (cb) => {
    ipcRenderer.on("term:event", (_e, ev) => cb(ev));
  },

  // Быстрый запуск проекта в превью: старт/стоп dev-сервера + освобождение порта
  devStart: (dir, command) => ipcRenderer.invoke("dev:start", dir, command),
  devStop: () => ipcRenderer.invoke("dev:stop"),
  devStatus: (dir) => ipcRenderer.invoke("dev:status", dir),
  onDevEvent: (cb) => {
    ipcRenderer.on("dev:event", (_e, ev) => cb(ev));
  },

  // Мобильный доступ (LAN + PWA + PIN): статус моста и новый PIN
  mobileStatus: () => ipcRenderer.invoke("mobile:status"),
  mobilePinRegen: () => ipcRenderer.invoke("mobile:pinRegen"),

  // Браузер агента: постоянный профиль (сессии сайтов) — статус и очистка
  browserProfileInfo: () => ipcRenderer.invoke("browser:profileInfo"),
  browserClearProfile: () => ipcRenderer.invoke("browser:clearProfile"),
  browserConnect: (opts) => ipcRenderer.invoke("browser:connect", opts),
  browserConnectInfo: () => ipcRenderer.invoke("browser:connectInfo"),

  // Почта (SMTP/IMAP): проверка входа, последние письма, тестовое письмо себе
  mailTest: () => ipcRenderer.invoke("mail:test"),
  mailRecent: (limit) => ipcRenderer.invoke("mail:recent", limit),
  mailTestSend: () => ipcRenderer.invoke("mail:testSend"),

  // Yandex Cloud (REST API): авторизация, каталог, дашборд, создание/удаление
  ycStatus: () => ipcRenderer.invoke("yc:status"),
  ycSetToken: (token) => ipcRenderer.invoke("yc:setToken", token),
  ycFolders: () => ipcRenderer.invoke("yc:folders"),
  ycSetFolder: (folderId, folderName, cloudId) => ipcRenderer.invoke("yc:setFolder", folderId, folderName, cloudId),
  ycSetPermissions: (allowCreate, allowDelete, allowUpdate) => ipcRenderer.invoke("yc:setPermissions", allowCreate, allowDelete, allowUpdate),
  ycLogout: () => ipcRenderer.invoke("yc:logout"),
  ycResources: () => ipcRenderer.invoke("yc:resources"),
  ycConsoleOverview: (args) => ipcRenderer.invoke("yc:console:overview", args || {}),
  ycConsoleList: (args) => ipcRenderer.invoke("yc:console:list", args || {}),
  ycConsoleRollback: (args) => ipcRenderer.invoke("yc:console:rollback", args || {}),
  ycCosts: (serviceKey, params) => ipcRenderer.invoke("yc:costs", serviceKey, params || {}),
  ycCreate: (serviceKey, name, opts) => ipcRenderer.invoke("yc:create", serviceKey, name, opts || {}),
  ycDelete: (serviceKey, resourceId) => ipcRenderer.invoke("yc:delete", serviceKey, resourceId),
  ycDeploy: (folderDir, appName, opts) => ipcRenderer.invoke("yc:deploy", folderDir, appName, opts || {}),
  // Деплой: состояние .cloud проекта, запуск, откат и разовая проверка адреса.
  deployState: (dir) => ipcRenderer.invoke("deploy:state", dir || ""),
  deployRun: (dir, opts) => ipcRenderer.invoke("deploy:run", dir || "", opts || {}),
  deployRollback: (dir, opts) => ipcRenderer.invoke("deploy:rollback", dir || "", opts || {}),
  deployHealth: (url, paths) => ipcRenderer.invoke("deploy:health", url || "", paths || []),
  ycLogs: (serviceKey, resourceId) => ipcRenderer.invoke("yc:logs", serviceKey, resourceId),
  ycCliStatus: () => ipcRenderer.invoke("yc:cliStatus"),
  ycInstallCli: () => ipcRenderer.invoke("yc:installCli"),

  // 🧠 Память диалогов: дневник сжатых памяток контекста (папка по датам)
  memoryStats: () => ipcRenderer.invoke("memory:stats"),
  memoryDays: () => ipcRenderer.invoke("memory:days"),
  memoryOpenDir: () => ipcRenderer.invoke("memory:openDir"),
  memoryClear: (date) => ipcRenderer.invoke("memory:clear", date),

  // Локальный self-update (OTA): статус, проверка, откат, открыть папку
  otaStatus: () => ipcRenderer.invoke("ota:status"),
  otaCheck: () => ipcRenderer.invoke("ota:check"),
  otaRollback: () => ipcRenderer.invoke("ota:rollback"),
  otaOpenDir: () => ipcRenderer.invoke("ota:openDir"),
  otaReset: (removeSource) => ipcRenderer.invoke("ota:reset", removeSource),
});
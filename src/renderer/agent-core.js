"use strict";

/* Общее ядро агента: системный промпт, определения инструментов, стриппер думающих блоков,
   а также унифицированный транспорт к трём семействам провайдеров:
     - "ollama"    — локальная Ollama (нативный /api/chat, NDJSON-стрим)
     - "openai"    — OpenAI-совместимые API (OpenAI, Groq, OpenRouter, DeepSeek, Yandex AI Studio, свой) — /chat/completions
     - "anthropic" — Claude (Anthropic Messages API /v1/messages, SSE-стрим)
   Работает и в Electron main (CommonJS), и в браузере (window.AgentCore). */
(function (root, factory) {
  // Ядро собирается из вынесенных модулей: подключение к провайдеру, транспорт
  // (сообщения и стрим), контекст (бюджет и компакция), веб (поиск/чтение страниц)
  // и вспомогательная модель (зрение + изображения). В Electron main они приходят
  // через require, в окне — как одноимённые объекты в window (теги <script> ПЕРЕД
  // agent-core.js, в порядке зависимостей: config → transport → context → agent).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(
      require("./provider-config.js"),
      require("./provider-transport.js"),
      require("./context-window.js"),
      require("./web-tools.js"),
      require("./image-tools.js"),
      require("./prompts.js"),
      require("./tool-schemas.js")
    );
  } else {
    root.AgentCore = factory(root.ProviderConfig, root.ProviderTransport, root.ContextWindow, root.WebTools, root.ImageTools, root.Prompts, root.ToolSchemas);
  }
})(typeof self !== "undefined" ? self : this, function (ProviderConfig, ProviderTransport, ContextWindow, WebTools, ImageTools, Prompts, ToolSchemas) {
  // ── Подключение к провайдеру ───────────────────────────────────────────────
  // Адреса, ключи, заголовки, лимиты и чтение ошибок живут в отдельном модуле
  // src/renderer/provider-config.js. Он не знает ни о сообщениях агента, ни о
  // настройках: каждое значение приходит ему аргументом. Объявления стоят в начале
  // файла, чтобы код ниже — в том числе контекст и окно модели — видел их всегда.
  const {
    G4F_PROVIDERS,
    splitG4fRoute,
    baseFor,
    isLocalBase,
    proxiedBase,
    apiKeyFor,
    apiHeaders,
    projectHeader,
    jsonArgs,
    genCallId,
    readApiError,
    friendlyRateLimitError,
    classifyKeyError,
    rateLimitInfo,
    createRateLimiter,
    fmtError,
  } = ProviderConfig;

  // ── Локальный ли сервер ────────────────────────────────────────────────
  // Признак — АДРЕС, а не имя семейства. LM Studio, vLLM, llama.cpp и LocalAI
  // говорят на OpenAI-совместимом API, но живут на своём ПК: токены там бесплатны,
  // окно может быть маленьким, а ответ на CPU — долгим. Раньше всё это было
  // привязано к provider === "ollama", и локальный сервер получал облачные лимиты
  // (бюджет от денег, таймаут 90 с, схемы всегда). Ollama остаётся локальной всегда:
  // даже на удалённом хосте её num_ctx/keep_alive — часть своего протокола.
  function isLocalEndpoint(settings) {
    const s = settings || {};
    const provider = s.provider || "openai";
    if (provider === "ollama") return true;
    try {
      return isLocalBase(baseFor(provider, s));
    } catch {
      return false;
    }
  }

  // ── Системный промпт и таблица инструментов агента ────────────────────────
  // Текст правил живёт в src/renderer/prompts.js, схемы инструментов — в
  // src/renderer/tool-schemas.js: это данные без логики, и правятся они там.
  // Ядро пользуется ими и отдаёт наружу под теми же именами (SYSTEM_PROMPT,
  // TOOL_DEFINITIONS), поэтому main.js, инструменты и тесты не менялись.
  const { SYSTEM_PROMPT } = Prompts;
  const { TOOL_DEFINITIONS } = ToolSchemas;

  // ── Транспорт провайдеров ──────────────────────────────────────────────────
  // Конвертация сообщений, кэш промпта, сборка запроса, стрим ответа, список
  // моделей и окно модели живут в src/renderer/provider-transport.js. Ему нужны
  // ровно две вещи: подключение к провайдеру и таблица инструментов выше.
  const {
    partsText,
    buildChatRequest,
    consumeProviderStream,
    listModels,
    normalizeUsage,
    splitStaticSystem,
    anthropicSystem,
    modelWindow,
    ollamaModelInfo,
    ollamaNumCtx,
    probeLocalModel,
    toolsAsText,
    withTextTools,
  } = ProviderTransport({ config: ProviderConfig, toolDefinitions: TOOL_DEFINITIONS });

  // ── Контекст и компакция ───────────────────────────────────────────────────
  // Оценка токенов, бюджет, обрезка истории и сжатие старых витков в памятку живут
  // в src/renderer/context-window.js. Ему нужны подключение к провайдеру (запрос к
  // дешёвой модели за памяткой) и транспорт (разбор частей сообщения). Объявления
  // стоят здесь, а не по месту использования: ниже таблица групп немедленно считает
  // вес инструментов через estimateTokens.
  const {
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    windowBudget,
    sanitizeToolPairs,
    trimConversation,
    truncateText,
    compactRemote,
    createContextManager,
  } = ContextWindow({ config: ProviderConfig, transport: ProviderTransport });

  // ── Контекст-окно, бюджет и обрезка истории — в src/renderer/context-window.js ──
  // estimateTokens, contextBudget, trimConversation, compactRemote и
  // createContextManager получены в начале файла.

  // Веб: поиск и чтение страниц — в модуле src/renderer/web-tools.js.
  // Имена не изменились, поэтому main.js, preview-сервер и инструменты не менялись.
  const { downloadHtml, webSearchDDG, webSearch, htmlToText, webFetchPage } = WebTools;

  /* Стриппер думающих блоков <think>...</think> / <thought>...</thought>.
     Устойчив к стримингу: теги могут приходить по кусочкам.
     opts.onHidden(chunk) — если передан, получает текст рассуждений по мере
     стриминга (его можно показать пользователю, как в Replit/Claude). */
  function createThinkingStripper(opts) {
    const onHidden = opts && typeof opts.onHidden === "function" ? opts.onHidden : null;
    let visible = "";
    let hidden = "";
    let inBlock = false;
    const hold = 16; // хвост, в котором может прятаться незавершённый тег
    const openRe = /<think(ing)?>/i;
    const closeRe = /<\/think(ing)?>/i;
    function flushHidden() {
      if (!onHidden || !inBlock) return;
      if (hidden.length > hold) {
        const out = hidden.slice(0, hidden.length - hold);
        hidden = hidden.slice(hidden.length - hold);
        if (out) onHidden(out);
      }
    }
    return {
      push(text) {
        if (!text) return "";
        for (const ch of text) {
          if (!inBlock) {
            visible += ch;
            const m = visible.slice(-hold).match(openRe);
            if (m) {
              visible = visible.slice(0, visible.length - m[0].length);
              hidden = "";
              inBlock = true;
            }
          } else {
            hidden += ch;
            flushHidden();
            const close = hidden.slice(-hold).match(closeRe);
            if (close) {
              // Дофлашиваем рассуждения, не включая сам закрывающий тег
              const idx = hidden.lastIndexOf(close[0]);
              if (idx > 0 && onHidden) onHidden(hidden.slice(0, idx));
              hidden = "";
              inBlock = false;
            }
          }
        }
        let out = "";
        if (!inBlock && visible.length > hold) {
          out = visible.slice(0, visible.length - hold);
          visible = visible.slice(visible.length - hold);
        }
        return out;
      },
      finish() {
        if (inBlock) {
          // Поток оборвался внутри блока — отдаём накопленные рассуждения целиком
          if (onHidden && hidden) onHidden(hidden);
          inBlock = false;
          hidden = "";
          visible = "";
          return "";
        }
        const out = visible;
        visible = "";
        return out;
      },
    };
  }

  function stripThinking(text) {
    const s = createThinkingStripper();
    return s.push(text) + s.finish();
  }

  // ── План работ (todoWrite): нормализация пунктов ──────────────────────────
  // Принимает что угодно (строки, объекты, JSON-строку) и возвращает чистый
  // список: до 7 пунктов, допустимые статусы, уникальные id. Никогда не бросает.
  const PLAN_STATUSES = ["pending", "in_progress", "done", "failed"];
  const PLAN_MAX_ITEMS = 7;
  const PLAN_STATUS_ALIASES = {
    pending: "pending", todo: "pending", new: "pending", open: "pending", waiting: "pending",
    ожидает: "pending", ожидание: "pending", запланировано: "pending", план: "pending",
    in_progress: "in_progress", inprogress: "in_progress", progress: "in_progress", doing: "in_progress",
    active: "in_progress", current: "in_progress", running: "in_progress",
    в_работе: "in_progress", вработе: "in_progress", работа: "in_progress", выполняется: "in_progress",
    done: "done", complete: "done", completed: "done", ok: "done", success: "done", finished: "done",
    готово: "done", выполнено: "done", сделано: "done", завершено: "done",
    failed: "failed", fail: "failed", error: "failed", blocked: "failed",
    ошибка: "failed", не_удалось: "failed", неудалось: "failed", провал: "failed",
  };

  function normalizePlanStatus(v) {
    const k = String(v == null ? "" : v).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (PLAN_STATUS_ALIASES[k]) return PLAN_STATUS_ALIASES[k];
    return "pending";
  }

  function normalizePlanTasks(raw) {
    let list = raw;
    if (list && !Array.isArray(list) && typeof list === "object") {
      // Модель часто присылает { tasks: [...] } или { items: [...] } целиком.
      list = list.tasks || list.items || list.steps || list.plan || list.todos || null;
    }
    if (typeof list === "string") {
      const t = list.trim();
      try {
        const parsed = JSON.parse(t);
        list = Array.isArray(parsed) ? parsed : (parsed && (parsed.tasks || parsed.items || parsed.steps)) || null;
      } catch {
        // Свободный текст: каждая значимая строка — пункт (снимаем «- », «1. », «[ ]»).
        list = t.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    for (const it of list) {
      let text = "";
      let status = "pending";
      let note = "";
      if (it && typeof it === "object") {
        text = String(it.text || it.title || it.task || it.name || it.step || "").trim();
        status = normalizePlanStatus(it.status || it.state || it.done);
        note = String(it.note || it.comment || it.detail || "").trim();
      } else {
        text = String(it == null ? "" : it).trim().replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim();
      }
      // Строка вида «- [x] шаг» / «☑ шаг» — статус прямо в тексте.
      const cb = text.match(/^\[([ xX\-\/])\]\s*/);
      if (cb) {
        text = text.slice(cb[0].length).trim();
        if (cb[1].toLowerCase() === "x") status = "done";
        else if (cb[1] === "/") status = "in_progress";
      }
      const mark = text.match(/^(✅|✔|☑|❌|⚠️|⚠|🔄|⏳|⬜)\s*/);
      if (mark) {
        text = text.slice(mark[0].length).trim();
        const ch = mark[1];
        if (ch === "✅" || ch === "✔" || ch === "☑") status = "done";
        else if (ch === "❌" || ch === "⚠️" || ch === "⚠") status = "failed";
        else if (ch === "🔄" || ch === "⏳") status = "in_progress";
      }
      // Обрезаем служебное: длинные пункты не нужны, они ломают слабые модели.
      if (text.length > 160) text = text.slice(0, 157).trim() + "…";
      if (note.length > 120) note = note.slice(0, 117).trim() + "…";
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: "t" + (out.length + 1), text, status, note });
      if (out.length >= PLAN_MAX_ITEMS) break;
    }
    // Ровно один шаг может быть «в работе»: если модель пометила несколько
    // (частая ошибка слабых моделей), оставляем первый, остальные понижаем.
    let seenActive = false;
    for (const it of out) {
      if (it.status !== "in_progress") continue;
      if (seenActive) it.status = "pending";
      else seenActive = true;
    }
    return out;
  }

  function planSummary(tasks) {
    const items = Array.isArray(tasks) ? tasks : [];
    const total = items.length;
    const done = items.filter((t) => t && t.status === "done").length;
    const failed = items.filter((t) => t && t.status === "failed").length;
    const active = items.find((t) => t && t.status === "in_progress");
    return { total, done, failed, active: active ? active.text : "" };
  }
  const TOOL_ALIASES = {
    createfile: "writeFile",
    create_file: "writeFile",
    write_file: "writeFile",
    read_file: "readFile",
    list_directory: "listDirectory",
    mkdir: "createFolder",
    makedirectory: "createFolder",
    make_dir: "createFolder",
    create_folder: "createFolder",
    git_clone: "gitClone",
    git_status: "gitStatus",
    git_commit: "gitCommit",
    git_push: "gitPush",
    git_pull: "gitPull",
    git_log: "gitLog",
    git_revert: "gitRevert",
    read_file_lines: "readFileLines",
    readfilelines: "readFileLines",
    edit_file: "editFile",
    editfile: "editFile",
    run_command: "runCommand",
    runcommand: "runCommand",
    shells_status: "shellsStatus",
    shellsstatus: "shellsStatus",
    shell_status: "shellsStatus",
    check_shells: "shellsStatus",
    shells: "shellsStatus",
    browser_open: "browserOpen",
    browser_snapshot: "browserSnapshot",
    browsersnapshot: "browserSnapshot",
    snapshot: "browserSnapshot",
    dom: "browserSnapshot",
    page_map: "browserSnapshot",
    browser_fill: "browserFill",
    browser_click: "browserClick",
    browser_select: "browserSelect",
    browser_press: "browserPress",
    browser_text: "browserText",
    browser_screenshot: "browserScreenshot",
    browser_eval: "browserEval",
    browsereval: "browserEval",
    eval_js: "browserEval",
    run_js: "browserEval",
    execute_js: "browserEval",
    browser_dom: "browserDOM",
    browserdom: "browserDOM",
    dom_html: "browserDOM",
    browser_overlays: "browserOverlays",
    browseroverlays: "browserOverlays",
    overlays: "browserOverlays",
    browser_act: "browserAct",
    browseract: "browserAct",
    act: "browserAct",
    steps: "browserAct",
    dialogs: "browserOverlays",
    dismiss_overlays: "browserOverlays",
    browser_wait: "browserWait",
    hover: "browserHover",
    scroll: "browserScroll",
    network: "browserNetwork",
    replay: "browserReplay",
    browser_replay: "browserReplay",
    replay_request: "browserReplay",
    virtual_list: "browserReplay",
    list_all: "browserReplay",
    read_all: "browserReplay",
    browser_scroll: "browserScroll",
    scroll_page: "browserScroll",
    scrollto: "browserScroll",
    scroll_to: "browserScroll",
    browser_hover: "browserHover",
    hover_element: "browserHover",
    browser_network: "browserNetwork",
    network_log: "browserNetwork",
    requests: "browserNetwork",
    wait_for_idle: "waitForIdle",
    waitidle: "waitForIdle",
    idle: "waitForIdle",
    agent_guide: "agentGuide",
    agentguide: "agentGuide",
    guide: "agentGuide",
    site_guide: "agentGuide",
    browser_close: "browserClose",
    browser_status: "browserStatus",
    memory_list: "memoryList",
    memorylist: "memoryList",
    memory_days: "memoryList",
    memory_search: "memorySearch",
    memorysearch: "memorySearch",
    context_memory: "memoryList",
    browser_clear_profile: "browserClearProfile",
    browserclearprofile: "browserClearProfile",
    browser_connect: "browserConnect",
    browserconnect: "browserConnect",
    cdp: "browserConnect",
    my_chrome: "browserConnect",
    mychrome: "browserConnect",
    vault_list: "vaultList",
    vaultlist: "vaultList",
    vault_fill: "vaultFill",
    vaultfill: "vaultFill",
    mail_send: "mailSend",
    mailsend: "mailSend",
    send_mail: "mailSend",
    send_email: "mailSend",
    email: "mailSend",
    mail_list: "mailList",
    maillist: "mailList",
    inbox: "mailList",
    list_mail: "mailList",
    mail_code: "mailCode",
    mailcode: "mailCode",
    confirmation_code: "mailCode",
    email_code: "mailCode",
    app_read: "appRead",
    app_click: "appClick",
    app_fill: "appFill",
    app_select: "appSelect",
    app_press: "appPress",
    app_wait: "appWait",
    app_screenshot: "appScreenshot",
    terminal: "runCommand",
    shell: "runCommand",
    execute: "runCommand",
    web_search: "webSearch",
    websearch: "webSearch",
    search: "webSearch",
    internet_search: "webSearch",
    web_fetch: "webFetch",
    webfetch: "webFetch",
    fetch_url: "webFetch",
    fetch: "webFetch",
    open_url: "webFetch",
    read_url: "webFetch",
    readweb: "webFetch",
    search_file: "searchFile",
    searchfile: "searchFile",
    grep: "searchFile",
    find_in_file: "searchFile",
    search_project: "searchProject",
    searchproject: "searchProject",
    file_outline: "fileOutline",
    fileoutline: "fileOutline",
    outline: "fileOutline",
    structure: "fileOutline",
    symbols: "fileOutline",
    toc: "fileOutline",
    file_map: "fileOutline",
    grep_project: "searchProject",
    find: "searchProject",
    rg: "searchProject",
    list_files: "listFiles",
    listfiles: "listFiles",
    tree: "listFiles",
    ls: "listFiles",
    project_tree: "listFiles",
    ask_user: "askUser",
    askuser: "askUser",
    question: "askUser",
    ask: "askUser",
    start_background: "startBackground",
    startbackground: "startBackground",
    bg: "startBackground",
    run_background: "startBackground",
    list_background: "listBackground",
    listbackground: "listBackground",
    background_output: "backgroundOutput",
    backgroundoutput: "backgroundOutput",
    process_output: "backgroundOutput",
    logs: "backgroundOutput",
    send_input: "sendInput",
    sendinput: "sendInput",
    sendkeys: "sendInput",
    simulate_input: "sendInput",
    stop_background: "stopBackground",
    stopbackground: "stopBackground",
    kill_process: "stopBackground",
    shell_start: "shellStart",
    shellstart: "shellStart",
    start_shell: "shellStart",
    shell_send: "shellSend",
    shellsend: "shellSend",
    shell_command: "shellSend",
    check_url: "checkUrl",
    checkurl: "checkUrl",
    ping_url: "checkUrl",
    openurl: "openUrl",
    open_url_browser: "openUrl",
    show_image: "showImage",
    showimage: "showImage",
    display_image: "showImage",
    check_port: "checkPort",
    checkport: "checkPort",
    list_ports: "listPorts",
    listports: "listPorts",
    netstat: "listPorts",
    docker_build: "dockerBuild",
    dockerbuild: "dockerBuild",
    docker_run: "dockerRun",
    dockerrun: "dockerRun",
    docker_exec: "dockerExec",
    dockerexec: "dockerExec",
    install_package: "installPackage",
    installpackage: "installPackage",
    npm_install: "installPackage",
    yarn_add: "installPackage",
    pnpm_add: "installPackage",
    lint_project: "lintProject",
    lintproject: "lintProject",
    lint: "lintProject",
    tsc_check: "lintProject",
    eslint: "lintProject",
    run_tests: "runTests",
    runtests: "runTests",
    test: "runTests",
    runtest: "runTests",
    diff_view: "diffView",
    diffview: "diffView",
    compare: "diffView",
    preview_ui: "previewUI",
    previewui: "previewUI",
    preview: "previewUI",
    open_preview: "previewUI",
    screenshot_capture: "screenshotCapture",
    screenshotcapture: "screenshotCapture",
    screenshot: "screenshotCapture",
    capture: "screenshotCapture",
    env_set: "envSet",
    envset: "envSet",
    set_env: "envSet",
    export_env: "envSet",
    env_list: "envList",
    envlist: "envList",
    list_env: "envList",
    env_unset: "envUnset",
    envunset: "envUnset",
    unset_env: "envUnset",
    read_file_structure: "readFileStructure",
    readfilestructure: "readFileStructure",
    file_structure: "readFileStructure",
    imports_exports: "readFileStructure",
    explain_code: "explainCode",
    explaincode: "explainCode",
    explain: "explainCode",
    explain_file: "explainCode",
    edit_file_nth: "editFile",
    editfilenth: "editFile",
    get_functions: "fileOutline",
    getfunctions: "fileOutline",
    functions: "fileOutline",
    exports: "fileOutline",
    undo_edit: "undoEdit",
    undoedit: "undoEdit",
    undo: "undoEdit",
    rollback: "undoEdit",
    refactor_rename: "refactorRename",
    refactorrename: "refactorRename",
    rename_symbol: "refactorRename",
    rename_function: "refactorRename",
    rename: "refactorRename",
    run_command_output: "runCommandOutput",
    runcommandoutput: "runCommandOutput",
    run_with_retry: "runCommandOutput",
    wait_for: "runCommandOutput",
    run_until: "runCommandOutput",
    api_request: "apiRequest",
    apirequest: "apiRequest",
    http_request: "apiRequest",
    http: "apiRequest",
    request: "apiRequest",
    curl: "apiRequest",
    run_script: "runScript",
    runscript: "runScript",
    npm_run: "runScript",
    run_npm_script: "runScript",
    validate_project: "validateProject",
    validateproject: "validateProject",
    validate: "validateProject",
    check_project: "validateProject",
    full_check: "validateProject",
    git_branch: "gitBranch",
    gitbranch: "gitBranch",
    branch: "gitBranch",
    branches: "gitBranch",
    git_checkout: "gitCheckout",
    gitcheckout: "gitCheckout",
    checkout: "gitCheckout",
    switch_branch: "gitCheckout",
    switchbranch: "gitCheckout",
    git_diff_branches: "gitDiff",
    gitdiff: "gitDiff",
    compare_branches: "gitDiff",
    branch_diff: "gitDiff",
    git_undo_last_commit: "gitUndoLastCommit",
    git_init: "gitInit",
    gitinit: "gitInit",
    init_repo: "gitInit",
    initrepo: "gitInit",
    create_repo: "gitInit",
    createrepo: "gitInit",
    new_repo: "gitInit",
    local_repo: "gitInit",
    init_git: "gitInit",
    gitundolastcommit: "gitUndoLastCommit",
    undo_commit: "gitUndoLastCommit",
    soft_reset: "gitUndoLastCommit",
    find_references: "findReferences",
    findreferences: "findReferences",
    references: "findReferences",
    where_used: "findReferences",
    usages: "findReferences",
    symbol_usage: "findReferences",
    reset_soft: "gitUndoLastCommit",
    get_dependencies: "getDependencies",
    getdependencies: "getDependencies",
    dependencies: "getDependencies",
    deps: "getDependencies",
    npm_ls: "getDependencies",
    npm_audit: "getDependencies",
    format_code: "formatCode",
    formatcode: "formatCode",
    format: "formatCode",
    prettier: "formatCode",
    db_query: "dbQuery",
    dbquery: "dbQuery",
    sql: "dbQuery",
    psql: "dbQuery",
    query_db: "dbQuery",
    install_system_package: "installSystemPackage",
    installsystempackage: "installSystemPackage",
    install_system: "installSystemPackage",
    check_installed_program: "checkInstalledProgram",
    checkinstalledprogram: "checkInstalledProgram",
    check_program: "checkInstalledProgram",
    installed: "checkInstalledProgram",
    can_execute: "canExecute",
    canexecute: "canExecute",
    exists: "canExecute",
    refresh_env: "refreshEnv",
    refreshenv: "refreshEnv",
    refresh_path: "refreshEnv",
    get_system_info: "getSystemInfo",
    getsysteminfo: "getSystemInfo",
    system_info: "getSystemInfo",
    os_info: "getSystemInfo",
    explain_error: "explainError",
    explainerror: "explainError",
    exit_code: "explainError",
    retry_command: "retryCommand",
    retrycommand: "retryCommand",
    timeout_command: "timeoutCommand",
    timeoutcommand: "timeoutCommand",
    run_as_admin: "runCommandAsAdmin",
    runcommandasadmin: "runCommandAsAdmin",
    admin: "runCommandAsAdmin",
    elevate: "runCommandAsAdmin",
    download_and_extract: "downloadAndExtract",
    downloadandextract: "downloadAndExtract",
    download_zip: "downloadAndExtract",
    extract_archive: "downloadAndExtract",
    todo_write: "todoWrite",
    todowrite: "todoWrite",
    todo: "todoWrite",
    todos: "todoWrite",
    plan: "todoWrite",
    write_plan: "todoWrite",
    writeplan: "todoWrite",
    update_plan: "todoWrite",
    updateplan: "todoWrite",
    plan_tasks: "todoWrite",
  };
  const KNOWN_TOOLS = TOOL_DEFINITIONS.map((t) => t.function.name);

  function normalizeToolName(name) {
    const n = String(name || "").trim();
    if (!n) return "";
    if (KNOWN_TOOLS.includes(n)) return n;
    return TOOL_ALIASES[n.toLowerCase()] || n;
  }

  function normalizeToolArgs(args) {
    if (args && typeof args === "object") return args;
    if (typeof args === "string") {
      try {
        return JSON.parse(args);
      } catch {
        return { raw: args };
      }
    }
    return {};
  }

  // Запасной способ вызова инструментов: если модель вместо tool_calls
  // напечатала JSON-объект вида {"name": "...", "arguments": {...}} текстом,
  // приложение само найдёт его и выполнит.
  function extractToolCallsFromText(text) {
    const calls = [];
    if (!text) return calls;
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("{", i);
      if (start === -1) break;
      let depth = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let k = start; k < text.length; k++) {
        const ch = text[k];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === "{") {
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) {
            end = k + 1;
            break;
          }
        }
      }
      if (end === -1) break;
      const raw = text.slice(start, end);
      i = end;
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      // Поддерживаем разные форматы, которые модели печатают текстом:
      // 1) {"name": "writeFile", "arguments": {...}}
      // 2) {"function": {"name": "writeFile", "arguments": {...}}}  (формат Ollama)
      // 3) {"tool": "gitStatus", "parameters": {...}}
      let name = obj.name || (obj.function && obj.function.name) || obj.tool;
      let args = obj.arguments != null ? obj.arguments : obj.function && obj.function.arguments != null ? obj.function.arguments : obj.parameters;
      if (typeof name !== "string") continue;
      name = normalizeToolName(name);
      if (!KNOWN_TOOLS.includes(name)) continue;
      calls.push({ name, args: normalizeToolArgs(args), raw });
    }
    return calls;
  }


  // ── Адреса, ключи и заголовки провайдеров — в src/renderer/provider-config.js ──
  // baseFor, proxiedBase, apiKeyFor, apiHeaders, projectHeader, jsonArgs, genCallId
  // и реестр G4F получены в начале файла: код ниже и остальное ядро не менялись.

  // ── Сообщения, запрос и стрим — в src/renderer/provider-transport.js ──
  // Конвертация сообщений, кэш промпта, сборка запроса, разбор потока и список
  // моделей берутся оттуда (см. начало раздела выше).

  // ── Чтение ошибок и лимиты провайдера — в src/renderer/provider-config.js ──
  // readApiError, friendlyRateLimitError, classifyKeyError, rateLimitInfo,
  // createRateLimiter и fmtError получены в начале файла.

  // ── Вспомогательная модель (второй ключ): зрение + генерация изображений ──
  // Логика живёт в src/renderer/image-tools.js: ядро даёт ей только транспортные
  // помощники, поэтому модуль можно проверять без агента и без настроек.
  const {
    normalizeAuxBase,
    auxConfig,
    describeImageRemote,
    generateImageRemote,
    imageAttempts,
    imageProviderLabel,
    proxiedUrl,
  } = ImageTools({ apiHeaders, proxiedBase, readApiError });

  // ── Динамические инструменты: при тесном контексте шлём только ядро ──
  const CORE_TOOL_NAMES = new Set([
    "createFolder", "readFile", "writeFile", "listDirectory", "readFileLines", "editFile",
    "runCommand", "runCommandOutput", "retryCommand", "timeoutCommand", "shellsStatus",
    "webSearch", "webFetch", "searchFile", "searchProject", "listFiles",
    "fileOutline", "readFileStructure", "explainCode", "undoEdit",
    "startBackground", "listBackground", "backgroundOutput", "sendInput", "stopBackground",
    "shellStart", "shellSend", "checkUrl", "checkPort", "openUrl", "showImage",
    "previewUI", "diffView", "askUser", "analyzeImage", "generateImage", "screenshotCapture",
    "listProcesses", "killProcess", "clipboardRead", "clipboardWrite", "screenshotDesktop",
    "registryRead", "registryWrite", "openPath", "wingetSearch", "installExe",
    "memoryList", "memorySearch", "todoWrite",
    // Git-минимум: приложение про репозитории — без этих инструментов агент на тесном
    // окне не мог даже посмотреть состояние, хотя до правки сюда попадал только браузер.
    "gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch", "gitPush", "gitPull", "gitInit",
    // Поиск возможностей доступен всегда: иначе «узкий» набор нечем расширить.
    "findTools",
    // Браузерный минимум: без него при тесном контексте агент не мог открыть сайт вообще.
    "browserOpen", "browserSnapshot", "browserClick", "browserFill", "browserAct",
    "browserScroll", "browserHover", "browserScreenshot", "browserNetwork", "waitForIdle",
    "browserEval", "browserOverlays", "agentGuide", "browserReplay",
  ]);
  const CORE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => CORE_TOOL_NAMES.has(t.function && t.function.name));
  // План-режим: модель должна уметь составить план структурой, а не текстом,
  // поэтому туда уходит ровно один инструмент — todoWrite.
  const PLAN_MODE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) => t.function && t.function.name === "todoWrite");
  // ── Роутер инструментов (ускорение №3) ───────────────────────────────────
  // 147 схем — это ~24 700 токенов в КАЖДОМ раунде: и деньги, и время до первого
  // токена. Роутер отдаёт модели базовый набор (файлы, терминал, основы git,
  // память, web, план) плюс только те группы, которые нужны по делу — по словам
  // в запросе пользователя и уже начатой работе.
  //
  // Два правила, которые нельзя нарушать:
  //  1) ПОРЯДОК инструментов — канонический (как в TOOL_DEFINITIONS), без сортировки
  //     по релевантности: иначе меняется префикс запроса и рушится кэш промпта
  //     (Anthropic/OpenRouter) и переиспользование префикса (OpenAI/DeepSeek/Groq).
  //  2) Липкость: группа, однажды включённая в задаче, остаётся до её конца — иначе
  //     инструмент исчезнет на середине работы.
  //
  // Предохранители: A) вызов реального инструмента вне набора → схема добавляется и
  // вызов повторяется (main.js); B) мета-инструмент findTools — модель сама просит
  // нужную возможность; C) настройка «отправлять все инструменты» + авто-расширение
  // при ошибке «неизвестный инструмент».
  // ── Роли агента ──────────────────────────────────────────────────────────
  // Роль — это РЕЖИМ ЧАТА, а не одноразовый промпт: её текст подставляется в системный
  // промпт каждый раунд, а её группы инструментов включены с первого раунда. Поэтому
  // роль держится весь диалог (чип-промпт так не умеет) и заодно сужает набор схем —
  // каждый раунд дешевле и префикс запроса стабильнее (кэш провайдера).
  const DEFAULT_ROLE = "dev";
  const AGENT_ROLES = [
    {
      id: "dev",
      icon: "🛠",
      title: "Разработчик",
      hint: "Код, файлы, git, запуск проекта — обычный режим приложения.",
      groups: [],
      chips: [],
      prompt: "",
    },
    {
      id: "assistant",
      icon: "🧑💼",
      title: "Ассистент",
      hint: "Помощник по делам на этом ПК: файлы, документы, письма, сайты, порядок.",
      groups: ["notes", "mail", "system", "browser", "files", "terminal", "vault"],
      chips: [
        { t: "Спланируй мой день", send: true },
        { t: "Разбери входящие", send: true },
        { t: "Напиши письмо", send: false },
        { t: "Наведи порядок в папке", send: false },
        { t: "Сделай выжимку из файла", send: false },
        { t: "Собери отчёт за неделю", send: true },
      ],
      prompt: [
        "РЕЖИМ «АССИСТЕНТ»: ты личный помощник по делам на этом компьютере, а не разработчик.",
        "1. Работаешь с файлами, документами, письмами, сайтами и порядком в папках; код пишешь только по прямой просьбе (иначе предложи роль «Разработчик»).",
        "2. Решения, договорённости и важные выводы сохраняй в память проекта (noteSave) — в новой сессии прочитай их (noteRead/noteList).",
        "3. Личные дела и сроки — это роль «Менеджер»: если человек говорит о дедлайнах и планах, предложи переключить роль и веди список дел.",
        "4. Файлы и документы ищи поиском по рабочей папке, прежде чем спрашивать; выжимку из длинного файла делай сам и показывай коротко.",
        "5. Письма и сообщения отправляй только по явной просьбе и после показа получателя и текста (mailSend).",
        "6. Входы на сайты бери из менеджера паролей (vaultList/vaultFill), пароли в чат не печатай.",
        "7. Заказ, бронь, формы на сайтах — через браузер; перед оплатой или отправкой данных остановись и спроси подтверждение.",
        "8. ВК (vk.com/vk.ru) — по отдельному справочнику: agentGuide { name: \"vk\" } (подхватывается сам на адресах vk.com/vk.ru). Перед действием проверь, что сессия жива (browserText); вход — пароль из менеджера паролей (vaultList/vaultFill), иначе попроси человека войти в окне. Сообщение отправляют РОВНО четыре шага: browserOpen → browserFill в [role=textbox] БЕЗ submit → browserClick по .ConvoComposer__sendButton--submit → проверка пустым полем (browserEval: .ComposerInput__input.textContent.length === 0). submit: true и Enter в ВК НЕ отправляют — текст залипает в поле.",
        "9. Действия на ПК (программы, буфер, скриншот, процессы) — группа system: сначала посмотри, потом меняй.",
      ].join("\n"),
    },
    {
      id: "manager",
      icon: "📋",
      title: "Менеджер",
      hint: "Дела и сроки: план дня, дедлайны, напоминания, отчёты.",
      // browser и vault — чтобы вести переписку с клиентами в ВК и на сайтах: без группы
      // браузера роль дел физически не могла отправить сообщение, хотя справочник ВК есть.
      groups: ["tasks", "notes", "mail", "system", "browser", "vault"],
      chips: [
        { t: "Что у меня на сегодня?", send: true },
        { t: "Что просрочено?", send: true },
        { t: "Спланируй неделю", send: true },
        { t: "Разбери входящие", send: true },
        { t: "Собери отчёт за неделю", send: true },
      ],
      prompt: [
        "РЕЖИМ «МЕНЕДЖЕР»: ты личный менеджер дел и сроков, а не разработчик.",
        "1. В начале работы и когда речь о планах — вызывай taskList (просроченные и ближайшие первыми) и опирайся на список, а не на память.",
        "2. Любую задачу, просьбу и договорённость превращай в дело: taskAdd(title, due, priority, project, note). Срок разбирается по-человечески: «завтра 14:00», «в пятницу», «через 2 недели», «15.09». Срок не назван — спроси, не выдумывай.",
        "3. Закрывай и переноси дела только по словам человека: taskDone(id, false) снимает отметку, taskUpdate меняет срок или название.",
        "4. Просроченное и «горит сегодня» говори прямо в начале ответа и предлагай, что важнее — человек не должен вычитывать список.",
        "5. Отчёты (день, неделя, проект) собирай из дел и заметок (noteList), а не из общих слов.",
        "6. Письма и напоминания наружу — только по явной просьбе и после подтверждения адресата.",
        "7. Код и файлы проекта не меняй САМОВОЛЬНО: твоя работа — дела, сроки и порядок. Но если человек прямо попросил код, скрипт или правку файла — делай: это просьба, а не самодеятельность. Большая такая работа — это миссия (missionStart), а не повод отказаться.",
        "8. Если дел нет — так и скажи и предложи занести первое.",
        "9. Повторяющиеся планы («каждый день в 9», «по понедельникам») заводи через taskAdd с repeat: «каждый день», «по будням», «каждую пятницу», «каждый месяц», «каждые 2 часа».",
        "10. Дело, которое агент должен ВЫПОЛНИТЬ сам по сроку, помечай auto: true и пиши prompt — что именно сделать. Тогда приложение в срок запустит агента в чате «Автозадачи», и ответ появится там. Без auto дело только напоминает.",
        "11. Отсрочить надоевшее напоминание — taskUpdate с snooze: «через час», «завтра 9:00». Срок при этом не меняется.",
        "12. БОЛЬШАЯ работа (разобрать десятки писем, навести порядок в куче файлов, обработать пачку документов, собрать большой отчёт) — это миссия: сначала missionStart(goal, steps), СРАЗУ после неё — todoWrite с планом миссии (панель плана видит человек, и план нужен с первого шага, а не после половины работы), потом работай шаг за шагом и после КАЖДОГО шага вызывай missionStep(done, next, note). Файлы миссии лежат в рабочей папке (.agent/missions/<id>/), поэтому работу видно человеку и она переживает перезапуск приложения.",
        "13. Миссия не закрыта — не заканчивай ответ словами «осталось сделать то и то»: продолжай делом. Закрывай её только когда работа действительно сделана — missionFinish(report) с коротким итогом.",
        "14. Если тебя разбудили по сроку (чат «Автозадачи») — сначала missionStatus (или missionStart, если миссии ещё нет), потом работа: в журнале должно быть видно, чем ты занимался.",
        "15. Переписка в ВК (клиенты, партнёры, заявки) — по справочнику agentGuide { name: \"vk\" }: адреса диалогов, селекторы, отправка сообщения, выгрузка диалогов запросом и грабли. Перед действием проверь сессию (browserText); вход — пароль из менеджера паролей (vaultList/vaultFill), иначе попроси человека войти в окне. Отправка — ровно четыре шага с кнопкой .ConvoComposer__sendButton--submit и проверкой пустого поля; submit: true и Enter в ВК НЕ отправляют.",
        "16. Отвечать людям в переписке от имени человека можно только по его просьбе и после показа адресата и текста. Непришедший ответ — это дело со сроком, а не повод писать от себя.",
      ].join("\n"),
    },
    {
      id: "researcher",
      icon: "🔎",
      title: "Исследователь",
      hint: "Поиск и разбор: источники, сравнения, выжимки с сохранением выводов.",
      groups: ["browser", "notes", "files"],
      chips: [
        { t: "Найди и разбери: ", send: false },
        { t: "Сравни подходы: ", send: false },
        { t: "Сделай выжимку из источника", send: false },
        { t: "Сохрани выводы в заметки", send: false },
      ],
      prompt: [
        "РЕЖИМ «ИССЛЕДОВАТЕЛЬ»: ты разбираешься в теме по источникам, а не пишешь код.",
        "1. Сначала поиск (webSearch), затем чтение страниц (webFetch/browser) — свежие факты важнее памяти модели.",
        "2. Каждый важный вывод подкрепляй источником: адрес и дата. Где источник один — так и скажи.",
        "3. Отделяй факты от предположений и явно помечай предположения.",
        "4. Итог — короткая структура: что выяснили, чем подтверждено, что осталось неизвестным.",
        "5. Результат сохраняй в память проекта (noteSave), чтобы вернуться к нему в новой сессии.",
        "6. Файлы проекта читай, но не меняй: правки — роль «Разработчик».",
      ].join("\n"),
    },
  ];

  function roleById(id) {
    const key = String(id || "").trim().toLowerCase();
    return AGENT_ROLES.find((r) => r.id === key) || AGENT_ROLES.find((r) => r.id === DEFAULT_ROLE);
  }

  // Роль целиком (для интерфейса и подсказок).
  function rolesList() {
    return AGENT_ROLES.map((r) => ({ id: r.id, icon: r.icon, title: r.title, hint: r.hint, chips: r.chips.slice(), groups: r.groups.slice() }));
  }

  // Что роль даёт прогону: группы с первого раунда, чипы и текст в системный промпт.
  function rolePlan(id) {
    const r = roleById(id);
    return { id: r.id, icon: r.icon, title: r.title, groups: r.groups.slice(), chips: r.chips.slice(), prompt: r.prompt };
  }

  // Роль из чата: строка id, можно мусор — вернётся роль по умолчанию.
  function roleOfChat(chat) {
    return roleById(chat && chat.role).id;
  }

  const BASE_TOOL_NAMES = [
    // файлы и папки
    "createFolder", "readFile", "readFileLines", "writeFile", "editFile", "listDirectory",
    "listFiles", "searchFile", "fileOutline", "readFileStructure", "applyPatch", "undoEdit", "diffView",
    // терминал и фоновые процессы
    "runCommand", "runCommandOutput", "startBackground", "listBackground", "backgroundOutput",
    "sendInput", "stopBackground",
    // git-основы (приложение про репозитории — это обязательный минимум)
    "gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch",
    // диалог, план, память
    "askUser", "todoWrite", "memoryList", "memorySearch", "findTools",
    // web, картинки, ожидание
    "webSearch", "webFetch", "showImage", "analyzeImage", "generateImage", "waitUntil", "checkUrl",
  ];

  const TOOL_GROUPS = [
    {
      id: "git",
      title: "git и GitHub (удалённые операции)",
      keywords: ["запуш", "push", "опублик", "github", "гитхаб", "gitlab", "клонир", "clone", "выгрузи",
        "pull", "стяни", "ветк", "branch", "checkout", "stash", "откати коммит", "revert", "cherry",
        "blame", "кто автор", "перенеси коммит"],
      names: ["gitClone", "gitPush", "gitPublish", "gitInit", "gitPull", "gitRevert", "gitUndoLastCommit",
        "gitCheckout", "gitStash", "gitCherryPick", "gitBlame"],
    },
    {
      id: "browser",
      title: "браузер (сайты, клики, интерфейсы)",
      keywords: ["браузер", "browser", "сайт", "страниц", "вкладк", "зайди", "зайти", "открой ссылк",
        "ссылк", "url", "http", "гугл", "google", "авито", "вконтакте", "вк ", "клик", "нажми",
        "навед", "прокрут", "скролл", "подсказк", "капч", "cookies", "сесси", "chromium", "playwright",
        "авторизуй", "форма вход", "ленив", "виртуальн", "диалог", "пагинац", "все сообщения"],
      names: ["browserOpen", "browserConnect", "browserClose", "browserStatus", "browserClearProfile",
        "browserSnapshot", "browserClick", "browserFill", "browserAct", "browserSelect", "browserPress",
        "browserText", "browserScreenshot", "browserEval", "browserDOM", "browserOverlays", "browserWait",
        "browserScroll", "browserHover", "browserNetwork", "browserReplay", "waitForIdle", "agentGuide"],
    },
    {
      id: "system",
      title: "система Windows (процессы, реестр, установка программ)",
      keywords: ["реестр", "registry", "процесс", "диспетчер задач", "скриншот экрана", "экран",
        "буфер", "clipboard", "скопируй", "вставь", "установи программ", "установк", "installer",
        "winget", "choco", "scoop", "драйвер", "характеристик", "железо", "gpu", "cpu", "оперативн",
        "переменные среды", "админ", "права администратора", "проводник", "ярлык"],
      names: ["getSystemInfo", "listProcesses", "killProcess", "clipboardRead", "clipboardWrite",
        "screenshotDesktop", "registryRead", "registryWrite", "openPath", "wingetSearch", "installExe",
        "installSystemPackage", "checkInstalledProgram", "canExecute", "refreshEnv", "runCommandAsAdmin"],
    },
    {
      id: "project",
      title: "сборка, тесты, зависимости, .env, docker/BД",
      keywords: ["тест", "test", "линт", "lint", "prettier", "формат код", "собери проект", "сборк",
        "docker", "докер", "контейнер", "база данн", "бд", "sql", "запрос к баз", "env", "переменн",
        "api", "http-запрос", "проверь проект", "архив", "распакуй", "зависимост", "установи пакет",
        "библиотек"],
      names: ["runTests", "lintProject", "formatCode", "validateProject", "installPackage",
        "downloadAndExtract", "dbQuery", "dockerBuild", "dockerRun", "dockerExec",
        "apiRequest", "envSet", "envList", "envUnset"],
    },
    {
      id: "files",
      title: "навигация и рефакторинг по коду",
      keywords: ["структур", "outline", "зависимост", "dependenc", "ссылки на", "найди ссылк",
        "рефактор", "переименуй", "переименова", "семантич", "по смыслу", "объясни код", "объясни ошибк"],
      names: ["searchProject", "explainCode", "refactorRename", "explainError", "findReferences",
        "semanticSearch", "getDependencies"],
    },
    {
      id: "terminal",
      title: "оболочки, порты, фоновые команды",
      keywords: ["shell", "оболочк", "терминал", "порт", "фонов", "долгую команд", "таймаут",
        "повтори команд", "скрипт", "bash", "powershell"],
      names: ["shellsStatus", "shellStart", "shellSend", "retryCommand", "timeoutCommand", "runScript",
        "listPorts", "checkPort"],
    },
    {
      id: "notes",
      title: "заметки и точки возврата",
      keywords: ["заметк", "note", "чекпоинт", "checkpoint", "точку возврата", "точка возврата",
        "дневник", "памятк", "откатись"],
      names: ["noteSave", "noteRead", "noteList", "noteDelete", "checkpointSave", "checkpointList",
        "checkpointRollback"],
    },
    {
      id: "tasks",
      title: "дела и сроки (личный список задач)",
      keywords: ["задач", "срок", "дедлайн", "deadline", "просроч", "напомни", "мои дела", "список дел",
        "напомина", "расписан", "календар", "встреч", "план на", "чеклист", "менеджер",
        "что сделать", "успеть", "перенес", "записать дело", "меня дела", "по делам", "на сегодня", "на неделю",
        "мисси", "долгая работа", "долго работать", "работай долго", "по шагам", "не останавливайся", "работай часами"],
      names: ["taskAdd", "taskList", "taskUpdate", "taskDone", "taskDelete",
        "missionStart", "missionStep", "missionStatus", "missionFinish"],
    },
    {
      id: "mail",
      title: "почта агента",
      keywords: ["почт", "письм", "mail", "smtp", "imap", "ящик", "коммерческое предлож", "кп ",
        "входящ", "код подтвержден"],
      names: ["mailSend", "mailList", "mailCode"],
    },
    {
      id: "vault",
      title: "менеджер паролей",
      keywords: ["парол", "vault", "сохрани вход", "вход на сайт", "логин и пароль"],
      names: ["vaultList", "vaultFill"],
    },
    {
      id: "app",
      title: "управление окном приложения",
      keywords: ["окно приложени", "окна приложени", "окном приложени", "интерфейс приложени",
        "своё прилож", "свою прилож", "наше прилож", "мое прилож", "моё прилож", "в приложении",
        "скриншот приложени", "панель приложени", "панели приложени"],
      names: ["appRead", "appClick", "appFill", "appSelect", "appPress", "appWait", "appScreenshot",
        "screenshotCapture"],
    },
    {
      id: "preview",
      title: "превью и запуск проекта",
      keywords: ["превью", "preview", "запусти проект", "запустить проект", "dev-сервер", "dev server",
        "localhost", "открой в браузере"],
      names: ["previewUI", "openUrl"],
    },
    {
      id: "ota",
      title: "самообновление",
      keywords: ["ota", "самосовершен", "обнови себя", "откати обновление", "обновление приложени"],
      names: ["otaStatus", "otaCheck", "otaRollback"],
    },
    {
      id: "cloud",
      title: "Yandex Cloud",
      keywords: ["yandex", "яндекс", "облак", "cloud", "серверлес", "serverless", "бакет", "s3"],
      names: ["ycStatus", "ycList", "ycContainer", "ycCosts", "ycCreate", "ycDelete", "ycDeploy", "ycLogs", "ycInstall"],
    },
  ];

  // Потолок «веса» выбранных схем (в токенах): база + группы должны укладываться сюда.
  // База стоит ~5 900 (36 схем), «браузер» ~5 570, «система» ~2 270, «проект» ~1 950.
  // 15 000 = база + 2–3 группы: тихая задача остаётся ~5.9k вместо 24.5k, а нужные
  // группы почти всегда помещаются. Если потолок всё же срезал группу — main.js
  // пишет об этом в «Консоль» (dropped), а предохранители A/B доберут её при работе.
  // База не режется никогда: без файлов/терминала/git агент не работает.
  const ROUTER_MAX_TOKENS = 15000;

  const _toolByGroupName = new Map(); // имя → id группы (для предохранителя A)
  const _groupNames = new Map();      // id → [имена]
  for (const g of TOOL_GROUPS) {
    _groupNames.set(g.id, g.names.slice());
    for (const n of g.names) _toolByGroupName.set(n, g.id);
  }
  const _groupTokensCache = new Map();
  function groupTokenWeight(id) {
    if (_groupTokensCache.has(id)) return _groupTokensCache.get(id);
    const names = new Set(_groupNames.get(id) || []);
    const w = estimateTokens(JSON.stringify(TOOL_DEFINITIONS.filter((t) => names.has(t.function && t.function.name))));
    _groupTokensCache.set(id, w);
    return w;
  }
  const BASE_TOOL_WEIGHT = estimateTokens(
    JSON.stringify(TOOL_DEFINITIONS.filter((t) => BASE_TOOL_NAMES.indexOf(t.function && t.function.name) !== -1))
  );

  // Какие группы активированы по тексту запроса (счётчик совпавших слов группы).
  function scoreGroups(text) {
    const t = String(text || "").toLowerCase();
    const out = [];
    for (const g of TOOL_GROUPS) {
      let score = 0;
      for (const kw of g.keywords) {
        if (kw && t.indexOf(kw) !== -1) score++;
      }
      out.push({ id: g.id, score: score });
    }
    return out;
  }

  // Предохранитель B: поиск инструмента по смыслу запроса (findTools).
  // Ищем по имени и описанию; слова запроса должны встречаться целиком (частичное
  // совпадение окончаний не требуется — берём и по началу слова, как scoreGroups).
  function searchTools(query, limit) {
    const q = String(query || "").toLowerCase().trim();
    const n = Math.max(1, Math.min(30, Number(limit) || 8));
    if (!q) return [];
    const words = q.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length >= 3);
    const scoreOf = (f) => {
      const name = String(f.name).toLowerCase();
      const desc = String(f.description || "").toLowerCase();
      let sc = 0;
      if (name.indexOf(q.replace(/\s+/g, "")) !== -1) sc += 6;
      for (const w of words) {
        const root = w.length > 5 ? w.slice(0, w.length - 2) : w;
        if (name.indexOf(root) !== -1) sc += 3;
        if (desc.indexOf(root) !== -1) sc += 1;
      }
      return sc;
    };
    // 1) Группы, чьи ключевые слова совпали («запуш» → git, «скриншот» → system).
    //    Это главный сигнал: он ловит русские слова, которых нет в английских именах.
    const groupScore = new Map(scoreGroups(q).filter((s) => s.score > 0).map((s) => [s.id, s.score]));
    const out = [];
    const seen = new Set();
    TOOL_DEFINITIONS.forEach((t, idx) => {
      const f = t && t.function;
      if (!f || !f.name || f.name === "findTools") return;
      const gid = _toolByGroupName.get(f.name) || "";
      const gs = groupScore.get(gid) || 0;
      const sc = scoreOf(f) + gs * 4 + (gs > 0 ? 2 : 0);
      if (sc <= 0) return;
      seen.add(f.name);
      out.push({ name: f.name, group: gid, description: String(f.description || ""), score: sc, idx: idx });
    });
    // 2) Инструменты, найденные в первом проходе, тянут за собой всю свою группу:
    //    модель просит «письмо» — получает весь почтовый набор.
    const groupsHit = new Set(out.filter((x) => x.group).map((x) => x.group));
    TOOL_DEFINITIONS.forEach((t, idx) => {
      const f = t && t.function;
      if (!f || !f.name || seen.has(f.name)) return;
      const gid = _toolByGroupName.get(f.name) || "";
      if (!gid || !groupsHit.has(gid)) return;
      seen.add(f.name);
      // 0.5 — ниже прямых совпадений, но выше нуля: порядок внутри группы остаётся
      // каноническим (idx), поэтому список детерминирован.
      out.push({ name: f.name, group: gid, description: String(f.description || ""), score: 0.5, idx: idx });
    });
    out.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return out.slice(0, n);
  }

  // Текст для роутера: по нему выбираются группы инструментов на задачу.
  // Раньше сюда попадали ТОЛЬКО последние 3 сообщения пользователя — и на «продолжай»
  // (где нет ни одного ключевого слова) группа предыдущей работы выпадала. Тогда набор
  // схем менялся прямо посреди прогона: предохранитель A дотягивал группу на ходу,
  // префикс запроса становился другим — и бесплатный пул провайдера отвечал
  // 503 cache_only_cold («принимаю только запрос с готовым кэшем»). Поэтому роутер
  // обязан видеть саму работу: историю реплик, а не одну последнюю фразу.
  const ROUTER_TASK_MESSAGES = 12;
  const ROUTER_TASK_CHARS = 6000;
  const ROUTER_TASK_PER_MESSAGE = 1200;
  function routerTaskText(messages, opts) {
    const o = opts || {};
    const maxMessages = Math.max(1, Number(o.maxMessages) || ROUTER_TASK_MESSAGES);
    const maxChars = Math.max(200, Number(o.maxChars) || ROUTER_TASK_CHARS);
    const list = Array.isArray(messages) ? messages : [];
    const parts = [];
    // Новейшее — в начало: при обрезке теряется самое старое, а не текущая задача.
    for (let i = list.length - 1; i >= 0 && parts.length < maxMessages; i--) {
      const m = list[i];
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      const c = m.content;
      const txt = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n")
          : "";
      const clean = String(txt || "").replace(/\s+/g, " ").trim();
      if (clean) parts.push(clean.slice(0, ROUTER_TASK_PER_MESSAGE));
    }
    return parts.join("\n").slice(0, maxChars);
  }

  // Отказ пула провайдера: 503 и «холодный» ответ (cache_only_cold у бесплатных пулов)
  // — принимается только запрос с готовым кэшем либо пул перегружен. Наша вина тут
  // косвенная (сменился префикс запроса), и лечится это повтором ТОГО ЖЕ раунда с
  // паузой: история не переписывается, поэтому повтор уже может попасть в кэш.
  const UNAVAILABLE_WAITS = [4000, 10000, 20000];
  const UNAVAILABLE_MAX = UNAVAILABLE_WAITS.length;
  function coldCacheInfo(status, detail, attempt) {
    const st = Number(status) || 0;
    // Ветку берут только 5xx: 429, 402 и 400 разбираются своими правилами.
    if (st && !(st >= 500 && st <= 599)) return null;
    const d = String(detail || "");
    const cold = /cache[ _-]?only/i.test(d);
    const busy = /overloaded|unavailable|capacity|too many requests|temporarily|try again/i.test(d);
    if (!cold && !busy && st !== 503 && st !== 502 && st !== 529) return null;
    const i = Math.max(0, Math.min(UNAVAILABLE_MAX - 1, (Number(attempt) || 1) - 1));
    const waitMs = UNAVAILABLE_WAITS[i];
    const text = cold
      ? "⏳ Пул провайдера принял только запрос с готовым кэшем (cache_only_cold). Жду " +
        Math.round(waitMs / 1000) + " с и повторяю тот же раунд — история не меняется, шанс попасть в кэш растёт."
      : "⏳ Провайдер временно недоступен (" + st + "). Жду " + Math.round(waitMs / 1000) +
        " с и повторяю тот же раунд.";
    return { cold: cold, waitMs: waitMs, text: text };
  }

  // Итоговый набор схем: база + липкие/найденные группы в КАНОНИЧЕСКОМ порядке.
  // opts: { text, sticky (массив id), roleGroups (id групп роли), forceAll, maxTokens }
  // Минимальная история, которую оставляем модели. Служит границей для роутера:
  // сколько токенов окна можно отдать схемам, не оставив диалог без истории.
  // Раньше граница была жёсткой (12 000) и на локальном окне 8–32k съедала весь
  // остаток — группы схем срезались всегда, то есть роли и справочники не работали.
  const MIN_HISTORY_TOKENS = 1500;
  // Потолок веса схем: не больше ROUTER_MAX_TOKENS и не больше того, что реально
  // остаётся от окна после системного промпта и минимальной истории.
  function routerMaxTokens(budget, systemWeight, baseWeight) {
    const b = Math.max(0, Math.round(Number(budget) || 0));
    const sys = Math.max(0, Math.round(Number(systemWeight) || 0));
    const base = Math.max(0, Math.round(Number(baseWeight) || 0));
    const spare = b - sys - MIN_HISTORY_TOKENS;
    return Math.max(base, Math.min(ROUTER_MAX_TOKENS, Math.max(base, spare)));
  }

  function routeTools(opts) {
    const o = opts || {};
    const sticky = new Set(o.sticky || []);
    // Группы активной роли — с первого раунда (стабильный префикс запроса и никаких
    // «дополнений на ходу», из-за которых промахивается кэш провайдера).
    for (const g of o.roleGroups || []) if (g) sticky.add(g);
    if (o.forceAll) {
      return {
        tools: TOOL_DEFINITIONS,
        groups: TOOL_GROUPS.map((g) => g.id),
        dropped: [],
        tokens: estimateTokens(JSON.stringify(TOOL_DEFINITIONS)),
        activated: [],
        all: true,
      };
    }
    const scores = scoreGroups(o.text);
    const byId = new Map(scores.map((s) => [s.id, s.score]));
    const activated = [];
    for (const s of scores) {
      if (s.score > 0) {
        sticky.add(s.id);
        activated.push(s.id);
      }
    }
    const maxTokens = Math.max(BASE_TOOL_WEIGHT, o.maxTokens || ROUTER_MAX_TOKENS);
    // Группы добавляем по силе сигнала; при равном счёте — по порядку реестра
    // (детерминированно). Сортировка влияет только на ПОРЯДОК ДОБАВЛЕНИЯ, а не на
    // порядок схем в запросе — он всегда канонический.
    const wanted = [];
    for (let i = 0; i < TOOL_GROUPS.length; i++) {
      const g = TOOL_GROUPS[i];
      if (!sticky.has(g.id)) continue;
      wanted.push({ id: g.id, score: byId.get(g.id) || 0, i: i, tokens: groupTokenWeight(g.id) });
    }
    wanted.sort((a, b) => b.score - a.score || a.i - b.i);
    let weight = BASE_TOOL_WEIGHT;
    const used = [];
    const dropped = [];
    for (const g of wanted) {
      if (weight + g.tokens <= maxTokens) {
        used.push(g.id);
        weight += g.tokens;
      } else {
        dropped.push(g.id);
      }
    }
    const names = new Set(BASE_TOOL_NAMES);
    for (const id of used) {
      for (const n of _groupNames.get(id) || []) names.add(n);
    }
    return {
      tools: TOOL_DEFINITIONS.filter((t) => names.has(t.function && t.function.name)),
      groups: used,
      dropped: dropped,
      tokens: weight,
      activated: activated,
      all: false,
    };
  }

  // Предохранитель A: имя реального инструмента, которого нет в текущем наборе.
  // Возвращает id группы (или "" — такого инструмента нет вовсе).
  function groupOfTool(name) {
    return _toolByGroupName.get(String(name || "")) || "";
  }

  // Если окно контекста >= 26k — шлём все инструменты; иначе только ядро (~36 вместо 74).
  function selectTools(budget) {
    const b = budget || contextBudget("openai");
    return b >= 26000 ? TOOL_DEFINITIONS : CORE_TOOL_DEFINITIONS;
  }

  // ── Окно модели и параметры Ollama — в src/renderer/provider-transport.js ──
  // modelWindow, ollamaModelInfo, ollamaNumCtx и OLLAMA_KEEP_ALIVE живут там же.

  // ── Компакция старых витков — в src/renderer/context-window.js ──
  // Сжатие истории в памятку берётся оттуда (см. начало раздела «Контекст»).

  // ── Парсеры для инструментов ОС (процессы, реестр, системная информация) ──
  // tasklist /FO CSV /NH (Windows) или ps -eo (macOS/Linux) → [{pid, name, mem, ...}]
  function parseProcessesCsv(csv) {
    const procs = [];
    const lines = String(csv || "").split("\n");
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/"([^"]*)","(\d+)","([^"]*)","([^"]*)","([^"]*)"/);
      if (m) {
        procs.push({ name: m[1], pid: parseInt(m[2], 10), session: m[3], sessionNum: m[4], mem: m[5] });
        continue;
      }
      const p = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (p) procs.push({ pid: parseInt(p[1], 10), name: p[2], cpu: p[3], rss: p[4], args: p[5] });
    }
    return procs;
  }

  // Whitelist реестра: чтение — только SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY; запись — только HKCU.
  function registryPathAllowed(regPath, write) {
    const p = String(regPath || "").trim();
    if (!p) return { ok: false, error: "Укажи путь в реестре (например HKCU\\Software\\MyApp)" };
    if (!/^HK[A-Z0-9]+\\/i.test(p)) {
      return { ok: false, error: "Путь должен начинаться с корня (HKLM\\, HKCU\\, HKCR\\, HKU\\ или HKCC\\)" };
    }
    const up = p.toUpperCase();
    if (write) {
      const ok = up.startsWith("HKCU\\SOFTWARE") || up.startsWith("HKCU\\ENVIRONMENT");
      return ok
        ? { ok: true }
        : { ok: false, error: "Запись разрешена только в HKCU\\Software и HKCU\\Environment. Для HKLM нужны права администратора — используй runCommandAsAdmin с reg add." };
    }
    const first = (up.split("\\")[1] || "").toUpperCase();
    if (["SOFTWARE", "ENVIRONMENT", "SYSTEM", "SECURITY"].includes(first)) return { ok: true };
    return { ok: false, error: "Чтение разрешено только из разделов SOFTWARE, ENVIRONMENT, SYSTEM, SECURITY (например HKLM\\Software, HKCU\\Environment)." };
  }

  // Разбор JSON системной информации от PowerShell → плоский объект.
  function parseSysInfoJson(json) {
    const d = {};
    try {
      const o = JSON.parse(String(json || "{}"));
      if (o && typeof o === "object") {
        if (o.os) d.os = String(o.os);
        if (o.build) d.build = String(o.build);
        if (o.cpu) d.cpu = String(o.cpu);
        if (o.gpu) d.gpu = String(o.gpu);
        if (o.ramGB != null) d.ramGB = Number(o.ramGB);
        if (Array.isArray(o.ips)) d.ips = o.ips.map(String);
        if (Array.isArray(o.disks)) d.disks = o.disks;
      }
    } catch {}
    return d;
  }

  return {
    SYSTEM_PROMPT,
    TOOL_DEFINITIONS,
    G4F_PROVIDERS,
    createThinkingStripper,
    stripThinking,
    normalizeToolName,
    normalizeToolArgs,
    normalizePlanTasks,
    normalizePlanStatus,
    planSummary,
    PLAN_MAX_ITEMS,
    extractToolCallsFromText,
    // транспорт провайдеров
    baseFor,
    isLocalBase,
    buildChatRequest,
    consumeProviderStream,
    toolsAsText,
    withTextTools,
    listModels,
    readApiError,
    friendlyRateLimitError,
    rateLimitInfo,
    createRateLimiter,
    genCallId,
    // контекст
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    windowBudget,
    trimConversation,
    sanitizeToolPairs,
    truncateText,
    selectTools,
    routeTools,
    routerMaxTokens,
    MIN_HISTORY_TOKENS,
    routerTaskText,
    coldCacheInfo,
    UNAVAILABLE_MAX,
    searchTools,
    AGENT_ROLES,
    DEFAULT_ROLE,
    roleById,
    rolesList,
    rolePlan,
    roleOfChat,
    TOOL_GROUPS,
    BASE_TOOL_NAMES,
    groupOfTool,
    ROUTER_MAX_TOKENS,
    PLAN_MODE_TOOL_DEFINITIONS,
    modelWindow,
    ollamaModelInfo,
    ollamaNumCtx,
    probeLocalModel,
    isLocalEndpoint,
    compactRemote,
    createContextManager,
    // веб (общий для Electron main и preview-сервера)
    downloadHtml,
    webSearchDDG,
    webSearch,
    classifyKeyError,
    webFetchPage,
    htmlToText,
    // вспомогательная модель: зрение + генерация изображений
    auxConfig,
    normalizeAuxBase,
    fmtError,
    splitStaticSystem,
    anthropicSystem,
    normalizeUsage,
    describeImageRemote,
    generateImageRemote,
    imageAttempts,
    imageProviderLabel,
    proxiedUrl,
    // инструменты ОС
    parseProcessesCsv,
    registryPathAllowed,
    parseSysInfoJson,
  };
});

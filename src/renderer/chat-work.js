"use strict";

/* ─── Строки действий агента и группа работ текущего ответа ───────────────────
   Вынесено из app.js (этап 3.7, часть 5). Здесь то, что человек видит, ПОКА агент
   работает: компактная строка действия (значок, подпись, цель, состояние и
   подробности по клику) и тонкая группа «Выполняю действия · N», которая живёт над
   полем ввода. Раньше это были громоздкие карточки на каждое действие — теперь
   строки складываются в одну группу, а группа заменяется на каждый новый запуск,
   чтобы не копились десятки блоков.

   Зависимости приходят одним объектом: DOM ($), признак настольного приложения
   (isElectron — в браузере путь в строке действия не открывает файл) и открытие
   файла в просмотрщике панели проекта (openFile). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatWork = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatWorkDeps) {
  const { $, isElectron, openFile } = ChatWorkDeps || {};

  const TOOL_ICON = {
    createFolder: "📁",
    readFile: "📄",
    writeFile: "✏️",
    listDirectory: "📂",
    gitClone: "🧬",
    gitStatus: "📊",
    gitCommit: "💾",
    gitPush: "📤",
    gitPull: "📥",
    gitLog: "📜",
    gitRevert: "↩️",
    readFileLines: "📑",
    editFile: "✂️",
    searchFile: "🔍",
    searchProject: "🔎",
    fileOutline: "🧭",
    listFiles: "🗂️",
    runCommand: "💻",
    webSearch: "🌐",
    webFetch: "🌍",
    browserOpen: "🌐",
    browserFill: "⌨️",
    browserClick: "🖱️",
    browserAct: "⚡",
    browserEval: "🧪",
    browserDOM: "🧩",
    browserOverlays: "🪟",
    browserSelect: "🔽",
    browserPress: "⌨️",
    browserText: "📄",
    browserScreenshot: "📷",
    browserWait: "⏳",
    browserScroll: "↕️",
    browserHover: "👆",
    browserNetwork: "📡",
    browserReplay: "🔁",
    waitForIdle: "⏸",
    agentGuide: "📘",
    browserClose: "🚪",
    browserStatus: "🗔",
    appRead: "👁️",
    appClick: "🖱️",
    appFill: "⌨️",
    appSelect: "🔽",
    appPress: "🔑",
    appWait: "⏳",
    appScreenshot: "📷",
    askUser: "❓",
    startBackground: "🔄",
    listBackground: "📋",
    backgroundOutput: "📜",
    sendInput: "⌨️",
    stopBackground: "⏹️",
    shellStart: "🖥️",
    shellSend: "💬",
    checkUrl: "🌐",
    openUrl: "🔗",
    showImage: "🖼️",
    checkPort: "🔌",
    listPorts: "🔎",
    dockerBuild: "🐳",
    dockerRun: "🐳",
    dockerExec: "🐳",
    installPackage: "📦",
    lintProject: "🧹",
    runTests: "🧪",
    diffView: "🔀",
    previewUI: "🖥️",
    screenshotCapture: "📸",
    analyzeImage: "👁",
    generateImage: "🎨",
    envSet: "🔑",
    envList: "🗝️",
    envUnset: "🗑️",
    readFileStructure: "📇",
    explainCode: "💡",
    undoEdit: "↩️",
    refactorRename: "♻️",
    runCommandOutput: "🔄",
    apiRequest: "🌐",
    runScript: "▶️",
    validateProject: "🛡️",
    gitBranch: "🌿",
    gitCheckout: "🔀",
    findReferences: "🎯",
    gitDiff: "⇄",
    gitUndoLastCommit: "⏪",
    getDependencies: "📦",
    formatCode: "✨",
    dbQuery: "🗄️",
    listProcesses: "📊",
    killProcess: "💥",
    clipboardRead: "📋",
    clipboardWrite: "📝",
    screenshotDesktop: "🪟",
    registryRead: "🗃️",
    registryWrite: "🗃️",
    openPath: "📂",
    wingetSearch: "🧲",
    installExe: "⚙️",
  };

  const TOOL_LABEL = {
    createFolder: "Создание папки",
    readFile: "Чтение файла",
    writeFile: "Изменение файла",
    listDirectory: "Список файлов",
    gitClone: "Клонирование репозитория",
    gitStatus: "git status",
    gitCommit: "Коммит изменений",
    gitPush: "Отправка на GitHub",
    gitPull: "Загрузка с GitHub",
    gitLog: "Журнал коммитов",
    gitRevert: "Откат коммита",
    readFileLines: "Чтение строк файла",
    editFile: "Правка фрагмента",
    searchFile: "Поиск по файлу",
    searchProject: "Поиск по проекту",
    fileOutline: "Карта файла",
    listFiles: "Файлы проекта",
    runCommand: "Команда в терминале",
    webSearch: "Поиск в интернете",
    webFetch: "Чтение страницы",
    browserOpen: "Открыть сайт в браузере",
    browserFill: "Заполнить поле",
    browserClick: "Клик",
    browserAct: "Цепочка действий в браузере",
    browserEval: "JS на странице",
    browserDOM: "Разбор HTML",
    browserOverlays: "Слои и помехи",
    browserSelect: "Выбор из списка",
    browserPress: "Нажатие клавиши",
    browserText: "Текст страницы",
    browserScreenshot: "Скриншот страницы",
    browserWait: "Ожидание элемента",
    browserScroll: "Прокрутка страницы",
    browserHover: "Наведение мыши",
    browserNetwork: "Запросы страницы",
    browserReplay: "Повтор запроса сайта",
    waitForIdle: "Ожидание покоя страницы",
    agentGuide: "Справочник агента",
    browserClose: "Закрыть вкладку",
    browserStatus: "Вкладки браузера",
    appRead: "Чтение окна приложения",
    appClick: "Клик в окне приложения",
    appFill: "Ввод в поле приложения",
    appSelect: "Выбор из списка",
    appPress: "Нажатие клавиши",
    appWait: "Ожидание элемента",
    appScreenshot: "Скриншот окна",
    askUser: "Вопрос пользователю",
    startBackground: "Запуск фонового процесса",
    listBackground: "Список фоновых процессов",
    backgroundOutput: "Вывод процесса",
    sendInput: "Ввод в процесс",
    stopBackground: "Остановка процесса",
    shellStart: "Запуск shell-сессии",
    shellSend: "Команда в shell",
    checkUrl: "Проверка URL",
    openUrl: "Открытие URL",
    showImage: "Показ изображения",
    checkPort: "Проверка порта",
    listPorts: "Список портов",
    dockerBuild: "Сборка Docker-образа",
    dockerRun: "Запуск Docker-контейнера",
    dockerExec: "Команда в Docker-контейнере",
    installPackage: "Установка пакета",
    lintProject: "Проверка кода",
    runTests: "Запуск тестов",
    diffView: "Сравнение файлов",
    previewUI: "Предпросмотр сайта",
    screenshotCapture: "Скриншот страницы",
    analyzeImage: "Анализ изображения",
    generateImage: "Генерация изображения",
    envSet: "Задать переменную окружения",
    envList: "Список переменных окружения",
    envUnset: "Удалить переменную окружения",
    readFileStructure: "Структура файла",
    explainCode: "Объяснение кода",
    undoEdit: "Откат правки файла",
    refactorRename: "Переименование в проекте",
    runCommandOutput: "Команда с повтором",
    apiRequest: "HTTP-запрос",
    runScript: "Скрипт из package.json",
    validateProject: "Проверка проекта",
    gitBranch: "Ветки git",
    gitCheckout: "Переключение ветки",
    findReferences: "Ссылки на символ",
    gitDiff: "Сравнение веток",
    gitUndoLastCommit: "Отмена коммита (soft)",
    getDependencies: "Зависимости проекта",
    formatCode: "Форматирование кода",
    dbQuery: "SQL-запрос к БД",
    listProcesses: "Список процессов",
    killProcess: "Завершение процесса",
    clipboardRead: "Чтение буфера обмена",
    clipboardWrite: "Копирование в буфер",
    screenshotDesktop: "Скриншот экрана",
    registryRead: "Чтение реестра",
    registryWrite: "Запись в реестр",
    openPath: "Открытие файла",
    wingetSearch: "Поиск в winget",
    installExe: "Установка .exe",
  };

  function toolTargetOf(t) {
    // У сообщения поле называется toolArgs, у события вызова — args. Раньше здесь
    // читалось только args, поэтому цель действия и ссылка «открыть файл» в строке
    // не появлялись вообще; поймал это поведенческий тест модуля.
    const a = (t && (t.toolArgs || t.args)) || {};
    if (a.path) return String(a.path);
    if (a.url) return String(a.url);
    if (a.commit) return "commit " + String(a.commit);
    if (a.message) return "«" + String(a.message).slice(0, 50) + "»";
    if (a.query) return String(a.query).slice(0, 80);
    if (a.command) return String(a.command).slice(0, 60);
    if (a.question) return String(a.question).slice(0, 60);
    return "";
  }

  function toolArgsPreview(a) {
    const obj = {};
    for (const [k, v] of Object.entries(a || {})) {
      if (typeof v === "string" && v.length > 220) obj[k] = v.slice(0, 220) + "… (" + v.length + " симв.)";
      else obj[k] = v;
    }
    return JSON.stringify(obj, null, 1);
  }

  // Компактная строка действия агента (как во Freebuff/Replit):
  // [✓ файл/действие · Готово ▾] — клик раскрывает подробности
  function buildToolEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg tool";
    const body = document.createElement("div");
    const isErr = m.toolOk === false;
    const isDone = !m.pending;
    body.className = "tool-body" + (isErr ? " err" : isDone ? " done" : " busy");
    const row = document.createElement("div");
    row.className = "tool-row";

    const state = document.createElement("span");
    state.className = "tool-state";
    state.textContent = isErr ? "✕" : isDone ? "✓" : "●";

    const ic = document.createElement("span");
    ic.className = "tool-ic";
    ic.textContent = TOOL_ICON[m.toolName] || "⚙️";

    const label = document.createElement("span");
    label.className = "tool-label";
    label.textContent = TOOL_LABEL[m.toolName] || m.toolName;

    const target = toolTargetOf(m);
    const tEl = document.createElement("span");
    tEl.className = "tool-target";
    tEl.textContent = target;
    tEl.title = target;
    // Файловые инструменты: клик по пути открывает файл в просмотрщике
    const FILE_TOOLS = ["readFile", "writeFile", "editFile", "readFileLines", "searchFile", "showImage"];
    if (target && isElectron && FILE_TOOLS.includes(m.toolName)) {
      tEl.classList.add("tool-target-link");
      tEl.title = "Открыть файл: " + target + " (клик)";
      tEl.onclick = (e) => {
        e.stopPropagation();
        openFile(target);
      };
    }

    const status = document.createElement("span");
    status.className = "tool-status " + (isErr ? "err" : isDone ? "ok" : "pending");
    status.textContent = isErr ? "Ошибка" : isDone ? "Готово" : "Выполняется";

    const chev = document.createElement("span");
    chev.className = "tool-chev";
    chev.textContent = "▾";

    row.appendChild(state);
    row.appendChild(ic);
    row.appendChild(label);
    if (target) row.appendChild(tEl);
    row.appendChild(status);
    row.appendChild(chev);

    const details = document.createElement("div");
    details.className = "tool-details";
    if (m.toolArgs && Object.keys(m.toolArgs).length) {
      const args = document.createElement("div");
      args.className = "tool-args";
      args.textContent = toolArgsPreview(m.toolArgs);
      details.appendChild(args);
    }
    if (m.toolResult) {
      const res = document.createElement("div");
      res.className = "tool-result";
      res.textContent = m.toolResult;
      details.appendChild(res);
    }

    body.appendChild(row);
    body.appendChild(details);
    body.title = "Клик — показать/скрыть подробности";
    body.onclick = (e) => {
      if (e.target.closest && !e.target.closest("a")) body.classList.toggle("open");
    };
    wrap.appendChild(body);
    return wrap;
  }

  // ─── Ход работы: компактная группа строк действий текущего ответа ───
  // Строки действий (tool-сообщения) складываются в work.body, а над ними —
  // тонкий заголовок «Выполняю действия · N». Без громоздких карточек.
  let turnPlan = null; // { body, head, badge, count }

  function ensureWorkGroup() {
    if (turnPlan) return turnPlan;
    const wrap = document.createElement("div");
    wrap.className = "work-wrap";
    const body = document.createElement("div");
    body.className = "work-group";
    wrap.appendChild(body);
    // Живая панель действий агента — над полем ввода. Новый запуск = новая панель
    // (предыдущая заменяется, чтобы не копились десятки блоков).
    const panel = $("work-panel");
    if (panel) {
      panel.innerHTML = "";
      panel.appendChild(wrap);
    } else {
      // Fallback (старый layout): как раньше, в конец ленты сообщений.
      $("messages").appendChild(wrap);
    }
    const head = document.createElement("div");
    head.className = "work-head";
    const dot = document.createElement("span");
    dot.className = "work-dot";
    const txt = document.createElement("span");
    txt.className = "work-title";
    txt.textContent = "Выполняю действия";
    const badge = document.createElement("span");
    badge.className = "work-count";
    badge.textContent = "0";
    const chev = document.createElement("span");
    chev.className = "work-chev";
    chev.textContent = "▾";
    head.appendChild(dot);
    head.appendChild(txt);
    head.appendChild(badge);
    head.appendChild(chev);
    head.title = "Показать/скрыть ход работ";
    head.onclick = (e) => {
      e.stopPropagation();
      // Сворачивается/разворачивается по клику и во время работы, и после.
      body.classList.toggle("expanded");
      updatePlanTitle(turnPlan);
    };
    body.appendChild(head);
    turnPlan = { body, head, txt, badge, count: 0 };
    return turnPlan;
  }

  function planAdd(ev) {
    const plan = ensureWorkGroup();
    plan.count += 1;
    plan.badge.textContent = String(plan.count);
    plan.label = (ev && TOOL_LABEL[ev.name]) || null;
    updatePlanTitle(plan);
  }

  function planSet() {
    // отдельного списка нет — строки действий обновляются в tool_result
  }

  function updatePlanTitle(plan) {
    const t = plan && plan.txt;
    if (!t) return;
    const done = plan.body.classList.contains("finished");
    const open = plan.body.classList.contains("expanded");
    if (done) t.textContent = "Действия выполнены";
    else if (!open && plan.label) t.textContent = "Выполняю: " + plan.label;
    else if (!open) t.textContent = "Выполняю действия";
    else t.textContent = "Выполняю действия";
  }

  // ─── Точки входа для оболочки (новое при выносе) ───
  // Строка действия встаёт в группу текущего ответа; после ответа группа закрывается
  // и обнуляется — следующая работа начинается с чистой панели.
  function addRow(el) {
    const plan = ensureWorkGroup();
    if (el && plan.body) plan.body.appendChild(el);
    return plan;
  }

  function finishGroup() {
    const group = turnPlan && turnPlan.body;
    if (!group) return false;
    group.classList.add("finished");
    updatePlanTitle(turnPlan);
    return true;
  }

  function resetGroup() {
    turnPlan = null;
  }

  return {
    // Значок и подпись инструмента: тем же словарём пользуется проверка ниже.
    toolIcon: (name) => TOOL_ICON[name] || "⚙️",
    toolLabel: (name) => TOOL_LABEL[name] || String(name == null ? "" : name),
    TOOL_ICON: TOOL_ICON,
    TOOL_LABEL: TOOL_LABEL,
    toolTargetOf: toolTargetOf,
    toolArgsPreview: toolArgsPreview,
    buildToolEl: buildToolEl,
    ensureWorkGroup: ensureWorkGroup,
    addRow: addRow,
    planAdd: planAdd,
    planSet: planSet,
    updatePlanTitle: updatePlanTitle,
    finishGroup: finishGroup,
    resetGroup: resetGroup,
  };
});

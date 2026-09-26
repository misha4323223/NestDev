"use strict";
(function () {
  const AgentCore = window.AgentCore;
  const $ = (id) => document.getElementById(id);
  const api = window.api || null; // null → браузер (веб-превью)
  const isElectron = !!api;

  // provider: "ollama" | "openai" (OpenAI-совместимые) | "anthropic" (Claude)
  const DEFAULTS = {
    provider: "ollama",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "",
    openaiUrl: "https://api.groq.com/openai/v1",
    openaiApiKey: "",
    openaiModel: "",
    openaiProject: "", // Yandex AI Studio: ID каталога (OpenAI-Project)
    anthropicUrl: "https://api.anthropic.com",
    anthropicApiKey: "",
    anthropicModel: "",
    model: "", // зеркало модели активного провайдера (для main-процесса / отправки)
    workingDir: "",
    previewUrl: "http://localhost:5000",
    agentEnv: {}, // секреты/переменные окружения: подставляются в команды агента, терминал, git, docker
    agentEnv: {}, // подставляются в команды агента (кому именно — решает выдача ниже)
    // Кому выдана каждая переменная: { ИМЯ: ["terminal", "git"] }. Нет записи — всем
    // командам агента (как раньше), пустой список — никому.
    agentEnvScopes: {},
    githubToken: "",
    githubClientId: "",
    githubLogin: "",
    githubAvatarUrl: "",
    projects: [], // до 10 проектов: { id, name, dir, createdAt, lastOpened }
    activeProjectId: "",
    openaiProfiles: [], // сохранённые OpenAI-совместимые подключения: { id, name, url, apiKey, model, project }
    openaiActiveProfile: "", // id активного подключения
    autoSwitchProfiles: false, // при ошибке ключа/баланса/лимита — авто-переключение
    sendAllTools: false, // предохранитель C: слать все схемы инструментов (медленнее, но надёжнее)
    longWork: true, // долгая работа миссиями (файлы .agent/, батчи, авто-продолжение)
    longWorkHours: 8, // часов на одну миссию — как рабочий день
    longWorkRounds: 600, // раундов на миссию
    longWorkAutoContinue: 6, // авто-продолжений после сбоя
    noToolsModel: false, // модель без нативных вызовов: схемы не шлём, инструменты — JSON-блоком
    // Модели, про которые провайдер САМ сказал, что поля рассуждений не знает:
    // «провайдер|модель» → true. По ним плашка 🧠 не показывается вовсе — иначе
    // каждый запуск тратил бы раунд на ту же ошибку (пишет reasoning.js).
    reasoningUnsupported: {},
  };

  // Пресеты для OpenAI-совместимых API (ключ/модель хранятся отдельно по каждому пресету? нет — единый URL+ключ).
  const PRESETS = {
    deepseek: { url: "https://api.deepseek.com/v1" },
    openai: { url: "https://api.openai.com/v1" },
    groq: { url: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
    cerebras: { url: "https://api.cerebras.ai/v1", model: "qwen-3-235b-a22b-instruct-2507" },
    ollamacloud: { url: "https://ollama.com/v1", model: "gpt-oss:120b" },
    openrouter: { url: "https://openrouter.ai/api/v1" },
    nvidia: { url: "https://integrate.api.nvidia.com/v1" },
    mistral: { url: "https://api.mistral.ai/v1", model: "devstral-2-2512" },
    yandex: { url: "https://ai.api.cloud.yandex.net/v1" },
    g4f: { url: "http://localhost:1337/v1" },
    custom: null,
  };
  const PRESET_LABEL = {
    deepseek: "DeepSeek",
    openai: "OpenAI",
    groq: "Groq",
    cerebras: "Cerebras",
    ollamacloud: "Ollama Cloud",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA NIM",
    mistral: "Mistral Devstral",
    yandex: "Yandex AI Studio",
    g4f: "G4F",
    custom: "Свой",
  };

  // Провайдеры G4F — единый реестр живёт в agent-core.js (его же использует транспорт
  // buildChatRequest для маршрута «Провайдер:модель»).
  const G4F_PROVIDERS = (AgentCore && AgentCore.G4F_PROVIDERS) || [];

  // Ключи настроек по провайдеру (поле URL / API-ключ / модель)
  const MODEL_KEY = { ollama: "ollamaModel", openai: "openaiModel", anthropic: "anthropicModel" };
  const URL_KEY = { ollama: "ollamaUrl", openai: "openaiUrl", anthropic: "anthropicUrl" };
  const KEY_FIELD = { openai: "openaiApiKey", anthropic: "anthropicApiKey" };
  const MODEL_INPUT = { ollama: "s-ollama-model", openai: "s-openai-model", anthropic: "s-anth-model" };
  const URL_INPUT = { ollama: "s-ollama-url", openai: "s-openai-url", anthropic: "s-anth-url" };
  const KEY_INPUT = { openai: "s-openai-key", anthropic: "s-anth-key" };
  const KEY_TOGGLE = { openai: "btn-toggle-key", anthropic: "btn-toggle-anth-key" };
  const REFRESH_INPUT = { ollama: "btn-refresh-ollama-models", openai: "btn-refresh-models", anthropic: "btn-refresh-anth-models" };

  let settings = { ...DEFAULTS };
  let chatsData = { chats: [], activeId: null };
  let streaming = false;
  let session = null; // { chatId, assistantId, segmentIds: [] }
  let webAbort = null;
  let planToggleOn = false; // «Режим плана» — сначала план, потом выполнение
  let lastUndoCount = 0; // сколько файлов можно откатить после последнего ответа агента
  let pendingImage = null; // dataURL скриншота, прикреплённого к следующему сообщению
  // Текстовые файлы к следующему сообщению: [{ name, text }]. Картинка уходит
  // отдельной частью (image_url), а файл вкладывается текстом — у моделей без
  // зрения другого способа увидеть содержимое файла нет.
  let pendingFiles = [];
  const FILE_TEXT_LIMIT = 60000; // один файл целиком в запрос не годится — 60 КБ
  const FILES_MAX = 8; // больше восьми вложений раздувают запрос без пользы
  let cachedModels = {}; // кэш списков моделей по провайдеру (для быстрого переключения в шапке)

  // Панель вложений показывает то, что реально приложено: картинку — миниатюрой,
  // файлы — списком имён. Без этого было видно только «прикреплено» без деталей,
  // а при одном файле (без картинки) миниатюра рисовала пустую рамку.
  function refreshAttachBar() {
    const bar = $("attach-bar");
    const thumb = $("attach-thumb");
    if (!bar || !thumb) return;
    const nameEl = $("attach-name");
    if (pendingImage) {
      thumb.src = pendingImage;
      thumb.classList.remove("hidden");
    } else {
      thumb.removeAttribute("src");
      thumb.classList.add("hidden");
    }
    if (nameEl) {
      const parts = [];
      if (pendingImage) parts.push("скриншот");
      for (const f of pendingFiles) parts.push(f.name);
      nameEl.textContent = parts.length ? parts.join(", ") + " — уйдёт с сообщением" : "";
    }
    bar.classList.toggle("hidden", !pendingImage && !pendingFiles.length);
  }

  // Один файл из поля выбора или из буфера обмена: картинка — миниатюрой,
  // остальное — текстом (двоичное содержимое в чат не имеет смысла).
  function attachFile(file) {
    if (!file) return;
    const name = file.name || "файл";
    if (/^image\//.test(file.type || "")) {
      const reader = new FileReader();
      reader.onload = () => {
        pendingImage = String(reader.result || "");
        refreshAttachBar();
      };
      reader.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let text = String(reader.result || "");
      // Двоичный файл, переодетый в текстовое имя (например .log с нулями):
      // в запрос такое отправлять нельзя — получается мусор в контексте.
      if (text.indexOf("\u0000") !== -1) {
        toast("Файл «" + name + "» — двоичный, вложить текстом не могу");
        return;
      }
      if (text.length > FILE_TEXT_LIMIT) {
        text = text.slice(0, FILE_TEXT_LIMIT) + "\n… (файл обрезан: показано " + Math.round(FILE_TEXT_LIMIT / 1024) + " КБ из " + Math.round((file.size || 0) / 1024) + " КБ)";
      }
      pendingFiles.push({ name: name, text: text });
      if (pendingFiles.length > FILES_MAX) pendingFiles = pendingFiles.slice(-FILES_MAX);
      refreshAttachBar();
    };
    reader.readAsText(file);
  }

  // Вставка из буфера (Ctrl+V). Картинка приходит элементом clipboard, а файл — в
  // clipboardData.files (после «Копировать файл» в проводнике). Раньше читался только
  // первый путь, и вставленный файл молча пропадал: подсветки не было, вложения нет.
  function onInputPaste(e) {
    const dt = e.clipboardData;
    if (!dt) return;
    let taken = false;
    for (const f of Array.from(dt.files || [])) {
      attachFile(f);
      taken = true;
    }
    const items = dt.items || [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        attachFile(it.getAsFile && it.getAsFile());
        return;
      }
    }
    if (taken) e.preventDefault(); // файл из буфера не вставляем текстом в поле
  }
  function hideAttachBar() {
    pendingImage = null;
    pendingFiles = [];
    refreshAttachBar();
  }
  let currentPreset = "deepseek";
  const msgEls = new Map();

  // ─── Выбор провайдера G4F (аккордеон в настройках) — код в src/renderer/g4f-panel.js ───
  // Сборка на прежнем месте куска. Панели (настройки, правая, проект, запуск) объявлены
  // НИЖЕ, поэтому переданы отложенными стрелками; пресет читается живьём.
  const G4fPanel = window.G4fPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    G4F_PROVIDERS: G4F_PROVIDERS,
    URL_INPUT: URL_INPUT,
    getPreset: () => currentPreset,
    getSettingsPanel: () => SettingsPanel,
    getSidePanel: () => SidePanel,
    getProjectPanel: () => ProjectPanel,
    getDevRun: () => DevRun,
  });
  // Элементы настроек уже в DOM (скрипты в конце body) — вешаем события сразу
  G4fPanel.wireG4fProviderPicker();

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Миграция старых настроек (provider:"external", externalUrl, apiKey) в новую схему
  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    if (s.provider === "external") s.provider = "openai";
    if (raw && raw.openaiUrl === undefined && raw.externalUrl !== undefined) s.openaiUrl = raw.externalUrl;
    if (raw && raw.openaiApiKey === undefined && raw.apiKey !== undefined) s.openaiApiKey = raw.apiKey;
    // Миграция на сохранённые OpenAI-подключения: единственный URL+ключ → первый профиль.
    if (!raw || !Array.isArray(raw.openaiProfiles)) {
      const profUrl = String(s.openaiUrl || "").trim();
      if (profUrl) {
        s.openaiProfiles = [{ id: "p-main", name: OpenaiProfiles.profileNameFromUrl(profUrl), url: profUrl, apiKey: s.openaiApiKey || "", model: s.openaiModel || "", project: s.openaiProject || "" }];
        s.openaiActiveProfile = "p-main";
      } else {
        s.openaiProfiles = [];
        s.openaiActiveProfile = "";
      }
    }
    return s;
  }

  // ─────────────── Хранилище ───────────────
  // Код живёт в src/renderer/chat-store.js. Модуль собирается на прежнем месте куска.
  // Значениями переданы только неизменные (признак Electron, мост api, нормализатор
  // настроек и ядро), а переписываемое состояние — живыми функциями: настройки и
  // история чатов переприсваиваются ЦЕЛИКОМ (загрузка с диска и синхронизация с
  // другого устройства), а предел истории планов объявлен НИЖЕ точки сбора.
  const ChatStore = window.ChatStore({
    isElectron: isElectron,
    api: api,
    AgentCore: AgentCore,
    normalize: normalize,
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    getChatsData: () => chatsData,
    setChatsData: (c) => { chatsData = c; },
    getPlanArchiveLimit: () => PLAN_ARCHIVE_LIMIT,
    getSession: () => session,
    setRemoteRunNotified: (v) => { remoteRunNotified = v; },
    renderSidebar: renderSidebar,
    renderMessages: renderMessages,
    toast: toast,
    getProjectPanel: () => ProjectPanel,
    // После загрузки настроек спрашиваем про папки работы агента — но только при
    // первом запуске и один раз (см. settings-panel.js, maybeAskFolders).
    // Раскладку правой рабочей области восстанавливаем здесь же (см. restoreSidePanel
    // в side-panel.js): открытие «превью» пишет настройки ЦЕЛИКОМ, и до их чтения оно
    // затирало бы умолчаниями настоящие — модель «сбрасывалась» сразу после запуска.
    afterLoad: () => { if (SettingsPanel && SettingsPanel.maybeAskFolders) SettingsPanel.maybeAskFolders(); if (SidePanel && SidePanel.restoreSidePanel) SidePanel.restoreSidePanel(); },
  });
  // Сброс на диск при закрытии/сворачивании окна — на прежнем месте куска.
  ChatStore.wire();

  // ─────────────── Чат ───────────────
  function getActiveChat() {
    return chatsData.chats.find((c) => c.id === chatsData.activeId) || null;
  }
  function createChat(opts) {
    opts = opts || {};
    const c = { id: uid(), title: opts.title || "Новый чат", projectId: settings.activeProjectId || "", createdAt: Date.now(), messages: [] };
    if (opts.contextMsg) c.messages.push({ id: uid(), role: "system", content: opts.contextMsg, createdAt: Date.now() });
    chatsData.chats.unshift(c);
    chatsData.activeId = c.id;
    renderSidebar();
    renderMessages();
    ChatStore.persistChats();
    return c;
  }
  // Найти чат, привязанный к проекту, или создать новый (с именем проекта).
  function ensureProjectChat(projectId, projectName) {
    if (!projectId) return;
    let chat = chatsData.chats.find((c) => c.projectId === projectId);
    if (!chat) {
      chat = createChat();
      chat.projectId = projectId;
      chat.title = projectName || "Новый чат";
      ChatStore.persistChats();
      renderSidebar();
      renderMessages();
    } else {
      selectChat(chat.id);
    }
    return chat;
  }
  function chatTitle(c) {
    if (c && c.auto) return "Автозадачи"; // чат автозадач всегда зовётся одинаково
    const firstUser = c.messages.find((m) => m.role === "user");
    if (firstUser) {
      const t = ChatRender.msgText(firstUser.content) || "📷 Изображение";
      return t.slice(0, 42) + (t.length > 42 ? "…" : "");
    }
    // Чат, привязанный к проекту, без сообщений — показываем имя проекта.
    if (c.title && c.title !== "Новый чат") return c.title;
    const d = new Date(c.createdAt);
    const pad = (n) => String(n).padStart(2, "0");
    return "Чат " + pad(d.getDate()) + "." + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function deleteChat(id) {
    if (streaming) return;
    chatsData.chats = chatsData.chats.filter((c) => c.id !== id);
    if (chatsData.activeId === id) chatsData.activeId = chatsData.chats[0] ? chatsData.chats[0].id : null;
    renderSidebar();
    renderMessages();
    ChatStore.persistChats();
  }
  function selectChat(id) {
    if (streaming) return;
    const chat = chatsData.chats.find((c) => c.id === id);
    // Чат привязан к другому проекту — переключаемся на этот проект,
    // чтобы агент работал в правильной рабочей директории и с чистым контекстом.
    if (chat && chat.projectId && isElectron && chat.projectId !== settings.activeProjectId) {
      ProjectPanel.switchProject(chat.projectId);
      return;
    }
    chatsData.activeId = id;
    renderSidebar();
    renderMessages();
    ChatStore.persistChats();
  }

  // ─── План работ (todoWrite): чеклист, разбор плана из текста, галочки ───
  // Код живёт в src/renderer/plan-panel.js. Модуль собирается на прежнем месте куска.
  // Значения передаются напрямую ($, document, AgentCore и вызовы оболочки), а
  // переписываемое состояние — живыми функциями: признак генерации (streaming) и
  // сегменты ответа (они объявлены НИЖЕ точки сбора).
  // Сколько прошлых планов хранит чат: тем же числом ограничивается история при
  // загрузке чатов с диска (sanitizeChats) — один источник правды на оба места.
  const PLAN_ARCHIVE_LIMIT = 5;
  // ─── Отправка: ход агента, обычная отправка и досылка прерванного ответа ───
  // Код живёт в src/renderer/chat-send.js. Сборка стоит ВЫШЕ прежнего места куска:
  // панель плана (ниже) берёт `sendMessage` значением — её кнопка «Выполнить план»
  // отправляет запрос тем же путём. Живые доступы — функциями: признак прогона,
  // сессия, прерывание браузера, режим плана, вложение и счётчик отката меняются
  // по ходу хода, настройки и история чатов переписываются целиком. Что собирается
  // НИЖЕ (лента, панель настроек, разбор событий агента, прогон ответа, автозадачи
  // и веб-режим) — стрелками.
  // ─── Рассуждения модели (Reasoning effort) — код в src/renderer/reasoning.js ───
  // Плашка рядом с полем ввода: Выкл / Low / High / Max. Выбор лежит в настройках
  // и уезжает вместе с сообщением (opts.reasoning); в шкалу провайдера его переводит
  // транспорт. Собирается ДО отправки: chat-send спрашивает уровень на каждом ходу.
  const Reasoning = window.Reasoning({
    $: $,
    toast: toast,
    getSettings: () => settings,
    persistSettings: () => ChatStore.persistSettings(),
    // Умеет ли модель рассуждать, решает транспорт (рядом со шкалой провайдеров) —
    // по имени модели, без запроса, поэтому ответ одинаков в окне, на телефоне и в
    // браузере. Спрашиваем у ЯДРА, а не у window.ProviderTransport: в окне тот —
    // ФАБРИКА (объект собирает agent-core.js), и свойство у неё дало бы молчаливое
    // «не понять» у всех моделей сразу.
    support: (provider, model) => AgentCore.reasoningSupport(provider, model),
  });
  Reasoning.wire();

  const ChatSend = window.ChatSend({
    $: $,
    isElectron: isElectron,
    api: api,
    uid: uid,
    toast: toast,
    renderSidebar: renderSidebar,
    buildMessageEl: buildMessageEl,
    autoResize: autoResize,
    hideAttachBar: hideAttachBar,
    selectChat: selectChat,
    getActiveChat: getActiveChat,
    createChat: createChat,
    getSettings: () => settings,
    getChatsData: () => chatsData,
    getStreaming: () => streaming,
    getPlanToggleOn: () => planToggleOn,
    setPlanToggleOn: (v) => { planToggleOn = v; },
    getPendingImage: () => pendingImage,
    getPendingFiles: () => pendingFiles,
    getReasoning: () => Reasoning.get(),
    setLastUndoCount: (v) => { lastUndoCount = v; },
    setSession: (v) => { session = v; },
    getWebAbort: () => webAbort,
    setWebAbort: (v) => { webAbort = v; },
    getChatFeed: () => ChatFeed,
    getPlanPanel: () => PlanPanel,
    getSettingsPanel: () => SettingsPanel,
    getChatEvents: () => ChatEvents,
    getChatRun: () => ChatRun,
    getAutoTasks: () => AutoTasks,
    getWebChat: () => WebChat,
    ChatStore: ChatStore,
  });

  const PlanPanel = window.PlanPanel({
    $: $,
    document: document,
    getActiveChat: getActiveChat,
    getStreaming: () => streaming,
    getChatSegments: () => ChatSegments,
    sendMessage: ChatSend.sendMessage,
    autoResize: autoResize,
    persistChatsSoon: ChatStore.persistChatsSoon,
    toast: toast,
    AgentCore: AgentCore,
    planArchiveLimit: PLAN_ARCHIVE_LIMIT,
  });
  // ─────────── /План работ ───────────
  // Синхронизация истории между устройствами (событие chats:reload) живёт
  // в хранилище — см. `ChatStore.reloadChatsFromDisk()`. Здесь остаётся только
  // признак «про чужой прогон уже сказали»: его читает и пишет разбор событий агента.
  let remoteRunNotified = false;

  // ─────────────── Рендер ───────────────
  function renderSidebar() {
    const list = $("chat-list");
    list.innerHTML = "";
    for (const c of chatsData.chats) {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === chatsData.activeId ? " active" : "");
      const title = document.createElement("div");
      title.className = "chat-title";
      title.textContent = chatTitle(c);
      // Подпись проекта, если чат привязан к проекту.
      if (c.projectId) {
        const pr = (settings.projects || []).find((p) => p.id === c.projectId);
        if (pr) {
          const tag = document.createElement("div");
          tag.className = "chat-project";
          tag.textContent = "📁 " + pr.name;
          tag.title = pr.dir || "";
          title.appendChild(tag);
        }
      }
      const del = document.createElement("button");
      del.className = "chat-del";
      del.textContent = "🗑";
      del.title = "Удалить чат";
      del.onclick = (e) => {
        e.stopPropagation();
        deleteChat(c.id);
      };
      item.appendChild(title);
      item.appendChild(del);
      item.onclick = () => selectChat(c.id);
      list.appendChild(item);
    }
  }

  function renderMessages() {
    ChatRun.maybeRestoreUndoButton();
    // Смена чата и загрузка истории: кнопка «Продолжить» относится к прогону
    // прошлого чата — в новом она была бы чужой.
    ChatRun.hideResume();
    updateModelNeeded();
    PlanPanel.renderPlanPanel();
    const wrap = $("messages");
    wrap.innerHTML = "";
    msgEls.clear();
    const chat = getActiveChat();
    const welcome = $("welcome");
    if (!chat || !chat.messages.length) {
      $("chat-title").textContent = chat ? chatTitle(chat) : "Новый чат";
      welcome.classList.remove("hidden");
      // Сразу даём печатать: фокус в композер, чтобы не приходилось сначала
      // жать кнопку-карточку (раньше оверлей перехватывал клики по полю ввода).
      if (!streaming) {
        requestAnimationFrame(() => {
          const inp = $("input");
          // Фокус отдаём только «пустому» экрану: если человек уже печатает в
          // другом поле (дело, настройки, консоль), перерисовка ленты не имеет
          // права выдирать у него курсор.
          const cur = document.activeElement;
          const busy = !!cur && cur !== document.body && cur !== document.documentElement;
          if (inp && !busy && cur !== inp) inp.focus();
        });
      }
      return;
    }
    welcome.classList.add("hidden");
    $("chat-title").textContent = chatTitle(chat);
    for (const m of chat.messages) wrap.appendChild(buildMessageEl(m));
    // Именно pinBottom («вниз без кнопки»): перерисовка не имеет права трогать
    // элементы вне ленты, а jumpToBottom дёргает кнопку «↓».
    ChatFeed.pinBottom(); // при переключении чата всегда прыгаем вниз
  }

  function buildMessageEl(m) {
    let el;
    if (m.role === "tool") el = ChatWork.buildToolEl(m);
    else el = ChatRender.buildBubbleEl(m);
    msgEls.set(m.id, el);
    return el;
  }

  // ─── Отрисовка сообщения (текст, вложения, кнопки) — код в src/renderer/chat-render.js ───

  // ─── Размышления модели: блок над ответом — код в src/renderer/chat-thinking.js ───
  // Своих зависимостей у модуля нет: он работает с элементом сообщения, который ему дали.
  const ChatThinking = window.ChatThinking();

  // ─── Строки действий агента и группа работ — код в src/renderer/chat-work.js ───
  const ChatWork = window.ChatWork({
    $: $,
    isElectron: isElectron,
    openFile: openToolFile,
  });

  // Открывает файл из строки действия агента в просмотрщике (панель проекта).
  function openToolFile(target) {
    const t = String(target || "").trim();
    if (!t) return;
    const isAbs = /^[a-zA-Z]:[\\/]|^[\\/]/.test(t);
    const base = ProjectPanel.projectDir().replace(/[\\/]+$/, "");
    const full = isAbs ? t : (base ? base + "/" + t : t);
    ProjectPanel.viewFile(full);
  }

  function refreshMessage(m) {
    const old = msgEls.get(m.id);
    if (!old) return;
    const rebuilt = buildMessageEl(m);
    if (old.classList && old.classList.contains("in-work")) rebuilt.classList.add("in-work");
    old.parentNode.insertBefore(rebuilt, old);
    old.parentNode.removeChild(old);
    ChatFeed.scrollBottom();
  }

  // ─── Лента: прокрутка и очередь кадра при стриме — код в src/renderer/chat-feed.js ───
  // msgHtml — стрелкой: отрисовка сообщения (chat-render.js) собирается НИЖЕ.
  const ChatFeed = window.ChatFeed({
    $: $,
    msgEls: msgEls,
    msgHtml: (c) => ChatRender.msgHtml(c),
  });

  // ─── Автозадачи (планировщик дел) — код в src/renderer/auto-tasks.js ───
  // Модуль собирается на прежнем месте куска. Живые значения — функциями: настройки,
  // признак идущего прогона и история чатов переписываются целиком. Дела с миссией
  // собираются правой панелью НИЖЕ, поэтому внутрь идёт отложенная стрелка.
  const AutoTasks = window.AutoTasks({
    isElectron: isElectron,
    api: api,
    toast: toast,
    uid: uid,
    createChat: createChat,
    persistChats: ChatStore.persistChats,
    renderSidebar: renderSidebar,
    selectChat: selectChat,
    runTurn: ChatSend.runTurn,
    getSettings: () => settings,
    getStreaming: () => streaming,
    getChatsData: () => chatsData,
    getTasksMission: () => TasksMission,
  });

  // ─── Сегменты ответа: лог «текст → действия → текст» — код в src/renderer/chat-segments.js ───
  const ChatSegments = window.ChatSegments({
    $: $,
    uid: uid,
    getSession: () => session,
    msgEls: msgEls,
    buildMessageEl: buildMessageEl,
    scrollBottom: ChatFeed.scrollBottom,
    persistChatsSoon: ChatStore.persistChatsSoon,
    planRoundStarted: PlanPanel.planRoundStarted,
  });

  // ─── Модалка «вопрос агента» (askUser) — код в src/renderer/ask-modal.js ───
  // Сборка стоит ВЫШЕ прежнего места куска: на неё смотрят разбор событий агента
  // и веб-режим, которые собираются раньше, — иначе им пришлось бы давать
  // отложенную стрелку, а их вызовы остаются прежними. Зависимость у модалки одна: $.
  const AskModal = window.AskModal({
    $: $,
  });
  // Элементы модалки уже в DOM (скрипты в конце body) — вешаем события сразу
  AskModal.wire();

  // ─── События агента и оверлеи картинки/диффа/предпросмотра — код в src/renderer/chat-events.js ───
  // Модуль собирается на прежнем месте куска. Зависимости, объявленные НИЖЕ
  // (SidePanel, TasksMission, ProjectPanel), переданы отложенными стрелками.
  const ChatEvents = window.ChatEvents({
    $: $,
    api: api,
    isElectron: isElectron,
    uid: uid,
    toast: toast,
    normalize: normalize,
    // Роли нужны окну предложения сменить роль (событие role_suggest): чтобы не
    // дублировать названия в разметке, подпись кнопки берётся из ядра.
    AgentCore: AgentCore,
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    getChatsData: () => chatsData,
    getSession: () => session,
    // Отказ провайдера «поля рассуждений не знаю» приходит событием — по нему плашка
    // 🧠 пропадает у этой модели навсегда (помним в настройках, а не в памяти окна).
    getReasoning: () => Reasoning,
    setLastUndoCount: (v) => { lastUndoCount = v; },
    setPlanCollapsed: (v) => PlanPanel.setPlanCollapsed(v),
    getRemoteRunNotified: () => remoteRunNotified,
    setRemoteRunNotified: (v) => { remoteRunNotified = v; },
    msgEls: msgEls,
    autoQueue: AutoTasks.autoQueue,
    flushAutoQueue: AutoTasks.flushAutoQueue,
    persistChatsSoon: ChatStore.persistChatsSoon,
    buildMessageEl: buildMessageEl,
    refreshMessage: refreshMessage,
    openAskModal: AskModal.openAskModal,
    closeAskModal: AskModal.closeAskModal,
    renderContext: renderContext,
    planFromModel: PlanPanel.planFromModel,
    planTextAdvance: PlanPanel.planTextAdvance,
    planTextFinish: PlanPanel.planTextFinish,
    planToolOutcome: PlanPanel.planToolOutcome,
    tryPlanFromRunText: PlanPanel.tryPlanFromRunText,
    renderPlanPanel: PlanPanel.renderPlanPanel,
    ChatSegments: ChatSegments,
    ChatFeed: ChatFeed,
    ChatThinking: ChatThinking,
    ChatWork: ChatWork,
    getSidePanel: () => SidePanel,
    getTasksMission: () => TasksMission,
    getProjectPanel: () => ProjectPanel,
    // Модуль прогона объявлен НИЖЕ (он берёт отправку из chat-send.js) — только
    // отложенной стрелкой: прямое чтение биндинга обрывает загрузку окна.
    getChatRun: () => ChatRun,
  });

  // ─── Правая панель, рельса, консоль и превью — код в src/renderer/side-panel.js ───
  // Модуль создаётся на прежнем месте панели: выше него на панель смотрят только
  // вызовы внутри функций (тест провайдера G4F, события агента), а им модуль уже есть.
  // Живые значения — функциями: настройки и история чатов переписываются целиком,
  // состояние генерации и панели проекта/облака создаются позже.
  const SidePanel = window.SidePanel({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    // Модальное подтверждение нужно панели для необратимых действий (удаление
    // образа реестра, записи DNS) — живёт в панели проекта, отдаём его целиком.
    confirmModal: (...a) => ProjectPanel.confirmModal(...a),
    AgentCore: AgentCore,
    esc: (t) => ProjectPanel.esc(t),
    persistSettings: ChatStore.persistSettings,
    getSettings: () => settings,
    getProjectPanel: () => ProjectPanel,
    getYcPanel: () => YcPanel,
    getChatsData: () => chatsData,
    getStreaming: () => streaming,
    getActiveChat: getActiveChat,
    persistChatsNow: ChatStore.persistChatsNow,
    selectChat: selectChat,
    renderSidebar: renderSidebar,
    sendMessage: ChatSend.sendMessage,
    startAutoRunNow: AutoTasks.startAutoRunNow,
    autoResize: autoResize,
  });
  // Быстрый запуск проекта и дела с миссией собираются внутри панели (их кнопки там),
  // а оболочке нужны под своими именами: ими пользуются события, автозадачи и палитра.
  const DevRun = SidePanel.DevRun;
  const TasksMission = SidePanel.TasksMission;

  // ─────────────── Удобство: копирование, регенерация, редактирование ───────────────
  // Код живёт в src/renderer/chat-actions.js: копирование, повторная генерация и
  // правка сообщения. «Идёт генерация» отдаётся живой функцией — иначе кнопки
  // могли бы перебить уже идущий ответ.
  const ChatActions = window.ChatActions({
    $: $,
    toast: toast,
    getActiveChat: getActiveChat,
    persistChats: ChatStore.persistChats,
    renderMessages: renderMessages,
    sendMessage: ChatSend.sendMessage,
    autoResize: autoResize,
    msgText: (c) => ChatRender.msgText(c),
    chatTitle: chatTitle,
    isStreaming: () => streaming,
  });

  // ─── Отрисовка сообщения: текст, вложения, кнопки — код в src/renderer/chat-render.js ───
  const ChatRender = window.ChatRender({
    MdRender: MdRender,
    fmtClock: fmtClock,
    ChatThinking: ChatThinking,
    ChatActions: ChatActions,
    continueInterruptedAnswer: ChatSend.continueInterruptedAnswer,
    getChatsData: () => chatsData,
  });

  // ─── Быстрое переключение модели (попап в шапке) — код в src/renderer/model-popup.js ───
  // Модуль собирается на прежнем месте куска. Настройки — живым доступом: модуль их не
  // только читает, но и пишет (выбор модели), а оболочка переписывает объект целиком.
  // Панель настроек объявлена НИЖЕ — отложенной стрелкой. Кэш моделей — значением:
  // он не переприсваивается, только наполняется, и его же наполняют настройки.
  const ModelPopup = window.ModelPopup({
    $: $,
    isElectron: isElectron,
    api: api,
    AgentCore: AgentCore,
    toast: toast,
    persistSettings: ChatStore.persistSettings,
    PRESET_LABEL: PRESET_LABEL,
    MODEL_KEY: MODEL_KEY,
    MODEL_INPUT: MODEL_INPUT,
    cachedModels: cachedModels,
    getSettings: () => settings,
    getSettingsPanel: () => SettingsPanel,
  });

  // ─── Переименование чата (двойной клик по заголовку) — код в src/renderer/chat-rename.js ───
  // Модуль собирается на прежнем месте куска. Признак идущего прогона — живым доступом:
  // во время генерации переименование запрещено, а прогон начинается и кончается по ходу.
  const ChatRename = window.ChatRename({
    $: $,
    toast: toast,
    getActiveChat: getActiveChat,
    getStreaming: () => streaming,
    chatTitle: chatTitle,
    persistChats: ChatStore.persistChats,
    renderSidebar: renderSidebar,
  });

  // ── Секреты: пароли сайтов, почта и переменные окружения — код в src/renderer/secrets-panel.js ──
  const SecretsPanel = window.SecretsPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    persistSettings: ChatStore.persistSettings,
    getSettings: () => settings,
  });

  // ─── Прогон ответа: состояние, завершение, остановка, откат — код в src/renderer/chat-run.js ───
  // Сборка стоит на прежнем месте куска. Живые доступы — функциями: признак прогона,
  // счётчик отката, признак «кнопка отката уже показана» и объект остановки меняются
  // по ходу хода, а панель проекта объявлена НИЖЕ точки сбора — потому стрелкой.
  const ChatRun = window.ChatRun({
    $: $,
    isElectron: isElectron,
    api: api,
    toast: toast,
    msgEls: msgEls,
    getStreaming: () => streaming,
    setStreamingFlag: (v) => { streaming = v; },
    getLastUndoCount: () => lastUndoCount,
    setLastUndoCount: (v) => { lastUndoCount = v; },
    getUndoRestoreShown: () => undoRestoreShown,
    setUndoRestoreShown: (v) => { undoRestoreShown = v; },
    getWebAbort: () => webAbort,
    getActiveChat: getActiveChat,
    renderSidebar: renderSidebar,
    autoResize: autoResize,
    sendMessage: ChatSend.sendMessage,
    getProjectPanel: () => ProjectPanel,
    ChatStore: ChatStore,
    ChatSegments: ChatSegments,
    ChatWork: ChatWork,
    ChatThinking: ChatThinking,
    ChatRender: ChatRender,
  });

  // Признак «кнопка отката уже показана» ещё нужен оболочке: его сбрасывает загрузка
  // истории с другого устройства. Сама кнопка и её показ живут в chat-run.js.
  let undoRestoreShown = false;
  // Баннер «нужна модель» на приветственном экране. Бейдж модели всегда статичен.
  function updateModelNeeded() {
    const chat = getActiveChat();
    const show = !settings.model && (!chat || !chat.messages.length);
    $("model-needed").classList.toggle("hidden", !show);
    SettingsPanel.updateBadge();
  }


  // ─────────────── Сохранённые OpenAI-подключения ───────────────
  // Код живёт в src/renderer/openai-profiles.js. Сборка стоит раньше веб-режима:
  // тот берёт список подключений своим входом (OpenaiProfiles.arr).
  const OpenaiProfiles = window.OpenaiProfiles({
    $: $,
    uid: uid,
    getSettings: () => settings,
    PRESETS: PRESETS,
    persistSettings: ChatStore.persistSettings,
    // Панель настроек объявлена НИЖЕ этой проводки: прямое чтение SettingsPanel.setSettingsMsg
    // упало бы на загрузке окна («Cannot access before initialization» — поймал живой прогон).
    setSettingsMsg: (t, e) => SettingsPanel.setSettingsMsg(t, e),
  });

  // ─────────────── Веб-режим: чат напрямую из браузера ───────────────
  // Код живёт в src/renderer/web-chat.js: тот же цикл чата на общем транспорте
  // AgentCore, когда окно открыто в браузере (веб-превью, телефон).
  const WebChat = window.WebChat({
    AgentCore: AgentCore,
    getSettings: () => settings,
    openaiProfilesArr: OpenaiProfiles.arr,
    persistSettings: ChatStore.persistSettings,
    onEvent: ChatEvents.onAiEvent, // то же окно событий, что и у desktop-цикла
    openAskModal: AskModal.openAskModal,
    // Предложение сменить роль (suggestRole) работает и в браузере: окно спрашивает,
    // а меняет роль то же действие, что и кнопка «Роль».
    setChatRole: TasksMission.setChatRole,
  });

  // ─────────────── Настройки ───────────────
  // Переключение вкладок настроек. Последняя открытая вкладка запоминается на сессию:
  // кнопка «Настройки» возвращает туда, где ты остановился.
  let lastSettingsTab = "model";
  // Поиск по настройкам собран до первого спрашивающего: о состоянии поиска
  // спрашивает переключение вкладок, а оно может случиться раньше этого места.
  const SettingsSearch = window.SettingsSearch({ $: $, getLastTab: () => lastSettingsTab });
  // Панель настроек: вкладки, поля, провайдеры, замер модели, сохранение — код в
  // src/renderer/settings-panel.js. Зависимости — живые функции там, где значение
  // переписывается: getSettings (настройки грузятся целиком), getPreset/setCurrentPreset,
  // setSbVersion, getMobilePanel (панель мобильного доступа создаётся ниже и берёт отсюда
  // сообщение панели — потому и функция, а не значение).
  const SettingsPanel = window.SettingsPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    getSettings: () => settings,
    getPreset: () => currentPreset,
    setCurrentPreset: (p) => { currentPreset = p; },
    setSbVersion: (v) => { ProjectPanel.setSbVersion(v); },
    cachedModels: cachedModels,
    persistSettings: ChatStore.persistSettings,
    updateStatusBar: () => ProjectPanel.updateStatusBar(),
    // Смена модели меняет и плашку 🧠 (у модели без рассуждений её нет вовсе):
    // обновление значка модели — единственное место, через которое проходят все смены.
    updateReasoning: () => Reasoning.updateButton(),
    updateModelNeeded: updateModelNeeded,
    refreshProject: () => ProjectPanel.refreshProject(),
    toast: toast,
    esc: (t) => ProjectPanel.esc(t),
    renderGithubSection: () => ProjectPanel.renderGithubSection(),
    probeG4fPort: G4fPanel.probeG4fPort,
    renderG4fProviderList: G4fPanel.renderG4fProviderList,
    search: SettingsSearch,
    getLastTab: () => lastSettingsTab,
    setLastTab: (t) => { lastSettingsTab = t; },
    getMobilePanel: () => MobilePanel,
    AgentCore: AgentCore,
    SecretsPanel: SecretsPanel,
    // YcPanel объявлен НИЖЕ панели настроек: прямое чтение значения упало бы на загрузке
    // окна («Cannot access 'YcPanel' before initialization» — поймал живой прогон).
    getYcPanel: () => YcPanel,
    OpenaiProfiles: OpenaiProfiles,
    PRESETS: PRESETS,
    PRESET_LABEL: PRESET_LABEL,
    MODEL_KEY: MODEL_KEY,
    MODEL_INPUT: MODEL_INPUT,
    URL_INPUT: URL_INPUT,
    URL_KEY: URL_KEY,
  });

  // ── Мобильный доступ: QR-код, статус моста, PIN и адреса — код в src/renderer/mobile-panel.js ──
  const MobilePanel = window.MobilePanel({
    $: $,
    api: api,
    isElectron: isElectron,
    getSettings: () => settings,
    setSettingsMsg: SettingsPanel.setSettingsMsg,
  });

  // Токены в коротком виде: 12400 → «12.4k»
  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v < 1000) return String(v);
    return (Math.round(v / 100) / 10).toFixed(1).replace(/\.0$/, "") + "k";
  }

  // Заполняемость контекста модели под полем ввода (приходит событием "context").
  // Показываем ТОЛЬКО слово и процент (как у Freebuff). Полоска убрана: она
  // отнимала ширину, читалась как второй индикатор загрузки, а точные числа
  // всё равно лежат в подсказке.
  function renderContext(ev) {
    const el = $("ctx-indicator");
    const textEl = $("ctx-text");
    if (!el || !textEl) return;
    const used = Number((ev && ev.used) || 0);
    const budget = Number((ev && ev.budget) || 0);
    // Процент считаем от бюджета: при переполнении он честно больше 100, а не
    // «упирается» в 100 (раньше при 62 000 из 50 000 показывалось «100%»).
    const pct = budget > 0 ? Math.round((used / budget) * 100) : Math.max(0, parseInt(ev && ev.percent, 10) || 0);
    textEl.textContent = "Контекст " + pct + "%";
    textEl.classList.toggle("warn", pct >= 75 && pct < 92);
    textEl.classList.toggle("danger", pct >= 92);
    el.classList.add("visible");
    el.title =
      "Контекст модели: занято " + fmtTokens(used) + " из " + fmtTokens(budget) +
      " токенов (" + pct + "%); точнее — " + used.toLocaleString("ru-RU") + " из " + budget.toLocaleString("ru-RU") +
      ". Это история переписки и схема инструментов; оценка приблизительная (по символам), а не точный счёт токенов модели." +
      (pct > 100
        ? " Сейчас занято БОЛЬШЕ бюджета: текущий шаг (твоё сообщение и результаты инструментов) не сжимается и уходит целиком. Перед следующим запросом история снова обрезается до бюджета, а при переполнении старая часть сворачивается в памятку."
        : " При заполнении старая часть автоматически сжимается в памятку.");
  }


  function fmtClock(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function toast(text) {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "90px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#1e222c",
      border: "1px solid #3a4050",
      color: "#e7e9ee",
      padding: "10px 16px",
      borderRadius: "10px",
      zIndex: 200,
      fontSize: "13.5px",
      boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  // ─────────────── События ───────────────
  // Чтение scrollHeight заставляет браузер синхронно пересчитать раскладку.
  // При быстрой печати (в ленте к этому моменту уже тысячи узлов) это заметно
  // «съедало» плавность — поэтому пересчёт откладываем до кадра.
  let inputResizeRaf = 0;
  function autoResize() {
    if (inputResizeRaf) return;
    inputResizeRaf = requestAnimationFrame(() => {
      inputResizeRaf = 0;
      const t = $("input");
      if (!t) return;
      t.style.height = "auto";
      t.style.height = Math.min(t.scrollHeight, 160) + "px";
    });
  }

  $("btn-send").onclick = ChatSend.sendMessage;
  $("btn-stop").onclick = ChatRun.stop;
  $("btn-resume").onclick = ChatRun.resume;
  $("btn-plan").onclick = () => {
    if (streaming) return;
    planToggleOn = !planToggleOn;
    $("btn-plan").classList.toggle("active", planToggleOn);
    if (planToggleOn) toast("📋 Режим плана: сначала план и подтверждение, потом действия");
  };
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ChatSend.sendMessage();
    }
  });
  $("input").addEventListener("input", autoResize);
  $("input").addEventListener("paste", onInputPaste);
  $("btn-attach-remove").onclick = hideAttachBar;
  // Кнопка-скрепка. Раньше обработчика у неё не было ВООБЩЕ: поле #file-input лежало
  // в разметке, но никто его не открывал и не читал — отсюда «кнопка не работает».
  $("btn-attach-file").onclick = () => $("file-input").click();
  $("file-input").addEventListener("change", (e) => {
    for (const f of Array.from(e.target.files || [])) attachFile(f);
    e.target.value = ""; // тот же файл можно приложить повторно
  });
  // Перетаскивание файлов в композер. Это третий путь к вложению — единственный,
  // который вообще не спрашивает системный диалог: в веб-превью и во встроенных
  // веб-вью он бывает недоступен, из-за чего скрепка выглядит «мёртвой», хотя
  // обработчик на ней есть. Здесь файл приходит прямо в страницу.
  const composerEl = document.querySelector(".composer");
  if (composerEl) {
    const dropHasFiles = (e) =>
      !!(e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.types || []).some((t) => t === "Files"));
    composerEl.addEventListener("dragenter", (e) => {
      if (!dropHasFiles(e)) return;
      e.preventDefault();
      composerEl.classList.add("drag-over");
    });
    composerEl.addEventListener("dragover", (e) => {
      if (!dropHasFiles(e)) return;
      e.preventDefault(); // без этого браузер отменяет drop и файл не придёт
      e.dataTransfer.dropEffect = "copy";
    });
    composerEl.addEventListener("dragleave", (e) => {
      if (e.target === composerEl) composerEl.classList.remove("drag-over");
    });
    composerEl.addEventListener("drop", (e) => {
      e.preventDefault();
      composerEl.classList.remove("drag-over");
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      for (const f of files) attachFile(f);
      toast(files.length > 1 ? "Файлов прикреплено: " + files.length : "Файл прикреплён: " + files[0].name);
    });
  }
  $("chat-title").addEventListener("dblclick", ChatRename.startRenameChat);
  $("btn-new-chat").onclick = () => {
    if (!streaming) createChat();
  };
  // ─── Продолжение чата: контекст из прошлого чата — код в src/renderer/chat-continue.js ───
  // Сборка стоит на прежнем месте куска, а `wire()` навешивает обработчик там, где он
  // висел раньше: кнопку жмут и мышью, и из палитры команд (`.click()`). Живые доступы —
  // функциями: признак прогона и активный чат берутся в момент нажатия, копия застыла бы.
  const ChatContinue = window.ChatContinue({
    $: $,
    getStreaming: () => streaming,
    getActiveChat: getActiveChat,
    createChat: createChat,
  });
  ChatContinue.wire();
  // ── Yandex Cloud (дашборд + настройки) — код в src/renderer/yc-panel.js ──
  // Отдаём панели ровно то, что принадлежит оболочке окна: DOM, IPC, всплывашки,
  // переходы и живой доступ к настройкам.
  const YcPanel = window.YcPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    termAppend: SidePanel.termAppend,
    confirmModal: (...a) => ProjectPanel.confirmModal(...a),
    inputDialog: (...a) => ProjectPanel.inputDialog(...a),
    openSettings: SettingsPanel.openSettings,
    openSidePanel: SidePanel.openSidePanel,
    getSettings: () => settings,
  });
  // Кнопка «☁️» в шапке — дашборд Yandex Cloud в правой панели
  if ($("btn-toggle-cloud")) {
    $("btn-toggle-cloud").onclick = () => {
      if (SidePanel.sidePanelVisible() && SidePanel.getSideTab() === "cloud") SidePanel.closeSidePanel();
      else SidePanel.openSidePanel("cloud");
    };
  }
  // Кнопка «🚀» в шапке — панель деплоя
  if ($("btn-toggle-deploy")) {
    $("btn-toggle-deploy").onclick = () => {
      if (SidePanel.sidePanelVisible() && SidePanel.getSideTab() === "deploy") SidePanel.closeSidePanel();
      else SidePanel.openSidePanel("deploy");
    };
  }

  $("btn-settings").onclick = () => SettingsPanel.openSettings();
  // Шапка модели: попап, обновление списка и клик мимо него — код в src/renderer/model-popup.js
  // (модуль навешивает события в том же порядке, что и раньше).
  ModelPopup.wireHeader();
  $("btn-model-needed").onclick = () => SettingsPanel.openSettings("model");

  // Быстрые действия на приветственном экране (делегирование — работает даже
  // после пересоздания чипов при смене чата)
  const welcome = $("welcome");
  welcome.addEventListener("click", (e) => {
    const chip = e.target.closest(".welcome-chips .chip");
    if (!chip || !chip.dataset.prompt) return;
    $("input").value = chip.dataset.prompt;
    autoResize();
    ChatSend.sendMessage();
  });

  // Поиск по чатам. В поле поиска может оказаться «мусор» от автозаполнения браузера —
  // адреса из настроек (https://api.groq.com/openai/v1, localhost:11434, email и т.п.).
  // Такой «адрес» не может быть поисковым запросом: он не должен прятать все чаты
  // и не должен мозолить глаза под кнопкой «Новый чат».
  function isJunkSearchValue(v) {
    const s = String(v || "").trim();
    if (!s) return false;
    if (/^(https?:)?\/\//i.test(s)) return true; // URL со схемой или //
    if (s.includes("@")) return true; // email / токен
    // Домен без схемы, возможно с путём или портом: api.groq.com, groq.com/openai/v1, localhost:11434
    if (/^[\w.-]+(\.[a-zа-яё]{2,})+([/:?#]|$)/i.test(s)) return true;
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/:?#]|$)/.test(s)) return true; // IP-адрес
    return false;
  }

  function applyChatFilter() {
    const raw = $("chat-search").value.trim();
    if (isJunkSearchValue(raw)) {
      // В поле попал адрес, а не запрос: показываем все чаты и стираем «адрес»
      $("chat-search").value = "";
      document.querySelectorAll(".chat-item").forEach((it) => (it.style.display = ""));
      return;
    }
    const q = raw.toLowerCase();
    document.querySelectorAll(".chat-item").forEach((it) => {
      const t = it.querySelector(".chat-title");
      it.style.display = !q || (t && t.textContent.toLowerCase().includes(q)) ? "" : "none";
    });
  }
  $("chat-search").addEventListener("input", applyChatFilter);
  // Автозаполнение браузера подставляло сюда URL из настроек — при фокусе чистим;
  // иначе просто выделяем текст, чтобы печать заменила его.
  $("chat-search").addEventListener("focus", () => {
    if (isJunkSearchValue($("chat-search").value)) {
      $("chat-search").value = "";
      applyChatFilter();
    } else {
      $("chat-search").select();
    }
  });

  // Горячие клавиши: Ctrl/Cmd+N — новый чат
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (!streaming) createChat();
    }
  });
  $("btn-close-settings").onclick = () => $("settings-overlay").classList.add("hidden");
  if ($("settings-search")) {
    $("settings-search").addEventListener("input", (e) => SettingsSearch.apply(e.target.value));
    // Esc в поле поиска очищает только поиск, а не закрывает всё окно настроек.
    $("settings-search").addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("settings-search").value) {
        e.preventDefault();
        e.stopPropagation();
        SettingsSearch.reset();
      }
    });
  }
  if ($("settings-search-clear")) {
    $("settings-search-clear").onclick = () => {
      SettingsSearch.reset();
      $("settings-search").focus();
    };
  }
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) $("settings-overlay").classList.add("hidden");
  });
  $("btn-toggle-key").onclick = () => SettingsPanel.toggleKey("s-openai-key");
  $("btn-toggle-anth-key").onclick = () => SettingsPanel.toggleKey("s-anth-key");
  const provSel = $("s-provider-select");
  if (provSel) {
    provSel.onchange = () => SettingsPanel.setProviderUI(provSel.value);
  }
  // Вкладки настроек
  document.querySelectorAll(".stab").forEach((b) => {
    b.onclick = () => SettingsPanel.showSettingsTab(b.dataset.tab);
  });
  // Аккордеон: карточки провайдеров — клик по свёрнутой выбирает провайдера и раскрывает,
  // по раскрытой — сворачивает; вложенные блоки (data-acc-head="presets") — просто раскрытие.
  document.querySelectorAll("[data-acc-head]").forEach((h) => {
    h.onclick = () => {
      const acc = h.closest(".acc");
      const isProvider = acc.dataset.acc === "ollama" || acc.dataset.acc === "openai" || acc.dataset.acc === "anthropic";
      if (isProvider) {
        if (acc.classList.contains("open")) {
          acc.classList.remove("open");
        } else {
          SettingsPanel.setProviderUI(acc.dataset.acc);
        }
      } else {
        acc.classList.toggle("open");
      }
    };
  });
  document.querySelectorAll(".chip[data-preset]").forEach((b) => {
    b.onclick = () => SettingsPanel.setPreset(b.dataset.preset);
  });
  $("btn-refresh-models").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    ChatStore.persistSettings();
    SettingsPanel.loadModels();
  };
  $("btn-refresh-anth-models").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    ChatStore.persistSettings();
    SettingsPanel.loadModels();
  };
  $("btn-refresh-ollama-models").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    ChatStore.persistSettings();
    SettingsPanel.loadModels();
  };
  $("btn-probe-ollama").onclick = () => {
    SettingsPanel.probeLocalModelUI();
  };
  // Кнопка в подвале настроек делает ровно то же самое: один и тот же замер.
  $("btn-probe-model").onclick = () => {
    SettingsPanel.probeLocalModelUI();
  };
  $("btn-test").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    ChatStore.persistSettings();
    SettingsPanel.testConnection();
  };
  $("btn-save-settings").onclick = SettingsPanel.saveSettingsUI;
  // Сохранённые OpenAI-подключения: список, сохранить/обновить, удалить
  $("s-openai-profile").onchange = () => {
    const v = $("s-openai-profile").value;
    if (v === "__new__") { settings.openaiActiveProfile = ""; return; }
    OpenaiProfiles.apply(v);
  };
  $("btn-profile-save").onclick = OpenaiProfiles.saveFromFields;
  $("btn-profile-delete").onclick = OpenaiProfiles.remove;
  $("btn-pick-dir").onclick = async () => {
    if (!isElectron) {
      toast("Выбор папки доступен только в приложении на ПК");
      return;
    }
    const p = await api.pickDirectory("work");
    if (p) $("s-workdir").value = p;
  };
  // Куда класть работу агента (миссии, прогоны и дела): окно первого запуска и
  // кнопка «🎯 Папки работы» в настройках — код в src/renderer/settings-panel.js.
  SettingsPanel.wireSetupFolders();

  // Браузер агента: постоянный профиль (сессии сайтов) — очистка и обновление подписи
  if ($("btn-browser-profile-clear")) {
    $("btn-browser-profile-clear").onclick = async () => {
      if (!isElectron || !api.browserClearProfile) {
        toast("Очистка профиля доступна в desktop-приложении");
        return;
      }
      if (!confirm("Выйти со всех сайтов в браузере агента? Куки и сессии будут стёрты — при следующем входе потребуется авторизация заново.")) return;
      const r = await api.browserClearProfile();
      toast((r && r.message) || "Профиль очищен");
      SettingsPanel.renderBrowserProfileInfo();
    };
  }
  if ($("s-browser-profile")) $("s-browser-profile").onchange = SettingsPanel.renderBrowserProfileInfo;

  // «Свой Chrome» (CDP): подключение по кнопке и подпись состояния.
  if ($("s-browser-connect")) $("s-browser-connect").onchange = SettingsPanel.renderBrowserConnectInfo;
  if ($("s-browser-connect-port")) $("s-browser-connect-port").onchange = SettingsPanel.renderBrowserConnectInfo;
  if ($("btn-browser-connect")) {
    $("btn-browser-connect").onclick = async () => {
      if (!isElectron || !api.browserConnect) {
        toast("Подключение к своему Chrome доступно в desktop-приложении");
        return;
      }
      const el = $("browser-connect-info");
      if (el) el.textContent = "⏳ Подключаюсь к Chrome… (если он не запущен с отладкой, приложение запустит его само)";
      const port = parseInt($("s-browser-connect-port").value, 10) || 9222;
      const r = await api.browserConnect({ port });
      const msg = (r && r.message) || "Не удалось подключиться";
      if (el) el.textContent = msg.split("\n").slice(0, 2).join(" ");
      toast(r && r.ok ? "Подключено к вашему Chrome" : "Не подключилось — смотрите подсказку ниже");
      SettingsPanel.renderBrowserConnectInfo();
    };
  }

  // ─── Панель проекта: файлы, коммиты, изменения, публикация — код в src/renderer/project-panel.js ───
  // Настройки читаются и пишутся ЦЕЛИКОМ (грузятся и сохраняются объектом), поэтому
  // живые функции, а не копия: setSettings переписывает саму переменную оболочки.
  const ProjectPanel = window.ProjectPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    normalize: normalize,
    persistSettings: ChatStore.persistSettings,
    toast: toast,
    syncRail: SidePanel.syncRail,
    toggleModelPopup: ModelPopup.toggleModelPopup,
    openSidePanel: SidePanel.openSidePanel,
    ensureProjectChat: ensureProjectChat,
    DevRun: DevRun,
    SettingsPanel: SettingsPanel,
  });

  // ── Секреты: переменные окружения ──
  $("btn-env-add").onclick = SecretsPanel.envAdd;
  $("btn-env-import").onclick = SecretsPanel.envImportText;
  $("btn-env-file").onclick = () => $("env-file-input").click();
  $("env-file-input").addEventListener("change", (e) => {
    SecretsPanel.envImportFile(e.target.files && e.target.files[0]);
    e.target.value = "";
  });

  // ── Секреты: пароли сайтов ──
  if ($("btn-vault-add")) $("btn-vault-add").onclick = SecretsPanel.vaultAdd;
  if ($("btn-vault-clear")) $("btn-vault-clear").onclick = SecretsPanel.vaultClearForm;
  if ($("btn-vault-eye")) $("btn-vault-eye").onclick = () => SettingsPanel.toggleKey("s-vault-pass");
  if ($("s-vault-pass")) {
    // Enter в любом поле формы сохраняет запись.
    for (const id of ["s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note"]) {
      const el = $(id);
      if (el) el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          SecretsPanel.vaultAdd();
        }
      });
    }
  }

  // ─── Палитра команд (Ctrl+K, Ctrl+P) — код в src/renderer/command-palette.js ───
  // Модуль создаётся ДО блока горячих клавиш: Ctrl+K и Ctrl+P открывают палитру.
  // Состояние генерации отдаём живой функцией — копия застыла бы на времени загрузки,
  // и «Остановить агента» показывалось бы в списке всегда (или никогда).
  const CommandPalette = window.CommandPalette({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    createChat: createChat,
    stop: ChatRun.stop,
    getStreaming: () => streaming,
    openSidePanel: SidePanel.openSidePanel,
    termReset: SidePanel.termReset,
    ChatActions: ChatActions,
    ProjectPanel: ProjectPanel,
    SettingsPanel: SettingsPanel,
  });


  // ── Удобство: копирование чата, умная прокрутка, горячие клавиши, ресайзер панели ──
  $("btn-copy-chat").onclick = ChatActions.copyChat;
  $("btn-scroll-bottom").onclick = ChatFeed.jumpToBottom;
  $("messages").addEventListener("scroll", ChatFeed.updatePinState, { passive: true });

  // Горячие клавиши (дополнение к Ctrl/Cmd+N — новый чат)
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target;
    const tag = t && t.tagName ? t.tagName : "";
    const inField = tag === "INPUT" || tag === "TEXTAREA";
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (e.shiftKey) {
        $("chat-search").focus();
        $("chat-search").select();
      } else {
        CommandPalette.openPalette("actions");
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (e.shiftKey) CommandPalette.openPalette("actions");
      else CommandPalette.enterFileMode();
      return;
    }
    if (mod && e.key.toLowerCase() === "enter") {
      if (inField && t.id === "input") {
        e.preventDefault();
        ChatSend.sendMessage();
      }
      return;
    }
    if (e.key === "Escape") {
      // В редакторе файла Esc не закрывает панель (им же закрывают подсказки редактора)
      if (t && t.id === "file-editor") return;
      // закрыть любой открытый оверлей
      for (const ov of document.querySelectorAll(".overlay")) {
        if (!ov.classList.contains("hidden")) {
          if (ov.id === "ask-overlay") {
            $("btn-ask-cancel").click(); // отменяем ожидание ответа агента
          } else {
            ov.classList.add("hidden");
          }
          return;
        }
      }
      // затем — правую панель
      if (SidePanel.sidePanelVisible()) SidePanel.closeSidePanel();
      // Esc во время генерации = явная остановка агента. Только реальные нажатия
      // пользователя (e.isTrusted) — синтетические клики агента (appPress Escape) не сработают.
      if (streaming && e.isTrusted) ChatRun.stop();
    }
  });

  // Ресайзер правой панели: тонкая полоска на левом крае (ширина)
  (function initSideResizer() {
    const panel = $("side-panel");
    const handle = document.createElement("div");
    handle.className = "sp-resize";
    handle.title = "Потяни, чтобы изменить ширину";
    panel.insertBefore(handle, panel.firstChild);
    let dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.classList.add("resizing");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = $("main").getBoundingClientRect();
      const w = e.clientX - rect.left;
      panel.style.width = Math.min(Math.max(w, 320), window.innerWidth * 0.55) + "px";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      document.body.classList.remove("resizing");
    });
  })();




  // ── Мобильный доступ: панель в настройках — код в src/renderer/mobile-panel.js ──
  MobilePanel.initMobilePanel();
  // ── Зрение и генерация изображений (вспомогательная модель) ──
  $("s-vision-enabled").addEventListener("change", () => {
    $("vision-fields").classList.toggle("hidden", !$("s-vision-enabled").checked);
  });
  // ── Локальный self-update (OTA): проверка, откат, открыть папку ──
  $("btn-ota-check").onclick = async () => {
    if (!isElectron) {
      toast("Self-update доступен в приложении на ПК");
      return;
    }
    const r = await api.otaCheck();
    if (r && r.status === "applied") toast("✅ Обновление применено: " + r.version + " — перезапуск…");
    else if (r && r.status === "error") toast("⚠ " + ((r && r.message) || "Ошибка применения обновления"));
    else if (r && r.status === "busy") toast("Агент сейчас работает — обновление применится после");
    else if (r && r.status === "disabled") toast("Self-update выключен в настройках");
    else toast("Обновлений нет — код актуален");
    SettingsPanel.renderOtaStatus();
  };
  $("btn-ota-rollback").onclick = () => {
    if (!isElectron) return;
    ProjectPanel.confirmModal("Откатить на предыдущую версию кода?", "Приложение перезапустится с прошлой версией.", () => {
      api.otaRollback();
    });
  };
  $("btn-ota-reset").onclick = () => {
    if (!isElectron) {
      toast("Self-update доступен в приложении на ПК");
      return;
    }
    ProjectPanel.confirmModal(
      "Полностью сбросить OTA-обновления?",
      "Будет удалён применённый бандл (userData/ota) и папка ota/ рядом с кодом — нерабочее обновление больше не подхватится. Приложение вернётся к установленной версии кода (перезапусти его).",
      () => {
        api.otaReset(true).then((r) => {
          if (r && r.ok) {
            toast("OTA сброшен — код вернётся к установленной версии после перезапуска");
            SettingsPanel.renderOtaStatus();
          } else {
            toast("Ошибка сброса OTA");
          }
        });
      }
    );
  };
  $("btn-ota-open").onclick = () => {
    if (isElectron) api.otaOpenDir();
  };
  // ── 🧠 Память диалогов: открыть папку и очистить дневник ──
  // Файлы работы агента: открыть папку и очистить зеркала (миссии не трогаем).
  if ($("btn-agent-files-open")) $("btn-agent-files-open").onclick = async () => {
    if (!isElectron || !api.agentFilesOpen) {
      toast("Файлы работы агента доступны в приложении на ПК");
      return;
    }
    const r = await api.agentFilesOpen();
    if (r && r.ok) toast("Открываю папку работы агента");
    else toast("⚠ Не удалось открыть папку" + (r && r.error ? ": " + r.error : ""));
  };
  if ($("btn-agent-files-clear")) $("btn-agent-files-clear").onclick = () => {
    if (!isElectron || !api.agentFilesClear) return;
    ProjectPanel.confirmModal(
      "Удалить зеркала работы агента? Будут удалены .agent/tasks.md и .agent/context/. Миссии, их журналы и отчёты останутся на месте.",
      async () => {
        const r = await api.agentFilesClear();
        toast((r && r.message) || "Зеркала очищены");
        SettingsPanel.renderAgentFilesStatus();
      }
    );
  };
  if ($("btn-memory-open")) $("btn-memory-open").onclick = async () => {
    if (!isElectron || !api.memoryOpenDir) {
      toast("Память диалогов доступна в приложении на ПК");
      return;
    }
    const r = await api.memoryOpenDir();
    if (r && r.ok) toast("Открываю папку памяти диалогов");
    else toast("⚠ Не удалось открыть папку" + (r && r.error ? ": " + r.error : ""));
  };
  if ($("btn-memory-clear")) $("btn-memory-clear").onclick = () => {
    if (!isElectron || !api.memoryClear) return;
    ProjectPanel.confirmModal(
      "Удалить все сохранённые памятки?",
      "Будут удалены все дни дневника памяти диалогов. Переписка в чатах и заметки проекта не затрагиваются.",
      () => {
        api.memoryClear("").then((r) => {
          toast(r && r.ok ? "🧠 " + r.message : "⚠ Ошибка очистки памяти диалогов");
          SettingsPanel.renderMemoryStatus();
        });
      }
    );
  };
  if ($("s-context-memory")) $("s-context-memory").addEventListener("change", SettingsPanel.renderMemoryStatus);
  if ($("s-agent-files")) $("s-agent-files").addEventListener("change", SettingsPanel.renderAgentFilesStatus);
  $("btn-toggle-vision-key").onclick = () => SettingsPanel.toggleKey("s-vision-key");
  $("btn-toggle-serper-key").onclick = () => SettingsPanel.toggleKey("s-serper-key");
  if ($("btn-mail-eye")) $("btn-mail-eye").onclick = () => SettingsPanel.toggleKey("s-mail-pass");
  if ($("btn-mail-detect")) $("btn-mail-detect").onclick = SecretsPanel.mailFillServers;
  if ($("btn-mail-test")) $("btn-mail-test").onclick = SecretsPanel.mailDoTest;
  if ($("btn-mail-test-send")) $("btn-mail-test-send").onclick = SecretsPanel.mailDoTestSend;
  if ($("btn-mail-recent")) $("btn-mail-recent").onclick = SecretsPanel.mailDoRecent;
  $("btn-refresh-vision-models").onclick = () => SettingsPanel.loadAuxModels("vision");
  $("btn-refresh-image-models").onclick = () => SettingsPanel.loadAuxModels("image");
  if ($("s-vision-url")) $("s-vision-url").addEventListener("input", SettingsPanel.renderVisionDetect);
  if ($("s-vision-enabled")) $("s-vision-enabled").addEventListener("change", SettingsPanel.renderVisionDetect);
  TasksMission.initRolesAndTasks();
  $("btn-mobile-menu").onclick = () => $("sidebar").classList.toggle("open");
  $("chat-list").addEventListener("click", () => {
    if (window.innerWidth <= 900) $("sidebar").classList.remove("open");
  });  $("btn-device-open").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/login/device");
  };
  $("btn-device-cancel").onclick = () => {
    if (isElectron) api.githubDeviceCancel();
    ProjectPanel.closeDeviceModal();
  };


  // ─────────────── Старт ───────────────
  ChatStore.loadState().then(() => {
    // Чистим поле поиска: автозаполнение браузера могло подставить URL из настроек
    $("chat-search").value = "";
    if (!chatsData.chats.length) {
      createChat();
    } else {
      renderSidebar();
      renderMessages();
    }
    // Если активен проект — сразу открываем чат, привязанный к нему
    // (агент не должен видеть контекст других проектов).
    if (isElectron && settings.activeProjectId) {
      const pr = (settings.projects || []).find((p) => p.id === settings.activeProjectId);
      ensureProjectChat(settings.activeProjectId, pr && pr.name);
    }
    SettingsPanel.updateBadge();
    ProjectPanel.refreshProjects();
    SettingsPanel.renderOtaStatus(); // версия кода — сразу в статус-бар
    if (isElectron) {
      api.onAiEvent(ChatEvents.onAiEvent);
      // История чатов общая: телефон сохранил переписку — перечитываем файл.
      if (typeof api.onChatsReload === "function") api.onChatsReload(() => ChatStore.reloadChatsFromDisk());
      ProjectPanel.wireGithubEvents();
    }
  });
})();

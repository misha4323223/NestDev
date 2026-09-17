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
  let cachedModels = {}; // кэш списков моделей по провайдеру (для быстрого переключения в шапке)

  // Вставка изображений (Ctrl+V): если в буфере картинка — прикрепляем к сообщению
  function onInputPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        e.preventDefault();
        const file = it.getAsFile && it.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          pendingImage = String(reader.result || "");
          $("attach-bar").classList.remove("hidden");
          $("attach-thumb").src = pendingImage;
        };
        reader.readAsDataURL(file);
        return;
      }
    }
  }
  function hideAttachBar() {
    pendingImage = null;
    $("attach-bar").classList.add("hidden");
    $("attach-thumb").removeAttribute("src");
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
  function loadState() {
    if (isElectron) {
      return Promise.all([api.getSettings(), api.loadChats()]).then(([s, c]) => {
        settings = normalize(s);
        chatsData = sanitizeChats(c || { chats: [], activeId: null });
        persistChats();
      });
    }
    try {
      settings = normalize(JSON.parse(localStorage.getItem("settings") || "null"));
    } catch {}
    try {
      chatsData = sanitizeChats(JSON.parse(localStorage.getItem("chats") || "null") || { chats: [], activeId: null });
    } catch {}
    return Promise.resolve();
  }

  // ─── Восстановление после аварийного закрытия ───
  // В сохранённой истории могли остаться незавершённые сообщения (pending).
  // Снимаем флаги, чтобы после перезапуска не висел вечный индикатор «выполняется»,
  // и один раз поясняем, что ответ был прерван.
  function sanitizeChats(d) {
    if (!d || !Array.isArray(d.chats)) return d || { chats: [], activeId: null };
    for (const c of d.chats) {
      if (!Array.isArray(c.messages)) c.messages = [];
      // План работ сохраняется вместе с чатом. Битые пункты (старый формат,
      // ручная правка файла) чистим тем же нормализатором, что и данные модели.
      // Защищается try/catch: sanitizeChats работает с файлом чатов при запуске и
      // не должен падать ни при каких данных (битый chats.json — не повод не стартовать).
      try {
        // Поле трогаем только если оно есть: чаты без плана не должны менять форму
        // (иначе каждый запуск перезаписывал бы весь файл истории).
        if (c.plan !== undefined) {
          const pi = c.plan && typeof c.plan === "object" && Array.isArray(c.plan.items) ? AgentCore.normalizePlanTasks(c.plan.items) : [];
          // legacy-планы со source "auto" отбрасываем — панель показывает только план модели.
          if (pi.length && c.plan.source !== "auto") c.plan = { title: String(c.plan.title || ""), source: c.plan.source === "text" ? "text" : "model", items: pi, updatedAt: Number(c.plan.updatedAt) || Date.now() };
          else c.plan = null;
        }
        if (Array.isArray(c.planHistory)) c.planHistory = c.planHistory.slice(0, PLAN_ARCHIVE_LIMIT);
      } catch { c.plan = null; c.planHistory = []; }
      let interrupted = false;
      for (const m of c.messages) {
        if (!m.pending) continue;
        m.pending = false;
        interrupted = true;
        if (m.role === "tool") {
          if (!m.toolResult) {
            m.toolResult = "Действие не завершилось: приложение закрылось раньше.";
            m.toolOk = false;
          }
        } else if (!m.content) {
          m.content = "…";
        }
      }
      if (interrupted && c.id === d.activeId) {
        c.messages.push({
          id: "recovered-" + c.id + "-" + Date.now(),
          role: "system",
          content: "⚠️ Предыдущий ответ был прерван закрытием приложения. Сохранённая часть осталась в истории — можно продолжить с этого места.",
          interrupted: true,
          chatId: c.id,
          createdAt: Date.now(),
        });
      }
    }
    return d;
  }
  function persistSettings() {
    if (isElectron) api.setSettings(settings);
    else localStorage.setItem("settings", JSON.stringify(settings));
  }
  function persistChats() {
    if (isElectron) api.saveChats(chatsData);
    else localStorage.setItem("chats", JSON.stringify(chatsData));
  }
  // ─── Автосохранение во время длинного ответа ───
  // Раньше чат писался на диск только в начале и в конце хода. Если приложение
  // закрыть посреди ответа, весь уже полученный текст и действия пропадали.
  // Теперь пишем не чаще раза в 1.5 c и гарантированно сбрасываем данные
  // при закрытии/сворачивании окна.
  let chatsSaveTimer = null;
  let chatsSavePending = false;
  const CHATS_SAVE_INTERVAL = 1500;
  function persistChatsSoon() {
    chatsSavePending = true;
    if (chatsSaveTimer) return;
    chatsSaveTimer = setTimeout(() => {
      chatsSaveTimer = null;
      if (!chatsSavePending) return;
      chatsSavePending = false;
      persistChats();
    }, CHATS_SAVE_INTERVAL);
  }
  function persistChatsNow() {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    chatsSavePending = false;
    persistChats();
  }
  function flushChats(sync) {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    if (!chatsSavePending) return;
    chatsSavePending = false;
    if (isElectron) {
      // Синхронный канал доступен в Electron: успевает записать файл при закрытии окна.
      if (sync && typeof api.saveChatsSync === "function") {
        try { api.saveChatsSync(chatsData); return; } catch {}
      }
      api.saveChats(chatsData);
    } else {
      localStorage.setItem("chats", JSON.stringify(chatsData));
    }
  }
  window.addEventListener("beforeunload", () => flushChats(true));
  window.addEventListener("pagehide", () => flushChats(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushChats(true);
  });

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
    persistChats();
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
      persistChats();
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
    persistChats();
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
    persistChats();
  }

  // ─── План работ (todoWrite): чеклист, разбор плана из текста, галочки ───
  // Код живёт в src/renderer/plan-panel.js. Модуль собирается на прежнем месте куска.
  // Значения передаются напрямую ($, document, AgentCore и вызовы оболочки), а
  // переписываемое состояние — живыми функциями: признак генерации (streaming) и
  // сегменты ответа (они объявлены НИЖЕ точки сбора).
  // Сколько прошлых планов хранит чат: тем же числом ограничивается история при
  // загрузке чатов с диска (sanitizeChats) — один источник правды на оба места.
  const PLAN_ARCHIVE_LIMIT = 5;
  const PlanPanel = window.PlanPanel({
    $: $,
    document: document,
    getActiveChat: getActiveChat,
    getStreaming: () => streaming,
    getChatSegments: () => ChatSegments,
    sendMessage: sendMessage,
    autoResize: autoResize,
    persistChatsSoon: persistChatsSoon,
    toast: toast,
    AgentCore: AgentCore,
    planArchiveLimit: PLAN_ARCHIVE_LIMIT,
  });
  // ─────────── /План работ ───────────
  // ─── Синхронизация истории между устройствами ───
  // История чатов лежит в одном файле, а клиентов несколько: окно на ПК и телефоны.
  // Когда сохраняет другой клиент, приходит событие chats:reload — раньше его не
  // было, и ответ, написанный с телефона, появлялся на ПК только после перезапуска.
  let remoteRunNotified = false;
  async function reloadChatsFromDisk() {
    if (!isElectron || typeof api.loadChats !== "function") return;
    // Свой прогон агента или несохранённые правки — перезагрузка их потеряет.
    if (session || chatsSavePending) return;
    let c = null;
    try {
      c = await api.loadChats();
    } catch {
      return;
    }
    if (!c || !Array.isArray(c.chats)) return;
    chatsData = sanitizeChats(c);
    remoteRunNotified = false;
    renderSidebar();
    renderMessages();
    try { ProjectPanel.refreshProject(); } catch {}
    toast("📱 История обновлена с другого устройства");
  }

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
    maybeRestoreUndoButton();
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

  // ─────────────── Отправка ───────────────
  // Продолжить ответ, прерванный закрытием приложения. Идём тем же путём, что и
  // обычная отправка (в историю попадает прозрачная просьба дописать), поэтому
  // агент видит контекст и просто доводит задачу до конца.
  function continueInterruptedAnswer(chatId, m) {
    if (streaming) {
      toast("Дождись окончания текущего ответа");
      return;
    }
    const chat = chatsData.chats.find((c) => c.id === chatId);
    if (!chat) return;
    if (m) m.interrupted = false;
    if (chatsData.activeId !== chat.id) selectChat(chat.id);
    const input = $("input");
    input.value = "Продолжи предыдущий ответ с того места, где он прервался, и доведи задачу до конца. Не начинай заново и не повторяй уже сделанное.";
    autoResize();
    sendMessage();
  }

  // Один прогон агента в конкретном чате. Сюда идут И обычная отправка, И автозадача:
  // второй копии логики (история, сессия, стрим, завершение) быть не должно — иначе
  // починка в одном месте обходит другое.
  async function runTurn(chat, content, opts) {
    opts = opts || {};
    const usePlan = !!opts.plan;
    chat.messages.push({ id: uid(), role: "user", content, createdAt: Date.now() });
    const assistantMsg = { id: uid(), role: "assistant", content: "", pending: true, createdAt: Date.now() };
    if (usePlan) assistantMsg.plan = true;
    chat.messages.push(assistantMsg);
    renderSidebar();
    $("welcome").classList.add("hidden");
    $("messages").appendChild(buildMessageEl(chat.messages[chat.messages.length - 2]));
    $("messages").appendChild(buildMessageEl(assistantMsg));
    ChatFeed.scrollBottom();
    persistChats();
    setStreaming(true);

    // История уходит в main ЦЕЛИКОМ: там её держат в бюджете модели, а при переполнении
    // голова уходит в памятку (сжатие). Раньше история обрезалась здесь по ПОЛНОМУ бюджету
    // модели — на длинном чате срез схлопывался до одного последнего сообщения, сжатию было
    // нечего сворачивать, и агент терял задачу («перестаёт нормально работать»).
    let history = chat.messages
      .filter((m) => {
        if (!m || !m.content) return false;
        if (m.role === "user" || m.role === "assistant") return true;
        // Служебные заметки (перенос задачи из прошлого чата, восстановление после сбоя,
        // авто-переключение подключения) — тоже часть контекста.
        return m.role === "system";
      })
      .map((m) => ({ role: m.role, content: m.content }));

    session = { chatId: chat.id, assistantId: assistantMsg.id, segmentIds: [assistantMsg.id] };
    try {
      if (isElectron) {
        await api.sendMessage(history, { plan: usePlan, role: chat.role || "dev", chatId: chat.id });
      } else {
        webAbort = new AbortController();
        try {
          await WebChat.webSend(history, ChatEvents.onAiEvent, webAbort.signal, { plan: usePlan, role: chat.role || "dev", chatId: chat.id });
        } catch (e) {
          if (e.name !== "AbortError") ChatEvents.onAiEvent({ type: "error", message: e.message || String(e) });
        }
      }
    } finally {
      finishStream(chat, assistantMsg);
      session = null;
      webAbort = null;
      AutoTasks.flushAutoQueue(); // во время прогона автозадача ждала — самое время её запустить
    }
    return assistantMsg;
  }

  async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || streaming) return;
    lastUndoCount = 0; // новый запуск — счётчик отката обнуляется
    if (PlanPanel.planRotate(getActiveChat())) PlanPanel.renderPlanPanel();
    if (!settings.model) {
      // У чипов-действий («Создать файл» и т.п.) не получается выполнить задачу
      // без модели — показываем понятное сообщение в настройках.
      SettingsPanel.openSettings("model");
      SettingsPanel.setSettingsMsg(
        "Сначала выбери модель: провайдер → API-ключ (для облака) → кнопка «Проверить подключение» → клик по модели из списка → «Сохранить настройки». Пока модель не выбрана, команды агенту («создай файл…») выполнить нельзя.",
        true
      );
      return;
    }
    let chat = getActiveChat();
    if (!chat) chat = createChat();
    if (chat.title === "Новый чат") chat.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");

    const usePlan = planToggleOn;
    if (usePlan) {
      // Режим плана применяется к одному запросу, дальше выключается
      planToggleOn = false;
      $("btn-plan").classList.remove("active");
    }
    const content = pendingImage
      ? [{ type: "text", text }, { type: "image_url", image_url: { url: pendingImage } }]
      : text;
    hideAttachBar();
    input.value = "";
    autoResize();
    await runTurn(chat, content, { plan: usePlan });
  }

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
    persistChats: persistChats,
    renderSidebar: renderSidebar,
    selectChat: selectChat,
    runTurn: runTurn,
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
    persistChatsSoon: persistChatsSoon,
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
    getSettings: () => settings,
    setSettings: (s) => { settings = s; },
    getChatsData: () => chatsData,
    getSession: () => session,
    setLastUndoCount: (v) => { lastUndoCount = v; },
    setPlanCollapsed: (v) => PlanPanel.setPlanCollapsed(v),
    getRemoteRunNotified: () => remoteRunNotified,
    setRemoteRunNotified: (v) => { remoteRunNotified = v; },
    msgEls: msgEls,
    autoQueue: AutoTasks.autoQueue,
    flushAutoQueue: AutoTasks.flushAutoQueue,
    persistChatsSoon: persistChatsSoon,
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
    AgentCore: AgentCore,
    esc: (t) => ProjectPanel.esc(t),
    persistSettings: persistSettings,
    getSettings: () => settings,
    getProjectPanel: () => ProjectPanel,
    getYcPanel: () => YcPanel,
    getChatsData: () => chatsData,
    getStreaming: () => streaming,
    getActiveChat: getActiveChat,
    persistChatsNow: persistChatsNow,
    selectChat: selectChat,
    renderSidebar: renderSidebar,
    sendMessage: sendMessage,
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
    persistChats: persistChats,
    renderMessages: renderMessages,
    sendMessage: sendMessage,
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
    continueInterruptedAnswer: continueInterruptedAnswer,
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
    persistSettings: persistSettings,
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
    persistChats: persistChats,
    renderSidebar: renderSidebar,
  });

  // ── Секреты: пароли сайтов, почта и переменные окружения — код в src/renderer/secrets-panel.js ──
  const SecretsPanel = window.SecretsPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    persistSettings: persistSettings,
    getSettings: () => settings,
  });

  async function finishStream(chat, aMsg) {
    // Все сегменты текущего запуска: помечаем готовыми, пустые промежуточные убираем.
    const segs = ChatSegments.runSegments(chat, aMsg);
    const anyText = segs.some((s) => s.content && !s.error);
    const kept = [];
    for (const s of segs) {
      s.pending = false;
      if (!s.content && !s.error) {
        if (!anyText && segs.indexOf(s) === segs.length - 1) s.content = "…";
        else {
          ChatSegments.removeSegment(chat, s);
          continue;
        }
      }
      kept.push(s);
    }
    const lastSeg = kept[kept.length - 1] || aMsg;
    setStreaming(false);
    persistChatsNow();
    renderSidebar();
    const el = msgEls.get(lastSeg.id);
    if (el) {
      const b = el.querySelector(".bubble");
      if (b) {
        if (lastSeg.error) {
          b.textContent = lastSeg.error;
        } else {
          b.classList.add("md");
          b.innerHTML = ChatRender.msgHtml(lastSeg.content) || "…";
        }
        b.classList.remove("pending");
      }
    }
    ChatWork.finishGroup();
    // Ответ готов: сворачиваем блок «Размышление», если пользователь сам его не трогал
    for (const s of kept) {
      const sEl = msgEls.get(s.id);
      if (!sEl) continue;
      ChatThinking.collapseThinkBox(sEl);
    }
    // Кнопки действий под ответом: выполнить план / отменить изменения агента
    if (el && !lastSeg.error) {
      if (lastSeg.plan && lastSeg.content) {
        let actRow = el.querySelector(".ai-actions");
        if (!actRow) {
          actRow = document.createElement("div");
          actRow.className = "ai-actions";
          el.appendChild(actRow);
        }
        const bGo = document.createElement("button");
        bGo.className = "btn btn-primary btn-small";
        bGo.textContent = "▶ Выполнить план";
        bGo.onclick = () => {
          if (streaming) return;
          lastSeg.plan = false;
          const cur = getActiveChat();
          if (!cur) return;
          // Отправляем короткую команду — модель видит предыдущий план в истории
          const inp = $("input");
          inp.value = "Выполни план, который ты составил. Не пересказывай план — сразу действуй.";
          autoResize();
          sendMessage();
        };
        actRow.appendChild(bGo);
      }
      if (isElectron) {
        let n = lastUndoCount;
        if (!n) {
          try {
            const st = await api.undoStatus();
            n = st && st.ok ? st.count : 0;
          } catch {}
        }
        if (n > 0) addUndoButton(el);
      }
    }
    ChatWork.resetGroup();
  }

  // Кнопка «Отменить изменения агента» под ответом (чекпоинт последнего запуска).
  // Используется и сразу после ответа, и после перезапуска приложения (чекпоинт на диске).
  function addUndoButton(el) {
    if (!el) return;
    let actRow = el.querySelector(".ai-actions");
    if (!actRow) {
      actRow = document.createElement("div");
      actRow.className = "ai-actions";
      el.appendChild(actRow);
    }
    const bUndo = document.createElement("button");
    bUndo.className = "btn btn-ghost btn-small";
    bUndo.textContent = "↩ Отменить изменения агента (" + (lastUndoCount || 0) + ")";
    bUndo.title = "Вернуть файлы к состоянию до этого ответа";
    bUndo.onclick = async () => {
      if (streaming) return;
      const r = await api.undoRollback();
      lastUndoCount = 0;
      if (r && r.ok) {
        ProjectPanel.toastShort("✅ Отменено: " + (r.count || 0) + " файлов");
        bUndo.remove();
        if (!$("project-panel").classList.contains("hidden")) ProjectPanel.refreshProject();
      } else {
        toast("Не удалось отменить изменения");
      }
    };
    actRow.appendChild(bUndo);
  }

  // После перезапуска приложения чекпоинт изменений агента (undo.json) ещё жив —
  // показываем кнопку отката под последним ответом. Вызывается из renderMessages
  // (первый рендер), дальше — один раз, чтобы не дублировать кнопку при смене чатов.
  let undoRestoreShown = false;
  function maybeRestoreUndoButton() {
    if (undoRestoreShown || !isElectron) return;
    undoRestoreShown = true;
    api.undoStatus().then((st) => {
      if (!(st && st.ok && st.count > 0)) return;
      lastUndoCount = st.count;
      const chat = getActiveChat();
      const lastAssistant =
        chat && [...chat.messages].reverse().find((m) => m.role === "assistant" && !m.error);
      if (lastAssistant) addUndoButton(msgEls.get(lastAssistant.id));
    });
  }

  // Баннер «нужна модель» на приветственном экране. Бейдж модели всегда статичен.
  function updateModelNeeded() {
    const chat = getActiveChat();
    const show = !settings.model && (!chat || !chat.messages.length);
    $("model-needed").classList.toggle("hidden", !show);
    SettingsPanel.updateBadge();
  }


  function setStreaming(v) {
    streaming = v;
    $("typing").classList.toggle("hidden", !v);
    $("btn-stop").classList.toggle("hidden", !v);
    $("btn-send").classList.toggle("hidden", v);
  }

  function stop() {
    if (isElectron) api.stopMessage();
    else if (webAbort) webAbort.abort();
  }

  // ─────────────── Сохранённые OpenAI-подключения ───────────────
  // Код живёт в src/renderer/openai-profiles.js. Сборка стоит раньше веб-режима:
  // тот берёт список подключений своим входом (OpenaiProfiles.arr).
  const OpenaiProfiles = window.OpenaiProfiles({
    $: $,
    uid: uid,
    getSettings: () => settings,
    PRESETS: PRESETS,
    persistSettings: persistSettings,
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
    persistSettings: persistSettings,
    onEvent: ChatEvents.onAiEvent, // то же окно событий, что и у desktop-цикла
    openAskModal: AskModal.openAskModal,
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
    persistSettings: persistSettings,
    updateStatusBar: () => ProjectPanel.updateStatusBar(),
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

  // Полоска заполняемости контекста модели под полем ввода (приходит событием "context").
  function renderContext(ev) {
    const el = $("ctx-indicator");
    if (!el || !$("ctx-fill") || !$("ctx-text")) return;
    const used = Number((ev && ev.used) || 0);
    const budget = Number((ev && ev.budget) || 0);
    // Процент считаем от бюджета: при переполнении он честно больше 100, а не
    // «упирается» в 100 (раньше при 62 000 из 50 000 показывалось «100%»).
    const pct = budget > 0 ? Math.round((used / budget) * 100) : Math.max(0, parseInt(ev && ev.percent, 10) || 0);
    const barPct = Math.max(0, Math.min(100, pct));
    const fill = $("ctx-fill");
    fill.style.width = barPct + "%";
    fill.classList.toggle("warn", barPct >= 75 && barPct < 92);
    fill.classList.toggle("danger", barPct >= 92);
    $("ctx-text").textContent = "🧠 " + fmtTokens(used) + " / " + fmtTokens(budget) + " · " + pct + "%";
    el.classList.add("visible");
    el.title =
      "Контекст модели: занято " + used.toLocaleString("ru-RU") + " из " + budget.toLocaleString("ru-RU") +
      " токенов (" + pct + "%). Это история переписки и схема инструментов; оценка приблизительная (по символам), а не точный счёт токенов модели." +
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

  $("btn-send").onclick = sendMessage;
  $("btn-stop").onclick = stop;
  $("btn-plan").onclick = () => {
    if (streaming) return;
    planToggleOn = !planToggleOn;
    $("btn-plan").classList.toggle("active", planToggleOn);
    if (planToggleOn) toast("📋 Режим плана: сначала план и подтверждение, потом действия");
  };
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("input").addEventListener("input", autoResize);
  $("input").addEventListener("paste", onInputPaste);
  $("btn-attach-remove").onclick = hideAttachBar;
  $("chat-title").addEventListener("dblclick", ChatRename.startRenameChat);
  $("btn-new-chat").onclick = () => {
    if (!streaming) createChat();
  };
  // Контекст для кнопки «Продолжить контекст предыдущего чата»: переносим не только
  // последний ответ, а суть задачи — последний запрос пользователя, последний ответ
  // агента и хвост диалога. Ограничено по символам: перенос должен быть компактным,
  // а не копией всего чата.
  function buildContinuationContext(prev) {
    const CONTEXT_LIMIT = 6000;
    const textOf = (m) => {
      const c = m && m.content;
      if (typeof c === "string") return c.trim();
      if (Array.isArray(c)) {
        return c.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n").trim();
      }
      return "";
    };
    const turns = [];
    for (const m of prev.messages) {
      if (!m || m.role === "tool") continue;
      const t = textOf(m);
      if (!t) continue;
      turns.push({ role: m.role, text: t });
    }
    let lastUserId = -1;
    let lastAssistantId = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (lastUserId < 0 && turns[i].role === "user") lastUserId = i;
      if (lastAssistantId < 0 && turns[i].role === "assistant") lastAssistantId = i;
      if (lastUserId >= 0 && lastAssistantId >= 0) break;
    }
    const lastUser = lastUserId >= 0 ? turns[lastUserId].text : "";
    const lastAssistant = lastAssistantId >= 0 ? turns[lastAssistantId].text : "";
    // Хвост собираем с конца: свежие реплики важнее ранних.
    const tail = [];
    let used = 900 + lastUser.length + lastAssistant.length;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (i === lastUserId || i === lastAssistantId) continue;
      const t = turns[i];
      const label = t.role === "user" ? "Пользователь" : t.role === "assistant" ? "Агент" : "Заметка";
      const part = label + ": " + t.text;
      if (used + part.length > CONTEXT_LIMIT) break;
      used += part.length;
      tail.unshift(part);
    }
    const title = prev.title && prev.title !== "Новый чат" ? prev.title : "";
    const out = ["ПРОДОЛЖЕНИЕ ПРЕДЫДУЩЕГО ЧАТА (перенесено из другого чата — считай сделанное сделанным и не начинай заново)."];
    if (title) out.push("Тема/задача: " + title);
    if (lastUser) out.push("", "Последний запрос пользователя:", lastUser.slice(0, 2500));
    if (lastAssistant) out.push("", "Последний ответ агента:", lastAssistant.slice(0, 2500));
    if (tail.length) out.push("", "Хвост диалога (последние реплики):", tail.join("\n"));
    return out.join("\n");
  }
  $("btn-continue-chat").onclick = () => {
    if (streaming) return;
    const prev = getActiveChat();
    if (!prev || !prev.messages.length) { createChat(); return; }
    const title = prev.title && prev.title !== "Новый чат" ? prev.title : "";
    createChat({
      contextMsg: buildContinuationContext(prev),
      title: title ? title + " (продолжение)" : "Новый чат (продолжение)",
    });
  };
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
    sendMessage();
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
    persistSettings();
    SettingsPanel.loadModels();
  };
  $("btn-refresh-anth-models").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    persistSettings();
    SettingsPanel.loadModels();
  };
  $("btn-refresh-ollama-models").onclick = () => {
    SettingsPanel.collectSettingsFromUI();
    persistSettings();
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
    persistSettings();
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
    const p = await api.pickDirectory();
    if (p) $("s-workdir").value = p;
  };

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
    persistSettings: persistSettings,
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
    stop: stop,
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
        sendMessage();
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
      if (streaming && e.isTrusted) stop();
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
  loadState().then(() => {
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
      if (typeof api.onChatsReload === "function") api.onChatsReload(() => reloadChatsFromDisk());
      ProjectPanel.wireGithubEvents();
    }
  });
})();

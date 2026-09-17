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
  let g4fProviderQuery = ""; // поиск по провайдерам G4F в настройках
  let g4fProbeLastTs = 0; // авто-подбор порта G4F: не чаще раза в 30 секунд
  const msgEls = new Map();

  // ── Выбор провайдера G4F (аккордеон в настройках): поиск по буквам + список ──
  // Клик по провайдеру подставляет маршрут «Провайдер:модель» в поле модели.
  function renderG4fProviderList() {
    const list = $("g4f-provider-list");
    const status = $("g4f-provider-status");
    if (!list) return;
    const q = g4fProviderQuery.trim().toLowerCase();
    const provs = G4F_PROVIDERS.filter(
      (p) => !q || p.name.toLowerCase().includes(q) || (p.desc || "").toLowerCase().includes(q)
    );
    list.innerHTML = "";
    if (!provs.length) {
      if (status) {
        status.textContent = "Поиск «" + g4fProviderQuery + "»: ничего не найдено. Попробуй другие буквы (например: deep, chat, open, qwen).";
        status.className = "gh-repos-status err";
      }
      return;
    }
    if (status) {
      status.textContent = g4fProviderQuery.trim()
        ? "Поиск «" + g4fProviderQuery + "»: найдено " + provs.length + " — нажми на провайдера, его модели появятся ниже."
        : "Провайдеров G4F: " + provs.length + " (★ — стабильные, без ключа). Нажми — подставится «Провайдер:модель», модели покажутся ниже.";
      status.className = "gh-repos-status";
    }
    const curModel = ($("s-openai-model").value || "").trim();
    for (const p of provs) {
      const isSelected = curModel.toLowerCase().startsWith(p.name.toLowerCase() + ":");
      const item = document.createElement("div");
      item.className = "gh-repo-item" + (isSelected ? " selected" : "");
      item.innerHTML =
        '<span class="repo-icon">' + (p.rec ? "★" : "◆") + "</span>" +
        '<span class="repo-info">' +
        '<span class="repo-slug">' + ProjectPanel.escHtml(p.name) + "</span>" +
        '<span class="repo-meta">' + ProjectPanel.escHtml(p.desc || "") + "</span>" +
        "</span>" +
        '<button type="button" class="repo-test-btn" title="Проверить провайдера: что отвечает g4f и какие модели отдаёт (логи — в консоль)">▶</button>' +
        (isSelected ? '<span class="repo-check">✓</span>' : "");
      const testBtn = item.querySelector(".repo-test-btn");
      if (testBtn) {
        testBtn.onclick = (e) => {
          e.stopPropagation();
          testG4fProvider(p);
        };
      }
      item.onclick = () => {
        // «default» — авто-режим G4F: сам выберет провайдера и модель
        $("s-openai-model").value = p.name === "default" ? "default" : p.name + ":";
        $("s-openai-model").focus();
        // Сразу показываем модели провайдера (офлайн-подсказки из реестра),
        // затем тихо пробуем подгрузить точный список из запущенного g4f.
        SettingsPanel.renderModelHints("openai", p.name === "default" ? null : (p.models && p.models.length ? p.models : null));
        renderG4fProviderList();
        refreshG4fModels(p.name);
        SettingsPanel.setSettingsMsg(
          p.name === "default"
            ? "Авто-режим G4F: модель «default» — G4F сам подберёт провайдера. Сохрани настройки и общайся."
            : (p.models && p.models.length
                ? "Провайдер «" + p.name + "» выбран — его модели показаны ниже, нажми нужную. Точный список от g4f подтягивается автоматически."
                : "Маршрут через «" + p.name + "» вставлен в поле модели. Допиши имя модели (или нажми ↻, чтобы увидеть список моделей) и сохрани настройки."),
          false
        );
      };
      list.appendChild(item);
    }
  }

  // Счётчик запросов: ответ живого списка применяем, только если провайдер не сменился
  let g4fModelReqSeq = 0;
  // Живой список моделей G4F (после выбора провайдера). Тихий: если g4f не запущен —
  // ничего не делаем, остаются офлайн-подсказки из реестра (никаких ошибок в UI).
  async function refreshG4fModels(providerName) {
    if (!providerName || providerName === "default") return;
    const seq = ++g4fModelReqSeq;
    const prov = G4F_PROVIDERS.find((p) => p.name === providerName);
    const registryModels = (prov && prov.models) || [];
    try {
      const res = await SettingsPanel.requestModelsList();
      if (seq !== g4fModelReqSeq) return; // пользователь успел выбрать другого провайдера
      if (!Array.isArray(res) || !res.length) {
        // g4f молчит — оставляем реестровые подсказки провайдера как есть
        if (registryModels.length) SettingsPanel.renderModelHints("openai", registryModels);
        return;
      }
      // Реестровые модели провайдера — ПЕРВЫЕ (реальные имена: DeepSeek-V3, Qwen…),
      // живые алиасы от g4f дописываются следом; дубликаты убираются.
      // Так живой список НЕ подменяет настоящие модели провайдера.
      const prefix = providerName + ":";
      const known = G4F_PROVIDERS;
      const seen = new Set();
      const merged = [];
      for (const rm of registryModels) {
        const full = String(rm || "").trim();
        if (full && !seen.has(full)) {
          seen.add(full);
          merged.push(full);
        }
      }
      for (const m of res) {
        if (typeof m !== "string" || !m.trim()) continue;
        const i = m.indexOf(":");
        const hasPrefix = i > 0 && known.some((p) => p.name === m.slice(0, i));
        const full = hasPrefix ? m.trim() : prefix + m.trim();
        if (!seen.has(full)) {
          seen.add(full);
          merged.push(full);
        }
      }
      if (!merged.length) return;
      SettingsPanel.renderModelHints("openai", merged);
      SettingsPanel.setSettingsMsg(
        "Провайдер «" + providerName + "»: " + merged.length + " моделей (настоящие из реестра + алиасы от g4f) — нажми нужную ниже.",
        false
      );
    } catch {
      // g4f не отвечает — оставляем офлайн-подсказки из реестра
    }
  }

  // Кнопка «▶» у провайдера: полный тест — что отвечает g4f и какие модели отдаёт.
  // Логи идут в панель «Консоль» (правая панель, вкладка console).
  async function testG4fProvider(p) {
    if (!p) return;
    const base = $(URL_INPUT.openai).value.trim();
    const curVal = ($("s-openai-model").value || "").trim();
    let model = "";
    if (p.name !== "default" && curVal.toLowerCase().startsWith(p.name.toLowerCase() + ":")) {
      model = curVal.slice(p.name.length + 1).trim();
    } else if (p.name !== "default" && p.models && p.models.length) {
      model = p.models[0];
    }
    // Открываем консоль, чтобы логи было видно сразу
    SidePanel.switchSideTab("console");
    SidePanel.termAppend('<div class="term-server"><span class="ts-err">▶ Тест провайдера «' + ProjectPanel.esc(p.name) + "»…</span></div>");
    let result;
    if (isElectron && api.g4fTest) {
      result = await api.g4fTest({ url: base, provider: p.name, model });
    } else {
      DevRun.termServerAppend('<span class="ts-err">Полный тест доступен в десктоп-приложении (в браузере локальный g4f недоступен).</span>');
      SettingsPanel.setSettingsMsg("Тест G4F доступен в приложении на ПК.", true);
      return;
    }
    const lines = (result && result.log) || [];
    let okCount = 0;
    let errCount = 0;
    for (const l of lines) {
      const cls = l.level === "err" ? "ts-err" : l.level === "ok" ? "ts-ok" : l.level === "warn" ? "ts-warn" : "ts-info";
      if (l.level === "err") errCount++;
      if (l.level === "ok") okCount++;
      DevRun.termServerAppend('<span class="' + cls + '">' + ProjectPanel.esc(l.text) + "</span>");
    }
    const verdict = errCount
      ? "Провайдер «" + p.name + "»: есть проблемы — смотри логи в консоли (правая панель)."
      : okCount
        ? "Провайдер «" + p.name + "» отвечает — подробности в консоли."
        : "Провайдер «" + p.name + "»: ответов нет — подробности в консоли.";
    SettingsPanel.setSettingsMsg(verdict, !!errCount);
  }

  // Авто-подбор порта G4F: если в поле URL ничего не отвечает, а живой g4f есть
  // на 1337 / 8080 — подставляем рабочий адрес (только для localhost, чтобы не
  // затирать вручную вписанный туннель/сетевой адрес).
  async function probeG4fPort() {
    if (!isElectron || !api.g4fProbe) return;
    const input = $("s-openai-url");
    const current = (input.value || "").trim();
    try {
      const r = await api.g4fProbe({ url: current });
      if (!r || r.ok === false || !r.base) return;
      const norm = current.replace(/\/+$/, "");
      if (r.base === norm) return;
      if (/localhost|127\.0\.0\.1/i.test(current)) {
        input.value = r.base;
        SettingsPanel.setSettingsMsg("Найден живой G4F на «" + r.base + "» — URL обновлён автоматически. Сохрани настройки.", false);
      } else {
        SettingsPanel.setSettingsMsg("G4F отвечает на «" + r.base + "», а в поле указан «" + norm + "» — если это не тот адрес, поправь URL.", false);
      }
    } catch {}
  }

  // Скрытие/показ блока выбора провайдера при смене пресета и открытии настроек.
  // preset передаётся от кликнутого чипа, потому что наш слушатель срабатывает
  // раньше SettingsPanel.setPreset() и currentPreset ещё не обновился.
  function syncG4fProviderBox(preset) {
    const box = $("g4f-provider-box");
    if (!box) return;
    const active = preset || currentPreset;
    box.classList.toggle("hidden", active !== "g4f");
    if (active === "g4f") {
      renderG4fProviderList();
      // Авто-подбор порта при открытии настроек (не чаще раза в 30 секунд)
      const now = Date.now();
      if (now - g4fProbeLastTs > 30000) {
        g4fProbeLastTs = now;
        probeG4fPort();
      }
    }
  }
  function wireG4fProviderPicker() {
    const head = $("g4f-provider-head");
    const search = $("g4f-provider-search");
    const clear = $("g4f-provider-clear");
    if (head) {
      head.onclick = () => {
        const body = $("g4f-provider-body");
        const chev = $("g4f-prov-chev");
        const opening = body.classList.contains("hidden");
        body.classList.toggle("hidden", !opening);
        if (chev) chev.textContent = opening ? "▾" : "▸";
        if (opening) renderG4fProviderList();
      };
    }
    if (search && clear) {
      search.addEventListener("input", () => {
        g4fProviderQuery = search.value;
        clear.classList.toggle("hidden", !search.value.trim());
        renderG4fProviderList();
      });
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          search.value = "";
          g4fProviderQuery = "";
          clear.classList.add("hidden");
          renderG4fProviderList();
        }
      });
      clear.onclick = () => {
        search.value = "";
        g4fProviderQuery = "";
        clear.classList.add("hidden");
        renderG4fProviderList();
      };
    }
    // Переключение пресетов (чипы в настройках) и открытие окна настроек
    document.querySelectorAll(".chip[data-preset]").forEach((c) => {
      c.addEventListener("click", () => syncG4fProviderBox(c.dataset.preset));
    });
    const overlay = $("settings-overlay");
    if (overlay && window.MutationObserver) {
      new MutationObserver(() => {
        if (!overlay.classList.contains("hidden")) syncG4fProviderBox();
      }).observe(overlay, { attributes: true, attributeFilter: ["class"] });
    }
  }
  // Элементы настроек уже в DOM (скрипты в конце body) — вешаем события сразу
  wireG4fProviderPicker();

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

  // ─────────── План работ (todoWrite): панель-чеклист над панелью действий ───────────
  // Панель показывает ТОЛЬКО план, составленный моделью инструментом todoWrite.
  // Если модель плана не дала — панели нет вовсе: ход её действий и так виден в панели
  // работы над полем ввода, а дублирующий чеклист «что уже сделано» только путал
  // и выглядел ошибкой интерфейса.
  // Функции ниже чистые: они меняют только переданный объект чата и ничего не рисуют —
  // отрисовку и запись на диск делают вызывающие места (так это и тестируется).
  const PLAN_ICON = { pending: "⬜", in_progress: "🔄", done: "✅", failed: "⚠️" };
  const PLAN_TEXT = { pending: "ожидает", in_progress: "в работе", done: "готово", failed: "не удалось" };
  const PLAN_ARCHIVE_LIMIT = 5;

  function planProgress(items) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const done = list.filter((i) => i && i.status === "done").length;
    const failed = list.filter((i) => i && i.status === "failed").length;
    const active = list.find((i) => i && i.status === "in_progress");
    const percent = total ? Math.round(((done + failed) / total) * 100) : 0;
    return { total, done, failed, percent, active: active ? active.text : "", finished: total > 0 && done + failed === total };
  }

  function planArchive(chat, plan) {
    if (!chat || !plan || !Array.isArray(plan.items) || !plan.items.length) return;
    if (!Array.isArray(chat.planHistory)) chat.planHistory = [];
    chat.planHistory.unshift({
      title: plan.title || "",
      source: plan.source || "model",
      items: plan.items,
      updatedAt: plan.updatedAt || Date.now(),
    });
    if (chat.planHistory.length > PLAN_ARCHIVE_LIMIT) chat.planHistory.length = PLAN_ARCHIVE_LIMIT;
  }

  // План от модели (todoWrite). Слабая модель может прислать мусор — нормализатор
  // вернёт пустой список, и такой «план» просто не появится.
  function planFromModel(chat, ev) {
    if (!chat) return false;
    const items = AgentCore.normalizePlanTasks(ev && ev.tasks);
    if (!items.length) return false;
    // Заменяя план модели, предыдущий убираем в историю (не теряем контекст).
    if (chat.plan && chat.plan.source !== "auto") planArchive(chat, chat.plan);
    chat.plan = {
      title: String((ev && ev.title) || "").trim().slice(0, 80),
      source: "model",
      items,
      updatedAt: Date.now(),
    };
    return true;
  }

  // ── План, написанный моделью ТЕКСТОМ (не через todoWrite) ──
  // Слабые модели часто перечисляют шаги прямо в ответе («План: 1. … 2. …»). Раньше такой
  // план пропадал: панель питалась только todoWrite, и получалось «план составляет, а панели
  // с галочками нет». Теперь текст тоже становится чеклистом: заголовок («План», «План работ»,
  // «Шаги», «Todo») со списком пунктов или блок строк-чекбоксов (✅/⬜/🔄/⚠️).
  const PLAN_TEXT_MAX = 7;
  const PLAN_HEAD_RE = /^\s*(?:[>#*_+-]{0,4}\s*)?(?:\*\*|__)?\s*(план(?:\s+(?:работ|действий|выполнения|задач))?|шаги|порядок\s+действий|todo|to-do)\s*:?\s*(?:\*\*|__)?\s*$/i;
  // Заголовок в КОНЦЕ фразы, а не отдельной строкой: «План уже составлен. Сейчас нужно:», «Дальше по шагам:».
  // Ключевое слово обязательно: иначе любой абзац «что нужно:» со списком выглядел бы планом.
  const PLAN_TAIL_RE = /(?:план\w*|шаг\w*|этап\w*|дальше|теперь|нужно|надо|осталось|порядок\s+действий)[^:\n]{0,60}:\s*(?:\*\*|__)?\s*$/i;
  const PLAN_ITEM_RE = /^\s*(?:[-*•–—]\s+\S|\[[ xX]\]\s*\S|\d{1,2}[.)]\s+\S|(?:[Шш]аг|[Ээ]тап|[Ss]tep)\s*\d+\s*[:.)]\s*\S|[A-Za-zА-Яа-я]\)\s+\S|[✅☑✔⬜☐🔄⚠️⬛]\s*\S)/;
  const PLAN_TICK_RE = /^\s*[✅☑✔⬜☐🔄⚠️⬛]\s*\S/;
  // Слова-маркеры для плана без заголовка (см. planLinesFromText).
  const PLAN_WORD_RE = /(план\w*|шаг\w*|этап\w*|порядок\s+действий|дальше|осталось|todo)/i;

  // Собирает пункты плана, начиная со строки from. Пустые строки ВНУТРИ списка
  // пропускаем: модели печатают markdown «loose list» (пункты через пустую строку),
  // и раньше такой план терялся целиком — панель оставалась пустой.
  function collectPlanItems(lines, from) {
    const out = [];
    for (let j = Math.max(0, from); j < lines.length && out.length < PLAN_TEXT_MAX; j++) {
      const line = lines[j].replace(/\s+$/, "");
      if (!line.trim()) continue; // пустая строка внутри списка — не конец плана
      if (!PLAN_ITEM_RE.test(line)) break;
      out.push(line);
    }
    return out;
  }

  // Строки плана из текста ответа. Пусто — если плана в тексте нет (обычный ответ или
  // перечисление в прозе): заголовок обязателен, либо нужен блок чекбоксов из 2+ строк.
  function planLinesFromText(text) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!PLAN_HEAD_RE.test(lines[i]) && !PLAN_TAIL_RE.test(lines[i])) continue;
      const out = collectPlanItems(lines, i + 1);
      if (out.length >= 2) return out;
    }
    // Заголовка нет, но есть блок строк-чекбоксов — это тоже план (его и ждёт пользователь).
    let block = [];
    for (const row of lines) {
      const line = row.replace(/\s+$/, "");
      if (PLAN_TICK_RE.test(line)) { block.push(line); continue; }
      if (!line.trim() && block.length) continue;
      if (block.length >= 2) break;
      block = [];
    }
    if (block.length >= 2) return block.slice(0, PLAN_TEXT_MAX);
    // Совсем без заголовка: в тексте есть планирующее слово и нумерованный список из 3+
    // пунктов — это план («Задача разбивается на этапы: 1. … 2. … 3. …»). Порог в три
    // пункта и узкий список слов оставляют обычные отчёты со списком вне панели.
    if (PLAN_WORD_RE.test(raw)) {
      for (let i = 0; i < lines.length; i++) {
        if (!PLAN_ITEM_RE.test(lines[i])) continue;
        const out = collectPlanItems(lines, i);
        if (out.length >= 3) return out;
      }
    }
    return [];
  }

  // Заголовок плана из текста («План работ» и т.п.). Пусто → панель покажет «План работ».
  function planTitleFromText(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = line.match(PLAN_HEAD_RE);
      if (!m || !m[1]) continue;
      const t = String(m[1]).trim();
      if (t) return t.charAt(0).toUpperCase() + t.slice(1);
    }
    return "";
  }

  // План из текста. Настоящий план модели (todoWrite) всегда важнее текстового.
  function planFromText(chat, text) {
    if (!chat) return false;
    if (chat.plan && chat.plan.source === "model") return false;
    const lines = planLinesFromText(text);
    if (lines.length < 2) return false;
    const items = AgentCore.normalizePlanTasks(lines);
    if (items.length < 2) return false; // один пункт — это фраза, а не план
    if (chat.plan && chat.plan.source === "text") {
      const old = chat.plan.items;
      const same = old.map((i) => i.text).join("|") === items.map((i) => i.text).join("|");
      if (same) return false; // тот же план — статусы не сбрасываем
      // План печатается прямо сейчас: старые пункты — начало нового списка. Значит это ТОТ ЖЕ
      // план, просто стрим дошёл до следующих строк: в историю его не убираем, а статусы уже
      // пройденных пунктов сохраняем (иначе галочки прыгали бы назад на каждом куске).
      const grows = old.length <= items.length && old.every((it, i) => it.text === items[i].text);
      if (grows) {
        for (let i = 0; i < old.length; i++) items[i].status = old[i].status;
        chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
        return true;
      }
      planArchive(chat, chat.plan);
    }
    chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
    return true;
  }

  // Прогресс текстового плана: модель статусы не присылает, поэтому галочки двигает сам факт
  // работы — перед раундом действий первый пункт встаёт «в работе», после раунда — готов.
  function planTextAdvance(chat, ok) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const items = chat.plan.items;
    const cur = items.find((i) => i.status === "in_progress");
    if (!cur) {
      const first = items.find((i) => i.status === "pending");
      if (!first) return false;
      first.status = "in_progress";
      chat.plan.updatedAt = Date.now();
      return true;
    }
    if (!ok) return false; // провал шага отмечает planToolOutcome
    cur.status = "done";
    const next = items.find((i) => i.status === "pending");
    if (next) next.status = "in_progress";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Запуск закончился: незакрытый пункт текстового плана отмечаем готовым.
  function planTextFinish(chat) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const cur = chat.plan.items.find((i) => i.status === "in_progress");
    if (!cur) return false;
    cur.status = "done";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Начался новый раунд ответа (текст или размышления после действий) — предыдущий пункт
  // текстового плана фактически выполнен. Один пункт на раунд: segId защищает от повторов
  // (размышления и текст в одном раунде открывают сегмент лишь один раз).
  function planRoundStarted(chat, segId) {
    if (!chat || !chat.plan || chat.plan.source !== "text") return false;
    if (!segId || chat.plan.advancedFor === segId) return false;
    if (!planTextAdvance(chat, true)) return false;
    chat.plan.advancedFor = segId;
    renderPlanPanel();
    persistChatsSoon();
    return true;
  }

  // Весь текст текущего запуска — ответ И размышления: источник для разбора плана.
  // Размышления обязательны: слабые и локальные модели пишут план именно там
  // («План уже составлен. Сейчас нужно: 1. … 2. …»), а в самом ответе плана нет вовсе —
  // поэтому панель и оставалась пустой, хотя модель «составила план».
  function runTextOf(chat, aMsg) {
    const parts = [];
    for (const s of ChatSegments.runSegments(chat, aMsg)) {
      if (!s) continue;
      if (s.thinking) parts.push(String(s.thinking));
      if (s.content) parts.push(String(s.content));
    }
    return parts.join("\n");
  }

  // Разбор плана из текста запуска. Во время стрима вызывается на каждом куске, поэтому
  // сначала дешёвый гейт: без нескольких строк плана быть не может — регекспы не гоняем.
  function tryPlanFromRunText(chat, aMsg) {
    const text = runTextOf(chat, aMsg);
    if ((text.match(/\n/g) || []).length < 2) return false;
    const hadPlan = !!(chat && chat.plan);
    if (planFromText(chat, runTextOf(chat, aMsg))) {
      planCollapsed = false; // план только что появился — показываем его развёрнутым
      renderPlanPanel();
      persistChatsSoon();
      // Панель плана живёт над полем ввода, и её легко не заметить — сообщаем один раз
      // на план (дальнейшие уточнения плана тост не повторяют).
      if (!hadPlan) toast("📋 Модель составила план — чеклист над полем ввода");
      return true;
    }
    return false;
  }

  // Результат инструмента. Статусы пунктов ведёт модель, но если её текущий шаг
  // фактически упал — показываем ⚠️, а не «в работе»: слепо доверять плану нельзя.
  function planToolOutcome(chat, ev, ok) {
    if (!chat || !chat.plan || !Array.isArray(chat.plan.items)) return false;
    if (!ok) {
      for (let i = chat.plan.items.length - 1; i >= 0; i--) {
        const it = chat.plan.items[i];
        if (it.status !== "in_progress") continue;
        it.status = "failed";
        if (!it.note) it.note = "шаг не удался — см. результат инструмента";
        chat.plan.updatedAt = Date.now();
        return true;
      }
    }
    return false;
  }

  // Новый запрос пользователя: завершённый план — в историю, незавершённый
  // остаётся (при «продолжай» агент видит, что осталось).
  function planRotate(chat) {
    if (!chat || !chat.plan) return false;
    if (planProgress(chat.plan.items).finished) { planArchive(chat, chat.plan); chat.plan = null; return true; }
    return false;
  }
  // ─────────── /План работ ───────────
  // Панель плана: отдельный контейнер над панелью действий — она не сбрасывается
  // вместе с ходом работ и не уезжает при прокрутке списка действий.
  let planCollapsed = false;
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

  function renderPlanPanel() {
    const host = $("plan-panel");
    if (!host) return;
    const chat = getActiveChat();
    // Панель только для плана модели. Старые авто-списки из chats.json (source "auto")
    // не показываем: они и есть тот самый «ход работы», который дублировал панель действий.
    const plan =
      chat && chat.plan && chat.plan.source !== "auto" && Array.isArray(chat.plan.items) && chat.plan.items.length
        ? chat.plan
        : null;
    if (!plan) {
      host.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    const pr = planProgress(plan.items);
    host.classList.remove("hidden");
    host.innerHTML = "";
    const group = document.createElement("div");
    group.className = "plan-group" + (pr.finished ? " finished" : "") + (planCollapsed ? "" : " expanded");

    const head = document.createElement("div");
    head.className = "plan-head";
    head.title = "Показать/скрыть план работ";
    head.onclick = (e) => {
      e.stopPropagation();
      planCollapsed = !planCollapsed;
      renderPlanPanel();
    };
    const dot = document.createElement("span");
    dot.className = "plan-dot";
    const title = document.createElement("span");
    title.className = "plan-title";
    title.textContent = "📋 " + (plan.title || "План работ");
    const count = document.createElement("span");
    count.className = "plan-count";
    count.textContent = pr.done + "/" + pr.total + (pr.failed ? " ⚠" + pr.failed : "");
    count.title = "Готово " + pr.done + " из " + pr.total + (pr.failed ? ", не удалось: " + pr.failed : "");
    head.appendChild(dot);
    head.appendChild(title);
    // Свёрнутая панель: видно, какой шаг выполняется прямо сейчас (разворачивать не нужно).
    if (planCollapsed && pr.active && !pr.finished) {
      const act = document.createElement("span");
      act.className = "plan-active";
      act.textContent = PLAN_ICON.in_progress + " " + pr.active;
      act.title = "Сейчас в работе: " + pr.active;
      head.appendChild(act);
    }
    head.appendChild(count);
    // Кнопка «выполнить план» — только когда план составлен моделью и ждёт запуска
    // (в режиме плана инструменты не выполнялись).
    if (planPending(chat)) {
      const run = document.createElement("button");
      run.className = "btn btn-primary btn-small plan-run";
      run.textContent = "▶ Выполнить";
      run.onclick = (e) => {
        e.stopPropagation();
        if (streaming) return;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].role === "assistant") { chat.messages[i].plan = false; break; }
        }
        const inp = $("input");
        inp.value = "Выполни план, который ты составил. Обновляй его через todoWrite после каждого шага.";
        autoResize();
        sendMessage();
      };
      head.appendChild(run);
    }
    const clear = document.createElement("button");
    clear.className = "plan-clear";
    clear.textContent = "✕";
    clear.title = "Убрать план с экрана (уйдёт в историю планов чата)";
    clear.onclick = (e) => {
      e.stopPropagation();
      planArchive(chat, chat.plan);
      chat.plan = null;
      renderPlanPanel();
      persistChatsSoon();
    };
    const chev = document.createElement("span");
    chev.className = "plan-chev";
    chev.textContent = planCollapsed ? "▸" : "▾";
    head.appendChild(clear);
    head.appendChild(chev);
    group.appendChild(head);

    const bar = document.createElement("div");
    bar.className = "plan-bar";
    const fill = document.createElement("div");
    fill.className = "plan-fill";
    fill.style.width = pr.percent + "%";
    bar.appendChild(fill);
    group.appendChild(bar);

    const body = document.createElement("div");
    body.className = "plan-body";
    for (const it of plan.items) {
      const row = document.createElement("div");
      row.className = "plan-item " + (PLAN_ICON[it.status] ? "st-" + it.status : "st-pending");
      const ic = document.createElement("span");
      ic.className = "plan-ic";
      ic.textContent = PLAN_ICON[it.status] || PLAN_ICON.pending;
      const tx = document.createElement("span");
      tx.className = "plan-txt";
      tx.textContent = it.text;
      row.appendChild(ic);
      row.appendChild(tx);
      if (it.note) {
        const nt = document.createElement("span");
        nt.className = "plan-note";
        nt.textContent = it.note;
        row.appendChild(nt);
      } else {
        row.title = PLAN_TEXT[it.status] || "";
      }
      body.appendChild(row);
    }
    group.appendChild(body);
    host.appendChild(group);
  }

  // Ждёт ли план запуска: последний ответ ассистента помечен режимом плана.
  function planPending(chat) {
    if (!chat || !Array.isArray(chat.messages)) return false;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role !== "assistant") continue;
      return !!m.plan;
    }
    return false;
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
    renderPlanPanel();
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
          await WebChat.webSend(history, onAiEvent, webAbort.signal, { plan: usePlan, role: chat.role || "dev", chatId: chat.id });
        } catch (e) {
          if (e.name !== "AbortError") onAiEvent({ type: "error", message: e.message || String(e) });
        }
      }
    } finally {
      finishStream(chat, assistantMsg);
      session = null;
      webAbort = null;
      flushAutoQueue(); // во время прогона автозадача ждала — самое время её запустить
    }
    return assistantMsg;
  }

  async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || streaming) return;
    lastUndoCount = 0; // новый запуск — счётчик отката обнуляется
    if (planRotate(getActiveChat())) renderPlanPanel();
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

  // ─────────────── Автозадачи (планировщик дел) ───────────────
  // Дело с отметкой «выполняет агент» приложение запускает само по сроку: агент молча
  // работает в отдельном чате «Автозадачи», ответ остаётся там. Если в этот момент идёт
  // другой прогон — автозадача встаёт в очередь и стартует сразу после него.
  const AUTO_CHAT_TITLE = "Автозадачи";
  const autoQueue = [];

  function ensureAutoChat() {
    let chat = chatsData.chats.find((c) => c.auto === true);
    if (chat) return chat;
    chat = createChat({ title: AUTO_CHAT_TITLE });
    chat.auto = true;
    chat.role = "manager";
    chat.messages.push({
      id: uid(),
      role: "system",
      content: "🗓 Это чат автозадач: сюда приложение складывает дела, которые агент выполняет сам по сроку. Задачи появляются здесь без твоего участия — можно просто читать ответы.",
      createdAt: Date.now(),
    });
    persistChats();
    renderSidebar();
    return chat;
  }

  function autoTaskText(t) {
    const what = String(t.prompt || "").trim() || "Выполни это дело и кратко напиши результат.";
    return "⏰ Автозадача по сроку: «" + t.title + "»\n\n" + what;
  }

  // «▶ Сейчас» из строки дела: тот же прогон, что и по сроку, но не по сроку и без правки
  // расписания (manual) — чтобы человек мог проверить запуск, не дожидаясь часа.
  function startAutoRunNow(t) {
    if (!isElectron) { toast("Дела: автозапуск работает в приложении на ПК"); return; }
    if (!t || !t.id) return;
    if (!t.auto) { toast("Дела: сначала включи «▶ агент» в строке дела"); return; }
    if (streaming) { toast("⏰ Агент занят другим прогоном — нажми «▶ сейчас» чуть позже"); return; }
    runAutoTask({
      id: t.id,
      title: t.title,
      prompt: t.prompt || "",
      note: t.note || "",
      repeat: t.repeat || "",
      due: t.due,
      auto: true,
      manual: true,
    });
  }

  function flushAutoQueue() {
    if (streaming || !autoQueue.length) return;
    runAutoTask(autoQueue.shift());
  }

  // Подтверждение планировщику. Раньше его не было, и дело считалось запущенным ещё
  // до прогона: не хватило модели, сорвался запрос, кончился прогон — и автозадача
  // больше не срабатывала НИКОГДА. Теперь планировщик повторяет попытку и в конце
  // говорит человеку вслух.
  function autoAck(task, ok, error) {
    if (!task || !task.id || task.manual) return;
    try {
      if (api && api.tasksAutoAck) api.tasksAutoAck(task.id, ok !== false, error || "");
    } catch {}
  }

  async function runAutoTask(task) {
    // Автозадачу выполняет ПК-клиент: у чатов один хозяин, иначе прогон удвоился бы
    // (событие срока уходит и на телефон).
    if (!isElectron) return;
    if (!task || !task.id) return;
    if (streaming) {
      if (task.manual) { toast("⏰ Агент занят другим прогоном — нажми «▶ сейчас» чуть позже"); return; }
      if (!autoQueue.some((q) => q.id === task.id)) autoQueue.push(task);
      return;
    }
    if (!settings.model) {
      autoAck(task, false, "не выбрана модель");
      toast("⏰ Дело «" + task.title + "» — автозапуск отложен: не выбрана модель");
      return;
    }
    const chat = ensureAutoChat();
    if (chatsData.activeId !== chat.id) selectChat(chat.id);
    autoAck(task, true); // прогон начинается — срок закрыт, повтор сдвигается
    let assistantMsg = null;
    try {
      assistantMsg = await runTurn(chat, autoTaskText(task), {});
    } catch (e) {
      autoAck(task, false, "прогон сорвался: " + (e && e.message ? e.message : e));
      toast("⏰ Автозадача «" + task.title + "» сорвалась — смотри чат «Автозадачи»");
      return;
    }
    if (assistantMsg && assistantMsg.error) {
      toast("⏰ Автозадача «" + task.title + "» не выполнилась — смотри чат «Автозадачи»");
      return;
    }
    // Разовое дело после выполнения закрываем: сделано — висеть просроченным незачем.
    if (!task.repeat && api && api.tasksDone) {
      try { await api.tasksDone(task.id); } catch {}
      TasksMission.renderTasks();
    }
    // Ручной прогон удался — снимаем «сдался», планировщик снова берёт это дело.
    if (task.manual && task.auto && api && api.tasksAutoRearm) {
      try { await api.tasksAutoRearm(task.id); } catch {}
      TasksMission.renderTasks();
    }
  }

  // ─── Сегменты ответа: лог «текст → действия → текст» — код в src/renderer/chat-segments.js ───
  const ChatSegments = window.ChatSegments({
    $: $,
    uid: uid,
    getSession: () => session,
    msgEls: msgEls,
    buildMessageEl: buildMessageEl,
    scrollBottom: ChatFeed.scrollBottom,
    persistChatsSoon: persistChatsSoon,
    planRoundStarted: planRoundStarted,
  });

  function onAiEvent(ev) {
    // Служебная заметка прогона (например, ожидание лимита провайдера). Показываем тостом:
    // в «Консоль» за этим никто не следит, а ждать приходится молча и помногу.
    if (ev && ev.type === "notice") {
      if (ev.text) toast(ev.text);
      return;
    }
    // Напоминание о деле приходит вне прогона агента: тост + обновление панели.
    if (ev && ev.type === "task-reminder") {
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      if (list.length) {
        const late = list.filter((t) => t.late).length;
        const text = list.length === 1
          ? (late ? "⚠ Просрочено: " : "⏰ Срок: ") + list[0].title
          : late ? "⚠ Просроченных дел: " + late : "⏰ Подошёл срок: " + list.length + " дел";
        toast(text);
      }
      TasksMission.renderTasks();
      return;
    }
    // Срок автозадачи: приложение будит агента само (чат «Автозадачи»).
    if (ev && ev.type === "task-due") {
      if (!isElectron) return;
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      for (const t of list) {
        // Планировщик повторяет попытку, пока прогон не подтвердится, — в очередь
        // одно и то же дело попадает один раз.
        if (t && t.id && !autoQueue.some((q) => q.id === t.id)) autoQueue.push(t);
      }
      flushAutoQueue();
      return;
    }
    // Автозадача так и не запустилась — об этом надо сказать вслух, а не молчать.
    if (ev && ev.type === "task-auto-failed") {
      const list = Array.isArray(ev.tasks) ? ev.tasks : [];
      if (list.length === 1) {
        const one = list[0];
        toast("⚠ Автозадача «" + one.title + "» не запустилась" + (one.error ? ": " + one.error : ""));
      } else if (list.length > 1) {
        toast("⚠ Автозадач не запустилось: " + list.length);
      }
      TasksMission.renderTasks();
      return;
    }
    // Прогон запущен другим клиентом (обычно телефоном): у событий нет привязки к
    // переписке, поэтому в свой чат их не подмешиваем — иначе ответ с телефона
    // дописывался бы в открытую на ПК переписку. Результат придёт целиком через
    // chats:reload, когда телефон сохранит историю.
    if (ev && ev.from === "mobile" && !session) {
      if (!remoteRunNotified) {
        remoteRunNotified = true;
        toast("📱 Задача выполняется с телефона — результат появится здесь сам");
      }
      return;
    }
    const chat = session ? chatsData.chats.find((c) => c.id === session.chatId) : null;
    const aMsg = chat ? chat.messages.find((m) => m.id === session.assistantId) : null;
    switch (ev.type) {
      case "chunk": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content += ev.text;
          persistChatsSoon();
          ChatFeed.queueBubbleRender(chat, seg);
        }
        // План, написанный в ответе, показываем сразу, как только он сложился.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "thinking": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.thinking = (seg.thinking || "") + ev.text;
          persistChatsSoon();
          const el = msgEls.get(seg.id);
          if (el) {
            ChatThinking.ensureThinkBox(el, seg.thinking);
            ChatFeed.scrollBottomSoon();
          }
        }
        // План в размышлениях: локальные модели формулируют его именно там.
        tryPlanFromRunText(chat, aMsg);
        break;
      }
      case "plan": {
        // Модель вызвала todoWrite — показываем её план панелью-чеклистом.
        if (planFromModel(chat, ev)) {
          planCollapsed = false;
          renderPlanPanel();
          persistChatsSoon();
        }
        break;
      }
      case "tool_start":
        if (!chat) break;
        chat.messages.push({ id: uid(), role: "tool", toolName: ev.name, toolArgs: ev.args, toolResult: null, pending: true, createdAt: Date.now() });
        const toolEl = buildMessageEl(chat.messages[chat.messages.length - 1]);
        if (toolEl && toolEl.classList) toolEl.classList.add("in-work");
        ChatWork.addRow(toolEl);
        ChatWork.planAdd(ev);
        // Модель могла написать план текстом (или в размышлениях) вместо todoWrite —
        // разбираем его, чтобы панель-чеклист всё равно появилась.
        tryPlanFromRunText(chat, aMsg);
        // Работа пошла: текущий пункт текстового плана сразу становится «в работе»,
        // а не висит «ожидает» до конца раунда (иначе не видно, какой этап выполняется).
        if (
          chat &&
          chat.plan &&
          chat.plan.source === "text" &&
          Array.isArray(chat.plan.items) &&
          !chat.plan.items.some((i) => i.status === "in_progress")
        ) {
          if (planTextAdvance(chat, true)) renderPlanPanel();
        }
        ChatFeed.scrollBottom();
        persistChatsSoon();
        break;
      case "tool_result":
        if (!chat) break;
        let toolOk = true;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          const m = chat.messages[i];
          if (m.role === "tool" && m.toolName === ev.name && m.pending) {
            toolOk = !/^(Ошибка|⚠|Ошибка git|Ошибка:)/.test(ev.result || "");
            m.pending = false;
            m.toolResult = ev.result;
            m.toolOk = toolOk;
            refreshMessage(m);
            break;
          }
        }
        if (planToolOutcome(chat, ev, toolOk)) renderPlanPanel();
        ChatWork.planSet(ev, toolOk);
        persistChatsSoon();
        // Агент изменил файлы или git — обновляем панель проекта
        if (["writeFile", "editFile", "runCommand", "createFolder", "gitClone", "gitCommit", "gitRevert", "gitPush", "gitPull"].includes(ev.name)) {
          if (!$("project-panel").classList.contains("hidden")) setTimeout(ProjectPanel.refreshProject, 400);
        }
        break;
      case "text_override": {
        const seg = ChatSegments.ensureSegmentForText(chat, aMsg);
        if (seg) {
          seg.content = ev.text;
          persistChatsSoon();
          ChatFeed.queueBubbleRender(chat, seg);
        }
        break;
      }
      case "ask": {
        // Агент задал вопрос (askUser) — показываем модалку и ждём ответа
        openAskModal(ev.question || "Уточни, пожалуйста", (t) => {
          if (isElectron && api.answerQuestion) api.answerQuestion(t);
        });
        break;
      }
      case "vision": {
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "context": {
        renderContext(ev);
        break;
      }
      case "memory": {
        // Памятка контекста сохранена в локальный дневник (память диалогов) — плашка
        if (ev.text) {
          const mnote = document.createElement("div");
          mnote.className = "vision-note";
          mnote.textContent = ev.text;
          $("messages").appendChild(mnote);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "compact": {
        // Контекст сжат в памятку (экономия токенов) — показываем плашку
        if (ev.text) {
          const note = document.createElement("div");
          note.className = "vision-note";
          note.textContent = ev.text;
          $("messages").appendChild(note);
          ChatFeed.scrollBottom();
        }
        break;
      }
      case "image":
        showImageOverlay(ev.path || "", ev.dataUrl || "");
        break;
      case "diff":
        showPatchOverlay((ev.a || "") + "  ↔  " + (ev.b || ""), ev.patch || "");
        break;
      case "preview":
        // инструмент previewUI открывает постоянную правую панель (как в Replit),
        // а не разовый оверлей
        SidePanel.openSidePanel("preview");
        SidePanel.previewOpen(ev.url || "");
        break;
      case "undo_available": {
        lastUndoCount = ev.count || 0;
        break;
      }
      case "mission": {
        // Движок миссии: батч, пауза, лимит, смена шага — панель обновляется сразу.
        TasksMission.missionFromEvent(ev);
        break;
      }
      case "checkpoint": {
        // Авто-чекпоинт: агент закончил задачу и создал локальный коммит
        if (ev.message) toast(ev.message);
        break;
      }
      case "retry": {
        // Авто-повтор после сбоя: агент упал и продолжает с сохранённым контекстом
        const rErr = String(ev.error || "").slice(0, 200);
        toast("🔄 Попытка " + (ev.attempt || 2) + " из " + (ev.total || 3) + " после сбоя" + (rErr ? ": " + rErr : ""));
        break;
      }
      case "profile_switched": {
        // Авто-переключение между сохранёнными подключениями при ошибке ключа/баланса/лимита
        const pName = ev.name || "?";
        const pErr = String(ev.error || "").slice(0, 160);
        const ch = session ? chatsData.chats.find((c) => c.id === session.chatId) : null;
        if (ch) {
          ch.messages.push({
            id: uid(),
            role: "system",
            content: "🔄 Запрос упал" + (pErr ? ": " + pErr : "") + ".\nАвтоматически переключено на подключение «" + pName + "» — повторяю запрос с новым ключом.",
            createdAt: Date.now(),
          });
          const el = buildMessageEl(ch.messages[ch.messages.length - 1]);
          ChatWork.addRow(el);
          ChatFeed.scrollBottom();
          persistChatsSoon();
        }
        // Синхронизируем локальную копию настроек с main (активный профиль сменился)
        settings.openaiActiveProfile = ev.id || settings.openaiActiveProfile;
        if (isElectron) api.getSettings().then((s) => { if (s) settings = normalize(s); });
        toast("🔄 Переключено на подключение «" + pName + "»");
        break;
      }
      case "done":
        // План, написанный моделью текстом (или в размышлениях), разбираем и на финише,
        // а его текущий пункт закрываем: запуск завершён.
        tryPlanFromRunText(chat, aMsg);
        if (planTextFinish(chat)) {
          renderPlanPanel();
          persistChatsSoon();
        }
        // После завершения запуска обновляем панель git: авто-коммит мог очистить «Изменения»
        setTimeout(() => {
          if (!$("project-panel").classList.contains("hidden")) ProjectPanel.refreshProject();
        }, 300);
        break;
      case "error": {
        closeAskModal();
        const segs = ChatSegments.runSegments(chat, aMsg);
        for (const s of segs) s.pending = false;
        const lastSeg = segs[segs.length - 1] || aMsg;
        if (lastSeg) {
          lastSeg.error = ev.message;
          refreshMessage(lastSeg);
        }
        break;
      }
      case "deploy_stage": {
        if (window.DeployPanel && ev.stage) window.DeployPanel.onStage(ev.stage);
        break;
      }
      case "deploy_done": {
        if (window.DeployPanel) window.DeployPanel.onDone(ev);
        break;
      }
      case "yc_step": {
        const box = $("yc-deploy-box");
        const stepsEl = $("yc-deploy-steps");
        if (box && !box.classList.contains("hidden") && stepsEl) {
          const loading = stepsEl.querySelector(".yc-loading");
          if (loading) loading.remove();
          const d = document.createElement("div");
          d.className = "yc-step";
          d.textContent = ev.text || "";
          stepsEl.appendChild(d);
          const sp = $("sp-cloud");
          if (sp) sp.scrollTop = sp.scrollHeight;
        }
        break;
      }
    }
  }

  // Показ изображения, присланного инструментом showImage / screenshotCapture (событие image)
  function showImageOverlay(filePath, dataUrl) {
    const overlay = $("file-overlay");
    $("file-path").textContent = filePath || "Изображение";
    ProjectPanel.setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const img = document.createElement("img");
    img.className = "image-view";
    img.src = dataUrl || "";
    img.alt = filePath || "изображение";
    content.appendChild(img);
    overlay.classList.remove("hidden");
  }

  // Визуальный дифф двух файлов (инструмент diffView, событие diff)
  function showPatchOverlay(title, patch) {
    const overlay = $("file-overlay");
    $("file-path").textContent = title || "Сравнение файлов";
    ProjectPanel.setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const pre = document.createElement("pre");
    pre.className = "code-view";
    for (const ln of String(patch || "").split("\n")) {
      const line = document.createElement("div");
      let cls = "";
      if (/^(@@|diff --git|index |--- |\+\+\+ )/.test(ln)) cls = "meta";
      else if (/^\+/.test(ln)) cls = "add";
      else if (/^-/.test(ln)) cls = "del";
      line.className = "diff-line" + (cls ? " " + cls : "");
      line.textContent = ln || " ";
      pre.appendChild(line);
    }
    content.appendChild(pre);
    overlay.classList.remove("hidden");
  }

  // Встроенный предпросмотр сайта (инструмент previewUI, событие preview)
  function showPreviewOverlay(url) {
    const overlay = $("file-overlay");
    $("file-path").textContent = "Предпросмотр: " + url;
    ProjectPanel.setFileViewPath("");
    $("btn-file-edit").classList.add("hidden");
    $("btn-file-save").classList.add("hidden");
    $("btn-file-delete").classList.add("hidden");
    const content = $("file-content");
    content.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.src = url;
    content.appendChild(frame);
    overlay.classList.remove("hidden");
  }

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
    startAutoRunNow: startAutoRunNow,
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

  // ─────────────── Быстрое переключение модели (попап в шапке) ───────────────
  function toggleModelPopup() {
    const popup = $("model-popup");
    const willShow = popup.classList.contains("hidden");
    popup.classList.toggle("hidden", !willShow);
    if (willShow) renderModelPopup();
  }
  function closeModelPopup() {
    $("model-popup").classList.add("hidden");
  }
  function renderModelPopup() {
    const provider = settings.provider || "openai";
    const cur = settings.model || "";
    $("mp-title").textContent = "Модель · " + (PRESET_LABEL[provider] || provider);
    const list = $("mp-list");
    list.innerHTML = "";
    const models = cachedModels[provider] || [];
    if (!models.length) {
      const empty = document.createElement("div");
      empty.className = "mp-empty";
      empty.textContent = "Список моделей ещё не загружен. Нажми «↻ Обновить» или открой Настройки.";
      list.appendChild(empty);
    }
    for (const name of models.slice(0, 30)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mp-item" + (name === cur ? " active" : "");
      b.textContent = name;
      b.title = "Выбрать модель " + name;
      b.onclick = () => selectModelQuick(provider, name);
      list.appendChild(b);
    }
  }
  function selectModelQuick(provider, name) {
    settings.model = name;
    settings[MODEL_KEY[provider]] = name;
    const input = $(MODEL_INPUT[provider]);
    if (input) input.value = name;
    persistSettings();
    SettingsPanel.updateBadge();
    closeModelPopup();
    toast("Модель: " + name);
  }
  async function refreshModelsQuick() {
    const provider = settings.provider || "openai";
    const btn = $("mp-refresh");
    btn.disabled = true;
    btn.textContent = "Загружаю...";
    try {
      const cfg = { ...settings, provider, model: "" };
      const res = isElectron ? await api.listModels(cfg) : await AgentCore.listModels(cfg, { fromBrowser: true });
      const models = res && res.ok ? res.models : null;
      if (Array.isArray(models)) {
        cachedModels[provider] = models;
        renderModelPopup();
        toast("Моделей: " + models.length);
      } else {
        toast("Ошибка: " + ((res && res.message) || (res && res.error) || "не удалось загрузить"));
      }
    } catch (e) {
      toast("Ошибка: " + (e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "↻ Обновить";
    }
  }

  // Переименование чата: двойной клик по заголовку → инлайн-ввод
  function startRenameChat() {
    const chat = getActiveChat();
    if (!chat || streaming) return;
    const titleEl = $("chat-title");
    const old = chatTitle(chat);
    const inp = document.createElement("input");
    inp.id = "chat-title-input";
    inp.className = "chat-title-input";
    inp.value = old;
    inp.maxLength = 80;
    inp.spellcheck = false;
    titleEl.replaceWith(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const val = save ? inp.value.trim() : old;
      if (save && val && val !== old) {
        chat.title = val;
        persistChats();
        renderSidebar();
        toast("Чат переименован");
      }
      const div = document.createElement("div");
      div.id = "chat-title";
      div.textContent = chatTitle(chat);
      inp.replaceWith(div);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    inp.addEventListener("blur", () => finish(true));
  }

  // ── Секреты: пароли сайтов, почта и переменные окружения — код в src/renderer/secrets-panel.js ──
  const SecretsPanel = window.SecretsPanel({
    $: $,
    api: api,
    isElectron: isElectron,
    toast: toast,
    persistSettings: persistSettings,
    getSettings: () => settings,
  });

  // ── Модалка «вопрос агента» (askUser) ──
  let askOnAnswer = null;
  function openAskModal(question, onAnswer) {
    $("ask-question").textContent = question;
    $("ask-input").value = "";
    $("ask-overlay").classList.remove("hidden");
    setTimeout(() => $("ask-input").focus(), 60);
    askOnAnswer = onAnswer;
  }
  function closeAskModal() {
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
  }
  $("btn-ask-send").onclick = () => {
    const cb = askOnAnswer;
    const v = $("ask-input").value.trim();
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
    if (cb) cb(v);
  };
  $("btn-ask-cancel").onclick = () => {
    const cb = askOnAnswer;
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
    if (cb) cb("");
  };
  $("ask-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("btn-ask-send").click();
    }
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
    onEvent: onAiEvent, // то же окно событий, что и у desktop-цикла
    openAskModal: openAskModal,
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
    probeG4fPort: probeG4fPort,
    renderG4fProviderList: renderG4fProviderList,
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
  $("chat-title").addEventListener("dblclick", startRenameChat);
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
  $("model-badge").onclick = toggleModelPopup;
  $("mp-close").onclick = closeModelPopup;
  $("mp-refresh").onclick = refreshModelsQuick;
  $("mp-settings").onclick = () => {
    closeModelPopup();
    SettingsPanel.openSettings();
  };
  document.addEventListener("mousedown", (e) => {
    const popup = $("model-popup");
    if (popup.classList.contains("hidden")) return;
    if (!popup.contains(e.target) && e.target !== $("model-badge")) closeModelPopup();
  });
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
    toggleModelPopup: toggleModelPopup,
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
      api.onAiEvent(onAiEvent);
      // История чатов общая: телефон сохранил переписку — перечитываем файл.
      if (typeof api.onChatsReload === "function") api.onChatsReload(() => reloadChatsFromDisk());
      ProjectPanel.wireGithubEvents();
    }
  });
})();

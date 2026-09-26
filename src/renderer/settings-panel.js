"use strict";

/* ─── Настройки: вкладки, поля, провайдеры, замер и сохранение ────────────────
   Вынесено из app.js (этап 3.8, часть 3) — последний кусок панели настроек.
   Здесь переключение вкладок, заполнение полей из памяти и обратное чтение,
   выбор провайдера и пресета, список моделей, замер скорости местной модели,
   вспомогательная модель (зрение и генерация картинок), состояние обновлений,
   памяти диалогов, профиля браузера и режима своего Chrome, сохранение настроек
   и сообщения панели.

   Зависимости приходят одним объектом. Где значение переписывается целиком —
   приходит ЖИВАЯ функция, а не копия: getSettings (настройки грузятся и
   сохраняются объектом), getPreset/setCurrentPreset, getLastTab/setLastTab,
   setSbVersion, getMobilePanel (панель мобильного доступа создаётся позже и
   берёт отсюда сообщение панели — ссылка на значение была бы пустой). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.SettingsPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (SettingsPanelDeps) {
  const {
    $, api, isElectron, getSettings, getPreset, setCurrentPreset, setSbVersion,
    cachedModels, persistSettings, updateStatusBar, updateReasoning, updateModelNeeded,
    refreshProject,
    toast, esc, renderGithubSection, probeG4fPort, renderG4fProviderList,
    search, getLastTab, setLastTab, getMobilePanel,
    AgentCore, SecretsPanel, getYcPanel, OpenaiProfiles,
    PRESETS, PRESET_LABEL, MODEL_KEY, MODEL_INPUT, URL_INPUT, URL_KEY,
  } = SettingsPanelDeps || {};

  function providerLabel() {
    if (getSettings().provider === "ollama") return "Ollama";
    if (getSettings().provider === "anthropic") return "Claude";
    return PRESET_LABEL[getPreset()] || "OpenAI-совместимый";
  }
  function updateBadge() {
    const label = providerLabel();
    $("model-badge").textContent = getSettings().model ? label + " · " + getSettings().model : "Модель не выбрана";
    $("model-badge").title = getSettings().model
      ? "Провайдер и модель — нажми, чтобы изменить"
      : "Модель не выбрана — нажми, чтобы настроить";
    // Плашка 🧠 живёт по модели: у модели без рассуждений её нет вовсе, у остальных —
    // есть. ВСЕ смены провайдера и модели проходят через этот значок, поэтому
    // показывать/прятать плашку надо здесь, а не в каждом месте по отдельности.
    if (updateReasoning) updateReasoning();
    updateStatusBar();
  }

  function setSettingsMsg(text, isError) {
    const msg = $("settings-msg");
    msg.textContent = text;
    msg.className = "settings-msg " + (isError ? "err" : "ok");
  }

  function setProviderUI(p) {
    if (p !== "ollama" && p !== "openai" && p !== "anthropic") p = "openai";
    getSettings().provider = p;
    const provSel = $("s-provider-select");
    if (provSel) provSel.value = p;
    // Аккордеон: раскрываем карточку активного провайдера, остальные сворачиваем.
    // Вручную раскрыть другую карточку можно кликом по её заголовку — это не меняет выбор.
    for (const key of ["ollama", "openai", "anthropic"]) {
      const acc = document.querySelector('.acc[data-acc="' + key + '"]');
      if (!acc) continue;
      acc.classList.toggle("open", key === p);
      const badge = acc.querySelector(".acc-badge");
      if (badge) badge.classList.toggle("hidden", key !== p);
    }
    // Переключаем зеркало модели на сохранённую модель выбранного провайдера,
    // чтобы случайно не отправить модель от другого провайдера.
    getSettings().model = getSettings()[MODEL_KEY[p]] || "";
    updateBadge();
    renderModelHints(null, null); // подсказки моделей относятся к активному провайдеру
    refreshProbeButton(); // замер в подвале настроек виден только для местной модели
  }

  function showSettingsTab(name) {
    name = name || "model";
    setLastTab(name);
    if (search.active()) search.reset();
    document.querySelectorAll(".stab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll(".settings-tab-body").forEach((b) => {
      b.classList.remove("sfilter-hide");
      b.classList.toggle("hidden", b.dataset.tabBody !== name);
    });
  }

  // opts.keepFields — только ПОКАЗАТЬ выбор (подсветка чипа, поля Yandex/G4F), не трогая
  // адрес и модель. Так открытие настроек встаёт на сохранённые значения: раньше
  // определение пресета по адресу подставляло модель пресета и затирало выбранную
  // человеком (у groq, cerebras, ollamacloud, mistral модель в PRESETS есть) —
  // «сохранённая модель сама сбрасывалась на другую».
  function setPreset(p, opts) {
    setCurrentPreset(p);
    // Только пресеты из настроек: селектор без [data-preset] задел бы чипы
    // приветственного экрана и переключил бы их «активный» вид.
    document.querySelectorAll(".chip[data-preset]").forEach((c) => c.classList.toggle("active", c.dataset.preset === p));
    if (!(opts && opts.keepFields)) {
      if (PRESETS[p] && PRESETS[p].url) $("s-openai-url").value = PRESETS[p].url;
      if (PRESETS[p] && PRESETS[p].model) $("s-openai-model").value = PRESETS[p].model;
    }
    // Поле «Yandex folder ID» — только для Yandex AI Studio
    const yandexField = $("yandex-project-field");
    if (yandexField) yandexField.classList.toggle("hidden", p !== "yandex");
    // Подсказка G4F — только при выборе локального пресета
    const g4fHint = $("g4f-hint");
    if (g4fHint) g4fHint.classList.toggle("hidden", p !== "g4f");
    // Авто-подбор порта: если указанный URL не отвечает, а живой g4f есть на 1337/8080
    if (p === "g4f") probeG4fPort();
  }

  // Заполняет все поля настроек значениями из памяти (чтобы переключение провайдеров ничего не теряло)
  function fillSettingsUI() {
    $("s-ollama-url").value = getSettings().ollamaUrl || "";
    $("s-ollama-model").value = getSettings().ollamaModel || "";
    $("s-openai-url").value = getSettings().openaiUrl || "";
    $("s-openai-key").value = getSettings().openaiApiKey || "";
    $("s-openai-model").value = getSettings().openaiModel || "";
    $("s-openai-project").value = getSettings().openaiProject || "";
    $("s-anth-url").value = getSettings().anthropicUrl || "";
    $("s-anth-key").value = getSettings().anthropicApiKey || "";
    $("s-anth-model").value = getSettings().anthropicModel || "";
    $("s-workdir").value = getSettings().workingDir || "";
    $("s-gh-client-id").value = getSettings().githubClientId || "";
    $("s-gh-token").value = getSettings().githubToken || "";
    $("s-allow-agent-push").checked = !!getSettings().allowAgentPush;
    $("s-agent-auto-commit").checked = getSettings().agentAutoCommit !== false;
    $("s-context-memory").checked = getSettings().contextMemory === true;
    $("s-context-memory-days").value = getSettings().contextMemoryDays || 30;
    renderMemoryStatus();
    $("s-browser-profile").checked = getSettings().browserProfile !== false;
    renderBrowserProfileInfo();
    if ($("s-browser-connect")) {
      $("s-browser-connect").checked = getSettings().browserConnect === true;
      $("s-browser-connect-port").value = getSettings().browserConnectPort || 9222;
      renderBrowserConnectInfo();
    }
    getMobilePanel().applyMobileFields();
    $("s-vision-enabled").checked = !!getSettings().visionEnabled;
    $("s-vision-auto").checked = getSettings().visionAuto !== false;
    $("s-vision-url").value = getSettings().visionUrl || "";
    $("s-vision-key").value = getSettings().visionKey || "";
    $("s-serper-key").value = getSettings().serperApiKey || "";
    $("s-vision-model").value = getSettings().visionModel || "";
    $("s-image-model").value = getSettings().imageModel || "";
    renderVisionDetect();
    $("vision-fields").classList.toggle("hidden", !$("s-vision-enabled").checked);
    $("vision-model-hints").classList.add("hidden");
    if ($("s-default-role")) $("s-default-role").value = AgentCore.roleById(getSettings().defaultRole).id;
    if ($("s-task-reminders")) $("s-task-reminders").checked = getSettings().taskReminders !== false;
    if ($("s-task-auto")) $("s-task-auto").checked = getSettings().taskAuto !== false;
    if ($("s-long-work")) $("s-long-work").checked = getSettings().longWork !== false;
    if ($("s-long-hours")) $("s-long-hours").value = getSettings().longWorkHours || 8;
    if ($("s-long-rounds")) $("s-long-rounds").value = getSettings().longWorkRounds || 600;
    if ($("s-long-continue")) $("s-long-continue").value = getSettings().longWorkAutoContinue == null ? 6 : getSettings().longWorkAutoContinue;
    if ($("s-agent-files")) $("s-agent-files").checked = getSettings().agentWorkFiles !== false;
    renderAgentFilesStatus();
    if ($("s-audit-log")) $("s-audit-log").checked = getSettings().auditLog !== false;
    $("s-ota-enabled").checked = getSettings().otaEnabled !== false;
    $("s-ota-dir").value = getSettings().otaDir || "";
    OpenaiProfiles.render();
    $("s-auto-switch").checked = !!getSettings().autoSwitchProfiles;
    $("s-send-all-tools").checked = !!getSettings().sendAllTools;
    if ($("s-no-tools-model")) $("s-no-tools-model").checked = !!getSettings().noToolsModel;
    // Почта
    $("s-mail-address").value = getSettings().mailAddress || "";
    $("s-mail-from-name").value = getSettings().mailFromName || "";
    $("s-mail-pass").value = getSettings().mailPassword || "";
    $("s-mail-imap-host").value = getSettings().mailImapHost || "";
    $("s-mail-imap-port").value = getSettings().mailImapPort ? String(getSettings().mailImapPort) : "";
    $("s-mail-smtp-host").value = getSettings().mailSmtpHost || "";
    $("s-mail-smtp-port").value = getSettings().mailSmtpPort ? String(getSettings().mailSmtpPort) : "";
    $("s-mail-starttls").checked = !!getSettings().mailStarttls;
    $("s-mail-allow-send").checked = !!getSettings().mailAllowAgentSend;
    renderOtaStatus();
  }

  // Читает значения активного провайдера из полей в settings
  function collectSettingsFromUI() {
    getSettings().ollamaUrl = $("s-ollama-url").value.trim() || "http://localhost:11434";
    getSettings().ollamaModel = $("s-ollama-model").value.trim();
    getSettings().openaiUrl = $("s-openai-url").value.trim();
    getSettings().openaiApiKey = $("s-openai-key").value.trim();
    getSettings().openaiModel = $("s-openai-model").value.trim();
    getSettings().openaiProject = $("s-openai-project").value.trim();
    getSettings().anthropicUrl = $("s-anth-url").value.trim() || "https://api.anthropic.com";
    getSettings().anthropicApiKey = $("s-anth-key").value.trim();
    getSettings().anthropicModel = $("s-anth-model").value.trim();
    getSettings().workingDir = $("s-workdir").value.trim();
    getSettings().githubClientId = $("s-gh-client-id").value.trim();
    getSettings().githubToken = $("s-gh-token").value.trim();
    getSettings().allowAgentPush = !!$("s-allow-agent-push").checked;
    getSettings().agentAutoCommit = !!$("s-agent-auto-commit").checked;
    getSettings().contextMemory = !!$("s-context-memory").checked;
    getSettings().contextMemoryDays = Math.max(1, Math.min(3650, parseInt($("s-context-memory-days").value, 10) || 30));
    getSettings().browserProfile = !!$("s-browser-profile").checked;
    if ($("s-browser-connect")) {
      getSettings().browserConnect = !!$("s-browser-connect").checked;
      getSettings().browserConnectPort = parseInt($("s-browser-connect-port").value, 10) || 9222;
    }
    getMobilePanel().readMobileFields();
    getSettings().visionEnabled = !!$("s-vision-enabled").checked;
    getSettings().visionAuto = !!$("s-vision-auto").checked;
    getSettings().visionUrl = $("s-vision-url").value.trim();
    getSettings().visionKey = $("s-vision-key").value.trim();
    getSettings().serperApiKey = $("s-serper-key").value.trim();
    getSettings().mailAddress = $("s-mail-address").value.trim();
    getSettings().mailFromName = $("s-mail-from-name").value.trim();
    getSettings().mailPassword = $("s-mail-pass").value.trim();
    getSettings().mailImapHost = $("s-mail-imap-host").value.trim();
    getSettings().mailImapPort = parseInt($("s-mail-imap-port").value, 10) || 993;
    getSettings().mailSmtpHost = $("s-mail-smtp-host").value.trim();
    getSettings().mailSmtpPort = parseInt($("s-mail-smtp-port").value, 10) || 465;
    getSettings().mailStarttls = !!$("s-mail-starttls").checked;
    getSettings().mailAllowAgentSend = !!$("s-mail-allow-send").checked;
    getSettings().visionModel = $("s-vision-model").value.trim();
    getSettings().imageModel = $("s-image-model").value.trim();
    if ($("s-default-role")) getSettings().defaultRole = AgentCore.roleById($("s-default-role").value).id;
    if ($("s-task-reminders")) getSettings().taskReminders = !!$("s-task-reminders").checked;
    if ($("s-task-auto")) getSettings().taskAuto = !!$("s-task-auto").checked;
    if ($("s-long-work")) getSettings().longWork = !!$("s-long-work").checked;
    if ($("s-long-hours")) getSettings().longWorkHours = Math.max(1, Math.min(24, parseInt($("s-long-hours").value, 10) || 8));
    if ($("s-long-rounds")) getSettings().longWorkRounds = Math.max(25, Math.min(2000, parseInt($("s-long-rounds").value, 10) || 600));
    if ($("s-long-continue")) getSettings().longWorkAutoContinue = Math.max(0, Math.min(20, parseInt($("s-long-continue").value, 10) || 0));
    if ($("s-agent-files")) getSettings().agentWorkFiles = !!$("s-agent-files").checked;
    if ($("s-audit-log")) getSettings().auditLog = !!$("s-audit-log").checked;
    getSettings().otaEnabled = !!$("s-ota-enabled").checked;
    getSettings().otaDir = $("s-ota-dir").value.trim();
    getSettings().autoSwitchProfiles = !!$("s-auto-switch").checked;
    getSettings().sendAllTools = !!$("s-send-all-tools").checked;
    if ($("s-no-tools-model")) getSettings().noToolsModel = !!$("s-no-tools-model").checked;
    // Зеркало модели активного провайдера
    getSettings().model = getSettings()[MODEL_KEY[getSettings().provider]] || "";
  }

  // Статус локального self-update (OTA): какой код работает, какой набор применён,
  // куда приложение смотрит за обновлениями и что там доступно.
  //
  // Раньше здесь показывался номер НАБОРА как «версия кода» — и человек, обновив
  // папку проекта из репозитория, видел ту же цифру и делал верный вывод «код
  // старый». Теперь версия кода и номер набора показаны раздельно, а если источников
  // обновлений нет — сказано и это, чтобы не оставалось места для догадок.
  async function renderOtaStatus() {
    const el = $("ota-status");
    if (!el) return;
    if (!isElectron) {
      el.textContent = "Доступно в приложении на ПК";
      return;
    }
    try {
      const st = await api.otaStatus();
      const code = (st && (st.codeVersion || st.appVersion)) || "";
      setSbVersion(code || "базовая");
      updateStatusBar();
      const parts = ["Версия кода: " + (code || "не прочитана")];
      if (st && st.bundle) parts.push("применён набор " + st.bundle);
      if (st && st.dir) parts.push("Папка обновлений: " + st.dir);
      const list = (st && st.sourceList) || [];
      if (list.length) {
        parts.push(
          "Источников: " + list.length + " — " + list.map((s) => (s.codeVersion || s.version || "?") + " из " + s.dir).join(" | ")
        );
      } else {
        parts.push("Источников обновлений нет — укажите папку ota проекта в поле ниже");
      }
      if (st && st.candidate) {
        parts.push("Доступно: " + st.candidate.version + " из " + st.candidate.dir + " — нажмите «Проверить сейчас»");
      } else {
        parts.push("Ничего новее этого кода нет");
      }
      // Подпись набора: человек должен видеть, проверяется она или нет — иначе
      // «обновление не ставится» выглядит поломкой, а «ставится что угодно» — нормой.
      if (st && st.trust) {
        if (st.trust.warning) parts.push("⚠ " + st.trust.warning);
        else if (st.trust.keys) {
          parts.push("Подпись набора: ключей " + st.trust.keys + " (" + st.trust.ids.join(", ") + ")");
        }
      }
      el.textContent = parts.join(" · ");
    } catch {
      el.textContent = "—";
    }
  }

  function openSettings(tab) {
    SecretsPanel.renderEnvVars();
    SecretsPanel.renderVault();
    fillSettingsUI();
    // Без явной вкладки открываем ту, где остановились в прошлый раз. Вызовы, которым
    // нужна конкретная вкладка («Настройки: модель», «выбрать модель»), передают её явно.
    showSettingsTab(tab || getLastTab() || "model");
    setProviderUI(getSettings().provider || "openai");
    // Определение пресета ТОЛЬКО подсвечивает чип: адрес и модель окно берёт из
    // сохранённых настроек (fillSettingsUI выше). Иначе подстановка модели пресета
    // молча сбрасывала выбранную человеком модель при каждом открытии настроек.
    setPreset(getPreset(), { keepFields: true });
    // Определяем пресет по сохранённому URL (если он не пустой и совпадает с известным)
    const url = (getSettings().openaiUrl || "").toLowerCase();
    let found = false;
    for (const [k, v] of Object.entries(PRESETS)) {
      if (v && url.includes(v.url.replace(/\/+$/, "").toLowerCase())) {
        setPreset(k, { keepFields: true });
        found = true;
        break;
      }
    }
    if (!found) setPreset(getSettings().openaiUrl ? "custom" : "deepseek", { keepFields: true });
    renderModelHints(null, null); // прячем подсказки моделей (провайдер мог смениться)
    renderGithubSection();
    getYcPanel().refreshSettingsUI(); // Yandex Cloud: статус подключения, каталог, разрешения
    $("settings-overlay").classList.remove("hidden");
    setSettingsMsg("", false);
  }

  // Кликабельные подсказки с моделями под активным провайдером
  function renderModelHints(provider, models) {
    cachedModels[provider] = models || [];
    const box = $("model-hints");
    box.innerHTML = "";
    if (!provider || !models || !models.length) {
      box.classList.add("hidden");
      return;
    }
    const label = document.createElement("span");
    label.className = "hint-label";
    label.textContent = "Модели (клик — вставить):";
    box.appendChild(label);
    const shown = models.slice(0, 12);
    for (const name of shown) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (name === (getSettings()[MODEL_KEY[provider]] || getSettings().model) ? " active" : "");
      b.textContent = name;
      b.title = "Вставить модель " + name;
      b.onclick = () => {
        // На пресете G4F в поле модели может стоять маршрут «Провайдер:» — не затираем его:
        // модель дописывается после двоеточия, иначе теряется выбранный провайдер.
        const input = $(MODEL_INPUT[provider]);
        const curVal = (input.value || "").trim();
        const g4fPrefix = /^[A-Za-z0-9_]+:\s*$/.test(curVal) ? curVal.replace(/:+$/, "") + ":" : "";
        const finalName = g4fPrefix + name;
        input.value = finalName;
        getSettings()[MODEL_KEY[provider]] = finalName;
        getSettings().model = finalName;
        persistSettings();
        updateBadge();
        setSettingsMsg("Модель выбрана: " + finalName + ". Нажми «Сохранить настройки» и общайся.", false);
        renderModelHints(provider, models);
        if (getPreset() === "g4f") renderG4fProviderList();
      };
      box.appendChild(b);
    }
    box.classList.remove("hidden");
  }

  // Список моделей для активного провайдера (по значениям из полей настроек)
  async function requestModelsList() {
    const provider = getSettings().provider || "openai";
    const base = $(URL_INPUT[provider]).value.trim();
    const key = provider === "anthropic" ? $("s-anth-key").value.trim() : $("s-openai-key").value.trim();
    const cfg = { ...getSettings(), provider, [URL_KEY[provider]]: base, model: "" };
    if (provider === "anthropic") cfg.anthropicApiKey = key;
    else cfg.openaiApiKey = key;
    if (isElectron) {
      const res = await api.listModels(cfg);
      return res && res.ok ? res.models : { error: (res && res.message) || "Не удалось загрузить" };
    }
    try {
      return await AgentCore.listModels(cfg, { fromBrowser: true });
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  async function loadModels() {
    collectSettingsFromUI();
    const provider = getSettings().provider || "openai";
    if (!$(URL_INPUT[provider]).value.trim()) {
      setSettingsMsg("Заполни базовый URL провайдера.", true);
      return;
    }
    setSettingsMsg("Загружаю список моделей...", false);
    const res = await requestModelsList();
    if (Array.isArray(res) && res.length) {
      renderModelHints(provider, res);
      setSettingsMsg(
        "Доступно моделей: " + res.length + ". Нажми на нужную ниже, чтобы вставить её в поле.",
        false
      );
    } else {
      renderModelHints(provider, null);
      setSettingsMsg("Модели не загрузились: " + (res.error || ""), true);
    }
  }

  async function testConnection() {
    collectSettingsFromUI();
    const provider = getSettings().provider || "openai";
    if (!$(URL_INPUT[provider]).value.trim()) {
      setSettingsMsg("Заполни базовый URL провайдера.", true);
      return;
    }
    setSettingsMsg("Проверяю подключение...", false);
    const res = await requestModelsList();
    if (Array.isArray(res)) {
      renderModelHints(provider, res);
      setSettingsMsg("Подключено! Моделей: " + res.length + ". Нажми на нужную ниже, чтобы выбрать.", false);
    } else {
      renderModelHints(provider, null);
      setSettingsMsg("Ошибка: " + (res.error || "не удалось подключиться"), true);
    }
  }
  // ── Замер локальной модели ─────────────────────────────────────────────────
  // «Проверить подключение» отвечает только «сервер жив». Этой кнопкой спрашиваем
  // у сервера главное для местной модели: сколько он грузится, как быстро читает
  // промпт и генерирует и сколько весов лежит в видеопамяти. Строки отчёта готовит
  // ядро (AgentCore.probeLocalModel) — здесь только показ.
  function renderProbeResult(res) {
    const box = $("ollama-probe-result");
    if (!box) return;
    const r = res || {};
    const lines = Array.isArray(r.lines) && r.lines.length ? r.lines : ["❌ Замер не удался."];
    let text = lines.join("\n");
    if (Array.isArray(r.advice) && r.advice.length) {
      text += "\n\nЧто ускорит:\n" + r.advice.map((a) => "— " + a).join("\n");
    }
    box.textContent = text;
    box.classList.remove("hidden");
  }

  // Кнопка «Замерить скорость» в подвале настроек: показываем её только там, где
  // замер имеет смысл — модель считается местной (Ollama всегда; OpenAI-совместимый
  // сервер на своём ПК или в домашней сети). Для облака замер бессмыслен: он измерил
  // бы задержку чужого дата-центра, а не нашего ПК. Та же кнопка живёт в карточке Ollama.
  function refreshProbeButton() {
    const btn = $("btn-probe-model");
    if (!btn) return;
    const local = !!(AgentCore.isLocalEndpoint && AgentCore.isLocalEndpoint(getSettings()));
    btn.classList.toggle("hidden", !local);
  }

  async function probeLocalModelUI() {
    // Показываем то, что измеряем, и саму кнопку: карточки провайдеров свёрнуты,
    // если активен другой, и замер без этого выглядел бы как «ничего не произошло».
    for (const key of [getSettings().provider || "openai", "ollama"]) {
      const acc = document.querySelector('.acc[data-acc="' + key + '"]');
      if (acc && !acc.classList.contains("open")) acc.classList.add("open");
    }
    const probeBtn = $("btn-probe-ollama");
    if (probeBtn && probeBtn.scrollIntoView) probeBtn.scrollIntoView({ block: "center" });
    collectSettingsFromUI();
    const provider = getSettings().provider || "openai";
    const base = $(URL_INPUT[provider]).value.trim();
    if (!base) {
      setSettingsMsg("Заполни базовый URL провайдера.", true);
      return;
    }
    const model = $(MODEL_INPUT[provider]).value.trim();
    if (!model) {
      setSettingsMsg("Сначала выбери модель — замерять нечего (кнопка ↻ рядом со списком).", true);
      return;
    }
    const cfg = { ...getSettings(), provider, [URL_KEY[provider]]: base, [MODEL_KEY[provider]]: model };
    const btn = $("btn-probe-ollama");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳ Замеряю…";
    }
    // Честно предупреждаем про время: на процессоре чтение промпта идёт минутами.
    setSettingsMsg("Замеряю модель: на слабом ПК это может занять минуты — жди, окно не зависло.", false);
    try {
      const res = isElectron
        ? await api.probeLocalModel(cfg)
        : await AgentCore.probeLocalModel(cfg, { fromBrowser: true });
      renderProbeResult(res);
      const ok = !!(res && res.ok);
      setSettingsMsg(
        ok ? "Замер готов: вердикт и цифры — под кнопкой." : "Замер не удался: " + ((res && (res.error || res.message)) || "нет ответа"),
        !ok
      );
    } catch (e) {
      const why = (e && e.message) || String(e);
      renderProbeResult({ ok: false, lines: ["❌ Замер не удался: " + why] });
      setSettingsMsg("Замер не удался: " + why, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "📈 Замерить скорость";
      }
    }
  }

  // Тип подключения вспомогательной модели выбирать не нужно — приложение определяет
  // провайдера по адресу. Но человек должен видеть, что понято правильно: «Gemini
  // (OpenAI-совместимо)», «OpenRouter», «ЯндексART» и т. д.
  function renderVisionDetect() {
    const el = $("vision-detect-hint");
    if (!el) return;
    const url = ($("s-vision-url").value || "").trim() || getSettings().visionUrl || "https://openrouter.ai/api/v1";
    const label = AgentCore.imageProviderLabel(url);
    el.textContent = "Генерация картинок: " + label + " — путь к API приложение подбирает само, выбирать вручную не нужно.";
  }

  // Загрузка списка моделей для вспомогательной модели (зрение/генерация)
  async function loadAuxModels(kind) {
    const box = $("vision-model-hints");
    box.innerHTML = "";
    const url = $("s-vision-url").value.trim() || getSettings().visionUrl || "https://openrouter.ai/api/v1";
    const key = $("s-vision-key").value.trim() || getSettings().visionKey || getSettings().openaiApiKey || "";
    box.classList.remove("hidden");
    if (!key) {
      box.innerHTML = '<span class="hint-label">Сначала укажи API-ключ вспомогательной модели.</span>';
      return;
    }
    box.innerHTML = '<span class="hint-label">Загружаю модели…</span>';
    try {
      const cfg = { provider: "openai", openaiUrl: url, openaiApiKey: key, model: "" };
      const res = isElectron ? await api.listModels(cfg) : await AgentCore.listModels(cfg, { fromBrowser: true });
      const models = Array.isArray(res) ? res : (res && res.models) || [];
      if (!models.length) {
        box.innerHTML = '<span class="hint-label">Модели не загрузились: ' + esc(((res && res.message) || "пустой ответ")) + "</span>";
        return;
      }
      box.innerHTML = "";
      for (const name of models) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = name;
        b.title = "Вставить " + name;
        b.onclick = () => {
          if (kind === "vision") { $("s-vision-model").value = name; getSettings().visionModel = name; }
          else { $("s-image-model").value = name; getSettings().imageModel = name; }
          persistSettings();
          box.innerHTML = "";
          box.classList.add("hidden");
        };
        box.appendChild(b);
      }
    } catch (e) {
      box.innerHTML = '<span class="hint-label">Ошибка: ' + esc((e && e.message) || String(e)) + "</span>";
    }
  }

  // 🧠 Память диалогов: включена ли и сколько памяток уже сохранено.
  // Папка работы агента (.agent/): что уже лежит рядом с проектом. Показываем
  // факты (файлы, миссии, размер), а не намерение — включённая галочка ≠ файлы есть.
  async function renderAgentFilesStatus() {
    const el = $("agent-files-status");
    if (!el) return;
    if (!(($("s-agent-files") || {}).checked)) {
      el.textContent = "Выключено: агент не создаёт файлы работы в папке проекта.";
      return;
    }
    if (!isElectron || !api.agentFilesStatus) {
      el.textContent = "Файлы работы агента ведутся в desktop-приложении (в веб-превью недоступны).";
      return;
    }
    try {
      const r = await api.agentFilesStatus();
      if (!r || !r.enabled) return;
      const parts = [];
      parts.push(r.tasks ? "задачи: " + (r.tasks.bytes / 1024).toFixed(1) + " КБ" : "задачи: файла ещё нет");
      parts.push(r.contextDays && r.contextDays.length ? "дней контекста: " + r.contextDays.length : "контекст: памяток ещё нет");
      parts.push(r.missions ? "миссий: " + r.missions : "миссий: нет");
      if (r.bytes) parts.push("всего " + (r.bytes / 1024).toFixed(0) + " КБ");
      // Где файлы лежат НА САМОМ ДЕЛЕ. Раньше здесь было написано «место: .agent/»
      // на память — и после выбора своей папки панель показывала чужой путь.
      const where = [
        "миссии — " + (r.missionsCustom ? r.missionsRoot : ".agent/ в рабочей папке"),
        "дела — " + (r.tasksCustom ? r.tasksRoot : "папка приложения"),
      ].join("; ");
      el.textContent =
        (r.exists ? "Файлы работы уже есть: " : "Файлов работы ещё нет — появятся при первой записи. ") +
        parts.join(" · ") +
        " Место: " + where + "." +
        (r.insideProject ? " Выбранная папка лежит внутри проекта — груз остаётся в папке проекта." : "");
    } catch {
      el.textContent = "Не удалось прочитать состояние папки работы.";
    }
  }

  async function renderMemoryStatus() {
    const el = $("memory-status");
    if (!el) return;
    const dirEl = $("memory-dir");
    const on = !!(($("s-context-memory") || {}).checked);
    if (!on) {
      el.textContent = "Выключено: сжатые памятки на диск не пишутся. Включи галочку — и агент сможет вспоминать прошлые сессии по датам.";
      if (dirEl) dirEl.textContent = "—";
      return;
    }
    if (!isElectron || !api.memoryStats) {
      el.textContent = "Память диалогов работает в desktop-приложении (в веб-превью недоступна).";
      return;
    }
    try {
      const r = await api.memoryStats();
      if (dirEl && r && r.dir) dirEl.textContent = r.dir;
      if (!r || !r.days) {
        el.textContent = "Памяток пока нет — они появятся, когда контекст переполнится и старые шаги свернутся в памятку.";
        return;
      }
      const kb = r.bytes ? " · " + (r.bytes / 1024).toFixed(0) + " КБ" : "";
      el.textContent = "Сохранено дней: " + r.days + " · памяток: " + r.memos + kb + (r.newest ? " · последняя запись " + r.newest : "") + " · храним " + (r.keepDays || 30) + " дн.";
    } catch {
      el.textContent = "Не удалось прочитать состояние памяти диалогов.";
    }
  }

  // Состояние постоянного профиля браузера агента: включён ли и есть ли папка на диске.
  async function renderBrowserProfileInfo() {
    const el = $("browser-profile-info");
    if (!el) return;
    const box = $("s-browser-profile");
    if (box && !box.checked) {
      el.textContent = "Профиль выключен: браузер агента каждый раз стартует «чистым» — вход на сайты придётся повторять.";
      return;
    }
    if (!isElectron || !api.browserProfileInfo) {
      el.textContent = "Постоянный профиль работает в desktop-приложении: куки и входы на сайты сохраняются между запусками.";
      return;
    }
    try {
      const r = await api.browserProfileInfo();
      el.textContent =
        "Профиль: " +
        (r && r.exists ? "папка на диске, сессии сайтов сохраняются" : "пока пуст — заполнится при первом входе на сайт") +
        (r && r.dir ? " · " + r.dir : "");
    } catch {
      el.textContent = "Не удалось прочитать состояние профиля браузера.";
    }
  }

  // Режим «свой Chrome по CDP»: включён ли и подключены ли мы прямо сейчас.
  async function renderBrowserConnectInfo() {
    const el = $("browser-connect-info");
    if (!el) return;
    const box = $("s-browser-connect");
    if (box && !box.checked) {
      el.textContent = "Режим выключен: агент работает в отдельном окне Chromium (постоянный профиль выше).";
      return;
    }
    if (!isElectron || !api.browserConnectInfo) {
      el.textContent = "Подключение к своему Chrome работает в desktop-приложении.";
      return;
    }
    try {
      const info = await api.browserConnectInfo();
      el.textContent =
        "Режим включён, порт " +
        ((info && info.port) || 9222) +
        " · " +
        (info && info.active
          ? "подключено: работаем в вашем Chrome"
          : "пока не подключено — нажмите «Подключиться» или попросите агента открыть сайт");
    } catch {
      el.textContent = "Не удалось прочитать состояние подключения.";
    }
  }

  function saveSettingsUI() {
    updateModelNeeded();
    collectSettingsFromUI();
    persistSettings();
    updateBadge();
    $("settings-overlay").classList.add("hidden");
    refreshProject();
    toast("Настройки сохранены");
  }

  function toggleKey(inputId) {
    const i = $(inputId);
    i.type = i.type === "password" ? "text" : "password";
  }

  // ── Куда класть работу агента: миссии, прогоны и дела ────────────────────────
  // Окно «Куда класть работу агента?» (#setup-overlay в разметке) показывается ОДИН раз
  // при первом запуске: пусто в поле — прежние места (.agent/ рядом с проектом и папка
  // приложения), выбрана папка — файлы уезжают туда. То же окно открывается потом
  // кнопкой в настройках — выбор можно поменять.
  //
  // Почему выбор идёт своим каналом, а не полем формы настроек: раскладка и защита
  // от «стёртого» выбора живут в главном процессе (src/settings-ipc.js, setup:state и
  // setup:save). Объект настроек, загруженный ДО выбора, принёс бы прежние пустые
  // значения и стёр бы выбор при обычном сохранении — та же болезнь, что у каталога
  // Yandex Cloud и паролей сайтов.
  //
  // Уже лежащие файлы приложение НЕ переносит: раскладка действует с момента выбора,
  // старое остаётся где было (человек сам решает, что со старым делать).
  let setupShownThisRun = false; // приглашение уже показано — второй раз не пристаём

  function fillSetupFields(missionsDir, tasksDir) {
    if ($("setup-missions-dir")) $("setup-missions-dir").value = missionsDir || "";
    if ($("setup-tasks-dir")) $("setup-tasks-dir").value = tasksDir || "";
  }

  async function openSetupFolders(firstRun) {
    if (!isElectron || !api.setupState || !$("setup-overlay")) return false;
    // Телефон папки на ПК не выбирает: раскладка — дело машины, где лежат файлы.
    // Признак моста проверяем осторожно: модуль собирают и в проверках, где окна нет
    // вовсе (там «window» не объявлен и голое обращение уронило бы сборку).
    if (typeof window !== "undefined" && window.__mobileBridge) return false;
    let st = null;
    try {
      st = await api.setupState();
    } catch {}
    const s = getSettings();
    fillSetupFields((st && st.missionsDir) || s.missionsDir || "", (st && st.tasksDir) || s.tasksDir || "");
    if ($("setup-title")) $("setup-title").textContent = firstRun ? "Куда класть работу агента?" : "Папки работы агента";
    if ($("setup-text")) {
      $("setup-text").textContent = firstRun
        ? "Миссии, прогоны и дела агент держит файлами на диске: по ним видно, чем он занят, и по ним же работа поднимается заново после перезапуска приложения. Можно оставить как было или выбрать свои папки, чтобы не забивать папки проектов рабочим грузом."
        : "Тот же выбор, что и при первом запуске — его можно поменять в любой момент.";
    }
    $("setup-overlay").classList.remove("hidden");
    return true;
  }

  function closeSetupFolders() {
    if ($("setup-overlay")) $("setup-overlay").classList.add("hidden");
  }

  // Показ при первом запуске: только пока человек не ответил (настройка firstRunSetup
  // = "ask") и только если файлы работы вообще ведутся — при выключенной долгой
  // работе и выключенных файлах спрашивать не о чем (включит — спросим в следующий раз).
  async function maybeAskFolders() {
    if (setupShownThisRun || !isElectron || !api.setupState) return;
    setupShownThisRun = true;
    const s = getSettings();
    if (s.firstRunSetup === "done") return;
    if (s.agentWorkFiles === false && s.longWork === false) return;
    await openSetupFolders(true);
  }

  // Системный диалог выбора папки: вид ("missions" / "tasks") задаёт подпись окна и
  // папку, с которой начинается выбор (src/settings-ipc.js).
  async function pickSetupFolder(kind) {
    if (!isElectron || !api.pickDirectory) return;
    const p = await api.pickDirectory(kind);
    if (!p) return;
    if (kind === "tasks") fillSetupFields($("setup-missions-dir").value, p);
    else fillSetupFields(p, $("setup-tasks-dir").value);
  }

  // Сохранение выбора. Пустой выбор ("Оставить как было", Esc или клик мимо окна) —
  // это тоже ответ: папки остаются прежними, а вопрос закрывается навсегда.
  async function saveSetupFolders(asIs) {
    if (!isElectron || !api.setupSave) {
      closeSetupFolders();
      return;
    }
    const payload = asIs
      ? {}
      : { missionsDir: (($("setup-missions-dir") || {}).value || "").trim(), tasksDir: (($("setup-tasks-dir") || {}).value || "").trim() };
    let r = null;
    try {
      r = await api.setupSave(payload);
    } catch (e) {
      setSettingsMsg("Не удалось сохранить папки работы: " + ((e && e.message) || e), true);
      return;
    }
    if (!r || !r.ok) {
      setSettingsMsg("Не удалось сохранить папки работы: " + ((r && r.error) || "неизвестная ошибка"), true);
      return;
    }
    // Настройки в памяти окна обновляем теми же значениями: панели читают из них, и
    // без этого они показывали бы прежние папки до перезапуска приложения.
    getSettings().missionsDir = r.missionsDir || "";
    getSettings().tasksDir = r.tasksDir || "";
    getSettings().firstRunSetup = "done";
    closeSetupFolders();
    renderAgentFilesStatus();
    if (asIs) toast("Оставил как было: работа агента остаётся в прежних папках");
    else if (!r.missionsDir && !r.tasksDir) toast("Папки не выбраны: работа агента остаётся в прежних местах");
    else toast("Папки работы сохранены — файлы будут писаться туда с этого момента, старое осталось где было");
  }

  // Сборка окна и кнопки-входа в него. Кнопка добавляется к строке «Файлы работы» в
  // настройках: разметка настроек огромна, а вход в окно нужен ровно один.
  let setupWired = false; // сборка окна ровно одна: повторная навесила бы вторые обработчики
  function wireSetupFolders() {
    if (!$("setup-overlay")) return;
    if (setupWired) return;
    setupWired = true;
    $("btn-setup-save").onclick = () => saveSetupFolders(false);
    $("btn-setup-skip").onclick = () => saveSetupFolders(true);
    if ($("btn-setup-missions-pick")) $("btn-setup-missions-pick").onclick = () => pickSetupFolder("missions");
    if ($("btn-setup-tasks-pick")) $("btn-setup-tasks-pick").onclick = () => pickSetupFolder("tasks");
    if ($("btn-setup-missions-clear")) $("btn-setup-missions-clear").onclick = () => fillSetupFields("", $("setup-tasks-dir").value);
    if ($("btn-setup-tasks-clear")) $("btn-setup-tasks-clear").onclick = () => fillSetupFields($("setup-missions-dir").value, "");
    // Esc и клик мимо окна — это «оставить как было», а не «закрыть и спросить снова»:
    // иначе вопрос возвращался бы при каждом запуске.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("setup-overlay").classList.contains("hidden")) return;
      saveSetupFolders(true);
    });
    $("setup-overlay").addEventListener("click", (e) => {
      if (e.target === $("setup-overlay")) saveSetupFolders(true);
    });
    const row = $("btn-agent-files-open") && $("btn-agent-files-open").parentNode;
    if (row && !$("btn-setup-folders") && typeof document.createElement === "function") {
      const b = document.createElement("button");
      b.id = "btn-setup-folders";
      b.type = "button";
      b.className = "btn btn-ghost btn-small";
      b.title = "Выбрать, куда класть миссии, прогоны и дела (по умолчанию — .agent/ рядом с проектом и папка приложения)";
      b.textContent = "🎯 Папки работы";
      b.onclick = () => openSetupFolders(false);
      row.appendChild(b);
    }
  }

  return {
    providerLabel: providerLabel,
    updateBadge: updateBadge,
    setSettingsMsg: setSettingsMsg,
    setProviderUI: setProviderUI,
    showSettingsTab: showSettingsTab,
    setPreset: setPreset,
    fillSettingsUI: fillSettingsUI,
    collectSettingsFromUI: collectSettingsFromUI,
    renderOtaStatus: renderOtaStatus,
    openSettings: openSettings,
    renderModelHints: renderModelHints,
    requestModelsList: requestModelsList,
    loadModels: loadModels,
    testConnection: testConnection,
    renderProbeResult: renderProbeResult,
    refreshProbeButton: refreshProbeButton,
    probeLocalModelUI: probeLocalModelUI,
    renderVisionDetect: renderVisionDetect,
    loadAuxModels: loadAuxModels,
    renderAgentFilesStatus: renderAgentFilesStatus,
    // Куда класть работу агента: окно первого запуска и та же смена папок позже.
    openSetupFolders: openSetupFolders,
    closeSetupFolders: closeSetupFolders,
    maybeAskFolders: maybeAskFolders,
    saveSetupFolders: saveSetupFolders,
    pickSetupFolder: pickSetupFolder,
    wireSetupFolders: wireSetupFolders,
    renderMemoryStatus: renderMemoryStatus,
    renderBrowserProfileInfo: renderBrowserProfileInfo,
    renderBrowserConnectInfo: renderBrowserConnectInfo,
    saveSettingsUI: saveSettingsUI,
    toggleKey: toggleKey,
  };
});

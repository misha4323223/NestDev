"use strict";

/* ─── Выбор провайдера G4F: аккордеон в настройках, поиск по буквам и список ──
   Вынесено из app.js (этап A, часть 2). Клик по провайдеру подставляет маршрут
   «Провайдер:модель» в поле модели и тихо подгружает точный список моделей из
   запущенного g4f; кнопка «▶» прогоняет полный тест провайдера с логами в консоль;
   при открытии настроек подбирается живой порт g4f.

   Зависимости приходят одним объектом. Значениями — DOM ($), api, признак
   desktop-режима, реестр провайдеров (G4F_PROVIDERS) и адреса полей (URL_INPUT).
   Текущий пресет читается ЖИВОЙ функцией (getPreset): его переписывает панель
   настроек, копия устарела бы молча. Модули панелей (настройки, правая панель,
   проект, быстрый запуск) объявлены в оболочке НИЖЕ точки сбора — поэтому
   отложенные стрелки: прямое чтение биндинга упало бы с «Cannot access before
   initialization» и оборвало загрузку окна. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.G4fPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (G4fPanelDeps) {
  const {
    $, api, isElectron, G4F_PROVIDERS, URL_INPUT, getPreset,
    getSettingsPanel, getSidePanel, getProjectPanel, getDevRun,
  } = G4fPanelDeps || {};
  let g4fProviderQuery = ""; // поиск по провайдерам G4F в настройках
  let g4fProbeLastTs = 0; // авто-подбор порта G4F: не чаще раза в 30 секунд

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
        '<span class="repo-slug">' + getProjectPanel().escHtml(p.name) + "</span>" +
        '<span class="repo-meta">' + getProjectPanel().escHtml(p.desc || "") + "</span>" +
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
        getSettingsPanel().renderModelHints("openai", p.name === "default" ? null : (p.models && p.models.length ? p.models : null));
        renderG4fProviderList();
        refreshG4fModels(p.name);
        getSettingsPanel().setSettingsMsg(
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
      const res = await getSettingsPanel().requestModelsList();
      if (seq !== g4fModelReqSeq) return; // пользователь успел выбрать другого провайдера
      if (!Array.isArray(res) || !res.length) {
        // g4f молчит — оставляем реестровые подсказки провайдера как есть
        if (registryModels.length) getSettingsPanel().renderModelHints("openai", registryModels);
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
      getSettingsPanel().renderModelHints("openai", merged);
      getSettingsPanel().setSettingsMsg(
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
    getSidePanel().switchSideTab("console");
    getSidePanel().termAppend('<div class="term-server"><span class="ts-err">▶ Тест провайдера «' + getProjectPanel().esc(p.name) + "»…</span></div>");
    let result;
    if (isElectron && api.g4fTest) {
      result = await api.g4fTest({ url: base, provider: p.name, model });
    } else {
      getDevRun().termServerAppend('<span class="ts-err">Полный тест доступен в десктоп-приложении (в браузере локальный g4f недоступен).</span>');
      getSettingsPanel().setSettingsMsg("Тест G4F доступен в приложении на ПК.", true);
      return;
    }
    const lines = (result && result.log) || [];
    let okCount = 0;
    let errCount = 0;
    for (const l of lines) {
      const cls = l.level === "err" ? "ts-err" : l.level === "ok" ? "ts-ok" : l.level === "warn" ? "ts-warn" : "ts-info";
      if (l.level === "err") errCount++;
      if (l.level === "ok") okCount++;
      getDevRun().termServerAppend('<span class="' + cls + '">' + getProjectPanel().esc(l.text) + "</span>");
    }
    const verdict = errCount
      ? "Провайдер «" + p.name + "»: есть проблемы — смотри логи в консоли (правая панель)."
      : okCount
        ? "Провайдер «" + p.name + "» отвечает — подробности в консоли."
        : "Провайдер «" + p.name + "»: ответов нет — подробности в консоли.";
    getSettingsPanel().setSettingsMsg(verdict, !!errCount);
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
        getSettingsPanel().setSettingsMsg("Найден живой G4F на «" + r.base + "» — URL обновлён автоматически. Сохрани настройки.", false);
      } else {
        getSettingsPanel().setSettingsMsg("G4F отвечает на «" + r.base + "», а в поле указан «" + norm + "» — если это не тот адрес, поправь URL.", false);
      }
    } catch {}
  }

  // Скрытие/показ блока выбора провайдера при смене пресета и открытии настроек.
  // preset передаётся от кликнутого чипа, потому что наш слушатель срабатывает
  // раньше SettingsPanel.setPreset() и currentPreset ещё не обновился.
  function syncG4fProviderBox(preset) {
    const box = $("g4f-provider-box");
    if (!box) return;
    const active = preset || getPreset();
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

  return {
    renderG4fProviderList: renderG4fProviderList,
    probeG4fPort: probeG4fPort,
    wireG4fProviderPicker: wireG4fProviderPicker,
  };
});

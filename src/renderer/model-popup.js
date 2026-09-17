"use strict";

/* ─── Быстрое переключение модели (попап в шапке) ────────────────────────────
   Вынесено из app.js (этап A, часть 5: остатки окна). Здесь всё, ради чего человек
   жмёт на плашку модели в шапке: список моделей провайдера (кэш, который наполняют
   ещё и настройки), выбор модели в один клик и кнопка «↻ Обновить» с походом за
   живым списком. Плюс навеска событий шапки: открытие, закрытие, клик мимо.

   Зависимости приходят одним объектом. Настройки — ЖИВЫМ доступом: их не только
   читают (провайдер, текущая модель), но и пишут (`settings.model` и поле провайдера),
   а сама оболочка переписывает объект настроек целиком — копия застыла бы. Панель
   настроек объявлена НИЖЕ точки сбора, поэтому берётся отложенной стрелкой.

   Кэш моделей приходит ЗНАЧЕНИЕМ и это осознанно: объект не переприсваивается нигде,
   только наполняется (`cachedModels[provider] = …`), и его же наполняют настройки —
   значит копия была бы вторым кэшем. Сторож в наборе тестов проверяет, что в оболочке
   `cachedModels` действительно нигде не переприсваивается. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ModelPopup = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ModelPopupDeps) {
  const {
    $, isElectron, api, AgentCore, toast, persistSettings,
    PRESET_LABEL, MODEL_KEY, MODEL_INPUT, cachedModels,
    getSettings, getSettingsPanel,
  } = ModelPopupDeps || {};

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
    const provider = getSettings().provider || "openai";
    const cur = getSettings().model || "";
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
    getSettings().model = name;
    getSettings()[MODEL_KEY[provider]] = name;
    const input = $(MODEL_INPUT[provider]);
    if (input) input.value = name;
    persistSettings();
    getSettingsPanel().updateBadge();
    closeModelPopup();
    toast("Модель: " + name);
  }
  async function refreshModelsQuick() {
    const provider = getSettings().provider || "openai";
    const btn = $("mp-refresh");
    btn.disabled = true;
    btn.textContent = "Загружаю...";
    try {
      const cfg = { ...getSettings(), provider, model: "" };
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

  // События шапки. Навешиваются на прежнем месте куска — в том же порядке, что и
  // раньше: сначала кнопки попапа, потом закрытие кликом мимо него.
  function wireHeader() {
    $("model-badge").onclick = toggleModelPopup;
    $("mp-close").onclick = closeModelPopup;
    $("mp-refresh").onclick = refreshModelsQuick;
    $("mp-settings").onclick = () => {
      closeModelPopup();
      getSettingsPanel().openSettings();
    };
    document.addEventListener("mousedown", (e) => {
      const popup = $("model-popup");
      if (popup.classList.contains("hidden")) return;
      if (!popup.contains(e.target) && e.target !== $("model-badge")) closeModelPopup();
    });
  }

  return {
    toggleModelPopup,
    wireHeader,
  };
});

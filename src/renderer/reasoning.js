"use strict";

/* ─── Сколько модель думает перед ответом (Reasoning effort) ──────────────────
   Плашка рядом с полем ввода, как у Freebuff: Low / High / Max (и «Выкл»).
   У большинства моделей с рассуждением это переключатель ВНУТРИ запроса, а не
   настройка сервера, поэтому выбранный уровень уезжает вместе с сообщением
   (opts.reasoning), а в тело запроса его подставляет транспорт — там же, где
   num_ctx и stream_options.

   Уровни наши, а шкала у каждого провайдера своя, поэтому перевод в шкалу живёт
   в provider-transport.js (reasoningEffort), а здесь — только выбор человека и
   его память. Значение лежит в настройках (`settings.reasoning`) и сохраняется
   вместе с ними, как модель и галочка «модель без инструментов».

   Рассуждения умеет не каждая модель, поэтому плашка показывается НЕ ВСЕГДА:
     • рассуждений у модели нет — плашки нет вовсе (её наличие обещало бы то,
       чего не бывает: у Claude транспорт поля не шлёт, у llama3 поле не знает
       сервер). Кто умеет, решает provider-transport.js.reasoningSupport;
     • по имени модели не понять (свой прокси, редкая сборка) — плашку оставляем:
       спрятать работающую настройку хуже, чем показать лишнюю;
     • провайдер САМ отказал полю — запоминаем по модели (markUnsupported ниже):
       иначе каждый запуск тратил бы раунд на ту же ошибку.
   Выбор человека при этом не стирается: вернувшись на рассуждающую модель, он
   найдёт свой уровень там же, где оставил.

   Почему «Выкл» — значение по умолчанию: поле reasoning_effort знают не все
   совместимые серверы, и молча добавлять его каждому запросу значит ломать
   прогоны там, где оно не нужно. Совет: у Anthropic рассуждения включаются
   бюджетом токенов (thinking.budget_tokens), а не уровнем, — там переключатель
   пока ничего не делает. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.Reasoning = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ReasoningDeps) {
  const { $, toast, getSettings, persistSettings, support } = ReasoningDeps || {};

  // Уровни. id — то, что лежит в настройках; подпись — то, что видит человек.
  // Подписи уровней — по-русски: остальные надписи окна русские, а Low/High/Max
  // рядом с ними читались как непереведённый кусок интерфейса.
  const LEVELS = [
    { id: "off", label: "Выкл", hint: "Модель отвечает как обычно" },
    { id: "low", label: "Низкий", hint: "Меньше рассуждений — ответ быстрее" },
    { id: "high", label: "Высокий", hint: "Дольше думает, отвечает точнее" },
    { id: "max", label: "Максимум", hint: "Дольше всех — для самых трудных задач" },
  ];
  const IDS = LEVELS.map((l) => l.id);

  // Чужое или испорченное значение настроек не должно ломать запрос.
  function normalize(v) {
    const s = String(v || "").trim().toLowerCase();
    return IDS.indexOf(s) >= 0 ? s : "off";
  }

  function levelOf(v) {
    const id = normalize(v);
    return LEVELS.find((l) => l.id === id) || LEVELS[0];
  }

  // ─── Умеет ли ТЕКУЩАЯ модель рассуждать ────────────────────────────────────
  // Ключ «у этой модели рассуждений нет» в настройках: «провайдер|модель». По нему
  // помним отказ провайдера — скупо, только сам факт: причина не важна.
  function modelKey(s) {
    const provider = String((s && s.provider) || "");
    const model = String((s && s.model) || "");
    return model ? provider + "|" + model : "";
  }

  function learned() {
    try {
      const map = getSettings().reasoningUnsupported;
      return map && typeof map === "object" ? map : {};
    } catch {
      return {};
    }
  }

  // "yes" — модель рассуждает, "no" — знаем, что нет, "unknown" — не понять.
  // Наружу это `supports()`: по нему же прячется плашка, и его спрашивает набор тестов.
  function supportState() {
    let s;
    try {
      s = getSettings() || {};
    } catch {
      return "unknown"; // настройки недоступны — молчим, плашку не прячем
    }
    const key = modelKey(s);
    if (key && learned()[key]) return "no"; // провайдер уже отказал этой модели
    try {
      const v = support ? support(s.provider, s.model) : "unknown";
      return v === "yes" || v === "no" ? v : "unknown";
    } catch {
      return "unknown";
    }
  }

  function current() {
    try {
      // Модель без рассуждений: уровень не уезжает в запрос, даже если человек выбрал
      // его на другой модели. Сам выбор не трогаем — он вернётся вместе с моделью.
      if (supportState() === "no") return "off";
      return normalize(getSettings().reasoning);
    } catch {
      return "off";
    }
  }

  function labelFor(v) {
    const l = levelOf(v);
    return l.id === "off" ? "Рассуждения" : "Рассуждения · " + l.label;
  }

  // Кнопка рядом с полем ввода: подпись показывает уровень, цвет — что он включён,
  // а у модели без рассуждений кнопки нет вовсе (ей нечего показывать).
  function updateButton() {
    const btn = $("btn-reasoning");
    if (!btn) return;
    const noReasoning = supportState() === "no";
    btn.classList.toggle("hidden", noReasoning);
    if (noReasoning) close(); // открытый попап у такой модели остался бы висеть в воздухе
    const l = levelOf(current());
    // Значок кнопки — SVG в разметке, поэтому подпись живёт в отдельном span:
    // присвоение textContent самой кнопке стёрло бы иконку.
    const label = $("reasoning-label");
    if (label) label.textContent = labelFor(l.id);
    btn.classList.toggle("active", l.id !== "off");
    btn.title = noReasoning
      ? "Эта модель не умеет рассуждать: переключатель не нужен."
      : l.id === "off"
      ? "Рассуждения модели: сколько думать перед ответом. Сейчас выключено."
      : "Рассуждения модели: " + l.label + " — " + l.hint;
  }

  function close() {
    const popup = $("reasoning-popup");
    if (popup) popup.classList.add("hidden");
  }

  function render() {
    const list = $("rp-list");
    if (!list) return;
    list.innerHTML = "";
    const cur = current();
    for (const l of LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mp-item rp-item" + (l.id === cur ? " active" : "");
      b.dataset.reasoning = l.id;
      // Подпись и объяснение рядом: человек выбирает не «low/high», а «быстрее/дольше».
      b.innerHTML = "";
      const name = document.createElement("span");
      name.className = "rp-name";
      name.textContent = l.label;
      const hint = document.createElement("span");
      hint.className = "rp-hint";
      hint.textContent = l.hint;
      b.appendChild(name);
      b.appendChild(hint);
      b.title = l.hint;
      b.onclick = () => set(l.id);
      list.appendChild(b);
    }
    const title = $("rp-title");
    if (title) title.textContent = "Рассуждения модели";
  }

  function toggle() {
    const popup = $("reasoning-popup");
    if (!popup) return;
    if (supportState() === "no") return; // у модели без рассуждений попапу взяться неоткуда
    const willShow = popup.classList.contains("hidden");
    // Попап модели живёт на том же месте — два открытых перекрылись бы.
    const mp = $("model-popup");
    if (willShow && mp) mp.classList.add("hidden");
    popup.classList.toggle("hidden", !willShow);
    if (willShow) render();
  }

  function set(id) {
    const v = normalize(id);
    try {
      getSettings().reasoning = v;
      if (persistSettings) persistSettings();
    } catch {}
    updateButton();
    close();
    toast(v === "off" ? "Рассуждения модели выключены" : "Рассуждения: " + levelOf(v).label);
  }

  // Провайдер сам сказал, что поля рассуждений не знает (отказ ловит прогон): помним
  // это по модели, чтобы плашка пропала и в следующих запусках. Иначе каждый запуск
  // повторял бы ту же ошибку и тратил на неё раунд — а причина отказа у сервера своя
  // и в настройках нам не нужна.
  function markUnsupported(key) {
    try {
      const s = getSettings() || {};
      const k = String(key || "") || modelKey(s);
      if (!k || k.slice(-1) === "|") return false; // модель неизвестна — привязывать не к чему
      const map =
        s.reasoningUnsupported && typeof s.reasoningUnsupported === "object"
          ? s.reasoningUnsupported
          : (s.reasoningUnsupported = {});
      if (map[k]) {
        updateButton();
        return false; // уже знаем — второй раз не сохраняем
      }
      map[k] = true;
      if (persistSettings) persistSettings();
      updateButton();
      return true;
    } catch {
      return false;
    }
  }

  function wire() {
    const btn = $("btn-reasoning");
    if (btn) btn.onclick = toggle;
    const closeBtn = $("rp-close");
    if (closeBtn) closeBtn.onclick = close;
    document.addEventListener("mousedown", (e) => {
      const popup = $("reasoning-popup");
      if (!popup || popup.classList.contains("hidden")) return;
      if (!popup.contains(e.target) && e.target !== btn) close();
    });
    updateButton();
  }

  return {
    LEVELS: LEVELS,
    IDS: IDS,
    normalize: normalize,
    labelFor: labelFor,
    // supports — умеет ли рассуждать ТЕКУЩАЯ модель (по ней же прячется плашка);
    // markUnsupported — провайдер отказал полю, запоминаем это по модели.
    supports: supportState,
    markUnsupported: markUnsupported,
    // get/set — то, чем пользуются оболочка и отправка сообщения.
    get: current,
    set: set,
    wire: wire,
    updateButton: updateButton,
    toggle: toggle,
    close: close,
  };
});

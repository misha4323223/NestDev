"use strict";

/* ─── Окно контекста модели: ручной выбор по клику на чип заполняемости ───────
   Чип «Контекст 52%» под полем ввода стал кнопкой: по клику открывается
   небольшой попап, где человек сам задаёт окно контекста модели.

   Зачем это вообще нужно. Приложение старается узнать окно у сервера
   (provider-transport.js.modelWindow: /api/show у Ollama, поле context_length /
   context_window / max_model_len в ответе /models у остальных). Но
   OpenAI-совместимые роутеры (nrouter.ai и подобные) этих полей НЕ сообщают.
   Тогда окно неизвестно, и бюджет истории берётся «на глаз» — 400 000 токенов
   (context-window.js CLOUD_CTX_BUDGET). На модели с настоящим окном 32k–128k
   это значит: история НЕ сжимается вовремя, запрос уходит за окно, провайдер
   либо отказывает, либо молча обрезает начало. В обрезанном запросе теряется
   схема инструментов и системные правила — именно поэтому агент «тупеет»:
   перестаёт звать инструменты и пишет код прямо в чат.

   Что делает ручное окно. Значение лежит в настройках (`settings.contextWindow`,
   0 = Авто) и в прогоне перебивает авто-определение (run-ai.js): бюджет истории
   считается от него, и сжатие срабатывает ДО того, как запрос упрётся в предел.

   Почему «Авто» остаётся значением по умолчанию: для Ollama и для серверов,
   которые окно сообщают, догадка верна и трогать её незачем. Ручной выбор — это
   лечение случая «окно не сообщается», а не обязательный шаг.

   Значения кнопок и подписи — в разметке (index.html, #ctx-popover): там же и
   подсказка для человека, что ставить при переполнении и что — на большом окне. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ContextUI = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ContextUIDeps) {
  const { $, toast, getSettings, persistSettings } = ContextUIDeps || {};

  // Границы те же, что у нормализации в settings-store.js: ниже 4000 окно смысла
  // не имеет (не влезет даже системный промпт), выше 8M — опечатка в поле ввода.
  const MIN_WINDOW = 4000;
  const MAX_WINDOW = 8000000;
  const CUSTOM = -1; // кнопка «Своё…»: помечает нестандартные значения
  const FALLBACK = 32768; // на открытии «Своё…», когда окно ещё «Авто»

  function say(text) {
    if (typeof toast === "function") toast(text);
  }

  function settingsSafe() {
    try {
      return getSettings() || {};
    } catch {
      return {};
    }
  }

  // Заданное вручную окно: 0 — «Авто» (авто-определение в прогоне). Испорченное
  // значение не должно уезжать в бюджет — приводим к границам.
  function current() {
    const n = Math.round(Number(settingsSafe().contextWindow) || 0);
    if (!(n > 0)) return 0;
    return Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, n));
  }

  // «128k», «200k», «1M» — коротко, как на кнопках. Если число совпало с пресетом,
  // берём ЕГО подпись: человек нажал «128k», и «131k» в подтверждении сбивало бы с толку.
  function fmtWindow(n) {
    const v = Number(n) || 0;
    if (v <= 0) return "Авто";
    const preset = presetButtons().find((b) => parseInt(b.dataset && b.dataset.win, 10) === v);
    if (preset && preset.textContent) return String(preset.textContent);
    if (v >= 1000000) {
      const m = v / 1000000;
      return (m >= 10 ? Math.round(m) : Math.round(m * 10) / 10) + "M";
    }
    return Math.round(v / 1000) + "k";
  }

  function chip() {
    return $("ctx-indicator");
  }

  function presetButtons() {
    const box = $("ctx-pop-opts");
    if (!box || !box.querySelectorAll) return [];
    return Array.prototype.slice.call(box.querySelectorAll(".ctx-opt"));
  }

  function presetWins() {
    return presetButtons()
      .map((b) => parseInt(b.dataset && b.dataset.win, 10))
      .filter((w) => w >= 0);
  }

  // Отрисовка попапа: что стоит сейчас, какая кнопка активна, нужен ли ряд «своё».
  // Показываем и шестерёнку у чипа — по ней видно, что окно задано вручную, а не
  // угадано приложением. Второй аргумент — «показать ряд своё»: его просит клик по
  // «Своё…», когда значение ещё равно пресету или «Авто».
  function render(showCustom) {
    const cur = current();
    const el = chip();
    if (el && el.classList) el.classList.toggle("manual", cur > 0);

    const now = $("ctx-pop-current");
    if (now) {
      now.textContent = cur > 0
        ? "Сейчас: " + fmtWindow(cur) + " — история сжимается, не доходя до этого окна."
        : "Сейчас: Авто — окно определяется само, но роутеры его не сообщают.";
    }

    const custom = (!presetWins().includes(cur) && cur > 0) || !!showCustom;
    presetButtons().forEach((b) => {
      const w = parseInt(b.dataset && b.dataset.win, 10);
      const active = w === CUSTOM ? custom : cur === w;
      b.classList.toggle("active", active);
    });

    const box = $("ctx-pop-custom");
    if (box) box.classList.toggle("hidden", !custom);
    if (custom) {
      const input = $("ctx-pop-input");
      // Поле не затираем: человек мог начать вводить число и уйти за пределы попапа.
      if (input && !String(input.value || "").trim()) input.value = String(cur || FALLBACK);
    }
  }

  function close() {
    const popup = $("ctx-popover");
    if (popup) popup.classList.add("hidden");
    const box = $("ctx-pop-custom");
    if (box) box.classList.add("hidden");
  }

  function toggle() {
    const popup = $("ctx-popover");
    if (!popup) return;
    const willShow = popup.classList.contains("hidden");
    // Попапы модели и рассуждений стоят на том же месте — два открытых перекрылись бы.
    if (willShow) {
      ["model-popup", "reasoning-popup", "role-popover"].forEach((id) => {
        const p = $(id);
        if (p && p.classList) p.classList.add("hidden");
      });
    }
    popup.classList.toggle("hidden", !willShow);
    if (willShow) render();
  }

  // Сохраняем выбор и закрываем попап. 0 — «Авто»: снимаем ручное окно.
  function setWindow(n) {
    let v = Math.round(Number(n) || 0);
    v = v > 0 ? Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, v)) : 0;
    try {
      const s = getSettings();
      s.contextWindow = v;
      if (persistSettings) persistSettings();
    } catch {}
    render();
    close();
    say(v > 0 ? "Окно контекста: " + fmtWindow(v) : "Окно контекста: Авто");
    return v;
  }

  function openCustom() {
    const input = $("ctx-pop-input");
    if (input && !String(input.value || "").trim()) input.value = String(current() || FALLBACK);
    render(true);
    if (input) {
      input.focus();
      if (input.select) input.select();
    }
  }

  function applyCustom() {
    const input = $("ctx-pop-input");
    const raw = parseInt(input && input.value, 10);
    if (!(raw > 0)) {
      say("Укажи окно числом, например 128000");
      return;
    }
    if (raw < MIN_WINDOW || raw > MAX_WINDOW) {
      say("Окно — от " + MIN_WINDOW + " до " + MAX_WINDOW + " токенов");
      return;
    }
    setWindow(raw);
  }

  function wire() {
    const el = chip();
    if (el) {
      el.onclick = toggle;
      el.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          toggle();
        }
      };
    }

    // Кнопки-значения статичны в разметке: обработчик один на контейнере, а не на
    // каждой кнопке. Клик по «Своё…» раскрывает поле, остальные сразу сохраняют.
    const opts = $("ctx-pop-opts");
    if (opts && opts.addEventListener) {
      opts.addEventListener("click", (e) => {
        const b = e.target && e.target.closest ? e.target.closest(".ctx-opt") : null;
        if (!b) return;
        const w = parseInt(b.dataset && b.dataset.win, 10);
        if (w === CUSTOM) openCustom();
        else setWindow(w);
      });
    }

    const apply = $("ctx-pop-apply");
    if (apply) apply.onclick = applyCustom;
    const input = $("ctx-pop-input");
    if (input) {
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyCustom();
        }
      };
    }

    document.addEventListener("mousedown", (e) => {
      const popup = $("ctx-popover");
      if (!popup || popup.classList.contains("hidden")) return;
      if (popup.contains(e.target) || e.target === chip()) return;
      close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const popup = $("ctx-popover");
      if (popup && !popup.classList.contains("hidden")) close();
    });

    render();
  }

  return {
    MIN_WINDOW: MIN_WINDOW,
    MAX_WINDOW: MAX_WINDOW,
    CUSTOM: CUSTOM,
    fmtWindow: fmtWindow,
    // current — заданное вручную окно (0 = «Авто»); setWindow — сохранить и закрыть.
    current: current,
    setWindow: setWindow,
    render: render,
    openCustom: openCustom,
    applyCustom: applyCustom,
    toggle: toggle,
    close: close,
    wire: wire,
  };
});

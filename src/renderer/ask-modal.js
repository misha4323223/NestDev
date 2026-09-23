"use strict";

/* ─── Модалка «вопрос агента» (инструмент askUser) ───────────────────────────
   Вынесено из app.js (этап A, часть 6: остатки окна). Агент умеет спросить человека
   перед необратимым действием: вопрос показывается поверх окна, ответ уходит обратно
   в прогон. Здесь весь диалог: показ вопроса, ВАРИАНТЫ кнопками и своё поле, закрытие
   и три способа ответить — кнопка варианта, «Ответить»/Enter и «Отмена».

   Варианты (часть 42). Модель может передать `options` — 2–6 коротких вариантов.
   Тогда человек отвечает одним нажатием, а если ни один не подходит — пишет своё в
   поле. Варианты пересобираются на КАЖДЫЙ вопрос: кнопки прошлого вопроса рядом с
   новым — это чужой ответ одной рукой (человек жмёт «Да», а вопрос уже другой).

   Ждать ответа приходится и main-процессу (desktop-прогон), и вебу: колбэк хранится
   в модуле, поэтому окно и оба потребителя видят один и тот же ответ, а не копию.
   Ответ отдаётся ровно один раз (`askOnAnswer` снимается до вызова), иначе прогон
   получил бы два ответа на один вопрос.

   Зависимости простые: `$` и глобальный `document` (нужен только для кнопок-вариантов).
   Сборка стоит ВЫШЕ прежнего места куска — на неё смотрят разбор событий агента
   (chat-events.js) и веб-режим (web-chat.js), которые собираются раньше. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.AskModal = factory;
  }
})(typeof self !== "undefined" ? self : this, function (AskModalDeps) {
  const { $ } = AskModalDeps || {};

  // ── Модалка «вопрос агента» (askUser) ──
  let askOnAnswer = null;

  // Кнопки вариантов пересобираются на каждый вопрос (см. заголовок модуля).
  function renderAskOptions(options) {
    const box = $("ask-options");
    box.innerHTML = "";
    const list = Array.isArray(options) ? options : [];
    for (const item of list) {
      const text = String(item == null ? "" : item).replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (typeof document === "undefined" || !document || !document.createElement) break;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ask-option";
      btn.textContent = text;
      btn.onclick = () => answerAsk(text);
      box.appendChild(btn);
    }
    // Нет вариантов — нет и пустой полосы над полем ввода.
    if (box.children && box.children.length) box.classList.remove("hidden");
    else box.classList.add("hidden");
  }

  // Единственная точка ответа: и кнопка варианта, и «Ответить», и «Отмена».
  function answerAsk(text) {
    const cb = askOnAnswer;
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
    if (cb) cb(String(text == null ? "" : text));
  }

  // openAskModal(question, options, onAnswer); старый вызов (question, onAnswer) тоже работает.
  function openAskModal(question, options, onAnswer) {
    if (typeof options === "function") {
      onAnswer = options;
      options = [];
    }
    $("ask-question").textContent = question;
    $("ask-input").value = "";
    $("ask-input").placeholder = Array.isArray(options) && options.length ? "Своё (если ни один вариант не подходит)…" : "Введи ответ...";
    renderAskOptions(options);
    $("ask-overlay").classList.remove("hidden");
    setTimeout(() => $("ask-input").focus(), 60);
    askOnAnswer = onAnswer;
  }

  function closeAskModal() {
    $("ask-overlay").classList.add("hidden");
    askOnAnswer = null;
  }

  // События модалки. Навешиваются на прежнем месте куска — в том же порядке:
  // «Ответить», «Отмена», затем Enter в поле ввода. Кнопки вариантов вешают свой
  // обработчик при сборке (renderAskOptions).
  function wire() {
    $("btn-ask-send").onclick = () => {
      answerAsk($("ask-input").value.trim());
    };
    $("btn-ask-cancel").onclick = () => {
      answerAsk("");
    };
    $("ask-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        $("btn-ask-send").click();
      }
    });
  }

  return {
    openAskModal,
    closeAskModal,
    wire,
    renderAskOptions,
  };
});

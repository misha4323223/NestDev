"use strict";

/* ─── Модалка «вопрос агента» (инструмент askUser) ───────────────────────────
   Вынесено из app.js (этап A, часть 6: остатки окна). Агент умеет спросить человека
   перед необратимым действием: вопрос показывается поверх окна, ответ уходит обратно
   в прогон. Здесь весь диалог: показ вопроса, закрытие и три способа ответить —
   кнопка «Ответить», «Отмена» и Enter (Shift+Enter оставляет перенос строки).

   Ждать ответа приходится и main-процессу (desktop-прогон), и вебу: колбэк хранится
   в модуле, поэтому окно и оба потребителя видят один и тот же ответ, а не копию.

   Зависимости простые: только `$`. Сборка стоит ВЫШЕ прежнего места куска — на неё
   смотрят разбор событий агента (chat-events.js) и веб-режим (web-chat.js), которые
   собираются раньше; отложенная стрелка дала бы лишнюю прослойку в их вызовах, а сами
   вызовы остаются прежними. */
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

  // События модалки. Навешиваются на прежнем месте куска — в том же порядке:
  // «Ответить», «Отмена», затем Enter в поле ввода.
  function wire() {
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
  }

  return {
    openAskModal,
    closeAskModal,
    wire,
  };
});

"use strict";

/* ─── Удобство чата: копирование, повторная генерация, правка сообщения ───────
   Вынесено из app.js (этап 3 разбора гигантов). Здесь три кнопки под сообщением
   и копирование всего чата в markdown: скопировать ответ или своё сообщение,
   перегенерировать последний ответ, вернуть своё сообщение в поле ввода и
   переотправить его.

   Зависимости приходят одним объектом: доступ к DOM ($), всплывашки (toast),
   активный чат, сохранение и перерисовка переписки, отправка сообщения, размер
   поля ввода и текст сообщения. «Идёт генерация» отдаётся живой функцией
   isStreaming(): копия значения устарела бы, и кнопки перебили бы идущий ответ. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatActions = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatActionsDeps) {
  const {
    $, toast, getActiveChat, persistChats, renderMessages,
    sendMessage, autoResize, msgText, chatTitle, isStreaming,
  } = ChatActionsDeps || {};

  // ─────────────── Удобство: копирование, регенерация, редактирование ───────────────
  function copyText(text) {
    const done = () => toast("Скопировано в буфер обмена");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      done();
    }
  }

  // «↻ Перегенерировать» показываем только у последнего ответа агента
  function isLastAssistant(m) {
    const chat = getActiveChat();
    if (!chat) return false;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role !== "tool") return chat.messages[i] === m;
    }
    return false;
  }

  function regenerate(m) {
    if (isStreaming()) return;
    const chat = getActiveChat();
    if (!chat) return;
    const idx = chat.messages.indexOf(m);
    if (idx <= 0) return;
    // Ответ агента может состоять из нескольких сегментов текста и действий —
    // убираем весь запуск: от последнего user-сообщения до конца.
    let start = idx;
    for (let i = idx - 1; i >= 0; i--) {
      if (chat.messages[i].role === "user") {
        start = i + 1;
        break;
      }
    }
    chat.messages.splice(start);
    persistChats();
    renderMessages();
    const lastUser = [...chat.messages].reverse().find((x) => x.role === "user");
    if (lastUser) {
      const inp = $("input");
      inp.value = lastUser.content;
      autoResize();
      sendMessage();
    }
  }

  function editUserMessage(m) {
    if (isStreaming()) return;
    const chat = getActiveChat();
    if (!chat) return;
    const idx = chat.messages.indexOf(m);
    if (idx < 0) return;
    const inp = $("input");
    inp.value = msgText(m.content);
    autoResize();
    inp.focus();
    chat.messages.splice(idx); // удалить это сообщение и всё после — текст уже в поле ввода
    persistChats();
    renderMessages();
  }

  // Скопировать активный чат в буфер обмена в виде markdown
  function copyChat() {
    const chat = getActiveChat();
    if (!chat || !chat.messages.length) {
      toast("Чат пуст");
      return;
    }
    const lines = ["# " + chatTitle(chat), ""];
    for (const m of chat.messages) {
      if (m.role === "user") {
        lines.push("**Пользователь:**", "", m.content || "", "");
      } else if (m.role === "assistant") {
        lines.push("**Ассистент:**", "", m.content || "", "");
      } else if (m.role === "tool") {
        lines.push("**Инструмент:** " + (m.toolName || ""), "", "```", m.toolResult || "", "```", "");
      }
    }
    copyText(lines.join("\n"));
  }

  return {
    copyText: copyText,
    copyChat: copyChat,
    isLastAssistant: isLastAssistant,
    regenerate: regenerate,
    editUserMessage: editUserMessage,
  };
});

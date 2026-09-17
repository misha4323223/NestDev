"use strict";

/* ─── Переименование чата: двойной клик по заголовку → инлайн-ввод ────────────
   Вынесено из app.js (этап A, часть 6: остатки окна). Заголовок чата в шапке меняется
   прямо на месте: вместо него встаёт поле ввода, Enter сохраняет, Escape отменяет,
   уход фокуса (клик мимо) сохраняет. Пустое имя и то же самое имя не сохраняются —
   иначе в списке чатов появлялось бы «Чат переименован» без переименования.

   Зависимости приходят одним объектом. Оболочка отдаёт каталог чатов и перерисовку
   списка функциями, а признак идущего прогона — ЖИВЫМ доступом: во время генерации
   переименование запрещено, а прогон начинается и кончается по ходу работы. Копия
   значения «идёт генерация» застыла бы на состоянии загрузки окна. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatRename = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatRenameDeps) {
  const {
    $, toast, getActiveChat, getStreaming, chatTitle, persistChats, renderSidebar,
  } = ChatRenameDeps || {};

  // Переименование чата: двойной клик по заголовку → инлайн-ввод
  function startRenameChat() {
    const chat = getActiveChat();
    if (!chat || getStreaming()) return;
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

  return {
    startRenameChat,
  };
});

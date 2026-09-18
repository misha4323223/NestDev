"use strict";

/* ─── Продолжение чата: контекст задачи из прошлого чата ─────────────────────
   Вынесено из app.js (этап A, часть 10: остатки окна). Кнопка «🔄 Продолжить
   контекст» заводит новый чат и переносит в него не последний ответ, а СУТЬ
   задачи: последний запрос пользователя, последний ответ агента и хвост диалога.
   Перенос ограничен по символам — он должен быть компактным, а не копией чата.

   Что именно переносить, решает `buildContinuationContext`: она чистая (на входе
   разговор, на выходе текст) и проверяется тестом отдельно. Живые доступы — только
   у самого обработчика: признак прогона (во время ответа кнопка не работает) и
   активный чат (его берём в момент нажатия — копия застыла бы на старом чате).

   `wire()` навешивает обработчик ровно там, где он висел раньше: кнопку жмут и
   мышью, и из палитры команд (`$("btn-continue-chat").click()`), поэтому обработчик
   обязан быть на самой кнопке, а не в общем слушателе. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatContinue = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatContinueDeps) {
  const { $, getStreaming, getActiveChat, createChat } = ChatContinueDeps || {};

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

  // Навешивается на прежнем месте куска.
  function wire() {
    $("btn-continue-chat").onclick = () => {
      if (getStreaming()) return;
      const prev = getActiveChat();
      if (!prev || !prev.messages.length) { createChat(); return; }
      const title = prev.title && prev.title !== "Новый чат" ? prev.title : "";
      createChat({
        contextMsg: buildContinuationContext(prev),
        title: title ? title + " (продолжение)" : "Новый чат (продолжение)",
      });
    };
  }

  return {
    buildContinuationContext,
    wire,
  };
});

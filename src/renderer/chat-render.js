"use strict";

/* ─── Отрисовка сообщения: текст, вложения, метка времени и кнопки ────────────
   Вынесено из app.js (этап 3.7, часть 3). Здесь одно сообщение превращается в
   элемент ленты: пузырь с markdown (или ошибкой), картинки-вложения как части
   содержимого, метка времени, плашка размышлений, кнопка «Дописать ответ» у
   прерванного хода и кнопки действий — скопировать, перегенерировать, править.

   Зависимости приходят одним объектом: рендер markdown (MdRender), часы (fmtClock),
   плашка размышлений (ChatThinking), действия под сообщением (ChatActions), возврат
   к прерванному ответу (continueInterruptedAnswer) и ЖИВЫЕ данные чатов
   (getChatsData — объект перезаписывают, копия устарела бы молча). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatRender = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatRenderDeps) {
  const { MdRender, fmtClock, ChatThinking, ChatActions, continueInterruptedAnswer, getChatsData } = ChatRenderDeps || {};

  // content сообщения может быть строкой или массивом частей
  // [{type:"text",text},{type:"image_url",image_url:{url}}] — вложения-скриншоты.
  function msgText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
    }
    return "";
  }
  function msgHtml(content) {
    if (typeof content === "string") return MdRender.render(content);
    if (Array.isArray(content)) {
      let h = "";
      for (const p of content) {
        if (!p) continue;
        if (p.type === "image_url" && p.image_url && p.image_url.url) {
          h += '<div class="md-attach"><img src="' + MdRender.esc(p.image_url.url) + '" alt="изображение" /></div>';
        }
      }
      const txt = msgText(content);
      if (txt) h += MdRender.render(txt);
      return h;
    }
    return "";
  }

  function buildBubbleEl(m) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + (m.error ? "error" : m.role);
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (m.pending ? " pending" : "");
    if (m.error) {
      bubble.textContent = m.error;
    } else {
      bubble.classList.add("md");
      bubble.innerHTML = msgHtml(m.content);
    }
    wrap.appendChild(bubble);
    if (m.createdAt) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = fmtClock(m.createdAt);
      wrap.appendChild(meta);
    }
    // Прерванный ответ (приложение закрыли посреди хода): кнопка «Дописать ответ»
    if (m.role === "system" && m.interrupted) {
      const row = document.createElement("div");
      row.className = "msg-actions";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ma-btn";
      b.textContent = "↻ Дописать ответ";
      b.title = "Продолжить прерванный ответ с того места, где он остановился";
      b.onclick = (e) => {
        e.stopPropagation();
        if (row.parentNode) row.parentNode.removeChild(row);
        // Живые данные чатов — через getChatsData(): объект перезаписывают, копия устарела бы.
        continueInterruptedAnswer(m.chatId || getChatsData().activeId, m);
      };
      row.appendChild(b);
      wrap.appendChild(row);
    }
    // Сохранённые размышления (после перезагрузки/переключения чата) — свёрнуты
    if (m.role === "assistant" && m.thinking) ChatThinking.restoreThinkBox(wrap, m.thinking, m.pending);
    // Кнопки действий под сообщением: копировать, перегенерировать, редактировать
    if (!m.pending && (m.role === "user" || (m.role === "assistant" && !m.error))) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const addBtn = (label, title, fn) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ma-btn";
        b.textContent = label;
        b.title = title;
        b.onclick = fn;
        actions.appendChild(b);
      };
      if (m.role === "assistant") {
        addBtn("⧉", "Скопировать ответ", () => ChatActions.copyText(msgText(m.content)));
        if (ChatActions.isLastAssistant(m)) addBtn("↻", "Сгенерировать ответ заново", () => ChatActions.regenerate(m));
      } else if (m.role === "user") {
        addBtn("⧉", "Скопировать сообщение", () => ChatActions.copyText(msgText(m.content)));
        addBtn("✏️", "Редактировать — вставить в поле ввода и переотправить", () => ChatActions.editUserMessage(m));
      }
      wrap.appendChild(actions);
    }
    return wrap;
  }

  return {
    msgText: msgText,
    msgHtml: msgHtml,
    buildBubbleEl: buildBubbleEl,
  };
});

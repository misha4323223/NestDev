"use strict";

/* ─── Сегменты ответа: хронологический лог «текст → действия → текст → …» ─────
   Вынесено из app.js (этап 3.7, часть 2). Текст, пришедший сразу после действия,
   открывается НОВЫМ сообщением ниже блока действий, а не дописывается в пузырь
   сверху: иначе непонятно, что модель сделала и что сказала после этого.

   Зависимости приходят одним объектом: DOM ($), новый идентификатор (uid), ЖИВАЯ
   сессия запуска (getSession — её переписывают, копия устарела бы молча), карта
   элементов сообщений (msgEls), сборка сообщения (buildMessageEl), прокрутка вниз
   (scrollBottom), отложенное сохранение истории (persistChatsSoon) и отметка нового
   раунда работы для плана (planRoundStarted). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatSegments = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatSegmentsDeps) {
  const { $, uid, getSession, msgEls, buildMessageEl, scrollBottom, persistChatsSoon, planRoundStarted } = ChatSegmentsDeps || {};

  // ─── Сегменты ответа: хронологический лог «текст → действия → текст → …» ───
  // Текст, пришедший сразу после действия (tool-сообщения), открывается НОВЫМ
  // сообщением ниже блока действий, а не дописывается в пузырь сверху.
  function ensureSegmentForText(chat, aMsg) {
    if (!chat) return aMsg || null;
    const msgs = chat.messages;
    const last = msgs[msgs.length - 1];
    const sess = getSession();
    const segIds = sess && Array.isArray(sess.segmentIds) ? sess.segmentIds : null;
    if (last && last.role === "tool") {
      // Текст после действия — новый сегмент ответа в конец (ниже блока действий).
      const seg = { id: uid(), role: "assistant", content: "", pending: true, createdAt: Date.now() };
      msgs.push(seg);
      if (segIds) segIds.push(seg.id);
      planRoundStarted(chat, seg.id); // новый раунд работы закрывает шаг текстового плана
      $("messages").appendChild(buildMessageEl(seg));
      scrollBottom();
      return seg;
    }
    // Дописываем в последний сегмент текущего запуска, если он ещё последний.
    if (last && last.role === "assistant" && (!segIds || segIds.includes(last.id))) return last;
    return aMsg || null;
  }

  // Убрать пустой сегмент (промежуточный текст так и не появился) из данных и из DOM.
  function removeSegment(chat, s) {
    const idx = chat.messages.indexOf(s);
    if (idx >= 0) chat.messages.splice(idx, 1);
    const el = msgEls.get(s.id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    msgEls.delete(s.id);
    const sess = getSession();
    if (sess && Array.isArray(sess.segmentIds)) {
      const i = sess.segmentIds.indexOf(s.id);
      if (i >= 0) sess.segmentIds.splice(i, 1);
    }
    persistChatsSoon();
  }

  // Все assistant-сегменты текущего запуска (по порядку).
  function runSegments(chat, aMsg) {
    const sess = getSession();
    const ids = sess && Array.isArray(sess.segmentIds) ? sess.segmentIds : null;
    if (!ids || !chat) return [aMsg].filter(Boolean);
    const segs = ids.map((id) => chat.messages.find((m) => m.id === id)).filter(Boolean);
    return segs.length ? segs : [aMsg].filter(Boolean);
  }

  return {
    ensureSegmentForText: ensureSegmentForText,
    removeSegment: removeSegment,
    runSegments: runSegments,
  };
});

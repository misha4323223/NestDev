"use strict";

/* ─── Лента сообщений: умная прокрутка и очередь кадра при стриме ────────────
   Вынесено из app.js (этап 3.7, часть 4). Здесь ходят вместе две вещи.
   Умная прокрутка: пока человек читает выше — вниз не дёргаем, показываем
   плавающую кнопку «↓»; по клику или новому сообщению возвращаемся в конец.
   Экономия кадров при печати ответа: текст копится в данных, а DOM обновляется
   не чаще одного кадра — раньше КАЖДЫЙ чанк модели заменял innerHTML всего
   пузыря, и браузер десятки раз в секунду пересобирал сотни узлов и заново
   растеризовал «стеклянную» подложку, отчего интерфейс начинал «жевать».

   Зависимости приходят одним объектом: DOM ($), карта элементов сообщений
   (msgEls) и рендер содержимого (msgHtml). Отрисовка сообщения живёт в
   chat-render.js и собирается НИЖЕ этой проводки, поэтому msgHtml передаётся
   стрелкой, а не копией функции: копия на этом месте была бы пустой. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatFeed = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatFeedDeps) {
  const { $, msgEls, msgHtml } = ChatFeedDeps || {};

  // Умная прокрутка: пока пользователь читает выше — не дёргаем вниз,
  // показываем плавающую кнопку «↓»; по клику/новому сообщению — обратно вниз.
  let pinnedToBottom = true;
  function scrollBottom() {
    const w = $("messages");
    if (!pinnedToBottom) return;
    w.scrollTop = w.scrollHeight;
  }
  // Кнопка «↓» — необязательный спутник ленты: если её нет в разметке, прокрутка
  // обязана работать и молча. Раньше обращения к ней падали с «Cannot read
  // properties of null», и падение обрывало перерисовку ленты (1.5.118).
  function pinButton() {
    return $("btn-scroll-bottom") || null;
  }
  function updatePinState() {
    const w = $("messages");
    const nearBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 90;
    pinnedToBottom = nearBottom;
    const btn = pinButton();
    if (btn) btn.classList.toggle("hidden", nearBottom);
  }
  function jumpToBottom() {
    pinnedToBottom = true;
    const btn = pinButton();
    if (btn) btn.classList.add("hidden");
    const w = $("messages");
    w.scrollTop = w.scrollHeight;
  }
  // Прыжок в конец БЕЗ кнопки: так перерисовка ленты гасит прокрутку вниз. Здесь
  // важно не трогать элементы вне ленты: лента очищает себя целиком, и любой её
  // спутник, попавший внутрь, будет удалён вместе с содержимым.
  function pinBottom() {
    pinnedToBottom = true;
    const w = $("messages");
    w.scrollTop = w.scrollHeight;
  }

  // ─── Экономия кадров при стриме ───
  // Раньше КАЖДЫЙ чанк модели заменял innerHTML всего пузыря: на длинном ответе
  // браузер десятки раз в секунду пересобирал сотни узлов и заново растеризовал
  // «стеклянную» подложку — интерфейс начинал «жевать» при печати. Теперь текст
  // копится в данных, а DOM обновляется не чаще одного раза за кадр (финальный
  // рендер всё равно делает finishStream).
  let streamRenderRaf = 0;
  let streamDirty = [];
  function queueBubbleRender(chat, seg) {
    if (!seg) return;
    if (streamDirty.indexOf(seg.id) < 0) streamDirty.push(seg.id);
    if (streamRenderRaf) return;
    streamRenderRaf = requestAnimationFrame(() => {
      streamRenderRaf = 0;
      const ids = streamDirty;
      streamDirty = [];
      for (const id of ids) {
        const m = chat && chat.messages.find((x) => x.id === id);
        const el = msgEls.get(id);
        const b = el && el.querySelector ? el.querySelector(".bubble") : null;
        if (!m || !b) continue;
        b.classList.add("md");
        b.innerHTML = msgHtml(m.content);
      }
      scrollBottom();
    });
  }

  // Автопрокрутка — тоже не чаще кадра: scrollTop = scrollHeight заставляет браузер
  // синхронно пересчитать раскладку, и на каждый чанк это лишняя работа.
  let streamScrollRaf = 0;
  function scrollBottomSoon() {
    if (streamScrollRaf) return;
    streamScrollRaf = requestAnimationFrame(() => {
      streamScrollRaf = 0;
      scrollBottom();
    });
  }


  return {
    scrollBottom: scrollBottom,
    scrollBottomSoon: scrollBottomSoon,
    updatePinState: updatePinState,
    jumpToBottom: jumpToBottom,
    pinBottom: pinBottom,
    queueBubbleRender: queueBubbleRender,
  };
});

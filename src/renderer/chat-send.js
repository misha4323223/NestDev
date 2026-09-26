"use strict";

/* ─── Отправка: ход агента, обычная отправка и досылка прерванного ответа ─────
   Вынесено из app.js (этап A, часть 9). Здесь ядро чата: собрать историю текущего
   чата и отдать её агенту, показать пару «запрос пользователя → ответ агента» в
   ленте и завершить прогон, когда поток закрылся.

   Один прогон агента (`runTurn`) на всех — на кнопку «Отправить», на автозадачу
   планировщика и на «Выполнить план». Второй копии этой логики (история, сессия,
   отправка в main или в веб, завершение) быть не должно: починка в одном месте
   тогда обходила бы другое.

   Живые доступы (функциями, а не значениями) — потому что эти значения меняются
   по ходу хода, а копия застыла бы:
     • идёт ли прогон (streaming) — по нему отправка отказывается работать;
     • объект сессии (session) — его читает разбор событий агента и загрузка истории;
     • прерывание браузерного прогона (webAbort) — за него дёргает остановка;
     • режим плана (planToggleOn) — выключается сразу после отправки запроса;
     • прикреплённый скриншот (pendingImage) — это вложение к отправляемому сообщению;
     • счётчик отката (lastUndoCount) — обнуляется на новом запуске;
     • объект настроек (settings) — модель и активный проект читаются отсюда.

   Отложенные стрелки — то, что собирается НИЖЕ точки сбора: лента, панель настроек,
   панель плана, разбор событий агента, прогон ответа, автозадачи и веб-режим.

   Сборка стоит ВЫШЕ прежнего места куска (перед панелью плана): панель плана берёт
   `sendMessage` значением, а её кнопки («Выполнить план») отправляют запрос тем же
   путём. Так все вызовы в оболочке остаются простыми переименованиями. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatSend = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatSendDeps) {
  const {
    $, isElectron, api, uid, toast,
    renderSidebar, buildMessageEl, autoResize, hideAttachBar, selectChat,
    getActiveChat, createChat,
    getSettings, getChatsData, getStreaming,
    getPlanToggleOn, setPlanToggleOn,
    getPendingImage, getPendingFiles, getReasoning, setLastUndoCount,
    setSession, getWebAbort, setWebAbort,
    getChatFeed, getPlanPanel, getSettingsPanel,
    getChatEvents, getChatRun, getAutoTasks, getWebChat,
    ChatStore,
  } = ChatSendDeps || {};

  // Продолжить ответ, прерванный закрытием приложения. Идём тем же путём, что и
  // обычная отправка (в историю попадает прозрачная просьба дописать), поэтому
  // агент видит контекст и просто доводит задачу до конца.
  function continueInterruptedAnswer(chatId, m) {
    if (getStreaming()) {
      toast("Дождись окончания текущего ответа");
      return;
    }
    const chat = getChatsData().chats.find((c) => c.id === chatId);
    if (!chat) return;
    if (m) m.interrupted = false;
    if (getChatsData().activeId !== chat.id) selectChat(chat.id);
    const input = $("input");
    input.value = "Продолжи предыдущий ответ с того места, где он прервался, и доведи задачу до конца. Не начинай заново и не повторяй уже сделанное.";
    autoResize();
    sendMessage();
  }

  // Один прогон агента в конкретном чате. Сюда идут И обычная отправка, И автозадача:
  // второй копии логики (история, сессия, стрим, завершение) быть не должно — иначе
  // починка в одном месте обходит другое.
  async function runTurn(chat, content, opts) {
    opts = opts || {};
    const usePlan = !!opts.plan;
    chat.messages.push({ id: uid(), role: "user", content, createdAt: Date.now() });
    const assistantMsg = { id: uid(), role: "assistant", content: "", pending: true, createdAt: Date.now() };
    if (usePlan) assistantMsg.plan = true;
    chat.messages.push(assistantMsg);
    renderSidebar();
    $("welcome").classList.add("hidden");
    $("messages").appendChild(buildMessageEl(chat.messages[chat.messages.length - 2]));
    $("messages").appendChild(buildMessageEl(assistantMsg));
    getChatFeed().scrollBottom();
    ChatStore.persistChats();
    getChatRun().setStreaming(true);
    getChatRun().hideResume(); // новый прогон — старая кнопка «Продолжить» не нужна

    // История уходит в main ЦЕЛИКОМ: там её держат в бюджете модели, а при переполнении
    // голова уходит в памятку (сжатие). Раньше история обрезалась здесь по ПОЛНОМУ бюджету
    // модели — на длинном чате срез схлопывался до одного последнего сообщения, сжатию было
    // нечего сворачивать, и агент терял задачу («перестаёт нормально работать»).
    let history = chat.messages
      .filter((m) => {
        if (!m || !m.content) return false;
        if (m.role === "user" || m.role === "assistant") return true;
        // Служебные заметки (перенос задачи из прошлого чата, восстановление после сбоя,
        // авто-переключение подключения) — тоже часть контекста.
        return m.role === "system";
      })
      .map((m) => ({ role: m.role, content: m.content }));

    setSession({ chatId: chat.id, assistantId: assistantMsg.id, segmentIds: [assistantMsg.id] });
    try {
      if (isElectron) {
        await api.sendMessage(history, { plan: usePlan, role: chat.role || "dev", chatId: chat.id, reasoning: getReasoning ? getReasoning() : "off" });
      } else {
        setWebAbort(new AbortController());
        try {
          await getWebChat().webSend(history, getChatEvents().onAiEvent, getWebAbort().signal, { plan: usePlan, role: chat.role || "dev", chatId: chat.id, reasoning: getReasoning ? getReasoning() : "off" });
        } catch (e) {
          if (e.name !== "AbortError") getChatEvents().onAiEvent({ type: "error", message: e.message || String(e) });
        }
      }
    } finally {
      getChatRun().finishStream(chat, assistantMsg);
      setSession(null);
      setWebAbort(null);
      getAutoTasks().flushAutoQueue(); // во время прогона автозадача ждала — самое время её запустить
    }
    return assistantMsg;
  }

  async function sendMessage() {
    const input = $("input");
    const text = input.value.trim();
    if (!text || getStreaming()) return;
    setLastUndoCount(0); // новый запуск — счётчик отката обнуляется
    if (getPlanPanel().planRotate(getActiveChat())) getPlanPanel().renderPlanPanel();
    if (!getSettings().model) {
      // У чипов-действий («Создать файл» и т.п.) не получается выполнить задачу
      // без модели — показываем понятное сообщение в настройках.
      getSettingsPanel().openSettings("model");
      getSettingsPanel().setSettingsMsg(
        "Сначала выбери модель: провайдер → API-ключ (для облака) → кнопка «Проверить подключение» → клик по модели из списка → «Сохранить настройки». Пока модель не выбрана, команды агенту («создай файл…») выполнить нельзя.",
        true
      );
      return;
    }
    let chat = getActiveChat();
    if (!chat) chat = createChat();
    if (chat.title === "Новый чат") chat.title = text.slice(0, 42) + (text.length > 42 ? "…" : "");

    const usePlan = getPlanToggleOn();
    if (usePlan) {
      // Режим плана применяется к одному запросу, дальше выключается
      setPlanToggleOn(false);
      $("btn-plan").classList.remove("active");
    }
    // Вложения: картинка уходит отдельной частью (image_url), а текстовые файлы —
    // прямо в текст сообщения: у модели без зрения другого способа увидеть файл нет.
    const files = (getPendingFiles && getPendingFiles()) || [];
    const body = files.length
      ? text + "\n\n" + files.map((f) => "--- Файл: " + f.name + " ---\n" + f.text).join("\n\n")
      : text;
    const content = getPendingImage()
      ? [{ type: "text", text: body }, { type: "image_url", image_url: { url: getPendingImage() } }]
      : body;
    hideAttachBar();
    input.value = "";
    autoResize();
    await runTurn(chat, content, { plan: usePlan });
  }

  return {
    continueInterruptedAnswer,
    runTurn,
    sendMessage,
  };
});

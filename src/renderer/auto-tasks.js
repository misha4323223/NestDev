"use strict";

/* ─── Автозадачи (планировщик дел) ───────────────────────────────────────────
   Вынесено из app.js (этап A, часть 4: остатки окна). Дело с отметкой «выполняет
   агент» приложение запускает само по сроку: агент молча работает в отдельном чате
   «Автозадачи», ответ остаётся там. Если в этот момент идёт другой прогон, автозадача
   встаёт в очередь и стартует сразу после него. Здесь же «▶ Сейчас» из строки дела
   (тот же прогон, но по кнопке) и подтверждение планировщику.

   Зависимости приходят одним объектом. ЖИВЫЕ функции, а не копии: настройки, признак
   идущего прогона и история чатов переписываются по ходу работы — копия устарела бы
   молча. Дела с миссией (TasksMission) собираются правой панелью НИЖЕ точки сбора
   этого модуля, поэтому берутся отложенной стрелкой: прямое чтение биндинга упало бы
   с «Cannot access before initialization» и оборвало загрузку окна. Остальное — признак
   desktop-режима, мост IPC, тосты, uid, чаты (создание, запись, отрисовка, выбор) и
   прогон агента — передано значениями.

   Очередь (autoQueue) отдаётся наружу как есть: её наполняет еще и разбор событий
   агента (chat-events.js) по сроку из планировщика, поэтому копия не годится. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.AutoTasks = factory;
  }
})(typeof self !== "undefined" ? self : this, function (AutoTasksDeps) {
  const {
    isElectron, api, toast, uid, createChat, persistChats, renderSidebar, selectChat,
    runTurn, getSettings, getStreaming, getChatsData, getTasksMission,
  } = AutoTasksDeps || {};

  // ─────────────── Автозадачи (планировщик дел) ───────────────
  // Дело с отметкой «выполняет агент» приложение запускает само по сроку: агент молча
  // работает в отдельном чате «Автозадачи», ответ остаётся там. Если в этот момент идёт
  // другой прогон — автозадача встаёт в очередь и стартует сразу после него.
  const AUTO_CHAT_TITLE = "Автозадачи";
  const autoQueue = [];

  function ensureAutoChat() {
    let chat = getChatsData().chats.find((c) => c.auto === true);
    if (chat) return chat;
    chat = createChat({ title: AUTO_CHAT_TITLE });
    chat.auto = true;
    chat.role = "manager";
    chat.messages.push({
      id: uid(),
      role: "system",
      content: "🗓 Это чат автозадач: сюда приложение складывает дела, которые агент выполняет сам по сроку. Задачи появляются здесь без твоего участия — можно просто читать ответы.",
      createdAt: Date.now(),
    });
    persistChats();
    renderSidebar();
    return chat;
  }

  function autoTaskText(t) {
    const what = String(t.prompt || "").trim() || "Выполни это дело и кратко напиши результат.";
    return "⏰ Автозадача по сроку: «" + t.title + "»\n\n" + what;
  }

  // «▶ Сейчас» из строки дела: тот же прогон, что и по сроку, но не по сроку и без правки
  // расписания (manual) — чтобы человек мог проверить запуск, не дожидаясь часа.
  function startAutoRunNow(t) {
    if (!isElectron) { toast("Дела: автозапуск работает в приложении на ПК"); return; }
    if (!t || !t.id) return;
    if (!t.auto) { toast("Дела: сначала включи «▶ агент» в строке дела"); return; }
    if (getStreaming()) { toast("⏰ Агент занят другим прогоном — нажми «▶ сейчас» чуть позже"); return; }
    runAutoTask({
      id: t.id,
      title: t.title,
      prompt: t.prompt || "",
      note: t.note || "",
      repeat: t.repeat || "",
      due: t.due,
      auto: true,
      manual: true,
    });
  }

  function flushAutoQueue() {
    if (getStreaming() || !autoQueue.length) return;
    runAutoTask(autoQueue.shift());
  }

  // Подтверждение планировщику. Раньше его не было, и дело считалось запущенным ещё
  // до прогона: не хватило модели, сорвался запрос, кончился прогон — и автозадача
  // больше не срабатывала НИКОГДА. Теперь планировщик повторяет попытку и в конце
  // говорит человеку вслух.
  function autoAck(task, ok, error) {
    if (!task || !task.id || task.manual) return;
    try {
      if (api && api.tasksAutoAck) api.tasksAutoAck(task.id, ok !== false, error || "");
    } catch {}
  }

  async function runAutoTask(task) {
    // Автозадачу выполняет ПК-клиент: у чатов один хозяин, иначе прогон удвоился бы
    // (событие срока уходит и на телефон).
    if (!isElectron) return;
    if (!task || !task.id) return;
    if (getStreaming()) {
      if (task.manual) { toast("⏰ Агент занят другим прогоном — нажми «▶ сейчас» чуть позже"); return; }
      if (!autoQueue.some((q) => q.id === task.id)) autoQueue.push(task);
      return;
    }
    if (!getSettings().model) {
      autoAck(task, false, "не выбрана модель");
      toast("⏰ Дело «" + task.title + "» — автозапуск отложен: не выбрана модель");
      return;
    }
    const chat = ensureAutoChat();
    if (getChatsData().activeId !== chat.id) selectChat(chat.id);
    autoAck(task, true); // прогон начинается — срок закрыт, повтор сдвигается
    let assistantMsg = null;
    try {
      assistantMsg = await runTurn(chat, autoTaskText(task), {});
    } catch (e) {
      autoAck(task, false, "прогон сорвался: " + (e && e.message ? e.message : e));
      toast("⏰ Автозадача «" + task.title + "» сорвалась — смотри чат «Автозадачи»");
      return;
    }
    if (assistantMsg && assistantMsg.error) {
      toast("⏰ Автозадача «" + task.title + "» не выполнилась — смотри чат «Автозадачи»");
      return;
    }
    // Разовое дело после выполнения закрываем: сделано — висеть просроченным незачем.
    if (!task.repeat && api && api.tasksDone) {
      try { await api.tasksDone(task.id); } catch {}
      getTasksMission().renderTasks();
    }
    // Ручной прогон удался — снимаем «сдался», планировщик снова берёт это дело.
    if (task.manual && task.auto && api && api.tasksAutoRearm) {
      try { await api.tasksAutoRearm(task.id); } catch {}
      getTasksMission().renderTasks();
    }
  }

  return {
    autoQueue,
    startAutoRunNow,
    flushAutoQueue,
  };
});

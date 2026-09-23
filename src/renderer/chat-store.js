"use strict";

/* ─── Хранилище: настройки и история чатов (загрузка, чистка, запись) ────────
   Вынесено из app.js (этап A, часть 7: хранилище и автосохранение). Здесь всё,
   что касается записи состояния на диск: загрузка при старте, чистка истории
   после аварийного закрытия, сохранение настроек, сохранение чатов и отложенная
   запись во время длинного ответа.

   Почему автосохранение вообще есть: раньше чат писался на диск только в начале и
   в конце хода. Если приложение закрыть посреди ответа, весь уже полученный текст
   и действия пропадали. Теперь пишем не чаще раза в 1.5 c и гарантированно
   сбрасываем данные при закрытии/сворачивании окна.

   Живые доступы (функциями, а не значениями):
     • настройки и история чатов ПЕРЕПИСЫВАЮТСЯ ЦЕЛИКОМ — и при загрузке с диска,
       и при синхронизации с другого устройства (chats:reload), поэтому модуль
       читает их через getSettings()/getChatsData() и пишет через
       setSettings()/setChatsData();
     • предел истории планов (PLAN_ARCHIVE_LIMIT) объявлен в оболочке НИЖЕ точки
       сбора, поэтому и он приходит стрелкой — иначе окно падало бы на загрузке
       (обращение к const до инициализации);
     • признак прогона (session) — по нему синхронизация с другого устройства
       отказывается перечитывать историю: перезагрузка потеряла бы свой ответ.

   Здесь же и СИНХРОНИЗАЦИЯ ИСТОРИИ между устройствами (этап A, часть 10): история
   лежит в одном файле, а клиентов несколько — когда сохраняет другой клиент, приходит
   событие chats:reload, и файл надо перечитать (с телефона написанный ответ иначе
   появлялся на ПК только после перезапуска).

   Значениями приходят только то, что не меняется: признак Electron, мост api,
   нормализатор настроек и ядро (AgentCore.normalizePlanTasks). */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ChatStore = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ChatStoreDeps) {
  const {
    isElectron,
    api,
    AgentCore,
    normalize,
    getSettings,
    setSettings,
    getChatsData,
    setChatsData,
    getPlanArchiveLimit,
    getSession,
    setRemoteRunNotified,
    renderSidebar,
    renderMessages,
    toast,
    getProjectPanel,
    afterLoad,
  } = ChatStoreDeps || {};

  // Один раз после загрузки состояния зовём оболочку: ей есть что показать ПОСЛЕ
  // того, как настройки прочитаны с диска. Так работает окно первого запуска
  // «Куда класть работу агента» (settings-panel.js) — оно обязано появиться поверх
  // готового окна, а не рядом с недочитанными настройками. Зовём ровно один раз:
  // перечитывание истории с другого устройства не повод показывать его снова.
  let afterLoadFired = false;
  function fireAfterLoad() {
    if (afterLoadFired) return;
    afterLoadFired = true;
    if (typeof afterLoad !== "function") return;
    try {
      afterLoad();
    } catch {}
  }

  // ─────────────── Хранилище ───────────────
  function loadState() {
    if (isElectron) {
      return Promise.all([api.getSettings(), api.loadChats()]).then(([s, c]) => {
        setSettings(normalize(s));
        setChatsData(sanitizeChats(c || { chats: [], activeId: null }));
        persistChats();
        fireAfterLoad();
      });
    }
    try {
      setSettings(normalize(JSON.parse(localStorage.getItem("settings") || "null")));
    } catch {}
    try {
      setChatsData(sanitizeChats(JSON.parse(localStorage.getItem("chats") || "null") || { chats: [], activeId: null }));
    } catch {}
    fireAfterLoad();
    return Promise.resolve();
  }

  // ─── Восстановление после аварийного закрытия ───
  // В сохранённой истории могли остаться незавершённые сообщения (pending).
  // Снимаем флаги, чтобы после перезапуска не висел вечный индикатор «выполняется»,
  // и один раз поясняем, что ответ был прерван.
  function sanitizeChats(d) {
    if (!d || !Array.isArray(d.chats)) return d || { chats: [], activeId: null };
    for (const c of d.chats) {
      if (!Array.isArray(c.messages)) c.messages = [];
      // План работ сохраняется вместе с чатом. Битые пункты (старый формат,
      // ручная правка файла) чистим тем же нормализатором, что и данные модели.
      // Защищается try/catch: sanitizeChats работает с файлом чатов при запуске и
      // не должен падать ни при каких данных (битый chats.json — не повод не стартовать).
      try {
        // Поле трогаем только если оно есть: чаты без плана не должны менять форму
        // (иначе каждый запуск перезаписывал бы весь файл истории).
        if (c.plan !== undefined) {
          const pi = c.plan && typeof c.plan === "object" && Array.isArray(c.plan.items) ? AgentCore.normalizePlanTasks(c.plan.items) : [];
          // legacy-планы со source "auto" отбрасываем — панель показывает только план модели.
          if (pi.length && c.plan.source !== "auto") c.plan = { title: String(c.plan.title || ""), source: c.plan.source === "text" ? "text" : "model", items: pi, updatedAt: Number(c.plan.updatedAt) || Date.now() };
          else c.plan = null;
        }
        if (Array.isArray(c.planHistory)) c.planHistory = c.planHistory.slice(0, getPlanArchiveLimit());
      } catch { c.plan = null; c.planHistory = []; }
      let interrupted = false;
      for (const m of c.messages) {
        if (!m.pending) continue;
        m.pending = false;
        interrupted = true;
        if (m.role === "tool") {
          if (!m.toolResult) {
            m.toolResult = "Действие не завершилось: приложение закрылось раньше.";
            m.toolOk = false;
          }
        } else if (!m.content) {
          m.content = "…";
        }
      }
      if (interrupted && c.id === d.activeId) {
        c.messages.push({
          id: "recovered-" + c.id + "-" + Date.now(),
          role: "system",
          content: "⚠️ Предыдущий ответ был прерван закрытием приложения. Сохранённая часть осталась в истории — можно продолжить с этого места.",
          interrupted: true,
          chatId: c.id,
          createdAt: Date.now(),
        });
      }
    }
    return d;
  }
  function persistSettings() {
    if (isElectron) api.setSettings(getSettings());
    else localStorage.setItem("settings", JSON.stringify(getSettings()));
  }
  function persistChats() {
    if (isElectron) api.saveChats(getChatsData());
    else localStorage.setItem("chats", JSON.stringify(getChatsData()));
  }
  // ─── Автосохранение во время длинного ответа ───
  let chatsSaveTimer = null;
  let chatsSavePending = false;
  const CHATS_SAVE_INTERVAL = 1500;
  function persistChatsSoon() {
    chatsSavePending = true;
    if (chatsSaveTimer) return;
    chatsSaveTimer = setTimeout(() => {
      chatsSaveTimer = null;
      if (!chatsSavePending) return;
      chatsSavePending = false;
      persistChats();
    }, CHATS_SAVE_INTERVAL);
  }
  function persistChatsNow() {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    chatsSavePending = false;
    persistChats();
  }
  function flushChats(sync) {
    if (chatsSaveTimer) { clearTimeout(chatsSaveTimer); chatsSaveTimer = null; }
    if (!chatsSavePending) return;
    chatsSavePending = false;
    if (isElectron) {
      // Синхронный канал доступен в Electron: успевает записать файл при закрытии окна.
      if (sync && typeof api.saveChatsSync === "function") {
        try { api.saveChatsSync(getChatsData()); return; } catch {}
      }
      api.saveChats(getChatsData());
    } else {
      localStorage.setItem("chats", JSON.stringify(getChatsData()));
    }
  }

  // Есть ли несохранённые правки. Спрашивает синхронизация истории: перезагрузка
  // файла с диска поверх несохранённых правок их потеряет.
  function getChatsSavePending() {
    return chatsSavePending;
  }

  // ─── Синхронизация истории между устройствами ───
  // История чатов лежит в одном файле, а клиентов несколько: окно на ПК и телефоны.
  // Когда сохраняет другой клиент, приходит событие chats:reload — раньше его не
  // было, и ответ, написанный с телефона, появлялся на ПК только после перезапуска.
  async function reloadChatsFromDisk() {
    if (!isElectron || typeof api.loadChats !== "function") return;
    // Свой прогон агента или несохранённые правки — перезагрузка их потеряет.
    if (getSession() || getChatsSavePending()) return;
    let c = null;
    try {
      c = await api.loadChats();
    } catch {
      return;
    }
    if (!c || !Array.isArray(c.chats)) return;
    setChatsData(sanitizeChats(c));
    setRemoteRunNotified(false);
    renderSidebar();
    renderMessages();
    try { getProjectPanel().refreshProject(); } catch {}
    toast("📱 История обновлена с другого устройства");
  }

  // Сброс на диск при закрытии/сворачивании окна — навешивается на прежнем месте куска.
  function wire() {
    window.addEventListener("beforeunload", () => flushChats(true));
    window.addEventListener("pagehide", () => flushChats(true));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushChats(true);
    });
  }

  return {
    loadState,
    sanitizeChats,
    persistSettings,
    persistChats,
    persistChatsSoon,
    persistChatsNow,
    flushChats,
    getChatsSavePending,
    reloadChatsFromDisk,
    wire,
  };
});

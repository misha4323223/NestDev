"use strict";

/* ─── Прогон агента и откат правок: каналы окна и телефона ───────────────────
   Вынесено из main.js (этап B, часть 34). Здесь шесть каналов, вокруг которых
   держится вся работа агента:

     • ai:send       — запуск прогона (runAi): источник запуска, роль, чат, миссия;
     • ai:answer     — ответ человека на вопрос инструмента askUser;
     • ai:stop       — мягкая остановка: флаг прогона + снятие ожидания ответа;
     • ai:test       — проверка подключения к провайдеру со списком моделей;
     • undo:status   — что можно откатить: чекпоинт последнего запуска;
     • undo:rollback — сам откат: файлы возвращаются на прежнее место (или
                       удаляются, если их создал агент).

   Почему это место нельзя переносить механически. Каналы держат ЖИВОЕ состояние
   оболочки, а не копии:

     • activeRunOrigin / activeRunRole / activeRunChatId — «кто запустил прогон,
       в какой роли и в каком чате». Их читают события окна (метка from),
       инструменты миссий (журнал) и сохранение чатов. Передай их копией —
       первый же запуск с телефона пометился бы как «с ПК», а события уехали бы
       не в тот чат;
     • runMissionId — миссия текущего прогона: сброс «с чистого листа» в начале
       прогона обязан быть виден инструментам, иначе они отмечали бы шаги в
       миссии прошлой работы;
     • activeRunUndo / lastUndoLog — снимки текущего запуска и журнал отката.
       Их пишет и разбор правок, и эти каналы; копия «застыла» бы на пустом
       массиве, и «Откатить» молча не нашёл бы ничего;
     • pendingAsk — ожидание ответа askUser: пишет прогон, снимает этот модуль;
     • activeAbort — прерывание текущего запроса к провайдеру;
     • mainWindow — окно приложения: события отката уходят в него, а оно
       создаётся позже сборки модуля и может быть закрыто.

   Всё перечисленное приходит мостом live (чтение и запись), помощники
   (loadSettings, normalizeSettings, fetchModels, runAi, persistUndo,
   loadPersistedUndo, undoFile) — значениями: это модули и чистые функции.

   Ошибка здесь тихая и дорогая: ai:send отвечает окну значением { ok:false }, и
   на него смотрит интерфейс. Потеряй канал эту ветку — прогон падал бы молча,
   окно считало бы, что всё идёт, а правки, сделанные до сбоя, не откатывались бы. */

function registerRunIpc(deps) {
  const {
    ipcMain,
    fs,
    loadSettings,
    normalizeSettings,
    fetchModels,
    runAi,
    persistUndo,
    loadPersistedUndo,
    undoFile,
    live,
    netGuard,
    ipcGuard,
  } = deps;

  // Окно спрашиваем в момент события: оно создаётся позже сборки модуля и может
  // быть уже закрыто. Копия «застыла» бы на null, и события отката не доходили бы
  // до окна вовсе.
  const aliveWindow = () => {
    const w = live.mainWindow;
    return w && !w.isDestroyed() ? w : null;
  };

ipcMain.handle("ai:send", async (e, messages, opts) => {
  // Разрушительный канал: сначала проверяем, кто позвал (см. src/ipc-guard.js).
  // Раньше здесь не было никакой проверки отправителя — хватало изоляции рендерера.
  const kind = ipcGuard.senderKind(e, live.mainWindow);
  const bad = ipcGuard.denyReason(e, { window: live.mainWindow, channel: "ai:send" });
  if (bad) return { ok: false, error: bad };
  const settings = loadSettings();
  // Кто запустил прогон — тот же ответ, что и у проверки: «с ПК» только живое окно,
  // всё остальное — телефон (мост) и внутренние вызовы. Раньше здесь стояла своя
  // копия проверки (e.sender.id) и расходилась с ней: событие из окна без id
  // считалось телефоном, и в журнал уходил неверный источник.
  live.activeRunOrigin = kind === "desktop" ? "desktop" : "mobile";
  live.activeRunRole = String((opts && opts.role) || "") || live.activeRunRole;
  live.activeRunChatId = String((opts && opts.chatId) || "");
  live.runMissionId = ""; // прогон начинается с чистого листа: миссию выберет missionRead
  global.__agentStopRequested = false;
  global.__agentRunning = true;
  try {
    await runAi(settings, messages || [], aliveWindow(), opts || {});
    return { ok: true };
  } catch (e) {
    const msg = e.name === "AbortError" ? "⏹ Генерация остановлена" : e.message || String(e);
    // Даже при ошибке изменения файлов, сделанные до неё, должны откатываться
    if (live.activeRunUndo.length) {
      live.lastUndoLog = live.activeRunUndo.slice();
      persistUndo();
      const w = aliveWindow();
      if (w) w.webContents.send("ai:event", { type: "undo_available", count: live.lastUndoLog.length });
    }
    const w = aliveWindow();
    if (w) w.webContents.send("ai:event", { type: "error", message: msg });
    return { ok: false, error: msg };
  } finally {
    global.__agentStopRequested = false;
    global.__agentPauseRequested = false;
    global.__agentRunning = false;
  }
});

// Ответ пользователя на вопрос агента (askUser)
ipcMain.handle("ai:answer", (_e, text) => {
  if (live.pendingAsk) {
    const r = live.pendingAsk;
    live.pendingAsk = null;
    r(text);
    return true;
  }
  return false;
});

// ─── Откат изменений агента (чекпоинт последнего запуска) ───
ipcMain.handle("undo:status", () => {
  loadPersistedUndo(); // чекпоинт мог остаться после перезапуска приложения
  return {
    ok: true,
    count: live.lastUndoLog.length,
    files: live.lastUndoLog.map((u) => u.path),
  };
});

ipcMain.handle("undo:rollback", (e) => {
  const bad = ipcGuard.denyReason(e, { window: live.mainWindow, channel: "undo:rollback" });
  if (bad) return { ok: false, error: bad };
  loadPersistedUndo();
  const restored = [];
  for (let i = live.lastUndoLog.length - 1; i >= 0; i--) {
    const u = live.lastUndoLog[i];
    try {
      if (u.content === null) {
        if (fs.existsSync(u.path)) fs.unlinkSync(u.path); // файл создан агентом — удаляем
      } else {
        fs.writeFileSync(u.path, u.content, "utf8"); // возвращаем прежнее содержимое
      }
      restored.push(u.path);
    } catch (e) {
      restored.push(u.path + " (ошибка: " + (e.message || String(e)) + ")");
    }
  }
  const count = restored.length;
  live.lastUndoLog = [];
  live.activeRunUndo = [];
  try { fs.unlinkSync(undoFile()); } catch {} // чекпоинт израсходован
  return { ok: true, count, restored };
});

ipcMain.handle("ai:stop", () => {
  global.__agentStopRequested = true;
  if (live.activeAbort) live.activeAbort.abort();
  if (live.pendingAsk) {
    const r = live.pendingAsk;
    live.pendingAsk = null;
    r("");
  }
  return true;
});

ipcMain.handle("ai:test", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  // Адрес приходит от интерфейса, а запрос делает ГЛАВНЫЙ процесс: без проверки
  // цели этот канал был маленьким SSRF — окно просило сходить на метаданные
  // облака и читало ответ. См. src/net-guard.js.
  const target = netGuard.checkSettingsUrls(s);
  if (!target.ok) return { ok: false, message: target.error, models: [] };
  try {
    const models = await fetchModels(s);
    return { ok: true, message: "Подключено! Найдено моделей: " + models.length, models };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});
}

module.exports = { registerRunIpc };

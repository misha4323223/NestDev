"use strict";

/* ─── Дела: зеркало, напоминания и точный будильник ──────────────────────────
   Вынесено из main.js (этап B, часть 24 — заход в «Выполнение инструментов»).

   Здесь живёт всё, что происходит между списком дел и человеком:

     • **зеркало списка в рабочей папке** (.agent/tasks.md) — человек видит дела
       файлом рядом с проектом, а не только в панели приложения;
     • **напоминания по сроку** — системное уведомление (Notification) плюс тост в
       ленте чата. Дело помечается напомненным: пристаём один раз и только после
       смены срока;
     • **точный будильник** (`armTaskWake`): таймер ровно на ближайший срок, а не
       только опрос раз в минуту — иначе дело «опаздывает» до минуты, а после сна
       или перевода часов не срабатывает вовсе.

   Ошибки здесь тихие и обидные: напоминание не пришло (агент «молчит», хотя дело
   просрочено), автозадача сгорела впустую (дело взяли, а доставить его некому) или
   уведомление через libnotify убило процесс в контейнере, где D-Bus недоступен.
   Поэтому «доставлять некому» = окна нет, и такие дела НЕ берутся: они дождутся
   возвращения окна.

   Окно приходит функцией (`getWindow`): оно создаётся позже сборки модуля и может
   быть закрыто — копия «застыла» бы на первом значении, и тосты уходили бы в
   закрытое окно. */

function createTasksReminders(deps) {
  const { app, Notification, agentStore, missionStore, loadSettings, agentWorkDir, getWindow } = deps;

// Хранилище приложения (дела, заметки): вне рабочей папки, поэтому в git не попадает.
function userDataDir() {
  return app.getPath("userData");
}

// Дела изменились (агент, панель в окне или телефон) — обновляем панель везде.
function emitTasksChanged() {
  try {
    const mainWindow = getWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("tasks:changed", { ts: Date.now() });
  } catch {}
  // Зеркало в рабочей папке (.agent/tasks.md): человек видит список дел файлом
  // рядом с проектом, а не только в панели приложения.
  try {
    const s = loadSettings();
    if (s.agentWorkFiles === false) return;
    const brief = agentStore.tasksBrief(userDataDir(), 40);
    const board = agentStore.tasksBoard(userDataDir());
    const sum = (board && board.summary) || {};
    missionStore.tasksMirror(
      agentWorkDir(s),
      "# Дела (зеркало списка приложения, обновлено " + new Date().toLocaleString() + ")\n\n" +
        "Активных: " + (sum.active || 0) + ", просрочено: " + (sum.overdue || 0) + ", сегодня: " + (sum.today || 0) + ", выполнено: " + (sum.done || 0) + "\n\n" +
        (brief || "Список пуст.")
    );
  } catch {}
}

// Напоминания о делах: раз в минуту смотрим, не подошёл ли срок. Уведомление Windows
// (Notification) + тост в ленте чата. Дело помечается напомненным — пристаём один раз,
// повторно только после смены срока. Отключается галочкой в настройках.
// Уведомление пользователю — только если канал уведомлений действительно есть.
// В контейнерах и headless-сборках уведомление через libnotify завершает процесс
// (D-Bus недоступен), а это фон: он обязан выживать.
function canNotify() {
  try {
    if (!Notification || !Notification.isSupported()) return false;
    if (process.platform === "linux") {
      const bus = String(process.env.DBUS_SESSION_BUS_ADDRESS || "");
      return /^(unix:path=|unix:abstract=)/.test(bus);
    }
    return true;
  } catch {
    return false;
  }
}

function notifyUser(title, body) {
  if (!canNotify()) return false;
  try {
    new Notification({ title: String(title || ""), body: String(body || "") }).show();
    return true;
  } catch {
    return false;
  }
}

// Точный будильник: таймер ровно на ближайший срок. Опрос раз в минуту остаётся
// страховкой (сон, перевод часов, смена дел), но к сроку приложение приходит вовремя.
let taskWakeTimer = null;
function armTaskWake() {
  if (taskWakeTimer) { clearTimeout(taskWakeTimer); taskWakeTimer = null; }
  let ms = 0;
  try { ms = agentStore.tasksNextDue(userDataDir()); } catch { ms = 0; }
  if (!ms) return;
  const delay = Math.max(1000, Math.min(ms + 250, 6 * 60 * 60 * 1000));
  taskWakeTimer = setTimeout(() => { taskWakeTimer = null; checkTaskReminders(); }, delay);
}

function checkTaskReminders() {
  let due = [];
  let auto = [];
  let failed = [];
  let remindOn = true;
  let autoOn = true;
  // Доставить дело некому (окна нет — свёрнуто в трей, закрыто): дела НЕ «берём»,
  // иначе автозадача сгорела бы впустую. Возьмём их, когда окно вернётся.
  const mainWindow = getWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const s = loadSettings();
    remindOn = s.taskReminders !== false;
    autoOn = s.taskAuto !== false;
    // Автозадачи выключены галочкой — дело не должно молчать совсем: напоминаем
    // тостом, как обычное (иначе «ставлю время, и не происходит ничего»).
    if (remindOn) due = agentStore.tasksTakeReminders(userDataDir(), undefined, { includeAuto: !autoOn }).tasks;
    // Автозадачи — это работа агента, а не тост: галочка напоминаний их не глушит.
    if (autoOn) {
      const take = agentStore.tasksTakeAuto(userDataDir());
      auto = take.tasks;
      failed = take.failed || [];
    }
  } catch {
    return;
  }
  const now = Date.now();
  for (const t of due) {
    const at = new Date(t.due).getTime();
    const late = at < now;
    notifyUser((late ? "⚠ Дело просрочено: " : "⏰ Дело: ") + t.title, agentStore.humanDue(t, now));
  }
  // Автозадача не подтвердилась после всех попыток: молчать нельзя — человек ждал,
  // что агент сработает сам.
  for (const t of failed) {
    notifyUser("⚠ Автозадача не запустилась: " + t.title, t.error || "прогон не подтвердился");
  }
  if (due.length || auto.length || failed.length) emitTasksChanged();
  try {
    if (due.length) {
      mainWindow.webContents.send("ai:event", {
        type: "task-reminder",
        tasks: due.map((t) => ({ id: t.id, title: t.title, due: t.due, late: new Date(t.due).getTime() < now })),
      });
    }
    if (auto.length) {
      // from: "desktop" — событие уходит и на телефон, но запускать автозадачу
      // должен только ПК-клиент: у чатов один хозяин, иначе прогон удвоится.
      mainWindow.webContents.send("ai:event", { type: "task-due", from: "desktop", tasks: auto });
    }
    // Автозадача не пошла: окно говорит об этом человеку тостом в ленте.
    if (failed.length) {
      mainWindow.webContents.send("ai:event", { type: "task-auto-failed", tasks: failed });
    }
  } catch {}
  armTaskWake();
}

  return { userDataDir, emitTasksChanged, canNotify, notifyUser, armTaskWake, checkTaskReminders };
}

module.exports = { createTasksReminders };

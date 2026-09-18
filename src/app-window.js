"use strict";

/* ─── Окно приложения ───────────────────────────────────────────────────────
   Вынесено из main.js (этап B, часть 13). Здесь собирается главное окно и
   навешивается то, что легко сделать «на вид работает»:

     • прокси webContents.send — события уходят И в окно, И в мобильный мост,
       иначе телефон не увидит ответ агента, запущенного с ПК (и наоборот);
     • метка from у ai:event — чей это прогон: клиентов несколько, у событий нет
       привязки к переписке, и без метки ответ с телефона подмешивался бы в
       открытый чат на ПК;
     • ссылки из чата открываются в браузере пользователя, а не в новом окне
       Electron (иначе вместо страницы человек видит пустую рамку);
     • напоминания о делах — окно может быть свёрнуто, таймер живёт с приложением;
     • закрытие окна обязано обнулить его у оболочки: иначе таймеры и отправители
       будут писать в мёртвый объект.

   Живые значения приходят мостами: окно создаётся позже сборки модуля и
   закрывается (`setWindow`), а метку запуска пишет прогон агента (`getRunOrigin`). */

function createAppWindow(deps) {
  const { app, path, shell, mobileBridge, BrowserWindow, checkTaskReminders, getRunOrigin, setWindow, appDir } = deps;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "AI Developer Agent",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(appDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setWindow(win);
  // Напоминания о делах: проверяем раз в минуту (плюс сразу после старта, если что-то
  // уже просрочено). Таймер живёт вместе с приложением, окно может быть свёрнуто.
  // Интервал можно укоротить для живого теста: AI_AGENT_TASK_REMINDER_MS.
  const taskReminderEvery = Math.max(2000, Number(process.env.AI_AGENT_TASK_REMINDER_MS) || 60000);
  setTimeout(checkTaskReminders, Math.min(8000, taskReminderEvery));
  setInterval(checkTaskReminders, taskReminderEvery);

  // Прокси webContents.send: все события (ai:event, term:event, dev:event, github:event)
  // дополнительно транслируются клиентам мобильного моста по WebSocket.
  // Windows: без AppUserModelID уведомления приходят «от Electron» (или не приходят).
  if (process.platform === "win32") {
    try { app.setAppUserModelId("AI Developer Agent"); } catch {}
  }

  const _wcSend = win.webContents.send.bind(win.webContents);
  win.webContents.send = (ch, ev) => {
    // Клиентов теперь несколько (окно на ПК + телефоны), и прогон агента может
    // быть чужим. У событий нет привязки к переписке, поэтому помечаем их тем,
    // кто запустил прогон: иначе ответ с телефона подмешивался бы в открытый чат
    // на ПК, а плашки «сжатие контекста» и превью всплывали бы не там.
    if (ch === "ai:event" && ev && typeof ev === "object" && ev.from === undefined) {
      ev = { ...ev, from: getRunOrigin() };
    }
    try {
      mobileBridge.broadcast(ch, ev);
    } catch {}
    return _wcSend(ch, ev);
  };
  win.loadFile(path.join(appDir, "renderer", "index.html"));
  // Кликабельные ссылки из чата: http(s) открываются в браузере пользователя,
  // а не в новом окне Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
  win.on("closed", () => {
    setWindow(null);
  });
}
  return { createWindow };
}

module.exports = { createAppWindow };

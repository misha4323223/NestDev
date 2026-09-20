"use strict";

/* ─── Самообновление приложения: каналы OTA и electron-updater ────────────────
   Вынесено из main.js (этап B, часть 32). Здесь ДВА разных обновления, и их легко
   перепутать:

     • OTA (src/ota.js) — свой, локальный: агент собирает бандл в папку рядом с
       кодом, приложение подхватывает его и перезапускается. Каналы ota:* зовут и
       окно на ПК, и телефон (инструменты агента тоже).
     • electron-updater — штатный апдейтер сборки (NSIS/ZIP): он не отдаёт данные
       окну, а показывает прогресс в заголовке и уведомлением, поэтому проверка
       идёт по таймеру и молчит, когда обновлений нет.

   Почему ошибка здесь тихая и дорогая: ota:check сообщает об отказе ОБЫЧНЫМ
   значением. Если отказ не превратить в {status:"error"}, окно покажет «обновлений
   нет», человек решит, что код актуален, — а на самом деле проверка упала. Так же
   молча ничего не произойдёт, если ota:* потеряет настройки: с ними приходит
   выключатель self-update, и без них ota.check пошёл бы работать при выключенном
   обновлении.

   Живое значение одно — окно приложения: оно создаётся позже сборки модуля и может
   быть уже закрыто, поэтому приходит ФУНКЦИЕЙ (getWindow), а не значением. Копия
   «застыла» бы на null, и прогресс загрузки перестал бы показываться. */

function registerOtaIpc(deps) {
  const { ipcMain, ota, loadSettings } = deps;

// Локальный self-update (OTA): статус, проверка, откат, открыть папку
ipcMain.handle("ota:status", () => ota.status(loadSettings()));
ipcMain.handle("ota:check", async () => {
  try {
    return await ota.check(loadSettings());
  } catch (e) {
    return { status: "error", message: e.message || String(e) };
  }
});
ipcMain.handle("ota:rollback", () => ota.rollback());
ipcMain.handle("ota:openDir", () => ota.openDir());
ipcMain.handle("ota:reset", (_e, removeSource) => ota.reset(!!removeSource, loadSettings()));
}

/* Штатный апдейтер сборки. Проверка идёт по таймеру: показать обновление окну
   нельзя (это отдельный механизм), поэтому видно только заголовок окна и
   системное уведомление. Ошибки уходят в консоль и снимают надпись с заголовка —
   иначе окно навсегда осталось бы с «доступно обновление» на пустом месте. */
function initAutoUpdater(deps) {
  const { autoUpdater, Notification, getWindow } = deps;
  // Окно спрашиваем в момент события: оно могло быть закрыто или пересоздано.
  const aliveWindow = () => {
    const w = getWindow ? getWindow() : null;
    return w && !w.isDestroyed() ? w : null;
  };

  autoUpdater.autoDownload = false;           // спросим пользователя перед загрузкой
  autoUpdater.autoInstallOnAppQuit = true;    // установить при закрытии, если уже скачан

  autoUpdater.on("checking-for-update", () => {
    const w = aliveWindow();
    if (w) w.setTitle("AI Developer Agent — проверка обновлений…");
  });
  autoUpdater.on("update-available", (info) => {
    const w = aliveWindow();
    if (w) {
      w.setTitle("AI Developer Agent — доступно обновление");
      w.webContents.send("ai:event", { type: "update:available", info });
    }
    // Спрашиваем: скачать?
    new Notification({
      title: "AI Developer Agent",
      body: `Доступна версия ${info.version}. Скачать и установить?`,
    }).show();
    autoUpdater.downloadUpdate().catch((e) => console.error("[updater] download error", e));
  });
  autoUpdater.on("update-not-available", () => {
    const w = aliveWindow();
    if (w) w.setTitle("AI Developer Agent");
  });
  autoUpdater.on("download-progress", (p) => {
    const pct = Math.round(p.percent);
    const w = aliveWindow();
    if (w) w.setTitle(`AI Developer Agent — загрузка ${pct}%`);
  });
  autoUpdater.on("update-downloaded", () => {
    const w = aliveWindow();
    if (w) {
      w.setTitle("AI Developer Agent — обновление готово");
      w.webContents.send("ai:event", { type: "update:downloaded" });
    }
    new Notification({
      title: "AI Developer Agent",
      body: "Обновление скачано. Применится при следующем перезапуске.",
    }).show();
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater]", e.message);
    const w = aliveWindow();
    if (w) w.setTitle("AI Developer Agent");
  });

  // Проверка раз в час
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

module.exports = { registerOtaIpc, initAutoUpdater };

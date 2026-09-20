"use strict";

/* ─── Браузер агента: применение настроек и каналы интерфейса ─────────────────
   Сам браузер (Playwright, постоянный профиль, карта страницы, подключение к
   своему Chrome по CDP) живёт в src/browser-tools.js. Здесь — то, что раньше
   стояло в main.js: единая точка применения браузерных настроек и четыре канала,
   которыми пользуются окно и телефон (src/preload.js, src/renderer/mobile-api.js).

   Почему это отдельный модуль, а не строчки в оболочке: папка профиля лежит в
   userData приложения, а режим «свой Chrome» знает порт отладки — интерфейс не
   должен угадывать ни то, ни другое, а хранилище настроек обязано применять
   профиль ровно в одном месте (иначе настройка «профиль выключен» терялась бы
   при следующем сохранении настроек).

   loadSettings приходит мостом live, а не значением: хранилище настроек
   (src/settings-store.js) собирается НИЖЕ этого модуля и берёт у него
   applyBrowserSettings — прямая передача функции упала бы на «cannot access
   before initialization» и оборвала загрузку всего бэкенда. Каналы читают
   настройки в момент вызова, как и раньше, поэтому мосту достаточно чтения. */

function registerBrowserIpc(deps) {
  const { ipcMain, app, fs, path, browserTools, live } = deps;
  // Чтение настроек в момент вызова: хранилище строится ниже по main.js.
  const loadSettings = () => live.loadSettings();

// ─────────────────────────── Браузер агента (постоянный профиль) ───────────────────────────
// Сессии ВК и других сайтов хранятся в userData/browser-profile — вход переживает перезапуск.
// Единая точка применения браузерных настроек: своя папка профиля и режим «свой Chrome» (CDP).
function applyBrowserSettings(s) {
  const dir = path.join(app.getPath("userData"), "browser-profile");
  try {
    browserTools.setProfileDir(s && s.browserProfile === false ? "" : dir);
    browserTools.setConnectMode({
      enabled: !!(s && s.browserConnect === true),
      port: s && s.browserConnectPort,
      dataDir: dir,
    });
  } catch {}
}

ipcMain.handle("browser:profileInfo", () => {
  const s = loadSettings();
  const dir = browserTools.profilePath();
  let exists = false;
  try { exists = !!(dir && fs.existsSync(dir)); } catch {}
  return { enabled: s.browserProfile !== false, dir: dir || "", exists };
});
ipcMain.handle("browser:clearProfile", async () => {
  const message = await browserTools.clearProfile();
  return { ok: !/^Не удалось/.test(message), message };
});
// Подключение к своему Chrome по CDP (кнопка в Настройках и инструмент агента).
ipcMain.handle("browser:connect", async (_e, opts) => {
  const message = await browserTools.connect(opts || {});
  return { ok: !/^Ошибка/.test(message), message, info: browserTools.connectInfo() };
});
ipcMain.handle("browser:connectInfo", () => browserTools.connectInfo());

  // Возвращаем применение настроек: его зовёт хранилище настроек (settings-store.js),
  // которое собирается ниже по main.js.
  return { applyBrowserSettings };
}

module.exports = { registerBrowserIpc };

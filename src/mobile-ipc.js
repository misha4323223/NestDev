"use strict";

/* ─── Мобильный доступ к приложению: каналы статуса и PIN ─────────────────────
   Раньше стояли в main.js (этап B, часть 30): два канала панели «Мобильный
   доступ» — mobile:status и mobile:pinRegen. Сам мост (LAN + PWA + WebSocket,
   дублирующий IPC на телефон) живёт в src/mobile-bridge.js, здесь только то, что
   зовёт из него окно и телефон.

   Почему PIN меняется именно так. Новый PIN не просто пишется в настройки: его
   надо ещё и применить к живому мосту (applySettings) — иначе телефон остался бы
   подключён по старому PIN, а окно показывало бы новый, и «сменить PIN» молча
   ничего не меняло. Поэтому порядок здесь: прочитать свежие настройки, поставить
   случайный PIN, сохранить и применить — и вернуть мосту его же статус, чтобы
   окно показало то, что действительно работает. На эту связку есть проверки
   (test/mobile-ipc.test.js) и живой прогон (scripts/live-settings-ipc.js). */

function registerMobileIpc(deps) {
  const { ipcMain, mobileBridge, loadSettings, saveSettings } = deps;

ipcMain.handle("mobile:status", () => mobileBridge.status());
ipcMain.handle("mobile:pinRegen", () => {
  const s = loadSettings();
  s.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  saveSettings(s);
  mobileBridge.applySettings(s);
  return mobileBridge.status();
});
}

module.exports = { registerMobileIpc };

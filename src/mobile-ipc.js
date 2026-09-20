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
   (test/mobile-ipc.test.js) и живой прогон (scripts/live-settings-ipc.js).

   Здесь же решается, ЧТО видно клиенту. Статус моста содержит PIN и токен пары —
   то есть ровно те секреты, по которым телефон подключается. Окну на ПК они
   нужны: в нём рисуется QR-код. Телефону — нет: он за этими секретами и пришёл
   бы. Поэтому телефон получает статус без них (mobileBridge.status({ client:true })),
   а кто позвал — решает общая проверка отправителя (src/ipc-guard.js). */

function registerMobileIpc(deps) {
  const { ipcMain, mobileBridge, loadSettings, saveSettings, ipcGuard, getWindow } = deps;

// Пустой статус для отказа: панель телефона не должна падать на «undefined».
const emptyStatus = (error) => ({ enabled: false, running: false, port: 0, ips: [], urls: [], error });
// Кто позвал: телефону — статус без секретов моста.
const forClient = (e) => ipcGuard.senderKind(e, getWindow ? getWindow() : null) === "mobile";
const denied = (e, channel) => ipcGuard.denyReason(e, { window: getWindow ? getWindow() : null, channel });

ipcMain.handle("mobile:status", (e) => {
  const bad = denied(e, "mobile:status");
  if (bad) return emptyStatus(bad);
  return mobileBridge.status({ client: forClient(e) });
});
ipcMain.handle("mobile:pinRegen", (e) => {
  const bad = denied(e, "mobile:pinRegen");
  if (bad) return emptyStatus(bad);
  const s = loadSettings();
  s.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  saveSettings(s);
  mobileBridge.applySettings(s);
  // «Сменить PIN» — это ещё и «выкинуть подключённые телефоны»: новый токен пары
  // и сброс сеансов. Иначе старый сеанс (и скриншот старого QR-кода) продолжали
  // бы пускать в приложение, хотя человек только что сменил вход.
  mobileBridge.rotate();
  return mobileBridge.status({ client: forClient(e) });
});
}

module.exports = { registerMobileIpc };

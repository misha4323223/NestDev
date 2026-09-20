"use strict";

/* ─── История чатов: каналы окна и сигнал «перечитай файл» ────────────────────
   История чатов лежит ОДНИМ файлом на всех клиентов (окно на ПК + телефоны),
   а хранилище (с резервной копией и атомарной записью) живёт в
   src/settings-store.js. Здесь — то, что раньше стояло в main.js: три канала
   (chats:load, chats:save, chats:saveSync) и рассылка chats:reload.

   Зачем сигнал вообще нужен: когда историю сохранял телефон, окно на ПК
   продолжало показывать свою копию — ответ, написанный с телефона, появлялся на
   ПК только после перезапуска окна. Поэтому остальные клиенты получают
   «перечитай файл», а тому, кто сохранил, сигнал не шлём (иначе окно перечитало
   бы файл прямо во время набора). Клиент мобильного моста приходит с фиктивным
   sender (id = 0) — это и есть «не ПК».

   Окно приходит функцией (getWindow), а не значением: оно создаётся позже
   сборки этого модуля и может быть пересоздано, поэтому копия на момент сборки
   «застыла» бы на null и сигнал молча перестал бы уходить. */

function registerChatsIpc(deps) {
  const { ipcMain, loadChats, saveChats, getWindow } = deps;

ipcMain.handle("chats:load", () => loadChats());
ipcMain.handle("chats:save", (e, d) => {
  saveChats(d);
  notifyChatsSaved(e);
  return true;
});

// История чатов — ОДИН файл на всех клиентов (окно на ПК + телефоны). Раньше, когда
// историю сохранял телефон, окно на ПК продолжало показывать свою копию: ответ,
// написанный с телефона, появлялся на ПК только после перезапуска окна.
// Просим остальные клиенты перечитать файл; тому, кто сохранил, сигнал не шлём.
// Клиент мобильного моста приходит с фиктивным sender (id = 0) — это и есть «не ПК».
function notifyChatsSaved(e) {
  try {
    const mainWindow = getWindow ? getWindow() : null;
    const senderId = e && e.sender && typeof e.sender.id === "number" ? e.sender.id : 0;
    if (senderId && mainWindow && senderId === mainWindow.webContents.id) return;
    if (mainWindow) mainWindow.webContents.send("chats:reload", { at: Date.now() });
  } catch {}
}

// Синхронное сохранение при закрытии окна: renderer успевает записать данные на диск.
ipcMain.on("chats:saveSync", (e, d) => {
  try { saveChats(d); } catch {}
  e.returnValue = true;
});
}

module.exports = { registerChatsIpc };

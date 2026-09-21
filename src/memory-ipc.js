"use strict";

/* ─── Память диалогов: каналы дневника сжатых памяток ─────────────────────────
   Сам дневник (папка по датам, чтение и удаление памяток, срок хранения) живёт в
   src/agent-store.js. Здесь — четыре канала панели памяти, которые раньше стояли
   в main.js вперемешку с почтой и деплоем.

   Папка дневника лежит в userData приложения, поэтому путь считает бэкенд, а не
   интерфейс: окну возвращается готовый каталог (memory:days, memory:openDir), и
   оно не угадывает, ни где лежат памятки, ни включена ли память в настройках.
   Настройки читаются в момент вызова, поэтому смена срока хранения и выключателя
   действует сразу, без перезапуска. */

function registerMemoryIpc(deps) {
  // missionStore и agentWorkDir нужны записи памятки при сжатии контекста: зеркало
  // кладётся рядом с проектом (.agent/context), а дневник — в папку приложения.
  const { ipcMain, app, fs, shell, agentStore, loadSettings, missionStore, agentWorkDir } = deps;
  // Папка приложения спрашивается в момент записи: другой модуль (или другой канал)
  // не должен видеть застывший путь.
  const userDataDir = () => app.getPath("userData");

// ── 🧠 Память диалогов: локальный дневник сжатых памяток (папка по датам) ──────
ipcMain.handle("memory:stats", () => {
  const s = loadSettings();
  const st = agentStore.contextMemoryStats(app.getPath("userData"));
  return {
    ...st,
    enabled: !!s.contextMemory,
    keepDays: Number(s.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
  };
});

ipcMain.handle("memory:days", () => {
  const s = loadSettings();
  if (!s.contextMemory) return { ok: false, error: "Память диалогов выключена." };
  const days = agentStore.contextMemoryDays(app.getPath("userData"));
  return { ok: true, days, dir: agentStore.contextMemoryDir(app.getPath("userData")) };
});

ipcMain.handle("memory:openDir", async () => {
  const dir = agentStore.contextMemoryDir(app.getPath("userData"));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const err = await shell.openPath(dir);
  return { ok: !err, dir, error: err || "" };
});

ipcMain.handle("memory:clear", (_e, date) => {
  const d = String(date || "").trim();
  const r = agentStore.contextMemoryClear(app.getPath("userData"), d);
  return {
    ...r,
    message: r.ok
      ? "Удалено дней: " + r.removedDays + ", памяток: " + r.removedMemos + "."
      : "Ошибка: " + r.error,
  };
});

// Память диалогов: сохраняем сжатую памятку в локальный дневник по датам, но
// ТОЛЬКО если пользователь включил галочку «Память диалогов» (иначе — тишина).
// Отдельно от дневника памяти работает зеркало рядом с проектом
// (.agent/context/<дата>.md): долгая работа обязана оставлять следы файлами на ПК,
// даже когда галочка «Память диалогов» выключена — поэтому зеркало решает своё
// условие («файлы работы агента»), а не эту галочку.
function saveContextMemo(settings, entry, emit) {
  if (!settings || !entry || !String(entry.text || "").trim()) return null;
  if (settings.agentWorkFiles !== false) {
    try {
      missionStore.contextMirror(agentWorkDir(settings), entry.ts, entry.text);
    } catch {}
  }
  if (!settings.contextMemory) return null;
  try {
    const r = agentStore.contextMemorySave(userDataDir(), {
      ts: entry.ts,
      memo: entry.text,
      messages: entry.messages,
      provider: entry.provider,
      model: entry.model,
      workDir: agentWorkDir(settings),
      keepDays: Number(settings.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
    });
    if (r && r.ok && emit) {
      emit({
        type: "memory",
        text: "🧠 Память диалогов: сохранена памятка за " + r.day + " (памяток за день: " + r.count + "). Спросить прошлые сессии — memoryList / memorySearch.",
      });
    }
    return r;
  } catch {
    return null;
  }
}

  return { saveContextMemo: saveContextMemo };
}

module.exports = { registerMemoryIpc };

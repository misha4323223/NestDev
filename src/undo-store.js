"use strict";

/* ─── Снимки отката и чекпоинт правок агента ──────────────────────────────────
   Вынесено из main.js (этап B, часть 8). Здесь память о правках агента:

     • snapshotFileForUndo — снимок файла ПЕРЕД правкой (содержимое или null, если
       файла ещё не было — тогда откат означает «удалить»). На файл хранится не
       больше UNDO_MAX_PER_FILE последних снимков: старые вытесняются, иначе долгий
       прогон съел бы память копиями одного и того же файла;
     • persistUndo / loadPersistedUndo — тот же журнал на диске (undo.json), чтобы
       «Отменить изменения агента» пережило перезапуск приложения.

   Живых значений два, поэтому они идут мостом live:
     • activeRunUndo — снимки текущего запуска: их пишет правка файла, читает откат
       и панель проекта, а обнуляет начало нового запуска;
     • lastUndoLog — журнал последнего запуска: его берут кнопка отката и канал
       undoStatus.
   Путь к чекпоинту берётся у окна Electron функцией userDataDir(), а не значением:
   папка приложения известна только после запуска. */

function createUndoStore(deps) {
  const { fs, path, userDataDir } = deps;

  // Мост живых значений: см. шапку модуля.
  const live = {
    get activeRunUndo() {
      return deps.live.activeRunUndo();
    },
    set activeRunUndo(v) {
      deps.live.setActiveRunUndo(v);
    },
    get lastUndoLog() {
      return deps.live.lastUndoLog();
    },
    set lastUndoLog(v) {
      deps.live.setLastUndoLog(v);
    },
  };

// Снимок файла для «отката изменений агента». Снимок делается ПЕРЕД каждой правкой,
// поэтому undoEdit(path, steps) умеет откатывать на несколько шагов назад.
// На файл хранится не более UNDO_MAX_PER_FILE последних снимков (старые вытесняются).
// content === null означает, что файл был создан агентом (откат = удалить).
const UNDO_MAX_PER_FILE = 5;
function snapshotFileForUndo(p) {
  try {
    let content;
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 10 * 1024 * 1024) return; // очень большие файлы не копируем
      content = fs.readFileSync(p, "utf8");
    } else {
      content = null; // создан агентом
    }
    live.activeRunUndo.push({ path: p, content, ts: Date.now() });
    // вытесняем самые старые снимки этого файла, оставляя UNDO_MAX_PER_FILE
    let total = 0;
    for (const u of live.activeRunUndo) if (u.path === p) total++;
    let drop = total - UNDO_MAX_PER_FILE;
    if (drop > 0) {
      const kept = [];
      for (let i = 0; i < live.activeRunUndo.length; i++) {
        const u = live.activeRunUndo[i];
        if (u.path === p && drop > 0) { drop--; continue; }
        kept.push(u);
      }
      live.activeRunUndo = kept;
    }
  } catch {}
}

// ── Чекпоинт: снимок изменений последнего запуска сохраняется на диск, ──
// ── чтобы откат пережил перезапуск приложения. ──
const undoFile = () => path.join(userDataDir(), "undo.json");

function persistUndo() {
  try {
    fs.mkdirSync(path.dirname(undoFile()), { recursive: true });
    fs.writeFileSync(undoFile(), JSON.stringify(live.lastUndoLog), "utf8");
  } catch {}
}

function loadPersistedUndo() {
  if (live.lastUndoLog.length) return;
  try {
    const d = JSON.parse(fs.readFileSync(undoFile(), "utf8"));
    if (Array.isArray(d)) live.lastUndoLog = d;
  } catch {}
}
  return { snapshotFileForUndo, persistUndo, loadPersistedUndo, undoFile };
}

module.exports = { createUndoStore };

"use strict";

/* ─── Дела, миссии и файлы работы агента: каналы окна ────────────────────────
   Вынесено из main.js (этап B, часть 1). Здесь только обвязка вокруг хранилищ:
   дела и их сроки — agent-store.js, миссии и зеркала работы — mission-store.js;
   раскладка данных на диске остаётся в хранилищах.

   Каналы: tasks:board, tasks:list/add/update/done/delete/auto-ack/auto-rearm,
   mission:state/pause/stop/resume/finish/delete/open/list,
   agentfiles:status/openDir/clear.

   Живое значение одно: missionClaim — id миссии, которую человек вернул в работу
   кнопкой «▶ Продолжить». Его переписывает и этот модуль, и прогон агента (отбор
   миссии в runAi), поэтому оно передано мостом live с чтением и записью: копия
   «застыла» бы на пустой строке, и продолженная миссия снова не подхватывалась. */

function registerMissionIpc(deps) {
  const {
    ipcMain,
    fs,
    shell,
    agentStore,
    missionStore,
    loadSettings,
    agentWorkDir,
    userDataDir,
    emitTasksChanged,
    armTaskWake,
  } = deps;

  // Мост живых значений: missionClaim меняется и здесь, и в прогоне агента.
  const live = {
    get missionClaim() {
      return deps.live.missionClaim();
    },
    set missionClaim(v) {
      deps.live.setMissionClaim(v);
    },
  };

ipcMain.handle("tasks:board", () => agentStore.tasksBoard(userDataDir()));

// ── Миссии (долгая работа агента) ──────────────────────────────────────────
// Панель «Миссия» показывает цель, шаги, журнал и метрики; кнопки ставят работу
// на паузу, продолжают её и открывают папку миссии в проводнике.
function missionStateForUi(settings) {
  const s = settings || loadSettings();
  const dir = agentWorkDir(s);
  const enabled = !!s.longWork;
  let active = null;
  let list = [];
  try {
    if (enabled) {
      active = missionStore.missionActive(dir);
      list = missionStore.missionList(dir, { limit: 10 });
    }
  } catch {}
  return {
    enabled: enabled,
    dir: dir,
    folder: missionStore.agentRoot(dir),
    active: active,
    progress: active ? missionStore.missionProgress(active) : null,
    journal: active ? missionStore.missionJournal(dir, active.id, { limit: 40 }) : [],
    list: list.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      steps: m.steps.length,
      rounds: m.rounds,
      tokens: m.metrics.tokens,
      role: m.role,
      chatId: m.chatId,
      reason: m.reason || "",
      progress: missionStore.missionProgress(m),
    })),
    running: !!global.__agentRunning,
    paused: !!global.__agentPauseRequested,
  };
}
ipcMain.handle("mission:state", () => missionStateForUi());
ipcMain.handle("mission:pause", () => {
  // Пауза — не остановка: работа сохраняется, миссия остаётся незакрытой.
  if (global.__agentRunning) global.__agentPauseRequested = true;
  return { ok: true, running: !!global.__agentRunning };
});
ipcMain.handle("mission:stop", () => {
  global.__agentStopRequested = true;
  global.__agentPauseRequested = false;
  return { ok: true };
});
ipcMain.handle("mission:resume", () => {
  const s = loadSettings();
  const dir = agentWorkDir(s);
  let rec = null;
  try {
    rec = missionStore.missionActive(dir);
  } catch {}
  if (!rec) return { ok: false, error: "Незакрытых миссий нет." };
  // Человек нажал «▶ Продолжить» — это единственный путь для миссии с паузы:
  // сама пауза не подхватывается (иначе прогон бесконечно «продолжал» бы сданную
  // работу). Возвращаем миссию в работу и запоминаем просьбу: следующий прогон
  // возьмёт именно её — пауза без этой просьбы не подхватывается.
  try {
    rec.status = "active";
    rec.finishedAt = 0;
    rec.reason = "";
    missionStore.missionSave(dir, rec);
    missionStore.missionNote(dir, rec.id, "note", "▶ Человек вернул миссию в работу (кнопка «Продолжить»).");
  } catch {}
  live.missionClaim = rec.id;
  return {
    ok: true,
    id: rec.id,
    chatId: rec.chatId || "",
    text: missionStore.missionResumeText(rec, missionStore.missionJournalText(dir, rec.id, { limit: 12 })),
  };
});
// Закрытие миссии человеком. Раньше незакрытую миссию можно было только
// продолжить или увести в паузу — работы без конца висели в панели, и агент
// снова и снова «продолжал» их. Теперь человек закрывает её одним нажатием.
ipcMain.handle("mission:finish", (_e, id) => {
  const s = loadSettings();
  const dir = agentWorkDir(s);
  let rec = null;
  try {
    rec = String(id || "").trim() ? missionStore.missionLoad(dir, String(id).trim()) : missionStore.missionActive(dir);
  } catch {}
  if (!rec) return { ok: false, error: "Незакрытых миссий нет." };
  if (rec.status === "done" || rec.status === "failed" || rec.status === "stopped") {
    return { ok: true, id: rec.id, status: rec.status, already: true };
  }
  let r = null;
  try {
    r = missionStore.missionFinish(dir, rec.id, { status: "stopped", reason: "закрыто человеком", next: rec.next });
    missionStore.missionNote(dir, rec.id, "note", "🏁 Миссию закрыл человек — работа считается законченной.");
  } catch {}
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "Не удалось закрыть миссию." };
  if (live.missionClaim === rec.id) live.missionClaim = "";
  return { ok: true, id: rec.id, status: r.mission.status };
});
// Удаление миссии человеком: папка миссии (журнал, отчёт, план) уходит целиком.
// Во время прогона по этой же миссии не удаляем: агент держит её в памяти и продолжит
// писать — сначала «⏹ Стоп» или «🏁 Закрыть». Закрытые и прошлые миссии удаляются свободно.
ipcMain.handle("mission:delete", (_e, id) => {
  const dir = agentWorkDir(loadSettings());
  const wanted = String(id || "").trim() || live.missionClaim;
  if (!wanted) return { ok: false, error: "Не понял, какую миссию удалять." };
  if (live.missionClaim === wanted && global.__agentRunning) {
    return { ok: false, error: "Идёт прогон по этой миссии — сначала «⏹ Стоп» или «🏁 Закрыть»." };
  }
  const r = missionStore.missionDelete(dir, wanted);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "Не удалось удалить миссию." };
  if (live.missionClaim === wanted) live.missionClaim = "";
  return { ok: true, id: r.id };
});
ipcMain.handle("mission:open", (_e, id) => {
  const dir = agentWorkDir(loadSettings());
  const target = id ? missionStore.missionDirOf(dir, id) : missionStore.agentRoot(dir);
  try {
    shell.showItemInFolder(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle("mission:list", () => missionStateForUi());

// ── 🗂 Файлы работы агента рядом с проектом (.agent/) ──────────────────────
// Задачи и контекст агент ведёт сам: список дел — в .agent/tasks.md, памятки
// контекста — в .agent/context/<дата>.md, миссии — в .agent/missions/<id>/. Здесь
// только состояние папки для настроек и две кнопки: открыть и очистить зеркала.
function agentFilesStatus() {
  const s = loadSettings();
  const dir = agentWorkDir(s);
  let st = { dir: dir, root: missionStore.agentRoot(dir), exists: false, tasks: null, contextDays: [], missions: 0, bytes: 0 };
  try {
    st = missionStore.mirrorStatus(dir);
  } catch {}
  return {
    enabled: s.agentWorkFiles !== false,
    longWork: !!s.longWork,
    memory: !!s.contextMemory,
    dir: st.dir,
    folder: st.root,
    exists: !!st.exists,
    tasks: st.tasks ? { bytes: st.tasks.bytes, mtime: st.tasks.mtime } : null,
    contextDays: st.contextDays || [],
    missions: st.missions || 0,
    bytes: st.bytes || 0,
  };
}
ipcMain.handle("agentfiles:status", () => agentFilesStatus());

ipcMain.handle("agentfiles:openDir", async (_e, id) => {
  const s = loadSettings();
  const dir = agentWorkDir(s);
  const target = id ? missionStore.missionDirOf(dir, id) : missionStore.agentRoot(dir);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch {}
  const err = await shell.openPath(target);
  return { ok: !err, path: target, error: err || "" };
});

ipcMain.handle("agentfiles:clear", () => {
  const s = loadSettings();
  const r = missionStore.mirrorClear(agentWorkDir(s));
  return {
    ...r,
    message: r.ok
      ? r.removed.length ? "Зеркала очищены: " + r.removed.join(", ") + ". Миссии не затронуты." : "Зеркал не было — чистить нечего."
      : "Ошибка: " + r.error,
  };
});
ipcMain.handle("tasks:list", (_e, opts) => agentStore.tasksList(userDataDir(), opts || {}));
ipcMain.handle("tasks:add", (_e, input) => {
  const r = agentStore.tasksAdd(userDataDir(), input || {});
  if (r.ok) {
    emitTasksChanged();
    armTaskWake(); // срок мог стать ближе — будильник перезаряжаем сразу
  }
  return r;
});
ipcMain.handle("tasks:update", (_e, key, patch) => {
  const r = agentStore.tasksUpdate(userDataDir(), key, patch || {});
  if (r.ok) {
    emitTasksChanged();
    armTaskWake(); // срок мог стать ближе — будильник перезаряжаем сразу
  }
  return r;
});
ipcMain.handle("tasks:done", (_e, key, done) => {
  const r = agentStore.tasksDone(userDataDir(), key, done !== false);
  if (r.ok) {
    emitTasksChanged();
    armTaskWake(); // срок мог стать ближе — будильник перезаряжаем сразу
  }
  return r;
});
ipcMain.handle("tasks:delete", (_e, key) => {
  const r = agentStore.tasksDelete(userDataDir(), key);
  if (r.ok) {
    emitTasksChanged();
    armTaskWake(); // срок мог стать ближе — будильник перезаряжаем сразу
  }
  return r;
});
// Подтверждение от окна: автозадача действительно пошла в прогон (ok) или не смогла.
// Без этого окна планировщик повторяет попытку и в конце честно говорит о неудаче.
ipcMain.handle("tasks:auto-ack", (_e, key, ok, error) => {
  const r = agentStore.tasksAutoAck(userDataDir(), key, ok !== false, error || "");
  if (r.ok) {
    emitTasksChanged();
    armTaskWake();
  }
  return r;
});
ipcMain.handle("tasks:auto-rearm", (_e, key) => {
  const r = agentStore.tasksAutoRearm(userDataDir(), key);
  if (r.ok) {
    emitTasksChanged();
    armTaskWake();
  }
  return r;
});

  // Возвращаем состояние дел и миссий: по каналам его читает окно (и телефон),
  // а тесты собирают модуль напрямую и проверяют эти функции.
  return { missionStateForUi, agentFilesStatus };
}

module.exports = { registerMissionIpc };

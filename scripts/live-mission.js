"use strict";
/* ЖИВОЙ прогон дел, миссий и папки работы: модуль src/mission-ipc.js собран как в
   main.js, но с НАСТОЯЩИМИ хранилищами (agent-store.js, mission-store.js) и настоящим
   диском. Заглушки только у окна и у Electron (ipcMain/shell) — их в Node нет.
   Запуск: bun run test:live:mission

   Зачем: обычные тесты работают на заглушках хранилищ, а здесь всё по-настоящему —
   дело ложится файлом в userData, миссия переживает паузу и «▶ Продолжить»,
   закрытие и удаление чистят диск, папка работы открывается и очищается,
   и при этом миссии остаются целы. Окно и телефон ходят именно по этим каналам. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerMissionIpc } = require(path.join(ROOT, "src", "mission-ipc.js"));
const agentStore = require(path.join(ROOT, "src", "agent-store.js"));
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log("  ✅ " + name + (extra ? " — " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mission-live-"));
const workDir = path.join(tmp, "project");
const userData = path.join(tmp, "userData");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const handlers = new Map();
const opened = [];
const shown = [];
let emitted = 0;
let armed = 0;
let claim = "";
const settings = { longWork: true, agentWorkFiles: true, contextMemory: true, workingDir: workDir };

const mod = registerMissionIpc({
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
  fs: fs,
  shell: {
    showItemInFolder: (p) => shown.push(p),
    openPath: async (p) => { opened.push(p); return ""; },
  },
  agentStore: agentStore,
  missionStore: missionStore,
  loadSettings: () => Object.assign({}, settings),
  agentWorkDir: (s) => s.workingDir,
  userDataDir: () => userData,
  emitTasksChanged: () => { emitted++; },
  armTaskWake: () => { armed++; },
  live: { missionClaim: () => claim, setMissionClaim: (v) => { claim = v; } },
});

const call = (ch, ...args) => handlers.get(ch)(null, ...args);
const agentRoot = path.join(workDir, ".agent");

(async () => {
  console.log("[1] Каналы собраны на настоящих хранилищах");
  check("19 каналов дел, миссий и файлов работы", handlers.size === 19, "собрано " + handlers.size);
  check("модуль отдаёт состояние миссий", typeof mod.missionStateForUi === "function");
  check("модуль отдаёт состояние папки работы", typeof mod.agentFilesStatus === "function");

  console.log("[2] Дела: настоящая запись на диск");
  const today = new Date().toISOString().slice(0, 10);
  const added = await call("tasks:add", { title: "Позвонить в банк", due: today, priority: "high" });
  check("дело добавлено", added.ok === true, JSON.stringify(added));
  check("окно извещено об изменении дел", emitted === 1, "извещений " + emitted);
  check("будильник на срок перезаряжен", armed === 1, "перезарядок " + armed);
  const list = await call("tasks:list", {});
  check("дело видно в списке", list.tasks && list.tasks.length === 1, JSON.stringify(list.tasks && list.tasks.length));
  check("название не потерялось", (list.tasks[0] || {}).title === "Позвонить в банк", (list.tasks[0] || {}).title);
  const tasksFile = path.join(userData, "tasks.json");
  check("дела лежат файлом в userData", fs.existsSync(tasksFile), tasksFile);
  const board = await call("tasks:board");
  // Доска отдаёт разделы списком ({groups:[{id,title,tasks}]}) — берём разделы по id.
  // К вечеру дело со сроком «сегодня» честно уезжает в «Просрочено», поэтому ждём
  // его в любом из двух разделов, а не именно в «Сегодня».
  const group = (gid) => ((board.groups || []).find((g) => g.id === gid) || {}).tasks || [];
  const onBoard = group("overdue").concat(group("today")).some((t) => t.title === "Позвонить в банк");
  check("дело со сроком «сегодня» видно на доске", onBoard,
    "просрочено: " + group("overdue").length + ", сегодня: " + group("today").length);
  check("итог доски посчитан", (board.summary || {}).active === 1, JSON.stringify(board.summary || {}));
  check("приоритет сохранён", (list.tasks[0] || {}).priority === "high", (list.tasks[0] || {}).priority);

  console.log("[3] Дела: закрытие и удаление через каналы");
  const key = (list.tasks[0] || {}).id;
  const done = await call("tasks:done", key, true);
  check("дело закрыто", done.ok === true, JSON.stringify(done));
  const active = await call("tasks:list", {});
  check("закрытое дело ушло из активных", active.tasks.length === 0, "осталось " + active.tasks.length);
  const doneList = await call("tasks:list", { status: "done" });
  check("закрытое дело осталось в истории", doneList.tasks.length === 1, "в истории " + doneList.tasks.length);
  check("чтение дел не дёргает окно зря (извещали только запись)", emitted === 2, "извещений " + emitted);

  console.log("[4] Миссия: настоящая папка, журнал и продолжение");
  const created = missionStore.missionCreate(workDir, {
    goal: "Разобрать 10 писем и ответить",
    title: "Разбор писем",
    role: "manager",
    chatId: "c1",
    steps: [{ title: "прочитать" }, { title: "ответить" }],
  });
  check("миссия заведена настоящим хранилищем", created.ok === true, JSON.stringify(created.error || ""));
  const id = created.mission.id;
  check("папка миссии на диске", fs.existsSync(path.join(agentRoot, "missions", id)), id);

  const st = await call("mission:state");
  check("панель видит долгую работу", st.enabled === true);
  check("активная миссия отдана панели", st.active && st.active.id === id, st.active && st.active.id);
  check("журнал прочитан с диска", st.journal.length >= 2, "строк " + st.journal.length);
  check("шаги посчитаны", st.list[0].steps === 2, String(st.list[0].steps));
  check("прогон не идёт — признак честный", st.running === false && st.paused === false);

  const paused = await call("mission:pause");
  check("пауза без прогона безопасна", paused.ok === true && paused.running === false, JSON.stringify(paused));
  missionStore.missionSave(workDir, Object.assign(missionStore.missionLoad(workDir, id), { status: "paused" }));
  check("миссия уведена в паузу на диске", missionStore.missionLoad(workDir, id).status === "paused");

  const resumed = await call("mission:resume");
  check("«▶ Продолжить» принято", resumed.ok === true, JSON.stringify(resumed.error || ""));
  check("миссия вернулась в работу на диске", missionStore.missionLoad(workDir, id).status === "active");
  check("просьба человека ушла в живое значение main.js", claim === id, claim);
  check("текст продолжения собран", String(resumed.text || "").indexOf(id) >= 0, String(resumed.text || "").slice(0, 60));
  const journal = missionStore.missionJournalText(workDir, id, { limit: 20 });
  check("в журнале записано, кто продолжил", /Человек вернул миссию/.test(journal), journal.slice(-90));

  console.log("[5] Миссия: закрытие человеком");
  const fin = await call("mission:finish", id);
  check("миссия закрыта", fin.ok === true && fin.status === "stopped", JSON.stringify(fin));
  check("после закрытия просьба снята", claim === "", "claim=" + JSON.stringify(claim));
  check("статус на диске — stopped", missionStore.missionLoad(workDir, id).status === "stopped");
  const again = await call("mission:finish", id);
  check("повторное закрытие не ломается", again.ok === true && again.already === true, JSON.stringify(again));

  console.log("[6] Файлы работы: состояние, открытие, очистка");
  missionStore.tasksMirror(workDir, "# Дела\n- позвонить");
  missionStore.contextMirror(workDir, Date.now(), "памятка за день");
  const files = await call("agentfiles:status");
  check("папка работы видна", files.exists === true && files.folder === agentRoot, JSON.stringify(files.folder));
  check("зеркало дел посчитано", files.tasks && files.tasks.bytes > 0, JSON.stringify(files.tasks));
  check("дни контекста перечислены", files.contextDays.length === 1, JSON.stringify(files.contextDays));
  check("миссия посчитана", files.missions === 1, String(files.missions));
  check("галочки настроек отданы", files.enabled === true && files.longWork === true, JSON.stringify(filesenabledSafe(files)));

  const openedRoot = await call("agentfiles:openDir");
  check("открылась папка работы", opened[opened.length - 1] === agentRoot, opened[opened.length - 1]);
  check("открытие отчиталось успехом", openedRoot.ok === true, JSON.stringify(openedRoot.error));
  const openedMission = await call("agentfiles:openDir", id);
  check("открылась папка миссии", /missions[\\/]/.test(opened[opened.length - 1]) && opened[opened.length - 1].indexOf(id) > 0,
    opened[opened.length - 1]);
  check("папка миссии создана на диске", fs.existsSync(path.join(agentRoot, "missions", id)));

  const cleared = await call("agentfiles:clear");
  check("очистка прошла", cleared.ok === true, JSON.stringify(cleared));
  check("текст очистки называет, что убрано", /Зеркала очищены/.test(cleared.message || ""), cleared.message);
  check("текст успокаивает про миссии", /Миссии не затронуты/.test(cleared.message || ""), cleared.message);
  check("зеркало дел удалено", !fs.existsSync(path.join(agentRoot, "tasks.md")));
  check("папка контекста удалена", !fs.existsSync(path.join(agentRoot, "context")));
  check("миссия после очистки цела", fs.existsSync(path.join(agentRoot, "missions", id)));

  console.log("[7] Удаление миссии: во время прогона — отказ, потом — по-настоящему");
  // «Во время прогона» = прогон идёт и человек только что вернул ИМЕННО эту миссию
  // («▶ Продолжить» — тот же путь: он ставит живую просьбу). Порядок тот же, что в жизни.
  const created2 = missionStore.missionCreate(workDir, { goal: "Дописать отчёт", title: "Отчёт" });
  const id2 = created2.mission.id;
  const resumed2 = await call("mission:resume");
  check("живая просьба стоит на второй миссии", resumed2.ok === true && claim === id2, JSON.stringify(resumed2.error || claim));
  global.__agentRunning = true;
  const refused = await call("mission:delete", id2);
  check("во время прогона миссия не удаляется", refused.ok === false, JSON.stringify(refused));
  check("отказ объясняет, что делать", /Стоп|Закрыть/.test(refused.error || ""), refused.error);
  check("папка миссии на месте", fs.existsSync(path.join(agentRoot, "missions", id2)));
  global.__agentRunning = false;
  const del = await call("mission:delete", id2);
  check("после прогона миссия удалена", del.ok === true && del.id === id2, JSON.stringify(del));
  check("папка миссии ушла с диска", !fs.existsSync(path.join(agentRoot, "missions", id2)));
  check("просьба человека снята вместе с миссией", claim === "", JSON.stringify(claim));
  const delOld = await call("mission:delete", id);
  check("закрытая ранее миссия удаляется свободно", delOld.ok === true, JSON.stringify(delOld));

  console.log("[8] Мост в окно: открытие миссии и «Открыть папку» человека");
  const openMission = await call("mission:open", id2);
  check("mission:open сообщает путь", openMission.ok === true && openMission.path.indexOf("missions") > 0, openMission.path);
  check("проводник получил путь", shown.length === 1 && shown[0] === openMission.path, shown.join(" | "));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nЖИВОЙ ПРОГОН ДЕЛ И МИССИЙ: " + pass + " ✅ / " + fail + " ❌");
  if (!fail) console.log("Дерево не тронуто: всё писалось во временную папку.");
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("✗ прогон упал: " + (err && err.stack || err));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

function filesenabledSafe(f) {
  return { enabled: f.enabled, longWork: f.longWork, memory: f.memory };
}

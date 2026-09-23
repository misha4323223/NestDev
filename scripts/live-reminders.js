"use strict";
/* ЖИВОЙ прогон дел: зеркало, напоминания, автозадачи и будильник — модуль
   src/tasks-reminders.js собран как в main.js, но с НАСТОЯЩИМИ хранилищами
   (agent-store.js, mission-store.js) и настоящим диском. Заглушки только у окна
   и у уведомлений Windows — их в Node нет.
   Запуск: bun run test:live:reminders

   Зачем: набор модуля работает на поддельных хранилищах, а здесь всё по-настоящему —
   дело ложится файлом в userData, зеркало .agent/tasks.md пишется на диск, отметка
   «напомнено» ложится в настоящий файл дел (значит, второй раз не пристанем),
   а задержка будильника считается по настоящему хранилищу.

   Сроки задаются так, как их шлёт само приложение («через 2 часа», «09:30», дата):
   ISO-строка с секундами в хранилище разбирается как «весь день» — это его правило,
   а не то, что приходит от окна.

   Проверяются именно тихие ошибки: напоминание не пришло; пристаём дважды; в
   контейнере без D-Bus фон падает; автозадача ушла тостом вместо прогона агента;
   взяли дела без окна — и автозадача сгорела. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createTasksReminders } = require(path.join(ROOT, "src", "tasks-reminders.js"));
const agentStore = require(path.join(ROOT, "src", "agent-store.js"));
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));

let pass = 0;
let fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log("  ✅ " + name + (extra ? " — " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? " — " + extra : "")); }
};
const pad = (n) => String(n).padStart(2, "0");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-live-"));
const workDir = path.join(tmp, "project");
const userData = path.join(tmp, "userData");
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

// ── Окно и уведомления: поддельные (в Node их нет), но ведут себя как настоящие ──
const events = [];
let destroyed = false;
const win = {
  isDestroyed: () => destroyed,
  webContents: { send: (ch, ev) => events.push({ ch, ev }) },
};
const toasts = [];
const Notification = class {
  constructor(x) { toasts.push(x); }
  show() {}
  static isSupported() { return true; }
};

const settings = { workingDir: workDir, agentWorkFiles: true };
const api = createTasksReminders({
  app: { getPath: () => userData },
  Notification: Notification,
  agentStore: agentStore,
  missionStore: missionStore,
  loadSettings: () => Object.assign({}, settings),
  agentWorkDir: (s) => s.workingDir,
  // Папка данных дел приходит ФУНКЦИЕЙ: она своя, если человек выбрал её в настройках
  // (src/agent-data.js), и папка приложения — если нет. Стенд отдаёт папку приложения:
  // без выбора человека это то же самое место.
  tasksDataDir: () => userData,
  getWindow: () => win,
});

const mirrorFile = path.join(workDir, ".agent", "tasks.md");
const readMirror = () => (fs.existsSync(mirrorFile) ? fs.readFileSync(mirrorFile, "utf8") : "");
const eventsOf = (type) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === type);
const toastTitles = () => toasts.map((t) => t.title);
const clear = () => { toasts.length = 0; events.length = 0; };
const taskOf = (id) => agentStore.tasksList(userData, {}).tasks.find((t) => t.id === id);

// Просроченное дело — вчерашним днём, будущее — «через 2 часа»: формы, которые шлёт
// окно. («00:05» на прошлое не годится: время, которое уже прошло, хранилище честно
// переносит на завтра — см. правило 7 разбора срока.)
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const pastDate = yesterday.getFullYear() + "-" + pad(yesterday.getMonth() + 1) + "-" + pad(yesterday.getDate());
const futureText = "через 2 часа";

(async () => {
  console.log("Живой прогон дел (настоящее хранилище, настоящий диск)");

  console.log("\n[1] Зеркало списка ложится файлом в рабочую папку");
  const t1 = agentStore.tasksAdd(userData, { title: "Позвонить в банк", due: pastDate, priority: "high" });
  check("дело легло в настоящее хранилище", t1.ok === true && t1.task.due.indexOf(pastDate + "T09:00") === 0, t1.task && t1.task.due);
  clear();
  api.emitTasksChanged();
  check("окно получило событие панели", events.length === 1 && events[0].ch === "tasks:changed", "событий: " + events.length);
  check("зеркало появилось на диске", fs.existsSync(mirrorFile), mirrorFile);
  const mir1 = readMirror();
  check("в зеркале шапка с отметкой обновления", /^# Дела \(зеркало списка приложения, обновлено /m.test(mir1));
  check("в зеркале сводка посчитана хранилищем", /Активных: 1, просрочено: 1/.test(mir1), mir1.split("\n")[2]);
  check("в зеркале само дело", /Позвонить в банк/.test(mir1));

  const t2 = agentStore.tasksAdd(userData, { title: "Собрать отчёт", due: futureText });
  check("второе дело добавлено (срок через два часа)", t2.ok === true);
  api.emitTasksChanged();
  check("зеркало перезаписано со свежей сводкой", /Активных: 2/.test(readMirror()), readMirror().split("\n")[2]);

  settings.agentWorkFiles = false;
  fs.unlinkSync(mirrorFile);
  clear();
  api.emitTasksChanged();
  check("галочка «файлы работы» выключена — файла нет", !fs.existsSync(mirrorFile));
  check("но событие панели всё равно ушло", events.some((e) => e.ch === "tasks:changed"));
  settings.agentWorkFiles = true;

  console.log("\n[2] Контейнер без D-Bus: тоста нет, но фон жив и дело названо окну");
  delete process.env.DBUS_SESSION_BUS_ADDRESS;
  check("канал уведомлений честно признан отсутствующим", api.canNotify() === false);
  clear();
  api.checkTaskReminders();
  check("в контейнере тоста нет (процесс не убьём)", toasts.length === 0, toastTitles().join(" | "));
  const rem = eventsOf("task-reminder");
  check("окно всё равно получило событие о сроке", rem.length === 1, "событий: " + rem.length);
  check("в событии просроченное дело", !!rem[0] && rem[0].ev.tasks.length === 1 && rem[0].ev.tasks[0].title === "Позвонить в банк" && rem[0].ev.tasks[0].late === true,
    JSON.stringify(rem[0] && rem[0].ev.tasks));
  check("будущее дело не пристало раньше срока", eventsOf("task-reminder")[0].ev.tasks.length === 1);
  const stored = taskOf(t1.task.id);
  check("отметка «напомнено» легла в настоящий файл дел", !!(stored && stored.remindedAt), stored && String(stored.remindedAt));
  clear();
  api.checkTaskReminders();
  check("второй раз не пристаём (напоминание одно)", toasts.length === 0 && eventsOf("task-reminder").length === 0);

  console.log("\n[3] Канал есть: тост про срок и прогон агента вместо тоста");
  process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
  check("живая шина распознана", api.canNotify() === true);
  const t3 = agentStore.tasksAdd(userData, { title: "Оплатить счёт", due: pastDate });
  const t4 = agentStore.tasksAdd(userData, { title: "Собрать отчёт (агент)", due: pastDate, auto: true });
  check("просроченное дело и автозадача легли в хранилище", t3.ok === true && t4.ok === true);
  clear();
  api.checkTaskReminders();
  const late = toasts.find((t) => /Оплатить счёт/.test(String(t.title)));
  check("просроченное дело подано тостом", !!late, toastTitles().join(" | "));
  check("тост назван просроченным", !!late && /^⚠ Дело просрочено: /.test(late.title), late && late.title);
  check("в теле — человеческий срок из хранилища", !!late && /просрочено \(/.test(String(late.body)), late && late.body);
  check("автозадача не ушла тостом", !toastTitles().some((t) => /Собрать отчёт \(агент\)/.test(t)), toastTitles().join(" | "));
  const due = eventsOf("task-due");
  check("окно получило срок автозадачи", due.length === 1, "событий: " + due.length);
  check("событие помечено ПК-клиентом (иначе прогон удвоится)", !!due[0] && due[0].ev.from === "desktop", due[0] && String(due[0].ev.from));
  check("в событии именно автозадача", !!due[0] && due[0].ev.tasks.length === 1 && due[0].ev.tasks[0].id === t4.task.id);
  check("окно обновилось после автозадачи", events.some((e) => e.ch === "tasks:changed"));
  const storedAuto = taskOf(t4.task.id);
  check("в хранилище автозадача ждёт подтверждения прогона", !!(storedAuto && storedAuto.autoPending), storedAuto && String(storedAuto.autoPending));

  console.log("\n[4] Без окна дела НЕ берутся: автозадача не сгорает впустую");
  const t5 = agentStore.tasksAdd(userData, { title: "Выйти к врачу", due: pastDate });
  check("следующее просроченное дело добавлено", t5.ok === true);
  destroyed = true;
  clear();
  api.checkTaskReminders();
  check("в закрытое окно ничего не ушло", events.length === 0, "событий: " + events.length);
  check("тостов в никуда нет", toasts.length === 0, toastTitles().join(" | "));
  const waiting = taskOf(t5.task.id);
  check("дело осталось ненапомненным — ждёт окна", !!(waiting && !waiting.remindedAt));
  destroyed = false;
  clear();
  api.checkTaskReminders();
  check("окно вернулось — дело напомнило о себе", toastTitles().some((t) => /Выйти к врачу/.test(t)), toastTitles().join(" | "));

  console.log("\n[5] Будильник: задержка по настоящему хранилищу и срабатывание");
  // Часы не подменяем — таймеры настоящие; только смотрим, что именно поставлено.
  const armed = [];
  const wiped = [];
  const realTimeout = global.setTimeout;
  const realClear = global.clearTimeout;
  global.setTimeout = (cb, ms) => {
    const handle = realTimeout(cb, ms);
    armed.push({ cb, ms, handle });
    return handle;
  };
  global.clearTimeout = (h) => { wiped.push(h); return realClear(h); };
  try {
    // Будущих сроков больше нет — будильник не нужен вовсе.
    agentStore.tasksUpdate(userData, t2.task.id, { due: pastDate });
    api.armTaskWake();
    check("без будущих дел будильник не ставится", armed.length === 0, "таймеров: " + armed.length);

    agentStore.tasksUpdate(userData, t2.task.id, { due: "через 30 минут" });
    api.armTaskWake();
    check("будильник поставлен на ближайший срок", armed.length === 1, "таймеров: " + armed.length);
    // Срок хранится с точностью до минуты (fmtDue отбрасывает секунды), поэтому
    // допуск — минута; сам запас в четверть секунды сверяется отдельно.
    check("задержка равна сроку с запасом в четверть секунды",
      !!armed[0] && Math.abs(armed[0].ms - (30 * 60 * 1000 + 250)) <= 60000,
      armed[0] && armed[0].ms + " мс");
    check("запас в четверть секунды не потерян (сверка с хранилищем)",
      !!armed[0] && Math.abs((armed[0].ms - 250) - agentStore.tasksNextDue(userData)) <= 50,
      "запас: " + (armed[0] && armed[0].ms - agentStore.tasksNextDue(userData)) + " мс");
    api.armTaskWake();
    check("повторная зарядка снимает прежний будильник", armed.length === 2 && wiped.indexOf(armed[0].handle) >= 0,
      "снято таймеров: " + wiped.length);

    // Далёкий срок ограничен сверху — иначе таймер не переживёт сон машины.
    agentStore.tasksUpdate(userData, t2.task.id, { due: pastDate });
    agentStore.tasksAdd(userData, { title: "Годовой отчёт", due: "через 10 дней" });
    api.armTaskWake();
    const far = armed[armed.length - 1];
    check("далёкий срок ограничен шестью часами", far.ms === 6 * 60 * 60 * 1000, far.ms + " мс");

    const t7 = agentStore.tasksAdd(userData, { title: "Позвонить маме", due: pastDate });
    clear();
    api.armTaskWake();
    const fired = armed[armed.length - 1];
    const wipedBefore = wiped.length;
    fired.cb(); // ровно то, что делает сработавший таймер
    check("сработавший будильник поднимает напоминание", toastTitles().some((t) => /Позвонить маме/.test(t)), toastTitles().join(" | "));
    check("и дело отмечено напомненным в хранилище", !!taskOf(t7.task.id).remindedAt);
    check("сработавший таймер не снимают как живой", wiped.slice(wipedBefore).indexOf(fired.handle) < 0);
  } finally {
    global.setTimeout = realTimeout;
    global.clearTimeout = realClear;
  }

  console.log("\nИтог: " + (fail ? fail + " провал(ов)" : "все проверки прошли") + " (" + pass + " ✅)");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.log("  ❌ прогон сорвался: " + String((e && e.stack) || e).split("\n")[0]);
  console.log("\nИтог: провал");
  process.exit(1);
});

"use strict";

/* ── Дела: зеркало, напоминания и точный будильник (src/tasks-reminders.js) ─────
   Запуск: node test/tasks-reminders.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 24). Ошибки здесь тихие и обидные:

     • напоминание не пришло — агент «молчит», хотя дело просрочено;
     • автозадача сгорела впустую: дело взяли, а доставить его некому (окна нет);
     • уведомление через libnotify убило процесс в контейнере без D-Bus;
     • будильник не перезарядился — дело «опаздывает» до минутного опроса;
     • окно прочитано копией — тосты уходят в закрытое окно. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createTasksReminders } = require(path.join(ROOT, "src", "tasks-reminders.js"));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "tasks-reminders.js"), "utf8");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

// Живая шина уведомлений: без неё (контейнер, headless) модуль честно молчит —
// проверять отправку уведомлений нужно там, где канал есть.
function withBus(fn) {
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (process.platform === "linux") process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
  }
}

// Окно: то же, что видит модуль у настоящего Electron.
function mkWindow() {
  const events = [];
  return {
    events,
    isDestroyed: () => false,
    webContents: { send: (ch, ev) => events.push({ ch, ev }) },
  };
}

// Часы: подменяем глобальные таймеры, чтобы будильник был проверяем.
function withClock(fn) {
  const timers = [];
  const saved = { s: global.setTimeout, c: global.clearTimeout };
  global.setTimeout = (cb, ms) => {
    const t = { cb, ms, cleared: false };
    timers.push(t);
    return t;
  };
  global.clearTimeout = (t) => {
    if (t) t.cleared = true;
  };
  try {
    return fn(timers);
  } finally {
    global.setTimeout = saved.s;
    global.clearTimeout = saved.c;
  }
}

// Стенд: хранилище дел, настройки, уведомления, окно.
function mk(over) {
  const o = over || {};
  const calls = { mirrors: [], notifications: [], events: [], emitted: 0, armed: 0, takeReminders: [], takeAuto: 0 };
  let win = o.window === undefined ? mkWindow() : o.window;
  const tasks = {
    reminders: o.reminders || [],
    auto: o.auto || [],
    failed: o.failed || [],
  };
  const deps = {
    app: { getPath: (what) => "/user-data/" + what },
    // «Не передан вовсе» — рабочий уведомитель; «передан undefined» — канала нет.
    // Различаем по наличию ключа, иначе проверка «без Notification» не проверяет ничего.
    Notification: Object.prototype.hasOwnProperty.call(o, "Notification")
      ? o.Notification
      : class { constructor(x) { calls.notifications.push(x); } show() { this.shown = true; } static isSupported() { return true; } },
    agentStore: {
      tasksTakeReminders: (ud, at, opts) => {
        calls.takeReminders.push({ ud, at, opts });
        if (o.throwReminders) throw new Error("хранилище упало");
        return { tasks: tasks.reminders };
      },
      tasksTakeAuto: (ud) => {
        calls.takeAuto++;
        if (o.throwAuto) throw new Error("хранилище упало");
        return { tasks: tasks.auto, failed: tasks.failed };
      },
      tasksNextDue: (ud) => {
        if (o.throwNextDue) throw new Error("нет хранилища");
        return o.nextDue === undefined ? 0 : o.nextDue;
      },
      humanDue: (t, now) => "срок: " + t.due,
      tasksBrief: () => o.brief === undefined ? "- Позвонить в банк" : o.brief,
      tasksBoard: () => ({ summary: o.summary || { active: 2, overdue: 1, today: 1, done: 3 } }),
    },
    missionStore: {
      tasksMirror: (dir, text) => {
        calls.mirrors.push({ dir, text });
        return { ok: true };
      },
    },
    loadSettings: () => {
      if (o.throwSettings) throw new Error("настройки упали");
      return o.settings || {};
    },
    agentWorkDir: () => "/work/project",
    getWindow: () => win,
  };
  const api = createTasksReminders(deps);
  // Собираем счётчики emit/arm из самого модуля (проверяем и то, что он их зовёт).
  return {
    ...api,
    calls,
    deps,
    setWindow: (w) => {
      win = w;
    },
    getWindowNow: () => win,
    tasks,
  };
}

(async () => {
  await test("userDataDir: путь приходит из Electron, а не из рабочей папки", () => {
    const m = mk();
    assert.strictEqual(m.userDataDir(), "/user-data/userData", "хранилище дел уехало из userData");
  });

  await test("зеркало дел: событие окну, файл в рабочей папке и сводка в нём", () => {
    const m = mk();
    m.emitTasksChanged();
    assert.deepStrictEqual(m.calls.events || [], [], "событие ушло не туда");
    const win = m.getWindowNow();
    assert.strictEqual(win.events.length, 1, "окно не получило tasks:changed");
    assert.strictEqual(win.events[0].ch, "tasks:changed");
    assert.ok(typeof win.events[0].ev.ts === "number", "в событии нет метки времени");
    assert.strictEqual(m.calls.mirrors.length, 1, "зеркало дел не записано");
    const mir = m.calls.mirrors[0];
    assert.strictEqual(mir.dir, "/work/project", "зеркало легло не в рабочую папку");
    assert.ok(/^# Дела \(зеркало списка приложения, обновлено /.test(mir.text), "нет шапки зеркала: " + mir.text.slice(0, 60));
    assert.ok(/Активных: 2, просрочено: 1, сегодня: 1, выполнено: 3/.test(mir.text), "сводка дел потерялась: " + mir.text);
    assert.ok(/Позвонить в банк/.test(mir.text), "список дел не попал в зеркало");
  });

  await test("зеркало дел: галочка «файлы работы» выключена — файла нет, событие есть", () => {
    const m = mk({ settings: { agentWorkFiles: false } });
    m.emitTasksChanged();
    assert.strictEqual(m.calls.mirrors.length, 0, "зеркало записано при выключенной галочке");
    assert.strictEqual(m.getWindowNow().events.length, 1, "событие окну не ушло");
  });

  await test("зеркало дел: пустой список объясняется, а не оставляет пустой файл", () => {
    const m = mk({ brief: "" });
    m.emitTasksChanged();
    assert.ok(/Список пуст\./.test(m.calls.mirrors[0].text), "пустой список не объяснён");
  });

  await test("окно читается в момент вызова: событие уходит в НОВОЕ окно", () => {
    const m = mk();
    const old = m.getWindowNow();
    const fresh = mkWindow();
    m.setWindow(fresh);
    m.emitTasksChanged();
    assert.strictEqual(old.events.length, 0, "событие ушло в старое окно — окно прочитано копией");
    assert.strictEqual(fresh.events.length, 1, "новое окно события не получило");
  });

  await test("без окна зеркало всё равно обновляется и ничего не падает", () => {
    const dead = { isDestroyed: () => true, webContents: { send: () => { throw new Error("окно закрыто"); } } };
    const m = mk({ window: dead });
    m.emitTasksChanged();
    assert.strictEqual(m.calls.mirrors.length, 1, "зеркало не обновилось без окна");
    const none = mk({ window: null });
    none.emitTasksChanged();
    assert.strictEqual(none.calls.mirrors.length, 1, "без окна зеркало потерялось");
  });

  // Живая шина: без неё проверку канала закрывает вторая преграда (D-Bus),
  // и «нет канала» проходило бы без самой проверки isSupported.
  await test("canNotify: канал уведомлений проверяется, а не предполагается", () => withBus(() => {
    const noSupport = mk({ Notification: class { static isSupported() { return false; } } });
    assert.strictEqual(noSupport.canNotify(), false, "нет канала, а уведомление считается возможным");
    const broken = mk({ Notification: class { static isSupported() { throw new Error("нет шины"); } } });
    assert.strictEqual(broken.canNotify(), false, "исключение проверки канала уронило модуль");
    const none = mk({ Notification: undefined });
    assert.strictEqual(none.canNotify(), false, "без Notification уведомление считается возможным");
  }));

  await test("canNotify: в контейнере без D-Bus уведомление не шлём (иначе процесс умирает)", () => {
    if (process.platform !== "linux") return;
    const m = mk();
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
      assert.strictEqual(m.canNotify(), false, "без D-Bus уведомление всё-таки пойдёт — фон убьёт процесс");
      process.env.DBUS_SESSION_BUS_ADDRESS = "тcp:host=localhost";
      assert.strictEqual(m.canNotify(), false, "чужой формат шины принят за рабочий");
      process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
      assert.strictEqual(m.canNotify(), true, "живая шина не распознана");
    } finally {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });

  await test("notifyUser: заголовок и тело доходят строками, а отказ не роняет фон", () => withBus(() => {
    const m = mk();
    assert.strictEqual(m.notifyUser("⏰ Дело: Отчёт", "срок: 12:00"), true, "уведомление не отправлено");
    assert.deepStrictEqual(m.calls.notifications[m.calls.notifications.length - 1], { title: "⏰ Дело: Отчёт", body: "срок: 12:00" });
    // Заглушка «нет канала» обязана уметь show(): иначе отказ приходил бы от
    // отсутствия метода, а не от проверки канала, и снятие проверки не ловилось бы.
    const made = [];
    const noChan = mk({ Notification: class { constructor(x) { made.push(x); } show() {} static isSupported() { return false; } } });
    assert.strictEqual(noChan.notifyUser("x", "y"), false, "без канала уведомление «отправлено»");
    assert.strictEqual(made.length, 0, "уведомление создано без канала");
    const dumb = mk({ Notification: class { constructor() { throw new Error("нет уведомлений"); } static isSupported() { return true; } } });
    assert.strictEqual(dumb.notifyUser("x", "y"), false, "падение уведомления уронило фон");
  }));

  await test("будильник: таймер ровно на срок, повторная зарядка снимает прежний", () => {
    withClock((timers) => {
      const m = mk({ nextDue: 60 * 1000 });
      m.armTaskWake();
      assert.strictEqual(timers.length, 1, "будильник не поставлен");
      assert.strictEqual(timers[0].ms, 60 * 1000 + 250, "задержка не равна сроку с запасом: " + timers[0].ms);
      m.armTaskWake();
      assert.strictEqual(timers.length, 2, "будильник не перезарядился");
      assert.strictEqual(timers[0].cleared, true, "старый будильник остался висеть");
    });
  });

  await test("будильник: пустой список дел не ставит таймер, далёкий срок ограничен сверху", () => {
    withClock((timers) => {
      const none = mk({ nextDue: 0 });
      none.armTaskWake();
      assert.strictEqual(timers.length, 0, "будильник поставлен без дел");
      const far = mk({ nextDue: 40 * 60 * 60 * 1000 });
      far.armTaskWake();
      assert.strictEqual(timers[0].ms, 6 * 60 * 60 * 1000, "далёкий срок не ограничен: " + timers[0].ms);
      const broken = mk({ throwNextDue: true });
      broken.armTaskWake();
      assert.strictEqual(timers.length, 1, "падение хранилища сломало зарядку будильника");
    });
  });

  await test("будильник: сработал — слот свободен, следующий раз не снимается впустую", () => {
    withClock((timers) => {
      const m = mk({ nextDue: 5000 });
      m.armTaskWake();
      const fired = timers[0];
      fired.cb(); // будильник срабатывает: внутри себя он зовёт проверку напоминаний
      assert.strictEqual(fired.cleared, false, "сработавший будильник снимают как живой");
    });
  });

  await test("без окна дела НЕ берутся: автозадача не сгорает впустую", () => {
    const reminder = { id: "1", title: "Позвонить", due: "2026-01-01T00:00:00.000Z" };
    withClock(() => {
      const m = mk({ window: null, reminders: [reminder], nextDue: 60000 });
      m.checkTaskReminders();
      assert.strictEqual(m.calls.takeReminders.length, 0, "напоминания взяты без окна — человек их не увидит");
      assert.strictEqual(m.calls.takeAuto, 0, "автозадача взята без окна — она сгорит");
      assert.strictEqual(m.calls.notifications.length, 0, "уведомление ушло в никуда");
    });
    // Закрытое окно (свёрнуто в трей) — ровно тот же случай: доставить дело некому,
    // и взятая автозадача сгорела бы вместе с окном.
    withClock(() => {
      const dead = mk({
        window: { isDestroyed: () => true, webContents: { send: () => {} } },
        reminders: [reminder],
        auto: [{ id: "z", title: "Отчёт" }],
        nextDue: 60000,
      });
      dead.checkTaskReminders();
      assert.strictEqual(dead.calls.takeReminders.length, 0, "напоминания взяты при закрытом окне");
      assert.strictEqual(dead.calls.takeAuto, 0, "автозадача взята при закрытом окне — она сгорит");
      assert.strictEqual(dead.calls.notifications.length, 0, "уведомление ушло в закрытое окно");
    });
  });

  await test("напоминания: просроченное дело — система, тост и событие окну", () => withBus(() => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const m = mk({
      reminders: [
        { id: "a", title: "Отчёт", due: past },
        { id: "b", title: "Позвонить", due: future },
      ],
      nextDue: 60000,
    });
    withClock((timers) => {
      m.checkTaskReminders();
      assert.strictEqual(timers.length, 1, "будильник не перезаряжен после проверки");
    });
    const titles = m.calls.notifications.map((n) => n.title);
    assert.ok(titles.includes("⚠ Дело просрочено: Отчёт"), "просроченное дело подано не как просроченное: " + titles.join(" | "));
    assert.ok(titles.includes("⏰ Дело: Позвонить"), "будущее дело подано как просроченное: " + titles.join(" | "));
    const ev = m.getWindowNow().events.find((e) => e.ev && e.ev.type === "task-reminder");
    assert.ok(ev, "окно не получило событие о сроке");
    assert.deepStrictEqual(ev.ev.tasks, [
      { id: "a", title: "Отчёт", due: past, late: true },
      { id: "b", title: "Позвонить", due: future, late: false },
    ], "в событии неверные дела: " + JSON.stringify(ev.ev.tasks));
    assert.deepStrictEqual(m.calls.takeReminders[0].opts, { includeAuto: false }, "режим «напоминать автозадачи» неверен");
    assert.strictEqual(m.calls.mirrors.length, 1, "после напоминания панель и зеркало не обновились");
  }));

  await test("автозадачи: событие помечено ПК-клиентом, иначе прогон удвоится", () => {
    const m = mk({ auto: [{ id: "z", title: "Собрать отчёт" }], nextDue: 0 });
    withClock(() => m.checkTaskReminders());
    const ev = m.getWindowNow().events.find((e) => e.ev && e.ev.type === "task-due");
    assert.ok(ev, "окно не получило срок автозадачи");
    assert.strictEqual(ev.ev.from, "desktop", "автозадача уйдёт и на телефон — прогон удвоится");
    assert.deepStrictEqual(ev.ev.tasks, [{ id: "z", title: "Собрать отчёт" }]);
    const reminder = m.getWindowNow().events.find((e) => e.ev && e.ev.type === "task-reminder");
    assert.strictEqual(reminder, undefined, "пустой список напоминаний дал событие");
  });

  await test("галочки: напоминания выключены — автозадачи работают; автозадачи выключены — дело не молчит", () => withBus(() => {
    const off = mk({ settings: { taskReminders: false }, auto: [{ id: "z", title: "Отчёт" }], nextDue: 0 });
    withClock(() => off.checkTaskReminders());
    assert.strictEqual(off.calls.takeReminders.length, 0, "напоминания взяты при выключенной галочке");
    assert.strictEqual(off.calls.takeAuto, 1, "автозадачи заглушены галочкой напоминаний");
    assert.ok(off.getWindowNow().events.some((e) => e.ev && e.ev.type === "task-due"), "автозадача не доехала до окна");

    const noAuto = mk({ settings: { taskAuto: false }, reminders: [{ id: "a", title: "Позвонить", due: new Date().toISOString() }], nextDue: 0 });
    withClock(() => noAuto.checkTaskReminders());
    assert.strictEqual(noAuto.calls.takeAuto, 0, "автозадачи взяты при выключенной галочке");
    assert.deepStrictEqual(noAuto.calls.takeReminders[0].opts, { includeAuto: true }, "автозадача не попадает даже в напоминания — дело промолчит");
    assert.ok(noAuto.calls.notifications.some((n) => /Позвонить/.test(n.title)), "дело промолчало совсем");
  }));

  await test("неудача автозадачи названа человеку, а не проглочена", () => withBus(() => {
    const m = mk({ failed: [{ id: "f", title: "Отчёт", error: "нет ключа модели" }], nextDue: 0 });
    withClock(() => m.checkTaskReminders());
    assert.ok(m.calls.notifications.some((n) => n.title === "⚠ Автозадача не запустилась: Отчёт" && n.body === "нет ключа модели"),
      "провал автозадачи не объяснён: " + JSON.stringify(m.calls.notifications));
    const ev = m.getWindowNow().events.find((e) => e.ev && e.ev.type === "task-auto-failed");
    assert.ok(ev, "окно не узнало о провале автозадачи");
    assert.deepStrictEqual(ev.ev.tasks, [{ id: "f", title: "Отчёт", error: "нет ключа модели" }]);
    const noReason = mk({ failed: [{ id: "g", title: "Без причины" }], nextDue: 0 });
    withClock(() => noReason.checkTaskReminders());
    assert.ok(noReason.calls.notifications.some((n) => n.body === "прогон не подтвердился"), "у провала без причины нет объяснения");
  }));

  await test("падение хранилища и настроек не роняет фон и не оставляет мусор", () => {
    withClock((timers) => {
      const m = mk({ throwSettings: true, nextDue: 0 });
      m.checkTaskReminders();
      assert.strictEqual(m.getWindowNow().events.length, 0, "при сбое настроек ушло событие");
      assert.strictEqual(timers.length, 0, "при сбое настроек поставлен будильник");
      const noStore = mk({ throwReminders: true, nextDue: 0 });
      noStore.checkTaskReminders();
      assert.strictEqual(noStore.getWindowNow().events.length, 0, "при сбое хранилища ушло событие");
    });
  });

  await test("пустая проверка не дёргает окно и не пишет зеркало", () => {
    withClock(() => {
      const m = mk({ nextDue: 0 });
      m.checkTaskReminders();
      assert.strictEqual(m.calls.mirrors.length, 0, "зеркало перезаписано без изменений");
      assert.strictEqual(m.getWindowNow().events.length, 0, "окно дёрнуто без повода");
    });
  });

  await test("в main.js этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["function userDataDir(", "function emitTasksChanged(", "function canNotify(",
      "function notifyUser(", "function armTaskWake(", "function checkTaskReminders(", "let taskWakeTimer"]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    const wiring = /const \{ createTasksReminders \} = require\("\.\/tasks-reminders\.js"\)[\s\S]*?\n\}\);/.exec(MAIN_SRC);
    assert.ok(wiring, "не нашёл проводку модуля");
    for (const dep of ["  app,", "  Notification,", "  agentStore,", "  missionStore,", "  loadSettings,", "  agentWorkDir,", "  getWindow: () => mainWindow,"]) {
      assert.ok(wiring[0].includes(dep), "в проводку не передано: " + dep.trim());
    }
    assert.ok(/const \{ userDataDir, emitTasksChanged, canNotify, notifyUser, armTaskWake,/.test(MAIN_SRC),
      "оболочка не берёт имена из модуля целиком");
    // Сборка стоит ВЫШЕ справочников: они получают userDataDir значением.
    assert.ok(MAIN_SRC.indexOf("createTasksReminders({") < MAIN_SRC.indexOf("createSiteGuides({"),
      "модуль собран ниже site-guides — userDataDir придёт пустым");
    assert.ok(MODULE_SRC.includes("getWindow()"), "окно читается не в момент вызова");
    // Окно берётся в момент вызова: сверху модуля нет своей переменной окна,
    // иначе тосты уходили бы в окно, которое уже закрыто.
    assert.ok(!/^(?:let|var|const) mainWindow\b/m.test(MODULE_SRC), "модуль завёл копию окна");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

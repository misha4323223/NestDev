"use strict";

/* ── Автозадачи (src/renderer/auto-tasks.js) ─────────────────────────────────
   Запуск: node test/auto-tasks.test.js   (входит в общий `npm test`)

   Автозадачи вынесены из app.js своим модулем (этап A, часть 4). Ломается это тихо:
   дело со сроком просто перестаёт выполняться, а человек видит его в списке как
   обычно. Поэтому проверяется настоящий маршрут на заглушках:

     • «▶ Сейчас» — тот же прогон, что по сроку, но по кнопке: без модели не бежит,
       при занятом агенте не бежит, в браузере честно отказывает;
     • чат «Автозадачи» — один на всё приложение (второй не заводится), у него своя
       роль, пояснение и он же выбирается в окне;
     • подтверждение планировщику: срок закрывается, когда прогон начался, и
       открывается снова, когда прогон сорвался (иначе дело не поднялось бы НИКОГДА);
     • очередь: пока идёт другой прогон, дело ждёт, а после — стартует;
     • разовое дело закрывается, ручной прогон снимает «сдался».

   Отдельно — границы модуля: оболочку он читает только через живые доступы
   (getSettings/getStreaming/getChatsData/getTasksMission), а подключён тегом до
   app.js и отдан телефону мостом. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "renderer", "auto-tasks.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет»
// (ровно тот случай, ради которого тест «бюджет прямых чтений app.js» и оставлен).
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
// Прогон агента вынесен своим модулем (этап A, часть 9): конец прогона разбирает
// очередь автозадач именно там, поэтому и спрашиваем модуль отправки.
const SEND_SRC = read("src", "renderer", "chat-send.js");

// ── Сборка модуля в песочнице ───────────────────────────────────────────────
// Модуль живёт в окне, но собирается той же фабрикой, что и в приложении, поэтому
// проверяется настоящий код, а не копия из теста.
function buildAutoTasks(world) {
  const o = world || {};
  const calls = { toast: [], ack: [], done: [], rearm: [], run: [], selected: [] };
  const state = {
    isElectron: o.isElectron === undefined ? true : o.isElectron,
    settings: Object.assign({ model: "gpt-oss:120b" }, o.settings || {}),
    streaming: !!o.streaming,
    chatsData: o.chatsData || { chats: [], activeId: null },
    runResult: o.runResult === undefined ? { id: "m1", role: "assistant", content: "готово" } : o.runResult,
    runThrows: o.runThrows || null,
  };
  let created = 0;
  let persisted = 0;
  let sidebars = 0;
  let rendered = 0;

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "auto-tasks.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");

  const tasks = box.module.exports({
    isElectron: state.isElectron,
    api: {
      tasksAutoAck: (id, ok, err) => calls.ack.push({ id, ok, err }),
      tasksDone: async (id) => calls.done.push(id),
      tasksAutoRearm: async (id) => calls.rearm.push(id),
    },
    toast: (t) => calls.toast.push(t),
    uid: () => "sys-1",
    createChat: (opts) => {
      created++;
      const chat = { id: "auto-chat", title: (opts || {}).title, messages: [], auto: false, role: "dev" };
      state.chatsData.chats.push(chat);
      return chat;
    },
    persistChats: () => { persisted++; },
    renderSidebar: () => { sidebars++; },
    selectChat: (id) => { calls.selected.push(id); state.chatsData.activeId = id; },
    runTurn: async (chat, text) => {
      calls.run.push({ chat, text });
      if (state.runThrows) throw state.runThrows;
      return state.runResult;
    },
    getSettings: () => state.settings,
    getStreaming: () => state.streaming,
    getChatsData: () => state.chatsData,
    getTasksMission: () => ({ renderTasks: () => { rendered++; } }),
  });

  return {
    tasks, calls, state,
    counters: () => ({ created, persisted, sidebars, rendered }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const task = (extra) => Object.assign({ id: "t1", title: "Позвонить в банк", auto: true, repeat: "" }, extra || {});

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("автозадачи: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="auto-tasks.js"');
    assert.ok(tag > 0, "разметка не грузит auto-tasks.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "auto-tasks.js подключён после app.js");
    assert.ok(/"auto-tasks\.js"/.test(BRIDGE_SRC), "мост не отдаёт auto-tasks.js телефону");
  });

  await test("автозадачи: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "function ensureAutoChat", "function autoTaskText", "function startAutoRunNow",
      "function flushAutoQueue", "function autoAck", "async function runAutoTask",
      'const AUTO_CHAT_TITLE = "Автозадачи"', "const autoQueue = []",
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код автозадач остался в app.js: " + gone);
    }
    assert.ok(MODULE_SRC.includes('const AUTO_CHAT_TITLE = "Автозадачи"'), "модуль потерял чат автозадач");
    assert.ok(MODULE_SRC.includes("async function runAutoTask"), "модуль не умеет запускать автозадачу");

    // Очередь — общая с разбором событий агента: значит, отдаётся из модуля, а не копией.
    assert.ok(APP_SRC.includes("autoQueue: AutoTasks.autoQueue,"), "события агента получили копию очереди");
    assert.ok(APP_SRC.includes("flushAutoQueue: AutoTasks.flushAutoQueue,"), "события агента зовут не тот запуск");
    assert.ok(APP_SRC.includes("getAutoTasks: () => AutoTasks,"), "прогон не получает автозадачи живым доступом");
    assert.ok(SEND_SRC.includes("getAutoTasks().flushAutoQueue();"), "прогон не разбирает очередь после себя");
    assert.ok(APP_SRC.includes("startAutoRunNow: AutoTasks.startAutoRunNow,"), "дела с миссией не зовут «▶ сейчас»");

    // Проводка: панели объявлены НИЖЕ, поэтому внутрь идут только отложенные стрелки.
    const start = APP_SRC.indexOf("  const AutoTasks = window.AutoTasks({");
    assert.ok(start > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(start, APP_SRC.indexOf("  });", start));
    for (const dep of [
      "isElectron: isElectron,", "api: api,", "toast: toast,", "uid: uid,",
      "createChat: createChat,", "persistChats: ChatStore.persistChats,", "renderSidebar: renderSidebar,",
      "selectChat: selectChat,", "runTurn: ChatSend.runTurn,", "getSettings: () => settings,",
      "getStreaming: () => streaming,", "getChatsData: () => chatsData,",
      "getTasksMission: () => TasksMission,",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
  });

  await test("автозадачи: границы модуля — оболочка только живыми доступами", () => {
    // Пояснения в комментариях не считаем: проверяем код.
    const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const live = code.replace(/\bget(Settings|Streaming|ChatsData|TasksMission)\(\)/g, "@live@");
    for (const bare of ["settings", "streaming", "chatsData", "TasksMission"]) {
      assert.ok(!new RegExp("(^|[^\\w$\\.\"'])" + bare + "\\b").test(live), "модуль читает оболочку напрямую: " + bare);
    }
    for (const live of ["getSettings()", "getStreaming()", "getChatsData()", "getTasksMission()"]) {
      assert.ok(MODULE_SRC.includes(live), "модуль не пользуется живым доступом " + live);
    }
    assert.ok(!/localStorage|\bwindow\b/.test(code), "модуль лезет в чужие глобалы");
  });

  console.log("\n[2] «▶ Сейчас»: кнопка в строке дела");

  await test("автозадачи: «▶ сейчас» в браузере честно отказывает, при занятом агенте ждёт", () => {
    const web = buildAutoTasks({ isElectron: false });
    web.tasks.startAutoRunNow(task());
    assert.ok(web.calls.run.length === 0, "в браузере автозадача всё-таки побежала");
    assert.ok(/на ПК/.test(web.calls.toast[web.calls.toast.length - 1] || ""), "нет честного отказа в веб-режиме: " + web.calls.toast);

    const offTask = buildAutoTasks();
    offTask.tasks.startAutoRunNow(task({ auto: false }));
    assert.ok(offTask.calls.run.length === 0, "прогон без отметки «▶ агент» всё-таки пошёл");
    assert.ok(/включи/.test(offTask.calls.toast[offTask.calls.toast.length - 1] || ""), "нет подсказки про «▶ агент»: " + offTask.calls.toast);

    const busy = buildAutoTasks({ streaming: true });
    busy.tasks.startAutoRunNow(task());
    assert.ok(busy.calls.run.length === 0, "при идущем прогоне автозадача влезла второй");
    assert.ok(/занят/.test(busy.calls.toast[busy.calls.toast.length - 1] || ""), "про занятость не сказано: " + busy.calls.toast);
    assert.deepStrictEqual(busy.calls.ack, [], "ручной прогон что-то подтвердил планировщику");
  });

  await test("автозадачи: без модели прогон отложен, планировщик об этом знает", async () => {
    const env = buildAutoTasks({ settings: { model: "" } });
    // Дело приходит по сроку — это путь планировщика, а не кнопки: ему и отвечаем.
    env.tasks.autoQueue.push(task({ manual: false }));
    env.tasks.flushAutoQueue();
    await tick();
    assert.ok(env.calls.run.length === 0, "без модели прогон всё-таки пошёл");
    assert.deepStrictEqual(env.calls.ack, [{ id: "t1", ok: false, err: "не выбрана модель" }],
      "планировщик не получил отказ: " + JSON.stringify(env.calls.ack));
    assert.strictEqual(env.calls.selected.length, 0, "без модели окно всё равно переключилось на чат автозадач");
    assert.ok(/не выбрана модель/.test(env.calls.toast.join(" | ")), "человеку не сказано о причине: " + env.calls.toast);
  });

  console.log("\n[3] Прогон автозадачи: чат, подтверждение и исходы");

  await test("автозадачи: прогон заводит чат «Автозадачи» и подтверждает срок", async () => {
    const env = buildAutoTasks();
    env.tasks.autoQueue.push(task({ manual: false }));
    env.tasks.flushAutoQueue();
    await tick();
    const chat = env.state.chatsData.chats[0];
    assert.ok(chat && chat.auto === true, "чат автозадач не помечен своим");
    assert.strictEqual(chat.title, "Автозадачи", "у чата автозадач другое имя");
    assert.strictEqual(chat.role, "manager", "у чата автозадач не та роль: " + chat.role);
    assert.ok(/Это чат автозадач/.test(chat.messages.map((m) => m.content).join(" ")), "в чате нет пояснения");
    assert.deepStrictEqual(env.calls.selected, ["auto-chat"], "окно не переключилось на чат автозадач");
    assert.deepStrictEqual(env.calls.ack, [{ id: "t1", ok: true, err: "" }], "срок не подтверждён запуском");
    assert.strictEqual(env.calls.run.length, 1, "прогон не запущен ровно один раз");
    assert.ok(/Автозадача по сроку: «Позвонить в банк»/.test(env.calls.run[0].text), "текст прогона потерял дело: " + env.calls.run[0].text);
    assert.ok(/Выполни это дело и кратко напиши результат\./.test(env.calls.run[0].text), "у дела без просьбы нет понятной подсказки");
    assert.deepStrictEqual(env.calls.done, ["t1"], "разовое дело не закрылось после прогона");
    // Прогон по сроку — не просьба человека: «сдался» он не снимает.
    assert.deepStrictEqual(env.calls.rearm, [], "прогон по сроку снял «сдался» без повода");
    assert.strictEqual(env.counters().rendered, 1, "список дел в панели не обновился");
  });

  await test("автозадачи: второй чат не заводится, выбранный не переключается", async () => {
    const env = buildAutoTasks({ chatsData: { chats: [{ id: "c9", auto: true, messages: [] }], activeId: "c9" } });
    env.tasks.startAutoRunNow(task({ repeat: "каждый день" }));
    await tick();
    assert.strictEqual(env.counters().created, 0, "завёлся второй чат автозадач");
    assert.deepStrictEqual(env.calls.selected, [], "окно дёрнуло выбор чата зря");
    assert.strictEqual(env.counters().persisted, 0, "история переписана без изменений");
    assert.deepStrictEqual(env.calls.done, [], "дело с повтором закрыто после прогона");
  });

  await test("автозадачи: сорвавшийся прогон открывает срок заново", async () => {
    const env = buildAutoTasks({ runThrows: new Error("нет сети") });
    env.tasks.autoQueue.push(task({ manual: false }));
    env.tasks.flushAutoQueue();
    await tick();
    assert.deepStrictEqual(env.calls.ack, [
      { id: "t1", ok: true, err: "" },
      { id: "t1", ok: false, err: "прогон сорвался: нет сети" },
    ], "планировщик не узнал о срыве: " + JSON.stringify(env.calls.ack));
    assert.ok(/сорвалась/.test(env.calls.toast.join(" | ")), "человеку не сказано о срыве: " + env.calls.toast);
    assert.deepStrictEqual(env.calls.done, [], "сорвавшееся дело всё-таки закрыто");
    assert.deepStrictEqual(env.calls.rearm, [], "сорвавшееся дело сняло «сдался»");
  });

  await test("автозадачи: ошибка ответа не закрывает дело, ручной прогон снимает «сдался»", async () => {
    const bad = buildAutoTasks({ runResult: { id: "m1", error: "лимит" } });
    bad.tasks.startAutoRunNow(task());
    await tick();
    assert.ok(/не выполнилась/.test(bad.calls.toast.join(" | ")), "о неудаче прогона не сказано: " + bad.calls.toast);
    assert.deepStrictEqual(bad.calls.done, [], "дело закрыто, хотя прогон не удался");
    assert.deepStrictEqual(bad.calls.rearm, [], "«сдался» снят при неудаче");

    const ok = buildAutoTasks();
    ok.tasks.startAutoRunNow(task());
    await tick();
    assert.deepStrictEqual(ok.calls.rearm, ["t1"], "ручной прогон не снял «сдался»: " + JSON.stringify(ok.calls.rearm));
    assert.strictEqual(ok.counters().rendered, 2, "панель не обновилась после закрытия и снятия «сдался»");
  });

  await test("автозадачи: пока идёт прогон, дело ждёт своей очереди", async () => {
    const env = buildAutoTasks({ streaming: true });
    env.tasks.startAutoRunNow(task());
    env.tasks.autoQueue.push(task({ id: "t2", manual: false }));
    env.tasks.flushAutoQueue();
    await tick();
    assert.strictEqual(env.calls.run.length, 0, "очередь запустилась во время чужого прогона");
    assert.strictEqual(env.tasks.autoQueue.length, 1, "дело потерялось, пока ждало своей очереди");

    env.state.streaming = false;
    env.tasks.flushAutoQueue();
    await tick();
    assert.strictEqual(env.calls.run.length, 1, "после прогона очередь не разобралась");
    assert.strictEqual(env.tasks.autoQueue.length, 0, "очередь не отдала дело к запуску");
    assert.ok(/Позвонить в банк/.test(env.calls.run[0].text), "из очереди побежало не то дело");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

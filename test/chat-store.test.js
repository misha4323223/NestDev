"use strict";

/* ── Хранилище: настройки, история чатов, автосохранение (src/renderer/chat-store.js)
   Запуск: node test/chat-store.test.js   (входит в общий `npm test`)

   Модуль вынесен из app.js (этап A, часть 7). Это место, где ошибка стоит дороже всего:
   испорченная чистка истории ломает уже сохранённые чаты у человека, а сломанное
   автосохранение молча теряет ответ, если окно закрыть посреди генерации. Поэтому здесь
   проверяется настоящий модуль целиком:

     • загрузка с диска (Electron) и из localStorage (браузер);
     • чистка истории после аварийного закрытия: снятые флаги pending, «…» вместо пустого
       ответа, пояснение «ответ был прерван» только в активном чате;
     • битые данные не роняют запуск (битый plan, чужой planHistory, мусор вместо чатов);
     • запись настроек и истории в обе среды;
     • автосохранение: «не чаще раза в 1.5 c», немедленная запись, сброс при закрытии окна
       (в том числе синхронным каналом), и «нечего писать — не пишем».

   Заглушки времени и хранилища под контролем теста: проверяется не «функция есть», а что
   именно и сколько раз ушло на диск. */

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
const MODULE_SRC = read("src", "renderer", "chat-store.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет».
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");

function buildStore(opts) {
  const o = opts || {};
  const state = {
    settings: o.settings || { model: "m1", activeProjectId: "" },
    chatsData: o.chatsData || { chats: [], activeId: null },
    session: o.session === undefined ? null : o.session,
    remoteRunNotified: !!o.remoteRunNotified,
  };
  const log = { apiSettings: [], saved: [], savedSync: [], loaded: 0, normalized: [], toasts: [], sidebar: 0, messages: 0, projectRefreshes: 0, remoteResets: 0 };
  const ls = new Map(o.ls || []);
  const lsWrites = [];
  const timers = [];
  const events = { window: {}, document: {} };
  let timerId = 0;

  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => { ls.set(k, String(v)); lsWrites.push(k); },
    removeItem: (k) => { ls.delete(k); },
  };
  const win = { addEventListener: (t, fn) => { events.window[t] = fn; } };
  const doc = { visibilityState: "visible", addEventListener: (t, fn) => { events.document[t] = fn; } };

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
    localStorage, window: win, document: doc,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ id, fn, ms, dead: false }); return id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
  };

  const api = {
    getSettings: () => Promise.resolve(o.diskSettings !== undefined ? o.diskSettings : { ...state.settings }),
    loadChats: () => {
      log.loaded++;
      if (o.loadChatsThrows) return Promise.reject(new Error("файл занят"));
      return Promise.resolve(o.diskChats !== undefined ? o.diskChats : state.chatsData);
    },
    setSettings: (s) => { log.apiSettings.push(s); },
    saveChats: (c) => { log.saved.push(c); },
  };
  if (o.saveChatsSync !== false) {
    api.saveChatsSync = (c) => { if (o.saveChatsSyncThrows) throw new Error("не удалось записать синхронно"); log.savedSync.push(c); };
  }

  vm.runInNewContext(MODULE_SRC, box, { filename: "chat-store.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
  const store = box.module.exports({
    isElectron: !!o.isElectron,
    api,
    AgentCore: o.AgentCore || { normalizePlanTasks: (items) => (Array.isArray(items) ? items.filter((t) => t && t.text) : []) },
    normalize: (raw) => { log.normalized.push(raw); return { ...(raw || {}), model: "нормализовано" }; },
    getSettings: () => state.settings,
    setSettings: (s) => { state.settings = s; },
    getChatsData: () => state.chatsData,
    setChatsData: (c) => { state.chatsData = c; },
    getPlanArchiveLimit: () => (o.planArchiveLimit === undefined ? 5 : o.planArchiveLimit),
    getSession: () => state.session,
    setRemoteRunNotified: (v) => { state.remoteRunNotified = v; log.remoteResets++; },
    renderSidebar: () => { log.sidebar++; },
    renderMessages: () => { log.messages++; },
    toast: (t) => log.toasts.push(t),
    getProjectPanel: () => ({
      refreshProject: () => {
        log.projectRefreshes++;
        if (o.projectRefreshThrows) throw new Error("панель проекта занята");
      },
    }),
  });

  return {
    store, state, log, ls, lsWrites, events, timers,
    runTimers: () => timers.splice(0).forEach((t) => { if (!t.dead) t.fn(); }),
    setVisibility: (v) => { doc.visibilityState = v; },
    fire: (where, type, ev) => { const fn = events[where][type]; assert.ok(fn, "событие не навешено: " + where + "." + type); return fn(ev); },
  };
}

const assistant = (over) => ({ id: "m1", role: "assistant", content: "", ...(over || {}) });
// Объекты из модуля живут в своей песочнице: strictEqual их не породняет (чужие прототипы),
// поэтому сравниваем по содержимому.
const plain = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("хранилище: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="chat-store.js"');
    assert.ok(tag > 0, "разметка не грузит chat-store.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "chat-store.js подключён после app.js");
    assert.ok(/"chat-store\.js"/.test(BRIDGE_SRC), "мост не отдаёт chat-store.js телефону");
    assert.ok(/window\.ChatStore\(\{/.test(APP_SRC), "в оболочке нет сборки модуля");
  });

  await test("хранилище: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "function loadState", "function sanitizeChats", "function persistSettings",
      "function flushChats", "let chatsSavePending", "const CHATS_SAVE_INTERVAL",
      'window.addEventListener("beforeunload"',
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код хранилища остался в app.js: " + gone);
    }
    assert.ok(APP_SRC.includes("ChatStore.loadState().then(("), "старт окна не грузит состояние через модуль");
    assert.ok(APP_SRC.includes("ChatStore.wire();"), "сброс при закрытии окна не подключён");
    assert.ok(APP_SRC.includes("ChatStore.persistChatsSoon,"), "живая запись «скоро» не уходит потребителям");
    // Синхронизация истории (chats:reload) переехала в этот же модуль (этап A, часть 10):
    // спрашиваем модуль, а у оболочки — только подписку на событие.
    assert.ok(MODULE_SRC.includes("if (getSession() || getChatsSavePending()) return;"), "синхронизация истории не спрашивает о своём прогоне и несохранённых правках");
    assert.ok(APP_SRC.includes("api.onChatsReload(() => ChatStore.reloadChatsFromDisk())"), "окно не подписано на chats:reload");

    const build = APP_SRC.indexOf("  const ChatStore = window.ChatStore({");
    assert.ok(build > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    for (const dep of ["isElectron: isElectron,", "api: api,", "normalize: normalize,", "getSettings: () => settings,", "setSettings: (s) => { settings = s; }", "getChatsData: () => chatsData,", "setChatsData: (c) => { chatsData = c; }", "getPlanArchiveLimit: () => PLAN_ARCHIVE_LIMIT,", "getSession: () => session,", "setRemoteRunNotified: (v) => { remoteRunNotified = v; },", "renderSidebar: renderSidebar,", "renderMessages: renderMessages,", "getProjectPanel: () => ProjectPanel,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
  });

  console.log("\n[2] Загрузка состояния");

  await test("хранилище: загрузка в Electron читает диск, чистит историю и пишет обратно", async () => {
    const env = buildStore({
      isElectron: true,
      diskSettings: { model: "из файла" },
      diskChats: { chats: [{ id: "c1", messages: [assistant({ pending: true })] }], activeId: "c1" },
    });
    await env.store.loadState();
    assert.strictEqual(env.log.normalized.length, 1, "настройки не прошли нормализатор");
    assert.strictEqual(env.state.settings.model, "нормализовано", "настройки не записаны в окно");
    assert.strictEqual(env.state.chatsData.chats[0].messages[0].pending, false, "флаг «выполняется» не снят");
    assert.strictEqual(env.state.chatsData.chats[0].messages[0].content, "…", "пустой ответ не заменён на «…»");
    assert.strictEqual(env.log.saved.length, 1, "очищенная история не записана обратно на диск");
    assert.strictEqual(env.log.loaded, 1, "файл чатов прочитан не один раз");
  });

  await test("хранилище: загрузка без диска берёт localStorage и не падает на мусоре", async () => {
    const env = buildStore({
      isElectron: false,
      ls: [["settings", "{не json"], ["chats", JSON.stringify({ chats: [{ id: "c1", messages: [] }], activeId: "c1" })]],
    });
    await env.store.loadState();
    assert.strictEqual(env.log.loaded, 0, "в браузере полезли на диск");
    assert.strictEqual(env.state.chatsData.activeId, "c1", "история из localStorage не прочитана");
    assert.strictEqual(env.log.apiSettings.length, 0, "в браузере писали настройки через мост");

    // Совсем пустое хранилище — тоже не повод не стартовать.
    const empty = buildStore({ isElectron: false });
    await empty.store.loadState();
    assert.deepStrictEqual(plain(empty.state.chatsData), { chats: [], activeId: null }, "пустое хранилище дало не ту форму");
  });

  console.log("\n[3] Чистка истории после аварийного закрытия");

  await test("хранилище: прерванный ответ получает пояснение только в активном чате", () => {
    const env = buildStore({});
    const d = env.store.sanitizeChats({
      chats: [
        { id: "a", messages: [assistant({ pending: true })] },
        { id: "b", messages: [assistant({ pending: true })] },
      ],
      activeId: "a",
    });
    assert.strictEqual(d.chats[0].messages.length, 2, "в активном чате нет пояснения о прерывании");
    const note = d.chats[0].messages[1];
    assert.strictEqual(note.role, "system", "пояснение добавлено не системной заметкой");
    assert.ok(/прерван/.test(note.content), "пояснение не объясняет, что ответ прерван");
    assert.strictEqual(note.interrupted, true, "пояснение не помечено как восстановленное");
    assert.strictEqual(d.chats[1].messages.length, 1, "в неактивный чат добавили пояснение");

    // Сохранённая часть ответа не трогается, пояснения нет — восстанавливать нечего.
    const clean = env.store.sanitizeChats({ chats: [{ id: "a", messages: [assistant({ content: "готовый ответ" })] }], activeId: "a" });
    assert.strictEqual(clean.chats[0].messages.length, 1, "пояснение добавили без прерванного ответа");
    assert.strictEqual(clean.chats[0].messages[0].content, "готовый ответ", "готовый ответ испорчен");
  });

  await test("хранилище: незавершённое действие объясняется словами, а не висит", () => {
    const env = buildStore({});
    const d = env.store.sanitizeChats({ chats: [{ id: "a", messages: [{ id: "t1", role: "tool", pending: true }] }], activeId: "a" });
    const m = d.chats[0].messages[0];
    assert.strictEqual(m.pending, false, "флаг «выполняется» остался на действии");
    assert.strictEqual(m.toolOk, false, "незавершённое действие не помечено неуспешным");
    assert.ok(/не завершилось/.test(m.toolResult), "у действия нет пояснения: " + JSON.stringify(m.toolResult));

    // У действия уже был результат — его не затираем.
    const kept = env.store.sanitizeChats({ chats: [{ id: "a", messages: [{ id: "t1", role: "tool", pending: true, toolResult: "готово", toolOk: true }] }], activeId: "a" });
    assert.strictEqual(kept.chats[0].messages[0].toolResult, "готово", "готовый результат действия затёрт");
    assert.strictEqual(kept.chats[0].messages[0].toolOk, true, "готовый результат действия испорчен");
  });

  await test("хранилище: битые чаты, планы и мусор вместо истории не роняют запуск", () => {
    const env = buildStore({ planArchiveLimit: 3 });
    const d = env.store.sanitizeChats({
      chats: [
        { id: "a", messages: null, plan: { title: "План", source: "model", items: [{ text: "п.1" }] }, planHistory: [1, 2, 3, 4, 5, 6] },
      ],
      activeId: "a",
    });
    assert.deepStrictEqual(plain(d.chats[0].messages), [], "не-массив сообщений не приведён к пустому списку");
    assert.strictEqual(d.chats[0].planHistory.length, 3, "история планов не обрезана пределом");
    assert.strictEqual(d.chats[0].plan.items.length, 1, "план чата вычищен без причины");

    // Ядро не поняло план (старый формат, ручная правка файла) — чат остаётся работоспособным.
    const broken = buildStore({ planArchiveLimit: 3, AgentCore: { normalizePlanTasks: () => { throw new Error("ядро не поняло план"); } } });
    const bd = broken.store.sanitizeChats({ chats: [{ id: "a", messages: [], plan: { items: [{ text: "п.1" }] }, planHistory: [1, 2] }], activeId: "a" });
    assert.strictEqual(bd.chats[0].plan, null, "битый план не вычищен");
    assert.strictEqual(bd.chats[0].planHistory.length, 0, "битый план оставил за собой историю");

    // Форму чатов без плана не меняем: иначе каждый запуск переписывал бы весь файл истории.
    const bare = env.store.sanitizeChats({ chats: [{ id: "a", messages: [] }], activeId: "a" });
    assert.ok(!("plan" in bare.chats[0]), "чату без плана добавили поле plan");

    // Совсем мусор возвращается как есть — без падения и без выдумок.
    assert.deepStrictEqual(plain(env.store.sanitizeChats(null)), { chats: [], activeId: null }, "null не дал безопасную форму");
    assert.deepStrictEqual(plain(env.store.sanitizeChats({ chats: "нет" })), { chats: "нет" }, "непонятные данные переписаны");
  });

  console.log("\n[4] Запись настроек и истории");

  await test("хранилище: настройки пишутся на диск или в localStorage и читаются живыми", () => {
    const disk = buildStore({ isElectron: true });
    disk.store.persistSettings();
    assert.deepStrictEqual(disk.log.apiSettings[0], disk.state.settings, "в файл ушёл не текущий объект настроек");

    const web = buildStore({ isElectron: false });
    web.store.persistSettings();
    assert.strictEqual(web.lsWrites[web.lsWrites.length - 1], "settings", "в браузере настройки записаны не под своим ключом");
    assert.deepStrictEqual(JSON.parse(web.ls.get("settings")), web.state.settings, "в localStorage ушли не текущие настройки");
  });

  await test("хранилище: история чатов пишется из живых данных, а не из копии", () => {
    const env = buildStore({ isElectron: true });
    env.store.persistChats();
    assert.deepStrictEqual(env.log.saved[0], env.state.chatsData, "на диск ушла не текущая история");

    // Дальше историю переписывают целиком (ответ с телефона, загрузка с диска) — писали бы копию, потеряли бы её.
    env.state.chatsData = { chats: [{ id: "новый", messages: [] }], activeId: "новый" };
    env.store.persistChats();
    assert.deepStrictEqual(env.log.saved[1].activeId, "новый", "записалась устаревшая история");
  });

  console.log("\n[5] Автосохранение и сброс при закрытии окна");

  await test("хранилище: частые правки сливаются в одну запись раз в 1.5 c", () => {
    const env = buildStore({ isElectron: true });
    env.store.persistChatsSoon();
    env.store.persistChatsSoon();
    env.store.persistChatsSoon();
    assert.strictEqual(env.log.saved.length, 0, "запись случилась сразу, без ожидания");
    assert.strictEqual(env.timers.length, 1, "на каждую правку завели свой таймер");
    assert.strictEqual(env.timers[0].ms, 1500, "интервал автосохранения не 1.5 c: " + env.timers[0].ms);
    env.runTimers();
    assert.strictEqual(env.log.saved.length, 1, "слитые правки записаны не одной записью");

    // После срабатывания автосохранение снова готово к работе.
    env.store.persistChatsSoon();
    env.runTimers();
    assert.strictEqual(env.log.saved.length, 2, "после первой записи автосохранение перестало работать");
  });

  await test("хранилище: «сейчас» пишет немедленно и снимает отложенную запись", () => {
    const env = buildStore({ isElectron: true });
    env.store.persistChatsSoon();
    env.store.persistChatsNow();
    assert.strictEqual(env.log.saved.length, 1, "немедленной записи не было");
    assert.strictEqual(env.store.getChatsSavePending(), false, "после записи остались несохранённые правки");
    env.runTimers();
    assert.strictEqual(env.log.saved.length, 1, "отложенный таймер дописал историю второй раз");
  });

  await test("хранилище: закрытие окна сбрасывает данные, а без правок — не пишет", () => {
    const env = buildStore({ isElectron: true });
    env.store.wire();
    assert.ok(env.events.window.beforeunload && env.events.window.pagehide, "сброс не навешен на закрытие окна");
    assert.ok(env.events.document.visibilitychange, "сброс не навешен на сворачивание окна");

    env.fire("window", "beforeunload");
    assert.strictEqual(env.log.saved.length + env.log.savedSync.length, 0, "писать было нечего, а запись случилась");

    env.store.persistChatsSoon();
    env.fire("window", "beforeunload");
    assert.strictEqual(env.log.savedSync.length, 1, "при закрытии окна не использован синхронный канал");
    assert.strictEqual(env.log.saved.length, 0, "при закрытии окна история ушла и обычным путём");

    // Сворачивание окна тоже сбрасывает, а возвращение — нет.
    const hidden = buildStore({ isElectron: true });
    hidden.store.wire();
    hidden.store.persistChatsSoon();
    hidden.setVisibility("visible");
    hidden.fire("document", "visibilitychange");
    assert.strictEqual(hidden.log.savedSync.length, 0, "сброс случился при видимом окне");
    hidden.setVisibility("hidden");
    hidden.fire("document", "visibilitychange");
    assert.strictEqual(hidden.log.savedSync.length, 1, "сворачивание окна не сбросило данные");
  });

  await test("хранилище: при сбое синхронного канала данные не теряются", () => {
    const env = buildStore({ isElectron: true, saveChatsSyncThrows: true });
    env.store.wire();
    env.store.persistChatsSoon();
    env.fire("window", "beforeunload");
    assert.strictEqual(env.log.saved.length, 1, "после сбоя синхронной записи история не ушла обычным путём");

    // Канала нет вовсе — тоже пишем обычным путём.
    const noChan = buildStore({ isElectron: true, saveChatsSync: false });
    noChan.store.wire();
    noChan.store.persistChatsSoon();
    noChan.fire("window", "pagehide");
    assert.strictEqual(noChan.log.saved.length, 1, "без синхронного канала история не записана");
  });

  console.log("\n[6] Синхронизация истории с другого устройства (chats:reload)");

  await test("синхронизация: файл перечитан, окно и панель проекта обновлены", async () => {
    const disk = { chats: [{ id: "c1", title: "с телефона", messages: [] }, { id: "c2", title: "второй", messages: [] }], activeId: "c1" };
    const env = buildStore({ isElectron: true, diskChats: disk, remoteRunNotified: true });
    await env.store.reloadChatsFromDisk();
    assert.strictEqual(env.state.chatsData.chats.length, 2, "история с диска не подхвачена");
    assert.strictEqual(env.state.chatsData.activeId, "c1", "активный чат с диска потерян");
    assert.strictEqual(env.log.sidebar, 1, "список чатов не перерисован");
    assert.strictEqual(env.log.messages, 1, "лента не перерисована");
    assert.strictEqual(env.log.projectRefreshes, 1, "панель проекта не обновлена");
    assert.deepStrictEqual(env.log.toasts, ["📱 История обновлена с другого устройства"], "обновление не объяснено человеку");
    assert.strictEqual(env.state.remoteRunNotified, false, "признак «про чужой прогон сказали» не сброшен");
  });

  await test("синхронизация: свой прогон и несохранённые правки отменяют перезагрузку", async () => {
    // Идёт свой прогон агента: перезагрузка потеряла бы ответ, который сейчас пишется.
    const busy = buildStore({ isElectron: true, session: { chatId: "c1", assistantId: "m1", segmentIds: [] }, diskChats: { chats: [{ id: "cX", messages: [] }], activeId: "cX" } });
    await busy.store.reloadChatsFromDisk();
    assert.strictEqual(busy.log.loaded, 0, "во время своего прогона история всё-таки перечитана");
    assert.strictEqual(busy.log.sidebar, 0, "окно перерисовано без перезагрузки");

    // Есть несохранённые правки — они ещё не на диске, терять их нельзя.
    const pending = buildStore({ isElectron: true, diskChats: { chats: [{ id: "cX", messages: [] }], activeId: "cX" } });
    pending.store.persistChatsSoon();
    await pending.store.reloadChatsFromDisk();
    assert.strictEqual(pending.log.loaded, 0, "несохранённые правки потеряны перезагрузкой");
    assert.strictEqual(pending.state.chatsData.chats.length, 0, "история перезаписана поверх несохранённой");
  });

  await test("синхронизация: в браузере, при сбое чтения и мусоре ничего не ломается", async () => {
    const web = buildStore({ isElectron: false, diskChats: { chats: [{ id: "cX", messages: [] }], activeId: "cX" } });
    await web.store.reloadChatsFromDisk();
    assert.strictEqual(web.log.loaded, 0, "в браузере полезли за файлом истории");

    const broken = buildStore({ isElectron: true, loadChatsThrows: true });
    await assert.doesNotReject(() => broken.store.reloadChatsFromDisk(), "сбой чтения файла уронил синхронизацию");
    assert.strictEqual(broken.log.messages, 0, "окно перерисовано после неудачного чтения");

    const junk = buildStore({ isElectron: true, diskChats: { chats: "это не список" } });
    await junk.store.reloadChatsFromDisk();
    assert.strictEqual(junk.log.sidebar, 0, "мусор с диска принят за историю");
    assert.strictEqual(junk.log.toasts.length, 0, "о мусоре сказали как об обновлении");
  });

  await test("синхронизация: упавшая панель проекта не отменяет обновление истории", async () => {
    const env = buildStore({ isElectron: true, projectRefreshThrows: true, diskChats: { chats: [{ id: "cX", messages: [] }], activeId: "cX" } });
    await assert.doesNotReject(() => env.store.reloadChatsFromDisk(), "сбой панели проекта уронил синхронизацию");
    assert.strictEqual(env.state.chatsData.chats.length, 1, "история не подхвачена из-за панели проекта");
    assert.strictEqual(env.log.toasts.length, 1, "человек не узнал, что история обновилась");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

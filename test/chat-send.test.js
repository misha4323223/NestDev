"use strict";

/* ── Отправка: ход агента, обычная отправка и досылка прерванного ответа ──────
   Запуск: node test/chat-send.test.js   (входит в общий `npm test`)

   Модуль вынесен из app.js (этап A, часть 9). Это ядро чата: один прогон агента
   (`runTurn`) на все входы — кнопку «Отправить», автозадачу планировщика и кнопку
   «Выполнить план». Тихие поломки здесь самые дорогие: не уходит запрос, история
   теряет пару «пользователь → ответ», сессия не сбрасывается после прогона и
   следующий ответ агента уходит не в тот пузырь, а автозадача так и не запускается.

   Проверяется НАСТОЯЩИЙ модуль: те же зависимости, что даёт оболочка, но разметка,
   сеть и хранилище — игрушечные, и видно, что именно и сколько раз произошло. */

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
const MODULE_SRC = read("src", "renderer", "chat-send.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет».
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");

function makeEl(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    className: "",
    value: "",
    children: [],
    classList: {
      has: (c) => el.className.split(/\s+/).includes(c),
      add: (c) => { if (!el.classList.has(c)) el.className = (el.className + " " + c).trim(); },
      remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => el.classList.has(c),
    },
    appendChild(ch) { el.children.push(ch); return ch; },
  };
  return el;
}

function buildChatSend(opts) {
  const o = opts || {};
  const log = {
    toasts: [], sidebar: 0, persistChats: 0, scroll: 0, setStreaming: [],
    finishStream: [], flushed: 0, autoResize: 0, hideAttach: 0, selectChat: [],
    settingsMsg: [], openedSettings: [], planRendered: 0, events: [],
    sent: [], webSent: [], created: 0,
  };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl("div", id));
    return els.get(id);
  };

  const state = {
    streaming: false,
    planToggleOn: false,
    pendingImage: o.pendingImage === undefined ? null : o.pendingImage,
    lastUndoCount: 3,
    session: "старая сессия",
    webAbort: "старый обрыв",
  };
  const settings = { model: o.model === undefined ? "llama-3" : o.model };
  const chatsData = { chats: o.chats || [], activeId: o.activeId || null };

  const uidSeq = { n: 0 };
  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    AbortController,
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "chat-send.js" });
  const mod = box.module.exports;

  const api = {
    sendMessage: (history, meta) => {
      log.sent.push({ history, meta });
      if (o.apiError) return Promise.reject(new Error(o.apiError));
      return Promise.resolve();
    },
  };

  const wired = mod({
    $,
    isElectron: !!o.isElectron,
    api,
    uid: () => "id" + (++uidSeq.n),
    toast: (t) => log.toasts.push(t),
    renderSidebar: () => { log.sidebar++; },
    buildMessageEl: (m) => makeEl("div", m.id),
    autoResize: () => { log.autoResize++; },
    hideAttachBar: () => { log.hideAttach++; },
    // Как в оболочке: выбор чата делается ТЕМ ЖЕ списком чатов, иначе отправка
    // ушла бы в другой чат или завела новый.
    selectChat: (id) => {
      log.selectChat.push(id);
      if (state.streaming) return;
      chatsData.activeId = id;
    },
    getActiveChat: () => chatsData.chats.find((c) => c.id === chatsData.activeId) || null,
    createChat: () => {
      log.created++;
      const c = { id: "chat-new", title: "Новый чат", messages: [] };
      chatsData.chats.unshift(c);
      chatsData.activeId = c.id;
      return c;
    },
    getSettings: () => settings,
    getChatsData: () => chatsData,
    getStreaming: () => state.streaming,
    getPlanToggleOn: () => state.planToggleOn,
    setPlanToggleOn: (v) => { state.planToggleOn = v; },
    getPendingImage: () => state.pendingImage,
    setLastUndoCount: (v) => { state.lastUndoCount = v; },
    setSession: (v) => { state.session = v; },
    getWebAbort: () => state.webAbort,
    setWebAbort: (v) => { state.webAbort = v; },
    getChatFeed: () => ({ scrollBottom: () => { log.scroll++; } }),
    getPlanPanel: () => ({
      planRotate: (chat) => (o.planRotate ? o.planRotate(chat) : false),
      renderPlanPanel: () => { log.planRendered++; },
    }),
    getSettingsPanel: () => ({
      openSettings: (tab) => log.openedSettings.push(tab),
      setSettingsMsg: (t, bad) => log.settingsMsg.push({ t, bad }),
    }),
    getChatEvents: () => ({ onAiEvent: (e) => log.events.push(e) }),
    getChatRun: () => ({
      setStreaming: (v) => log.setStreaming.push(v),
      finishStream: (chat, msg) => log.finishStream.push({ chat, msg }),
    }),
    getAutoTasks: () => ({ flushAutoQueue: () => { log.flushed++; } }),
    getWebChat: () => ({
      webSend: (history, onEvent, signal, meta) => {
        log.webSent.push({ history, onEvent, signal, meta });
        if (o.webError) return Promise.reject(Object.assign(new Error(o.webError), { name: o.webErrorName || "Error" }));
        return Promise.resolve();
      },
    }),
    ChatStore: { persistChats: () => { log.persistChats++; } },
  });

  return { mod: wired, state, log, $, els, settings, chatsData, io: uidSeq };
}

function makeChat(title) {
  return { id: "chat1", title: title === undefined ? "Новый чат" : title, messages: [] };
}

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("отправка: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="chat-send.js"');
    assert.ok(tag > 0, "разметка не грузит chat-send.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "chat-send.js подключён после app.js");
    assert.ok(/"chat-send\.js"/.test(BRIDGE_SRC), "мост не отдаёт chat-send.js телефону");
    assert.ok(/window\.ChatSend\(\{/.test(APP_SRC), "в оболочке нет сборки модуля");
  });

  await test("отправка: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "async function sendMessage", "async function runTurn", "function continueInterruptedAnswer",
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код отправки остался в app.js: " + gone);
    }
    for (const call of [
      '$("btn-send").onclick = ChatSend.sendMessage;',
      "runTurn: ChatSend.runTurn,",
      "continueInterruptedAnswer: ChatSend.continueInterruptedAnswer,",
      "      ChatSend.sendMessage();",
      "        ChatSend.sendMessage();",
    ]) {
      assert.ok(APP_SRC.includes(call), "вызов не переименован: " + call);
    }
    const build = APP_SRC.indexOf("  const ChatSend = window.ChatSend({");
    assert.ok(build > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    for (const dep of [
      "getSettings: () => settings,", "getChatsData: () => chatsData,",
      "getStreaming: () => streaming,", "getPlanToggleOn: () => planToggleOn,",
      "setPlanToggleOn: (v) => { planToggleOn = v; },",
      "getPendingImage: () => pendingImage,",
      "setLastUndoCount: (v) => { lastUndoCount = v; },",
      "setSession: (v) => { session = v; },",
      "getWebAbort: () => webAbort,", "setWebAbort: (v) => { webAbort = v; },",
      "getChatFeed: () => ChatFeed,", "getPlanPanel: () => PlanPanel,",
      "getSettingsPanel: () => SettingsPanel,", "getChatEvents: () => ChatEvents,",
      "getChatRun: () => ChatRun,", "getAutoTasks: () => AutoTasks,",
      "getWebChat: () => WebChat,", "ChatStore: ChatStore,",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
    // Сборка стоит ВЫШЕ панели плана: та берёт sendMessage значением.
    const plan = APP_SRC.indexOf("  const PlanPanel = window.PlanPanel({");
    assert.ok(build < plan, "сборка отправки стоит ниже панели плана");
  });

  console.log("\n[2] Обычная отправка");

  await test("отправка: пустое поле и идущий прогон запрос не отправляют", async () => {
    const empty = buildChatSend({ chats: [makeChat()], activeId: "chat1" });
    await empty.mod.sendMessage();
    assert.strictEqual(empty.log.sent.length, 0, "пустое поле отправило запрос");
    assert.strictEqual(empty.log.sidebar, 0, "лента перерисована без запроса");

    const busy = buildChatSend({ chats: [makeChat()], activeId: "chat1" });
    busy.state.streaming = true;
    busy.$("input").value = "привет";
    await busy.mod.sendMessage();
    assert.strictEqual(busy.log.sent.length, 0, "во время прогона ушёл второй запрос");
  });

  await test("отправка: без модели объясняет в настройках и не запускает агента", async () => {
    const env = buildChatSend({ model: "", chats: [makeChat()], activeId: "chat1" });
    env.$("input").value = "создай файл";
    await env.mod.sendMessage();
    assert.strictEqual(env.log.sent.length, 0, "запрос ушёл без модели");
    assert.deepStrictEqual(env.log.openedSettings, ["model"], "настройки открыты не на модели");
    assert.strictEqual(env.log.settingsMsg.length, 1, "нет пояснения, почему не работает");
    assert.strictEqual(env.log.settingsMsg[0].bad, true, "пояснение показано как удача");
    // Поведение прежнее: счётчик отката обнуляется ещё до проверки модели (так было и в app.js).
    assert.strictEqual(env.state.lastUndoCount, 0, "счётчик отката не сброшен на попытке отправки");
  });

  await test("отправка: запрос, история и вид чата", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: "chat1" });
    env.$("input").value = "Сделай сайт с нуля и проверь запуск";
    await env.mod.sendMessage();

    assert.strictEqual(env.log.sent.length, 1, "запрос не ушёл или ушёл дважды");
    const sent = env.log.sent[0];
    assert.strictEqual(sent.history.length, 1, "в историю ушло не одно сообщение: " + sent.history.length);
    assert.strictEqual(sent.history[0].role, "user", "первое сообщение в истории не от пользователя");
    assert.strictEqual(sent.history[0].content, "Сделай сайт с нуля и проверь запуск", "текст запроса изменился");
    assert.strictEqual(sent.meta.plan, false, "обычный запрос ушёл как план");
    assert.strictEqual(sent.meta.role, "dev", "роль чата не передана");
    assert.strictEqual(sent.meta.chatId, "chat1", "чат не назван");

    assert.strictEqual(chat.messages.length, 2, "в чате не пара «запрос → ответ»");
    assert.strictEqual(chat.messages[0].role, "user", "нет сообщения пользователя");
    assert.strictEqual(chat.messages[1].role, "assistant", "нет места под ответ агента");
    assert.strictEqual(chat.messages[1].pending, true, "ответ не помечен как ожидающий");
    assert.strictEqual(chat.title, "Сделай сайт с нуля и проверь запуск", "имя чата не взято из запроса");
    assert.strictEqual(env.$("welcome").classList.contains("hidden"), true, "приветственный экран остался");
    assert.strictEqual(env.$("messages").children.length, 2, "в ленте не два сообщения");
    assert.strictEqual(env.log.scroll, 1, "лента не прокручена к новому сообщению");
    assert.strictEqual(env.log.persistChats, 1, "запрос не записан на диск");
    assert.strictEqual(env.$("input").value, "", "поле ввода не очищено");
    assert.strictEqual(env.log.autoResize, 1, "поле ввода не подогнано после очистки");
    assert.strictEqual(env.log.hideAttach, 1, "вложение не убрано после отправки");
    assert.strictEqual(env.state.lastUndoCount, 0, "счётчик отката не обнулён на новом запуске");
  });

  await test("отправка: длинное имя чата обрезается, короткое — нет", async () => {
    const long = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [long], activeId: "chat1" });
    env.$("input").value = "а".repeat(60);
    await env.mod.sendMessage();
    assert.strictEqual(long.title.length, 43, "длинное имя чата не обрезано: " + long.title.length);
    assert.strictEqual(long.title.slice(-1), "…", "у обрезанного имени нет многоточия");

    // Имя, уже данное человеком, отправка не переписывает.
    const named = makeChat("Мой чат");
    const env2 = buildChatSend({ isElectron: true, chats: [named], activeId: "chat1" });
    env2.$("input").value = "что-то новое";
    await env2.mod.sendMessage();
    assert.strictEqual(named.title, "Мой чат", "отправка переписала имя чата");
  });

  await test("отправка: скриншот уходит вложением, а не текстом", async () => {
    const env = buildChatSend({ isElectron: true, chats: [makeChat()], activeId: "chat1", pendingImage: "data:image/png;base64,AAA" });
    env.$("input").value = "посмотри на скриншот";
    await env.mod.sendMessage();
    const content = env.log.sent[0].history[0].content;
    assert.ok(Array.isArray(content), "вложение не собрано в части сообщения");
    // Сравниваем по полям: объект собран внутри модуля, у него своя область значений.
    assert.strictEqual(content[0].type, "text", "текст рядом с картинкой потерян");
    assert.strictEqual(content[0].text, "посмотри на скриншот", "текст рядом с картинкой изменился");
    assert.strictEqual(content[1].type, "image_url", "картинка не ушла как изображение");
    assert.strictEqual(content[1].image_url.url, "data:image/png;base64,AAA", "сам скриншот не ушёл");
  });

  await test("отправка: чата нет — создаётся новый", async () => {
    const env = buildChatSend({ isElectron: true, chats: [], activeId: null });
    env.$("input").value = "первое сообщение";
    await env.mod.sendMessage();
    assert.strictEqual(env.log.created, 1, "новый чат не заведён");
    assert.strictEqual(env.log.sent.length, 1, "запрос не ушёл из нового чата");
    assert.strictEqual(env.log.sent[0].meta.chatId, "chat-new", "запрос ушёл в чужой чат");
  });

  console.log("\n[3] Режим плана");

  await test("план: запрос уходит как план и режим выключается", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: "chat1" });
    env.state.planToggleOn = true;
    env.$("btn-plan").classList.add("active");
    env.$("input").value = "спланируй переезд";
    await env.mod.sendMessage();

    assert.strictEqual(env.log.sent[0].meta.plan, true, "запрос ушёл не в режиме плана");
    assert.strictEqual(chat.messages[1].plan, true, "ответ не помечен как план");
    assert.strictEqual(env.state.planToggleOn, false, "режим плана остался включённым на следующий запрос");
    assert.strictEqual(env.$("btn-plan").classList.contains("active"), false, "кнопка плана осталась нажатой");
  });

  await test("план: готовый план переворачивается и панель перерисовывается", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: "chat1", planRotate: () => true });
    env.$("input").value = "продолжай";
    await env.mod.sendMessage();
    assert.strictEqual(env.log.planRendered, 1, "панель плана не перерисована после переворота");
  });

  console.log("\n[4] Завершение прогона");

  await test("прогон: завершение сбрасывает сессию и будит автозадачи", async () => {
    const env = buildChatSend({ isElectron: true, chats: [makeChat()], activeId: "chat1" });
    env.$("input").value = "работай";
    const msg = await env.mod.sendMessage();

    assert.strictEqual(typeof msg, "undefined", "отправка вернула не то: " + typeof msg);
    assert.deepStrictEqual(env.log.setStreaming, [true], "признак прогона не выставлен (или выставлен дважды)");
    assert.strictEqual(env.log.finishStream.length, 1, "прогон не завершён");
    assert.strictEqual(env.state.session, null, "сессия не сброшена после прогона");
    assert.strictEqual(env.state.webAbort, null, "прерывание браузера не сброшено после прогона");
    assert.strictEqual(env.log.flushed, 1, "автозадача не разбужена после прогона");
  });

  await test("прогон: сессия ведёт в ответ этого чата", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: "chat1" });
    env.$("input").value = "работай";
    const p = env.mod.sendMessage();
    await Promise.resolve();
    assert.ok(env.state.session && env.state.session.chatId === "chat1", "сессия не указывает на чат прогона");
    assert.strictEqual(env.state.session.assistantId, chat.messages[1].id, "сессия не ведёт в пузырь ответа");
    assert.strictEqual(env.state.session.segmentIds.join(","), chat.messages[1].id, "сегменты ответа не начаты с первого");
    await p;
    assert.strictEqual(env.state.session, null, "сессия пережила прогон");
  });

  console.log("\n[5] Браузерный режим и срывы");

  await test("браузер: прогон идёт через веб-мост и его можно прервать", async () => {
    const env = buildChatSend({ chats: [makeChat()], activeId: "chat1" });
    env.$("input").value = "привет";
    await env.mod.sendMessage();
    assert.strictEqual(env.log.sent.length, 0, "в браузере дёрнули Electron-мост");
    assert.strictEqual(env.log.webSent.length, 1, "запрос не ушёл в веб-режим");
    const sig = env.log.webSent[0].signal;
    assert.ok(sig && typeof sig.aborted === "boolean", "нет объекта прерывания браузерного прогона");
    assert.strictEqual(sig.aborted, false, "прогон начат уже прерванным");
    assert.strictEqual(typeof env.log.webSent[0].onEvent, "function", "разбор событий агента не передан");
    assert.strictEqual(env.log.flushed, 1, "автозадача не разбужена после браузерного прогона");
  });

  await test("браузер: срыв прогона объясняется, прерывание — молча", async () => {
    const bad = buildChatSend({ chats: [makeChat()], activeId: "chat1", webError: "нет сети" });
    bad.$("input").value = "привет";
    await bad.mod.sendMessage();
    assert.strictEqual(bad.log.events.length, 1, "срыв прогона не показан в чате");
    assert.strictEqual(bad.log.events[0].type, "error", "срыв ушёл не как ошибка");
    assert.strictEqual(bad.log.events[0].message, "нет сети", "текст срыва изменился");

    const aborted = buildChatSend({ chats: [makeChat()], activeId: "chat1", webError: "стоп", webErrorName: "AbortError" });
    aborted.$("input").value = "привет";
    await aborted.mod.sendMessage();
    assert.strictEqual(aborted.log.events.length, 0, "остановка прогона показана как ошибка");
  });

  await test("прогон: ошибка Electron не съедает завершение", async () => {
    const env = buildChatSend({ isElectron: true, chats: [makeChat()], activeId: "chat1", apiError: "модель недоступна" });
    env.$("input").value = "привет";
    await assert.rejects(() => env.mod.sendMessage(), /модель недоступна/, "срыв прогона проглочен");
    assert.strictEqual(env.log.finishStream.length, 1, "прогон не завершён после срыва");
    assert.strictEqual(env.state.session, null, "сессия осталась висеть после срыва");
    assert.strictEqual(env.log.flushed, 1, "автозадача не разбужена после срыва");
  });

  console.log("\n[6] Досылка прерванного ответа");

  await test("досылка: просьба дописать уходит тем же путём, что обычная отправка", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: null });
    env.mod.continueInterruptedAnswer("chat1", null);
    assert.deepStrictEqual(env.log.selectChat, ["chat1"], "чат прерванного ответа не выбран");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(env.log.sent.length, 1, "просьба дописать не ушла агенту");
    const asked = env.log.sent[0].history[0].content;
    assert.ok(/Продолжи предыдущий ответ/.test(asked), "агенту ушла не просьба дописать: " + asked);
    // Поле подгоняется дважды: под саму просьбу и после её отправки (поле очищено).
    assert.strictEqual(env.log.autoResize, 2, "поле ввода не подогнано под просьбу");
    assert.strictEqual(chat.messages.length, 2, "пара «просьба → ответ» не создана");
  });

  await test("досылка: снимает пометку прерывания у сообщения", async () => {
    const chat = makeChat();
    const env = buildChatSend({ isElectron: true, chats: [chat], activeId: "chat1" });
    const m = { id: "a1", role: "assistant", content: "половина", interrupted: true };
    env.mod.continueInterruptedAnswer("chat1", m);
    assert.strictEqual(m.interrupted, false, "пометка прерывания осталась");
    await new Promise((r) => setImmediate(r));
  });

  await test("досылка: во время прогона отказывается и объясняет", () => {
    const env = buildChatSend({ isElectron: true, chats: [makeChat()], activeId: "chat1" });
    env.state.streaming = true;
    env.mod.continueInterruptedAnswer("chat1", null);
    assert.strictEqual(env.log.sent.length, 0, "во время прогона ушла досылка");
    assert.deepStrictEqual(env.log.toasts, ["Дождись окончания текущего ответа"], "нет пояснения отказа");
    assert.strictEqual(env.$("input").value, "", "поле тронули при отказе");
  });

  await test("досылка: чужого чата не касается", () => {
    const env = buildChatSend({ isElectron: true, chats: [makeChat()], activeId: "chat1" });
    assert.doesNotThrow(() => env.mod.continueInterruptedAnswer("нет-такого", null), "досылка упала на неизвестном чате");
    assert.strictEqual(env.log.sent.length, 0, "досылка ушла в никуда");
    assert.strictEqual(env.log.autoResize, 0, "поле тронули на неизвестном чате");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

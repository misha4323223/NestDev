"use strict";

/* ── Прогон ответа: состояние, завершение, остановка, откат (src/renderer/chat-run.js)
   Запуск: node test/chat-run.test.js   (входит в общий `npm test`)

   Модуль вынесен из app.js (этап A, часть 8). Он отвечает за самый заметный кусок
   работы агента: признак «идёт ответ» и вид шапки, остановку, завершение ответа
   (готовые сегменты, «…» вместо пустого ответа, кнопки под ответом) и откат правок
   агента по чекпоинту. Тихие поломки тут дороже всего: не гаснет крутилка, не
   появляется кнопка отката, сегмент остаётся «выполняется», а ответ — пустым.

   Проверяется НАСТОЯЩИЙ модуль: те же зависимости, что даёт оболочка, но состояние
   и разметка — игрушечные, и видно, что именно ушло в DOM и сколько раз. */

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
const MODULE_SRC = read("src", "renderer", "chat-run.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет».
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
// Начало и конец прогона вынесены своим модулем (этап A, часть 9): спрашиваем их там,
// а у app.js — только сборку самих модулей.
const SEND_SRC = read("src", "renderer", "chat-send.js");
const EVENTS_SRC = read("src", "renderer", "chat-events.js");
const STYLES_SRC = read("src", "renderer", "styles.css");

// Игрушечная разметка: элементы ищутся по id, а вложенные — по классу (как в модуле:
// el.querySelector(".bubble") и el.querySelector(".ai-actions")).
function makeEl(tag, id) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: id || "",
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    onclick: null,
    parent: null,
    children: [],
    removed: false,
    classList: {
      has: (c) => el.className.split(/\s+/).includes(c),
      add: (c) => { if (!el.classList.has(c)) el.className = (el.className + " " + c).trim(); },
      remove: (c) => { el.className = el.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
      contains: (c) => el.classList.has(c),
      toggle: (c, on) => { const want = on === undefined ? !el.classList.has(c) : !!on; if (want) el.classList.add(c); else el.classList.remove(c); },
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, "");
      for (const ch of el.children) {
        if (ch.className.split(/\s+/).includes(cls)) return ch;
        const deep = ch.querySelector(sel);
        if (deep) return deep;
      }
      return null;
    },
    appendChild(ch) { el.children.push(ch); ch.parent = el; return ch; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.removed = true; },
  };
  return el;
}

function buildChatRun(opts) {
  const o = opts || {};
  const log = {
    toasts: [], shortToasts: [], refreshed: 0, sent: 0, autoResize: 0, sidebar: 0,
    persistNow: 0, finishGroup: 0, resetGroup: 0, collapse: [], removedSegments: [],
    stopMessage: 0, aborted: 0, undoStatus: 0, undoRollback: 0,
  };
  const state = {
    streaming: false,
    lastUndoCount: o.lastUndoCount || 0,
    undoRestoreShown: false,
    webAbort: o.webAbort === undefined ? { abort: () => { log.aborted++; } } : o.webAbort,
  };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl("div", id));
    return els.get(id);
  };
  els.set("project-panel", makeEl("div", "project-panel"));
  if (o.projectPanelOpen) els.get("project-panel").classList.remove("hidden");
  else els.get("project-panel").className = "hidden";

  const msgEls = new Map();
  if (o.bubbleText !== undefined) {
    const el = makeEl("div", "msg1");
    const bubble = makeEl("div");
    bubble.className = "bubble pending";
    bubble.textContent = o.bubbleText;
    el.appendChild(bubble);
    msgEls.set("msg1", el);
  }

  const chat = o.chat || { id: "c1", messages: o.messages || [] };
  const api = {
    stopMessage: () => { log.stopMessage++; },
    undoStatus: () => { log.undoStatus++; return Promise.resolve(o.undoStatus === undefined ? { ok: true, count: 0 } : o.undoStatus); },
    undoRollback: () => { log.undoRollback++; return Promise.resolve(o.undoRollback === undefined ? { ok: true, count: 2 } : o.undoRollback); },
  };

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
    document: { createElement: (tag) => makeEl(tag) },
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "chat-run.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
  const mod = box.module.exports({
    $,
    isElectron: !!o.isElectron,
    api,
    toast: (t) => log.toasts.push(t),
    msgEls,
    getStreaming: () => state.streaming,
    setStreamingFlag: (v) => { state.streaming = v; },
    getLastUndoCount: () => state.lastUndoCount,
    setLastUndoCount: (v) => { state.lastUndoCount = v; },
    getUndoRestoreShown: () => state.undoRestoreShown,
    setUndoRestoreShown: (v) => { state.undoRestoreShown = v; },
    getWebAbort: () => state.webAbort,
    getActiveChat: () => o.activeChat === undefined ? chat : o.activeChat,
    renderSidebar: () => { log.sidebar++; },
    autoResize: () => { log.autoResize++; },
    sendMessage: () => { log.sent++; },
    getProjectPanel: () => ({
      toastShort: (t) => log.shortToasts.push(t),
      refreshProject: () => { log.refreshed++; },
    }),
    ChatStore: { persistChatsNow: () => { log.persistNow++; } },
    ChatSegments: {
      runSegments: () => o.segments || [],
      removeSegment: (_c, s) => log.removedSegments.push(s.id),
    },
    ChatWork: {
      finishGroup: () => { log.finishGroup++; },
      resetGroup: () => { log.resetGroup++; },
    },
    ChatThinking: { collapseThinkBox: (el) => log.collapse.push(el && el.id) },
    ChatRender: { msgHtml: (t) => (o.msgHtml ? o.msgHtml(t) : "<p>" + t + "</p>") },
  });

  return { mod, state, log, $, els, msgEls, chat };
}

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("прогон: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="chat-run.js"');
    assert.ok(tag > 0, "разметка не грузит chat-run.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "chat-run.js подключён после app.js");
    assert.ok(/"chat-run\.js"/.test(BRIDGE_SRC), "мост не отдаёт chat-run.js телефону");
    assert.ok(/window\.ChatRun\(\{/.test(APP_SRC), "в оболочке нет сборки модуля");
  });

  await test("прогон: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "async function finishStream", "function addUndoButton", "function maybeRestoreUndoButton",
      "function setStreaming", "function stop()", "async function undoStatus",
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код прогона остался в app.js: " + gone);
    }
    for (const call of [
      "ChatRun.maybeRestoreUndoButton();", '$("btn-stop").onclick = ChatRun.stop;',
      "stop: ChatRun.stop,", "if (streaming && e.isTrusted) ChatRun.stop();",
    ]) {
      assert.ok(APP_SRC.includes(call), "вызов не переименован: " + call);
    }
    // Прогон начинается и завершается в модуле отправки — там же и его вызовы.
    for (const call of ["getChatRun().setStreaming(true);", "getChatRun().finishStream(chat, assistantMsg);"]) {
      assert.ok(SEND_SRC.includes(call), "прогон не зовёт модуль прогона: " + call);
    }
    // Завершение прогона обязано трогать ШАПКУ, а не только состояние. Здесь это
    // проверяется по исходнику — чтобы было видно сразу, что именно потеряли, если
    // кто-то заменит вызов на «как бы такой же» (одно состояние + крутилка навсегда).
    assert.ok(MODULE_SRC.includes("setStreaming(false);"), "завершение прогона не возвращает шапку");
    assert.ok(!MODULE_SRC.includes("setStreamingFlag(false)"), "завершение прогона меняет только состояние, а не шапку");
    const build = APP_SRC.indexOf("  const ChatRun = window.ChatRun({");
    assert.ok(build > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    for (const dep of [
      "getStreaming: () => streaming,", "setStreamingFlag: (v) => { streaming = v; },",
      "getLastUndoCount: () => lastUndoCount,", "setLastUndoCount: (v) => { lastUndoCount = v; },",
      "getUndoRestoreShown: () => undoRestoreShown,", "getWebAbort: () => webAbort,",
      "getActiveChat: getActiveChat,", "renderSidebar: renderSidebar,", "sendMessage: ChatSend.sendMessage,",
      "getProjectPanel: () => ProjectPanel,", "ChatStore: ChatStore,", "ChatSegments: ChatSegments,",
      "ChatWork: ChatWork,", "ChatThinking: ChatThinking,", "ChatRender: ChatRender,",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
  });

  console.log("\n[2] Признак прогона и остановка");

  await test("прогон: признак ведёт шапку — крутилка вместо «Отправить»", () => {
    const env = buildChatRun({});
    assert.strictEqual(env.state.streaming, false, "прогон «идёт» до начала");
    env.mod.setStreaming(true);
    assert.strictEqual(env.state.streaming, true, "признак прогона не выставлен в состояние окна");
    assert.strictEqual(env.$("typing").classList.contains("hidden"), false, "крутилка не показана");
    assert.strictEqual(env.$("btn-stop").classList.contains("hidden"), false, "кнопка «Стоп» не показана");
    assert.strictEqual(env.$("btn-send").classList.contains("hidden"), true, "«Отправить» осталась видимой");
    env.mod.setStreaming(false);
    assert.strictEqual(env.state.streaming, false, "признак прогона не снят");
    assert.strictEqual(env.$("typing").classList.contains("hidden"), true, "крутилка осталась");
    assert.strictEqual(env.$("btn-stop").classList.contains("hidden"), true, "кнопка «Стоп» осталась");
    assert.strictEqual(env.$("btn-send").classList.contains("hidden"), false, "«Отправить» не вернулась");
  });

  await test("прогон: остановка — через главный процесс, а в браузере — прерыванием", () => {
    const disk = buildChatRun({ isElectron: true });
    disk.mod.stop();
    assert.strictEqual(disk.log.stopMessage, 1, "в Electron остановка не ушла в главный процесс");
    assert.strictEqual(disk.log.aborted, 0, "в Electron ещё и браузерное прерывание");

    const web = buildChatRun({ isElectron: false });
    web.mod.stop();
    assert.strictEqual(web.log.aborted, 1, "в браузере прогон не прерван");
    assert.strictEqual(web.log.stopMessage, 0, "в браузере дёрнули главный процесс");

    // Прогона нет вовсе — кнопка не должна падать.
    const idle = buildChatRun({ isElectron: false, webAbort: null });
    assert.doesNotThrow(() => idle.mod.stop(), "остановка без прогона упала");
  });

  console.log("\n[3] Завершение ответа");

  await test("прогон: готовые сегменты остаются, пустые промежуточные убираются", async () => {
    const segs = [
      { id: "msg1", content: "первый текст", pending: true },
      { id: "msg2", content: "", pending: true },
      { id: "msg3", content: "итог", pending: true },
    ];
    const env = buildChatRun({ segments: segs, bubbleText: "" });
    await env.mod.finishStream(env.chat, segs[0]);
    assert.deepStrictEqual(segs.map((s) => s.pending), [false, false, false], "сегменты остались «выполняется»");
    assert.deepStrictEqual(env.log.removedSegments, ["msg2"], "пустой промежуточный сегмент не убран: " + JSON.stringify(env.log.removedSegments));
    assert.strictEqual(env.state.streaming, false, "признак прогона не снят по завершении");
    assert.strictEqual(env.log.persistNow, 1, "готовый ответ не записан сразу");
    assert.strictEqual(env.log.sidebar, 1, "список чатов не перерисован");
    assert.strictEqual(env.log.finishGroup, 1, "группа работ не закрыта");
    assert.strictEqual(env.log.resetGroup, 1, "группа работ не сброшена");
  });

  await test("прогон: по завершении ответа в шапке снова «Отправить», а не «Стоп»", async () => {
    // Ровно та тихая поломка, которая ломала весь следующий шаг: признак прогона
    // снимался, а ШАПКА не перерисовывалась — крутилка и «Стоп» оставались на месте,
    // кнопка «Отправить» была скрыта, и отправить следующую команду было нечем
    // (видно только в живом окне: в структурном тесте состояние «как бы» верное).
    const segs = [{ id: "msg1", content: "готово", pending: true }];
    const env = buildChatRun({ segments: segs, bubbleText: "" });
    env.mod.setStreaming(true);
    await env.mod.finishStream(env.chat, segs[0]);
    assert.strictEqual(env.state.streaming, false, "признак прогона остался включённым");
    assert.strictEqual(env.$("btn-stop").classList.contains("hidden"), true, "кнопка «Стоп» осталась в шапке после ответа");
    assert.strictEqual(env.$("typing").classList.contains("hidden"), true, "крутилка осталась в шапке после ответа");
    assert.strictEqual(env.$("btn-send").classList.contains("hidden"), false, "кнопка «Отправить» не вернулась — следующую команду отправить нечем");
  });

  await test("прогон: ответ без текста не оставляет пустоту", async () => {
    const segs = [{ id: "msg1", content: "", pending: true }];
    const env = buildChatRun({ segments: segs, bubbleText: "" });
    await env.mod.finishStream(env.chat, segs[0]);
    assert.strictEqual(segs[0].content, "…", "пустой ответ не заменён на «…»: " + JSON.stringify(segs[0].content));
    assert.deepStrictEqual(env.log.removedSegments, [], "единственный сегмент убран, ответ пропал");
  });

  await test("прогон: текст рисуется как markdown, ошибка — как есть", async () => {
    const okSegs = [{ id: "msg1", content: "привет", pending: true }];
    const ok = buildChatRun({ segments: okSegs, bubbleText: "" });
    await ok.mod.finishStream(ok.chat, okSegs[0]);
    const bubble = ok.msgEls.get("msg1").querySelector(".bubble");
    assert.strictEqual(bubble.innerHTML, "<p>привет</p>", "текст ответа не отрисован: " + bubble.innerHTML);
    assert.strictEqual(bubble.classList.contains("md"), true, "у ответа нет класса markdown");
    assert.strictEqual(bubble.classList.contains("pending"), false, "с ответа не снят признак ожидания");

    const errSegs = [{ id: "msg1", content: "", error: "нет ключа", pending: true }];
    const err = buildChatRun({ segments: errSegs, bubbleText: "нет ключа" });
    await err.mod.finishStream(err.chat, errSegs[0]);
    const eb = err.msgEls.get("msg1").querySelector(".bubble");
    assert.strictEqual(eb.textContent, "нет ключа", "сообщение об ошибке не показано");
    assert.strictEqual(eb.classList.contains("md"), false, "ошибку отрисовали как markdown");
  });

  await test("прогон: размышления сворачиваются только у оставшихся сегментов", async () => {
    const segs = [
      { id: "msg1", content: "текст", pending: true },
      { id: "msg2", content: "", pending: true },
    ];
    const env = buildChatRun({ segments: segs, bubbleText: "" });
    for (const s of segs) env.msgEls.set(s.id, makeEl("div", s.id));
    await env.mod.finishStream(env.chat, segs[0]);
    assert.deepStrictEqual(env.log.collapse, ["msg1"], "свёрнут не тот блок размышлений: " + JSON.stringify(env.log.collapse));
  });

  console.log("\n[4] Кнопки под ответом");

  await test("прогон: «Выполнить план» появляется только у плана с текстом", async () => {
    const withPlan = [{ id: "msg1", content: "план готов", plan: true, pending: true }];
    const env = buildChatRun({ segments: withPlan, bubbleText: "" });
    await env.mod.finishStream(env.chat, withPlan[0]);
    const row = env.msgEls.get("msg1").querySelector(".ai-actions");
    assert.ok(row, "под ответом-планом нет строки кнопок");
    const go = row.children.find((c) => /Выполнить план/.test(c.textContent));
    assert.ok(go, "нет кнопки «Выполнить план»");
    assert.strictEqual(withPlan[0].plan, true, "план снят до нажатия — повторный клик отправил бы запрос дважды");
    go.onclick();
    assert.strictEqual(withPlan[0].plan, false, "план не снят с сегмента после нажатия");
    assert.strictEqual(env.log.sent, 1, "кнопка плана не отправила команду");
    assert.strictEqual(env.$("input").value, "Выполни план, который ты составил. Не пересказывай план — сразу действуй.", "текст команды изменился");
    assert.strictEqual(env.log.autoResize, 1, "поле ввода не подогнано под текст команды");

    // Во время прогона кнопка не отправляет второй запрос.
    const busy = [{ id: "msg1", content: "план", plan: true, pending: true }];
    const env2 = buildChatRun({ segments: busy, bubbleText: "" });
    await env2.mod.finishStream(env2.chat, busy[0]);
    env2.state.streaming = true;
    env2.msgEls.get("msg1").querySelector(".ai-actions").children[0].onclick();
    assert.strictEqual(env2.log.sent, 0, "во время прогона отправился повторный запрос");

    // Обычный ответ — без кнопки плана.
    const plain = [{ id: "msg1", content: "просто ответ", pending: true }];
    const env3 = buildChatRun({ segments: plain, bubbleText: "" });
    await env3.mod.finishStream(env3.chat, plain[0]);
    assert.strictEqual(env3.msgEls.get("msg1").querySelector(".ai-actions"), null, "кнопка плана появилась под обычным ответом");
  });

  await test("прогон: кнопка отката появляется, только если есть что откатывать", async () => {
    const segs = [{ id: "msg1", content: "ответ", pending: true }];
    const withChanges = buildChatRun({ isElectron: true, segments: segs, bubbleText: "", lastUndoCount: 3 });
    await withChanges.mod.finishStream(withChanges.chat, segs[0]);
    assert.ok(withChanges.msgEls.get("msg1").querySelector(".ai-actions"), "нет строки с кнопкой отката");
    assert.strictEqual(withChanges.log.undoStatus, 0, "при известном счётчике лишний вопрос о статусе");

    const unknown = buildChatRun({ isElectron: true, segments: segs, bubbleText: "", lastUndoCount: 0, undoStatus: { ok: true, count: 4 } });
    await unknown.mod.finishStream(unknown.chat, segs[0]);
    assert.strictEqual(unknown.log.undoStatus, 1, "счётчик неизвестен, а статус не спросили");
    assert.ok(unknown.msgEls.get("msg1").querySelector(".ai-actions"), "изменения есть, а кнопки нет");

    const nothing = buildChatRun({ isElectron: true, segments: segs, bubbleText: "", lastUndoCount: 0, undoStatus: { ok: true, count: 0 } });
    await nothing.mod.finishStream(nothing.chat, segs[0]);
    assert.strictEqual(nothing.msgEls.get("msg1").querySelector(".ai-actions"), null, "кнопка отката появилась без изменений");

    const web = buildChatRun({ isElectron: false, segments: segs, bubbleText: "", lastUndoCount: 3 });
    await web.mod.finishStream(web.chat, segs[0]);
    assert.strictEqual(web.msgEls.get("msg1").querySelector(".ai-actions"), null, "в браузере показали откат файлов");
  });

  await test("прогон: откат возвращает файлы, обнуляет счётчик и убирает кнопку", async () => {
    const env = buildChatRun({ isElectron: true, lastUndoCount: 5, projectPanelOpen: true });
    const el = makeEl("div", "msg1");
    env.mod.addUndoButton(el);
    const bUndo = el.querySelector(".ai-actions").children[0];
    assert.strictEqual(bUndo.textContent, "↩ Отменить изменения агента (5)", "в кнопке не тот счётчик: " + bUndo.textContent);
    await bUndo.onclick();
    assert.strictEqual(env.log.undoRollback, 1, "откат не запрошен");
    assert.strictEqual(env.state.lastUndoCount, 0, "счётчик отката не обнулён");
    assert.deepStrictEqual(env.log.shortToasts, ["✅ Отменено: 2 файлов"], "нет пояснения об откате: " + JSON.stringify(env.log.shortToasts));
    assert.strictEqual(bUndo.removed, true, "кнопка осталась после отката");
    assert.strictEqual(env.log.refreshed, 1, "панель проекта не обновлена после отката");

    // Отказ отката — понятное сообщение в тосте, кнопка остаётся.
    const bad = buildChatRun({ isElectron: true, lastUndoCount: 1, undoRollback: { ok: false, error: "нет чекпоинта" } });
    const el2 = makeEl("div", "msg1");
    bad.mod.addUndoButton(el2);
    const b2 = el2.querySelector(".ai-actions").children[0];
    await b2.onclick();
    assert.deepStrictEqual(bad.log.toasts, ["Не удалось отменить изменения"], "нет сообщения об отказе");
    assert.strictEqual(b2.removed, false, "кнопка исчезла при неудачном откате");

    // Без элемента кнопку вешать некуда — и падать не за что.
    assert.doesNotThrow(() => bad.mod.addUndoButton(null), "кнопка отката упала без элемента ответа");
  });

  await test("прогон: кнопка отката после перезапуска появляется один раз", async () => {
    const messages = [
      { id: "u1", role: "user", content: "сделай" },
      { id: "a1", role: "assistant", content: "готово" },
      { id: "s1", role: "system", content: "служебное" },
      { id: "a2", role: "assistant", content: "", error: "ошибка" },
    ];
    const env = buildChatRun({ isElectron: true, messages, undoStatus: { ok: true, count: 7 }, activeChat: { id: "c1", messages } });
    env.msgEls.set("a1", makeEl("div", "a1"));
    env.mod.maybeRestoreUndoButton();
    assert.strictEqual(env.state.undoRestoreShown, true, "признак «уже показали» не выставлен");
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(env.state.lastUndoCount, 7, "счётчик из чекпоинта не восстановлен");
    assert.ok(env.msgEls.get("a1").querySelector(".ai-actions"), "кнопка не повешена под последним ответом");

    // Второй раз — молча, кнопка не дублируется.
    env.mod.maybeRestoreUndoButton();
    assert.strictEqual(env.log.undoStatus, 1, "статус чекпоинта спросили повторно");

    const web = buildChatRun({ isElectron: false, messages, undoStatus: { ok: true, count: 7 }, activeChat: { id: "c1", messages } });
    web.mod.maybeRestoreUndoButton();
    assert.strictEqual(web.log.undoStatus, 0, "в браузере полезли за чекпоинтом на диск");
    assert.strictEqual(web.state.undoRestoreShown, false, "в браузере пометили «показано»");

    const empty = buildChatRun({ isElectron: true, messages, undoStatus: { ok: true, count: 0 }, activeChat: { id: "c1", messages } });
    empty.msgEls.set("a1", makeEl("div", "a1"));
    empty.mod.maybeRestoreUndoButton();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(empty.msgEls.get("a1").querySelector(".ai-actions"), null, "кнопка появилась без чекпоинта");
  });

  console.log("\n[5] Кнопка «Продолжить» после остановки");

  await test("кнопка продолжения: модуль умеет показать, скрыть и отправить", () => {
    const env = buildChatRun({});
    // Игрушечный DOM не знает разметки: «скрыта по умолчанию» проверяется отдельным
    // тестом по самому index.html, а здесь — поведение показа, скрытия и отправки.
    env.mod.showResume("лимит раундов");
    assert.strictEqual(env.$("resume-bar").classList.contains("hidden"), false, "кнопка не показана по событию прогона");
    assert.ok(/лимит раундов/.test(env.$("btn-resume").title), "в подсказке нет причины остановки: " + env.$("btn-resume").title);
    env.mod.hideResume();
    assert.strictEqual(env.$("resume-bar").classList.contains("hidden"), true, "кнопка не скрыта");

    // Нажатие: просьба уходит тем же путём, что и обычное сообщение.
    env.mod.showResume("");
    env.mod.resume();
    assert.strictEqual(env.log.sent, 1, "нажатие не отправило продолжение");
    assert.strictEqual(env.$("input").value, env.mod.RESUME_TEXT, "в поле ввода ушёл не тот текст");
    assert.strictEqual(env.log.autoResize, 1, "поле ввода не подогнано под текст");
    assert.strictEqual(env.$("resume-bar").classList.contains("hidden"), true, "кнопка осталась после нажатия");

    // Во время прогона кнопка не отправляет второй запрос и не прячется сама.
    const busy = buildChatRun({});
    busy.mod.showResume("пауза миссии");
    busy.state.streaming = true;
    busy.mod.resume();
    assert.strictEqual(busy.log.sent, 0, "во время прогона ушёл второй запрос");
    assert.strictEqual(busy.$("resume-bar").classList.contains("hidden"), false, "кнопка спряталась во время прогона");
  });

  await test("кнопка продолжения: её текст — служебный, а не «уточнение к цели» миссии", () => {
    // Текст кнопки узнаёт хранилище миссии (missionStore.isResumeText) — иначе каждый
    // клик добавлял бы миссии уточнение цели, и журнал заполнился бы одинаковыми строками.
    const missionStore = require(path.join(ROOT, "src", "mission-store.js"));
    const env = buildChatRun({});
    env.mod.resume();
    const text = env.$("input").value;
    assert.ok(text.length > 40, "текст кнопки подозрительно короткий: " + text);
    assert.strictEqual(missionStore.isResumeText(text), true, "текст кнопки не узнан как служебный: " + text);
    assert.strictEqual(missionStore.isResumeText("Продолжи миссию «Разбор» (файлы: x)"), true, "прежний служебный текст перестал узнаваться");
    assert.strictEqual(missionStore.isResumeText("добавь ещё плитку на кухне"), false, "обычная просьба человека принята за служебную");
  });

  await test("кнопка продолжения: зажигается событием прогона, а не текстом ответа", () => {
    // Признак продолжения приходит СВОИМ событием: кнопка не должна гореть после
    // любой реплики со словом «продолжай» и не должна теряться при остановке.
    assert.ok(/case "resume":[\s\S]{0,500}getChatRun\(\)\.showResume\(ev\.reason\);/.test(EVENTS_SRC), "событие resume не зажигает кнопку");
    const wiring = APP_SRC.slice(APP_SRC.indexOf("  const ChatEvents = window.ChatEvents({"), APP_SRC.indexOf("  // ─── Правая панель"));
    assert.ok(wiring.includes("getChatRun: () => ChatRun,"), "в проводку событий не передан модуль прогона");
    assert.ok(APP_SRC.includes('$("btn-resume").onclick = ChatRun.resume;'), "кнопка не подключена к продолжению");
    assert.ok(APP_SRC.includes("ChatRun.hideResume();"), "смена чата не гасит чужую кнопку");
    assert.ok(SEND_SRC.includes("getChatRun().hideResume();"), "новый прогон не гасит старую кнопку");
    assert.ok(/id="resume-bar"/.test(HTML_SRC) && /id="btn-resume"/.test(HTML_SRC), "в разметке нет полосы и кнопки продолжения");
    assert.ok(/class="resume-bar hidden"/.test(HTML_SRC), "полоса кнопки видна сразу, без остановки");
    assert.ok(/\.resume-bar\s*\{/.test(STYLES_SRC), "нет стилей полосы кнопки");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

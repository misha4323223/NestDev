"use strict";

/* ── Переименование чата (src/renderer/chat-rename.js) ───────────────────────
   Запуск: node test/chat-rename.test.js   (входит в общий `npm test`)

   Двойной клик по заголовку чата ставит вместо него поле ввода: Enter сохраняет,
   Escape отменяет, клик мимо (уход фокуса) сохраняет. Модуль вынесен из app.js
   (этап A, часть 6). Тихие поломки здесь дорогие: имя не сохраняется, сохраняется
   дважды, или в списке чатов появляется «Чат переименован» без переименования.
   Поэтому проверяется настоящий маршрут: что уходит в хранилище и что показано.

   Заглушка `$` строгая: id, которого нет в настоящей разметке, — ошибка теста.
   Проводка «идёт генерация» проверяется как ЖИВОЙ доступ: признак меняется. */

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
const MODULE_SRC = read("src", "renderer", "chat-rename.js");
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
    textContent: "",
    maxLength: 0,
    spellcheck: true,
    parent: null,
    replacedWith: null,
    selfReplaced: false,
    focused: 0,
    selected: 0,
    listeners: {},
    addEventListener(t, fn) { el.listeners[t] = fn; },
    focus() { el.focused++; },
    select() { el.selected++; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); el.removed = true; },
    replaceWith(node) {
      el.selfReplaced = true;
      el.replacedWith = node;
      node.parent = el.parent;
      if (el.parent) el.parent.children = el.parent.children.map((c) => (c === el ? node : c));
      el.removed = true;
    },
    fire(type, ev) { if (el.listeners[type]) return el.listeners[type](ev); },
  };
  return el;
}

function buildChatRename(opts) {
  const o = opts || {};
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const els = new Map();
  const made = [];
  const log = { persist: 0, render: 0, toasts: [] };

  const $ = (id) => {
    assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
    if (!els.has(id)) {
      const node = makeEl("div", id);
      if (id === "chat-title") { node.parent = makeEl("div"); node.parent.children = [node]; }
      els.set(id, node);
    }
    return els.get(id);
  };

  let streaming = !!o.streaming;
  const chat = o.chat === undefined ? { title: "Старое имя" } : o.chat;

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
    document: { createElement: (tag) => { const el = makeEl(tag); made.push(el); return el; } },
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "chat-rename.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
  const mod = box.module.exports({
    $,
    toast: (t) => log.toasts.push(t),
    getActiveChat: () => chat,
    getStreaming: () => streaming,
    chatTitle: (c) => c.title || "Новый чат",
    persistChats: () => { log.persist++; },
    renderSidebar: () => { log.render++; },
  });

  return {
    mod, $, log, made, chat,
    setStreaming: (v) => { streaming = v; },
    titleEl: () => $("chat-title"),
    input: () => els.get("chat-title").replacedWith,
    restored: () => { const i = els.get("chat-title").replacedWith; return i ? i.replacedWith : null; },
  };
}

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("переименование чата: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="chat-rename.js"');
    assert.ok(tag > 0, "разметка не грузит chat-rename.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "chat-rename.js подключён после app.js");
    assert.ok(/"chat-rename\.js"/.test(BRIDGE_SRC), "мост не отдаёт chat-rename.js телефону");
    assert.ok(
      /window\.ChatRename\(\{/.test(APP_SRC),
      "в оболочке нет сборки модуля"
    );
  });

  await test("переименование чата: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of ["function startRenameChat", 'inp.id = "chat-title-input"', 'toast("Чат переименован")']) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код переименования остался в app.js: " + gone);
    }
    assert.ok(
      APP_SRC.includes('$("chat-title").addEventListener("dblclick", ChatRename.startRenameChat);'),
      "двойной клик по заголовку больше не зовёт модуль"
    );
    const build = APP_SRC.indexOf("  const ChatRename = window.ChatRename({");
    const use = APP_SRC.indexOf('$("chat-title").addEventListener("dblclick", ChatRename.startRenameChat);');
    assert.ok(build > 0 && build < use, "сборка модуля стоит ниже того, кто её зовёт");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    for (const dep of ["$: $,", "toast: toast,", "getActiveChat:", "getStreaming:", "chatTitle:", "persistChats:", "renderSidebar:"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
  });

  console.log("\n[2] Когда переименовывать нельзя");

  await test("переименование чата: без открытого чата и во время генерации ничего не происходит", () => {
    const noChat = buildChatRename({ chat: null });
    noChat.mod.startRenameChat();
    assert.strictEqual(noChat.made.length, 0, "поле ввода создано без открытого чата");
    assert.strictEqual(noChat.titleEl().selfReplaced, false, "заголовок подменён без открытого чата");
    assert.deepStrictEqual(noChat.log.toasts, [], "тост без открытого чата");

    const busy = buildChatRename({ streaming: true });
    busy.mod.startRenameChat();
    assert.strictEqual(busy.made.length, 0, "поле ввода создано во время генерации");
    assert.strictEqual(busy.log.persist, 0, "имя сохранено во время генерации");

    // Признак читается ЖИВЫМ: пока прогон не кончился — нельзя, после — можно.
    busy.setStreaming(false);
    busy.mod.startRenameChat();
    assert.strictEqual(busy.made.length, 1, "после генерации переименование всё ещё запрещено");
  });

  console.log("\n[3] Сохранение, отмена, один раз");

  await test("переименование чата: поле встаёт вместо заголовка и получает фокус", () => {
    const env = buildChatRename();
    env.mod.startRenameChat();
    const inp = env.input();
    assert.ok(inp, "заголовок не подменён полем ввода");
    assert.strictEqual(inp.id, "chat-title-input", "у поля другой id");
    assert.strictEqual(inp.className, "chat-title-input", "у поля другой класс");
    assert.strictEqual(inp.value, "Старое имя", "в поле не подставлено текущее имя");
    assert.strictEqual(inp.maxLength, 80, "у поля другой предел длины");
    assert.strictEqual(inp.spellcheck, false, "проверка орфографии в поле имени осталась включённой");
    assert.strictEqual(inp.focused, 1, "фокус не встал в поле");
    assert.strictEqual(inp.selected, 1, "старое имя не выделено");
  });

  await test("переименование чата: Enter сохраняет новое имя и перерисовывает список", () => {
    const env = buildChatRename();
    env.mod.startRenameChat();
    const inp = env.input();
    inp.value = "  Новая тема  ";
    inp.fire("keydown", { key: "Enter" });
    assert.strictEqual(env.chat.title, "Новая тема", "новое имя не сохранено: " + JSON.stringify(env.chat.title));
    assert.strictEqual(env.log.persist, 1, "имя не записано в хранилище");
    assert.strictEqual(env.log.render, 1, "список чатов не перерисован");
    assert.deepStrictEqual(env.log.toasts, ["Чат переименован"], "тост не показан");
    const back = env.restored();
    assert.ok(back, "заголовок не вернулся на место");
    assert.strictEqual(back.id, "chat-title", "вернулся не заголовок чата");
    assert.strictEqual(back.textContent, "Новая тема", "заголовок показывает не новое имя");
  });

  await test("переименование чата: уход фокуса сохраняет, Enter дважды — нет", () => {
    const env = buildChatRename();
    env.mod.startRenameChat();
    const inp = env.input();
    inp.value = "Клик мимо";
    inp.fire("blur", {});
    assert.strictEqual(env.chat.title, "Клик мимо", "уход фокуса не сохранил имя");
    assert.strictEqual(env.log.persist, 1, "уход фокуса записал имя не один раз");

    const env2 = buildChatRename();
    env2.mod.startRenameChat();
    const inp2 = env2.input();
    inp2.value = "Один раз";
    inp2.fire("keydown", { key: "Enter" });
    inp2.fire("keydown", { key: "Enter" });
    inp2.fire("blur", {});
    assert.strictEqual(env2.chat.title, "Один раз", "имя сохранено неверно");
    assert.strictEqual(env2.log.persist, 1, "имя записано в хранилище несколько раз: " + env2.log.persist);
    assert.deepStrictEqual(env2.log.toasts, ["Чат переименован"], "тост показан повторно");
  });

  await test("переименование чата: Escape отменяет и возвращает прежнее имя", () => {
    const env = buildChatRename();
    env.mod.startRenameChat();
    const inp = env.input();
    inp.value = "Не надо";
    inp.fire("keydown", { key: "Escape" });
    assert.strictEqual(env.chat.title, "Старое имя", "Escape всё-таки переименовал чат");
    assert.strictEqual(env.log.persist, 0, "Escape записал чат в хранилище");
    assert.deepStrictEqual(env.log.toasts, [], "Escape показал тост");
    assert.strictEqual(env.restored().textContent, "Старое имя", "заголовок показывает не прежнее имя");
    // Escape закрыл ввод: уход фокуса после отмены уже ничего не сохраняет.
    inp.fire("blur", {});
    assert.strictEqual(env.log.persist, 0, "после Escape уход фокуса всё-таки сохранил");
  });

  await test("переименование чата: пустое и то же имя не считаются переименованием", () => {
    const empty = buildChatRename();
    empty.mod.startRenameChat();
    empty.input().value = "   ";
    empty.input().fire("keydown", { key: "Enter" });
    assert.strictEqual(empty.chat.title, "Старое имя", "пустое имя затёрло старое");
    assert.strictEqual(empty.log.persist, 0, "пустое имя записано в хранилище");
    assert.deepStrictEqual(empty.log.toasts, [], "пустое имя показало «Чат переименован»");
    assert.strictEqual(empty.restored().textContent, "Старое имя", "заголовок потерялся после пустого имени");

    const same = buildChatRename();
    same.mod.startRenameChat();
    same.input().value = "Старое имя";
    same.input().fire("keydown", { key: "Enter" });
    assert.strictEqual(same.log.persist, 0, "то же имя записано в хранилище");
    assert.deepStrictEqual(same.log.toasts, [], "то же имя показало «Чат переименован»");
    assert.strictEqual(same.restored().textContent, "Старое имя", "заголовок потерялся");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

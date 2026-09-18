"use strict";

/* ── Продолжение чата: контекст из прошлого чата (src/renderer/chat-continue.js) ──
   Запуск: node test/chat-continue.test.js   (входит в общий `npm test`)

   Модуль вынесен из app.js (этап A, часть 10: остатки окна). Кнопка «🔄 Продолжить
   контекст» заводит новый чат и переносит в него суть задачи: последний запрос
   человека, последний ответ агента и хвост диалога — с ограничением по символам.

   Тихие поломки здесь дорогие и незаметные: перенос окажется копией всего чата
   (раздутый контекст), потеряет последний запрос (агент начнёт заново) или вовсе
   не создаст чат. Поэтому проверяется НАСТОЯЩИЙ модуль: сборка контекста — на
   разговорах, обработчик кнопки — на игрушечном DOM. */

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
const MODULE_SRC = read("src", "renderer", "chat-continue.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет».
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");

function makeEl(id) {
  const el = {
    id: id || "",
    onclick: null,
  };
  return el;
}

function buildChatContinue(opts) {
  const o = opts || {};
  const log = { created: [], toasts: [] };
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const state = { streaming: !!o.streaming, activeChat: o.activeChat === undefined ? null : o.activeChat };

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "chat-continue.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");

  const mod = box.module.exports({
    $,
    getStreaming: () => state.streaming,
    getActiveChat: () => state.activeChat,
    createChat: (opts2) => { log.created.push(opts2 === undefined ? "без аргументов" : opts2); },
    toast: (t) => log.toasts.push(t),
  });

  return { mod, state, log, $, els };
}

const chat = (messages, title) => ({ id: "c1", title: title === undefined ? "Мой чат" : title, messages });

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("продолжение: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="chat-continue.js"');
    assert.ok(tag > 0, "разметка не грузит chat-continue.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "chat-continue.js подключён после app.js");
    assert.ok(/"chat-continue\.js"/.test(BRIDGE_SRC), "мост не отдаёт chat-continue.js телефону");
    assert.ok(/window\.ChatContinue\(\{/.test(APP_SRC), "в оболочке нет сборки модуля");
  });

  await test("продолжение: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of ["function buildContinuationContext", '$("btn-continue-chat").onclick']) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код продолжения остался в app.js: " + gone);
    }
    assert.ok(APP_SRC.includes("ChatContinue.wire();"), "обработчик кнопки не подключён");
    const build = APP_SRC.indexOf("  const ChatContinue = window.ChatContinue({");
    assert.ok(build > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    for (const dep of ["$: $,", "getStreaming: () => streaming,", "getActiveChat: getActiveChat,", "createChat: createChat,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
    // Палитра команд жмёт кнопку через .click() — обработчик обязан висеть на ней самой.
    assert.ok(read("src", "renderer", "command-palette.js").includes('$("btn-continue-chat").click()'), "палитра перестала жать кнопку продолжения");
  });

  console.log("\n[2] Что переносится в новый чат");

  await test("продолжение: в контекст идут запрос, ответ и хвост диалога", () => {
    const env = buildChatContinue({});
    const prev = chat([
      { role: "user", content: "старый вопрос" },
      { role: "assistant", content: "старый ответ" },
      { role: "user", content: "сделай сайт" },
      { role: "assistant", content: "сайт готов" },
    ], "Сайт визитка");
    const out = env.mod.buildContinuationContext(prev);
    assert.ok(out.includes("ПРОДОЛЖЕНИЕ ПРЕДЫДУЩЕГО ЧАТА"), "нет заголовка переноса");
    assert.ok(out.includes("Тема/задача: Сайт визитка"), "тема чата не перенесена");
    assert.ok(out.includes("Последний запрос пользователя:") && out.includes("сделай сайт"), "последний запрос не перенесён");
    assert.ok(out.includes("Последний ответ агента:") && out.includes("сайт готов"), "последний ответ не перенесён");
    assert.ok(out.includes("Хвост диалога") && out.includes("Пользователь: старый вопрос"), "хвост диалога не перенесён");
    assert.ok(out.includes("Агент: старый ответ"), "в хвост не попал ответ агента");
  });

  await test("продолжение: свежие реплики важнее ранних, перенос не растёт бесконечно", () => {
    const many = [{ role: "user", content: "первый вопрос" }, { role: "assistant", content: "первый ответ" }];
    for (let i = 0; i < 40; i++) {
      many.push({ role: "user", content: "реплика " + i + " " + "я".repeat(400) });
      many.push({ role: "assistant", content: "ответ " + i + " " + "ю".repeat(400) });
    }
    const env = buildChatContinue({});
    const out = env.mod.buildContinuationContext(chat(many, "Долгий чат"));
    assert.ok(out.length < 12000, "перенос разросся: " + out.length + " знаков");
    assert.ok(out.includes("ответ 39"), "самая свежая реплика не попала в перенос");
    assert.ok(!out.includes("первый вопрос"), "ранняя реплика вытеснила свежие");
  });

  await test("продолжение: картинки переносятся текстом, служебные роли не ломают сборку", () => {
    const env = buildChatContinue({});
    const prev = chat([
      { role: "user", content: [{ type: "text", text: "вот скриншот" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      { role: "assistant", content: "вижу" },
      { role: "tool", content: "вывод инструмента" },
      { role: "system", content: "заметка о переносе" },
      { role: "assistant", content: "" },
    ]);
    const out = env.mod.buildContinuationContext(prev);
    assert.ok(out.includes("вот скриншот"), "текст рядом с картинкой потерян");
    assert.ok(!out.includes("data:image/png"), "в контекст уехала сама картинка");
    assert.ok(!out.includes("вывод инструмента"), "служебный вывод инструмента попал в контекст");
    assert.ok(out.includes("Заметка: заметка о переносе"), "заметка системы не названа своим словом");
  });

  await test("продолжение: чат без разговора и без имени переносится без выдумок", () => {
    const env = buildChatContinue({});
    const out = env.mod.buildContinuationContext(chat([], "Новый чат"));
    assert.ok(out.startsWith("ПРОДОЛЖЕНИЕ ПРЕДЫДУЩЕГО ЧАТА"), "нет заголовка переноса");
    assert.ok(!out.includes("Тема/задача"), "имя «Новый чат» уехало как тема задачи");
    assert.ok(!out.includes("Последний запрос"), "перенос придумал несуществующий запрос");
    assert.ok(!out.includes("Хвост диалога"), "перенос придумал несуществующий хвост");

    // Разговор только из ответа агента — перенос всё равно осмысленный.
    const onlyAnswer = env.mod.buildContinuationContext(chat([{ role: "assistant", content: "готово" }], "Чат"));
    assert.ok(onlyAnswer.includes("Последний ответ агента:") && onlyAnswer.includes("готово"), "одинокий ответ агента потерян");
  });

  console.log("\n[3] Кнопка «Продолжить контекст»");

  await test("продолжение: кнопка заводит новый чат с перенесённым контекстом", () => {
    const prev = chat([{ role: "user", content: "сделай сайт" }, { role: "assistant", content: "готово" }], "Сайт");
    const env = buildChatContinue({ activeChat: prev });
    env.mod.wire();
    env.$("btn-continue-chat").onclick();
    assert.strictEqual(env.log.created.length, 1, "новый чат не заведён");
    const created = env.log.created[0];
    assert.ok(created && created.contextMsg, "в новый чат не передан контекст");
    assert.ok(created.contextMsg.includes("сделай сайт"), "контекст пуст: " + created.contextMsg);
    assert.strictEqual(created.title, "Сайт (продолжение)", "имя нового чата не связано с прошлым: " + created.title);
  });

  await test("продолжение: без разговора кнопка честно заводит обычный чат", () => {
    const empty = buildChatContinue({ activeChat: chat([], "Новый чат") });
    empty.mod.wire();
    empty.$("btn-continue-chat").onclick();
    assert.deepStrictEqual(empty.log.created, ["без аргументов"], "пустой чат превратился в «продолжение»");

    const none = buildChatContinue({ activeChat: null });
    none.mod.wire();
    none.$("btn-continue-chat").onclick();
    assert.deepStrictEqual(none.log.created, ["без аргументов"], "кнопка упала без активного чата");
  });

  await test("продолжение: во время прогона кнопка не мешает агенту", () => {
    const env = buildChatContinue({ streaming: true, activeChat: chat([{ role: "user", content: "работай" }], "Чат") });
    env.mod.wire();
    env.$("btn-continue-chat").onclick();
    assert.strictEqual(env.log.created.length, 0, "во время прогона заведён второй чат");
    assert.strictEqual(env.state.activeChat.id, "c1", "активный чат подменён во время прогона");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

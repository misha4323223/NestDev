"use strict";

/* ── Модалка «вопрос агента» (src/renderer/ask-modal.js) ─────────────────────
   Запуск: node test/ask-modal.test.js   (входит в общий `npm test`)

   Агент спрашивает человека перед необратимым действием (askUser) — вопрос показывается
   поверх окна, ответ уходит обратно в прогон. Модалка вынесена из app.js своим модулем
   (этап A, часть 6). Ломается она тихо: окно вопроса открывается, а ответ уходит в пустоту
   (или уходит дважды) — и прогон виснет. Поэтому проверяется настоящий маршрут:

     • вопрос показывается, поле пустое, фокус возвращается в него;
     • «Ответить» отдаёт ответ один раз и запоминает, что он отдан;
     • «Отмена» отдаёт пустой ответ (агент не должен ждать вечно);
     • Enter отправляет, Shift+Enter — нет (перенос строки);
     • открытие нового вопроса не переиспользует прошлый ответ;
     • закрытие окна убирает ждущий ответ: отвечать больше некому и нечему.

   Заглушка `$` строгая: id, которого нет в настоящей разметке, — ошибка теста. */

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
const MODULE_SRC = read("src", "renderer", "ask-modal.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет».
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");

function buildAskModal() {
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const els = new Map();
  const calls = { focused: [], events: {} };

  function mkEl(id) {
    let cls = new Set();
    const node = {
      id: id, value: "", textContent: "", onclick: null,
      listeners: {},
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
      },
      addEventListener(t, fn) { node.listeners[t] = fn; },
      focus() { calls.focused.push(id); },
      click() { if (node.onclick) return node.onclick(); },
    };
    return node;
  }
  for (const tag of HTML_SRC.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag[0]);
    if (cls && /\bhidden\b/.test(cls[1])) {
      // overlay в разметке уже скрыт (class="overlay hidden") — начинаем с того же состояния
      els.set(tag[1], null);
    }
  }
  const hiddenAtStart = new Set([...els.keys()]);

  const $ = (id) => {
    assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
    if (!els.has(id) || !els.get(id)) {
      const node = mkEl(id);
      // Классы из разметки: прячем всё, что помечено hidden
      if (!hiddenAtStart.has(id)) node.classList.add("visible");
      if (hiddenAtStart.has(id)) node.classList.add("hidden");
      els.set(id, node);
    }
    return els.get(id);
  };

  // Таймеры под контролем теста: фокус ставится через setTimeout(60).
  const timers = [];
  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "ask-modal.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
  const modal = box.module.exports({ $ });

  return {
    modal, $, calls, timers,
    exports: Object.keys(modal).sort(),
    runTimers: () => { const list = timers.splice(0); list.forEach((t) => t.fn()); },
    isHidden: () => $("ask-overlay").classList.contains("hidden"),
  };
}

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("вопрос агента: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="ask-modal.js"');
    assert.ok(tag > 0, "разметка не грузит ask-modal.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "ask-modal.js подключён после app.js");
    assert.ok(/"ask-modal\.js"/.test(BRIDGE_SRC), "мост не отдаёт ask-modal.js телефону");
  });

  await test("вопрос агента: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "function openAskModal", "function closeAskModal", "let askOnAnswer",
      '$("btn-ask-send").onclick', '$("btn-ask-cancel").onclick',
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код модалки остался в app.js: " + gone);
    }
    assert.ok(APP_SRC.includes("AskModal.wire();"), "события модалки не подключены");
    assert.ok(APP_SRC.includes("openAskModal: AskModal.openAskModal,"), "события агента получили не тот показ вопроса");
    assert.ok(APP_SRC.includes("closeAskModal: AskModal.closeAskModal,"), "события агента получили не то закрытие");
    assert.ok(APP_SRC.includes("openAskModal: AskModal.openAskModal,"), "веб-режим не получает показ вопроса");

    // Сборка стоит ВЫШЕ потребителей (chat-events.js и web-chat.js собираются раньше).
    const build = APP_SRC.indexOf("  const AskModal = window.AskModal({");
    assert.ok(build > 0, "в оболочке нет сборки модуля");
    assert.ok(build < APP_SRC.indexOf("openAskModal: AskModal.openAskModal,"), "сборка стоит ниже того, кто её зовёт");
    const wiring = APP_SRC.slice(build, APP_SRC.indexOf("  });", build));
    assert.ok(wiring.includes("$: $,"), "в проводку не передан $");
  });

  console.log("\n[2] Показ вопроса и ответы");

  await test("вопрос агента: показ ставит вопрос, чистит поле и возвращает фокус", () => {
    const env = buildAskModal();
    assert.ok(env.isHidden(), "модалка открыта до вопроса");
    env.$("ask-input").value = "старый ответ";
    env.modal.openAskModal("Удалить файл?", () => {});
    assert.ok(!env.isHidden(), "вопрос не показал модалку");
    assert.strictEqual(env.$("ask-question").textContent, "Удалить файл?", "заголовок вопроса не показан");
    assert.strictEqual(env.$("ask-input").value, "", "поле не очищено под новый ответ");
    assert.deepStrictEqual(env.calls.focused, [], "фокус поставлен синхронно (он мешал бы открытию)");
    assert.strictEqual(env.timers.length, 1, "фокус не запланирован");
    assert.strictEqual(env.timers[0].ms, 60, "фокус запланирован с другой задержкой: " + env.timers[0].ms);
    env.runTimers();
    assert.deepStrictEqual(env.calls.focused, ["ask-input"], "фокус не встал в поле ответа");
  });

  await test("вопрос агента: «Ответить» отдаёт ответ один раз", () => {
    const env = buildAskModal();
    env.modal.wire();
    const answers = [];
    env.modal.openAskModal("Продолжить?", (t) => answers.push(t));
    env.$("ask-input").value = "  да, продолжай  ";
    env.$("btn-ask-send").onclick();
    assert.deepStrictEqual(answers, ["да, продолжай"], "ответ ушёл не обрезанным: " + JSON.stringify(answers));
    assert.ok(env.isHidden(), "модалка не закрылась после ответа");
    // Повторный клик (или поздний клик) ничего не отправляет: ответ уже отдан.
    env.$("btn-ask-send").onclick();
    assert.deepStrictEqual(answers, ["да, продолжай"], "ответ отправлен дважды: " + JSON.stringify(answers));
  });

  await test("вопрос агента: «Отмена» отдаёт пустой ответ и закрывает окно", () => {
    const env = buildAskModal();
    env.modal.wire();
    const answers = [];
    env.modal.openAskModal("Удалить?", (t) => answers.push(t));
    env.$("ask-input").value = "нет, не надо";
    env.$("btn-ask-cancel").onclick();
    assert.deepStrictEqual(answers, [""], "отмена не отдала пустой ответ: " + JSON.stringify(answers));
    assert.ok(env.isHidden(), "модалка осталась открытой после отмены");
  });

  await test("вопрос агента: Enter отправляет, Shift+Enter оставляет перенос строки", () => {
    const env = buildAskModal();
    env.modal.wire();
    let sent = 0;
    env.modal.openAskModal("Спросить", () => { sent++; });
    const input = env.$("ask-input");
    const key = (e) => input.listeners.keydown(e);
    key({ key: "Enter", shiftKey: true, preventDefault() { assert.fail("Shift+Enter забрал перевод строки"); } });
    assert.strictEqual(sent, 0, "Shift+Enter отправил ответ вместо переноса строки");

    let prevented = 0;
    key({ key: "Enter", shiftKey: false, preventDefault() { prevented++; } });
    assert.strictEqual(prevented, 1, "Enter не остановил поведение по умолчанию");
    assert.strictEqual(sent, 1, "Enter не отправил ответ");

    // Прочая клавиша ничего не делает.
    env.modal.openAskModal("Спросить", () => { sent++; });
    key({ key: "a", shiftKey: false, preventDefault() {} });
    assert.strictEqual(sent, 1, "обычная клавиша отправила ответ");
  });

  console.log("\n[3] Границы: новый вопрос, закрытие, ответа нет");

  await test("вопрос агента: новый вопрос не переиспользует прошлый ответ", () => {
    const env = buildAskModal();
    env.modal.wire();
    const answers = [];
    env.modal.openAskModal("Первый", (t) => answers.push("первый:" + t));
    env.modal.openAskModal("Второй", (t) => answers.push("второй:" + t));
    env.$("ask-input").value = "ок";
    env.$("btn-ask-send").onclick();
    assert.deepStrictEqual(answers, ["второй:ок"], "ответ ушёл в старый вопрос: " + JSON.stringify(answers));
    assert.strictEqual(env.$("ask-question").textContent, "Второй", "показан не последний вопрос");
  });

  await test("вопрос агента: после закрытия окна ответа ждать некому", () => {
    const env = buildAskModal();
    env.modal.wire();
    const answers = [];
    env.modal.openAskModal("Вопрос", (t) => answers.push(t));
    env.modal.closeAskModal();
    assert.ok(env.isHidden(), "закрытие не спрятало модалку");
    env.$("btn-ask-send").onclick();
    env.$("btn-ask-cancel").onclick();
    assert.deepStrictEqual(answers, [], "после закрытия ответ всё-таки ушёл: " + JSON.stringify(answers));
  });

  await test("вопрос агента: вопрос без обработчика не ломает окно", () => {
    const env = buildAskModal();
    env.modal.wire();
    env.modal.openAskModal("Никто не ждёт", undefined);
    assert.doesNotThrow(() => env.$("btn-ask-send").onclick(), "кнопка ответа упала без ждущего");
    assert.doesNotThrow(() => env.$("btn-ask-cancel").onclick(), "кнопка отмены упала без ждущего");
    assert.ok(env.isHidden(), "окно осталось открытым");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

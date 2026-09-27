"use strict";

/* ── Окно контекста модели: чип и попап (src/renderer/context-ui.js) ──────────
   Запуск: node test/context-ui.test.js   (входит в общий `npm test`)

   Зачем этот набор. Чип «Контекст 52%» под полем ввода стал кнопкой: по клику
   человек задаёт окно контекста модели вручную. Без этого на OpenAI-совместимых
   роутерах (nrouter.ai и подобных) окно модели неизвестно, бюджет истории
   остаётся «на глаз» — 400 000 токенов из context-window.js, — и запрос уходит
   за настоящее окно: провайдер либо отказывает, либо молча обрезает начало.
   В обрезанном запросе теряется схема инструментов и системные правила — именно
   поэтому агент «тупеет»: перестаёт звать инструменты и пишет код в чат.

   Поэтому проверяется не «строка на месте», а поведение:
     • модуль отдаёт ФАБРИКУ (как reasoning.js/model-popup.js), а оболочка только
       собирает её — иначе `window.ContextUI({...})` упадёт с «is not a function»;
     • разметка грузит модуль ДО app.js, мост отдаёт его телефону;
     • чип открывает попап, повторный клик и клик мимо закрывают;
     • выбор пресета ложится в настройки, сохраняется, подтверждается и закрывает
       попап; ряд «Своё…» раскрывает поле, значение проверяется на границы;
     • заданное вручную окно перебивает авто-определение в прогоне (run-ai.js) —
       ради этого всё и сделано;
     • значение переживает сохранение настроек (settings-store.js).

   Заглушка `$` строгая: id, которого нет в настоящей разметке, — ошибка теста.
   Кнопки-пресеты берутся ИЗ РАЗМЕТКИ: значения и подписи должны совпадать с тем,
   что видит человек. */

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
const MODULE_SRC = read("src", "renderer", "context-ui.js");
const HTML_SRC = read("src", "renderer", "index.html");
const CSS_SRC = read("src", "renderer", "styles.css");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
const APP_SRC = read("src", "renderer", "app.js");
const RUN_SRC = read("src", "run-ai.js");
const PKG = JSON.parse(read("package.json"));

// Кнопки-пресеты — из настоящей разметки, вместе со значением и подписью.
const PRESETS = [...HTML_SRC.matchAll(/<button[^>]*class="ctx-opt"[^>]*data-win="(-?\d+)"[^>]*>([^<]+)<\/button>/g)]
  .map((m) => ({ win: Number(m[1]), label: m[2] }));

function classSet(init) {
  const set = new Set(init || []);
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c);
      else set.delete(c);
      return want;
    },
  };
}

// ── Игрушечное окно: только те id, что есть в разметке ──────────────────────
function buildEnv(o) {
  const opts = o || {};
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const initialClasses = new Map();
  for (const tag of HTML_SRC.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag[0]);
    initialClasses.set(tag[1], new Set((cls ? cls[1] : "").split(/\s+/).filter(Boolean)));
  }

  const inside = new Set();

  function makeClassList(cls) {
    return classSet(cls);
  }

  // Кнопки-пресеты в разметке без id: собираем их из данных, как их видит человек.
  const presetNodes = PRESETS.map((p) => {
    const cls = new Set(["ctx-opt"]);
    const node = {
      dataset: { win: String(p.win) },
      className: "ctx-opt",
      textContent: p.label,
      children: [],
      classList: makeClassList(cls),
      contains: () => false,
    };
    node.closest = (sel) => (sel === ".ctx-opt" ? node : null);
    inside.add(node);
    return node;
  });

  const els = new Map();
  function newNode(id) {
    const cls = new Set(initialClasses.get(id) || []);
    const node = {
      id: id,
      value: "",
      textContent: "",
      title: "",
      className: "",
      dataset: {},
      children: [],
      onclick: null,
      onkeydown: null,
      listeners: {},
      classList: makeClassList(cls),
      appendChild(c) {
        node.children.push(c);
        return c;
      },
      contains(n) {
        return n === node || inside.has(n) || node.children.indexOf(n) >= 0;
      },
      addEventListener(t, fn) {
        (node.listeners[t] = node.listeners[t] || []).push(fn);
      },
      focus() {
        focusCalls.push(id);
      },
      select() {},
    };
    node.closest = () => null;
    return node;
  }

  const focusCalls = [];

  const $ = (id) => {
    assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
    if (!els.has(id)) {
      const node = newNode(id);
      if (id === "ctx-pop-opts") {
        node.querySelectorAll = (sel) => (sel === ".ctx-opt" ? presetNodes.slice() : []);
        node.children = presetNodes.slice();
      }
      // Внутренностями попапа считаем только его собственные элементы: иначе
      // клик по чужому полю (textarea #input) считался бы кликом внутрь.
      if (id.indexOf("ctx-pop") === 0) inside.add(node);
      els.set(id, node);
    }
    return els.get(id);
  };

  const calls = { msgs: [], saved: 0, doc: {} };
  const state = { settings: Object.assign({ contextWindow: 0 }, opts.settings || {}) };

  const sharedDocument = {
    getElementById: $,
    createElement: () => newNode("created"),
    addEventListener: (t, fn) => {
      (calls.doc[t] = calls.doc[t] || []).push(fn);
    },
  };

  function load(src, filename, deps) {
    const box = {
      module: { exports: {} },
      self: {},
      Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
      parseInt, parseFloat,
      console: { log() {}, warn() {}, error() {} },
      document: sharedDocument,
    };
    vm.runInNewContext(src, box, { filename: filename });
    assert.strictEqual(typeof box.module.exports, "function",
      filename + ": модуль не отдал фабрику — окно упадёт на «is not a function»");
    return box.module.exports(deps);
  }

  const getSettings = opts.settingsThrows
    ? () => {
        throw new Error("настройки недоступны");
      }
    : () => state.settings;

  const ctx = load(MODULE_SRC, "context-ui.js", {
    $,
    toast: (t) => calls.msgs.push(t),
    getSettings,
    persistSettings: () => {
      calls.saved++;
    },
  });

  return {
    ctx,
    $,
    calls,
    state,
    presetNodes,
    focusCalls,
    exports: Object.keys(ctx).sort(),
    mousedown: (target) => (calls.doc.mousedown || []).forEach((fn) => fn({ target })),
    keydown: (key) => (calls.doc.keydown || []).forEach((fn) => fn({ key })),
    clickOpt: (win) => {
      const node = presetNodes.find((n) => n.dataset.win === String(win));
      const listeners = $("ctx-pop-opts").listeners.click || [];
      listeners.forEach((fn) => fn({ target: node }));
    },
  };
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const lastMsg = (env) => env.calls.msgs[env.calls.msgs.length - 1] || "";
const activeWin = (env) => {
  const a = env.presetNodes.find((n) => n.classList.contains("active"));
  return a ? Number(a.dataset.win) : null;
};

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("context-ui: разметка грузит модуль до app.js, мост отдаёт его телефону", () => {
    const tag = HTML_SRC.indexOf('src="context-ui.js"');
    assert.ok(tag > 0, "разметка не грузит context-ui.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "context-ui.js подключён после app.js");
    assert.ok(/"context-ui\.js"/.test(BRIDGE_SRC), "мост не отдаёт context-ui.js телефону");
  });

  await test("context-ui: модуль отдаёт ФАБРИКУ, а не готовый объект", () => {
    const box = { module: { exports: {} }, self: {} };
    vm.runInNewContext(MODULE_SRC, box, { filename: "context-ui.js" });
    assert.strictEqual(typeof box.module.exports, "function",
      "наружу отдан готовый объект: window.ContextUI({...}) упадёт с «is not a function»");
    assert.ok(APP_SRC.includes("const ContextUI = window.ContextUI({"), "оболочка не собирает модуль фабрикой");
    for (const dep of ["$: $,", "toast: toast,", "getSettings: () => settings,", "persistSettings: () => ChatStore.persistSettings(),"]) {
      assert.ok(APP_SRC.includes(dep), "в проводку не передан " + dep);
    }
    assert.ok(APP_SRC.includes("ContextUI.wire();"), "чип не подключён к модулю");
  });

  await test("context-ui: в оболочке только сборка, сам код живёт в модуле", () => {
    for (const gone of ['$("ctx-popover")', '"ctx-pop-opts"', "function fmtWindow"]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код окна контекста остался в app.js: " + gone);
    }
    // Границы модуля: настройки — только через getSettings(), чужих глобалов нет.
    const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bare of ["localStorage", "window.api"]) {
      assert.ok(!new RegExp(bare.replace(".", "\\.") + "\\b").test(code), "модуль читает " + bare + " напрямую");
    }
    assert.ok(!/(^|[^\w$."'])\bsettings\b/.test(code), "модуль читает settings напрямую, а не через getSettings()");
  });

  await test("context-ui: чип — кнопка с подсказкой о ручном окне", () => {
    assert.ok(/id="ctx-indicator"[^>]*role="button"/.test(HTML_SRC), "чип не кнопка — мышью и с клавиатуры не открыть");
    assert.ok(/id="ctx-indicator"[^>]*tabindex="0"/.test(HTML_SRC), "чип не берёт фокус с клавиатуры");
    assert.ok(/Нажми, чтобы задать окно вручную/.test(HTML_SRC), "подсказка чипа не объясняет, что он кликабелен");
    assert.ok(/\.ctx-popover \{/.test(CSS_SRC), "нет стилей попапа — он раскроется без фона и рамки");
    assert.ok(/\.ctx-opt\.active/.test(CSS_SRC), "выбранное значение не подсвечивается");
    assert.ok(/\.composer \{[\s\S]{0,80}position: relative;/.test(CSS_SRC), "попапу не от чего отсчитываться: .composer не position: relative");
  });

  await test("context-ui: пресеты в разметке — 0/32k/64k/128k/200k/1M и «Своё…»", () => {
    assert.deepStrictEqual(PRESETS.map((p) => p.win), [0, 32000, 65536, 131072, 204800, 1000000, -1],
      "набор кнопок разъехался: " + JSON.stringify(PRESETS));
    assert.ok(/id="ctx-pop-input"[^>]*type="number"/.test(HTML_SRC), "нет поля для своего значения");
    assert.ok(/id="ctx-pop-apply"/.test(HTML_SRC), "нет кнопки «Применить»");
    assert.ok(/class="ctx-pop-hint"/.test(HTML_SRC), "нет подсказки для человека");
  });

  console.log("\n[2] Чип, попап и клики мимо");

  await test("context-ui: чип открывает попап, повторный клик закрывает", () => {
    const env = buildEnv();
    env.ctx.wire();
    const popup = env.$("ctx-popover");
    assert.ok(popup.classList.contains("hidden"), "попап открыт до клика");

    env.$("ctx-indicator").onclick();
    assert.ok(!popup.classList.contains("hidden"), "клик по чипу не открыл попап");
    assert.strictEqual(env.$("ctx-text").textContent, "", "модуль переписал подпись чипа за интерфейсом");

    env.$("ctx-indicator").onclick();
    assert.ok(popup.classList.contains("hidden"), "повторный клик не закрыл попап");
  });

  await test("context-ui: клик по пресету сохраняет окно, подтверждает и закрывает", () => {
    const env = buildEnv();
    env.ctx.wire();
    env.$("ctx-indicator").onclick();
    assert.strictEqual(activeWin(env), 0, "при «Авто» подсвечено не то");

    env.clickOpt(131072);
    assert.strictEqual(env.state.settings.contextWindow, 131072, "выбор не попал в настройки");
    assert.strictEqual(env.calls.saved, 1, "настройки не сохранены");
    assert.strictEqual(lastMsg(env), "Окно контекста: 128k", "о выборе не сказано: " + lastMsg(env));
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "попап остался открытым");
    assert.ok(env.$("ctx-indicator").classList.contains("manual"), "на чипе нет отметки ручного окна");

    // Задание «Авто» снимает ручное окно и отметку.
    env.$("ctx-indicator").onclick();
    assert.strictEqual(activeWin(env), 131072, "на открытии подсветка не обновилась");
    env.clickOpt(0);
    assert.strictEqual(env.state.settings.contextWindow, 0, "«Авто» не записано");
    assert.ok(!env.$("ctx-indicator").classList.contains("manual"), "отметка ручного окна осталась после «Авто»");
  });

  await test("context-ui: клик мимо и Escape закрывают, клик по чипу — нет", () => {
    const env = buildEnv();
    env.ctx.wire();
    env.mousedown(env.$("input"));
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "закрытый попап открылся от клика мимо");
    env.$("ctx-indicator").onclick();
    env.mousedown(env.$("ctx-pop-input"));
    assert.ok(!env.$("ctx-popover").classList.contains("hidden"), "клик внутри попапа закрыл его");
    env.mousedown(env.$("input"));
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "клик мимо не закрыл попап");
    env.$("ctx-indicator").onclick();
    env.keydown("Escape");
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "Escape не закрыл попап");
  });

  console.log("\n[3] Своё значение и его границы");

  await test("context-ui: «Своё…» раскрывает поле со значением по умолчанию", () => {
    const env = buildEnv();
    env.ctx.wire();
    env.$("ctx-indicator").onclick();
    const box = env.$("ctx-pop-custom");
    assert.ok(box.classList.contains("hidden"), "ряд «своё» открыт без запроса");

    env.clickOpt(-1);
    assert.ok(!box.classList.contains("hidden"), "«Своё…» не раскрыл поле");
    assert.strictEqual(env.$("ctx-pop-input").value, "32768", "поле не заполнено значением по умолчанию");
    assert.strictEqual(env.focusCalls[env.focusCalls.length - 1], "ctx-pop-input", "фокус не ушёл в поле");
  });

  await test("context-ui: своё значение сохраняется, мусор и границы отклоняются", () => {
    const env = buildEnv();
    env.ctx.wire();
    env.clickOpt(-1);
    env.$("ctx-pop-input").value = "120000";
    env.$("ctx-pop-apply").onclick();
    assert.strictEqual(env.state.settings.contextWindow, 120000, "своё значение не сохранилось");
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "попап остался открытым после «Применить»");

    env.$("ctx-indicator").onclick();
    env.$("ctx-pop-input").value = "чушь";
    env.$("ctx-pop-apply").onclick();
    assert.strictEqual(env.state.settings.contextWindow, 120000, "мусор из поля записался");
    assert.ok(/числом/.test(lastMsg(env)), "о мусоре не сказано: " + lastMsg(env));

    env.$("ctx-pop-input").value = "500";
    env.$("ctx-pop-apply").onclick();
    assert.strictEqual(env.state.settings.contextWindow, 120000, "слишком маленькое окно записалось");
    assert.ok(/от 4000 до 8000000/.test(lastMsg(env)), "границы не названы: " + lastMsg(env));
  });

  await test("context-ui: испорченное значение в настройках читается как «Авто»", () => {
    const env = buildEnv({ settings: { contextWindow: "чушь" } });
    assert.strictEqual(env.ctx.current(), 0, "мусор в настройках стал окном");
    const low = buildEnv({ settings: { contextWindow: 100 } });
    assert.strictEqual(low.ctx.current(), 4000, "окно ниже нижней границы не поднято");
    const high = buildEnv({ settings: { contextWindow: 99_000_000 } });
    assert.strictEqual(high.ctx.current(), 8000000, "окно выше верхней границы не срезано");
    assert.strictEqual(env.ctx.fmtWindow(0), "Авто", "0 — не «Авто»");
    assert.strictEqual(env.ctx.fmtWindow(131072), "128k", "подпись 128k-пресета собрана неверно");
    assert.strictEqual(env.ctx.fmtWindow(1000000), "1M", "подпись миллиона собрана неверно");
  });

  await test("context-ui: сломанные настройки не роняют чип", () => {
    const env = buildEnv({ settingsThrows: true });
    assert.strictEqual(env.ctx.current(), 0, "сломанные настройки уронили чтение окна");
    env.ctx.wire();
    assert.ok(env.$("ctx-popover").classList.contains("hidden"), "попап открылся сам");
  });

  console.log("\n[4] Ручное окно решает прогон и переживает сохранение");

  await test("context-ui: прогон берёт ручное окно вместо авто-определения", () => {
    assert.ok(/settings\.contextWindow/.test(RUN_SRC), "прогон не читает ручное окно");
    assert.ok(/modelWin = manualWindow;/.test(RUN_SRC), "ручное окно не перебивает найденное");
    assert.ok(/budget = windowBudget\(provider, manualWindow, manualWindow/.test(RUN_SRC),
      "бюджет не считается от ручного окна (нет резерва на ответ)");
    // Ручное окно, равное нижней границе, не должно дать бюджет ниже 3000.
    assert.ok(/Math\.max\(budget, Math\.min\(3000, manualWindow\)\)/.test(RUN_SRC),
      "нет нижнего предела бюджета для ручного окна");
  });

  await test("context-ui: выбранное окно переживает save/load настроек", () => {
    // Настоящее хранилище здесь не поднимаем (это делает settings-store.test.js):
    // проверяем, что поле вообще есть в схеме и нормализуется, а не теряется.
    const store = read("src", "settings-store.js");
    assert.ok(/\bcontextWindow: 0,/.test(store), "в схеме настроек нет contextWindow по умолчанию");
    assert.ok(/s\.contextWindow = Math\.max\(0, Math\.min\(8000000, Math\.round\(Number\(s\.contextWindow\) \|\| 0\)\)\);/.test(store),
      "значение ручного окна не нормализуется при чтении");
  });

  console.log("\n[5] Набор в цепочке");

  await test("context-ui: набор стоит в цепочке npm test — иначе это не набор", () => {
    const chain = String((PKG.scripts && PKG.scripts.test) || "");
    assert.ok(chain.indexOf("test/context-ui.test.js") >= 0,
      "набор не попал в цепочку npm test (правило проекта: набор вне цепочки — это не набор)");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

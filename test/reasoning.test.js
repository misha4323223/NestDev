"use strict";

/* ── Рассуждения модели: плашка и попап (src/renderer/reasoning.js) ──────────
   Запуск: node test/reasoning.test.js   (входит в общий `npm test`)

   Почему набор появился позже самого модуля. reasoning.js писался по образцу
   соседей, но его UMD-хвост ВЫЗЫВАЛ фабрику (`root.Reasoning = factory()`), а
   оболочка, как и у остальных модулей окна, зовёт её фабрикой:
   `window.Reasoning({...})`. В итоге `window.Reasoning` — обычный объект, и
   первый же вызов падал с «window.Reasoning is not a function»: верхний catch
   в app.js показывал «Окно не работает» и остальная настройка окна не
   выполнялась. Ни один набор этого не видел — у модуля не было своего набора.
   Поэтому здесь проверяется В ПЕРВУЮ ОЧЕРЕДЬ форма модуля (наружу фабрика, как
   у chat-send/model-popup/g4f-panel), а дальше — то, ради чего жмут 🧠:

     • кнопка называет уровень и подсвечивается, когда рассуждения включены;
     • попап открывается списком из четырёх уровней и закрывается повторным кликом;
     • выбор ложится в настройки, сохраняется, подтверждается словами и подсветкой;
     • чужой или испорченный уровень — это «Выкл», а не сломанный запрос;
     • два попапа на одном месте не открыты одновременно — в обе стороны;
     • плашка есть не у всех: у модели без рассуждений её НЕТ, у неизвестной — есть;
     • у такой модели уровень не уезжает в запрос, но выбор в настройках не теряется;
     • отказ провайдера («поля рассуждений не знаю») помнится по модели, а не на раунд.

   Кто умеет рассуждать, решает provider-transport.js (reasoningSupport) — по имени
   модели и без запроса, поэтому ответ один для окна, телефона и браузера. Здесь
   проверяется и его таблица имён (транспорт подключён живой, а не пересказан).

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
const MODULE_SRC = read("src", "renderer", "reasoning.js");
const POPUP_SRC = read("src", "renderer", "model-popup.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
const PKG = JSON.parse(read("package.json"));
// Единственное прямое чтение app.js: проверка границы «код уехал в модуль, в
// оболочке осталась только сборка». Всё поведение берётся из настоящего модуля.
const APP_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

// ── Игрушечное окно: только те id, что есть в разметке ──────────────────────
function buildEnv(world) {
  const o = world || {};
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Классы из НАСТОЯЩЕЙ разметки: попап в окне уже скрыт, и заглушка обязана
  // начинать с того же состояния — иначе проверка «открылся» была бы ложной.
  const initialClasses = new Map();
  for (const tag of HTML_SRC.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag[0]);
    initialClasses.set(tag[1], new Set((cls ? cls[1] : "").split(/\s+/).filter(Boolean)));
  }

  // Что лежит ВНУТРИ попапов (из настоящей разметки): без этого клик по строке
  // списка считался бы кликом мимо попапа.
  const INNER = {
    "reasoning-popup": ["rp-title", "rp-list", "rp-close"],
    "model-popup": ["mp-title", "mp-list", "mp-close", "mp-refresh", "mp-settings"],
  };
  for (const [popup, ids] of Object.entries(INNER)) {
    assert.ok(HTML_SRC.includes('id="' + popup + '"'), "в разметке нет #" + popup);
    for (const id of ids) assert.ok(HTML_SRC.includes('id="' + id + '"'), "в разметке нет #" + id);
  }

  const els = new Map();
  function mkEl(id) {
    let cls = new Set(initialClasses.get(id) || []);
    const node = {
      id: id, value: "", textContent: "", title: "", type: "", disabled: false,
      className: "", children: [], onclick: null, _html: "", dataset: {},
      listeners: {},
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
        toggle: (c, on) => {
          const want = on === undefined ? !cls.has(c) : !!on;
          if (want) cls.add(c);
          else cls.delete(c);
          return want;
        },
      },
      appendChild(c) { node.children.push(c); return c; },
      contains(n) {
        const inner = INNER[id];
        if (inner) return n === node || (n && inner.indexOf(n.id) >= 0) || node.children.indexOf(n) >= 0;
        return n === node || node.children.indexOf(n) >= 0;
      },
      addEventListener(t, fn) { (node.listeners[t] = node.listeners[t] || []).push(fn); },
    };
    Object.defineProperty(node, "innerHTML", {
      configurable: true,
      get() { return node._html; },
      set(v) { node._html = String(v == null ? "" : v); node.children.length = 0; },
    });
    return node;
  }

  const $ = (id) => {
    assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  };

  const calls = { msgs: [], saved: 0, docListeners: {} };
  const state = { settings: Object.assign({}, o.settings || {}) };

  const docListeners = calls.docListeners;
  const sharedDocument = {
    getElementById: $,
    createElement: () => mkEl("created"),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  };

  // Оба попапа стоят на одном месте, поэтому собираются в ОДНОМ окне: так
  // проверяется и обратная связь (модель закрывает рассуждения), а не только
  // строка в исходнике.
  function load(src, filename, deps) {
    const box = {
      module: { exports: {} },
      self: {},
      Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
      console: { log() {}, warn() {}, error() {} },
      document: sharedDocument,
    };
    vm.runInNewContext(src, box, { filename: filename });
    assert.strictEqual(typeof box.module.exports, "function",
      filename + ": модуль не отдал фабрику — окно упадёт на «is not a function»");
    return box.module.exports(deps);
  }

  const getSettings = o.settingsThrows
    ? () => { throw new Error("настройки недоступны"); }
    : () => state.settings;
  const toast = (t) => calls.msgs.push(t);

  const reasoning = load(MODULE_SRC, "reasoning.js", {
    $, toast, getSettings,
    persistSettings: () => { calls.saved++; },
    // «Умеет ли модель рассуждать» решает транспорт; в наборе — управляемая заглушка,
    // чтобы проверить и «не умеет» (плашки нет), и «не понять» (плашка есть).
    support: o.support,
  });
  const modelPopup = load(POPUP_SRC, "model-popup.js", {
    $, toast, isElectron: true,
    api: { listModels: async () => ({ ok: true, models: [] }) },
    AgentCore: { listModels: async () => ({ ok: true, models: [] }) },
    persistSettings: () => {},
    PRESET_LABEL: {}, MODEL_KEY: {}, MODEL_INPUT: {},
    cachedModels: {},
    getSettings,
    getSettingsPanel: () => ({ updateBadge() {}, openSettings() {} }),
  });

  return {
    reasoning, modelPopup, $, calls, state,
    exports: Object.keys(reasoning).sort(),
    mousedown: (target) => (docListeners.mousedown || []).forEach((fn) => fn({ target })),
  };
}

// Объекты из песочницы живут в своём окружении — сравниваем значения, приведя к обычным.
const plain = (v) => JSON.parse(JSON.stringify(v));
const lastMsg = (env) => env.calls.msgs[env.calls.msgs.length - 1] || "";
const items = (env) => env.$("rp-list").children;
const itemOf = (env, id) => items(env).find((b) => b.dataset.reasoning === id);
const activeItem = (env) => items(env).find((b) => b.className.includes("active"));

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("reasoning: разметка грузит модуль до app.js, мост отдаёт его телефону", () => {
    const tag = HTML_SRC.indexOf('src="reasoning.js"');
    assert.ok(tag > 0, "разметка не грузит reasoning.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "reasoning.js подключён после app.js");
    assert.ok(/"reasoning\.js"/.test(BRIDGE_SRC), "мост не отдаёт reasoning.js телефону");
  });

  await test("reasoning: модуль отдаёт ФАБРИКУ, а не готовый объект", () => {
    // Та самая поломка: `root.Reasoning = factory()` отдавал объект, и вызов
    // `window.Reasoning({...})` в браузере/на телефоне/на ПК падал целиком.
    const box = { module: { exports: {} }, self: {} };
    vm.runInNewContext(MODULE_SRC, box, { filename: "reasoning.js" });
    assert.strictEqual(typeof box.module.exports, "function",
      "наружу отдан готовый объект: window.Reasoning({...}) упадёт с «is not a function»");
    assert.ok(APP_SRC.includes("const Reasoning = window.Reasoning({"), "оболочка не собирает модуль фабрикой");
    for (const dep of [
      "$: $,", "toast: toast,", "getSettings: () => settings,",
      "persistSettings: () => ChatStore.persistSettings(),",
    ]) {
      assert.ok(APP_SRC.includes(dep), "в проводку не передан " + dep);
    }
    assert.ok(APP_SRC.includes("Reasoning.wire();"), "кнопка 🧠 не подключена к модулю");
    assert.ok(APP_SRC.includes("getReasoning: () => Reasoning.get(),"), "уровень не доезжает до отправки сообщения");
  });

  await test("reasoning: в оболочке только сборка, сам код живёт в модуле", () => {
    for (const gone of [
      "const LEVELS = [", "function updateButton", "function levelOf",
      '$("btn-reasoning")', '$("rp-list")', '"reasoning-popup"',
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код рассуждений остался в app.js: " + gone);
    }
    // Границы модуля: настройки — только через getSettings(), чужих глобалов нет.
    const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bare of ["settings", "localStorage"]) {
      assert.ok(!new RegExp("(^|[^\\w$.\"'])" + bare + "\\b").test(code), "модуль читает " + bare + " напрямую");
    }
    assert.ok(!/\bwindow\.api\b/.test(code), "модуль лезет в чужие глобалы");
  });

  console.log("\n[2] Кнопка, попап и клики мимо");

  await test("reasoning: кнопка называет уровень и подсвечивается, когда он включён", () => {
    const env = buildEnv();
    env.reasoning.wire();
    const btn = env.$("btn-reasoning");
    // Подпись кнопки живёт в своём span: значок — SVG в разметке, и запись в
    // textContent самой кнопки стёрла бы его.
    const label = env.$("reasoning-label");
    assert.strictEqual(label.textContent, "Рассуждения", "кнопка не названа по умолчанию: " + label.textContent);
    assert.ok(!btn.classList.contains("active"), "кнопка подсвечена при выключенных рассуждениях");
    assert.ok(/Сейчас выключено/.test(btn.title), "подсказка кнопки не говорит, что выключено: " + btn.title);

    env.state.settings.reasoning = "max";
    env.reasoning.updateButton();
    assert.strictEqual(label.textContent, "Рассуждения · Максимум", "кнопка не показала включённый уровень: " + label.textContent);
    assert.ok(btn.classList.contains("active"), "включённый уровень не подсвечен");
    assert.ok(/Максимум/.test(btn.title), "подсказка кнопки не назвала уровень: " + btn.title);
  });

  await test("reasoning: попап открывается списком уровней, повторный клик закрывает", () => {
    const env = buildEnv();
    env.reasoning.wire();
    const popup = env.$("reasoning-popup");
    assert.ok(popup.classList.contains("hidden"), "попап открыт до клика");

    env.$("btn-reasoning").onclick();
    assert.ok(!popup.classList.contains("hidden"), "клик по 🧠 не открыл попап");
    assert.strictEqual(env.$("rp-title").textContent, "Рассуждения модели", "заголовок попапа потерян");
    assert.deepStrictEqual(items(env).map((b) => b.dataset.reasoning), ["off", "low", "high", "max"],
      "список уровней неполный или в другом порядке");
    assert.deepStrictEqual(items(env).map((b) => b.children[0].textContent), ["Выкл", "Низкий", "Высокий", "Максимум"],
      "подписи уровней разъехались");
    for (const b of items(env)) {
      assert.ok(b.children[1] && b.children[1].textContent.length > 10, "уровень без объяснения: " + b.dataset.reasoning);
      assert.strictEqual(b.children[1].textContent, b.title, "подсказка строки и её текст разошлись");
    }
    assert.ok(activeItem(env) && activeItem(env).dataset.reasoning === "off", "текущий уровень не подсвечен");

    env.$("btn-reasoning").onclick();
    assert.ok(popup.classList.contains("hidden"), "повторный клик не закрыл попап");
    // Список перерисовывается только на открытии: закрытый попап не трогает разметку.
    env.state.settings.reasoning = "high";
    assert.strictEqual(activeItem(env).dataset.reasoning, "off", "закрытый попап перерисовался");
    env.$("btn-reasoning").onclick();
    assert.strictEqual(activeItem(env).dataset.reasoning, "high", "на открытии подсветка не обновилась");
  });

  await test("reasoning: крестик и клик мимо закрывают, клик по самой кнопке — нет", () => {
    const env = buildEnv();
    env.reasoning.wire();
    const popup = env.$("reasoning-popup");
    env.$("rp-close").onclick();
    assert.ok(popup.classList.contains("hidden"), "крестик не закрыл попап");

    env.$("btn-reasoning").onclick();
    env.mousedown(env.$("rp-list"));
    assert.ok(!popup.classList.contains("hidden"), "клик по списку закрыл попап");
    env.mousedown(env.$("btn-reasoning"));
    assert.ok(!popup.classList.contains("hidden"), "клик по самой кнопке закрыл попап (двойной обработчик)");
    env.mousedown(env.$("input"));
    assert.ok(popup.classList.contains("hidden"), "клик мимо не закрыл попап");
    env.mousedown(env.$("input"));
    assert.ok(popup.classList.contains("hidden"), "закрытый попап открылся от клика мимо");
  });

  console.log("\n[3] Выбор уровня и его память");

  await test("reasoning: выбор ложится в настройки, сохраняется и подтверждается", () => {
    const env = buildEnv();
    env.reasoning.wire();
    env.$("btn-reasoning").onclick();
    itemOf(env, "low").onclick();
    assert.strictEqual(env.state.settings.reasoning, "low", "выбор не попал в настройки");
    assert.strictEqual(env.calls.saved, 1, "настройки не сохранены");
    assert.ok(env.$("reasoning-popup").classList.contains("hidden"), "попап остался открытым");
    assert.strictEqual(env.$("reasoning-label").textContent, "Рассуждения · Низкий", "кнопка не показала выбор");
    assert.strictEqual(lastMsg(env), "Рассуждения: Низкий", "о выборе не сказано: " + lastMsg(env));

    env.$("btn-reasoning").onclick();
    itemOf(env, "off").onclick();
    assert.strictEqual(env.state.settings.reasoning, "off", "«Выкл» не записался");
    assert.strictEqual(env.calls.saved, 2, "выключение не сохранилось");
    assert.strictEqual(env.$("reasoning-label").textContent, "Рассуждения", "кнопка не сбросилась");
    assert.strictEqual(lastMsg(env), "Рассуждения модели выключены", "выключение не подтверждено: " + lastMsg(env));
  });

  await test("reasoning: чужой уровень — это «Выкл», а не сломанный запрос", () => {
    const env = buildEnv({ settings: { reasoning: "HIGH" } });
    assert.deepStrictEqual(env.exports, [
      "IDS", "LEVELS", "close", "get", "labelFor", "markUnsupported", "normalize", "set", "supports",
      "toggle", "updateButton", "wire",
    ], "наружу торчит лишнее или чего-то не хватает: " + env.exports.join(", "));
    assert.deepStrictEqual(plain(env.reasoning.IDS), ["off", "low", "high", "max"], "список уровней разъехался");
    assert.strictEqual(env.reasoning.normalize(" HIGH "), "high", "регистр и пробелы не нормализованы");
    assert.strictEqual(env.reasoning.normalize("maximum"), "off", "чужое значение не сведено к «Выкл»");
    assert.strictEqual(env.reasoning.normalize(undefined), "off", "пустое значение не «Выкл»");
    assert.strictEqual(env.reasoning.normalize(42), "off", "число не сведено к «Выкл»");
    assert.strictEqual(env.reasoning.get(), "high", "уровень из настроек не прочитан");
    assert.strictEqual(env.reasoning.labelFor("off"), "Рассуждения", "подпись «Выкл» названа не как «Рассуждения»");
    assert.strictEqual(env.reasoning.labelFor("max"), "Рассуждения · Максимум", "подпись уровня не собрана");
    assert.deepStrictEqual(plain(env.reasoning.LEVELS.map((l) => l.id)), ["off", "low", "high", "max"],
      "уровни переопределены");
  });

  await test("reasoning: сломанные настройки не роняют чтение уровня", () => {
    const env = buildEnv({ settingsThrows: true });
    assert.strictEqual(env.reasoning.get(), "off", "сломанные настройки уронили чтение уровня");
    env.reasoning.set("чушь");
    assert.strictEqual(env.reasoning.get(), "off", "чужое значение записалось в настройки");
    assert.strictEqual(env.$("reasoning-label").textContent, "Рассуждения", "кнопка не сбросилась в «Выкл»");
  });

  console.log("\n[4] Плашка только там, где модель умеет рассуждать");

  await test("reasoning: плашку прячет только известное «не умеет»", () => {
    const seen = { verdict: "unknown" };
    const env = buildEnv({ support: () => seen.verdict });
    env.reasoning.wire();
    const btn = env.$("btn-reasoning");
    assert.ok(!btn.classList.contains("hidden"),
      "неизвестная модель осталась без плашки — прятать работающую настройку по догадке нельзя");

    seen.verdict = "yes";
    env.reasoning.updateButton();
    assert.ok(!btn.classList.contains("hidden"), "у модели с рассуждениями плашки нет");
    assert.strictEqual(env.reasoning.supports(), "yes", "поддержка не называется наружу");

    seen.verdict = "no";
    env.reasoning.updateButton();
    assert.strictEqual(env.reasoning.supports(), "no", "поддержка не называется наружу");
    assert.ok(btn.classList.contains("hidden"), "у модели без рассуждений плашка осталась");
    assert.ok(!btn.classList.contains("active"), "спрятанная плашка осталась подсвеченной");

    // Кнопки нет — и попапу взяться неоткуда: даже прямой вызов ничего не открывает.
    env.reasoning.toggle();
    assert.ok(env.$("reasoning-popup").classList.contains("hidden"), "попап открылся у модели без рассуждений");

    // Модель для нас неизвестна — ведём себя как раньше (плашка на месте).
    seen.verdict = "unknown";
    env.reasoning.updateButton();
    assert.ok(!btn.classList.contains("hidden"), "неизвестная модель осталась без плашки");
  });

  await test("reasoning: у модели без рассуждений уровень не уезжает в запрос (и не теряется)", () => {
    const seen = { verdict: "no" };
    const env = buildEnv({ settings: { reasoning: "max" }, support: () => seen.verdict });
    env.reasoning.wire();
    assert.strictEqual(env.reasoning.get(), "off", "уровень уехал в запрос к модели, которая не умеет рассуждать");
    assert.strictEqual(env.state.settings.reasoning, "max", "выбор человека стёрся из настроек");

    seen.verdict = "yes";
    env.reasoning.updateButton();
    assert.strictEqual(env.reasoning.get(), "max", "выбор не вернулся вместе с моделью, которая умеет рассуждать");
    assert.strictEqual(env.$("reasoning-label").textContent, "Рассуждения · Максимум", "кнопка не показала запомненный уровень");
  });

  await test("reasoning: провайдер отказал полю — помним отказ по модели, а не на раунд", () => {
    const env = buildEnv({ settings: { provider: "openai", model: "gpt-4o", reasoning: "high" } });
    env.reasoning.wire();
    // Отказ приходит из прогона строкой «провайдер|модель» (событие reasoning_unsupported).
    assert.strictEqual(env.reasoning.markUnsupported("openai|gpt-4o"), true, "отказ не запомнился");
    assert.strictEqual(env.calls.saved, 1, "память об отказе не сохранена");
    assert.strictEqual(plain(env.state.settings.reasoningUnsupported)["openai|gpt-4o"], true, "ключ модели не записан");
    assert.strictEqual(env.reasoning.supports(), "no", "модель с отказом всё ещё считается умеющей");
    assert.ok(env.$("btn-reasoning").classList.contains("hidden"), "плашка осталась у модели, которую сервер уже отклонил");
    assert.strictEqual(env.reasoning.get(), "off", "уровень всё ещё уезжает в запрос");

    // Второй раз то же самое не сохраняем: настройки не должны переписываться впустую.
    assert.strictEqual(env.reasoning.markUnsupported("openai|gpt-4o"), false, "отказ записался повторно");
    assert.strictEqual(env.calls.saved, 1, "повторный отказ сохранил настройки ещё раз");

    // Помним именно ключ «провайдер|модель»: отказ по соседней модели не делает
    // нерассуждающими все остальные.
    assert.strictEqual(env.reasoning.markUnsupported("openai|gpt-4o-mini"), true, "отказ по второй модели не запомнился");
    env.state.settings.model = "gpt-4o-mini";
    env.reasoning.updateButton();
    assert.ok(env.$("btn-reasoning").classList.contains("hidden"), "вторая модель с отказом осталась с плашкой");
    env.state.settings.model = "o3-mini"; // эта не отказывала — про неё мы ничего не знаем
    env.reasoning.updateButton();
    assert.ok(!env.$("btn-reasoning").classList.contains("hidden"), "чужая модель спрятала плашку у всех подряд");
    // Без имени модели запоминать нечего — и падать не на что: ключ не пишется.
    assert.strictEqual(env.reasoning.markUnsupported("openai|"), false, "отказ без имени модели записался");
    assert.ok(!plain(env.state.settings.reasoningUnsupported)["openai|"], "в настройки попал ключ без модели");
    // А пустой ключ — это «та самая модель»: событие без имени всё равно полезно.
    assert.strictEqual(env.reasoning.markUnsupported(""), true, "отказ по текущей модели не запомнился");
    assert.strictEqual(plain(env.state.settings.reasoningUnsupported)["openai|o3-mini"], true, "ключ текущей модели не записан");
  });

  await test("reasoning: кто умеет рассуждать — решает транспорт, по имени модели", () => {
    const transport = require(path.join(ROOT, "src", "renderer", "provider-transport.js"))({ config: {}, toolDefinitions: [] });
    assert.strictEqual(typeof transport.reasoningSupport, "function",
      "транспорт не отдаёт reasoningSupport — плашку не по чему прятать");
    const cases = [
      ["ollama", "gpt-oss:120b", "yes"],
      ["ollama", "deepseek-r1:7b", "yes"],
      ["ollama", "deepseek-r1-distill-llama-8b", "yes"], // «умеет» важнее «llama»
      ["ollama", "qwen3:8b", "yes"],
      ["ollama", "qwen2.5:7b", "no"],
      ["ollama", "llama3.2:3b", "no"],
      ["ollama", "gemma3:4b", "no"],
      ["ollama", "mistral:7b", "no"],
      ["openai", "openai/gpt-5", "yes"],
      ["openai", "o3-mini", "yes"],
      ["openai", "DeepSeek-V3.1", "yes"],
      ["openai", "gpt-4o", "no"],
      // Свой прокси или редкая сборка: не понять — и это НЕ повод спрятать настройку.
      ["openai", "my-custom-model", "unknown"],
      ["openai", "", "unknown"],
      // Claude: поля рассуждений туда не шлём вовсе — плашке нечего делать.
      ["anthropic", "claude-sonnet-4-5", "no"],
    ];
    for (const [p, m, want] of cases) {
      assert.strictEqual(transport.reasoningSupport(p, m), want, p + " · «" + m + "»: ждали " + want);
    }
  });

  await test("reasoning: оболочка подключает и подсказку модели, и пересборку плашки", () => {
    for (const wire of [
      "support: (provider, model) => AgentCore.reasoningSupport(provider, model),",
      "getReasoning: () => Reasoning,",
      "updateReasoning: () => Reasoning.updateButton(),",
    ]) {
      assert.ok(APP_SRC.includes(wire), "в проводку не передан " + wire);
    }
    // Ловушка того же рода, что и падение «window.Reasoning is not a function»: в окне
    // window.ProviderTransport — ФАБРИКА (объект собирает agent-core.js), и её свойство
    // равно undefined. Обращение к нему дало бы молчаливое «не понять» для всех моделей
    // сразу: плашка осталась бы везде, а ошибки не было бы ни в консоли, ни в окне.
    assert.ok(!/window\.ProviderTransport\./.test(APP_SRC),
      "оболочка читает свойство у ФАБРИКИ транспорта — надо AgentCore.reasoningSupport");
    const core = read("src", "renderer", "agent-core.js");
    assert.ok(/^\s+reasoningSupport,$/m.test(core.slice(0, core.indexOf("probeLocalModel"))),
      "ядро не забирает reasoningSupport у транспорта");
    assert.ok(/^\s+reasoningSupport,$/m.test(core.slice(core.lastIndexOf("return {"))),
      "ядро не отдаёт reasoningSupport наружу");
    // Плашка живёт по модели — все смены модели и провайдера проходят через значок
    // модели, значит пересобирать её надо там (иначе она останется от прежней модели).
    assert.ok(/if \(updateReasoning\) updateReasoning\(\);/.test(read("src", "renderer", "settings-panel.js")),
      "смена модели не обновляет плашку");
    assert.ok(/reasoning_unsupported/.test(read("src", "renderer", "chat-events.js")),
      "отказ провайдера не доходит до плашки");
    // Оба пути отказа: код на заголовках (run-retry) и ошибка внутри потока (run-ai) —
    // иначе часть моделей так и осталась бы с плашкой, которая только мешает.
    assert.ok(/type: "reasoning_unsupported"/.test(read("src", "run-retry.js")),
      "отказ провайдера (код на заголовках) не отправляется окну событием");
    assert.ok(/type: "reasoning_unsupported"/.test(read("src", "run-ai.js")),
      "отказ провайдера (ошибка в потоке) не отправляется окну событием");
  });

  console.log("\n[5] Два попапа на одном месте");

  await test("reasoning: попапы рассуждений и модели не открыты одновременно", () => {
    const env = buildEnv();
    env.reasoning.wire();
    env.modelPopup.toggleModelPopup();
    assert.ok(!env.$("model-popup").classList.contains("hidden"), "попап модели не открылся");

    env.$("btn-reasoning").onclick();
    assert.ok(!env.$("reasoning-popup").classList.contains("hidden"), "попап рассуждений не открылся");
    assert.ok(env.$("model-popup").classList.contains("hidden"), "два попапа открыты одновременно");

    env.modelPopup.toggleModelPopup();
    assert.ok(!env.$("model-popup").classList.contains("hidden"), "попап модели не открылся обратно");
    assert.ok(env.$("reasoning-popup").classList.contains("hidden"), "попап рассуждений остался под попапом модели");
  });

  console.log("\n[6] Набор в цепочке");

  await test("reasoning: набор стоит в цепочке npm test — иначе это не набор", () => {
    const chain = String((PKG.scripts && PKG.scripts.test) || "");
    assert.ok(chain.indexOf("test/reasoning.test.js") >= 0,
      "набор не попал в цепочку npm test (правило проекта: набор вне цепочки — это не набор)");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Быстрое переключение модели: попап в шапке (src/renderer/model-popup.js) ──
   Запуск: node test/model-popup.test.js   (входит в общий `npm test`)

   Попап вынесен из app.js своим модулем (этап A, часть 5). Ломается он тихо: окно
   открывается, а список моделей пуст или выбор не доезжает до настроек — и человек
   снова идёт в Настройки. Поэтому проверяется настоящий маршрут на заглушке окна:

     • открытие показывает список, повторный клик закрывает (и зря не перерисовывает);
     • заголовок называет провайдера, пустой кэш объясняется словами, список обрезан;
     • выбор модели пишет её и в общий `model`, и в поле провайдера, двигает поле
       настроек, сохраняет настройки, обновляет плашку и закрывает попап;
     • «↻ Обновить» идёт за живым списком (на ПК — в главный процесс, в браузере —
       напрямую), кнопка на время занята и возвращается, ошибка объясняется;
     • кэш — ОБЩИЙ с настройками объект (значение, а не копия), и в оболочке он
       нигде не переприсваивается: иначе копия молча разошлась бы с настоящим кэшем.

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
const MODULE_SRC = read("src", "renderer", "model-popup.js");
// Единственное прямое чтение app.js здесь — проверка «этого в оболочке больше нет»
// (ровно тот случай, ради которого тест «бюджет прямых чтений app.js» и оставлен).
const APP_SRC = read("src", "renderer", "app.js");
const HTML_SRC = read("src", "renderer", "index.html");
const BRIDGE_SRC = read("src", "mobile-bridge.js");

const PRESET_LABEL = { groq: "Groq", openai: "OpenAI", ollama: "Ollama" };
const MODEL_KEY = { ollama: "ollamaModel", openai: "openaiModel", anthropic: "anthropicModel" };
const MODEL_INPUT = { ollama: "s-ollama-model", openai: "s-openai-model", anthropic: "s-anth-model" };

// ── Игрушечное окно: только те id, что есть в разметке ──────────────────────
function buildModelPopup(world) {
  const o = world || {};
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const els = new Map();
  // Классы из НАСТОЯЩЕЙ разметки: попап в окне уже скрыт (class="model-popup hidden"),
  // и заглушка обязана начинать с того же состояния — иначе проверка была бы ложной.
  const initialClasses = new Map();
  for (const tag of HTML_SRC.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag[0]);
    initialClasses.set(tag[1], new Set((cls ? cls[1] : "").split(/\s+/).filter(Boolean)));
  }

  // Что лежит ВНУТРИ попапа (из настоящей разметки). Заглушка проверяет вложенность
  // по этому списку: без него клик по строке списка считался бы кликом мимо попапа.
  const INNER = ["mp-title", "mp-list", "mp-close", "mp-refresh", "mp-settings"];
  for (const id of INNER) assert.ok(HTML_SRC.includes('id="' + id + '"'), "в разметке нет #" + id);

  function mkEl(id) {
    let cls = new Set(initialClasses.get(id) || []);
    const node = {
      id: id, value: "", textContent: "", title: "", disabled: false,
      className: "", children: [], onclick: null, _html: "",
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
      contains(n) { return n === node || (n && INNER.indexOf(n.id) >= 0) || node.children.indexOf(n) >= 0; },
      addEventListener(t, fn) { node.listeners[t] = fn; },
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
  const calls = { msgs: [], desktopList: [], browserList: [], badges: 0, saved: 0, opened: [] };
  const state = {
    isElectron: o.isElectron === undefined ? true : o.isElectron,
    // Провайдер «openai» — как в жизни: Groq/DeepSeek и прочие пресеты идут именно
    // этим полем (своё у них только URL), и поле модели берётся из MODEL_INPUT.
    settings: Object.assign({ provider: "openai", model: "openai/gpt-oss-120b" }, o.settings || {}),
    cachedModels: o.cachedModels || { openai: ["openai/gpt-oss-120b", "llama-3.3-70b", "qwen-3-32b"] },
  };
  let pendingResolve = null;

  const listModelsResult = () => (o.listModelsResult === undefined ? { ok: true, models: ["m1", "m2"] } : o.listModelsResult);

  const box = {
    module: { exports: {} },
    self: {},
    console: { log() {}, warn() {}, error() {} },
    Object, Array, JSON, Date, Math, Promise, Error, String, RegExp, Number, Boolean, Set, Map,
    document: {
      getElementById: $,
      createElement: () => mkEl("created"),
      addEventListener: (t, fn) => { calls.docListeners = calls.docListeners || {}; calls.docListeners[t] = fn; },
    },
  };
  vm.runInNewContext(MODULE_SRC, box, { filename: "model-popup.js" });
  assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");

  const popup = box.module.exports({
    $, isElectron: state.isElectron,
    api: {
      listModels: async (cfg) => {
        calls.desktopList.push(cfg);
        if (o.listThrows) throw o.listThrows;
        if (o.listPending) return new Promise((r) => { pendingResolve = () => r(listModelsResult()); });
        return listModelsResult();
      },
    },
    AgentCore: {
      listModels: async (cfg, opts) => {
        calls.browserList.push({ cfg, opts });
        return listModelsResult();
      },
    },
    toast: (t) => calls.msgs.push(t),
    persistSettings: () => { calls.saved++; },
    PRESET_LABEL, MODEL_KEY, MODEL_INPUT,
    cachedModels: state.cachedModels,
    getSettings: () => state.settings,
    getSettingsPanel: () => ({
      updateBadge: () => { calls.badges++; },
      openSettings: (tab) => calls.opened.push(tab === undefined ? "" : tab),
    }),
  });

  return {
    popup, $, calls, state,
    exports: Object.keys(popup).sort(),
    resolveList: () => { if (pendingResolve) pendingResolve(); },
    mousedown: (target) => calls.docListeners.mousedown({ target }),
  };
}

const tick = () => new Promise((r) => setImmediate(r));
// Объекты из песочницы живут в своём окружении — сравниваем значения, приведя к обычным.
const plain = (v) => JSON.parse(JSON.stringify(v));
const items = (env) => env.$("mp-list").children;
const lastMsg = (env) => env.calls.msgs[env.calls.msgs.length - 1] || "";

(async () => {
  console.log("\n[1] Модуль на месте, оболочка только собирает его");

  await test("попап модели: модуль подключён до app.js и отдан телефону", () => {
    const tag = HTML_SRC.indexOf('src="model-popup.js"');
    assert.ok(tag > 0, "разметка не грузит model-popup.js");
    assert.ok(tag < HTML_SRC.indexOf('src="app.js"'), "model-popup.js подключён после app.js");
    assert.ok(/"model-popup\.js"/.test(BRIDGE_SRC), "мост не отдаёт model-popup.js телефону");
  });

  await test("попап модели: код ушёл из app.js, вызовы только переименованы", () => {
    for (const gone of [
      "function toggleModelPopup", "function closeModelPopup", "function renderModelPopup",
      "function selectModelQuick", "async function refreshModelsQuick",
      '$("model-badge").onclick', '$("mp-close").onclick', '$("mp-refresh").onclick',
    ]) {
      assert.ok(APP_SRC.indexOf(gone) === -1, "код попапа остался в app.js: " + gone);
    }
    assert.ok(APP_SRC.includes("ModelPopup.wireHeader();"), "шапка модели не подключена к модулю");
    assert.ok(APP_SRC.includes("toggleModelPopup: ModelPopup.toggleModelPopup,"), "панель проекта зовёт старую копию");
    assert.ok(MODULE_SRC.includes("function wireHeader()"), "модуль не навешивает события шапки");

    // Проводка: панель настроек объявлена НИЖЕ, поэтому внутрь идёт отложенная стрелка.
    const start = APP_SRC.indexOf("  const ModelPopup = window.ModelPopup({");
    assert.ok(start > 0, "в оболочке нет сборки модуля");
    const wiring = APP_SRC.slice(start, APP_SRC.indexOf("  });", start));
    for (const dep of [
      "$: $,", "isElectron: isElectron,", "api: api,", "AgentCore: AgentCore,", "toast: toast,",
      "persistSettings: ChatStore.persistSettings,", "PRESET_LABEL: PRESET_LABEL,", "MODEL_KEY: MODEL_KEY,",
      "MODEL_INPUT: MODEL_INPUT,", "cachedModels: cachedModels,", "getSettings: () => settings,",
      "getSettingsPanel: () => SettingsPanel,",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
  });

  await test("попап модели: кэш моделей общий с настройками и не переприсваивается", () => {
    // Кэш уходит в модуль ЗНАЧЕНИЕМ: это безопасно только пока оболочка его не
    // переприсваивает (иначе копия молча разошлась бы с настоящим кэшем).
    assert.ok(APP_SRC.includes("cachedModels: cachedModels,"), "кэш уходит в модуль копией?");
    assert.ok(/let cachedModels = \{\};/.test(APP_SRC), "объявление кэша пропало");
    const reassigned = APP_SRC.match(/cachedModels\s*=[^=]/g) || [];
    assert.strictEqual(reassigned.length, 1, "кэш где-то переприсваивается: " + JSON.stringify(reassigned));
    assert.ok(/let cachedModels = \{\};/.test(reassigned[0]) === false, "кэш переприсваивается вне объявления");
    assert.ok(MODULE_SRC.includes("cachedModels[provider] = models;"), "модуль не наполняет кэш");
  });

  console.log("\n[2] Открытие, список и выбор модели");

  await test("попап модели: открытие рисует список, повторный клик закрывает", () => {
    const env = buildModelPopup();
    const popupEl = env.$("model-popup");
    assert.ok(popupEl.classList.contains("hidden"), "попап открыт до клика");
    env.popup.toggleModelPopup();
    assert.ok(!popupEl.classList.contains("hidden"), "клик по плашке не открыл попап");
    assert.strictEqual(env.$("mp-title").textContent, "Модель · OpenAI", "заголовок не назвал провайдера: " + env.$("mp-title").textContent);
    assert.strictEqual(items(env).length, 3, "показаны не все модели: " + items(env).length);
    const active = items(env).find((b) => b.className.includes("active"));
    assert.ok(active && active.textContent === "openai/gpt-oss-120b", "текущая модель не подсвечена");

    env.popup.toggleModelPopup();
    assert.ok(popupEl.classList.contains("hidden"), "повторный клик не закрыл попап");
    // Список перерисовывается только на открытии: закрытый попап не трогает разметку.
    env.state.settings.provider = "ollama";
    assert.strictEqual(env.$("mp-title").textContent, "Модель · OpenAI", "закрытый попап перерисовался");
    env.popup.toggleModelPopup();
    assert.strictEqual(env.$("mp-title").textContent, "Модель · Ollama", "на открытии заголовок не обновился");
  });

  await test("попап модели: пустой кэш объясняется, неизвестный провайдер назван как есть, список обрезан", () => {
    const empty = buildModelPopup({ cachedModels: { openai: [] } });
    empty.popup.toggleModelPopup();
    assert.strictEqual(items(empty).length, 1, "на пустом кэше список не объяснён");
    assert.strictEqual(items(empty)[0].className, "mp-empty", "объяснение пустого кэша без своего класса");
    assert.ok(/Список моделей ещё не загружен/.test(items(empty)[0].textContent), "пустой кэш не объяснён словами: " + items(empty)[0].textContent);
    assert.ok(/открой Настройки/.test(items(empty)[0].textContent), "не сказано, что делать");

    const many = buildModelPopup({ cachedModels: { openai: Array.from({ length: 45 }, (_, i) => "m" + i) } });
    many.popup.toggleModelPopup();
    assert.strictEqual(items(many).length, 30, "список не обрезан до 30: " + items(many).length);

    const other = buildModelPopup({ settings: { provider: "свой-провайдер", model: "" }, cachedModels: {} });
    other.popup.toggleModelPopup();
    assert.strictEqual(other.$("mp-title").textContent, "Модель · свой-провайдер", "неизвестный провайдер потерял имя: " + other.$("mp-title").textContent);
  });

  await test("попап модели: выбор пишет модель и в настройки, и в поле провайдера", () => {
    const env = buildModelPopup();
    env.popup.toggleModelPopup();
    const chosen = items(env).find((b) => b.textContent === "qwen-3-32b");
    assert.ok(chosen, "модель не найдена в списке");
    chosen.onclick();
    assert.strictEqual(env.state.settings.model, "qwen-3-32b", "общая модель не сменилась");
    assert.strictEqual(env.state.settings.openaiModel, "qwen-3-32b", "поле провайдера не заполнено");
    assert.strictEqual(env.$("s-openai-model").value, "qwen-3-32b", "поле настроек не обновлено");
    assert.strictEqual(env.calls.saved, 1, "настройки не сохранены");
    assert.strictEqual(env.calls.badges, 1, "плашка модели не обновлена");
    assert.ok(env.$("model-popup").classList.contains("hidden"), "попап остался открытым после выбора");
    assert.strictEqual(lastMsg(env), "Модель: qwen-3-32b", "о смене модели не сказано: " + lastMsg(env));
  });

  console.log("\n[3] «↻ Обновить»: живой список и ошибки");

  await test("попап модели: обновление занято на время и наполняет кэш", async () => {
    const env = buildModelPopup({ listPending: true });
    env.popup.wireHeader();
    env.popup.toggleModelPopup();
    const btn = env.$("mp-refresh");
    const done = btn.onclick(); // ответ ещё не пришёл — кнопка обязана быть занята
    assert.strictEqual(btn.disabled, true, "кнопка не занята во время загрузки");
    assert.strictEqual(btn.textContent, "Загружаю...", "кнопка не сказала, что загружает: " + btn.textContent);
    assert.strictEqual(env.calls.desktopList.length, 1, "за списком не пошли в главный процесс");
    env.resolveList();
    await tick();
    await tick();
    assert.strictEqual(btn.disabled, false, "кнопка осталась занятой после ответа");
    assert.strictEqual(btn.textContent, "↻ Обновить", "кнопка не вернула подпись: " + btn.textContent);
    assert.deepStrictEqual(plain(env.state.cachedModels.openai), ["m1", "m2"], "живой список не попал в кэш");
    assert.strictEqual(items(env).length, 2, "попап не перерисован после загрузки: " + items(env).length);
    assert.strictEqual(lastMsg(env), "Моделей: 2", "о числе моделей не сказано: " + lastMsg(env));
    // Провайдер и модель в запросе: модель пустая — нужен список провайдера, а не активной модели.
    assert.strictEqual(env.calls.desktopList[0].provider, "openai", "запрос ушёл с другим провайдером");
    assert.strictEqual(env.calls.desktopList[0].model, "", "запрос ушёл с активной моделью");
    assert.strictEqual(env.calls.desktopList.length, 1, "за списком пошли больше одного раза");
    await done;
  });

  await test("попап модели: отказ и срыв объясняются человеку, в браузере спрашивают напрямую", async () => {
    const refused = buildModelPopup({ listModelsResult: { ok: false, message: "нет ключа" } });
    refused.popup.wireHeader();
    await refused.$("mp-refresh").onclick();
    assert.strictEqual(lastMsg(refused), "Ошибка: нет ключа", "отказ не объяснён: " + lastMsg(refused));
    assert.strictEqual(refused.$("mp-refresh").disabled, false, "кнопка осталась занятой после отказа");

    const broken = buildModelPopup({ listThrows: new Error("сеть легла") });
    broken.popup.wireHeader();
    await broken.$("mp-refresh").onclick();
    assert.strictEqual(lastMsg(broken), "Ошибка: сеть легла", "срыв не объяснён: " + lastMsg(broken));

    const web = buildModelPopup({ isElectron: false });
    web.popup.wireHeader();
    await web.$("mp-refresh").onclick();
    assert.strictEqual(web.calls.desktopList.length, 0, "в браузере пошли в главный процесс");
    assert.strictEqual(web.calls.browserList.length, 1, "в браузере не спросили ядро напрямую");
    assert.deepStrictEqual(plain(web.calls.browserList[0].opts), { fromBrowser: true }, "ядру не сказали, что запрос из браузера");
    assert.deepStrictEqual(plain(web.state.cachedModels.openai), ["m1", "m2"], "браузерный список не попал в кэш");
  });

  console.log("\n[4] События шапки");

  await test("попап модели: кнопки шапки и клик мимо попапа", async () => {
    const env = buildModelPopup();
    env.popup.wireHeader();
    const popupEl = env.$("model-popup");
    env.$("model-badge").onclick();
    assert.ok(!popupEl.classList.contains("hidden"), "плашка модели не открыла попап");
    env.$("mp-close").onclick();
    assert.ok(popupEl.classList.contains("hidden"), "крестик не закрыл попап");

    env.$("model-badge").onclick();
    env.$("mp-settings").onclick();
    assert.ok(popupEl.classList.contains("hidden"), "переход в настройки не закрыл попап");
    assert.deepStrictEqual(env.calls.opened, [""], "настройки не открылись: " + JSON.stringify(env.calls.opened));

    env.$("model-badge").onclick();
    const inside = env.$("mp-list");
    env.mousedown(inside);
    assert.ok(!popupEl.classList.contains("hidden"), "клик по списку закрыл попап");
    env.mousedown(env.$("input"));
    assert.ok(popupEl.classList.contains("hidden"), "клик мимо попапа не закрыл его");

    // На закрытом попапе клик мимо ничего не делает и не падает.
    env.mousedown(env.$("input"));
    assert.ok(popupEl.classList.contains("hidden"), "закрытый попап открылся от клика мимо");
    // Закрытый попап всё равно умеет обновлять список (кнопка не завязана на видимость).
    await env.$("mp-refresh").onclick();
    assert.strictEqual(env.$("mp-refresh").disabled, false, "кнопка обновления осталась занятой");
    assert.strictEqual(env.calls.desktopList.length, 1, "обновление из закрытого попапа не пошло");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

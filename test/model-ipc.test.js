"use strict";

/* ── Модели, замер локальной модели и G4F (src/model-ipc.js) ──────────────────
   Запуск: node test/model-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 2) и держит четыре канала, которые
   раньше жили в главном процессе: g4f:probe, g4f:test, ai:models, ai:probeLocal.

   Почему проверки поведенческие, а не «строка на месте»: у этих каналов ошибки
   тихие. Про поиск живого инстанса окно молчит, если вернуть «нашёл» без адреса;
   тест провайдера без чат-запроса показывает зелёный лог там, где провайдер не
   отвечает; замер локальной модели с ДРУГИМ размером контекста (num_ctx) заставит
   Ollama перезагрузить модель прямо перед следующим ответом — то есть замер сам
   сломает чат после себя. Поэтому каналы водятся по-настоящему: настоящий модуль,
   подставной fetch и записанные вызовы помощников ядра. Сети в тесте нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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
const MODULE_SRC = read("src", "model-ipc.js");
// Единственное прямое чтение main.js здесь — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");
const PRELOAD_SRC = read("src", "preload.js");
const MOBILE_SRC = read("src", "renderer", "mobile-api.js");

/* Подставной fetch: записывает запросы и отвечает по карте маршрутов.
   Маршрута нет — соединения нет (так и выглядит мёртвый порт). */
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    calls.push(method + " " + url);
    const r = routes[method + " " + url];
    if (!r) throw new Error("соединение отклонено");
    if (r.throw) throw new Error(r.throw);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body || "",
    };
  };
  return calls;
}

const modelsBody = (ids) => JSON.stringify({ data: ids.map((id) => ({ id: id })) });
const chatBody = (text) => JSON.stringify({ choices: [{ message: { content: text } }] });

/* Собираем НАСТОЯЩИЙ модуль его же фабрикой: так же, как это делает main.js. */
function build(o) {
  const opts = o || {};
  const handlers = new Map();
  const seen = { probeCalls: [], fetchModels: [], normalized: [], load: 0 };
  const core = {
    SYSTEM_PROMPT: "СИСТЕМА",
    ROUTER_MAX_TOKENS: 2000,
    estimateTokens: (t) => String(t).length,
    contextBudget: (provider, model) => (provider === "ollama" ? 8192 : 16384),
    windowBudget: (provider, budget, win, o2) => Math.min(budget, win) - (o2 && o2.local ? 512 : 0),
    modelWindow: async (s, m) => (opts.noWindow ? 0 : 32768),
    // Формула как в provider-transport.js: бюджет + запас 4096, но не больше окна модели.
    ollamaNumCtx: (budget, win) => {
      const b = Math.round(Number(budget) || 0);
      if (b <= 0) return 0;
      const need = b + 4096;
      const w = Math.round(Number(win) || 0);
      return w > 0 ? Math.min(need, w) : need;
    },
    isLocalEndpoint: (s) => /127\.0\.0\.1|localhost/.test(String((s && (s.ollamaUrl || s.openaiUrl)) || "")),
    fetchModels: async (s) => {
      seen.fetchModels.push(s);
      if (opts.modelsFail) throw new Error("сервер моделей молчит");
      return ["m1", "m2"];
    },
    probeLocalModel: async (s, model, call) => {
      seen.probeCalls.push({ settings: s, model: model, opts: call });
      if (opts.probeFail) throw new Error("Ollama не отвечает");
      return { ok: true, lines: ["✅ замер"] };
    },
  };
  const { registerModelIpc } = require(path.join(ROOT, "src", "model-ipc.js"));
  const mod = registerModelIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    loadSettings: () => {
      seen.load++;
      return opts.saved || { provider: "openai", model: "старая", openaiUrl: "http://localhost:8080/v1" };
    },
    normalizeSettings: (s) => {
      seen.normalized.push(s);
      return Object.assign({ provider: "openai", model: "" }, s);
    },
    ...core,
  });
  return { mod, handlers, seen, core };
}

(async () => {
  const realFetch = global.fetch;

  console.log("\n[1] g4f:probe — поиск живого инстанса");

  await test("поиск: указанный URL отвечает — вернулся он же и число моделей", async () => {
    const env = build();
    const calls = mockFetch({
      "GET http://мой-туннель.example/v1/models": { status: 200, body: modelsBody(["a", "b", "c"]) },
    });
    try {
      const r = await env.handlers.get("g4f:probe")(null, { url: "http://мой-туннель.example/v1/" });
      assert.strictEqual(r.ok, true, "живой указанный URL не найден: " + JSON.stringify(r));
      assert.strictEqual(r.base, "http://мой-туннель.example/v1", "вернулся адрес без хвостового слэша: " + r.base);
      assert.strictEqual(r.count, 3, "число моделей не посчитано: " + r.count);
      assert.strictEqual(calls.length, 1, "лишние запросы мимо указанного URL: " + calls.join(", "));
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("поиск: указанный порт мёртв — находится живой на 1337", async () => {
    const env = build();
    const calls = mockFetch({
      "GET http://localhost:1337/v1/models": { status: 200, body: modelsBody(["x"]) },
    });
    try {
      const r = await env.handlers.get("g4f:probe")(null, { url: "http://localhost:8080/v1" });
      assert.strictEqual(r.ok, true, "живой g4f на 1337 не найден");
      assert.strictEqual(r.base, "http://localhost:1337/v1", "вернулся не тот адрес: " + r.base);
      assert.ok(calls.indexOf("GET http://localhost:8080/v1/models") === 0, "проба началась не с указанного URL");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("поиск: ни один порт не отвечает — честное «не нашёл»", async () => {
    const env = build();
    mockFetch({});
    try {
      const r = await env.handlers.get("g4f:probe")(null, {});
      assert.deepStrictEqual(r, { ok: false }, "мертвый g4f выдан за живой: " + JSON.stringify(r));
      const direct = await env.mod.probeG4fBase("http://localhost:1337/v1");
      assert.strictEqual(direct, null, "прямой поиск вернул не null: " + JSON.stringify(direct));
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log("\n[2] g4f:test — тест провайдера с логом в консоль");

  await test("тест: пустой URL — один понятный отказ и ни одного запроса", async () => {
    const env = build();
    const calls = mockFetch({});
    try {
      const r = await env.handlers.get("g4f:test")(null, { url: "", provider: "HuggingChat", model: "gpt-4o-mini" });
      assert.strictEqual(r.ok, false, "тест без URL выдал успех");
      assert.deepStrictEqual(r.log.map((e) => e.level), ["info", "err"], "лог без URL расползся: " + JSON.stringify(r.log));
      assert.ok(/URL/.test(r.log[1].text), "отказ не говорит про поле URL: " + r.log[1].text);
      assert.deepStrictEqual(calls, [], "без URL ушли запросы: " + calls.join(", "));
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("тест: живой провайдер — модели, ответ модели и итог в логе", async () => {
    const env = build();
    const calls = mockFetch({
      "GET http://localhost:1337/v1/models": { status: 200, body: modelsBody(["gpt-4o-mini", "llama"]) },
      "POST http://localhost:1337/v1/chat/completions": { status: 200, body: chatBody("понг") },
    });
    try {
      const r = await env.handlers.get("g4f:test")(null, {
        url: "http://localhost:1337/v1",
        provider: "HuggingChat",
        model: "gpt-4o-mini",
      });
      assert.strictEqual(r.ok, true, "живой провайдер признан мёртвым");
      const text = r.log.map((e) => e.text).join("\n");
      assert.ok(/Моделей отдаёт: 2/.test(text), "в логе нет списка моделей: " + text);
      assert.ok(/понг/.test(text), "в логе нет ответа провайдера: " + text);
      assert.ok(/Проверка завершена за \d+ мс/.test(text), "в логе нет итога: " + text);
      assert.strictEqual(r.log[r.log.length - 1].level, "info", "лог не заканчивается итогом");
      // Провайдер уходит отдельным полем — на этом ломались современные сборки g4f.
      assert.ok(calls.indexOf("POST http://localhost:1337/v1/chat/completions") > 0, "чат-запрос не отправлен");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("тест: указанный порт мёртв — подсказка с адресом живого g4f", async () => {
    const env = build();
    mockFetch({
      "GET http://localhost:1337/v1/models": { status: 200, body: modelsBody(["x"]) },
    });
    try {
      const r = await env.handlers.get("g4f:test")(null, { url: "http://localhost:8080/v1", provider: "A", model: "m" });
      const text = r.log.map((e) => e.text).join("\n");
      assert.ok(/Живой g4f найден на/.test(text), "нет подсказки о живом порту: " + text);
      assert.ok(text.indexOf("http://localhost:1337/v1") >= 0, "подсказка без адреса живого инстанса: " + text);
      assert.ok(/Поправь URL/.test(text), "подсказка не говорит, что делать: " + text);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("тест: авто-режим и пустая модель — чат-запрос не отправляется", async () => {
    const env = build();
    const auto = mockFetch({ "GET http://localhost:1337/v1/models": { status: 200, body: modelsBody(["x"]) } });
    const empty = mockFetch({ "GET http://localhost:1337/v1/models": { status: 200, body: modelsBody(["x"]) } });
    try {
      const r1 = await env.handlers.get("g4f:test")(null, { url: "http://localhost:1337/v1", provider: "default", model: "m" });
      assert.ok(/авто-режим/.test(r1.log.map((e) => e.text).join("\n")), "авто-режим не объяснён");
      assert.ok(!auto.some((c) => c.startsWith("POST")), "в авто-режиме ушёл чат-запрос: " + auto.join(", "));

      const r2 = await env.handlers.get("g4f:test")(null, { url: "http://localhost:1337/v1", provider: "A", model: "" });
      assert.ok(/Модель не указана/.test(r2.log.map((e) => e.text).join("\n")), "не сказано, что нужна модель");
      assert.ok(!empty.some((c) => c.startsWith("POST")), "без модели ушёл чат-запрос: " + empty.join(", "));
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log("\n[3] ai:models — список моделей по настройкам");

  await test("модели: поля из окна накладываются на сохранённые настройки", async () => {
    const env = build({ saved: { provider: "openai", model: "старая", openaiUrl: "http://localhost:1337/v1" } });
    const r = await env.handlers.get("ai:models")(null, { model: "новая" });
    assert.strictEqual(r.ok, true, "список моделей не отдан: " + JSON.stringify(r));
    assert.deepStrictEqual(r.models, ["m1", "m2"], "список моделей подменён: " + JSON.stringify(r.models));
    const got = env.seen.normalized[0];
    assert.strictEqual(got.model, "новая", "поле из окна не перекрыло сохранённое: " + got.model);
    assert.strictEqual(got.provider, "openai", "потеряны сохранённые настройки: " + JSON.stringify(got));
    const asked = env.seen.fetchModels[0];
    assert.strictEqual(asked.model, "новая", "в запрос ушла не та модель: " + asked.model);
    assert.strictEqual(asked.provider, "openai", "в запрос ушли настройки без провайдера");
  });

  await test("модели: молчащий сервер — отказ с текстом и пустым списком", async () => {
    const env = build({ modelsFail: true });
    const r = await env.handlers.get("ai:models")(null, {});
    assert.strictEqual(r.ok, false, "отказ сервера выдан за успех");
    assert.deepStrictEqual(r.models, [], "при отказе вернулся непустой список");
    assert.ok(/сервер моделей молчит/.test(r.message || ""), "причина отказа потеряна: " + r.message);
  });

  console.log("\n[4] ai:probeLocal — замер локальной модели");

  await test("замер: num_ctx и бюджет считаются ровно как у чата", async () => {
    const env = build({ saved: { provider: "ollama", model: "qwen3:8b", ollamaUrl: "http://127.0.0.1:11434" } });
    const r = await env.handlers.get("ai:probeLocal")(null, {});
    assert.strictEqual(r.ok, true, "замер не прошёл: " + JSON.stringify(r));
    const call = env.seen.probeCalls[0];
    assert.ok(call, "замер не вызван");
    assert.strictEqual(call.model, "qwen3:8b", "замер ушёл не по той модели: " + call.model);
    assert.strictEqual(call.opts.window, 32768, "размер окна не передан в замер: " + call.opts.window);
    // contextBudget 8192, окно 32768, адрес локальный → 8192 − 512 = 7680.
    assert.strictEqual(call.opts.budget, 7680, "бюджет замера не совпал с чатовым: " + call.opts.budget);
    // Бюджет 7680 + запас 4096 = 11776 (окно 32768 не мешает) — ровно как в прогоне агента.
    assert.strictEqual(call.opts.numCtx, 11776, "num_ctx замера не совпал с чатовым: " + call.opts.numCtx);
    assert.strictEqual(call.opts.promptTokens, "СИСТЕМА".length + 2000 + 3000, "оценка запроса не посчитана: " + call.opts.promptTokens);
  });

  await test("замер: окно модели неизвестно — размер контекста не выдумывается", async () => {
    const env = build({ noWindow: true, saved: { provider: "ollama", model: "qwen3:8b" } });
    await env.handlers.get("ai:probeLocal")(null, {});
    assert.strictEqual(env.seen.probeCalls[0].opts.window, 0, "окно выдумано при неизвестном размере");
    assert.strictEqual(env.seen.probeCalls[0].opts.budget, 8192, "бюджет порезан без причины");
    assert.strictEqual(env.seen.probeCalls[0].opts.numCtx, 12288, "без известного окна запас контекста не запрошен");
  });

  await test("замер: сервер не ответил — отказ с понятной строкой, а не пустота", async () => {
    const env = build({ probeFail: true });
    const r = await env.handlers.get("ai:probeLocal")(null, {});
    assert.strictEqual(r.ok, false, "сорванный замер выдан за успех");
    assert.ok(/Ollama не отвечает/.test(r.error || ""), "причина сорванного замера потеряна: " + r.error);
    assert.ok(/❌/.test((r.lines || []).join("\n")), "нет строки отчёта об отказе: " + JSON.stringify(r.lines));
  });

  console.log("\n[5] Расположение кода и проводка");

  await test("вынос: каналов и функции поиска в main.js больше нет", () => {
    for (const gone of [
      'ipcMain.handle("g4f:probe"',
      'ipcMain.handle("g4f:test"',
      'ipcMain.handle("ai:models"',
      'ipcMain.handle("ai:probeLocal"',
      "async function probeG4fBase",
    ]) {
      assert.strictEqual(MAIN_SRC.indexOf(gone), -1, "код остался в main.js: " + gone);
    }
    for (const ch of ['ipcMain.handle("g4f:probe"', 'ipcMain.handle("g4f:test"', 'ipcMain.handle("ai:models"', 'ipcMain.handle("ai:probeLocal"']) {
      assert.ok(MODULE_SRC.indexOf(ch) >= 0, "канал не найден в модуле: " + ch);
    }
  });

  await test("проводка: main.js собирает модуль и передаёт ему всё нужное", () => {
    const at = MAIN_SRC.indexOf('const { registerModelIpc } = require("./model-ipc.js");');
    assert.ok(at > 0, "main.js не собирает модуль моделей");
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["ipcMain,", "loadSettings,", "normalizeSettings,", "fetchModels,", "SYSTEM_PROMPT,",
      "ROUTER_MAX_TOKENS,", "estimateTokens,", "contextBudget,", "windowBudget,", "modelWindow,",
      "ollamaNumCtx,", "isLocalEndpoint,", "probeLocalModel,"]) {
      assert.ok(wiring.includes(dep), "в проводку модуля не передан " + dep);
    }
  });

  await test("каналы: окно на ПК и телефон знают те же имена", () => {
    for (const dep of [
      'listModels: (ui) => ipcRenderer.invoke("ai:models", ui)',
      'probeLocalModel: (ui) => ipcRenderer.invoke("ai:probeLocal", ui)',
      'g4fTest: (opts) => ipcRenderer.invoke("g4f:test", opts)',
      'g4fProbe: (opts) => ipcRenderer.invoke("g4f:probe", opts)',
    ]) {
      assert.ok(PRELOAD_SRC.indexOf(dep) >= 0, "preload не знает канал: " + dep);
    }
    for (const ch of ['invoke("ai:models")', 'invoke("g4f:test")', 'invoke("g4f:probe")']) {
      assert.ok(MOBILE_SRC.indexOf(ch) >= 0, "мобильный API не знает канал: " + ch);
    }
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

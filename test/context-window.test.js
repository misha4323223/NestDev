"use strict";

/* ── Контекст диалога: обрезка и сжатие (src/renderer/context-window.js) ──────
   Запуск: node test/context-window.test.js   (входит в общий `npm test`)

   Зачем отдельный набор. Жалоба человека звучала так: «при длительной работе в
   одном чате агент начинает постоянно отключаться, пока я не перейду в чистый
   чат». Причина нашлась ровно та, о которой он и спрашивал, — история НЕ
   ужималась, и вот почему:

     1. `trimConversation` считала бюджет с конца, но затем ЛЮБОЙ ценой оставляла
        «последнее user-сообщение и всё после него». В длительной работе просьба
        ОДНА и стоит в начале, а после неё идут сотни шагов агента (вызовы
        инструментов и их результаты). Итог замера: 601 сообщение и 338 352
        токена при бюджете 3 000 — обрезка не обрезала НИЧЕГО. Провайдер отвечал
        «запрос больше окна», ступени ужатия (`shrinkContext` в run-ai.js) звали
        тот же путь и возвращали тот же запрос, и прогон умирал на третьей
        ступени — это и был «отключается». В чистом чате история короткая, и там
        всё работало.

     2. Граница сжатого куска (`keepFrom`) жила в замыкании менеджера, а история
        между вызовами ПЕРЕСОБИРАЕТСЯ (`canonical = [system, ...результат]`).
        После третьего сжатия старый номер указывал в середину другого массива:
        хвост схлопывался до одного сообщения, и агент терял и просьбу человека,
        и свежие шаги («пишет что-то и отключается»). Плюс памятка, уже лежавшая
        в истории, уезжала и в голову, и в хвост — то есть считалась дважды.

   Поэтому проверяется ПОВЕДЕНИЕ, а не строка на месте: число токенов на выходе,
   сохранность просьбы человека, свежего шага и пар assistant(tool_calls)→tool, и
   прогон из семидесяти раундов, где история пересобирается каждый раунд. */

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
const PKG = JSON.parse(read("package.json"));
const MODULE_SRC = read("src", "renderer", "context-window.js");

// Модуль берётся тем же способом, что в ядре: UMD-фабрика с подключением к
// провайдеру (кому и как отправить запрос за памяткой). Сеть подменяется в
// самих проверках: `callApi` берёт `fetch` в момент вызова.
const makeContext = () =>
  require(path.join(ROOT, "src", "renderer", "context-window.js"))({
    config: {
      baseFor: () => "https://example.invalid/v1",
      proxiedBase: (b) => b,
      apiKeyFor: () => "k",
      apiHeaders: () => ({}),
      projectHeader: () => null,
    },
    transport: { partsText: (parts) => parts.map((p) => p.text || "").join(" ") },
  });

const tokenSum = (ctx, arr) => arr.reduce((n, m) => n + ctx.estimateMessageTokens(m), 0);

const CHUNK = "строка старого контекста ".repeat(120);
const GOAL = { role: "user", content: "одна задача: дойти до конца" };

// История одной задачи: просьба одна и в начале, дальше только шаги агента.
function oneTaskHistory(steps) {
  const h = [{ role: GOAL.role, content: GOAL.content }];
  for (let i = 1; i <= steps; i++) {
    h.push({
      role: "assistant",
      content: CHUNK + " шаг " + i,
      tool_calls: [{ id: "c" + i, type: "function", function: { name: "runCommand", arguments: "{}" } }],
    });
    h.push({ role: "tool", tool_call_id: "c" + i, content: CHUNK });
  }
  return h;
}

const hasGoal = (arr) => arr.some((m) => m.content === GOAL.content);
const hasStep = (arr, n) => arr.some((m) => typeof m.content === "string" && m.content.indexOf("шаг " + n) >= 0);
const pairsOk = (arr) => {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].role !== "tool") continue;
    const prev = arr[i - 1];
    if (!(prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0)) return false;
  }
  return true;
};

(async () => {
  await test("набор в цепочке npm test, а ядро считает историю тем же модулем", () => {
    assert.ok(String(PKG.scripts.test).indexOf("test/context-window.test.js") >= 0, "набора нет в цепочке npm test");
    const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    const ctx = makeContext();
    for (const n of ["estimateTokens", "estimateMessageTokens", "sanitizeToolPairs", "trimConversation", "createContextManager"]) {
      assert.strictEqual(typeof ctx[n], "function", "модуль не отдаёт " + n);
      assert.strictEqual(typeof core[n], "function", "ядро не отдаёт " + n);
    }
    // Ядро собирает СВОЙ экземпляр той же фабрики, поэтому сравниваем не ссылки, а
    // поведение: если ядро когда-нибудь перестанет брать модуль, числа разойдутся.
    const msgs = oneTaskHistory(60);
    assert.strictEqual(
      JSON.stringify(core.trimConversation(msgs, 8000)),
      JSON.stringify(ctx.trimConversation(msgs, 8000)),
      "ядро считает историю иначе, чем модуль context-window.js"
    );
  });

  await test("обрезка: длительная работа одной задачи ужимается, а просьба человека остаётся", () => {
    // Тот самый замер: 601 сообщение / 338 352 токена при бюджете 3 000 — прежнее
    // правило «пользователь и всё после него» не давало обрезать ни одного шага.
    const ctx = makeContext();
    const msgs = [{ role: "user", content: "одна задача: " + "x".repeat(2000) }];
    for (let i = 1; i <= 300; i++) {
      msgs.push({ role: "assistant", content: "шаг " + i + " " + "y".repeat(2000), tool_calls: [{ id: "c" + i, type: "function", function: { name: "readFile", arguments: "{}" } }] });
      msgs.push({ role: "tool", tool_call_id: "c" + i, content: "результат " + i + " " + "z".repeat(2000) });
    }
    const before = tokenSum(ctx, msgs);
    assert.ok(before > 3000, "набор собран неверно: история меньше бюджета (" + before + ")");
    const trimmed = ctx.trimConversation(msgs, 3000);
    assert.ok(trimmed.length < msgs.length, "история не обрезана вообще (" + trimmed.length + ")");
    assert.ok(tokenSum(ctx, trimmed) <= 3000, "в бюджет не влезли: " + tokenSum(ctx, trimmed) + " токенов при бюджете 3 000");
    assert.strictEqual(trimmed[0].role, "user", "история начинается не с просьбы: " + trimmed[0].role);
    assert.ok(trimmed.some((m) => String(m.content).indexOf("результат 300") >= 0), "потерян свежий шаг");
    assert.ok(!trimmed.some((m) => String(m.content).indexOf("результат 1 ") >= 0), "самый старый шаг не обрезан");
    assert.ok(pairsOk(trimmed), "срез разорвал пару assistant(tool_calls)→tool");
    assert.strictEqual(msgs.length, 601, "обрезка изменила исходный массив");
  });

  await test("обрезка: свежий хвост сохраняется, а окно считается по бюджету", () => {
    const ctx = makeContext();
    const msgs = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: "U" + i + ":" + "x".repeat(200) });
      msgs.push({ role: "assistant", content: "A" + i + ":" + "y".repeat(200) });
    }
    const trimmed = ctx.trimConversation(msgs, 3000);
    assert.ok(trimmed.length > 1, "история схлопнулась до " + trimmed.length + " сообщения");
    assert.ok(trimmed.length < msgs.length, "история не обрезана (" + trimmed.length + ")");
    assert.ok(trimmed.some((m) => String(m.content).startsWith("U39:")), "потерян последний запрос пользователя");
    assert.ok(!trimmed.some((m) => String(m.content).startsWith("U0:")), "самое старое сообщение не обрезано");
    assert.strictEqual(trimmed[0].role, "user", "история начинается не с user: " + trimmed[0].role);
  });

  await test("сжатие недоступно: история всё равно ужимается, просьба и свежий шаг на месте", async () => {
    // Модель-памятка не отвечает (сжатие не сработало) — раньше это и был смертельный
    // случай: обрезка отдавала всю работу, провайдер отказывал, ступени ужатия
    // возвращали тот же запрос, и прогон падал на третьей ступени.
    const ctx = makeContext();
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "no" });
    try {
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const history = oneTaskHistory(120);
      const before = tokenSum(ctx, history);
      const cm = ctx.createContextManager({ settings, planMode: false });
      const out = await cm.manage(history, 12000);
      const after = tokenSum(ctx, out);
      assert.ok(before > 12000, "набор собран неверно: история меньше бюджета (" + before + ")");
      assert.ok(after <= 12000, "в запрос уехало " + after + " токенов при бюджете 12 000");
      assert.ok(hasGoal(out), "потеряна просьба человека — агент не знает, чего от него хотят");
      assert.ok(hasStep(out, 120), "потерян свежий шаг — агенту нечем продолжать");
      assert.ok(pairsOk(out), "после ужатия остались осиротевшие tool-сообщения");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("сжатие работает: 70 раундов, история пересобирается — просьба и свежие шаги не теряются", async () => {
    // Ядро пересобирает canonical из результата каждого manage(). Прежняя граница
    // сжатого куска, сохранённая в замыкании, после третьего сжатия указывала в
    // середину нового массива: хвост схлопывался, просьба пропадала.
    const ctx = makeContext();
    const realFetch = global.fetch;
    const bodies = [];
    global.fetch = async (url, o) => {
      bodies.push(String((o && o.body) || ""));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ПАМЯТКА: сделано то-то" } }] }), text: async () => "" };
    };
    try {
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const cm = ctx.createContextManager({ settings, planMode: false });
      let messages = [{ role: GOAL.role, content: GOAL.content }];
      let worst = 0;
      for (let r = 1; r <= 70; r++) {
        messages.push({ role: "assistant", content: CHUNK + " шаг " + r, tool_calls: [{ id: "c" + r, type: "function", function: { name: "runCommand", arguments: "{}" } }] });
        messages.push({ role: "tool", tool_call_id: "c" + r, content: CHUNK });
        messages = await cm.manage(messages, 12000);
        const t = tokenSum(ctx, messages);
        worst = Math.max(worst, t);
        assert.ok(t <= 12000, "раунд " + r + ": в запрос уехало " + t + " токенов при бюджете 12 000");
        assert.ok(hasGoal(messages), "раунд " + r + ": потеряна просьба человека");
        assert.ok(hasStep(messages, r), "раунд " + r + ": потерян свежий шаг");
        assert.ok(messages.filter((m) => m.role === "system").length <= 1, "раунд " + r + ": памяток в истории больше одной");
        assert.ok(pairsOk(messages), "раунд " + r + ": осиротевшее tool-сообщение");
      }
      assert.ok(bodies.length >= 2, "повторного сжатия не было: вызовов " + bodies.length);
      assert.ok(bodies.length <= 4, "сжатий больше лимита: " + bodies.length);
      assert.ok(bodies[1].indexOf("ПАМЯТКА") >= 0, "повторное сжатие не видит предыдущую памятку — свёрнутое потеряется");
      assert.ok(worst > 0, "история вообще не измерялась");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("памятка заменяет свёрнутый кусок, а не едет доплаткой", async () => {
    const ctx = makeContext();
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ПАМЯТКА" } }] }), text: async () => "" });
    try {
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const history = oneTaskHistory(40);
      const before = tokenSum(ctx, history);
      const cm = ctx.createContextManager({ settings, planMode: false, onMemo: () => {} });
      const out = await cm.manage(history, 2000);
      const after = tokenSum(ctx, out);
      assert.ok(out.length && out[0].role === "system" && /ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА/.test(out[0].content), "памятка не встала первой");
      assert.ok(hasGoal(out), "просьба человека потерялась — агент забудет, чего от него хотят");
      assert.ok(after < before / 2, "переписка не уменьшилась: было " + before + " токенов, стало " + after);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("обрезка не портит исходный массив и повторяется теми же числами", () => {
    const ctx = makeContext();
    const msgs = oneTaskHistory(60);
    const snapshot = JSON.stringify(msgs);
    const a = ctx.trimConversation(msgs, 8000);
    const b = ctx.trimConversation(msgs, 8000);
    assert.strictEqual(JSON.stringify(msgs), snapshot, "обрезка изменила входной массив");
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), "два одинаковых вызова дали разный результат");
    assert.ok(tokenSum(ctx, a) <= 8000, "в бюджет не влезли: " + tokenSum(ctx, a));
  });

  await test("модуль не привязывается к прежнему правилу «start = lastUser»", () => {
    // Сторож самой причины: если правило вернут, первый замер (338 352 токена при
    // бюджете 3 000) пройдёт молча — а это и был дефект.
    assert.ok(!/if \(lastUser >= 0 && start > lastUser\) start = lastUser;/.test(MODULE_SRC), "в обрезке вернулось правило, отдающее всю работу в запрос");
    assert.ok(MODULE_SRC.indexOf("windowStart") > 0, "обрезка больше не считает окно отдельной функцией");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

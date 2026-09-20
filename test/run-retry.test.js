"use strict";

/* ── Восстановление прогона после отказа запроса (src/run-retry.js) ───────────
   Запуск: node test/run-retry.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 16 — третий заход в ядро чата runAi).
   Он решает, что делать с неудовлетворительным ответом провайдера. Ошибки тут
   тихие и дорогие:

     • не подождали лимит 429 — раунд потерян, человек пишет «продолжай» руками;
     • не сбросили счётчики на успехе — прогон «сдаётся» посреди долгой работы;
     • «холодный» отказ пула приняли за фатальный — хотя он лечится повтором;
     • не ужали контекст — на модели с малым окном прогон падает навсегда;
     • не выключили stream_options — каждый раунд падает на одном и том же месте.

   Ядро (rateLimitInfo, coldCacheInfo, friendlyRateLimitError, UNAVAILABLE_MAX)
   берём настоящее — иначе проверка не увидит того же поведения, что и прогон.
   Пауза внедряется: тест не должен спать по-настоящему. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const { createRunRetry } = require(path.join(ROOT, "src", "run-retry.js"));

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

const CORE_DEPS = {
  friendlyRateLimitError: core.friendlyRateLimitError,
  rateLimitInfo: core.rateLimitInfo,
  coldCacheInfo: core.coldCacheInfo,
  UNAVAILABLE_MAX: core.UNAVAILABLE_MAX,
};

function makeRetry(opts) {
  const o = opts || {};
  const seen = { term: [], chat: [], pauses: [], shrink: 0, took: [], notes: [] };
  const limiter = {
    take: async () => {
      seen.took.push(1);
      return typeof o.paceMs === "number" ? o.paceMs : 0;
    },
    note: (info) => seen.notes.push(info),
  };
  let budget = typeof o.budget === "number" ? o.budget : 60000;
  const retry = createRunRetry(
    Object.assign({}, CORE_DEPS, {
      settings: o.settings || { provider: "openai" },
      provider: o.provider || "openai",
      emit: (e) => seen.chat.push(e),
      termEmit: (e) => seen.term.push(e),
      rateLimiter: limiter,
      getBudget: () => budget,
      shrinkContext: async () => {
        seen.shrink++;
        budget = Math.max(3000, Math.floor(budget * 0.4));
      },
      rateWaitBudgetMs: o.rateWaitBudgetMs,
      pause: async (ms) => {
        seen.pauses.push(ms);
      },
    })
  );
  return {
    retry,
    state: retry.state,
    seen,
    getBudget: () => budget,
    termText: () => seen.term.map((e) => e.text).join("\n"),
    chatText: () => seen.chat.map((e) => e.text || "").join("\n"),
  };
}

const RESP_429 = (detail) => ({ status: 429, headers: { get: () => null }, detail: detail || "rate limit exceeded" });

(async () => {
  // ── 429: ждём сами ────────────────────────────────────────────────────────
  await test("лимит 429: ждём и повторяем тот же раунд, никого не прося писать «продолжай»", async () => {
    const r = makeRetry();
    const v = await r.retry.plan(RESP_429("Please try again in 30s"));
    assert.strictEqual(v.kind, "repeat", "429 не повторяется: " + JSON.stringify(v).slice(0, 120));
    assert.strictEqual(v.what, "rate", "повтор 429 помечен не как лимит");
    assert.strictEqual(r.seen.pauses.length, 1, "паузы не было — раунд уйдёт в лимит снова");
    assert.ok(r.seen.pauses[0] >= 2000 && r.seen.pauses[0] <= 60000, "пауза вне разумных рамок: " + r.seen.pauses[0]);
    assert.strictEqual(r.state.rateRetries, 1, "попытка не посчитана");
    assert.strictEqual(r.state.rateWaitedMs, r.seen.pauses[0], "ожидание не накопилось");
    assert.ok(/жду 30 с и повторю сам \(попытка 1\)/.test(r.chatText()), "человеку не сказано, что прогон ждёт сам: " + r.chatText());
    assert.ok(/Всего в ожидании/.test(r.termText()), "в «Консоль» нет накопленного ожидания");
    assert.strictEqual(r.seen.notes.length, 1, "лимитер не узнал о лимите — следующий запрос снова уйдёт вслепую");
    // Второй отказ: ждём снова, счётчик и накопление растут.
    await r.retry.plan(RESP_429("try again in 5 seconds"));
    assert.strictEqual(r.state.rateRetries, 2, "вторая попытка не посчитана");
    assert.strictEqual(r.seen.pauses.length, 2, "второй паузы не было");
    assert.ok(r.state.rateWaitedMs > r.seen.pauses[0], "накопленное ожидание не растёт");
  });

  await test("лимит 429: пауза не выходит за бюджет ожидания, а исчерпание бюджета — честная ошибка", async () => {
    const r = makeRetry({ rateWaitBudgetMs: 2500 });
    await r.retry.plan(RESP_429("try again in 60 seconds"));
    assert.strictEqual(r.seen.pauses[0], 2500, "ждали не весь остаток бюджета: " + r.seen.pauses[0]);
    // Ждали сколько могли — дальше честно говорим и не висим вечно.
    const v = await r.retry.plan(RESP_429("try again in 60 seconds"));
    assert.strictEqual(v.kind, "throw", "бюджет исчерпан, а прогон всё ждёт");
    assert.ok(/Ждал сам \d+ с, но лимит не отпускает/.test(v.error.message), "не сказано, сколько ждали: " + v.error.message);
    assert.ok(/подожди минуту и напиши «продолжай»/.test(v.error.message), "нет понятного совета человеку");
    assert.strictEqual(r.seen.pauses.length, 1, "после исчерпания бюджета ещё ждали");
  });

  await test("успех снимает счётчики: иначе прогон «сдастся» после часа работы", async () => {
    const r = makeRetry();
    await r.retry.plan(RESP_429());
    await r.retry.plan({ status: 503, headers: { get: () => null }, detail: "cache_only_cold" });
    assert.ok(r.state.rateRetries > 0 && r.state.unavailableRetries > 0, "счётчики не набрались — проверка не о том");
    r.retry.noteSuccess();
    assert.strictEqual(r.state.rateRetries, 0, "счётчик лимита не сброшен");
    assert.strictEqual(r.state.unavailableRetries, 0, "счётчик сбоев пула не сброшен");
    assert.strictEqual(r.state.rateWaitedMs > 0, true, "накопленное ожидание сброшено — потолок ожидания перестанет работать");
  });

  // ── 503 и «холодный» пул ─────────────────────────────────────────────────
  await test("503 cache_only_cold: ждём столько, сколько просит ядро, и повторяем", async () => {
    const r = makeRetry();
    const cold = core.coldCacheInfo(503, "cache_only_cold", 1);
    const v = await r.retry.plan({ status: 503, headers: { get: () => null }, detail: "cache_only_cold" });
    assert.strictEqual(v.kind, "repeat", "«холодный» отказ пула не повторяется");
    assert.deepStrictEqual(r.seen.pauses, [cold.waitMs], "пауза не совпала с расчётом ядра: " + r.seen.pauses);
    assert.strictEqual(r.state.unavailableRetries, 1, "повтор не посчитан");
    assert.ok(r.termText().indexOf(cold.text) >= 0, "в «Консоль» не сказано, почему ждём");
  });

  await test("503 после исчерпания повторов: понятное объяснение, а не сырой JSON", async () => {
    const r = makeRetry();
    let last = null;
    for (let i = 0; i < core.UNAVAILABLE_MAX; i++) last = await r.retry.plan({ status: 503, headers: { get: () => null }, detail: "cache_only_cold" });
    assert.strictEqual(last.kind, "repeat", "раньше исчерпания сдались");
    const v = await r.retry.plan({ status: 503, headers: { get: () => null }, detail: "cache_only_cold" });
    assert.strictEqual(v.kind, "throw", "исчерпав повторы, всё равно повторяем бесконечно");
    assert.ok(/cache_only_cold: провайдер принимает только запрос с готовым кэшем/.test(v.error.message), "нет объяснения про кэш");
    assert.ok(/смена ключа внутри того же бесплатного пула не поможет/.test(v.error.message), "нет честного совета");
  });

  await test("5xx без признаков «холода» не повторяем зря, а 500 с cache_only_cold — повторяем", async () => {
    const quiet = makeRetry();
    const v = await quiet.retry.plan({ status: 500, headers: { get: () => null }, detail: "internal error" });
    assert.strictEqual(v.kind, "throw", "любой 500 стал повтором — ждём зря");
    assert.strictEqual(v.error.message, "API error 500: internal error", "текст ошибки разошёлся с прежним: " + v.error.message);
    const cold = makeRetry();
    const c = await cold.retry.plan({ status: 500, headers: { get: () => null }, detail: "cache_only_cold" });
    assert.strictEqual(c.kind, "repeat", "«холодный» отказ под 500 не распознан");
  });

  // ── Строгий сервер и метрики токенов ─────────────────────────────────────
  await test("строгий сервер без stream_options: выключаем метрики и повторяем, а не падаем", async () => {
    const r = makeRetry();
    const v = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "unknown parameter: stream_options" });
    assert.strictEqual(v.kind, "repeat", "отказ из-за stream_options роняет раунд");
    assert.strictEqual(v.what, "usage-off", "повтор помечен не как отключение метрик");
    assert.strictEqual(r.state.includeUsage, false, "флаг метрик не выключен — раунд упадёт по кругу");
    assert.ok(/stream_options\.include_usage/.test(r.termText()), "в «Консоль» не сказано, почему нет метрик");
    // Второй такой же отказ уже фатален: метрики выключены, значит дело не в них.
    const again = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "unknown parameter: stream_options" });
    assert.strictEqual(again.kind, "throw", "прогон повторяет один и тот же отказ бесконечно");
  });

  await test("«переполнен контекст» — не повод выключать метрики токенов", async () => {
    const r = makeRetry();
    const v = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "context length exceeded: maximum is 8192" });
    assert.strictEqual(r.state.includeUsage, true, "флаг метрик выключен на ошибке контекста");
    assert.strictEqual(v.kind, "repeat", "переполнение контекста не лечится повтором");
    assert.strictEqual(v.what, "context", "переполнение ушло не в свою ветку");
  });

  // ── Переполнение контекста ───────────────────────────────────────────────
  await test("переполнение контекста: ужимаем историю один раз и повторяем", async () => {
    const r = makeRetry({ budget: 60000 });
    const v = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "This model's maximum context length is 8192 tokens" });
    assert.strictEqual(v.kind, "repeat", "переполнение контекста роняет прогон");
    assert.strictEqual(r.seen.shrink, 1, "история не ужата");
    assert.ok(r.getBudget() < 60000, "бюджет контекста не уменьшен");
    const again = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "maximum context length" });
    assert.strictEqual(again.kind, "throw", "контекст ужимается по кругу");
    assert.strictEqual(r.seen.shrink, 1, "ужатие повторилось");
  });

  await test("на крошечном бюджете контекст не ужимаем — там уже нечего ужимать", async () => {
    const r = makeRetry({ budget: 2500 });
    const v = await r.retry.plan({ status: 400, headers: { get: () => null }, detail: "context too long" });
    assert.strictEqual(v.kind, "throw", "ужимаем то, что уже меньше минимума");
    assert.strictEqual(r.seen.shrink, 0, "shrinkContext вызван на крошечном бюджете");
  });

  // ── Фатальные ответы ─────────────────────────────────────────────────────
  await test("402: русское объяснение с именем провайдера, без бессмысленных повторов", async () => {
    const r = makeRetry({ settings: { provider: "deepseek" } });
    const v = await r.retry.plan({ status: 402, headers: { get: () => null }, detail: '{"error":{"message":"Insufficient Balance"}}' });
    assert.strictEqual(v.kind, "throw", "402 повторяется — баланс сам не появится");
    assert.ok(/Недостаточно средств на балансе провайдера \(deepseek\)/.test(v.error.message), "нет понятного текста: " + v.error.message);
    assert.ok(/Пополни счёт или выбери другого провайдера/.test(v.error.message), "не сказано, что делать человеку");
  });

  await test("Groq-лимит по токенам: совет вместо ожидания (повтор там бессмыслен)", async () => {
    const r = makeRetry({ settings: { provider: "openai", openaiUrl: "https://api.groq.com/openai/v1" } });
    const v = await r.retry.plan({
      status: 429,
      headers: { get: () => null },
      detail: "Rate limit reached: tokens per minute (TPM): Limit 7000, please reduce your message size",
    });
    assert.strictEqual(v.kind, "throw", "Groq-лимит по токенам ушёл в бессмысленные повторы");
    assert.ok(/Groq \(бесплатный тариф\) ограничивает входные токены/.test(v.error.message), "нет совета по Groq: " + v.error.message);
    assert.strictEqual(r.seen.pauses.length, 0, "ждали там, где это не поможет");
  });

  await test("незнакомый отказ уходит наружу с прежним текстом, ничего не выдумывая", async () => {
    const r = makeRetry();
    const v = await r.retry.plan({ status: 418, headers: { get: () => null }, detail: "я — чайник" });
    assert.strictEqual(v.kind, "throw", "неизвестный код стал повтором");
    assert.strictEqual(v.error.message, "API error 418: я — чайник", "текст ошибки потерялся");
    assert.strictEqual(r.seen.pauses.length, 0, "ждали на неизвестной ошибке");
  });

  // ── Темп ─────────────────────────────────────────────────────────────────
  await test("темп провайдера: пауза выдерживается заранее и видна в «Консоли»", async () => {
    const r = makeRetry({ paceMs: 3200 });
    const paced = await r.retry.pace();
    assert.strictEqual(paced, 3200, "пауза темпа не отдана наружу");
    assert.strictEqual(r.seen.took.length, 1, "лимитер провайдера не спрошен");
    assert.ok(/Держу темп провайдера: пауза 3 с/.test(r.termText()), "в «Консоли» не видно, почему запрос не уходит");
    const quiet = makeRetry({ paceMs: 300 });
    await quiet.retry.pace();
    assert.strictEqual(quiet.termText(), "", "о короткой паузе сообщают — «Консоль» забивается шумом");
  });

  await test("модуль берёт только внедрённое состояние — в main.js этого больше нет", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "run-retry.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    // Цикл прогона с части 25 живёт в src/run-ai.js: спрашиваем его, а у оболочки —
    // только то, что осталось её (отсутствие кода, подключение модуля, живые значения).
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    for (const gone of ["rateWaitedMs", "unavailableRetries", "contextRetried", "let includeUsage", "RATE_WAIT_BUDGET_MS"]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js осталось состояние повторов: " + gone);
    }
    assert.ok(/const retry = createRunRetry\(\{/.test(runSrc), "модуль не собран в прогоне");
    // Темп, флаг метрик и применение решения о повторе живут в теле раунда:
    // с части 17 оно в src/run-round.js, а хозяином цикла остаётся прогон.
    const roundSrc = fs.readFileSync(path.join(ROOT, "src", "run-round.js"), "utf8");
    assert.ok(/await retry\.pace\(\);/.test(roundSrc), "темп провайдера не спрашивается через модуль");
    assert.ok(/if \(verdict\.kind === "repeat"\) return \{ kind: "repeat" \};/.test(roundSrc), "решение модуля не отдаётся прогону");
    assert.ok(/includeUsage: retry\.state\.includeUsage/.test(roundSrc), "флаг метрик не берётся из модуля");
    assert.ok(/if \(roundOut\.kind === "repeat"\) \{/.test(runSrc), "повтор раунда перестал применяться в прогоне");
    assert.ok(!/app\.getPath|__dirname|require\(/.test(src), "модуль сам достаёт состояние вместо внедрения");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

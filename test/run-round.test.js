"use strict";

/* ── Один раунд общения с провайдером (src/run-round.js) ─────────────────────
   Запуск: node test/run-round.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 17 — четвёртый заход в ядро чата).
   Он собирает запрос, читает поток ответа и считает цифры раунда. Ошибки здесь
   тихие и дорогие:

     • бюджет и окно модели взяли копией — после переполнения контекста история
       режется по старому числу, и прогон падает навсегда;
     • справочник поставили не сразу за системным промптом — слетела точка кэша
       префикса, каждый раунд дороже;
     • usage шлют частями, а мы берём последнее поле — панель миссии показывает
       расход меньше настоящего;
     • рассуждения модели не отделили от ответа — человек читает «думаю…» вместо
       работы;
     • решение «повторить раунд» уехало в модуль — цикл раундов теряет счётчик.

   Ядро берём настоящее (agent-core): поддельная чистка рассуждений не покажет
   того же поведения, что у прогона. Сеть, поток и повторы внедряются. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const { createRunRound } = require(path.join(ROOT, "src", "run-round.js"));

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Подменённая сеть: ответ приходит не мгновенно, иначе TTFB выйдет нулевым и
   проверка «сколько ждали первый байт» ничего не значит. Пауза заметная: TTFB
   печатается с десятыми долями секунды, и 6 мс выглядели бы как «0.0 с». */
function fakeFetch(handler) {
  const prev = global.fetch;
  global.fetch = async (url, init) => {
    await sleep(120);
    return handler(url, init);
  };
  return () => {
    global.fetch = prev;
  };
}

const okRes = (extra) =>
  Object.assign({ ok: true, status: 200, headers: { get: () => null } }, extra || {});
const errRes = (status, detail) => ({
  ok: false,
  status: status,
  headers: { get: () => null },
  __detail: detail,
  text: async () => detail,
});

/* Сценарий потока: те же вызовы, что делает настоящий транспорт. */
const streamOf = (actions) => async (args) => {
  for (const a of actions) {
    if (a.text) args.onText(a.text);
    if (a.think) args.onThinking(a.think);
    if (a.call) args.onToolCall(a.call);
    if (a.usage) args.onUsage(a.usage);
    if (a.trunc) args.onTruncated();
  }
};

const HISTORY = [
  { role: "system", content: "СИСТЕМНЫЙ ПРОМПТ" },
  { role: "user", content: "привет" },
];

function makeRound(opts) {
  const o = opts || {};
  const seen = { term: [], chat: [], think: [], pace: 0, success: 0, plans: [], cost: [], reqs: [] };
  let budget = o.budget == null ? 32000 : o.budget;
  let modelWin = o.modelWin == null ? 128000 : o.modelWin;
  const tools = {
    state: {
      active: o.active || [{ type: "function", function: { name: "writeFile" } }],
      guideNotes: o.guideNotes || [],
      weight: o.weight == null ? 1500 : o.weight,
      histBudget: o.histBudget == null ? 60000 : o.histBudget,
      route: o.route || null,
    },
  };
  const retry = {
    state: { includeUsage: o.includeUsage !== false },
    pace: async () => {
      seen.pace++;
      return 0;
    },
    noteSuccess: () => {
      seen.success++;
    },
    plan: async (failure) => {
      seen.plans.push(failure);
      if (o.verdict) return o.verdict;
      return { kind: "throw", error: new Error("API error " + failure.status + ": " + failure.detail) };
    },
  };
  const mission = { cost: (u, comps) => seen.cost.push({ usage: u, comps: comps }) };
  const round = createRunRound({
    settings: o.settings || { provider: "openai", model: "test-model" },
    provider: o.provider || "openai",
    emit: (e) => seen.chat.push(e),
    termEmit: (e) => seen.term.push(e),
    emitThink: (t) => seen.think.push(t),
    getBudget: () => budget,
    getModelWindow: () => modelWin,
    getCompactions: () => (o.compactions == null ? 3 : o.compactions),
    noTools: !!o.noTools,
    localEndpoint: false,
    tools: tools,
    retry: retry,
    mission: mission,
    abort: o.abort || new AbortController(),
    SYSTEM_PROMPT: core.SYSTEM_PROMPT,
    buildChatRequest: (settings, req) => {
      seen.reqs.push(req);
      return {
        url: o.url || "https://api.test/v1/chat/completions",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      };
    },
    consumeProviderStream: o.stream || (async () => {}),
    createThinkingStripper: core.createThinkingStripper,
    readApiError: async (res) => (res && res.__detail) || "",
    estimateTokens: core.estimateTokens,
  });
  return {
    round: round,
    seen: seen,
    tools: tools,
    retry: retry,
    setBudget: (v) => {
      budget = v;
    },
    setModelWindow: (v) => {
      modelWin = v;
    },
    chatText: () => seen.chat.filter((e) => e.type === "chunk").map((e) => e.text).join(""),
    notices: () => seen.chat.filter((e) => e.type === "notice").map((e) => e.text),
    metrics: () => seen.term.map((e) => e.text).join("\n"),
  };
}

const RUN = { n: 2, maxRounds: 25, messages: HISTORY };

(async () => {
  // ── Сборка запроса ───────────────────────────────────────────────────────
  await test("бюджет и окно модели читаются в момент запроса, а не копией при сборке", async () => {
    const r = makeRound({ budget: 32000, modelWin: 128000 });
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      assert.strictEqual(r.seen.reqs[0].numCtxBudget, 32000, "бюджет не доехал до запроса");
      assert.strictEqual(r.seen.reqs[0].modelWindow, 128000, "окно модели не доехало");
      // Ужатие контекста уменьшило бюджет — следующий раунд обязан уйти с новым числом.
      r.setBudget(9000);
      r.setModelWindow(32768);
      await r.round.run(RUN);
      assert.strictEqual(r.seen.reqs[1].numCtxBudget, 9000, "бюджет взят копией — история режется по старому числу");
      assert.strictEqual(r.seen.reqs[1].modelWindow, 32768, "окно модели взято копией");
    } finally {
      restore();
    }
  });

  await test("флаг метрик токенов берётся из восстановления после отказа, а не зашит", async () => {
    const r = makeRound();
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      assert.strictEqual(r.seen.reqs[0].includeUsage, true, "метрики токенов не запрошены с первого раза");
      // Строгий сервер отказался от stream_options — дальше запрос идёт без него.
      r.retry.state.includeUsage = false;
      await r.round.run(RUN);
      assert.strictEqual(r.seen.reqs[1].includeUsage, false, "флаг из модуля повторов не применяется — раунд падал бы по кругу");
    } finally {
      restore();
    }
  });

  await test("справочники идут сразу после системного промпта, схемы — из роутера", async () => {
    const note = { role: "system", content: "СПРАВОЧНИК: как работать с почтой" };
    const r = makeRound({ guideNotes: [note], noTools: true });
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      const req = r.seen.reqs[0];
      assert.strictEqual(req.messages[0].content, "СИСТЕМНЫЙ ПРОМПТ", "системный промпт уехал с места");
      assert.strictEqual(req.messages[1], note, "справочник не сразу за промптом — слетит точка кэша");
      assert.strictEqual(req.messages[2].content, "привет", "история потерялась");
      assert.strictEqual(req.tools, r.tools.state.active, "в запрос ушёл не набор роутера");
      assert.strictEqual(req.staticSystem, core.SYSTEM_PROMPT, "статичный префикс не передан ядру");
      assert.strictEqual(req.noTools, true, "модель без инструментов получит схемы");
    } finally {
      restore();
    }
  });

  // ── Поток ответа ─────────────────────────────────────────────────────────
  await test("текст идёт в чат по мере прихода, рассуждения — в блок мыслей", async () => {
    const r = makeRound({
      stream: streamOf([
        { text: "Сейчас <thi" },
        { text: "nk>внутреннее рассуждение модели</think>готовим ответ" },
        { text: " и проверяем его" },
      ]),
    });
    const restore = fakeFetch(() => okRes());
    try {
      const out = await r.round.run(RUN);
      const visible = "Сейчас готовим ответ и проверяем его";
      assert.strictEqual(r.chatText(), visible, "в чат ушло не то: " + JSON.stringify(r.chatText()));
      assert.ok(r.seen.think.join("").indexOf("внутреннее рассуждение") >= 0, "рассуждения модели потерялись");
      assert.strictEqual(out.text, visible, "наружу отдан текст вместе с рассуждениями");
      // Ответ идёт в чат по мере прихода: последние 16 символов транспорт держит
      // (в них может прятаться незакрытый тег рассуждений), но длинный ответ виден
      // кусками, а не только в самом конце.
      assert.ok(
        r.seen.chat.filter((e) => e.type === "chunk").length >= 2,
        "ответ отдан одним куском только в конце — человек не видит, что работа идёт"
      );
    } finally {
      restore();
    }
  });

  await test("обрыв ответа лимитом вывода объясняется человеку, а не молчится", async () => {
    const r = makeRound({ stream: streamOf([{ text: "начал писать" }, { trunc: true }]) });
    const restore = fakeFetch(() => okRes());
    try {
      const out = await r.round.run(RUN);
      assert.strictEqual(out.truncated, true, "усечение не отдано наружу");
      assert.ok(
        r.notices().some((t) => /оборван лимитом вывода/.test(t) && /продолжай/.test(t)),
        "человеку не сказано, почему ответ оборвался: " + JSON.stringify(r.notices())
      );
    } finally {
      restore();
    }
  });

  await test("вызовы инструментов доходят наружу все и по порядку", async () => {
    const calls = [
      { id: "c1", name: "readFile", args: { path: "a.js" } },
      { id: "c2", name: "writeFile", args: { path: "b.js" } },
    ];
    const r = makeRound({ stream: streamOf([{ call: calls[0] }, { call: calls[1] }]) });
    const restore = fakeFetch(() => okRes());
    try {
      const out = await r.round.run(RUN);
      assert.deepStrictEqual(out.toolCalls, calls, "вызовы потерялись или перемешались");
    } finally {
      restore();
    }
  });

  await test("пустой ответ отдаётся пустым: «Готово» вместо прогона не подставляем", async () => {
    const r = makeRound();
    const restore = fakeFetch(() => okRes());
    try {
      const out = await r.round.run(RUN);
      assert.strictEqual(out.text, "", "модуль выдумал текст ответа");
      assert.deepStrictEqual(out.toolCalls, [], "выдумал вызов инструмента");
      assert.strictEqual(out.truncated, false, "пустой ответ помечен как оборванный");
    } finally {
      restore();
    }
  });

  // ── Цифры раунда ─────────────────────────────────────────────────────────
  await test("usage собирается по частям: по каждому полю максимум", async () => {
    const r = makeRound({
      stream: streamOf([
        { text: "ответ", usage: { prompt: 120 } },
        { usage: { completion: 40 } },
        { usage: { cached: 96, prompt: 0, completion: 0 } },
      ]),
    });
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      assert.ok(/токены 120→40/.test(r.metrics()), "части usage не сложились: " + r.metrics());
      assert.ok(/кэш 96 \(80%\)/.test(r.metrics()), "кэш посчитан неверно: " + r.metrics());
      assert.deepStrictEqual(
        r.seen.cost[0].usage,
        { prompt: 120, completion: 40, cached: 96 },
        "в миссию ушёл неверный расход: " + JSON.stringify(r.seen.cost[0].usage)
      );
      assert.strictEqual(r.seen.cost[0].comps, 3, "сжатия контекста не переданы в цену миссии");
    } finally {
      restore();
    }
  });

  await test("метрики раунда: номер, схемы, группы, TTFB и всё время", async () => {
    const r = makeRound({ route: { groups: ["mail", "browser"], dropped: ["cloud", "yc"] } });
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      const m = r.metrics();
      assert.ok(/раунд 3\/25/.test(m), "номер раунда неверен (n+1 от нуля): " + m);
      assert.ok(/схем 1 \(~1500 т\.\)/.test(m), "состав и вес схем не показаны: " + m);
      assert.ok(/групп 2/.test(m), "группы не показаны: " + m);
      assert.ok(/срезано: cloud,yc/.test(m), "срезанные группы не названы: " + m);
      assert.ok(/TTFB 0\.[1-9]/.test(m), "первый байт не измерен: " + m);
      assert.ok(/всего \d+\.\d+ с/.test(m), "полное время раунда не показано: " + m);
    } finally {
      restore();
    }
  });

  await test("без usage провайдера — честная оценка, а не нули", async () => {
    const r = makeRound();
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      const m = r.metrics();
      assert.ok(/токены ≈\d+ \(провайдер не прислал\)/.test(m), "оценка токенов не показана: " + m);
      assert.ok(/кэш нет данных/.test(m), "отсутствие кэша не названо: " + m);
      assert.strictEqual(r.seen.cost[0].usage, null, "в цену миссии ушло выдуманное число");
    } finally {
      restore();
    }
  });

  // ── Отказы ───────────────────────────────────────────────────────────────
  await test("отказ запроса: раунд повторяется решением прогона, в чат ничего не ушло", async () => {
    const r = makeRound({ verdict: { kind: "repeat", what: "rate" } });
    const restore = fakeFetch(() => errRes(429, "try again in 30s"));
    try {
      const out = await r.round.run(RUN);
      assert.strictEqual(out.kind, "repeat", "модуль не сказал, что раунд надо повторить: " + JSON.stringify(out));
      assert.strictEqual(r.seen.plans.length, 1, "решение о повторе не спрошено");
      assert.strictEqual(r.seen.plans[0].status, 429, "код отказа потерялся");
      assert.strictEqual(r.seen.plans[0].detail, "try again in 30s", "подробность отказа потерялась");
      assert.strictEqual(r.chatText(), "", "в чат ушёл мусор от неудачного раунда");
      assert.strictEqual(r.seen.term.length, 0, "метрики неудачного раунда показаны как рабочие");
      assert.strictEqual(r.seen.cost.length, 0, "неудачный раунд списан в расход миссии");
      assert.strictEqual(r.seen.success, 0, "неудачный запрос засчитан успехом");
    } finally {
      restore();
    }
  });

  await test("фатальный отказ модуль не бросает сам — текст уходит прогону", async () => {
    const r = makeRound();
    const restore = fakeFetch(() => errRes(402, '{"error":{"message":"Insufficient Balance"}}'));
    try {
      const out = await r.round.run(RUN);
      assert.strictEqual(out.kind, "error", "фатальный отказ не отдан прогону: " + JSON.stringify(out));
      assert.ok(/API error 402/.test(out.error.message), "текст отказа потерялся: " + out.error.message);
    } finally {
      restore();
    }
  });

  await test("успешный ответ снимает счётчики отказов", async () => {
    const r = makeRound();
    const restore = fakeFetch(() => okRes());
    try {
      await r.round.run(RUN);
      assert.strictEqual(r.seen.success, 1, "успех не засчитан — прогон «сдастся» после сбоя");
    } finally {
      restore();
    }
  });

  await test("темп провайдера спрашивается до запроса", async () => {
    const r = makeRound();
    const order = [];
    const restore = fakeFetch(() => {
      order.push("fetch");
      return okRes();
    });
    try {
      r.retry.pace = async () => {
        order.push("pace");
        return 5000;
      };
      await r.round.run(RUN);
      assert.deepStrictEqual(order, ["pace", "fetch"], "пауза темпа не перед запросом: " + order.join(","));
    } finally {
      restore();
    }
  });

  await test("сетевая ошибка названа провайдером, а прерывание проходит как есть", async () => {
    const r = makeRound({ provider: "deepseek" });
    const restore = fakeFetch(() => {
      const e = new Error("ECONNREFUSED");
      throw e;
    });
    try {
      await assert.rejects(() => r.round.run(RUN), (e) => /Сетевая ошибка при запросе к deepseek: ECONNREFUSED/.test(e.message));
    } finally {
      restore();
    }
    const stop = makeRound({ abort: (() => { const c = new AbortController(); c.abort(); return c; })() });
    const restore2 = fakeFetch(() => {
      const e = new Error("прервано");
      e.name = "AbortError";
      throw e;
    });
    try {
      await assert.rejects(
        () => stop.round.run(RUN),
        (e) => e.name === "AbortError" && e.message === "прервано",
        "прерывание обёрнуто в «сетевую ошибку» — прогон не отличит остановку от сбоя"
      );
    } finally {
      restore2();
    }
  });

  // ── Границы модуля ───────────────────────────────────────────────────────
  await test("модуль берёт только внедрённое состояние — в main.js этого больше нет", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "run-round.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    // Цикл прогона с части 25 живёт в src/run-ai.js: спрашиваем его, а у оболочки —
    // только то, что осталось её (отсутствие кода, подключение модуля, живые значения).
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    for (const gone of ["let collected", "const stripper", "roundTtfbMs", "roundUsage", "const req = buildChatRequest"]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js осталось тело раунда: " + gone);
    }
    assert.ok(/const roundRunner = createRunRound\(\{/.test(runSrc), "модуль не собран в прогоне");
    assert.ok(/await roundRunner\.run\(\{ n: round, maxRounds: maxRounds, messages: canonical \}\)/.test(runSrc),
      "раунд не идёт через модуль");
    // С правки 1.5.173 между `round--` и `continue` стоит пометка «это та же попытка»
    // (повтор не тратит ни номер раунда, ни раунд миссии).
    assert.ok(
      /if \(roundOut\.kind === "repeat"\) \{[\s\S]{0,240}round--;[\s\S]{0,240}continue;/.test(runSrc),
      "повтор раунда перестал быть решением прогона"
    );
    assert.ok(/getBudget: \(\) => budget/.test(runSrc) && /getModelWindow: \(\) => modelWin/.test(runSrc),
      "живые значения переданы копией");
    assert.ok(!/app\.getPath|__dirname|require\(/.test(src), "модуль сам достаёт состояние вместо внедрения");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

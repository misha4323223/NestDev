"use strict";

/* ── Вызовы раунда (src/run-calls.js) ────────────────────────────────────────
   Запуск: node test/run-calls.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 18 — пятый заход в ядро чата runAi).
   Он превращает ответ модели в вызовы инструментов. Ошибки здесь тихие и дорогие:

     • текстовый вызов не нашли — модель напечатала JSON-вызов в тексте, а её
       отправили в призыв «план не закрыт»; работа встала;
     • дубль выполнился дважды — файл создан или коммит сделан дважды;
     • подпись мысли потеряна — Gemini 3.x отвечает 400 на СЛЕДУЮЩИЙ запрос;
     • писатель попал в параллельную пачку — файлы пишутся вперемешку, а вопрос
       человеку ждёт ответа на фоне чужой работы.

   Разбор текста и нормализация имён берутся настоящие (agent-core): поддельные
   не покажут того же поведения, что у прогона. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const { createRunCalls } = require(path.join(ROOT, "src", "run-calls.js"));

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

function makeCalls(opts) {
  const o = opts || {};
  const seen = { chat: [], started: [], ran: [], history: [] };
  let idSeq = 0;
  const calls = createRunCalls({
    settings: o.settings || {},
    emit: (e) => seen.chat.push(e),
    extractToolCallsFromText: core.extractToolCallsFromText,
    genCallId: () => "gen-" + ++idSeq,
    normalizeToolName: core.normalizeToolName,
    executeTool: async (name, args) => {
      seen.ran.push({ name: name, args: args });
      if (o.executeTool) return o.executeTool(name, args);
      return "результат " + name;
    },
    truncateText: (t, max) => "CAP(" + String(t).slice(0, max) + ")",
    fmtError: (e) => (e && e.message) || String(e),
    PARALLEL_SAFE_TOOLS: o.safe || new Set(["readFile", "searchProject"]),
  });
  const history = o.history || [];
  return {
    calls: calls,
    seen: seen,
    history: history,
    overrides: () => seen.chat.filter((e) => e.type === "text_override").map((e) => e.text),
    starts: () => seen.started,
  };
}

const TEXT_CALL =
  'Пишу файл: ```json\n{"name": "writeFile", "arguments": {"path": "a.txt", "content": "ок"}}\n```\n';

(async () => {
  // ── 1. Текстовые вызовы ─────────────────────────────────────────────────
  await test("текстовый вызов найден, выполним и убран из показанного текста", () => {
    const env = makeCalls();
    const toolCalls = [];
    const found = env.calls.fromText({ toolCalls: toolCalls, text: TEXT_CALL, planMode: false });
    assert.strictEqual(found, 1, "вызов из текста не найден");
    assert.strictEqual(toolCalls.length, 1, "вызов не попал в список раунда");
    assert.strictEqual(toolCalls[0].name, "writeFile", "имя вызова потеряно: " + toolCalls[0].name);
    assert.deepStrictEqual(toolCalls[0].args, { path: "a.txt", content: "ок" }, "аргументы разобраны неверно");
    assert.ok(/^gen-\d+$/.test(toolCalls[0].id), "вызову не выдан id: " + toolCalls[0].id);
    const shown = env.overrides();
    assert.strictEqual(shown.length, 1, "показанный текст не переписан: " + JSON.stringify(shown));
    assert.strictEqual(shown[0], "Пишу файл:", "в показанном тексте остался мусор: " + JSON.stringify(shown[0]));
  });

  await test("в режиме плана текст не разбираем, а при своих вызовах не трогаем ответ", () => {
    const plan = makeCalls();
    const planCalls = [];
    assert.strictEqual(plan.calls.fromText({ toolCalls: planCalls, text: TEXT_CALL, planMode: true }), 0,
      "в режиме плана инструменты всё равно вынуты из текста");
    assert.strictEqual(planCalls.length, 0, "в плане появился исполняемый вызов");
    assert.strictEqual(plan.overrides().length, 0, "в плане переписан показанный текст");

    const own = makeCalls();
    const ownCalls = [{ id: "c1", name: "readFile", args: {} }];
    assert.strictEqual(own.calls.fromText({ toolCalls: ownCalls, text: TEXT_CALL, planMode: false }), 0,
      "текст разобран, хотя вызовы уже пришли через tool_calls");
    assert.strictEqual(ownCalls.length, 1, "в раунд подмешался лишний вызов");
  });

  await test("без вызовов в тексте ничего не показываем и не подменяем ответ", () => {
    const env = makeCalls();
    const toolCalls = [];
    assert.strictEqual(env.calls.fromText({ toolCalls: toolCalls, text: "Просто ответ без вызовов.", planMode: false }), 0,
      "в обычном тексте найден вызов");
    assert.strictEqual(env.overrides().length, 0, "показанный текст переписан без повода");
    assert.strictEqual(env.calls.fromText({ toolCalls: [], text: "", planMode: false }), 0, "пустой текст дал вызов");
  });

  // ── 2. Нормализация и дедупликация ───────────────────────────────────────
  await test("имена нормализуются, дубли убираются, порядок сохраняется", () => {
    const env = makeCalls();
    const out = env.calls.normalize([
      { id: "a", name: "write_file", args: { path: "x" } },
      { id: "b", name: "writeFile", args: { path: "x" } },
      { id: "c", name: "git_status", args: {} },
    ]);
    assert.deepStrictEqual(out.map((c) => c.name), ["writeFile", "gitStatus"], "нормализация или дедупликация сломаны: " + JSON.stringify(out.map((c) => c.name)));
    assert.deepStrictEqual(out.map((c) => c.id), ["a", "c"], "id вызовов не сохранились");
  });

  await test("вызов без id получает стабильный, без аргументов — пустой объект", () => {
    const env = makeCalls();
    // Имена разные: одинаковые по имени и аргументам вызовы обязаны схлопнуться,
    // и это проверяется отдельно выше.
    const out = env.calls.normalize([{ name: "readFile", args: "строка вместо объекта" }, { name: "listFiles" }]);
    assert.strictEqual(out.length, 2, "разные вызовы склеены: " + JSON.stringify(out));
    assert.ok(/^gen-\d+$/.test(out[0].id) && /^gen-\d+$/.test(out[1].id), "id не выдан: " + JSON.stringify(out.map((c) => c.id)));
    assert.notStrictEqual(out[0].id, out[1].id, "двум вызовам выдан один id");
    assert.deepStrictEqual(out[0].args, {}, "не-объект просочился в аргументы: " + JSON.stringify(out[0].args));
    assert.deepStrictEqual(out[1].args, {}, "отсутствующие аргументы не заменены пустыми");
  });

  await test("подпись мысли (extra_content) едет вместе с вызовом", () => {
    const sig = { google: { thought_signature: "SIG==" } };
    const env = makeCalls();
    const out = env.calls.normalize([{ id: "a", name: "runCommand", args: {}, extraContent: sig }]);
    assert.deepStrictEqual(out[0].extraContent, sig, "подпись мысли потеряна — Gemini ответит 400");
    const plain = env.calls.normalize([{ id: "b", name: "runCommand", args: {} }]);
    assert.ok(!("extraContent" in plain[0]), "вызову без подписи приписали extraContent");
  });

  // ── 3. Запись в историю ─────────────────────────────────────────────────
  await test("вызовы записываются в историю как assistant с tool_calls", () => {
    const env = makeCalls();
    const sig = { google: { thought_signature: "SIG==" } };
    env.calls.recordAssistant(
      env.history,
      "Пишу файл.",
      [
        { id: "c1", name: "writeFile", args: { path: "a.txt" } },
        { id: "c2", name: "runCommand", args: { command: "ls" }, extraContent: sig },
      ]
    );
    assert.strictEqual(env.history.length, 1, "в историю не записано ровно одно сообщение");
    const msg = env.history[0];
    assert.strictEqual(msg.role, "assistant", "роль сообщения неверна: " + msg.role);
    assert.strictEqual(msg.content, "Пишу файл.", "текст ответа потерян");
    assert.strictEqual(msg.tool_calls.length, 2, "вызовы не записаны: " + JSON.stringify(msg.tool_calls));
    assert.strictEqual(msg.tool_calls[0].type, "function", "тип вызова не проставлен");
    assert.strictEqual(msg.tool_calls[0].id, "c1", "id вызова потерян");
    assert.strictEqual(msg.tool_calls[0].function.name, "writeFile", "имя вызова потеряно");
    assert.strictEqual(msg.tool_calls[0].function.arguments, '{"path":"a.txt"}', "аргументы не сериализованы");
    assert.deepStrictEqual(msg.tool_calls[1].extra_content, sig, "подпись мысли не попала в историю");
    assert.ok(!("extra_content" in msg.tool_calls[0]), "лишняя подпись y вызова без неё");
  });

  await test("пустой текст ответа записывается как content: null", () => {
    const env = makeCalls();
    env.calls.recordAssistant(env.history, "", [{ id: "c1", name: "readFile", args: {} }]);
    assert.strictEqual(env.history[0].content, null, "пустой ответ записан иначе: " + JSON.stringify(env.history[0].content));
  });

  // ── 4. Пачка ────────────────────────────────────────────────────────────
  await test("параллельно идут только два и более read-only вызова вне плана", () => {
    const env = makeCalls();
    const read = (n) => ({ id: "c" + n, name: "readFile", args: { path: n + ".txt" } });
    assert.strictEqual(env.calls.canRunParallel([read(1)], false), false, "один вызов пошёл в пачку");
    assert.strictEqual(env.calls.canRunParallel([read(1), read(2)], false), true, "два чтения не пошли в пачку");
    assert.strictEqual(env.calls.canRunParallel([read(1), read(2)], true), false, "в плане вызовы пошли параллельно");
    assert.strictEqual(
      env.calls.canRunParallel([read(1), { id: "w", name: "writeFile", args: {} }], false),
      false,
      "писатель уехал в параллельную пачку"
    );
  });

  await test("пачка: сначала все запуски, потом результаты, история — по порядку вызовов", async () => {
    const order = [];
    const env = makeCalls({
      executeTool: async (name) => {
        order.push("run:" + name);
        await new Promise((r) => setTimeout(r, 5));
        return "тело " + name;
      },
    });
    const calls = [
      { id: "c1", name: "readFile", args: { path: "a.txt" } },
      { id: "c2", name: "readFile", args: { path: "b.txt" } },
    ];
    await env.calls.runParallel(calls, env.history);
    const starts = env.seen.chat.filter((e) => e.type === "tool_start").map((e) => e.name);
    const results = env.seen.chat.filter((e) => e.type === "tool_result");
    assert.deepStrictEqual(starts, ["readFile", "readFile"], "запуски не отправлены до работы: " + JSON.stringify(starts));
    assert.strictEqual(env.seen.chat.filter((e) => e.type === "tool_start").length, 2, "не все запуски показаны");
    assert.deepStrictEqual(
      results.map((e) => e.result),
      ["CAP(тело readFile)", "CAP(тело readFile)"],
      "результаты не ужаты или не отправлены: " + JSON.stringify(results)
    );
    assert.strictEqual(results.length, 2, "результатов не два");
    assert.deepStrictEqual(
      env.history.map((m) => m.tool_call_id),
      ["c1", "c2"],
      "история получила результаты не в порядке вызовов: " + JSON.stringify(env.history)
    );
    assert.ok(
      env.history.every((m) => m.role === "tool" && /^CAP\(/.test(m.content)),
      "в историю легли необработанные результаты: " + JSON.stringify(env.history)
    );
    const first = env.seen.chat.findIndex((e) => e.type === "tool_result");
    const lastStart = env.seen.chat.map((e) => e.type).lastIndexOf("tool_start");
    assert.ok(lastStart < first, "результат показан раньше, чем запущен последний вызов — это уже не пачка");
    assert.strictEqual(order.length, 2, "выполнение не пошло параллельно: " + JSON.stringify(order));
  });

  await test("сбой инструмента в пачке не роняет раунд: он превращается в текст", async () => {
    const env = makeCalls({
      executeTool: async (name) => {
        throw new Error("диск переполнен");
      },
    });
    await env.calls.runParallel(
      [
        { id: "c1", name: "readFile", args: {} },
        { id: "c2", name: "readFile", args: {} },
      ],
      env.history
    );
    assert.strictEqual(env.history.length, 2, "после сбоя история не дописана: " + env.history.length);
    assert.ok(
      /Ошибка инструмента readFile: диск переполнен/.test(env.history[0].content),
      "сбой инструмента не превращён в понятный текст: " + env.history[0].content
    );
  });

  // ── 5. Границы модуля ───────────────────────────────────────────────────
  await test("тело вызовов ушло из оболочки, а предохранитель A остался в прогоне", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "run-calls.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    // Цикл прогона с части 25 живёт в src/run-ai.js: спрашиваем его, а у оболочки —
    // только то, что осталось её (отсутствие кода, подключение модуля, живые значения).
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    for (const gone of ["const seenCalls = new Set()", "extractToolCallsFromText(finalText)", 'role: "assistant"', "await Promise.all("]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js остались вызовы раунда: " + gone);
    }
    assert.ok(/const callPrep = createRunCalls\(\{/.test(runSrc), "модуль не собран в прогоне");
    assert.ok(runSrc.indexOf("tools.ensureGroupsFor(calls);") > 0, "предохранитель A потерялся");
    assert.ok(mainSrc.indexOf("const PARALLEL_SAFE_TOOLS = new Set([") > 0, "список безопасных для параллели инструментов потерялся");
    assert.ok(runSrc.indexOf("callPrep.fromText(") > 0 && runSrc.indexOf("callPrep.normalize(toolCalls)") > 0, "раунд не ходит в модуль");
    // Призывы по текстовому ответу с части 20 живут в src/run-nudge.js, поэтому
    // порядок проверяем по ВЫЗОВУ модуля призывов: разбор текста обязан быть раньше.
    assert.ok(
      runSrc.indexOf("callPrep.fromText(") < runSrc.indexOf("nudge.decide(canonical, {"),
      "разбор текстовых вызовов уехал после призывов — найденный вызов потеряется"
    );
    assert.ok(!/app\.getPath|__dirname|require\(/.test(src), "модуль сам достаёт состояние вместо внедрения");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

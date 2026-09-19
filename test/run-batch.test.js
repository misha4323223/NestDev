"use strict";

/* ── Решения после раунда (src/run-batch.js) ───────────────────────────────────
   Запуск: node test/run-batch.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 19б — седьмой заход в ядро чата runAi).
   Здесь решается, что делать после раунда: попросить итоговый отчёт, начать
   следующий батч, закрыть работу или выйти из цикла. Ошибки тихие и дорогие:

     • молчание вместо отчёта — работа сделана, а человеку ничего не сказано;
     • повторный отчёт по кругу — чат заполняется одинаковыми просьбами;
     • закрытая миссия подана как ошибка счётчика раундов;
     • батч без напоминания — модель повторяет уже сделанное;
     • история меняется после паузы — следующий запрос уходит со старым контекстом. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunBatch } = require(path.join(ROOT, "src", "run-batch.js"));

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

function makeBatch(opts) {
  const o = opts || {};
  const seen = { chat: [], states: [], refreshes: 0 };
  let afterResult = o.afterResult || { continue: false, closed: true };
  const batch = createRunBatch({
    emit: (e) => seen.chat.push(e),
    mission: {
      afterBatch: async () => afterResult,
      emitState: (p) => seen.states.push(p),
      refresh: () => {
        seen.refreshes++;
        // undefined — проверка «миссия без названия»: подставляем название только
        // когда его вообще не задавали (null — это осознанно пусто).
        return o.mission === undefined ? { title: "Проверка батчей" } : o.mission;
      },
    },
    pauseMs: o.pauseMs === undefined ? 0 : o.pauseMs,
  });
  return {
    batch: batch,
    seen: seen,
    setAfter: (v) => { afterResult = v; },
  };
}

const file = ROOT + "/src/run-batch.js";

(async () => {
  // ── пустой ответ ────────────────────────────────────────────────────────────
  await test("пустой ответ: один раз просим итоговый отчёт и повторяем раунд", () => {
    const env = makeBatch();
    const history = [];
    const asked = env.batch.askForReport(history, {
      toolCalls: [],
      planMode: false,
      text: "   ",
      reportRetried: false,
      aborted: false,
    });
    assert.strictEqual(asked, true, "просьба об отчёте не отправлена");
    assert.strictEqual(history.length, 1, "просьба не попала в историю");
    assert.ok(/итоговый отчёт/.test(history[0].content), "просьба без просьбы: " + history[0].content);
    assert.strictEqual(history[0].role, "user", "просьба ушла не как реплика человека");
  });

  await test("непустой ответ, план, остановка и повтор — отчёт не просим", () => {
    const cases = [
      [{ toolCalls: [], text: "Готово.", reportRetried: false, aborted: false }, "непустой ответ"],
      [{ toolCalls: [{ id: "c1" }], text: "", reportRetried: false, aborted: false }, "были вызовы инструментов"],
      [{ toolCalls: [], text: "", reportRetried: true, aborted: false }, "отчёт уже просили"],
      [{ toolCalls: [], text: "", reportRetried: false, aborted: true }, "человек нажал «Стоп»"],
    ];
    for (const [o, why] of cases) {
      const env = makeBatch();
      const history = [];
      const asked = env.batch.askForReport(history, Object.assign({ planMode: false }, o));
      assert.strictEqual(asked, false, "просим отчёт зря: " + why);
      assert.strictEqual(history.length, 0, "история тронута зря: " + why);
    }
    const env = makeBatch();
    const history = [];
    assert.strictEqual(
      env.batch.askForReport(history, { toolCalls: [], planMode: true, text: "", reportRetried: false, aborted: false }),
      false,
      "в режиме плана просим отчёт"
    );
  });

  // ── граница батча ───────────────────────────────────────────────────────────
  await test("миссия просит закончить — прогон завершается её текстом", async () => {
    const env = makeBatch({ afterResult: { finish: true, phase: "failed", message: "🏁 Предел работы" } });
    const r = await env.batch.afterRound([]);
    assert.deepStrictEqual(r, { kind: "end", message: "🏁 Предел работы" }, "не завершение с текстом миссии: " + JSON.stringify(r));
    assert.deepStrictEqual(env.seen.states, ["failed"], "состояние миссии не показано человеку");
  });

  await test("миссия закрыта — обычный финал, а не ошибка счётчика раундов", async () => {
    const env = makeBatch({ afterResult: { continue: false, closed: true }, mission: { title: "Уборка" } });
    const r = await env.batch.afterRound([]);
    assert.strictEqual(r.kind, "end", "закрытая миссия не завершает прогон нормально");
    assert.ok(/Работа закончена/.test(r.message), "нет человеческого финала: " + r.message);
    assert.ok(/Уборка/.test(r.message), "в финале нет названия миссии: " + r.message);
    assert.ok(/\.agent\/missions\//.test(r.message), "финал не говорит, где отчёт");
    assert.strictEqual(env.seen.refreshes, 1, "миссия не перечитана перед финалом");
  });

  await test("миссия закрыта без названия — финал без пустых кавычек", async () => {
    const env = makeBatch({ afterResult: { continue: false, closed: true }, mission: null });
    const r = await env.batch.afterRound([]);
    assert.strictEqual(r.kind, "end", "нет финала");
    assert.ok(r.message.indexOf("«") < 0 && r.message.indexOf("»") < 0, "в финале пустые кавычки: " + r.message);
  });

  await test("миссия не закрыта и не продолжается — выход из цикла без ошибки", async () => {
    const env = makeBatch({ afterResult: { continue: false, closed: false } });
    const r = await env.batch.afterRound([]);
    assert.deepStrictEqual(r, { kind: "break" }, "нет выхода из цикла: " + JSON.stringify(r));
    assert.strictEqual(env.seen.chat.length, 0, "человеку сказано лишнее");
  });

  await test("батч продолжается: напоминание человеку, событие миссии и история", async () => {
    const env = makeBatch({ afterResult: { continue: true, phase: "batch", notice: "Продолжаю: батч 2", historyMessage: "Работа продолжается" } });
    const history = [];
    const r = await env.batch.afterRound(history);
    assert.deepStrictEqual(r, { kind: "continue" }, "батч не продолжен: " + JSON.stringify(r));
    assert.deepStrictEqual(env.seen.chat, [{ type: "notice", text: "Продолжаю: батч 2" }], "напоминание человеку не отправлено");
    assert.deepStrictEqual(env.seen.states, ["batch"], "событие миссии не отправлено");
    assert.strictEqual(history.length, 1, "напоминание не попало в историю");
    assert.strictEqual(history[0].content, "Работа продолжается", "в историю ушло не то напоминание");
  });

  await test("история пополняется ДО паузы: следующий запрос не уходит со старым контекстом", async () => {
    const env = makeBatch({ pauseMs: 120, afterResult: { continue: true, phase: "batch", notice: "n", historyMessage: "h" } });
    const history = [];
    const p = env.batch.afterRound(history);
    // Пауза ещё идёт (120 мс), а история уже должна быть дописана. Если бы
    // напоминание писалось после паузы, здесь было бы пусто.
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(history.length, 1, "история дописана после паузы, а не до неё");
    await p;
  });

  await test("пауза между батчами выдержана (не «continue» в тот же тик)", async () => {
    const env = makeBatch({ pauseMs: 80, afterResult: { continue: true, phase: "batch", notice: "n", historyMessage: "h" } });
    const started = Date.now();
    await env.batch.afterRound([]);
    const spent = Date.now() - started;
    assert.ok(spent >= 70, "паузы нет: " + spent + " мс");
  });

  // ── связки и оболочка ───────────────────────────────────────────────────────
  await test("модуль берёт только внедрённое состояние и не тянет electron", () => {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!/require\(/.test(src), "модуль сам что-то требует вместо внедрения");
    assert.ok(!/app\.getPath|__dirname|ipcMain|process\.env/.test(src), "модуль достаёт состояние сам");
    for (const glue of ["mission.afterBatch()", "mission.emitState", "mission.refresh()", 'emit({ type: "notice"']) {
      assert.ok(src.indexOf(glue) >= 0, "потеряна связка: " + glue);
    }
  });

  await test("решения после раунда ушли из оболочки, а цикл раундов остался в прогоне", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    for (const gone of ["mission.afterBatch()", "afterBatch.historyMessage", "Ты завершил действия, но итоговый ответ получился пустым"]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js осталось решение после раунда: " + gone);
    }
    assert.ok(/const batchCtl = createRunBatch\(\{ emit, mission, pauseMs: 1500 \}\)/.test(mainSrc), "модуль не собран в прогоне");
    assert.ok(mainSrc.indexOf("batchCtl.askForReport(canonical, {") > 0, "пустой ответ не спрашивает модуль");
    assert.ok(/const after = await batchCtl\.afterRound\(canonical\)/.test(mainSrc), "граница батча не спрашивает модуль");
    assert.ok(mainSrc.indexOf('if (after.kind === "end") return await endRun(after.message);') > 0, "финал потерял текст модуля");
    assert.ok(mainSrc.indexOf("reportRetried = true;") > 0, "флаг повторного отчёта потерялся");
    assert.ok(mainSrc.indexOf("for (let batch = 1; ; batch++)") > 0, "внешний цикл батчей потерялся");
    assert.ok(mainSrc.indexOf("const batch = createRunBatch") < 0, "проводка названа batch — её перекрыл бы счётчик цикла");
    assert.ok(mainSrc.indexOf("Превышено максимальное число раундов") > 0, "жёсткий предел раундов потерялся");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

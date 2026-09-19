"use strict";

/* ── Призывы по текстовому ответу (src/run-nudge.js) ───────────────────────────
   Запуск: node test/run-nudge.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 20 — восьмой заход в ядро чата runAi).
   Модель ответила текстом без вызова инструментов: призывать ли её продолжить
   делом. Ошибки тихие и дорогие:

     • призыв по кругу — человек получает три одинаковых отчёта подряд;
     • призыв после «Стоп» — работа идёт вопреки остановке;
     • призыв в режиме плана — зовём вызывать инструмент там, где нельзя;
     • призыв при закрытом плане — лишний круг и лишние токены;
     • пауза сторожа не кончает призывы — петля жжёт лимиты. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunNudge } = require(path.join(ROOT, "src", "run-nudge.js"));

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

function makeNudge(opts) {
  const o = opts || {};
  const seen = { chat: [], metrics: [], states: [], refreshes: 0, seeds: [] };
  let plan = o.plan === undefined ? null : o.plan;
  let nudgeAction = o.nudgeAction || "none";
  const nudge = createRunNudge({
    emit: (e) => seen.chat.push(e),
    termEmit: (e) => seen.metrics.push(e),
    mission: {
      canNudge: () => (o.canNudge === undefined ? true : o.canNudge),
      nudge: (text) => {
        seen.seeds.push(text);
        return nudgeAction === "none"
          ? { action: "none" }
          : { action: nudgeAction, notice: "н-" + nudgeAction, historyMessage: "и-" + nudgeAction, phase: "paused" };
      },
      emitState: (p) => seen.states.push(p),
      refresh: () => {
        seen.refreshes++;
      },
    },
    getPlanSummary: () => plan,
  });
  return {
    nudge: nudge,
    seen: seen,
    setPlan: (v) => { plan = v; },
    setNudge: (v) => { nudgeAction = v; },
  };
}

const textOnly = { toolCalls: [], planMode: false, text: "Всё сделано.", aborted: false };
const plan = (done, total, failedCount) => ({ done: done, total: total, failed: failedCount || 0 });

(async () => {
  await test("незакрытый план: призыв с точным числом пунктов и повтором раунда", () => {
    const env = makeNudge({ plan: plan(1, 4, 1) });
    const history = [];
    const r = env.nudge.decide(history, textOnly);
    assert.deepStrictEqual(r, { action: "repeat" }, "раунд не повторяется: " + JSON.stringify(r));
    assert.strictEqual(history.length, 1, "просьба не ушла модели");
    assert.ok(/1 из 4 готово/.test(history[0].content), "в просьбе неверное число пунктов: " + history[0].content.slice(0, 60));
    assert.ok(/сбоев: 1/.test(history[0].content), "сбои не названы — модель не поймёт про failed");
    assert.ok(/ВЫПОЛНЯЙ/.test(history[0].content), "просьба не говорит «делай, а не описывай»");
    assert.strictEqual(env.seen.metrics.length, 1, "человеку не сказано, что план не закрыт");
    assert.ok(/План не закрыт \(2 из 4 пунктов\)/.test(env.seen.metrics[0].text), "неверный текст метрики: " + env.seen.metrics[0].text);
    assert.ok(/попытка 1\/2/.test(env.seen.metrics[0].text), "не показано, какая это попытка");
    assert.strictEqual(history[0].role, "user", "просьба ушла не как реплика человека");
  });

  await test("призыв по плану ограничен двумя попытками, дальше — не зовём", () => {
    const env = makeNudge({ plan: plan(0, 3), canNudge: false });
    const history = [];
    assert.strictEqual(env.nudge.decide(history, textOnly).action, "repeat", "первый призыв не ушёл");
    assert.strictEqual(env.nudge.decide(history, textOnly).action, "repeat", "второй призыв не ушёл");
    assert.deepStrictEqual(env.nudge.decide(history, textOnly), { action: "none" }, "третий призыв — цикл");
    assert.strictEqual(env.seen.metrics.length, 2, "попыток не две: " + env.seen.metrics.length);
    assert.ok(/попытка 2\/2/.test(env.seen.metrics[1].text), "вторая попытка названа неверно");
  });

  await test("план закрыт — призыва нет, идём обычным финалом", () => {
    const env = makeNudge({ plan: plan(3, 3), canNudge: false });
    const history = [];
    assert.deepStrictEqual(env.nudge.decide(history, textOnly), { action: "none" }, "призыв при закрытом плане");
    assert.strictEqual(history.length, 0, "история тронута зря");
  });

  await test("план без пунктов или без сводки — призыва нет", () => {
    for (const p of [null, { done: 0, total: 0, failed: 0 }]) {
      const env = makeNudge({ plan: p, canNudge: false });
      const history = [];
      assert.deepStrictEqual(env.nudge.decide(history, textOnly), { action: "none" }, "призыв без плана: " + JSON.stringify(p));
    }
  });

  await test("есть вызовы, режим плана или «Стоп» — призывов нет вовсе", () => {
    const cases = [
      [{ toolCalls: [{ id: "c1" }], planMode: false, text: "x", aborted: false }, "были вызовы инструментов"],
      [{ toolCalls: [], planMode: true, text: "x", aborted: false }, "режим плана"],
      [{ toolCalls: [], planMode: false, text: "x", aborted: true }, "человек нажал «Стоп»"],
    ];
    for (const [o, why] of cases) {
      const env = makeNudge({ plan: plan(0, 2) });
      const history = [];
      assert.deepStrictEqual(env.nudge.decide(history, o), { action: "none" }, "призыв не к месту: " + why);
      assert.strictEqual(history.length, 0, "история тронута зря: " + why);
      assert.strictEqual(env.seen.metrics.length, 0, "человеку сказано зря: " + why);
      assert.strictEqual(env.seen.seeds.length, 0, "сторож миссии спрошен зря: " + why);
    }
  });

  await test("сторож миссии велит призвать — просьба уходит модели, раунд повторяется", () => {
    const env = makeNudge({ plan: null, nudgeAction: "nudge" });
    const history = [];
    const r = env.nudge.decide(history, textOnly);
    assert.deepStrictEqual(r, { action: "repeat" }, "раунд не повторяется: " + JSON.stringify(r));
    assert.deepStrictEqual(env.seen.chat, [{ type: "notice", text: "н-nudge" }], "человеку не сказано о призыве");
    assert.deepStrictEqual(history, [{ role: "user", content: "и-nudge" }], "просьба сторожа не ушла модели");
    assert.deepStrictEqual(env.seen.seeds, ["Всё сделано."], "сторож не увидел ответ модели");
  });

  await test("пауза сторожа: призывы кончились, миссия встала, но прогон идёт дальше", () => {
    const env = makeNudge({ plan: null, nudgeAction: "pause" });
    const history = [];
    const r = env.nudge.decide(history, textOnly);
    assert.deepStrictEqual(r, { action: "pause" }, "нет решения о паузе: " + JSON.stringify(r));
    assert.deepStrictEqual(env.seen.chat, [{ type: "notice", text: "н-pause" }], "человеку не сказано о паузе");
    assert.deepStrictEqual(env.seen.states, ["paused"], "состояние миссии не отправлено");
    assert.strictEqual(env.seen.refreshes, 1, "миссия не перечитана после паузы");
    assert.strictEqual(history.length, 0, "в историю ушло лишнее при паузе");
  });

  await test("сторож промолчал — решения нет, прогон заканчивается обычным финалом", () => {
    const env = makeNudge({ plan: null, nudgeAction: "none" });
    assert.deepStrictEqual(env.nudge.decide([], textOnly), { action: "none" }, "лишнее решение");
    assert.strictEqual(env.seen.chat.length, 0, "человеку сказано зря");
  });

  await test("план важнее сторожа: при незакрытом плане сторожа не спрашиваем", () => {
    const env = makeNudge({ plan: plan(0, 2), nudgeAction: "nudge" });
    const r = env.nudge.decide([], textOnly);
    assert.strictEqual(r.action, "repeat", "план не призвал");
    assert.strictEqual(env.seen.seeds.length, 0, "сторож спрошен при незакрытом плане");
  });

  await test("счётчик призывов живёт в модуле и не сбивается между вызовами", () => {
    const env = makeNudge({ plan: plan(0, 5), canNudge: false });
    for (let i = 0; i < 2; i++) env.nudge.decide([], textOnly);
    assert.ok(/попытка 2\/2/.test(env.seen.metrics[1].text), "счётчик не растёт: " + env.seen.metrics.map((m) => m.text));
    assert.strictEqual(env.nudge.decide([], textOnly).action, "none", "счётчик не остановился");
  });

  await test("модуль берёт только внедрённое состояние и не тянет electron", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "run-nudge.js"), "utf8");
    assert.ok(!/require\(/.test(src), "модуль сам что-то требует вместо внедрения");
    assert.ok(!/app\.getPath|__dirname|ipcMain|process\.env/.test(src), "модуль достаёт состояние сам");
    for (const glue of ["termEmit(", "mission.canNudge()", "mission.nudge(", "mission.emitState(", "getPlanSummary()"]) {
      assert.ok(src.indexOf(glue) >= 0, "потеряна связка: " + glue);
    }
  });

  await test("призывы ушли из оболочки, а повтор раунда остался за прогоном", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    for (const gone of ["planNudges", "activePlanSummary.total", "mission.nudge(finalText)"]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js остались призывы: " + gone);
    }
    assert.ok(/const nudge = createRunNudge\(\{/.test(mainSrc), "модуль не собран в прогоне");
    assert.ok(mainSrc.indexOf("nudge.decide(canonical, {") > 0, "раунд не спрашивает модуль призывов");
    assert.ok(mainSrc.indexOf('if (nudged.action === "repeat") continue;') > 0, "повтор раунда потерялся");
    assert.ok(mainSrc.indexOf("activePlanSummary = null; // план прошлого прогона") > 0, "сброс сводки плана потерялся");
    assert.ok(mainSrc.indexOf("let activePlanSummary = null;") > 0, "живое значение сводки плана потерялось");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

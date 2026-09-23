"use strict";

/* ── Ожидание ответа человека (src/ask-wait.js) ──────────────────────────────
   Запуск: node test/ask-wait.test.js   (входит в общий `npm test`)

   Модуль появился из жалобы: «агент открыл окно с вопросом, а сам не остановился
   и продолжил что-то делать». Настоящая причина — забытый таймер: он не снимался
   при ответе, просыпался через пять минут и «отвечал» пустой строкой на СЛЕДУЮЩИЙ
   вопрос. Человек смотрел на открытое окно, а прогон уже шёл дальше.

   Здесь проверяется именно это, а не «функция на месте»:

     • вопрос уходит в окно вместе с вариантами ответа;
     • ответ человека отдаётся РОВНО один раз и снимает таймер;
     • просроченный таймер отвечает только за свой вопрос и говорит об этом вслух;
     • старый таймер не может подменить новый вопрос (та самая жалоба);
     • конец прогона снимает ожидание: поздний ответ не уедет в следующий прогон;
     • варианты чистятся: пустые, дубли, простыни.

   Время подменено: таймеры срабатывают руками, настоящих минут здесь нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createAskWait, normalizeAskOptions, ASK_MAX_OPTIONS, ASK_OPTION_MAX } = require(path.join(ROOT, "src", "ask-wait.js"));
const RUN_AI_SRC = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

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

// Стенд: настоящий модуль, но время — руками.
function mk(over) {
  const o = over || {};
  const events = [];
  const live = { pendingAsk: null };
  const timers = [];
  const wait = createAskWait({
    emit: (ev) => events.push(ev),
    live,
    timeoutMs: o.timeoutMs === undefined ? 1000 : o.timeoutMs,
    setTimeout: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (t) => {
      if (t) t.cleared = true;
    },
  });
  return {
    wait,
    live,
    events,
    timers,
    // Срабатывание «как в жизни»: только живые таймеры.
    fire: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
    notices: () => events.filter((e) => e.type === "notice"),
  };
}

// Итог обещания — без ожидания: ответ отдаётся синхронно, хватает такта микротасок.
function outcome(p) {
  const box = { state: "pending", value: undefined };
  p.then((v) => {
    box.state = "done";
    box.value = v;
  });
  return box;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log("\n[1] Вопрос уходит в окно вместе с вариантами");

  await test("вопрос и варианты уезжают окну, ожидание встаёт в живое значение", () => {
    const m = mk();
    const p = m.wait.askUserWait("Какой сайт открыть?", ["Ozon", "Wildberries"]);
    assert.strictEqual(m.events.length, 1, "окну ушло не одно событие: " + m.events.length);
    assert.strictEqual(m.events[0].type, "ask", "это не событие вопроса: " + m.events[0].type);
    assert.strictEqual(m.events[0].question, "Какой сайт открыть?", "текст вопроса потерялся");
    assert.deepStrictEqual(m.events[0].options, ["Ozon", "Wildberries"], "варианты не доехали до окна");
    assert.strictEqual(typeof m.live.pendingAsk, "function", "ожидание не встало: ответу некуда прийти");
    assert.strictEqual(typeof p.then, "function", "модуль не вернул обещание ответа");
  });

  await test("без вариантов вопрос всё равно задаётся (окно без кнопок)", () => {
    const m = mk();
    m.wait.askUserWait("Что дальше?");
    assert.deepStrictEqual(m.events[0].options, [], "подставились варианты, которых не было");
  });

  await test("пустой вопрос и пустые варианты не превращаются в дыру в окне", () => {
    const m = mk();
    m.wait.askUserWait("   ", ["  ", "", "  Да  ", "Да", 12]);
    assert.strictEqual(m.events[0].question, "Уточни, пожалуйста", "пустой вопрос ушёл как есть");
    assert.deepStrictEqual(m.events[0].options, ["Да", "12"], "мусор в вариантах не вычищен");
  });

  console.log("\n[2] Ответ человека: один раз и с снятым таймером");

  await test("ответ отдаётся один раз, таймер снимается", async () => {
    const m = mk();
    const box = outcome(m.wait.askUserWait("Вопрос", ["Да"]));
    const finish = m.live.pendingAsk;
    assert.strictEqual(finish("Да"), true, "первый ответ не принят");
    await flush();
    assert.strictEqual(box.state, "done", "прогон не получил ответ");
    assert.strictEqual(box.value, "Да", "ответ дошёл не тот: " + box.value);
    assert.strictEqual(m.timers[0].cleared, true, "таймер не снят — он «ответит» на следующий вопрос");
    assert.strictEqual(m.live.pendingAsk, null, "ожидание не убрано из живого значения");
    assert.strictEqual(finish("ещё раз"), false, "второй ответ прошёл: прогон получил бы два ответа");
    await flush();
    assert.strictEqual(box.value, "Да", "второй ответ переписал первый: " + box.value);
  });

  await test("человек может написать своё вместо варианта — текст доходит целиком", async () => {
    const m = mk();
    const box = outcome(m.wait.askUserWait("Вопрос", ["Да", "Нет"]));
    m.live.pendingAsk("свой вариант: сначала почту, потом отчёт");
    await flush();
    assert.strictEqual(box.value, "свой вариант: сначала почту, потом отчёт", "свой ответ потерялся");
  });

  console.log("\n[3] Просрочка и забытый таймер (та самая жалоба)");

  await test("просроченный таймер снимает СВОЙ вопрос и говорит человеку об этом", async () => {
    const m = mk({ timeoutMs: 60000 });
    const box = outcome(m.wait.askUserWait("Вопрос", ["Да"]));
    m.fire();
    await flush();
    assert.strictEqual(box.state, "done", "вопрос так и висит — прогон бы замер навсегда");
    assert.strictEqual(box.value, "", "просрочка отдала не пустой ответ: " + JSON.stringify(box.value));
    assert.strictEqual(m.live.pendingAsk, null, "ожидание осталось после просрочки");
    const notes = m.notices();
    assert.strictEqual(notes.length, 1, "человеку не сказали, что вопрос снят по времени");
    assert.ok(/снят/.test(notes[0].text), "в сообщении нет слова о снятии: " + notes[0].text);
    assert.ok(/1 мин/.test(notes[0].text), "в сообщении нет срока: " + notes[0].text);
  });

  await test("старый таймер НЕ отвечает за новый вопрос (окно открыто — агент работает)", async () => {
    const m = mk();
    const first = outcome(m.wait.askUserWait("Первый вопрос", ["Да"]));
    const staleTimer = m.timers[0]; // таймер ПЕРВОГО вопроса — тот самый забытый
    m.live.pendingAsk("Да"); // человек ответил — прогон пошёл дальше
    await flush();
    assert.strictEqual(first.state, "done", "первый ответ не дошёл");
    const second = outcome(m.wait.askUserWait("Второй вопрос", ["Нет"]));
    assert.ok(m.live.pendingAsk, "второе ожидание не встало");
    // Худший случай, который и был раньше: старый таймер всё-таки сработал.
    staleTimer.fn();
    await flush();
    assert.strictEqual(second.state, "pending", "старый таймер ответил за НОВЫЙ вопрос — агент пошёл работать при открытом окне");
    assert.strictEqual(m.notices().length, 0, "человеку сказали о снятии вопроса, который он не бросал");
    assert.strictEqual(typeof m.live.pendingAsk, "function", "ожидание второго вопроса потерялось");
    m.live.pendingAsk("Нет");
    await flush();
    assert.strictEqual(second.value, "Нет", "второй ответ не дошёл: " + JSON.stringify(second.value));
  });

  await test("два вопроса подряд не путают ответы", async () => {
    const m = mk();
    const a = outcome(m.wait.askUserWait("Первый", ["A"]));
    m.live.pendingAsk("A");
    await flush();
    const b = outcome(m.wait.askUserWait("Второй", ["B"]));
    m.live.pendingAsk("B");
    await flush();
    assert.strictEqual(a.value, "A", "первый ответ перепутан: " + a.value);
    assert.strictEqual(b.value, "B", "второй ответ перепутан: " + b.value);
    assert.strictEqual(m.events.filter((e) => e.type === "ask").length, 2, "окну ушло не два вопроса");
  });

  console.log("\n[4] Конец прогона и чистка вариантов");

  await test("cancel снимает ожидание: поздний ответ не уедет в следующий прогон", async () => {
    const m = mk();
    const box = outcome(m.wait.askUserWait("Вопрос", ["Да"]));
    const late = m.live.pendingAsk;
    assert.strictEqual(m.wait.cancel(), true, "прогон не смог снять ожидание");
    await flush();
    assert.strictEqual(box.state, "done", "вопрос остался висеть после конца прогона");
    assert.strictEqual(m.live.pendingAsk, null, "ожидание осталось в живом значении");
    assert.strictEqual(m.wait.cancel(), false, "снятие без ожидания сказало, что что-то сняло");
    assert.strictEqual(late("поздний ответ"), false, "поздний ответ прошёл — он попал бы в чужой прогон");
    assert.strictEqual(m.timers[0].cleared, true, "таймер конца прогона остался жить");
  });

  await test("варианты: не массив, пустые, дубли, простыни, потолок", () => {
    assert.deepStrictEqual(normalizeAskOptions(undefined), [], "не массив принят за варианты");
    assert.deepStrictEqual(normalizeAskOptions("Да"), [], "строка принята за список вариантов");
    assert.deepStrictEqual(normalizeAskOptions(["", "   ", null]), [], "пустые варианты не вычищены");
    assert.deepStrictEqual(normalizeAskOptions(["Да", "Да", " да "]), ["Да", "да"], "дубли не убраны");
    const long = "я".repeat(400);
    const cut = normalizeAskOptions([long])[0];
    assert.strictEqual(cut.length, ASK_OPTION_MAX, "длинный вариант не обрезан: " + cut.length);
    assert.ok(/…$/.test(cut), "обрезка не помечена: " + cut.slice(-3));
    const many = normalizeAskOptions(Array.from({ length: 20 }, (_, i) => "вариант " + i));
    assert.strictEqual(many.length, ASK_MAX_OPTIONS, "потолок вариантов не сработал: " + many.length);
    assert.deepStrictEqual(normalizeAskOptions(["  два   слова  "]), ["два слова"], "лишние пробелы не убраны");
  });

  await test("прогон пользуется модулем, а старого таймера в нём нет", () => {
    assert.ok(MAIN_SRC.indexOf('require("./ask-wait.js")') >= 0, "модуль не подключён в оболочке");
    assert.ok(/const \{ runAi \} = createRunAi\(\{[\s\S]{0,500}?createAskWait,/.test(MAIN_SRC), "модуль не передан прогону");
    assert.ok(/createAskWait\(\{ emit, live \}\)/.test(RUN_AI_SRC), "прогон не собирает ожидание ответа");
    assert.ok(!/300000/.test(RUN_AI_SRC), "в прогоне остался старый таймер на 5 минут");
    assert.ok(!/live\.pendingAsk = resolve/.test(RUN_AI_SRC), "прогон сам подсовывает resolve в живое значение");
    assert.ok(/askWait\.cancel\(\)/.test(RUN_AI_SRC), "конец прогона не снимает ожидание ответа");
    // Ответ человека и «Стоп» снимают ожидание через одно и то же живое значение.
    assert.ok(/if \(live\.pendingAsk\)/.test(fs.readFileSync(path.join(ROOT, "src", "run-ipc.js"), "utf8")), "канал ответа не отвечает на ожидание");
  });

  console.log("\n  ожидание ответа: прошло " + passed + ", упало " + failed);
  process.exit(failed ? 1 : 0);
})();

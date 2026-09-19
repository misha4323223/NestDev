"use strict";

/* ── Строгая очередь вызовов (src/run-strict.js) ───────────────────────────────
   Запуск: node test/run-strict.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 19а — шестой заход в ядро чата runAi).
   Сюда приходят вызовы, которые нельзя гнать пачкой: запись файла, вопрос
   человеку, потенциально опасное. Ошибки здесь тихие и дорогие:

     • выполнили без спроса — опасная команда уходит в работу молча;
     • спросили не то — рискованное действие без вопроса либо двойной диалог;
     • отказ человека не попал в журнал — потом не объяснить, почему файла нет;
     • чекпоинт не снят — правка ушла на диск без снимка, откатывать нечего;
     • в режиме плана выполнили инструмент — план «составился», сделав дело;
     • источник действия застыл значением — в журнале вечно «desktop». */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunStrict } = require(path.join(ROOT, "src", "run-strict.js"));

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

function makeStrict(opts) {
  const o = opts || {};
  const seen = { chat: [], audit: [], mission: [], undo: [], asked: [], ran: [] };
  let origin = o.origin || "desktop";
  let answer = o.answer === undefined ? "да" : o.answer;
  let answerSeq = o.answerSeq || null;
  let seqIdx = 0;

  const strict = createRunStrict({
    settings: o.settings || { workDir: "/tmp/proj" },
    emit: (e) => seen.chat.push(e),
    askUserWait: async (q) => {
      seen.asked.push(q);
      if (answerSeq) return answerSeq[seqIdx++];
      return typeof answer === "function" ? answer(q) : answer;
    },
    toolPolicy: o.toolPolicy || {
      isDangerousCommand: () => false,
      needsConfirm: () => false,
    },
    describeToolArgs: (name, a) => name + "(" + JSON.stringify(a) + ")",
    executeTool: async (name, args) => {
      seen.ran.push({ name: name, args: args });
      if (o.executeTool) return o.executeTool(name, args);
      return "результат " + name;
    },
    truncateText: (t, n) => (String(t).length > n ? String(t).slice(0, n) : String(t)),
    audit: { record: (r) => seen.audit.push(r) },
    mission: { noteCall: (name, args) => seen.mission.push({ name: name, args: args }) },
    snapshotFileForUndo: (p) => {
      if (o.undoThrows) throw new Error("диск переполнен");
      seen.undo.push(p);
    },
    resolvePath: (p, s) => (s && s.workDir ? s.workDir + "/" + p : "/" + p),
    getRunOrigin: () => origin,
  });

  return {
    strict: strict,
    seen: seen,
    setOrigin: (v) => { origin = v; },
    setAnswer: (v) => { answer = v; },
  };
}

const file = ROOT + "/src/run-strict.js";

(async () => {
  await test("обычный вызов: показан, выполнен, записан в журнал и в историю", async () => {
    const env = makeStrict();
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "readFile", args: { path: "a.txt" } }], {
      planMode: false,
      history: history,
    });
    assert.deepStrictEqual(
      env.seen.chat.map((e) => e.type),
      ["tool_start", "tool_result"],
      "события идут не по одному вызову"
    );
    assert.strictEqual(env.seen.ran.length, 1, "инструмент не выполнен");
    assert.strictEqual(env.seen.audit.length, 1, "действие не записано в журнал");
    assert.strictEqual(env.seen.audit[0].decision, "auto", "обычное действие помечено не как auto");
    assert.strictEqual(env.seen.audit[0].tool, "readFile", "в журнале не тот инструмент");
    assert.strictEqual(env.seen.mission.length, 1, "миссия не увидела вызов");
    assert.strictEqual(history.length, 1, "результат не вернулся модели");
    assert.strictEqual(history[0].role, "tool", "в историю ушло не tool-сообщение");
    assert.strictEqual(history[0].tool_call_id, "c1", "результат привязан не к тому вызову");
  });

  await test("длинный вывод инструмента ужимается перед отправкой модели", async () => {
    const env = makeStrict({ executeTool: () => "x".repeat(9000) });
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "runCommand", args: {} }], { planMode: false, history: history });
    assert.strictEqual(history[0].content.length, 8000, "вывод не ужат до 8000");
    assert.strictEqual(env.seen.chat[1].result.length, 8000, "в окно ушёл необрезанный вывод");
  });

  await test("порядок строгий: каждый следующий вызов только после результата", async () => {
    const env = makeStrict();
    const history = [];
    await env.strict.runStrict(
      [
        { id: "a", name: "writeFile", args: { path: "a.txt" } },
        { id: "b", name: "writeFile", args: { path: "b.txt" } },
      ],
      { planMode: false, history: history }
    );
    assert.deepStrictEqual(
      env.seen.chat.map((e) => e.type + ":" + e.name),
      ["tool_start:writeFile", "tool_result:writeFile", "tool_start:writeFile", "tool_result:writeFile"],
      "вызовы пошли вперемешку, а не по очереди"
    );
    assert.deepStrictEqual(history.map((h) => h.tool_call_id), ["a", "b"], "история не по порядку вызовов");
  });

  await test("вопрос человеку: уходит агенту, пустой ответ не теряется", async () => {
    const env = makeStrict();
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "askUser", args: { question: "Какой порт?" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.asked.length, 1, "вопрос не задан");
    assert.strictEqual(env.seen.asked[0], "Какой порт?", "вопрос ушёл не тот");
    assert.strictEqual(history[0].content, "да", "ответ человека не вернулся модели");
    const env2 = makeStrict({ answer: "   " });
    const h2 = [];
    await env2.strict.runStrict([{ id: "c1", name: "askUser", args: {} }], { planMode: false, history: h2 });
    assert.strictEqual(env2.seen.asked[0], "Уточни, пожалуйста", "вопрос по умолчанию потерян");
    assert.strictEqual(h2[0].content, "(пользователь не дал ответ)", "молчание человека не объяснено модели");
  });

  await test("опасная команда: без подтверждения не выполняется, отказ виден человеку", async () => {
    const env = makeStrict({
      toolPolicy: { isDangerousCommand: () => true, needsConfirm: () => false },
      answer: "нет",
    });
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "runCommand", args: { command: "rm -rf /" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.ran.length, 0, "опасная команда выполнена без согласия");
    assert.strictEqual(env.seen.audit[0].decision, "denied", "отказ не записан в журнал");
    assert.ok(/НЕ выполнена/.test(history[0].content), "модель не узнала об отказе");
    assert.ok(env.seen.asked[0].indexOf("rm -rf /") >= 0, "спрашиваем, но не говорим что именно");
  });

  await test("опасная команда: с подтверждением выполняется и помечается approved", async () => {
    const env = makeStrict({
      toolPolicy: { isDangerousCommand: () => true, needsConfirm: () => false },
      answer: "Да, выполняй",
    });
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "runCommand", args: { command: "rm -rf /tmp/x" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.ran.length, 1, "подтверждённая команда не выполнена");
    assert.strictEqual(env.seen.audit[0].decision, "approved", "подтверждение не записано в журнал");
    assert.strictEqual(history[0].content, "результат runCommand", "результат не вернулся модели");
  });

  await test("опасное действие по политике: спрос ровно один и с описанием аргументов", async () => {
    const env = makeStrict({
      toolPolicy: { isDangerousCommand: () => false, needsConfirm: (n) => n === "deploy" },
      answer: "no",
    });
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "deploy", args: { env: "prod" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.asked.length, 1, "спросили не один раз");
    assert.ok(env.seen.asked[0].indexOf('deploy({"env":"prod"})') >= 0, "в вопросе нет описания действия");
    assert.strictEqual(env.seen.ran.length, 0, "опасное действие выполнено без согласия");
    assert.strictEqual(env.seen.audit[0].decision, "denied", "отказ не записан");
  });

  await test("спрос не двойной: инструмент с политикой риска спрашивают один раз", async () => {
    const env = makeStrict({
      toolPolicy: { isDangerousCommand: () => true, needsConfirm: () => true },
      answer: "да",
    });
    const history = [];
    await env.strict.runStrict([{ id: "c1", name: "runCommand", args: { command: "rm -rf /tmp/x" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.asked.length, 1, "два диалога за одно действие");
    assert.strictEqual(env.seen.ran.length, 1, "инструмент не выполнен после согласия");
  });

  await test("подтверждение распознаётся по-русски и по-английски, «нет» — отказ", async () => {
    const yes = ["да", "Да", "ДА!", "yes", "y", "ok", "го", "ага", "точно", "конечно", "давай", "выполняй"];
    const no = ["нет", "no", "не надо", "", "потом", "стоп"];
    for (const a of yes) {
      const env = makeStrict({
        toolPolicy: { isDangerousCommand: () => true, needsConfirm: () => false },
        answer: a,
      });
      const h = [];
      await env.strict.runStrict([{ id: "c1", name: "runCommand", args: { command: "x" } }], { planMode: false, history: h });
      assert.strictEqual(env.seen.ran.length, 1, "не распознано согласие: «" + a + "»");
    }
    for (const a of no) {
      const env = makeStrict({
        toolPolicy: { isDangerousCommand: () => true, needsConfirm: () => false },
        answer: a,
      });
      const h = [];
      await env.strict.runStrict([{ id: "c1", name: "runCommand", args: { command: "x" } }], { planMode: false, history: h });
      assert.strictEqual(env.seen.ran.length, 0, "«" + a + "» принято за согласие");
    }
  });

  await test("чекпоинт: перед правкой файла снимок снят, у чтения — нет", async () => {
    const env = makeStrict();
    const h = [];
    await env.strict.runStrict(
      [
        { id: "a", name: "writeFile", args: { path: "a.txt" } },
        { id: "b", name: "editFile", args: { path: "b.txt" } },
        { id: "c", name: "readFile", args: { path: "c.txt" } },
      ],
      { planMode: false, history: h }
    );
    assert.deepStrictEqual(env.seen.undo, ["/tmp/proj/a.txt", "/tmp/proj/b.txt"], "снимки сняты не для правок");
  });

  await test("сбой чекпоинта не роняет вызов: правка всё равно выполняется", async () => {
    const env = makeStrict({ undoThrows: true });
    const history = [];
    await env.strict.runStrict([{ id: "a", name: "writeFile", args: { path: "a.txt" } }], {
      planMode: false,
      history: history,
    });
    assert.strictEqual(env.seen.undo.length, 0, "снимок сделан, хотя хранилище упало");
    assert.strictEqual(env.seen.ran.length, 1, "инструмент не выполнен после сбоя чекпоинта");
    assert.strictEqual(history.length, 1, "раунд не получил результат");
  });

  await test("режим плана: выполняется только todoWrite, остальное — честный отказ", async () => {
    const env = makeStrict();
    const history = [];
    await env.strict.runStrict(
      [
        { id: "a", name: "readFile", args: { path: "a.txt" } },
        { id: "b", name: "todoWrite", args: { todos: [] } },
      ],
      { planMode: true, history: history }
    );
    assert.strictEqual(env.seen.ran.length, 1, "в плане выполнен лишний инструмент");
    assert.strictEqual(env.seen.ran[0].name, "todoWrite", "выполнен не todoWrite");
    assert.deepStrictEqual(
      env.seen.chat.filter((e) => e.name === "readFile"),
      [],
      "запрещённый в плане инструмент всё равно показан как выполняемый"
    );
    assert.strictEqual(history.length, 2, "отказ не вернулся модели");
    assert.ok(/Режим плана/.test(history[0].content), "отказ без объяснения");
    assert.strictEqual(history[0].tool_call_id, "a", "отказ привязан не к тому вызову");
    assert.strictEqual(env.seen.audit.length, 1, "в журнал ушёл отказ, а не только выполненное действие");
  });

  await test("источник действия берётся на КАЖДЫЙ вызов, а не запоминается значением", async () => {
    const env = makeStrict({ origin: "desktop" });
    const history = [];
    env.setOrigin("mobile");
    await env.strict.runStrict([{ id: "a", name: "readFile", args: {} }], { planMode: false, history: history });
    assert.strictEqual(env.seen.audit[0].source, "mobile", "источник действия застыл значением");
  });

  await test("модуль берёт только внедрённое состояние и не тянет electron", () => {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!/require\(/.test(src), "модуль сам что-то требует вместо внедрения");
    assert.ok(!/app\.getPath|__dirname|ipcMain/.test(src), "модуль достаёт состояние сам");
    for (const glue of [
      "askUserWait",
      "toolPolicy",
      "describeToolArgs",
      "executeTool",
      "audit.record",
      "mission.noteCall",
      "snapshotFileForUndo",
      "resolvePath",
      "getRunOrigin()",
    ]) {
      assert.ok(src.indexOf(glue) >= 0, "потеряна связка: " + glue);
    }
  });

  await test("тело очереди ушло из оболочки, а предохранители прогона остались", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    for (const gone of ["toolPolicy.isDangerousCommand(", "snapshotFileForUndo(resolvePath("]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js осталась строгая очередь: " + gone);
    }
    assert.ok(/const strict = createRunStrict\(\{/.test(mainSrc), "модуль не собран в прогоне");
    assert.ok(/await strict\.runStrict\(calls, \{ planMode: planMode, history: canonical \}\)/.test(mainSrc), "раунд не ходит в модуль");
    assert.ok(mainSrc.indexOf('require("./run-strict.js")') > 0, "модуль не подключён");
    assert.ok(mainSrc.indexOf("mission.trackProgress(calls);") > 0, "счётчик прогресса миссии потерялся");
    // Остановка обязана идти ПОСЛЕ очереди: ищем первое вхождение начиная с вызова
    // модуля (раньше по тексту есть такая же проверка после параллельной пачки).
    const fromStrict = mainSrc.indexOf("await strict.runStrict(");
    const stopAfter = mainSrc.indexOf("if (global.__agentStopRequested) return stopGraceful();", fromStrict);
    assert.ok(stopAfter > fromStrict, "остановка по «Стоп» потеряла очередь");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

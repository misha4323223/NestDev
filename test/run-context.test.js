"use strict";

/* ── Контекст прогона (src/run-context.js) ────────────────────────────────────
   Запуск: node test/run-context.test.js   (входит в общий `npm test`)

   Модуль появился из-за конкретной жалобы: после паузы агент заново ищет, чем
   занимался. Проверяем ровно то, ради чего он существует, а не «функция на месте»:

   • работа (вызовы инструментов и их результаты) возвращается в контекст ЦЕЛИКОМ,
     вместе с tool_call_id — без него разбор пар выбрасывает результат как
     «осиротевший», и пауза опять теряла бы всё, ради чего чекпоинт заведён;
   • свежая просьба человека дописывается в конец и НЕ удваивает историю;
   • окно, которое не узнаётся в чекпоинте, не подклеивается наугад;
   • в чекпоинт не попадают секреты, base64-картинки и гигантские выводы;
   • оборванный на полуслове ответ (assistant с вызовами без результатов) не
     остаётся «висеть»: такой хвост провайдер отвергает 400;
   • битый файл, чужая рабочая папка и неизвестный чат не ломают прогон.

   Всё на настоящей файловой системе во временной папке: подделка fs не показала
   бы ни обрезку 512 КБ, ни маскировку секретов, ни атомарную запись. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunContext, RUN_CTX_MAX_BYTES, RUN_CTX_VERSION, planResume } = require(path.join(ROOT, "src", "run-context.js"));
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const RUN_AI_SRC = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");

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

// Временная рабочая папка на каждый случай: чекпоинт пишется рядом с проектом.
const tmpRoots = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "run-ctx-" + (tag || "x") + "-"));
  tmpRoots.push(d);
  return d;
}
function cleanup() {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
}

function mk(dir, id) {
  return createRunContext({ dir: () => dir, id: id === undefined ? "chat-1" : id, sanitizeToolPairs: core.sanitizeToolPairs });
}

// Рабочая история, как её видит прогон: просьба человека, ответ агента с вызовом
// инструмента и результат этого инструмента.
function workingHistory() {
  return [
    { role: "system", content: "ТЫ АГЕНТ (системный промпт — в чекпоинт не едет)" },
    { role: "user", content: "поправь конфиг и перезапусти сервер" },
    {
      role: "assistant",
      content: "Смотрю конфиг",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "readFile", arguments: JSON.stringify({ path: "config.js" }) } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "module.exports = { port: 3000 }" },
    { role: "user", content: "Работа продолжается (граница батча)" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_2", type: "function", function: { name: "editFile", arguments: JSON.stringify({ path: "config.js" }) } }],
    },
    { role: "tool", tool_call_id: "call_2", content: "правка применена" },
  ];
}

const checkpointFile = (dir, id) => path.join(dir, ".agent", "runs", String(id || "chat-1") + ".json");

(async () => {
  await test("1. работа возвращается в контекст целиком, вместе с tool_call_id", () => {
    const dir = tmpDir("resume");
    const ctx = mk(dir);
    const saved = ctx.save(workingHistory());
    assert.strictEqual(saved.ok, true, "чекпоинт не записан: " + (saved.reason || ""));
    assert.ok(fs.existsSync(checkpointFile(dir)), "файла чекпоинта нет на диске");
    // Окно присылает только реплики: просьба та же, плюс обрывок ответа и «продолжай».
    const renderer = [
      { role: "user", content: "поправь конфиг и перезапусти сервер" },
      { role: "assistant", content: "Смотрю конфиг" },
      { role: "assistant", content: "⏸ Пауза. Работа сохранена." },
      { role: "user", content: "продолжай" },
    ];
    const plan = ctx.plan(renderer);
    assert.strictEqual(plan.resumed, true, "работа не вернулась в контекст");
    assert.ok(plan.notice && plan.notice.indexOf("Продолжаю с места остановки") >= 0, "нет честного сообщения о продолжении");
    assert.ok(/шагов/.test(plan.notice) && /результатов инструментов: 2/.test(plan.notice), "сообщение не говорит, сколько работы вернулось: " + plan.notice);
    const toolResults = plan.history.filter((m) => m.role === "tool");
    assert.strictEqual(toolResults.length, 2, "результатов инструментов в контексте: " + toolResults.length);
    assert.deepStrictEqual(
      toolResults.map((m) => m.tool_call_id),
      ["call_1", "call_2"],
      "результаты потеряли свой tool_call_id — разбор пар выбросит их как осиротевшие"
    );
    assert.ok(
      plan.history.some((m) => m.role === "tool" && m.content.indexOf("module.exports") >= 0),
      "в контекст не вернулось содержимое, которое агент уже прочитал"
    );
    // Свежая просьба — в конце, и она есть ровно один раз.
    assert.strictEqual(plan.history[plan.history.length - 1].content, "продолжай", "новая просьба не последняя");
    const sameText = plan.history.filter((m) => m.role === "user" && m.content === "поправь конфиг и перезапусти сервер").length;
    assert.strictEqual(sameText, 1, "история удвоила просьбу человека");
  });

  await test("2. пары assistant→tool не разорваны: провайдер не ответит 400", () => {
    const dir = tmpDir("pairs");
    const ctx = mk(dir);
    ctx.save(workingHistory());
    const plan = ctx.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }, { role: "user", content: "продолжай" }]);
    assert.strictEqual(plan.resumed, true);
    // Инвариант канонической истории: у каждого tool есть предшествующий assistant
    // с ТЕМ ЖЕ tool_call_id и ровно один вызов на результат.
    const ids = new Set();
    for (const m of plan.history) {
      if (m.role === "tool") {
        assert.ok(ids.has(m.tool_call_id), "осиротевший результат инструмента в контексте: " + m.tool_call_id);
        ids.delete(m.tool_call_id);
      } else if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) ids.add(c.id);
      }
    }
    assert.strictEqual(ids.size, 0, "вызов без результата остался в контексте — это и есть 400 от провайдера");
  });

  await test("3. окно, которое не узнаётся в чекпоинте, не подклеиваем наугад", () => {
    const dir = tmpDir("unknown");
    const ctx = mk(dir);
    ctx.save(workingHistory());
    const renderer = [{ role: "user", content: "совсем другая задача" }, { role: "assistant", content: "делаю" }];
    const plan = ctx.plan(renderer);
    assert.strictEqual(plan.resumed, false, "к чужой переписке подклеена чужая работа");
    assert.deepStrictEqual(plan.history, renderer, "история изменена, хотя опоры не нашлось");
  });

  await test("4. чекпоинт другого чата и другой рабочей папки не подхватывается", () => {
    const dirA = tmpDir("a");
    const dirB = tmpDir("b");
    mk(dirA, "chat-A").save(workingHistory());
    const otherChat = mk(dirA, "chat-B");
    assert.strictEqual(otherChat.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }]).resumed, false, "работа чужого чата ушла в контекст");
    const otherDir = mk(dirB, "chat-A");
    assert.strictEqual(otherDir.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }]).resumed, false, "работа из другой папки ушла в контекст");
    assert.strictEqual(otherDir.info().exists, false, "чекпоинт другой папки считается своим");
    // А это — настоящее «другая рабочая папка»: проект скопировали или переименовали,
    // файл чекпоинта лежит уже в новой папке, а внутри записана СТАРАЯ («dir»). Без
    // сверки папки такая работа считалась бы своей, и агент продолжил бы чужой
    // проект. Прежняя версия проверки этого не ловила: в чужой папке просто не было
    // файла, и строка «в другой папке работа не подхватилась» проходила вхолостую
    // (нашлось негативным контролем).
    const moved = path.join(dirB, ".agent", "runs", "chat-A.json");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.writeFileSync(
      moved,
      JSON.stringify({
        v: RUN_CTX_VERSION,
        dir: dirA,
        chatId: "chat-A",
        at: Date.now(),
        steps: 2,
        messages: [{ role: "user", content: "поправь конфиг и перезапусти сервер" }],
      })
    );
    const afterMove = mk(dirB, "chat-A");
    assert.ok(fs.existsSync(moved), "файл чекпоинта в новой папке не создан — проверка опять вхолостую");
    assert.strictEqual(afterMove.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }]).resumed, false, "работа, записанная для прежней папки, подхватилась в новой");
    assert.strictEqual(afterMove.info().exists, false, "чекпоинт, записанный для прежней папки, считается своим");
  });

  await test("5. без известного чата модуль молчит и файлов не создаёт", () => {
    const dir = tmpDir("nochat");
    const ctx = mk(dir, "");
    const saved = ctx.save(workingHistory());
    assert.strictEqual(saved.ok, false, "запись без чата: общий чекпоинт подсунул бы работу чужой переписке");
    assert.strictEqual(ctx.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }]).resumed, false, "контекст вернулся без чата");
    assert.ok(!fs.existsSync(path.join(dir, ".agent", "runs")), "папка чекпоинтов создана без надобности");
  });

  await test("6. в чекпоинт не едут системный промпт и сводка миссии, а реплики и результаты — едут", () => {
    const dir = tmpDir("content");
    const ctx = mk(dir);
    const history = workingHistory().concat([
      { role: "system", content: "СОСТОЯНИЕ РАБОТЫ (миссия идёт; блок собран приложением)\nЦель: поправить конфиг" },
      { role: "user", content: "и перезапусти" },
    ]);
    ctx.save(history);
    const raw = fs.readFileSync(checkpointFile(dir), "utf8");
    assert.ok(raw.indexOf("ТЫ АГЕНТ") < 0, "системный промпт уехал в чекпоинт");
    assert.ok(raw.indexOf("СОСТОЯНИЕ РАБОТЫ") < 0, "сводка миссии уехала в чекпоинт (она собирается заново)");
    const data = JSON.parse(raw);
    assert.strictEqual(data.v, 1, "неизвестная версия формата");
    assert.strictEqual(data.dir, dir, "чекпоинт не помнит свою рабочую папку");
    assert.strictEqual(data.chatId, "chat-1", "чекпоинт не помнит чат");
    assert.strictEqual(data.messages.filter((m) => m.role === "tool").length, 2, "результаты инструментов не сохранены");
    assert.strictEqual(data.messages[data.messages.length - 1].content, "и перезапусти", "свежая реплика человека потеряна");
  });

  await test("7. секреты из переписки на диск не попадают", () => {
    const dir = tmpDir("secret");
    const ctx = mk(dir);
    const key = "sk-" + "A".repeat(40);
    ctx.save([
      { role: "user", content: "вот ключ " + key },
      { role: "tool", tool_call_id: "call_1", content: "лог с ключом " + key },
    ]);
    const raw = fs.readFileSync(checkpointFile(dir), "utf8");
    assert.ok(raw.indexOf(key) < 0, "ключ уехал в файл проекта");
    assert.ok(raw.indexOf("[секрет скрыт]") >= 0, "маскировка секретов не сработала");
  });

  await test("8. гигантский вывод обрезается, но начало и конец остаются", () => {
    const dir = tmpDir("big");
    const ctx = mk(dir);
    const big = "НАЧАЛО\n" + "x".repeat(200000) + "\nКОНЕЦ_СБОРКИ_УПАЛО";
    // Результат идёт со СВОИМ вызовом: одиночный tool — сирота, и его вычищает
    // разбор пар (это отдельная проверка), а здесь важно именно ужатие.
    const saved = ctx.save([
      { role: "user", content: "запусти сборку" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "runCommand", arguments: JSON.stringify({ command: "npm run build" }) } }],
      },
      { role: "tool", tool_call_id: "call_1", content: big },
    ]);
    assert.strictEqual(saved.ok, true);
    const data = JSON.parse(fs.readFileSync(checkpointFile(dir), "utf8"));
    const toolMsg = data.messages.filter((m) => m.role === "tool")[0];
    assert.ok(toolMsg, "результат сборки не сохранён вовсе");
    const text = toolMsg.content;
    assert.ok(text.length < 12000, "вывод не обрезан: " + text.length + " символов");
    assert.ok(text.indexOf("НАЧАЛО") >= 0, "потеряно начало вывода");
    assert.ok(text.indexOf("КОНЕЦ_СБОРКИ_УПАЛО") >= 0, "потерян хвост вывода — а именно там ошибка");
    assert.ok(text.indexOf("обрезано") >= 0, "обрезка не названа честно");
  });

  await test("9. оборванный ответ (вызовы без результатов) не висит в конце", () => {
    const dir = tmpDir("dangling");
    const ctx = mk(dir);
    ctx.save([
      { role: "user", content: "перезапусти сервер" },
      {
        role: "assistant",
        content: "Запускаю",
        tool_calls: [{ id: "call_9", type: "function", function: { name: "runCommand", arguments: JSON.stringify({ command: "npm start" }) } }],
      },
    ]);
    const raw = fs.readFileSync(checkpointFile(dir), "utf8");
    const data = JSON.parse(raw);
    const last = data.messages[data.messages.length - 1];
    assert.ok(!(last.role === "assistant" && Array.isArray(last.tool_calls)), "на диске остался вызов без результата — следующий запрос упал бы 400");
    const plan = ctx.plan([{ role: "user", content: "перезапусти сервер" }]);
    const tail = plan.history[plan.history.length - 1];
    assert.ok(!(tail && tail.role === "assistant" && Array.isArray(tail.tool_calls)), "в контекст вернулся вызов без результата");
  });

  await test("10. картинка не сохраняется мегабайтами base64", () => {
    const dir = tmpDir("image");
    const ctx = mk(dir);
    const dataUrl = "data:image/png;base64," + "B".repeat(50000);
    ctx.save([
      { role: "user", content: [{ type: "text", text: "посмотри на скриншот" }, { type: "image_url", image_url: { url: dataUrl } }] },
    ]);
    const raw = fs.readFileSync(checkpointFile(dir), "utf8");
    assert.ok(raw.indexOf("data:image/png;base64") < 0, "base64-картинка уехала в чекпоинт");
    assert.ok(raw.indexOf("посмотри на скриншот") >= 0, "текст реплики потерян вместе с картинкой");
    assert.ok(raw.indexOf("изображение") >= 0, "пометка о картинке не поставлена");
  });

  await test("11. сирота-результат без своего вызова вычищается", () => {
    const dir = tmpDir("orphan");
    const ctx = mk(dir);
    ctx.save([
      { role: "user", content: "покажи файл" },
      { role: "tool", tool_call_id: "call_нет_вызова", content: "лишний результат" },
      { role: "assistant", content: "готово" },
    ]);
    const data = JSON.parse(fs.readFileSync(checkpointFile(dir), "utf8"));
    assert.strictEqual(data.messages.filter((m) => m.role === "tool").length, 0, "осиротевший результат сохранён");
  });

  await test("12. файл не растёт выше потолка и остаётся читаемым", () => {
    const dir = tmpDir("cap");
    const ctx = mk(dir);
    const many = [{ role: "user", content: "длинная работа" }];
    for (let i = 0; i < 300; i++) {
      many.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c" + i, type: "function", function: { name: "readFile", arguments: "{}" } }],
      });
      many.push({ role: "tool", tool_call_id: "c" + i, content: "данные " + i + "\n" + "y".repeat(6000) });
    }
    const saved = ctx.save(many);
    assert.strictEqual(saved.ok, true, "чекпоинт длинной работы не записан: " + (saved.reason || ""));
    const size = fs.statSync(checkpointFile(dir)).size;
    assert.ok(size <= RUN_CTX_MAX_BYTES, "файл больше потолка: " + size);
    const data = JSON.parse(fs.readFileSync(checkpointFile(dir), "utf8"));
    assert.ok(data.messages.length >= 2, "от истории не осталось ничего");
    assert.ok(data.messages.some((m) => m.role === "tool" && m.content.indexOf("данные 299") >= 0), "потерян самый свежий шаг работы");
  });

  await test("13. битый файл не роняет прогон и перезаписывается", () => {
    const dir = tmpDir("broken");
    const ctx = mk(dir);
    fs.mkdirSync(path.dirname(checkpointFile(dir)), { recursive: true });
    fs.writeFileSync(checkpointFile(dir), "{это не json", "utf8");
    assert.strictEqual(ctx.info().exists, false, "битый чекпоинт считается рабочим");
    assert.strictEqual(ctx.plan([{ role: "user", content: "привет" }]).resumed, false, "битый чекпоинт подклеен к контексту");
    assert.strictEqual(ctx.save(workingHistory()).ok, true, "после битого файла чекпоинт не пишется");
    assert.strictEqual(ctx.info().exists, true, "чекпоинт не восстановился");
  });

  await test("14. обычный финал удаляет чекпоинт, пауза — оставляет", () => {
    const dir = tmpDir("close");
    const ctx = mk(dir);
    ctx.save(workingHistory());
    assert.strictEqual(ctx.info().exists, true, "чекпоинт не записан");
    assert.strictEqual(ctx.close(), true);
    assert.strictEqual(ctx.info().exists, false, "после финала остался чекпоинт незавершённого прогона");
    assert.strictEqual(ctx.plan([{ role: "user", content: "поправь конфиг и перезапусти сервер" }]).resumed, false, "сданная работа вернулась в контекст");
    // Закрытие пустого чекпоинта — не ошибка: финал бывает и без работы.
    const fresh = mk(tmpDir("close2"));
    assert.strictEqual(fresh.close(), true, "закрытие пустого чекпоинта считается ошибкой");
  });

  await test("15. решение о продолжении — чистым разбором, без диска", () => {
    const cp = [{ role: "user", content: "задача" }, { role: "assistant", content: "делаю" }];
    const merged = planResume(cp, [
      { role: "user", content: "старое" },
      { role: "user", content: "задача" },
      { role: "assistant", content: "обрывок" },
      { role: "user", content: "продолжай" },
    ]);
    assert.strictEqual(merged.resumed, true);
    assert.deepStrictEqual(merged.history.map((m) => m.content), ["задача", "делаю", "обрывок", "продолжай"], "порядок истории неверен");
    // Опора — ПОСЛЕДНЯЯ узнанная реплика человека: более раннее совпадение не должно
    // втянуть в конец всю переписку заново.
    const twice = planResume(cp, [
      { role: "user", content: "задача" },
      { role: "assistant", content: "старый ответ" },
      { role: "user", content: "задача" },
      { role: "user", content: "ещё просьба" },
    ]);
    assert.deepStrictEqual(twice.history.map((m) => m.content), ["задача", "делаю", "ещё просьба"], "взята не последняя опора");
    assert.strictEqual(planResume([], [{ role: "user", content: "x" }]).resumed, false, "пустой чекпоинт дал продолжение");
  });

  await test("16. прогон действительно зовёт контекст: план, запись и закрытие на месте", () => {
    assert.ok(MAIN_SRC.indexOf('require("./run-context.js")') >= 0, "main.js не подключает модуль контекста прогона");
    assert.ok(/createRunContext,\s*\n/.test(MAIN_SRC), "модуль не передан прогону");
    assert.ok(/const runCtx = createRunContext\(\{/.test(RUN_AI_SRC), "прогон не собирает контекст");
    assert.ok(/runCtx\.plan\(runHistory\)/.test(RUN_AI_SRC), "прогон не возвращает работу в контекст");
    assert.ok(/if \(resumePlan\.resumed\)/.test(RUN_AI_SRC), "сообщение о продолжении не зависит от решения плана");
    assert.ok(/runCtx\.save\(canonical\);/.test(RUN_AI_SRC), "чекпоинт не пишется по ходу работы");
    assert.ok(/if \(!stopNote\) runCtx\.close\(\);/.test(RUN_AI_SRC), "финал прогона не закрывает чекпоинт");
    // Работа возвращается ЖИВЫМ значением рабочей папки: клонирование и смена
    // проекта меняют её на ходу, копия застыла бы на прежней.
    assert.ok(/dir: \(\) => workDir/.test(RUN_AI_SRC), "рабочая папка передана копией");
    assert.ok(/id: live\.activeRunChatId/.test(RUN_AI_SRC), "чат прогона передан копией вместо живого значения");
    // Вызовы и их результаты обязаны дожить до канонической истории: проверка
    // держит именно то место, где их легко потерять (map по role+content).
    assert.ok(/if \(m\.tool_calls\) one\.tool_calls = m\.tool_calls;/.test(RUN_AI_SRC), "вызовы инструментов теряются при сборке истории");
    assert.ok(/if \(m\.tool_call_id\) one\.tool_call_id = m\.tool_call_id;/.test(RUN_AI_SRC), "tool_call_id теряется при сборке истории");
  });

  cleanup();
  console.log("\n  контекст прогона: прошло " + passed + ", упало " + failed);
  process.exit(failed ? 1 : 0);
})();

"use strict";
/* ─── Живой прогон ожидания ответа: агент ДЕЙСТВИТЕЛЬНО ждёт человека ─────────
   Запуск: node scripts/live-ask-wait.js   (npm run test:live:ask-wait)

   Зачем отдельный прогон. Набор (test/ask-wait.test.js) водит модуль напрямую и
   подменяет время. Он не проверяет главного: что НАСТОЯЩИЙ прогон на настоящем
   main.js действительно ОСТАНАВЛИВАЕТСЯ на вопросе, что варианты ответа доезжают
   до окна, что ответ человека уходит в модель результатом ИМЕННО ЭТОГО вызова, и
   что забытый таймер больше не «отвечает» на следующий вопрос.

   Жалоба человека, из которой всё выросло: «агент открыл окно с вопросом, а сам не
   остановился и продолжил что-то делать». Здесь это проверяется поведением.
   Каждое утверждение живёт в СВОЁМ прогоне — иначе проверка «ожидание снято» ловила
   бы уже следующий вопрос (ровно эта ошибка была допущена в первой редакции):

     [1] оболочка собирает модуль ожидания и отдаёт его прогону;
     [2] прогон A: на вопросе прогон СТОИТ, варианты доехали до окна очищенными;
     [3] прогон A: ответ уходит модели результатом того же вызова, финал снимает ожидание;
     [4] прогон B: таймер отвеченного вопроса снят и, если его заставить сработать,
         он НЕ отвечает за следующий вопрос (та самая жалоба);
     [5] прогон C: поздний ответ после конца прогона не уезжает никуда.

   Подмена здесь одна и честная: у модуля ожидания перехватываются таймеры, чтобы
   «забытый» таймер можно было заставить сработать немедленно. Ничего в репозитории
   приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-ask-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-ask-work-"));
const CHAT_A = "chat-live-ask-a";
const CHAT_B = "chat-live-ask-b";
const CHAT_C = "chat-live-ask-c";
const ANSWER_A = "Вариант Б — сохранить рядом с проектом";
const ANSWER_B1 = "Да, по умолчанию";
const ANSWER_B2 = "PDF";

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2)
);

const handlers = new Map();
const events = [];
const windows = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => {
        events.push({ ch, ev });
        w.webContents.sent.push({ ch, ev });
      },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
      setWindowOpenHandler: () => {},
    },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    on: () => {},
    once: () => {},
    loadFile: () => Promise.resolve(),
    show: () => {},
    focus: () => {},
    restore: () => {},
    maximize: () => {},
    setTitle: () => {},
    close: () => {},
  };
  windows.push(w);
  return w;
};

// ── Подменённый провайдер: у каждого прогона свой сценарий ──────────────────
// A: вопрос с мусором в вариантах → финал.
// B: вопрос → второй вопрос → финал (между ними и «сработает» забытый таймер).
// C: обычный финал — проверяем, что поздний ответ в него не уехал.
const LONG_OPTION = "я".repeat(200);
const bodies = [];
const counts = { A: 0, B: 0, C: 0 };
let current = "A";
let served = 0;
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const textChunks = (text) => [
  { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
  { choices: [], usage: { prompt_tokens: 300, completion_tokens: 30 } },
];
const callChunks = (id, name, args) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [], usage: { prompt_tokens: 300, completion_tokens: 30 } },
];
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model", context_length: 128000 }] }));
    }
    if (!u.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
    }
    served++;
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const n = ++counts[current];
    bodies.push({ run: current, n: served, inRun: n, messages: parsed.messages || [] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (current === "A" && n === 1) {
      return res.end(
        sse(
          callChunks("call_ask_A1", "askUser", {
            question: "Куда сохранить отчёт?",
            options: ["Вариант А", ANSWER_A, ANSWER_A, "", LONG_OPTION, "Вариант В", "Вариант Г", "Вариант Д", "Вариант Е"],
          })
        )
      );
    }
    if (current === "A") return res.end(sse(textChunks("Готово: отчёт сохранён.")));
    if (current === "B" && n === 1) {
      return res.end(sse(callChunks("call_ask_B1", "askUser", { question: "Сохранить рядом с проектом?", options: ["Да", "Нет"] })));
    }
    if (current === "B" && n === 2) {
      return res.end(sse(callChunks("call_ask_B2", "askUser", { question: "В каком формате?", options: ["PDF", "DOCX"] })));
    }
    if (current === "B") return res.end(sse(textChunks("Готово: отчёт в PDF.")));
    return res.end(sse(textChunks("Просто ответ текстом.")));
  });
});

// Перехватываем сборку модуля ожидания: видим, с чем его позвал НАСТОЯЩИЙ прогон,
// и можем заставить «забытый» таймер сработать немедленно (подмена времени).
const seen = { wait: 0, waitDeps: null };
const timers = [];
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.211",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => handlers.set("on:" + ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(21); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (/ask-wait\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      ...real,
      createAskWait: (deps) => {
        seen.wait++;
        seen.waitDeps = deps;
        return real.createAskWait({
          ...deps,
          setTimeout: (fn, ms) => {
            const id = setTimeout(fn, ms);
            timers.push({ id, fn, ms, cleared: false, run: current });
            return id;
          },
          clearTimeout: (id) => {
            const rec = timers.find((x) => x.id === id);
            if (rec) rec.cleared = true;
            clearTimeout(id);
          },
        });
      },
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 180 секунд");
  process.exit(1);
}, 180000);
watchdog.unref();

let liveWin = null;
const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  const ev = liveWin ? { sender: liveWin.webContents, senderFrame: { parent: null } } : null;
  return Promise.resolve(fn(ev, ...args));
};
const asks = () => events.filter((e) => e.ev && e.ev.type === "ask");
const pending = () => (seen.waitDeps && seen.waitDeps.live ? seen.waitDeps.live.pendingAsk : null);
const waitFor = async (cond, ms) => {
  for (let i = 0; i < Math.ceil(ms / 50); i++) {
    if (cond()) return true;
    await sleep(50);
  }
  return !!cond();
};
const bodiesOf = (run) => bodies.filter((b) => b.run === run);
const toolOf = (body, id) => (body ? body.messages.filter((m) => m.role === "tool" && m.tool_call_id === id) : []);

(async () => {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const providerBase = "http://127.0.0.1:" + provider.address().port + "/v1";

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон ожидания ответа (настоящий main.js без окна)");
  await sleep(400);
  liveWin = windows[0];

  console.log("\n[1] оболочка собирает модуль ожидания и отдаёт его прогону");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const runAiSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
  ok(mainSrc.indexOf('require("./ask-wait.js")') >= 0, "main.js подключает модуль ожидания ответа");
  ok(/const \{ runAi \} = createRunAi\(\{[\s\S]{0,400}?createAskWait,/.test(mainSrc), "модуль передан прогону");
  ok(/const askWait = createAskWait\(\{ emit, live \}\)/.test(runAiSrc), "прогон собирает модуль на своём месте");
  ok(runAiSrc.indexOf("300000") < 0, "в прогоне не осталось старого таймера на пять минут");
  ok(/askWait\.cancel\(\)/.test(runAiSrc), "конец прогона снимает ожидание ответа");
  ok(seen.wait === 0, "до первого прогона модуль не создаётся зря");

  const saved = await callIpc("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: work,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));

  console.log("\n[2] прогон A: на вопросе прогон СТОИТ, варианты доехали до окна очищенными");
  current = "A";
  const runA = callIpc("ai:send", [{ role: "user", content: "сделай отчёт и сохрани" }], { chatId: CHAT_A, role: "developer" });
  await waitFor(() => asks().length >= 1, 5000);
  ok(served === 1, "модель спросила человека (запросов: " + served + ")");
  ok(asks().length === 1, "окну ушёл ровно один вопрос: " + asks().length);
  const askA = asks()[0] && asks()[0].ev;
  ok(!!askA && askA.question === "Куда сохранить отчёт?", "текст вопроса дошёл как есть: " + JSON.stringify(askA && askA.question));
  const opts = (askA && askA.options) || [];
  ok(opts.length === 6, "вариантов ровно шесть (лишние обрезаны): " + opts.length);
  ok(opts[0] === "Вариант А" && opts[1] === ANSWER_A, "варианты дошли по порядку: " + JSON.stringify(opts.slice(0, 2)));
  ok(new Set(opts).size === opts.length, "дубли вариантов не пролезли");
  const long = opts.find((o) => o.length > 100);
  ok(!!long && long.length === 120 && /…$/.test(long), "длинный вариант обрезан и помечен: " + (long ? long.length : "нет"));
  ok(opts.indexOf("") < 0, "пустой вариант в окно не ушёл");
  ok(typeof pending() === "function", "прогон ждёт ответа (ожидание стоит в живом значении)");
  await sleep(700);
  ok(served === 1, "за время ожидания прогон НЕ пошёл дальше (запросов: " + served + ")");
  ok(asks().length === 1, "нового вопроса нет, пока не отвечен старый: " + asks().length);

  console.log("\n[3] прогон A: ответ уходит модели результатом того же вызова, финал снимает ожидание");
  ok((await callIpc("ai:answer", ANSWER_A)) === true, "канал ответа принял ответ человека");
  await waitFor(() => served >= 2, 5000);
  ok(served >= 2, "прогон продолжился после ответа (запросов: " + served + ")");
  const a2 = bodiesOf("A")[1];
  const toolA = toolOf(a2, "call_ask_A1");
  ok(toolA.length === 1, "модель получила результат вызванного инструмента: " + toolA.length);
  ok(toolA.length === 1 && String(toolA[0].content).indexOf(ANSWER_A) >= 0, "в модель ушёл ответ человека, а не заглушка");
  ok(timers.length >= 1 && timers[0].cleared === true, "таймер отвеченного вопроса снят (забытый таймер не остался жить)");
  const rA = await runA;
  ok(rA && rA.ok === true, "прогон A дошёл до конца без ошибки: " + JSON.stringify(rA && rA.error));
  ok(pending() === null, "финал снял ожидание: ждать больше некого");
  ok((await callIpc("ai:answer", "поздний ответ в закончившийся прогон")) === false, "поздний ответ отклонён, а не подменён в следующий прогон");

  console.log("\n[4] прогон B: таймер отвеченного вопроса не отвечает за СЛЕДУЮЩИЙ вопрос");
  current = "B";
  const mark = timers.length;
  const runB = callIpc("ai:send", [{ role: "user", content: "сделай отчёт в два шага: где и в каком формате" }], { chatId: CHAT_B, role: "developer" });
  await waitFor(() => asks().length >= 2, 5000);
  ok(asks().length === 2, "пришёл первый вопрос прогона B: " + asks().length);
  ok((await callIpc("ai:answer", ANSWER_B1)) === true, "человек ответил быстро — до срока таймера");
  await waitFor(() => asks().length >= 3, 5000);
  ok(asks().length === 3, "пришёл второй вопрос: " + asks().length);
  const timerB1 = timers[mark];
  const timerB2 = timers[mark + 1];
  ok(!!timerB1 && timerB1.run === "B", "таймер первого вопроса заведён в прогоне B");
  ok(!!timerB1 && timerB1.cleared === true, "таймер отвеченного вопроса снят (это и был забытый таймер)");
  ok(!!timerB2 && timerB2.cleared === false, "таймер ждущего вопроса жив — вопрос по времени не брошен");
  ok(typeof pending() === "function", "второй вопрос действительно ждёт человека");
  const servedBefore = served;
  if (timerB1) timerB1.fn(); // худший случай: таймер отвеченного вопроса всё-таки сработал
  await sleep(400);
  ok(served === servedBefore, "сработавший старый таймер НЕ отправил прогон дальше (запросов: " + served + ")");
  ok(typeof pending() === "function", "второй вопрос остался ждать ответа человека");
  ok(bodiesOf("B").filter((b) => b.messages.some((m) => m.role === "tool" && /не дал ответ/.test(String(m.content)))).length === 0,
    "в модель не ушло «пользователь не дал ответ» на неотвеченный вопрос");
  ok((await callIpc("ai:answer", ANSWER_B2)) === true, "человек ответил на второй вопрос");
  await waitFor(() => counts.B >= 3, 5000);
  const b3 = bodiesOf("B")[2];
  const toolB2 = toolOf(b3, "call_ask_B2");
  ok(toolB2.length === 1 && String(toolB2[0].content).indexOf(ANSWER_B2) >= 0, "второй ответ дошёл до модели как результат СВОЕГО вызова: " + JSON.stringify(toolB2[0] && String(toolB2[0].content).slice(0, 40)));
  const rB = await runB;
  ok(rB && rB.ok === true, "прогон B дошёл до конца без ошибки: " + JSON.stringify(rB && rB.error));
  ok(timers.every((t) => t.cleared), "ни один таймер не остался жить после прогона: " + timers.filter((t) => !t.cleared).length + " живых");

  console.log("\n[5] прогон C: поздний ответ чужого вопроса в новую работу не уезжает");
  current = "C";
  const asksBefore = asks().length;
  const rC = await callIpc("ai:send", [{ role: "user", content: "просто ответь текстом" }], { chatId: CHAT_C, role: "developer" });
  ok(rC && rC.ok === true, "прогон C прошёл: " + JSON.stringify(rC && rC.error));
  const c1 = bodiesOf("C")[0] || { messages: [] };
  ok(asks().length === asksBefore, "в прогоне C вопроса не было — ждать было нечего: " + (asks().length - asksBefore));
  ok(!c1.messages.some((m) => /поздний ответ/.test(String(m.content))), "поздний ответ в новую работу не попал");
  ok(pending() === null, "после всех прогонов ожидания нет");
  ok(seen.wait === 3, "модуль ожидания собран каждым прогоном (собрано: " + seen.wait + ")");
  ok(!fs.existsSync(path.join(ROOT, ".agent")), "работа не легла в репозиторий приложения");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  provider.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

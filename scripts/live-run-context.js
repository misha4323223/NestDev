"use strict";
/* ─── Живой прогон контекста прогона: работа переживает остановку ─────────────
   Запуск: node scripts/live-run-context.js   (npm run test:live:run-context)

   Зачем отдельный прогон. Набор (test/run-context.test.js) водит модуль с настоящей
   файловой системой, но он НЕ проверяет главного: что НАСТОЯЩИЙ main.js собирает
   модуль на своём месте, отдаёт ему ЖИВУЮ рабочую папку и настоящий разбор пар, и
   что прогон действительно возвращает работу в контекст после остановки. Ошибки
   тут тихие и дорогие:

     • модуль собран, но не вызван — пауза снова теряет весь ход работы, и это
       видно только по поведению агента («зачем ты опять читаешь этот файл?»);
     • рабочая папка ушла копией — чекпоинт лёг бы в прежний проект;
     • результат инструмента потерял tool_call_id — разбор пар выбросил бы его,
       и контекст вернулся бы «пустым» (прогон выглядел бы как продолжение ни с чем);
     • чекпоинт не удаляется на финале — следующая задача в том же чате потащила бы
       за собой работу, которую человек уже принял.

   Здесь всё по-настоящему: main.js грузится в Node с поддельным electron, провайдера
   изображает локальный HTTP-сервер, первый прогон выполняет НАСТОЯЩИЙ инструмент
   (readFile читает настоящий файл) и останавливается по «Стоп» посреди ответа модели,
   а второй прогон идёт как «продолжай» из окна — и обязан получить в запросе
   результат инструмента из остановленного прогона.

   Разделы:
     [1] main.js собрал модуль и отдал ему ЖИВЫЕ зависимости (папка — функцией);
     [2] остановленный прогон оставил чекпоинт с результатом инструмента;
     [3] «продолжай»: работа вернулась в запрос к модели, человеку сказано об этом;
     [4] обычный финал чекпоинт убирает, а чужой чат чужую работу не подхватывает.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-ctx-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-ctx-work-"));
const CHAT = "chat-live-run-context";
const OTHER_CHAT = "chat-live-run-context-other";
// Маркер живёт внутри файла: если работа вернулась в контекст, он окажется в запросе
// к модели; если контекст потерян — модель обязана сходить за файлом заново.
const MARKER = "УНИКАЛЬНЫЙ_МАРКЕР_РАБОТЫ_41";
fs.writeFileSync(path.join(work, "read.txt"), MARKER + "\nвторая строка файла", "utf8");

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

// ── Подменённый провайдер: SSE-поток по фазам прогона ────────────────────────
// run1: первый запрос — вызов НАСТОЯЩЕГО readFile; второй и дальнейшие — молчание
//       (соединение держим, чтобы «Стоп» прервал прогон посреди ответа модели).
// run2: простой финальный ответ.
let phase = "run1";
let served = 0;
const bodies = [];
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
    const entry = { phase: phase, messages: parsed.messages || [] };
    bodies.push(entry);
    if (phase === "run1" && served === 1) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(sse(callChunks("call_read_1", "readFile", { path: path.join(work, "read.txt") })));
    }
    if (phase === "run1") {
      // Молчим: прогон ждёт ответа модели, и именно в этот момент человек жмёт «Стоп».
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    return res.end(sse(textChunks("Продолжил с того же места: файл уже прочитан, правлю дальше.")));
  });
});

// Перехватываем сборку модуля: видим, с чем его позвал НАСТОЯЩИЙ main.js.
const seen = { ctx: 0, ctxDeps: null };
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
        getVersion: () => "1.5.210",
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
  if (/run-context\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createRunContext: (deps) => {
        seen.ctx++;
        seen.ctxDeps = deps;
        return real.createRunContext(deps);
      },
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 150 секунд");
  process.exit(1);
}, 150000);
watchdog.unref();

let liveWin = null;
const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  const ev = liveWin ? { sender: liveWin.webContents, senderFrame: { parent: null } } : null;
  return Promise.resolve(fn(ev, ...args));
};

(async () => {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const providerBase = "http://127.0.0.1:" + provider.address().port + "/v1";

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон контекста прогона (настоящий main.js без окна)");
  await sleep(400);
  const win = windows[0];
  liveWin = win;

  // Модуль контекста собирается НА КАЖДЫЙ прогон (его зависимости — про этот прогон),
  // поэтому сначала — только статичная проверка проводки в оболочке.
  console.log("\n[1] оболочка собирает модуль контекста и передаёт его прогону");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const runAiSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
  ok(mainSrc.indexOf('require("./run-context.js")') >= 0, "main.js подключает модуль контекста прогона");
  ok(/const \{ runAi \} = createRunAi\(\{[\s\S]{0,400}?createRunContext,/.test(mainSrc), "модуль передан прогону");
  ok(/const runCtx = createRunContext\(\{/.test(runAiSrc), "прогон собирает модуль в начале работы");
  ok(/if \(!stopNote\) runCtx\.close\(\);/.test(runAiSrc), "обычный финал закрывает чекпоинт");
  ok(seen.ctx === 0, "до первого прогона модуль не создаётся зря");

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

  const ctxFile = path.join(work, ".agent", "runs", CHAT + ".json");

  console.log("\n[2] остановленный прогон оставил работу на диске");
  const run1 = callIpc("ai:send", [{ role: "user", content: "прочитай файл read.txt" }], { chatId: CHAT, role: "developer" });
  // Ждём, пока прогон выполнит инструмент и снова спросит модель (второй запрос).
  for (let i = 0; i < 200 && served < 2; i++) await sleep(50);
  ok(served >= 2, "прогон выполнил инструмент и снова спросил модель (запросов: " + served + ")");
  ok(fs.existsSync(ctxFile), "чекпоинт появился на диске ещё до остановки: " + path.relative(work, ctxFile));
  await callIpc("ai:stop");
  const r1 = await run1;
  ok(r1 && r1.ok === false, "«Стоп» прервал прогон посреди ответа модели: " + JSON.stringify(r1));
  ok(fs.existsSync(ctxFile), "после остановки чекпоинт ОСТАЛСЯ (работа не сдана)");
  const cpRaw = fs.readFileSync(ctxFile, "utf8");
  ok(cpRaw.indexOf(MARKER) >= 0, "в чекпоинте лежит результат настоящего инструмента (маркер файла)");
  const cp = JSON.parse(cpRaw);
  const cpTools = cp.messages.filter((m) => m.role === "tool");
  ok(cpTools.length === 1 && cpTools[0].tool_call_id === "call_read_1", "результат сохранил свой tool_call_id: " + JSON.stringify(cpTools.map((m) => m.tool_call_id)));
  ok(cp.dir === work && cp.chatId === CHAT, "чекпоинт помнит свою папку и чат");
  ok(cpRaw.indexOf("УНИКАЛЬНЫЙ") >= 0 && cpRaw.indexOf("data:image") < 0, "в чекпоинт уехала работа, а не служебные данные интерфейса");
  // Модуль собран ПРОГОНОМ — и собран с живыми зависимостями этого прогона.
  ok(seen.ctx === 1, "createRunContext собран прогоном: " + seen.ctx + " раз(а)");
  const cd = seen.ctxDeps || {};
  ok(typeof cd.dir === "function", "рабочая папка передана ФУНКЦИЕЙ (её меняет клонирование и смена проекта)");
  ok(typeof cd.dir === "function" && cd.dir() === work, "функция отдаёт настоящую рабочую папку прогона");
  ok(cd.id === CHAT, "чекпоинт заводится на чат ИМЕННО этого прогона: " + JSON.stringify(cd.id));
  ok(typeof cd.sanitizeToolPairs === "function", "разбор пар assistant→tool пришёл настоящий");

  console.log("\n[3] «продолжай»: работа вернулась в запрос к модели");
  phase = "run2";
  const before = events.length;
  const r2 = await callIpc("ai:send", [
    { role: "user", content: "прочитай файл read.txt" },
    { role: "assistant", content: "⏹ Остановлено пользователем." },
    { role: "user", content: "продолжай" },
  ], { chatId: CHAT, role: "developer" });
  ok(r2 && r2.ok === true, "второй прогон прошёл без ошибки: " + JSON.stringify(r2 && r2.error));
  const run2 = bodies.filter((b) => b.phase === "run2");
  ok(run2.length >= 1, "второй прогон дошёл до провайдера (запросов: " + run2.length + ")");
  const first2 = run2[0] || { messages: [] };
  const toolMsgs = first2.messages.filter((m) => m.role === "tool");
  ok(toolMsgs.length === 1, "в ПЕРВОМ же запросе второго прогона результат инструмента: " + toolMsgs.length);
  ok(toolMsgs.length === 1 && String(toolMsgs[0].content).indexOf(MARKER) >= 0, "вернулся именно результат прошлого шага, а не пустая заглушка");
  ok(toolMsgs.length === 1 && toolMsgs[0].tool_call_id === "call_read_1", "вызов и результат не разъехались — API не ответит 400");
  const humanAsks = first2.messages.filter((m) => m.role === "user" && m.content === "прочитай файл read.txt").length;
  ok(humanAsks === 1, "просьба человека не удвоилась в истории: " + humanAsks);
  ok(first2.messages[first2.messages.length - 1].content === "продолжай", "новая просьба стоит последней: " + JSON.stringify(first2.messages[first2.messages.length - 1].content));
  const notices = events.slice(before).filter((e) => e.ev && e.ev.type === "notice").map((e) => e.ev.text);
  ok(notices.some((t) => /Продолжаю с места остановки/.test(t)), "человеку сказано, что работа возвращена: " + JSON.stringify(notices).slice(0, 200));
  ok(notices.some((t) => /результатов инструментов/.test(t)), "в сообщении видно, сколько работы вернулось");
  // Прогон не пошёл перечитывать файл: запрос к провайдеру ровно один (сразу финал).
  ok(run2.length === 1, "второй прогон не тратил раунд на повторное чтение: запросов " + run2.length);

  console.log("\n[4] финал убирает чекпоинт, чужой чат чужую работу не подхватывает");
  ok(!fs.existsSync(ctxFile), "после обычного финала чекпоинт убран — возвращать в работу нечего");
  const otherBefore = events.length;
  const r3 = await callIpc("ai:send", [{ role: "user", content: "прочитай файл read.txt" }], { chatId: OTHER_CHAT, role: "developer" });
  ok(r3 && r3.ok === true, "прогон в другом чате прошёл: " + JSON.stringify(r3 && r3.error));
  const other = bodies.filter((b) => b.messages.some((m) => m.role === "user" && m.content === "прочитай файл read.txt") && !b.messages.some((m) => m.role === "tool"));
  ok(other.length >= 1, "в другом чате работа НЕ подтянулась: запрос без результатов инструментов");
  const otherNotices = events.slice(otherBefore).filter((e) => e.ev && e.ev.type === "notice").map((e) => e.ev.text);
  ok(!otherNotices.some((t) => /Продолжаю с места остановки/.test(t)), "чужому чату не сказано о продолжении");
  ok(seen.ctx === 3, "модуль собран каждым прогоном (собрано: " + seen.ctx + ")");
  ok(seen.ctxDeps && seen.ctxDeps.id === OTHER_CHAT, "последний прогон собрал модуль на СВОЙ чат: " + JSON.stringify(seen.ctxDeps && seen.ctxDeps.id));
  ok(!fs.existsSync(path.join(ROOT, ".agent", "runs")), "чекпоинты не легли в репозиторий приложения");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  provider.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

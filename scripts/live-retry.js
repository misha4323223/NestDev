"use strict";
/* ─── Живой прогон восстановления после отказов (main.js без окна Electron) ───
   Запуск: bun run test:live:retry   (node scripts/live-retry.js)

   Зачем. С этапа B, части 16 восстановление после отказа запроса (лимиты 429,
   «холодный» пул 503, отказ строгого сервера, переполнение контекста) живёт в
   src/run-retry.js, а ядро чата runAi зовёт его. Модульный набор водит модуль
   напрямую; здесь проверяется ПРОВОДКА и поведение НАСТОЯЩЕГО прогона: main.js
   грузится в Node с поддельным electron, а провайдера изображает локальный
   HTTP-сервер, который отвечает по сценарию — отказ, потом успех.

   Что проверяется по-настоящему:
     • 429: прогон ждёт САМ (время между запросами на сервере) и повторяет ТОТ ЖЕ
       раунд — тела запросов совпадают, человек ничего не пишет руками;
     • 503 cache_only_cold: пауза ровно та, что посчитало ядро;
     • строгий сервер без stream_options: следующий запрос уходит БЕЗ него;
     • переполнение контекста: бюджет контекста падает и история пересобирается;
     • успех снимает счётчики: следующий 429 снова «попытка 1»;
     • 402: прогон заканчивается понятной ошибкой (а не сырым JSON), и до неё
       внешний авто-повтор успевает сообщить о попытках;
     • шлюз провайдера (524 с HTML-страницей вместо JSON) и обрыв чтения тела запроса
       (400 «Could not read the request body»): прогон ЖДЁТ и повторяет тот же раунд
       сам, а не падает насмерть и не вываливает в чат простыню тегов;
     • оборванная связь (провайдер рвёт соединение, ответа нет вовсе): прогон ждёт
       и повторяет тот же раунд, а не останавливается молча (1.5.20x:

   Негативные контроли: --break=<имя> ломает одну проводку, и прогон обязан упасть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-retry-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-retry-work-"));
const BREAK = (() => {
  const a = process.argv.find((s) => s.startsWith("--break="));
  return a ? a.slice("--break=".length) : "";
})();

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BREAKS = {
  rate: ["src/run-retry.js", "      state.rateRetries++;\n", ""],
  wait: ["src/run-retry.js", "      await pause(waitMs);\n", ""],
  coldWait: ["src/run-retry.js", "        await pause(cold.waitMs);\n", ""],
  noteSuccess: ["src/run-retry.js", "    state.rateRetries = 0;\n    state.unavailableRetries = 0;\n", "    state.unavailableRetries = 0;\n"],
  usage: ["src/run-retry.js", "      state.includeUsage = false;\n", ""],
  cold: ["src/run-retry.js", "    if (cold) {\n", "    if (false && cold) {\n"],
  // Шлюзовые коды (524/520) снова уходят в фатальную ошибку: живой прогон обязан
  // упасть на сценарии со HTML-страницей шлюза.
  gateway: ["src/renderer/agent-core.js", "const gateway = is5xx && GATEWAY_CODES.indexOf(st) >= 0;", "const gateway = is5xx && false;"],
  // То же про обрыв чтения тела запроса.
  gatewayBody: [
    "src/renderer/agent-core.js",
    "const bodyRead = BODY_READ_RE.test(d) && (st === 400 || st === 411 || st === 413);",
    "const bodyRead = false && BODY_READ_RE.test(d) && (st === 400 || st === 411 || st === 413);",
  ],
  // Оборванная связь снова считается фатальной: живой прогон обязан упасть.
  transport: ["src/run-retry.js", "    if (!text || FATAL_NET.test(text) || !TRANSIENT_NET.test(text)) return null;", "    if (true) return null;"],
  context: ["src/run-retry.js", "      await shrinkContext();\n", ""],
  // Лимитер снова выдаётся НОВЫЙ на каждый запрос (карта темпа убрана). Так было
  // ДО выноса: «Стоп» и новый прогон получали свой лимитер, слали запрос сразу и
  // снова ловили 429. Проверка — «пауза 429 выждана ДО следующего запроса», а не
  // после него (её даёт не явная пауза повтора, а память лимитера).
  rateMemory: ["src/rate-limiters.js", "    if (!byKey.has(key)) byKey.set(key, createRateLimiter());\n    return byKey.get(key);\n", "    return createRateLimiter();\n"],
  // Памятку прогон получает отложенной стрелкой из модуля памяти (он собирается ниже).
  // Если проводка пустая, модульный набор этого не увидит (он водит модуль напрямую),
  // а длинная работа молча потеряет память — ловится только живым прогоном.
  memo: ["src/main.js", "  saveContextMemo: (...memoArgs) => memory.saveContextMemo(...memoArgs),\n", "  saveContextMemo: () => null,\n"],
};
let brokenFile = null;
if (BREAK) {
  const spec = BREAKS[BREAK];
  if (!spec) {
    console.error("✗ Неизвестный контроль: " + BREAK + ". Есть: " + Object.keys(BREAKS).join(", "));
    process.exit(2);
  }
  brokenFile = path.join(ROOT, spec[0]);
  const src = fs.readFileSync(brokenFile, "utf8");
  if (src.split(spec[1]).length - 1 !== 1) {
    console.error("✗ Якорь контроля не найден в " + spec[0] + ": " + JSON.stringify(spec[1]));
    process.exit(2);
  }
  const before = crypto.createHash("sha256").update(src).digest("hex");
  fs.writeFileSync(brokenFile, src.replace(spec[1], spec[2]));
  process.on("exit", () => {
    try {
      fs.writeFileSync(brokenFile, src);
      const back = crypto.createHash("sha256").update(fs.readFileSync(brokenFile, "utf8")).digest("hex");
      console.log(back === before ? "  ✓ " + spec[0] + " восстановлен байт в байт" : "  ✗ " + spec[0] + " НЕ восстановлен!");
    } catch (e) {
      console.error("  ✗ Файл не восстановлен: " + e.message);
    }
  });
}

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const events = [];
function FakeWindow() {
  this.webContents = { send: (ch, ev) => events.push({ ch: ch, ev: ev }), setWindowOpenHandler: () => {}, on: () => {}, id: 1 };
  this.on = () => {};
  this.isDestroyed = () => false;
  this.isFocused = () => true;
  this.loadFile = () => {};
  this.setTitle = () => {};
}

// ── Подменённый провайдер: отвечает по сценарию, тела и время сохраняем ─────
const requests = []; // { at, status, tools, messages, body }
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const toolCall = (id, name, args) => ({ index: 0, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } });
const answer = (n) => sse([
  { choices: [{ index: 0, delta: { role: "assistant", content: "Раунд " + n + ": двигаю работу.\n" } }] },
  { choices: [{ index: 0, delta: { tool_calls: [toolCall("call_" + n, "writeFile", { path: "notes/round-" + n + ".txt", content: "раунд " + n + "\n" })] } }] },
  { choices: [], usage: { prompt_tokens: 300, completion_tokens: 20 } },
]);
const final = (n) => sse([
  { choices: [{ index: 0, delta: { role: "assistant", content: "Работа завершена." } }] },
  { choices: [], usage: { prompt_tokens: 400, completion_tokens: 10 } },
]);

/* Сценарий основного прогона: каждый второй запрос — отказ, между ними успех.
   Так проверяются и ожидание, и повтор ТОГО ЖЕ раунда (тела совпадают). */
// Та самая HTML-страница, которой шлюз (Cloudflare) отвечал вместо JSON: раньше она
// уезжала в чат целиком, а прогон падал насмерть — ровно то, на что жаловался человек.
const CF_HTML =
  '<!DOCTYPE html>\n<html class="no-js ie6 oldie" lang="en-US"><head><title>api.example.com | 524: A timeout occurred</title>' +
  "</head><body><h1>Error 524</h1><p>A timeout occurred</p></body></html>";
const SCRIPT = {
  1: { status: 429, headers: { "Retry-After": "2" }, text: "rate limit exceeded" },
  2: { run: answer },
  3: { status: 503, text: JSON.stringify({ error: { message: "cache-only admission rejected a cold request", code: "cache_only_cold" } }) },
  4: { run: answer },
  5: { status: 400, text: JSON.stringify({ error: { message: "unknown parameter: stream_options" } }) },
  6: { run: answer },
  7: { status: 400, text: JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }) },
  8: { run: answer },
  // Второй 429 — БЕЗ заголовка Retry-After: провайдер не сказал, сколько ждать, и
  // держатель темпа промолчит. Выждать обязан сам прогон (по умолчанию 5 с) —
  // именно это ловит контроль `wait`.
  9: { status: 429, text: "rate limit exceeded" },
  // Шлюз провайдера: страница ошибки вместо JSON (запрос до модели не дошёл).
  10: { status: 524, headers: { "Content-Type": "text/html" }, text: CF_HTML },
  11: { run: answer },
  // Обрыв на шлюзе при чтении тела запроса: модель запроса тоже не получила.
  12: { status: 400, text: JSON.stringify({ type: "bad_request", message: "Could not read the request body.", request_id: "2f35f2ec" }) },
  13: { run: answer },
  // Провайдер (или прокси перед ним) рвёт соединение: ответа нет ВООБЩЕ. Раньше это
  // роняло прогон с первой попытки — «останавливается молча после обращения к API».
  14: { destroy: true },
  15: { run: answer },
  16: { run: final },
};
let phrase = "main";
// Текст, которым подставной провайдер отвечает на запрос ЗА ПАМЯТКОЙ (сжатие контекста).
// Ищем его потом в зеркале проекта и в дневнике — так видно, что сохранён именно он.
const MEMO_TEXT = "ПАМЯТКА: прокси собран, осталось проверить запуск и порт.";
function respond(n) {
  if (phrase === "402") return { status: 402, text: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  // Темп между прогонами: первый запрос получает 429 с частотой (6 запросов в минуту
  // → держатель темпа расставляет запросы по 10 с), второй — уже ответ.
  if (phrase === "pace") {
    if (n === 1) return { status: 429, headers: { "Retry-After": "2" }, text: "rate limit exceeded — 6 requests per minute" };
    return { status: 200, run: final };
  }
  const step = SCRIPT[n];
  if (!step) return { status: 200, run: final };
  // Оборванная связь: у шага нет ни кода, ни ответа — сокет закрывается.
  if (step.destroy) return step;
  if (step.status) return step;
  return { status: 200, run: step.run };
}

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
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    const step = respond(requests.filter((r) => r.phrase === phrase).length + 1);
    requests.push({
      at: Date.now(),
      phrase: phrase,
      status: step.status,
      destroyed: !!step.destroy,
      tools: (parsed && parsed.tools) || [],
      messages: (parsed && parsed.messages) || [],
      streamOptions: parsed && parsed.stream_options,
    });
    // Оборванная связь: сокет закрывается без ответа (так ведёт себя прокси, когда
    // соединение до модели рвётся). fetch в приложении падает — это и проверяем.
    if (step.destroy) {
      req.socket.destroy();
      return;
    }
    if (step.status !== 200) {
      res.writeHead(step.status, Object.assign({ "Content-Type": "application/json" }, step.headers || {}));
      return res.end(step.text);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const n = requests.filter((r) => r.phrase === phrase).length;
    res.end(step.run(n));
  });
});

// ── main.js с поддельным electron ──────────────────────────────────────────
const handlers = new Map();
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
        getVersion: () => "1.5.166",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: FakeWindow,
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
      Notification: function () { this.show = () => {}; },
    };
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});

const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  return Promise.resolve(fn({ sender: { id: 1 } }, ...args));
};

const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const COLD_WAIT_MS = core.coldCacheInfo(503, "cache_only_cold", 1).waitMs;

(async () => {
  console.log("Живой прогон восстановления после отказов (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 150 с — это уже поломка.");
    process.exit(1);
  }, 150000);
  guard.unref?.();

  let providerBase = "";
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    providerBase = "http://127.0.0.1:" + provider.address().port + "/v1";
  } catch (e) {
    console.error("✗ Не удалось поднять подменённый провайдер: " + e.message);
    process.exit(2);
  }
  require(path.join(ROOT, "src", "main.js"));
  await sleep(400);

  console.log("\n[1] Настройки: подменённый провайдер, временная рабочая папка");
  const saved = await callIpc("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
    autoSwitchProfiles: false,
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));

  console.log("\n[2] Прогон: провайдер отвечает отказами по сценарию, прогон обязан дожить до конца");
  const t0 = Date.now();
  const run = await callIpc("ai:send", [{ role: "user", content: "Сделай четыре заметки в папке notes" }], { chatId: "chat-live-retry", role: "developer" });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  ok(run && run.ok === true, "прогон завершился без ошибки (" + took + " с): " + JSON.stringify(run && run.error));
  const reqs = requests.filter((r) => r.phrase === "main");
  ok(reqs.length === 16, "провайдер получил ровно 16 запросов (8 отказов + 7 раундов + финал): " + reqs.length);

  const kind = (t) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === t);
  const consoleText = () => events.filter((e) => e.ch === "term:event" && e.ev && e.ev.type === "metrics").map((e) => e.ev.text).join("\n");
  const chatText = () => kind("notice").map((e) => e.ev.text || "").join("\n");
  const same = (a, b) => JSON.stringify(a.messages) === JSON.stringify(b.messages) && JSON.stringify(a.tools) === JSON.stringify(b.tools);

  console.log("\n[3] Лимит 429: прогон ждёт сам и повторяет ТОТ ЖЕ раунд");
  const gap429 = reqs[1].at - reqs[0].at;
  ok(gap429 >= 1900, "прогон сам выждал " + gap429 + " мс перед повтором (провайдер просил 2 с)");
  ok(same(reqs[0], reqs[1]), "повтор ушёл с ТЕМ ЖЕ телом — это тот же раунд, а не новый");
  ok(/жду 2 с и повторю сам \(попытка 1\)/.test(chatText()), "в чат ушло объяснение: ждём сами, попытка 1 (пауза из Retry-After)");
  ok(/Всего в ожидании/.test(consoleText()), "в «Консоли» видно накопленное ожидание");
  ok(/Писать ничего не нужно/.test(chatText()), "человеку сказано, что писать «продолжай» не надо");

  console.log("\n[4] 503 cache_only_cold: пауза ровно та, что посчитало ядро");
  const gapCold = reqs[3].at - reqs[2].at;
  ok(reqs[2].status === 503, "третий запрос ушёл как «холодный» отказ пула: " + reqs[2].status);
  ok(gapCold >= COLD_WAIT_MS - 100, "пауза «холодного» пула выдержана: " + gapCold + " мс (расчёт ядра: " + COLD_WAIT_MS + ")");
  ok(same(reqs[2], reqs[3]), "повтор ушёл байт в байт — шанс попасть в кэш сохранён");
  ok(/cache_only_cold/.test(consoleText()), "в «Консоль» сказано, почему ждём");

  console.log("\n[5] Строгий сервер без stream_options: следующий запрос уходит без него");
  const bad400 = reqs.filter((r) => r.status === 400).length;
  ok(bad400 === 3, "отказов 400 было ровно три (stream_options, контекст и обрыв чтения тела): " + bad400);
  ok(reqs[4].streamOptions && reqs[4].streamOptions.include_usage === true, "до отказа метрики токенов запрашивались");
  ok(!reqs[5].streamOptions, "после отказа stream_options больше не уходит — раунд не падает по кругу");
  ok(/Провайдер не понял stream_options\.include_usage/.test(consoleText()), "в «Консоль» сказано, что метрики выключены");

  console.log("\n[6] Переполнение контекста: бюджет ужат, прогон продолжает работу");
  const ctx = kind("context").map((e) => e.ev);
  const beforeCtx = ctx.find((c) => c.budget > 3000);
  const afterCtx = ctx.slice().reverse().find((c) => c.budget < (beforeCtx ? beforeCtx.budget : Infinity));
  ok(!!beforeCtx && !!afterCtx, "событий контекста до и после отказа хватает: " + JSON.stringify(ctx.map((c) => c.budget)));
  ok(
    !!beforeCtx && !!afterCtx && afterCtx.budget <= Math.round(beforeCtx.budget * 0.45),
    "бюджет контекста ужат: " + (beforeCtx && beforeCtx.budget) + " → " + (afterCtx && afterCtx.budget)
  );
  ok(reqs[7].messages.length <= reqs[6].messages.length, "история пересобрана и не выросла: " + reqs[6].messages.length + " → " + reqs[7].messages.length);
  ok(reqs[7].status === 200, "после ужатия раунд продолжился, а не упал");

  console.log("\n[6Б] Шлюз провайдера: 524 с HTML-страницей и обрыв чтения тела — ждём и повторяем сами");
  // Это и была немота: прогон останавливался после ответа внешнего сервиса. Теперь тот
  // же раунд повторяется сам, а если шлюз совсем молчит — прогон говорит словами.
  const gw = reqs[9];
  const gwRetry = reqs[10];
  ok(gw.status === 524, "шлюз ответил 524: " + gw.status);
  ok(same(gw, gwRetry), "повтор ушёл с ТЕМ ЖЕ телом — это тот же раунд, а не новый");
  ok(gwRetry.at - gw.at >= 3800, "перед повтором выждана пауза ядра: " + (gwRetry.at - gw.at) + " мс");
  ok(/временно недоступен \(524\)/.test(consoleText()), "человеку не сказано, что отказал шлюз");
  ok(!/[<>]|DOCTYPE/.test(consoleText()), "в «Консоль» уехала HTML-страница шлюза");
  const br = reqs[11];
  const brRetry = reqs[12];
  ok(br.status === 400, "пришёл 400 на обрыв чтения тела: " + br.status);
  ok(same(br, brRetry), "после обрыва тела повтор ушёл с тем же телом");
  ok(brRetry.at - br.at >= 3800, "после обрыва тела тоже выждали паузу: " + (brRetry.at - br.at) + " мс");
  ok(/не смог прочитать тело запроса/.test(consoleText()), "в «Консоли» нет объяснения обрыва: " + consoleText().slice(-160));
  ok(!/bad_request|request_id/.test(chatText() + consoleText()), "в чат/консоль уехал сырой JSON шлюза");

  console.log("\n[6В] Оборванная связь: провайдер рвёт соединение — ждём и повторяем тот же раунд");
  const cut = reqs[13];
  const cutRetry = reqs[14];
  ok(cut.destroyed === true, "на этом раунде провайдер оборвал соединение");
  ok(same(cut, cutRetry), "после обрыва повтор ушёл с ТЕМ ЖЕ телом — это тот же раунд");
  ok(cutRetry.at - cut.at >= 1800, "перед повтором после обрыва выждали паузу: " + (cutRetry.at - cut.at) + " мс");
  ok(/оборвалась/.test(consoleText()), "в «Консоли» не сказано, что связь оборвалась: " + consoleText().slice(-160));
  ok(!/Сетевая ошибка/.test(chatText() + consoleText()), "обрыв связи назван ошибкой, а не вылечен повтором");

  console.log("\n[7] Успех снимает счётчики: второй лимит снова «попытка 1»");
  const waits = [...chatText().matchAll(/жду \d+ с и повторю сам \(попытка (\d+)\)/g)].map((m) => Number(m[1]));
  ok(waits.length === 2, "ожиданий в чате ровно два: " + waits.length);
  ok(waits[0] === 1 && waits[1] === 1, "счётчик повторов сброшен успешным раундом (обе попытки первые): " + waits.join(", "));
  // Второй 429 пришёл без Retry-After: ждать обязана сама программа (5 с по умолчанию),
  // держателю темпа тут сказать нечего — без паузы прогон ударит в лимит снова.
  const gap2 = reqs[9].at - reqs[8].at;
  ok(gap2 >= 4500, "лимит без Retry-After выждан по умолчанию: " + gap2 + " мс");

  console.log("\n[8] Работа действительно шла: файлы на диске, ответ дошёл");
  const written = fs.existsSync(path.join(workDir, "notes")) ? fs.readdirSync(path.join(workDir, "notes")) : [];
  ok(written.length === 7, "записано файлов: " + written.length + " — по одному на успешный раунд");
  const text = kind("chunk").map((e) => e.ev.text).join("");
  ok(/Работа завершена/.test(text), "итоговый текст дошёл до чата");
  ok(kind("done").length === 1, "«готово» пришло ровно один раз");
  ok(kind("error").length === 0, "ошибок в чат не пришло: " + JSON.stringify(kind("error").map((e) => e.ev.message)));
  ok(kind("retry").length === 0, "внешний авто-повтор не понадобился — все отказы вылечены внутри раунда");

  console.log("\n[9] 402: конец прогона понятной ошибкой, а не сырым JSON");
  phrase = "402";
  const denied = await callIpc("ai:send", [{ role: "user", content: "Ещё заметку" }], { chatId: "chat-live-retry", role: "developer" });
  ok(denied && denied.ok === false, "прогон с 402 завершился ошибкой, а не «готово»");
  const deniedText = ((denied && denied.error) || "") + "\n" + kind("retry").map((e) => e.ev.error || "").join("\n");
  ok(/Недостаточно средств на балансе провайдера/.test(deniedText), "объяснение про баланс дошло до человека");
  ok(/Пополни счёт или выбери другого провайдера/.test(deniedText), "в ошибке сказано, что делать дальше");
  ok(kind("retry").length >= 1, "внешний авто-повтор попыток сработал: " + kind("retry").length);
  console.log("\n[10] Ничего не осталось висеть");
  ok(global.__agentRunning === false, "признак прогона снят");
  ok(global.__agentStopRequested === false && global.__agentPauseRequested === false, "флаги остановки сняты");

  console.log("\n[12] Памятка контекста: дневник памяти и зеркало проекта — по СВОИМ условиям");
  // saveContextMemo вынесен из оболочки в модуль памяти. У него ДВА разных условия в
  // одной функции, и главный риск переноса — слить их в одно:
  //   • «файлы работы агента» (agentWorkFiles) → зеркало .agent/context рядом с проектом;
  //   • галочка «Память диалогов» (contextMemory) → дневник памяток в папке приложения.
  // Проверяем на настоящем прогоне: окно модели маленькое, поэтому история переполняется
  // и приложение САМО сжимает контекст — только так эта ветка кода вообще вызывается.
  //
  // Провайдер здесь СОБСТВЕННЫЙ (свой адрес): окно модели кешируется на адрес, и на
  // старом адресе ответ «128000 токенов» уже лежит в кеше — сжатие просто не наступило бы.
  const memoReqs = [];
  const memoServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "memo-model", context_length: 12000 }] }));
      }
      let parsed = null;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      memoReqs.push({
        stream: parsed && parsed.stream,
        tools: (parsed && parsed.tools) || [],
        chars: JSON.stringify((parsed && parsed.messages) || []).length,
        msgs: ((parsed && parsed.messages) || []).length,
      });
      // Запрос за памяткой идёт БЕЗ потока и БЕЗ инструментов, и ответ читается как JSON.
      if (parsed && parsed.stream === false) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: MEMO_TEXT } }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(final(1));
    });
  });
  let memoBase = "";
  try {
    await new Promise((resolve, reject) => {
      memoServer.once("error", reject);
      memoServer.listen(0, "127.0.0.1", resolve);
    });
    memoBase = "http://127.0.0.1:" + memoServer.address().port + "/v1";
  } catch (e) {
    console.error("✗ Не удалось поднять второго подменённого провайдера: " + e.message);
    process.exit(2);
  }

  const countDiary = (dir) => {
    let n = 0;
    const walk = (d) => {
      let names = [];
      try {
        names = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of names) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (/\.json$/.test(e.name)) n++;
      }
    };
    walk(dir);
    return n;
  };

  const memoWork = fs.mkdtempSync(path.join(os.tmpdir(), "live-retry-memo-"));
  await callIpc("settings:set", {
    provider: "openai",
    model: "memo-model",
    openaiUrl: memoBase,
    workingDir: memoWork,
    contextMemory: true,
    agentWorkFiles: true,
    longWork: false,
  });
  const mirrorDir = path.join(memoWork, ".agent", "context");
  const diaryDir = path.join(userData, "context-memory");
  const longAsk = "Подробное задание для длинной работы: собери прокси и проверь его. ".repeat(500).slice(0, 30000);
  // Историю чата ведёт интерфейс и присылает её ЦЕЛИКОМ — поэтому копим её здесь сами:
  // сжатие контекста возможно только когда история перед новым вопросом уже большая.
  let memoHistory = [{ role: "user", content: longAsk }];
  const memo1 = await callIpc("ai:send", memoHistory.slice(), { chatId: "chat-live-memo", role: "developer" });
  ok(memo1 && memo1.ok === true, "первый прогон (длинное задание) прошёл: " + JSON.stringify(memo1 && memo1.error));
  // История ОДНОЙ задачи (одна просьба и всё после неё) — тот самый случай, где сжатие
  // раньше не срабатывало вовсе: summarizer видел «последняя просьба на нулевом месте»,
  // отвечал «нечего сжимать» и возвращался ни с чем, а история ехала в запрос целиком.
  // Теперь середина витка сворачивается, и памятка приходит уже на ПЕРВОМ прогоне —
  // проверяем это здесь, а не после второго, иначе проверка сторожит пустоту.
  ok(memoReqs.some((r) => r.stream === false && !r.tools.length), "на первом прогоне контекст одной задачи не сжат: summarizer снова отказался сворачивать середину витка");
  ok(fs.existsSync(mirrorDir), "памятка собралась, но в зеркало проекта .agent/context не легла");
  const firstMirrorFiles = fs.existsSync(mirrorDir) ? fs.readdirSync(mirrorDir) : [];
  const firstMirrorText = firstMirrorFiles.length ? fs.readFileSync(path.join(mirrorDir, firstMirrorFiles[0]), "utf8") : "";
  ok(firstMirrorText.indexOf(MEMO_TEXT) >= 0, "в зеркало проекта легла НЕ сама памятка: " + firstMirrorText.slice(0, 140));

  const memosBefore = kind("memory").length;
  const diaryBefore = countDiary(diaryDir);
  memoHistory.push({ role: "assistant", content: "Прокси собран, перехожу к проверке запуска." });
  const ask2 = { role: "user", content: "Продолжай работу" };
  const memo2 = await callIpc("ai:send", memoHistory.concat([ask2]), { chatId: "chat-live-memo", role: "developer" });
  memoHistory.push(ask2);
  ok(memo2 && memo2.ok === true, "второй прогон прошёл: " + JSON.stringify(memo2 && memo2.error));
  ok(memoReqs.some((r) => r.stream === false && !r.tools.length), "приложение так и не сжало контекст — ветка памятки не проверена");
  if (process.env.DEBUG_MEMO) console.log("  ℹ запросов: " + JSON.stringify(memoReqs.map((r) => ({ stream: r.stream, tools: r.tools.length, msgs: r.msgs, chars: r.chars }))));

  const memoTexts = kind("memory").map((e) => e.ev.text || "");
  ok(memoTexts.length === memosBefore + 1, "в чат ушло ровно одно сообщение о памятке: " + JSON.stringify(memoTexts).slice(0, 160));
  ok(/Память диалогов: сохранена памятка за/.test(memoTexts.join("\n")), "сообщение о памятке не то: " + JSON.stringify(memoTexts).slice(0, 160));

  const mirrorFiles = fs.existsSync(mirrorDir) ? fs.readdirSync(mirrorDir) : [];
  ok(mirrorFiles.length === 1 && /\.md$/.test(mirrorFiles[0] || ""), "зеркало .agent/context создано не так: " + JSON.stringify(mirrorFiles));
  const mirrorPath = mirrorFiles.length ? path.join(mirrorDir, mirrorFiles[0]) : "";
  const mirrorText = mirrorPath && fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, "utf8") : "";
  ok(mirrorText.indexOf(MEMO_TEXT) >= 0, "в зеркало проекта легла НЕ сама памятка: " + mirrorText.slice(0, 140));
  ok(countDiary(diaryDir) === diaryBefore + 1, "дневник памяти не пополнился: было " + diaryBefore + ", стало " + countDiary(diaryDir));

  // Независимость условий: выключаем галочку «Память диалогов» и повторяем.
  await callIpc("settings:set", { contextMemory: false });
  const mirrorBefore = mirrorText.length;
  const diaryBefore2 = countDiary(diaryDir);
  const memosBefore2 = kind("memory").length;
  memoHistory.push({ role: "assistant", content: "Запуск проверен, порт свободен." });
  const memo3 = await callIpc("ai:send", memoHistory.concat([{ role: "user", content: "И ещё шаг" }]), { chatId: "chat-live-memo", role: "developer" });
  ok(memo3 && memo3.ok === true, "третий прогон прошёл: " + JSON.stringify(memo3 && memo3.error));
  const mirrorAfter = mirrorPath && fs.existsSync(mirrorPath) ? fs.readFileSync(mirrorPath, "utf8") : "";
  ok(mirrorAfter.length > mirrorBefore, "зеркало НЕ пополнилось — а оно не зависит от галочки памяти: " + mirrorBefore + " → " + mirrorAfter.length);
  ok(kind("memory").length === memosBefore2, "сообщение о памятке пришло при ВЫКЛЮЧЕННОЙ памяти");
  ok(countDiary(diaryDir) === diaryBefore2, "дневник памяти пополнился при выключенной галочке: " + countDiary(diaryDir));
  // Возвращаем настройки на ОСНОВНОЙ провайдер: следующий раздел гоняет темп уже по нему,
  // а закрытый порт памятки дал бы «отказы» там, где их никто не планировал.
  await callIpc("settings:set", { provider: "openai", model: "test-model", openaiUrl: providerBase, workingDir: workDir });
  try {
    memoServer.close();
  } catch {}

  console.log("\n[11] Темп провайдера переживает конец прогона (карта лимитеров общая)");
  // Ровно та жалоба, из-за которой карта лимитеров вынесена отдельным модулем:
  // «после Стоп ничего не работает» — если держатель темпа создаётся на прогон, то
  // следующий стартует с чистым счётчиком, шлёт запрос сразу и снова ловит 429.
  // Первый прогон получает 429 с частотой (6 запросов/мин) и запоминает её;
  // первый же запрос ВТОРОГО прогона обязан эту частоту соблюсти.
  phrase = "pace";
  const paced1 = await callIpc("ai:send", [{ role: "user", content: "Продолжай работу" }], { chatId: "chat-live-pace", role: "developer" });
  ok(paced1 && paced1.ok === true, "первый прогон дожил до конца после 429: " + JSON.stringify(paced1 && paced1.error));
  const paceReqs = requests.filter((r) => r.phrase === "pace");
  ok(paceReqs.length >= 2 && paceReqs[1].status === 200, "после ожидания раунд повторился и был принят: " + paceReqs.map((r) => r.status).join(","));
  const paced2 = await callIpc("ai:send", [{ role: "user", content: "И ещё шаг" }], { chatId: "chat-live-pace", role: "developer" });
  ok(paced2 && paced2.ok === true, "второй прогон прошёл без отказа: " + JSON.stringify(paced2 && paced2.error));
  const later = requests.filter((r) => r.phrase === "pace" && r.at > (paceReqs[1] ? paceReqs[1].at : 0));
  const gapNext = later.length ? Math.min(...later.map((r) => r.at - paceReqs[1].at)) : -1;
  ok(gapNext >= 8000, "темп, узнанный первым прогоном, соблюдён во втором: разрыв " + gapNext + " мс (ожидалось ≈10000)");
  ok(later.length > 0 && later.every((r) => r.status === 200), "второй прогон действительно ходил к провайдеру и не получал отказов: " + later.map((r) => r.status).join(","));

  try {
    provider.close();
  } catch {}
  console.log("\nИтог: " + (failures ? failures + " проверок упало" : "все проверки прошли") + " (запросов чата: " + requests.length + ")");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("✗ Прогон упал: " + ((e && e.stack) || e));
  try { provider.close(); } catch {}
  process.exit(1);
});

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
       внешний авто-повтор успевает сообщить о попытках.

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
  context: ["src/run-retry.js", "      await shrinkContext();\n", ""],
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
  10: { run: final },
};
let phrase = "main";
function respond(n) {
  if (phrase === "402") return { status: 402, text: JSON.stringify({ error: { message: "Insufficient Balance" } }) };
  const step = SCRIPT[n];
  if (!step) return { status: 200, run: final };
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
      tools: (parsed && parsed.tools) || [],
      messages: (parsed && parsed.messages) || [],
      streamOptions: parsed && parsed.stream_options,
    });
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
  ok(reqs.length === 10, "провайдер получил ровно 10 запросов (4 отказа + 4 раунда + финал): " + reqs.length);

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
  ok(bad400 === 2, "отказов 400 было ровно два (stream_options и контекст): " + bad400);
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
  ok(written.length === 4, "записано файлов: " + written.length + " — по одному на успешный раунд");
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

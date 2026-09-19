"use strict";
/* ─── Живой прогон раунда прогона (main.js без окна Electron) ────────────────
   Запуск: bun run test:live:round   (node scripts/live-round.js)

   Зачем. С этапа B, части 17 тело раунда (сборка запроса, поток ответа, метрики)
   живёт в src/run-round.js, а ядро чата runAi его зовёт. Модульный набор водит
   модуль напрямую; здесь проверяется ПРОВОДКА и поведение НАСТОЯЩЕГО прогона:
   main.js грузится в Node с поддельным electron, канал ai:send запускает runAi,
   а провайдера изображает локальный HTTP-сервер с SSE-потоком. Тела запросов
   сохраняются — по ним и видно, что реально ушло.

   Что проверяется по-настоящему:
     • лимит 429 повторяет ТОТ ЖЕ раунд: тела двух запросов совпадают буквально
       (иначе раунд потерян, а человеку писать «продолжай» руками);
     • флаг метрик токенов уходит из состояния восстановления, а не «вообще»;
     • usage, пришедший ЧАСТЯМИ, собирается по каждому полю: панель миссии и
       «Консоль» показывают настоящий расход, а не последний кусок;
     • первый байт и полное время раунда измерены (TTFB не ноль);
     • рассуждения модели уходят в блок мыслей и НЕ попадают в текст ответа;
     • номер раунда в метриках не сбивается после повтора.

   Негативные контроли: --break=<имя> ломает одну проводку, и прогон обязан упасть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-round-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-round-work-"));
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

/* Негативный контроль ломает ОДНУ проводку до загрузки main.js и обязан провалить
   прогон. Файл восстанавливается байт в байт. */
const BREAKS = {
  usage: [
    "src/run-round.js",
    "        usage.prompt = Math.max(usage.prompt, u.prompt || 0);\n        usage.completion = Math.max(usage.completion, u.completion || 0);\n        usage.cached = Math.max(usage.cached, u.cached || 0);\n",
    "        usage.prompt = u.prompt || 0;\n        usage.completion = u.completion || 0;\n        usage.cached = u.cached || 0;\n",
  ],
  think: ["src/run-round.js", "        const vis = stripper.push(text);\n", "        const vis = text;\n"],
  ttfb: ["src/run-round.js", "    ttfbMs = Date.now() - startedAt; // заголовки ответа = первый байт\n", "    ttfbMs = 0;\n"],
  repeat: [
    "src/run-round.js",
    '      if (verdict.kind === "repeat") return { kind: "repeat" };\n',
    '      if (verdict.kind === "repeat") return { kind: "ok", text: "", toolCalls: [] };\n',
  ],
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

// ── Подменённый провайдер ───────────────────────────────────────────────────
const requests = []; // { body (объект), stream_options }
let served = 0;
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const call = (index, id, name, args) => ({ index: index, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } });

/* Второй ответ раунда намеренно отдаёт usage ЧАСТЯМИ: сначала вход, потом выход
   и чтение из кэша. Сборка «по каждому полю максимум» — то, что проверяем. */
const answerFor = (n) => {
  if (n === 2) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Начинаю работу.\n" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [call(0, "call_1", "writeFile", { path: "round-live.txt", content: "проверка раунда" })] } }] },
      { choices: [], usage: { prompt_tokens: 200 } },
      { choices: [], usage: { completion_tokens: 40, prompt_tokens_details: { cached_tokens: 96 } } },
    ]);
  }
  // Четвёртый запрос — обрыв ответа лимитом вывода у ОБЛАЧНОГО провайдера:
  // до правки эта пометка приходила только от Ollama, и обрезанный ответ выглядел
  // законченным. Здесь проверяем, что прогон видит finish_reason «length».
  if (n === 4) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Начало ответа, который " } }] },
      { choices: [{ index: 0, delta: { content: "оборвался" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]);
  }
  return sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "<think>внутреннее рассуждение модели</think>" } }] },
    { choices: [{ index: 0, delta: { content: "Ответ готов, файл записан." } }] },
    { choices: [], usage: { prompt_tokens: 260, completion_tokens: 18 } },
  ]);
};

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model", context_length: 128000 }] }));
    }
    if (u.pathname.endsWith("/chat/completions")) {
      let parsed = null;
      try { parsed = JSON.parse(body || "{}"); } catch {}
      served++;
      requests.push({ body: parsed || {}, streamOptions: (parsed && parsed.stream_options) || null });
      // Первый запрос раунда — лимит провайдера: прогон обязан подождать и повторить
      // ТОТ ЖЕ раунд, ничего не спрашивая у человека.
      if (served === 1) {
        res.writeHead(429, { "Content-Type": "application/json", "retry-after": "1" });
        return res.end(JSON.stringify({ error: { message: "rate limit exceeded" } }));
      }
      // Первый байт — с задержкой: иначе TTFB выйдет нулевым и проверка ничего не значит.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(answerFor(served));
      }, 250);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
  });
});

// ── main.js с поддельным electron: подменяем только то, чего в Node нет ────
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
        getVersion: () => "1.5.167",
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

(async () => {
  console.log("Живой прогон раунда (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 120 с — это уже поломка.");
    process.exit(1);
  }, 120000);
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
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));

  console.log("\n[2] Прогон: лимит 429 в первом раунде, затем работа и финальный ответ");
  const run = await callIpc("ai:send", [{ role: "user", content: "Сделай проверку раунда" }], { chatId: "chat-live-round", role: "developer" });
  ok(run && run.ok === true, "прогон завершился без ошибки: " + JSON.stringify(run && run.error));

  const chunks = events.filter((e) => e.ev && e.ev.type === "chunk").map((e) => e.ev.text);
  const noticed = events.filter((e) => e.ev && e.ev.type === "notice").map((e) => e.ev.text);
  const thinking = events.filter((e) => e.ev && (e.ev.type === "thinking" || e.ev.type === "think")).map((e) => e.ev.text);
  const metrics = events.filter((e) => e.ev && e.ev.type === "metrics").map((e) => e.ev.text);

  console.log("\n[3] Повтор раунда после лимита");
  ok(served === 3, "провайдер получил ровно 3 запроса (429 → повтор того же раунда → второй раунд): " + served);
  const same = requests[0] && requests[1] && JSON.stringify(requests[0].body) === JSON.stringify(requests[1].body);
  ok(same, "повтор после 429 ушёл с тем же телом — потерянный раунд не подменён новым");
  if (requests[0] && requests[2]) {
    const grew = JSON.stringify(requests[2].body).length > JSON.stringify(requests[1].body).length;
    ok(grew, "после результата инструмента контекст вырос — работа дошла до модели");
  } else {
    ok(false, "не хватает тел запросов для сверки контекста");
  }
  ok(requests.every((r) => r.streamOptions && r.streamOptions.include_usage === true),
    "флаг метрик токенов доехал до провайдера в каждом запросе: " + JSON.stringify(requests.map((r) => r.streamOptions)));
  ok(noticed.some((t) => /жду \d+ с и повторю сам/.test(t)), "человеку сказано, что прогон ждёт лимит сам: " + JSON.stringify(noticed));

  console.log("\n[4] Поток ответа в окно");
  const answer = chunks.join("");
  ok(/Ответ готов, файл записан\./.test(answer), "финальный ответ дошёл до окна: " + JSON.stringify(answer));
  ok(!/внутренне/.test(answer), "рассуждения модели в текст ответа не попали: " + JSON.stringify(answer));
  ok(thinking.join("").indexOf("внутреннее рассуждение") >= 0, "рассуждения дошли до блока мыслей");
  ok(chunks.length >= 2, "текст приходит кусками по мере генерации: кусков " + chunks.length);

  console.log("\n[5] Цифры раунда в «Консоль»");
  const m1 = metrics.filter((t) => /раунд 1\/25/.test(t));
  const m2 = metrics.filter((t) => /раунд 2\/25/.test(t));
  ok(m1.length >= 1, "метрики первого раунда есть, номер не сбит повтором: " + JSON.stringify(m1));
  ok(m2.length >= 1, "метрики второго раунда есть: " + JSON.stringify(m2));
  ok(metrics.some((t) => /токены 200→40/.test(t)), "usage, пришедший частями, собран по максимуму полей: " + JSON.stringify(metrics));
  ok(metrics.some((t) => /кэш 96 \(48%\)/.test(t)), "кэш считается от входных токенов (96 из 200 — 48%)");
  ok(metrics.some((t) => /TTFB 0\.[1-9]/.test(t)), "первый байт измерен в десятых секунды: " + JSON.stringify(metrics));
  ok(metrics.some((t) => /· всего \d+\.\d+ с/.test(t)), "полное время раунда показано: " + JSON.stringify(metrics));
  ok(!metrics.some((t) => /провайдер не прислал/.test(t)), "usage провайдера дошёл — оценки вместо настоящих токенов нет");

  console.log("\n[6] Обрыв ответа лимитом вывода у облачного провайдера");
  const chunksBeforeCut = events.filter((e) => e.ev && e.ev.type === "chunk").length;
  const run2 = await callIpc("ai:send", [{ role: "user", content: "Напиши длинный ответ" }], { chatId: "chat-live-round-cut", role: "developer" });
  ok(run2 && run2.ok === true, "прогон с обрывом завершился без ошибки: " + JSON.stringify(run2 && run2.error));
  const cutText = events.slice().filter((e) => e.ev && e.ev.type === "chunk").slice(chunksBeforeCut).map((e) => e.ev.text).join("");
  const cutNotices = events.filter((e) => e.ev && e.ev.type === "notice").map((e) => e.ev.text).filter((t) => /оборван лимитом вывода/.test(t));
  ok(cutNotices.length === 1, "обрыв ответа (finish_reason «length») замечен прогоном ровно один раз: " + JSON.stringify(cutNotices));
  ok(cutNotices.some((t) => /продолжай/.test(t)), "человеку сказано, что делать с оборванным ответом: " + JSON.stringify(cutNotices));
  ok(/Начало ответа, который оборвался/.test(cutText), "текст второго прогона дошёл целиком: " + JSON.stringify(cutText));

  console.log("\n[7] Завершение прогона");
  ok(events.some((e) => e.ev && e.ev.type === "done"), "прогон сообщил о завершении");
  ok(fs.existsSync(path.join(workDir, "round-live.txt")), "инструмент раунда выполнился: файл создан");

  console.log("\nИтог: " + (failures ? failures + " проверок провалено" : "все проверки пройдены"));
  clearTimeout(guard);
  process.exit(failures ? 1 : 0);
})();

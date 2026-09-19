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
  textcalls: [
    "src/run-calls.js",
    "    const fallbackCalls = extractToolCallsFromText(round.text);\n",
    "    const fallbackCalls = [];\n",
  ],
  dedup: ["src/run-calls.js", "      if (seenCalls.has(sig)) continue;\n", ""],
  extra: ["src/run-calls.js", "        if (c.extraContent) call.extra_content = c.extraContent;\n", ""],
  parallel: [
    "src/run-calls.js",
    "  const canRunParallel = (calls, planMode) =>\n    !planMode && calls.length > 1 && calls.every((c) => PARALLEL_SAFE_TOOLS.has(c.name));\n",
    "  const canRunParallel = (calls, planMode) => false;\n",
  ],
  // ── строгая очередь (часть 19а) ──
  strictdeny: [
    "src/run-strict.js",
    '      } else if (c.name === "runCommand" && toolPolicy.isDangerousCommand((c.args && c.args.command) || "")) {\n',
    "      } else if (false) {\n",
  ],
  strictaudit: [
    "src/run-strict.js",
    "      audit.record({ tool: c.name, args: c.args, decision, result, source: getRunOrigin() });\n",
    "",
  ],
  strictask: ["src/run-strict.js", '      if (c.name === "askUser") {\n', "      if (false) {\n"],
  // ── решения после раунда (часть 19б) ──
  batchreport: ["src/run-batch.js", "      o.toolCalls.length === 0 &&\n", "      false &&\n"],
  batchfake: [
    "src/run-batch.js",
    '      return { kind: "break" };\n',
    '      return { kind: "end", message: "🏁 Работа закончена. Цель, план, журнал и отчёт: .agent/missions/." };\n',
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
  // Третий прогон: модель печатает вызов инструмента ТЕКСТОМ (запасной способ),
  // затем присылает дубль вызова и подпись мысли (Gemini) — все три вещи живут
  // в src/run-calls.js (часть 18).
  if (n === 5) {
    return sse([
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content:
                'Пишу файл, вызываю инструмент: {"name":"writeFile","arguments":{"path":"from-text.txt","content":"из текста"}}\n',
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  if (n === 6) {
    // Индекс отличает вызовы в одном ответе (транспорт складывает их по index),
    // поэтому три вызова идут одним чанком с индексами 0, 1, 2.
    const read = (index, id, path, extra) => {
      const tc = { index: index, id: id, type: "function", function: { name: "readFile", arguments: JSON.stringify({ path: path }) } };
      if (extra) tc.extra_content = extra;
      return tc;
    };
    const sig = { google: { thought_signature: "SIG-LIVE-1==" } };
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Читаю оба файла.\n" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                read(0, "call_r1", "from-text.txt", sig),
                read(1, "call_r2", "from-text.txt"),
                read(2, "call_r3", "round-live.txt"),
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  if (n === 7) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Готово." } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  // Четвёртый прогон: СТРОГАЯ очередь (часть 19а). Модель зовёт опасную команду
  // дважды (первую человек отклонит, вторую подтвердит) и задаёт вопрос человеку.
  // Всё это живёт в src/run-strict.js и решается человеком через ai:answer.
  if (n === 8) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Удаляю лишнее.\n" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                call(0, "call_d1", "runCommand", {
                  command: "rm -rf " + path.join(workDir, "нет-такого") + " && touch " + path.join(workDir, "отказ.txt"),
                }),
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  if (n === 9) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Чищу временное.\n" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                call(0, "call_d2", "runCommand", {
                  command: "rm -rf " + path.join(workDir, "тоже-нет") + " && touch " + path.join(workDir, "согласие.txt"),
                }),
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  if (n === 10) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Уточняю.\n" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [call(0, "call_q1", "askUser", { question: "На каком порту поднимать сервер?" })],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  if (n === 11) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Готово: очередь пройдена." } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  // Пятый прогон: пустой итоговый ответ — прогон обязан ОДИН раз попросить
  // итоговый отчёт (решение в src/run-batch.js, часть 19б).
  if (n === 12) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Смотрю файлы.\n" } }] },
      { choices: [{ index: 0, delta: { tool_calls: [call(0, "call_l1", "listFiles", { path: "." })] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
  }
  if (n === 13) {
    // Пустой ответ БЕЗ вызовов инструментов — ровно то, на что отвечает просьба об отчёте.
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  if (n === 14) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "Отчёт: файлы просмотрены." } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  }
  // Шестой прогон: план-режим (3 раунда) — граница батча и честный финал.
  if (n >= 15) {
    return sse([
      { choices: [{ index: 0, delta: { role: "assistant", content: "План работ.\n" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                call(0, "call_p" + n, "todoWrite", { todos: [{ text: "Шаг " + n, status: "pending" }] }),
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
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

  console.log("\n[7] Вызовы раунда: текстовый вызов, дубль, подпись мысли, пачка");
  const evBefore3 = events.length;
  const run3 = await callIpc("ai:send", [{ role: "user", content: "Прочитай файлы" }], { chatId: "chat-live-round-calls", role: "developer" });
  ok(run3 && run3.ok === true, "прогон с вызовами завершился без ошибки: " + JSON.stringify(run3 && run3.error));
  ok(served === 7, "провайдер получил ровно 7 запросов за три прогона: " + served);

  const overrides = events.slice(evBefore3).filter((e) => e.ev && e.ev.type === "text_override").map((e) => e.ev.text);
  ok(overrides.length === 1, "показанный текст переписан ровно один раз: " + JSON.stringify(overrides));
  ok(
    overrides.length === 1 && /Пишу файл/.test(overrides[0]) && !/writeFile/.test(overrides[0]) && !/```/.test(overrides[0]),
    "из показанного текста убран JSON-вызов: " + JSON.stringify(overrides)
  );
  const fromTextFile = path.join(workDir, "from-text.txt");
  ok(fs.existsSync(fromTextFile), "вызов, напечатанный текстом, выполнен — файл на диске");
  ok(
    fs.existsSync(fromTextFile) && /из текста/.test(fs.readFileSync(fromTextFile, "utf8")),
    "вызов из текста выполнен с теми же аргументами"
  );

  const order = events
    .slice(evBefore3)
    .filter((e) => e.ev && (e.ev.type === "tool_start" || e.ev.type === "tool_result") && e.ev.name === "readFile")
    .map((e) => e.ev.type);
  ok(
    order.join(",") === "tool_start,tool_start,tool_result,tool_result",
    "read-only вызовы идут параллельно (сначала оба запуска, потом оба результата): " + order.join(",")
  );
  const starts = events.slice(evBefore3).filter((e) => e.ev && e.ev.type === "tool_start" && e.ev.name === "readFile");
  ok(starts.length === 2, "выполнено ровно два разных вызова (дубль не пошёл в работу): " + starts.length);

  // Подпись мысли ищем во ВСЕХ assistant-сообщениях истории: вызовов за прогон
  // несколько, и первый из них — запись файла, у которой подписи нет.
  const lastBody = requests[6] && requests[6].body;
  const allCalls = [].concat(
    ...(lastBody && lastBody.messages ? lastBody.messages : [])
      .filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length)
      .map((m) => m.tool_calls)
  );
  const echoed = allCalls.filter((c) => c.extra_content && c.extra_content.google);
  ok(
    echoed.length === 1 && echoed[0].extra_content.google.thought_signature === "SIG-LIVE-1==",
    "подпись мысли (extra_content) вернулась провайдеру — следующий раунд не упадёт с 400"
  );
  // Результаты чтения — по идентификаторам вызовов этого раунда: в истории лежат
  // ещё и результаты прошлого раунда, и они тут ни при чём.
  const readResults = (lastBody ? lastBody.messages || [] : []).filter(
    (m) => m.role === "tool" && /^call_r/.test(String(m.tool_call_id || ""))
  );
  ok(readResults.length === 2, "в историю записаны результаты обоих прочитанных файлов: " + readResults.length);

  console.log("\n[8] Строгая очередь: отказ, согласие, аудит и вопрос человеку");
  const evBefore4 = events.length;
  const servedBefore4 = served;
  // Ответы человека по порядку: отказ опасной команде, согласие, ответ на вопрос.
  const answers = ["нет", "да", "порт 8080"];
  let answeredCount = 0;
  let run4done = false;
  const run4p = callIpc("ai:send", [{ role: "user", content: "Почисти лишнее и уточни порт" }], {
    chatId: "chat-live-round-strict",
    role: "developer",
  }).then((r) => {
    run4done = true;
    return r;
  });
  // Отвечаем на вопросы, ПОКА прогон ждёт: askUser держит раунд открытым.
  const answerer = (async () => {
    while (!run4done) {
      await sleep(40);
      const asks = events.filter((e) => e.ev && e.ev.type === "ask");
      while (answeredCount < asks.length) {
        await callIpc("ai:answer", answers[answeredCount] || "нет");
        answeredCount++;
      }
    }
  })();
  const run4 = await run4p;
  await answerer;
  ok(run4 && run4.ok === true, "прогон со строгой очередью завершился без ошибки: " + JSON.stringify(run4 && run4.error));
  ok(served - servedBefore4 === 4, "провайдер получил 4 запроса (отказ, согласие, вопрос, финал): " + (served - servedBefore4));

  const asks = events.slice(evBefore4).filter((e) => e.ev && e.ev.type === "ask").map((e) => e.ev.question);
  ok(asks.length === 3, "человека спросили три раза (опасное дважды и вопрос модели): " + JSON.stringify(asks));
  ok(
    asks[0] && /потенциально опасна/.test(asks[0]) && /rm -rf/.test(asks[0]),
    "первым спросили про опасную команду и показали её: " + JSON.stringify(asks[0])
  );
  ok(asks[2] === "На каком порту поднимать сервер?", "вопрос модели дошёл до человека дословно: " + JSON.stringify(asks[2]));

  const deniedFile = path.join(workDir, "отказ.txt");
  const approvedFile = path.join(workDir, "согласие.txt");
  ok(!fs.existsSync(deniedFile), "отклонённая команда НЕ выполнена — файла нет");
  ok(fs.existsSync(approvedFile), "подтверждённая команда выполнена — файл создан");

  const run4Events = events.slice(evBefore4);
  const denied = run4Events.filter((e) => e.ev && e.ev.type === "tool_result" && /НЕ выполнена/.test(String(e.ev.result || "")));
  ok(denied.length === 1, "модели объяснён отказ (она не думает, что команда сработала): " + denied.length);

  // Журнал действий — на диске, в папке приложения: подтверждения и отказы пишутся всегда.
  const auditPath = path.join(userData, "audit.log");
  let auditRows = [];
  try {
    auditRows = fs
      .readFileSync(auditPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    auditRows = [];
  }
  ok(auditRows.some((r) => r.tool === "runCommand" && r.decision === "denied"), "отказ человека записан в журнал действий");
  ok(auditRows.some((r) => r.tool === "runCommand" && r.decision === "approved"), "согласие человека записано в журнал действий");
  ok(
    auditRows.filter((r) => r.decision === "denied" || r.decision === "approved").every((r) => r.source === "desktop"),
    "источник действия записан в журнал: " + JSON.stringify(auditRows.map((r) => r.source).slice(0, 6))
  );

  // Ответ человека и отказ видны модели в следующем запросе — иначе она соврёт человеку.
  const lastStrictBody = requests[requests.length - 1] && requests[requests.length - 1].body;
  const strictTools = (lastStrictBody && lastStrictBody.messages ? lastStrictBody.messages : []).filter(
    (m) => m.role === "tool" && /^call_(d1|d2|q1)/.test(String(m.tool_call_id || ""))
  );
  ok(strictTools.length === 3, "результаты всех трёх вызовов вернулись модели: " + strictTools.length);
  ok(
    strictTools.some((m) => /НЕ выполнена/.test(String(m.content || ""))),
    "в контексте модели есть отказ человека"
  );
  ok(
    strictTools.some((m) => String(m.content || "").indexOf("порт 8080") >= 0),
    "ответ человека на вопрос дошёл до модели"
  );

  console.log("\n[9] Пустой ответ: просьба об итоговом отчёте ровно одна");
  const ev5 = events.length;
  const served5 = served;
  const run5 = await callIpc("ai:send", [{ role: "user", content: "Посмотри файлы и отчитайся" }], {
    chatId: "chat-live-round-empty",
    role: "developer",
  });
  ok(run5 && run5.ok === true, "прогон с пустым ответом завершился без ошибки: " + JSON.stringify(run5 && run5.error));
  ok(served - served5 === 3, "провайдер получил 3 запроса (работа, пустой ответ, отчёт): " + (served - served5));
  const emptyBody = requests[served5 + 2] && requests[served5 + 2].body;
  const emptyAsks = (emptyBody && emptyBody.messages ? emptyBody.messages : []).filter(
    (m) => m.role === "user" && /итоговый ответ получился пустым/.test(String(m.content || ""))
  );
  ok(emptyAsks.length === 1, "просьба об итоговом отчёте ушла модели ровно один раз: " + emptyAsks.length);
  ok(
    !/итоговый ответ получился пустым/.test(JSON.stringify((requests[served5 + 1] || {}).body || {})),
    "просьба отправлена не в том же раунде, что пустой ответ"
  );
  const emptyText = events
    .slice(ev5)
    .filter((e) => e.ev && e.ev.type === "chunk")
    .map((e) => e.ev.text)
    .join("");
  ok(/Отчёт: файлы просмотрены/.test(emptyText), "итоговый отчёт дошёл до окна: " + JSON.stringify(emptyText));

  console.log("\n[10] Конец батча: раунды кончились — честное сообщение, а не молчание");
  const ev6 = events.length;
  const served6 = served;
  // Режим плана приходит опцией прогона (opts.planMode), а не настройкой: в нём
  // раундов всего 3, и граница батча достигается быстро — без 25 запросов.
  const run6 = await callIpc("ai:send", [{ role: "user", content: "Составь план работ" }], {
    chatId: "chat-live-round-batch",
    role: "developer",
    planMode: true,
  });
  const planText = events
    .slice(ev6)
    .filter((e) => e.ev && e.ev.type === "chunk")
    .map((e) => e.ev.text)
    .join("");
  const run6text = String((run6 && run6.error) || "") + " " + planText;
  ok(run6 && run6.ok === false, "прогон честно сообщил, что раунды кончились: " + JSON.stringify(run6 && run6.ok));
  ok(served - served6 === 3, "в плане ровно 3 раунда (граница батча): " + (served - served6));
  ok(/Превышено максимальное число раундов/.test(run6text), "человеку объяснено, что случилось: " + JSON.stringify(run6text.slice(0, 140)));
  ok(/продолжай/.test(run6text), "человеку сказано, как продолжить работу");
  ok(
    !/Работа закончена/.test(run6text),
    "без миссии прогон не выдаёт себя за закрытую миссию: " + JSON.stringify(run6text.slice(0, 140))
  );

  console.log("\n[11] Завершение прогона");
  ok(events.some((e) => e.ev && e.ev.type === "done"), "прогон сообщил о завершении");
  ok(fs.existsSync(path.join(workDir, "round-live.txt")), "инструмент раунда выполнился: файл создан");

  console.log("\nИтог: " + (failures ? failures + " проверок провалено" : "все проверки пройдены"));
  clearTimeout(guard);
  process.exit(failures ? 1 : 0);
})();

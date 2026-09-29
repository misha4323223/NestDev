"use strict";
/* ─── Группа «Агент: ядро, память, правки, поиск кода, политика и кэш подсказок» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 9.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  browserHomeSrc,
  coreData,
  get,
  hasTool,
  mainOnlySrc,
  tmpdir,
  uiAll,
  uiFile,
  uiFind,
} = H;

// ── 1. agent-core ───────────────────────────────────────────────────────────
async function testAgentCore() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("TOOL_DEFINITIONS: 90+ инструментов и все browser-*", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.length >= 90, "ожидалось >= 90 инструментов, есть " + names.length);
    for (const n of ["browserOpen", "browserSnapshot", "browserFill", "browserClick", "browserSelect", "browserPress", "browserText", "browserScreenshot", "browserWait", "browserClose", "browserStatus"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    // У каждого определения обязательные поля.
    for (const d of core.TOOL_DEFINITIONS) {
      assert.ok(d.function && d.function.name && d.function.description, "плохое определение: " + JSON.stringify(d.function && d.function.name));
      assert.ok(d.function.parameters && d.function.parameters.properties, "нет parameters у " + d.function.name);
    }
  });

  await test("TOOL_DEFINITIONS: app-* инструменты управления окном", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["appRead", "appClick", "appFill", "appSelect", "appPress", "appWait", "appScreenshot"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: память проекта и точки отката (note-* / checkpoint-*)", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["noteSave", "noteRead", "noteList", "noteDelete", "checkpointSave", "checkpointList", "checkpointRollback"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: applyPatch / waitUntil / gitStash / gitCherryPick / gitBlame", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["applyPatch", "waitUntil", "gitStash", "gitCherryPick", "gitBlame"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: semanticSearch", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.includes("semanticSearch"), "нет инструмента semanticSearch");
  });

  await test("TOOL_DEFINITIONS + алиасы: gitInit (репозиторий без GitHub)", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.includes("gitInit"), "нет инструмента gitInit");
    assert.strictEqual(core.normalizeToolName("git_init"), "gitInit");
    assert.strictEqual(core.normalizeToolName("gitinit"), "gitInit");
    assert.strictEqual(core.normalizeToolName("init_repo"), "gitInit");
    assert.strictEqual(core.normalizeToolName("create_repo"), "gitInit");
  });

  await test("SYSTEM_PROMPT: правила 21-23 (браузер, своё окно, остановка)", () => {
    assert.ok(core.SYSTEM_PROMPT.includes("21. Браузер (видимое окно Chromium)"), "нет правила 21");
    assert.ok(core.SYSTEM_PROMPT.includes("22. СВОЁ окно приложения (app-инструменты)"), "нет правила 22");
    assert.ok(core.SYSTEM_PROMPT.includes("23. Остановка"), "нет правила 23");
    assert.ok(core.SYSTEM_PROMPT.includes("Остановлено пользователем"), "нет текста остановки");
    assert.ok(core.SYSTEM_PROMPT.includes("appRead, appClick"), "нет имён app-* в списке");
  });

  await test("SYSTEM_PROMPT: правила 24-25 (память/чекпоинты, проверка после правок)", () => {
    assert.ok(core.SYSTEM_PROMPT.includes("24. Память проекта и точки отката"), "нет правила 24");
    assert.ok(core.SYSTEM_PROMPT.includes("noteSave/noteRead/noteList/noteDelete"), "нет имён памяти в правиле 24");
    assert.ok(core.SYSTEM_PROMPT.includes("25. Проверка после правок"), "нет правила 25");
    assert.ok(core.SYSTEM_PROMPT.includes("validateProject"), "нет validateProject в правиле 25");
  });

  await test("TOOL_DEFINITIONS + SYSTEM_PROMPT: OTA-инструменты самообновления и правило 27", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["otaStatus", "otaCheck", "otaRollback"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    assert.ok(core.SYSTEM_PROMPT.includes("27. Самоизменения и OTA"), "нет правила 27");
    assert.ok(core.SYSTEM_PROMPT.includes("otaStatus, otaCheck, otaRollback"), "нет OTA-имён в списке инструментов");
    assert.ok(core.SYSTEM_PROMPT.includes("src/bootstrap.js и src/ota.js"), "нет упоминания защиты критичных файлов");
  });

  await test("normalizeToolName: snake_case алиасы (в т.ч. browser-*)", () => {
    assert.strictEqual(core.normalizeToolName("browserOpen"), "browserOpen");
    assert.strictEqual(core.normalizeToolName("browser_open"), "browserOpen");
    assert.strictEqual(core.normalizeToolName("browser_click"), "browserClick");
    assert.strictEqual(core.normalizeToolName("app_read"), "appRead");
    assert.strictEqual(core.normalizeToolName("app_click"), "appClick");
    assert.strictEqual(core.normalizeToolName("write_file"), "writeFile");
  });

  await test("extractToolCallsFromText: JSON-блок из текста", () => {
    const text = '```json\n[{"name":"webSearch","arguments":{"query":"x"}}]\n```';
    const calls = core.extractToolCallsFromText(text);
    assert.ok(Array.isArray(calls) && calls.length === 1, "не извлёк вызов");
    assert.strictEqual(calls[0].name, "webSearch");
    assert.strictEqual(calls[0].args.query, "x");
  });

  await test("contextBudget/trimConversation: не ломаются", () => {
    const budget = core.contextBudget("openai", "deepseek-v4-flash");
    assert.ok(typeof budget === "number" && budget > 0, "contextBudget вернул " + budget);
    const msgs = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: "m" + i }));
    const trimmed = core.trimConversation(msgs, 1000);
    assert.ok(Array.isArray(trimmed), "trimConversation вернул не массив");
  });

  await test("trimConversation: осиротевшие tool-сообщения выбрасываются", () => {
    // Цепочка инструментов без нового user-сообщения: после обрезки хвост может
    // остаться без assistant(tool_calls) — такие tool-сообщения валидны только сразу
    // после assistant с tool_calls, иначе провайдер отвечает 400 wrong_api_format.
    const msgs = [
      { role: "user", content: "сделай" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "readFile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "file" },
      { role: "assistant", content: "готово", tool_calls: null },
    ];
    // Маленький бюджет — срез придётся на середину цепочки инструментов
    const trimmed = core.trimConversation(msgs, 1500);
    const roles = trimmed.map((m) => m.role);
    // Никакое tool-сообщение не должно идти первым или без предшествующего assistant с tool_calls
    assert.notStrictEqual(roles[0], "tool", "история начинается с tool: " + JSON.stringify(roles));
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === "tool") {
        const prev = trimmed[i - 1];
        assert.ok(
          prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i + ": " + JSON.stringify(roles)
        );
      }
    }
  });

  await test("trimConversation: длинная цепочка инструментов без нового user валидна", () => {
    // Многораундовый агентный цикл: после исходного user идут только пары
    // assistant(tool_calls) → tool без новых user-сообщений. Срез падает на середину
    // цепочки — санитайзер не должен оставить tool без предшествующего assistant.
    const msgs = [{ role: "user", content: "сделай всё" }];
    for (let i = 1; i <= 12; i++) {
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c" + i, type: "function", function: { name: "runCommand", arguments: "{}" } }],
      });
      msgs.push({ role: "tool", tool_call_id: "c" + i, content: "result ".repeat(60) });
    }
    const trimmed = core.trimConversation(msgs, 1500);
    const roles = trimmed.map((m) => m.role);
    assert.ok(roles.length >= 1, "история пуста после обрезки");
    assert.notStrictEqual(roles[0], "tool", "история начинается с tool: " + JSON.stringify(roles));
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === "tool") {
        const prev = trimmed[i - 1];
        assert.ok(
          prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i + ": " + JSON.stringify(roles)
        );
      }
    }
  });

  await test("sanitizeToolPairs: экспорт и удаление сирот без обрезки", () => {
    // Прямой доступ к санитайзеру — защита срабатывает и когда обрезка контекста
    // не нужна (под-бюджетный путь manage() / финальный предохранитель перед запросом).
    assert.strictEqual(typeof core.sanitizeToolPairs, "function", "sanitizeToolPairs не экспортирован");
    const msgs = [
      { role: "tool", tool_call_id: "x1", content: "сирота без assistant" },
      { role: "user", content: "привет" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "tool", tool_call_id: "c2", content: "сирота после валидной пары" },
      { role: "assistant", content: "готово" },
    ];
    const out = core.sanitizeToolPairs(msgs);
    const roles = out.map((m) => m.role);
    // Первый tool — сирота (удалён), второй tool (c2) идёт сразу после валидной пары
    // и допустим: несколько tool-ответов подряд после одного assistant(tool_calls) — валидно.
    assert.deepStrictEqual(roles, ["user", "assistant", "tool", "tool", "assistant"], "роли после санитизации: " + JSON.stringify(roles));
    // Инвариант: у каждого tool последнее НЕ-tool сообщение перед ним — assistant с tool_calls
    // (несколько tool-ответов подряд после одного assistant — допустимо: N вызовов → N результатов).
    let lastNonTool = null;
    for (let i = 0; i < out.length; i++) {
      if (out[i].role !== "tool") lastNonTool = out[i];
      else {
        assert.ok(
          lastNonTool && lastNonTool.role === "assistant" && Array.isArray(lastNonTool.tool_calls) && lastNonTool.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i
        );
      }
    }
  });

  await test("createContextManager: под-бюджетный путь тоже убирает сирот", async () => {
    const mgr = core.createContextManager({ settings: {}, planMode: true });
    const msgs = [
      { role: "tool", tool_call_id: "x", content: "сирота" },
      { role: "user", content: "сделай" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const out = await mgr.manage(msgs, 1e9); // бюджет огромный — обрезка не нужна
    const roles = out.map((m) => m.role);
    assert.deepStrictEqual(roles, ["user", "assistant", "tool"], "роли под-бюджетного пути: " + JSON.stringify(roles));
  });

  await test("Gemini: thought signature захватывается из стрима (extra_content)", async () => {
    // SSE-чанк как его шлёт OpenAI-совместимый эндпоинт Gemini 3.x:
    // tool-call несёт extra_content.google.thought_signature.
    const sse =
      "data: " +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  extra_content: { google: { thought_signature: "SIG123==" } },
                  function: { name: "runCommand", arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
      }) +
      "\n" +
      "data: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const calls = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "openai",
      onToolCall: (tc) => calls.push(tc),
    });
    assert.strictEqual(calls.length, 1, "не получен вызов инструмента");
    assert.strictEqual(calls[0].name, "runCommand");
    assert.ok(calls[0].extraContent, "нет extraContent у вызова");
    assert.strictEqual(calls[0].extraContent.google.thought_signature, "SIG123==");
  });

  await test("Ollama: рассуждения из message.thinking доходят до интерфейса", async () => {
    // Thinking-модели (qwen3, deepseek-r1, gpt-oss) кладут рассуждения отдельным полем.
    // Раньше их не читали вовсе — план, написанный в размышлениях, пропадал.
    const ndjson =
      JSON.stringify({ message: { role: "assistant", thinking: "Размышляю: ", content: "" }, done: false }) + "\n" +
      JSON.stringify({ message: { role: "assistant", thinking: "план готов", content: "План:\n1. Раз\n2. Два" }, done: false }) + "\n" +
      JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 10, eval_count: 5 }) + "\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      },
    });
    const think = [];
    const texts = [];
    const usage = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "ollama",
      onText: (t) => texts.push(t),
      onThinking: (t) => think.push(t),
      onUsage: (u) => usage.push(u),
    });
    assert.strictEqual(think.join(""), "Размышляю: план готов", "рассуждения Ollama потеряны: " + JSON.stringify(think));
    assert.strictEqual(texts.join(""), "План:\n1. Раз\n2. Два", "текст ответа Ollama потерян: " + JSON.stringify(texts));
    assert.strictEqual(usage.length, 1, "счётчики Ollama не пришли");
  });

  await test("OpenAI-совместимые: поле reasoning тоже доходит до интерфейса", async () => {
    const sse =
      "data: " + JSON.stringify({ choices: [{ delta: { reasoning: "думаю" } }] }) + "\n" +
      "data: " + JSON.stringify({ choices: [{ delta: { content: "ответ" } }] }) + "\n" +
      "data: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const think = [];
    const texts = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "openai",
      onText: (t) => texts.push(t),
      onThinking: (t) => think.push(t),
    });
    assert.strictEqual(think.join(""), "думаю", "поле reasoning не проброшено: " + JSON.stringify(think));
    assert.strictEqual(texts.join(""), "ответ");
  });

  await test("Gemini: assistant tool_calls эхуют extra_content в запрос", () => {
    const req = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" },
      {
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "runCommand", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG123==" } } },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "ok" },
        ],
      }
    );
    const body = JSON.parse(req.body);
    const asst = body.messages[1];
    assert.ok(asst.tool_calls && asst.tool_calls[0], "нет tool_calls у ассистента");
    assert.ok(asst.tool_calls[0].extra_content, "extra_content потерян при эхе");
    assert.strictEqual(asst.tool_calls[0].extra_content.google.thought_signature, "SIG123==");
  });

  await test("Gemini: signature отдельной дельтой достаётся tool-call'у", async () => {
    // Google может прислать подпись отдельным delta.extra_content до tool_calls.
    const sse =
      "data: " +
      JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", extra_content: { google: { thought_signature: "SIG456==" } } } }] }) +
      "\n" +
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-2", type: "function", function: { name: "listFiles", arguments: "{}" } }] } }],
      }) +
      "\n" +
      "data: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const calls = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "openai",
      onToolCall: (tc) => calls.push(tc),
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].extraContent, "нет extraContent (отдельная дельта)");
    assert.strictEqual(calls[0].extraContent.google.thought_signature, "SIG456==");
  });
  await test("friendlyRateLimitError: Groq 413 ITPM → понятное сообщение", () => {
    const msg = core.friendlyRateLimitError(
      413,
      '{"error":{"message":"Request too large for model ... ITPM: Limit 7000, Requested 19594, please reduce your message size","type":"tokens","code":"rate_limit_exceeded"}}',
      { openaiUrl: "https://api.groq.com/openai/v1" }
    );
    assert.ok(msg && msg.includes("Groq"), "нет пояснения Groq");
    assert.ok(msg.includes("7 000"), "нет лимита 7000");
    assert.ok(msg.includes("Ollama Cloud"), "нет подсказки о провайдерах");
  });

  await test("friendlyRateLimitError: не-Groq / другие статусы → null", () => {
    const groq = { openaiUrl: "https://api.groq.com/openai/v1" };
    assert.strictEqual(core.friendlyRateLimitError(413, "ITPM: Limit 7000", { openaiUrl: "https://api.deepseek.com/v1" }), null);
    assert.strictEqual(core.friendlyRateLimitError(500, "server error", groq), null);
    assert.strictEqual(core.friendlyRateLimitError(401, "unauthorized", groq), null);
    assert.strictEqual(core.friendlyRateLimitError(413, "request body too large", groq), null);
  });

  // ── Ошибка vision: показываем причину, а не «[object Promise]» ────────────
  // Было: readApiError() (async) вызывалась без await → в текст ошибки попадал промис.
  const realFetchVision = global.fetch;
  await test("analyzeImage/generateImage: ошибка API читаемая, а не «[object Promise]»", async () => {
    const badBody = JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
    });
    global.fetch = async () => ({ ok: false, status: 400, text: async () => badBody, json: async () => JSON.parse(badBody) });
    const cfg = {
      enabled: true,
      url: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: "k",
      visionModel: "gemini-2.0-flash-001",
      imageModel: "img",
    };
    try {
      await assert.rejects(
        () => core.describeImageRemote(cfg, "data:image/png;base64,AA==", "что тут?", "gemini-2.0-flash-001"),
        (e) => {
          assert.ok(e instanceof Error, "брошен не Error");
          assert.ok(!/\[object Promise\]/.test(e.message), "снова [object Promise]: " + e.message);
          assert.ok(/API key not valid/.test(e.message), "нет причины из ответа API: " + e.message);
          return true;
        }
      );
      await assert.rejects(
        () => core.generateImageRemote(cfg, "кот", "img"),
        (e) => {
          assert.ok(!/\[object Promise\]/.test(e.message), "generateImage снова [object Promise]: " + e.message);
          assert.ok(/API key not valid/.test(e.message), "нет причины из ответа API: " + e.message);
          return true;
        }
      );
    } finally {
      global.fetch = realFetchVision;
    }
  });

  await test("fmtError: промис — «забыт await», объекты и строки читаемы", () => {
    assert.strictEqual(core.fmtError(new Error("ENOENT: no such file or directory")), "ENOENT: no such file or directory");
    assert.ok(/забыт await/.test(core.fmtError(Promise.resolve(1))), "промис не распознан как промис");
    assert.strictEqual(core.fmtError("просто строка"), "просто строка");
    assert.ok(core.fmtError({ code: 400 }).includes("400"), "объект не сериализован");
    assert.strictEqual(core.fmtError(undefined), "undefined");
  });

  await test("auxConfig: база Gemini приводится к OpenAI-совместимому /v1beta/openai", () => {
    const g1 = core.auxConfig({ visionEnabled: true, visionUrl: "https://generativelanguage.googleapis.com/v1", visionModel: "gemini-2.0-flash-001" });
    assert.strictEqual(g1.url, "https://generativelanguage.googleapis.com/v1beta/openai");
    const g2 = core.auxConfig({ visionEnabled: true, visionUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", visionModel: "m" });
    assert.strictEqual(g2.url, "https://generativelanguage.googleapis.com/v1beta/openai");
    const other = core.auxConfig({ visionEnabled: true, visionUrl: "https://api.openai.com/v1", visionModel: "gpt-4o-mini" });
    assert.strictEqual(other.url, "https://api.openai.com/v1", "чужая база изменена");
  });

  await test("изображения: провайдер определяется по адресу, версия пути достраивается", () => {
    assert.strictEqual(core.normalizeAuxBase("https://api.openai.com"), "https://api.openai.com/v1");
    assert.strictEqual(core.normalizeAuxBase("https://api.openai.com/v1/"), "https://api.openai.com/v1");
    assert.strictEqual(core.normalizeAuxBase("https://openrouter.ai"), "https://openrouter.ai/api/v1");
    assert.strictEqual(core.normalizeAuxBase("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
    assert.strictEqual(
      core.normalizeAuxBase("https://generativelanguage.googleapis.com/v1beta"),
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
    assert.strictEqual(core.normalizeAuxBase("https://llm.api.cloud.yandex.net/v1"), "https://llm.api.cloud.yandex.net/v1", "чужой путь изменён");
    assert.strictEqual(core.normalizeAuxBase("https://my.proxy.example/openai"), "https://my.proxy.example/openai", "прокси-путь изменён");
    assert.strictEqual(core.imageProviderLabel("https://openrouter.ai/api/v1"), "OpenRouter");
    assert.strictEqual(core.imageProviderLabel("https://api.openai.com/v1"), "OpenAI");
    assert.strictEqual(core.imageProviderLabel("https://generativelanguage.googleapis.com/v1beta/openai"), "Gemini (OpenAI-совместимо)");
    assert.strictEqual(core.imageProviderLabel("https://llm.api.cloud.yandex.net/v1"), "YandexART (Яндекс AI Studio)");
    assert.strictEqual(core.imageProviderLabel("http://127.0.0.1:7860"), "Stable Diffusion (локально, A1111)");
    assert.ok(/незнаком/.test(core.imageProviderLabel("https://my.proxy.example/openai")), "незнакомый адрес не распознан");
  });

  await test("изображения: попытки — свой путь первым, тела под провайдера", () => {
    const open = core.imageAttempts({ url: "https://api.openai.com/v1", key: "k" }, "кот", "gpt-image-1", { aspectRatio: "16:9" });
    assert.strictEqual(open[0].kind, "openai_images");
    assert.strictEqual(open[0].url, "https://api.openai.com/v1/images/generations");
    assert.strictEqual(open[0].body.size, "1536x1024", "размер под gpt-image-1 не подставлен");
    assert.strictEqual(open[0].body.response_format, undefined, "gpt-image-1 получил неподдерживаемый response_format");
    assert.strictEqual(open[0].headers.Authorization, "Bearer k");

    const dalle = core.imageAttempts({ url: "https://api.openai.com/v1", key: "k" }, "кот", "dall-e-3", { aspectRatio: "16:9" });
    assert.strictEqual(dalle[0].body.size, "1792x1024", "размер под dall-e-3 не подставлен");
    assert.strictEqual(dalle[0].body.response_format, "b64_json");

    const gemini = core.imageAttempts({ url: "https://generativelanguage.googleapis.com/v1beta", key: "g" }, "кот", "gemini-2.5-flash-image", {});
    assert.strictEqual(gemini[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/images/generations");
    assert.strictEqual(gemini[0].body.size, undefined, "Gemini получил чужой size");

    const or = core.imageAttempts({ url: "https://openrouter.ai/api/v1", key: "o" }, "кот", "openai/dall-e-3", { aspectRatio: "1:1" });
    assert.strictEqual(or[0].kind, "openrouter");
    assert.strictEqual(or[0].url, "https://openrouter.ai/api/v1/images");
    assert.strictEqual(or[0].body.aspect_ratio, "1:1");
    assert.strictEqual(or[0].body.size, undefined, "OpenRouter получил чужой size");

    const unknown = core.imageAttempts({ url: "https://my.proxy.example/openai", key: "p" }, "кот", "m", {});
    assert.strictEqual(unknown[0].kind, "openai_images", "незнакомый сервер: первым должен идти OpenAI-совместимый путь");
    assert.strictEqual(unknown[0].url, "https://my.proxy.example/openai/images/generations");

    const sd = core.imageAttempts({ url: "http://127.0.0.1:7860", key: "" }, "кот", "", { aspectRatio: "16:9" });
    assert.strictEqual(sd[0].kind, "sd_webui");
    assert.strictEqual(sd[0].url, "http://127.0.0.1:7860/sdapi/v1/txt2img");
    assert.deepStrictEqual([sd[0].body.width, sd[0].body.height], [1024, 576]);

    const yandex = core.imageAttempts({ url: "https://llm.api.cloud.yandex.net/v1", key: "AQVN", project: "b1gfolder" }, "кот", "yandex-art/latest", { aspectRatio: "9:16" });
    assert.strictEqual(yandex[0].kind, "yandex_art");
    assert.strictEqual(yandex[0].headers.Authorization, "Api-Key AQVN");
    assert.strictEqual(yandex[0].body.modelUri, "art://b1gfolder/yandex-art/latest");
    assert.deepStrictEqual(yandex[0].body.generationOptions.aspectRatio, { widthRatio: "9", heightRatio: "16" });
    assert.strictEqual(yandex[0].body.messages[0].text, "кот");
  });

  const realFetchImg = global.fetch;
  await test("изображения: незнакомый шлюз — перебор путей и памятка удачного", async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push(String(url));
      if (/\/images\/generations$/.test(String(url))) {
        return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: "Not Found" } }), json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "AAAA" }] }), text: async () => "" };
    };
    try {
      const cfg = { url: "https://gw-one.example/v1", key: "k" };
      const r1 = await core.generateImageRemote(cfg, "кот", "model-x", {});
      assert.strictEqual(r1.b64, "AAAA");
      assert.strictEqual(r1.kind, "openrouter", "удачный путь определён неверно");
      assert.strictEqual(calls.length, 2, "перебор не сработал: " + calls.join(", "));
      assert.ok(/\/images\/generations$/.test(calls[0]) && /\/images$/.test(calls[1]), calls.join(", "));
      calls.length = 0;
      const r2 = await core.generateImageRemote(cfg, "кот", "model-x", {});
      assert.strictEqual(r2.kind, "openrouter");
      assert.strictEqual(calls.length, 1, "памятка не сработала: " + calls.join(", "));
      assert.ok(/\/images$/.test(calls[0]), calls.join(", "));
    } finally {
      global.fetch = realFetchImg;
    }
  });

  await test("изображения: пустой ответ больше не даёт пустую ошибку", async () => {
    global.fetch = async () => ({ ok: false, status: 404, text: async () => "", json: async () => ({}) });
    try {
      await assert.rejects(
        () => core.generateImageRemote({ url: "https://gw-two.example/v1", key: "k" }, "кот", "model-y", {}),
        (e) => {
          assert.ok(/Не удалось сгенерировать/.test(e.message), "нет заголовка: " + e.message);
          assert.ok(/HTTP 404/.test(e.message), "нет кода ответа: " + e.message);
          assert.ok(/gw-two\.example/.test(e.message), "нет адреса: " + e.message);
          assert.ok(/images\/generations/.test(e.message) && /\/images\b/.test(e.message), "попытки не перечислены: " + e.message);
          assert.ok(/\(пустой ответ\)/.test(e.message), "пустое тело не объяснено: " + e.message);
          return true;
        }
      );
    } finally {
      global.fetch = realFetchImg;
    }
  });

  await test("изображения: ЯндексART — запуск и опрос операции", async () => {
    const seen = [];
    global.fetch = async (url, init) => {
      seen.push(String(url) + " " + ((init && init.method) || "GET"));
      if (/imageGenerationAsync$/.test(String(url))) {
        return { ok: true, status: 200, json: async () => ({ id: "op-1" }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ done: true, response: { image: "BBBB" } }), text: async () => "" };
    };
    try {
      const r = await core.generateImageRemote({ url: "https://llm.api.cloud.yandex.net/v1", key: "AQVN", project: "b1g" }, "кот", "yandex-art/latest", {});
      assert.strictEqual(r.b64, "BBBB");
      assert.strictEqual(r.mediaType, "image/jpeg");
      assert.strictEqual(r.ext, ".jpg");
      assert.ok(/imageGenerationAsync POST/.test(seen[0]), seen.join(" | "));
      assert.ok(/\/operations\/op-1 GET/.test(seen[1]), seen.join(" | "));
    } finally {
      global.fetch = realFetchImg;
    }
  });

  await test("изображения: ответ со ссылкой скачивается в base64", async () => {
    global.fetch = async (url) => {
      if (/\/images/.test(String(url)) && !/cdn\.example/.test(String(url))) {
        return { ok: true, status: 200, json: async () => ({ data: [{ url: "https://cdn.example/pic.png" }] }), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        json: async () => ({}),
        text: async () => "",
      };
    };
    try {
      const r = await core.generateImageRemote({ url: "https://gw-three.example/v1", key: "k" }, "кот", "m", {});
      assert.strictEqual(r.mediaType, "image/png");
      assert.strictEqual(r.b64, Buffer.from([1, 2, 3]).toString("base64"));
    } finally {
      global.fetch = realFetchImg;
    }
  });

  await test("main.js: файл пишется из base64 ядра, ошибка называет адрес и модель", () => {
    const mainSrc = backendSrc();
    assert.ok(/Buffer\.from\(img\.b64, "base64"\)/.test(mainSrc), "main.js не пишет файл из base64");
    assert.ok(/провайдер: " \+ img\.label/.test(mainSrc), "в отчёте агента нет определённого провайдера");
    assert.ok(/Тип подключения приложение определяет по адресу само/.test(mainSrc), "ошибка не объясняет автоопределение");
    const htmlSrc2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(/id="vision-detect-hint"/.test(htmlSrc2), "нет строки «определено» в настройках");
    // Строку «определено» рисует панель настроек (app.js: window.SettingsPanel).
    assert.ok(/AgentCore\.imageProviderLabel\(url\)/.test(uiFile("settings-panel.js")), "настройки не показывают определённого провайдера");
    // Генерация изображений живёт в отдельном модуле (agent-core только раздаёт её наружу).
    const imgSrc2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "image-tools.js"), "utf8");
    // Прокси браузерного режима ждёт «/api/llm/<кодированная база>/<путь>»: если закодировать
    // адрес целиком, server.js отвечает 400 «Bad proxy path» (ловил живой тест).
    assert.ok(/res = await callApi\(proxiedUrl\(a\.url\)/.test(imgSrc2), "запрос генерации кодирует адрес целиком");
    assert.ok(/function proxiedUrl\(fullUrl\)/.test(imgSrc2), "нет сборщика прокси-адреса");
  });
}

// ── 1b. app-ui-tools ─────────────────────────────────────────────────────────
async function testAppUiTools() {
  const appUi = require(path.join(ROOT, "src", "app-ui-tools.js"));

  await test("app-ui-tools: экспорты и looksDangerous", () => {
    for (const f of ["read", "click", "fill", "select", "press", "wait", "screenshot"]) {
      assert.strictEqual(typeof appUi[f], "function", "нет экспорта " + f);
    }
    assert.ok(appUi.looksDangerous("Удалить файл"), "не поймал «Удалить»");
    assert.ok(appUi.looksDangerous("Очистить чат"), "не поймал «Очистить чат»");
    assert.ok(appUi.looksDangerous("Сбросить настройки"), "не поймал «Сбросить»");
    assert.ok(appUi.looksDangerous("Отменить изменения"), "не поймал «Отменить»");
    assert.ok(!appUi.looksDangerous("Настройки"), "ложный сработал на «Настройки»");
    assert.ok(!appUi.looksDangerous("Сохранить"), "ложный сработал на «Сохранить»");
    assert.ok(!appUi.looksDangerous(""), "пустая строка опасна");
  });

  await test("app-ui-tools: без окна → понятная ошибка", async () => {
    let msg = "";
    try {
      await appUi.read({}, null);
    } catch (e) {
      msg = e && e.message ? e.message : String(e);
    }
    assert.ok(/десктоп|недоступно/i.test(msg), "read(null) вернул: " + msg.slice(0, 80));
  });
}

// ── 1.5 agent-store: память проекта и точки отката ────────────────────────────
async function testAgentStore() {
  const store = require(path.join(ROOT, "src", "agent-store.js"));

  await test("agent-store: заметки roundtrip (save/read/list/delete), разделение по проектам", () => {
    const userData = tmpdir("as-mem-");
    const projA = path.join(userData, "projA");
    const projB = path.join(userData, "projB");
    fs.mkdirSync(projA);
    fs.mkdirSync(projB);

    const r1 = store.noteSave(userData, projA, "architecture", "Electron + Vite, main.js — агентский цикл.");
    assert.ok(r1.ok, "noteSave упал: " + (r1.error || ""));
    const r2 = store.noteSave(userData, projA, "decisions", "Никогда не пушим без спроса.");
    assert.ok(r2.ok);
    store.noteSave(userData, projB, "architecture", "Другой проект.");

    const one = store.noteRead(userData, projA, "architecture");
    assert.ok(one.ok && one.content.includes("Electron"), "noteRead по ключу: " + JSON.stringify(one));

    const all = store.noteRead(userData, projA, "");
    assert.ok(all.ok && all.notes.length === 2, "должно быть 2 заметки в projA, есть " + (all.notes && all.notes.length));
    // Свежие первыми (при равных миллисекундах порядок не важен — главное, что обе на месте).
    const keys = all.notes.map((n) => n.key).sort();
    assert.deepStrictEqual(keys, ["architecture", "decisions"]);

    const bOnly = store.noteRead(userData, projB, "");
    assert.strictEqual(bOnly.notes.length, 1, "проекты должны быть изолированы");

    const del = store.noteDelete(userData, projA, "decisions");
    assert.ok(del.ok, "noteDelete: " + (del.error || ""));
    assert.strictEqual(store.noteRead(userData, projA, "").notes.length, 1);
    assert.ok(!store.noteRead(userData, projA, "decisions").ok, "удалённая заметка всё ещё читается");
  });

  await test("agent-store: валидация заметок (key, пустота, длина)", () => {
    const userData = tmpdir("as-val-");
    const proj = path.join(userData, "p");
    fs.mkdirSync(proj);
    // «Плохой» ключ — это пустой или пробельный: кириллица и пробелы переводятся
    // в латиницу сами, иначе естественная попытка записать заметку по-русски
    // превращалась в отказ формата.
    const ru = store.noteSave(userData, proj, "разбор переписок", "x");
    assert.ok(ru.ok, "русский ключ отклонён: " + (ru.error || ""));
    assert.strictEqual(ru.key, "razbor-perepisok", "ключ переведён не так: " + ru.key);
    assert.strictEqual(ru.transliterated, true, "о переводе ключа не сказано");
    assert.ok(store.noteSave(userData, proj, "zadacha na segodnya", "x").ok, "латиница с пробелом отклонена");
    assert.ok(!store.noteSave(userData, proj, "   ", "x").ok, "пропустил пустой key");
    assert.ok(!store.noteSave(userData, proj, "valid", "   ").ok, "пропустил пустой content");
    assert.ok(!store.noteSave(userData, proj, "valid", "x".repeat(store.NOTE_MAX_LEN + 1)).ok, "пропустил слишком длинный content");
    assert.ok(store.noteSave(userData, proj, "valid", "x").ok, "валидная заметка отклонена");
  });

  await test("agent-store: чекпоинт — снимок, правки, откат (пропускает .git/node_modules/бинарные)", async () => {
    const userData = tmpdir("as-cp-");
    const proj = path.join(userData, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "app.js"), "const a = 1;");
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(proj, "node_modules", "big.js"), "should not be saved");
    fs.writeFileSync(path.join(proj, ".git", "config"), "should not be saved");
    fs.writeFileSync(path.join(proj, "bin.dat"), Buffer.from([0, 1, 2, 3]));

    const saved = store.checkpointSave(userData, proj, "до правок");
    assert.ok(saved.ok, "checkpointSave: " + (saved.error || ""));
    assert.strictEqual(saved.files, 2, "в снимке должно быть 2 файла, есть " + saved.files);

    // Правки после снимка
    fs.writeFileSync(path.join(proj, "src", "app.js"), "// сломано");
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>broken</h1>");
    fs.writeFileSync(path.join(proj, "new-file.txt"), "создан после чекпоинта");

    const list = store.checkpointList(userData);
    assert.ok(list.ok && list.checkpoints.length === 1, "checkpointList: " + JSON.stringify(list));

    const rb = store.checkpointRollback(userData, saved.id);
    assert.ok(rb.ok, "rollback: " + (rb.error || ""));
    assert.strictEqual(rb.restoredCount, 2);
    assert.strictEqual(fs.readFileSync(path.join(proj, "src", "app.js"), "utf8"), "const a = 1;");
    assert.strictEqual(fs.readFileSync(path.join(proj, "index.html"), "utf8"), "<h1>hi</h1>");
    // Файлы, созданные после чекпоинта, не удаляются.
    assert.ok(fs.existsSync(path.join(proj, "new-file.txt")), "rollback удалил новый файл");
  });

  await test("agent-store: чекпоинт — лимит хранения (старые вытесняются) и защита id", async () => {
    const userData = tmpdir("as-cplim-");
    const proj = path.join(userData, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "a.txt"), "x");
    for (let i = 0; i < 17; i++) store.checkpointSave(userData, proj, "cp" + i);
    const list = store.checkpointList(userData);
    assert.strictEqual(list.checkpoints.length, 15, "должно остаться 15 чекпоинтов, есть " + list.checkpoints.length);

    assert.ok(!store.checkpointRollback(userData, "..\\..\\settings").ok, "пропустил path traversal в id");
    assert.ok(!store.checkpointRollback(userData, "нет-такого-id").ok, "пропустил несуществующий id");
  });
}

// ── 1.6 unified-patch: применение diff ───────────────────────────────────────
async function testUnifiedPatch() {
  const up = require(path.join(ROOT, "src", "unified-patch.js"));

  await test("unified-patch: изменение существующего файла (контекст + замена)", () => {
    const dir = tmpdir("up-mod-");
    fs.writeFileSync(path.join(dir, "app.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const patch = [
      "diff --git a/app.js b/app.js",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 20;",
      " const c = 3;",
    ].join("\n");
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(r.ok, "apply упал: " + JSON.stringify(r.errors));
    assert.deepStrictEqual(r.changed, ["app.js"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  await test("unified-patch: создание и удаление файлов, безопасность путей", () => {
    const dir = tmpdir("up-cr-");
    const patch = [
      "diff --git a/new.js b/new.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.js",
      "@@ -0,0 +1,2 @@",
      "+// новый",
      "+export const x = 1;",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-старый",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "old.txt"), "старый\n");
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(r.ok, "apply упал: " + JSON.stringify(r.errors));
    assert.strictEqual(fs.readFileSync(path.join(dir, "new.js"), "utf8"), "// новый\nexport const x = 1;");
    assert.ok(!fs.existsSync(path.join(dir, "old.txt")), "файл не удалён");

    // Path traversal не проходит
    const bad = up.applyUnifiedPatch(dir, "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n");
    assert.ok(bad.errors.length >= 1, "пропустил traversal: " + JSON.stringify(bad));
    // Абсолютный путь тоже
    const bad2 = up.applyUnifiedPatch(dir, "--- a/" + dir.replace(/\\/g, "/") + "/secret\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n");
    assert.ok(bad2.errors.length >= 1, "пропустил абсолютный путь");
  });

  await test("unified-patch: несовпадение контекста → понятная ошибка, файл не тронут", () => {
    const dir = tmpdir("up-miss-");
    fs.writeFileSync(path.join(dir, "a.txt"), "один\nдва\n");
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n один\n-НЕСОВПАДЕНИЕ\n+три\n";
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(!r.ok, "должен был упасть");
    assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "один\nдва\n");
  });
}

// ── 1.7 code-index: семантический поиск ─────────────────────────────────────
async function testCodeIndex() {
  const ci = require(path.join(ROOT, "src", "code-index.js"));

  await test("code-index: стемминг Porter сводит формы одного слова", () => {
    assert.strictEqual(ci.stem("running"), ci.stem("run"));
    assert.strictEqual(ci.stem("tokens"), ci.stem("token"));
    assert.strictEqual(ci.stem("files"), ci.stem("file"));
    assert.strictEqual(ci.stem("abc"), "abc");
    // authenticat/authentic — известная неточность Porter: не строго равны, но родственны (общий префикс).
    assert.ok(ci.tokenRelated(ci.stem("authentication"), ci.stem("authenticate")) > 0, "стеммы не родственны");
  });

  await test("code-index: токенизация разбирает camelCase/snake_case и кириллицу", () => {
    const toks = ci.tokenizeCode("getUserToken -> api_token; AUTH! 123");
    for (const t of ["get", "user", "token", "api", "auth", "123"]) {
      assert.ok(toks.includes(t), "нет токена " + t + " в " + JSON.stringify(toks));
    }
    const ru = ci.tokenizeCode("функция авторизации пользователя");
    assert.ok(ru.includes("функция") && ru.includes("авторизации"), "кириллица пропала: " + JSON.stringify(ru));
  });

  await test("code-index: BM25 — ранжирование и поиск по смыслу (auth → authenticate)", () => {
    const dir = tmpdir("ci-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "src", "login.js"), "function authenticateUser(user, pass) { return checkPassword(user, pass); }");
    fs.writeFileSync(path.join(dir, "src", "cart.js"), "function addToCart(item) { return total + item.price; }");
    fs.writeFileSync(path.join(dir, "src", "db.js"), "export const pool = createConnection('localhost');");
    fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "authenticate should be ignored");

    const index = ci.buildIndex(dir);
    assert.strictEqual(index.docsCount, 3, "node_modules должен быть пропущен, есть " + index.docsCount);

    // «authenticating users login» — морфология + смылс: должен найти login.js, где authenticateUser.
    const hits = ci.searchIndex(index, "authenticating users login", 8);
    assert.ok(hits.length >= 1, "ничего не найдено");
    assert.strictEqual(hits[0].rel, "src/login.js", "первый результат: " + JSON.stringify(hits.map((h) => h.rel)));

    const hits2 = ci.searchIndex(index, "database connection", 8);
    assert.strictEqual(hits2[0].rel, "src/db.js", "второй запрос: " + JSON.stringify(hits2.map((h) => h.rel)));

    // Кириллица: запрос на русском находит русские комментарии/строки.
    fs.writeFileSync(path.join(dir, "src", "docs.md"), "# Подключение к базе\nпароль хранится в secrets");
    const idxRu = ci.buildIndex(dir);
    const hitsRu = ci.searchIndex(idxRu, "пароль база", 8);
    assert.strictEqual(hitsRu[0].rel, "src/docs.md", "русский запрос: " + JSON.stringify(hitsRu.map((h) => h.rel)));

    const sn = ci.snippetForFile(dir, "src/login.js", "authenticate");
    assert.ok(sn.line >= 1 && sn.text.includes("authenticateUser"), "сниппет: " + sn.text);
  });

  await test("code-index: кэш на диске (getIndex по отпечатку)", () => {
    const userData = tmpdir("ci-cache-");
    const dir = path.join(userData, "proj");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world");
    const idx1 = ci.getIndex(userData, dir);
    const idx2 = ci.getIndex(userData, dir);
    assert.strictEqual(idx1.docsCount, 1);
    assert.ok(idx2.docs.length === 1, "кэш не подхватился");
    // После изменения файла отпечаток меняется → пересборка
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world again and again");
    const idx3 = ci.getIndex(userData, dir);
    assert.ok(idx3.docs[0].len > idx1.docs[0].len, "индекс не обновился после правки файла");
  });
}

async function testAgentSpeedups() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = backendSrc();
  const appUiSrc = fs.readFileSync(path.join(ROOT, "src", "app-ui-tools.js"), "utf8");
  // Адаптивный поиск элемента живёт в browser-map.js, прокрутка и наведение — в
  // browser-scroll.js, остальное — в ядре сессии: читаем весь дом целиком.
  const browserSrc = browserHomeSrc();

  await test("батчинг: правило 35 в промпте + параллельный набор read-only инструментов", () => {
    assert.ok(/^35\. БАТЧИНГ/m.test(core.SYSTEM_PROMPT), "в промпте нет правила 35 (батчинг)");
    assert.ok(/ВСЕ СРАЗУ в одном ответе/.test(core.SYSTEM_PROMPT), "правило не просит звать несколько инструментов сразу");
    assert.ok(/параллельн/i.test(core.SYSTEM_PROMPT), "правило не объясняет, что вызовы пойдут параллельно");
    assert.ok(/const PARALLEL_SAFE_TOOLS = new Set\(\[/.test(mainSrc), "нет списка безопасных для параллели инструментов");
    const setStart = mainSrc.indexOf("PARALLEL_SAFE_TOOLS = new Set");
    const block = mainSrc.slice(setStart, mainSrc.indexOf("]);", setStart));
    for (const t of ["readFile", "searchProject", "gitStatus", "gitDiff", "webFetch"]) {
      assert.ok(block.indexOf('"' + t + '"') !== -1, "в PARALLEL_SAFE_TOOLS нет " + t);
    }
    // Писатели и интерактивные инструменты НЕ должны попасть в параллельный набор.
    for (const t of ["writeFile", "editFile", "applyPatch", "runCommand", "askUser", "gitCommit", "gitPush", "createFolder", "startBackground"]) {
      assert.ok(block.indexOf('"' + t + '"') === -1, "писатель " + t + " попал в параллельный набор");
    }
    assert.ok(/calls\.every\(\(c\) => PARALLEL_SAFE_TOOLS\.has\(c\.name\)\)/.test(mainSrc), "нет условия параллельного выполнения");
    assert.ok(/await Promise\.all\(\s*calls\.map/.test(mainSrc), "нет параллельного запуска через Promise.all");
  });

  await test("скриншоты: JPEG по умолчанию, PNG по флагу png:true, mime по расширению", () => {
    assert.ok(/function encodeShot\(/.test(mainSrc) && /toJPEG\(/.test(mainSrc), "нет JPEG-кодирования скриншотов в main.js");
    assert.ok(/wantPng = a\.png === true/.test(mainSrc), "нет флага png:true для точных скриншотов");
    assert.ok(/const IMG_MIME = \{/.test(mainSrc) && /"\.jpg": "image\/jpeg"/.test(mainSrc), "analyzeImage не мапит .jpg → image/jpeg");
    assert.ok(/toJPEG\(/.test(appUiSrc), "appScreenshot не отдаёт JPEG");
    assert.ok(/type: "jpeg", quality/.test(browserSrc), "browserScreenshot не снимает JPEG по умолчанию");
    assert.ok(/r\.mime \|\| "image\/png"/.test(browserSrc), "data URL скриншота браузера не учитывает mime");
  });

  await test("компакция: сжатие с резервом 15% до переполнения", () => {
    // Резерв 15% + честное вычитание схем, системного промпта и справочников группы (иначе
    // индикатор врёт, а запрос не влезает в окно модели).
    assert.ok(
      /Math\.floor\(\(budget - state\.weight - systemWeight - state\.guidesWeight\) \* 0\.85\)/.test(mainSrc),
      "нет резерва 15% в бюджете истории (или справочники не вычтены)"
    );
    assert.ok(/const systemWeight = estimateTokens\(systemPrompt\);/.test(mainSrc), "системный промпт не вычитается из бюджета");
    // Справочник группы уезжает в КАЖДЫЙ запрос system-сообщением: его вес обязан
    // считаться, иначе на окне 32k запрос выходил за окно (замер: 30 729 из 28 672, а
    // справочник облака — 2 684 токена).
    assert.ok(
      /state\.guidesWeight = state\.guideNotes\.length \? estimateTokens\(JSON\.stringify\(state\.guideNotes\)\) : 0;/.test(mainSrc),
      "вес справочников группы не считается"
    );
    assert.ok(
      /const histBudgetAfterOverflow = \(\) => Math\.max\(1500, getBudget\(\) - state\.weight - systemWeight - state\.guidesWeight\);/.test(mainSrc),
      "после переполнения бюджет истории не учитывает справочники"
    );
    assert.ok(/const used = histTokens \+ tools\.state\.weight \+ tools\.state\.systemWeight;/.test(mainSrc), "индикатор контекста не учитывает промпт");
  });
  await test("кэш промпта: Claude получает точки кэша, OpenAI-совместимым поле не шлём", () => {
    const tools = [
      { type: "function", function: { name: "a", description: "d", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "b", description: "d", parameters: { type: "object", properties: {} } } },
    ];
    // 1) Anthropic: кэш на system и на последней схеме инструмента (кэширует весь блок tools).
    const anth = JSON.parse(
      core.buildChatRequest(
        { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" },
        {
          model: "claude-sonnet-4",
          messages: [
            { role: "system", content: "СИСТЕМА" },
            { role: "user", content: "hi" },
          ],
          tools,
        }
      ).body
    );
    assert.ok(Array.isArray(anth.system) && anth.system[0].cache_control, "Anthropic: нет точки кэша на system");
    assert.strictEqual(anth.system[0].cache_control.type, "ephemeral", "Anthropic: неверный тип точки кэша");
    assert.strictEqual(anth.system[0].text, "СИСТЕМА", "Anthropic: текст системного промпта потерялся");
    assert.ok(anth.tools[anth.tools.length - 1].cache_control, "Anthropic: нет точки кэша на последнем инструменте");
    assert.ok(!anth.tools[0].cache_control, "Anthropic: лишняя точка кэша на первом инструменте");

    // 2) Обычный OpenAI-совместимый API: поле запрещено — иначе 400.
    const oai = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" },
      { model: "gpt-4o-mini", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }], tools }
    );
    assert.strictEqual(oai.body.indexOf("cache_control"), -1, "OpenAI получил чужое поле cache_control (будет 400)");

    // 3) OpenRouter: кэш для Claude/Gemini, но не для прочих моделей.
    const orClaude = JSON.parse(
      core.buildChatRequest(
        { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" },
        { model: "anthropic/claude-sonnet-4", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
      ).body
    );
    const sysMsg = orClaude.messages[0];
    assert.ok(Array.isArray(sysMsg.content) && sysMsg.content[0].cache_control, "OpenRouter+Claude: нет точки кэша");
    assert.strictEqual(sysMsg.content[0].text, "S", "OpenRouter+Claude: системный текст потерялся");
    const orGpt = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" },
      { model: "openai/gpt-4o", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
    );
    assert.strictEqual(orGpt.body.indexOf("cache_control"), -1, "OpenRouter+GPT получил cache_control");
    // 4) Ollama: ничего лишнего.
    const ollama = core.buildChatRequest(
      { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" },
      { model: "llama3", messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] }
    );
    assert.strictEqual(ollama.body.indexOf("cache_control"), -1, "Ollama получила cache_control");
  });

  await test("ожидание событий: адаптивный опрос вместо фиксированных пауз", () => {
    assert.ok(/async function waitUntil\(fn, timeoutMs, pollMs\)/.test(browserSrc), "нет waitUntil в browser-tools");
    assert.ok(/let findPoll = 80;/.test(browserSrc), "поиск элемента не адаптивный (остались фиксированные 200 мс)");
    assert.ok(/findPoll = Math\.min\(Math\.round\(findPoll \* 1\.6\), FIND_POLL_MS\)/.test(browserSrc), "опрос поиска не растёт до потолка");
    assert.ok(/let poll = 100;/.test(browserSrc), "browserWait не адаптивный (остались фиксированные 400 мс)");
    assert.ok(/await waitUntil\(async \(\) => \{[\s\S]{0,180}?\}, 400, 70\)/.test(browserSrc), "hover не ждёт появления меню событием");
    assert.ok(/const moved = await waitUntil\(async \(\) => \{/.test(browserSrc), "прокрутка колесом ждёт фиксированную паузу");
    assert.ok(!/await sleep\(400\);\s*\n\s*const after = await namesOnPage/.test(browserSrc), "в hover осталась слепая пауза 400 мс");
  });
}

// ── Кэш промпта: статичный префикс и метрики токенов ─────────────────────────
async function testPromptCacheAndUsage() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
  const orSettings = { provider: "openai", openaiUrl: "https://openrouter.ai/api/v1", openaiApiKey: "k" };

  await test("кэш промпта: кэшируемый блок — только статичный SYSTEM_PROMPT", () => {
    const prompt = core.SYSTEM_PROMPT;
    const dynamic = "\n\nРабочая директория: /home/user\n=== САММАРИ ПРОЕКТА ===\n📁 src/";
    const sp = core.splitStaticSystem(prompt + dynamic, prompt);
    assert.ok(sp, "статичный префикс не распознан");
    assert.strictEqual(sp.head, prompt, "в кэшируемый блок попал не весь статичный промпт");
    assert.strictEqual(sp.tail, dynamic, "динамический хвост отделён неверно");
    assert.ok(
      sp.head.indexOf("/home/user") === -1 && sp.head.indexOf("📁") === -1,
      "динамический «паспорт проекта» попал в кэшируемый блок"
    );
    assert.strictEqual(core.splitStaticSystem("совсем другой текст", prompt), null, "чужой текст признан статичным");
    assert.strictEqual(core.splitStaticSystem(prompt, ""), null, "пустая граница принята за статичный префикс");
  });

  await test("кэш промпта: OpenRouter+Claude — кэш только на статичном блоке", () => {
    const prompt = core.SYSTEM_PROMPT;
    const dynamic = "\n\n=== САММАРИ ПРОЕКТА ===\n📄 package.json";
    const req = core.buildChatRequest(orSettings, {
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "system", content: prompt + dynamic }, { role: "user", content: "привет" }],
      tools: core.TOOL_DEFINITIONS,
      staticSystem: prompt,
    });
    const sys = JSON.parse(req.body).messages[0];
    assert.strictEqual(sys.role, "system");
    assert.ok(Array.isArray(sys.content), "system не разбит на блоки");
    assert.strictEqual(sys.content.length, 2, "ожидались два блока: статичный и динамический");
    assert.ok(sys.content[0].cache_control, "нет точки кэша на статичном блоке");
    assert.ok(!sys.content[1].cache_control, "точка кэша попала на динамический блок");
    assert.strictEqual(sys.content[0].text, prompt, "статичный блок искажён");
    assert.strictEqual(sys.content[1].text, dynamic, "динамический блок искажён");
    assert.ok(sys.content[0].text.indexOf("📄 package.json") === -1, "динамика осталась в кэшируемом блоке");
    // Без границы — прежнее поведение: один кэшируемый блок целиком.
    const plain = JSON.parse(
      core.buildChatRequest(orSettings, {
        model: "anthropic/claude-3.5-sonnet",
        messages: [{ role: "system", content: prompt + dynamic }],
        tools: [],
      }).body
    ).messages[0];
    assert.strictEqual(plain.content.length, 1, "без границы блок должен остаться один");
  });

  await test("кэш промпта: Anthropic — system блоками, схемы инструментов тоже кэшируются", () => {
    const prompt = core.SYSTEM_PROMPT;
    const ant = { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" };
    const body = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [{ role: "system", content: prompt + "\n\nПлан: пункт 1" }, { role: "user", content: "ок" }],
        tools: core.TOOL_DEFINITIONS,
        staticSystem: prompt,
      }).body
    );
    assert.ok(Array.isArray(body.system), "system не блоками");
    assert.strictEqual(body.system.length, 2, "динамика должна идти отдельным блоком");
    assert.ok(body.system[0].cache_control, "нет точки кэша на статичном промпте");
    assert.ok(!body.system[1].cache_control, "точка кэша накрыла динамику");
    assert.ok(body.tools[body.tools.length - 1].cache_control, "схемы инструментов не кэшируются");
    // Без границы — как раньше: один блок под кэш.
    const old = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [{ role: "system", content: prompt }],
        tools: [],
      }).body
    );
    assert.strictEqual(old.system.length, 1, "без границы ожидается один блок");
    assert.ok(old.system[0].cache_control, "точка кэша пропала вовсе");
  });
  await test("кэш промпта: Anthropic + справочники — кэш только на статике, ничего не теряется", () => {
    const prompt = core.SYSTEM_PROMPT;
    const brief = "\n\nРабочая директория: /home/user\n=== САММАРИ ПРОЕКТА ===\n📁 src/";
    const guideA = '=== СПРАВОЧНИК АГЕНТА: "browser" (группа "browser") ===\nБыстрый путь: browserOpen → browserSnapshot';
    const guideB = '=== СПРАВОЧНИК АГЕНТА: "yc" (группа "cloud") ===\nНачни с ycStatus';
    // Ровно та раскладка, что строит main.js: [system(промпт+brief), ...guideNotes, ...история]
    const messages = [
      { role: "system", content: prompt + brief },
      { role: "system", content: guideA },
      { role: "system", content: guideB },
      { role: "user", content: "открой сайт" },
      { role: "assistant", content: "ок" },
    ];
    const ant = { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" };
    const body = JSON.parse(
      core.buildChatRequest(ant, { model: "claude-sonnet-4", messages, tools: [], staticSystem: prompt }).body
    );
    assert.ok(Array.isArray(body.system), "system не блоками");
    assert.strictEqual(body.system.length, 2, "ожидались статичный блок + динамика со справочниками");
    assert.ok(body.system[0].cache_control, "нет точки кэша на статичном промпте");
    assert.ok(!body.system[1].cache_control, "точка кэша накрыла динамику и справочники");
    assert.strictEqual(body.system[0].text, prompt, "статичный блок искажён");
    const tail = body.system[1].text;
    assert.ok(tail.indexOf(guideA) !== -1 && tail.indexOf(guideB) !== -1, "справочники потерялись в system");
    assert.ok(tail.indexOf("/home/user") !== -1, "паспорт проекта потерялся");
    assert.ok(body.system[0].text.indexOf("СПРАВОЧНИК АГЕНТА") === -1, "справочник попал в кэшируемый блок");
    assert.ok(!body.messages.some((m) => m.role === "system"), "system остался в messages");
    assert.deepStrictEqual(body.messages.map((m) => m.role), ["user", "assistant"], "история диалога повреждена");
    // Заметка о повторной попытке приходит ПОСЛЕ истории (main.js) — у Anthropic она тоже
    // обязана уехать в верхнеуровневый system: system внутри messages API не принимает.
    const retryBody = JSON.parse(
      core.buildChatRequest(ant, {
        model: "claude-sonnet-4",
        messages: [
          { role: "system", content: prompt + brief },
          { role: "user", content: "почини баг" },
          { role: "assistant", content: "работаю" },
          { role: "system", content: "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА — авто-повтор" },
          { role: "user", content: "продолжай" },
        ],
        tools: [],
        staticSystem: prompt,
      }).body
    );
    assert.ok(!retryBody.messages.some((m) => m.role === "system"), "заметка о повторе осталась в messages");
    assert.strictEqual(retryBody.system.length, 2, "заметка раздвоила блоки system");
    assert.ok(
      retryBody.system[1].text.indexOf("ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА") !== -1,
      "заметка о повторе не попала в system"
    );
    assert.ok(!retryBody.system[1].cache_control, "кэш накрыл заметку о повторе");
  });

  await test("G4F: строгий OpenAI-совместимый получает ОДИН ведущий system и никаких полей кэша", () => {
    const prompt = core.SYSTEM_PROMPT;
    const g4f = { provider: "openai", openaiUrl: "http://localhost:1337/v1", openaiApiKey: "" };
    const guideA = '=== СПРАВОЧНИК АГЕНТА: "browser" (группа "browser") ===\nБыстрый путь';
    const guideB = '=== СПРАВОЧНИК АГЕНТА: "system" (группа "system") ===\nОболочки: shellsStatus';
    const messages = [
      { role: "system", content: prompt + "\n\nРабочая директория: /home/user" },
      { role: "system", content: guideA },
      { role: "system", content: guideB },
      { role: "user", content: "привет" },
    ];
    const req = core.buildChatRequest(g4f, { model: "HuggingChat:gpt-4o-mini", messages, tools: [], staticSystem: prompt });
    const body = JSON.parse(req.body);
    assert.ok(/\/chat\/completions$/.test(req.url), "не OpenAI-совместимый путь: " + req.url);
    // Маршрут «Провайдер:модель»: современный g4f ждёт провайдера отдельным полем.
    assert.strictEqual(body.provider, "HuggingChat", "провайдер G4F не ушёл отдельным полем");
    assert.strictEqual(body.model, "gpt-4o-mini", "имя модели не очищено от префикса провайдера");
    const sysMsgs = body.messages.filter((m) => m.role === "system");
    assert.strictEqual(sysMsgs.length, 1, "у строгого сервера больше одного system: " + sysMsgs.length);
    assert.strictEqual(body.messages[0].role, "system", "system не в начале диалога");
    const head = sysMsgs[0].content;
    assert.ok(head.startsWith(prompt), "статичный промпт потерялся или сдвинулся");
    assert.ok(head.indexOf("Рабочая директория: /home/user") !== -1, "паспорт проекта потерялся");
    assert.ok(head.indexOf(guideA) !== -1 && head.indexOf(guideB) !== -1, "справочники потерялись");
    assert.ok(
      head.indexOf("Быстрый путь\n\n=== СПРАВОЧНИК АГЕНТА: \"system\"") !== -1,
      "ведущие system склеены не через пустую строку (порядок/разделитель изменились)"
    );
    assert.ok(!/cache_control/.test(req.body), "поле кэша ушло строгому OpenAI-совместимому");
    assert.strictEqual(body.stream_options, undefined, "stream_options ушёл без запроса");
    // Исходный массив не мутируем, а служебная заметка в середине остаётся на месте.
    assert.strictEqual(messages.filter((m) => m.role === "system").length, 3, "исходные сообщения изменены");
    const retry = JSON.parse(
      core.buildChatRequest(g4f, {
        model: "gpt-4o-mini",
        messages: messages.concat([
          { role: "assistant", content: "ок" },
          { role: "system", content: "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА" },
          { role: "user", content: "продолжай" },
        ]),
        tools: [],
      }).body
    );
    assert.strictEqual(retry.messages.filter((m) => m.role === "system").length, 2, "склеились и служебные заметки — они должны остаться на месте");
    assert.strictEqual(retry.messages[retry.messages.length - 2].content, "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА", "заметка о повторе сдвинулась");
  });

  await test("кэш промпта: OpenRouter + справочники — одна точка кэша и ничего не теряется", () => {
    const prompt = core.SYSTEM_PROMPT;
    const guide = '=== СПРАВОЧНИК АГЕНТА: "app" (группа "app") ===\nappRead → appClick';
    const body = JSON.parse(
      core.buildChatRequest(orSettings, {
        model: "anthropic/claude-3.5-sonnet",
        messages: [
          { role: "system", content: prompt + "\n\n📁 src/" },
          { role: "system", content: guide },
          { role: "user", content: "нажми Сохранить в настройках" },
        ],
        tools: [],
        staticSystem: prompt,
      }).body
    );
    const sys = body.messages[0];
    assert.strictEqual(sys.role, "system", "первым должен идти system");
    assert.ok(Array.isArray(sys.content), "system не разбит на блоки");
    assert.strictEqual(sys.content.length, 2, "ожидались статичный блок и хвост");
    assert.ok(sys.content[0].cache_control, "нет точки кэша на статике");
    assert.ok(!sys.content[1].cache_control, "кэш накрыл динамику");
    assert.strictEqual(sys.content[0].text, prompt, "статичный блок искажён");
    assert.ok(sys.content[1].text.indexOf(guide) !== -1, "справочник потерялся");
    const points = JSON.parse(JSON.stringify(body)).messages
      .filter((m) => m.role === "system")
      .reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.cache_control).length : 0), 0);
    assert.strictEqual(points, 1, "точек кэша должно быть ровно одна, а не " + points);
    assert.strictEqual(body.messages.filter((m) => m.role === "system").length, 1, "справочник ушёл отдельным system-сообщением");
  });

  await test("метрики: stream_options.include_usage только там, где его ждут", () => {
    const msgs = [{ role: "system", content: core.SYSTEM_PROMPT }, { role: "user", content: "привет" }];
    const strict = { provider: "openai", openaiUrl: "https://api.deepseek.com/v1", openaiApiKey: "k" };
    const on = JSON.parse(core.buildChatRequest(strict, { model: "deepseek-chat", messages: msgs, tools: [], includeUsage: true }).body);
    assert.deepStrictEqual(on.stream_options, { include_usage: true }, "нет stream_options.include_usage");
    const off = JSON.parse(core.buildChatRequest(strict, { model: "deepseek-chat", messages: msgs, tools: [] }).body);
    assert.strictEqual(off.stream_options, undefined, "stream_options ушёл без запроса");
    const ant = JSON.parse(
      core.buildChatRequest(
        { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" },
        { model: "claude-sonnet-4", messages: msgs, tools: [], includeUsage: true }
      ).body
    );
    assert.strictEqual(ant.stream_options, undefined, "stream_options ушёл в Anthropic");
    const ol = JSON.parse(
      core.buildChatRequest({ provider: "ollama", ollamaUrl: "http://localhost:11434" }, {
        model: "qwen3:4b",
        messages: msgs,
        tools: [],
        includeUsage: true,
      }).body
    );
    assert.strictEqual(ol.stream_options, undefined, "stream_options ушёл в Ollama");
  });

  await test("замер локальной модели: скорости, память и вердикт по ответу Ollama", async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init: init || {} });
      const u = String(url);
      if (/\/api\/tags$/.test(u)) return { ok: true, status: 200, json: async () => ({ models: [{ name: "qwen3:8b" }] }) };
      if (/\/api\/ps$/.test(u)) {
        const asked = calls.some((c) => /\/api\/chat$/.test(c.url));
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: asked ? [{ name: "qwen3:8b", size: 5 * 1073741824, size_vram: 0 }] : [] }),
        };
      }
      if (/\/api\/chat$/.test(u)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            message: { content: "готов" },
            total_duration: 30e9,
            load_duration: 20e9,
            prompt_eval_count: 600,
            prompt_eval_duration: 20e9,
            eval_count: 24,
            eval_duration: 4e9,
          }),
        };
      }
      if (/\/api\/show$/.test(u)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            capabilities: ["completion", "tools"],
            model_info: {
              "general.architecture": "qwen3",
              "qwen3.context_length": 40960,
              "qwen3.block_count": 36,
              "qwen3.attention.head_count": 32,
              "qwen3.attention.head_count_kv": 8,
              "qwen3.embedding_length": 4096,
            },
          }),
        };
      }
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    };
    try {
      const r = await core.probeLocalModel(
        { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" },
        "qwen3:8b",
        { numCtx: 36864, window: 40960, promptTokens: 24000, probeChars: 600 }
      );
      assert.ok(r.ok, "замер не прошёл: " + r.error);
      // 24 токена за 4 с и 600 токенов за 20 с — из этих чисел и строится вердикт.
      assert.strictEqual(r.genPerSec, 6, "скорость генерации: " + r.genPerSec);
      assert.strictEqual(r.prefillPerSec, 30, "скорость чтения промпта: " + r.prefillPerSec);
      assert.strictEqual(r.gpuShare, 0, "доля весов в видеопамяти");
      assert.strictEqual(r.wasLoaded, false, "модель сочли загруженной до запроса");
      assert.strictEqual(r.loadMs, 20000, "время загрузки модели");
      // KV-кэш: 2 × 36 слоёв × 8 голов KV × 128 (4096 / 32) × 2 байта = 147 456 Б/токен.
      assert.strictEqual(r.kvPerToken, 147456, "размер KV на токен: " + r.kvPerToken);
      assert.strictEqual(r.kvBytes, 147456 * 36864, "KV-кэш посчитан неверно");
      assert.strictEqual(r.estimateSec, 800, "оценка нашего запроса: " + r.estimateSec);
      const body = JSON.parse(calls.find((c) => /\/api\/chat$/.test(c.url)).init.body);
      assert.strictEqual(body.options.num_ctx, 36864, "замер ушёл с другим num_ctx — Ollama перезагрузит модель");
      assert.strictEqual(body.stream, false, "замер должен быть не-стримом: длительности приходят в финале");
      assert.ok(body.messages[0].content.length > 300, "пробный промпт без балласта — скорость чтения будет скакать");
      const text = r.lines.join("\n");
      assert.ok(/процессор/.test(text), "в отчёте нет вывода про процессор: " + text);
      assert.ok(/KV-кэш/.test(text), "в отчёте нет цены контекста: " + text);
      assert.ok(/13 мин/.test(text), "нет оценки нашего обычного запроса: " + text);
      assert.ok(r.advice.length >= 1, "нет советов, что ускорит");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("замер локальной модели: сервер молчит — честный отказ без выдуманных цифр", async () => {
    const realFetch = global.fetch;
    global.fetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    };
    try {
      const r = await core.probeLocalModel({ provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }, "qwen3:8b", {});
      assert.strictEqual(r.ok, false, "отказ должен остаться отказом");
      assert.ok(/ECONNREFUSED/.test(r.error), "причина потеряна: " + r.error);
      assert.ok(/не измерена/.test(r.lines.join("\n")), "нет понятной строки для панели");
      assert.strictEqual(r.genPerSec, 0, "цифры выдуманы без ответа сервера");
      assert.deepStrictEqual(r.advice, [], "у отказа не должно быть советов");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("замер локальной модели: без модели в настройках не стучимся в сервер", async () => {
    const realFetch = global.fetch;
    let touched = 0;
    global.fetch = async () => {
      touched++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const r = await core.probeLocalModel({ provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" }, "", {});
      assert.strictEqual(r.ok, false, "замер без модели не должен считаться удачным");
      assert.strictEqual(touched, 0, "запросы ушли без выбранной модели");
      assert.ok(/модель/i.test(r.error), "не сказано, что нужна модель: " + r.error);
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("замер локальной модели: канал IPC, preload, мобильный API и кнопка на месте", () => {
    // Канал и вызов замера вынесены в src/model-ipc.js (этап B, часть 2).
    const modelIpc = fs.readFileSync(path.join(ROOT, "src", "model-ipc.js"), "utf8");
    assert.ok(/ipcMain\.handle\("ai:probeLocal"/.test(modelIpc), "нет канала ai:probeLocal");
    assert.ok(/probeLocalModel\(s, s\.model,\s*\{/.test(modelIpc), "обработчик не вызывает замер");
    assert.ok(/numCtx = provider === "ollama" \? ollamaNumCtx\(budget, win\)/.test(modelIpc), "num_ctx для замера не тот, что у чата");
    assert.strictEqual(mainOnlySrc().indexOf('ipcMain.handle("ai:probeLocal"'), -1, "канал замера остался в main.js");
    const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    assert.ok(/probeLocalModel: \(ui\) => ipcRenderer\.invoke\("ai:probeLocal"/.test(preloadSrc), "нет метода в preload");
    const mobileSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    assert.ok(/probeLocalModel: invoke\("ai:probeLocal"\)/.test(mobileSrc), "нет метода в мобильном API");
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    assert.ok(/\$\("btn-probe-ollama"\)\.onclick/.test(appSrc), "кнопка замера не подключена");
    assert.ok(/AgentCore\.probeLocalModel\(cfg, \{ fromBrowser: true \}\)/.test(uiFile("settings-panel.js")), "в веб-превью замер недоступен");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(/id="ollama-probe-result"/.test(htmlSrc), "нет блока отчёта в настройках");
  });

  await test("метрики: токен-отчёт разных провайдеров приводится к одному виду", () => {
    assert.deepStrictEqual(
      core.normalizeUsage({ prompt_tokens: 29042, completion_tokens: 512, prompt_tokens_details: { cached_tokens: 26880 } }),
      { prompt: 29042, completion: 512, cached: 26880 }
    );
    assert.deepStrictEqual(core.normalizeUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 900 }), {
      prompt: 1000,
      completion: 50,
      cached: 900,
    });
    assert.deepStrictEqual(core.normalizeUsage({ input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 700 }), {
      prompt: 800,
      completion: 120,
      cached: 700,
    });
    // Без данных кэша — ноль, а не NaN (иначе в консоль уйдёт «кэш NaN%»).
    assert.deepStrictEqual(core.normalizeUsage({ prompt_tokens: 10 }), { prompt: 10, completion: 0, cached: 0 });
    assert.strictEqual(core.normalizeUsage(null), null);
    assert.strictEqual(core.normalizeUsage("мусор"), null);
  });

  await test("метрики: цифры уходят в «Консоль», откат без stream_options на месте", () => {
    // Тело раунда живёт в src/run-round.js (часть 17): приём usage, строка метрик,
    // граница статичного промпта и замер первого байта уехали туда.
    const roundSrc = fs.readFileSync(path.join(ROOT, "src", "run-round.js"), "utf8");
    assert.ok(/onUsage: \(u\) => \{/.test(roundSrc), "usage ответа не принимается");
    assert.ok(/usage\.cached = Math\.max\(usage\.cached, u\.cached \|\| 0\)/.test(roundSrc), "кэш не собирается по раунду");
    assert.ok(/termEmit\(\{[\s\S]{0,200}?type: "metrics"/.test(roundSrc), "строка метрик не отправляется");
    assert.ok(/staticSystem: SYSTEM_PROMPT/.test(roundSrc), "граница статичного промпта не передана в запрос");
    assert.ok(/includeUsage: retry\.state\.includeUsage/.test(roundSrc), "флаг токен-отчёта не передаётся в запрос");
    assert.ok(/ttfbMs = Date\.now\(\) - startedAt/.test(roundSrc), "нет замера времени до первого байта");
    // Оборванная связь: решение «ждать и повторить или сказать сразу» живёт в модуле
    // повторов, а не в теле раунда — иначе правила разойдутся и прогон снова упадёт
    // с первой же сетевой ошибки («останавливается молча после обращения к API»).
    assert.ok(/const netVerdict = await retry\.transport\(e\)/.test(roundSrc), "обрыв связи не отдан модулю повторов");
    assert.ok(/if \(netVerdict\.kind === "repeat"\) return \{ kind: "repeat" \}/.test(roundSrc), "повтор раунда после обрыва связи не возвращается");
    assert.ok(/if \(!netVerdict\) throw new Error\("Сетевая ошибка при запросе к "/.test(roundSrc), "постоянная сетевая ошибка не уходит наружу прежним текстом");
    const retrySrc = fs.readFileSync(path.join(ROOT, "src", "run-retry.js"), "utf8");
    assert.ok(/transport: transport,/.test(retrySrc), "модуль повторов не отдаёт решение по обрыву связи");
    assert.ok(/TRANSIENT_NET/.test(retrySrc) && /FATAL_NET/.test(retrySrc), "нет разделения «моргнувшая сеть» и «постоянная ошибка»");
    // Строгий сервер без stream_options: выключаем и повторяем раунд, а не падаем.
    assert.ok(
      /state\.includeUsage &&\s*\(status === 400 \|\| status === 422\)/.test(mainSrc),
      "нет отката для сервера без stream_options"
    );
    assert.ok(
      /retry\.state\.includeUsage && \/stream_options\|include_usage\/i\.test\(errText\)/.test(mainSrc),
      "нет отката, если провайдер отверг stream_options внутри ответа"
    );
    assert.ok(/includeUsage = false;/.test(mainSrc), "флаг не выключается после отказа");
    assert.ok(
      /if \(roundOut\.kind === "repeat"\) \{[\s\S]{0,220}round--;[\s\S]{0,220}continue;/.test(mainSrc),
      "раунд не повторяется после отказа"
    );
    // Интерфейс
    // Строка метрик живёт в приёмнике событий терминала (side-panel.js).
    const metricsUi = uiFind('ev.type === "metrics"');
    assert.ok(metricsUi.code.indexOf("ts-metrics") !== -1, "метрики не уходят в консоль");
    assert.ok(/\.ts-metrics \{/.test(cssSrc), "нет стиля строки метрик");
  });
}

// ── Роутер инструментов: реестр групп и чистая функция выбора ────────────────
async function testToolRouter() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const allNames = core.TOOL_DEFINITIONS.map((t) => t.function && t.function.name);

  await test("роутер: реестр покрывает все схемы ровно один раз", () => {
    const base = core.BASE_TOOL_NAMES;
    assert.strictEqual(base.length, new Set(base).size, "в базе есть дубли");
    const inGroup = new Map();
    for (const g of core.TOOL_GROUPS) {
      assert.ok(g.id && g.title && Array.isArray(g.names) && g.names.length, "битая группа: " + JSON.stringify(g && g.id));
      assert.ok(Array.isArray(g.keywords) && g.keywords.length, "у группы " + g.id + " нет ключевых слов");
      for (const n of g.names) {
        assert.ok(!inGroup.has(n), "инструмент " + n + " в двух группах: " + inGroup.get(n) + " и " + g.id);
        inGroup.set(n, g.id);
      }
    }
    // База и группы не пересекаются — иначе схема пришла бы дважды.
    for (const n of base) assert.ok(!inGroup.has(n), "базовый " + n + " ещё и в группе " + inGroup.get(n));
    const registered = new Set([...base, ...inGroup.keys()]);
    const missing = allNames.filter((n) => !registered.has(n));
    const extra = [...registered].filter((n) => !allNames.includes(n));
    assert.deepStrictEqual(missing, [], "схемы вне реестра: " + missing.join(", "));
    assert.deepStrictEqual(extra, [], "в реестре несуществующие схемы: " + extra.join(", "));
    // Набор приложения про репозитории: git-минимум обязан быть в базе.
    for (const n of ["gitStatus", "gitDiff", "gitLog", "gitCommit", "gitBranch"]) {
      assert.ok(base.includes(n), n + " не в базе — на тесном окне git исчезнет");
    }
  });

  await test("роутер: порядок схем канонический и детерминированный", () => {
    const r1 = core.routeTools({ text: "почини git push и задеплой на сервер" });
    const r2 = core.routeTools({ text: "почини git push и задеплой на сервер" });
    assert.deepStrictEqual(r1.groups, r2.groups, "состав групп не детерминирован");
    const n1 = r1.tools.map((t) => t.function.name);
    const n2 = r2.tools.map((t) => t.function.name);
    assert.deepStrictEqual(n1, n2, "порядок схем не детерминирован");
    // Канонический порядок = порядок объявления (иначе кэш префикса промахивается).
    assert.deepStrictEqual(n1, allNames.filter((n) => n1.includes(n)), "порядок схем не канонический");
    assert.deepStrictEqual(r1.tools.map((t) => t.function.name), r2.tools.map((t) => t.function.name));
    // forceAll — тот же канонический порядок и полный набор.
    const all = core.routeTools({ forceAll: true });
    assert.strictEqual(all.all, true);
    assert.deepStrictEqual(all.tools.map((t) => t.function.name), allNames);
    assert.strictEqual(all.dropped.length, 0, "forceAll что-то срезал");
  });

  await test("роутер: группа включается по смыслу и остаётся липкой", () => {
    const fresh = core.routeTools({ text: "закоммить и запуш изменения на github" });
    assert.ok(fresh.groups.includes("git"), "группа git не включена: " + fresh.groups.join(","));
    assert.ok(fresh.activated.includes("git"), "git нет в activated");
    // Липкость: следующий запрос без слов о git — группа остаётся до конца задачи.
    const sticky = core.routeTools({ text: "посмотри файл", sticky: fresh.groups });
    assert.ok(sticky.groups.includes("git"), "липкая группа потеряна");
    // Без липкости тот же запрос группу не тянет.
    const lonely = core.routeTools({ text: "привет, как дела" });
    assert.ok(!lonely.groups.includes("git"), "git включился без запроса");
    assert.strictEqual(lonely.groups.length, 0, "тихая задача включила группы: " + lonely.groups.join(","));
    assert.strictEqual(lonely.tools.length, core.BASE_TOOL_NAMES.length, "тихая задача получила не только базу");
  });

  await test("роутер: экономия токенов и потолок не режет базу", () => {
    const all = core.routeTools({ forceAll: true });
    const quiet = core.routeTools({ text: "привет, как дела" });
    assert.ok(quiet.tokens < all.tokens * 0.4, "экономия меньше 60%: " + quiet.tokens + " из " + all.tokens);
    assert.ok(core.ROUTER_MAX_TOKENS >= quiet.tokens, "потолок меньше веса базы");
    // Группа, не влезшая в потолок, попадает в dropped (не пропадает молча).
    const tiny = core.routeTools({ text: "закоммить и запуш на github, открой браузер", maxTokens: quiet.tokens });
    assert.ok(tiny.tools.length >= core.BASE_TOOL_NAMES.length, "база урезана");
    assert.ok(tiny.dropped.length > 0, "срезанная группа не отмечена в dropped");
    assert.ok(
      tiny.groups.every((id) => !tiny.dropped.includes(id)),
      "группа попала и в used, и в dropped"
    );
  });

  await test("роутер: groupOfTool знает группу вызова (предохранитель A)", () => {
    assert.strictEqual(core.groupOfTool("gitPush"), "git");
    assert.strictEqual(core.groupOfTool("browserClick"), "browser");
    assert.strictEqual(core.groupOfTool("getSystemInfo"), "system");
    // Базовый инструмент группы не имеет — дотягивать нечего.
    assert.strictEqual(core.groupOfTool("readFile"), "");
    assert.strictEqual(core.groupOfTool("совсемНетТакого"), "");
    assert.strictEqual(core.groupOfTool(""), "");
    // Вызов инструмента вне текущего набора всегда разрешим через его группу.
    const quiet = core.routeTools({ text: "привет" });
    const quietNames = quiet.tools.map((t) => t.function.name);
    for (const n of ["gitPush", "browserClick", "registryWrite"]) {
      assert.ok(!quietNames.includes(n), n + " неожиданно в базе");
      assert.ok(core.groupOfTool(n), "у " + n + " нет группы — предохранитель A не сработает");
      const widened = core.routeTools({ text: "привет", sticky: quiet.groups.concat(core.groupOfTool(n)) });
      assert.ok(
        widened.tools.map((t) => t.function.name).includes(n),
        "после расширения " + n + " всё равно отсутствует"
      );
    }
  });

  await test("роутер: findTools ищет по-русски и не зависит от порядка", () => {
    assert.ok(core.BASE_TOOL_NAMES.includes("findTools"), "findTools нет в базовом наборе");
    assert.ok(allNames.includes("findTools"), "нет схемы findTools");
    const push = core.searchTools("запуш в github").map((t) => t.name);
    assert.ok(push.includes("gitPush"), "по «запуш» не нашёлся gitPush: " + push.join(","));
    const mail = core.searchTools("отправить письмо по smtp").map((t) => t.name);
    assert.ok(mail.includes("mailSend"), "по «письмо smtp» не нашёлся mailSend: " + mail.join(","));
    const shot = core.searchTools("скриншот экрана").map((t) => t.name);
    assert.ok(shot.includes("screenshotDesktop"), "по «скриншот экрана» не нашёлся screenshotDesktop");
    // Детерминизм: одинаковый запрос — одинаковый список (стабильный префикс промпта).
    assert.deepStrictEqual(core.searchTools("запуш в github"), core.searchTools("запуш в github"));
    // Каждый результат знает свою группу — предохранитель B умеет включить её целиком.
    for (const t of core.searchTools("запуш в github")) {
      if (t.name !== "findTools") assert.ok(t.group, t.name + " без группы");
    }
    // Сам findTools в выдачу не попадает (он и так в базе) и мусор не матчится.
    assert.ok(!core.searchTools("запуш в github").some((t) => t.name === "findTools"), "findTools в выдаче");
    assert.deepStrictEqual(core.searchTools("абракадабращщ"), []);
    assert.deepStrictEqual(core.searchTools(""), []);
  });

  await test("роутер: видит историю работы, а не только последнюю фразу («продолжай»)", () => {
    // Регрессия 1.5.42–1.5.62: роутер смотрел 3 последних фразы пользователя. На
    // «продолжай» группа app выпадала, схема appRead исчезала из набора — модель звала
    // её по памяти, предохранитель A дотягивал группу на ходу, префикс запроса менялся
    // и пул провайдера отвечал 503 cache_only_cold.
    const history = [
      { role: "user", content: "посмотри наше окно приложения и нажми в нём кнопку Настройки" },
      { role: "assistant", content: "Продолжаю — читаю окно приложения" },
      { role: "user", content: "продолжай" },
    ];
    const text = core.routerTaskText(history);
    assert.ok(/окно приложения/i.test(text), "история не попала в текст роутера: " + text);
    const r = core.routeTools({ text: text });
    assert.ok(r.groups.includes("app"), "группа app не включена по истории: " + r.groups.join(","));
    assert.ok(
      r.tools.some((t) => t.function.name === "appRead"),
      "appRead не попал в набор схем"
    );
    // Одной последней фразы для этого мало — именно в этом и была ошибка.
    assert.ok(!core.routeTools({ text: "продолжай" }).groups.includes("app"), "«продолжай» сам включает app");
    // Тихая история группы не тянет: предохранитель от разрастания схем на месте.
    const quiet = core.routerTaskText([{ role: "user", content: "привет, как дела" }]);
    assert.strictEqual(core.routeTools({ text: quiet }).groups.length, 0, "тихая история включила группы");
    // Пустая история и битые сообщения роутер не ломают.
    assert.strictEqual(core.routerTaskText([]), "");
    assert.strictEqual(core.routerTaskText(null), "");
    assert.strictEqual(core.routerTaskText([null, { role: "user" }, { role: "tool", content: "x" }]), "");
    // Длинная история обрезается, но остаётся детерминированной, и свежее не теряется.
    const many = [];
    for (let i = 0; i < 40; i++) many.push({ role: i % 2 ? "assistant" : "user", content: "сообщение номер " + i });
    const longText = core.routerTaskText(many);
    assert.ok(longText.length <= 6000, "роутер не держит потолок символов: " + longText.length);
    assert.strictEqual(longText, core.routerTaskText(many), "текст роутера не детерминирован");
    assert.ok(/сообщение номер 39/.test(longText), "в текст роутера не попала последняя фраза");
    // И это подключено в main.js вместо старого разбора трёх фраз.
    const mainSrc = backendSrc();
    assert.ok(/const routerTask = routerTaskText\(messages\)/.test(mainSrc), "main.js не берёт текст роутера из истории");
    assert.ok(
      !/for \(let i = messages\.length - 1; i >= 0 && parts\.length < 3/.test(mainSrc),
      "остался старый разбор трёх фраз в роутере"
    );
  });

  await test("пул провайдера: 503 cache_only_cold не роняет раунд, а ждёт и повторяет", () => {
    const detail = JSON.stringify({
      message: "cache-only admission rejected a cold, unavailable, or overloaded request",
      type: "Service Unavailable",
      param: "",
      code: "cache_only_cold",
    });
    const cold = core.coldCacheInfo(503, detail, 1);
    assert.ok(cold && cold.cold === true, "cache_only_cold не распознан");
    assert.ok(cold.waitMs >= 3000, "пауза перед повтором подозрительно мала: " + cold.waitMs);
    assert.ok(/кэш/.test(cold.text), "нет человеческого объяснения: " + cold.text);
    // Пауза растёт с попытками и не растёт бесконечно.
    const w = [1, 2, 3, 4, 5].map((n) => core.coldCacheInfo(503, detail, n).waitMs);
    assert.ok(w[1] > w[0] && w[2] > w[1], "пауза не растёт: " + w.join(","));
    assert.strictEqual(w[4], w[2], "пауза растёт бесконечно");
    assert.strictEqual(core.UNAVAILABLE_MAX, 3, "число повторов изменилось — обнови текст подсказки");
    // Обычный 503 без «кэша» тоже повторяется, но с честной формулировкой.
    const busy = core.coldCacheInfo(503, "overloaded", 1);
    assert.ok(busy && busy.cold === false && /временно недоступен/.test(busy.text), "обычный 503 не обработан");
    assert.ok(core.coldCacheInfo(502, "bad gateway", 1), "502 не считается временным отказом");
    // Чужие коды не перехватываем: ими занимаются свои ветки.
    assert.strictEqual(core.coldCacheInfo(429, detail, 1), null, "429 ушёл в ветку «холодного» пула");
    assert.strictEqual(core.coldCacheInfo(402, detail, 1), null, "402 ушёл в ветку «холодного» пула");
    assert.strictEqual(core.coldCacheInfo(400, "bad request", 1), null, "400 ушёл в ветку «холодного» пула");
    // 5xx без признаков «холода» и перегрузки не трогаем — иначе будем ждать зря.
    assert.strictEqual(core.coldCacheInfo(500, "internal error", 1), null, "любой 500 стал повтором");
    assert.ok(core.coldCacheInfo(500, "cache_only_cold", 1).cold, "холодный отказ под 500 не распознан");
    // Шлюз провайдера: HTML-страница вместо JSON (Cloudflare 524 и родственные коды).
    // Раньше такое роняло прогон насмерть, а в чат уезжала простыня тегов.
    const cfHtml =
      '<!DOCTYPE html>\n<html class="no-js ie6 oldie" lang="en-US"><head><title>api.example.com | 524: A timeout occurred</title>';
    const gateway = core.coldCacheInfo(524, cfHtml, 1);
    assert.ok(gateway && !gateway.cold, "524 с HTML-страницей не считается временным отказом шлюза");
    assert.strictEqual(gateway.text.indexOf("<"), -1, "в объяснение уехала HTML-страница: " + gateway.text);
    for (const code of [504, 520, 521, 522, 523, 525, 527, 530]) {
      assert.ok(core.coldCacheInfo(code, "", 1), code + " не считается отказом шлюза");
    }
    // Обрыв чтения тела запроса (шлюз не донёс запрос до модели) — тот же повтор.
    const bodyRead = core.coldCacheInfo(400, '{"type":"bad_request","message":"Could not read the request body."}', 1);
    assert.ok(bodyRead && bodyRead.why === "body", "обрыв чтения тела запроса не распознан");
    assert.ok(/тело запроса/.test(bodyRead.text), "нет человеческого объяснения: " + bodyRead.text);
    assert.strictEqual(core.coldCacheInfo(400, "invalid request body: tools[3]", 1), null, "наша же ошибка в запросе ушла в повторы");
    assert.strictEqual(core.coldCacheInfo(404, "could not read the request body", 1), null, "404 перехвачен веткой обрыва тела");
    // И это подключено в main.js: повтор ТОГО ЖЕ раунда вместо падения с сырым JSON.
    const mainSrc = backendSrc();
    assert.ok(/const cold = coldCacheInfo\(status, detail, state\.unavailableRetries \+ 1\)/.test(mainSrc), "503 не обрабатывается");
    assert.ok(/state\.unavailableRetries\+\+;/.test(mainSrc), "нет счётчика повторов 503");
    assert.ok(
      /const noteSuccess = \(\) => \{\s*state\.rateRetries = 0;\s*state\.unavailableRetries = 0;/.test(mainSrc),
      "счётчик повторов 503 не сбрасывается на успешном ответе"
    );
    assert.ok(/cache_only_cold: провайдер принимает только запрос с готовым кэшем/.test(mainSrc), "нет понятного сообщения после исчерпания повторов");
  });

  await test("роутер: предохранители подключены в main.js и в настройках", () => {
    const mainSrc = backendSrc();
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    // A: реальный вызов вне набора дотягивает группу и повторяет раунд со схемой.
    assert.ok(/const gid = groupOfTool\(c\.name\);/.test(mainSrc), "нет предохранителя A");
    assert.ok(/state\.sticky\.add\(gid\);\s*\n\s*fresh\.push\(gid\);/.test(mainSrc), "группа вызова не добавляется на ходу");
    assert.ok(/if \(fresh\.length\) \{\s*\n\s*refresh\(\);/.test(mainSrc), "набор схем не пересобирается после включения группы");
    // Группа могла не поместиться в окно: обещать «схем станет больше» нельзя.
    assert.ok(mainSrc.indexOf("не влезают в окно модели") !== -1, "отчёт о включении группы не сверяется с фактом");
    // B: findTools исполняется и включает группы текущей задачи.
    assert.ok(hasTool(mainSrc, "findTools"), "findTools не исполняется");
    assert.ok(/activeToolRouter\.addGroups\(groups\)/.test(mainSrc), "findTools не включает группы");
    assert.ok(/activeToolRouter = tools\.router;/.test(mainSrc), "нет роутера текущего запуска");
    // C: чекбокс «Отправить все инструменты» + полный набор без роутера.
    assert.ok(/const forceAllTools = !!settings\.sendAllTools;/.test(mainSrc), "настройка не читается агентом");
    assert.ok(/if \(o\.forceAll\)/.test(coreSrc), "forceAll не поддерживается роутером");
    assert.ok(/id="s-send-all-tools"/.test(htmlSrc), "нет чекбокса в настройках");
    assert.ok(/getSettings\(\)\.sendAllTools = !!\$\("s-send-all-tools"\)\.checked;/.test(uiFile("settings-panel.js")), "чекбокс не сохраняется");
    assert.ok(/\$\("s-send-all-tools"\)\.checked = !!getSettings\(\)\.sendAllTools;/.test(uiFile("settings-panel.js")), "чекбокс не восстанавливается");
    // Метрика раунда говорит, сколько групп ушло и что срезано.
    assert.ok(/· групп " \+ tools\.state\.route\.groups\.length/.test(mainSrc), "метрика без числа групп");
    assert.ok(/срезано: " \+ tools\.state\.route\.dropped\.join/.test(mainSrc), "метрика молчит о срезанных группах");
  });
}

// ── Политика инструментов и журнал действий ─────────────────────────────────
// Риск каждого инструмента живёт в одном месте (src/tool-policy.js): оттуда его
// берут и подтверждения, и журнал. Проверяем, что таблица не разошлась с ядром,
// что подтверждения не дублируются с чекбоксами настроек и что секреты не попадают
// в журнал, а сам журнал не ломает прогон агента.
async function testToolPolicy() {
  const policy = require(path.join(ROOT, "src", "tool-policy.js"));
  const audit = require(path.join(ROOT, "src", "audit-log.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  const coreToolNames = () => {
    const pick = (defs) => (defs || [])
      .map((d) => (d && d.function && d.function.name) || (d && d.name) || "")
      .filter(Boolean);
    return Array.from(new Set([
      ...pick(core.TOOL_DEFINITIONS),
      ...pick(core.PLAN_MODE_TOOL_DEFINITIONS),
      ...(core.BASE_TOOL_NAMES || []),
    ]));
  };

  await test("политика: у каждого инструмента ядра есть capability и риск, лишних записей нет", () => {
    const names = coreToolNames();
    assert.ok(names.length > 100, "инструменты ядра не найдены: " + names.length);
    const unknown = names.filter((n) => policy.capabilityOf(n) === "unknown");
    assert.deepStrictEqual(unknown, [], "без политики остались: " + unknown.join(", "));
    const known = new Set(names);
    const bogus = policy.CAPABILITIES.reduce((acc, c) => acc.concat(c.tools || []), []).filter((n) => !known.has(n));
    assert.deepStrictEqual(bogus, [], "политика описана для несуществующих инструментов: " + bogus.join(", "));
    const confirmCaps = policy.CAPABILITIES.filter((c) => c.confirm);
    assert.ok(confirmCaps.length >= 7, "потерялись подтверждения: " + confirmCaps.map((c) => c.cap).join(", "));
    assert.ok(policy.allCapabilities().indexOf("cloud.deploy") >= 0, "нет capability облачного деплоя");
    assert.strictEqual(policy.riskOf("readFile"), "low");
    assert.strictEqual(policy.riskOf("ycDelete"), "high");
  });

  await test("подтверждения: старые на месте, опасные спрашивают, безопасные — нет", () => {
    for (const t of ["killProcess", "registryWrite", "installExe"]) {
      assert.strictEqual(policy.needsConfirm(t), true, "потеряно подтверждение: " + t);
    }
    for (const t of ["installSystemPackage", "runCommandAsAdmin", "otaRollback", "browserClearProfile", "checkpointRollback"]) {
      assert.strictEqual(policy.needsConfirm(t), true, "не спрашивает: " + t);
    }
    // У этих инструментов своя защита — чекбокс в настройках (push, почта, облако,
    // вход в свой Chrome). Второй диалог только мешал бы, поэтому confirm: false.
    for (const t of ["gitPush", "mailSend", "ycDelete", "ycDeploy", "ycCreate", "browserConnect"]) {
      assert.strictEqual(policy.needsConfirm(t), false, "двойной диалог: " + t);
    }
    for (const t of ["runCommand", "writeFile", "readFile", "browserClick", "taskAdd"]) {
      assert.strictEqual(policy.needsConfirm(t), false, "лишний диалог: " + t);
    }
  });

  await test("опасные команды и дампы окружения распознаются", () => {
    assert.strictEqual(policy.isDangerousCommand("rm -rf dist"), true);
    assert.strictEqual(policy.isDangerousCommand("git push origin main"), true);
    assert.strictEqual(policy.isDangerousCommand("git reset --hard HEAD~1"), true);
    assert.strictEqual(policy.isDangerousCommand("git status"), false);
    assert.strictEqual(policy.isDangerousCommand("npm run build"), false);
    // Дампы окружения секретов не получают: иначе модель одной строкой выводит в чат
    // все ключи и пароли, которые пользователь положил в переменные агента.
    for (const c of ["env", "printenv", "set", "env | grep KEY", "export -p", "Get-ChildItem Env:", "cat /proc/self/environ"]) {
      assert.strictEqual(policy.commandDumpsEnv(c), true, "не распознан дамп окружения: " + c);
    }
    // Явный запрос переменной — осознанное действие: переменные агента доходят,
    // и это видно в переписке. Секретом рискует только «голый» дамп.
    for (const c of ["npm run build", "node -e 1", "docker ps", "printenv MY_KEY", "env FOO=1 node x.js", "docker run --env FOO=1 img", "python -m venv .venv"]) {
      assert.strictEqual(policy.commandDumpsEnv(c), false, "ложное срабатывание на команде: " + c);
    }
  });

  await test("редакция секретов: ключи, токены и длинные тексты не утекают в журнал", () => {
    const r = policy.redact({
      password: "hunter2",
      openaiApiKey: "sk-abcdefghijkl",
      mobilePin: "4821",
      folderId: "b1g",
      nested: { githubToken: "ghp_0123456789abcdefghij" },
    });
    assert.strictEqual(r.password, "***");
    assert.strictEqual(r.openaiApiKey, "***");
    assert.strictEqual(r.mobilePin, "***");
    assert.strictEqual(r.folderId, "b1g", "обычное поле испорчено");
    assert.strictEqual(r.nested.githubToken, "***", "вложенный секрет не вычищен");
    assert.ok(policy.scrub("ключ sk-abcdefghijklmnopqr").indexOf("sk-abcdefghijklmnopqr") === -1, "ключ не вырезан из текста");
    assert.ok(policy.scrub("token=abcdef123456").indexOf("abcdef123456") === -1, "значение token=… не вырезано");
    assert.strictEqual(policy.scrub("обычный текст"), "обычный текст", "scrub портит обычный текст");
    // Содержимое файла (writeFile) в журнал целиком не пишем — только начало и размер.
    const big = policy.redact({ content: "x".repeat(500) });
    assert.ok(big.content.length < 260, "длинный текст не сжат: " + big.content.length);
    assert.ok(big.content.indexOf("всего 500") >= 0, "нет пометки о размере: " + big.content);
  });

  await test("журнал: опасное и отказы пишет, чтение игнорирует, секретов не содержит", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    const file = path.join(dir, "audit.log");
    audit.init(file, true);
    assert.strictEqual(audit.setSecrets(["live-secret-value-42", "abc"]), 1, "короткие значения в список секретов не берём");

    assert.strictEqual(audit.record({ tool: "readFile", args: { path: "a.js" }, decision: "auto" }), null, "чтение попало в журнал");
    assert.strictEqual(audit.record({ tool: "taskAdd", args: { title: "дело" }, decision: "auto" }), null, "мелкое действие попало в журнал");
    const denied = audit.record({ tool: "installExe", args: { url: "http://x/setup.exe" }, decision: "denied", result: "не выполнено" });
    assert.ok(denied && denied.capability === "system.install" && denied.risk === "high", "отказ не записан как надо");
    assert.strictEqual(denied.outcome, "denied", "отказ не помечен исходом");
    const row = audit.record({ tool: "runCommand", args: { command: "npm ci", githubToken: "ghp_0123456789abcdefghij" }, decision: "auto", result: "TOKEN=abcdef123456 готово" });
    assert.ok(row && row.capability === "terminal.execute" && row.decision === "auto", "команда не записана");
    const unknown = audit.record({ tool: "придуманныйИнструмент", args: {}, decision: "auto" });
    assert.ok(unknown && unknown.capability === "unknown", "незнакомый инструмент не попал в журнал");
    // Живая проверка нашла эту дыру: команда честно печатает значение переменной,
    // а журнал его сохранял. Теперь известно значение — известно и как его вырезать.
    const printed = audit.record({ tool: "runCommand", args: { command: "printenv LIVE_LIVE_SECRET" }, decision: "auto", result: "live-secret-value-42" });
    assert.ok(printed && printed.outcome === "ok", "команда с переменной не записана");
    // Текста результата в журнале нет вообще — только исход и заметка об ошибке.
    assert.ok(!("result" in printed), "журнал всё ещё хранит вывод команды");
    const failed = audit.record({ tool: "dockerBuild", args: {}, decision: "auto", result: "Ошибка: Docker не найден\nподробности" });
    assert.strictEqual(failed.outcome, "error", "ошибка не распознана");
    assert.ok(/"note":"Ошибка: Docker не найден"/.test(JSON.stringify(failed)), "заметка об ошибке потерялась: " + JSON.stringify(failed.note));

    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.indexOf("ghp_0123456789abcdefghij") === -1, "секрет попал в файл журнала");
    assert.ok(text.indexOf("abcdef123456") === -1, "секрет из результата попал в файл журнала");
    assert.ok(text.indexOf("live-secret-value-42") === -1, "значение переменной агента попало в журнал");
    assert.ok(text.indexOf("***") >= 0, "вместо секрета нет пометки");
    const lines = audit.tail(20);
    assert.ok(lines.length >= 3, "журнал пуст: " + lines.length);
    assert.ok(lines.every((l) => l.time && l.ts && l.tool && l.risk), "записи журнала неполные");

    audit.setEnabled(false);
    assert.strictEqual(audit.record({ tool: "ycDelete", args: {}, decision: "approved" }), null, "выключенный журнал пишет");
    audit.setEnabled(true);

    // Битый путь не должен ломать прогон агента.
    audit.init(path.join(dir, "нет", "такой", "папки", "audit.log"), true);
    assert.strictEqual(audit.record({ tool: "ycDelete", args: {}, decision: "approved" }), null, "битый путь бросил исключение");

    // Ротация: журнал не растёт бесконечно.
    fs.writeFileSync(file, "x".repeat(audit.MAX_BYTES + 10), "utf8");
    audit.init(file, true);
    audit.record({ tool: "ycDelete", args: { id: "r1" }, decision: "approved" });
    assert.ok(fs.existsSync(file + ".1"), "старый журнал не сдвинут в .1");
    assert.ok(fs.statSync(file).size < 1000, "новый журнал не начат заново");

    audit.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("полный журнал агента: пишет КАЖДЫЙ вызов, держит конец вывода, секретов не содержит", () => {
    const agentLog = require(path.join(ROOT, "src", "agent-log.js"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-log-test-"));
    const file = path.join(dir, "agent.log");
    agentLog.init(file, true);

    // Пишется ЛЮБОЙ вызов — в этом и смысл журнала: «что агент вообще делал».
    const head = "npm warn ".repeat(300);
    const errTail = "npm ERR! code ERESOLVE — Could not resolve dependency\n";
    const row = agentLog.record({ tool: "runCommand", args: { command: "npm install react", githubToken: "ghp_0123456789abcdefghij" }, result: head + errTail, source: "desktop", ms: 1234 });
    assert.ok(row && row.tool === "runCommand" && row.capability === "terminal.execute" && row.risk === "medium", "вызов команды не записан");
    assert.strictEqual(row.source, "desktop", "источник (ПК/телефон) не записан");
    assert.strictEqual(row.ms, 1234, "время выполнения не записано");
    assert.strictEqual(row.chars, (head + errTail).length, "размер вывода не записан");
    // Главное: КОНЕЦ вывода (ошибка) сохраняется — именно его прятал head-only срез.
    assert.ok(/ERESOLVE/.test(row.result), "конец вывода потерян в полном журнале: " + row.result.slice(-60));

    // Исход вызова в журнале — по ОДНОМУ правилу с окном (audit.toolOk). Раньше
    // «Ошибка удаления: Не найдено (404)», «⏱ Команда не уложилась…» и вывод команды
    // с ненулевым кодом считались удачей: в журнале провал выглядел зелёным.
    const outcome = require(path.join(ROOT, "src", "audit-log.js"));
    for (const bad of [
      "Ошибка удаления: Не найдено (404): The specified bucket does not exist.",
      "Ошибка browserFill: Не нашёл «Сообщение». Похожие элементы: e174",
      "⛔ Отказано: действие запрещено настройкой",
      "⏱ Команда не уложилась в 60 000 мс и остановлена принудительно",
      "Не удалось открыть: нет доступа",
      "$ dir /s /b C:\\нет\\такой\n(каталог: C:\\проект) Команда завершилась с кодом 1 (0.6 с): FINDSTR: Cannot open",
    ]) {
      assert.strictEqual(outcome.toolOk(bad), false, "провал принят за удачу: " + bad);
    }
    for (const good of ["OK — файл записан", "Готово: 3 файла", "$ npm test\nКоманда завершилась с кодом 0 (1.2 с)"]) {
      assert.strictEqual(outcome.toolOk(good), true, "удачный вызов назван провалом: " + good);
    }

    // Обычное чтение пишется тоже (в отличие от журнала опасного).
    const read = agentLog.record({ tool: "readFile", args: { path: "/a.txt" }, result: "ok", source: "mobile" });
    assert.ok(read && read.tool === "readFile", "обычное чтение не попало в полный журнал");

    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.indexOf("ghp_0123456789abcdefghij") === -1, "секрет попал в файл полного журнала");
    assert.ok(text.indexOf("***") >= 0, "вместо секрета нет пометки");
    const lines = agentLog.tail(20);
    assert.ok(lines.length >= 2 && lines.every((l) => l.time && l.ts && l.tool && "ok" in l), "записи полного журнала неполные");

    agentLog.setEnabled(false);
    assert.strictEqual(agentLog.record({ tool: "readFile", args: {}, result: "x" }), null, "выключенный полный журнал пишет");
    agentLog.setEnabled(true);

    // Битый путь не должен ломать прогон агента.
    agentLog.init(path.join(dir, "нет", "такой", "папки", "agent.log"), true);
    assert.strictEqual(agentLog.record({ tool: "readFile", args: {}, result: "x" }), null, "битый путь бросил исключение");

    // Ротация: полный журнал не растёт бесконечно.
    fs.writeFileSync(file, "x".repeat(agentLog.MAX_BYTES + 10), "utf8");
    agentLog.init(file, true);
    agentLog.record({ tool: "readFile", args: {}, result: "x" });
    assert.ok(fs.existsSync(file + ".1"), "старый полный журнал не сдвинут в .1");
    assert.ok(fs.statSync(file).size < 2000, "новый полный журнал не начат заново");

    agentLog.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("main.js спрашивает по политике, пишет в журнал и не отдаёт секреты дампам", () => {
    const src = backendSrc();
    assert.ok(src.indexOf("toolPolicy.needsConfirm(c.name)") >= 0, "подтверждение не привязано к политике");
    assert.ok(src.indexOf("toolPolicy.isDangerousCommand(") >= 0, "опасные команды проверяются мимо политики");
    assert.ok(src.indexOf("audit.record({ tool: c.name") >= 0, "журнал не подключён к прогону");
    assert.ok(src.indexOf("audit.setEnabled(") >= 0, "настройка журнала не читается");
    assert.ok(src.split("commandEnv(command)").length - 1 >= 3, "команды агента идут без сужения окружения");
    assert.ok(src.indexOf("probeEnv()") >= 0, "служебные пробы получают секреты");
    // Знание об опасных командах должно жить ровно в одном месте — в политике.
    assert.ok(src.indexOf("const DANGEROUS_CMD_RE = toolPolicy.DANGEROUS_CMD_RE;") >= 0, "регулярка опасных команд раздвоилась");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.indexOf('id="s-audit-log"') >= 0, "нет переключателя журнала в настройках");
    // Настройка журнала живёт в панели настроек (app.js: window.SettingsPanel).
    assert.ok(uiAll().indexOf('$("s-audit-log")') >= 0, "переключатель журнала не подключён к форме");
  });
}

module.exports = {
  testAgentCore,
  testAppUiTools,
  testAgentStore,
  testUnifiedPatch,
  testCodeIndex,
  testAgentSpeedups,
  testToolRouter,
  testToolPolicy,
  testPromptCacheAndUsage,
};

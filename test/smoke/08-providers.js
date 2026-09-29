"use strict";
/* ─── Группа «Провайдеры: разрез транспорта, окно модели, G4F» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 5.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  get,
  selected,
  uiFile,
  uiFind,
} = H;

// ── Ollama: реальное окно модели, num_ctx и удержание модели в памяти ────────
async function testOllamaWindow() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = backendSrc();
  const realFetch = global.fetch;
  const calls = [];
  const mkRes = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });

  try {
    global.fetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, method: (opts && opts.method) || "GET" });
      if (!/\/api\/show$/.test(u)) throw new Error("неожиданный запрос: " + u);
      const sent = JSON.parse((opts && opts.body) || "{}");
      if (sent.name === "legacy:7b") {
        // Старая сборка Ollama: capabilities и parameters не отдаёт вовсе,
        // ключа архитектуры тоже нет — окно ищем просто по суффиксу context_length.
        return mkRes({ model_info: { "llama.context_length": 4096 } });
      }
      if (sent.name === "multimodal:8b") {
        // Мультимодальная модель: рядом лежит окно аудио-энкодера, оно НЕ должно
        // подменять окно самой модели.
        return mkRes({
          model_info: {
            "general.architecture": "gemma4",
            "gemma4.context_length": 131072,
            "gemma4.audio.context_length": 512,
          },
          capabilities: ["completion", "vision"],
        });
      }
      return mkRes({
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 },
        parameters: 'stop "<|im_end|>"\nnum_ctx 8192',
        capabilities: ["completion", "tools"],
      });
    };
    const settings = { provider: "ollama", ollamaUrl: "http://localhost:11434", model: "qwen3:4b" };

    await test("ollama: окно модели берётся из POST /api/show и кэшируется", async () => {
      assert.strictEqual(await core.modelWindow(settings, "qwen3:4b"), 32768, "окно модели не прочитано");
      assert.strictEqual(await core.modelWindow(settings, "qwen3:4b"), 32768, "повторный вызов сломался");
      const shows = calls.filter((c) => /\/api\/show$/.test(c.url));
      assert.strictEqual(shows.length, 1, "окно спрашивается заново на каждый раунд: " + shows.length);
      assert.strictEqual(shows[0].method, "POST", "/api/show вызван не методом POST");
      const info = await core.ollamaModelInfo(settings, "qwen3:4b");
      assert.strictEqual(info.tools, true, "возможность tools не прочитана");
      assert.strictEqual(info.vision, false, "приписана лишняя возможность vision");
      assert.strictEqual(info.window, 32768, "окно перебито значением num_ctx из Modelfile");
      // Сервер без capabilities: про инструменты мы НЕ знаем — ложное предупреждение недопустимо.
      const legacy = await core.ollamaModelInfo(settings, "legacy:7b");
      assert.strictEqual(legacy.window, 4096, "окно старой сборки не прочитано");
      assert.strictEqual(legacy.known, false, "отсутствие capabilities принято за «инструментов нет»");
      // Окно модели не подменяется окном подсистемы (аудио/энкодер).
      const mm = await core.ollamaModelInfo(settings, "multimodal:8b");
      assert.strictEqual(mm.window, 131072, "окно модели подменено окном подсистемы: " + mm.window);
      assert.strictEqual(mm.vision, true, "возможность vision не прочитана");
    });

    await test("ollama: num_ctx = нужный бюджет, но не больше окна модели", () => {
      assert.strictEqual(core.ollamaNumCtx(14000, 32768), 18096, "num_ctx не покрывает бюджет с запасом");
      assert.strictEqual(core.ollamaNumCtx(14000, 0), 18096, "без окна num_ctx не посчитан");
      assert.strictEqual(core.ollamaNumCtx(40000, 8192), 8192, "num_ctx превысил окно модели");
      assert.strictEqual(core.ollamaNumCtx(0, 8192), 0, "без бюджета затёрт дефолт модели");
      assert.strictEqual(core.ollamaNumCtx(null, 0), 0, "пустой бюджет дал num_ctx");
    });

    await test("ollama: запрос несёт num_ctx и keep_alive, ведущий system склеен", () => {
      const prompt = core.SYSTEM_PROMPT;
      const req = core.buildChatRequest(settings, {
        model: "qwen3:4b",
        messages: [
          { role: "system", content: prompt },
          { role: "system", content: '=== СПРАВОЧНИК АГЕНТА: "browser" ===\nБыстрый путь' },
          { role: "user", content: "привет" },
        ],
        tools: [],
        numCtxBudget: 14000,
        modelWindow: 32768,
      });
      assert.ok(/\/api\/chat$/.test(req.url), "не нативный путь Ollama: " + req.url);
      const body = JSON.parse(req.body);
      assert.deepStrictEqual(body.options, { num_ctx: 18096 }, "num_ctx не ушёл в запрос");
      assert.ok(body.keep_alive, "keep_alive не ушёл: модель выгружалась бы между раундами");
      const sysMsgs = body.messages.filter((m) => m.role === "system");
      assert.strictEqual(sysMsgs.length, 1, "в Ollama ушло несколько system: " + sysMsgs.length);
      assert.ok(sysMsgs[0].content.indexOf("СПРАВОЧНИК АГЕНТА") !== -1, "справочник потерялся");
      const plain = JSON.parse(
        core.buildChatRequest(settings, { model: "qwen3:4b", messages: [{ role: "user", content: "привет" }], tools: [] }).body
      );
      assert.strictEqual(plain.options, undefined, "num_ctx ушёл без бюджета — дефолт модели затёрт");
    });

    await test("ollama: бюджет не может оказаться больше реального окна модели", () => {
      assert.ok(/let modelWin = 0;/.test(mainSrc), "окно модели не сохраняется для запроса");
      assert.ok(/Math\.min\(3000, modelWin\)/.test(mainSrc), "нижний предел бюджета не ограничен окном");
      // Запрос собирается в src/run-round.js (часть 17), и бюджет с окном модели
      // берутся там ЖИВЫМИ значениями: копия застыла бы на старом числе, и после
      // переполнения контекста история резалась бы по прежнему бюджету.
      const roundSrc = fs.readFileSync(path.join(ROOT, "src", "run-round.js"), "utf8");
      assert.ok(/numCtxBudget: getBudget\(\)/.test(roundSrc), "бюджет не передан в buildChatRequest");
      assert.ok(/modelWindow: getModelWindow\(\)/.test(roundSrc), "окно не передано в buildChatRequest");
      assert.ok(/getBudget: \(\) => budget/.test(mainSrc) && /getModelWindow: \(\) => modelWin/.test(mainSrc),
        "прогон не отдаёт бюджет и окно модели живыми значениями");
      assert.ok(/ollamaInfo\.known && !ollamaInfo\.tools/.test(mainSrc), "нет проверки поддержки инструментов у модели");
      assert.ok(/noTools: noTools,/.test(roundSrc), "флаг noTools не доходит до сборки запроса");
      assert.ok(
        /budget = windowBudget\(provider, budget, modelWin, \{ local: localEndpoint \}\);/.test(mainSrc),
        "бюджет не считается от окна модели"
      );
      assert.ok(mainSrc.indexOf("budget - 12000") === -1, "жёсткий резерв 12 000 вернулся: на локальном окне он срежет все группы");
    });
    await test("ollama: бюджет берётся от окна модели, а не от облачного потолка", () => {
      // Локальные токены бесплатны: платим памятью (KV-кэш) и временем, поэтому потолок — окно.
      const cloud = core.contextBudget("ollama", "qwen3:4b");
      assert.strictEqual(cloud, 14000, "изменился запасной бюджет на случай молчащего сервера");
      // Окно 40k отдаётся целиком, минус резерв на ответ: прежние «32 768» были не
      // потолком модели, а нашей осторожностью и срезали окно у больших моделей.
      assert.strictEqual(core.windowBudget("ollama", cloud, 40960), 36864, "окно 40k не использовано");
      assert.strictEqual(core.windowBudget("ollama", cloud, 8192), 4096, "окно 8k не учтено");
      // Модель с окном 128k больше не ужимается вчетверо раньше времени: пределами
      // остаются окно модели и общий потолок бюджета (400k, как и просили).
      assert.strictEqual(core.windowBudget("ollama", cloud, 131072), 126976, "окно 128k не использовано");
      assert.strictEqual(core.windowBudget("ollama", cloud, 2000000), 400000, "потолок бюджета не общий с облаком");
      // Окно меньше резерва на ответ: отдаём всё окно, но не больше него.
      assert.strictEqual(core.windowBudget("ollama", cloud, 2048), 2048, "бюджет превысил окно модели");
      // Окно неизвестно (сервер молчит) — поведение прежнее.
      assert.strictEqual(core.windowBudget("ollama", cloud, 0), 14000, "без окна бюджет потерян");
      // У облака бюджет про деньги — он остаётся потолком.
      assert.strictEqual(core.windowBudget("openai", 50000, 131072), 50000, "облачный потолок превышен");
      assert.strictEqual(core.windowBudget("openai", 50000, 8192), 4096, "малое окно у облака не учтено");
    });

    await test("роутер: на локальном окне группы помещаются (на прежних 14 000 — нет)", () => {
      const baseCount = core.routeTools({ text: "" }).tools.length;
      const base = core.routeTools({ text: "" }).tokens;
      const sys = core.estimateTokens(core.SYSTEM_PROMPT);
      const ask = { text: "открой вк и прочитай список диалогов", roleGroups: ["browser"] };
      // Потолок схем считает ядро (routerMaxTokens) — тест зовёт ЕГО, а не свою копию
      // формулы: иначе поломка самой формулы осталась бы незамеченной.
      const pick = (budget) =>
        core.routeTools(Object.assign({ maxTokens: core.routerMaxTokens(budget, sys, base) }, ask));
      const now = pick(core.windowBudget("ollama", 14000, 40960));
      assert.ok(now.groups.indexOf("browser") >= 0, "на окне 40k группа не включается: " + JSON.stringify(now.groups));
      assert.ok(now.tools.length > baseCount, "набор схем не вырос: " + now.tools.length + " из " + baseCount);
      // Дефект воспроизводится на том же честном расчёте, но с прежним бюджетом 14 000:
      // от окна после промпта и истории остаётся ~30 токенов, и групп не помещается ни одна.
      assert.strictEqual(pick(14000).groups.length, 0, "прежний бюджет 14 000 больше не воспроизводит дефект — тест перестал быть о том");
      // И граница: как только окна хватает на промпт, историю и вес группы, группа
      // обязана достаться. Окно НЕ вбиваем числом: длина промпта (и, значит, порог)
      // меняется от добавления инструмента, и «22 000» краснело бы на верной правке
      // (урок части 49: сторож держит смысл, а не вид). Жёсткий резерв истории
      // 12 000 всё равно ловится: тогда браузерная группа не влезает и в потолок ниже.
      let win = 8000;
      while (win < 60000 && pick(win).groups.indexOf("browser") < 0) win += 250;
      assert.ok(win <= 30000, "браузерная группа не влезает и в большое окно (нашли на " + win + ")");
      assert.ok(pick(win).groups.indexOf("browser") >= 0, "при достаточном окне группа не влезает: " + win);
      assert.ok(pick(16000).groups.indexOf("browser") < 0, "без места под группу она всё же включилась: " + JSON.stringify(pick(16000).groups));
    });

    await test("модель без инструментов: вместо схем уходит текстовый каталог", () => {
      const tools = core.routeTools({ text: "" }).tools;
      const msgs = [{ role: "system", content: "СИСТЕМА" }, { role: "user", content: "привет" }];
      const off = JSON.parse(core.buildChatRequest(settings, { model: "qwen3:4b", messages: msgs, tools: tools }).body);
      assert.ok(Array.isArray(off.tools) && off.tools.length === tools.length, "обычной модели схемы перестали уходить");
      const on = JSON.parse(
        core.buildChatRequest(settings, { model: "qwen3:4b", messages: msgs, tools: tools, noTools: true }).body
      );
      assert.strictEqual(on.tools, undefined, "модели без инструментов всё ещё уходят схемы");
      const sys = on.messages.filter((m) => m.role === "system")[0].content;
      assert.ok(sys.indexOf("КАК ВЫЗЫВАТЬ ИНСТРУМЕНТЫ") !== -1, "протокол вызова не объяснён");
      assert.ok(sys.indexOf('\"name\"') !== -1, "формат блока JSON не показан");
      assert.strictEqual(sys.indexOf("СИСТЕМА"), 0, "системный промпт потерял начало");
      for (const t of tools) {
        assert.ok(sys.indexOf(t.function.name + "(") !== -1, "инструмент не попал в каталог: " + t.function.name);
      }
      // Каталог в разы легче JSON-схем: именно это делает узкое окно достижимым.
      assert.ok(
        core.estimateTokens(core.toolsAsText(tools)) * 3 < core.estimateTokens(JSON.stringify(tools)),
        "текстовый каталог не легче схем"
      );
      // Исходные сообщения не портим: они переиспользуются между раундами.
      assert.strictEqual(msgs[0].content, "СИСТЕМА", "текстовый протокол изменил исходные сообщения");
    });

    await test("ollama: обрыв ответа по лимиту вывода замечен (done_reason length)", async () => {
      const ndjson =
        JSON.stringify({ message: { role: "assistant", content: "Начало ответа, который " }, done: false }) + "\n" +
        JSON.stringify({ message: { role: "assistant", content: "оборвался" }, done: false }) + "\n" +
        JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "length", prompt_eval_count: 9000, eval_count: 512 }) + "\n";
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(ndjson));
          c.close();
        },
      });
      const texts = [];
      let cut = 0;
      await core.consumeProviderStream({
        response: { body: stream },
        provider: "ollama",
        onText: (t) => texts.push(t),
        onTruncated: () => {
          cut++;
        },
      });
      assert.strictEqual(cut, 1, "обрыв по лимиту вывода не замечен");
      assert.strictEqual(texts.join(""), "Начало ответа, который оборвался", "текст до обрыва потерян");
      const okStream = new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ message: { role: "assistant", content: "готово" }, done: true, done_reason: "stop" }) + "\n"
            )
          );
          c.close();
        },
      });
      let cut2 = 0;
      await core.consumeProviderStream({
        response: { body: okStream },
        provider: "ollama",
        onTruncated: () => {
          cut2++;
        },
      });
      assert.strictEqual(cut2, 0, "законченный ответ помечен обрывом");
    });

    await test("ollama: таймаут первого байта рассчитан на медленную локальную модель", () => {
      // Модель на CPU грузится и читает промпт минутами: облачные 90 с её убивают.
      const transportSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "provider-transport.js"), "utf8");
      assert.ok(/const localish = !!local \|\| provider === \"ollama\";/.test(transportSrc), "локальный таймаут привязан к имени семейства");
      assert.ok(/const firstMs = firstByteTimeoutMs \|\| \(localish \? 300000 : 90000\);/.test(transportSrc), "нет отдельного таймаута первого байта");
      assert.ok(/const idleMs = idleTimeoutMs \|\| \(localish \? 120000 : 60000\);/.test(transportSrc), "нет отдельного простоя");
    });

    await test("локальный сервер совместимого API: окно и потолок как у Ollama", () => {
      // Признак локальности — АДРЕС, а не имя семейства: LM Studio, vLLM, llama.cpp и g4f
      // говорят на OpenAI-совместимом API, но токены там свои, а сервер может быть медленным.
      assert.strictEqual(core.isLocalEndpoint({ provider: "ollama" }), true, "Ollama перестала считаться локальной");
      assert.strictEqual(core.isLocalEndpoint({ provider: "openai", openaiUrl: "http://localhost:1234/v1" }), true, "LM Studio на localhost считается облаком");
      assert.strictEqual(core.isLocalEndpoint({ provider: "openai", openaiUrl: "http://127.0.0.1:8080/v1" }), true, "llama.cpp на 127.0.0.1 считается облаком");
      assert.strictEqual(core.isLocalEndpoint({ provider: "openai", openaiUrl: "http://192.168.1.50:8000/v1" }), true, "сервер в домашней сети считается облаком");
      assert.strictEqual(core.isLocalEndpoint({ provider: "openai", openaiUrl: "https://api.deepseek.com/v1" }), false, "облако принято за локальный сервер");
      assert.strictEqual(core.isLocalEndpoint({ provider: "anthropic" }), false, "Anthropic принят за локальный сервер");
      // Потолок: у местного сервера платим памятью (KV-кэш), а не деньгами, поэтому
      // облачный потолок высокий (400k, как у Freebuff), а настоящий предел задаёт
      // окно САМОЙ модели — оно и обрезает бюджет, когда известно.
      const cloud = core.contextBudget("openai", "qwen3-4b");
      assert.strictEqual(cloud, 400000, "у совместимого API не облачный потолок 400k");
      // Локальный сервер и Ollama идут одним путём: настоящий предел — окно САМОЙ модели,
      // а потолок бюджета общий с облаком (400k).
      assert.strictEqual(core.windowBudget("openai", cloud, 40960, { local: true }), 36864, "локальное окно 40k не использовано");
      assert.strictEqual(core.windowBudget("openai", cloud, 40960), 36864, "окно модели не стало потолком бюджета");
      assert.strictEqual(core.windowBudget("openai", 50000, 131072, { local: true }), 126976, "окно 128k у местного сервера не использовано");
      assert.strictEqual(core.windowBudget("openai", 50000, 2000000, { local: true }), 400000, "потолок местного сервера разошёлся с облачным");
      assert.strictEqual(core.windowBudget("openai", cloud, 8192, { local: true }), 4096, "окно 8k у локального сервера не учтено");
      // окно неизвестно — бюджет не режем «на всякий случай»: у g4f и подобных
      // местных прокси окна большие, а переполнение ловит повтор с меньшим бюджетом.
      assert.strictEqual(core.windowBudget("openai", cloud, 0, { local: true }), cloud, "локальный сервер без окна потерял бюджет");
      // main.js: признак считается один раз и уходит во все три места.
      assert.ok(/const localEndpoint = isLocalEndpoint\(settings\);/.test(mainSrc), "признак локального сервера не считается в прогоне");
      assert.ok(
        /if \(modelWin > 0\) budget = windowBudget\(provider, budget, modelWin, \{ local: localEndpoint \}\);/.test(mainSrc),
        "бюджет для местного сервера посчитан как облачный"
      );
      const localFlags = (mainSrc.match(/local: localEndpoint,/g) || []).length;
      assert.strictEqual(localFlags, 2, "признак не дошёл до сжатия контекста и стрима: " + localFlags);
    });

    await test("modelWindow: окно локального сервера добирается его родными ручками", async () => {
      try {
        // LM Studio: в /v1/models окна нет, оно есть в /api/v0/models.
        const calls = [];
        global.fetch = async (url) => {
          const u = String(url);
          calls.push(u);
          if (/\/api\/v0\/models$/.test(u)) return { ok: true, status: 200, json: async () => ({ data: [{ id: "qwen3-4b", max_context_length: 40960 }] }) };
          if (/\/models$/.test(u)) return { ok: true, status: 200, json: async () => ({ data: [{ id: "qwen3-4b" }] }) };
          return { ok: false, status: 404, json: async () => ({}) };
        };
        const lm = await core.modelWindow({ provider: "openai", openaiUrl: "http://127.0.0.1:12341/v1" }, "qwen3-4b");
        assert.strictEqual(lm, 40960, "окно LM Studio не прочитано: " + lm);
        assert.ok(calls.some((u) => /\/api\/v0\/models$/.test(u)), "родная ручка LM Studio не спрошена");
        // llama.cpp: имя модели — путь к .gguf, окно отдаёт /props.
        global.fetch = async (url) => {
          const u = String(url);
          if (/\/props$/.test(u)) return { ok: true, status: 200, json: async () => ({ default_generation_settings: { n_ctx: 4096 } }) };
          if (/\/models$/.test(u)) return { ok: true, status: 200, json: async () => ({ data: [{ id: "ggml-org/Qwen3-4B-Q4_K_M.gguf" }] }) };
          return { ok: false, status: 404, json: async () => ({}) };
        };
        const lp = await core.modelWindow({ provider: "openai", openaiUrl: "http://localhost:8081/v1" }, "Qwen3-4B-Q4_K_M");
        assert.strictEqual(lp, 4096, "окно llama.cpp не прочитано: " + lp);
        // vLLM отдаёт окно прямо в /models ключом max_model_len.
        global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "Qwen/Qwen3-8B", max_model_len: 32768 }] }) });
        assert.strictEqual(await core.modelWindow({ provider: "openai", openaiUrl: "http://localhost:8002/v1" }, "Qwen/Qwen3-8B"), 32768, "окно vLLM не прочитано");
        // Облачный адрес родные ручки не трогает: лишние запросы к чужому серверу недопустимы.
        const cloudCalls = [];
        global.fetch = async (url) => {
          cloudCalls.push(String(url));
          return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat", context_length: 65536 }] }) };
        };
        assert.strictEqual(await core.modelWindow({ provider: "openai", openaiUrl: "https://api.example.com/v1" }, "deepseek-chat"), 65536, "окно облака не прочитано");
        assert.strictEqual(cloudCalls.filter((u) => /\/api\/v0\/models$|\/props$/.test(u)).length, 0, "к облачному серверу ушли локальные пробы");
      } finally {
        global.fetch = realFetch;
      }
    });

    await test("noTools у совместимых серверов: схем нет, каталог есть, картинка цела", () => {
      const tools = core.routeTools({ text: "" }).tools;
      const oa = { provider: "openai", openaiUrl: "http://localhost:1234/v1", model: "qwen3-4b" };
      const msgs = [{ role: "system", content: "СИСТЕМА" }, { role: "user", content: "привет" }];
      const off = JSON.parse(core.buildChatRequest(oa, { model: "qwen3-4b", messages: msgs, tools: tools }).body);
      assert.ok(Array.isArray(off.tools) && off.tools.length === tools.length, "у совместимого сервера схемы пропали");
      const on = JSON.parse(core.buildChatRequest(oa, { model: "qwen3-4b", messages: msgs, tools: tools, noTools: true }).body);
      assert.strictEqual(on.tools, undefined, "серверу без инструментов всё ещё уходят схемы");
      assert.ok(on.messages[0].content.indexOf("КАК ВЫЗЫВАТЬ ИНСТРУМЕНТЫ") !== -1, "текстового протокола нет");
      // Anthropic: каталог дописывается В КОНЕЦ system — статичный префикс промпта
      // остаётся началом, иначе сорвалась бы точка кэша промпта.
      const anBody = JSON.parse(
        core.buildChatRequest({ provider: "anthropic", model: "claude-sonnet-4" }, {
          model: "claude-sonnet-4",
          messages: msgs,
          tools: tools,
          noTools: true,
          staticSystem: "СИСТЕМА",
        }).body
      );
      assert.strictEqual(anBody.tools, undefined, "Anthropic всё ещё получает схемы при noTools");
      const anSys = Array.isArray(anBody.system) ? anBody.system.map((b) => b.text || "").join("") : String(anBody.system || "");
      assert.ok(anSys.indexOf("КАК ВЫЗЫВАТЬ ИНСТРУМЕНТЫ") !== -1, "каталог не доехал до Anthropic");
      assert.strictEqual(anSys.indexOf("СИСТЕМА"), 0, "статичный префикс промпта сдвинулся — кэш сорвётся");
      // content-массив (текст + картинка) не превращается в строку: картинка бы потерялась.
      const mediaMsgs = [
        { role: "system", content: [{ type: "text", text: "СИС" }] },
        { role: "user", content: [{ type: "text", text: "что тут?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      ];
      const media = JSON.parse(core.buildChatRequest(oa, { model: "qwen3-4b", messages: mediaMsgs, tools: tools, noTools: true }).body);
      const sysParts = media.messages[0].content;
      assert.ok(Array.isArray(sysParts), "content-массив системы превращён в строку");
      assert.strictEqual(sysParts[0].text, "СИС", "текст системы изменился");
      assert.strictEqual(sysParts.length, 2, "к системному сообщению добавлено не одну часть: " + sysParts.length);
      assert.ok(String(sysParts[1].text).indexOf("КАК ВЫЗЫВАТЬ") !== -1, "каталог не дописан к частям сообщения");
      assert.strictEqual(media.messages[1].content.length, 2, "картинка потерялась по дороге");
    });

    await test("настройка «модель без инструментов» доходит от галочки до запроса", () => {
      const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
      const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
      const ctxSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "context-window.js"), "utf8");
      assert.ok(htmlSrc.indexOf('id="s-no-tools-model"') !== -1, "галочки нет в настройках");
      assert.ok(/^    noToolsModel: false,/m.test(appSrc), "у настройки нет значения по умолчанию");
      assert.ok(/if \(\$\("s-no-tools-model"\)\) \$\("s-no-tools-model"\)\.checked = !!getSettings\(\)\.noToolsModel;/.test(uiFile("settings-panel.js")), "галочка не читается из настроек");
      assert.ok(/if \(\$\("s-no-tools-model"\)\) getSettings\(\)\.noToolsModel = !!\$\("s-no-tools-model"\)\.checked;/.test(uiFile("settings-panel.js")), "галочка не сохраняется");
      assert.ok(/const noTools = noToolsDetected \|\| !!settings\.noToolsModel;/.test(mainSrc), "настройка не влияет на протокол вызовов");
      // Сжатие контекста тоже знает про местный сервер: на CPU это минуты, а не 30 с.
      assert.ok(/const slowLocal = !!\(o\.local \|\| provider === "ollama"\);/.test(ctxSrc), "сжатие у местного сервера уходит в облачный таймаут");
      assert.ok(/local: localServer,/.test(ctxSrc), "признак не доходит до самого сжатия");
    });
  } finally {
    global.fetch = realFetch;
  }
}

// ── Сохранённые OpenAI-подключения (этап 3.8, часть 2) ─────────────────────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ: имя подключения по адресу,
// сохранение нового и обновление выбранного, удаление с подтверждением,
// перерисовка списка и перенос значений в поля при выборе.
async function testOpenaiProfiles() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "openai-profiles.js"), "utf8");

  await test("подключения: сохранение, выбор и удаление работают, как раньше", () => {
    // 1. Модуль на месте, подключён до app.js, отдаётся телефону.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="openai-profiles.js"');
    assert.ok(iTag > 0, "разметка не грузит openai-profiles.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "openai-profiles.js подключён после app.js");
    assert.ok(/"openai-profiles\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")), "мост не отдаёт модуль телефону");
    const appSrc = uiFile("app.js");
    for (const gone of ["function renderOpenaiProfiles", "function applyOpenaiProfile", "function saveOpenaiProfileFromFields", "function deleteOpenaiProfile", "function profileNameFromUrl", "function openaiProfilesArr"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код подключений остался в app.js: " + gone);
    }
    // Границы модуля: чужое состояние — только через deps.
    for (const name of ["chatsData", "session", "streaming", "msgEls", "currentPreset", "cachedModels", "projectDir"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }

    // 2. Среда: поля настроек, сообщения, подтверждение удаления.
    const fields = {
      "s-openai-profile": { value: "__new__", innerHTML: "", children: [] },
      "s-openai-url": { value: "" },
      "s-openai-key": { value: "" },
      "s-openai-model": { value: "" },
      "s-openai-project": { value: "" },
    };
    const msgs = [];
    let saved = 0;
    let askAnswer = true;
    const settings = { openaiProfiles: [], openaiActiveProfile: "" };
    const options = () => fields["s-openai-profile"].children.filter((c) => /option/.test(c.tag || ""));
    const sandbox = {
      module: { exports: {} },
      window: {},
      self: {},
      console: { log() {}, warn() {}, error() {} },
      confirm: () => askAnswer,
      document: {
        createElement: (tag) => ({ tag, value: "", textContent: "" }),
        querySelectorAll: () => [],
      },
    };
    const vm = require("vm");
    vm.runInNewContext(src, sandbox, { filename: "openai-profiles.js" });
    // Заглушка списка: appendChild складывает опции, innerHTML = "" чистит.
    const sel = fields["s-openai-profile"];
    Object.defineProperty(sel, "innerHTML", { set() { sel.children.length = 0; }, get() { return ""; } });
    sel.appendChild = (o) => sel.children.push(o);
    const api = sandbox.module.exports({
      $: (id) => fields[id] || null,
      uid: (() => { let n = 0; return () => "id" + ++n; })(),
      getSettings: () => settings,
      PRESETS: { deepseek: { url: "https://api.deepseek.com" }, openai: { url: "https://api.openai.com/v1" } },
      persistSettings: () => { saved++; },
      setSettingsMsg: (t, isErr) => msgs.push({ t, isErr: !!isErr }),
    });

    // 3. Имя по адресу: обычный домен, без www, и честная замена при мусоре.
    assert.strictEqual(api.profileNameFromUrl("https://api.deepseek.com/v1"), "api.deepseek.com");
    assert.strictEqual(api.profileNameFromUrl("https://www.openai.com/v1"), "openai.com");
    assert.strictEqual(api.profileNameFromUrl("не-адрес"), "OpenAI");

    // 4. Сохранение нового подключения: имя по адресу, ключ и модель записаны.
    fields["s-openai-url"].value = "https://api.deepseek.com/v1";
    fields["s-openai-key"].value = "ключ-1";
    fields["s-openai-model"].value = "deepseek-chat";
    fields["s-openai-project"].value = "проект";
    api.saveFromFields();
    assert.strictEqual(settings.openaiProfiles.length, 1, "подключение не сохранено");
    assert.strictEqual(settings.openaiProfiles[0].name, "api.deepseek.com", "имя взято не по адресу");
    assert.strictEqual(settings.openaiProfiles[0].apiKey, "ключ-1", "ключ не записан");
    assert.strictEqual(saved, 1, "настройки не сохранены на диск");
    assert.ok(options().length === 2, "в списке должно быть «Новое подключение» и сохранённое");

    // 5. Сохранение сразу после сохранения ОБНОВЛЯЕТ выбранное, а не плодит копии:
    //    после записи подключение становится активным, и список показывает его же.
    fields["s-openai-key"].value = "ключ-1-правка";
    api.saveFromFields();
    assert.strictEqual(settings.openaiProfiles.length, 1, "повторное сохранение создало лишнее подключение");
    assert.strictEqual(settings.openaiProfiles[0].apiKey, "ключ-1-правка", "правка не дошла до подключения");

    // 6. А вот выбранное «Новое подключение» с тем же адресом получает номер —
    //    два ключа одного сервиса не сливаются в одну запись.
    fields["s-openai-profile"].value = "__new__";
    fields["s-openai-key"].value = "ключ-2";
    api.saveFromFields();
    assert.deepStrictEqual(settings.openaiProfiles.map((p) => p.name), ["api.deepseek.com", "api.deepseek.com #2"], "два ключа одного сервиса слились");
    assert.strictEqual(settings.openaiActiveProfile, "id2", "активным не стало новое подключение");

    // 7. Обновление ВЫБРАННОГО из списка подключения (а не создание нового).
    fields["s-openai-profile"].value = "id1";
    fields["s-openai-key"].value = "ключ-1-новый";
    api.saveFromFields();
    assert.strictEqual(settings.openaiProfiles.length, 2, "обновление создало лишнее подключение");
    assert.strictEqual(settings.openaiProfiles[0].apiKey, "ключ-1-новый", "ключ не обновился");

    // 8. Пустой адрес: отказ словами, без записи.
    fields["s-openai-url"].value = "";
    const before = msgs.length;
    api.saveFromFields();
    assert.ok(msgs.length > before && msgs[msgs.length - 1].isErr, "пустой адрес не объяснён");
    assert.strictEqual(settings.openaiProfiles.length, 2, "подключение с пустым адресом всё равно сохранилось");

    // 9. Выбор подключения переносит значения в поля и подсказывает пресет.
    api.apply("id2");
    assert.strictEqual(fields["s-openai-url"].value, "https://api.deepseek.com/v1", "адрес не перенесён");
    assert.strictEqual(fields["s-openai-key"].value, "ключ-2", "ключ не перенесён");
    assert.strictEqual(fields["s-openai-model"].value, "deepseek-chat", "модель не перенесена");
    assert.strictEqual(settings.openaiActiveProfile, "id2", "активное подключение не переключилось");
    assert.ok(/выбрано/.test(msgs[msgs.length - 1].t), "выбор никак не подтверждён");

    // 10. Удаление спрашивает подтверждение и не удаляет по отказу.
    askAnswer = false;
    fields["s-openai-profile"].value = "id2";
    api.remove();
    assert.strictEqual(settings.openaiProfiles.length, 2, "отказ в подтверждении всё равно удалил");
    askAnswer = true;
    api.remove();
    assert.deepStrictEqual(settings.openaiProfiles.map((p) => p.id), ["id1"], "подключение не удалено");
    assert.strictEqual(settings.openaiActiveProfile, "", "активным осталось удалённое подключение");
    assert.ok(options().length === 2, "список не перерисован после удаления");

    // 11. «Новое подключение» удалять нельзя — это подсказка, а не запись.
    fields["s-openai-profile"].value = "__new__";
    const beforeMsg = msgs.length;
    api.remove();
    assert.ok(msgs.length > beforeMsg && msgs[msgs.length - 1].isErr, "удаление «Нового подключения» прошло молча");

    // 12. Негативный контроль зависимости: забытый DOM падает понятной ошибкой.
    const noDeps = sandbox.module.exports({ uid: () => "x", getSettings: () => settings });
    assert.throws(() => noDeps.render(), /\$|is not a function/, "без $ модуль не упал");
  });
}

// ── Разрез транспорта, часть 1: подключение к провайдеру ────────────────────
// Модуль обязан собирать адрес, ключ и заголовки БЕЗ агента и без настроек
// приложения: всё приходит аргументом. Если он дёрнет ядро, «самостоятельность»
// окажется мнимой, и правка модуля уронит приложение.
async function testProviderConfig() {
  const pc = require(path.join(ROOT, "src", "renderer", "provider-config.js"));

  await test("подключение к провайдеру: адрес и ключ собираются без агента", () => {
    // Адреса: свой URL побеждает, хвостовой слэш убирается, /v1 у Anthropic не дублируется.
    assert.strictEqual(pc.baseFor("ollama", {}), pc.DEFAULT_BASES.ollama, "адрес Ollama по умолчанию потерян");
    assert.strictEqual(pc.baseFor("openai", {}), pc.DEFAULT_BASES.openai, "адрес OpenAI-совместимых по умолчанию потерян");
    assert.strictEqual(pc.baseFor("openai", { openaiUrl: "https://свой.прокси/v1/" }), "https://свой.прокси/v1", "свой адрес с хвостовым слэшем не приведён");
    assert.strictEqual(pc.baseFor("openai", { externalUrl: "https://старое/v1" }), "https://старое/v1", "старое поле externalUrl больше не читается");
    assert.strictEqual(pc.baseFor("anthropic", { anthropicUrl: "https://api.anthropic.com/v1" }), "https://api.anthropic.com", "/v1 у Anthropic удвоится");
    assert.strictEqual(pc.baseFor("anthropic", { anthropicUrl: "https://api.anthropic.com" }), "https://api.anthropic.com", "адрес Anthropic изменён без нужды");

    // Ключи: у каждого семейства свой, с откатом на общий.
    assert.strictEqual(pc.apiKeyFor("anthropic", { anthropicApiKey: "a" }), "a", "ключ Anthropic потерян");
    assert.strictEqual(pc.apiKeyFor("openai", { openaiApiKey: "o", apiKey: "общий" }), "o", "ключ OpenAI потерян");
    assert.strictEqual(pc.apiKeyFor("openai", { apiKey: "общий" }), "общий", "общий ключ больше не подхватывается");
    assert.strictEqual(pc.apiKeyFor("ollama", { apiKey: "общий" }), "", "Ollama получила чужой ключ");

    // Заголовки: у каждого семейства свой набор.
    const ollama = pc.apiHeaders("ollama", "", false, null);
    assert.strictEqual(ollama.Authorization, undefined, "запрос к Ollama уходит с Authorization");
    assert.strictEqual(ollama["Content-Type"], "application/json", "нет Content-Type");
    const anth = pc.apiHeaders("anthropic", "k", false, null);
    assert.strictEqual(anth["x-api-key"], "k", "нет ключа Anthropic");
    assert.strictEqual(anth["anthropic-version"], "2023-06-01", "нет версии Anthropic API");
    assert.strictEqual(anth["anthropic-dangerous-direct-browser-access"], undefined, "браузерный заголовок ушёл из десктопа");
    assert.strictEqual(pc.apiHeaders("anthropic", "k", true, null)["anthropic-dangerous-direct-browser-access"], "true", "из браузера запрос к Anthropic не пройдёт");
    assert.strictEqual(pc.apiHeaders("openai", "k", false, null).Authorization, "Bearer k", "нет Bearer-заголовка");
    assert.strictEqual(pc.apiHeaders("openai", "k", false, { "OpenAI-Project": "b1g" })["OpenAI-Project"], "b1g", "каталог Yandex не доходит до запроса");
    assert.strictEqual(pc.apiHeaders("openai", "", false, null).Authorization, undefined, "пустой ключ превратился в «Bearer »");

    // Каталог (папка) Yandex и разбор аргументов вызова инструмента.
    assert.strictEqual(pc.projectHeader({}), null, "пустой каталог превратился в заголовок");
    assert.deepStrictEqual(pc.projectHeader({ openaiProject: " b1g " }), { "OpenAI-Project": "b1g" }, "каталог не обрезан");
    assert.deepStrictEqual(pc.jsonArgs({ a: 1 }), { a: 1 }, "объект аргументов испорчен");
    assert.deepStrictEqual(pc.jsonArgs('{"a":1}'), { a: 1 }, "строка аргументов не разобрана");
    assert.deepStrictEqual(pc.jsonArgs("не json"), { raw: "не json" }, "битая строка аргументов потеряна");
    assert.deepStrictEqual(pc.jsonArgs(null), {}, "пустые аргументы дали не объект");

    // Идентификатор вызова уникален: по нему провайдер сопоставляет ответ и запрос.
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(pc.genCallId());
    assert.strictEqual(ids.size, 200, "идентификаторы вызовов повторяются");
    assert.ok([...ids][0].startsWith("call_"), "идентификатор вызова без префикса");

    // Маршрут «Провайдер:модель» разбирается только для известных провайдеров G4F.
    assert.deepStrictEqual(pc.splitG4fRoute("DeepInfra:deepseek-ai/DeepSeek-V3.1"), { provider: "DeepInfra", model: "deepseek-ai/DeepSeek-V3.1" }, "маршрут G4F не разобран");
    assert.strictEqual(pc.splitG4fRoute("openai/gpt-4o:free"), null, "чужое двоеточие принято за маршрут G4F");
    assert.strictEqual(pc.splitG4fRoute("DeepInfra:"), null, "пустая модель принята за маршрут");
    assert.ok(pc.G4F_PROVIDERS.length > 10, "реестр провайдеров G4F опустел");
  });

  await test("подключение к провайдеру: ошибка читается и объясняется", async () => {
    // Тело ответа: из JSON берём причину, а не сырой объект.
    const json = await pc.readApiError({ text: async () => JSON.stringify({ error: { message: "API key not valid" } }) });
    assert.ok(/API key not valid/.test(json), "причина из JSON не извлечена: " + json);
    // Обёртку {"error": {...}} разворачиваем: человеку нужна причина, а не конверт.
    assert.ok(!/"error"/.test(json), "в текст ошибки попала обёртка error: " + json);
    assert.ok(!/\[object/.test(json), "в текст ошибки попал объект вместо текста: " + json);
    const plain = await pc.readApiError({ text: async () => "ошибка шлюза" });
    assert.strictEqual(plain, "ошибка шлюза", "обычный текст потерян");
    // HTML-страница шлюза вместо JSON: в текст уходит короткая причина, а не теги.
    const cf = await pc.readApiError({
      text: async () =>
        "<!DOCTYPE html><html><head><title>api.example.com | 524: A timeout occurred</title></head><body><p>Error 524</p></body></html>",
    });
    assert.ok(/HTML-страница вместо JSON/.test(cf), "HTML-страница шлюза не распознана: " + cf.slice(0, 120));
    assert.ok(/524: A timeout occurred/.test(cf), "из страницы не взят заголовок с кодом: " + cf);
    assert.strictEqual(cf.indexOf("<"), -1, "в текст ошибки уехали теги: " + cf.slice(0, 120));
    assert.ok(cf.length < 300, "объяснение длиннее самой страницы: " + cf.length);
    const long = await pc.readApiError({ text: async () => "x".repeat(5000) });
    assert.strictEqual(long.length, 600, "длинное тело не обрезано: " + long.length);
    const broken = await pc.readApiError({ text: async () => { throw new Error("тело уже прочитано"); } });
    assert.strictEqual(broken, "", "нечитаемое тело уронило разбор ошибки");

    // Лимит Groq объясняется понятными словами — и только когда это правда.
    const groq = pc.friendlyRateLimitError(413, "reduce your message size", { openaiUrl: "https://api.groq.com/openai/v1" });
    assert.ok(groq && /Groq/.test(groq) && /Dev Tier/.test(groq), "лимит Groq не объяснён: " + groq);
    assert.strictEqual(pc.friendlyRateLimitError(413, "reduce your message size", { openaiUrl: "https://api.openai.com/v1" }), null, "чужому провайдеру приписаны лимиты Groq");
    assert.strictEqual(pc.friendlyRateLimitError(429, "слишком много запросов", { openaiUrl: "https://api.groq.com/openai/v1" }), null, "обычный 429 объяснён как токенный лимит Groq");

    // Классификация: меняет ли ошибка ключ.
    assert.deepStrictEqual(pc.classifyKeyError("API error 401 invalid api key"), { key: true, reason: "auth", cooldownMs: 600000 }, "401 не распознан");
    assert.deepStrictEqual(pc.classifyKeyError("API error 402 insufficient balance"), { key: true, reason: "quota", cooldownMs: 300000 }, "402 не распознан");
    assert.deepStrictEqual(pc.classifyKeyError("API error 429 rate limit exceeded"), { key: true, reason: "rate", cooldownMs: 60000 }, "429 не распознан");
    assert.strictEqual(pc.classifyKeyError("API error 400 invalid request").key, false, "ошибка запроса принята за ошибку ключа — агент зря сменит ключ");
    assert.strictEqual(pc.classifyKeyError("").key, false, "пустая ошибка признана ключевой");

    // Сколько ждать: заголовок, текст провайдера, частота запросов.
    assert.strictEqual(pc.rateLimitInfo(429, { get: (k) => (k === "retry-after" ? "12" : null) }, "").retryMs, 12000, "Retry-After не прочитан");
    assert.strictEqual(pc.rateLimitInfo(429, { get: () => null }, "Please retry in 12.3s").retryMs, 12300, "пауза из текста не прочитана");
    const rpm = pc.rateLimitInfo(429, { get: () => null }, "Maximum 8 requests within 1 minutes");
    assert.strictEqual(rpm.rpm, 8, "частота из «within 1 minutes» не разобрана: " + JSON.stringify(rpm));
    assert.strictEqual(rpm.retryMs, 60000, "пауза взята не по окну лимита: " + rpm.retryMs);
    assert.strictEqual(pc.rateLimitInfo(429, { get: (k) => (k === "retry-after" ? "9999" : null) }, "").retryMs, 120000, "пауза не ограничена сверху");

    // Держатель темпа: расставляет запросы сам, чтобы 429 вообще не случался.
    const lim = pc.createRateLimiter();
    assert.strictEqual(lim.pendingMs(), 0, "новый держатель темпа что-то ждёт");
    assert.strictEqual(await lim.take(), 0, "первый запрос ждал напрасно");
    lim.note({ rpm: 600 }); // 600 запросов в минуту → 100 мс между запросами
    await lim.take(); // этот ещё не ждёт: темп ставится на следующий запрос
    assert.ok(lim.pendingMs() > 0, "частота запомнена, но следующий запрос уйдёт сразу");
    const waited = await lim.take();
    assert.ok(waited > 0, "третий запрос ушёл без паузы: " + waited);
    // После 429 держатель темпа ждёт время, названное провайдером.
    const after429 = pc.createRateLimiter();
    after429.note({ retryMs: 5000 });
    assert.ok(after429.pendingMs() > 0, "пауза после 429 не выставлена");
    assert.strictEqual(pc.createRateLimiter().pendingMs(), 0, "держатели темпа делят состояние между собой");
    // Пауза ограничена сверху: провайдер может прислать абсурдное «жди час».
    const huge = pc.createRateLimiter();
    huge.note({ retryMs: 99999999 });
    assert.ok(huge.pendingMs() <= 120000, "пауза после 429 не ограничена: " + huge.pendingMs());

    // Текст исключения для интерфейса: причина, а не «[object Promise]».
    assert.strictEqual(pc.fmtError(new Error("сбой")), "сбой", "Error разобран неверно");
    assert.ok(/Promise/.test(pc.fmtError(Promise.resolve(1))), "забытый await не распознан: " + pc.fmtError(Promise.resolve(1)));
    assert.strictEqual(pc.fmtError("строка"), "строка", "строка испорчена");
    assert.strictEqual(pc.fmtError(null), "null", "пустая ошибка испорчена");
  });
}

// ── Разрез транспорта, часть 2: сообщения, запрос, стрим, окно модели ─────────
// Модуль получает ровно две вещи: подключение (адреса, ключи, заголовки) и таблицу
// инструментов агента. Если он дёрнет что-то ещё — «самостоятельность» мнимая, и
// правка транспорта уронит приложение.
async function testProviderTransport() {
  const makeTransport = require(path.join(ROOT, "src", "renderer", "provider-transport.js"));
  const config = require(path.join(ROOT, "src", "renderer", "provider-config.js"));
  const TOOLS = [
    {
      type: "function",
      function: {
        name: "runCommand",
        description: "Выполнить команду",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
    { type: "function", function: { name: "readFile", description: "Прочитать файл", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  ];
  const tr = makeTransport({ config, toolDefinitions: TOOLS });

  await test("транспорт: собирается без ядра — на подключении и таблице инструментов", () => {
    for (const n of ["buildChatRequest", "consumeProviderStream", "listModels", "modelWindow", "ollamaNumCtx", "messagesForProvider", "contentForProvider", "toolsForProvider"]) {
      assert.strictEqual(typeof tr[n], "function", "модуль не собрал " + n);
    }
    const msgs = [{ role: "system", content: "СИСТЕМА" }, { role: "user", content: "привет" }];

    // OpenAI-совместимые: путь, ключ, модель и схемы инструментов как есть.
    const oai = tr.buildChatRequest(
      { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" },
      { model: "gpt-4o", messages: msgs, tools: TOOLS }
    );
    assert.strictEqual(oai.url, "https://api.openai.com/v1/chat/completions", "адрес OpenAI-запроса неверен: " + oai.url);
    assert.strictEqual(oai.headers.Authorization, "Bearer k", "ключ не попал в заголовки");
    const oaiBody = JSON.parse(oai.body);
    assert.strictEqual(oaiBody.model, "gpt-4o", "модель не попала в запрос");
    assert.deepStrictEqual(oaiBody.tools.map((t) => t.function.name), ["runCommand", "readFile"], "таблица инструментов не разошлась по запросу");
    assert.strictEqual(oaiBody.messages[0].role, "system", "OpenAI-диалект: системный промпт потерян");

    // Anthropic: свой путь, свой заголовок ключа и свой диалект схем.
    const ant = tr.buildChatRequest(
      { provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k" },
      { model: "claude-sonnet-4", messages: msgs, tools: TOOLS }
    );
    assert.strictEqual(ant.url, "https://api.anthropic.com/v1/messages", "адрес Anthropic неверен: " + ant.url);
    assert.strictEqual(ant.headers["x-api-key"], "k", "ключ Anthropic не попал в заголовки");
    const antBody = JSON.parse(ant.body);
    assert.strictEqual(antBody.tools[0].input_schema.properties.command.type, "string", "Anthropic: схема инструмента не переведена");
    assert.strictEqual(antBody.tools[0].function, undefined, "Anthropic: ушёл OpenAI-формат инструмента (будет 400)");
    assert.ok(JSON.stringify(antBody.system).includes("СИСТЕМА"), "Anthropic: системный промпт не вынесен отдельно");

    // Ollama: нативный путь, стрим и удержание модели с нужным окном.
    const ol = tr.buildChatRequest(
      { provider: "ollama", ollamaUrl: "http://localhost:11434" },
      { model: "qwen3:4b", messages: msgs, tools: TOOLS, numCtxBudget: 14000, modelWindow: 32768 }
    );
    assert.strictEqual(ol.url, "http://localhost:11434/api/chat", "адрес Ollama неверен: " + ol.url);
    const olBody = JSON.parse(ol.body);
    assert.strictEqual(olBody.stream, true, "Ollama-запрос ушёл без стрима");
    assert.ok(olBody.keep_alive, "keep_alive не выставлен — модель выгружается между раундами");
    assert.ok(olBody.options && olBody.options.num_ctx > 14000, "num_ctx не покрывает бюджет: " + JSON.stringify(olBody.options));
    assert.deepStrictEqual(olBody.messages, msgs, "Ollama-диалект исказил сообщения");

    // Пустая таблица в opts — явный отказ от инструментов; без opts.tools берётся таблица модуля.
    const bare = JSON.parse(tr.buildChatRequest({ provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" }, { model: "gpt-4o", messages: msgs, tools: [] }).body);
    assert.deepStrictEqual(bare.tools, [], "явно пустая таблица инструментов не соблюдена");
    const stored = JSON.parse(tr.buildChatRequest({ provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" }, { model: "gpt-4o", messages: msgs }).body);
    assert.strictEqual(stored.tools.length, 2, "без opts.tools не взялась таблица модуля: " + JSON.stringify(stored.tools).slice(0, 80));
  });

  await test("транспорт: поток каждого семейства читается без ядра", async () => {
    const streamOf = (text) =>
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      });

    // OpenAI-совместимые: текст и вызов инструмента, аргументы приходят кусками.
    const oaiText = [];
    const oaiTools = [];
    await tr.consumeProviderStream({
      response: {
        body: streamOf(
          "data: " + JSON.stringify({ choices: [{ delta: { content: "Ответ" } }] }) + "\n" +
            "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "runCommand", arguments: '{"command":' } }] } }] }) + "\n" +
            "data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] }) + "\n" +
            "data: [DONE]\n"
        ),
      },
      provider: "openai",
      onText: (t) => oaiText.push(t),
      onToolCall: (tc) => oaiTools.push(tc),
    });
    assert.strictEqual(oaiText.join(""), "Ответ", "текст потока потерян: " + JSON.stringify(oaiText));
    assert.strictEqual(oaiTools.length, 1, "вызов инструмента не собран: " + oaiTools.length);
    assert.strictEqual(oaiTools[0].name, "runCommand", "имя вызова потеряно");
    assert.deepStrictEqual(oaiTools[0].args, { command: "ls" }, "аргументы не собраны из кусков: " + JSON.stringify(oaiTools[0].args));

    // Ollama: рассуждения отдельным полем, текст — отдельно.
    const think = [];
    const olText = [];
    await tr.consumeProviderStream({
      response: {
        body: streamOf(
          JSON.stringify({ message: { role: "assistant", thinking: "думаю", content: "" }, done: false }) + "\n" +
            JSON.stringify({ message: { role: "assistant", content: "готово" }, done: false }) + "\n" +
            JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 7, eval_count: 3 }) + "\n"
        ),
      },
      provider: "ollama",
      onText: (t) => olText.push(t),
      onThinking: (t) => think.push(t),
    });
    assert.strictEqual(think.join(""), "думаю", "рассуждения Ollama потеряны");
    assert.strictEqual(olText.join(""), "готово", "текст Ollama потерян");

    // Anthropic: вызов инструмента приходит кусками JSON (input_json_delta).
    const antTools = [];
    await tr.consumeProviderStream({
      response: {
        body: streamOf(
          "data: " + JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "readFile" } }) + "\n" +
            "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } }) + "\n" +
            "data: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"README.md"}' } }) + "\n" +
            "data: " + JSON.stringify({ type: "content_block_stop", index: 0 }) + "\n" +
            "data: " + JSON.stringify({ type: "message_stop" }) + "\n"
        ),
      },
      provider: "anthropic",
      onToolCall: (tc) => antTools.push(tc),
    });
    assert.strictEqual(antTools.length, 1, "Anthropic: вызов инструмента не собран: " + antTools.length);
    assert.strictEqual(antTools[0].name, "readFile", "Anthropic: имя вызова потеряно");
    assert.deepStrictEqual(antTools[0].args, { path: "README.md" }, "Anthropic: аргументы собраны неверно: " + JSON.stringify(antTools[0].args));
  });

  await test("транспорт: окно модели спрашивается у сервера и кэшируется", async () => {
    const real = global.fetch;
    const seen = [];
    try {
      global.fetch = async (url) => {
        seen.push(String(url));
        return {
          ok: true,
          json: async () => ({ model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 }, capabilities: ["completion", "tools"] }),
        };
      };
      const settings = { provider: "ollama", ollamaUrl: "http://localhost:11434", model: "qwen3:4b" };
      assert.strictEqual(await tr.modelWindow(settings, "qwen3:4b"), 32768, "окно модели не прочитано");
      assert.strictEqual(await tr.modelWindow(settings, "qwen3:4b"), 32768, "повторный вызов сломался");
      assert.strictEqual(seen.filter((u) => /\/api\/show$/.test(u)).length, 1, "окно спрашивается заново: " + seen.length);
      const info = await tr.ollamaModelInfo(settings, "qwen3:4b");
      assert.strictEqual(info.tools, true, "возможность tools не прочитана");
      assert.ok(tr.ollamaNumCtx(14000, 32768) > 14000, "num_ctx не покрывает бюджет с запасом");
      assert.ok(tr.ollamaNumCtx(14000, 0) > 14000, "num_ctx без окна не посчитан");
    } finally {
      global.fetch = real;
    }
  });
}

// ── Выбор провайдера G4F в настройках (src/renderer/g4f-panel.js, этап A, часть 2) ──
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ на заглушках настоящей разметки:
// список и поиск по провайдерам, выбор провайдера с подгрузкой его моделей, полный
// тест провайдера с логами в консоль, подбор живого порта g4f и связку с пресетами.
// Заглушка $ падает, если модуль ищет элемент, которого в разметке нет.
async function testG4fPanel() {
  const vm = require("vm");
  const src = uiFile("g4f-panel.js");
  const html = uiFile("index.html");
  const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // Классы из НАСТОЯЩЕЙ разметки: в окне часть полей уже скрыта (class="hidden"),
  // и заглушка обязана начинать с того же состояния, иначе проверка была бы ложной.
  const initialClasses = new Map();
  for (const tag of html.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(tag[0]);
    initialClasses.set(tag[1], new Set((cls ? cls[1] : "").split(/\s+/).filter(Boolean)));
  }

  // Заглушка ведёт className и classList одной коллекцией: в браузере это одно и то же.
  function mkEl(id) {
    let cls = new Set(initialClasses.get(id) || []);
    let markup = "";
    const node = {
      id: id, value: "", textContent: "", title: "", style: {}, dataset: {},
      children: [], onclick: null, focused: 0, listeners: {}, queried: {},
      get className() { return [...cls].join(" "); },
      set className(v) { cls = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
      get innerHTML() { return markup; },
      set innerHTML(v) { markup = String(v == null ? "" : v); if (!markup) node.children.length = 0; },
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
      },
      appendChild(c) { node.children.push(c); return c; },
      append(...cs) { cs.forEach((x) => node.children.push(x)); },
      addEventListener(t, fn) { node.listeners[t] = fn; },
      focus() { node.focused++; },
      querySelector(sel) {
        if (!node.queried[sel]) node.queried[sel] = mkEl(sel);
        return node.queried[sel];
      },
      querySelectorAll: () => [],
    };
    return node;
  }

  // Сборка модуля в песочнице: те же зависимости, что даёт оболочка. Встроенные
  // объекты отдаём внутрь, чтобы собранные модулем массивы имели обычный прототип.
  function buildG4f(world) {
    const o = world || {};
    const els = new Map();
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, mkEl(id));
      return els.get(id);
    };
    const calls = { hints: [], msgs: [], console: [], server: [], probed: [], tested: [] };
    const pending = [];
    let preset = o.preset || "g4f";
    let now = 1000000;
    const providers = o.providers || [
      { name: "default", desc: "авто-режим: G4F сам выберет провайдера и модель", rec: true, models: [] },
      { name: "DeepSeek", desc: "стабильный, без ключа", rec: true, models: ["DeepSeek-V3", "DeepSeek-R1"] },
      { name: "ChatGpt", desc: "чат-провайдер", rec: false, models: [] },
    ];
    const chips = (o.chips || ["deepseek", "g4f", "openai"]).map((p) => {
      const c = mkEl("chip-" + p);
      c.dataset.preset = p;
      return c;
    });
    let observerCb = null;
    const box = {
      module: { exports: {} }, self: {},
      console: { log() {}, warn() {}, error() {} },
      Object, Array, JSON, Date: { now: () => now }, Math, Promise, Error, String, RegExp,
      Number, Boolean, isNaN, parseInt, parseFloat, Set, Map,
      document: {
        getElementById: $,
        createElement: () => mkEl("created"),
        querySelectorAll: (sel) => (/\.chip\[data-preset\]/.test(sel) ? chips : []),
        addEventListener() {},
      },
    };
    // В браузере window — это и есть глобальный объект, поэтому наблюдатель виден и как
    // window.MutationObserver, и как MutationObserver: повторяем это в песочнице.
    box.window = box;
    box.MutationObserver = function (cb) { observerCb = cb; return { observe() {} }; };
    vm.runInNewContext(src, box, { filename: "g4f-panel.js" });
    assert.strictEqual(typeof box.module.exports, "function", "модуль не отдал фабрику");
    const panel = box.module.exports({
      $, isElectron: o.isElectron === undefined ? true : o.isElectron,
      G4F_PROVIDERS: providers,
      URL_INPUT: { openai: "s-openai-url" },
      api: Object.assign({
        g4fTest: async (a) => { calls.tested.push(a); return o.testResult || { log: [] }; },
        g4fProbe: async (a) => { calls.probed.push(a); return o.probeResult || { ok: true, base: "http://localhost:1337" }; },
      }, o.api || {}),
      getPreset: () => preset,
      getSettingsPanel: () => ({
        renderModelHints: (p, list) => calls.hints.push({ p: p, list: list || null }),
        setSettingsMsg: (text, err) => calls.msgs.push({ text: text, err: !!err }),
        requestModelsList: () => new Promise((resolve) => { pending.push(resolve); }),
      }),
      getSidePanel: () => ({
        switchSideTab: (t) => calls.console.push("tab:" + t),
        termAppend: (h) => calls.console.push(h),
      }),
      getProjectPanel: () => ({ escHtml: (s) => "[" + s + "]", esc: (s) => "{" + s + "}" }),
      getDevRun: () => ({ termServerAppend: (h) => calls.server.push(h) }),
    });
    return {
      panel, $, calls, providers, pending,
      chips: chips, exports: Object.keys(panel).sort(),
      setPreset: (p) => { preset = p; },
      advance: (ms) => { now += ms; },
      resolve: (list, idx) => { const i = idx === undefined ? pending.length - 1 : idx; const r = pending[i]; pending[i] = null; if (r) r(list); },
      observer: () => observerCb,
    };
  }
  const tick = () => new Promise((r) => setImmediate(r));
  // Объекты и массивы, собранные ВНУТРИ модуля, живут в своём окружении — сравниваем
  // их значения, приведя к обычным (иначе различие прототипов выдаётся за разницу данных).
  const plain = (v) => JSON.parse(JSON.stringify(v));

  await test("выбор провайдера G4F: модуль на месте, оболочка только собирает его", () => {
    const iTag = html.indexOf('src="g4f-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит g4f-panel.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "g4f-panel.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"g4f-panel\.js"/.test(bridge), "мост не отдаёт g4f-panel.js телефону");

    const appSrc = uiFile("app.js");
    for (const gone of [
      "function renderG4fProviderList", "function refreshG4fModels", "function testG4fProvider",
      "function probeG4fPort", "function syncG4fProviderBox", "function wireG4fProviderPicker",
      "let g4fProviderQuery", "let g4fProbeLastTs", "let g4fModelReqSeq",
    ]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код G4F остался в app.js: " + gone);
    }
    assert.ok(/G4fPanel\.wireG4fProviderPicker\(\);/.test(appSrc), "модуль не подключается к полям настроек");
    assert.ok(appSrc.indexOf("renderG4fProviderList: G4fPanel.renderG4fProviderList,") > 0, "настройки не получают список провайдеров");
    assert.ok(appSrc.indexOf("probeG4fPort: G4fPanel.probeG4fPort,") > 0, "настройки не получают подбор порта");

    // Границы модуля: общее состояние — только внедрением (пояснения в комментариях не считаем).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const bare of ["currentPreset", "settings"]) {
      assert.ok(!new RegExp("(^|[^\\w$.\"'])" + bare + "\\b").test(code), "модуль читает оболочку напрямую: " + bare);
    }
    for (const foreign of ["SettingsPanel.", "SidePanel.", "ProjectPanel.", "DevRun."]) {
      assert.ok(code.indexOf(foreign) === -1, "модуль зовёт " + foreign + " напрямую вместо get*()");
    }
    assert.ok(!/localStorage|\bwindow\.api\b/.test(code), "модуль лезет в чужие глобалы");

    // Проводка: панели объявлены НИЖЕ, поэтому внутрь идут только отложенные стрелки.
    const wiring = uiFind("  const G4fPanel = window.G4fPanel({", "\n  const uid = () =>").code;
    for (const dep of [
      "$: $,", "api: api,", "isElectron: isElectron,", "G4F_PROVIDERS: G4F_PROVIDERS,", "URL_INPUT: URL_INPUT,",
      "getPreset: () => currentPreset,", "getSettingsPanel: () => SettingsPanel,", "getSidePanel: () => SidePanel,",
      "getProjectPanel: () => ProjectPanel,", "getDevRun: () => DevRun,",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
  });

  await test("выбор провайдера G4F: список, поиск, выбор провайдера и его моделей", async () => {
    const env = buildG4f();
    assert.deepStrictEqual(env.exports, ["probeG4fPort", "renderG4fProviderList", "wireG4fProviderPicker"],
      "наружу торчит лишнее или чего-то не хватает: " + env.exports.join(", "));
    const list = env.$("g4f-provider-list");
    const status = env.$("g4f-provider-status");

    env.panel.renderG4fProviderList();
    assert.strictEqual(list.children.length, 3, "показаны не все провайдеры: " + list.children.length);
    assert.ok(/Провайдеров G4F: 3/.test(status.textContent), "итог по провайдерам не показан: " + status.textContent);
    assert.strictEqual(status.className, "gh-repos-status", "успешный итог помечен как ошибка");
    assert.ok(/★/.test(list.children[1].innerHTML) && /◆/.test(list.children[2].innerHTML), "стабильные провайдеры не отличаются значком");
    assert.ok(/\[DeepSeek\]/.test(list.children[1].innerHTML), "имя провайдера не погашено");
    assert.ok(/repo-test-btn/.test(list.children[1].innerHTML), "у провайдера нет кнопки теста");

    // Подсвечен ВЫБРАННЫЙ провайдер — по полю модели, а не «первый в списке».
    env.$("s-openai-model").value = "DeepSeek:DeepSeek-V3";
    env.panel.renderG4fProviderList();
    assert.ok(list.children[1].classList.contains("selected"), "выбранный провайдер не подсвечен");
    assert.ok(!list.children[2].classList.contains("selected"), "подсветился чужой провайдер");

    // Поиск: по имени, по описанию и «ничего не найдено».
    env.$("s-openai-model").value = "";
    env.panel.wireG4fProviderPicker();
    const search = env.$("g4f-provider-search");
    const clear = env.$("g4f-provider-clear");
    search.value = "chat";
    search.listeners.input();
    assert.strictEqual(list.children.length, 1, "поиск по имени не сузил список: " + list.children.length);
    assert.ok(!clear.classList.contains("hidden"), "кнопка очистки поиска не показалась");
    search.value = "без ключа";
    search.listeners.input();
    assert.strictEqual(list.children.length, 1, "поиск по описанию не сработал: " + list.children.length);
    assert.ok(/\[стабильный, без ключа\]/.test(list.children[0].innerHTML), "нашёлся не тот провайдер");
    search.value = "яяя";
    search.listeners.input();
    assert.strictEqual(list.children.length, 0, "мусорный поиск что-то оставил: " + list.children.length);
    assert.ok(/ничего не найдено/.test(status.textContent), "пустой поиск не объяснён: " + status.textContent);
    assert.ok(/err/.test(status.className), "пустой поиск не помечен как проблема");
    search.listeners.keydown({ key: "Escape" });
    assert.strictEqual(search.value, "", "Escape не очистил поиск");
    assert.strictEqual(list.children.length, 3, "Escape не вернул полный список");

    // Клик по провайдеру: маршрут «Провайдер:», подсказки, тихая подгрузка, сообщение.
    const deepseek = [...list.children][1];
    deepseek.onclick();
    assert.strictEqual(env.$("s-openai-model").value, "DeepSeek:", "маршрут «Провайдер:» не вставлен");
    assert.ok(env.$("s-openai-model").focused > 0, "поле модели не получило фокус");
    assert.deepStrictEqual(env.calls.hints[env.calls.hints.length - 1], { p: "openai", list: ["DeepSeek-V3", "DeepSeek-R1"] },
      "модели провайдера не подсказаны");
    assert.ok(/выбран/.test(env.calls.msgs[env.calls.msgs.length - 1].text), "о выборе провайдера не сказано");
    assert.strictEqual(env.calls.msgs[env.calls.msgs.length - 1].err, false, "выбор провайдера помечен ошибкой");
    assert.strictEqual(env.calls.tested.length, 0, "выбор провайдера сам по себе что-то тестировал");

    // Модели от живого g4f: реестровые первыми, алиасы с префиксом, дубликаты убраны.
    env.resolve(["DeepSeek-V3", "ChatGpt:gpt-4o", "Qwen2.5", "ChatGpt:gpt-4o"]);
    await tick();
    await tick();
    const merged = env.calls.hints[env.calls.hints.length - 1].list;
    assert.deepStrictEqual(plain(merged), ["DeepSeek-V3", "DeepSeek-R1", "DeepSeek:DeepSeek-V3", "ChatGpt:gpt-4o", "DeepSeek:Qwen2.5"],
      "живой список слит неверно: " + JSON.stringify(merged));
    assert.ok(/5 моделей/.test(env.calls.msgs[env.calls.msgs.length - 1].text),
      "число моделей не названо: " + env.calls.msgs[env.calls.msgs.length - 1].text);

    // Молчащий g4f: остаются офлайн-подсказки провайдера, лишних сообщений нет.
    const quiet = buildG4f();
    quiet.panel.renderG4fProviderList();
    quiet.$("g4f-provider-list").children[1].onclick();
    const msgsBefore = quiet.calls.msgs.length;
    quiet.resolve([]);
    await tick();
    await tick();
    assert.deepStrictEqual(quiet.calls.hints[quiet.calls.hints.length - 1].list, ["DeepSeek-V3", "DeepSeek-R1"],
      "без ответа g4f подсказки провайдера потерялись");
    assert.strictEqual(quiet.calls.msgs.length, msgsBefore, "молчащий g4f показал сообщение об ошибке");

    // Поздний ответ от прошлого провайдера не подменяет список текущего.
    const race = buildG4f();
    race.panel.renderG4fProviderList();
    race.$("g4f-provider-list").children[1].onclick();
    race.$("g4f-provider-list").children[2].onclick();
    const hintsBefore = race.calls.hints.length;
    race.resolve(["Qwen2.5"], 0); // ответ для первого (DeepSeek)
    await tick();
    await tick();
    assert.strictEqual(race.calls.hints.length, hintsBefore, "поздний ответ чужого провайдера применён");
  });

  await test("выбор провайдера G4F: авто-режим, тест провайдера и подбор порта", async () => {
    // «default» — авто-режим: в поле «default», моделей провайдера не подсказываем.
    const auto = buildG4f();
    auto.panel.renderG4fProviderList();
    auto.calls.hints.length = 0;
    auto.$("g4f-provider-list").children[0].onclick();
    assert.strictEqual(auto.$("s-openai-model").value, "default", "авто-режим не вставился в поле модели");
    assert.deepStrictEqual(auto.calls.hints, [{ p: "openai", list: null }], "авто-режим показал модели провайдера");
    assert.ok(/Авто-режим/.test(auto.calls.msgs[auto.calls.msgs.length - 1].text), "авто-режим не объяснён");
    assert.strictEqual(auto.pending.length, 0, "авто-режим зря пошёл за списком моделей");

    // Полный тест провайдера: консоль, строки логов с видами, вердикт.
    const env = buildG4f({ testResult: { log: [{ level: "info", text: "запрос к провайдеру" }, { level: "ok", text: "ответ получен" }, { level: "err", text: "сбой вызова" }] } });
    env.$("s-openai-url").value = "http://localhost:1337/v1";
    env.panel.renderG4fProviderList();
    const btn = env.$("g4f-provider-list").children[1].queried[".repo-test-btn"];
    assert.ok(btn, "у строки провайдера не нашлась кнопка теста");
    let stopped = 0;
    btn.onclick({ stopPropagation: () => stopped++ });
    assert.strictEqual(stopped, 1, "клик по кнопке теста не остановлен — он бы ещё и выбрал провайдера");
    assert.strictEqual(env.calls.console[0], "tab:console", "тест не открыл консоль правой панели");
    assert.ok(/Тест провайдера/.test(env.calls.console[1]), "в консоли нет строки о начале теста");
    await tick();
    await tick();
    assert.strictEqual(env.calls.tested.length, 1, "главный процесс не получил запрос на тест");
    assert.deepStrictEqual(plain(env.calls.tested[0]), { url: "http://localhost:1337/v1", provider: "DeepSeek", model: "DeepSeek-V3" },
      "тест ушёл с неверными данными: " + JSON.stringify(env.calls.tested[0]));
    assert.strictEqual(env.calls.server.length, 3, "строки логов не выведены в консоль: " + env.calls.server.length);
    assert.ok(/ts-info/.test(env.calls.server[0]) && /ts-ok/.test(env.calls.server[1]) && /ts-err/.test(env.calls.server[2]),
      "виды строк логов не различаются");
    assert.ok(/есть проблемы/.test(env.calls.msgs[env.calls.msgs.length - 1].text), "вердикт с ошибками не вынесен");
    assert.strictEqual(env.calls.msgs[env.calls.msgs.length - 1].err, true, "провальный тест не помечен ошибкой");

    // Успех и вовсе без ответов — свои формулировки, а не «всё хорошо» по умолчанию.
    const okEnv = buildG4f({ testResult: { log: [{ level: "ok", text: "ответ" }] } });
    okEnv.panel.renderG4fProviderList();
    okEnv.$("g4f-provider-list").children[1].queried[".repo-test-btn"].onclick({ stopPropagation() {} });
    const emptyEnv = buildG4f({ testResult: { log: [] } });
    emptyEnv.panel.renderG4fProviderList();
    emptyEnv.$("g4f-provider-list").children[1].queried[".repo-test-btn"].onclick({ stopPropagation() {} });
    await tick();
    await tick();
    assert.ok(/отвечает/.test(okEnv.calls.msgs[okEnv.calls.msgs.length - 1].text), "успешный тест не подтверждён");
    assert.ok(/ответов нет/.test(emptyEnv.calls.msgs[emptyEnv.calls.msgs.length - 1].text), "пустой ответ не назван своим словом");

    // В браузере тест честно недоступен: в главный процесс ничего не уходит.
    const web = buildG4f({ isElectron: false });
    web.$("s-openai-url").value = "http://localhost:1337";
    await web.panel.probeG4fPort();
    assert.strictEqual(web.calls.probed.length, 0, "в браузере подбор порта всё-таки пошёл");
    web.panel.renderG4fProviderList();
    web.$("g4f-provider-list").children[1].queried[".repo-test-btn"].onclick({ stopPropagation() {} });
    await tick();
    await tick();
    assert.strictEqual(web.calls.tested.length, 0, "в браузере тест всё-таки ушёл в главный процесс");
    assert.ok(/ПК/.test(web.calls.msgs[web.calls.msgs.length - 1].text), "нет честного отказа в веб-режиме: " + web.calls.msgs[web.calls.msgs.length - 1].text);
    assert.ok(/десктоп/.test(web.calls.server[web.calls.server.length - 1]), "в консоль не сказано, что тест только на ПК");

    // Подбор порта: свой localhost подменяется, чужой адрес — только предупреждение.
    const local = buildG4f({ probeResult: { ok: true, base: "http://localhost:1337" } });
    local.$("s-openai-url").value = "http://localhost:8080/";
    await local.panel.probeG4fPort();
    assert.strictEqual(local.$("s-openai-url").value, "http://localhost:1337", "живой порт G4F не подставлен");
    assert.ok(/URL обновлён/.test(local.calls.msgs[0].text), "о подборе порта не сказано: " + local.calls.msgs[0].text);

    const remote = buildG4f({ probeResult: { ok: true, base: "http://localhost:1337" } });
    remote.$("s-openai-url").value = "http://192.168.1.5:1337";
    await remote.panel.probeG4fPort();
    assert.strictEqual(remote.$("s-openai-url").value, "http://192.168.1.5:1337", "чужой адрес перезаписан автоматически");
    assert.ok(/если это не тот адрес/.test(remote.calls.msgs[0].text), "про несовпадение адреса не сказано");

    const same = buildG4f({ probeResult: { ok: true, base: "http://localhost:1337" } });
    same.$("s-openai-url").value = "http://localhost:1337";
    await same.panel.probeG4fPort();
    assert.strictEqual(same.calls.msgs.length, 0, "сообщение показано без повода");
    assert.strictEqual(same.calls.probed.length, 1, "подбор порта ушёл не одним запросом");

    // Молчащий сервер (запрос упал) — тоже без сообщений: это фоновая проверка.
    const dead = buildG4f({ api: { g4fProbe: async () => { throw new Error("сервер молчит"); } } });
    dead.$("s-openai-url").value = "http://localhost:8080";
    await dead.panel.probeG4fPort();
    assert.strictEqual(dead.calls.msgs.length, 0, "молчащий сервер напугал пользователя сообщением");
  });

  await test("выбор провайдера G4F: блок по пресету, аккордеон и поиск подключены", async () => {
    const env = buildG4f();
    env.panel.wireG4fProviderPicker();
    const box = env.$("g4f-provider-box");
    const body = env.$("g4f-provider-body");
    const chev = env.$("g4f-prov-chev");

    // Чипы пресетов: блок виден только на G4F, и при показе подбирается живой порт.
    env.chips[2].listeners.click();
    assert.ok(box.classList.contains("hidden"), "блок провайдеров показан на чужом пресете");
    env.chips[1].listeners.click();
    assert.ok(!box.classList.contains("hidden"), "блок провайдеров не показался на G4F");
    assert.strictEqual(env.calls.probed.length, 1, "при показе блока не подобрался живой порт");
    // Чаще раза в 30 секунд порт не подбираем — иначе дёргали бы локальный сервер зря.
    env.chips[2].listeners.click();
    env.chips[1].listeners.click();
    assert.strictEqual(env.calls.probed.length, 1, "подбор порта идёт чаще, чем раз в 30 секунд");
    env.advance(31000);
    env.chips[2].listeners.click();
    env.chips[1].listeners.click();
    assert.strictEqual(env.calls.probed.length, 2, "после 30 секунд подбор порта не повторился");

    // Пресет чипа важнее состояния оболочки: наш слушатель срабатывает раньше SettingsPanel.
    env.setPreset("openai");
    env.chips[1].listeners.click();
    assert.ok(!box.classList.contains("hidden"), "пресет чипа проигнорирован — блок спрятался");
    env.setPreset("g4f");

    // Открытие окна настроек (наблюдатель за классом) синхронизирует блок.
    const obs = env.observer();
    assert.strictEqual(typeof obs, "function", "наблюдатель за открытием настроек не поставлен");
    box.classList.add("hidden");
    env.$("settings-overlay").classList.remove("hidden");
    obs();
    assert.ok(!box.classList.contains("hidden"), "при открытии настроек блок не показался");
    box.classList.add("hidden");
    env.$("settings-overlay").classList.add("hidden");
    obs();
    assert.ok(box.classList.contains("hidden"), "на закрытых настройках блок показан");

    // Аккордеон: шапка раскрывает список и меняет стрелку в обе стороны.
    assert.ok(body.classList.contains("hidden"), "список провайдеров открыт сразу");
    env.$("g4f-provider-head").onclick();
    assert.ok(!body.classList.contains("hidden"), "шапка не раскрыла список");
    assert.strictEqual(chev.textContent, "▾", "стрелка не сменилась на «открыто»: " + chev.textContent);
    env.$("g4f-provider-head").onclick();
    assert.ok(body.classList.contains("hidden"), "шапка не свернула список");
    assert.strictEqual(chev.textContent, "▸", "стрелка не вернулась в «закрыто»: " + chev.textContent);

    // Поиск: ввод сужает список, крестик возвращает полный.
    const search = env.$("g4f-provider-search");
    const clear = env.$("g4f-provider-clear");
    search.value = "deep";
    search.listeners.input();
    assert.strictEqual(env.$("g4f-provider-list").children.length, 1, "ввод в поиск не сузил список");
    clear.onclick();
    assert.strictEqual(search.value, "", "крестик не очистил поиск");
    assert.strictEqual(env.$("g4f-provider-list").children.length, 3, "после очистки список не вернулся");
  });
}

module.exports = {
  testProviderConfig,
  testProviderTransport,
  testOllamaWindow,
  testOpenaiProfiles,
  testG4fPanel,
};

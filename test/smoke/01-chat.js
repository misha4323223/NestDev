"use strict";
/* ─── Группа «Чат: действия, лента, размышления, сегменты» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 12.

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
  buildChatFeed,
  get,
  mainOnlySrc,
  tmpdir,
  uiAll,
  uiFile,
  uiFind,
} = H;

// ── Удобство чата (src/renderer/chat-actions.js) ─────────────────────────
// Модуль вынесен из app.js: проверяется ПОВЕДЕНИЕ кнопок под сообщением —
// скопировать, перегенерировать, вернуть своё сообщение в поле ввода, — а не
// то, что функции где-то есть. Заглушка DOM строгая: id не из разметки — падение.
async function testChatActions() {
  await test("удобство чата: копирование, перегенерация и правка сообщения работают", () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-actions.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    const el = () => ({
      value: "", textContent: "", title: "", style: {},
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      focus() {}, select() {}, appendChild() {}, removeChild() {},
    });
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    const calls = { toasts: [], saved: 0, rendered: 0, sent: 0, resized: 0, clipboard: [], copied: 0 };
    const chat = {
      id: "c1",
      title: "Разбор заявок",
      messages: [
        { role: "user", content: "первый вопрос" },
        { role: "assistant", content: "первый ответ" },
        { role: "user", content: "второй вопрос" },
        { role: "assistant", content: "ответ с кодом" },
        { role: "tool", toolName: "readFile", toolResult: "содержимое" },
      ],
    };
    let streaming = false;
    // Собираем модуль так же, как его собирает окно: фабрика + зависимости.
    const build = (over) => {
      const sandbox = {
        module: { exports: {} },
        window: {},
        self: {},
        console: { log() {}, warn() {}, error() {} },
        document: {
          createElement: () => el(),
          body: { appendChild() {}, removeChild() {} },
          execCommand: (cmd) => (cmd === "copy" ? (calls.copied++, true) : false),
        },
        navigator: { clipboard: { writeText: (x) => (calls.clipboard.push(x), Promise.resolve()) } },
      };
      vm.runInNewContext(src, sandbox, { filename: "chat-actions.js" });
      assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
      return sandbox.module.exports(
        Object.assign(
          {
            $,
            toast: (x) => calls.toasts.push(x),
            getActiveChat: () => chat,
            persistChats: () => calls.saved++,
            renderMessages: () => calls.rendered++,
            sendMessage: () => calls.sent++,
            autoResize: () => calls.resized++,
            msgText: (c) => String(c == null ? "" : c),
            chatTitle: () => chat.title,
            isStreaming: () => streaming,
          },
          over || {}
        )
      );
    };
    // Проводка в app.js: генерация передана ЖИВОЙ проверкой. Копия ("isStreaming: false",
    // снимок в переменную) пропустила бы перегенерацию поверх идущего ответа.
    const wiring = uiFind("  const ChatActions = window.ChatActions({", "  // ─── Быстрое переключение модели (попап в шапке)").code;
    assert.ok(/isStreaming: \(\) => streaming/.test(wiring), "идущая генерация передана в модуль копией, а не живой проверкой");
    const A = build();
    assert.deepStrictEqual(Object.keys(A).sort(), ["copyChat", "copyText", "editUserMessage", "isLastAssistant", "regenerate"], "наружу торчит лишнее или чего-то не хватает");

    // 1. «Перегенерировать» показывается только у последнего ответа агента.
    assert.strictEqual(A.isLastAssistant(chat.messages[1]), false, "кнопка перегенерации показана у старого ответа");
    assert.strictEqual(A.isLastAssistant(chat.messages[3]), true, "у последнего ответа нет кнопки перегенерации");
    assert.strictEqual(A.isLastAssistant(chat.messages[2]), false, "своё сообщение сочли ответом агента");

    // 2. Перегенерация снимает ОТВЕТЫ запуска (вопрос остаётся — он и уходит заново),
    //    возвращает вопрос в поле ввода и отправляет заново.
    streaming = true;
    A.regenerate(chat.messages[3]);
    assert.strictEqual(chat.messages.length, 5, "во время генерации перегенерация всё равно сработала");
    assert.strictEqual(calls.sent, 0, "во время генерации ушла повторная отправка");
    streaming = false;
    A.regenerate(chat.messages[3]);
    assert.deepStrictEqual(chat.messages.map((m) => m.content), ["первый вопрос", "первый ответ", "второй вопрос"], "снят не весь запуск: " + JSON.stringify(chat.messages));
    assert.strictEqual($("input").value, "второй вопрос", "вопрос не вернулся в поле ввода");
    assert.strictEqual(calls.sent, 1, "повторная отправка не ушла");
    assert.ok(calls.saved > 0 && calls.rendered > 0 && calls.resized > 0, "переписка не сохранена или не перерисована");

    // 3. Правка своего сообщения: текст в поле ввода, само сообщение и всё после удалены.
    chat.messages = [{ role: "user", content: "старый вопрос" }, { role: "assistant", content: "ответ" }];
    A.editUserMessage(chat.messages[0]);
    assert.strictEqual($("input").value, "старый вопрос", "текст не попал в поле ввода");
    assert.strictEqual(chat.messages.length, 0, "правка не убрала сообщение и всё после него");

    // 4. Копирование всего чата: заголовок, роли, блок инструмента.
    chat.messages = [
      { role: "user", content: "вопрос" },
      { role: "assistant", content: "ответ" },
      { role: "tool", toolName: "readFile", toolResult: "содержимое" },
    ];
    A.copyChat();
    assert.strictEqual(calls.clipboard.length, 1, "чат не попал в буфер обмена");
    const md = calls.clipboard[0] || "";
    assert.ok(/# Разбор заявок/.test(md), "нет заголовка чата: " + md.slice(0, 60));
    assert.ok(/\*\*Пользователь:\*\*/.test(md) && /\*\*Ассистент:\*\*/.test(md), "роли в markdown потеряны");
    assert.ok(/Инструмент:\*\* readFile/.test(md) && /```/.test(md), "блок инструмента потерян");

    // 5. Пустой чат — честное сообщение, а не пустая выгрузка.
    chat.messages = [];
    const before = calls.clipboard.length;
    A.copyChat();
    assert.strictEqual(calls.clipboard.length, before, "пустой чат всё равно ушёл в буфер");
    assert.ok(calls.toasts.some((x) => /пуст/i.test(x)), "о пустом чате не сказано: " + calls.toasts.join(" | "));

    // 6. Копирование строки: современный путь (clipboard) и запасной (execCommand).
    A.copyText("строка");
    assert.strictEqual(calls.clipboard[calls.clipboard.length - 1], "строка", "строка не скопирована");
    const old = build({});
    void old;
    const sandbox2 = {
      module: { exports: {} },
      window: {},
      self: {},
      console: { log() {}, warn() {}, error() {} },
      navigator: {}, // старый браузер без clipboard API
      document: {
        createElement: () => el(),
        body: { appendChild() {}, removeChild() {} },
        execCommand: (cmd) => (cmd === "copy" ? (calls.copied++, true) : false),
      },
    };
    vm.runInNewContext(src, sandbox2, { filename: "chat-actions.js" });
    const A2 = sandbox2.module.exports({
      $, toast: (x) => calls.toasts.push(x), getActiveChat: () => chat, persistChats: () => calls.saved++,
      renderMessages: () => calls.rendered++, sendMessage: () => calls.sent++, autoResize: () => calls.resized++,
      msgText: (c) => String(c == null ? "" : c), chatTitle: () => chat.title, isStreaming: () => false,
    });
    A2.copyText("через execCommand");
    assert.ok(calls.copied > 0, "запасной путь копирования (execCommand) не сработал");

    // 7. Негативный контроль: забытая зависимость падает громко, а не молча.
    const broken = build({ chatTitle: undefined });
    chat.messages = [{ role: "user", content: "x" }];
    assert.throws(() => broken.copyChat(), /chatTitle/, "забытая зависимость не привела к понятной ошибке");
  });
}

// ── Веб-режим (src/renderer/web-chat.js) ─────────────────────────────────
// Цикл чата в браузере: проверяем ПОВЕДЕНИЕ на живом ядре AgentCore и подменённой
// сети — раунды, авто-переключение ключа при ошибке баланса, отказы для того,
// что в браузере невозможно. Сеть отвечает настоящими Response.
async function testWebChat() {
  await test("веб-режим: раунды, авто-переключение ключа и честные отказы", async () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "web-chat.js"), "utf8");
    const AgentCore2 = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    // В песочнице нет браузерных глобальных имён: fetch и таймеры подкладываем сами,
    // иначе модуль честно скажет «Сетевая ошибка: fetch is not defined».
    const sandbox = {
      module: { exports: {} }, window: {}, self: {},
      console: { log() {}, warn() {}, error() {} },
      fetch: (...a) => global.fetch(...a), setTimeout, clearTimeout,
    };
    vm.runInNewContext(src, sandbox, { filename: "web-chat.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
    const settings = {
      provider: "openai", model: "m1", openaiUrl: "https://a/v1", openaiApiKey: "ключ-1",
      autoSwitchProfiles: true, openaiActiveProfile: "p1", workingDir: "",
    };
    const events = [];
    let saved = 0;
    const web = sandbox.module.exports({
      AgentCore: AgentCore2,
      getSettings: () => settings,
      openaiProfilesArr: () => [
        { id: "p1", name: "Первый", apiKey: "ключ-1", url: "https://a/v1", model: "m1" },
        { id: "p2", name: "Второй", apiKey: "ключ-2", url: "https://b/v1", model: "m2" },
      ],
      persistSettings: () => saved++,
      onEvent: (ev) => events.push(ev),
      openAskModal: (q, options, cb) => (typeof options === "function" ? options : cb)("ответ агента"),
    });
    assert.deepStrictEqual(Object.keys(web), ["webSend"], "наружу торчит лишнее или чего-то не хватает");

    // Проводка в app.js: именно этих зависимостей не хватало раньше, и авто-переключение
    // профилей падало с ReferenceError ровно тогда, когда ключ кончился.
    const wiring = uiFind("  const WebChat = window.WebChat({", "  // ─────────────── Настройки ───────────────").code;
    assert.ok(/onEvent: ChatEvents\.onAiEvent/.test(wiring), "в модуль не передан обработчик событий: авто-переключение профилей снова упадёт");
    assert.ok(/getSettings: \(\) => settings/.test(wiring), "настройки переданы копией — смена профиля не дойдёт до модуля");
    assert.ok(/openaiProfilesArr: OpenaiProfiles.arr/.test(wiring), "модуль не видит сохранённые подключения");
    // Сборка подключений стоит РАНЬШЕ веб-режима: тот берёт их своим входом.
    const profLine = uiAll().split("\n").findIndex((l) => /const OpenaiProfiles = window.OpenaiProfiles\(/.test(l));
    const webLine = uiAll().split("\n").findIndex((l) => /const WebChat = window.WebChat\(/.test(l));
    assert.ok(profLine > 0 && webLine > profLine, "подключения собираются после веб-режима — он получит пустую ссылку");

    const sse = (parts) => new Response(parts.map((p) => "data: " + JSON.stringify(p) + "\n\n").join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    // У Ollama свой формат: не SSE, а NDJSON — каждая строка отдельный объект, и
    // разбирается он другим путём (см. provider-transport.js). Подменять его SSE нельзя.
    const ndjson = (parts) => new Response(parts.map((p) => JSON.stringify(p) + "\n").join(""), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    const realFetch = global.fetch;
    const calls = [];
    let script = null; // что отвечает подменённая сеть на каждый вызов
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), headers: (init && init.headers) || {}, body: String((init && init.body) || "") });
      return script(calls.length);
    };
    try {
      // 1. Первый ключ отвечает «кончились средства» (402), второй отдаёт ответ потоком.
      script = (n) =>
        n === 1
          ? new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402, headers: { "Content-Type": "application/json" } })
          : sse([{ choices: [{ delta: { content: "готово" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }]);
      await web.webSend([{ role: "user", content: "привет" }], (ev) => events.push(ev), undefined, {});
      assert.strictEqual(calls.length, 2, "раунд не повторился после 402: вызовов " + calls.length);
      assert.strictEqual(settings.openaiActiveProfile, "p2", "ключ не переключился на запасной");
      assert.ok(saved > 0, "смена подключения не сохранена");
      const switched = events.filter((e) => e.type === "profile_switched");
      assert.strictEqual(switched.length, 1, "о переключении не сообщено (это и был ReferenceError onEvent)");
      assert.strictEqual(switched[0].id, "p2", "сообщено не то подключение: " + JSON.stringify(switched[0]));
      assert.ok(/ключ-2/.test(JSON.stringify(calls[1].headers)), "повторный запрос ушёл со старым ключом: " + JSON.stringify(calls[1].headers));
      const text = events.filter((e) => e.type === "chunk").map((e) => e.text).join("");
      assert.ok(/готово/.test(text), "ответ не дошёл до интерфейса: " + JSON.stringify(text));
      assert.ok(events.some((e) => e.type === "done"), "прогон не завершился событием done");

      // 2. Инструмент, которому нужен главный процесс: честный отказ, не выдумка.
      events.length = 0;
      calls.length = 0;
      script = (n) =>
        n === 1
          ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "readFile", arguments: '{"path":"a.txt"}' } }] } }] }])
          : sse([{ choices: [{ delta: { content: "ок" } }] }]);
      await web.webSend([{ role: "user", content: "прочитай файл" }], (ev) => events.push(ev), undefined, {});
      const tr = events.filter((e) => e.type === "tool_result");
      assert.strictEqual(tr.length, 1, "результат инструмента не вернулся: " + JSON.stringify(events.map((e) => e.type)));
      assert.ok(/Файловые операции и git недоступны в веб-версии/.test(tr[0].result), "файлы в браузере не отказали честно: " + tr[0].result);
      assert.ok(tr[0].result.indexOf("readFile") < 0 || /недоступн/i.test(tr[0].result), "отказ не объясняет причину");

      // 3. Модель не выбрана — понятный отказ без единого запроса в сеть.
      events.length = 0;
      const before = calls.length;
      settings.model = "";
      await web.webSend([{ role: "user", content: "привет" }], (ev) => events.push(ev), undefined, {});
      assert.strictEqual(calls.length, before, "запрос ушёл без выбранной модели");
      assert.ok(events.some((e) => e.type === "error" && /модель/i.test(e.message)), "нет понятного отказа: " + JSON.stringify(events));

      // 4. «Стоп» посреди потока: чтение обрывается AbortError — это остановка
      // человека. Прогон завершается мягко, а в окне зажигается «▶ Продолжить»;
      // раньше AbortError улетал наружу: ответ обрывался молча, продолжать было нечем.
      events.length = 0;
      settings.model = "m1";
      const abortErr = new Error("Прерывание запроса: остановлено человеком");
      abortErr.name = "AbortError";
      // Кусок текста отдаётся ПЕРВЫМ чтением (он должен дойти до окна), а обрыв
      // приходит следом — так же ведёт себя прерванный поток у провайдера.
      const cutOff = (parts) =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const p of parts) controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(p) + "\n\n"));
              setTimeout(() => controller.error(abortErr), 5);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      script = () => cutOff([{ choices: [{ delta: { content: "начал" } }] }]);
      await web.webSend([{ role: "user", content: "работай" }], (ev) => events.push(ev), new AbortController().signal, {});
      assert.ok(!events.some((e) => e.type === "error"), "остановка человека ушла в чат ошибкой: " + JSON.stringify(events.filter((e) => e.type === "error")));
      assert.deepStrictEqual(
        events.filter((e) => e.type === "resume" || e.type === "done").map((e) => e.type),
        ["resume", "done"],
        "веб-режим не зажёг кнопку продолжения: " + JSON.stringify(events.map((e) => e.type))
      );
      assert.ok(/остановлено пользователем/.test(events.find((e) => e.type === "resume").reason), "у кнопки нет причины остановки");
      assert.ok(/начал/.test(events.filter((e) => e.type === "chunk").map((e) => e.text).join("")), "частичный текст потерялся");

      // 5. Контекст в веб-режиме: раньше не считались НИ системный промпт, НИ схемы
      //    инструментов, и в запрос уходили ВСЕ 167 схем (≈33 000 токенов) — на локальном
      //    окне они одни занимали окно целиком. Теперь набор отбирает роутер, индикатор
      //    получает честные числа, а окно модели спрашивается у САМОГО сервера: от него
      //    зависят и бюджет истории, и num_ctx, без которого Ollama молча резала запрос.
      events.length = 0;
      calls.length = 0;
      settings.provider = "ollama";
      settings.model = "qwen3:4b";
      settings.ollamaUrl = "http://127.0.0.1:11577";
      script = (n) => {
        if (/\/api\/show$/.test(calls[n - 1].url)) {
          return new Response(
            JSON.stringify({ model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 }, capabilities: ["completion", "tools"] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return ndjson([{ message: { content: "готово" } }, { done: true }]);
      };
      await web.webSend([{ role: "user", content: "сходи на сайт и прочитай страницу" }], (ev) => events.push(ev), undefined, {});
      assert.ok(calls.length >= 2, "запрос не ушёл на локальный сервер: " + JSON.stringify(calls.map((c) => c.url)));
      assert.ok(/\/api\/show$/.test(calls[0].url), "веб-режим не спросил окно модели у сервера: " + calls[0].url);
      const chatCall = calls.find((c) => /\/api\/chat$/.test(c.url));
      assert.ok(chatCall, "запрос чата не ушёл: " + JSON.stringify(calls.map((c) => c.url)));
      const allTools = AgentCore2.TOOL_DEFINITIONS.length;
      const sentTools = (JSON.parse(chatCall.body).tools || []).length;
      assert.ok(sentTools > 0, "в веб-версии ушёл запрос без схем инструментов");
      assert.ok(sentTools < allTools, "в запрос ушли ВСЕ схемы (" + sentTools + " из " + allTools + "): на малом окне они занимают его целиком");
      // num_ctx = бюджет + запас, но не больше окна: без него Ollama брала дефолт.
      assert.strictEqual(JSON.parse(chatCall.body).options.num_ctx, 32768, "num_ctx не ушёл в запрос веб-режима: " + chatCall.body.slice(0, 300));
      const ctxEv = events.filter((e) => e.type === "context").pop();
      assert.ok(ctxEv, "индикатор контекста не получил чисел: " + JSON.stringify(events.map((e) => e.type)));
      assert.strictEqual(ctxEv.budget, 28672, "бюджет веб-версии посчитан не от окна модели: " + ctxEv.budget);
      assert.ok(ctxEv.tools > 0 && ctxEv.system > 0, "индикатор не учитывает схемы и промпт: " + JSON.stringify(ctxEv));
      assert.ok(ctxEv.history <= ctxEv.budget, "индикатор считает истории больше бюджета: " + JSON.stringify(ctxEv));
      assert.ok(/готово/.test(events.filter((e) => e.type === "chunk").map((e) => e.text).join("")), "ответ не дошёл");

      // 6. Отказ «запрос больше окна»: историю ужимаем и повторяем ТОТ ЖЕ раунд, а когда
      //    ступени кончились — объясняем по-русски. Сырой английский ответ провайдера
      //    («maximum context length is 8192 tokens») человеку читать незачем.
      events.length = 0;
      calls.length = 0;
      settings.provider = "openai";
      settings.model = "m1";
      script = () => new Response(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }), { status: 400, headers: { "Content-Type": "application/json" } });
      const longHistory = [];
      for (let i = 0; i < 6; i++) {
        longHistory.push({ role: "user", content: "шаг " + i + " " + "слово ".repeat(200) });
        longHistory.push({ role: "assistant", content: "ясно " + "ответ ".repeat(200) });
      }
      await web.webSend(longHistory, (ev) => events.push(ev), undefined, {});
      const steps = events.filter((e) => e.type === "notice" && /больше её окна/.test(e.text));
      assert.ok(steps.length >= 1 && steps.length <= 3, "ступени ужатия вне предела 1–3: " + steps.length);
      // Повторы не должны превращаться в поток одинаковых строк: про размер запроса и про
      // тесное окно говорим один раз за прогон (в приложении для этого есть state.warned).
      assert.strictEqual(
        events.filter((e) => e.type === "notice" && /не влезал в окно/.test(e.text)).length,
        1,
        "про размер запроса сказано не один раз"
      );
      assert.strictEqual(
        events.filter((e) => e.type === "notice" && /Окно модели мало/.test(e.text)).length,
        1,
        "про тесное окно сказано не один раз"
      );
      assert.ok(calls.length >= 2, "раунд не повторён после ужатия: вызовов " + calls.length);
      const err = events.filter((e) => e.type === "error").pop();
      assert.ok(err, "прогон упал без объяснения: " + JSON.stringify(events.map((e) => e.type)));
      assert.ok(/Продолжить/.test(err.message), "в тексте ошибки нет выхода из положения: " + err.message);
      assert.ok(!/maximum context length/.test(err.message), "человеку показан сырой ответ провайдера: " + err.message);
    } finally {
      global.fetch = realFetch;
    }
  });
}

// ── Блок размышлений модели (src/renderer/chat-thinking.js, этап 3.7) ───────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ плашки «Размышление», а не наличие
// функций: сборку из заголовка и тела, рост текста с автопрокруткой, честную
// реакцию на ручную прокрутку (человек читает выше — не выдёргиваем), ручное
// сворачивание кликом, автосворачивание по завершении ответа и возврат
// сохранённых размышлений после перезагрузки.
async function testChatThinking() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-thinking.js"), "utf8");

  await test("размышления: плашка живёт в своём модуле и ведёт себя как раньше", () => {
    // 1. Разметка, мост и оболочка: модуль подключён до app.js и собирается без зависимостей.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-thinking.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-thinking.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-thinking.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"chat-thinking\.js"/.test(bridge), "мобильный мост не отдаёт chat-thinking.js телефону");
    const appSrc = uiFile("app.js");
    assert.ok(appSrc.indexOf("function thinkAutoScroll") === -1, "код блока размышлений остался в app.js");
    assert.ok(appSrc.indexOf('querySelector(".think")') === -1, "в app.js остались знания о разметке блока размышлений");
    assert.ok(/const ChatThinking = window\.ChatThinking\(\);/.test(appSrc), "оболочка не собирает модуль размышлений");
    // Возврат сохранённой плашки зовёт модуль отрисовки сообщения (этап 3.7),

    // поэтому спрашиваем интерфейс целиком, а не только оболочку.
    const uiSrc = uiAll();
    for (const call of ["ChatThinking.ensureThinkBox", "ChatThinking.collapseThinkBox", "ChatThinking.restoreThinkBox"]) {
      assert.ok(uiSrc.indexOf(call) !== -1, "никто не зовёт " + call);
    }

    // 2. Заглушка DOM: ищем по классу, как настоящий браузер (querySelector).
    const findByClass = (node, sel) => {
      const cls = String(sel || "").replace(/^\./, "");
      for (const child of node.children || []) {
        if (String(child.className).split(/\s+/).indexOf(cls) !== -1) return child;
        const deep = findByClass(child, sel);
        if (deep) return deep;
      }
      return null;
    };
    const el = () => {
      const classes = new Set();
      let text = "";
      const node = {
        className: "", children: [], dataset: {}, onclick: null, listeners: {},
        scrollTop: 0, scrollHeight: 900, clientHeight: 200, parentNode: null,
        get textContent() { return text; },
        set textContent(v) { text = String(v); },
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !classes.has(c) : !!on;
            if (want) classes.add(c); else classes.delete(c);
            return want;
          },
        },
        addEventListener: (type, fn) => { node.listeners[type] = fn; },
        appendChild: (child) => { node.children.push(child); child.parentNode = node; return child; },
        insertBefore: (child, ref) => {
          const at = node.children.indexOf(ref);
          node.children.splice(at < 0 ? node.children.length : at, 0, child);
          child.parentNode = node;
          return child;
        },
        querySelector: (sel) => findByClass(node, sel),
      };
      return node;
    };
    const sandbox = { module: { exports: {} }, self: {}, console: { warn() {}, log() {}, error() {} }, document: { createElement: () => el() } };
    vm.runInNewContext(src, sandbox, { filename: "chat-thinking.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
    const think = sandbox.module.exports();
    assert.deepStrictEqual(Object.keys(think).sort(), ["collapseThinkBox", "ensureThinkBox", "restoreThinkBox"],
      "наружу торчит лишнее или чего-то не хватает");

    // 3. Сборка плашки: заголовок, значок, стрелка, тело — и она встаёт НАД пузырём ответа.
    const wrap = el();
    const bubble = el();
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    const box = think.ensureThinkBox(wrap, "думаю над задачей");
    assert.strictEqual(box.className, "think", "плашка собрана не тем классом");
    assert.strictEqual(wrap.children[0], box, "плашка не встала над пузырём ответа");
    assert.ok(box.children[0].className === "think-head", "нет заголовка плашки");
    assert.strictEqual(box.children[1].className, "think-body", "нет тела плашки");
    assert.strictEqual(box.children[1].textContent, "думаю над задачей", "текст размышлений не попал в тело");
    const head = box.children[0];
    assert.strictEqual(head.querySelector(".think-t").textContent, "Размышление", "заголовок плашки не тот");
    assert.strictEqual(head.querySelector(".think-chev").textContent, "▾", "стрелка не раскрыта");
    assert.strictEqual(box.children[1].scrollTop, box.children[1].scrollHeight, "новый блок не показал конец размышлений");

    // 4. Текст вырос — тот же блок, текст обновился и снова поехал вниз.
    box.children[1].scrollTop = 0;
    const again = think.ensureThinkBox(wrap, "думаю дальше");
    assert.strictEqual(again, box, "выросший текст создал второй блок вместо обновления");
    assert.strictEqual(box.children[1].textContent, "думаю дальше", "текст в блоке не обновился");
    assert.strictEqual(box.children[1].scrollTop, box.children[1].scrollHeight, "текст вырос, а блок не поехал вниз");

    // 5. Человек отлистал вверх читать: не выдёргиваем, но вернёмся, когда он у конца.
    const body = box.children[1];
    body.scrollTop = 120;
    body.dataset.pinned = "0";
    think.ensureThinkBox(wrap, "думаю ещё немного");
    assert.strictEqual(body.scrollTop, 120, "человека выдернули из чтения");
    body.scrollHeight = 1000;
    body.scrollTop = 950;
    body.listeners.scroll();
    assert.strictEqual(body.dataset.pinned, "1", "не заметили, что человек снова у конца");
    think.ensureThinkBox(wrap, "и ещё");
    assert.strictEqual(body.scrollTop, body.scrollHeight, "у конца текста автопрокрутка не вернулась");

    // 6. Клик по заголовку: сворачивает, помечает ручное управление и разворачивает обратно.
    let stopped = false;
    head.onclick({ stopPropagation: () => { stopped = true; } });
    assert.ok(stopped, "клик по заголовку не остановлен — уйдёт в обработчик пузыря");
    assert.ok(box.classList.contains("user"), "ручное управление не помечено");
    assert.ok(box.classList.contains("collapsed"), "клик по заголовку не свернул блок");
    assert.strictEqual(head.querySelector(".think-chev").textContent, "▸", "стрелка не свернулась");
    body.scrollTop = 0;
    head.onclick({ stopPropagation: () => {} });
    assert.ok(!box.classList.contains("collapsed"), "повторный клик не развернул блок");
    assert.strictEqual(head.querySelector(".think-chev").textContent, "▾", "стрелка не развернулась");
    assert.strictEqual(body.scrollTop, body.scrollHeight, "разворот не показал конец размышлений");

    // 7. Завершение ответа сворачивает блок — но не тот, который человек открыл сам.
    const fresh = el(); // пузыря ответа ещё нет: плашка обязана встать в конец
    const auto = think.ensureThinkBox(fresh, "размышления до конца");
    assert.strictEqual(fresh.children[0], auto, "без пузыря плашка не встала в сообщение");
    think.collapseThinkBox(fresh);
    assert.ok(auto.classList.contains("collapsed"), "завершение ответа не свернуло размышления");
    assert.strictEqual(auto.querySelector(".think-chev").textContent, "▸", "стрелка не свернулась при автосворачивании");
    auto.classList.add("user");
    auto.classList.remove("collapsed");
    think.collapseThinkBox(fresh);
    assert.ok(!auto.classList.contains("collapsed"), "автосворачивание залезло в блок, открытый человеком");
    think.collapseThinkBox(null);
    think.collapseThinkBox(el());

    // 8. Возврат сохранённых размышлений: свёрнуто, а у незакрытого ответа — раскрыто.
    const saved = el();
    think.restoreThinkBox(saved, "старые размышления", false);
    const savedBox = saved.querySelector(".think");
    assert.ok(savedBox && savedBox.classList.contains("collapsed"), "сохранённые размышления показаны развёрнутыми");
    assert.strictEqual(savedBox.querySelector(".think-chev").textContent, "▸", "стрелка сохранённых размышлений не свёрнута");
    assert.strictEqual(savedBox.querySelector(".think-body").textContent, "старые размышления", "текст сохранённых размышлений потерян");
    const pending = el();
    think.restoreThinkBox(pending, "ответ ещё идёт", true);
    assert.ok(!pending.querySelector(".think").classList.contains("collapsed"), "у идущего ответа размышления свернули");

    // 9. Негативный контроль: тело плашки пропало — модуль не падает, а живёт дальше.
    const broken = el();
    const brokenBox = el();
    brokenBox.className = "think";
    broken.appendChild(brokenBox);
    assert.doesNotThrow(() => think.ensureThinkBox(broken, "новый текст"), "пропавшее тело плашки уронило модуль");
  });
}

// ── Сегменты ответа: лог «текст → действия → текст» (этап 3.7, часть 2) ─────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ: после действия текст идёт НОВЫМ
// сообщением ниже блока действий, а не дописывается в пузырь сверху; пустой
// сегмент убирается из данных, из DOM и из сессии; сегменты запуска собираются по
// порядку. Сессия приходит ЖИВОЙ функцией — проверяем и это.
async function testChatEvents() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-events.js"), "utf8");

  // ── Игрушечное окружение: настоящие id разметки, заглушки модулей, живые доступы ──
  function buildEnv(opts) {
    const o = opts || {};
    const mkNode = (id) => {
      const cls = new Set();
      const node = {
        id: id, value: "", textContent: "", className: "", src: "", alt: "",
        style: {}, children: [], _html: "", _q: null, removed: false,
        classList: {
          add: (...cs) => cs.forEach((c) => cls.add(c)),
          remove: (...cs) => cs.forEach((c) => cls.delete(c)),
          contains: (c) => cls.has(c),
          toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
          has: (c) => cls.has(c),
        },
        appendChild(c) { node.children.push(c); return c; },
        remove() { node.removed = true; },
        querySelector(sel) { return sel === ".yc-loading" ? node._q : null; },
        querySelectorAll() { return []; },
        addEventListener() {}, focus() {}, click() {},
      };
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        get() { return node._html; },
        set(v) { node._html = String(v == null ? "" : v); node.children.length = 0; },
      });
      return node;
    };
    const els = new Map();
    const $ = (id) => { if (!els.has(id)) els.set(id, mkNode(id)); return els.get(id); };

    let session = o.session === undefined ? { chatId: "c1", assistantId: "a1" } : o.session;
    let settings = { openaiActiveProfile: "p0" };
    let chatsData = { chats: o.chats || [] };
    let lastUndoCount = 0;
    let planCollapsed = true;
    let remoteRunNotified = false;

    const spy = {
      toast: [], persisted: 0, scroll: 0, scrollSoon: 0, queued: [], rendered: 0,
      ensureSeg: 0, thinkBox: 0, planFromModel: [], planAdvance: 0, planFinish: 0,
      planOutcome: 0, planText: 0, planPanel: 0, planSet: [], addRow: [], planAdd: [],
      built: [], refreshed: [], openAsk: [], closedAsk: 0, context: [], mission: [],
      tasksRendered: 0, flushed: 0, sidePanel: [], projectRefresh: [], deploy: [], timers: [], resume: [], resumeHidden: 0,
      settingsSaved: 0, getSettingsCalls: 0, answer: [],
    };
    const msgEls = new Map();
    const autoQueue = [];
    const seg = { id: "s1", role: "assistant", content: "", pending: true };

    const sandbox = {
      module: { exports: {} },
      self: {},
      console: { log() {}, warn() {}, error() {} },
      document: { getElementById: $, createElement: (tag) => mkNode(tag), querySelectorAll: () => [], addEventListener() {} },
      setTimeout: (fn) => { spy.timers.push(fn); },
    };
    sandbox.window = o.deployPanel === undefined ? { DeployPanel: { onStage: (s) => spy.deploy.push(s), onDone: (e) => spy.deploy.push(e) } } : { DeployPanel: o.deployPanel };
    vm.runInNewContext(src, sandbox, { filename: "chat-events.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");

    const deps = {
      $: $,
      api: Object.assign({
        answerQuestion: (t) => spy.answer.push(t),
        getSettings: async () => ({ openaiActiveProfile: "p9", model: "m", image: {} }),
      }, o.api),
      isElectron: o.isElectron === undefined ? true : o.isElectron,
      uid: (() => { let n = 0; return () => "id" + ++n; })(),
      toast: (t) => spy.toast.push(t),
      normalize: (s) => Object.assign({}, s, { model: "нормализовано" }),
      getSettings: () => { spy.getSettingsCalls++; return settings; },
      setSettings: (s) => { settings = s; spy.settingsSaved++; },
      getChatsData: () => chatsData,
      getSession: () => session,
      setLastUndoCount: (v) => { lastUndoCount = v; },
      setPlanCollapsed: (v) => { planCollapsed = v; },
      getRemoteRunNotified: () => remoteRunNotified,
      setRemoteRunNotified: (v) => { remoteRunNotified = v; },
      msgEls: msgEls,
      autoQueue: autoQueue,
      flushAutoQueue: () => { spy.flushed++; },
      persistChatsSoon: () => { spy.persisted++; },
      buildMessageEl: (m) => { spy.built.push(m.id); return mkNode("msg-" + m.id); },
      refreshMessage: (m) => spy.refreshed.push(m && m.id),
      openAskModal: (q, options, cb) => {
        if (typeof options === "function") {
          cb = options;
          options = [];
        }
        spy.openAsk.push({ q: q, options: options, cb: cb });
      },
      closeAskModal: () => { spy.closedAsk++; },
      renderContext: (ev) => spy.context.push(ev),
      planFromModel: (chat, ev) => { spy.planFromModel.push(ev); return o.planFromModel === undefined ? true : o.planFromModel; },
      planTextAdvance: () => { spy.planAdvance++; return true; },
      planTextFinish: () => { spy.planFinish++; return o.planFinish === undefined ? true : o.planFinish; },
      planToolOutcome: () => { spy.planOutcome++; return true; },
      tryPlanFromRunText: () => { spy.planText++; },
      renderPlanPanel: () => { spy.planPanel++; },
      ChatSegments: {
        ensureSegmentForText: () => { spy.ensureSeg++; return seg; },
        runSegments: () => [seg],
      },
      ChatFeed: {
        queueBubbleRender: (chat, s) => spy.queued.push(s.id),
        scrollBottom: () => { spy.scroll++; },
        scrollBottomSoon: () => { spy.scrollSoon++; },
      },
      ChatThinking: { ensureThinkBox: () => { spy.thinkBox++; } },
      ChatWork: {
        addRow: (el) => spy.addRow.push(el && el.id),
        planAdd: (ev) => spy.planAdd.push(ev.name),
        planSet: (ev, ok) => spy.planSet.push(ev.name + ":" + ok),
      },
      getSidePanel: () => ({ openSidePanel: (t) => spy.sidePanel.push(t), previewOpen: (u) => spy.sidePanel.push(u) }),
      getTasksMission: () => ({ renderTasks: () => { spy.tasksRendered++; }, missionFromEvent: (ev) => spy.mission.push(ev.type) }),
      getProjectPanel: () => ({ setFileViewPath: () => {}, refreshProject: () => spy.projectRefresh.push(1) }),
      // Кнопка «Продолжить» после остановки: модуль прогона объявлен в окне ниже,
      // поэтому событие зовёт его отложенной стрелкой.
      getChatRun: () => ({ showResume: (r) => spy.resume.push(r), hideResume: () => { spy.resumeHidden++; } }),
    };
    const ev = sandbox.module.exports(deps);
    return {
      onAiEvent: ev.onAiEvent, $: $, els: els, spy: spy, seg: seg, msgEls: msgEls, autoQueue: autoQueue,
      getSession: () => session, setSession: (v) => { session = v; },
      getSettings: () => settings, setChatsData: (v) => { chatsData = v; },
      getChatsData: () => chatsData, getLastUndoCount: () => lastUndoCount,
      getPlanCollapsed: () => planCollapsed, getRemoteRunNotified: () => remoteRunNotified,
    };
  }

  const chatWith = () => {
    const aMsg = { id: "a1", role: "assistant", content: "", pending: true };
    return { chat: { id: "c1", messages: [aMsg] }, aMsg: aMsg };
  };

  await test("события агента: модуль на месте, а оболочка только собирает его", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-events.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-events.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-events.js подключён после app.js");
    assert.ok(/"chat-events\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")), "мост не отдаёт chat-events.js телефону");

    const appSrc = uiFile("app.js");
    for (const gone of ["function onAiEvent", "function showImageOverlay", "function showPatchOverlay", "function showPreviewOverlay"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код событий остался в app.js: " + gone);
    }
    assert.ok(!/(^|[^.\w$])onAiEvent\b/.test(appSrc), "в app.js осталось голое имя onAiEvent");
    assert.ok(/api\.onAiEvent\(ChatEvents\.onAiEvent\);/.test(appSrc), "подписка на события агента потерялась");
    assert.ok(/onEvent: ChatEvents\.onAiEvent,/.test(appSrc), "веб-режим больше не получает обработчик событий");

    // Границы модуля: переприсваиваемое состояние — только живым доступом.
    for (const name of ["settings", "chatsData", "session", "lastUndoCount", "planCollapsed", "remoteRunNotified"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль читает " + name + " напрямую вместо живого доступа");
    }
    for (const pair of [["SidePanel.", "getSidePanel()"], ["TasksMission.", "getTasksMission()"], ["ProjectPanel.", "getProjectPanel()"], ["ChatRun.", "getChatRun()"]]) {
      assert.ok(src.indexOf(pair[0]) === -1, "модуль зовёт " + pair[0] + " напрямую вместо " + pair[1]);
    }
    assert.ok(!/window\.api\b|localStorage/.test(src), "модуль лезет в чужие глобалы");

    const wiring = uiFind("  const ChatEvents = window.ChatEvents({", "  // ─── Правая панель").code;
    for (const dep of ["getSettings: () => settings", "setSettings: (s) => { settings = s; }", "getChatsData: () => chatsData",
      "getSession: () => session", "setLastUndoCount: (v) => { lastUndoCount = v; }", "setPlanCollapsed: (v) => PlanPanel.setPlanCollapsed(v)",
      "getRemoteRunNotified: () => remoteRunNotified", "setRemoteRunNotified: (v) => { remoteRunNotified = v; }",
      "getSidePanel: () => SidePanel", "getTasksMission: () => TasksMission", "getProjectPanel: () => ProjectPanel",
      "getChatRun: () => ChatRun"]) {
      assert.ok(wiring.includes(dep), "в проводку не передан " + dep);
    }
  });

  await test("события агента: текст, размышления, план, действия и итоги", () => {
    const env = buildEnv();
    const { chat, aMsg } = chatWith();
    env.setChatsData({ chats: [chat] });

    // Служебная заметка и напоминания — тостом, без чата.
    env.onAiEvent({ type: "notice", text: "Ждём лимит провайдера" });
    assert.deepStrictEqual(env.spy.toast, ["Ждём лимит провайдера"], "заметка прогона не показана тостом");
    env.onAiEvent({ type: "task-reminder", tasks: [{ title: "Позвонить", late: true }] });
    assert.ok(/Просрочено: Позвонить/.test(env.spy.toast[1] || ""), "напоминание о деле не показано: " + env.spy.toast[1]);
    assert.strictEqual(env.spy.tasksRendered, 1, "панель дел не обновилась по напоминанию");
    env.onAiEvent({ type: "task-auto-failed", tasks: [{ title: "Отчёт", error: "нет ключа" }] });
    assert.ok(/не запустилась/.test(env.spy.toast[2] || "") && /нет ключа/.test(env.spy.toast[2] || ""), "провал автозадачи не объяснён: " + env.spy.toast[2]);

    // Текст: сегмент, сохранение, очередь кадра, разбор плана из текста.
    env.seg.content = "";
    env.onAiEvent({ type: "chunk", text: "привет" });
    assert.strictEqual(env.seg.content, "привет", "текст не попал в сегмент ответа");
    assert.strictEqual(env.spy.persisted, 1, "история не сохраняется по ходу стрима");
    assert.deepStrictEqual(env.spy.queued, ["s1"], "отрисовка идёт не через очередь кадра");
    assert.ok(env.spy.planText > 0, "текстовый план не разбирается по стриму");

    // Размышления: свой блок в элементе сообщения.
    const el = { id: "s1" };
    env.msgEls.set("s1", el);
    env.onAiEvent({ type: "thinking", text: "думаю" });
    assert.strictEqual(env.seg.thinking, "думаю", "размышления не попали в сегмент");
    assert.strictEqual(env.spy.thinkBox, 1, "блок размышлений не открыт");
    assert.ok(env.spy.scrollSoon > 0, "прокрутка при размышлениях не запрошена");

    // План от модели: панель разворачивается сама.
    env.onAiEvent({ type: "plan", tasks: [{ text: "Шаг", status: "in_progress" }] });
    assert.strictEqual(env.getPlanCollapsed(), false, "панель плана осталась свёрнутой");
    assert.ok(env.spy.planPanel > 0, "панель плана не перерисована");

    // Действие: своё сообщение, класс «в работе», строка действия.
    chat.plan = { source: "text", items: [{ text: "Шаг", status: "pending" }] };
    env.onAiEvent({ type: "tool_start", name: "readFile", args: { path: "a.txt" } });
    const tool = chat.messages[chat.messages.length - 1];
    assert.strictEqual(tool.role, "tool", "действие не стало сообщением");
    assert.strictEqual(tool.toolName, "readFile", "имя инструмента потерялось");
    assert.deepStrictEqual(tool.toolArgs, { path: "a.txt" }, "аргументы инструмента потерялись");
    assert.strictEqual(tool.pending, true, "действие не помечено незавершённым");
    assert.deepStrictEqual(env.spy.addRow, ["msg-" + tool.id], "строка действия не показана");
    assert.deepStrictEqual(env.spy.planAdd, ["readFile"], "действие не попало в группу работ");
    assert.strictEqual(env.spy.planAdvance, 1, "шаг текстового плана не отмечен «в работе»");

    // Итог действия: сообщение закрывается, план сверяет шаг, панель проекта подтягивается.
    env.$("project-panel").classList.remove("hidden");
    env.onAiEvent({ type: "tool_result", name: "readFile", result: "готово" });
    assert.strictEqual(tool.pending, false, "действие осталось незавершённым");
    assert.strictEqual(tool.toolResult, "готово", "итог действия не записан");
    assert.strictEqual(tool.toolOk, true, "успешный итог помечен провалом");
    assert.deepStrictEqual(env.spy.refreshed, [tool.id], "сообщение не перерисовано");
    assert.deepStrictEqual(env.spy.planSet, ["readFile:true"], "панель действий не сверена с итогом");
    // Провал действия читается по тексту результата.
    env.onAiEvent({ type: "tool_start", name: "runCommand", args: {} });
    env.onAiEvent({ type: "tool_result", name: "runCommand", result: "Ошибка: не нашёл команду" });
    assert.deepStrictEqual(env.spy.planSet[1], "runCommand:false", "провал действия не распознан");
    // Команда тоже подтягивает панель проекта — она в этой проверке открыта.
    assert.strictEqual(env.spy.timers.length, 1, "обновление панели проекта не запланировано после команды");
    env.spy.timers.pop()();
    assert.strictEqual(env.spy.projectRefresh.length, 1, "панель проекта не обновилась после команды");
    // Правка файлов подтягивает панель проекта — только если она открыта.
    env.onAiEvent({ type: "tool_start", name: "writeFile", args: { path: "b.txt" } });
    env.onAiEvent({ type: "tool_result", name: "writeFile", result: "файл записан" });
    assert.strictEqual(env.spy.timers.length, 1, "обновление панели проекта не запланировано после правки файла");
    env.spy.timers.pop()();
    assert.strictEqual(env.spy.projectRefresh.length, 2, "панель проекта не обновилась после правки файла");
    env.$("project-panel").classList.add("hidden");
    env.onAiEvent({ type: "tool_start", name: "writeFile", args: { path: "c.txt" } });
    env.onAiEvent({ type: "tool_result", name: "writeFile", result: "файл записан" });
    assert.strictEqual(env.spy.timers.length, 0, "закрытая панель проекта всё равно обновляется");

    // Подмена текста (модель переписала ответ), плашки зрения и памяти, контекст.
    env.onAiEvent({ type: "text_override", text: "переписано" });
    assert.strictEqual(env.seg.content, "переписано", "переписанный текст не заменил ответ");
    env.onAiEvent({ type: "vision", text: "смотрю картинку" });
    env.onAiEvent({ type: "memory", text: "запомнил" });
    env.onAiEvent({ type: "compact", text: "сжал контекст" });
    assert.strictEqual(env.$("messages").children.length, 3, "плашки зрения/памяти/сжатия не показаны");
    env.onAiEvent({ type: "context", used: 10 });
    assert.strictEqual(env.spy.context.length, 1, "событие контекста не дошло до отрисовки");

    // Вопрос агента, завершение и падение прогона.
    env.onAiEvent({ type: "ask", question: "Какой файл?", options: ["a.txt", "b.txt"] });
    assert.strictEqual(env.spy.openAsk[0].q, "Какой файл?", "вопрос агента не показан");
    assert.deepStrictEqual(env.spy.openAsk[0].options, ["a.txt", "b.txt"], "варианты ответа не доехали до окна");
    assert.strictEqual(typeof env.spy.openAsk[0].cb, "function", "ответу некуда уйти: обработчик потерялся");
    env.spy.openAsk[0].cb("a.txt");
    assert.deepStrictEqual(env.spy.answer, ["a.txt"], "ответ на вопрос агента не ушёл в главный процесс");
    // Остановка с сохранённой работой (лимит раундов, «Стоп», пауза миссии): кнопку
    // «Продолжить» в окне зажигает СВОЁ событие прогона, а не разбор текста ответа.
    env.onAiEvent({ type: "resume", reason: "лимит раундов" });
    assert.deepStrictEqual(env.spy.resume, ["лимит раундов"], "событие продолжения не зажгло кнопку: " + JSON.stringify(env.spy.resume));
    assert.strictEqual(env.spy.resumeHidden, 0, "кнопку спрятали сразу после показа");
    env.onAiEvent({ type: "done" });
    assert.ok(env.spy.planFinish > 0 && env.spy.planPanel > 1, "финиш запуска не закрыл шаг текстового плана");
    env.onAiEvent({ type: "error", message: "сеть отвалилась" });
    assert.strictEqual(env.spy.closedAsk, 1, "модалка вопроса не закрыта при падении");
    assert.strictEqual(env.seg.pending, false, "сегмент остался незавершённым при падении");
    assert.strictEqual(env.seg.error, "сеть отвалилась", "причина падения не записана");
    env.onAiEvent({ type: "undo_available", count: 5 });
    assert.strictEqual(env.getLastUndoCount(), 5, "счётчик откатов не ушёл в оболочку");
    env.onAiEvent({ type: "mission", step: 2 });
    assert.deepStrictEqual(env.spy.mission, ["mission"], "событие миссии не дошло до панели");
  });

  await test("события агента: автозадачи, чужой прогон, профили, оверлеи и деплой", async () => {
    const env = buildEnv({ isElectron: true });
    const { chat } = chatWith();
    env.setChatsData({ chats: [chat] });

    // Срок автозадачи: одно и то же дело в очередь один раз, и только на ПК.
    env.onAiEvent({ type: "task-due", tasks: [{ id: "t1", title: "Отчёт" }, { id: "t1", title: "Отчёт" }] });
    env.onAiEvent({ type: "task-due", tasks: [{ id: "t1", title: "Отчёт" }] });
    assert.deepStrictEqual(env.autoQueue.map((t) => t.id), ["t1"], "дело попало в очередь дважды: " + JSON.stringify(env.autoQueue));
    assert.strictEqual(env.spy.flushed, 2, "очередь автозадач не запускается");
    const web = buildEnv({ isElectron: false });
    web.onAiEvent({ type: "task-due", tasks: [{ id: "t1" }] });
    assert.strictEqual(web.autoQueue.length, 0, "в веб-режиме окно пытается запускать автозадачи");

    // Чужой прогон (с телефона) в открытый чат не подмешивается — и говорится один раз.
    env.setSession(null);
    env.onAiEvent({ type: "chunk", from: "mobile", text: "чужой текст" });
    assert.strictEqual(env.spy.toast.filter((t) => /с телефона/.test(t)).length, 1, "про чужой прогон не сказано");
    env.onAiEvent({ type: "chunk", from: "mobile", text: "ещё" });
    assert.strictEqual(env.spy.toast.filter((t) => /с телефона/.test(t)).length, 1, "про чужой прогон сказано дважды");
    assert.strictEqual(env.getRemoteRunNotified(), true, "отметка о чужом прогоне живёт только внутри модуля");
    assert.strictEqual(env.seg.content, "", "чужой текст подмешался в текущий чат");
    // Со своей сессией событие идёт в работу как обычно.
    env.setSession({ chatId: "c1", assistantId: "a1" });
    env.onAiEvent({ type: "chunk", from: "mobile", text: "свой" });
    assert.strictEqual(env.seg.content, "свой", "свой прогон перестал обрабатываться");

    // Переключение профиля: сообщение в чат, живые настройки, вычитка из главного процесса.
    env.onAiEvent({ type: "profile_switched", name: "Второй", id: "p2", error: "кончились средства" });
    const sys = chat.messages[chat.messages.length - 1];
    assert.strictEqual(sys.role, "system", "про переключение не написано в чат");
    assert.ok(/Второй/.test(sys.content) && /кончились средства/.test(sys.content), "в сообщении нет причины и имени профиля: " + sys.content);
    assert.strictEqual(env.getSettings().openaiActiveProfile, "p2", "активный профиль не переключился");
    assert.ok(/Второй/.test(env.spy.toast.join(" ")), "про переключение не сообщено тостом");
    // Настройки из главного процесса перечитываются и заново кладутся в оболочку
    // (setSettings) — это промис, поэтому ждём тик, а не верим на слово.
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(env.spy.getSettingsCalls > 0, true, "настройки читаются не живьём");
    assert.strictEqual(env.spy.settingsSaved, 1, "прочитанные настройки не вернулись в оболочку");
    assert.strictEqual(env.getSettings().model, "нормализовано", "настройки не прошли normalize");

    // Оверлеи: картинка, дифф, предпросмотр.
    env.onAiEvent({ type: "image", path: "/tmp/кот.png", dataUrl: "data:image/png;base64,AAA" });
    assert.ok(!env.$("file-overlay").classList.contains("hidden"), "оверлей картинки не открылся");
    assert.strictEqual(env.$("file-path").textContent, "/tmp/кот.png", "имя файла картинки не показано");
    assert.ok(env.$("btn-file-edit").classList.contains("hidden") && env.$("btn-file-save").classList.contains("hidden"), "у картинки остались кнопки правки файла");
    const img = env.$("file-content").children[0];
    assert.strictEqual(img.src, "data:image/png;base64,AAA", "картинка не попала в оверлей");

    env.onAiEvent({ type: "diff", a: "старый", b: "новый", patch: "--- a\n+++ b\n@@ -1 +1 @@\n-было\n+стало\nконец" });
    assert.strictEqual(env.$("file-path").textContent, "старый  ↔  новый", "заголовок диффа не показан");
    const lines = env.$("file-content").children[0].children;
    assert.strictEqual(lines.length, 6, "строки диффа потерялись: " + lines.length);
    assert.ok(/\bmeta\b/.test(lines[0].className) && /\bdel\b/.test(lines[3].className) && /\badd\b/.test(lines[4].className), "строки диффа не разрисованы по видам: " + lines.map((l) => l.className).join(" | "));

    env.onAiEvent({ type: "preview", url: "http://localhost:5000" });
    assert.deepStrictEqual(env.spy.sidePanel, ["preview", "http://localhost:5000"], "предпросмотр не открыл правую панель с адресом");

    // Стадии деплоя и шаги подключения к облаку.
    env.onAiEvent({ type: "deploy_stage", stage: { id: "build" } });
    env.onAiEvent({ type: "deploy_done", ok: true });
    assert.strictEqual(env.spy.deploy.length, 2, "стадии деплоя не дошли до панели");
    const steps = env.$("yc-deploy-steps");
    steps._q = { remove() { steps._q.removed = true; } };
    env.$("yc-deploy-box").classList.remove("hidden");
    env.onAiEvent({ type: "yc_step", text: "Создаю контейнер" });
    assert.strictEqual(steps._q.removed, true, "надпись «идёт» не убрана перед шагом");
    assert.strictEqual(steps.children.length, 1, "шаг подключения не показан");
    assert.strictEqual(steps.children[0].textContent, "Создаю контейнер", "текст шага потерялся");
    // Панель деплоя может отсутствовать — событие не должно падать.
    const noPanel = buildEnv({ deployPanel: null });
    noPanel.onAiEvent({ type: "deploy_stage", stage: { id: "x" } });
    noPanel.onAiEvent({ type: "deploy_done", ok: true });
    assert.strictEqual(noPanel.spy.deploy.length, 0, "без панели деплоя события не должны ничего ломать");
  });
}

async function testChatSegments() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-segments.js"), "utf8");

  await test("сегменты ответа: текст после действия открывает новое сообщение", () => {
    // 1. Модуль на месте, подключён до app.js, отдаётся телефону, собран в оболочке.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-segments.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-segments.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-segments.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"chat-segments\.js"/.test(bridge), "мобильный мост не отдаёт chat-segments.js телефону");
    const appSrc = uiFile("app.js");
    for (const gone of ["function ensureSegmentForText", "function removeSegment", "function runSegments"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код сегментов остался в app.js: " + gone);
    }
    const wiring = appSrc.slice(appSrc.indexOf("window.ChatSegments({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of ["$: $", "uid: uid", "getSession: () => session", "msgEls: msgEls", "buildMessageEl: buildMessageEl", "scrollBottom: ChatFeed.scrollBottom", "persistChatsSoon: ChatStore.persistChatsSoon", "planRoundStarted: PlanPanel.planRoundStarted"]) {
      assert.ok(wiringCall.includes(dep), "в проводку сегментов не передан " + dep);
    }
    // Границы модуля: сессия только живой функцией, в чужие глобалы не лезем.
    assert.ok(!/(^|[^\w$."])session\b/.test(src), "модуль читает session напрямую вместо getSession()");
    assert.ok(!/AgentCore|window\.api\b|localStorage/.test(src), "модуль лезет в чужие глобалы");

    // 2. Среда: живые настройки-сессия снаружи, карта элементов, счётчик вызовов.
    const makeEl = () => {
      const node = {
        children: [], parentNode: null,
        appendChild(child) { node.children.push(child); child.parentNode = node; return child; },
        removeChild(child) { node.children = node.children.filter((c) => c !== child); child.parentNode = null; },
      };
      return node;
    };
    let session = { chatId: "c1", segmentIds: [] };
    let seq = 0;
    const calls = { plan: [], scroll: 0, persist: 0, built: [] };
    const msgEls = new Map();
    const messages = makeEl();
    const build = (deps) => {
      const sandbox = { module: { exports: {} }, self: {}, console: { warn() {}, log() {}, error() {} } };
      vm.runInNewContext(src, sandbox, { filename: "chat-segments.js" });
      assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
      return sandbox.module.exports(deps);
    };
    const deps = {
      $: () => messages,
      uid: () => "seg" + ++seq,
      getSession: () => session,
      msgEls: msgEls,
      buildMessageEl: (m) => { calls.built.push(m.id); return makeEl(); },
      scrollBottom: () => { calls.scroll++; },
      persistChatsSoon: () => { calls.persist++; },
      planRoundStarted: (chat, id) => calls.plan.push(id),
    };
    const seg = build(deps);
    assert.deepStrictEqual(Object.keys(seg).sort(), ["ensureSegmentForText", "removeSegment", "runSegments"],
      "наружу торчит лишнее или чего-то не хватает");

    // 3. Текст БЕЗ действия дописывается в текущий сегмент запуска.
    const first = { id: "s1", role: "assistant", content: "", pending: true };
    const chat = { id: "c1", messages: [first] };
    session = { chatId: "c1", segmentIds: ["s1"] };
    assert.strictEqual(seg.ensureSegmentForText(chat, first), first, "текст без действия открыл лишнее сообщение");
    assert.strictEqual(chat.messages.length, 1, "лишнее сообщение всё-таки появилось");

    // 4. Текст ПОСЛЕ действия — новое сообщение в конец (ниже блока действий).
    chat.messages.push({ id: "t1", role: "tool", toolName: "runCommand" });
    const created = seg.ensureSegmentForText(chat, first);
    assert.ok(created && created !== first, "текст после действия дописан в пузырь сверху");
    assert.strictEqual(chat.messages[chat.messages.length - 1], created, "новое сообщение не встало в конец");
    assert.strictEqual(created.role, "assistant", "новое сообщение не от ассистента");
    assert.strictEqual(created.content, "", "новое сообщение не пустое для стрима");
    assert.strictEqual(created.pending, true, "новое сообщение не помечено как незавершённое");
    assert.deepStrictEqual(session.segmentIds, ["s1", created.id], "сегмент не попал в сессию запуска");
    assert.deepStrictEqual(calls.plan, [created.id], "новый раунд не отметился для текстового плана");
    assert.deepStrictEqual(calls.built, [created.id], "элемент сообщения не собран");
    assert.strictEqual(messages.children.length, 1, "элемент не добавлен в ленту сообщений");
    assert.ok(calls.scroll > 0, "лента не прокрутилась к новому сообщению");

    // 5. Сессия читается ЖИВОЙ: подменили объект снаружи — модуль видит новый.
    const second = { id: "s2", role: "assistant", content: "", pending: true };
    const chat2 = { id: "c2", messages: [second] };
    session = { chatId: "c2", segmentIds: ["s2"] };
    assert.strictEqual(seg.ensureSegmentForText(chat2, second), second, "модуль работал с копией сессии");
    // Чужой сегмент (не из текущего запуска) не трогаем: возвращаем запасной.
    const other = { id: "s9", role: "assistant", content: "старое" };
    const chat3 = { id: "c3", messages: [other] };
    assert.strictEqual(seg.ensureSegmentForText(chat3, second), second, "модуль дописал в чужой сегмент");
    // Пустой чат и совсем без сессии — без падений.
    assert.strictEqual(seg.ensureSegmentForText(null, second), second, "без чата не вернулся запасной сегмент");
    session = null;
    const chat4 = { id: "c4", messages: [{ id: "t2", role: "tool", toolName: "readFile" }] };
    const soloSeg = seg.ensureSegmentForText(chat4, null);
    assert.ok(soloSeg && soloSeg.role === "assistant", "без сессии новый сегмент не создался");

    // 6. Пустой сегмент убирается отовсюду: из данных, из DOM и из сессии.
    session = { chatId: "c1", segmentIds: [created.id] };
    const emptyChat = { id: "c1", messages: [first, { id: "t1", role: "tool" }, created] };
    const el = makeEl();
    messages.appendChild(el);
    msgEls.set(created.id, el);
    seg.removeSegment(emptyChat, created);
    assert.strictEqual(emptyChat.messages.indexOf(created), -1, "пустой сегмент остался в истории");
    assert.strictEqual(msgEls.has(created.id), false, "пустой сегмент остался в карте элементов");
    assert.strictEqual(el.parentNode, null, "элемент пустого сегмента остался в ленте");
    assert.deepStrictEqual(session.segmentIds, [], "пустой сегмент остался в сессии запуска");
    assert.ok(calls.persist > 0, "история не сохранена после удаления");
    seg.removeSegment(emptyChat, { id: "нет такого" }); // тихо, без исключений

    // 7. Сегменты запуска — по порядку id, с запасным вариантом.
    const a = { id: "a1", role: "assistant", content: "раз" };
    const b = { id: "b1", role: "assistant", content: "два" };
    const runChat = { id: "c5", messages: [b, a] }; // в истории лежат вразнобой
    session = { chatId: "c5", segmentIds: ["a1", "b1"] };
    // Модуль живёт в своём окружении (vm): его массив приводим к своему, иначе
    // строгое сравнение ругается на разные прототипы, а не на порядок.
    assert.deepStrictEqual(Array.from(seg.runSegments(runChat, a), (s) => s.id), ["a1", "b1"], "порядок сегментов поехал");
    session = { chatId: "c5", segmentIds: [] };
    assert.deepStrictEqual(Array.from(seg.runSegments(runChat, a)), [a], "без сегментов не вернулся запасной");
    session = null;
    assert.deepStrictEqual(Array.from(seg.runSegments(runChat, a)), [a], "без сессии не вернулся запасной");
    assert.deepStrictEqual(Array.from(seg.runSegments(runChat, null)), [], "пустой запасной не отфильтрован");

    // 8. Негативный контроль зависимостей: без getSession модуль падает понятно.
    const noSession = build({
      $: deps.$, uid: deps.uid, msgEls: msgEls, buildMessageEl: deps.buildMessageEl,
      scrollBottom: deps.scrollBottom, persistChatsSoon: deps.persistChatsSoon, planRoundStarted: deps.planRoundStarted,
    });
    assert.throws(() => noSession.ensureSegmentForText({ messages: [] }, null), /getSession/, "забытая зависимость не привела к понятной ошибке");
  });
}

// ── Отрисовка сообщения: текст, вложения, кнопки (этап 3.7, часть 3) ────────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ: как содержимое превращается в
// текст и в разметку (в том числе картинки-вложения), какие классы получает пузырь,
// какие кнопки появляются под сообщением и что они на самом деле делают.
// Отдельно — прерванный ответ: кнопка обязана уйти в главный процесс с ЖИВЫМИ
// данными чатов (именно здесь вынос оставил «голое» имя chatsData, и это падало
// бы у человека, а не в тестах).
async function testChatRender() {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-render.js"), "utf8");

  await test("отрисовка сообщения: содержимое, классы и кнопки работают, как раньше", () => {
    // 1. Разметка, мост, оболочка.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-render.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-render.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-render.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"chat-render\.js"/.test(bridge), "мобильный мост не отдаёт chat-render.js телефону");
    const appSrc = uiFile("app.js");
    for (const gone of ["function msgText", "function msgHtml", "function buildBubbleEl"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код отрисовки остался в app.js: " + gone);
    }
    // Проводка: собрана ПОСЛЕ действий чата — иначе ChatActions в этот момент пуст.
    const wiringAt = appSrc.indexOf("window.ChatRender({");
    const actionsAt = appSrc.indexOf("window.ChatActions({");
    assert.ok(wiringAt > 0 && wiringAt > actionsAt, "отрисовка собрана раньше действий чата");
    const wiringCall = appSrc.slice(wiringAt, appSrc.indexOf("});", wiringAt));
    for (const dep of ["MdRender: MdRender", "fmtClock: fmtClock", "ChatThinking: ChatThinking", "ChatActions: ChatActions", "continueInterruptedAnswer: ChatSend.continueInterruptedAnswer", "getChatsData: () => chatsData"]) {
      assert.ok(wiringCall.includes(dep), "в проводке отрисовки нет " + dep);
    }
    // Границы модуля: чужие имена берём только из deps. Это дешёвая родня
    // бэкенд-стража «ни одного имени из main.js без внедрения».
    for (const name of ["chatsData", "session", "streaming", "msgEls", "pinnedToBottom"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }
    // Часть вызовов после разбора app.js живёт в модулях: готовый ответ рисует
    // chat-run.js. Считаем по обоим файлам — проверка про вызовы, а не про адрес.
    const renderCallers = appSrc + "\n" + fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-run.js"), "utf8");
    const calls = (renderCallers.match(/ChatRender\.\w+/g) || []).sort();
    assert.deepStrictEqual(calls, ["ChatRender.buildBubbleEl", "ChatRender.msgHtml", "ChatRender.msgHtml", "ChatRender.msgText", "ChatRender.msgText"],
      "вызовов модуля не пять ожидаемых: " + calls.join(", "));

    // 2. Среда: заглушка DOM и живые зависимости.
    const el = () => {
      const classes = new Set();
      const node = {
        type: "", className: "", title: "", textContent: "", innerHTML: "", onclick: null,
        children: [], parentNode: null,
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !classes.has(c) : !!on;
            if (want) classes.add(c); else classes.delete(c);
            return want;
          },
        },
        appendChild(child) { node.children.push(child); child.parentNode = node; return child; },
        removeChild(child) { node.children = node.children.filter((c) => c !== child); child.parentNode = null; },
      };
      return node;
    };
    const spy = { rendered: [], restored: [], copied: [], regenerated: 0, edited: 0, continued: [] };
    const chats = { activeId: "chat-1" };
    const MdRender = { render: (t) => { spy.rendered.push(t); return "<md>" + t + "</md>"; }, esc: (s) => String(s).replace(/</g, "&lt;") };
    const sandbox = { module: { exports: {} }, self: {}, console: { warn() {}, log() {}, error() {} }, document: { createElement: () => el() } };
    vm.runInNewContext(src, sandbox, { filename: "chat-render.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
    const render = sandbox.module.exports({
      MdRender: MdRender,
      fmtClock: (ts) => "в " + ts,
      ChatThinking: { restoreThinkBox: (node, text, pending) => { spy.restored.push([text, pending]); return node; } },
      ChatActions: {
        copyText: (t) => spy.copied.push(t),
        isLastAssistant: (m) => m.last === true,
        regenerate: () => { spy.regenerated++; },
        editUserMessage: () => { spy.edited++; },
      },
      continueInterruptedAnswer: (id, m) => spy.continued.push([id, m]),
      getChatsData: () => chats,
    });
    assert.deepStrictEqual(Object.keys(render).sort(), ["buildBubbleEl", "msgHtml", "msgText"], "наружу торчит лишнее или чего-то не хватает");
    const byClass = (node, cls) => (node.children || []).filter((c) => String(c.className).split(/\s+/).indexOf(cls) !== -1);
    const first = (node, cls) => byClass(node, cls)[0];

    // 3. Содержимое: строка, части с картинками, пустое и мусор.
    assert.strictEqual(render.msgText("привет"), "привет", "строка не отдана как есть");
    assert.strictEqual(render.msgText([{ type: "text", text: "раз" }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: "два" }]), "раз\nдва", "текстовые части не склеены");
    assert.strictEqual(render.msgText(null), "", "пустое содержимое не отдано пустой строкой");
    assert.strictEqual(render.msgText([{ type: "image_url", image_url: { url: "x" } }]), "", "картинка без текста дала текст");
    assert.ok(render.msgHtml("жирный").indexOf("<md>жирный</md>") === 0, "markdown не отрисован");
    const withImage = render.msgHtml([{ type: "image_url", image_url: { url: "http://x/1.png?a=<b>" } }, { type: "text", text: "подпись" }]);
    assert.ok(withImage.indexOf('class="md-attach"') > 0, "картинка не встроена в разметку");
    assert.ok(withImage.indexOf("&lt;b>") > 0, "адрес картинки не экранирован");
    assert.ok(withImage.indexOf("<md>подпись</md>") > 0, "подпись под картинкой потерялась");
    assert.strictEqual(render.msgHtml(null), "", "пустое содержимое дало разметку");

    // 4. Ошибка и незавершённый ответ: классы и содержимое.
    const failed = render.buildBubbleEl({ id: "e1", role: "assistant", error: "Не вышло" });
    assert.strictEqual(failed.className, "msg error", "у ошибки не тот класс сообщения");
    const failedBubble = first(failed, "bubble");
    assert.strictEqual(failedBubble.textContent, "Не вышло", "текст ошибки не показан");
    assert.ok(!failedBubble.classList.contains("md"), "ошибку отрисовали как markdown");
    assert.strictEqual(byClass(failed, "msg-actions").length, 0, "под ошибкой появились кнопки действий");
    const pending = render.buildBubbleEl({ id: "p1", role: "assistant", content: "пишу", pending: true });
    assert.strictEqual(first(pending, "bubble").className, "bubble pending", "незавершённый ответ потерял пометку");
    assert.strictEqual(byClass(pending, "msg-actions").length, 0, "у незавершённого ответа появились кнопки");

    // 5. Обычный ответ: markdown, метка времени, плашка размышлений, кнопки.
    const answer = render.buildBubbleEl({ id: "a1", role: "assistant", content: "готово", createdAt: 12345, thinking: "думал", last: true });
    assert.ok(first(answer, "bubble").classList.contains("md"), "ответ не помечен как markdown");
    assert.strictEqual(first(answer, "bubble").innerHTML, "<md>готово</md>", "текст ответа отрисован неверно");
    assert.strictEqual(first(answer, "meta").textContent, "в 12345", "метка времени не показана");
    assert.deepStrictEqual(spy.restored, [["думал", undefined]], "плашка размышлений не восстановлена");
    const answerButtons = byClass(first(answer, "msg-actions"), "ma-btn");
    assert.strictEqual(answerButtons.length, 2, "у последнего ответа должны быть «скопировать» и «перегенерировать»");
    answerButtons[0].onclick();
    assert.deepStrictEqual(spy.copied, ["готово"], "кнопка «скопировать» не отдала текст ответа");
    answerButtons[1].onclick();
    assert.strictEqual(spy.regenerated, 1, "кнопка «перегенерировать» не сработала");
    const older = render.buildBubbleEl({ id: "a2", role: "assistant", content: "раньше", last: false });
    assert.strictEqual(byClass(first(older, "msg-actions"), "ma-btn").length, 1, "у старого ответа осталась кнопка перегенерации");

    // 6. Своё сообщение: скопировать и вернуть в поле ввода.
    const mine = render.buildBubbleEl({ id: "u1", role: "user", content: "вопрос" });
    assert.ok(String(mine.className).indexOf("msg user") === 0, "у своего сообщения не тот класс");
    const mineButtons = byClass(first(mine, "msg-actions"), "ma-btn");
    assert.strictEqual(mineButtons.length, 2, "у своего сообщения не две кнопки");
    assert.ok(mineButtons[1].title.indexOf("Редактировать") === 0, "нет кнопки правки сообщения");
    mineButtons[1].onclick();
    assert.strictEqual(spy.edited, 1, "кнопка правки не сработала");

    // 7. Прерванный ответ: кнопка уходит в главный процесс с ЖИВЫМИ данными чатов.
    const interrupted = render.buildBubbleEl({ id: "s1", role: "system", interrupted: true, content: "прервано" });
    const continueRow = first(interrupted, "msg-actions");
    const continueBtn = continueRow && byClass(continueRow, "ma-btn")[0];
    assert.ok(continueBtn, "нет кнопки «Дописать ответ» у прерванного хода");
    assert.strictEqual(continueBtn.textContent, "↻ Дописать ответ", "кнопка продолжения подписана иначе");
    continueBtn.onclick({ stopPropagation: () => {} });
    assert.strictEqual(continueRow.parentNode, null, "кнопка не убрана после нажатия");
    assert.deepStrictEqual(spy.continued.map((c) => c[0]), ["chat-1"], "продолжение ушло без данных чатов");
    assert.strictEqual(spy.continued[0][1].id, "s1", "продолжение ушло не с тем сообщением");
    // Данные чатов читаются ЖИВОЙ функцией: подменили объект — модуль видит новый.
    chats.activeId = "chat-2";
    const again = render.buildBubbleEl({ id: "s2", role: "system", interrupted: true });
    byClass(first(again, "msg-actions"), "ma-btn")[0].onclick({ stopPropagation: () => {} });
    assert.strictEqual(spy.continued[1][0], "chat-2", "модуль работал с копией данных чатов");
    // Свой чат у сообщения важнее активного.
    const own = render.buildBubbleEl({ id: "s3", role: "system", interrupted: true, chatId: "chat-9" });
    byClass(first(own, "msg-actions"), "ma-btn")[0].onclick({ stopPropagation: () => {} });
    assert.strictEqual(spy.continued[2][0], "chat-9", "чат сообщения не учтён");

    // 8. Негативный контроль зависимостей: без часов панель падает понятной ошибкой.
    const noClock = sandbox.module.exports({
      MdRender: MdRender, ChatThinking: { restoreThinkBox: () => ({}) }, ChatActions: {},
      continueInterruptedAnswer: () => {}, getChatsData: () => chats,
    });
    assert.throws(() => noClock.buildBubbleEl({ role: "assistant", content: "текст", createdAt: 1 }), /fmtClock/,
      "забытая зависимость не привела к понятной ошибке");
  });
}

// ── 11. Хранение чатов: атомарная запись, .bak-восстановление, автосейв ──────
async function testChatPersistence() {
  // Функции хранения берём прямо из main.js (реальный код, не копия).
  // Код хранения чатов вынесен в src/settings-store.js (этап B, часть 5) — берём его
  // оттуда: это по-прежнему настоящий код, а не копия.
  const storeSrc = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
  const s0 = storeSrc.indexOf("// Чтение чатов:");
  const s1 = storeSrc.indexOf("\n  return {", s0);
  assert.ok(s0 > 0 && s1 > s0, "не нашёл функции хранения чатов в src/settings-store.js");
  const chatCode = storeSrc.slice(s0, s1);

  function makeStore(dir) {
    const chatMod = new Function(
      "fs",
      "path",
      "chatsFile",
      chatCode + "\nreturn { loadChats, saveChats };"
    );
    return chatMod(fs, path, () => path.join(dir, "chats.json"));
  }

  await test("chats: атомарная запись — нет .tmp, есть .bak, основной файл валиден", () => {
    const dir = tmpdir("chats-atomic-");
    const { loadChats, saveChats } = makeStore(dir);
    saveChats({ chats: [{ id: "a", messages: [{ role: "user", content: "1" }] }], activeId: "a" });
    assert.ok(fs.existsSync(path.join(dir, "chats.json")), "нет chats.json");
    assert.ok(!fs.existsSync(path.join(dir, "chats.json.tmp")), "остался chats.json.tmp");
    saveChats({ chats: [{ id: "b", messages: [] }], activeId: "b" });
    assert.ok(!fs.existsSync(path.join(dir, "chats.json.tmp")), "остался chats.json.tmp после 2-й записи");
    assert.ok(fs.existsSync(path.join(dir, "chats.json.bak")), "нет резервной копии .bak");
    assert.strictEqual(loadChats().activeId, "b");
  });

  await test("chats: обрезанный (битый) основной файл → история поднимается из .bak", () => {
    const dir = tmpdir("chats-recover-");
    const { loadChats, saveChats } = makeStore(dir);
    saveChats({ chats: [{ id: "keep", messages: [] }], activeId: "keep" });
    saveChats({ chats: [{ id: "new", messages: [] }], activeId: "new" });
    // Имитируем внезапное закрытие во время записи: файл обрезан.
    fs.writeFileSync(path.join(dir, "chats.json"), '{"chats": [{"id": "new"', "utf8");
    const loaded = loadChats();
    assert.strictEqual(loaded.activeId, "keep", "не восстановилось из .bak: " + JSON.stringify(loaded));
    assert.strictEqual(loaded.chats[0].id, "keep");
  });

  await test("chats: битый JSON без .bak → пустая история, без исключения", () => {
    const dir = tmpdir("chats-broken-");
    fs.writeFileSync(path.join(dir, "chats.json"), "не json", "utf8");
    const { loadChats } = makeStore(dir);
    assert.deepStrictEqual(loadChats(), { chats: [], activeId: null });
  });

  // Логику автосохранения ищем маркером по интерфейсу, а не по адресу файла:
  // после разбора app.js она живёт в chat-store.js, и тест не должен это знать.
  const autoAll = uiFind("  function persistChats() {", "  return {");
  assert.ok(autoAll.start > 0 && autoAll.end > autoAll.start, "не нашёл блок автосохранения чатов в " + autoAll.file);

  function makeAutosave(syncSupported) {
    const block = autoAll.code;
    const syncSaves = [];
    const asyncSaves = [];
    const timers = [];
    const handlers = { window: {}, document: {} };
    const win = { addEventListener: (n, cb) => { handlers.window[n] = cb; } };
    const doc = { addEventListener: (n, cb) => { handlers.document[n] = cb; }, visibilityState: "visible" };
    const api = {
      saveChats: (d) => asyncSaves.push(d),
    };
    if (syncSupported) api.saveChatsSync = (d) => syncSaves.push(d);
    const mk = new Function(
      "window",
      "document",
      "isElectron",
      "api",
      "getChatsData",
      "localStorage",
      "setTimeout",
      "clearTimeout",
      block + "\nreturn { persistChats, persistChatsSoon, persistChatsNow, flushChats, wire };"
    );
    const fns = mk(
      win,
      doc,
      true,
      api,
      () => ({ chats: [{ id: "c1", messages: [] }], activeId: "c1" }),
      { setItem() {} },
      (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      (t) => { if (t) t.cancelled = true; }
    );
    fns.wire(); // в приложении сброс при закрытии окна навешивает оболочка (ChatStore.wire())
    return { ...fns, syncSaves, asyncSaves, timers, handlers, doc };
  }

  await test("чаты: throttle — пачка правок даёт одну запись, а не десять", () => {
    const a = makeAutosave(true);
    for (let i = 0; i < 10; i++) a.persistChatsSoon();
    assert.strictEqual(a.timers.length, 1, "запланировано таймеров: " + a.timers.length);
    assert.strictEqual(a.syncSaves.length + a.asyncSaves.length, 0, "запись произошла сразу, без задержки");
    a.timers[0].fn();
    assert.strictEqual(a.asyncSaves.length, 1, "после интервала должно быть ровно одно сохранение");
  });

  await test("чаты: закрытие окна (beforeunload) пишет синхронно — данные не теряются", () => {
    const a = makeAutosave(true);
    a.persistChatsSoon(); // правки во время ответа ещё не сброшены
    assert.ok(typeof a.handlers.window.beforeunload === "function", "нет обработчика beforeunload");
    a.handlers.window.beforeunload();
    assert.strictEqual(a.syncSaves.length, 1, "синхронное сохранение не сработало");
    assert.strictEqual(a.asyncSaves.length, 0, "при закрытии должен идти только синхронный путь");
    // Свёрнутая страница (мобильный режим) — тоже сбрасываем.
    a.persistChatsSoon();
    a.doc.visibilityState = "hidden";
    a.handlers.document.visibilitychange();
    assert.strictEqual(a.syncSaves.length, 2, "скрытие страницы не сохранило данные");
  });

  await test("чаты: без новых правок закрытие окна ничего не пишет", () => {
    const a = makeAutosave(true);
    a.handlers.window.beforeunload();
    assert.strictEqual(a.syncSaves.length + a.asyncSaves.length, 0, "лишняя запись на диск");
  });

  await test("чаты: завершение хода пишет сразу и отменяет отложенную запись", () => {
    const a = makeAutosave(true);
    a.persistChatsSoon();
    a.persistChatsNow();
    assert.strictEqual(a.asyncSaves.length, 1, "немедленной записи не было");
    a.timers.forEach((t) => { if (!t.cancelled) t.fn(); });
    assert.strictEqual(a.asyncSaves.length, 1, "отменённый таймер всё же записал файл");
  });

  await test("чаты: без синхронного канала (мобильный мост) сохранение всё равно происходит", () => {
    const a = makeAutosave(false);
    a.persistChatsSoon();
    a.handlers.window.beforeunload();
    assert.strictEqual(a.asyncSaves.length, 1, "асинхронный путь не сработал");
  });

  // Восстановление «подвисших» сообщений после аварийного закрытия.
  const sanitizeSliceA = uiFind("  function sanitizeChats(d) {");
  assert.ok(sanitizeSliceA.start > 0, "не нашёл sanitizeChats в интерфейсе");
  const rawLines = sanitizeSliceA.code.split("\n");
  let endLine = -1;
  for (let i = 1; i < rawLines.length; i++) {
    if (rawLines[i] === "  }") { endLine = i; break; }
  }
  assert.ok(endLine > 0, "не нашёл конец функции sanitizeChats");
  const sanitizeChats = new Function(rawLines.slice(0, endLine + 1).join("\n") + "\nreturn sanitizeChats;")();

  await test("чаты: после аварийного закрытия не остаётся вечных «выполняется»", () => {
    const out = sanitizeChats({
      activeId: "c1",
      chats: [
        {
          id: "c1",
          messages: [
            { id: "u", role: "user", content: "привет" },
            { id: "a", role: "assistant", content: "частичный ответ", pending: true },
            { id: "t", role: "tool", toolName: "runCommand", toolResult: null, pending: true },
          ],
        },
        { id: "c2", messages: [{ id: "a2", role: "assistant", content: "", pending: true }] },
      ],
    });
    const msgs = out.chats[0].messages;
    assert.strictEqual(msgs[1].pending, false, "assistant остался незавершённым");
    assert.strictEqual(msgs[1].content, "частичный ответ", "текст ответа потерян");
    assert.strictEqual(msgs[2].pending, false, "tool остался незавершённым");
    assert.strictEqual(msgs[2].toolOk, false);
    assert.ok(msgs[2].toolResult.indexOf("закрыл") !== -1, "нет пояснения к прерванному действию");
    assert.strictEqual(msgs[msgs.length - 1].role, "system", "нет пометки о прерывании");
    assert.ok(msgs[msgs.length - 1].content.indexOf("прерван") !== -1, "пометка без пояснения");
    // В неактивном чате флаг тоже снимается, но лишней пометки не появляется.
    assert.strictEqual(out.chats[1].messages[0].pending, false);
    assert.strictEqual(out.chats[1].messages[0].content, "…");
    assert.strictEqual(out.chats[1].messages.length, 1, "лишняя пометка в неактивном чате");
  });

  await test("чаты: целая история при загрузке не меняется", () => {
    const d = { activeId: "c1", chats: [{ id: "c1", messages: [{ id: "u", role: "user", content: "ок" }] }] };
    const before = JSON.stringify(d);
    assert.strictEqual(JSON.stringify(sanitizeChats(d)), before, "sanitizeChats испортил целую историю");
  });

  await test("чаты: битые данные не ломают загрузку", () => {
    assert.deepStrictEqual(sanitizeChats(null), { chats: [], activeId: null });
    assert.strictEqual(sanitizeChats({ chats: "нет" }).chats, "нет");
    const fixed = sanitizeChats({ chats: [{ id: "x" }], activeId: "x" });
    assert.deepStrictEqual(fixed.chats[0].messages, [], "messages не восстановлен в массив");
  });
}

// ── Лента: умная прокрутка и очередь кадра (этап 3.7, часть 4) ──────────────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ: пока человек читает выше — вниз
// не дёргаем и показываем кнопку «↓»; по клику и по новому сообщению возвращаемся
// в конец; очередь кадра копит текст и рисует последнее состояние ровно один раз
// за кадр. Отдельно — забытые зависимости: они обязаны падать понятной ошибкой,
// а не тихо оставлять человека с неперерисованным пузырём.
async function testChatFeed() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-feed.js"), "utf8");

  await test("лента: прокрутка и очередь кадра работают, как раньше", () => {
    // 1. Модуль на месте, подключён до app.js, отдаётся телефону, собран в оболочке.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-feed.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-feed.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-feed.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"chat-feed\.js"/.test(bridge), "мобильный мост не отдаёт chat-feed.js телефону");
    const appSrc = uiFile("app.js");
    for (const gone of ["function scrollBottom", "function updatePinState", "function jumpToBottom", "function queueBubbleRender", "function scrollBottomSoon", "let pinnedToBottom"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код ленты остался в app.js: " + gone);
    }
    const wiring = appSrc.slice(appSrc.indexOf("window.ChatFeed({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of ["$: $", "msgEls: msgEls", "msgHtml: (c) => ChatRender.msgHtml(c)"]) {
      assert.ok(wiringCall.includes(dep), "в проводку ленты не передан " + dep);
    }
    // Отрисовка сообщения (chat-render.js) собирается НИЖЕ ленты, поэтому msgHtml — стрелка:
    // копия функции на этом месте была бы пустой и упала бы при первом же чанке.
    assert.ok(
      appSrc.indexOf("window.ChatFeed({") < appSrc.indexOf("window.ChatRender({"),
      "лента собрана после отрисовки — стрелка msgHtml больше не нужна, проверь порядок"
    );
    // Кнопка «↓» обязана жить СНАРУЖИ ленты: перерисовка очищает ленту целиком
    // (innerHTML = ""), и вложенную кнопку удаляло вместе с содержимым. Именно на
    // этом падала перерисовка (1.5.118), а падение обрывало запуск окна.
    const flat = html.replace(/\s+/g, " ");
    assert.ok(flat.includes('<div id="messages"></div>'), "внутри ленты есть узлы — первая же перерисовка их удалит");
    assert.ok(
      html.indexOf('id="btn-scroll-bottom"') > html.indexOf('id="messages"'),
      "кнопка «↓» стоит внутри ленты — перерисовка её удалит"
    );
    assert.ok(flat.includes('<div id="messages-wrap">'), "нет обёртки ленты: кнопке негде жить снаружи");
    // Лента не имеет права трогать элементы вне себя: перерисовка зовёт pinBottom,
    // а не jumpToBottom (тот дёргает кнопку).
    const renderBody = appSrc.slice(appSrc.indexOf("function renderMessages"), appSrc.indexOf("function buildMessageEl"));
    assert.ok(/ChatFeed\.pinBottom\(\)/.test(renderBody), "перерисовка не прыгает в конец через pinBottom");
    assert.ok(!/ChatFeed\.jumpToBottom\(/.test(renderBody), "перерисовка дёргает кнопку «↓» — она может быть удалена");

    // Границы модуля: ничего чужого из оболочки, только внедрённое.
    for (const name of ["chatsData", "session", "streaming", "ChatRender", "localStorage", "document"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }

    // 2. Среда: заглушка ленты (окно прокрутки + кнопка «↓») и карта элементов сообщений.
    const classes = new Set();
    const btn = {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => {
          const want = on === undefined ? !classes.has(c) : !!on;
          if (want) classes.add(c); else classes.delete(c);
          return want;
        },
      },
    };
    const win = { scrollTop: 0, scrollHeight: 900, clientHeight: 300 };
    const dom = { messages: win, "btn-scroll-bottom": btn };
    const $ = (id) => dom[id];
    const msgEls = new Map();
    const bubble = { innerHTML: "", classList: { add() {}, remove() {} } };
    msgEls.set("a1", { querySelector: (sel) => (sel === ".bubble" ? bubble : null) });

    const rafQ = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
    try {
      const feed = buildChatFeed({ $: $, msgEls: msgEls, msgHtml: (c) => "<p>" + c + "</p>" });
      assert.deepStrictEqual(
        Object.keys(feed).sort(),
        ["jumpToBottom", "pinBottom", "queueBubbleRender", "scrollBottom", "scrollBottomSoon", "updatePinState"],
        "наружу торчит лишнее или чего-то не хватает"
      );

      // 3. У конца ленты — держимся внизу, кнопка «↓» скрыта.
      win.scrollTop = 900;
      feed.updatePinState();
      assert.strictEqual(classes.has("hidden"), true, "у конца ленты кнопка «↓» осталась видимой");
      win.scrollHeight = 1200;
      feed.scrollBottom();
      assert.strictEqual(win.scrollTop, 1200, "у конца ленты прокрутка не поехала вниз");

      // 4. Человек читает выше — не выдёргиваем и показываем кнопку.
      win.scrollTop = 120;
      feed.updatePinState();
      assert.strictEqual(classes.has("hidden"), false, "при чтении выше кнопка «↓» не показалась");
      win.scrollHeight = 1400;
      feed.scrollBottom();
      assert.strictEqual(win.scrollTop, 120, "человека выдернули из чтения");

      // 5. Ручной возврат в конец: без «умной» логики, сразу вниз.
      feed.jumpToBottom();
      assert.strictEqual(win.scrollTop, 1400, "кнопка «↓» не вернула в конец");
      assert.strictEqual(classes.has("hidden"), true, "после возврата кнопка «↓» осталась");
      win.scrollHeight = 1500;
      feed.scrollBottom();
      assert.strictEqual(win.scrollTop, 1500, "после возврата автопрокрутка не возобновилась");


      // 6. Очередь кадра: два чанка — один кадр и последнее состояние.
      const seg = { id: "a1", content: "прив" };
      const chat = { messages: [seg] };
      feed.queueBubbleRender(chat, seg);
      seg.content = "привет";
      feed.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "кадр запланирован не один раз: " + rafQ.length);
      assert.strictEqual(bubble.innerHTML, "", "пузырь перерисован до кадра");
      assert.strictEqual(win.scrollTop, 1500, "прокрутка дёрнулась до кадра");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет</p>", "не отрисовано последнее состояние");
      assert.strictEqual(win.scrollTop, win.scrollHeight, "нет автопрокрутки в кадре");
      assert.strictEqual(rafQ.length, 0, "очередь кадров не очищена");

      // 7. Следующий поток чанков снова планирует ровно один кадр.
      seg.content = "привет!";
      feed.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "новый кадр не запланирован");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет!</p>");

      // 8. Чанк без сообщения (сегмент уже убран) — молча: без падений и без лишней работы.
      feed.queueBubbleRender(chat, null);
      feed.queueBubbleRender(chat, { id: "нет такого", content: "x" });
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет!</p>", "чужой сегмент перерисовал пузырь");
      assert.strictEqual(rafQ.length, 0, "пустой чанк оставил висячий кадр");

      // 9. Отложенная прокрутка (размышления) тоже схлопывается в один кадр и тоже
      //    уважает «человек читает выше».
      win.scrollHeight = 2000;
      win.scrollTop = 100;
      feed.updatePinState();
      feed.scrollBottomSoon();
      feed.scrollBottomSoon();
      assert.strictEqual(rafQ.length, 1, "прокрутка планирует больше одного кадра");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(win.scrollTop, 100, "отложенная прокрутка выдернула человека из чтения");
      feed.jumpToBottom();
      win.scrollHeight = 2100;
      feed.scrollBottomSoon();
      assert.strictEqual(rafQ.length, 1, "отложенная прокрутка не запланирована");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(win.scrollTop, 2100, "отложенная прокрутка не сработала");

      // 11. Перерисовка ленты прыгает в конец через pinBottom: он не трогает кнопку
      //     «↓» и потому не может упасть на удалённом элементе.
      win.scrollTop = 300;
      feed.updatePinState();
      assert.strictEqual(classes.has("hidden"), false, "при чтении выше кнопка «↓» не показалась");
      win.scrollHeight = 1700;
      feed.pinBottom();
      assert.strictEqual(win.scrollTop, 1700, "pinBottom не прыгнул в конец");
      assert.strictEqual(classes.has("hidden"), false, "pinBottom сам управляет кнопкой — не должен");

      // 12. Кнопки может не быть вовсе (старая разметка, окно телефона): прокрутка
      //     обязана работать молча, а не падать с «Cannot read properties of null».
      const btnBackup = dom["btn-scroll-bottom"];
      delete dom["btn-scroll-bottom"];
      assert.doesNotThrow(() => feed.updatePinState(), "updatePinState падает без кнопки «↓»");
      assert.doesNotThrow(() => feed.jumpToBottom(), "jumpToBottom падает без кнопки «↓»");
      assert.doesNotThrow(() => feed.pinBottom(), "pinBottom падает без кнопки «↓»");
      dom["btn-scroll-bottom"] = btnBackup;
      // 10. Негативный контроль зависимостей: без DOM модуль падает понятной ошибкой.
      const noDollar = buildChatFeed({ msgEls: msgEls, msgHtml: (c) => c });
      assert.throws(() => noDollar.updatePinState(), /is not a function/, "без $ модуль не упал");
      try {
        noDollar.updatePinState();
        assert.fail("без $ ошибка не называет забытую зависимость");
      } catch (e) {
        assert.ok(/\$/.test(String(e && e.message)), "ошибка не называет забытую зависимость: " + (e && e.message));
      }
      // Без рендера содержимого кадр обязан упасть, а не молча оставить пузырь пустым.
      const noHtml = buildChatFeed({ $: $, msgEls: msgEls });
      noHtml.queueBubbleRender(chat, seg);
      assert.throws(
        () => rafQ.splice(0).forEach((fn) => fn()),
        /msgHtml is not a function/,
        "забытый рендер содержимого не привёл к понятной ошибке"
      );
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });
}

async function testChatWork() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-work.js"), "utf8");

  await test("строки действий: строка, ссылка на файл и группа работ работают, как раньше", () => {
    // 1. Модуль на месте, подключён до app.js, отдаётся телефону, собран в оболочке.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="chat-work.js"');
    assert.ok(iTag > 0, "разметка не грузит chat-work.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "chat-work.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"chat-work\.js"/.test(bridge), "мобильный мост не отдаёт chat-work.js телефону");
    const appSrc = uiFile("app.js");
    for (const gone of ["const TOOL_ICON", "const TOOL_LABEL", "function buildToolEl", "function toolTargetOf", "let turnPlan", "function ensureWorkGroup", "function updatePlanTitle"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код строк действий остался в app.js: " + gone);
    }
    const wiring = appSrc.slice(appSrc.indexOf("window.ChatWork({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of ["$: $", "isElectron: isElectron", "openFile: openToolFile"]) {
      assert.ok(wiringCall.includes(dep), "в проводку строк действий не передан " + dep);
    }
    // Границы модуля: чужое — только через deps (открытие файла зовут, а не ищут сами).
    for (const name of ["chatsData", "session", "streaming", "msgEls", "projectDir", "viewFile", "window."]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name.replace(".", "\\.") + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }

    // 2. Среда: заглушка DOM, живые зависимости и счётчики вызовов.
    const mkEl = (tag) => {
      const cls = new Set();
      const el = {
        tagName: tag, textContent: "", title: "", value: "", disabled: false,
        onclick: null, children: [], parentNode: null,
        // Как в браузере: запись innerHTML заменяет содержимое. Раньше панель
        // действий чистит себя именно так, и без этого старые блоки копились бы.
        get innerHTML() { return ""; },
        set innerHTML(v) { if (!String(v == null ? "" : v)) this.children.length = 0; },
        get className() { return [...cls].join(" "); },
        set className(v) { cls.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); },
        classList: {
          add: (...c) => c.forEach((x) => cls.add(x)),
          remove: (...c) => c.forEach((x) => cls.delete(x)),
          contains: (c) => cls.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !cls.has(c) : !!on;
            if (want) cls.add(c); else cls.delete(c);
            return want;
          },
        },
        appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
        querySelector: () => null,
      };
      return el;
    };
    // Плоский текст ветки: у строк действий всё содержание — строки и вложенные блоки.
    let nodeSeq = 0;
    const mark = (n) => {
      if (!n) return [];
      n.__id = ++nodeSeq;
      return [n].concat((n.children || []).flatMap(mark));
    };
    const textOf = (n) => ((n && n.textContent) || "");
    const hosts = {};
    const opened = [];
    const vm = require("vm");
    const build = (deps) => {
      const sandbox = {
        module: { exports: {} }, self: {}, window: {},
        console: { log() {}, warn() {}, error() {} },
        document: { createElement: mkEl },
      };
      vm.runInNewContext(src, sandbox, { filename: "chat-work.js" });
      assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
      return sandbox.module.exports(deps);
    };
    const $ = (id) => (hosts[id] = hosts[id] || mkEl("div"));
    const deps = { $: $, isElectron: true, openFile: (p) => opened.push(p) };
    const W = build(deps);
    assert.deepStrictEqual(
      Object.keys(W).sort(),
      ["TOOL_ICON", "TOOL_LABEL", "addRow", "buildToolEl", "ensureWorkGroup", "finishGroup", "planAdd", "planSet", "resetGroup", "toolArgsPreview", "toolIcon", "toolLabel", "toolTargetOf", "updatePlanTitle"],
      "наружу торчит лишнее или чего-то не хватает"
    );
    assert.strictEqual(W.toolIcon("writeFile"), "✏️", "значок инструмента потерялся");
    assert.strictEqual(W.toolIcon("такого-нет"), "⚙️", "нет запасного значка");
    assert.strictEqual(W.toolLabel("writeFile"), "Изменение файла", "подпись инструмента потерялась");
    assert.strictEqual(W.toolLabel("такого-нет"), "такого-нет", "нет запасной подписи");

    // 3. Строка действия: значки, подпись, цель, состояние, подробности.
    const flat = (el) => mark(el).map((n) => textOf(n)).filter(Boolean).join(" · ");
    const busy = W.buildToolEl({ toolName: "writeFile", toolArgs: { path: "src/a.js" }, pending: true });
    assert.ok(/msg tool/.test(busy.className), "строка действия потеряла класс сообщения: " + busy.className);
    assert.ok(flat(busy).indexOf("●") >= 0 && flat(busy).indexOf("✏️") >= 0, "в строке нет состояния или значка: " + flat(busy));
    assert.ok(flat(busy).indexOf("Изменение файла") >= 0, "в строке нет подписи действия: " + flat(busy));
    assert.ok(flat(busy).indexOf("src/a.js") >= 0, "в строке нет цели действия: " + flat(busy));
    assert.ok(flat(busy).indexOf("Выполняется") >= 0, "нет состояния «идёт»: " + flat(busy));
    assert.ok(/path/.test(flat(busy)), "в подробностях нет аргументов вызова: " + flat(busy));

    const done = W.buildToolEl({ toolName: "runCommand", toolArgs: { command: "ls -la" }, toolResult: "ok", pending: false });
    assert.ok(flat(done).indexOf("✓") >= 0 && flat(done).indexOf("Готово") >= 0, "готовое действие не отмечено: " + flat(done));
    assert.ok(flat(done).indexOf("ok") >= 0, "в подробностях нет результата: " + flat(done));
    const failed = W.buildToolEl({ toolName: "runCommand", toolArgs: { command: "нет" }, toolResult: "Ошибка", pending: false, toolOk: false });
    assert.ok(flat(failed).indexOf("✕") >= 0 && flat(failed).indexOf("Ошибка") >= 0, "провал действия не отмечен: " + flat(failed));

    // 4. Клик по строке раскрывает подробности; путь файла открывается из настольного окна.
    const link = mark(busy).find((n) => /tool-target-link/.test(n.className));
    assert.ok(link, "файловая цель не стала ссылкой: " + flat(busy));
    link.onclick({ stopPropagation() {} });
    assert.deepStrictEqual(opened, ["src/a.js"], "клик по пути не открыл файл: " + JSON.stringify(opened));
    const linkless = W.buildToolEl({ toolName: "runCommand", toolArgs: { command: "ls" }, pending: true });
    assert.ok(!mark(linkless).some((n) => /tool-target-link/.test(n.className)), "ссылка появилась у не-файлового действия");
    const browser = build({ $: $, isElectron: false, openFile: () => {} });
    const inBrowser = browser.buildToolEl({ toolName: "readFile", toolArgs: { path: "src/a.js" }, pending: true });
    assert.ok(!mark(inBrowser).some((n) => /tool-target-link/.test(n.className)), "в браузере путь открывает файл");
    const body = mark(busy).find((n) => /tool-body/.test(n.className));
    body.onclick({ target: { closest: () => null } });
    assert.strictEqual(body.classList.contains("open"), true, "клик по строке не раскрыл подробности");

    // 5. Цель и предпросмотр аргументов.
    assert.strictEqual(W.toolTargetOf({ args: { url: "https://a.test" } }), "https://a.test", "цель-адрес потерялась");
    assert.strictEqual(W.toolTargetOf({ args: { commit: "abc123" } }), "commit abc123", "цель-коммит потерялась");
    assert.strictEqual(W.toolTargetOf({ args: {} }), "", "цель выдумана из пустых аргументов");
    const long = "x".repeat(300);
    assert.ok(/… \(300 симв\.\)/.test(W.toolArgsPreview({ q: long })), "длинный аргумент не ужат: " + W.toolArgsPreview({ q: long }).slice(0, 60));

    // 6. Группа работ: строка встаёт в группу, счётчик и заголовок живут, группа закрывается.
    assert.strictEqual(W.ensureWorkGroup(), W.ensureWorkGroup(), "группа создаётся заново на каждый вызов");
    const panel = hosts["work-panel"];
    assert.strictEqual(panel.children.length, 1, "группа не встала в панель действий");
    const rowEl = mkEl("div");
    const group = W.addRow(rowEl);
    assert.ok(group.body.children.some((c) => c === rowEl), "строка не попала в тело группы");
    W.planAdd({ name: "writeFile" });
    W.planAdd({ name: "runCommand" });
    assert.strictEqual(group.badge.textContent, "2", "счётчик действий не растёт: " + group.badge.textContent);
    // В свёрнутой группе заголовок называет ТЕКУЩЕЕ действие — то, что началось последним.
    assert.strictEqual(group.txt.textContent, "Выполняю: Команда в терминале", "заголовок группы не назвал текущее действие: " + group.txt.textContent);
    group.head.onclick({ stopPropagation() {} });
    assert.strictEqual(group.body.classList.contains("expanded"), true, "группа не развернулась по клику");
    assert.strictEqual(group.txt.textContent, "Выполняю действия", "в развёрнутой группе заголовок не общий: " + group.txt.textContent);
    W.finishGroup();
    assert.strictEqual(group.body.classList.contains("finished"), true, "группа не закрылась по концу ответа");
    assert.strictEqual(group.txt.textContent, "Действия выполнены", "после ответа группа не сказала, что сделано: " + group.txt.textContent);
    W.resetGroup();
    const next = W.ensureWorkGroup();
    assert.notStrictEqual(next, group, "новая работа продолжила старую группу");
    // В новой группе только заголовок: строки прошлой работы с ней не переехали.
    assert.strictEqual(next.body.children.indexOf(rowEl), -1, "новая группа пришла с чужими строками");
    assert.strictEqual(next.badge.textContent, "0", "новая группа начала со старым счётчиком: " + next.badge.textContent);
    assert.strictEqual(panel.children.length, 1, "в панели остался старый блок работы");

    // 7. Негативный контроль зависимостей: без DOM модуль падает понятной ошибкой.
    const noDollar = build({ isElectron: false, openFile: () => {} });
    assert.throws(() => noDollar.ensureWorkGroup(), /is not a function/, "без $ модуль не упал");
    try {
      noDollar.ensureWorkGroup();
      assert.fail("без $ ошибка не назвала забытую зависимость");
    } catch (e) {
      assert.ok(/\$/.test(String(e && e.message)), "ошибка не называет забытую зависимость: " + (e && e.message));
    }
  });
}

// ── Стрим и печать: работа не чаще одного кадра ────────────────────────────
async function testStreamThrottle() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");

  await test("стрим: обработчик chunk рисует через очередь кадра, а не на каждый чанк", () => {
    assert.ok(
      /case "chunk":[\s\S]{0,420}?ChatFeed\.queueBubbleRender\(chat, seg\)/.test(uiFile("chat-events.js")),
      "обработчик chunk не использует очередь кадра"
    );
    assert.ok(
      !/case "chunk":[\s\S]{0,420}?b\.innerHTML = msgHtml\(seg\.content\)/.test(uiFile("chat-events.js")),
      "chunk всё ещё перерисовывает innerHTML на каждый чанк"
    );
    assert.ok(
      /case "thinking":[\s\S]{0,420}?ChatFeed\.scrollBottomSoon\(\)/.test(uiFile("chat-events.js")),
      "размышления всё ещё дёргают прокрутку на каждый токен"
    );
  });

  await test("стрим: очередь копит текст и рисует последнее состояние за один кадр", () => {
    const dom = {
      messages: { scrollTop: 0, scrollHeight: 500 },
      "btn-scroll-bottom": { classList: { add() {}, remove() {}, toggle() {} } },
    };
    const $ = (id) => dom[id];
    const msgEls = new Map();
    // Лента (прокрутка и очередь кадра) вынесена в src/renderer/chat-feed.js (этап 3.7):
    // очереди нужен только рендер содержимого — отдаём его заглушкой.
    const bubble = { innerHTML: "", classList: { add() {}, remove() {} } };
    msgEls.set("a1", { querySelector: (sel) => (sel === ".bubble" ? bubble : null) });

    const rafQ = [];
    const origRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (fn) => { rafQ.push(fn); return rafQ.length; };
    try {
      const api = buildChatFeed({ $: $, msgEls: msgEls, msgHtml: (c) => "<p>" + c + "</p>" });

      const seg = { id: "a1", content: "прив" };
      const chat = { messages: [seg] };

      api.queueBubbleRender(chat, seg);
      seg.content = "привет";
      api.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "кадр запланирован не один раз: " + rafQ.length);
      assert.strictEqual(bubble.innerHTML, "", "пузырь перерисован до кадра");
      assert.strictEqual(dom.messages.scrollTop, 0, "прокрутка дёрнулась до кадра");

      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет</p>", "не отрисовано последнее состояние");
      assert.strictEqual(dom.messages.scrollTop, 500, "нет автопрокрутки в кадре");
      assert.strictEqual(rafQ.length, 0, "очередь кадров не очищена");

      // Следующий поток чанков после отрисовки снова планирует ровно один кадр.
      seg.content = "привет!";
      api.queueBubbleRender(chat, seg);
      assert.strictEqual(rafQ.length, 1, "новый кадр не запланирован");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(bubble.innerHTML, "<p>привет!</p>");

      // Отложенная прокрутка (размышления) тоже схлопывается в один кадр.
      dom.messages.scrollTop = 0;
      api.scrollBottomSoon();
      api.scrollBottomSoon();
      assert.strictEqual(rafQ.length, 1, "прокрутка планирует больше одного кадра");
      rafQ.splice(0).forEach((fn) => fn());
      assert.strictEqual(dom.messages.scrollTop, 500, "отложенная прокрутка не сработала");
    } finally {
      globalThis.requestAnimationFrame = origRaf;
    }
  });

  await test("печать: высота поля ввода пересчитывается не чаще кадра", () => {
    assert.ok(
      /function autoResize\(\) \{\s*if \(inputResizeRaf\) return;/.test(appSrc),
      "autoResize не откладывается до кадра"
    );
    assert.ok(
      /requestAnimationFrame\(\(\) => \{\s*inputResizeRaf = 0;/.test(appSrc),
      "нет сброса inputResizeRaf внутри кадра"
    );
  });

  await test("фон под стеклянными панелями статичен (иначе блюры пересчитываются каждый кадр)", () => {
    const before = cssSrc.match(/body::before \{[\s\S]*?\n\}/);
    assert.ok(before, "не нашёл body::before в styles.css");
    assert.ok(!/animation:/.test(before[0]), "body::before всё ещё анимируется");
    assert.ok(!/will-change/.test(before[0]), "лишний композитный слой: will-change: transform");

    const bubbleRule = cssSrc.match(/\.msg\.assistant \.bubble \{[^}]*165deg[^}]*\}/);
    assert.ok(bubbleRule, "не нашёл оформление пузыря ответа");
    assert.ok(!/backdrop-filter:\s*blur/.test(bubbleRule[0]), "у пузыря ответа остался backdrop-filter");
  });
}

// ── Контекст длинного чата и кнопка «Продолжить контекст» ───────────────────
async function testChatContextTransfer() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("trimConversation: на длинном чате остаётся свежий хвост, а не одно сообщение", () => {
    // Регрессия: прежний проход «с начала» тратил бюджет на старые сообщения, а на чате
    // длиннее бюджета возвращал ОДНО последнее сообщение — задача агента терялась.
    const msgs = [];
    for (let i = 0; i < 40; i++) {
      msgs.push({ role: "user", content: "U" + i + ":" + "x".repeat(200) });
      msgs.push({ role: "assistant", content: "A" + i + ":" + "y".repeat(200) });
    }
    let total = 0;
    for (const m of msgs) total += core.estimateTokens(m.content);
    assert.ok(total > 3000, "тест собран неверно: сообщений меньше бюджета (" + total + " т.)");
    const trimmed = core.trimConversation(msgs, 3000);
    assert.ok(trimmed.length > 1, "история схлопнулась до " + trimmed.length + " сообщения — задача потеряна");
    assert.ok(trimmed.length < msgs.length, "история не обрезана вообще (" + trimmed.length + ")");
    assert.ok(trimmed.some((m) => String(m.content).startsWith("U39:")), "потерян последний запрос пользователя");
    assert.ok(!trimmed.some((m) => String(m.content).startsWith("U0:")), "самое старое сообщение не обрезано");
    assert.strictEqual(trimmed[0].role, "user", "история начинается не с user: " + trimmed[0].role);
  });

  await test("история чата уходит в модель целиком и со служебными заметками", () => {
    // Маркер конца — внутри самого куска (правило 3 в ARCHITECTURE.md): начало сессии
    // уехало в модуль отправки и зовётся там через setSession.
    const historySlice = uiFind("let history = chat.messages", "setSession({ chatId: chat.id");
    assert.ok(historySlice.start > 0, "не нашёл сборку истории в sendMessage");
    const block = historySlice.code;
    assert.ok(!block.includes("AgentCore.trimConversation(history"), "история по-прежнему режется в интерфейсе по полному бюджету");
    assert.ok(block.includes('m.role === "system"'), "служебные заметки чата не попадают в контекст");
    assert.ok(block.includes('m.role === "user"') && block.includes('m.role === "assistant"'), "user/assistant не попадают в контекст");
  });

  await test("кнопка «Продолжить контекст» переносит последний запрос и хвост диалога", () => {
    const contSlice = uiFind("function buildContinuationContext", "$(\"btn-continue-chat\").onclick");
    assert.ok(contSlice.start > 0, "нет сборки контекста для кнопки");
    assert.ok(contSlice.end > contSlice.start, "кнопка не использует новую сборку контекста");
    const fn = contSlice.code;
    assert.ok(fn.includes("Последний запрос пользователя"), "в контекст не попадает последний запрос пользователя");
    assert.ok(fn.includes("Последний ответ агента"), "в контекст не попадает последний ответ");
    assert.ok(fn.includes("Хвост диалога"), "в контекст не попадает хвост диалога");
    const handler = uiFind("$(\"btn-continue-chat\").onclick").code.slice(0, 900);
    assert.ok(handler.includes("buildContinuationContext(prev)"), "кнопка не собирает контекст новой функцией");
    assert.ok(!handler.includes("lastAssistant.slice"), "кнопка по-прежнему шлёт только последний ответ");
  });
}

// ── Выросший чат: агент не должен «писать что-то и отключаться» ─────────────
async function testLongChatRecovery() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const mainSrc = backendSrc();
  // Предохранитель «план не закрыт» с части 20 живёт в src/run-nudge.js,
  // а пустой ответ — в src/run-batch.js. Обе части читаем напрямую.
  const guardSrc = fs.readFileSync(path.join(ROOT, "src", "run-nudge.js"), "utf8");
  const GUARD_START = "  const decide = (history, o) => {";
  const GUARD_END = "    return { action: \"none\" };\n  };\n";

  await test("выросший чат: незакрытый план не даёт прогону закончиться текстом", () => {
    const i = guardSrc.indexOf(GUARD_START);
    const j = guardSrc.indexOf(GUARD_END);
    assert.ok(i > 0 && j > i, "нет предохранителя «план не закрыт»");
    const block = guardSrc.slice(i, j);
    assert.ok(block.includes("o.toolCalls.length"), "предохранитель не привязан к «нет вызовов инструментов»");
    assert.ok(
      block.includes("plan.done + plan.failed < plan.total"),
      "не проверяется, что пункты плана закрыты не все"
    );
    assert.ok(block.includes("planNudges < 2"), "нет ограничения повторов — возможен бесконечный цикл");
    assert.ok(block.includes("history.push("), "просьба продолжить не уходит модели");
    assert.ok(block.includes('return { action: "repeat" };'), "прогон всё равно завершается");
    assert.ok(/failed/.test(block), "нет выхода для невыполнимого пункта (failed)");
    assert.ok(guardSrc.includes("let planNudges = 0;"), "нет счётчика повторов");
    // Именно оболочка (main.js), а не backendSrc: модуль призывов в него входит.
    assert.ok(mainOnlySrc().includes("planNudges") === false, "счётчик призывов остался в оболочке");
    assert.ok(mainSrc.includes("activePlanSummary = null; // план прошлого прогона"), "сводка плана не сбрасывается между прогонами");
    assert.ok(/if \(nudged.action === "repeat"\) continue;/.test(mainSrc), "прогон не повторяет раунд по решению модуля");
  });

  await test("выросший чат: todoWrite отдаёт сводку плана предохранителю", () => {
    assert.ok(mainSrc.includes("let activePlanSummary = null;"), "нет переменной сводки плана");
    assert.ok(
      mainSrc.includes("activePlanSummary = { total: ps.total, done: ps.done, failed: ps.failed };"),
      "todoWrite не запоминает сводку плана"
    );
  });

  await test("выросший чат: в режиме плана предохранитель выключен", () => {
    const block = guardSrc.slice(guardSrc.indexOf(GUARD_START), guardSrc.indexOf(GUARD_END));
    assert.ok(block.includes("o.planMode"), "в режиме плана агент будет «продолжать делом» вместо ожидания команды");
  });

  await test("лимит раундов объясняет, как продолжить, а не просто падает", () => {
    const i = mainSrc.indexOf("Превышено максимальное число раундов вызова инструментов");
    assert.ok(i > 0, "нет сообщения о лимите раундов");
    const t = mainSrc.slice(i, i + 400);
    assert.ok(t.includes("продолжай"), "пользователю не сказано, что делать дальше");
    assert.ok(/сохранены/.test(t), "не сказано, что работа не потеряна");
  });

  // Повторное сжатие: перехватываем сеть, чтобы увидеть, сколько раз и с чем сжимаем.
  const realFetch = global.fetch;
  const bodies = [];
  let memoN = 0;
  global.fetch = async (url, opts) => {
    memoN++;
    bodies.push(String((opts && opts.body) || ""));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "МЕМО" + memoN } }] }),
    };
  };
  try {
    await test("выросший чат: сжатие срабатывает повторно, и памятка накапливается", async () => {
      const chunk = "строка старого контекста ".repeat(120);
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: chunk + " u" + i });
        messages.push({ role: "assistant", content: chunk + " a" + i });
      }
      messages.push({ role: "user", content: "текущая задача: дойти до конца" });
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const cm = core.createContextManager({ settings, planMode: false });
      for (let i = 0; i < 5; i++) await cm.manage(messages, 2000);
      assert.ok(bodies.length > 1, "сжатие по-прежнему одноразовое: вызовов " + bodies.length);
      assert.ok(bodies.length <= 3, "сжатий больше лимита: " + bodies.length);
      assert.ok(bodies[1].includes("МЕМО1"), "повторное сжатие не видит предыдущую памятку — старые шаги потеряются");
    });

    await test("выросший чат одной задачи: памятка ЗАМЕНЯЕТ свёрнутый кусок, а не дописывается", async () => {
      // Одна просьба человека и сорок шагов агента после неё — тот самый ход, где сжатие
      // было фиктивным: границы «до последней просьбы» в истории нет, а правило «текущий
      // виток сохраняем целиком» не давало свернуть ничего. Замер на живом чате:
      // 112 911 токенов до сжатия и 112 911 после — история оставалась целой, а памятка
      // ехала доплаткой и обещала экономию, которой не было.
      const chunk = "строка старого контекста ".repeat(120);
      const goal = { role: "user", content: "одна задача: дойти до конца" };
      const history = [goal];
      for (let i = 0; i < 40; i++) history.push({ role: "assistant", content: chunk + " шаг " + i });
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const cm = core.createContextManager({ settings, planMode: false });
      const out = await cm.manage(history, 2000);
      assert.ok(out.length && out[0].role === "system" && /ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА/.test(out[0].content), "памятка не встала первой");
      assert.strictEqual(out[1], goal, "просьба человека потерялась — агент забудет, чего от него хотят");
      assert.ok(out.length < history.length, "история не свёрнута: было " + history.length + " сообщений, стало " + out.length);
      const before = history.reduce((n, m) => n + String(m.content).length, 0);
      const after = out.reduce((n, m) => n + String(m.content).length, 0);
      assert.ok(after < before / 2, "переписка не уменьшилась: было " + Math.round(before / 1000) + "k символов, стало " + Math.round(after / 1000) + "k");
    });

    await test("выросший чат одной задачи: при двух просьбах хвост начинается с последней", async () => {
      // Обычный длинный чат: просьб несколько, и граница свёрнутого — последняя из них.
      // Всё, что было до неё, уходит в памятку; её письмо и шаги по нему остаются целиком.
      const chunk = "строка старого контекста ".repeat(120);
      const history = [];
      for (let i = 0; i < 10; i++) {
        history.push({ role: "user", content: chunk + " просьба " + i });
        history.push({ role: "assistant", content: chunk + " ответ " + i });
      }
      const last = { role: "user", content: "последняя просьба: допиши отчёт" };
      history.push(last);
      // Текущий виток уже пошёл: после последней просьбы есть шаги агента, и они
      // обязаны остаться в запросе — по ним прогон и продолжает работу.
      history.push({ role: "assistant", content: "Открыл отчёт." });
      history.push({ role: "tool", content: "Отчёт: 12 строк." });
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const cm = core.createContextManager({ settings, planMode: false });
      const out = await cm.manage(history, 2000);
      assert.ok(out.length && out[0].role === "system", "памятка не встала первой");
      assert.ok(out.indexOf(last) > 0, "последняя просьба потерялась из хвоста");
      assert.ok(out.some((m) => m !== last && m.role === "assistant"), "шаги текущего витка потерялись");
    });
  } finally {
    global.fetch = realFetch;
  }
}

module.exports = {
  testChatActions,
  testWebChat,
  testChatThinking,
  testChatEvents,
  testChatSegments,
  testChatRender,
  testChatFeed,
  testChatWork,
  testChatPersistence,
  testChatContextTransfer,
  testLongChatRecovery,
  testStreamThrottle,
};

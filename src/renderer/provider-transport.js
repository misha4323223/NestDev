"use strict";

/* Унифицированный транспорт провайдеров: канонические сообщения агента
   («OpenAI-стиль») переводятся в диалект каждого семейства, запрос собирается
   вместе с кэшем промпта, ответ читается потоком, а окно модели узнаётся у сервера.

   Вынесено из agent-core.js. Модуль получает ровно две вещи: подключение
   (адреса, ключи, заголовки — src/renderer/provider-config.js) и таблицу
   инструментов агента. Настройки приложения ему не видны: нужное приходит
   аргументами функций, поэтому модуль проверяется без агента. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ProviderTransport = factory;
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  const { config, toolDefinitions } = deps || {};
  const {
    splitG4fRoute,
    baseFor,
    isLocalBase,
    proxiedBase,
    apiKeyFor,
    apiHeaders,
    projectHeader,
    jsonArgs,
    genCallId,
  } = config || {};
  // Таблица инструментов нужна здесь для схем запроса: у каждого семейства
  // провайдеров формат схем свой, и «пустой» список означал бы агента без инструментов.
  const TOOL_DEFINITIONS = toolDefinitions || [];

  // ═══════════════════ Унифицированный транспорт провайдеров ═══════════════════
  // Канонический формат сообщений внутри цикла агента — «OpenAI-стиль»:
  //   { role: "system"|"user"|"assistant", content }
  //   assistant с вызовами инструментов: { role:"assistant", content, tool_calls:[{ id, type:"function",
  //     function:{ name, arguments: "<json-строка>" } }] }
  //   результат инструмента:            { role:"tool", tool_call_id, content }
  // Для каждого провайдера сообщения конвертируются на лету при отправке запроса.

  // ── Канонический content сообщения: строка ИЛИ массив частей
  // [{ type: "text", text }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }]
  function partsText(parts) {
    return (parts || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  }
  function partsImages(parts) {
    return (parts || []).filter((p) => p && p.type === "image_url" && p.image_url && p.image_url.url);
  }
  function contentForProvider(provider, content) {
    if (!Array.isArray(content)) return content == null ? "" : content;
    const text = partsText(content);
    const imgs = partsImages(content);
    if (provider === "ollama") {
      // Ollama: content — строка, изображения — массив base64 (без префикса data:)
      const images = imgs.map((p) => {
        const url = String(p.image_url.url || "");
        const idx = url.indexOf(";base64,");
        return idx >= 0 ? url.slice(idx + 8) : url;
      });
      return { content: text, images };
    }
    if (provider === "anthropic") {
      // Claude: content — массив блоков { type: "image", source: { type: "base64", media_type, data } }
      const blocks = [];
      if (text) blocks.push({ type: "text", text });
      for (const p of imgs) {
        const url = String(p.image_url.url || "");
        const m = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
        if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      }
      return blocks;
    }
    return content; // OpenAI-совместимые: массив частей с image_url как есть
  }

  // ── Конвертация канонических сообщений в диалект провайдера ──
  function messagesForProvider(provider, messages) {
    if (provider === "ollama") {
      // Ollama: tool_calls без id и type; arguments — объект (не строка); content — строка.
      return messages.map((m) => {
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          return {
            role: "assistant",
            content: m.content || "",
            tool_calls: m.tool_calls.map((tc) => ({
              function: {
                name: (tc.function && tc.function.name) || "",
                arguments: jsonArgs(tc.function && tc.function.arguments),
              },
            })),
          };
        }
        if (Array.isArray(m.content)) {
          const c = contentForProvider("ollama", m.content);
          const msg = { role: m.role, content: c.content };
          if (c.images && c.images.length) msg.images = c.images;
          return msg;
        }
        return { role: m.role, content: m.content == null ? "" : m.content };
      });
    }
    if (provider === "anthropic") {
      const out = [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.role === "system") continue; // уходит в верхнеуровневое поле system
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const blocks = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          const ids = [];
          for (const tc of m.tool_calls) {
            const id = tc.id || genCallId();
            ids.push(id);
            blocks.push({
              type: "tool_use",
              id,
              name: (tc.function && tc.function.name) || "",
              input: jsonArgs(tc.function && tc.function.arguments),
            });
          }
          out.push({ role: "assistant", content: blocks });
          // Следующие подряд tool-результаты группируем в ОДНО user-сообщение с tool_result-блоками
          const results = [];
          let used = 0;
          while (i + 1 < messages.length && messages[i + 1].role === "tool") {
            i++;
            results.push({
              type: "tool_result",
              tool_use_id: messages[i].tool_call_id || ids[used] || genCallId(),
              content: messages[i].content || "",
            });
            used++;
          }
          if (results.length) out.push({ role: "user", content: results });
          continue;
        }
        if (m.role === "assistant") {
          out.push({ role: "assistant", content: m.content || "" });
          continue;
        }
        out.push({ role: "user", content: Array.isArray(m.content) ? contentForProvider("anthropic", m.content) : m.content });
      }
      return out;
    }
    return messages; // openai-совместимые — как есть (массив частей с image_url поддерживается нативно)
  }

  function systemText(messages) {
    return messages
      .filter((m) => m.role === "system")
      .map((m) => m.content || "")
      .filter(Boolean)
      .join("\n\n");
  }

  function toolsForProvider(provider, tools) {
    if (provider !== "anthropic") return tools || [];
    return (tools || []).map((t) => ({
      name: t.function && t.function.name,
      description: (t.function && t.function.description) || "",
      input_schema: (t.function && t.function.parameters) || { type: "object", properties: {} },
    }));
  }

  // ── Кэш промпта (ускорение №2) ──────────────────────────────────────────
  // Неизменяемый префикс запроса (системный промпт + схемы инструментов) — это
  // десятки тысяч токенов, которые провайдер иначе пересчитывает на КАЖДОМ
  // раунде. Точка кэша срезает время до первого токена с 5-8 с до 1-2 с на
  // повторных раундах одной задачи. Поле отправляем только тем, кто его
  // понимает: строгие OpenAI-совместимые API отвечают на него 400.
  function cacheableProvider(provider, base, model) {
    if (provider === "anthropic") return "anthropic";
    if (provider !== "openai") return "";
    if (!/openrouter\.ai/i.test(String(base || ""))) return "";
    // OpenRouter кэширует префикс только у Claude и Gemini — другим не шлём.
    return /anthropic\/|claude|gemini|google\//i.test(String(model || "")) ? "openrouter" : "";
  }

  // Граница «статичного» префикса системного промпта. Кэшируемый блок обязан
  // накрывать ТОЛЬКО его: динамический «паспорт проекта» (дерево файлов, режим плана,
  // подсказка после клонирования) меняется почти каждый виток, и если он попадёт ВНУТРЬ
  // кэшируемого блока, промах обнуляет кэш целиком (кэш блоков у Anthropic/OpenRouter) —
  // то есть мы платим полную цену за все ~30k токенов шапки вместо ~10%.
  // Возвращает { head, tail } либо null, если текст не начинается со статичной части.
  function splitStaticSystem(text, staticText) {
    const full = String(text || "");
    const head = String(staticText || "");
    if (!head || !full.startsWith(head)) return null;
    return { head: head, tail: full.slice(head.length) };
  }

  // Системный промпт для Anthropic: при кэше — массив блоков, где точка кэша стоит
  // ровно на статичном префиксе, а динамика идёт следующим блоком без неё.
  function anthropicSystem(sysText, cacheKind, staticText) {
    const text = String(sysText || "");
    if (!text) return null;
    if (!cacheKind) return text;
    const sp = splitStaticSystem(text, staticText);
    if (!sp) return [{ type: "text", text: text, cache_control: { type: "ephemeral" } }];
    const blocks = [{ type: "text", text: sp.head, cache_control: { type: "ephemeral" } }];
    if (sp.tail) blocks.push({ type: "text", text: sp.tail });
    return blocks;
  }

  function withCacheOnFirstSystem(msgs, staticText) {
    const out = (msgs || []).slice();
    for (let i = 0; i < out.length; i++) {
      const m = out[i];
      if (!m || m.role !== "system" || !m.content) continue;
      if (typeof m.content === "string") {
        const sp = splitStaticSystem(m.content, staticText);
        const blocks = [{ type: "text", text: sp ? sp.head : m.content, cache_control: { type: "ephemeral" } }];
        if (sp && sp.tail) blocks.push({ type: "text", text: sp.tail });
        out[i] = { role: "system", content: blocks };
      } else if (Array.isArray(m.content) && m.content.length) {
        out[i] = {
          role: "system",
          content: m.content.map((b, j) =>
            j === m.content.length - 1 ? Object.assign({}, b, { cache_control: { type: "ephemeral" } }) : b
          ),
        };
      }
      break; // только первый — он же самый стабильный
    }
    return out;
  }

  // Строгие OpenAI-совместимые API (G4F, Yandex AI Studio, DeepSeek, свой сервер) ждут
  // system в начале диалога и часто ТОЛЬКО одним сообщением. Промпт, паспорт проекта и
  // справочники групп идут несколькими system-сообщениями подряд — склеиваем именно
  // ведущую серию. Текст, порядок и разделитель («\n\n», как у Anthropic) не меняются,
  // поэтому автоматический кэш префикса OpenAI/DeepSeek/Groq продолжает попадать.
  // Одиночный system и служебные заметки в середине диалога остаются ровно как были.
  function mergeLeadingSystem(messages) {
    const list = messages || [];
    const heads = [];
    let i = 0;
    for (; i < list.length; i++) {
      const m = list[i];
      if (!m || m.role !== "system") break;
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => (b && (b.text || b.content)) || "").join("")
            : "";
      if (text) heads.push(text);
    }
    if (heads.length <= 1) return list; // склеивать нечего — поведение прежнее
    return [{ role: "system", content: heads.join("\n\n") }, ...list.slice(i)];
  }

  // ── Текстовый протокол вызова инструментов (для моделей БЕЗ capability «tools») ──
  // Такой модели схемы бесполезны, а часть сборок Ollama отвечает на них ошибкой
  // «does not support tools» — раунд падал целиком. Вместо JSON-схем (у базового
  // набора это ~6 000 токенов) кладём в системное сообщение компактный каталог
  // текстом: имя(поля) — короткое описание. Ответ модели разбирает
  // extractToolCallsFromText в ядре, поэтому формат блока должен быть ровно такой.
  const TEXT_TOOLS_MAX = 5000; // символов: каталог не должен сам съесть окно слабой модели
  function toolsAsText(tools) {
    const lines = [];
    for (const t of tools || []) {
      const f = t && t.function;
      if (!f || !f.name) continue;
      const props = (f.parameters && f.parameters.properties) || {};
      const required = (f.parameters && f.parameters.required) || [];
      const sign = Object.keys(props)
        .map((a) => (required.indexOf(a) >= 0 ? a : a + "?"))
        .join(", ");
      const desc = String(f.description || "").replace(/\s+/g, " ").split(". ")[0];
      lines.push(f.name + "(" + sign + ") — " + desc.slice(0, 140));
    }
    if (!lines.length) return "";
    let text = lines.join("\n");
    if (text.length > TEXT_TOOLS_MAX) {
      text = text.slice(0, TEXT_TOOLS_MAX) + "\n… (каталог обрезан — остальные найдёт findTools)";
    }
    return text;
  }

  // Правило вызова + каталог — одним куском. Нужен и для сообщения (withTextTools),
  // и для системного поля Anthropic, поэтому текст собран в одном месте.
  function textToolRule(tools) {
    const cat = toolsAsText(tools);
    if (!cat) return "";
    return (
      "\n\n=== КАК ВЫЗЫВАТЬ ИНСТРУМЕНТЫ (структурный вызов твоим сервером не поддержан) ===\n" +
      "Закончи ответ ОДНИМ блоком JSON в отдельной строке — без пояснений внутри блока:\n" +
      '{"name": "имяИнструмента", "arguments": {"поле": "значение"}}\n' +
      "Пояснение, если нужно, пиши ДО блоков. Можно дать несколько блоков подряд, каждый на своей строке — " +
      "приложение выполнит их и вернёт результаты. Если инструмент не нужен — просто ответь текстом.\n\n" +
      "Доступны (в скобках поля, «?» — необязательное поле):\n" + cat
    );
  }

  // Каталог + правило вызова дописываются в СИСТЕМНОЕ сообщение: у Ollama часть
  // шаблонов читает только первый system, а mergeLeadingSystem уже склеил ведущие.
  function withTextTools(messages, tools) {
    const rule = textToolRule(tools);
    if (!rule || !messages || !messages.length) return messages;
    const first = messages[0] && messages[0].role === "system" ? messages[0] : null;
    if (!first) return [{ role: "system", content: rule.trim() }].concat(messages);
    // У OpenAI-совместимых content бывает массивом частей (текст + картинки):
    // превращать его в строку нельзя — картинка потеряется.
    if (Array.isArray(first.content)) {
      const parts = first.content.concat([{ type: "text", text: rule }]);
      return [Object.assign({}, first, { content: parts })].concat(messages.slice(1));
    }
    const head = first.content == null ? "" : String(first.content);
    return [Object.assign({}, first, { content: head + rule })].concat(messages.slice(1));
  }

  /**
   * Собирает HTTP-запрос к нужному провайдеру.
   * s — объект настроек: { provider, ollamaUrl, openaiUrl, anthropicUrl, openaiApiKey, anthropicApiKey }
   * opts — { model, messages, tools, fromBrowser, noTools, numCtxBudget, modelWindow }
   */
  function buildChatRequest(s, opts) {
    const provider = s && s.provider ? s.provider : "openai";
    const model = opts && opts.model;
    const messages = (opts && opts.messages) || [];
    const tools = (opts && opts.tools) || TOOL_DEFINITIONS;
    const fromBrowser = !!(opts && opts.fromBrowser);
    const apiKey = apiKeyFor(provider, s);
    const headers = apiHeaders(provider, apiKey, fromBrowser, projectHeader(s));

    if (provider === "ollama") {
      // num_ctx: без него Ollama берёт дефолт модели (часто 2048) и молча режет запрос,
      // где только промпт ~6k и схемы инструментов ~6k. keep_alive: дефолтные 5 минут
      // выгружали модель между раундами (загрузка = секунды на каждом).
      const merged = mergeLeadingSystem(messagesForProvider(provider, messages));
      const body = {
        model,
        messages: merged,
        stream: true,
        keep_alive: OLLAMA_KEEP_ALIVE,
      };
      // Модель, которая сама себя объявила без инструментов (capabilities из /api/show):
      // схемы в запросе ей бесполезны, а сервер может ответить ошибкой — тогда раунд
      // падал целиком. Отдаём каталог текстом и просим вызывать инструменты JSON-блоком.
      if (opts && opts.noTools) body.messages = withTextTools(merged, tools);
      else body.tools = tools;
      const numCtx = ollamaNumCtx(opts && opts.numCtxBudget, opts && opts.modelWindow);
      if (numCtx > 0) body.options = { num_ctx: numCtx };
      return { url: baseFor(provider, s) + "/api/chat", headers, body: JSON.stringify(body) };
    }
    const cacheKind = cacheableProvider(provider, baseFor(provider, s), model);
    if (provider === "anthropic") {
      const noTools = !!(opts && opts.noTools);
      const toolDefs = toolsForProvider(provider, tools);
      // Точка кэша на последней схеме инструмента — кэширует весь блок tools.
      if (cacheKind && !noTools && toolDefs.length) {
        toolDefs[toolDefs.length - 1] = Object.assign({}, toolDefs[toolDefs.length - 1], {
          cache_control: { type: "ephemeral" },
        });
      }
      let sys = systemText(messages);
      const body = {
        model,
        max_tokens: 4096,
        messages: messagesForProvider(provider, messages),
        stream: true,
      };
      // Каталог дописывается В КОНЕЦ системного текста: статичный префикс промпта
      // остаётся началом строки, поэтому точка кэша не срывается.
      if (noTools) sys += textToolRule(tools);
      else body.tools = toolDefs;
      if (sys) body.system = anthropicSystem(sys, cacheKind, opts && opts.staticSystem);
      return {
        url: baseFor(provider, s) + "/v1/messages",
        headers,
        body: JSON.stringify(body),
      };
    }
    // G4F-маршрут «Провайдер:модель» (например HuggingChat:gpt-4o-mini):
    // современный g4f принимает провайдера отдельным полем provider, а имя модели — без префикса.
    // Справочники/паспорт проекта идут несколькими system подряд: строгим серверам
    // отдаём один ведущий system (текст и порядок те же).
    const noToolsOpenai = !!(opts && opts.noTools);
    let openaiMessages = mergeLeadingSystem(messagesForProvider("openai", messages));
    // Сервер не умеет вызывать инструменты (модель без tools у LM Studio/vLLM или
    // строгий шлюз): схемы не шлём, отдаём каталог текстом — иначе запрос падает 400.
    if (noToolsOpenai) openaiMessages = withTextTools(openaiMessages, tools);
    if (cacheableProvider(provider, baseFor(provider, s), model) === "openrouter") {
      openaiMessages = withCacheOnFirstSystem(openaiMessages, opts && opts.staticSystem);
    }
    const body = { model, messages: openaiMessages, stream: true };
    if (!noToolsOpenai) body.tools = tools;
    // Токены и попадание в кэш OpenAI-совместимые API отдают в стриме ТОЛЬКО по
    // явному запросу stream_options.include_usage (последний чанк с usage).
    // Строгий сервер может поля не знать — тогда main.js выключает его и повторяет.
    if (opts && opts.includeUsage) body.stream_options = { include_usage: true };
    const g4f = splitG4fRoute(model);
    if (g4f) {
      body.model = g4f.model;
      body.provider = g4f.provider;
    }
    return {
      url: proxiedBase(baseFor(provider, s)) + "/chat/completions",
      headers,
      body: JSON.stringify(body),
    };
  }

  /**
   * Читает стрим ответа провайдера и вызывает колбэки:
   *   onText(text)     — очередной кусок текста (без обработки <think> — это делает вызывающий)
   *   onToolCall(call) — завершённый вызов инструмента { id, name, args } (аргументы — объект)
   *   onThinking(text) — нативные рассуждения модели: DeepSeek reasoning_content,
   *                      Anthropic thinking_delta (мысли приходят отдельным потоком)
   * Поддерживает NDJSON (Ollama), OpenAI-SSE и Anthropic-SSE.
   */
  // ── Чтение стрима ответа провайдера с защитой от «вечного ожидания» ──
  // 1) Ошибки, которые провайдеры шлют прямо в стриме (data: {"error": ...} —
  //    OpenAI-совместимые, {"type":"error"} — Anthropic, NDJSON-ошибки Ollama),
  //    превращаются в исключение с понятным текстом, а не молча пропускаются
  //    (раньше это выглядело как «бесконечное думание»).
  // 2) Таймауты: первый байт (firstByteTimeoutMs, по умолчанию 90 с) и пауза
  //    между чанками (idleTimeoutMs, по умолчанию 60 с) — зависший/молчащий
  //    провайдер завершается ошибкой вместо бесконечного ожидания.
  // Токен-отчёт провайдера → единый вид { prompt, completion, cached }: разные API
  // кладут попадание в кэш в разные поля (OpenAI/OpenRouter — prompt_tokens_details,
  // DeepSeek — prompt_cache_hit_tokens, Anthropic — cache_read_input_tokens).
  function normalizeUsage(u) {
    if (!u || typeof u !== "object") return null;
    const det = u.prompt_tokens_details || u.input_tokens_details || null;
    const prompt = u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens != null ? u.input_tokens : 0;
    const completion = u.completion_tokens != null ? u.completion_tokens : u.output_tokens != null ? u.output_tokens : 0;
    const cached =
      (det && det.cached_tokens) || u.prompt_cache_hit_tokens || u.cache_read_input_tokens || 0;
    return { prompt: prompt || 0, completion: completion || 0, cached: cached || 0 };
  }

  async function consumeProviderStream({ response, provider, onText, onToolCall, onThinking, onUsage, onTruncated, local, firstByteTimeoutMs, idleTimeoutMs }) {
    if (!response || !response.body) throw new Error("Пустой ответ от сервера (нет тела).");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Аккумуляция по индексу блока (OpenAI: tool_calls по index; Anthropic: content_block по index)
    const accum = new Map();
    const seenOllamaCalls = new Set();
    // Gemini 3.x: шифрованная подпись мысли (thought signature) приходит в
    // extra_content.google.thought_signature — на самом tool-call или отдельной дельтой.
    // Её нужно вернуть модели дословно в следующем запросе, иначе API отвечает 400
    // «Function call is missing a thought_signature in functionCall parts».
    let pendingExtra = null;
    const finalizeAccum = () => {
      for (const item of accum.values()) {
        if (!item.name) continue;
        const call = { id: item.id || genCallId(), name: item.name, args: jsonArgs(item.args) };
        if (item.extra) call.extraContent = item.extra;
        if (onToolCall) onToolCall(call);
      }
      accum.clear();
      pendingExtra = null;
    };
    // Локальная модель грузится и читает промпт на CPU минутами: 90 с на первый байт
    // для неё — обрыв на пустом месте (модель просто ещё считает). Облачные значения
    // не трогаем: там молчание 90 с — признак настоящей поломки. «Локальность»
    // приходит флагом: LM Studio и vLLM на localhost — такие же местные серверы.
    const localish = !!local || provider === "ollama";
    const firstMs = firstByteTimeoutMs || (localish ? 300000 : 90000);
    const idleMs = idleTimeoutMs || (localish ? 120000 : 60000);
    let gotFirst = false;
    // reader.read() с таймером: зависший стрим не держит чат в «думании» вечно.
    const readChunk = () =>
      new Promise((resolve, reject) => {
        const ms = gotFirst ? idleMs : firstMs;
        const timer = setTimeout(() => {
          reader.cancel().catch(() => {});
          reject(
            new Error(
              gotFirst
                ? "Провайдер замолчал — данные не приходили более " + Math.round(ms / 1000) + " с. Проверь сеть или выбери другого провайдера."
                : "Провайдер не отвечает — первый байт не пришёл за " + Math.round(ms / 1000) + " с. Проверь, что сервер запущен и URL в настройках верный."
            )
          );
        }, ms);
        reader.read().then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          }
        );
      });
    const errText = (e) => {
      if (!e) return "";
      if (typeof e === "string") return e;
      return e.message || e.detail || e.code || JSON.stringify(e).slice(0, 300);
    };
    try {
      while (true) {
        const { done, value } = await readChunk();
        if (done) break;
        // «Первый байт» засчитываем только при реальных данных: провайдер, который шлёт
        // пустые keep-alive чанки, но так и не отвечает, тоже завершится по таймауту.
        if (value && value.length) gotFirst = true;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;

          if (provider === "ollama") {
            // NDJSON: каждая строка — полный JSON-объект
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            if (obj && obj.error) throw new Error("Ошибка Ollama: " + errText(obj.error));
            const msg = (obj && obj.message) || {};
            if (msg.content && onText) onText(msg.content);
            // Thinking-модели (qwen3, deepseek-r1, gpt-oss) кладут рассуждения в отдельное
            // поле message.thinking. Без него размышления локальной модели не видны вовсе,
            // и план, написанный в них, не попадал ни в блок мыслей, ни в панель плана.
            if (msg.thinking && onThinking) onThinking(msg.thinking);
            // Финальный чанк (done) несёт счётчики промпта и ответа.
            if (onUsage && obj.done && (obj.prompt_eval_count != null || obj.eval_count != null)) {
              onUsage({ prompt: obj.prompt_eval_count || 0, completion: obj.eval_count || 0, cached: 0 });
            }
            // done_reason «length» = модель упёрлась в лимит вывода и оборвала ответ
            // на полуслове. Раньше это выглядело как обычный законченный ответ.
            if (obj.done && obj.done_reason === "length" && onTruncated) onTruncated();
            if (Array.isArray(msg.tool_calls)) {
              for (const tc of msg.tool_calls) {
                const f = tc.function || {};
                if (!f.name) continue;
                // Ollama в финальном (done:true) чанке может повторно прислать tool_calls —
                // дедуплицируем одинаковые вызовы в пределах одного стрима, чтобы инструмент
                // не выполнился дважды (двойное создание папки / двойной git commit).
                const args = jsonArgs(f.arguments);
                const sig = f.name + "|" + JSON.stringify(args);
                if (seenOllamaCalls.has(sig)) continue;
                seenOllamaCalls.add(sig);
                if (onToolCall) onToolCall({ id: tc.id || genCallId(), name: f.name, args });
              }
            }
            continue;
          }

          if (!line.startsWith("data:")) continue; // SSE (OpenAI/Anthropic): игнорируем event:-строки
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }

          if (provider === "openai") {
            // Ошибка внутри стрима (частая беда бесплатных провайдеров G4F:
            // «Зарегистрируйтесь и повторите свой запрос» и т.п.) — показываем её,
            // а не ждём вечно молчания.
            if (obj.error || (obj.type === "error" && obj.error)) {
              throw new Error("Провайдер ответил ошибкой: " + (errText(obj.error) || errText(obj)));
            }
            // Финальный чанк при include_usage: choices пустой, а usage заполнен —
            // поэтому читаем usage ДО выхода по отсутствию choice.
            if (obj.usage && onUsage) onUsage(normalizeUsage(obj.usage));
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            // finish_reason «length» = модель упёрлась в лимит вывода и оборвала ответ
            // на полуслове. Раньше эту пометку получал только Ollama (done_reason), и у
            // облачных провайдеров (DeepSeek, Groq, OpenAI) обрезанный ответ выглядел
            // законченным: человек не знал, что нужно написать «продолжай».
            if (choice.finish_reason === "length" && onTruncated) onTruncated();
            const delta = choice.delta || {};
            if (delta.content && onText) onText(delta.content);
            // DeepSeek и другие OpenAI-совместимые шлют рассуждения отдельным полем
            if (delta.reasoning_content && onThinking) onThinking(delta.reasoning_content);
            // Часть провайдеров (OpenRouter, vLLM, некоторые сборки-прокси) называет поле
            // просто reasoning — раньше такие рассуждения пропадали целиком.
            else if (delta.reasoning && onThinking) onThinking(delta.reasoning);
            // Gemini может прислать подпись мысли отдельным полем delta.extra_content
            // (до или вместо поля на самом tool-call) — запоминаем и подставляем вызовам без своей.
            if (delta.extra_content && delta.extra_content.google && delta.extra_content.google.thought_signature) {
              pendingExtra = delta.extra_content;
            }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const i = tc.index || 0;
                const cur = accum.get(i) || { id: "", name: "", args: "", extra: null };
                if (tc.id) cur.id = tc.id;
                const fn = tc.function || {};
                if (fn.name) cur.name = fn.name;
                if (fn.arguments) cur.args += fn.arguments;
                if (tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature) {
                  cur.extra = tc.extra_content;
                } else if (pendingExtra && !cur.extra) {
                  cur.extra = pendingExtra;
                }
                accum.set(i, cur);
              }
              pendingExtra = null;
            }
          } else if (provider === "anthropic") {
            const type = obj.type;
            if (type === "error" && obj.error) {
              throw new Error("Claude ответил ошибкой: " + errText(obj.error));
            }
            // usage: message_start — входные токены (и чтение из кэша),
            // message_delta — выходные. Собираются воедино в main.js.
            if (onUsage && type === "message_start" && obj.message && obj.message.usage) {
              onUsage(normalizeUsage(obj.message.usage));
            }
            if (onUsage && type === "message_delta" && obj.usage) onUsage(normalizeUsage(obj.usage));
            // stop_reason «max_tokens» = ответ оборван лимитом вывода (у Claude своё имя).
            if (type === "message_delta" && obj.delta && obj.delta.stop_reason === "max_tokens" && onTruncated) onTruncated();
            if (type === "content_block_start") {
              const block = obj.content_block || {};
              const cur = accum.get(obj.index) || { id: "", name: "", args: "" };
              if (block.type === "tool_use") {
                if (block.id) cur.id = block.id;
                if (block.name) cur.name = block.name;
              }
              accum.set(obj.index, cur);
            } else if (type === "content_block_delta") {
              const delta = obj.delta || {};
              const cur = accum.get(obj.index) || { id: "", name: "", args: "" };
              if (delta.type === "text_delta" && delta.text && onText) onText(delta.text);
              else if (delta.type === "thinking_delta" && delta.thinking && onThinking) onThinking(delta.thinking);
              else if (delta.type === "input_json_delta" && delta.partial_json) cur.args += delta.partial_json;
              accum.set(obj.index, cur);
            }
            // content_block_stop / message_delta / message_stop: ничего не делаем, финализируем ниже
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    finalizeAccum();
  }

  /** Возвращает список доступных моделей у выбранного провайдера (throws при ошибке). */
  async function listModels(s, opts) {
    const provider = s && s.provider ? s.provider : "openai";
    const fromBrowser = !!(opts && opts.fromBrowser);
    const apiKey = apiKeyFor(provider, s);
    const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
    const headers = apiHeaders(provider, apiKey, fromBrowser, projectHeader(s));

    if (provider === "ollama") {
      const res = await fetch(baseFor(provider, s) + "/api/tags", { headers, signal: timeout });
      if (!res.ok) throw new Error("Ollama error " + res.status + ": " + (await res.text()).slice(0, 300));
      const data = await res.json();
      return (data.models || []).map((m) => m.name);
    }
    if (provider === "anthropic") {
      const res = await fetch(baseFor(provider, s) + "/v1/models", { headers, signal: timeout });
      if (!res.ok) throw new Error("Claude API error " + res.status + ": " + (await res.text()).slice(0, 300));
      const data = await res.json();
      return (data.data || []).map((m) => m.id);
    }
    const res = await fetch(proxiedBase(baseFor(provider, s)) + "/models", { headers, signal: timeout });
    if (!res.ok) throw new Error("API error " + res.status + ": " + (await res.text()).slice(0, 300));
    const data = await res.json();
    return (data.data || []).map((m) => m.id);
  }

  // ── Ollama: реальное окно модели и параметры запроса ───────────────────────
  // Дефолт Ollama — контекст 2048 токенов, а приложение считало бюджет 14 000:
  // сервер МОЛЧА резал запрос (терялись системный промпт, схемы инструментов и
  // история), и агент работал «вслепую». Поэтому окно спрашиваем у сервера,
  // выделяем ровно нужный контекст и держим модель в памяти между раундами.
  const OLLAMA_KEEP_ALIVE = "30m"; // дефолт Ollama — 5 минут: модель выгружалась между раундами
  const _ollamaInfoCache = new Map(); // base|model → { ts, window, tools, vision, known }
  const _OLLAMA_INFO_TTL = 10 * 60 * 1000;
  async function ollamaModelInfo(s, model) {
    const name = String(model || "");
    const base = baseFor("ollama", s);
    const key = base + "|" + name;
    const now = Date.now();
    const hit = _ollamaInfoCache.get(key);
    if (hit && now - hit.ts <= _OLLAMA_INFO_TTL) return hit;
    const info = { ts: now, window: 0, tools: false, vision: false, known: false, layers: 0, kvPerToken: 0 };
    if (name) {
      try {
        const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
        const res = await fetch(base + "/api/show", {
          method: "POST",
          headers: apiHeaders("ollama", apiKeyFor("ollama", s), false, projectHeader(s)),
          signal: timeout,
          body: JSON.stringify({ name: name, model: name }),
        });
        if (res.ok) {
          const d = await res.json();
          // capabilities есть только у новых сборок Ollama: если поля нет, про
          // инструменты модели мы НИЧЕГО не знаем и молчим (иначе ложное предупреждение).
          const caps = Array.isArray(d.capabilities) ? d.capabilities.map((c) => String(c).toLowerCase()) : null;
          if (caps) {
            info.known = true;
            info.tools = caps.indexOf("tools") !== -1;
            info.vision = caps.indexOf("vision") !== -1;
          }
          // model_info: "qwen3.context_length" (у старых сборок — "llama.context_length").
          // Ключ архитектуры важнее: у мультимодальных моделей рядом лежат ключи
          // подсистем (gemma4.audio.context_length), и максимум по всем подменил бы
          // окно модели окном энкодера.
          const mi = d.model_info || {};
          const arch = String(mi["general.architecture"] || "");
          let max = arch && Number(mi[arch + ".context_length"]) > 0 ? Number(mi[arch + ".context_length"]) : 0;
          if (!max) {
            for (const k of Object.keys(mi)) {
              if (!/context_length$/i.test(k)) continue;
              const n = Number(mi[k]);
              if (n > 0 && n > max) max = n;
            }
          }
          // Modelfile мог задать num_ctx вручную — осознанный потолок автора модели.
          const mnum = /num_ctx\s+(\d+)/i.exec(String(d.parameters || ""));
          const defCtx = mnum ? Number(mnum[1]) : 0;
          info.window = max > 0 ? max : defCtx;
          info.defaultCtx = defCtx;
          // Цена одного токена контекста в памяти: 2 (K и V) × слои × головы KV ×
          // размер головы × 2 байта (f16). Нужна, чтобы честно сказать, сколько ГБ
          // съест запрошенный num_ctx — самая частая причина «модель ушла на CPU».
          const miNum = (key) => {
            const direct = Number(mi[arch + "." + key]) || 0;
            if (direct) return direct;
            for (const k of Object.keys(mi)) {
              if (k !== key && !k.endsWith("." + key)) continue;
              const n = Number(mi[k]);
              if (n > 0) return n;
            }
            return 0;
          };
          const layers = miNum("block_count");
          const kvHeads = miNum("attention.head_count_kv");
          const heads = miNum("attention.head_count");
          const emb = miNum("embedding_length");
          const headDim = heads > 0 && emb > 0 ? emb / heads : 0;
          info.layers = layers;
          if (layers > 0 && kvHeads > 0 && headDim > 0) {
            info.kvPerToken = Math.round(2 * layers * kvHeads * headDim * 2);
          }
        }
      } catch {}
    }
    _ollamaInfoCache.set(key, info);
    return info;
  }

  // Сколько токенов контекста просить у Ollama: ровно столько, сколько нужно запросу
  // (бюджет + запас на ответ и tool-результаты), но НИКОГДА больше реального окна.
  // Без бюджета (0) дефолт модели не трогаем: уменьшать окно без причины нельзя.
  function ollamaNumCtx(budget, window) {
    const b = Math.round(Number(budget) || 0);
    if (b <= 0) return 0;
    const need = b + 4096;
    const win = Math.round(Number(window) || 0);
    return win > 0 ? Math.min(need, win) : need;
  }
  // ── Реальное окно модели (context_length / context_window из GET /models) ──
  const _ctxModelsCache = new Map(); // base → { ts, byModel: Map<model, window> }
  const _CTX_TTL = 10 * 60 * 1000;
  // Родные ручки локальных серверов: /v1/models у них часто без окна.
  // LM Studio: /api/v0/models → max_context_length; llama.cpp: /props → n_ctx
  // (имя модели там — путь к .gguf, поэтому окно сервера идёт «общим» на базу).
  async function _localServerWindows(root, byModel) {
    const to = () =>
      typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
    let propsWindow = 0;
    try {
      const r = await fetch(root + "/api/v0/models", { signal: to() });
      if (r.ok) {
        const d = await r.json();
        for (const m of d.data || []) {
          const id = m && m.id ? String(m.id) : "";
          const win = Number((m && (m.max_context_length || m.loaded_context_length)) || 0) || 0;
          if (id && win > 0 && !byModel.has(id)) byModel.set(id, win);
        }
      }
    } catch {}
    try {
      const r = await fetch(root + "/props", { signal: to() });
      if (r.ok) {
        const d = await r.json();
        const dg = (d && d.default_generation_settings) || {};
        propsWindow = Number(dg.n_ctx || (d && d.n_ctx) || 0) || 0;
      }
    } catch {}
    return propsWindow;
  }

  async function modelWindow(s, model) {
    const provider = s && s.provider ? s.provider : "openai";
    if (provider === "ollama") return (await ollamaModelInfo(s, model)).window || 0;
    if (provider !== "openai" || !model) return 0;
    const base = baseFor(provider, s);
    const now = Date.now();
    let entry = _ctxModelsCache.get(base);
    if (!entry || now - entry.ts > _CTX_TTL) {
      const byModel = new Map();
      let propsWindow = 0;
      try {
        const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
        const res = await fetch(proxiedBase(base) + "/models", {
          headers: apiHeaders(provider, apiKeyFor(provider, s), false, projectHeader(s)),
          signal: timeout,
        });
        if (res.ok) {
          const d = await res.json();
          for (const m of d.data || []) {
            const id = m && m.id ? String(m.id) : "";
            // max_model_len отдают vLLM и часть сборок TGI.
            const win = Number((m && (m.context_length || m.context_window || m.max_model_len)) || 0) || 0;
            if (id && win > 0) byModel.set(id, win);
          }
        }
      } catch {}
      // Только для локальных адресов: у облака этих ручек нет, а лишний запрос
      // к чужому серверу — это шум и подозрительное поведение.
      if (isLocalBase(base)) {
        const root = String(base || "").replace(/\/+$/, "").replace(/\/v1$/, "");
        propsWindow = await _localServerWindows(root, byModel);
      }
      entry = { ts: now, byModel: byModel, propsWindow: propsWindow };
      _ctxModelsCache.set(base, entry);
    }
    if (!entry) return 0;
    if (entry.byModel.has(model)) return entry.byModel.get(model);
    // Суффиксные варианты id: "vendor/model:free", "vendor/model@date", "vendor/model-vN"
    for (const [id, win] of entry.byModel) {
      if (id.startsWith(model + ":") || id.startsWith(model + "@") || id.startsWith(model + "-")) return win;
    }
    // llama.cpp назвал модель путём к .gguf — окно сервера всё равно верное.
    if (entry.propsWindow > 0) return entry.propsWindow;
    return 0;
  }

  // ── Проверка локальной модели: не «есть связь», а «сколько она думает» ─────
  // Обычная проверка подключения отвечает только на «сервер жив». Пользователь
  // спрашивает другое: «тормозит ноутбук или настройки?». Ответ даёт сам сервер —
  // Ollama кладёт в каждый ответ длительности (загрузка модели, чтение промпта,
  // генерация), а /api/ps показывает, сколько весов реально лежит в видеопамяти.
  function _probeTimeout(ms) {
    return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
  }
  function probeSec(ms) {
    const s = (Number(ms) || 0) / 1000;
    if (s <= 0) return "—";
    if (s < 1) return Math.round(Number(ms)) + " мс";
    if (s < 60) return Math.round(s * 10) / 10 + " с";
    const m = Math.floor(s / 60);
    return m + " мин " + Math.round(s - m * 60) + " с";
  }
  function probeGb(bytes) {
    return (Number(bytes || 0) / 1073741824).toFixed(1).replace(/\.0$/, "") + " ГБ";
  }
  function probeSpeed(tokens, ms) {
    const sec = (Number(ms) || 0) / 1000;
    if (!tokens || sec <= 0) return 0;
    return Math.round((Number(tokens) / sec) * 10) / 10;
  }
  // Загруженные модели и их память: size — всего, size_vram — сколько в видеопамяти.
  // Есть не во всех сборках Ollama, поэтому молчание сервера — не ошибка проверки.
  async function ollamaPs(base, headers) {
    try {
      const res = await fetch(base + "/api/ps", { headers, signal: _probeTimeout(5000) });
      if (!res.ok) return [];
      const d = await res.json();
      return Array.isArray(d.models) ? d.models : [];
    } catch {
      return [];
    }
  }
  function _psEntry(list, name) {
    for (const m of list || []) {
      const n = String((m && (m.name || m.model)) || "");
      if (n === name || n.split(":")[0] === name.split(":")[0]) return m || {};
    }
    return {};
  }
  function probeVerdict(r) {
    const known = r.weightsBytes > 0;
    const onCpu = known && r.gpuShare < 0.02;
    const partial = known && r.gpuShare >= 0.02 && r.gpuShare < 0.98;
    const slowGen = r.genPerSec > 0 && r.genPerSec < 8;
    const slowRead = r.prefillPerSec > 0 && r.prefillPerSec < 60;
    if (onCpu && slowGen) return "модель целиком считает процессор (" + r.genPerSec + " ток/с) — упор в железо, а не в подключение (это localhost).";
    if (partial && (slowGen || slowRead)) return "часть весов в видеопамяти, остальное считает процессор (" + Math.round(r.gpuShare * 100) + "% на GPU) — узкое место в железе, а не в подключении.";
    if (slowRead && !slowGen) return "генерация бодрая, а чтение промпта медленное: тормозит объём запроса (системный промпт + схемы инструментов), а не модель.";
    if (slowRead) return "и чтение промпта, и генерация медленные — это скорость железа.";
    if (slowGen) return "ответы идут медленно (" + r.genPerSec + " ток/с) — модель тяжёлая для этой машины.";
    if (r.genPerSec > 0) return "скорости в норме — железо справляется, в подключении узкого места нет.";
    return "сервер ответил, но разбивку по скоростям не отдал — судить не по чему.";
  }
  function probeAdvice(r) {
    const a = [];
    const slowGen = r.genPerSec > 0 && r.genPerSec < 8;
    const midGen = r.genPerSec > 0 && r.genPerSec < 25;
    if (r.gpuShare > 0 && r.gpuShare < 0.98) {
      a.push("Веса не влезли в видеопамять целиком: модель поменьше или квантизация полегче дадут разы, а не проценты.");
    } else if (!r.weightsBytes && slowGen) {
      a.push("Генерация ниже 8 ток/с — это уровень процессора: такой ноутбук эту модель не тянет.");
    }
    if (r.kvBytes > 0 && r.numCtx > 16384 && (slowGen || midGen)) {
      a.push("num_ctx " + r.numCtx + " — это ~" + probeGb(r.kvBytes) + " KV-кэша: ручные 8–16k освободят память и ускорят чтение промпта.");
    }
    if (r.estimateSec > 60) {
      a.push("Наш обычный запрос читается " + probeSec(r.estimateSec * 1000) + " — это объём системного промпта и схем инструментов, а не размер истории.");
    }
    if (midGen) {
      a.push("У моделей с размышлениями (qwen3, deepseek-r1) перед ответом идут сотни токенов — при такой скорости это минуты на каждый шаг.");
    }
    return a.slice(0, 3);
  }
  function probeLines(r) {
    const out = [];
    out.push("📊 " + r.model + " @ " + (r.base || "—"));
    out.push("• Связь: сервер ответил за " + probeSec(r.connectMs));
    if (r.provider === "ollama") {
      out.push(
        "• Загрузка модели: " + (r.loadMs > 0 ? probeSec(r.loadMs) : "без загрузки") +
          (r.wasLoaded ? " (модель уже была в памяти)" : " (модель была выгружена)")
      );
    }
    if (r.weightsBytes > 0) {
      const where = r.gpuShare >= 0.98
        ? "целиком в видеопамяти (GPU)"
        : r.gpuShare > 0
          ? "в видеопамяти " + probeGb(r.vramBytes) + " из " + probeGb(r.weightsBytes) + " — часть считает процессор"
          : "в видеопамяти 0 — считает процессор";
      out.push("• Память: веса " + probeGb(r.weightsBytes) + ", " + where);
    }
    if (r.prefillMs > 0) {
      out.push("• Чтение промпта: " + r.prefillTokens + " токенов за " + probeSec(r.prefillMs) + " — " + r.prefillPerSec + " ток/с");
    }
    if (r.genMs > 0) {
      out.push("• Генерация: " + r.genTokens + " токенов за " + probeSec(r.genMs) + " — " + r.genPerSec + " ток/с");
    } else if (r.genPerSec > 0) {
      out.push("• Полный ответ: " + r.genTokens + " токенов за " + probeSec(r.totalMs) + " (" + r.genPerSec + " ток/с; разбивку сервер не отдаёт)");
    }
    if (r.window || r.numCtx) {
      let ctx = "• Контекст: окно модели " + (r.window || "неизвестно") + ", запросим num_ctx " + (r.numCtx || "по умолчанию");
      if (r.kvBytes > 0) ctx += " — KV-кэш ≈ " + probeGb(r.kvBytes);
      out.push(ctx);
    }
    if (r.estimateSec > 0) {
      out.push("• Наш обычный запрос (~" + r.promptTokens + " токенов) только читается ≈ " + probeSec(r.estimateSec * 1000));
    }
    out.push("Вердикт: " + probeVerdict(r));
    return out;
  }

  // Шаги замера у Ollama: связь → пробный ответ (длительности) → память → окно.
  // num_ctx передаётся ТОТ ЖЕ, что у боевого чата: другой размер контекста заставил бы
  // Ollama перезагрузить модель, и сама проверка испортила бы следующий ответ.
  async function _probeOllama(s, name, r, headers, o, timeoutMs) {
    const base = baseFor("ollama", s);
    r.base = base;
    const t0 = Date.now();
    const tags = await fetch(base + "/api/tags", { headers, signal: _probeTimeout(Math.min(15000, timeoutMs)) });
    if (!tags.ok) throw new Error("Ollama ответила " + tags.status + " на /api/tags: " + (await tags.text()).slice(0, 200));
    r.connectMs = Date.now() - t0;
    const before = await ollamaPs(base, headers);
    const pre = _psEntry(before, name);
    r.wasLoaded = !!(pre.name || pre.model);
    // Балласт для честного замера чтения промпта: на тридцати токенах скорость скачет.
    const chars = Math.max(0, Math.round(Number(o.probeChars) || 1200));
    const body = {
      model: name,
      messages: [{
        role: "user",
        content: "Повтори одно слово: готов" + (chars
          ? "\n\nСлужебный текст для замера скорости (отвечать на него не нужно): " + "замер ".repeat(Math.round(chars / 6)).trim()
          : ""),
      }],
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: { num_predict: 24, temperature: 0 },
    };
    if (r.numCtx > 0) body.options.num_ctx = r.numCtx;
    const t1 = Date.now();
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: _probeTimeout(timeoutMs),
    });
    if (!res.ok) throw new Error("Ollama ответила " + res.status + " на /api/chat: " + (await res.text()).slice(0, 200));
    const d = await res.json();
    r.totalMs = Date.now() - t1;
    r.loadMs = Math.round((Number(d.load_duration) || 0) / 1e6);
    r.prefillTokens = Number(d.prompt_eval_count) || 0;
    r.prefillMs = Math.round((Number(d.prompt_eval_duration) || 0) / 1e6);
    r.genTokens = Number(d.eval_count) || 0;
    r.genMs = Math.round((Number(d.eval_duration) || 0) / 1e6);
    r.prefillPerSec = probeSpeed(r.prefillTokens, r.prefillMs);
    r.genPerSec = probeSpeed(r.genTokens, r.genMs);
    // Память смотрим ПОСЛЕ запроса: теперь модель гарантированно загружена.
    const me = _psEntry(await ollamaPs(base, headers), name);
    r.weightsBytes = Number(me.size) || 0;
    r.vramBytes = Number(me.size_vram) || 0;
    r.gpuShare = r.weightsBytes > 0 ? r.vramBytes / r.weightsBytes : 0;
    const info = await ollamaModelInfo(s, name);
    if (info) {
      if (!r.window && info.window) r.window = info.window;
      if (info.known) r.tools = !!info.tools;
      r.kvPerToken = Number(info.kvPerToken) || 0;
    }
    if (!r.numCtx && r.window) r.numCtx = ollamaNumCtx(o.budget, r.window);
    if (r.kvPerToken > 0 && r.numCtx > 0) r.kvBytes = Math.round(r.kvPerToken * r.numCtx);
  }

  // Местный сервер OpenAI-совместимого API (LM Studio, llama.cpp, g4f): разбивку
  // «чтение промпта / генерация» он не отдаёт, поэтому меряем полное время ответа.
  async function _probeCompatible(s, name, r, headers, o, timeoutMs) {
    const provider = (s && s.provider) || "openai";
    const base = baseFor(provider, s);
    r.base = base;
    const t0 = Date.now();
    const res = await fetch(proxiedBase(base) + "/models", { headers, signal: _probeTimeout(10000) });
    r.connectMs = Date.now() - t0;
    if (!res.ok) throw new Error("сервер ответил " + res.status + " на /models: " + (await res.text()).slice(0, 200));
    const t1 = Date.now();
    const res2 = await fetch(proxiedBase(base) + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: name,
        messages: [{ role: "user", content: "Повтори одно слово: готов" }],
        max_tokens: 16,
        stream: false,
        temperature: 0,
      }),
      signal: _probeTimeout(timeoutMs),
    });
    if (!res2.ok) throw new Error("сервер ответил " + res2.status + " на /chat/completions: " + (await res2.text()).slice(0, 200));
    const d = await res2.json();
    r.totalMs = Date.now() - t1;
    const u = d.usage || {};
    r.prefillTokens = Number(u.prompt_tokens) || 0;
    r.genTokens = Number(u.completion_tokens) || 0;
    r.genPerSec = probeSpeed(r.genTokens, r.totalMs);
  }

  /**
   * Измеряет локальную модель: связь, загрузку, чтение промпта, генерацию и память.
   * opts: { numCtx, window, budget, promptTokens, probeChars, timeoutMs, fromBrowser }
   * Возвращает { ok, …метрики, lines: [готовые строки отчёта], advice: [...], error }.
   */
  async function probeLocalModel(s, model, opts) {
    const o = opts || {};
    const provider = (s && s.provider) || "openai";
    const name = String(model || (s && s.model) || "");
    const headers = apiHeaders(provider, apiKeyFor(provider, s), !!o.fromBrowser, projectHeader(s));
    const r = {
      ok: false, provider: provider, model: name, base: "",
      connectMs: 0, totalMs: 0,
      loadMs: 0, wasLoaded: false,
      prefillTokens: 0, prefillMs: 0, prefillPerSec: 0,
      genTokens: 0, genMs: 0, genPerSec: 0,
      weightsBytes: 0, vramBytes: 0, gpuShare: 0,
      window: Math.round(Number(o.window) || 0),
      numCtx: Math.round(Number(o.numCtx) || 0),
      kvBytes: 0, kvPerToken: 0,
      promptTokens: Math.round(Number(o.promptTokens) || 0),
      estimateSec: 0, tools: null, lines: [], advice: [], error: "",
    };
    const timeoutMs = Math.max(5000, Number(o.timeoutMs) || 300000);
    try {
      if (!name) throw new Error("не выбрана модель — укажи её в настройках или нажми ↻ рядом со списком");
      if (provider === "ollama") await _probeOllama(s, name, r, headers, o, timeoutMs);
      else await _probeCompatible(s, name, r, headers, o, timeoutMs);
      if (r.promptTokens > 0 && r.prefillPerSec > 0) r.estimateSec = Math.round(r.promptTokens / r.prefillPerSec);
      r.lines = probeLines(r);
      r.advice = probeAdvice(r);
      r.ok = true;
    } catch (e) {
      r.error = (e && e.message) || String(e);
      r.lines = ["❌ Локальная модель не измерена: " + r.error];
    }
    return r;
  }

  return {
    partsText,
    partsImages,
    contentForProvider,
    messagesForProvider,
    systemText,
    toolsForProvider,
    toolsAsText,
    withTextTools,
    cacheableProvider,
    splitStaticSystem,
    anthropicSystem,
    withCacheOnFirstSystem,
    mergeLeadingSystem,
    buildChatRequest,
    normalizeUsage,
    consumeProviderStream,
    listModels,
    ollamaModelInfo,
    ollamaNumCtx,
    modelWindow,
    probeLocalModel,
    OLLAMA_KEEP_ALIVE,
  };
});

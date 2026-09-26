"use strict";

/* Контекст диалога: сколько токенов занимает история, что влезает в окно модели и
   что делать, когда контекст переполнен — обрезать или сжать старые витки в памятку
   дешёвым вызовом модели.

   Вынесено из agent-core.js. Модуль получает подключение к провайдеру (кому и как
   отправить запрос за памяткой) и транспорт (разбор частей сообщения), а настройки
   видит только те, что ему передали аргументом. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ContextWindow = factory;
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  const { config, transport } = deps || {};
  const { baseFor, proxiedBase, apiKeyFor, apiHeaders, projectHeader } = config || {};
  const { partsText } = transport || {};

  // ── Контекст-окно: грубая оценка токенов и обрезка истории ──
  // Русский текст ~ 3–4 символа на токен, код/англ ~ 4; берём 3.6 с запасом.
  function estimateTokens(text) {
    if (Array.isArray(text)) {
      let n = 0;
      for (const p of text) {
        if (!p) continue;
        if (p.type === "text") n += Math.ceil(String(p.text || "").length / 3.6);
        else if (p.type === "image_url") n += 800; // изображение ~ 800 токенов
        else n += 120;
      }
      return Math.ceil(n);
    }
    const s = String(text || "");
    if (!s) return 0;
    return Math.ceil(s.length / 3.6);
  }

  function estimateMessageTokens(m) {
    if (!m) return 0;
    let n = estimateTokens(m.content);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        n += estimateTokens((tc.function && tc.function.name) || "");
        n += estimateTokens((tc.function && tc.function.arguments) || "");
      }
    }
    return n;
  }

  // Потолок контекста у облака: сколько токенов не жалко отдать истории, когда
  // окно модели неизвестно. 400 000 — столько же, сколько у Freebuff, и прежние
  // 50 000 были не «сколько влезает», а осторожной экономией: облако платное за
  // токен, поэтому потолок ставили вручную. Настоящий предел даёт окно самой
  // модели (windowBudget ниже), а переполнение ловит повтор раунда с меньшим
  // бюджетом, так что высокий потолок ничего не ломает.
  const CLOUD_CTX_BUDGET = 400000;
  // Бюджет контекста (токенов) для истории, без учёта system и результата текущего запроса.
  // Локальные модели (qwen3:4b и др.) имеют 8–32k — даём запас на вывод и tool-результаты.
  function contextBudget(provider, model) {
    // Ollama: реальное окно узнаётся у сервера (/api/show → modelWindow), а в запрос
    // уходит нужный num_ctx. Здесь — только потолок на случай, когда сервер молчит:
    // прежние 14 000 не были ошибкой как потолок, но без реального окна и без num_ctx
    // агент получал дефолтные 2048 токенов контекста и обрезание на середине задачи.
    if (provider === "ollama") return LOCAL_CTX_FALLBACK;
    // Локальный сервер совместимого API с НЕИЗВЕСТНЫМ окном сюда намеренно не заведён:
    // снижать бюджет «на всякий случай» — значит молча отнимать историю у g4f и подобных
    // местных прокси к большим моделям. Окно спрашивается у самого сервера
    // (modelWindow: /models, LM Studio /api/v0/models, llama.cpp /props), а переполнение
    // ловит существующий повтор того же раунда с меньшим бюджетом.
    // Антроповское окно — 200k, и потолок держим ниже него: бюджет БОЛЬШЕ окна
    // гарантировал бы отказ на каждом запросе (окно модели здесь неизвестно:
    // modelWindow для anthropic не спрашивается).
    if (provider === "anthropic") return 180000;
    return CLOUD_CTX_BUDGET;
  }

  // ── Сколько контекста выделять, когда окно модели ИЗВЕСТНО ──
  // У облака бюджет — «сколько не жалко токенов»: он и остаётся потолком.
  // У локальной модели токены бесплатны, платим памятью (KV-кэш) и временем,
  // поэтому потолок другой, а настоящий предел даёт окно модели.
  // Прежние жёсткие 14 000 были наследием облачной экономии: у модели с окном 40k
  // история сжималась втрое раньше, чем кончалось место.
  const LOCAL_CTX_FALLBACK = 14000; // окно неизвестно (сервер молчит) — безопасный дефолт
  // Потолок бюджета у локальной модели. Раньше здесь стояло 32 768 («KV-кэш 8B-модели
  // ~4 ГБ: выше — уже не ноутбук») — и это срезало окно у моделей с большим контекстом:
  // у модели с окном 128k история сжималась вчетверо раньше, чем кончалось место.
  // Теперь потолок тот же, что у облака (400 000), а настоящий предел даёт ОКНО
  // самой модели — оно вычитается ниже, и `num_ctx` уходит в Ollama равным бюджету.
  // Память (KV-кэш) — решение человека: модель с окном 128k так и просит больше.
  const LOCAL_CTX_CAP = CLOUD_CTX_BUDGET;
  const OUTPUT_RESERVE = 4096; // запас на ответ модели и результаты инструментов
  function windowBudget(provider, cloudBudget, window, opts) {
    const win = Math.round(Number(window) || 0);
    const cloud = Math.round(Number(cloudBudget) || 0);
    if (win <= 0) return cloud; // окно неизвестно — поведение прежнее
    // Потолок локального сервера — память (KV-кэш), а не наш облачный бюджет:
    // у LM Studio и vLLM на localhost токены так же бесплатны, как у Ollama.
    const local = !!((opts && opts.local) || provider === "ollama");
    const cap = local ? LOCAL_CTX_CAP : cloud;
    const fit = Math.min(win - OUTPUT_RESERVE, cap);
    // Окно меньше резерва (модель на 2k): отдаём всё окно, не больше и не меньше.
    return fit > 0 ? fit : Math.min(cloud, win);
  }

  // Обрезает массив канонических сообщений так, чтобы их суммарная оценка токенов
  // не превышала budget, сохраняя самые свежие сообщения (диалог идёт от старых к новым).
  // Гарантирует: никогда не выкидываем последнее user-сообщение и не разрываем
  // tool-цепочки в хвосте (assistant tool_calls + его результаты остаются целиком).
  // Убирает «осиротевшие» tool-сообщения: role:"tool" допустим только сразу после
  // assistant с tool_calls. После обрезки контекста хвост может начинаться с tool
  // (или содержать tool без своего assistant) — такие сообщения ломают
  // OpenAI-совместимые API (400 wrong_api_format «tool must be a response to tool_calls»).
  function sanitizeToolPairs(messages) {
    const out = [];
    let expectTool = false;
    for (const m of messages) {
      if (m && m.role === "tool") {
        if (!expectTool) continue; // сирота — выбрасываем
        out.push(m);
        continue;
      }
      expectTool = false;
      if (m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        expectTool = true;
      }
      out.push(m);
    }
    return out;
  }

  function trimConversation(messages, budget) {
    if (!Array.isArray(messages) || !messages.length) return messages || [];
    const limit = Math.max(1500, budget || contextBudget("openai"));
    // Считаем С КОНЦА: свежие сообщения важнее начала, а старое при переполнении
    // сворачивается в памятку (compactRemote вызывается раньше и видит голову целиком).
    // Прежний проход «с начала» тратил бюджет именно на СТАРЫЕ сообщения, а на длинном
    // чате срез схлопывался до одного последнего сообщения — агент терял задачу.
    let total = 0;
    let start = messages.length - 1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const w = estimateMessageTokens(messages[i]);
      // Последнее сообщение оставляем всегда, даже если оно одно больше бюджета.
      if (i < messages.length - 1 && total + w > limit) break;
      total += w;
      start = i;
    }
    // Текущий виток не рвём: последнее user-сообщение и всё после него остаются целиком.
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser >= 0 && start > lastUser) start = lastUser;
    let kept = messages.slice(start);
    // Не оставляем «висящий» assistant/tool в начале среза без его вопроса
    // Ведущие system-заметки (перенос задачи, восстановление после сбоя) сохраняем:
    // провайдеры принимают их в начале и склеивают в одну шапку.
    while (kept.length > 1 && kept[0] && kept[0].role !== "user" && kept[0].role !== "system") kept = kept.slice(1);
    // Санитайзер пар assistant(tool_calls)→tool: выкидывает осиротевшие tool-сообщения
    // (в т.ч. одиночный tool, оставшийся после среза цепочки инструментов).
    kept = sanitizeToolPairs(kept);
    if (!kept.length) {
      kept = sanitizeToolPairs(messages.slice(-2));
    }
    if (!kept.length && lastUser >= 0) kept = [messages[lastUser]];
    return kept;
  }

  function truncateText(text, max) {
    const s = String(text || "");
    const cap = max || 6000;
    if (s.length <= cap) return s;
    return s.slice(0, cap) + "\n… (обрезано: " + s.length + " символов)";
  }

  // ── Компакция: старые витки диалога сжимаются в памятку дешёвым вызовом модели ──
  async function compactRemote(s, messages, opts) {
    // opts — { numCtx, keepAlive, timeoutMs, onFail }: локальной модели нужен свой
    // num_ctx (иначе Ollama берёт дефолт 2048 и собирает памятку из обрезанного
    // текста), а о провале надо сказать вслух, а не молчать.
    const o = opts || {};
    const fail = (why) => {
      if (typeof o.onFail === "function") {
        try { o.onFail(why); } catch (e) {}
      }
    };
    try {
      const provider = s && s.provider ? s.provider : "openai";
      const model = (s && s.model) || "";
      if (!model) return null;
      // Границу свёрнутого считает manage и называет её явно (headEnd). Причина:
      // «последней просьбы человека» в истории может и не быть — в прогоне одной задачи
      // она стоит первой, а дальше идут только шаги агента, и прежняя проверка
      // `lastUser <= 0` отказывалась сжимать ровно там, где шагов набираются сотни.
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") {
          lastUser = i;
          break;
        }
      }
      const headEnd = Math.round(Number(o.headEnd) || 0) || lastUser;
      if (headEnd <= 0) return null; // и правда нечего: вся история — один виток без шагов
      const head = messages.slice(0, headEnd);
      let headTokens = 0;
      for (const m of head) headTokens += estimateMessageTokens(m);
      if (headTokens < 4000) return null; // голова маленькая — обычная обрезка дешевле вызова
      const parts = [];
      for (const m of head) {
        const role = m && m.role;
        const label = role === "user" ? "Пользователь" : role === "assistant" ? "Агент" : role === "system" ? "Система" : "Инструмент";
        const c = m && m.content;
        let txt = "";
        if (typeof c === "string") txt = c;
        else if (Array.isArray(c)) txt = partsText(c) || "[изображение]";
        if (String(txt || "").trim()) parts.push(label + ": " + truncateText(txt, 1200));
      }
      const body = parts.join("\n\n").slice(0, 30000);
      if (!body.trim()) return null;
      const sys =
        "Ты — менеджер памяти ИИ-агента-разработчика. Сожми переписку в краткую памятку на русском (до 700 слов): что просил пользователь, что уже сделано (файлы, команды, git), текущее состояние проекта, что осталось сделать. Памятка должна позволить агенту продолжить работу без исходных сообщений. Пиши только саму памятку, без пояснений.";
      // Сжать «до 700 слов» на CPU — это минуты: 30 с рвали запрос на середине, и
      // сжатие всегда «не срабатывало». Облаку хватает 30 с, локальной модели — нет,
      // причём «локальная» — это любой местный сервер, а не только Ollama.
      const slowLocal = !!(o.local || provider === "ollama");
      const timeoutMs = Math.round(Number(o.timeoutMs) || (slowLocal ? 300000 : 30000));
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      const headers = apiHeaders(provider, apiKeyFor(provider, s), false, projectHeader(s));
      if (provider === "anthropic") {
        const res = await fetch(baseFor(provider, s) + "/v1/messages", {
          method: "POST",
          headers,
          signal: timeout,
          body: JSON.stringify({ model, max_tokens: 900, system: sys, messages: [{ role: "user", content: body }], stream: false }),
        });
        if (!res.ok) return null;
        const d = await res.json();
        return (d.content || []).filter((b) => b && b.type === "text").map((b) => b.text || "").join("\n") || null;
      }
      if (provider === "ollama") {
        const localChat = {
          model: model,
          messages: [{ role: "system", content: sys }, { role: "user", content: body }],
          stream: false,
          // keep_alive обязателен и здесь: без него локальная сессия получает дефолтные
          // 5 минут и выгружает модель ровно тогда, когда она нужна для работы.
          keep_alive: o.keepAlive || "5m",
        };
        const numCtx = Math.round(Number(o.numCtx) || 0);
        if (numCtx > 0) localChat.options = { num_ctx: numCtx };
        const res = await fetch(baseFor(provider, s) + "/api/chat", {
          method: "POST",
          headers: headers,
          signal: timeout,
          body: JSON.stringify(localChat),
        });
        if (!res.ok) throw new Error("Ollama error " + res.status + ": " + (await res.text()).slice(0, 200));
        const d = await res.json();
        return (d.message && d.message.content) || null;
      }
      const res = await fetch(proxiedBase(baseFor(provider, s)) + "/chat/completions", {
        method: "POST",
        headers,
        signal: timeout,
        body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: body }], max_tokens: 900, stream: false }),
      });
      if (!res.ok) return null;
      const d = await res.json();
      return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || null;
    } catch (e) {
      // Раньше ошибка глоталась здесь: сжатие молча «не срабатывало», вместо памятки
      // шла обрезка головы вместе с целью задачи, и агент выглядел забывчивым.
      fail(e && e.name === "AbortError" ? "не успело за отведённое время" : (e && e.message) || String(e));
      return null;
    }
  }

  // Фабрика менеджера контекста: компакция (до 3 раз за запуск, памятки накапливаются)
  // + обрезка хвоста.
  function createContextManager(opts) {
    const settings = (opts && opts.settings) || {};
    const emit = (opts && opts.emit) || (() => {});
    const planMode = !!(opts && opts.planMode);
    // onMemo — необязательный хук: получает текст только что созданной памятки и
    // сообщения, из которых она свёрнута. main.js пишет по нему локальный дневник
    // (память диалогов по датам). Ошибка хука не должна ломать работу агента.
    const onMemo = (opts && opts.onMemo) || null;
    // Сжатий за прогон может быть несколько: на длинной задаче (браузер, обход
    // страниц, большой рефакторинг) контекст переполняется повторно, а одиночной
    // памятки не хватало — дальше шла молчаливая обрезка головы, вместе с целью
    // задачи, и агент бросал работу («напишет что-то и отключается»).
    let compactCount = 0;
    const COMPACT_LIMIT = 3;
    let compactMemo = null;
    // Свёрнут ли кусок в ЭТОМ вызове и с какого места история остаётся как есть.
    let compactedNow = false;
    let keepFrom = 0;
    let keepGoal = false; // историю одной задачи начинаем с её же просьбы дословно
    // num_ctx для запроса за памяткой: тот же, что у основного запроса, иначе Ollama
    // собирает памятку с дефолтным окном 2048 и ещё и перезагружает модель.
    const localCtx = Math.round(Number(opts && opts.localCtx) || 0);
    // Локальный сервер (по адресу) — тому же флагу доверяем и таймаут сжатия.
    const localServer = !!(opts && opts.local);
    let compactFailed = false;
    return {
      async manage(messages, budget) {
        if (!Array.isArray(messages) || !messages.length) return messages || [];
        const memoWeight = compactMemo ? estimateTokens(compactMemo.content) : 0;
        let total = 0;
        for (const m of messages) total += estimateMessageTokens(m);
        // Страховка: даже если обрезка не нужна, убираем осиротевшие tool-сообщения
        // (role:"tool" без предшествующего assistant с tool_calls ломает API — 400 wrong_api_format).
        if (total + memoWeight <= budget) {
          return compactMemo ? [compactMemo, ...sanitizeToolPairs(messages)] : sanitizeToolPairs(messages);
        }
        if (compactCount < COMPACT_LIMIT && !planMode) {
          // Граница свёрнутого: последняя просьба человека и всё после неё остаются как
          // есть — по ним прогон и продолжает работу. Если просьба одна (история началась
          // с неё, а дальше одни шаги), границы нет: сворачиваем середину витка, оставляя
          // свежий хвост шагов. Иначе сжимать было бы нечего, и вся история ехала в запрос.
          const KEEP_TAIL = 8;
          let boundary = 0;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i] && messages[i].role === "user") { boundary = i; break; }
          }
          const boundaryIsUser = boundary > 0;
          if (!boundaryIsUser) boundary = Math.max(1, messages.length - KEEP_TAIL);
          try {
            // Предыдущую памятку скармливаем вместе с новыми сообщениями: иначе
            // повторное сжатие потеряло бы всё, что уже было свёрнуто в неё.
            const memoText = await compactRemote(
              settings,
              compactMemo ? [compactMemo, ...messages] : messages,
              {
                numCtx: localCtx,
                local: localServer,
                headEnd: boundary,
                onFail: (why) => {
                  if (compactFailed) return; // говорим один раз за прогон, а не каждый виток
                  compactFailed = true;
                  if (emit) {
                    emit({
                      type: "notice",
                      text: "⚠ Сжать старые шаги не удалось (" + why + "): обрезаю историю и продолжаю. Контекст сохранён не будет.",
                    });
                  }
                },
              }
            );
            if (memoText && String(memoText).trim()) {
              compactMemo = {
                role: "system",
                content:
                  "ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА (сжато, чтобы экономить токены; это резюме старых шагов):\n" +
                  String(memoText).trim(),
              };
              compactCount++;
              compactedNow = true;
              keepFrom = boundary; // ровно та граница, по которой собрана памятка
              keepGoal = !boundaryIsUser; // сворачивали середину витка — просьбу оставляем
              if (onMemo) {
                try {
                  onMemo({
                    text: String(memoText).trim(),
                    messages,
                    provider: settings.provider || "",
                    model: settings.model || "",
                    ts: Date.now(),
                  });
                } catch {}
              }
            }
          } catch {}
        }
        // Памятка ЗАМЕНЯЕТ свёрнутый кусок, а не дописывается к нему. Раньше история
        // оставалась целиком (она влезала в бюджет — зачем же её резать), и событие
        // «контекст сжат» обещало экономию, которой не было: замер на длинном чате дал
        // 112 911 токенов до сжатия и 112 911 после — памятка просто ехала доплаткой.
        // Отдельная беда — история одной задачи: она начинается с просьбы человека, дальше
        // одни шаги агента, и правило trimConversation «последнее user-сообщение оставляем
        // целиком» сохраняло её ВСЮ — памятка ехала доплаткой, и «сжатие» не сжимало ничего.
        // Поэтому границу называет тот, кто собирает памятку (последняя просьба человека, а
        // если её нет — середина витка с запасом KEEP_TAIL шагов), и хвост режется ровно по ней.
        let tail = messages;
        if (compactedNow) {
          tail = messages.slice(Math.min(keepFrom, messages.length));
          // Отвечать нечем, если не оставить ни одного шага.
          if (!tail.length) tail = messages.slice(-1);
          // В истории одной задачи просьба человека одна и стоит в начале: под памяткой
          // она свёрнута вместе со всем остальным, но терять дословную цель незачем —
          // оставляем её перед хвостом. Так задача не «растворяется» в пересказе.
          if (keepGoal && messages[0] && messages[0].role === "user") tail = [messages[0], ...tail];
        }
        const nowMemoWeight = compactMemo ? estimateTokens(compactMemo.content) : 0;
        const rest = trimConversation(tail, Math.max(1500, budget - nowMemoWeight - 400));
        const out = compactMemo ? [compactMemo, ...rest] : rest;
        if (compactedNow && emit) {
          let afterTokens = 0;
          for (const m of out) afterTokens += estimateMessageTokens(m);
          emit({
            type: "compact",
            text:
              "🧠 Контекст сжат: " + (messages.length - tail.length) + " сообщений свернуты в памятку (≈" +
              Math.round(total / 1000) + "k → ≈" + Math.round(afterTokens / 1000) + "k токенов).",
          });
        }
        return out;
      },
      memo() {
        return compactMemo;
      },
      // Сколько сжатий сделано за прогон: панель «Миссия» показывает это как
      // признак того, что работа действительно долгая.
      compactions() {
        return compactCount;
      },
    };
  }

  return {
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    CLOUD_CTX_BUDGET,
    windowBudget,
    sanitizeToolPairs,
    trimConversation,
    truncateText,
    compactRemote,
    createContextManager,
  };
});

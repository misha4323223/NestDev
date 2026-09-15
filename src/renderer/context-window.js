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

  // Бюджет контекста (токенов) для истории, без учёта system и результата текущего запроса.
  // Локальные модели (qwen3:4b и др.) имеют 8–32k — даём запас на вывод и tool-результаты.
  function contextBudget(provider, model) {
    // Ollama: реальное окно узнаётся у сервера (/api/show → modelWindow), а в запрос
    // уходит нужный num_ctx. Здесь — только потолок на случай, когда сервер молчит:
    // прежние 14 000 не были ошибкой как потолок, но без реального окна и без num_ctx
    // агент получал дефолтные 2048 токенов контекста и обрезание на середине задачи.
    if (provider === "ollama") return 14000;
    const m = String(model || "");
    if (/deepseek|qwen/i.test(m)) return 26000;
    if (provider === "anthropic") return 80000;
    return 50000;
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
  async function compactRemote(s, messages) {
    try {
      const provider = s && s.provider ? s.provider : "openai";
      const model = (s && s.model) || "";
      if (!model) return null;
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === "user") {
          lastUser = i;
          break;
        }
      }
      if (lastUser <= 0) return null; // нечего сжимать — только текущий виток
      const head = messages.slice(0, lastUser);
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
      const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined;
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
        const res = await fetch(baseFor(provider, s) + "/api/chat", {
          method: "POST",
          headers,
          signal: timeout,
          body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: body }], stream: false }),
        });
        if (!res.ok) return null;
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
    } catch {
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
          try {
            // Предыдущую памятку скармливаем вместе с новыми сообщениями: иначе
            // повторное сжатие потеряло бы всё, что уже было свёрнуто в неё.
            const memoText = await compactRemote(
              settings,
              compactMemo ? [compactMemo, ...messages] : messages
            );
            if (memoText && String(memoText).trim()) {
              compactMemo = {
                role: "system",
                content:
                  "ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА (сжато, чтобы экономить токены; это резюме старых шагов):\n" +
                  String(memoText).trim(),
              };
              compactCount++;
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
              if (emit) emit({ type: "compact", text: "🧠 Контекст сжат: старые шаги свернуты в памятку — токены экономятся." });
            }
          } catch {}
        }
        const rest = trimConversation(messages, Math.max(1500, budget - memoWeight - 400));
        return compactMemo ? [compactMemo, ...rest] : rest;
      },
      memo() {
        return compactMemo;
      },
    };
  }

  return {
    estimateTokens,
    estimateMessageTokens,
    contextBudget,
    sanitizeToolPairs,
    trimConversation,
    truncateText,
    compactRemote,
    createContextManager,
  };
});

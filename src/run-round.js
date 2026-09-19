"use strict";

/* ─── Один раунд общения с провайдером: запрос, поток ответа, метрики ─────────
   Вынесено из main.js (этап B, часть 17 — четвёртый заход в ядро чата runAi).

   Здесь собирается запрос и читается поток ответа — то, что ошибается тихо и
   дорого:

     • состав схем и справочники собираются в момент запроса: если схемы взять
       «как было» или справочник поставить не сразу за системным промптом,
       ломается кэш префикса и каждый раунд дороже (провайдер отвечает 503
       cache_only_cold);
     • бюджет контекста и окно модели берутся ЖИВЫМИ значениями: после
       переполнения контекста бюджет другой, и застывшая копия резала бы историю
       по старому числу;
     • текст ответа чистится от рассуждений и уходит в чат по мере прихода —
       на этом держится и показ, и «мягкая остановка» (иначе человек видит
       пустой ответ);
     • usage провайдеры шлют частями (Anthropic: вход в message_start, выход в
       message_delta) — по каждому полю берём максимум, иначе панель миссии
       показывает расход меньше настоящего.

   Живые значения приходят мостами: бюджет и окно модели — функциями (ужимаются
   в прогоне), история — аргументом раунда, роутер схем, восстановление после
   отказа, миссия и прерывание — своими объектами. Хозяином цикла остаётся
   прогон: модуль лишь докладывает, что раунд нужно повторить. */

function createRunRound(deps) {
  const {
    settings,
    provider,
    emit,
    termEmit,
    emitThink,
    // Живые значения прогона: ужатие контекста уменьшает бюджет и меняет окно
    // модели, поэтому внутрь идут функции, а не копии.
    getBudget,
    getModelWindow,
    getCompactions,
    noTools,
    localEndpoint,
    // Объекты прогона с общим состоянием: схемы и справочники, восстановление
    // после отказа, миссия долгой работы, прерывание прогона.
    tools,
    retry,
    mission,
    abort,
    // Функции ядра — именами, как их зовёт прогон.
    SYSTEM_PROMPT,
    buildChatRequest,
    consumeProviderStream,
    createThinkingStripper,
    readApiError,
    estimateTokens,
  } = deps;

  // Сообщения запроса: справочники по сайтам стоят сразу после системного промпта —
  // они часть статичного префикса, и точка кэша остаётся на месте.
  const requestMessages = (history) => {
    const notes = tools.state.guideNotes;
    return notes.length ? [history[0], ...notes, ...history.slice(1)] : history;
  };

  // Один раунд: запрос → поток ответа → цифры. Возвращает:
  //   { kind: "repeat" }                       — раунд повторяется тем же контекстом;
  //   { kind: "error", error }                 — фатальная ошибка с понятным текстом;
  //   { kind: "ok", text, toolCalls, truncated }.
  const run = async (round) => {
    const startedAt = Date.now();
    let ttfbMs = 0;
    let collected = "";
    let truncated = false;
    let usage = null;
    const toolCalls = [];
    const stripper = createThinkingStripper({ onHidden: emitThink });

    const req = buildChatRequest(settings, {
      model: settings.model,
      messages: requestMessages(round.messages),
      tools: tools.state.active,
      // Статичный префикс промпта: до этой границы ставится точка кэша, чтобы
      // динамический «паспорт проекта» не обнулял кэш на каждом витке.
      staticSystem: SYSTEM_PROMPT,
      includeUsage: retry.state.includeUsage,
      // Ollama: сколько контекста выделить (num_ctx) — считает agent-core из бюджета
      // и реального окна модели, чтобы сервер не резал запрос молча.
      numCtxBudget: getBudget(),
      modelWindow: getModelWindow(),
      // Модель без инструментов: схемы не отправляем, вместо них текстовый каталог.
      noTools: noTools,
    });
    // Темп провайдера: пауза выдерживается ЗАРАНЕЕ, если лимит уже известен (429 —
    // потерянный раунд). Решение и текст — в src/run-retry.js.
    await retry.pace();
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: abort.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Сетевая ошибка при запросе к " + provider + ": " + e.message);
    }
    ttfbMs = Date.now() - startedAt; // заголовки ответа = первый байт
    if (res.ok) retry.noteSuccess();
    if (!res.ok) {
      const detail = await readApiError(res);
      // Повтор с паузой, отключение метрик, ужатие контекста или честная ошибка —
      // решает src/run-retry.js. Ожидание оно делает само, а раунд повторяет прогон:
      // продолжение цикла — решение прогона, а не модуля.
      const verdict = await retry.plan({ status: res.status, headers: res.headers, detail: detail });
      if (verdict.kind === "repeat") return { kind: "repeat" };
      return { kind: "error", error: verdict.error };
    }

    await consumeProviderStream({
      response: res,
      provider,
      // Локальный сервер (в т.ч. LM Studio/vLLM на localhost) — свои таймауты:
      // загрузка и чтение промпта на CPU не укладываются в облачные 90 с.
      local: localEndpoint,
      onText: (text) => {
        const vis = stripper.push(text);
        if (vis) {
          collected += vis;
          emit({ type: "chunk", text: vis });
        }
      },
      onToolCall: (tc) => toolCalls.push(tc),
      onThinking: emitThink,
      // Локальная модель, упёршаяся в лимит вывода, обрывает ответ на полуслове.
      // Раньше это выглядело как законченный ответ — теперь помечаем.
      onTruncated: () => {
        truncated = true;
      },
      onUsage: (u) => {
        if (!u) return;
        usage = usage || { prompt: 0, completion: 0, cached: 0 };
        // Провайдеры шлют usage частями (Anthropic: вход в message_start, выход в
        // message_delta) — по каждому полю берём максимум.
        usage.prompt = Math.max(usage.prompt, u.prompt || 0);
        usage.completion = Math.max(usage.completion, u.completion || 0);
        usage.cached = Math.max(usage.cached, u.cached || 0);
      },
    });

    if (truncated) {
      emit({
        type: "notice",
        text: "⚠ Ответ модели оборван лимитом вывода (done_reason «length»). Напиши «продолжай», если нужен остаток.",
      });
    }

    // Метрики раунда в «Консоль» (вкладка «Консоль» правой панели): без цифр
    // любая оптимизация контекста — гадание.
    {
      const estPrompt = tools.state.weight + estimateTokens(JSON.stringify(round.messages));
      const totalMs = Date.now() - startedAt;
      const tokens =
        usage && usage.prompt
          ? usage.prompt + "→" + usage.completion
          : "≈" + estPrompt + " (провайдер не прислал)";
      const cache =
        usage && usage.prompt
          ? usage.cached + " (" + Math.round((usage.cached / usage.prompt) * 100) + "%)"
          : "нет данных";
      termEmit({
        type: "metrics",
        text:
          "раунд " + (round.n + 1) + "/" + round.maxRounds +
          " · схем " + tools.state.active.length + " (~" + tools.state.weight + " т.)" +
          (tools.state.route && tools.state.route.groups.length ? " · групп " + tools.state.route.groups.length : "") +
          (tools.state.route && tools.state.route.dropped.length ? " · срезано: " + tools.state.route.dropped.join(",") : "") +
          " · токены " + tokens +
          " · кэш " + cache +
          " · TTFB " + (ttfbMs / 1000).toFixed(1) + " с" +
          " · всего " + (totalMs / 1000).toFixed(1) + " с",
      });
      // Цена работы в миссии: панель показывает токены и сжатия, чтобы «работает
      // часами» не превращалось в невидимый расход.
      mission.cost(usage, getCompactions());
    }

    const tail = stripper.finish();
    if (tail) {
      collected += tail;
      emit({ type: "chunk", text: tail });
    }

    return { kind: "ok", text: collected, toolCalls: toolCalls, truncated: truncated };
  };

  return { run: run };
}

module.exports = { createRunRound };

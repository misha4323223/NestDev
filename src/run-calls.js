"use strict";

/* ─── Вызовы раунда: текстовые, нормализация, запись в историю, пачка ─────────
   Вынесено из main.js (этап B, часть 18 — пятый заход в ядро чата runAi).

   Здесь ответ модели превращается в вызовы инструментов, которые пойдут в работу.
   Ошибки на этом шаге тихие и дорогие:

     • **текстовый вызов не нашли** — модель напечатала JSON-вызов в тексте, а
       приложение отправило её в призыв «план не закрыт»; вызов потерян, работа
       встала (поэтому разбор текста идёт ДО призывов и «пустого отчёта»);
     • **дубль выполнился дважды** — одинаковый вызов в одном раунде создаёт файл
       или коммит дважды (в истории проекта это уже случалось);
     • **подпись мысли потеряна** — Gemini 3.x требует вернуть `extra_content`
       дословно, иначе СЛЕДУЮЩИЙ раунд падает с 400 (missing thought_signature);
     • **писатель попал в параллельную пачку** — read-only вызовы идут вместе
       (экономим раунд на каждом), но с писателем или вопросом к человеку порядок
       обязан быть строгим: иначе файлы пишутся вперемешку, а `askUser` ждёт ответа
       на фоне чужой работы.

   Живые значения — аргументами и объектами: история приходит массивом (модуль в
   неё пишет), список безопасных для параллели инструментов — множеством из
   main.js, выполнение инструмента и ужатие вывода — функциями. Решение «раунд
   закончен» (пустой ответ, дубли, остановка) остаётся у прогона. */

function createRunCalls(deps) {
  const {
    settings,
    emit,
    // Функции ядра и оболочки — именами, как их зовёт прогон.
    extractToolCallsFromText,
    genCallId,
    normalizeToolName,
    executeTool,
    truncateText,
    fmtError,
    // Множество read-only инструментов: собрано один раз в main.js.
    PARALLEL_SAFE_TOOLS,
  } = deps;

  // 1. Текстовые вызовы. Модель могла напечатать JSON-вызов инструмента в тексте,
  // а не отдать его через tool_calls. Найденные вызовы дописываются в переданный
  // список — дальше они идут общим путём. В режиме плана инструменты не выполняются
  // вовсе (план только составляется), поэтому текст там не разбираем.
  const fromText = (round) => {
    const toolCalls = round.toolCalls;
    if (toolCalls.length || round.planMode) return 0;
    const fallbackCalls = extractToolCallsFromText(round.text);
    if (!fallbackCalls.length) return 0;
    for (const fc of fallbackCalls) {
      toolCalls.push({ id: genCallId(), name: fc.name, args: fc.args });
    }
    // Убираем JSON-мусор из показанного пользователю текста
    let cleaned = round.text;
    for (const fc of fallbackCalls) {
      cleaned = cleaned.split(fc.raw).join("");
    }
    cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    if (cleaned) emit({ type: "text_override", text: cleaned });
    return fallbackCalls.length;
  };

  // 2. Нормализация имён, стабильные id (нужны для tool-сообщений) и дедупликация:
  // одинаковый вызов в одном раунде выполняется один раз.
  const normalize = (toolCalls) => {
    const seenCalls = new Set();
    const calls = [];
    for (const tc of toolCalls) {
      const norm = {
        id: tc.id || genCallId(),
        name: normalizeToolName(tc.name),
        args: tc.args && typeof tc.args === "object" ? tc.args : {},
        // Gemini 3.x: extra_content с thought signature нужно вернуть дословно,
        // иначе следующий раунд упадёт с 400 (missing thought_signature).
        ...(tc.extraContent ? { extraContent: tc.extraContent } : {}),
      };
      const sig = norm.name + "|" + JSON.stringify(norm.args);
      if (seenCalls.has(sig)) continue;
      seenCalls.add(sig);
      calls.push(norm);
    }
    return calls;
  };

  // 3. Запись вызовов в историю: assistant с tool_calls. Подпись мысли, если она
  // была, едет обратно к провайдеру вместе с вызовом.
  const recordAssistant = (history, text, calls) => {
    history.push({
      role: "assistant",
      content: text || null,
      tool_calls: calls.map((c) => {
        const call = {
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        };
        if (c.extraContent) call.extra_content = c.extraContent;
        return call;
      }),
    });
  };

  // 4. Батчинг: если раунд целиком состоит из независимых read-only вызовов —
  // выполняем их параллельно (экономит по раунду на каждый вызов). Любой
  // пишущий/интерактивный инструмент в раунде возвращает строгую очередь.
  const canRunParallel = (calls, planMode) =>
    !planMode && calls.length > 1 && calls.every((c) => PARALLEL_SAFE_TOOLS.has(c.name));

  const runParallel = async (calls, history) => {
    for (const c of calls) emit({ type: "tool_start", name: c.name, args: c.args });
    const results = await Promise.all(
      calls.map((c) =>
        executeTool(c.name, c.args, settings).catch((e) => "Ошибка инструмента " + c.name + ": " + fmtError(e))
      )
    );
    calls.forEach((c, i) => {
      const capped = truncateText(results[i], 8000);
      emit({ type: "tool_result", name: c.name, result: capped });
      history.push({ role: "tool", tool_call_id: c.id, content: capped });
    });
  };

  return {
    fromText: fromText,
    normalize: normalize,
    recordAssistant: recordAssistant,
    canRunParallel: canRunParallel,
    runParallel: runParallel,
  };
}

module.exports = { createRunCalls };

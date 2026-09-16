"use strict";

/* ─── Веб-режим: чат напрямую из браузера ─────────────────────────────────────
   Вынесено из app.js (этап 3 разбора гигантов). Когда приложение открыто в
   браузере (веб-превью, телефон), главного процесса Electron нет: этот модуль
   ведёт тот же цикл чата на общем транспорте AgentCore — те же правила, бюджеты
   контекста, схемы инструментов и лимиты, что и в Electron main.

   Инструменты, которым нужен главный процесс (файлы, git, браузер, облако,
   память проекта), здесь честно отвечают «доступно только в desktop-приложении»;
   работают чат, план, askUser, веб-поиск и паузы.

   Зависимости приходят одним объектом. Настройки — через getSettings(): объект
   перезаписывается при смене профиля, копия устарела бы. Обработчик событий
   (onEvent) нужен авто-переключению профилей: в app.js такого имени нет, и вызов
   падал с ReferenceError ровно в момент, когда ключ кончился, а переключиться
   надо было на запасной. Лимит ожидания 429 держится здесь же. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.WebChat = factory;
  }
})(typeof self !== "undefined" ? self : this, function (WebChatDeps) {
  const {
    AgentCore, getSettings, openaiProfilesArr, persistSettings, onEvent, openAskModal,
  } = WebChatDeps || {};
  // ─────────────── Веб-режим: чат напрямую из браузера ───────────────
  // Единый цикл на общем транспорте AgentCore (те же правила, что и в Electron main).
  // Инструменты (файлы/git) в браузере недоступны — только чат.
  let webAutoSwitches = 0; // счётчик авто-переключений за запуск (защита от бесконечного круга)
  const webProfileCooldown = new Map(); // profileId → timestamp: провинившийся ключ откладываем

  // Авто-переключение между сохранёнными OpenAI-подключениями при ошибке (браузерный путь).
  // Возвращает true, если переключились (вызывающий должен повторить раунд).
  function tryWebAutoSwitch(errText) {
    if (!getSettings().autoSwitchProfiles || getSettings().provider !== "openai") return false;
    // Меняем ключ только если ошибка про ключ/баланс/лимит (400, контент, сеть — не про ключ).
    const cls = (typeof AgentCore !== "undefined" && AgentCore.classifyKeyError)
      ? AgentCore.classifyKeyError(errText)
      : { key: true, cooldownMs: 60 * 1000 };
    if (!cls.key) return false;
    const profs = openaiProfilesArr().filter((p) => p && p.id && String(p.apiKey || "").trim());
    if (profs.length < 2) return false;
    if (webAutoSwitches >= profs.length) return false; // прошли полный круг — стоп
    const cur = getSettings().openaiActiveProfile;
    const idx = Math.max(0, profs.findIndex((p) => p.id === cur));
    const now = Date.now();
    webProfileCooldown.set(cur, now + cls.cooldownMs); // провинившийся ключ отлеживается
    for (let step = 1; step <= profs.length; step++) {
      const next = profs[(idx + step) % profs.length];
      if (!next || next.id === cur) continue;
      if ((webProfileCooldown.get(next.id) || 0) > now) continue; // ещё в кулдауне
      webAutoSwitches++;
      getSettings().openaiActiveProfile = next.id;
      getSettings().openaiUrl = next.url || getSettings().openaiUrl;
      getSettings().openaiApiKey = next.apiKey || "";
      if (next.model) getSettings().openaiModel = next.model;
      if (next.project !== undefined) getSettings().openaiProject = next.project || "";
      persistSettings();
      onEvent({ type: "profile_switched", name: next.name || next.id, id: next.id, error: String(errText || "").slice(0, 160) });
      return true;
    }
    return false; // все ключи в кулдауне — переключать некуда
  }

  async function webSend(messages, onEvent, signal, opts) {
    opts = opts || {};
    webAutoSwitches = 0; // сброс счётчика авто-переключений на каждый запуск
    const planMode = !!opts.plan;
    const provider = getSettings().provider || "openai";
    if (!getSettings().model) {
      onEvent({ type: "error", message: "Не выбрана модель. Открой Настройки." });
      return;
    }
    // Контекст-окно (в браузере те же бюджеты, что и в Electron)
    let budget = AgentCore.contextBudget(provider, getSettings().model);
    let contextRetried = false; // при переполнении контекста пробуем ещё раз с меньшим бюджетом
    try {
      messages = AgentCore.trimConversation(messages, budget);
    } catch {}
    let apiMessages = [
      {
        role: "system",
        content:
          AgentCore.SYSTEM_PROMPT +
          (getSettings().workingDir ? "\n\nРабочая директория: " + getSettings().workingDir : "") +
          (planMode
            ? "\n\nРЕЖИМ ПЛАНА: сейчас НЕ выполняй инструменты и НЕ изменяй файлы. Составь пошаговый план работ и перечисли файлы, которые затронешь. Жди команды пользователя."
            : ""),
      },
      ...messages,
    ];
    const maxRounds = planMode ? 3 : 10;
    let finalText = "";
    // Лимит провайдера (429) в веб-режиме: ждём сами до потолка, как в приложении.
    // Раньше здесь 429 сразу завершал прогон ошибкой и требовал «напиши продолжай».
    const RATE_WAIT_BUDGET_MS = 10 * 60 * 1000;
    let rateWaitedMs = 0;

    for (let round = 0; round < maxRounds; round++) {
      let collected = "";
      const toolCalls = [];
      const stripper = AgentCore.createThinkingStripper({ onHidden: (t) => onEvent({ type: "thinking", text: t }) });

      // Контекст-менеджмент: держим историю в рамках бюджета между раундами
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...AgentCore.trimConversation(apiMessages.slice(1), budget)];
      }
      // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
      // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...AgentCore.sanitizeToolPairs(apiMessages.slice(1))];
      }

      const req = AgentCore.buildChatRequest(getSettings(), {
        model: getSettings().model,
        messages: apiMessages,
        tools: planMode ? AgentCore.PLAN_MODE_TOOL_DEFINITIONS : AgentCore.TOOL_DEFINITIONS,
        fromBrowser: true,
      });
      let res;
      try {
        res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (tryWebAutoSwitch(e.message)) { round--; continue; }
        onEvent({ type: "error", message: "Сетевая ошибка: " + e.message });
        return;
      }
      if (!res.ok) {
        const detail = await AgentCore.readApiError(res);
        // Лимиты провайдера (Groq free ~7K токенов/мин): понятное объяснение вместо сырого JSON.
        const friendly = AgentCore.friendlyRateLimitError(res.status, detail, getSettings());
        if (friendly) {
          if (tryWebAutoSwitch(friendly)) { round--; continue; }
          onEvent({ type: "error", message: friendly });
          return;
        }
        // 429: ждём окно лимита и повторяем ТОТ ЖЕ раунд — без участия пользователя.
        if (res.status === 429) {
          const info = AgentCore.rateLimitInfo(res.status, res.headers, detail);
          const wantMs = Math.max(2000, Math.min(info.retryMs || 5000, 60000));
          const leftMs = RATE_WAIT_BUDGET_MS - rateWaitedMs;
          if (leftMs >= 1000) {
            const waitMs = Math.min(wantMs, leftMs);
            rateWaitedMs += waitMs;
            onEvent({
              type: "notice",
              text:
                "⏳ Лимит провайдера на запросы: жду " + Math.max(1, Math.round(waitMs / 1000)) + " с и повторю сам" +
                (info.rpm ? ", лимит ≈" + Math.round(info.rpm) + " запросов/мин" : "") +
                ". Писать ничего не нужно.",
            });
            await new Promise((r) => setTimeout(r, waitMs));
            round--;
            continue;
          }
        }
        // Переполнение контекста: один раз повторяем с резко урезанной историей
        if (!contextRetried && /context|too long|maximum|num_ctx|token/i.test(detail) && budget > 3000) {
          contextRetried = true;
          budget = Math.max(3000, Math.floor(budget * 0.4));
          if (apiMessages.length > 1) {
            apiMessages = [apiMessages[0], ...AgentCore.trimConversation(apiMessages.slice(1), budget)];
          }
          round--;
          continue;
        }
        if (res.status === 402) {
          if (tryWebAutoSwitch("API error 402: недостаточно средств")) { round--; continue; }
          onEvent({
            type: "error",
            message: "API error 402: Недостаточно средств на балансе провайдера. Пополни счёт (platform.deepseek.com → Top up) или выбери другого провайдера/модель в настройках.",
          });
          return;
        }
        if (tryWebAutoSwitch("API error " + res.status + ": " + detail)) { round--; continue; }
        onEvent({ type: "error", message: "API error " + res.status + ": " + detail });
        return;
      }

      await AgentCore.consumeProviderStream({
        response: res,
        provider,
        onText: (text) => {
          const vis = stripper.push(text);
          if (vis) {
            collected += vis;
            onEvent({ type: "chunk", text: vis });
          }
        },
        onToolCall: (tc) => toolCalls.push(tc),
        onThinking: (t) => onEvent({ type: "thinking", text: t }),
      });

      const tail = stripper.finish();
      if (tail) {
        collected += tail;
        onEvent({ type: "chunk", text: tail });
      }
      finalText = collected;

      // Запасной способ вызова инструментов (модель напечатала JSON текстом).
      // В режиме плана инструменты не выполняются — план только составляется.
      if (toolCalls.length === 0 && !planMode) {
        const fallbackCalls = AgentCore.extractToolCallsFromText(finalText);
        for (const fc of fallbackCalls) {
          toolCalls.push({ id: AgentCore.genCallId(), name: fc.name, args: fc.args });
        }
        if (fallbackCalls.length) {
          let cleaned = finalText;
          for (const fc of fallbackCalls) {
            cleaned = cleaned.split(fc.raw).join("");
          }
          cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
          if (cleaned) onEvent({ type: "text_override", text: cleaned });
        }
      }
      if (toolCalls.length === 0) {
        onEvent({ type: "done" });
        return;
      }

      // Нормализуем имена, назначаем стабильные id и убираем дубли одного раунда
      const seenCalls = new Set();
      const calls = [];
      for (const tc of toolCalls) {
        const norm = {
          id: tc.id || AgentCore.genCallId(),
          name: AgentCore.normalizeToolName(tc.name),
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
      // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
      if (!calls.length) {
        if (!String(finalText || "").trim()) finalText = "Готово.";
        onEvent({ type: "chunk", text: finalText });
        onEvent({ type: "done" });
        return;
      }
      apiMessages.push({
        role: "assistant",
        content: finalText || null,
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
      for (const c of calls) {
        onEvent({ type: "tool_start", name: c.name, args: c.args });
        let result;
        if (c.name === "askUser") {
          // В веб-режиме askUser тоже работает: спрашиваем через модалку
          const question = (c.args && c.args.question) || "Уточни, пожалуйста";
          result = await new Promise((resolve) => openAskModal(question, resolve));
          result = result && String(result).trim() ? String(result).trim() : "(пользователь не дал ответ)";
        } else if (c.name === "webSearch" || c.name === "webFetch") {
          // Веб-поиск и чтение страниц работают и в браузере: запрос идёт через
          // preview-сервер (/api/…), потому что DuckDuckGo и сайты блокируют CORS.
          const q = c.name === "webSearch"
            ? encodeURIComponent(((c.args && (c.args.query || c.args.q)) || "").trim())
            : encodeURIComponent(((c.args && c.args.url) || "").trim());
          const endpoint = c.name === "webSearch" ? "/api/search?q=" : "/api/fetch?url=";
          try {
            const r = await fetch(endpoint + q);
            result = r.ok ? await r.text() : "Ошибка " + c.name + ": HTTP " + r.status;
          } catch (e) {
            result = "Ошибка " + c.name + ": " + (e && e.message ? e.message : "сеть недоступна");
          }
        } else if (c.name === "waitUntil") {
          // Обычная пауза — работает и в браузере.
          const secs = Math.max(1, Math.min(parseInt((c.args && c.args.seconds) || "5", 10) || 5, 300));
          await new Promise((r) => setTimeout(r, secs * 1000));
          result = "OK — подождал " + secs + " с. Теперь перепроверь состояние (checkPort/checkUrl/backgroundOutput).";
        } else if (c.name === "todoWrite") {
          // План работ — чистая структура, работает и в веб-превью.
          const webTasks = AgentCore.normalizePlanTasks(c.args && (c.args.tasks != null ? c.args.tasks : c.args.items));
          if (!webTasks.length) {
            result = "Ошибка: план пуст — пришли непустой массив tasks (до 7 пунктов).";
          } else {
            onEvent({ type: "plan", tasks: webTasks, title: String((c.args && c.args.title) || "").slice(0, 80) });
            const wp = AgentCore.planSummary(webTasks);
            result = planMode
              ? "OK — план показан пользователю (" + wp.total + " пункт(ов)). Режим плана: инструменты не выполняются — жди команды «Выполнить»."
              : "OK — план показан пользователю: " + wp.done + " из " + wp.total + " готово" +
                (wp.failed ? ", сбоев: " + wp.failed : "") +
                ". Продолжай со следующего пункта и после каждого шага вызывай todoWrite заново с полным списком.";
          }
        } else if (c.name === "semanticSearch") {
          result =
            "⚠️ Семантический поиск (semanticSearch) доступен только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "otaStatus" || c.name === "otaCheck" || c.name === "otaRollback") {
          result =
            "⚠️ Инструменты самообновления (otaStatus/otaCheck/otaRollback) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "applyPatch" || c.name === "gitStash" || c.name === "gitCherryPick" || c.name === "gitBlame") {
          result =
            "⚠️ Инструменты applyPatch и gitStash/gitCherryPick/gitBlame доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "agentGuide") {
          // Справочники лежат рядом с кодом приложения — в браузере их не читать.
          result =
            "⚠️ Справочники по сайтам (agentGuide) доступны в desktop-приложении (bun run dist:win). В веб-версии ищи по DOM: browserSnapshot/browserScroll недоступны — работай через webFetch.";
        } else if (c.name === "waitForIdle") {
          // Обычная пауза — в браузере тоже работает (нечего ждать по DOM-мутациям).
          const secs = Math.max(1, Math.min(parseInt((c.args && (c.args.quietMs || c.args.timeout)) || "1500", 10) / 1000, 30));
          await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
          result = "OK — подождал " + secs.toFixed(1) + " с (в веб-версии ожидание покоя = пауза).";
        } else if (c.name && (c.name.startsWith("browser") || c.name.startsWith("app"))) {
          // Браузерные (Playwright) и app-инструменты (управление собственным окном)
          // работают только в desktop-приложении (main-процесс Electron).
          result =
            "⚠️ Инструменты браузера (browserOpen и др.) и управления окном приложения (appRead/appClick и др.) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name && (c.name === "noteSave" || c.name === "noteRead" || c.name === "noteList" || c.name === "noteDelete" || c.name === "checkpointSave" || c.name === "checkpointList" || c.name === "checkpointRollback")) {
          // Память проекта и точки отката работают только в desktop-приложении.
          result =
            "⚠️ Инструменты памяти проекта (noteSave/noteRead/noteList/noteDelete) и точек отката (checkpointSave/checkpointList/checkpointRollback) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "ycStatus" || c.name === "ycList" || c.name === "ycCreate" || c.name === "ycDelete" || c.name === "ycDeploy" || c.name === "ycLogs" || c.name === "ycContainer") {
          result =
            "⚠️ Инструменты Yandex Cloud (ycStatus/ycList/ycCreate/ycDelete) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else {
          result =
            "⚠️ Файловые операции и git недоступны в веб-версии. Запустите приложение на Windows (bun run dist:win).";
        }
        onEvent({ type: "tool_result", name: c.name, result });
        apiMessages.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }
    onEvent({ type: "error", message: "Превышено максимальное число раундов вызова инструментов (" + maxRounds + ")." });
  }

  return {
    webSend: webSend,
  };
});

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
    AgentCore, getSettings, openaiProfilesArr, persistSettings, onEvent, openAskModal, setChatRole,
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
      // Модель — принадлежность подключения: пустая у нового значит пустая, а не
      // модель прошлого ключа (та же правка, что в switchOpenaiProfile).
      getSettings().openaiModel = next.model || "";
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
    // Окно модели у ЛОКАЛЬНОГО сервера узнаём у него самого — как в приложении
    // (Ollama /api/show, LM Studio /api/v0/models, llama.cpp /props). От окна зависят
    // и бюджет истории, и num_ctx: без него Ollama берёт дефолт (часто 2048) и молча
    // режет запрос, а человек видит «модель ничего не делает». Облачным провайдерам
    // этот запрос не нужен: num_ctx — понятие Ollama, а бюджет у них свой.
    let modelWin = 0; // реальное окно модели (0 — сервер не ответил)
    if (provider === "ollama" || AgentCore.isLocalEndpoint(getSettings())) {
      try {
        modelWin = await AgentCore.modelWindow(getSettings(), getSettings().model);
        if (modelWin > 0) budget = AgentCore.windowBudget(provider, budget, modelWin, { local: true });
      } catch {}
    }
    let contextRetriedSteps = 0; // ступени ужатия при отказе «запрос больше окна»
    let webFitWarned = false; // про «запрос не влезал» говорим один раз за прогон
    let webNarrowWarned = false; // и про тесное окно — тоже один раз: иначе шум в каждом раунде
    // Системный промпт уезжает в КАЖДЫЙ запрос — считаем его один раз.
    const systemText =
      AgentCore.SYSTEM_PROMPT +
      (getSettings().workingDir ? "\n\nРабочая директория: " + getSettings().workingDir : "") +
      (planMode
        ? "\n\nРЕЖИМ ПЛАНА: сейчас НЕ выполняй инструменты и НЕ изменяй файлы. Составь пошаговый план работ и перечисли файлы, которые затронешь. Жди команды пользователя."
        : "");
    const systemWeight = AgentCore.estimateTokens(systemText);
    // ── Схемы инструментов: в веб-режиме их не считали ВООБЩЕ ────────────────
    // Уходили все 167 схем (≈33 000 токенов). На окне 32k они одни занимали окно
    // целиком: человек писал задачу, а модель получала обрезанный промпт или отказ
    // «контекст больше окна». Теперь как в приложении: набор схем отбирает роутер, а
    // группы накапливаются за прогон (однажды понадобившаяся — остаётся).
    const webSticky = new Set();
    let webTools = planMode ? AgentCore.PLAN_MODE_TOOL_DEFINITIONS : AgentCore.TOOL_DEFINITIONS;
    let toolsWeight = AgentCore.estimateTokens(JSON.stringify(webTools));
    const routeWebTools = (taskText) => {
      if (planMode) {
        webTools = AgentCore.PLAN_MODE_TOOL_DEFINITIONS;
      } else {
        const baseWeight = AgentCore.routeTools({ text: "" }).tokens;
        const route = AgentCore.routeTools({
          text: taskText || "",
          sticky: [...webSticky],
          roleGroups: AgentCore.rolePlan(opts.role || "dev").groups,
          maxTokens: AgentCore.routerMaxTokens(budget, systemWeight, baseWeight),
        });
        for (const gid of route.groups) webSticky.add(gid);
        webTools = route.tools;
      }
      toolsWeight = AgentCore.estimateTokens(JSON.stringify(webTools));
    };
    routeWebTools(AgentCore.routerTaskText(messages));
    // Бюджет истории: окно минус системный промпт и схемы, минус резерв 15% на ответ
    // модели и результаты инструментов (та же формула, что в приложении).
    const histBudget = () => Math.max(1500, Math.floor((budget - toolsWeight - systemWeight) * 0.85));
    // Сколько токенов уедет на самом деле: история целиком плюс схемы (промпт внутри неё).
    const payloadWeight = () => AgentCore.estimateTokens(JSON.stringify(apiMessages)) + toolsWeight;
    // Индикатор контекста: история считается БЕЗ системного промпта (он лежит внутри
    // неё, а вес промпта прибавляем сами) — иначе промпт считался бы дважды.
    const emitWebContext = () => {
      const histTokens = apiMessages.length > 1 ? AgentCore.estimateTokens(JSON.stringify(apiMessages.slice(1))) : 0;
      const used = histTokens + toolsWeight + systemWeight;
      onEvent({
        type: "context",
        used: used,
        budget: budget,
        percent: budget > 0 ? Math.max(0, Math.min(100, Math.round((used / budget) * 100))) : 0,
        history: histTokens,
        tools: toolsWeight,
        system: systemWeight,
      });
    };
    // Сжатие (памятка) в веб-режиме не работало вовсе: история молча обрезалась по
    // голове, вместе с целью задачи. Менеджер контекста тот же, что в приложении.
    const ctxManager = AgentCore.createContextManager({
      settings: getSettings(),
      emit: (ev) => onEvent(ev),
      planMode,
      local: AgentCore.isLocalEndpoint(getSettings()),
    });
    try {
      messages = AgentCore.trimConversation(messages, histBudget());
    } catch {}
    let apiMessages = [
      {
        role: "system",
        content: systemText,
      },
      ...messages,
    ];
    const maxRounds = planMode ? 3 : 10;
    let finalText = "";
    // «Стоп» в веб-режиме: прерывание запроса — остановка человека, а не сбой. Раньше
    // AbortError просто уходил наружу: ответ обрывался молча, и продолжать было нечем.
    // Теперь это та же мягкая остановка, что в приложении: «▶ Продолжить» зажигается,
    // а её просьба возвращает прогону его же прошлый ход.
    const stopGraceful = (partial) => {
      if (!String(partial || "").trim()) {
        onEvent({ type: "chunk", text: "⏹ Остановлено пользователем. Нажми «▶ Продолжить», чтобы доработать работу." });
      }
      onEvent({ type: "resume", reason: "остановлено пользователем" });
      onEvent({ type: "done" });
    };
    // Лимит провайдера (429) в веб-режиме: ждём сами до потолка, как в приложении.
    // Раньше здесь 429 сразу завершал прогон ошибкой и требовал «напиши продолжай».
    const RATE_WAIT_BUDGET_MS = 10 * 60 * 1000;
    let rateWaitedMs = 0;

    for (let round = 0; round < maxRounds; round++) {
      let collected = "";
      const toolCalls = [];
      const stripper = AgentCore.createThinkingStripper({ onHidden: (t) => onEvent({ type: "thinking", text: t }) });

      // Контекст-менеджмент: держим историю в рамках бюджета между раундами. Сначала
      // сжатие старых витков в памятку (если место кончилось), затем обрезка хвоста.
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...(await ctxManager.manage(apiMessages.slice(1), histBudget()))];
      }
      // Предохранитель перед отправкой: мерим ВЕСЬ запрос (история + промпт + схемы) и
      // урезаем историю ступенями, пока он не влезет в бюджет окна. Раньше бюджет
      // считался только по длине истории, а схемы и промпт в него не входили совсем.
      if (payloadWeight() > budget) {
        const before = payloadWeight();
        for (const frac of [0.8, 0.6, 0.4, 0.25, 0.1]) {
          const target = Math.max(1500, Math.floor((budget - toolsWeight - systemWeight) * frac));
          apiMessages = [apiMessages[0], ...(await ctxManager.manage(apiMessages.slice(1), target))];
          if (payloadWeight() <= budget) break;
        }
        // Один раз за прогон: на малом окне условие верно в каждом раунде, и та же строка
        // каждые несколько секунд — шум, который мешает читать ответ агента.
        if (!webFitWarned) {
          webFitWarned = true;
          onEvent({
            type: "notice",
            text:
              "⚠ Запрос не влезал в окно модели (≈" + Math.round(before / 1000) + "k из " + Math.round(budget / 1000) +
              "k токенов): ужал историю до ≈" + Math.round(payloadWeight() / 1000) + "k и продолжаю.",
          });
        }
        // История ужата до минимума, а запрос всё равно больше окна: причина в схемах и
        // промпте, и молчать об этом нельзя — модель будет видеть обрезанный контекст.
        if (payloadWeight() > budget && !webNarrowWarned) {
          webNarrowWarned = true;
          onEvent({
            type: "notice",
            text:
              "⚠ Окно модели мало: инструменты (~" + Math.round(toolsWeight / 1000) + "k) и промпт (~" +
              Math.round(systemWeight / 1000) + "k) занимают почти всё окно (" + Math.round(budget / 1000) +
              "k т.). Возьми модель с окном побольше, иначе агент работает вслепую.",
          });
        }
      }
      emitWebContext();
      // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
      // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
      if (apiMessages.length > 1) {
        apiMessages = [apiMessages[0], ...AgentCore.sanitizeToolPairs(apiMessages.slice(1))];
      }

      const req = AgentCore.buildChatRequest(getSettings(), {
        model: getSettings().model,
        messages: apiMessages,
        tools: webTools,
        fromBrowser: true,
        // Локальному серверу — тот же num_ctx, что и у бюджета, и не больше окна
        // модели: иначе Ollama молча режет промпт (в веб-режиме эта ручка не
        // передавалась вовсе).
        numCtxBudget: budget,
        modelWindow: modelWin,
        // Рассуждения (Low/High/Max) — из плашки рядом с полем ввода. «off» —
        // поле в запрос не попадает.
        reasoning: opts.reasoning || "off",
      });
      let res;
      try {
        res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal });
      } catch (e) {
        if (e.name === "AbortError") return stopGraceful(collected);
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
        // Переполнение контекста: ужимаем историю ступенями и повторяем ТОТ ЖЕ раунд.
        // Одной ступени мало при неизвестном окне: история влезает в новый бюджет, запрос
        // не меняется ни на токен — и второй отказ заканчивал прогон сырым JSON провайдера
        // (замер в приложении: 145 440 токенов до ужатия и 145 440 после).
        const contextish = /context|too long|maximum|num_ctx|token/i.test(detail);
        // «token» само по себе бывает про ключ — про окно рассказываем только по словам,
        // которые встречаются у переполнения («maximum context length», «context_length_exceeded»).
        const contextSure = /context|too long|maximum|num_ctx/i.test(detail);
        if (contextish) {
          if (contextSure && contextRetriedSteps < 3 && budget > 3000) {
            contextRetriedSteps++;
            const beforeBudget = budget;
            const real = Math.max(payloadWeight(), 1);
            budget = Math.max(3000, Math.floor(Math.min(budget * 0.4, real * 0.6)));
            if (apiMessages.length > 1) {
              apiMessages = [apiMessages[0], ...(await ctxManager.manage(apiMessages.slice(1), histBudget()))];
            }
            onEvent({
              type: "notice",
              text:
                "⚠ Модель ответила, что запрос больше её окна: ужимаю историю (бюджет " + Math.round(beforeBudget / 1000) +
                "k → " + Math.round(budget / 1000) + "k токенов) и повторяю тот же раунд.",
            });
            round--;
            continue;
          }
          // Ступени кончились (или ужимать некуда): объясняем по-русски и подсказываем
          // кнопку «▶ Продолжить». Слабое «token» без единой ступени — это не про окно.
          if (contextSure || contextRetriedSteps > 0) {
            onEvent({
              type: "error",
              message:
                "⚠ Модель отказалась принять запрос: он больше её окна контекста, даже ужав историю (≈" +
                Math.round(budget / 1000) + "k токенов). Переписка сохранена: нажми «▶ Продолжить» — прогон " +
                "вернёт её себе и пойдёт дальше; или выбери модель с окном побольше.",
            });
            return;
          }
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

      try {
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
      } catch (e) {
        // Обрыв чтения потока по «Стоп»: это остановка человека, а не ошибка прогона.
        if (e && e.name === "AbortError") return stopGraceful(collected);
        throw e;
      }

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
      // Вызов инструмента вне текущего набора схем: дотягиваем его группу — в этом и
      // следующих раундах схема будет на месте (в приложении то же, предохранитель A).
      if (!planMode) {
        let grew = false;
        for (const c of calls) {
          const gid = AgentCore.groupOfTool(c.name);
          if (!gid || webSticky.has(gid)) continue;
          webSticky.add(gid);
          grew = true;
        }
        if (grew) routeWebTools(AgentCore.routerTaskText(messages));
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
          result = await new Promise((resolve) => openAskModal(question, (c.args && c.args.options) || [], resolve));
          result = result && String(result).trim() ? String(result).trim() : "(пользователь не дал ответ)";
        } else if (c.name === "suggestRole") {
          // Предложение сменить роль: окно спрашивает кнопкой, а роль меняет то же
          // действие, что и кнопка «Роль». Смена ждёт следующего сообщения — текущий
          // прогон идёт в своей роли, поэтому говорим об этом модели прямо.
          const wrRaw = c.args && c.args.role;
          const wrWant = AgentCore.roleIdFromAny(wrRaw);
          const wrCur = String(opts.role || "dev");
          if (!wrWant) {
            result = "Ошибка: неизвестная роль " + JSON.stringify(String(wrRaw == null ? "" : wrRaw)) +
              ". Доступные: dev (Разработчик), assistant (Ассистент), manager (Менеджер), researcher (Исследователь).";
          } else if (wrWant === wrCur) {
            result = "Ошибка: роль уже «" + wrCur + "» — предлагать нечего, продолжай работу.";
          } else {
            const wrInfo = AgentCore.roleById(wrWant);
            const wrSwitch = "Переключиться на " + wrInfo.icon + " " + wrInfo.title;
            const wrStay = "Остаться как есть";
            const wrWhy = String((c.args && c.args.reason) || "").trim();
            const wrAns = await new Promise((resolve) =>
              openAskModal((wrWhy ? wrWhy + "\n\n" : "") + "Переключить роль чата?", [wrSwitch, wrStay], resolve)
            );
            if (String(wrAns || "").trim() === wrSwitch) {
              if (typeof setChatRole === "function") setChatRole(wrWant);
              result = "Пользователь согласился и переключил роль чата на «" + wrWant +
                "». Текущий прогон продолжается в прежней роли, новые инструменты будут доступны со следующего сообщения.";
            } else {
              result = "Пользователь решил остаться в текущей роли. Продолжай своими силами; если чего-то не хватает — прямо скажи.";
            }
          }
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
        } else if (c.name && (c.name === "noteSave" || c.name === "noteRead" || c.name === "noteList" || c.name === "noteDelete" || c.name === "diaryWrite" || c.name === "diaryRead" || c.name === "checkpointSave" || c.name === "checkpointList" || c.name === "checkpointRollback")) {
          // Память проекта, дневник агента и точки отката работают только в desktop-приложении.
          result =
            "⚠️ Инструменты памяти проекта (noteSave/noteRead/noteList/noteDelete), дневника агента (diaryWrite/diaryRead) и точек отката (checkpointSave/checkpointList/checkpointRollback) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else if (c.name === "ycStatus" || c.name === "ycList" || c.name === "ycCreate" || c.name === "ycDelete" || c.name === "ycDeploy" || c.name === "ycLogs" || c.name === "ycContainer" || c.name === "ycSecret" || c.name === "ycDns" || c.name === "ycRegistry" || c.name === "ycCosts" || c.name === "ycInstall") {
          result =
            "⚠️ Инструменты Yandex Cloud (ycStatus/ycList/ycCreate/ycDelete/ycDeploy/ycLogs/ycContainer/ycSecret/ycDns/ycRegistry/ycCosts/ycInstall) доступны только в desktop-приложении. Запустите приложение на Windows (bun run dist:win).";
        } else {
          result =
            "⚠️ Файловые операции и git недоступны в веб-версии. Запустите приложение на Windows (bun run dist:win).";
        }
        onEvent({ type: "tool_result", name: c.name, result });
        apiMessages.push({ role: "tool", tool_call_id: c.id, content: result });
      }
    }
    onEvent({ type: "resume", reason: "лимит раундов" });
    onEvent({
      type: "error",
      message:
        "Превышено максимальное число раундов вызова инструментов (" + maxRounds + "). " +
        "Нажми «▶ Продолжить» — прогон вернёт себе прошлый ход и продолжит с текущего места.",
    });
  }

  return {
    webSend: webSend,
  };
});

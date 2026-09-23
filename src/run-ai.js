"use strict";

/* ─── Прогон агента: цикл раундов, миссия и восстановление после сбоя ──────────
   Вынесено из main.js (этап B, часть 25 — последний заход в ядро чата).

   Здесь живёт сам прогон: подготовка запроса (роль чата, сводка дел менеджеру,
   рабочая папка, визитка проекта, одноразовый толчок после клона), сборка истории и
   ужатие контекста, батчи по 25 раундов, финал прогона (объяснение вместо пустого
   ответа, авто-коммит, уведомление в неактивное окно), остановка и пауза, и
   восстановление после сбоя (авто-повтор с продолжением контекста и переключением
   OpenAI-подключения).

   Модули частей 14–20 (миссия, роутер, повтор, раунд, вызовы, строгая очередь, батч,
   призывы) этот код СОБИРАЕТ: они уже вынесены и получают своё отсюда.

   Живое состояние оболочки (откат, ответ на askUser, признак клона, выбранная миссия,
   окно) приходит мостом `live`: его пишут и другие части main.js, поэтому копия
   застыла бы на первом значении. Всё остальное — готовые помощники оболочки и ядра. */

function createRunAi(deps) {
  const {
    Notification,
    PARALLEL_SAFE_TOOLS,
    PLAN_MODE_TOOL_DEFINITIONS,
    SYSTEM_PROMPT,
    UNAVAILABLE_MAX,
    agentStore,
    agentWorkDir,
    audit,
    autoCheckpointCommit,
    auxConfig,
    buildChatRequest,
    buildProjectBrief,
    classifyKeyError,
    coldCacheInfo,
    consumeProviderStream,
    contextBudget,
    createAskWait,
    createContextManager,
    createRunBatch,
    createRunCalls,
    createRunContext,
    createRunMission,
    createRunNudge,
    createRunRetry,
    createRunRound,
    createRunStrict,
    createRunTools,
    createThinkingStripper,
    describeImageRemote,
    describeToolArgs,
    estimateTokens,
    executeTool,
    extractToolCallsFromText,
    fmtError,
    friendlyRateLimitError,
    genCallId,
    groupOfTool,
    guideReadText,
    isLocalEndpoint,
    missionGuard,
    missionStore,
    modelWindow,
    normalizeToolName,
    ollamaModelInfo,
    ollamaNumCtx,
    persistUndo,
    rateLimitInfo,
    rateLimiterFor,
    readApiError,
    resolvePath,
    roleIdFromAny,
    rolePlan,
    routeTools,
    routerMaxTokens,
    routerTaskText,
    sanitizeToolPairs,
    saveContextMemo,
    saveSettings,
    snapshotFileForUndo,
    switchOpenaiProfile,
    termEmit,
    toolPolicy,
    toolsAsText,
    truncateText,
    tasksDataDir,
    windowBudget,
  } = deps;
  // Живое состояние прогона: читаем по имени каждый раз — в оболочке те же значения
  // пишут кнопки, телефон и прогон агента. Этот же мост уходит миссии: она читает
  // просьбу «▶ Продолжить» (missionClaim) и объявляет свою миссию прогона (missionId)
  // — оболочка зовёт это же значение runMissionId.
  const live = deps.live;

async function runAi(settings, messages, win, opts) {
  opts = opts || {};
  const planMode = !!(opts.plan || opts.planMode); // режим «сначала план»: инструменты не выполняются
  // Роль чата (Разработчик / Ассистент / Менеджер / Исследователь). Текст роли уходит
  // в системный промпт каждый раунд, а её группы инструментов включены с первого раунда:
  // набор схем не меняется на ходу, префикс запроса стабилен, каждый раунд дешевле.
  const role = rolePlan(opts.role);
  const roleNote = role.prompt ? "\n\n" + role.prompt : "";

  // Менеджеру сразу даём свежую сводку дел — чтобы он не гадал и не звал taskList впустую.
  let tasksNote = "";
  if (role.id === "manager" && !planMode) {
    try {
      tasksNote = "\n\n=== МОИ ДЕЛА (актуально на " + new Date().toLocaleString() + ") ===\n" + agentStore.tasksBrief(tasksDataDir(), 8);
    } catch {}
  }
  const emit = (ev) => {
    if (!win.isDestroyed()) win.webContents.send("ai:event", ev);
  };
  live.activeEmit = emit;
  const abort = new AbortController();
  live.activeAbort = abort;
  live.activeRunUndo = [];
  const provider = settings.provider || "openai";
  // Рассуждения модели (текст из <think>...</think> и нативные reasoning_content / thinking_delta)
  const emitThink = (text) => {
    if (text) emit({ type: "thinking", text });
  };

  // ── Миссия: долгая работа, которая переживает перезапуск — код в src/run-mission.js ──
  // Агент «на 8 часов» не имеет права терять задачу: цель, план, шаги и журнал лежат
  // файлами в .agent/missions/<id>/, а прогон идёт БАТЧАМИ (25 раундов, затем
  // «миссия жива? лимиты? был ли прогресс?» и новый батч с тем же контекстом).
  // Живые значения приходят мостами: emit определён выше, «▶ Продолжить» из панели
  // отдаёт свою просьбу через missionClaim, а инструменты агента видят миссию
  // прогона по runMissionId. Показ (чат, откат, «готово») остаётся здесь.
  const mission = createRunMission({
    settings,
    planMode,
    messages,
    roleId: role.id,
    dir: agentWorkDir(settings),
    chatId: live.activeRunChatId,
    emit,
    missionStore,
    missionGuard,
    live: live,
  });

  // Пауза по кнопке: работа не теряется — миссия гасится на диске модулем, а
  // показ, откат и «готово» делает оболочка. Порядок событий прежний.
  const stopForPause = () => {
    const paused = mission.pause();
    global.__agentPauseRequested = false;
    finalText = paused.text;
    emit({ type: "chunk", text: finalText });
    mission.emitState("paused");
    live.lastUndoLog = live.activeRunUndo.slice();
    persistUndo();
    if (live.lastUndoLog.length) emit({ type: "undo_available", count: live.lastUndoLog.length });
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  if (!settings.model) {
    throw new Error("Не выбрана модель. Открой Настройки и обнови список моделей (кнопка ↻).");
  }

  // Локальный ли сервер — по АДРЕСУ, а не по имени семейства: LM Studio, vLLM,
  // llama.cpp и g4f живут на своём ПК, и правила у них локальные (потолок по памяти,
  // неспешные таймауты), хотя говорят они на OpenAI-совместимом API.
  const localEndpoint = isLocalEndpoint(settings);
  // Контекст-окно: бюджет = реальное окно модели (если известно) минус резерв на вывод.
  let budget = contextBudget(provider, settings.model);
  let modelWin = 0; // реальное окно модели (0 — сервер не ответил)
  try {
    modelWin = await modelWindow(settings, settings.model);
    // Потолок бюджета. У облака это «сколько не жалко токенов», у локальной модели —
    // её окно: локальные токены бесплатны, платим памятью (KV-кэш) и временем. Прежний
    // общий потолок 14 000 душил локальную модель с окном 40–130k, а вместе с ним
    // выключался и роутер инструментов (см. tools.refresh).
    if (modelWin > 0) budget = windowBudget(provider, budget, modelWin, { local: localEndpoint });
    // Нижний предел — 3000 токенов, но НИКОГДА больше реального окна: у модели с
    // окном 2048 «пол» в 3000 гарантировал переполнение на каждом запросе.
    budget = Math.max(budget, modelWin > 0 ? Math.min(3000, modelWin) : 3000);
  } catch {}
  // Возможности локальной модели (tools) — не «информация к сведению»: без capability
  // «tools» схемы в запросе бесполезны, а часть сборок Ollama отвечает на них ошибкой и
  // роняет весь раунд. Ниже это переключает протокол вызова инструментов.
  let ollamaInfo = null;
  if (provider === "ollama") {
    try {
      ollamaInfo = await ollamaModelInfo(settings, settings.model);
    } catch {}
  }
  // Ollama сама сообщает о поддержке инструментов (/api/show → capabilities).
  // У совместимых серверов (LM Studio, vLLM, g4f) спросить негде, поэтому там это
  // осознанная галочка в настройках — угадывать по имени модели мы не будем.
  const noToolsDetected = !!(ollamaInfo && ollamaInfo.known && !ollamaInfo.tools);
  const noTools = noToolsDetected || !!settings.noToolsModel;
  if (noTools) {
    // Говорим и в «Консоль», и в чат: раньше сообщение жило только в консоли,
    // а пользователь видел «модель ничего не делает» без объяснения причины.
    const noToolsNote = noToolsDetected
      ? "⚠ Модель «" + settings.model + "» не объявила поддержку инструментов (нет capability «tools»). " +
        "Схемы в таком запросе бесполезны, поэтому работаю по текстовому протоколу: в системное " +
        "сообщение ушёл компактный каталог, а инструменты вызываются JSON-блоком " +
        "{\"name\": ..., \"arguments\": {...}}. Для файлов и git надёжнее модель с инструментами " +
        "(qwen3, llama3.1, mistral-nemo)."
      : "⚠ Включена настройка «Модель без поддержки инструментов»: схемы не отправляю, " +
        "вместо них в системном сообщении компактный каталог, а инструменты вызываются " +
        "JSON-блоком {\"name\": ..., \"arguments\": {...}}. Выключи галочку, если модель " +
        "умеет нативные вызовы — тогда вернутся схемы и точность вызовов будет выше.";
    termEmit({ type: "metrics", text: noToolsNote });
    emit({ type: "notice", text: noToolsNote });
  }
  // Счётчики повторов, ожидание лимита и лимитер провайдера живут в src/run-retry.js,
  // который собирается ниже (после истории: ему нужно уметь ужимать контекст).
  let reportRetried = false; // пустой финальный текст — один раз просим итоговый отчёт
  live.activePlanSummary = null; // план прошлого прогона не должен влиять на этот
  // ── Роутер инструментов и справочники ──────────────────────────────────────
  // Состав схем, липкость групп, предохранители A и C, вес схем и автоподключение
  // справочников живут в src/run-tools.js — там же объяснено, почему группа не
  // гаснет на середине задачи и почему вес считается по тому, что РЕАЛЬНО уйдёт в
  // запрос. Здесь — только сборка и чтение состояния прогона.
  const tools = createRunTools({
    settings,
    planMode,
    messages,
    role,
    noTools,
    emit,
    termEmit,
    getBudget: () => budget, // бюджет пересчитывается при переполнении — считаем по живому
    systemPrompt: SYSTEM_PROMPT,
    routeTools,
    routerMaxTokens,
    routerTaskText,
    estimateTokens,
    toolsAsText,
    guideReadText,
    groupOfTool,
    PLAN_MODE_TOOL_DEFINITIONS,
  });
  live.activeToolRouter = tools.router;
  tools.refresh();
  const ctxManager = createContextManager({
    settings,
    emit,
    planMode,
    // Сжатие идёт тем же сервером: локальной модели нужен тот же num_ctx, иначе Ollama
    // возьмёт дефолт 2048 (памятка соберётся из обрезанного текста) и перезагрузит модель.
    localCtx: provider === "ollama" ? ollamaNumCtx(budget, modelWin) : 0,
    // Тот же признак, что и для бюджета: у местного сервера сжатие может идти минутами.
    local: localEndpoint,
    // Память диалогов: при сжатии контекста пишем памятку в локальный дневник (по датам).
    onMemo: (m) => saveContextMemo(settings, m, emit),
  });
  // Индикатор контекста: сколько токенов занимают история + схема инструментов.
  // Отправляется в интерфейс полоской под полем ввода (видно, когда контекст подходит к концу).
  const emitContext = (hist) => {
    try {
      const histTokens = hist && hist.length ? estimateTokens(JSON.stringify(hist)) : 0;
      const used = histTokens + tools.state.weight + tools.state.systemWeight;
      const percent = budget > 0 ? Math.max(0, Math.min(100, Math.round((used / budget) * 100))) : 0;
      emit({ type: "context", used, budget, percent, history: histTokens, tools: tools.state.weight, system: tools.state.systemWeight });
    } catch {}
  };


  // ── Завершение прогона — одна точка входа ──────────────────────────────────
  // И обычный финал, и мягкая остановка миссии (лимит раундов/времени, зацикливание)
  // проходят здесь: пользователь получает объяснение, а не «ошибку API».
  const endRun = async (fallbackText) => {
    // Мягкая остановка миссии (лимит раундов/времени, зацикливание, закрытие) —
    // это объяснение человеку, а не «ошибка API». Раньше оно подставлялось только
    // вместо ПУСТОГО ответа: если модель успела напечатать текст в последнем раунде,
    // человек видел обрыв на полуслове и без причины. Теперь объяснение дописывается
    // в конец ответа, а сам ответ не затирается.
    const stopNote = String(fallbackText || "").trim();
    const said = String(finalText || "").trim();
    if (stopNote && stopNote !== said) {
      finalText = said ? finalText + "\n\n" + stopNote : stopNote;
      emit({ type: "chunk", text: (said ? "\n\n" : "") + stopNote });
    }
    // Обычный финал — работа доведена до конца, возвращать в работу нечего.
    // Мягкая остановка миссии (stopNote) — наоборот: человек продолжит её кнопкой,
    // и чекпоинт даст модели её же прошлые шаги, а не пересказ.
    if (!stopNote) runCtx.close();
    if (!String(finalText || "").trim() && !abort.signal.aborted) {
      finalText =
        "⚠ Модель не прислала итоговый текст (вероятно, переполнен контекст). Изменения сохранены; нажми «↻ Перегенерировать» или напиши «продолжай».";
      emit({ type: "chunk", text: finalText });
    }
    live.lastUndoLog = live.activeRunUndo.slice();
    persistUndo();
    if (live.lastUndoLog.length) emit({ type: "undo_available", count: live.lastUndoLog.length });
    // Авто-чекпоинт: агент менял файлы — фиксируем локальный коммит-точку возврата (без пуша).
    if (!planMode && live.lastUndoLog.length) {
      const cp = await autoCheckpointCommit(settings, messages);
      if (cp && cp.committed) emit({ type: "checkpoint", message: cp.message });
    }
    // Системное уведомление, если окно не в фокусе (долгий ответ закончился)
    if (live.mainWindow && !live.mainWindow.isFocused() && Notification.isSupported()) {
      try {
        const snippet = String(finalText || "").trim().slice(0, 140);
        new Notification({
          title: "NestDev",
          body: "Ответ агента готов" + (snippet ? ": " + snippet : ""),
        }).show();
      } catch {}
    }
    // Прогон закончился — ждать ответа больше некому: поздний ответ в окно
    // завершённого прогона не должен уезжать в следующий.
    askWait.cancel();
    mission.emitState("end");
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  // Ожидание ответа человека (варианты кнопкой плюс своё поле) — своим модулем
  // (src/ask-wait.js): там же объяснено, почему забытый таймер нельзя оставлять —
  // он «отвечал» на СЛЕДУЮЩИЙ вопрос, и агент работал дальше, пока человек смотрел
  // на открытое окно с вопросом.
  const askWait = createAskWait({ emit, live });
  const askUserWait = askWait.askUserWait;
  // Предложение сменить роль (suggestRole) ждёт ответа тем же механизмом, что и
  // вопрос: окно показывает кнопку, прогон стоит, пока человек не решит.
  const roleSuggestWait = askWait.roleSuggestWait;
  const trimmedHistory = await ctxManager.manage(messages, tools.state.histBudget);
  emitContext(trimmedHistory);
  // Авто-разбор присланных картинок вспомогательной vision-моделью (второй ключ):
  // скриншот → описание → кодер работает с текстом (его модель может не видеть картинки).
  let runHistory = trimmedHistory;
  const vcfg = auxConfig(settings);
  if (vcfg.enabled && vcfg.auto && vcfg.visionModel && vcfg.url && !planMode) {
    let target = -1;
    for (let i = runHistory.length - 1; i >= 0; i--) {
      const m = runHistory[i];
      if (m && m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p && p.type === "image_url")) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      const msg = runHistory[target];
      const text = (msg.content || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
      const imgs = (msg.content || []).filter((p) => p && p.type === "image_url" && p.image_url && p.image_url.url).slice(0, 3);
      emit({ type: "vision", text: "👁 Разбираю присланные изображения вспомогательной моделью…" });
      try {
        const descs = [];
        for (const part of imgs) {
          const desc = await describeImageRemote(vcfg, part.image_url.url, "Опиши подробно, что изображено на картинке: объекты, текст, интерфейс, цвета, расположение. Это описание уйдёт программисту вместо картинки.", vcfg.visionModel);
          descs.push(desc || "(описание пустое)");
        }
        const note = "\n\n[Описание присланного изображения (сделано вспомогательной vision-моделью на отдельном ключе):]\n" + descs.join("\n\n---\n\n");
        runHistory = runHistory.slice();
        runHistory[target] = { ...msg, content: text ? text + note : note.trim() };
        emit({ type: "vision", text: "✓ Изображения разобраны — описание передано основной модели." });
      } catch (e) {
        emit({ type: "vision", text: "⚠ Не удалось разобрать изображение: " + ((e && e.message) || e) + " — картинка отправлена как есть." });
      }
    }
  }
  // Канонические сообщения (OpenAI-стиль). Провайдер-специфику применяем на лету в buildChatRequest.
  const workDir = agentWorkDir(settings);
  // ── Контекст прогона: работа, которая переживает остановку ────────────────
  // Пауза, «Стоп» и закрытие приложения раньше теряли весь ход работы: в новый
  // прогон уходили одни тексты реплик (результаты инструментов интерфейс не
  // отправляет), и агент заново искал, чем занимался. Теперь рабочая история
  // ложится рядом с проектом (.agent/runs/) и возвращается в работу, если прогон
  // не был доведён до конца (см. src/run-context.js).
  const runCtx = createRunContext({
    dir: () => workDir,
    id: live.activeRunChatId,
    sanitizeToolPairs,
  });
  const resumePlan = runCtx.plan(runHistory);
  if (resumePlan.resumed) {
    runHistory = resumePlan.history;
    emit({ type: "notice", text: resumePlan.notice });
    emitContext(runHistory);
  }
  const wdNote =
    "\n\nРабочая директория приложения (туда создаются файлы и там выполняются команды): " +
    workDir +
    (live.lastAgentRepoDir && live.lastAgentRepoDir !== workDir ? "\nАктивный репозиторий: " + live.lastAgentRepoDir : "") +
    '\nОтносительные пути вроде "test.txt" или "src/utils/helper.txt" резолвятся относительно рабочей директории.';
  // Файлы миссий лежат там, где решил человек (настройка «миссии и прогоны»), а не
  // обязательно в `.agent/` рядом с проектом. Модель обязана знать правду: иначе она
  // станет искать журнал миссии не там и сочтёт уже сделанную работу потерянной.
  // Когда папка не выбрана, приписки НЕТ — прежний промпт не меняется ни на байт.
  let dataNote = "";
  try {
    const mRoot = missionStore.agentRoot(workDir);
    if (mRoot !== missionStore.defaultRoot(workDir)) {
      dataNote =
        "\n\nРабота агента (миссии и прогоны) лежит в папке, выбранной в настройках: " +
        missionStore.missionsPathText(workDir) +
        " — не .agent/ рядом с проектом. Журнал, план и отчёт миссии ищи там (точные пути показывает missionStatus).";
    }
  } catch {}
  // Краткая «визитка» проекта — чтобы агент не начинал сессию вслепую
  // (buildProjectBrief: имя, скрипты, структура, начало README).
  const projectBrief = buildProjectBrief(workDir);
  const briefNote = projectBrief
    ? "\n\n=== САММАРИ ПРОЕКТА (сгенерировано автоматически; детали — через listFiles / fileOutline / readFileLines) ===\n" + projectBrief
    : "";
  // Одноразовый толчок после клонирования/выбора репозитория: без него агент может
  // не догадаться, что пользователь ждёт разбора нового проекта. Флаг сбрасывается
  // сразу после первого ответа — постоянной нагрузки на контекст нет.
  let cloneNote = "";
  if (live.clonedRepoPending && !planMode) {
    live.clonedRepoPending = false;
    cloneNote =
      "\n\nПроект только что склонирован (рабочая директория сменилась). Пользователь ждёт: краткий анализ проекта и инструкцию, как его запустить — команда запуска (скрипты — в САММАРИ ПРОЕКТА), порт, как проверить (startBackground + checkUrl/checkPort; для веб-интерфейса — previewUI). Файлы целиком не читай — fileOutline / readFileLines / searchProject.";
  }
  let canonical = [
    {
      role: "system",
      content: SYSTEM_PROMPT + roleNote + tasksNote + wdNote + dataNote + briefNote + cloneNote + (planMode ? "\n\nРЕЖИМ ПЛАНА: доступен только todoWrite — вызови его с планом работ (3–7 пунктов) и в тексте перечисли файлы, которые затронешь. НЕ изменяй файлы и НЕ выполняй другие инструменты. Жди команды пользователя." : ""),
    },
    ...sanitizeToolPairs(
      runHistory.map((m) => {
        const one = { role: m.role, content: m.content };
        // Рабочая история из чекпоинта приходит с вызовами и их результатами, и
        // терять их нельзя: без tool_call_id результат инструмента становится
        // «осиротевшим», разбор пар его выбрасывает — и пауза опять теряла бы
        // работу, ради которой чекпоинт и заведён.
        if (m.tool_calls) one.tool_calls = m.tool_calls;
        if (m.tool_call_id) one.tool_call_id = m.tool_call_id;
        return one;
      })
    ),
  ];
  // Первый чекпоинт — сразу: если приложение закроется во время ответа модели,
  // работа уже на диске.
  runCtx.save(canonical);

  // Ужать историю при переполнении контекста: бюджет уменьшается, список пересобирается.
  // Ровно та же работа нужна и при сжатии между раундами, поэтому — одной точкой входа.
  const shrinkContext = async () => {
    budget = Math.max(3000, Math.floor(budget * 0.4));
    tools.state.histBudget = tools.histBudgetAfterOverflow();
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), tools.state.histBudget))];
      emitContext(canonical);
    }
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }
  };

  // Восстановление после отказа запроса (лимиты 429, «холодный» пул 503, переполнение
  // контекста, отказ строгого сервера) живёт в src/run-retry.js: там же объяснено,
  // почему ждём сами и что сбрасывает счётчики. Здесь — сборка с живыми значениями.
  const retry = createRunRetry({
    settings,
    provider,
    emit,
    termEmit,
    rateLimiter: rateLimiterFor(settings),
    getBudget: () => budget,
    shrinkContext: shrinkContext,
    friendlyRateLimitError,
    rateLimitInfo,
    coldCacheInfo,
    UNAVAILABLE_MAX,
  });

  // Один раунд общения с провайдером (запрос, поток ответа, метрики) — своим модулем
  // (src/run-round.js). Бюджет и окно модели идут функциями: их меняет ужатие
  // контекста, и копия застыла бы на старом числе.
  const roundRunner = createRunRound({
    settings,
    provider,
    emit,
    termEmit,
    emitThink,
    getBudget: () => budget,
    getModelWindow: () => modelWin,
    getCompactions: () => ctxManager.compactions(),
    noTools: noTools,
    localEndpoint: localEndpoint,
    tools: tools,
    retry: retry,
    mission: mission,
    abort: abort,
    SYSTEM_PROMPT,
    buildChatRequest,
    consumeProviderStream,
    createThinkingStripper,
    readApiError,
    estimateTokens,
  });

  // Вызовы раунда (текстовые, нормализация, история, параллельная пачка) — своим
  // модулем (src/run-calls.js). Список безопасных для параллели инструментов
  // остаётся здесь: он собран из инструментов всего приложения.
  const callPrep = createRunCalls({
    settings,
    emit,
    extractToolCallsFromText,
    genCallId,
    normalizeToolName,
    executeTool,
    truncateText,
    fmtError,
    PARALLEL_SAFE_TOOLS,
  });

  // Строгая очередь вызовов: подтверждения человеком, чекпоинты отката, журнал
  // действий и журнал миссии — своим модулем (src/run-strict.js). Источник
  // действия меняется на каждый прогон, поэтому уходит функцией.
  const strict = createRunStrict({
    settings,
    emit,
    askUserWait,
    roleSuggestWait,
    roleIdFromAny,
    toolPolicy,
    describeToolArgs,
    executeTool,
    truncateText,
    audit,
    mission,
    snapshotFileForUndo,
    resolvePath,
    getRunOrigin: () => live.activeRunOrigin,
  });

  // Решения после раунда (пустой отчёт, граница батча, закрытие миссии) —
  // своим модулем (src/run-batch.js). Пауза между батчами — аргументом.
  // ВНИМАНИЕ: имя НЕ `batch` — внутри внешнего цикла так называется его счётчик,
  // и модуль был бы перекрыт числом (живой прогон ловит это сразу).
  const batchCtl = createRunBatch({ emit, mission, pauseMs: 1500 });

  // Призывы по текстовому ответу: счётчик «план не закрыт» живёт внутри модуля
  // (он собирается один раз на прогон), сводка плана — живым значением.
  const nudge = createRunNudge({
    emit,
    termEmit,
    mission,
    getPlanSummary: () => live.activePlanSummary,
  });

  const maxRounds = planMode ? 3 : 25;
  let finalText = "";

  const stopGraceful = () => {
    // Человек остановил работу: закрываем отрезок в миссии. Дальше она продолжится
    // с панели новым отрезком, и в пути останется, на чём именно встали, — иначе
    // следующая сессия видела бы «работа шла», но не знала, где остановилась.
    mission.stage("остановка человеком");
    if (!String(finalText || "").trim()) {
      finalText = "⏹ Остановлено пользователем. Изменения сохранены; напиши «продолжай», чтобы доработать.";
      emit({ type: "chunk", text: finalText });
    }
    live.lastUndoLog = live.activeRunUndo.slice();
    persistUndo();
    if (live.lastUndoLog.length) emit({ type: "undo_available", count: live.lastUndoLog.length });
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  // Авто-повтор после сбоя: при любой ошибке (сеть/API/провайдер/инструмент) делаем ещё
  // попытку с продолжением контекста (история canonical сохраняется) — до AUTO_RETRY_LIMIT повторов.
  const AUTO_RETRY_LIMIT = 2;
  for (let attemptNum = 1; ; attemptNum++) {
  try {
  // Батчи: 25 раундов работы, затем проверка «миссия жива? лимиты? был ли прогресс?»
  // и следующий батч с тем же контекстом. Долгая работа перестаёт быть одной
  // длинной попыткой, которую обрывает счётчик раундов.
  // Повтор раунда после лимита/сбоя — это ТА ЖЕ попытка, а не новый раунд: иначе
  // счётчик раундов миссии растёт вдвое под лимитами провайдера, и её пределы
  // (а также порог авто-миссии на 6-м раунде) наступают раньше настоящего времени.
  // Флаг заодно не даёт второй раз объявить «продолжаю миссию с места остановки»:
  // без него повтор первого раунда писал бы в журнал миссии лишнюю строку.
  let repeatAttempt = false;
  let firstRoundHandled = false;
  for (let batch = 1; ; batch++) {
  for (let round = 0; round < maxRounds; round++) {
    if (!repeatAttempt) mission.state.rounds++;
    repeatAttempt = false;
    // Незакрытая миссия (в том числе с прошлого запуска приложения) — продолжаем её,
    // а не начинаем работу заново: файлы и журнал лежат на диске.
    if (!firstRoundHandled) {
      firstRoundHandled = true;
      const resumed = mission.resume();
      if (resumed) {
        emit({ type: "notice", text: resumed.notice });
        mission.emitState(resumed.phase);
      }
    }
    // Длинная работа видна по делу: если модель много раундов работает инструментами,
    // заводим миссию — файлы, журнал и защита от обрыва появляются вовремя.
    mission.autoStart();
    // Пауза из панели «Миссия»: не начинаем новый раунд, работу не теряем.
    if (global.__agentPauseRequested) return stopForPause();
    // Пользователь остановил агента (Esc/Стоп) — не начинаем новый раунд.
    if (global.__agentStopRequested) return stopGraceful();
    // Роутер: пересобираем набор схем (группы могли добавиться в прошлом раунде).
    tools.refresh();
    // Контекст-менеджмент: между раундами держим историю в рамках бюджета токенов.
    // Хвост (текущий виток с tool-результатами) сохраняется целиком.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), tools.state.histBudget))];
    }
    // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
    // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }

    // ── Состояние работы: сводка миссии для модели ───────────────────────────
    // Начало долгой работы вытесняется из окна (обрезка идёт С КОНЦА истории), а
    // журнал миссии лежит файлами на диске и в запрос не попадал вообще: после
    // батча или сжатия агент видел только свежий хвост и заново искал, что уже
    // делал. Поэтому подставляем короткую сводку (цель, план, прогресс, хвост
    // журнала, что живёт между командами) в КАЖДЫЙ запрос и убираем её сразу
    // после раунда: в сохранённой истории чата она не копится, а модель видит её
    // всегда — и в первом раунде, и после границы батча, и после сжатия.
    const digestMsg = mission.digestMessage();
    if (digestMsg) canonical.splice(1, 0, digestMsg);
    // Индикатор контекста — ПОСЛЕ подстановки: иначе он врал бы про занятое место.
    emitContext(canonical);
    // Чекпоинт перед запросом: обрыв на ответе модели оставляет работу на диске.
    runCtx.save(canonical);

    // Один раунд (запрос, поток ответа, метрики) живёт в src/run-round.js: там же
    // объяснено, почему состав схем, бюджет и usage ошибаются тихо. Хозяином цикла
    // остаётся прогон: и повтор раунда, и фатальная ошибка — его решение.
    let roundOut;
    try {
      roundOut = await roundRunner.run({ n: round, maxRounds: maxRounds, messages: canonical });
    } finally {
      // Сводка ищется ПО ССЫЛКЕ: сама история между раундами пересобирается
      // (обрезка, сжатие), и по номеру позиции её можно было бы снять не на месте.
      const di = digestMsg ? canonical.indexOf(digestMsg) : -1;
      if (di >= 0) canonical.splice(di, 1);
    }
    if (roundOut.kind === "repeat") {
      round--; // тот же логический раунд: номер не тратится
      repeatAttempt = true; // и раунд миссии не тратится тоже
      continue;
    }
    if (roundOut.kind === "error") throw roundOut.error;
    const toolCalls = roundOut.toolCalls;
    finalText = roundOut.text;

    // Запасной способ живёт в src/run-calls.js. Он стоит здесь, ДО призывов и
    // «пустого отчёта»: найденный в тексте вызов обязан выполниться, а не уйти
    // в призыв «план не закрыт».
    callPrep.fromText({ toolCalls: toolCalls, text: finalText, planMode: planMode });

    // Призывы по текстовому ответу (план не закрыт, сторож миссии) живут в
    // src/run-nudge.js. Повтор раунда и финал — решение прогона.
    const nudged = nudge.decide(canonical, {
      toolCalls: toolCalls,
      planMode: planMode,
      text: finalText,
      aborted: abort.signal.aborted,
    });
    if (nudged.action === "repeat") continue;

    // Пустой финальный ответ: один раз просим итоговый отчёт — решение в
    // src/run-batch.js, повтор раунда и флаг остаются за прогоном.
    if (
      batchCtl.askForReport(canonical, {
        toolCalls: toolCalls,
        planMode: planMode,
        text: finalText,
        reportRetried: reportRetried,
        aborted: abort.signal.aborted,
      })
    ) {
      reportRetried = true;
      continue;
    }

    if (toolCalls.length === 0) return await endRun("");

    // Нормализация имён, стабильные id, дедупликация и запись в историю —
    // в src/run-calls.js: там же объяснено, почему дубль вызова и потерянная
    // подпись мысли (Gemini) стоят дорого.
    const calls = callPrep.normalize(toolCalls);
    // Предохранитель A: модель вызвала реальный инструмент, которого нет в текущем
    // наборе схем (группа не была активирована). Дотягиваем его группу — в этом и
    // следующих раундах схема будет на месте; сам вызов выполняем как обычно.
    tools.ensureGroupsFor(calls);

    // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
    if (!calls.length) {
      if (!String(finalText || "").trim()) finalText = "Готово.";
      emit({ type: "chunk", text: finalText });
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    callPrep.recordAssistant(canonical, finalText, calls);

    // Батчинг (правило 35 промпта): read-only вызовы раунда идут параллельно,
    // любая запись или вопрос человеку возвращает строгую очередь. Решение и
    // порядок событий — в src/run-calls.js, остановка остаётся за прогоном.
    if (callPrep.canRunParallel(calls, planMode)) {
      await callPrep.runParallel(calls, canonical);
      runCtx.save(canonical); // результаты шага уже в работе — фиксируем на диске
      if (global.__agentStopRequested) return stopGraceful();
      continue;
    }

    // Строгая очередь (подтверждения, чекпоинт, аудит, журнал миссии) — в
    // src/run-strict.js. Сюда приходят вызовы, которые НЕЛЬЗЯ гнать пачкой:
    // запись, вопрос человеку, потенциально опасное. Остановка — за прогоном.
    await strict.runStrict(calls, { planMode: planMode, history: canonical, role: role.id });
    runCtx.save(canonical); // то же для строгой очереди: запись, правки, подтверждения
    // Остановка во время выполнения инструментов — завершаем без нового раунда.
    if (global.__agentStopRequested) return stopGraceful();
    mission.trackProgress(calls);
  }
  // Конец батча: граница батча, закрытие миссии и напоминание живут в
  // src/run-batch.js. Завершение и выход из цикла — решение прогона.
  const after = await batchCtl.afterRound(canonical);
  if (after.kind === "end") return await endRun(after.message);
  if (after.kind === "break") break;
  }
  throw Object.assign(
    new Error(
      "Превышено максимальное число раундов вызова инструментов (" + maxRounds + "). " +
      "(Действия на диске сохранены.) Напиши «продолжай» — агент получит тот же контекст и продолжит с текущего места."
    ),
    { fatal: true }
  );
  } catch (e) {
    const fatal = (e && e.name === "AbortError") || (e && e.fatal) || global.__agentStopRequested || (e && e.message && /Не выбрана модель/.test(e.message));
    // Миссия и сбой: обычные ошибки (сеть, 5xx, обрыв) не повод бросать долгую работу.
    // Ждём и продолжаем, пока миссия жива и не исчерпан запас авто-продолжений.
    const mAlive = !fatal && mission.alive();
    const mContinues = mAlive && mission.canAutoContinue();
    if (fatal || (attemptNum > AUTO_RETRY_LIMIT && !mContinues)) throw e;
    if (mContinues) mission.recordError(e);
    const errText = String((e && e.message) || e).slice(0, 800);
    // Провайдер отверг stream_options уже внутри ответа (не ошибкой на заголовках) —
    // снимаем флаг: авто-повтор ниже пойдёт без него.
    if (retry.state.includeUsage && /stream_options|include_usage/i.test(errText)) {
      retry.state.includeUsage = false;
      termEmit({
        type: "metrics",
        text: "Провайдер отверг stream_options — повторяю запрос без метрик токенов.",
      });
    }
    // Авто-переключение на следующее сохранённое OpenAI-подключение: ошибка ключа/
    // баланса/лимита/сети — пробуем другой ключ вместо бессмысленных повторов.
    let switchedProfile = null;
    if (settings.provider === "openai" && settings.autoSwitchProfiles) {
      try {
        // Меняем ключ только когда ошибка действительно про ключ/баланс/лимит,
        // и откладываем провинившийся ключ на cooldown (не долбим провайдера).
        const cls = classifyKeyError(errText);
        if (cls.key) switchedProfile = switchOpenaiProfile(settings, { penalizeCurrentMs: cls.cooldownMs });
        if (switchedProfile) {
          saveSettings(settings); // активное подключение сохраняется (ключи — в secrets.json)
          emit({
            type: "profile_switched",
            name: switchedProfile.name || switchedProfile.id || "?",
            id: switchedProfile.id,
            error: errText,
          });
        }
      } catch {}
    }
    emit({ type: "text_override", text: "" }); // стираем частичный текст упавшей попытки в UI
    emit({
      type: "retry",
      attempt: attemptNum + 1,
      total: AUTO_RETRY_LIMIT + 1,
      error: errText + (switchedProfile ? " — переключено на подключение «" + (switchedProfile.name || switchedProfile.id) + "»" : ""),
    });
    finalText = "";
    await new Promise((r) => setTimeout(r, 3000)); // пауза: провайдеры сбрасывают лимиты за секунды
    canonical.push({
      role: "system",
      content:
        "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА — авто-повтор " + (attemptNum + 1) + " из " + (AUTO_RETRY_LIMIT + 1) + ".\n" +
        "Ошибка: " + errText + (switchedProfile ? " (выполнено переключение на другое подключение — ключ «" + (switchedProfile.name || switchedProfile.id) + "»)" : "") + "\n" +
        "Продолжай с того места, где остановился, опираясь на уже сделанное (инструменты, файлы, результаты выше). " +
        "Не начинай заново и не повторяй выполненные шаги: сначала быстро оцени текущее состояние (например git status или чтение ключевых файлов), затем продолжи. " +
        "Если ошибка про лимиты/токены — работай компактнее: меньше файлов целиком, чаще searchFile/semanticSearch, короче выводы.",
    });
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }
    continue;
  }
  }
}

  return { runAi };
}

module.exports = { createRunAi };

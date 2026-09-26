"use strict";

/* ── Прогон агента: цикл раундов, миссия и восстановление (src/run-ai.js) ────────
   Запуск: node test/run-ai.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 25). Здесь проверяется то, что видно
   СНАРУЖИ прогона: как собирается запрос (роль, рабочая папка, визитка проекта,
   одноразовые примечания), какие решения принимает цикл (повтор раунда, финал,
   остановка, пауза, авто-повтор) и что живое состояние оболочки читается ПО ИМЕНИ.

   Ошибки здесь дорогие и тихие: обрыв на полуслове без объяснения, потерянные
   правки без журнала отката, авто-повтор, который повторяет не то, и уведомление,
   которое приходит при активном окне (или не приходит при свёрнутом). */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunAi } = require(path.join(ROOT, "src", "run-ai.js"));
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

// ── Стенд: прогон с поддельным окружением ────────────────────────────────────
// Раунды задаются очередью: элемент — что вернёт раунд. Очередь кончилась —
// раунд отвечает `defaultStep` (по умолчанию обычным финальным текстом, иначе
// цикл зациклился бы на одном шаге).
//   { text, toolCalls }  обычный ответ        { repeat: true }  повтор раунда
//   { error }            сбой раунда          { onRun() }       что сделать ДО ответа
function mk(over) {
  const o = over || {};
  const calls = {
    rounds: [], events: [], notifies: [], metrics: [],
    switched: 0, saves: 0, commits: 0, parallel: 0, strict: [], manages: [],
    mission: [], brief: [], histories: [], asks: [],
    ctxSaves: [], ctxClosed: 0, ctxDeps: null, ctxPlanned: [], askDeps: null, askCancels: 0,
  };
  const queue = (o.rounds || [{ text: "Готово." }]).slice();
  const win = {
    isDestroyed: () => false,
    isFocused: () => (o.focused === undefined ? true : o.focused),
    webContents: { send: (ch, ev) => calls.events.push({ ch, ev }) },
  };
  const live = {
    activeAbort: null,
    activeEmit: null,
    activePlanSummary: null,
    activeToolRouter: null,
    activeRunUndo: [],
    lastUndoLog: [],
    pendingAsk: null,
    clonedRepoPending: !!o.clonedRepoPending,
    mainWindow: Object.prototype.hasOwnProperty.call(o, "mainWindow") ? o.mainWindow : win,
    activeRunChatId: "chat-1",
    activeRunOrigin: "desktop",
    lastAgentRepoDir: o.lastAgentRepoDir || null,
    missionClaim: "",
    runMissionId: "",
  };
  const Notification = class {
    constructor(x) { calls.notifies.push(x); }
    show() {}
    static isSupported() { return o.notifySupported === undefined ? true : o.notifySupported; }
  };

  const mission = {
    state: { rounds: 0 },
    // Сводка состояния работы: по умолчанию её нет (как до её появления), поэтому
    // остальные проверки набора остаются про то же самое. Кому нужна — отдаёт
    // `mk({ digest })`.
    digestMessage: () => (o.digest === undefined ? null : o.digest),
    // Закрытие отрезка работы (этапа): зовётся при остановке человеком.
    stage: (reason) => calls.mission.push("stage:" + reason),
    resume: () => (o.resume ? { notice: "продолжаю миссию с места остановки", phase: "active" } : null),
    autoStart: () => calls.mission.push("autoStart"),
    pause: () => { calls.mission.push("pause"); return { text: "⏸ Пауза. Работа сохранена." }; },
    emitState: (s) => calls.mission.push("state:" + s),
    alive: () => true,
    canAutoContinue: () => false,
    recordError: () => calls.mission.push("recordError"),
    trackProgress: () => calls.mission.push("trackProgress"),
  };
  const tools = {
    router: { id: "router" },
    state: { active: [], weight: 10, systemWeight: 5, histBudget: 1000 },
    refresh: () => {},
    histBudgetAfterOverflow: () => 400,
    ensureGroupsFor: () => {},
  };
  const ctxManager = {
    manage: async (msgs) => { calls.manages.push(msgs.length); return msgs; },
    compactions: () => 0,
  };

  const deps = {
    Notification,
    PARALLEL_SAFE_TOOLS: new Set(["readFile"]),
    PLAN_MODE_TOOL_DEFINITIONS: [{ function: { name: "todoWrite" } }],
    SYSTEM_PROMPT: "СИСТЕМА",
    UNAVAILABLE_MAX: 2,
    agentStore: { tasksBrief: (ud, n) => { calls.brief.push([ud, n]); return "- Позвонить в банк"; } },
    agentWorkDir: () => "/work/проект",
    audit: { record: () => {} },
    autoCheckpointCommit: async () => { calls.commits++; return { committed: true, message: "💾 Авто-коммит агента: тест" }; },
    auxConfig: () => ({ enabled: !!o.vision, auto: true, visionModel: "v", url: "http://v" }),
    buildChatRequest: () => ({}),
    buildProjectBrief: () => "ВИЗИТКА ПРОЕКТА",
    classifyKeyError: () => ({ key: true, cooldownMs: 1000 }),
    coldCacheInfo: () => "холодный пул",
    consumeProviderStream: async () => {},
    contextBudget: () => 100000,
    createContextManager: () => ctxManager,
    createRunBatch: () => ({ askForReport: () => false, afterRound: async () => o.afterRound || ({ kind: "break" }) }),
    createRunCalls: () => ({
      fromText: () => {},
      normalize: (c) => (o.dropCalls ? [] : c),
      recordAssistant: () => {},
      canRunParallel: (c) => !!o.parallel && c.length > 0,
      runParallel: async (c) => { calls.parallel += c.length; },
    }),
    // Контекст прогона (src/run-context.js): работа, переживающая остановку.
    // Здесь — заглушка (настоящий модуль пишет файлы), но она повторяет его
    // договор: решение о продолжении ДО сборки запроса, фиксация по ходу,
    // закрытие только на обычном финале.
    createRunContext: (d) => {
      calls.ctxDeps = d;
      return {
        plan: (h) => {
          calls.ctxPlanned.push(h.length);
          return o.resumeCtx ? { resumed: true, history: h.concat(o.resumeCtx), notice: "▶ Продолжаю с места остановки" } : { resumed: false, history: h };
        },
        save: (h) => { calls.ctxSaves.push(h.length); },
        close: () => { calls.ctxClosed++; },
      };
    },
    // Ожидание ответа человека (src/ask-wait.js): заглушка повторяет договор
    // модуля — вопрос уходит с вариантами, ответ приходит один раз, конец
    // прогона снимает ожидание.
    createAskWait: (d) => {
      calls.askDeps = d;
      return {
        askUserWait: (q, opts) => {
          calls.asks.push({ q: q, opts: opts || [] });
          return Promise.resolve(o.answer === undefined ? "Да" : o.answer);
        },
        cancel: () => { calls.askCancels++; return true; },
      };
    },
    createRunMission: () => mission,
    createRunNudge: (d) => { calls.nudgeDeps = d; return { decide: () => ({ action: "none" }) }; },
    createRunRetry: (d) => {
      calls.retryDeps = d;
      calls.retryObj = { state: { includeUsage: o.includeUsage === undefined ? true : o.includeUsage } };
      return calls.retryObj;
    },
    createRunRound: () => ({
      run: async (a) => {
        // Снимок, а не ссылка: прогон подставляет сводку состояния и снимает её
        // после раунда ИЗ ТОГО ЖЕ массива — по ссылке проверка увидела бы пустоту.
        calls.rounds.push({ n: a.n, maxRounds: a.maxRounds, messages: a.messages.slice() });
        const step = queue.length ? queue.shift() : (o.defaultStep || { text: "Готово." });
        if (step.onRun) step.onRun();
        if (step.error) throw step.error;
        if (step.repeat) return { kind: "repeat" };
        return { kind: "ok", toolCalls: step.toolCalls || [], text: step.text === undefined ? "Готово." : step.text };
      },
    }),
    createRunStrict: () => ({
      runStrict: async (c, d) => {
        calls.strict.push(c.length);
        // История, которую получают инструменты, — та же, что сохранится: ею же
        // проверяется, что сводка в неё не осела (см. проверку про сводку ниже).
        calls.histories.push(d && d.history);
      },
    }),
    createRunTools: (d) => { calls.toolsDeps = d; return tools; },
    createThinkingStripper: () => (s) => s,
    describeImageRemote: async () => "описание",
    describeToolArgs: () => "",
    estimateTokens: (s) => String(s || "").length,
    executeTool: async () => "ок",
    extractToolCallsFromText: () => [],
    fmtError: (e) => String((e && e.message) || e),
    friendlyRateLimitError: () => "",
    genCallId: () => "id1",
    groupOfTool: () => "",
    guideReadText: () => "",
    isLocalEndpoint: () => !!o.local,
    missionGuard: {},
    missionStore: {},
    modelWindow: async () => (o.modelWin === undefined ? 32000 : o.modelWin),
    normalizeToolName: (n) => n,
    ollamaModelInfo: async () => ({ known: true, tools: true }),
    ollamaNumCtx: () => 0,
    persistUndo: () => {},
    rateLimitInfo: () => "",
    rateLimiterFor: () => ({ take: async () => {} }),
    readApiError: () => "",
    resolvePath: (p) => p,
    rolePlan: (id) => ({ id: id || "developer", prompt: "РОЛЬ: " + (id || "developer") }),
    routeTools: () => [],
    routerMaxTokens: 100,
    routerTaskText: () => "",
    sanitizeToolPairs: (m) => m,
    saveContextMemo: () => null,
    saveSettings: () => { calls.saves++; },
    snapshotFileForUndo: () => {},
    switchOpenaiProfile: () => { calls.switched++; return { id: "p2", name: "Второй" }; },
    termEmit: (ev) => calls.metrics.push(ev),
    toolPolicy: {},
    toolsAsText: () => "",
    truncateText: (s) => s,
    // Папка дел — своя (часть 44): сводка берётся в папке дел, а не в папке приложения.
    tasksDataDir: () => "/tasks",
    windowBudget: (p, b, w, opts) => { calls.windowBudget = { b, w, opts }; return o.windowed === undefined ? w : o.windowed; },
    live: live,
  };
  const { runAi } = createRunAi(deps);
  const settings = Object.assign(
    { model: "test-model", provider: "openai", autoSwitchProfiles: true, agentAutoCommit: true },
    o.settings || {}
  );
  const set = (m) => { m.win = win; m.live = live; m.settings = settings; m.calls = calls; return m; };
  return set({ runAi, calls, live, win, settings, deps, mission });
}

const run = (m, opts) => m.runAi(m.settings, [{ role: "user", content: "привет" }], m.win, opts || {});
const systemOf = (m) => String((m.calls.rounds[0] || {}).messages && (m.calls.rounds[0].messages[0] || {}).content || "");

(async () => {
  await test("без модели прогон честно отказывает и подсказывает, что делать", async () => {
    const m = mk({ settings: { model: "" } });
    await assert.rejects(() => run(m), /Не выбрана модель.*Настройки/s);
    assert.strictEqual(m.calls.rounds.length, 0, "запрос ушёл без модели");
  });

  await test("системное сообщение собирает роль, рабочую папку и визитку проекта", async () => {
    const m = mk();
    await run(m, { role: "manager" });
    const sys = systemOf(m);
    assert.ok(sys.indexOf("СИСТЕМА") === 0, "системный промпт не первый");
    assert.ok(/РОЛЬ: manager/.test(sys), "текст роли не доехал: " + sys.slice(0, 80));
    assert.ok(/Рабочая директория приложения.*\/work\/проект/s.test(sys), "рабочая папка не сказана");
    assert.ok(/САММАРИ ПРОЕКТА.*ВИЗИТКА ПРОЕКТА/s.test(sys), "визитка проекта потерялась");
    assert.deepStrictEqual(m.calls.brief[0], ["/tasks", 8], "сводка дел не взята у хранилища");
    assert.ok(/МОИ ДЕЛА.*Позвонить в банк/s.test(sys), "менеджер не получил свежую сводку дел");
  });

  await test("рабочий репозиторий назван, если он не совпал с рабочей папкой", async () => {
    const same = mk({ lastAgentRepoDir: "/work/проект" });
    await run(same);
    assert.ok(!/Активный репозиторий/.test(systemOf(same)), "лишняя строка про тот же путь");
    const other = mk({ lastAgentRepoDir: "/work/клон" });
    await run(other);
    assert.ok(/Активный репозиторий: \/work\/клон/.test(systemOf(other)), "подменённый репозиторий не назван");
  });

  await test("толчок после клона уходит один раз и снимает флаг", async () => {
    const m = mk({ clonedRepoPending: true });
    await run(m);
    assert.ok(/только что склонирован/.test(systemOf(m)), "агент не получил толчок после клона");
    assert.strictEqual(m.live.clonedRepoPending, false, "флаг клона не снят — толчок будет каждый раз");
  });

  await test("режим плана: три раунда и требование плана вместо работы", async () => {
    const m = mk();
    await run(m, { plan: true });
    assert.ok(/РЕЖИМ ПЛАНА/.test(systemOf(m)), "в промпте нет режима плана");
    assert.strictEqual(m.calls.rounds[0].maxRounds, 3, "лимит раундов в плане не 3: " + m.calls.rounds[0].maxRounds);
  });

  await test("модель без инструментов: предупреждение и в консоль, и в чат", async () => {
    const m = mk({ settings: { noToolsModel: true } });
    await run(m);
    const notices = m.calls.events.filter((e) => e.ev && e.ev.type === "notice");
    assert.strictEqual(notices.length, 1, "человеку не сказано про текстовый протокол");
    assert.ok(/без поддержки инструментов/.test(notices[0].ev.text), notices[0].ev.text);
    assert.ok(m.calls.metrics.some((x) => x.type === "metrics" && /инструментов/.test(x.text)), "в консоль не ушло объяснение");
  });

  await test("окно модели управляет бюджетом, а нижний предел не выше окна", async () => {
    const m = mk({ modelWin: 4096 });
    await run(m);
    assert.ok(m.calls.windowBudget, "окно модели не учтено в бюджете");
    assert.strictEqual(m.calls.windowBudget.w, 4096, "в расчёт ушло не окно модели");
    const tiny = mk({ modelWin: 2048, windowed: 2048 });
    await run(tiny);
    assert.strictEqual(tiny.calls.toolsDeps.getBudget(), 2048, "бюджет поднят выше реального окна 2048");
  });

  await test("пустой ответ модели объясняется, а не оставляет пустоту", async () => {
    const m = mk({ rounds: [{ text: "" }] });
    const r = await run(m);
    assert.ok(r.ok === true && /Модель не прислала итоговый текст/.test(r.text), "пустой ответ не объяснён: " + r.text);
    assert.ok(m.calls.events.some((e) => e.ev && e.ev.type === "done"), "прогон не закрыт событием done");
  });

  await test("остановка «Стоп»: объяснение, журнал отката и ни одного лишнего раунда", async () => {
    const mkStop = (text) => mk({
      parallel: true,
      rounds: [{
        text: text,
        toolCalls: [{ name: "readFile", args: {} }],
        onRun: () => {
          // Журнал правок наполняет строгая очередь (snapshotFileForUndo) — здесь его роль играет этот ход.
          mCase.live.activeRunUndo.push({ file: "a.js" });
          global.__agentStopRequested = true;
        },
      }],
    });
    let mCase = mkStop("");
    try {
      const r = await run(mCase);
      assert.ok(/Остановлено пользователем/.test(r.text), "остановка без объяснения: " + r.text);
      assert.deepStrictEqual(mCase.live.lastUndoLog, [{ file: "a.js" }], "журнал отката не записан в оболочку");
      assert.ok(mCase.calls.events.some((e) => e.ev && e.ev.type === "undo_available" && e.ev.count === 1), "окно не узнало про откат");
      assert.strictEqual(mCase.calls.rounds.length, 1, "после «Стоп» начался новый раунд");
      assert.ok(mCase.calls.events.some((e) => e.ev && e.ev.type === "done"), "остановка не закрыла прогон событием done");
      // Отрезок работы закрыт: следующий запуск увидит, на чём именно встали.
      assert.ok(mCase.calls.mission.some((x) => x === "stage:остановка человеком"), "остановка не закрыла этап работы: " + JSON.stringify(mCase.calls.mission));
      // Модель успела сказать полуслово — его НЕ затираем: человек видит и текст, и что работа прервана.
      global.__agentStopRequested = false; // новый прогон — новая кнопка
      mCase = mkStop("Начал читать файл");
      const said = await run(mCase);
      assert.strictEqual(said.text, "Начал читать файл", "сказанное моделью затёрто при остановке: " + said.text);
    } finally {
      global.__agentStopRequested = false;
    }
  });

  await test("пауза по кнопке: миссия погашена, флаг снят, журнал — копия", async () => {
    global.__agentPauseRequested = true;
    try {
      const m = mk();
      const r = await run(m);
      assert.ok(/Пауза/.test(r.text), "пауза не объяснена: " + r.text);
      assert.ok(m.calls.mission.includes("pause"), "миссия не погашена");
      assert.ok(m.calls.mission.includes("state:paused"), "состояние паузы не отправлено");
      assert.strictEqual(global.__agentPauseRequested, false, "флаг паузы не снят — прогон не перезапустится");
      assert.ok(m.calls.events.some((e) => e.ev && e.ev.type === "done"), "пауза не закрыла прогон событием done");
      assert.notStrictEqual(m.live.lastUndoLog, m.live.activeRunUndo, "журнал отдан ссылкой — показ отката поедет следом за прогоном");
    } finally {
      global.__agentPauseRequested = false;
    }
  });

  await test("пауза между раундами не теряет журнал правок", async () => {
    const m = mk({
      parallel: true,
      rounds: [{
        text: "работаю",
        toolCalls: [{ name: "readFile", args: {} }],
        onRun: () => {
          m.live.activeRunUndo.push({ file: "b.js" });
          global.__agentPauseRequested = true;
        },
      }],
    });
    try {
      const r = await run(m);
      assert.ok(/Пауза/.test(r.text), "пауза не объяснена: " + r.text);
      assert.deepStrictEqual(m.live.lastUndoLog, [{ file: "b.js" }], "правки раунда потерялись при паузе");
    } finally {
      global.__agentPauseRequested = false;
    }
  });

  await test("повтор раунда не тратит ни номер раунда, ни раунд миссии", async () => {
    const m = mk({ rounds: [{ repeat: true }] });
    await run(m);
    assert.deepStrictEqual(m.calls.rounds.map((r) => r.n), [0, 0], "повтор занял новый номер раунда");
    // Счётчик миссии ведёт сам прогон (mission.state.rounds++): лимиты миссии и
    // порог авто-миссии считаются по нему, и повтор не имеет права их ускорять.
    assert.strictEqual(m.mission.state.rounds, 1, "повтор потратил раунд миссии: " + m.mission.state.rounds);
    const plain = mk();
    await run(plain);
    assert.strictEqual(plain.mission.state.rounds, 1, "обычный раунд не засчитан миссии");
  });

  await test("вызовы раунда: пачкой только read-only, иначе строгая очередь", async () => {
    const par = mk({ parallel: true, rounds: [{ text: "читаю", toolCalls: [{ name: "readFile", args: {} }] }] });
    await run(par);
    assert.strictEqual(par.calls.parallel, 1, "read-only вызовы не ушли пачкой");
    assert.strictEqual(par.calls.strict.length, 0, "пачка ушла и в строгую очередь тоже");
    const seq = mk({ rounds: [{ text: "пишу", toolCalls: [{ name: "writeFile", args: {} }] }] });
    await run(seq);
    assert.deepStrictEqual(seq.calls.strict, [1], "опасный вызов не пошёл через строгую очередь");
  });

  await test("все вызовы раунда оказались дублями: финал без пустых tool_calls", async () => {
    // Модель повторила уже выполненный вызов: отправь мы его снова, провайдер получил бы
    // assistant с tool_calls без ответа — 400. Поэтому прогон заканчивает работу сам.
    const m = mk({ dropCalls: true, rounds: [{ text: "", toolCalls: [{ name: "readFile", args: {} }] }] });
    const r = await run(m);
    assert.strictEqual(r.ok, true, "прогон не завершился на дублях вызовов");
    assert.strictEqual(r.text, "Готово.", "финал на дублях вызовов пустой: " + r.text);
    assert.ok(m.calls.events.some((e) => e.ev && e.ev.type === "done"), "прогон не закрыт событием done");
    assert.strictEqual(m.calls.strict.length + m.calls.parallel, 0, "дубль-вызов всё-таки выполнен");
    assert.strictEqual(m.calls.rounds.length, 1, "после дублей начался новый раунд");
  });

  await test("сбой прогона: два авто-повтора с примечанием и переключение подключения", async () => {
    const err = new Error("401 кончились средства");
    const m = mk({ rounds: [{ error: err }, { error: err }, { error: err }] });
    await assert.rejects(() => run(m), /401 кончились средства/);
    const retries = m.calls.events.filter((e) => e.ev && e.ev.type === "retry");
    assert.strictEqual(retries.length, 2, "авто-повторов не два, а " + retries.length);
    assert.strictEqual(retries[0].ev.total, 3, "человеку сказано неверное число попыток");
    // Каждая упавшая попытка переключает ключ на следующее сохранённое подключение
    // и сохраняет выбор — иначе два повтора шли бы тем же мёртвым ключом.
    assert.strictEqual(m.calls.switched, 2, "переключений подключения не по числу попыток: " + m.calls.switched);
    assert.strictEqual(m.calls.saves, 2, "выбранное подключение не сохранено");
    assert.ok(m.calls.events.some((e) => e.ev && e.ev.type === "profile_switched"), "окно не узнало о переключении");
    assert.ok(/переключено на подключение/.test(retries[0].ev.error), "в тексте повтора нет нового подключения: " + retries[0].ev.error);
    const last = m.calls.rounds[m.calls.rounds.length - 1];
    assert.ok(/ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА/.test(JSON.stringify(last.messages)), "повтор идёт без примечания о сбое");
    assert.strictEqual(m.calls.rounds.length, 3, "попыток не три: " + m.calls.rounds.length);
  });

  await test("прерывание запроса не повторяется: это остановка человека, а не сбой сети", async () => {
    const abortErr = Object.assign(new Error("Прервано"), { name: "AbortError" });
    const m = mk({ rounds: [{ error: abortErr }, { error: abortErr }, { error: abortErr }] });
    await assert.rejects(() => run(m), /Прервано/);
    assert.strictEqual(m.calls.rounds.length, 1, "после прерывания запроса пошли новые попытки: " + m.calls.rounds.length);
    assert.strictEqual(m.calls.events.filter((e) => e.ev && e.ev.type === "retry").length, 0, "человеку показан бессмысленный авто-повтор");
    assert.strictEqual(m.calls.switched, 0, "на прерывании переключено подключение");
  });

  await test("фатальная ошибка (лимит раундов) не повторяется и не переключает ключ", async () => {
    const m = mk({ rounds: [], defaultStep: { text: "работаю", toolCalls: [{ name: "writeFile", args: {} }] } });
    await assert.rejects(() => run(m), /Превышено максимальное число раундов/);
    assert.strictEqual(m.calls.switched, 0, "ключ переключён на фатальной ошибке");
    assert.strictEqual(m.calls.rounds.length, 25, "лимит раундов не 25: " + m.calls.rounds.length);
  });

  await test("провайдер отверг stream_options — повтор идёт без метрик токенов", async () => {
    const err = new Error("stream_options is not supported");
    const m = mk({ rounds: [{ error: err }, { error: err }, { error: err }] });
    await assert.rejects(() => run(m));
    assert.strictEqual(m.calls.retryObj.state.includeUsage, false, "флаг метрик токенов не снят");
    assert.ok(/Провайдер отверг stream_options/.test(m.calls.metrics.map((x) => x.text).join(" ")), "в консоль не сказано про отказ");
  });

  await test("ужатие контекста считает от ФАКТИЧЕСКОГО размера запроса и пересобирает историю", async () => {
    const m = mk();
    await run(m);
    const before = m.calls.manages.length;
    assert.ok(m.calls.retryDeps && typeof m.calls.retryDeps.shrinkContext === "function", "ужатие не отдано модулю повторов");
    assert.ok(typeof m.calls.retryDeps.getBudget === "function", "бюджет не отдан функцией");
    const budget = m.calls.retryDeps.getBudget();
    const res = await m.calls.retryDeps.shrinkContext();
    assert.ok(m.calls.manages.length > before, "история не пересобрана при ужатии");
    assert.ok(res && typeof res.budget === "number" && typeof res.cost === "number",
      "ужатие не сообщило бюджет и размер запроса");
    assert.strictEqual(m.calls.retryDeps.getBudget(), res.budget, "бюджет прогона и отчёт ужатия расходятся");
    // Главное: шаг считается от того, сколько токенов уедет НА САМОМ ДЕЛЕ. Прежнее «×0,4
    // от бюджета» при неизвестном окне (400 000) давало 160 000 — история в них влезала,
    // запрос не менялся ни на токен, и второй отказ провайдера убивал прогон.
    assert.strictEqual(res.budget, Math.max(3000, Math.floor(Math.min(budget * 0.4, res.cost * 0.6))),
      "шаг ужатия не от фактического размера запроса: " + res.budget + " при бюджете " + budget + " и запросе ≈" + res.cost);
    assert.ok(res.budget < budget, "бюджет не срезан: " + res.budget + " при " + budget);
    assert.ok(res.cost > 0, "размер запроса не посчитан");
  });

  await test("авто-коммит: только когда были правки и не в режиме плана", async () => {
    const m = mk({ rounds: [{ text: "готово", onRun: () => m.live.activeRunUndo.push({ file: "a.js" }) }] });
    await run(m);
    assert.strictEqual(m.calls.commits, 1, "авто-коммит не сделан при правках");
    assert.ok(m.calls.events.some((e) => e.ev && e.ev.type === "checkpoint"), "человеку не сказано про точку возврата");
    const clean = mk();
    await run(clean);
    assert.strictEqual(clean.calls.commits, 0, "авто-коммит сделан без правок");
    const plan = mk({ rounds: [{ text: "план", onRun: () => plan.live.activeRunUndo.push({ file: "a.js" }) }] });
    await run(plan, { plan: true });
    assert.strictEqual(plan.calls.commits, 0, "авто-коммит сделан в режиме плана");
  });

  await test("уведомление о готовом ответе — только для неактивного окна", async () => {
    const away = mk({ focused: false });
    await run(away);
    assert.strictEqual(away.calls.notifies.length, 1, "нет уведомления, когда окно не в фокусе");
    assert.ok(/Ответ агента готов/.test(away.calls.notifies[0].title + " " + away.calls.notifies[0].body), "текст уведомления невнятный");
    const here = mk({ focused: true });
    await run(here);
    assert.strictEqual(here.calls.notifies.length, 0, "уведомление пришло при активном окне");
    const noChan = mk({ focused: false, notifySupported: false });
    await run(noChan);
    assert.strictEqual(noChan.calls.notifies.length, 0, "уведомление создано без канала");
    const noWin = mk({ focused: false, mainWindow: null });
    await run(noWin);
    assert.strictEqual(noWin.calls.notifies.length, 0, "уведомление без окна");
  });

  await test("живое состояние читается по имени: копия не застывает", async () => {
    const m = mk({ focused: false });
    await run(m);
    assert.strictEqual(m.calls.notifies.length, 1, "окно прочитано копией — уведомление ушло не туда");
    m.live.mainWindow = { isDestroyed: () => false, isFocused: () => true, webContents: { send: () => {} } };
    await run(m);
    assert.strictEqual(m.calls.notifies.length, 1, "второй прогон взял старое окно из копии");
    m.live.activePlanSummary = { total: 7 };
    assert.deepStrictEqual(m.calls.nudgeDeps.getPlanSummary(), { total: 7 }, "сводка плана отдана копией");
    assert.strictEqual(typeof m.calls.retryDeps.getBudget, "function", "бюджет отдан значением");
  });

  await test("миссия: продолжение объявлено один раз, конец работы отмечен", async () => {
    const m = mk({ resume: true });
    await run(m);
    const notices = m.calls.events.filter((e) => e.ev && e.ev.type === "notice" && /продолжаю миссию/.test(e.ev.text));
    assert.strictEqual(notices.length, 1, "«продолжаю миссию» сказано не один раз: " + notices.length);
    assert.ok(m.calls.mission.includes("state:active"), "состояние миссии не объявлено окну");
    assert.ok(m.calls.mission.includes("state:end"), "конец работы не отмечен в миссии");
  });

  await test("сводка состояния работы идёт в каждый запрос и в историю не попадает", async () => {
    // Сводка собирается приложением из файлов миссии и подставляется перед запросом:
    // именно она говорит модели после границы батча, что она уже начала делать.
    const digest = { role: "system", content: "СОСТОЯНИЕ РАБОТЫ (тест)" };
    const m = mk({
      digest: digest,
      rounds: [
        { text: "шаг 1", toolCalls: [{ name: "writeFile", args: { path: "a.txt", content: "1" } }] },
        { text: "Финал." },
      ],
    });
    await run(m);
    assert.strictEqual(m.calls.rounds.length, 2, "раундов прошло не два: " + m.calls.rounds.length);
    for (const r of m.calls.rounds) {
      assert.strictEqual(r.messages[1], digest, "сводки нет вторым сообщением в раунде " + (r.n + 1));
      assert.strictEqual(r.messages.filter((x) => x === digest).length, 1, "сводка продублирована в раунде " + (r.n + 1));
    }
    // Индикатор контекста считается ПОСЛЕ подстановки: иначе он врал бы про занятое место.
    const ctx = m.calls.events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === "context");
    assert.ok(ctx.length > 0, "индикатор контекста не пришёл");
    // Инструментам уходит история БЕЗ сводки — иначе она сохранялась бы в чат и множилась.
    assert.ok(m.calls.histories.length > 0, "история ни разу не дошла до инструментов");
    for (const h of m.calls.histories) {
      assert.ok(Array.isArray(h) && h.indexOf(digest) < 0, "сводка осталась в истории, которая сохраняется");
    }
    // Без миссии сводки нет вовсе: подставлять нечего.
    const quiet = mk({ rounds: [{ text: "Финал." }] });
    await run(quiet);
    assert.strictEqual(quiet.calls.rounds[0].messages.indexOf(digest), -1, "сводка подставилась без миссии");
    assert.strictEqual(quiet.calls.rounds[0].messages.length, 2, "в запрос ушло лишнее сообщение: " + quiet.calls.rounds[0].messages.length);
  });

  await test("контекст прогона: оставленная работа возвращается в запрос, а не ищется заново", async () => {
    // Жалоба человека: после паузы агент заново выясняет, чем занимался. Прогон
    // обязан СПРОСИТЬ модуль о работе ДО сборки запроса и вернуть её целиком —
    // вместе с вызовами и их результатами: без tool_call_id разбор пар выбрасывает
    // результат как осиротевший, и продолжение снова пустое.
    const left = [
      { role: "assistant", content: "читаю файл", tool_calls: [{ id: "c1", type: "function", function: { name: "readFile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "СОДЕРЖИМОЕ ФАЙЛА (тест)" },
    ];
    const m = mk({ resumeCtx: left });
    await run(m);
    const sent = m.calls.rounds[0].messages;
    assert.ok(sent.some((x) => x && x.tool_call_id === "c1"), "результат прошлого шага не вернулся в запрос");
    assert.ok(sent.some((x) => x && x.tool_calls), "вызовы инструментов потеряны при сборке истории");
    assert.ok(sent.some((x) => x && /СОДЕРЖИМОЕ ФАЙЛА/.test(String(x.content))), "содержимое прошлого шага не дошло до модели");
    const notices = m.calls.events.filter((e) => e.ev && e.ev.type === "notice").map((e) => String(e.ev.text));
    assert.ok(notices.some((t) => /Продолжаю с места остановки/.test(t)), "человеку не сказали, что работа возвращена");
    // Работа фиксируется по ходу: обрыв на ответе модели не должен её терять.
    assert.ok(m.calls.ctxSaves.length >= 2, "работа не фиксируется по ходу прогона: " + m.calls.ctxSaves.length);
    // Проводка: рабочая папка — ФУНКЦИЕЙ (её меняет клонирование и смена проекта),
    // чат прогона — из живого значения, разбор пар — живой.
    assert.strictEqual(typeof m.calls.ctxDeps.dir, "function", "рабочая папка передана копией: чекпоинт лёг бы в прежний проект");
    assert.strictEqual(m.calls.ctxDeps.dir(), "/work/проект", "функция отдаёт не рабочую папку прогона");
    assert.strictEqual(m.calls.ctxDeps.id, "chat-1", "чат прогона не взят из живого значения");
    assert.strictEqual(typeof m.calls.ctxDeps.sanitizeToolPairs, "function", "разбор пар не передан модулю");
    // Решение принято ДО того, как история поехала в запрос.
    assert.deepStrictEqual(m.calls.ctxPlanned, [1], "история спрошена не один раз или не та: " + JSON.stringify(m.calls.ctxPlanned));
  });

  await test("сданная работа чекпоинт закрывает, пауза — оставляет", async () => {
    // Обычный финал: работа доведена, возвращать нечего — иначе агент «продолжал» бы
    // то, что уже сделано. Пауза — наоборот: человек нажмёт «Продолжить».
    const done = mk();
    await run(done);
    assert.strictEqual(done.calls.ctxClosed, 1, "обычный финал не закрыл чекпоинт: " + done.calls.ctxClosed);
    global.__agentPauseRequested = true;
    try {
      const paused = mk();
      await run(paused);
      assert.strictEqual(paused.calls.ctxClosed, 0, "пауза закрыла чекпоинт — продолжение потеряло бы работу");
      assert.ok(paused.calls.ctxSaves.length >= 1, "пауза не оставила работу на диске");
    } finally {
      global.__agentPauseRequested = false;
    }
  });

  await test("ожидание ответа: прогон зовёт модуль и снимает ожидание на финале", async () => {
    // Тихая ошибка была бы такой: вопрос задан, а прогон идёт дальше. Здесь видно,
    // что модуль ожидания собирается прогоном на ЖИВОМ состоянии окна (иначе ответ
    // человека некуда приносить) и что финал снимает ожидание.
    const m = mk();
    await run(m);
    assert.ok(m.calls.askDeps, "прогон не собрал ожидание ответа");
    assert.strictEqual(typeof m.calls.askDeps.emit, "function", "ожиданию не передан вывод событий");
    assert.strictEqual(m.calls.askDeps.live, m.live, "ожидание получило копию живого состояния: ответ не дошёл бы");
    assert.strictEqual(m.calls.askCancels, 1, "финал не снял ожидание ответа: " + m.calls.askCancels);
  });

  await test("кнопка «Продолжить»: остановка с сохранённой работой — событие resume", async () => {
    // Прерывание чтения потока «Стопом» приходит как AbortError — так его отдаёт
    // транспорт (src/renderer/provider-transport.js): это и есть остановка человека.
    const abortError = () => {
      const e = new Error("Прерывание запроса: остановлено человеком");
      e.name = "AbortError";
      return e;
    };
    // Обычный финал: возвращаться некуда — кнопка гореть не должна.
    const done = mk();
    await run(done);
    assert.ok(!done.calls.events.some((e) => e.ev && e.ev.type === "resume"), "обычный финал зажёг кнопку «Продолжить»");

    // «Стоп»: работа лежит на диске, чекпоинт открыт — кнопка нужна, и признак идёт
    // ДО «done»: окно показывает её вместе с завершением ответа, а не после.
    const mkStop = () => mk({
      parallel: true,
      rounds: [{
        text: "работаю",
        toolCalls: [{ name: "readFile", args: {} }],
        onRun: () => { global.__agentStopRequested = true; },
      }],
    });
    try {
      const stopped = mkStop();
      await run(stopped);
      const types = stopped.calls.events
        .filter((e) => e.ev && (e.ev.type === "resume" || e.ev.type === "done"))
        .map((e) => e.ev.type);
      assert.deepStrictEqual(types, ["resume", "done"], "«Стоп» не зажёг кнопку продолжения или порядок событий другой: " + JSON.stringify(types));
      const reason = stopped.calls.events.find((e) => e.ev && e.ev.type === "resume").ev.reason;
      assert.ok(/остановлено пользователем/.test(reason), "у кнопки нет причины остановки: " + reason);
    } finally {
      global.__agentStopRequested = false;
    }

    // «Стоп» ПОСРЕДИ запроса: транспорт прерывает чтение, и это по-прежнему
    // остановка человека — мягкая, с сохранённой работой и кнопкой продолжения.
    // Раньше здесь человек видел ошибку «⏹ Генерация остановлена» и продолжал руками.
    try {
      global.__agentStopRequested = true;
      const midStop = mk({ parallel: true, rounds: [{ error: abortError() }] });
      await run(midStop);
      const midTypes = midStop.calls.events
        .filter((e) => e.ev && (e.ev.type === "resume" || e.ev.type === "done"))
        .map((e) => e.ev.type);
      assert.deepStrictEqual(midTypes, ["resume", "done"], "«Стоп» посреди запроса не завершился мягко: " + JSON.stringify(midTypes));
      assert.ok(!midStop.calls.events.some((e) => e.ev && e.ev.type === "error"), "остановка человека ушла в чат ошибкой");
      assert.ok(midStop.calls.mission.some((s) => /stage:остановка человеком/.test(s)), "отрезок работы не закрыт причиной остановки: " + JSON.stringify(midStop.calls.mission));
    } finally {
      global.__agentStopRequested = false;
    }
    // Обратная сторона: прерывание БЕЗ остановки человека (закрытие приложения,
    // сбой транспорта) остаётся сбоем прогона — кнопка не горит зря.
    const lost = mk({ parallel: true, rounds: [{ error: abortError() }] });
    await assert.rejects(() => run(lost), (e) => e && e.name === "AbortError", "прерывание без остановки перестало быть сбоем");
    assert.ok(!lost.calls.events.some((e) => e.ev && e.ev.type === "resume"), "сбой транспорта зажёг кнопку продолжения");

    // Пауза миссии по кнопке — то же самое.
    global.__agentPauseRequested = true;
    try {
      const paused = mk();
      await run(paused);
      assert.ok(paused.calls.events.some((e) => e.ev && e.ev.type === "resume" && /пауза/.test(e.ev.reason)),
        "пауза не зажгла кнопку продолжения");
    } finally {
      global.__agentPauseRequested = false;
    }

    // Лимит раундов: прогон падает фатальным отказом — человек видит кнопку, а не
    // только текст «напиши продолжай» руками.
    const limited = mk({ parallel: true, rounds: [], defaultStep: { toolCalls: [{ name: "readFile", args: {} }], text: "" } });
    await assert.rejects(() => run(limited), /Превышено максимальное число раундов/);
    assert.ok(limited.calls.events.some((e) => e.ev && e.ev.type === "resume" && /лимит раундов/.test(e.ev.reason)),
      "лимит раундов не зажёг кнопку продолжения");
  });

  await test("кнопка «Продолжить»: закрытая миссия её не показывает, мягкая остановка — показывает", async () => {
    // Мягкая остановка миссии (лимит/время/цикл) приходит решением батча с признаком
    // resume: продолжать есть что, и чекпоинт остаётся открытым.
    const work = { toolCalls: [{ name: "readFile", args: {} }], text: "работаю" };
    const stop = mk({ parallel: true, rounds: [], defaultStep: work, afterRound: { kind: "end", message: "⏹ Миссия отработала лимит раундов.", resume: true } });
    await run(stop);
    assert.ok(stop.calls.events.some((e) => e.ev && e.ev.type === "resume" && /остановлена/.test(e.ev.reason)), "мягкая остановка миссии не зажгла кнопку");
    assert.strictEqual(stop.calls.ctxClosed, 0, "мягкая остановка закрыла чекпоинт — продолжение потеряло бы работу");

    // Закрытая миссия — работа доведена: кнопка не показывается (resume: false).
    const closed = mk({
      parallel: true,
      rounds: [],
      defaultStep: work,
      afterRound: { kind: "end", message: "🏁 Работа закончена — миссия закрыта.", resume: false },
    });
    await run(closed);
    assert.ok(!closed.calls.events.some((e) => e.ev && e.ev.type === "resume"), "закрытая миссия зажгла кнопку «Продолжить»");
  });

  await test("в оболочке этого больше нет, а мост к живому состоянию на месте", () => {
    for (const gone of ["async function runAi(", "const AUTO_RETRY_LIMIT = 2;", "const endRun = async (fallbackText)",
      "const shrinkContext = async () =>", "const stopGraceful = () =>", "for (let round = 0; round < maxRounds; round++)"]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js остался кусок прогона: " + gone);
    }
    const wiring = /const \{ createRunAi \} = require\("\.\/run-ai\.js"\);[\s\S]*?\n\}\);/.exec(MAIN_SRC);
    assert.ok(wiring, "не нашёл проводку прогона");
    for (const dep of ["  createRunRound,", "  createRunMission,", "  createRunContext,", "  executeTool:", "  SYSTEM_PROMPT,", "  live: {"]) {
      assert.ok(wiring[0].includes(dep), "в проводку не передано: " + dep.trim());
    }
    // Живое состояние оболочки держится сеттерами: часть его пишет и прогон.
    for (const pair of ["set activeAbort", "set activeEmit", "set activeRunUndo", "set lastUndoLog",
      "set pendingAsk", "set clonedRepoPending", "set missionClaim", "set missionId"]) {
      assert.ok(wiring[0].includes(pair + "(v)"), "мост без сеттера: " + pair);
    }
    // Панель терминала собирается ниже — значит, передавать её можно только отложенно.
    assert.ok(/termEmit: \(\.\.\.termArgs\) => termEmit\(\.\.\.termArgs\)/.test(MAIN_SRC), "termEmit передан значением до объявления");
    assert.ok(MAIN_SRC.includes("executeTool: (...toolArgs) => executeTool(...toolArgs)"), "executeTool передан значением до сборки реестра");
    // Модуль ничего не достаёт сам: ни путей, ни require.
    assert.ok(!/app\.getPath|__dirname|require\(/.test(MODULE_SRC), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(!/^let |^var /m.test(MODULE_SRC), "в модуле завелось состояние уровня файла");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

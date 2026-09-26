"use strict";

/* ─── Роутер инструментов прогона: какие схемы уходят и какие справочники едут ──
   Вынесено из main.js (этап B, часть 15 — второй заход в ядро чата runAi).

   Вместо «все схемы в каждом раунде» прогон шлёт базу + группы, нужные этой
   задаче (routeTools из ядра). Здесь живёт всё, что делает эту экономию
   безопасной:

     • состав ЛИПКИЙ: группа, однажды включённая, не исчезает на середине работы.
       Иначе набор схем меняется на ходу, префикс запроса ломается и провайдер
       отвечает 503 cache_only_cold (это уже случалось, см. 1.5.46 и 1.5.63);
     • задача для роутера берётся из ИСТОРИИ работы, а не из последней фразы: в
       «продолжай» ключевых слов нет вовсе, и группа прошлой задачи выпадала;
     • предохранитель: если модель позвала инструмент, которого нет в текущем
       наборе, его группа включается на лету, а в «Консоль» уходит честный
       результат («включил» или «включил, но схемы не влезают в окно»);
     • вес того, что РЕАЛЬНО уйдёт в запрос, — основа бюджета истории: посчитать
       схемы как JSON, когда они не отправляются, значит сжимать историю раньше
       времени и зря пугать человека тесным окном;
     • справочник группы (browser/system/app/yc) подключается сам ровно тогда,
       когда группа активна: длинные правила не занимают промпт зря.

   Ошибки тут тихие и дорогие: выпавшая группа — исчезнувший инструмент; не
   подключённый справочник — работа по памяти; неверный вес — молчаливое «тупеет».

   Живые значения: бюджет приходит ФУНКЦИЕЙ (при переполнении контекста он
   пересчитывается, и вес схем обязан считаться по новому), а состояние прогона —
   один объект `state`, который оболочка читает напрямую. */

function createRunTools(deps) {
  const {
    settings,
    planMode,
    messages,
    role,
    noTools,
    emit,
    termEmit,
    getBudget,
    systemPrompt,
    // Функции ядра приходят именами, как их зовёт оболочка: модуль в ядро не лезет.
    routeTools,
    routerMaxTokens,
    routerTaskText,
    estimateTokens,
    toolsAsText,
    guideReadText,
    groupOfTool,
    PLAN_MODE_TOOL_DEFINITIONS,
  } = deps;

  // Вес системного промпта (~8k токенов) — раньше в бюджет не входил, поэтому индикатор
  // контекста занижал заполнение и сжатие срабатывало позже, чем нужно.
  const systemWeight = estimateTokens(systemPrompt);

  const state = {
    active: [], // схемы, которые реально уйдут в запрос
    weight: 0, // их вес в токенах
    histBudget: 1500, // сколько оставлено истории (её держит контекст-менеджер)
    guidesWeight: 0, // вес справочников группы: они едут в КАЖДЫЙ запрос
    route: null, // последний результат routeTools (метрики + предохранители)
    guideNotes: [], // system-сообщения со справочниками (стабильный префикс)
    systemWeight: systemWeight,
    sticky: new Set(), // id групп, включённых в этой задаче
    injected: new Set(), // справочники, уже подключённые в этой задаче
    warned: false, // о тесном окне предупреждаем один раз за прогон
  };
  // Роутер видит не одну последнюю фразу, а историю работы (см. 1.5.63).
  const routerTask = routerTaskText(messages);
  // Группа → справочник агента: подключается сам, когда группа активна. Так «диета»
  // промпта ничего не теряет: длинные правила живут в гайдах и приходят ровно тогда,
  // когда нужны (браузер, система, окно приложения, облако).
  const GROUP_GUIDES = { browser: "browser", system: "system", app: "app", cloud: "yc" };
  const forceAllTools = !!settings.sendAllTools; // предохранитель C: «отправлять все инструменты»

  const refresh = () => {
    const budget = getBudget();
    if (planMode) {
      state.route = null;
      state.active = PLAN_MODE_TOOL_DEFINITIONS;
    } else {
      const baseWeight = routeTools({ text: "" }).tokens;
      // Потолок схем: не больше ROUTER_MAX_TOKENS и не больше того, что реально остаётся
      // от окна после системного промпта и минимальной истории. Сама формула живёт в
      // ядре (routerMaxTokens) — здесь только вызов.
      const maxTokens = routerMaxTokens(budget, systemWeight, baseWeight);
      state.route = routeTools({ text: routerTask, sticky: [...state.sticky], roleGroups: role.groups, forceAll: forceAllTools, maxTokens: maxTokens });
      for (const id of state.route.groups) state.sticky.add(id);
      state.active = state.route.tools;
    }
    // Вес того, что РЕАЛЬНО уйдёт в запрос. Без поддержки инструментов схемы не
    // отправляются — вместо них текстовый каталог, и он вчетверо легче: считать по JSON
    // значило бы сжимать историю раньше времени и зря пугать тесным окном.
    state.weight = state.active.length
      ? estimateTokens(noTools ? toolsAsText(state.active) : JSON.stringify(state.active))
      : 0;
    // Тесное окно: схемы + промпт уже занимают почти всё. Честно говорим об этом
    // один раз — иначе агент «тупеет» без объяснений (модель видит обрезанный хвост).
    if (!state.warned && !planMode && budget > 0 && state.weight + systemWeight > budget * 0.9) {
      state.warned = true;
      const narrowNote =
        "⚠ Окно модели мало: инструменты (~" + Math.round(state.weight / 1000) + "k) + системный промпт (~" +
        Math.round(systemWeight / 1000) + "k) занимают почти всё окно (" + budget + " т.). " +
        "Возьми модель с окном побольше — иначе агент видит обрезанный контекст и работает вслепую.";
      termEmit({ type: "metrics", text: narrowNote });
      // То же сообщение — в чат: в «Консоли» его не видит тот, кто просто пишет задачу.
      emit({ type: "notice", text: narrowNote });
    }
    // Справочник группы: подключаем один раз за задачу, дальше он просто едет в запросе.
    if (!planMode && state.route) {
      for (const gid of state.route.groups) {
        const gname = GROUP_GUIDES[gid];
        if (!gname || state.injected.has(gname)) continue;
        const text = guideReadText(gname);
        if (!text.trim()) continue;
        state.injected.add(gname);
        state.guideNotes.push({
          role: "system",
          content:
            "=== СПРАВОЧНИК АГЕНТА: \"" + gname + "\" (группа \"" + gid + "\") — следуй ему в этой задаче ===\n" + text,
        });
        termEmit({ type: "metrics", text: "📘 Подключён справочник «" + gname + "» (группа «" + gid + "»)." });
      }
    }
    // Вес справочников: они уезжают в КАЖДЫЙ запрос system-сообщениями (см.
    // requestMessages в src/run-round.js), поэтому их место обязано входить в бюджет
    // истории. Раньше не входило: на окне 32k справочник облака (+2,7k токенов)
    // выводил запрос за окно, и модель получала обрезанный промпт — «агент
    // перегружается» без единого слова о причине (замер: 30 729 против 28 672).
    state.guidesWeight = state.guideNotes.length ? estimateTokens(JSON.stringify(state.guideNotes)) : 0;
    // История + резерв 15%: сжатие успевает до переполнения. Схемы, системный промпт
    // и справочники вычитаются: всё это едет в запрос вместе с историей.
    state.histBudget = Math.max(
      1500,
      Math.floor((budget - state.weight - systemWeight - state.guidesWeight) * 0.85)
    );
  };

  // Предохранитель A: модель вызвала реальный инструмент, которого нет в текущем
  // наборе схем (группа не была активирована). Дотягиваем его группу — в этом и
  // следующих раундах схема будет на месте; сам вызов выполняет оболочка как обычно.
  const ensureGroupsFor = (calls) => {
    if (planMode || !state.route) return;
    const fresh = [];
    for (const c of calls || []) {
      const gid = groupOfTool(c.name);
      if (!gid || state.sticky.has(gid)) continue;
      state.sticky.add(gid);
      fresh.push(gid);
    }
    if (fresh.length) {
      refresh();
      // Группа могла не поместиться в окно: обещать «схем станет больше», когда их не
      // стало, — врать в глаза. Говорим результат, а не намерение.
      const fits = fresh.filter((g) => state.route.groups.indexOf(g) >= 0);
      termEmit({
        type: "metrics",
        text: fits.length
          ? "🔧 «" + calls[0].name + "» вне набора схем — включаю группу «" + fits.join(", ") + "» (схем теперь " + state.active.length + ")."
          : "🔧 «" + calls[0].name + "» вне набора схем: группа «" + fresh.join(", ") + "» включена, но её схемы не влезают в окно модели (схем " + state.active.length + "). Вызов выполняю как обычно.",
      });
    }
  };
  // Переполнение контекста: историю урезают, и её бюджет считается иначе — без
  // резерва 15% (окно уже ужато вручную). Формула остаётся здесь: она про бюджет
  // истории, и держать её в двух местах — верный способ их развести.
  const histBudgetAfterOverflow = () => Math.max(1500, getBudget() - state.weight - systemWeight - state.guidesWeight);

  // Объект для executeTool (findTools): включить группу на лету и посмотреть состав.
  const router = {
    addGroups(ids) {
      let changed = false;
      for (const id of ids || []) {
        if (!id || state.sticky.has(id)) continue;
        state.sticky.add(id);
        changed = true;
      }
      if (changed) refresh();
    },
    has(id) {
      return state.sticky.has(id);
    },
    names() {
      return state.active.map((t) => t.function && t.function.name).filter(Boolean);
    },
    groups() {
      return [...state.sticky];
    },
  };

  return { state: state, refresh: refresh, ensureGroupsFor: ensureGroupsFor, histBudgetAfterOverflow: histBudgetAfterOverflow, router: router };
}

module.exports = { createRunTools };

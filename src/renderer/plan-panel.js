"use strict";

/* ─── План работ: чеклист над полем ввода, разбор плана из текста, галочки ────────
   Вынесено из app.js (этап A, часть 3). Панель питается планом, который составила
   модель: инструментом todoWrite ИЛИ просто текстом ответа (заголовок «План» со
   списком, блок строк-чекбоксов, нумерованные этапы). Статусы текстового плана
   двигает сам факт работы: перед раундом первый пункт встаёт «в работе», после
   раунда — готов, а упавший шаг отмечается «⚠️» по результату инструмента.

   Зависимости приходят одним объектом. Значениями — DOM ($, document), ядро
   (AgentCore) и вызовы оболочки (getActiveChat, sendMessage, autoResize,
   persistChatsSoon, toast). Переписываемое состояние отдано ЖИВЫМИ функциями:
   признак генерации (getStreaming) и сегменты ответа (getChatSegments) — сегменты
   собираются в оболочке НИЖЕ точки сбора, копия устарела бы молча.
   Свёрнутость панели и история планов живут в самом модуле. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.PlanPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (PlanPanelDeps) {
  const {
    $, document, getActiveChat, getStreaming, getChatSegments,
    sendMessage, autoResize, persistChatsSoon, toast, AgentCore,
    // Сколько прошлых планов хранит чат. Значение приходит из оболочки: тем же
    // числом ограничивается история планов при загрузке чатов с диска (sanitizeChats).
    planArchiveLimit = 5,
  } = PlanPanelDeps || {};

  // ─────────── План работ (todoWrite): панель-чеклист над панелью действий ───────────
  // Панель показывает ТОЛЬКО план, составленный моделью инструментом todoWrite.
  // Если модель плана не дала — панели нет вовсе: ход её действий и так виден в панели
  // работы над полем ввода, а дублирующий чеклист «что уже сделано» только путал
  // и выглядел ошибкой интерфейса.
  // Функции ниже чистые: они меняют только переданный объект чата и ничего не рисуют —
  // отрисовку и запись на диск делают вызывающие места (так это и тестируется).
  const PLAN_ICON = { pending: "⬜", in_progress: "🔄", done: "✅", failed: "⚠️" };
  const PLAN_TEXT = { pending: "ожидает", in_progress: "в работе", done: "готово", failed: "не удалось" };

  function planProgress(items) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    const done = list.filter((i) => i && i.status === "done").length;
    const failed = list.filter((i) => i && i.status === "failed").length;
    const active = list.find((i) => i && i.status === "in_progress");
    const percent = total ? Math.round(((done + failed) / total) * 100) : 0;
    return { total, done, failed, percent, active: active ? active.text : "", finished: total > 0 && done + failed === total };
  }

  function planArchive(chat, plan) {
    if (!chat || !plan || !Array.isArray(plan.items) || !plan.items.length) return;
    if (!Array.isArray(chat.planHistory)) chat.planHistory = [];
    chat.planHistory.unshift({
      title: plan.title || "",
      source: plan.source || "model",
      items: plan.items,
      updatedAt: plan.updatedAt || Date.now(),
    });
    if (chat.planHistory.length > planArchiveLimit) chat.planHistory.length = planArchiveLimit;
  }

  // План от модели (todoWrite). Слабая модель может прислать мусор — нормализатор
  // вернёт пустой список, и такой «план» просто не появится.
  function planFromModel(chat, ev) {
    if (!chat) return false;
    const items = AgentCore.normalizePlanTasks(ev && ev.tasks);
    if (!items.length) return false;
    // Заменяя план модели, предыдущий убираем в историю (не теряем контекст).
    if (chat.plan && chat.plan.source !== "auto") planArchive(chat, chat.plan);
    chat.plan = {
      title: String((ev && ev.title) || "").trim().slice(0, 80),
      source: "model",
      items,
      updatedAt: Date.now(),
    };
    return true;
  }

  // ── План, написанный моделью ТЕКСТОМ (не через todoWrite) ──
  // Слабые модели часто перечисляют шаги прямо в ответе («План: 1. … 2. …»). Раньше такой
  // план пропадал: панель питалась только todoWrite, и получалось «план составляет, а панели
  // с галочками нет». Теперь текст тоже становится чеклистом: заголовок («План», «План работ»,
  // «Шаги», «Todo») со списком пунктов или блок строк-чекбоксов (✅/⬜/🔄/⚠️).
  const PLAN_TEXT_MAX = 7;
  const PLAN_HEAD_RE = /^\s*(?:[>#*_+-]{0,4}\s*)?(?:\*\*|__)?\s*(план(?:\s+(?:работ|действий|выполнения|задач))?|шаги|порядок\s+действий|todo|to-do)\s*:?\s*(?:\*\*|__)?\s*$/i;
  // Заголовок в КОНЦЕ фразы, а не отдельной строкой: «План уже составлен. Сейчас нужно:», «Дальше по шагам:».
  // Ключевое слово обязательно: иначе любой абзац «что нужно:» со списком выглядел бы планом.
  const PLAN_TAIL_RE = /(?:план\w*|шаг\w*|этап\w*|дальше|теперь|нужно|надо|осталось|порядок\s+действий)[^:\n]{0,60}:\s*(?:\*\*|__)?\s*$/i;
  const PLAN_ITEM_RE = /^\s*(?:[-*•–—]\s+\S|\[[ xX]\]\s*\S|\d{1,2}[.)]\s+\S|(?:[Шш]аг|[Ээ]тап|[Ss]tep)\s*\d+\s*[:.)]\s*\S|[A-Za-zА-Яа-я]\)\s+\S|[✅☑✔⬜☐🔄⚠️⬛]\s*\S)/;
  const PLAN_TICK_RE = /^\s*[✅☑✔⬜☐🔄⚠️⬛]\s*\S/;
  // Слова-маркеры для плана без заголовка (см. planLinesFromText).
  const PLAN_WORD_RE = /(план\w*|шаг\w*|этап\w*|порядок\s+действий|дальше|осталось|todo)/i;

  // Собирает пункты плана, начиная со строки from. Пустые строки ВНУТРИ списка
  // пропускаем: модели печатают markdown «loose list» (пункты через пустую строку),
  // и раньше такой план терялся целиком — панель оставалась пустой.
  function collectPlanItems(lines, from) {
    const out = [];
    for (let j = Math.max(0, from); j < lines.length && out.length < PLAN_TEXT_MAX; j++) {
      const line = lines[j].replace(/\s+$/, "");
      if (!line.trim()) continue; // пустая строка внутри списка — не конец плана
      if (!PLAN_ITEM_RE.test(line)) break;
      out.push(line);
    }
    return out;
  }

  // Строки плана из текста ответа. Пусто — если плана в тексте нет (обычный ответ или
  // перечисление в прозе): заголовок обязателен, либо нужен блок чекбоксов из 2+ строк.
  function planLinesFromText(text) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!PLAN_HEAD_RE.test(lines[i]) && !PLAN_TAIL_RE.test(lines[i])) continue;
      const out = collectPlanItems(lines, i + 1);
      if (out.length >= 2) return out;
    }
    // Заголовка нет, но есть блок строк-чекбоксов — это тоже план (его и ждёт пользователь).
    let block = [];
    for (const row of lines) {
      const line = row.replace(/\s+$/, "");
      if (PLAN_TICK_RE.test(line)) { block.push(line); continue; }
      if (!line.trim() && block.length) continue;
      if (block.length >= 2) break;
      block = [];
    }
    if (block.length >= 2) return block.slice(0, PLAN_TEXT_MAX);
    // Совсем без заголовка: в тексте есть планирующее слово и нумерованный список из 3+
    // пунктов — это план («Задача разбивается на этапы: 1. … 2. … 3. …»). Порог в три
    // пункта и узкий список слов оставляют обычные отчёты со списком вне панели.
    if (PLAN_WORD_RE.test(raw)) {
      for (let i = 0; i < lines.length; i++) {
        if (!PLAN_ITEM_RE.test(lines[i])) continue;
        const out = collectPlanItems(lines, i);
        if (out.length >= 3) return out;
      }
    }
    return [];
  }

  // Заголовок плана из текста («План работ» и т.п.). Пусто → панель покажет «План работ».
  function planTitleFromText(text) {
    for (const line of String(text || "").split(/\r?\n/)) {
      const m = line.match(PLAN_HEAD_RE);
      if (!m || !m[1]) continue;
      const t = String(m[1]).trim();
      if (t) return t.charAt(0).toUpperCase() + t.slice(1);
    }
    return "";
  }

  // План из текста. Настоящий план модели (todoWrite) всегда важнее текстового.
  function planFromText(chat, text) {
    if (!chat) return false;
    if (chat.plan && chat.plan.source === "model") return false;
    const lines = planLinesFromText(text);
    if (lines.length < 2) return false;
    const items = AgentCore.normalizePlanTasks(lines);
    if (items.length < 2) return false; // один пункт — это фраза, а не план
    if (chat.plan && chat.plan.source === "text") {
      const old = chat.plan.items;
      const same = old.map((i) => i.text).join("|") === items.map((i) => i.text).join("|");
      if (same) return false; // тот же план — статусы не сбрасываем
      // План печатается прямо сейчас: старые пункты — начало нового списка. Значит это ТОТ ЖЕ
      // план, просто стрим дошёл до следующих строк: в историю его не убираем, а статусы уже
      // пройденных пунктов сохраняем (иначе галочки прыгали бы назад на каждом куске).
      const grows = old.length <= items.length && old.every((it, i) => it.text === items[i].text);
      if (grows) {
        for (let i = 0; i < old.length; i++) items[i].status = old[i].status;
        chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
        return true;
      }
      planArchive(chat, chat.plan);
    }
    chat.plan = { title: planTitleFromText(text), source: "text", items, updatedAt: Date.now() };
    return true;
  }

  // Прогресс текстового плана: модель статусы не присылает, поэтому галочки двигает сам факт
  // работы — перед раундом действий первый пункт встаёт «в работе», после раунда — готов.
  function planTextAdvance(chat, ok) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const items = chat.plan.items;
    const cur = items.find((i) => i.status === "in_progress");
    if (!cur) {
      const first = items.find((i) => i.status === "pending");
      if (!first) return false;
      first.status = "in_progress";
      chat.plan.updatedAt = Date.now();
      return true;
    }
    if (!ok) return false; // провал шага отмечает planToolOutcome
    cur.status = "done";
    const next = items.find((i) => i.status === "pending");
    if (next) next.status = "in_progress";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Запуск закончился: незакрытый пункт текстового плана отмечаем готовым.
  function planTextFinish(chat) {
    if (!chat || !chat.plan || chat.plan.source !== "text" || !Array.isArray(chat.plan.items)) return false;
    const cur = chat.plan.items.find((i) => i.status === "in_progress");
    if (!cur) return false;
    cur.status = "done";
    chat.plan.updatedAt = Date.now();
    return true;
  }

  // Начался новый раунд ответа (текст или размышления после действий) — предыдущий пункт
  // текстового плана фактически выполнен. Один пункт на раунд: segId защищает от повторов
  // (размышления и текст в одном раунде открывают сегмент лишь один раз).
  function planRoundStarted(chat, segId) {
    if (!chat || !chat.plan || chat.plan.source !== "text") return false;
    if (!segId || chat.plan.advancedFor === segId) return false;
    if (!planTextAdvance(chat, true)) return false;
    chat.plan.advancedFor = segId;
    renderPlanPanel();
    persistChatsSoon();
    return true;
  }

  // Весь текст текущего запуска — ответ И размышления: источник для разбора плана.
  // Размышления обязательны: слабые и локальные модели пишут план именно там
  // («План уже составлен. Сейчас нужно: 1. … 2. …»), а в самом ответе плана нет вовсе —
  // поэтому панель и оставалась пустой, хотя модель «составила план».
  function runTextOf(chat, aMsg) {
    const parts = [];
    for (const s of getChatSegments().runSegments(chat, aMsg)) {
      if (!s) continue;
      if (s.thinking) parts.push(String(s.thinking));
      if (s.content) parts.push(String(s.content));
    }
    return parts.join("\n");
  }

  // Разбор плана из текста запуска. Во время стрима вызывается на каждом куске, поэтому
  // сначала дешёвый гейт: без нескольких строк плана быть не может — регекспы не гоняем.
  function tryPlanFromRunText(chat, aMsg) {
    const text = runTextOf(chat, aMsg);
    if ((text.match(/\n/g) || []).length < 2) return false;
    const hadPlan = !!(chat && chat.plan);
    if (planFromText(chat, runTextOf(chat, aMsg))) {
      planCollapsed = false; // план только что появился — показываем его развёрнутым
      renderPlanPanel();
      persistChatsSoon();
      // Панель плана живёт над полем ввода, и её легко не заметить — сообщаем один раз
      // на план (дальнейшие уточнения плана тост не повторяют).
      if (!hadPlan) toast("📋 Модель составила план — чеклист над полем ввода");
      return true;
    }
    return false;
  }

  // Результат инструмента. Статусы пунктов ведёт модель, но если её текущий шаг
  // фактически упал — показываем ⚠️, а не «в работе»: слепо доверять плану нельзя.
  function planToolOutcome(chat, ev, ok) {
    if (!chat || !chat.plan || !Array.isArray(chat.plan.items)) return false;
    if (!ok) {
      for (let i = chat.plan.items.length - 1; i >= 0; i--) {
        const it = chat.plan.items[i];
        if (it.status !== "in_progress") continue;
        it.status = "failed";
        if (!it.note) it.note = "шаг не удался — см. результат инструмента";
        chat.plan.updatedAt = Date.now();
        return true;
      }
    }
    return false;
  }

  // Новый запрос пользователя: завершённый план — в историю, незавершённый
  // остаётся (при «продолжай» агент видит, что осталось).
  function planRotate(chat) {
    if (!chat || !chat.plan) return false;
    if (planProgress(chat.plan.items).finished) { planArchive(chat, chat.plan); chat.plan = null; return true; }
    return false;
  }
  // Панель плана: отдельный контейнер над панелью действий — она не сбрасывается
  // вместе с ходом работ и не уезжает при прокрутке списка действий.
  let planCollapsed = false;
  function renderPlanPanel() {
    const host = $("plan-panel");
    if (!host) return;
    const chat = getActiveChat();
    // Панель только для плана модели. Старые авто-списки из chats.json (source "auto")
    // не показываем: они и есть тот самый «ход работы», который дублировал панель действий.
    const plan =
      chat && chat.plan && chat.plan.source !== "auto" && Array.isArray(chat.plan.items) && chat.plan.items.length
        ? chat.plan
        : null;
    if (!plan) {
      host.classList.add("hidden");
      host.innerHTML = "";
      return;
    }
    const pr = planProgress(plan.items);
    host.classList.remove("hidden");
    host.innerHTML = "";
    const group = document.createElement("div");
    group.className = "plan-group" + (pr.finished ? " finished" : "") + (planCollapsed ? "" : " expanded");

    const head = document.createElement("div");
    head.className = "plan-head";
    head.title = "Показать/скрыть план работ";
    head.onclick = (e) => {
      e.stopPropagation();
      planCollapsed = !planCollapsed;
      renderPlanPanel();
    };
    const dot = document.createElement("span");
    dot.className = "plan-dot";
    const title = document.createElement("span");
    title.className = "plan-title";
    title.textContent = "📋 " + (plan.title || "План работ");
    const count = document.createElement("span");
    count.className = "plan-count";
    count.textContent = pr.done + "/" + pr.total + (pr.failed ? " ⚠" + pr.failed : "");
    count.title = "Готово " + pr.done + " из " + pr.total + (pr.failed ? ", не удалось: " + pr.failed : "");
    head.appendChild(dot);
    head.appendChild(title);
    // Свёрнутая панель: видно, какой шаг выполняется прямо сейчас (разворачивать не нужно).
    if (planCollapsed && pr.active && !pr.finished) {
      const act = document.createElement("span");
      act.className = "plan-active";
      act.textContent = PLAN_ICON.in_progress + " " + pr.active;
      act.title = "Сейчас в работе: " + pr.active;
      head.appendChild(act);
    }
    head.appendChild(count);
    // Кнопка «выполнить план» — только когда план составлен моделью и ждёт запуска
    // (в режиме плана инструменты не выполнялись).
    if (planPending(chat)) {
      const run = document.createElement("button");
      run.className = "btn btn-primary btn-small plan-run";
      run.textContent = "▶ Выполнить";
      run.onclick = (e) => {
        e.stopPropagation();
        if (getStreaming()) return;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          if (chat.messages[i].role === "assistant") { chat.messages[i].plan = false; break; }
        }
        const inp = $("input");
        inp.value = "Выполни план, который ты составил. Обновляй его через todoWrite после каждого шага.";
        autoResize();
        sendMessage();
      };
      head.appendChild(run);
    }
    const clear = document.createElement("button");
    clear.className = "plan-clear";
    clear.textContent = "✕";
    clear.title = "Убрать план с экрана (уйдёт в историю планов чата)";
    clear.onclick = (e) => {
      e.stopPropagation();
      planArchive(chat, chat.plan);
      chat.plan = null;
      renderPlanPanel();
      persistChatsSoon();
    };
    const chev = document.createElement("span");
    chev.className = "plan-chev";
    chev.textContent = planCollapsed ? "▸" : "▾";
    head.appendChild(clear);
    head.appendChild(chev);
    group.appendChild(head);

    const bar = document.createElement("div");
    bar.className = "plan-bar";
    const fill = document.createElement("div");
    fill.className = "plan-fill";
    fill.style.width = pr.percent + "%";
    bar.appendChild(fill);
    group.appendChild(bar);

    const body = document.createElement("div");
    body.className = "plan-body";
    for (const it of plan.items) {
      const row = document.createElement("div");
      row.className = "plan-item " + (PLAN_ICON[it.status] ? "st-" + it.status : "st-pending");
      const ic = document.createElement("span");
      ic.className = "plan-ic";
      ic.textContent = PLAN_ICON[it.status] || PLAN_ICON.pending;
      const tx = document.createElement("span");
      tx.className = "plan-txt";
      tx.textContent = it.text;
      row.appendChild(ic);
      row.appendChild(tx);
      if (it.note) {
        const nt = document.createElement("span");
        nt.className = "plan-note";
        nt.textContent = it.note;
        row.appendChild(nt);
      } else {
        row.title = PLAN_TEXT[it.status] || "";
      }
      body.appendChild(row);
    }
    group.appendChild(body);
    host.appendChild(group);
  }

  // Ждёт ли план запуска: последний ответ ассистента помечен режимом плана.
  function planPending(chat) {
    if (!chat || !Array.isArray(chat.messages)) return false;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const m = chat.messages[i];
      if (m.role !== "assistant") continue;
      return !!m.plan;
    }
    return false;
  }

  return {
    planProgress,
    planArchive,
    planFromModel,
    planFromText,
    planLinesFromText,
    planTextAdvance,
    planTextFinish,
    planRoundStarted,
    runTextOf,
    tryPlanFromRunText,
    planToolOutcome,
    planRotate,
    planPending,
    renderPlanPanel,
    setPlanCollapsed: (v) => { planCollapsed = v; },
  };
});

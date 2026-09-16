"use strict";

/* ─── Роли чата, дела и миссия ────────────────────────────────────────────────
   Вынесено из app.js (этап 3 разбора гигантов). Три раздела ехали вместе, потому
   что связаны: переключатель роли перерисовывает панель дел, а дела и миссия
   пользуются кнопками роли.

   Здесь: роли диалога (кнопка у поля ввода, попап и чипсы), панель «Дела» (список,
   фильтры, быстрые сроки, «▶ агент») и панель «Миссия» (ход долгой работы агента,
   пауза/продолжение/стоп, шаги и журнал).

   Зависимости приходят одним объектом. Общее состояние — живыми функциями:
   настройки (getSettings), идёт ли генерация (isStreaming) и какая вкладка открыта
   в правой панели (getSideTab): копии значений устарели бы, а по ним решается,
   можно ли продолжать миссию и что перерисовывать по таймеру. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.TasksMission = factory;
  }
})(typeof self !== "undefined" ? self : this, function (TasksMissionDeps) {
  const {
    $, api, isElectron, AgentCore, toast, getActiveChat, getChatsData, selectChat, sendMessage, autoResize,
    persistChatsNow, renderSidebar, openSidePanel, closeSidePanel, sidePanelVisible,
    startAutoRunNow, getSettings, isStreaming, getSideTab,
  } = TasksMissionDeps || {};
  // ── Роли чата ────────────────────────────────────────────────────────────
  // Роль — режим всего чата: текст роли уходит в системный промпт каждый раунд, а её
  // инструменты включены с первого раунда (см. AGENT_ROLES в ядре). Выбор хранится в
  // самом чате, поэтому переписка с менеджером остаётся менеджерской и после перезапуска.
  function roleEsc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function chatRole() {
    const c = getActiveChat();
    return AgentCore.roleById((c && c.role) || getSettings().defaultRole || "dev");
  }
  function renderRoleButton() {
    const btn = $("btn-role");
    if (!btn) return;
    const role = chatRole();
    btn.textContent = role.icon + " " + role.title;
    btn.classList.toggle("active", role.id !== "dev");
    btn.title = role.hint + " · клик — сменить роль";
  }
  function renderRolePopover() {
    const box = $("role-popover");
    if (!box) return;
    const cur = chatRole();
    box.innerHTML = '<div class="role-popover-head">Роль держится весь чат: агент иначе себя ведёт и сразу включает нужные инструменты. Выбор запоминается в чате.</div>';
    for (const r of AgentCore.rolesList()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "role-card" + (r.id === cur.id ? " active" : "");
      b.innerHTML = '<span class="role-card-ic">' + roleEsc(r.icon) + '</span><span><span class="role-card-title">' + roleEsc(r.title) + '</span><div class="role-card-hint">' + roleEsc(r.hint) + "</div></span>";
      b.onclick = () => { setChatRole(r.id); toggleRolePopover(false); };
      box.appendChild(b);
    }
  }
  function toggleRolePopover(show) {
    const box = $("role-popover");
    if (!box) return;
    const next = show === undefined ? box.classList.contains("hidden") : !!show;
    if (next) renderRolePopover();
    box.classList.toggle("hidden", !next);
  }
  function setChatRole(id) {
    const role = AgentCore.roleById(id);
    const chat = getActiveChat();
    if (chat) {
      chat.role = role.id;
      persistChatsNow();
      renderSidebar();
    }
    // Новые чаты наследуют последнюю выбранную роль.
    getSettings().defaultRole = role.id;
    if (api && api.setSettings) api.setSettings({ defaultRole: role.id }).catch(() => {});
    renderRoleButton();
    renderRoleChips();
    toast(role.icon + " Роль: " + role.title);
    if (role.id === "manager") {
      openSidePanel("tasks");
      renderTasks();
    }
  }
  function renderRoleChips() {
    const box = $("role-chips");
    if (!box) return;
    const chips = chatRole().chips || [];
    box.innerHTML = "";
    box.classList.toggle("hidden", !chips.length);
    for (const c of chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip action role-chip";
      b.textContent = c.t;
      b.onclick = () => {
        const input = $("input");
        input.value = c.t;
        autoResize();
        if (c.send) sendMessage();
        else input.focus();
      };
      box.appendChild(b);
    }
  }

  // ── Дела (задачи и сроки) ────────────────────────────────────────────────
  let tasksShowDone = false;
  function tasksSupported() {
    return !!(isElectron && api.tasksBoard);
  }
  function dayStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  // Срок по-человечески: «сегодня 14:00», «завтра», «⚠ просрочено 2 ч назад».
  function tasksDueText(t) {
    if (!t.due) return "без срока";
    const at = new Date(t.due);
    if (isNaN(at.getTime())) return String(t.due);
    const now = Date.now();
    const time = t.allDay ? "" : " " + String(at.getHours()).padStart(2, "0") + ":" + String(at.getMinutes()).padStart(2, "0");
    if (at.getTime() < now) {
      const mins = Math.max(1, Math.round((now - at.getTime()) / 60000));
      const ago = mins < 60 ? mins + " мин" : Math.round(mins / 60) + " ч";
      return "⚠ просрочено" + time + " · " + ago + " назад";
    }
    const diff = Math.round((dayStart(at.getTime()) - dayStart(now)) / 86400000);
    if (diff === 0) return "сегодня" + time + (t.allDay ? " (весь день)" : "");
    if (diff === 1) return "завтра" + time + (t.allDay ? " (весь день)" : "");
    if (diff > 1 && diff < 7) return "через " + diff + " дн" + time;
    return at.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + time;
  }
  // Повтор по-человечески — та же строка, что хранит приложение («daily», «weekly:5»…).
  const REPEAT_TEXT = { daily: "каждый день", weekdays: "по будням", weekly: "каждую неделю", monthly: "каждый месяц" };
  const WEEKDAY_ACC = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];
  function repeatText(r) {
    const s = String(r || "");
    if (!s) return "";
    if (REPEAT_TEXT[s]) return REPEAT_TEXT[s];
    if (s.startsWith("weekly:")) {
      const d = parseInt(s.slice(7), 10);
      return d >= 0 && d <= 6 ? "каждую " + WEEKDAY_ACC[d] : "каждую неделю";
    }
    if (s.startsWith("every:")) {
      const mins = parseInt(s.slice(6), 10) || 60;
      return mins % 60 === 0 && mins >= 60 ? "каждые " + mins / 60 + " ч" : "каждые " + mins + " мин";
    }
    return s;
  }
  function updateTasksBadge(s) {
    const b = $("rail-tasks-badge");
    if (!b) return;
    const n = (s && (s.overdue || 0) + (s.today || 0)) || 0;
    b.textContent = n > 99 ? "99+" : String(n);
    b.classList.toggle("hidden", n === 0);
  }
  function taskRow(t, done) {
    const high = t.priority === "high";
    const row = document.createElement("div");
    row.className = "task-row" + (done ? " done" : "") + (high ? " high" : "");
    const at = t.due ? new Date(t.due) : null;
    const late = !!(at && !isNaN(at.getTime()) && !done && at.getTime() < Date.now());
    if (late) row.classList.add("late");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "task-check";
    cb.checked = !!done;
    cb.title = done ? "Снять отметку «выполнено»" : "Отметить выполненным";
    cb.onchange = async () => { await api.tasksDone(t.id, !done); renderTasks(); };
    // Название и срок живут в одном блоке: длинные дела переносятся, а метки
    // не разъезжаются по всей ширине панели.
    const body = document.createElement("div");
    body.className = "task-body";
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = t.title;
    if (t.note) title.title = t.note;
    title.onclick = () => startTaskEdit(row, title, t, "title");
    const meta = document.createElement("div");
    meta.className = "task-meta";
    const due = document.createElement("span");
    due.className = "task-due" + (late ? " late" : t.due ? "" : " none");
    // Значок «⚠» уже внутри текста срока (tasksDueText) — второй ставить не нужно,
    // иначе в панели получалось «⚠ ⚠ просрочено».
    due.textContent = (t.due ? (late ? "" : "🕒 ") : "— ") + tasksDueText(t);
    due.title = "Клик — изменить срок (например: завтра 14:00)";
    due.onclick = () => startTaskEdit(row, due, t, "due");
    meta.appendChild(due);
    if (t.repeat) {
      const rep = document.createElement("span");
      rep.className = "task-tag";
      rep.textContent = "🔁 " + repeatText(t.repeat);
      rep.title = "Дело повторяется: " + repeatText(t.repeat);
      meta.appendChild(rep);
    }
    // Автозапуск агентом — ВИДИМАЯ кнопка, а не скрытая галочка: раньше пометить дело
    // было нечем, и планировщик его пропускал («ставлю время, а агента никто не дёргает»).
    const autoBtn = document.createElement("button");
    autoBtn.type = "button";
    autoBtn.className = "task-tag tk-auto" + (t.auto ? " on" : "");
    autoBtn.textContent = t.auto ? "▶ агент" : "▷ агент";
    autoBtn.title = t.auto
      ? "Агент выполнит это дело сам по сроку (ответ — в чате «Автозадачи»). Клик — выключить."
      : "Клик — включить: приложение само разбудит агента в срок дела.";
    autoBtn.onclick = async (e) => {
      e.stopPropagation();
      const r = await api.tasksUpdate(t.id, { auto: !t.auto });
      if (r && r.ok === false) { toast("Дела: " + r.error); return; }
      toast(!t.auto
        ? "▶ Дело «" + t.title + "» запустит агент по сроку"
        : "▷ Дело «" + t.title + "» больше не запускается агентом");
      renderTasks();
    };
    meta.appendChild(autoBtn);
    if (t.auto) {
      // Проверить запуск, не дожидаясь часа: тот же путь, что и по сроку.
      const nowBtn = document.createElement("button");
      nowBtn.type = "button";
      nowBtn.className = "task-tag tk-now";
      nowBtn.textContent = "▶ сейчас";
      nowBtn.title = "Запустить агента прямо сейчас, не дожидаясь срока (срок и повтор не меняются)";
      nowBtn.onclick = (e) => { e.stopPropagation(); startAutoRunNow(t); };
      meta.appendChild(nowBtn);
    }
    if (t.auto && t.autoGaveUp) {
      const failTag = document.createElement("span");
      failTag.className = "task-tag tk-fail";
      failTag.textContent = "⚠ не запустилась";
      failTag.title = t.autoLastError ? "Последняя ошибка: " + t.autoLastError : "Прогон не подтвердился";
      meta.appendChild(failTag);
    }
    if (t.project) {
      const tag = document.createElement("span");
      tag.className = "task-tag";
      tag.textContent = t.project;
      tag.title = "Проект: " + t.project;
      meta.appendChild(tag);
    }
    if (high || t.priority === "low") {
      const tag = document.createElement("span");
      tag.className = "task-tag" + (high ? " high" : "");
      tag.textContent = high ? "важное" : "мелкое";
      meta.appendChild(tag);
    }
    body.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "task-actions";
    const del = document.createElement("button");
    del.className = "task-edit";
    del.textContent = "🗑";
    del.title = "Удалить дело";
    del.onclick = async () => {
      if (!window.confirm("Удалить дело «" + t.title + "»?")) return;
      await api.tasksDelete(t.id);
      renderTasks();
    };
    actions.appendChild(del);
    row.append(cb, body, actions);
    return row;
  }
  // Правка прямо в строке: клик по названию или сроку. В Electron window.prompt нет,
  // поэтому редактируем на месте и сохраняем по Enter или потере фокуса.
  function startTaskEdit(row, el, t, field) {
    if (row.querySelector(".task-edit-input")) return;
    const input = document.createElement("input");
    input.className = "task-edit-input";
    input.value = field === "due" ? t.due || "" : t.title;
    if (field === "due") input.placeholder = "завтра 14:00 / в пятницу / пусто — без срока";
    el.replaceWith(input);
    input.focus();
    if (field === "title") input.select();
    const save = async () => {
      const value = input.value.trim();
      input.onblur = null;
      if (!value && field === "title") { renderTasks(); return; }
      const patch = {};
      patch[field] = value;
      const r = await api.tasksUpdate(t.id, patch);
      if (r && r.ok === false) toast("Дела: " + r.error);
      renderTasks();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      if (e.key === "Escape") { input.onblur = null; renderTasks(); }
    };
    input.onblur = save;
  }
  // Фильтр панели: «Все» либо конкретная группа сроков (клик по плитке).
  let tasksFilter = "all";
  const TASK_FILTERS = [
    { id: "all", title: "Все" },
    { id: "overdue", title: "Просрочено" },
    { id: "today", title: "Сегодня" },
    { id: "tomorrow", title: "Завтра" },
    { id: "week", title: "На неделе" },
    { id: "none", title: "Без срока" },
  ];
  function paintTaskFilters(board) {
    const box = $("tasks-filters");
    if (!box) return;
    const groups = board.groups || [];
    const total = groups.reduce((n, g) => n + g.tasks.length, 0);
    // Фильтр, в котором ничего не осталось, сам возвращается к «Все» —
    // иначе панель выглядела бы пустой без причины.
    if (tasksFilter !== "all" && !groups.some((g) => g.id === tasksFilter && g.tasks.length)) tasksFilter = "all";
    box.innerHTML = "";
    for (const f of TASK_FILTERS) {
      const n = f.id === "all" ? total : ((groups.find((g) => g.id === f.id) || { tasks: [] }).tasks.length);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tk-chip" + (tasksFilter === f.id ? " active" : "") + (n ? "" : " zero") + (f.id === "overdue" && n ? " late" : "");
      b.dataset.filter = f.id;
      b.title = "Показать: " + f.title.toLowerCase();
      const label = document.createElement("span");
      label.textContent = f.title;
      const num = document.createElement("span");
      num.className = "tk-n";
      num.textContent = String(n);
      b.append(label, num);
      b.onclick = () => { tasksFilter = f.id; renderTasks(); };
      box.appendChild(b);
    }
  }

  // ── Миссия (долгая работа агента) ──────────────────────────────────────────
  // Агент, который работает часами, должен быть виден: цель, шаги, живой журнал,
  // время и токены. Данные приходят из main (файлы .agent/) — панель их только рисует.
  let missionCache = null;
  let missionTimer = null;
  const MISSION_STATUS_LABEL = {
    active: "работает",
    paused: "на паузе",
    done: "завершена",
    failed: "с ошибкой",
    stopped: "остановлена",
  };
  const MISSION_STEP_ICON = { done: "✓", failed: "!", doing: "▸", todo: "○" };

  function missionSupported() {
    return !!(isElectron && api.missionState);
  }

  function missionClock(ms) {
    const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  }

  async function refreshMission() {
    if (!missionSupported()) return null;
    try {
      missionCache = await api.missionState();
    } catch {
      missionCache = null;
    }
    renderMission();
    return missionCache;
  }

  function missionDot(active) {
    const dot = $("sp-mission-dot");
    if (dot) dot.classList.toggle("hidden", !active);
    const badge = $("rail-mission-badge");
    if (badge) {
      badge.classList.toggle("hidden", !active);
      if (active) badge.textContent = "●";
    }
  }

  function renderMission() {
    const host = $("sp-mission");
    if (!host) return;
    const st = missionCache;
    if (!st || !st.enabled) {
      const empty = $("ms-empty");
      if (empty) {
        empty.classList.remove("hidden");
        empty.textContent = st && !st.enabled
          ? "Долгая работа выключена: включи галочку «Долгая работа агента (миссии)» в настройках — тогда большие задачи будут вестись миссиями с файлами в папке .agent/."
          : "Миссий пока нет. Они появляются сами, когда работа агента становится длинной: цель, план и журнал работы ложатся файлами в папку .agent/ рядом с проектом.";
      }
      if ($("ms-card")) $("ms-card").classList.add("hidden");
      if ($("ms-list")) $("ms-list").innerHTML = "";
      missionDot(false);
      return;
    }
    const m = st.active;
    if ($("ms-empty")) $("ms-empty").classList.toggle("hidden", !!m);
    const card = $("ms-card");
    if (card) card.classList.toggle("hidden", !m);
    missionDot(!!(m && (m.status === "active" || m.status === "paused")));

    if (m) {
      const pr = st.progress || m.progress || { total: 0, done: 0, failed: 0, current: "" };
      const running = st.running && m.status === "active";
      if ($("ms-title")) $("ms-title").textContent = m.title || "Миссия";
      const statusEl = $("ms-status");
      if (statusEl) {
        const label = MISSION_STATUS_LABEL[m.status] || m.status;
        statusEl.textContent = (running ? "работает" : label) + " · " + pr.done + "/" + pr.total;
        statusEl.className = "ms-status ms-" + m.status;
      }
      if ($("ms-goal")) $("ms-goal").textContent = m.goal || "";
      if ($("ms-fill")) $("ms-fill").style.width = Math.max(2, pr.percent || 0) + "%";
      const elapsed = running && st.startedAt ? Date.now() - st.startedAt : (m.finishedAt || m.updatedAt || m.createdAt) - (m.startedAt || m.createdAt);
      if ($("ms-meta")) {
        $("ms-meta").innerHTML =
          '<span title="Время работы">⏱ ' + missionClock(elapsed) + "</span>" +
          '<span title="Раундов пройдено">⚙ ' + (st.rounds || m.rounds || 0) + "</span>" +
          '<span title="Батчей (отрезков по 25 раундов)">◆ ' + (st.batches || m.batches || 0) + "</span>" +
          // metrics может отсутствовать: у миссии, нарисованной из одного события
          // (опрос ещё не ответил), его нет — раньше здесь было падение TypeError.
          '<span title="Токенов израсходовано">✦ ' + (st.tokens || (m.metrics && m.metrics.tokens) || 0) + "</span>" +
          '<span title="Сжатий контекста">🧠 ' + (st.compactions || (m.metrics && m.metrics.compactions) || 0) + "</span>" +
          (pr.failed ? '<span class="ms-bad" title="Шагов не удалось">⚠ ' + pr.failed + "</span>" : "") +
          (m.reason ? '<span class="ms-reason" title="Причина остановки">' + roleEsc(m.reason) + "</span>" : "");
      }
      const steps = m.steps || [];
      const sbox = $("ms-steps");
      if (sbox) {
        sbox.innerHTML = steps.length
          ? steps.map((s, i) =>
              '<div class="ms-step ms-step-' + (s.state || "todo") + '">' +
              '<i>' + (MISSION_STEP_ICON[s.state] || "○") + "</i>" +
              '<span class="ms-step-text">' + (i + 1) + ". " + roleEsc(s.title || "") + "</span>" +
              (s.note ? '<span class="ms-step-note" title="' + roleEsc(s.note) + '">' + roleEsc(s.note) + "</span>" : "") +
              "</div>"
            ).join("")
          : '<div class="ms-muted">План пока не составлен — агент добавит шаги по ходу работы.</div>';
      }
      const jbox = $("ms-journal");
      if (jbox) {
        const rows = st.journal || [];
        jbox.innerHTML = rows.length
          ? rows.slice().reverse().map((r) =>
              '<div class="ms-line ms-line-' + roleEsc(r.kind || "note") + '">' +
              '<span class="ms-time">' + new Date(r.ts).toLocaleTimeString().slice(0, 5) + "</span>" +
              "<span>" + roleEsc(r.text || "") + "</span></div>"
            ).join("")
          : '<div class="ms-muted">Журнал пуст — работа ещё не начиналась.</div>';
      }
      const pauseBtn = $("btn-mission-pause");
      if (pauseBtn) pauseBtn.disabled = !running;
      const resumeBtn = $("btn-mission-resume");
      if (resumeBtn) resumeBtn.disabled = running || !!isStreaming();
      const stopBtn = $("btn-mission-stop");
      if (stopBtn) stopBtn.disabled = !st.running;
      const finishBtn = $("btn-mission-finish");
      if (finishBtn) finishBtn.disabled = !!isStreaming();
    }

    const list = (st.list || []).filter((x) => !m || x.id !== m.id);
    const lbox = $("ms-list");
    if (lbox) {
      lbox.innerHTML = list.length
        ? list.map((x) =>
            '<div class="ms-past" data-id="' + roleEsc(x.id) + '">' +
            '<span class="ms-past-title">' + roleEsc(x.title || x.id) + "</span>" +
            '<span class="ms-past-meta">' + (MISSION_STATUS_LABEL[x.status] || x.status) + " · " +
            (x.progress ? x.progress.done + "/" + x.progress.total : "0/0") + "</span>" +
            '<button class="btn btn-ghost btn-small ms-past-open" title="Открыть папку миссии">📂</button>' +
            "</div>"
          ).join("")
        : '<div class="ms-muted">Прошлых миссий нет.</div>';
      for (const row of lbox.querySelectorAll(".ms-past-open")) {
        row.onclick = (e) => {
          e.stopPropagation();
          const box = row.closest(".ms-past");
          if (box && api.missionOpen) api.missionOpen(box.dataset.id);
        };
      }
    }
    const pastTitle = $("ms-past-title");
    if (pastTitle) pastTitle.classList.toggle("hidden", !list.length);
  }

  function missionTickStart() {
    if (missionTimer) return;
    missionTimer = setInterval(() => {
      if (!missionCache || !missionCache.active || !missionCache.running || getSideTab() !== "mission") return;
      renderMission();
    }, 1000);
  }

  function initMissionPanel() {
    if ($("btn-mission-refresh")) $("btn-mission-refresh").onclick = () => refreshMission();
    if ($("btn-mission-pause")) {
      $("btn-mission-pause").onclick = async () => {
        try {
          await api.missionPause();
          toast("⏸ Пауза: работа сохранена, миссия ждёт продолжения");
        } catch {}
      };
    }
    if ($("btn-mission-stop")) {
      $("btn-mission-stop").onclick = async () => {
        try {
          await api.missionStop();
          toast("⏹ Останавливаю прогон");
        } catch {}
      };
    }
    if ($("btn-mission-resume")) {
      $("btn-mission-resume").onclick = async () => {
        if (isStreaming()) return;
        let r = null;
        try {
          r = await api.missionResume();
        } catch {}
        if (!r || !r.ok) {
          toast((r && r.error) || "Незакрытых миссий нет");
          return;
        }
        // Продолжаем миссию в ЕЁ чате (там история работы и отчёты); если чата уже
        // нет — работаем в открытом. Чат приходит из mission:resume вместе с текстом.
        const chats = getChatsData ? getChatsData() : null;
        const home = r.chatId && chats && Array.isArray(chats.chats) ? chats.chats.find((c) => c.id === r.chatId) : null;
        const chat = home || getActiveChat();
        if (chat) selectChat(chat.id);
        $("input").value = r.text;
        autoResize();
        sendMessage();
      };
    }
    if ($("btn-mission-finish")) {
      $("btn-mission-finish").onclick = async () => {
        // Во время прогона не закрываем: агент держит миссию в памяти и продолжит
        // её писать. Скажем вслух — молчаливая кнопка хуже отказа.
        if (isStreaming()) {
          toast("Дождись окончания текущего прогона");
          return;
        }
        // Закрываем ту миссию, которую видит человек в карточке.
        const id = missionCache && missionCache.active ? missionCache.active.id : "";
        let r = null;
        try {
          r = await api.missionFinish(id);
        } catch {}
        if (!r || !r.ok) {
          toast((r && r.error) || "Не удалось закрыть миссию");
          return;
        }
        toast("🏁 Миссия закрыта — напоминать о ней больше не будут");
        refreshMission();
      };
    }
    if ($("btn-mission-folder")) {
      $("btn-mission-folder").onclick = () => {
        const id = missionCache && missionCache.active ? missionCache.active.id : "";
        if (api.missionOpen) api.missionOpen(id);
      };
    }
    if (missionSupported()) {
      refreshMission();
      missionTickStart();
    }
  }

  // Событие прогона: агент или движок что-то записали в миссию — обновляем панель.
  function missionFromEvent(ev) {
    if (!missionSupported() || !ev) return;
    if (ev.id) {
      // enabled: true — событие само доказывает, что долгая работа включена. Без этого
      // событие, пришедшее раньше опроса главного процесса (гонка на старте),
      // прятало карточку и советовало «включи галочку», хотя миссия уже идёт.
      missionCache = Object.assign({}, missionCache || {}, {
        enabled: true,
        active: Object.assign({}, (missionCache && missionCache.active) || {}, {
          id: ev.id,
          title: ev.title,
          goal: ev.goal,
          status: ev.status,
          steps: ev.steps || [],
          reason: ev.reason || "",
        }),
        progress: ev.progress || null,
        rounds: ev.rounds,
        batches: ev.batches,
        tokens: ev.tokens,
        compactions: ev.compactions,
        startedAt: ev.startedAt,
        running: true,
      });
      renderMission();
    }
    refreshMission();
  }

  async function renderTasks() {
    if (!tasksSupported()) {
      const c0 = $("tasks-counts");
      if (c0) c0.textContent = "Дела работают в приложении на ПК (в веб-превью список недоступен).";
      return;
    }
    const box = $("tasks-groups");
    if (!box) return;
    let board = null;
    try { board = await api.tasksBoard(); } catch { board = null; }
    if (!board || !board.groups) {
      const c = $("tasks-counts");
      if (c) c.textContent = "Не удалось прочитать список дел.";
      return;
    }
    const s = board.summary || {};
    const counts = $("tasks-counts");
    if (counts) {
      counts.innerHTML = "Активных: " + (s.active || 0) +
        (s.overdue ? ' · <span class="tc-late">просрочено ' + s.overdue + "</span>" : "") +
        " · сегодня " + (s.today || 0) + " · завтра " + (s.tomorrow || 0);
    }
    paintTaskFilters(board);
    box.innerHTML = "";
    for (const g of board.groups) {
      if (!g.tasks.length) continue;
      if (tasksFilter !== "all" && g.id !== tasksFilter) continue;
      const head = document.createElement("div");
      head.className = "tasks-group-head" + (g.id === "overdue" ? " overdue" : "");
      head.textContent = g.title + " · " + g.tasks.length;
      box.appendChild(head);
      for (const t of g.tasks) box.appendChild(taskRow(t, false));
    }
    const empty = $("tasks-empty");
    if (empty) {
      const nothing = box.childElementCount === 0;
      empty.classList.toggle("hidden", !nothing);
      if (nothing) {
        const filtered = tasksFilter !== "all";
        empty.innerHTML =
          '<span class="tk-empty-ic">' + (filtered ? "🔍" : "🗒") + "</span>" +
          '<div class="tk-empty-t">' + (filtered ? "В этом фильтре дел нет" : "Дел пока нет") + "</div>" +
          '<div class="tk-empty-s">' + (filtered
            ? "Сбрось фильтр кнопкой «Все» выше — или добавь дело с таким сроком."
            : "Добавь первое дело в поле выше — или попроси агента: «запиши дело позвонить в банк завтра в 10».") + "</div>";
      }
    }
    const doneBox = $("tasks-done-list");
    if (doneBox) {
      doneBox.classList.toggle("hidden", !tasksShowDone);
      doneBox.innerHTML = "";
      const toggle = $("btn-tasks-done-toggle");
      if (toggle) {
        const n = (board.done || []).length;
        toggle.classList.toggle("active", tasksShowDone);
        toggle.title = tasksShowDone ? "Скрыть выполненные дела" : "Показать выполненные дела";
        const label = toggle.querySelector(".tk-done-label");
        if (label) label.textContent = "Выполненные" + (n ? " · " + n : "");
      }
      if (tasksShowDone) {
        if (!board.done.length) doneBox.innerHTML = '<div class="tasks-empty">Выполненных дел пока нет.</div>';
        else for (const t of board.done) doneBox.appendChild(taskRow(t, true));
      }
    }
    updateTasksBadge(s);
  }
  // «▶ агент» в строке добавления: новое дело можно сразу отдать агенту. Состояние
  // живёт до следующего клика — как приоритет рядом.
  let taskNewAuto = false;
  function paintNewTaskAuto() {
    const b = $("task-new-auto");
    if (!b) return;
    b.classList.toggle("active", taskNewAuto);
    b.textContent = taskNewAuto ? "▶ агент" : "▷ агент";
    b.title = taskNewAuto
      ? "Новое дело получит «▶ агент»: приложение разбудит агента по сроку. Клик — выключить."
      : "Клик — пометить новое дело «▶ агент»: агент выполнит его сам по сроку.";
  }
  function toggleNewTaskAuto() {
    taskNewAuto = !taskNewAuto;
    paintNewTaskAuto();
  }

  async function addTaskFromPanel() {
    if (!tasksSupported()) { toast("Дела: список доступен в приложении на ПК"); return; }
    const titleEl = $("task-new-title");
    const dueEl = $("task-new-due");
    const title = (titleEl.value || "").trim();
    if (!title) { titleEl.focus(); toast("Дела: напиши, что нужно сделать"); return; }
    const r = await api.tasksAdd({
      title: title,
      due: (dueEl.value || "").trim(),
      priority: $("task-new-priority").value,
      auto: taskNewAuto, // «▶ агент» из строки добавления
    });
    if (r && r.ok === false) { toast("Дела: " + r.error); return; }
    titleEl.value = "";
    dueEl.value = "";
    titleEl.focus();
    renderTasks();
  }
  // Быстрые сроки у поля добавления: клик подставляет срок, а если название уже
  // написано — сразу добавляет дело (не надо тянуться к кнопке).
  const QUICK_DUE = ["через час", "сегодня вечером", "завтра 10:00", "в пятницу", "через неделю"];
  function paintQuickDue() {
    const box = $("tasks-quick-due");
    if (!box) return;
    box.innerHTML = "";
    for (const q of QUICK_DUE) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.title = "Срок: " + q;
      b.onclick = () => {
        const dueEl = $("task-new-due");
        if (dueEl) dueEl.value = q;
        const titleEl = $("task-new-title");
        if (titleEl && titleEl.value.trim()) addTaskFromPanel();
        else if (titleEl) titleEl.focus();
      };
      box.appendChild(b);
    }
  }
  function initRolesAndTasks() {
    if ($("btn-role")) $("btn-role").onclick = () => toggleRolePopover();
    paintQuickDue();
    paintNewTaskAuto();
    if ($("task-new-auto")) $("task-new-auto").onclick = () => toggleNewTaskAuto();
    if ($("rail-tasks")) $("rail-tasks").onclick = () => {
      if (sidePanelVisible() && getSideTab() === "tasks") closeSidePanel();
      else openSidePanel("tasks");
    };
    if ($("rail-mission")) $("rail-mission").onclick = () => {
      if (sidePanelVisible() && getSideTab() === "mission") closeSidePanel();
      else openSidePanel("mission");
    };
    initMissionPanel();
    if ($("btn-task-add")) $("btn-task-add").onclick = addTaskFromPanel;
    if ($("task-new-title")) $("task-new-title").onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); addTaskFromPanel(); }
    };
    if ($("task-new-due")) $("task-new-due").onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); addTaskFromPanel(); }
    };
    if ($("btn-tasks-refresh")) $("btn-tasks-refresh").onclick = () => renderTasks();
    if ($("btn-tasks-done-toggle")) $("btn-tasks-done-toggle").onclick = () => {
      tasksShowDone = !tasksShowDone;
      $("btn-tasks-done-toggle").classList.toggle("active", tasksShowDone);
      renderTasks();
    };
    // Клик вне попапа ролей закрывает его (иначе он перекрывает поле ввода).
    document.addEventListener("mousedown", (e) => {
      const box = $("role-popover");
      if (!box || box.classList.contains("hidden")) return;
      if (box.contains(e.target) || ($("btn-role") && $("btn-role").contains(e.target))) return;
      toggleRolePopover(false);
    });
    if (api && api.onTasksChanged) {
      api.onTasksChanged(() => {
        renderTasks();
      });
    }
    renderRoleButton();
    renderRoleChips();
    if (tasksSupported()) api.tasksBoard().then((b) => updateTasksBadge(b && b.summary)).catch(() => {});
  }

  return {
    refreshMission: refreshMission,
    missionFromEvent: missionFromEvent,
    renderTasks: renderTasks,
    initRolesAndTasks: initRolesAndTasks,
  };
});

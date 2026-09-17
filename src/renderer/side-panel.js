"use strict";

/* ─── Правая панель, рельса, консоль и превью ────────────────────────────────
   Вынесено из app.js (этап 9). Здесь состояние правой панели и её разделы,
   рельса слева, свёрнутый список чатов, консоль рабочей папки и превью с
   переключением устройств. Тут же собираются два подмодуля, чьи кнопки живут
   в панели: быстрый запуск проекта (DevRun) и дела с миссией (TasksMission) —
   оболочка берёт их отсюда под своими именами.

   Зависимости приходят одним объектом. Где значение переписывается целиком или
   создаётся позже — приходит ЖИВАЯ функция, а не копия: getSettings (настройки
   грузятся объектом), getChatsData, getStreaming, getProjectPanel и getYcPanel
   (панели проекта и облака создаются ниже панели). Гашение текста — `esc` из
   панели проекта: своя копия разошлась бы с её таблицей значков.

   Наружу — только то, что зовёт оболочка: разделы панели, рельса, консоль,
   превью и два подмодуля. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.SidePanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (SidePanelDeps) {
  const {
    $, api, isElectron, toast, AgentCore, esc, persistSettings, getSettings,
    getProjectPanel, getYcPanel, getChatsData, getStreaming, getActiveChat,
    persistChatsNow, selectChat, renderSidebar, sendMessage, startAutoRunNow, autoResize,
  } = SidePanelDeps || {};

  // ─────────────── Правая панель: превью + консоль (как в Replit) ───────────────
  let sideTab = "preview"; // активная вкладка правой панели
  let termBuf = []; // буфер вывода консоли (рендерится в <pre>)
  let termHist = []; // история команд консоли
  let termHistIdx = -1;
  let termAutostartDone = false;
  let previewLoaded = ""; // последний загруженный URL превью

  // Рельса слева (как в Replit): иконки переиспользуют кнопки шапки, поэтому поведение
  // ровно то же, а подсветка синхронизируется с состоянием панелей.
  function syncRail() {
    const pairs = [
      ["rail-console", "btn-toggle-console"],
      ["rail-preview", "btn-toggle-preview"],
      ["rail-cloud", "btn-toggle-cloud"],
      ["rail-files", "btn-toggle-panel"],
    ];
    for (const [railId, btnId] of pairs) {
      const r = $(railId);
      const b = $(btnId);
      if (r && b) r.classList.toggle("active", b.classList.contains("active"));
    }
    const chats = $("rail-chats");
    const sb = $("sidebar");
    if (chats && sb) chats.classList.toggle("active", !sb.classList.contains("collapsed"));
  }

  // Одна навигация — рельса слева: разделы переключаются только ей, а подсветка
  // ровно одна. Кнопки шапки (видны лишь на телефоне) повторяют ту же подсветку.
  const SP_TITLES = {
    preview: "Превью",
    console: "Консоль",
    cloud: "Yandex Cloud",
    deploy: "Деплой",
    mission: "Миссия",
    tasks: "Дела",
  };
  const PANEL_BTN = { console: "btn-toggle-console", preview: "btn-toggle-preview", cloud: "btn-toggle-cloud", deploy: "btn-toggle-deploy" };
  const RAIL_PANEL = { console: "rail-console", preview: "rail-preview", cloud: "rail-cloud", deploy: "rail-deploy", mission: "rail-mission", tasks: "rail-tasks" };
  function markPanelButtons() {
    const open = sidePanelVisible();
    for (const id of Object.values(PANEL_BTN)) {
      const b = $(id);
      if (b) b.classList.remove("active");
    }
    for (const tab of Object.keys(RAIL_PANEL)) {
      const r = $(RAIL_PANEL[tab]);
      if (r) r.classList.toggle("active", open && sideTab === tab);
    }
    if (open) {
      const b = $(PANEL_BTN[sideTab]);
      if (b) b.classList.add("active");
    }
    syncRail();
  }

  // Свёрнутый список чатов (рельса остаётся на месте). Состояние запоминается:
  // привычка «работаю без списка» не должна сбрасываться при каждом запуске.
  function setSidebarCollapsed(v) {
    const sb = $("sidebar");
    if (!sb) return;
    sb.classList.toggle("collapsed", !!v);
    try { localStorage.setItem("sidebarCollapsed", v ? "1" : "0"); } catch {}
    const b = $("btn-side-collapse");
    if (b) b.title = v ? "Развернуть панель чатов" : "Свернуть панель чатов";
    syncRail();
  }

  function toggleSidebarCollapsed() {
    const sb = $("sidebar");
    setSidebarCollapsed(!(sb && sb.classList.contains("collapsed")));
  }

  function sidePanelVisible() {
    return !$("side-panel").classList.contains("hidden");
  }

  function openSidePanel(tab) {
    sideTab = tab || sideTab;
    $("side-panel").classList.remove("hidden");
    for (const b of document.querySelectorAll(".sp-btn")) {
      b.classList.toggle("active", b.dataset.sp === sideTab);
    }
    $("sp-console").classList.toggle("hidden", sideTab !== "console");
    $("sp-preview").classList.toggle("hidden", sideTab !== "preview");
    const spCloudEl = $("sp-cloud");
    if (spCloudEl) spCloudEl.classList.toggle("hidden", sideTab !== "cloud");
    const spTasksEl = $("sp-tasks");
    if (spTasksEl) spTasksEl.classList.toggle("hidden", sideTab !== "tasks");
    const spMissionEl = $("sp-mission");
    if (spMissionEl) spMissionEl.classList.toggle("hidden", sideTab !== "mission");
    if (sideTab === "mission") TasksMission.refreshMission();
    const spDeployEl = $("sp-deploy");
    if (spDeployEl) spDeployEl.classList.toggle("hidden", sideTab !== "deploy");
    if (sideTab === "deploy" && window.DeployPanel) window.DeployPanel.open(getSettings().workingDir || "");
    if (sideTab === "tasks") TasksMission.renderTasks();
    // Название раздела в шапке панели: на широком экране вкладки скрыты, и это
    // единственная подсказка, куда мы переключились (переключает рельса слева).
    const spTitle = $("sp-title");
    if (spTitle) spTitle.textContent = SP_TITLES[sideTab] || "";
    // Подсветка ровно одна — по активному разделу (раньше загорались три сразу).
    markPanelButtons();
    if (sideTab === "console") {
      ensureTerminal();
      setTimeout(() => $("term-input").focus(), 50);
    }
    if (sideTab === "preview") {
      DevRun.refreshDevControls();
      if (!previewLoaded && getSettings().previewUrl) previewOpen(getSettings().previewUrl);
    }
    if (sideTab === "cloud") {
      getYcPanel().loadDashboard(false);
    }
    syncRail();
  }

  function closeSidePanel() {
    $("side-panel").classList.add("hidden");
    // Панель закрыта — снимаем всю подсветку разделов одним движением.
    markPanelButtons();
  }

  function switchSideTab(tab) {
    openSidePanel(tab);
  }

  // ── Роли чата, дела и миссия — код в src/renderer/tasks-mission.js ──
  // Отдельные модули интерфейса (консоль Yandex Cloud) — в своём файле и не видят
  // замыкание app.js. Тост отдаём наружу явно, а не дублируем его реализацию.
  window.uiToast = toast;
  const TasksMission = window.TasksMission({
    $: $,
    api: api,
    isElectron: isElectron,
    AgentCore: AgentCore,
    toast: toast,
    getActiveChat: getActiveChat,
    // Живые данные чатов: по ним «▶ Продолжить» находит чат самой миссии —
    // продолжать работу надо там, где она шла, а не где открыта панель.
    getChatsData: getChatsData,
    selectChat: selectChat,
    sendMessage: sendMessage,
    autoResize: autoResize,
    persistChatsNow: persistChatsNow,
    renderSidebar: renderSidebar,
    openSidePanel: openSidePanel,
    closeSidePanel: closeSidePanel,
    sidePanelVisible: sidePanelVisible,
    startAutoRunNow: startAutoRunNow,
    getSettings: getSettings,
    isStreaming: () => getStreaming(),
    getSideTab: () => sideTab,
  });

  // ── Консоль ──
  function termAppend(html) {
    const out = $("term-out");
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    termBuf.push(html);
    if (termBuf.length > 3000) termBuf.splice(0, termBuf.length - 3000);
    out.innerHTML = termBuf.join("");
    if (nearBottom) out.scrollTop = out.scrollHeight;
  }

  function termReset() {
    termBuf = [];
    $("term-out").innerHTML = '<div class="term-welcome">Консоль рабочей директории. Логи сервера и вывод команд — здесь. Введи команду ниже (например: ls, npm run dev, bun test).</div>';
  }

  function ensureTerminal() {
    if (!isElectron) return;
    if (termAutostartDone) return;
    termAutostartDone = true;
    api.termStatus().then((st) => {
      if (!st || !st.running) api.termStart().then((r) => {
        if (!r || !r.ok) toast("Консоль: " + ((r && r.error) || "не удалось запустить"));
      });
    });
  }

  function termSend() {
    if (!isElectron) return;
    const inp = $("term-input");
    const text = inp.value.trim();
    if (!text) return;
    termHist.push(text);
    termHistIdx = -1;
    inp.value = "";
    api.termInput(text);
  }

  function onTermEvent(ev) {
    if (!ev) return;
    if (ev.type === "metrics") {
      // Метрики раунда агента из main.js: сколько токенов ушло, попал ли префикс в
      // кэш, сколько ждали ответа. Тихой строкой в «Консоль» (правая панель).
      DevRun.termServerAppend('<span class="ts-metrics">▤ ' + esc(ev.text || "") + "</span>");
    } else if (ev.type === "out") {
      const escTxt = esc(ev.text || "");
      termAppend('<span class="term-plain">' + escTxt + "</span>");
    } else if (ev.type === "agent") {
      const escTxt = esc(ev.text || "").replace(/\n/g, "<br>");
      termAppend('<div class="term-agent">' + escTxt + "</div>");
    } else if (ev.type === "in") {
      const cmd = esc(ev.text || "");
      termAppend('<div class="term-cmd-line"><span class="term-prefix">❯</span> <span class="term-cmd">' + cmd + "</span></div>");
    } else if (ev.type === "start") {
      const cwd = esc(ev.cwd || "");
      termAppend('<div class="term-exit">— терминал запущен' + (cwd ? " в " + cwd : "") + " —</div>");
      $("btn-term-stop").classList.remove("hidden");
    } else if (ev.type === "exit") {
      termAppend('<div class="term-exit">— процесс завершён (код ' + esc(String(ev.code ?? "?")) + (ev.error ? ", " + esc(ev.error) : "") + ") —</div>");
      $("btn-term-stop").classList.add("hidden");
      termAutostartDone = false; // панель можно перезапустить заново
    }
  }

  // ── Превью ──
  function previewOpen(url) {
    const u = String(url || "").trim();
    if (!u) return;
    previewLoaded = u;
    getSettings().previewUrl = u;
    persistSettings();
    // С телефона localhost — это сам телефон; подставляем адрес ПК (мост).
    const shown = window.mobileApi && window.mobileApi.host
      ? u.replace(/^https?:\/\/localhost(:\d+)?/i, "http://" + window.mobileApi.host)
      : u;
    $("preview-url").value = shown;
    $("preview-frame").src = shown;
  }

  function previewSetDevice(w) {
    const dev = $("preview-device");
    dev.style.width = w === "100%" ? "100%" : w + "px";
    dev.classList.toggle("phone", w === "390");
    dev.classList.toggle("tablet", w === "768");
    for (const b of document.querySelectorAll(".dev-btns .dev")) {
      b.classList.toggle("active", b.dataset.w === w);
    }
  }

  function previewOpenTab() {
    const u = $("preview-url").value.trim();
    if (!u) return;
    if (isElectron && api.openExternal && !window.mobileApi) api.openExternal(u);
    else window.open(u, "_blank");
  }

  // ── Быстрый запуск проекта в превью — код в src/renderer/dev-run.js ──
  const DevRun = window.DevRun({
    $: $,
    api: api,
    isElectron: isElectron,
    esc: esc,
    previewOpen: previewOpen,
    projectDir: () => getProjectPanel().projectDir(),
    termAppend: termAppend,
    toast: toast,
    updateStatusBar: () => getProjectPanel().updateStatusBar(),
    getSettings: getSettings,
  });


  // ── Нижняя панель: терминал + превью ──
  $("btn-toggle-console").onclick = () => {
    if (!isElectron) {
      toast("Консоль доступна в приложении на ПК (Windows/macOS/Linux)");
      return;
    }
    if (sidePanelVisible() && sideTab === "console") closeSidePanel();
    else openSidePanel("console");
  };
  $("btn-toggle-preview").onclick = () => {
    if (sidePanelVisible() && sideTab === "preview") closeSidePanel();
    else openSidePanel("preview");
  };

  // ── Рельса слева: иконки нажимают те же кнопки шапки ──
  (() => {
    const proxy = (railId, btnId) => {
      const r = $(railId);
      const b = $(btnId);
      if (!r || !b) return;
      r.onclick = () => {
        b.click();
        syncRail();
        if (window.innerWidth <= 900) $("sidebar").classList.remove("open");
      };
    };
    proxy("rail-console", "btn-toggle-console");
    proxy("rail-preview", "btn-toggle-preview");
    proxy("rail-cloud", "btn-toggle-cloud");
    proxy("rail-deploy", "btn-toggle-deploy");
    proxy("rail-files", "btn-toggle-panel");
    proxy("rail-new", "btn-new-chat");
    proxy("rail-settings", "btn-settings");

    const chats = $("rail-chats");
    if (chats) {
      chats.onclick = () => {
        if (window.innerWidth <= 900) $("sidebar").classList.toggle("open");
        else toggleSidebarCollapsed();
      };
    }
    const collapse = $("btn-side-collapse");
    if (collapse) collapse.onclick = toggleSidebarCollapsed;

    // Состояние панели восстанавливаем: свёрнутость — часть привычного рабочего места.
    try {
      if (localStorage.getItem("sidebarCollapsed") === "1") setSidebarCollapsed(true);
    } catch {}
    syncRail();
  })();
  $("btn-sp-close").onclick = closeSidePanel;
  document.querySelectorAll(".sp-btn").forEach((b) => {
    b.onclick = () => switchSideTab(b.dataset.sp);
  });
  if (isElectron) api.onTermEvent(onTermEvent);
  $("term-input").addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      DevRun.termTabComplete();
    } else if (e.key === "Enter") {
      e.preventDefault();
      termSend();
    } else if (e.key === "ArrowUp") {
      if (!termHist.length) return;
      e.preventDefault();
      termHistIdx = termHistIdx < 0 ? termHist.length - 1 : Math.max(0, termHistIdx - 1);
      $("term-input").value = termHist[termHistIdx];
    } else if (e.key === "ArrowDown") {
      if (termHistIdx < 0) return;
      e.preventDefault();
      termHistIdx++;
      $("term-input").value = termHistIdx < termHist.length ? termHist[termHistIdx] : "";
      if (termHistIdx >= termHist.length) termHistIdx = -1;
    }
  });
  $("btn-term-clear").onclick = termReset;
  $("btn-term-stop").onclick = () => {
    if (isElectron) api.termStop();
  };
  $("btn-preview-open").onclick = () => previewOpen($("preview-url").value);
  // Быстрый запуск/остановка проекта в превью
  $("btn-preview-start").onclick = DevRun.devStartClick;
  $("btn-preview-stop").onclick = DevRun.devStopClick;
  $("preview-cmd").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      DevRun.devStartClick();
    }
  });
  if (isElectron && api.onDevEvent) api.onDevEvent(DevRun.onDevEvent);
  $("preview-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") previewOpen($("preview-url").value);
  });
  $("btn-preview-tab").onclick = previewOpenTab;
  $("btn-preview-reload").onclick = () => {
    if (!previewLoaded) return;
    const f = $("preview-frame");
    f.src = previewLoaded; // перезагрузка сбросом src
  };
  document.querySelectorAll(".dev-btns .dev").forEach((b) => {
    b.onclick = () => previewSetDevice(b.dataset.w);
  });

  return {
    openSidePanel: openSidePanel,
    closeSidePanel: closeSidePanel,
    sidePanelVisible: sidePanelVisible,
    getSideTab: () => sideTab,
    switchSideTab: switchSideTab,
    syncRail: syncRail,
    termAppend: termAppend,
    termReset: termReset,
    previewOpen: previewOpen,
    DevRun: DevRun,
    TasksMission: TasksMission,
  };
});

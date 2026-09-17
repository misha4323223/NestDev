"use strict";

/* ─── Палитра команд (Ctrl+K) и быстрый переход к файлу (Ctrl+P) ──────────────
   Вынесено из app.js (этап 8). Здесь список действий по разделам, поиск и
   сортировка, сборка списка файлов проекта, отрисовка с подсветкой, обработка
   клавиш внутри палитры и запуск выбранного действия.

   Зависимости приходят одним объектом. Состояние генерации — ЖИВОЙ функцией
   (getStreaming), а не копией: «Остановить агента» появляется в списке только
   во время ответа, и копия переменной застыла бы на времени загрузки окна.
   Вызовы наружу: только openPalette (Ctrl+K, Ctrl+Shift+P) и enterFileMode (Ctrl+P). */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.CommandPalette = factory;
  }
})(typeof self !== "undefined" ? self : this, function (CommandPaletteDeps) {
  const {
    $, api, isElectron, toast, createChat, stop, getStreaming,
    openSidePanel, termReset, ChatActions, ProjectPanel, SettingsPanel,
  } = CommandPaletteDeps || {};

  // ═══ Палитра команд (Ctrl+K): действия и файлы ═══
  let paletteItems = [];
  let paletteIndex = 0;
  let paletteMode = "actions";
  let paletteFiles = null;

  function paletteActions() {
    const acts = [];
    const A = (icon, title, hint, group, run, when) =>
      acts.push({ icon: icon, title: title, hint: hint || "", group: group, run: run, when: when || null });

    A("💬", "Новый чат", "Ctrl+N", "Чат", () => createChat());
    A("🔄", "Продолжить контекст предыдущего чата", "", "Чат", () => $("btn-continue-chat").click());
    A("🔍", "Поиск по чатам", "Ctrl+Shift+K", "Чат", () => {
      closePalette();
      $("chat-search").focus();
      $("chat-search").select();
    });
    A("📋", "Скопировать чат в буфер", "markdown", "Чат", () => ChatActions.copyChat());
    A("⏹", "Остановить агента", "", "Чат", () => stop(), () => getStreaming());

    A("📄", "Открыть файл…", "Ctrl+P", "Файлы и проект", () => enterFileMode(), () => isElectron);
    A("📂", "Панель проекта: файлы", "", "Файлы и проект", () => ProjectPanel.showPanelTab("files"), () => isElectron);
    A("✏️", "Панель проекта: изменения", "", "Файлы и проект", () => ProjectPanel.showPanelTab("changes"), () => isElectron);
    A("🕘", "Панель проекта: коммиты", "", "Файлы и проект", () => ProjectPanel.showPanelTab("commits"), () => isElectron);
    A("➕", "Новый файл", "", "Файлы и проект", () => ProjectPanel.newProjectFile(), () => isElectron);
    A("🗂", "Новая папка", "", "Файлы и проект", () => ProjectPanel.newProjectFolder(), () => isElectron);
    A("🔎", "Поиск по коду (семантический)", "агент", "Файлы и проект", () => {
      $("input").value = "найди в проекте: ";
      $("input").focus();
    }, () => isElectron);

    A("💾", "Закоммитить изменения", "", "Git и GitHub", () => ProjectPanel.showPanelTab("changes"), () => isElectron);
    A("📤", "Push на GitHub", "", "Git и GitHub", () => ProjectPanel.doPush(), () => isElectron);
    A("📥", "Pull из GitHub", "", "Git и GitHub", () => ProjectPanel.doPull(), () => isElectron);
    A("⬆", "Опубликовать проект на GitHub", "новый репозиторий", "Git и GitHub", () => ProjectPanel.openPublishDialog(), () => isElectron);

    A("🖥", "Превью и консоль", "", "Запуск и хостинг", () => openSidePanel("preview"), () => isElectron);
    A("⌨️", "Консоль", "логи и команды", "Запуск и хостинг", () => openSidePanel("console"), () => isElectron);
    A("🧹", "Очистить консоль", "", "Запуск и хостинг", () => {
      openSidePanel("console");
      termReset();
    }, () => isElectron);
    A("☁️", "Yandex Cloud — ресурсы", "", "Запуск и хостинг", () => openSidePanel("cloud"), () => isElectron);
    A("🚀", "Задеплоить на Yandex Cloud", "контейнер", "Запуск и хостинг", () => {
      openSidePanel("cloud");
      $("btn-yc-deploy").click();
    }, () => isElectron);

    A("🤖", "Настройки: модель", "", "Настройки", () => SettingsPanel.openSettings("model"));
    A("🔒", "Настройки: секреты и переменные", "", "Настройки", () => {
      SettingsPanel.openSettings("secrets");
    });
    A("🐙", "Настройки: GitHub и проект", "", "Настройки", () => {
      SettingsPanel.openSettings("project");
    });
    A("👁", "Настройки: зрение и картинки", "", "Настройки", () => {
      SettingsPanel.openSettings("vision");
    });
    A("📱", "Настройки: мобильный доступ", "", "Настройки", () => {
      SettingsPanel.openSettings("mobile");
    });
    A("☁️", "Настройки: Yandex Cloud", "", "Настройки", () => {
      SettingsPanel.openSettings("yandex");
    });
    A("🔄", "Настройки: self-update (OTA)", "", "Настройки", () => {
      SettingsPanel.openSettings("ota");
    });
    A("🛠", "Проверить подключение к модели", "", "Настройки", () => {
      SettingsPanel.openSettings("model");
      SettingsPanel.testConnection();
    });
    A("📈", "Замерить скорость локальной модели", "", "Настройки", () => {
      SettingsPanel.openSettings("model");
      SettingsPanel.probeLocalModelUI();
    });
    return acts;
  }

  function paletteFilter(query) {
    const all = paletteItems.filter((it) => !it.when || it.when());
    const q = String(query || "").trim().toLowerCase();
    if (!q) return all;
    const scored = [];
    for (let i = 0; i < all.length; i++) {
      const it = all[i];
      const title = String(it.title || "").toLowerCase();
      const hay = title + " " + String(it.hint || "").toLowerCase() + " " + String(it.group || "").toLowerCase();
      const pos = hay.indexOf(q);
      if (pos === -1) continue;
      scored.push({ it: it, score: title.indexOf(q) === 0 ? 0 : pos + 1 });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.it);
  }

  function paletteRows() {
    return Array.prototype.slice.call($("palette-list").querySelectorAll(".palette-row"));
  }

  function paletteHighlight() {
    const rows = paletteRows();
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle("active", i === paletteIndex);
    const cur = rows[paletteIndex];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }

  function paletteRender() {
    const list = $("palette-list");
    const items = paletteFilter($("palette-input").value);
    if (paletteIndex >= items.length) paletteIndex = Math.max(0, items.length - 1);
    if (paletteIndex < 0) paletteIndex = 0;
    list.innerHTML = "";
    if (!items.length) {
      const d = document.createElement("div");
      d.className = "palette-empty";
      d.textContent = paletteMode === "files" ? "Файлы не найдены (проект не выбран?)" : "Ничего не найдено";
      list.appendChild(d);
      return;
    }
    let lastGroup = "";
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.group && it.group !== lastGroup) {
        lastGroup = it.group;
        const h = document.createElement("div");
        h.className = "palette-sec";
        h.textContent = it.group;
        list.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "palette-row" + (i === paletteIndex ? " active" : "");
      const ic = document.createElement("span");
      ic.className = "pr-ic";
      ic.textContent = it.icon || "•";
      const t = document.createElement("span");
      t.className = "pr-title";
      t.textContent = it.title;
      row.appendChild(ic);
      row.appendChild(t);
      if (it.hint) {
        const hh = document.createElement("span");
        hh.className = "pr-hint";
        hh.textContent = it.hint;
        row.appendChild(hh);
      }
      row.onclick = () => paletteRun(it);
      row.onmousemove = () => {
        if (paletteIndex !== i) {
          paletteIndex = i;
          paletteHighlight();
        }
      };
      list.appendChild(row);
    }
  }

  function openPalette(mode) {
    paletteMode = mode || "actions";
    paletteItems = paletteMode === "files" ? paletteFiles || [] : paletteActions();
    paletteIndex = 0;
    const ic = $("palette-ic");
    const inp = $("palette-input");
    if (ic) ic.textContent = paletteMode === "files" ? "📄" : "⌘";
    if (inp) {
      inp.placeholder = paletteMode === "files" ? "Имя файла…" : "Действие или файл…";
      inp.value = "";
    }
    $("palette-overlay").classList.remove("hidden");
    paletteRender();
    if (inp) inp.focus();
  }

  function closePalette() {
    $("palette-overlay").classList.add("hidden");
  }

  function paletteRun(item) {
    closePalette();
    try {
      item.run();
    } catch (e) {
      toast("Не удалось выполнить: " + ((e && e.message) || e));
    }
  }

  // Список файлов проекта для быстрого перехода (Ctrl+P)
  async function collectProjectFiles(dir, limit) {
    const out = [];
    const skip = { node_modules: 1, ".git": 1, dist: 1, build: 1, out: 1, ".next": 1, ".nuxt": 1, __pycache__: 1, venv: 1, ".venv": 1, ".idea": 1, ".vscode": 1, coverage: 1 };
    const clean = String(dir || "").replace(/[\\/]+$/, "");
    async function walk(d, prefix) {
      if (out.length >= limit) return;
      const r = await api.fsListTree(d);
      if (!r || !r.ok) return;
      for (let i = 0; i < r.entries.length; i++) {
        if (out.length >= limit) return;
        const e = r.entries[i];
        if (e.isDir) {
          if (skip[e.name]) continue;
          await walk(d + "/" + e.name, prefix + e.name + "/");
        } else {
          const full = d + "/" + e.name;
          out.push({
            icon: ProjectPanel.fileIcon(e.name),
            title: e.name,
            hint: prefix ? prefix.replace(/\/$/, "") : "корень",
            group: prefix ? "📁 " + prefix.replace(/\/$/, "") : "📄 корень проекта",
            run: () => ProjectPanel.viewFile(full),
          });
        }
      }
    }
    if (clean) await walk(clean, "");
    return out;
  }

  async function enterFileMode() {
    if (!isElectron) {
      toast("Доступно в приложении на ПК");
      return;
    }
    if (!ProjectPanel.projectDir()) {
      toast("Сначала выбери рабочую папку проекта");
      return;
    }
    if (!paletteFiles) {
      toast("Собираю список файлов…");
      paletteFiles = await collectProjectFiles(ProjectPanel.projectDir(), 1200);
    }
    openPalette("files");
  }

  if ($("palette-input")) {
    $("palette-input").addEventListener("input", () => {
      paletteIndex = 0;
      paletteRender();
    });
    $("palette-input").addEventListener("keydown", (e) => {
      const items = paletteFilter($("palette-input").value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        paletteIndex = Math.min(paletteIndex + 1, items.length - 1);
        paletteHighlight();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        paletteIndex = Math.max(paletteIndex - 1, 0);
        paletteHighlight();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[paletteIndex];
        if (it) paletteRun(it);
      } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        closePalette();
      }
    });
  }
  if ($("palette-overlay")) {
    $("palette-overlay").addEventListener("click", (e) => {
      if (e.target === $("palette-overlay")) closePalette();
    });
  }

  return {
    openPalette: openPalette,
    enterFileMode: enterFileMode,
  };
});

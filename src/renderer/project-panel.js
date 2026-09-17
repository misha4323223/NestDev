"use strict";

/* ─── Панель проекта: файлы, правка, вкладки, коммиты, изменения, публикация ───
   Вынесено из app.js (этап 7). Здесь дерево файлов и проекты, чтение файла с
   подсветкой, правка поверх подсвеченного слоя, вкладки открытых файлов, создание
   и удаление, коммиты, вкладка «Изменения» с диффом, публикация папки в новый
   репозиторий GitHub, выбор репозитория, ширина панели перетаскиванием и вся их
   проводка событий.

   Зависимости приходят одним объектом. Где значение переписывается целиком —
   приходит ЖИВАЯ функция, а не копия: getSettings/setSettings (настройки грузятся
   и сохраняются объектом), setFileViewPath (оболочка гасит текущий файл, показывая
   картинку или дифф), setSbVersion (версию кода в строку состояния пишет панель
   настроек). Список репозиториев GitHub (githubReposList) переехал сюда вместе с
   блоком — окно его больше не держит. */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory;
  } else {
    root.ProjectPanel = factory;
  }
})(typeof self !== "undefined" ? self : this, function (ProjectPanelDeps) {
  const {
    $, api, isElectron, getSettings, setSettings, normalize, persistSettings,
    toast, syncRail, toggleModelPopup, openSidePanel, ensureProjectChat,
    DevRun, SettingsPanel,
  } = ProjectPanelDeps || {};

  let githubReposList = null; // переехал из оболочки: окно его не читает

  // ─────────────── Панель проекта: файлы + коммиты ───────────────
  let panelTab = "files";
  const selectedChanges = new Set(); // выбранные файлы для массовых операций
  let repoRoot = null;
  let treeGitStatus = null; // rel-путь → "new" | "mod" для подсветки дерева
  const treeLoading = new Set();
  const pathSep = isElectron && navigator.platform && navigator.platform.includes("Win") ? "\\" : "/";

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }

  function formatSize(n) {
    if (n == null || n < 0) return "";
    if (n < 1024) return n + " Б";
    if (n < 1048576) return (n / 1024).toFixed(1) + " КБ";
    return (n / 1048576).toFixed(1) + " МБ";
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (x) => String(x).padStart(2, "0");
    return (
      pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes())
    );
  }

  function toastShort(text) {
    toast(String(text || "").slice(0, 160));
  }

  function togglePanel() {
    if (!isElectron) {
      toast("Панель проекта доступна в приложении на ПК");
      return;
    }
    const panel = $("project-panel");
    const wasHidden = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !wasHidden);
    $("btn-toggle-panel").classList.toggle("active", wasHidden);
    syncRail();
    if (wasHidden) {
      refreshProject();
      refreshProjects();
    }
  }

  // Активная директория проекта: если выбран GitHub-репозиторий — работаем в нём,
  // иначе — в рабочей директории.
  function projectDir() {
    // Панель показывает папку последнего склонированного репозитория (кнопка «⬇ Выгрузить»
    // или поле «Клонировать») — даже если рабочая директория недоступна для записи и клон
    // автоматически ушёл в запасную записываемую папку.
    if (isElectron && getSettings().githubRepoDir) return getSettings().githubRepoDir;
    return getSettings().workingDir || "";
  }

  function refreshProject() {
    refreshTree();
    Promise.resolve(refreshRepo())
      .then(updateStatusBar)
      .catch(() => {});
  }

  // ── Проекты (переключатель в панели) ──
  function refreshProjects() {
    const row = $("project-select").closest(".project-switch");
    if (!isElectron) {
      row.classList.add("hidden");
      return;
    }
    row.classList.remove("hidden");
    api.projectsList().then((r) => {
      if (!r || !r.ok) return;
      const sel = $("project-select");
      sel.innerHTML = "";
      if (!r.projects.length) {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "Нет проектов — создай ＋";
        sel.appendChild(o);
        $("btn-project-add").disabled = false;
        $("btn-project-remove").disabled = true;
        return;
      }
      r.projects.forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = p.name + (p.exists ? "" : " ⚠");
        o.title = p.dir;
        if (p.id === r.activeId) o.selected = true;
        sel.appendChild(o);
      });
      $("btn-project-add").disabled = r.projects.length >= 10;
      $("btn-project-remove").disabled = !r.activeId;
      updateStatusBar();
    });
  }

  async function switchProject(id) {
    if (!id) return;
    const r = await api.projectsActivate(id);
    if (!r || !r.ok) {
      toast((r && r.error) || "Не удалось переключить проект");
      refreshProjects();
      return;
    }
    const s = await api.getSettings();
    setSettings(normalize(s));
    $("s-workdir").value = getSettings().workingDir || "";
    // Переключаемся на чат, привязанный к этому проекту (или создаём новый).
    ensureProjectChat(id, r.project && r.project.name);
    toast("Проект: " + (r.project && r.project.name));
    refreshProject();
    refreshProjects();
    refreshRepo();
    DevRun.refreshDevControls();
  }

  // ── Файлы ──
  function fileIcon(name) {
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"].includes(ext)) return "🖼";
    if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "exe", "dmg", "msi", "jar", "apk"].includes(ext)) return "📦";
    if (["md", "txt", "rst"].includes(ext)) return "📝";
    return "📄";
  }

  async function refreshTree() {
    const dir = projectDir();
    $("panel-dir-path").textContent = dir || "Рабочая директория не выбрана";
    $("panel-dir-path").title = dir;
    const tree = $("tree");
    tree.innerHTML = "";
    if (!isElectron || !dir) {
      tree.innerHTML = '<div class="tree-empty">Нажми 📁, чтобы выбрать рабочую папку, или клонируй репозиторий ниже.</div>';
      return;
    }
    // Карта git-статусов (для подсветки новых/изменённых файлов в дереве):
    // rel-путь → "new" (не отслеживается) | "mod" (изменён/в индексе).
    treeGitStatus = {};
    if (isElectron && repoRoot) {
      try {
        const st = await api.gitStatus(repoRoot);
        if (st && st.ok) {
          for (const f of st.untracked) treeGitStatus[f.replace(/\\/g, "/")] = "new";
          for (const f of st.staged) treeGitStatus[f.replace(/\\/g, "/")] = "mod";
          for (const f of st.unstaged) treeGitStatus[f.replace(/\\/g, "/")] = "mod";
        }
      } catch {}
    }
    const node = document.createElement("div");
    node.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row root";
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    caret.textContent = "▾";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "🗂";
    const name = document.createElement("span");
    name.className = "tree-name";
    const base = dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    name.textContent = base;
    row.title = dir;
    row.appendChild(caret);
    row.appendChild(icon);
    row.appendChild(name);
    const children = document.createElement("div");
    children.className = "tree-children";
    node.appendChild(row);
    node.appendChild(children);
    tree.appendChild(node);
    await loadChildren(node, dir);
  }

  async function loadChildren(nodeEl, dir) {
    const wrap = nodeEl.querySelector(".tree-children");
    if (treeLoading.has(dir)) return;
    treeLoading.add(dir);
    const res = await api.fsListTree(dir);
    treeLoading.delete(dir);
    wrap.innerHTML = "";
    if (!res || !res.ok) {
      wrap.innerHTML = '<div class="tree-empty">' + esc(res && res.error) + "</div>";
      return;
    }
    if (!res.entries.length) {
      wrap.innerHTML = '<div class="tree-empty">Пусто</div>';
      return;
    }
    for (const e of res.entries) wrap.appendChild(buildTreeEntry(e, dir));
    nodeEl.classList.add("open");
  }

  function buildTreeEntry(e, parentDir) {
    const full = parentDir.replace(/[\\/]+$/, "") + pathSep + e.name;
    const node = document.createElement("div");
    node.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.title = full;
    const caret = document.createElement("span");
    caret.className = "tree-caret";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = e.name;
    const children = document.createElement("div");
    children.className = "tree-children";
    const actions = document.createElement("span");
    actions.className = "tree-actions";
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.className = "danger";
    if (e.isDir) {
      caret.textContent = "▸";
      icon.textContent = "📁";
      row.appendChild(caret);
      row.appendChild(icon);
      row.appendChild(name);
      row.classList.add("dir");
      row.dataset.dir = full;
      row.onclick = () => {
        const open = node.classList.contains("open");
        if (!open) {
          caret.textContent = "▾";
          loadChildren(node, full);
        } else {
          caret.textContent = "▸";
          node.classList.remove("open");
          node.querySelector(".tree-children").innerHTML = "";
        }
      };
      delBtn.title = "Удалить папку целиком";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        deleteFsItem(full, true);
      };
      actions.appendChild(delBtn);
    } else {
      caret.textContent = " ";
      icon.textContent = fileIcon(e.name);
      row.title = full + (e.size != null ? " · " + formatSize(e.size) : "");
      row.classList.add("file");
      row.onclick = () => viewFile(full);
      row.appendChild(caret);
      row.appendChild(icon);
      row.appendChild(name);
      // Подсветка git-статуса: 🆕 новый файл, ✏️ изменённый
      if (treeGitStatus) {
        const rel = full.startsWith(repoRoot + "/") || full.startsWith(repoRoot + "\\")
          ? full.slice(repoRoot.length + 1).replace(/\\/g, "/")
          : null;
        const kind = rel && treeGitStatus[rel];
        if (kind) {
          row.classList.add(kind === "new" ? "tree-new" : "tree-mod");
          const mark = document.createElement("span");
          mark.className = "tree-mark";
          mark.textContent = kind === "new" ? "🆕" : "✏️";
          mark.title = kind === "new" ? "Новый файл (ещё не в git)" : "Изменён относительно последнего коммита";
          row.insertBefore(mark, name.nextSibling);
        }
      }
      const editBtn = document.createElement("button");
      editBtn.textContent = "✎";
      editBtn.title = "Открыть и редактировать";
      editBtn.onclick = (ev) => {
        ev.stopPropagation();
        viewFile(full, { edit: true });
      };
      actions.appendChild(editBtn);
      delBtn.title = "Удалить файл";
      delBtn.onclick = (ev) => {
        ev.stopPropagation();
        deleteFsItem(full, false);
      };
      actions.appendChild(delBtn);
    }
    row.appendChild(actions);
    node.appendChild(row);
    node.appendChild(children);
    return node;
  }

  // ═══ Файлы: вкладки, нумерация строк, подсветка синтаксиса ═══
  let fileViewPath = "";   // путь активного файла (для кнопок панели)
  let fileCanEdit = false; // текстовый ли активный файл
  let openFiles = [];      // [{ path, content, orig, loaded, dirty, truncated, binary, image }]
  let editMode = false;    // активная вкладка открыта в редакторе
  let hlInEditor = true;   // подсветка в редакторе (кнопка ✨)
  let editorRepaint = null; // перерисовать слой подсветки в открытом редакторе
  const MAX_VIEW_LINES = 8000;

  function hl(code, name) {
    return window.Highlight && window.Highlight.highlight ? window.Highlight.highlight(code, name) : escHtml(code);
  }

  function activeFile() {
    for (let i = 0; i < openFiles.length; i++) if (openFiles[i].path === fileViewPath) return openFiles[i];
    return null;
  }

  function isImagePath(p) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(String(p || ""));
  }

  function fileErrorEl(text) {
    const d = document.createElement("div");
    d.className = "file-error";
    d.textContent = text;
    return d;
  }

  function updateFileToolbar() {
    const f = activeFile();
    const img = !!(f && f.image);
    const editBtn = $("btn-file-edit");
    const saveBtn = $("btn-file-save");
    const hlBtn = $("btn-file-hl");
    const delBtn = $("btn-file-delete");
    if (editBtn) editBtn.classList.toggle("hidden", editMode || img || !fileCanEdit);
    if (saveBtn) saveBtn.classList.toggle("hidden", !editMode);
    if (hlBtn) {
      hlBtn.classList.toggle("hidden", !editMode);
      hlBtn.classList.toggle("active", hlInEditor);
    }
    if (delBtn) delBtn.classList.toggle("hidden", !fileViewPath);
  }

  // Открыть файл: новая вкладка или активация уже открытой (opts.edit — сразу редактор)
  async function viewFile(p, opts) {
    opts = opts || {};
    if (!isElectron || !p) return;
    let f = null;
    for (let i = 0; i < openFiles.length; i++) if (openFiles[i].path === p) f = openFiles[i];
    if (!f) {
      f = { path: p, content: "", orig: "", loaded: false, dirty: false, truncated: false, binary: false, image: isImagePath(p) };
      openFiles.push(f);
    }
    fileViewPath = p;
    editMode = !!opts.edit && !f.image;
    $("file-overlay").classList.remove("hidden");
    renderFileTabs();
    await loadActiveFile();
  }

  async function loadActiveFile() {
    const f = activeFile();
    const content = $("file-content");
    if (!f) {
      content.innerHTML = "";
      updateFileToolbar();
      return;
    }
    $("file-path").textContent = f.path;
    $("file-path").title = f.path;
    if (f.image) {
      fileCanEdit = false;
      updateFileToolbar();
      const imgRes = await api.fsReadImage(f.path);
      content.innerHTML = "";
      if (!imgRes || !imgRes.ok) {
        content.appendChild(fileErrorEl((imgRes && imgRes.error) || "Не удалось прочитать изображение"));
        return;
      }
      const img = document.createElement("img");
      img.className = "image-view";
      img.src = imgRes.dataUrl;
      img.alt = f.path;
      content.appendChild(img);
      return;
    }
    // Несохранённые правки не перечитываем с диска — иначе потеряем их
    if (!f.loaded || !f.dirty) {
      const res = await api.fsReadFile(f.path);
      if (!res || !res.ok) {
        f.loaded = true;
        f.content = "";
        f.binary = true;
        f.truncated = false;
        fileCanEdit = false;
        content.innerHTML = "";
        content.appendChild(fileErrorEl((res && res.error) || "Не удалось прочитать файл"));
        updateFileToolbar();
        return;
      }
      f.content = res.content || "";
      f.truncated = !!res.truncated;
      f.binary = !!res.binary;
      f.loaded = true;
      f.orig = f.content;
    }
    fileCanEdit = !f.truncated && !f.binary;
    updateFileToolbar();
    if (editMode && fileCanEdit) renderFileEditor(f.content);
    else renderFileView(f);
  }

  // ── Чтение: нумерация строк + подсветка ──
  function renderFileView(f) {
    editorRepaint = null;
    const content = $("file-content");
    content.innerHTML = "";
    const lines = String(f.content || "").split("\n");
    const shown = lines.slice(0, MAX_VIEW_LINES);
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    const gutter = document.createElement("div");
    gutter.className = "code-gutter";
    for (let i = 0; i < shown.length; i++) {
      const d = document.createElement("div");
      d.className = "code-gn";
      d.textContent = String(i + 1);
      gutter.appendChild(d);
    }
    const pre = document.createElement("pre");
    pre.className = "code-pre";
    pre.innerHTML = hl(shown.join("\n"), f.path);
    wrap.appendChild(gutter);
    wrap.appendChild(pre);
    content.appendChild(wrap);
    if (f.truncated) content.appendChild(fileErrorEl("Файл обрезан — показаны первые 300 КБ."));
  }

  // ── Правка: textarea поверх подсвеченного слоя + нумерация ──
  function renderFileEditor(text) {
    const content = $("file-content");
    content.innerHTML = "";
    const f = activeFile();
    const name = f ? f.path : "";
    const hint = document.createElement("div");
    hint.className = "file-edit-hint";
    hint.textContent = "Редактирование: " + name + " — Ctrl+S сохранить, Tab — отступ, ✨ — подсветка.";
    const wrap = document.createElement("div");
    wrap.className = "code-edit-wrap" + (hlInEditor ? "" : " no-hl");
    const gutter = document.createElement("div");
    gutter.className = "code-edit-gutter";
    const gin = document.createElement("div");
    gutter.appendChild(gin);
    const box = document.createElement("div");
    box.className = "code-edit-box";
    const pre = document.createElement("pre");
    pre.className = "code-hl";
    const ta = document.createElement("textarea");
    ta.className = "code-input";
    ta.id = "file-editor";
    ta.spellcheck = false;
    ta.value = text;
    ta.setAttribute("wrap", "off");
    box.appendChild(pre);
    box.appendChild(ta);
    wrap.appendChild(gutter);
    wrap.appendChild(box);
    content.appendChild(hint);
    content.appendChild(wrap);

    function paintGutter() {
      const n = window.Highlight && window.Highlight.countLines ? window.Highlight.countLines(ta.value) : ta.value.split("\n").length;
      if (gin.childElementCount === n) return;
      gin.innerHTML = "";
      for (let i = 0; i < n; i++) {
        const d = document.createElement("div");
        d.className = "code-egn";
        d.textContent = String(i + 1);
        gin.appendChild(d);
      }
    }
    const LIVE_HL_MAX = 150 * 1024; // живая подсветка — до 150 КБ текста
    let hlWarned = false;
    function paintCode() {
      const tooBig = ta.value.length > LIVE_HL_MAX;
      if (!hlInEditor || tooBig) {
        wrap.classList.add("no-hl"); // текст в textarea прозрачный — показываем его явно
        pre.innerHTML = "";
        if (tooBig && hlInEditor && !hlWarned) {
          hlWarned = true;
          toast("Файл большой — подсветка в редакторе отключена, текст обычный");
        }
        return;
      }
      wrap.classList.remove("no-hl");
      pre.innerHTML = hl(ta.value, name) + "\n";
    }
    function syncScroll() {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gin.style.transform = "translateY(" + -ta.scrollTop + "px)";
    }
    // Кнопка ✨ в шапке панели дёргает этот хук
    editorRepaint = function () {
      wrap.classList.toggle("no-hl", !hlInEditor);
      paintCode();
      syncScroll();
    };
    ta.addEventListener("input", () => {
      const cur = activeFile();
      if (cur) {
        cur.content = ta.value;
        cur.dirty = cur.content !== (cur.orig || "");
      }
      renderFileTabs();
      paintGutter();
      paintCode();
      syncScroll();
    });
    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveEditedFile();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const s0 = ta.selectionStart;
        const s1 = ta.selectionEnd;
        ta.value = ta.value.slice(0, s0) + "  " + ta.value.slice(s1);
        ta.selectionStart = ta.selectionEnd = s0 + 2;
        ta.dispatchEvent(new Event("input"));
      }
    });
    paintGutter();
    paintCode();
    syncScroll();
    ta.focus();
    try {
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } catch {}
  }

  async function saveEditedFile() {
    const ta = $("file-editor");
    const f = activeFile();
    if (!ta || !f) return;
    const text = ta.value;
    if (text.length > 2 * 1024 * 1024) {
      toast("Файл слишком большой для сохранения из панели (максимум 2 МБ)");
      return;
    }
    const r = await api.fsWriteFile(f.path, text);
    toastShort(r && r.ok ? "✅ Сохранено: " + f.path : "❌ " + ((r && r.error) || "Ошибка сохранения"));
    if (r && r.ok) {
      f.content = text;
      f.orig = text;
      f.dirty = false;
      f.loaded = true;
      f.truncated = false;
      f.binary = false;
      refreshTree();
      renderFileTabs();
      editMode = false;
      renderFileView(f);
      updateFileToolbar();
    }
  }

  // ── Вкладки открытых файлов ──
  function renderFileTabs() {
    const box = $("file-tabs");
    if (!box) return;
    box.innerHTML = "";
    for (let i = 0; i < openFiles.length; i++) {
      const f = openFiles[i];
      const tab = document.createElement("div");
      tab.className = "file-tab" + (f.path === fileViewPath ? " active" : "");
      tab.title = f.path;
      const icon = document.createElement("span");
      icon.textContent = fileIcon(f.path);
      const nm = document.createElement("span");
      nm.className = "file-tab-name";
      nm.textContent = pathBase(f.path);
      tab.appendChild(icon);
      tab.appendChild(nm);
      if (f.dirty) {
        const d = document.createElement("span");
        d.className = "file-tab-dot";
        d.title = "Есть несохранённые правки";
        tab.appendChild(d);
      }
      const x = document.createElement("button");
      x.className = "file-tab-x";
      x.textContent = "✕";
      x.title = "Закрыть вкладку";
      x.onclick = (ev) => {
        ev.stopPropagation();
        closeFileTab(f.path);
      };
      tab.appendChild(x);
      tab.onclick = () => activateFileTab(f.path);
      box.appendChild(tab);
    }
  }

  async function activateFileTab(p) {
    if (p === fileViewPath) return;
    fileViewPath = p;
    editMode = false;
    renderFileTabs();
    await loadActiveFile();
  }

  function closeFileTab(p) {
    const i = openFiles.findIndex((f) => f.path === p);
    if (i < 0) return;
    openFiles.splice(i, 1);
    if (fileViewPath === p) {
      const next = openFiles[i] || openFiles[i - 1] || null;
      fileViewPath = next ? next.path : "";
      editMode = false;
    }
    renderFileTabs();
    if (!fileViewPath) {
      $("file-overlay").classList.add("hidden");
      return;
    }
    loadActiveFile();
  }

  // Закрыть вкладки удалённого файла или папки
  function closeTabsUnder(p) {
    const pref = String(p || "").replace(/[\\/]+$/, "") + "/";
    const rest = openFiles.filter((f) => f.path !== p && f.path.replace(/\\/g, "/").indexOf(pref.replace(/\\/g, "/")) !== 0);
    if (rest.length === openFiles.length) return;
    openFiles = rest;
    if (!activeFile()) fileViewPath = "";
    renderFileTabs();
    if (!fileViewPath) {
      editMode = false;
      $("file-overlay").classList.add("hidden");
    }
  }

  // ── Ручное создание / удаление файлов и папок ──
  let inputResolver = null;

  function inputDialog(title, hintText, okLabel) {
    return new Promise((resolve) => {
      inputResolver = resolve;
      $("input-title").textContent = title;
      $("input-hint").textContent = hintText || "";
      $("input-value").value = "";
      const ok = $("btn-input-ok");
      ok.textContent = okLabel || "Создать";
      $("input-overlay").classList.remove("hidden");
      setTimeout(() => { $("input-value").focus(); }, 30);
    });
  }

  function resolveInput(value) {
    $("input-overlay").classList.add("hidden");
    const cb = inputResolver;
    inputResolver = null;
    if (cb) cb(value);
  }

  // ── Диалог «Новый проект» ──
  let projectChosenDir = "";
  function openProjectDialog() {
    projectChosenDir = "";
    $("project-name").value = "";
    $("project-dir").value = "";
    $("project-hint").textContent = "";
    $("btn-project-ok").disabled = false;
    $("project-overlay").classList.remove("hidden");
    setTimeout(() => { $("project-name").focus(); }, 30);
  }
  function closeProjectDialog() {
    $("project-overlay").classList.add("hidden");
  }

  async function newProjectFile() {
    if (!isElectron) return;
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери рабочую директорию (📁)");
      return;
    }
    const name = await inputDialog("Новый файл", "Создаётся в корне: " + dir + " (имя без слэшей)");
    if (!name || !name.trim()) return;
    const r = await api.fsCreateFile(dir, name, "");
    if (!r || !r.ok) {
      toastShort("❌ " + ((r && r.error) || "Не удалось создать файл"));
      return;
    }
    toastShort("✅ Файл создан: " + r.path);
    refreshTree();
    viewFile(r.path, { edit: true });
  }

  async function newProjectFolder() {
    if (!isElectron) return;
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери рабочую директорию (📁)");
      return;
    }
    const name = await inputDialog("Новая папка", "Создаётся в корне: " + dir + " (имя без слэшей)");
    if (!name || !name.trim()) return;
    const r = await api.fsCreateFolder(dir, name);
    toastShort(r && r.ok ? "✅ Папка создана: " + r.path : "❌ " + ((r && r.error) || "Не удалось создать папку"));
    if (r && r.ok) refreshTree();
  }

  function pathBase(p) {
    return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  }

  function deleteFsItem(p, isDir) {
    const nm = pathBase(p);
    confirmModal(
      "Удалить «" + nm + "»?",
      isDir ? "Папка будет удалена вместе со всем содержимым (рекурсивно). Действие необратимо." : "Файл будет удалён безвозвратно.",
      async () => {
        const r = await api.fsDelete(p);
        toastShort(r && r.ok ? "✅ Удалено: " + nm : "❌ " + ((r && r.error) || "Ошибка удаления"));
        if (r && r.ok) {
          closeTabsUnder(p);
          refreshTree();
        }
      },
      true
    );
  }

  // ── Перетаскивание файлов и изображений в панель проекта ──
  function collectDrop(dt) {
    return new Promise((resolve) => {
      const out = [];
      const queue = [];
      const dtItems = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
      for (const it of dtItems) {
        if (!it || it.kind !== "file") continue;
        const entry = typeof it.webkitGetAsEntry === "function" ? it.webkitGetAsEntry() : null;
        if (entry) queue.push({ entry: entry, rel: "" });
      }
      if (!queue.length) {
        const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
        for (const f of files) {
          const src = api.fsPathForFile ? api.fsPathForFile(f) : (f.path || "");
          if (src && f.name) out.push({ src: src, rel: f.name });
        }
        return resolve(out);
      }
      const process = () => {
        const job = queue.shift();
        if (!job) return resolve(out);
        const entry = job.entry;
        if (!entry) return process();
        if (entry.isFile) {
          entry.file(
            (file) => {
              const src = api.fsPathForFile ? api.fsPathForFile(file) : (file.path || "");
              if (src && file.name) out.push({ src: src, rel: (job.rel ? job.rel + "/" : "") + file.name });
              process();
            },
            () => process()
          );
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const nextBatch = () => {
            reader.readEntries(
              (list) => {
                const arr = list || [];
                if (!arr.length) return process();
                for (const en of arr) queue.push({ entry: en, rel: job.rel + entry.name + "/" });
                nextBatch();
              },
              () => process()
            );
          };
          nextBatch();
        } else process();
      };
      process();
    });
  }

  function initProjectDnD() {
    if (!isElectron) return;
    const panel = $("project-panel");
    const tree = $("tree");
    const hint = $("drop-hint");
    let dropDir = projectDir();
    let dragDepth = 0;

    const clearRowHighlight = () => {
      tree.querySelectorAll(".tree-row.drop-target").forEach((r) => r.classList.remove("drop-target"));
    };
    const showHint = (dir) => {
      if (!dir) return;
      dropDir = dir;
      hint.innerHTML = dir === projectDir()
        ? "📥 Отпустите — скопирую файлы в корень проекта"
        : "📥 Отпустите — скопирую файлы в «" + esc(dir) + "»";
      hint.classList.remove("hidden");
    };

    window.addEventListener("dragenter", (e) => {
      if (!isElectron || panel.classList.contains("hidden")) return;
      e.preventDefault();
      dragDepth++;
    });
    window.addEventListener("dragover", (e) => {
      if (!isElectron || panel.classList.contains("hidden")) return;
      const hasFiles = e.dataTransfer && Array.prototype.slice.call(e.dataTransfer.items || []).some((i) => i.kind === "file");
      if (!hasFiles) return;
      e.preventDefault();
      const row = e.target && e.target.closest ? e.target.closest(".tree-row.dir") : null;
      clearRowHighlight();
      if (row && row.dataset && row.dataset.dir) {
        row.classList.add("drop-target");
        showHint(row.dataset.dir);
      } else {
        showHint(projectDir());
      }
    });
    window.addEventListener("dragleave", (e) => {
      if (!isElectron) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        hint.classList.add("hidden");
        clearRowHighlight();
      }
    });
    window.addEventListener("drop", async (e) => {
      if (!isElectron) return;
      const target = e.target;
      const insidePanel = target && target.closest && target.closest("#project-panel");
      if (panel.classList.contains("hidden") || (!insidePanel && hint.classList.contains("hidden"))) return;
      e.preventDefault();
      dragDepth = 0;
      hint.classList.add("hidden");
      clearRowHighlight();
      const dir = dropDir || projectDir();
      if (!dir) {
        toast("Сначала выбери рабочую директорию");
        return;
      }
      const items = await collectDrop(e.dataTransfer);
      if (!items.length) {
        toast("Не удалось получить файлы из перетаскивания");
        return;
      }
      const r = await api.fsImportDropped(dir, items);
      if (!r) {
        toast("Ошибка импорта файлов");
        return;
      }
      const added = (r.created || []).length;
      const failed = (r.errors || []).length;
      if (added && failed) toastShort("✅ Скопировано: " + added + ", ошибок: " + failed);
      else if (added) toastShort("✅ Скопировано файлов: " + added + " → " + dir);
      else toastShort("❌ " + ((r.errors || []).join("; ") || "Ничего не скопировано"));
      refreshTree();
    });
  }

  // ═══ Статус-бар (полоса внизу окна) ═══
  let sbChanges = 0; // изменённых файлов (последний git status)
  let sbVersion = ""; // версия кода из OTA-статуса

  function switchPanelTab(name) {
    const b = document.querySelector('.panel-tab[data-tab="' + name + '"]');
    if (b) b.click();
  }

  function showPanelTab(name) {
    const panel = $("project-panel");
    if (panel && panel.classList.contains("hidden")) togglePanel();
    switchPanelTab(name);
  }

  function sbProjectLabel() {
    const sel = $("project-select");
    if (sel && sel.selectedIndex >= 0) {
      const opt = sel.options[sel.selectedIndex];
      if (opt && opt.value) return String(opt.textContent || "").replace(/\s*⚠$/, "");
    }
    const dir = projectDir();
    return dir ? pathBase(dir) : "";
  }

  function updateStatusBar() {
    const repoEl = $("panel-repo");
    const hasRepo = !!repoRoot && !!repoEl && !repoEl.classList.contains("hidden");
    const proj = $("sb-project-name");
    if (proj) {
      proj.textContent = sbProjectLabel() || "проект не выбран";
      const btn = $("sb-project");
      if (btn) btn.title = (projectDir() || "Проект не выбран") + " — открыть файлы проекта";
    }
    const branchEl = $("sb-branch-name");
    const branchBtn = $("sb-branch");
    if (branchEl && branchBtn) {
      if (hasRepo) {
        branchEl.textContent = ($("panel-branch") && $("panel-branch").textContent) || "HEAD";
        branchBtn.classList.remove("hidden");
      } else {
        branchBtn.classList.add("hidden");
      }
    }
    const chBtn = $("sb-changes");
    const chNum = $("sb-changes-num");
    if (chBtn && chNum) {
      if (hasRepo) {
        chBtn.classList.remove("hidden");
        chNum.textContent = String(sbChanges);
        chBtn.classList.toggle("has-changes", sbChanges > 0);
        chBtn.classList.toggle("clean", sbChanges === 0);
        chBtn.title = sbChanges ? sbChanges + " изменённых файлов — открыть «Изменения»" : "Изменений нет — всё закоммичено";
      } else {
        chBtn.classList.add("hidden");
      }
    }
    const dot = $("sb-run-dot");
    const rtxt = $("sb-run-text");
    const runBtn = $("sb-run");
    if (dot && rtxt) {
      dot.className = "sb-dot" + (DevRun.previewRunning ? " on" : "");
      let port = "";
      try {
        const u = new URL(getSettings().previewUrl || "http://localhost:5000");
        port = u.port || (u.protocol === "https:" ? "443" : "80");
      } catch {
        port = "";
      }
      rtxt.textContent = DevRun.previewRunning ? "dev-сервер" + (port ? " :" + port : "") : "не запущен";
      if (runBtn) runBtn.title = DevRun.previewRunning ? "Dev-сервер запущен — открыть превью" : "Dev-сервер остановлен — открыть превью";
    }
    const mtxt = $("sb-model-text");
    if (mtxt) mtxt.textContent = getSettings().model ? SettingsPanel.providerLabel() + " · " + getSettings().model : "Модель не выбрана";
    const vtxt = $("sb-version-text");
    if (vtxt) vtxt.textContent = sbVersion || "—";
  }

  // Клики по статус-бару
  if ($("sb-project")) $("sb-project").onclick = () => showPanelTab("files");
  if ($("sb-branch")) $("sb-branch").onclick = () => showPanelTab("changes");
  if ($("sb-changes")) $("sb-changes").onclick = () => showPanelTab("changes");
  if ($("sb-run")) $("sb-run").onclick = () => openSidePanel("preview");
  if ($("sb-model")) $("sb-model").onclick = () => toggleModelPopup();
  if ($("sb-version"))
    $("sb-version").onclick = () => {
      SettingsPanel.openSettings("ota");
    };

  // ── Коммиты ──
  async function refreshRepo() {
    const el = $("panel-repo");
    const listEl = $("commit-list");
    $("commit-summary").textContent = "";
    $("commit-actions").innerHTML = "";
    const dir = projectDir();
    if (!isElectron || !dir) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML = '<div class="tree-empty">Выбери рабочую директорию — здесь появятся файлы и коммиты.</div>';
      return;
    }
    const info = await api.gitRepoInfo(dir);
    if (!info || !info.ok) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML = '<div class="tree-empty">' + esc(info && info.error) + "</div>";
      return;
    }
    if (!info.isRepo) {
      el.classList.add("hidden");
      repoRoot = null;
      listEl.innerHTML =
        '<div class="tree-empty">Эта папка — не git-репозиторий. Клонируй репозиторий полем выше или выбери другую рабочую папку.</div>';
      return;
    }
    repoRoot = info.root;
    el.classList.remove("hidden");
    $("panel-branch").textContent = info.branch || "HEAD";
    $("panel-branch").title = "Ветка";
    $("panel-remote").textContent = info.remote || "";
    $("panel-remote").title = info.remote || "";
    await refreshCommits();
    if (panelTab === "changes") await refreshChanges();
  }

  async function refreshCommits() {
    const summaryEl = $("commit-summary");
    const actionsEl = $("commit-actions");
    const listEl = $("commit-list");
    summaryEl.textContent = "";
    actionsEl.innerHTML = "";
    listEl.innerHTML = "";
    if (!repoRoot) return;
    const [st, log] = await Promise.all([api.gitStatus(repoRoot), api.gitLog(repoRoot, 60)]);
    if (!st || !st.ok) {
      listEl.innerHTML = '<div class="tree-empty">' + esc(st && st.error) + "</div>";
      return;
    }
    const parts = [];
    parts.push("🌿 " + (st.detached ? "HEAD (detached)" : st.branch || "—"));
    if (st.ahead) parts.push("↑" + st.ahead);
    if (st.behind) parts.push("↓" + st.behind);
    if (st.staged.length) parts.push("📌 staged: " + st.staged.length);
    if (st.unstaged.length) parts.push("✏️ изменено: " + st.unstaged.length);
    if (st.untracked.length) parts.push("🆕 новых: " + st.untracked.length);
    summaryEl.textContent = parts.join(" · ");
    summaryEl.title = "git status";
    // Счётчик изменений в статус-баре обновляем сразу при загрузке репозитория
    sbChanges = st.staged.length + st.unstaged.length + st.untracked.length;
    updateStatusBar();

    if (log && log.ok && log.commits.length) {
      const bUndo = document.createElement("button");
      bUndo.className = "btn btn-small";
      bUndo.textContent = "↩ Отменить последний коммит";
      bUndo.title = "Безопасно (git reset --soft HEAD~1): последний коммит убирается, а его изменения возвращаются как незакоммиченные — ничего не теряется.";
      bUndo.onclick = () =>
        confirmModal(
          "Отменить последний коммит?",
          "Коммит «" + log.commits[0].message.slice(0, 80) + "» будет убран из истории, а его изменения вернутся в рабочую папку как незакоммиченные.\nНичего не удаляется — можно закоммитить заново.",
          doUndoLastCommit
        );
      actionsEl.appendChild(bUndo);
    }

    if (st.staged.length || st.unstaged.length) {
      const b = document.createElement("button");
      b.className = "btn btn-danger btn-small";
      b.textContent = "↩ Отменить все изменения";
      b.title = "Вернуть изменённые файлы к состоянию последнего коммита (git restore .). Новые неотслеживаемые файлы не удаляются.";
      b.onclick = () =>
        confirmModal(
          "Отменить незакоммиченные изменения?",
          "Все правки в рабочей папке «" + repoRoot + "» будут отменены.\nНовые файлы, которые ещё не в git, останутся на месте.",
          doRestore,
          true
        );
      actionsEl.appendChild(b);
    }

    if (!log || !log.ok) {
      listEl.innerHTML = '<div class="tree-empty">' + esc(log && log.error) + "</div>";
      return;
    }
    if (!log.commits.length) {
      listEl.innerHTML = '<div class="tree-empty">Коммитов пока нет</div>';
      return;
    }
    for (const c of log.commits) listEl.appendChild(buildCommitRow(c));
  }

  // ── Вкладка «Изменения»: что изменилось, дифф, коммит и push ──
  async function refreshChanges() {
    const summaryEl = $("changes-summary");
    const listEl = $("change-list");
    summaryEl.textContent = "";
    listEl.innerHTML = "";
    if (!repoRoot) {
      summaryEl.textContent = "Открой git-репозиторий — здесь появятся изменения, которые можно закоммитить и запушить.";
      sbChanges = 0;
      updateStatusBar();
      return;
    }
    const st = await api.gitStatus(repoRoot);
    if (!st || !st.ok) {
      summaryEl.textContent = (st && st.error) || "Ошибка git status";
      return;
    }
    const total = st.staged.length + st.unstaged.length + st.untracked.length;
    sbChanges = total;
    updateStatusBar();
    if (!total) {
      summaryEl.textContent = "✨ Изменений нет — всё закоммичено. Чтобы запушить на GitHub, жми «Push».";
      return;
    }
    summaryEl.textContent = total + " изменённых файлов · ветка " + (st.branch || "HEAD");
    const groups = [
      { title: "📌 В индексе (staged)", cls: "staged", items: st.staged },
      { title: "✏️ Изменено", cls: "modified", items: st.unstaged },
      { title: "🆕 Новые", cls: "untracked", items: st.untracked },
    ];
    for (const g of groups) {
      if (!g.items.length) continue;
      const gTitle = document.createElement("div");
      gTitle.className = "change-group";
      gTitle.textContent = g.title;
      listEl.appendChild(gTitle);
      for (const f of g.items) {
        const row = document.createElement("div");
        row.className = "change-item" + (g.cls === "untracked" ? " untracked-row" : "");
        const badge = document.createElement("span");
        badge.className = "change-status " + g.cls;
        badge.textContent = g.cls === "staged" ? "staged" : g.cls === "untracked" ? "+ новый" : "изменён";
        const nm = document.createElement("span");
        nm.className = "change-name";
        nm.textContent = f;
        nm.title = f;
        row.appendChild(badge);
        row.appendChild(nm);
        row.title = "Клик — показать дифф";
        // Чекбокс для выбора файла
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "change-cb";
        cb.dataset.file = f;
        cb.dataset.group = g.cls;
        cb.checked = selectedChanges.has(f);
        cb.onclick = (ev) => { ev.stopPropagation(); toggleChangeSelect(f, cb.checked); };
        row.onclick = () => showDiff(repoRoot, f);
        row.insertBefore(cb, row.firstChild);
        listEl.appendChild(row);
      }
    }
    updateChangeActions();
  };

  // ── Чекбоксы: выбор / снятие ──
  function toggleChangeSelect(file, checked) {
    if (checked) selectedChanges.add(file); else selectedChanges.delete(file);
    updateChangeActions();
  }
  function updateChangeActions() {
    const bar = $("change-actions-bar");
    bar.classList.toggle("visible", selectedChanges.size > 0);
    // Обновить счётчик в кнопках
    const n = selectedChanges.size;
    const btnUnstage = $("btn-unstage-selected");
    const btnDel = $("btn-untrack-selected");
    btnUnstage.textContent = "↩ Убрать из staged" + (n ? " (" + n + ")" : "");
    btnDel.textContent = "🗑 Удалить выбранные" + (n ? " (" + n + ")" : "");
    // Select all checkbox
    const all = document.querySelectorAll(".change-cb");
    const selAll = $("change-select-all");
    if (all.length) selAll.checked = Array.from(all).every((cb) => cb.checked);
  }

  // ── Выбрать все / снять все ──
  $("change-select-all").onclick = () => {
    const checked = $("change-select-all").checked;
    document.querySelectorAll(".change-cb").forEach((cb) => {
      cb.checked = checked;
      const f = cb.dataset.file;
      if (checked) selectedChanges.add(f); else selectedChanges.delete(f);
    });
    updateChangeActions();
  };

  // ── Убрать из staged ──
  $("btn-unstage-selected").onclick = async () => {
    if (!repoRoot || !selectedChanges.size) return;
    for (const f of selectedChanges) {
      await api.gitUnstage(repoRoot, f);
    }
    selectedChanges.clear();
    refreshChanges();
  };

  // ── Удалить выбранные ──
  $("btn-untrack-selected").onclick = async () => {
    if (!repoRoot || !selectedChanges.size) return;
    const files = [...selectedChanges];
    confirmModal(
      "Удалить " + files.length + " файл(ов)?",
      "Файлы будут удалены с диска и из git. Это необратимо.",
      async () => {
        for (const f of files) {
          await api.gitRm(repoRoot, f);
        }
        selectedChanges.clear();
        refreshChanges();
      }
    );
  };

  // Показ диффа/содержимого файла в оверлее
  async function showDiff(root, rel) {
    if (!isElectron) return;
    const res = await api.gitDiff(root, rel);
    const overlay = $("file-overlay");
    const pathEl = $("file-path");
    const content = $("file-content");
    content.innerHTML = '<div class="file-error">Загружаю...</div>';
    pathEl.textContent = rel;
    overlay.classList.remove("hidden");
    if (!res || !res.ok) {
      content.innerHTML = "";
      const d = document.createElement("div");
      d.className = "file-error";
      d.textContent = (res && res.error) || "Нет изменений";
      content.appendChild(d);
      return;
    }
    const pre = document.createElement("pre");
    pre.className = "code-view";
    if (res.untracked) {
      const note = document.createElement("div");
      note.className = "diff-file-head";
      note.textContent = "🆕 Новый файл (ещё не в git)";
      pre.appendChild(note);
      const f = await api.fsReadFile(res.path || rel);
      if (f && f.ok) {
        for (const ln of f.content.split("\n").slice(0, 800)) {
          const line = document.createElement("div");
          line.className = "diff-line add";
          line.textContent = "+ " + ln;
          pre.appendChild(line);
        }
      } else {
        const d = document.createElement("div");
        d.className = "file-error";
        d.textContent = (f && f.error) || "Не удалось прочитать файл";
        pre.appendChild(d);
      }
    } else {
      for (const ln of String(res.diff || "").split("\n")) {
        const line = document.createElement("div");
        let cls = "";
        if (/^(@@|diff --git|index |--- |\+\+\+ )/.test(ln)) cls = "meta";
        else if (/^\+/.test(ln)) cls = "add";
        else if (/^-/.test(ln)) cls = "del";
        line.className = "diff-line" + (cls ? " " + cls : "");
        line.textContent = ln || " ";
        pre.appendChild(line);
      }
    }
    content.innerHTML = "";
    content.appendChild(pre);
  }

  async function doCommit() {
    if (!repoRoot) return;
    const msg = $("commit-msg").value.trim();
    if (!msg) {
      toast("Напиши сообщение коммита");
      return;
    }
    const btn = $("btn-commit");
    btn.disabled = true;
    btn.textContent = "…";
    try {
      const r = await api.gitCommit(repoRoot, msg);
      toastShort(r && r.ok ? "✅ Коммит создан" : "❌ " + ((r && r.error) || "Ошибка"));
      if (r && r.ok) $("commit-msg").value = "";
    } finally {
      btn.disabled = false;
      btn.textContent = "Коммит";
    }
    refreshRepo();
  }

  async function doPush() {
    if (!repoRoot) return;
    const btn = $("btn-push");
    btn.disabled = true;
    btn.textContent = "📤 …";
    try {
      const r = await api.gitPush(repoRoot);
      toastShort(r && r.ok ? "✅ Изменения отправлены на GitHub" : "❌ " + ((r && r.error) || "Ошибка"));
    } finally {
      btn.disabled = false;
      btn.textContent = "📤 Push";
    }
    refreshRepo();
  }

  async function doPull() {
    if (!repoRoot) return;
    const btn = $("btn-pull");
    btn.disabled = true;
    btn.textContent = "📥 …";
    try {
      const r = await api.gitPull(repoRoot);
      toastShort(r && r.ok ? "✅ Изменения получены с GitHub" : "❌ " + ((r && r.error) || "Ошибка"));
    } finally {
      btn.disabled = false;
      btn.textContent = "📥 Pull";
    }
    refreshRepo();
  }

  function buildCommitRow(c) {
    const row = document.createElement("div");
    row.className = "commit-row";
    const head = document.createElement("div");
    head.className = "commit-head";
    const hash = document.createElement("span");
    hash.className = "commit-hash";
    hash.textContent = c.short;
    hash.title = c.hash;
    const msg = document.createElement("span");
    msg.className = "commit-msg";
    msg.textContent = c.message;
    msg.title = c.message;
    const meta = document.createElement("span");
    meta.className = "commit-meta";
    meta.textContent = (c.author || "—") + (c.date ? " · " + fmtDate(c.date) : "");
    meta.title = c.email || "";
    head.appendChild(hash);
    head.appendChild(msg);
    head.appendChild(meta);
    const detail = document.createElement("div");
    detail.className = "commit-detail hidden";
    let detailLoaded = false;
    head.onclick = async () => {
      if (!detail.classList.contains("hidden")) {
        detail.classList.add("hidden");
        return;
      }
      detail.classList.remove("hidden");
      if (detailLoaded) return;
      detail.innerHTML = '<div class="commit-loading">Загружаю...</div>';
      const d = await api.gitCommitDetail(repoRoot, c.hash);
      detailLoaded = true;
      detail.innerHTML = "";
      if (!d || !d.ok) {
        detail.innerHTML = '<div class="tree-empty">' + esc(d && d.error) + "</div>";
        return;
      }
      if (d.files && d.files.length) {
        const files = document.createElement("div");
        files.className = "commit-files";
        for (const f of d.files) {
          const fl = document.createElement("div");
          fl.className = "commit-file";
          const st = document.createElement("span");
          st.className = "commit-file-status " + f.status;
          st.textContent = f.status === "added" ? "+" : f.status === "deleted" ? "−" : "±";
          const nm = document.createElement("span");
          nm.className = "commit-file-name";
          nm.textContent = f.path;
          nm.title = f.path;
          const ns = document.createElement("span");
          ns.className = "commit-file-nums";
          ns.textContent = (f.additions ? "+" + f.additions : "") + (f.deletions ? " −" + f.deletions : "");
          fl.appendChild(st);
          fl.appendChild(nm);
          fl.appendChild(ns);
          files.appendChild(fl);
        }
        detail.appendChild(files);
      }
      const btns = document.createElement("div");
      btns.className = "commit-btns";
      const bRevert = document.createElement("button");
      bRevert.className = "btn btn-small";
      bRevert.textContent = "↩ Откатить (revert)";
      bRevert.title = "Создаёт новый коммит с обратными изменениями. История сохраняется.";
      bRevert.onclick = (e) => {
        e.stopPropagation();
        confirmModal(
          "Откатить коммит?",
          "Будет создан новый коммит, отменяющий «" + c.message.slice(0, 80) + "».\nИстория останется нетронутой.",
          () => doRevert(c.hash)
        );
      };
      const bReset = document.createElement("button");
      bReset.className = "btn btn-danger btn-small";
      bReset.textContent = "⛔ Сбросить сюда";
      bReset.title = "Жёсткий откат (git reset --hard): все изменения после этого коммита будут удалены безвозвратно";
      bReset.onclick = (e) => {
        e.stopPropagation();
        confirmModal(
          "Жёсткий сброс к " + c.short + "?",
          "Все коммиты и правки после " + c.short + " («" + c.message.slice(0, 80) + "» и более новые) будут УДАЛЕНЫ безвозвратно.\nОткат невозможен!",
          () => doReset(c.hash),
          true
        );
      };
      btns.appendChild(bRevert);
      btns.appendChild(bReset);
      detail.appendChild(btns);
    };
    row.appendChild(head);
    row.appendChild(detail);
    return row;
  }

  async function doRevert(hash) {
    const r = await api.gitRevert(repoRoot, hash);
    toastShort(r && r.ok ? "✅ " + (r.out || "Коммит отменён") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doReset(hash) {
    const r = await api.gitResetHard(repoRoot, hash);
    toastShort(r && r.ok ? "✅ " + (r.out || "Сброшено") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doRestore() {
    const r = await api.gitRestore(repoRoot);
    toastShort(r && r.ok ? "✅ " + (r.out || "Изменения отменены") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  async function doUndoLastCommit() {
    const r = await api.gitUndoLastCommit(repoRoot);
    toastShort(r && r.ok ? "✅ " + (r.out || "Коммит отменён") : "❌ " + ((r && r.error) || "Ошибка"));
    refreshRepo();
  }

  // ── Публикация папки проекта как НОВОГО репозитория GitHub ──
  function openPublishDialog() {
    if (!isElectron) {
      toast("Публикация на GitHub доступна только в приложении на ПК");
      return;
    }
    if (!getSettings().githubToken) {
      toast("Сначала подключи GitHub: Настройки → GitHub");
      return;
    }
    const dir = projectDir();
    if (!dir) {
      toast("Сначала выбери папку проекта (📁 в панели проекта или Настройки)");
      return;
    }
    const base = String(dir.split(/[\\/]/).pop() || "")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "my-project";
    $("publish-dir").textContent = "Папка: " + dir;
    $("publish-dir").title = dir;
    $("publish-name").value = base;
    $("publish-desc").value = "";
    $("publish-private").checked = true;
    $("publish-hint").textContent = "";
    const ok = $("btn-publish-ok");
    ok.disabled = false;
    ok.textContent = "Создать и выгрузить";
    $("publish-overlay").classList.remove("hidden");
    setTimeout(() => $("publish-name").focus(), 60);
  }

  function closePublishDialog() {
    $("publish-overlay").classList.add("hidden");
  }

  async function doPublish() {
    const name = $("publish-name").value.trim();
    const desc = $("publish-desc").value.trim();
    const dir = projectDir();
    if (!name) {
      $("publish-hint").textContent = "Введи имя репозитория.";
      return;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.length > 100) {
      $("publish-hint").textContent = "Имя: только буквы, цифры, точка, дефис, подчёркивание (без пробелов, не с точки).";
      return;
    }
    const btn = $("btn-publish-ok");
    btn.disabled = true;
    btn.textContent = "⏳ Создаём и выгружаем…";
    $("publish-hint").textContent = "";
    try {
      const r = await api.githubPublish({ dir, name, description: desc, private: $("publish-private").checked });
      if (r && r.ok) {
        closePublishDialog();
        // main сохранил githubRepoSlug/Dir — обновляем локальное состояние и панели
        const fresh = await api.getSettings();
        setSettings(normalize(fresh));
        renderGithubSection();
        if (typeof renderRepoSelector === "function") renderRepoSelector();
        refreshProject();
        refreshProjects();
        toastShort("✅ " + (r.message || "Опубликовано на GitHub"));
      } else {
        $("publish-hint").textContent = "❌ " + ((r && r.error) || "Ошибка публикации");
      }
    } catch (e) {
      $("publish-hint").textContent = "❌ " + (e && e.message ? e.message : String(e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Создать и выгрузить";
    }
  }

  async function cloneRepo() {
    const url = $("clone-url").value.trim();
    if (!url) {
      toast("Вставь URL репозитория");
      return;
    }
    if (!/^(https?:\/\/|git@)/i.test(url)) {
      toast("URL должен начинаться с https:// или git@");
      return;
    }
    // Рабочую директорию на этом шаге не требуем: если она пустая или защищена от записи,
    // бэкенд сам подберёт записываемую папку (pickCloneBase) и сообщит, куда склонировал.
    $("btn-clone").disabled = true;
    let ok = false;
    let msg = "Ошибка";
    try {
      const r = await api.gitClone(getSettings().workingDir, url);
      ok = r && r.ok;
      msg = ok ? "Клонировано: " + r.dir : (r && r.error) || "Ошибка";
      if (ok) {
        $("clone-url").value = "";
        getSettings().githubRepoDir = r.dir; // панель проекта сразу показывает склонированный репозиторий
        persistSettings();
      }
    } finally {
      $("btn-clone").disabled = false;
    }
    toastShort((ok ? "✅ " : "❌ ") + msg);
    refreshProject();
  }

  // ── Подтверждение ──
  let confirmCb = null;
  function confirmModal(title, text, onOk, danger) {
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    const okBtn = $("btn-confirm-ok");
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-primary");
    okBtn.textContent = danger ? "⛔ Да, выполнить" : "Подтвердить";
    confirmCb = onOk;
    $("confirm-overlay").classList.remove("hidden");
  }

  // ── GitHub ──
  async function renderGithubSection() {
    const connected = !!getSettings().githubToken;
    $("gh-connected").classList.toggle("hidden", !connected);
    $("gh-disconnected").classList.toggle("hidden", connected);
    if (!connected) {
      $("gh-repos").classList.add("hidden");
      return;
    }
    let login = getSettings().githubLogin || "";
    let avatar = getSettings().githubAvatarUrl || "";
    if (!login && isElectron) {
      const u = await api.githubUser();
      if (u && u.ok) {
        login = u.login;
        avatar = u.avatar;
        getSettings().githubLogin = login;
        getSettings().githubAvatarUrl = avatar;
        persistSettings();
      }
    }
    $("gh-login").textContent = login ? "@" + login : "@github";
    const img = $("gh-avatar");
    if (avatar) {
      img.src = avatar;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }
    renderRepoSelector();
  }

  function githubConnected() {
    return !!getSettings().githubToken;
  }

  function escHtml(s) {
    return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function repoItemInner(slug, selected) {
    const r = githubReposList && githubReposList.find((x) => x.slug === slug);
    const [owner, name] = slug.split("/");
    const desc = r && r.description ? r.description : "";
    const lang = r && r.language ? r.language.trim() : "";
    const priv = r && r.isPrivate;
    const updated = r && r.updated ? new Date(r.updated).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" }) : "";
    const meta = [];
    if (priv) meta.push('<span class="dot private" title="Приватный"></span>');
    if (lang) meta.push('<span class="dot language" title="Язык"></span> ' + lang);
    if (updated) meta.push(updated);
    return (
      '<span class="repo-icon">📊</span>' +
      '<span class="repo-info">' +
      '<span class="repo-slug">' + escHtml(owner) + " / " + escHtml(name) + "</span>" +
      (meta.length ? '<span class="repo-meta">' + meta.join(" · ") + "</span>" : "") +
      (desc ? '<span class="repo-desc" style="font-size:11.5px;color:var(--text-faint);">' + escHtml(desc) + "</span>" : "") +
      "</span>" +
      '<button type="button" class="gh-repo-export' + (selected ? " primary" : "") + '" title="Склонировать в рабочую папку">⬇ Выгрузить</button>' +
      (selected ? '<span class="repo-check">✓</span>' : "")
    );
  }

  let reposPage = 1;
  let reposQuery = "";
  let reposMore = false;
  let repoSearchTimer = null;

  async function renderRepoSelector() {
    const box = $("gh-repos");
    const body = $("gh-repos-body");
    const list = $("gh-repo-list");
    const status = $("gh-repos-status");
    const chev = $("repo-chev");
    list.innerHTML = "";
    const selected = (getSettings().githubRepoSlug || "").trim();
    box.classList.toggle("hidden", !githubConnected());

    if (!githubConnected()) return;

    const hasData = !!githubReposList || !!selected;
    body.classList.toggle("hidden", !hasData);
    if (chev) chev.textContent = hasData ? "▾" : "▸";

    if (!selected && !githubReposList) {
      status.textContent = "Открой аккордеон, чтобы загрузить список репозиториев (или воспользуйся поиском).";
      status.className = "gh-repos-status";
      return;
    }

    if (selected && !githubReposList) {
      // Репозиторий уже выбран (например, после перезапуска приложения) —
      // показываем его без загрузки списка, список можно открыть кликом по заголовку.
      const direct = await api.githubSelectedRepo().catch(() => null);
      if (direct && direct.ok && direct.slug) {
        getSettings().githubRepoSlug = direct.slug;
        getSettings().githubRepoDir = direct.dir || "";
        persistSettings();
      }
      status.textContent = "Выбран репозиторий — " + selected +
        (getSettings().githubRepoDir ? ". Локальная папка: " + getSettings().githubRepoDir : ". Нажми «⬇ Выгрузить», чтобы склонировать его в рабочую папку.") +
        " Список можно открыть, чтобы переключиться.";
      status.className = "gh-repos-status";
      const item = document.createElement("div");
      item.className = "gh-repo-item selected";
      item.innerHTML = repoItemInner(selected, true);
      const eb = item.querySelector(".gh-repo-export");
      if (eb && !getSettings().githubRepoDir) {
        eb.onclick = (e) => {
          e.stopPropagation();
          exportRepoItem(selected, eb);
        };
      }
      list.appendChild(item);
      return;
    }

    renderRepoList();
  }

  function renderRepoList() {
    const list = $("gh-repo-list");
    const more = $("gh-repo-more");
    const status = $("gh-repos-status");
    const selected = (getSettings().githubRepoSlug || "").trim();
    list.innerHTML = "";
    if (!githubReposList || !githubReposList.length) {
      if (more) more.classList.add("hidden");
      status.textContent = reposQuery
        ? "Поиск «" + reposQuery + "»: ничего не найдено. Проверь имя или введи точный owner/repo (например: facebook/react)."
        : "Репозиториев не найдено.";
      status.className = "gh-repos-status";
      return;
    }
    status.textContent = reposQuery
      ? "Поиск «" + reposQuery + "»: найдено " + githubReposList.length + " — нажми на репозиторий, затем «⬇ Выгрузить» склонирует его в рабочую папку."
      : "Найдено репозиториев: " + githubReposList.length + (reposMore ? " (первые 100, есть ещё)" : "") +
        ". Нажми на репозиторий — появится «⬇ Выгрузить», который склонирует его в рабочую папку.";
    status.className = "gh-repos-status";
    for (const r of githubReposList) {
      const isSelected = r.slug === selected;
      const item = document.createElement("div");
      item.className = "gh-repo-item" + (isSelected ? " selected" : "");
      item.innerHTML = repoItemInner(r.slug, isSelected);
      item.onclick = () => selectRepoItem(r.slug);
      const exportBtn = item.querySelector(".gh-repo-export");
      if (exportBtn) {
        exportBtn.onclick = (e) => {
          e.stopPropagation();
          exportRepoItem(r.slug, exportBtn);
        };
      }
      list.appendChild(item);
    }
    if (more) more.classList.toggle("hidden", !reposMore);
  }

  async function fetchRepos(opts) {
    opts = opts || {};
    const q = typeof opts.query === "string" ? opts.query.trim() : reposQuery;
    const page = opts.page || 1;
    const append = !!opts.append;
    const status = $("gh-repos-status");
    const list = $("gh-repo-list");
    if (append && githubReposList && githubReposList.length) {
      status.textContent = "Загружаю ещё…";
    } else {
      reposQuery = q;
      status.textContent = q ? "Поиск «" + q + "»…" : "Загрузка списка репозиториев…";
      list.innerHTML = "";
    }
    status.className = "gh-repos-status";
    try {
      const res = await api.githubRepos({ query: q, page: page });
      if (!res || !res.ok) throw new Error((res && res.error) || "Не удалось загрузить список");
      const items = res.repos || [];
      githubReposList = append ? (githubReposList || []).concat(items) : items;
      reposQuery = q;
      reposPage = page;
      reposMore = !!res.hasMore;
      renderRepoList();
    } catch (e) {
      status.textContent = "Ошибка: " + (e.message || String(e));
      status.className = "gh-repos-status err";
      if (!append) githubReposList = null;
    }
  }

  // Клик по строке репозитория = выбор (без клонирования). Клонирует явная кнопка «⬇ Выгрузить».
  async function selectRepoItem(slug) {
    const status = $("gh-repos-status");
    const selected = (getSettings().githubRepoSlug || "").trim();
    if (selected === slug) {
      status.textContent = "Репозиторий уже выбран: " + slug + ". Нажми «⬇ Выгрузить», чтобы склонировать его в рабочую папку.";
      status.className = "gh-repos-status";
      return;
    }
    if (!isElectron) {
      status.textContent = "Клонирование GitHub-репозиториев доступно в приложении на ПК.";
      status.className = "gh-repos-status err";
      return;
    }
    status.textContent = "Выбираю репозиторий «" + slug + "»...";
    status.className = "gh-repos-status";
    const res = await api.githubPickRepo(slug);
    if (!res || !res.ok) {
      status.textContent = "Ошибка: " + ((res && res.error) || "Не удалось выбрать репозиторий");
      status.className = "gh-repos-status err";
      return;
    }
    getSettings().githubRepoSlug = slug;
    getSettings().githubRepoDir = "";
    persistSettings();
    renderRepoList();
    status.textContent = "Выбран «" + slug + "». Нажми «⬇ Выгрузить» — склонируется в рабочую папку" +
      (getSettings().workingDir ? " (" + getSettings().workingDir + ")" : " (домашнюю папку)") + ".";
    status.className = "gh-repos-status";
  }

  // «⬇ Выгрузить»: явное клонирование выбранного репозитория в рабочую директорию.
  async function exportRepoItem(slug, btn) {
    const status = $("gh-repos-status");
    const oldLabel = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = "…"; }
    status.textContent = "Клонирую «" + slug + "» в рабочую папку...";
    status.className = "gh-repos-status";
    const res = await api.githubSelectRepo(slug, getSettings().workingDir);
    if (btn) { btn.disabled = false; btn.innerHTML = oldLabel; }
    if (!res || !res.ok) {
      status.textContent = "Ошибка: " + ((res && res.error) || "Не удалось склонировать");
      status.className = "gh-repos-status err";
      return;
    }
    getSettings().githubRepoSlug = slug;
    getSettings().githubRepoDir = res.dir || "";
    persistSettings();
    status.textContent = res.message + (res.cloned ? " Теперь можно работать с файлами." : "");
    status.className = "gh-repos-status";
    githubReposList = null;
    reposQuery = "";
    reposMore = false;
    const si = $("gh-repo-search");
    if (si) si.value = "";
    const sc = $("gh-repo-search-clear");
    if (sc) sc.classList.add("hidden");
    renderRepoSelector();
    if (!$("project-panel").classList.contains("hidden")) refreshProject();
  }

  async function unselectRepo() {
    const res = await api.githubUnselectRepo();
    if (res && res.ok) {
      getSettings().githubRepoSlug = "";
      getSettings().githubRepoDir = "";
      persistSettings();
      githubReposList = null;
      renderRepoSelector();
      if (!$("project-panel").classList.contains("hidden")) refreshProject();
    }
  }

  function showDeviceModal(code) {
    $("device-code").textContent = code;
    const st = $("device-status");
    st.textContent = "Ожидаем авторизацию...";
    st.className = "device-status";
    $("device-overlay").classList.remove("hidden");
  }

  function closeDeviceModal() {
    $("device-overlay").classList.add("hidden");
  }

  async function connectGithub() {
    if (!isElectron) {
      SettingsPanel.setSettingsMsg("Авторизация GitHub доступна только в приложении на ПК", true);
      return;
    }
    const clientId = $("s-gh-client-id").value.trim();
    if (!clientId) {
      SettingsPanel.setSettingsMsg("Вставь Client ID OAuth-приложения GitHub (или создай его по ссылке ниже).", true);
      return;
    }
    getSettings().githubClientId = clientId;
    persistSettings();
    const res = await api.githubDeviceStart();
    if (!res || !res.ok) {
      SettingsPanel.setSettingsMsg((res && res.error) || "Не удалось начать авторизацию", true);
      return;
    }
    showDeviceModal(res.user_code);
    SettingsPanel.setSettingsMsg("Код показан. Введи его на github.com/login/device — доступ подключится сам.", false);
  }

  function wireGithubEvents() {
    if (!isElectron) return;
    api.onGithubEvent((ev) => {
      if (ev.type === "done") {
        closeDeviceModal();
        api.getSettings().then((s) => {
          setSettings(normalize(s));
          SettingsPanel.fillSettingsUI();
          renderGithubSection();
        });
        SettingsPanel.setSettingsMsg("GitHub подключён: @" + (ev.login || "github"), false);
        toast("GitHub: @" + (ev.login || ""));
      } else if (ev.type === "error") {
        const st = $("device-status");
        st.textContent = "Ошибка: " + ev.message;
        st.className = "device-status err";
        SettingsPanel.setSettingsMsg("Ошибка авторизации: " + ev.message, true);
      } else if (ev.type === "expired") {
        const st = $("device-status");
        st.textContent = "Код истёк. Нажми «Отмена» и попробуй снова.";
        st.className = "device-status err";
        SettingsPanel.setSettingsMsg("Код авторизации истёк. Попробуй ещё раз.", true);
      }
    });
  }

  // ── Ресайзер панели проекта: ширина перетаскиванием ──
  (function initPanelResizer() {
    const panel = $("project-panel");
    const handle = document.createElement("div");
    handle.className = "panel-resize";
    handle.title = "Потяни, чтобы изменить ширину";
    panel.insertBefore(handle, panel.firstChild);
    let dragging = false;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.classList.add("resizing-x");
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = $("main").getBoundingClientRect();
      const w = e.clientX - rect.left;
      panel.style.width = Math.min(Math.max(w, 260), window.innerWidth * 0.5) + "px";
      panel.style.minWidth = "0";
    });
    document.addEventListener("mouseup", () => {
      dragging = false;
      document.body.classList.remove("resizing-x");
    });
  })();

  // ── События панели проекта ──
  $("btn-toggle-panel").onclick = togglePanel;
  $("btn-panel-close").onclick = () => $("project-panel").classList.add("hidden");
  $("btn-panel-refresh").onclick = () => refreshProject();
  $("btn-panel-pick-dir").onclick = async () => {
    if (!isElectron) return;
    const p = await api.pickDirectory();
    if (p) {
      getSettings().workingDir = p;
      $("s-workdir").value = p;
      persistSettings();
      refreshProject();
    }
  };
  $("btn-clone").onclick = cloneRepo;
  // ── Переключение / создание / удаление проектов ──
  $("project-select").onchange = () => switchProject($("project-select").value);
  $("btn-project-add").onclick = async () => {
    if (!isElectron) {
      toast("Проекты доступны в приложении на ПК");
      return;
    }
    const list = await api.projectsList();
    if (list && list.ok && list.projects.length >= 10) {
      toast("Максимум 10 проектов — убери один из списка (🗑)");
      return;
    }
    openProjectDialog();
  };
  $("btn-project-remove").onclick = () => {
    const id = $("project-select").value;
    if (!id) return;
    confirmModal("Убрать проект из списка?", "Папка на диске НЕ будет удалена.", () => {
      api.projectsRemove(id).then(async (r) => {
        if (!r || !r.ok) {
          toast((r && r.error) || "Не удалось убрать проект");
          return;
        }
        const s = await api.getSettings();
        setSettings(normalize(s));
        $("s-workdir").value = getSettings().workingDir || "";
        // Если остался активный проект — переключаемся на его чат.
        if (getSettings().activeProjectId) {
          const pr = (getSettings().projects || []).find((p) => p.id === getSettings().activeProjectId);
          ensureProjectChat(getSettings().activeProjectId, pr && pr.name);
        }
        toast("Проект убран из списка");
        refreshProject();
        refreshProjects();
      });
    }, false);
  };
  // ── Ручное создание файлов/папок + перетаскивание ──
  $("btn-new-file").onclick = () => {
    if (!isElectron) {
      toast("Создание файлов доступно в приложении на ПК");
      return;
    }
    newProjectFile();
  };
  $("btn-new-folder").onclick = () => {
    if (!isElectron) {
      toast("Создание папок доступно в приложении на ПК");
      return;
    }
    newProjectFolder();
  };
  initProjectDnD();
  // ── Кнопки вкладки «Изменения»: коммит, push, pull ──
  $("btn-commit").onclick = doCommit;
  $("btn-push").onclick = doPush;
  $("btn-pull").onclick = doPull;
  $("commit-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doCommit();
  });
  $("clone-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") cloneRepo();
  });
  document.querySelectorAll(".panel-tab").forEach((b) => {
    b.onclick = () => {
      panelTab = b.dataset.tab;
      document.querySelectorAll(".panel-tab").forEach((x) => x.classList.toggle("active", x === b));
      $("panel-files").classList.toggle("hidden", panelTab !== "files");
      $("panel-changes").classList.toggle("hidden", panelTab !== "changes");
      $("panel-commits").classList.toggle("hidden", panelTab !== "commits");
      if (panelTab === "commits") refreshRepo();
      else if (panelTab === "changes") refreshChanges();
      else refreshTree();
    };
  });

  // ── События модалок ──
  $("btn-file-close").onclick = () => {
    editMode = false;
    updateFileToolbar();
    $("file-overlay").classList.add("hidden");
  };
  $("file-overlay").addEventListener("click", (e) => {
    if (e.target === $("file-overlay")) $("file-overlay").classList.add("hidden");
  });
  $("btn-file-copy").onclick = () => {
    navigator.clipboard.writeText($("file-path").textContent).then(() => toast("Путь скопирован"));
  };
  $("btn-file-open").onclick = () => {
    if (isElectron) api.fsOpenInExplorer($("file-path").textContent);
  };
  $("btn-file-edit").onclick = () => {
    if (!fileViewPath || !fileCanEdit) return;
    editMode = true;
    renderFileTabs();
    loadActiveFile();
  };
  $("btn-file-save").onclick = saveEditedFile;
  $("btn-file-hl").onclick = () => {
    hlInEditor = !hlInEditor;
    if (editorRepaint) editorRepaint();
    else {
      const wrap = document.querySelector(".code-edit-wrap");
      if (wrap) wrap.classList.toggle("no-hl", !hlInEditor);
    }
    $("btn-file-hl").classList.toggle("active", hlInEditor);
    toast(hlInEditor ? "✨ Подсветка включена" : "Подсветка выключена — обычный текст");
  };
  $("btn-file-delete").onclick = () => {
    if (fileViewPath) deleteFsItem(fileViewPath, false);
  };
  // «⬆ Опубликовать на GitHub» — создать новый репозиторий и выгрузить папку проекта
  $("btn-publish").onclick = openPublishDialog;
  $("btn-publish-cancel").onclick = closePublishDialog;
  $("publish-overlay").addEventListener("click", (e) => {
    if (e.target === $("publish-overlay")) closePublishDialog();
  });
  $("btn-publish-ok").onclick = doPublish;
  $("publish-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doPublish();
    } else if (e.key === "Escape") closePublishDialog();
  });
  // Диалог «Новый проект»
  $("btn-project-cancel").onclick = closeProjectDialog;
  $("project-overlay").addEventListener("click", (e) => {
    if (e.target === $("project-overlay")) closeProjectDialog();
  });
  $("btn-project-pick-dir").onclick = async () => {
    if (!isElectron) return;
    const p = await api.pickDirectory();
    if (p) {
      projectChosenDir = p;
      $("project-dir").value = p;
    }
  };
  $("project-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-project-ok").click();
    else if (e.key === "Escape") closeProjectDialog();
  });
  $("btn-project-ok").onclick = async () => {
    const name = $("project-name").value.trim();
    if (!name) {
      $("project-hint").textContent = "Введи название проекта.";
      return;
    }
    $("btn-project-ok").disabled = true;
    const r = await api.projectsCreate(name, projectChosenDir);
    $("btn-project-ok").disabled = false;
    if (!r || !r.ok) {
      $("project-hint").textContent = (r && r.error) || "Не удалось создать проект";
      return;
    }
    closeProjectDialog();
    const s = await api.getSettings();
    setSettings(normalize(s));
    $("s-workdir").value = getSettings().workingDir || "";
    // Новый проект становится активным — сразу переходим в его чат.
    ensureProjectChat(r.project && r.project.id, r.project && r.project.name);
    toast("Проект создан: " + (r.project && r.project.name));
    refreshProject();
    refreshProjects();
  };
  // Диалог ввода имени (новый файл/папка)
  $("btn-input-ok").onclick = () => resolveInput($("input-value").value.trim());
  $("btn-input-cancel").onclick = () => resolveInput(null);
  $("input-overlay").addEventListener("click", (e) => {
    if (e.target === $("input-overlay")) resolveInput(null);
  });
  $("input-value").addEventListener("keydown", (e) => {
    if (e.key === "Enter") resolveInput($("input-value").value.trim());
    else if (e.key === "Escape") resolveInput(null);
  });
  $("input-value").addEventListener("input", () => {
    $("input-hint").textContent = /[\\/:*?"<>|]/.test($("input-value").value)
      ? "Имя не должно содержать символы / \\ : * ? \" < > |"
      : "";
  });
  $("btn-confirm-ok").onclick = () => {
    $("confirm-overlay").classList.add("hidden");
    const cb = confirmCb;
    confirmCb = null;
    if (cb) cb();
  };
  $("btn-confirm-cancel").onclick = () => {
    $("confirm-overlay").classList.add("hidden");
    confirmCb = null;
  };
  $("confirm-overlay").addEventListener("click", (e) => {
    if (e.target === $("confirm-overlay")) {
      $("confirm-overlay").classList.add("hidden");
      confirmCb = null;
    }
  });

  // ── События GitHub ──
  $("btn-gh-connect").onclick = connectGithub;
  $("btn-gh-disconnect").onclick = async () => {
    if (!isElectron) return;
    await api.githubDisconnect();
    getSettings().githubToken = "";
    getSettings().githubLogin = "";
    getSettings().githubAvatarUrl = "";
    persistSettings();
    renderGithubSection();
    SettingsPanel.setSettingsMsg("GitHub отключён", false);
  };
  $("btn-gh-create-app").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/settings/applications/new");
  };
  $("btn-device-open").onclick = () => {
    if (isElectron) api.openExternal("https://github.com/login/device");
  };

  // ── Выбор репозитория GitHub (аккордеон в настройках): поиск + пагинация ──
  const ghSearchInput = $("gh-repo-search");
  const ghSearchClear = $("gh-repo-search-clear");
  ghSearchInput.addEventListener("input", () => {
    const q = ghSearchInput.value;
    ghSearchClear.classList.toggle("hidden", !q.trim());
    clearTimeout(repoSearchTimer);
    repoSearchTimer = setTimeout(() => fetchRepos({ query: q }), q.trim() ? 350 : 0);
  });
  ghSearchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(repoSearchTimer);
      fetchRepos({ query: ghSearchInput.value });
    } else if (e.key === "Escape") {
      ghSearchInput.value = "";
      ghSearchClear.classList.add("hidden");
      fetchRepos({ query: "" });
    }
  });
  ghSearchClear.onclick = () => {
    ghSearchInput.value = "";
    ghSearchClear.classList.add("hidden");
    clearTimeout(repoSearchTimer);
    fetchRepos({ query: "" });
  };
  $("gh-repo-more").onclick = () => {
    clearTimeout(repoSearchTimer);
    fetchRepos({ query: "", page: (reposPage || 1) + 1, append: true });
  };
  $("gh-repos-head").onclick = async (e) => {
    if (e.target.closest("#btn-gh-unselect-repo")) return;
    const body = $("gh-repos-body");
    const chev = $("repo-chev");
    const opening = body.classList.contains("hidden");
    body.classList.toggle("hidden", !opening);
    if (chev) chev.textContent = opening ? "▾" : "▸";
    if (opening && !githubReposList && !(getSettings().githubRepoSlug || "").trim()) await fetchRepos();
  };
  $("btn-gh-unselect-repo").onclick = async () => {
    if (!isElectron) {
      toast("Выбор репозитория доступен только в приложении на ПК");
      return;
    }
    await unselectRepo();
  };

  return {
    esc: esc,
    toastShort: toastShort,
    projectDir: projectDir,
    refreshProject: refreshProject,
    refreshProjects: refreshProjects,
    switchProject: switchProject,
    fileIcon: fileIcon,
    viewFile: viewFile,
    inputDialog: inputDialog,
    newProjectFile: newProjectFile,
    newProjectFolder: newProjectFolder,
    showPanelTab: showPanelTab,
    updateStatusBar: updateStatusBar,
    doPush: doPush,
    doPull: doPull,
    openPublishDialog: openPublishDialog,
    confirmModal: confirmModal,
    renderGithubSection: renderGithubSection,
    escHtml: escHtml,
    closeDeviceModal: closeDeviceModal,
    wireGithubEvents: wireGithubEvents,
    getFileViewPath: function () { return fileViewPath; },
    setFileViewPath: function (v) { fileViewPath = v; },
    getSbVersion: function () { return sbVersion; },
    setSbVersion: function (v) { sbVersion = v; },
  };
});

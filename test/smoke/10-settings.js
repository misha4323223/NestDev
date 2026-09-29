"use strict";
/* ─── Группа «Настройки и навигация: панели, палитра, рельса, песочница» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 9.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  fakeEl,
  get,
  miniDom,
  panelDom,
  uiAll,
  uiFile,
  uiFind,
} = H;

// ── Палитра команд: свой модуль (этап 8) ────────────────────────────────────
// Палитра уехала из app.js в command-palette.js. Проверяем две вещи: границы
// (в оболочке осталась только сборка модуля) и ПОВЕДЕНИЕ на игрушечном DOM —
// список действий с учётом условий, поиск, запуск строки и клавиши.
async function testCommandPalette() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "command-palette.js"), "utf8");

  await test("палитра команд: модуль на месте, оболочка только собирает его", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="command-palette.js"');
    assert.ok(iTag > 0, "разметка не грузит command-palette.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "command-palette.js подключён после app.js");
    assert.ok(
      /"command-palette\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")),
      "мост не отдаёт модуль телефону"
    );

    // Кода палитры в оболочке не осталось — только сборка модуля с зависимостями.
    const appSrc = uiFile("app.js");
    for (const gone of [
      "function paletteActions", "function paletteFilter", "function paletteRows",
      "function paletteHighlight", "function paletteRender", "function paletteRun",
      "function openPalette", "function closePalette", "function collectProjectFiles",
      "function enterFileMode", "paletteFiles",
    ]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код палитры остался в app.js: " + gone);
    }
    assert.ok(/const CommandPalette = window\.CommandPalette\(\{/.test(appSrc), "app.js не собирает палитру");

    // Проводка: состояние генерации — живой функцией. Копия застыла бы на времени
    // загрузки, и «Остановить агента» показывалось бы в списке всегда (или никогда).
    const wiring = appSrc.slice(appSrc.indexOf("const CommandPalette = window.CommandPalette({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of [
      "getStreaming: () => streaming", "openSidePanel: SidePanel.openSidePanel", "termReset: SidePanel.termReset",
      "ChatActions: ChatActions", "ProjectPanel: ProjectPanel", "SettingsPanel: SettingsPanel",
    ]) {
      assert.ok(wiringCall.includes(dep), "в проводку палитры не передано " + dep);
    }
    // И своё место: Ctrl+K читает модуль на загрузке окна, поэтому сборка обязана
    // стоять ДО блока горячих клавиш (иначе «Cannot access before initialization»).
    assert.ok(
      appSrc.indexOf("const CommandPalette = window.CommandPalette({") < appSrc.indexOf("CommandPalette.openPalette("),
      "проводка палитры стоит после горячих клавиш"
    );

    // Границы модуля: чужое состояние — только через внедрение.
    for (const name of ["settings", "streaming", "chatsData", "session", "msgEls"]) {
      assert.ok(!new RegExp("(^|[^\\\\w$.])" + name + "\\\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }
    assert.ok(!/localStorage|window\.api\b/.test(src), "модуль лезет в чужие глобалы");
  });

  await test("палитра команд: список, поиск, запуск и клавиши работают на игрушечном DOM", async () => {
    // Игрушечный DOM: узлы запоминают детей, обработчики и классы — этого хватает,
    // потому что палитра строит список сама (createElement + appendChild).
    const mkNode = (tag) => {
      const cls = new Set();
      const node = {
        tag: tag, className: "", textContent: "", value: "", placeholder: "", title: "",
        style: {}, children: [], listeners: {}, _html: "",
        onclick: null, onmousemove: null,
        clicked: 0,
        classList: {
          add: (...cs) => cs.forEach((c) => cls.add(c)),
          remove: (...cs) => cs.forEach((c) => cls.delete(c)),
          contains: (c) => cls.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !cls.has(c) : !!on;
            if (want) cls.add(c); else cls.delete(c);
            return want;
          },
        },
        appendChild(c) { node.children.push(c); return c; },
        addEventListener(type, fn) { node.listeners[type] = fn; },
        click() { node.clicked++; },
        focus() {},
        select() {},
        scrollIntoView() {},
        querySelectorAll(sel) {
          const want = String(sel).replace(/^\./, "");
          return node.children.filter((c) => String(c.className).split(" ").indexOf(want) !== -1);
        },
      };
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        get() { return node._html; },
        set(v) {
          node._html = String(v == null ? "" : v);
          if (node._html === "") node.children.length = 0; // приложение очищает список так же
        },
      });
      return node;
    };
    const mkDom = () => {
      const els = new Map();
      const $ = (id) => {
        if (!els.has(id)) els.set(id, mkNode("div"));
        return els.get(id);
      };
      return { $, els };
    };
    const build = (deps) => {
      const base = mkDom();
      const vm = require("vm");
      const box = {
        module: { exports: {} },
        self: {},
        console: { log() {}, warn() {}, error() {} },
        document: { createElement: (tag) => mkNode(tag), querySelectorAll: () => [], addEventListener() {} },
      };
      vm.runInNewContext(src, box, { filename: "command-palette.js" });
      const calls = { toast: [], runs: [], side: [], reset: 0, view: [] };
      let streaming = false;
      let projectDir = "/tmp/проект";
      const api = {
        fsListTree: async (dir) => ({
          ok: true,
          entries: dir === "/tmp/проект"
            ? [{ name: "a.js", isDir: false }, { name: "src", isDir: true }]
            : [{ name: "b.js", isDir: false }],
        }),
      };
      const panel = box.module.exports(Object.assign({
        $: base.$,
        api: api,
        isElectron: true,
        toast: (t) => calls.toast.push(t),
        createChat: () => calls.runs.push("новый чат"),
        stop: () => calls.runs.push("стоп"),
        getStreaming: () => streaming,
        openSidePanel: (t) => calls.side.push(t),
        termReset: () => { calls.reset++; },
        ChatActions: { copyChat() {} },
        ProjectPanel: {
          showPanelTab() {}, newProjectFile() {}, newProjectFolder() {},
          doPush() {}, doPull() {}, openPublishDialog() {}, fileIcon: () => "📄",
          viewFile: (p) => calls.view.push(p),
          projectDir: () => projectDir,
        },
        SettingsPanel: { openSettings() {}, testConnection() {}, probeLocalModelUI() {} },
      }, deps || {}));
      return {
        panel, calls, $: base.$,
        setStreaming: (v) => { streaming = v; },
        setProjectDir: (v) => { projectDir = v; },
      };
    };
    const rows = ($) => $("palette-list").children.filter((c) => /(^| )palette-row( |$)/.test(c.className));
    const titles = ($) => rows($).map((r) => r.children.map((c) => c.textContent).join(" | "));

    // 1. Список действий: подписи на месте, условия учитываются.
    const a = build();
    a.panel.openPalette("actions");
    assert.ok(!a.$("palette-overlay").classList.contains("hidden"), "палитра не открылась");
    const all = titles(a.$);
    assert.ok(all.some((t) => /Новый чат/.test(t)), "в палитре нет «Новый чат»: " + all.join(" / "));
    assert.ok(all.some((t) => /Открыть файл/.test(t)), "в палитре нет открытия файла (ПК): " + all.join(" / "));
    assert.ok(!all.some((t) => /Остановить агента/.test(t)), "без генерации предложено остановить агента");
    a.setStreaming(true);
    a.panel.openPalette("actions");
    assert.ok(titles(a.$).some((t) => /Остановить агента/.test(t)), "во время генерации нет остановки агента");
    assert.ok(a.$("palette-list").children.some((c) => /palette-sec/.test(c.className)), "в списке нет заголовков разделов");

    // 2. Запуск строки: клик по первой строке закрывает палитру и делает своё действие.
    const first = rows(a.$)[0];
    first.onclick();
    assert.ok(a.$("palette-overlay").classList.contains("hidden"), "после запуска палитра осталась открытой");
    assert.deepStrictEqual(a.calls.runs, ["новый чат"], "первая строка запустила не своё действие: " + a.calls.runs.join(","));

    // 3. Поиск: строка фильтрует список (и заголовки разделов уезжают вместе с ним).
    a.panel.openPalette("actions");
    a.$("palette-input").value = "консоль";
    a.$("palette-input").listeners.input();
    const filtered = titles(a.$);
    assert.ok(filtered.length > 0 && filtered.length < all.length, "поиск не сузил список: " + filtered.length);
    assert.ok(filtered.some((t) => /Консоль/.test(t)), "поиск по «консоль» не нашёл консоль: " + filtered.join(" / "));
    assert.ok(!filtered.some((t) => /Новый чат/.test(t)), "поиск оставил чужие строки: " + filtered.join(" / "));

    // 4. Клавиши: ArrowDown двигает подсветку, Enter запускает ИМЕННО её.
    a.panel.openPalette("actions");
    const before = a.calls.runs.length;
    const key = (k) => a.$("palette-input").listeners.keydown({ key: k, preventDefault() {}, ctrlKey: false, metaKey: false });
    key("ArrowDown");
    key("Enter");
    assert.ok(a.calls.runs.length === before, "Enter запустил первую строку вместо подсвеченной: " + a.calls.runs.join(","));
    assert.ok(a.$("btn-continue-chat").clicked > 0, "Enter не выполнил подсвеченную строку");

    // 5. Файлы (Ctrl+P): список собирается обходом проекта, клик открывает файл путём.
    const b = build();
    b.setProjectDir("");
    await b.panel.enterFileMode();
    assert.ok(b.calls.toast.some((t) => /рабочую папку/.test(t)), "без рабочей папки нет понятного отказа: " + b.calls.toast.join(" / "));
    b.setProjectDir("/tmp/проект");
    await b.panel.enterFileMode();
    const files = titles(b.$);
    assert.ok(files.some((t) => /a\.js/.test(t)) && files.some((t) => /b\.js/.test(t)), "в списке файлов нет файлов проекта: " + files.join(" / "));
    const fileRow = rows(b.$).filter((r) => /b\.js/.test(r.children.map((c) => c.textContent).join(" ")))[0];
    fileRow.onclick();
    assert.deepStrictEqual(b.calls.view, ["/tmp/проект/src/b.js"], "файл открылся не своим путём: " + b.calls.view.join(","));

    // 6. Не на ПК: палитра не обещает файлов, а честно говорит, где они есть.
    const c = build({ isElectron: false });
    c.panel.openPalette("actions");
    assert.ok(!titles(c.$).some((t) => /Открыть файл/.test(t)), "в браузере предложено открывать файлы: " + titles(c.$).join(" / "));
    await c.panel.enterFileMode();
    assert.ok(c.calls.toast.some((t) => /на ПК/.test(t)), "в браузере нет понятного отказа: " + c.calls.toast.join(" / "));
  });
}

// ── Правая панель, рельса, консоль и превью: свой модуль (этап 9) ───────────
// Панель уехала из app.js в side-panel.js. Проверяем границы (в оболочке осталась
// только сборка), порядок загрузки и ПОВЕДЕНИЕ на игрушечном DOM: разделы, подсветка,
// консоль и превью с адресом из настроек.
async function testSidePanel() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "side-panel.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  await test("панель и рельса: модуль на месте, оболочка только собирает его", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const iTag = html.indexOf('src="side-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит side-panel.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "side-panel.js подключён после app.js");
    assert.ok(
      /"side-panel\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")),
      "мост не отдаёт модуль телефону"
    );

    // Кода панели в оболочке не осталось — только сборка модуля с зависимостями.
    for (const gone of [
      "function syncRail", "function markPanelButtons", "function setSidebarCollapsed",
      "function toggleSidebarCollapsed", "function sidePanelVisible", "function openSidePanel",
      "function closeSidePanel", "function switchSideTab", "function termAppend", "function termReset",
      "function ensureTerminal", "function termSend", "function onTermEvent", "function previewOpen",
      "function previewSetDevice", "function previewOpenTab", "let sideTab", "let termBuf",
      "let previewLoaded", "const TasksMission = window.TasksMission({", "const DevRun = window.DevRun({",
    ]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код панели остался в app.js: " + gone);
    }
    assert.ok(/const SidePanel = window\.SidePanel\(\{/.test(appSrc), "app.js не собирает панель");

    // Оболочка зовёт панель только через модуль: голых имён не осталось.
    const wireAt = appSrc.indexOf("const SidePanel = window.SidePanel({");
    for (const use of ["SidePanel.openSidePanel(", "SidePanel.syncRail", "SidePanel.termAppend", "SidePanel.termReset", "SidePanel.sidePanelVisible(", "SidePanel.closeSidePanel(", "SidePanel.getSideTab()"]) {
      assert.ok(appSrc.includes(use), "оболочка больше не зовёт " + use);
    }
    // Событие «preview» открывает раздел превью: код события уехал в chat-events.js
    // (этап A, часть 1), поэтому панель там берётся отложенной стрелкой.
    assert.ok(/getSidePanel\(\)\.openSidePanel\("preview"\);/.test(uiFile("chat-events.js")), "событие preview не открывает раздел превью");
    assert.ok(/getSidePanel\(\)\.previewOpen\(ev\.url \|\| ""\);/.test(uiFile("chat-events.js")), "событие preview не отдаёт адрес панели");
    // Тест провайдера G4F открывает консоль правой панели: сам код уехал в g4f-panel.js
    // (этап A, часть 2), поэтому панель там берётся отложенной стрелкой.
    assert.ok(/getSidePanel\(\)\.switchSideTab\("console"\);/.test(uiFile("g4f-panel.js")), "тест провайдера G4F не открывает консоль");
    assert.ok(/getSidePanel\(\)\.termAppend\(/.test(uiFile("g4f-panel.js")), "тест провайдера G4F не пишет в консоль");
    // Своё место: проводки, читающие панель НА ЗАГРУЗКЕ окна, обязаны стоять ниже сборки —
    // иначе «Cannot access before initialization» и весь остаток загрузки не выполняется.
    // Обращения выше сборки (тест провайдера G4F, события агента) живут внутри функций и
    // выполняются позже — им модуль уже доступен.
    for (const later of ["const ProjectPanel = window.ProjectPanel({", "const CommandPalette = window.CommandPalette({"]) {
      const at = appSrc.indexOf(later);
      assert.ok(at > 0, "в оболочке нет проводки " + later);
      assert.ok(wireAt < at, "сборка панели стоит после " + later);
    }
    // Подмодули панели оболочка берёт под своими именами (события и автозадачи зовут их как раньше).
    assert.ok(appSrc.indexOf("const DevRun = SidePanel.DevRun;") > wireAt, "оболочка не берёт DevRun из панели");
    assert.ok(appSrc.indexOf("const TasksMission = SidePanel.TasksMission;") > wireAt, "оболочка не берёт дела из панели");

    // Живые зависимости: настройки и история чатов переписываются целиком, состояние
    // генерации меняется, панель проекта и облако создаются позже — копия устарела бы молча.
    const wiring = appSrc.slice(wireAt, appSrc.indexOf("});", wireAt));
    for (const dep of [
      "getSettings: () => settings", "getChatsData: () => chatsData", "getStreaming: () => streaming",
      "getProjectPanel: () => ProjectPanel", "getYcPanel: () => YcPanel", "esc: (t) => ProjectPanel.esc(t)",
      "persistSettings: ChatStore.persistSettings", "isElectron: isElectron",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку панели не передано " + dep);
    }

    // Границы модуля: чужое состояние — только через внедрение.
    for (const name of ["settings", "chatsData", "streaming", "session", "msgEls"]) {
      assert.ok(!new RegExp("(^|[^\\\\w$.])" + name + "\\\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }
    assert.ok(!/(^|[^\\w.])settings\\./.test(src), "модуль ходит в settings напрямую вместо getSettings()");
    assert.ok(!/ProjectPanel\\.|YcPanel\\./.test(src), "модуль зовёт чужую панель напрямую вместо доступа через проводку");
  });

  await test("панель и рельса: разделы, подсветка, консоль и превью работают на игрушечном DOM", () => {
    const mkNode = (id) => {
      const cls = new Set();
      const node = {
        id: id, value: "", textContent: "", placeholder: "", title: "", src: "",
        style: {}, dataset: {}, children: [], listeners: {}, _html: "",
        onclick: null, className: "",
        classList: {
          add: (...cs) => cs.forEach((c) => cls.add(c)),
          remove: (...cs) => cs.forEach((c) => cls.delete(c)),
          contains: (c) => cls.has(c),
          toggle: (c, on) => {
            const want = on === undefined ? !cls.has(c) : !!on;
            if (want) cls.add(c); else cls.delete(c);
            return want;
          },
        },
        appendChild(c) { node.children.push(c); return c; },
        addEventListener(type, fn) { node.listeners[type] = fn; },
        click() { if (node.onclick) node.onclick(); },
        focus() {},
        scrollIntoView() {},
        querySelectorAll() { return []; },
      };
      Object.defineProperty(node, "innerHTML", {
        configurable: true,
        get() { return node._html; },
        set(v) { node._html = String(v == null ? "" : v); },
      });
      return node;
    };
    const els = new Map();
    const $ = (id) => {
      if (!els.has(id)) els.set(id, mkNode(id));
      return els.get(id);
    };
    // Вкладки панели и переключатели устройств — их модуль ищет по классам.
    const spBtns = ["console", "preview", "cloud", "deploy", "mission", "tasks"].map((tab) => {
      const b = mkNode("sp-btn-" + tab);
      b.dataset = { sp: tab };
      return b;
    });
    const devBtns = ["390", "768", "100%"].map((w) => {
      const b = mkNode("dev-" + w);
      b.dataset = { w: w };
      return b;
    });
    const store = {};
    const sandbox = {
      module: { exports: {} },
      self: {},
      console: { log() {}, warn() {}, error() {} },
      document: {
        getElementById: $,
        createElement: (tag) => mkNode(tag),
        querySelectorAll: (sel) => (/sp-btn/.test(sel) ? spBtns : /dev-btns/.test(sel) ? devBtns : []),
        addEventListener() {},
      },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
      setTimeout: (fn) => { fn(); },
    };
    const calls = { toast: [], persisted: 0, refreshDev: 0, dashboards: 0, termCalls: 0, closed: 0 };
    // Подмодули панели — заглушки с теми методами, которые панель реально зовёт.
    sandbox.window = {
      innerWidth: 1280,
      DevRun: () => ({
        refreshDevControls() { calls.refreshDev++; },
        onDevEvent() {}, devStartClick() {}, devStopClick() {}, termTabComplete() {}, termServerAppend() {},
      }),
      TasksMission: () => ({ refreshMission() {}, renderTasks() {}, missionFromEvent() {} }),
    };
    const vm = require("vm");
    vm.runInNewContext(src, sandbox, { filename: "side-panel.js" });

    let settings = { workingDir: "/tmp/проект", previewUrl: "" };
    const api = {
      onTermEvent: (fn) => { api._termEvent = fn; },
      onDevEvent: (fn) => { api._devEvent = fn; },
      termStatus: async () => ({ running: true }),
      termStart: async () => ({ ok: true }),
      termInput: () => { calls.termCalls++; },
      termStop() {}, openExternal() {},
    };
    const panel = sandbox.module.exports({
      $: $,
      api: api,
      isElectron: true,
      toast: (t) => calls.toast.push(t),
      AgentCore: {},
      esc: (t) => String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
      persistSettings: () => { calls.persisted++; },
      getSettings: () => settings,
      getProjectPanel: () => ({ updateStatusBar() {}, projectDir: () => "/tmp/проект" }),
      getYcPanel: () => ({ loadDashboard() { calls.dashboards++; } }),
      getChatsData: () => ({ chats: [], activeId: null }),
      getStreaming: () => false,
      getActiveChat: () => null,
      persistChatsNow() {}, selectChat() {}, renderSidebar() {}, sendMessage() {},
      startAutoRunNow() {}, autoResize() {},
    });
    assert.ok(panel, "фабрика ничего не вернула");
    for (const name of ["openSidePanel", "closeSidePanel", "sidePanelVisible", "getSideTab", "switchSideTab", "syncRail", "termAppend", "termReset", "previewOpen"]) {
      assert.strictEqual(typeof panel[name], "function", "панель не отдаёт " + name);
    }
    assert.ok(panel.DevRun && panel.TasksMission, "панель не отдала подмодули (DevRun/TasksMission)");

    // Подписки на события ставит сама панель: без них консоль и запуск проекта молчат.
    assert.strictEqual(typeof api._termEvent, "function", "панель не подписалась на события терминала");
    assert.strictEqual(typeof api._devEvent, "function", "панель не подписалась на события запуска проекта");
    const railActive = () => ["rail-console", "rail-preview", "rail-cloud", "rail-deploy", "rail-mission", "rail-tasks"].filter((id) => $(id).classList.contains("active"));

    // 1. Раздел «Консоль»: панель выезжает, тело переключается, подсветка одна, заголовок — свой.
    panel.openSidePanel("console");
    assert.ok(panel.sidePanelVisible() && panel.getSideTab() === "console", "консоль не открылась");
    assert.ok(!$("sp-console").classList.contains("hidden") && $("sp-preview").classList.contains("hidden"), "тело раздела не переключилось");
    assert.strictEqual($("sp-title").textContent, "Консоль", "заголовок раздела не обновился");
    assert.deepStrictEqual(railActive(), ["rail-console"], "подсветка рельсы: " + railActive().join(","));
    assert.ok($("btn-toggle-console").classList.contains("active"), "кнопка раздела не подсветилась");

    // 2. Консоль принимает вывод и гасит его (esc приходит из панели проекта).
    api._termEvent({ type: "out", text: "<b>привет</b>" });
    assert.ok(/\&lt;b\&gt;привет\&lt;\/b\&gt;/.test($("term-out").innerHTML), "вывод консоли не погашен: " + $("term-out").innerHTML);
    api._termEvent({ type: "in", text: "ls" });
    assert.ok(/\$|\u276f/.test($("term-out").innerHTML), "команда не показана в консоли");
    $( "btn-term-stop").classList.add("hidden");
    api._termEvent({ type: "start", cwd: "/tmp/проект" });
    assert.ok(!$("btn-term-stop").classList.contains("hidden"), "кнопка остановки не показалась при старте");
    api._termEvent({ type: "exit", code: 0 });
    assert.ok($("btn-term-stop").classList.contains("hidden"), "кнопка остановки осталась после выхода");
    panel.termReset();
    assert.ok(/Консоль рабочей директории/.test($("term-out").innerHTML), "очистка консоли не вернула подсказку");

    // 3. Раздел «Превью»: адрес сохраняется в настройках, кадр грузит его, устройства переключаются.
    panel.switchSideTab("preview");
    assert.ok(!$("sp-preview").classList.contains("hidden") && $("sp-console").classList.contains("hidden"), "превью не показалось");
    assert.strictEqual($("sp-title").textContent, "Превью", "заголовок превью не обновился");
    assert.ok(calls.refreshDev >= 1, "панель не обновила кнопки запуска проекта");
    panel.previewOpen("http://localhost:3000");
    assert.strictEqual(settings.previewUrl, "http://localhost:3000", "адрес превью не сохранён в настройках");
    assert.strictEqual(calls.persisted, 1, "настройки не сохранены на диск");
    assert.strictEqual($("preview-url").value, "http://localhost:3000", "адрес не встал в поле");
    assert.strictEqual($("preview-frame").src, "http://localhost:3000", "кадр превью не загрузил адрес");
    // С телефона localhost — это сам телефон: host подменяем на адрес ПК из моста,
    // а ПОРТ оставляем портом проекта. Мост слушает порт 9090 и отдаёт файлы самого
    // окна, а не dev-сервер: с портом моста превью открывало приложение вместо сайта.
    sandbox.window.mobileApi = { host: "192.168.1.5:9090" };
    panel.previewOpen("http://localhost:3000/app");
    assert.strictEqual($("preview-frame").src, "http://192.168.1.5:3000/app", "порт проекта потерялся при подмене для телефона: " + $("preview-frame").src);
    assert.strictEqual(settings.previewUrl, "http://localhost:3000/app", "в настройках оказался адрес для телефона вместо адреса проекта");
    panel.previewOpen("http://localhost:5000");
    assert.strictEqual($("preview-frame").src, "http://192.168.1.5:5000", "порт dev-сервера 5000 не сохранился: " + $("preview-frame").src);
    panel.previewOpen("http://127.0.0.1:5000");
    assert.strictEqual($("preview-frame").src, "http://192.168.1.5:5000", "127.0.0.1 не подменился на адрес ПК: " + $("preview-frame").src);
    panel.previewOpen("https://example.com/app");
    assert.strictEqual($("preview-frame").src, "https://example.com/app", "чужой адрес не должен подменяться на телефоне");
    sandbox.window.mobileApi = null;
    panel.previewOpen("http://localhost:3000");

    // 4. Рельса: иконка нажимает кнопку шапки и подсвечивается вместе с ней.
    let toggles = 0;
    $("btn-toggle-preview").onclick = () => { toggles++; $("btn-toggle-preview").classList.add("active"); };
    $("rail-preview").onclick();
    assert.strictEqual(toggles, 1, "иконка рельсы не нажала кнопку шапки");
    assert.ok($("rail-preview").classList.contains("active"), "иконка рельсы не подсветилась");
    // Синхронизация: кнопка шапки, нажатая напрямую, тоже зажигает рельсу.
    $("rail-preview").classList.remove("active");
    $("btn-toggle-preview").classList.add("active");
    panel.syncRail();
    assert.ok($("rail-preview").classList.contains("active"), "рельса не синхронизировалась с кнопкой шапки");

    // 5. Свёрнутый список чатов: состояние запоминается и возвращается.
    $("rail-chats").onclick();
    assert.ok($("sidebar").classList.contains("collapsed"), "иконка «Чаты» не свернула панель");
    assert.strictEqual(store.sidebarCollapsed, "1", "свёрнутость не запомнилась");
    $("btn-side-collapse").onclick();
    assert.ok(!$("sidebar").classList.contains("collapsed"), "кнопка в шапке не развернула панель");
    assert.strictEqual(store.sidebarCollapsed, "0", "разворот не запомнился");

    // 6. Закрытие: панель уезжает, подсветка снимается целиком, и открыть её можно снова.
    panel.closeSidePanel();
    assert.ok(!panel.sidePanelVisible(), "панель не закрылась");
    assert.deepStrictEqual(railActive(), [], "подсветка осталась: " + railActive().join(","));
    assert.ok(!$("btn-toggle-console").classList.contains("active"), "кнопка раздела осталась подсвеченной");
    panel.openSidePanel("cloud");
    assert.ok(calls.dashboards === 1, "облако не загрузило дашборд при открытии раздела");
    assert.deepStrictEqual(railActive(), ["rail-cloud"], "подсветка облака: " + railActive().join(","));
  });
}

// ── Одна навигация: рельса слева, шапка — действия чата (1.5.90) ─────────────
// Было: одни и те же разделы переключались из трёх мест — иконки на рельсе,
// иконки в шапке справа и вкладки внутри самой панели. Хуже того, подсветка
// загоралась сразу у трёх иконок: openSidePanel включал консоль, превью и
// облако одной пачкой, а не по активному разделу.
// Стало: разделы переключает ТОЛЬКО рельса; в шапке остаются действия чата,
// а шапка панели показывает название раздела. Иконки разделов и вкладки панели
// возвращаются лишь на телефоне, где рельсы нет.
async function testOneNavigation() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
  const m900 = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
  const TABS = ["console", "preview", "cloud", "deploy", "mission", "tasks"];

  await test("одна навигация: дубли в шапке спрятаны, раздел подписан", () => {
    // Кнопки-дубли остаются в разметке (рельса нажимает именно их через proxy),
    // но помечены — иначе их нечем скрыть на широком экране.
    for (const id of ["btn-toggle-console", "btn-toggle-preview", "btn-toggle-cloud", "btn-toggle-deploy", "btn-toggle-panel"]) {
      assert.ok(new RegExp('id="' + id + '"[^>]*class="[^"]*hdr-dupe').test(html), "кнопка " + id + " не помечена дублем рельсы");
    }
    assert.ok(/\.header-btns \.hdr-dupe \{ display: none; \}/.test(css), "дубли шапки видны на широком экране");
    assert.ok(m900 && /\.header-btns \.hdr-dupe \{ display: inline-flex; \}/.test(m900[1]), "на телефоне иконки разделов не вернулись в шапку");
    // Лента вкладок рабочей области (как в Replit) видна и на широком экране:
    // разделы переключает активная вкладка, а рельса слева остаётся пусковой.
    assert.ok(/\.sp-switch \{\n  display: flex;/.test(css), "лента вкладок панели скрыта на широком экране");
    assert.ok(m900 && /\.sp-switch \{ display: flex; \}/.test(m900[1]), "на телефоне вкладки панели не вернулись");
    // Подпись раздела осталась в разметке, но её роль взяла активная вкладка.
    assert.ok(html.indexOf('id="sp-title"') !== -1, "в шапке панели нет названия раздела");
    const navSrc = uiFile("side-panel.js");
    assert.ok(/SP_TITLES = \{[\s\S]{0,200}?tasks: "Дела"/.test(navSrc), "нет названий разделов");
    assert.ok(/spTitle\.textContent = SP_TITLES\[sideTab\]/.test(navSrc), "название раздела не обновляется");
    // Каскад: мобильное правило обязано идти ПОСЛЕ базового и лежать внутри блока 900px —
    // иначе скрытие не переопределится и на телефоне не останется навигации вообще.
    const baseDupe = css.indexOf(".header-btns .hdr-dupe { display: none; }");
    const mobDupe = css.indexOf(".header-btns .hdr-dupe { display: inline-flex; }");
    assert.ok(baseDupe > 0 && mobDupe > baseDupe, "мобильное правило дублей не после базового");
    assert.ok(css.indexOf(".header-btns .hdr-dupe { display: none; }", baseDupe + 1) === -1, "базовое правило дублей продублировано");
    const baseSwitch = css.indexOf(".sp-switch {\n  display: flex;");
    const mobSwitch = css.indexOf(".sp-switch { display: flex; }");
    assert.ok(baseSwitch > 0 && mobSwitch > baseSwitch, "мобильное правило вкладок не после базового");
    assert.ok(css.indexOf(".sp-switch {\n  display: flex;", baseSwitch + 1) === -1, "базовое правило вкладок продублировано");
    assert.ok(m900 && m900[1].indexOf(".sp-switch { display: flex; }") !== -1 && m900[1].indexOf(".header-btns .hdr-dupe { display: inline-flex; }") !== -1, "мобильные правила лежат вне блока 900px");
    // Стили, которые грузятся последними, не должны возвращать этим элементам видимость.
    for (const cssFile of ["monochrome.css", "yc-console.css", "deploy-panel.css"]) {
      const t = fs.readFileSync(path.join(ROOT, "src", "renderer", cssFile), "utf8");
      assert.ok(!/(sp-switch|hdr-dupe|sp-title)[^}]*display/.test(t), cssFile + " возвращает видимость вкладкам, дублям или названию раздела");
    }
  });

  await test("одна навигация: ровно одна подсветка вместо трёх", () => {
    const navLogic = uiFind("  // Рельса слева (как в Replit): иконки переиспользуют", "  function sidePanelVisible() {");
    assert.ok(navLogic.start > 0, "не нашёл блок навигации в интерфейсе");
    const openBody = uiFind("  function openSidePanel(tab) {", "  function closeSidePanel() {").code;
    assert.ok(openBody.indexOf("markPanelButtons();") !== -1, "openSidePanel не пересчитывает подсветку");
    assert.ok(openBody.indexOf('.classList.add("active")') === -1, "openSidePanel снова включает подсветку вручную");
    assert.ok(/function markPanelButtons\(\)/.test(uiFile("side-panel.js")), "нет единой точки подсветки разделов");

    // Живая логика: берём из app.js сам блок навигации и прогоняем на игрушечном
    // DOM. sidePanelVisible и sideTab объявлены в файле рядом — подставляем их
    // ровно так же, как в исходнике, чтобы slice остался хрупким не больше нужного.
    const code =
      "let sideTab = 'preview';\n" +
      "function sidePanelVisible() { return !$('side-panel').classList.contains('hidden'); }\n" +
      navLogic.code +
      "\nreturn { markPanelButtons: markPanelButtons, setTab: function (t) { sideTab = t; } };";
    const el = () => {
      const e = { _c: new Set(), title: "", onclick: null };
      Object.defineProperty(e, "classList", {
        value: {
          contains: (c) => e._c.has(c),
          add: (...cs) => cs.forEach((c) => e._c.add(c)),
          remove: (...cs) => cs.forEach((c) => e._c.delete(c)),
          toggle: (c, on) => {
            const want = on === undefined ? !e._c.has(c) : !!on;
            if (want) e._c.add(c);
            else e._c.delete(c);
            return want;
          },
        },
      });
      return e;
    };
    const ids = [
      "side-panel", "sidebar", "btn-side-collapse",
      "rail-chats", "rail-console", "rail-preview", "rail-cloud", "rail-deploy", "rail-mission", "rail-tasks", "rail-files",
      "btn-toggle-console", "btn-toggle-preview", "btn-toggle-cloud", "btn-toggle-deploy", "btn-toggle-panel",
    ];
    const nodes = {};
    for (const id of ids) nodes[id] = el();
    const store = {};
    const localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    const fakeDoc = { getElementById: (id) => nodes[id] || null };
    const run = new Function("document", "$", "localStorage", "window", code)(fakeDoc, fakeDoc.getElementById, localStorage, { innerWidth: 1280 });
    const active = () => TABS.filter((t) => nodes["rail-" + t].classList.contains("active"));

    nodes["side-panel"].classList.add("hidden");
    run.setTab("console");
    nodes["side-panel"].classList.remove("hidden");
    run.markPanelButtons();
    assert.deepStrictEqual(active(), ["console"], "подсвечено не одно: " + JSON.stringify(active()));
    assert.ok(nodes["btn-toggle-console"].classList.contains("active"), "кнопка шапки не подсветилась");
    assert.ok(!nodes["btn-toggle-preview"].classList.contains("active") && !nodes["btn-toggle-cloud"].classList.contains("active"), "подсветились чужие кнопки шапки");

    run.setTab("deploy");
    run.markPanelButtons();
    assert.deepStrictEqual(active(), ["deploy"], "переключение раздела оставило прошлую подсветку");
    assert.ok(nodes["btn-toggle-deploy"].classList.contains("active") && !nodes["btn-toggle-console"].classList.contains("active"), "деплой не подсветился или консоль осталась активной");

    nodes["side-panel"].classList.add("hidden");
    run.markPanelButtons();
    assert.deepStrictEqual(active(), [], "закрытая панель оставила подсветку разделов");
    assert.ok(!nodes["btn-toggle-deploy"].classList.contains("active"), "закрытая панель оставила кнопку шапки активной");
  });

  await test("композер: кнопки одной высоты, подписи компактные", () => {
    // Ряд кнопок прижат вправо И обязан сжиматься: колонка чата сужается, когда
    // открыта правая рабочая область, а flex-потомки по умолчанию не сжимаются —
    // без min-width:0 «Отправить» выезжала за колонку под панель (живой прогон
    // окна: кнопка видна, клик не проходит). Проверяем смысл, а не точный вид.
    const btnsRule = (css.match(/\.composer-btns \{[^}]*\}/) || [""])[0];
    assert.ok(/margin-left: auto/.test(btnsRule), "кнопки композера не прижаты вправо: " + btnsRule);
    assert.ok(/min-width: 0/.test(btnsRule), "ряд кнопок не сжимается — «Отправить» уедет под панель: " + btnsRule);
    assert.ok(/flex-wrap: wrap/.test(btnsRule), "ряд кнопок не переносится в узкой колонке: " + btnsRule);
    const rowRule = (css.match(/\.composer-row \{[^}]*\}/) || [""])[0];
    assert.ok(/min-width: 0/.test(rowRule), "строка композера не сжимается: " + rowRule);
    assert.ok(/\.composer-btns > \.btn \{ height: 28px; padding: 0 9px; border-radius: 8px; font-size: 11.5px; gap: 5px; \}/.test(css), "кнопки композера не одной высоты");
    assert.ok(/\.composer-btns > #btn-send,\n\.composer-btns > #btn-stop \{ width: 30px; height: 30px;/.test(css), "главное действие не выделено размером");
    assert.ok(html.indexOf("Enter — отправить · Shift+Enter — новая строка</span>") !== -1, "подсказка в композере не укорочена");
    assert.ok(html.indexOf("План</button>") !== -1, "подпись режима плана не укорочена");
    assert.ok(html.indexOf(">Рассуждения</span>") !== -1, "кнопка рассуждений не переведена на русский");
    assert.ok(html.indexOf("🧠 Reasoning") === -1 && html.indexOf("📋 План") === -1, "в композере остались эмодзи вместо иконок");
    assert.ok(m900 && /\.input-hint \{ display: none; \}/.test(m900[1]), "на телефоне осталась подсказка про Enter");
    assert.ok(m900 && /\.composer-btns \{ gap: 3px; \}/.test(m900[1]), "на телефоне кнопки композера не сжаты");
  });
}

// ── 4f. Отчёт песочницы по ВК: честные ответы инструментов ───────────────
// ── Настройки: вертикальная навигация, поиск, липкий футер ──────────────────
async function testSettingsRedesign() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "monochrome.css"), "utf8");

  await test("настройки: категории в вертикальной колонке слева, содержимое справа", () => {
    const nav = htmlSrc.indexOf('<nav class="settings-nav">');
    const content = htmlSrc.indexOf('<div class="settings-content">');
    const tabs = htmlSrc.indexOf('data-tab-body="model"');
    assert.ok(nav > 0, "нет вертикальной навигации .settings-nav");
    assert.ok(content > nav, "область содержимого идёт не после навигации");
    assert.ok(tabs > content, "вкладки оказались вне области содержимого");
    const stabs = (htmlSrc.match(/class="stab[" ]/g) || []).length;
    assert.strictEqual(stabs, 11, "вкладок не 11: " + stabs);
    const subs = (htmlSrc.match(/class="stab-text"/g) || []).length;
    assert.strictEqual(subs, 11, "у категорий нет подписей: " + subs);
    assert.ok(cssSrc.includes("grid-template-columns: 218px minmax(0, 1fr)"), "раскладка настроек не двухколоночная");
  });

  await test("настройки: футер с «Сохранить» вне прокрутки", () => {
    const footer = htmlSrc.indexOf('<div class="settings-footer">');
    const lastBody = htmlSrc.lastIndexOf("data-tab-body=");
    const msg = htmlSrc.indexOf('id="settings-msg"');
    assert.ok(footer > lastBody, "футер оказался внутри прокручиваемой области");
    assert.ok(msg > footer, "сообщение о сохранении вне футера");
    assert.ok(cssSrc.includes("grid-template-rows: auto minmax(0, 1fr) auto"), "панель не делит высоту на шапку/тело/футер");
    assert.ok(cssSrc.includes(".settings-footer-btns"), "кнопки сохранения не сгруппированы");
  });

  await test("настройки: поиск по всем вкладкам и понятная пустота", () => {
    assert.ok(htmlSrc.includes('id="settings-search"'), "нет поля поиска");
    assert.ok(htmlSrc.includes('id="settings-empty"'), "нет сообщения «ничего не найдено»");
    // Поиск живёт в своём модуле (этап 3.8, часть 1): проверяется и сама логика,
    // и то, что оболочка ведёт ввод в неё, а кода поиска в app.js больше нет.
    const searchSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings-search.js"), "utf8");
    assert.ok(/function settingsSearchApply/.test(searchSrc), "поиск не реализован");
    assert.ok(!appSrc.includes("function settingsSearchApply"), "поиск остался в оболочке");
    assert.ok(
      appSrc.includes('$("settings-search").addEventListener("input", (e) => SettingsSearch.apply(e.target.value))'),
      "поиск не слушает ввод"
    );
    assert.ok(searchSrc.includes('classList.toggle("sfilter-hide"'), "поле прячется не своим классом");
    assert.ok(searchSrc.includes('"sfilter-open"'), "найденное в свёрнутой карточке не раскрывается");
    assert.ok(cssSrc.includes(".sfilter-hide { display: none !important; }"), "нет стиля скрытия в поиске");
    assert.ok(searchSrc.includes("el.placeholder"), "поиск не видит placeholder полей");
    assert.ok(searchSrc.includes('classList.contains("acc")'), "карточки провайдеров выпадают из поиска (ключ и модель в «Модели» лежат в .acc)");
    assert.ok(searchSrc.includes("data-search-label"), "результаты не подписаны категорией");
  });

  await test("настройки: вкладка запоминается, клик по кнопке не передаёт событие", () => {
    assert.ok(appSrc.includes("let lastSettingsTab"), "вкладка не запоминается");
    assert.ok(uiFile("settings-panel.js").includes('showSettingsTab(tab || getLastTab() || "model")'), "открытие настроек не восстанавливает вкладку");
    assert.ok(appSrc.includes('openSettings("model")'), "«выбрать модель» не ведёт на вкладку модели");
    assert.ok(!appSrc.includes('$("btn-settings").onclick = openSettings;'), "клик по кнопке настроек передаёт событие как вкладку");
    assert.ok(!appSrc.includes('$("btn-model-needed").onclick = openSettings;'), "кнопка «выбрать модель» передаёт событие как вкладку");
  });
}

async function testProjectPanel() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "project-panel.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  await test("панель проекта: модуль на месте, оболочка только собирает его", () => {
    // 1. Разметка грузит модуль раньше app.js; телефон получает тот же файл.
    const iTag = html.indexOf('src="project-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит project-panel.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "project-panel.js подключён после app.js");
    assert.ok(
      /"project-panel\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")),
      "мост не отдаёт модуль телефону"
    );

    // 2. В app.js не осталось кода панели — только сборка модуля с зависимостями.
    for (const gone of [
      "function refreshTree", "function loadChildren", "function buildTreeEntry",
      "function renderFileEditor", "function saveEditedFile", "function renderFileTabs",
      "function buildCommitRow", "function showDiff", "function doCommit",
      "function openPublishDialog", "function initProjectDnD", "function fetchRepos",
      "function wireGithubEvents", "function connectGithub",
    ]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код панели остался в app.js: " + gone);
    }
    assert.ok(/const ProjectPanel = window\.ProjectPanel\(\{/.test(appSrc), "app.js не собирает панель проекта");

    // 3. Живые зависимости. Настройки грузятся и сохраняются ЦЕЛИКОМ, поэтому внутрь
    //    идёт живая пара getSettings/setSettings: копия молча устарела бы.
    const wiringAt = appSrc.indexOf("const ProjectPanel = window.ProjectPanel({");
    const wiring = appSrc.slice(wiringAt, appSrc.indexOf("});", wiringAt));
    for (const dep of [
      "getSettings: () => settings", "setSettings: (s) => { settings = s; }",
      "normalize: normalize", "persistSettings: ChatStore.persistSettings", "toast: toast",
      "syncRail: SidePanel.syncRail", "ensureProjectChat: ensureProjectChat",
      "DevRun: DevRun", "SettingsPanel: SettingsPanel",
    ]) {
      assert.ok(wiring.includes(dep), "в проводку панели проекта не передано " + dep);
    }
    assert.ok(appSrc.indexOf("let githubReposList") === -1, "список репозиториев остался в оболочке");

    // 4. Проводки ДРУГИХ модулей стоят выше панели проекта: значение берётся отложенной
    //    стрелкой, иначе окно падает на загрузке («Cannot access before initialization»).
    for (const dep of [
      "esc: (t) => ProjectPanel.esc(t)",
      "getProjectPanel: () => ProjectPanel", "getYcPanel: () => YcPanel",
      "refreshProject: () => ProjectPanel.refreshProject()",
      "renderGithubSection: () => ProjectPanel.renderGithubSection()",
      "setSbVersion: (v) => { ProjectPanel.setSbVersion(v); }",
      "confirmModal: (...a) => ProjectPanel.confirmModal(...a)",
      "inputDialog: (...a) => ProjectPanel.inputDialog(...a)",
    ]) {
      assert.ok(appSrc.includes(dep), "отложенная зависимость потеряна: " + dep);
    }

    // 5. Оболочка не зовёт вынесенное напрямую — только через ProjectPanel.
    for (const name of [
      "refreshTree", "loadChildren", "renderFileEditor", "saveEditedFile", "doCommit",
      "doPush", "buildCommitRow", "showDiff", "initProjectDnD", "fetchRepos", "wireGithubEvents",
    ]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(appSrc), "оболочка зовёт " + name + " напрямую");
    }

    // 6. Границы модуля: своё состояние, настройки только через getSettings().
    for (const name of ["chatsData", "session", "streaming", "sideTab", "currentPreset"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }
    assert.ok(!/(^|[^\w.])settings\./.test(src), "модуль ходит в settings напрямую вместо getSettings()");
    assert.ok(!/localStorage|window\.api\b/.test(src), "модуль лезет в чужие глобалы");
  });

  await test("панель проекта: поднимается на объявленных зависимостях и отдаёт наружу нужное", () => {
    const calls = { toast: [], persisted: 0, statusBar: 0 };
    let settings = { workingDir: "/tmp/panel-proj", githubRepoDir: "", projects: [], activeProjectId: "" };
    // Маленький честный div: esc() строит текст через textContent -> innerHTML, поэтому
    // на «пустом объекте» он вернул бы пустую строку и проверка ничего бы не стоила.
    const escapingDiv = () => {
      const el = panelDom();
      Object.defineProperty(el, "textContent", {
        configurable: true,
        get() { return el.innerHTML; },
        set(v) {
          el.innerHTML = String(v == null ? "" : v)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        },
      });
      return el;
    };
    const documentStub = {
      getElementById: () => panelDom(),
      createElement: (tag) => (tag === "div" ? escapingDiv() : panelDom()),
      querySelector: () => panelDom(),
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible",
      body: { classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} },
      documentElement: { style: {}, classList: { add() {}, remove() {} } },
    };
    const sandbox = {
      module: { exports: {} },
      window: {},
      self: {},
      document: documentStub,
      console: { log() {}, warn() {}, error() {} },
    };
    const vm = require("vm");
    vm.runInNewContext(src, sandbox, { filename: "project-panel.js" });
    const panel = sandbox.module.exports({
      $: () => panelDom(),
      api: {},
      isElectron: false,
      getSettings: () => settings,
      setSettings: (s) => { settings = s; },
      normalize: (s) => s,
      persistSettings: () => { calls.persisted++; },
      toast: (t) => calls.toast.push(t),
      syncRail() {},
      toggleModelPopup() {},
      openSidePanel() {},
      ensureProjectChat() {},
      DevRun: { previewRunning: false, refreshDevControls() {} },
      SettingsPanel: { providerLabel: () => "Ollama", openSettings() {}, setSettingsMsg() {} },
    });
    assert.ok(panel, "фабрика ничего не вернула");

    // Наружу — ровно то, что зовёт оболочка (иначе «ProjectPanel.x не функция» в окне).
    for (const name of [
      "esc", "toastShort", "projectDir", "refreshProject", "refreshProjects", "switchProject",
      "fileIcon", "viewFile", "inputDialog", "newProjectFile", "newProjectFolder", "showPanelTab",
      "updateStatusBar", "doPush", "doPull", "openPublishDialog", "confirmModal",
      "renderGithubSection", "escHtml", "closeDeviceModal", "wireGithubEvents",
      "getFileViewPath", "setFileViewPath", "getSbVersion", "setSbVersion",
    ]) {
      assert.strictEqual(typeof panel[name], "function", "панель не отдаёт " + name);
    }

    // Живые значения: гашение файла и версия кода доходят до оболочки.
    assert.strictEqual(panel.esc('<i>&"'), "&lt;i&gt;&amp;&quot;", "esc испортился");
    assert.strictEqual(panel.projectDir(), "/tmp/panel-proj", "рабочая папка не из настроек");
    panel.setFileViewPath("/tmp/panel-proj/a.js");
    assert.strictEqual(panel.getFileViewPath(), "/tmp/panel-proj/a.js", "текущий файл не запомнился");
    panel.setSbVersion("1.5.137");
    assert.strictEqual(panel.getSbVersion(), "1.5.137", "версия кода не запомнилась");
    panel.toastShort("привет");
    assert.deepStrictEqual(calls.toast, ["привет"], "короткий тост не дошёл до окна");
    assert.ok(String(panel.fileIcon("a.js")).length > 0, "иконка файла пустая");
  });
}

async function testSettingsPanel() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings-panel.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");

  await test("панель настроек: модуль на месте, оболочка только собирает его", () => {
    // 1. Разметка грузит модуль раньше app.js; телефон получает тот же файл.
    const iTag = html.indexOf('src="settings-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит settings-panel.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "settings-panel.js подключён после app.js");
    assert.ok(
      /"settings-panel\.js"/.test(fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8")),
      "мост не отдаёт модуль телефону"
    );

    // 2. Кода панели в оболочке не осталось — только сборка модуля с зависимостями.
    const appSrc = uiFile("app.js");
    for (const gone of [
      "function fillSettingsUI", "function collectSettingsFromUI", "function openSettings",
      "function setProviderUI", "function setPreset", "function showSettingsTab", "function setSettingsMsg",
      "function renderModelHints", "function probeLocalModelUI", "function renderProbeResult",
      "function refreshProbeButton", "function renderOtaStatus", "function renderMemoryStatus",
      "function renderBrowserProfileInfo", "function renderBrowserConnectInfo", "function renderAgentFilesStatus",
      "function renderVisionDetect", "function saveSettingsUI", "function toggleKey", "function updateBadge",
    ]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код панели остался в app.js: " + gone);
    }
    assert.ok(/const SettingsPanel = window\.SettingsPanel\(\{/.test(appSrc), "app.js не собирает панель");

    // 3. Живые зависимости: настройки, пресет, последняя вкладка и версия кода переписываются —
    //    копия устарела бы молча (ровно так номер набора выдавал себя за версию кода в 1.5.135).
    // Проверяем СВОЮ проводку: те же строки встречаются и в сборке других модулей,
    // поэтому «где-то в app.js» — не доказательство (поймано негативным контролем).
    const wiring = appSrc.slice(appSrc.indexOf("const SettingsPanel = window.SettingsPanel({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of [
      "getSettings: () => settings", "getPreset: () => currentPreset", "setCurrentPreset: (p) => { currentPreset = p; }",
      "setSbVersion: (v) => { ProjectPanel.setSbVersion(v); }", "getLastTab: () => lastSettingsTab", "setLastTab: (t) => { lastSettingsTab = t; }",
      "getMobilePanel: () => MobilePanel", "getYcPanel: () => YcPanel", "search: SettingsSearch", "cachedModels: cachedModels",
    ]) {
      assert.ok(wiringCall.includes(dep), "в проводку панели не передано " + dep);
    }

    // 4. Границы модуля: своё состояние — только через внедрение.
    for (const name of ["chatsData", "session", "streaming", "msgEls", "currentPreset", "lastSettingsTab", "sbVersion", "projectDir"]) {
      assert.ok(!new RegExp("(^|[^\\w$.])" + name + "\\b").test(src), "модуль ссылается на " + name + " без внедрения");
    }
    assert.ok(!/(^|[^\w.])settings\./.test(src), "модуль ходит в settings напрямую вместо getSettings()");
    assert.ok(!/localStorage|window\.api\b/.test(src), "модуль лезет в чужие глобалы");
  });

  await test("панель настроек: поля, вкладки, пресет и сохранение работают на игрушечном DOM", () => {
    const els = new Map();
    const $ = (id) => {
      if (!els.has(id)) els.set(id, fakeEl(id));
      return els.get(id);
    };
    const cls = () => {
      const s = new Set();
      return {
        _s: s,
        add: (...cs) => cs.forEach((c) => s.add(c)),
        remove: (...cs) => cs.forEach((c) => s.delete(c)),
        contains: (c) => s.has(c),
        toggle: (c, on) => {
          const want = on === undefined ? !s.has(c) : !!on;
          if (want) s.add(c);
          else s.delete(c);
          return want;
        },
      };
    };
    const tabs = [{ dataset: { tab: "model" }, classList: cls() }, { dataset: { tab: "mail" }, classList: cls() }];
    const bodies = [{ dataset: { tabBody: "model" }, classList: cls() }, { dataset: { tabBody: "mail" }, classList: cls() }];
    const acc = cls();
    const documentStub = {
      querySelectorAll: (sel) => (sel === ".stab" ? tabs : sel === ".settings-tab-body" ? bodies : []),
      querySelector: (sel) =>
        String(sel).indexOf(".acc") === 0 ? { classList: acc, querySelector: () => ({ classList: cls() }) } : null,
      createElement: () => fakeEl("new"),
    };

    let searchActive = false; // состояние поиска по настройкам (его спрашивает переключение вкладок)
    const settings = {};
    const calls = { persisted: 0, collected: 0, preset: [], version: [], tab: [], toast: [], projectRefreshed: 0, modelNeeded: 0, search: [] };
    const sandbox = {
      module: { exports: {} },
      window: {},
      self: {},
      document: documentStub,
      console: { log() {}, warn() {}, error() {} },
    };
    const vm = require("vm"); // в этом файле vm подключается локально в каждой функции
    vm.runInNewContext(src, sandbox, { filename: "settings-panel.js" });
    const api = sandbox.module.exports({
      $: $,
      api: {},
      isElectron: false,
      getSettings: () => settings,
      getPreset: () => "deepseek",
      setCurrentPreset: (p) => calls.preset.push(p),
      setSbVersion: (v) => calls.version.push(v),
      cachedModels: {},
      persistSettings: () => { calls.persisted++; },
      updateStatusBar: () => {},
      updateModelNeeded: () => { calls.modelNeeded++; },
      refreshProject: () => { calls.projectRefreshed++; },
      toast: (tx) => calls.toast.push(tx),
      esc: (s) => String(s),
      renderGithubSection: () => {},
      probeG4fPort: () => {},
      renderG4fProviderList: () => {},
      search: { active: () => searchActive, reset: () => calls.search.push("reset") },
      getLastTab: () => "model",
      setLastTab: (n) => calls.tab.push(n),
      getMobilePanel: () => ({ applyMobileFields: () => calls.search.push("mobileFill"), readMobileFields: () => calls.search.push("mobileRead") }),
      AgentCore: { roleById: (id) => ({ id: id || "coder" }), imageProviderLabel: () => "OpenRouter" },
      SecretsPanel: { renderEnvVars: () => {}, renderVault: () => {} },
      getYcPanel: () => ({ refreshSettingsUI: () => {} }),
      OpenaiProfiles: { render: () => {} },
      PRESETS: { deepseek: { url: "https://api.deepseek.com", model: "deepseek-chat" } },
      PRESET_LABEL: { deepseek: "DeepSeek" },
      MODEL_KEY: { ollama: "ollamaModel", openai: "openaiModel", anthropic: "anthropicModel" },
      MODEL_INPUT: { ollama: "s-ollama-model", openai: "s-openai-model", anthropic: "s-anth-model" },
      URL_INPUT: { ollama: "s-ollama-url", openai: "s-openai-url", anthropic: "s-anth-url" },
      URL_KEY: { ollama: "ollamaUrl", openai: "openaiUrl", anthropic: "anthropicUrl" },
    });
    for (const fn of ["openSettings", "fillSettingsUI", "collectSettingsFromUI", "showSettingsTab", "setPreset",
      "setProviderUI", "setSettingsMsg", "saveSettingsUI", "renderOtaStatus", "renderMemoryStatus",
      "renderBrowserConnectInfo", "renderAgentFilesStatus", "toggleKey", "probeLocalModelUI", "loadModels",
      "testConnection", "requestModelsList", "renderModelHints", "loadAuxModels", "renderVisionDetect",
      "renderBrowserProfileInfo", "refreshProbeButton", "renderProbeResult", "updateBadge", "providerLabel"]) {
      assert.strictEqual(typeof api[fn], "function", "модуль не отдаёт " + fn);
    }

    // 1. Заполнение полей из памяти: что лежит в настройках, то и в поле.
    settings.openaiUrl = "https://api.example.com/v1";
    settings.openaiApiKey = "sk-test";
    settings.openaiModel = "модель-1";
    settings.visionEnabled = true;
    settings.otaDir = "D:/проект/ota";
    settings.sendAllTools = true;
    settings.agentWorkFiles = false;
    api.fillSettingsUI();
    assert.strictEqual($("s-openai-url").value, "https://api.example.com/v1", "адрес не доехал в поле");
    assert.strictEqual($("s-openai-key").value, "sk-test", "ключ не доехал в поле");
    assert.strictEqual($("s-openai-model").value, "модель-1", "модель не доехала в поле");
    assert.strictEqual($("s-ota-dir").value, "D:/проект/ota", "папка обновлений не доехала в поле");
    assert.strictEqual($("s-vision-enabled").checked, true, "галочка зрения не восстановлена");
    assert.strictEqual($("s-send-all-tools").checked, true, "галочка «все инструменты» не восстановлена");
    assert.strictEqual($("vision-fields").classList.contains("hidden"), false, "поля зрения остались скрытыми");
    assert.ok(calls.search.indexOf("mobileFill") !== -1, "поля мобильной панели не заполняются");

    // 2. Обратное чтение: правки в полях уходят в настройки (тот же объект — живой).
    $("s-openai-url").value = "https://api.other.com/v1";
    $("s-openai-key").value = "  sk-новый  ";
    $("s-openai-model").value = "модель-2";
    $("s-mail-smtp-port").value = "2525";
    $("s-allow-agent-push").checked = true;
    api.collectSettingsFromUI();
    assert.strictEqual(settings.openaiUrl, "https://api.other.com/v1", "адрес не сохранился");
    assert.strictEqual(settings.openaiApiKey, "sk-новый", "ключ не обрезан");
    assert.strictEqual(settings.openaiModel, "модель-2", "модель не сохранилась");
    assert.strictEqual(settings.mailSmtpPort, 2525, "порт почты не сохранился");
    assert.strictEqual(settings.allowAgentPush, true, "разрешение пуша не сохранилось");
    assert.ok(calls.search.indexOf("mobileRead") !== -1, "поля мобильной панели не читаются обратно");

    // 3. Вкладки: переключение запоминается, активный поиск сбрасывается, лишние вкладки скрыты.
    searchActive = true; // в поле поиска что-то было — панель обязана вернуть вкладки
    api.showSettingsTab("mail");
    assert.deepStrictEqual(calls.tab, ["mail"], "вкладка не запомнилась");
    assert.strictEqual(tabs[1].classList.contains("active"), true, "нажатая вкладка не подсвечена");
    assert.strictEqual(tabs[0].classList.contains("active"), false, "старая вкладка осталась активной");
    assert.strictEqual(bodies[1].classList.contains("hidden"), false, "тело вкладки «Почта» скрыто");
    assert.strictEqual(bodies[0].classList.contains("hidden"), true, "чужое тело вкладки показано");
    assert.strictEqual(calls.search.filter((x) => x === "reset").length, 1, "активный поиск не сброшен при переключении вкладок");

    // 4. Пресет: подставляет адрес и модель, пишет пресет через живую функцию.
    api.setPreset("deepseek");
    assert.deepStrictEqual(calls.preset, ["deepseek"], "пресет не записан");
    assert.strictEqual($("s-openai-url").value, "https://api.deepseek.com", "адрес пресета не подставился");
    assert.strictEqual($("s-openai-model").value, "deepseek-chat", "модель пресета не подставилась");
    assert.strictEqual($("yandex-project-field").classList.contains("hidden"), true, "поле Yandex показано не вовремя");
    assert.strictEqual($("g4f-hint").classList.contains("hidden"), true, "подсказка G4F показана не вовремя");

    // 5. Сообщение панели: текст и признак ошибки.
    api.setSettingsMsg("Сохранено", false);
    assert.strictEqual($("settings-msg").textContent, "Сохранено", "сообщение не дошло до панели");
    assert.strictEqual($("settings-msg").className, "settings-msg ok", "класс успеха не выставлен");
    api.setSettingsMsg("Ошибка", true);
    assert.strictEqual($("settings-msg").className, "settings-msg err", "класс ошибки не выставлен");

    // 6. Сохранение: перечитать поля, записать настройки, закрыть окно, сказать человеку.
    api.saveSettingsUI();
    assert.ok(calls.persisted >= 1, "настройки не записаны на диск");
    assert.ok(calls.modelNeeded >= 1, "перед сохранением не проверено наличие модели");
    assert.ok(calls.projectRefreshed >= 1, "проект не перечитан после смены рабочей папки");
    assert.deepStrictEqual(calls.toast, ["Настройки сохранены"], "человек не увидел подтверждения");
    assert.strictEqual($("settings-overlay").classList.contains("hidden"), true, "окно настроек осталось открытым");

    // 7. Глазок у секретного поля: пароль ↔ текст, ничего больше.
    $("s-openai-key").type = "password";
    api.toggleKey("s-openai-key");
    assert.strictEqual($("s-openai-key").type, "text", "секрет не показался");
    api.toggleKey("s-openai-key");
    assert.strictEqual($("s-openai-key").type, "password", "секрет не спрятался обратно");

    // 8. Открытие панели: секреты перечитаны, поля заполнены, окно показано, сообщение очищено.
    $("settings-overlay").classList.add("hidden");
    searchActive = false; // поиск пуст — трогать вкладки не нужно
    api.openSettings("model");
    assert.strictEqual(calls.search.filter((x) => x === "reset").length, 1, "поиск сбрасывается, даже когда его нет");
    assert.strictEqual($("settings-overlay").classList.contains("hidden"), false, "окно настроек не открылось");
    assert.strictEqual($("settings-msg").textContent, "", "старое сообщение осталось в панели");
    assert.deepStrictEqual(calls.tab, ["mail", "model"], "открытие не переключило вкладку");

    // 9. Внешние вызовы настроек не роняют окно в браузере (нет Electron) — говорят словами.
    api.renderOtaStatus();
    assert.ok(/Доступно в приложении на ПК/.test($("ota-status").textContent), "статус обновлений молчит в браузере");
    api.renderMemoryStatus();
    assert.ok($("memory-status").textContent.length > 0, "статус памяти пуст");
  });
}

async function testSettingsSearchLogic() {

  await test("поиск настроек: фильтрует по всем вкладкам, включая карточки провайдеров", () => {
    // Модуль берём с диска целиком и собираем ТОЙ ЖЕ фабрикой, что и приложение:
    // проверяется настоящий код, а не вырезка из app.js.
    const searchSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "settings-search.js"), "utf8");
    const d = miniDom();
    const sandbox = {
      module: { exports: {} },
      window: {},
      self: {},
      document: d.document,
      console: { log() {}, warn() {}, error() {} },
    };
    const vm = require("vm"); // в этом файле vm подключается локально в каждой функции
    vm.runInNewContext(searchSrc, sandbox, { filename: "settings-search.js" });
    const api = sandbox.module.exports({ $: d.$, getLastTab: () => "model" });
    const apply = api.apply;
    assert.ok(api.active && api.reset && api.input && api.fieldText, "модуль поиска отдаёт не все входы");

    // 1. Поиск ключа: карточка OpenAI-совместимых должна быть видна, Ollama — нет.
    d.input.value = "ключ";
    apply("ключ");
    assert.ok(!d.bodyModel.classList.contains("hidden"), "вкладка «Модель» пропала из результатов");
    assert.ok(d.bodyMail.classList.contains("hidden"), "вкладка «Почта» осталась без совпадений");
    assert.ok(d.accOpenai.classList.contains("sfilter-hide") === false, "карточка с API-ключом скрыта");
    assert.ok(d.accOllama.classList.contains("sfilter-hide") === true, "карточка без совпадений показана");
    assert.ok(d.accOpenai.classList.contains("open"), "найденная свёрнутая карточка не раскрылась");
    assert.ok(d.accOpenai.classList.contains("sfilter-open"), "карточка не помечена как раскрытая поиском");
    assert.ok(d.secProvider.classList.contains("sfilter-hide"), "секция без совпадений видна");
    assert.ok(d.hints.classList.contains("sfilter-hide"), "служебный блок (подсказки моделей) виден в результатах");
    assert.ok(d.empty.classList.contains("hidden"), "«ничего не найдено» показано при совпадениях");
    assert.ok(d.content.classList.contains("search-mode"), "нет режима результатов");
    assert.strictEqual(d.bodyModel.getAttribute("data-search-label"), "Модель", "результаты не подписаны категорией");

    // 2. Поиск по другой вкладке: видна «Почта», «Модель» скрыта, подпись своя.
    apply("пароль");
    assert.ok(!d.bodyMail.classList.contains("hidden"), "«Почта» не найдена по слову «пароль»");
    assert.ok(d.bodyMail.getAttribute("data-search-label") === "Почта", "подпись категории не обновилась");
    assert.ok(d.bodyModel.classList.contains("hidden"), "«Модель» показана без совпадений");

    // 3. Ничего не найдено — честное сообщение, обе вкладки скрыты.
    apply("нет-такого-слова-вообще");
    assert.ok(d.empty.classList.contains("hidden") === false, "нет сообщения «ничего не найдено»");
    assert.ok(d.bodyModel.classList.contains("hidden") && d.bodyMail.classList.contains("hidden"), "вкладки видны без совпадений");

    // 4. Очистка: возвращаемся на запомненную вкладку, чужие классы не тронуты.
    apply("");
    assert.ok(!d.bodyModel.classList.contains("hidden"), "после очистки не вернулись на «Модель»");
    assert.ok(d.bodyMail.classList.contains("hidden"), "после очистки видна чужая вкладка");
    assert.ok(d.empty.classList.contains("hidden"), "после очистки висит «ничего не найдено»");
    assert.ok(!d.content.classList.contains("search-mode"), "режим результатов не выключился");
    assert.ok(!d.accOpenai.classList.contains("sfilter-open") && !d.accOpenai.classList.contains("open"), "карточка осталась раскрытой поиском");
    assert.ok(!d.secProvider.classList.contains("sfilter-hide"), "после очистки остались скрытые секции");
    assert.ok(d.hints.classList.contains("hidden"), "служебный .hidden не должен сниматься поиском");

    // 5. Замер локальной модели находится поиском: подпись поля слова «замерить»
    // не содержит, а кнопка и её подсказка — содержат.
    apply("замерить");
    assert.ok(d.accOllama.classList.contains("sfilter-hide") === false, "поиск по «замерить» не нашёл замер скорости");
    assert.ok(d.accOpenai.classList.contains("sfilter-hide") === true, "чужая карточка показана при поиске замера");
    assert.ok(d.accOllama.classList.contains("sfilter-open"), "карточка с замером не раскрылась для показа");
    apply("чтение промпта");
    assert.ok(d.accOllama.classList.contains("sfilter-hide") === false, "подсказка кнопки замера не участвует в поиске");

    // 6. Границы модуля: чужое состояние — только через deps.
    for (const name of ["chatsData", "session", "streaming", "msgEls", "currentPreset", "PRESETS", "projectDir"]) {
      assert.ok(
        !new RegExp("(^|[^\\w$.])" + name + "\\b").test(searchSrc),
        "модуль поиска ссылается на " + name + " без внедрения"
      );
    }
    // 7. Негативный контроль зависимости: забытый DOM — понятная ошибка, а не тихий отказ.
    const noDeps = sandbox.module.exports({ getLastTab: () => "model" });
    assert.throws(() => noDeps.apply("ключ"), /\$|is not a function/, "без $ поиск не упал");
  });

  await test("замер локальной модели: отчёт рисуется в панели, кнопка видна только для местной модели", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const render = uiFind("  function renderProbeResult(res) {", "  // Кнопка «Замерить скорость» в подвале").code;
    const shown = { text: "", cls: new Set(["probe-result", "hidden"]) };
    const box = {
      set textContent(v) { shown.text = v; },
      get textContent() { return shown.text; },
      classList: { remove: (c) => shown.cls.delete(c), add: (c) => shown.cls.add(c) },
    };
    const draw = new Function("$", render + "\nreturn renderProbeResult;")((id) => (id === "ollama-probe-result" ? box : null));
    draw({ ok: true, lines: ["Сервер отвечает за 12 мс", "Генерация: 6 ток/с"], advice: ["Возьми модель поменьше"] });
    assert.ok(/12 мс/.test(shown.text), "цифры отчёта не дошли до панели: " + shown.text);
    assert.ok(/6 ток\/с/.test(shown.text), "скорость генерации не показана: " + shown.text);
    assert.ok(/Возьми модель поменьше/.test(shown.text), "советы не показаны: " + shown.text);
    assert.ok(!shown.cls.has("hidden"), "панель отчёта осталась скрытой");
    // Отказ тоже объясняется словами, а не пустой панелью.
    shown.text = "";
    draw({ ok: false, lines: [] });
    assert.ok(/не удался|не измерена/.test(shown.text), "отказ показан непонятно: " + shown.text);

    // Видимость кнопки: местная модель — видна, облако — спрятана.
    const show = uiFind("  function refreshProbeButton() {", "  async function probeLocalModelUI() {").code;
    const run = (local) => {
      const btn = { cls: new Set(["btn", "hidden"]) };
      btn.classList = {
        add: (c) => btn.cls.add(c),
        remove: (c) => btn.cls.delete(c),
        toggle: (c, on) => (on ? btn.cls.add(c) : btn.cls.delete(c)),
      };
      // Кнопка живёт в панели настроек: настройки приходят туда живой функцией getSettings().
      const fn = new Function("$", "AgentCore", "getSettings", show + "\nreturn refreshProbeButton;")((id) => (id === "btn-probe-model" ? btn : null), { isLocalEndpoint: () => local }, () => ({}));
      fn();
      return btn.cls;
    };
    assert.ok(run(true).has("hidden") === false, "для местной модели кнопка замера спрятана");
    assert.ok(run(false).has("hidden") === true, "для облачной модели кнопка замера показана");

    // Разметка и проводка: кнопка есть, спрятана до проверки типа модели, нажатие подключено.
    assert.ok(html.indexOf('id="btn-probe-model"') !== -1, "кнопки замера нет в подвале настроек");
    assert.ok(/id="btn-probe-model"[^>]*class="[^>]*hidden/.test(html), "кнопка в подвале видна до проверки типа модели");
    const appSrc2 = uiFile("app.js");
    assert.ok(/\$\("btn-probe-model"\)\.onclick/.test(appSrc2), "кнопка в подвале не подключена");
    const setProv = uiFind("  function setProviderUI(p) {", "  function showSettingsTab(name) {").code;
    assert.ok(/refreshProbeButton\(\);/.test(setProv), "видимость кнопки замера не обновляется при смене провайдера");
    // Список действий палитры живёт своим модулем (этап 8) — ищем в нём, а не в app.js.
    assert.ok(/Замерить скорость локальной модели/.test(uiFile("command-palette.js")), "в палитре команд нет замера");
  });
}

// ── 4d. Левая рельса (как в Replit): разметка + живая логика ───────────────
async function testLeftRail() {
  // Рельса и сворачивание панели чатов живут в side-panel.js (этап 9): читаем модуль,
  // а не адрес кода. Разметка и живая логика — по-прежнему здесь.
  const panelSrc = uiFile("side-panel.js");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");

  const RAIL_IDS = ["rail-chats", "rail-console", "rail-preview", "rail-files", "rail-cloud", "rail-new", "rail-settings"];

  await test("рельса: иконки в разметке, цель каждой есть в шапке/панелях", () => {
    for (const id of RAIL_IDS) assert.ok(html.indexOf('id="' + id + '"') !== -1, "нет иконки " + id);
    assert.ok(html.indexOf('id="rail-cloud-dot"') !== -1, "у облака на рельсе нет точки состояния");
    assert.ok(html.indexOf('id="btn-side-collapse"') !== -1, "нет кнопки сворачивания панели чатов");
    // Рельса должна стоять ДО списка чатов и внутри #app: иначе она уедет под панель.
    const app = html.indexOf('id="app"');
    const rail = html.indexOf('id="rail"');
    const side = html.indexOf('id="sidebar"');
    assert.ok(app > 0 && rail > app && rail < side, "рельса не между началом #app и списком чатов");
    // Каждая иконка нажимает реально существующую кнопку: иначе клик уходит в никуда.
    const targets = ["btn-toggle-console", "btn-toggle-preview", "btn-toggle-cloud", "btn-toggle-panel", "btn-new-chat", "btn-settings"];
    for (const t of targets) assert.ok(html.indexOf('id="' + t + '"') !== -1, "нет цели нажатия " + t);
    for (const r of RAIL_IDS.slice(1, 6)) {
      assert.ok(panelSrc.indexOf('proxy("' + r + '"') !== -1, "иконка " + r + " ни на что не нажимает");
    }
    assert.ok(panelSrc.indexOf('proxy("rail-new", "btn-new-chat")') !== -1, "«новый чат» на рельсе не работает");
    assert.ok(panelSrc.indexOf('proxy("rail-settings", "btn-settings")') !== -1, "«настройки» на рельсе не работают");
  });

  await test("рельса: панель чатов сворачивается, рельса остаётся", () => {
    assert.ok(/function setSidebarCollapsed\(/.test(panelSrc), "нет сворачивания панели чатов");
    assert.ok(/localStorage\.setItem\("sidebarCollapsed"/.test(panelSrc), "свёрнутость не запоминается");
    assert.ok(/#sidebar\.collapsed \{[\s\S]*?width: 0;/.test(css), "свёрнутая панель не уезжает");
    // На телефоне свёрнутость не должна ломать выезжающую панель.
    const m900 = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
    assert.ok(m900, "нет блока max-width: 900px");
    assert.ok(/#rail \{ display: none; \}/.test(m900[1]), "на телефоне рельса не скрыта");
    assert.ok(/#sidebar\.collapsed \{[\s\S]*?width: 276px;/.test(m900[1]), "на телефоне свёрнутая панель перестаёт выезжать");
  });

  await test("рельса: нажатия переключают панели, подсветка синхронна", () => {
    // Живая логика: берём из app.js синхронизацию и навешивание обработчиков и
    // прогоняем на игрушечном DOM — проверяем поведение, а не наличие строк.
    const railLogic = uiFind("  // Рельса слева (как в Replit): иконки переиспользуют", "  function sidePanelVisible() {");
    const railWiring = uiFind("  // ── Рельса слева: иконки нажимают те же кнопки шапки ──", "  $(\"btn-sp-close\")");
    assert.ok(railLogic.start > 0 && railWiring.start > 0, "не нашёл логику рельсы в интерфейсе");
    const code =
      railLogic.code +
      railWiring.code +
      "\nreturn { syncRail, setSidebarCollapsed, toggleSidebarCollapsed };";

    const el = () => {
      const e = { _c: new Set(), title: "", onclick: null };
      // Как в браузере: click() вызывает обработчик — рельса нажимает кнопки шапки именно так.
      e.click = () => { if (e.onclick) e.onclick(); };
      Object.defineProperty(e, "classList", {
        value: {
          contains: (c) => e._c.has(c),
          add: (...cs) => cs.forEach((c) => e._c.add(c)),
          remove: (...cs) => cs.forEach((c) => e._c.delete(c)),
          toggle: (c, on) => {
            const want = on === undefined ? !e._c.has(c) : !!on;
            if (want) e._c.add(c);
            else e._c.delete(c);
            return want;
          },
        },
      });
      return e;
    };
    const ids = RAIL_IDS.concat([
      "rail-cloud-dot",
      "sidebar",
      "btn-side-collapse",
      "btn-toggle-console",
      "btn-toggle-preview",
      "btn-toggle-cloud",
      "btn-toggle-panel",
      "btn-new-chat",
      "btn-settings",
    ]);
    const nodes = {};
    for (const id of ids) nodes[id] = el();
    // Кнопки шапки ведут себя как настоящие: переключают свою подсветку.
    nodes["btn-toggle-console"].onclick = () => nodes["btn-toggle-console"].classList.toggle("active");
    nodes["btn-toggle-preview"].onclick = () => nodes["btn-toggle-preview"].classList.toggle("active");
    nodes["btn-toggle-cloud"].onclick = () => nodes["btn-toggle-cloud"].classList.toggle("active");
    nodes["btn-toggle-panel"].onclick = () => nodes["btn-toggle-panel"].classList.toggle("active");
    let created = 0;
    nodes["btn-new-chat"].onclick = () => { created++; };

    const store = {};
    const localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    const win = { innerWidth: 1280 };
    const fakeDoc = { getElementById: (id) => nodes[id] || null };
    const run = new Function("document", "$", "localStorage", "window", code)(fakeDoc, fakeDoc.getElementById, localStorage, win);

    // 1. Старт: панель развёрнута, иконка «Чаты» подсвечена.
    assert.ok(!nodes.sidebar.classList.contains("collapsed"), "панель чатов свёрнута при старте");
    assert.ok(nodes["rail-chats"].classList.contains("active"), "«Чаты» не подсвечены при старте");

    // 2. Сворачиваем иконкой: панель уезжает, состояние запоминается, подсветка снята.
    nodes["rail-chats"].onclick();
    assert.ok(nodes.sidebar.classList.contains("collapsed"), "клик по «Чаты» не свернул панель");
    assert.strictEqual(store.sidebarCollapsed, "1", "свёрнутость не запомнилась");
    assert.ok(!nodes["rail-chats"].classList.contains("active"), "«Чаты» подсвечены у свёрнутой панели");

    // 3. Кнопка в шапке панели разворачивает обратно.
    nodes["btn-side-collapse"].onclick();
    assert.ok(!nodes.sidebar.classList.contains("collapsed"), "кнопка в шапке не разворачивает панель");
    assert.strictEqual(store.sidebarCollapsed, "0", "разворот не запомнился");
    assert.ok(nodes["rail-chats"].classList.contains("active"), "«Чаты» не подсветились после разворота");

    // 4. Иконка панели нажимает кнопку шапки и подсвечивается вместе с ней.
    nodes["rail-console"].onclick();
    assert.ok(nodes["btn-toggle-console"].classList.contains("active"), "иконка консоли не нажала кнопку шапки");
    assert.ok(nodes["rail-console"].classList.contains("active"), "иконка консоли не подсветилась");
    nodes["rail-console"].onclick();
    assert.ok(!nodes["rail-console"].classList.contains("active"), "повторный клик не снял подсветку");

    // 5. Кнопка шапки, нажатая напрямую, тоже обновляет рельсу (syncRail).
    nodes["btn-toggle-panel"].classList.add("active");
    run.syncRail();
    assert.ok(nodes["rail-files"].classList.contains("active"), "рельса не синхронизировалась с панелью файлов");

    // 6. Новый чат и настройки: иконки нажимают настоящие кнопки.
    nodes["rail-new"].onclick();
    assert.strictEqual(created, 1, "иконка «новый чат» не создала чат");

    // 7. Свёрнутость восстанавливается при запуске.
    store.sidebarCollapsed = "1";
    const nodes2 = {};
    for (const id of ids) nodes2[id] = el();
    const fakeDoc2 = { getElementById: (id) => nodes2[id] || null };
    new Function("document", "$", "localStorage", "window", code)(fakeDoc2, fakeDoc2.getElementById, localStorage, win);
    assert.ok(nodes2.sidebar.classList.contains("collapsed"), "свёрнутость не восстановилась при запуске");

    // 8. На телефоне рельса прячется, а иконка «Чаты» открывает выезжающую панель.
    store.sidebarCollapsed = "0";
    win.innerWidth = 500;
    const nodes3 = {};
    for (const id of ids) nodes3[id] = el();
    const fakeDoc3 = { getElementById: (id) => nodes3[id] || null };
    new Function("document", "$", "localStorage", "window", code)(fakeDoc3, fakeDoc3.getElementById, localStorage, win);
    nodes3["rail-chats"].onclick();
    assert.ok(nodes3.sidebar.classList.contains("open"), "на телефоне «Чаты» не открывают панель");
    assert.ok(!nodes3.sidebar.classList.contains("collapsed"), "на телефоне панель свернулась вместо выезда");
  });
}

// ── 4e. Преграды из отчёта песочницы: лимит 429, ленивые списки, формат шагов ─
async function testSandboxObstacles() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core"));
  const tools = require(path.join(ROOT, "src", "browser-tools"));
  const mainSrc = backendSrc();
  const toolsSrc = fs.readFileSync(path.join(ROOT, "src", "browser-tools.js"), "utf8");

  await test("лимит 429: пауза читается из заголовка, текста и частоты", () => {
    const hdr = { get: (k) => (k.toLowerCase() === "retry-after" ? "12" : null) };
    assert.deepStrictEqual(core.rateLimitInfo(429, hdr, "").retryMs, 12000, "Retry-After не прочитан");
    const ms = core.rateLimitInfo(429, null, "Please retry in 12.3s").retryMs;
    assert.ok(Math.abs(ms - 12300) < 50, "«retry in 12.3s» не разобран: " + ms);
    assert.strictEqual(core.rateLimitInfo(429, null, '{"error":{"retryDelay":"7s"}}').retryMs, 7000, "retryDelay не разобран");
    assert.strictEqual(core.rateLimitInfo(429, null, "try again in 2 minutes").retryMs, 120000, "минуты не разобраны");
    assert.strictEqual(core.rateLimitInfo(429, null, "8 requests per minute").rpm, 8, "частота запросов не разобрана");
    // Ничего лимитного в тексте — не выдумываем паузу.
    assert.strictEqual(core.rateLimitInfo(500, null, "internal error").retryMs, 0, "пауза придумана из ничего");

    // Окно лимита: провайдеры пишут его по-разному, а ждать надо именно окно.
    // Реальная ошибка OpenRouter-подобного пула (z-ai/glm): три короткие паузы её не лечат.
    const zai = "You have reached the request limit[z-ai/glm-5.3-free]: Maximum 8 requests within 1 minutes. (request id: 20260913223056261579680h7bsHtrz)";
    assert.strictEqual(core.rateLimitInfo(429, null, zai).rpm, 8, "«within 1 minutes» не разобрано");
    assert.strictEqual(core.rateLimitInfo(429, null, zai).retryMs, 60000, "пауза не равна окну лимита");
    assert.strictEqual(core.rateLimitInfo(429, null, "Maximum 30 requests in 1 minute").rpm, 30, "«in 1 minute» не разобрано");
    assert.strictEqual(core.rateLimitInfo(429, null, "10 запросов в минуту").rpm, 10, "русский лимит не разобран");
    assert.strictEqual(core.rateLimitInfo(429, null, "60 requests per hour").rpm, 1, "часовое окно не разобрано");
    assert.strictEqual(core.rateLimitInfo(429, null, "60 requests per hour").retryMs, 120000, "часовое окно без потолка");
  });

  await test("лимит 429: темп держится заранее, а не после отказа", async () => {
    const lim = core.createRateLimiter();
    // Узнали частоту 60/min → интервал 1 с: второй вызов обязан подождать.
    lim.note({ rpm: 60, retryMs: 0 });
    const t0 = Date.now();
    await lim.take();
    await lim.take();
    const waited = Date.now() - t0;
    assert.ok(waited >= 900, "темп не выдержан (ждали " + waited + " мс)");
    // После 429 пауза от провайдера учитывается: следующий запрос ждёт её целиком.
    const l2 = core.createRateLimiter();
    l2.note({ retryMs: 700 });
    assert.ok(l2.pendingMs() >= 600, "пауза после 429 не запомнена");
  });

  await test("main.js: 429 больше не роняет раунд (ждём сами и повторяем)", () => {
    assert.ok(/rateLimiter: rateLimiterFor\(settings\)/.test(mainSrc), "нет держателя темпа в main.js");
    assert.ok(/const paced = await rateLimiter\.take\(\);/.test(mainSrc), "запросы не расставляются по темпу заранее");
    assert.ok(/if \(status === 429\) \{/.test(mainSrc), "429 не обрабатывается");
    // Предела «не больше 3 попыток» больше нет: именно он заставлял пользователя
    // писать «продолжай» руками при лимите «8 запросов в минуту».
    assert.ok(!/rateRetries < 3/.test(mainSrc), "вернулся жёсткий предел в 3 попытки");
    assert.ok(/state\.rateRetries\+\+;/.test(mainSrc), "лимит раунда не отмечается");
    // Повтор раунда: с правки 1.5.173 между `round--` и `continue` стоит пометка
    // «это та же попытка» — условный ход остаётся тем же.
    assert.ok(
      /if \(roundOut\.kind === "repeat"\) \{[\s\S]{0,220}round--;[\s\S]{0,220}continue;/.test(mainSrc),
      "повтор не возвращает раунд на перезапуск"
    );
    assert.ok(
      /const noteSuccess = \(\) => \{\s*state\.rateRetries = 0;\s*state\.unavailableRetries = 0;/.test(mainSrc),
      "счётчики повторов не сбрасываются на успехе"
    );
    // Ждём до бюджета, и бюджет ограничивает паузу сверху — иначе прогон висел бы вечно.
    assert.ok(/RATE_WAIT_BUDGET_MS/.test(mainSrc), "нет бюджета ожидания лимита");
    assert.ok(/state\.rateWaitedMs \+= waitMs/.test(mainSrc), "ожидание не накапливается");
    assert.ok(/Math\.min\(wantMs, leftMs\)/.test(mainSrc), "пауза не ограничена бюджетом");
    // Пользователь должен видеть, что прогон жив и ждёт сам.
    assert.ok(/type: "notice"/.test(mainSrc), "пользователю не сообщают об ожидании");
    // Порядок важен: сначала совет по токенному лимиту Groq (повтор там бессмысленен).
    const i = mainSrc.indexOf("const friendly = friendlyRateLimitError(status, detail, settings);");
    const j = mainSrc.indexOf("if (status === 429) {");
    assert.ok(i > 0 && j > i, "повтор 429 стоит раньше совета по токенному лимиту");

    // Веб-режим (превью и телефон) раньше падал на 429 сразу: своей обработки там не было
    // вовсе, и прогон заканчивался ошибкой до всякого ожидания.
    const webSrc = uiAll(); // веб-режим живёт в src/renderer/web-chat.js
    assert.ok(/if \(res\.status === 429\) \{/.test(webSrc), "в веб-режиме 429 не обрабатывается");
    assert.ok(/RATE_WAIT_BUDGET_MS = 10 \* 60 \* 1000/.test(webSrc), "в веб-режиме нет бюджета ожидания");
    assert.ok(/rateWaitedMs \+= waitMs;/.test(webSrc), "в веб-режиме ожидание не накапливается");
  });

  await test("догрузка ленивого списка: останавливается сама, когда новое кончилось", async () => {
    assert.strictEqual(tools.lazyKeyOf({ y: 10, max: 100, inner: [] }, 50), tools.lazyKeyOf({ y: 10, max: 100, inner: [] }, 50), "ключ роста не стабилен");
    assert.notStrictEqual(tools.lazyKeyOf({ y: 10, max: 100, inner: [] }, 50), tools.lazyKeyOf({ y: 10, max: 100, inner: [] }, 51), "рост текста не виден");
    assert.notStrictEqual(
      tools.lazyKeyOf({ y: 10, max: 100, inner: [{ top: 0, max: 50 }] }, 50),
      tools.lazyKeyOf({ y: 10, max: 100, inner: [{ top: 0, max: 90 }] }, 50),
      "рост внутреннего контейнера не виден"
    );
    // Позиция прокрутки — НЕ рост содержимого: иначе догрузка не остановится сама.
    assert.strictEqual(
      tools.lazyKeyOf({ y: 10, max: 100, docH: 900 }, 50),
      tools.lazyKeyOf({ y: 900, max: 100, docH: 900 }, 50),
      "прокрутка по уже загруженному считается новым содержимым"
    );

    // Игрушечная страница: текст растёт три прокрутки, потом список кончился.
    const fakePage = (growUntil) => {
      const st = { y: 0, max: 5000, text: 1000, scrolls: 0 };
      const page = {
        viewportSize: () => ({ width: 1000, height: 800 }),
        mouse: {
          move: async () => {},
          wheel: async (dx, dy) => {
            st.scrolls++;
            st.y = Math.max(0, Math.min(st.max, st.y + dy));
            if (st.scrolls <= growUntil) st.text += 400;
          },
        },
        evaluate: async (fn) => {
          const s = String(fn);
          if (fn.name === "scrollStateInPage") return { y: st.y, max: st.max, vh: 800, docH: st.max + 800, inner: [] };
          if (/scrollingElement/.test(s)) return st.y + ":0";
          if (/innerText/.test(s)) return st.text;
          if (fn.name === "scrollPageInPage") return { mode: "page", moved: 700, y: st.y, max: st.max };
          return null;
        },
      };
      return page;
    };

    const done = await tools.loadAllScroll(fakePage(3), { times: 12, read: true });
    assert.ok(/догрузил страницу down/.test(done), "нет строки о догрузке: " + done.slice(0, 120));
    assert.ok(/конец списка/.test(done), "не понял, что список кончился: " + done.slice(0, 200));
    assert.ok(/Новое содержимое появилось на 3/.test(done), "неверный счётчик новых шагов: " + done.slice(0, 200));

    const stuck = await tools.loadAllScroll(fakePage(0), { times: 12, read: true });
    assert.ok(/Новое содержимое появилось на 0/.test(stuck), "при пустом списке считает рост: " + stuck.slice(0, 160));
    assert.ok(/конец списка/.test(stuck), "на пустом списке не остановился");

    const running = await tools.loadAllScroll(fakePage(99), { times: 4, read: true });
    assert.ok(/предел 4 шагов/.test(running), "не сказал про предел шагов: " + running.slice(0, 200));
  });

  await test("browserAct: один объект вместо массива и строковые шаги", () => {
    assert.ok(/args\.step \|\| args\.commands \|\| args\.pipeline/.test(toolsSrc), "не принимает шаги под другими именами");
    assert.ok(/!Array\.isArray\(steps\)\) steps = \[steps\]/.test(toolsSrc), "объект-шаг не превращается в массив");
    assert.ok(/получено: /.test(toolsSrc), "ошибка формата не говорит, что пришло");
    // Живая проверка нормализатора: строки должны пониматься, а не падать.
    const press = tools.normalizeStep("Enter");
    assert.strictEqual(press && press.kind, "press", "«Enter» не стал клавишей");
    const open = tools.normalizeStep("goto https://vk.com/im");
    assert.strictEqual(open && open.kind, "open", "«goto …» не стал переходом");
    const click = tools.normalizeStep("Написать сообщение");
    assert.strictEqual(click && click.kind, "click", "обычная строка не стала кликом");
    assert.strictEqual(tools.normalizeStep("   "), null, "пустая строка стала шагом");
  });
}

module.exports = {
  testSettingsRedesign,
  testProjectPanel,
  testCommandPalette,
  testSidePanel,
  testSettingsPanel,
  testSettingsSearchLogic,
  testLeftRail,
  testSandboxObstacles,
  testOneNavigation,
};

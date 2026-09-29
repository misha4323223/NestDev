"use strict";
/* ─── Группа «Браузер: инструменты, карта страницы, оболочка и CDP» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 7.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  browserHomeSrc,
  coreData,
  get,
  hasTool,
  mainOnlySrc,
  modelPrompt,
  selected,
  tmpdir,
  toolBody,
  toolBodySelf,
  uiAll,
  uiFile,
} = H;

// ── 4. browser-tools (без браузера) ─────────────────────────────────────────
async function testBrowserTools() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));

  await test("status: корректное сообщение без запущенного браузера", async () => {
    const s = await bt.status();
    assert.ok(typeof s === "string" && s.includes("Браузер не запущен"), "странный статус: " + s.slice(0, 60));
  });

  await test("close(all): безопасен без браузера", async () => {
    const r = await bt.close({ tabId: "all" });
    assert.ok(typeof r === "string" && r.includes("закрыты"), r);
  });

  // ── Постоянный профиль: сессии сайтов переживают перезапуск приложения ──
  // playwright подменяем заглушкой — реальный браузер в тестах не запускаем.
  const Module_ = require("module");
  const origRequire = Module_.prototype.require;
  const persistentDirs = [];
  const mkPage = (u) => ({
    _u: u || "about:blank",
    url() { return this._u; },
    async title() { return "t"; },
    async goto(x) { this._u = x; },
    on() {},
    async close() {},
    async fill() {},
    async click() {},
  });
  const fakePw = {
    chromium: {
      executablePath() { return ""; },
      async launch() {
        return { isConnected: () => true, on() {}, async newPage() { return mkPage(""); }, async close() {} };
      },
      async launchPersistentContext(dir, opts) {
        persistentDirs.push({ dir, opts });
        const pages = [mkPage("about:blank")];
        return { pages: () => pages, on() {}, async newPage() { return mkPage(""); }, async close() {} };
      },
    },
  };
  Module_.prototype.require = function (id) {
    if (id === "playwright") return fakePw;
    return origRequire.apply(this, arguments);
  };
  try {
    const dir = path.join(tmpdir("agent-profile-"), "profile");
    bt.setProfileDir(dir);
    await test("browser-tools: профиль включён → launchPersistentContext + папка на диске", async () => {
      const r = await bt.open({ url: "https://vk.com/im" });
      assert.ok(/постоянный профиль/.test(r), "движок: " + r.slice(0, 90));
      assert.strictEqual(persistentDirs.length, 1, "вызовов persistent: " + persistentDirs.length);
      assert.ok(fs.existsSync(dir), "папка профиля не создана");
    });
    await test("browser-tools: следы автоматизации скрыты (без обхода защит сайтов)", () => {
      const opts = persistentDirs[0] && persistentDirs[0].opts;
      assert.ok(opts, "не нашёл опции запуска браузера");
      assert.ok(
        (opts.ignoreDefaultArgs || []).includes("--enable-automation"),
        "не отключён флаг --enable-automation: " + JSON.stringify(opts.ignoreDefaultArgs)
      );
      assert.ok(
        (opts.args || []).includes("--disable-blink-features=AutomationControlled"),
        "нет флага AutomationControlled: " + JSON.stringify(opts.args)
      );
      assert.ok(opts.headless === false, "браузер должен быть видимым (headless=false)");
    });

    await test("browser-tools: status сообщает, что профиль постоянный", async () => {
      assert.ok(/Профиль: постоянный/.test(await bt.status()));
    });
    await test("browser-tools: очистка профиля удаляет папку", async () => {
      const m = await bt.clearProfile();
      assert.ok(/^OK/.test(m), m);
      assert.ok(!fs.existsSync(dir), "папка профиля осталась");
    });
    await test("browser-tools: профиль выключен → обычный запуск и честное сообщение", async () => {
      bt.setProfileDir("");
      assert.ok(/выключен/.test(await bt.clearProfile()));
      const r = await bt.open({ url: "https://example.com" });
      assert.ok(!/постоянный профиль/.test(r), "движок: " + r.slice(0, 90));
      assert.ok(/Профиль: временный/.test(await bt.status()));
    });
  } finally {
    Module_.prototype.require = origRequire;
    bt.setProfileDir("");
    await bt.stop().catch(() => {});
  }
}

// ── 4c. Браузерная карта страницы (browserSnapshot) и умные действия ────────
// Главное обещание: агент НЕ перебирает селекторы, а берёт ref из карты;
// при промахе инструмент сам возвращает похожие элементы с их ref.
async function testBrowserBrain() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const dom = require(path.join(ROOT, "src", "dom-map.js"));
  const Module_ = require("module");

  const EL = (spec) =>
    Object.assign(
      {
        key: "", tag: "button", type: "", id: "", cls: "", role: "button", name: "",
        label: "", placeholder: "", text: "", href: "", contenteditable: false,
        visible: true, disabled: false, checked: false, options: [], ref: "",
      },
      spec
    );
  const contains = (hay, needle) =>
    String(hay || "").toLowerCase().indexOf(String(needle || "").toLowerCase()) >= 0;
  const matchSelector = (sel, e) => {
    const ref = String(sel).match(/^\[data-agent-ref="([^"]+)"\]$/);
    if (ref) return e.ref === ref[1];
    const s = String(sel).trim();
    const tag = s.match(/^[a-zA-Z][\w-]*/);
    const id = s.match(/#([\w-]+)/);
    const cls = s.match(/\.([\w-]+)/);
    if (!tag && !id && !cls) return false;
    if (tag && e.tag !== tag[0].toLowerCase()) return false;
    if (id && e.id !== id[1]) return false;
    if (cls && String(e.cls).split(/\s+/).indexOf(cls[1]) < 0) return false;
    return true;
  };
  const fakePage = (elements) => {
    const page = {
      els: elements, clicked: [], filled: [], selected: [], typed: [],
      _u: "about:blank",
      keyboard: { press: async () => {}, insertText: async (t) => page.typed.push(t) },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Тестовая страница"; },
      on() {},
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
      _list: list,
      first() { return loc(list.slice(0, 1)); },
      async count() { return list.length; },
      async isVisible() { return !!(list[0] && list[0].visible); },
      async scrollIntoViewIfNeeded() {},
      async click() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
        page.clicked.push(e.key);
      },
      async fill(t) {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (e.contenteditable) throw new Error("Element is not an <input>, <textarea> or [contenteditable]");
        page.filled.push({ key: e.key, text: t });
      },
      async selectOption(v) {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!(e.options || []).some((o) => o.value === v)) throw new Error("did not find option");
        page.selected.push({ key: e.key, value: v });
      },
      async evaluate(fn) {
        const e = list[0];
        if (!e) throw new Error("no element");
        return fn({ options: e.options || [] });
      },
    });
    page.locator = (sel) => loc(by((e) => matchSelector(sel, e)));
    page.getByRole = (role, opts) => loc(by((e) => e.role === role && (!opts || !opts.name || contains(e.name, opts.name))));
    page.getByLabel = (t) => loc(by((e) => contains(e.label || e.ariaLabel, t)));
    page.getByPlaceholder = (t) => loc(by((e) => contains(e.placeholder, t)));
    page.getByText = (t) => loc(by((e) => contains(e.text || e.name, t)));
    // Настоящий сборщик карты пропускает невидимое — подставной ведёт себя так же.
    page.evaluate = async () => ({
      url: "https://vk.com/im",
      title: "ВК",
      items: elements.filter((e) => e.visible).map((e) => ({
        ref: e.ref,
        tag: e.tag,
        type: e.type,
        roleAttr: e.roleAttr || "",
        contenteditable: !!e.contenteditable,
        text: e.text || e.name || "",
        value: e.value || "",
        ariaLabel: e.ariaLabel || "",
        labelText: e.label,
        placeholder: e.placeholder,
        id: e.id,
        cls: e.cls,
        href: e.href,
        inViewport: e.visible,
        disabled: !!e.disabled,
        checked: !!e.checked,
      })),
    });
    return page;
  };

  const els = [
    EL({ key: "home", tag: "a", role: "link", name: "Главная", href: "/" }),
    EL({ key: "login", tag: "button", role: "button", name: "Войти", id: "login", cls: "btn primary" }),
    EL({ key: "search", tag: "input", type: "search", role: "searchbox", name: "Поиск", ariaLabel: "Поиск", placeholder: "Найти", id: "q" }),
    EL({ key: "msg", tag: "div", role: "textbox", roleAttr: "textbox", name: "Написать сообщение", contenteditable: true }),
    EL({ key: "city", tag: "select", role: "combobox", label: "Город", id: "city", options: [{ value: "msk", text: "Москва" }, { value: "tula", text: "Тула" }] }),
    EL({ key: "captcha", tag: "input", type: "checkbox", role: "checkbox", name: "Я не робот", visible: false }),
  ];
  els.forEach((e, i) => { e.ref = "e" + (i + 1); });
  const page = fakePage(els);

  const origRequire = Module_.prototype.require;
  // Важно: browser-tools кэширует playwright между тестами — сбрасываем кэш,
  // иначе вместо нашего подставного движка остался бы движок предыдущего теста.
  bt.setPlaywright(null);
  Module_.prototype.require = function (id) {
    if (id === "playwright") {
      return {
        chromium: {
          executablePath: () => "",
          async launch() {
            return { isConnected: () => true, on() {}, async newPage() { return page; }, async close() {} };
          },
        },
      };
    }
    return origRequire.apply(this, arguments);
  };
  try {
    await bt.open({ url: "https://vk.com/im" });

    await test("browserSnapshot: карта с ref, ролями и именами", async () => {
      const s = await bt.snapshot({});
      assert.ok(/Карта страницы: «ВК»/.test(s), s.slice(0, 160));
      assert.ok(/e2\s+button\s+«Войти»/.test(s), "нет кнопки:\n" + s);
      assert.ok(/e3\s+searchbox\s+«Поиск»/.test(s), "нет поля поиска:\n" + s);
      assert.ok(/e4\s+textbox\s+«Написать сообщение»/.test(s), "нет contenteditable:\n" + s);
      assert.ok(/browserClick \{ ref: "e2" \}/.test(s), "нет подсказки по ref:\n" + s);
      assert.ok(!/Я не робот/.test(s), "невидимый элемент попал в карту:\n" + s);
    });

    await test("browserSnapshot: filter сужает список", async () => {
      const s = await bt.snapshot({ filter: "войти" });
      assert.ok(/по фильтру «войти» — 1/.test(s), s.slice(0, 200));
      assert.ok(!/«Главная»/.test(s), "фильтр не отсеял лишнее:\n" + s);
    });

    await test("browserClick: по имени — берёт саму кнопку, без селектора", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ name: "Войти" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"], "клики: " + JSON.stringify(page.clicked));
    });

    await test("browserClick: по ref из карты и по номеру вместо ref", async () => {
      page.clicked.length = 0;
      await bt.click({ ref: "e4" });
      await bt.click({ ref: 1 });
      assert.deepStrictEqual(page.clicked, ["msg", "home"], "клики: " + JSON.stringify(page.clicked));
    });

    await test("browserClick: имя в кавычках («Войти») не мешает поиску", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ name: "«Войти»" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"]);
    });

    await test("browserClick: несовпавшая роль не ломает поиск по имени", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ role: "clickable", name: "Войти" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"], "роль не совпала — должен сработать поиск по имени");
    });

    await test("browserClick: промах по имени возвращает похожие элементы с ref", async () => {
      const r = await bt.click({ name: "Войти в аккаунт" });
      assert.ok(/Ошибка browserClick/.test(r), r.slice(0, 160));
      assert.ok(/Не нашёл «Войти в аккаунт»/.test(r), "кривой заголовок:\n" + r);
      assert.ok(/Похожие элементы/.test(r), "нет подсказок:\n" + r);
      assert.ok(/browserClick \{ ref: "e2" \}/.test(r), "нет готового действия:\n" + r);
    });

    await test("browserClick: безнадёжный селектор — отдаёт карту страницы", async () => {
      const r = await bt.click({ selector: "#nope" });
      assert.ok(/Ошибка browserClick/.test(r), r.slice(0, 160));
      assert.ok(/«Войти»/.test(r), "нет карты страницы:\n" + r);
    });

    await test("browserFill: поле по подписи (label / aria-label) и по ref", async () => {
      const r = await bt.fill({ label: "Поиск", text: "велосипед" });
      assert.ok(/^OK — поле «подпись «Поиск»»/.test(r), r);
      assert.deepStrictEqual(page.filled, [{ key: "search", text: "велосипед" }]);
    });

    await test("browserFill: contenteditable через insertText (ВК)", async () => {
      const r = await bt.fill({ ref: "e4", text: "привет" });
      assert.ok(/способ: insertText/.test(r), r);
      assert.deepStrictEqual(page.typed, ["привет"]);
    });

    await test("browserFill: промах показывает похожие поля (textbox)", async () => {
      const r = await bt.fill({ selector: "textarea.nope", text: "x" });
      assert.ok(/Ошибка browserFill/.test(r), r.slice(0, 120));
      assert.ok(/textbox/.test(r), "нет похожих полей:\n" + r);
    });

    await test("browserSelect: неверный вариант — показываем реальные значения списка", async () => {
      const r = await bt.select({ label: "Город", value: "Сочи" });
      assert.ok(/не выбрался вариант «Сочи»/.test(r), r);
      assert.ok(/msk \(«Москва»\)/.test(r) && /tula \(«Тула»\)/.test(r), "нет вариантов:\n" + r);
      const ok = await bt.select({ label: "Город", value: "tula" });
      assert.ok(/^OK — в «подпись «Город»» выбрано: tula/.test(ok), ok);
    });

    await test("browserWait: ждём словами — и находим, и объясняем промах", async () => {
      const ok = await bt.wait({ name: "Войти", timeout: 1000 });
      assert.ok(/^OK — элемент «role=button name="Войти"» появился/.test(ok), ok);
      const no = await bt.wait({ name: "Капча", timeout: 400 });
      assert.ok(/Ошибка browserWait/.test(no), no.slice(0, 160));
      assert.ok(/Не нашёл «Капча»/.test(no) && /browserSnapshot/.test(no), no);
    });

    await test("браузерные инструменты: без аргументов — понятная подсказка", async () => {
      assert.ok(/укажи, по чему кликать/.test(await bt.click({})));
      assert.ok(/укажи поле/.test(await bt.fill({ text: "x" })));
      assert.ok(/укажи список/.test(await bt.select({ value: "x" })));
      assert.ok(/укажи selector, ref или name\/text/.test(await bt.wait({})));
    });
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  // ── Настоящий сборщик карты на мини-DOM: ref стабильны, пароли не утекают ──
  await test("browserSnapshot: сборщик карты не отдаёт значения полей (пароли) и скрытое", () => {
    const mk = (tag, attrs, extra) => {
      const store = Object.assign({}, attrs);
      return Object.assign(
        {
          tagName: tag.toUpperCase(),
          className: attrs.class || "",
          innerText: attrs.__text || "",
          textContent: attrs.__text || "",
          isContentEditable: !!attrs.__ce,
          onclick: null,
          disabled: false,
          checked: false,
          labels: [],
          closest: () => null,
          getAttribute: (n) => (n in store ? store[n] : null),
          setAttribute: (n, v) => { store[n] = v; },
          getBoundingClientRect: () =>
            (extra && extra.rect) || { top: 10, left: 10, bottom: 40, right: 200, width: 190, height: 30 },
        },
        extra || {}
      );
    };
    const nodes = [
      mk("button", { __text: "Войти" }),
      mk("input", { type: "password", name: "pass", "aria-label": "Пароль", value: "СЕКРЕТ" }),
      mk("input", { type: "hidden", name: "token", value: "СЕКРЕТ2" }),
      mk("div", { __ce: true, role: "textbox" }),
      mk("button", { __text: "Невидимая" }, { getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) }),
      mk("div", { role: "presentation", __text: "мусор" }),
      mk("span", { tabindex: "0", __text: "без роли, но кликабельный" }),
    ];
    global.window = {
      __aiAgentRefSeq: 0,
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" }),
    };
    global.document = { title: "T", querySelectorAll: () => nodes, getElementById: () => null };
    global.location = { href: "https://x.ru/" };
    try {
      const raw = bt.collectInPage();
      assert.deepStrictEqual(
        raw.items.map((i) => i.ref),
        ["e1", "e2", "e3", "e4", "e5"],
        "refs: " + JSON.stringify(raw.items.map((i) => i.ref))
      );
      assert.strictEqual(raw.items.filter((i) => i.type === "hidden").length, 0, "hidden-поле в карте");
      const pass = raw.items.find((i) => i.type === "password");
      assert.strictEqual(pass.value, "", "пароль попал в карту!");
      assert.strictEqual(dom.accessibleName(pass), "Пароль");
      assert.strictEqual(dom.isInteractive({ tag: "div", roleAttr: "presentation", text: "x" }), false);
      assert.strictEqual(
        dom.accessibleName({ tag: "input", type: "submit", value: "Войти" }),
        "Войти",
        "подпись кнопки-<input> берётся из value"
      );
      assert.strictEqual(dom.refName("#e12"), "e12");
      assert.strictEqual(dom.refName("div.x"), "");
      const again = bt.collectInPage();
      assert.deepStrictEqual(again.items.map((i) => i.ref), raw.items.map((i) => i.ref), "ref не должны меняться");
    } finally {
      delete global.window;
      delete global.document;
      delete global.location;
    }
  });
}

// ── 5. Оболочка (shell), коды ошибок, установщики и свой Chrome по CDP ─────
async function testShellAndCdp() {
  const http = require("http");
  const mainFull = backendSrc();
  const core2 = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const pre2 = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const html2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const app2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  // ── Оболочки: берём ЖИВОЙ модуль (src/shell-tools.js, часть 23) ──────────
  // Раньше здесь был срез текста main.js и new Function по нему. После выноса
  // такой срез проверял бы код, которого в main.js уже нет, и «зеленел» впустую:
  // настоящий модуль никто бы не тронул.
  const shellSrc = fs.readFileSync(path.join(ROOT, "src", "shell-tools.js"), "utf8");
  const mkHelpers = (findProgram, fsImpl) =>
    require(path.join(ROOT, "src", "shell-tools.js")).createShellTools({
      fs: fsImpl || fs,
      path,
      execFile: require("child_process").execFile,
      commandEnv: () => ({}),
      findProgram,
      truncateText: require(path.join(ROOT, "src", "renderer", "agent-core.js")).truncateText,
    });
  const H = mkHelpers((name) => ({ found: true, path: "/usr/bin/" + name }));

  await test("shell: код оболочек живёт в модуле, а не в main.js", () => {
    const shellOnly = mainOnlySrc();
    for (const gone of ["function resolveShell", "function shellsStatus", "function shellsBrief",
      "function shellArgsFor", "function findGitShell", "function runTerminalCommand",
      "const SHELL_KINDS = {", "const PS_PRELUDE =", "function stripAnsi"]) {
      assert.ok(shellOnly.indexOf(gone) === -1, "код оболочек остался в main.js: " + gone);
    }
    assert.ok(/createShellTools\(\{/.test(shellOnly), "оболочки не собираются из модуля");
    assert.ok(/require\("\.\/shell-tools\.js"\)/.test(shellOnly), "нет подключения модуля оболочек");
    assert.ok(/findProgram: \(name\) => findProgram\(name\)/.test(shellOnly),
      "системный раздел собирается ниже — без отложенной стрелки оболочки упали бы на сборке");
    // Запуск команды живёт там, где стоит сама сборка вывода: с части 36 сбор вывода
    // переехал в src/bg-processes.js, а в main.js остался только импорт. Проверяем
    // СМЫСЛ — любой запуск команды берёт аргументы у хелпера кодировки, — иначе
    // пропажа вызова не была бы замечена ничем.
    const bgSrc = fs.readFileSync(path.join(ROOT, "src", "bg-processes.js"), "utf8");
    assert.ok(/shellArgsFor\(command\)/.test(shellOnly) || /shellArgsFor\(command\)/.test(bgSrc),
      "оболочка запускается без хелпера кодировки (ни в main.js, ни в bg-processes.js)");
  });

  await test("shell: псевдонимы оболочек и команда PowerShell без искажений", () => {
    assert.strictEqual(H.normalizeShell("PS"), "powershell");
    assert.strictEqual(H.normalizeShell("pwsh"), "pwsh");
    assert.strictEqual(H.normalizeShell("git-bash"), "bash");
    assert.strictEqual(H.normalizeShell("КОМАНДНАЯ СТРОКА"), "cmd");
    assert.strictEqual(H.normalizeShell("calc.exe"), "", "мусор не должен становиться оболочкой");
    const ps = H.powershellArgs('Get-Process | Where-Object { $_.Name -eq "node" }');
    assert.ok(ps.includes("-EncodedCommand"), "нет -EncodedCommand");
    assert.ok(ps.includes("-NoProfile"), "нет тихих ключей");
    const decoded = Buffer.from(ps[ps.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    assert.ok(/UTF8/.test(decoded), "нет UTF-8 на выходе PowerShell");
    assert.ok(decoded.includes('$_.Name -eq "node"'), "команда искажена: " + decoded);
    assert.deepStrictEqual(H.resolveShell("echo $HOME", "bash").args, ["-lc", "echo $HOME"]);
    assert.strictEqual(H.resolveShell("echo hi", "").kind, process.platform === "win32" ? "cmd" : "sh");
  });

  await test("shell: нет оболочки — подсказка, а не безликий «код 1»", () => {
    const noPs = mkHelpers(() => ({ found: false, reason: "нет" }));
    assert.ok(/installSystemPackage/.test(noPs.resolveShell("x", "powershell").shellHint), "нет подсказки про установку PowerShell");
    assert.ok(/shell: "cmd"/.test(noPs.resolveShell("x", "powershell").shellHint), "нет альтернативы cmd");
    const cmdCode = shellSrc;
    assert.ok(/sh\.shellHint/.test(cmdCode), "подсказка оболочки не попадает в ответ");
    assert.ok(/const sh = resolveShell\(command, shellName\)/.test(cmdCode), "runTerminalCommand не использует выбор оболочки");
    const rc = toolBody(mainFull, "runCommand", "startBackground");
    assert.ok(/normalizeShell\(shellRaw\)/.test(rc), "runCommand не проверяет оболочку");
    assert.ok(/runTerminalCommand\(cmd, cwd, timeoutMs, shellName\)/.test(rc), "runCommand не передаёт оболочку");
    const bg = toolBody(mainFull, "startBackground", "listBackground");
    assert.ok(/shellArgs: bgShell\.args/.test(bg), "startBackground не передаёт оболочку");
    assert.ok(mainFull.includes('shell: { type: "string", description: "Оболочка: cmd') === false, "описание в main.js не нужно");
    assert.ok(/shell: "powershell"/.test(core2) || /shell: \\"powershell\\"/.test(core2), "нет описания shell у инструмента runCommand");
  });

  // ── Оболочки: bash/sh через Git for Windows + справочник shellsStatus ────
  await test("shell: sh и bash находят Git-оболочку и объясняют отсутствие", () => {
    const noShells = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    for (const kind of ["bash", "sh"]) {
      const r = noShells.resolveShell("echo hi", kind);
      assert.strictEqual(r.kind, kind);
      assert.ok(r.shellHint.length > 10, "нет подсказки для " + kind + ": «" + r.shellHint + "»");
      assert.ok(r.shellHint.includes(kind), "подсказка не называет оболочку: " + r.shellHint);
      assert.strictEqual(r.shell, kind, "при отсутствии не должно быть молчаливого отката в другую оболочку");
    }
    if (process.platform === "win32") {
      assert.ok(noShells.resolveShell("x", "sh").shellHint.includes("Git for Windows"), "нет совета про Git for Windows для sh");
    }
    // Git-бинарь найден → путь подставляется, подсказки нет, bash идёт с -lc
    const withGit = mkHelpers(
      (n) => (n === "bash" ? { found: true, path: "C:\\Git\\bin\\bash.exe" } : { found: false, reason: "нет" }),
      { existsSync: () => false }
    );
    const rb = withGit.resolveShell("echo $HOME", "bash");
    assert.strictEqual(rb.shell, "C:\\Git\\bin\\bash.exe", "путь Git-оболочки не подставлен: " + rb.shell);
    assert.strictEqual(rb.shellHint, "");
    assert.deepStrictEqual(rb.args, ["-lc", "echo $HOME"]);
    if (process.platform !== "win32") {
      // На Unix sh живёт в /bin/sh — это не ошибка и подсказки быть не должно
      const unixSh = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: (p) => p === "/bin/sh" });
      const rs = unixSh.resolveShell("echo hi", "sh");
      assert.strictEqual(rs.shellHint, "", "на Unix /bin/sh не должен считаться отсутствующим");
      assert.ok(/bin\/sh/.test(rs.shell), "нет пути к sh: " + rs.shell);
    }
    assert.strictEqual(noShells.resolveShell("x", "bash").missing, true, "нет флага missing у bash");
    assert.strictEqual(withGit.resolveShell("echo $HOME", "bash").missing, false, "найденный bash помечен отсутствующим");
    const allOk = mkHelpers(() => ({ found: true, path: "/usr/bin/sh" }), { existsSync: () => true });
    assert.strictEqual(allOk.resolveShell("echo hi", "").missing, false, "оболочка по умолчанию не может быть missing");
  });

  await test("shellsStatus: агент видит доступные оболочки и получает советы по установке", () => {
    const win = process.platform === "win32";
    const all = mkHelpers((n) => ({ found: true, path: "/usr/bin/" + n }), { existsSync: () => true });
    const st = all.shellsStatus();
    const kinds = st.map((s) => s.kind);
    const expected = win ? ["cmd", "powershell", "pwsh", "bash", "sh"] : ["sh", "powershell", "pwsh", "bash"];
    assert.deepStrictEqual(kinds, expected, "состав отчёта: " + kinds.join(","));
    assert.strictEqual(st.filter((s) => s.def).length, 1, "должна быть ровно одна оболочка по умолчанию");
    assert.strictEqual(st[0].def, true, "оболочка по умолчанию идёт первой");
    assert.ok(st.every((s) => s.available), "всё найдено, а отчёт говорит иначе: " + JSON.stringify(st));

    const none = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    const st2 = none.shellsStatus();
    assert.ok(st2.every((s) => !s.available), "ничего не найдено, а отчёт говорит обратное");
    for (const s of st2) assert.ok(s.hint.length > 5, "нет совета для отсутствующей " + s.kind);

    const brief = all.shellsBrief();
    assert.ok(/^по умолчанию /.test(brief), "строка САММАРИ не начинается с «по умолчанию»: " + brief);
    assert.ok(brief.includes("доступно: "), "нет списка доступного: " + brief);
    assert.ok(brief.includes("powershell"), "в САММАРИ нет powershell");
  });

  await test("shellsStatus: инструмент, промпт, ядро инструментов и САММАРИ проекта согласованы", () => {
    assert.ok(/name: "shellsStatus"/.test(core2), "нет описания инструмента");
    assert.ok(/timeoutCommand, shellsStatus, checkInstalledProgram/.test(core2), "нет в списке инструментов промпта");
    assert.ok(/"shellsStatus",/.test(core2), "нет в ядре инструментов (тесный контекст)");
    assert.ok(/shells_status: "shellsStatus"/.test(core2), "нет алиаса");
    assert.ok(/вызови shellsStatus/.test(modelPrompt()), "промпт не велит проверять доступные оболочки");
    assert.ok(hasTool(mainFull, "shellsStatus"), "нет обработчика shellsStatus");
    assert.ok(/parts\.push\("Оболочки: " \+ shellsBrief\(\)\)/.test(mainFull), "нет строки оболочек в САММАРИ проекта");
  });

  await test("startBackground: без оболочки честная ошибка, а не «OK, PID undefined»", () => {
    const bg = toolBody(mainFull, "startBackground", "listBackground");
    assert.ok(/if \(bgShell\.missing\)/.test(bg), "нет предпроверки оболочки");
    assert.ok(/фоновый процесс НЕ запущен/.test(bg), "нет понятного текста отказа");
    assert.ok(bg.indexOf("bgShell.missing") < bg.indexOf("bgSpawn("), "предпроверка должна идти до запуска процесса");
    assert.ok(/shellsStatus/.test(bg), "отказ не подсказывает shellsStatus");
    assert.ok(/sh\.missing === true/.test(shellSrc), "runTerminalCommand игнорирует флаг missing");
    const H = mkHelpers(() => ({ found: false, reason: "нет" }), { existsSync: () => false });
    assert.strictEqual(H.resolveShell("x", "bash").missing, true, "bash без Git не помечен отсутствующим");
    assert.strictEqual(H.resolveShell("x", "sh").missing, true, "sh без Git не помечен отсутствующим");
    const allOk = mkHelpers(() => ({ found: true, path: "/usr/bin/sh" }), { existsSync: () => true });
    assert.strictEqual(allOk.resolveShell("echo hi", "").missing, false, "оболочка по умолчанию не может быть missing");
    const gitOk = mkHelpers(() => ({ found: true, path: "/usr/bin/bash" }), { existsSync: () => true });
    assert.strictEqual(gitOk.resolveShell("x", "bash").missing, false, "найденная оболочка помечена отсутствующей");
    assert.strictEqual(gitOk.resolveShell("x", "powershell").missing, false, "powershell не блокируется по PATH");
  });

  // ── spawnRaw: системные коды ошибок сохраняются ─────────────────────────
  let pendingErr = null;
  // Раздел «Системные программы и окружение» вынесен в src/system-stack.js
  // (1.5.78). Проверка берёт НАСТОЯЩИЙ модуль, а не срез текста main.js: срез
  // проверял бы код, которого в main.js уже нет, и «зеленел» бы впустую.
  const mkSystemStack = (over) =>
    require(path.join(ROOT, "src", "system-stack.js")).createSystemStack({
      fs,
      path,
      os,
      // Раздел сменил execFile на spawn (часть 43): стенд отдаёт фальшивый ПРОЦЕСС
      // с потоками, а pendingErr решает, чем тот закончится — отказом запуска
      // (событие error), кодом выхода (close) или молчанием (тогда ветку таймаута
      // ведёт сам runGroup). Числовой code — это код выхода, строковый (EINVAL,
      // ENOENT) — отказ запуска; «убит» стенд не изображает: -1 по таймауту обязана
      // дать НАСТОЯЩАЯ таймерная ветка, а не подмена. pid у фальшивого процесса нет —
      // killCommandTree без pid ничего не трогает.
      spawn: (file, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => {
          const err = pendingErr;
          if (!err) {
            child.stdout.emit("data", Buffer.from("ok"));
            child.emit("close", 0, null);
          } else if (err.killed) {
            // молчит до таймаута — см. ветку timedOut в runGroup
          } else if (typeof err.code === "number") {
            child.emit("close", err.code, null);
          } else {
            child.emit("error", err);
          }
        }, 0);
        return child;
      },
      winPs: { exec: async () => ({ noSession: true, ok: true, code: 0, out: "", err: "" }) },
      probeEnv: () => ({ ...process.env }),
      stripAnsi: (x) => String(x || ""),
      runTerminalCommand: async () => "",
      live: { get agentEnv() { return {}; }, envFor: () => ({ ...process.env }) },
      ...(over || {}),
    });
  const spawnRaw = mkSystemStack().spawnRaw;

  await test("spawnRaw: EINVAL/EACCES/EPERM и текст ошибки больше не теряются", async () => {
    const cases = [
      [{ code: "EINVAL", message: "spawn EINVAL" }, "EINVAL", /spawn EINVAL/],
      [{ code: "EACCES", message: "spawn EACCES" }, "EACCES", /EACCES/],
      [{ code: "EPERM", message: "operation not permitted" }, "EPERM", /not permitted/],
      [{ code: 2, message: "exit 2" }, 2, /./],
      [{ code: "ENOENT", message: "spawn foo ENOENT" }, 127, /ENOENT/],
      // «убит по таймауту»: стенд молчит, и -1 даёт настоящий таймер runGroup
      // (короткий timeoutMs, чтобы не ждать минуту) — код не подменяется вручную.
      [{ killed: true, message: "killed" }, -1, /./, { timeoutMs: 50 }],
      [{ message: "непонятный сбой" }, 1, /непонятный сбой/],
    ];
    for (const [err, wantCode, wantText, opts] of cases) {
      pendingErr = err;
      const r = await spawnRaw(["x"], opts || {});
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, wantCode, "код для " + JSON.stringify(err) + " → " + r.code + ", ждали " + wantCode);
      assert.ok(wantText.test(r.err), "текст ошибки потерян: «" + r.err + "»");
    }
    pendingErr = null;
    const okRes = await spawnRaw(["x"], {});
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.code, 0);
  });

  // ── installExe: .exe / .msi / .zip ──────────────────────────────────────
  // Поиск установщиков тоже живёт в src/system-stack.js — берём его оттуда.
  const findInstallersIn = mkSystemStack().findInstallersIn;

  await test("installExe: установщик ищется в распакованном архиве (сначала из корня)", () => {
    const dir = tmpdir("inst-test-");
    fs.mkdirSync(path.join(dir, "app", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "x");
    fs.writeFileSync(path.join(dir, "setup.exe"), "x");
    fs.writeFileSync(path.join(dir, "app", "pkg.msi"), "x");
    fs.writeFileSync(path.join(dir, "app", "bin", "tool.exe"), "x");
    const found = findInstallersIn(dir);
    assert.strictEqual(found.length, 3, "найдено не то: " + JSON.stringify(found));
    assert.ok(found[0].endsWith("setup.exe"), "первым должен идти установщик из корня: " + found[0]);
    assert.ok(found.some((f) => f.endsWith("pkg.msi")), ".msi не найден");
    assert.ok(!found.some((f) => f.endsWith(".txt")), "текстовый файл попал в установщики");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("installExe: ветки .msi (msiexec) и .zip на месте, .exe не форсируется", () => {
    const inst = toolBodySelf(mainFull, "installExe");
    assert.ok(inst.includes("msiexec /i"), "нет ветки .msi");
    assert.ok(inst.includes("/passive /norestart"), "нет тихих ключей msiexec по умолчанию");
    assert.ok(inst.includes("downloadAndExtractTo(url, destDir)"), "нет распаковки .zip");
    assert.ok(inst.includes("findInstallersIn("), "нет поиска установщика в архиве");
    assert.ok(inst.includes("downloadFileTo(url, destMsi)") && inst.includes("downloadFileTo(url, dest)"), "загрузка не переиспользует downloadFileTo");
    assert.ok(/path\.extname\(pathOnly\)/.test(inst), "расширение не берётся из URL");
    assert.ok(/\.\(exe\|msi\|zip\|msix\|appx\)[^/]*\/i\.test\(rawBase\)/.test(inst), "имя файла не учитывает расширение");
    assert.ok(core2.includes("msiexec") && core2.includes(".zip (распаковка"), "описание installExe не обновлено");
  });

  // ── installExe: файл проверяется ДО запуска ─────────────────────────────
  // Это НАСТОЯЩИЕ функции из src/system-stack.js, а не срез текста: хэш,
  // подпись, отчёт и решение «запускать или нет» проверяются по факту.
  const instStack = mkSystemStack();

  await test("проверка установщика: хэш файла, «sha256:» и регистр не мешают", async () => {
    const dir = tmpdir("inst-verify-");
    const f = path.join(dir, "setup.exe");
    fs.writeFileSync(f, "payload");
    const want = crypto.createHash("sha256").update("payload").digest("hex");
    const v = await instStack.verifyInstaller(f, want);
    assert.strictEqual(v.ok, true, "проверка не прошла: " + (v.error || ""));
    assert.strictEqual(v.sha256, want, "хэш посчитан не по файлу");
    assert.strictEqual(v.size, 7);
    assert.strictEqual(v.hashOk, true);
    const loud = await instStack.verifyInstaller(f, "SHA256:" + want.toUpperCase());
    assert.strictEqual(loud.hashOk, true, "приставка sha256: и регистр сломали сверку");
    const noWant = await instStack.verifyInstaller(f, "");
    assert.strictEqual(noWant.hashOk, true, "без заданного хэша запуск не должен блокироваться");
    assert.strictEqual(noWant.expected, "");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("проверка установщика: другой хэш — отказ с обоими хэшами, allowUnsigned не помогает", async () => {
    const dir = tmpdir("inst-mismatch-");
    const f = path.join(dir, "setup.exe");
    fs.writeFileSync(f, "payload");
    const other = "0".repeat(64);
    const v = await instStack.verifyInstaller(f, other);
    assert.strictEqual(v.hashOk, false, "подмена хэша не замечена");
    const why = instStack.installerGate(v, {});
    assert.ok(why.includes(other) && why.includes(v.sha256), "в отказе нет обоих хэшей: " + why);
    assert.ok(why.includes("остановлена"), "отказ не говорит словами: " + why);
    assert.strictEqual(instStack.installerGate(v, { allowUnsigned: true }), why, "allowUnsigned не отменяет сверку хэша");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("проверка установщика: файла нет — понятная ошибка, а не исключение", async () => {
    const v = await instStack.verifyInstaller(path.join(os.tmpdir(), "нет-такого-установщика.exe"), "");
    assert.strictEqual(v.ok, false);
    assert.ok(/не найден/i.test(v.error || ""), "ошибка без объяснения: " + v.error);
  });

  await test("подпись: недействительная останавливает запуск, allowUnsigned разрешает", () => {
    const base = { ok: true, size: 2048, sha256: "a".repeat(64), expected: "", hashOk: true };
    const bad = Object.assign({}, base, { sig: { status: "NotSigned", signer: "" } });
    const why = instStack.installerGate(bad, {});
    assert.ok(why.includes("подпись"), "нет объяснения про подпись: " + why);
    assert.ok(why.includes("allowUnsigned"), "нет подсказки, как продолжить: " + why);
    assert.strictEqual(instStack.installerGate(bad, { allowUnsigned: true }), "", "allowUnsigned не разрешил запуск");
    const good = Object.assign({}, base, { sig: { status: "Valid", signer: "CN=Издатель" } });
    assert.strictEqual(instStack.installerGate(good, {}), "", "действительная подпись не должна мешать");
    assert.strictEqual(instStack.installerGate(Object.assign({}, base, { sig: null }), {}), "", "без данных о подписи запуск не блокируется");
    assert.strictEqual(instStack.installerGate(base, {}), "", "решение без поля sig должно быть разрешающим");
  });

  await test("отчёт о файле: размер, хэш и подпись видны до запуска", () => {
    const v = { ok: true, size: 2048, sha256: "b".repeat(64), expected: "", hashOk: true, sig: null };
    const t = instStack.installerFacts("C:\\tmp\\setup.exe", v);
    assert.ok(t.includes(v.sha256), "в отчёте нет хэша");
    assert.ok(t.includes("2 КБ"), "размер подан странно: " + t);
    assert.ok(t.includes("нет данных"), "отсутствие подписи подано как проверка: " + t);
    const signed = instStack.installerFacts("C:\\tmp\\setup.exe", Object.assign({}, v, { sig: { status: "Valid", signer: "CN=Издатель" } }));
    assert.ok(signed.includes("действительна") && signed.includes("CN=Издатель"), "подпись не показана: " + signed);
    const mismatch = instStack.installerFacts("C:\\tmp\\setup.exe", Object.assign({}, v, { expected: "c".repeat(64), hashOk: false }));
    assert.ok(mismatch.includes("НЕ совпал"), "несовпадение хэша не видно в отчёте: " + mismatch);
    const big = instStack.installerFacts("C:\\tmp\\setup.exe", Object.assign({}, v, { size: 12 * 1024 * 1024 }));
    assert.ok(big.includes("12 МБ"), "крупный файл показан странно: " + big);
  });

  await test("подпись читается через Get-AuthenticodeSignature (Windows), без сессии — «нет данных»", async () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    let sawScript = "";
    const stack = mkSystemStack({
      winPs: { exec: async (script) => { sawScript = script; return { ok: true, out: '{"Status":"Valid","Signer":"CN=Test Publisher"}', err: "" }; } },
    });
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const dir = tmpdir("inst-sig-");
      const f = path.join(dir, "setup.exe");
      fs.writeFileSync(f, "payload");
      const v = await stack.verifyInstaller(f, "");
      assert.ok(/Get-AuthenticodeSignature/.test(sawScript), "подпись не запрашивалась: " + sawScript);
      assert.ok(v.sig && v.sig.status === "Valid", "статус подписи не разобран: " + JSON.stringify(v.sig));
      assert.strictEqual(v.sig.signer, "CN=Test Publisher");
      const noSession = mkSystemStack({ winPs: { exec: async () => ({ noSession: true, ok: true, code: 0, out: "", err: "" }) } });
      const v2 = await noSession.verifyInstaller(f, "");
      assert.strictEqual(v2.sig, null, "без живой сессии PowerShell подпись придумана");
      const junk = mkSystemStack({ winPs: { exec: async () => ({ ok: true, out: "не json", err: "" }) } });
      const v3 = await junk.verifyInstaller(f, "");
      assert.ok(v3.sig && v3.sig.status === "Unknown", "неразобранный ответ не помечен как неизвестный: " + JSON.stringify(v3.sig));
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      Object.defineProperty(process, "platform", realPlatform);
    }
  });

  await test("installExe: проверка стоит ДО запуска во всех трёх ветках", () => {
    const inst = toolBodySelf(mainFull, "installExe");
    assert.strictEqual((inst.match(/await verifyInstaller\(/g) || []).length, 3, "проверка хэша стоит не во всех ветках");
    assert.strictEqual((inst.match(/installerGate\(/g) || []).length, 3, "решение о запуске не во всех ветках");
    const pairs = [
      ["архив", inst.indexOf("const stopZip = installerGate"), inst.indexOf("const outZ = await runTerminalCommand(")],
      [".msi", inst.indexOf("const stopMsi = installerGate"), inst.indexOf("const outM = await runTerminalCommand(")],
      [".exe", inst.indexOf("const stopExe = installerGate"), inst.indexOf("const out = await runTerminalCommand(")],
    ];
    for (const row of pairs) {
      assert.ok(row[1] > 0 && row[2] > 0, "не нашёл проверку или запуск: " + row[0]);
      assert.ok(row[1] < row[2], row[0] + ": запуск идёт раньше проверки");
    }
    assert.ok(!/function installerGate|const installerGate/.test(inst), "копия помощников вернулась в инструмент");
    for (const name of ["factsZip", "factsMsi", "factsExe"]) {
      const decl = inst.indexOf("const " + name + " = installerFacts(");
      const use = inst.indexOf(name + " +");
      assert.ok(decl > 0, "нет объявления " + name);
      assert.ok(use > decl, name + " используется раньше объявления (TDZ)");
    }
    assert.ok(/sha256/.test(core2), "описание installExe не знает про sha256");
    assert.ok(/allowUnsigned/.test(core2), "описание installExe не знает про allowUnsigned");
  });

  // ── system-stack: PATH, коды выхода, загрузка файлов ─────────────────────
  await test("system-stack: слитый PATH без дублей, порядок «своё, потом системное»", () => {
    const stack = mkSystemStack();
    const before = process.env.PATH;
    try {
      // Пути без буквы диска и «:»: на Windows разделитель «;», на Unix «:», а
      // «C:\one» сломал бы разбор на Unix (колонка после буквы диска).
      const all = stack.setMergedPath(
        ["/opt/one", "/opt/two"].join(path.delimiter),
        ["/opt/two", "/opt/three"].join(path.delimiter)
      );
      assert.deepStrictEqual(all, ["/opt/one", "/opt/two", "/opt/three"], "дубль пути не убран: " + JSON.stringify(all));
      assert.strictEqual(process.env.PATH, all.join(path.delimiter), "PATH процесса не обновлён");
      assert.deepStrictEqual(stack.setMergedPath("", ""), [], "пустые пути должны давать пустой список");
    } finally {
      process.env.PATH = before;
    }
  });

  await test("system-stack: 127 и 9009 объясняются установкой, 0 — «успех»", () => {
    const stack = mkSystemStack();
    const notFound = stack.explainExit(127, "node -v");
    assert.ok(/НЕ НАЙДЕНА/.test(notFound), "код 127 не объяснён: " + notFound.slice(0, 120));
    assert.ok(/installSystemPackage/.test(notFound) && /refreshEnv/.test(notFound), "нет пути решения для 127");
    assert.ok(/команда не найдена/.test(stack.explainExit(9009, "x")), "нет объяснения 9009");
    assert.ok(/Успех/.test(stack.explainExit(0, "x")), "код 0 должен быть «успех»");
    assert.ok(/права администратора/.test(stack.explainExit(740, "x")), "740 не объяснён");
    assert.ok(/числом/.test(stack.explainExit("x", "")), "нечисловой код должен просить число");
    assert.ok(/Команда: node -v/.test(notFound), "текст команды потерян");
  });

  await test("system-stack: downloadFileTo уважает лимит и HTTP-ошибку", async () => {
    const stack = mkSystemStack();
    const server = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.alloc(3 * 1024 * 1024));
        return;
      }
      if (req.url === "/ok") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("привет");
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + server.address().port;
    const dir = tmpdir("dl-test-");
    try {
      const big = await stack.downloadFileTo(base + "/big", path.join(dir, "big.bin"), 1);
      assert.strictEqual(big.ok, false, "файл больше лимита скачан");
      assert.ok(/слишком большой/.test(big.error), "нет объяснения про размер: " + big.error);
      assert.ok(!fs.existsSync(path.join(dir, "big.bin")), "слишком большой файл всё же записан на диск");
      const bad = await stack.downloadFileTo(base + "/nope", path.join(dir, "nope.bin"), 10);
      assert.strictEqual(bad.ok, false, "404 отдан как успех");
      assert.ok(/HTTP 404/.test(bad.error), "нет кода ошибки: " + bad.error);
      const ok = await stack.downloadFileTo(base + "/ok", path.join(dir, "ok.txt"), 10);
      assert.strictEqual(ok.ok, true, "нормальная загрузка сорвалась: " + ok.error);
      assert.strictEqual(fs.readFileSync(path.join(dir, "ok.txt"), "utf8"), "привет");
      assert.ok(ok.size > 0, "размер не посчитан");
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("system-stack: .tar.gz не путается с .zip (тип application/gzip содержит «zip»)", async () => {
    // Живой прогон сети (часть 40, заход 6a) нашёл это на деле: сервер отдал .tar.gz
    // стандартным типом application/gzip, а инструмент ушёл в ветку unzip и упал —
    // потому что проверял `contentType.includes("zip")`, а «gzip» содержит «zip».
    // Набор этого не видел: он проверял ТЕКСТ инструмента, а не решение.
    const stack = mkSystemStack();
    const kind = stack.archiveKind;
    assert.strictEqual(typeof kind, "function", "решение «zip или tar» не вынесено наружу — проверить нельзя");
    const cases = [
      ["https://x/pkg.tar.gz", "application/gzip", "tar", ".tar.gz с типом gzip"],
      ["https://x/pkg.tgz", "application/gzip", "tar", ".tgz"],
      ["https://x/pkg.tar.gz", "", "tar", "имя решает без типа"],
      ["https://x/pkg.tar.gz", "application/octet-stream", "tar", "чужой тип не мешает имени"],
      ["https://x/pkg.zip", "application/zip", "zip", ".zip"],
      ["https://x/pkg.zip", "application/octet-stream", "zip", ".zip с чужим типом"],
      ["https://x/archive", "application/zip", "zip", "тип без имени"],
      ["https://x/archive", "application/gzip", "tar", "тип gzip без имени"],
      ["https://x/photo.png", "image/png", "", "не архив — распаковывать нельзя"],
      ["https://x/archive", "text/plain", "", "неизвестный тип — лучше отказать"],
    ];
    for (const [url, ct, want, note] of cases) {
      assert.strictEqual(kind(url, ct), want, note + ": " + kind(url, ct));
    }

    // И следствие на деле: настоящий .tar.gz с настоящего сервера обязан распаковаться
    // (без этого проверка решения ничего не стоит). На Windows архив распаковывает
    // Expand-Archive, и там ветка tar своя — проверку ведём на остальных ОС.
    if (process.platform !== "win32") {
      const zlib = require("zlib");
      const mkTar = (name, content) => {
        const buf = Buffer.from(content, "utf8");
        const h = Buffer.alloc(512);
        h.write(name, 0, 100, "utf8");
        h.write("0000644\0", 100, 8);
        h.write("0000000\0", 108, 8);
        h.write("0000000\0", 116, 8);
        h.write(buf.length.toString(8).padStart(11, "0") + "\0", 124, 12);
        h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
        h.write("        ", 148, 8);
        h.write("0", 156, 1);
        h.write("ustar\0", 257, 6);
        h.write("00", 263, 2);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
        const pad = Buffer.alloc((512 - (buf.length % 512)) % 512);
        return Buffer.concat([h, buf, pad]);
      };
      const tarGz = zlib.gzipSync(Buffer.concat([mkTar("progon.txt", "распаковалось\n"), Buffer.alloc(1024)]));
      const server2 = http.createServer((req, res) => {
        if (req.url === "/pkg.tar.gz") { res.writeHead(200, { "Content-Type": "application/gzip" }); res.end(tarGz); return; }
        res.writeHead(404); res.end("no");
      });
      await new Promise((r) => server2.listen(0, "127.0.0.1", r));
      const dir2 = tmpdir("unpack-test-");
      try {
        // Распаковка — НАСТОЯЩАЯ: у mkSystemStack() spawn подменён заглушкой, и
        // первый заход этого теста получил «OK — Файлов: 0» (tar не запускался вовсе).
        const realStack = mkSystemStack({ spawn });
        const res = await realStack.downloadAndExtractTo("http://127.0.0.1:" + server2.address().port + "/pkg.tar.gz", path.join(dir2, "out"));
        assert.ok(/^OK — скачано и распаковано/.test(res), ".tar.gz не распаковался: " + res);
        const f = path.join(dir2, "out", "progon.txt");
        assert.ok(fs.existsSync(f), "файла из архива нет: " + res);
        assert.ok(/распаковалось/.test(fs.readFileSync(f, "utf8")), "содержимое файла из архива не то");
      } finally {
        server2.close();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    }
  });

  await test("system-stack: findProgram не выдумывает путь и разбирает абсолютный", () => {
    const stack = mkSystemStack();
    assert.strictEqual(stack.findProgram("").found, false, "пустое имя считается найденным");
    const abs = stack.findProgram(process.execPath);
    assert.strictEqual(abs.found, true, "абсолютный путь к node не найден");
    const gone = stack.findProgram(path.join(os.tmpdir(), "нет-такого-файла-9f8e.exe"));
    assert.strictEqual(gone.found, false, "несуществующий путь считается найденным");
    assert.ok(/Не найден файл/.test(gone.reason), "нет причины отказа: " + gone.reason);
  });

  await test("system-stack: установленное не ставится повторно и не трогает команды", async () => {
    const calls = [];
    const stack = mkSystemStack({ runTerminalCommand: async (cmd) => { calls.push(cmd); return "не должно вызываться"; } });
    const out = await stack.installSystemPkg("node");
    assert.ok(/уже установлен/.test(out), "установленный node не распознан: " + out.slice(0, 120));
    assert.strictEqual(calls.length, 0, "на установленную программу запущена команда установки");
    const empty = await stack.installSystemPkg("");
    assert.ok(/укажи packageName/.test(empty), "пустое имя не отклонено");
  });

  // ── gitPublish вне GitHub ───────────────────────────────────────────────
  await test("gitPublish: публикация на GitLab/Bitbucket по remoteUrl", () => {
    const gp = toolBody(mainFull, "gitPublish", "gitInit");
    assert.ok(gp.includes("args.remoteUrl"), "нет ветки remoteUrl");
    assert.ok(/remote", "set-url"/.test(gp) || gp.includes('"remote", "set-url"'), "нет обновления существующего remote");
    assert.ok(gp.includes('"remote", "add"'), "нет добавления remote");
    assert.ok(gp.includes('"push", "-u"'), "нет push -u <remote> <branch>");
    assert.ok(/git@bitbucket\.org/.test(core2), "описание gitPublish не объясняет формат адреса");
  });

  // ── Свой Chrome по CDP ──────────────────────────────────────────────────
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  assert.ok(typeof bt.connect === "function" && typeof bt.setConnectMode === "function", "нет API CDP в browser-tools");

  await test("browserConnect: подхват вкладок пользователя, отключение без закрытия его Chrome", async () => {
    const closed = [];
    let killed = 0;
    const mkPage = (url, title) => ({
      url: () => url, title: async () => title, on: () => {}, goto: async () => {},
      waitForLoadState: async () => {}, close: async () => { closed.push(url); },
    });
    const vk = mkPage("https://vk.com/im", "ВКонтакте");
    const mail = mkPage("https://mail.yandex.ru/", "Почта");
    const fresh = mkPage("about:blank", "Новая вкладка");
    const ctx = { pages: () => [vk, mail], newPage: async () => fresh };
    const browserMock = {
      isConnected: () => true,
      contexts: () => [ctx],
      on: () => {},
      close: async () => { killed++; },
      newPage: async () => { throw new Error("в CDP-режиме нельзя создавать вкладки вне контекста пользователя"); },
    };
    const endpoints = [];
    bt.setPlaywright({ chromium: { connectOverCDP: async (ep) => { endpoints.push(ep); return browserMock; } } });
    bt.setProfileDir(path.join(os.tmpdir(), "agent-profile-test"));

    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Browser: "Chrome/140.0.0.0" }));
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
      const cfg = bt.setConnectMode({ enabled: true, port, dataDir: path.join(os.tmpdir(), "cdp-dir") });
      assert.strictEqual(cfg.port, port, "порт не принят");
      assert.strictEqual(bt.setConnectMode({ enabled: true, port: 80, dataDir: "/x" }).port, 9222, "некорректный порт не отброшен");
      bt.setConnectMode({ enabled: true, port, dataDir: path.join(os.tmpdir(), "cdp-dir") });

      const out = await bt.connect({ launch: false });
      assert.ok(/^OK — подключился к твоему Chrome по CDP/.test(out), "нет подтверждения: " + out.slice(0, 140));
      assert.strictEqual(endpoints[0], "http://127.0.0.1:" + port, "подключение не к тому адресу: " + endpoints[0]);
      assert.ok(/vk\.com\/im/.test(out) && /mail\.yandex/.test(out), "вкладки пользователя не подхвачены:\n" + out);

      const st = await bt.status();
      assert.ok(/СВОЙ Chrome по CDP/.test(st), "статус не сообщает режим CDP");
      const tabId = (st.match(/(tab\d+)/) || [])[1];
      assert.ok(tabId, "нет id вкладки в статусе");
      const refused = await bt.close({ tabId });
      assert.ok(/вкладка твоего Chrome/.test(refused), "вкладка пользователя закрыта: " + refused);

      const off = await bt.close({ tabId: "all" });
      assert.ok(/отключился от твоего Chrome/.test(off), "нет отключения: " + off);
      assert.strictEqual(killed, 0, "Chrome пользователя был закрыт!");
      assert.deepStrictEqual(closed, [], "вкладки пользователя закрыты: " + JSON.stringify(closed));
      assert.strictEqual(bt.connectInfo().active, false, "флаг CDP не сброшен");

      await bt.connect({ launch: false });
      const opened = await bt.open({ url: "https://example.com", newTab: true });
      assert.ok(/Вкладка tab\d+ открыта/.test(opened) && /CDP/.test(opened), "новая вкладка не открылась в своём Chrome: " + opened);

      await bt.close({ tabId: "all" });
      bt.setConnectMode({ enabled: true, port: 65500, dataDir: "/x" });
      const fail = await bt.connect({ launch: false });
      assert.ok(/^Ошибка browserConnect/.test(fail), "нет ошибки подключения: " + fail.slice(0, 100));
      assert.ok(/Chrome 136\+/.test(fail) && /user-data-dir/.test(fail), "нет предупреждения про Chrome 136+ и --user-data-dir");
    } finally {
      bt.setConnectMode({ enabled: false, port: 9222, dataDir: "" });
      await bt.stop();
      bt.setPlaywright(null);
      await new Promise((r) => server.close(r));
    }
  });

  await test("browserConnect: инструмент, промпт, каналы и настройки согласованы", () => {
    assert.ok(core2.includes('name: "browserConnect"'), "нет определения инструмента в agent-core");
    const list = core2.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/browserConnect/.test(list), "инструмента нет в списке для модели");
    assert.ok(/browser_connect: "browserConnect"/.test(core2), "нет алиаса browser_connect");
    assert.ok(/начни с browserConnect/.test(modelPrompt()), "промпт не объясняет, когда подключаться к своему Chrome");
    assert.ok(pre2.includes("browserConnect: (opts) =>"), "preload не пробрасывает browserConnect");
    assert.ok(hasTool(mainFull, "browserConnect"), "нет обработчика browserConnect");
    assert.ok(mainFull.includes("function applyBrowserSettings(s)"), "нет единой точки применения браузерных настроек");
    assert.ok(/browserConnect === true/.test(mainFull), "настройка не читается");
    for (const id of ["s-browser-connect", "s-browser-connect-port", "btn-browser-connect", "browser-connect-info"]) {
      assert.ok(html2.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(uiAll().includes('"' + id + '"'), "интерфейс не ссылается на " + id);
    }
    // Сохранение настройки живёт в панели настроек (app.js: window.SettingsPanel).
    assert.ok(uiFile("settings-panel.js").includes('getSettings().browserConnect = !!$("s-browser-connect").checked'), "настройка не сохраняется");
    assert.ok(app2.includes("api.browserConnect({ port })"), "кнопка не вызывает подключение");
  });
}

// ── 1d. Слои поверх страницы: диалоги, force-клик, JS на странице ───────────
// Повод — консоль Google Cloud: чекбокс согласия и «Agree and continue» лежали в
// .cdk-overlay-container, не попадали в карту (диалог дописан в конец <body> и
// отрезался лимитом строк), а клик падал на проверке «элемент под курсором».
// Здесь проверяем поведенчески: карта видит диалог, клик повторяется, JS и HTML
// доступны, помехи закрываются, а юридические согласия сами не подтверждаются.
async function testBrowserOverlays() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const dom = require(path.join(ROOT, "src", "dom-map.js"));
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const mainSrc = backendSrc();
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  // ── Мини-DOM с диалогом поверх страницы ──
  const mkEl = (tag, attrs, opts) => {
    const a = Object.assign({}, attrs || {});
    const o = opts || {};
    return {
      tagName: String(tag).toUpperCase(),
      id: a.id || "",
      className: a.class || "",
      innerText: a.__text || "",
      textContent: a.__text || "",
      isContentEditable: false,
      onclick: null,
      disabled: false,
      checked: !!a.__checked,
      shadowRoot: o.shadowRoot || null,
      labels: [],
      __style: o.style || null,
      getAttribute: (n) => (n in a ? a[n] : null),
      setAttribute: (n, v) => { a[n] = v; },
      getBoundingClientRect: () => o.rect || { top: 120, left: 120, bottom: 150, right: 320, width: 200, height: 30 },
      closest: (sel) => (o.closest ? o.closest(String(sel)) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
    };
  };
  const transparent = { visibility: "visible", display: "block", opacity: "0", pointerEvents: "auto" };
  const visible = { visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" };

  // Диалог: контейнер + внутри прозрачная галочка и кнопка согласия.
  const dialogHost = mkEl(
    "div",
    {
      class: "cdk-overlay-pane",
      "aria-label": "Welcome Misha Pimashin",
      __text:
        "Welcome Misha Pimashin! Create and manage your Google Cloud instances. " +
        "You must accept these terms of service to continue. I agree to the Google Cloud Platform Terms of Service",
    },
    {}
  );
  // closest умеет искать по селектору, как настоящий DOM: панель диалога
  // возвращается только на overlay-селектор, на "label" — null (иначе подпись
  // кнопки подменилась бы текстом всего диалога).
  const OVERLAY_RE = /cdk-overlay|\[role=dialog\]|\[role=alertdialog\]|aria-modal|modal|goog-te|skiptranslate/i;
  const inDialog = (sel) => (OVERLAY_RE.test(String(sel || "")) ? dialogHost : null);
  const checkbox = mkEl("input", { type: "checkbox", "aria-label": "I agree to the Terms of Service" }, { style: transparent, closest: inDialog });
  const agreeBtn = mkEl("button", { __text: "Agree and continue" }, { style: visible, closest: inDialog });
  const pageButtons = [];
  for (let i = 0; i < 70; i++) pageButtons.push(mkEl("button", { __text: "Обычная кнопка " + i }, { style: visible }));
  // Кнопка внутри shadow DOM: обычный querySelectorAll её не видит.
  const shadowInner = mkEl("button", { __text: "Внутри веб-компонента" }, { style: visible });
  const shadowHost = mkEl("my-widget", {}, { shadowRoot: { querySelectorAll: () => [shadowInner] }, style: visible });
  const nodes = pageButtons.concat([shadowHost, checkbox, agreeBtn]);

  global.window = {
    __aiAgentRefSeq: 0,
    innerHeight: 900,
    innerWidth: 1400,
    getComputedStyle: (el) => (el && el.__style) || visible,
  };
  global.document = { title: "Google Cloud", querySelectorAll: () => nodes, getElementById: () => null };
  global.location = { href: "https://console.cloud.google.com/" };
  let map = null;
  try {
    await test("карта: диалог поверх страницы виден, помечен и не режется лимитом", async () => {
      map = await bt.collectMap({ evaluate: (fn) => Promise.resolve(fn()) });
      const dlg = map.items.filter((i) => i.inDialog);
      assert.ok(dlg.length >= 2, "элементы диалога не попали в карту: " + JSON.stringify(map.items.slice(0, 3)));
      assert.strictEqual(map.items[0].inDialog, true, "диалог не первым в карте");
      assert.ok(/Welcome Misha/.test(map.items[0].dialogName), "имя диалога не подхвачено: " + map.items[0].dialogName);
      const box = map.items.find((i) => i.type === "checkbox");
      assert.ok(box, "прозрачный чекбокс согласия не найден");
      assert.strictEqual(box.hiddenInput, true, "чекбокс не помечен как скрытый ввод");
      assert.ok(/terms of service/i.test(box.name || ""), "нет имени чекбокса: " + box.name);
      assert.ok(map.items.some((i) => /Agree and continue/.test(i.name || "")), "кнопки согласия нет в карте");
      // Тень: элемент из shadow-root тоже попал в карту.
      assert.ok(map.items.some((i) => /Внутри веб-компонента/.test(i.name || "")), "shadow DOM не обойдён");
      // Сводка слоёв и классификация.
      assert.ok(map.overlays.length >= 1, "нет сводки слоёв");
      assert.strictEqual(bt.overlayKind(map.overlays[0]), "terms", "диалог согласия распознан неверно");
      // Карта для агента: диалог первым, с предупреждением и подсказками.
      const text = dom.formatSnapshot({ items: map.items, url: map.url, title: map.title, limit: 5, filter: "" });
      assert.ok(/Поверх страницы открыт диалог/.test(text), "нет предупреждения о диалоге поверх страницы");
      assert.ok(/скрытый ввод/.test(text), "нет пометки про скрытый ввод");
      const firstRows = text.split("\n").filter((l) => /\be\d+\b/.test(l));
      assert.ok(/Agree and continue/.test(firstRows.slice(0, 4).join(" ")), "кнопка согласия не в начале списка: " + firstRows.slice(0, 4).join(" | "));
    });

    await test("слои: классификация terms / translate / cookie / dialog", () => {
      const cases = [
        [{ name: "Welcome", cls: "cdk-overlay-pane", text: "You must accept these terms of service to continue" }, "terms"],
        [{ name: "", cls: "goog-te-banner-frame skiptranslate", text: "Перевести страницу? Не сейчас" }, "translate"],
        [{ name: "", cls: "", text: "Мы используем cookie. Принять все" }, "cookie"],
        [{ name: "Оплата", cls: "", text: "Введите данные карты" }, "dialog"],
        [{ name: "", cls: "notice", text: "Понятно, закрыть" }, "noise"],
      ];
      for (const [o, want] of cases) {
        assert.strictEqual(bt.overlayKind(o), want, JSON.stringify(o) + " → " + bt.overlayKind(o));
      }
    });

    await test("помехи: закрываются перевод и «Не сейчас», юридическое — нет", () => {
      const clicked = [];
      const trIframe = mkEl("iframe", { class: "goog-te-banner-frame" }, { style: visible });
      trIframe.style = { display: "" };
      const notNow = mkEl("button", { __text: "Не сейчас" }, { style: visible, closest: () => dialogHost });
      const acceptAll = mkEl("button", { __text: "Принять все" }, { style: visible, closest: () => dialogHost });
      const outsideSafe = mkEl("button", { __text: "Закрыть" }, { style: visible, closest: () => null });
      notNow.click = () => clicked.push("Не сейчас");
      acceptAll.click = () => clicked.push("Принять все");
      outsideSafe.click = () => clicked.push("Закрыть-вне-слоя");
      const all = [trIframe, notNow, acceptAll, outsideSafe];
      global.document = {
        title: "T",
        querySelectorAll: (sel) => (String(sel).indexOf("button") >= 0 || String(sel).indexOf("div") >= 0 ? all : trIframe === null ? [] : [trIframe]),
        getElementById: () => null,
      };
      const report = bt.cleanupInPage();
      assert.ok(clicked.indexOf("Не сейчас") >= 0, "безопасная кнопка слоя не нажата: " + JSON.stringify(clicked));
      assert.strictEqual(clicked.indexOf("Принять все"), -1, "нажата юридическая кнопка «Принять все»!");
      assert.strictEqual(clicked.indexOf("Закрыть-вне-слоя"), -1, "нажата кнопка вне слоя поверх страницы");
      assert.ok(/перевода/.test(report.join(" ")), "окно перевода не скрыто: " + report.join("; "));
      assert.ok(trIframe.style.display === "none", "iframe перевода не скрыт");
    });

    await test("подтверждение согласия: отмечает галочку и жмёт кнопку согласия", () => {
      const acted = [];
      const box = mkEl("input", { type: "checkbox" }, { style: transparent, closest: () => dialogHost });
      box.click = () => acted.push("галочка");
      const agree = mkEl("button", { __text: "Agree and continue" }, { style: visible, closest: () => dialogHost });
      agree.click = () => acted.push("agree");
      const disagree = mkEl("button", { __text: "Не согласен" }, { style: visible, closest: () => dialogHost });
      disagree.click = () => acted.push("disagree");
      const outside = mkEl("button", { __text: "Agree" }, { style: visible, closest: () => null });
      outside.click = () => acted.push("outside");
      const boxes = [box];
      const btns = [disagree, agree, outside];
      global.document = {
        title: "T",
        querySelectorAll: (sel) => (String(sel).indexOf("checkbox") >= 0 ? boxes : btns),
        getElementById: () => null,
      };
      const report = bt.acceptTermsInPage();
      assert.ok(acted.indexOf("галочка") >= 0, "галочка согласия не отмечена: " + JSON.stringify(acted));
      assert.ok(acted.indexOf("agree") >= 0, "кнопка согласия не нажата: " + JSON.stringify(acted));
      assert.strictEqual(acted.indexOf("disagree"), -1, "нажата кнопка «Не согласен»");
      assert.strictEqual(acted.indexOf("outside"), -1, "нажата кнопка вне слоя");
      assert.ok(report.length >= 2, "отчёт пуст: " + JSON.stringify(report));
    });
  } finally {
    delete global.window;
    delete global.document;
    delete global.location;
  }

  // ── Клик: перекрытый элемент всё равно нажимается ──
  const mkClickPage = (mode) => {
    const log = { plain: 0, force: 0, dom: 0, mouse: 0 };
    const locator = {
      first() { return this; },
      async count() { return 1; },
      async isVisible() { return true; },
      async scrollIntoViewIfNeeded() {},
      async click(opts) {
        const force = !!(opts && opts.force);
        if (mode === "plain") { log.plain++; return; }
        if (mode === "force") {
          if (!force) { log.plain++; throw new Error('div.cdk-overlay-backdrop intercepts pointer events'); }
          log.force++;
          return;
        }
        if (mode === "dom") { log.plain++; throw new Error("timeout: element is not stable"); }
        throw new Error("совсем не нажимается");
      },
      async evaluate() {
        if (mode === "mouse") throw new Error("element is not attached to the DOM");
        return "div.cdk-overlay-backdrop «Войти»";
      },
      async boundingBox() { return { x: 100, y: 200, width: 80, height: 20 }; },
    };
    const page = {
      url: () => "https://console.cloud.google.com/",
      async title() { return "Console"; },
      locator: () => locator,
      getByRole: () => locator,
      getByText: () => locator,
      getByLabel: () => locator,
      getByPlaceholder: () => locator,
      on() {},
      async goto() {},
      async waitForTimeout() {},
      keyboard: { async press() {}, async insertText() {} },
      mouse: { async click(x, y) { log.mouse++; log.mouseAt = [x, y]; } },
    };
    return { page, log };
  };
  const Module_ = require("module");
  const origRequire = Module_.prototype.require;
  const useFake = (page) => {
    Module_.prototype.require = function (id) {
      if (id === "playwright") {
        return {
          chromium: {
            executablePath: () => "",
            async launch() {
              return { isConnected: () => true, on() {}, async newPage() { return page; }, async close() {} };
            },
            async launchPersistentContext() {
              return { pages: () => [page], on() {}, async newPage() { return page; }, async close() {} };
            },
          },
        };
      }
      return origRequire.apply(this, arguments);
    };
  };
  try {
    bt.setProfileDir("");
    for (const [mode, expect] of [["plain", /обычный клик/], ["force", /force-клик/], ["dom", /клик из DOM/], ["mouse", /клик мышью/]]) {
      const { page, log } = mkClickPage(mode);
      useFake(page);
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      const open = await bt.open({ url: "https://console.cloud.google.com/" });
      assert.ok(/открыта/.test(open), "вкладка не открылась: " + open.slice(0, 80));
      await test("клик (" + mode + "): перекрытый элемент всё равно нажимается", async () => {
        const r = await bt.click({ ref: "e1" });
        assert.ok(expect.test(r), "способ не сработал: " + r.slice(0, 120));
        if (mode === "force") {
          assert.strictEqual(log.force, 1, "force-клик не вызван");
          assert.ok(/cdk-overlay-backdrop/.test(r), "слой-перекрытие не назван: " + r);
        }
        if (mode === "mouse") assert.ok(log.mouse >= 1, "клик мышью по координатам не сделан");
      });
      await bt.close({ tabId: "all" }).catch(() => {});
    }
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  // ── JS и HTML на странице ──
  const mkEvalPage = (handler) => ({
    url: () => "https://x.ru/",
    async title() { return "T"; },
    locator: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {}, async evaluate() { return ""; } }),
    getByRole: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {} }),
    on() {},
    async goto() {},
    evaluate: handler,
  });
  try {
    const { page, log } = (() => {
      const calls = [];
      return { page: mkEvalPage(async (fn, arg) => { calls.push({ fn, arg }); return "ЗАГОЛОВОК"; }), log: calls };
    })();
    useFake(page);
    bt.setPlaywright(null);
    await bt.stop().catch(() => {});
    await bt.open({ url: "https://x.ru/" });
    await test("browserEval: выражение оборачивается в return, результат отдаётся текстом", async () => {
      const r = await bt.evalJs({ script: "document.title" });
      assert.ok(/ЗАГОЛОВОК/.test(r), "результат не вернулся: " + r);
      const fnSrc = String(log[log.length - 1].fn);
      assert.ok(/const __v = \(document\.title\);/.test(fnSrc), "выражение не обёрнуто: " + fnSrc);
      assert.ok(/return __ser\(__v\);/.test(fnSrc), "результат не проходит сериализатор (DOM-узел потерялся бы): " + fnSrc);
      assert.ok(!/return \(__v\)/.test(fnSrc), "сериализатор обёрнут повторно")
      const code = await bt.evalJs({ script: "const a = 1; return a + 1;" });
      assert.ok(/return a \+ 1;/.test(String(log[log.length - 1].fn)), "код со своим return переписан: " + log[log.length - 1].fn);
      assert.ok(!/return \(const/.test(String(log[log.length - 1].fn)), "код со своим return обёрнут повторно");
      assert.ok(/укажи script/.test(await bt.evalJs({})), "пустой script не объяснён");
    });
    await test("browserDOM: HTML элемента, лимит и «не найдено»", async () => {
      useFake(mkEvalPage(async (fn, arg) => {
        global.document = {
          querySelector: (s) => (s === ".cdk-overlay-pane" ? { outerHTML: "<div class=\"cdk-overlay-pane\">x</div>", innerText: "Диалог", tagName: "DIV" } : null),
          querySelectorAll: () => [{}, {}],
        };
        try {
          return fn(arg);
        } finally {
          delete global.document;
        }
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const r = await bt.domHtml({ selector: ".cdk-overlay-pane", limit: 500 });
      assert.ok(/cdk-overlay-pane/.test(r) && /Диалог/.test(r), "HTML не вернулся: " + r.slice(0, 120));
      assert.ok(/совпадений на странице: 2/.test(r), "нет количества совпадений: " + r.slice(0, 160));
      const miss = await bt.domHtml({ selector: ".нет-такого" });
      assert.ok(/ничего не нашлось/.test(miss), "промах не объяснён: " + miss);
      assert.ok(/укажи selector/.test(await bt.domHtml({})), "пустой аргумент не объяснён");
      // shadow DOM: обычный querySelector не находит, поиск уходит внутрь корня
      useFake(mkEvalPage(async (fn, arg) => {
        const inner = { outerHTML: "<button>В тени</button>", tagName: "BUTTON", innerText: "В тени" };
        const host = { shadowRoot: { querySelector: (s) => (s === ".in-shadow" ? inner : null), querySelectorAll: () => [] } };
        global.document = {
          querySelector: () => null,
          querySelectorAll: (s) => (s === "*" ? [host] : []),
        };
        try {
          return fn(arg);
        } finally {
          delete global.document;
        }
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const shadow = await bt.domHtml({ selector: ".in-shadow" });
      assert.ok(/В тени/.test(shadow), "shadow DOM не обойдён: " + shadow.slice(0, 140));
    });
    await test("browserOverlays: согласие не подтверждается само, помехи — по флагу", async () => {
      const cleanupCalls = [];
      useFake(mkEvalPage(async (fn) => {
        if (String(fn.name).indexOf("cleanup") >= 0) { cleanupCalls.push(1); return ["нажато «не сейчас»"]; }
        if (String(fn.name).indexOf("acceptTerms") >= 0) { cleanupCalls.push(2); return ["отмечена галочка"]; }
        return {
          url: "https://console.cloud.google.com/",
          title: "Console",
          items: [
            { ref: "e1", tag: "input", type: "checkbox", roleAttr: "", text: "", ariaLabel: "I agree to the Terms of Service", checked: false, inDialog: true, dialogName: "Welcome", hiddenInput: true, inViewport: true, cls: "cdk-overlay-pane-input" },
          ],
          overlays: [{ name: "Welcome", text: "You must accept these terms of service to continue", cls: "cdk-overlay-pane", tag: "div" }],
        };
      }));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://console.cloud.google.com/" });
      const plain = await bt.overlays({});
      assert.ok(/юридическое согласие/i.test(plain), "нет предупреждения про юридическое согласие: " + plain.slice(0, 200));
      assert.ok(cleanupCalls.indexOf(1) === -1, "помехи закрыты без флага dismiss");
      assert.ok(cleanupCalls.indexOf(2) === -1 && !/Подтверждение согласия/.test(plain), "согласие подтверждено само!");
      const dismissed = await bt.overlays({ dismiss: true });
      assert.ok(cleanupCalls.indexOf(1) >= 0, "dismiss не вызвал очистку помех");
      assert.ok(/Закрытие помех/.test(dismissed), "нет отчёта о закрытии помех: " + dismissed.slice(0, 200));
      const accepted = await bt.overlays({ acceptTerms: true });
      assert.ok(cleanupCalls.indexOf(2) >= 0, "acceptTerms не сработал");
      assert.ok(/Подтверждение согласия/.test(accepted), "нет отчёта о подтверждении: " + accepted.slice(0, 200));
    });
    await test("карта: помехи и юридическое согласие видны даже без элементов в слое", async () => {
      useFake(mkEvalPage(async () => ({
        url: "https://console.cloud.google.com/",
        title: "Console",
        items: [],
        overlays: [
          { name: "", cls: "goog-te-banner-frame skiptranslate", text: "Перевести страницу? Не сейчас", tag: "iframe" },
          { name: "Welcome", cls: "cdk-overlay-pane", text: "You must accept these terms of service to continue", tag: "div" },
        ],
      })));
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://console.cloud.google.com/" });
      const text = await bt.snapshot({});
      assert.ok(/Поверх страницы помехи: окно перевода Google/.test(text), "нет предупреждения о помехе: " + text.slice(0, 220));
      assert.ok(/browserOverlays \{ dismiss: true \}/.test(text), "нет подсказки убрать помеху");
      assert.ok(/юридического согласия/.test(text), "нет предупреждения о согласии: " + text.slice(0, 260));
      assert.ok(/acceptTerms: true/.test(text), "нет подсказки пройти согласие осознанно");
    });

    await test("browserScreenshot: файл на диске + путь агенту, data URL только по запросу", async () => {
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      const page = mkEvalPage(async () => null);
      page.screenshot = async () => png;
      useFake(page);
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://x.ru/" });
      const dir = path.join(tmpdir("agent-shots-"), "shots");
      const r = await bt.screenshot({ dir });
      assert.ok(/скриншот сохранён/.test(r), "нет подтверждения сохранения: " + r.slice(0, 120));
      // По умолчанию — JPEG (компактнее для vision-модели), PNG остаётся по флагу png:true.
      const m = r.match(/сохранён в файл: (.+\.(?:jpg|png))/);
      assert.ok(m && fs.existsSync(m[1]), "файла нет на диске: " + r.slice(0, 160));
      assert.ok(/\.jpg$/.test(m[1]), "по умолчанию ожидался .jpg: " + m[1]);
      assert.ok(fs.readFileSync(m[1]).equals(png), "содержимое файла не совпало");
      assert.ok(/analyzeImage/.test(r), "нет подсказки про разбор");
      const data = await bt.screenshot({ dir, dataUrl: true });
      assert.ok(/^data:image\/jpeg;base64,/.test(data), "data URL не вернулся (ожидался jpeg): " + data.slice(0, 40));
      // Флаг png: true возвращает PNG-файл и PNG data URL (точное чтение мелкого текста).
      const rp = await bt.screenshot({ dir, png: true });
      const mp = rp.match(/сохранён в файл: (.+\.png)/);
      assert.ok(mp && fs.existsSync(mp[1]), "png: true не дал .png файл: " + rp.slice(0, 160));
      const dp = await bt.screenshot({ dir, png: true, dataUrl: true });
      assert.ok(/^data:image\/png;base64,/.test(dp), "png: true не вернул png data URL");
    });
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  await test("слои поверх страницы: инструменты, промпт и main.js согласованы", () => {
    for (const t of ["browserEval", "browserDOM", "browserOverlays"]) {
      assert.ok(hasTool(mainSrc, t), "нет обработчика " + t);
      assert.ok(coreSrc.indexOf('name: "' + t + '"') !== -1, "нет определения " + t + " в ядре");
      assert.ok(AgentCore.SYSTEM_PROMPT.indexOf(t) !== -1, t + " нет в списке доступных инструментов");
    }
    assert.ok(/browserOverlays \{ dismiss: true \}/.test(modelPrompt()), "промпт не учит закрывать помехи");
    assert.ok(/terms of service\) молча не подтверждай/.test(modelPrompt()), "промпт не запрещает молчаливое согласие");
    assert.ok(/screenshotFile\(Object\.assign\(\{\}, args, \{ dir: shotDir \}\)\)/.test(mainSrc), "скриншот не сохраняется файлом");
    assert.ok(/Vision-модель не ответила/.test(mainSrc), "нет честного сообщения, когда зрение не ответило");
    assert.ok(/activeEmit\(\{ type: "image", path: shot\.path/.test(mainSrc), "скриншот не показывается пользователю");
    for (const a of ["browser_eval", "run_js", "browser_dom", "browser_overlays", "overlays", "dismiss_overlays"]) {
      assert.ok(AgentCore.normalizeToolName(a).indexOf("browser") === 0, "алиас " + a + " не ведёт к браузерному инструменту");
    }
    // Карта не должна терять диалог: сортировка в collectMap + защита в formatSnapshot.
    // Карта живёт в browser-map.js (часть 39), ядро только реэкспортирует её имена.
    const btSrc = browserHomeSrc();
    assert.ok(/items\.sort\(\(a, b\) => \(b\.inDialog \? 1 : 0\)/.test(btSrc), "collectMap не поднимает диалог наверх");
    const domSrc = fs.readFileSync(path.join(ROOT, "src", "dom-map.js"), "utf8");
    assert.ok(/const dialogItems = shown\.filter\(\(it\) => it\.inDialog\);/.test(domSrc), "formatSnapshot не защищает диалог от обрезки");
    assert.strictEqual(/app\.js/.test("app.js"), true);
    assert.ok(appSrc.length > 0, "app.js не прочитан");
  });
}

// ── Ускорение агента: батчинг, скриншоты JPEG, порог компакции ──────────────
async function testBrowserReplayData() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const os = require("os");
  const toolsSrc = backendSrc();
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const policySrc = fs.readFileSync(path.join(ROOT, "src", "tool-policy.js"), "utf8");
  const vkGuide = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "vk.md"), "utf8");
  const browserGuide = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "browser.md"), "utf8");
  const dir = path.join(os.tmpdir(), "ai-agent-replay-test");

  // Формы и пути: пересборка тела НЕ должна портить нетронутые поля.
  await test("replay: тело формы пересобирается байт в байт, пока поле не меняли", () => {
    const body = "v=5.285&q=hello+world&access_token=vk1.a%2Bb&start_from=conversations_0";
    const pairs = bt.parseForm(body);
    assert.strictEqual(pairs.length, 4, "поля разобраны не все: " + JSON.stringify(pairs));
    assert.strictEqual(bt.buildForm(pairs), body, "нетронутое тело пересобрано иначе");
    assert.strictEqual(bt.pickPath({ a: 1 }, "a.b"), undefined, "отсутствующий путь не распознан");
    assert.strictEqual(bt.pickPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c"), 7, "путь с индексом сломан");
    // Меняем одно поле — исходный кусок больше не используется.
    const edited = bt.parseForm("start_from=conversations_0&q=hello+world");
    edited[0][1] = "conversations_222";
    edited[0].length = 2;
    assert.strictEqual(bt.buildForm(edited), "start_from=conversations_222&q=hello+world", "правка поля пересобрана неверно");
  });

  await test("replay: секреты прячутся, а маршруты ответа находятся сами", () => {
    const masked = bt.maskForm("v=5.285&access_token=vk1.SECRET&client_id=6287487");
    assert.ok(masked.indexOf("vk1.SECRET") < 0, "токен остался в тексте: " + masked);
    assert.ok(/access_token=«скрыто/.test(masked), masked);
    assert.ok(/v=5\.285/.test(masked) && /client_id=6287487/.test(masked), "не секретные поля тоже скрыты: " + masked);
    // Ответ в форме ВК: элементы, количество и курсор находятся без подсказок.
    const vk = { response: { count: 42, conversations: { count: 42, items: [{ conversation: { peer: { id: 5 } } }] }, last_item: 999 } };
    assert.strictEqual(bt.findItemsPath(vk), "response.conversations.items", "не нашёл массив диалогов");
    assert.strictEqual(bt.findTotalPath(vk), "response.count", "не нашёл total_count");
    assert.strictEqual(bt.findCursorPath(vk), "response.last_item", "не нашёл курсор");
    assert.strictEqual(bt.keyOfItem(vk.response.conversations.items[0], ""), "5", "ключ строки не выведен из peer.id");
    assert.strictEqual(bt.keyOfItem({ peer_id: 77 }, ""), "77", "peer_id не стал ключом");
    // Незнакомый API: массив ищется сам.
    const other = { payload: { rows: [{ id: 1 }, { id: 2 }] } };
    assert.strictEqual(bt.findItemsPath(other), "payload.rows", "незнакомый ответ не разобран");
    assert.strictEqual(bt.findCursorParam([["target_count", "20"], ["offset", "40"]]), "offset", "курсор в теле не найден");
  });

  // Ленивый список диалогов: 3 страницы курсором, повтор строки не дублируется.
  const ITEM = (id) => ({ conversation: { peer: { id: id } }, last_message: { text: "msg-" + id } });
  const VK_BODY = "v=5.285&client_id=6287487&start_from=conversations_0&filter=all&target_count=20&extended=1&access_token=vk1.SECRET&fields=bdate&q=hello+world";

  function fakePage() {
    const page = {
      handlers: {},
      _u: "https://vk.com/im",
      viewportSize: () => ({ width: 1000, height: 800 }),
      mouse: { async move() {}, async wheel() {} },
      server: null,
      on(type, fn) { (page.handlers[type] = page.handlers[type] || []).push(fn); },
      off(type, fn) {
        const l = page.handlers[type] || [];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      },
      emit(type) {
        const args = Array.prototype.slice.call(arguments, 1);
        for (const fn of (page.handlers[type] || []).slice()) fn.apply(null, args);
      },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "ВКонтакте"; },
      async close() {},
    };
    page.evaluate = async (fn, arg) => {
      if (fn === bt.fetchJsonInPage) return page.server ? page.server(arg) : { error: "нет сервера" };
      if (fn === bt.itemsKeyInPage) return bt.itemsKeyInPage(arg);
      if (fn === bt.scrollItemIntoViewInPage) return page.onScrollItem ? page.onScrollItem(arg) : { ok: false, count: 0 };
      if (fn === bt.scrollStateInPage) return { y: 0, max: 0, vh: 800, docH: 800, inner: [] };
      if (fn === bt.scrollPageInPage) return { mode: "page", moved: 0, y: 0, max: 0 };
      if (typeof fn === "string") return "x".repeat(5000);
      const src = String(fn);
      if (/scrollingElement/.test(src)) return "0:0";
      if (/replace/.test(src)) return "текст страницы";
      if (/innerText/.test(src)) return 100;
      return { url: page._u, title: "ВКонтакте", items: [] };
    };
    return page;
  }

  async function openWith(page) {
    const browser = {
      isConnected: () => true,
      on() {},
      async pages() { return [page]; },
      async newPage() { return page; },
      async close() {},
    };
    bt.setPlaywright({
      chromium: {
        executablePath: () => "",
        async launch() { return browser; },
        async launchPersistentContext() { return browser; },
      },
    });
    await bt.close({ tabId: "all" });
    await bt.open({ url: page._u });
    return page;
  }

  await test("replay: повторяет запрос страницы, листает курсором и отдаёт файл", async () => {
    const calls = [];
    const page = fakePage();
    page.server = (arg) => {
      calls.push(arg.body);
      const pairs = bt.parseForm(arg.body);
      const cursor = (pairs.filter((p) => p[0] === "start_from")[0] || [])[1] || "";
      const pages = {
        "conversations_0": { items: [ITEM(111), ITEM(222)], last: 222 },
        "conversations_222": { items: [ITEM(222), ITEM(333)], last: 333 },
      };
      const cur = pages[cursor] || { items: [], last: cursor };
      return {
        ok: true, status: 200, url: arg.url, text: "",
        json: { response: { count: 3, conversations: { count: 3, items: cur.items }, last_item: cur.last } },
      };
    };
    await openWith(page);
    // Страница САМА отправила запрос — replay берёт адрес и тело из перехвата.
    page.emit("request", {
      method: () => "POST",
      url: () => "https://api.vk.ru/method/messages.getItems?v=5.285&client_id=6287487",
      resourceType: () => "xhr",
      postData: () => VK_BODY,
    });
    const out = await bt.replay({ match: "messages.getItems", cursorParam: "start_from", cursorPrefix: "conversations_", dir: dir });
    assert.ok(/собрано 3 строк за 2 запросов/.test(out), "не собрал все страницы:\n" + out);
    assert.ok(/собрано всё: 3 из 3/.test(out), "не остановился по total_count:\n" + out);
    assert.ok(/Повторов отброшено: 1/.test(out), "повтор строки не отброшен:\n" + out);
    assert.ok(/response\.conversations\.items/.test(out), "не сказал, откуда взял данные:\n" + out);
    assert.ok(out.indexOf("vk1.SECRET") < 0, "токен попал в ответ агента:\n" + out);
    assert.strictEqual(calls[0], VK_BODY, "первый запрос ушёл не байт в байт с перехваченным:\n" + calls[0]);
    assert.ok(/start_from=conversations_222/.test(calls[1]), "курсор не подставлен в следующий запрос:\n" + calls[1]);
    assert.ok(calls[1].indexOf("q=hello+world") >= 0, "нетронутое поле пересобрано иначе:\n" + calls[1]);
    assert.ok(calls[1].indexOf("access_token=vk1.SECRET") >= 0, "токен пересобран иначе (replay сломался бы):\n" + calls[1]);
    const saved = out.match(/Файл: (.+?) —/);
    assert.ok(saved, "не сказал, куда сохранил данные:\n" + out);
    const data = JSON.parse(fs.readFileSync(saved[1], "utf8"));
    assert.strictEqual(data.count, 3, "в файле не 3 строки");
    assert.strictEqual(data.items.length, 3, "в файле лишние или потерянные строки");
    assert.strictEqual(data.total, 3, "total не попал в файл");
    assert.strictEqual(data.itemsPath, "response.conversations.items", "путь элементов не записан в файл");
  });

  await test("replay: неподвижный курсор — стоп, а не бесконечная лента", async () => {
    const calls = [];
    const page = fakePage();
    page.server = (arg) => {
      calls.push(arg.body);
      return {
        ok: true, status: 200, url: arg.url, text: "",
        json: { response: { count: 0, items: [ITEM(100 + calls.length)], last_item: 999 } },
      };
    };
    await openWith(page);
    const out = await bt.replay({ url: "https://api.vk.ru/method/messages.getItems?v=5.285", body: VK_BODY, cursorParam: "start_from", cursorPrefix: "conversations_", dir: dir });
    assert.ok(/курсор не двигается/.test(out), "не остановился на неподвижном курсоре:\n" + out);
    assert.strictEqual(calls.length, 2, "сделал лишние запросы: " + calls.length);
  });

  await test("replay: set/remove правят тело, pick выводит строки, save отключается", async () => {
    const calls = [];
    const page = fakePage();
    page.server = (arg) => {
      calls.push(arg.body);
      return {
        ok: true, status: 200, url: arg.url, text: "",
        json: { response: { count: 3, items: [ITEM(111), ITEM(222)], last_item: 333 } },
      };
    };
    await openWith(page);
    const out = await bt.replay({
      url: "https://api.vk.ru/method/messages.getItems?v=5.285",
      body: VK_BODY,
      set: { target_count: 50, start_from: "conversations_0" },
      remove: ["extended", "fields"],
      save: false,
      pick: ["conversation.peer.id", "last_message.text"],
      maxSteps: 1,
      dir: dir,
    });
    assert.ok(/target_count=50/.test(calls[0]), "set не применился:\n" + calls[0]);
    assert.ok(!/extended=/.test(calls[0]), "remove не убрал поле extended:\n" + calls[0]);
    assert.ok(!/fields=/.test(calls[0]), "remove не убрал поле fields:\n" + calls[0]);
    assert.ok(/111 · msg-111/.test(out), "строки по pick не выведены:\n" + out);
    assert.ok(/упёрся в предел 1 шагов/.test(out), "не сказал про потолок шагов:\n" + out);
    assert.ok(out.indexOf("vk1.SECRET") < 0, "токен попал в ответ агента:\n" + out);
    assert.ok(out.indexOf("Файл: ") < 0, "сохранил файл, хотя save: false");
  });

  await test("replay: без перехвата честно говорит, что повторять нечего", async () => {
    const page = fakePage();
    await openWith(page);
    const out = await bt.replay({ match: "messages.getItems" });
    assert.ok(/нечего повторять/.test(out), out);
    assert.ok(/browserNetwork/.test(out), "не подсказал, где взять образец запроса:" + out);
  });

  await test("browserEval: save пишет результат в файл целиком", async () => {
    const page = fakePage();
    await openWith(page);
    const out = await bt.evalJs({ script: "1", save: true, maxChars: 100 });
    assert.ok(/Результат сохранён В ФАЙЛ/.test(out), out);
    const saved = out.match(/В ФАЙЛ: (.+?)\n/);
    assert.ok(saved, "путь к файлу не назван: " + out.slice(0, 200));
    const text = fs.readFileSync(saved[1], "utf8");
    assert.strictEqual(text.length, 5000, "в файл записан не весь результат (" + text.length + " символов)");
    assert.ok(/Символов: 5000/.test(out), "не сообщил размер результата:\n" + out);
    assert.ok(/readFile/.test(out), "не подсказал, как прочитать файл:\n" + out);
    fs.rmSync(saved[1], { force: true });
    // Без save поведение прежнее: обрезанный ответ и намёк на save.
    const plain = await bt.evalJs({ script: "1", maxChars: 100 });
    assert.ok(/обрезано, всего 5000 символов/.test(plain), plain);
    assert.ok(/save: true/.test(plain), "нет намёка на save:\n" + plain);
  });

  await test("ленивый список: строки считаются по ключам, последняя прокручивается в кадр", async () => {
    const rows = [
      { innerText: "Диалог 1", id: "", getAttribute: () => "", querySelector: () => ({ getAttribute: () => "/im/convo/1" }) },
      { innerText: "Диалог 2", id: "", getAttribute: () => "", querySelector: () => ({ getAttribute: () => "/im/convo/2" }) },
    ];
    let scrolled = "";
    for (const r of rows) r.scrollIntoView = function (o) { scrolled = r.innerText + ":" + ((o && o.block) || ""); };
    const prevDoc = global.document;
    global.document = { querySelectorAll: () => rows.slice() };
    try {
      const s1 = bt.itemsKeyInPage({ item: ".convo-item" });
      assert.strictEqual(s1.count, 2, "строки не посчитаны");
      assert.strictEqual(s1.uniq, 2, "уникальные ключи не посчитаны");
      assert.ok(/\/im\/convo\/1/.test(s1.joined), "ключ взят не из href: " + s1.joined);
      rows.push({ innerText: "Диалог 3", id: "", getAttribute: () => "", querySelector: () => ({ getAttribute: () => "/im/convo/3" }) });
      rows[rows.length - 1].scrollIntoView = function (o) { scrolled = this.innerText + ":" + ((o && o.block) || ""); };
      const s2 = bt.itemsKeyInPage({ item: ".convo-item" });
      assert.notStrictEqual(s1.joined, s2.joined, "рост списка не виден по ключам");
      assert.ok(bt.scrollItemIntoViewInPage({ item: ".convo-item", up: false }).ok, "не прокрутил последнюю строку");
      assert.ok(/Диалог 3:end/.test(scrolled), "прокручена не последняя строка: " + scrolled);
      assert.ok(bt.scrollItemIntoViewInPage({ item: ".convo-item", up: true }).ok, "не прокрутил первую строку (чтение вверх)");
      assert.ok(/Диалог 1:start/.test(scrolled), "при чтении вверх прокручена не первая строка: " + scrolled);

      // Живая догрузка: каждая прокрутка добавляет строку, потом список кончается.
      const page = fakePage();
      let extra = 0;
      page.onScrollItem = () => {
        if (extra < 3) {
          extra++;
          const n = rows.length + 1; // номер фиксируем сейчас: иначе все новые строки получат один href
          rows.push({ innerText: "Диалог " + n, id: "", getAttribute: () => "", querySelector: () => ({ getAttribute: () => "/im/convo/" + n }) });
          return { ok: true, count: rows.length };
        }
        return { ok: false, count: rows.length };
      };
      await openWith(page);
      const out = await bt.loadAllScroll(page, { item: ".convo-item", times: 12, read: true });
      assert.ok(/Строк в списке: 6/.test(out), "не сказал, сколько строк собрано:\n" + out.slice(0, 300));
      assert.ok(/конец списка/.test(out), "не понял, что список кончился:\n" + out.slice(0, 300));
      assert.ok(/Новое содержимое появилось на 3/.test(out), "неверный счётчик роста:\n" + out.slice(0, 300));
      // Дубликат той же строки (прокрутка туда-обратно) не считается новой.
      rows.push({ innerText: "Диалог 1 (копия)", id: "", getAttribute: () => "", querySelector: () => ({ getAttribute: () => "/im/convo/1" }) });
      assert.strictEqual(bt.itemsKeyInPage({ item: ".convo-item" }).uniq, 6, "повтор строки посчитан как новая");
    } finally {
      if (prevDoc === undefined) delete global.document;
      else global.document = prevDoc;
      bt.setPlaywright(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("связки: инструмент объявлен и в ядре, и в политике, и в панели", () => {
    assert.ok(/"browserReplay": async \(args, settings\) =>/.test(toolsSrc), "нет обработчика в agent-tools.js");
    assert.ok(/browserTools\.replay\(args\)/.test(toolsSrc), "обработчик не зовёт replay");
    assert.ok(/name: "browserReplay"/.test(coreSrc), "нет описания инструмента");
    assert.ok(/replay: "browserReplay"/.test(coreSrc), "нет алиаса имени");
    assert.ok(/"browserEval", "browserOverlays", "agentGuide", "browserReplay",/.test(coreSrc), "не попал в ядро инструментов");
    assert.ok(/"browserNetwork", "browserReplay", "waitForIdle", "agentGuide"\]/.test(coreSrc), "не попал в группу браузера");
    assert.ok(/browserNetwork, browserReplay, waitForIdle/.test(coreSrc), "не попал в список инструментов промпта");
    assert.ok(/38\. Данные со страницы бери ЗАПРОСОМ/.test(coreSrc), "нет правила про сбор данных запросом");
    assert.ok(/"browserEval", "browserScroll", "browserHover", "browserReplay"/.test(policySrc), "нет capability в политике инструментов");
    assert.ok(/browserReplay: "🔁"/.test(uiAll()), "нет иконки в журнале действий");
    assert.ok(/browserReplay: "Повтор запроса сайта"/.test(uiAll()), "нет подписи инструмента");
    // Гайды: замер ВК и порядок работы по сети.
    assert.ok(/api\.vk\.ru\/method\/messages\.getItems/.test(vkGuide), "в гайде ВК нет проверенного эндпоинта");
    assert.ok(/v=5\.285/.test(vkGuide), "в гайде ВК нет версии клиента");
    assert.ok(/ConvoList__itemsWrapper/.test(vkGuide), "в гайде ВК нет реального контейнера списка");
    assert.ok(/cursorPrefix/.test(vkGuide), "в гайде ВК нет примера replay с курсором");
    assert.ok(/browserReplay/.test(browserGuide), "в справочнике браузера нет раздела про запрос вместо DOM");
  });
}

// ── Скорость работы в браузере: ожидание, фреймы, submit, browserAct ───────
// Слабая/быстрая модель должна делать шаги «сразу», а не искать селекторы:
// инструменты сами ждут появления элемента, ищут его и во вложенных фреймах,
// умеют отправлять Enter вместе с вводом и выполняют цепочку шагов одной командой.
async function testBrowserSpeed() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js

  const mkEl = (o) => Object.assign({ visible: true, text: "", name: "" }, o);

  function fakePage(elements, url) {
    const page = {
      els: elements,
      clicked: [],
      filled: [],
      typed: [],
      keys: [],
      _u: url || "https://site.test/",
      keyboard: {
        async press(k) { page.keys.push(k); },
        async insertText(x) { page.typed.push(x); },
      },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Страница"; },
      on() {},
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
      first() { return loc(list.slice(0, 1)); },
      async count() { return list.length; },
      async isVisible() { return !!(list[0] && list[0].visible); },
      async scrollIntoViewIfNeeded() {},
      async click() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
        page.clicked.push(e.key);
      },
      async fill(t) {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (e.tag === "div") throw new Error("Element is not an <input>");
        page.filled.push({ key: e.key, text: t });
      },
      async selectOption() { throw new Error("did not find option"); },
      async evaluate(fn) { return fn({ options: [] }); },
    });
    page.locator = () => loc([]);
    page.getByRole = (role, o) => loc(by((e) => e.role === role && (!o || !o.name || e.name === o.name)));
    page.getByLabel = (t) => loc(by((e) => e.label === t));
    page.getByPlaceholder = (t) => loc(by((e) => e.placeholder === t));
    page.getByText = (t) => loc(by((e) => e.text === t || e.name === t));
    page.evaluate = async () => ({
      url: page._u,
      title: "Страница",
      items: elements.map((e, i) => ({
        ref: "e" + (i + 1),
        tag: e.tag,
        roleAttr: e.role,
        text: e.text || e.name,
        inViewport: e.visible,
        disabled: false,
      })),
    });
    return page;
  }

  const mainEls = [
    mkEl({ key: "login", tag: "button", role: "button", name: "Войти" }),
    mkEl({ key: "email", tag: "input", role: "textbox", label: "Почта" }),
  ];
  const page = fakePage(mainEls);
  const frame = fakePage([mkEl({ key: "frame-agree", tag: "button", role: "button", name: "Согласен" })], "https://widget.test/frame");
  page.frames = () => [page, frame];
  const mockBrowser = {
    isConnected: () => true,
    on() {},
    async pages() { return [page]; },
    async newPage() { return page; },
    async close() {},
  };

  await bt.close({ tabId: "all" });
  bt.setPlaywright({
    chromium: {
      executablePath: () => "",
      async launch() { return mockBrowser; },
      async launchPersistentContext() { return mockBrowser; },
    },
  });
  try {
    await bt.open({ url: "https://site.test/", newTab: true });

    await test("browserClick: сам ждёт появления элемента (без browserWait и повторов)", async () => {
      page.clicked.length = 0;
      setTimeout(() => mainEls.push(mkEl({ key: "late", tag: "button", role: "button", name: "Поздняя" })), 250);
      const r = await bt.click({ name: "Поздняя", timeout: 2500 });
      assert.ok(/^OK — клик/.test(r), "клик не прошёл по появившейся позже кнопке:\n" + r);
      assert.deepStrictEqual(page.clicked, ["late"]);
    });

    await test("browserClick: находит элемент во вложенном фрейме (iframe)", async () => {
      frame.clicked.length = 0;
      const r = await bt.click({ name: "Согласен" });
      assert.ok(/^OK — клик/.test(r), "элемент во фрейме не найден:\n" + r);
      assert.ok(/фрейм/.test(r), "ответ не сообщает, что элемент был во фрейме:\n" + r);
      assert.deepStrictEqual(frame.clicked, ["frame-agree"]);
    });

    await test("browserFill: submit сразу отправляет Enter (ввёл и отправил одним вызовом)", async () => {
      page.filled.length = 0;
      page.keys.length = 0;
      const r = await bt.fill({ label: "Почта", text: "a@b.c", submit: true });
      assert.ok(/^OK — поле/.test(r), r);
      assert.ok(/отправлено \(Enter\)/.test(r), "нет отметки об отправке:\n" + r);
      assert.deepStrictEqual(page.filled, [{ key: "email", text: "a@b.c" }]);
      assert.deepStrictEqual(page.keys, ["Enter"]);
    });

    await test("browserAct: цепочка шагов одной командой (клик → ввод+Enter → клавиша → пауза → текст)", async () => {
      page.clicked.length = 0;
      page.filled.length = 0;
      page.keys.length = 0;
      const r = await bt.act({
        steps: [
          { click: "Войти" },
          { field: "Почта", text: "b@c.d", submit: true },
          { press: "Escape" },
          { wait: 10 },
          { read: true },
        ],
      });
      assert.ok(/шагов 5 из 5, ок: 5/.test(r), "не все шаги выполнены:\n" + r);
      assert.ok(!/❌/.test(r), "есть сбой на ровном месте:\n" + r);
      assert.deepStrictEqual(page.clicked, ["login"]);
      assert.deepStrictEqual(page.filled, [{ key: "email", text: "b@c.d" }]);
      assert.deepStrictEqual(page.keys, ["Enter", "Escape"]);
    });

    await test("browserAct: первый сбой останавливает цепочку и объясняет причину", async () => {
      page.clicked.length = 0;
      page.keys.length = 0;
      const r = await bt.act({ steps: [{ click: "Кнопки нет" }, { press: "Enter" }] });
      assert.ok(/сбоев: 1/.test(r), "сбой не отражён:\n" + r);
      assert.ok(!/✅ .*Enter/.test(r), "шаги после сбоя всё равно выполнялись:\n" + r);
      assert.deepStrictEqual(page.keys, [], "Enter нажался после сбоя");
      assert.ok(/Похожие элементы|Что вообще есть/.test(r), "нет подсказки с похожими элементами:\n" + r);
    });

    await test("browserAct: без шагов и с мусором — понятная ошибка, а не молчание", async () => {
      const empty = await bt.act({});
      assert.ok(/Ошибка browserAct/.test(empty), empty);
      const junk = await bt.act({ steps: [123, { fill: {} }, { nonsense: 1 }] });
      assert.ok(/шаг не понял|Ошибка/.test(junk), junk);
    });

    await test("browserWait: пауза без элемента (странице нужно время дорисоваться)", async () => {
      const r = await bt.wait({ ms: 10 });
      assert.ok(/пауза 10 мс/.test(r), r);
    });

    await test("browserAct: цепочку можно начать с открытия адреса ({goto})", async () => {
      const r = await bt.act({ steps: [{ goto: "https://other.test/page" }, { snapshot: true }] });
      assert.ok(/шагов 2 из 2, ок: 2/.test(r), "цепочка с goto не прошла:\n" + r);
      assert.ok(/other\.test/.test(r), "в отчёте нет нового адреса:\n" + r);
      assert.strictEqual(page.url(), "https://other.test/page");
    });

    await test("browserAct: подключён к интерфейсу, промпту и подписям инструментов", () => {
      assert.ok(hasTool(mainSrc, "browserAct"), "бэкенд не обрабатывает browserAct");
      assert.ok(/name: "browserAct"/.test(coreSrc), "нет определения инструмента browserAct");
      // Значки и подписи инструментов живут в src/renderer/chat-work.js
      // (этап 3.7, часть 5) — проверяем окно целиком, а не один файл.
      assert.ok(/browserAct: "⚡"/.test(uiAll()), "нет иконки browserAct в интерфейсе");
      assert.ok(/browserAct: "Цепочка действий в браузере"/.test(uiAll()), "нет подписи browserAct");
      assert.ok(/быстрый путь/i.test(modelPrompt()), "в промпте нет блока про быстрый путь");
      assert.ok(/submit: true/.test(coreSrc), "промпт не знает про submit у browserFill");
      assert.ok(/фрейм/.test(coreSrc), "в описаниях нет поиска по фреймам");
    });
  } finally {
    bt.setPlaywright(null);
  }
}

// ── 1e. «Чувства» агента: прокрутка, наведение, сеть, ожидание покоя ────────
// Повод: половина элементов была ЗА ЭКРАНОМ (не видно в карте), меню не
// раскрывались без hover, а после клика агент гадал по DOM, что ответил сервер.
// Проверяем поведенчески на подставном Playwright и мини-DOM страницы.
async function testBrowserSenses() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  const mkEl = (o) => Object.assign({ visible: true, text: "", name: "", role: "button", tag: "button", inViewport: true }, o);

  function fakePage(elements, url) {
    const page = {
      els: elements,
      wheels: [],
      moves: [],
      handlers: {},
      _u: url || "https://site.test/",
      _scroll: { y: 0, max: 2000, vh: 800 },
      _inner: [],
      _takes: [],
      mouse: {
        async move(x, y) { page.moves.push([x, y]); },
        async wheel(dx, dy) {
          page.wheels.push([dx, dy]);
          page._scroll.y = Math.max(0, Math.min(page._scroll.max, page._scroll.y + dy));
        },
      },
      viewportSize: () => ({ width: 1000, height: 800 }),
      on(type, fn) { (page.handlers[type] = page.handlers[type] || []).push(fn); },
      off(type, fn) {
        const l = page.handlers[type] || [];
        const i = l.indexOf(fn);
        if (i >= 0) l.splice(i, 1);
      },
      emit(type) {
        const args = Array.prototype.slice.call(arguments, 1);
        for (const fn of (page.handlers[type] || []).slice()) fn.apply(null, args);
      },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Страница"; },
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
      first() { return loc(list.slice(0, 1)); },
      async count() { return list.length; },
      async isVisible() { return !!(list[0] && list[0].visible); },
      async scrollIntoViewIfNeeded() { if (list[0]) list[0].scrolledIn = true; },
      async boundingBox() {
        const e = list[0];
        return e ? { x: 10, y: 20, width: 100, height: 50 } : null;
      },
      async hover() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
        e.hovered = true;
        if (e.onHover) e.onHover();
      },
      async click() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
      },
      async fill() { if (!list[0]) throw new Error("no element"); },
      async evaluate(fn, arg) { return fn(list[0], arg); },
    });
    page.locator = (sel) => {
      const ref = String(sel).match(/^\[data-agent-ref="([^"]+)"\]$/);
      return loc(ref ? by((e) => e.ref === ref[1]) : []);
    };
    page.getByRole = (role, o) => loc(by((e) => e.role === role && (!o || !o.name || String(e.name).toLowerCase().indexOf(String(o.name).toLowerCase()) >= 0)));
    page.getByLabel = (t) => loc(by((e) => String(e.label || "").toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.getByPlaceholder = (t) => loc(by((e) => String(e.placeholder || "").toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.getByText = (t) => loc(by((e) => String(e.text || e.name).toLowerCase().indexOf(String(t).toLowerCase()) >= 0));
    page.evaluate = async (fn, arg) => {
      if (fn === bt.scrollStateInPage) {
        return { y: page._scroll.y, max: page._scroll.max, vh: page._scroll.vh, docH: page._scroll.max + page._scroll.vh, inner: page._inner };
      }
      if (fn === bt.scrollPageInPage) {
        const before = page._scroll.y;
        page._scroll.y = Math.max(0, Math.min(page._scroll.max, before + (arg.dy || 0)));
        return { moved: page._scroll.y - before, mode: page._scroll.y === before && !page._scroll.max ? "внутренний контейнер" : "страница", y: page._scroll.y, max: page._scroll.max };
      }
      if (fn === bt.scrollInnerInPage) {
        const el = arg.self;
        const before = el.scrollTop || 0;
        const box = el.__scroller || el;
        box.scrollTop = Math.max(0, before + (arg.dy || 0));
        return { moved: (box.scrollTop || 0) - before, mode: "контейнер", y: box.scrollTop || 0, max: (box.scrollHeight || 0) - (box.clientHeight || 0) };
      }
      if (fn === bt.idleStartInPage) return true;
      if (fn === bt.idleTakeInPage) return page._takes.length ? page._takes.shift() : 0;
      if (fn === bt.idleStopInPage) return true;
      // карта страницы (collectInPage)
      return {
        url: page._u,
        title: "Страница",
        items: page.els.map((e, i) => ({
          ref: e.ref || "e" + (i + 1),
          tag: e.tag,
          roleAttr: e.role,
          text: e.text || e.name,
          inViewport: e.inViewport !== false,
          disabled: !!e.disabled,
        })),
      };
    };
    return page;
  }

  const els = [
    mkEl({ key: "login", role: "button", name: "Войти" }),
    mkEl({ key: "settings", role: "button", name: "Настройки", inViewport: false }),
    mkEl({ key: "list", role: "button", name: "Список API" }),
    mkEl({ key: "menu", role: "button", name: "Профиль", onHover: () => { els.push(mkEl({ key: "logout", role: "menuitem", name: "Выйти" })); } }),
  ];
  els.forEach((e, i) => { e.ref = "e" + (i + 1); });
  const page = fakePage(els);
  const mockBrowser = {
    isConnected: () => true,
    on() {},
    async pages() { return [page]; },
    async newPage() { return page; },
    async close() {},
  };

  await bt.close({ tabId: "all" });
  bt.setPlaywright({
    chromium: {
      executablePath: () => "",
      async launch() { return mockBrowser; },
      async launchPersistentContext() { return mockBrowser; },
    },
  });
  try {
    await bt.open({ url: "https://site.test/" });

    await test("browserScroll: крутит колесом и отдаёт то, что попало в кадр", async () => {
      page.wheels.length = 0;
      const r = await bt.scroll({ how: "down" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.wheels[0], [0, 640], "колесо не сработало (ожидали 0.8 экрана = 640): " + JSON.stringify(page.wheels));
      assert.ok(/Прокрутка: 640 из 2000 \(32%\)/.test(r), "нет позиции прокрутки:\n" + r);
      // В ответе — что СЕЙЧАС в кадре, с ref: кликать можно сразу, без карты.
      assert.ok(/«Войти»/.test(r), "в кадре нет видимого элемента:\n" + r);
      assert.ok(/browserClick \{ ref: "e1" \}/.test(r), "нет подсказки с ref:\n" + r);
      assert.ok(!/«Настройки»/.test(r), "в кадр попал элемент вне экрана:\n" + r);
    });

    await test("browserScroll: прокрутить ДО элемента (его не было в кадре)", async () => {
      const r = await bt.scroll({ to: "Настройки" });
      assert.ok(/прокрутил до «/.test(r) && /Настройки/.test(r), "не прокрутил до элемента:\n" + r);
      assert.ok(els[1].scrolledIn === true, "scrollIntoView не вызван");
      assert.ok(/Прокрутка:/.test(r), "нет позиции после прокрутки:\n" + r);
      // Промах — честное сообщение с похожими элементами, а не молчание.
      const bad = await bt.scroll({ to: "Корзина" });
      assert.ok(/Не нашёл|Ошибка/.test(bad), "не нашёл элемент, но не сказал:\n" + bad);
    });

    await test("browserScroll: внутренний контейнер крутится там, где стоит курсор", async () => {
      page.wheels.length = 0;
      page.moves.length = 0;
      const r = await bt.scroll({ container: "Список API", how: "down", by: 300 });
      assert.ok(/прокрутил контейнер/.test(r) && /Список API/.test(r), r);
      assert.deepStrictEqual(page.moves[0], [60, 45], "курсор не наведён на контейнер (центр 10+100/2, 20+50/2): " + JSON.stringify(page.moves));
      assert.deepStrictEqual(page.wheels[0], [0, 300], "контейнер не прокручен колесом: " + JSON.stringify(page.wheels));
    });

    await test("browserScroll: страница не сдвинулась — говорит, что крутить контейнер", async () => {
      const still = fakePage([mkEl({ key: "a", role: "button", name: "Кнопка" })], "https://spa.test/");
      still._scroll = { y: 0, max: 0, vh: 800 };
      const browser = {
        isConnected: () => true,
        on() {},
        async pages() { return [still]; },
        async newPage() { return still; },
        async close() {},
      };
      bt.setPlaywright({ chromium: { executablePath: () => "", async launch() { return browser; }, async launchPersistentContext() { return browser; } } });
      await bt.close({ tabId: "all" });
      await bt.open({ url: "https://spa.test/" });
      const r = await bt.scroll({ how: "down" });
      assert.ok(/не сдвинулась/.test(r), "SPA-страница со своим скроллом не распознана:\n" + r);
      assert.ok(/container/.test(r), "нет подсказки про container:\n" + r);
      // Возвращаем рабочий браузер для остальных проверок.
      bt.setPlaywright({ chromium: { executablePath: () => "", async launch() { return mockBrowser; }, async launchPersistentContext() { return mockBrowser; } } });
      await bt.close({ tabId: "all" });
      await bt.open({ url: "https://site.test/" });
    });

    await test("browserHover: наводит мышь и показывает, что раскрылось", async () => {
      const r = await bt.hover({ name: "Профиль" });
      assert.ok(/^OK/.test(r), r);
      assert.ok(els[3].hovered === true, "hover не вызван");
      assert.ok(/Появилось/.test(r), "не сказал, что появилось:\n" + r);
      assert.ok(/«Выйти»/.test(r), "новый пункт меню не назван:\n" + r);
      // Элемент без hover-меню — честный ответ с подсказкой.
      const quiet = await bt.hover({ name: "Войти" });
      assert.ok(/Новых элементов не появилось/.test(quiet), quiet);
      assert.ok(/browserClick/.test(quiet), "нет совета, что делать дальше:\n" + quiet);
    });

    await test("browserNetwork: что ушло на сервер и что он ответил", async () => {
      const req = { method: () => "POST", url: () => "https://site.test/api/login", resourceType: () => "xhr" };
      const res = {
        request: () => req,
        status: () => 401,
        headers: () => ({ "content-type": "application/json; charset=utf-8" }),
        text: async () => '{"error":"invalid password"}',
      };
      page.emit("request", req);
      page.emit("response", res);
      await new Promise((r) => setTimeout(r, 5));
      const out = await bt.network({});
      assert.ok(/POST https:\/\/site.test\/api\/login → 401/.test(out), "нет строки запроса:\n" + out);
      assert.ok(/❌/.test(out), "ошибка ответа не помечена:\n" + out);
      assert.ok(/invalid password/.test(out), "тело ответа не показано:\n" + out);
      assert.ok(/4xx\/5xx/.test(out), "нет совета, что делать с ошибкой:\n" + out);
      // По умолчанию журнал очищается: второй вызов не повторяет старое.
      const again = await bt.network({});
      assert.ok(/новых запросов нет/.test(again), again);
      // Статика не мешает, если её не просили.
      const img = { method: () => "GET", url: () => "https://site.test/logo.png", resourceType: () => "image" };
      page.emit("request", img);
      page.emit("response", { request: () => img, status: () => 200, headers: () => ({ "content-type": "image/png" }), text: async () => "" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/новых запросов нет/.test(await bt.network({})), "картинка попала в отчёт без all: true");
      page.emit("request", img);
      page.emit("response", { request: () => img, status: () => 200, headers: () => ({ "content-type": "image/png" }), text: async () => "" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/logo\.png/.test(await bt.network({ all: true })), "с all: true статика не показана");
      // Фильтр по адресу.
      const api = { method: () => "GET", url: () => "https://site.test/api/items", resourceType: () => "xhr" };
      page.emit("request", api);
      page.emit("response", { request: () => api, status: () => 200, headers: () => ({ "content-type": "application/json" }), text: async () => "[]" });
      await new Promise((r) => setTimeout(r, 5));
      assert.ok(/api\/items/.test(await bt.network({ filter: "api/items" })), "фильтр не применён");
    });

    await test("waitForIdle: ждёт тишину DOM и сеть без запросов", async () => {
      page._takes = [3, 1, 0];
      const started = Date.now();
      const r = await bt.waitForIdle({ quietMs: 100, timeout: 3000 });
      assert.ok(/успокоилась/.test(r), r);
      assert.ok(/изменений DOM 4/.test(r), "мутации не посчитаны:\n" + r);
      assert.ok(Date.now() - started >= 90, "вернулся раньше тишины");
      assert.ok(/browserSnapshot/.test(r), "нет совета, что делать после покоя:\n" + r);
    });

    await test("страница-помощники: контейнер со скроллом находится и крутится", () => {
      // Мини-DOM: тело не скроллится, а внутренний блок — да (типичная SPA).
      const mkNode = (o) => Object.assign({
        scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0,
        className: "", parentElement: null, innerHeight: 0,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
      }, o);
      const inner = mkNode({ scrollHeight: 1000, clientHeight: 300, className: "list" });
      const child = mkNode({ parentElement: inner });
      const body = mkNode({ scrollHeight: 300, clientHeight: 300 });
      const docEl = mkNode({ scrollHeight: 300, clientHeight: 300, parentElement: body });
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStyle = global.getComputedStyle;
      global.document = { body, documentElement: docEl, querySelectorAll: () => [inner] };
      global.window = { innerHeight: 300, scrollY: 0, scrollX: 0, scrollBy() {}, scrollTo() {} };
      global.getComputedStyle = (el) => ({ overflowY: el === inner ? "auto" : "visible", visibility: "visible", display: "block", opacity: "1" });
      try {
        const state = bt.scrollStateInPage();
        assert.strictEqual(state.vh, 300);
        assert.strictEqual(state.inner.length, 1, "внутренний контейнер со скроллом не найден: " + JSON.stringify(state));
        // Крутим от ребёнка — поднимаемся до прокручиваемого родителя.
        const res = bt.scrollInnerInPage({ self: child, dy: 200 });
        assert.strictEqual(inner.scrollTop, 200, "прокрутка не дошла до контейнера: " + inner.scrollTop);
        assert.strictEqual(res.moved, 200);
        assert.strictEqual(res.max, 700);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.getComputedStyle = prevStyle;
      }
    });

    await test("browserScroll/browserHover/browserNetwork/waitForIdle связаны с приложением", () => {
      for (const t of ["browserScroll", "browserHover", "browserNetwork", "waitForIdle", "agentGuide"]) {
        assert.ok(hasTool(mainSrc, t), "бэкенд не обрабатывает " + t);
        const def = AgentCore.TOOL_DEFINITIONS.find((x) => x.function && x.function.name === t);
        assert.ok(def, "нет определения инструмента " + t);
        assert.ok(AgentCore.SYSTEM_PROMPT.indexOf(t) !== -1, t + " нет в списке инструментов промпта");
      }
      // Прокрутка умеет внутренние контейнеры и «до элемента» — это и просил пользователь.
      const scrollDef = AgentCore.TOOL_DEFINITIONS.find((x) => x.function.name === "browserScroll").function;
      for (const p of ["how", "by", "times", "to", "container"]) {
        assert.ok(scrollDef.parameters.properties[p], "у browserScroll нет параметра " + p);
      }
      assert.ok(/container/.test(scrollDef.description) && /внутренний/i.test(scrollDef.description), "описание не объясняет внутренние контейнеры");
      // Сеть спрашивают ПОСЛЕ действия — это должно быть в описании.
      assert.ok(/browserNetwork/.test(coreSrc) && /что ответил сервер/i.test(coreSrc), "промпт не учит спрашивать сеть после действия");
      // Алиасы, чтобы слабая модель не промахивалась мимо имени.
      for (const a of ["browser_scroll", "hover", "browser_network", "wait_for_idle", "guide"]) {
        assert.ok(/browserScroll|browserHover|browserNetwork|waitForIdle|agentGuide/.test(AgentCore.normalizeToolName(a)), "алиас " + a + " не ведёт к инструменту");
      }
      // При тесном контексте браузерный минимум должен остаться.
      const core = AgentCore.selectTools(8000).map((t) => t.function.name);
      for (const t of ["browserOpen", "browserSnapshot", "browserScroll", "browserHover", "browserNetwork", "waitForIdle", "agentGuide"]) {
        assert.ok(core.indexOf(t) >= 0, t + " выпал из ядра инструментов");
      }
      // Интерфейс: иконки и понятные подписи.
      assert.ok(/browserScroll: "↕️"/.test(uiAll()) && /browserNetwork: "📡"/.test(uiAll()) && /agentGuide: "📘"/.test(uiAll()), "нет иконок новых инструментов");
      assert.ok(/browserScroll: "Прокрутка страницы"/.test(uiAll()) && /waitForIdle: "Ожидание покоя страницы"/.test(uiAll()), "нет подписей новых инструментов");
      // Веб-версия: справочники и браузер честно недоступны, ожидание покоя = пауза.
      assert.ok(/agentGuide\) доступны в desktop-приложении/.test(uiAll()), "веб-версия не отвечает про agentGuide");
    });

    await test("зрение на скриншоте: включается по модели с ключом и спрашивает про кликабельное", () => {
      const shot = toolBody(mainSrc, "browserScreenshot", "browserEval");
      assert.ok(/vcfg.visionModel && vcfg.key/.test(shot), "зрение не подключается без галочки «Зрение»");
      assert.ok(/КЛИКАБЕЛЬНЫ/.test(shot), "вопрос зрению не про кликабельные элементы");
      assert.ok(/ЗА пределами экрана/.test(shot), "зрение не спрашивают про то, что за экраном");
      assert.ok(/analyze === false/.test(shot), "нет способа отключить разбор скриншота");
      assert.ok(/Настройки → вкладка «Зрение»/.test(shot), "нет подсказки, как включить зрение");
    });

    await test("справочники по сайтам: гайды есть, домены в шапке, маршрут сохраняется", () => {
      const dir = path.join(ROOT, "src", "agent-guides");
      const files = fs.readdirSync(dir);
      for (const name of ["vk.md", "chat-analysis.md", "google-cloud.md", "github.md"]) {
        assert.ok(files.indexOf(name) >= 0, "нет справочника " + name);
      }
      const gc = fs.readFileSync(path.join(dir, "google-cloud.md"), "utf8");
      assert.ok(/<!--\s*sites:\s*console\.cloud\.google\.com/.test(gc), "в гайде нет домена для авто-подхвата");
      assert.ok(/ENABLE/.test(gc) && /apis\/credentials/.test(gc), "гайд google-cloud не описывает включение API и ключи");
      assert.ok(/Terms of Service|Agree and continue/.test(gc), "гайд не описывает «стену» согласия");
      const gh = fs.readFileSync(path.join(dir, "github.md"), "utf8");
      assert.ok(/sites:\s*github\.com/.test(gh) && /tokens\/new/.test(gh), "гайд github не про токены/домены");
      // Инструмент: список/чтение/подхват по домену/сохранение маршрута.
      assert.ok(/function guideIndex\(\)/.test(mainSrc) && /function guideForUrl\(/.test(mainSrc) && /function agentGuideCall\(/.test(mainSrc), "нет логики справочников в main.js");
      assert.ok(/guideForUrl\(args && args.url\)/.test(mainSrc), "browserOpen не подсказывает справочник");
      assert.ok(/agent-guides/.test(mainSrc) && /userData/.test(mainSrc), "выученные справочники не сохраняются в память приложения");
      assert.ok(/^34\. Справочники и память маршрутов:/m.test(AgentCore.SYSTEM_PROMPT), "в промпте нет правила про справочники и маршруты");
      assert.ok(/^33\. Интерфейсы сайтов собраны из одних и тех же узоров/m.test(AgentCore.SYSTEM_PROMPT), "в промпте нет книги UI-паттернов");
    });

    await test("книга UI-паттернов: Material-select, автокомплит, длинные списки", () => {
      const p = modelPrompt(); // промпт + автоподключаемый справочник группы browser (промпт-диета)
      assert.ok(/НЕ <select>/.test(p), "не сказано, что Material-select — не <select>");
      assert.ok(/Автокомплит|подсказк/i.test(p), "нет правила про автокомплит (ввёл → выбрал подсказку)");
      assert.ok(/НЕ скролль вручную/.test(p), "нет правила про длинные списки (искать, а не скроллить)");
      assert.ok(/opacity: 0|скрытый ввод/.test(p), "нет правила про прозрачные чекбоксы");
      assert.ok(/Date-?\s?пикер|Дата-пикеры/i.test(p), "нет правила про дата-пикеры и деревья");
    });
  } finally {
    bt.setPlaywright(null);
  }
}

module.exports = {
  testBrowserTools,
  testBrowserBrain,
  testShellAndCdp,
  testBrowserOverlays,
  testBrowserReplayData,
  testBrowserSpeed,
  testBrowserSenses,
};

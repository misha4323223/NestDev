"use strict";

/* ── Панель Yandex Cloud «полкой»: иконки, фильтр, строка здоровья ───────────
   Запуск: node test/yc-ui.test.js   (входит в общий `npm test`)

   Зачем этот набор. Панель облака перестала быть списком эмодзи и стала полкой
   сервисов с ОФИЦИАЛЬНЫМИ иконками (src/renderer/yc-logos.js), поиском и
   фильтром, а сверху появилась строка здоровья: сколько ресурсов, что не
   ответило, баланс и — главное — платные хвосты в рублях.

   Что здесь стережётся (и почему именно это):
     • иконки — ОФИЦИАЛЬНЫЕ и НЕПЕРЕКРАШЕННЫЕ. Файл собирается из библиотеки
       брендбука Yandex Cloud, и правила брендбука запрещают менять внешний вид,
       пропорции и цвета. Поэтому проверяем: у каждого сервиса панели есть
       иконка, геометрия у всех одна (32×32), внутри нет ничего исполняемого
       (скрипты, обработчики, javascript:-ссылки), а подпись об источнике на месте.
     • в разметке и CSS соблюдён ПОРЯДОК: yc-logos.js грузится раньше панели,
       yc-panel.css — последним стилем, и все его селекторы живут только внутри
       `#sp-cloud`. Иначе новые правила подрались бы с общим окном.
     • CSS не полагается на то, что в этом приложении ПОГАШЕНО: monochrome.css
       убивает box-shadow и backdrop-filter глобально, поэтому «стекло» здесь
       делается светом и границей. Проверка статическая — чтобы никто не вернул
       тени и не удивился, почему их не видно.
     • панель действительно РАБОТАЕТ: собирается в игрушечном окне, грузит
       ресурсы и деньги, рисует плитки с иконками, фильтрует (поиск + «с
       ресурсами» / «ошибки»), показывает хвосты по клику и перечитывает деньги
       по кнопке ↻ — а не просто «строка на месте».
     • негативные контроли (то, ради чего набор и написан):
       ① без модуля иконок панель не падает — плитки те же, иконок нет;
       ② биллинг отказал — ресурсы всё равно видны, а вместо суммы честное
          «Баланс не видно» с причиной (частая — нет роли billing.viewer);
       ③ SVG со скриптом внутри не рисуется: панель показывает наш нейтральный
          знак, а не чужой код.

   Заглушка `$` строгая: id, которого нет в настоящей разметке, — ошибка теста. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const LOGOS_SRC = read("src", "renderer", "yc-logos.js");
const PANEL_SRC = read("src", "renderer", "yc-panel.js");
const CONSOLE_SRC = read("src", "renderer", "yc-console.js");
const HTML_SRC = read("src", "renderer", "index.html");
const PANEL_CSS = read("src", "renderer", "yc-panel.css");
const CONSOLE_CSS = read("src", "renderer", "yc-console.css");
const BRIDGE_SRC = read("src", "mobile-bridge.js");
const PKG = JSON.parse(read("package.json"));
const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));

const LOGOS = require(path.join(ROOT, "src", "renderer", "yc-logos.js"));

// ── Игрушечное окно: только id, которые есть в настоящей разметке ────────────

function makeNode(tag) {
  const cls = new Set();
  const node = {
    tagName: String(tag || "div").toLowerCase(),
    dataset: {},
    children: [],
    value: "",
    title: "",
    type: "",
    href: "",
    onclick: null,
    oninput: null,
    style: {},
    _text: "",
    _html: "",
  };
  Object.defineProperty(node, "className", {
    get: () => [...cls].join(" "),
    set: (v) => {
      cls.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c));
    },
  });
  Object.defineProperty(node, "textContent", {
    get: () => node._text + node.children.map((c) => c.textContent).join(""),
    set: (v) => {
      node._text = String(v);
      node.children = [];
    },
  });
  Object.defineProperty(node, "innerHTML", {
    get: () => node._html,
    set: (v) => {
      node._html = String(v);
      node.children = [];
    },
  });
  node.classList = {
    add: (...c) => c.forEach((x) => cls.add(x)),
    remove: (...c) => c.forEach((x) => cls.delete(x)),
    contains: (c) => cls.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !cls.has(c) : !!on;
      if (want) cls.add(c);
      else cls.delete(c);
      return want;
    },
  };
  node.appendChild = (c) => {
    node.children.push(c);
    return c;
  };
  node.querySelectorAll = (sel) => {
    const one = String(sel).replace(/^\./, "");
    const out = [];
    const walk = (n) => {
      for (const ch of n.children) {
        if (ch.classList.contains(one)) out.push(ch);
        walk(ch);
      }
    };
    walk(node);
    return out;
  };
  node.querySelector = (sel) => node.querySelectorAll(sel)[0] || null;
  node.setAttribute = (k, v) => {
    if (k.indexOf("data-") === 0) node.dataset[k.slice(5)] = String(v);
  };
  node.getAttribute = () => "";
  node.removeAttribute = () => {};
  node.remove = () => {};
  return node;
}

// Кнопки фильтра берём ИЗ РАЗМЕТКИ: подписи и значения должны совпадать с тем,
// что видит человек.
const FILTER_BTNS = [...HTML_SRC.matchAll(/<button[^>]*class="(yc-filter-btn[^"]*)"[^>]*data-flt="([^"]+)"[^>]*>([^<]+)</g)].map((m) => {
  const n = makeNode("button");
  n.className = m[1];
  n.dataset.flt = m[2];
  n._text = m[3].trim();
  return n;
});

function buildEnv(o) {
  const opts = o || {};
  const known = new Set([...HTML_SRC.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const initialClasses = new Map();
  for (const tag of HTML_SRC.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)) {
    const c = /class="([^"]*)"/.exec(tag[0]);
    initialClasses.set(tag[1], c ? c[1] : "");
  }
  const els = new Map();
  const $ = (id) => {
    assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
    if (!els.has(id)) {
      const node = makeNode("div");
      node.className = initialClasses.get(id) || "";
      if (id === "yc-filter") node.children = FILTER_BTNS.slice();
      els.set(id, node);
    }
    return els.get(id);
  };

  const calls = { resources: 0, billing: 0, status: 0 };
  const services = opts.services || [
    {
      key: "storage",
      ru: "Объектное хранилище",
      title: "Object Storage",
      ok: true,
      count: 2,
      items: [
        { id: "b1", name: "site-bucket" },
        { id: "b2", name: "logs" },
      ],
    },
    { key: "dns", ru: "DNS-зоны", title: "Cloud DNS", ok: false, count: 0, error: "403: нет роли dns.viewer" },
    { key: "cdn", ru: "CDN и сайты", title: "Cloud CDN", ok: true, count: 0, items: [] },
  ];

  const api = {
    ycStatus: async () => {
      calls.status++;
      return { loggedIn: true, iamOk: true, folderId: "folder-1", folderName: "prod", allowCreate: true };
    },
    ycResources: async () => {
      calls.resources++;
      if (opts.resourcesDelayMs) await new Promise((r) => setTimeout(r, opts.resourcesDelayMs));
      return opts.resourcesError
        ? { ok: false, error: opts.resourcesError }
        : { ok: true, services, total: 5, activeServices: 2 };
    },
    ycBilling: async (args) => {
      calls.billing++;
      calls.billingOp = args && args.op;
      if (opts.billingFails) return { ok: false, error: opts.billingFails };
      return {
        ok: true,
        account: { id: "acc-1", name: "Облако", currency: "RUB", balance: 1234.56, balanceHuman: "1 234,56 ₽", active: true },
        leaks: {
          count: 1,
          total: 310.5,
          live: 1440,
          running: [{ instance: { name: "vm-1" }, monthHuman: "1 440,00 ₽", month: 1440 }],
          tails: [{ kind: "disk", name: "data", month: 310.5, monthHuman: "310,50 ₽", why: "диск data не привязан ни к одной машине", todo: "удали диск" }],
        },
        lines: [],
        message: "",
      };
    },
    openExternal() {},
    ycLogs: async () => ({ ok: false, error: "нет логов" }),
  };

  const win = { YcConsole: { open() {}, close() {}, isOpen: () => false } };
  if (opts.withLogos !== false) win.YcLogos = opts.logos || LOGOS;
  const sandbox = {
    window: win,
    self: win,
    document: {
      getElementById: $,
      createElement: (t) => makeNode(t),
      createTextNode: (t) => {
        const n = makeNode("#text");
        n._text = String(t);
        return n;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    navigator: { clipboard: { readText: async () => "" } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  // В браузере глобал один: YcLogos лежит в window. В vm «окно» и глобальный
  // объект — разные вещи, поэтому модуль иконок кладём в оба места, иначе
  // панель его не увидит и тест проверял бы не то, что видит человек.
  if (opts.withLogos !== false) sandbox.YcLogos = opts.logos || LOGOS;
  vm.runInNewContext(PANEL_SRC, sandbox, { filename: "yc-panel.js" });
  assert.strictEqual(typeof win.YcPanel, "function", "модуль не отдал фабрику в window.YcPanel");
  const built = win.YcPanel({
    $,
    api,
    isElectron: true,
    toast() {},
    termAppend() {},
    confirmModal() {},
    inputDialog() {},
    openSettings() {},
    openSidePanel() {},
    getSettings: () => ({ ycFolderId: "folder-1", ycCloudId: "cloud-1" }),
  });
  return { $, built, calls, win, sandbox, els, services };
}

// Деньги панель спрашивает, НЕ блокируя полку (биллинг может думать секунды),
// поэтому после loadDashboard нужен один макрозаход — к этому моменту он ответил.
const tick = () => new Promise((r) => setTimeout(r, 0));

function tileByName(env, name) {
  return env
    .$("yc-dash")
    .querySelectorAll(".yc-tile")
    .find((t) => t.querySelectorAll(".yc-tile-name").some((n) => n.textContent === name));
}

// ── [1] Иконки ──────────────────────────────────────────────────────────────

(async function main() {
  console.log("\n[1] Официальные иконки сервисов");

  await test("yc-logos: у каждого сервиса панели есть своя иконка", () => {
    const missing = yandex.SERVICES.map((s) => s.key).filter((k) => !LOGOS.has(k));
    assert.deepStrictEqual(missing, [], "сервисы без иконки: " + missing.join(", "));
    assert.ok(Object.keys(LOGOS.LOGOS).length >= 20, "иконок подозрительно мало: " + Object.keys(LOGOS.LOGOS).length);
  });

  await test("yc-logos: иконки не перерисованы — одна геометрия 32×32 и подпись источника", () => {
    for (const [key, svg] of Object.entries(LOGOS.LOGOS)) {
      assert.ok(/viewBox="0 0 32 32"/.test(svg), key + ": иконка не 32×32 — значит, её перерисовали");
      assert.ok(/width="32"/.test(svg) && /height="32"/.test(svg), key + ": пропорции изменены");
    }
    assert.ok(/yandex\.cloud\/ru\/brandbook/.test(LOGOS.CREDIT), "в подписи нет ссылки на брендбук");
    assert.ok(/апрел/i.test(LOGOS.CREDIT) && LOGOS.LIBRARY_DATE, "не сказано, какой редакцией библиотеки собрано");
    assert.ok(/yandex\.cloud\/ru\/brandbook/.test(LOGOS_SRC), "в файле не осталось ссылки на источник иконок");
    assert.ok(/brandbook\/terms/.test(LOGOS_SRC), "в файле не сказано про правила использования логотипов");
  });

  await test("yc-logos: внутри иконок нет ничего исполняемого, а «злой» SVG подменяется нашим знаком", () => {
    for (const [key, svg] of Object.entries(LOGOS.LOGOS)) {
      assert.ok(LOGOS.isSafe(svg), key + ": в SVG есть скрипт, внешняя ссылка или обработчик");
    }
    // Негативный контроль: чужой код в иконке не должен доехать до экрана.
    const evil = '<svg viewBox="0 0 32 32"><script>alert(1)</script></svg>';
    assert.strictEqual(LOGOS.isSafe(evil), false, "SVG со скриптом признан безопасным");
    assert.strictEqual(LOGOS.isSafe('<svg viewBox="0 0 32 32"><a href="https://evil.tld/x">т</a></svg>'), false, "внешняя ссылка в SVG не замечена");
    LOGOS.LOGOS.__test_evil = evil;
    try {
      assert.strictEqual(LOGOS.svgFor("__test_evil"), LOGOS.FALLBACK, "на исполняемый SVG панель отдала бы его же");
    } finally {
      delete LOGOS.LOGOS.__test_evil;
    }
    assert.strictEqual(LOGOS.svgFor("нет-такого-сервиса"), LOGOS.FALLBACK, "у неизвестного сервиса нет нейтрального знака");
    assert.ok(/currentColor/.test(LOGOS.FALLBACK), "наш нейтральный знак должен брать цвет из темы");
  });

  await test("yc-logos: знак платформы вставляется с уникальными id (иначе ломается clipPath)", () => {
    const a = LOGOS.uniqueIds(LOGOS.brand());
    const b = LOGOS.uniqueIds(LOGOS.brand());
    assert.ok(/id="[^"]+-1"/.test(a) || a.indexOf("-1") > 0, "id знака остался прежним");
    assert.notStrictEqual(a, b, "две вставки знака получили одинаковые id");
    assert.ok(LOGOS.brand().indexOf("#2A9FFF") > 0, "знак платформы потерял фирменный синий цвет");
  });

  console.log("\n[2] Разметка, стили и проводка");

  await test("разметка грузит иконки раньше панели, а её стиль — последним", () => {
    const iLogos = HTML_SRC.indexOf('src="yc-logos.js"');
    const iPanel = HTML_SRC.indexOf('src="yc-panel.js"');
    assert.ok(iLogos > 0, "разметка не грузит yc-logos.js");
    assert.ok(iLogos < iPanel, "иконки подключены позже панели — она их не увидит");
    const iCss = HTML_SRC.indexOf('href="yc-panel.css"');
    const iTheme = HTML_SRC.indexOf('href="replit-theme.css"');
    assert.ok(iCss > iTheme, "стили панели стоят до темы окна: тема их перекроет");
    assert.ok(/<span id="yc-brand-mark"/.test(HTML_SRC), "в шапке нет места под знак платформы");
    assert.ok(/id="yc-search"/.test(HTML_SRC), "нет поиска по сервисам");
    assert.ok(/id="yc-filter"/.test(HTML_SRC), "нет фильтра сервисов");
    assert.ok(FILTER_BTNS.length === 3, "кнопок фильтра должно быть три: " + FILTER_BTNS.length);
    assert.ok(/id="yc-credit"/.test(HTML_SRC), "нет подписи об источнике иконок");
  });

  await test("телефон получает те же файлы панели (иконки и её стиль)", () => {
    assert.ok(/"yc-logos\.js"/.test(BRIDGE_SRC), "мост не отдаёт yc-logos.js");
    assert.ok(/"yc-panel\.css"/.test(BRIDGE_SRC), "мост не отдаёт yc-panel.css");
  });

  await test("стили панели не выходят за #sp-cloud и не полагаются на погашенные эффекты", () => {
    const rules = PANEL_CSS.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const line of rules.split("\n")) {
      const t = line.trim();
      if (!t || t.indexOf("{") < 0) continue;
      const sel = t.slice(0, t.indexOf("{")).trim();
      if (sel.indexOf("@") === 0) continue;
      for (const one of sel.split(",")) {
        assert.ok(one.trim().indexOf("#sp-cloud") === 0, "селектор без #sp-cloud подерётся с общим окном: " + one.trim());
      }
    }
    assert.ok(!/box-shadow\s*:/.test(rules), "box-shadow в этом окне погашен monochrome.css — тень не покажется");
    assert.ok(!/backdrop-filter\s*:/.test(rules), "backdrop-filter погашен monochrome.css — стекло не покажется");
    assert.ok(/--yc-blue:\s*#2a9fff/i.test(rules), "фирменный синий не вынесен в переменную");
    assert.ok(/@media \(max-width: 900px\)/.test(rules), "нет раскладки для узкой панели и телефона");
    assert.ok(/#sp-cloud \.yc-logo|#sp-cloud .*\.svg|\.yc-tile-logo svg/.test(rules) || /\.yc-tile-logo svg/.test(rules), "иконка не ограничена по размеру");
  });

  await test("карточка ресурса носит ту же иконку сервиса, что полка", () => {
    assert.ok(/window\.YcLogos/.test(CONSOLE_SRC), "карточка ресурса не берёт официальную иконку");
    assert.ok(/ykc-logo/.test(CONSOLE_CSS), "иконка карточки не описана в стилях");
  });

  console.log("\n[3] Панель работает: полка, фильтр, деньги");

  await test("полка: плитки с иконками, русские имена, ошибка текстом, «Создать» только где можно", async () => {
    const env = buildEnv();
    assert.deepStrictEqual(Object.keys(env.built).sort(), ["loadDashboard", "refreshSettingsUI"], "наружу торчит лишнее");
    await env.built.loadDashboard(true);
    await tick();

    const tiles = env.$("yc-dash").querySelectorAll(".yc-tile");
    assert.strictEqual(tiles.length, 3, "плиток должно быть три: " + tiles.length);
    const names = tiles.map((t) => t.querySelectorAll(".yc-tile-name")[0].textContent);
    assert.deepStrictEqual(names, ["Объектное хранилище", "DNS-зоны", "CDN и сайты"], "плитки названы не по-русски: " + names.join(", "));
    for (const t of tiles) {
      const logo = t.querySelectorAll(".yc-tile-logo")[0];
      assert.ok(logo && /<svg/.test(logo.innerHTML), "у плитки нет официальной иконки: " + t.textContent);
    }
    const failed = tileByName(env, "DNS-зоны");
    assert.ok(/нет роли dns\.viewer/.test(failed.textContent), "ошибка сервиса не показана текстом");
    assert.ok(tileByName(env, "Объектное хранилище").querySelectorAll(".yc-tile-add").length === 1, "у хранилища нет кнопки «Создать»");
    assert.ok(tileByName(env, "CDN и сайты").querySelectorAll(".yc-tile-add").length === 0, "CDN не создаётся агентом — кнопки быть не должно");
  });

  await test("плитка раскрывается в список ресурсов: имя ведёт в карточку ресурса", async () => {
    const env = buildEnv();
    await env.built.loadDashboard(true);
    let opened = null;
    env.win.YcConsole.open = (o) => {
      opened = o;
    };
    const tile = tileByName(env, "Объектное хранилище");
    tile.onclick();
    const rows = env.$("yc-dash").querySelectorAll(".yc-item");
    assert.strictEqual(rows.length, 2, "в раскрытой плитке не видно ресурсов: " + rows.length);
    const name = rows[0].querySelectorAll(".yc-item-name")[0];
    assert.strictEqual(name.textContent, "site-bucket");
    name.onclick({ stopPropagation() {} });
    assert.ok(opened && opened.item && opened.item.id === "b1", "клик по имени не открыл карточку ресурса");
    assert.strictEqual(opened.title, "Объектное хранилище", "карточка открыта с английским именем сервиса");
    // Повторный клик по плитке закрывает список.
    tileByName(env, "Объектное хранилище").onclick();
    assert.strictEqual(env.$("yc-dash").querySelectorAll(".yc-item").length, 0, "плитка не свернулась");
  });

  await test("фильтр и поиск правят полку на месте, без нового запроса в облако", async () => {
    const env = buildEnv();
    await env.built.loadDashboard(true);
    const resourcesCalls = env.calls.resources;

    const errBtn = FILTER_BTNS.find((b) => b.dataset.flt === "err");
    errBtn.onclick();
    const onlyErr = env.$("yc-dash").querySelectorAll(".yc-tile").map((t) => t.querySelectorAll(".yc-tile-name")[0].textContent);
    assert.deepStrictEqual(onlyErr, ["DNS-зоны"], "фильтр «Ошибки» показывает не то: " + onlyErr.join(", "));
    assert.ok(errBtn.classList.contains("active"), "активный фильтр не подсвечен");

    FILTER_BTNS.find((b) => b.dataset.flt === "used").onclick();
    const used = env.$("yc-dash").querySelectorAll(".yc-tile").map((t) => t.querySelectorAll(".yc-tile-name")[0].textContent);
    assert.deepStrictEqual(used, ["Объектное хранилище"], "фильтр «С ресурсами» показывает не то: " + used.join(", "));

    FILTER_BTNS.find((b) => b.dataset.flt === "all").onclick();
    env.$("yc-search").value = "функц";
    env.$("yc-search").oninput();
    assert.strictEqual(env.$("yc-dash").querySelectorAll(".yc-tile").length, 0, "поиск не сузил полку");
    assert.ok(/Ничего не нашлось/.test(env.$("yc-dash").textContent), "пустой поиск не объясняет, что делать");

    env.$("yc-search").value = "cdn";
    env.$("yc-search").oninput();
    const bySearch = env.$("yc-dash").querySelectorAll(".yc-tile").map((t) => t.querySelectorAll(".yc-tile-name")[0].textContent);
    assert.deepStrictEqual(bySearch, ["CDN и сайты"], "поиск по английскому имени нашёл не то: " + bySearch.join(", "));

    // Ищем по тому, что написано на плитке: человек не знает, что «Функции»
    // внутри называются Cloud Functions.
    env.$("yc-search").value = "хранилищ";
    env.$("yc-search").oninput();
    const byRu = env.$("yc-dash").querySelectorAll(".yc-tile").map((t) => t.querySelectorAll(".yc-tile-name")[0].textContent);
    assert.deepStrictEqual(byRu, ["Объектное хранилище"], "поиск по русскому имени не работает: " + byRu.join(", "));
    assert.strictEqual(env.calls.resources, resourcesCalls, "фильтр сходил в облако заново — данные уже загружены");
  });

  await test("строка здоровья: ресурсы, баланс и хвосты в рублях, хвосты раскрываются", async () => {
    const env = buildEnv();
    await env.built.loadDashboard(true);
    await tick();
    const strip = env.$("yc-summary");
    assert.ok(!strip.classList.contains("hidden"), "строка здоровья скрыта при подключённом облаке");
    const text = strip.textContent;
    assert.ok(/Ресурсов 5/.test(text), "нет числа ресурсов: " + text);
    assert.ok(/Баланс 1 234,56 ₽/.test(text), "нет баланса: " + text);
    assert.ok(/Хвосты 1 · 310,50 ₽\/мес/.test(text), "нет платных хвостов в рублях: " + text);
    assert.strictEqual(env.calls.billingOp, "overview", "деньги спрашиваются не обзором биллинга");
    assert.ok(/не является продуктом Яндекс\.Облака/.test(env.$("yc-credit").textContent), "в подвале нет честной оговорки про продукт");
    assert.ok(/<svg/.test(env.$("yc-brand-mark").innerHTML), "знак платформы не вставлен в шапку");

    const leakChip = strip.querySelectorAll(".yc-chip").find((c) => /Хвосты/.test(c.textContent));
    assert.ok(leakChip.classList.contains("yc-chip-link"), "по хвостам нельзя кликнуть — список не открыть");
    leakChip.onclick();
    const leaks = env.$("yc-summary").querySelectorAll(".yc-leaks");
    assert.strictEqual(leaks.length, 1, "список хвостов не открылся");
    assert.ok(/диск data не привязан/.test(leaks[0].textContent), "хвост назван без объяснения");
    assert.ok(/≈ 310,50 ₽/.test(leaks[0].textContent), "у хвоста нет цены за месяц");
    assert.ok(/удали диск/.test(leaks[0].textContent), "у хвоста нет ответа «что делать»");
  });

  await test("повторный заход берёт данные из памяти, а ↻ перечитывает деньги", async () => {
    const env = buildEnv();
    await env.built.loadDashboard(true);
    const r1 = env.calls.resources;
    const b1 = env.calls.billing;
    await env.built.loadDashboard(false);
    assert.strictEqual(env.calls.resources, r1, "второй заход сходил за ресурсами заново");
    assert.strictEqual(env.calls.billing, b1, "второй заход сходил за деньгами заново");
    env.$("btn-yc-dash-refresh").onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(env.calls.resources > r1, "кнопка ↻ не перечитала ресурсы");
    assert.ok(env.calls.billing > b1, "кнопка ↻ не перечитала деньги");
  });

  await test("пока ресурсы не пришли — скелетоны вместо пустой панели, потом плитки", async () => {
    const env = buildEnv({ resourcesDelayMs: 20 });
    const p = env.built.loadDashboard(true);
    await tick(); // статус подключения пройден, ресурсы ещё идут
    const skel = env.$("yc-dash").querySelectorAll(".yc-skel");
    assert.ok(skel.length >= 4, "во время загрузки нет скелетонов: " + skel.length);
    await p;
    assert.strictEqual(env.$("yc-dash").querySelectorAll(".yc-skel").length, 0, "скелетоны остались после загрузки");
    assert.strictEqual(env.$("yc-dash").querySelectorAll(".yc-tile").length, 3, "после загрузки нет плиток");
  });

  console.log("\n[4] Негативные контроли");

  await test("без модуля иконок панель работает: плитки те же, иконок нет", async () => {
    const env = buildEnv({ withLogos: false });
    await env.built.loadDashboard(true);
    await tick();
    const tiles = env.$("yc-dash").querySelectorAll(".yc-tile");
    assert.strictEqual(tiles.length, 3, "без иконок полка рассыпалась: " + tiles.length);
    assert.ok(tiles.every((t) => t.querySelectorAll(".yc-tile-logo")[0].innerHTML === ""), "иконка появилась ниоткуда");
    assert.ok(/Баланс 1 234,56 ₽/.test(env.$("yc-summary").textContent), "без иконок пропала строка здоровья");
  });

  await test("биллинг отказал — ресурсы видны, а вместо суммы честное «не видно» и причина", async () => {
    const env = buildEnv({ billingFails: "403: нет роли billing.viewer" });
    await env.built.loadDashboard(true);
    await tick();
    assert.strictEqual(env.$("yc-dash").querySelectorAll(".yc-tile").length, 3, "падение биллинга спрятало ресурсы");
    const text = env.$("yc-summary").textContent;
    assert.ok(/Баланс не видно/.test(text), "нет честного «баланс не видно»: " + text);
    const chip = env.$("yc-summary").querySelectorAll(".yc-chip").find((c) => /Баланс/.test(c.textContent));
    assert.ok(/billing\.viewer/.test(chip.title), "не сказано, какой роли не хватает");
    assert.ok(/Хвосты/.test(text) === false, "хвосты показаны, хотя биллинг не ответил");
  });

  await test("список ресурсов не загрузился — панель объясняет причину и не молчит", async () => {
    const env = buildEnv({ resourcesError: "Сеть: облако не ответило" });
    env.$("yc-search").oninput();
    await env.built.loadDashboard(true);
    await tick();
    assert.ok(/Ресурсы не загрузились: Сеть/.test(env.$("yc-dash").textContent), "ошибка загрузки ресурсов не объяснена");
    assert.ok(/Баланс 1 234,56 ₽/.test(env.$("yc-summary").textContent), "падение списка ресурсов спрятало деньги");
  });

  console.log("\n[5] Сторож и цепочка");

  await test("набор стоит в цепочке npm test, а сторож знает новую сводку", () => {
    assert.ok(/node test\/yc-ui\.test\.js/.test(PKG.scripts.test), "набор не подключён к цепочке npm test");
    const smoke = read("test", "smoke.test.js");
    assert.ok(smoke.indexOf('chip("Ошибки API", failed.length') > 0, "сторож не следит за строкой здоровья");
    assert.ok(smoke.indexOf('err.className = "yc-card-err"') > 0, "сторож перестал требовать текст ошибки сервиса");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало\n");
  process.exit(failed ? 1 : 0);
})();

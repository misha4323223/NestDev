"use strict";

/* ── Основа набора smoke: счётчики, проверка и общие помощники ──────────────
   Запуск: через test/smoke.test.js (бегунок) — набор входит в `npm test`.

   Зачем отдельный файл. Набор smoke — 19 тысяч строк и 87 наборов; общие
   помощники (чтение исходников, мини-DOM, разбор интерфейса, запрос в
   подменённое облако, чтение OTA-подписи) раньше лежали внутри файла
   наборов, и ни один новый файл не мог их взять. Здесь они в одном месте и
   не зависят от того, в каком порядке идут наборы.

   Здесь же значения, которыми помощники пользуются: кэш чтения интерфейса,
   порядок модулей окна и ключи для проверки OTA. Текст перенесён как есть.
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const assert = require("assert");

// Карта набора (что где лежит): отдельный лёгкий модуль — им пользуются и
// основа, и scripts/smoke-map.js, и test/smoke/source.js.
const map = require("./map.js");

const ROOT = path.join(__dirname, "..", ".."); // корень проекта

let passed = 0;
let failed = 0;

// Фильтр по имени: node test/smoke.test.js "replay|ленивый список" — прогон только тех
// тестов, чьё имя содержит одну из подсказок (через |). Нужен для отладки и проверки
// мутаций: весь набор идёт полторы минуты, а точечный прогон — секунды.
const ONLY = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
function selected(name) {
  if (!ONLY.length) return true;
  return ONLY.some((s) => name.indexOf(s) >= 0);
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

// Итог и код выхода. Печатает одну строку и отдаёт число провалов: каким кодом
// закончить — решает бегунок.
function finish() {
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  return failed;
}

// ── Текст интерфейса: код ищем там, где он лежит СЕЙЧАС ────────────────────
// app.js разбирается по этапам: куски уезжают в свои модули src/renderer/*.js.
// Проверки, которые берут кусок и исполняют его, должны находить код, а не знать
// адрес — иначе каждый вынос роняет пачку тестов (так было на этапе 2).
//   uiFile("имя.js") — один файл;  uiAll() — весь интерфейс (app.js последним, как
//   при загрузке);  uiFind(начало[, конец]) — кусок с проверкой, что маркер не
//   раздвоился: два одинаковых маркера в разных файлах — это ошибка, а не догадка.
// Кто проверяет, что в САМОМ app.js чего-то больше нет, читает app.js напрямую:
// это нарочно, и число таких чтений стережёт тест «бюджет прямых чтений app.js».
const RENDERER_DIR = path.join(ROOT, "src", "renderer");

const UI_ORDER = fs
  .readdirSync(RENDERER_DIR)
  .filter((f) => f.endsWith(".js") && f !== "app.js")
  .sort()
  .concat("app.js");

const uiCache = new Map();

// ── 3. ota ──────────────────────────────────────────────────────────────────
// Наборы здесь собираются ПОДПИСАННЫМИ (src/ota-sign.js): подпись — это то, что
// отличает «набор собрал владелец» от «набор положил кто-то в папку-источник».
// Ключи стендовые, создаются на месте, доверие к ним выдаётся переменной окружения
// в testOta() — то есть идёт настоящая проверка, а не послабление.
const otaSigner = require(path.join(ROOT, "src", "ota-sign.js"));

const OTA_TEST_KEYS = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: pub, id: otaSigner.keyId(pub) };
})();

// ── Исходники бэкенда целиком ───────────────────────────────────────────────
// Yandex Cloud вынесен из main.js в отдельные модули (yc-service.js, yc-ipc.js).
// Проверки «в приложении есть канал/помощник» читают бэкенд целиком: тот же код,
// что раньше лежал в main.js, просто теперь в своём файле.
// Только main.js: нужен там, где проверка говорит именно про него. Остальные
// проверки читают бэкенд целиком — код мог переехать в свой модуль.
// Инструмент агента: раньше каждая ветка была `case "имя": {` внутри switch в
// main.js, теперь это запись реестра `"имя": async (args, settings) => {` в
// agent-tools.js (1.5.77). Проверяем НАЛИЧИЕ инструмента, а не место, где он лежал.
function hasTool(src, name) {
  // Третья форма — ссылка на модуль дома инструментов (часть 40): тело уехало,
  // а в реестре осталось `"имя": write.имя,`. Без неё инструмент считался бы
  // необъявленным ровно после того, как его перенесли (ловилось уже четырежды).
  return (
    src.includes('case "' + name + '"') ||
    src.includes('"' + name + '": async (args, settings) =>') ||
    new RegExp('"' + name + '":\\s*[A-Za-z_$][\\w$]*\\.' + name + ',', 'm').test(src)
  );
}

// Тело инструмента: срез от его начала до начала следующего — в любом из двух видов.
function toolBody(src, from, to) {
  const at = (name) => {
    const a = src.indexOf('case "' + name + '"');
    const b = src.indexOf('"' + name + '": async (args, settings) =>');
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  };
  const start = at(from);
  const end = at(to);
  return start >= 0 && end > start ? src.slice(start, end) : "";
}

// Тело инструмента ЦЕЛИКОМ — от его записи до закрывающей `    },`. Нужен там, где
// инструмент уехал в свой модуль дома (часть 40): сосед по прежнему файлу больше
// не рядом, и срез «до следующего имени» отдавал пустоту — проверка молчала, хотя
// выглядела живой (ловилось на installExe).
function toolBodySelf(src, name) {
  const start = src.indexOf('"' + name + '": async (args, settings) =>');
  if (start < 0) return "";
  const end = /\n    \},?\n/.exec(src.slice(start));
  return end ? src.slice(start, start + end.index + end[0].length) : src.slice(start);
}

function mainOnlySrc() {
  return fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
}

function backendSrc() {
  return ["main.js", "agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js", "agent-tools-devtools.js", "agent-tools-media.js", "agent-tools-vault.js", "agent-tools-env.js", "agent-tools-browser.js", "yc-service.js", "yc-ipc.js", "deploy-ipc.js", "mail-ipc.js", "fs-ipc.js", "git-ipc.js", "system-stack.js", "mission-ipc.js", "model-ipc.js", "github-ipc.js", "settings-store.js", "paths-git.js", "project-search.js", "undo-store.js", "bg-processes.js", "screens.js", "rate-limiters.js", "tool-helpers.js", "project-analysis.js", "site-guides.js", "terminal-panel.js", "app-window.js", "lifecycle.js", "run-mission.js", "run-tools.js", "run-retry.js", "run-round.js", "run-calls.js", "run-strict.js", "run-batch.js", "run-nudge.js", "agent-env.js", "shell-tools.js", "tasks-reminders.js", "run-ai.js", "browser-ipc.js", "project-brief.js", "chats-ipc.js", "memory-ipc.js", "git-stage.js", "settings-ipc.js", "mobile-ipc.js", "projects-ipc.js", "preview-ipc.js", "ota-ipc.js", "run-ipc.js", "tool-registry.js", "run-context.js", "ask-wait.js", "agent-data.js", "role-folders.js", "net-proxy.js", "net-proxy-ipc.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8"))
    .join("\n");
}

// Дом агентских инструментов ЦЕЛИКОМ: тела обработчиков разбираются по своим модулям
// (часть 40), а проверка «повтор доходит до хранилища» спрашивает про ТЕЛО, а не про
// файл-оболочку. Без этого проверка зеленеет ровно до того дня, когда обработчик
// уезжает, и тогда падает не текстом, а отсутствием строки (та же ловушка, что у
// toolBodySelf — HANDOFF §4).
function toolsHomeSrc() {
  return ["agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js", "agent-tools-devtools.js", "agent-tools-media.js", "agent-tools-vault.js", "agent-tools-env.js", "agent-tools-browser.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8"))
    .join("\n");
}

// Ядро агента ВМЕСТЕ с его данными. Текст правил (prompts.js) и таблица схем
// инструментов (tool-schemas.js) вынесены из agent-core.js в свои модули (разрез
// ядра, этап 1). Проверки вида «в промпте сказано X» и «в описании инструмента есть
// Y» обязаны видеть данные, где бы они ни лежали — иначе падают на переехавшем
// тексте, хотя поведение не менялось. Кто проверяет, что в САМОМ ядре чего-то
// больше нет (тест «разрез ядра»), читает agent-core.js напрямую.
function coreData() {
  return ["agent-core.js", "prompts.js", "tool-schemas.js"]
    .map((f) => fs.readFileSync(path.join(ROOT, "src", "renderer", f), "utf8"))
    .join("\n");
}

function uiFile(name) {
  if (!uiCache.has(name)) uiCache.set(name, fs.readFileSync(path.join(RENDERER_DIR, name), "utf8"));
  return uiCache.get(name);
}

function uiAll() {
  return UI_ORDER.map(uiFile).join("\n");
}

function uiFind(startMarker, endMarker) {
  const hits = UI_ORDER.filter((f) => uiFile(f).indexOf(startMarker) !== -1);
  assert.strictEqual(
    hits.length,
    1,
    "маркер должен быть ровно в одном файле интерфейса: " + JSON.stringify(startMarker) + " → " + (hits.join(", ") || "нигде")
  );
  const file = hits[0];
  const src = uiFile(file);
  const start = src.indexOf(startMarker);
  if (endMarker === undefined) return { file, start, code: src.slice(start) };
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, "не найден конец куска (" + JSON.stringify(endMarker) + ") в " + file);
  return { file, start, end, code: src.slice(start, end) };
}

// Сборка вынесенного модуля ленты (chat-feed.js) в песочнице: та же фабрика, что и
// в приложении, поэтому проверяется НАСТОЯЩИЙ код, а не копия из теста.
function buildChatFeed(deps) {
  const vm = require("vm");
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "chat-feed.js"), "utf8");
  const sandbox = {
    module: { exports: {} },
    self: {},
    console: { warn() {}, log() {}, error() {} },
    // Очередь кадра зовёт requestAnimationFrame: в песочнице его нет, поэтому
    // пробрасываем наружу — так тест сам распоряжается кадрами.
    requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  };
  vm.runInNewContext(src, sandbox, { filename: "chat-feed.js" });
  assert.strictEqual(typeof sandbox.module.exports, "function", "модуль ленты не отдал фабрику");
  return sandbox.module.exports(deps);
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── Промпт-диета: что РЕАЛЬНО видит модель ──────────────────────────────────
// Длинные правила переехали в справочники (src/agent-guides) и приходят в запрос
// сами, когда активна группа (GROUP_GUIDES в main.js). Поэтому проверяем
// «эффективный промпт» = SYSTEM_PROMPT + автоподключаемые справочники, а не только
// текст agent-core.js: иначе тест требует вернуть в промпт то, что сознательно убрали.
function autoGuideNames() {
  const mainSrc = backendSrc();
  const m = /const GROUP_GUIDES = \{([^}]*)\}/.exec(mainSrc);
  assert.ok(m, "в main.js нет карты GROUP_GUIDES — справочники групп не подключаются");
  const names = m[1]
    .split(",")
    .map((pair) => (pair.split(":")[1] || "").trim().replace(/["']/g, ""))
    .filter(Boolean);
  assert.ok(names.length >= 4, "GROUP_GUIDES почти пуст: " + m[1]);
  return [...new Set(names)];
}

function modelPrompt() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const parts = [core.SYSTEM_PROMPT || ""];
  for (const n of autoGuideNames()) {
    const file = path.join(ROOT, "src", "agent-guides", n + ".md");
    assert.ok(fs.existsSync(file), "справочник группы \"" + n + "\" не найден: " + file);
    parts.push(fs.readFileSync(file, "utf8"));
  }
  // Markdown-кавычки мешают сверять фразы: убираем их, текст правил не меняем.
  return parts.join("\n").replace(/`/g, "");
}

function makeBundle(dir, files, version, corrupt, signer) {
  const filesB64 = {};
  for (const rel of Object.keys(files)) filesB64[rel] = Buffer.from(files[rel]).toString("base64");
  const bundleJson = JSON.stringify({ version, files: filesB64 });
  // signer === undefined — свой ключ (обычный случай); null — набор без подписи.
  const key = signer === undefined ? OTA_TEST_KEYS : signer;
  const manifest = {
    app: "ai-agent",
    version,
    codeVersion: version,
    builtAt: Date.now(),
    files: Object.keys(filesB64).length,
    sha256: crypto.createHash("sha256").update(bundleJson).digest("hex"),
    sig: key ? otaSigner.signBundle(bundleJson, key.priv) : "",
    keyId: key ? otaSigner.keyId(key.pub) : "",
  };
  if (corrupt) manifest.sha256 = "0".repeat(64);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle.json"), bundleJson, "utf8");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

// ── 5. server.js (API-защита) ───────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function get(port, p, secure) {
  return new Promise((resolve) => {
    const mod = secure ? require("https") : require("http");
    const req = mod.get({ host: "127.0.0.1", port, path: p, timeout: 5000, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
  });
}

// Весь дом браузера агента: ядро сессии (browser-tools.js) и вынесенные из него
// модули (функции страницы, replay, сеть, карта, прокрутка). Читаем по ИМЕНИ
// файла, а не жёстким списком: перенос кода в новый модуль не должен ослеплять
// сторожа (на этом уже дважды ловились — см. AGENT-NOTES, часть 39).
function browserHomeSrc() {
  const dir = path.join(ROOT, "src");
  return fs
    .readdirSync(dir)
    .filter((f) => /^browser-.*\.js$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

// ── Настройки: поиск по НАСТОЯЩЕЙ функции на игрушечном DOM ─────────────────
// Достаём settingsSearchApply из app.js и прогоняем на дереве, повторяющем
// структуру вкладок. Проверяется сама логика фильтра, а не только наличие строк.
function miniDom() {
  const el = (tag, cls, opts) => {
    const o = opts || {};
    const e = {
      tagName: tag,
      children: [],
      _classes: new Set(String(cls || "").split(" ").filter(Boolean)),
      _attrs: Object.create(null),
      text: o.text || "",
      value: "",
      placeholder: o.placeholder || "",
      title: "",
      focus() {},
    };
    Object.defineProperty(e, "classList", {
      value: {
        contains: (c) => e._classes.has(c),
        add: (...cs) => cs.forEach((c) => e._classes.add(c)),
        remove: (...cs) => cs.forEach((c) => e._classes.delete(c)),
        toggle: (c, on) => {
          const want = on === undefined ? !e._classes.has(c) : !!on;
          if (want) e._classes.add(c);
          else e._classes.delete(c);
          return want;
        },
      },
    });
    Object.defineProperty(e, "textContent", {
      get() {
        return [e.text].concat(e.children.map((c) => c.textContent)).join(" ");
      },
    });
    Object.defineProperty(e, "dataset", {
      get() {
        const out = {};
        for (const k of Object.keys(e._attrs)) {
          if (k.indexOf("data-") === 0) out[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = e._attrs[k];
        }
        return out;
      },
    });
    e.getAttribute = (n) => (n in e._attrs ? e._attrs[n] : null);
    e.setAttribute = (n, v) => {
      e._attrs[n] = String(v);
    };
    e.appendChild = (...cs) => {
      cs.forEach((c) => e.children.push(c));
      return e;
    };
    return e;
  };

  const desc = (n) => {
    const out = [];
    const walk = (x) => {
      for (const c of x.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(n);
    return out;
  };
  const matchSimple = (e, rawSel) => {
    let rest = rawSel.trim();
    const not = /:not\(\.([\w-]+)\)/.exec(rest);
    if (not) {
      if (e._classes.has(not[1])) return false;
      rest = rest.replace(not[0], "");
    }
    const attr = /\[([\w-]+)="([^"]*)"\]/.exec(rest);
    if (attr) {
      if (e.getAttribute(attr[1]) !== attr[2]) return false;
      rest = rest.replace(attr[0], "");
    }
    const tag = /^[a-zA-Z][\w-]*/.exec(rest);
    if (tag) {
      if (e.tagName !== tag[0].toLowerCase()) return false;
      rest = rest.slice(tag[0].length);
    }
    for (const c of rest.match(/\.([\w-]+)/g) || []) if (!e._classes.has(c.slice(1))) return false;
    return true;
  };
  const matchIn = (root, sel) => {
    let cur = [root];
    for (const part of sel.trim().split(/\s+/)) {
      const next = [];
      for (const node of cur) for (const d of desc(node)) if (matchSimple(d, part)) next.push(d);
      cur = next;
      if (!cur.length) return [];
    }
    return cur;
  };
  const queryAll = (root, sel) => {
    const seen = new Set();
    const out = [];
    for (const sub of String(sel).split(",")) {
      for (const m of matchIn(root, sub)) {
        if (!seen.has(m)) {
          seen.add(m);
          out.push(m);
        }
      }
    }
    return out;
  };
  const attach = (e) => {
    e.querySelectorAll = (s) => queryAll(e, s);
    e.querySelector = (s) => queryAll(e, s)[0] || null;
    return e;
  };

  // Дерево: навигация + содержимое + поиск (структура как в index.html).
  const root = attach(el("div", "settings-panel"));
  const nav = attach(el("nav", "settings-nav"));
  const mkStab = (tab, name) => {
    const b = attach(el("button", tab === "model" ? "stab active" : "stab"));
    b.setAttribute("data-tab", tab);
    const t = attach(el("span", "stab-text"));
    t.appendChild(attach(el("b", "", { text: name })));
    b.appendChild(t);
    nav.appendChild(b);
    return b;
  };
  mkStab("model", "Модель");
  mkStab("mail", "Почта");

  const content = attach(el("div", "settings-content"));
  const empty = attach(el("div", "settings-empty hidden"));
  content.appendChild(empty);

  const bodyModel = attach(el("div", "settings-tab-body"));
  bodyModel.setAttribute("data-tab-body", "model");
  const secProvider = attach(el("div", "settings-section"));
  const fProvider = attach(el("div", "field", { text: "Активный провайдер" }));
  fProvider.appendChild(attach(el("select", "select")));
  secProvider.appendChild(fProvider);
  const accOllama = attach(el("div", "acc"));
  accOllama.setAttribute("data-acc", "ollama");
  const fOllama = attach(el("div", "field", { text: "Ollama URL" }));
  fOllama.appendChild(attach(el("input", "", { placeholder: "http://localhost:11434" })));
  accOllama.appendChild(fOllama);
  // Поле замера: подпись «Скорость модели», слова «замерить» в подписи нет —
  // оно живёт в тексте кнопки и в её подсказке, как в настоящей разметке.
  const fProbe = attach(el("div", "field", { text: "Скорость модели" }));
  const btnProbe = attach(el("button", "btn btn-ghost", { text: "Замерить скорость" }));
  btnProbe.title = "Замерить локальную модель: связь, загрузку, чтение промпта, генерацию и память";
  fProbe.appendChild(btnProbe);
  accOllama.appendChild(fProbe);
  const accOpenai = attach(el("div", "acc"));
  accOpenai.setAttribute("data-acc", "openai");
  const fKey = attach(el("div", "field", { text: "API-ключ" }));
  fKey.appendChild(attach(el("input", "", { placeholder: "sk-..." })));
  accOpenai.appendChild(fKey);
  const hints = attach(el("div", "model-hints hidden"));
  bodyModel.appendChild(secProvider, accOllama, accOpenai, hints);
  content.appendChild(bodyModel);

  const bodyMail = attach(el("div", "settings-tab-body hidden"));
  bodyMail.setAttribute("data-tab-body", "mail");
  const secMail = attach(el("div", "settings-section"));
  const fMail = attach(el("div", "field", { text: "Пароль приложения" }));
  fMail.appendChild(attach(el("input", "", { placeholder: "пароль приложения" })));
  secMail.appendChild(fMail);
  bodyMail.appendChild(secMail);
  content.appendChild(bodyMail);

  root.appendChild(nav, content);

  const search = attach(el("input", "", { placeholder: "Поиск настроек" }));
  const clear = attach(el("button", "btn hidden"));
  const byId = { "settings-search": search, "settings-search-clear": clear, "settings-empty": empty };

  return {
    root,
    content,
    empty,
    bodyModel,
    bodyMail,
    accOllama,
    accOpenai,
    secProvider,
    hints,
    input: search,
    document: {
      querySelectorAll: (s) => queryAll(root, s),
      querySelector: (s) => queryAll(root, s)[0] || null,
    },
    $: (id) => byId[id] || null,
  };
}

// ── Панель настроек (этап 3.8, часть 3) ─────────────────────────────────────
// Модуль берём с диска целиком и собираем ТОЙ ЖЕ фабрикой, что и приложение:
// проверяются настоящие поля, вкладки и сохранение, а не вырезка из app.js.
function fakeEl(id) {
  const cls = new Set();
  return {
    id: id,
    value: "",
    checked: false,
    textContent: "",
    innerHTML: "",
    type: "password",
    style: {},
    className: "",
    title: "",
    classList: {
      add: (...cs) => cs.forEach((c) => cls.add(c)),
      remove: (...cs) => cs.forEach((c) => cls.delete(c)),
      contains: (c) => cls.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !cls.has(c) : !!on;
        if (want) cls.add(c);
        else cls.delete(c);
        return want;
      },
    },
    appendChild() {},
    setAttribute() {},
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

// ── Панель проекта (этап 7) ──────────────────────────────────────────────────
// Модуль берём с диска целиком и собираем ТОЙ ЖЕ фабрикой, что и приложение:
// проверяется, что он поднимается на одних объявленных зависимостях (пропущенная
// зависимость — это ReferenceError на загрузке окна, и окно останется пустым).
function panelDom() {
  const el = {
    id: "", value: "", checked: false, textContent: "", innerHTML: "", className: "", title: "",
    type: "text", src: "", alt: "", scrollTop: 0, scrollHeight: 0, firstChild: null,
    children: [], parentNode: null, files: null, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild: () => el, insertBefore: () => el, removeChild: () => el, remove: () => el,
    setAttribute: () => el, removeAttribute: () => el, getAttribute: () => null,
    addEventListener: () => el, removeEventListener: () => el, dispatchEvent: () => true,
    querySelector: () => panelDom(), querySelectorAll: () => [],
    closest: () => null, matches: () => false, contains: () => false,
    focus() {}, select() {}, click() {}, blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  };
  return el;
}

// Код без строк и комментариев. Имя, попавшее В СТРОКУ, модуль уронить не может
// («X is not defined» случается только в коде), а таблицы данных — промпт и схемы
// инструментов — состоят из строк почти целиком: без этой чистки они выглядели как
// утечка. Заодно снимается старая ошибка наивного среза комментариев: «//» внутри
// строки («https://…») съедал остаток строки вместе с кодом, и утечка пряталась.
function codeOnly(src) {
  const TICK = String.fromCharCode(96); // обратная кавычка без вложенных кавычек
  let out = "";
  let i = 0;
  let mode = ""; // "" | "line" | "block" | TICK | двойная | одинарная
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "line") {
      if (c === "\n") { mode = ""; out += c; }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") { mode = ""; i += 2; continue; }
      i++;
      continue;
    }
    if (mode === TICK || mode === '"' || mode === "'") {
      if (c === "\\") { i += 2; continue; }
      if (c === mode) { mode = ""; out += c; }
      i++;
      continue;
    }
    if (c === "/" && d === "/") { mode = "line"; i += 2; continue; }
    if (c === "/" && d === "*") { mode = "block"; i += 2; continue; }
    if (c === TICK || c === '"' || c === "'") { mode = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

module.exports = {
  test,
  selected,
  finish,
  ROOT,
  RENDERER_DIR,
  UI_ORDER,
  uiCache,
  otaSigner,
  OTA_TEST_KEYS,
  hasTool,
  toolBody,
  toolBodySelf,
  mainOnlySrc,
  backendSrc,
  toolsHomeSrc,
  coreData,
  uiFile,
  uiAll,
  uiFind,
  buildChatFeed,
  tmpdir,
  autoGuideNames,
  modelPrompt,
  makeBundle,
  freePort,
  get,
  browserHomeSrc,
  miniDom,
  fakeEl,
  panelDom,
  codeOnly,
  mapRows: map.mapRows,
  declaredSuites: map.declaredSuites,
  runnerCalls: map.runnerCalls,
  mapProblems: map.mapProblems,
  setSources: map.setSources,
  declaredAll: map.declaredAll,
  lineAt: map.lineAt,
  lastNonEmpty: map.lastNonEmpty,
};

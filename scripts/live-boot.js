"use strict";
/* ─── Живой прогон окна без Chromium ──────────────────────────────────────────
   Запуск: bun run test:boot     (node scripts/live-boot.js)
   Ключи:  --strip=<файл>  — негативный контроль: убрать тег файла из разметки,
                             прогон обязан это заметить.

   Зачем. В песочнице нет системных библиотек для Chromium (libglib), поэтому
   `test:live` там не идёт. А проверить, что окно действительно собирается, нужно
   после каждого выноса кода из app.js: модули подключаются тегами, и забытый тег
   или потерянный обработчик видны только при запуске.

   Что делает:
     1. Поднимает настоящий мобильный мост и дергает по HTTP каждый скрипт и стиль
        из разметки — так ловится файл, забытый в STATIC_FILES (на телефоне он молча
        давал 404).
     2. Запускает все скрипты в одной браузерной песочнице в порядке тегов index.html
        с заглушками DOM, собранными из id настоящей разметки: забытый элемент или
        обращение к несуществующей зависимости падает здесь.
     3. Проверяет, что ожидаемые модули объявились и панели повесили обработчики. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "src", "renderer");
const STRIP = (() => {
  const a = process.argv.find((s) => s.startsWith("--strip="));
  return a ? a.slice("--strip=".length) : "";
})();

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

// Скрипты и стили, которые разметка реально подключает.
let html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
if (STRIP) html = html.replace(new RegExp('^.*' + STRIP.replace(/\./g, "\\.") + '.*$\\n', "m"), "");
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const assets = [...html.matchAll(/(?:src|href)="([^"/][^"]*\.(?:js|css))"/g)].map((m) => m[1]);

// ── 1. Живой HTTP: мост отдаёт окно телефону ───────────────────────────────
async function liveHttp() {
  console.log("\n[1] Живой HTTP: мобильный мост отдаёт файлы окна");
  const MobileBridge = require(path.join(ROOT, "src", "mobile-bridge.js"));
  const port = 9187;
  const b = new MobileBridge({ handlerMap: new Map() });
  b.port = port;
  b.start();
  await new Promise((r) => setTimeout(r, 300));
  try {
    for (const f of assets) {
      const res = await fetch("http://127.0.0.1:" + port + "/" + f);
      const body = await res.text();
      ok(res.status === 200 && body.length > 0, "GET /" + f + " → " + res.status + ", " + body.length + " байт");
    }
  } finally {
    b.stop();
  }
}

// ── 2. Запуск окна в порядке тегов ─────────────────────────────────────────
// preload — то, что должно лежать в localStorage ДО загрузки скриптов (настройки:
// без модели окно справедливо отказывается отправлять запрос).
// fetchImpl — чем отвечает сеть: нужен, чтобы прогнать НАСТОЯЩИЙ цикл ответа.
function bootWindow(preload, fetchImpl) {
  console.log("\n[2] Запуск окна: " + scripts.length + " скриптов в порядке тегов");
  const stubs = new Map();
  // Заглушка не строит дерево DOM, но у неё есть текст настоящей разметки: только для
  // `closest` этого достаточно. Без него app.js справедливо падает на элементе,
  // которого в песочнице «нет», и живой прогон терял бы настоящий код.
  const closestByHtml = (id, sel) => {
    const cls = String(sel || "").replace(/^\./, "");
    const at = id ? html.indexOf('id="' + id + '"') : -1;
    if (!cls || at < 0) return null;
    const re = new RegExp('<[a-zA-Z][^>]*class="[^"]*' + cls + '[^"]*"', "g");
    let m;
    let last = -1;
    while ((m = re.exec(html.slice(0, at)))) last = m.index;
    return last < 0 ? null : { className: cls, classList: { add() {}, remove() {}, contains: () => false, toggle() {} } };
  };
  const makeEl = (tag) => {
    const set = new Set();
    return {
      tagName: String(tag).toUpperCase(), id: "", className: "", style: {}, dataset: {}, children: [],
      value: "", textContent: "", innerHTML: "", title: "", checked: false, disabled: false, hidden: false,
      classList: {
        add: (...c) => c.forEach((x) => set.add(x)),
        remove: (...c) => c.forEach((x) => set.delete(x)),
        contains: (c) => set.has(c),
        // Второй довод (force) настоящий classList.toggle уважает: без него проверка
        // «класс добавлен/убран» в песочнице врала бы — молча оставляла как было.
        toggle: (c, force) => {
          const want = force === undefined ? !set.has(c) : !!force;
          if (want) set.add(c);
          else set.delete(c);
        },
      },
      setAttribute() {}, getAttribute: () => "", removeAttribute() {}, hasAttribute: () => false,
      // parentNode проставляется как в настоящем DOM: без этого перерисовка сообщения
      // (old.parentNode.insertBefore) в песочнице падала бы на null — то есть
      // песочница врала бы про ошибку в окне.
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; }, removeChild() {},
      insertBefore(c) { c.parentNode = this; this.children.push(c); return c; }, replaceChildren() {},
      remove() {}, focus() {}, blur() {}, click() {}, select() {}, scrollIntoView() {}, scrollTo() {},
      closest(sel) { return closestByHtml(this.id, sel); }, querySelector: () => null, querySelectorAll: () => [],
      // Запоминаем подписку на click/change — иначе честная панель, которая вешает
      // обработчик через addEventListener, выглядит в прогоне «без обработчика».
      addEventListener(type, fn) { if (type === "click" || type === "change") this["on" + type] = fn; },
      removeEventListener() {}, dispatchEvent: () => true,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
      clientHeight: 100, scrollHeight: 100, offsetHeight: 100, clientWidth: 100, scrollWidth: 100, offsetWidth: 100,
      firstChild: null, lastChild: null, parentNode: null, files: [], childNodes: [],
    };
  };
  const $ = (id) => {
    if (!ids.has(id)) return null;
    if (!stubs.has(id)) {
      const e = makeEl("div");
      e.id = id; // нужно тому же closest: по id он ищет родителя в настоящей разметке
      stubs.set(id, e);
    }
    return stubs.get(id);
  };
  const store = new Map();
  const win = {
    document: {
      getElementById: $, createElement: (t) => makeEl(t), createTextNode: (t) => ({ text: t }),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
      body: makeEl("body"), documentElement: makeEl("html"), head: makeEl("head"),
      title: "boot", readyState: "complete", hidden: false, cookie: "", activeElement: null,
    },
    navigator: { userAgent: "boot", language: "ru", clipboard: { readText: async () => "", writeText: async () => {} } },
    location: { href: "file:///index.html", origin: "file://", protocol: "file:", reload() {}, assign() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      key: (i) => [...store.keys()][i] || null,
      get length() { return store.size; },
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame() {},
    AbortController, AbortSignal, TextDecoder, TextEncoder, ReadableStream, Response, Blob,
    innerWidth: 1440, innerHeight: 900, devicePixelRatio: 1,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {}, info() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    ResizeObserver: class { observe() {} disconnect() {} },
    WebSocket: class { constructor() {} send() {} close() {} },
    EventSource: class { constructor() {} close() {} },
    api: null, // браузерный режим: IPC нет
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.globalThis = win;
  win.__stubs = stubs; // для проверки обработчиков ниже
  if (fetchImpl) win.fetch = fetchImpl;
  if (preload) for (const [k, v] of Object.entries(preload)) win.localStorage.setItem(k, v);
  const ctx = vm.createContext(win);

  for (const file of scripts) {
    const code = fs.readFileSync(path.join(RENDERER, file), "utf8");
    try {
      vm.runInContext(code, ctx, { filename: file });
    } catch (e) {
      ok(false, "скрипт " + file + " не выполнился: " + ((e && e.message) || e));
      return win;
    }
  }
  ok(true, "все " + scripts.length + " скриптов из разметки выполнились");

  // Модули, которые обязаны подняться в окне.
  // ProviderTransport / ContextWindow / ImageTools — фабрики (их вызывает agent-core),
  // остальные отдают готовый объект. Проверяем именно то, чем модуль является.
  const globals = [
    ["AgentCore", "object"], ["Prompts", "object"], ["ToolSchemas", "object"], ["ContextWindow", "function"],
    ["ProviderConfig", "object"], ["ProviderTransport", "function"], ["WebTools", "object"], ["ImageTools", "function"],
    ["MdRender", "object"], ["Highlight", "object"], ["QR", "object"], ["YcConsole", "object"],
    ["YcPanel", "function"], ["DeployPanel", "object"], ["DevRun", "function"],
    ["MobilePanel", "function"],
    ["BootGuard", "object"],
    ["ChatThinking", "function"],
    ["ChatSegments", "function"],
    ["ChatRender", "function"],
    ["ChatFeed", "function"],
    ["ChatWork", "function"],
    ["SettingsSearch", "function"],
    ["OpenaiProfiles", "function"],
    // Модули, вынесенные из app.js разбором (этапы A и B): каждый — фабрика,
    // которую оболочка собирает своей проводкой. Забытый тег или сломанная проводка
    // видны именно здесь — на настоящем порядке тегов из index.html.
    ["ChatEvents", "function"],
    ["G4fPanel", "function"],
    ["PlanPanel", "function"],
    ["AutoTasks", "function"],
    ["ModelPopup", "function"],
    ["AskModal", "function"],
    ["ChatRename", "function"],
    ["ChatStore", "function"],
    ["ChatRun", "function"],
    ["ChatSend", "function"],
    ["ChatContinue", "function"],
  ];
  for (const [name, kind] of globals) ok(typeof win[name] === kind, "модуль в окне: " + name + " (" + kind + ")");
  return win;
}

// ── 3. Обработчики на элементах разметки ───────────────────────────────────
function checkWiring(win) {
  console.log("\n[3] Обработчики панелей на элементах разметки");
  const stubs = win.__stubs;
  const wired = [
    "btn-yc-connect", "btn-yc-dash-refresh", "s-yc-allow-update",
    "btn-preview-start", "btn-preview-stop", "btn-probe-ollama", "btn-probe-model",
    // Панель дел и миссии (задачи со сроками): строки добавляются, фильтры кликаются.
    "btn-task-add", "btn-role", "btn-tasks-refresh", "btn-tasks-done-toggle",
    "btn-mission-pause", "btn-mission-resume", "btn-mission-stop", "btn-mission-finish", "btn-mission-refresh",
    // Секреты: переменные агента, пароли сайтов и почта.
    "btn-env-add", "btn-env-import", "btn-vault-add", "btn-vault-clear", "btn-vault-eye",
    "btn-mail-detect", "btn-mail-test", "btn-mail-test-send", "btn-mail-recent",
    // Мобильный доступ: галочка включает поля и читает статус, кнопка меняет PIN.
    "s-mobile-enabled", "btn-mobile-pin-regen",
  ];
  for (const id of wired) {
    const el = stubs && stubs.get(id);
    const h = el && (el.onclick || el.onchange);
    ok(typeof h === "function", "обработчик на " + id);
  }
}

// ── 4. Живой замер локальной модели: отвечает НАСТОЯЩИЙ сервер ──────────────
// Заглушек сети здесь нет: поднимается настоящий HTTP-сервер на 127.0.0.1 и
// говорит протоколом Ollama. Проверяем, что замер действительно ходит по сети,
// считает по настоящим длительностям и не выдумывает цифры.
async function liveProbe() {
  console.log("\n[4] Живой замер модели: настоящий HTTP-сервер вместо Ollama");
  const http = require("http");
  const core = require(path.join(RENDERER, "agent-core.js"));
  const asked = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(req.url);
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/api/tags") return json({ models: [{ name: "qwen3:8b" }] });
      if (req.url === "/api/ps") {
        const ran = asked.indexOf("/api/chat") >= 0;
        return json({ models: ran ? [{ name: "qwen3:8b", size: 5368709120, size_vram: 4294967296 }] : [] });
      }
      // 600 токенов промпта за 20 с, 24 токена генерации за 4 с — из этих чисел
      // и строится вердикт, поэтому они известны заранее.
      if (req.url === "/api/chat") {
        return json({
          message: { content: "готов" },
          total_duration: 30e9,
          load_duration: 0,
          prompt_eval_count: 600,
          prompt_eval_duration: 20e9,
          eval_count: 24,
          eval_duration: 4e9,
        });
      }
      if (req.url === "/api/show") {
        return json({
          capabilities: ["completion", "tools"],
          model_info: {
            "general.architecture": "qwen3",
            "qwen3.context_length": 40960,
            "qwen3.block_count": 36,
            "qwen3.attention.head_count": 32,
            "qwen3.attention.head_count_kv": 8,
            "qwen3.embedding_length": 4096,
          },
        });
      }
      json({});
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  try {
    const r = await core.probeLocalModel(
      { provider: "ollama", ollamaUrl: base },
      "qwen3:8b",
      { numCtx: 8192, window: 40960, promptTokens: 3000, probeChars: 600 }
    );
    ok(r.ok, "замер прошёл по сети" + (r.ok ? "" : ": " + r.error));
    ok(asked.indexOf("/api/tags") >= 0 && asked.indexOf("/api/chat") >= 0, "замер спросил сервер: " + asked.join(", "));
    ok(r.genPerSec === 6, "скорость генерации из живого ответа: " + r.genPerSec + " ток/с");
    ok(r.prefillPerSec === 30, "скорость чтения промпта: " + r.prefillPerSec + " ток/с");
    ok(r.gpuShare === 0.8, "доля весов в видеопамяти: " + r.gpuShare);
    ok(r.kvPerToken === 147456, "KV-кэш на токен: " + r.kvPerToken);
    ok(r.ok && r.lines.join("\n").length > 40, "отчёт непустой: " + r.lines.length + " строк");
    ok(/видеопамят|видеокарт/i.test(r.lines.join("\n")), "в отчёте названа видеопамять");
  } finally {
    srv.close();
  }
}

// ── 5. Живой цикл ответа через НАСТОЯЩЕЕ окно ─────────────────────────────
// Самый дорогой класс тихих поломок при разрезании окна: код переехал, состояние
// меняется, а ШАПКА не перерисовывается — крутилка и «Стоп» остаются на месте,
// кнопка «Отправить» скрыта, и отправить следующую команду нечем. Именно это и
// случилось при выносе прогона (chat-run.js): признак снимался, разметка — нет.
// Здесь проверяется настоящий путь: щелчок по «Отправить» → прогон → завершение.
// Провайдера нет — но проверяется не провайдер, а то, что окно возвращается в рабочее
// состояние и в ленте появляется ответ (та же ошибка — тоже ответ).
async function liveAnswerCycle() {
  console.log("\n[5] Живой цикл ответа: шапка возвращается после прогона");
  const sse =
    "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: "Готово: живой прогон окна." } }] }) + "\n\n" +
    "data: [DONE]\n\n";
  const win = bootWindow(
    {
      settings: JSON.stringify({
        provider: "openai",
        openaiUrl: "https://api.groq.com/openai/v1",
        openaiApiKey: "live-boot-key",
        openaiModel: "live-boot-model",
        model: "live-boot-model",
      }),
      chats: JSON.stringify({ chats: [], activeId: null }),
    },
    // Отвечаем настоящим потоком: та же форма, что у провайдера (SSE + [DONE]).
    async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } })
  );
  const stubs = win.__stubs;
  if (!stubs) return;
  // Элементы берём через getElementById: заглушка появляется при первом обращении,
  // а до прогона окно к «typing» может и не обращаться.
  const send = win.document.getElementById("btn-send");
  const stop = win.document.getElementById("btn-stop");
  const typing = win.document.getElementById("typing");
  ok(!!send && !!stop && !!typing, "кнопки шапки есть в окне");
  if (!send || !stop || !typing) return;
  ok(!send.classList.contains("hidden"), "до прогона кнопка «Отправить» на месте");

  const input = win.document.getElementById("input");
  input.value = "живая проверка окна";
  let promise = null;
  try {
    promise = send.onclick(); // это и есть ChatSend.sendMessage из разметки
  } catch (e) {
    ok(false, "живая отправка упала: " + ((e && e.message) || e));
    return;
  }
  ok(promise && typeof promise.then === "function", "отправка завела прогон");
  ok(stop.classList.contains("hidden") === false, "во время прогона видна кнопка «Стоп»");
  ok(send.classList.contains("hidden") === true, "во время прогона «Отправить» скрыта (крутилка на месте)");
  try {
    await promise;
  } catch (e) {
    ok(false, "живой прогон упал исключением: " + ((e && e.message) || e));
    return;
  }
  ok(send.classList.contains("hidden") === false, "после прогона «Отправить» вернулась — иначе следующую команду отправить нечем");
  ok(stop.classList.contains("hidden") === true, "после прогона «Стоп» убран из шапки");
  ok(typing.classList.contains("hidden") === true, "после прогона крутилка погасла");
  // Ответ должен дойти до ЧАТА, а не только до консоли: заглушки DOM текст детей
  // не собирают, поэтому смотрим сохранённый чат — тот же путь, на котором ответ
  // рисовался и сохранялся в окне.
  const saved = String(win.localStorage.getItem("chats") || "");
  ok(/Готово: живой прогон окна/.test(saved), "ответ агента дошёл до чата и сохранён: " + JSON.stringify(saved.slice(0, 90)));
  ok(/живая проверка окна/.test(saved), "запрос человека тоже в истории чата");
  // И человек должен мочь отправить ещё раз — повторный щелчок не отказывает.
  input.value = "вторая команда";
  const second = send.onclick();
  ok(stop.classList.contains("hidden") === false, "вторая отправка тоже началась (окно не заперто)");
  try {
    await second;
  } catch (e) {}
  ok(send.classList.contains("hidden") === false, "после второй команды «Отправить» снова на месте");

  // Самый частый случай в жизни: провайдер ответил ошибкой. Прогон обрывается — и
  // кнопка ОБЯЗАНА вернуться, иначе человек не может даже повторить запрос.
  const errWin = bootWindow(
    {
      settings: JSON.stringify({
        provider: "openai",
        openaiUrl: "https://api.groq.com/openai/v1",
        openaiApiKey: "live-boot-key",
        openaiModel: "live-boot-model",
        model: "live-boot-model",
      }),
      chats: JSON.stringify({ chats: [], activeId: null }),
    },
    async () => new Response("server exploded", { status: 500, headers: { "content-type": "text/plain" } })
  );
  const eSend = errWin.document.getElementById("btn-send");
  const eStop = errWin.document.getElementById("btn-stop");
  const eInput = errWin.document.getElementById("input");
  eInput.value = "запрос, который упадёт";
  try {
    await eSend.onclick();
  } catch (e) {
    ok(false, "прогон с ошибкой провайдера упал исключением: " + ((e && e.message) || e));
    return;
  }
  ok(eSend.classList.contains("hidden") === false, "после ошибки провайдера «Отправить» вернулась — можно повторить запрос");
  ok(eStop.classList.contains("hidden") === true, "после ошибки «Стоп» убран из шапки");
  const errSaved = String(errWin.localStorage.getItem("chats") || "");
  // Ошибку ищем в самих полях error сообщений, а не в тексте всего файла: поиск
  // по всему файлу проходил бы на любом упоминании «ошиб» (например, в заголовке
  // чата) и молча перестал бы ловить пропавшее объяснение. Заодно в отчёт идёт
  // сам текст ошибки, а не начало файла — иначе по выводу не понять, что нашли.
  const errTexts = [];
  const collectErrors = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(collectErrors);
    for (const [key, val] of Object.entries(node)) {
      if (key === "error" && typeof val === "string" && val) errTexts.push(val);
      else collectErrors(val);
    }
  };
  try {
    collectErrors(JSON.parse(errSaved));
  } catch {}
  const errFound = errTexts.find((t) => /API error 500|server exploded|ошиб/i.test(t)) || "";
  ok(!!errFound, "ошибка провайдера объяснена в чате: " + (errFound || JSON.stringify(errTexts).slice(0, 120)));
}

(async () => {
  console.log("Живой прогон окна" + (STRIP ? " (негативный контроль: без " + STRIP + ")" : ""));
  await liveHttp();
  const win = bootWindow();
  if (win.__stubs) checkWiring(win);
  await liveProbe();
  await liveAnswerCycle();
  console.log(failures ? "\nЖИВОЙ ПРОГОН: провалов " + failures : "\nЖИВОЙ ПРОГОН: всё чисто");
  process.exit(failures ? 1 : 0);
})();

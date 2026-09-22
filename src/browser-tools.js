"use strict";

/* ── Браузерные инструменты агента (Playwright) ─────────────────────────────
   Агент получает ВИДИМОЕ окно Chromium и управляет им через инструменты:
   открыть URL, КАРТА страницы (browserSnapshot), заполнить поле, кликнуть,
   выбрать из <select>, нажать клавишу, прочитать текст страницы, сделать
   скриншот, подождать элемент, закрыть вкладку.
   Окно видимое намеренно: пользователь видит, что делает агент, и может
   дожимать руками капчу / 2FA / лишние подтверждения.

   Как агент «понимает» кнопки (без перебора селекторов):
     • browserSnapshot отдаёт карту: ref (e1, e2…), роль, видимое имя, подсказки;
     • браузер сам нумерует элементы атрибутом data-agent-ref — ref живут до
       перезагрузки страницы;
     • browserClick / browserFill принимают ref, role+name (доступное имя),
       label/placeholder или обычный CSS-селектор — что удобнее агенту;
     • если элемент не найден, инструмент НЕ молчит, а возвращает похожие
       элементы с их ref — следующий шаг делается без угадывания.

   Браузер запускается лениво — только при первом вызове инструмента.
   Приоритет движков (чтобы ничего не качать на Windows):
     1) системный Edge  (channel: "msedge") — есть почти на каждом Windows;
     2) системный Chrome (channel: "chrome");
     3) Chromium из playwright — если бинарь не установлен, скачивается
        автоматически один раз (npx playwright install chromium).

   Все функции возвращают строки для агента (как остальные инструменты)
   и НЕ бросают исключений наружу — ошибки превращаются в текст ответа.
   Модуль не требует playwright на этапе require (ленивая загрузка),
   поэтому работает и там, где пакет ещё не установлен (node --check и т.п.).
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dom = require("./dom-map.js"); // карта интерфейса: роли, имена, ref, подсказки
const { collectInPage, evalValueToPlain, unwrapEvalValue, varValueInPage, describeVar, cleanupInPage, acceptTermsInPage, scrollStateInPage, scrollPageInPage, scrollInnerInPage, hoverInPage, idleStartInPage, idleTakeInPage, idleStopInPage, fetchJsonInPage, itemsKeyInPage, scrollItemIntoViewInPage } = require("./browser-inpage.js"); // функции, исполняемые в странице
const browserNet = require("./browser-net.js"); // сеть вкладки и ожидание покоя
const browserReplay = require("./browser-replay.js"); // replay и работа с формами
const browserMap = require("./browser-map.js"); // карта страницы и поиск элементов
const browserScroll = require("./browser-scroll.js"); // прокрутка, наведение и ленивая догрузка
// netRecorder нужен replay и ядру, поэтому объявляем его ДО подключения мостов.
const { netRecorder, network, waitForIdle } = browserNet;
browserNet.setBrowserNetDeps({ needTab, sleep }); // вкладка сессии и общий помощник — мостом
browserReplay.setBrowserReplayDeps({ needTab, netRecorder }); // разбор живого состояния — мостом
browserMap.setBrowserMapDeps({ sleep }); // общий помощник живёт в ядре — мостом
const { overlayKind, OVERLAY_LABEL, overlayItems, collectMap, cssOrTextLocator, firstUsable, CLICK_ROLES, FIELD_ROLES, clickCandidates, fieldCandidates, readScrollY, frameList, frameLabel, visibleNow, resolveTarget, suggestQuery, missText } = browserMap;
const { posLine, revealText, namesOnPage, queryFromSpec, wheelAt, lazyKeyOf, loadAllScroll, scroll, hover } = browserScroll;
const { maskForm, parseForm, buildForm, pickPath, findItemsPath, findTotalPath, findCursorPath, findCursorParam, keyOfItem, replayFindSample, replay } = browserReplay;

let pw = null; // модуль playwright (лениво)
let browser = null; // Browser (обычный запуск) ИЛИ BrowserContext (постоянный профиль)
let sessionClosed = false; // для BrowserContext: пришло событие "close" — сессия мертва
let profileDir = ""; // папка постоянного профиля (пусто — сессии не сохраняются)
let runningProfileDir = null; // папка профиля, с которой запущена текущая сессия
let tabs = new Map(); // tabId -> { id, page, openedAt }
let tabSeq = 0;
let activeTabId = null;
let installPromise = null; // один инсталлятор на всё время жизни процесса
let engineName = "";

// ── Свой Chrome по CDP ────────────────────────────────────────────────────
// Playwright даёт быстрые и точные инструменты (клик/ввод/карта страницы), но в
// СВОЁМ окне Chromium. Чтобы работать в браузере пользователя (его входы в ВК,
// почту и т.д.), приложение подключается к Chrome с включённым портом отладки —
// тогда browserClick/browserFill действуют в его вкладках с его сессиями.
let connectEnabled = false; // настройка «работать в своём Chrome»
let connectPort = 9222; // порт отладки
let connectDataDir = ""; // отдельный профиль для запуска Chrome с отладкой
let cdpActive = false; // текущая сессия получена по CDP
let cdpContext = null; // контекст браузера пользователя (для новых вкладок)
let runningModeKey = null; // режим+профиль текущей сессии (см. modeKey)

const ACTION_TIMEOUT = 12000;
// Мост прокрутки ставим ПОСЛЕ объявления ACTION_TIMEOUT: ссылка на const выше него —
// это мёртвая зона и падение при загрузке (часть 39, заход 3 — так уже было).
browserScroll.setBrowserScrollDeps({ needTab, sleep, waitUntil, boxOf, ACTION_TIMEOUT });
// Сколько ждём появления элемента и как часто опрашиваем — живёт в browser-map.js
// вместе с resolveTarget, который единственный этим пользуется.

// Только для тестов: подставляет заглушку playwright (реальный браузер не запускается)
// или сбрасывает кэш (null), чтобы следующий вызов взял свежий модуль.
function setPlaywright(mock) {
  pw = mock || null;
  return pw;
}

function loadPlaywright() {
  if (pw) return pw;
  try {
    // eslint-disable-next-line global-require
    pw = require("playwright");
    return pw;
  } catch (e) {
    pw = null;
    throw new Error(
      "Библиотека playwright не найдена. Установи её: npm install playwright" +
        (e && e.message ? " (" + e.message.slice(0, 120) + ")" : "")
    );
  }
}

// Находит cli.js playwright-core: через require.resolve (в собранном приложении
// electron-builder с asarUnpack отдаёт реальный путь из app.asar.unpacked).
function findPlaywrightCli() {
  const cands = [];
  try { cands.push(require.resolve("playwright-core/cli.js")); } catch {}
  try {
    const pkg = require.resolve("playwright-core/package.json");
    cands.push(path.join(path.dirname(pkg), "cli.js"));
  } catch {}
  try { cands.push(require.resolve("playwright/cli.js")); } catch {}
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Скачивание Chromium (один раз на процесс). Запускаем cli.js самим процессом
// (process.execPath с ELECTRON_RUN_AS_NODE=1) — это работает и в dev, и в собранном
// приложении, и не требует установленного node/npx в PATH пользователя.
function installChromium() {
  if (installPromise) return installPromise;
  installPromise = new Promise((resolve) => {
    const cli = findPlaywrightCli();
    const useOwnNode = !!(cli && process.execPath);
    const cmd = useOwnNode
      ? '"' + process.execPath + '" "' + cli + '" install chromium'
      : "npx playwright install chromium";
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    const env = useOwnNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
    let out = "";
    const child = spawn(shell, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim().slice(-2500) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message || String(e) });
    });
  });
  return installPromise;
}

// ── Постоянный профиль браузера ───────────────────────────────────────────
// Папка задаётся из main.js (userData/browser-profile). Внутри неё Chromium
// хранит куки, localStorage и авторизации — поэтому вход в ВК и на сайты
// переживает закрытие и перезапуск приложения. Пустая строка — как раньше
// (чистый профиль на каждый запуск).
function setProfileDir(dir) {
  profileDir = dir ? String(dir) : "";
  return profileDir;
}

function profilePath() {
  return profileDir;
}

// Настройки режима «свой Chrome»: включает main.js из настроек приложения.
function setConnectMode(cfg) {
  const c = cfg || {};
  connectEnabled = c.enabled === true;
  const p = parseInt(c.port, 10);
  connectPort = p >= 1024 && p <= 65535 ? p : 9222;
  connectDataDir = c.dataDir ? String(c.dataDir) : "";
  return { enabled: connectEnabled, port: connectPort, dir: connectDataDir };
}

function connectInfo() {
  return { enabled: connectEnabled, port: connectPort, dataDir: connectDataDir, active: cdpActive };
}

// Ключ режима: смена режима или профиля означает «нужна новая сессия».
function modeKey() {
  return connectEnabled ? "cdp:" + connectPort + ":" + connectDataDir : "launch:" + profileDir;
}

function profileNote() {
  const head = cdpActive
    ? "\nРежим: СВОЙ Chrome по CDP (:" + connectPort + ") — используются твои вкладки и входы на сайты."
    : "";
  return head + (profileDir
    ? "\nПрофиль: постоянный — куки и входы на сайтах сохраняются между запусками."
    : "\nПрофиль: временный — при закрытии браузера сессии и входы теряются.");
}

// ── CDP: подключение к своему Chrome ──────────────────────────────────────
function cdpEndpoint(port) {
  return "http://127.0.0.1:" + (parseInt(port, 10) || connectPort || 9222);
}

// Ждёт, пока порт отладки откроется (Chrome стартует 1–3 секунды).
async function cdpReady(endpoint, timeoutMs) {
  const deadline = Date.now() + (timeoutMs == null ? 700 : timeoutMs);
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 900);
      const res = await fetch(endpoint + "/json/version", { signal: ctrl.signal });
      clearTimeout(timer);
      if (res && res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.Browser) return j;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// Установленные Chrome / Edge / Chromium — в порядке предпочтения.
function chromeCandidates() {
  const out = [];
  const push = (name, p) => { if (p) out.push({ name, path: p }); };
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const la = process.env.LOCALAPPDATA || "";
    push("chrome", path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    push("chrome", path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    push("chrome", la ? path.join(la, "Google", "Chrome", "Application", "chrome.exe") : "");
    push("edge", path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    push("edge", path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    push("chromium", la ? path.join(la, "Chromium", "Application", "chrome.exe") : "");
  } else if (process.platform === "darwin") {
    push("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    push("edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    push("chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    push("chrome", "/usr/bin/google-chrome");
    push("chrome", "/usr/bin/google-chrome-stable");
    push("chromium", "/usr/bin/chromium");
    push("chromium", "/usr/bin/chromium-browser");
    push("edge", "/usr/bin/microsoft-edge");
  }
  return out.filter((c) => {
    try { return fs.existsSync(c.path); } catch { return false; }
  });
}

function findChromeExe(which) {
  const list = chromeCandidates();
  if (which) {
    const hit = list.find((c) => c.name === which);
    return hit ? hit.path : "";
  }
  return list.length ? list[0].path : "";
}

// Запускает установленный Chrome/Edge с портом отладки. Отдельный профиль нужен
// обязательно: с Chrome 136+ порт отладки НЕ работает со стандартной папкой
// профиля (защита от кражи куки). В этом профиле и сохраняются входы на сайты.
function launchDebugChrome(port, dataDir, which) {
  const exe = findChromeExe(String(which || "").trim().toLowerCase());
  if (!exe) return { ok: false, error: "Не нашёл установленный Chrome или Edge — установи Google Chrome и повтори." };
  const dir = dataDir || path.join(os.tmpdir(), "ai-agent-chrome-cdp");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const args = [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + dir,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
  ];
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, exe, dir };
}

// Что делать, если подключиться не удалось.
function cdpHowTo(port) {
  const p = parseInt(port, 10) || connectPort || 9222;
  const run =
    process.platform === "win32"
      ? '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=' + p + ' --user-data-dir="%LOCALAPPDATA%\\chrome-debug"'
      : 'google-chrome --remote-debugging-port=' + p + ' --user-data-dir="$HOME/chrome-debug"';
  return (
    "Как подключиться к своему Chrome:\n" +
    "  1) Закрой Chrome полностью — запущенный Chrome порт отладки не откроет.\n" +
    "  2) Запусти: " + run + "\n" +
    "  3) Войди на нужные сайты (ВК, почта) — дальше агент работает в этих же вкладках.\n" +
    "Важно: с Chrome 136+ порт отладки не работает со стандартным профилем (защита от кражи куки) — нужен отдельный --user-data-dir.\n" +
    "Проще всего: Настройки → 🌐 Браузер агента → «Подключиться к моему Chrome» — приложение само запустит Chrome со своим профилем, и входы в нём сохранятся."
  );
}

// Вкладки текущего браузера: в режиме CDP — вкладки пользователя (его контекст).
function listPages() {
  try {
    if (cdpActive && cdpContext) return cdpContext.pages();
    if (browser && typeof browser.pages === "function") {
      const r = browser.pages();
      // ВАЖНО: у BrowserContext pages() синхронный (массив), у Browser — Promise.
      // Раньше промис возвращался как «список» (length === undefined), и всё,
      // что по нему итерируется, падало с «pages is not iterable».
      return Array.isArray(r) ? r : [];
    }
  } catch {}
  return [];
}

// Тот же список, но с ожиданием (для подхвата вкладок, открытых кликом).
async function allPages() {
  try {
    if (cdpActive && cdpContext) return cdpContext.pages() || [];
    if (browser && typeof browser.pages === "function") {
      const r = browser.pages();
      return Array.isArray(r) ? r : (await r) || [];
    }
  } catch {}
  return [];
}

// Новая вкладка. В режиме CDP — в контексте пользователя, иначе вкладка была бы
// без его куки и входов (новый контекст = чистый профиль).
async function newPageInBrowser() {
  if (cdpActive && cdpContext) {
    try { return await cdpContext.newPage(); } catch {}
  }
  return await browser.newPage();
}

// Подхватывает УЖЕ открытые вкладки пользователя (ВК, почта, кабинеты), чтобы
// агент работал в них, а не открывал новые «пустые». Помечены adopted — их агент
// не закрывает.
function adoptExistingPages() {
  const names = [];
  for (const p of listPages()) {
    if (tabs.size >= 25) break;
    let url = "";
    try { url = p.url() || ""; } catch { continue; }
    if (!/^https?:/i.test(url)) continue;
    const tabId = "tab" + (++tabSeq);
    tabs.set(tabId, { id: tabId, page: p, openedAt: Date.now(), adopted: true });
    netRecorder(p); // журнал сети ведём с открытия вкладки: replay ищет в нём образец запроса
    if (!activeTabId) activeTabId = tabId;
    try {
      p.on("close", () => {
        if (tabs.has(tabId)) {
          tabs.delete(tabId);
          if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
        }
      });
    } catch {}
    names.push(tabId + "  " + url.slice(0, 90));
  }
  return names;
}

// Сколько вкладок сейчас открыто (без создания).
async function pageCount() {
  return (await allPages()).length;
}

// Подхватить вкладки, появившиеся ПОСЛЕ действия (ссылка с target=_blank,
// window.open, платёжный виджет). Без этого агент остаётся в старой вкладке и
// решает, что «клик ничего не сделал».
async function adoptNewPages(before) {
  const opened = [];
  const pages = await allPages();
  if (pages.length <= before) return opened;
  for (const p of pages) {
    let url = "";
    try { url = p.url() || ""; } catch { continue; }
    let known = false;
    for (const tb of tabs.values()) if (tb.page === p) { known = true; break; }
    if (known || !/^https?:/i.test(url)) continue;
    if (tabs.size >= 25) break;
    const tabId = "tab" + (++tabSeq);
    tabs.set(tabId, { id: tabId, page: p, openedAt: Date.now(), adopted: !!cdpActive });
    netRecorder(p);
    activeTabId = tabId;
    try {
      p.on("close", () => {
        if (tabs.has(tabId)) {
          tabs.delete(tabId);
          if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
        }
      });
    } catch {}
    opened.push(tabId + "  " + url.slice(0, 90));
  }
  return opened;
}

// Подключение к своему Chrome: сначала пробуем уже запущенный с отладкой, иначе
// запускаем Chrome сами и ждём порт.
async function attachCdp(opts) {
  const o = opts || {};
  const port = parseInt(o.port, 10) || connectPort || 9222;
  const endpoint = cdpEndpoint(port);
  const { chromium } = loadPlaywright();
  let info = await cdpReady(endpoint, o.waitMs == null ? 700 : o.waitMs);
  let launched = "";
  if (!info && o.launch !== false) {
    const r = launchDebugChrome(port, connectDataDir, o.browser);
    if (!r.ok) return { ok: false, message: "Не удалось запустить Chrome: " + r.error + "\n\n" + cdpHowTo(port) };
    launched = "Запустил Chrome с отладкой:\n  " + r.exe + "\n  профиль: " + r.dir;
    info = await cdpReady(endpoint, 20000);
    if (!info) {
      return {
        ok: false,
        message:
          launched +
          "\n\nПорт " + port + " не открылся за 20 с. Обычно причина одна: Chrome уже запущен — закрой ВСЕ его окна и повтори.\n\n" +
          cdpHowTo(port),
      };
    }
  }
  if (!info) {
    return { ok: false, message: "На " + endpoint + " никто не слушает (Chrome с отладкой не запущен).\n\n" + cdpHowTo(port) };
  }
  if (sessionAlive()) await stop();
  let b;
  try {
    b = await chromium.connectOverCDP(endpoint);
  } catch (e) {
    return {
      ok: false,
      message: "Не удалось подключиться к " + endpoint + ": " + String((e && e.message) || e).slice(0, 200) + "\n\n" + cdpHowTo(port),
    };
  }
  browser = b;
  cdpActive = true;
  sessionClosed = false;
  connectPort = port; // работаем на том порту, с которым реально соединились
  runningProfileDir = profileDir;
  engineName = "Свой Chrome (CDP :" + port + ")";
  try { cdpContext = (b.contexts() || [])[0] || null; } catch { cdpContext = null; }
  wireBrowser();
  const adopted = adoptExistingPages();
  return { ok: true, port, launched, adopted, browserName: (info && info.Browser) || "", endpoint };
}

// Инструмент агента: подключиться к своему Chrome (и открыть url, если задан).
async function connect(args) {
  args = args || {};
  const r = await attachCdp({ port: args.port, launch: args.launch !== false, browser: args.browser });
  if (!r.ok) return "Ошибка browserConnect:\n" + r.message;
  const lines = [
    "OK — подключился к твоему Chrome по CDP: " + r.endpoint + (r.browserName ? " (" + r.browserName + ")" : ""),
  ];
  if (r.launched) lines.push(r.launched);
  if (r.adopted && r.adopted.length) {
    lines.push("Твои открытые вкладки подхвачены (" + r.adopted.length + "):");
    lines.push(...r.adopted.slice(0, 15).map((x) => "  " + x));
    lines.push("Работаю в этих вкладках — твои входы на сайты на месте. Твои вкладки я не закрываю.");
  } else {
    lines.push("Открытых вкладок с сайтами не нашёл — открой страницу через browserOpen (url) или скажи, что сделать.");
  }
  lines.push('Дальше: browserSnapshot — карта кнопок и полей. Отключиться: browserClose (tabId: "all") — твой Chrome продолжит работать.');
  const url = String(args.url || "").trim();
  if (/^https?:\/\//i.test(url)) {
    const opened = await open({ url, newTab: args.newTab !== false });
    lines.push("", opened);
  }
  return lines.join("\n");
}

// Жива ли текущая сессия: у Browser есть isConnected(), у BrowserContext — нет
// (для него признак — не пришло событие "close", см. wireBrowser).
function sessionAlive() {
  if (!browser || sessionClosed) return false;
  try {
    if (typeof browser.isConnected === "function") return browser.isConnected();
  } catch {
    return false;
  }
  return true;
}

// Запуск движка: с папкой профиля — launchPersistentContext, без неё — обычный launch.
async function launchEngine(chromium, name, opts) {
  // Следы автоматизации, которые мешают входу на сайты с жёсткими проверками
  // (Google, банки): плашка «управляется автоматизированным ПО», флаг
  // --enable-automation и navigator.webdriver = true. Это документированные
  // опции Playwright — мы лишь не афишируем автоматизацию, пароли и входы
  // по-прежнему вводит сам пользователь. Защиты сайтов не обходятся.
  const args = ["--start-maximized", "--disable-infobars", "--disable-blink-features=AutomationControlled"];
  const base = {
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    ...opts,
    args,
  };
  if (profileDir) {
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
    const ctx = await chromium.launchPersistentContext(profileDir, base);
    return { ok: true, browser: ctx, engine: name + " · постоянный профиль", persistent: true };
  }
  const b = await chromium.launch(base);
  return { ok: true, browser: b, engine: name, persistent: false };
}

// Запуск браузера: системный Edge → Chrome → свой Chromium (с авто-установкой).
async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const attempts = [
    { name: "Edge (системный)", opts: { channel: "msedge" } },
    { name: "Chrome (системный)", opts: { channel: "chrome" } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      return await launchEngine(chromium, a.name, a.opts);
    } catch (e) {
      lastErr = e;
    }
  }
  // Свой Chromium из playwright: сначала проверяем, установлен ли бинарь.
  let execPath = "";
  try { execPath = chromium.executablePath() || ""; } catch {}
  const needInstall = execPath && !fs.existsSync(execPath);
  if (needInstall) return { needInstall: true, message: "Chromium (playwright) не установлен — скачиваю…" };
  try {
    return await launchEngine(chromium, "Chromium (playwright)", {});
  } catch (e) {
    lastErr = e;
  }
  return { ok: false, error: (lastErr && lastErr.message) || "Не удалось запустить браузер" };
}

// Гарантирует запущенный браузер: возвращает { ok:true } либо сообщение об ошибке.
// Никогда не бросает исключений наружу — все ошибки превращаются в текст для агента.
async function ensureBrowser() {
  try {
    return await ensureBrowserInner();
  } catch (e) {
    return { ok: false, message: "Ошибка браузера: " + ((e && e.message) || String(e)).slice(0, 300) };
  }
}

async function ensureBrowserInner() {
  if (sessionAlive()) {
    // Режим (свой Chrome по CDP или собственный Chromium) и профиль не менялись —
    // работаем в текущей сессии.
    if (runningModeKey === modeKey()) return { ok: true };
    // Режим или профиль сменили — перезапускаем, чтобы применилось сразу.
    await stop();
  }
  // Режим «свой Chrome»: подключаемся по CDP (если Chrome не запущен с отладкой —
  // запускаем его сами со своим профилем).
  if (connectEnabled) {
    const c = await attachCdp({ port: connectPort, launch: true });
    return c.ok ? { ok: true } : { ok: false, message: c.message };
  }
  const r = await launchBrowser();
  if (r.needInstall) {
    const inst = await installChromium();
    if (!inst.ok) {
      return {
        ok: false,
        message:
          "Не удалось установить Chromium автоматически. Сделай это вручную один раз:\n" +
          "  npm install playwright && npx playwright install chromium\n" +
          "Затем повтори вызов. Лог установки:\n" +
          (inst.out || "нет вывода"),
      };
    }
    const r2 = await launchBrowser();
    if (!r2.ok) return { ok: false, message: r2.error || "Chromium установлен, но не запустился." };
    browser = r2.browser;
    engineName = r2.engine;
    runningProfileDir = profileDir;
    wireBrowser();
    return { ok: true };
  }
  if (!r.ok) return { ok: false, message: r.error || "Не удалось запустить браузер" };
  browser = r.browser;
  engineName = r.engine;
  runningProfileDir = profileDir;
  wireBrowser();
  return { ok: true };
}

function wireBrowser() {
  sessionClosed = false;
  runningModeKey = modeKey();
  const reset = () => {
    tabs.clear();
    activeTabId = null;
    browser = null;
    sessionClosed = true;
  };
  try {
    // У Browser событие "disconnected", у BrowserContext (постоянный профиль) — "close".
    const evt = typeof browser.isConnected === "function" ? "disconnected" : "close";
    browser.on(evt, reset);
  } catch {}
}

function resolveTab(tabId) {
  if (tabId && tabs.has(String(tabId))) return tabs.get(String(tabId));
  if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
  return null;
}

function needTab(tabId) {
  // Сеть вкладки копим с первого инструмента: агент спрашивает её ПОСЛЕ действия.
  try { const t0 = activeTabId ? tabs.get(tabId || activeTabId) : null; if (t0 && t0.page && t0.page.on) netRecorder(t0.page); } catch (e) {}
  if (!sessionAlive()) {
    return { error: "Браузер не запущен. Сначала вызови browserOpen (url)." };
  }
  const tab = resolveTab(tabId);
  if (!tab) {
    return { error: "Вкладка не найдена: " + (tabId || activeTabId || "—") + ". Открой страницу через browserOpen (url)." };
  }
  return { tab };
}

async function pageInfo(page) {
  let url = "";
  let title = "";
  try { url = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  return { url, title };
}

async function afterNavigation(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Ждать УСЛОВИЕ (а не «слепую» паузу) с опросом и жёстким потолком: как только
// страница готова — идём дальше сразу, а на медленном сайте ждём до потолка.
// Это и быстрее (обычно 60-150 мс вместо фиксированных 200-400), и надёжнее
// (не действуем по недорисованной странице).
async function waitUntil(fn, timeoutMs, pollMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  const step = Math.max(30, pollMs || 60);
  for (;;) {
    let ok = false;
    try {
      ok = await fn();
    } catch (e) {
      ok = false;
    }
    if (ok) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(step, left));
  }
}

// ── Составное действие: несколько шагов одной командой ────────────────────
// Зачем: слабая или быстрая модель тратит ходы на каждый шаг (клик → карта →
// ввод → Enter → проверка) и на этом «застревает». Здесь вся цепочка идёт одним
// вызовом: мы сами ждём появления элементов и останавливаемся на первом сбое.
// Шаги (любая форма, см. normalizeStep):
//   { "click": "Войти" } · { "ref": "e2" } · { "click": { "ref": "e2" } }
//   { "fill": { "ref": "e4", "text": "…" }, "submit": true }
//   { "fill": "привет", "ref": "e9" } · { "field": "Почта", "text": "a@b.c" }
//   { "press": "Enter" } · { "key": "Escape" }
//   { "wait": 800 } · { "waitFor": "Готово" }
//   { "scroll": "down", "times": 3 } · { "eval": "document.title" }
//   { "read": true } · { "snapshot": true }
function stepQuery(s) {
  const q = {};
  for (const k of ["ref", "selector", "css", "role", "name", "label", "placeholder", "field", "text"]) {
    if (s[k] != null) q[k] = s[k];
  }
  return q;
}

function normalizeStep(raw) {
  if (typeof raw === "string") {
    const t = String(raw).trim();
    if (!t) return null;
    // Строка-шаг: «Enter»/«Escape» — это клавиша, «goto https://…»/URL — переход,
    // остальное — клик по видимому тексту (модели шлют и массив строк).
    if (/^(enter|escape|esc|tab|pagedown|pageup|space|arrowup|arrowdown|arrowleft|arrowright)$/i.test(t)) {
      return { kind: "press", args: { key: t }, label: "клавиша " + t };
    }
    if (/^goto\s+/i.test(t) || /^https?:\/\//i.test(t)) {
      return { kind: "open", args: { url: t.replace(/^goto\s+/i, "") }, label: "открыть " + t.slice(0, 60) };
    }
    return { kind: "click", args: { name: t }, label: "клик по «" + t.slice(0, 40) + "»" };
  }
  const s = raw && typeof raw === "object" ? raw : null;
  if (!s) return null;
  const q = stepQuery(s);
  const code = s.eval != null ? s.eval : s.js != null ? s.js : s.script != null ? s.script : null;
  if (code != null) return { kind: "eval", args: { script: code }, label: "JS на странице" };
  const link = s.goto != null ? s.goto : s.open != null ? s.open : s.navigate != null ? s.navigate : null;
  if (typeof link === "string" && link) {
    return { kind: "open", args: { url: link, newTab: s.newTab }, label: "открыть " + link.slice(0, 60) };
  }
  if (s.back === true || s.goBack === true || s.previous === true) {
    return { kind: "back", args: {}, label: "назад по истории" };
  }
  if (typeof s.press === "string" && s.press) return { kind: "press", args: { key: s.press, waitLoad: s.waitLoad }, label: "клавиша " + s.press };
  if (typeof s.key === "string" && s.key) return { kind: "press", args: { key: s.key, waitLoad: s.waitLoad }, label: "клавиша " + s.key };
  if (s.enter === true) return { kind: "press", args: { key: "Enter", waitLoad: s.waitLoad }, label: "клавиша Enter" };
  if (s.waitFor != null || s.forText != null) {
    const w = s.waitFor != null ? s.waitFor : s.forText;
    const wargs = typeof w === "string" ? Object.assign({}, q, { name: w }) : Object.assign({}, q, w || {});
    return { kind: "wait", args: wargs, label: "ждать появление «" + String(w && typeof w === "string" ? w : wargs.name || "").slice(0, 40) + "»" };
  }
  const pause = s.wait != null ? s.wait : s.ms != null ? s.ms : s.sleep;
  if (pause != null && !isNaN(parseInt(pause, 10))) {
    const n = Math.min(Math.max(parseInt(pause, 10), 0), 60000);
    return { kind: "pause", args: { ms: n }, label: "пауза " + n + " мс" };
  }
  if (s.scroll != null) {
    return { kind: "scroll", args: { how: s.scroll, times: s.times }, label: "прокрутка (" + String(s.scroll) + ")" };
  }
  if (s.read === true || (s.text === true && !q.ref)) {
    return { kind: "text", args: { max: s.max }, label: "текст страницы" };
  }
  if (s.snapshot != null) {
    const sn = s.snapshot && typeof s.snapshot === "object" ? s.snapshot : {};
    return { kind: "snapshot", args: sn, label: "карта страницы" };
  }
  // Значение для ввода: {"fill":"текст"} · {"fill":{...}} · {"type":"текст"} ·
  // {"field":"Почта","text":"…"} — последний вариант слабые модели пишут чаще всего.
  const val =
    s.fill != null
      ? s.fill
      : s.type != null
      ? s.type
      : s.field != null && s.text != null
      ? s.text
      : s.field != null && s.value != null
      ? s.value
      : null;
  if (val != null || s.field != null) {
    const fargs = Object.assign({}, q);
    if (typeof val === "string" || typeof val === "number") fargs.text = String(val);
    else if (val && typeof val === "object") Object.assign(fargs, val);
    if (s.submit != null) fargs.submit = s.submit;
    return {
      kind: "fill",
      args: fargs,
      label: "ввод" + (fargs.text != null ? " «" + String(fargs.text).slice(0, 30) + "»" : "") + (fargs.submit ? " + Enter" : ""),
    };
  }
  if (s.click != null || dom.hasQuery(dom.parseQuery(q))) {
    const cargs = Object.assign({}, q);
    if (typeof s.click === "string") cargs.name = s.click;
    else if (s.click && typeof s.click === "object") Object.assign(cargs, s.click);
    if (s.waitLoad != null) cargs.waitLoad = s.waitLoad;
    return {
      kind: "click",
      args: cargs,
      label: "клик по " + (cargs.name || cargs.ref || cargs.selector || "элементу"),
    };
  }
  return null;
}

// Прокрутка страницы: ленивые списки (ВК, бесконечные ленты) не отдают элементы,
// пока их не подгрузят скроллом.
async function scrollPage(page, a) {
  const how = String(a.how == null ? "down" : a.how).toLowerCase();
  const times = Math.max(1, Math.min(parseInt(a.times, 10) || 1, 10));
  for (let i = 0; i < times; i++) {
    let key = "PageDown";
    if (how === "up" || how === "вверх") key = "PageUp";
    else if (how === "top" || how === "начало") key = "Home";
    else if (how === "bottom" || how === "низ") key = "End";
    const beforeY = await readScrollY(page);
    try {
      await page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
    } catch (e) {
      return "Ошибка browserAct (прокрутка): " + String((e && e.message) || e).slice(0, 150);
    }
    await waitUntil(async () => (await readScrollY(page)) !== beforeY, 220, 50);
    await sleep(70);
  }
  await afterNavigation(page);
  return "OK — прокрутка " + how + (times > 1 ? " ×" + times : "");
}

async function goBackStep(page) {
  try {
    const r = await page.goBack({ timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" });
    if (!r) return "Ошибка browserAct (назад): история переходов пуста";
  } catch (e) {
    return "Ошибка browserAct (назад): " + String((e && e.message) || e).slice(0, 150);
  }
  const pi = await pageInfo(page);
  return "OK — вернулся назад. URL: " + (pi.url || "—");
}

// Единый список отказов набора: им пользуются browserAct (остановка цепочки),
// browserOpen и vaultFill. Отказом считается не только «Ошибка …»: без запущенного
// браузера набор отвечает «Браузер не запущен…», и раньше такой отказ выглядел успехом.
function isBrowserFailure(res) {
  return /^(Ошибка|Не нашёл|Браузер не запущен|Вкладка не найдена|browserDOM:)/.test(String(res || ""));
}

// Несколько шагов одной командой. Первый сбой останавливает цепочку
// (stopOnError: false — продолжать), в ответе видно, что сработало, а что нет.
async function act(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let steps = args.steps || args.actions || args.script || args.step || args.commands || args.pipeline;
  if (typeof steps === "string") {
    try { steps = JSON.parse(steps); } catch { steps = null; }
  }
  // Один шаг без массива — тоже шаг: модель регулярно присылает объект вместо [объект],
  // и раньше это стоило целого хода («вызов упал»).
  if (steps && typeof steps === "object" && !Array.isArray(steps)) steps = [steps];
  if (Array.isArray(steps)) {
    steps = steps.filter((s) => s != null && (typeof s === "object" || typeof s === "string"));
  }
  if (!Array.isArray(steps) || !steps.length) {
    const saw = Object.keys(args).filter((k) => k !== "tabId" && k !== "tab");
    return (
      "Ошибка browserAct: укажи steps — массив шагов" +
      (saw.length ? " (получено: " + saw.join(", ") + ")" : "") + ". Пример:\n" +
      'browserAct { steps: [{ "click": "Войти" }, { "field": "Почта", "text": "a@b.c" }, ' +
      '{ "fill": "•••", "ref": "e5", "submit": true }, { "read": true }] }\n' +
      "Шаги: goto (открыть адрес), click, fill (+submit), press, wait (мс), waitFor (текст), back, scroll, eval, read, snapshot."
    );
  }
  const list = steps.slice(0, 20);
  const stopOnError = args.stopOnError !== false;
  const page = t.tab.page;
  const rows = [];
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    const st = normalizeStep(list[i]);
    const num = i + 1;
    if (!st) {
      failed++;
      rows.push(num + ". ❌ шаг не понял: " + JSON.stringify(list[i]).slice(0, 140));
      if (stopOnError) break;
      continue;
    }
    const a = Object.assign({}, st.args, { tabId: t.tab.id, waitLoad: args.waitLoad });
    let res = "";
    if (st.kind === "click") res = await click(a);
    else if (st.kind === "fill") res = await fill(a);
    else if (st.kind === "press") res = await press(a);
    else if (st.kind === "wait") res = await wait(a);
    else if (st.kind === "pause") res = await wait({ tabId: t.tab.id, ms: a.ms, load: a.load });
    else if (st.kind === "eval") res = await evalJs(a);
    else if (st.kind === "text") res = await text(a);
    else if (st.kind === "snapshot") res = await snapshot(a);
    else if (st.kind === "scroll") res = await scrollPage(page, a);
    else if (st.kind === "open") res = await open(a);
    else if (st.kind === "back") res = await goBackStep(page);
    const bad = isBrowserFailure(res);
    if (bad) failed++;
    const one = String(res || "").replace(/\s+/g, " ").trim().slice(0, 220);
    rows.push(num + ". " + (bad ? "❌ " : "✅ ") + st.label + " — " + (one || "(без ответа)"));
    if (bad && stopOnError) break;
    if (args.stepDelayMs) await sleep(Math.min(Math.max(parseInt(args.stepDelayMs, 10) || 0, 0), 5000));
  }
  const info = await pageInfo(page);
  const done = rows.filter((r) => r.indexOf("✅") > 0).length;
  const out = [
    "browserAct: шагов " + rows.length + " из " + list.length + ", ок: " + done + (failed ? ", сбоев: " + failed : ""),
    ...rows,
    "URL: " + (info.url || "—") + (info.title ? " («" + info.title + "»)" : ""),
  ];
  if (failed) {
    out.push("Дальше: поправь шаг и вызови browserAct снова одним вызовом (похожие элементы и ref — browserSnapshot).");
  }
  return out.join("\n");
}

// ── Инструменты ────────────────────────────────────────────────────────────

// Открыть страницу в новой (или активной) вкладке. Возвращает id вкладки.
async function open(args) {
  args = args || {};
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL, например https://example.com";
  const r = await ensureBrowser();
  if (!r.ok) return r.message;
  let page = null;
  if (!args.newTab && activeTabId) {
    const cur = tabs.get(activeTabId);
    if (cur) page = cur.page;
  }
  if (!page) {
    // Постоянный профиль (и свой Chrome по CDP) стартует с пустой вкладки —
    // используем её, а не плодим новую.
    try {
      if (!tabs.size) {
        const pages = listPages();
        if (pages.length === 1 && pages[0].url() === "about:blank") page = pages[0];
      }
    } catch {}
  }
  if (!page) page = await newPageInBrowser();
  const tabId = "tab" + (++tabSeq);
  tabs.set(tabId, { id: tabId, page, openedAt: Date.now() });
  netRecorder(page);
  activeTabId = tabId;
  page.on("close", () => {
    if (tabs.has(tabId)) {
      tabs.delete(tabId);
      if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
    }
  });
  let navErr = "";
  try {
    await page.goto(url, {
      waitUntil: args.waitUntil === "load" ? "load" : "domcontentloaded",
      timeout: 30000,
    });
  } catch (e) {
    navErr = (e && e.message ? e.message : String(e)).slice(0, 300);
  }
  const info = await pageInfo(page);
  let out =
    "Вкладка " + tabId + " открыта (движок: " + engineName + ")\n" +
    "URL: " + (info.url || url) + "\n" +
    "Заголовок: " + (info.title || "—");
  if (navErr && !/net::ERR_NAME_NOT_RESOLVED|timeout/i.test(navErr)) out += "\nЗамечание: " + navErr;
  return out;
}

// Заполнить текстовое поле. Поле можно указать как угодно: ref из browserSnapshot
// (самый надёжный), label/placeholder/name (подпись или подсказка поля), role+name
// или selector (CSS, text=…, xpath=…).
// Поддержка contenteditable (ВК и другие SPA): если fill не сработал —
// клик по полю → очистка (Ctrl+A) → вставка через insertText, которая корректно
// триггерит события ввода в кастомных редакторах.
async function fill(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const text = String(args.text == null ? "" : args.text);
  // field — понятный человеку синоним подписи/имени поля (модели часто пишут именно так).
  const fargs =
    args.field != null && args.label == null && args.name == null
      ? Object.assign({}, args, { name: args.field })
      : args;
  const q = dom.parseQuery(fargs, { forField: true });
  if (!dom.hasQuery(q)) {
    return "Ошибка browserFill: укажи поле — ref из browserSnapshot (ref: \"e4\"), label/placeholder/name (видимая подпись) или selector (CSS / text= / xpath=).";
  }
  const findStart = Date.now();
  const found = await resolveTarget(t.tab.page, q, "field", { timeout: args.timeout });
  if (!found) {
    return missText(
      t.tab.page,
      "browserFill",
      q,
      "поле не найдено (ждал " + Math.round((Date.now() - findStart) / 1000) + " с)"
    );
  }
  const target = found;
  let via = "fill";
  try {
    await target.loc.fill(text, { timeout: ACTION_TIMEOUT });
  } catch (e1) {
    const firstErr = (e1 && e1.message) || String(e1);
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.insertText(text, { timeout: ACTION_TIMEOUT });
      via = "insertText";
    } catch (e2) {
      return missText(t.tab.page, "browserFill", q, ((e2 && e2.message) || firstErr || "").slice(0, 160));
    }
  }
  // submit: true — сразу отправить (Enter). Обычный случай: поиск, вход, сообщение.
  // Так агент делает «ввёл и отправил» одним вызовом, без отдельного browserPress.
  let sent = "";
  if (args.submit) {
    const key = typeof args.submit === "string" ? args.submit : "Enter";
    try {
      await t.tab.page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
      sent = "; отправлено (" + key + ")";
      if (args.waitLoad !== false) await afterNavigation(t.tab.page);
    } catch (e3) {
      sent = "; но отправить не удалось (" + String((e3 && e3.message) || e3).slice(0, 120) + ")";
    }
  }
  // Страницу показываем только после отправки: там возможен переход.
  const pinfo = args.submit ? await pageInfo(t.tab.page) : null;
  return (
    "OK — поле «" + target.desc + "» заполнено (" + text.length + " символов, способ: " + via + sent + ")." +
    (pinfo ? "\nСтраница: " + (pinfo.title ? "«" + pinfo.title + "» — " : "") + (pinfo.url || "—") : "")
  );
}

// Кликнуть по элементу. Способы (любой один): ref из browserSnapshot,
// role+name (доступное имя — например role: "button", name: "Войти"),
// name/text (видимый текст), selector (CSS / text= / xpath=).
async function click(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const q = dom.parseQuery(args);
  if (!dom.hasQuery(q)) {
    return "Ошибка browserClick: укажи, по чему кликать — ref из browserSnapshot (ref: \"e2\"), name (видимый текст кнопки), role+name или selector. Карту элементов даёт browserSnapshot.";
  }
  const findStart = Date.now();
  const target = await resolveTarget(t.tab.page, q, "click", { timeout: args.timeout });
  if (!target) {
    return missText(
      t.tab.page,
      "browserClick",
      q,
      "элемент не найден (ждал " + Math.round((Date.now() - findStart) / 1000) + " с)"
    );
  }
  const pagesBefore = await pageCount();
  try { await target.loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
  // Клик не сдаётся с первого раза: если элемент перекрыт слоем (диалог, баннер,
  // окно перевода) — повторяем силой, затем из DOM, затем мышью по координатам.
  // Разница принципиальная: раньше агент получал «перекрыт» и упирался.
  let via = "";
  let blocker = "";
  const firstErr = await (async () => {
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT });
      via = "обычный клик";
      return "";
    } catch (e) {
      return (e && e.message) || String(e);
    }
  })();
  if (!via) {
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT, force: true });
      via = "force-клик (проверка «под курсором» пропущена)";
      blocker = await describeInterceptor(t.tab.page, target.loc);
    } catch (e2) {}
  }
  if (!via) {
    try {
      const l = typeof target.loc.first === "function" ? target.loc.first() : target.loc;
      await l.evaluate((el) => el.click());
      via = "клик из DOM (el.click())";
      blocker = await describeInterceptor(t.tab.page, target.loc);
    } catch (e3) {}
  }
  if (!via) {
    const box = await boxOf(target.loc);
    if (box) {
      try {
        await t.tab.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        via = "клик мышью по координатам центра";
      } catch (e4) {}
    }
  }
  if (!via) {
    const msg = /intercepts pointer events/i.test(firstErr)
      ? "элемент перекрыт другим слоем (диалог, баннер, окно перевода)"
      : String(firstErr || "не удалось").slice(0, 160);
    return (
      "Ошибка browserClick («" + target.desc + "»): " + msg + ".\n" +
      (await missText(t.tab.page, "browserClick", q, msg))
    );
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  // Ссылка с target=_blank открывает НОВУЮ вкладку — подхватываем её и делаем
  // активной, иначе агент продолжит работать в старой и решит, что клик не сработал.
  const opened = await adoptNewPages(pagesBefore);
  const info = await pageInfo(t.tab.page);
  let out = "OK — клик по «" + target.desc + "» (" + via + "). Текущий URL: " + (info.url || "—");
  if (opened.length) out += "\nОткрылась новая вкладка: " + opened.join(", ") + " — она стала активной.";
  if (blocker) {
    out +=
      "\nВнимание: элемент был перекрыт слоем (" + blocker + "). Если действие не сработало — " +
      "посмотри слои через browserOverlays и убери помеху (browserOverlays { dismiss: true }).";
  }
  return out;
}

// Выбрать значение в <select>: ref / selector / label. Если вариант не подошёл —
// показываем реальные варианты списка (без угадывания).
async function select(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const value = args.value == null ? "" : String(args.value);
  const q = dom.parseQuery(args, { forField: true });
  if (!dom.hasQuery(q)) return "Ошибка browserSelect: укажи список — ref из browserSnapshot, selector или label.";
  const target = await resolveTarget(t.tab.page, q, "field");
  if (!target) return missText(t.tab.page, "browserSelect", q, "список не найден");
  try {
    await target.loc.selectOption(value, { timeout: ACTION_TIMEOUT });
    return "OK — в «" + target.desc + "» выбрано: " + value;
  } catch (e) {
    let opts = [];
    try {
      opts = await target.loc.evaluate((el) =>
        Array.from(el.options || [])
          .map((o) => o.value + (o.text && o.text !== o.value ? " («" + o.text + "»)" : ""))
          .slice(0, 20)
      );
    } catch {}
    const head = "Ошибка browserSelect: в «" + target.desc + "» не выбрался вариант «" + value + "».";
    return opts.length
      ? head + "\nВарианты списка: " + opts.join(", ")
      : head + " " + String((e && e.message) || "").slice(0, 150);
  }
}

// Нажать клавишу (Enter, Escape, Tab, стрелки…). Работает с активным элементом страницы.
async function press(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const key = String(args.key || "").trim();
  if (!key) return "Ошибка: укажи key (например Enter)";
  try {
    await t.tab.page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
  } catch (e) {
    return "Ошибка browserPress: " + ((e && e.message || "").slice(0, 200));
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  return "OK — нажата клавиша " + key + ".";
}

// Прочитать видимый текст страницы (до max символов).
async function text(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const max = Math.max(1000, Math.min(parseInt(args.max, 10) || 12000, 30000));
  let bodyText = "";
  try {
    bodyText = await t.tab.page.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch (e) {
    return "Ошибка browserText: " + ((e && e.message || "").slice(0, 200));
  }
  const info = await pageInfo(t.tab.page);
  const clean = String(bodyText || "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = clean.length > max;
  const shown = truncated ? clean.slice(0, max) + "\n… [текст обрезан, всего " + clean.length + " символов]" : clean;
  return "URL: " + (info.url || "—") + "\nЗаголовок: " + (info.title || "—") + "\n\n" + (shown || "(пустая страница)");
}

// Скриншот страницы: сохраняем PNG В ФАЙЛ (data URL в контекст агента — это
// десятки тысяч токенов на один вызов) и возвращаем путь. Файл можно отдать
// vision-модели через analyzeImage или показать пользователю.
async function screenshotFile(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return { error: t.error };
  // JPEG по умолчанию: файл в 3–5 раз меньше PNG — быстрее пишется и дешевле для
  // vision-модели. png:true (или fullPage) остаётся для точного чтения мелкого текста.
  const wantPng = args.png === true || args.format === "png" || args.fullPage === true;
  const quality = Math.min(Math.max(parseInt(args.quality, 10) || 72, 30), 100);
  let buf;
  try {
    buf = await t.tab.page.screenshot(
      wantPng
        ? { type: "png", fullPage: args.fullPage === true }
        : { type: "jpeg", quality: quality, fullPage: args.fullPage === true }
    );
  } catch (e) {
    return { error: "Ошибка browserScreenshot: " + String((e && e.message) || "").slice(0, 200) };
  }
  const ext = wantPng ? ".png" : ".jpg";
  const mime = wantPng ? "image/png" : "image/jpeg";
  const dir = String(args.dir || path.join(os.tmpdir(), "ai-agent-shots"));
  let file = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "browser-" + new Date().toISOString().replace(/[:.]/g, "-") + ext);
    fs.writeFileSync(file, buf);
  } catch (e) {
    file = "";
  }
  const info = await pageInfo(t.tab.page);
  return { buf: buf, path: file, url: info.url, title: info.title, mime: mime };
}

// Текстовый ответ для агента: путь к файлу (data URL — только если попросили явно).
async function screenshot(args) {
  args = args || {};
  const r = await screenshotFile(args);
  if (r.error) return r.error;
  if (args.dataUrl === true || args.asDataUrl === true) {
    return "data:" + (r.mime || "image/png") + ";base64," + r.buf.toString("base64");
  }
  if (r.path) {
    return (
      "OK — скриншот сохранён в файл: " + r.path +
      "\nСтраница: " + (r.url || "—") + (r.title ? " («" + r.title + "»)" : "") +
      "\nДальше: analyzeImage { path: \"" + r.path + "\" } — разбор vision-моделью (если она настроена), " +
      "или работай по DOM: browserSnapshot / browserDOM / browserEval."
    );
  }
  return "data:" + (r.mime || "image/png") + ";base64," + r.buf.toString("base64");
}

// ── Инструменты поверх стандартных ─────────────────────────────────────────

// Выполнить JS на странице и вернуть результат. Самый надёжный путь через любые
// слои: перекрытый чекбокс, кнопка в диалоге, значение из JS-состояния страницы.
async function evalJs(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const script = String(args.script || args.code || args.js || "").trim();
  if (!script) {
    return (
      'Ошибка browserEval: укажи script — выражение или код на JS. Примеры: ' +
      '"document.querySelector(\'input[type=checkbox]\').click()", "document.title", ' +
      '"Array.from(document.querySelectorAll(\'[role=dialog] button\')).map(b=>b.innerText)"'
    );
  }
  const max = Math.min(Math.max(parseInt(args.maxChars, 10) || 2000, 200), 20000);
  // Голое выражение оборачиваем в return, код со своими return выполняем как есть.
  const withReturn = /\breturn\b/.test(script);
  let value;
  let err = "";
  let asStatements = false; // сработал запасной путь: это был набор операторов
  try {
    // Значение проходит через сериализатор В СТРАНИЦЕ: без него DOM-узел, Map,
    // объект с циклами и bigint превращаются в undefined (Playwright такие
    // значения не отдаёт), и агент видел пустоту вместо результата.
    value = unwrapEvalValue(
      await t.tab.page.evaluate(
        "(async () => {\n const __ser = " + evalValueToPlain.toString() + ";\n" +
          (withReturn ? script : "const __v = (" + script + ");\nreturn __ser(__v);") +
          "\n})()"
      )
    );
  } catch (e1) {
    try {
      // Не выражение, а набор операторов (многострочный код без return):
      // выполняем как есть — эффекты важнее значения.
      asStatements = true;
      value = await t.tab.page.evaluate("(async () => {\n" + script + "\n})()");
    } catch (e2) {
      err = String((e2 && e2.message) || e1 || "").slice(0, 300);
    }
  }
  if (err) return "Ошибка browserEval: " + err;
  // Код мог сам положить результат в window.__x — забираем его оттуда:
  // «ничего не вернуло» без значения выглядит как «код не сработал».
  const assignedTo = (script.match(/\b(?:window|globalThis)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/) || [])[1] || "";
  let wroteVar = null;
  if (value === undefined && assignedTo) {
    try {
      wroteVar = await t.tab.page.evaluate(varValueInPage, { name: assignedTo, max: Math.min(max * 4, 40000) });
    } catch (e) {}
  }
  let text = "";
  let note = "";
  if (value === undefined) {
    if (wroteVar && wroteVar.found) {
      text = wroteVar.text;
      note =
        "Код выполнен" + (asStatements ? " (это набор операторов, а не выражение)" : "") +
        " и значения не вернул — взял то, что он сам положил: window." + assignedTo + " (" + describeVar(wroteVar) + ").";
    } else {
      text = "(код выполнен, но ничего не вернул)";
      note =
        "Код выполнен. Значение не вернулось, потому что " +
        (asStatements ? "это набор операторов, а не выражение" : "само выражение даёт undefined") +
        ": закончи код словом return — например { …; return window.__rows.length; }." +
        (asStatements && !assignedTo ? " Результат удобно класть в window.__x и читать следующим вызовом." : "") +
        " Если возвращал DOM-узел — верни .outerHTML, .textContent или .length: узел целиком мост не отдаёт.";
    }
  } else {
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch (e) {
      text = String(value);
    }
    if (text == null) text = "(код выполнен, но ничего не вернул)";
  }
  const info = await pageInfo(t.tab.page);
  // save / saveToFile: результат пишется В ФАЙЛ и переживает перезагрузку вкладки.
  // Раньше большие данные складывали в window.__var и резали ответ до maxChars —
  // хвост (total_count, курсор) прочитать было нельзя, а перезагрузка вкладки
  // стирала всё накопленное. Файл закрывает оба случая.
  const saveArg = args.save != null ? args.save : args.saveToFile != null ? args.saveToFile : args.file;
  const saveAs = typeof saveArg === "string" && saveArg.trim() ? saveArg.trim() : "";
  if (saveArg === true || saveAs) {
    let file = saveAs;
    try {
      if (!file) {
        const dir = path.join(os.tmpdir(), "ai-agent-eval");
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, "eval-" + new Date().toISOString().replace(/[:.]/g, "-") + ".txt");
      }
      fs.writeFileSync(file, text, "utf8");
    } catch (e) {
      return "Ошибка browserEval: результат не удалось записать в файл (" + String((e && e.message) || e).slice(0, 120) + ").";
    }
    const head = text.slice(0, Math.min(max, 800));
    return (
      "browserEval выполнен. URL: " + (info.url || "—") +
      (note ? "\n" + note : "") +
      "\nРезультат сохранён В ФАЙЛ: " + file +
      "\nСимволов: " + text.length + " (файл переживает перезагрузку вкладки — не держи накопленное в window)." +
      "\nДальше: readFile { path: \"" + file + "\" } — или разбирай файл своим кодом (runCommand).\n" +
      "Начало:\n" + head + (text.length > head.length ? "\n… [остальное в файле]" : "")
    );
  }
  const shown = text.length > max
    ? text.slice(0, max) + "\n… [обрезано, всего " + text.length + " символов. Нужен весь ответ — повтори с save: true]"
    : text;
  return "browserEval выполнен. URL: " + (info.url || "—") + "\nРезультат: " + shown + (note ? "\n" + note : "");
}

// HTML вокруг селектора (или ref из карты) — чтобы понять структуру незнакомого
// слоя: имена классов диалога, aria-атрибуты, вложенность.
async function domHtml(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const ref = dom.refName(args.ref || args.element);
  const selector = String(args.selector || args.css || "").trim();
  if (!ref && !selector) return "Ошибка browserDOM: укажи selector (CSS) или ref из browserSnapshot.";
  const sel = ref ? dom.refSelector(ref) : selector;
  const max = Math.min(Math.max(parseInt(args.limit, 10) || 3000, 300), 30000);
  let res;
  try {
    res = await t.tab.page.evaluate(({ sel, max }) => {
      // Ищем и в обычном дереве, и в shadow-root'ах веб-компонентов.
      const deepFind = (s) => {
        let direct = null;
        try { direct = document.querySelector(s); } catch (e) { return null; }
        if (direct) return direct;
        const queue = [document];
        let seen = 0;
        while (queue.length && seen < 4000) {
          const root = queue.shift();
          let all = [];
          try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
          for (let i = 0; i < all.length; i++) {
            seen++;
            const node = all[i];
            if (!node.shadowRoot) continue;
            let hit = null;
            try { hit = node.shadowRoot.querySelector(s); } catch (e) {}
            if (hit) return hit;
            queue.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = deepFind(sel);
      if (!el) return { found: false };
      const html = el.outerHTML || "";
      let total = 0;
      try { total = document.querySelectorAll(sel).length; } catch (e) { total = 0; }
      return {
        found: true,
        tag: (el.tagName || "").toLowerCase(),
        html: html.slice(0, max),
        full: html.length,
        text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
        count: total,
      };
    }, { sel: sel, max: max });
  } catch (e) {
    return "Ошибка browserDOM: " + String((e && e.message) || e).slice(0, 200);
  }
  if (!res || !res.found) {
    return (
      "browserDOM: по «" + sel + "» ничего не нашлось. Проверь селектор через browserSnapshot " +
      "(там ref и классы элементов) или посмотри слои через browserOverlays."
    );
  }
  return (
    "Элемент «" + sel + "» — <" + res.tag + ">, совпадений на странице: " + res.count +
    "\nТекст: " + (res.text || "(пусто)") +
    "\nHTML" + (res.html.length < res.full ? " (обрезано до " + res.html.length + " из " + res.full + " символов)" : "") +
    ":\n" + res.html
  );
}

// Закрыть помехи поверх страницы и/или показать, что там открыто.
// ВАЖНО: юридические согласия (terms of service) молча НЕ подтверждаются —
// инструмент только показывает, какие ref нажать. Явное подтверждение —
// acceptTerms: true (агент вызывает его осознанно, по просьбе пользователя).
async function overlays(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let map;
  try {
    map = await collectMap(t.tab.page);
  } catch (e) {
    return "Ошибка browserOverlays: " + String((e && e.message) || e).slice(0, 200);
  }
  const found = (map.overlays || []).map((o) => Object.assign({}, o, { kind: overlayKind(o) }));
  let out = "";
  if (found.length) {
    out += "Слоёв поверх страницы: " + found.length + "\n";
    found.forEach((o, i) => {
      const items = overlayItems(map, o.name);
      out +=
        "\n" + (i + 1) + ". " + (OVERLAY_LABEL[o.kind] || OVERLAY_LABEL.dialog) +
        (o.name ? " — «" + o.name + "»" : "") +
        " (" + items.length + " " + (items.length === 1 ? "элемент" : items.length < 5 ? "элемента" : "элементов") + ")" +
        (o.text ? "\n   Текст: «" + o.text.slice(0, 220) + "»" : "");
      if (items.length) {
        out +=
          "\n   Элементы: " +
          items
            .slice(0, 12)
            .map((it) => it.ref + " (" + it.role + (it.name ? " «" + it.name.slice(0, 40) + "»" : "") + (it.hiddenInput ? ", скрытый ввод" : "") + (it.checked ? ", отмечено" : "") + ")")
            .join(", ");
        out += "\n   Действия: " + dom.actionHint(items[0]);
      }
    });
  } else {
    out += "Слоёв поверх страницы не видно.";
  }

  if (args.dismiss) {
    let report = [];
    try {
      report = await t.tab.page.evaluate(cleanupInPage);
    } catch (e) {
      report = [];
    }
    out += "\n\nЗакрытие помех: " + (report && report.length ? report.join("; ") : "нечего закрывать (перевод и баннеры не найдены)");
  }
  if (args.acceptTerms) {
    let report = [];
    try {
      report = await t.tab.page.evaluate(acceptTermsInPage);
    } catch (e) {
      report = [];
    }
    out += "\n\nПодтверждение согласия: " + (report && report.length ? report.join("; ") : "галочка/кнопка согласия не найдены — сделай browserSnapshot и действуй по ref");
  }
  if (found.some((o) => o.kind === "terms") && !args.acceptTerms) {
    out +=
      "\n\nЭто юридическое согласие: сам его не подтверждаю. Если пользователь просил продолжить — " +
      "отметь галочку и нажми кнопку согласия (browserOverlays { acceptTerms: true } либо browserClick по ref), " +
      "затем проверь результат: browserSnapshot.";
  }
  if (found.some((o) => o.kind === "translate")) {
    out += "\n\nОкно перевода Google сдвигает страницу и перехватывает клики — убери его: browserOverlays { dismiss: true }.";
  }
  return out;
}

// Координаты элемента — для клика мышью в обход проверки доступности.
async function boxOf(loc) {
  try {
    const l = typeof loc.first === "function" ? loc.first() : loc;
    return await l.boundingBox();
  } catch (e) {
    return null;
  }
}

// Кто перекрывает элемент: настоящий клик мышью попал бы в этот слой. Агенту
// нужен человеческий ответ («div.cdk-overlay-backdrop»), а не «intercepts events».
async function describeInterceptor(page, loc) {
  try {
    const l = typeof loc.first === "function" ? loc.first() : loc;
    const info = await l.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (!top || top === el || el.contains(top)) return "";
      let cls = "";
      try { cls = typeof top.className === "string" ? top.className.replace(/\s+/g, ".").slice(0, 60) : ""; } catch (e) {}
      const txt = String(top.innerText || top.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      return (top.tagName || "").toLowerCase() + (cls ? "." + cls : "") + (txt ? " «" + txt + "»" : "");
    });
    return String(info || "").slice(0, 140);
  } catch (e) {
    return "";
  }
}

// Ждать появления элемента: selector, ref или name/text (та же логика поиска,
 // что у клика — поэтому ожидание можно писать словами, а не селектором).
async function wait(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const q = dom.parseQuery(args);
  // Пауза без элемента: browserWait { ms: 1500 } — иногда нужно просто дать
  // странице дорисоваться, а искать конкретный элемент нечего.
  const pauseMs = parseInt(args.ms != null ? args.ms : args.pause, 10);
  if (!dom.hasQuery(q) && pauseMs > 0) {
    const capped = Math.min(Math.max(pauseMs, 0), 60000);
    await sleep(capped);
    if (args.load) await afterNavigation(t.tab.page);
    const pi = await pageInfo(t.tab.page);
    return "OK — пауза " + capped + " мс. URL: " + (pi.url || "—");
  }
  if (!dom.hasQuery(q)) {
    return "Ошибка browserWait: укажи selector, ref или name/text ожидаемого элемента (или паузу: browserWait { ms: 1500 }).";
  }
  const timeout = Math.min(parseInt(args.timeout, 10) || 10000, 60000);
  const cands = q.ref
    ? [{ loc: t.tab.page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref }]
    : clickCandidates(t.tab.page, q);
  const deadline = Date.now() + timeout;
  let poll = 100;
  while (Date.now() < deadline) {
    const target = await firstUsable(cands);
    if (target) {
      let vis = false;
      try { vis = await target.loc.isVisible(); } catch { vis = false; }
      if (vis) return "OK — элемент «" + target.desc + "» появился.";
    }
    await sleep(Math.min(poll, Math.max(1, deadline - Date.now())));
    poll = Math.min(Math.round(poll * 1.5), 400);
  }
  return missText(t.tab.page, "browserWait", q, "не появился за " + timeout + " мс");
}

// Карта интерактивных элементов страницы: ref, роль, видимое имя.
// Это «глаза» агента на кнопки и поля — вместо угадывания селекторов.
async function snapshot(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let map;
  try {
    map = await collectMap(t.tab.page);
  } catch (e) {
    return "Ошибка browserSnapshot: " + String((e && e.message) || e).slice(0, 200);
  }
  let text = dom.formatSnapshot({
    items: map.items,
    url: map.url,
    title: map.title,
    filter: String(args.filter || "").trim(),
    limit: parseInt(args.limit, 10) || 60,
  });
  // Слои бывают без интерактивных элементов (окно перевода — это iframe), поэтому
  // о помехах и о юридических согласиях сообщаем прямо в карте: агент узнаёт об
  // экране до того, как упрётся в него кликом.
  const found = (map.overlays || []).map((o) => Object.assign({}, o, { kind: overlayKind(o) }));
  const noise = found.filter((o) => o.kind === "translate" || o.kind === "cookie" || o.kind === "noise");
  const terms = found.filter((o) => o.kind === "terms");
  if (noise.length) {
    const kinds = [];
    for (const o of noise) if (kinds.indexOf(OVERLAY_LABEL[o.kind]) < 0) kinds.push(OVERLAY_LABEL[o.kind]);
    text +=
      "\n⚠️ Поверх страницы помехи: " + kinds.join(", ") +
      " — убрать одним вызовом: browserOverlays { dismiss: true } (баннер перевода сдвигает страницу и перехватывает клики).";
  }
  if (terms.length) {
    text +=
      "\n⚠️ Открыт экран юридического согласия (" + (terms[0].name ? "«" + terms[0].name + "»" : "terms of service") +
      ") — сам его не подтверждай: сообщи пользователю и пройди по его просьбе (browserOverlays { acceptTerms: true }).";
  }
  return text;
}

// Закрыть вкладку (по умолчанию активную; "all" — все вкладки и браузер).
async function close(args) {
  args = args || {};
  if (args.tabId === "all" || args.all) {
    const list = Array.from(tabs.values());
    for (const tb of list) {
      if (tb.adopted) continue; // вкладки пользователя не закрываем
      try { await tb.page.close(); } catch {}
    }
    const adoptedCount = list.filter((tb) => tb.adopted).length;
    tabs.clear();
    activeTabId = null;
    runningProfileDir = null;
    runningModeKey = null;
    if (cdpActive) {
      // Свой Chrome НЕ закрываем: только отключаемся, его вкладки и сессии целы.
      browser = null;
      cdpActive = false;
      cdpContext = null;
      sessionClosed = true;
      return (
        "OK — отключился от твоего Chrome (он продолжает работать, вкладки" +
        (adoptedCount ? " (" + adoptedCount + ")" : "") +
        " и входы на сайты на месте)."
      );
    }
    if (sessionAlive()) { try { await browser.close(); } catch {} }
    browser = null;
    sessionClosed = true;
    return "OK — все вкладки и браузер закрыты.";
  }
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  if (t.tab.adopted) {
    return "Это вкладка твоего Chrome (" + t.tab.id + ") — я её не закрываю, чтобы не тронуть твою работу. Открой новую вкладку через browserOpen.";
  }
  const id = t.tab.id;
  try { await t.tab.page.close(); } catch {}
  tabs.delete(id);
  if (activeTabId === id) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
  return "OK — вкладка " + id + " закрыта.";
}

// Список открытых вкладок.
async function status() {
  if (!sessionAlive()) {
    return "Браузер не запущен. Ни одной вкладки нет. Открой страницу через browserOpen (url)." + profileNote();
  }
  const rows = [];
  for (const [id, tb] of tabs.entries()) {
    const info = await pageInfo(tb.page);
    rows.push((id === activeTabId ? "▶ " : "   ") + id + "  " + (info.title || "").slice(0, 60) + "  " + (info.url || ""));
  }
  if (!rows.length) return "Браузер запущен, вкладок нет. browserOpen (url) — открыть страницу.";
  return "Открытые вкладки (" + rows.length + "), движок: " + engineName + ":\n" + rows.join("\n") +
    "\n\nАктивная — ▶. Для действий в конкретной вкладке передавай tabId." + profileNote();
}

// Остановить браузер (вызывается при выходе из приложения).
async function stop() {
  // В режиме «свой Chrome» отключаемся, НЕ закрывая браузер пользователя.
  if (sessionAlive() && !cdpActive) {
    try { await browser.close(); } catch {}
  }
  browser = null;
  tabs.clear();
  activeTabId = null;
  sessionClosed = true;
  runningProfileDir = null;
  runningModeKey = null;
  cdpActive = false;
  cdpContext = null;
}

// Полная очистка постоянного профиля: выход со всех сайтов, стирание куки и сессий.
async function clearProfile() {
  if (cdpActive) {
    return "Сейчас инструменты работают в твоём Chrome (CDP). Закрой его окно (или вызови browserClose с tabId: \"all\") — иначе профиль занят и файлы не удалятся.";
  }
  await stop();
  if (!profileDir) return "Постоянный профиль браузера выключен — очищать нечего.";
  await new Promise((r) => setTimeout(r, 400)); // даём Chromium отпустить файлы профиля
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {
    return "Не удалось очистить профиль браузера: " + (((e && e.message) || String(e)) + "").slice(0, 200);
  }
  return "OK — профиль браузера очищен. При следующем входе на сайт потребуется авторизация заново.";
}

// ── Аудит страницы для деплоя ────────────────────────────────────────────────
// Открывает адрес в браузере агента, слушает консоль, ошибки страницы и сеть,
// снимает скриншот и закрывает вкладку. Нужен после выката: HTTP 200 ещё не
// значит, что страница нарисовалась. Возвращает данные, а не текст — решение
// «годится / не годится» принимает src/deploy-check.js, чтобы правила были
// в одном месте и проверялись тестами без браузера.
async function auditPage(url, opts) {
  const o = opts || {};
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: "Нужен полный адрес (http/https): " + target };
  const r = await ensureBrowser();
  if (!r.ok) return { ok: false, error: r.message || "браузер не запустился" };
  const started = Date.now();
  let page = null;
  try {
    page = await newPageInBrowser();
  } catch (e) {
    return { ok: false, error: "не удалось открыть вкладку: " + ((e && e.message) || String(e)) };
  }
  const tabId = "tab" + (++tabSeq);
  tabs.set(tabId, { id: tabId, page, openedAt: Date.now() });
  netRecorder(page);
  activeTabId = tabId;

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const onConsole = (m) => {
    try {
      if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 300));
    } catch {}
  };
  const onPageError = (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300));
  const onFailed = (req) => {
    try {
      const f = req.failure && req.failure();
      failedRequests.push({ url: String(req.url()).slice(0, 200), reason: String((f && f.errorText) || "") });
    } catch {}
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onFailed);

  let status = 0;
  let navError = "";
  try {
    const resp = await page.goto(target, {
      waitUntil: o.waitUntil === "load" ? "load" : "domcontentloaded",
      timeout: o.timeoutMs || 25000,
    });
    status = (resp && resp.status && resp.status()) || 0;
  } catch (e) {
    navError = String((e && e.message) || e).slice(0, 300);
  }
  // Странице надо дать дорисоваться: у SPA разметка и картинки приходят после DOMContentLoaded.
  try {
    await page.waitForLoadState("networkidle", { timeout: o.idleMs || 4000 });
  } catch {}
  const settle = Math.min(Math.max(parseInt(o.settleMs, 10) || 1200, 0), 10000);
  if (settle) await new Promise((res) => setTimeout(res, settle));

  let info;
  try {
    info = await page.evaluate(() => {
      const body = document.body;
      const text = body ? String(body.innerText || "").trim() : "";
      const root = document.getElementById("root") || document.getElementById("app") || document.getElementById("__next");
      return {
        title: document.title || "",
        textLen: text.length,
        sample: text.slice(0, 200),
        rootChildren: root ? root.children.length : -1,
        h1: Array.from(document.querySelectorAll("h1")).slice(0, 3).map((h) => String(h.innerText || "").trim().slice(0, 80)),
      };
    });
  } catch (e) {
    info = { title: "", textLen: 0, sample: "", rootChildren: -1, h1: [], evalError: String((e && e.message) || e).slice(0, 200) };
  }

  let screenshot = null;
  try {
    screenshot = await page.screenshot({ fullPage: false });
  } catch {}

  let finalUrl = target;
  try {
    finalUrl = page.url() || target;
  } catch {}
  try {
    if (page.off) {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onFailed);
    }
  } catch {}
  // Вкладку закрываем: проверка не должна оставлять мусор в браузере агента.
  try {
    await page.close();
  } catch {}
  if (tabs.has(tabId)) tabs.delete(tabId);
  if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;

  return {
    ok: true,
    target,
    url: finalUrl,
    status,
    navError,
    consoleErrors,
    pageErrors,
    failedRequests,
    info,
    screenshot,
    ms: Date.now() - started,
  };
}

module.exports = {
  open,
  snapshot,
  fill,
  click,
  evalJs,
  domHtml,
  overlays,
  act,
  scroll,
  hover,
  network,
  replay,
  maskForm,
  parseForm,
  buildForm,
  pickPath,
  findItemsPath,
  findTotalPath,
  findCursorPath,
  findCursorParam,
  keyOfItem,
  // тесты: строки списка и прокрутка строки в кадр
  itemsKeyInPage,
  // тесты: разбор значения из страницы (DOM-узел, циклы, undefined),
  evalValueToPlain,
  unwrapEvalValue,
  varValueInPage,
  describeVar,
  scrollItemIntoViewInPage,
  fetchJsonInPage,
  replayFindSample,
  waitForIdle,
  overlayKind,
  overlayItems,
  screenshotFile,
  select,
  press,
  text,
  screenshot,
  auditPage, // аудит выкаченной страницы: консоль, ошибки, скриншот (для деплоя)
  wait,
  close,
  status,
  stop,
  connect,
  setConnectMode,
  connectInfo,
  setProfileDir,
  profilePath,
  clearProfile,
  collectInPage, // используется тестами (мини-DOM), не вызывается снаружи
  collectMap, // тесты: карта строится на мини-DOM через page.evaluate-заглушку
  cleanupInPage, // тесты: очистка помех не трогает юридические кнопки
  acceptTermsInPage, // тесты: подтверждение согласия отмечает галочку и кнопку
  // тесты: прокрутка и счётчики покоя на мини-DOM
  scrollStateInPage,
  scrollPageInPage,
  scrollInnerInPage,
  hoverInPage,
  idleStartInPage,
  idleTakeInPage,
  idleStopInPage,
  normalizeStep, // тесты: строки в шагах
  queryFromSpec,
  lazyKeyOf, // тесты: определение «появилось ли новое содержимое»
  loadAllScroll, // тесты: цикл догрузки ленивого списка
  setPlaywright, // только для тестов: подменить/сбросить кэш playwright
  isBrowserFailure, // отказ набора: «Ошибка …», «Браузер не запущен …», «Вкладка не найдена …»
};
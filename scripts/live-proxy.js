"use strict";
/* ─── Живой прогон прокси для внешних API (main.js без окна Electron) ─────────
   Запуск: bun run test:live:proxy   (node scripts/live-proxy.js)

   Зачем. Часть 62 дала приложению прокси: запросы к провайдеру можно вести через
   прокси, а локальную работу — нет. Модульный набор (test/net-proxy.test.js) водит
   модуль напрямую и проверяет сам протокол на настоящих локальных прокси. Здесь
   проверяется ПРОВОДКА и поведение НАСТОЯЩЕГО прогона: main.js грузится в Node с
   поддельным electron, провайдера изображает локальный HTTP-сервер, а между ними
   стоит НАСТОЯЩИЙ http-прокси, который записывает всё, что через него прошло.

   Что проверяется по-настоящему:
     • прокси включён и локальные адреса не исключены — запрос агента к провайдеру
       идёт ЧЕРЕЗ прокси (прокси видит запрос), и прогон при этом доживает до конца;
     • прокси включён, но цель локальная (свой Ollama / LM Studio) — запрос идёт
       НАПРЯМУЮ: прокси не видит ни одного нового запроса (иначе локальные модели
       уезжали бы в чужую сеть и работали в разы медленнее);
     • прокси выключен — поведение прежнее, напрямую, мимо прокси;
     • канал проверки прокси из окна отвечает: мусор на месте адреса объясняется
       словами, а не молчанием (живой запрос наружу проверяет человек кнопкой).

   Протокол SOCKS5 живьём проверяет модульный набор (там настоящий SOCKS5-сервер с
   логином и паролем): здесь важен путь «прогон → транспорт → прокси», а не
   рукопожатие.

   Негативные контроли: --break=proxy (гнездо подстановки в main.js обнулено) ломает
   первую проверку; --break=bypass (исключение локальных адресов убрано) ломает
   вторую. Оба обязаны покраснеть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const net = require("net");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-proxy-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-proxy-work-"));
const BREAK = (() => {
  const a = process.argv.find((s) => s.startsWith("--break="));
  return a ? a.slice("--break=".length) : "";
})();

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BREAKS = {
  // Проводка прогона сломана: раунд снова зовёт голый fetch и в прокси не идёт —
  // первая проверка обязана покраснеть.
  proxy: ["src/run-round.js", "      ? (url, opts) => netProxy.fetchFor(settings, url, opts)\n", "      ? (url, opts) => fetch(url, opts)\n"],
  // Гнездо подстановки в оболочке обнулено: модули (транспорт, окно контекста —
  // вспомогательные запросы) снова ходят голым fetch. Живой прогон обязан это
  // заметить: их запросы мимо прокси.
  renderer: ["src/main.js", "ProviderConfig.setFetchImpl((url, opts) => netProxy.fetchFor(loadSettings(), url, opts));", "ProviderConfig.setFetchImpl(null);"],
  // Исключение локальных адресов убрано: свой Ollama поехал бы через прокси — вторая
  // проверка это ловит, а модульный набор ловит только саму функцию.
  bypass: ["src/net-proxy.js", "    if (s.proxyBypassLocal !== false && isLocalUrl(raw)) return null;\n", ""],
};
let brokenFile = null;
if (BREAK) {
  const spec = BREAKS[BREAK];
  if (!spec) {
    console.error("✗ Неизвестный контроль: " + BREAK + ". Есть: " + Object.keys(BREAKS).join(", "));
    process.exit(2);
  }
  brokenFile = path.join(ROOT, spec[0]);
  const src = fs.readFileSync(brokenFile, "utf8");
  if (src.split(spec[1]).length - 1 !== 1) {
    console.error("✗ Якорь контроля не найден в " + spec[0] + ": " + JSON.stringify(spec[1]));
    process.exit(2);
  }
  const before = crypto.createHash("sha256").update(src).digest("hex");
  fs.writeFileSync(brokenFile, src.replace(spec[1], spec[2]));
  process.on("exit", () => {
    try {
      fs.writeFileSync(brokenFile, src);
      const back = crypto.createHash("sha256").update(fs.readFileSync(brokenFile, "utf8")).digest("hex");
      console.log(back === before ? "  ✓ " + spec[0] + " восстановлен байт в байт" : "  ✗ " + spec[0] + " НЕ восстановлен!");
    } catch (e) {
      console.error("  ✗ Файл не восстановлен: " + e.message);
    }
  });
}

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const events = [];
function FakeWindow() {
  this.webContents = { send: (ch, ev) => events.push({ ch: ch, ev: ev }), setWindowOpenHandler: () => {}, on: () => {}, id: 1 };
  this.on = () => {};
  this.isDestroyed = () => false;
  this.isFocused = () => true;
  this.loadFile = () => {};
  this.setTitle = () => {};
}

// ── Подменённый провайдер: отвечает одним финалом и считает запросы ─────────
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const finalText = (text) =>
  sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
  ]);

let phrase = "main";
const providerHits = []; // { phrase, kind, at }
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/models")) {
      providerHits.push({ phrase: phrase, kind: "models", at: Date.now() });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model", context_length: 64000 }] }));
    }
    if (!u.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
    }
    providerHits.push({ phrase: phrase, kind: "chat", at: Date.now() });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(finalText(phrase === "main" ? "Проверка связи прошла: готово." : "Второй шаг сделан: готово."));
  });
});

// ── НАСТОЯЩИЙ http-прокси: записывает всё, что через него прошло ─────────────
// http-цель идёт запросом в абсолютной форме, https-цель — тоннелем CONNECT.
// Провайдер в этом прогоне локальный и по http, поэтому живой путь — абсолютная
// форма; тоннель и SOCKS5 проверяет модульный набор.
const proxySeen = []; // { kind, url, at }
const proxyServer = http.createServer((req, res) => {
  proxySeen.push({ kind: "absolute", url: req.url, at: Date.now() });
  let u = null;
  try {
    u = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end("bad absolute url");
  }
  const preq = http.request(
    {
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: u.host }),
    },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on("error", () => {
    try {
      res.writeHead(502);
      res.end("proxy error");
    } catch {}
  });
  req.pipe(preq);
});
proxyServer.on("connect", (req, socket, head) => {
  proxySeen.push({ kind: "connect", url: req.url, at: Date.now() });
  const parts = String(req.url).split(":");
  const port = parseInt(parts.pop(), 10) || 443;
  const host = parts.join(":");
  const up = net.connect({ host: host, port: port }, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

// ── main.js с поддельным electron ──────────────────────────────────────────
// electron-updater — единственная настоящая зависимость приложения; в этом
// окружении node_modules пуст, и автообновление тут ни при чём: подменяем.
const updater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  subs: [],
  on: (name) => updater.subs.push(name),
  checkForUpdates: () => Promise.resolve(null),
  downloadUpdate: () => Promise.resolve(null),
  quitAndInstall: () => {},
  currentVersion: { version: "1.5.220" },
  logger: null,
};

const handlers = new Map();
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron-updater") return { autoUpdater: updater };
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.220",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: FakeWindow,
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
      Notification: function () { this.show = () => {}; },
    };
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});

const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  return Promise.resolve(fn({ sender: { id: 1 } }, ...args));
};

const listen = (srv) =>
  new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" + srv.address().port));
  });

(async () => {
  console.log("Живой прогон прокси для внешних API (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 120 с — это уже поломка.");
    process.exit(1);
  }, 120000);
  guard.unref?.();

  let providerBase = "";
  let proxyBase = "";
  try {
    providerBase = (await listen(provider)) + "/v1";
    proxyBase = await listen(proxyServer);
  } catch (e) {
    console.error("✗ Не удалось поднять подменённые серверы: " + e.message);
    process.exit(2);
  }
  require(path.join(ROOT, "src", "main.js"));
  await sleep(400);

  const chatHits = (p) => providerHits.filter((h) => h.phrase === p && h.kind === "chat");
  const ask = (what) => callIpc("ai:send", [{ role: "user", content: what }], { chatId: "chat-live-proxy", role: "developer" });

  console.log("\n[1] Прокси включён, локальные адреса НЕ исключены — запрос идёт через прокси");
  const saved = await callIpc("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
    autoSwitchProfiles: false,
    proxyEnabled: true,
    proxyUrl: proxyBase,
    proxyBypassLocal: false,
  });
  ok(saved && saved.proxyEnabled === true, "настройки приняты: прокси включён = " + (saved && saved.proxyEnabled));
  const seenBefore = proxySeen.length;
  phrase = "main";
  const run1 = await ask("Скажи одним предложением, что связь есть.");
  ok(run1 && run1.ok === true, "прогон через прокси дожил до конца: " + JSON.stringify(run1 && run1.error));
  ok(chatHits("main").length >= 1, "провайдер получил запрос чата: " + chatHits("main").length);
  const viaProxy = proxySeen.filter((s) => /\/chat\/completions$/.test(String(s.url).split("?")[0]));
  ok(viaProxy.length === chatHits("main").length, "через прокси прошли ВСЕ запросы чата: прокси " + viaProxy.length + ", провайдер " + chatHits("main").length);
  ok(viaProxy.length >= 1, "прокси действительно видел запросы (иначе прокси не работает вовсе)");
  // Вспомогательные запросы (окно модели у сервера) идут из окна через сеточное
  // гнездо provider-config → netFetch. Если гнездо не подставлено, они уйдут голым
  // fetch и останутся мимо прокси — тогда часть связи из России тихо отвалится.
  const viaProxyModels = proxySeen.filter((s) => /\/models$/.test(String(s.url).split("?")[0])).length;
  const providerModels = providerHits.filter((h) => h.phrase === "main" && h.kind === "models").length;
  ok(
    providerModels >= 1 && viaProxyModels === providerModels,
    "вспомогательные запросы (окно модели) тоже через прокси: прокси " + viaProxyModels + ", провайдер " + providerModels
  );
  ok(viaProxy.some((s) => s.kind === "absolute"), "http-цель пошла запросом в абсолютной форме, как и должна");
  if (process.env.DEBUG_PROXY) {
    console.log("  ℹ прокси видел: " + JSON.stringify(proxySeen.map((s) => s.kind + " " + s.url)));
    console.log("  ℹ провайдер получил: " + JSON.stringify(providerHits.map((h) => h.phrase + " " + h.kind)));
  }
  const text1 = events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === "chunk").map((e) => e.ev.text).join("");
  ok(/Проверка связи прошла/.test(text1), "ответ провайдера доехал до чата через прокси: " + JSON.stringify(text1.slice(0, 80)));
  ok(events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === "error").length === 0, "ошибок в чат не пришло");

  console.log("\n[2] Цель локальная (свой Ollama) — мимо прокси, даже когда прокси включён");
  await callIpc("settings:set", { proxyBypassLocal: true });
  const seenBeforeLocal = proxySeen.length;
  phrase = "local";
  const run2 = await ask("Скажи одним предложением, что связь есть.");
  ok(run2 && run2.ok === true, "прогон к локальному провайдеру прошёл: " + JSON.stringify(run2 && run2.error));
  ok(providerHits.some((h) => h.phrase === "local" && h.kind === "chat"), "локальный провайдер получил запрос чата");
  ok(proxySeen.length === seenBeforeLocal, "прокси не увидел НИ ОДНОГО нового запроса: " + (proxySeen.length - seenBeforeLocal));
  ok(providerHits.filter((h) => h.phrase === "local").length >= 1, "запрос дошёл до провайдера напрямую");

  console.log("\n[3] Прокси выключен — прежнее поведение, напрямую");
  await callIpc("settings:set", { proxyEnabled: false });
  const seenBeforeOff = proxySeen.length;
  phrase = "off";
  const run3 = await ask("Скажи одним предложением, что связь есть.");
  ok(run3 && run3.ok === true, "прогон с выключенным прокси прошёл: " + JSON.stringify(run3 && run3.error));
  ok(providerHits.some((h) => h.phrase === "off" && h.kind === "chat"), "провайдер получил запрос");
  ok(proxySeen.length === seenBeforeOff, "с выключенным прокси прокси не тронут: " + (proxySeen.length - seenBeforeOff));

  console.log("\n[4] Канал проверки прокси из окна отвечает словами");
  const bad = await callIpc("settings:testProxy", { proxyUrl: "не адрес" });
  ok(bad && bad.ok === false, "мусор на месте адреса не признан рабочим прокси");
  ok(/не разобран/i.test((bad && bad.error) || ""), "объяснение словами: " + JSON.stringify((bad && bad.error || "").slice(0, 90)));
  // Окно может не прислать адрес вовсе — тогда канал берёт СОХРАНЁННЫЙ. Стираем его,
  // чтобы проверка не пошла в настоящий интернет, и убеждаемся в честном отказе.
  await callIpc("settings:set", { proxyUrl: "" });
  const empty = await callIpc("settings:testProxy", {});
  ok(empty && empty.ok === false, "пустой адрес тоже честно отказывает: " + JSON.stringify((empty && empty.error) || ""));
  ok(/не разобран/i.test((empty && empty.error) || ""), "и объясняет, чего не хватает");

  console.log("\n[5] Ничего не осталось висеть");
  ok(global.__agentRunning === false, "признак прогона снят");
  ok(global.__agentStopRequested === false && global.__agentPauseRequested === false, "флаги остановки сняты");

  try {
    provider.close();
  } catch {}
  try {
    proxyServer.close();
  } catch {}
  console.log("\nИтог: " + (failures ? failures + " проверок упало" : "все проверки прошли") + " (прокси видел: " + proxySeen.length + ", провайдер получил: " + providerHits.length + ")");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("✗ Прогон упал: " + ((e && e.stack) || e));
  try { provider.close(); } catch {}
  try { proxyServer.close(); } catch {}
  process.exit(1);
});

"use strict";
/* ─── Живой прогон сети и проверок доступности (без окна) ──────────────────────
   Запуск: npm run test:live:tools-net   (node scripts/live-tools-net.js)

   Зачем этот прогон. Семь обработчиков (checkUrl, checkPort, listPorts, webSearch,
   webFetch, apiRequest, downloadAndExtract) уехали своим модулем (часть 40, заход 6a).
   Это инструменты про НАРУЖНОЕ: отвечает ли адрес, кто слушает порт, что вернул API,
   распаковался ли архив. Текстовый сторож здесь не значит ничего.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-net.js;
     • НАСТОЯЩИЙ HTTP-сервер на 127.0.0.1 (порт выбирает система), который отдаёт
       JSON-эхо запроса, HTML-страницу, сжатый tar-архив и не-архив.

   Наружу сеть не нужна: всё бьёт в свой сервер или в закрытый порт. webSearch —
   единственный, кто ходит в интернет; для него проверяется ЧЕСТНОСТЬ формы ответа
   (результаты / «не дал результатов» / понятная ошибка), а не наличие связи. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const http = require("http");
const zlib = require("zlib");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-net-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-net-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 1).join(" | ").slice(0, 110);
const info = (msg) => console.log("  · " + msg);

function writeSettings(over) {
  const s = Object.assign({ workingDir: work, model: "test-model", provider: "openai" }, over || {});
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Настоящий архив: tar + gzip собираем сами (ничего не качаем извне) ──────
function tarFile(name, content) {
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
}
const ARCHIVE_TEXT = "распаковалось верно\n";
const TAR_GZ = zlib.gzipSync(Buffer.concat([tarFile("progon.txt", ARCHIVE_TEXT), Buffer.alloc(1024)]));

// ── Настоящий сервер: JSON-эхо, страница, архив, не-архив, 404 ─────────────
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/ok") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      // Заголовки отдаём целиком: так прогон видит, что переданные заголовки доехали.
      res.end(JSON.stringify({ method: req.method, contentType: req.headers["content-type"] || "", headers: req.headers, body }));
    });
    return;
  }
  if (u.pathname === "/page.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><head><title>Прогон сети</title></head><body><h1>Живой заголовок</h1><p>Текст страницы для чтения.</p><script>var x=1;</script></body></html>");
    return;
  }
  if (u.pathname === "/pkg.tar.gz") {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(TAR_GZ);
    return;
  }
  if (u.pathname === "/notarchive.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("это не архив");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("нет такой страницы");
});

// ── Поддельный electron: окно в прогоне не нужно ───────────────────────────
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: { id, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

const seen = { net: 0, netDeps: null, netArgs: 0, netTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.199", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  // Перехват только по имени файла: подстрока «agent-tools» заглатывала бы соседей
  // по дому (эта ошибка уже стоила двух молчавших прогонов — см. заход 4.1).
  if (/agent-tools-net\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createNetTools: function (deps) {
        seen.net++;
        seen.netDeps = deps;
        seen.netArgs = arguments.length;
        seen.netTools = real.createNetTools(deps);
        return seen.netTools;
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolDeps = deps;
        seen.tools = real.createAgentTools(deps);
        return seen.tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seen.api = real.createToolRegistry(deps);
        return seen.api;
      },
      describeToolArgs: real.describeToolArgs,
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 180 секунд");
  process.exit(1);
}, 180000);
watchdog.unref();

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон сети и проверок доступности (настоящий main.js, настоящий сервер на порту " + port + ")");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);

  try {
    console.log("\n[1] проводка: модуль собран один раз с тем же состоянием");
    ok(seen.net === 1, "createNetTools вызван " + seen.net + " раз(а)");
    ok(seen.netDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
    ok(seen.netArgs === 1, "модулю передан только deps (живого моста не нужно): аргументов " + seen.netArgs);
    const names = ["checkUrl", "checkPort", "listPorts", "webSearch", "webFetch", "apiRequest", "downloadAndExtract"];
    const missing = names.filter((n) => typeof (seen.netTools || {})[n] !== "function");
    ok(missing.length === 0, "все семь инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const refs = names.filter((n) => seen.tools[n] !== seen.netTools[n]);
    ok(refs.length === 0, "в реестре именно ссылки на модуль, а не копии" + (refs.length ? ": расходятся " + refs.join(", ") : ""));

    console.log("\n[2] checkUrl: отвечает ли адрес");
    const okUrl = plain(await call("checkUrl", { url: base + "/ok" }));
    ok(/Статус: 200/.test(okUrl), "живой сервер отозвался 200: " + oneLine(okUrl));
    ok(/Content-Type: application\/json/.test(okUrl), "тип ответа назван: " + oneLine(okUrl.split("\n")[2]));
    ok(/Размер тела: \d+ символов/.test(okUrl), "размер тела измерен");
    const notFound = plain(await call("checkUrl", { url: base + "/nope" }));
    ok(/Статус: 404/.test(notFound), "404 назван кодом, а не «не работает»: " + oneLine(notFound.split("\n")[1]));
    const dead = plain(await call("checkUrl", { url: "http://127.0.0.1:1/" }));
    ok(/сервер не ответил/.test(dead), "закрытый порт объяснён: " + oneLine(dead));
    ok(/укажи полный URL/.test(plain(await call("checkUrl", { url: "localhost:3000" }))), "адрес без схемы отвергнут понятным текстом");
    const meta = plain(await call("checkUrl", { url: "http://169.254.169.254/latest/meta-data/" }));
    ok(!/Статус: 200/.test(meta), "адрес облачных метаданных не отдан как успешный ответ: " + oneLine(meta));

    console.log("\n[3] checkPort: кто слушает");
    const busy = plain(await call("checkPort", { port }));
    ok(/занят/.test(busy), "наш живой порт " + port + " назван занятым: " + oneLine(busy));
    const free = plain(await call("checkPort", { port: 1 }));
    ok(/свободен/.test(free), "закрытый порт назван свободным: " + oneLine(free));
    ok(/укажи корректный порт/.test(plain(await call("checkPort", { port: 99999 }))), "негодный номер порта отвергнут");

    console.log("\n[4] listPorts: настоящий список слушателей");
    const ports = plain(await call("listPorts", {}));
    ok(new RegExp(":" + port + "\\b").test(ports), "наш слушатель виден в списке портов (порт " + port + ")");
    ok(/Слушающие порты:/.test(ports) && ports.split("\n").length > 1, "список не пустой и назван по-человечески");
    if (!new RegExp(":" + port + "\\b").test(ports)) info("вывод списка: " + oneLine(ports, 4));

    console.log("\n[5] apiRequest: запрос с телом и заголовками");
    const post = plain(await call("apiRequest", { url: base + "/ok", method: "POST", body: { hello: "прогон" } }));
    ok(/HTTP 200/.test(post), "POST вернул 200: " + oneLine(post));
    ok(/\"method\":\"POST\"/.test(post), "сервер получил именно POST");
    ok(/\"body\":\"\{\\\"hello\\\":\\\"прогон\\\"\}\"/.test(post), "тело доехало целиком, в UTF-8: " + oneLine(post.split("\n").slice(-1)[0]));
    ok(/application\/json/.test(post), "объект в body ушёл с Content-Type: application/json");
    // Значение заголовка — ASCII: fetch справедливо отказывает заголовкам с кириллицей,
    // и первая версия этой проверки падала из-за самой пробы, а не из-за инструмента.
    const getHeaders = plain(await call("apiRequest", { url: base + "/ok", headers: { "X-Progon": "yes" } }));
    ok(/\"method\":\"GET\"/.test(getHeaders), "по умолчанию GET");
    ok(/\"x-progon\":\"yes\"/.test(getHeaders), "свой заголовок доехал до сервера");
    ok(/укажи полный URL/.test(plain(await call("apiRequest", { url: "ftp://x/y" }))), "не-http адрес отвергнут");
    ok(/Ошибка GET/.test(plain(await call("apiRequest", { url: "http://127.0.0.1:1/x" }))), "недоступный адрес объяснён, а не проглочен");

    console.log("\n[6] webFetch: страница текстом");
    const page = plain(await call("webFetch", { url: base + "/page.html" }));
    ok(/Живой заголовок/.test(page), "текст страницы прочитан: " + oneLine(page));
    ok(/Текст страницы для чтения/.test(page), "содержимое абзаца доехало");
    ok(!/<html>|<script>/.test(page), "разметка и скрипты в ответ не попали");

    console.log("\n[7] webSearch: честная форма ответа (интернет не обязателен)");
    const search = plain(await call("webSearch", { query: "живой прогон сети" }));
    ok(/Результаты поиска по|Поиск не дал результатов|Ошибка|не удалось/i.test(search), "ответ либо с результатами, либо с объяснением: " + oneLine(search));

    console.log("\n[8] downloadAndExtract: настоящий архив с настоящего сервера");
    const destDir = path.join(work, "downloads");
    const dl = plain(await call("downloadAndExtract", { url: base + "/pkg.tar.gz", path: destDir }));
    ok(/OK — скачано и распаковано/.test(dl), "архив скачан и распакован: " + oneLine(dl));
    const unpacked = fs.existsSync(path.join(destDir, "progon.txt"))
      ? fs.readFileSync(path.join(destDir, "progon.txt"), "utf8")
      : "";
    ok(unpacked.indexOf(ARCHIVE_TEXT.trim()) >= 0, "файл из архива лежит на диске с верным содержимым" + (unpacked ? "" : " (его нет)"));
    const notArchive = plain(await call("downloadAndExtract", { url: base + "/notarchive.txt", path: path.join(work, "dl2") }));
    ok(/Не похоже на архив/.test(notArchive), "не-архив отвергнут с объяснением: " + oneLine(notArchive));
    // Пустая папка после неудачной распаковки — не мусор, а пустая папка: проверяем,
    // что в ней не осталось ФАЙЛОВ (первая версия проверки была строже смысла).
    const dl2 = path.join(work, "dl2");
    const dl2Files = fs.existsSync(dl2) ? fs.readdirSync(dl2) : [];
    ok(dl2Files.length === 0, "неудачная распаковка не оставила файлов: " + (dl2Files.join(", ") || "чисто"));

    console.log("\n[9] гигиена прогона");
    ok(server.listening, "сервер прогона был живым всё это время");
  } finally {
    await new Promise((r) => server.close(r));
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки сети и проверок доступности пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})();

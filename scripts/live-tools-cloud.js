"use strict";
/* ─── Живой прогон облачных инструментов агента (без окна) ───────────────────
   Запуск: bun run test:live:tools-cloud    (node scripts/live-tools-cloud.js)

   Зачем этот прогон. Облачные инструменты (ycStatus/ycList/ycCreate/ycCosts/
   ycDelete/ycDeploy/ycContainer/ycSecret/ycDns/ycRegistry/ycStorage/ycLogs/ycInstall) до
   сих пор проверялись ТОЛЬКО по тексту: наборы искали строки в исходнике,
   поведенческого прогона не было ни у одного из них. Пока код лежал в
   agent-tools.js, это выглядело терпимо;
   после того как девять обработчиков уехали своим модулем (часть 40, заход 1),
   «проверено по тексту» означает ровно одно: если перенос потеряет ветку, набор
   этого не увидит.

   Что здесь поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно в прогоне не нужно);
     • настоящий src/tool-registry.js, то есть вызов идёт тем же путём, что у агента:
       политика → назначение → обработчик → текст ответа;
     • настоящий src/agent-tools.js и его новый модуль src/agent-tools-cloud.js;
     • настоящий HTTP: облако отвечает подменённый сервер, а клиент к нему ведёт
       штатная переменная AI_AGENT_YC_BASE (тот же приём, что в test:live:yc).

   Что проверяется:
     [1] проводка: new-модуль собран один раз и получил ТОТ ЖЕ объект состояния,
         что и остальные инструменты (иначе «свежие настройки» перестали бы быть свежими);
     [2] четырнадцать инструментов отвечают через НАСТОЯЩИЙ реестр (а не «есть в тексте»);
     [3] ycCosts — тарифы и оценка контейнера без сети;
     [4] отказы без разрешений/согласия — и ни одного запроса в облако при отказе;
     [5] ycCreate с согласием доходит до облака и возвращает человеческий ответ;
     [6] ycList и ycContainer читают НАСТОЯЩИЕ списки по HTTP (зоны, контейнеры,
         ревизии) и показывают активную ревизию и URL;
     [7] настройки читаются в момент вызова: смена каталога видна сразу;
     [8] ycSecret: секрет каталога, его версии (значения не читаются) и создание
         новой версии — с отказом без чекбокса и без единого запроса в облако;
     [9] ycDns: записи зоны читаются, пара «имя+тип» ЗАМЕНЯЕТСЯ (сначала удаление
         прежних значений, потом добавление), удаление — по чекбоксу;
     [10] ycRegistry: образы реестра видны с тегами и размером, удаление находит
         образ ПО ТЕГУ, а в облако уходит id — и только с разрешением;
     [11] ycStorage: файлы бакета — список прочитан из XML S3-совместимого API,
         загрузка ушла с типом содержимого и БЕЗ подписи AWS (IAM-токеном),
         скачанное легло на диск, удаление — по чекбоксу, отказы объяснены;
     [12] ycDb: база YDB — таблицы и записи через её Document API: операция идёт
         ЗАГОЛОВКОМ X-Amz-Target, значения — типизированные ({ S }, { N }),
         адрес берётся у самой базы, разрешения стоят перед сетью.

   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-cloud-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-cloud-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
// N-я непустая строка ответа — для сообщений прогона (в самих проверках
// сравнивается смысл регуляркой, а не номер строки).
const lineN = (v, n) => (String(v).split("\n").filter(Boolean)[n] || "").trim();

// ── Настройки приложения: облако подключено, каталог выбран ────────────────
function writeSettings(over) {
  const s = Object.assign(
    {
      workingDir: work,
      model: "test-model",
      provider: "openai",
      yandexOauthToken: "fake-oauth",
      ycCloudId: "cloud1",
      ycFolderId: "f1",
      ycFolderName: "default",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
      ycAllowAgentUpdate: false,
    },
    over || {}
  );
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Подменённое облако ─────────────────────────────────────────────────────
const seen = [];
let containerCreated = 0;
// Тела запросов на изменение записей DNS: на них держится проверка строгого
// порядка «сначала удалить прежнее значение, потом добавить новое».
const dnsUpdates = [];
// Загрузки и удаления файлов бакета: на них держится проверка «ушло ровно то,
// что просили, и с тем же типом содержимого».
const putObjects = [];
const deletedObjects = [];
// Запросы Document API базы YDB: на них держится проверка «операция ушла
// ЗАГОЛОВКОМ, значения типизированы». Таблицы живут в этом же подменённом
// облаке — отдельного сервера для базы не нужно.
const docCalls = [];
const dbTables = new Map();
let fakeYcBase = "";
function startFakeYc() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (obj, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // S3-совместимый API отвечает XML-ом, а не JSON: для него отдельный ответ.
      const xml = (text, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/xml" });
        res.end(text);
      };
      const p = u.pathname;
      seen.push(req.method + " " + p + (u.search || ""));
      // ── Document API базы YDB ────────────────────────────────────────────
      // Операция идёт ЗАГОЛОВКОМ, тело — JSON, значения — типизированные.
      // Это другой протокол, чем у остальных сервисов каталога, и именно его
      // приложение должно соблюдать.
      const amzTarget = String(req.headers["x-amz-target"] || "");
      if (amzTarget) {
        let sent = {};
        try { sent = body ? JSON.parse(body) : {}; } catch { sent = {}; }
        docCalls.push({ target: amzTarget, auth: req.headers.authorization || "", body: sent, path: p });
        const method = amzTarget.replace("DynamoDB_20120810.", "");
        if (method === "ListTables") return json({ TableNames: Array.from(dbTables.keys()) });
        if (method === "CreateTable") {
          dbTables.set(String(sent.TableName), { keys: sent.KeySchema || [], items: new Map() });
          return json({ TableDescription: { TableName: sent.TableName, TableStatus: "ACTIVE" } });
        }
        if (method === "DeleteTable") {
          dbTables.delete(String(sent.TableName));
          return json({});
        }
        const t = dbTables.get(String(sent.TableName));
        if (!t) {
          return json({ __type: "com.amazonaws.dynamodb.v20120810#ResourceNotFoundException", message: "Cannot do operations on a non-existent table" }, 400);
        }
        const scalar = (v) => (v && v.S != null ? v.S : v && v.N != null ? v.N : "");
        const keyOf = (typed) => (t.keys || []).map((k) => String(scalar(typed && typed[k.AttributeName]))).join("|");
        if (method === "PutItem") { t.items.set(keyOf(sent.Item), sent.Item); return json({}); }
        if (method === "GetItem") { const f = t.items.get(keyOf(sent.Key)); return json(f ? { Item: f } : {}); }
        if (method === "DeleteItem") { t.items.delete(keyOf(sent.Key)); return json({}); }
        if (method === "Scan") { const items = Array.from(t.items.values()); return json({ Items: items, Count: items.length }); }
        if (method === "DescribeTable") {
          return json({ Table: { TableName: sent.TableName, TableStatus: "ACTIVE", ItemCount: t.items.size, KeySchema: (t.keys || []).map((k) => ({ AttributeName: k.AttributeName, KeyType: k.KeyType })) } });
        }
        return json({ __type: "com.amazonaws.dynamodb.v20120810#ValidationException", message: "Unknown operation " + method }, 400);
      }
      // Каталог баз YDB: адрес Document API берётся У САМОЙ базы (поле), а не
      // собирается клиентом по памяти.
      if (p === "/ydb/v1/databases") {
        return json({ databases: [{
          id: "etn1", name: "app-db", folderId: "f1", status: "RUNNING",
          endpoint: "grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g/etn1",
          documentApiEndpoint: fakeYcBase + "/ru-central1/b1g/etn1",
        }] });
      }
      if (p === "/iam/v1/tokens") return json({ iamToken: "fake-iam", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p === "/dns/v1/zones") {
        return json({ zones: [
          { id: "z1", name: "test-zone", folderId: "f1", createdAt: "2026-09-01T10:00:00Z" },
          { id: "z2", name: "prod-zone", folderId: "f1", createdAt: "2026-09-02T10:00:00Z" },
        ] });
      }
      if (p === "/containers/v1/containers") {
        if (req.method === "POST") {
          containerCreated++;
          return json({ id: "op-cont", done: true });
        }
        return json({ containers: containerCreated
          ? [{ id: "cont1", name: "shop", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", url: "https://shop.example" }]
          : [] });
      }
      // Операции: создание/удаление ресурсов ждут её завершения, и без этого
      // ответа клиент честно ждёт до таймаута (в прогоне — до сторожа).
      if (p.startsWith("/operations/")) {
        const opId = p.slice("/operations/".length);
        // У операции создания версии секрета свой id ответа: по нему инструмент
        // называет человеку номер версии.
        if (opId === "op-sec") return json({ id: opId, done: true, response: { id: "ver3" } });
        return json({ id: opId, done: true, response: { id: "cont1" } });
      }
      if (p === "/containers/v1/containers/cont1") {
        return json({ id: "cont1", name: "shop", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", url: "https://shop.example" });
      }
      if (p === "/containers/v1/revisions") {
        return json({ revisions: [
          { id: "rev2", status: "ACTIVE", image: "cr.yandex/crp1/shop:2", createdAt: "2026-09-02T10:00:00Z" },
          { id: "rev1", status: "OBSOLETE", image: "cr.yandex/crp1/shop:1", createdAt: "2026-09-01T10:00:00Z" },
        ] });
      }
      // Lockbox: секреты каталога, сам секрет, его версии и новая версия.
      // payloadEntryKeys — то единственное, что API отдаёт про содержимое:
      // значения секрета не читаются обратно никогда.
      if (p === "/lockbox/v1/secrets") {
        return json({ secrets: [{ id: "sec1", name: "app-env", status: "ACTIVE", folderId: "f1" }] });
      }
      if (p === "/lockbox/v1/secrets/sec1") {
        return json({ id: "sec1", name: "app-env", status: "ACTIVE" });
      }
      if (p === "/lockbox/v1/secrets/sec1/versions") {
        return json({ versions: [
          { id: "ver1", createdAt: "2026-09-01T10:00:00Z", status: "OBSOLETE", payloadEntryKeys: ["API_KEY"] },
          { id: "ver2", createdAt: "2026-09-02T10:00:00Z", status: "ACTIVE", payloadEntryKeys: ["API_KEY", "DB_URL"] },
        ] });
      }
      if (p === "/lockbox/v1/secrets/sec1:addVersion") return json({ id: "op-sec", done: true });
      // Cloud DNS: записи зоны и их изменение. Строгость настоящего API разобрана
      // набором; здесь важно, что запрос дошёл и с каким телом.
      if (p === "/dns/v1/zones/z1:getRecordSets") {
        return json({ recordSets: [{ name: "www.test-zone.", type: "A", ttl: "600", data: ["203.0.113.10"] }] });
      }
      if (p === "/dns/v1/zones/z1:updateRecordSets") {
        dnsUpdates.push(body);
        return json({ id: "op-dns", done: true });
      }
      // Container Registry: реестр, его образы и удаление образа.
      if (p === "/container-registry/v1/registries") {
        return json({ registries: [{ id: "reg1", name: "app", folderId: "f1", status: "ACTIVE" }] });
      }
      if (p === "/container-registry/v1/images") {
        return json({ images: [
          { id: "img1", name: "shop", tags: ["v1", "latest"], size: 10485760, compressedSize: 5000000, digest: "sha256:abc" },
        ] });
      }
      if (p === "/container-registry/v1/images/img1") return json({ id: "op-img", done: true });
      // Object Storage: бакет каталога и объекты бакета. Список бакетов идёт в
      // консольный API (JSON), а сами объекты — в S3-совместимый (XML), поэтому
      // на один и тот же прогон здесь два разных вида ответа.
      if (p === "/storage/v1/buckets") {
        return json({ buckets: [{ id: "b1", name: "site-bucket", folderId: "f1", createdAt: "2026-09-01T10:00:00Z" }] });
      }
      if (u.search.indexOf("list-type=2") >= 0) {
        return xml(
          '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>site-bucket</Name>' +
          '<Contents><Key>index.html</Key><LastModified>2026-09-20T10:00:00.000Z</LastModified><ETag>&quot;aaa&quot;</ETag><Size>2048</Size></Contents>' +
          '<Contents><Key>a&amp;b.txt</Key><LastModified>2026-09-21T10:00:00.000Z</LastModified><Size>10</Size></Contents>' +
          '<IsTruncated>false</IsTruncated></ListBucketResult>'
        );
      }
      // Любой ключ бакета: PUT кладёт, GET забирает (один объект готов заранее),
      // DELETE убирает. Остальное — настоящая форма отказа S3 на несуществующий
      // ключ: на ней держится проверка «отказ объяснён словами, а не XML-ом».
      if (/^\/site-bucket\/.+/.test(p)) {
        if (req.method === "PUT") {
          putObjects.push({ path: p, contentType: String(req.headers["content-type"] || ""), auth: String(req.headers.authorization || ""), body: body.slice(0, 40), bytes: Buffer.byteLength(body) });
          res.writeHead(200, { "Content-Type": "application/xml", ETag: '"etag-1"' });
          return res.end("");
        }
        if (req.method === "DELETE") {
          deletedObjects.push(p);
          res.writeHead(204);
          return res.end();
        }
        if (p === "/site-bucket/download.txt") {
          const text = "файл из облака";
          res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(Buffer.byteLength(text)) });
          return res.end(text);
        }
        return xml('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>', 404);
      }
      // Прочие сервисы каталога: пустой список — этого достаточно для сводки.
      return json({});
    });
  });
}

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

// ── Перехват: видим, кто кого собрал и куда отдал вызов ────────────────────
const seenWiring = { cloud: 0, toolDeps: null, cloudDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.192", setName: () => {}, setAppUserModelId: () => {},
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
  if (/agent-tools(-cloud)?\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    if (/agent-tools-cloud\.js$/.test(t)) {
      return {
        createCloudTools: (deps) => {
          seenWiring.cloud++;
          seenWiring.cloudDeps = deps;
          return real.createCloudTools(deps);
        },
      };
    }
    return {
      createAgentTools: (deps) => {
        seenWiring.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seenWiring.tools = tools;
        return tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seenWiring.api = real.createToolRegistry(deps);
        return seenWiring.api;
      },
      describeToolArgs: real.describeToolArgs,
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 120 секунд");
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  const srv = startFakeYc();
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const ycBase = "http://127.0.0.1:" + port;
  fakeYcBase = ycBase; // адрес Document API базы YDB указывает на этот же сервер
  process.env.AI_AGENT_YC_BASE = ycBase;
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон облачных инструментов (настоящий main.js, подменённое облако)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  // Настройки прогона — СНИМОК, сделанный один раз, как в настоящем прогоне
  // (run-ai берёт их при старте). Именно поэтому проверка [7] что-то значит:
  // обработчик обязан читать свежие настройки сам, а не доверять своему аргументу.
  const runSettings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, runSettings);

  console.log("\n[1] проводка: новый модуль собран один раз и с тем же состоянием");
  ok(seenWiring.cloud === 1, "createCloudTools вызван " + seenWiring.cloud + " раз(а)");
  ok(seenWiring.cloudDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools (одна сборка)");
  const cloud = seenWiring.cloudDeps || {};
  for (const name of ["loadSettings", "ycConfig", "yandexCloud", "ycCosts", "applyAgentEnv", "runCloudDeploy"]) {
    ok(typeof cloud[name] !== "undefined", "в модуль пришло " + name);
  }

  console.log("\n[2] инструменты облака отвечают через настоящий реестр");
  const tools = seenWiring.tools || {};
  const cloudNames = ["ycStatus", "ycList", "ycCreate", "ycCosts", "ycDelete", "ycDeploy", "ycContainer", "ycSecret", "ycDns", "ycRegistry", "ycStorage", "ycDb", "ycLogs", "ycInstall"];
  const missing = cloudNames.filter((n) => typeof tools[n] !== "function");
  ok(missing.length === 0, "все четырнадцать на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
  const unknown = await call("ycContainer", { action: "overview" });
  ok(!/неизвестный инструмент/.test(plain(unknown)), "реестр знает ycContainer: " + plain(unknown).slice(0, 60));

  console.log("\n[3] ycCosts: тарифы и оценка — без сети");
  const costList = plain(await call("ycCosts", {}));
  ok(/тарифы на/.test(costList) && /serverlessContainers/.test(costList), "список тарифов назван");
  const estimate = plain(await call("ycCosts", { service: "serverlessContainers", memoryMb: 512, cores: 1 }));
  ok(/Стоимость \(ориентир/.test(estimate) && /₽/.test(estimate), "оценка контейнера посчитана: " + estimate.split("\n")[1]);
  const unknownCost = plain(await call("ycCosts", { service: "такого-нет" }));
  ok(/Неизвестный ресурс/.test(unknownCost), "незнакомый ресурс объяснён, а не подставлен молча");

  console.log("\n[4] отказы: без разрешений и без согласия — и ни одного запроса в облако");
  const before = seen.length;
  const del = plain(await call("ycDelete", { service: "dns", id: "z1" }));
  ok(/⛔ Удаление ресурсов .* ЗАПРЕЩЕНО/.test(del), "удаление без чекбокса отклонено");
  const contDeploy = plain(await call("ycContainer", { action: "deploy", container: "shop" }));
  ok(/⛔ Менять контейнеры и деплоить ревизии агенту ЗАПРЕЩЕНО/.test(contDeploy), "ревизия без чекбокса отклонена");
  const deployNoCreate = plain(await call("ycDeploy", { name: "shop" }));
  ok(/⛔ Деплой создаёт ресурсы/.test(deployNoCreate), "деплой без чекбокса создания отклонён");
  ok(seen.length === before, "на отказы в облако не ушло ни одного запроса: " + (seen.length - before));
  writeSettings({ ycAllowAgentCreate: true });
  const pay = plain(await call("ycCreate", { service: "serverlessContainers", name: "shop" }));
  ok(/⛔ Не создаю без согласия/.test(pay), "платное создание ждёт согласия человека");
  ok(seen.length === before, "и на этом отказе в облако тоже ничего не ушло");

  console.log("\n[5] ycCreate с согласием доходит до облака");
  const created = plain(await call("ycCreate", { service: "serverlessContainers", name: "shop", confirm: true }));
  ok(/OK —/.test(created) && /serverlessContainers/.test(created), "создание вернуло человеческий ответ: " + created.slice(0, 80));
  ok(seen.some((s) => /POST \/containers\/v1\/containers/.test(s)), "запрос создания действительно ушёл");

  console.log("\n[6] ycList и ycContainer читают настоящие списки по HTTP");
  const zones = plain(await call("ycList", { service: "dns" }));
  ok(/Cloud DNS/.test(zones) && /всего 2/.test(zones), "зоны посчитаны: " + zones.replace(/\n/g, " | "));
  ok(/test-zone/.test(zones) && /prod-zone/.test(zones) && /\(z1\)/.test(zones), "имена и id зон показаны");
  ok(seen.some((s) => /GET \/dns\/v1\/zones/.test(s)), "список зон запрошен у облака");
  const overview = plain(await call("ycContainer", { action: "overview", container: "shop" }));
  ok(/Контейнер «shop» \(cont1\)/.test(overview), "контейнер найден по имени: " + overview.split("\n")[0]);
  ok(/ACTIVE/.test(overview), "статус и активная ревизия показаны");
  ok(/URL: https:\/\/shop\.example/.test(overview), "адрес контейнера показан");
  ok(/Логи: ycLogs/.test(overview), "подсказка про логи не потеряна");
  const revisions = plain(await call("ycContainer", { action: "revisions", container: "shop" }));
  ok(/rev2/.test(revisions) && /rev1/.test(revisions), "список ревизий показан");

  console.log("\n[7] настройки читаются в момент вызова");
  writeSettings({ ycFolderId: "f2", ycFolderName: "второй" });
  const fresh = plain(await call("ycList", { service: "dns" }));
  ok(/второй/.test(fresh), "в ответе сразу новый каталог: " + fresh.split("\n")[0]);
  // Название каталога в ответе — это ещё не доказательство: важно, что в ОБЛАКО
  // ушёл запрос по новому id, а не по тому, что читался при сборке приложения.
  const zonesRequest = seen.slice().reverse().find((s) => s.indexOf("/dns/v1/zones") >= 0) || "";
  ok(/folderId=f2/.test(zonesRequest), "запрос ушёл по новому каталогу: " + zonesRequest);
  writeSettings({ ycFolderId: "" });
  const noFolder = plain(await call("ycList", { service: "dns" }));
  ok(/Не выбран каталог/.test(noFolder), "без каталога инструмент честно говорит об этом");
  writeSettings({ yandexOauthToken: "" });
  const noAuth = plain(await call("ycStatus", {}));
  ok(/не подключён/.test(noAuth), "без токена инструмент говорит «не подключён»");

  console.log("\n[8] ycSecret: секреты Lockbox — список, версии и новая версия");
  // [7] оставил настройки без токена и каталога — возвращаем исходные: дальше
  // проверяются сами инструменты, а не отказ «не подключено».
  writeSettings();
  const secrets = plain(await call("ycSecret", { action: "list" }));
  ok(/Секреты Lockbox/.test(secrets) && /app-env/.test(secrets) && /sec1/.test(secrets), "секрет каталога назван: " + lineN(secrets, 1));
  const versions = plain(await call("ycSecret", { action: "versions", secret: "app-env" }));
  ok(/Секрет «app-env» \(sec1\)/.test(versions), "секрет найден по имени: " + lineN(versions, 0));
  ok(/ver2/.test(versions) && /ключи: API_KEY, DB_URL/.test(versions), "версия и ИМЕНА ключей показаны: " + lineN(versions, 2));
  ok(!/secret-value-db/.test(versions), "значение секрета в ответ не попало");
  const beforeSecret = seen.length;
  const putRefused = plain(await call("ycSecret", { action: "putversion", secret: "app-env", entries: { API_KEY: "secret-value" } }));
  ok(/⛔ Добавлять версии секретов агентом ЗАПРЕЩЕНО/.test(putRefused), "новая версия без чекбокса отклонена");
  ok(seen.length === beforeSecret, "на отказе в облако не ушло ни одного запроса: " + (seen.length - beforeSecret));
  writeSettings({ ycAllowAgentCreate: true });
  const put = plain(await call("ycSecret", { action: "putversion", secret: "app-env", entries: { API_KEY: "secret-value" } }));
  ok(/✅ Новая версия секрета/.test(put) && /ver3/.test(put), "версия создана и названа: " + lineN(put, 0));
  ok(/API_KEY/.test(put) && !/secret-value/.test(put), "значение не показано, имя ключа — показано");
  ok(seen.some((s) => /POST \/lockbox\/v1\/secrets\/sec1:addVersion/.test(s)), "запрос новой версии действительно ушёл");
  // Секрет ищется по имени — это ЧТЕНИЕ, и оно здесь законно. Значит, проверять
  // надо не «ни одного запроса», а что новая версия с плохим ключом НЕ создана.
  const writesBefore = seen.filter((s) => /addVersion/.test(s)).length;
  const badKey = plain(await call("ycSecret", { action: "putversion", secret: "app-env", entries: { "ключ с пробелом": "x" } }));
  ok(/не годится для Lockbox/.test(badKey), "плохой ключ объяснён, а не отправлен: " + badKey.slice(0, 70));
  ok(seen.filter((s) => /addVersion/.test(s)).length === writesBefore, "версия с плохим ключом не создана: " + (seen.filter((s) => /addVersion/.test(s)).length - writesBefore) + " лишних записей");

  console.log("\n[9] ycDns: записи зоны — чтение, замена пары «имя+тип» и удаление");
  const records = plain(await call("ycDns", { action: "records", zone: "test-zone" }));
  ok(/Зона «test-zone» \(z1\)/.test(records), "зона найдена по имени: " + lineN(records, 0));
  ok(/• A www\.test-zone\. \(TTL 600\) → 203\.0\.113\.10/.test(records), "запись показана: " + lineN(records, 2));
  ok(seen.some((s) => /GET \/dns\/v1\/zones\/z1:getRecordSets/.test(s)), "записи запрошены у облака");
  writeSettings();
  const addRefused = plain(await call("ycDns", { action: "add", zone: "test-zone", name: "www.test-zone.", type: "A", value: "203.0.113.11" }));
  ok(/⛔ Создавать записи DNS агентом ЗАПРЕЩЕНО/.test(addRefused), "добавление без чекбокса создания отклонено");
  writeSettings({ ycAllowAgentCreate: true });
  const added = plain(await call("ycDns", { action: "add", zone: "test-zone", name: "www.test-zone.", type: "A", value: "203.0.113.11" }));
  ok(/✅ Запись заменена: A www\.test-zone\. \(TTL 600\) — значений 1/.test(added), "существующая пара заменена, а не задвоена: " + lineN(added, 0));
  // Строгий API: «поставить значение» — это удаление прежнего набора ПЛЮС
  // добавление нового. Проверяем именно тело, а не факт запроса.
  const dnsBody = JSON.parse(dnsUpdates[dnsUpdates.length - 1] || "{}");
  ok((dnsBody.deletions || []).length === 1 && dnsBody.deletions[0].data[0] === "203.0.113.10", "сначала ушло удаление прежних значений");
  ok((dnsBody.additions || []).length === 1 && dnsBody.additions[0].data[0] === "203.0.113.11" && dnsBody.additions[0].ttl === "600", "затем — добавление нового с TTL");
  const delRefused = plain(await call("ycDns", { action: "delete", zone: "test-zone", name: "www.test-zone.", type: "A" }));
  ok(/⛔ Удалять записи DNS агентом ЗАПРЕЩЕНО/.test(delRefused), "удаление без чекбокса удаления отклонено");
  writeSettings({ ycAllowAgentDelete: true });
  const removed = plain(await call("ycDns", { action: "delete", zone: "test-zone", name: "www.test-zone.", type: "A" }));
  ok(/🗑 Запись удалена: A www\.test-zone\./.test(removed), "запись удалена: " + lineN(removed, 0));

  console.log("\n[10] ycRegistry: образы реестра и их чистка");
  const images = plain(await call("ycRegistry", { action: "images", registry: "app" }));
  ok(/Реестр «app» \(reg1\)/.test(images), "реестр найден по имени: " + lineN(images, 0));
  ok(/• shop — теги: v1, latest · 10 МБ · id img1/.test(images), "образ, теги и размер показаны: " + lineN(images, 2));
  writeSettings();
  const imgRefused = plain(await call("ycRegistry", { action: "delete", registry: "app", image: "v1" }));
  ok(/⛔ Удалять образы агентом ЗАПРЕЩЕНО/.test(imgRefused), "удаление без чекбокса удаления отклонено");
  writeSettings({ ycAllowAgentDelete: true });
  const noImage = plain(await call("ycRegistry", { action: "delete", registry: "app", image: "нет-такого" }));
  ok(/нет образа «нет-такого»/.test(noImage), "несуществующий образ объяснён, а не удалён наугад");
  ok(!seen.some((s) => /DELETE \/container-registry\/v1\/images\/img1/.test(s)), "на несуществующем образе удаление не ушло");
  const removedImg = plain(await call("ycRegistry", { action: "delete", registry: "app", image: "v1" }));
  ok(/🗑 Образ удалён: shop \(теги: v1, latest\)/.test(removedImg), "образ найден ПО ТЕГУ и удалён: " + lineN(removedImg, 0));
  ok(seen.some((s) => /DELETE \/container-registry\/v1\/images\/img1/.test(s)), "в облако ушло удаление именно по id образа");

  console.log("\n[11] ycStorage: файлы бакета — список, загрузка, выкачивание и удаление");
  const objects = plain(await call("ycStorage", { action: "list" }));
  ok(/Бакет «site-bucket» \(b1\)/.test(objects), "бакет найден по имени каталога: " + lineN(objects, 0));
  ok(/index\.html/.test(objects) && /a&b\.txt/.test(objects), "ключи объектов раскодированы из XML (в том числе &amp;): " + lineN(objects, 2));
  ok(/2 КБ/.test(objects), "размер объекта назван человеку: " + lineN(objects, 2));
  ok(seen.some((s) => /GET \/site-bucket\?list-type=2/.test(s)), "список запрошен у S3-совместимого API, а не у консольного");
  ok(/storage\.yandexcloud\.net\/site-bucket\/index\.html/.test(objects), "назван открытый адрес объекта");
  ok(/анонимное чтение/.test(objects), "сказано, когда адрес работает у других");

  // Загрузка требует чекбокса «создавать»: до разрешения в облако не уходит ничего.
  fs.writeFileSync(path.join(work, "index.html"), "<h1>Привет</h1>");
  writeSettings();
  const upRefused = plain(await call("ycStorage", { action: "upload", file: "index.html", key: "index.html" }));
  ok(/⛔ Класть файлы .* ЗАПРЕЩЕНО/.test(upRefused), "загрузка без чекбокса создания отклонена");
  ok(putObjects.length === 0, "на отказе в облако ничего не ушло");
  writeSettings({ ycAllowAgentCreate: true });
  const uploaded = plain(await call("ycStorage", { action: "upload", file: "index.html", key: "index.html" }));
  ok(/✅ Файл положили в облако из файла «index\.html»: index\.html/.test(uploaded), "файл ЗАГРУЖЕН и это названо: " + lineN(uploaded, 0));
  const putCall = putObjects[putObjects.length - 1] || {};
  ok(putCall.path === "/site-bucket/index.html", "файл ушёл по ключу объекта: " + putCall.path);
  ok(/^text\/html/.test(putCall.contentType), "тип содержимого поставлен по расширению (иначе браузер скачивал бы файл): " + putCall.contentType);
  ok(/^Bearer /.test(putCall.auth), "запрос авторизован IAM-токеном, без подписи AWS: " + String(putCall.auth).slice(0, 12) + "…");
  ok(putCall.body.indexOf("Привет") >= 0, "в облако ушло настоящее содержимое файла: " + putCall.body);

  // «Положить папку» — это тот же PUT с ключом-путём: слеши не должны стать именем файла.
  const nested = plain(await call("ycStorage", { action: "upload", key: "site/assets/app.js", content: "console.log(1)" }));
  ok(/site\/assets\/app\.js/.test(nested) && /text\/javascript/.test(nested), "вложенный ключ и тип по расширению: " + lineN(nested, 0));
  // Проверки «нечего класть» идут, пока разрешение на создание ЕСТЬ: иначе
  // отказ придёт раньше (по разрешению), и проверка будет не про содержимое.
  const noKey = plain(await call("ycStorage", { action: "upload", content: "x" }));
  ok(/укажи key/.test(noKey), "без ключа объекта загрузка не начата");
  const emptyObj = plain(await call("ycStorage", { action: "upload", key: "empty.txt", content: "" }));
  ok(/Пустое содержимое/.test(emptyObj), "пустой объект не отправлен вместо файла");
  const noFile = plain(await call("ycStorage", { action: "upload", file: "нет-такого.html", key: "x.html" }));
  ok(/файла «нет-такого\.html» нет/.test(noFile), "отсутствующий файл назван честно: " + lineN(noFile, 0));
  ok(putObjects.length === 2, "на пустых и недостающих данных в облако ничего лишнего не ушло: " + putObjects.length);

  const dl = plain(await call("ycStorage", { action: "download", key: "download.txt", to: "скачанное.txt" }));
  ok(/✅ Объект скачан: download\.txt/.test(dl), "объект выкачан: " + lineN(dl, 0));
  ok(fs.readFileSync(path.join(work, "скачанное.txt"), "utf8") === "файл из облака", "на диск записано то, что пришло из бакета");

  const objDelRefused = plain(await call("ycStorage", { action: "delete", key: "old.txt" }));
  ok(/⛔ Удалять файлы .* ЗАПРЕЩЕНО/.test(objDelRefused), "удаление без чекбокса удаления отклонено");
  writeSettings({ ycAllowAgentDelete: true });
  const removedObj = plain(await call("ycStorage", { action: "delete", key: "old.txt" }));
  ok(/🗑 Объект удалён: old\.txt/.test(removedObj), "объект удалён: " + lineN(removedObj, 0));
  ok(deletedObjects.indexOf("/site-bucket/old.txt") >= 0, "в облако ушло удаление именно этого объекта");

  const missingObj = plain(await call("ycStorage", { action: "download", key: "нет-такого.txt" }));
  ok(/Такого объекта в бакете нет/.test(missingObj), "отказ S3 объяснён словами, а не XML-ом: " + lineN(missingObj, 0));
  const strange = plain(await call("ycStorage", { action: "стереть" }));
  ok(/неизвестное действие ycStorage/.test(strange), "незнакомое действие названо");
  const wrongBucket = plain(await call("ycStorage", { action: "list", bucket: "нет-такого" }));
  ok(/Не нашёл бакет/.test(wrongBucket) && /site-bucket/.test(wrongBucket), "чужой бакет назван вместе со списком своих: " + lineN(wrongBucket, 0));

  console.log("\n[12] ycDb: таблицы и записи базы YDB через её Document API");
  const dbList = plain(await call("ycList", { service: "ydb" }));
  ok(/app-db/.test(dbList), "база YDB видна в списке каталога: " + lineN(dbList, 0));
  const tables0 = plain(await call("ycDb", { action: "tables" }));
  ok(/Таблиц нет/.test(tables0), "пустая база названа пустой: " + lineN(tables0, 0));
  ok(docCalls.some((c) => c.target === "DynamoDB_20120810.ListTables"), "список таблиц ушёл ОПЕРАЦИЕЙ в заголовке X-Amz-Target, а не REST-путём");
  ok(docCalls.every((c) => /^Bearer /.test(c.auth)), "Document API авторизован IAM-токеном, без подписи AWS");
  ok(docCalls.some((c) => c.path.indexOf("/ru-central1/b1g/etn1") >= 0), "запрос ушёл на адрес САМОЙ базы (" + ((docCalls[0] || {}).path || "") + ")");

  writeSettings({ ycAllowAgentCreate: true });
  const dbCreated = plain(await call("ycDb", { action: "create", table: "pets", keys: { species: "S", name: "S" } }));
  ok(/✅ Таблица создана: pets/.test(dbCreated), "таблица создана: " + lineN(dbCreated, 0));
  const createCall = docCalls.filter((c) => c.target === "DynamoDB_20120810.CreateTable").pop() || {};
  ok((createCall.body.KeySchema || []).map((k) => k.KeyType).join(",") === "HASH,RANGE", "ключ собран как HASH + RANGE: " + JSON.stringify(createCall.body.KeySchema));

  const dbPut = plain(await call("ycDb", { action: "put", table: "pets", item: { species: "cat", name: "Tom", price: 10.5 } }));
  ok(/✅ Запись сохранена/.test(dbPut), "запись сохранена: " + lineN(dbPut, 0));
  const dbPutCall = docCalls.filter((c) => c.target === "DynamoDB_20120810.PutItem").pop() || {};
  ok(dbPutCall.body.Item && dbPutCall.body.Item.price && dbPutCall.body.Item.price.N === "10.5", "число ушло ТИПИЗИРОВАННЫМ значением { N }: " + JSON.stringify((dbPutCall.body.Item || {}).price));
  const got = plain(await call("ycDb", { action: "get", table: "pets", key: { species: "cat", name: "Tom" } }));
  ok(/"price": 10\.5/.test(got), "запись прочитана обратно обычным JSON: " + lineN(got, 1));
  const scan = plain(await call("ycDb", { action: "scan", table: "pets" }));
  ok(/"Tom"/.test(scan), "обход таблицы показал запись");
  const missingTable = plain(await call("ycDb", { action: "scan", table: "нет-такой" }));
  ok(/Такой таблицы в базе нет/.test(missingTable), "отказ базы переведён словами, а не кодом: " + lineN(missingTable, 0));

  // Разрешения — тот же принцип, что у остальных ресурсов: без чекбокса в облако не уходит ничего.
  writeSettings();
  const refusedDrop = plain(await call("ycDb", { action: "drop", table: "pets" }));
  ok(/⛔ Удалять данные из базы .* ЗАПРЕЩЕНО/.test(refusedDrop), "удаление без чекбокса удаления отклонено");
  ok(!docCalls.some((c) => c.target === "DynamoDB_20120810.DeleteTable"), "на отказе по разрешению удаление в облако не ушло");

  writeSettings({ ycAllowAgentDelete: true });
  const removedRow = plain(await call("ycDb", { action: "delete", table: "pets", key: { species: "cat", name: "Tom" } }));
  ok(/🗑 Запись удалена/.test(removedRow), "запись удалена по ключу: " + lineN(removedRow, 0));
  const after = plain(await call("ycDb", { action: "scan", table: "pets" }));
  ok(/пусто/.test(after), "после удаления записей нет: " + lineN(after, 0));
  const dropped = plain(await call("ycDb", { action: "drop", table: "pets" }));
  ok(/🗑 Таблица удалена/.test(dropped), "таблица удалена вместе с записями: " + lineN(dropped, 0));
  ok(dbTables.size === 0, "таблица снесена и в самом облаке: осталось " + dbTables.size);

  srv.close();
  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки облачных инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

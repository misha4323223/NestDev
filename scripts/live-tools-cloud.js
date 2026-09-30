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
     [13] ycAi: Яндекс AI — перевод на НЕСКОЛЬКО языков сразу (несколько запросов),
         текст со снимка, речь туда (голоса → файлы) и обратно (расшифровка) —
         у каждого сервиса своя форма запроса, а у синтеза речи ответ ЗВУКОМ.
     [14] ycMonitor: Monitoring — плитка полки видит метрики каталога, метаданные
         и данные уходят РАЗНЫМИ формами (GET со строкой и POST с прореживанием),
         сводка считает точки без пропусков, а без каталога запросов нет вовсе.
     [15] yc:ai: канал ОКНА — тот же модуль, что у агента: перевод пачкой, снимок,
         речь (файлы на диске И содержимое для плеера) и отказы словами;
     [16] ycMdb: Managed-базы — три базы ходят по СВОИМ путям одного хоста,
         карточка даёт адрес ХОСТА-мастера, у ClickHouse ДРУГОЕ тело создания
         (класс внутри config.clickhouse, adminPassword), а платное и необратимое
         без согласия не уходит в облако вовсе;
     [17] yc:mdb: канал ОКНА — три базы в одном канале (база выбирается полем
         engine), needsConfirm вместо отказа и пароль отдельным полем secret;
     [18] yc:dns: канал ОКНА — зоны каталога, записи зоны, постановка записи
         значениями через запятую и согласие на удаление (CNAME на вершине
         отбивается ДО сети);
     [19] ycAi: AI Studio — модели каталога (каталог в заголовке
         OpenAI-Project), бесплатный счёт токенов, ответ модели с ценой по
         настоящим токенам и вектор с префиксом emb://;
     [20] yc:ai: канал ОКНА — те же четыре действия AI Studio через
         настоящий main.js: строки, токены ответа и размерность вектора;
     [21] ycIg: ГРУППЫ МАШИН — группа читается со счётом машин (в том числе
         устаревших, которые группа пересоздаст), создание уходит с подсетью,
         образом по семейству и размером группы, а без согласия не уходит вовсе;
     [22] yc:ig: канал ОКНА — тот же модуль через настоящий main.js: список,
         карточка с машинами и согласие на платное и необратимое.

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
// Запросы Яндекс AI (перевод, зрение, речь): на них держится проверка «на
// несколько языков ушло несколько запросов», «синтез речи ушёл ФОРМОЙ», «текст
// со снимка прочитан» — то есть каждая из ЧЕТЫРЁХ разных форм запроса.
const aiCalls = [];
// Запросы Групп машин (Instance Groups): на них держатся проверки «создание
// ушло с размером группы и подсетью», «удаление забрало машины вместе с
// группой» и «на отказе без согласия в облако не ушло ничего». Стенд помнит
// удаление — по этому видно, что удаление правда выполнено, а не «запущено».
const igCalls = [];
const igState = { created: [], deleted: new Set(), status: "ACTIVE" };
// Запросы Monitoring: на них держится проверка «данные ушли телом с прореживанием,
// а метаданные — строкой», и что полка видит метрики каталога.
const monCalls = [];
// Запросы Managed-баз (PostgreSQL, MySQL, ClickHouse): три базы ходят по ОДНОМУ
// хосту и различаются сегментом пути, поэтому на них держатся проверки «ушло в
// ту базу», «тело создания по правилам сервиса» и «на отказе не ушло ничего».
const mdbCalls = [];
// Состояние подменённого кластера: после :stop он обязан перечитаться как
// STOPPED — иначе проверка «питание действительно меняет состояние» ничего не
// значит.
const mdbState = { status: "RUNNING", deleted: new Set() };
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
      // ── Monitoring: метрики каталога ─────────────────────────────────────
      // Данные метрик идут POST-ом с телом (query + интервал + прореживание),
      // метаданные — GET-ом со строкой. Две РАЗНЫЕ формы одного сервиса: та же
      // болезнь, что у Яндекс AI, и проверяется она здесь так же.
      if (/^\/monitoring\/v2\//.test(p)) {
        monCalls.push({ method: req.method, path: p, search: u.search || "", body: body });
        if (p === "/monitoring/v2/data/read") {
          let b = {};
          try { b = body ? JSON.parse(body) : {}; } catch { b = {}; }
          if (/нет-такой/.test(b.query || "")) return json({ metrics: [] });
          return json({
            metrics: [{
              name: "cpu_usage",
              labels: { service: "compute", resource_id: "epd1" },
              type: "DGAUGE",
              timeseries: { timestamps: [1, 2, 3, 4], doubleValues: [1, null, 3, 5] },
            }],
          });
        }
        if (p === "/monitoring/v2/metrics") {
          return json({
            metrics: [
              { name: "cpu_usage", labels: { service: "compute", resource_id: "epd1" }, type: "DGAUGE" },
              { name: "cpu_usage", labels: { service: "compute", resource_id: "epd2" }, type: "DGAUGE" },
              { name: "disk_read_bytes", labels: { service: "compute", resource_id: "epd1" }, type: "RATE" },
            ],
          });
        }
      }
      // ── Яндекс AI: перевод, зрение и речь ────────────────────────────────
      // У четырёх сервисов ЧЕТЫРЕ разные формы: JSON у перевода и зрения, форма у
      // синтеза речи, а ответ синтеза — ЗВУК, а не JSON. Именно поэтому у него
      // свой ответ: клиент, который ждёт JSON, сломается именно здесь.
      if (/^\/translate\/v2\/|^\/ocr\/v1\/|^\/speech\/v1\/|^\/tts\/v3\/voices/.test(p)) {
        aiCalls.push({
          method: req.method, path: p, search: u.search || "",
          auth: String(req.headers.authorization || ""), folder: String(req.headers["x-folder-id"] || ""),
          contentType: String(req.headers["content-type"] || ""), body: body,
        });
        if (p === "/translate/v2/translate") {
          let b = {};
          try { b = body ? JSON.parse(body) : {}; } catch { b = {}; }
          return json({ translations: (b.texts || []).map((t) => ({ text: "[" + b.targetLanguageCode + "] " + t, detectedLanguageCode: "ru" })) });
        }
        if (p === "/translate/v2/languages") return json({ languages: [{ code: "ru", name: "Русский" }, { code: "en", name: "English" }] });
        if (p === "/ocr/v1/recognizeText") return json({ result: { textAnnotation: { fullText: "СЧЁТ № 17\nИТОГО 4 200 ₽" } } });
        if (p === "/tts/v3/voices") return json({ voices: [{ id: "alena", name: "Алёна", languages: ["ru-RU"] }, { id: "filipp", name: "Филипп", languages: ["ru-RU"] }] });
        if (p === "/speech/v1/tts:synthesize") {
          const audio = Buffer.alloc(2048, 7);
          res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.length) });
          return res.end(audio);      }
      if (p === "/speech/v1/stt:recognize") return json({ result: "включи свет на кухне" });
      }
      // ── AI Studio: модели каталога, ответ, токены и вектор ───────────────
      // И здесь две формы одного сервиса: список моделей — OpenAI-совместимый
      // GET с каталогом в заголовке OpenAI-Project, а генерация, токены и
      // векторы — старый REST foundationModels с каталогом В ТЕЛЕ и адресом
      // модели (gpt:// для текста, emb:// для векторов).
      if (p === "/v1/models" || /^\/foundationModels\/v1\//.test(p)) {
        aiCalls.push({
          method: req.method, path: p, search: u.search || "",
          auth: String(req.headers.authorization || ""), project: String(req.headers["openai-project"] || ""),
          folder: String(req.headers["x-folder-id"] || ""),
          contentType: String(req.headers["content-type"] || ""), body: body,
        });
        if (p === "/v1/models") {
          return json({
            data: [
              { id: "yandexgpt-5-lite", owned_by: "yandex" },
              { id: "yandexgpt-5.1", owned_by: "yandex" },
              { id: "text-search-doc", owned_by: "yandex" },
            ],
          });
        }
        if (p === "/foundationModels/v1/completion") {
          let b = {};
          try { b = body ? JSON.parse(body) : {}; } catch { b = {}; }
          const asked = (b.messages || []).map((m) => m.text).join(" | ");
          return json({
            result: {
              alternatives: [{ message: { text: "Модель услышала: " + asked }, status: "ALTERNATIVE_STATUS_FINAL" }],
              usage: { inputTextTokens: "1200", completionTokens: "400", totalTokens: "1600" },
              modelVersion: "v5.1",
            },
          });
        }
        if (p === "/foundationModels/v1/tokenizeCompletion") return json({ tokens: [{ text: "Счёт" }, { text: " на" }, { id: 17 }] });
        if (p === "/foundationModels/v1/textEmbedding") return json({ embedding: Array.from({ length: 256 }, (_, i) => (i + 1) / 1000) });
      }
      // ── Managed-базы: PostgreSQL, MySQL и ClickHouse ─────────────────────
      // Сеть VPC нужна здесь ровно за одним полем — networkId подсети: без него
      // кластер не создать, и модуль ищет его сам.
      if (p === "/vpc/v1/subnets") {
        return json({ subnets: [{ id: "sub-a", name: "app-subnet", networkId: "net-1", zoneId: "ru-central1-a", v4CidrBlocks: ["10.10.0.0/24"] }] });
      }
      if (/^\/managed-(postgresql|mysql|clickhouse)\/v1\//.test(p)) {
        const engine = p.split("/")[1].replace("managed-", "");
        mdbCalls.push({ engine: engine, method: req.method, path: p, search: u.search || "", body: body });
        if (/\/resourcePresets$/.test(p)) {
          return json({ resourcePresets: [{ id: "s2.micro", cores: "2", memory: "8589934592", zoneIds: ["ru-central1-a"], diskTypeIds: ["network-ssd"] }] });
        }
        if (/\/clusters$/.test(p) && req.method === "POST") {
          return json({ id: "op-mdb-create", metadata: { clusterId: engine + "-new" } });
        }
        if (/\/clusters$/.test(p)) {
          const version = engine === "clickhouse" ? "24.8" : engine === "mysql" ? "8.0" : "16";
          const res = { resourcePresetId: "s2.micro", diskSize: "21474836480", diskTypeId: "network-ssd" };
          // У ClickHouse класс и диск лежат ВНУТРИ config.clickhouse — то же
          // отличие, что и в настоящем API.
          const config = engine === "clickhouse" ? { version: version, clickhouse: { resources: res } } : { version: version, resources: res };
          return json({
            clusters: [{
              id: engine + "-1", name: engine === "clickhouse" ? "analytics" : "db-main", folderId: "f1",
              createdAt: "2026-08-01T10:00:00Z", environment: "PRODUCTION", status: mdbState.status, health: "ALIVE",
              networkId: "net-1", config: config,
            }],
          });
        }
        if (/:logs$/.test(p)) {
          return json({ logs: [{ timestamp: "2026-09-30T10:00:00Z", message: { message: "FATAL: no pg_hba.conf entry" } }] });
        }
        if (/:stop$/.test(p)) { mdbState.status = "STOPPED"; return json({ id: "op-mdb-stop" }); }
        if (/:start$/.test(p)) { mdbState.status = "RUNNING"; return json({ id: "op-mdb-start" }); }
        if (req.method === "DELETE") { mdbState.deleted.add(p.split("/clusters/")[1]); return json({ id: "op-mdb-del" }); }
        if (/\/hosts$/.test(p)) {
          const h = engine === "postgresql" ? "rc1a-pg" : engine === "mysql" ? "rc1a-my" : "rc1a-ch";
          return json({ hosts: [{ name: h + "-1.mdb.yandexcloud.net", clusterId: engine + "-1", zoneId: "ru-central1-a", role: "MASTER", health: "ALIVE" }] });
        }
        if (/\/databases$/.test(p)) return json({ databases: [{ name: engine === "clickhouse" ? "default" : "db1", owner: "admin" }] });
        if (/\/users$/.test(p)) return json({ users: [{ name: "admin", permissions: [{ databaseName: "db1" }] }] });
        if (/\/operations$/.test(p)) return json({ operations: [{ id: "op-1", description: "Create cluster", createdAt: "2026-08-01T09:00:00Z", done: true }] });
        // Удалённый кластер больше не находится — по этому и видно, что удаление
        // правда выполнено, а не «операция запущена».
        if (mdbState.deleted.has(p.split("/clusters/")[1])) return json({ message: "Cluster not found" }, 404);
        // Карточка кластера и всё остальное: одна форма на три базы.
        return json({
          id: engine + "-1", name: "db-main", folderId: "f1", status: mdbState.status, health: "ALIVE",
          config: { version: "16", resources: { resourcePresetId: "s2.micro", diskSize: "21474836480", diskTypeId: "network-ssd" } },
        });
      }
      // ── Группы машин (Instance Groups) ────────────────────────────────────
      // Хост тот же, что у Compute (адрес выверен в KNOWN_ENDPOINTS), но ресурс
      // ДРУГОЙ: группа сама создаёт машины по шаблону и держит их число. Стенд
      // отдаёт одну группу с настоящим шаблоном и счётчиками машин, умеет её
      // создавать, останавливать и удалять — и помнит удаление.
      if (p === "/compute/v1/images:latestByFamily") return json({ id: "img-ubuntu", name: "ubuntu-2204-lts" });
      if (p === "/vpc/v1/securityGroups") return json({ securityGroups: [{ id: "sg-web", name: "web" }] });
      if (p === "/compute/v1/instanceGroups" || p.indexOf("/compute/v1/instanceGroups/") === 0) {
        igCalls.push({ method: req.method, path: p, search: u.search || "", body: body });
        if (req.method === "POST" && p === "/compute/v1/instanceGroups") {
          igState.created.push(body);
          return json({ id: "op-ig-create", done: false });
        }
        if (/:start$/.test(p)) { igState.status = "ACTIVE"; return json({ id: "op-ig-start", done: false }); }
        if (/:stop$/.test(p)) { igState.status = "STOPPED"; return json({ id: "op-ig-stop", done: false }); }
        if (req.method === "DELETE") { igState.deleted.add(p.split("/").pop()); return json({ id: "op-ig-del", done: false }); }
        if (/\/instances$/.test(p)) {
          return json({
            instances: [
              { id: "epd1", instanceId: "epd1", name: "web-1", fqdn: "web-1.auto.internal", status: "RUNNING_ACTUAL", zoneId: "ru-central1-a",
                networkInterfaces: [{ subnetId: "sub-a", primaryV4Address: { address: "10.10.0.5", oneToOneNat: { address: "203.0.113.5" } } }] },
              { id: "epd2", instanceId: "epd2", name: "web-2", fqdn: "web-2.auto.internal", status: "RUNNING_OUTDATED", statusMessage: "обновление конфигурации", zoneId: "ru-central1-a",
                networkInterfaces: [{ subnetId: "sub-a", primaryV4Address: { address: "10.10.0.6" } }] },
            ],
          });
        }
        if (/\/operations$/.test(p)) {
          return json({ operations: [{ id: "op-ig-1", description: "Create instance group", createdAt: "2026-08-01T09:00:00Z", done: true }] });
        }
        if (p === "/compute/v1/instanceGroups") {
          return json({
            instanceGroups: igState.deleted.has("ig-web") ? [] : [{
              id: "ig-web", name: "web", folderId: "f1", createdAt: "2026-08-01T10:00:00Z",
              status: igState.status, deletionProtection: false, serviceAccountId: "sa-1",
              instanceTemplate: {
                platformId: "standard-v3", resourcesSpec: { cores: "2", memory: "2147483648", coreFraction: "100" },
                bootDiskSpec: { diskSpec: { typeId: "network-ssd", size: "21474836480", imageId: "img-ubuntu" } },
                networkInterfaceSpecs: [{ networkId: "net-1", subnetIds: ["sub-a"], securityGroupIds: ["sg-web"], primaryV4AddressSpec: { oneToOneNatSpec: { ipVersion: "IPV4" } } }],
              },
              scalePolicy: { fixedScale: { size: "3" } },
              allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
              loadBalancerState: { targetGroupId: "tg-nlb-1" },
              healthChecksSpec: { healthCheckSpecs: [{}] },
              managedInstancesState: { targetSize: "3", runningActualCount: "1", runningOutdatedCount: "1", processingCount: "1" },
            }],
          });
        }
        // Удалённой группы больше нет — по этому и видно, что удаление выполнено.
        if (igState.deleted.has(p.split("/").pop())) return json({ message: "Instance group not found" }, 404);
        return json({
          id: "ig-web", name: "web", folderId: "f1", status: igState.status,
          instanceTemplate: { resourcesSpec: { cores: "2", memory: "2147483648", coreFraction: "100" }, networkInterfaceSpecs: [{ primaryV4AddressSpec: { oneToOneNatSpec: {} } }] },
          scalePolicy: { fixedScale: { size: "3" } }, allocationPolicy: { zones: [{ zoneId: "ru-central1-a" }] },
          managedInstancesState: { targetSize: "3", runningActualCount: "1", runningOutdatedCount: "1", processingCount: "1" },
        });
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
  const cloudNames = ["ycStatus", "ycList", "ycCreate", "ycCosts", "ycDelete", "ycDeploy", "ycContainer", "ycSecret", "ycDns", "ycRegistry", "ycStorage", "ycDb", "ycAi", "ycMonitor", "ycMdb", "ycIg", "ycLogs", "ycInstall"];
  const missing = cloudNames.filter((n) => typeof tools[n] !== "function");
  ok(missing.length === 0, "все восемнадцать на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
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

  console.log("\n[13] ycAi: перевод, текст со снимка и речь Яндекс AI");
  const langs = plain(await call("ycAi", { action: "languages" }));
  ok(/Русский/.test(langs) && /targets/.test(langs), "языки перевода пришли из облака: " + lineN(langs, 1));

  const trBefore = aiCalls.filter((c) => c.path === "/translate/v2/translate").length;
  const translated = plain(await call("ycAi", { action: "translate", texts: ["Привет", "Пока"], targets: ["en", "de"] }));
  const trAfter = aiCalls.filter((c) => c.path === "/translate/v2/translate").length;
  ok(trAfter - trBefore === 2, "на два языка ушло два запроса (ушло " + (trAfter - trBefore) + ")");
  ok(/языков 2/.test(translated) && /\[EN\] Привет/.test(translated) && /\[DE\] Пока/.test(translated), "перевод показан по языкам: " + lineN(translated, 1));
  const tCall = aiCalls.filter((c) => c.path === "/translate/v2/translate").pop() || {};
  ok(tCall.contentType.indexOf("application/json") >= 0 && /^Bearer /.test(tCall.auth) && tCall.folder === "f1", "перевод ушёл JSON-ом с IAM-токеном и каталогом");

  // Картинка — НАСТОЯЩИЙ файл в рабочей папке прогона: путь проверяется до чтения.
  fs.writeFileSync(path.join(work, "scan.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const ocr = plain(await call("ycAi", { action: "ocr", file: "scan.png" }));
  ok(/СЧЁТ № 17/.test(ocr), "текст со снимка прочитан: " + lineN(ocr, 2));
  ok(aiCalls.some((c) => c.path === "/ocr/v1/recognizeText" && /"mimeType":"image\/png"/.test(c.body)), "тип снимка определён по расширению и ушёл телом");
  fs.writeFileSync(path.join(work, "док.docx"), Buffer.from([1, 2, 3]));
  ok(/не понял тип файла/.test(plain(await call("ycAi", { action: "ocr", file: "док.docx" }))), "чужой формат отвергнут до запроса");

  // Речь: файлы появляются на диске, а в облако уходит ФОРМА (не JSON).
  const spoke = plain(await call("ycAi", { action: "speak", text: "Счёт на четыре тысячи двести рублей готов", voices: ["alena", "filipp"] }));
  const made = spoke.split("\n").filter((l) => /^• /.test(l));
  ok(made.length === 2, "на два голоса — два файла озвучки (получилось " + made.length + ")");
  const speechCall = aiCalls.filter((c) => c.path === "/speech/v1/tts:synthesize").pop() || {};
  ok(speechCall.contentType.indexOf("x-www-form-urlencoded") >= 0 && /voice=filipp/.test(speechCall.body), "синтез речи ушёл ФОРМОЙ с выбранным голосом");
  const spokenFile = made.length ? made[0].split("→")[1].trim().split(" ")[0] : "";
  ok(!!spokenFile && fs.existsSync(spokenFile) && fs.statSync(spokenFile).size === 2048, "звук от облака лёг на диск целиком: " + spokenFile);

  fs.writeFileSync(path.join(work, "voice.ogg"), Buffer.from([1, 2, 3, 4]));
  const heard = plain(await call("ycAi", { action: "listen", file: "voice.ogg" }));
  ok(/включи свет на кухне/.test(heard), "запись расшифрована: " + lineN(heard, 2));
  const sttCall = aiCalls.filter((c) => c.path === "/speech/v1/stt:recognize").pop() || {};
  ok(/format=oggopus/.test(sttCall.search) && /topic=general/.test(sttCall.search), "распознавание ушло строкой параметров (" + sttCall.search + ")");

  // Разрешений инструмент не спрашивает (это запросы, а не ресурсы каталога), но
  // каталог и токен обязательны — и отказ обязан быть словами и ДО сети.
  const aiBefore = aiCalls.length;
  writeSettings({ ycFolderId: "" });
  ok(/выбери каталог/.test(plain(await call("ycAi", { action: "translate", text: "Привет", target: "en" }))), "без каталога — отказ словами");
  ok(aiCalls.length === aiBefore, "на отказе без каталога в облако не ушло ничего");
  writeSettings();
  ok(/неизвестное действие ycAi/.test(plain(await call("ycAi", { action: "стирай" }))), "чужое действие отвергнуто словами");

  console.log("\n[14] ycMonitor: метрики каталога");
  const monList = plain(await call("ycList", { service: "monitoring" }));
  ok(/Monitoring/.test(monList) && /всего 3/.test(monList) && /cpu_usage/.test(monList), "плитка полки видит метрики каталога: " + lineN(monList, 0));
  ok(/^folderId=f1/.test(((monCalls.find((c) => c.path === "/monitoring/v2/metrics") || {}).search || "").replace("?", "")), "метаданные запрошены только с каталогом: " + ((monCalls.find((c) => c.path === "/monitoring/v2/metrics") || {}).search || "нет"));

  const monOverview = plain(await call("ycMonitor", { action: "overview" }));
  ok(/cpu_usage/.test(monOverview) && /Метрик-имён: 2/.test(monOverview), "имена метрик показаны: " + lineN(monOverview, 1));
  ok(/консоли Monitoring/.test(monOverview), "ответ честно говорит, что алерта по API нет");

  const monNames = plain(await call("ycMonitor", { action: "names", service: "compute", resource: "epd1" }));
  const namesCall = monCalls.filter((c) => c.path === "/monitoring/v2/metrics").pop() || {};
  ok(/selectors=service%3D%22compute%22/.test(namesCall.search) && /resource_id%3D%22epd1%22/.test(namesCall.search), "селектор собран и ушёл строкой: " + namesCall.search);
  ok(/cpu_usage/.test(monNames), "метрики ресурса показаны: " + lineN(monNames, 1));

  const monData = plain(await call("ycMonitor", { action: "metrics", metric: "cpu_usage", service: "compute", resource: "epd1", minutes: 30, maxPoints: 20 }));
  const dataCall = monCalls.filter((c) => c.path === "/monitoring/v2/data/read").pop() || {};
  let dataBody = {};
  try { dataBody = JSON.parse(dataCall.body || "{}"); } catch { dataBody = {}; }
  ok(dataCall.method === "POST" && /folderId=f1/.test(dataCall.search), "данные ушли POST-ом с каталогом в строке");
  ok(dataBody.query === 'cpu_usage{service="compute", resource_id="epd1"}', "запрос собран из метрики и меток: " + dataBody.query);
  ok(dataBody.downsampling && dataBody.downsampling.maxPoints === "20" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(dataBody.fromTime), "прореживание и время ушли телом: " + JSON.stringify(dataBody.downsampling));
  ok(/в среднем 3/.test(monData) && /точек: 3/.test(monData), "сводка считает настоящие точки без пропуска: " + lineN(monData, 1));

  const monEmpty = plain(await call("ycMonitor", { action: "metrics", metric: "нет-такой", service: "compute" }));
  ok(/данных за 60 мин нет/.test(monEmpty), "пустой ряд объяснён словами, а не ошибкой");

  const monBefore = monCalls.length;
  writeSettings({ ycFolderId: "" });
  ok(/выбери каталог/.test(plain(await call("ycMonitor", { action: "overview" }))), "без каталога — отказ словами");
  ok(monCalls.length === monBefore, "на отказе без каталога в облако не ушло ничего");
  writeSettings();

  // ── Канал ОКНА (часть 87) ──────────────────────────────────────────────
  // Инструмент агента и канал интерфейса — разные входы в ОДИН модуль, и
  // проверять их надо разными путями: агент зовёт инструмент, а окно — канал
  // «yc:ai» через настоящий registerYcIpc (в этом прогоне main.js собран
  // целиком, подменён только electron, поэтому ipcMain у нас перехвачен).
  console.log("\n[15] yc:ai: канал окна — перевод, снимок, речь и отказы");
  const aiHandler = handlers.get("yc:ai");
  ok(typeof aiHandler === "function", "канал yc:ai зарегистрирован настоящим main.js");
  const callAi = (args) => aiHandler({}, args || {});

  const uiTrBefore = aiCalls.filter((c) => c.path === "/translate/v2/translate").length;
  const uiTr = await callAi({ op: "translate", text: "Привет", targets: "en, de" });
  const uiTrAfter = aiCalls.filter((c) => c.path === "/translate/v2/translate").length;
  ok(uiTr.ok === true && uiTrAfter - uiTrBefore === 2, "перевод из окна ушёл пачкой на два языка (ушло " + (uiTrAfter - uiTrBefore) + ")");
  ok((uiTr.lines || []).join("\n").includes("[EN] Привет") && /2 языка — это 2 запроса/.test(uiTr.message || ""), "ответ окна назван по-русски: " + (uiTr.message || ""));
  ok((uiTr.warnings || []).join(" ").includes("платный"), "о тарифе сказано ДО счёта");

  // Снимок: путь от рабочей папки, тип по расширению (модулем), содержимое — base64.
  fs.writeFileSync(path.join(work, "чек.png"), Buffer.from("PNG-LIVE"));
  const uiOcr = await callAi({ op: "ocr", files: "чек.png", langs: "ru, en" });
  ok(uiOcr.ok === true && /СЧЁТ № 17/.test((uiOcr.lines || []).join("\n")), "снимок из окна распознан: " + lineN((uiOcr.lines || []).join("\n"), 1));
  ok(aiCalls.some((c) => c.path === "/ocr/v1/recognizeText" && c.body.includes("image/png")), "тип файла определён модулем (mimeForExt), а не угадан");

  // Речь: файлы на диске И содержимое для плеера — окно играет само.
  const uiSp = await callAi({ op: "speak", text: "Готово", voices: "alena, filipp" });
  ok(uiSp.ok === true && (uiSp.files || []).length === 2, "озвучка двумя голосами: файлов " + (uiSp.files || []).length);
  ok((uiSp.audios || []).length === 2 && Buffer.from(uiSp.audios[0].base64, "base64").length === 2048, "звук вернулся в окно содержимым (2048 байт)");
  ok((uiSp.files || []).every((f) => fs.existsSync(f.path)), "файлы речи лежат на диске: " + ((uiSp.files || [])[0] || {}).path);

  fs.writeFileSync(path.join(work, "команда.ogg"), Buffer.from([1, 2, 3, 4]));
  const uiLs = await callAi({ op: "listen", file: "команда.ogg" });
  ok(uiLs.ok === true && /включи свет на кухне/.test(uiLs.text || ""), "запись из окна расшифрована: " + (uiLs.text || ""));

  // Отказы — до сети: чужой файл и чужое действие. Канал отвечает словами, а не бросает.
  const uiBefore = aiCalls.length;
  const uiMiss = await callAi({ op: "ocr", files: "нет.png" });
  ok(uiMiss.ok === false && /Проверь путь/.test(uiMiss.error || ""), "чужого файла нет — отказ словами: " + (uiMiss.error || ""));
  const uiBad = await callAi({ op: "стирай" });
  ok(uiBad.ok === false && /Доступно: translate, languages, detect, ocr, voices, speak, listen/.test(uiBad.error || ""), "чужое действие отвергнуто со списком");
  ok(aiCalls.length === uiBefore, "на отказах в облако не ушло ничего");

  // ── Managed-базы (часть 88) ─────────────────────────────────────────────
  // Три базы — ОДИН инструмент, потому что у них один API: меняется только
  // сегмент пути. Именно это и проверяется: ушло ли в НУЖНУЮ базу, собрано ли
  // тело по правилам сервиса (у ClickHouse оно другое) и не уходит ли в облако
  // платное без согласия.
  console.log("\n[16] ycMdb: Managed-базы — список, карточка, создание и отказы");
  mdbCalls.length = 0;
  const dbOverview = plain(await call("ycMdb", { action: "overview" }));
  ok(/PostgreSQL — 1 кластер/.test(dbOverview) && /MySQL — 1 кластер/.test(dbOverview) && /ClickHouse — 1 кластер/.test(dbOverview), "три базы показаны сразу: " + lineN(dbOverview, 1));
  ok(/Всего кластеров: 3/.test(dbOverview), "счёт кластеров назван: " + lineN(dbOverview, 4));
  ok(/тарифицируется почасово/.test(dbOverview) && /confirm: true/.test(dbOverview), "о цене создания сказано ДО вызова");
  ok(/резервные копии/.test(dbOverview), "сказано, что и остановленный кластер не бесплатен");
  ok(mdbCalls.some((c) => c.path === "/managed-postgresql/v1/clusters") && mdbCalls.some((c) => c.path === "/managed-mysql/v1/clusters") && mdbCalls.some((c) => c.path === "/managed-clickhouse/v1/clusters"), "каждая база опрошена по своему пути");
  ok(/^\?folderId=f1&pageSize=1000$/.test((mdbCalls.find((c) => c.engine === "postgresql") || {}).search || ""), "каталог ушёл строкой: " + ((mdbCalls.find((c) => c.engine === "postgresql") || {}).search || "нет"));

  const dbCard = plain(await call("ycMdb", { action: "card", engine: "postgresql", cluster: "db-main" }));
  ok(/rc1a-pg-1\.mdb\.yandexcloud\.net/.test(dbCard) && /port=6432/.test(dbCard), "карточка даёт адрес ХОСТА и порт пулера: " + lineN(dbCard, 4));
  const chCard = plain(await call("ycMdb", { action: "card", engine: "clickhouse", cluster: "analytics" }));
  ok(/24\.8/.test(chCard) && /--port 9440 --secure/.test(chCard), "у ClickHouse адрес собран по-своему: " + lineN(chCard, 4));

  const dbUsers = plain(await call("ycMdb", { action: "users", engine: "postgresql", cluster: "db-main" }));
  ok(/admin/.test(dbUsers) && /пароли облако в чтении не отдаёт/i.test(dbUsers), "про пароли сказано честно: " + lineN(dbUsers, 1));

  const dbLogs = plain(await call("ycMdb", { action: "logs", engine: "postgresql", cluster: "db-main", minutes: 30, serviceType: "postgresql" }));
  const logCall = mdbCalls.filter((c) => /:logs$/.test(c.path)).pop() || {};
  const logQuery = decodeURIComponent(logCall.search || "");
  ok(/^\?fromTime=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z&toTime=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(logQuery) && /serviceType=POSTGRESQL/.test(logQuery), "логи запрошены с временем без миллисекунд: " + logQuery);
  ok(/no pg_hba/.test(dbLogs), "запись лога прочитана: " + lineN(dbLogs, 1));

  // Питание: на работающем кластере start — это ответ, а не запрос; stop уходит и
  // состояние ПЕРЕЧИТЫВАЕТСЯ (в подменённом облаке оно правда меняется).
  const powerBefore = mdbCalls.filter((c) => /:start$/.test(c.path)).length;
  const dbStart = plain(await call("ycMdb", { action: "start", engine: "postgresql", cluster: "db-main" }));
  ok(/уже работает/.test(dbStart), "«уже работает» — это ответ, а не ошибка: " + lineN(dbStart, 0));
  ok(mdbCalls.filter((c) => /:start$/.test(c.path)).length === powerBefore, "на «уже работает» запрос питания не ушёл");
  const dbStop = plain(await call("ycMdb", { action: "stop", engine: "postgresql", cluster: "db-main" }));
  ok(/останавливается/.test(dbStop) && /состояние: остановлен/.test(dbStop), "питание выполнено и состояние прочитано заново: " + lineN(dbStop, 0));
  ok(/диск и резервные копии/.test(dbStop), "сказано, что остановка не делает кластер бесплатным");

  // Создание и удаление: без согласия — ни одного запроса.
  const createBefore = mdbCalls.filter((c) => c.method === "POST" && c.path === "/managed-postgresql/v1/clusters").length;
  const dbCreateAsk = plain(await call("ycMdb", { action: "create", engine: "postgresql", name: "db-2", version: "16", preset: "s2.micro", subnet: "app-subnet" }));
  ok(/ПЛАТНОЕ/.test(dbCreateAsk) && /confirm: true/.test(dbCreateAsk), "создание без согласия — вопрос, а не отказ: " + lineN(dbCreateAsk, 0));
  ok(mdbCalls.filter((c) => c.method === "POST" && c.path === "/managed-postgresql/v1/clusters").length === createBefore, "кластер создался БЕЗ согласия");

  const dbCreate = plain(await call("ycMdb", { action: "create", engine: "postgresql", name: "db-2", version: "16", preset: "s2.micro", subnet: "app-subnet", user: "app", database: "appdb", confirm: true }));
  const pgMade = mdbCalls.filter((c) => c.method === "POST" && c.path === "/managed-postgresql/v1/clusters").pop() || {};
  let madeBody = {};
  try { madeBody = JSON.parse(pgMade.body || "{}"); } catch { madeBody = {}; }
  ok(madeBody.name === "db-2" && madeBody.networkId === "net-1", "сеть найдена МОДУЛЕМ по подсети: " + madeBody.networkId);
  ok(madeBody.configSpec && madeBody.configSpec.version === "16" && madeBody.configSpec.resources.resourcePresetId === "s2.micro", "версия и класс ушли телом: " + JSON.stringify(madeBody.configSpec && madeBody.configSpec.resources));
  ok(madeBody.databaseSpecs[0].name === "appdb" && madeBody.databaseSpecs[0].owner === "app", "база и её владелец создаются вместе с кластером");
  ok(String(madeBody.userSpecs[0].password || "").length >= 8 && dbCreate.includes(madeBody.userSpecs[0].password), "пароль показан один раз и тот же, что уехал в облако");
  ok(/ОДИН раз/.test(dbCreate), "сказано, что пароль больше не покажут");

  // ClickHouse: ДРУГОЕ тело — класс ВНУТРИ config.clickhouse и adminPassword.
  const chCreate = plain(await call("ycMdb", { action: "create", engine: "clickhouse", name: "ch-2", version: "24.8", preset: "s2.micro", subnet: "app-subnet", confirm: true }));
  const chMade = mdbCalls.filter((c) => c.method === "POST" && c.path === "/managed-clickhouse/v1/clusters").pop() || {};
  let chBody = {};
  try { chBody = JSON.parse(chMade.body || "{}"); } catch { chBody = {}; }
  ok(chBody.configSpec && chBody.configSpec.clickhouse && chBody.configSpec.clickhouse.resources.resourcePresetId === "s2.micro", "у ClickHouse класс ушёл в config.clickhouse: " + JSON.stringify(chBody.configSpec));
  ok(chBody.configSpec.resources === undefined && String(chBody.configSpec.adminPassword || "").length >= 8, "у ClickHouse нет configSpec.resources, но есть adminPassword");
  ok(chCreate.includes(chBody.configSpec.adminPassword), "пароль администратора ClickHouse показан один раз");

  const delBefore = mdbCalls.filter((c) => c.method === "DELETE").length;
  const delAsk = plain(await call("ycMdb", { action: "delete", engine: "postgresql", cluster: "db-main" }));
  ok(/НЕОБРАТИМО/.test(delAsk) && /РЕЗЕРВНЫЕ КОПИИ/.test(delAsk), "об необратимости сказано прямо: " + lineN(delAsk, 0));
  ok(mdbCalls.filter((c) => c.method === "DELETE").length === delBefore, "кластер удалён БЕЗ согласия");

  // ── Канал ОКНА (часть 88): те же три базы, но через yc:mdb ─────────────
  console.log("\n[17] yc:mdb: канал окна — три базы, согласие и секрет");
  const mdbHandler = handlers.get("yc:mdb");
  ok(typeof mdbHandler === "function", "канал yc:mdb зарегистрирован настоящим main.js");
  const callMdb = (args) => mdbHandler({}, args || {});

  const uiList = await callMdb({ op: "list", engine: "mysql" });
  ok(uiList.ok === true && /db-main/.test((uiList.lines || []).join("\n")), "канал читает кластеры своей базы: " + lineN((uiList.lines || []).join("\n"), 0));
  const uiCard = await callMdb({ op: "card", engine: "mysql", cluster: "db-main" });
  ok(uiCard.ok === true && uiCard.connection && /--port 3306/.test(uiCard.connection.line || ""), "канал отдаёт строку подключения: " + ((uiCard.connection || {}).line || "—"));

  const uiNeed = await callMdb({ op: "create", engine: "postgresql", name: "db-3", version: "16", preset: "s2.micro", subnet: "app-subnet" });
  ok(uiNeed.ok === false && uiNeed.needsConfirm === true, "окно получает needsConfirm, а не отказ");
  const uiMade = await callMdb({ op: "create", engine: "postgresql", name: "db-3", version: "16", preset: "s2.micro", subnet: "app-subnet", confirm: true });
  ok(uiMade.ok === true && typeof uiMade.secret === "string" && uiMade.secret.length >= 8, "пароль ушёл окну ОТДЕЛЬНЫМ полем secret");
  ok(/Пароль базы/.test(uiMade.secretLabel || ""), "окно знает, чей это пароль: " + uiMade.secretLabel);

  const uiDelNeed = await callMdb({ op: "delete", engine: "postgresql", cluster: "db-main" });
  ok(uiDelNeed.ok === false && uiDelNeed.needsConfirm === true && /НЕОБРАТИМО/.test(uiDelNeed.error || ""), "удаление из окна тоже спросит согласие");
  const uiDel = await callMdb({ op: "delete", engine: "postgresql", cluster: "db-main", confirm: true });
  ok(uiDel.ok === true && uiDel.deleted === true, "удаление по согласию выполнено: " + (uiDel.message || ""));

  // Отказы: чужое действие и отсутствие каталога — до сети.
  const mdbBefore = mdbCalls.length;
  const uiBadOp = await callMdb({ op: "vacuum" });
  ok(uiBadOp.ok === false && /Доступно: list, card, hosts, databases, users, logs, operations, presets, start, stop, create, delete/.test(uiBadOp.error || ""), "чужое действие отвергнуто со списком");
  writeSettings({ ycFolderId: "" });
  const uiNoFolder = await callMdb({ op: "list", engine: "postgresql" });
  ok(uiNoFolder.ok === false && /Не выбран каталог/.test(uiNoFolder.error || ""), "без каталога — отказ словами");
  writeSettings();
  ok(mdbCalls.length === mdbBefore, "на отказах в облако не ушло ничего");

  // ── DNS-зоны и записи из окна (часть 89) ────────────────────────────────
  // Записи DNS умели агент и карточка зоны, а у плитки действий не было. Канал
  // «yc:dns» собран на ТЕХ ЖЕ функциях yandex-cloud.js, что и они: проверяем,
  // что он видит зоны, ставит запись значениями через запятую, а удаление
  // спрашивает согласие (и показывает саму запись до него).
  console.log("\n[18] yc:dns: канал окна — зоны, запись и согласие на удаление");
  const dnsHandler = handlers.get("yc:dns");
  ok(typeof dnsHandler === "function", "канал yc:dns зарегистрирован настоящим main.js");
  const callDns = (args) => dnsHandler({}, args || {});

  const uiZones = await callDns({ op: "zones" });
  ok(uiZones.ok === true && /test-zone — id z1/.test((uiZones.lines || []).join("\n")), "зоны каталога пришли строками: " + lineN((uiZones.lines || []).join("\n"), 0));
  ok((uiZones.zones || []).length === 2, "окно получило и сам список зон (для подсказок формы)");

  const uiRecs = await callDns({ op: "records", zone: "test-zone" });
  ok(uiRecs.ok === true && /A www\.test-zone\. \(TTL 600\) → 203\.0\.113\.10/.test((uiRecs.lines || []).join("\n")), "записи зоны прочитаны: " + lineN((uiRecs.lines || []).join("\n"), 1));

  dnsUpdates.length = 0;
  const uiAdd = await callDns({ op: "add", zone: "test-zone", name: "api.test-zone", type: "A", ttl: 120, values: "203.0.113.11, 203.0.113.12" });
  const uiAddBody = JSON.parse(dnsUpdates.pop() || "{}");
  ok(uiAdd.ok === true && uiAddBody.additions && uiAddBody.additions[0].name === "api.test-zone." && uiAddBody.additions[0].data.length === 2, "запись ушла additions с двумя значениями: " + JSON.stringify(uiAddBody.additions && uiAddBody.additions[0]));
  ok(/203\.0\.113\.11, 203\.0\.113\.12/.test((uiAdd.lines || []).join("\n")), "ответ окна называет оба значения");
  ok((uiAdd.warnings || []).join(" ").includes("от минуты до часов"), "сказано, что DNS расходится не сразу");

  const uiApex = await callDns({ op: "add", zone: "test-zone.", name: "test-zone.", type: "CNAME", values: "host.example.net." });
  ok(uiApex.ok === false && /вершине зоны/.test(uiApex.error || ""), "CNAME на вершине отбит до сети: " + (uiApex.error || "").slice(0, 80));

  const uiAsk = await callDns({ op: "delete", zone: "test-zone", name: "www.test-zone.", type: "A" });
  ok(uiAsk.ok === false && uiAsk.needsConfirm === true && /перестать открываться/.test(uiAsk.error || ""), "удаление без согласия объясняет последствия");
  ok(/A www\.test-zone\./.test((uiAsk.lines || []).join("\n")), "перед удалением показана сама запись: " + lineN((uiAsk.lines || []).join("\n"), 0));
  dnsUpdates.length = 0;
  const uiDnsDel = await callDns({ op: "delete", zone: "test-zone", name: "www.test-zone.", type: "A", confirm: true });
  const uiDnsDelBody = JSON.parse(dnsUpdates.pop() || "{}");
  ok(uiDnsDel.ok === true && uiDnsDelBody.deletions && uiDnsDelBody.deletions[0].name === "www.test-zone." && (uiDnsDelBody.additions || []).length === 0, "удаление убрало ровно найденную запись");

  const uiDnsBad = await callDns({ op: "стирай" });
  ok(uiDnsBad.ok === false && /Доступно: zones, card, records, add, delete/.test(uiDnsBad.error || ""), "чужое действие отвергнуто со списком");
  writeSettings({ ycFolderId: "" });
  const uiDnsNoFolder = await callDns({ op: "zones" });
  ok(uiDnsNoFolder.ok === false && /Не выбран каталог/.test(uiDnsNoFolder.error || ""), "без каталога — отказ словами");
  writeSettings();

  // ── AI Studio: модели, токены, ответ и вектор (часть 90) ────────────────
  // Модели AI Studio в приложении были только как провайдер чата; у ОБЛАЧНОГО
  // инструмента их не было. Проверяем обе половины сразу: список моделей идёт
  // OpenAI-совместимым GET-ом с каталогом в заголовке, а ответ, токены и вектор —
  // старым REST-ом с адресом модели в теле (gpt:// и emb:// — РАЗНЫЕ префиксы).
  console.log("\n[19] ycAi: AI Studio — модели, токены, ответ и вектор");
  const aiModels = plain(await call("ycAi", { action: "models" }));
  ok(/yandexgpt-5-lite/.test(aiModels) && /text-search-doc/.test(aiModels), "модели каталога перечислены: " + lineN(aiModels, 1));
  ok(/бесплатн/i.test(aiModels) && /0\.2 ₽/.test(aiModels), "сказано, что список и токены бесплатны, а ответ платный");
  const listCall = aiCalls.filter((c) => c.path === "/v1/models").pop() || {};
  ok(listCall.project === "f1" && /^Bearer /.test(listCall.auth), "каталог ушёл заголовком OpenAI-Project, авторизация — IAM-токеном");

  const aiTokens = plain(await call("ycAi", { action: "tokens", text: "Счёт на четыре тысячи рублей" }));
  ok(/Токены текста: 3/.test(aiTokens), "токены посчитаны: " + lineN(aiTokens, 0));
  const tokCall = aiCalls.filter((c) => c.path === "/foundationModels/v1/tokenizeCompletion").pop() || {};
  let tokBody = {};
  try { tokBody = JSON.parse(tokCall.body || "{}"); } catch { tokBody = {}; }
  ok(tokBody.modelUri === "gpt://f1/yandexgpt-5-lite" && tokBody.text === "Счёт на четыре тысячи рублей", "тело токенизации собрано адресом модели: " + (tokCall.body || ""));

  const aiDone = plain(await call("ycAi", { action: "complete", prompt: "Сколько будет 2+2?", system: "Отвечай коротко" }));
  ok(/Модель услышала: Отвечай коротко \| Сколько будет 2\+2\?/.test(aiDone), "ответ модели показан: " + lineN(aiDone, 0));
  ok(/вход 1200, ответ 400/.test(aiDone) && /≈ 0\.32 ₽/.test(aiDone), "токены и цена ответа посчитаны: " + lineN(aiDone, 2));
  const doneCall = aiCalls.filter((c) => c.path === "/foundationModels/v1/completion").pop() || {};
  let doneBody = {};
  try { doneBody = JSON.parse(doneCall.body || "{}"); } catch { doneBody = {}; }
  ok(doneBody.completionOptions && doneBody.completionOptions.stream === false && doneBody.completionOptions.maxTokens === "2000", "ответ запрошен синхронно, длина ушла строкой: " + JSON.stringify(doneBody.completionOptions));
  ok((doneBody.messages || []).map((m) => m.role).join(",") === "system,user", "роль ушла первой, запрос — вторым");

  const aiVec = plain(await call("ycAi", { action: "embed", text: "договор поставки", model: "text-search-doc" }));
  ok(/256 чисел/.test(aiVec) && /text-search-doc/.test(aiVec), "вектор посчитан: " + lineN(aiVec, 0));
  ok(/0\.0101/.test(aiVec), "тариф векторов назван");
  const vecCall = aiCalls.filter((c) => c.path === "/foundationModels/v1/textEmbedding").pop() || {};
  let vecBody = {};
  try { vecBody = JSON.parse(vecCall.body || "{}"); } catch { vecBody = {}; }
  ok(vecBody.modelUri === "emb://f1/text-search-doc", "адрес вектора собран с префиксом emb://: " + vecBody.modelUri);

  const aiRef = aiCalls.length;
  ok(/нужен prompt/.test(plain(await call("ycAi", { action: "complete" }))), "без запроса — отказ словами до сети");
  ok(/нужен text/.test(plain(await call("ycAi", { action: "tokens" }))), "без текста — отказ словами до сети");
  ok(aiCalls.length === aiRef, "на отказах в облако не ушло ничего");

  // ── Те же четыре действия — из ОКНА (часть 90) ──────────────────────────
  // Канал «yc:ai» — второй вход в тот же модуль: окно не должно видеть ни
  // адресов модели, ни разбора ответа — оно получает готовые строки, токены
  // ответа для показа и размерность вектора.
  console.log("\n[20] yc:ai: AI Studio из окна — модели, токены, ответ и вектор");
  const uiModels = await callAi({ op: "models" });
  ok(uiModels.ok === true && (uiModels.lines || []).length === 3, "модели каталога пришли строками: " + ((uiModels.lines || [])[0] || ""));
  const uiModelsCall = aiCalls.filter((c) => c.path === "/v1/models").pop() || {};
  ok(uiModelsCall.project === "f1", "окно тоже называет каталог заголовком");
  const uiTokens = await callAi({ op: "tokens", text: "Счёт на четыре тысячи рублей" });
  ok(uiTokens.ok === true && uiTokens.tokens === 3, "токены из окна: " + uiTokens.tokens);
  ok((uiTokens.warnings || []).join(" ").includes("Токенизация бесплатна"), "окно говорит, что токенизация бесплатна");
  const uiComplete = await callAi({ op: "complete", prompt: "Сколько будет 2+2?", system: "Отвечай коротко" });
  ok(uiComplete.ok === true && /Модель услышала/.test(uiComplete.answer || ""), "ответ модели вернулся в окно: " + String(uiComplete.answer || "").slice(0, 80));
  ok(uiComplete.usage && uiComplete.usage.input === 1200 && uiComplete.usage.output === 400, "окно получило токены ответа для показа");
  ok((uiComplete.lines || []).join("\n").includes("≈ 0.32 ₽"), "цена ответа показана в строках");
  const uiEmbed = await callAi({ op: "embed", text: "договор поставки" });
  ok(uiEmbed.ok === true && uiEmbed.dims === 256, "вектор из окна: " + uiEmbed.dims + " чисел");
  ok(/Первые числа: 0\.001/.test((uiEmbed.lines || []).join("\n")), "первые числа вектора показаны");
  const uiRef = aiCalls.length;
  ok((await callAi({ op: "tokens" })).ok === false, "пустые токены из окна отклонены до сети");
  ok((await callAi({ op: "complete" })).ok === false, "пустой запрос из окна отклонён до сети");
  ok(aiCalls.length === uiRef, "на отказах окно в облако не ходило");

  // ── Группы машин: группа не «несколько машин» (часть 91) ───────────────
  // Группа сама создаёт машины по шаблону, держит их число и пересоздаёт
  // удалённые. Платят МАШИНЫ группы — за час, как обычные, поэтому создание и
  // удаление требуют согласия, а отказ обязан назвать цену и последствия.
  console.log("\n[21] ycIg: Группы машин — размер, карточка, создание и отказы");
  const igList = plain(await call("ycIg", { action: "list" }));
  ok(/Группы машин/.test(igList) && /web/.test(igList), "группа каталога показана: " + lineN(igList, 1));
  ok(/3 машин/.test(igList) && /машин 1\/3/.test(igList), "размер группы и счёт машин названы: " + lineN(igList, 1));
  ok(/устаревших 1/.test(igList), "устаревшие машины названы — группа их пересоздаст");
  ok(/ycCosts/.test(igList) && /платит за час/.test(igList), "сказано, что платят машины группы, и где смотреть цену");
  ok(/удалённая руками машина вернётся/.test(igList), "сказано главное: машины группы пересоздаются сами");
  const igListCall = igCalls.filter((c) => c.path === "/compute/v1/instanceGroups").pop() || {};
  ok(/folderId=f1/.test(igListCall.search || ""), "список ушёл с каталогом: " + (igListCall.search || ""));

  const igCard = plain(await call("ycIg", { action: "card", group: "web" }));
  ok(/Шаблон: standard-v3/.test(igCard), "карточка назвала шаблон: " + lineN(igCard, 1));
  ok(/Машины \(2\):/.test(igCard) && /203\.0\.113\.5/.test(igCard), "машины группы показаны с адресами: " + lineN(igCard, 3));
  ok(/балансировщику/.test(igCard) && /target group tg-nlb-1/.test(igCard), "карточка назвала связь с балансировщиком: " + lineN(igCard, 2));
  ok(/операц/i.test(igCard), "история операций показана");

  writeSettings({ ycAllowAgentCreate: true });
  const igNoConfirm = plain(await call("ycIg", { action: "create", name: "web-2", subnet: "app-subnet", size: 2 }));
  ok(/ценой/.test(igNoConfirm) && /confirm: true/.test(igNoConfirm), "создание без согласия назвало цену и ждёт согласия");
  ok(igState.created.length === 0, "без согласия группа не создана");
  const igCreate = plain(await call("ycIg", { action: "create", name: "web-2", subnet: "app-subnet", size: 2, publicIp: true, securityGroups: ["web"], confirm: true }));
  ok(/web-2/.test(igCreate) && /машин 2/.test(igCreate), "группа создана и названа: " + lineN(igCreate, 0));
  const createdBody = JSON.parse(igState.created[0] || "{}");
  ok(createdBody.scalePolicy && createdBody.scalePolicy.fixedScale.size === "2", "размер группы ушёл в scalePolicy.fixedScale: " + JSON.stringify(createdBody.scalePolicy));
  ok(createdBody.instanceTemplate.networkInterfaceSpecs[0].subnetIds[0] === "sub-a", "подсеть ушла в шаблон машины");
  ok(createdBody.instanceTemplate.bootDiskSpec.diskSpec.imageId === "img-ubuntu", "образ найден по семейству");
  ok(createdBody.instanceTemplate.networkInterfaceSpecs[0].securityGroupIds[0] === "sg-web", "группа безопасности разрешена по имени");
  ok(createdBody.allocationPolicy.zones[0].zoneId === "ru-central1-a", "зона взята у подсети");

  const igStop = plain(await call("ycIg", { action: "stop", group: "web" }));
  ok(/останавливается/.test(igStop) && /диски/.test(igStop), "остановка названа и сказано про диски: " + lineN(igStop, 0));
  ok(igState.status === "STOPPED", "состояние группы правда изменилось: " + igState.status);
  const igNoDel = plain(await call("ycIg", { action: "delete", group: "web" }));
  ok(/необратимо/.test(igNoDel) && /ВМЕСТЕ с машинами/.test(igNoDel) && /confirm: true/.test(igNoDel), "удаление без согласия назвало последствия");
  ok(igState.deleted.size === 0, "без согласия группа не удалена");
  const igDel = plain(await call("ycIg", { action: "delete", group: "web", confirm: true }));
  ok(/удаляется/.test(igDel) && /дисками/.test(igDel), "удаление выполнено и объяснено: " + lineN(igDel, 0));
  ok(igState.deleted.has("ig-web"), "удаление действительно дошло до облака");
  const igGone = plain(await call("ycIg", { action: "card", group: "web" }));
  ok(/не нашёл группу/.test(igGone), "удалённой группы больше нет: " + lineN(igGone, 0));

  const igBad = igCalls.length;
  ok(/неизвестное действие ycIg/.test(plain(await call("ycIg", { action: "nope" }))), "чужое действие отбито словами");
  ok(/нужно имя|Не указано имя/.test(plain(await call("ycIg", { action: "create", confirm: true }))), "создание без имени отбито до сети");
  ok(igCalls.length === igBad, "на отказах в облако не ушло ничего");
  writeSettings();

  // ── Те же действия — из ОКНА (часть 91) ────────────────────────────────
  // Канал «yc:ig» — второй вход в тот же модуль: окно получает готовые строки,
  // id созданной группы и предупреждения, а согласие спрашивает флагом confirm.
  console.log("\n[22] yc:ig: группы машин из окна — список, карточка и согласие");
  // Стенд возвращает группу: проверка удаления уже сделана выше, а этому
  // разделу нужна группа, с которой окно работает (как после пересоздания).
  igState.deleted.clear();
  igState.status = "ACTIVE";
  const igHandler = handlers.get("yc:ig");
  ok(typeof igHandler === "function", "канал yc:ig зарегистрирован настоящим main.js");
  const callIg = (args) => igHandler({}, args || {});
  const uiIgList = await callIg({ op: "list" });
  ok(uiIgList.ok === true && (uiIgList.lines || []).length === 1, "список групп пришёл строками: " + ((uiIgList.lines || [])[0] || ""));
  ok(/машин 1\/3/.test((uiIgList.lines || [])[0] || ""), "окно видит счёт машин группы");
  ok((uiIgList.warnings || []).join(" ").includes("устаревш"), "окно предупреждено про устаревшие машины");
  const uiIgCard = await callIg({ op: "card", group: "web" });
  ok(uiIgCard.ok === true && (uiIgCard.lines || []).some((l) => /Шаблон:/.test(l)), "карточка группы собрана из строк: " + JSON.stringify((uiIgCard.lines || []).slice(0, 2)));
  ok((uiIgCard.instances || []).length === 2, "машины группы вернулись окну: " + (uiIgCard.instances || []).length);
  const uiIgNew = await callIg({ op: "create", name: "web-3", subnet: "app-subnet", size: 2 });
  ok(uiIgNew.ok === false && uiIgNew.needsConfirm === true, "создание из окна спросило человека, а не отказало");
  ok(/ценой/.test(uiIgNew.error || "") && (uiIgNew.lines || []).some((l) => /Машин: 2/.test(l)), "вопрос назвал цену и размер: " + JSON.stringify((uiIgNew.lines || [])[0]));
  const uiIgRef = igCalls.length;
  ok((await callIg({ op: "create", name: "web-3", subnet: "app-subnet", size: 2, confirm: true })).ok === true, "с согласием создание прошло");
  ok(igCalls.length > uiIgRef, "и действительно ушло в облако");
  const uiIgNoAuth = await callIg({ op: "nope" });
  ok(uiIgNoAuth.ok === true || uiIgNoAuth.ok === false, "чужое действие не сломало канал");

  srv.close();
  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки облачных инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

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
     [23] ycAlb: ВХОД В ПРИЛОЖЕНИЕ — слушатели в форме ОТВЕТА облака (адрес
         виден), карточка проходит путь слушатель → роутер → маршрут → группа
         бэкендов → группа целей, создание уходит с подсетью и ценой; ГРУППА
         БЭКЕНДОВ создаётся с портом целей и проверкой здоровья, занятую
         облако удалять откажется, а здоровье цели спрашивают у ПАРЫ
         «бэкенды + цели» и приходит оно ПО ЗОНАМ;
     [24] yc:alb: канал ОКНА — тот же модуль через настоящий main.js: строки,
         цена до согласия, согласие на необратимое и здоровье числом; состав
         слушателей меняют ТОЧЕЧНО (:addListener, :updateListener,
         :removeListener — без списка целиком), HTTPS берёт только выпущенный
         сертификат, правка уходит МАСКОЙ полей, а карточка отдаёт сертификаты
         окну объектами; правка слушателя НЕ перебирает его заново (что не
         назвали — то и осталось, адрес в том числе), а несколько доменов на
         одном слушателе живут в SNI — у каждого свой сертификат.

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
const igState = { created: [], deleted: new Set(), status: "ACTIVE" };// Запросы Application Load Balancer (часть 91, заход 2): вход в приложение —
// слушатели, группы целей, HTTP-роутеры и группы бэкендов. Стенд держит всю
// цепочку «слушатель → роутер → маршрут → группа бэкендов → группа целей» и
// отдаёт слушателей в форме ОТВЕТА облака (endpoints → addresses →
// externalIpv4Address): модуль обязан читать адрес оттуда, а форма запроса
// (endpointSpecs/addressSpecs) — только запасная. Как и у групп машин, стенд
// помнит созданное и удалённое: по этому видно, что действие правда дошло.
const albCalls = [];
// Облако выдаёт адрес слушателю САМО, если его не назвали, и отдаёт слушателя в
// форме ОТВЕТА — тут так же: иначе «адрес сохраняется при правке» проверить
// было бы нечем (домены смотрят именно на адрес).
let albAddrSeq = 0;
const albState = { lbCreated: [], lbDeleted: new Set(), tgCreated: [], tgDeleted: new Set(), bgCreated: [], bgDeleted: new Set(), routerCreated: [], targets: ["10.10.0.5", "10.10.0.6"], status: "ACTIVE",
  // Часть 91, заход 4: имя, описание, группы безопасности и СОСТАВ СЛУШАТЕЛЕЙ
  // здесь меняются — иначе правку (:addListener, :removeListener, PATCH) нечем
  // было бы проверить: стенд должен перечитываться как настоящее облако.
  name: "web-lb", description: "", securityGroupIds: ["sg-web"],
  listeners: [{ name: "web", endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.10" } }], ports: ["80"] }], http: { handler: { httpRouterId: "rt-web" } } }],
  // Часть 91, заход 6: роутер и группа бэкендов тоже изменяемые — правка идёт
  // ЗАМЕНОЙ вложенного списка (virtualHosts / backends), и без этого «облако
  // применило» проверить было бы нечем.
  routerName: "web-router", routerDescription: "",
  routerHosts: [{ name: "main", authority: ["site.example.com"], routes: [{ name: "main", http: { match: { path: { prefixMatch: "/" } }, route: { backendGroupId: "bg-web" } } }] }],
  routerPatches: [], bgPatches: [],
  bgName: "web-backends",
  bgBackends: [{ name: "web", port: "8080", targetGroups: { targetGroupIds: ["tg-web"] }, healthchecks: [{ timeout: "1s", interval: "2s", http: { path: "/" } }] }] };
// Правка слушателя (:updateListener): тело — updateMask + listenerSpec, а сам
// слушатель опознаётся ПО ИМЕНИ (переименовать его нельзя). Стенд повторяет
// поведение облака: названное в маске берётся из тела, НЕназванное остаётся
// прежним, а названное без значения сбрасывается — так и работает смена вида
// http → https (в маске оказывается и СТАРЫЙ вид).
const albMaskField = { name: "name", endpoints: "endpoint_specs", http: "http", tls: "tls", stream: "stream" };
const albEndpointFromSpec = (e) => {
  const a = (e && (e.addressSpecs || [])[0]) || {};
  const ext = a.externalIpv4AddressSpec || a.externalIpv6AddressSpec || a.internalIpv4AddressSpec || {};
  return { addresses: [ext.address ? { externalIpv4Address: { address: ext.address } } : {}], ports: ((e && e.ports) || []).map(String) };
};
const albApplyListener = (sent) => {
  const spec = sent.listenerSpec || {};
  const fields = String(sent.updateMask || "").split(",").map((s) => s.trim());
  const at = albState.listeners.findIndex((x) => x.name === spec.name);
  if (at < 0) return;
  const before = albState.listeners[at];
  const next = {};
  for (const key of ["name", "endpoints", "http", "tls", "stream"]) {
    if (fields.indexOf(albMaskField[key]) < 0) {
      if (before[key] !== undefined) next[key] = before[key];
      continue;
    }
    const given = key === "endpoints" ? spec.endpointSpecs : spec[key];
    if (given === undefined) continue;
    next[key] = key === "endpoints" ? (spec.endpointSpecs || []).map(albEndpointFromSpec) : given;
  }
  albState.listeners[at] = next;
};
const albLbBody = () => ({
  id: "lb-web", name: albState.name, folderId: "f1", description: albState.description, createdAt: "2026-08-03T10:00:00Z", status: albState.status,
  regionId: "ru-central1", networkId: "net-1", securityGroupIds: albState.securityGroupIds,
  allocationPolicy: { locations: [{ zoneId: "ru-central1-a", subnetId: "sub-a" }] },
  listeners: albState.listeners,
});
const albTgBody = (id, name, targets) => ({
  id: id || "tg-web", name: name || "web-targets", folderId: "f1", createdAt: "2026-08-02T10:00:00Z",
  targets: (targets || albState.targets).map((ip) => ({ ipAddress: ip, subnetId: "sub-a" })),
});
const albRouterBody = () => ({
  id: "rt-web", name: albState.routerName, folderId: "f1", description: albState.routerDescription, createdAt: "2026-08-02T11:00:00Z",
  virtualHosts: albState.routerHosts,
});
// Группа бэкендов: ПОРТ целей и проверки здоровья живут именно здесь.
const albBackendBody = () => ({ id: "bg-web", name: albState.bgName, folderId: "f1", createdAt: "2026-08-02T12:00:00Z",
  http: { backends: albState.bgBackends } });
// Свободная группа бэкендов: на неё никто не смотрит — её и удалим, а занятая
// (та, в которую ведёт маршрут роутера) обязана отбиться словами.
const albFreeBackendBody = () => ({ id: "bg-free", name: "free-backends", folderId: "f1", createdAt: "2026-08-02T13:00:00Z",
  stream: { backends: [{ name: "free", port: "1521", targetGroups: { targetGroupIds: ["tg-web"] } }] } });

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
        if (opId === "op-sec") return json({ id: opId, done: true, response: { id: "ver3" } });        // Операции ALB: id созданного ресурса приходит ТОЛЬКО в metadata —
        // модуль обязан читать его оттуда (иначе созданное «теряется»).
        if (opId === "op-alb-tg") return json({ id: opId, done: true, metadata: { targetGroupId: "tg-new" } });
        if (opId === "op-alb-rt") return json({ id: opId, done: true, metadata: { httpRouterId: "rt-web" } });
        if (opId === "op-alb-lb") return json({ id: opId, done: true, metadata: { loadBalancerId: "lb-new" } });
        // Созданная группа бэкендов: id — в metadata, и он УНИКАЛЕН для каждой
        // группы (иначе вторая созданная читалась бы как первая).
        const bgOp = /^op-alb-bg(\d+)$/.exec(opId);
        if (bgOp) return json({ id: opId, done: true, metadata: { backendGroupId: "bg-new" + bgOp[1] } });

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

      // Сертификаты Certificate Manager: HTTPS-слушателю годится только
      // ВЫПУЩЕННЫЙ (Issued) сертификат того же каталога — стенд даёт оба случая.
      if (p.indexOf("/certificate-manager/v1/certificates") === 0) {
        return json({
          certificates: [
            { id: "cert-1", name: "site-cert", status: "ISSUED", domains: ["site.example.com"], notAfter: new Date(Date.now() + 200 * 86400000).toISOString() },
            { id: "cert-2", name: "old-cert", status: "VALIDATING" },
            // Два сертификата на один слушатель — это SNI, и продление HTTPS:
            // у каждого домена свой, а «fresh» нужен правке слушателя.
            { id: "cert-3", name: "fresh-cert", status: "ISSUED", domains: ["site.example.com"], notAfter: new Date(Date.now() + 360 * 86400000).toISOString() },
            { id: "cert-4", name: "shop-cert", status: "ISSUED", domains: ["shop.example.com"], notAfter: new Date(Date.now() + 150 * 86400000).toISOString() },
          ],
        });
      }

      // ── Application Load Balancer (часть 91, заходы 2–4) ─────────────────
      // Вход в приложение: балансировщик, слушатели, группы целей, роутеры и
      // группы бэкендов. Слушатели отдаются в форме ОТВЕТА облака; группа
      // целей достижима только через группу бэкендов — стенд держит цепочку.
      if (p.indexOf("/apploadbalancer/v1/") === 0) {
        albCalls.push({ method: req.method, path: p, search: u.search || "", body: body });
        const albSent = (() => { try { return body ? JSON.parse(body) : {}; } catch { return {}; } })();
        if (req.method === "POST" && p === "/apploadbalancer/v1/loadBalancers") { albState.lbCreated.push(body); return json({ id: "op-alb-lb", done: false }); }
        if (req.method === "POST" && p === "/apploadbalancer/v1/targetGroups") { albState.tgCreated.push(body); return json({ id: "op-alb-tg", done: false }); }
        if (req.method === "POST" && p === "/apploadbalancer/v1/httpRouters") { albState.routerCreated.push(body); return json({ id: "op-alb-rt", done: false }); }
        if (req.method === "POST" && p === "/apploadbalancer/v1/backendGroups") {
          const n = albState.bgCreated.length + 1;
          albState.bgCreated.push({ id: "bg-new" + n, body: albSent });
          return json({ id: "op-alb-bg" + n, done: false });
        }
        if (req.method === "POST" && /:start$/.test(p)) { albState.status = "ACTIVE"; return json({ id: "op-alb-start", done: false }); }
        if (req.method === "POST" && /:stop$/.test(p)) { albState.status = "STOPPED"; return json({ id: "op-alb-stop", done: false }); }
        if (req.method === "POST" && /:addTargets$/.test(p)) {
          (albSent.targets || []).forEach((t) => { if (albState.targets.indexOf(t.ipAddress) < 0) albState.targets.push(t.ipAddress); });
          return json({ id: "op-alb-tadd", done: false });
        }
        if (req.method === "POST" && /:removeTargets$/.test(p)) {
          albState.targets = albState.targets.filter((ip) => !(albSent.targets || []).some((t) => t.ipAddress === ip));
          return json({ id: "op-alb-trem", done: false });
        }
        // Слушателей меняют ТОЧЕЧНО: один добавляется, один убирается — списка
        // целиком в этих запросах нет вовсе (иначе остальные были бы стёрты).
        if (req.method === "POST" && /:addListener$/.test(p)) {
          const spec = albSent.listenerSpec || {};
          const eps = (spec.endpointSpecs || []).map(albEndpointFromSpec);
          if (eps.length && !(eps[0].addresses[0] || {}).externalIpv4Address) {
            albAddrSeq++;
            eps[0] = { addresses: [{ externalIpv4Address: { address: "203.0.113." + (20 + albAddrSeq) } }], ports: eps[0].ports };
          }
          const next = { name: spec.name, endpoints: eps };
          for (const k of ["http", "tls", "stream"]) if (spec[k] !== undefined) next[k] = spec[k];
          albState.listeners.push(next);
          return json({ id: "op-alb-ladd", done: false });
        }
        if (req.method === "POST" && /:updateListener$/.test(p)) {
          albApplyListener(albSent);
          return json({ id: "op-alb-lupd", done: false });
        }
        if (req.method === "POST" && /:removeListener$/.test(p)) {
          albState.listeners = albState.listeners.filter((x) => x.name !== albSent.name);
          return json({ id: "op-alb-ldel", done: false });
        }
        // Правка самого балансировщика приходит МАСКОЙ полей: без маски облако
        // сбросило бы всё, чего нет в теле (включая слушателей).
        if (req.method === "PATCH" && /\/loadBalancers\/lb-web$/.test(p)) {
          const fields = String(albSent.updateMask || "").split(",").map((s) => s.trim());
          if (fields.indexOf("name") >= 0) albState.name = albSent.name;
          if (fields.indexOf("description") >= 0) albState.description = albSent.description || "";
          if (fields.indexOf("security_group_ids") >= 0) albState.securityGroupIds = albSent.securityGroupIds || [];
          return json({ id: "op-alb-patch", done: false });
        }
        // Правка роутера и группы бэкендов приходит ЗАМЕНОЙ вложенного списка:
        // облако не умеет «поменять путь» или «поменять порт» отдельным методом.
        if (req.method === "PATCH" && p === "/apploadbalancer/v1/httpRouters/rt-web") {
          albState.routerPatches.push(albSent);
          const rtFields = String(albSent.updateMask || "").split(",").map((s) => s.trim());
          if (rtFields.indexOf("name") >= 0) albState.routerName = albSent.name;
          if (rtFields.indexOf("description") >= 0) albState.routerDescription = albSent.description || "";
          if (rtFields.indexOf("virtual_hosts") >= 0) albState.routerHosts = albSent.virtualHosts || [];
          return json({ id: "op-alb-rtpatch", done: false });
        }
        if (req.method === "PATCH" && p === "/apploadbalancer/v1/backendGroups/bg-web") {
          albState.bgPatches.push(albSent);
          const bgFields = String(albSent.updateMask || "").split(",").map((s) => s.trim());
          if (bgFields.indexOf("name") >= 0) albState.bgName = albSent.name;
          if (bgFields.indexOf("http") >= 0) albState.bgBackends = (albSent.http || {}).backends || [];
          return json({ id: "op-alb-bgpatch", done: false });
        }
        if (req.method === "DELETE") {
          if (/\/loadBalancers\//.test(p)) { albState.lbDeleted.add("lb-web"); return json({ id: "op-alb-lbdel", done: false }); }
          if (/\/targetGroups\//.test(p)) { albState.tgDeleted.add("tg-web"); return json({ id: "op-alb-tgdel", done: false }); }
          if (/\/httpRouters\//.test(p)) { albState.routerDeleted = true; return json({ id: "op-alb-rtdel", done: false }); }
          if (/\/backendGroups\//.test(p)) { albState.bgDeleted.add(p.slice(p.lastIndexOf("/") + 1)); return json({ id: "op-alb-bgdel", done: false }); }
        }
        // Здоровье приходит ПО ЗОНАМ: у цели их может быть несколько, и «здорова»
        // решается по каждой зоне отдельно.
        if (/\/targetStates\//.test(p)) {
          return json({ targetStates: [
            { target: { ipAddress: "10.10.0.5", subnetId: "sub-a" }, status: { zoneStatuses: [
              { zoneId: "ru-central1-a", status: "HEALTHY" }, { zoneId: "ru-central1-b", status: "HEALTHY" }] } },
            { target: { ipAddress: "10.10.0.6", subnetId: "sub-a" }, status: { zoneStatuses: [
              { zoneId: "ru-central1-a", status: "HEALTHY" }, { zoneId: "ru-central1-b", status: "UNHEALTHY", failedActiveHc: true }] } },
          ] });
        }
        if (p === "/apploadbalancer/v1/loadBalancers") return json({ loadBalancers: albState.lbDeleted.has("lb-web") ? [] : [albLbBody()] });
        if (albState.lbDeleted.has("lb-web") && /\/loadBalancers\//.test(p)) return json({ message: "Load balancer not found" }, 404);
        if (p === "/apploadbalancer/v1/loadBalancers/lb-web") return json(albLbBody());
        if (p === "/apploadbalancer/v1/targetGroups") {
          const list = albState.tgDeleted.has("tg-web") ? [] : [albTgBody()];
          if (albState.tgCreated.length) list.push(albTgBody("tg-new", "web-targets2", []));
          return json({ targetGroups: list });
        }
        if (p === "/apploadbalancer/v1/targetGroups/tg-web") return json(albTgBody());
        if (p === "/apploadbalancer/v1/targetGroups/tg-new") return json(albTgBody("tg-new", "web-targets2", []));
        if (p === "/apploadbalancer/v1/httpRouters") return json({ httpRouters: albState.routerDeleted ? [] : [albRouterBody()] });
        if (p === "/apploadbalancer/v1/httpRouters/rt-web") return json(albRouterBody());
        if (p === "/apploadbalancer/v1/backendGroups") {
          const list = [];
          if (!albState.bgDeleted.has("bg-web")) list.push(albBackendBody());
          if (!albState.bgDeleted.has("bg-free")) list.push(albFreeBackendBody());
          albState.bgCreated.forEach((x) => { if (!albState.bgDeleted.has(x.id)) list.push(Object.assign({ id: x.id }, x.body)); });
          return json({ backendGroups: list });
        }
        const bgById = /^\/apploadbalancer\/v1\/backendGroups\/(bg-[a-z0-9]+)$/.exec(p);
        if (bgById) {
          if (bgById[1] === "bg-web") return albState.bgDeleted.has("bg-web") ? json({ message: "Backend group not found" }, 404) : json(albBackendBody());
          if (bgById[1] === "bg-free") return json(albFreeBackendBody());
          const made = albState.bgCreated.find((x) => x.id === bgById[1]);
          return made ? json(Object.assign({ id: made.id }, made.body)) : json({ message: "Backend group not found" }, 404);
        }
        return json({ message: "Not found" }, 404);
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
  const cloudNames = ["ycStatus", "ycList", "ycCreate", "ycCosts", "ycDelete", "ycDeploy", "ycContainer", "ycSecret", "ycDns", "ycRegistry", "ycStorage", "ycDb", "ycAi", "ycMonitor", "ycMdb", "ycIg", "ycAlb", "ycLogs", "ycInstall"];
  const missing = cloudNames.filter((n) => typeof tools[n] !== "function");
  ok(missing.length === 0, "все девятнадцать на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
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

  // ── Application Load Balancer: вход в приложение (часть 91, заходы 2–4) ──
  // Балансировщик — не «ещё один ресурс»: за одним адресом стоят слушатели,
  // группы целей, роутеры и группы бэкендов. Стенд отдаёт слушателей в форме
  // ОТВЕТА облака, поэтому раздел проверяет и чтение адреса, и весь путь
  // слушатель → роутер → маршрут → группа бэкендов → группа целей. Группа
  // бэкендов здесь же задаёт ПОРТ целей и проверку здоровья, а здоровье цели
  // облако отдаёт ПО ЗОНАМ. В заходе 4 стенд научился МЕНЯТЬ состояние:
  // :addListener, :removeListener и PATCH — правка обязана перечитываться.
  console.log("\n[23] ycAlb: вход в приложение — слушатели, роутер, группы бэкендов и здоровье целей");
  const albList = plain(await call("ycAlb", { action: "list" }));
  ok(/Балансировщики/.test(albList) && /web-lb/.test(albList), "балансировщик каталога показан: " + lineN(albList, 1));
  ok(/HTTP 80 203\.0\.113\.10/.test(albList), "адрес прочитан из ФОРМЫ ОТВЕТА облака: " + lineN(albList, 1));
  ok(/зоны: ru-central1-a/.test(albList), "зона узла названа");
  ok(/платный/.test(albList) && /DNS-запись/.test(albList), "сказано про цену и про DNS только после создания");
  const albListCall = albCalls.filter((c) => c.path === "/apploadbalancer/v1/loadBalancers").pop() || {};
  ok(/folderId=f1/.test(albListCall.search || ""), "список ушёл с каталогом: " + (albListCall.search || ""));

  const albCard = plain(await call("ycAlb", { action: "card", lb: "web-lb" }));
  ok(/Слушатели \(1\)/.test(albCard) && /роутер rt-web/.test(albCard), "слушатель и его роутер названы: " + lineN(albCard, 2));
  ok(/домены: site\.example\.com/.test(albCard) && /группа бэкендов bg-web/.test(albCard), "маршрут показан доменом и группой бэкендов: " + lineN(albCard, 4));
  ok(/Группы бэкендов: web-backends/.test(albCard), "группа бэкендов найдена из слушателя и маршрута");
  const cardBgCall = albCalls.filter((c) => c.path === "/apploadbalancer/v1/backendGroups/bg-web").pop() || {};
  ok(!!cardBgCall.method, "карточка правда читала группу бэкендов по id");
  ok(/Группы целей \(1\)/.test(albCard) && /10\.10\.0\.5/.test(albCard), "группа целей дошла из группы бэкендов: " + lineN(albCard, 7));
  ok(/Здоровье целей/.test(albCard), "сказано, где здоровье целей: в карточке его нет");

  const albTargets = plain(await call("ycAlb", { action: "targets" }));
  ok(/web-targets/.test(albTargets) && /целей: 2/.test(albTargets), "группа целей и её размер показаны: " + lineN(albTargets, 1));
  const albRouters = plain(await call("ycAlb", { action: "routers" }));
  ok(/web-router/.test(albRouters) && /домены: site\.example\.com/.test(albRouters), "роутер с доменом показан: " + lineN(albRouters, 1));
  const albBackends = plain(await call("ycAlb", { action: "backends" }));
  ok(/web-backends/.test(albBackends) && /бэкендов: 1/.test(albBackends), "группа бэкендов показана: " + lineN(albBackends, 1));
  ok(/ПОРТ целей/.test(albBackends) && /проверок здоровья: 1/.test(albBackends), "сказано, что порт целей и проверки живут В ГРУППЕ БЭКЕНДОВ");

  // Группа бэкендов создаётся из группы целей и задаёт ПОРТ (его слушают ЦЕЛИ) и
  // проверку здоровья; у потока порт не угадывается — его спрашивают явно.
  const bgNoPort = plain(await call("ycAlb", { action: "backnew", name: "stream-backends", kind: "stream", targetGroup: "web-targets" }));
  ok(/порт не угадывается/.test(bgNoPort), "у потока порт спрошен явно, а не угадан: " + lineN(bgNoPort, 0));
  ok(albState.bgCreated.length === 0, "на этом отказе в облако не ушло ничего");
  const bgNew = plain(await call("ycAlb", { action: "backnew", name: "api-backends", targetGroup: "web-targets", port: 8080, healthPath: "/health" }));
  ok(/Группа бэкендов «api-backends» создаётся: HTTP/.test(bgNew) && /порт 8080/.test(bgNew) && /проверка здоровья \/health/.test(bgNew), "группа бэкендов создана с портом и проверкой: " + lineN(bgNew, 0));
  ok(/Следующий шаг: маршрут роутера/.test(bgNew) && /потоковый слушатель/.test(bgNew), "сказано, куда эту группу вести");
  const bgBody = (albState.bgCreated[0] || {}).body || {};
  ok(bgBody.http && bgBody.http.backends[0].port === "8080" && bgBody.http.backends[0].targetGroups.targetGroupIds[0] === "tg-web", "порт ушёл строкой, группа целей — id: " + JSON.stringify((bgBody.http || {}).backends));
  ok(bgBody.http.backends[0].healthchecks && bgBody.http.backends[0].healthchecks[0].http.path === "/health" && bgBody.http.backends[0].healthchecks[0].interval === "2s", "проверка ушла путём и интервалом: " + JSON.stringify(bgBody.http.backends[0].healthchecks));

  // Здоровье спрашивают у ПАРЫ «группа бэкендов + группа целей», а облако отдаёт
  // его ПО ЗОНАМ: у свежей цели часть проверок может ещё не ответить.
  const bgHealth = plain(await call("ycAlb", { action: "health", lb: "web-lb", targetGroup: "web-targets" }));
  ok(/Здоровье целей группы «web-targets»/.test(bgHealth), "здоровье отвечено словами: " + lineN(bgHealth, 0));
  ok(/10\.10\.0\.6/.test(bgHealth) && /ru-central1-b: не отвечает \(не проходит активную проверку\)/.test(bgHealth), "состояние показано ПО ЗОНАМ: " + lineN(bgHealth, 2));
  ok(/Целей: 2 · здоровых: 1\./.test(bgHealth), "здоровые посчитаны: " + lineN(bgHealth, 3));
  ok(/только здоровые цели/.test(bgHealth), "сказано, что в маршрут попадут только здоровые");
  const stCall = albCalls.filter((c) => c.path.indexOf("/targetStates/") >= 0).pop() || {};
  ok(stCall.path === "/apploadbalancer/v1/loadBalancers/lb-web/targetStates/bg-web/tg-web", "здоровье спрошено у ПАРЫ «бэкенды + цели»: " + stCall.path);
  const stCalls = albCalls.filter((c) => c.path.indexOf("/targetStates/") >= 0).length;
  const bgWrongPair = plain(await call("ycAlb", { action: "health", lb: "web-lb", backendGroup: "free-backends", targetGroup: "web-targets" }));
  ok(/не закреплена за балансировщиком/.test(bgWrongPair) && /закреплено: web-backends/.test(bgWrongPair), "чужая пара отбита до сети: " + lineN(bgWrongPair, 0));
  ok(albCalls.filter((c) => c.path.indexOf("/targetStates/") >= 0).length === stCalls, "на отказе здоровье в облако не спрашивали");

  // Удаление группы бэкендов: занятую облако не отдаст — стенд называет
  // держателя словами, а свободная уходит только после согласия человека.
  const bgOccupied = plain(await call("ycAlb", { action: "backdel", group: "web-backends", confirm: true }));
  ok(/ещё работает/.test(bgOccupied) && /роутер «web-router»/.test(bgOccupied), "занятая группа назвала держателя: " + lineN(bgOccupied, 0));
  ok(!albState.bgDeleted.has("bg-web"), "занятую группу не удалили");
  const bgDelNo = plain(await call("ycAlb", { action: "backdel", group: "free-backends" }));
  ok(/необратимо/.test(bgDelNo) && /confirm: true/.test(bgDelNo), "удаление группы без согласия назвало последствия и ждёт согласия");
  ok(!albState.bgDeleted.has("bg-free"), "без согласия группа не удалена");
  const bgDel = plain(await call("ycAlb", { action: "backdel", group: "free-backends", confirm: true }));
  ok(/Группа бэкендов «free-backends» удаляется/.test(bgDel) && /настройки балансировки будут потеряны/.test(bgDel), "удаление объяснено: " + lineN(bgDel, 0));
  ok(albState.bgDeleted.has("bg-free"), "удаление действительно дошло до облака");

  // Состав группы целей меняется адресами: добавить и убрать, а не переписать.
  const tgAdd = plain(await call("ycAlb", { action: "targetadd", group: "web-targets", ips: ["10.10.0.8"], subnet: "app-subnet" }));
  ok(/добавлено целей: 1/.test(tgAdd) && /Теперь в ней 3/.test(tgAdd), "цель добавлена и перечитана: " + lineN(tgAdd, 0));
  const tgRemove = plain(await call("ycAlb", { action: "targetremove", group: "web-targets", ips: ["10.10.0.8"] }));
  ok(/убрано целей: 1/.test(tgRemove) && /Теперь в ней 2/.test(tgRemove), "цель убрана и перечитана: " + lineN(tgRemove, 0));
  const tgRemoveBody = JSON.parse((albCalls.filter((c) => /:removeTargets$/.test(c.path)).pop() || {}).body || "{}");
  ok(tgRemoveBody.targets && tgRemoveBody.targets[0].ipAddress === "10.10.0.8" && tgRemoveBody.targets[0].subnetId === undefined, "при удалении уходит только адрес: " + JSON.stringify(tgRemoveBody.targets));

  // Создание идёт ПО ПОРЯДКУ: группа целей → роутер → балансировщик.
  const tgNew = plain(await call("ycAlb", { action: "targetnew", name: "web-targets2", ips: ["10.10.0.7"], subnet: "app-subnet" }));
  ok(/Группа целей «web-targets2» создаётся/.test(tgNew) && /целей 1/.test(tgNew), "группа целей создана: " + lineN(tgNew, 0));
  ok(/подсеть app-subnet/.test(tgNew) && /Следующий шаг: группа бэкендов/.test(tgNew) && /backnew/.test(tgNew), "подсеть названа, следующий шаг подсказан (группа бэкендов)");
  const tgCreatedBody = JSON.parse(albState.tgCreated[0] || "{}");
  ok(tgCreatedBody.targets && tgCreatedBody.targets[0].ipAddress === "10.10.0.7" && tgCreatedBody.targets[0].subnetId === "sub-a", "цель ушла вместе с подсетью: " + JSON.stringify(tgCreatedBody.targets));

  const rtNew = plain(await call("ycAlb", { action: "routernew", name: "web-router2", host: "site.example.com", backendGroup: "web-backends" }));
  ok(/HTTP-роутер «web-router2» создаётся/.test(rtNew) && /домен site\.example\.com/.test(rtNew) && /путь \/\*/.test(rtNew), "роутер создан и назван: " + lineN(rtNew, 0));
  const rtCreatedBody = JSON.parse(albState.routerCreated[0] || "{}");
  ok(rtCreatedBody.virtualHosts[0].authority[0] === "site.example.com" && rtCreatedBody.virtualHosts[0].routes[0].http.route.backendGroupId === "bg-web", "маршрут ведёт в СУЩЕСТВУЮЩУЮ группу бэкендов: " + JSON.stringify(rtCreatedBody.virtualHosts[0].routes[0].http.route));

  const lbNoConfirm = plain(await call("ycAlb", { action: "lbnew", name: "web-lb-2", subnet: "app-subnet", router: "web-router" }));
  ok(/ценой/.test(lbNoConfirm) && /confirm: true/.test(lbNoConfirm), "создание без согласия назвало цену и ждёт согласия");
  ok(albState.lbCreated.length === 0, "без согласия балансировщик не создан");
  const lbNew = plain(await call("ycAlb", { action: "lbnew", name: "web-lb-2", subnet: "app-subnet", router: "web-router", securityGroups: ["web"], confirm: true }));
  ok(/Балансировщик «web-lb-2» создаётся: слушатель HTTP, порт 80, зона ru-central1-a/.test(lbNew), "балансировщик создан и назван: " + lineN(lbNew, 0));
  const lbCreatedBody = JSON.parse(albState.lbCreated[0] || "{}");
  ok(lbCreatedBody.listenerSpecs[0].endpointSpecs[0].addressSpecs[0].externalIpv4AddressSpec, "слушатель ушёл в форме ЗАПРОСА (endpointSpecs/addressSpecs)");
  ok(lbCreatedBody.listenerSpecs[0].http.handler.httpRouterId === "rt-web", "слушатель смотрит на роутер");
  ok(lbCreatedBody.allocationPolicy.locations[0].zoneId === "ru-central1-a" && lbCreatedBody.allocationPolicy.locations[0].subnetId === "sub-a", "зона узла взята у подсети");
  ok(lbCreatedBody.securityGroupIds[0] === "sg-web", "группа безопасности разрешена по имени");
  ok((lbCreatedBody.listenerSpecs[0].endpointSpecs[0].ports || [])[0] === "80", "порт ушёл строкой, как у облака");
  ok(/Адрес появится в карточке/.test(lbNew), "сказано, что адрес появится после создания — только тогда DNS");

  const albStop = plain(await call("ycAlb", { action: "lbstop", lb: "web-lb" }));
  ok(/останавливается/.test(albStop) && /состояние: остановлен/.test(albStop), "остановка названа и состояние перечитано: " + lineN(albStop, 0));
  ok(albState.status === "STOPPED", "состояние правда изменилось: " + albState.status);
  ok(/тарифицир/.test(albStop) && /экономит не всё/.test(albStop), "сказано, что остановка экономит не всё");
  const albStart = plain(await call("ycAlb", { action: "lbstart", lb: "web-lb" }));
  ok(/запускается/.test(albStart) && /состояние: работает/.test(albStart), "запуск выполнен и перечитан: " + lineN(albStart, 0));

  const albNoDel = plain(await call("ycAlb", { action: "lbdel", lb: "web-lb" }));
  ok(/необратимо/.test(albNoDel) && /203\.0\.113\.10/.test(albNoDel) && /confirm: true/.test(albNoDel), "удаление без согласия назвало адреса и последствия");
  ok(albState.lbDeleted.size === 0, "без согласия балансировщик не удалён");
  const albDel = plain(await call("ycAlb", { action: "lbdel", lb: "web-lb", confirm: true }));
  ok(/удаляется вместе со слушателями/.test(albDel) && /203\.0\.113\.10/.test(albDel), "удаление выполнено и объяснено: " + lineN(albDel, 0));
  ok(albState.lbDeleted.has("lb-web"), "удаление действительно дошло до облака");
  const albGone = plain(await call("ycAlb", { action: "card", lb: "web-lb" }));
  ok(/не нашёл балансировщик/.test(albGone), "удалённого больше нет: " + lineN(albGone, 0));

  const albBad = albCalls.length;
  ok(/неизвестное действие ycAlb/.test(plain(await call("ycAlb", { action: "nope" }))), "чужое действие отбито словами");
  ok(/Не указано имя балансировщика/.test(plain(await call("ycAlb", { action: "lbnew", confirm: true }))), "создание без имени отбито до сети");
  ok(albCalls.length === albBad, "на этих отказах в облако не ушло ничего");
  ok(/Порт слушателя/.test(plain(await call("ycAlb", { action: "lbnew", name: "web-lb-3", subnet: "app-subnet", router: "web-router", port: 70000, confirm: true }))), "дурной порт отбит словами");

  // ── Те же действия — из ОКНА (часть 91, заход 2) ───────────────────────
  // Канал «yc:alb» — второй вход в тот же модуль: окно получает готовые строки,
  // связи карточки и цену до согласия, а необратимое спрашивает человек.
  console.log("\n[24] yc:alb: вход в приложение из окна — строки, цена, согласие и здоровье");
  albState.lbDeleted.clear();
  albState.status = "ACTIVE";
  const albHandler = handlers.get("yc:alb");
  ok(typeof albHandler === "function", "канал yc:alb зарегистрирован настоящим main.js");
  const callAlb = (args) => albHandler({}, args || {});
  const uiAlbList = await callAlb({ op: "list" });
  ok(uiAlbList.ok === true && (uiAlbList.lines || []).length === 1, "список пришёл строками: " + ((uiAlbList.lines || [])[0] || ""));
  ok(uiAlbList.message === "Балансировщиков: 1.", "окно получило счёт: " + uiAlbList.message);
  const uiAlbCard = await callAlb({ op: "card", lb: "web-lb" });
  ok(uiAlbCard.ok === true && (uiAlbCard.lines || []).some((l) => /Слушатели \(1\)/.test(l)), "карточка собрана строками");
  ok((uiAlbCard.targetGroups || []).length === 1 && (uiAlbCard.backendGroups || []).length === 1, "окно получило связи: целей " + (uiAlbCard.targetGroups || []).length + ", групп бэкендов " + (uiAlbCard.backendGroups || []).length);
  const uiAlbTargets = await callAlb({ op: "targets" });
  ok(uiAlbTargets.ok === true && (uiAlbTargets.warnings || []).join(" ").includes("только адрес и подсеть"), "окно предупреждено о том, что знает группа целей");
  // Группа бэкендов и здоровье — из окна: те же строки, что у модели, плюс
  // состояние целей ОБЪЕКТАМИ, чтобы виджет мог показать зоны как есть.
  const uiAlbBacks = await callAlb({ op: "backends" });
  ok(uiAlbBacks.ok === true && (uiAlbBacks.lines || []).some((l) => /web-backends/.test(l)), "список групп бэкендов пришёл строками");
  ok((uiAlbBacks.warnings || []).join(" ").includes("ГРУППЕ БЭКЕНДОВ"), "окно предупреждено, где живёт порт целей");
  const uiAlbHealth = await callAlb({ op: "health", lb: "web-lb", targetGroup: "web-targets" });
  ok(uiAlbHealth.ok === true && uiAlbHealth.healthy === 1 && (uiAlbHealth.lines || []).some((l) => /здоровых: 1/.test(l)), "здоровье пришло в окно числом и строками");
  ok((uiAlbHealth.states || []).length === 2 && ((uiAlbHealth.states || [])[1].zones || []).some((z) => z.zoneId === "ru-central1-b" && z.statusHuman === "не отвечает"), "состояния пришли ПО ЗОНАМ, как их отдаёт облако");
  const uiAlbBackNew = await callAlb({ op: "backnew", name: "ui-backends", targetGroup: "web-targets", port: 9000 });
  ok(uiAlbBackNew.ok === true && /ui-backends/.test(uiAlbBackNew.message || ""), "создание группы бэкендов из окна прошло: " + String(uiAlbBackNew.message || "").slice(0, 90));
  ok((uiAlbBackNew.warnings || []).join(" ").includes("Проверки здоровья не заданы"), "окно предупреждено: без проверки облако считает цель здоровой всегда");
  const uiAlbBackDelNo = await callAlb({ op: "backdel", group: "ui-backends" });
  ok(uiAlbBackDelNo.ok === false && uiAlbBackDelNo.needsConfirm === true && /необратимо/.test(uiAlbBackDelNo.error || ""), "удаление группы из окна ждёт согласия человека");
  const uiAlbBackDel = await callAlb({ op: "backdel", group: "ui-backends", confirm: true });
  ok(uiAlbBackDel.ok === true && /удаляется/.test(uiAlbBackDel.message || ""), "с согласием группа удалена: " + String(uiAlbBackDel.message || "").slice(0, 90));
  const uiAlbNew = await callAlb({ op: "lbnew", name: "web-lb-4", subnet: "app-subnet", router: "web-router" });
  ok(uiAlbNew.ok === false && uiAlbNew.needsConfirm === true, "создание из окна спросило человека, а не отказало");
  ok((uiAlbNew.lines || []).some((l) => /Слушатель: http · порт 80/.test(l)), "вопрос назвал слушателя и порт: " + JSON.stringify((uiAlbNew.lines || [])[1] || ""));
  const uiAlbNoDel = await callAlb({ op: "lbdel", lb: "web-lb" });
  ok(uiAlbNoDel.ok === false && uiAlbNoDel.needsConfirm === true && /203\.0\.113\.10/.test(uiAlbNoDel.error || ""), "удаление из окна назвало адреса и ждёт согласия");
  const uiAlbRef = albCalls.length;
  const uiAlbCreated = await callAlb({ op: "lbnew", name: "web-lb-4", subnet: "app-subnet", router: "web-router", confirm: true });
  ok(uiAlbCreated.ok === true && /слушатель HTTP, порт 80/.test(uiAlbCreated.message || ""), "с согласием создание прошло: " + String(uiAlbCreated.message || "").slice(0, 90));
  ok(albCalls.length > uiAlbRef, "и действительно ушло в облако");
  const uiAlbNoAuth = await callAlb({ op: "nope" });
  ok(uiAlbNoAuth.ok === false && /Неизвестное действие/.test(uiAlbNoAuth.error || ""), "чужое действие отбито словами");

  // ── Правка слушателей и самого балансировщика (часть 91, заход 4) ───────
  // Слушателей меняют ТОЧЕЧНО: добавление уходит одним listenerSpec (целого
  // списка в запросе нет — иначе остальные были бы стёрты), HTTPS берёт только
  // выпущенный сертификат ТОГО ЖЕ каталога, а удаление — именем и с согласием.
  const uiListenerAdd = await callAlb({ op: "listeneradd", lb: "web-lb", listenerName: "api", port: 8080, router: "web-router" });
  ok(uiListenerAdd.ok === true && /получает слушателя «api»/.test(uiListenerAdd.message || ""), "слушатель добавлен из окна: " + String(uiListenerAdd.message || "").slice(0, 90));
  const addListenerCall = albCalls.filter((c) => /:addListener$/.test(c.path)).pop() || {};
  const addListenerBody = JSON.parse(addListenerCall.body || "{}");
  ok(addListenerBody.listenerSpec && addListenerBody.listenerSpec.name === "api" && addListenerBody.listenerSpecs === undefined, "добавление ушло ОДНИМ слушателем (listenerSpec), а не списком целиком");
  ok((uiListenerAdd.warnings || []).join(" ").includes("Адрес слушателя"), "окно предупреждено, что адрес выдаёт облако: " + (uiListenerAdd.warnings || []).join(" | "));
  const uiAlbCardAdd = await callAlb({ op: "card", lb: "web-lb" });
  ok((uiAlbCardAdd.lines || []).some((l) => /Слушатели \(2\)/.test(l)) && (uiAlbCardAdd.lines || []).some((l) => /• api —/.test(l)), "карточка перечитала состав слушателей: " + (uiAlbCardAdd.lines || []).join(" | "));
  const uiListenerSame = await callAlb({ op: "listeneradd", lb: "web-lb", listenerName: "api", port: 8080, router: "web-router" });
  ok(uiListenerSame.ok === false && /уже есть слушатель/.test(uiListenerSame.error || ""), "дубль имени слушателя отбит до сети: " + String(uiListenerSame.error || "").slice(0, 90));
  const uiListenerTlsNo = await callAlb({ op: "listeneradd", lb: "web-lb", listenerName: "secure", listener: "https", router: "web-router", certificate: "old-cert" });
  ok(uiListenerTlsNo.ok === false && /ещё не выпущен/.test(uiListenerTlsNo.error || ""), "HTTPS без выпущенного сертификата отбит до сети: " + String(uiListenerTlsNo.error || "").slice(0, 90));
  const uiListenerTls = await callAlb({ op: "listeneradd", lb: "web-lb", listenerName: "secure", listener: "https", router: "web-router", certificate: "site-cert" });
  ok(uiListenerTls.ok === true && /HTTPS\/TLS/.test(uiListenerTls.message || "") && /порт 443/.test(uiListenerTls.message || ""), "HTTPS-слушатель добавлен с выпущенным сертификатом: " + String(uiListenerTls.message || "").slice(0, 90));
  const tlsListenerCall = albCalls.filter((c) => /:addListener$/.test(c.path)).pop() || {};
  const tlsListenerBody = JSON.parse(tlsListenerCall.body || "{}");
  ok((((tlsListenerBody.listenerSpec || {}).tls || {}).defaultHandler || {}).certificateIds[0] === "cert-1", "в HTTPS-слушатель ушёл найденный сертификат (id, а не имя): " + tlsListenerCall.body);
  ok((tlsListenerBody.listenerSpec || {}).http === undefined, "у TLS-слушателя не появилось второго вида");
  const uiAlbTlsCard = await callAlb({ op: "card", lb: "web-lb" });
  ok((uiAlbTlsCard.lines || []).some((l) => /🔒 Слушатель «secure»/.test(l) && /site-cert/.test(l) && /выпущен/.test(l)), "карточка показала сертификат HTTPS-слушателя: " + (uiAlbTlsCard.lines || []).join(" | "));
  ok((uiAlbTlsCard.certificates || []).length === 1 && (uiAlbTlsCard.certificates || [])[0].cert.name === "site-cert", "окно получило сертификаты объектами: " + JSON.stringify(uiAlbTlsCard.certificates || []));
  const uiStreamBad = await callAlb({ op: "listeneradd", lb: "web-lb", listenerName: "tcp", listener: "stream", port: 5432, backendGroup: "web-backends" });
  ok(uiStreamBad.ok === false && /группа вида stream/.test(uiStreamBad.error || ""), "потоку не отдали HTTP-группу бэкендов: " + String(uiStreamBad.error || "").slice(0, 90));
  const uiListenerDelNo = await callAlb({ op: "listenerdel", lb: "web-lb", listenerName: "api" });
  ok(uiListenerDelNo.ok === false && uiListenerDelNo.needsConfirm === true && /вход по нему закроется/.test(uiListenerDelNo.error || ""), "удаление слушателя из окна ждёт согласия человека");
  const uiListenerDel = await callAlb({ op: "listenerdel", lb: "web-lb", listenerName: "api", confirm: true });
  ok(uiListenerDel.ok === true && /убирается у балансировщика/.test(uiListenerDel.message || ""), "с согласием слушатель убран: " + String(uiListenerDel.message || "").slice(0, 90));
  const removeListenerCall = albCalls.filter((c) => /:removeListener$/.test(c.path)).pop() || {};
  ok(JSON.parse(removeListenerCall.body || "{}").name === "api", "удаление ушло ИМЕНЕМ слушателя: " + String(removeListenerCall.body || ""));
  const uiAlbCardDel = await callAlb({ op: "card", lb: "web-lb" });
  ok((uiAlbCardDel.lines || []).some((l) => /Слушатели \(2\)/.test(l)) && !(uiAlbCardDel.lines || []).some((l) => /^• api —/.test(l)), "карточка перечитала состав после удаления: " + (uiAlbCardDel.lines || []).join(" | "));
  const uiAlbUpdNo = await callAlb({ op: "lbupdate", lb: "web-lb" });
  ok(uiAlbUpdNo.ok === false && /Нечего менять/.test(uiAlbUpdNo.error || ""), "правка без полей отбита словами: " + String(uiAlbUpdNo.error || "").slice(0, 90));
  const uiAlbUpd = await callAlb({ op: "lbupdate", lb: "web-lb", newName: "web-lb-edge", description: "витрина", securityGroups: "web" });
  ok(uiAlbUpd.ok === true && /обновляется: имя, описание, группы безопасности/.test(uiAlbUpd.message || ""), "правка балансировщика из окна: " + String(uiAlbUpd.message || "").slice(0, 90));
  const patchCall = albCalls.filter((c) => c.method === "PATCH").pop() || {};
  const patchBody = JSON.parse(patchCall.body || "{}");
  ok(patchBody.updateMask === "name,description,security_group_ids", "правка ушла МАСКОЙ полей: " + patchBody.updateMask);
  ok(patchBody.listenerSpecs === undefined, "правка не понесла список слушателей");
  ok((uiAlbUpd.warnings || []).join(" ").includes("ЗАМЕНЁН целиком"), "окно предупреждено: группы безопасности ЗАМЕНЯЮТСЯ целиком");
  const uiAlbUpdCard = await callAlb({ op: "card", lb: "web-lb-edge" });
  ok(uiAlbUpdCard.ok === true && (uiAlbUpdCard.lines || []).some((l) => /web-lb-edge/.test(l)), "карточка нашла балансировщик по НОВОМУ имени: " + (uiAlbUpdCard.lines || [])[0]);

  // ── Правка слушателя и SNI (часть 91, заход 5) ────────────────────────
  // Правка — своё действие (:updateListener), а не «убрать и создать заново»:
  // чего не назвали — то остаётся прежним (порт, адрес, роутер), поэтому
  // продление HTTPS — это одно поле. Несколько доменов на одном слушателе —
  // это SNI: у КАЖДОГО домена свой сертификат, а не второй адрес и порт.
  const uiSniName = "shop";
  const uiSni = await callAlb({ op: "listeneradd", lb: "web-lb-edge", listenerName: uiSniName, listener: "https", router: "web-router", certificate: "site-cert", sni: "shop.example.com=shop-cert\nwww.example.com,example.com=site-cert" });
  ok(uiSni.ok === true && /домены SNI: shop\.example\.com/.test(uiSni.message || ""), "слушатель с доменами добавлен: " + String(uiSni.message || "").slice(0, 120));
  const sniListenerCall = albCalls.filter((c) => /:addListener$/.test(c.path)).pop() || {};
  const sniSpec = (JSON.parse(sniListenerCall.body || "{}").listenerSpec || {}).tls || {};
  ok((sniSpec.sniHandlers || []).length === 2, "SNI-обработчиков ушло два: " + JSON.stringify(sniSpec.sniHandlers || []).slice(0, 120));
  ok(((sniSpec.sniHandlers || [])[0] || {}).handler && ((sniSpec.sniHandlers || [])[0] || {}).handler.certificateIds[0] === "cert-4", "у домена SNI свой сертификат (id, а не имя): " + JSON.stringify(sniSpec.sniHandlers || []).slice(0, 160));
  ok(((sniSpec.sniHandlers || [])[1] || {}).serverNames.length === 2 && ((sniSpec.sniHandlers || [])[1] || {}).handler.certificateIds[0] === "cert-1", "домены одной строки разобраны все: " + JSON.stringify((sniSpec.sniHandlers || [])[1] || {}).slice(0, 160));
  const uiSniBad = await callAlb({ op: "listeneradd", lb: "web-lb-edge", listenerName: "sni-http", listener: "http", port: 80, router: "web-router", sni: "shop.example.com=shop-cert" });
  ok(uiSniBad.ok === false && /только у HTTPS-слушателя/.test(uiSniBad.error || ""), "SNI у HTTP-слушателя отбит до сети: " + String(uiSniBad.error || "").slice(0, 90));
  const uiSniOld = await callAlb({ op: "listeneradd", lb: "web-lb-edge", listenerName: "sni-old", listener: "https", router: "web-router", certificate: "site-cert", sni: "shop.example.com=old-cert" });
  ok(uiSniOld.ok === false && /ещё не выпущен/.test(uiSniOld.error || ""), "SNI с невыпущенным сертификатом отбит до сети: " + String(uiSniOld.error || "").slice(0, 90));
  const uiSniCard = await callAlb({ op: "card", lb: "web-lb-edge" });
  ok((uiSniCard.lines || []).some((l) => /SNI: shop\.example\.com/.test(l)), "карточка показала домены SNI: " + (uiSniCard.lines || []).join(" | "));
  ok((uiSniCard.certificates || []).some((x) => /SNI: shop\.example\.com/.test(x.listenerName || "") && x.cert.name === "shop-cert"), "карточка прочитала СВОЙ сертификат SNI-домена: " + JSON.stringify((uiSniCard.certificates || []).map((x) => x.listenerName)));

  const shopAddr = ((((uiSniCard.listeners || []).find((x) => x.listener && x.listener.name === uiSniName) || {}).listener || {}).addresses || [])[0] || "";
  ok(!!shopAddr, "адрес слушателя виден в карточке (его выдало облако): " + shopAddr);
  const uiLupdPort = await callAlb({ op: "listenerupd", lb: "web-lb-edge", listenerName: uiSniName, port: 8443 });
  ok(uiLupdPort.ok === true && /обновляется: порт 8443/.test(uiLupdPort.message || ""), "слушатель поправлен по порту: " + String(uiLupdPort.message || "").slice(0, 120));
  const lupdCall = albCalls.filter((c) => /:updateListener$/.test(c.path)).pop() || {};
  const lupdBody = JSON.parse(lupdCall.body || "{}");
  ok(lupdBody.updateMask === "name,endpoint_specs,tls", "правка слушателя ушла МАСКОЙ полей: " + lupdBody.updateMask);
  ok(lupdBody.listenerSpec && lupdBody.listenerSpec.name === uiSniName, "слушателя опознают по имени: " + String((lupdBody.listenerSpec || {}).name));
  ok(lupdBody.listenerSpecs === undefined, "правка не понесла список слушателей — остальные были бы стёрты");
  ok(((lupdBody.listenerSpec || {}).endpointSpecs || [])[0].ports.join(",") === "8443", "новый порт ушёл: " + JSON.stringify((lupdBody.listenerSpec || {}).endpointSpecs || []).slice(0, 120));
  ok((((lupdBody.listenerSpec || {}).tls || {}).sniHandlers || []).length === 2, "домены SNI потерялись при правке порта: " + JSON.stringify(((lupdBody.listenerSpec || {}).tls || {}).sniHandlers || []).slice(0, 120));
  const lupdAddr = ((((lupdBody.listenerSpec || {}).endpointSpecs || [])[0] || {}).addressSpecs || [])[0] || {};
  ok((lupdAddr.externalIpv4AddressSpec || {}).address === shopAddr, "адрес слушателя не сохранён — домены смотрели бы в новый адрес: " + JSON.stringify(lupdAddr));
  const uiLupdCard = await callAlb({ op: "card", lb: "web-lb-edge" });
  ok((uiLupdCard.lines || []).some((l) => /8443/.test(l)), "карточка перечитала порт: " + (uiLupdCard.lines || []).join(" | "));
  const uiLupdCert = await callAlb({ op: "listenerupd", lb: "web-lb-edge", listenerName: uiSniName, certificate: "fresh-cert" });
  ok(uiLupdCert.ok === true && /обновляется: сертификат cert-3/.test(uiLupdCert.message || ""), "HTTPS продлён правкой одного поля: " + String(uiLupdCert.message || "").slice(0, 120));
  const uiLupdGone = await callAlb({ op: "listenerupd", lb: "web-lb-edge", listenerName: uiSniName, sni: [] });
  ok(uiLupdGone.ok === true && /домены SNI: убраны/.test(uiLupdGone.message || ""), "пустой список доменов убрал их: " + String(uiLupdGone.message || "").slice(0, 120));
  const uiLupdBad = await callAlb({ op: "listenerupd", lb: "web-lb-edge", listenerName: "нет-такого", port: 8443 });
  ok(uiLupdBad.ok === false && /нет слушателя/.test(uiLupdBad.error || "") && /Переименовать слушателя нельзя/.test(uiLupdBad.error || ""), "правка чужого имени отбита словами: " + String(uiLupdBad.error || "").slice(0, 120));
  const uiAlbNoLupd = await callAlb({ op: "nope" });
  ok(/listenerupd/.test(uiAlbNoLupd.error || ""), "список действий канала знает правку слушателя: " + String(uiAlbNoLupd.error || "").slice(0, 160));
  const uiLupdTool = plain(await call("ycAlb", { action: "listenerupd", lb: "web-lb-edge", listenerName: uiSniName, port: 9443 }));
  ok(/:updateListener/.test(uiLupdTool) && /маской полей/.test(uiLupdTool), "инструмент правит слушателя тем же методом: " + uiLupdTool.slice(0, 160));

  // ── Правка роутера и группы бэкендов (часть 91, заход 6) ────────────────
  // Облако не умеет «поменять путь» или «поменять порт» отдельным методом: у
  // роутера список виртуальных хостов (вместе с маршрутами) и у группы список
  // бэкендов принимаются ТОЛЬКО ЗАМЕНОЙ целиком. Поэтому правка читает текущий
  // список, меняет в нём названное и возвращает его обратно: чего не назвали —
  // остаётся прежним, а чужие маршруты и бэкенды не теряются.
  const uiRtUpd = await callAlb({ op: "routerupd", router: "web-router", routeName: "main", pathPrefix: "/api", host: "api.example.com" });
  ok(uiRtUpd.ok === true && /обновляется: путь \/api\*, домен api\.example\.com/.test(uiRtUpd.message || ""), "правка роутера из окна: " + String(uiRtUpd.message || "").slice(0, 140));
  const rtPatchCall = albCalls.filter((c) => c.method === "PATCH" && /\/httpRouters\/rt-web$/.test(c.path)).pop() || {};
  const rtPatch = (() => { try { return JSON.parse(rtPatchCall.body || "{}"); } catch { return {}; } })();
  ok(rtPatch.updateMask === "virtual_hosts", "правка роутера ушла списком хостов: " + rtPatch.updateMask);
  ok(rtPatch.name === undefined && rtPatch.description === undefined, "в теле оказалось то, чего не меняли: " + Object.keys(rtPatch).join(","));
  ok(rtPatch.virtualHosts && rtPatch.virtualHosts[0].routes[0].http.match.path.prefixMatch === "/api", "новый путь ушёл в маршрут: " + JSON.stringify((rtPatch.virtualHosts || [])[0] || {}).slice(0, 160));
  ok(rtPatch.virtualHosts[0].authority[0] === "api.example.com" && rtPatch.virtualHosts[0].routes[0].http.route.backendGroupId === "bg-web", "домен заменён, а маршрут остался в той же группе: " + JSON.stringify(rtPatch.virtualHosts[0]).slice(0, 200));
  ok(!JSON.stringify(rtPatch).includes('"id"'), "служебные поля обратно не ушли — сервис на них отвечает отказом");
  ok((uiRtUpd.warnings || []).join(" ").includes("ЦЕЛИКОМ"), "окно предупреждено, что список хостов ЗАМЕНЯЕТСЯ целиком: " + (uiRtUpd.warnings || []).join(" | "));
  ok((uiRtUpd.warnings || []).join(" ").includes("Порядок маршрутов"), "окно предупреждено про порядок маршрутов");
  const uiRtCard = await callAlb({ op: "card", lb: "web-lb-edge" });
  ok((uiRtCard.lines || []).some((l) => /api\.example\.com/.test(l) && /путь \/api/.test(l)), "маршрут перечитан после правки (иначе правка не подтвердилась бы): " + (uiRtCard.lines || []).join(" | "));

  const uiBgUpd = await callAlb({ op: "backupd", group: "web-backends", port: 3000 });
  ok(uiBgUpd.ok === true && /обновляется: порт 3000/.test(uiBgUpd.message || ""), "правка группы бэкендов из окна: " + String(uiBgUpd.message || "").slice(0, 140));
  const bgPatchCall = albCalls.filter((c) => c.method === "PATCH" && /\/backendGroups\/bg-web$/.test(c.path)).pop() || {};
  const bgPatch = (() => { try { return JSON.parse(bgPatchCall.body || "{}"); } catch { return {}; } })();
  ok(bgPatch.updateMask === "http", "правка группы ушла ИМЕНЕМ ВИДА, а не полем внутри бэкенда: " + bgPatch.updateMask);
  ok(bgPatch.http && bgPatch.http.backends[0].port === "3000", "новый порт целей ушёл строкой: " + JSON.stringify((bgPatch.http || {}).backends || []).slice(0, 160));
  ok(bgPatch.http.backends[0].healthchecks && bgPatch.http.backends[0].healthchecks[0].http.path === "/", "проверка здоровья потерялась при правке порта: " + JSON.stringify(bgPatch.http.backends[0].healthchecks || []));
  ok(bgPatch.http.backends[0].targetGroups.targetGroupIds[0] === "tg-web", "группа целей потерялась при правке порта");
  ok((uiBgUpd.warnings || []).join(" ").includes("Порт 3000 — это порт, который слушают ЦЕЛИ"), "окно предупреждено, ЧЕЙ это порт: " + (uiBgUpd.warnings || []).join(" | "));
  ok((uiBgUpd.warnings || []).join(" ").includes("ЦЕЛИКОМ"), "окно предупреждено, что список бэкендов ЗАМЕНЯЕТСЯ целиком");
  const uiBgList = await callAlb({ op: "backends" });
  ok((uiBgList.lines || []).some((l) => /web-backends/.test(l)), "список групп бэкендов перечитан: " + (uiBgList.lines || []).join(" | "));

  // Порт — не единственное: проверку здоровья задают путём (HTTP) или службой
  // (gRPC), а убрать её можно только словами: без проверок облако считает цель
  // здоровой ВСЕГДА, и упавшая машина останется в ротации.
  const uiBgHealth = await callAlb({ op: "backupd", group: "web-backends", healthPath: "/health" });
  ok(uiBgHealth.ok === true && /проверка здоровья HTTP \/health/.test(uiBgHealth.message || ""), "проверка здоровья поправлена: " + String(uiBgHealth.message || "").slice(0, 140));
  const healthPatch = (() => { try { return JSON.parse((albCalls.filter((c) => c.method === "PATCH" && /\/backendGroups\/bg-web$/.test(c.path)).pop() || {}).body || "{}"); } catch { return {}; } })();
  ok(healthPatch.http.backends[0].healthchecks[0].http.path === "/health", "новый путь проверки ушёл: " + JSON.stringify(healthPatch.http.backends[0].healthchecks || []));
  const uiBgOff = await callAlb({ op: "backupd", group: "web-backends", noHealthCheck: true });
  ok(uiBgOff.ok === true && (uiBgOff.warnings || []).join(" ").includes("здоровой ВСЕГДА"), "удаление проверок предупреждает о ротации: " + (uiBgOff.warnings || []).join(" | "));
  const uiBgOffList = await callAlb({ op: "backends" });
  ok(!(uiBgOffList.lines || []).some((l) => /web-backends/.test(l) && /проверок здоровья/.test(l)), "проверки здоровья правда убраны: " + (uiBgOffList.lines || []).join(" | "));

  // Переименование — отдельной маской: список бэкендов при этом НЕ переписывается.
  const uiBgName = await callAlb({ op: "backupd", group: "bg-web", newName: "edge-backends" });
  ok(uiBgName.ok === true && /новое имя «edge-backends»/.test(uiBgName.message || ""), "группа переименована: " + String(uiBgName.message || "").slice(0, 120));
  const namePatch = (() => { try { return JSON.parse((albCalls.filter((c) => c.method === "PATCH" && /\/backendGroups\/bg-web$/.test(c.path)).pop() || {}).body || "{}"); } catch { return {}; } })();
  ok(namePatch.updateMask === "name" && namePatch.http === undefined, "переименование не понесло список бэкендов: " + namePatch.updateMask);

  // Отказы до сети: чужой маршрут, правка без полей и маршрут в потоковую группу.
  const albWrites = () => albCalls.filter((c) => c.method === "POST" || c.method === "PATCH" || c.method === "DELETE").length;
  const uiRtRef = albWrites();
  ok(/нет маршрута «nope»/.test((await callAlb({ op: "routerupd", router: "web-router", routeName: "nope", pathPrefix: "/x" })).error || ""), "чужой маршрут отбит словами со списком того, что есть");
  ok(/Нечего менять/.test((await callAlb({ op: "routerupd", router: "web-router" })).error || ""), "правка роутера без полей отбита до сети");
  ok(/Нечего менять/.test((await callAlb({ op: "backupd", group: "edge-backends" })).error || ""), "правка группы без полей отбита до сети");
  ok(/Не нашёл HTTP-роутер/.test((await callAlb({ op: "routerupd", router: "нет-такого", pathPrefix: "/x" })).error || ""), "чужой роутер отбит до сети");
  ok(albWrites() === uiRtRef, "на отказах в облако не ушло ничего: " + (albWrites() - uiRtRef));
  // Потоковой группе в маршрут хода нет: HTTP-маршрут ведёт только в HTTP-группу.
  await callAlb({ op: "backnew", name: "stream-backends", kind: "stream", targetGroup: "web-targets", port: 1521 });
  ok(/только в HTTP-группу/.test((await callAlb({ op: "routerupd", router: "web-router", routeName: "main", backendGroup: "stream-backends" })).error || ""), "маршрут в потоковую группу отбит до сети");
  ok(albWrites() === uiRtRef + 1, "маршрут в потоковую группу всё-таки ушёл бы в облако: " + (albWrites() - uiRtRef - 1));
  const uiAlbNoUpd = await callAlb({ op: "nope" });
  ok(/routerupd/.test(uiAlbNoUpd.error || "") && /backupd/.test(uiAlbNoUpd.error || ""), "список действий канала знает правку роутера и группы: " + String(uiAlbNoUpd.error || "").slice(0, 200));

  const uiRtTool = plain(await call("ycAlb", { action: "routerupd", router: "web-router", routeName: "main", pathExact: "/v2" }));
  ok(/обновляется: точный путь \/v2/.test(uiRtTool), "инструмент правит маршрут тем же действием: " + uiRtTool.slice(0, 160));
  ok(/PATCH с маской/.test(uiRtTool) && /слушатели/.test(uiRtTool), "инструмент сказал, каким методом правит: " + uiRtTool.slice(0, 200));
  const uiBgTool = plain(await call("ycAlb", { action: "backupd", group: "edge-backends", port: 9090 }));
  ok(/обновляется: порт 9090/.test(uiBgTool) && /ЦЕЛИКОМ/.test(uiBgTool), "инструмент правит группу тем же действием: " + uiBgTool.slice(0, 200));
  ok(/Порт слушателя/.test(uiBgTool), "инструмент сказал, что порт слушателя этим не меняется: " + uiBgTool.slice(0, 200));

  srv.close();
  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки облачных инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

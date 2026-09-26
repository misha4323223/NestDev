"use strict";

/* ── YDB: таблицы и записи базы (Document API) ────────────────────────────────
   Запуск: node test/yc-db.test.js   (входит в общий `npm test`)

   Зачем набор. Базу YDB в приложении было чем СОЗДАТЬ (ycCreate service "ydb") и
   увидеть в списке, а работать с ней — нечем: ни одной таблицы, ни одной записи
   не видели ни агент, ни консоль облака. Между тем serverless-база создаётся
   ровно ради данных — то есть это пустая полка того же рода, что секрет Lockbox
   без версии (часть 46) и бакет без файлов (часть 47).

   Главная тонкость, ради которой набор и написан. Таблицы живут в HTTP Document
   API, и его протокол НЕ такой, как у остальных сервисов каталога:
     1) операция задаётся ЗАГОЛОВКОМ X-Amz-Target: DynamoDB_20120810.<Метод>, а
        тело — JSON (Content-Type: application/x-amz-json-1.0); REST-путей вида
        /tables здесь нет — запрос всегда идёт в корень адреса базы;
     2) значения атрибутов ТИПИЗИРОВАНЫ ({ \"S\": \"cat\" }, { \"N\": \"10.5\" }),
        а не приходят как в JSON.
   И адрес берётся У САМОЙ БАЗЫ (documentApiEndpoint), а не собирается по памяти:
   у serverless и выделенных баз хосты разные. Если однажды кто-то «упростит»
   запрос до REST или зашьёт адрес — набор обязан покраснеть.

   Чего набор НЕ проверяет (честно): настоящую базу в облаке и её права —
   для этого нужен живой каталог владельца (scripts/live-yc-real.js). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

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
const plain = (v) => JSON.parse(JSON.stringify(v));

const { createYcDb } = require(path.join(ROOT, "src", "yc-db.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const ycConsole = require(path.join(ROOT, "src", "yc-console.js"));

const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke.test.js");
const IPC_SRC = read("src", "yc-ipc.js");
// У связи «Таблицы» НЕТ своего канала IPC: она идёт общим `yc:console:list`, как
// остальные связи карточки. Свой канал потребовал бы правок preload и моста.
const IPC_HAS_NO_DB_CHANNEL = !/yc:console:db/.test(IPC_SRC);
const PKG = JSON.parse(read("package.json"));

// ── Подменённая база: HTTP Document API ─────────────────────────────────────
// Один сервер повторяет ровно тот протокол, что и настоящее облако: операция —
// в заголовке, тело — JSON, значения — типизированные. Тогда и разбор ошибок, и
// сборка ключей проверяются на настоящих байтах, а не на воображении.
let dbList = []; // каталог баз, который отдаёт подменённый каталог (для панели)

function startDocStub() {
  const calls = [];
  // Таблица: { keys: [{name,type}], items: { <ключ как JSON>: item } }
  const tables = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = { _broken: raw };
      }
      const target = String(req.headers["x-amz-target"] || "");
      calls.push({ target: target, headers: req.headers, body: body, url: req.url });
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/x-amz-json-1.0" });
        res.end(JSON.stringify(o));
      };
      const fail = (code, type, message) =>
        json({ __type: "com.amazonaws.dynamodb.v20120810#" + type, message: message }, code);
      const method = target.replace("DynamoDB_20120810.", "");

      // Каталог и обмен OAuth → IAM: их зовёт ПАНЕЛЬ — она ходит настоящим
      // yandex-cloud.js, которому адрес подменяет AI_AGENT_YC_BASE.
      if (req.url === "/iam/v1/tokens") {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (req.url.indexOf("/ydb/v1/databases") >= 0) {
        return json({ databases: dbList });
      }

      if (method === "ListTables") return json({ TableNames: Array.from(tables.keys()) });
      if (method === "CreateTable") {
        const name = String(body.TableName || "");
        if (!name) return fail(400, "ValidationException", "TableName is required");
        const defs = body.AttributeDefinitions || [];
        const schema = body.KeySchema || [];
        if (!schema.length || !defs.length) return fail(400, "ValidationException", "Key schema required");
        if (tables.has(name)) return fail(400, "ResourceInUseException", "Table already exists");
        tables.set(name, {
          keys: schema.map((k) => ({ name: String(k.AttributeName || ""), kind: String(k.KeyType || "") })),
          defs: defs.map((d) => ({ name: String(d.AttributeName || ""), type: String(d.AttributeType || "") })),
          items: new Map(),
        });
        return json({ TableDescription: { TableName: name, TableStatus: "ACTIVE" } });
      }
      const t = tables.get(String(body.TableName || ""));
      if (method === "DeleteTable") {
        if (!t) return fail(400, "ResourceNotFoundException", "Cannot do operations on a non-existent table");
        tables.delete(String(body.TableName || ""));
        return json({ TableDescription: { TableName: body.TableName } });
      }
      if (!t) return fail(400, "ResourceNotFoundException", "Cannot do operations on a non-existent table");
      if (method === "DescribeTable") {
        return json({
          Table: {
            TableName: body.TableName,
            TableStatus: "ACTIVE",
            ItemCount: t.items.size,
            TableSizeBytes: t.items.size * 10,
            KeySchema: t.keys.map((k) => ({ AttributeName: k.name, KeyType: k.kind })),
          },
        });
      }
      // Значение одного поля ключа — как строка, чтобы собрать опознаватель записи.
      const keyOf = (typed) => {
        const parts = t.keys.map((k) => String(fromAttr(typed[k.name])));
        return parts.join("\u0000");
      };
      if (method === "PutItem") {
        if (!body.Item) return fail(400, "ValidationException", "Item is required");
        t.items.set(keyOf(body.Item), plain(body.Item));
        return json({});
      }
      if (method === "GetItem") {
        const found = body.Key ? t.items.get(keyOf(body.Key)) : null;
        return json(found ? { Item: found } : {});
      }
      if (method === "DeleteItem") {
        t.items.delete(keyOf(body.Key || {}));
        return json({});
      }
      if (method === "Scan") {
        const items = Array.from(t.items.values()).slice(0, Number(body.Limit) || 100);
        return json({ Items: items, Count: items.length });
      }
      return fail(400, "ValidationException", "Unknown operation " + method);
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({
        server,
        calls,
        tables,
        base: "http://127.0.0.1:" + server.address().port,
        reset: () => tables.clear(),
      })
    );
  });
}

// Разбор типизированного значения — маленькая копия для опознавателя записи.
function fromAttr(a) {
  if (a == null) return "";
  if ("S" in a) return a.S;
  if ("N" in a) return Number(a.N);
  if ("BOOL" in a) return !!a.BOOL;
  return JSON.stringify(a);
}

const work = workDir();
function workDir() {
  const os = require("os");
  return fs.mkdtempSync(path.join(os.tmpdir(), "yc-db-work-"));
}

// ── Подменённый модуль облака для инструмента агента ───────────────────────
// Отдаём НАСТОЯЩИЙ createYcDb, но с подменёнными помощниками облака: так протокол
// Document API проверяется целиком, вплоть до реальных HTTP-запросов.
function fakeCloud(db, over) {
  const calls = { list: [] };
  const cloud = Object.assign(
    {
      _fetchJson: async () => ({}),
      getIamToken: async () => "iam-test",
      endpoint: async () => "http://127.0.0.1:1",
      serviceByKey: () => ({ key: "ydb", title: "Managed Service for YDB", svc: "ydb", listPath: "/ydb/v1/databases", listKey: "databases" }),
      listService: async (oauth, folder, svc) => {
        calls.list.push({ oauth: oauth, folder: folder, svc: svc && svc.key });
        return { count: db.length, items: db };
      },
      hostOf: (u) => {
        try {
          return new URL(u).host;
        } catch {
          return String(u);
        }
      },
      serviceError: (e, base, p) => "сбой сети " + (e && e.message) + " (" + base + p + ")",
      isNetworkError: (e) => !!(e && /fetch failed|aborted|network/i.test(String((e && e.message) || e))),
    },
    over || {}
  );
  return { cloud, calls };
}

function buildTool(over, settingsOver) {
  const db = (over && over.__dbs) || [];
  const { cloud, calls } = fakeCloud(db, over && over.__cloud);
  const settings = Object.assign(
    {
      workingDir: work,
      yandexOauthToken: "oauth-1",
      ycCloudId: "cloud-1",
      ycFolderId: "folder-1",
      ycFolderName: "prod",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
    },
    settingsOver || {}
  );
  const tools = createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: cloud,
    resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(work, String(p))),
    agentWorkDir: () => work,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
      };
    },
    loadSettings: () => settings,
  });
  return { tools, calls, settings, cloud };
}

(async () => {
  const stub = await startDocStub();
  const DB = {
    id: "etn1",
    name: "app-db",
    status: "RUNNING",
    endpoint: "grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g/etn1",
    documentApiEndpoint: stub.base,
  };

  const mk = (over, settings) => buildTool(Object.assign({ __dbs: [DB] }, over || {}), settings);

  console.log("\n[1] Адрес Document API базы");

  await test("ycDb: адрес берётся у базы, а не собирается по памяти", () => {
    const api = createYcDb({});
    assert.strictEqual(api.documentApiEndpointFor(DB), stub.base, "взят не адрес базы");
    // Без documentApiEndpoint адрес выводится из gRPC-эндпоинта: хост меняется,
    // путь /<регион>/<облако>/<база> остаётся.
    const derived = api.documentApiEndpointFor({ endpoint: DB.endpoint });
    assert.strictEqual(derived, "https://docapi.serverless.yandexcloud.net/ru-central1/b1g/etn1", "адрес выведен неверно: " + derived);
    assert.strictEqual(api.documentApiEndpointFor({}), "", "без адресов должно быть пусто");
  });

  console.log("\n[2] Значения: обычный JSON ↔ типизированные значения DynamoDB");

  await test("ycDb: значения оборачиваются в типы и разворачиваются обратно", () => {
    const api = createYcDb({});
    const item = { s: "cat", n: 10.5, b: true, nil: null, list: [1, "two"], obj: { x: "y" } };
    const typed = api.toItem(item);
    assert.deepStrictEqual(typed.s, { S: "cat" }, "строка ушла не как S");
    assert.deepStrictEqual(typed.n, { N: "10.5" }, "число ушло не как N");
    assert.deepStrictEqual(typed.b, { BOOL: true }, "флаг ушёл не как BOOL");
    assert.deepStrictEqual(typed.nil, { NULL: true }, "null ушёл не как NULL");
    assert.deepStrictEqual(typed.list, { L: [{ N: "1" }, { S: "two" }] }, "массив ушёл не как L");
    assert.deepStrictEqual(typed.obj, { M: { x: { S: "y" } } }, "объект ушёл не как M");
    assert.deepStrictEqual(api.fromItem(typed), item, "обратный разбор не совпал");
  });

  await test("ycDb: наборы отдаются массивами, двоичные — пометкой, целое число пары", () => {
    const api = createYcDb({});
    assert.deepStrictEqual(api.fromAttrValue({ SS: ["a", "b"] }), ["a", "b"], "S-набор не разобран");
    assert.deepStrictEqual(api.fromAttrValue({ NS: ["1", "2"] }), [1, 2], "N-набор не разобран");
    assert.strictEqual(api.fromAttrValue({ B: "AAAA" }), "[двоичные данные]", "бинарь напечатан как есть");
    assert.strictEqual(api.fromAttrValue({ N: "7" }), 7, "число осталось строкой");
  });

  console.log("\n[3] Настоящие запросы Document API");

  await test("ycDb: список таблиц уходит заголовком X-Amz-Target и IAM-токеном", async () => {
    const api = createYcDb({
      getIamToken: async () => "iam-1",
      hostOf: (u) => new URL(u).host,
      serviceError: (e) => String(e && e.message),
      isNetworkError: () => false,
    });
    const r = await api.listDocumentTables("oauth", DB);
    assert.deepStrictEqual(r.tables, [], "пустая база дала непустой список");
    const call = stub.calls[stub.calls.length - 1];
    assert.strictEqual(call.target, "DynamoDB_20120810.ListTables", "операция ушла не заголовком: " + call.target);
    assert.strictEqual(call.headers.authorization, "Bearer iam-1", "нет IAM-авторизации");
    assert.ok(/x-amz-json-1\.0/.test(call.headers["content-type"]), "не тот Content-Type: " + call.headers["content-type"]);
    assert.strictEqual(call.url, "/", "запрос ушёл не в корень адреса базы: " + call.url);
  });

  await test("ycDb: создание таблицы шлёт ключ HASH/RANGE и типы полей", async () => {
    const api = createYcDb({ getIamToken: async () => "iam-1", hostOf: (u) => new URL(u).host, serviceError: (e) => String(e && e.message), isNetworkError: () => false });
    await api.createDocumentTable("oauth", DB, { table: "pets", keys: { species: "S", name: "S" } });
    const call = stub.calls[stub.calls.length - 1];
    assert.strictEqual(call.target, "DynamoDB_20120810.CreateTable", "не CreateTable");
    assert.deepStrictEqual(call.body.KeySchema, [
      { AttributeName: "species", KeyType: "HASH" },
      { AttributeName: "name", KeyType: "RANGE" },
    ], "ключ собран неверно: " + JSON.stringify(call.body.KeySchema));
    assert.deepStrictEqual(call.body.AttributeDefinitions, [
      { AttributeName: "species", AttributeType: "S" },
      { AttributeName: "name", AttributeType: "S" },
    ], "типы полей неверные");
  });

  await test("ycDb: пустой ключ и пустая запись до сети не уходят", async () => {
    const api = createYcDb({ getIamToken: async () => "iam-1", hostOf: (u) => new URL(u).host, serviceError: (e) => String(e && e.message), isNetworkError: () => false });
    await assert.rejects(() => api.createDocumentTable("oauth", DB, { table: "pets" }), /keys/, "пустой ключ не отвергнут");
    await assert.rejects(() => api.putDocumentItem("oauth", DB, { table: "pets", item: {} }), /Пустая запись/, "пустая запись не отвергнута");
    await assert.rejects(() => api.putDocumentItem("oauth", DB, { item: { a: 1 } }), /таблица/, "нет таблицы — не отвергнуто");
  });

  await test("ycDb: запись кладётся, читается, обходится и удаляется по ключу", async () => {
    stub.reset();
    const api = createYcDb({ getIamToken: async () => "iam-1", hostOf: (u) => new URL(u).host, serviceError: (e) => String(e && e.message), isNetworkError: () => false });
    await api.createDocumentTable("oauth", DB, { table: "pets", keys: { species: "S", name: "S" } });
    await api.putDocumentItem("oauth", DB, { table: "pets", item: { species: "cat", name: "Tom", price: 10.5, tags: ["black"] } });
    const got = await api.getDocumentItem("oauth", DB, { table: "pets", key: { species: "cat", name: "Tom" } });
    assert.deepStrictEqual(got.item, { species: "cat", name: "Tom", price: 10.5, tags: ["black"] }, "запись прочитана неверно: " + JSON.stringify(got.item));
    const scan = await api.scanDocumentTable("oauth", DB, { table: "pets" });
    assert.strictEqual(scan.items.length, 1, "обход дал не одну запись");
    const desc = await api.describeDocumentTable("oauth", DB, "pets");
    assert.deepStrictEqual(desc.keys, [{ name: "species", type: "HASH" }, { name: "name", type: "RANGE" }], "ключ в описании неверен");
    await api.deleteDocumentItem("oauth", DB, { table: "pets", key: { species: "cat", name: "Tom" } });
    const after = await api.scanDocumentTable("oauth", DB, { table: "pets" });
    assert.strictEqual(after.items.length, 0, "запись не удалилась");
  });

  await test("ycDb: отказ облака переводится словами, а не кодом", async () => {
    const api = createYcDb({ getIamToken: async () => "iam-1", hostOf: (u) => new URL(u).host, serviceError: (e) => String(e && e.message), isNetworkError: () => false });
    let caught = null;
    try {
      await api.getDocumentItem("oauth", DB, { table: "нет-такой", key: { id: "1" } });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "отказ не брошен");
    assert.ok(/Такой таблицы в базе нет/.test(caught.message), "отказ не объяснён: " + caught.message);
    assert.ok(!/__type|ResourceNotFound/.test(caught.message), "служебный код просочился в текст");
  });

  await test("ycDb: у базы без адреса Document API — честный отказ, а не запрос в никуда", async () => {
    const api = createYcDb({ getIamToken: async () => "iam-1", hostOf: (u) => new URL(u).host, serviceError: (e) => String(e && e.message), isNetworkError: () => false });
    await assert.rejects(() => api.listDocumentTables("oauth", { id: "x", name: "x" }), /Document API/, "нет объяснения про адрес");
  });

  console.log("\n[4] Инструмент агента ycDb");

  await test("ycDb: разрешения и чужое действие — до всякой сети", async () => {
    const off = mk();
    const cr = await off.tools.ycDb({ action: "create", table: "pets", keys: { id: "S" } }, {});
    assert.ok(/⛔/.test(cr) && /создавать/.test(cr), "создание не заперто: " + cr.slice(0, 120));
    const put = await off.tools.ycDb({ action: "put", table: "pets", item: { id: 1 } }, {});
    assert.ok(/⛔/.test(put), "запись не заперта");
    const del = await off.tools.ycDb({ action: "delete", table: "pets", key: { id: 1 } }, {});
    assert.ok(/⛔/.test(del) && /удалять/.test(del), "удаление не заперто");
    const bad = await mk().tools.ycDb({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycDb/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 120));
    // Ни один запертый вызов не дошёл до облака — иначе разрешение было бы фикцией.
    assert.strictEqual(off.calls.list.length, 0, "при запертом действии инструмент всё равно сходил в облако");
  });

  await test("ycDb: список таблиц и честный ответ по пустой базе", async () => {
    const env = mk({ __cloud: { getIamToken: async () => "iam-1" } });
    stub.reset();
    const empty = await env.tools.ycDb({ action: "tables" }, {});
    assert.ok(/Таблиц нет/.test(empty), "пустая база не объяснена: " + empty.slice(0, 160));
    assert.ok(/ycDb \{ action: "create"/.test(empty), "нет подсказки, как создать таблицу");
    const c = mk({ __cloud: { getIamToken: async () => "iam-1" } }, { ycAllowAgentCreate: true });
    await c.tools.ycDb({ action: "create", table: "pets", keys: { species: "S", name: "S" } }, {});
    const out = await c.tools.ycDb({ action: "tables" }, {});
    assert.ok(/• pets/.test(out), "таблица не найдена: " + out.slice(0, 160));
  });

  await test("ycDb: полный цикл записи через инструмент (создать, положить, прочитать, обойти, удалить, снести таблицу)", async () => {
    const env = mk(
      { __cloud: { getIamToken: async () => "iam-1" } },
      { ycAllowAgentCreate: true, ycAllowAgentDelete: true }
    );
    stub.reset();
    const created = await env.tools.ycDb({ action: "create", table: "pets", keys: { species: "S", name: "S" } }, {});
    assert.ok(/✅ Таблица создана/.test(created), "таблица не создана: " + created.slice(0, 160));
    const put = await env.tools.ycDb({ action: "put", table: "pets", item: { species: "cat", name: "Tom", price: 10.5 } }, {});
    assert.ok(/✅ Запись сохранена/.test(put), "запись не сохранена: " + put.slice(0, 160));
    const got = await env.tools.ycDb({ action: "get", table: "pets", key: { species: "cat", name: "Tom" } }, {});
    assert.ok(/"price": 10\.5/.test(got), "запись прочитана неверно: " + got.slice(0, 200));
    const scan = await env.tools.ycDb({ action: "scan", table: "pets" }, {});
    assert.ok(/"Tom"/.test(scan), "обход не показал запись");
    const del = await env.tools.ycDb({ action: "delete", table: "pets", key: { species: "cat", name: "Tom" } }, {});
    assert.ok(/🗑 Запись удалена/.test(del), "запись не удалена");
    const gone = await env.tools.ycDb({ action: "get", table: "pets", key: { species: "cat", name: "Tom" } }, {});
    assert.ok(/нет\./.test(gone), "удалённая запись всё ещё видна: " + gone.slice(0, 160));
    const drop = await env.tools.ycDb({ action: "drop", table: "pets" }, {});
    assert.ok(/🗑 Таблица удалена/.test(drop), "таблица не удалена");
  });

  await test("ycDb: база ищется по имени, по id, единственная; чужая — честный ответ", async () => {
    const only = mk({ __dbs: [DB], __cloud: { getIamToken: async () => "iam-1" } });
    assert.ok(/Таблиц нет/.test(await only.tools.ycDb({ action: "tables" }, {})), "единственная база не найдена");
    const two = mk({
      __dbs: [DB, { id: "etn2", name: "other-db", documentApiEndpoint: stub.base }],
      __cloud: { getIamToken: async () => "iam-1" },
    });
    const ambiguous = await two.tools.ycDb({ action: "tables" }, {});
    assert.ok(/укажи database/.test(ambiguous), "неоднозначность не объяснена: " + ambiguous.slice(0, 160));
    const byId = await two.tools.ycDb({ action: "tables", database: "etn2" }, {});
    assert.ok(/other-db/.test(byId), "база по id не найдена: " + byId.slice(0, 160));
    const none = mk({ __dbs: [] });
    const noDb = await none.tools.ycDb({ action: "tables" }, {});
    assert.ok(/Баз YDB в каталоге/.test(noDb), "пустой каталог не объяснён: " + noDb.slice(0, 160));
  });

  await test("ycDb: без подключения и без каталога отвечает честно", async () => {
    const off = buildTool({ __dbs: [DB] }, { yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await off.tools.ycDb({ action: "tables" }, {})), "нет ответа про подключение");
    const noFolder = buildTool({ __dbs: [DB] }, { ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycDb({ action: "tables" }, {})), "нет ответа про каталог");
  });

  await test("ycDb: запрос к базе без адреса Document API назван честно (а не «сбой сети»)", async () => {
    const env = mk({
      __dbs: [{ id: "etn9", name: "creating-db", status: "PROVISIONING" }],
      __cloud: { getIamToken: async () => "iam-1" },
    });
    const out = await env.tools.ycDb({ action: "tables" }, {});
    assert.ok(/Document API/.test(out), "отсутствие адреса не объяснено: " + out.slice(0, 200));
  });

  console.log("\n[5] Согласованность: схема, промпт, права, справочник и цепочка");

  await test("ycDb: схема инструмента описана и названа действиями", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycDb"');
    assert.ok(at > 0, "в схеме нет ycDb");
    const block = SCHEMAS_SRC.slice(at, at + 3000);
    assert.ok(/tables \| create \| describe \| put \| get \| scan \| delete \| drop/.test(block), "в схеме нет списка действий");
    assert.ok(/required: \["action"\]/.test(block), "действие не обязательно");
  });

  await test("ycDb: группа облака, правила промпта и список инструментов знают его", () => {
    assert.ok(/"ycStorage", "ycDb", "ycCosts"/.test(CORE_SRC), "группы облака нет в ядре роутера");
    assert.ok(/ycDb \(таблицы и записи/.test(PROMPTS_SRC), "правило 28 не знает ycDb");
    assert.ok(/ycStorage, ycDb, ycCosts/.test(PROMPTS_SRC), "список инструментов не знает ycDb");
  });

  await test("ycDb: права выданы на чтение, а создание/удаление — через разрешения облака", () => {
    const line = POLICY_SRC.split("\n").find((l) => l.indexOf('cap: "cloud.read"') >= 0) || "";
    assert.ok(/"ycDb"/.test(line), "ycDb не в cloud.read: " + line.slice(0, 120));
  });

  await test("ycDb: справочник yc.md объясняет действия и разрешения", () => {
    assert.ok(/`ycDb \{ action/.test(GUIDE_SRC), "справочник не знает ycDb");
    assert.ok(/ДОКУМЕНТНЫЕ таблицы/.test(GUIDE_SRC), "справочник не оговаривает, что это документные таблицы");
  });

  await test("ycDb: сторож smoke знает инструмент, а цепочка npm test — набор", () => {
    assert.ok(/\"ycStorage\", \"ycDb\", \"ycCreate\"/.test(SMOKE_SRC), "список инструментов в smoke не знает ycDb");
    assert.ok(PKG.scripts.test.indexOf("test/yc-db.test.js") >= 0, "набор не в цепочке npm test");
  });

  console.log("\n[6] Панель: таблицы в карточке базы");

  await test("ycDb: карточка базы получает связь «Таблицы» сама (без нового канала)", () => {
    const caps = ycConsole.capabilities().find((c) => c.serviceKey === "ydb");
    assert.ok(caps, "в консоли нет сервиса ydb");
    const rel = (caps.relations || []).find((r) => r.key === "tables");
    assert.ok(rel, "у базы YDB нет связи «Таблицы»: " + JSON.stringify(caps.relations));
    assert.strictEqual(rel.title, "Таблицы", "связь названа иначе");
    // Связь идёт общим каналом: у неё есть путь, но нет своего обработчика.
    assert.ok(ycConsole.RELATIONS.ydb.some((r) => r.docApi), "связь не помечена как Document API");
  });

  await test("ycDb: связь читает таблицы через Document API и отдаёт их таблицей", async () => {
    process.env.AI_AGENT_YC_BASE = stub.base;
    dbList = [DB];
    stub.reset();
    const api = createYcDb({
      getIamToken: async () => "iam-1",
      hostOf: (u) => new URL(u).host,
      serviceError: (e) => String(e && e.message),
      isNetworkError: () => false,
    });
    await api.createDocumentTable("oauth", DB, { table: "pets", keys: { id: "S" } });
    const out = await ycConsole.relationList("oauth-1", {
      serviceKey: "ydb",
      relationKey: "tables",
      id: DB.id,
      name: DB.name,
      folderId: "folder-1",
    });
    assert.ok(out.ok, "связь не прочиталась: " + JSON.stringify(out).slice(0, 200));
    assert.strictEqual(out.count, 1, "таблица не найдена: " + JSON.stringify(out.rows));
    assert.deepStrictEqual(out.columns.map((c) => c.key), ["name"], "колонки не заданы");
    assert.ok(/pets/.test(JSON.stringify(out.rows)), "имя таблицы не показано: " + JSON.stringify(out.rows));
    assert.ok(/Document API/.test(out.path), "путь запроса не назван: " + out.path);
    // Это тот же общий канал, что у остальных связей: своего обработчика нет.
    assert.ok(IPC_HAS_NO_DB_CHANNEL, "у связи появился собственный канал IPC — она должна идти общим yc:console:list");
  });

  await test("ycDb: база не нашлась — карточка объясняет, а не молчит пустым списком", async () => {
    process.env.AI_AGENT_YC_BASE = stub.base;
    dbList = [];
    const out = await ycConsole.relationList("oauth-1", {
      serviceKey: "ydb",
      relationKey: "tables",
      id: "etn1",
      name: "app-db",
      folderId: "folder-1",
    });
    assert.strictEqual(out.ok, false, "пустой каталог выдан за успех");
    assert.ok(/причину, а не пустой список/.test(out.error), "нет объяснения: " + String(out.error).slice(0, 160));
    assert.ok(/не нашлась/.test(out.error), "не сказано, что база не найдена");
    delete process.env.AI_AGENT_YC_BASE;
  });

  await new Promise((r) => stub.server.close(r));
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

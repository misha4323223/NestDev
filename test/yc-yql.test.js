"use strict";

/* ── YQL (SQL) по gRPC к базе YDB (src/yc-yql.js) ────────────────────────────
   Запуск: node test/yc-yql.test.js   (входит в общий `npm test`)

   Зачем этот набор. У базы YDB две половины. Документные таблицы (src/yc-db.js,
   HTTP Document API) умеют хранить в колонках только первичный ключ. Обычные
   таблицы с колонками и любые SQL-запросы к ним — это YQL, и HTTP-привязки у
   него НЕТ: Ydb.Query.V1.QueryService живёт только по gRPC. Здесь проверяется
   именно этот протокол, потому что ошибиться в нём очень легко:

     • адрес: соединение — с ХОСТОМ, а база уходит заголовком x-ydb-database
       (иначе сервер отвечает «database not specified»);
     • сессия: сначала CreateSession, запрос С session_id, потом DeleteSession —
       и закрывать её надо ВСЕГДА, иначе она висит на сервере до таймаута;
     • ответ — ПОТОК частей, склеиваемых по result_set_index (колонки в первой
       части, строки могут доехать в следующих);
     • ответ ТИПИЗИРОВАН: колонка = Type, значение = Value без типа; NULL — это
       отдельный null_flag_value, а Optional не оборачивается для не-null;
     • успех — это SUCCESS = 400000, а не ноль (ноль значит «статус не указан»).

   Живой обмен идёт по встроенному http2 на подменённый сервер — настоящий
   mini-protobuf и настоящий транспорт, без внешнего yc и без облака. */

const assert = require("assert");
const http2 = require("http2");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const yql = require(path.join(ROOT, "src", "yc-yql.js"));
const grpc = require(path.join(ROOT, "src", "yc-grpc.js"));

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

// ── Сборка protobuf для ответа (то, что присылает YDB) ─────────────────────
function pbFixed32(field, n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n) >>> 0, 0);
  return Buffer.concat([grpc.varint((field << 3) | 5), b]);
}
function pbFixed64(field, n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n), 0);
  return Buffer.concat([grpc.varint((field << 3) | 1), b]);
}
const typePrimitive = (id) => grpc.pbInt(1, id);
// OptionalType { Type item = 1 } / ListType { Type item = 1 } — поле item это
// ВЛОЖЕННОЕ сообщение Type, а не сам тип.
const typeOptional = (inner) => grpc.pbMessage(101, grpc.pbMessage(1, inner));
const typeList = (inner) => grpc.pbMessage(102, grpc.pbMessage(1, inner));
function typeStruct(members) {
  // StructType { repeated StructMember members = 1 } — члены лежат ВНУТРИ поля 1.
  const membersBuf = Buffer.concat(members.map((m) => grpc.pbMessage(1, Buffer.concat([grpc.pbString(1, m.name), grpc.pbMessage(2, m.type)]))));
  return grpc.pbMessage(104, membersBuf);
}
const column = (name, typeBuf) => Buffer.concat([grpc.pbString(1, name), grpc.pbMessage(2, typeBuf)]);
const valueUtf8 = (s) => grpc.pbString(9, s);
const valueInt64 = (n) => pbFixed64(4, n);
const valueNull = () => grpc.pbInt(10, 0);
const valueItems = (items) => Buffer.concat(items.map((i) => grpc.pbMessage(12, i)));
function resultSet(columns, rows) {
  return Buffer.concat([...columns.map((c) => grpc.pbMessage(1, c)), ...rows.map((r) => grpc.pbMessage(2, r))]);
}
function part(index, rs, status) {
  return Buffer.concat([grpc.pbInt(1, status || 400000), grpc.pbInt(3, index), grpc.pbMessage(4, rs)]);
}

(async () => {
  console.log("[1] Адрес базы и вид запроса");

  await test("yql: адрес — хост без пути, база — отдельно", () => {
    assert.deepStrictEqual(yql.grpcTargetOf("grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g/etn1"), {
      origin: "https://ydb.serverless.yandexcloud.net:2135",
      database: "/ru-central1/b1g/etn1",
    });
    // Без порта подставляется 2135, а необычные схемы не ломают разбор.
    assert.strictEqual(yql.grpcTargetOf("grpcs://ydb.serverless.yandexcloud.net/ru-central1/b1g/etn1").origin, "https://ydb.serverless.yandexcloud.net:2135");
    assert.strictEqual(yql.grpcTargetOf("grpc://127.0.0.1:7000/db").origin, "http://127.0.0.1:7000");
    assert.strictEqual(yql.grpcTargetOf("не адрес"), null, "мусор принят за адрес");
    assert.strictEqual(yql.grpcTargetOf("grpcs://host"), null, "адрес без базы принят");
  });

  await test("yql: вид запроса — по первому слову КАЖДОГО оператора", () => {
    assert.strictEqual(yql.queryKind("SELECT * FROM pets"), "read");
    assert.strictEqual(yql.queryKind("  -- комментарий\nSELECT 1"), "read");
    assert.strictEqual(yql.queryKind("CREATE TABLE t (id Uint64, PRIMARY KEY (id))"), "write");
    assert.strictEqual(yql.queryKind("UPSERT INTO pets …"), "write");
    assert.strictEqual(yql.queryKind("DROP TABLE pets"), "destructive");
    assert.strictEqual(yql.queryKind("DELETE FROM pets"), "destructive");
    // Опасность видна и во ВТОРОМ операторе, и после комментария — иначе
    // «SELECT 1; DROP TABLE x» прошёл бы как чтение.
    assert.strictEqual(yql.queryKind("SELECT 1; DROP TABLE pets"), "destructive");
    assert.strictEqual(yql.queryKind("/* drop */ SELECT 1"), "read");
    // Колонка с опасным именем сама по себе запрос не портит.
    assert.strictEqual(yql.queryKind("SELECT name FROM t WHERE name = 'delete'"), "read");
    assert.ok(yql.checkQuery(" SELECT 1 "), "нормальный запрос не принят");
    assert.throws(() => yql.checkQuery("   "), /Пустой запрос/, "пустой запрос не отвергнут");
  });

  console.log("\n[2] Типы и значения ответа YDB");

  await test("yql: типы читаются и печатаются человеку", () => {
    assert.strictEqual(yql.typeName(yql.decodeType(typePrimitive(0x1200))), "Utf8");
    assert.strictEqual(yql.typeName(yql.decodeType(typePrimitive(0x0003))), "Int64");
    assert.strictEqual(yql.typeName(yql.decodeType(typeOptional(typePrimitive(0x0003)))), "Optional<Int64>");
    assert.strictEqual(yql.typeName(yql.decodeType(typeList(typePrimitive(0x1200)))), "List<Utf8>");
    assert.strictEqual(yql.typeName(yql.decodeType(typeStruct([{ name: "a", type: typePrimitive(0x1200) }]))), "Struct<a:Utf8>");
  });

  await test("yql: значения разбираются по типу (Optional, List, Struct, Date)", () => {
    const optInt = yql.decodeType(typeOptional(typePrimitive(0x0003)));
    assert.strictEqual(yql.decodeValue(optInt, valueNull()), null, "NULL не распознан");
    assert.strictEqual(yql.decodeValue(optInt, valueInt64(7)), 7, "Optional<Int64> разобран неверно");

    const listT = yql.decodeType(typeList(typePrimitive(0x1200)));
    assert.deepStrictEqual(yql.decodeValue(listT, valueItems([valueUtf8("a"), valueUtf8("b")])), ["a", "b"]);

    const structT = yql.decodeType(typeStruct([{ name: "a", type: typePrimitive(0x1200) }, { name: "n", type: typePrimitive(0x0003) }]));
    assert.deepStrictEqual(yql.decodeValue(structT, valueItems([valueUtf8("x"), valueInt64(5)])), { a: "x", n: 5 });

    // DATE — это uint32 дней от 1970-01-01; без разбора в чат ушло бы число.
    const dateT = yql.decodeType(typePrimitive(0x0030));
    assert.strictEqual(yql.decodeValue(dateT, pbFixed32(3, 1)), "1970-01-02", "дата разобрана неверно");

    // Utf8 vs String: у String значение лежит в bytes_value (поле 8).
    const strT = yql.decodeType(typePrimitive(0x1001));
    assert.strictEqual(yql.decodeValue(strT, grpc.pbBytes(8, Buffer.from("abc"))), "abc");
  });

  await test("yql: ResultSet и часть потока собираются вместе", () => {
    const col = column("name", typePrimitive(0x1200));
    const rs = resultSet([col], [valueItems([valueUtf8("Tom")]), valueItems([valueUtf8("Jerry")])]);
    const p = yql.parseExecutePart(part(0, rs));
    assert.strictEqual(p.status, 400000);
    assert.strictEqual(p.resultSet.columns[0].name, "name");
    assert.strictEqual(p.resultSet.rows.length, 2);
    assert.deepStrictEqual(p.resultSet.rows[0], ["Tom"]);

    // Строки могут прийти ВТОРОЙ частью того же набора: склейка идёт по индексу,
    // «взять последнюю часть» потеряло бы первые строки.
    const p2 = yql.parseExecutePart(part(0, resultSet([], [valueItems([valueUtf8("Spike")])])));
    const agg = yql.collectResultSets([p, p2]);
    assert.strictEqual(agg.sets[0].rows.length, 3, "части набора не склеены: " + agg.sets[0].rows.length);
    assert.ok(yql.formatSets(agg.sets)[0].indexOf("name Utf8") >= 0, "колонки не названы");
    assert.ok(yql.formatSets(agg.sets).join(" ").indexOf("Tom") >= 0, "строки не напечатаны");

    // Ошибка несёт СТАТУС и сообщение, а не «пустой результат».
    const bad = yql.parseExecutePart(part(0, resultSet([], []), 400140));
    const agg2 = yql.collectResultSets([bad]);
    assert.ok(agg2.failed, "ошибка статуса потеряна");
    assert.throws(() => {
      throw yql.statusError(agg2.failed.status, agg2.failed.issues, "выполнение");
    }, /не найден/, "статус не переведён словами");
  });

  console.log("\n[3] Живой обмен по http2 (mini-protobuf и транспорт целиком)");

  await test("yql: CreateSession → ExecuteQuery → DeleteSession на настоящем http2", async () => {
    const seen = [];
    const rs = resultSet([column("name", typePrimitive(0x1200))], [valueItems([valueUtf8("Tom")])]);
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      const p = String(headers[":path"] || "");
      seen.push({ path: p, db: headers["x-ydb-database"], ticket: headers["x-ydb-auth-ticket"], auth: headers["authorization"] });
      let payload;
      if (/\/CreateSession$/.test(p)) payload = Buffer.concat([grpc.pbInt(1, 400000), grpc.pbString(3, "sess-1")]);
      else if (/\/ExecuteQuery$/.test(p)) payload = part(0, rs);
      else payload = grpc.pbInt(1, 400000);
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(payload.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, payload]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const res = await yql.runYql({
        origin: "http://127.0.0.1:" + port,
        database: "/ru-central1/b1g/etn1",
        iamToken: "t.IAM",
        query: "SELECT name FROM pets",
      });
      assert.strictEqual(res.kind, "read");
      assert.strictEqual(res.rowCount, 1, "строки не дошли: " + JSON.stringify(res).slice(0, 200));
      assert.deepStrictEqual(res.sets[0].rows[0], ["Tom"]);
      assert.ok(res.sets[0].columns[0].name === "name");
    } finally {
      await new Promise((r) => server.close(r));
    }
    const paths = seen.map((s) => s.path);
    assert.deepStrictEqual(paths, [
      "/Ydb.Query.V1.QueryService/CreateSession",
      "/Ydb.Query.V1.QueryService/ExecuteQuery",
      "/Ydb.Query.V1.QueryService/DeleteSession",
    ], "порядок методов неверен: " + paths.join(", "));
    assert.strictEqual(seen[0].db, "/ru-central1/b1g/etn1", "база не ушла заголовком x-ydb-database");
    assert.strictEqual(seen[0].ticket, "t.IAM", "нет заголовка x-ydb-auth-ticket");
    assert.strictEqual(seen[0].auth, "Bearer t.IAM", "нет заголовка авторизации");
  });

  await test("yql: отказ сессии и ошибка запроса — со словами, а не молчанием", async () => {
    // CreateSession отвечает ошибкой: в облако дальше идти нечем.
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      const p = String(headers[":path"] || "");
      let payload;
      if (/\/CreateSession$/.test(p)) {
        const issue = grpc.pbString(2, "Query service is not available"); // IssueMessage { message = 2 }
        payload = Buffer.concat([grpc.pbInt(1, 400180), grpc.pbMessage(2, issue)]);
      }
      else payload = grpc.pbInt(1, 400000);
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(payload.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, payload]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const err = await yql
        .runYql({ origin: "http://127.0.0.1:" + port, database: "/db", iamToken: "t", query: "SELECT 1" })
        .then(() => null, (e) => e);
      assert.ok(err instanceof Error && /не поддерживается/.test(err.message), "статус сессии не переведён: " + (err && err.message));
    } finally {
      await new Promise((r) => server.close(r));
    }

    // А это отказы ДО сети: пустой запрос, нет адреса/базы/токена.
    assert.throws(() => yql.checkQuery(""), /Пустой запрос/);
    const noOrigin = await yql.runYql({ database: "/db", iamToken: "t", query: "SELECT 1" }).then(() => null, (e) => e);
    assert.ok(noOrigin && /адрес gRPC/.test(noOrigin.message), "нет ответа про адрес: " + (noOrigin && noOrigin.message));
    const noDb = await yql.runYql({ origin: "http://x", iamToken: "t", query: "SELECT 1" }).then(() => null, (e) => e);
    assert.ok(noDb && /путь базы/.test(noDb.message), "нет ответа про путь базы: " + (noDb && noDb.message));
    const noToken = await yql.runYql({ origin: "http://x", database: "/db", query: "SELECT 1" }).then(() => null, (e) => e);
    assert.ok(noToken && /токен/.test(noToken.message), "нет ответа про токен: " + (noToken && noToken.message));
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

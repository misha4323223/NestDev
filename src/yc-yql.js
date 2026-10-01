"use strict";

/* ── YQL (SQL) по gRPC: запросы к базе YDB из приложения ────────────────────
   Зачем модуль. База YDB умеет две очень разные половины. Документные таблицы
   (Document API, src/yc-db.js) — DynamoDB-совместимый HTTP: колонок у них нет,
   в колонках живёт только первичный ключ, а поля лежат в самих записях. Обычные
   таблицы YDB и любые запросы к ним — это YQL, и HTTP-привязки у него НЕТ:
   Ydb.Query.V1.QueryService живёт только по gRPC. Пока этой половины не было,
   «создать таблицу с колонками» и «выполнить SELECT» в консоли облака можно
   было сделать, а у нас — нет: то есть обещание «что можно в консоли, можно и
   у нас» не выполнялось.

   Три строгости протокола, которые легко потерять при правке:

     1) сессия. QueryService — не «запрос в пустоту»: сначала CreateSession
        отдаёт session_id, запрос идёт С ним, а DeleteSession закрывает сессию.
        Сессию закрываем ВСЕГДА (finally) — иначе она висит на сервере до
        таймаута. База выбирается НЕ телом, а заголовком `x-ydb-database`
        (а токен — `x-ydb-auth-ticket`), потому что соединение одно на хост, а
        баз на хосте много.

     2) ExecuteQuery отвечает ПОТОКОМ частей: одна часть = один «кусок» набора,
        у каждой свой `result_set_index`. Колонки приходят в первой части, строки
        могут приходить частями, поэтому части СКЛЕИВАЮТСЯ по индексу, а не
        «берётся последняя».

     3) ответ ТИПИЗИРОВАН. Колонка — это Type (primitive/optional/list/tuple/
        struct/dict/variant/tagged/decimal/pg), а значение — Value, у которого
        нет типа: тип берут из колонки и по нему разбирают байты. Optional
        не оборачивается, когда значение не null (так устроен YDB), а NULL — это
        отдельный `null_flag_value`. Ошибку несёт СТАТУС (SUCCESS = 400000, а не
        ноль) и сообщения-issues.

   Транспорт (mini-protobuf + gRPC поверх http2) вынесен в src/yc-grpc.js: тот же
   разбор понадобился Cloud Logging (записи читаются только по gRPC), и держать
   две копии протокола нельзя. Модуль чистый: Electron не тянет, состояния нет,
   сеть подменяется (grpcCall в доводах) — поэтому проверяется без облака.
*/

const grpc = require("./yc-grpc.js");
const { pbString, pbMessage, pbInt, pbDecode, grpcCall } = grpc;

const QUERY_SERVICE = "Ydb.Query.V1.QueryService";
// StatusIds.StatusCode.SUCCESS — в YDB это 400000, а не 1: ноль значит
// «статус не указан», и принять его за успех — значит показать пустоту вместо
// ошибки.
const SUCCESS = 400000;
const EXEC_MODE_EXECUTE = 50;
const SYNTAX_YQL_V1 = 1;

const STATUS_RU = {
  0: "статус не указан",
  400010: "облако отклонило запрос как некорректный",
  400020: "запрос не авторизован — проверь OAuth-токен",
  400030: "внутренняя ошибка YDB",
  400040: "запрос прерван",
  400050: "база недоступна",
  400060: "база перегружена",
  400070: "схемная ошибка (проверь имена таблицы и колонок)",
  400080: "ошибка выполнения запроса",
  400090: "таймаут на стороне базы",
  400100: "сессия потеряна — повтори запрос",
  400120: "условие не выполнено",
  400130: "объект с таким именем уже есть",
  400140: "объект не найден (таблицы или колонки нет)",
  400150: "сессия истекла — повтори запрос",
  400160: "запрос отменён",
  400170: "результат запроса неизвестен",
  400180: "операция не поддерживается",
  400190: "сессия занята — повтори запрос",
  400200: "внешняя ошибка",
};

// PrimitiveTypeId (ydb_value.proto) — только те, что встречаются в ответах.
const PRIM = {
  0x0001: "Int32", 0x0002: "Uint32", 0x0003: "Int64", 0x0004: "Uint64",
  0x0005: "Uint8", 0x0006: "Bool", 0x0007: "Int8", 0x0008: "Int16", 0x0009: "Uint16",
  0x0020: "Double", 0x0021: "Float",
  0x0030: "Date", 0x0031: "Datetime", 0x0032: "Timestamp", 0x0033: "Interval",
  0x0034: "TzDate", 0x0035: "TzDatetime", 0x0036: "TzTimestamp",
  0x0040: "Date32", 0x0041: "Datetime64", 0x0042: "Timestamp64", 0x0043: "Interval64",
  0x1001: "String", 0x1200: "Utf8", 0x1201: "Yson", 0x1202: "Json",
  0x1203: "Uuid", 0x1204: "JsonDocument", 0x1302: "DyNumber",
};

// ── Адрес базы: gRPC-эндпоинт и путь ───────────────────────────────────────
// У базы YDB есть поле `endpoint` вида
//   grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g…/etn…
// Соединяемся с ХОСТОМ (без пути), а путь базы уходит заголовком x-ydb-database —
// иначе сервер отвечает «database not specified».
function grpcTargetOf(endpoint) {
  const ep = String(endpoint || "").trim();
  const m = /^(grpcs?|https?):\/\/([^/]+)\/(.+)$/i.exec(ep);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2];
  const database = "/" + m[3].replace(/^\/+/, "").replace(/\/+$/, "");
  if (!host || database === "/") return null;
  const secure = scheme !== "grpc" && scheme !== "http";
  const origin = (secure ? "https://" : "http://") + host + (/:\d+$/.test(host) ? "" : ":2135");
  return { origin: origin, database: database };
}

// ── Форма запроса: что человек написал и чем это грозит ────────────────────
function firstKeyword(text) {
  const s = String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  const m = /[A-Za-z]+/.exec(s);
  return m ? m[0].toUpperCase() : "";
}

const DESTRUCTIVE_KW = { DROP: 1, TRUNCATE: 1, ALTER: 1, DELETE: 1 };
const WRITE_KW = { INSERT: 1, UPSERT: 1, REPLACE: 1, UPDATE: 1, CREATE: 1, GRANT: 1, REVOKE: 1 };

// Вид запроса по ПЕРВОМУ слову каждого оператора (до «;»): так «SELECT 1; DROP
// TABLE x» считается опасным, а колонка с именем delete — нет.
function queryKind(text) {
  const parts = String(text || "").split(";");
  let kind = "read";
  for (const p of parts) {
    const k = firstKeyword(p);
    if (DESTRUCTIVE_KW[k]) return "destructive";
    if (WRITE_KW[k]) kind = "write";
  }
  return kind;
}

function checkQuery(text) {
  const q = String(text || "").trim();
  if (!q) {
    throw new Error("Пустой запрос: напиши текст на YQL, например SELECT * FROM pets LIMIT 10.");
  }
  return q;
}

// ── Сборка запросов (protobuf) ─────────────────────────────────────────────
function buildCreateSession() {
  return Buffer.alloc(0); // CreateSessionRequest пуст
}

function buildDeleteSession(sessionId) {
  return pbString(1, sessionId);
}

// ExecuteQueryRequest: session_id=1, exec_mode=2, tx_control=3, query_content=4.
// Транзакция: begin_tx (serializable_read_write, пустая настройка) + commit_tx —
// значит запрос фиксируется сразу, а повторять его после обрыва безопасно
// только для чтения (это и записано в подсказке пользователю).
function buildExecuteQuery(opts) {
  const o = opts || {};
  return Buffer.concat([
    pbString(1, o.sessionId),
    pbInt(2, EXEC_MODE_EXECUTE),
    pbMessage(3, Buffer.concat([
      pbMessage(2, pbMessage(1, Buffer.alloc(0))), // begin_tx { serializable_read_write {} }
      pbInt(10, 1), // commit_tx = true
    ])),
    pbMessage(4, Buffer.concat([
      pbInt(1, SYNTAX_YQL_V1),
      pbString(2, o.text),
    ])),
  ]);
}

// ── Разбор ответов ─────────────────────────────────────────────────────────
function fld(F, n) {
  for (const f of F) if (f.field === n) return f;
  return null;
}

function u32(f) {
  return Number(f.num & 0xffffffffn);
}

function i32(f) {
  return Number(BigInt.asIntN(32, f.num));
}

function i64(f) {
  return Number(BigInt.asIntN(64, f.num));
}

function subMessage(buf, n) {
  if (!buf) return null;
  for (const f of pbDecode(buf)) if (f.field === n && f.wire === 2) return f.buf;
  return null;
}

function statusOf(F) {
  const f = fld(F, 1);
  return f && f.wire === 0 ? Number(f.num) : 0;
}

// IssueMessage { message = 2; … } — берём текст верхнего уровня.
function parseIssues(F) {
  const out = [];
  for (const f of F) {
    if (f.field !== 2 || f.wire !== 2) continue;
    let text = "";
    for (const x of pbDecode(f.buf)) if (x.field === 2 && x.wire === 2) text = x.buf.toString("utf8");
    if (text) out.push(text);
  }
  return out;
}

function parseCreateSession(buf) {
  const F = pbDecode(buf || Buffer.alloc(0));
  return { status: statusOf(F), sessionId: (fld(F, 3) || {}).buf ? fld(F, 3).buf.toString("utf8") : "", issues: parseIssues(F) };
}

// Type (ydb_value.proto): primitive=1, decimal=2, optional=101, list=102,
// tuple=103, struct=104, dict=105, variant=106, tagged=107, … pg=205.
function decodeType(buf) {
  if (!buf) return { kind: "unknown" };
  const F = pbDecode(buf);
  for (const f of F) {
    if (f.field === 1 && f.wire === 0) return { kind: "primitive", id: Number(f.num) };
    if (f.field === 2 && f.wire === 2) {
      const d = pbDecode(f.buf);
      return { kind: "decimal", precision: Number((fld(d, 1) || {}).num || 0n), scale: Number((fld(d, 2) || {}).num || 0n) };
    }
    if (f.field === 101 && f.wire === 2) return { kind: "optional", item: decodeType(subMessage(f.buf, 1)) };
    if (f.field === 102 && f.wire === 2) return { kind: "list", item: decodeType(subMessage(f.buf, 1)) };
    if (f.field === 103 && f.wire === 2) {
      const els = [];
      for (const x of pbDecode(f.buf)) if (x.field === 1 && x.wire === 2) els.push(decodeType(x.buf));
      return { kind: "tuple", elements: els };
    }
    if (f.field === 104 && f.wire === 2) {
      const members = [];
      for (const x of pbDecode(f.buf)) {
        if (x.field !== 1 || x.wire !== 2) continue;
        const m = pbDecode(x.buf);
        members.push({ name: (fld(m, 1) || {}).buf ? fld(m, 1).buf.toString("utf8") : String(members.length), type: decodeType(subMessage(x.buf, 2)) });
      }
      return { kind: "struct", members: members };
    }
    if (f.field === 105 && f.wire === 2) return { kind: "dict", key: decodeType(subMessage(f.buf, 1)), payload: decodeType(subMessage(f.buf, 2)) };
    if (f.field === 106 && f.wire === 2) {
      const tuple = subMessage(f.buf, 1);
      const struct = subMessage(f.buf, 2);
      if (tuple) return decodeType(tuple);
      if (struct) return decodeType(struct);
      return { kind: "variant", item: { kind: "unknown" } };
    }
    if (f.field === 107 && f.wire === 2) return { kind: "tagged", type: decodeType(subMessage(f.buf, 2)) };
    if (f.field === 205 && f.wire === 2) return { kind: "pg", name: (fld(pbDecode(f.buf), 10) || {}).buf ? fld(pbDecode(f.buf), 10).buf.toString("utf8") : "pg" };
    if ((f.field === 201 || f.field === 202) && f.wire === 0) return { kind: "null" };
    if (f.field === 203 && f.wire === 0) return { kind: "empty_list" };
    if (f.field === 204 && f.wire === 0) return { kind: "empty_dict" };
  }
  return { kind: "unknown" };
}

function typeName(desc) {
  const d = desc || { kind: "unknown" };
  switch (d.kind) {
    case "primitive": return PRIM[d.id] || ("тип#" + d.id);
    case "optional": return "Optional<" + typeName(d.item) + ">";
    case "list": return "List<" + typeName(d.item) + ">";
    case "tuple": return "Tuple<" + (d.elements || []).map(typeName).join(",") + ">";
    case "struct": return "Struct<" + (d.members || []).map((m) => m.name + ":" + typeName(m.type)).join(",") + ">";
    case "dict": return "Dict<" + typeName(d.key) + "," + typeName(d.payload) + ">";
    case "tagged": return "Tagged<" + typeName(d.type) + ">";
    case "pg": return "Pg:" + (d.name || "pg");
    case "decimal": return "Decimal(" + d.precision + "," + d.scale + ")";
    case "null": case "void": return "Null";
    case "empty_list": return "EmptyList";
    case "empty_dict": return "EmptyDict";
    default: return "?";
  }
}

function uuidOf(buf) {
  // YDB кладёт UUID в bytes_value в обычном порядке (старший байт — первым),
  // поэтому печатаем как есть: 8-4-4-4-12.
  const h = Buffer.from(buf).toString("hex");
  if (h.length !== 32) return h;
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function dateOf(days) {
  const d = new Date(Number(days) * 86400000);
  return Number.isNaN(d.getTime()) ? String(days) : d.toISOString().slice(0, 10);
}

function dateTimeOf(sec) {
  const d = new Date(Number(sec) * 1000);
  return Number.isNaN(d.getTime()) ? String(sec) : d.toISOString().slice(0, 19).replace("T", " ");
}

function timestampOf(us) {
  const u = Number(us);
  const d = new Date(Math.floor(u / 1000));
  if (Number.isNaN(d.getTime())) return String(us);
  return d.toISOString().slice(0, 19).replace("T", " ") + "." + String(Math.abs(u % 1000000)).padStart(6, "0");
}

// Decimal хранится двумя 64-битными половинами (low_128=15, high_128=16).
function decimalOf(F, scale) {
  const lo = fld(F, 15);
  const hi = fld(F, 16);
  if (!lo && !hi) return null;
  const low = lo ? lo.num & ((1n << 64n) - 1n) : 0n;
  const high = hi ? hi.num : 0n;
  let v = (BigInt.asIntN(64, high) << 64n) | low;
  const s = Number(scale) || 0;
  const neg = v < 0n;
  if (neg) v = -v;
  const ten = 10n ** BigInt(s);
  const whole = v / ten;
  const frac = v % ten;
  let out = String(whole);
  if (s > 0) out += "." + String(frac).padStart(s, "0");
  return (neg ? "-" : "") + out;
}

function primitiveOf(id, F) {
  switch (id) {
    case 0x0006: { const f = fld(F, 1); return f ? f.num !== 0n : null; }
    case 0x0007: case 0x0008: case 0x0001: { const f = fld(F, 2); return f ? i32(f) : null; }
    case 0x0005: case 0x0009: case 0x0002: { const f = fld(F, 3); return f ? u32(f) : null; }
    case 0x0003: { const f = fld(F, 4); return f ? i64(f) : null; }
    case 0x0004: { const f = fld(F, 5); return f ? Number(f.num) : null; }
    case 0x0021: { const f = fld(F, 6); if (!f) return null; const b = Buffer.alloc(4); b.writeUInt32LE(u32(f)); return b.readFloatLE(0); }
    case 0x0020: { const f = fld(F, 7); if (!f) return null; const b = Buffer.alloc(8); b.writeBigUInt64LE(f.num); return b.readDoubleLE(0); }
    case 0x1001: case 0x1201: case 0x1202: case 0x1204: case 0x1302: { const f = fld(F, 8); return f ? f.buf.toString("utf8") : null; }
    case 0x1200: { const f = fld(F, 9); return f ? f.buf.toString("utf8") : null; }
    case 0x1203: { const f = fld(F, 8); return f ? uuidOf(f.buf) : null; }
    case 0x0030: { const f = fld(F, 3); return f ? dateOf(u32(f)) : null; }
    case 0x0031: { const f = fld(F, 3); return f ? dateTimeOf(u32(f)) : null; }
    case 0x0032: { const f = fld(F, 5); return f ? timestampOf(Number(f.num)) : null; }
    case 0x0033: case 0x0043: { const f = fld(F, 4); return f ? i64(f) + " мкс" : (fld(F, 3) ? u32(fld(F, 3)) + " мкс" : null); }
    case 0x0040: { const f = fld(F, 2); return f ? dateOf(i32(f)) : null; }
    case 0x0041: { const f = fld(F, 4); return f ? dateTimeOf(i64(f)) : null; }
    case 0x0042: { const f = fld(F, 4); return f ? timestampOf(i64(f)) : null; }
    case 0x0034: case 0x0035: case 0x0036: {
      const f = fld(F, 5) || fld(F, 3);
      return f ? "значение со смещением зоны (" + (f.wire === 1 ? Number(f.num) : u32(f)) + ")" : null;
    }
    default: return null;
  }
}

function valueOf(desc, F) {
  const d = desc || { kind: "unknown" };
  switch (d.kind) {
    case "optional": {
      for (const f of F) {
        if (f.field === 10) return null; // null_flag_value
        if (f.field === 11) return valueOf(d.item, pbDecode(f.buf)); // вложенный (Optional<Optional<T>> = NULL)
      }
      if (!F.length) return null;
      return valueOf(d.item, F);
    }
    case "list": {
      const out = [];
      for (const f of F) if (f.field === 12 && f.wire === 2) out.push(valueOf(d.item, pbDecode(f.buf)));
      return out;
    }
    case "tuple": {
      const out = [];
      let i = 0;
      for (const f of F) if (f.field === 12 && f.wire === 2) { out.push(valueOf((d.elements || [])[i], pbDecode(f.buf))); i++; }
      return out;
    }
    case "struct": {
      const out = {};
      let i = 0;
      for (const f of F) if (f.field === 12 && f.wire === 2) { const m = (d.members || [])[i] || {}; out[m.name || String(i)] = valueOf(m.type, pbDecode(f.buf)); i++; }
      return out;
    }
    case "dict": {
      const out = [];
      for (const f of F) if (f.field === 13 && f.wire === 2) {
        const pf = pbDecode(f.buf);
        out.push([valueOf(d.key, pbDecode((fld(pf, 1) || {}).buf || Buffer.alloc(0))), valueOf(d.payload, pbDecode((fld(pf, 2) || {}).buf || Buffer.alloc(0)))]);
      }
      return out;
    }
    case "variant": {
      // Variant<T> всегда представлен явно: variant_index + одно значение.
      let idx = 0;
      let inner = null;
      for (const f of F) {
        if (f.field === 14 && f.wire === 0) idx = Number(f.num);
        else if (f.field === 12 && f.wire === 2) inner = pbDecode(f.buf);
      }
      return { variant: idx, value: inner ? valueOf(d.item, inner) : null };
    }
    case "tagged": return valueOf(d.type, F);
    case "pg": { const t = fld(F, 9); if (t) return t.buf.toString("utf8"); const b = fld(F, 8); return b ? "[pg-значение, " + b.buf.length + " Б]" : null; }
    case "decimal": return decimalOf(F, d.scale);
    case "null": case "void": case "empty_list": case "empty_dict": return null;
    case "primitive": return primitiveOf(d.id, F);
    default: return null;
  }
}

function decodeValue(desc, buf) {
  return valueOf(desc, pbDecode(buf || Buffer.alloc(0)));
}

function parseColumn(buf) {
  const F = pbDecode(buf);
  const name = (fld(F, 1) || {}).buf ? fld(F, 1).buf.toString("utf8") : "";
  return { name: name, type: decodeType(subMessage(buf, 2)) };
}

// ResultSet { columns = 1; rows = 2; … }. Колонки идут ПЕРЕД строками, поэтому
// тип для каждой ячейки уже известен к моменту разбора строки.
function parseResultSet(buf) {
  const F = pbDecode(buf);
  const columns = [];
  for (const f of F) if (f.field === 1 && f.wire === 2) columns.push(parseColumn(f.buf));
  const rows = [];
  for (const f of F) if (f.field === 2 && f.wire === 2) {
    const cells = pbDecode(f.buf); // Value структуры: repeated items = 12
    const row = [];
    let i = 0;
    for (const c of cells) if (c.field === 12 && c.wire === 2) { row.push(decodeValue((columns[i] || {}).type, c.buf)); i++; }
    rows.push(row);
  }
  return { columns: columns, rows: rows };
}

// ExecuteQueryResponsePart: status=1, issues=2, result_set_index=3, result_set=4.
function parseExecutePart(buf) {
  const F = pbDecode(buf || Buffer.alloc(0));
  let index = 0;
  for (const f of F) if (f.field === 3 && f.wire === 0) index = Number(f.num);
  const rsf = fld(F, 4);
  return {
    status: statusOf(F),
    issues: parseIssues(F),
    resultSetIndex: index,
    resultSet: rsf && rsf.wire === 2 ? parseResultSet(rsf.buf) : null,
  };
}

// Части склеиваются ПО ИНДЕКСУ набора: колонки приходят в первой части, строки
// могут доехать в следующих — «взять последнюю часть» потеряло бы строки.
function collectResultSets(parts) {
  const map = new Map();
  let failed = null;
  let issues = [];
  for (const p of parts || []) {
    if (!p) continue;
    if (p.status && p.status !== SUCCESS && !failed) failed = p;
    if (p.issues && p.issues.length) issues = issues.concat(p.issues);
    if (!p.resultSet) continue;
    let e = map.get(p.resultSetIndex);
    if (!e) {
      e = { index: p.resultSetIndex, columns: [], rows: [] };
      map.set(p.resultSetIndex, e);
    }
    if (p.resultSet.columns.length) e.columns = p.resultSet.columns;
    for (const r of p.resultSet.rows) e.rows.push(r);
  }
  return { sets: [...map.values()].sort((a, b) => a.index - b.index), failed: failed, issues: issues };
}

function statusError(status, issues, where) {
  const why = STATUS_RU[status] || ("код состояния " + status);
  const text = "YDB (" + (where || "запрос") + "): " + why + (issues && issues.length ? " — " + issues.join("; ") : "");
  const e = new Error(text);
  e.status = status;
  return e;
}

function ydbHint(code) {
  if (code === 7) return " (нет прав: аккаунту не хватает роли на эту базу — нужна ydb.editor)";
  if (code === 16) return " (не пройдена авторизация: проверь OAuth-токен)";
  if (code === 14) return " (база недоступна: проверь, что она создана и находится в рабочем состоянии)";
  if (code === 12) return " (метод не поддерживается по этому адресу базы)";
  return "";
}

// ── Показ результата словами (для окна и агента) ───────────────────────────
function cellText(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatSets(sets, opts) {
  const o = opts || {};
  const maxRows = Math.max(1, Math.min(parseInt(o.maxRows, 10) || 50, 500));
  const out = [];
  (sets || []).forEach((set, si) => {
    const cols = set.columns || [];
    const rows = set.rows || [];
    out.push("Набор " + (si + 1) + ": " + (cols.length ? cols.map((c) => c.name + " " + typeName(c.type)).join(", ") : "колонок нет"));
    if (!rows.length) {
      out.push("(строк нет)");
      return;
    }
    for (const r of rows.slice(0, maxRows)) {
      out.push(cols.map((c, i) => c.name + " = " + cellText(r[i])).join(" · "));
    }
    if (rows.length > maxRows) out.push("… показаны первые " + maxRows + " из " + rows.length + " строк");
  });
  return out;
}

// ── Выполнение запроса целиком: создал сессию → выполнил → закрыл ───────────
async function runYql(opts) {
  const o = opts || {};
  const gcall = o.grpcCall || grpcCall;
  const origin = String(o.origin || "").replace(/\/+$/, "");
  const database = String(o.database || "").trim();
  const token = String(o.iamToken || "");
  const query = checkQuery(o.query);
  if (!origin) throw new Error("не задан адрес gRPC базы YDB (создай базу или обнови её карточку)");
  if (!database) throw new Error("не задан путь базы YDB (database) — он виден в адресе базы");
  if (!token) throw new Error("нет IAM-токена — проверь OAuth-токен в настройках «☁️ Yandex Cloud»");

  const headers = {
    authorization: "Bearer " + token,
    // База и токен уходят ЗАГОЛОВКАМИ: соединение одно на хост, а баз много.
    "x-ydb-database": database,
    "x-ydb-auth-ticket": token,
    "x-ydb-client-capabilities": "session-balancer",
    "x-ydb-sdk-build-info": "nestdev/1.0",
  };
  const timeout = Math.max(5000, Number(o.timeoutMs) || 60000);
  const callOpts = { service: "сервиса YDB", hint: ydbHint };

  const csFrames = await gcall(origin, "/" + QUERY_SERVICE + "/CreateSession", headers, buildCreateSession(), Math.min(timeout, 20000),
    Object.assign({ timeoutMessage: "таймаут создания сессии YDB" }, callOpts));
  const cs = parseCreateSession(csFrames[0] || Buffer.alloc(0));
  if (cs.status && cs.status !== SUCCESS) throw statusError(cs.status, cs.issues, "создание сессии");
  if (!cs.sessionId) throw new Error("YDB не вернула идентификатор сессии" + (cs.issues.length ? ": " + cs.issues.join("; ") : ""));

  let parts = [];
  try {
    const frames = await gcall(origin, "/" + QUERY_SERVICE + "/ExecuteQuery", headers,
      buildExecuteQuery({ sessionId: cs.sessionId, text: query }), timeout,
      Object.assign({ timeoutMessage: "таймаут выполнения запроса YDB (запрос всё ещё может выполняться)" }, callOpts));
    parts = frames.map(parseExecutePart);
  } finally {
    // Сессию закрываем ВСЕГДА — иначе она висит на сервере до его таймаута.
    await gcall(origin, "/" + QUERY_SERVICE + "/DeleteSession", headers, buildDeleteSession(cs.sessionId), 8000,
      Object.assign({ timeoutMessage: "таймаут закрытия сессии YDB" }, callOpts)).catch(() => {});
  }

  const agg = collectResultSets(parts);
  if (agg.failed) throw statusError(agg.failed.status, agg.failed.issues, "выполнение запроса");
  const rowCount = agg.sets.reduce((n, s) => n + s.rows.length, 0);
  return { query: query, kind: queryKind(query), sets: agg.sets, rowCount: rowCount, issues: agg.issues };
}

module.exports = {
  QUERY_SERVICE: QUERY_SERVICE,
  SUCCESS: SUCCESS,
  STATUS_RU: STATUS_RU,
  PRIM: PRIM,
  grpcTargetOf: grpcTargetOf,
  firstKeyword: firstKeyword,
  queryKind: queryKind,
  checkQuery: checkQuery,
  buildCreateSession: buildCreateSession,
  buildDeleteSession: buildDeleteSession,
  buildExecuteQuery: buildExecuteQuery,
  parseIssues: parseIssues,
  parseCreateSession: parseCreateSession,
  decodeType: decodeType,
  typeName: typeName,
  decodeValue: decodeValue,
  parseColumn: parseColumn,
  parseResultSet: parseResultSet,
  parseExecutePart: parseExecutePart,
  collectResultSets: collectResultSets,
  statusError: statusError,
  formatSets: formatSets,
  runYql: runYql,
};

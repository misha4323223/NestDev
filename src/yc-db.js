"use strict";

/* ── YDB: таблицы и записи (Document API) ───────────────────────────────────
   Зачем модуль. Базу YDB из приложения можно было СОЗДАТЬ (ycCreate service
   "ydb") и увидеть в списке, а работать с ней — нечем: ни таблиц, ни одной
   записи не видели ни агент, ни консоль облака. Между тем serverless-база и
   создаётся ради данных — то есть это пустая полка ровно того же рода, что
   секрет Lockbox без версии (часть 46) и бакет Object Storage без файлов
   (часть 47).

   Документные таблицы YDB живут в HTTP Document API. Авторизация у него та же
   (IAM-токен), но протокол ДРУГОЙ — Amazon DynamoDB-совместимый, и у него две
   строгости, которые легко потерять при правке:

     1) операция задаётся ЗАГОЛОВКОМ X-Amz-Target: DynamoDB_20120810.<Метод>, а
        тело — JSON (Content-Type: application/x-amz-json-1.0). Обычных
        REST-путей вида /tables здесь нет — запрос всегда идёт в КОРЕНЬ адреса
        базы;
     2) значения атрибутов ТИПИЗИРОВАНЫ ({ "S": "cat" }, { "N": "10.5" }), а не
        приходят как в JSON. Разбор и сборка значений живут только здесь.

   Адрес API — у самой базы (поле documentApiEndpoint): у serverless и выделенных
   баз хосты разные, поэтому собирать его по памяти нельзя. Если поле пустое
   (база ещё создаётся или список отдал краткую форму), адрес выводится из
   gRPC-эндпоинта базы — у него тот же путь /<регион>/<облако>/<база>.

   Модуль чистый: Electron не тянет, состояния уровня файла не держит, сеть и
   диск приходят через deps. Проверяется в обычном Node (та же конвенция, что у
   createYcService, createYcCosts и createYcLogs).
*/

// Запасной адрес управляющего API YDB, если discovery не ответил.
const YDB_API_FALLBACK = "https://ydb.api.cloud.yandex.net";

const DOC_API_TARGET = "DynamoDB_20120810.";

function createYcDb(deps) {
  const {
    getIamToken,
    fetchJson,
    endpoint,
    listService,
    serviceByKey,
    hostOf,
    serviceError,
    isNetworkError,
  } = deps;

  async function ydbApiBase() {
    return (await endpoint("ydb")) || YDB_API_FALLBACK;
  }

  // Адрес Document API базы. Сначала — поле самой базы, затем вывод из
  // gRPC-эндпоинта (у него тот же путь, меняется только хост).
  function documentApiEndpointFor(db) {
    const direct = String((db && db.documentApiEndpoint) || "").trim();
    if (direct) return direct.replace(/\/+$/, "");
    const ep = String((db && db.endpoint) || "").trim();
    const m = /^[a-z]+:\/\/([^/]+)\/(.+)$/i.exec(ep);
    if (!m) return "";
    const host = m[1].replace(/^ydb\./, "docapi.").replace(/:\d+$/, "");
    return "https://" + host + "/" + m[2].replace(/\/+$/, "");
  }

  // Обычное значение → типизированное значение DynamoDB. Агент передаёт привычный
  // JSON (строка, число, флаг, массив, объект), а API ждёт обёртку с типом: без
  // неё строка ушла бы как есть и облако отвергло бы запрос.
  function toAttrValue(v) {
    if (v == null) return { NULL: true };
    if (typeof v === "string") return { S: v };
    if (typeof v === "number") return Number.isFinite(v) ? { N: String(v) } : { S: String(v) };
    if (typeof v === "boolean") return { BOOL: v };
    if (Array.isArray(v)) return { L: v.map(toAttrValue) };
    if (typeof v === "object") {
      const M = {};
      for (const k of Object.keys(v)) M[k] = toAttrValue(v[k]);
      return { M: M };
    }
    return { S: String(v) };
  }

  function toItem(obj) {
    const src = obj && typeof obj === "object" ? obj : {};
    const out = {};
    for (const k of Object.keys(src)) out[k] = toAttrValue(src[k]);
    return out;
  }

  // Типизированное значение DynamoDB → обычное. Наборы (SS/NS) отдаём массивами,
  // а двоичные — пометкой: в чат байты всё равно не напечатать.
  function fromAttrValue(a) {
    if (a == null) return null;
    if ("S" in a) return a.S;
    if ("N" in a) return Number(a.N);
    if ("BOOL" in a) return !!a.BOOL;
    if ("NULL" in a) return null;
    if ("L" in a) return (a.L || []).map(fromAttrValue);
    if ("M" in a) {
      const o = {};
      for (const k of Object.keys(a.M || {})) o[k] = fromAttrValue(a.M[k]);
      return o;
    }
    if ("SS" in a) return (a.SS || []).slice();
    if ("NS" in a) return (a.NS || []).map((x) => Number(x));
    if ("BS" in a || "B" in a) return "[двоичные данные]";
    return null;
  }

  function fromItem(item) {
    const src = item && typeof item === "object" ? item : {};
    const out = {};
    for (const k of Object.keys(src)) out[k] = fromAttrValue(src[k]);
    return out;
  }

  // Ошибку DynamoDB-протокола разбираем как JSON: у него свой формат
  // ({ __type, message }), и без перевода человек видел бы служебный код.
  function documentApiError(status, body, where) {
    const t = String((body && (body.__type || body.type)) || "");
    const msg = String((body && (body.message || body.Message)) || "").trim();
    const code = t.split("#").pop().split(":").pop();
    const hints = {
      ResourceNotFoundException: "Такой таблицы в базе нет — посмотри список: ycDb { action: \"tables\" }.",
      ResourceInUseException: "Таблица с таким именем уже есть в базе.",
      AccessDeniedException: "Нет прав: у аккаунта нет роли на эту базу (нужна ydb.editor).",
      ProvisionedThroughputExceededException: "База отклонила запрос по лимиту — повтори позже.",
      ValidationException: "Облако не приняло запрос: " + (msg || "проверь имена полей"),
    };
    const text = hints[code] || (code ? code + ": " : "") + (msg || "HTTP " + status);
    const e = new Error(text + (where ? " [" + where + "]" : ""));
    e.status = status;
    return e;
  }

  // Один вызов Document API: адрес — у базы, операция — заголовком, тело — JSON.
  async function documentApiFetch(oauthToken, db, target, body, timeoutMs) {
    const base = documentApiEndpointFor(db);
    if (!base) {
      throw new Error("У базы YDB нет адреса Document API. Обычно это значит, что база ещё создаётся — подожди минуту и повтори (ycList service ydb).");
    }
    const token = await getIamToken(oauthToken);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 60000);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: {
          "X-Amz-Target": DOC_API_TARGET + target,
          "Content-Type": "application/x-amz-json-1.0",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
      const text = await res.text().catch(() => "");
      let j = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch {
        j = null;
      }
      if (!res.ok) {
        if (!j) {
          const e = new Error(
            "Облако вернуло не JSON (HTTP " + res.status + "): " + text.slice(0, 200) +
            " [" + hostOf(base) + " " + target + "]"
          );
          e.status = res.status;
          throw e;
        }
        throw documentApiError(res.status, j, hostOf(base) + " " + target);
      }
      return j || {};
    } catch (e) {
      if (isNetworkError(e)) throw new Error(serviceError(e, base, "/" + target));
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Найти базу в каталоге: по id, по имени, либо единственную. Если список отдал
  // базу без адреса Document API — добираем её карточкой (там адрес точный).
  async function findDatabase(oauthToken, folderId, ref) {
    const r = await listService(oauthToken, folderId, serviceByKey("ydb"));
    const list = r.items || [];
    if (!list.length) return { list: list, db: null };
    const want = String(ref || "").trim();
    let db = want
      ? list.find((d) => d.id === want) || list.find((d) => d.name === want)
      : list.length === 1 ? list[0] : null;
    if (db && !db.documentApiEndpoint) {
      try {
        const base = await ydbApiBase();
        const token = await getIamToken(oauthToken);
        const full = await fetchJson(
          base + "/ydb/v1/databases/" + encodeURIComponent(db.id),
          { headers: { Authorization: "Bearer " + token } },
          30000
        );
        if (full && full.id) db = full;
      } catch {
        // Оставляем краткую форму: адрес всё равно выведем из gRPC-эндпоинта.
      }
    }
    return { list: list, db: db };
  }

  async function listDocumentTables(oauthToken, db) {
    const j = await documentApiFetch(oauthToken, db, "ListTables", {});
    return {
      tables: Array.isArray(j.TableNames) ? j.TableNames.slice() : [],
      endpoint: documentApiEndpointFor(db),
    };
  }

  // Создать документную таблицу. Ключ собирается из объекта `keys`: первый ключ —
  // HASH (обязателен), остальные — RANGE. Тип ключа — S, N или B.
  async function createDocumentTable(oauthToken, db, opts) {
    const o = opts || {};
    const name = String(o.table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const keys = o.keys && typeof o.keys === "object" ? o.keys : {};
    const names = Object.keys(keys);
    if (!names.length) {
      throw new Error("Укажи keys — поля первичного ключа, например { \"id\": \"S\" } (первый — ключ поиска, остальные — сортировки).");
    }
    const definitions = names.map((n) => ({ AttributeName: n, AttributeType: String(keys[n] || "S").toUpperCase() }));
    const keySchema = names.map((n, i) => ({ AttributeName: n, KeyType: i === 0 ? "HASH" : "RANGE" }));
    await documentApiFetch(oauthToken, db, "CreateTable", { TableName: name, AttributeDefinitions: definitions, KeySchema: keySchema });
    return { table: name, keys: names };
  }

  async function describeDocumentTable(oauthToken, db, table) {
    const name = String(table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const j = await documentApiFetch(oauthToken, db, "DescribeTable", { TableName: name });
    const t = (j && j.Table) || {};
    return {
      table: String(t.TableName || name),
      status: String(t.TableStatus || ""),
      itemCount: Number(t.ItemCount) || 0,
      sizeBytes: Number(t.TableSizeBytes) || 0,
      keys: Array.isArray(t.KeySchema)
        ? t.KeySchema.map((k) => ({ name: String(k.AttributeName || ""), type: String(k.KeyType || "") }))
        : [],
    };
  }

  async function putDocumentItem(oauthToken, db, opts) {
    const o = opts || {};
    const name = String(o.table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const item = o.item && typeof o.item === "object" ? o.item : {};
    if (!Object.keys(item).length) throw new Error("Пустая запись: укажи item — пары «поле → значение».");
    await documentApiFetch(oauthToken, db, "PutItem", { TableName: name, Item: toItem(item) });
    return { table: name, fields: Object.keys(item) };
  }

  async function getDocumentItem(oauthToken, db, opts) {
    const o = opts || {};
    const name = String(o.table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const key = o.key && typeof o.key === "object" ? o.key : {};
    if (!Object.keys(key).length) throw new Error("Укажи key — значения полей первичного ключа записи.");
    const j = await documentApiFetch(oauthToken, db, "GetItem", { TableName: name, Key: toItem(key) });
    return { table: name, item: j.Item ? fromItem(j.Item) : null };
  }

  async function scanDocumentTable(oauthToken, db, opts) {
    const o = opts || {};
    const name = String(o.table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const limit = Math.max(1, Math.min(parseInt(o.limit, 10) || 20, 100));
    const j = await documentApiFetch(oauthToken, db, "Scan", { TableName: name, Limit: limit });
    return { table: name, items: (j.Items || []).map(fromItem), count: Number(j.Count) || 0, limit: limit };
  }

  async function deleteDocumentItem(oauthToken, db, opts) {
    const o = opts || {};
    const name = String(o.table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    const key = o.key && typeof o.key === "object" ? o.key : {};
    if (!Object.keys(key).length) throw new Error("Укажи key — значения полей первичного ключа записи.");
    await documentApiFetch(oauthToken, db, "DeleteItem", { TableName: name, Key: toItem(key) });
    return { table: name };
  }

  async function deleteDocumentTable(oauthToken, db, table) {
    const name = String(table || "").trim();
    if (!name) throw new Error("Не указана таблица (table).");
    await documentApiFetch(oauthToken, db, "DeleteTable", { TableName: name });
    return { table: name };
  }

  return {
    documentApiEndpointFor,
    toAttrValue,
    toItem,
    fromAttrValue,
    fromItem,
    documentApiError,
    documentApiFetch,
    findDatabase,
    listDocumentTables,
    createDocumentTable,
    describeDocumentTable,
    putDocumentItem,
    getDocumentItem,
    scanDocumentTable,
    deleteDocumentItem,
    deleteDocumentTable,
  };
}

module.exports = { createYcDb, DOC_API_TARGET };

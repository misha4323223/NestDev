"use strict";

/* ─── Консоль Yandex Cloud: карточка ресурса и связанные объекты ─────────────
   Чистый Node-модуль без Electron. Стоит ПОВЕРХ ./yandex-cloud.js: оттуда
   приходят авторизация (OAuth → IAM), адреса сервисов и разбор ошибок.

   Зачем: в панели облака видно СПИСОК ресурсов сервиса, но не сам ресурс.
   В настоящей консоли Yandex Cloud заходят внутрь: у сети — подсети и группы
   безопасности, у реестра — образы, у сервисного аккаунта — ключи, у секрета —
   версии, у контейнера — ревизии. Здесь именно это: обзор ресурса (все его поля)
   плюс связанные объекты.

   Про связанные объекты — важная деталь. У части сервисов «списка по родителю»
   нет, есть только список по каталогу: тогда берём список по каталогу и
   фильтруем по родителю на месте (это всегда корректный запрос). Где форма пути
   неочевидна — пробуем несколько вариантов и запоминаем сработавший, чтобы не
   гадать каждый раз. Если не подошла ни одна форма, карточка честно скажет, что
   связь недоступна, — вместо пустого списка «ничего нет».

   Модуль ничего не выдумывает: все поля — то, что вернул API Yandex Cloud. */

const yc = require("./yandex-cloud.js");
const { createYcDb } = require("./yc-db.js");

// Таблицы базы YDB живут в другом протоколе — HTTP Document API самой базы
// (DynamoDB-совместимый). Обслуживает его yc-db.js; помощники облака (IAM-токен,
// адрес сервиса, разбор сетевых отказов) берём те же, что у остальных запросов.
const ycdb = createYcDb({
  getIamToken: yc.getIamToken,
  fetchJson: yc._fetchJson,
  endpoint: yc.endpoint,
  listService: yc.listService,
  serviceByKey: yc.serviceByKey,
  hostOf: yc.hostOf,
  serviceError: yc.serviceError,
  isNetworkError: yc.isNetworkError,
});

const PAGE_SIZE = 200; // столько объектов показываем в связанном списке
const LIST_TIMEOUT_MS = 20000;

// ── Реестр связей: сервис → связанные объекты ресурса ───────────────────────
// attempts — варианты запроса по порядку. parentField — поле, по которому
// фильтруем список каталога (когда «по родителю» API не умеет).
const RELATIONS = {
  vpc: [
    { key: "subnets", title: "Подсети", icon: "🕸", listKey: "subnets", parentField: "networkId",
      attempts: [{ path: (c) => "/vpc/v1/subnets?folderId=" + enc(c.folderId) + "&pageSize=1000" }] },
    { key: "securityGroups", title: "Группы безопасности", icon: "🛡", listKey: "securityGroups", parentField: "networkId",
      attempts: [{ path: (c) => "/vpc/v1/securityGroups?folderId=" + enc(c.folderId) + "&pageSize=1000" }] },
    { key: "routeTables", title: "Таблицы маршрутизации", icon: "🧭", listKey: "routeTables", parentField: "networkId",
      attempts: [{ path: (c) => "/vpc/v1/routeTables?folderId=" + enc(c.folderId) + "&pageSize=1000" }] },
  ],
  serverlessContainers: [
    { key: "revisions", title: "Ревизии", icon: "🧱", listKey: "revisions",
      attempts: [{ path: (c) => "/containers/v1/revisions?containerId=" + enc(c.id) + "&pageSize=100" }] },
  ],
  containerRegistry: [
    { key: "images", title: "Образы", icon: "🖼", listKey: "images",
      attempts: [{ path: (c) => "/container-registry/v1/images?registryId=" + enc(c.id) + "&pageSize=100" }] },
  ],
  iam: [
    { key: "accessKeys", title: "Статические ключи", icon: "🔑", listKey: "accessKeys",
      // У ключей есть оба варианта: по сервисному аккаунту и по каталогу.
      attempts: [
        { path: (c) => "/iam/v1/accessKeys?serviceAccountId=" + enc(c.id) },
        { path: (c) => "/iam/v1/accessKeys?folderId=" + enc(c.folderId) + "&pageSize=1000", parentField: "serviceAccountId" },
      ] },
    { key: "apiKeys", title: "API-ключи", icon: "🗝", listKey: "apiKeys",
      attempts: [
        { path: (c) => "/iam/v1/apiKeys?serviceAccountId=" + enc(c.id) },
        { path: (c) => "/iam/v1/apiKeys?folderId=" + enc(c.folderId) + "&pageSize=1000", parentField: "serviceAccountId" },
      ] },
  ],
  lockbox: [
    { key: "versions", title: "Версии", icon: "🕘", listKey: "versions",
      attempts: [{ path: (c) => "/lockbox/v1/secrets/" + enc(c.id) + "/versions?pageSize=100" }] },
  ],
  dns: [
    { key: "recordSets", title: "Записи зоны", icon: "📇", listKey: "recordSets",
      // У DNS две равноправные формы вызова; какая сработает — зависит от шлюза.
      attempts: [
        { path: (c) => "/dns/v1/zones/" + enc(c.id) + ":getRecordSets" },
        { path: (c) => "/dns/v1/zones/" + enc(c.id) + ":getRecordSets", method: "POST", body: {} },
      ] },
  ],
  storage: [
    // Единственная связь НЕ через консольный API: объекты бакета живут в
    // S3-совместимом API (storage.yandexcloud.net), который отвечает XML-ом.
    // Поэтому у неё свой путь запроса — см. ветку rel.s3 в relationList.
    { key: "objects", title: "Объекты", icon: "🗂", listKey: "objects", s3: true,
      attempts: [{ path: (c) => "/" + enc(c.name) + "?list-type=2&max-keys=1000" }] },
  ],
  ydb: [
    // Вторая связь НЕ через консольный API: таблицы отдаёт HTTP Document API
    // САМОЙ базы (адрес — в её же documentApiEndpoint). Поэтому у связи свой
    // путь запроса — см. ветку rel.docApi в relationList.
    { key: "tables", title: "Таблицы", icon: "📋", listKey: "tables", docApi: true, attempts: [] },
  ],
};

// ── Карточка одного ресурса: чем дополнить список ───────────────────────────
// Путь GET'а самого ресурса. Если его нет — показываем то, что пришло списком.
const DETAIL_PATHS = {
  vpc: (c) => "/vpc/v1/networks/" + enc(c.id),
  dns: (c) => "/dns/v1/zones/" + enc(c.id),
  certificateManager: (c) => "/certificate-manager/v1/certificates/" + enc(c.id),
  apiGateway: (c) => "/apigateways/v1/apigateways/" + enc(c.id),
  cdn: (c) => "/cdn/v1/resources/" + enc(c.id),
  ydb: (c) => "/ydb/v1/databases/" + enc(c.id),
  lockbox: (c) => "/lockbox/v1/secrets/" + enc(c.id),
  logging: (c) => "/logging/v1/logGroups/" + enc(c.id),
  containerRegistry: (c) => "/container-registry/v1/registries/" + enc(c.id),
  iam: (c) => "/iam/v1/serviceAccounts/" + enc(c.id),
  serverlessContainers: (c) => "/containers/v1/containers/" + enc(c.id),
};

// Эндпоинт сервиса для запросов консоли. Совпадает с SERVICES из yandex-cloud.js.
const SERVICE_ENDPOINT = {
  apiGateway: "serverless-apigateway",
  certificateManager: "certificate-manager",
  cdn: "cdn",
  dns: "dns",
  logging: "logging",
  containerRegistry: "container-registry",
  iam: "iam",
  lockbox: "lockbox",
  ydb: "ydb",
  serverlessContainers: "serverless-containers",
  vpc: "vpc",
  storage: "storage-api",
  postbox: "postbox",
};

function enc(v) {
  return encodeURIComponent(String(v == null ? "" : v));
}

// ── Читаемые подписи и форматирование значений ──────────────────────────────
// Порядок важен: сначала то, что человек ищет глазами в консоли.
const FIELD_ORDER = [
  "name", "id", "status", "createdAt", "description", "folderId", "labels",
  "url", "image", "resources", "connectivity", "expiresAt", "updatedAt",
];

const FIELD_LABELS = {
  id: "Идентификатор",
  name: "Название",
  status: "Статус",
  createdAt: "Создано",
  updatedAt: "Изменено",
  lastModified: "Изменён",
  expiresAt: "Действует до",
  description: "Описание",
  folderId: "Каталог",
  cloudId: "Облако",
  labels: "Метки",
  url: "Адрес",
  image: "Образ",
  resources: "Ресурсы",
  connectivity: "Доступность",
  networkId: "Сеть",
  subnetId: "Подсеть",
  serviceAccountId: "Сервисный аккаунт",
  registryId: "Реестр",
  containerId: "Контейнер",
  zoneId: "Зона",
  domainName: "Домен",
  serverlessDatabase: "База",
  size: "Размер",
  memory: "Память",
  cores: "Ядра",
  coreFraction: "Доля ядра",
  concurrency: "Одновременных вызовов",
  timeout: "Таймаут",
  httpPort: "HTTP-порт",
  type: "Тип",
  mountType: "Тип тома",
  key: "Ключ",
  value: "Значение",
  endpoint: "Эндпоинт",
  documentApiEndpoint: "Эндпоинт Document API",
  defaultSecurityGroupId: "Группа безопасности по умолчанию",
  imageUrl: "Образ",
  keyId: "Идентификатор ключа",
  activeRevisionId: "Активная ревизия",
  reserved: "Зарезервировано",
  versionId: "Версия",
  lastUsedAt: "Последнее использование",
  createdBy: "Кем создано",
  recordSet: "Записи",
  ttl: "TTL",
  addresses: "Адреса",
  v4CidrBlocks: "Диапазоны IPv4",
  v6CidrBlocks: "Диапазоны IPv6",
  used: "Использовано",
  storageSize: "Место",
  regionId: "Регион",
  deletedAt: "Удалено",
  activeRevision: "Активная ревизия",
  variables: "Переменные",
  secrets: "Секреты",
  secretsData: "Секреты",
  runtime: "Среда",
  executionTimeout: "Таймаут",
  serviceAccountIds: "Сервисные аккаунты",
  content: "Содержимое",
  originGroupId: "Группа источников",
  originProtocol: "Протокол источника",
  sslCertificate: "Сертификат",
  providerType: "Провайдер",
  issuer: "Издатель",
  serial: "Серийный номер",
  challenges: "Проверки домена",
  domains: "Домены",
  encryption: "Шифрование",
  version: "Версия",
  payloadEntryKeys: "Ключи секрета",
};

// Что в карточке не показываем: служебное и дубли (список адресов из дашборда).
const FIELD_HIDDEN = new Set(["ok", "error", "items", "count", "title", "icon"]);

function labelFor(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  // camelCase → «Camel case»: неизвестное поле должно выглядеть читаемо.
  const s = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isoToRu(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

// «3 дня назад» — в консоли это половина смысла даты создания.
function humanAgo(iso, nowMs) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diff = (Number.isFinite(nowMs) ? nowMs : Date.now()) - d.getTime();
  if (diff < 0) return "";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "только что";
  if (min < 60) return min + " мин назад";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " ч назад";
  const days = Math.floor(h / 24);
  if (days === 1) return "вчера";
  if (days < 31) return days + " дн назад";
  const mon = Math.floor(days / 30);
  return mon < 12 ? mon + " мес назад" : Math.floor(mon / 12) + " г назад";
}

function humanBytes(n) {
  const v = Number(n);
  if (!isFinite(v) || v < 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (i === 0 ? x : Math.round(x * 10) / 10) + " " + units[i];
}

function humanSec(n) {
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return "";
  if (v < 60) return v + " с";
  const m = Math.floor(v / 60);
  return m < 60 ? m + " мин" : Math.floor(m / 60) + " ч " + (m % 60 ? (m % 60) + " мин" : "");
}

const TIME_KEYS = new Set(["createdAt", "updatedAt", "expiresAt", "deletedAt", "lastUsedAt", "startedAt", "finishedAt", "lastModified"]);
const BYTE_KEYS = new Set(["size", "storageSize", "used"]);
const SEC_KEYS = new Set(["timeout", "executionTimeout", "ttl", "duration"]);

// Значение поля → строка для карточки. Сложное уходит как есть (в интерфейсе
// такие значения показываются под раскрывающимся блоком, без выдумывания).
function formatField(key, val, nowMs) {
  if (val == null || val === "") return "";
  if (typeof val === "boolean") return val ? "да" : "нет";
  if (TIME_KEYS.has(key) && typeof val === "string") {
    const ru = isoToRu(val);
    if (!ru) return String(val);
    const ago = humanAgo(val, nowMs);
    return ago ? ru + " · " + ago : ru;
  }
  if (BYTE_KEYS.has(key) && (typeof val === "number" || /^\d+$/.test(String(val)))) {
    const h = humanBytes(val);
    if (h) return h + " (" + val + ")";
  }
  if (SEC_KEYS.has(key) && (typeof val === "number" || /^\d+$/.test(String(val)))) {
    const h = humanSec(val);
    if (h) return h;
  }
  // Метки — это пары «ключ: значение»; ключи пользователя (env, team) не
  // переименовываем и не капитализируем.
  if (key === "labels" && typeof val === "object" && !Array.isArray(val)) {
    const pairs = Object.keys(val).filter((k) => val[k] != null && val[k] !== "");
    return pairs.length ? pairs.map((k) => k + ": " + val[k]).join(" · ") : "";
  }
  // Образ и описание ресурса лежат во вложенных объектах одним понятным полем.
  if (key === "image" && typeof val === "object" && !Array.isArray(val) && val.imageUrl) return String(val.imageUrl);
  if ((key === "resources" || key === "resourcesSpec") && typeof val === "object" && !Array.isArray(val)) {
    const parts = Object.keys(val)
      .filter((k) => val[k] != null && val[k] !== "")
      .map((k) => labelFor(k) + ": " + (k === "memory" ? humanBytes(val[k]) || val[k] : val[k]));
    return parts.length ? parts.join(" · ") : "";
  }
  if (typeof val === "string" || typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    if (!val.length) return "";
    if (val.every((x) => typeof x !== "object")) return val.join(", ");
    return "";
  }
  if (typeof val === "object") {
    const keys = Object.keys(val).filter((k) => val[k] != null && val[k] !== "" && !FIELD_HIDDEN.has(k));
    if (!keys.length) return "";
    if (keys.length <= 4 && keys.every((k) => typeof val[k] !== "object")) {
      return keys.map((k) => labelFor(k) + ": " + val[k]).join(" · ");
    }
    return ""; // покажем отдельным блоком
  }
  return String(val);
}

// Как показывать поле в интерфейсе: строка, текст или JSON.
function fieldKind(key, val) {
  if (typeof val === "object" && val !== null) {
    return Array.isArray(val) && val.every((x) => typeof x !== "object") ? "list" : "json";
  }
  if (typeof val === "string" && (val.length > 90 || val.indexOf("\n") >= 0)) return "text";
  return "str";
}

// ── Обзор ресурса ───────────────────────────────────────────────────────────
// item — объект из списка сервиса (что уже есть на руках). detail запрашиваем
// дополнительно и мягко: ошибка не должна ломать карточку.
function buildFields(serviceKey, item, detail, nowMs) {
  const src = Object.assign({}, item || {}, detail || {});
  const keys = Object.keys(src).filter((k) => !FIELD_HIDDEN.has(k));
  const order = (k) => {
    const i = FIELD_ORDER.indexOf(k);
    return i < 0 ? 100 : i;
  };
  keys.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const fields = [];
  const extra = [];
  for (const k of keys) {
    const v = src[k];
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    const formatted = formatField(k, v, nowMs);
    if (!formatted) {
      if (typeof v === "object") extra.push({ key: k, label: labelFor(k), value: v });
      continue;
    }
    fields.push({ key: k, label: labelFor(k), value: formatted, kind: fieldKind(k, v) });
  }
  return { fields: fields, extra: extra };
}

function relationsFor(serviceKey) {
  return RELATIONS[serviceKey] || [];
}

// Какие колонки показывать в таблице связанных объектов. Список задан там, где
// важен порядок и осмысленные поля; иначе берём скалярные поля первой строки.
const RELATION_COLUMNS = {
  "vpc:subnets": ["name", "zoneId", "v4CidrBlocks", "status"],
  "vpc:securityGroups": ["name", "description"],
  "vpc:routeTables": ["name", "description"],
  "serverlessContainers:revisions": ["id", "status", "createdAt", "image"],
  "containerRegistry:images": ["name", "tags", "size", "createdAt"],
  "iam:accessKeys": ["keyId", "createdAt", "lastUsedAt"],
  "iam:apiKeys": ["id", "createdAt", "expiresAt"],
  "lockbox:versions": ["id", "status", "createdAt"],
  "dns:recordSets": ["name", "type", "ttl", "data"],
  "storage:objects": ["key", "size", "lastModified"],
  "ydb:tables": ["name"],
};

// Таблица для интерфейса: колонки + уже отформатированные строки. Форматирование
// живёт в одном месте (здесь), поэтому рендер остаётся простым.
function buildTable(serviceKey, relationKey, items, nowMs) {
  const list = Array.isArray(items) ? items : [];
  let keys = RELATION_COLUMNS[serviceKey + ":" + relationKey];
  if (!keys) {
    const first = list.find((x) => x && typeof x === "object") || {};
    keys = Object.keys(first)
      .filter((k) => !FIELD_HIDDEN.has(k) && first[k] != null && first[k] !== "" && typeof first[k] !== "object")
      .sort((a, b) => {
        const ia = FIELD_ORDER.indexOf(a);
        const ib = FIELD_ORDER.indexOf(b);
        return (ia < 0 ? 100 : ia) - (ib < 0 ? 100 : ib) || a.localeCompare(b);
      })
      .slice(0, 4);
  }
  const columns = keys.map((k) => ({ key: k, label: labelFor(k) }));
  const rows = list.map((it) =>
    keys.map((k) => {
      const v = it ? it[k] : "";
      const s = formatField(k, v, nowMs);
      if (s) return s;
      if (v == null || v === "") return "—";
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? "…" : x)).join(", ") || "—";
      return "{\u2026}";
    })
  );
  return { columns: columns, rows: rows };
}

function detailPathFor(serviceKey, ctx) {
  const f = DETAIL_PATHS[serviceKey];
  return f ? f(ctx) : "";
}

// ── Запросы ─────────────────────────────────────────────────────────────────
const workedAttempt = new Map(); // "сервис:связь" → индекс сработавшей формы пути

async function headersFor(oauthToken) {
  const token = await yc.getIamToken(oauthToken);
  return { Authorization: "Bearer " + token };
}

async function baseFor(serviceKey) {
  const id = SERVICE_ENDPOINT[serviceKey] || serviceKey;
  const base = (await yc.endpoint(id)) || "";
  if (!base) throw new Error("Не найден адрес сервиса «" + id + "» в каталоге Yandex Cloud.");
  return base.replace(/\/+$/, "");
}

// Один запрос с понятной ошибкой: модуль не должен показывать пользователю
// сырой текст сетевого сбоя без адреса и статуса.
async function getJson(base, path, headers, opts) {
  const o = opts || {};
  try {
    return await yc._fetchJson(base + path, {
      method: o.method || "GET",
      headers: Object.assign({}, headers, o.body ? { "Content-Type": "application/json" } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined,
    }, o.timeoutMs || LIST_TIMEOUT_MS);
  } catch (e) {
    // Статус сохраняем: по нему выше отличаем «такой формы пути нет» (404/405)
    // от настоящей ошибки (401/403/сеть) — их нельзя выдавать за пустой список.
    const err = new Error(yc.serviceError(e, base, path) || (e && e.message) || String(e));
    err.status = e && e.status;
    throw err;
  }
}

// Список связанных объектов: пробуем формы пути по порядку, сработавшую
// запоминаем — на следующий раз это один запрос без перебора.
async function relationList(oauthToken, opts) {
  const o = opts || {};
  const serviceKey = String(o.serviceKey || "").trim();
  const relationKey = String(o.relationKey || "").trim();
  const rel = relationsFor(serviceKey).find((r) => r.key === relationKey);
  if (!rel) throw new Error("У сервиса «" + serviceKey + "» нет связи «" + relationKey + "».");
  const ctx = {
    id: String(o.id || "").trim(),
    name: String(o.name || "").trim(),
    folderId: String(o.folderId || "").trim(),
  };
  // Объекты бакета — единственная связь не через консольный API: их отдаёт
  // S3-совместимый API (storage.yandexcloud.net) и отвечает он XML-ом. Запрос
  // идёт через yandex-cloud.js, где авторизация и разбор уже есть, — иначе
  // пришлось бы заводить здесь второй вид запроса ради одного списка.
  if (rel.s3) {
    try {
      const r = await yc.listBucketObjects(oauthToken, { bucket: ctx.name, prefix: "", limit: PAGE_SIZE });
      const table = buildTable(serviceKey, relationKey, r.items, Date.now());
      return {
        ok: true,
        key: rel.key,
        title: rel.title,
        icon: rel.icon,
        count: r.count,
        items: r.items,
        columns: table.columns,
        rows: table.rows,
        truncated: r.truncated || r.count > PAGE_SIZE,
        path: "S3 /" + ctx.name + "?list-type=2",
      };
    } catch (e) {
      return {
        ok: false,
        key: rel.key,
        title: rel.title,
        icon: rel.icon,
        count: 0,
        items: [],
        error: "Не удалось прочитать «" + rel.title + "» (показываю причину, а не пустой список):\n" + ((e && e.message) || String(e)),
      };
    }
  }
  // Таблицы базы YDB — вторая связь не через консольный API: их отдаёт HTTP
  // Document API самой базы (операция идёт заголовком, значения типизированы).
  // Запрос идёт через yc-db.js, где уже есть адрес базы, IAM и разбор отказов.
  if (rel.docApi) {
    try {
      const found = await ycdb.findDatabase(oauthToken, ctx.folderId, ctx.id || ctx.name);
      if (!found.db) {
        throw new Error("База «" + (ctx.name || ctx.id) + "» не нашлась в каталоге — возможно, её удалили.");
      }
      const r = await ycdb.listDocumentTables(oauthToken, found.db);
      const items = r.tables.map((name) => ({ name: name }));
      const table = buildTable(serviceKey, relationKey, items, Date.now());
      return {
        ok: true,
        key: rel.key,
        title: rel.title,
        icon: rel.icon,
        count: items.length,
        items: items,
        columns: table.columns,
        rows: table.rows,
        truncated: false,
        path: "Document API " + r.endpoint + " ListTables",
      };
    } catch (e) {
      return {
        ok: false,
        key: rel.key,
        title: rel.title,
        icon: rel.icon,
        count: 0,
        items: [],
        error: "Не удалось прочитать «" + rel.title + "» (показываю причину, а не пустой список):\n" + ((e && e.message) || String(e)),
      };
    }
  }
  const headers = await headersFor(oauthToken);
  const base = await baseFor(serviceKey);
  const memoKey = serviceKey + ":" + relationKey;
  const order = [];
  const known = workedAttempt.get(memoKey);
  if (known != null) order.push(known);
  for (let i = 0; i < rel.attempts.length; i++) if (i !== known) order.push(i);

  const errors = [];
  for (const idx of order) {
    const at = rel.attempts[idx];
    const path = at.path(ctx);
    try {
      const j = await getJson(base, path, headers, { method: at.method || "GET", body: at.body });
      let items = yc.pickList(j, rel.listKey);
      const parentField = at.parentField || rel.parentField;
      if (parentField && ctx.id) {
        const filtered = items.filter((x) => !x || x[parentField] == null || String(x[parentField]) === ctx.id);
        // Если фильтр вычистил всё, а поле у объектов есть — значит они не наши,
        // и честнее показать пусто, чем чужие ресурсы каталога.
        const hasField = items.some((x) => x && x[parentField] != null);
        if (hasField) items = filtered;
      }
      workedAttempt.set(memoKey, idx);
      const shown = items.slice(0, PAGE_SIZE);
      const table = buildTable(serviceKey, relationKey, shown, Date.now());
      return {
        ok: true,
        key: rel.key,
        title: rel.title,
        icon: rel.icon,
        count: items.length,
        items: shown,
        columns: table.columns,
        rows: table.rows,
        truncated: items.length > PAGE_SIZE,
        path: path,
      };
    } catch (e) {
      // Пробуем следующую форму, если текущая не подошла или отказала по правам:
      // список «по каталогу» часто разрешён там, где список «по родителю» даёт
      // 403. Тормозимся только на сломанной авторизации — с ней другие формы
      // бессмысленны, и на ошибке показываем её, а не пустой список.
      errors.push(path + " → " + ((e && e.message) || String(e)).slice(0, 160));
      if (e && e.status === 401) break;
    }
  }
  return {
    ok: false,
    key: rel.key,
    title: rel.title,
    icon: rel.icon,
    count: 0,
    items: [],
    error: "Не удалось прочитать «" + rel.title + "» (показываю причину, а не пустой список):\n" + errors.join("\n"),
  };
}

// Обзор: поля ресурса + счётчики по связанным объектам (сами списки — по клику).
async function overview(oauthToken, opts) {
  const o = opts || {};
  const serviceKey = String(o.serviceKey || "").trim();
  const id = String(o.id || "").trim();
  const folderId = String(o.folderId || "").trim();
  const item = (o.item && typeof o.item === "object") ? o.item : {};
  const nowMs = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const ctx = { id: id, name: String(item.name || "").trim(), folderId: folderId };

  const headers = await headersFor(oauthToken);
  let base = "";
  let detail = null;
  let detailError = "";
  const path = id ? detailPathFor(serviceKey, ctx) : "";
  if (path) {
    try {
      base = await baseFor(serviceKey);
      detail = await getJson(base, path, headers, { timeoutMs: 15000 });
    } catch (e) {
      detailError = (e && e.message) || String(e);
    }
  }

  const rels = relationsFor(serviceKey);
  const relations = [];
  if (rels.length) {
    // Счётчики — пачками по 3: залпом все связи упираются в таймауты.
    const batch = 3;
    for (let i = 0; i < rels.length; i += batch) {
      const chunk = rels.slice(i, i + batch);
      const res = await Promise.all(
        chunk.map((r) => relationList(oauthToken, { serviceKey: serviceKey, relationKey: r.key, id: id, name: ctx.name, folderId: folderId }))
      );
      for (const r of res) {
        relations.push({
          key: r.key,
          title: r.title,
          icon: r.icon,
          ok: !!r.ok,
          count: r.count || 0,
          error: r.error || "",
        });
      }
    }
  }

  const built = buildFields(serviceKey, item, detail, nowMs);
  return {
    ok: true,
    serviceKey: serviceKey,
    id: id,
    title: String((detail && detail.name) || item.name || id || "ресурс"),
    subtitle: labelService(serviceKey),
    fields: built.fields,
    extra: built.extra,
    relations: relations,
    detailError: detailError,
  };
}

const SERVICE_TITLES = {
  vpc: "Virtual Private Cloud",
  dns: "Cloud DNS",
  certificateManager: "Certificate Manager",
  apiGateway: "API Gateway",
  cdn: "Cloud CDN",
  ydb: "Managed Service for YDB",
  lockbox: "Lockbox",
  logging: "Cloud Logging",
  containerRegistry: "Container Registry",
  iam: "Identity and Access Management",
  serverlessContainers: "Serverless Containers",
  storage: "Object Storage",
  postbox: "Cloud Postbox",
};

function labelService(key) {
  return SERVICE_TITLES[key] || String(key || "");
}

// Откат контейнера на ревизию («сделать активной» в консоли). Право на изменение
// проверяет вызывающая сторона: модуль только говорит, что и куда отправил.
async function rollbackRevision(oauthToken, opts) {
  const o = opts || {};
  const containerId = String(o.containerId || "").trim();
  const revisionId = String(o.revisionId || "").trim();
  if (!containerId || !revisionId) {
    throw new Error("Нужны containerId и revisionId. Список ревизий — в карточке контейнера.");
  }
  const headers = await headersFor(oauthToken);
  const base = await baseFor("serverlessContainers");
  const path = "/containers/v1/containers/" + enc(containerId) + ":rollback";
  await getJson(base, path, headers, { method: "POST", body: { revisionId: revisionId }, timeoutMs: 30000 });
  return { ok: true, containerId: containerId, revisionId: revisionId };
}

// ── Версия секрета Lockbox: карточка секрета в панели ────────────────────────
// Раньше секрет можно было создать (ycCreate), и на этом всё заканчивалось:
// версий у него не было, а без версии секрет бесполезен — ревизия контейнера
// ссылается на ключ, которого нет. Здесь — единственная недостающая операция.
//
// Новая версия секрета. Значения уходят в облако и НЕ возвращаются: наружу
// отдаём только id версии и имена ключей — они попадают и в ответ агенту,
// и в сообщение панели, и в логи.
async function putSecretVersion(oauthToken, opts) {
  const o = opts || {};
  const secretId = String(o.secretId || o.id || "").trim();
  if (!secretId) throw new Error("Нужен id секрета. Открой карточку секрета в панели «☁️ Cloud» (список: ycList(service: \"lockbox\")).");
  // Разбор «ключ → значение» и проверка ключей — в yandex-cloud.js: тем же
  // кодом пользуется агент, и две копии разъехались бы на первой правке.
  const entries = o.entries || o.payload || o.values;
  const r = await yc.putSecretVersion(oauthToken, secretId, entries);
  return { ok: true, secretId: secretId, versionId: (r && r.versionId) || "", keys: (r && r.keys) || [] };
}

// ── Записи DNS-зоны: карточка зоны в панели ──────────────────────────────────
// Раньше зону можно было создать (ycCreate), а записи — только читать: домен
// подключить было нечем. Строгость API (нельзя удалить несуществующее и
// добавить поверх существующего) разобрана в yandex-cloud.js — здесь только
// разбор того, что пришло из формы, и понятные ошибки.
async function upsertRecord(oauthToken, opts) {
  const o = opts || {};
  const zoneId = String(o.zoneId || o.id || "").trim();
  if (!zoneId) throw new Error("Нужен id DNS-зоны. Открой карточку зоны в панели «☁️ Cloud» (список: ycList(service: \"dns\")).");
  const type = String(o.type || "").trim().toUpperCase();
  const values = Array.isArray(o.values) ? o.values : (o.value == null ? [] : [o.value]);
  const r = await yc.upsertRecordSet(oauthToken, zoneId, {
    name: o.name,
    type: type,
    ttl: o.ttl,
    data: values,
  });
  return { ok: true, zoneId: zoneId, name: r.name, type: r.type, ttl: r.ttl, values: r.values, replaced: r.replaced };
}

async function deleteRecord(oauthToken, opts) {
  const o = opts || {};
  const zoneId = String(o.zoneId || o.id || "").trim();
  if (!zoneId) throw new Error("Нужен id DNS-зоны.");
  const r = await yc.deleteRecordSet(oauthToken, zoneId, { name: o.name, type: o.type });
  return { ok: true, zoneId: zoneId, name: r.name, type: r.type, values: r.values };
}

// ── Container Registry: чистка образов ────────────────────────────────────
// Образы копятся: каждая выкатка добавляет новый, а прежние остаются и занимают
// место в платном хранилище. Удаление образа забирает и его теги, поэтому образ
// ищем по id, тегу или digest: человек называет тег, а Delete принимает id.
async function deleteRegistryImage(oauthToken, opts) {
  const o = opts || {};
  const registryId = String(o.registryId || "").trim();
  if (!registryId) throw new Error("Нужен id реестра. Открой карточку реестра в панели «☁️ Cloud» (список: ycList(service: \"containerRegistry\")).");
  const ref = String(o.imageId || o.tag || o.image || o.ref || "").trim();
  if (!ref) throw new Error("Не указан образ: нужен id образа или его тег.");
  const img = await yc.findRegistryImage(oauthToken, registryId, ref);
  if (!img) throw new Error("В реестре нет образа «" + ref + "» — возможно, его уже удалили.");
  await yc.deleteRegistryImage(oauthToken, img.id);
  return {
    ok: true,
    registryId: registryId,
    imageId: img.id,
    name: String(img.name || ""),
    tags: Array.isArray(img.tags) ? img.tags : [],
  };
}

// ── Object Storage: объект в бакете ───────────────────────────────────────
// Файлы в бакете не открывались в панели вообще: карточка бакета показывала
// только его самого. Список даёт связь storage:objects, а отсюда идёт удаление
// объекта — тем же путём, что у образов реестра и записей DNS (свой код в
// yandex-cloud.js, где лежат строгости S3-совместимого API).
async function deleteBucketObject(oauthToken, opts) {
  const o = opts || {};
  const bucket = String(o.bucket || o.bucketName || "").trim();
  if (!bucket) throw new Error("Нужно имя бакета. Открой карточку бакета в панели «☁️ Cloud» (список: ycList(service: \"storage\")).");
  const key = String(o.key || o.object || "").replace(/^\/+/, "");
  if (!key) throw new Error("Не указан объект: нужен ключ (путь файла в бакете).");
  const r = await yc.deleteBucketObject(oauthToken, { bucket: bucket, key: key });
  return { ok: true, bucket: r.bucket, key: r.key };
}

// ── Object Storage: публичный доступ к бакету ─────────────────────────────
// Бакет по умолчанию закрыт, и это правильно, но из карточки не было видно, что
// именно он закрыт: ссылка «открытый адрес объекта» возвращала отказ, и человек
// искал причину в консоли Yandex Cloud. Теперь состояние читается и меняется
// прямо здесь — тем же console-API, что и список бакетов (объекты лежат в
// S3-совместимом API, а права на бакет — в консольном).
async function getBucketAccessFlags(oauthToken, bucket) {
  const name = String(bucket || "").trim();
  if (!name) throw new Error("Нужно имя бакета. Открой карточку бакета в панели «☁️ Cloud» (список: ycList(service: \"storage\")).");
  const r = await yc.getBucketAccess(oauthToken, name);
  return { ok: true, bucket: r.bucket, flags: r.flags };
}

async function setBucketPublicAccess(oauthToken, opts) {
  const o = opts || {};
  const name = String(o.bucket || o.bucketName || "").trim();
  if (!name) throw new Error("Нужно имя бакета. Открой карточку бакета в панели «☁️ Cloud» (список: ycList(service: \"storage\")).");
  const on = o.publicOn == null ? !!(o.public || o.on) : !!o.publicOn;
  const r = await yc.setBucketPublicAccess(oauthToken, name, on);
  return { ok: true, bucket: r.bucket, flags: r.flags, public: r.public };
}

// Что модуль умеет — для карточки «нет данных» и для справки агенту.
function capabilities() {
  const out = [];
  for (const key of Object.keys(SERVICE_ENDPOINT)) {
    out.push({
      serviceKey: key,
      title: labelService(key),
      detail: !!DETAIL_PATHS[key],
      relations: relationsFor(key).map((r) => ({ key: r.key, title: r.title })),
    });
  }
  return out;
}

module.exports = {
  RELATIONS,
  DETAIL_PATHS,
  SERVICE_ENDPOINT,
  relationList,
  rollbackRevision,
  putSecretVersion,
  upsertRecord,
  deleteRecord,
  deleteRegistryImage,
  deleteBucketObject,
  getBucketAccessFlags,
  setBucketPublicAccess,
  overview,
  buildFields,
  buildTable,
  formatField,
  labelFor,
  humanAgo,
  humanBytes,
  capabilities,
  labelService,
  _resetWorkedAttempts: () => workedAttempt.clear(),
};

"use strict";

/* ─── Интеграция с Yandex Cloud (REST API) ────────────────────────────────────
   Чистый Node-модуль (без Electron): fetch + таймеры, тестируется в plain-node.

   Авторизация:
     Пользователь даёт OAuth-токен Yandex (получается на oauth.yandex.ru,
     тот же токен, что использует yc CLI). Приложение обменивает его на
     IAM-токен (POST https://iam.api.cloud.yandex.net/iam/v1/tokens), который
     живёт ~12 часов и кэшируется — пере-обмен происходит автоматически.

   Эндпоинты:
     Загружаются динамически с https://api.cloud.yandex.net/endpoints (кэш),
     фолбэк — известные адреса сервисов (на случай недоступности списка).

   Дашборд (счётчики по 13 сервисам):
     Для каждого сервиса — GET list по каталогу (folderId) с Bearer IAM-токеном.
     Каждый сервис считается независимо: ошибка одного не роняет остальные.

   Создание/удаление:
     Простые ресурсы (YDB, Lockbox, Registry, Bucket, DNS-зона, Serverless
     Container, VPC-сеть) создаются POST'ом и ждут завершения операции.
     Удаление — DELETE по id ресурса. */

const KNOWN_ENDPOINTS = {
  "iam": "https://iam.api.cloud.yandex.net",
  "resource-manager": "https://resource-manager.api.cloud.yandex.net",
  "operation": "https://operation.api.cloud.yandex.net",
  "serverless-containers": "https://serverless-containers.api.cloud.yandex.net",
  "container-registry": "https://container-registry.api.cloud.yandex.net",
  "ydb": "https://ydb.api.cloud.yandex.net",
  "lockbox": "https://lockbox.api.cloud.yandex.net",
  "storage": "https://storage.api.cloud.yandex.net",
  "storage-api": "https://storage.api.cloud.yandex.net",
  // Объекты бакета — не в консольном (storage-api), а в S3-совместимом API.
  // Авторизация там IAM-токеном работает БЕЗ подписи запроса
  // (Authorization: Bearer <IAM>), поэтому статический ключ доступа не нужен.
  "storage-s3": "https://storage.yandexcloud.net",
  "dns": "https://dns.api.cloud.yandex.net",
  "apigateway": "https://apigateway.api.cloud.yandex.net",
  "serverless-apigateway": "https://serverless-apigateway.api.cloud.yandex.net",
  "certificate-manager": "https://certificatemanager.api.cloud.yandex.net",
  "cdn": "https://cdn.api.cloud.yandex.net",
  "logging": "https://logging.api.cloud.yandex.net",
  // В каталоге эндпоинтов это ТРИ разных сервиса:
  //   logging       — группы, экспорт, синки (REST + gRPC);
  //   log-reading   — чтение записей (ТОЛЬКО gRPC; REST там не живёт вовсе);
  //   log-ingestion — запись записей.
  // Чтение логов с logging.api.cloud.yandex.net даёт «gRPC 12: unknown service
  // yandex.cloud.logging.v1.LogReadingService» — сервиса на том хосте нет.
  "log-reading": "https://reader.logging.yandexcloud.net",
  "log-ingestion": "https://ingester.logging.yandexcloud.net",
  "vpc": "https://vpc.api.cloud.yandex.net",
  // Postbox — SES-совместимый API (см. auth в SERVICES), не обычный REST каталога.
  "postbox": "https://postbox.cloud.yandex.net",
};

let endpointsCache = null; // { serviceId: address }
let endpointsTs = 0; // мс загрузки
let iamCache = null; // { token, expiresAtMs }

// ── HTTP-обёртка с таймаутом ────────────────────────────────────────────────
async function fetchJson(url, opts, timeoutMs) {
  const t = timeoutMs || 15000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal, redirect: "follow" }, opts || {}));
    let body = null;
    const text = await res.text().catch(() => "");
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = friendlyApiError(res.status, body, text);
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      err.raw = text;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// Понятное объяснение ошибок API (коды HTTP + типовые причины Yandex Cloud).
function friendlyApiError(status, body, text) {
  const raw = body && (body.message || body.error || body.detail) ? String(body.message || body.error || body.detail) : (text || "").slice(0, 300);
  const map = {
    400: "Неверный запрос (400): ",
    401: "Не пройдена авторизация (401): токен недействителен или истёк. Проверь OAuth-токен в Настройках → Yandex Cloud.",
    403: "Нет доступа (403): у аккаунта/сервисного аккаунта не хватает прав на это действие в каталоге.",
    404: "Не найдено (404): ",
    409: "Конфликт (409): ресурс с таким именем уже существует или операция ещё не завершена.",
    429: "Слишком много запросов (429): подожди немного и повтори.",
    500: "Ошибка сервера Yandex Cloud (500): ",
    503: "Сервис временно недоступен (503): попробуй позже.",
  };
  const prefix = map[status] || ("Ошибка HTTP " + status + ": ");
  const detail = raw ? raw.slice(0, 500) : "(без деталей)";
  // Типовые причины из тела ошибки (коды вида FAILED_PRECONDITION и т.п.)
  if (body && body.code === 7) return "Предусловие не выполнено (7, FAILED_PRECONDITION): " + (body.message || detail);
  if (body && body.code === 16) return "Недостаточно прав (16, UNAUTHENTICATED): " + (body.message || detail);
  if (body && body.code === 3) return "Неверный аргумент (3, INVALID_ARGUMENT): " + (body.message || detail);
  return prefix + detail;
}

// Сбои «запрос не дошёл» (сеть, таймаут, обрыв) — их имеет смысл повторить,
// в отличие от ошибок API (401/403/404 — повтор ничего не изменит).
function isNetworkError(e) {
  const m = String((e && e.message) || e || "");
  if (e && e.name === "AbortError") return true;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|aborted|terminated/i.test(m);
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url || "");
  }
}

// Понятный текст ошибки сервиса + адрес, по которому стучались (видно сразу,
// сетевой это сбой или ошибка API).
function serviceError(e, base, path) {
  const where = hostOf(base) + String(path || "");
  if (e && e.name === "AbortError") return "Таймаут: " + where + " не ответил вовремя — повтори позже.";
  if (isNetworkError(e)) {
    return "Сеть: запрос к " + where + " не прошёл (" + String((e && e.message) || e).slice(0, 120) + ").";
  }
  return String((e && e.message) || e) + " [" + where + "]";
}

// ── Эндпоинты сервисов ──────────────────────────────────────────────────────
// Полный список отдаёт https://api.cloud.yandex.net/endpoints (формат устойчив к
// изменениям: ищем все объекты с полем address и собираем карту по id).
async function loadEndpoints() {
  if (endpointsCache && Date.now() - endpointsTs < 12 * 3600 * 1000) return endpointsCache;
  try {
    const j = await fetchJson("https://api.cloud.yandex.net/endpoints", {}, 8000);
    const map = {};
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (typeof v.address === "string" && v.id) {
        let a = String(v.address).replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(a)) a = "https://" + a;
        map[String(v.id)] = a;
      }
      for (const k of Object.keys(v)) {
        if (k === "address") continue;
        walk(v[k]);
      }
    };
    walk(j);
    if (Object.keys(map).length) {
      endpointsCache = map;
      endpointsTs = Date.now();
      return map;
    }
  } catch {}
  return null;
}

// Фоновое обновление каталога: не блокирует запуск (у loadEndpoints таймаут 8 с,
// и раньше он ждался ДО первого запроса — из-за этого холодный yc:status мог
// висеть десятки секунд).
let primePromise = null;
let primeTs = 0;
const PRIME_MIN_INTERVAL = 5 * 60 * 1000; // не долбим каталог, если он недоступен
function primeEndpoints() {
  if (primePromise) return primePromise;
  if (Date.now() - primeTs < PRIME_MIN_INTERVAL) return null;
  primeTs = Date.now();
  primePromise = loadEndpoints()
    .catch(() => null)
    .finally(() => {
      primePromise = null;
    });
  return primePromise;
}

// Тестовый хук: живые тесты поднимают подменённый Yandex Cloud API и уводят туда
// все сервисы, включая обмен OAuth → IAM. В обычной жизни переменная не задана.
function testApiBase() {
  return String(process.env.AI_AGENT_YC_BASE || "").trim().replace(/\/+$/, "");
}

// Адрес сервиса. Выверенный KNOWN_ENDPOINTS отдаётся сразу (он совпадает с
// актуальным), а каталог догружается в фоне и потом используется для id, которых
// в KNOWN нет. Так первый запрос не ждёт сеть вообще.
async function endpoint(serviceId) {
  const testBase = testApiBase();
  if (testBase) return testBase;
  if (endpointsCache && Date.now() - endpointsTs < 12 * 3600 * 1000) {
    return endpointsCache[serviceId] || KNOWN_ENDPOINTS[serviceId] || null;
  }
  const known = KNOWN_ENDPOINTS[serviceId] || null;
  if (known) {
    primeEndpoints();
    return known;
  }
  const ep = await loadEndpoints();
  return (ep && ep[serviceId]) || null;
}

// ── IAM-токен (OAuth → IAM, кэш с авто-обновлением) ─────────────────────────
// Возвращает и срок жизни: он нужен, чтобы подставлять в окружение yc CLI
// ЗАВЕДОМО живой IAM-токен (OAuth там не принимается — CLI отвечает
// «The token is invalid»).
async function getIamTokenInfo(oauthToken, force) {
  const oauth = String(oauthToken || "").trim();
  if (!oauth) {
    const e = new Error("Не указан OAuth-токен Yandex. Открой Настройки → Yandex Cloud и вставь токен.");
    e.status = 401;
    throw e;
  }
  if (!force && iamCache && Date.now() < iamCache.expiresAtMs - 60 * 1000) return { token: iamCache.token, expiresAtMs: iamCache.expiresAtMs };
  const base = (await endpoint("iam")) || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yandexPassportOauthToken: oauth }),
  }, 20000);
  const token = j && j.iamToken;
  if (!token) {
    const e = new Error("Обмен OAuth → IAM не вернул токен (ответ: " + JSON.stringify(j).slice(0, 200) + ")");
    e.status = 401;
    throw e;
  }
  const expiresAtMs = j.expiresAt ? Date.parse(String(j.expiresAt)) : 0;
  iamCache = { token, expiresAtMs: expiresAtMs || Date.now() + 12 * 3600 * 1000 };
  return { token: iamCache.token, expiresAtMs: iamCache.expiresAtMs };
}

async function getIamToken(oauthToken, force) {
  return (await getIamTokenInfo(oauthToken, force)).token;
}

// Обнулить кэш IAM-токена (после смены/удаления OAuth-токена).
function resetIamCache() {
  iamCache = null;
}

// ── Облака и каталоги ───────────────────────────────────────────────────────
// Сетевые сбои повторяем — они, в отличие от 401/403/404, проходят со второй попытки.
async function retryNet(fn, tries) {
  const n = Math.max(1, tries || 2);
  let last = null;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isNetworkError(e) || i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

async function listClouds(oauthToken) {
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("resource-manager")) || KNOWN_ENDPOINTS["resource-manager"];
  const j = await retryNet(() =>
    fetchJson(base + "/resource-manager/v1/clouds?pageSize=1000", {
      headers: { Authorization: "Bearer " + token },
    }, 12000)
  );
  const clouds = Array.isArray(j && j.clouds) ? j.clouds : [];
  return clouds.map((c) => ({ id: c.id, name: c.name || "" }));
}

async function listFolders(oauthToken, cloudId) {
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("resource-manager")) || KNOWN_ENDPOINTS["resource-manager"];
  const q = cloudId ? "cloudId=" + encodeURIComponent(cloudId) + "&pageSize=1000" : "pageSize=1000";
  const j = await retryNet(() =>
    fetchJson(base + "/resource-manager/v1/folders?" + q, {
      headers: { Authorization: "Bearer " + token },
    }, 12000)
  );
  const folders = Array.isArray(j && j.folders) ? j.folders : [];
  return folders.map((f) => ({ id: f.id, name: f.name || "", cloudId: f.cloudId || "" }));
}

// ── Сервисы дашборда ────────────────────────────────────────────────────────
// Каждый сервис: key (для IPC), title, icon (emoji), svc (id эндпоинта),
// listPath (GET list по каталогу), listKey (поле массива в ответе).
const SERVICES = [
  { key: "apiGateway", title: "API Gateway", icon: "🔀", svc: "serverless-apigateway", listPath: "/apigateways/v1/apigateways", listKey: "apigateways" },
  { key: "certificateManager", title: "Certificate Manager", icon: "🔐", svc: "certificate-manager", listPath: "/certificate-manager/v1/certificates", listKey: "certificates" },
  { key: "cdn", title: "Cloud CDN", icon: "🌍", svc: "cdn", listPath: "/cdn/v1/resources", listKey: "resources" },
  { key: "dns", title: "Cloud DNS", icon: "🌐", svc: "dns", listPath: "/dns/v1/zones", listKey: "zones" },
  { key: "logging", title: "Cloud Logging", icon: "📜", svc: "logging", listPath: "/logging/v1/logGroups", listKey: "groups" },
  // Cloud Postbox — это SES-совместимый API (Amazon SES v2), а НЕ обычный REST
  // каталога: путь /postbox/v1/addresses не существует (проверено — быстрый 404),
  // список адресов — GET /v2/email/identities, авторизация — X-YaCloud-SubjectToken
  // с IAM-токеном СЕРВИСНОГО аккаунта (роль postbox.viewer), Authorization не нужен.
  { key: "postbox", title: "Cloud Postbox", icon: "📮", svc: "postbox", listPath: "/v2/email/identities", listKey: "Identities", auth: "subject", query: "ses" },
  { key: "containerRegistry", title: "Container Registry", icon: "📦", svc: "container-registry", listPath: "/container-registry/v1/registries", listKey: "registries" },
  { key: "iam", title: "Identity and Access Management", icon: "🗝️", svc: "iam", listPath: "/iam/v1/serviceAccounts", listKey: "serviceAccounts" },
  { key: "lockbox", title: "Lockbox", icon: "🔒", svc: "lockbox", listPath: "/lockbox/v1/secrets", listKey: "secrets" },
  { key: "ydb", title: "Managed Service for YDB", icon: "🗄️", svc: "ydb", listPath: "/ydb/v1/databases", listKey: "databases" },
  { key: "storage", title: "Object Storage", icon: "🪣", svc: "storage-api", listPath: "/storage/v1/buckets", listKey: "buckets" },
  { key: "serverlessContainers", title: "Serverless Containers", icon: "☁️", svc: "serverless-containers", listPath: "/containers/v1/containers", listKey: "containers" },
  { key: "vpc", title: "Virtual Private Cloud", icon: "🕸️", svc: "vpc", listPath: "/vpc/v1/networks", listKey: "networks" },
];

function serviceByKey(key) {
  return SERVICES.find((s) => s.key === key) || null;
}

// Заголовки авторизации сервиса. Postbox (SES) ждёт IAM-токен в
// X-YaCloud-SubjectToken; все остальные сервисы — обычный Bearer.
function serviceHeaders(svcDef, token) {
  return svcDef && svcDef.auth === "subject"
    ? { "X-YaCloud-SubjectToken": token }
    : { Authorization: "Bearer " + token };
}

// Строка запроса. SES живёт по своим правилам (PageSize вместо folderId/pageSize).
function serviceQuery(svcDef, folderId) {
  if (svcDef && svcDef.query === "ses") return "?PageSize=100";
  const q = folderId ? "folderId=" + encodeURIComponent(folderId) + "&pageSize=1000" : "pageSize=1000";
  return "?" + q;
}

// Массив ресурсов из ответа: точное имя поля, затем то же имя в другом регистре
// (SES отдаёт Identities, каталог — lowercase), затем сам ответ, если это массив.
function pickList(body, key) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body[key])) return body[key];
  const lower = String(key).toLowerCase();
  for (const k of Object.keys(body)) {
    if (k.toLowerCase() === lower && Array.isArray(body[k])) return body[k];
  }
  return [];
}

// Почему 403 у SES-сервиса: пользовательский OAuth-токен такой API не принимает,
// нужен сервисный аккаунт. Иначе агент видел бы просто «Нет доступа (403)» и шёл
// искать права пользователя, которых там нет.
function serviceForbidden(svcDef, e) {
  if (!svcDef || svcDef.auth !== "subject" || !e || e.status !== 403) return "";
  return (
    "Нет доступа (403) к «" + svcDef.title + "»: этому API нужен IAM-токен СЕРВИСНОГО аккаунта с ролью postbox.viewer — " +
    "пользовательский OAuth-токен Postbox не принимает. Создай сервисный аккаунт в консоли Yandex Cloud."
  );
}

// Список всех ресурсов каталога по одному сервису. Возвращает { count, items }.
async function listService(oauthToken, folderId, svcDef, opts) {
  const o = opts || {};
  const token = await getIamToken(oauthToken);
  const base = (await endpoint(svcDef.svc)) || KNOWN_ENDPOINTS[svcDef.svc];
  if (!base) throw new Error("Эндпоинт сервиса «" + svcDef.title + "» не найден.");
  const url = base + svcDef.listPath + serviceQuery(svcDef, folderId);
  const headers = serviceHeaders(svcDef, token);
  const tries = Math.max(1, o.retries == null ? 2 : parseInt(o.retries, 10) || 1);
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await fetchJson(url, { headers }, o.timeoutMs || 25000);
      const items = pickList(j, svcDef.listKey);
      return { count: items.length, items };
    } catch (e) {
      lastErr = e;
      // Повторяем только то, что может пройти со второй попытки.
      const retriable = isNetworkError(e) || (e && e.status >= 500) || (e && e.status === 429);
      if (!retriable || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw new Error(serviceForbidden(svcDef, lastErr) || serviceError(lastErr, base, svcDef.listPath));
}

// Дашборд: все сервисы разом (каждый независимо). Возвращает массив
// { key, title, icon, ok, count, error }.
async function resourcesStatus(oauthToken, folderId, opts) {
  // Раньше все 13 сервисов опрашивались залпом: поодиночке каждый отвечает,
  // а вместе — таймауты. Идём небольшими пачками (по умолчанию 3).
  // Таймаут для дашборда короткий и без повторов: карточка со сбоем лучше, чем
  // минуты ожидания (серийный вызов может позволить себе 25 с и 2 попытки).
  const o = Object.assign({ timeoutMs: 12000, retries: 1 }, opts || {});
  const batch = Math.max(1, Math.min(parseInt(o.batch, 10) || 3, SERVICES.length));
  await getIamToken(oauthToken); // обмен токена — один раз до опроса
  const out = [];
  for (let i = 0; i < SERVICES.length; i += batch) {
    const chunk = SERVICES.slice(i, i + batch);
    const res = await Promise.all(
      chunk.map(async (svcDef) => {
        try {
          const r = await listService(oauthToken, folderId, svcDef, o);
          return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: true, count: r.count, items: r.items, error: "" };
        } catch (e) {
          return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: false, count: 0, items: [], error: (e && e.message) || String(e) };
        }
      })
    );
    out.push(...res);
  }
  return out;
}

// ── Создание и удаление ресурсов ────────────────────────────────────────────
// Какие сервисы можно создать из приложения (простые ресурсы с минимумом полей).
const CREATABLE = {
  ydb: {
    path: "/ydb/v1/databases",
    body: (folderId, name) => ({ folderId, name, serverlessDatabase: {} }),
    hint: "Serverless-база: оплата только за реальные запросы/хранилище",
  },
  lockbox: {
    path: "/lockbox/v1/secrets",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Хранилище секретов (ключи, пароли, токены)",
  },
  containerRegistry: {
    path: "/container-registry/v1/registries",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Реестр Docker-образов для Serverless Containers",
  },
  storage: {
    path: "/storage/v1/buckets",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Бакет Object Storage для файлов и статики",
  },
  dns: {
    path: "/dns/v1/zones",
    body: (folderId, name) => ({ folderId, zone: name.replace(/\.$/, "") + ".", publicVisibility: {} }),
    hint: "Публичная DNS-зона (например example.com)",
  },
  serverlessContainers: {
    path: "/containers/v1/containers",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Контейнер для запуска приложения (образ деплоится отдельно)",
  },
  vpc: {
    path: "/vpc/v1/networks",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Виртуальная сеть с подсетями",
  },
};

function creatableKeys() {
  return Object.keys(CREATABLE);
}

// Создать ресурс. Возвращает { ok, resourceId, name, message }.
async function createResource(oauthToken, folderId, serviceKey, name) {
  const svcDef = serviceByKey(serviceKey);
  const maker = CREATABLE[serviceKey];
  if (!svcDef || !maker) throw new Error("Создание «" + (serviceKey || "?") + "» из приложения пока не поддерживается — создай в консоли Yandex Cloud.");
  const nm = String(name || "").trim();
  if (!nm) throw new Error("Укажи имя ресурса.");
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(nm)) {
    throw new Error("Имя может содержать только латиницу, цифры и дефис (2–63 символа), начинаться и заканчиваться буквой/цифрой.");
  }
  const token = await getIamToken(oauthToken);
  const base = await endpoint(svcDef.svc) || KNOWN_ENDPOINTS[svcDef.svc];
  const j = await fetchJson(base + maker.path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(maker.body(folderId, nm)),
  }, 30000);
  const op = await waitOperation(oauthToken, j && j.id, 180000);
  // id созданного ресурса, а не операции: в облаке это разные вещи, и откат
  // с удалением по id операции не находит ничего.
  const resourceId = (op && op.response && op.response.id) || (j && j.id) || "";
  return { ok: true, resourceId, name: nm, message: "Ресурс «" + nm + "» создан (операция завершена)." };
}

// Удалить ресурс по id. DELETE <base><listPath>/<id>.
async function deleteResource(oauthToken, serviceKey, resourceId) {
  const svcDef = serviceByKey(serviceKey);
  if (!svcDef) throw new Error("Неизвестный сервис: " + serviceKey);
  const id = String(resourceId || "").trim();
  if (!id) throw new Error("Не указан id ресурса.");
  const token = await getIamToken(oauthToken);
  const base = await endpoint(svcDef.svc) || KNOWN_ENDPOINTS[svcDef.svc];
  const j = await fetchJson(base + svcDef.listPath + "/" + encodeURIComponent(id), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token },
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return { ok: true, message: "Ресурс удалён." };
}

// Ожидание завершения операции (поллинг каждые 2 сек).
async function waitOperation(oauthToken, operationId, timeoutMs) {
  if (!operationId) return;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("operation") || KNOWN_ENDPOINTS.operation;
  const deadline = Date.now() + (timeoutMs || 180000);
  let lastMsg = "";
  let first = true;
  while (Date.now() < deadline) {
    // Первая проверка — сразу: операция создания/удаления нередко уже завершена,
    // а сон до неё добавлял гарантированные 2 секунды к каждому созданию.
    if (!first) await new Promise((r) => setTimeout(r, 2000));
    first = false;
    try {
      const j = await fetchJson(base + "/operations/" + encodeURIComponent(operationId), {
        headers: { Authorization: "Bearer " + token },
      }, 15000);
      if (j && j.done) {
        if (j.error) {
          const e = new Error("Операция завершилась ошибкой: " + ((j.error.message || "") || JSON.stringify(j.error).slice(0, 300)));
          e.status = 400;
          throw e;
        }
        // Возвращаем тело операции: у части сервисов (Lockbox, создание
        // ресурсов) id готового объекта приходит только в response.
        return j;
      }
      lastMsg = "операция ещё выполняется";
    } catch (e) {
      if (e && e.status === 404) return; // операция уже не находится — считаем завершённой
      lastMsg = (e && e.message) || String(e);
    }
  }
  throw new Error("Операция не завершилась за отведённое время (" + Math.round(timeoutMs / 1000) + " с). Проверь результат в консоли Yandex Cloud: " + lastMsg);
}

// ── Тест подключения: токен валиден? Есть ли каталог? ───────────────────────
async function testAuth(oauthToken, folderId) {
  const clouds = await listClouds(oauthToken);
  const folders = await listFolders(oauthToken, clouds[0] && clouds[0].id);
  let folderOk = false;
  if (folderId) {
    try {
      await getIamToken(oauthToken);
      folderOk = true;
    } catch {}
  }
  return { clouds, folders, folderOk };
}

// ── Деплой-конвейер: папка проекта → Serverless Containers ───────────────────
// Шаги (порядок задаёт src/deploy-engine.js, здесь — только REST-части):
//   ensureRegistry → docker build/push (CLI) → ensureContainer →
//   setContainerPublicAccess (allUsers → invoker) → deployContainerRevision → url.

function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
}

async function findRegistry(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/registries?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const regs = Array.isArray(j && j.registries) ? j.registries : [];
  return regs.find((r) => r.name === name) || null;
}

async function ensureRegistry(oauthToken, folderId, name) {
  const existing = await findRegistry(oauthToken, folderId, name);
  if (existing) return existing;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/registries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ folderId, name }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return findRegistry(oauthToken, folderId, name);
}

async function findContainer(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("serverless-containers") || KNOWN_ENDPOINTS["serverless-containers"];
  const j = await fetchJson(base + "/containers/v1/containers?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.containers) ? j.containers : [];
  return list.find((c) => c.name === name) || null;
}

async function ensureContainer(oauthToken, folderId, name) {
  const existing = await findContainer(oauthToken, folderId, name);
  if (existing) return existing;
  const r = await createResource(oauthToken, folderId, "serverlessContainers", name);
  return findContainer(oauthToken, folderId, name);
}

// ── Serverless Containers: глубокий слой (обзор → редактор → ревизии) ───────
// Раньше здесь был только Container.Get из трёх полей, поэтому «зайти внутрь»
// контейнера агент не мог. Консоль YC работает так: «Обзор» = Container.Get,
// «Редактор» = настройки последней ревизии (ListRevisions/GetRevision) плюс
// Container.Update, «Создать ревизию» = DeployRevision с префиллом из текущей
// ревизии, «Ревизии» = список с откатом (Container.Rollback). Методы и поля
// сверены по REST-справочнику:
//   GET   /containers/v1/containers/{containerId}
//   PATCH /containers/v1/containers/{containerId}          { updateMask, name, description, labels }
//   POST  /containers/v1/containers/{containerId}:rollback { revisionId }
//   GET   /containers/v1/revisions?containerId=…&filter=…
//   GET   /containers/v1/revisions/{containerRevisionId}
//   POST  /containers/v1/revisions:deploy
// Замечание по API: ревизию удалить нельзя (в сервисе нет DeleteRevision) —
// «переключить» контейнер можно только откатом на другую ревизию.
async function scBase(oauthToken) {
  return (await endpoint("serverless-containers")) || KNOWN_ENDPOINTS["serverless-containers"];
}

// Полный объект контейнера: id, folderId, createdAt, name, description, labels,
// url, status (CREATING | ACTIVE | DELETING | ERROR).
async function getContainer(oauthToken, containerId) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return j || {};
}

// Краткая карточка контейнера (совместима с прежним containerInfo).
async function containerInfo(oauthToken, containerId) {
  const c = await getContainer(oauthToken, containerId);
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    status: c.status,
    description: c.description || "",
    labels: c.labels || {},
    folderId: c.folderId || "",
    createdAt: c.createdAt || "",
  };
}

// ── Публичный доступ к контейнеру ──────────────────────────────────────────
// Публичным контейнер делает привязка роли invoker субъекту «все пользователи»
// ({ id: "allUsers", type: "system" }) НА САМ КОНТЕЙНЕР. Роль, выданная
// сервисному аккаунту или на каталог, доступа из интернета не даёт: адрес
// контейнера отвечает 403, и деплой справедливо падает на проверке после
// выката, хотя все предыдущие стадии прошли. Сверено с документацией
// (serverless-containers/operations/container-public).
const PUBLIC_INVOKER_SUBJECT = { id: "allUsers", type: "system" };
const CONTAINER_INVOKER_ROLE = "serverless.containers.invoker";

// id роли в ответах встречается в двух формах: serverless.containers.invoker и
// serverless-containers.containerInvoker. Сравниваем по «скелету», иначе
// готовая привязка не распознаётся и мы добавили бы её второй раз.
function isInvokerRole(roleId) {
  const s = String(roleId || "")
    .toLowerCase()
    .replace(/[\s._-]/g, "");
  return s === "serverlesscontainersinvoker" || s === "serverlesscontainerscontainerinvoker";
}

// Права контейнера в читаемом виде.
async function listContainerAccessBindings(oauthToken, containerId) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id) + ":listAccessBindings", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.accessBindings) ? j.accessBindings : [];
  return list.map((b) => {
    const subj = (b && b.subject) || {};
    return { roleId: (b && b.roleId) || "", subjectId: subj.id || "", subjectType: subj.type || "" };
  });
}

function hasPublicInvoker(bindings) {
  return (bindings || []).some(
    (b) => isInvokerRole(b.roleId) && b.subjectId === PUBLIC_INVOKER_SUBJECT.id && b.subjectType === PUBLIC_INVOKER_SUBJECT.type
  );
}

// Сделать контейнер вызываемым из интернета. Добавляем одну привязку (delta ADD),
// а не заменяем весь список: чужие роли на контейнере остаются на месте. Если
// привязка уже есть — ничего не делаем, и это не ошибка.
async function setContainerPublicAccess(oauthToken, containerId) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const before = await listContainerAccessBindings(oauthToken, id);
  if (hasPublicInvoker(before)) return { ok: true, already: true, bindings: before };
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id) + ":updateAccessBindings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      accessBindingDeltas: [
        { action: "ADD", accessBinding: { roleId: CONTAINER_INVOKER_ROLE, subject: PUBLIC_INVOKER_SUBJECT } },
      ],
    }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  // Проверяем результат, а не факт отправки запроса: без привязки контейнер
  // останется закрытым, и узнать об этом лучше здесь, а не на проверке адреса.
  const after = await listContainerAccessBindings(oauthToken, id);
  if (!hasPublicInvoker(after)) {
    const e = new Error(
      "Права контейнера не изменились: привязка «все пользователи → " +
        CONTAINER_INVOKER_ROLE +
        "» не появилась. Нужна роль с правом serverless-containers.containers.setAccessBindings (её даёт editor на каталог)."
    );
    e.status = 403;
    throw e;
  }
  return { ok: true, already: false, bindings: after };
}

// Редактор контейнера: имя, описание, метки. updateMask перечисляет ТОЛЬКО те
// поля, которые реально меняем: без него сервис сбросил бы остальные поля в
// значения по умолчанию, то есть правка меток стирала бы описание.
async function updateContainer(oauthToken, containerId, patch) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const p = patch || {};
  const body = {};
  const mask = [];
  if (p.name != null) { body.name = String(p.name).trim(); mask.push("name"); }
  if (p.description != null) { body.description = String(p.description).slice(0, 256); mask.push("description"); }
  if (p.labels != null) {
    const labels = {};
    for (const k of Object.keys(p.labels || {})) labels[String(k)] = String(p.labels[k]);
    body.labels = labels;
    mask.push("labels");
  }
  if (!mask.length) throw new Error("Нечего менять: укажи name, description или labels.");
  body.updateMask = mask.join(",");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return getContainer(oauthToken, id);
}

// Ревизии контейнера (или всего каталога). От свежих к старым.
// filter: только по полям Revision.status и Revision.runtime, например status="ACTIVE".
async function listRevisions(oauthToken, opts) {
  const o = opts || {};
  const containerId = String(o.containerId || "").trim();
  const folderId = String(o.folderId || "").trim();
  if (!containerId && !folderId) throw new Error("Нужен containerId или folderId.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const q = new URLSearchParams();
  if (containerId) q.set("containerId", containerId);
  else q.set("folderId", folderId);
  q.set("pageSize", String(Math.min(Math.max(parseInt(o.pageSize, 10) || 100, 1), 1000)));
  if (o.filter) q.set("filter", String(o.filter));
  const j = await fetchJson(base + "/containers/v1/revisions?" + q.toString(), {
    headers: { Authorization: "Bearer " + token },
  }, 25000);
  return Array.isArray(j && j.revisions) ? j.revisions : [];
}

async function getRevision(oauthToken, revisionId) {
  const id = String(revisionId || "").trim();
  if (!id) throw new Error("Не указан id ревизии.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/revisions/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return j || {};
}

// Откат контейнера на выбранную ревизию (в консоли — «сделать активной»).
async function rollbackContainer(oauthToken, containerId, revisionId) {
  const cid = String(containerId || "").trim();
  const rid = String(revisionId || "").trim();
  if (!cid || !rid) throw new Error("Нужны containerId и revisionId (список ревизий — action: revisions).");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(cid) + ":rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ revisionId: rid }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 180000);
  return true;
}

// Длительность вида "30s" → 30 (секунды).
function parseDurationSec(d) {
  const m = /^([0-9.]+)s$/.exec(String(d || ""));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Сводка ревизии — ровно то, что показывает «Редактор» в консоли, в нормальном
// виде (байты → МБ, длительность → секунды), чтобы агент не пересчитывал в уме.
function revisionSummary(rev) {
  const r = rev || {};
  const img = r.image || {};
  const res = r.resources || {};
  const mem = parseInt(res.memory, 10);
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  return {
    id: r.id || "",
    containerId: r.containerId || "",
    status: r.status || "",
    createdAt: r.createdAt || "",
    description: r.description || "",
    image: img.imageUrl || "",
    imageDigest: img.imageDigest || "",
    command: (img.command && img.command.command) || [],
    args: (img.args && img.args.args) || [],
    workingDir: img.workingDir || "",
    env: img.environment || {},
    memoryMb: Number.isFinite(mem) ? Math.round(mem / 1024 / 1024) : null,
    cores: num(res.cores),
    coreFraction: num(res.coreFraction),
    timeoutSec: parseDurationSec(r.executionTimeout),
    concurrency: num(r.concurrency),
    serviceAccountId: r.serviceAccountId || "",
    networkId: (r.connectivity && r.connectivity.networkId) || "",
    minInstances: (r.provisionPolicy && num(r.provisionPolicy.minInstances)) || 0,
    secrets: Array.isArray(r.secrets)
      ? r.secrets.map((s) => ({ id: s.id || "", versionId: s.versionId || "", key: s.key || "", environmentVariable: s.environmentVariable || "" }))
      : [],
    logGroupId: (r.logOptions && r.logOptions.logGroupId) || "",
    logDisabled: !!(r.logOptions && r.logOptions.disabled),
    logMinLevel: (r.logOptions && r.logOptions.minLevel) || "",
    maxInstancesPerZone: (r.scalingPolicy && num(r.scalingPolicy.zoneInstancesLimit)) || 0,
    maxRequestsPerZone: (r.scalingPolicy && num(r.scalingPolicy.zoneRequestsLimit)) || 0,
    runtime: r.runtime && r.runtime.task ? "task" : "http",
    mounts: Array.isArray(r.mounts)
      ? r.mounts.map((m) => ({ path: m.mountPointPath || "", mode: m.mode || "", bucketId: (m.objectStorage && m.objectStorage.bucketId) || "" }))
      : [],
    storageMounts: Array.isArray(r.storageMounts)
      ? r.storageMounts.map((m) => ({ bucketId: m.bucketId || "", prefix: m.prefix || "", path: m.mountPointPath || "", readOnly: !!m.readOnly }))
      : [],
  };
}

// «Создать ревизию» как в консоли: настройки берутся из последней ревизии, а то,
// что передали явно — их переопределяет. Переменные окружения ДОБАВЛЯЮТСЯ к
// прежним (envReplace: true — заменить набор целиком).
function revisionToDeployOpts(rev, overrides) {
  const s = revisionSummary(rev);
  const o = overrides || {};
  const pick = (v, d) => (v == null || v === "" ? d : v);
  return {
    imageUrl: pick(o.imageUrl, s.image),
    memoryMb: pick(o.memoryMb, s.memoryMb || 256),
    cores: pick(o.cores, s.cores || 1),
    coreFraction: pick(o.coreFraction, s.coreFraction || 100),
    timeoutSec: pick(o.timeoutSec, s.timeoutSec || 30),
    concurrency: pick(o.concurrency, s.concurrency || 1),
    serviceAccountId: pick(o.serviceAccountId, s.serviceAccountId),
    networkId: pick(o.networkId, s.networkId),
    minInstances: pick(o.minInstances, s.minInstances || 0),
    env: o.envReplace === true ? (o.env || {}) : Object.assign({}, s.env, o.env || {}),
    command: o.command != null ? o.command : s.command,
    args: o.args != null ? o.args : s.args,
    workingDir: pick(o.workingDir, s.workingDir),
    secrets: o.secrets != null ? o.secrets : s.secrets,
    runtime: pick(o.runtime, s.runtime || "http"),
    maxInstancesPerZone: pick(o.maxInstancesPerZone, s.maxInstancesPerZone || 0),
    maxRequestsPerZone: pick(o.maxRequestsPerZone, s.maxRequestsPerZone || 0),
    logGroupId: pick(o.logGroupId, s.logGroupId),
    logDisabled: o.logDisabled != null ? !!o.logDisabled : s.logDisabled,
    logMinLevel: pick(o.logMinLevel, s.logMinLevel),
    mounts: o.mounts != null ? o.mounts : s.mounts,
    storageMounts: o.storageMounts != null ? o.storageMounts : s.storageMounts,
    description: o.description,
    folderId: o.folderId,
  };
}

// Деплой ревизии контейнера (POST /containers/v1/revisions:deploy).
// opts: { containerId, folderId, imageUrl, description?, serviceAccountId?, memoryMb?,
//   cores?, coreFraction?, timeoutSec?, concurrency?, env?, command?, args?, workingDir?,
//   networkId?, minInstances?, secrets?, logOptions?, scalingPolicy?, storageMounts?,
//   mounts?, runtime?, asyncInvocationServiceAccountId? }
async function deployContainerRevision(oauthToken, opts) {
  const o = opts || {};
  const containerId = String(o.containerId || "").trim();
  if (!containerId) throw new Error("Не указан containerId — для какого контейнера создавать ревизию.");
  const imageUrl = String(o.imageUrl || "").trim();
  if (!imageUrl) throw new Error("Не указан образ (imageUrl) для ревизии, например cr.yandex/<registry-id>/<image>:latest.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const memoryMb = Math.max(128, Math.min(parseInt(o.memoryMb, 10) || 256, 8192));
  const cores = Math.min(Math.max(parseInt(o.cores, 10) || 1, 1), 4);
  // Доля ядра: у многоядерных ревизий сервис принимает только 100%.
  const coreFraction = cores > 1 ? 100 : Math.min(Math.max(parseInt(o.coreFraction, 10) || 100, 5), 100);
  const timeoutSec = Math.min(Math.max(parseInt(o.timeoutSec, 10) || 30, 1), 600);
  const body = {
    containerId,
    description: String(o.description || "deploy " + new Date().toISOString()).slice(0, 256),
    resources: { memory: String(memoryMb * 1024 * 1024), cores: String(cores), coreFraction: String(coreFraction) },
    executionTimeout: timeoutSec + "s",
    imageSpec: { imageUrl, environment: o.env || {} },
    concurrency: String(Math.max(parseInt(o.concurrency, 10) || 1, 1)),
  };
  if (Array.isArray(o.command) && o.command.length) body.imageSpec.command = { command: o.command.map(String) };
  if (Array.isArray(o.args) && o.args.length) body.imageSpec.args = { args: o.args.map(String) };
  if (o.workingDir) body.imageSpec.workingDir = String(o.workingDir);
  if (o.serviceAccountId) body.serviceAccountId = String(o.serviceAccountId);
  // Сеть: без неё ревизия не видит ни VPC, ни управляемые базы.
  if (o.networkId) body.connectivity = { networkId: String(o.networkId) };
  const minInst = parseInt(o.minInstances, 10) || 0;
  if (minInst > 0) body.provisionPolicy = { minInstances: String(minInst) };
  if (Array.isArray(o.secrets) && o.secrets.length) {
    body.secrets = o.secrets
      .map((s) => {
        if (!s || !s.id || !s.key || !s.environmentVariable) return null;
        const out = { id: String(s.id), key: String(s.key), environmentVariable: String(s.environmentVariable) };
        if (s.versionId) out.versionId = String(s.versionId);
        return out;
      })
      .filter(Boolean);
  }
  const logOpts = {};
  if (o.logDisabled) logOpts.disabled = true;
  if (o.logGroupId) logOpts.logGroupId = String(o.logGroupId);
  else if (o.folderId) logOpts.folderId = String(o.folderId);
  if (o.logMinLevel) logOpts.minLevel = String(o.logMinLevel).toUpperCase();
  if (Object.keys(logOpts).length) body.logOptions = logOpts;
  const zoneInst = parseInt(o.maxInstancesPerZone, 10) || 0;
  const zoneReq = parseInt(o.maxRequestsPerZone, 10) || 0;
  if (zoneInst || zoneReq) {
    body.scalingPolicy = { zoneInstancesLimit: String(zoneInst), zoneRequestsLimit: String(zoneReq) };
  }
  if (Array.isArray(o.storageMounts) && o.storageMounts.length) {
    body.storageMounts = o.storageMounts
      .filter((m) => m && m.bucketId && m.mountPointPath)
      .map((m) => ({ bucketId: String(m.bucketId), prefix: String(m.prefix || ""), readOnly: !!m.readOnly, mountPointPath: String(m.mountPointPath) }));
  }
  if (Array.isArray(o.mounts) && o.mounts.length) {
    body.mounts = o.mounts
      .filter((m) => m && m.mountPointPath && m.bucketId)
      .map((m) => ({
        mountPointPath: String(m.mountPointPath),
        mode: String(m.mode || "READ_ONLY").toUpperCase() === "READ_WRITE" ? "READ_WRITE" : "READ_ONLY",
        objectStorage: { bucketId: String(m.bucketId), prefix: String(m.prefix || "") },
      }));
  }
  // Режим task: процесс из ENTRYPOINT запускается на каждый запрос (иначе http-сервер).
  if (String(o.runtime || "").toLowerCase() === "task") body.runtime = { task: {} };
  if (o.asyncInvocationServiceAccountId) {
    body.asyncInvocationConfig = { serviceAccountId: String(o.asyncInvocationServiceAccountId) };
  }
  const j = await fetchJson(base + "/containers/v1/revisions:deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 240000);
  return j;
}

// ── Сервисный аккаунт + роль на каталог (для публичного вызова контейнера) ──
async function findServiceAccount(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("iam") || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/serviceAccounts?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.serviceAccounts) ? j.serviceAccounts : [];
  return list.find((s) => s.name === name) || null;
}

async function ensureServiceAccount(oauthToken, folderId, name) {
  const existing = await findServiceAccount(oauthToken, folderId, name);
  if (existing) return existing;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("iam") || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/serviceAccounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ folderId, name, description: "Создан приложением NestDev для Serverless Containers" }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return findServiceAccount(oauthToken, folderId, name);
}

// Добавить роль субъекту НА каталог (delta ADD — остальные роли не трогает).
async function addRoleOnFolder(oauthToken, folderId, saId, roleId) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("resource-manager") || KNOWN_ENDPOINTS["resource-manager"];
  const j = await fetchJson(base + "/resource-manager/v1/folders/" + encodeURIComponent(folderId) + ":updateAccessBindings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      accessBindingDeltas: [
        { action: "ADD", accessBinding: { roleId, subject: { id: saId, type: "serviceAccount" } } },
      ],
    }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return true;
}

// ── Cloud DNS: записи зоны ──────────────────────────────────────────────────
// Сверено с документацией: dns/api-ref/DnsZone/updateRecordSets. Метод СТРОГИЙ:
// удаление несуществующей записи — ошибка, добавление поверх уже существующей
// пары «имя+тип» — тоже ошибка. Поэтому «поставить значение» сделано как
// чтение зоны → удаление прежнего набора → добавление нового: иначе второй
// такой вызов по тому же имени падал бы с «record already exists».
async function dnsBase(oauthToken) {
  return (await endpoint("dns")) || KNOWN_ENDPOINTS.dns;
}

// Одна запись в том виде, в каком её ждёт API: ttl — строка секунд (int64),
// data — непустой массив строк. Имя зоны в Cloud DNS — FQDN с точкой на конце,
// поэтому точку добавляем сами: без неё API отвечает ошибкой валидации.
function normalizeRecordSet(v) {
  const o = v || {};
  let name = String(o.name == null ? "" : o.name).trim();
  if (name && name !== "." && name.slice(-1) !== ".") name += ".";
  // Значения называют по-разному: в API это data, человек и агент говорят
  // «value» и «values». Принимаем все три, чтобы запись не теряла значения
  // на ровном месте (и не падала «нет значений» там, где значение передали).
  const src = o.data != null ? o.data : o.values != null ? o.values : o.value;
  const raw = Array.isArray(src) ? src : src == null || src === "" ? [] : [src];
  const data = raw.map((d) => String(d == null ? "" : d).trim()).filter(Boolean);
  const ttlNum = parseInt(o.ttl, 10);
  return {
    name: name,
    type: String(o.type == null ? "" : o.type).trim().toUpperCase(),
    ttl: String(ttlNum > 0 ? ttlNum : 600),
    data: data,
    description: o.description == null ? "" : String(o.description),
  };
}

async function listRecordSets(oauthToken, zoneId) {
  const id = String(zoneId || "").trim();
  if (!id) throw new Error("Не указан id DNS-зоны.");
  const token = await getIamToken(oauthToken);
  const base = await dnsBase(oauthToken);
  const path = "/dns/v1/zones/" + encodeURIComponent(id) + ":getRecordSets";
  let j = null;
  try {
    j = await fetchJson(base + path, { headers: { Authorization: "Bearer " + token } }, 20000);
  } catch (e) {
    // Часть шлюзов принимает только POST (в proto у метода есть и POST-привязка) —
    // это тот же случай, что в консоли панели: пробуем вторую форму, а не гадаем.
    j = await fetchJson(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: "{}",
    }, 20000);
  }
  return pickList(j, "recordSets").map(normalizeRecordSet).filter((r) => r.name && r.type);
}

// Одна операция изменения: deletions применяются первыми, additions — после.
async function updateRecordSets(oauthToken, zoneId, body) {
  const id = String(zoneId || "").trim();
  if (!id) throw new Error("Не указан id DNS-зоны.");
  const deletions = ((body && body.deletions) || []).map(normalizeRecordSet);
  const additions = ((body && body.additions) || []).map(normalizeRecordSet);
  if (!deletions.length && !additions.length) throw new Error("Нечего менять: список записей пуст.");
  const token = await getIamToken(oauthToken);
  const base = await dnsBase(oauthToken);
  const j = await fetchJson(base + "/dns/v1/zones/" + encodeURIComponent(id) + ":updateRecordSets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ deletions: deletions, additions: additions }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return true;
}

// Поставить значения для пары «имя+тип»: есть — заменяем, нет — добавляем.
async function upsertRecordSet(oauthToken, zoneId, rec) {
  const want = normalizeRecordSet(rec);
  if (!want.name || want.name === ".") throw new Error("У записи нужно имя: вершина зоны — само имя зоны (example.com.), поддомен — www.example.com.");
  if (!want.type) throw new Error("У записи нужен тип: A, AAAA, CNAME, TXT, MX, NS, SRV…");
  if (!want.data.length) throw new Error("У записи нет значений: для A это IP, для CNAME — домен, для TXT — текст.");
  const existing = (await listRecordSets(oauthToken, zoneId)).find((r) => r.name === want.name && r.type === want.type) || null;
  await updateRecordSets(oauthToken, zoneId, { deletions: existing ? [existing] : [], additions: [want] });
  return { name: want.name, type: want.type, ttl: want.ttl, values: want.data.length, replaced: !!existing };
}

// Удалить ВЕСЬ набор значений пары «имя+тип» (строгий API требует точного
// совпадения, поэтому удаляем ровно то, что лежит в зоне).
async function deleteRecordSet(oauthToken, zoneId, opts) {
  const o = opts || {};
  const name = normalizeRecordSet({ name: o.name }).name;
  const type = String(o.type == null ? "" : o.type).trim().toUpperCase();
  if (!name || name === "." || !type) throw new Error("Для удаления нужны имя и тип записи.");
  const existing = (await listRecordSets(oauthToken, zoneId)).find((r) => r.name === name && r.type === type) || null;
  if (!existing) throw new Error("В зоне нет записи " + name + " " + type + " — удалять нечего.");
  await updateRecordSets(oauthToken, zoneId, { deletions: [existing], additions: [] });
  return { name: name, type: type, values: existing.data.length };
}

// ── Lockbox: секреты приложения ─────────────────────────────────────────────
// Зачем: значения секретов не должны ехать через модель и не должны лежать
// в образе открытым текстом (imageSpec.environment). Секрет живёт в Lockbox, а
// ревизия получает только ссылку { id, key, environmentVariable } — значение
// подставляет само облако. Ревизии для этого нужен сервисный аккаунт с ролью
// lockbox.payloadViewer НА СЕКРЕТ (не на каталог — так меньше прав).
// Сверено с документацией: serverless-containers/operations/lockbox-secret-transmit,
// lockbox/api-ref/Secret/addVersion.

async function lockboxBase(oauthToken) {
  return (await endpoint("lockbox")) || KNOWN_ENDPOINTS.lockbox;
}

async function listSecrets(oauthToken, folderId) {
  const token = await getIamToken(oauthToken);
  const base = await lockboxBase(oauthToken);
  const j = await fetchJson(base + "/lockbox/v1/secrets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 25000);
  return Array.isArray(j && j.secrets) ? j.secrets : [];
}

async function findSecret(oauthToken, folderId, name) {
  const list = await listSecrets(oauthToken, folderId);
  return list.find((s) => s && s.name === name) || null;
}

// Секрет приложения: есть — отдаём его, нет — создаём. Повторные деплои не
// плодят новые секреты, а добавляют в тот же новую версию.
async function ensureLockboxSecret(oauthToken, folderId, name) {
  const nm = String(name || "").trim();
  if (!nm) throw new Error("Не указано имя секрета Lockbox.");
  const existing = await findSecret(oauthToken, folderId, nm);
  if (existing) return existing;
  await createResource(oauthToken, folderId, "lockbox", nm);
  const after = await findSecret(oauthToken, folderId, nm);
  if (!after) throw new Error("Секрет «" + nm + "» создан, но не найден в каталоге — проверь права на Lockbox.");
  return after;
}

async function getSecret(oauthToken, secretId) {
  const id = String(secretId || "").trim();
  if (!id) throw new Error("Не указан id секрета Lockbox.");
  const token = await getIamToken(oauthToken);
  const base = await lockboxBase(oauthToken);
  const j = await fetchJson(base + "/lockbox/v1/secrets/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return j || {};
}

async function listSecretVersions(oauthToken, secretId) {
  const id = String(secretId || "").trim();
  if (!id) throw new Error("Не указан id секрета Lockbox.");
  const token = await getIamToken(oauthToken);
  const base = await lockboxBase(oauthToken);
  const j = await fetchJson(base + "/lockbox/v1/secrets/" + encodeURIComponent(id) + "/versions?pageSize=100", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.versions) ? j.versions : [];
  return list
    .slice()
    .sort((a, b) => String((b && b.createdAt) || "").localeCompare(String((a && a.createdAt) || "")));
}

// Пары «ключ → значение» принимаем в обоих видах, в которых они приходят:
// списком объектов (форма в панели облака) и обычным объектом (так пишет модель).
function normalizeSecretEntries(v) {
  const out = [];
  if (Array.isArray(v)) {
    for (const e of v) {
      if (!e || typeof e !== "object") continue;
      const key = String(e.key == null ? "" : e.key).trim();
      if (!key) continue;
      out.push({ key: key, value: e.value == null ? "" : String(e.value) });
    }
    return out;
  }
  if (v && typeof v === "object") {
    for (const key of Object.keys(v)) {
      const k = String(key).trim();
      if (!k) continue;
      out.push({ key: k, value: v[key] == null ? "" : String(v[key]) });
    }
  }
  return out;
}
// Новая версия секрета со значениями. Значения НЕ возвращаются и НЕ попадают
// ни в отчёт, ни в состояние: наружу уходят только ключи и id версии.
async function putSecretVersion(oauthToken, secretId, entries) {
  const id = String(secretId || "").trim();
  if (!id) throw new Error("Не указан id секрета Lockbox.");
  const list = normalizeSecretEntries(entries).map((e) => ({ key: e.key, textValue: e.value }));
  if (!list.length) throw new Error("Нет ни одной пары «ключ → значение» для версии секрета.");
  const bad = list.find((e) => !/^[-_./\\@0-9a-zA-Z]+$/.test(e.key));
  if (bad) throw new Error("Ключ «" + bad.key + "» не годится для Lockbox: допустимы латиница, цифры и знаки - _ . / \\ @.");
  const token = await getIamToken(oauthToken);
  const base = await lockboxBase(oauthToken);
  const j = await fetchJson(base + "/lockbox/v1/secrets/" + encodeURIComponent(id) + ":addVersion", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ description: "deploy " + new Date().toISOString(), payloadEntries: list }),
  }, 30000);
  const op = await waitOperation(oauthToken, j && j.id, 120000);
  let versionId = (op && op.response && op.response.id) || "";
  if (!versionId) {
    const versions = await listSecretVersions(oauthToken, id);
    versionId = (versions[0] && versions[0].id) || "";
  }
  return { versionId, keys: list.map((e) => e.key) };
}

// Права на секрет — сервисному аккаунту ревизии и только на этот секрет.
async function grantSecretAccess(oauthToken, secretId, serviceAccountId, roleId) {
  const id = String(secretId || "").trim();
  const saId = String(serviceAccountId || "").trim();
  if (!id) throw new Error("Не указан id секрета Lockbox.");
  if (!saId) throw new Error("Не указан сервисный аккаунт, которому выдаём доступ к секрету.");
  const token = await getIamToken(oauthToken);
  const base = await lockboxBase(oauthToken);
  const j = await fetchJson(base + "/lockbox/v1/secrets/" + encodeURIComponent(id) + ":updateAccessBindings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      accessBindingDeltas: [
        { action: "ADD", accessBinding: { roleId: roleId || "lockbox.payloadViewer", subject: { id: saId, type: "serviceAccount" } } },
      ],
    }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return true;
}

// ── Образы реестра: нужны уборке ────────────────────────────────────────────
// Реестр в облаке не удаляется, пока в нём есть образы, а тестовый прогон
// обязан убрать за собой всё.
async function listRegistryImages(oauthToken, registryId) {
  const id = String(registryId || "").trim();
  if (!id) throw new Error("Не указан id реестра.");
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/images?registryId=" + encodeURIComponent(id) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 25000);
  return Array.isArray(j && j.images) ? j.images : [];
}

// Найти образ по id, тегу или digest. Нужно и панели, и агенту: человек называет
// образ тегом («удали app:v1.2»), а Delete принимает ровно id образа.
async function findRegistryImage(oauthToken, registryId, ref) {
  const want = String(ref || "").trim();
  if (!want) return null;
  const images = await listRegistryImages(oauthToken, registryId);
  return (
    images.find((i) => i && i.id === want) ||
    images.find((i) => i && Array.isArray(i.tags) && i.tags.indexOf(want) >= 0) ||
    images.find((i) => i && i.digest === want) ||
    null
  );
}

async function deleteRegistryImage(oauthToken, imageId) {
  const id = String(imageId || "").trim();
  if (!id) throw new Error("Не указан id образа.");
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/images/" + encodeURIComponent(id), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token },
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return true;
}

// ── Object Storage: объекты бакета (S3-совместимый API) ─────────────────────
// Бакет в приложении было чем СОЗДАТЬ, а положить в него файл — нечем: список
// бакетов читался, а сами объекты не открывались нигде, кроме консоли облака.
// Между тем бакет и создаётся «для файлов и статики»: без объектов это пустая
// полка. Объекты живут в S3-совместимом API (storage.yandexcloud.net), и его
// главная особенность — авторизация IAM-токеном работает БЕЗ подписи запроса
// (Authorization: Bearer <IAM>), ровно как у остальных сервисов каталога.
// Поэтому ни статический ключ доступа, ни подпись AWS здесь не нужны.
//
// Ответы этого API — XML (JSON-варианта у S3 нет), поэтому разбор здесь свой и
// намеренно маленький: списку объектов нужны четыре поля.
const S3_OBJECTS_LIMIT = 1000; // столько ключей просим у API за раз
const S3_MAX_BYTES = 64 * 1024 * 1024; // столько кладём и забираем одним запросом

async function s3Base() {
  return (await endpoint("storage-s3")) || KNOWN_ENDPOINTS["storage-s3"];
}

// Раскодировать текст XML. Значения приходят экранированными (&amp; и т.п.),
// а ключ объекта — это имя файла пользователя, его нельзя показывать как есть.
function xmlText(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml, tag) {
  const m = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">").exec(String(xml || ""));
  return m ? xmlText(m[1]) : "";
}

// Список объектов: каждое содержимое идёт блоком <Contents>. «Папки» Object
// Storage — это тоже ключи (нулевой размер и слеш на конце), поэтому отдельной
// ветки для них нет: что API отдал, то и показываем.
function parseObjectList(xml) {
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const one = m[1];
    out.push({
      key: xmlTag(one, "Key"),
      size: Number(xmlTag(one, "Size")) || 0,
      lastModified: xmlTag(one, "LastModified"),
      etag: xmlTag(one, "ETag").replace(/^"/, "").replace(/"$/, ""),
      storageClass: xmlTag(one, "StorageClass"),
    });
  }
  return out;
}

// Ошибка S3 приходит XML-ом: вытаскиваем Code и Message и объясняем то, что
// случается чаще всего. Без этого человек видел бы «<?xml version…» целиком.
function s3Error(status, xml, where) {
  const code = xmlTag(xml, "Code") || "HTTP " + status;
  const msg = xmlTag(xml, "Message") || String(xml || "").slice(0, 200);
  const hints = {
    NoSuchBucket: "Бакета с таким именем нет в каталоге — проверь имя (ycList service storage).",
    NoSuchKey: "Такого объекта в бакете нет.",
    AccessDenied: "Нет прав: у аккаунта нет роли на этот бакет (нужна storage.viewer / storage.uploader), либо у бакета закрыт доступ по IAM-токену.",
    InvalidBucketName: "Имя бакета не годится: только латиница в нижнем регистре, цифры, дефис и точка (3–63 символа).",
    EntityTooLarge: "Файл больше допустимого для одного запроса.",
    KeyTooLong: "Слишком длинный ключ объекта (путь в бакете).",
    SignatureDoesNotMatch: "Облако не приняло подпись запроса — приложению подпись не нужна, оно ходит с IAM-токеном; похоже, запрос ушёл не на тот адрес.",
  };
  const text = hints[code] ? hints[code] + " (" + msg + ")" : code + ": " + msg;
  const e = new Error(text + (where ? " [" + where + "]" : ""));
  e.status = status;
  return e;
}

// Один запрос к S3: путь собирается из бакета и ключа, а ключ не кодируется
// целиком — иначе слеши в пути стали бы частью имени файла.
async function s3Fetch(oauthToken, opts) {
  const o = opts || {};
  const bucket = String(o.bucket || "").trim();
  if (!bucket) throw new Error("Не указан бакет.");
  const key = String(o.key == null ? "" : o.key).replace(/^\/+/, "");
  const base = await s3Base();
  const token = await getIamToken(oauthToken);
  const path = "/" + encodeURIComponent(bucket) + (key ? "/" + key.split("/").map(encodeURIComponent).join("/") : "");
  const query = o.query ? (String(o.query).indexOf("?") === 0 ? String(o.query) : "?" + o.query) : "";
  const headers = { Authorization: "Bearer " + token };
  if (o.contentType) headers["Content-Type"] = o.contentType;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 60000);
  try {
    const res = await fetch(base + path + query, {
      method: o.method || "GET",
      headers: headers,
      body: o.body,
      signal: ctrl.signal,
    });
    if (res.ok && o.raw) {
      const len = Number(res.headers.get("content-length"));
      if (isFinite(len) && len > S3_MAX_BYTES) {
        throw new Error("Объект больше " + Math.round(S3_MAX_BYTES / 1048576) + " МБ — целиком в приложение его не забрать. Возьми файл из консоли облака или сожми его.");
      }
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()), text: "", headers: res.headers };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) throw s3Error(res.status, text, hostOf(base) + path);
    return { status: res.status, body: null, text: text, headers: res.headers };
  } catch (e) {
    // Сбои «запрос не дошёл» объясняем так же, как у остальных сервисов: видно и
    // адрес, и причину (иначе отказ S3 выглядел бы как «fetch failed»).
    if (isNetworkError(e)) throw new Error(serviceError(e, base, path));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function listBucketObjects(oauthToken, opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || S3_OBJECTS_LIMIT, 1), S3_OBJECTS_LIMIT);
  const prefix = String(o.prefix || "").replace(/^\/+/, "");
  const query = "list-type=2&max-keys=" + limit + (prefix ? "&prefix=" + encodeURIComponent(prefix) : "");
  const r = await s3Fetch(oauthToken, { bucket: o.bucket, query: query });
  const items = parseObjectList(r.text);
  return {
    items: items,
    count: items.length,
    truncated: /<IsTruncated>true<\/IsTruncated>/i.test(r.text),
    prefix: prefix,
  };
}

// Тип содержимого по расширению. S3 хранит ровно то, что мы прислали, и от этого
// заголовка зависит, покажет браузер картинку или скачает файл: без него статика
// в бакете открывается «скачиванием».
const CONTENT_TYPES = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
};

function contentTypeFor(key) {
  const m = /\.([a-z0-9]+)$/i.exec(String(key || ""));
  const ext = m ? m[1].toLowerCase() : "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// Открытый адрес объекта. Работает для всех, только если у бакета разрешено
// анонимное чтение; у закрытого бакета адрес вернёт отказ — и это правда, о
// которой лучше сказать человеку, чем обещать рабочую ссылку.
function objectPublicUrl(bucket, key) {
  const b = String(bucket || "").trim();
  const k = String(key || "").replace(/^\/+/, "");
  return "https://storage.yandexcloud.net/" + b + "/" + k;
}

async function putBucketObject(oauthToken, opts) {
  const o = opts || {};
  const key = String(o.key || "").replace(/^\/+/, "");
  if (!key) throw new Error("Не указан ключ объекта (key).");
  const body = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body == null ? "" : o.body), "utf8");
  if (!body.length) {
    throw new Error("Пустое содержимое: объект нулевого размера не отправляем — в бакете появилась бы пустышка вместо файла.");
  }
  if (body.length > S3_MAX_BYTES) {
    throw new Error("Файл больше " + Math.round(S3_MAX_BYTES / 1048576) + " МБ — одним запросом такое не залить.");
  }
  const r = await s3Fetch(oauthToken, {
    method: "PUT",
    bucket: o.bucket,
    key: key,
    body: body,
    contentType: o.contentType || contentTypeFor(key),
    timeoutMs: 120000,
  });
  return {
    bucket: String(o.bucket || "").trim(),
    key: key,
    size: body.length,
    etag: String(r.headers.get("etag") || "").replace(/^"/, "").replace(/"$/, ""),
    url: objectPublicUrl(o.bucket, key),
  };
}

async function getBucketObject(oauthToken, opts) {
  const o = opts || {};
  const key = String(o.key || "").replace(/^\/+/, "");
  if (!key) throw new Error("Не указан ключ объекта (key).");
  const r = await s3Fetch(oauthToken, { bucket: o.bucket, key: key, raw: true, timeoutMs: 120000 });
  return {
    bucket: String(o.bucket || "").trim(),
    key: key,
    body: r.body,
    size: r.body.length,
    contentType: String(r.headers.get("content-type") || "") || contentTypeFor(key),
  };
}

async function deleteBucketObject(oauthToken, opts) {
  const o = opts || {};
  const key = String(o.key || "").replace(/^\/+/, "");
  if (!key) throw new Error("Не указан ключ объекта (key).");
  await s3Fetch(oauthToken, { method: "DELETE", bucket: o.bucket, key: key });
  return { bucket: String(o.bucket || "").trim(), key: key };
}

// ── Публичный доступ к бакету ──────────────────────────────────────────────
// Файл, положенный в бакет, по умолчанию виден ТОЛЬКО владельцу: открытый адрес
// storage.yandexcloud.net/<бакет>/<ключ> у другого человека вернёт отказ. Агент
// при этом честно обещает ссылку — и она не работает. Включается это не ACL, а
// флагом анонимного доступа бакета (anonymousAccessFlags) через КОНСОЛЬНЫЙ API
// хранилища: PATCH /storage/v1/buckets/{name} с updateMask=anonymousAccessFlags.
//
// Почему не S3-путь с заголовком X-Amz-Acl: ACL бакета тоже ставятся через
// консольный API, и запись ACL — это PUT ?acl, который в S3-совместимом API
// означал бы ещё и подпись запроса. Флаг anonymousAccessFlags — ровно то, что
// включает галочка «Публичный доступ» в консоли Yandex Cloud, и ходит тем же
// IAM-токеном, как остальное.
//
// Флагов три, и их нельзя путать:
//   read       — прочитать объект по прямой ссылке (то, что нужно для сайта);
//   list       — перечислить содержимое бакета анонимно (сколько файлов и какие
//                имена — это уже разведка содержимого, поэтому по умолчанию OFF);
//   configRead — прочитать настройки бакета (CORS, жизненный цикл, статика).
// Включаем ТОЛЬКО read: этого хватает, чтобы ссылка открылась, и не выдаёт
// наружу список файлов.
const BUCKET_ACCESS_FIELDS = ["read", "list", "configRead"];

function readAnonymousFlags(bucketJson) {
  const f = (bucketJson && bucketJson.anonymousAccessFlags) || {};
  return { read: !!f.read, list: !!f.list, configRead: !!f.configRead };
}

// Текущее состояние публичного доступа бакета (GET /storage/v1/buckets/{name}).
async function getBucketAccess(oauthToken, bucketName) {
  const name = String(bucketName || "").trim();
  if (!name) throw new Error("Не указан бакет.");
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("storage-api")) || KNOWN_ENDPOINTS["storage-api"];
  const j = await fetchJson(base + "/storage/v1/buckets/" + encodeURIComponent(name), {
    headers: { Authorization: "Bearer " + token },
  }, 30000);
  return { bucket: name, flags: readAnonymousFlags(j) };
}

// Включить (publicOn=true) или снять анонимное чтение бакета. updateMask
// обязателен: без него сервис обнулит ВСЕ остальные поля бакета — потеря
// настроек статики или CORS была бы неприятным сюрпризом.
async function setBucketPublicAccess(oauthToken, bucketName, publicOn) {
  const name = String(bucketName || "").trim();
  if (!name) throw new Error("Не указан бакет.");
  const on = !!publicOn;
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("storage-api")) || KNOWN_ENDPOINTS["storage-api"];
  await fetchJson(base + "/storage/v1/buckets/" + encodeURIComponent(name), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      updateMask: "anonymousAccessFlags",
      anonymousAccessFlags: { read: on, list: false, configRead: false },
    }),
  }, 60000);
  // Проверяем результат, а не факт отправки: без этого «сделал публичным» осталось
  // бы обещанием при отказе по правам (нужна роль storage.admin или storage.editor).
  const after = await getBucketAccess(oauthToken, name);
  if (after.flags.read !== on) {
    const e = new Error(
      "Публичный доступ к бакету не изменился: анонимное чтение " +
        (on ? "не включилось" : "не выключилось") +
        ". Нужна роль storage.admin или storage.editor на бакете (у viewer прав на изменение нет)."
    );
    e.status = 403;
    throw e;
  }
  return { bucket: name, flags: after.flags, public: after.flags.read };
}

module.exports = {
  SERVICES,
  _fetchJson: fetchJson,
  _testApiBase: testApiBase,
  CREATABLE,
  serviceByKey,
  creatableKeys,
  loadEndpoints,
  primeEndpoints,
  endpoint,
  getIamToken,
  getIamTokenInfo,
  resetIamCache,
  retryNet,
  listClouds,
  listFolders,
  listService,
  resourcesStatus,
  pickList,
  serviceHeaders,
  serviceQuery,
  isNetworkError,
  hostOf,
  serviceError,
  createResource,
  deleteResource,
  waitOperation,
  testAuth,
  slugify,
  findRegistry,
  ensureRegistry,
  findContainer,
  ensureContainer,
  containerInfo,
  listContainerAccessBindings,
  setContainerPublicAccess,
  normalizeRecordSet,
  listRecordSets,
  updateRecordSets,
  upsertRecordSet,
  deleteRecordSet,
  normalizeSecretEntries,
  listSecrets,
  findSecret,
  ensureLockboxSecret,
  getSecret,
  listSecretVersions,
  putSecretVersion,
  grantSecretAccess,
  listRegistryImages,
  deleteRegistryImage,
  findRegistryImage,
  parseObjectList,
  contentTypeFor,
  objectPublicUrl,
  listBucketObjects,
  putBucketObject,
  getBucketObject,
  deleteBucketObject,
  getBucketAccess,
  setBucketPublicAccess,
  BUCKET_ACCESS_FIELDS,
  S3_MAX_BYTES,
  getContainer,
  updateContainer,
  listRevisions,
  getRevision,
  rollbackContainer,
  revisionSummary,
  revisionToDeployOpts,
  deployContainerRevision,
  findServiceAccount,
  ensureServiceAccount,
  addRoleOnFolder,
  _friendlyApiError: friendlyApiError,
};
"use strict";

/* ── API Gateway (API-шлюз) БЕЗ внешнего yc CLI ──────────────────────────────
   Почему модуль. API-шлюз — это «вход» в приложение: он принимает запросы по
   адресу `<id>.apigw.yandexcloud.net`, разбирает их по OpenAPI-спецификации и
   уводит в интеграции (dummy, cloud-functions, container, object-storage и
   т.д.). До этого захода шлюз был виден в окне только ПЛИТКОЙ-списком: у
   сервиса был список и общее создание из src/yandex-cloud.js, а создать шлюз ИЗ
   СПЕЦИФИКАЦИИ, посмотреть её, поправить и удалить было нечем — ни у человека,
   ни у агента. Между тем без шлюза функция или контейнер отвечают только по
   своему «неудобному» адресу, а сайт с маршрутами собрать не из чего.

   Что важно знать про API Gateway и не потерять при правке:

     • шлюз ЦЕЛИКОМ задаётся спецификацией `openapiSpec` — это текст OpenAPI
       (JSON или YAML). Создание без спецификации бессмысленно: облако примет
       запрос, но шлюз будет пустой, поэтому пустую спецификацию отбиваем ДО сети;
     • изменяющие методы возвращают OPERATION, а не сам ресурс (как у лог-групп и
       контейнеров): поэтому результат ждёт вызывающий (waitOperation), а тело
       готового шлюза приходит в `response` операции;
     • правка идёт МАСКОЙ полей (`updateMask`): без неё облако обнулило бы всё,
       чего нет в теле. Имя поля спецификации в маске — `openapi_spec` (в proto
       змеиный регистр), а в теле JSON — `openapiSpec`;
     • у шлюза есть адрес по умолчанию (`domain`, вид `<id>.apigw.yandexcloud.net`)
       — он генерируется при создании и меняется вместе с id, поэтому его и
       называем человеку как «куда стучаться»;
     • у шлюза бывают статусы (CREATING/ACTIVE/UPDATING/ERROR/STOPPED): «ACTIVE»
       значит «готов отвечать», а «ERROR» — «работает только удаление». Это надо
       переводить словами, а не отдавать английское слово;
     • источников у спецификации нет отдельным полем: всё живёт в её тексте
       (интеграции `x-yc-apigateway-integration`). Поэтому «показать спецификацию»
       — это отдельное действие, а не часть карточки.

   Модуль чистый: ни Electron, ни окон, ни настроек. Функции принимают IAM-токен
   и адрес сервиса, а сеть зовут через встроенный fetch (можно подменить
   fetchImpl — так его проверяет набор без настоящего облака). Та же конвенция,
   что у REST-части src/yc-logs.js. */

const APIGW_FALLBACK = "https://serverless-apigateway.api.cloud.yandex.net";

// ── Проверки ввода ─────────────────────────────────────────────────────────
// Имя шлюза: как у функции и лог-группы — строчная латиница, цифры и дефис,
// начинается с буквы, 2–63 символа (в облаке ровно `[a-z]([-a-z0-9]{0,61}[a-z0-9])?`).
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя API-шлюза: строчные латинские буквы, цифры и дефис (например my-api), 2–63 символа.");
  if (NAME_RE.test(nm)) return nm;
  throw new Error(
    "Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис, имя начинается с буквы и не заканчивается дефисом (2–63 символа). Подойдёт, например, «my-api»."
  );
}

// Спецификация обязательна: без неё шлюз нечего обслуживать. Проверяем, что это
// похоже на OpenAPI (есть поле openapi/swagger) — иначе облако вернуло бы отказ
// уже после операции, а человек искал бы причину в правах.
function checkSpec(spec) {
  const s = String(spec == null ? "" : spec);
  if (!s.trim()) {
    throw new Error("Нет OpenAPI-спецификации: вставь её текст (JSON или YAML). Шлюз без спецификации нечего обслуживать — начни с шаблона.");
  }
  if (!/["']?openapi["']?\s*:/i.test(s) && !/["']?swagger["']?\s*:/i.test(s)) {
    throw new Error(
      "Это не похоже на OpenAPI-спецификацию: в ней нет поля openapi (или swagger). Спецификация начинается так: `openapi: 3.0.0`, затем `info:` и `paths:`."
    );
  }
  return s;
}

// Время выполнения шлюза — длительность (\"5s\"); число принимаем за секунды,
// пусто/ноль значит «по умолчанию».
function durationOf(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v === "number" || /^\d+$/.test(String(v).trim())) {
    const sec = Math.round(Number(v));
    return sec > 0 ? sec + "s" : "";
  }
  return String(v).trim();
}

// ── Статусы ────────────────────────────────────────────────────────────────
const STATUS_RU = {
  CREATING: "создаётся",
  ACTIVE: "работает",
  UPDATING: "обновляется",
  DELETING: "удаляется",
  ERROR: "ошибка (доступно только удаление)",
  STOPPED: "остановлен",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return STATUS_RU[s] || (s ? s.toLowerCase() : "неизвестно");
}

// ── Нормализация ответов ───────────────────────────────────────────────────
function gatewayInfo(g) {
  const x = g || {};
  const dom = x.domain || "";
  return {
    id: x.id || "",
    folderId: x.folderId || "",
    name: x.name || "",
    description: x.description || "",
    status: x.status || "",
    statusHuman: statusHuman(x.status),
    active: String(x.status || "").toUpperCase() === "ACTIVE",
    domain: dom,
    // Адрес по умолчанию: именно его называют человеку — по нему шлюз отвечает.
    url: dom ? "https://" + dom : "",
    createdAt: x.createdAt || "",
    logGroupId: x.logGroupId || "",
    executionTimeout: x.executionTimeout || "",
    labels: x.labels && typeof x.labels === "object" ? x.labels : {},
  };
}

function gatewayLine(g) {
  const x = gatewayInfo(g);
  return (
    "• " + (x.name || x.id) +
    (x.status ? " — " + x.statusHuman : "") +
    (x.url ? " · " + x.url : "") +
    " (" + x.id + ")"
  );
}

// ── Разбор спецификации без зависимостей ───────────────────────────────────
// YAML-парсер тянуть нельзя (OTA возит только свой код), а знать «сколько путей
// в спецификации» полезно: это первое, что человек хочет увидеть, не читая текст
// целиком. Разбираем обе формы одним способом — ищем строки-пути и интеграции.
function specFormat(spec) {
  const s = String(spec == null ? "" : spec).trim();
  if (!s) return "";
  return s[0] === "{" || s[0] === "[" ? "JSON" : "YAML";
}

function specPaths(spec, fmt) {
  const s = String(spec == null ? "" : spec);
  if (!s.trim()) return [];
  if ((fmt || specFormat(s)) === "JSON") {
    try {
      const obj = JSON.parse(s);
      const paths = obj && obj.paths && typeof obj.paths === "object" ? obj.paths : {};
      return Object.keys(paths);
    } catch {
      return [];
    }
  }
  // YAML: пути объявлены в блоке `paths:` с отступом два пробела и начинаются со
  // слеша. Глубже (методы, интеграции) — уже не пути.
  const out = [];
  for (const line of s.split("\n")) {
    const m = /^\s{2}(\/[^\s:]+):\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

// Краткая сводка: формат, версия OpenAPI, пути и число интеграций.
function specBrief(spec) {
  const s = String(spec == null ? "" : spec);
  const fmt = specFormat(s);
  const paths = specPaths(s, fmt);
  const om = /["']?openapi["']?\s*:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)/i.exec(s) || /["']?swagger["']?\s*:\s*["']?([0-9.]+)/i.exec(s);
  const integrations = (s.match(/x-yc-apigateway-integration/g) || []).length;
  return { format: fmt, openapi: om ? om[1] : "", paths, pathCount: paths.length, integrations };
}

// ── Поиск шлюза по имени, id или адресу ────────────────────────────────────
// Человек называет шлюз по-разному, и адрес по умолчанию — самый частый способ.
function matchGateway(list, ref) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return arr.length === 1 ? arr[0] : null;
  const host = (/^https?:\/\//i.test(q) ? q.replace(/^https?:\/\//i, "") : q).split("/")[0];
  return (
    arr.find((g) => g.id === q) ||
    arr.find((g) => g.name === q) ||
    arr.find((g) => g.domain && g.domain === host) ||
    null
  );
}

// ── REST-помощники (тот же приём, что у лог-групп) ──────────────────────────
function restBase(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

async function restJson(iamToken, url, method, body, fetchImpl) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("нет доступа к сети (fetch недоступен)");
  const init = { method: method || "GET", headers: { Authorization: "Bearer " + iamToken }, redirect: "follow" };
  if (body !== undefined && body !== null) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await f(url, init);
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error("API-шлюз: HTTP " + res.status + " " + String(text).slice(0, 200));
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  return j || null;
}

// ── Чтение: список, карточка, спецификация ─────────────────────────────────
async function listGateways(iamToken, baseUrl, folderId, fetchImpl) {
  const folder = String(folderId || "").trim();
  if (!folder) throw new Error("не выбран каталог (folder)");
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways?folderId=" + encodeURIComponent(folder) + "&pageSize=1000";
  const j = await restJson(iamToken, url, "GET", null, fetchImpl);
  const list = Array.isArray(j && j.apigateways) ? j.apigateways : [];
  return list.map(gatewayInfo);
}

async function getGateway(iamToken, baseUrl, gatewayId, fetchImpl) {
  const id = String(gatewayId || "").trim();
  if (!id) throw new Error("не задан id API-шлюза");
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways/" + encodeURIComponent(id);
  return gatewayInfo(await restJson(iamToken, url, "GET", null, fetchImpl));
}

// Спецификация шлюза. format: JSON или YAML (пусто — как её задали при создании).
async function getSpec(iamToken, baseUrl, gatewayId, format, fetchImpl) {
  const id = String(gatewayId || "").trim();
  if (!id) throw new Error("не задан id API-шлюза");
  const q = format ? "?format=" + encodeURIComponent(String(format).toUpperCase()) : "";
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways/" + encodeURIComponent(id) + ":spec" + q;
  const j = await restJson(iamToken, url, "GET", null, fetchImpl);
  return { apiGatewayId: (j && j.apiGatewayId) || id, openapiSpec: (j && j.openapiSpec) || "" };
}

// ── Создание, правка, удаление ─────────────────────────────────────────────
async function createGateway(iamToken, baseUrl, opts, fetchImpl) {
  const o = opts || {};
  const folderId = String(o.folderId || "").trim();
  if (!folderId) throw new Error("не выбран каталог (folder)");
  const name = checkName(o.name);
  const spec = checkSpec(o.spec != null ? o.spec : o.openapiSpec);
  const body = { folderId: folderId, name: name, openapiSpec: spec };
  if (o.description) body.description = String(o.description);
  if (o.labels && typeof o.labels === "object") body.labels = o.labels;
  const tout = durationOf(o.executionTimeout);
  if (tout) body.executionTimeout = tout;
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways";
  return (await restJson(iamToken, url, "POST", body, fetchImpl)) || {};
}

async function updateGateway(iamToken, baseUrl, gatewayId, opts, fetchImpl) {
  const id = String(gatewayId || "").trim();
  if (!id) throw new Error("не задан id API-шлюза");
  const o = opts || {};
  const body = {};
  const mask = [];
  if (o.name != null && String(o.name).trim()) {
    body.name = checkName(o.name);
    mask.push("name");
  }
  if (o.description != null) {
    body.description = String(o.description);
    mask.push("description");
  }
  if (o.labels != null && typeof o.labels === "object") {
    body.labels = o.labels;
    mask.push("labels");
  }
  const spec = o.spec != null ? o.spec : o.openapiSpec;
  if (spec != null && String(spec).trim()) {
    body.openapiSpec = checkSpec(spec);
    mask.push("openapi_spec");
  }
  const tout = durationOf(o.executionTimeout);
  if (tout) {
    body.executionTimeout = tout;
    mask.push("execution_timeout");
  }
  if (!mask.length) throw new Error("нечего менять: назови новую спецификацию, имя, описание, метки или время выполнения");
  body.updateMask = mask.join(",");
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways/" + encodeURIComponent(id);
  return (await restJson(iamToken, url, "PATCH", body, fetchImpl)) || {};
}

async function deleteGateway(iamToken, baseUrl, gatewayId, fetchImpl) {
  const id = String(gatewayId || "").trim();
  if (!id) throw new Error("не задан id API-шлюза");
  const url = restBase(baseUrl) + "/apigateways/v1/apigateways/" + encodeURIComponent(id);
  return (await restJson(iamToken, url, "DELETE", null, fetchImpl)) || {};
}

// ── Шаблон спецификации ────────────────────────────────────────────────────
// Готовый рабочий минимум: шлюз с одним путём, который отвечает без внешних
// ресурсов (интеграция dummy). С него человек начинает — и сразу видит, что
// «спецификация» это просто текст, а не что-то недостижимое.
const SPEC_TEMPLATE = [
  "openapi: 3.0.0",
  "info:",
  "  title: my-api",
  "  version: 1.0.0",
  "paths:",
  "  /hello:",
  "    get:",
  "      x-yc-apigateway-integration:",
  "        type: dummy",
  "        http_code: 200",
  "        content:",
  '          application/json: \'{"hello": "world"}\'',
  "",
].join("\n");

const SPEC_HINT =
  "Спецификация — это текст OpenAPI (JSON или YAML): `openapi: 3.0.0`, затем `info:` с названием и `paths:`. " +
  "Куда уводить запрос, говорит интеграция `x-yc-apigateway-integration` внутри метода (dummy — ответ без ресурсов, " +
  "cloud-functions — функция, container — контейнер, object-storage — файл бакета).";

module.exports = {
  APIGW_FALLBACK,
  NAME_RE,
  SPEC_TEMPLATE,
  SPEC_HINT,
  STATUS_RU,
  checkName,
  checkSpec,
  durationOf,
  statusHuman,
  gatewayInfo,
  gatewayLine,
  specFormat,
  specPaths,
  specBrief,
  matchGateway,
  restBase,
  restJson,
  listGateways,
  getGateway,
  getSpec,
  createGateway,
  updateGateway,
  deleteGateway,
};

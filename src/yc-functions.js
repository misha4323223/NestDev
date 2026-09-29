"use strict";

/* ── Cloud Functions: функции, версии, теги и вызов ──────────────────────────
   Зачем модуль. Serverless Containers приложение выкатывать умело, а функции —
   нет: их даже не было видно в облаке. Между тем функция — самый дешёвый способ
   получить «что-то, что отвечает в интернете» или «что-то, что просыпается по
   расписанию»: пока её не зовут, она не стоит ничего, а первые 1 000 000 вызовов
   и 10 ГБ×час в месяц не тарифицируются вовсе. Человек шёл за этим в чужую
   консоль, а агент не мог ни посмотреть, ни выкатить.

   Что важно знать про Cloud Functions и не потерять при правке:

     • у функции НЕТ кода. Код живёт в ВЕРСИИ, а вызывается всегда КАКАЯ-ТО
       версия: по умолчанию — последняя созданная (её и показывает виртуальный
       тег `$latest`). Поэтому «обновить функцию» = создать версию, а не
       отредактировать её: версия неизменяема. `SetTag` — это «сделать версию
       боевой», а не «пометить»;
     • теги: `$latest` ВИРТУАЛЬНЫЙ, его нельзя назначить руками — он значит
       «последняя созданная версия». Свой тег (`v1`, `prod`) назначается версии и
       даёт ей СТАБИЛЬНЫЙ адрес вызова (`?tag=prod`), который не меняется от
       следующих выкаток. Человеку нужно именно это: ссылка, которая не поедет;
     • память уходит в БАЙТАХ строкой, кратна 128 МБ, от 128 МБ до 8 ГБ (та же
       тонкость, что у машин), а `executionTimeout` — строка-секунды, максимум
       600 с: дольше функция работать не может;
     • вызов идёт НЕ в API сервиса, а на отдельный адрес `functions.yandexcloud.net`
       (`?tag=` выбирает версию). Публичная функция отвечает кому угодно, а
       закрытая требует роли `serverless.functions.invoker` У ВЫЗЫВАЮЩЕГО: без неё
       приходит 403, и это надо объяснить словами, а не «HTTP 403»;
     • «сделать функцию публичной» — это выдача роли `serverless.functions.invoker`
       субъекту `allUsers` НА САМУ ФУНКЦИЮ (привязки-дельты, как в IAM). Поэтому
       публичность бывает только осознанной: здесь она отдельное действие, а
       проверяется ПЕРЕЧИТЫВАНИЕМ привязок — «200 OK» ещё не значит, что роль
       появилась;
     • источник кода версии бывает трёх видов: содержимое архива (`content`,
       base64), уже лежащий в бакете архив (`package`) и КОПИЯ прежней версии
       (`versionId`) — последнее и есть «поменять только переменные и память»;
     • удаление функции забирает и все её версии, и теги: сказать об этом надо ДО
       удаления, а не после. Версию удалить можно, но если она последняя —
       функция останется без версий и перестанет отвечать;
     • логи функции лежат в Cloud Logging с типом ресурса `serverless.function`
       (см. YC_RESOURCE_TYPES), а не в API функций;
     • функции НЕ тарифицируются за простой: платят за вызовы и ГБ×час
       выполнения (6,48 ₽/ГБ×ч и 18,97 ₽/млн вызовов, первые 10 ГБ×ч и 1 млн
       вызовов в месяц — бесплатно). Поэтому предложение «перенеси это в функцию»
       часто дешевле машины, о чём агент и должен говорить.

   Модуль чистый: ни Electron, ни окон, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcVpc, createYcCompute, createYcIam):
   IAM-токен, адреса сервисов, разбор сетевых отказов, ожидание операции и
   чтение ответа текстом (вызов функции возвращает НЕ JSON — это ответ её кода).

   Изменения не делаются «по умолчанию»: модуль ничего не решает за человека, а
   возвращает данные и предупреждения. */

const FUNCTIONS_FALLBACK = "https://serverless-functions.api.cloud.yandex.net";
const INVOKE_FALLBACK = "https://functions.yandexcloud.net";

// ── Проверки ввода ─────────────────────────────────────────────────────────
// Имя функции: как у подсети и машины — строчные латинские буквы, цифры и дефис,
// от 3 до 63 символов (в облаке это ровно `[a-z][-a-z0-9]{1,61}[a-z0-9]`).
const NAME_RE = /^[a-z][-a-z0-9]{1,61}[a-z0-9]$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя функции: строчные латинские буквы, цифры и дефис (например hello-func), 3–63 символа.");
  if (NAME_RE.test(nm)) return nm;
  const lower = nm.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (NAME_RE.test(lower)) {
    throw new Error("Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис. Возьми «" + lower + "».");
  }
  throw new Error(
    "Имя «" + nm + "» не подойдёт: нужно 3–63 символа, только строчные латинские буквы, цифры и дефис, начинается с буквы и не заканчивается дефисом. Подойдёт, например, «hello-func»."
  );
}

function checkFolder(folderId) {
  const f = String(folderId || "").trim();
  if (!f) throw new Error("Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.");
  return f;
}

// ── Память, время и теги ───────────────────────────────────────────────────
// Память облако ждёт в БАЙТАХ строкой и кратной 128 МБ (как у машин — там байты
// для диска). Путаница «256» и «256 МБ» здесь дороже, чем где-либо: слишком мало
// памяти — функция падает по OOM уже в бою, а не при создании.
const MEMORY_MIN_MB = 128;
const MEMORY_MAX_MB = 8192;
const MEMORY_STEP_MB = 128;

// Столько кода отправляем в облако одним запросом. Больше — только через бакет:
// держать в памяти архив на десятки мегабайт незачем (лимит API 50 МБ).
const MAX_CONTENT_MB = 8;

function parseMemoryMb(v, fallbackMb) {
  if (v == null || v === "") return fallbackMb == null ? MEMORY_MIN_MB : fallbackMb;
  let mb;
  if (typeof v === "number") {
    mb = v;
    // Число больше 100_000 — это почти наверняка байты, а не мегабайты.
    if (mb >= 100000) mb = Math.round(mb / 1048576);
  } else {
    const s = String(v).trim().toLowerCase();
    const m = /^([0-9.]+)\s*(g|gb|гб|гиг|m|mb|мб|b|байт)?$/.exec(s);
    if (!m) throw new Error("Не понял объём памяти «" + v + "». Пиши в мегабайтах: 128, 256, 512, 1024 (можно «512 МБ» или «1 ГБ»).");
    const num = parseFloat(m[1]);
    if (!isFinite(num) || num <= 0) throw new Error("Не понял объём памяти «" + v + "».");
    const unit = m[2] || "mb";
    if (unit === "g" || unit === "gb" || unit === "гб" || unit === "гиг") mb = num * 1024;
    else if (unit === "b" || unit === "байт") mb = num / 1048576;
    else if (num >= 100000) mb = num / 1048576; // «134217728» — это байты
    else mb = num;
  }
  // Облако принимает только значения, кратные 128 МБ: округляем вверх сами,
  // иначе «300 МБ» превращалось бы в отказ сервиса уже на создании версии.
  let real = Math.ceil(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB;
  if (real < MEMORY_MIN_MB) real = MEMORY_MIN_MB;
  if (real > MEMORY_MAX_MB) throw new Error("Память " + real + " МБ не бывает: у функции максимум " + MEMORY_MAX_MB + " МБ (8 ГБ).");
  return real;
}

function memoryBytes(mb) {
  return String(Math.round(mb) * 1048576);
}

function memoryHuman(mb) {
  const m = Number(mb) || 0;
  return m >= 1024 ? (m % 1024 === 0 ? m / 1024 + " ГБ" : (m / 1024).toFixed(1) + " ГБ") : m + " МБ";
}

// Время выполнения: строка-секунды (поле duration), максимум 600 с. Принимаем и
// «PT30S», и «30s», и просто 30 — агент и человек пишут по-разному.
const TIMEOUT_DEFAULT_SEC = 5;
const TIMEOUT_MAX_SEC = 600;

function parseTimeoutSec(v, fallbackSec) {
  const def = fallbackSec == null ? TIMEOUT_DEFAULT_SEC : fallbackSec;
  if (v == null || v === "") return def;
  let sec;
  if (typeof v === "number") sec = v;
  else {
    const s = String(v).trim().toUpperCase();
    const iso = /^PT([0-9.]+)S$/.exec(s);
    const plain = /^([0-9.]+)\s*(S|SEC|С|СЕК|СЕКУНД(?:А|Ы)?)?$/.exec(s);
    if (iso) sec = parseFloat(iso[1]);
    else if (plain) sec = parseFloat(plain[1]);
    else throw new Error("Не понял время выполнения «" + v + "». Пиши в секундах: 5, 30, 600 (можно «30 с» или «PT30S»).");
  }
  if (!isFinite(sec) || sec <= 0) throw new Error("Время выполнения должно быть больше нуля (секунды).");
  if (sec > TIMEOUT_MAX_SEC) {
    throw new Error("Время выполнения " + sec + " с не подойдёт: у Cloud Functions максимум " + TIMEOUT_MAX_SEC + " секунд (10 минут) на вызов. Если работы больше — дели её на шаги или бери машину.");
  }
  return Math.ceil(sec);
}

function timeoutHuman(sec) {
  const s = Number(sec) || 0;
  if (!s) return "не задано (по умолчанию 5 с)";
  return s + " с";
}

// Теги версии. `$latest` — виртуальный тег облака («последняя созданная версия»):
// назначить его руками нельзя, и попытка означала бы, что человек не понимает,
// что делает, поэтому отбиваем с объяснением.
const TAG_RE = /^[a-z][-_0-9a-z]*$/;

function checkTag(tag) {
  const t = String(tag == null ? "" : tag).trim();
  if (!t) throw new Error("Не указан тег. Тег — это короткое имя версии: v1, prod, stable (строчные латинские буквы, цифры, дефис и подчёркивание).");
  if (t === "$latest" || t === "latest") {
    throw new Error("Тег «" + t + "» ставить нельзя: `$latest` — виртуальный тег облака, он всегда значит «последняя созданная версия». Свой тег — это v1, prod, stable.");
  }
  if (!TAG_RE.test(t)) {
    throw new Error("Тег «" + t + "» не подойдёт: облако принимает строчные латинские буквы, цифры, дефис и подчёркивание, и тег начинается с буквы (например v1 или prod).");
  }
  return t;
}

// Язык выполнения. Живой список отдаёт само облако (ListRuntimes), но подсказать
// частые надо: иначе агент придумывает «node20» и получает отказ сервиса.
const RUNTIMES_HINT = ["nodejs22", "nodejs20", "nodejs18", "python312", "python311", "golang122", "java21", "dotnet8", "php83", "bash", "ruby33", "c"];

function checkRuntime(runtime, available) {
  const r = String(runtime == null ? "" : runtime).trim().toLowerCase();
  if (!r) {
    throw new Error("Не указан язык выполнения (runtime). Частые: " + RUNTIMES_HINT.slice(0, 6).join(", ") + ". Полный список: ycFunctions { action: \"runtimes\" }.");
  }
  const list = Array.isArray(available) ? available.map((x) => String(x)) : [];
  if (list.length && list.indexOf(r) < 0) {
    const near = list.filter((x) => x.indexOf(r.slice(0, 4)) >= 0).slice(0, 6);
    throw new Error(
      "Языка «" + r + "» в облаке нет." + (near.length ? " Похожие: " + near.join(", ") + "." : "") + " Полный список: ycFunctions { action: \"runtimes\" }."
    );
  }
  return r;
}

// ── Статусы и время ────────────────────────────────────────────────────────
const FN_STATUS = {
  CREATING: "создаётся",
  ACTIVE: "работает",
  DELETING: "удаляется",
  ERROR: "ошибка",
};

const VERSION_STATUS = {
  CREATING: "создаётся",
  ACTIVE: "готова",
  OBSOLETE: "устарела (будет удалена облаком)",
  DELETING: "удаляется",
};

function statusHuman(status, map) {
  const s = String(status || "").toUpperCase();
  const table = map || FN_STATUS;
  return table[s] || (s ? s.toLowerCase() : "неизвестно");
}

function daysSince(iso) {
  const t = Date.parse(String(iso || ""));
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function humanDays(n) {
  if (n == null) return "неизвестно";
  if (n <= 0) return "сегодня";
  if (n === 1) return "вчера";
  return n + " дн. назад";
}

function isActive(fn) {
  return String((fn && fn.status) || "").toUpperCase() === "ACTIVE";
}

// ── Нормализация ответов сервиса ────────────────────────────────────────────
function functionInfo(f) {
  const o = f || {};
  const age = daysSince(o.createdAt);
  return {
    id: o.id || "",
    folderId: o.folderId || "",
    name: o.name || "",
    description: o.description || "",
    labels: o.labels || {},
    createdAt: o.createdAt || "",
    ageDays: age,
    ageHuman: humanDays(age),
    status: o.status || "",
    statusHuman: statusHuman(o.status, FN_STATUS),
    active: isActive(o),
    httpInvokeUrl: o.httpInvokeUrl || "",
  };
}

function versionInfo(v) {
  const o = v || {};
  const res = o.resources || {};
  const mb = res.memory ? Math.round(Number(res.memory) / 1048576) : 0;
  const age = daysSince(o.createdAt);
  const tags = Array.isArray(o.tags) ? o.tags.map(String) : [];
  const timeout = o.executionTimeout ? String(o.executionTimeout).replace(/^PT/, "").replace(/S$/, "") : "";
  return {
    id: o.id || "",
    functionId: o.functionId || "",
    description: o.description || "",
    createdAt: o.createdAt || "",
    ageDays: age,
    ageHuman: humanDays(age),
    runtime: o.runtime || "",
    entrypoint: o.entrypoint || "",
    memoryMb: mb,
    memoryHuman: mb ? memoryHuman(mb) : "неизвестно",
    memoryBytes: res.memory ? String(res.memory) : "",
    timeoutSec: timeout ? Number(timeout) || 0 : 0,
    timeoutHuman: timeoutHuman(timeout ? Number(timeout) || 0 : 0),
    serviceAccountId: o.serviceAccountId || "",
    imageSizeMb: o.imageSize ? Math.round(Number(o.imageSize) / 1048576) : 0,
    status: o.status || "",
    statusHuman: statusHuman(o.status, VERSION_STATUS),
    active: String(o.status || "").toUpperCase() === "ACTIVE",
    tags: tags,
    // Тег — это стабильный адрес вызова: `?tag=v1` не поедет от новых версий.
    tagged: tags.length > 0,
    environment: o.environment || {},
    envCount: Object.keys(o.environment || {}).length,
    secrets: Array.isArray(o.secrets) ? o.secrets : [],
    secretCount: (Array.isArray(o.secrets) ? o.secrets : []).length,
    concurrency: o.concurrency ? Number(o.concurrency) : 0,
    networkId: (o.connectivity && o.connectivity.networkId) || "",
  };
}

// Какая версия отвечает «по умолчанию». `$latest` — виртуальный тег: облако
// подставляет последнюю СОЗДАННУЮ версию, поэтому в списке её ищем по времени.
function activeVersion(versions) {
  const list = (versions || []).filter(Boolean);
  if (!list.length) return null;
  let best = null;
  for (const v of list) {
    const t = Date.parse(String(v.createdAt || "")) || 0;
    if (!best || t >= best.t) best = { v: v, t: t };
  }
  return best ? best.v : null;
}

function versionWithTag(versions, tag) {
  const t = String(tag || "").trim();
  if (!t) return null;
  return (versions || []).find((v) => v && Array.isArray(v.tags) && v.tags.indexOf(t) >= 0) || null;
}

// Постоянные теги функции: то, чем можно пользоваться извне, не боясь следующей
// выкатки. Именно их и надо называть человеку.
function stableTags(versions) {
  const out = [];
  for (const v of versions || []) {
    for (const t of (v && v.tags) || []) out.push({ tag: t, version: v });
  }
  return out;
}

// ── Предупреждения о версиях ────────────────────────────────────────────────
const VERSION_OLD_DAYS = 180;

function versionTrouble(v, all) {
  const ver = v || {};
  const list = all || [];
  const out = [];
  if (String(ver.status || "").toUpperCase() === "OBSOLETE") {
    out.push("версия " + (ver.id || "").slice(0, 8) + " помечена как устаревшая: облако удалит её само, и вызов по этой версии перестанет работать");
  }
  if (ver.tagged === false && ver.active) {
    const newest = activeVersion(list);
    if (newest && newest.id === ver.id && list.length > 1) {
      out.push("боевой адрес функции сейчас указывает на САМУЮ НОВУЮ версию (`$latest`): следующая выкатка поменяет то, что отвечает. Поставь постоянный тег (v1 / prod) и вызывай по нему");
    }
  }
  if (ver.active && ver.ageDays != null && ver.ageDays >= VERSION_OLD_DAYS && list.length > 1) {
    out.push("эту версию не трогали " + ver.ageDays + " дн., а версий уже " + list.length + " — проверь, нет ли лишних");
  }
  if (ver.secretCount) {
    out.push("версия читает секреты Lockbox (" + ver.secretCount + "): удалять сам секрет нельзя, пока он нужен этой версии");
  }
  return out;
}

// ── Объяснение ответа вызова ────────────────────────────────────────────────
// Вызов идёт на публичный адрес, а не в API сервиса, поэтому 403 здесь значит
// ровно одно: функцию нельзя звать без прав — и это надо сказать словами.
function invokeHint(status, text, fn) {
  const s = Number(status) || 0;
  const body = String(text || "");
  const name = (fn && fn.name) || "функция";
  if (s === 200) return "";
  if (s === 403) {
    return "Функцию «" + name + "» нельзя вызвать: у аккаунта нет роли serverless.functions.invoker на неё, а сама функция не публичная. Разреши вызов: ycFunctions { action: \"public\", function: \"" + name + "\" } — но помни, что тогда её сможет позвать кто угодно из интернета.";
  }
  if (s === 404) return "Такой функции или версии нет (404): проверь имя функции и тег — список версий: ycFunctions { action: \"versions\", function: \"" + name + "\" }.";
  if (s === 429) return "Слишком много одновременных вызовов (429): подожди и повтори, либо подними квоту в облаке.";
  if (s === 502 || s === 504 || /timeout/i.test(body)) {
    return "Функция не успела ответить (код " + s + "): у неё ограничение времени выполнения (" + TIMEOUT_MAX_SEC + " с максимум). Посмотри логи — ycLogs { service: \"cloudFunctions\", id: \"<id функции>\" }.";
  }
  return "";
}

function createYcFunctions(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError = typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Functions: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function base(serviceId, fallback) {
    const b = typeof api.endpoint === "function" ? await api.endpoint(serviceId) : "";
    return b || fallback;
  }

  async function call(oauthToken, serviceId, fallback, method, path, body, timeoutMs) {
    requireApi();
    const b = await base(serviceId, fallback);
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      return await api.fetchJson(b + path, opts, timeoutMs || 30000);
    } catch (e) {
      const err = new Error(serviceError(e, b, path));
      err.status = e && e.status;
      throw err;
    }
  }

  function fns(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "serverless-functions", FUNCTIONS_FALLBACK, method, path, body, timeoutMs);
  }

  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 300000);
    return op || {};
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  async function functions(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await fns(oauthToken, "GET", "/functions/v1/functions?folderId=" + encodeURIComponent(folder) + "&pageSize=1000", undefined, 25000);
    return (Array.isArray(j && j.functions) ? j.functions : []).map(functionInfo);
  }

  async function functionInfoById(oauthToken, id) {
    const i = String(id || "").trim();
    if (!i) throw new Error("Не указан id функции.");
    return functionInfo(await fns(oauthToken, "GET", "/functions/v1/functions/" + encodeURIComponent(i), undefined, 20000));
  }

  // Функция по имени, id или адресу вызова: человек называет её по-разному.
  async function findFunction(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    const list = await functions(oauthToken, folderId);
    if (!q) return list.length === 1 ? list[0] : null;
    const urlMatch = /functions\.yandexcloud\.net\/([^/?#]+)/.exec(q);
    const byUrl = urlMatch ? decodeURIComponent(urlMatch[1]) : "";
    return (
      list.find((f) => f.id === q) ||
      list.find((f) => f.name === q) ||
      (byUrl ? list.find((f) => f.id === byUrl || f.name === byUrl) : null) ||
      null
    );
  }

  async function requireFunction(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    if (!q) throw new Error("Укажи функцию: имя или id (список: ycFunctions { action: \"list\" }).");
    const found = await findFunction(oauthToken, folderId, q);
    if (found) return found;
    // Не нашли в каталоге — возможно, это id из другого каталога.
    const byId = await functionInfoById(oauthToken, q).catch(() => null);
    if (byId && byId.id) return byId;
    throw new Error("Не нашёл функцию «" + q + "» в каталоге.");
  }

  async function versions(oauthToken, functionId) {
    const id = typeof functionId === "string" ? functionId : (functionId && functionId.id) || "";
    const fid = String(id || "").trim();
    if (!fid) throw new Error("Не указана функция для списка версий.");
    const j = await fns(oauthToken, "GET", "/functions/v1/versions?functionId=" + encodeURIComponent(fid) + "&pageSize=1000", undefined, 25000);
    return (Array.isArray(j && j.versions) ? j.versions : []).map(versionInfo);
  }

  async function version(oauthToken, versionId) {
    const id = String(versionId || "").trim();
    if (!id) throw new Error("Не указан id версии.");
    return versionInfo(await fns(oauthToken, "GET", "/functions/v1/versions/" + encodeURIComponent(id), undefined, 20000));
  }

  // Версия по id, тегу или по признаку «последняя»: агенту и панели нужно уметь
  // назвать версию так, как её называет человек.
  async function requireVersion(oauthToken, functionId, ref) {
    const list = await versions(oauthToken, functionId);
    const q = String(ref == null ? "" : ref).trim();
    if (!q) {
      const active = activeVersion(list);
      if (!active) throw new Error("У функции нет ни одной версии — сначала создай её: ycFunctions { action: \"deploy\" }.");
      return active;
    }
    if (q === "latest" || q === "$latest") {
      const active = activeVersion(list);
      if (!active) throw new Error("У функции нет ни одной версии.");
      return active;
    }
    const found = list.find((v) => v.id === q) || versionWithTag(list, q) || list.find((v) => v.id.indexOf(q) === 0 && q.length >= 6) || null;
    if (!found) {
      throw new Error(
        "Не нашёл версию «" + q + "» у функции. Есть: " + (list.map((v) => v.id.slice(0, 8) + (v.tags.length ? " (" + v.tags.join(", ") + ")" : "")).join(", ") || "ни одной")
      );
    }
    return found;
  }

  async function runtimes(oauthToken) {
    const j = await fns(oauthToken, "GET", "/functions/v1/runtimes", undefined, 20000);
    return Array.isArray(j && j.runtimes) ? j.runtimes.map(String) : [];
  }

  // Адрес вызова. В ответе API он уже есть (httpInvokeUrl), но у только что
  // созданной функции его может не быть — тогда собираем сами, чтобы человек не
  // остался без ссылки.
  async function invokeBase() {
    return base("functions-invoke", INVOKE_FALLBACK);
  }

  function invokeUrl(fn, tag, baseUrl) {
    const id = (fn && (fn.id || fn)) || "";
    const t = String(tag || "").trim();
    return String(baseUrl || INVOKE_FALLBACK).replace(/\/+$/, "") + "/" + encodeURIComponent(String(id)) + (t ? "?tag=" + encodeURIComponent(t) : "");
  }

  // ── Создание, правка, удаление функции ─────────────────────────────────────

  async function createFunction(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    const body = { folderId, name };
    if (opt.description) body.description = String(opt.description);
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;

    const j = await fns(oauthToken, "POST", "/functions/v1/functions", body, 30000);
    const op = await run(oauthToken, j, 300000);
    const id = (op.response && op.response.id) || "";
    const made = id ? await functionInfoById(oauthToken, id).catch(() => null) : await findFunction(oauthToken, folderId, name);
    if (!made) throw new Error("Функция «" + name + "» создана, но не найдена в каталоге — проверь права (functions.editor) и повтори список.");

    return {
      function: made,
      message: "Функция «" + made.name + "» создана (" + made.id + ").",
      warnings: [
        "У функции пока НЕТ НИ ОДНОЙ версии: она не отвечает и вызвать её нельзя. Дальше — ycFunctions { action: \"deploy\", function: \"" + made.name + "\", zipFile: \"index.zip\", runtime: \"nodejs22\", entrypoint: \"index.handler\" }.",
        "Первые 1 000 000 вызовов и 10 ГБ×час в месяц не тарифицируются — до этих пор функция бесплатна.",
      ],
    };
  }

  async function updateFunction(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const fields = [];
    const body = {};
    if (opt.newName != null && String(opt.newName).trim()) {
      const nm = checkName(opt.newName);
      if (nm !== fn.name) {
        body.name = nm;
        fields.push("name");
      }
    }
    if (opt.description != null) {
      const d = String(opt.description).trim();
      if (d !== String(fn.description || "")) {
        body.description = d;
        fields.push("description");
      }
    }
    if (opt.labels && typeof opt.labels === "object") {
      body.labels = opt.labels;
      fields.push("labels");
    }
    if (!fields.length) {
      return { changed: false, function: fn, message: "У функции «" + fn.name + "» нечего менять: имя, описание и метки те же." };
    }
    // Маска обязательна: без неё сервис обнулит всё, чего нет в теле.
    body.updateMask = fields.join(",");
    const j = await fns(oauthToken, "PATCH", "/functions/v1/functions/" + encodeURIComponent(fn.id), body, 30000);
    await run(oauthToken, j, 300000);
    const after = await functionInfoById(oauthToken, fn.id).catch(() => null);
    if (!after) throw new Error("Функция «" + fn.name + "» не перечиталась после правки — проверь её в списке.");
    const ok = (!body.name || after.name === body.name) && (!fields.includes("description") || after.description === body.description);
    if (!ok) throw new Error("Правка функции «" + fn.name + "» не применилась: имя «" + after.name + "», описание «" + after.description + "». Проверь права (functions.editor).");
    return { changed: true, function: after, message: "Функция «" + after.name + "» обновлена (" + fields.join(", ") + ")." };
  }

  // Удаление: сначала собираем, что уйдёт вместе с функцией (версии, теги,
  // привязки ролей), и только потом удаляем. Публичный вызов — тоже часть ответа:
  // после удаления ссылка перестаёт работать у всех, кто ею пользовался.
  async function deleteFunction(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const list = await versions(oauthToken, fn.id).catch(() => []);
    const bindings = await accessBindings(oauthToken, fn.id).catch(() => []);
    const wasPublic = isPublic(bindings);

    const j = await fns(oauthToken, "DELETE", "/functions/v1/functions/" + encodeURIComponent(fn.id), undefined, 30000);
    await run(oauthToken, j, 300000);

    const left = await functionInfoById(oauthToken, fn.id).catch(() => null);
    if (left) throw new Error("Функция «" + fn.name + "» не удалилась: она ещё существует. Проверь права (functions.editor).");

    const warns = [];
    if (list.length) warns.push("Вместе с функцией удалены её версии (" + list.length + ") и их теги: " + list.map((v) => v.id.slice(0, 8) + (v.tags.length ? " (" + v.tags.join(", ") + ")" : "")).join(", ") + ".");
    if (wasPublic) warns.push("Функция была ПУБЛИЧНОЙ: её адрес работал у кого угодно из интернета. Если на него ссылались бот, сайт или расписание — они сломаются.");
    warns.push("Триггеры и API Gateway, которые её звали, останутся, но вызывать будет нечего: их надо удалить или перенастроить отдельно.");
    return {
      deleted: true,
      function: fn,
      versions: list,
      wasPublic: wasPublic,
      warnings: warns,
      message: "Функция «" + fn.name + "» удалена" + (list.length ? " вместе с " + list.length + " версией(ями)" : "") + ".",
    };
  }

  // ── Версии: выкатка кода ───────────────────────────────────────────────────
  // Источник кода ровно один из трёх: архив целиком (content), архив в бакете
  // (package) или КОПИЯ прежней версии (versionId) — последнее и есть «поменять
  // только переменные и память». Ничего не задали — отказываем, а не гадаем.

  function sourceOf(opt) {
    const o = opt || {};
    const zip = o.zipFile || o.file;
    if (zip) {
      const fs = require("fs");
      const p = String(zip);
      if (!fs.existsSync(p)) throw new Error("Файл архива «" + p + "» не найден.");
      const stat = fs.statSync(p);
      const mb = stat.size / 1048576;
      if (mb > MAX_CONTENT_MB) {
        throw new Error(
          "Архив " + mb.toFixed(1) + " МБ — больше " + MAX_CONTENT_MB + " МБ в один запрос не отправить. Положи архив в бакет (ycStorage) и создай версию с package { bucketName, objectName }."
        );
      }
      if (!/\.(zip|jar)$/i.test(p)) {
        throw new Error("Код функции — это ZIP-архив (или JAR для java). «" + p + "» на архив не похож: собери zip, например `Compress-Archive -Path index.js -DestinationPath index.zip`.");
      }
      return { content: fs.readFileSync(p).toString("base64"), source: "архив " + p + " (" + mb.toFixed(2) + " МБ)" };
    }
    if (o.contentBase64) return { content: String(o.contentBase64), source: "переданный архив (base64)" };
    if (o.sourceVersionId || o.fromVersion) {
      return { versionId: String(o.sourceVersionId || o.fromVersion), source: "копия версии " + String(o.sourceVersionId || o.fromVersion).slice(0, 8) };
    }
    if (o.package && o.package.bucketName && o.package.objectName) {
      return { package: { bucketName: String(o.package.bucketName), objectName: String(o.package.objectName) }, source: "архив в бакете " + o.package.bucketName + "/" + o.package.objectName };
    }
    throw new Error(
      "Не указан код версии. Три способа: zipFile — путь к ZIP-архиву с кодом; sourceVersionId — скопировать код прежней версии (тогда меняются только переменные и память); package { bucketName, objectName } — архив уже лежит в бакете."
    );
  }

  async function createVersion(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);

    // Языки берём живым списком: придуманный «node20» сервис отбивает отказом.
    let available = [];
    try {
      available = await runtimes(oauthToken);
    } catch (e) {
      available = [];
    }
    const runtime = checkRuntime(opt.runtime, available);
    const entrypoint = String(opt.entrypoint || opt.handler || "").trim();
    if (!entrypoint) {
      throw new Error("Не указана точка входа (entrypoint) — имя файла и функции-обработчика, например index.handler (для python — index.handler).");
    }
    if (!/^[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+$/.test(entrypoint) && !entrypoint.endsWith(".")) {
      throw new Error("Точка входа «" + entrypoint + "» выглядит не так: её пишут как <файл>.<обработчик>, например index.handler.");
    }
    const memoryMb = parseMemoryMb(opt.memoryMb != null ? opt.memoryMb : opt.memory, 128);
    const timeoutSec = parseTimeoutSec(opt.timeoutSec != null ? opt.timeoutSec : opt.timeout, TIMEOUT_DEFAULT_SEC);
    const src = sourceOf(opt);
    const tags = [];
    if (opt.tag != null && String(opt.tag).trim()) tags.push(checkTag(opt.tag));
    if (Array.isArray(opt.tags)) for (const t of opt.tags) tags.push(checkTag(t));

    const body = {
      functionId: fn.id,
      runtime: runtime,
      entrypoint: entrypoint,
      resources: { memory: memoryBytes(memoryMb) },
      executionTimeout: timeoutSec + "s",
    };
    if (opt.description) body.description = String(opt.description);
    if (opt.serviceAccountId) body.serviceAccountId = String(opt.serviceAccountId);
    if (opt.environment && typeof opt.environment === "object") body.environment = opt.environment;
    if (tags.length) body.tag = tags;
    if (opt.concurrency != null && opt.concurrency !== "") body.concurrency = String(parseInt(opt.concurrency, 10) || 0);
    if (opt.networkId) body.connectivity = { networkId: String(opt.networkId) };
    if (Array.isArray(opt.secrets) && opt.secrets.length) body.secrets = opt.secrets;
    if (src.content) body.content = src.content;
    else if (src.versionId) body.versionId = src.versionId;
    else if (src.package) body.package = src.package;

    const j = await fns(oauthToken, "POST", "/functions/v1/versions", body, 120000);
    const op = await run(oauthToken, j, 600000);
    const madeId = (op.response && op.response.id) || "";
    let made = null;
    if (madeId) made = await version(oauthToken, madeId).catch(() => null);
    if (!made) {
      // Ответ операции может не нести версию — тогда ищем самую свежую.
      const list = await versions(oauthToken, fn.id).catch(() => []);
      const newest = activeVersion(list);
      if (!newest || (madeId && newest.id !== madeId)) {
        throw new Error("Версия не появилась у функции «" + fn.name + "» — проверь логи и права (functions.editor). Список версий: ycFunctions { action: \"versions\", function: \"" + fn.name + "\" }.");
      }
      made = newest;
    }

    const warnings = [];
    warnings.push(
      "Версия " + made.id.slice(0, 8) + " СРАЗУ стала боевой: функция отвечает именно ею, пока не создана следующая (это и значит виртуальный тег $latest)."
    );
    if (tags.length) {
      warnings.push("Постоянный адрес этой версии: " + (await invokeUrlOf(oauthToken, fn, tags[0])) + " — он не поедет от следующих выкаток.");
    } else {
      warnings.push("Постоянного тега у версии нет: адрес без тега всегда ведёт на САМУЮ НОВУЮ версию. Чтобы ссылка не менялась, добавь тег: ycFunctions { action: \"tag\", function: \"" + fn.name + "\", tag: \"v1\" }.");
    }
    if (made.memoryMb < 256) warnings.push("Память " + made.memoryHuman + " — минимум облака. Node.js и Python на нём стартуют, но с реальной работой он падает по нехватке памяти: для веба обычно нужно 256–512 МБ.");
    warnings.push("Пустая функция бесплатна: первые 1 000 000 вызовов и 10 ГБ×час в месяц не тарифицируются. Что внутри — видно в логах: ycLogs { service: \"cloudFunctions\", id: \"" + fn.id + "\" }.");

    return {
      function: fn,
      version: made,
      source: src.source,
      memoryMb: memoryMb,
      timeoutSec: timeoutSec,
      runtime: runtime,
      message: "У функции «" + fn.name + "» создана версия " + made.id.slice(0, 8) + " (" + made.runtime + ", " + made.memoryHuman + ", " + made.timeoutHuman + ", код: " + src.source + ").",
      warnings: warnings,
    };
  }

  async function deleteVersion(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const list = await versions(oauthToken, fn.id);
    const ver = await requireVersion(oauthToken, fn.id, opt.version || opt.versionId);
    if (list.length === 1) {
      throw new Error(
        "Это ЕДИНСТВЕННАЯ версия функции «" + fn.name + "»: без версий функция перестанет отвечать вовсе. Сначала создай новую (ycFunctions { action: \"deploy\" }), потом удаляй эту."
      );
    }
    const j = await fns(oauthToken, "DELETE", "/functions/v1/versions/" + encodeURIComponent(ver.id), undefined, 30000);
    await run(oauthToken, j, 300000);
    const after = await versions(oauthToken, fn.id).catch(() => []);
    if (after.some((v) => v.id === ver.id)) throw new Error("Версия " + ver.id.slice(0, 8) + " не удалилась — она всё ещё в списке. Проверь права (functions.editor).");
    const warns = [];
    if (ver.tags.length) warns.push("Вместе с версией исчезли её теги: " + ver.tags.join(", ") + ". Адреса вызова с этими тегами перестанут работать.");
    return { deleted: true, function: fn, version: ver, warnings: warns, message: "Версия " + ver.id.slice(0, 8) + " функции «" + fn.name + "» удалена." };
  }

  // ── Теги: стабильный адрес вызова ─────────────────────────────────────────
  // Тег — это не украшение, а адрес: `?tag=v1` не поедет от следующих выкаток.
  // Поэтому результат проверяется ПЕРЕЧИТЫВАНИЕМ: сервис отвечает «операция
  // завершена» и на тег, которого на версии нет.
  async function setTag(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const tag = checkTag(opt.tag);
    const ver = await requireVersion(oauthToken, fn.id, opt.version || opt.versionId);
    const remove = opt.remove === true || opt.action === "untag";
    const path = "/functions/v1/versions/" + encodeURIComponent(ver.id) + (remove ? ":removeTag" : ":setTag");

    const before = await versions(oauthToken, fn.id);
    const holder = versionWithTag(before, tag);
    if (!remove && holder && holder.id === ver.id) {
      return { changed: false, function: fn, version: ver, tag: tag, message: "У версии " + ver.id.slice(0, 8) + " тег " + tag + " уже есть — ничего не менял." };
    }
    if (remove && !holder) {
      throw new Error("У функции «" + fn.name + "» нет версии с тегом " + tag + " — снимать нечего.");
    }

    const j = await fns(oauthToken, "POST", path, { tag: tag }, 30000);
    await run(oauthToken, j, 300000);

    const after = await versions(oauthToken, fn.id);
    const now = versionWithTag(after, tag);
    if (remove) {
      if (now) throw new Error("Тег " + tag + " не снялся: он всё ещё на версии " + now.id.slice(0, 8) + ". Проверь права (functions.editor).");
    } else if (!now || now.id !== ver.id) {
      throw new Error("Тег " + tag + " не появился на версии " + ver.id.slice(0, 8) + ". Проверь права (functions.editor) в каталоге.");
    }

    const warns = [];
    if (!remove && holder && holder.id !== ver.id) {
      warns.push("Тег " + tag + " был на версии " + holder.id.slice(0, 8) + " и переехал: тот адрес теперь отвечает новым кодом. Если так делать нельзя — не трогай тег, а создай второй (v2, prod2).");
    }
    const url = await invokeUrlOf(oauthToken, fn, tag);
    return {
      changed: true,
      function: fn,
      version: now || ver,
      tag: tag,
      removed: remove,
      url: url,
      warnings: warns,
      message: remove
        ? "С версии " + ver.id.slice(0, 8) + " снят тег " + tag + "."
        : "Версия " + ver.id.slice(0, 8) + " функции «" + fn.name + "» помечена тегом " + tag + " — её постоянный адрес: " + url,
    };
  }

  // ── Вызов ─────────────────────────────────────────────────────────────────
  // Вызов идёт на публичный адрес функции, а не в её API: тот же путь, которым
  // ходят браузер, бот и API Gateway. Ответ — то, что вернул КОД, поэтому он
  // может быть и JSON, и текстом, и HTML.
  const INVOKE_MAX_CHARS = 20000;

  async function invokeUrlOf(oauthToken, fn, tag) {
    const b = await invokeBase();
    return (fn && fn.httpInvokeUrl) ? fn.httpInvokeUrl + (String(tag || "").trim() ? (fn.httpInvokeUrl.indexOf("?") >= 0 ? "&" : "?") + "tag=" + encodeURIComponent(String(tag).trim()) : "") : invokeUrl(fn, tag, b);
  }

  async function invoke(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const tag = opt.tag != null && String(opt.tag).trim() ? checkTag(opt.tag) : "";
    if (tag) {
      const list = await versions(oauthToken, fn.id).catch(() => []);
      if (list.length && !versionWithTag(list, tag) && tag !== "latest") {
        throw new Error("У функции «" + fn.name + "» нет версии с тегом " + tag + ". Есть: " + (stableTags(list).map((x) => x.tag).join(", ") || "постоянных тегов нет") + ".");
      }
    }
    const url = await invokeUrlOf(oauthToken, fn, tag);
    const timeoutMs = Math.min(Math.max(parseInt(opt.timeoutMs, 10) || 60000, 1000), 300000);
    let payload = opt.payload;
    if (typeof payload === "string") {
      const s = payload.trim();
      if (s && (s[0] === "{" || s[0] === "[")) {
        try {
          payload = JSON.parse(s);
        } catch (e) {
          throw new Error("Полезная нагрузка похожа на JSON, но разобрать её не удалось: " + ((e && e.message) || e));
        }
      }
    }
    const bodyText = payload == null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);

    requireApi();
    if (typeof api.fetchText !== "function") throw new Error("Functions: модулю не передан помощник fetchText — без него ответ функции не прочитать (это может быть не JSON).");
    const token = await api.getIamToken(oauthToken);
    const started = Date.now();
    const r = await api.fetchText(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": opt.contentType || "application/json",
      },
      body: bodyText,
    }, timeoutMs);
    const ms = Date.now() - started;
    const text = String((r && r.text) || "");
    const status = Number((r && r.status) || 0);
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (e) {
        json = null;
      }
    }
    const truncated = text.length > INVOKE_MAX_CHARS;
    return {
      function: fn,
      tag: tag,
      url: url,
      status: status,
      ok: status >= 200 && status < 300,
      ms: ms,
      text: truncated ? text.slice(0, INVOKE_MAX_CHARS) : text,
      truncated: truncated,
      json: json,
      hint: invokeHint(status, text, fn),
      message: "Функция «" + fn.name + "» ответила кодом " + status + " за " + ms + " мс" + (tag ? " (версия с тегом " + tag + ")" : " (самая новая версия)") + ".",
    };
  }

  // ── Публичный доступ и привязки ролей ─────────────────────────────────────
  const PUBLIC_SUBJECT = { id: "allUsers", type: "system" };
  const INVOKER_ROLE = "serverless.functions.invoker";

  function bindingInfo(b) {
    const o = b || {};
    const subj = o.subject || {};
    return {
      roleId: o.roleId || "",
      subjectId: subj.id || "",
      subjectType: subj.type || "",
      isPublic: String(subj.id || "") === "allUsers",
      canInvoke: String(o.roleId || "") === INVOKER_ROLE,
    };
  }

  async function accessBindings(oauthToken, functionId) {
    const id = typeof functionId === "string" ? functionId : (functionId && functionId.id) || "";
    const fid = String(id || "").trim();
    if (!fid) throw new Error("Не указана функция для списка привязок ролей.");
    const j = await fns(oauthToken, "GET", "/functions/v1/functions/" + encodeURIComponent(fid) + ":listAccessBindings?pageSize=1000", undefined, 20000);
    return (Array.isArray(j && j.accessBindings) ? j.accessBindings : []).map(bindingInfo);
  }

  function isPublic(bindings) {
    return (bindings || []).some((b) => b.canInvoke && b.isPublic);
  }

  // Сделать функцию публичной или закрыть обратно. Проверяем результат
  // ПЕРЕЧИТЫВАНИЕМ в обе стороны: «200 OK» на привязку значит только то, что
  // запрос принят, а не то, что роль появилась.
  async function setPublic(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const fn = await requireFunction(oauthToken, folderId, opt.function || opt.id || opt.name);
    const on = opt.publicOn !== false && opt.on !== false;
    const before = await accessBindings(oauthToken, fn.id);
    const already = isPublic(before);
    if (on === already) {
      return {
        changed: false,
        function: fn,
        public: already,
        message: on
          ? "Функция «" + fn.name + "» уже публичная — ничего не менял."
          : "Функция «" + fn.name + "» уже закрыта — ничего не менял.",
      };
    }
    const j = await fns(
      oauthToken,
      "POST",
      "/functions/v1/functions/" + encodeURIComponent(fn.id) + ":updateAccessBindings",
      { accessBindingDeltas: [{ action: on ? "ADD" : "REMOVE", accessBinding: { roleId: INVOKER_ROLE, subject: PUBLIC_SUBJECT } }] },
      30000
    );
    await run(oauthToken, j, 300000);

    const after = await accessBindings(oauthToken, fn.id);
    if (isPublic(after) !== on) {
      throw new Error(
        on
          ? "Функция «" + fn.name + "» не стала публичной: роль " + INVOKER_ROLE + " не появилась. Проверь права (functions.admin или functions.editor)."
          : "Функцию «" + fn.name + "» не удалось закрыть: роль " + INVOKER_ROLE + " у allUsers осталась. Проверь права (functions.admin или functions.editor)."
      );
    }
    const url = await invokeUrlOf(oauthToken, fn, opt.tag);
    const warns = [];
    if (on) {
      warns.push("Теперь функцию «" + fn.name + "» может вызвать КТО УГОДНО из интернета, кто знает адрес: " + url + ". Данные и деньги за вызовы уходят наружу — не делай публичной функцию, которая читает базу или секреты по своему усмотрению.");
      warns.push("Закрыть обратно: ycFunctions { action: \"private\", function: \"" + fn.name + "\" }.");
    } else {
      warns.push("Закрытая функция отвечает только тем, у кого есть роль " + INVOKER_ROLE + " на неё: свои сервисы вызывают её с ключом сервисного аккаунта, а API Gateway — по своей привязке.");
    }
    return {
      changed: true,
      function: fn,
      public: on,
      url: url,
      bindings: after,
      warnings: warns,
      message: on ? "Функция «" + fn.name + "» стала публичной: " + url : "Публичный доступ к функции «" + fn.name + "» закрыт.",
    };
  }

  // ── Обзор и карточка ──────────────────────────────────────────────────────
  // Человеку и агенту нужен ответ «что здесь есть и что с этим не так», а не
  // полсотни полей: функция без версий не отвечает, функция без постоянного тега
  // меняет боевой код от каждой выкатки, публичная функция открыта всему миру.
  async function overview(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const list = await functions(oauthToken, folder);
    const rows = await Promise.all(
      list.map(async (fn) => {
        const vers = await versions(oauthToken, fn.id).catch(() => []);
        const binds = await accessBindings(oauthToken, fn.id).catch(() => []);
        const live = activeVersion(vers);
        return {
          function: fn,
          versions: vers,
          versionCount: vers.length,
          active: live,
          tags: stableTags(vers).map((x) => x.tag),
          public: isPublic(binds),
          // Функция без версий физически не может ответить: это недоделка.
          broken: vers.length === 0,
        };
      })
    );
    const broken = rows.filter((r) => r.broken);
    const untagged = rows.filter((r) => !r.broken && !(r.active && r.active.tagged));
    const wideOpen = rows.filter((r) => r.public);

    const lines = [];
    if (!rows.length) lines.push("Функций в каталоге нет. Создать: ycFunctions { action: \"create\", name: \"hello-func\" }.");
    for (const r of rows) {
      lines.push(
        r.function.name +
          " — " + r.function.statusHuman +
          " · версий: " + r.versionCount +
          (r.active ? " · боевая " + r.active.id.slice(0, 8) + " (" + r.active.runtime + ", " + r.active.memoryHuman + ")" : " · БЕЗ ВЕРСИЙ — не отвечает") +
          " · теги: " + (r.tags.join(", ") || "нет") +
          (r.public ? " · ПУБЛИЧНАЯ" : "") +
          " · id " + r.function.id
      );
    }
    if (broken.length) lines.push("Без версий: " + broken.map((r) => r.function.name).join(", ") + " — их нельзя вызвать; кода у функции нет, код живёт в версии.");
    if (untagged.length) lines.push("Без постоянного тега: " + untagged.map((r) => r.function.name).join(", ") + " — у боевой версии постоянного тега нет: адрес без тега всегда ведёт на самую новую версию, то есть следующая выкатка меняет то, что отвечает.");
    if (wideOpen.length) lines.push("Публичные (может позвать кто угодно): " + wideOpen.map((r) => r.function.name).join(", ") + ".");

    return { functions: list, rows, broken, untagged, public: wideOpen, lines, message: "Функций: " + rows.length + "." };
  }

  // Карточка функции словами: что отвечает, чем можно звать, что не так и что
  // будет при удалении. Ровно то, что должно быть видно без чужой консоли.
  function cardLines(fnRaw, ctx) {
    const c = ctx || {};
    const fn = fnRaw && fnRaw.id ? fnRaw : functionInfo(fnRaw);
    const vers = c.versions || [];
    const live = c.active || activeVersion(vers);
    const out = [];
    out.push(fn.name + " — " + fn.statusHuman + (fn.description ? " · " + fn.description : ""));
    out.push("  id: " + (fn.id || "—") + " · создана " + (fn.createdAt || "—") + (fn.ageDays != null ? " (возраст " + fn.ageHuman + ")" : ""));
    out.push("  адрес вызова: " + (fn.httpInvokeUrl || (c.url || "—")) + (c.public ? " · ПУБЛИЧНАЯ (отвечает кому угодно)" : " · закрытая (нужна роль " + INVOKER_ROLE + ")"));
    if (!vers.length) {
      out.push("  версий: НЕТ — функция не отвечает и вызвать её нельзя");
      out.push("    → создай версию: ycFunctions { action: \"deploy\", function: \"" + fn.name + "\", zipFile: \"index.zip\", runtime: \"nodejs22\", entrypoint: \"index.handler\" }.");
      return out;
    }
    out.push("  версий: " + vers.length + (live ? " · отвечает по умолчанию " + live.id.slice(0, 8) + " (" + live.runtime + ", " + live.memoryHuman + ", " + live.timeoutHuman + ")" : ""));
    for (const v of vers.slice(0, 10)) {
      out.push(
        "    " + (v.tags.length ? "★" : "•") + " " + v.id.slice(0, 8) + " · " + v.runtime + " · " + v.memoryHuman + " · " + v.statusHuman +
          " · " + v.ageHuman + (v.tags.length ? " · теги: " + v.tags.join(", ") : "") + (v.envCount ? " · переменных: " + v.envCount : "")
      );
      for (const t of versionTrouble(v, vers)) out.push("      ⚠ " + t);
    }
    if (vers.length > 10) out.push("    …и ещё " + (vers.length - 10) + " версия(й)");
    const tags = stableTags(vers);
    out.push(
      "  постоянные адреса: " + (tags.length ? tags.map((t) => t.tag + " → .../" + fn.id + "?tag=" + t.tag).join("; ") : "НЕТ — боевой адрес поедет от следующей выкатки")
    );
    out.push(
      "  если удалить: уйдут " + vers.length + " версия(ей) и их теги" + (c.public ? ", а публичный адрес перестанет работать у всех" : "") + " — всё, что её вызывало, сломается."
    );
    return out;
  }

  return {
    // чтение
    functions,
    functionInfoById,
    findFunction,
    versions,
    version,
    runtimes,
    accessBindings,
    isPublic,
    overview,
    // функция
    createFunction,
    updateFunction,
    deleteFunction,
    // версии и теги
    createVersion,
    deleteVersion,
    setTag,
    // вызов
    invoke,
    invokeUrl,
    invokeUrlOf,
    // публичность
    setPublic,
    // карточка
    cardLines,
    // Чистые помощники наружу: их читают инструмент агента и канал панели —
    // как у сети, машин и IAM, значения рядом с методами.
    RUNTIMES_HINT,
    PUBLIC_SUBJECT,
    INVOKER_ROLE,
    MEMORY_MIN_MB,
    MEMORY_MAX_MB,
    MEMORY_STEP_MB,
    TIMEOUT_DEFAULT_SEC,
    TIMEOUT_MAX_SEC,
    MAX_CONTENT_MB,
    checkName,
    checkTag,
    checkRuntime,
    parseMemoryMb,
    memoryHuman,
    parseTimeoutSec,
    timeoutHuman,
    statusHuman,
    versionTrouble,
    activeVersion,
    versionWithTag,
    stableTags,
    invokeHint,
  };
}

module.exports = {
  createYcFunctions,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  checkName,
  checkTag,
  checkRuntime,
  parseMemoryMb,
  memoryBytes,
  memoryHuman,
  parseTimeoutSec,
  timeoutHuman,
  statusHuman,
  functionInfo,
  versionInfo,
  activeVersion,
  versionWithTag,
  stableTags,
  versionTrouble,
  invokeHint,
  daysSince,
  humanDays,
  RUNTIMES_HINT,
  MEMORY_MIN_MB,
  MEMORY_MAX_MB,
  MEMORY_STEP_MB,
  TIMEOUT_DEFAULT_SEC,
  TIMEOUT_MAX_SEC,
  MAX_CONTENT_MB,
};

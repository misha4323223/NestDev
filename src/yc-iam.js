"use strict";

/* ── IAM: сервисные аккаунты, ключи и роли ───────────────────────────────────
   Зачем модуль. У всего, что работает САМО (выкатка контейнера, скрипт бэкапа,
   машина, выгрузка из базы), должен быть отдельный «робот» — сервисный аккаунт
   с узкой ролью и своим ключом. Раньше приложение умело только завести аккаунт
   под выкатку внутри деплоя и выдать ему роль; посмотреть, какие аккаунты есть,
   какие у них роли и ключи, чем они пользуются и что сломается при удалении,
   было нечем — и человек шёл в чужую консоль.

   Что важно знать про IAM и не потерять при правке:

     • секрет ключа облако отдаёт РОВНО ОДИН РАЗ — в ответе на создание. Ни один
       метод чтения его не вернёт: у API-ключа вместо секрета приходит
       `maskedSecret` вида «****Ab12cd». Поэтому секрет выходит наружу ТОЛЬКО из
       create*(): вызывающий обязан положить его в хранилище секретов, а не в
       переписку и не в файл;
     • ключ без роли бесполезен, а роль без ключа — просто запись в правах.
       Работает аккаунт, когда у него ЕСТЬ роль на каталог (или на ресурс) И
       есть чем аутентифицироваться. Поэтому при выдаче ключа модуль смотрит
       роли и говорит прямо, если их нет;
     • привязки меняются ДЕЛЬТАМИ (ADD/REMOVE). Это не «запиши список целиком»
       (как правила безопасности в сети): снятие одной роли не задевает
       остальные. Проверять всё равно надо: «роль уже есть» — не повод писать в
       облако, а после записи привязка обязана ПЕРЕЧИТЫВАТЬСЯ;
     • роли бывают примитивные (viewer, editor, admin, auditor — это весь каталог)
       и сервисные (storage.editor, compute.editor). Здесь есть каталог частых
       ролей человеческими словами и подсказка «каких ролей хватит для задачи»,
       чтобы агент предлагал узкую роль вместо «дам editor»;
     • полный список ролей придумывать нельзя — он живой, и модуль берёт его из
       самого облака (`roles`). В каталоге ниже только те роли, о которых агент
       обязан предупредить;
     • удаление сервисного аккаунта ломает всё, что им пользовалось. Поэтому
       перед удалением модуль СОБИРАЕТ, за что аккаунт отвечает (ключи, роли), и
       называет это в предупреждении: молча удалить «робота» — значит утром
       обнаружить, что бэкапы и выкатка не работают;
     • IAM не тарифицируется: аккаунты, роли и ключи бесплатны. Платят за
       ресурсы, к которым роли дают доступ, — «выдать editor» дешевле не станет,
       а вот опаснее станет.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcVpc, createYcCompute и createYcDb):
   IAM-токен, адреса сервисов, разбор сетевых отказов и ожидание операции.
   Поэтому он проверяется в plain-node, на подставных ответах сервиса.

   Правки и удаления здесь делает ТОЛЬКО вызывающий: модуль ничего не решает за
   человека, а возвращает данные и предупреждения. */

const IAM_FALLBACK = "https://iam.api.cloud.yandex.net";
const RM_FALLBACK = "https://resource-manager.api.cloud.yandex.net";

// ── Проверки ввода ─────────────────────────────────────────────────────────
// Имя сервисного аккаунта: строчные латинские буквы, цифры и дефис.
// Подчёркивание облако здесь НЕ принимает (в отличие от имени машины), поэтому
// проверка своя, а не «общая для всех».
const NAME_RE = /^[a-z][-a-z0-9]{0,61}[a-z0-9]$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя сервисного аккаунта: строчные латинские буквы, цифры и дефис (например sa-site).");
  if (NAME_RE.test(nm)) return nm;
  const lower = nm.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (NAME_RE.test(lower)) {
    throw new Error("Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис. Возьми «" + lower + "».");
  }
  throw new Error(
    "Имя «" + nm + "» не подойдёт: нужно 2–63 символа, только строчные латинские буквы, цифры и дефис, начинается с буквы и не заканчивается дефисом. Подойдёт, например, «sa-site»."
  );
}

function checkFolder(folderId) {
  const f = String(folderId || "").trim();
  if (!f) throw new Error("Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.");
  return f;
}

// Роль облака: примитивная (viewer, editor, admin, auditor) или сервисная
// (storage.editor, kms.keys.encrypterDecrypter). Опечатка в роли — это отказ
// сервиса уже на записи, поэтому проверяем сами.
const ROLE_RE = /^(viewer|editor|admin|auditor|[a-z][a-zA-Z0-9-]*(\.[a-zA-Z][a-zA-Z0-9-]*){1,2})$/;

function checkRole(role) {
  const r = String(role == null ? "" : role).trim();
  if (!r) {
    throw new Error("Не указана роль. Узкие роли: storage.editor (файлы в бакете), compute.editor (машины) — полный список: ycIam { action: \"rolemap\" }.");
  }
  if (!ROLE_RE.test(r)) {
    throw new Error("Роль «" + r + "» не похожа на роль облака: она выглядит как storage.editor или lockbox.payloadViewer — начинается со строчной латинской буквы, дальше буквы, цифры, точки и дефис.");
  }
  return r;
}

// ── Статусы аккаунта ───────────────────────────────────────────────────────
// Алгоритмы ключа подписи. Облако принимает ровно эти два значения.
const KEY_ALGORITHMS = ["RSA_2048", "RSA_4096"];

const SA_STATUS = {
  CREATING: "создаётся",
  ACTIVE: "работает",
  SUSPENDED: "приостановлен",
  DELETING: "удаляется",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return SA_STATUS[s] || (s ? s.toLowerCase() : "неизвестно");
}

function isActive(account) {
  return String((account && account.status) || "").toUpperCase() === "ACTIVE";
}

// ── Время ──────────────────────────────────────────────────────────────────
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

// ── Каталог частых ролей и подсказка «каких хватит» ────────────────────────
// kind — насколько роль широкая: read (смотреть), write (менять своё),
// secret (доступ к секретам или шифрованию), wide (почти весь каталог).
const ROLE_CATALOG = [
  { id: "viewer", kind: "wide", title: "читать всё в каталоге", note: "примитивная роль: видно ВСЕ ресурсы каталога" },
  { id: "editor", kind: "wide", title: "менять всё, кроме прав", note: "примитивная роль: почти весь каталог, включая удаление" },
  { id: "admin", kind: "wide", title: "всё, включая выдачу прав", note: "самая широкая роль каталога: ей можно выдать себе что угодно" },
  { id: "auditor", kind: "read", title: "смотреть настройки ресурсов", note: "без доступа к данным внутри них" },
  { id: "compute.editor", kind: "write", title: "машины и снимки", note: "создавать, менять и удалять ВМ" },
  { id: "compute.viewer", kind: "read", title: "машины и снимки — только смотреть" },
  { id: "compute.images.user", kind: "read", title: "использовать публичные образы", note: "хватает, чтобы поднять машину из стандартного образа" },
  { id: "vpc.admin", kind: "write", title: "сеть: подсети, группы, адреса", note: "включая публичные IP и правила безопасности — это выход в интернет" },
  { id: "storage.editor", kind: "write", title: "файлы в бакетах", note: "читать, класть и удалять объекты Object Storage" },
  { id: "storage.viewer", kind: "read", title: "файлы в бакетах — только смотреть" },
  { id: "container-registry.images.puller", kind: "read", title: "скачивать образы реестра", note: "нужна тому, кто поднимает контейнер" },
  { id: "serverless.containers.editor", kind: "write", title: "выкатывать и менять контейнеры" },
  { id: "serverless.containers.invoker", kind: "write", title: "вызывать контейнер", note: "именно эта роль открывает контейнер наружу — проверено приложением при деплое" },
  { id: "lockbox.payloadViewer", kind: "secret", title: "читать СОДЕРЖИМОЕ секретов", note: "открывает значения секретов Lockbox (пароли, ключи API)" },
  { id: "kms.keys.encrypterDecrypter", kind: "secret", title: "шифровать и расшифровывать ключом KMS", note: "доступ к шифрованию, а не к самому ключу" },
  { id: "logging.viewer", kind: "read", title: "читать логи" },
  { id: "monitoring.viewer", kind: "read", title: "читать метрики" },
  { id: "ydb.editor", kind: "write", title: "таблицы и записи базы YDB" },
  { id: "iam.serviceAccounts.user", kind: "wide", title: "действовать ОТ ИМЕНИ аккаунта", note: "разрешает пользоваться аккаунтом, а не только смотреть на него" },
];

const ROLE_BY_ID = (() => {
  const m = {};
  for (const r of ROLE_CATALOG) m[r.id] = r;
  return m;
})();

function roleInfo(role) {
  const id = String(role || "").trim();
  const found = ROLE_BY_ID[id];
  return {
    id: id,
    known: !!found,
    kind: found ? found.kind : "",
    title: found ? found.title : "",
    note: found ? found.note : "",
  };
}

// Человеческая строка роли: «storage.editor — файлы в бакетах».
function roleHuman(role) {
  const i = roleInfo(role);
  if (!i.id) return "—";
  return i.title ? i.id + " — " + i.title : i.id;
}

// Насколько роль широкая. Незнакомую роль не называем «безопасной»: пусто —
// значит «не знаю», и это честнее выдуманного «узкая».
function roleDanger(role) {
  return roleInfo(role).kind;
}

// «Каких ролей хватит для задачи». Ключи фиксированы, потому что по ним
// отвечает и инструмент агента, и панель: свободный текст тут не нужен.
const TASKS = [
  {
    key: "site",
    title: "сайт или файлы в бакете",
    roles: ["storage.editor"],
    note: "если сайт читается из бакета, для публичного доступа роль не нужна вовсе — нужен открытый бакет на чтение",
  },
  {
    key: "vm",
    title: "машина с сайтом или ботом",
    roles: ["compute.editor"],
    note: "роль нужна только тогда, когда аккаунт сам управляет машинами; внутрь машины он не входит — туда входят ключом SSH",
  },
  {
    key: "containers",
    title: "выкатка контейнера",
    roles: ["serverless.containers.editor", "container-registry.images.puller"],
    note: "и отдельно lockbox.payloadViewer, если ревизия читает секреты",
  },
  {
    key: "secrets",
    title: "читать секреты Lockbox",
    roles: ["lockbox.payloadViewer"],
    note: "эта роль открывает ЗНАЧЕНИЯ секретов — выдавай её только тому, кто без неё не работает, и лучше на один секрет, а не на каталог",
  },
  {
    key: "db",
    title: "таблицы и записи базы YDB",
    roles: ["ydb.editor"],
    note: "для чтения без изменений: ydb.viewer",
  },
  {
    key: "logs",
    title: "логи и метрики",
    roles: ["logging.viewer", "monitoring.viewer"],
    note: "безопасный набор: только чтение",
  },
  {
    key: "readonly",
    title: "смотреть, но не менять",
    roles: ["viewer"],
    note: "viewer видит все ресурсы каталога, но ничего не может изменить — это и есть «безопасный максимум»",
  },
];

const TASK_KEYS = TASKS.map((t) => t.key);

function minimalRoles(task) {
  const key = String(task == null ? "" : task).trim().toLowerCase();
  if (!key) return null;
  const t = TASKS.find((x) => x.key === key) || TASKS.find((x) => key && (x.title.indexOf(key) >= 0 || x.key.indexOf(key) === 0));
  if (!t) return null;
  return { key: t.key, title: t.title, roles: t.roles.slice(), note: t.note || "" };
}

// Примитивные роли действуют на весь каталог — о них предупреждаем отдельно.
const PRIMITIVE_ROLES = ["viewer", "editor", "admin", "auditor"];

function isPrimitiveRole(role) {
  return PRIMITIVE_ROLES.indexOf(String(role || "").trim()) >= 0;
}

// ── Нормализация ответов сервиса ────────────────────────────────────────────
// Карточке и агенту нужны стабильные имена полей, а не то, что вернул сервис.

function accountInfo(a) {
  const o = a || {};
  const age = daysSince(o.createdAt);
  const lastAuth = daysSince(o.lastAuthenticatedAt);
  return {
    id: o.id || "",
    folderId: o.folderId || "",
    name: o.name || "",
    description: o.description || "",
    labels: o.labels || {},
    createdAt: o.createdAt || "",
    ageDays: age,
    ageHuman: humanDays(age),
    lastAuthenticatedAt: o.lastAuthenticatedAt || "",
    lastAuthDays: lastAuth,
    lastAuthHuman: o.lastAuthenticatedAt ? humanDays(lastAuth) : "",
    neverAuthenticated: !o.lastAuthenticatedAt,
    status: o.status || "",
    statusHuman: statusHuman(o.status),
    active: isActive(o),
    expiresAt: o.expiresAt || "",
  };
}

function accessKeyInfo(k) {
  const o = k || {};
  const used = daysSince(o.lastUsedAt);
  return {
    kind: "access",
    id: o.id || "",
    serviceAccountId: o.serviceAccountId || "",
    description: o.description || "",
    keyId: o.keyId || "",
    createdAt: o.createdAt || "",
    lastUsedAt: o.lastUsedAt || "",
    usedDays: used,
    usedHuman: o.lastUsedAt ? humanDays(used) : "ни разу не использовался",
    ageDays: daysSince(o.createdAt),
    ageHuman: humanDays(daysSince(o.createdAt)),
  };
}

function apiKeyInfo(k) {
  const o = k || {};
  const used = daysSince(o.lastUsedAt);
  return {
    kind: "api",
    id: o.id || "",
    serviceAccountId: o.serviceAccountId || "",
    description: o.description || "",
    createdAt: o.createdAt || "",
    lastUsedAt: o.lastUsedAt || "",
    usedDays: used,
    usedHuman: o.lastUsedAt ? humanDays(used) : "ни разу не использовался",
    ageDays: daysSince(o.createdAt),
    ageHuman: humanDays(daysSince(o.createdAt)),
    expiresAt: o.expiresAt || "",
    scopes: Array.isArray(o.scopes) ? o.scopes.map(String) : o.scope ? [String(o.scope)] : [],
    // Секрет облако показывает один раз; здесь только маска — «****Ab12cd».
    maskedSecret: o.maskedSecret || "",
  };
}

function authorizedKeyInfo(k) {
  const o = k || {};
  const used = daysSince(o.lastUsedAt);
  return {
    kind: "authorized",
    id: o.id || "",
    serviceAccountId: o.serviceAccountId || "",
    userAccountId: o.userAccountId || "",
    description: o.description || "",
    keyAlgorithm: o.keyAlgorithm || "",
    publicKey: o.publicKey || "",
    createdAt: o.createdAt || "",
    lastUsedAt: o.lastUsedAt || "",
    usedDays: used,
    usedHuman: o.lastUsedAt ? humanDays(used) : "ни разу не использовался",
    ageDays: daysSince(o.createdAt),
    ageHuman: humanDays(daysSince(o.createdAt)),
  };
}

function bindingInfo(b) {
  const o = b || {};
  const subj = o.subject || {};
  return {
    roleId: o.roleId || "",
    roleHuman: roleHuman(o.roleId),
    roleKind: roleDanger(o.roleId),
    subjectId: subj.id || "",
    subjectType: subj.type || "",
    isServiceAccount: String(subj.type || "") === "serviceAccount",
    isPublic: String(subj.id || "") === "allUsers" || String(subj.id || "") === "allAuthenticatedUsers",
  };
}

// ── Что не так с ключом ─────────────────────────────────────────────────────
// Ключи — это доступ. Мёртвый ключ (создан давно, ни разу не использовался)
// надо удалять: он ничего не делает, а утечёт — сделает. Пустая строка = «всё в
// порядке», поэтому функцию удобно складывать в список предупреждений.
const KEY_IDLE_DAYS = 90;

function keyTrouble(key) {
  const k = key || {};
  if (!k.lastUsedAt) {
    return k.ageDays != null && k.ageDays > 7
      ? "создан " + k.ageHuman + " и НИ РАЗУ не использовался — скорее всего, он не нужен"
      : "пока ни разу не использовался";
  }
  if (k.usedDays != null && k.usedDays >= KEY_IDLE_DAYS) return "не использовался " + k.usedDays + " дн. — вероятно, им уже никто не пользуется";
  return "";
}

function createYcIam(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError = typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("IAM: модулю не переданы помощники облака (fetchJson, getIamToken).");
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

  function iam(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "iam", IAM_FALLBACK, method, path, body, timeoutMs);
  }

  function rm(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "resource-manager", RM_FALLBACK, method, path, body, timeoutMs);
  }

  // Ожидание операции. Возвращаем тело операции: у создания аккаунта id
  // готового объекта приходит только в response (та же тонкость, что у машин).
  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 180000);
    return op || {};
  }

  // Удаление ключа у части сервисов отвечает операцией, у части — пустым телом.
  // Поэтому ждём операцию ТОЛЬКО если её выдали: иначе ждать нечего.
  async function maybeRun(oauthToken, j, timeoutMs) {
    if (j && j.id) return run(oauthToken, j, timeoutMs);
    return {};
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  async function serviceAccounts(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await iam(
      oauthToken,
      "GET",
      "/iam/v1/serviceAccounts?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.serviceAccounts) ? j.serviceAccounts : []).map(accountInfo);
  }

  async function serviceAccount(oauthToken, id) {
    const i = String(id || "").trim();
    if (!i) throw new Error("Не указан id сервисного аккаунта.");
    return accountInfo(await iam(oauthToken, "GET", "/iam/v1/serviceAccounts/" + encodeURIComponent(i), undefined, 20000));
  }

  async function findServiceAccount(oauthToken, folderId, ref) {
    const list = await serviceAccounts(oauthToken, folderId);
    const q = String(ref == null ? "" : ref).trim();
    const got = list.find((a) => a.id === q) || list.find((a) => a.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  // Внутренний помощник: аккаунт по id или по имени в каталоге. Через него
  // работают и ключи, и роли, чтобы «имя или id» понималось одинаково везде.
  async function resolveAccount(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    if (!q) throw new Error("Укажи сервисный аккаунт: имя или id (список: ycIam { action: \"list\" }).");
    const found = await findServiceAccount(oauthToken, folderId, q);
    if (found) return found;
    // Не нашли в каталоге — возможно, это id аккаунта из другого каталога.
    const byId = await serviceAccount(oauthToken, q).catch(() => null);
    if (byId && byId.id) return byId;
    throw new Error("Не нашёл сервисный аккаунт «" + q + "» в каталоге.");
  }

  async function accessKeys(oauthToken, saId) {
    const id = String(saId || "").trim();
    if (!id) throw new Error("Не указан сервисный аккаунт для списка ключей доступа.");
    const j = await iam(
      oauthToken,
      "GET",
      "/iam/aws-compatibility/v1/accessKeys?serviceAccountId=" + encodeURIComponent(id) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.accessKeys) ? j.accessKeys : []).map(accessKeyInfo);
  }

  async function apiKeys(oauthToken, saId) {
    const id = String(saId || "").trim();
    if (!id) throw new Error("Не указан сервисный аккаунт для списка API-ключей.");
    const j = await iam(
      oauthToken,
      "GET",
      "/iam/v1/apiKeys?serviceAccountId=" + encodeURIComponent(id) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.apiKeys) ? j.apiKeys : []).map(apiKeyInfo);
  }

  async function authorizedKeys(oauthToken, saId) {
    const id = String(saId || "").trim();
    if (!id) throw new Error("Не указан сервисный аккаунт для списка ключей подписи.");
    const j = await iam(
      oauthToken,
      "GET",
      "/iam/v1/keys?serviceAccountId=" + encodeURIComponent(id) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.keys) ? j.keys : []).map(authorizedKeyInfo);
  }

  // Все ключи аккаунта сразу: у одного «робота» их бывает три вида, и человеку
  // нужен ответ «чем он ходит в облако», а не три отдельных списка.
  async function allKeys(oauthToken, saId) {
    const [access, apiK, authorized] = await Promise.all([
      accessKeys(oauthToken, saId).catch((e) => ({ error: (e && e.message) || String(e) })),
      apiKeys(oauthToken, saId).catch((e) => ({ error: (e && e.message) || String(e) })),
      authorizedKeys(oauthToken, saId).catch((e) => ({ error: (e && e.message) || String(e) })),
    ]);
    const list = [].concat(Array.isArray(access) ? access : [], Array.isArray(apiK) ? apiK : [], Array.isArray(authorized) ? authorized : []);
    const errors = [access, apiK, authorized].filter((x) => x && x.error).map((x) => x.error);
    return {
      accessKeys: Array.isArray(access) ? access : [],
      apiKeys: Array.isArray(apiK) ? apiK : [],
      authorizedKeys: Array.isArray(authorized) ? authorized : [],
      keys: list,
      errors: errors,
      total: list.length,
      troubles: list.map(keyTrouble).filter(Boolean),
    };
  }

  // Полный список ролей облака. Придумывать его нельзя: он живой и меняется.
  async function roles(oauthToken, filter) {
    const f = String(filter || "").trim();
    const j = await iam(
      oauthToken,
      "GET",
      "/iam/v1/roles?pageSize=1000" + (f ? "&filter=" + encodeURIComponent(f) : ""),
      undefined,
      25000
    );
    return (Array.isArray(j && j.roles) ? j.roles : []).map((r) => ({
      id: r.id || "",
      description: r.description || "",
      known: !!ROLE_BY_ID[r.id || ""],
      kind: roleDanger(r.id),
    }));
  }

  // Привязки каталога — это «кому что выдано». Ролей у каталога бывает много
  // (в том числе людям и группам), поэтому фильтр по аккаунту — отдельная
  // функция: так видно и «что вообще выдано», и «что выдано этому роботу».
  async function bindings(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await rm(
      oauthToken,
      "GET",
      "/resource-manager/v1/folders/" + encodeURIComponent(folder) + ":listAccessBindings?pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.accessBindings) ? j.accessBindings : []).map(bindingInfo);
  }

  async function bindingsFor(oauthToken, folderId, saId) {
    const id = String(saId || "").trim();
    const all = await bindings(oauthToken, folderId);
    return all.filter((b) => b.subjectId === id);
  }

  // ── Обзор: кто чем пользуется ──────────────────────────────────────────────
  // Один запрос вместо «пять экранов»: аккаунты, их роли, их ключи и что
  // брошено. Именно сюда смотрит человек, когда спрашивает «а это ещё нужно?».
  async function overview(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const accounts = await serviceAccounts(oauthToken, folder);
    const all = await bindings(oauthToken, folder).catch(() => []);

    const rows = await Promise.all(
      accounts.map(async (a) => {
        const own = all.filter((b) => b.subjectId === a.id);
        const keys = await allKeys(oauthToken, a.id).catch(() => null);
        return {
          account: a,
          roles: own,
          roleIds: own.map((b) => b.roleId),
          keys: keys,
          keyCount: keys ? keys.total : 0,
          // «Робот без роли» — это аккаунт, которым нельзя ничего сделать: либо
          // он недоделан, либо роль сняли, а он остался.
          useless: own.length === 0,
          broken: !keys || keys.total === 0,
        };
      })
    );

    const useless = rows.filter((r) => r.useless);
    const keyless = rows.filter((r) => !r.useless && r.broken);
    const stale = rows.filter((r) => r.keys && r.keys.troubles.length);
    const neverUsed = rows.filter((r) => r.account.neverAuthenticated && r.keyCount > 0);

    const lines = [];
    if (!rows.length) lines.push("Сервисных аккаунтов в каталоге нет: всё, что работает само, ходит под аккаунтом человека.");
    for (const r of rows) {
      lines.push(
        r.account.name +
          " — " +
          r.account.statusHuman +
          " · роли: " +
          (r.roleIds.length ? r.roleIds.map((x) => roleHuman(x)).join("; ") : "НЕТ — аккаунт не может ничего") +
          " · ключей: " +
          r.keyCount +
          (r.account.lastAuthenticatedAt ? " · последний вход " + r.account.lastAuthHuman : " · ни разу не входил")
      );
      for (const t of (r.keys && r.keys.troubles) || []) lines.push("  ⚠ " + t);
    }
    if (useless.length) lines.push("Без ролей: " + useless.map((r) => r.account.name).join(", ") + " — либо выдай узкую роль, либо удали.");
    if (stale.length) lines.push("Ключи, которые стоит пересмотреть: " + stale.map((r) => r.account.name).join(", ") + ".");
    if (neverUsed.length) lines.push("Ни разу не входили, хотя ключи есть: " + neverUsed.map((r) => r.account.name).join(", ") + " — проверь, не ключ ли это «про запас».");

    return {
      accounts,
      rows,
      bindings: all,
      useless,
      keyless,
      stale,
      neverUsed,
      lines,
      message: "Сервисных аккаунтов: " + rows.length + ", привязок ролей в каталоге: " + all.length + ".",
    };
  }

  // ── Сервисные аккаунты: создание, правка, удаление ─────────────────────────

  async function createServiceAccount(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    const body = { folderId, name };
    if (opt.description) body.description = String(opt.description);
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;
    if (opt.expiresAt) body.expiresAt = String(opt.expiresAt);

    const j = await iam(oauthToken, "POST", "/iam/v1/serviceAccounts", body, 30000);
    const op = await run(oauthToken, j, 180000);
    const id = (op.response && op.response.id) || "";
    const made = id ? await serviceAccount(oauthToken, id).catch(() => null) : await findServiceAccount(oauthToken, folderId, name);
    if (!made) throw new Error("Аккаунт «" + name + "» создан, но не найден в каталоге — проверь права (iam.serviceAccounts.editor) и повтори список.");

    return {
      account: made,
      message: "Сервисный аккаунт «" + made.name + "» создан (" + made.id + ").",
      warnings: [
        "Аккаунт без роли не может ничего: выдай узкую роль (ycIam { action: \"grant\", account: \"" + made.name + "\", role: \"storage.editor\" }) — и не выдавай editor «на всякий случай».",
        "Аккаунт без ключа не может войти: ключ нужен только тому, кто работает вне облака (скрипт, выкатка, машина).",
      ],
    };
  }

  async function updateServiceAccount(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account || opt.name);
    const fields = [];
    const body = {};
    if (opt.newName != null && String(opt.newName).trim()) {
      const nm = checkName(opt.newName);
      if (nm !== acc.name) {
        body.name = nm;
        fields.push("name");
      }
    }
    if (opt.description != null) {
      const d = String(opt.description).trim();
      if (d !== String(acc.description || "")) {
        body.description = d;
        fields.push("description");
      }
    }
    if (!fields.length) {
      return { changed: false, account: acc, message: "У аккаунта «" + acc.name + "» нечего менять: имя и описание те же." };
    }
    // Маска обязательна: без неё сервис сбросит всё, чего нет в теле (у аккаунта
    // это метки и срок жизни).
    body.updateMask = fields.join(",");
    const j = await iam(oauthToken, "PATCH", "/iam/v1/serviceAccounts/" + encodeURIComponent(acc.id), body, 30000);
    await run(oauthToken, j, 180000);
    const after = await serviceAccount(oauthToken, acc.id).catch(() => null);
    if (!after) throw new Error("Аккаунт «" + acc.name + "» не перечитался после правки — проверь его в списке.");
    const ok = (!body.name || after.name === body.name) && (!fields.includes("description") || after.description === body.description);
    if (!ok) throw new Error("Правка аккаунта «" + acc.name + "» не применилась: имя «" + after.name + "», описание «" + after.description + "». Проверь права (iam.serviceAccounts.editor).");
    return { changed: true, account: after, message: "Аккаунт «" + after.name + "» обновлён (" + fields.join(", ") + ")." };
  }

  // Удаление: сначала собираем, за что аккаунт отвечает, и только потом удаляем.
  // Так человек видит, что именно перестанет работать, а не узнаёт об этом утром.
  async function deleteServiceAccount(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account || opt.name);

    const keys = await allKeys(oauthToken, acc.id).catch(() => null);
    const own = await bindingsFor(oauthToken, folderId, acc.id).catch(() => []);

    const j = await iam(oauthToken, "DELETE", "/iam/v1/serviceAccounts/" + encodeURIComponent(acc.id), undefined, 30000);
    await run(oauthToken, j, 180000);

    const left = await serviceAccount(oauthToken, acc.id).catch(() => null);
    if (left) throw new Error("Аккаунт «" + acc.name + "» не удалился: он ещё существует. Проверь права (iam.serviceAccounts.editor) в каталоге.");

    const warns = [];
    if (keys && keys.total) {
      warns.push(
        "Вместе с аккаунтом перестали работать его ключи (" +
          keys.total +
          "): " +
          keys.keys.map((k) => (k.description || k.keyId || k.id) + " (" + k.usedHuman + ")").join(", ") +
          ". Если этими ключами ходил скрипт или выкатка — они сломаются."
      );
    }
    if (own.length) {
      warns.push("Сняты роли, которые были выданы аккаунту: " + own.map((b) => b.roleId).join(", ") + ".");
    }
    warns.push("Записи в логах и ресурсы, созданные этим аккаунтом, остаются — удаляется только доступ.");
    return {
      deleted: true,
      account: acc,
      keys: keys ? keys.keys : [],
      roles: own,
      warnings: warns,
      message: "Сервисный аккаунт «" + acc.name + "» удалён" + (keys && keys.total ? " вместе с " + keys.total + " ключом(ами)" : "") + ".",
    };
  }

  // ── Роли: выдать и снять ───────────────────────────────────────────────────
  // Дельты, а не список целиком: снятие одной роли не задевает остальные. Но и
  // «уже выдано» — не повод писать в облако, а результат обязан подтверждаться
  // перечитыванием привязок (иначе агент отчитается о правах, которых нет).

  function bindingBody(action, roleId, saId) {
    return {
      accessBindingDeltas: [
        { action: action, accessBinding: { roleId: roleId, subject: { id: saId, type: "serviceAccount" } } },
      ],
    };
  }

  async function grantRole(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account);
    const role = checkRole(opt.role);

    const before = await bindingsFor(oauthToken, folderId, acc.id);
    if (before.some((b) => b.roleId === role)) {
      return { changed: false, account: acc, role: role, roles: before.map((b) => b.roleId), warnings: [], message: "У аккаунта «" + acc.name + "» роль " + role + " уже есть — ничего не менял." };
    }

    const j = await rm(
      oauthToken,
      "POST",
      "/resource-manager/v1/folders/" + encodeURIComponent(folderId) + ":updateAccessBindings",
      bindingBody("ADD", role, acc.id),
      30000
    );
    await run(oauthToken, j, 180000);

    const after = await bindingsFor(oauthToken, folderId, acc.id);
    if (!after.some((b) => b.roleId === role)) {
      throw new Error(
        "Роль " + role + " не появилась у аккаунта «" + acc.name + "». Проверь права на выдачу ролей (resource-manager.admin или iam.admin) в каталоге."
      );
    }

    const warns = [];
    const danger = roleDanger(role);
    if (danger === "wide") warns.push(role + " — " + roleInfo(role).title + ". Это ШИРОКАЯ роль: она даёт доступ почти ко всему каталогу. Для «просто чтобы работало» она не нужна — есть узкие роли.");
    if (danger === "secret") warns.push(role + " открывает ДАННЫЕ: " + roleInfo(role).note + ". Выдавай только тому, кто без этого не работает.");
    if (isPrimitiveRole(role) && role !== "viewer" && role !== "auditor") {
      warns.push("Вместо " + role + " чаще хватает узкой роли: " + TASKS.map((t) => t.roles[0]).slice(0, 3).join(", ") + " (подробнее: ycIam { action: \"suggest\" }).");
    }
    warns.push("Роль действует на ВЕСЬ каталог. Если доступ нужен к одному ресурсу — роль надо выдавать на сам ресурс, а не на каталог.");

    return {
      changed: true,
      account: acc,
      role: role,
      roles: after.map((b) => b.roleId),
      warnings: warns,
      message: "Аккаунту «" + acc.name + "» выдана роль " + role + " на каталог.",
    };
  }

  async function revokeRole(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account);
    const role = checkRole(opt.role);

    const before = await bindingsFor(oauthToken, folderId, acc.id);
    if (!before.some((b) => b.roleId === role)) {
      throw new Error("У аккаунта «" + acc.name + "» роли " + role + " и так нет. Что выдано: " + (before.map((b) => b.roleId).join(", ") || "ничего") + ".");
    }

    const j = await rm(
      oauthToken,
      "POST",
      "/resource-manager/v1/folders/" + encodeURIComponent(folderId) + ":updateAccessBindings",
      bindingBody("REMOVE", role, acc.id),
      30000
    );
    await run(oauthToken, j, 180000);

    const after = await bindingsFor(oauthToken, folderId, acc.id);
    if (after.some((b) => b.roleId === role)) {
      throw new Error("Роль " + role + " не снялась с аккаунта «" + acc.name + "» — она всё ещё выдана. Проверь права на выдачу ролей.");
    }

    const warns = [];
    if (!after.length) {
      warns.push("У аккаунта «" + acc.name + "» не осталось НИ ОДНОЙ роли: он больше ничего не может. Всё, что под ним работало, сломается.");
    }
    if (role === "lockbox.payloadViewer") warns.push("Секреты, которые читал аккаунт, станут для него недоступны: выкатка контейнера с секретами упадёт.");
    return {
      changed: true,
      account: acc,
      role: role,
      roles: after.map((b) => b.roleId),
      warnings: warns,
      message: "С аккаунта «" + acc.name + "» снята роль " + role + ".",
    };
  }

  // ── Ключи ─────────────────────────────────────────────────────────────────
  // Три вида ключей — три разных назначения:
  //   доступ     (access key)   — S3-совместимый: Object Storage, скрипты, бэкапы;
  //   API        (api key)      — ключ для вызова API сервисов (API Gateway, функции);
  //   подписи    (authorized)   — пара ключей для SSH/подписи, публичная часть
  //                               уезжает в метаданные машины.
  // Секрет каждого из них облако отдаёт РОВНО ОДИН РАЗ. Поэтому create*()
  // возвращает secret/privateKey, а вызывающий обязан положить его в хранилище
  // секретов — в переписку и журнал прогона такому значению нельзя.

  async function createAccessKey(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account);
    const body = { serviceAccountId: acc.id };
    if (opt.description) body.description = String(opt.description);

    const j = await iam(oauthToken, "POST", "/iam/aws-compatibility/v1/accessKeys", body, 30000);
    if (!j || !j.accessKey || !j.secret) throw new Error("Ключ доступа не создался: сервис не вернул секрет. Повтори и проверь права (iam.serviceAccounts.editor).");
    const key = accessKeyInfo(j.accessKey);
    const warns = [];
    if (!key.keyId) warns.push("Сервис не вернул keyId — ключ может быть нерабочим; перечитай список ключей аккаунта.");
    return {
      account: acc,
      key: key,
      secret: String(j.secret),
      // Ключ даёт ровно те права, что роли аккаунта: без роли он бесполезен.
      message: "Ключ доступа для «" + acc.name + "» создан (keyId " + (key.keyId || "—") + ").",
      warnings: warns.concat([
        "Секрет этого ключа больше НЕ ПОКАЖУТ ни в списке, ни здесь: сохрани его сразу.",
        "Ключ работает только с ролями аккаунта: без роли он ничего не откроет, а с широкой ролью откроет почти всё.",
      ]),
    };
  }

  async function deleteAccessKey(oauthToken, keyId) {
    const id = String(keyId || "").trim();
    if (!id) throw new Error("Не указан id ключа доступа (список: ycIam { action: \"card\", account: \"имя\" }).");
    const j = await iam(oauthToken, "DELETE", "/iam/aws-compatibility/v1/accessKeys/" + encodeURIComponent(id), undefined, 30000);
    await maybeRun(oauthToken, j, 120000);
    return { deleted: true, id: id, message: "Ключ доступа " + id + " удалён. Всё, что им пользовалось, больше не войдёт." };
  }

  async function createApiKey(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account);
    const body = { serviceAccountId: acc.id };
    if (opt.description) body.description = String(opt.description);
    if (opt.scopes) body.scopes = [].concat(opt.scopes).map(String);
    if (opt.expiresAt) body.expiresAt = String(opt.expiresAt);

    const j = await iam(oauthToken, "POST", "/iam/v1/apiKeys", body, 30000);
    if (!j || !j.apiKey || !j.secret) throw new Error("API-ключ не создался: сервис не вернул секрет. Повтори и проверь права (iam.serviceAccounts.editor).");
    return {
      account: acc,
      key: apiKeyInfo(j.apiKey),
      secret: String(j.secret),
      message: "API-ключ для «" + acc.name + "» создан (id " + ((j.apiKey && j.apiKey.id) || "—") + ").",
      warnings: [
        "Секрет API-ключа показывается ОДИН раз — сохрани его сразу.",
        opt.expiresAt
          ? "Срок ключа: " + opt.expiresAt + ". После него ключ перестанет работать — это защита, а не поломка."
          : "У ключа нет срока действия: он будет работать, пока его не удалят. Если он нужен на время — задавай expiresAt.",
      ],
    };
  }

  async function deleteApiKey(oauthToken, keyId) {
    const id = String(keyId || "").trim();
    if (!id) throw new Error("Не указан id API-ключа (список: ycIam { action: \"card\", account: \"имя\" }).");
    const j = await iam(oauthToken, "DELETE", "/iam/v1/apiKeys/" + encodeURIComponent(id), undefined, 30000);
    await maybeRun(oauthToken, j, 120000);
    return { deleted: true, id: id, message: "API-ключ " + id + " удалён." };
  }

  async function createAuthorizedKey(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const acc = await resolveAccount(oauthToken, folderId, opt.saId || opt.account);
    const alg = String(opt.algorithm || opt.keyAlgorithm || "RSA_2048").trim().toUpperCase();
    if (KEY_ALGORITHMS.indexOf(alg) < 0) throw new Error("Алгоритм «" + alg + "» не бывает. Доступно: " + KEY_ALGORITHMS.join(", ") + ".");
    const body = { serviceAccountId: acc.id, keyAlgorithm: alg };
    if (opt.description) body.description = String(opt.description);

    const j = await iam(oauthToken, "POST", "/iam/v1/keys", body, 30000);
    if (!j || !j.key) throw new Error("Пара ключей не создалась: сервис не вернул ключ. Повтори и проверь права (iam.serviceAccounts.editor).");
    return {
      account: acc,
      key: authorizedKeyInfo(j.key),
      privateKey: String(j.privateKey || ""),
      message: "Пара ключей для «" + acc.name + "» создана (" + alg + ", ключ " + ((j.key && j.key.id) || "—") + ").",
      warnings: [
        "Приватная часть показывается ОДИН раз: сохрани её сразу (её место — секрет Lockbox или файл у человека, но не переписка).",
        "Публичная часть уходит в метаданные машины (ssh-keys) — тогда под аккаунтом можно входить по SSH.",
      ],
    };
  }

  async function deleteKey(oauthToken, keyId) {
    const id = String(keyId || "").trim();
    if (!id) throw new Error("Не указан id ключа подписи (список: ycIam { action: \"card\", account: \"имя\" }).");
    const j = await iam(oauthToken, "DELETE", "/iam/v1/keys/" + encodeURIComponent(id), undefined, 30000);
    await maybeRun(oauthToken, j, 120000);
    return { deleted: true, id: id, message: "Ключ подписи " + id + " удалён." };
  }

  // Удаление ключа любого вида одним действием: человеку не нужно помнить, какой
  // это был ключ, — карточка аккаунта показывает вид (kind) рядом с id.
  async function deleteKeyByKind(oauthToken, kind, keyId) {
    const k = String(kind || "").trim().toLowerCase();
    if (k === "access" || k === "accesskey" || k === "доступ") return deleteAccessKey(oauthToken, keyId);
    if (k === "api" || k === "apikey") return deleteApiKey(oauthToken, keyId);
    if (k === "authorized" || k === "key" || k === "подписи") return deleteKey(oauthToken, keyId);
    throw new Error("Не понял вид ключа «" + kind + "». Доступно: access (ключ доступа), api (API-ключ), authorized (ключ подписи).");
  }

  // ── Карточка аккаунта ─────────────────────────────────────────────────────
  // Одна страница человеческими словами: чем занят, что может, чем входит и что
  // сломается, если его удалить. Ровно то, что должно быть видно без чужой консоли.
  function cardLines(acc, ctx) {
    const c = ctx || {};
    const a = acc && acc.id ? acc : accountInfo(acc);
    const keys = c.keys || null;
    const roles = c.roles || [];
    const out = [];
    out.push(a.name + " — " + a.statusHuman + (a.description ? " · " + a.description : ""));
    out.push("  id: " + (a.id || "—") + (a.folderId ? " · каталог " + a.folderId : ""));
    out.push("  создан: " + (a.createdAt || "—") + (a.ageDays != null ? " (возраст " + a.ageHuman + ")" : ""));
    out.push(
      "  вход в облако: " +
        (a.lastAuthenticatedAt ? a.lastAuthHuman : "НИ РАЗУ не входил — либо ключом не пользуются, либо он не нужен")
    );
    if (a.expiresAt) out.push("  сам аккаунт истекает: " + a.expiresAt);
    out.push(
      "  роли в каталоге: " + (roles.length ? roles.map((r) => (r.roleHuman || roleHuman(r.roleId || r))).join("; ") : "НЕТ — аккаунт ничего не может")
    );
    if (!roles.length) out.push("    → без роли аккаунт бесполезен: выдай узкую роль (ycIam { action: \"grant\" }) или удали его.");
    const wide = roles.filter((r) => roleDanger(r.roleId || r) === "wide" || roleDanger(r.roleId || r) === "secret");
    if (wide.length) out.push("    → широкие роли: " + wide.map((r) => r.roleId || r).join(", ") + " — проверь, нужны ли они: узкая роль обычно хватает.");
    if (keys) {
      out.push("  ключи (" + keys.total + "):");
      if (!keys.total) out.push("    — ни одного: снаружи облака под этим аккаунтом войти нельзя");
      for (const k of keys.accessKeys) out.push("    • доступ: " + (k.description || k.keyId) + " · " + k.usedHuman + " · id " + k.id);
      for (const k of keys.apiKeys) out.push("    • API: " + (k.description || k.id) + " · " + k.usedHuman + (k.expiresAt ? " · истекает " + k.expiresAt : " · бессрочный") + " · маска " + (k.maskedSecret || "—"));
      for (const k of keys.authorizedKeys) out.push("    • подпись: " + (k.description || k.id) + " · " + (k.keyAlgorithm || "") + " · " + k.usedHuman);
      for (const t of keys.troubles) out.push("    ⚠ " + t);
      if (keys.errors.length) out.push("    (часть ключей не прочиталась: " + keys.errors.join("; ") + ")");
    } else if (c.keysError) {
      out.push("  ключи: прочитать не удалось — " + c.keysError);
    }
    out.push(
      "  если удалить: " +
        ((keys && keys.total) || roles.length
          ? "перестанут работать ключи (" + ((keys && keys.total) || 0) + ") и снимаются роли (" + roles.length + ") — всё, что ходило под этим аккаунтом, сломается."
          : "ничего не сломается: у аккаунта нет ни ролей, ни ключей.")
    );
    return out;
  }

  return {
    // чтение
    serviceAccounts,
    serviceAccount,
    findServiceAccount,
    resolveAccount,
    accessKeys,
    apiKeys,
    authorizedKeys,
    allKeys,
    roles,
    bindings,
    bindingsFor,
    overview,
    // аккаунты
    createServiceAccount,
    updateServiceAccount,
    deleteServiceAccount,
    // роли
    grantRole,
    revokeRole,
    // ключи
    createAccessKey,
    deleteAccessKey,
    createApiKey,
    deleteApiKey,
    createAuthorizedKey,
    deleteKey,
    deleteKeyByKind,
    // карточка
    cardLines,
    // Чистые помощники наружу: их читают инструмент агента и канал панели —
    // как у сети и машин, значения рядом с методами.
    ROLE_CATALOG,
    TASKS,
    TASK_KEYS,
    PRIMITIVE_ROLES,
    KEY_ALGORITHMS,
    KEY_IDLE_DAYS,
    checkName,
    checkRole,
    statusHuman,
    roleInfo,
    roleHuman,
    roleDanger,
    isPrimitiveRole,
    minimalRoles,
    keyTrouble,
  };
}

module.exports = {
  createYcIam,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  checkName,
  checkRole,
  statusHuman,
  isActive,
  roleInfo,
  roleHuman,
  roleDanger,
  isPrimitiveRole,
  minimalRoles,
  keyTrouble,
  accountInfo,
  accessKeyInfo,
  apiKeyInfo,
  authorizedKeyInfo,
  bindingInfo,
  daysSince,
  humanDays,
  ROLE_CATALOG,
  TASKS,
  TASK_KEYS,
  PRIMITIVE_ROLES,
  KEY_ALGORITHMS,
  KEY_IDLE_DAYS,
};

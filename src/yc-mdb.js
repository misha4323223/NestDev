"use strict";

const crypto = require("crypto");

/* ── Managed-базы Yandex Cloud: PostgreSQL, MySQL и ClickHouse ───────────────
   Зачем модуль. До этого облако в приложении умело всё, кроме самих баз: их
   видно в консоли Yandex Cloud, но не у нас. Managed-кластер — это база, за
   которую платят по часам и которую нельзя «просто посмотреть»: у неё есть
   состояние (работает/остановлена), роли хостов, базы, пользователи и логи.

   Три сервиса в ОДНОМ модуле, потому что у них один и тот же API: один хост
   (mdb.api.cloud.yandex.net), один набор методов и одни пути — меняется только
   сегмент пути (/managed-postgresql, /managed-mysql, /managed-clickhouse) и
   мелочи в теле создания. Писать три почти одинаковых модуля значило бы трижды
   повторять одни и те же ошибки.

   Формы API сверены с официальным справочником (mdb.api.cloud.yandex.net),
   а не взяты по памяти:
     GET    /{api}/v1/clusters?folderId=…            список (Cluster.List)
     GET    /{api}/v1/clusters/{id}                  карточка
     GET    /{api}/v1/clusters/{id}/hosts            хосты (роли, зоны, здоровье)
     GET    /{api}/v1/clusters/{id}/databases        базы
     GET    /{api}/v1/clusters/{id}/users            пользователи
     GET    /{api}/v1/clusters/{id}:logs             логи (timestamp + message)
     GET    /{api}/v1/clusters/{id}/operations       операции кластера
     GET    /{api}/v1/resourcePresets                классы (ресурсы) хостов
     POST   /{api}/v1/clusters/{id}:start|:stop      питание
     POST   /{api}/v1/clusters                       создание
     DELETE /{api}/v1/clusters/{id}                  удаление

   Что важно знать и не потерять при правке:

     • ХОСТОВ в объекте кластера НЕТ. Список хостов — отдельный вызов, поэтому
       и список кластеров, и карточка показывают только то, что отдал сам
       кластер, а хосты спрашиваются явно. Иначе плитка делала бы N+1 запросов
       на каждый показ.
     • Адрес подключения — это ИМЯ ХОСТА (fqdn вида c-…rw.mdb.yandexcloud.net),
       а не адрес кластера: у кластера точки входа нет, вход дают хосты. Поэтому
       строка подключения собирается из хоста-мастера (role MASTER), а не из
       константы.
     • ПАРОЛЬ пользователя облако отдаёт ровно один раз — при создании. В
       списках и карточках паролей нет и быть не может; модуль их и не просит.
       Наружу пароль уходит только из create (как secret) и никогда из чтения.
     • ClickHouse устроен иначе: ресурсы (класс и диск) живут ВНУТРИ configSpec.
       clickhouse, а не рядом, и администратору нужен adminPassword. Поэтому
       тело создания собирается по-разному для «обычных» баз и для ClickHouse.
     • ОСТАНОВЛЕННЫЙ кластер дешевле, но не бесплатен: платят за диск и
       резервные копии. Удаление необратимо и забирает резервные копии вместе с
       кластером, поэтому оно делается с явным подтверждением.
     • У кластера может стоять deletionProtection: удаление тогда отказывает.
       Причина называется прямо, а не показывается как «500 от облака».

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcCompute и createYcVpc), поэтому
   он проверяется в plain-node на подставных ответах сервиса. */

// Адрес mdb — один на все три базы; он же в KNOWN_ENDPOINTS (yandex-cloud.js),
// поэтому первый же запрос не ждёт каталог эндпоинтов.
const MDB_HOST = "https://mdb.api.cloud.yandex.net";

// Зона по умолчанию: как у машин (yc-compute.js) — самая обычная зона региона.
const ZONE_DEFAULT = "ru-central1-a";
const DISK_TYPE_DEFAULT = "network-ssd";
const DISK_TYPE_CHEAP = "network-hdd";
const DISK_GB_DEFAULT = { postgresql: 20, mysql: 20, clickhouse: 32 };
const ENVIRONMENT_DEFAULT = "PRODUCTION";

// ── Три базы: всё, чем они отличаются, собрано здесь одним местом ───────────
// api  — сегмент пути; svc — id сервиса в каталоге эндпоинтов (он же у консоли);
// port — порт подключения (у PostgreSQL это порт пулера соединений, 6432: в
// Managed-кластере подключаются именно к нему, а 5432 остаётся внутри хоста).
// versions — значения, перечисленные в справочнике API на момент правки
// (сентябрь 2026): у ClickHouse явного списка версий в справочнике нет вовсе,
// поэтому там список пустой, а версию называет человек.
const ENGINES = {
  postgresql: {
    key: "postgresql",
    ru: "PostgreSQL",
    title: "Managed Service for PostgreSQL",
    api: "managed-postgresql",
    svc: "managed-postgresql",
    port: 6432,
    defaultUser: "admin",
    defaultDb: "db1",
    versions: ["11", "12", "13", "14", "15", "16", "17", "18"],
    logTypes: ["POSTGRESQL", "POOLER", "REPACK"],
  },
  mysql: {
    key: "mysql",
    ru: "MySQL",
    title: "Managed Service for MySQL",
    api: "managed-mysql",
    svc: "managed-mysql",
    port: 3306,
    defaultUser: "admin",
    defaultDb: "db1",
    versions: ["5.7", "8.0", "8.4"],
    logTypes: ["MYSQL", "POOLER"],
  },
  clickhouse: {
    key: "clickhouse",
    ru: "ClickHouse",
    title: "Managed Service for ClickHouse",
    api: "managed-clickhouse",
    svc: "managed-clickhouse",
    port: 9440,
    defaultUser: "admin",
    defaultDb: "default",
    // У ClickHouse класс и диск лежат внутри configSpec.clickhouse, и админу
    // обязателен пароль — это учтено в createBody по флагу nestedConfig.
    nestedConfig: true,
    versions: [],
    logTypes: ["CLICKHOUSE", "KEEPER"],
  },
};

const ENGINE_KEYS = ["postgresql", "mysql", "clickhouse"];

// Как человек называет базу в переписке — «постгрес», «pg», «клик» — и всё это
// должно попадать в ту же базу, что и «postgresql».
const ENGINE_ALIASES = {
  postgresql: "postgresql",
  postgres: "postgresql",
  pg: "postgresql",
  pgsql: "postgresql",
  "постгрес": "postgresql",
  "постгре": "postgresql",
  mysql: "mysql",
  "майсиквел": "mysql",
  maria: "mysql",
  mariadb: "mysql",
  clickhouse: "clickhouse",
  "клик": "clickhouse",
  ch: "clickhouse",
};

// Состояния кластера — из перечисления Status справочника API.
const STATUSES = ["STATUS_UNKNOWN", "CREATING", "RUNNING", "ERROR", "UPDATING", "STOPPING", "STOPPED", "STARTING"];
const STATUS_RU = {
  STATUS_UNKNOWN: "состояние неизвестно",
  CREATING: "создаётся",
  RUNNING: "работает",
  ERROR: "ошибка: кластер не может работать",
  UPDATING: "обновляется",
  STOPPING: "останавливается",
  STOPPED: "остановлен",
  STARTING: "запускается",
};
const HEALTH_RU = {
  HEALTH_UNKNOWN: "здоровье неизвестно",
  ALIVE: "здоров",
  DEAD: "недоступен",
  DEGRADED: "частично доступен",
  READONLY: "только чтение",
};

// ── Проверки ввода (свои в каждом модуле: он должен читаться целиком) ───────
const NAME_RE = /^[a-z][-a-z0-9_]{0,61}[a-z0-9]$/;

function checkName(name) {
  const n = String(name == null ? "" : name).trim();
  if (!n) throw new Error("Не указано имя кластера.");
  if (!NAME_RE.test(n)) {
    throw new Error(
      "Имя «" + n + "» облако не примет: строчные латинские буквы, цифры, дефис и подчёркивание, начинается с буквы, длина 1–63."
    );
  }
  return n;
}

function checkFolder(folderId) {
  const f = String(folderId == null ? "" : folderId).trim();
  if (!f) throw new Error("Не выбран каталог (folderId) — кластеры баз живут в каталоге.");
  return f;
}

function one(v) {
  return String(v == null ? "" : v).trim();
}

// ── Человеческие значения ──────────────────────────────────────────────────
// Память и размер диска облако присылает в БАЙТАХ строками («2147483648»).
function humanBytes(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "";
  const gb = n / 1073741824;
  if (gb >= 1) return (Math.round(gb * 10) / 10) + " ГБ";
  return Math.round(n / 1048576) + " МБ";
}

// «Работает 3 дня» вместо даты создания: человек спрашивает про возраст.
function humanUptime(fromIso) {
  const t = Date.parse(String(fromIso || ""));
  if (!isFinite(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "меньше минуты";
  if (min < 60) return min + " мин";
  const h = Math.floor(min / 60);
  if (h < 24) return h + " ч";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " дн";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + " мес";
  return Math.floor(mo / 12) + " г";
}

function statusHuman(status) {
  return STATUS_RU[String(status || "").toUpperCase()] || one(status);
}

function healthHuman(health) {
  return HEALTH_RU[String(health || "").toUpperCase()] || one(health);
}

function isRunning(status) {
  return String(status || "").toUpperCase() === "RUNNING";
}

// «Занят» — идёт переход (создание, старт, стоп, обновление): в это время
// облако отказывает в питании и удалении, и лучше сказать это заранее.
function isBusy(status) {
  const s = String(status || "").toUpperCase();
  return s === "CREATING" || s === "UPDATING" || s === "STARTING" || s === "STOPPING";
}

// ── Нормализация ответов ───────────────────────────────────────────────────
// Ресурсы кластера: у PostgreSQL и MySQL они рядом с версией (config.resources),
// у ClickHouse — внутри config.clickhouse.resources. Достаём оба варианта.
function resourcesOf(config) {
  const c = config || {};
  const r = c.resources || (c.clickhouse && c.clickhouse.resources) || {};
  return r || {};
}

function versionOf(config) {
  const c = config || {};
  return one(c.version) || (c.clickhouse && c.clickhouse.version ? one(c.clickhouse.version) : "");
}

function clusterInfo(c) {
  const o = c || {};
  const res = resourcesOf(o.config);
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    environment: one(o.environment),
    status: one(o.status),
    statusHuman: statusHuman(o.status),
    health: one(o.health),
    healthHuman: healthHuman(o.health),
    running: isRunning(o.status),
    busy: isBusy(o.status),
    version: versionOf(o.config),
    resourcePresetId: one(res.resourcePresetId),
    cores: one(res.cores),
    memoryBytes: Number(res.memory) || 0,
    memoryHuman: humanBytes(res.memory),
    diskBytes: Number(res.diskSize) || 0,
    diskHuman: humanBytes(res.diskSize),
    diskTypeId: one(res.diskTypeId),
    networkId: one(o.networkId),
    securityGroupIds: Array.isArray(o.securityGroupIds) ? o.securityGroupIds : [],
    deletionProtection: o.deletionProtection === true,
    labels: o.labels || {},
    monitoring: Array.isArray(o.monitoring) ? o.monitoring : [],
    autofailover: o.config && o.config.autofailover === true,
  };
}

function hostInfo(h) {
  const o = h || {};
  const res = o.resources || {};
  return {
    name: one(o.name), // это и есть fqdn хоста — адрес для подключения
    clusterId: one(o.clusterId),
    zoneId: one(o.zoneId),
    subnetId: one(o.subnetId),
    role: one(o.role),
    roleHuman: one(o.role) === "MASTER" ? "мастер" : one(o.role) === "REPLICA" ? "реплика" : one(o.role),
    health: one(o.health),
    healthHuman: healthHuman(o.health),
    replicationSource: one(o.replicationSource),
    shardName: one(o.shardName),
    resourcePresetId: one(res.resourcePresetId),
    diskHuman: humanBytes(res.diskSize),
  };
}

// Строка подключения собирается из ХОСТА-мастера: точки входа у кластера нет.
function connection(engineKey, cluster, hosts, opts) {
  const e = engineOf(engineKey);
  const o = opts || {};
  if (!e) return null;
  const list = Array.isArray(hosts) ? hosts.filter((h) => h && h.name) : [];
  const master = list.find((h) => String(h.role || "").toUpperCase() === "MASTER") || list[0] || null;
  const host = master ? master.name : one(cluster && cluster.fqdn);
  const port = o.port || e.port;
  const db = one(o.database) || e.defaultDb;
  const user = one(o.user) || e.defaultUser;
  const secure = e.key === "clickhouse";
  const parts = [];
  if (host) {
    if (e.key === "postgresql") parts.push('psql "host=' + host + " port=" + port + " dbname=" + db + " user=" + user + ' sslmode=require"');
    else if (e.key === "mysql") parts.push("mysql --host " + host + " --port " + port + " -u " + user + " -p " + db);
    else parts.push("clickhouse-client --host " + host + " --port " + port + (secure ? " --secure" : "") + " -u " + user);
  }
  return { host: host, port: port, database: db, user: user, line: parts[0] || "" };
}

// ── Строки для человека (одним текстом отвечают и агент, и окно) ────────────
function clusterLine(c, engineKey) {
  const e = engineOf(engineKey);
  const bits = [];
  bits.push((c.running ? "● " : "○ ") + c.name);
  bits.push(c.statusHuman || "—");
  if (e) bits.push(e.ru + " " + (c.version || "?"));
  if (c.resourcePresetId) bits.push(c.resourcePresetId + (c.cores ? " (" + c.cores + " vCPU)" : ""));
  if (c.memoryHuman) bits.push(c.memoryHuman);
  if (c.diskHuman) bits.push("диск " + c.diskHuman + (c.diskTypeId ? " " + c.diskTypeId : ""));
  if (c.age) bits.push("возраст " + c.age);
  if (c.deletionProtection) bits.push("защита от удаления");
  return bits.join(" · ") + (c.id ? "\n    id " + c.id : "");
}

function hostLine(h) {
  return (
    "• " + h.name + " — " + (h.zoneId || "—") + (h.roleHuman ? ", " + h.roleHuman : "") +
    (h.shardName ? ", шард " + h.shardName : "") +
    (h.diskHuman ? ", диск " + h.diskHuman : "") +
    (h.healthHuman ? ", " + h.healthHuman : "")
  );
}

function engineOf(key) {
  const k = one(key).toLowerCase();
  const id = ENGINE_ALIASES[k] || (ENGINES[k] ? k : "");
  return id ? ENGINES[id] : null;
}

// Пароль для нового пользователя (и администратора ClickHouse). Требования
// облака: 8–128 символов, минимум одна строчная, одна прописная и одна цифра.
// Собираем криптостойко и без кавычек — пароль попадает в строки подключения.
function generatePassword() {
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = lower + upper + digits + "-_";
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(lower), pick(upper), pick(digits)];
  for (let i = 0; i < 15; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = chars[i];
    chars[i] = chars[j];
    chars[j] = t;
  }
  return chars.join("");
}

function createYcMdb(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError =
    typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Managed-базы: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function baseOf(engineId) {
    const e = engineOf(engineId);
    if (!e) throw new Error("Неизвестная база «" + engineId + "». Доступно: " + ENGINE_KEYS.join(", ") + ".");
    const b = typeof api.endpoint === "function" ? await api.endpoint(e.svc) : "";
    return b || MDB_HOST;
  }

  // Один запрос к mdb: путь собирается из сегмента сервиса, чтобы три базы
  // ходили одной и той же рукой.
  async function call(oauthToken, engineId, method, path, body, timeoutMs) {
    requireApi();
    const e = engineOf(engineId);
    const base = await baseOf(engineId);
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method: method, headers: headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const full = "/" + e.api + "/v1" + path;
    try {
      return await api.fetchJson(base + full, opts, timeoutMs || 30000);
    } catch (err) {
      const msg = serviceError(err, base, full);
      const wrapped = new Error(msg);
      wrapped.status = err && err.status;
      throw wrapped;
    }
  }

  // Ждать операцию не обязательно: создание кластера идёт минутами, и окно не
  // должно «висеть». Поэтому ожидание ограничено, а по таймауту возвращается
  // id операции — по нему результат видно позже.
  async function waitOrNote(oauthToken, j, timeoutMs) {
    const id = j && j.id;
    if (!id) return { done: true, operationId: "" };
    try {
      const op = await waitOp(oauthToken, id, timeoutMs || 180000);
      return { done: true, operationId: id, operation: op || {} };
    } catch (e) {
      return { done: false, operationId: id, error: (e && e.message) || String(e) };
    }
  }

  // ── Чтение ────────────────────────────────────────────────────────────────
  async function clusters(oauthToken, engineId, folderId) {
    const folder = checkFolder(folderId);
    const j = await call(
      oauthToken,
      engineId,
      "GET",
      "/clusters?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    const list = Array.isArray(j && j.clusters) ? j.clusters : [];
    return list.map(clusterInfo);
  }

  async function cluster(oauthToken, engineId, id) {
    const cid = one(id);
    if (!cid) throw new Error("Не указан id кластера.");
    return clusterInfo(await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid), undefined, 25000));
  }

  async function hosts(oauthToken, engineId, clusterId) {
    const cid = one(clusterId);
    if (!cid) throw new Error("Не указан id кластера — хосты спрашиваются у конкретного кластера.");
    const j = await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid) + "/hosts", undefined, 25000);
    const list = Array.isArray(j && j.hosts) ? j.hosts : [];
    return list.map(hostInfo);
  }

  async function databases(oauthToken, engineId, clusterId) {
    const cid = one(clusterId);
    if (!cid) throw new Error("Не указан id кластера.");
    const j = await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid) + "/databases", undefined, 25000);
    const list = Array.isArray(j && j.databases) ? j.databases : [];
    return list.map((d) => ({ name: one(d && d.name), owner: one(d && d.owner) }));
  }

  // Пользователи — ТОЛЬКО имена и права. Паролей облако в чтении не отдаёт
  // вовсе, и делать вид, что мы их «не показываем», было бы неправдой.
  async function users(oauthToken, engineId, clusterId) {
    const cid = one(clusterId);
    if (!cid) throw new Error("Не указан id кластера.");
    const j = await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid) + "/users", undefined, 25000);
    const list = Array.isArray(j && j.users) ? j.users : [];
    return list.map((u) => ({
      name: one(u && u.name),
      permissions: Array.isArray(u && u.permissions)
        ? u.permissions.map((p) => one(p && p.databaseName) || "…").filter(Boolean)
        : [],
      connLimit: u && u.connLimit != null ? String(u.connLimit) : "",
      authMethod: one(u && u.authMethod),
    }));
  }

  // Логи: отдаём по одной строке на запись, чтобы читалось как обычный текст.
  async function logs(oauthToken, engineId, clusterId, opts) {
    const cid = one(clusterId);
    if (!cid) throw new Error("Не указан id кластера.");
    const o = opts || {};
    const q = new URLSearchParams();
    const minutes = Number(o.minutes) > 0 ? Number(o.minutes) : 60;
    const to = o.toTime ? new Date(o.toTime) : new Date();
    const from = o.fromTime ? new Date(o.fromTime) : new Date(to.getTime() - minutes * 60000);
    if (!isFinite(from.getTime()) || !isFinite(to.getTime())) throw new Error("Не понял время. Укажи минуты (minutes) или время в формате RFC3339.");
    q.set("fromTime", from.toISOString().replace(/\.\d{3}Z$/, "Z"));
    q.set("toTime", to.toISOString().replace(/\.\d{3}Z$/, "Z"));
    q.set("pageSize", String(Math.max(1, Math.min(parseInt(o.limit, 10) || 100, 1000))));
    const svcType = one(o.serviceType).toUpperCase();
    if (svcType) q.set("serviceType", svcType);
    const j = await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid) + ":logs?" + q.toString(), undefined, 30000);
    const list = Array.isArray(j && j.logs) ? j.logs : [];
    const rows = list.map((l) => {
      const msg = l && l.message;
      let text = "";
      if (msg && typeof msg === "object") {
        const keys = Object.keys(msg);
        // Обычно колонка одна (message/log); иначе склеиваем «колонка: значение».
        text = keys.length === 1 ? one(msg[keys[0]]) : keys.map((k) => k + "=" + one(msg[k])).join(" ");
      } else {
        text = one(msg);
      }
      return { timestamp: one(l && l.timestamp), text: text };
    });
    return { from: from.toISOString(), to: to.toISOString(), minutes: minutes, rows: rows };
  }

  async function operations(oauthToken, engineId, clusterId, opts) {
    const cid = one(clusterId);
    if (!cid) throw new Error("Не указан id кластера.");
    const o = opts || {};
    const j = await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cid) + "/operations?pageSize=50", undefined, 25000);
    const list = Array.isArray(j && j.operations) ? j.operations : [];
    return list.slice(0, Math.max(1, parseInt(o.limit, 10) || 15)).map((op) => ({
      id: one(op && op.id),
      description: one(op && op.description),
      createdAt: one(op && op.createdAt),
      done: !!(op && op.done),
      error: op && op.error ? one(op.error.message) : "",
      metadataType: op && op.metadata && op.metadata["@type"] ? one(op.metadata["@type"]).replace(/^.*\./, "") : "",
    }));
  }

  // Классы хостов: облако отдаёт их по запросу (id, ядра, память, зоны). Список
  // классов, записанный по памяти, устареет молча — поэтому спрашиваем облако.
  async function presets(oauthToken, engineId) {
    const j = await call(oauthToken, engineId, "GET", "/resourcePresets?pageSize=1000", undefined, 25000);
    const list = Array.isArray(j && j.resourcePresets) ? j.resourcePresets : [];
    return list.map((p) => ({
      id: one(p && p.id),
      cores: one(p && p.cores),
      memoryBytes: Number(p && p.memory) || 0,
      memoryHuman: humanBytes(p && p.memory),
      zoneIds: Array.isArray(p && p.zoneIds) ? p.zoneIds : [],
      diskTypes: Array.isArray(p && p.diskTypeIds) ? p.diskTypeIds : [],
    }));
  }

  async function findCluster(oauthToken, engineId, folderId, ref) {
    const list = await clusters(oauthToken, engineId, folderId);
    const q = one(ref);
    const got = list.find((c) => c.id === q) || list.find((c) => c.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  // ── Питание ───────────────────────────────────────────────────────────────
  // start/stop обратимы, но стоп экономит только деньги за вычислительные
  // ресурсы: диск и резервные копии тарифицируются и у остановленного кластера.
  async function power(oauthToken, engineId, action, ref, opts) {
    const o = opts || {};
    const act = one(action).toLowerCase();
    if (act !== "start" && act !== "stop") {
      throw new Error("Питание кластера: неизвестное действие «" + action + "». Доступно: start, stop.");
    }
    const e = engineOf(engineId);
    if (!e) throw new Error("Неизвестная база «" + engineId + "». Доступно: " + ENGINE_KEYS.join(", ") + ".");
    const cl = ref && ref.id ? ref : await findCluster(oauthToken, engineId, o.folderId, ref);
    if (!cl) throw new Error("Не нашёл кластер «" + one(ref) + "» в каталоге.");
    if (act === "start" && cl.running) return { changed: false, cluster: cl, message: "Кластер «" + cl.name + "» уже работает." };
    if (act === "stop" && String(cl.status).toUpperCase() === "STOPPED") {
      return { changed: false, cluster: cl, message: "Кластер «" + cl.name + "» уже остановлен." };
    }
    if (cl.busy) {
      throw new Error("Кластер «" + cl.name + "» сейчас занят: " + cl.statusHuman + ". Дождись окончания и повтори.");
    }
    const j = await call(oauthToken, engineId, "POST", "/clusters/" + encodeURIComponent(cl.id) + ":" + act, undefined, 30000);
    const done = await waitOrNote(oauthToken, j, 300000);
    const after = done.done ? await cluster(oauthToken, engineId, cl.id).catch(() => null) : null;
    const now = after || cl;
    const warns = [];
    if (act === "stop") {
      warns.push("Остановленный кластер дешевле, но не бесплатен: диск и резервные копии тарифицируются и у остановленного.");
    } else {
      warns.push("Работающий кластер платит за каждый час — останови, когда база не нужна.");
    }
    if (!done.done) warns.push("Операция ещё идёт (" + done.operationId + "): состояние смотри действием clusters.");
    return {
      changed: true,
      action: act,
      cluster: now,
      operationId: done.operationId,
      message:
        "Кластер «" + now.name + "» " + (act === "start" ? "запускается" : "останавливается") +
        (after ? ", состояние: " + after.statusHuman : "") + ".",
      warnings: warns,
    };
  }

  // ── Создание ──────────────────────────────────────────────────────────────
  // Тело собирается по-разному для ClickHouse: у него класс и диск лежат внутри
  // configSpec.clickhouse, а администратору обязателен пароль. У PostgreSQL и
  // MySQL те же ресурсы стоят рядом с версией.
  function createBody(engineId, o) {
    const e = engineOf(engineId);
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name);
    const version = one(o.version);
    if (!version) {
      throw new Error(
        "Не указана версия базы (version)." +
          (e.versions.length ? " Для " + e.ru + " облако принимает: " + e.versions.join(", ") + "." : " Для " + e.ru + " версию называет человек, например 24.8.")
      );
    }
    const preset = one(o.preset || o.resourcePresetId);
    if (!preset) throw new Error("Не указан класс хоста (preset) — id класса отдаёт действие presets.");
    const diskGb = Number(o.diskGb) > 0 ? Number(o.diskGb) : DISK_GB_DEFAULT[e.key] || 20;
    const diskType = one(o.diskType || o.diskTypeId) || DISK_TYPE_DEFAULT;
    const zone = one(o.zone) || ZONE_DEFAULT;
    const subnetId = one(o.subnetId || o.subnet);
    if (!subnetId) throw new Error("Не указана подсеть (subnet) — хосту нужна подсеть, а через неё определяется сеть.");
    const networkId = one(o.networkId || o.network);
    const user = one(o.user || o.userName) || e.defaultUser;
    const database = one(o.database || o.dbName) || e.defaultDb;
    const password = one(o.userPassword) || generatePassword();
    const assignPublicIp = o.publicIp === true || o.assignPublicIp === true;
    const resources = {
      resourcePresetId: preset,
      diskSize: String(Math.round(diskGb * 1073741824)),
      diskTypeId: diskType,
    };
    const configSpec = { version: version };
    if (e.nestedConfig) {
      configSpec.clickhouse = { resources: resources };
      // Пароль администратора ClickHouse обязателен в самом configSpec.
      configSpec.adminPassword = password;
    } else {
      configSpec.resources = resources;
    }
    const hostSpec = { zoneId: zone, subnetId: subnetId, assignPublicIp: assignPublicIp };
    if (e.nestedConfig) hostSpec.type = "CLICKHOUSE";
    const body = {
      folderId: folderId,
      name: name,
      environment: one(o.environment).toUpperCase() || ENVIRONMENT_DEFAULT,
      configSpec: configSpec,
      hostSpecs: [hostSpec],
    };
    const sgroups = o.securityGroupIds || o.securityGroups;
    if (Array.isArray(sgroups) && sgroups.length) body.securityGroupIds = sgroups.map(one).filter(Boolean);
    if (o.deletionProtection === true) body.deletionProtection = true;
    if (!e.nestedConfig) {
      // У PostgreSQL и MySQL база и её владелец создаются вместе с кластером:
      // пустой кластер пришлось бы доводить руками, а «создать базу» в этом
      // модуле нечем — такой отдельной ручки у API для наших задач не нужно.
      body.databaseSpecs = [{ name: database, owner: user }];
      body.userSpecs = [{ name: user, password: password }];
    }
    return {
      engine: e,
      body: body,
      password: password,
      user: user,
      database: database,
      zone: zone,
      diskGb: diskGb,
      diskType: diskType,
      preset: preset,
      version: version,
    };
  }

  async function create(oauthToken, engineId, opts) {
    const o = opts || {};
    const built = createBody(engineId, o);
    // Сеть: если её не назвали, берём из подсети — иначе облако откажет
    // «networkId is required». Подсеть живёт в том же каталоге.
    if (!built.body.networkId) {
      built.body.networkId = await networkOfSubnet(oauthToken, built.body.folderId, built.body.hostSpecs[0].subnetId);
    }
    const j = await call(oauthToken, engineId, "POST", "/clusters", built.body, 40000);
    const done = await waitOrNote(oauthToken, j, 180000);
    let clusterId = "";
    if (j && j.metadata && j.metadata.clusterId) clusterId = one(j.metadata.clusterId);
    const created = clusterId ? await cluster(oauthToken, engineId, clusterId).catch(() => null) : null;
    const e = built.engine;
    const warns = [
      "Класс " + built.preset + " и диск " + built.diskGb + " ГБ тарифицируются почасово — точную цену за час покажет каталог облака: ycBilling { action: \"price\", query: \"" + e.ru + "\" }.",
      "Пароль пользователя «" + built.user + "» показан ОДИН раз: сохрани его в хранилище секретов (Lockbox), второй раз облако его не отдаст.",
    ];
    if (!done.done) warns.push("Кластер ещё создаётся (" + done.operationId + "): это занимает минуты, состояние видно действием clusters.");
    return {
      changed: true,
      created: !!created,
      cluster: created,
      clusterId: clusterId,
      operationId: done.operationId,
      secret: built.password,
      secretLabel: "Пароль базы «" + e.ru + "» (пользователь " + built.user + ")",
      user: built.user,
      database: built.database,
      message:
        "Кластер «" + built.body.name + "» (" + e.ru + " " + built.version + ") " +
        (created ? "создан, состояние: " + created.statusHuman : "создаётся") + ".",
      warnings: warns,
    };
  }

  // Сеть по подсети: сам модуль ходит в VPC только за этим полем.
  async function networkOfSubnet(oauthToken, folderId, subnetId) {
    const b = (typeof api.endpoint === "function" ? await api.endpoint("vpc") : "") || "https://vpc.api.cloud.yandex.net";
    const token = await api.getIamToken(oauthToken);
    const j = await api.fetchJson(
      b + "/vpc/v1/subnets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000",
      { headers: { Authorization: "Bearer " + token } },
      25000
    );
    const list = Array.isArray(j && j.subnets) ? j.subnets : [];
    const id = one(subnetId);
    const s = list.find((x) => one(x && x.id) === id) || list.find((x) => one(x && x.name) === id) || null;
    if (!s) throw new Error("Не нашёл подсеть «" + subnetId + "» в каталоге. Список подсетей: ycVpc { action: \"subnets\" }.");
    return one(s.networkId);
  }

  // ── Удаление ──────────────────────────────────────────────────────────────
  // Необратимо и вместе с резервными копиями. Защита от удаления у кластера
  // (deletionProtection) отменяет удаление — говорим об этом прямо, а не
  // показываем отказ облака.
  async function remove(oauthToken, engineId, opts) {
    const o = opts || {};
    const cl = o.clusterId || o.id
      ? await cluster(oauthToken, engineId, o.clusterId || o.id)
      : await findCluster(oauthToken, engineId, o.folderId, o.name || o.cluster);
    if (!cl) throw new Error("Не нашёл кластер «" + one(o.name || o.cluster || o.clusterId) + "» в каталоге.");
    if (cl.deletionProtection) {
      throw new Error(
        "У кластера «" + cl.name + "» включена защита от удаления (deletionProtection). Сними её в консоли Yandex Cloud, тогда удаление пройдёт."
      );
    }
    if (cl.busy) {
      throw new Error("Кластер «" + cl.name + "» сейчас занят: " + cl.statusHuman + ". Дождись окончания и повтори.");
    }
    const j = await call(oauthToken, engineId, "DELETE", "/clusters/" + encodeURIComponent(cl.id), undefined, 30000);
    const done = await waitOrNote(oauthToken, j, 300000);
    const left = done.done ? await call(oauthToken, engineId, "GET", "/clusters/" + encodeURIComponent(cl.id), undefined, 20000).catch(() => null) : null;
    if (left) throw new Error("Кластер «" + cl.name + "» не удалился: он ещё существует. Проверь права (mdb.admin) в каталоге.");
    return {
      deleted: true,
      cluster: cl,
      operationId: done.operationId,
      warnings: [
        "Резервные копии удалены вместе с кластером: восстановить данные будет не из чего.",
        done.done ? "" : "Операция ещё идёт (" + done.operationId + "): состояние смотри действием clusters.",
      ].filter(Boolean),
      message: "Кластер «" + cl.name + "» (" + cl.version + ") удалён.",
    };
  }

  // ── Карточка ──────────────────────────────────────────────────────────────
  // Один текст на все случаи: и агенту, и окну. Хосты и подключение — часть
  // карточки, потому что без них «кластер есть» не значит «в базу можно войти».
  async function cardLines(oauthToken, engineId, ref, opts) {
    const o = opts || {};
    const e = engineOf(engineId);
    if (!e) throw new Error("Неизвестная база «" + engineId + "». Доступно: " + ENGINE_KEYS.join(", ") + ".");
    const cl = ref && ref.id ? ref : await findCluster(oauthToken, engineId, o.folderId, ref);
    if (!cl) throw new Error("Не нашёл кластер «" + one(ref) + "» в каталоге.");
    const hs = await hosts(oauthToken, engineId, cl.id).catch(() => []);
    const conn = connection(engineId, cl, hs, { database: o.database, user: o.user });
    const lines = [];
    lines.push("Кластер «" + cl.name + "» — " + e.ru + " " + (cl.version || "?") + " · id " + cl.id);
    lines.push("Состояние: " + cl.statusHuman + (cl.healthHuman ? " · " + cl.healthHuman : "") + (cl.age ? " · возраст " + cl.age : ""));
    lines.push(
      "Ресурсы: " + (cl.resourcePresetId || "—") + (cl.cores ? " (" + cl.cores + " vCPU)" : "") +
        (cl.memoryHuman ? ", " + cl.memoryHuman : "") +
        (cl.diskHuman ? ", диск " + cl.diskHuman + (cl.diskTypeId ? " (" + cl.diskTypeId + ")" : "") : "")
    );
    if (cl.autofailover) lines.push("Отказоустойчивость: включена");
    if (cl.deletionProtection) lines.push("Защита от удаления: включена");
    if (hs.length) {
      lines.push("Хосты (" + hs.length + "):");
      for (const h of hs) lines.push("  " + hostLine(h).replace(/^• /, ""));
    } else {
      lines.push("Хостов не видно — это странно для работающего кластера; проверь состояние.");
    }
    if (conn && conn.line) lines.push("Подключение: " + conn.line);
    return { cluster: cl, hosts: hs, connection: conn, lines: lines };
  }

  return {
    ENGINES,
    ENGINE_KEYS,
    ZONE_DEFAULT,
    DISK_GB_DEFAULT,
    STATUSES,
    // чтение
    clusters,
    cluster,
    hosts,
    databases,
    users,
    logs,
    operations,
    presets,
    findCluster,
    // изменение
    power,
    create,
    remove,
    // текст
    cardLines,
    clusterLine,
    hostLine,
    connection,
    // чистые помощники
    generatePassword,
    engineOf,
    checkName,
    humanBytes,
    humanUptime,
    statusHuman,
    healthHuman,
    isRunning,
    isBusy,
    clusterInfo,
    hostInfo,
  };
}

module.exports = {
  createYcMdb,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  generatePassword,
  engineOf,
  checkName,
  humanBytes,
  humanUptime,
  statusHuman,
  healthHuman,
  isRunning,
  isBusy,
  clusterInfo,
  hostInfo,
  connection,
  clusterLine,
  hostLine,
  ENGINES,
  ENGINE_KEYS,
  ZONE_DEFAULT,
  DISK_GB_DEFAULT,
  STATUSES,
};

"use strict";

/* ── Compute Cloud: виртуальные машины, диски, снимки, консоль и метрики ──────
   Зачем модуль. Приложение умело в облаке всё, кроме главного: самих машин.
   Машина — это «компьютер в дата-центре», на котором живёт сайт, бот или база.
   Без неё «облако» было набором полок, а весь путь «поднять сервер» человек
   проходил руками в чужой консоли.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcVpc и createYcDb): IAM-токен,
   адрес сервиса, разбор сетевых отказов и ожидание операции. Поэтому он
   проверяется в plain-node, на подставных ответах сервиса.

   Что важно знать про машины и не потерять при правке:

     • у машины НЕТ экрана. Всё, что от неё видно снаружи — это serial-консоль
       (текст загрузки) и метрики (счётчики нагрузки). Оба живут в этом модуле:
       без них «машина работает?» остаётся догадкой;
     • serial-консоль по умолчанию ВЫКЛЮЧЕНА. Её включает только метаданные
       `serial-port-enable=1` в момент создания — включить задним числом нельзя
       без правки метаданных. Поэтому при создании она включается сразу;
     • машина не встанет без подсети, а подсеть живёт в одной зоне. Значит зона
       машины, зона подсети и зона статического адреса — одна и та же. Если
       подсеть названа, а зона нет, зона берётся ИЗ ПОДСЕТИ, а не из константы:
       иначе облако отказывает «subnet ... is in a different zone»;
     • публичного IP у машины нет, пока его не попросили явно (oneToOneNatSpec).
       Машина без него доступна только внутри облака — и это нормальный выбор;
     • цена машины не зависит от нагрузки: платят за каждый час существования,
       а остановленная машина всё равно платит за свои диски и за статический IP.
       Поэтому у каждой карточки есть строка про деньги;
     • ресурсы (память и размер диска) сервис принимает в БАЙТАХ строками.
       Перевод «2 ГБ → 2147483648» живёт здесь (bytesFromHuman), и обратно тоже;
     • снимок диска — единственная защита от «удалил машину вместе с дисками».
       Снимки тарифицируются отдельно, поэтому «чистка старых снимков» здесь
       сделана с предварительным показом (dryRun), а не удаляет сразу.

   Ничего не пишется и не удаляется по своей инициативе: функции делают ровно то,
   о чём их попросили, и возвращают данные. Права и согласие на траты проверяет
   вызывающий. */

const COMPUTE_FALLBACK = "https://compute.api.cloud.yandex.net";
const MONITORING_FALLBACK = "https://monitoring.api.cloud.yandex.net";

// Технические значения по умолчанию. Все они выбраны «самое дешёвое разумное»,
// потому что первая машина у человека обычно первая и пробная.
const ZONE_DEFAULT = "ru-central1-a";
// standard-v3 — платформа с почасовым уровнем производительности (coreFraction):
// именно она даёт самую дешёвую машину (20% одного ядра). На standard-v1/v2
// прерываемость тоже есть, но устаревшие платформы дороже и слабее.
const PLATFORM_DEFAULT = "standard-v3";
const IMAGE_FAMILY_DEFAULT = "ubuntu-2204-lts";
const DISK_TYPE_DEFAULT = "network-ssd";
const DISK_TYPE_CHEAP = "network-hdd";
const CORES_DEFAULT = 2;
const MEMORY_GB_DEFAULT = 2;
// 20% ядра — «экономный» уровень: сайту и боту хватает, счёт меньше в разы.
const CORE_FRACTION_DEFAULT = 20;
const DISK_SIZE_GB_DEFAULT = 20;

// Разрешённые значения взяты из описания API: неверное число ядер или уровень
// производительности сервис отбивает невнятной ошибкой, поэтому проверяем сами.
const ALLOWED_CORES = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80];
const ALLOWED_FRACTIONS = [0, 5, 20, 50, 100];

// Готовые наборы: человек выбирает «для сайта», а не 76 значений API.
const PRESETS = {
  micro: {
    title: "Совсем маленькая (бот, тест)",
    cores: 2,
    memoryGb: 1,
    coreFraction: 20,
    diskSizeGb: 15,
    diskTypeId: DISK_TYPE_CHEAP,
    note: "одного ядра хватает скрипту и боту; диск на HDD медленнее, зато дешевле",
  },
  small: {
    title: "Небольшой сайт (обычный выбор)",
    cores: 2,
    memoryGb: 2,
    coreFraction: 20,
    diskSizeGb: 20,
    diskTypeId: DISK_TYPE_DEFAULT,
    note: "типичный вариант: сайт, бот, небольшая база",
  },
  medium: {
    title: "Понадобится побольше (база, несколько сервисов)",
    cores: 4,
    memoryGb: 4,
    coreFraction: 50,
    diskSizeGb: 40,
    diskTypeId: DISK_TYPE_DEFAULT,
    note: "для настоящей базы данных и нескольких сервисов на одной машине",
  },
  full: {
    title: "Полное выделенное ядро",
    cores: 4,
    memoryGb: 8,
    coreFraction: 100,
    diskSizeGb: 60,
    diskTypeId: DISK_TYPE_DEFAULT,
    note: "без «экономного» режима: ровная скорость, дороже всех",
  },
};

const PRESET_KEYS = ["micro", "small", "medium", "full"];

// ── Проверки ввода ──────────────────────────────────────────────────────────
// Имя в Yandex Cloud: строчные латинские буквы, цифры, дефис и подчёркивание.
// У машин правило чуть шире, чем у подсетей (подчёркивание разрешено), но
// приводить к одному виду полезно: имя попадает в fqdn и в команды.
const NAME_RE = /^[a-z][-a-z0-9_]{0,61}[a-z0-9]$/;

// Проверки ввода намеренно живут в каждом модуле облака свои (а не в общем
// помощнике): модуль должен читаться и правиться целиком, без переходов.
function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя машины: строчные латинские буквы, цифры и дефис (например web-1).");
  if (NAME_RE.test(nm)) return nm;
  const lower = nm.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (NAME_RE.test(lower)) {
    throw new Error("Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры, дефис и подчёркивание. Возьми «" + lower + "».");
  }
  throw new Error(
    "Имя «" + nm + "» не подойдёт: нужно 2–63 символа, только строчные латинские буквы, цифры, дефис и подчёркивание, " +
      "начинается с буквы и не заканчивается дефисом. Подойдёт, например, «web-1»."
  );
}

function checkFolder(folderId) {
  const f = String(folderId || "").trim();
  if (!f) throw new Error("Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.");
  return f;
}

// ── Байты и человеческое «ГБ» ────────────────────────────────────────────────
// Сервис ждёт память и размер диска в байтах СТРОКОЙ. Человек думает в ГБ.
const GB = 1024 * 1024 * 1024;

// «2», "2GB", "2048MB", "2 ГБ", 2147483648 → байты.
function bytesFromHuman(v, what) {
  if (typeof v === "number") {
    if (!isFinite(v) || v <= 0) throw new Error(what + ": размер должен быть положительным числом.");
    // Число больше 1000 читаем как байты, меньше — как гигабайты: 2 ГБ никто
    // не станет записывать двумя байтами, а 2147483648 — двумя гигабайтами.
    return Math.round(v > 1000 ? v : v * GB);
  }
  const s = String(v == null ? "" : v).trim().toLowerCase().replace(",", ".").replace(/\s+/g, "");
  if (!s) throw new Error(what + ": укажи размер, например 2 ГБ.");
  const m = /^(\d+(?:\.\d+)?)(gb|gb|гб|g|mb|мб|m|b|б)?$/.exec(s);
  if (!m) throw new Error(what + ": «" + v + "» не похоже на размер. Примеры: 2 ГБ, 2048 МБ, 20.");
  const n = Number(m[1]);
  const unit = m[2] || "gb";
  const mul = /^(gb|гб|g)$/.test(unit) ? GB : /^(mb|мб|m)$/.test(unit) ? 1024 * 1024 : 1;
  return Math.round(n * mul);
}

// Байты → человеческая строка. Округление крупное: «1,9 ГБ» мешает читать.
function humanBytes(v) {
  const n = Number(v) || 0;
  if (n <= 0) return "—";
  if (n >= GB) {
    const gb = n / GB;
    const txt = gb >= 100 ? String(Math.round(gb)) : String(Math.round(gb * 10) / 10).replace(".", ",");
    return txt + " ГБ";
  }
  if (n >= 1024 * 1024) return Math.round(n / (1024 * 1024)) + " МБ";
  return Math.round(n) + " Б";
}

function humanSpeed(v) {
  const n = Number(v) || 0;
  if (n <= 0) return "0";
  if (n >= 1024 * 1024) return (Math.round((n / (1024 * 1024)) * 10) / 10).toString().replace(".", ",") + " МБ/с";
  if (n >= 1024) return Math.round(n / 1024) + " КБ/с";
  return Math.round(n) + " Б/с";
}

function humanUptime(fromIso) {
  const t = Date.parse(String(fromIso || ""));
  if (!isFinite(t)) return "—";
  const days = (Date.now() - t) / 86400000;
  if (days < 1) return "меньше суток";
  return Math.floor(days) + " дн.";
}

function parseCores(v) {
  const n = Number(v);
  if (!n || ALLOWED_CORES.indexOf(n) < 0) {
    throw new Error("Ядер «" + v + "» не бывает. Облако разрешает: " + ALLOWED_CORES.slice(0, 8).join(", ") + "… — начни с 2.");
  }
  return n;
}

function parseFraction(v) {
  const n = Number(v != null && v !== "" ? v : CORE_FRACTION_DEFAULT);
  if (ALLOWED_FRACTIONS.indexOf(n) < 0) {
    throw new Error("Уровень производительности «" + v + "» не бывает. Доступно: 20 (экономный), 50, 100 (полное ядро).");
  }
  return n;
}

// ── Статусы и их человеческие слова ─────────────────────────────────────────
const STATUS_WORDS = {
  PROVISIONING: "создаётся",
  RUNNING: "работает",
  STOPPING: "останавливается",
  STOPPED: "остановлена",
  STARTING: "запускается",
  RESTARTING: "перезагружается",
  UPDATING: "обновляется",
  ERROR: "сбой",
  CRASHED: "аварийно остановилась",
  DELETING: "удаляется",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return STATUS_WORDS[s] || (s ? s.toLowerCase() : "неизвестно");
}

function isBusy(status) {
  const s = String(status || "").toUpperCase();
  return ["PROVISIONING", "STOPPING", "STARTING", "RESTARTING", "UPDATING", "DELETING"].indexOf(s) >= 0;
}

function isRunning(status) {
  return String(status || "").toUpperCase() === "RUNNING";
}

// ── Нормализация ответов сервиса ────────────────────────────────────────────
// Карточке и агенту нужны стабильные имена полей, а не то, что вернул сервис.

function diskInfo(d) {
  const o = d || {};
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    typeId: o.typeId || "",
    zoneId: o.zoneId || "",
    size: Number(o.size) || 0,
    sizeHuman: humanBytes(o.size),
    blockSize: Number(o.blockSize) || 0,
    status: o.status || "",
    // instanceIds — кто диск занял. Пустой список = диск лежит сам по себе и
    // продолжает стоить денег (это и есть «платный хвост» при удалении машины).
    instanceIds: (o.instanceIds || []).map(String),
    attached: (o.instanceIds || []).length > 0,
    sourceImageId: o.sourceImageId || "",
    sourceSnapshotId: o.sourceSnapshotId || "",
    createdAt: o.createdAt || "",
  };
}

function snapshotInfo(s) {
  const o = s || {};
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    diskSize: Number(o.diskSize) || 0,
    storageSize: Number(o.storageSize) || 0,
    storageHuman: humanBytes(o.storageSize),
    status: o.status || "",
    sourceDiskId: o.sourceDiskId || "",
    labels: o.labels || {},
    createdAt: o.createdAt || "",
    ageDays: ageDays(o.createdAt),
  };
}

function ageDays(iso) {
  const t = Date.parse(String(iso || ""));
  if (!isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function networkInterfaceInfo(n) {
  const o = n || {};
  const v4 = o.primaryV4Address || {};
  const nat = v4.oneToOneNat || {};
  return {
    index: Number(o.index) || 0,
    mac: o.macAddress || "",
    subnetId: o.subnetId || "",
    internalIp: v4.address || "",
    externalIp: nat.address || "",
    securityGroupIds: (o.securityGroupIds || []).map(String),
  };
}

function diskRefInfo(a) {
  const o = a || {};
  return {
    diskId: o.diskId || "",
    deviceName: o.deviceName || "",
    mode: o.mode || "",
    autoDelete: !!o.autoDelete,
    // autoDelete=false — это и есть диск, который останется после удаления
    // машины и продолжит тарифицироваться.
    keepsAfterDelete: !o.autoDelete,
  };
}

function instanceInfo(i) {
  const o = i || {};
  const nets = (o.networkInterfaces || []).map(networkInterfaceInfo);
  const res = o.resources || {};
  const cores = Number(res.cores) || 0;
  const fraction = Number(res.coreFraction) || 0;
  const memory = Number(res.memory) || 0;
  const externalIp = (nets.find((n) => n.externalIp) || {}).externalIp || "";
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    folderId: o.folderId || "",
    zoneId: o.zoneId || "",
    platformId: o.platformId || "",
    status: o.status || "",
    statusHuman: statusHuman(o.status),
    running: isRunning(o.status),
    busy: isBusy(o.status),
    cores,
    coreFraction: fraction,
    // Доли ядра переводим в «сколько на самом деле»: 2 ядра по 20% — это 0,4 ядра.
    guaranteedVcpu: fraction ? Math.round(cores * (fraction / 100) * 100) / 100 : cores,
    memory,
    memoryHuman: humanBytes(memory),
    preemptible: !!(o.schedulingPolicy && o.schedulingPolicy.preemptible),
    fqdn: o.fqdn || "",
    serviceAccountId: o.serviceAccountId || "",
    labels: o.labels || {},
    createdAt: o.createdAt || "",
    uptime: humanUptime(o.createdAt),
    bootDisk: diskRefInfo(o.bootDisk),
    secondaryDisks: (o.secondaryDisks || []).map(diskRefInfo),
    networkInterfaces: nets,
    subnetIds: nets.map((n) => n.subnetId),
    securityGroupIds: [].concat.apply([], nets.map((n) => n.securityGroupIds)),
    internalIp: (nets.find((n) => n.internalIp) || {}).internalIp || "",
    externalIp,
    hasExternalIp: !!externalIp,
    serialPortSettings: o.serialPortSettings || {},
  };
}

function zoneInfo(z) {
  const o = z || {};
  return { id: o.id || "", status: o.status || "", regionId: o.regionId || "" };
}

function imageInfo(im) {
  const o = im || {};
  return {
    id: o.id || "",
    name: o.name || "",
    family: o.family || "",
    description: o.description || "",
    size: Number(o.size) || 0,
    minDiskSize: Number(o.minDiskSize) || 0,
    minDiskSizeHuman: humanBytes(o.minDiskSize),
    osType: (o.os && o.os.type) || "",
    status: o.status || "",
  };
}

// ── Ключ SSH ────────────────────────────────────────────────────────────────
// Без ключа в машину нельзя войти: у неё нет ни экрана, ни пароля. Ключ — это
// два файла: «скважина» (публичная строка) уезжает в метаданные машины, «сам
// ключ» остаётся у человека.
//
// Почему ed25519 и почему именно так: публичную строку облако ждёт в формате
// OpenSSH («ssh-ed25519 AAAA…»), а приватный ключ Node отдаёт в PEM (PKCS8) —
// этот формат читает и ssh2. Переводить PEM в OpenSSH-приватник незачем:
// лишний код шифрования без пользы.
const SSH_KEY_PREFIX = "ssh-ed25519";

function sshPublicLine(raw32, comment) {
  const type = SSH_KEY_PREFIX;
  const blob = Buffer.concat([
    // uint32 длина имени типа + сам тип
    uint32(type.length),
    Buffer.from(type, "utf8"),
    uint32(raw32.length),
    raw32,
  ]);
  const line = type + " " + blob.toString("base64");
  return comment ? line + " " + comment : line;
}

function uint32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

// Отпечаток — то, что человеку можно показать и сверить: он не даёт доступа.
function sshFingerprint(raw32) {
  const { createHash } = require("crypto");
  const h = createHash("sha256").update(raw32).digest("base64").replace(/=+$/, "");
  return "SHA256:" + h;
}

function looksLikePublicKey(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  // «ssh-rsa AAAA…», «ssh-ed25519 AAAA…», «ecdsa-sha2-nistp256 AAAA…»
  const m = /^(ssh-rsa|ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-dss)\s+([A-Za-z0-9+/=]{40,})(?:\s+(.*))?$/.exec(s);
  if (!m) return null;
  return { type: m[1], body: m[2], comment: (m[3] || "").trim(), line: m[1] + " " + m[2] + (m[3] ? " " + m[3].trim() : "") };
}

// Пару ключей делаем сами, если у человека её нет: без этого создание машины
// упирается в «а где взять ключ». Приватный ключ отдаём наружу ОДИН раз —
// вызывающий обязан положить его в хранилище (Lockbox), а не в файл наугад.
function generateSshKeyPair(o) {
  const opt = o || {};
  const { generateKeyPairSync } = require("crypto");
  const pair = generateKeyPairSync("ed25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI всегда: 30 2a 30 05 06 03 2b 65 70 03 21 00 + 32 байта.
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new Error("Не удалось собрать публичный ключ SSH: неожиданный формат ключа Node.");
  }
  const raw32 = der.subarray(prefix.length);
  const comment = String(opt.comment || "nestdev");
  const publicKey = sshPublicLine(raw32, comment);
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    type: SSH_KEY_PREFIX,
    publicKey,
    privateKey: privateKeyPem,
    fingerprint: sshFingerprint(raw32),
    comment,
  };
}

// Пользователь по умолчанию зависит от образа: у Ubuntu это ubuntu, у Debian
// debian, у AlmaLinux/CentOS — almalinux/centos. Ошибка здесь стоит часа
// поисков «почему не пускает», поэтому определяем по семейству образа.
const IMAGE_USERS = [
  [/ubuntu/i, "ubuntu"],
  [/debian/i, "debian"],
  [/almalinux|alma/i, "almalinux"],
  [/centos/i, "centos"],
  [/fedora/i, "fedora"],
  [/rocky/i, "rocky"],
  [/opensuse|suse/i, "opensuse"],
  [/windows/i, "Administrator"],
];

function sshUserForImage(family, fallback) {
  const f = String(family || "");
  for (const [re, user] of IMAGE_USERS) if (re.test(f)) return user;
  return String(fallback || "ubuntu");
}

// Имена метрик — из справочника Monitoring: проценты в cpu_usage могут быть
// больше 100 у «экономного» уровня производительности, сеть и диск — в байтах
// в секунду. Формат каждого значения задаём готовой функцией: иначе проценты и
// «байты в секунду» пришлось бы различать в двух местах.
const METRIC_NAMES = [
  { key: "cpu", name: "cpu_usage", title: "Процессор", unit: "%", format: (v) => (Math.round(Number(v) * 10) / 10).toString().replace(".", ",") + "%" },
  { key: "netIn", name: "network_received_bytes", title: "Принято из сети", unit: "Б/с", format: humanSpeed },
  { key: "netOut", name: "network_sent_bytes", title: "Отдано в сеть", unit: "Б/с", format: humanSpeed },
  { key: "diskRead", name: "disk.read_bytes", title: "Чтение с диска", unit: "Б/с", format: humanSpeed },
  { key: "diskWrite", name: "disk.write_bytes", title: "Запись на диск", unit: "Б/с", format: humanSpeed },
];

function createYcCompute(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError =
    typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Compute: модулю не переданы помощники облака (fetchJson, getIamToken).");
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

  function compute(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "compute", COMPUTE_FALLBACK, method, path, body, timeoutMs);
  }

  // Ожидание операции. Возвращаем тело операции: id готового объекта у части
  // методов приходит только в response (та же тонкость, что у ресурсов).
  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 240000);
    return op || {};
  }

  async function listByFolder(oauthToken, path, key, folderId) {
    const folder = checkFolder(folderId);
    const j = await compute(
      oauthToken,
      "GET",
      path + "?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return Array.isArray(j && j[key]) ? j[key] : [];
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  async function instances(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/compute/v1/instances", "instances", folderId)).map(instanceInfo);
  }

  async function instance(oauthToken, id) {
    const i = String(id || "").trim();
    if (!i) throw new Error("Не указан id машины.");
    return instanceInfo(await compute(oauthToken, "GET", "/compute/v1/instances/" + encodeURIComponent(i), undefined, 25000));
  }

  async function disks(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/compute/v1/disks", "disks", folderId)).map(diskInfo);
  }

  async function snapshots(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/compute/v1/snapshots", "snapshots", folderId)).map(snapshotInfo);
  }

  async function zones(oauthToken) {
    const j = await compute(oauthToken, "GET", "/compute/v1/zones", undefined, 20000);
    return (Array.isArray(j && j.zones) ? j.zones : []).map(zoneInfo);
  }

  async function diskTypes(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/diskTypes?folderId=" + encodeURIComponent(folder) + "&pageSize=100",
      undefined,
      20000
    );
    return (Array.isArray(j && j.diskTypes) ? j.diskTypes : []).map((d) => ({
      id: d.id || "",
      description: d.description || "",
      zoneIds: d.zoneIds || [],
    }));
  }

  // Публичные образы лежат в служебном каталоге standard-images. Именно так
  // выбирают «Ubuntu 22.04» и не знают её id — он меняется с каждым обновлением.
  async function imageByFamily(oauthToken, family, folderId) {
    const f = String(family || IMAGE_FAMILY_DEFAULT).trim();
    const folder = String(folderId || "standard-images");
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/images:latestByFamily?folderId=" + encodeURIComponent(folder) + "&family=" + encodeURIComponent(f),
      undefined,
      25000
    );
    if (!j || !j.id) throw new Error("Не нашёл образ семейства «" + f + "». Проверь имя семейства (например ubuntu-2204-lts) или укажи imageId.");
    return imageInfo(j);
  }

  async function findInstance(oauthToken, folderId, ref) {
    const list = await instances(oauthToken, folderId);
    const q = String(ref == null ? "" : ref).trim();
    const got = list.find((i) => i.id === q) || list.find((i) => i.name === q) || list.find((i) => i.fqdn === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  async function findDisk(oauthToken, folderId, ref) {
    const list = await disks(oauthToken, folderId);
    const q = String(ref == null ? "" : ref).trim();
    const got = list.find((d) => d.id === q) || list.find((d) => d.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  async function findSnapshot(oauthToken, folderId, ref) {
    const list = await snapshots(oauthToken, folderId);
    const q = String(ref == null ? "" : ref).trim();
    const got = list.find((s) => s.id === q) || list.find((s) => s.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  // Платные хвосты: снимки и диски, за которые платят, но которые уже никому
  // не нужны. Без этого поиска удалённая машина тихо оставляет счёт.
  function paidLeftovers(ctx) {
    const o = ctx || {};
    const inst = o.instances || [];
    const attachedIds = new Set();
    for (const i of inst) {
      if (i.bootDisk && i.bootDisk.diskId) attachedIds.add(i.bootDisk.diskId);
      for (const d of i.secondaryDisks || []) if (d.diskId) attachedIds.add(d.diskId);
    }
    const orphanDisks = (o.disks || []).filter((d) => !d.instanceIds.length && !attachedIds.has(d.id));
    // Снимок нужен, только если есть диск, из которого он сделан. Снимок диска,
    // которого больше нет в каталоге, — это чистая плата за хранение.
    const diskIds = new Set((o.disks || []).map((d) => d.id));
    const orphanSnapshots = (o.snapshots || []).filter((s) => s.sourceDiskId && !diskIds.has(s.sourceDiskId));
    const idleAddresses = (o.addresses || []).filter((a) => !a.used);
    return {
      disks: orphanDisks,
      snapshots: orphanSnapshots,
      addresses: idleAddresses,
      total: orphanDisks.length + orphanSnapshots.length + idleAddresses.length,
      lines: [
        orphanDisks.length ? "диски без машины: " + orphanDisks.map((d) => d.name + " " + d.sizeHuman).join(", ") : "",
        orphanSnapshots.length ? "снимки удалённых дисков: " + orphanSnapshots.map((s) => s.name).join(", ") : "",
        idleAddresses.length ? "простаивающие статические адреса: " + idleAddresses.map((a) => a.address || a.name).join(", ") : "",
      ].filter(Boolean),
    };
  }

  // ── Питание ───────────────────────────────────────────────────────────────
  // start/stop/restart — обратимы и дёшевы по риску, но у `stop` есть важное
  // следствие: временный публичный адрес у машины освобождается. Следующий
  // запуск может получить ДРУГОЙ адрес — поэтому это видно в предупреждении.

  async function power(oauthToken, action, ref, o) {
    const opt = o || {};
    const act = String(action || "").trim().toLowerCase();
    if (["start", "stop", "restart"].indexOf(act) < 0) {
      throw new Error("Питание машины: неизвестное действие «" + action + "». Доступно: start, stop, restart.");
    }
    const inst = ref && ref.id ? ref : await findInstance(oauthToken, opt.folderId, ref);
    if (!inst) throw new Error("Не нашёл машину «" + (ref || "") + "».");
    if (act === "start" && inst.running) return { changed: false, instance: inst, message: "Машина «" + inst.name + "» уже работает." };
    if (act === "stop" && !inst.running && String(inst.status).toUpperCase() === "STOPPED") {
      return { changed: false, instance: inst, message: "Машина «" + inst.name + "» уже остановлена." };
    }
    if (inst.busy) {
      throw new Error(
        "Машина «" + inst.name + "» сейчас занята: " + inst.statusHuman + ". Дождись окончания и повтори."
      );
    }
    const j = await compute(oauthToken, "POST", "/compute/v1/instances/" + encodeURIComponent(inst.id) + ":" + act, undefined, 30000);
    await run(oauthToken, j, 240000);
    const after = await instance(oauthToken, inst.id).catch(() => null);
    const now = after || inst;
    const warns = [];
    if (act === "stop" && inst.externalIp) {
      warns.push(
        "У остановленной машины публичный адрес " + inst.externalIp + " освобождается. Следующий запуск, скорее всего, получит другой — " +
          "если адрес нужен постоянным, закрепи статический и привяжи его к новой машине (ycVpc: reserve)."
      );
    }
    if (act !== "stop") {
      warns.push("Машина платит за каждый час работы — «просто так работает» тоже стоит денег. Останови, когда не нужна.");
    }
    return {
      changed: true,
      action: act,
      instance: now,
      message:
        (act === "start" ? "Машина «" + now.name + "» запущена" : act === "stop" ? "Машина «" + now.name + "» остановлена" : "Машина «" + now.name + "» перезагружается") +
        (now.externalIp ? " — адрес " + now.externalIp : "") +
        (after ? ", состояние: " + after.statusHuman : "") +
        ".",
      warnings: warns,
    };
  }

  // ── Создание машины ───────────────────────────────────────────────────────

  async function createInstance(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);

    const presetKey = String(opt.preset || "").trim().toLowerCase();
    const preset = presetKey && PRESETS[presetKey] ? PRESETS[presetKey] : null;
    if (presetKey && !preset) {
      throw new Error("Набора «" + presetKey + "» нет. Доступно: " + PRESET_KEYS.join(", ") + " — или задай ядра, память и диск явно.");
    }

    const cores = parseCores(opt.cores != null ? opt.cores : preset ? preset.cores : CORES_DEFAULT);
    const memoryBytes = bytesFromHuman(
      opt.memoryGb != null ? opt.memoryGb + "GB" : opt.memory != null ? opt.memory : preset ? preset.memoryGb + "GB" : MEMORY_GB_DEFAULT + "GB",
      "Память машины"
    );
    const coreFraction = parseFraction(
      opt.coreFraction != null ? opt.coreFraction : opt.cpuGuarantee != null ? opt.cpuGuarantee : preset ? preset.coreFraction : CORE_FRACTION_DEFAULT
    );
    const platformId = String(opt.platformId || opt.platform || PLATFORM_DEFAULT).trim();

    // Подсеть: сначала ищем по имени/ид, и только потом — «единственная в зоне».
    const folderSubnets = await listByFolder(oauthToken, "/vpc/v1/subnets", "subnets", folderId);
    let subnet = null;
    if (opt.subnetId) {
      subnet = folderSubnets.find((s) => s.id === String(opt.subnetId)) || null;
      if (!subnet) throw new Error("Подсеть с id «" + opt.subnetId + "» не найдена в каталоге.");
    } else if (opt.subnet) {
      subnet = folderSubnets.find((s) => s.name === String(opt.subnet)) || folderSubnets.find((s) => s.id === String(opt.subnet)) || null;
      if (!subnet) {
        throw new Error(
          "Не нашёл подсеть «" + opt.subnet + "»." +
            (folderSubnets.length ? " В каталоге: " + folderSubnets.map((s) => s.name + " (" + s.zoneId + ")").join(", ") : " Подсетей нет — создай: ycVpc { action: \"addsubnet\", ... }.")
        );
      }
    }

    // Зона: приоритет у явной, иначе — зона подсети, иначе значение по умолчанию.
    let zoneId = String(opt.zoneId || opt.zone || "").trim();
    if (!zoneId) zoneId = subnet ? String(subnet.zoneId || "") : "";
    if (!zoneId) zoneId = ZONE_DEFAULT;

    if (!subnet) {
      const inZone = folderSubnets.filter((s) => s.zoneId === zoneId);
      if (inZone.length === 1) subnet = inZone[0];
      else if (folderSubnets.length === 1) subnet = folderSubnets[0];
      else if (inZone.length > 1) {
        throw new Error(
          "В зоне " + zoneId + " несколько подсетей — выбери одну (subnet): " + inZone.map((s) => s.name).join(", ") + "."
        );
      } else {
        throw new Error(
          "В зоне " + zoneId + " нет подсети, а машина без подсети не встанет. Создай подсеть в этой зоне: " +
            "ycVpc { action: \"addsubnet\", name: \"app-subnet-a\", network: \"<имя сети>\", zone: \"" + zoneId + "\", cidr: \"" +
            (folderSubnets.length ? "10.10.0.0/24" : "10.10.0.0/24") + "\" }." +
            (folderSubnets.length ? " Есть подсети в других зонах: " + folderSubnets.map((s) => s.name + " (" + s.zoneId + ")").join(", ") + "." : "")
        );
      }
    }
    if (zoneId !== subnet.zoneId) {
      throw new Error(
        "Зона машины (" + zoneId + ") и зона подсети «" + subnet.name + "» (" + subnet.zoneId + ") разные. Машина подключается к подсети СВОЕЙ зоны — " +
          "укажи zone: \"" + subnet.zoneId + "\" или выбери подсеть в зоне " + zoneId + "."
      );
    }

    // Группы безопасности: если их не задать, машина получит группу по умолчанию
    // этой сети, а та запрещает вход снаружи — SSH просто не откроется. Поэтому
    // про это сказано прямо в предупреждении.
    const nets = await listByFolder(oauthToken, "/vpc/v1/networks", "networks", folderId);
    const net = nets.find((n) => n.id === subnet.networkId) || null;
    const wanted = (Array.isArray(opt.securityGroupIds) ? opt.securityGroupIds : opt.securityGroupIds || opt.securityGroups || opt.sg
      ? [].concat(opt.securityGroupIds || opt.securityGroups || opt.sg)
      : []).map((x) => String(x).trim()).filter(Boolean);
    let securityGroupIds = [];
    if (wanted.length) {
      const groups = await listByFolder(oauthToken, "/vpc/v1/securityGroups", "securityGroups", folderId);
      for (const w of wanted) {
        const g = groups.find((x) => x.id === w) || groups.find((x) => x.name === w);
        if (!g) {
          throw new Error("Не нашёл группу безопасности «" + w + "»." + (groups.length ? " В каталоге: " + groups.map((x) => x.name).join(", ") : " Групп нет — создай: ycVpc { action: \"addgroup\", ... }."));
        }
        securityGroupIds.push(g.id);
      }
    } else if (net && net.defaultSecurityGroupId) {
      securityGroupIds = [net.defaultSecurityGroupId];
    }

    // Образ: либо явный id, либо семейство (Ubuntu 22.04 и т. п.). Если машина
    // поднимается с ГОТОВОГО диска (после восстановления из снимка), образа нет
    // вовсе: система уже лежит на диске, и запрашивать образ было бы лишним
    // запросом, а главное — облако отвергло бы лишний аргумент.
    const bootDiskId = String(opt.bootDiskId || "").trim();
    const imageFamily = String(opt.imageFamily || opt.image || (opt.imageId || bootDiskId ? "" : IMAGE_FAMILY_DEFAULT)).trim();
    let image = null;
    if (!bootDiskId) {
      if (opt.imageId) image = { id: String(opt.imageId), family: imageFamily, minDiskSize: 0 };
      else image = await imageByFamily(oauthToken, imageFamily);
    }

    const diskTypeId = String(opt.diskTypeId || opt.diskType || (preset ? preset.diskTypeId : DISK_TYPE_DEFAULT)).trim();
    const diskSizeBytes = bootDiskId
      ? 0
      : bytesFromHuman(
          opt.diskSizeGb != null ? opt.diskSizeGb + "GB" : opt.diskSize != null ? opt.diskSize : preset ? preset.diskSizeGb + "GB" : DISK_SIZE_GB_DEFAULT + "GB",
          "Размер диска"
        );
    if (!bootDiskId && image.minDiskSize && diskSizeBytes < image.minDiskSize) {
      throw new Error(
        "Диск " + humanBytes(diskSizeBytes) + " меньше, чем требует образ («" + (image.family || image.name) + "»): нужно минимум " +
          humanBytes(image.minDiskSize) + ". Увеличь диск."
      );
    }

    // Готовый диск обязан жить в той же зоне, что и машина — иначе облако
    // отказывает уже на середине операции.
    if (bootDiskId) {
      const disk = (await disks(oauthToken, folderId)).find((d) => d.id === bootDiskId) || null;
      if (!disk) throw new Error("Диск с id «" + bootDiskId + "» не найден в каталоге — восстанови его из снимка: ycCompute { action: \"restoredisk\" }.");
      if (disk.attached) throw new Error("Диск «" + disk.name + "» уже занят машиной — один и тот же диск не подключается дважды.");
      if (disk.zoneId && disk.zoneId !== zoneId) {
        throw new Error("Диск «" + disk.name + "» в зоне " + disk.zoneId + ", а машина — в " + zoneId + ". Диск в другую зону не переносится: создай машину в зоне диска.");
      }
    }

    // SSH-ключ и включение serial-консоли. Консоль включается ТОЛЬКО здесь —
    // задним числом её включать отдельным вызовом неудобно и легко забыть.
    const pub = looksLikePublicKey(opt.sshPublicKey || opt.publicKey);
    const sshUser = String(opt.sshUser || "").trim() || sshUserForImage(imageFamily, "ubuntu");
    const metadata = {};
    for (const k of Object.keys(opt.metadata || {})) metadata[k] = String(opt.metadata[k]);
    if (pub) metadata["ssh-keys"] = sshUser + ":" + pub.line;
    if (opt.serialPort !== false) metadata["serial-port-enable"] = "1";

    const iface = {
      subnetId: subnet.id,
      primaryV4AddressSpec: {},
    };
    if (securityGroupIds.length) iface.securityGroupIds = securityGroupIds;

    // Публичный адрес: без просьбы его нет. Статический задаётся ЗНАЧЕНИЕМ
    // адреса (так его и ждёт API), а не id.
    const wantPublic = opt.publicIp === true || !!opt.staticAddress || !!opt.externalIp;
    if (wantPublic) {
      const nat = { ipVersion: "IPV4" };
      const staticIp = String(opt.staticAddress || opt.externalIp || "").trim();
      if (staticIp) {
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(staticIp)) {
          throw new Error("Статический адрес «" + staticIp + "» не понял: нужен вид 203.0.113.10 (закрепить адрес: ycVpc { action: \"reserve\" }).");
        }
        nat.address = staticIp;
      }
      iface.primaryV4AddressSpec.oneToOneNatSpec = nat;
    }

    const body = {
      folderId,
      name,
      zoneId,
      platformId,
      resourcesSpec: { memory: String(memoryBytes), cores: String(cores) },
      bootDiskSpec: bootDiskId
        ? { autoDelete: opt.keepBootDisk === true ? false : true, diskId: bootDiskId }
        : {
            autoDelete: opt.keepBootDisk === true ? false : true,
            diskSpec: { typeId: diskTypeId, size: String(diskSizeBytes) },
          },
      networkInterfaceSpecs: [iface],
    };
    if (image && image.id) body.bootDiskSpec.diskSpec.imageId = image.id;
    if (coreFraction && coreFraction !== 100) body.resourcesSpec.coreFraction = String(coreFraction);
    if (Object.keys(metadata).length) body.metadata = metadata;
    if (opt.description) body.description = String(opt.description);
    if (opt.hostname) body.hostname = checkName(opt.hostname);
    if (opt.preemptible === true) body.schedulingPolicy = { preemptible: true };
    if (opt.serviceAccountId) body.serviceAccountId = String(opt.serviceAccountId);
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;

    // Второй диск — необязательный, но частый случай (данные отдельно от системы).
    // Когда машина поднимается с готового диска, второй диск описывают отдельно;
    // здесь оставлен тот же путь, но с явной оговоркой, что так делают не всегда.
    if (opt.dataDiskSizeGb != null || opt.dataDiskSize != null || opt.secondDiskSizeGb != null) {
      const dataSize = bytesFromHuman(
        opt.dataDiskSizeGb != null ? opt.dataDiskSizeGb + "GB" : opt.dataDiskSize != null ? opt.dataDiskSize : opt.secondDiskSizeGb + "GB",
        "Размер диска с данными"
      );
      body.secondaryDiskSpecs = [
        {
          autoDelete: true,
          diskSpec: { typeId: diskTypeId, size: String(dataSize), name: name + "-data" },
        },
      ];
    }

    const j = await compute(oauthToken, "POST", "/compute/v1/instances", body, 30000);
    const op = await run(oauthToken, j, 300000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? await instance(oauthToken, id).catch(() => null) : null;
    const result = made || instanceInfo({ id, name, zoneId, folderId, resources: { cores, memory: memoryBytes, coreFraction: coreFraction }, status: "PROVISIONING" });

    const warns = [];
    if (!pub) {
      warns.push(
        "SSH-ключ не задан — войти в машину будет нельзя (пароля у неё нет). Перед созданием сгенерируй ключ и передай sshPublicKey; " +
          "ключ, созданный парой, хранится в облачном хранилище секретов, а не в коде."
      );
    }
    if (!wanted.length && securityGroupIds.length) {
      warns.push(
        "Машина подключена к группе безопасности по умолчанию (она запрещает вход снаружи). Чтобы открыть SSH, добавь правило ВХОДА на 22 порт " +
          "только со своего адреса: ycVpc { action: \"addrule\", group: \"" + securityGroupIds[0] + "\", direction: \"ingress\", protocol: \"tcp\", port: 22, cidr: \"<твой адрес>/32\" }."
      );
    }
    if (!wantPublic) {
      warns.push("Публичного адреса у машины нет: снаружи она недоступна. Если нужен сайт в интернете — пересоздай с публичным адресом (или привяжи статический).");
    }
    warns.push("Машина платит за каждый час существования, даже когда ничего не делает. Останови её, когда закончишь: ycCompute { action: \"stop\" }.");

    return {
      instance: result,
      image: image,
      bootDiskId,
      subnet: { id: subnet.id, name: subnet.name, zoneId: subnet.zoneId, networkId: subnet.networkId },
      securityGroupIds,
      memoryBytes,
      cores,
      coreFraction,
      diskSizeBytes,
      diskTypeId,
      sshUser: pub ? sshUser : "",
      publicIp: wantPublic,
      warnings: warns,
    };
  }

  // ── Удаление машины ───────────────────────────────────────────────────────
  // Удалить машину легко; дорого — забыть про её диски. Диски с autoDelete=true
  // уходят вместе с машиной, остальные остаются и продолжают тарифицироваться.
  // Поэтому сначала считаем, что останется, и удаляем это ТОЛЬКО если попросили.

  async function deleteInstance(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const inst = opt.instanceId || opt.id
      ? await instance(oauthToken, opt.instanceId || opt.id)
      : await findInstance(oauthToken, folderId, opt.name || opt.instance);
    if (!inst) throw new Error("Не нашёл машину «" + (opt.name || opt.instance || opt.instanceId || opt.id || "") + "».");

    const attachedIds = [inst.bootDisk.diskId].concat(inst.secondaryDisks.map((d) => d.diskId)).filter(Boolean);
    const before = (await disks(oauthToken, folderId)).filter((d) => attachedIds.indexOf(d.id) >= 0);

    const j = await compute(oauthToken, "DELETE", "/compute/v1/instances/" + encodeURIComponent(inst.id), undefined, 30000);
    await run(oauthToken, j, 300000);

    const left = await compute(oauthToken, "GET", "/compute/v1/instances/" + encodeURIComponent(inst.id), undefined, 20000).catch(() => null);
    if (left) throw new Error("Машина «" + inst.name + "» не удалилась: она ещё существует. Проверь права (compute.admin) в каталоге.");

    // Что осталось: диски с autoDelete=false и любые, что не были привязаны.
    const after = await disks(oauthToken, folderId).catch(() => []);
    const orphans = after.filter((d) => attachedIds.indexOf(d.id) >= 0 && !d.instanceIds.length);

    const deletedDisks = [];
    const keptDisks = [];
    if (opt.deleteDisks === true) {
      for (const d of orphans) {
        try {
          const dj = await compute(oauthToken, "DELETE", "/compute/v1/disks/" + encodeURIComponent(d.id), undefined, 30000);
          await run(oauthToken, dj, 240000);
          deletedDisks.push(d);
        } catch (e) {
          keptDisks.push({ disk: d, error: (e && e.message) || String(e) });
        }
      }
    } else {
      keptDisks.push.apply(keptDisks, orphans.map((d) => ({ disk: d, error: "" })));
    }

    // Статический адрес: освобождаем только по явной просьбе — вернуть его уже
    // нельзя, а на нём могут висеть DNS и белые списки.
    let releasedAddress = null;
    if (opt.releaseAddress === true && inst.externalIp) {
      try {
        const addrs = await listByFolder(oauthToken, "/vpc/v1/addresses", "addresses", folderId);
        const ad = addrs.find((a) => (a.externalIpv4Address && a.externalIpv4Address.address) === inst.externalIp);
        if (ad && !ad.used) {
          const aj = await compute(oauthToken, "DELETE", "/vpc/v1/addresses/" + encodeURIComponent(ad.id), undefined, 30000);
          await run(oauthToken, aj, 180000);
          releasedAddress = inst.externalIp;
        }
      } catch {
        releasedAddress = null;
      }
    }

    const warns = [];
    if (keptDisks.length) {
      warns.push(
        "Остались платные диски (" + keptDisks.length + "): " + keptDisks.map((k) => k.disk.name + " " + k.disk.sizeHuman).join(", ") +
          ". Они тарифицируются, хотя машины уже нет. Удалить их вместе с машиной нужно было с deleteDisks: true; " +
          "сейчас — либо снимок и удаление, либо пересоздай машину с этими дисками."
      );
    }
    if (deletedDisks.length) {
      warns.push("Удалены диски (" + deletedDisks.length + "): " + deletedDisks.map((d) => d.name).join(", ") + ". Данные с них восстановить нельзя — только из снимка.");
    }
    if (inst.externalIp && !releasedAddress) {
      warns.push("Публичный адрес " + inst.externalIp + " мог быть статическим: проверь простаивающие адреса (ycVpc { action: \"addresses\" }) — за неиспользуемый адрес берут плату.");
    }
    warns.push("Данные на дисках машины, если не сделано ни одного снимка, потеряны безвозвратно.");

    return {
      deleted: true,
      instance: inst,
      deletedDisks,
      keptDisks,
      releasedAddress,
      warnings: warns,
      message:
        "Машина «" + inst.name + "» удалена" +
        (deletedDisks.length ? " вместе с дисками (" + deletedDisks.length + ")" : "") +
        (keptDisks.length ? ", но остались платные диски: " + keptDisks.length : "") +
        (releasedAddress ? ". Статический адрес " + releasedAddress + " освобождён" : "") + ".",
    };
  }

  // ── Снимки ────────────────────────────────────────────────────────────────
  // Снимок — единственная защита от «удалил и потерял». Стоит он как хранение
  // объёма снимка, поэтому старые снимки надо чистить, но чистить осознанно:
  // здесь всегда сначала показываем, что будет удалено (dryRun).

  async function createSnapshot(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    let disk = null;
    if (opt.diskId) {
      const list = await disks(oauthToken, folderId);
      disk = list.find((d) => d.id === String(opt.diskId)) || null;
      if (!disk) throw new Error("Диск с id «" + opt.diskId + "» не найден в каталоге.");
    } else if (opt.disk) {
      disk = await findDisk(oauthToken, folderId, opt.disk);
      if (!disk) throw new Error("Не нашёл диск «" + opt.disk + "».");
    } else if (opt.instance || opt.instanceId) {
      const inst = opt.instanceId ? await instance(oauthToken, opt.instanceId) : await findInstance(oauthToken, folderId, opt.instance);
      if (!inst) throw new Error("Не нашёл машину «" + (opt.instance || opt.instanceId) + "».");
      const withDisk = (await disks(oauthToken, folderId)).find((d) => d.id === inst.bootDisk.diskId);
      disk = withDisk || null;
      if (!disk) throw new Error("У машины «" + inst.name + "» не нашёл загрузочный диск — сними снимок с диска напрямую (disk).");
    } else {
      throw new Error("Укажи, с чего делать снимок: disk (имя или id диска) либо instance (имя или id машины).");
    }

    const name = opt.name ? checkName(opt.name) : checkName(disk.name + "-snap-" + new Date().toISOString().slice(0, 10));
    const body = { folderId, diskId: disk.id, name };
    if (opt.description) body.description = String(opt.description);

    const j = await compute(oauthToken, "POST", "/compute/v1/snapshots", body, 30000);
    const op = await run(oauthToken, j, 600000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? (await snapshots(oauthToken, folderId)).find((s) => s.id === id) || null : null;
    return {
      snapshot: made || snapshotInfo({ id, name, sourceDiskId: disk.id, diskSize: disk.size }),
      disk,
      warnings: [
        "Снимок хранится и тарифицируется, пока его не удалят: «на всякий случай» превращается в постоянные расходы.",
        "Снимок делается с диска, который работает: для базы данных лучше сначала остановить запись, иначе снимок будет как у выключенного питания.",
      ],
    };
  }

  async function deleteSnapshot(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const snap = opt.snapshotId
      ? (await snapshots(oauthToken, folderId)).find((s) => s.id === String(opt.snapshotId)) || null
      : await findSnapshot(oauthToken, folderId, opt.snapshot || opt.name);
    if (!snap) throw new Error("Не нашёл снимок «" + (opt.snapshot || opt.name || opt.snapshotId || "") + "».");
    const j = await compute(oauthToken, "DELETE", "/compute/v1/snapshots/" + encodeURIComponent(snap.id), undefined, 30000);
    await run(oauthToken, j, 300000);
    const left = (await snapshots(oauthToken, folderId).catch(() => [])).some((s) => s.id === snap.id);
    if (left) throw new Error("Снимок «" + snap.name + "» не удалился: он ещё существует. Проверь права (compute.admin).");
    return { deleted: true, snapshot: snap, message: "Снимок «" + snap.name + "» удалён." };
  }

  // Чистка старых снимков. По умолчанию НИЧЕГО не удаляет — только показывает.
  // keep — сколько последних снимков на каждый диск оставить.
  async function cleanSnapshots(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const keep = Number(opt.keep) >= 0 ? Number(opt.keep) : 2;
    const olderThanDays = Number(opt.olderThanDays) > 0 ? Number(opt.olderThanDays) : 0;
    const all = await snapshots(oauthToken, folderId);
    const filtered = opt.disk ? all.filter((s) => s.sourceDiskId === String(opt.disk) || s.name.indexOf(String(opt.disk)) === 0) : all;

    const byDisk = new Map();
    for (const s of filtered) {
      const key = s.sourceDiskId || "(диск неизвестен)";
      if (!byDisk.has(key)) byDisk.set(key, []);
      byDisk.get(key).push(s);
    }
    const doomed = [];
    const kept = [];
    for (const [, list] of byDisk) {
      const sorted = list.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      sorted.forEach((s, idx) => {
        const tooOld = olderThanDays > 0 && s.ageDays != null && s.ageDays >= olderThanDays;
        if (idx >= keep || tooOld) doomed.push(s);
        else kept.push(s);
      });
    }

    const dryRun = opt.dryRun !== false;
    const removed = [];
    const failed = [];
    if (!dryRun) {
      for (const s of doomed) {
        try {
          const j = await compute(oauthToken, "DELETE", "/compute/v1/snapshots/" + encodeURIComponent(s.id), undefined, 30000);
          await run(oauthToken, j, 300000);
          removed.push(s);
        } catch (e) {
          failed.push({ snapshot: s, error: (e && e.message) || String(e) });
        }
      }
    }

    return {
      dryRun,
      keep,
      olderThanDays,
      total: filtered.length,
      doomed,
      kept,
      removed,
      failed,
      message: dryRun
        ? "Пока ничего не удалено. К удалению: " + doomed.length + " снимок(ов), останется " + kept.length + ". Чтобы удалить — повтори с dryRun: false."
        : "Удалено снимков: " + removed.length + (failed.length ? ", не удалось: " + failed.length : "") + ". Осталось: " + (filtered.length - removed.length) + ".",
      warnings: failed.length ? ["Часть снимков не удалилась: " + failed.map((f) => f.snapshot.name + " — " + f.error).join("; ")] : [],
    };
  }

  // Восстановление диска из снимка: создаётся НОВЫЙ диск. Машина от этого не
  // появляется — её надо создать с этим диском как загрузочным (или привязать).
  async function restoreDisk(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const snap = opt.snapshotId
      ? (await snapshots(oauthToken, folderId)).find((s) => s.id === String(opt.snapshotId)) || null
      : await findSnapshot(oauthToken, folderId, opt.snapshot);
    if (!snap) throw new Error("Не нашёл снимок «" + (opt.snapshot || opt.snapshotId || "") + "».");
    const name = checkName(opt.name || snap.name + "-restored");
    const zoneId = String(opt.zoneId || opt.zone || "").trim();
    if (!zoneId) throw new Error("Укажи зону (zone) нового диска: диск живёт в одной зоне, например ru-central1-a.");
    const sizeBytes = opt.sizeGb != null ? bytesFromHuman(opt.sizeGb + "GB", "Размер диска") : 0;
    if (sizeBytes && snap.diskSize && sizeBytes < snap.diskSize) {
      throw new Error("Восстановленный диск не может быть меньше снимка: " + humanBytes(snap.diskSize) + ".");
    }
    const body = {
      folderId,
      name,
      zoneId,
      typeId: String(opt.diskTypeId || opt.diskType || DISK_TYPE_DEFAULT),
      snapshotId: snap.id,
    };
    if (sizeBytes) body.size = String(sizeBytes);
    if (opt.description) body.description = String(opt.description);

    const j = await compute(oauthToken, "POST", "/compute/v1/disks", body, 30000);
    const op = await run(oauthToken, j, 600000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? (await disks(oauthToken, folderId)).find((d) => d.id === id) || null : null;
    return {
      disk: made || diskInfo({ id, name, zoneId, size: sizeBytes || snap.diskSize, sourceSnapshotId: snap.id }),
      snapshot: snap,
      message:
        "Диск «" + name + "» восстановлен из снимка «" + snap.name + "» (" + humanBytes(sizeBytes || snap.diskSize) + ", зона " + zoneId + "). " +
        "Машины у него пока нет: чтобы поднять её с этих данных, создай машину с этим диском как загрузочным.",
      warnings: ["Восстановленный диск тарифицируется отдельно и сам по себе не работает — привяжи его к машине или удали после проверки."],
    };
  }

  // ── Serial-консоль ────────────────────────────────────────────────────────
  // Единственный способ увидеть, что происходит внутри машины, у которой нет
  // экрана: текст загрузки. Без него «машина не отвечает» — тупик.

  async function serialOutput(oauthToken, o) {
    const opt = o || {};
    const folderId = opt.folderId;
    const inst = opt.instanceId ? await instance(oauthToken, opt.instanceId) : await findInstance(oauthToken, folderId, opt.instance || opt.name);
    if (!inst) throw new Error("Не нашёл машину «" + (opt.instance || opt.name || opt.instanceId || "") + "».");
    const port = Number(opt.port) > 0 ? Number(opt.port) : 1;
    const j = await compute(
      oauthToken,
      "GET",
      "/compute/v1/instances/" + encodeURIComponent(inst.id) + ":serialPortOutput?port=" + port,
      undefined,
      30000
    );
    const contents = String((j && j.contents) || "");
    const lines = contents.split("\n");
    // Отдаём хвост: начало загрузки не меняется, глазами ищут последние строки.
    const tail = lines.slice(Math.max(0, lines.length - (Number(opt.lines) > 0 ? Number(opt.lines) : 200)));
    return {
      instance: inst,
      port,
      empty: !contents.trim(),
      contents,
      lines: tail,
      message: contents.trim()
        ? "Serial-консоль машины «" + inst.name + "», последние " + tail.length + " строк."
        : "Serial-консоль машины «" + inst.name + "» пуста. Если машина создана без serial-port-enable в метаданных, консоль выключена — пересоздай машину с включённой консолью.",
    };
  }

  // ── Метрики ───────────────────────────────────────────────────────────────
  // Метрики живут в отдельном сервисе (Monitoring), а не в Compute: там же
  // видно, «машина действительно работает или просто числится».
  // Имена метрик — из справочника: cpu_usage в процентах (может быть больше 100
  // у «экономного» уровня), сеть и диск в байтах в секунду.
  function summarizeSeries(series) {
    const ts = (series && series.timeseries) || {};
    const values = (ts.doubleValues && ts.doubleValues.length ? ts.doubleValues : ts.int64Values) || [];
    const nums = values.map(Number).filter((v) => isFinite(v));
    if (!nums.length) return { count: 0, avg: null, max: null, last: null, points: [] };
    const sum = nums.reduce((a, b) => a + b, 0);
    return {
      count: nums.length,
      avg: sum / nums.length,
      max: Math.max.apply(null, nums),
      last: nums[nums.length - 1],
      points: nums.slice(-40),
    };
  }

  async function metrics(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const inst = opt.instanceId ? await instance(oauthToken, opt.instanceId) : await findInstance(oauthToken, folderId, opt.instance || opt.name);
    if (!inst) throw new Error("Не нашёл машину «" + (opt.instance || opt.name || opt.instanceId || "") + "».");
    const minutes = Number(opt.minutes) > 0 ? Number(opt.minutes) : 60;
    const to = new Date();
    const from = new Date(to.getTime() - minutes * 60000);
    const wanted = (Array.isArray(opt.metrics) && opt.metrics.length
      ? METRIC_NAMES.filter((m) => opt.metrics.indexOf(m.name) >= 0 || opt.metrics.indexOf(m.key) >= 0)
      : METRIC_NAMES
    ).filter(Boolean);

    const out = [];
    const errors = [];
    for (const m of wanted) {
      const query = m.name + '{service="compute", resource_id="' + inst.id + '"}';
      const body = {
        query,
        fromTime: from.toISOString().replace(/\.\d{3}Z$/, "Z"),
        toTime: to.toISOString().replace(/\.\d{3}Z$/, "Z"),
        downsampling: { maxPoints: 30, gridAggregation: "AVG", gapFilling: "NULL" },
      };
      try {
        const j = await call(
          oauthToken,
          "monitoring",
          MONITORING_FALLBACK,
          "POST",
          "/monitoring/v2/data/read?folderId=" + encodeURIComponent(folderId),
          body,
          30000
        );
        const list = (j && j.metrics) || [];
        const summary = summarizeSeries(list[0]);
        out.push({ key: m.key, name: m.name, title: m.title, unit: m.unit, format: m.format, summary });
      } catch (e) {
        errors.push({ key: m.key, name: m.name, error: (e && e.message) || String(e) });
      }
    }

    // Текст — то, что читает человек и агент: цифры без подписи бесполезны.
    const lines = [];
    for (const m of out) {
      const s = m.summary;
      if (!s.count) {
        lines.push(m.title + ": данных за " + minutes + " мин нет (машина могла быть остановлена)");
        continue;
      }
      lines.push(m.title + ": в среднем " + m.format(s.avg) + ", максимум " + m.format(s.max) + " (точек: " + s.count + ")");
    }
    const cpu = out.find((m) => m.key === "cpu");
    const cpuAvg = cpu && cpu.summary.count ? cpu.summary.avg : null;
    const idle = cpuAvg != null && cpuAvg < 1;
    if (cpuAvg != null) {
      lines.push(
        idle
          ? "Процессор почти не нагружен — машина, скорее всего, простаивает. За простой платят так же, как за работу: останови её (ycCompute: stop)."
          : "Процессор нагружен — машина работает."
      );
    }

    return {
      instance: inst,
      minutes,
      from: from.toISOString(),
      to: to.toISOString(),
      metrics: out,
      errors,
      idle,
      lines,
      message:
        "Метрики машины «" + inst.name + "» за последние " + minutes + " мин." +
        (errors.length ? " Часть метрик недоступна: " + errors.map((e) => e.name).join(", ") + "." : ""),
    };
  }

  // ── Карточка ──────────────────────────────────────────────────────────────
  // Одна машина человеческими словами: чем занята, где, чем отвечает и сколько
  // стоит. Ровно то, что должно быть видно, не заходя в чужую консоль.

  function cardLines(inst, ctx) {
    const c = ctx || {};
    const i = inst && inst.id ? inst : instanceInfo(inst);
    const out = [];
    out.push(i.name + " — " + i.statusHuman + (i.zoneId ? ", зона " + i.zoneId : ""));
    out.push("  ядра: " + i.cores + (i.coreFraction && i.coreFraction !== 100 ? " × " + i.coreFraction + "% (гарантированно " + i.guaranteedVcpu + ")" : "") + ", память " + i.memoryHuman);
    if (i.preemptible) out.push("  прерываемая: облако может остановить её в любой момент — годится только для тестов");
    out.push("  адреса: " + (i.internalIp || "—") + " внутри" + (i.externalIp ? ", " + i.externalIp + " — снаружи" : " (снаружи недоступна)"));
    if (i.fqdn) out.push("  имя в сети: " + i.fqdn);
    out.push("  создана: " + (i.createdAt || "—") + " (возраст " + i.uptime + ")");
    if (c.subnets && c.subnets.length) {
      const names = i.subnetIds.map((id) => (c.subnets.find((s) => s.id === id) || {}).name || id);
      out.push("  подсеть: " + names.join(", "));
    }
    if (c.securityGroups && (i.securityGroupIds || []).length) {
      const names = i.securityGroupIds.map((id) => (c.securityGroups.find((g) => g.id === id) || {}).name || id);
      out.push("  группы безопасности: " + names.join(", "));
    }
    const boot = c.disks ? c.disks.find((d) => d.id === i.bootDisk.diskId) : null;
    out.push("  загрузочный диск: " + (boot ? boot.name + " " + boot.sizeHuman + " (" + boot.typeId + ")" : i.bootDisk.diskId || "—"));
    if (i.secondaryDisks.length) {
      const sec = i.secondaryDisks.map((d) => {
        const full = c.disks ? c.disks.find((x) => x.id === d.diskId) : null;
        return (full ? full.name + " " + full.sizeHuman : d.diskId) + (d.autoDelete ? "" : " (останется после удаления)");
      });
      out.push("  диски: " + sec.join(", "));
    }
    const snaps = c.snapshots ? c.snapshots.filter((s) => s.sourceDiskId === i.bootDisk.diskId) : [];
    out.push(
      "  снимки: " +
        (snaps.length ? snaps.length + " (последний " + (snaps[0].ageDays != null ? snaps[0].ageDays + " дн. назад" : snaps[0].createdAt) + ")" : "нет — восстановить будет не из чего")
    );
    if (i.running) {
      out.push("  деньги: платит за каждый час работы. Останови, когда не нужна — за диски платят всё равно.");
    } else if (String(i.status).toUpperCase() === "STOPPED") {
      out.push("  деньги: сама машина не тарифицируется, но её диски и статический адрес — да.");
    }
    return out;
  }

  return {
    // чтение
    instances,
    instance,
    disks,
    snapshots,
    zones,
    diskTypes,
    imageByFamily,
    findInstance,
    findDisk,
    findSnapshot,
    paidLeftovers,
    // питание и жизнь
    start: (t, ref, o) => power(t, "start", ref, o),
    stop: (t, ref, o) => power(t, "stop", ref, o),
    restart: (t, ref, o) => power(t, "restart", ref, o),
    power,
    serialOutput,
    metrics,
    // создание и удаление
    createInstance,
    deleteInstance,
    // снимки
    createSnapshot,
    deleteSnapshot,
    cleanSnapshots,
    restoreDisk,
    // карточка
    cardLines,
    // Готовые наборы и чистые помощники наружу: их читают инструмент агента
    // (action presets) и канал панели yc:compute — как у сети (yc-vpc.js),
    // значения рядом с методами. Без этого сборка возвращала бы модуль без
    // PRESETS, и action presets падал бы на чтении coreFraction у undefined.
    PRESETS,
    PRESET_KEYS,
    ZONE_DEFAULT,
    PLATFORM_DEFAULT,
    IMAGE_FAMILY_DEFAULT,
    DISK_TYPE_DEFAULT,
    ALLOWED_CORES,
    ALLOWED_FRACTIONS,
    METRIC_NAMES,
    checkName,
    sshUserForImage,
    looksLikePublicKey,
    generateSshKeyPair,
  };
}

module.exports = {
  createYcCompute,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  bytesFromHuman,
  humanBytes,
  humanSpeed,
  humanUptime,
  statusHuman,
  isBusy,
  isRunning,
  parseCores,
  parseFraction,
  checkName,
  instanceInfo,
  diskInfo,
  snapshotInfo,
  zoneInfo,
  imageInfo,
  sshUserForImage,
  looksLikePublicKey,
  generateSshKeyPair,
  sshPublicLine,
  sshFingerprint,
  PRESETS,
  PRESET_KEYS,
  ZONE_DEFAULT,
  PLATFORM_DEFAULT,
  IMAGE_FAMILY_DEFAULT,
  DISK_TYPE_DEFAULT,
  ALLOWED_CORES,
  ALLOWED_FRACTIONS,
  METRIC_NAMES,
};

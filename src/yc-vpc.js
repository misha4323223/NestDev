"use strict";

/* ── VPC: подсети, группы безопасности и статические адреса ───────────────────
   Зачем модуль. Сеть в каталоге приложение умело СОЗДАТЬ (ycCreate service
   "vpc"), но всё, ради чего сеть существует, было недоступно: подсеть, группа
   безопасности и статический адрес делались только в консоли облака. Без
   подсети не встанет ни одна виртуальная машина (она живёт в зоне и требует
   диапазон адресов), без группы безопасности машина окажется открыта всему
   интернету, а без статического адреса её публичный IP поменяется после первой
   же перезагрузки — и все ссылки, DNS и белые списки поедут.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcDb и createYcService): тот же
   IAM-токен, адрес сервиса, разбор сетевых отказов и ожидание операции, что у
   остальных запросов облака. Поэтому он проверяется в plain-node.

   Что важно знать про API и не потерять при правке:

     • подсеть создаётся В КОНКРЕТНОЙ ЗОНЕ с непустым диапазоном — «просто
       подсеть» создать нельзя, и подсказка диапазона живёт здесь (suggestCidr);
     • группа безопасности — это СПИСОК ПРАВИЛ, а API заменяет список целиком
       (Update с updateMask). Значит «добавить правило» = прочитать группу →
       собрать новый список → записать. Предопределённые правила группы (они
       приходят с predefinedTarget) переносятся БЕЗ изменений;
     • поле id у правила — вычисляемое: обратно при записи его отдавать нельзя,
       и наружу из чтения оно не уходит (см. writableRule);
     • направление в API — ingress/egress, в человеческих словах — вход/выход.
       Перевод живёт только здесь (normalizeDirection);
     • у ICMP и «any» диапазона портов нет вовсе: если его передать, сервис
       отказывает. Поэтому порты молча отбрасываются для этих протоколов;
     • статический адрес платный, и платный ОСОБЕННО когда он ни к чему не
       привязан: поле used в ответе показывает, занят адрес или простаивает.

   Ничего не пишется и не удаляется по своей инициативе: функции делают ровно
   то, о чём их попросили, и возвращают данные. Права проверяет вызывающий. */

// Фолбэк адреса: обычно его отдаёт каталог эндпоинтов облака, но подсеть нужно
// уметь создать и тогда, когда каталог недоступен (та же схема, что в KNOWN_ENDPOINTS).
const VPC_FALLBACK = "https://vpc.api.cloud.yandex.net";

// Протоколы, которые принимает API правил. «any» — без диапазона портов.
const PROTOCOLS = ["tcp", "udp", "icmp", "ipv6_icmp", "any"];
const PORTLESS = ["icmp", "ipv6_icmp", "any"];

// ── Проверки ввода ──────────────────────────────────────────────────────────
// Имя в Yandex Cloud: строчные латинские буквы, цифры и дефис, 2–63 символа.
// Проверяем до запроса: сервис на «My_Subnet» отвечает невнятно, а агент потом
// ищет причину в правах.
const NAME_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя: строчные латинские буквы, цифры и дефис (например app-subnet-a).");
  if (NAME_RE.test(nm)) return nm;
  const lower = nm.toLowerCase();
  if (NAME_RE.test(lower)) {
    throw new Error("Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис. Возьми «" + lower + "».");
  }
  throw new Error(
    "Имя «" + nm + "» не подойдёт: нужно 2–63 символа, только строчные латинские буквы, цифры и дефис, " +
      "начинается с буквы и не заканчивается дефисом."
  );
}

function checkFolder(folderId) {
  const f = String(folderId || "").trim();
  if (!f) throw new Error("Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.");
  return f;
}

function isCidr4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(s || "").trim());
  if (!m) return false;
  for (let i = 1; i <= 4; i++) if (Number(m[i]) > 255) return false;
  return Number(m[5]) <= 32;
}

function isCidr6(s) {
  const v = String(s || "").trim();
  return v.indexOf(":") >= 0 && /^[0-9a-f:]+\/\d{1,3}$/i.test(v);
}

function checkCidr(v, what) {
  const list = (Array.isArray(v) ? v : [v])
    .map((x) => String(x == null ? "" : x).trim())
    .filter(Boolean);
  if (!list.length) throw new Error(what + ": укажи диапазон адресов, например 10.10.0.0/24.");
  for (const c of list) {
    if (!isCidr4(c) && !isCidr6(c)) {
      throw new Error(what + ": «" + c + "» не похоже на диапазон. Нужен вид 10.10.0.0/24 (IPv4) или fd00::/64 (IPv6).");
    }
  }
  return list;
}

// ── Правила групп безопасности ──────────────────────────────────────────────

function normalizeDirection(v) {
  const d = String(v == null ? "" : v).trim().toLowerCase();
  if (!d) return "ingress";
  if (d === "ingress" || d === "in" || d === "вход" || d === "входящее" || d === "входящий") return "ingress";
  if (d === "egress" || d === "out" || d === "выход" || d === "исходящее" || d === "исходящий") return "egress";
  throw new Error("Направление «" + v + "» не понял. Доступно: ingress (вход) или egress (выход).");
}

// Диапазон портов в любом из привычных видов: 22, "22", "8000-8010",
// { from, to }, { fromPort, toPort }, [from, to]. Возвращает null или
// { fromPort, toPort } — в том виде, в каком его ждёт API.
function parsePorts(v) {
  if (v == null || v === "") return null;
  let from = null;
  let to = null;
  if (typeof v === "number") {
    from = v;
    to = v;
  } else if (typeof v === "string") {
    const s = v.trim();
    const m = /^(\d{1,5})\s*[-–—:]\s*(\d{1,5})$/.exec(s);
    if (m) {
      from = Number(m[1]);
      to = Number(m[2]);
    } else if (/^\d{1,5}$/.test(s)) {
      from = Number(s);
      to = Number(s);
    } else {
      throw new Error("Порты «" + v + "» не понял. Укажи число (22) или диапазон (8000-8010).");
    }
  } else if (Array.isArray(v)) {
    from = Number(v[0]);
    to = v.length > 1 ? Number(v[1]) : from;
  } else if (typeof v === "object") {
    from = Number(v.fromPort != null ? v.fromPort : v.from);
    to = Number(v.toPort != null ? v.toPort : v.to != null ? v.to : from);
  } else {
    throw new Error("Порты указаны непонятно: " + JSON.stringify(v));
  }
  if (!isFinite(from) || !isFinite(to)) throw new Error("Порты должны быть числами от 0 до 65535.");
  if (from < 0 || from > 65535 || to < 0 || to > 65535) throw new Error("Порты вне диапазона 0–65535.");
  if (from > to) {
    const t = from;
    from = to;
    to = t;
  }
  return { fromPort: from, toPort: to };
}

function cidrList(o) {
  const src = o.cidrBlocks != null ? o.cidrBlocks : o.cidr != null ? o.cidr : o.source;
  if (src && typeof src === "object" && !Array.isArray(src)) {
    return [].concat(src.v4CidrBlocks || [], src.v6CidrBlocks || []).map(String);
  }
  return Array.isArray(src) ? src.map(String) : src == null ? [] : [String(src)];
}

// Человеческий ввод → правило в том виде, в каком его ждёт API.
// Ошибки — до запроса и с указанием, что именно поправить.
function normalizeRule(input) {
  const o = input || {};
  const direction = normalizeDirection(o.direction != null ? o.direction : o.dir);
  const protocolRaw = String(o.protocol != null ? o.protocol : o.proto != null ? o.proto : "tcp").trim().toLowerCase();
  const protocol = PROTOCOLS.indexOf(protocolRaw) >= 0 ? protocolRaw : null;
  if (!protocol) {
    throw new Error("Протокол «" + protocolRaw + "» не понял. Доступно: " + PROTOCOLS.join(", ") + ".");
  }

  const spec = { direction, protocolName: protocol };
  const description = String(o.description || "").trim();
  if (description) spec.description = description;

  // Диапазон портов: только у tcp/udp. У ICMP и any его в API нет — иначе отказ.
  if (PORTLESS.indexOf(protocol) < 0) {
    const ports = parsePorts(o.port != null ? o.port : o.ports != null ? o.ports : o.portRange);
    if (ports) spec.portRange = ports;
  }

  const cidrs = cidrList(o).map((c) => c.trim()).filter(Boolean);
  for (const c of cidrs) {
    if (!isCidr4(c) && !isCidr6(c)) {
      throw new Error("Адрес «" + c + "» не понял: нужен вид 0.0.0.0/0, 203.0.113.10/32 или fd00::/64.");
    }
  }
  const sgId = String(o.securityGroupId != null ? o.securityGroupId : o.sg != null ? o.sg : o.fromGroup || "").trim();
  const target = String(o.target || o.predefinedTarget || "").trim().toLowerCase();

  if (sgId) spec.securityGroupId = sgId;
  if (target) {
    if (["self", "all"].indexOf(target) < 0) throw new Error("Цель правила «" + target + "» не понял. Доступно: self или all.");
    spec.predefinedTarget = target;
  }
  if (cidrs.length) {
    spec.cidrBlocks = {
      v4CidrBlocks: cidrs.filter(isCidr4),
      v6CidrBlocks: cidrs.filter((c) => !isCidr4(c)),
    };
  }

  const hasSource = !!sgId || cidrs.length > 0 || !!target;
  if (!hasSource) {
    if (direction === "ingress") {
      throw new Error(
        "У правила входа должен быть источник: cidr (например 203.0.113.10/32 или 0.0.0.0/0) либо sg (группа-источник). " +
          "Открывать вход «отовсюду по умолчанию» приложение не станет — это и есть открытая дверь."
      );
    }
    // Для выхода отсутствие диапазона — обычное дело: весь интернет.
    spec.cidrBlocks = { v4CidrBlocks: ["0.0.0.0/0"], v6CidrBlocks: [] };
  }
  return spec;
}

// Только те поля правила, которые сервис принимает на запись. id правила он
// считает сам: вернуть его обратно — ошибка обновления.
function writableRule(spec) {
  const s = spec || {};
  const out = { direction: normalizeDirection(s.direction), protocolName: String(s.protocolName || "any") };
  if (s.description) out.description = String(s.description);
  if (s.portRange && (s.portRange.fromPort != null || s.portRange.toPort != null)) {
    out.portRange = { fromPort: Number(s.portRange.fromPort) || 0, toPort: Number(s.portRange.toPort) || 0 };
  }
  if (s.cidrBlocks) {
    out.cidrBlocks = {
      v4CidrBlocks: (s.cidrBlocks.v4CidrBlocks || []).map(String),
      v6CidrBlocks: (s.cidrBlocks.v6CidrBlocks || []).map(String),
    };
  }
  if (s.securityGroupId) out.securityGroupId = String(s.securityGroupId);
  if (s.predefinedTarget) out.predefinedTarget = String(s.predefinedTarget);
  return out;
}

// Ключ правила — по нему сравниваем «то же правило или другое». Порт, адрес,
// группа-источник и цель входят в ключ: правило «22 с 10.0.0.1/32» и правило
// «22 с 0.0.0.0/0» — разные, и второе не должно считаться уже существующим.
function ruleKey(spec) {
  const s = writableRule(spec);
  const ports = s.portRange ? s.portRange.fromPort + "-" + s.portRange.toPort : "";
  const v4 = (s.cidrBlocks && s.cidrBlocks.v4CidrBlocks ? s.cidrBlocks.v4CidrBlocks : []).join(",");
  const v6 = (s.cidrBlocks && s.cidrBlocks.v6CidrBlocks ? s.cidrBlocks.v6CidrBlocks : []).join(",");
  return [s.direction, s.protocolName, ports, v4, v6, s.securityGroupId || "", s.predefinedTarget || ""].join("|");
}

// Правило человеческими словами — для ответа агенту и для карточки в окне.
function ruleHuman(spec) {
  const s = writableRule(spec);
  const proto = s.protocolName.toUpperCase();
  const ports = s.portRange ? " " + s.portRange.fromPort + (s.portRange.toPort === s.portRange.fromPort ? "" : "-" + s.portRange.toPort) : "";
  const cidrs = [].concat(
    (s.cidrBlocks && s.cidrBlocks.v4CidrBlocks) || [],
    (s.cidrBlocks && s.cidrBlocks.v6CidrBlocks) || []
  );
  const from = cidrs.length ? cidrs.join(", ") : s.securityGroupId ? "группа " + s.securityGroupId : s.predefinedTarget ? "цель " + s.predefinedTarget : "—";
  return (s.direction === "ingress" ? "вход" : "выход") + " " + proto + ports + " ← " + from;
}

// ── Нормализация ответов API ────────────────────────────────────────────────
// Карточке и агенту нужны стабильные имена полей, а не то, что вернул сервис.

function networkInfo(n) {
  const o = n || {};
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    defaultSecurityGroupId: o.defaultSecurityGroupId || "",
    createdAt: o.createdAt || "",
  };
}

function subnetInfo(s) {
  const o = s || {};
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    networkId: o.networkId || "",
    zoneId: o.zoneId || "",
    v4CidrBlocks: o.v4CidrBlocks || [],
    v6CidrBlocks: o.v6CidrBlocks || [],
    routeTableId: o.routeTableId || "",
    createdAt: o.createdAt || "",
  };
}

function sgInfo(s) {
  const o = s || {};
  const rules = (o.ruleSpecs || []).map(writableRule);
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    networkId: o.networkId || "",
    defaultForNetwork: !!o.defaultForNetwork,
    createdAt: o.createdAt || "",
    rules,
    ingress: rules.filter((r) => r.direction === "ingress").length,
    egress: rules.filter((r) => r.direction === "egress").length,
  };
}

function addressInfo(a) {
  const o = a || {};
  const ext = o.externalIpv4Address || {};
  const inner = o.internalIpv4Address || {};
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    address: ext.address || inner.address || "",
    zoneId: ext.zoneId || inner.zoneId || "",
    internal: !!inner.address,
    reserved: !!o.reserved,
    // used = адрес привязан к ресурсу. Простаивающий статический адрес облако
    // тарифицирует отдельно — именно поэтому поле выведено наружу.
    used: !!o.used,
    deletionProtection: !!o.deletionProtection,
    createdAt: o.createdAt || "",
  };
}

// Свободный диапазон /24 рядом с уже занятыми: агент не должен угадывать адрес
// и уж тем более брать диапазон, который в этой сети уже занят.
function suggestCidr(subnets) {
  const used = new Set();
  for (const s of subnets || []) {
    for (const c of (s && s.v4CidrBlocks) || []) {
      const m = /^10\.(\d{1,3})\./.exec(String(c));
      if (m) used.add(Number(m[1]));
    }
  }
  for (let n = 10; n < 250; n++) if (!used.has(n)) return "10." + n + ".0.0/24";
  const used192 = new Set();
  for (const s of subnets || []) {
    for (const c of (s && s.v4CidrBlocks) || []) {
      const m = /^192\.168\.(\d{1,3})\./.exec(String(c));
      if (m) used192.add(Number(m[1]));
    }
  }
  for (let n = 1; n < 250; n++) if (!used192.has(n)) return "192.168." + n + ".0/24";
  return "";
}

// Поиск по id или по имени — как в консоли. Пустая ссылка не ошибка: если в
// каталоге ровно один такой объект, берём его (удобство для агента).
function matchByIdOrName(items, ref) {
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return null;
  const list = items || [];
  return list.find((i) => i.id === q) || list.find((i) => i.name === q) || null;
}

function pickOne(items, ref) {
  const got = matchByIdOrName(items, ref);
  if (got) return got;
  if (!String(ref == null ? "" : ref).trim() && (items || []).length === 1) return items[0];
  return null;
}

function createYcVpc(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError =
    typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("VPC: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function vpcBase() {
    const b = typeof api.endpoint === "function" ? await api.endpoint("vpc") : "";
    return b || VPC_FALLBACK;
  }

  async function request(oauthToken, method, path, body, timeoutMs) {
    requireApi();
    const base = await vpcBase();
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      return await api.fetchJson(base + path, opts, timeoutMs || 30000);
    } catch (e) {
      const err = new Error(serviceError(e, base, path));
      err.status = e && e.status;
      throw err;
    }
  }

  // Ожидание операции + id созданного объекта: у части методов id приходит
  // только в response операции (та же тонкость, что у создания ресурсов).
  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 180000);
    return op || {};
  }

  async function listByFolder(oauthToken, path, key, folderId) {
    const folder = checkFolder(folderId);
    const j = await request(
      oauthToken,
      "GET",
      path + "?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    const items = Array.isArray(j && j[key]) ? j[key] : [];
    return items;
  }

  // ── Чтение ────────────────────────────────────────────────────────────────

  async function networks(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/vpc/v1/networks", "networks", folderId)).map(networkInfo);
  }

  async function subnets(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/vpc/v1/subnets", "subnets", folderId)).map(subnetInfo);
  }

  async function securityGroups(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/vpc/v1/securityGroups", "securityGroups", folderId)).map(sgInfo);
  }

  async function addresses(oauthToken, folderId) {
    return (await listByFolder(oauthToken, "/vpc/v1/addresses", "addresses", folderId)).map(addressInfo);
  }

  async function getSecurityGroup(oauthToken, id) {
    if (!id) throw new Error("Не указана группа безопасности.");
    const j = await request(oauthToken, "GET", "/vpc/v1/securityGroups/" + encodeURIComponent(id), undefined, 25000);
    return sgInfo(j);
  }

  async function getAddress(oauthToken, id) {
    if (!id) throw new Error("Не указан адрес.");
    const j = await request(oauthToken, "GET", "/vpc/v1/addresses/" + encodeURIComponent(id), undefined, 25000);
    return addressInfo(j);
  }

  async function findNetwork(oauthToken, folderId, ref) {
    return matchByIdOrName(await networks(oauthToken, folderId), ref);
  }

  async function findSubnet(oauthToken, folderId, ref) {
    return pickOne(await subnets(oauthToken, folderId), ref);
  }

  async function findSecurityGroup(oauthToken, folderId, ref) {
    return pickOne(await securityGroups(oauthToken, folderId), ref);
  }

  async function findAddress(oauthToken, folderId, ref) {
    return pickOne(await addresses(oauthToken, folderId), ref);
  }

  // ── Подсеть ───────────────────────────────────────────────────────────────

  async function createSubnet(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    const zoneId = String(opt.zoneId || opt.zone || "").trim();
    if (!zoneId) throw new Error("Укажи зону подсети (zoneId), например ru-central1-a: подсеть живёт в одной зоне.");
    let networkId = String(opt.networkId || "").trim();
    if (!networkId) {
      const net = await findNetwork(oauthToken, folderId, opt.network);
      if (!net) {
        throw new Error(
          "Не нашёл сеть" + (opt.network ? " «" + opt.network + "»" : "") + ". Укажи network (имя или id) — список сетей видно в дашборде, создать сеть: ycCreate service vpc."
        );
      }
      networkId = net.id;
    }
    const cidr = checkCidr(opt.cidr != null ? opt.cidr : opt.v4CidrBlocks, "Диапазон подсети");
    const body = {
      folderId,
      networkId,
      name,
      zoneId,
      v4CidrBlocks: cidr.filter(isCidr4),
    };
    if (cidr.some((c) => !isCidr4(c))) body.v6CidrBlocks = cidr.filter((c) => !isCidr4(c));
    if (opt.description) body.description = String(opt.description);
    if (opt.routeTableId) body.routeTableId = String(opt.routeTableId);

    const j = await request(oauthToken, "POST", "/vpc/v1/subnets", body, 30000);
    const op = await run(oauthToken, j, 180000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? (await subnets(oauthToken, folderId)).find((s) => s.id === id) : null;
    return made || { id, name, networkId, zoneId, v4CidrBlocks: cidr, description: "", routeTableId: "" };
  }

  async function deleteSubnet(oauthToken, subnetId) {
    const id = String(subnetId || "").trim();
    if (!id) throw new Error("Не указан id подсети.");
    const j = await request(oauthToken, "DELETE", "/vpc/v1/subnets/" + encodeURIComponent(id), undefined, 30000);
    await run(oauthToken, j, 180000);
    // Проверяем, что подсеть действительно ушла: «запрос отправлен» — не результат.
    const left = await request(oauthToken, "GET", "/vpc/v1/subnets/" + encodeURIComponent(id), undefined, 20000).catch(() => null);
    if (left) throw new Error("Подсеть не удалилась: она ещё существует. Проверь права (vpc.admin) в каталоге.");
    return { id, deleted: true };
  }

  // ── Группа безопасности ───────────────────────────────────────────────────

  async function createSecurityGroup(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    let networkId = String(opt.networkId || "").trim();
    if (!networkId) {
      const net = await findNetwork(oauthToken, folderId, opt.network);
      if (!net) {
        throw new Error("Не нашёл сеть для группы безопасности. Укажи network (имя или id).");
      }
      networkId = net.id;
    }
    const body = { folderId, networkId, name };
    if (opt.description) body.description = String(opt.description);
    const rules = Array.isArray(opt.rules) ? opt.rules : [];
    if (rules.length) body.ruleSpecs = rules.map(normalizeRule);

    const j = await request(oauthToken, "POST", "/vpc/v1/securityGroups", body, 30000);
    const op = await run(oauthToken, j, 180000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? await getSecurityGroup(oauthToken, id).catch(() => null) : null;
    return made || { id, name, networkId, rules: rules.map(writableRule), ingress: 0, egress: 0, defaultForNetwork: false };
  }

  async function deleteSecurityGroup(oauthToken, sgId) {
    const id = String(sgId || "").trim();
    if (!id) throw new Error("Не указан id группы безопасности.");
    const j = await request(oauthToken, "DELETE", "/vpc/v1/securityGroups/" + encodeURIComponent(id), undefined, 30000);
    await run(oauthToken, j, 180000);
    const left = await request(oauthToken, "GET", "/vpc/v1/securityGroups/" + encodeURIComponent(id), undefined, 20000).catch(() => null);
    if (left) throw new Error("Группа не удалилась: она ещё существует. Проверь права (vpc.admin) в каталоге.");
    return { id, deleted: true };
  }

  // Правка правил: API принимает СПИСОК ЦЕЛИКОМ, поэтому читаем группу, считаем
  // новый список и записываем его. После записи перечитываем группу и сверяем —
  // иначе «правило добавлено» осталось бы обещанием (та же школа, что у
  // публичного доступа к бакету).
  async function updateSecurityGroupRules(oauthToken, o) {
    const opt = o || {};
    const sgId = String(opt.sgId || opt.securityGroupId || opt.id || "").trim();
    if (!sgId) throw new Error("Не указана группа безопасности (sgId).");
    const add = (Array.isArray(opt.add) ? opt.add : opt.add ? [opt.add] : []).map(normalizeRule);
    const remove = (Array.isArray(opt.remove) ? opt.remove : opt.remove ? [opt.remove] : []).map(normalizeRule);
    if (!add.length && !remove.length) throw new Error("Нечего менять: передай add (что добавить) или remove (что убрать).");

    const before = await getSecurityGroup(oauthToken, sgId);
    const current = (before.rules || []).map(writableRule);

    // Сначала проверяем, что удаляемое вообще есть: иначе часть правил успела бы
    // измениться, а часть — нет, и группа осталась бы в половинчатом виде.
    const removeKeys = remove.map(ruleKey);
    const notFound = [];
    for (let i = 0; i < removeKeys.length; i++) {
      if (!current.some((r) => ruleKey(r) === removeKeys[i])) notFound.push(ruleHuman(remove[i]));
    }
    if (notFound.length) {
      const have = current.length ? current.map((r) => "• " + ruleHuman(r)).join("\n") : "• (правил нет)";
      throw new Error(
        "В группе «" + (before.name || before.id) + "» нет такого правила:\n" + notFound.map((x) => "• " + x).join("\n") + "\nЧто есть сейчас:\n" + have
      );
    }

    const kept = [];
    const removed = [];
    for (const r of current) {
      if (removeKeys.indexOf(ruleKey(r)) >= 0) removed.push(r);
      else kept.push(r);
    }
    const added = [];
    const skipped = [];
    for (const r of add) {
      if (kept.concat(added).some((x) => ruleKey(x) === ruleKey(r))) skipped.push(r);
      else added.push(r);
    }
    if (!added.length && !removed.length) {
      return { changed: false, group: before, rules: before.rules, added: [], removed: [], skipped };
    }

    const next = kept.concat(added);
    const j = await request(
      oauthToken,
      "PUT",
      "/vpc/v1/securityGroups/" + encodeURIComponent(before.id),
      { securityGroupId: before.id, updateMask: "rule_specs", ruleSpecs: next },
      30000
    );
    await run(oauthToken, j, 180000);

    const after = await getSecurityGroup(oauthToken, before.id);
    const afterKeys = (after.rules || []).map(ruleKey);
    for (const r of added) {
      if (afterKeys.indexOf(ruleKey(r)) < 0) {
        throw new Error(
          "Правило не появилось в группе «" + (before.name || before.id) + "»: " + ruleHuman(r) +
            ". Проверь права на изменение групп безопасности (vpc.admin или vpc.securityAdmin)."
        );
      }
    }
    for (const r of removed) {
      if (afterKeys.indexOf(ruleKey(r)) >= 0) {
        throw new Error("Правило не удалилось из группы «" + (before.name || before.id) + "»: " + ruleHuman(r) + ".");
      }
    }
    return { changed: true, group: after, rules: after.rules, added, removed, skipped };
  }

  // ── Статический адрес ─────────────────────────────────────────────────────

  async function reserveAddress(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    const zoneId = String(opt.zoneId || opt.zone || "").trim();
    if (!zoneId) throw new Error("Укажи зону адреса (zoneId), например ru-central1-a: внешний адрес выдаётся в конкретной зоне.");
    const ext = { zoneId };
    if (opt.address) {
      const addr = String(opt.address).trim();
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(addr)) throw new Error("Адрес «" + opt.address + "» не понял: нужен вид 203.0.113.10.");
      ext.address = addr;
    }
    const body = { folderId, name, externalIpv4Address: ext };
    if (opt.description) body.description = String(opt.description);
    if (opt.deletionProtection) body.deletionProtection = true;

    const j = await request(oauthToken, "POST", "/vpc/v1/addresses", body, 30000);
    const op = await run(oauthToken, j, 180000);
    const id = (op.response && op.response.id) || (j && j.id) || "";
    const made = id ? await getAddress(oauthToken, id).catch(() => null) : null;
    return made || { id, name, address: "", zoneId, reserved: true, used: false, deletionProtection: !!opt.deletionProtection };
  }

  async function releaseAddress(oauthToken, addressId) {
    const id = String(addressId || "").trim();
    if (!id) throw new Error("Не указан id адреса.");
    const j = await request(oauthToken, "DELETE", "/vpc/v1/addresses/" + encodeURIComponent(id), undefined, 30000);
    await run(oauthToken, j, 180000);
    const left = await request(oauthToken, "GET", "/vpc/v1/addresses/" + encodeURIComponent(id), undefined, 20000).catch(() => null);
    if (left) throw new Error("Адрес не освободился: он ещё закреплён за каталогом. Сними защиту от удаления или отвяжи его от ресурса.");
    return { id, released: true };
  }

  return {
    networks,
    subnets,
    securityGroups,
    addresses,
    getSecurityGroup,
    getAddress,
    findNetwork,
    findSubnet,
    findSecurityGroup,
    findAddress,
    createSubnet,
    deleteSubnet,
    createSecurityGroup,
    deleteSecurityGroup,
    updateSecurityGroupRules,
    reserveAddress,
    releaseAddress,
    // Поиск по id или имени — им пользуются и инструмент агента, и канал панели.
    matchByIdOrName,
    pickOne,
    suggestCidr,
    normalizeRule,
    ruleKey,
    ruleHuman,
    writableRule,
    normalizeDirection,
    checkName,
    checkCidr,
    isCidr4,
    isCidr6,
  };
}

module.exports = {
  createYcVpc,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  normalizeRule,
  writableRule,
  ruleKey,
  ruleHuman,
  normalizeDirection,
  parsePorts,
  suggestCidr,
  matchByIdOrName,
  checkName,
  checkCidr,
  isCidr4,
  isCidr6,
  subnetInfo,
  sgInfo,
  addressInfo,
  networkInfo,
};

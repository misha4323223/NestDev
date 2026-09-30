"use strict";

/* ── Application Load Balancer Yandex Cloud: HTTPS-вход в приложение ─────────
   Зачем модуль. Машины, группы машин и базы у приложения есть, а ВХОДА в них с
   улицы — нет: без балансировщика сайт живёт на одном адресе одной машины, а
   сертификат (yc-cdn.js умеет его выпустить) некуда повесить. Application Load
   Balancer — это четыре связанных ресурса, и путать их нельзя:

     • ГРУППА БЭКЕНДОВ (backendGroups) — куда ведут маршруты: набор из групп
       целей с проверками здоровья. В этой части только ЧИТАЕТСЯ (список), чтобы
       роутер не ссылался на выдуманный id: создание групп бэкендов — отдельный
       заход с настройками проверок;
     • ГРУППА ЦЕЛЕЙ (targetGroups) — САМ СПИСОК МАШИН: адрес (ipAddress) и
       подсеть (subnetId). Цели добавляются и убираются отдельными операциями
       (`addTargets`/`removeTargets`) — «изменить состав» здесь отсутствует;
     • HTTP-РОУТЕР (httpRouters) — правила: хост (authority) и путь
       (prefixMatch/exactMatch) → группа бэкендов. Роутер не знает про машины;
     • БАЛАНСИРОВЩИК (loadBalancers) — адреса, зоны и СЛУШАТЕЛИ (listenerSpecs):
       HTTP на порт, HTTPS с сертификатом, или поток TCP. Слушатель ссылается
       ЛИБО на роутер (HTTP/HTTPS), ЛИБО на группу бэкендов (поток).

   Формы сверены с официальным справочником (обновлён 09.07.2026), а не взяты по
   памяти. Хост — alb.api.cloud.yandex.net, пути — /apploadbalancer/v1/:

     GET    /loadBalancers?folderId=…                   список
     GET    /loadBalancers/{id}                         карточка
     POST   /loadBalancers                              создание
     POST   /loadBalancers/{id}:start | :stop           питание
     DELETE /loadBalancers/{id}                         удаление
     GET    /targetGroups?folderId=…                    группы целей
     POST   /targetGroups                               создание
     POST   /targetGroups/{id}:addTargets | :removeTargets   состав целей
     DELETE /targetGroups/{id}
     GET    /httpRouters?folderId=…                     роутеры
     POST   /httpRouters                                создание
     DELETE /httpRouters/{id}
     GET    /backendGroups?folderId=…                   группы бэкендов (список)
     GET    /backendGroups/{id}                         группа бэкендов (за ней — её группы целей)

   ЗДОРОВЬЕ ЦЕЛЕЙ в ответах балансировщика и группы целей НЕ приходит: его отдаёт
   только LoadBalancer.GetTargetStates, и спрашивать его надо связкой «группа
   бэкендов + группа целей». Это вернётся вместе с созданием групп бэкендов (там
   же живут проверки здоровья) — пока карточка показывает адреса целей, а не их
   состояние. У балансировщика НЕТ и защиты от удаления: такого поля в справочнике
   нет вовсе.

   Что важно и не потерять при правке:

     • АДРЕСА. У балансировщика нет «одного адреса»: адрес задаётся у КАЖДОГО
       слушателя (endpointSpecs[].addressSpecs[].externalIpv4AddressSpec), а он
       стоит в зонах, перечисленных в allocationPolicy.locations — каждой зоне
       нужна СВОЯ подсеть. Пока адрес не задан, облако выдаёт его при создании;
       поэтому «адрес балансировщика» — это список адресов его слушателей.
     • СЛУШАТЕЛЬ РОВНО ОДНОГО ВИДА: stream, http или tls (одно из трёх). HTTP —
       это http.handler.httpRouterId; HTTPS — tls.defaultHandler с httpHandler и
       certificateIds. Смешивать HTTP и TCP в одном TLS-слушателе нельзя.
     • РОУТЕР БЕЗ ГРУППЫ БЭКЕНДОВ НЕ ИМЕЕТ СМЫСЛА: маршрут ведёт в
       backendGroupId. Модуль проверяет группу бэкендов ДО запроса — иначе
       человек получил бы роутер, который ничего не отдаёт.
     • ГРУППА ЦЕЛЕЙ ЗНАЕТ ТОЛЬКО АДРЕС И ПОДСЕТЬ. Ни порта, ни пути, ни
       протокола здесь нет: порт говорит группа бэкендов, путь — роутер.
     • БАЛАНСИРОВЩИК ПЛАТНЫЙ и тарифицируется за час (ресурсные единицы плюс
       сам ресурс), поэтому создание требует согласия и называет, что будет
       создано; удаление необратимо и забирает слушатели вместе с адресами.
     • ЗАНЯТЫЙ балансировщик (CREATING/STARTING/STOPPING/DELETING) отбивает
       питание и удаление ДО сети.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcIg и createYcCompute), поэтому он
   проверяется в plain-node на подставных ответах сервиса. */

const ALB_HOST = "https://alb.api.cloud.yandex.net";
const ALB_BASE = "/apploadbalancer/v1";

const PORT_DEFAULT = 80;
const LISTENER_NAME_DEFAULT = "web";
const ROUTE_NAME_DEFAULT = "main";
const PATH_PREFIX_DEFAULT = "/";

// Состояния балансировщика — из перечисления Status справочника API.
const STATUS_RU = {
  CREATING: "создаётся",
  STARTING: "запускается",
  ACTIVE: "работает",
  STOPPING: "останавливается",
  STOPPED: "остановлен",
  DELETING: "удаляется",
};

// Состояния цели — перечисление Status метода LoadBalancer.GetTargetStates
// (в самом ресурсе группы целей здоровья нет).
const TARGET_STATUS_RU = {
  HEALTHY: "здорова",
  PARTIALLY_HEALTHY: "здорова частично (часть проверок не прошла)",
  UNHEALTHY: "не отвечает",
  DRAINING: "выводится из работы",
  TIMEOUT: "проверка не успела ответить",
};

const NAME_RE = /^[a-z][-a-z0-9_]{0,61}[a-z0-9]$/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function one(v) {
  return String(v == null ? "" : v).trim();
}

function checkName(name, what) {
  const n = one(name);
  if (!n) throw new Error("Не указано имя " + (what || "ресурса") + ".");
  if (!NAME_RE.test(n)) {
    throw new Error(
      "Имя «" + n + "» облако не примет: строчные латинские буквы, цифры, дефис и подчёркивание, начинается с буквы, длина 1–63."
    );
  }
  return n;
}

function checkFolder(folderId) {
  const f = one(folderId);
  if (!f) throw new Error("Не выбран каталог (folderId) — балансировщик и его группы целей живут в каталоге.");
  return f;
}

function checkPort(v) {
  const p = Number(v != null && v !== "" ? v : PORT_DEFAULT);
  if (!isFinite(p) || p < 1 || p > 65535) {
    throw new Error("Порт слушателя — целое от 1 до 65535 (дано: " + v + ").");
  }
  return Math.round(p);
}

function checkIpList(list) {
  const ips = [].concat(list || []).map(one).filter(Boolean);
  if (!ips.length) throw new Error("Нужен хотя бы один адрес цели (ipAddress) — состав группы целей меняется адресами.");
  const bad = ips.filter((ip) => !IPV4_RE.test(ip));
  if (bad.length) throw new Error("Это не похоже на адреса: " + bad.join(", ") + ". Цель задаётся адресом IPv4, например 10.10.0.5.");
  return ips;
}

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
  return STATUS_RU[one(status).toUpperCase()] || one(status);
}

function targetStatusHuman(status) {
  return TARGET_STATUS_RU[one(status).toUpperCase()] || one(status);
}

function isActive(status) {
  return one(status).toUpperCase() === "ACTIVE";
}

// «Занят» — идёт переход: питание и удаление в это время облако отклонит.
function isBusy(status) {
  const s = one(status).toUpperCase();
  return s === "CREATING" || s === "STARTING" || s === "STOPPING" || s === "DELETING";
}

// Слушатель: имя, адреса, порты и ЧЕМ он занят — роутером (HTTP/HTTPS) или
// группой бэкендов (поток TCP). Без этого карточка не объяснит, куда ведёт вход.
function listenerInfo(l) {
  const o = l || {};
  const kind = o.stream ? "stream" : o.tls ? "tls" : o.http ? "http" : "";
  const handler =
    (o.stream && o.stream.handler) ||
    (o.http && o.http.handler) ||
    (o.tls && o.tls.defaultHandler && (o.tls.defaultHandler.httpHandler || o.tls.defaultHandler.streamHandler)) ||
    {};
  const certs = (o.tls && o.tls.defaultHandler && o.tls.defaultHandler.certificateIds) || [];
  const sni = (o.tls && o.tls.sniHandlers) || [];
  // Ответ облака отличается от запроса именами: в запросе — endpointSpecs и
  // addressSpecs с ...AddressSpec, в ответе — endpoints и addresses с
  // ...Address. Читаем ответ, а форму запроса принимаем как запасную.
  const endpoints = (o.endpoints || o.endpointSpecs || []).map((e) => {
    const addresses = ((e.addresses || e.addressSpecs || [])[0] || {});
    const ext = addresses.externalIpv4Address || addresses.externalIpv4AddressSpec || addresses.externalIpv6Address || addresses.externalIpv6AddressSpec || {};
    const inner = addresses.internalIpv4Address || addresses.internalIpv4AddressSpec || {};
    return {
      address: one(ext.address) || one(inner.address),
      internal: !!(addresses.internalIpv4Address || addresses.internalIpv4AddressSpec),
      subnetId: one(inner.subnetId),
      ports: (e.ports || []).map(one),
    };
  });
  return {
    name: one(o.name),
    kind: kind,
    kindHuman: kind === "http" ? "HTTP" : kind === "tls" ? "HTTPS/TLS" : kind === "stream" ? "поток TCP" : "вид не назван",
    routerId: one(handler.httpRouterId),
    backendGroupId: one(handler.backendGroupId),
    certificateIds: certs.map(one),
    sniNames: sni.map((h) => one(h && h.name)),
    httpToHttps: !!(o.http && o.http.redirects && o.http.redirects.httpToHttps),
    endpoints: endpoints,
    ports: endpoints.reduce((acc, e) => acc.concat(e.ports), []),
    addresses: endpoints.map((e) => e.address).filter(Boolean),
  };
}

function lbInfo(lb) {
  const o = lb || {};
  const locations = ((o.allocationPolicy && o.allocationPolicy.locations) || []).map((z) => ({
    zoneId: one(z && z.zoneId),
    subnetId: one(z && z.subnetId),
    disabled: !!(z && z.disableTraffic),
  }));
  const listeners = (o.listenerSpecs || o.listeners || []).map(listenerInfo);
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    status: one(o.status),
    statusHuman: statusHuman(o.status),
    active: isActive(o.status),
    busy: isBusy(o.status),
    networkId: one(o.networkId),
    regionId: one(o.regionId),
    securityGroupIds: (o.securityGroupIds || []).map(one),
    locations: locations,
    zones: locations.map((z) => z.zoneId).filter(Boolean),
    listeners: listeners,
    addresses: listeners.reduce((acc, l) => acc.concat(l.addresses), []),
    ports: listeners.reduce((acc, l) => acc.concat(l.ports), []),
    autoScale: o.autoScalePolicy ? { min: one(o.autoScalePolicy.minZoneSize), max: one(o.autoScalePolicy.maxSize) } : null,
    logGroupId: one(o.logOptions && o.logOptions.logGroupId),
  };
}

function tgInfo(tg) {
  const o = tg || {};
  const targets = (o.targets || []).map((t) => targetInfo(t));
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    targets: targets,
    targetCount: targets.length,
  };
}

function targetInfo(t) {
  const o = t || {};
  return {
    ipAddress: one(o.ipAddress),
    subnetId: one(o.subnetId),
    external: o.externalAddress === true,
    privateOnly: o.privateIpv4Address === true,
    health: one(o.health && o.health.status),
    healthHuman: targetStatusHuman(o.health && o.health.status),
  };
}

function routerInfo(r) {
  const o = r || {};
  const hosts = (o.virtualHosts || []).map((h) => {
    const routes = (h.routes || []).map((rt) => {
      const http = rt && rt.http;
      const path = (http && http.match && http.match.path) || {};
      const action = (http && http.route) || {};
      return {
        name: one(rt && rt.name),
        kind: http ? "http" : rt && rt.grpc ? "grpc" : "",
        pathExact: one(path.exactMatch),
        pathPrefix: one(path.prefixMatch),
        backendGroupId: one(action.backendGroupId),
        autoHostRewrite: action.autoHostRewrite === true,
      };
    });
    return { name: one(h && h.name), authority: (h && h.authority) || [], routes: routes };
  });
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    hosts: hosts,
    hostCount: hosts.length,
    routeCount: hosts.reduce((n, h) => n + h.routes.length, 0),
  };
}

// Одна строка балансировщика — на список, карточку, канал и инструмент.
function lbLine(lb) {
  const bits = [];
  bits.push((lb.active ? "● " : "○ ") + lb.name);
  bits.push(lb.statusHuman || "—");
  if (lb.listeners.length) {
    bits.push(
      lb.listeners
        .map((l) => l.kindHuman + (l.ports.length ? " " + l.ports.join(",") : "") + (l.addresses.length ? " " + l.addresses.join(", ") : ""))
        .join(" · ")
    );
  }
  if (lb.zones.length) bits.push("зоны: " + lb.zones.join(", "));
  if (lb.age) bits.push("возраст " + lb.age);
  return bits.join(" · ") + (lb.id ? "\n    id " + lb.id : "");
}

function listenerLine(l) {
  const where = l.addresses.length ? l.addresses.join(", ") : "адрес выдаст облако";
  const ports = l.ports.length ? ":" + l.ports.join(",") : "";
  const target = l.routerId ? "роутер " + l.routerId : l.backendGroupId ? "группа бэкендов " + l.backendGroupId : "цель не названа";
  const certs = l.certificateIds.length ? " · сертификатов: " + l.certificateIds.length : "";
  const redirect = l.httpToHttps ? " · перенаправляет на HTTPS" : "";
  return "• " + (l.name || "слушатель") + " — " + l.kindHuman + " " + where + ports + " → " + target + certs + redirect;
}

function targetLine(t) {
  return (
    "• " + t.ipAddress +
    (t.subnetId ? " (подсеть " + t.subnetId + ")" : t.privateOnly ? " (внутренний адрес)" : t.external ? " (внешний адрес)" : "") +
    (t.healthHuman ? " — " + t.healthHuman : "")
  );
}

function tgLine(tg) {
  const bits = ["• " + tg.name, "целей: " + tg.targetCount];
  if (tg.age) bits.push("возраст " + tg.age);
  return bits.join(" · ") + (tg.id ? "\n    id " + tg.id : "");
}

function routerLine(r) {
  const bits = ["• " + r.name, "хостов: " + r.hostCount, "маршрутов: " + r.routeCount];
  const hosts = r.hosts.map((h) => h.authority.join(", ")).filter(Boolean);
  if (hosts.length) bits.push("домены: " + hosts.join(", "));
  if (r.age) bits.push("возраст " + r.age);
  return bits.join(" · ") + (r.id ? "\n    id " + r.id : "");
}

function createYcAlb(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError =
    typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Application Load Balancer: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function baseOf(serviceId, fallback) {
    const b = typeof api.endpoint === "function" ? await api.endpoint(serviceId) : "";
    return b || fallback;
  }

  async function call(oauthToken, serviceId, fallback, method, path, body, timeoutMs) {
    requireApi();
    const base = await baseOf(serviceId, fallback);
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method: method, headers: headers };
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

  function alb(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "alb", ALB_HOST, method, path, body, timeoutMs);
  }

  // Ожидание операции: id готового ресурса приходит ТОЛЬКО в ответе операции,
  // поэтому тело операции возвращается целиком (та же тонкость, что у машин и
  // групп машин).
  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 240000);
    return op || {};
  }

  // ── Чтение ────────────────────────────────────────────────────────────────
  async function loadBalancers(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/loadBalancers?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.loadBalancers) ? j.loadBalancers : []).map(lbInfo);
  }

  async function loadBalancer(oauthToken, id) {
    const lbId = one(id);
    if (!lbId) throw new Error("Не указан id балансировщика.");
    return lbInfo(await alb(oauthToken, "GET", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lbId), undefined, 25000));
  }

  async function findLoadBalancer(oauthToken, folderId, ref) {
    const list = await loadBalancers(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((l) => l.id === q) || list.find((l) => l.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  async function targetGroups(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/targetGroups?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.targetGroups) ? j.targetGroups : []).map(tgInfo);
  }

  async function targetGroup(oauthToken, id) {
    const tgId = one(id);
    if (!tgId) throw new Error("Не указан id группы целей.");
    return tgInfo(await alb(oauthToken, "GET", ALB_BASE + "/targetGroups/" + encodeURIComponent(tgId), undefined, 25000));
  }

  async function findTargetGroup(oauthToken, folderId, ref) {
    const list = await targetGroups(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((g) => g.id === q) || list.find((g) => g.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  async function httpRouters(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/httpRouters?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.httpRouters) ? j.httpRouters : []).map(routerInfo);
  }

  async function findHttpRouter(oauthToken, folderId, ref) {
    const list = await httpRouters(oauthToken, folderId);
    const q = one(ref);
    return list.find((r) => r.id === q) || list.find((r) => r.name === q) || null;
  }

  // Группы бэкендов — только чтение: маршрут роутера обязан вести в СУЩЕСТВУЮЩУЮ
  // группу, иначе роутер создался бы «в никуда». Сами группы бэкендов (с
  // проверками здоровья и балансировкой) — отдельный заход.
  async function backendGroups(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/backendGroups?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.backendGroups) ? j.backendGroups : []).map((b) => ({
      id: one(b && b.id),
      name: one(b && b.name),
      // Бэкенды лежат ВНУТРИ вида группы: stream.backends, http.backends или
      // grpc.backends — поля backends на верхнем уровне у группы нет.
      backendCount:
        ((b && b.stream && b.stream.backends) || []).length +
        ((b && b.http && b.http.backends) || []).length +
        ((b && b.grpc && b.grpc.backends) || []).length,
    }));
  }

  // Группа бэкендов по id — нужна карточке: только в ней лежат id групп целей.
  async function backendGroup(oauthToken, id) {
    const bgId = one(id);
    if (!bgId) throw new Error("Не указан id группы бэкендов.");
    return alb(oauthToken, "GET", ALB_BASE + "/backendGroups/" + encodeURIComponent(bgId), undefined, 25000);
  }

  async function findBackendGroup(oauthToken, folderId, ref) {
    const list = await backendGroups(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((b) => b.id === q) || list.find((b) => b.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  // Карточка: балансировщик и его связи — роутеры слушателей, группы бэкендов
  // (из слушателей-потоков и маршрутов) и группы целей. У балансировщика и
  // роутера ссылки на группу целей НЕТ: путь к ней один — через группу бэкендов,
  // поэтому карточка читает найденные группы бэкендов по id.
  async function card(oauthToken, folderId, ref) {
    const lb = await findLoadBalancer(oauthToken, folderId, ref);
    if (!lb) return null;
    const [tgs, routers, backends] = await Promise.all([
      targetGroups(oauthToken, folderId).catch(() => []),
      httpRouters(oauthToken, folderId).catch(() => []),
      backendGroups(oauthToken, folderId).catch(() => []),
    ]);
    const routerIds = lb.listeners.map((l) => l.routerId).filter(Boolean);
    const boundRouters = routers.filter((r) => routerIds.indexOf(r.id) >= 0);
    const backendIds = [];
    const addBackend = (id) => {
      if (id && backendIds.indexOf(id) < 0) backendIds.push(id);
    };
    lb.listeners.forEach((l) => addBackend(l.backendGroupId));
    boundRouters.forEach((r) => r.hosts.forEach((h) => h.routes.forEach((rt) => addBackend(rt.backendGroupId))));
    const boundBackends = backends.filter((b) => backendIds.indexOf(b.id) >= 0);
    const tgIds = [];
    for (const b of boundBackends.slice(0, 5)) {
      const full = await backendGroup(oauthToken, b.id).catch(() => null);
      const lists = [full && full.stream && full.stream.backends, full && full.http && full.http.backends, full && full.grpc && full.grpc.backends];
      lists.forEach((items) =>
        (items || []).forEach((x) => {
          const ids = (x && x.targetGroups && x.targetGroups.targetGroupIds) || [];
          ids.map(one).filter(Boolean).forEach((id) => {
            if (tgIds.indexOf(id) < 0) tgIds.push(id);
          });
        })
      );
    }
    const used = tgs.filter((g) => tgIds.indexOf(g.id) >= 0);
    const listeners = [];
    for (const l of lb.listeners) {
      if (!l.routerId) continue;
      const r = boundRouters.find((x) => x.id === l.routerId);
      if (r) listeners.push({ listener: l, router: r });
    }
    return {
      lb: lb,
      listeners: listeners,
      routers: boundRouters,
      backendGroups: boundBackends,
      targetGroups: used.length ? used : tgs,
      targetGroupsResolved: used.length > 0,
    };
  }

  // ── Создание группы целей ─────────────────────────────────────────────────
  async function createTargetGroup(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name, "группы целей");

    // Подсеть: у группы целей адрес задаётся ВМЕСТЕ с подсетью, где этот адрес
    // живёт (иначе облако не проверит цель). Если адреса нет — группа пустая.
    const ips = o.ips != null ? [].concat(o.ips).map(one).filter(Boolean) : [];
    let subnetId = "";
    let subnetName = "";
    if (ips.length) {
      const subs = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
        "/vpc/v1/subnets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
      const list = Array.isArray(subs && subs.subnets) ? subs.subnets : [];
      const want = one(o.subnet || o.subnetId);
      const subnet = want ? list.find((s) => s.id === want) || list.find((s) => s.name === want) : list.length === 1 ? list[0] : null;
      if (!subnet) {
        throw new Error(
          "Для целей нужна подсеть, в которой живут их адреса: укажи subnet (имя или id)." +
            (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") + "." : " Подсетей нет — создай: ycVpc { action: \"addsubnet\", ... }.")
        );
      }
      subnetId = one(subnet.id);
      subnetName = one(subnet.name);
    }
    if (ips.length) checkIpList(ips);

    const body = {
      folderId: folderId,
      name: name,
      description: one(o.description),
      targets: ips.map((ip) => ({ ipAddress: ip, subnetId: subnetId })),
    };
    const j = await alb(oauthToken, "POST", ALB_BASE + "/targetGroups", body, 30000);
    const op = await run(oauthToken, j, 120000);
    const id = one(op && op.metadata && op.metadata.targetGroupId) || one(op && op.response && (op.response.id || op.response.targetGroupId)) || "";
    const created = id ? await targetGroup(oauthToken, id).catch(() => null) : await findTargetGroup(oauthToken, folderId, name).catch(() => null);
    const warnings = [];
    if (!ips.length) {
      warnings.push("Группа целей пустая: адреса добавляются действием «Добавить цели». Пока в ней нет целей, балансировщик за неё отвечать не сможет.");
    } else {
      warnings.push("Цели — это адреса машин; проверку здоровья задаёт ГРУППА БЭКЕНДОВ, а не группа целей.");
    }
    return {
      group: created,
      groupId: (created && created.id) || id,
      operationId: one(j && j.id),
      message:
        "Группа целей «" + name + "» создаётся: целей " + ips.length +
        (ips.length && subnetName ? ", подсеть " + subnetName : "") + ".",
      warnings: warnings,
    };
  }

  // ── Состав группы целей: addTargets / removeTargets ───────────────────────
  async function changeTargets(oauthToken, action, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const act = one(action).toLowerCase();
    if (["add", "remove"].indexOf(act) < 0) {
      throw new Error("Состав группы целей: неизвестное действие «" + action + "». Доступно: add, remove.");
    }
    const ips = checkIpList(o.ips);
    const g = await findTargetGroup(oauthToken, folderId, o.group || o.targetGroup);
    if (!g) {
      throw new Error("Не нашёл группу целей «" + one(o.group || o.targetGroup) + "» в каталоге " + folderId + ".");
    }
    if (act === "remove") {
      const absent = ips.filter((ip) => !g.targets.some((t) => t.ipAddress === ip));
      if (absent.length) {
        throw new Error(
          "В группе «" + g.name + "» нет целей: " + absent.join(", ") + ". Сейчас в ней: " +
            (g.targets.length ? g.targets.map((t) => t.ipAddress).join(", ") : "пусто") + "."
        );
      }
    }
    let subnetId = "";
    if (act === "add") {
      const subs = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
        "/vpc/v1/subnets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
      const list = Array.isArray(subs && subs.subnets) ? subs.subnets : [];
      const want = one(o.subnet || o.subnetId);
      const subnet = want ? list.find((s) => s.id === want) || list.find((s) => s.name === want) : list.length === 1 ? list[0] : null;
      if (!subnet) {
        throw new Error(
          "Новой цели нужна подсеть — укажи subnet (имя или id)." +
            (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") + "." : "")
        );
      }
      subnetId = one(subnet.id);
    }
    const body = { targets: ips.map((ip) => (act === "add" ? { ipAddress: ip, subnetId: subnetId } : { ipAddress: ip })) };
    const j = await alb(oauthToken, "POST", ALB_BASE + "/targetGroups/" + encodeURIComponent(g.id) + ":" + (act === "add" ? "addTargets" : "removeTargets"), body, 30000);
    await run(oauthToken, j, 120000);
    const after = await targetGroup(oauthToken, g.id).catch(() => null);
    const now = after || g;
    return {
      changed: true,
      group: now,
      action: act,
      message:
        (act === "add" ? "В группу «" + g.name + "» добавлено целей: " : "Из группы «" + g.name + "» убрано целей: ") +
        ips.length + ". Теперь в ней " + now.targetCount + ".",
      warnings: act === "add"
        ? ["Проверку здоровья цели задаёт группа бэкендов: новая цель может отвечать не сразу, а первое время числиться «проверяется»."]
        : [],
    };
  }

  // ── Создание HTTP-роутера ─────────────────────────────────────────────────
  async function createHttpRouter(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name, "HTTP-роутера");

    // Маршрут ведёт в ГРУППУ БЭКЕНДОВ: без неё роутер ничего не отдаёт, поэтому
    // она проверяется ДО запроса.
    const ref = one(o.backendGroup || o.backendGroupId);
    const bg = await findBackendGroup(oauthToken, folderId, ref);
    if (!bg) {
      const list = await backendGroups(oauthToken, folderId);
      throw new Error(
        "Маршрут ведёт в группу бэкендов, а её нет: " + (ref ? "«" + ref + "» не нашёл" : "не указана") + "." +
          (list.length ? " В каталоге: " + list.map((b) => b.name).join(", ") + "." : " Групп бэкендов в каталоге нет вовсе — их создают в консоли (или в следующем заходе), а маршрут без них не имеет смысла.") +
          " Подсказка: группу бэкендов создают из группы целей и слушателя — action \"backends\" покажет, что уже есть."
      );
    }

    const host = one(o.host || o.authority);
    const pathPrefix = one(o.pathPrefix || o.prefix) || PATH_PREFIX_DEFAULT;
    const pathExact = one(o.pathExact);
    const route = {
      name: one(o.routeName || o.route) || ROUTE_NAME_DEFAULT,
      http: {
        match: { path: pathExact ? { exactMatch: pathExact } : { prefixMatch: pathPrefix } },
        route: { backendGroupId: bg.id },
      },
    };
    if (o.autoHostRewrite === true) route.http.route.autoHostRewrite = true;

    const body = {
      folderId: folderId,
      name: name,
      description: one(o.description),
      virtualHosts: [{ name: one(o.hostName || o.vhost) || "main", authority: host ? [host] : [], routes: [route] }],
    };
    const j = await alb(oauthToken, "POST", ALB_BASE + "/httpRouters", body, 30000);
    const op = await run(oauthToken, j, 120000);
    const id = one(op && op.metadata && op.metadata.httpRouterId) || one(op && op.response && (op.response.id || op.response.httpRouterId)) || "";
    const created = id ? (await httpRouters(oauthToken, folderId).catch(() => [])).find((r) => r.id === id) || null : await findHttpRouter(oauthToken, folderId, name).catch(() => null);
    return {
      router: created,
      routerId: (created && created.id) || id,
      operationId: one(j && j.id),
      message:
        "HTTP-роутер «" + name + "» создаётся: " +
        (host ? "домен " + host + ", " : "без домена (любой хост), ") +
        (pathExact ? "точный путь " + pathExact : "путь " + pathPrefix + "*") +
        " → группа бэкендов «" + bg.name + "».",
      warnings: [
        "Домен (authority) — это то, что пришло в заголовке Host: если его не указать, хост-виртуальный сервер отвечает на ЛЮБОЙ домен, и это не всегда то, что нужно.",
        "Сертификат и HTTPS задаёт СЛУШАТЕЛЬ балансировщика, а не роутер: роутер — только правила путей.",
      ],
    };
  }

  // ── Создание балансировщика ───────────────────────────────────────────────
  async function createLoadBalancer(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name, "балансировщика");

    // Сеть и подсеть: балансировщик стоит в ЗОНАХ, и каждой зоне нужна своя
    // подсеть. Сеть определяется по подсети — иначе нечего спрашивать.
    const subs = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
      "/vpc/v1/subnets?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
    const list = Array.isArray(subs && subs.subnets) ? subs.subnets : [];
    const wantSubnet = one(o.subnet || o.subnetId);
    let subnet = null;
    if (wantSubnet) {
      subnet = list.find((s) => s.id === wantSubnet) || list.find((s) => s.name === wantSubnet) || null;
      if (!subnet) {
        throw new Error(
          "Не нашёл подсеть «" + wantSubnet + "»." +
            (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") : " Подсетей нет — создай: ycVpc { action: \"addsubnet\", ... }.")
        );
      }
    } else if (list.length === 1) {
      subnet = list[0];
    } else {
      throw new Error(
        "Балансировщик стоит в подсети (её зона — зона узла), поэтому нужна подсеть: укажи subnet." +
          (list.length ? " В каталоге: " + list.map((s) => s.name + " (" + s.zoneId + ")").join(", ") + "." : "")
      );
    }
    const zoneId = one(o.zone || o.zoneId) || one(subnet.zoneId);
    if (subnet.zoneId && zoneId && one(subnet.zoneId) !== zoneId) {
      throw new Error("Зона узла (" + zoneId + ") и зона подсети «" + subnet.name + "» (" + subnet.zoneId + ") разные: подсеть должна быть в своей зоне.");
    }
    const networkId = one(o.networkId || subnet.networkId);
    if (!networkId) {
      throw new Error("У подсети «" + subnet.name + "» не названа сеть — без сети балансировщик не создать.");
    }

    // Слушатель: HTTP — роутер, HTTPS — роутер и сертификат, поток — группа
    // бэкендов. Смешивать виды нельзя, поэтому вид выбирается одним полем.
    const kind = one(o.listener || o.kind || "http").toLowerCase();
    if (["http", "https", "stream"].indexOf(kind) < 0) {
      throw new Error("Слушатель бывает http, https или stream (дано: " + o.listener + ").");
    }
    const port = checkPort(kind === "https" ? (o.port || 443) : o.port);
    let handler = {};
    let tls = null;
    if (kind === "stream") {
      const bgRef = one(o.backendGroup || o.backendGroupId);
      const bg = await findBackendGroup(oauthToken, folderId, bgRef);
      if (!bg) {
        throw new Error(
          "Потоковому слушателю нужна группа бэкендов («backendGroup»): " +
            (bgRef ? "«" + bgRef + "» не нашёл" : "не указана") + "."
        );
      }
      handler = { backendGroupId: bg.id, idleTimeout: "60s" };
    } else {
      const rRef = one(o.router || o.httpRouter || o.httpRouterId);
      let router = null;
      if (rRef) {
        router = await findHttpRouter(oauthToken, folderId, rRef);
        if (!router) {
          const rs = await httpRouters(oauthToken, folderId);
          throw new Error(
            "Не нашёл HTTP-роутер «" + rRef + "»." +
              (rs.length ? " В каталоге: " + rs.map((x) => x.name).join(", ") + "." : " Роутеров нет — создай: действие «Создать HTTP-роутер».")
          );
        }
      } else {
        const rs = await httpRouters(oauthToken, folderId);
        if (rs.length === 1) router = rs[0];
        else {
          throw new Error(
            "Слушателю нужен HTTP-роутер — он решает, куда идёт запрос: укажи router." +
              (rs.length ? " В каталоге: " + rs.map((x) => x.name).join(", ") + "." : " Роутеров нет — сначала создай роутер (действие «Создать HTTP-роутер»).")
          );
        }
      }
      handler = { httpRouterId: router.id };
      if (kind === "https") {
        const cRef = one(o.certificate || o.certificateId);
        if (!cRef) {
          throw new Error(
            "HTTPS-слушателю нужен сертификат (поле certificate): он берётся в Certificate Manager. Выпустить: ycCdn { action: \"certnew\", domain: \"…\" } и дождаться статуса Issued."
          );
        }
        const certs = await call(oauthToken, "certificate-manager", "https://certificatemanager.api.cloud.yandex.net", "GET",
          "/certificate-manager/v1/certificates?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
        const cl = Array.isArray(certs && certs.certificates) ? certs.certificates : [];
        const cert = cl.find((c) => c.id === cRef) || cl.find((c) => c.name === cRef);
        if (!cert) {
          throw new Error(
            "Не нашёл сертификат «" + cRef + "» в каталоге." +
              (cl.length ? " В каталоге: " + cl.map((c) => c.name + " (" + one(c.status) + ")").join(", ") + "." : " Сертификатов нет — выпусти: ycCdn { action: \"certnew\", domain: \"…\" }.")
          );
        }
        if (one(cert.status) && one(cert.status).toUpperCase() !== "ISSUED") {
          throw new Error(
            "Сертификат «" + (cert.name || cert.id) + "» ещё не выпущен (состояние " + one(cert.status) + "): HTTPS-слушатель с таким сертификатом не поднимется. Дождись статуса Issued."
          );
        }
        tls = { defaultHandler: { httpHandler: { httpRouterId: router.id }, certificateIds: [one(cert.id)] } };
      }
    }

    const wanted = [].concat(o.securityGroupIds || o.securityGroups || []).map(one).filter(Boolean);
    let securityGroupIds = [];
    if (wanted.length) {
      const groupsRes = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
        "/vpc/v1/securityGroups?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
      const sgs = Array.isArray(groupsRes && groupsRes.securityGroups) ? groupsRes.securityGroups : [];
      for (const w of wanted) {
        const g = sgs.find((x) => x.id === w) || sgs.find((x) => x.name === w);
        if (!g) throw new Error("Не нашёл группу безопасности «" + w + "»." + (sgs.length ? " В каталоге: " + sgs.map((x) => x.name).join(", ") + "." : ""));
        securityGroupIds.push(g.id);
      }
    }

    const addressSpecs = [{ externalIpv4AddressSpec: {} }];
    const staticIp = one(o.address || o.staticAddress);
    if (staticIp) addressSpecs[0].externalIpv4AddressSpec.address = staticIp;
    const listenerSpec = {
      name: one(o.listenerName) || LISTENER_NAME_DEFAULT,
      endpointSpecs: [{ addressSpecs: addressSpecs, ports: [String(port)] }],
      [kind === "stream" ? "stream" : kind === "https" ? "tls" : "http"]:
        kind === "stream" ? { handler: handler } : kind === "https" ? tls : { handler: handler },
    };
    if (kind === "http" && o.httpToHttps === true) listenerSpec.http.redirects = { httpToHttps: true };

    const body = {
      folderId: folderId,
      name: name,
      description: one(o.description),
      regionId: "ru-central1",
      networkId: networkId,
      allocationPolicy: { locations: [{ zoneId: zoneId, subnetId: one(subnet.id) }] },
      listenerSpecs: [listenerSpec],
    };
    if (securityGroupIds.length) body.securityGroupIds = securityGroupIds;
    if (o.minZoneSize != null || o.maxSize != null) {
      body.autoScalePolicy = {
        minZoneSize: String(o.minZoneSize != null ? o.minZoneSize : 2),
        maxSize: String(o.maxSize != null ? o.maxSize : 4),
      };
    }

    const j = await alb(oauthToken, "POST", ALB_BASE + "/loadBalancers", body, 40000);
    const op = await run(oauthToken, j, 240000);
    const id =
      one(op && op.metadata && op.metadata.loadBalancerId) ||
      one(op && op.response && (op.response.id || op.response.loadBalancerId)) ||
      "";
    const created = id ? await loadBalancer(oauthToken, id).catch(() => null) : await findLoadBalancer(oauthToken, folderId, name).catch(() => null);

    const warnings = [
      "Балансировщик ПЛАТНЫЙ и считается за час: платят ресурсные единицы (узлы) и сам ресурс, даже когда трафика нет. Ориентир — ycCosts { service: \"serverlessContainers\" } и каталог цен (ycBilling { action: \"price\", query: \"Application Load Balancer\" }).",
      "Адрес выдаёт облако при создании узла: глянь его в карточке, и только потом вешай на него DNS-запись домена (ycDns).",
      "Балансировщик стоит в зоне подсети (" + zoneId + "). Для отказоустойчивости узлы ставят в двух зонах — это отдельная правка allocationPolicy, а не второй балансировщик.",
    ];
    if (!securityGroupIds.length) {
      warnings.push("Группы безопасности не заданы: правила приёма трафика на порт " + port + " останутся за группой по умолчанию сети, а она обычно закрыта снаружи (ycVpc: addrule).");
    }
    return {
      lb: created,
      lbId: (created && created.id) || id,
      operationId: one(j && j.id),
      message:
        "Балансировщик «" + name + "» создаётся: слушатель " +
        (kind === "stream" ? "поток TCP" : kind === "https" ? "HTTPS/TLS" : "HTTP") +
        ", порт " + port + ", зона " + zoneId + ".",
      warnings: warnings,
    };
  }

  // ── Питание и удаление ────────────────────────────────────────────────────
  async function power(oauthToken, action, ref, o) {
    const opt = o || {};
    const act = one(action).toLowerCase();
    if (["start", "stop"].indexOf(act) < 0) {
      throw new Error("Питание балансировщика: неизвестное действие «" + action + "». Доступно: start, stop.");
    }
    const lb = ref && ref.id ? ref : await findLoadBalancer(oauthToken, opt.folderId, ref);
    if (!lb) throw new Error("Не нашёл балансировщик «" + one(ref) + "»." + (opt.folderId ? " Список — действие list." : ""));
    if (act === "start" && lb.active) return { changed: false, lb: lb, message: "Балансировщик «" + lb.name + "» уже работает." };
    if (act === "stop" && one(lb.status).toUpperCase() === "STOPPED") return { changed: false, lb: lb, message: "Балансировщик «" + lb.name + "» уже остановлен." };
    if (lb.busy) throw new Error("Балансировщик «" + lb.name + "» сейчас занят: " + lb.statusHuman + ". Дождись окончания и повтори.");
    const j = await alb(oauthToken, "POST", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id) + ":" + act, undefined, 40000);
    await run(oauthToken, j, 240000);
    const after = await loadBalancer(oauthToken, lb.id).catch(() => null);
    const now = after || lb;
    return {
      changed: true,
      action: act,
      lb: now,
      message:
        (act === "start" ? "Балансировщик «" + now.name + "» запускается" : "Балансировщик «" + now.name + "» останавливается") +
        (after ? ", состояние: " + after.statusHuman : "") + ".",
      warnings: act === "stop"
        ? ["Остановленный балансировщик перестаёт отвечать по адресам (домен станет недоступен), но ресурсные единицы и сам ресурс продолжают тарифицироваться: остановка экономит не всё."]
        : [],
    };
  }

  async function remove(oauthToken, opts) {
    const o = opts || {};
    const lb = o.lb && o.lb.id ? o.lb : await findLoadBalancer(oauthToken, o.folderId, o.lb || o.id || o.name);
    if (!lb) throw new Error("Не нашёл балансировщик «" + one(o.lb || o.id || o.name) + "».");
    if (lb.busy) {
      throw new Error("Балансировщик «" + lb.name + "» сейчас занят: " + lb.statusHuman + ". Дождись окончания и повтори.");
    }
    const j = await alb(oauthToken, "DELETE", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id), undefined, 40000);
    await run(oauthToken, j, 240000);
    return {
      changed: true,
      lbId: lb.id,
      addresses: lb.addresses,
      message:
        "Балансировщик «" + lb.name + "» удаляется вместе со слушателями" +
        (lb.addresses.length ? " и адресами (" + lb.addresses.join(", ") + ")" : "") + " — отменить нельзя.",
      warnings: [
        "Домен, который смотрел на этот адрес, перестанет открываться: пока не поставлена новая запись, сайт недоступен.",
        "Группы целей и HTTP-роутеры остаются — их удаляют отдельно (действия «Удалить группу целей» и «Удалить HTTP-роутер»).",
      ],
    };
  }

  async function removeTargetGroup(oauthToken, opts) {
    const o = opts || {};
    const g = o.group && o.group.id ? o.group : await findTargetGroup(oauthToken, o.folderId, o.group || o.id || o.name);
    if (!g) throw new Error("Не нашёл группу целей «" + one(o.group || o.id || o.name) + "».");
    const j = await alb(oauthToken, "DELETE", ALB_BASE + "/targetGroups/" + encodeURIComponent(g.id), undefined, 40000);
    await run(oauthToken, j, 120000);
    return {
      changed: true,
      groupId: g.id,
      message: "Группа целей «" + g.name + "» удаляется вместе со списком целей (" + g.targetCount + ").",
      warnings: [
        "Сами машины не трогаются: удаляется только список адресов, по которым балансировщик ходил в них.",
        "Если группа целей задействована в группе бэкендов, облако откажет: сначала убери её оттуда.",
      ],
    };
  }

  async function removeRouter(oauthToken, opts) {
    const o = opts || {};
    const r = o.router && o.router.id ? o.router : await findHttpRouter(oauthToken, o.folderId, o.router || o.id || o.name);
    if (!r) throw new Error("Не нашёл HTTP-роутер «" + one(o.router || o.id || o.name) + "».");
    const j = await alb(oauthToken, "DELETE", ALB_BASE + "/httpRouters/" + encodeURIComponent(r.id), undefined, 40000);
    await run(oauthToken, j, 120000);
    return {
      changed: true,
      routerId: r.id,
      message: "HTTP-роутер «" + r.name + "» удаляется вместе с правилами (" + r.routeCount + ").",
      warnings: ["Если слушатель балансировщика ссылается на этот роутер, вход перестанет отвечать: сначала переключи слушатель на другой роутер."],
    };
  }

  return {
    loadBalancers: loadBalancers,
    loadBalancer: loadBalancer,
    findLoadBalancer: findLoadBalancer,
    card: card,
    targetGroups: targetGroups,
    targetGroup: targetGroup,
    findTargetGroup: findTargetGroup,
    httpRouters: httpRouters,
    findHttpRouter: findHttpRouter,
    backendGroups: backendGroups,
    backendGroup: backendGroup,
    findBackendGroup: findBackendGroup,
    createLoadBalancer: createLoadBalancer,
    createTargetGroup: createTargetGroup,
    changeTargets: changeTargets,
    createHttpRouter: createHttpRouter,
    power: power,
    remove: remove,
    removeTargetGroup: removeTargetGroup,
    removeRouter: removeRouter,
    lbLine: lbLine,
    listenerLine: listenerLine,
    targetLine: targetLine,
    tgLine: tgLine,
    routerLine: routerLine,
    statusHuman: statusHuman,
    targetStatusHuman: targetStatusHuman,
  };
}

module.exports = {
  createYcAlb: createYcAlb,
  ALB_HOST: ALB_HOST,
  ALB_BASE: ALB_BASE,
  PORT_DEFAULT: PORT_DEFAULT,
  statusHuman: statusHuman,
  targetStatusHuman: targetStatusHuman,
  lbInfo: lbInfo,
  tgInfo: tgInfo,
  routerInfo: routerInfo,
  lbLine: lbLine,
  listenerLine: listenerLine,
  targetLine: targetLine,
  tgLine: tgLine,
  routerLine: routerLine,
};

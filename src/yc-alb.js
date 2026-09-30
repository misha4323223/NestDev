"use strict";

/* ── Application Load Balancer Yandex Cloud: HTTPS-вход в приложение ─────────
   Зачем модуль. Машины, группы машин и базы у приложения есть, а ВХОДА в них с
   улицы — нет: без балансировщика сайт живёт на одном адресе одной машины, а
   сертификат (yc-cdn.js умеет его выпустить) некуда повесить. Application Load
   Balancer — это четыре связанных ресурса, и путать их нельзя:

     • ГРУППА БЭКЕНДОВ (backendGroups) — куда ведут маршруты: набор из групп
       целей с проверками здоровья. Именно здесь живут порт целей и проверки
       здоровья: создаётся группа видом (http/grpc/stream), а удаляется только
       когда на неё никто не смотрит (маршрут роутера или слушатель-поток);
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
     PATCH  /loadBalancers/{id}                         правка (имя, описание, группы безопасности)
     POST   /loadBalancers/{id}:addListener             добавить слушателя
     POST   /loadBalancers/{id}:updateListener          правка слушателя (updateMask + listenerSpec)
     POST   /loadBalancers/{id}:removeListener          убрать слушателя (по имени)
     DELETE /loadBalancers/{id}                         удаление
     GET    /targetGroups?folderId=…                    группы целей
     POST   /targetGroups                               создание
     POST   /targetGroups/{id}:addTargets | :removeTargets   состав целей
     DELETE /targetGroups/{id}
     GET    /httpRouters?folderId=…                     роутеры
     POST   /httpRouters                                создание
     PATCH  /httpRouters/{id}                           правка (имя, описание, виртуальные хосты и маршруты)
     DELETE /httpRouters/{id}
     GET    /backendGroups?folderId=…                   группы бэкендов (список)
     GET    /backendGroups/{id}                         группа бэкендов (за ней — её группы целей)
     POST   /backendGroups                              создание (вид, порт целей и проверки)
     PATCH  /backendGroups/{id}                         правка (имя, описание, бэкенды)
     DELETE /backendGroups/{id}                         удаление (занятую облако отклонит)
     GET    /loadBalancers/{id}/targetStates/{bg}/{tg}  здоровье целей (по зонам)

   ЗДОРОВЬЕ ЦЕЛЕЙ в ответах балансировщика и группы целей НЕ приходит: его отдаёт
   только LoadBalancer.GetTargetStates, и спрашивать его надо связкой «группа
   бэкендов + группа целей» — пару ищут У БАЛАНСИРОВЩИКА (слушатель-поток или
   маршрут роутера), а состояние приходит ПО ЗОНАМ (status.zoneStatuses), а не
   одной строкой. У балансировщика НЕТ и защиты от удаления: такого поля в
   справочнике нет вовсе.

   Что важно и не потерять при правке:

     • АДРЕСА. У балансировщика нет «одного адреса»: адрес задаётся у КАЖДОГО
       слушателя (endpointSpecs[].addressSpecs[].externalIpv4AddressSpec), а он
       стоит в зонах, перечисленных в allocationPolicy.locations — каждой зоне
       нужна СВОЯ подсеть. Пока адрес не задан, облако выдаёт его при создании;
       поэтому «адрес балансировщика» — это список адресов его слушателей.
     • СЛУШАТЕЛЬ РОВНО ОДНОГО ВИДА: stream, http или tls (одно из трёх). HTTP —
       это http.handler.httpRouterId; HTTPS — tls.defaultHandler с httpHandler и
       certificateIds. Смешивать HTTP и TCP в одном TLS-слушателе нельзя.
     • СПИСОК СЛУШАТЕЛЕЙ ЗАМЕНЯЕТСЯ ЦЕЛИКОМ, и это ловушка: PATCH с
       listenerSpecs[] стирает всех слушателей, которых нет в присланном списке,
       а PATCH БЕЗ updateMask сбрасывает в значение по умолчанию всё, чего нет в
       теле. Поэтому состав слушателей меняют ТОЧЕЧНЫМИ методами (:addListener,
       :updateListener, :removeListener), а правка самого балансировщика уходит
       С МАСКОЙ полей — в маске только то, что действительно меняем.
     • ГРУППЫ БЕЗОПАСНОСТИ ЗАМЕНЯЮТСЯ ЦЕЛИКОМ: список в теле — это НОВЫЙ список,
       а не добавка к прежнему. Пока порт слушателя не открыт в новых группах,
       вход закроется снаружи.
     • У HTTPS-СЛУШАТЕЛЯ РОВНО ОДИН СЕРТИФИКАТ (tls.defaultHandler.
       certificateIds, максимум 1): годится только ВЫПУЩЕННЫЙ (ISSUED) и лежать
       он обязан в ТОМ ЖЕ каталоге, что балансировщик.
     • ПРАВКА СЛУШАТЕЛЯ — ЭТО НОВЫЙ СЛУШАТЕЛЬ ЦЕЛИКОМ: :updateListener
       принимает updateMask и listenerSpec, а САМ слушатель опознаётся ПО ИМЕНИ
       (переименовать его нельзя — такого поля у метода нет). В маске
       перечисляем только то, что задаём: name, endpoint_specs и вид
       (http/tls/stream); если вид МЕНЯЕТСЯ, в маску попадает и СТАРЫЙ вид —
       иначе облако оставило бы оба, а у слушателя вид ровно один из трёх.
     • АДРЕС ПРИ ПРАВКЕ ОСТАВЛЯЮТ: адрес принадлежит СЛУШАТЕЛЮ, и правка без
       адреса может выдать НОВЫЙ адрес — тогда домены придётся переводить
       заново. Модуль по умолчанию берёт адрес из самого слушателя.
     • SNI — НЕСКОЛЬКО ДОМЕНОВ НА ОДНОМ СЛУШАТЕЛЕ: tls.sniHandlers[] — это
       список { name, serverNames[], handler } со СВОИМ сертификатом у каждого
       (у TLS-обработчика максимум ОДИН сертификат). Все обработчики одного
       слушателя обязаны быть ОДНОГО типа (HTTP или поток): смешивать нельзя.
     • У РОУТЕРА И ГРУППЫ БЭКЕНДОВ ВЛОЖЕННЫЕ СПИСКИ ТОЖЕ ЗАМЕНЯЮТСЯ ЦЕЛИКОМ:
       virtualHosts[] (вместе с routes[]) у роутера и backends[] у группы приходят
       в PATCH как НОВЫЙ список, а не как добавка. Поэтому правка пути, хоста,
       порта целей или проверки здоровья идёт по схеме «прочитал — изменил —
       записал»: облако отдаёт текущий список, модуль меняет в нём ОДНО место и
       возвращает весь список обратно с маской (для роутера — virtual_hosts, для
       группы — имя её вида: http/stream/grpc). Отдельного «поменять порт» у
       облака нет вовсе. Служебные поля (id, status) обратно НЕ уходят: сервис
       отвечает на них отказом — тот же урок, что у правил групп безопасности.
     • ПЕРЕИМЕНОВАТЬ НЕЛЬЗЯ ТОЛЬКО СЛУШАТЕЛЯ: у :updateListener нет поля
       «новое имя». У роутера, группы бэкендов и группы целей поле name в PATCH
       есть, но имя обязано быть УНИКАЛЬНЫМ в каталоге, поэтому занятое имя
       отбивается ДО сети.
     • РОУТЕР БЕЗ ГРУППЫ БЭКЕНДОВ НЕ ИМЕЕТ СМЫСЛА: маршрут ведёт в
       backendGroupId. Модуль проверяет группу бэкендов ДО запроса — иначе
       человек получил бы роутер, который ничего не отдаёт.
     • ЗАНЯТУЮ ГРУППУ БЭКЕНДОВ ОБЛАКО УДАЛЯТЬ ОТКАЖЕТСЯ: на неё смотрят
       маршрут роутера или слушатель-поток. Модуль читает и роутеры, и
       балансировщики ДО сети и называет, кто именно держит группу.
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
const CERT_FALLBACK = "https://certificatemanager.api.cloud.yandex.net";

const PORT_DEFAULT = 80;
const BACKEND_NAME_DEFAULT = "main";
const HEALTH_TIMEOUT = "1s";
const HEALTH_INTERVAL = "2s";
const HEALTH_THRESHOLD = "2";
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

// Состояния сертификата Certificate Manager — из перечисления Status. HTTPS-
// слушателю годится только ВЫПУЩЕННЫЙ: остальные состояния — это «ещё не
// готов» или «уже не годится», и в обоих случаях вход не отвечает.
const CERT_STATUS_RU = {
  VALIDATING: "проверяется (запись подтверждения не готова)",
  PROVISIONING: "выпускается",
  ISSUED: "выпущен",
  INVALID: "недействителен",
  REVOKED: "отозван",
  RENEWAL_FAILED: "не удалось продлить",
};

function certStatusHuman(status) {
  return CERT_STATUS_RU[one(status).toUpperCase()] || one(status);
}

// Вид слушателя в ОТВЕТЕ облака называется tls, а в запросе — https: сравнивать
// их надо приведёнными, иначе слушатель «менял бы вид» на каждом чтении.
function kindInput(kind) {
  const k = one(kind).toLowerCase();
  return k === "tls" ? "https" : k;
}

// Поля балансировщика, которые правит updateLoadBalancer, — словами для ответа
// (в теле и в маске они идут именами из справочника).
const LB_FIELD_RU = {
  name: "имя",
  description: "описание",
  security_group_ids: "группы безопасности",
  endpoint_specs: "адрес и порт",
  http: "вид HTTP",
  tls: "вид HTTPS/TLS",
  stream: "вид поток TCP",
};

// Поле вида в listenerSpec и в маске правки: у слушателя вид ровно один.
const KIND_FIELD = { http: "http", https: "tls", stream: "stream" };

// Поля роутера и группы бэкендов, которые правят updateHttpRouter и
// updateBackendGroup, — словами для ответа.
const ROUTER_FIELD_RU = {
  name: "имя",
  description: "описание",
  virtual_hosts: "виртуальные хосты и маршруты",
};
const GROUP_FIELD_RU = {
  name: "имя",
  description: "описание",
  http: "бэкенды (HTTP)",
  stream: "бэкенды (поток TCP)",
  grpc: "бэкенды (gRPC)",
};

// Обратная запись списка: облако отдаёт служебные поля (id, status), а на запрос
// с ними отвечает отказом — тот же урок, что у правил групп безопасности VPC
// (yc-vpc.js). Чистим их на ЛЮБОЙ глубине и НЕ трогаем поля, которых не знаем:
// список возвращается в том виде, как его отдало облако.
function writableDeep(v) {
  if (Array.isArray(v)) return v.map((x) => writableDeep(x));
  if (!v || typeof v !== "object") return v;
  const out = {};
  Object.keys(v).forEach((k) => {
    if (k === "id" || k === "status") return;
    out[k] = writableDeep(v[k]);
  });
  return out;
}

// Имя домена для SNI: только строчные латинские буквы, цифры, дефис и точка,
// звёздочка — только в начале (*.example.com).
const SNI_SERVER_RE = /^(\*\.)?[-.a-z0-9]+$/;

// Сколько дней осталось до даты (для сертификата): отрицательное — просрочен.
function daysTo(iso) {
  const t = Date.parse(one(iso));
  if (!t) return null;
  return Math.floor((t - Date.now()) / 86400000);
}

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
    // SNI-обработчики: у КАЖДОГО свои домены и СВОЙ сертификат — без этого
    // карточка не назовёт, какой именно домен отвечает и каким сертификатом.
    sni: sni.map((h) => ({
      name: one(h && h.name),
      serverNames: ((h && h.serverNames) || []).map(one),
      certificateIds: (((h && h.handler) || {}).certificateIds || []).map(one),
    })),
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

// Группа бэкендов: ОДИН вид из трёх (stream, http, grpc), и бэкенды лежат
// ВНУТРИ него (stream.backends, http.backends, grpc.backends) — поля backends на
// верхнем уровне у группы нет. Каждый бэкенд несёт порт ЦЕЛЕЙ, группы целей и
// проверки здоровья — ровно то, чего нет ни в группе целей, ни у балансировщика.
function backendGroupInfo(b) {
  const o = b || {};
  const kind = o.stream ? "stream" : o.http ? "http" : o.grpc ? "grpc" : "";
  const spec = o[kind] || {};
  const backends = (spec.backends || []).map((x) => ({
    name: one(x && x.name),
    port: one(x && x.port),
    weight: one(x && x.backendWeight),
    targetGroupIds: ((x && x.targetGroups && x.targetGroups.targetGroupIds) || []).map(one).filter(Boolean),
    healthcheckCount: ((x && x.healthchecks) || []).length,
    storageBucket: one(x && x.storageBucket && x.storageBucket.bucket),
  }));
  const tgIds = [];
  backends.forEach((x) => x.targetGroupIds.forEach((id) => { if (tgIds.indexOf(id) < 0) tgIds.push(id); }));
  return {
    id: one(o.id),
    name: one(o.name),
    folderId: one(o.folderId),
    description: one(o.description),
    createdAt: one(o.createdAt),
    age: humanUptime(o.createdAt),
    kind: kind,
    kindHuman: kind === "http" ? "HTTP" : kind === "grpc" ? "gRPC" : kind === "stream" ? "поток TCP" : "вид не назван",
    backends: backends,
    backendCount: backends.length,
    targetGroupIds: tgIds,
    healthcheckCount: backends.reduce((n, x) => n + x.healthcheckCount, 0),
  };
}

// Здоровье цели: в ответе targetStates оно приходит ПО ЗОНАМ
// (status.zoneStatuses), а не одной строкой со статусом.
function targetStateInfo(st) {
  const o = st || {};
  const t = o.target || {};
  const zones = ((o.status && o.status.zoneStatuses) || []).map((z) => ({
    zoneId: one(z && z.zoneId),
    status: one(z && z.status),
    statusHuman: targetStatusHuman(z && z.status),
    failedActiveHc: !!(z && z.failedActiveHc),
  }));
  return {
    ipAddress: one(t.ipAddress),
    subnetId: one(t.subnetId),
    external: t.externalAddress === true,
    privateOnly: t.privateIpv4Address === true,
    zones: zones,
    healthy: zones.length > 0 && zones.every((z) => z.status.toUpperCase() === "HEALTHY"),
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
  // Домены SNI — это то, зачем слушатель вообще сделан: один слушатель
  // отвечает на несколько доменов, каждому — свой сертификат.
  const sni = (l.sni || [])
    .map((h) => (h.serverNames.length ? h.serverNames.join(", ") : h.name))
    .filter(Boolean);
  return "• " + (l.name || "слушатель") + " — " + l.kindHuman + " " + where + ports + " → " + target + certs + redirect +
    (sni.length ? " · SNI: " + sni.join(" | ") : "");
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

function backendGroupLine(bg) {
  const bits = ["• " + bg.name, bg.kindHuman, "бэкендов: " + bg.backendCount];
  if (bg.targetGroupIds.length) bits.push("группы целей: " + bg.targetGroupIds.join(", "));
  if (bg.healthcheckCount) bits.push("проверок здоровья: " + bg.healthcheckCount);
  if (bg.age) bits.push("возраст " + bg.age);
  return bits.join(" · ") + (bg.id ? "\n    id " + bg.id : "");
}

// Строка здоровья цели: состояния ПО ЗОНАМ (у цели их может быть несколько).
function targetStateLine(s) {
  const where = s.zones.length
    ? s.zones
        .map((z) => (z.zoneId ? z.zoneId + ": " : "") + (z.statusHuman || "—") + (z.failedActiveHc ? " (не проходит активную проверку)" : ""))
        .join(" · ")
    : "состояний нет: у группы бэкендов не заданы проверки здоровья или облако ещё не ответило";
  return "• " + s.ipAddress + (s.subnetId ? " (подсеть " + s.subnetId + ")" : "") + " — " + where;
}

// Строка сертификата HTTPS-слушателя: имя, состояние, домены и срок — по ним
// видно, будет ли вход отвечать, не залезая в консоль Certificate Manager.
function certLine(entry) {
  const e = entry || {};
  const c = e.cert || {};
  const head = "🔒 Слушатель «" + (e.listenerName || "?") + "» — " + (c.name || c.id || "сертификат не назван") +
    (e.certId && e.certId !== c.name ? " (" + e.certId + ")" : "") + " · " + (c.statusHuman || "состояние неизвестно");
  const bits = [];
  if (c.domains && c.domains.length) bits.push("домены: " + c.domains.join(", "));
  if (c.notAfter) {
    bits.push("действует до " + c.notAfter.slice(0, 10) +
      (c.daysLeft != null ? c.daysLeft < 0 ? " (просрочен " + Math.abs(c.daysLeft) + " дн. назад)" : " (осталось " + c.daysLeft + " дн.)" : ""));
  }
  return head + (bits.length ? " · " + bits.join(" · ") : "");
}

// Имя SNI-обработчика по имени домена: у списка доменов своего имени нет, а
// облако требует его у каждого обработчика. «*.example.com» → «sni-wildcard-…».
function sniNameFor(serverName) {
  const base = one(serverName)
    .replace(/^\*\./, "wildcard-")
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  const name = "sni-" + (base || "handler");
  return name.length > 63 ? name.slice(0, 63).replace(/-+$/, "") : name;
}

// SNI-обработчики приходят ДВУМЯ формами: окно шлёт строкой «домен=сертификат»
// (по строке на обработчик, домены через запятую), агент — списком объектов.
// Разбор один, и «сертификата нет» отбивается словами ДО сети: без него
// обработчик не поднимется.
function parseSniHandlers(raw) {
  if (raw == null || raw === "") return [];
  // «нет» — это не домен, а просьба убрать домены: из окна пустое поле означает
  // «не менять», а список заменяется ЦЕЛИКОМ.
  if (typeof raw === "string" && ["нет", "нет.", "-"].indexOf(one(raw).toLowerCase()) >= 0) return [];
  const out = [];
  const push = (entry) => {
    if (!entry) return;
    if (typeof entry === "string") {
      const line = one(entry);
      if (!line) return;
      const cut = line.indexOf("=") >= 0 ? line.indexOf("=") : line.indexOf(":");
      if (cut < 0) {
        throw new Error("SNI: в строке «" + line + "» нет сертификата — пиши «домен=сертификат», а несколько доменов — через запятую.");
      }
      out.push({
        name: "",
        serverNames: line.slice(0, cut).split(/[,\s]+/).map(one).filter(Boolean),
        certificate: one(line.slice(cut + 1)),
      });
      return;
    }
    const o = entry || {};
    const names = [];
    [].concat(o.serverNames != null ? o.serverNames : o.names != null ? o.names : o.domains || [])
      .map(one)
      .forEach((s) => s.split(/[,\s]+/).map(one).filter(Boolean).forEach((x) => names.push(x)));
    out.push({
      name: one(o.name || o.handlerName),
      serverNames: names,
      certificate: one(o.certificate || o.certificateId || o.cert),
    });
  };
  if (Array.isArray(raw)) raw.forEach(push);
  else if (typeof raw === "string") raw.split(/[\n;]+/).forEach(push);
  else if (typeof raw === "object") Object.keys(raw).forEach((k) => push({ serverNames: k, certificate: raw[k] }));
  else throw new Error("SNI: не понял список доменов — передай строкой «домен=сертификат» или списком.");
  return out;
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

  // Группы бэкендов: маршрут роутера обязан вести в СУЩЕСТВУЮЩУЮ группу, иначе
  // роутер создался бы «в никуда».
  async function backendGroups(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/backendGroups?folderId=" + encodeURIComponent(folder) + "&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.backendGroups) ? j.backendGroups : []).map(backendGroupInfo);
  }

  // Группа бэкендов по id — нужна карточке и здоровью: только в ней лежат id
  // групп целей и проверки здоровья.
  async function backendGroup(oauthToken, id) {
    const bgId = one(id);
    if (!bgId) throw new Error("Не указан id группы бэкендов.");
    return backendGroupInfo(await alb(oauthToken, "GET", ALB_BASE + "/backendGroups/" + encodeURIComponent(bgId), undefined, 25000));
  }

  async function findBackendGroup(oauthToken, folderId, ref) {
    const list = await backendGroups(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((b) => b.id === q) || list.find((b) => b.name === q) || null;
    if (got) return got;
    if (!q && list.length === 1) return list[0];
    return null;
  }

  // ── Сертификаты (Certificate Manager) ─────────────────────────────────────
  // HTTPS-слушателю годится только ВЫПУЩЕННЫЙ сертификат, и лежать он обязан в
  // ТОМ ЖЕ каталоге, что балансировщик: чужой каталог облако отклонит.
  async function certificates(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await call(oauthToken, "certificate-manager", CERT_FALLBACK, "GET",
      "/certificate-manager/v1/certificates?folderId=" + encodeURIComponent(folder) + "&pageSize=1000", undefined, 25000);
    return (Array.isArray(j && j.certificates) ? j.certificates : []).map((c) => ({
      id: one(c.id),
      name: one(c.name),
      status: one(c.status).toUpperCase(),
      statusHuman: certStatusHuman(c.status),
      issued: one(c.status).toUpperCase() === "ISSUED",
      domains: (c.domains || []).map(one).filter(Boolean),
      notAfter: one(c.notAfter),
      daysLeft: daysTo(c.notAfter),
    }));
  }

  async function findCertificate(oauthToken, folderId, ref) {
    const list = await certificates(oauthToken, folderId);
    const q = one(ref);
    const got = list.find((c) => c.id === q) || list.find((c) => c.name === q) || null;
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
      ((full && full.targetGroupIds) || []).forEach((id) => {
        if (tgIds.indexOf(id) < 0) tgIds.push(id);
      });
    }
    const used = tgs.filter((g) => tgIds.indexOf(g.id) >= 0);
    const listeners = [];
    for (const l of lb.listeners) {
      if (!l.routerId) continue;
      const r = boundRouters.find((x) => x.id === l.routerId);
      if (r) listeners.push({ listener: l, router: r });
    }
    // HTTPS-слушателю нужен ВЫПУЩЕННЫЙ сертификат из ТОГО ЖЕ каталога. Карточка
    // читает его состояние, домены и срок: иначе «сайт не открывается» ищут
    // вслепую, а причина — в сертификате.
    const certWanted = [];
    lb.listeners.forEach((l) => {
      if (l.kind !== "tls") return;
      if (!l.certificateIds.length) certWanted.push({ listenerName: l.name, certId: "" });
      else l.certificateIds.forEach((id) => certWanted.push({ listenerName: l.name, certId: id }));
      // У SNI-обработчиков сертификаты СВОИ: без них домен отвечал бы не тем
      // сертификатом (или не отвечал вовсе), а по карточке это не видно.
      (l.sni || []).forEach((h) => {
        const label = l.name + " (SNI: " + (h.serverNames.join(", ") || h.name || "домены не названы") + ")";
        if (!h.certificateIds.length) certWanted.push({ listenerName: label, certId: "" });
        else h.certificateIds.forEach((id) => certWanted.push({ listenerName: label, certId: id }));
      });
    });
    let known = [];
    if (certWanted.length) known = await certificates(oauthToken, folderId).catch(() => []);
    const certificates_ = certWanted.map((x) => {
      const c = x.certId ? known.find((y) => y.id === x.certId) || null : null;
      return {
        listenerName: x.listenerName,
        certId: x.certId,
        cert: c || {
          id: x.certId,
          name: "",
          status: "",
          statusHuman: x.certId ? "в каталоге не найден" : "не назван",
          issued: false,
          domains: [],
          notAfter: "",
          daysLeft: null,
          unknown: !!x.certId,
        },
      };
    });
    const warnings = [];
    certificates_.forEach((x) => {
      const c = x.cert;
      if (!x.certId) {
        warnings.push("У HTTPS-слушателя «" + x.listenerName + "» не назван сертификат: HTTPS без сертификата не поднимется. Сертификат выпускают в Certificate Manager (ycCdn certnew), а слушателю его задают при создании (lbnew, certificate).");
      } else if (c.unknown) {
        warnings.push("Сертификат «" + x.certId + "» не найден в каталоге: сертификат обязан лежать в ТОМ ЖЕ каталоге, что балансировщик, иначе облако его не подставит.");
      } else if (!c.issued) {
        warnings.push("Сертификат «" + (c.name || x.certId) + "» в состоянии «" + c.statusHuman + "»: пока он не выпущен, HTTPS-слушатель «" + x.listenerName + "» может не отвечать.");
      } else if (c.daysLeft != null && c.daysLeft < 30) {
        warnings.push(c.daysLeft < 0
          ? "Сертификат «" + c.name + "» просрочен (" + c.notAfter.slice(0, 10) + "): HTTPS не отвечает — выпусти новый и задай его слушателю."
          : "Сертификат «" + c.name + "» истекает " + c.notAfter.slice(0, 10) + " (осталось " + c.daysLeft + " дн.): продли его или выпусти новый заранее.");
      }
    });
    return {
      lb: lb,
      listeners: listeners,
      routers: boundRouters,
      backendGroups: boundBackends,
      targetGroups: used.length ? used : tgs,
      targetGroupsResolved: used.length > 0,
      certificates: certificates_,
      warnings: warnings,
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

  // ── Группа бэкендов: создание и удаление ──────────────────────────────────
  async function createBackendGroup(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const name = checkName(o.name, "группы бэкендов");
    const kind = one(o.kind || o.type || "http").toLowerCase();
    if (["http", "grpc", "stream"].indexOf(kind) < 0) {
      throw new Error("Группа бэкендов бывает http, grpc или stream (дано: " + (o.kind || o.type) + "): вид задаёт и порт, и проверки.");
    }

    // Группа бэкендов без группы целей никуда не ведёт — проверяется ДО сети.
    const tgRef = one(o.targetGroup || o.targetGroupId || o.group);
    const tg = await findTargetGroup(oauthToken, folderId, tgRef);
    if (!tg) {
      const list = await targetGroups(oauthToken, folderId);
      throw new Error(
        "Группе бэкендов нужна группа целей: " + (tgRef ? "«" + tgRef + "» не нашёл" : "не указана") + "." +
          (list.length ? " В каталоге: " + list.map((g) => g.name).join(", ") + "." : " Групп целей нет — сначала создай: действие «Создать группу целей» (targetnew).")
      );
    }

    // Порт здесь — порт, который слушают ЦЕЛИ. У потока его не угадать (у базы
    // он 6432, у брокера свой), поэтому с потока порт спрашивают явно.
    const portGiven = o.port != null && o.port !== "";
    if (kind === "stream" && !portGiven) {
      throw new Error("У потока (stream) порт не угадывается: назови port — это порт, который слушают ЦЕЛИ.");
    }
    const port = checkPort(o.port);
    const backendName = checkName(o.backendName || BACKEND_NAME_DEFAULT, "бэкенда");
    const backend = { name: backendName, port: String(port), targetGroups: { targetGroupIds: [tg.id] } };

    const healthPath = one(o.healthPath || o.healthCheckPath);
    const healthService = one(o.healthService);
    const healthchecks = [];
    if (kind === "http" && healthPath) {
      healthchecks.push({ timeout: HEALTH_TIMEOUT, interval: HEALTH_INTERVAL, healthyThreshold: HEALTH_THRESHOLD, unhealthyThreshold: HEALTH_THRESHOLD, http: { path: healthPath } });
    } else if (kind === "grpc" && healthService) {
      healthchecks.push({ timeout: HEALTH_TIMEOUT, interval: HEALTH_INTERVAL, healthyThreshold: HEALTH_THRESHOLD, unhealthyThreshold: HEALTH_THRESHOLD, grpc: { serviceName: healthService } });
    }
    if (healthchecks.length) backend.healthchecks = healthchecks;

    const body = { folderId: folderId, name: name, description: one(o.description) };
    body[kind] = { backends: [backend] };
    const j = await alb(oauthToken, "POST", ALB_BASE + "/backendGroups", body, 30000);
    const op = await run(oauthToken, j, 120000);
    const id = one(op && op.metadata && op.metadata.backendGroupId) || one(op && op.response && op.response.id) || "";
    const created = id ? await backendGroup(oauthToken, id).catch(() => null) : await findBackendGroup(oauthToken, folderId, name).catch(() => null);

    const warnings = [];
    if (!healthchecks.length && kind !== "stream") {
      warnings.push("Проверки здоровья не заданы: облако будет считать цель здоровой всегда — упавшая машина останется в ротации. Путь проверки задаётся полем healthPath (например, \"/\").");
    }
    if (kind === "stream") {
      warnings.push("Проверки здоровья потока здесь не задаются: они требуют пары «запрос-ответ» (send/receive) и настраиваются в консоли. Поток без проверок падения машины не заметит.");
    }
    if (kind === "http" && healthService && !healthPath) {
      warnings.push("healthService — это проверка gRPC: у HTTP проверка задаётся путём (healthPath), поэтому проверка не включена.");
    }
    if (!portGiven && kind !== "stream") {
      warnings.push("Порт не назван — взят " + PORT_DEFAULT + ": это порт, который слушают ЦЕЛИ (машины), а не балансировщик. У базы и брокера он свой.");
    }
    warnings.push("Дальше: маршрут роутера (routernew, backendGroup) или потоковый слушатель балансировщика (lbnew, listener: \"stream\").");
    return {
      group: created,
      groupId: (created && created.id) || id,
      operationId: one(j && j.id),
      message:
        "Группа бэкендов «" + name + "» создаётся: " +
        (kind === "http" ? "HTTP" : kind === "grpc" ? "gRPC" : "поток TCP") +
        ", бэкенд «" + backendName + "» — порт " + port + ", группа целей «" + tg.name + "»" +
        (healthchecks.length ? ", проверка здоровья " + (healthPath || healthService) : "") + ".",
      warnings: warnings,
    };
  }

  async function removeBackendGroup(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const found = o.group && o.group.id ? o.group : await findBackendGroup(oauthToken, folderId, o.group || o.id || o.name);
    if (!found) throw new Error("Не нашёл группу бэкендов «" + one(o.group || o.id || o.name) + "».");
    const bg = found.kind ? found : await backendGroup(oauthToken, found.id);

    // Занятую группу облако удалять откажется: на неё смотрят маршрут роутера
    // или слушатель-поток. Читаем и то и другое ДО сети и называем виновников.
    const [routers, lbs] = await Promise.all([
      httpRouters(oauthToken, folderId),
      loadBalancers(oauthToken, folderId),
    ]);
    const holders = [];
    routers.forEach((r) => {
      if (r.hosts.some((h) => h.routes.some((rt) => rt.backendGroupId === bg.id))) holders.push("роутер «" + r.name + "»");
    });
    lbs.forEach((l) => {
      if (l.listeners.some((x) => x.backendGroupId === bg.id)) holders.push("слушатель балансировщика «" + l.name + "»");
    });
    if (holders.length) {
      throw new Error(
        "Группа бэкендов «" + bg.name + "» ещё работает: на неё смотрят " + holders.join(" и ") +
          ". Облако откажет удалять занятую группу — сначала переключи или удали то, что на неё смотрит, и повтори."
      );
    }

    const j = await alb(oauthToken, "DELETE", ALB_BASE + "/backendGroups/" + encodeURIComponent(bg.id), undefined, 40000);
    await run(oauthToken, j, 120000);
    return {
      changed: true,
      groupId: bg.id,
      message: "Группа бэкендов «" + bg.name + "» удаляется: проверки здоровья и настройки балансировки будут потеряны.",
      warnings: [
        "Группы целей, машины и роутеры не трогаются: удаляется только связка «какие цели и как проверять».",
        "Маршрут, который вёл в эту группу, отвечать перестанет — если такой был, слушатель потеряет ответ.",
      ],
    };
  }

  // ── Здоровье целей ────────────────────────────────────────────────────────
  // Здоровье спрашивают у ПАРЫ «группа бэкендов + группа целей», а пару ищут у
  // балансировщика: ни у него, ни у роутера ссылки на группу целей нет.
  async function targetStates(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const lbRef = one(o.lb || o.loadBalancer || o.loadBalancerId || o.id);
    const lb = o.lb && o.lb.id ? o.lb : await findLoadBalancer(oauthToken, folderId, lbRef);
    if (!lb) throw new Error("Не нашёл балансировщик «" + lbRef + "» в каталоге. Список — действие list.");
    const tgRef = one(o.targetGroup || o.targetGroupId || o.group || o.target);
    const tg = o.targetGroup && o.targetGroup.id ? o.targetGroup : await findTargetGroup(oauthToken, folderId, tgRef);
    if (!tg) throw new Error("Не нашёл группу целей «" + tgRef + "» в каталоге. Список — действие targets.");

    const c = await card(oauthToken, folderId, lb.id);
    const bound = (c && c.backendGroups) || [];
    const bgRef = one(o.backendGroup || o.backendGroupId);
    let bg = null;
    if (bgRef) {
      bg = bound.find((b) => b.id === bgRef) || bound.find((b) => b.name === bgRef) || null;
      if (!bg) {
        throw new Error(
          "Группа бэкендов «" + bgRef + "» не закреплена за балансировщиком «" + lb.name + "»: здоровье спрашивают только у той пары, которая работает, а пару задаёт слушатель-поток или маршрут роутера." +
            (bound.length ? " У «" + lb.name + "» закреплено: " + bound.map((b) => b.name).join(", ") + "." : " Закреплённых групп бэкендов у него нет.")
        );
      }
    } else if (bound.length === 1) {
      bg = bound[0];
    } else if (bound.length > 1) {
      throw new Error(
        "У балансировщика «" + lb.name + "» групп бэкендов больше одной (" + bound.map((b) => b.name).join(", ") +
          "): назови backendGroup — здоровье спрашивают у конкретной пары."
      );
    } else {
      throw new Error(
        "У балансировщика «" + lb.name + "» нет закреплённых групп бэкендов: здоровье спрашивают у пары «группа бэкендов + группа целей», а пару задаёт слушатель-поток или маршрут роутера."
      );
    }

    const full = await backendGroup(oauthToken, bg.id);
    if (full.targetGroupIds.indexOf(tg.id) < 0) {
      throw new Error(
        "Группа бэкендов «" + bg.name + "» не ссылается на группу целей «" + tg.name + "»: здоровье спрашивают только у той пары, что соединена на самом деле." +
          (full.targetGroupIds.length ? " В её бэкендах: " + full.targetGroupIds.join(", ") + "." : " В её бэкендах групп целей нет вовсе.")
      );
    }

    const j = await alb(
      oauthToken,
      "GET",
      ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id) + "/targetStates/" + encodeURIComponent(bg.id) + "/" + encodeURIComponent(tg.id),
      undefined,
      25000
    );
    const states = (Array.isArray(j && j.targetStates) ? j.targetStates : []).map(targetStateInfo);
    const healthyCount = states.filter((s) => s.healthy).length;
    const lines = ["Здоровье целей группы «" + tg.name + "» (группа бэкендов «" + bg.name + "», балансировщик «" + lb.name + "»):"];
    if (!states.length) lines.push("Целей нет: добавь адреса действием «Добавить цели» (targetadd), иначе вести некуда.");
    else for (const s of states) lines.push("  " + targetStateLine(s));
    if (states.length) lines.push("Целей: " + states.length + " · здоровых: " + healthyCount + ".");

    const warnings = [];
    if (!full.healthcheckCount) {
      warnings.push("У группы бэкендов «" + bg.name + "» не заданы проверки здоровья: облако считает здоровой КАЖДУЮ цель — упавшая машина останется в ротации.");
    }
    if (states.some((s) => s.zones.some((z) => z.status.toUpperCase() === "TIMEOUT"))) {
      warnings.push("Часть проверок ещё не ответила («проверка не успела ответить»): у свежей цели это обычное дело — повтори через минуту.");
    }
    if (states.length && healthyCount < states.length) {
      warnings.push("В маршрут попадут только здоровые цели: проверь машины, порт целей и путь проверки в группе бэкендов.");
    }
    return {
      lb: lb,
      backendGroup: bg,
      targetGroup: tg,
      states: states,
      healthyCount: healthyCount,
      lines: lines,
      message: "Здоровье целей «" + tg.name + "»: целей " + states.length + ", здоровых " + healthyCount + ".",
      warnings: warnings,
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
          (list.length ? " В каталоге: " + list.map((b) => b.name).join(", ") + "." : " Групп бэкендов в каталоге нет вовсе — их создаёт действие «Создать группу бэкендов» (backnew), а маршрут без них не имеет смысла.") +
          " Подсказка: группу бэкендов создают из группы целей — action \"backends\" покажет, что уже есть."
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

  // ── Сборка слушателя и групп безопасности ────────────────────────────────
  // Слушатель собирает ОДНА функция: создание балансировщика, добавление и
  // правка слушателя — три копии одного разбора разъехались бы. HTTP — это
  // роутер, HTTPS — роутер и ВЫПУЩЕННЫЙ сертификат, поток — группа бэкендов.
  async function listenerSpecOf(oauthToken, folderId, o) {
    const kind = one(o.listener || o.kind || "http").toLowerCase();
    if (["http", "https", "stream"].indexOf(kind) < 0) {
      throw new Error("Слушатель бывает http, https или stream (дано: " + o.listener + ").");
    }
    const port = checkPort(kind === "https" ? (o.port || 443) : o.port);
    const givenName = one(o.listenerName);
    if (givenName) checkName(givenName, "слушателя");
    const name = givenName || LISTENER_NAME_DEFAULT;

    // Домены сверх первого живут в SNI-обработчиках — но только у HTTPS: у HTTP и
    // потока сертификата (а значит и домена) нет вовсе. Это отказ ДО сети.
    const sniRaw = o.sni != null ? o.sni : o.sniHandlers != null ? o.sniHandlers : null;
    if (kind !== "https" && parseSniHandlers(sniRaw).length) {
      throw new Error(
        "SNI-обработчики (несколько доменов на одном слушателе) бывают только у HTTPS-слушателя: у HTTP и потока домена в сертификате нет. Смени вид слушателя на https."
      );
    }

    let handler = {};
    let tls = null;
    let sniSummary = [];
    if (kind === "stream") {
      const bgRef = one(o.backendGroup || o.backendGroupId);
      const bg = await findBackendGroup(oauthToken, folderId, bgRef);
      if (!bg) {
        throw new Error(
          "Потоковому слушателю нужна группа бэкендов («backendGroup»): " +
            (bgRef ? "«" + bgRef + "» не нашёл" : "не указана") + "."
        );
      }
      if (bg.kind && bg.kind !== "stream") {
        throw new Error(
          "Группа бэкендов «" + bg.name + "» — " + bg.kindHuman + ", а потоковому слушателю нужна группа вида stream: облако такой слушатель не примет."
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
        const cert = await findCertificate(oauthToken, folderId, cRef);
        if (!cert) {
          const cl = await certificates(oauthToken, folderId).catch(() => []);
          throw new Error(
            "Не нашёл сертификат «" + cRef + "» в каталоге." +
              (cl.length ? " В каталоге: " + cl.map((c) => c.name + " (" + c.status + ")").join(", ") + "." : " Сертификатов нет — выпусти: ycCdn { action: \"certnew\", domain: \"…\" }.")
          );
        }
        if (cert.status && !cert.issued) {
          throw new Error(
            "Сертификат «" + (cert.name || cert.id) + "» ещё не выпущен (состояние " + cert.status + "): HTTPS-слушатель с таким сертификатом не поднимется. Дождись статуса Issued."
          );
        }
        tls = { defaultHandler: { httpHandler: { httpRouterId: router.id }, certificateIds: [cert.id] } };

        // SNI: один TLS-слушатель отвечает на НЕСКОЛЬКО доменов, и у каждого
        // домена свой сертификат. Обработчик обязан быть того же типа, что
        // defaultHandler (оба — HTTP), иначе облако слушатель не примет.
        const snis = parseSniHandlers(sniRaw);
        if (snis.length) {
          const handlers = [];
          const seen = [];
          const handlerNames = [];
          for (const h of snis) {
            if (!h.serverNames.length) {
              throw new Error("SNI: у обработчика не назван ни один домен — пиши «домен=сертификат» (несколько доменов — через запятую).");
            }
            h.serverNames.forEach((n) => {
              if (n.length > 255 || !SNI_SERVER_RE.test(n)) {
                throw new Error(
                  "SNI: домен «" + n + "» облако не примет — только строчные латинские буквы, цифры, дефис и точка; звёздочка — только в начале (*.example.com)."
                );
              }
              if (seen.indexOf(n) >= 0) {
                throw new Error("SNI: домен «" + n + "» назван дважды — домен принадлежит РОВНО одному обработчику, иначе облако не поймёт, какой сертификат отдавать.");
              }
              seen.push(n);
            });
            if (!h.certificate) {
              throw new Error("SNI: у доменов «" + h.serverNames.join(", ") + "» не назван сертификат — у каждого SNI-обработчика СВОЙ сертификат (пиши «домен=сертификат»).");
            }
            const scert = await findCertificate(oauthToken, folderId, h.certificate);
            if (!scert) {
              const cl = await certificates(oauthToken, folderId).catch(() => []);
              throw new Error(
                "SNI: не нашёл сертификат «" + h.certificate + "» для домена «" + h.serverNames[0] + "» в каталоге." +
                  (cl.length ? " В каталоге: " + cl.map((c) => c.name + " (" + c.status + ")").join(", ") + "." : " Сертификатов нет — выпусти: ycCdn { action: \"certnew\", domain: \"…\" }.")
              );
            }
            if (scert.status && !scert.issued) {
              throw new Error(
                "SNI: сертификат «" + (scert.name || scert.id) + "» ещё не выпущен (состояние " + scert.status + "): обработчик для домена «" + h.serverNames[0] + "» с ним не поднимется. Дождись статуса Issued."
              );
            }
            const hname = h.name || sniNameFor(h.serverNames[0]);
            checkName(hname, "SNI-обработчика");
            if (handlerNames.indexOf(hname) >= 0) {
              throw new Error("SNI: два обработчика с одним именем «" + hname + "» — назови их (sni: имя | домены | сертификат) или разведи домены по разным обработчикам.");
            }
            handlerNames.push(hname);
            handlers.push({
              name: hname,
              serverNames: h.serverNames,
              handler: { httpHandler: { httpRouterId: router.id }, certificateIds: [scert.id] },
            });
          }
          tls.sniHandlers = handlers;
          sniSummary = handlers.map((h) => ({ name: h.name, serverNames: h.serverNames, certificateId: h.handler.certificateIds[0] }));
        }
      }
    }

    const addressSpecs = [{ externalIpv4AddressSpec: {} }];
    const staticIp = one(o.address || o.staticAddress);
    if (staticIp) addressSpecs[0].externalIpv4AddressSpec.address = staticIp;
    const listenerSpec = {
      name: name,
      endpointSpecs: [{ addressSpecs: addressSpecs, ports: [String(port)] }],
      [kind === "stream" ? "stream" : kind === "https" ? "tls" : "http"]:
        kind === "stream" ? { handler: handler } : kind === "https" ? tls : { handler: handler },
    };
    if (kind === "http" && o.httpToHttps === true) listenerSpec.http.redirects = { httpToHttps: true };
    return {
      kind: kind,
      kindHuman: kind === "stream" ? "поток TCP" : kind === "https" ? "HTTPS/TLS" : "HTTP",
      port: port,
      name: name,
      routerId: one(handler.httpRouterId),
      backendGroupId: one(handler.backendGroupId),
      certificateId: one(tls && tls.defaultHandler && tls.defaultHandler.certificateIds[0]),
      sni: sniSummary,
      staticAddress: staticIp,
      listenerSpec: listenerSpec,
    };
  }

  // Группы безопасности: имена разрешаются в id, а список ЗАМЕНЯЕТСЯ целиком —
  // поэтому сборка одна на создание балансировщика и на его правку.
  async function securityGroupIdsOf(oauthToken, folderId, wanted) {
    const ids = [];
    // Форма в окне и агент зовут этот разбор по-разному: окно шлёт строку
    // «sg-1, sg-2» (поле «через запятую»), агент — массив имён. Разбираем оба.
    const list = [];
    [].concat(wanted || []).map(one).filter(Boolean).forEach((w) => {
      w.split(/[,\n;]+/).forEach((s) => {
        const t = one(s);
        if (t) list.push(t);
      });
    });
    if (!list.length) return ids;
    const groupsRes = await call(oauthToken, "vpc", "https://vpc.api.cloud.yandex.net", "GET",
      "/vpc/v1/securityGroups?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", undefined, 25000);
    const sgs = Array.isArray(groupsRes && groupsRes.securityGroups) ? groupsRes.securityGroups : [];
    for (const w of list) {
      const g = sgs.find((x) => x.id === w) || sgs.find((x) => x.name === w);
      if (!g) throw new Error("Не нашёл группу безопасности «" + w + "»." + (sgs.length ? " В каталоге: " + sgs.map((x) => x.name).join(", ") + "." : ""));
      ids.push(g.id);
    }
    return ids;
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

    // Слушатель собирает ОДНА сборка (listenerSpecOf): она же нужна добавлению
    // и правке слушателя — три копии одного разбора разъехались бы.
    const L = await listenerSpecOf(oauthToken, folderId, o);
    const kind = L.kind;
    const port = L.port;
    const listenerSpec = L.listenerSpec;
    const securityGroupIds = await securityGroupIdsOf(oauthToken, folderId, o.securityGroupIds || o.securityGroups);

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
    if (L.sni.length) {
      warnings.push(
        "Домены SNI у слушателя «" + L.name + "»: " + L.sni.map((h) => h.serverNames.join(", ")).join(" | ") +
          " — каждый со СВОИМ сертификатом; остальным доменам достаётся основной сертификат слушателя."
      );
    }
    return {
      lb: created,
      lbId: (created && created.id) || id,
      sni: L.sni,
      operationId: one(j && j.id),
      message:
        "Балансировщик «" + name + "» создаётся: слушатель " +
        (kind === "stream" ? "поток TCP" : kind === "https" ? "HTTPS/TLS" : "HTTP") +
        ", порт " + port + ", зона " + zoneId + (L.sni.length ? ", домены SNI: " + L.sni.map((h) => h.serverNames.join(", ")).join(" | ") : "") + ".",
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

  // ── Правка слушателей и самого балансировщика ────────────────────────────
  // Состав слушателей меняют ТОЧЕЧНЫМИ методами: PATCH с listenerSpecs[] стёр
  // бы всех, кого нет в списке, а PATCH без маски — всё, чего нет в теле.
  async function requireLoadBalancer(oauthToken, folderId, ref) {
    const lb = ref && ref.id ? ref : await findLoadBalancer(oauthToken, folderId, ref);
    if (!lb) throw new Error("Не нашёл балансировщик «" + one(ref) + "» в каталоге. Список — действие list.");
    if (lb.busy) {
      throw new Error(
        "Балансировщик «" + lb.name + "» сейчас занят: " + lb.statusHuman + ". Слушатели меняют только у работающего (или остановленного) балансировщика — дождись окончания и повтори."
      );
    }
    return lb;
  }

  // Добавление слушателя: имя уникально ВНУТРИ балансировщика, вид — http,
  // https (с выпущенным сертификатом) или поток TCP (с группой вида stream).
  async function addListener(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const lb = await requireLoadBalancer(oauthToken, folderId, o.lb || o.loadBalancer || o.id || o.name);
    const L = await listenerSpecOf(oauthToken, folderId, o);
    if (lb.listeners.some((x) => x.name === L.name)) {
      throw new Error(
        "У балансировщика «" + lb.name + "» уже есть слушатель «" + L.name + "»: имя слушателя уникально внутри балансировщика, а второй слушатель с тем же именем облако не примет. Выбери другое имя."
      );
    }
    const j = await alb(oauthToken, "POST", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id) + ":addListener", { listenerSpec: L.listenerSpec }, 40000);
    await run(oauthToken, j, 240000);
    const after = await loadBalancer(oauthToken, lb.id).catch(() => null);
    const now = after || lb;
    const added = (now.listeners || []).find((x) => x.name === L.name) || null;
    if (after && !added) {
      throw new Error(
        "Слушатель «" + L.name + "» не появился у балансировщика «" + now.name + "»: облако приняло запрос, но в ответе его нет. Нужна роль alb.editor (или admin) — проверь права и повтори."
      );
    }
    const warnings = [
      "Адрес слушателя выдаёт облако и он же адрес других слушателей: домен вешай на адрес ТОЛЬКО после того, как он появился в карточке (ycDns).",
    ];
    if (L.kind === "https") warnings.push("Сертификат должен оставаться выпущенным: когда он истечёт, HTTPS перестанет отвечать — карточка показывает срок, и новый сертификат выпускают заранее.");
    if (L.sni.length) warnings.push("SNI-обработчики обслуживают свои домены СВОИМ сертификатом: у каждого обработчика максимум один сертификат, а домен, которого нет ни в одном обработчике, отдаётся основным сертификатом слушателя.");
    if (L.kind === "stream") warnings.push("Потоковый слушатель ведёт трафик в группу бэкендов вида stream, и порт слушателя должен совпадать с портом целей в той группе — иначе цели не ответят.");
    if (L.port === 80 || L.port === 443) warnings.push("Порт " + L.port + " обязан быть открыт в группах безопасности балансировщика: без них снаружи порт закрыт (ycVpc: addrule).");
    return {
      changed: true,
      lb: now,
      listener: added,
      listenerName: L.name,
      listenerSpec: L.listenerSpec,
      sni: L.sni,
      operationId: one(j && j.id),
      message:
        "Балансировщик «" + now.name + "» получает слушателя «" + L.name + "»: " + L.kindHuman + ", порт " + L.port +
        (L.staticAddress ? ", адрес " + L.staticAddress : "") +
        (L.sni.length ? ", домены SNI: " + L.sni.map((h) => h.serverNames.join(", ")).join(" | ") : "") + ".",
      warnings: warnings,
    };
  }

  // Удаление слушателя: адрес и порт закрываются вместе с ним, поэтому модуль
  // говорит об этом ДО запроса и предупреждает, если слушатель остался один.
  async function removeListener(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const lb = await requireLoadBalancer(oauthToken, folderId, o.lb || o.loadBalancer || o.id || o.name);
    const ref = one(o.listenerName || o.listener);
    const names = lb.listeners.map((l) => l.name).filter(Boolean);
    if (!ref) {
      throw new Error(
        "Не указано имя слушателя (listenerName). У балансировщика «" + lb.name + "» " + (names.length ? "слушатели: " + names.join(", ") : "слушателей нет") + "."
      );
    }
    const found = lb.listeners.find((l) => l.name === ref) || null;
    if (!found) {
      throw new Error(
        "У балансировщика «" + lb.name + "» нет слушателя «" + ref + "»." + (names.length ? " Слушатели: " + names.join(", ") + "." : " Слушателей нет вовсе.")
      );
    }
    const j = await alb(oauthToken, "POST", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id) + ":removeListener", { name: found.name }, 40000);
    await run(oauthToken, j, 120000);
    const after = await loadBalancer(oauthToken, lb.id).catch(() => null);
    const now = after || lb;
    if (after && (after.listeners || []).some((x) => x.name === found.name)) {
      throw new Error(
        "Слушатель «" + found.name + "» остался у балансировщика «" + now.name + "»: облако приняло запрос, но состав не изменился. Нужна роль alb.editor (или admin) — проверь права и повтори."
      );
    }
    const warnings = [
      found.addresses.length
        ? "Адрес " + found.addresses.join(", ") + " освободится, если его не слушает другой слушатель: домен, который на него смотрел, перестанет открываться — сначала поставь запись на новый адрес."
        : "Порт " + (found.ports.join(",") || "слушателя") + " закроется снаружи: домен, который на него смотрел, перестанет открываться.",
    ];
    if (!(now.listeners || []).length) {
      warnings.push("У балансировщика не осталось слушателей: он работает, но ни на одном порту не отвечает — а тарифицируется по-прежнему за час.");
    }
    return {
      changed: true,
      lb: now,
      listener: found,
      listenerName: found.name,
      operationId: one(j && j.id),
      message:
        "Слушатель «" + found.name + "» (" + found.kindHuman +
        (found.addresses.length ? " " + found.addresses.join(", ") : "") +
        (found.ports.length ? ":" + found.ports.join(",") : "") + ") убирается у балансировщика «" + now.name + "» — вход по нему закроется.",
      warnings: warnings,
    };
  }

  // Правка самого балансировщика: имя, описание и группы безопасности. Уходит
  // С МАСКОЙ полей: без маски облако сбросило бы всё, чего нет в теле (включая
  // слушателей), а с маской меняет только названное.
  async function updateLoadBalancer(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const lb = await requireLoadBalancer(oauthToken, folderId, o.lb || o.loadBalancer || o.id);
    const body = {};
    const mask = [];
    const newName = one(o.newName || o.rename);
    if (newName) {
      checkName(newName, "балансировщика");
      if (newName === lb.name) throw new Error("Балансировщик уже называется «" + newName + "»: назови другое имя или убери newName.");
      body.name = newName;
      mask.push("name");
    }
    if (o.description != null) {
      body.description = one(o.description);
      mask.push("description");
    }
    if (o.securityGroupIds != null || o.securityGroups != null) {
      body.securityGroupIds = await securityGroupIdsOf(oauthToken, folderId, o.securityGroupIds != null ? o.securityGroupIds : o.securityGroups);
      mask.push("security_group_ids");
    }
    if (!mask.length) {
      throw new Error(
        "Нечего менять: назови новое имя (newName), описание (description) или группы безопасности (securityGroups). Состав слушателей правят отдельными действиями — добавление, правка и удаление слушателя (listeneradd, listenerupd, listenerdel)."
      );
    }
    body.updateMask = mask.join(",");
    const j = await alb(oauthToken, "PATCH", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id), body, 40000);
    await run(oauthToken, j, 240000);
    const after = await loadBalancer(oauthToken, lb.id).catch(() => null);
    const now = after || lb;
    // Правка обязана подтвердиться ПЕРЕЧИТЫВАНИЕМ: облако может ответить
    // «сделано» и ничего не сделать (права, чужое поле, отброшенное значение).
    const bad = [];
    if (mask.indexOf("name") >= 0 && now.name !== body.name) bad.push("имя («" + now.name + "»)");
    if (mask.indexOf("description") >= 0 && one(now.description) !== one(body.description)) bad.push("описание («" + one(now.description) + "»)");
    if (mask.indexOf("security_group_ids") >= 0 && now.securityGroupIds.slice().sort().join(",") !== body.securityGroupIds.slice().sort().join(",")) {
      bad.push("группы безопасности (" + (now.securityGroupIds.join(", ") || "их нет") + ")");
    }
    if (bad.length) {
      throw new Error("Правка балансировщика «" + lb.name + "» не применилась: " + bad.join(", ") + ". Нужна роль alb.editor (или admin).");
    }
    const warnings = [];
    if (mask.indexOf("security_group_ids") >= 0) {
      warnings.push(
        "Список групп безопасности ЗАМЕНЁН целиком, а не дополнен: правила приёма трафика на порты " + (now.ports.join(", ") || "слушателей") +
          " должны быть открыты в НОВЫХ группах — иначе вход закроется снаружи. Группа по умолчанию открывает трафик только внутри сети."
      );
    }
    if (mask.indexOf("name") >= 0) {
      warnings.push("Имя — это подпись, а не адрес: домены смотрят на адреса слушателей, поэтому переименование их не трогает.");
    }
    return {
      changed: true,
      lb: now,
      fields: mask,
      operationId: one(j && j.id),
      message: "Балансировщик «" + lb.name + "» обновляется: " + mask.map((f) => LB_FIELD_RU[f] || f).join(", ") + ".",
      warnings: warnings,
    };
  }

  // ── Правка слушателя ─────────────────────────────────────────────────────
  // Переименовать слушателя нельзя: :updateListener опознаёт его ПО ИМЕНИ, а
  // поля «новое имя» у метода нет. Поэтому правка — это тот же слушатель с
  // новыми настройками, а маска перечисляет то, что задали (и СТАРЫЙ вид, если
  // вид меняется: иначе у слушателя оказалось бы два вида, а облако такого не
  // принимает). Чего не назвали — остаётся прежним: так «продлить сертификат»
  // — это одно поле, а не пересборка слушателя.
  async function updateListener(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const lb = await requireLoadBalancer(oauthToken, folderId, o.lb || o.loadBalancer || o.id || o.name);
    const ref = one(o.listenerName || o.listener);
    const names = lb.listeners.map((x) => x.name).filter(Boolean);
    if (!ref) {
      throw new Error(
        "Не указано имя слушателя (listenerName). У балансировщика «" + lb.name + "» " + (names.length ? "слушатели: " + names.join(", ") : "слушателей нет") + "."
      );
    }
    const before = lb.listeners.find((x) => x.name === ref) || null;
    if (!before) {
      throw new Error(
        "У балансировщика «" + lb.name + "» нет слушателя «" + ref + "»." +
          (names.length ? " Слушатели: " + names.join(", ") + "." : " Слушателей нет — сначала добавь (действие listeneradd).") +
          " Переименовать слушателя нельзя: правка — это тот же слушатель с новыми настройками."
      );
    }

    // Вид, порт, адрес, роутер, сертификат, группа бэкендов и перенаправление —
    // из самого слушателя, если человек их не назвал.
    const keepSni = (before.sni || []).map((h) => ({ name: h.name, serverNames: h.serverNames, certificate: h.certificateIds[0] }));
    const givenSni = o.sni != null ? o.sni : o.sniHandlers != null ? o.sniHandlers : null;
    const wantKind = one(o.listener || o.kind) || kindInput(before.kind);
    const L = await listenerSpecOf(oauthToken, folderId, {
      folderId: folderId,
      listener: wantKind,
      port: o.port != null ? o.port : before.ports[0],
      listenerName: before.name,
      router: one(o.router || o.httpRouter || o.httpRouterId) || before.routerId,
      certificate: one(o.certificate || o.certificateId) || before.certificateIds[0],
      backendGroup: one(o.backendGroup || o.backendGroupId) || before.backendGroupId,
      address: one(o.address || o.staticAddress) || before.addresses[0],
      httpToHttps: o.httpToHttps != null ? o.httpToHttps === true : before.httpToHttps,
      sni: givenSni != null ? givenSni : keepSni.length ? keepSni : null,
    });

    const mask = ["name", "endpoint_specs", KIND_FIELD[L.kind]];
    if (kindInput(before.kind) && kindInput(before.kind) !== L.kind) mask.push(KIND_FIELD[kindInput(before.kind)]);
    const body = { updateMask: mask.join(","), listenerSpec: L.listenerSpec };
    const j = await alb(oauthToken, "POST", ALB_BASE + "/loadBalancers/" + encodeURIComponent(lb.id) + ":updateListener", body, 40000);
    await run(oauthToken, j, 240000);

    // Правка обязана подтвердиться ПЕРЕЧИТЫВАНИЕМ: облако может ответить
    // «сделано» и ничего не сделать (права, отброшенное значение).
    const after = await loadBalancer(oauthToken, lb.id).catch(() => null);
    const now = after || lb;
    const got = (now.listeners || []).find((x) => x.name === before.name) || null;
    const wantSni = L.sni.map((h) => h.serverNames.join(",")).sort().join("|");
    const bad = [];
    if (!got) bad.push("слушателя «" + before.name + "» у балансировщика больше нет");
    else {
      if (got.kind !== KIND_FIELD[L.kind]) bad.push("вид (" + got.kindHuman + ")");
      if (one(got.ports.join(",")) !== one(String(L.port))) bad.push("порт (" + (got.ports.join(",") || "не назван") + ")");
      if (L.routerId && got.routerId !== L.routerId) bad.push("роутер (" + (got.routerId || "не назван") + ")");
      if (L.backendGroupId && got.backendGroupId !== L.backendGroupId) bad.push("группа бэкендов (" + (got.backendGroupId || "не названа") + ")");
      if (L.certificateId && got.certificateIds.indexOf(L.certificateId) < 0) bad.push("сертификат (" + (got.certificateIds.join(", ") || "не назван") + ")");
      const gotSni = (got.sni || []).map((h) => h.serverNames.join(",")).sort().join("|");
      if (wantSni !== gotSni) bad.push("SNI-домены (" + (gotSni || "их нет") + ")");
    }
    if (bad.length) {
      throw new Error("Правка слушателя «" + before.name + "» не применилась: " + bad.join(", ") + ". Нужна роль alb.editor (или admin) — проверь права и повтори.");
    }

    const warnings = [];
    const newAddress = (got && got.addresses[0]) || "";
    if (before.addresses[0] && newAddress && before.addresses[0] !== newAddress) {
      warnings.push(
        "Адрес слушателя изменился: " + before.addresses[0] + " → " + newAddress + ". Домены, которые смотрели на прежний адрес, надо перевести на новый (ycDns) — иначе вход открывается по старому адресу."
      );
    }
    if (kindInput(before.kind) && kindInput(before.kind) !== L.kind) {
      warnings.push(
        "Вид слушателя заменён целиком (" + before.kindHuman + " → " + L.kindHuman + "): настройки, которых мы не задаём (HTTP/2, перенаправление, проверка клиентских сертификатов), вернулись к значениям по умолчанию."
      );
    }
    if (one(before.ports.join(",")) !== one(String(L.port))) {
      warnings.push("Порт слушателя: " + (before.ports.join(",") || "—") + " → " + L.port + ". Новый порт должен быть открыт в группах безопасности балансировщика, а старый — закрыт (ycVpc).");
    }
    if (L.kind === "https") {
      warnings.push("Сертификат должен оставаться выпущенным: когда он истечёт, HTTPS перестанет отвечать — карточка показывает срок, а новый сертификат выпускают заранее.");
    }
    const beforeSni = (before.sni || []).map((h) => h.serverNames.join(",")).sort().join("|");
    // О доменах говорим ТОЛЬКО когда они меняются: иначе предупреждение стояло бы
    // и у правки одного порта, где домены никто не трогал.
    if (wantSni !== beforeSni) {
      if (L.sni.length) {
        warnings.push("SNI-обработчики заменяются ЦЕЛИКОМ: домены, которых нет в списке, убираются вместе со своими сертификатами; у каждого обработчика максимум ОДИН сертификат.");
      } else {
        warnings.push("Домены SNI убраны: " + before.sni.map((h) => h.serverNames.join(", ")).filter(Boolean).join(" | ") + " — эти домены слушатель больше не обслуживает, им достанется основной сертификат.");
      }
    }

    const what = [];
    if (one(before.ports.join(",")) !== one(String(L.port))) what.push("порт " + L.port);
    if (kindInput(before.kind) !== L.kind) what.push("вид " + L.kindHuman);
    if (L.routerId && L.routerId !== before.routerId) what.push("роутер " + L.routerId);
    if (L.backendGroupId && L.backendGroupId !== before.backendGroupId) what.push("группа бэкендов " + L.backendGroupId);
    if (L.certificateId && before.certificateIds.indexOf(L.certificateId) < 0) what.push("сертификат " + L.certificateId);
    if (wantSni !== beforeSni) what.push("домены SNI: " + (L.sni.map((h) => h.serverNames.join(", ")).join(" | ") || "убраны"));

    return {
      changed: true,
      lb: now,
      listener: got,
      listenerName: before.name,
      listenerSpec: L.listenerSpec,
      fields: mask,
      sni: L.sni,
      operationId: one(j && j.id),
      message:
        "Слушатель «" + before.name + "» балансировщика «" + now.name + "» обновляется" +
        (what.length ? ": " + what.join(", ") : " (настройки применены заново)") + ".",
      warnings: warnings,
    };
  }

  // ── Правка роутера и группы бэкендов ──────────────────────────────────────
  // У обоих вложенные списки ЗАМЕНЯЮТСЯ ЦЕЛИКОМ: virtualHosts[] (вместе с
  // routes[]) у роутера и backends[] у группы. Отдельного «поменять порт» или
  // «поменять путь» у облака нет вовсе, поэтому правка идёт по схеме «прочитал —
  // изменил — записал»: облако отдаёт текущий список, модуль меняет в нём ОДНО
  // место и возвращает ВЕСЬ список обратно с маской (для роутера virtual_hosts,
  // для группы — имя её вида). Иначе правка одного порта стёрла бы соседние
  // бэкенды и маршруты. Служебные поля (id, status) обратно не уходят: на них
  // сервис отвечает отказом — тот же урок, что у правил групп безопасности.
  async function updateHttpRouter(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const ref = one(o.router || o.id || o.name);
    const found = await findHttpRouter(oauthToken, folderId, ref);
    if (!found) {
      const list = await httpRouters(oauthToken, folderId);
      throw new Error(
        "Не нашёл HTTP-роутер «" + ref + "»." +
          (list.length ? " В каталоге: " + list.map((r) => r.name).join(", ") + "." : " Роутеров нет — создай: действие routernew.")
      );
    }
    const raw = await alb(oauthToken, "GET", ALB_BASE + "/httpRouters/" + encodeURIComponent(found.id), undefined, 25000);
    const hosts = (raw && raw.virtualHosts) || [];

    const newName = one(o.newName || o.rename);
    if (newName) checkName(newName, "HTTP-роутера");
    const descriptionGiven = o.description != null && one(o.description) !== "";
    const vhostRef = one(o.vhost || o.virtualHost);
    const hostGiven = o.host != null ? one(o.host) : null;
    const routeRef = one(o.routeName || o.route);
    const pathPrefixGiven = o.pathPrefix != null || o.prefix != null;
    const pathPrefix = one(o.pathPrefix || o.prefix);
    const pathExact = one(o.pathExact);
    const bgRef = one(o.backendGroup || o.backendGroupId);
    const routeEdit = vhostRef !== "" || hostGiven != null || routeRef !== "" || pathPrefixGiven || pathExact !== "" || bgRef !== "";

    if (!newName && !descriptionGiven && !routeEdit) {
      throw new Error(
        "Нечего менять: назови newName (имя роутера), description или правку маршрута — pathPrefix/pathExact (путь), backendGroup (куда ведёт), host (домен виртуального хоста)."
      );
    }

    const warnings = [];
    const what = [];
    let vhost = null;
    let route = null;
    if (routeEdit) {
      if (!hosts.length) {
        throw new Error(
          "У роутера «" + found.name + "» нет ни одного виртуального хоста: маршрутов тоже нет, и править нечего. Сначала создай роутер с маршрутом (routernew) — облако не даёт роутеру без хостов."
        );
      }
      if (vhostRef) {
        vhost = hosts.find((h) => one(h && h.name) === vhostRef) || null;
        if (!vhost) {
          throw new Error(
            "У роутера «" + found.name + "» нет виртуального хоста «" + vhostRef + "». Что есть: " + hosts.map((h) => one(h && h.name)).filter(Boolean).join(", ") + "."
          );
        }
      } else if (hosts.length === 1) {
        vhost = hosts[0];
      } else {
        throw new Error(
          "У роутера «" + found.name + "» несколько виртуальных хостов: назови vhost (имя хоста-виртуального сервера), чтобы было понятно, чей маршрут правим. Что есть: " +
            hosts.map((h) => one(h && h.name) + (h && h.authority && h.authority.length ? " (" + h.authority.join(", ") + ")" : "")).join(", ") + "."
        );
      }

      const routes = (vhost && vhost.routes) || [];
      if (routeRef) {
        route = routes.find((rt) => one(rt && rt.name) === routeRef) || null;
        if (!route) {
          throw new Error(
            "В хосте «" + one(vhost && vhost.name) + "» роутера «" + found.name + "» нет маршрута «" + routeRef + "»." +
              (routes.length ? " Что есть: " + routes.map((rt) => one(rt && rt.name)).join(", ") + "." : " Маршрутов нет вовсе.") +
              " Новый маршрут здесь не создаётся: облако принимает список хостов только заменой — создай роутер с нужным маршрутом (routernew)."
          );
        }
      } else if (routes.length === 1) {
        route = routes[0];
      } else {
        throw new Error(
          "В хосте «" + one(vhost && vhost.name) + "» " + routes.length + " маршрута(ов): назови route (имя маршрута)." +
            (routes.length ? " Что есть: " + routes.map((rt) => one(rt && rt.name)).join(", ") + "." : "")
        );
      }

      // Маршрут правим только HTTP: gRPC-маршрут устроен иначе (fqmn вместо пути).
      if (!route.http) {
        throw new Error(
          "Маршрут «" + one(route.name) + "» — " + (route.grpc ? "gRPC" : "без вида (http/grpc не назван)") + ": путь и точное совпадение у него задаются полем fqmn, а не path. Править такой маршрут здесь нельзя."
        );
      }
      route.http.match = route.http.match || {};
      if (pathExact) {
        if (route.http.match.path && route.http.match.path.exactMatch !== pathExact) {
          route.http.match.path = { exactMatch: pathExact };
          what.push("точный путь " + pathExact);
        }
      } else if (pathPrefixGiven) {
        if (!pathPrefix) throw new Error("Пустой pathPrefix: путь не может быть пустым — общий путь это «/».");
        if (pathPrefix.charAt(0) !== "/") throw new Error("Путь «" + pathPrefix + "» облако не примет: он должен начинаться со слэша, например /api.");
        if (!route.http.match.path || route.http.match.path.prefixMatch !== pathPrefix) {
          route.http.match.path = { prefixMatch: pathPrefix };
          what.push("путь " + pathPrefix + "*");
        }
      }
      if (bgRef) {
        const bg = await findBackendGroup(oauthToken, folderId, bgRef);
        if (!bg) {
          const list = await backendGroups(oauthToken, folderId);
          throw new Error(
            "Не нашёл группу бэкендов «" + bgRef + "» для маршрута." +
              (list.length ? " В каталоге: " + list.map((b) => b.name).join(", ") + "." : " Групп бэкендов нет — создай: действие backnew.")
          );
        }
        if (bg.kind && bg.kind !== "http") {
          throw new Error(
            "Группа бэкендов «" + bg.name + "» — " + bg.kindHuman + ", а HTTP-маршрут ведёт только в HTTP-группу: облако такой роутер не примет."
          );
        }
        route.http.route = route.http.route || {};
        if (route.http.route.backendGroupId !== bg.id) {
          route.http.route.backendGroupId = bg.id;
          what.push("группа бэкендов «" + bg.name + "»");
        }
      }
      if (hostGiven != null) {
        const authority = hostGiven ? hostGiven.split(",").map((x) => one(x)).filter(Boolean) : [];
        const nowAuthority = (vhost.authority || []).join(",");
        if (authority.join(",") !== nowAuthority) {
          vhost.authority = authority;
          what.push(authority.length ? "домен " + authority.join(", ") : "домен убран (хост отвечает на любой)");
        }
      }
    }

    const mask = [];
    if (newName && newName !== found.name) mask.push("name");
    if (descriptionGiven) mask.push("description");
    if (routeEdit && what.length) mask.push("virtual_hosts");
    if (!mask.length) {
      return { changed: false, router: await httpRouters(oauthToken, folderId).then((rs) => rs.find((r) => r.id === found.id) || found), fields: [], message: "У роутера «" + found.name + "» всё уже так, как просят: менять нечего.", warnings: [] };
    }

    const body = { updateMask: mask.join(",") };
    // Список хостов уходит ТОЛЬКО когда его правят: лишнее поле в теле — это
    // повод перечитать ответ облака дважды и поверить не в то.
    if (mask.indexOf("virtual_hosts") >= 0) body.virtualHosts = writableDeep(hosts);
    if (mask.indexOf("name") >= 0) body.name = newName;
    if (mask.indexOf("description") >= 0) body.description = one(o.description);
    const j = await alb(oauthToken, "PATCH", ALB_BASE + "/httpRouters/" + encodeURIComponent(found.id), body, 40000);
    await run(oauthToken, j, 240000);

    // Правка обязана подтвердиться ПЕРЕЧИТЫВАНИЕМ: облако может ответить
    // «сделано» и ничего не сделать (права, отброшенное значение).
    const afterRaw = await alb(oauthToken, "GET", ALB_BASE + "/httpRouters/" + encodeURIComponent(found.id), undefined, 25000).catch(() => null);
    const bad = [];
    if (afterRaw && mask.indexOf("name") >= 0 && one(afterRaw.name) !== newName) bad.push("имя (" + (one(afterRaw.name) || "не названо") + ")");
    if (afterRaw && routeEdit && what.length) {
      const hv = ((afterRaw.virtualHosts) || []).find((h) => one(h && h.name) === one(vhost && vhost.name)) || null;
      const rr = hv ? ((hv.routes) || []).find((rt) => one(rt && rt.name) === one(route && route.name)) || null : null;
      if (!rr) bad.push("маршрут «" + one(route && route.name) + "»");
      else {
        const p = (rr.http && rr.http.match && rr.http.match.path) || {};
        if (pathExact && p.exactMatch !== pathExact) bad.push("точный путь");
        if (pathPrefixGiven && !pathExact && p.prefixMatch !== pathPrefix) bad.push("путь");
        if (bgRef && one(rr.http && rr.http.route && rr.http.route.backendGroupId) !== one(route.http && route.http.route && route.http.route.backendGroupId)) bad.push("группа бэкендов маршрута");
        if (hostGiven != null && (hv.authority || []).join(",") !== (vhost.authority || []).join(",")) bad.push("домен хоста");
      }
    }
    if (bad.length) {
      throw new Error("Правка роутера «" + found.name + "» не применилась: " + bad.join(", ") + ". Нужна роль alb.editor (или admin) — проверь права и повтори.");
    }

    if (mask.indexOf("virtual_hosts") >= 0) {
      warnings.push(
        "Список виртуальных хостов уходит ЦЕЛИКОМ: облако принимает его только заменой, поэтому остальные маршруты и хосты вернулись в том виде, как их отдало облако."
      );
      warnings.push(
        "Порядок маршрутов важен: облако берёт ПЕРВОЕ совпавшее правило, поэтому общий путь (/) должен стоять НИЖЕ частных."
      );
      warnings.push(
        "Роутер не пересоздать, пока на него смотрит слушатель: правку увидят СРАЗУ все слушатели, которые на него смотрят (HTTP и HTTPS)."
      );
    }
    if (mask.indexOf("name") >= 0) {
      warnings.push("Имя роутера обязано быть уникальным в каталоге: «" + newName + "» занято — облако откажет. Слушатели ссылаются на роутер ПО id, поэтому переименование вход не закроет.");
    }
    const after = afterRaw ? routerInfo(afterRaw) : (await httpRouters(oauthToken, folderId).catch(() => [])).find((r) => r.id === found.id) || found;
    return {
      changed: true,
      router: after,
      routerId: found.id,
      fields: mask,
      operationId: one(j && j.id),
      message:
        "HTTP-роутер «" + found.name + "» обновляется" +
        (newName && newName !== found.name ? ", новое имя «" + newName + "»" : "") +
        (what.length ? ": " + what.join(", ") : " (настройки применены заново)") + ".",
      warnings: warnings,
    };
  }

  // ── Правка группы бэкендов ────────────────────────────────────────────────
  // Именно здесь живут ПОРТ, который слушают ЦЕЛИ, и ПРОВЕРКИ ЗДОРОВЬЯ, по
  // которым облако решает, пускать ли машину в ротацию. Отдельного метода
  // «поменять порт» у облака нет: список бэкендов меняется ТОЛЬКО целиком, а
  // значит правка — это «прочитал — изменил — записал». Маска при этом называет
  // имя вида (http/stream/grpc), а не поле внутри бэкенда.
  async function updateBackendGroup(oauthToken, opts) {
    const o = opts || {};
    const folderId = checkFolder(o.folderId);
    const ref = one(o.group || o.backendGroup || o.id || o.name);
    const found = await findBackendGroup(oauthToken, folderId, ref);
    if (!found) {
      const list = await backendGroups(oauthToken, folderId);
      throw new Error(
        "Не нашёл группу бэкендов «" + ref + "»." +
          (list.length ? " В каталоге: " + list.map((b) => b.name).join(", ") + "." : " Групп бэкендов нет — создай: действие backnew.")
      );
    }
    const bg = found.kind ? found : await backendGroup(oauthToken, found.id);
    const kind = bg.kind;
    if (!kind) {
      throw new Error("У группы бэкендов «" + bg.name + "» не назван вид (http/stream/grpc): без него непонятно, какой список бэкендов править.");
    }
    const raw = await alb(oauthToken, "GET", ALB_BASE + "/backendGroups/" + encodeURIComponent(bg.id), undefined, 25000);
    const block = writableDeep((raw && raw[kind]) || {});
    const backends = block.backends || [];

    const newName = one(o.newName || o.rename);
    if (newName) checkName(newName, "группы бэкендов");
    const descriptionGiven = o.description != null && one(o.description) !== "";
    const backendRef = one(o.backend || o.backendName);
    const portGiven = o.port != null && String(o.port).trim() !== "";
    const port = portGiven ? checkPort(o.port) : null;
    const healthPath = one(o.healthPath || o.healthCheckPath);
    const healthService = one(o.healthService);
    const dropHealth = o.noHealthCheck === true || o.dropHealthCheck === true;
    const tgRef = one(o.targetGroup || o.targetGroupId);

    if (healthPath && healthService) throw new Error("Назови что-то ОДНО: healthPath — проверка HTTP, healthService — проверка gRPC.");
    if (healthPath && kind !== "http") throw new Error("healthPath — это проверка HTTP (GET по пути), а группа «" + bg.name + "» вида " + bg.kindHuman + ". Для gRPC-группы проверка задаётся healthService.");
    if (healthService && kind !== "grpc") throw new Error("healthService — это проверка gRPC, а группа «" + bg.name + "» вида " + bg.kindHuman + ". Для HTTP-группы проверка задаётся healthPath.");
    if ((healthPath || healthService) && dropHealth) throw new Error("Нельзя одновременно задать проверку здоровья и убрать её: или healthPath/healthService, или noHealthCheck.");
    if (!newName && !descriptionGiven && !portGiven && !healthPath && !healthService && !dropHealth && !tgRef) {
      throw new Error(
        "Нечего менять: назови newName (имя группы), description, port (порт, который слушают ЦЕЛИ), healthPath/healthService (проверка здоровья), targetGroup или noHealthCheck (убрать проверки)."
      );
    }

    const needBackends = portGiven || healthPath || healthService || dropHealth || !!tgRef;
    if (needBackends && !backends.length) {
      throw new Error(
        "У группы бэкендов «" + bg.name + "» нет ни одного бэкенда: порт и проверки живут В бэкенде, а не в группе. Такую группу правят созданием заново (backnew)."
      );
    }

    let tg = null;
    if (tgRef) {
      tg = await findTargetGroup(oauthToken, folderId, tgRef);
      if (!tg) {
        const list = await targetGroups(oauthToken, folderId);
        throw new Error(
          "Не нашёл группу целей «" + tgRef + "»." +
            (list.length ? " В каталоге: " + list.map((g) => g.name).join(", ") + "." : " Групп целей нет — создай: действие targetnew.")
        );
      }
    }

    const targets = backendRef ? backends.filter((b) => one(b && b.name) === backendRef) : backends;
    if (backendRef && !targets.length) {
      throw new Error(
        "В группе бэкендов «" + bg.name + "» нет бэкенда «" + backendRef + "». Что есть: " + backends.map((b) => one(b && b.name)).filter(Boolean).join(", ") + "."
      );
    }

    const what = [];
    targets.forEach((b) => {
      if (portGiven && one(b.port) !== String(port)) {
        b.port = String(port);
        what.push((backendRef ? "бэкенд «" + one(b.name) + "»: " : "") + "порт " + port);
      }
      if (tgRef) {
        const ids = (b.targetGroups && b.targetGroups.targetGroupIds) || [];
        if (ids.length !== 1 || one(ids[0]) !== tg.id) {
          b.targetGroups = { targetGroupIds: [tg.id] };
          what.push("группа целей «" + tg.name + "»");
        }
      }
      if (dropHealth && (b.healthchecks || []).length) {
        delete b.healthchecks;
        what.push("проверки здоровья убраны");
      }
      if (healthPath) {
        const checks = [{ timeout: HEALTH_TIMEOUT, interval: HEALTH_INTERVAL, healthyThreshold: HEALTH_THRESHOLD, unhealthyThreshold: HEALTH_THRESHOLD, http: { path: healthPath } }];
        if (JSON.stringify(b.healthchecks || []) !== JSON.stringify(checks)) {
          b.healthchecks = checks;
          what.push("проверка здоровья HTTP " + healthPath);
        }
      }
      if (healthService) {
        const checks = [{ timeout: HEALTH_TIMEOUT, interval: HEALTH_INTERVAL, healthyThreshold: HEALTH_THRESHOLD, unhealthyThreshold: HEALTH_THRESHOLD, grpc: { serviceName: healthService } }];
        if (JSON.stringify(b.healthchecks || []) !== JSON.stringify(checks)) {
          b.healthchecks = checks;
          what.push("проверка здоровья gRPC " + healthService);
        }
      }
    });

    const mask = [];
    if (newName && newName !== bg.name) mask.push("name");
    if (descriptionGiven) mask.push("description");
    if (what.length) mask.push(kind);
    if (!mask.length) {
      return { changed: false, group: bg, fields: [], message: "У группы бэкендов «" + bg.name + "» всё уже так, как просят: менять нечего.", warnings: [] };
    }
    block.backends = backends;
    const body = { updateMask: mask.join(",") };
    if (mask.indexOf("name") >= 0) body.name = newName;
    if (mask.indexOf("description") >= 0) body.description = one(o.description);
    if (mask.indexOf(kind) >= 0) body[kind] = block;
    const j = await alb(oauthToken, "PATCH", ALB_BASE + "/backendGroups/" + encodeURIComponent(bg.id), body, 40000);
    await run(oauthToken, j, 240000);

    // Подтверждаем ПЕРЕЧИТЫВАНИЕМ: «облако промолчало» — это ошибка со словами
    // про роль alb.editor, а не успех.
    const after = await backendGroup(oauthToken, bg.id).catch(() => null);
    const bad = [];
    if (after && mask.indexOf("name") >= 0 && after.name !== newName) bad.push("имя (" + (after.name || "не названо") + ")");
    if (after && what.length) {
      if (after.backendCount !== backends.length) bad.push("состав бэкендов (" + after.backendCount + ")");
      const byName = {};
      after.backends.forEach((b) => { byName[b.name] = b; });
      targets.forEach((b) => {
        const got = byName[one(b.name)];
        if (!got) { bad.push("бэкенд «" + one(b.name) + "»"); return; }
        if (portGiven && one(got.port) !== String(port)) bad.push("порт бэкенда «" + one(b.name) + "» (" + (got.port || "не назван") + ")");
        if (tgRef && got.targetGroupIds.join(",") !== tg.id) bad.push("группа целей бэкенда «" + one(b.name) + "»");
        const wantChecks = healthPath || healthService ? 1 : 0;
        if ((healthPath || healthService || dropHealth) && got.healthcheckCount !== wantChecks) bad.push("проверки здоровья бэкенда «" + one(b.name) + "» (" + got.healthcheckCount + ")");
      });
    }
    if (bad.length) {
      throw new Error("Правка группы бэкендов «" + bg.name + "» не применилась: " + bad.join(", ") + ". Нужна роль alb.editor (или admin) — проверь права и повтори.");
    }

    const warnings = [];
    if (mask.indexOf(kind) >= 0) {
      warnings.push(
        "Список бэкендов уходит ЦЕЛИКОМ: облако принимает его только заменой, поэтому остальные бэкенды и настройки сессий вернулись в том виде, как их отдало облако."
      );
    }
    if (portGiven) {
      warnings.push(
        "Порт " + port + " — это порт, который слушают ЦЕЛИ (машины), а не балансировщик: если там слушают другой порт, вход начнёт отдавать 502. Порт слушателя при этом не меняется."
      );
    }
    if (dropHealth) {
      warnings.push("Проверок здоровья больше нет: облако будет считать цель здоровой ВСЕГДА — упавшая машина останется в ротации.");
    }
    if (tgRef) {
      warnings.push("Новая группа целей должна содержать те же машины и подсети, иначе трафик уйдёт в пустоту: состав целей смотрят действием targets.");
    }
    if (mask.indexOf("name") >= 0) {
      warnings.push("Имя группы бэкендов обязано быть уникальным в каталоге, а маршруты и слушатели ссылаются на неё ПО id — переименование вход не закроет.");
    }

    return {
      changed: true,
      group: after || bg,
      groupId: bg.id,
      fields: mask,
      operationId: one(j && j.id),
      message:
        "Группа бэкендов «" + bg.name + "» обновляется" +
        (newName && newName !== bg.name ? ", новое имя «" + newName + "»" : "") +
        (what.length ? ": " + what.join(", ") : " (настройки применены заново)") + ".",
      warnings: warnings,
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
    createBackendGroup: createBackendGroup,
    removeBackendGroup: removeBackendGroup,
    targetStates: targetStates,
    createLoadBalancer: createLoadBalancer,
    addListener: addListener,
    removeListener: removeListener,
    updateListener: updateListener,
    updateLoadBalancer: updateLoadBalancer,
    updateHttpRouter: updateHttpRouter,
    updateBackendGroup: updateBackendGroup,
    certificates: certificates,
    findCertificate: findCertificate,
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
    backendGroupLine: backendGroupLine,
    targetStateLine: targetStateLine,
    statusHuman: statusHuman,
    targetStatusHuman: targetStatusHuman,
    certStatusHuman: certStatusHuman,
    certLine: certLine,
  };
}

module.exports = {
  createYcAlb: createYcAlb,
  ALB_HOST: ALB_HOST,
  ALB_BASE: ALB_BASE,
  PORT_DEFAULT: PORT_DEFAULT,
  statusHuman: statusHuman,
  targetStatusHuman: targetStatusHuman,
  certStatusHuman: certStatusHuman,
  certLine: certLine,
  kindInput: kindInput,
  lbInfo: lbInfo,
  tgInfo: tgInfo,
  routerInfo: routerInfo,
  lbLine: lbLine,
  listenerLine: listenerLine,
  targetLine: targetLine,
  tgLine: tgLine,
  routerLine: routerLine,
  backendGroupInfo: backendGroupInfo,
  backendGroupLine: backendGroupLine,
  targetStateInfo: targetStateInfo,
  targetStateLine: targetStateLine,
  sniNameFor: sniNameFor,
  parseSniHandlers: parseSniHandlers,
  LB_FIELD_RU: LB_FIELD_RU,
  ROUTER_FIELD_RU: ROUTER_FIELD_RU,
  GROUP_FIELD_RU: GROUP_FIELD_RU,
  writableDeep: writableDeep,
};

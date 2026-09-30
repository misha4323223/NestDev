"use strict";

/* ── Application Load Balancer ────────────────────────────────────────────────
   Запуск: node test/yc-alb.test.js   (входит в общий `npm test`)

   Зачем набор. Машины, группы машин и базы у приложения были, а ВХОДА в них с
   улицы — нет: без балансировщика сайт живёт на одном адресе одной машины, а
   сертификат (ycCdn умеет его выпустить) некуда повесить. Балансировщик — это
   ЧЕТЫРЕ связанных ресурса, и путать их нельзя:

     • группа целей — САМ СПИСОК МАШИН (адрес и подсеть, и только они: ни
       порта, ни пути, ни проверок здоровья в ней нет). Состав меняют отдельными
       операциями addTargets/removeTargets — «изменить» здесь отсутствует;
     • HTTP-роутер — правила «домен и путь → группа бэкендов». Про машины он не
       знает вовсе;
     • балансировщик — адреса, зоны и СЛУШАТЕЛИ: HTTP на порт, HTTPS с
       сертификатом или поток TCP. Слушатель ссылается ЛИБО на роутер, ЛИБО на
       группу бэкендов, и смешивать HTTP с TCP в одном TLS-слушателе нельзя;
     • группа бэкендов — куда ведут маршруты: здесь живут ПОРТ целей и проверки
       здоровья, поэтому роутер обязан ссылаться на СУЩЕСТВУЮЩУЮ группу, а
       занятую группу облако удалять отклонит — модуль называет виновных ДО сети;
     • здоровье цели (здорова/не отвечает) отдаёт отдельный метод облака, и оно
       приходит ПО ЗОНАМ (status.zoneStatuses): спрашивают его у пары «группа
       бэкендов + группа целей», а пару ищут у балансировщика.

   Что здесь проверяется прежде всего (и почему):
     • АДРЕС БАЛАНСИРОВЩИКА — ЭТО АДРЕСА ЕГО СЛУШАТЕЛЕЙ. В ответе облака
       адреса лежат по другим именам, чем в запросе (listeners[].endpoints[].
       addresses[].externalIpv4Address против listenerSpecs[].endpointSpecs[].
       addressSpecs[].externalIpv4AddressSpec): модуль читает ОТВЕТ, и без этого
       «адрес выдаст облако» показывалось бы всегда;
     • БАЛАНСИРОВЩИК ПЛАТНЫЙ (ресурсные единицы и сам ресурс за час, даже без
       трафика): создание требует согласия и называет слушателя и порт ДО
       запроса; удаление необратимо и забирает слушатели с адресами;
     • HTTPS-СЛУШАТЕЛЬ БЕЗ ВЫПУЩЕННОГО СЕРТИФИКАТА НЕ ВСТАНЕТ: сертификат
       ищется в Certificate Manager и обязан быть в состоянии Issued — иначе
       отказ ДО сети; а карточка читает сертификат дальше: домены и СРОК —
       «сайт не открывается» часто значит «сертификат истекает»;
     • СОСТАВ СЛУШАТЕЛЕЙ МЕНЯЮТ ТОЧЕЧНО (addListener / updateListener /
       removeListener): PATCH с listenerSpecs[] стёр бы всех, кого нет в списке,
       поэтому добавление, правка и удаление идут по одному, а перечитывание
       подтверждает, что облако правда изменило состав (иначе «принял, но не
       сделал» выглядело бы успехом);
     • ПРАВКА СЛУШАТЕЛЯ НЕ ПЕРЕБИРАЕТ ЕГО ЗАНОВО: updateListener опознаёт
       слушателя ПО ИМЕНИ (переименовать нельзя), в маске перечислено только
       то, что задают (плюс СТАРЫЙ вид — иначе у слушателя оказалось бы два
       вида), а адрес, порт и роутер без просьбы берутся у самого слушателя:
       домены смотрят на адрес, и «продлить сертификат» — это одно поле;
     • SNI — ЭТО НЕСКОЛЬКО ДОМЕНОВ НА ОДНОМ СЛУШАТЕЛЕ: tls.sniHandlers[] со
       СВОИМ сертификатом у каждого домена (у TLS-обработчика максимум один);
       домен обязан быть у РОВНО одного обработчика, только строчными буквами,
       а карточка читает и эти сертификаты — иначе домен отвечал бы чужим;
     • ГРУППЫ БЕЗОПАСНОСТИ ЗАМЕНЯЮТСЯ ЦЕЛИКОМ: правка балансировщика (lbupdate)
       уходит с МАСКОЙ полей — без маски облако сбросило бы всё, чего нет в теле;
       имя и описание меняются, а состав слушателей — отдельными действиями;
     • РОУТЕР БЕЗ ГРУППЫ БЭКЕНДОВ НЕ ИМЕЕТ СМЫСЛА: маршрут ведёт в
       backendGroupId, поэтому группа проверяется до запроса, а пустой список
       групп бэкендов объясняется словами, а не выдуманным id;
     • карточка находит группы целей ЧЕРЕЗ ГРУППУ БЭКЕНДОВ (у балансировщика и
       роутера ссылки на группу целей нет вовсе) — это единственный путь;
     • ОТКАЗЫ ДО СЕТИ: кривое имя, нет каталога, порт вне 1…65535, зона не та,
       что у подсети, нет подсети/роутера/сертификата/группы безопасности,
       защита от удаления не нужна (её у балансировщика нет вовсе), занятый
       балансировщик (идёт переход) — на всё это запрос уходить не должен;
     • проводка: канал yc:alb через НАСТОЯЩИЙ registerYcIpc, проброс в окно,
       семейство действий в yc-actions (платное и опасное помечены), плитка
       полки со знаком сервиса из библиотеки, связи консоли и согласованность
       со схемой инструмента, промптом, политикой прав, справочником и цепочкой
       npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE, как у остальных наборов облака). */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const albMod = require(path.join(ROOT, "src", "yc-alb.js"));
const { createYcAlb, lbInfo, tgInfo, routerInfo, lbLine, listenerLine, targetLine, tgLine, routerLine } = albMod;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const MAIN_SRC = read("src", "main.js");
const PRELOAD_SRC = read("src", "preload.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const PANEL_SRC = read("src", "renderer", "yc-panel.js");
const CONSOLE_SRC = read("src", "yc-console.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const POLICY_SRC = read("src", "tool-policy.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SMOKE_SRC = read("test", "smoke", "03-cloud.js");
const YANDEX_SRC = read("src", "yandex-cloud.js");
const PKG = JSON.parse(read("package.json"));
const LOGOS = require(path.join(ROOT, "src", "renderer", "yc-logos.js"));
const ycConsole = require(path.join(ROOT, "src", "yc-console.js"));

// ── Подменённое облако: балансировщики, группы целей, роутеры, бэкенды ──────
// Четыре балансировщика — и каждый здесь не для красоты: работающий с HTTP-
// слушателем и адресом (alb-web), остановленный с HTTPS-слушателем и
// сертификатом (alb-https), занятый переходом (alb-busy, у него ещё и
// слушателей нет) и работающий с потоком TCP (alb-stream). На них видно и
// разбор ответа, и отказы до сети, а состав слушателей, имя, описание и группы
// безопасности здесь МЕНЯЮТСЯ (:addListener, :removeListener, PATCH) — как в
// облаке, чтобы проверять правку настоящими запросами.
function startAlbStub() {
  const calls = [];
  const created = { lb: [], tg: [], router: [], targets: [], bg: [], listenerOps: [], lbPatches: [] };
  const deleted = new Set();
  // «Облако приняло, но не сделало» — так бывает при нехватке прав (alb.editor):
  // модуль обязан заметить это перечитыванием, а не показать успех.
  const flags = { dropAdd: false, dropRemove: false, dropUpdate: false, dropPatch: false };
  const status = { "alb-web": "ACTIVE", "alb-https": "STOPPED", "alb-busy": "CREATING", "alb-stream": "ACTIVE" };
  // Имя, описание и группы безопасности — изменяемые: правка (lbupdate) обязана
  // быть видна следующему чтению, иначе проверка «применилось ли» ничего не значит.
  const meta = {
    "alb-web": { name: "web-lb", description: "витрина", securityGroupIds: ["sg-1"] },
    "alb-https": { name: "https-lb", description: "", securityGroupIds: ["sg-1"] },
    "alb-busy": { name: "busy-lb", description: "", securityGroupIds: ["sg-1"] },
    "alb-stream": { name: "stream-lb", description: "", securityGroupIds: ["sg-1"] },
  };
  const listeners = {
    "alb-web": [
      {
        name: "web",
        endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.10" } }], ports: ["80"] }],
        http: { handler: { httpRouterId: "router-1" } },
      },
    ],
    "alb-https": [
      {
        name: "secure",
        endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.11" } }], ports: ["443"] }],
        tls: { defaultHandler: { httpHandler: { httpRouterId: "router-1" }, certificateIds: ["cert-1"] } },
      },
    ],
    "alb-busy": [],
    // Потоковый слушатель держит группу бэкендов «free-backends»: без такой
    // связи проверка «занятую группу не удаляют» не проверилась бы.
    "alb-stream": [
      {
        name: "tcp",
        endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.12" } }], ports: ["5432"] }],
        stream: { handler: { backendGroupId: "bg-free" } },
      },
      {
        // Сертификата «cert-gone» в каталоге нет: карточка обязана сказать об
        // этом словами — иначе «сайт не открывается» ищут вслепую. Роутер здесь
        // без маршрутов (router-2): иначе через этот слушатель нашлась бы ещё
        // одна группа бэкендов, и поиск пары «слушатель + группа» стал бы
        // неоднозначным — а это уже другой урок.
        name: "ghost",
        endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.13" } }], ports: ["444"] }],
        tls: { defaultHandler: { httpHandler: { httpRouterId: "router-2" }, certificateIds: ["cert-gone"] } },
      },
    ],
  };
  const lbBase = (id) => ({
    id: id,
    name: meta[id].name,
    folderId: "folder-1",
    description: meta[id].description,
    createdAt: "2026-08-02T10:00:00Z",
    status: status[id],
    listeners: listeners[id],
    allocationPolicy: { locations: [{ zoneId: "ru-central1-a", subnetId: "sub-1" }] },
    networkId: "net-1",
    regionId: "ru-central1",
    securityGroupIds: meta[id].securityGroupIds,
  });
  // Правка слушателя в облаке — это НОВЫЙ слушатель с тем же именем: в теле
  // приходит форма ЗАПРОСА (endpointSpecs/addressSpecs), а читается она потом в
  // форме ОТВЕТА (endpoints/addresses), как у настоящего облака.
  const endpointFromSpec = (e) => {
    const a = (e && (e.addressSpecs || [])[0]) || {};
    const ext = a.externalIpv4AddressSpec || a.internalIpv4AddressSpec || a.externalIpv6AddressSpec || {};
    return {
      addresses: [ext.address ? { externalIpv4Address: { address: ext.address } } : {}],
      ports: ((e && e.ports) || []).map(String),
    };
  };
  // Имена полей в маске и в ответе облака разные: endpoint_specs → endpoints.
  const MASK_FIELD = { name: "name", endpoints: "endpoint_specs", http: "http", tls: "tls", stream: "stream" };
  const groups = {
    "tg-web": {
      id: "tg-web",
      name: "web-targets",
      folderId: "folder-1",
      createdAt: "2026-08-02T09:00:00Z",
      targets: [
        { ipAddress: "10.10.0.5", subnetId: "sub-1" },
        { ipAddress: "10.10.0.6", subnetId: "sub-1" },
      ],
    },
    "tg-empty": { id: "tg-empty", name: "empty-targets", folderId: "folder-1", createdAt: "2026-08-02T09:30:00Z", targets: [] },
  };
  const routers = {
    "router-1": {
      id: "router-1",
      name: "main-router",
      folderId: "folder-1",
      createdAt: "2026-08-02T09:40:00Z",
      virtualHosts: [
        {
          name: "main",
          authority: ["site.example"],
          routes: [{ name: "main", http: { match: { path: { prefixMatch: "/" } }, route: { backendGroupId: "bg-web" } } }],
        },
      ],
    },
    "router-2": { id: "router-2", name: "api-router", folderId: "folder-1", createdAt: "2026-08-02T09:50:00Z", virtualHosts: [] },
  };

  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      const url = req.url || "";
      calls.push({ method: req.method, url: url, body: raw });
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json({ iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }
      if (url.indexOf("/operations/") >= 0) {
        const id = url.split("/").pop();
        if (id === "op-tg-new") return json({ id: id, done: true, metadata: { targetGroupId: "tg-new" } });
        if (id === "op-router-new") return json({ id: id, done: true, metadata: { httpRouterId: "router-new" } });
        if (id === "op-bg-new") return json({ id: id, done: true, metadata: { backendGroupId: "bg-new" } });
        if (id === "op-lb-new") return json({ id: id, done: true, metadata: { loadBalancerId: "alb-new" } });
        return json({ id: id, done: true });
      }

      // Сеть VPC и сертификаты: то, что модуль спрашивает ДО создания.
      if (url.indexOf("/vpc/v1/subnets") >= 0) {
        return json({
          subnets: [
            { id: "sub-1", name: "app-subnet", networkId: "net-1", zoneId: "ru-central1-a" },
            { id: "sub-2", name: "other-subnet", networkId: "net-1", zoneId: "ru-central1-b" },
          ],
        });
      }
      if (url.indexOf("/vpc/v1/securityGroups") >= 0) {
        return json({ securityGroups: [{ id: "sg-1", name: "web" }, { id: "sg-2", name: "ssh" }] });
      }
      if (url.indexOf("/certificate-manager/v1/certificates") >= 0) {
        // Сроки считаются ОТ СЕГОДНЯШНЕГО дня: у одного сертификата запас
        // большой, у другого — меньше месяца (карточка обязана предупредить).
        return json({
          certificates: [
            { id: "cert-1", name: "site-cert", status: "ISSUED", domains: ["site.example"], notAfter: new Date(Date.now() + 200 * 86400000).toISOString() },
            { id: "cert-2", name: "old-cert", status: "VALIDATING" },
            { id: "cert-3", name: "soon-cert", status: "ISSUED", domains: ["soon.example"], notAfter: new Date(Date.now() + 20 * 86400000).toISOString() },
            // Два сертификата на один слушатель — это SNI: у каждого домена свой.
            { id: "cert-4", name: "shop-cert", status: "ISSUED", domains: ["shop.example.com"], notAfter: new Date(Date.now() + 150 * 86400000).toISOString() },
            { id: "cert-5", name: "fresh-cert", status: "ISSUED", domains: ["site.example"], notAfter: new Date(Date.now() + 360 * 86400000).toISOString() },
          ],
        });
      }

      // Здоровье целей: у пути свой обработчик, и он стоит ДО балансировщиков —
      // иначе список балансировщиков перехватил бы /loadBalancers/…/targetStates/….
      if (url.indexOf("/targetStates/") >= 0 && req.method === "GET") {
        // Здоровье приходит ПО ЗОНАМ (status.zoneStatuses) — как в облаке.
        if (/\/tg-empty$/.test(url)) return json({ targetStates: [] });
        return json({
          targetStates: [
            { status: { zoneStatuses: [{ zoneId: "ru-central1-a", status: "HEALTHY" }] }, target: { ipAddress: "10.10.0.5", subnetId: "sub-1" } },
            {
              status: { zoneStatuses: [{ zoneId: "ru-central1-a", status: "TIMEOUT" }, { zoneId: "ru-central1-b", status: "UNHEALTHY", failedActiveHc: true }] },
              target: { ipAddress: "10.10.0.6" },
            },
          ],
        });
      }

      // ── Балансировщики ──
      if (url.indexOf("/apploadbalancer/v1/loadBalancers") === 0) {
        if (req.method === "POST" && /\/loadBalancers(\?|$)/.test(url)) {
          created.lb.push(JSON.parse(raw || "{}"));
          return json({ id: "op-lb-new", done: false });
        }
        const listener = url.match(/\/loadBalancers\/([^/:?]+):(addListener|removeListener|updateListener)/);
        if (listener && req.method === "POST") {
          const body = JSON.parse(raw || "{}");
          created.listenerOps.push({ action: listener[2], lb: listener[1], body: body });
          if (listener[2] === "addListener" && !flags.dropAdd) listeners[listener[1]].push(body.listenerSpec || {});
          if (listener[2] === "removeListener" && !flags.dropRemove) {
            listeners[listener[1]] = (listeners[listener[1]] || []).filter((x) => x.name !== (body.name || ""));
          }
          if (listener[2] === "updateListener" && !flags.dropUpdate) {
            const spec = body.listenerSpec || {};
            const fields = String(body.updateMask || "").split(",").map((x) => x.trim());
            const list = listeners[listener[1]] || [];
            const at = list.findIndex((x) => x.name === spec.name);
            if (at >= 0) {
              const before = list[at];
              const next = {};
              // Маска: названное берётся из тела, НЕназванное остаётся прежним, а
              // поле, названное в маске и не присланное, сбрасывается — именно
              // так облако и обещает (именно поэтому смена вида работает).
              for (const key of ["name", "endpoints", "http", "tls", "stream"]) {
                if (fields.indexOf(MASK_FIELD[key]) < 0) {
                  if (before[key] !== undefined) next[key] = before[key];
                  continue;
                }
                const given = key === "endpoints" ? spec.endpointSpecs : spec[key];
                if (given === undefined) continue;
                next[key] = key === "endpoints" ? (spec.endpointSpecs || []).map(endpointFromSpec) : given;
              }
              list[at] = next;
            }
          }
          return json({ id: "op-listener", done: false });
        }
        const patch = url.match(/\/loadBalancers\/([^/?]+)$/);
        if (patch && req.method === "PATCH") {
          const body = JSON.parse(raw || "{}");
          created.lbPatches.push({ lb: patch[1], body: body });
          if (!flags.dropPatch) {
            const m = meta[patch[1]];
            const fields = String(body.updateMask || "").split(",").map((x) => x.trim());
            if (fields.indexOf("name") >= 0) m.name = body.name;
            if (fields.indexOf("description") >= 0) m.description = body.description || "";
            if (fields.indexOf("security_group_ids") >= 0) m.securityGroupIds = body.securityGroupIds || [];
          }
          return json({ id: "op-lb-patch", done: false });
        }
        const power = url.match(/\/loadBalancers\/([^/:?]+):(start|stop)/);
        if (power && req.method === "POST") {
          status[power[1]] = power[2] === "start" ? "ACTIVE" : "STOPPED";
          return json({ id: "op-power", done: false });
        }
        const del = url.match(/\/loadBalancers\/([^/?]+)$/);
        if (del && req.method === "DELETE") {
          deleted.add(del[1]);
          return json({ id: "op-del", done: false });
        }
        const one = url.match(/\/loadBalancers\/([^/?]+)(\?|$)/);
        if (one && req.method === "GET") {
          const key = one[1];
          if (key === "alb-new") {
            return json({
              id: "alb-new",
              name: "new-lb",
              folderId: "folder-1",
              status: "CREATING",
              listeners: [],
              allocationPolicy: { locations: [{ zoneId: "ru-central1-a", subnetId: "sub-1" }] },
              networkId: "net-1",
            });
          }
          if (status[key]) return json(lbBase(key));
          return json({ message: "load balancer not found" }, 404);
        }
        if (req.method === "GET") {
          return json({ loadBalancers: Object.keys(status).map((id) => lbBase(id)) });
        }
      }

      // ── Группы целей ──
      if (url.indexOf("/apploadbalancer/v1/targetGroups") === 0) {
        if (req.method === "POST" && /\/targetGroups(\?|$)/.test(url)) {
          created.tg.push(JSON.parse(raw || "{}"));
          return json({ id: "op-tg-new", done: false });
        }
        const change = url.match(/\/targetGroups\/([^/:?]+):(addTargets|removeTargets)/);
        if (change && req.method === "POST") {
          created.targets.push({ group: change[1], action: change[2], body: JSON.parse(raw || "{}") });
          return json({ id: "op-targets", done: false });
        }
        const del = url.match(/\/targetGroups\/([^/?]+)$/);
        if (del && req.method === "DELETE") {
          deleted.add(del[1]);
          return json({ id: "op-del", done: false });
        }
        const one = url.match(/\/targetGroups\/([^/?]+)(\?|$)/);
        if (one && req.method === "GET") {
          const key = one[1];
          if (key === "tg-new") {
            return json({ id: "tg-new", name: "created-targets", folderId: "folder-1", targets: [] });
          }
          if (groups[key]) return json(groups[key]);
          return json({ message: "target group not found" }, 404);
        }
        if (req.method === "GET") {
          // Удалённую группу стенд намеренно НЕ убирает из списка: после проверки
          // удаления набор ещё читает список, и «пусто» здесь ничего не проверило бы.
          return json({ targetGroups: Object.keys(groups).map((k) => groups[k]) });
        }
      }

      // ── HTTP-роутеры ──
      if (url.indexOf("/apploadbalancer/v1/httpRouters") === 0) {
        if (req.method === "POST") {
          created.router.push(JSON.parse(raw || "{}"));
          return json({ id: "op-router-new", done: false });
        }
        const del = url.match(/\/httpRouters\/([^/?]+)$/);
        if (del && req.method === "DELETE") {
          deleted.add(del[1]);
          return json({ id: "op-del", done: false });
        }
        if (req.method === "GET") {
          const list = Object.keys(routers).map((k) => routers[k]);
          list.push({
            id: "router-new",
            name: "created-router",
            folderId: "folder-1",
            virtualHosts: [{ name: "main", authority: ["new.example"], routes: [{ name: "main", http: { match: { path: { prefixMatch: "/" } }, route: { backendGroupId: "bg-web" } } }] }],
          });
          return json({ httpRouters: list });
        }
      }

      // ── Группы бэкендов: чтение, создание, удаление ──
      if (url.indexOf("/apploadbalancer/v1/backendGroups") === 0) {
        if (req.method === "POST" && /\/backendGroups(\?|$)/.test(url)) {
          created.bg.push(JSON.parse(raw || "{}"));
          return json({ id: "op-bg-new", done: false });
        }
        const del = url.match(/\/backendGroups\/([^/?]+)$/);
        if (del && req.method === "DELETE") {
          deleted.add(del[1]);
          return json({ id: "op-del", done: false });
        }
        const one = url.match(/\/backendGroups\/([^/?]+)(\?|$)/);
        if (one && req.method === "GET" && one[1] !== "backendGroups") {
          if (one[1] === "bg-web") {
            return json({
              id: "bg-web",
              name: "web-backends",
              folderId: "folder-1",
              http: { backends: [{ name: "web", port: "8080", targetGroups: { targetGroupIds: ["tg-web"] }, healthchecks: [{ timeout: "1s", interval: "2s", http: { path: "/" } }] }] },
            });
          }
          if (one[1] === "bg-free") {
            return json({ id: "bg-free", name: "free-backends", folderId: "folder-1", stream: { backends: [{ name: "tcp", port: "5432", targetGroups: { targetGroupIds: ["tg-empty"] } }] } });
          }
          if (one[1] === "bg-idle") {
            return json({ id: "bg-idle", name: "idle-backends", folderId: "folder-1", http: { backends: [{ name: "idle", port: "80", targetGroups: { targetGroupIds: ["tg-new"] } }] } });
          }
          if (one[1] === "bg-new") {
            return json({ id: "bg-new", name: "created-backends", folderId: "folder-1", http: { backends: [{ name: "main", port: "8080", targetGroups: { targetGroupIds: ["tg-web"] } }] } });
          }
          return json({ message: "backend group not found" }, 404);
        }
        if (req.method === "GET") {
          return json({
            backendGroups: [
              { id: "bg-web", name: "web-backends", folderId: "folder-1", http: { backends: [{ name: "web", port: "8080", targetGroups: { targetGroupIds: ["tg-web"] } }] } },
              { id: "bg-empty", name: "empty-backends", folderId: "folder-1", stream: { backends: [] } },
              { id: "bg-free", name: "free-backends", folderId: "folder-1", stream: { backends: [{ name: "tcp", targetGroups: { targetGroupIds: ["tg-empty"] } }] } },
              { id: "bg-idle", name: "idle-backends", folderId: "folder-1", http: { backends: [{ name: "idle", targetGroups: { targetGroupIds: ["tg-new"] } }] } },
            ],
          });
        }
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({
        server: server,
        calls: calls,
        created: created,
        deleted: deleted,
        status: status,
        flags: flags,
        reset: () => {
          calls.length = 0;
          created.lb.length = 0;
          created.tg.length = 0;
          created.router.length = 0;
          created.targets.length = 0;
          created.bg.length = 0;
          created.listenerOps.length = 0;
          created.lbPatches.length = 0;
          deleted.clear();
        },
        base: "http://127.0.0.1:" + server.address().port,
      })
    );
  });
}

const alb = createYcAlb({
  fetchJson: yandex._fetchJson,
  endpoint: yandex.endpoint,
  getIamToken: yandex.getIamToken,
  waitOperation: yandex.waitOperation,
  serviceError: yandex.serviceError,
});

function settingsFor(over) {
  return Object.assign(
    { yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "folder-1", ycFolderName: "prod" },
    over || {}
  );
}

function buildTools(settingsOver) {
  const settings = settingsFor(settingsOver);
  return createCloudTools({
    path: path,
    fs: fs,
    yandexCloud: yandex,
    ycAlb: alb,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        cloudId: st.ycCloudId || "",
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
      };
    },
    loadSettings: () => settings,
  });
}

function ipcDeps(handlers, settings) {
  return {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    yandexCloud: yandex,
    ycConsole: {},
    ycCosts: {},
    ycVpc: {},
    ycCompute: {},
    ycIam: {},
    ycFunctions: {},
    ycBilling: {},
    ycCdn: {},
    ycMonitoring: {},
    ycAi: {},
    ycMdb: {},
    ycIg: {},
    ycAlb: alb,
    fs: fs,
    path: path,
    resolvePath: (p) => String(p),
    agentWorkDir: () => os.tmpdir(),
    loadSettings: () => settings,
    saveSettings: () => {},
    svc: {
      YANDEX_OAUTH_URL: "https://oauth.yandex.ru/authorize",
      ycConfig: () => ({
        oauth: settings.yandexOauthToken ? "oauth-1" : "",
        cloudId: settings.ycCloudId || "",
        folderId: settings.ycFolderId || "",
        folderName: settings.ycFolderName || "",
        allowCreate: false,
        allowDelete: false,
        allowUpdate: false,
        allowPublic: false,
      }),
      ycRequireAuth: () => {},
      readYcLogsText: async () => "",
      ycCliStatus: () => ({}),
      ycCliInstall: async () => ({}),
    },
  };
}

const callsTo = (stub, part) => stub.calls.filter((c) => c.url.indexOf(part) >= 0);
const writes = (stub) => stub.calls.filter((c) => c.method === "POST" || c.method === "DELETE");
const section = (src, channel) => {
  const at = src.indexOf('ipcMain.handle("' + channel + '"');
  assert.ok(at > 0, "нет канала " + channel);
  let end = src.indexOf('ipcMain.handle("', at + 10);
  if (end < 0) end = src.length;
  return src.slice(at, end);
};

(async () => {
  const stub = await startAlbStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Четыре ресурса: слова, разбор ответа и строки");

  await test("ycAlb: состояния переводятся словами — и балансировщика, и цели", () => {
    assert.strictEqual(alb.statusHuman("ACTIVE"), "работает");
    assert.strictEqual(alb.statusHuman("STOPPED"), "остановлен");
    assert.strictEqual(alb.statusHuman("CREATING"), "создаётся");
    assert.strictEqual(alb.statusHuman("НЕВЕДОМОЕ"), "НЕВЕДОМОЕ", "незнакомое состояние показывается как есть");
    assert.strictEqual(alb.targetStatusHuman("HEALTHY"), "здорова");
    assert.strictEqual(alb.targetStatusHuman("UNHEALTHY"), "не отвечает");
    assert.strictEqual(alb.targetStatusHuman("DRAINING"), "выводится из работы");
    assert.ok(/частично/.test(alb.targetStatusHuman("PARTIALLY_HEALTHY")), alb.targetStatusHuman("PARTIALLY_HEALTHY"));
  });

  await test("ycAlb: адрес слушателя читается из ОТВЕТА облака (а не из формы запроса)", () => {
    const lb = lbInfo({
      id: "alb-1",
      name: "web-lb",
      status: "ACTIVE",
      listeners: [
        {
          name: "web",
          endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.10" } }], ports: ["80"] }],
          http: { handler: { httpRouterId: "router-1" } },
        },
      ],
      allocationPolicy: { locations: [{ zoneId: "ru-central1-a", subnetId: "sub-1" }] },
    });
    assert.strictEqual(lb.listeners.length, 1);
    assert.strictEqual(lb.listeners[0].kind, "http");
    assert.strictEqual(lb.listeners[0].addresses[0], "203.0.113.10", "адрес из ответа не разобран — в карточке было бы «выдаст облако»");
    assert.deepStrictEqual(lb.listeners[0].ports, ["80"]);
    assert.deepStrictEqual(lb.addresses, ["203.0.113.10"]);
    assert.strictEqual(lb.listeners[0].routerId, "router-1", "слушатель не связывается с роутером");
    assert.deepStrictEqual(lb.zones, ["ru-central1-a"]);
    assert.strictEqual(lb.active, true);
    assert.strictEqual(lb.busy, false);
  });

  await test("ycAlb: три вида слушателя различаются — http, HTTPS со сертификатом и поток TCP", () => {
    const tls = lbInfo({
      id: "x",
      status: "STOPPED",
      listeners: [
        {
          name: "secure",
          endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.11" } }], ports: ["443"] }],
          tls: { defaultHandler: { httpHandler: { httpRouterId: "router-1" }, certificateIds: ["cert-1", "cert-2"] } },
        },
      ],
    });
    assert.strictEqual(tls.listeners[0].kind, "tls");
    assert.strictEqual(tls.listeners[0].kindHuman, "HTTPS/TLS");
    assert.deepStrictEqual(tls.listeners[0].certificateIds, ["cert-1", "cert-2"]);
    const stream = lbInfo({
      id: "y",
      status: "ACTIVE",
      listeners: [{ name: "tcp", endpoints: [{ addresses: [], ports: ["5432"] }], stream: { handler: { backendGroupId: "bg-db" } } }],
    });
    assert.strictEqual(stream.listeners[0].kind, "stream");
    assert.strictEqual(stream.listeners[0].backendGroupId, "bg-db", "поток не связан с группой бэкендов");
    assert.strictEqual(stream.listeners[0].addresses.length, 0, "пустой адрес не должен превращаться в выдумку");
  });

  await test("ycAlb: строка сертификата говорит состояние, домены и срок — просроченный виден сразу", () => {
    assert.strictEqual(alb.certStatusHuman("VALIDATING"), "проверяется (запись подтверждения не готова)");
    assert.strictEqual(alb.certStatusHuman("ISSUED"), "выпущен");
    assert.ok(/выпускается/.test(alb.certStatusHuman("PROVISIONING")), alb.certStatusHuman("PROVISIONING"));
    const line = alb.certLine({
      listenerName: "secure",
      certId: "cert-1",
      cert: { id: "cert-1", name: "site-cert", statusHuman: "выпущен", domains: ["site.example"], notAfter: "2027-01-01T00:00:00Z", daysLeft: 92 },
    });
    assert.ok(/🔒 Слушатель «secure»/.test(line) && /site-cert/.test(line) && /выпущен/.test(line), line);
    assert.ok(/домены: site\.example/.test(line) && /действует до 2027-01-01 \(осталось 92 дн\.\)/.test(line), line);
    const expired = alb.certLine({
      listenerName: "old",
      certId: "cert-9",
      cert: { name: "dead-cert", statusHuman: "выпущен", daysLeft: -3, notAfter: "2026-09-27T00:00:00Z" },
    });
    assert.ok(/просрочен 3 дн\. назад/.test(expired), "просроченный сертификат не назван: " + expired);
  });

  await test("ycAlb: занятый балансировщик отличается от работающего", () => {
    assert.strictEqual(lbInfo({ status: "CREATING" }).busy, true, "CREATING — переход, а не рабочее состояние");
    assert.strictEqual(lbInfo({ status: "STOPPING" }).busy, true);
    assert.strictEqual(lbInfo({ status: "DELETING" }).busy, true);
    assert.strictEqual(lbInfo({ status: "ACTIVE" }).busy, false);
    assert.strictEqual(lbInfo({ status: "STOPPED" }).active, false);
  });

  await test("ycAlb: строки называют то, что человеку важно — адрес, порт, цель и путь", () => {
    const line = lbLine(lbInfo({
      id: "alb-web",
      name: "web-lb",
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      status: "ACTIVE",
      listeners: [
        {
          name: "web",
          endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.10" } }], ports: ["80", "8080"] }],
          http: { handler: { httpRouterId: "router-1" } },
        },
      ],
      allocationPolicy: { locations: [{ zoneId: "ru-central1-a", subnetId: "sub-1" }] },
    }));
    assert.ok(/web-lb/.test(line) && /работает/.test(line), line);
    assert.ok(/HTTP 80,8080 203\.0\.113\.10/.test(line), "слушатель в строке не назван: " + line);
    assert.ok(/зоны: ru-central1-a/.test(line), "зона не показана: " + line);
    assert.ok(/id alb-web/.test(line), "id не назван: " + line);

    const listener = listenerLine(lbInfo({
      status: "ACTIVE",
      listeners: [{ name: "secure", endpoints: [{ addresses: [{ externalIpv4Address: { address: "203.0.113.11" } }], ports: ["443"] }], tls: { defaultHandler: { httpHandler: { httpRouterId: "router-1" }, certificateIds: ["cert-1"] } } }],
    }).listeners[0]);
    assert.ok(/HTTPS\/TLS/.test(listener) && /роутер router-1/.test(listener), "слушатель не говорит, куда ведёт: " + listener);
    assert.ok(/сертификатов: 1/.test(listener), "сертификаты не показаны: " + listener);

    const target = targetLine({ ipAddress: "10.10.0.5", subnetId: "sub-1", healthHuman: "здорова" });
    assert.ok(/10\.10\.0\.5/.test(target) && /подсеть sub-1/.test(target) && /здорова/.test(target), target);

    const tg = tgLine(tgInfo({ id: "tg-web", name: "web-targets", targets: [{ ipAddress: "10.10.0.5" }] }));
    assert.ok(/web-targets/.test(tg) && /целей: 1/.test(tg), tg);

    const router = routerLine(routerInfo({
      id: "router-1",
      name: "main-router",
      virtualHosts: [{ name: "main", authority: ["site.example"], routes: [{ name: "main", http: { match: { path: { prefixMatch: "/" } }, route: { backendGroupId: "bg-web" } } }] }],
    }));
    assert.ok(/main-router/.test(router) && /маршрутов: 1/.test(router), router);
    assert.ok(/домены: site\.example/.test(router), "домен роутера не показан: " + router);
  });

  console.log("\n[2] Чтение: пути, карточка и отказы до сети");

  await test("ycAlb: список уходит каталогом и размером страницы, а карточка собирает связи", async () => {
    const before = stub.calls.length;
    const list = await alb.loadBalancers("oauth-1", "folder-1");
    assert.strictEqual(list.length, 4, "балансировщиков не четыре: " + list.length);
    const req = callsTo(stub, "/apploadbalancer/v1/loadBalancers?").slice(-1)[0];
    assert.ok(req.url.indexOf("folderId=folder-1") >= 0, "каталог не передан: " + req.url);
    assert.ok(req.url.indexOf("pageSize=1000") >= 0, "размер страницы не передан: " + req.url);
    assert.ok(stub.calls.length > before, "запрос вообще не ушёл");

    const found = await alb.findLoadBalancer("oauth-1", "folder-1", "https-lb");
    assert.strictEqual(found.id, "alb-https", "поиск по имени не сработал");
    assert.strictEqual((await alb.findLoadBalancer("oauth-1", "folder-1", "нет-такого")), null, "несуществующий балансировщик не отвергнут");
  });

  await test("ycAlb: карточка ведёт к группам целей ЧЕРЕЗ группу бэкендов (другого пути нет)", async () => {
    const c = await alb.card("oauth-1", "folder-1", "web-lb");
    assert.ok(c, "карточка пустая");
    assert.strictEqual(c.lb.id, "alb-web");
    assert.strictEqual(c.listeners.length, 1, "слушатель не связан с роутером");
    assert.strictEqual(c.listeners[0].router.id, "router-1");
    assert.strictEqual(c.routers.length, 1);
    assert.deepStrictEqual(c.backendGroups.map((b) => b.id), ["bg-web"], "группа бэкендов из маршрута не найдена");
    assert.deepStrictEqual(c.targetGroups.map((g) => g.id), ["tg-web"], "группа целей не найдена через группу бэкендов");
    assert.strictEqual(c.targetGroupsResolved, true, "связь с группами целей не подтверждена");
    assert.ok(callsTo(stub, "/backendGroups/bg-web").length >= 1, "группа бэкендов не прочитана по id — группы целей неоткуда взять");
    assert.strictEqual(await alb.card("oauth-1", "folder-1", "нет-такого"), null);
  });

  await test("ycAlb: группы целей, роутеры и группы бэкендов читаются списками", async () => {
    const tgs = await alb.targetGroups("oauth-1", "folder-1");
    assert.strictEqual(tgs.length, 2);
    assert.strictEqual(tgs.find((g) => g.id === "tg-web").targetCount, 2);
    assert.strictEqual(tgs.find((g) => g.id === "tg-web").targets[0].ipAddress, "10.10.0.5");
    const one = await alb.targetGroup("oauth-1", "tg-web");
    assert.strictEqual(one.name, "web-targets");
    assert.strictEqual((await alb.findTargetGroup("oauth-1", "folder-1", "empty-targets")).id, "tg-empty");

    const routers = await alb.httpRouters("oauth-1", "folder-1");
    assert.ok(routers.length >= 2);
    assert.strictEqual(routers.find((r) => r.id === "router-1").hosts[0].authority[0], "site.example");
    assert.strictEqual(routers.find((r) => r.id === "router-1").routeCount, 1);
    assert.strictEqual((await alb.findHttpRouter("oauth-1", "folder-1", "api-router")).id, "router-2");

    const backends = await alb.backendGroups("oauth-1", "folder-1");
    assert.deepStrictEqual(backends.map((b) => b.id), ["bg-web", "bg-empty", "bg-free", "bg-idle"]);
    assert.strictEqual(backends[0].backendCount, 1, "число бэкендов не посчитано");
    assert.strictEqual(backends[0].kind, "http", "вид группы не разобран");
    assert.strictEqual((await alb.findBackendGroup("oauth-1", "folder-1", "web-backends")).id, "bg-web");
  });

  await test("ycAlb: без каталога и без id — отказ ДО сети (и за это не платят)", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => alb.loadBalancers("oauth-1", ""), /каталог/);
    await assert.rejects(() => alb.targetGroups("oauth-1", ""), /каталог/);
    await assert.rejects(() => alb.httpRouters("oauth-1", ""), /каталог/);
    await assert.rejects(() => alb.backendGroups("oauth-1", ""), /каталог/);
    await assert.rejects(() => alb.loadBalancer("oauth-1", ""), /id балансировщика/);
    await assert.rejects(() => alb.targetGroup("oauth-1", ""), /id группы целей/);
    await assert.rejects(() => alb.backendGroup("oauth-1", ""), /id группы бэкендов/);
    assert.strictEqual(stub.calls.length, before, "запрос ушёл, хотя каталога/id нет");
  });

  console.log("\n[2x] Группа бэкендов: создание, удаление и здоровье целей");

  await test("ycAlb: группа бэкендов разбирается целиком — вид, бэкенды, порт и группы целей", async () => {
    const list = await alb.backendGroups("oauth-1", "folder-1");
    const web = list.find((b) => b.id === "bg-web");
    assert.strictEqual(web.kind, "http", "вид группы не разобран: " + web.kind);
    assert.strictEqual(web.kindHuman, "HTTP");
    assert.strictEqual(web.backends.length, 1);
    assert.strictEqual(web.backends[0].port, "8080", "порт целей не разобран");
    assert.deepStrictEqual(web.targetGroupIds, ["tg-web"], "группы целей бэкенда не собраны");
    const webFull = await alb.backendGroup("oauth-1", "bg-web");
    assert.strictEqual(webFull.healthcheckCount, 1, "проверки здоровья не посчитаны");
    const line = alb.backendGroupLine(web);
    assert.ok(/web-backends/.test(line) && /HTTP/.test(line) && /группы целей: tg-web/.test(line), line);
    const single = await alb.backendGroup("oauth-1", "bg-free");
    assert.strictEqual(single.kind, "stream", "одиночное чтение не разобрано");
    assert.deepStrictEqual(single.targetGroupIds, ["tg-empty"]);
    assert.strictEqual(single.healthcheckCount, 0, "у потока проверок нет — счётчик обязан быть нулевым");
  });

  await test("ycAlb: группа бэкендов создаётся из группы целей — вид, порт и проверка уходят телом", async () => {
    stub.created.bg.length = 0;
    const r = await alb.createBackendGroup("oauth-1", {
      folderId: "folder-1",
      name: "web-backends-2",
      kind: "http",
      targetGroup: "web-targets",
      port: 8080,
      healthPath: "/health",
    });
    assert.strictEqual(stub.created.bg.length, 1, "тело создания не ушло");
    const body = stub.created.bg[0];
    assert.strictEqual(body.folderId, "folder-1");
    assert.strictEqual(body.name, "web-backends-2");
    assert.ok(body.http && body.http.backends, "вид группы не собран: " + JSON.stringify(body));
    assert.strictEqual(body.stream, undefined, "у HTTP-группы появился второй вид");
    const backend = body.http.backends[0];
    assert.strictEqual(backend.name, "main");
    assert.strictEqual(backend.port, "8080");
    assert.deepStrictEqual(backend.targetGroups.targetGroupIds, ["tg-web"], "группа целей не разрешена в id");
    const hc = backend.healthchecks[0] || {};
    assert.ok(hc.http && hc.http.path === "/health", "проверка здоровья не собрана: " + JSON.stringify(hc));
    assert.ok(hc.timeout && hc.interval, "у проверки нет обязательных timeout и interval — облако её не примет");
    assert.strictEqual(r.groupId, "bg-new", "id готовой группы не достали из ответа операции");
    assert.ok(/web-backends-2/.test(r.message) && /порт 8080/.test(r.message) && /web-targets/.test(r.message), r.message);
    assert.ok(!r.warnings.some((w) => /Проверки здоровья не заданы/.test(w)), "проверка задана, а предупреждение осталось");
    assert.ok(r.warnings.some((w) => /routernew/.test(w)), "не сказано, что делать дальше: " + r.warnings.join(" | "));
  });

  await test("ycAlb: без проверок и без порта группа создаётся, но об этом говорят вслух", async () => {
    stub.created.bg.length = 0;
    const r = await alb.createBackendGroup("oauth-1", { folderId: "folder-1", name: "bare-backends", targetGroup: "tg-web" });
    const backend = stub.created.bg[0].http.backends[0];
    assert.strictEqual(backend.port, "80", "порт по умолчанию не тот");
    assert.strictEqual(backend.healthchecks, undefined, "проверки появились, хотя их не просили");
    assert.ok(r.warnings.some((w) => /Проверки здоровья не заданы/.test(w)), "о выключенных проверках не сказано: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /взят 80/.test(w) && /слушают ЦЕЛИ/.test(w)), "не сказано, чей это порт: " + r.warnings.join(" | "));
  });

  await test("ycAlb: у потока порт не угадывается, а кривые данные отбиваются ДО сети", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => alb.createBackendGroup("oauth-1", { folderId: "folder-1", name: "tcp-bg", kind: "stream", targetGroup: "tg-web" }), /порт не угадывается/);
    await assert.rejects(() => alb.createBackendGroup("oauth-1", { folderId: "folder-1", name: "1bg", targetGroup: "tg-web" }), /облако не примет/);
    await assert.rejects(() => alb.createBackendGroup("oauth-1", { folderId: "folder-1", name: "bg-x", kind: "udp", targetGroup: "tg-web" }), /http, grpc или stream/);
    await assert.rejects(() => alb.createBackendGroup("oauth-1", { folderId: "folder-1", name: "bg-x", targetGroup: "нет-такой" }), /нужна группа целей/);
    await assert.rejects(() => alb.createBackendGroup("oauth-1", { folderId: "", name: "bg-x", targetGroup: "tg-web" }), /каталог/);
    const paid = stub.calls.slice(before).filter((c) => c.method === "POST" || c.method === "DELETE");
    assert.deepStrictEqual(paid.map((c) => c.url), [], "запись ушла, хотя данные негодные");
  });

  await test("ycAlb: здоровье цели приходит ПО ЗОНАМ и говорит, сколько целей здорово", async () => {
    const before = callsTo(stub, "/targetStates/").length;
    const r = await alb.targetStates("oauth-1", { folderId: "folder-1", lb: "web-lb", targetGroup: "web-targets" });
    assert.strictEqual(callsTo(stub, "/targetStates/").length, before + 1, "запрос здоровья не ушёл");
    const reqCall = callsTo(stub, "/targetStates/").slice(-1)[0];
    assert.strictEqual(reqCall.url, "/apploadbalancer/v1/loadBalancers/alb-web/targetStates/bg-web/tg-web", "не тот путь здоровья: " + reqCall.url);
    assert.strictEqual(r.backendGroup.id, "bg-web", "группа бэкендов не найдена от балансировщика");
    assert.strictEqual(r.states.length, 2);
    assert.strictEqual(r.states[0].healthy, true);
    assert.strictEqual(r.states[1].healthy, false, "цель с TIMEOUT и UNHEALTHY названа здоровой");
    assert.strictEqual(r.healthyCount, 1, "здоровых целей не одна: " + r.healthyCount);
    assert.ok(r.lines.some((l) => /ru-central1-a: здорова/.test(l)), r.lines.join(" | "));
    assert.ok(r.lines.some((l) => /ru-central1-b: не отвечает/.test(l) && /не проходит активную проверку/.test(l)), "зона со сломанной проверкой не названа: " + r.lines.join(" | "));
    assert.ok(r.lines.some((l) => /здоровых: 1/.test(l)), r.lines.join(" | "));
    assert.ok(r.warnings.some((w) => /проверка не успела ответить/.test(w)), "о TIMEOUT не сказано: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /только здоровые цели/.test(w)), "не сказано, куда пойдёт трафик: " + r.warnings.join(" | "));
    assert.ok(!r.warnings.some((w) => /не заданы проверки здоровья/.test(w)), "у группы есть проверки — предупреждение лишнее");
  });

  await test("ycAlb: здоровье спрашивают у ПАРЫ — пара ищется у балансировщика, отказ ДО сети", async () => {
    const before = callsTo(stub, "/targetStates/").length;
    await assert.rejects(
      () => alb.targetStates("oauth-1", { folderId: "folder-1", lb: "web-lb", backendGroup: "free-backends", targetGroup: "web-targets" }),
      (e) => /не закреплена за балансировщиком/.test(e.message) && /web-backends/.test(e.message)
    );
    await assert.rejects(
      () => alb.targetStates("oauth-1", { folderId: "folder-1", lb: "web-lb", targetGroup: "empty-targets" }),
      (e) => /не ссылается на группу целей/.test(e.message) && /tg-web/.test(e.message)
    );
    await assert.rejects(() => alb.targetStates("oauth-1", { folderId: "folder-1", lb: "busy-lb", targetGroup: "web-targets" }), /нет закреплённых групп бэкендов/);
    await assert.rejects(() => alb.targetStates("oauth-1", { folderId: "folder-1", lb: "нет-такой", targetGroup: "web-targets" }), /Не нашёл балансировщик/);
    await assert.rejects(() => alb.targetStates("oauth-1", { folderId: "folder-1", lb: "web-lb", targetGroup: "нет-такой" }), /Не нашёл группу целей/);
    assert.strictEqual(callsTo(stub, "/targetStates/").length, before, "отказ не помешал запросу здоровья");
  });

  await test("ycAlb: пустая группа целей — честные нули и предупреждение о выключенных проверках", async () => {
    const streamLb = await alb.findLoadBalancer("oauth-1", "folder-1", "stream-lb");
    const r = await alb.targetStates("oauth-1", { folderId: "folder-1", lb: streamLb, targetGroup: "empty-targets" });
    assert.strictEqual(r.backendGroup.id, "bg-free", "единственная закреплённая группа не выбрана сама");
    assert.strictEqual(r.states.length, 0);
    assert.strictEqual(r.healthyCount, 0);
    assert.ok(r.lines.some((l) => /Целей нет/.test(l)), r.lines.join(" | "));
    assert.ok(r.warnings.some((w) => /не заданы проверки здоровья/.test(w)), "о выключенных проверках не сказано: " + r.warnings.join(" | "));
  });

  await test("ycAlb: занятую группу бэкендов не удаляют — модуль называет виновных ДО сети", async () => {
    const before = stub.calls.length;
    await assert.rejects(
      () => alb.removeBackendGroup("oauth-1", { folderId: "folder-1", group: "web-backends" }),
      (e) => /ещё работает/.test(e.message) && /роутер «main-router»/.test(e.message)
    );
    await assert.rejects(
      () => alb.removeBackendGroup("oauth-1", { folderId: "folder-1", group: "free-backends" }),
      (e) => /ещё работает/.test(e.message) && /слушатель балансировщика «stream-lb»/.test(e.message)
    );
    assert.strictEqual(stub.calls.slice(before).filter((c) => c.method === "DELETE").length, 0, "удаление ушло, хотя группа занята");
    await assert.rejects(() => alb.removeBackendGroup("oauth-1", { folderId: "folder-1", group: "нет-такой" }), /Не нашёл группу бэкендов/);
  });

  await test("ycAlb: свободная группа бэкендов удаляется по id и говорит, что останется", async () => {
    const r = await alb.removeBackendGroup("oauth-1", { folderId: "folder-1", group: "idle-backends" });
    assert.strictEqual(r.changed, true);
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === "/apploadbalancer/v1/backendGroups/bg-idle"), "удаление ушло не по id группы");
    assert.ok(/idle-backends/.test(r.message) && /потеряны/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /не трогаются/.test(w)), "не сказано, что цели и машины остаются: " + r.warnings.join(" | "));
  });

  console.log("\n[3] Группа целей: адреса, подсеть и тело запроса");

  await test("ycAlb: группа целей создаётся с адресами и подсетью — тела видно целиком", async () => {
    stub.created.tg.length = 0;
    const r = await alb.createTargetGroup("oauth-1", {
      folderId: "folder-1",
      name: "web-targets-2",
      ips: ["10.10.0.5", "10.10.0.6"],
      subnet: "app-subnet",
    });
    assert.strictEqual(stub.created.tg.length, 1, "тело создания не ушло");
    const body = stub.created.tg[0];
    assert.strictEqual(body.name, "web-targets-2");
    assert.strictEqual(body.folderId, "folder-1");
    assert.strictEqual(body.targets.length, 2);
    assert.strictEqual(body.targets[0].ipAddress, "10.10.0.5");
    assert.strictEqual(body.targets[0].subnetId, "sub-1", "подсеть не разрешена в id (по имени app-subnet)");
    assert.strictEqual(r.groupId, "tg-new", "id готовой группы не достали из ответа операции");
    assert.ok(/целей 2/.test(r.message) && /app-subnet/.test(r.message), "в ответе не названо, что именно создано: " + r.message);
    assert.ok(r.warnings.some((w) => /проверку здоровья задаёт ГРУППА БЭКЕНДОВ/.test(w)), "не сказано, где живут проверки здоровья: " + r.warnings.join(" | "));
  });

  await test("ycAlb: пустая группа целей — это можно, но об этом говорится вслух", async () => {
    stub.created.tg.length = 0;
    const r = await alb.createTargetGroup("oauth-1", { folderId: "folder-1", name: "empty-targets-2" });
    assert.strictEqual(stub.created.tg[0].targets.length, 0);
    assert.ok(!stub.created.tg[0].targets.length, "появились цели, которых не просили");
    assert.ok(r.warnings.some((w) => /Группа целей пустая/.test(w)), "о пустой группе не сказано: " + r.warnings.join(" | "));
    assert.ok(!/подсеть/.test(r.message), "пустой группе приписана подсеть: " + r.message);
  });

  await test("ycAlb: отказы до сети — кривое имя, нет подсети для адресов, не адрес", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => alb.createTargetGroup("oauth-1", { folderId: "folder-1", name: "1web", ips: ["10.0.0.1"] }), /облако не примет/);
    await assert.rejects(() => alb.createTargetGroup("oauth-1", { folderId: "folder-1", name: "web-x", ips: ["10.0.0.1"] }), /нужна подсеть/);
    await assert.rejects(() => alb.createTargetGroup("oauth-1", { folderId: "folder-1", name: "web-x", ips: ["не-адрес"], subnet: "app-subnet" }), /не похоже на адреса/);
    await assert.rejects(() => alb.createTargetGroup("oauth-1", { folderId: "folder-1", name: "web-x", ips: ["10.0.0.1"], subnet: "нет-такой" }), /нужна подсеть/);
    const paid = stub.calls.slice(before).filter((c) => c.method === "POST" || c.method === "DELETE");
    assert.deepStrictEqual(paid.map((c) => c.url), [], "запись ушла, хотя данные негодные");
  });

  console.log("\n[4] Состав группы целей: addTargets и removeTargets");

  await test("ycAlb: добавление целей требует подсеть и уходит отдельной операцией", async () => {
    stub.created.targets.length = 0;
    const r = await alb.changeTargets("oauth-1", "add", { folderId: "folder-1", group: "web-targets", ips: ["10.10.0.7"], subnet: "sub-1" });
    assert.strictEqual(stub.created.targets.length, 1);
    assert.strictEqual(stub.created.targets[0].action, "addTargets");
    assert.strictEqual(stub.created.targets[0].body.targets[0].ipAddress, "10.10.0.7");
    assert.strictEqual(stub.created.targets[0].body.targets[0].subnetId, "sub-1", "новой цели не передана подсеть");
    assert.ok(/добавлено целей: 1/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /проверяется|проверку/.test(w)), "не сказано, что цель проверяется не сразу: " + r.warnings.join(" | "));
    await assert.rejects(() => alb.changeTargets("oauth-1", "add", { folderId: "folder-1", group: "web-targets", ips: ["10.10.0.8"] }), /Новой цели нужна подсеть/);
  });

  await test("ycAlb: цель убирается по АДРЕСУ (subnetId в теле не нужен), а чужой адрес назван словами", async () => {
    stub.created.targets.length = 0;
    const r = await alb.changeTargets("oauth-1", "remove", { folderId: "folder-1", group: "tg-web", ips: ["10.10.0.6"] });
    assert.strictEqual(stub.created.targets[0].action, "removeTargets");
    assert.strictEqual(stub.created.targets[0].body.targets[0].ipAddress, "10.10.0.6");
    assert.strictEqual(stub.created.targets[0].body.targets[0].subnetId, undefined, "при удалении ушла подсеть — её не спрашивают");
    assert.ok(/убрано целей: 1/.test(r.message), r.message);

    await assert.rejects(() => alb.changeTargets("oauth-1", "remove", { folderId: "folder-1", group: "tg-web", ips: ["10.10.0.99"] }), /нет целей/);
    await assert.rejects(() => alb.changeTargets("oauth-1", "remove", { folderId: "folder-1", group: "нет-такой", ips: ["10.10.0.5"] }), /Не нашёл группу целей/);
    await assert.rejects(() => alb.changeTargets("oauth-1", "перевернуть", { folderId: "folder-1", group: "tg-web", ips: ["10.10.0.5"] }), /неизвестное действие/);
  });

  console.log("\n[5] HTTP-роутер: правила домена и пути");

  await test("ycAlb: роутер создаётся только в существующую группу бэкендов — иначе отказ словами", async () => {
    const before = stub.calls.length;
    await assert.rejects(
      () => alb.createHttpRouter("oauth-1", { folderId: "folder-1", name: "main-router", backendGroup: "bg-dream" }),
      (e) => /группу бэкендов, а её нет/.test(e.message) && /web-backends/.test(e.message) && /empty-backends/.test(e.message)
    );
    assert.deepStrictEqual(writes(stub).slice(before), [], "роутер ушёл в облако без группы бэкендов");
    await assert.rejects(() => alb.createHttpRouter("oauth-1", { folderId: "folder-1", name: "main-router" }), /группу бэкендов, а её нет/);
  });

  await test("ycAlb: маршрут описывает домен, путь и группу бэкендов — и говорит, кто ставит сертификат", async () => {
    stub.created.router.length = 0;
    const r = await alb.createHttpRouter("oauth-1", {
      folderId: "folder-1",
      name: "main-router-2",
      host: "site.example",
      pathPrefix: "/app",
      backendGroup: "web-backends",
    });
    assert.strictEqual(stub.created.router.length, 1, "тело роутера не ушло");
    const body = stub.created.router[0];
    assert.strictEqual(body.folderId, "folder-1");
    const host = body.virtualHosts[0];
    assert.deepStrictEqual(host.authority, ["site.example"], "домен не попал в виртуальный хост");
    const route = host.routes[0];
    assert.strictEqual(route.http.match.path.prefixMatch, "/app", "путь не попал в маршрут");
    assert.strictEqual(route.http.route.backendGroupId, "bg-web", "маршрут ведёт не в найденную группу бэкендов");
    assert.strictEqual(r.routerId, "router-new");
    assert.ok(/домен site\.example/.test(r.message) && /путь \/app\*/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /Заголовке Host|ЛЮБОЙ домен/.test(w)), "про домен не сказано: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /СЛУШАТЕЛЬ балансировщика/.test(w)), "не сказано, кто отвечает за сертификат: " + r.warnings.join(" | "));
  });

  await test("ycAlb: точный путь вместо префикса и домен по умолчанию", async () => {
    stub.created.router.length = 0;
    await alb.createHttpRouter("oauth-1", { folderId: "folder-1", name: "exact-router", pathExact: "/health", backendGroup: "bg-web" });
    const route = stub.created.router[0].virtualHosts[0].routes[0];
    assert.strictEqual(route.http.match.path.exactMatch, "/health");
    assert.strictEqual(route.http.match.path.prefixMatch, undefined, "точный путь подменился префиксом");
    assert.deepStrictEqual(stub.created.router[0].virtualHosts[0].authority, [], "появился домен, которого не просили");
  });

  console.log("\n[6] Балансировщик: слушатели, сертификат и тело создания");

  await test("ycAlb: HTTP-слушатель берёт роутер, и тело собирается по справочнику", async () => {
    stub.created.lb.length = 0;
    const r = await alb.createLoadBalancer("oauth-1", {
      folderId: "folder-1",
      name: "web-lb-2",
      subnet: "app-subnet",
      listener: "http",
      port: 8080,
      router: "main-router",
      securityGroups: ["web"],
    });
    assert.strictEqual(stub.created.lb.length, 1, "тело создания не ушло");
    const body = stub.created.lb[0];
    assert.strictEqual(body.folderId, "folder-1");
    assert.strictEqual(body.regionId, "ru-central1", "регион не тот, который принимает облако");
    assert.strictEqual(body.networkId, "net-1", "сеть не взята из подсети");
    assert.deepStrictEqual(body.allocationPolicy.locations, [{ zoneId: "ru-central1-a", subnetId: "sub-1" }], "зона/подсеть узла собраны неверно");
    assert.deepStrictEqual(body.securityGroupIds, ["sg-1"], "группа безопасности не разрешена в id");
    assert.strictEqual(body.listenerSpecs.length, 1);
    const l = body.listenerSpecs[0];
    assert.strictEqual(l.name, "web");
    assert.deepStrictEqual(l.endpointSpecs[0].ports, ["8080"]);
    assert.deepStrictEqual(l.endpointSpecs[0].addressSpecs[0], { externalIpv4AddressSpec: {} }, "адрес не запрошен у облака");
    assert.strictEqual(l.http.handler.httpRouterId, "router-1", "слушатель не связан с найденным роутером");
    assert.strictEqual(l.stream, undefined, "у HTTP-слушателя появился второй вид");
    assert.strictEqual(r.lbId, "alb-new", "id готового балансировщика не достали из операции");
    assert.ok(/слушатель HTTP/.test(r.message) && /порт 8080/.test(r.message) && /зона ru-central1-a/.test(r.message), "в ответе нет слушателя и зоны: " + r.message);
    assert.ok(r.warnings.some((w) => /ПЛАТНЫЙ/.test(w) && /за час/.test(w)), "о плате за час не сказано: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /Адрес выдаёт облако/.test(w)), "не сказано, откуда возьмётся адрес");
  });

  await test("ycAlb: HTTPS-слушатель требует ВЫПУЩЕННЫЙ сертификат — и это отказ до сети", async () => {
    const before = stub.calls.length;
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "s-lb", subnet: "app-subnet", listener: "https", router: "main-router" }), /нужен сертификат/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "s-lb", subnet: "app-subnet", listener: "https", router: "main-router", certificate: "нет-такого" }), /Не нашёл сертификат/);
    await assert.rejects(
      () => alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "s-lb", subnet: "app-subnet", listener: "https", router: "main-router", certificate: "old-cert" }),
      (e) => /ещё не выпущен/.test(e.message) && /VALIDATING/.test(e.message)
    );
    assert.deepStrictEqual(writes(stub).slice(before), [], "балансировщик ушёл в облако без годного сертификата");
  });

  await test("ycAlb: HTTPS-слушатель собирается как tls.defaultHandler с сертификатом и портом 443", async () => {
    stub.created.lb.length = 0;
    const r = await alb.createLoadBalancer("oauth-1", {
      folderId: "folder-1",
      name: "https-lb-2",
      subnet: "app-subnet",
      listener: "https",
      router: "main-router",
      certificate: "site-cert",
    });
    const l = stub.created.lb[0].listenerSpecs[0];
    assert.deepStrictEqual(l.endpointSpecs[0].ports, ["443"], "у HTTPS не тот порт по умолчанию");
    assert.strictEqual(l.tls.defaultHandler.httpHandler.httpRouterId, "router-1");
    assert.deepStrictEqual(l.tls.defaultHandler.certificateIds, ["cert-1"], "в слушатель ушёл не найденный сертификат");
    assert.strictEqual(l.http, undefined, "у TLS-слушателя появился второй вид — облако такой не примет");
    assert.ok(/слушатель HTTPS\/TLS/.test(r.message), r.message);
  });

  await test("ycAlb: stream-слушатель ведёт только в группу вида stream, а HTTP-группу отбивает", async () => {
    stub.created.lb.length = 0;
    const r = await alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "tcp-lb", subnet: "app-subnet", listener: "stream", port: 5432, backendGroup: "free-backends" });
    const l = stub.created.lb[0].listenerSpecs[0];
    assert.strictEqual(l.stream.handler.backendGroupId, "bg-free", "поток ушёл не в ту группу бэкендов");
    assert.strictEqual(l.http, undefined);
    assert.ok(/поток TCP/.test(r.message) && /порт 5432/.test(r.message), r.message);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "tcp-lb", subnet: "app-subnet", listener: "stream" }), /нужна группа бэкендов/);
    // Справочник облака: потоковому слушателю годится только группа вида stream
    // (для HTTP-группы облако отвечает «backend group type must be stream»).
    await assert.rejects(
      () => alb.createLoadBalancer("oauth-1", { folderId: "folder-1", name: "tcp-lb", subnet: "app-subnet", listener: "stream", port: 5432, backendGroup: "web-backends" }),
      (e) => /группа вида stream/.test(e.message) && /web-backends/.test(e.message)
    );
  });

  await test("ycAlb: отказы до сети — имя, порт, подсеть, зона, слушатель и группа безопасности", async () => {
    const lbPosts = () => stub.calls.filter((c) => c.method === "POST" && c.url.indexOf("/apploadbalancer/v1/loadBalancers") === 0).length;
    const beforePosts = lbPosts();
    const base = { folderId: "folder-1", name: "lb-x", subnet: "app-subnet" };
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { name: "1lb" })), /облако не примет/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { port: 0 })), /от 1 до 65535/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { port: 70000 })), /от 1 до 65535/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { subnet: "нет-такой" })), /Не нашёл подсеть/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { subnet: "other-subnet", zone: "ru-central1-a" })), /разные/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { listener: "udp" })), /http, https или stream/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { router: "нет-такого" })), /Не нашёл HTTP-роутер/);
    await assert.rejects(() => alb.createLoadBalancer("oauth-1", Object.assign({}, base, { router: "main-router", securityGroups: ["нет-такой"] })), /Не нашёл группу безопасности/);
    assert.strictEqual(lbPosts(), beforePosts, "балансировщик ушёл в облако, хотя данные негодные — за это платили бы");
  });

  console.log("\n[7] Питание и удаление: занятый балансировщик и адреса");

  await test("ycAlb: «уже работает» и «уже остановлен» — это ответ, а не ошибка", async () => {
    const running = await alb.power("oauth-1", "start", { id: "alb-web", name: "web-lb", active: true, status: "ACTIVE" }, { folderId: "folder-1" });
    assert.strictEqual(running.changed, false, "старт работающего считается изменением");
    assert.ok(/уже работает/.test(running.message), running.message);
    const stopped = await alb.power("oauth-1", "stop", { id: "alb-https", name: "https-lb", active: false, status: "STOPPED", busy: false }, { folderId: "folder-1" });
    assert.strictEqual(stopped.changed, false);
    assert.ok(/уже остановлен/.test(stopped.message), stopped.message);
  });

  await test("ycAlb: занятый балансировщик отбивает и питание, и удаление — ДО сети", async () => {
    const busy = await alb.findLoadBalancer("oauth-1", "folder-1", "busy-lb");
    assert.strictEqual(busy.busy, true);
    const before = stub.calls.length;
    await assert.rejects(() => alb.power("oauth-1", "start", busy, { folderId: "folder-1" }), /занят/);
    await assert.rejects(() => alb.remove("oauth-1", { folderId: "folder-1", lb: busy }), /занят/);
    assert.strictEqual(stub.calls.length, before, "занятый балансировщик всё-таки ушёл в облако");
    await assert.rejects(() => alb.power("oauth-1", "перезагрузить", busy, { folderId: "folder-1" }), /неизвестное действие/);
  });

  await test("ycAlb: запуск и остановка уходят POST-ом :start/:stop и говорят про деньги", async () => {
    const list = await alb.loadBalancers("oauth-1", "folder-1");
    const httpsLb = list.find((l) => l.name === "https-lb");
    const started = await alb.power("oauth-1", "start", httpsLb, { folderId: "folder-1" });
    assert.strictEqual(started.changed, true);
    const req = callsTo(stub, ":start").slice(-1)[0];
    assert.strictEqual(req.method, "POST", "питание не POST");
    assert.strictEqual(req.url, "/apploadbalancer/v1/loadBalancers/alb-https:start", "не тот путь питания: " + req.url);

    const list2 = await alb.loadBalancers("oauth-1", "folder-1");
    const webLb = list2.find((l) => l.name === "web-lb");
    const stopped = await alb.power("oauth-1", "stop", webLb, { folderId: "folder-1" });
    assert.ok(/перестаёт отвечать/.test(stopped.warnings.join(" ")), "не сказано, что домен станет недоступен: " + stopped.warnings.join(" | "));
    assert.ok(/продолжают тарифицироваться/.test(stopped.warnings.join(" ")), "не сказано, что остановка экономит не всё");
  });

  await test("ycAlb: удаление забирает слушатели и адреса, а группа целей — только список", async () => {
    const list = await alb.loadBalancers("oauth-1", "folder-1");
    const webLb = list.find((l) => l.name === "web-lb");
    const r = await alb.remove("oauth-1", { folderId: "folder-1", lb: webLb });
    assert.strictEqual(r.changed, true);
    assert.deepStrictEqual(r.addresses, ["203.0.113.10"], "в ответе не названы адреса, которые уйдут");
    assert.ok(/203\.0\.113\.10/.test(r.message) && /отменить нельзя/.test(r.message), "последствия удаления не названы: " + r.message);
    assert.ok(r.warnings.some((w) => /домен/i.test(w) && /недоступен/.test(w)), "про домен не сказано: " + r.warnings.join(" | "));
    assert.ok(stub.calls.some((c) => c.method === "DELETE" && c.url === "/apploadbalancer/v1/loadBalancers/alb-web"), "удаление ушло не по id балансировщика");

    const tg = await alb.findTargetGroup("oauth-1", "folder-1", "empty-targets");
    const rt = await alb.removeTargetGroup("oauth-1", { folderId: "folder-1", group: tg });
    assert.ok(/вместе со списком целей/.test(rt.message), rt.message);
    assert.ok(rt.warnings.some((w) => /Сами машины не трогаются/.test(w)), "не сказано, что машины остаются: " + rt.warnings.join(" | "));
    assert.ok(rt.warnings.some((w) => /группе бэкендов/.test(w)), "не сказано, что группа бэкендов может удержать удаление");

    const rt2 = await alb.removeRouter("oauth-1", { folderId: "folder-1", router: { id: "router-1", name: "main-router", routeCount: 1 } });
    assert.ok(/вместе с правилами/.test(rt2.message), rt2.message);
    assert.ok(rt2.warnings.some((w) => /слушатель/.test(w)), "не сказано, что слушатель перестанет отвечать: " + rt2.warnings.join(" | "));
    await assert.rejects(() => alb.removeTargetGroup("oauth-1", { folderId: "folder-1", group: "нет-такой" }), /Не нашёл группу целей/);
    await assert.rejects(() => alb.removeRouter("oauth-1", { folderId: "folder-1", router: "нет-такой" }), /Не нашёл HTTP-роутер/);
  });

  console.log("\n[5x] Канал yc:alb: настоящий registerYcIpc и отказы словами");

  await test("yc:alb: канал есть в мосте, а из main.js убран; модуль собран и передан", () => {
    assert.ok(IPC_SRC.indexOf('ipcMain.handle("yc:alb"') > 0, "нет канала yc:alb");
    assert.ok(!MAIN_SRC.includes('ipcMain.handle("yc:alb"'), "канал остался в main.js");
    assert.ok(/const ycAlb = createYcAlb\(\{/.test(MAIN_SRC), "модуль ALB не собран в main.js");
    const at = MAIN_SRC.indexOf("const ycAlb = createYcAlb(");
    assert.ok(/waitOperation/.test(MAIN_SRC.slice(at, at + 260)), "модулю не передано ожидание операции — создание осталось бы без ответа");
    const reg = /registerYcIpc\(\{([\s\S]{0,700}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /ycAlb/.test(reg[1]), "канал IPC не получает модуль ALB");
    assert.ok(/ycAlb: \(args\) => ipcRenderer\.invoke\("yc:alb"/.test(PRELOAD_SRC), "окно не видит канал yc:alb");
    assert.ok(/  ycAlb,\n/.test(MAIN_SRC), "инструмент не передан агенту");
  });

  await test("yc:alb: список действий канала — ОДНА правда (массив ALL), и отказ зовёт именно его", () => {
    const body = section(IPC_SRC, "yc:alb");
    const arr = body.match(/const ALL = \[([^\]]+)\];/);
    assert.ok(arr, "в канале нет списка доступных действий");
    assert.ok(/Доступно:\s*" \+ ALL\.join\(", "\)/.test(body), "отказ канала не называет действия из ALL");
    const ops = arr[1].split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    assert.deepStrictEqual(
      ops.slice().sort(),
      ["list", "card", "targets", "routers", "backends", "health", "targetnew", "targetadd", "targetremove", "targetdel", "routernew", "routerdel", "backnew", "backdel", "listeneradd", "listenerupd", "listenerdel", "lbupdate", "lbnew", "lbstart", "lbstop", "lbdel"].sort(),
      "список действий канала: " + ops.join(", ")
    );
    for (const part of ["ycAlb.loadBalancers(", "ycAlb.card(", "ycAlb.targetGroups(", "ycAlb.httpRouters(", "ycAlb.backendGroups(", "ycAlb.backendGroupLine(", "ycAlb.targetStates(", "ycAlb.createTargetGroup(", "ycAlb.changeTargets(", "ycAlb.createHttpRouter(", "ycAlb.createBackendGroup(", "ycAlb.removeBackendGroup(", "ycAlb.createLoadBalancer(", "ycAlb.power(", "ycAlb.remove(", "ycAlb.removeTargetGroup(", "ycAlb.removeRouter(", "ycAlb.lbLine(", "ycAlb.listenerLine(", "ycAlb.targetLine(", "ycAlb.tgLine(", "ycAlb.routerLine(", "ycAlb.addListener(", "ycAlb.updateListener(", "ycAlb.removeListener(", "ycAlb.updateLoadBalancer(", "ycAlb.certLine("]) {
      assert.ok(body.includes(part), "канал не зовёт " + part);
    }
    assert.ok(/needsConfirm: true/.test(body) && /a\.confirm !== true/.test(body), "канал не спрашивает согласие на платное и необратимое");
  });

  await test("yc:alb: канал отвечает правда — список, цели, роутеры, бэкенды и карточка", async () => {
    const handlers = new Map();
    const settings = settingsFor();
    registerYcIpc(ipcDeps(handlers, settings));
    const call = (args) => handlers.get("yc:alb")({}, args || {});

    const list = await call({ op: "list" });
    assert.strictEqual(list.ok, true, "канал отказал на списке: " + (list.error || ""));
    assert.strictEqual(list.loadBalancers.length, 4);
    assert.ok(list.lines.some((l) => /web-lb/.test(l) && /203\.0\.113\.10/.test(l)), "адрес балансировщика не показан: " + list.lines.join(" | "));
    assert.ok(list.warnings.some((w) => /не в работе/.test(w)), "не сказано, что часть балансировщиков не в работе");

    const targets = await call({ op: "targets" });
    assert.strictEqual(targets.targetGroups.length, 2);
    assert.ok(targets.lines.some((l) => /web-targets/.test(l) && /целей: 2/.test(l)), targets.lines.join(" | "));
    assert.ok(targets.warnings.some((w) => /порта, ни пути/.test(w)), "не сказано, что группа целей ничего не знает про порт и путь");

    const routers = await call({ op: "routers" });
    assert.ok(routers.lines.some((l) => /main-router/.test(l) && /site\.example/.test(l)), routers.lines.join(" | "));

    const backends = await call({ op: "backends" });
    assert.ok(backends.lines.some((l) => /web-backends/.test(l) && /HTTP/.test(l)), backends.lines.join(" | "));
    assert.ok(backends.warnings.some((w) => /ГРУППЕ БЭКЕНДОВ/.test(w)), "не сказано, где живут порт и проверки здоровья");

    const card = await call({ op: "card", lb: "web-lb" });
    assert.strictEqual(card.ok, true, "канал отказал на карточке: " + (card.error || ""));
    assert.ok(card.lines.some((l) => /Слушатели \(1\)/.test(l)), "в карточке нет слушателей: " + card.lines.join(" | "));
    // HTTPS-карточка обязана назвать сертификат: без него вход не отвечает.
    const secure = await call({ op: "card", lb: "https-lb" });
    assert.strictEqual(secure.ok, true, "канал отказал на HTTPS-карточке: " + (secure.error || ""));
    assert.ok(secure.lines.some((l) => /🔒 Слушатель «secure»/.test(l) && /site-cert/.test(l)), "сертификат HTTPS-слушателя не показан: " + secure.lines.join(" | "));
    assert.strictEqual(secure.certificates.length, 1, "канал не отдал сертификаты окну: " + secure.certificates.length);
    assert.ok(card.lines.some((l) => /Роутер «main-router»/.test(l)), "в карточке нет роутера: " + card.lines.join(" | "));
    assert.ok(card.lines.some((l) => /10\.10\.0\.5/.test(l)), "в карточке нет адресов целей: " + card.lines.join(" | "));
    assert.ok(card.lines.some((l) => /web-backends/.test(l)), "в карточке нет группы бэкендов: " + card.lines.join(" | "));

    const empty = await call({ op: "card", lb: "busy-lb" });
    assert.ok(empty.lines.some((l) => /Слушателей нет/.test(l)), "не сказано, что слушателей нет: " + empty.lines.join(" | "));

    const unknown = await call({ op: "nope" });
    assert.strictEqual(unknown.ok, false);
    assert.ok(/Неизвестное действие Application Load Balancer/.test(unknown.error), unknown.error);
    assert.ok(/Доступно: list, card, targets, routers, backends/.test(unknown.error), "отказ не перечислил действия: " + unknown.error);
    const notFound = await call({ op: "card", lb: "нет-такой" });
    assert.ok(/Не нашёл балансировщик/.test(notFound.error), notFound.error);
  });

  await test("yc:alb: группа бэкендов и здоровье работают через настоящий канал", async () => {
    const handlers = new Map();
    const settings = settingsFor();
    registerYcIpc(ipcDeps(handlers, settings));
    const call = (args) => handlers.get("yc:alb")({}, args || {});

    stub.created.bg.length = 0;
    const made = await call({ op: "backnew", name: "web-backends-9", kind: "http", targetGroup: "web-targets", port: 8080 });
    assert.strictEqual(made.ok, true, "канал отказал на создании группы бэкендов: " + (made.error || ""));
    assert.strictEqual(stub.created.bg.length, 1);
    assert.ok(made.groupId, "id созданной группы не вернулся окну");
    assert.ok((made.warnings || []).some((w) => /routernew/.test(w)), "канал потерял предупреждения");

    const health = await call({ op: "health", lb: "web-lb", targetGroup: "web-targets" });
    assert.strictEqual(health.ok, true, "канал отказал на здоровье: " + (health.error || ""));
    assert.strictEqual(health.healthy, 1);
    assert.ok(health.lines.some((l) => /здоровых: 1/.test(l)), health.lines.join(" | "));

    const badHealth = await call({ op: "health", lb: "web-lb", targetGroup: "empty-targets" });
    assert.strictEqual(badHealth.ok, false);
    assert.ok(/не ссылается на группу целей/.test(badHealth.error), badHealth.error);

    const d = await call({ op: "backdel", group: "web-backends" });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.needsConfirm, true, "удаление группы бэкендов не спрашивает человека");
    assert.ok(/необратимо/.test(d.error), d.error);
    assert.ok((d.lines || []).some((l) => /web-backends/.test(l)), (d.lines || []).join(" | "));
    assert.ok(!stub.calls.some((c) => c.method === "DELETE" && c.url === "/apploadbalancer/v1/backendGroups/bg-web"), "группа удалена без согласия");
    const busy = await call({ op: "backdel", group: "web-backends", confirm: true });
    assert.strictEqual(busy.ok, false, "занятая группа удалена по согласию вопреки проверке");
    assert.ok(/ещё работает/.test(busy.error), busy.error);
    const free = await call({ op: "backdel", group: "free-backends", confirm: true });
    assert.strictEqual(free.ok, false, "группа с потоковым слушателем удалена");
    assert.ok(/слушатель балансировщика/.test(free.error), free.error);
  });

  await test("yc:alb: создание балансировщика без согласия — вопрос с ценой, а не запрос в облако", async () => {
    const handlers = new Map();
    const settings = settingsFor();
    registerYcIpc(ipcDeps(handlers, settings));
    const call = (args) => handlers.get("yc:alb")({}, args || {});

    stub.created.lb.length = 0;
    const ask = await call({ op: "lbnew", name: "lb-9", subnet: "app-subnet", listener: "http", router: "main-router" });
    assert.strictEqual(ask.ok, false);
    assert.strictEqual(ask.needsConfirm, true, "канал не помечает, что нужен вопрос человеку");
    assert.ok(/ПЛАТНЫЙ/.test(ask.error) && /за час/.test(ask.error), "цена не названа: " + ask.error);
    assert.ok(ask.lines.some((l) => /Слушатель: http/.test(l) && /порт 80/.test(l)), "слушатель не назван в вопросе: " + ask.lines.join(" | "));
    assert.strictEqual(stub.created.lb.length, 0, "балансировщик создан без согласия");

    const ok = await call({ op: "lbnew", name: "lb-9", subnet: "app-subnet", listener: "http", router: "main-router", port: 8080, confirm: true });
    assert.strictEqual(ok.ok, true, "согласованное создание отказало: " + (ok.error || ""));
    assert.strictEqual(stub.created.lb.length, 1);
    assert.ok(ok.lbId, "id созданного балансировщика не вернулся окну");
    assert.ok((ok.warnings || []).length >= 2, "предупреждения о деньгах и адресе потерялись");

    const d = await call({ op: "lbdel", lb: "web-lb" });
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.needsConfirm, true);
    assert.ok(/необратимо/.test(d.error) && /слушателями и адресами/.test(d.error), "последствия удаления не названы: " + d.error);
  });

  await test("yc:alb: без токена и без каталога канал отвечает словами, а не падением", async () => {
    const handlers = new Map();
    registerYcIpc(ipcDeps(handlers, settingsFor({ yandexOauthToken: "" })));
    const call = (args) => handlers.get("yc:alb")({}, args || {});
    const needAuth = await call({ op: "list" });
    assert.strictEqual(needAuth.ok, false);
    assert.ok(/OAuth-токен/.test(needAuth.error), "о токене не сказано: " + needAuth.error);
    assert.ok(/Yandex Cloud/.test(needAuth.error), "отказ не назвал сервис: " + needAuth.error);

    const handlers2 = new Map();
    registerYcIpc(ipcDeps(handlers2, settingsFor({ ycFolderId: "" })));
    const noFolder = await handlers2.get("yc:alb")({}, { op: "list" });
    assert.strictEqual(noFolder.ok, false);
    assert.ok(/Не выбран каталог/.test(noFolder.error), noFolder.error);
  });

  console.log("\n[6x] Инструмент агента ycAlb");

  await test("ycAlb (агент): список объясняет четыре ресурса и порядок работы", async () => {
    const tools = buildTools();
    const out = await tools.ycAlb({ action: "list" });
    assert.ok(/Балансировщики/.test(out) && /web-lb/.test(out), out);
    assert.ok(/адреса его СЛУШАТЕЛЕЙ/.test(out), "не сказано, откуда берётся адрес: " + out);
    assert.ok(/платит за час/.test(out), "цена не названа: " + out);
    const targets = await tools.ycAlb({ action: "targets" });
    assert.ok(/ТОЛЬКО адрес и подсеть/.test(targets), "не сказано, что знает группа целей: " + targets);
    const backends = await tools.ycAlb({ action: "backends" });
    assert.ok(/ПОРТ целей/.test(backends) && /backnew/.test(backends) && /health/.test(backends), backends);
  });

  await test("ycAlb (агент): роутер без группы бэкендов объясняется, а не выдумывается", async () => {
    const tools = buildTools();
    const out = await tools.ycAlb({ action: "routernew", name: "main-router", backendGroup: "bg-dream" });
    assert.ok(/группу бэкендов, а её нет/.test(out), out);
    assert.ok(/web-backends/.test(out), "не перечислены существующие группы бэкендов: " + out);
  });

  await test("ycAlb (агент): создание балансировщика без согласия называет цену и не трогает облако", async () => {
    const tools = buildTools();
    stub.created.lb.length = 0;
    const out = await tools.ycAlb({ action: "lbnew", name: "lb-7", subnet: "app-subnet", router: "main-router" });
    assert.ok(/confirm: true/.test(out), out);
    assert.ok(/за час/.test(out) && /ycBilling/.test(out), "цена не названа: " + out);
    assert.strictEqual(stub.created.lb.length, 0, "балансировщик создан без согласия человека");

    const del = await tools.ycAlb({ action: "lbdel", lb: "web-lb" });
    assert.ok(/необратимо/.test(del) && /confirm: true/.test(del), del);

    const unknown = await tools.ycAlb({ action: "nope" });
    assert.ok(/неизвестное действие ycAlb/.test(unknown), unknown);
    assert.ok(/Доступно: list, card, targets, routers, backends/.test(unknown), unknown);
    const noToken = buildTools({ yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await noToken.ycAlb({ action: "list" })), "молчание вместо отказа без токена");
  });

  await test("ycAlb (агент): группа целей создаётся, а цель убирается — настоящими телами", async () => {
    const tools = buildTools();
    stub.created.tg.length = 0;
    stub.created.targets.length = 0;
    const created = await tools.ycAlb({ action: "targetnew", name: "web-targets-3", ips: ["10.10.0.5"], subnet: "app-subnet" });
    assert.strictEqual(stub.created.tg.length, 1);
    assert.ok(/целей 1/.test(created), created);
    const removed = await tools.ycAlb({ action: "targetremove", group: "web-targets", ips: ["10.10.0.5"] });
    assert.strictEqual(stub.created.targets[0].action, "removeTargets");
    assert.ok(/убрано целей: 1/.test(removed), removed);
  });

  await test("ycAlb (агент): группу бэкендов можно собрать, а здоровье — спросить", async () => {
    const tools = buildTools();
    stub.created.bg.length = 0;
    const made = await tools.ycAlb({ action: "backnew", name: "web-backends-3", targetGroup: "web-targets", port: 8080 });
    assert.strictEqual(stub.created.bg.length, 1, "группа не создана инструментом");
    assert.ok(/порт 8080/.test(made) && /web-targets/.test(made), made);
    const health = await tools.ycAlb({ action: "health", lb: "web-lb", targetGroup: "web-targets" });
    assert.ok(/здоровых: 1/.test(health), "здоровье не показано: " + health);
    assert.ok(/ru-central1-b: не отвечает/.test(health), health);
    const del = await tools.ycAlb({ action: "backdel", group: "web-backends" });
    assert.ok(/confirm: true/.test(del) && /необратимо/.test(del), del);
    const busy = await tools.ycAlb({ action: "backdel", group: "web-backends", confirm: true });
    assert.ok(/ещё работает/.test(busy) && /main-router/.test(busy), "занятую группу инструмент не защитил: " + busy);
    const noTg = await tools.ycAlb({ action: "backnew", name: "bg-x", targetGroup: "нет-такой" });
    assert.ok(/нужна группа целей/.test(noTg) && /web-targets/.test(noTg), noTg);
    const unknown = await tools.ycAlb({ action: "nope" });
    assert.ok(/Доступно: list, card, targets, routers, backends, health/.test(unknown), unknown);
  });

  console.log("\n[7x] Интерфейс: семейство действий, плитка полки и связи консоли");

  await test("yc-actions: семейство «Application Load Balancer» зовёт канал и помечает платное и опасное", () => {
    const ctx = { window: {}, document: undefined, navigator: {}, console: console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(ACTIONS_SRC, ctx, { filename: "yc-actions.js" });
    const A = ctx.window.YcActions;
    assert.strictEqual(A.CHANNELS.alb, "ycAlb", "семейство смотрит не в тот канал");
    const ids = A.forService("alb");
    for (const need of ["list", "card", "targets", "routers", "backends", "health", "targetnew", "targetadd", "targetremove", "targetdel", "routernew", "routerdel", "backnew", "backdel", "listeneradd", "listenerupd", "listenerdel", "lbupdate", "lbnew", "lbstart", "lbstop", "lbdel"]) {
      assert.ok(ids.indexOf(need) >= 0, "в семействе нет действия " + need);
    }
    const addListener = A.describe("alb", "listeneradd");
    for (const field of ["listenerName", "listener", "port", "router", "certificate", "backendGroup", "address"]) {
      assert.ok(addListener.fields.indexOf(field) >= 0, "в форме добавления слушателя нет поля " + field);
    }
    const addAction = A.actionsFor("alb").find((x) => x.id === "listeneradd");
    assert.strictEqual(addAction.target.key, "lb", "у добавления слушателя нет цели-балансировщика");
    assert.strictEqual(addListener.confirmArg, "", "добавление слушателя не платное — согласие тут только мешало бы");
    assert.strictEqual(A.describe("alb", "listenerdel").danger, true, "удаление слушателя не помечено опасным");
    assert.strictEqual(A.describe("alb", "listenerdel").confirmArg, "confirm", "удаление слушателя не спрашивает согласие");
    const updListener = A.describe("alb", "lbupdate");
    assert.ok(updListener.fields.indexOf("newName") >= 0 && updListener.fields.indexOf("description") >= 0 && updListener.fields.indexOf("securityGroups") >= 0, "в форме правки балансировщика не хватает полей: " + updListener.fields.join(", "));
    const addReq = A.request("alb", "listeneradd", { lb: "web-lb", listenerName: "api", listener: "http", port: "8080" }, false);
    assert.strictEqual(addReq.args.op, "listeneradd");
    assert.strictEqual(addReq.args.lb, "web-lb", "балансировщик не ушёл в добавление слушателя");
    assert.strictEqual(addReq.args.listenerName, "api", "имя слушателя не ушло");
    assert.strictEqual(addReq.args.port, 8080, "порт не число");
    assert.strictEqual(addReq.args.confirm, undefined, "лишний confirm у добавления слушателя");
    const delReq = A.request("alb", "listenerdel", { lb: "web-lb", listenerName: "api" }, true);
    assert.strictEqual(delReq.args.op, "listenerdel");
    assert.strictEqual(delReq.args.listenerName, "api");
    assert.strictEqual(delReq.args.confirm, true, "согласие на удаление слушателя не ушло");
    const updReq = A.request("alb", "lbupdate", { lb: "web-lb", newName: "edge-lb", securityGroups: "sg-1, sg-2" }, false);
    assert.strictEqual(updReq.args.op, "lbupdate");
    assert.strictEqual(updReq.args.newName, "edge-lb");
    assert.strictEqual(updReq.args.securityGroups, "sg-1, sg-2", "группы безопасности не ушли в правку");
    const create = A.describe("alb", "lbnew");
    assert.strictEqual(create.paid, true, "создание балансировщика не помечено платным");
    assert.strictEqual(create.confirmArg, "confirm", "форма не назвала аргумент согласия");
    for (const field of ["name", "subnet", "listener", "port", "router", "certificate", "backendGroup", "securityGroups"]) {
      assert.ok(create.fields.indexOf(field) >= 0, "в форме создания нет поля " + field);
    }
    assert.strictEqual(A.describe("alb", "lbdel").danger, true, "удаление балансировщика не помечено опасным");
    assert.strictEqual(A.describe("alb", "targetdel").danger, true, "удаление группы целей не помечено опасным");
    assert.strictEqual(A.describe("alb", "routerdel").danger, true, "удаление роутера не помечено опасным");
    assert.strictEqual(A.describe("alb", "targetnew").paid, false, "группа целей не платная — пометка о плате сбивала бы человека");
    assert.strictEqual(A.describe("alb", "backdel").danger, true, "удаление группы бэкендов не помечено опасным");
    assert.strictEqual(A.describe("alb", "backnew").paid, false, "группа бэкендов не платная");
    const health = A.describe("alb", "health");
    assert.ok(health.fields.indexOf("backendGroup") >= 0 && health.fields.indexOf("targetGroup") >= 0, "в форме здоровья нет полей пары: " + health.fields.join(", "));
    const reqHealth = A.request("alb", "health", { lb: "web-lb", backendGroup: "web-backends", targetGroup: "web-targets" }, false);
    assert.strictEqual(reqHealth.channel, "ycAlb");
    assert.strictEqual(reqHealth.args.op, "health");
    assert.strictEqual(reqHealth.args.lb, "web-lb", "балансировщик не ушёл в запрос здоровья");
    assert.strictEqual(reqHealth.args.targetGroup, "web-targets", "группа целей не ушла в запрос здоровья");
    assert.strictEqual(reqHealth.args.backendGroup, "web-backends", "группа бэкендов не ушла в запрос здоровья");
    const req = A.request("alb", "lbdel", { lb: "web-lb" }, true);
    assert.strictEqual(req.channel, "ycAlb");
    assert.strictEqual(req.args.op, "lbdel");
    assert.strictEqual(req.args.confirm, true, "согласие не ушло в канал");
    assert.strictEqual(A.request("alb", "lbdel", { lb: "web-lb" }, false).args.confirm, undefined, "лишний confirm: false сбил бы проверку канала");
    assert.ok(A.FAMILIES.alb && /Application Load Balancer/.test(A.FAMILIES.alb.title), "у семейства нет имени");
  });

  await test("полка: плитка «Балансировщики» со знаком сервиса из библиотеки", () => {
    const svc = yandex.SERVICES.find((s) => s.key === "alb");
    assert.ok(svc, "нет сервиса alb в SERVICES");
    assert.ok(/[А-Яа-яЁё]/.test(svc.ru), "плитка названа не по-русски: " + svc.ru);
    assert.strictEqual(svc.svc, "alb", "плитка смотрит не на тот сервис: " + svc.svc);
    assert.ok(svc.listPath.indexOf("/apploadbalancer/v1/loadBalancers") === 0, "плитка смотрит не на балансировщики: " + svc.listPath);
    assert.strictEqual(svc.listKey, "loadBalancers");
    assert.ok(YANDEX_SRC.indexOf('"alb": "https://alb.api.cloud.yandex.net"') > 0, "нет выверенного адреса ALB в KNOWN_ENDPOINTS");
    assert.ok(LOGOS.has("alb"), "у плитки нет знака сервиса");
    assert.ok(/viewBox=\"0 0 32 32\"/.test(LOGOS.LOGOS.alb), "знак не 32×32");
    assert.ok(LOGOS.isSafe(LOGOS.LOGOS.alb), "в знаке что-то исполняемое");
    assert.ok(/Application Load Balancer/.test(LOGOS.official("alb")), "у знака нет официального имени: " + LOGOS.official("alb"));
    assert.ok(PANEL_SRC.indexOf('alb: ["балансировщик"') > 0, "в полке нет русской формы слова для балансировщика");
  });

  await test("консоль и дашборд видят один набор: у балансировщика есть карточка и связи", () => {
    assert.strictEqual(ycConsole.SERVICE_ENDPOINT.alb, "alb", "консоль не знает, куда идти за балансировщиком");
    assert.ok(ycConsole.DETAIL_PATHS.alb, "у карточки балансировщика нет пути");
    assert.strictEqual(ycConsole.DETAIL_PATHS.alb({ id: "alb-1" }), "/apploadbalancer/v1/loadBalancers/alb-1");
    const rel = ycConsole.RELATIONS.alb.map((r) => r.key).sort();
    assert.deepStrictEqual(rel, ["backends", "routers", "targets"], "связи балансировщика: " + rel.join(", "));
    const targets = ycConsole.RELATIONS.alb.find((r) => r.key === "targets").attempts[0].path({ folderId: "folder-1" });
    assert.ok(targets.indexOf("/apploadbalancer/v1/targetGroups?folderId=folder-1") === 0, "группы целей читаются не из каталога: " + targets);
    const table = ycConsole.buildTable("alb", "targets", [{ name: "web-targets", targetCount: 2, age: "1 дн" }], Date.now());
    assert.deepStrictEqual(table.columns.map((c) => c.key), ["name", "targetCount", "age"], "колонки групп целей: " + table.columns.map((c) => c.key).join(", "));
    assert.ok(SMOKE_SRC.indexOf('"yc:alb"') > 0, "сторож smoke не знает канал yc:alb");
    assert.ok(/каналов в мосте должно быть 33/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(SMOKE_SRC.indexOf('"ycAlb"') > 0, "сторож smoke не знает инструмент ycAlb");
  });

  console.log("\n[8] Согласованность: схема, промпт, политика, справочник и цепочка");

  await test("ycAlb: схема, группа «облако», промпт и права знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycAlb"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    // Границы записи, а не число знаков: окно в 7400 ломалось от каждого нового
    // поля схемы (заход 5 части 91 добавил sni), хотя проверяемое свойство —
    // «схема знает эти поля» — не менялось.
    const end = SCHEMAS_SRC.indexOf('type: "function"', at + 10);
    const schema = SCHEMAS_SRC.slice(at, end > at ? end : at + 7400);
    for (const part of ["action", "lb", "listenerName", "newName", "group", "router", "name", "ips", "subnet", "listener", "port", "certificate", "backendGroup", "targetGroup", "kind", "healthPath", "host", "pathPrefix", "address", "sni", "securityGroups", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/listeneradd/.test(schema) && /listenerupd/.test(schema) && /listenerdel/.test(schema) && /lbupdate/.test(schema), "схема не знает правку слушателей и балансировщика");
    assert.ok(/СОСТАВ СЛУШАТЕЛЕЙ меняют точечно/.test(schema), "схема не объясняет, что состав слушателей меняют точечно, а не перезаписью списка");
    assert.ok(/ЧЕТЫРЕ разных ресурса/.test(schema), "схема не объясняет, что ресурсов четыре");
    assert.ok(/ПОРТ целей и проверки здоровья/.test(schema), "схема молчит о порте целей и проверках здоровья");
    assert.ok(/action health/.test(schema), "схема не знает про здоровье целей");
    assert.ok(/confirm: true/.test(schema) && /ПЛАТНЫЙ/.test(schema), "схема молчит про цену и согласие");
    const groupAt = CORE_SRC.indexOf('id: "cloud"');
    const group = CORE_SRC.slice(groupAt, groupAt + 2200);
    assert.ok(group.includes('"ycAlb"'), "инструмента нет в группе «облако»");
    assert.ok(/балансировщик/.test(group), "в ключевых словах группы нет балансировщика");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycAlb/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycAlb \(ВХОД В ПРИЛОЖЕНИЕ/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycAlb");
    const promptAlb = PROMPTS_SRC.slice(PROMPTS_SRC.indexOf("ycAlb (ВХОД"), PROMPTS_SRC.indexOf("ycAlb (ВХОД") + 4000);
    assert.ok(/группа целей/i.test(promptAlb), "промпт не объясняет группу целей");
    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 400).includes('"ycAlb"'), "нет назначения cloud.read для ycAlb");
  });

  await test("ycAlb: справочник агента учит порядку работы, цене и тому, где искать группы бэкендов", () => {
    assert.ok(/ycAlb \{ action/.test(GUIDE_SRC), "в yc.md нет пункта ycAlb");
    assert.ok(/ВХОД В ПРИЛОЖЕНИЕ С УЛИЦЫ/.test(GUIDE_SRC), "в yc.md не сказано, что это за ресурс");
    assert.ok(/ЧЕТЫРЕ разных ресурса/.test(GUIDE_SRC), "в yc.md не перечислены четыре ресурса");
    assert.ok(/СУЩЕСТВУЮЩАЯ группа бэкендов/.test(GUIDE_SRC), "в yc.md не сказано, что роутеру нужна существующая группа бэкендов");
    assert.ok(/платит БАЛАНСИРОВЩИК/.test(GUIDE_SRC), "в yc.md нет правила про цену");
    assert.ok(/адреса его СЛУШАТЕЛЕЙ/.test(GUIDE_SRC), "в yc.md не сказано, откуда берётся адрес");
    assert.ok(/ПО ЗОНАМ/.test(GUIDE_SRC), "в yc.md не сказано, что здоровье приходит по зонам");
    assert.ok(/backnew/.test(GUIDE_SRC) && /backdel/.test(GUIDE_SRC) && /`health`/.test(GUIDE_SRC), "в yc.md нет новых действий группы бэкендов");
    assert.ok(/`listeneradd`/.test(GUIDE_SRC) && /`listenerupd`/.test(GUIDE_SRC) && /`listenerdel`/.test(GUIDE_SRC) && /`lbupdate`/.test(GUIDE_SRC), "в yc.md нет точечной правки слушателей и балансировщика");
    assert.ok(/ЗАМЕНЯЕТСЯ целиком/.test(GUIDE_SRC), "в yc.md не сказано, что группы безопасности ЗАМЕНЯЮТСЯ целиком");
    assert.ok(/сертификат, его домены и срок/.test(GUIDE_SRC), "в yc.md не сказано, что карточка показывает срок сертификата");
  });

  await test("ycAlb: набор стоит в цепочке npm test — иначе это не набор", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-alb.test.js") >= 0, "набора нет в цепочке npm test");
  });

  console.log("\n[9] Правка слушателей, групп безопасности и HTTPS-карточка");

  await test("ycAlb: слушатель добавляется точечно (:addListener) и подтверждается перечитыванием", async () => {
    stub.created.listenerOps.length = 0;
    const r = await alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "api2", listener: "http", port: 8080, router: "main-router" });
    assert.strictEqual(stub.created.listenerOps.length, 1, "запрос добавления не ушёл");
    const op = stub.created.listenerOps[0];
    assert.strictEqual(op.action, "addListener");
    assert.strictEqual(op.lb, "alb-web");
    assert.ok(op.body.listenerSpec, "тело без listenerSpec — облако не поймёт, что добавлять");
    assert.strictEqual(op.body.listenerSpec.name, "api2");
    assert.strictEqual(op.body.listenerSpec.http.handler.httpRouterId, "router-1");
    assert.deepStrictEqual(op.body.listenerSpec.endpointSpecs[0].ports, ["8080"]);
    assert.strictEqual(op.body.listenerSpecs, undefined, "вместе со слушателем ушёл ВЕСЬ список: остальные были бы стёрты");
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.listenerName, "api2");
    const after = await alb.loadBalancer("oauth-1", "alb-web");
    assert.strictEqual(after.listeners.length, 2, "второй слушатель не появился: " + after.listeners.map((l) => l.name).join(", "));
    assert.ok(after.listeners.some((l) => l.name === "api2" && l.kind === "http"), "разбор добавленного слушателя не сошёлся");
    assert.ok(/получает слушателя «api2»/.test(r.message) && /HTTP/.test(r.message) && /порт 8080/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /выдаёт облако/.test(w)), "не сказано, откуда возьмётся адрес: " + r.warnings.join(" | "));
  });

  await test("ycAlb: HTTPS-слушатель ищет ВЫПУЩЕННЫЙ сертификат — и это отказ до сети", async () => {
    const before = writes(stub).length;
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "s1", listener: "https", router: "main-router" }), /нужен сертификат/);
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "s1", listener: "https", router: "main-router", certificate: "нет-такого" }), /Не нашёл сертификат/);
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "s1", listener: "https", router: "main-router", certificate: "old-cert" }),
      (e) => /ещё не выпущен/.test(e.message) && /VALIDATING/.test(e.message)
    );
    assert.strictEqual(writes(stub).length, before, "слушатель ушёл в облако без годного сертификата");
    const r = await alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "secure2", listener: "https", router: "main-router", certificate: "site-cert" });
    const op = stub.created.listenerOps.slice(-1)[0];
    assert.strictEqual(op.body.listenerSpec.tls.defaultHandler.certificateIds[0], "cert-1", "в слушатель ушёл сертификат не из каталога");
    assert.deepStrictEqual(op.body.listenerSpec.endpointSpecs[0].ports, ["443"], "у HTTPS не тот порт по умолчанию");
    assert.strictEqual(op.body.listenerSpec.http, undefined, "у TLS-слушателя появился второй вид");
    assert.ok(r.warnings.some((w) => /Сертификат должен оставаться выпущенным/.test(w)), r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /Порт 443 обязан быть открыт/.test(w)), r.warnings.join(" | "));
    // Вторая HTTPS-проверка нужна карточке: сертификат, который скоро истечёт.
    await alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "soon2", listener: "https", router: "main-router", certificate: "soon-cert" });
  });

  await test("ycAlb: потоковому слушателю и при добавлении — только группа вида stream", async () => {
    const before = writes(stub).length;
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "tcp3", listener: "stream", port: 5432, backendGroup: "web-backends" }),
      /группа вида stream/
    );
    assert.strictEqual(writes(stub).length, before, "поток с HTTP-группой ушёл в облако");
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "tcp3", listener: "stream", port: 5432 }), /нужна группа бэкендов/);
    const r = await alb.addListener("oauth-1", { folderId: "folder-1", lb: "stream-lb", listenerName: "tcp2", listener: "stream", port: 5433, backendGroup: "free-backends" });
    const op = stub.created.listenerOps.slice(-1)[0];
    assert.strictEqual(op.body.listenerSpec.stream.handler.backendGroupId, "bg-free");
    assert.ok(r.warnings.some((w) => /порт слушателя должен совпадать/.test(w)), r.warnings.join(" | "));
    const after = await alb.loadBalancer("oauth-1", "alb-stream");
    assert.ok(after.listeners.some((l) => l.name === "tcp2" && l.kind === "stream"), "потоковый слушатель не появился");
  });

  await test("ycAlb: занятый балансировщик, чужое имя и кривые значения отбиваются ДО сети", async () => {
    const before = writes(stub).length;
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "busy-lb", listenerName: "x1", listener: "http", router: "main-router" }), /занят/);
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "api2", listener: "http", router: "main-router" }),
      (e) => /уже есть слушатель/.test(e.message) && /api2/.test(e.message)
    );
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "1bad", listener: "http", router: "main-router" }), /облако не примет/);
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "p1", listener: "http", port: 70000, router: "main-router" }), /от 1 до 65535/);
    await assert.rejects(() => alb.addListener("oauth-1", { folderId: "folder-1", lb: "web-lb", listenerName: "u1", listener: "udp", port: 80, router: "main-router" }), /http, https или stream/);
    assert.strictEqual(writes(stub).length, before, "негодное добавление всё-таки ушло в облако");
  });

  await test("ycAlb: правка балансировщика уходит PATCH с маской — и не трогает слушателей", async () => {
    stub.created.lbPatches.length = 0;
    const r = await alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "web-lb", newName: "edge-lb", description: "витрина 2", securityGroups: "ssh" });
    assert.strictEqual(stub.created.lbPatches.length, 1, "PATCH не ушёл");
    const patch = stub.created.lbPatches[0];
    assert.strictEqual(patch.lb, "alb-web");
    assert.strictEqual(patch.body.updateMask, "name,description,security_group_ids", "маска полей не та: " + patch.body.updateMask);
    assert.strictEqual(patch.body.name, "edge-lb");
    assert.strictEqual(patch.body.description, "витрина 2");
    assert.deepStrictEqual(patch.body.securityGroupIds, ["sg-2"], "группа безопасности не разрешена в id (по имени ssh)");
    assert.strictEqual(patch.body.listenerSpecs, undefined, "PATCH понёс ВЕСЬ список слушателей — он стёр бы всех, кого нет в теле");
    assert.ok(r.warnings.some((w) => /ЗАМЕНЁН целиком/.test(w)), r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /подпись, а не адрес/.test(w)), r.warnings.join(" | "));
    assert.ok(/обновляется: имя, описание, группы безопасности/.test(r.message), r.message);
    const renamed = await alb.findLoadBalancer("oauth-1", "folder-1", "edge-lb");
    assert.ok(renamed && renamed.listeners.length === 3, "переименование потеряло слушателей: " + (renamed ? renamed.listeners.length : "балансировщик не найден"));
    // Поля «через запятую» из окна тоже разбираются (иначе группа искалась бы целой строкой).
    stub.created.lbPatches.length = 0;
    await alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "edge-lb", securityGroups: "sg-1, ssh" });
    assert.deepStrictEqual(stub.created.lbPatches[0].body.securityGroupIds, ["sg-1", "sg-2"], "строка «через запятую» не разобрана на группы");
  });

  await test("ycAlb: «облако промолчало» — это ошибка, а не успех (перечитывание)", async () => {
    stub.flags.dropAdd = true;
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "silent", listener: "http", router: "main-router" }),
      (e) => /не появился/.test(e.message) && /alb\.editor/.test(e.message)
    );
    stub.flags.dropAdd = false;
    stub.flags.dropRemove = true;
    await assert.rejects(
      () => alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "api2" }),
      (e) => /остался/.test(e.message) && /alb\.editor/.test(e.message)
    );
    stub.flags.dropRemove = false;
    stub.flags.dropPatch = true;
    await assert.rejects(
      () => alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "edge-lb", newName: "edge-lb-2" }),
      (e) => /не применилась/.test(e.message) && /alb\.editor/.test(e.message)
    );
    stub.flags.dropPatch = false;
    const same = await alb.findLoadBalancer("oauth-1", "folder-1", "edge-lb");
    assert.ok(same && same.name === "edge-lb", "молчащая правка всё-таки изменила имя");
  });

  await test("ycAlb: нечего менять и негодные значения — отказ ДО сети, а не пустой PATCH", async () => {
    const before = stub.created.lbPatches.length;
    await assert.rejects(() => alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "edge-lb" }), /Нечего менять/);
    await assert.rejects(() => alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "edge-lb", newName: "edge-lb" }), /уже называется/);
    await assert.rejects(() => alb.updateLoadBalancer("oauth-1", { folderId: "folder-1", lb: "edge-lb", securityGroups: ["нет-такой"] }), /Не нашёл группу безопасности/);
    assert.strictEqual(stub.created.lbPatches.length, before, "пустая или негодная правка всё-таки ушла в облако");
  });

  await test("ycAlb: слушатель убирается :removeListener телом из одного имени", async () => {
    stub.created.listenerOps.length = 0;
    const beforeCalls = stub.calls.length;
    const r = await alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "api2" });
    const op = stub.created.listenerOps[0];
    assert.strictEqual(op.action, "removeListener");
    assert.strictEqual(op.lb, "alb-web");
    assert.deepStrictEqual(op.body, { name: "api2" }, "тело удаления — только имя слушателя: " + JSON.stringify(op.body));
    assert.ok(/убирается у балансировщика «edge-lb»/.test(r.message) && /вход по нему закроется/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /Порт 8080 закроется снаружи/.test(w)), r.warnings.join(" | "));
    const after = await alb.loadBalancer("oauth-1", "alb-web");
    assert.ok(!after.listeners.some((l) => l.name === "api2"), "слушатель остался после удаления");
    assert.ok(!stub.calls.slice(beforeCalls).some((c) => c.method === "PATCH"), "удаление слушателя ушло через PATCH — целый список был бы перезаписан");

    const web = await alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "web" });
    assert.ok(web.warnings.some((w) => /Адрес 203\.0\.113\.10 освободится/.test(w)), web.warnings.join(" | "));
    const last = await alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "secure2" });
    assert.ok(last.warnings.some((w) => /не осталось слушателей/.test(w)), "о последнем слушателе не сказано: " + last.warnings.join(" | "));
    assert.ok(last.warnings.some((w) => /Порт 443 закроется снаружи/.test(w)), last.warnings.join(" | "));
    const empty = await alb.loadBalancer("oauth-1", "alb-web");
    assert.strictEqual(empty.listeners.length, 0, "слушатели остались: " + empty.listeners.map((l) => l.name).join(", "));
    await assert.rejects(() => alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "web" }), /нет слушателя/);
    await assert.rejects(() => alb.removeListener("oauth-1", { folderId: "folder-1", lb: "edge-lb" }), /Не указано имя слушателя/);
  });

  await test("ycAlb: карточка HTTPS-слушателя читает сертификаты — домены, срок и «нет в каталоге»", async () => {
    const c = await alb.card("oauth-1", "folder-1", "https-lb");
    assert.ok(c, "карточка https-lb пустая");
    assert.strictEqual(c.certificates.length, 2, "сертификаты слушателей не собраны: " + c.certificates.length);
    const healthy = c.certificates.find((x) => x.listenerName === "secure");
    assert.ok(healthy && healthy.cert.name === "site-cert", "сертификат слушателя secure не найден");
    const healthyLine = alb.certLine(healthy);
    assert.ok(/site-cert/.test(healthyLine) && /домены: site\.example/.test(healthyLine) && /осталось \d+ дн\./.test(healthyLine), healthyLine);
    assert.ok(c.warnings.some((w) => /soon-cert/.test(w) && /истекает/.test(w)), "о скором истечении не сказано: " + c.warnings.join(" | "));
    assert.ok(!c.warnings.some((w) => /site-cert/.test(w)), "здоровый сертификат попал в предупреждения: " + c.warnings.join(" | "));
    const streamCard = await alb.card("oauth-1", "folder-1", "stream-lb");
    assert.ok(streamCard.warnings.some((w) => /cert-gone/.test(w) && /не найден в каталоге/.test(w)), "сертификат, которого нет в каталоге, не назван: " + streamCard.warnings.join(" | "));
  });

  await test("yc:alb: добавление, удаление слушателя и правка идут через настоящий канал", async () => {
    const handlers = new Map();
    registerYcIpc(ipcDeps(handlers, settingsFor()));
    const call = (args) => handlers.get("yc:alb")({}, args || {});

    stub.created.listenerOps.length = 0;
    const added = await call({ op: "listeneradd", lb: "stream-lb", listenerName: "ch1", listener: "http", port: 8081, router: "main-router" });
    assert.strictEqual(added.ok, true, "канал отказал на добавлении слушателя: " + (added.error || ""));
    assert.strictEqual(added.listenerName, "ch1");
    const addOp = stub.created.listenerOps.slice(-1)[0];
    assert.strictEqual(addOp.action, "addListener");
    assert.strictEqual(addOp.body.listenerSpec.name, "ch1", "канал не передал имя слушателя");
    assert.ok((added.lines || []).some((l) => /получает слушателя «ch1»/.test(l)), (added.lines || []).join(" | "));
    assert.ok((added.warnings || []).some((w) => /выдаёт облако/.test(w)), "канал потерял предупреждения добавления");

    const ask = await call({ op: "listenerdel", lb: "stream-lb", listenerName: "ch1" });
    assert.strictEqual(ask.ok, false);
    assert.strictEqual(ask.needsConfirm, true, "удаление слушателя не спросило человека");
    assert.ok(/вход по нему закроется/.test(ask.error), ask.error);
    assert.ok(!stub.created.listenerOps.some((o) => o.action === "removeListener"), "слушатель удалён без согласия");
    const removed = await call({ op: "listenerdel", lb: "stream-lb", listenerName: "ch1", confirm: true });
    assert.strictEqual(removed.ok, true, "канал отказал на удалении слушателя: " + (removed.error || ""));
    assert.strictEqual(stub.created.listenerOps.slice(-1)[0].action, "removeListener");

    stub.created.lbPatches.length = 0;
    const upd = await call({ op: "lbupdate", lb: "stream-lb", newName: "stream-lb-2", securityGroups: "sg-2" });
    assert.strictEqual(upd.ok, true, "канал отказал на правке балансировщика: " + (upd.error || ""));
    assert.deepStrictEqual(upd.fields, ["name", "security_group_ids"]);
    const patch = stub.created.lbPatches.slice(-1)[0];
    assert.strictEqual(patch.lb, "alb-stream");
    assert.strictEqual(patch.body.updateMask, "name,security_group_ids");
    assert.deepStrictEqual(patch.body.securityGroupIds, ["sg-2"]);

    const unknown = await call({ op: "nope" });
    assert.ok(/Доступно: list, card, targets, routers, backends/.test(unknown.error), unknown.error);
  });

  await test("ycAlb (агент): слушатели и балансировщик правятся действиями инструмента", async () => {
    const tools = buildTools();
    stub.created.listenerOps.length = 0;
    const added = await tools.ycAlb({ action: "listeneradd", lb: "stream-lb-2", name: "tool1", listener: "http", port: 8082, router: "main-router" });
    assert.ok(/получает слушателя «tool1»/.test(added), added);
    assert.ok(/состав слушателей НЕ переписывается/.test(added), "инструмент не сказал, что список не перезаписывается: " + added);
    assert.strictEqual(stub.created.listenerOps.slice(-1)[0].body.listenerSpec.name, "tool1", "имя слушателя не доехало до облака");
    const ask = await tools.ycAlb({ action: "listenerdel", lb: "stream-lb-2", listenerName: "tool1" });
    assert.ok(/confirm: true/.test(ask), "удаление слушателя не просит подтверждения: " + ask);
    assert.ok(!stub.created.listenerOps.some((o) => o.action === "removeListener"), "слушатель удалён без согласия");
    const done = await tools.ycAlb({ action: "listenerdel", lb: "stream-lb-2", listenerName: "tool1", confirm: true });
    assert.ok(/убирается у балансировщика/.test(done), done);
    const upd = await tools.ycAlb({ action: "lbupdate", lb: "stream-lb-2", description: "поток для баз" });
    assert.ok(/обновляется: описание/.test(upd), upd);
    assert.ok(/С МАСКОЙ полей/.test(upd), "инструмент не сказал про маску: " + upd);
  });

  console.log("\n[10] Правка слушателя (:updateListener) и SNI-домены");

  await test("ycAlb: слушатель правится :updateListener с маской — и продление сертификата не трогает остальное", async () => {
    stub.created.listenerOps.length = 0;
    const r = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "secure", certificate: "fresh-cert" });
    assert.strictEqual(stub.created.listenerOps.length, 1, "запрос правки слушателя не ушёл");
    const op = stub.created.listenerOps[0];
    assert.strictEqual(op.action, "updateListener");
    assert.strictEqual(op.lb, "alb-https");
    assert.strictEqual(op.body.updateMask, "name,endpoint_specs,tls", "маска правки слушателя не та: " + op.body.updateMask);
    assert.deepStrictEqual(r.fields, ["name", "endpoint_specs", "tls"]);
    assert.strictEqual(op.body.listenerSpec.name, "secure", "слушатель опознаётся по имени — оно не должно меняться");
    assert.strictEqual(op.body.listenerSpec.tls.defaultHandler.certificateIds[0], "cert-5", "новый сертификат не доехал");
    assert.deepStrictEqual(op.body.listenerSpec.endpointSpecs[0].ports, ["443"], "порт, которого не называли, изменился");
    assert.strictEqual(op.body.listenerSpec.endpointSpecs[0].addressSpecs[0].externalIpv4AddressSpec.address, "203.0.113.11", "адрес слушателя не сохранён: домены смотрят именно на него");
    assert.strictEqual(op.body.listenerSpec.http, undefined, "у TLS-слушателя появился второй вид");
    assert.strictEqual(op.body.listenerSpecs, undefined, "вместе с правкой ушёл ВЕСЬ список слушателей");
    assert.ok(/обновляется: сертификат cert-5/.test(r.message), r.message);
    assert.ok(r.warnings.some((w) => /Сертификат должен оставаться выпущенным/.test(w)), r.warnings.join(" | "));
    const after = await alb.loadBalancer("oauth-1", "alb-https");
    const got = after.listeners.find((l) => l.name === "secure");
    assert.ok(got && got.certificateIds.indexOf("cert-5") >= 0, "перечитывание не показывает новый сертификат");
    assert.deepStrictEqual(got.ports, ["443"], "порт уехал: " + got.ports.join(","));
    assert.strictEqual(got.routerId, "router-1", "роутер потерян при правке");
    // Переименовать слушателя нельзя: такого поля у метода нет — говорим об этом словами.
    await assert.rejects(() => alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "nope", port: 443 }), (e) => /нет слушателя/.test(e.message) && /Переименовать слушателя нельзя/.test(e.message));
    await assert.rejects(() => alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", port: 443 }), /Не указано имя слушателя/);
    await assert.rejects(() => alb.updateListener("oauth-1", { folderId: "folder-1", lb: "busy-lb", listenerName: "x", port: 443 }), /занят/);
  });

  await test("ycAlb: перевод HTTP на HTTPS меняет вид — в маске оказывается СТАРЫЙ вид", async () => {
    await alb.addListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "www", listener: "http", port: 80, router: "main-router" });
    stub.created.listenerOps.length = 0;
    const r = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "www", listener: "https", certificate: "site-cert" });
    const op = stub.created.listenerOps[0];
    assert.strictEqual(op.body.updateMask, "name,endpoint_specs,tls,http", "старый вид не попал в маску — облако оставило бы у слушателя ДВА вида: " + op.body.updateMask);
    assert.ok(op.body.listenerSpec.tls, "в теле нет TLS-обработчика");
    assert.strictEqual(op.body.listenerSpec.http, undefined, "в теле остался HTTP-обработчик");
    assert.deepStrictEqual(op.body.listenerSpec.endpointSpecs[0].ports, ["80"], "порт, которого не называли, изменился");
    assert.ok(r.warnings.some((w) => /Вид слушателя заменён целиком/.test(w)), r.warnings.join(" | "));
    const after = await alb.loadBalancer("oauth-1", "alb-web");
    const got = after.listeners.find((l) => l.name === "www");
    assert.ok(got && got.kind === "tls", "после правки слушатель не HTTPS: " + (got ? got.kindHuman : "нет слушателя"));
    assert.deepStrictEqual(got.certificateIds, ["cert-1"]);
    assert.strictEqual(got.routerId, "router-1", "роутер не сохранён при смене вида");
  });

  await test("ycAlb: несколько доменов на одном HTTPS-слушателе — SNI со СВОИМ сертификатом у каждого", async () => {
    stub.created.listenerOps.length = 0;
    const r = await alb.addListener("oauth-1", {
      folderId: "folder-1", lb: "https-lb", listenerName: "shop", listener: "https", port: 443, router: "main-router", certificate: "site-cert",
      sni: "shop.example.com=shop-cert\nwww.example.com,example.com=site-cert",
    });
    const tls = stub.created.listenerOps[0].body.listenerSpec.tls;
    assert.strictEqual(tls.sniHandlers.length, 2, "SNI-обработчиков не два: " + tls.sniHandlers.length);
    assert.strictEqual(tls.defaultHandler.certificateIds[0], "cert-1", "основной сертификат не тот");
    const shop = tls.sniHandlers.find((h) => h.serverNames[0] === "shop.example.com");
    assert.ok(shop, "нет обработчика для shop.example.com");
    assert.strictEqual(shop.handler.certificateIds[0], "cert-4", "у домена свой сертификат не доехал: " + JSON.stringify(shop.handler.certificateIds));
    assert.strictEqual(shop.handler.httpHandler.httpRouterId, "router-1", "обработчик SNI должен быть того же типа, что основной");
    assert.strictEqual(shop.name, "sni-shop-example-com", "имя обработчика не собрано из домена: " + shop.name);
    const many = tls.sniHandlers.find((h) => h.serverNames.length === 2);
    assert.deepStrictEqual(many.serverNames, ["www.example.com", "example.com"], "домены одной строки разобраны не все");
    assert.strictEqual(r.sni.length, 2, "ответ не назвал SNI-домены");
    assert.ok(/домены SNI: shop\.example\.com/.test(r.message), r.message);
    // Карточка обязана читать сертификаты SNI-обработчиков: у них СВОИ.
    const c = await alb.card("oauth-1", "folder-1", "https-lb");
    const sniCert = c.certificates.find((x) => /SNI: shop\.example\.com/.test(x.listenerName));
    assert.ok(sniCert && sniCert.cert.name === "shop-cert", "карточка не читает сертификат SNI-домена: " + c.certificates.map((x) => x.listenerName).join(" | "));
    const line = alb.certLine(sniCert);
    assert.ok(/shop-cert/.test(line) && /осталось \d+ дн\./.test(line), line);
    const lbLine = alb.listenerLine((await alb.loadBalancer("oauth-1", "alb-https")).listeners.find((l) => l.name === "shop"));
    assert.ok(/SNI: shop\.example\.com/.test(lbLine), "строка слушателя молчит про домены SNI: " + lbLine);
  });

  await test("ycAlb: негодные SNI-домены отбиваются ДО сети", async () => {
    const before = writes(stub).length;
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "edge-lb", listenerName: "sni-http", listener: "http", port: 80, router: "main-router", sni: "shop.example.com=shop-cert" }),
      /только у HTTPS-слушателя/
    );
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "sni-x", listener: "https", router: "main-router", certificate: "site-cert", sni: "shop.example.com=нет-такого" }),
      /SNI: не нашёл сертификат/
    );
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "sni-x", listener: "https", router: "main-router", certificate: "site-cert", sni: "shop.example.com=old-cert" }),
      (e) => /SNI/.test(e.message) && /ещё не выпущен/.test(e.message) && /VALIDATING/.test(e.message)
    );
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "sni-x", listener: "https", router: "main-router", certificate: "site-cert", sni: "shop.example.com=site-cert\nSHOP.example.com=site-cert" }),
      /облако не примет/
    );
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "sni-x", listener: "https", router: "main-router", certificate: "site-cert", sni: "shop.example.com,shop.example.com=site-cert" }),
      /назван дважды/
    );
    await assert.rejects(
      () => alb.addListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "sni-x", listener: "https", router: "main-router", certificate: "site-cert", sni: "shop.example.com" }),
      /нет сертификата/
    );
    assert.strictEqual(writes(stub).length, before, "негодные SNI-домены всё-таки ушли в облако");
  });

  await test("ycAlb: правка без доменов сохраняет SNI, а «нет» — убирает", async () => {
    // Домены не называем — они должны остаться: правка одного порта не повод
    // потерять их вместе с сертификатами.
    stub.created.listenerOps.length = 0;
    const kept = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "shop", port: 8443 });
    const keptSpec = stub.created.listenerOps[0].body.listenerSpec;
    assert.strictEqual(keptSpec.tls.sniHandlers.length, 2, "домены потеряны при правке порта: " + keptSpec.tls.sniHandlers.length);
    assert.ok(kept.warnings.some((w) => /Порт слушателя: 443 → 8443/.test(w)), kept.warnings.join(" | "));
    assert.ok(!kept.warnings.some((w) => /SNI/.test(w)), "о доменах сказано там, где их не трогали: " + kept.warnings.join(" | "));
    const afterKeep = await alb.loadBalancer("oauth-1", "alb-https");
    const keptListener = afterKeep.listeners.find((l) => l.name === "shop");
    assert.strictEqual(keptListener.sni.length, 2, "перечитывание не видит домены SNI");
    assert.deepStrictEqual(keptListener.ports, ["8443"]);
    // А теперь убираем домены целиком — пустым списком (в окне это «нет»).
    const gone = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "shop", sni: [] });
    const goneSpec = stub.created.listenerOps.slice(-1)[0].body.listenerSpec;
    assert.strictEqual(goneSpec.tls.sniHandlers, undefined, "пустой список не убрал домены: " + JSON.stringify(goneSpec.tls.sniHandlers));
    assert.ok(gone.warnings.some((w) => /Домены SNI убраны/.test(w) && /shop\.example\.com/.test(w)), gone.warnings.join(" | "));
    assert.ok(/домены SNI: убраны/.test(gone.message), gone.message);
    const afterGone = await alb.loadBalancer("oauth-1", "alb-https");
    assert.strictEqual(afterGone.listeners.find((l) => l.name === "shop").sni.length, 0, "домены остались после удаления");
    assert.strictEqual(afterGone.listeners.find((l) => l.name === "shop").certificateIds[0], "cert-1", "основной сертификат потерялся вместе с доменами");
  });

  await test("ycAlb: молчаливая правка слушателя — ошибка, а смена адреса предупреждает", async () => {
    stub.flags.dropUpdate = true;
    await assert.rejects(
      () => alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "secure", port: 9443 }),
      (e) => /не применилась/.test(e.message) && /порт \(443\)/.test(e.message) && /alb\.editor/.test(e.message)
    );
    stub.flags.dropUpdate = false;
    const moved = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "secure", address: "203.0.113.99" });
    assert.ok(moved.warnings.some((w) => /Адрес слушателя изменился: 203\.0\.113\.11 → 203\.0\.113\.99/.test(w)), moved.warnings.join(" | "));
    // Возврат на прежний адрес — тоже смена адреса: предупреждение обязано быть.
    const back = await alb.updateListener("oauth-1", { folderId: "folder-1", lb: "https-lb", listenerName: "secure", address: "203.0.113.11" });
    assert.ok(back.warnings.some((w) => /Адрес слушателя изменился: 203\.0\.113\.99 → 203\.0\.113\.11/.test(w)), back.warnings.join(" | "));
  });

  await test("yc:alb и ycAlb: правка слушателя идёт через настоящий канал и инструмент", async () => {
    const handlers = new Map();
    registerYcIpc(ipcDeps(handlers, settingsFor()));
    const call = (args) => handlers.get("yc:alb")({}, args || {});

    stub.created.listenerOps.length = 0;
    const upd = await call({ op: "listenerupd", lb: "https-lb", listenerName: "shop", port: 9443 });
    assert.strictEqual(upd.ok, true, "канал отказал на правке слушателя: " + (upd.error || ""));
    const op = stub.created.listenerOps.slice(-1)[0];
    assert.strictEqual(op.action, "updateListener");
    assert.strictEqual(op.body.listenerSpec.name, "shop");
    assert.deepStrictEqual(upd.fields, ["name", "endpoint_specs", "tls"]);
    assert.ok((upd.lines || []).some((l) => /обновляется/.test(l) && /порт 9443/.test(l)), (upd.lines || []).join(" | "));
    const gone = await call({ op: "listenerupd", lb: "https-lb", listenerName: "nope", port: 9443 });
    assert.strictEqual(gone.ok, false, "канал не отбил чужое имя слушателя");
    assert.ok(/нет слушателя/.test(gone.error), gone.error);

    const tools = buildTools();
    stub.created.listenerOps.length = 0;
    const text = await tools.ycAlb({ action: "listenerupd", lb: "https-lb", listenerName: "shop", certificate: "fresh-cert" });
    assert.strictEqual(stub.created.listenerOps.slice(-1)[0].action, "updateListener");
    assert.strictEqual(stub.created.listenerOps.slice(-1)[0].body.listenerSpec.tls.defaultHandler.certificateIds[0], "cert-5", "инструмент не донёс новый сертификат");
    assert.ok(/:updateListener/.test(text), "инструмент не сказал, каким методом правит: " + text);
    assert.ok(/маской полей/.test(text), text);
    assert.ok(/listenerupd/.test(text), "инструмент не подсказал, как править слушателя: " + text);
  });

  await test("yc-actions: у правки слушателя своя форма, и SNI есть у создания балансировщика", () => {
    const ctx = { window: {}, document: undefined, navigator: {}, console: console };
    ctx.window.window = ctx.window;
    vm.createContext(ctx);
    vm.runInContext(ACTIONS_SRC, ctx, { filename: "yc-actions.js" });
    const A = ctx.window.YcActions;
    const upd = A.describe("alb", "listenerupd");
    for (const field of ["listenerName", "listener", "port", "router", "certificate", "backendGroup", "address", "sni"]) {
      assert.ok(upd.fields.indexOf(field) >= 0, "в форме правки слушателя нет поля " + field + ": " + upd.fields.join(", "));
    }
    assert.strictEqual(A.actionsFor("alb").find((x) => x.id === "listenerupd").target.key, "lb", "у правки слушателя нет цели-балансировщика");
    assert.strictEqual(upd.danger, false, "правка слушателя — не удаление: опасной её называть не надо");
    assert.strictEqual(upd.confirmArg, "", "правка слушателя не спрашивает согласие: она обратима");
    const req = A.request("alb", "listenerupd", { lb: "web-lb", listenerName: "web", port: "9443" }, false);
    assert.strictEqual(req.args.op, "listenerupd");
    assert.strictEqual(req.args.lb, "web-lb", "балансировщик не ушёл в правку слушателя");
    assert.strictEqual(req.args.listenerName, "web");
    assert.strictEqual(req.args.port, 9443, "порт не число");
    assert.strictEqual(req.args.certificate, undefined, "пустое поле ушло в запрос — модуль счёл бы это сменой настройки");
    assert.strictEqual(req.args.confirm, undefined, "лишний confirm у правки слушателя");
    const empty = A.request("alb", "listenerupd", { lb: "web-lb", listenerName: "web" }, false);
    assert.strictEqual(empty.args.port, undefined, "пустой порт всё равно ушёл числом");
    for (const id of ["listeneradd", "lbnew"]) {
      assert.ok(A.describe("alb", id).fields.indexOf("sni") >= 0, "в форме " + id + " нет поля домены SNI");
    }
    const sniReq = A.request("alb", "listenerupd", { lb: "web-lb", listenerName: "web", sni: "shop.example.com=shop-cert" }, false);
    assert.strictEqual(sniReq.args.sni, "shop.example.com=shop-cert", "домены SNI не ушли строкой");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало" + (failed ? " — есть ошибки" : ""));
  process.exit(failed ? 1 : 0);
})();

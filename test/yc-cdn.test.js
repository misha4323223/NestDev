"use strict";

/* ── HTTPS-сайт: сертификаты Certificate Manager и Cloud CDN ──────────────────
   Запуск: node test/yc-cdn.test.js   (входит в общий `npm test`)

   Зачем набор. Бакет с сайтом приложение умело создать и наполнить, домен —
   завести в Cloud DNS, а вот открыть это по HTTPS было нечем: сертификат и
   CDN-ресурс делались только в консоли облака. Теперь это делают модуль
   src/yc-cdn.js и инструмент ycCdn.

   Что проверяется и почему именно это:

     • ДОМЕНЫ СЕРТИФИКАТА ИЗМЕНИТЬ НЕЛЬЗЯ (в Update такого поля нет) — это
       главный факт про сертификаты, и он проверяется и словами модели, и
       отказом модуля;
     • запись подтверждения — РОВНО ОДНА: CNAME (<id сертификата>.cm.yandexcloud.
       net.) или TXT. CNAME подтверждается один раз и продления проходят сами,
       TXT пришлось бы обновлять каждые 60 дней. Маску (*.домен) файлом на сайте
       подтвердить нельзя вовсе — модуль отбивает это ДО обращения в облако;
     • тело выпуска сертификата сверяется целиком (домены, тип проверки, имя), а
       id готового сертификата берётся из ответа ОПЕРАЦИИ, а не из запроса:
       перепутать легко, а «сертификат создан, но не тот» ищется потом долго;
     • тело создания CDN-ресурса сверяется целиком: заголовок Host для
       бакета-сайта, перевод http→https и тип сертификата CM — это ровно то, без
       чего сайт не откроется («CDN настроен, а сайта нет» — это про Host);
     • создание ресурса БЕЗ подтверждения не создаёт ничего и называет цену:
       ресурс платный (150 ₽/мес за каждый ресурс пакетом), и деньги уходят даже
       при нулевом трафике;
     • группа источников обновляется запросом БЕЗ id в пути и с именем groupName
       — с id в пути сервис отвечает 404, и это отдельная проверка (ловушка API);
     • очистка кэша: пустой список путей значит «очистить всё», звёздочка — только
       в конце пути, не больше 10 путей за раз;
     • список источников группы сравнивается ПО СОДЕРЖИМОМУ, а не по числу: иначе
       «облако не применило правку, но источников столько же» проходит проверку;
     • результат, а не факт отправки: после правки сертификата и ресурса, после
       удаления и после привязки сертификата всё ПЕРЕЧИТЫВАЕТСЯ, и три случая
       «облако ответило „сделано“, а на деле ничего не изменилось» держатся
       НЕГАТИВНЫМИ контролями;
     • инструмент ycCdn: права (создание / правка и очистка кэша / удаление)
       проверяются ДО запроса, удаление и платное создание требуют согласия,
       чтение не делает ни одной изменяющей операции;
     • проводка: канал yc:cdn, мост окна, схема, группа «облако», промпт,
       политика прав, справочник и тариф CDN в оценке стоимости.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает НАСТОЯЩИЙ модуль. */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
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
const plain = (v) => JSON.parse(JSON.stringify(v));

const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
const ycCosts = require(path.join(ROOT, "src", "yc-costs.js"));
const cdnLib = require(path.join(ROOT, "src", "yc-cdn.js"));
const {
  createYcCdn,
  checkName,
  checkDomain,
  checkDomains,
  normalizeDomain,
  isWildcard,
  challengeFor,
  certInfo,
  certTrouble,
  cdnInfo,
  cdnTrouble,
  originGroupInfo,
  normalizeOrigin,
  sslTypeHuman,
  typeHuman,
  statusHuman,
  challengeStatusHuman,
  bucketOriginSource,
  hostHeaderFor,
  normalizePurgePaths,
  dnsChallengeValue,
  daysLeft,
  humanDaysLeft,
  DNS_CHALLENGE_PREFIX,
  CERT_CNAME_SUFFIX,
  CDN_RESOURCE_MONTH,
  CDN_MAX_PURGE_PATHS,
} = cdnLib;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const MAIN_SRC = read("src", "main.js");
const SMOKE_SRC = require(path.join(__dirname, "smoke", "source.js")); // текст всего набора smoke (часть 81)
const PKG = JSON.parse(read("package.json"));

// ── Подменённое облако ──────────────────────────────────────────────────────
// Настоящая машина состояний: выпуск сертификата, подтверждение домена, привязка
// сертификата к ресурсу, правка, удаление и очистка кэша меняют то, что отдаёт
// чтение. Проверяется не форма запроса, а то, что после вызова в каталоге
// действительно стало иначе.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n) => new Date(Date.now() + n * 86400000).toISOString();
const HOUR = 3600e3;

function initialState() {
  return {
    certificates: [
      // Выпущенный сертификат на домен: годится, чтобы привязать к ресурсу.
      {
        id: "cert-1",
        folderId: "folder-1",
        name: "site-cert",
        type: "MANAGED",
        domains: ["cdn.example.com"],
        status: "ISSUED",
        createdAt: daysAgo(40),
        issuedAt: daysAgo(40),
        notAfter: daysAhead(50),
        issuer: "CN=Let's Encrypt",
        deletionProtection: false,
        challenges: [
          { domain: "cdn.example.com", type: "DNS", status: "VALID", dnsChallenge: { name: "_acme-challenge.cdn.example.com", type: "CNAME", value: "cert-1.cm.yandexcloud.net." } },
        ],
      },
      // Сертификат, который ждёт подтверждения домена: HTTPS по нему ещё не работает.
      {
        id: "cert-2",
        folderId: "folder-1",
        name: "blog-cert",
        type: "MANAGED",
        domains: ["blog.example.com"],
        status: "VALIDATING",
        createdAt: daysAgo(1),
        notAfter: "",
        challenges: [
          { domain: "blog.example.com", type: "DNS", status: "PENDING", dnsChallenge: { name: "_acme-challenge.blog.example.com", type: "CNAME", value: "cert-2.cm.yandexcloud.net." } },
        ],
      },
      // Загруженный сертификат, который истекает, — его никто не продлит.
      {
        id: "cert-3",
        folderId: "folder-1",
        name: "old-imported",
        type: "IMPORTED",
        domains: ["old.example.com"],
        status: "ISSUED",
        createdAt: daysAgo(350),
        notAfter: daysAhead(10),
        incompleteChain: true,
        challenges: [],
      },
      // Сертификат с защитой от удаления — облако его не отдаст.
      {
        id: "cert-4",
        folderId: "folder-1",
        name: "protected-cert",
        type: "MANAGED",
        domains: ["solid.example.com"],
        status: "ISSUED",
        createdAt: daysAgo(20),
        notAfter: daysAhead(60),
        deletionProtection: true,
        challenges: [],
      },
    ],
    groups: [
      {
        id: "777",
        folderId: "folder-1",
        name: "bucket-origin",
        useNext: true,
        providerType: "ourcdn",
        origins: [{ id: "1", source: "example.com.website.yandexcloud.net", enabled: true, backup: false, meta: { website: { name: "example.com" } } }],
      },
      {
        id: "778",
        folderId: "folder-1",
        name: "spare-origin",
        useNext: true,
        providerType: "ourcdn",
        origins: [{ id: "2", source: "files.example.com", enabled: true, backup: false, meta: { common: { name: "files.example.com" } } }],
      },
      // Свободная группа: на неё не смотрит ни один ресурс — её и удаляем.
      {
        id: "779",
        folderId: "folder-1",
        name: "unused-origin",
        useNext: true,
        providerType: "ourcdn",
        origins: [{ id: "3", source: "vendor.example.com", enabled: true, backup: false, meta: { common: { name: "vendor.example.com" } } }],
      },
    ],
    resources: [
      // Нормальный ресурс: сертификат привязан и подхвачен.
      {
        id: "res-1",
        folderId: "folder-1",
        cname: "cdn.example.com",
        active: true,
        createdAt: daysAgo(30),
        originGroupId: "777",
        originGroupName: "bucket-origin",
        originProtocol: "HTTP",
        secondaryHostnames: ["www.example.com"],
        providerCname: "b5384481.a.yccdn.cloud.yandex.net",
        sslCertificate: { type: "CM", status: "READY", data: { cm: { id: "cert-1" } } },
        options: { hostOptions: { host: { enabled: true, value: "example.com.website.yandexcloud.net" } } },
      },
      // Ресурс без сертификата: по https он не отвечает вовсе.
      {
        id: "res-2",
        folderId: "folder-1",
        cname: "plain.example.com",
        active: true,
        createdAt: daysAgo(5),
        originGroupId: "778",
        originGroupName: "spare-origin",
        originProtocol: "MATCH",
        secondaryHostnames: [],
        providerCname: "e1b83ae3.topology.gslb.yccdn.ru",
        sslCertificate: { type: "DONT_USE" },
        options: {},
      },
      // Выключенный ресурс: содержимое не отдаётся.
      {
        id: "res-3",
        folderId: "folder-1",
        cname: "off.example.com",
        active: false,
        createdAt: daysAgo(2),
        originGroupId: "778",
        originGroupName: "spare-origin",
        originProtocol: "HTTP",
        secondaryHostnames: [],
        providerCname: "aa11.topology.gslb.yccdn.ru",
        sslCertificate: { type: "CM", status: "CREATING", data: { cm: { id: "cert-4" } } },
        options: {},
      },
    ],
  };
}

function startCdnStub() {
  const calls = [];
  const state = initialState();
  // «Облако молча ничего не сделало» — так проверяются негативные контроли.
  const quiet = { certPatchNoop: false, certDeleteNoop: false, cdnPatchNoop: false, cdnDeleteNoop: false, groupPatchNoop: false, dropSsl: false };
  let seq = 100;
  const ops = new Map();

  const json = (res, code, body) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = String(req.url || "");
      const method = String(req.method || "GET").toUpperCase();
      calls.push({ method, url, body });
      const q = url.split("?")[0];
      const query = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";

      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + HOUR).toISOString() });
      }
      if (url.indexOf("/operations/") >= 0) {
        const id = url.slice(url.indexOf("/operations/") + "/operations/".length);
        return json(res, 200, { id, done: true, response: ops.get(id) || {} });
      }

      const op = (created) => {
        const id = "op-" + ++seq;
        if (created) ops.set(id, created);
        return { id, done: false };
      };
      const certById = (id) => state.certificates.find((c) => c.id === id);
      const resById = (id) => state.resources.find((r) => r.id === id);

      // ── Certificate Manager ──────────────────────────────────────────────
      if (q === "/certificate-manager/v1/certificates" && method === "GET") {
        if (query.indexOf("view=FULL") < 0) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: без view=FULL проверок домена не будет" });
        return json(res, 200, { certificates: plain(state.certificates) });
      }
      if (q === "/certificate-manager/v1/certificates/requestNew" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.folderId || !b.name) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет каталога или имени" });
        if (!Array.isArray(b.domains) || !b.domains.length) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет доменов" });
        if (b.challengeType !== "DNS" && b.challengeType !== "HTTP") return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: неизвестный тип проверки" });
        // Wildcard файлом подтвердить нельзя — так же отвечает настоящее облако.
        if (b.challengeType === "HTTP" && b.domains.some((d) => d.indexOf("*.") === 0)) {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: wildcard domains require DNS challenge" });
        }
        if (state.certificates.some((c) => c.name === b.name)) return json(res, 409, { code: 6, message: "ALREADY_EXISTS: сертификат с таким именем уже есть" });
        const id = "cert-" + ++seq;
        // Проверок домена у только что созданного сертификата может не быть с
        // заполненным значением — модуль обязан собрать его сам.
        state.certificates.push({
          id,
          folderId: b.folderId,
          name: b.name,
          description: b.description || "",
          type: "MANAGED",
          domains: b.domains.slice(),
          status: "VALIDATING",
          createdAt: new Date().toISOString(),
          notAfter: "",
          deletionProtection: b.deletionProtection === true,
          challenges: b.domains.map((d) => ({
            domain: d,
            type: b.challengeType,
            status: "PENDING",
            dnsChallenge: b.challengeType === "DNS" ? { name: "_acme-challenge." + d, type: "CNAME" } : undefined,
            httpChallenge: b.challengeType === "HTTP" ? { url: "http://" + d + "/.well-known/acme-challenge/abc", content: "abc.def" } : undefined,
          })),
        });
        return json(res, 200, op({ id }));
      }
      if (q === "/certificate-manager/v1/certificates" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.privateKey) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: private_key обязателен" });
        if (String(b.certificate || "").indexOf("-----BEGIN") < 0) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: certificate must be PEM" });
        const id = "cert-" + ++seq;
        state.certificates.push({
          id,
          folderId: b.folderId,
          name: b.name,
          type: "IMPORTED",
          domains: ["imported.example.com"],
          status: "ISSUED",
          createdAt: new Date().toISOString(),
          notAfter: daysAhead(90),
          challenges: [],
        });
        return json(res, 200, op({ id }));
      }
      if (q.indexOf("/certificate-manager/v1/certificates/") === 0) {
        const id = q.slice("/certificate-manager/v1/certificates/".length);
        const cert = certById(id);
        if (!cert) return json(res, 404, { code: 5, message: "NOT_FOUND: сертификат не найден" });
        if (method === "GET") return json(res, 200, plain(cert));
        if (method === "PATCH") {
          const b = JSON.parse(body || "{}");
          if (!b.updateMask) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: update_mask обязателен" });
          if (quiet.certPatchNoop) return json(res, 200, op());
          const fields = String(b.updateMask).split(",").map((x) => x.trim());
          if (fields.indexOf("name") >= 0 && b.name) cert.name = b.name;
          if (fields.indexOf("description") >= 0) cert.description = b.description == null ? "" : b.description;
          if (fields.indexOf("labels") >= 0) cert.labels = b.labels || {};
          if (fields.indexOf("deletionProtection") >= 0) cert.deletionProtection = b.deletionProtection === true;
          return json(res, 200, op());
        }
        if (method === "DELETE") {
          if (cert.deletionProtection) return json(res, 400, { code: 9, message: "FAILED_PRECONDITION: deletion protection" });
          if (quiet.certDeleteNoop) return json(res, 200, op());
          state.certificates = state.certificates.filter((c) => c.id !== id);
          return json(res, 200, op());
        }
      }

      // ── Cloud CDN: группы источников ─────────────────────────────────────
      if (q === "/cdn/v1/originGroups" && method === "GET") {
        return json(res, 200, { originGroups: plain(state.groups) });
      }
      if (q === "/cdn/v1/originGroups" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.folderId || !b.name || !Array.isArray(b.origins) || !b.origins.length) {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нужны каталог, имя и источники" });
        }
        if (!b.origins.some((o) => o.enabled !== false)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: ни один источник не включён" });
        const id = String(9000 + Math.floor(Math.random() * 999));
        state.groups.push({ id, folderId: b.folderId, name: b.name, useNext: b.useNext !== false, providerType: "ourcdn", origins: plain(b.origins).map((o, i) => Object.assign({ id: String(i + 1) }, o)) });
        return json(res, 200, op());
      }
      // ЛОВУШКА: обновление группы идёт БЕЗ id в пути, id и имя — в теле.
      if (q === "/cdn/v1/originGroups" && method === "PATCH") {
        const b = JSON.parse(body || "{}");
        if (!b.originGroupId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: origin_group_id обязателен" });
        const g = state.groups.find((x) => x.id === String(b.originGroupId));
        if (!g) return json(res, 404, { code: 5, message: "NOT_FOUND: группы нет" });
        if (!Array.isArray(b.origins) || !b.origins.length) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: origins пуст" });
        if (quiet.groupPatchNoop) return json(res, 200, op());
        if (b.groupName) g.name = b.groupName;
        if (b.useNext != null) g.useNext = b.useNext === true;
        g.origins = plain(b.origins).map((o, i) => Object.assign({ id: String(i + 1) }, o));
        return json(res, 200, op());
      }
      if (q.indexOf("/cdn/v1/originGroups/") === 0) {
        const id = q.slice("/cdn/v1/originGroups/".length);
        const g = state.groups.find((x) => x.id === id);
        if (!g) return json(res, 404, { code: 5, message: "NOT_FOUND: группы нет" });
        if (method === "GET") return json(res, 200, plain(g));
        if (method === "DELETE") {
          if (state.resources.some((r) => String(r.originGroupId) === id)) {
            return json(res, 400, { code: 9, message: "FAILED_PRECONDITION: origin group is used by resource" });
          }
          state.groups = state.groups.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
      }

      // ── Cloud CDN: ресурсы ───────────────────────────────────────────────
      if (q === "/cdn/v1/resources" && method === "GET") {
        return json(res, 200, { resources: plain(state.resources) });
      }
      if (q === "/cdn/v1/resources" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.folderId || !b.cname || !b.origin) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нужны каталог, cname и источник" });
        if (state.resources.some((r) => r.cname === b.cname)) return json(res, 409, { code: 6, message: "ALREADY_EXISTS: ресурс с таким доменом уже есть" });
        const id = "res-" + ++seq;
        let groupId = "";
        let groupName = "";
        if (b.origin.originGroupId) {
          const g = state.groups.find((x) => x.id === String(b.origin.originGroupId));
          if (!g) return json(res, 404, { code: 5, message: "NOT_FOUND: группы источников нет" });
          groupId = g.id;
          groupName = g.name;
        } else if (b.origin.originSourceParams) {
          // Так же, как облако: CDN сам заводит группу с одним источником.
          groupId = "777";
          groupName = "bucket-origin";
          state.groups[0].origins = [Object.assign({ id: "1", enabled: true }, b.origin.originSourceParams)];
        } else {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: источник не понят" });
        }
        const created = {
          id,
          folderId: b.folderId,
          cname: b.cname,
          active: b.active !== false,
          createdAt: new Date().toISOString(),
          originGroupId: groupId,
          originGroupName: groupName,
          originProtocol: b.originProtocol || "MATCH",
          secondaryHostnames: (b.secondaryHostnames && b.secondaryHostnames.values) || [],
          providerCname: "new" + seq + ".topology.gslb.yccdn.ru",
          // Негативный контроль: облако сделало ресурс, но сертификат не привязало.
          sslCertificate: quiet.dropSsl ? { type: "DONT_USE" } : b.sslCertificate || { type: "DONT_USE" },
          options: b.options || {},
        };
        state.resources.push(created);
        return json(res, 200, op({ id }));
      }
      if (q.indexOf("/cdn/v1/resources/") === 0) {
        const id = q.slice("/cdn/v1/resources/".length);
        const r = resById(id);
        if (!r) return json(res, 404, { code: 5, message: "NOT_FOUND: ресурс не найден" });
        if (method === "GET") return json(res, 200, plain(r));
        if (method === "PATCH") {
          const b = JSON.parse(body || "{}");
          if (quiet.cdnPatchNoop) return json(res, 200, op());
          if (b.originGroupId != null) {
            r.originGroupId = String(b.originGroupId);
            const g = state.groups.find((x) => x.id === String(b.originGroupId));
            r.originGroupName = g ? g.name : "";
          }
          if (b.secondaryHostnames) r.secondaryHostnames = (b.secondaryHostnames.values || []).slice();
          if (b.active != null) r.active = b.active === true;
          if (b.sslCertificate) r.sslCertificate = plain(b.sslCertificate);
          if (b.options) r.options = Object.assign({}, r.options, b.options);
          if (b.originProtocol) r.originProtocol = b.originProtocol;
          if (b.labels) r.labels = b.labels;
          return json(res, 200, op());
        }
        if (method === "DELETE") {
          if (quiet.cdnDeleteNoop) return json(res, 200, op());
          state.resources = state.resources.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
      }
      if (/^\/cdn\/v1\/cache\/[^/]+:purge$/.test(q) && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!Array.isArray(b.paths)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: paths должен быть списком (пустой список = очистить всё)" });
        if (b.paths.length > CDN_MAX_PURGE_PATHS) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: не больше 10 путей за раз" });
        return json(res, 200, op());
      }

      return json(res, 404, { code: 5, message: "NOT_FOUND: " + method + " " + q });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.certPatchNoop = false;
    quiet.certDeleteNoop = false;
    quiet.cdnPatchNoop = false;
    quiet.cdnDeleteNoop = false;
    quiet.groupPatchNoop = false;
    quiet.dropSsl = false;
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function mkCdn() {
  return createYcCdn({
    fetchJson: yandex._fetchJson,
    endpoint: yandex.endpoint,
    getIamToken: yandex.getIamToken,
    waitOperation: yandex.waitOperation,
    serviceError: yandex.serviceError,
    isNetworkError: yandex.isNetworkError,
  });
}

function buildTools(settingsOver, cdnOver) {
  const settings = Object.assign(
    {
      yandexOauthToken: "oauth-1",
      ycCloudId: "cloud-1",
      ycFolderId: "folder-1",
      ycFolderName: "prod",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
      ycAllowAgentUpdate: false,
    },
    settingsOver || {}
  );
  const tools = createCloudTools({
    yandexCloud: yandex,
    ycCdn: cdnOver === null ? null : mkCdn(),
    ycCosts,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        cloudId: st.ycCloudId || "",
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
        allowUpdate: !!st.ycAllowAgentUpdate,
      };
    },
    loadSettings: () => settings,
  });
  return { tools, settings };
}

// Изменяющие запросы: POST/PUT/PATCH/DELETE, кроме служебных (токен и операции).
const writeCalls = (calls) =>
  calls.filter(
    (c) =>
      (c.method === "POST" || c.method === "PUT" || c.method === "PATCH" || c.method === "DELETE") &&
      c.url.indexOf("/operations/") < 0 &&
      c.url.indexOf("/tokens") < 0
  );

const urlOf = (c) => String(c.url).split("?")[0];

(async () => {
  const stub = await startCdnStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Домены, состояния и записи подтверждения — до всякой сети");

  await test("ycCdn: домен приводится к виду облака, маска распознаётся, кривой домен отбивается", () => {
    assert.strictEqual(checkDomain("https://CDN.Example.com./path?x=1"), "cdn.example.com", "домен не приведён к виду облака");
    assert.strictEqual(normalizeDomain("example.com:443"), "example.com", "порт не убран из домена");
    assert.strictEqual(checkDomain("*.example.com"), "*.example.com", "маска не принята");
    assert.ok(isWildcard("*.example.com") && !isWildcard("example.com"), "маска распознаётся неверно");
    assert.throws(() => checkDomain("localhost"), /не полное доменное имя/, "имя без точки прошло");
    assert.throws(() => checkDomain(""), /укажи домен/, "пустой домен прошёл");
    assert.throws(() => checkDomain("my_site.example.com"), /не годится/, "подчёркивание в домене прошло");
    assert.throws(() => checkDomain("cdn.*.example.com"), /звёздочка/, "звёздочка в середине прошла");
    assert.deepStrictEqual(plain(checkDomains(["example.com", "EXAMPLE.com", "www.example.com"])), ["example.com", "www.example.com"], "домены не дедуплицированы");
  });

  await test("ycCdn: маску нельзя подтвердить файлом на сайте — отказ до запроса в облако", () => {
    assert.strictEqual(challengeFor(["example.com"], "HTTP"), "HTTP", "обычный домен потерял HTTP-проверку");
    assert.strictEqual(challengeFor(["example.com"]), "DNS", "по умолчанию выбран не DNS");
    let msg = "";
    try {
      challengeFor(["*.example.com"], "HTTP");
    } catch (e) {
      msg = e.message;
    }
    assert.ok(/нельзя подтвердить файлом/i.test(msg), "маска не отбита от HTTP-проверки: " + msg);
    assert.ok(msg.indexOf(DNS_CHALLENGE_PREFIX) >= 0, "в отказе нет имени записи подтверждения: " + msg);
    assert.throws(() => challengeFor(["example.com"], "по-почте"), /не понял/, "неизвестный тип проверки прошёл");
  });

  await test("ycCdn: состояния сертификата и ресурса переводятся словами", () => {
    assert.ok(/выпущен/i.test(statusHuman("ISSUED")), "ISSUED не объяснён: " + statusHuman("ISSUED"));
    assert.ok(/не выпущен/i.test(statusHuman("VALIDATING")), "VALIDATING не объяснён: " + statusHuman("VALIDATING"));
    assert.ok(/НОВЫЙ запрос|новый запрос/i.test(statusHuman("INVALID")), "INVALID не объяснён словами о новом запросе: " + statusHuman("INVALID"));
    assert.ok(/подтверждён/i.test(challengeStatusHuman("VALID")), "VALID проверки не объяснён");
    assert.ok(/не видит/i.test(challengeStatusHuman("PENDING")), "PENDING проверки не объяснён");
    assert.ok(/продлевается сам/i.test(typeHuman("MANAGED")), "MANAGED не объяснён: " + typeHuman("MANAGED"));
    assert.ok(/самому/i.test(typeHuman("IMPORTED")), "IMPORTED не объяснён: " + typeHuman("IMPORTED"));
    assert.ok(/ВЫКЛЮЧЕН/i.test(sslTypeHuman("DONT_USE")), "DONT_USE не назван как «HTTPS выключен»: " + sslTypeHuman("DONT_USE"));
  });

  await test("ycCdn: адрес источника и заголовок Host для бакета-сайта считаются одинаково", () => {
    assert.strictEqual(bucketOriginSource("example.com"), "example.com.website.yandexcloud.net", "сайт-адрес бакета неверен");
    assert.strictEqual(bucketOriginSource("files", false), "files.storage.yandexcloud.net", "адрес обычного бакета неверен");
    assert.strictEqual(hostHeaderFor("example.com"), "example.com.website.yandexcloud.net", "заголовок Host для бакета-сайта неверен");
    assert.throws(() => bucketOriginSource(""), /Укажи имя бакета/, "пустой бакет прошёл");
    const g = originGroupInfo({ id: "777", name: "g", origins: [{ source: "example.com.website.yandexcloud.net", enabled: true, meta: { website: { name: "example.com" } } }] });
    assert.strictEqual(g.origins[0].kind, "website", "тип источника бакета-сайта не распознан");
    assert.strictEqual(g.active.length, 1, "включённые источники посчитаны неверно");
    const o = normalizeOrigin("my-bucket");
    assert.strictEqual(o.source, "my-bucket.website.yandexcloud.net", "имя бакета не превратилось в сайт-адрес");
    assert.deepStrictEqual(plain(o.meta), { website: { name: "my-bucket" } }, "метка типа источника бакета потеряна");
    assert.strictEqual(normalizeOrigin("files.example.com").meta, undefined, "своему серверу приписана метка бакета");
  });

  console.log("\n[2] Что именно надо добавить в DNS и почему HTTPS не работает");

  await test("ycCdn: запись подтверждения — одна, CNAME, значение по документированному шаблону", () => {
    const withValue = certInfo(stub.state.certificates.find((c) => c.id === "cert-1"));
    assert.strictEqual(withValue.challenges[0].dns.value, "cert-1.cm.yandexcloud.net.", "значение записи потеряно");
    assert.strictEqual(withValue.challenges[0].done, true, "пройденная проверка не помечена");
    // Значение пришло пустым (как у только что запрошенного сертификата) — собираем сами.
    const without = certInfo({ id: "cert-77", domains: ["blog.example.com"], status: "VALIDATING", challenges: [{ domain: "blog.example.com", type: "DNS", status: "PENDING", dnsChallenge: { name: "_acme-challenge.blog.example.com", type: "CNAME" } }] });
    assert.strictEqual(without.challenges[0].dns.value, "cert-77" + CERT_CNAME_SUFFIX, "значение записи не собрано по шаблону");
    assert.strictEqual(dnsChallengeValue({ id: "cert-77", challenges: [{ dnsChallenge: {} }] }), "cert-77" + CERT_CNAME_SUFFIX, "шаблон значения записи изменился");
    assert.strictEqual(without.challenges[0].dns.name, "_acme-challenge.blog.example.com", "имя записи подтверждения неверно");
  });

  await test("ycCdn: неподтверждённый домен назван причиной, по которой HTTPS не работает", () => {
    const c = certInfo(stub.state.certificates.find((x) => x.id === "cert-2"));
    const trouble = certTrouble(c);
    assert.ok(trouble.some((t) => /не подтверждён/.test(t)), "неподтверждённый домен не назван: " + trouble.join(" | "));
    const joined = trouble.join(" ");
    assert.ok(joined.indexOf("_acme-challenge.blog.example.com") >= 0, "в предупреждении нет имени записи: " + joined);
    assert.ok(joined.indexOf("cert-2.cm.yandexcloud.net.") >= 0, "в предупреждении нет значения записи: " + joined);
    assert.ok(/сертификат не выпустится|HTTPS не откроется/i.test(joined), "не сказано, что HTTPS не заработает: " + joined);
  });

  await test("ycCdn: загруженный сертификат предупреждают продлевать самому, а невыпущенный — ждать", () => {
    const imported = certInfo(stub.state.certificates.find((x) => x.id === "cert-3"));
    const t1 = certTrouble(imported).join(" ");
    assert.ok(/не продлевается|обнови его до срока/i.test(t1), "загруженный сертификат не предупреждён о продлении: " + t1);
    assert.ok(/звеньев/i.test(t1), "неполная цепочка не замечена: " + t1);
    const dead = certInfo({ id: "x", name: "dead", type: "MANAGED", domains: ["a.example.com"], status: "INVALID", challenges: [] });
    const t2 = certTrouble(dead).join(" ");
    assert.ok(/НОВЫЙ запрос/i.test(t2), "INVALID не лечится новым запросом в предупреждении: " + t2);
    // У выключенного ресурса и у ресурса без сертификата беды разные.
    const off = cdnInfo(stub.state.resources.find((r) => r.id === "res-3"));
    const t3 = cdnTrouble(off).join(" ");
    assert.ok(/ВЫКЛЮЧЕН/.test(t3), "выключенный ресурс не назван: " + t3);
    const plainRes = cdnInfo(stub.state.resources.find((r) => r.id === "res-2"));
    const t4 = cdnTrouble(plainRes).join(" ");
    assert.ok(/https/i.test(t4) && /сертификат не привязан|HTTPS выключен/i.test(t4), "ресурс без сертификата не назван: " + t4);
  });

  console.log("\n[3] Сертификаты: настоящий модуль против подменённого облака");

  stub.reset();
  const cdn = mkCdn();

  await test("ycCdn: список и карточка сертификата читаются с проверками домена (view=FULL)", async () => {
    const list = await cdn.certificates("oauth-1", "folder-1");
    assert.strictEqual(list.length, 4, "в каталоге не все сертификаты: " + list.length);
    assert.ok(list.every((c) => c.challenges !== undefined), "в списке нет проверок домена");
    const one = await cdn.certificate("oauth-1", "cert-1");
    assert.strictEqual(one.name, "site-cert", "карточка сертификата не перечиталась");
    assert.strictEqual(one.issued, true, "выпущенный сертификат не помечен выпущенным");
    const listCall = stub.calls.find((c) => urlOf(c) === "/certificate-manager/v1/certificates");
    assert.ok(listCall && /view=FULL/.test(listCall.url), "список запрошен не с view=FULL: " + (listCall && listCall.url));
    // Сертификат ищется и по имени, и по домену, и по id.
    assert.strictEqual((await cdn.findCertificate("oauth-1", "folder-1", "blog.example.com")).id, "cert-2", "сертификат по домену не найден");
    assert.strictEqual((await cdn.findCertificate("oauth-1", "folder-1", "old-imported")).id, "cert-3", "сертификат по имени не найден");
    assert.strictEqual(await cdn.findCertificate("oauth-1", "folder-1", "нет-такого"), null, "нашёлся несуществующий сертификат");
  });

  await test("ycCdn: выпуск сертификата — тело целиком, id из операции, план подтверждения на месте", async () => {
    stub.reset();
    const r = await cdn.requestCertificate("oauth-1", { folderId: "folder-1", name: "shop-cert", domains: ["shop.example.com", "*.shop.example.com"], challengeType: "DNS" });
    const post = stub.calls.find((c) => c.method === "POST" && urlOf(c) === "/certificate-manager/v1/certificates/requestNew");
    assert.ok(post, "запроса на выпуск не было");
    const body = JSON.parse(post.body);
    assert.deepStrictEqual(body, { folderId: "folder-1", name: "shop-cert", domains: ["shop.example.com", "*.shop.example.com"], challengeType: "DNS" }, "тело выпуска сертификата изменилось: " + post.body);
    assert.ok(r.certificate && r.certificate.id, "id сертификата не взят из ответа операции");
    assert.strictEqual(r.certificate.name, "shop-cert", "сертификат перечитан не тот");
    assert.strictEqual(r.challengeType, "DNS", "тип проверки потерян");
    assert.strictEqual(r.plan.length, 2, "в плане подтверждения не все домены: " + r.plan.length);
    assert.ok(r.plan[1].record.value.indexOf(".cm.yandexcloud.net.") > 0, "значение записи для нового сертификата не собрано: " + JSON.stringify(r.plan[1].record));
    assert.ok(r.lines.join(" ").indexOf("_acme-challenge") >= 0, "в строках плана нет имени записи: " + r.lines.join(" | "));
    assert.ok(r.warnings.join(" ").indexOf("ОДНА") >= 0, "не сказано, что запись подтверждения ровно одна: " + r.warnings.join(" | "));
    assert.ok(/бесплатн/i.test(r.warnings.join(" ")), "не сказано, что сертификат бесплатный");
  });

  await test("ycCdn: кривой домен и маска с HTTP-проверкой отбиваются ДО запроса в облако", async () => {
    stub.reset();
    await assert.rejects(() => cdn.requestCertificate("oauth-1", { folderId: "folder-1", name: "bad-cert", domains: ["localhost"] }), /не полное доменное имя/, "кривой домен ушёл в облако");
    await assert.rejects(() => cdn.requestCertificate("oauth-1", { folderId: "folder-1", name: "bad-cert", domains: ["*.example.com"], challengeType: "HTTP" }), /нельзя подтвердить файлом/, "маска с HTTP-проверкой ушла в облако");
    await assert.rejects(() => cdn.requestCertificate("oauth-1", { folderId: "folder-1", name: "Bad_Cert", domains: ["a.example.com"] }), /буквы/, "плохое имя сертификата ушло в облако");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "в облако ушли изменяющие запросы при отказе: " + JSON.stringify(writeCalls(stub.calls).map(urlOf)));
  });

  await test("ycCdn: загруженный сертификат требует PEM, а содержимое managed-сертификата менять нельзя", async () => {
    stub.reset();
    await assert.rejects(() => cdn.importCertificate("oauth-1", { folderId: "folder-1", name: "my-cert", certificate: "сертификат", privateKey: "ключ" }), /PEM/, "не-PEM сертификат принят");
    await assert.rejects(() => cdn.importCertificate("oauth-1", { folderId: "folder-1", name: "my-cert", certificate: "-----BEGIN CERTIFICATE-----\nxx", privateKey: "" }), /PEM/, "пустой ключ принят");
    const imp = await cdn.importCertificate("oauth-1", {
      folderId: "folder-1",
      name: "my-cert",
      certificate: "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----",
    });
    assert.strictEqual(imp.certificate.imported, true, "загруженный сертификат не помечен загруженным");
    assert.ok(/не продлевается/i.test(imp.warnings.join(" ")), "не предупреждено, что загруженный сертификат не продлевается");
    const managedContent = await cdn
      .updateCertificate("oauth-1", {
        folderId: "folder-1",
        certificate: "site-cert",
        certificateText: "-----BEGIN CERTIFICATE-----\nMII\n-----END CERTIFICATE-----",
        privateKey: "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----",
      })
      .then(() => null, (e) => e);
    assert.ok(managedContent && /содержимое менять нельзя/.test(String(managedContent.message)), "managed-сертификату позволили подменить содержимое");
    await assert.rejects(
      () => cdn.updateCertificate("oauth-1", { folderId: "folder-1", certificate: "old-imported", certificateText: "не PEM", privateKey: "-----BEGIN PRIVATE KEY-----\nMII" }),
      /PEM/,
      "не-PEM содержимое прошло"
    );
  });

  await test("ycCdn: правка сертификата проверяется перечитыванием (негативный контроль)", async () => {
    stub.reset();
    const ok = await cdn.updateCertificate("oauth-1", { folderId: "folder-1", certificate: "site-cert", description: "сайт компании" });
    assert.strictEqual(ok.changed, true, "правка не применилась");
    assert.strictEqual(ok.certificate.description, "сайт компании", "описание не перечиталось");
    const patch = stub.calls.find((c) => c.method === "PATCH");
    assert.strictEqual(JSON.parse(patch.body).updateMask, "description", "маска правки собрана неверно: " + patch.body);

    // Облако ответило «сделано», а на деле ничего не поменялось.
    stub.quiet.certPatchNoop = true;
    await assert.rejects(() => cdn.updateCertificate("oauth-1", { folderId: "folder-1", certificate: "site-cert", description: "другое" }), /не применилась/, "молчаливая правка не поймана");
    stub.quiet.certPatchNoop = false;
  });

  await test("ycCdn: домены сертификата менять нечем — модуль говорит это прямо", async () => {
    stub.reset();
    const r = await cdn.updateCertificate("oauth-1", { folderId: "folder-1", certificate: "site-cert" });
    assert.strictEqual(r.changed, false, "«нечего менять» превратилось в правку");
    assert.ok(/ДОМЕНЫ|Домены/.test(r.message) && /НЕЛЬЗЯ|нельзя/.test(r.message), "не сказано, что домены изменить нельзя: " + r.message);
    const same = await cdn.updateCertificate("oauth-1", { folderId: "folder-1", certificate: "site-cert", newName: "site-cert" });
    assert.strictEqual(same.changed, false, "правка «тем же именем» ушла в облако");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "изменяющие запросы ушли, хотя менять нечего: " + JSON.stringify(writeCalls(stub.calls).map(urlOf)));
  });

  await test("ycCdn: удаление сертификата без согласия называет, какой сайт сломается", async () => {
    stub.reset();
    const r = await cdn.deleteCertificate("oauth-1", { folderId: "folder-1", certificate: "site-cert" });
    assert.strictEqual(r.deleted, false, "сертификат удалён без согласия");
    assert.strictEqual(r.needsConfirm, true, "не запрошено подтверждение");
    assert.strictEqual(r.usedBy.length, 1, "не найдены ресурсы, которые носят сертификат: " + r.usedBy.length);
    assert.strictEqual(r.usedBy[0].cname, "cdn.example.com", "назван не тот сайт: " + r.usedBy[0].cname);
    const joined = r.warnings.join(" ");
    assert.ok(/cdn\.example\.com/.test(joined), "в предупреждениях нет имени сайта: " + joined);
    assert.ok(/отвалится HTTPS|недействителен/i.test(joined), "не сказано, что будет с сайтом: " + joined);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "удаление началось до согласия");
    await assert.rejects(() => cdn.deleteCertificate("oauth-1", { folderId: "folder-1", certificate: "protected-cert" }), /защита от удаления/, "сертификат под защитой не отбит");
  });

  await test("ycCdn: удаление сертификата с согласия действительно удаляет (негативный контроль)", async () => {
    stub.reset();
    const r = await cdn.deleteCertificate("oauth-1", { folderId: "folder-1", certificate: "old-imported", confirm: true });
    assert.strictEqual(r.deleted, true, "сертификат не удалён");
    assert.strictEqual(await cdn.findCertificate("oauth-1", "folder-1", "old-imported"), null, "сертификат остался в каталоге");
    stub.quiet.certDeleteNoop = true;
    await assert.rejects(() => cdn.deleteCertificate("oauth-1", { folderId: "folder-1", certificate: "blog-cert", confirm: true }), /не удалился/, "молчаливое «удалено» не поймано");
    stub.quiet.certDeleteNoop = false;
  });

  console.log("\n[4] CDN: ресурсы, источники, кэш");

  await test("ycCdn: создание ресурса без согласия не создаёт ничего и называет цену", async () => {
    stub.reset();
    const r = await cdn.createResource("oauth-1", { folderId: "folder-1", cname: "new.example.com", bucket: "example.com", certificate: "site-cert" });
    assert.strictEqual(r.created, false, "платный ресурс создан без согласия");
    assert.strictEqual(r.needsConfirm, true, "не запрошено подтверждение");
    assert.strictEqual(r.price, CDN_RESOURCE_MONTH, "цена не названа: " + r.price);
    assert.ok(/150/.test(r.message) && /₽/.test(r.message), "в отказе нет цены: " + r.message);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "создание началось до согласия");
  });

  await test("ycCdn: создание ресурса — тело целиком: источники бакета, Host, http→https, сертификат CM", async () => {
    stub.reset();
    const r = await cdn.createResource("oauth-1", {
      folderId: "folder-1",
      cname: "new.example.com",
      bucket: "example.com",
      certificate: "site-cert",
      secondaryHostnames: ["www.new.example.com"],
      confirm: true,
    });
    const post = stub.calls.find((c) => c.method === "POST" && urlOf(c) === "/cdn/v1/resources");
    assert.ok(post, "ресурс не создавался");
    const body = JSON.parse(post.body);
    assert.strictEqual(body.cname, "new.example.com", "домен ресурса не тот");
    assert.deepStrictEqual(body.origin, { originSourceParams: { source: "example.com.website.yandexcloud.net", meta: { website: { name: "example.com" } } } }, "источник бакета собран неверно: " + JSON.stringify(body.origin));
    assert.strictEqual(body.options.hostOptions.host.value, "example.com.website.yandexcloud.net", "заголовок Host для бакета-сайта не поставлен");
    assert.strictEqual(body.options.redirectOptions.redirectHttpToHttps.value, true, "http не переводится на https");
    assert.deepStrictEqual(body.sslCertificate, { type: "CM", data: { cm: { id: "cert-1" } } }, "сертификат привязан не так: " + JSON.stringify(body.sslCertificate));
    assert.deepStrictEqual(body.secondaryHostnames, { values: ["www.new.example.com"] }, "дополнительные домены потеряны");
    assert.strictEqual(body.originProtocol, "HTTP", "протокол до бакета выбран не http");
    assert.strictEqual(r.created, true, "ресурс не создан при согласии");
    assert.strictEqual(r.resource.cname, "new.example.com", "созданный ресурс перечитан неверно");
    assert.ok(/CNAME/.test(r.lines.join(" ")), "в ответе нет записи DNS на адрес провайдера: " + r.lines.join(" | "));
    assert.ok(/платный/i.test(r.warnings.join(" ")), "не напомнили про платный ресурс");
  });

  await test("ycCdn: сертификат из другого каталога отбивается с объяснением", async () => {
    stub.reset();
    stub.state.certificates.push({ id: "cert-other", folderId: "folder-2", name: "other-cert", type: "MANAGED", domains: ["other.example.com"], status: "ISSUED", challenges: [] });
    const other = mkCdn();
    await assert.rejects(
      () => other.createResource("oauth-1", { folderId: "folder-1", cname: "x.example.com", bucket: "example.com", certificate: "other-cert", confirm: true }),
      /другом каталоге/,
      "сертификат из чужого каталога прошёл"
    );
    assert.ok(
      !stub.calls.some((c) => c.method === "POST" && urlOf(c) === "/cdn/v1/resources"),
      "ресурс создан несмотря на сертификат из другого каталога"
    );
  });

  await test("ycCdn: ресурс создан, а сертификат не привязался — честная ошибка (негативный контроль)", async () => {
    stub.reset();
    stub.quiet.dropSsl = true;
    await assert.rejects(
      () => cdn.createResource("oauth-1", { folderId: "folder-1", cname: "ssl.example.com", bucket: "example.com", certificate: "site-cert", confirm: true }),
      /сертификат к нему не привязался/,
      "потеря сертификата при создании не замечена"
    );
    stub.quiet.dropSsl = false;
  });

  await test("ycCdn: правка ресурса перечитывается, молчаливый noop ловится", async () => {
    stub.reset();
    const ok = await cdn.updateResource("oauth-1", { folderId: "folder-1", resource: "plain.example.com", certificate: "site-cert" });
    assert.strictEqual(ok.changed, true, "привязка сертификата не применилась");
    assert.strictEqual(ok.resource.sslCertId, "cert-1", "сертификат не перечитался в ресурсе");
    const off = await cdn.updateResource("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", active: false });
    assert.strictEqual(off.resource.active, false, "выключение ресурса не применилось");
    assert.ok(/15 минут/.test(off.warnings.join(" ")), "не сказано, что изменения применяются до 15 минут");

    stub.quiet.cdnPatchNoop = true;
    await assert.rejects(() => cdn.updateResource("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", active: true }), /не применилась/, "молчаливая правка ресурса не поймана");
    stub.quiet.cdnPatchNoop = false;
  });

  await test("ycCdn: основной домен ресурса изменить нельзя — отказ со ссылкой на новый ресурс", async () => {
    stub.reset();
    await assert.rejects(
      () => cdn.updateResource("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", cname: "another.example.com" }),
      /изменить нельзя/,
      "домен ресурса разрешили поменять"
    );
    assert.strictEqual(writeCalls(stub.calls).length, 0, "изменяющие запросы ушли при отказе");
  });

  await test("ycCdn: очистка кэша — пустой список значит «всё», звёздочка только в конце, не больше 10 путей", async () => {
    stub.reset();
    const full = await cdn.purgeCache("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", all: true });
    assert.strictEqual(full.full, true, "полная очистка не помечена полной");
    const call = stub.calls.find((c) => urlOf(c).indexOf(":purge") > 0);
    assert.deepStrictEqual(JSON.parse(call.body), { paths: [] }, "полная очистка ушла не пустым списком: " + call.body);

    const part = await cdn.purgeCache("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", paths: ["index.html", "/img/*"] });
    assert.deepStrictEqual(part.paths, ["/index.html", "/img/*"], "пути к очистке приведены неверно: " + JSON.stringify(part.paths));
    await assert.rejects(() => cdn.purgeCache("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", paths: ["/i*/logo.png"] }), /только В КОНЦЕ/, "звёздочка в середине пути прошла");
    await assert.rejects(() => cdn.purgeCache("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", paths: [] }), /Не указано, что чистить/, "пустой список путей ушёл как «очистить всё»");
    const many = [];
    for (let i = 1; i <= CDN_MAX_PURGE_PATHS + 1; i++) many.push("/p" + i + ".html");
    await assert.rejects(() => cdn.purgeCache("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", paths: many }), /не больше 10 путей/, "11 путей за раз прошли");
    assert.deepStrictEqual(plain(normalizePurgePaths("/one")), ["/one"], "путь без слеша не приведён к виду API");
  });

  await test("ycCdn: группа источников правится запросом БЕЗ id в пути и с именем groupName", async () => {
    stub.reset();
    const r = await cdn.updateOriginGroup("oauth-1", {
      folderId: "folder-1",
      group: "spare-origin",
      newName: "files-origin",
      origins: [{ source: "files.example.com", backup: true }],
      useNext: false,
    });
    const patch = stub.calls.find((c) => c.method === "PATCH" && urlOf(c).indexOf("/cdn/") >= 0);
    assert.ok(patch, "правки группы не было");
    // Ловушка API: с id в пути сервис отвечает 404.
    assert.strictEqual(urlOf(patch), "/cdn/v1/originGroups", "правка группы ушла с id в пути: " + urlOf(patch));
    const body = JSON.parse(patch.body);
    assert.strictEqual(body.originGroupId, "778", "id группы не ушёл в теле: " + patch.body);
    assert.strictEqual(body.groupName, "files-origin", "новое имя ушло не как groupName: " + patch.body);
    assert.strictEqual(body.useNext, false, "useNext потерян");
    assert.strictEqual(body.origins.length, 1, "источники не заменены");
    assert.strictEqual(r.group.name, "files-origin", "группа не перечиталась с новым именем");
    assert.ok(r.group.origins[0].backup, "резервный источник потерян");
    assert.ok(/15 минут/.test(r.warnings.join(" ")), "не сказано про 15 минут и очистку кэша");

    stub.quiet.groupPatchNoop = true;
    await assert.rejects(() => cdn.updateOriginGroup("oauth-1", { folderId: "folder-1", group: "777", origins: [{ source: "files.example.com" }] }), /не применилась/, "молчаливая правка группы не поймана");
    stub.quiet.groupPatchNoop = false;
  });

  await test("ycCdn: группа источников создаётся из бакета и пустой список отбивается", async () => {
    stub.reset();
    const r = await cdn.createOriginGroup("oauth-1", { folderId: "folder-1", name: "site-origin", origins: [{ bucket: "example.com" }] });
    const post = stub.calls.find((c) => c.method === "POST" && urlOf(c) === "/cdn/v1/originGroups");
    const body = JSON.parse(post.body);
    assert.strictEqual(body.origins[0].source, "example.com.website.yandexcloud.net", "источник бакета не развёрнут в сайт-адрес");
    assert.deepStrictEqual(body.origins[0].meta, { website: { name: "example.com" } }, "метка типа источника потеряна");
    assert.strictEqual(r.group.name, "site-origin", "созданная группа не перечиталась");
    await assert.rejects(() => cdn.createOriginGroup("oauth-1", { folderId: "folder-1", name: "empty-origin", origins: [] }), /Укажи источник/, "пустой список источников прошёл");
    await assert.rejects(() => cdn.createOriginGroup("oauth-1", { folderId: "folder-1", name: "off-origin", origins: [{ source: "a.example.com", enabled: false }] }), /выключен/i, "группа без включённых источников прошла");
  });

  await test("ycCdn: удаление занятой группы источников отбивается с именами ресурсов", async () => {
    stub.reset();
    await assert.rejects(() => cdn.deleteOriginGroup("oauth-1", { folderId: "folder-1", group: "bucket-origin" }), /использует CDN-ресурс/, "занятая группа удалена");
    // force снимает только запрет «группа занята» — согласие всё равно нужно.
    const forced = await cdn.deleteOriginGroup("oauth-1", { folderId: "folder-1", group: "spare-origin", force: true });
    assert.strictEqual(forced.deleted, false, "занятую группу удалили без согласия даже с force");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "удаление началось без согласия");
    // С согласием отказ приходит уже от самого облака — и он должен быть виден.
    const cloudNo = await cdn.deleteOriginGroup("oauth-1", { folderId: "folder-1", group: "spare-origin", force: true, confirm: true }).then(() => null, (e) => e);
    assert.ok(cloudNo, "облако дало удалить занятую группу");
    assert.ok(/origin group is used by resource|занят|использует/i.test(String(cloudNo.message)), "отказ облака не виден словами: " + (cloudNo && cloudNo.message));
    const r = await cdn.deleteOriginGroup("oauth-1", { folderId: "folder-1", group: "unused-origin" });
    assert.strictEqual(r.deleted, false, "группа удалена без согласия");
    assert.ok(/unused-origin/.test(r.message), "в отказе нет имени группы: " + r.message);
    assert.ok(/vendor\.example\.com/.test(r.warnings.join(" ")), "не сказано, какие источники были в группе: " + r.warnings.join(" | "));
    const ok = await cdn.deleteOriginGroup("oauth-1", { folderId: "folder-1", group: "unused-origin", confirm: true });
    assert.strictEqual(ok.deleted, true, "свободная группа не удалена по согласию");
  });

  await test("ycCdn: удаление ресурса без согласия перечисляет последствия, с согласием — удаляет", async () => {
    stub.reset();
    const r = await cdn.deleteResource("oauth-1", { folderId: "folder-1", resource: "cdn.example.com" });
    assert.strictEqual(r.deleted, false, "ресурс удалён без согласия");
    const joined = r.warnings.join(" ");
    assert.ok(/перестанут открываться/.test(joined), "не сказано, что домены перестанут открываться: " + joined);
    assert.ok(/[Сс]ертификат «site-cert»/.test(joined), "не сказано, что станет с сертификатом: " + joined);
    assert.ok(/пакет|обнуляется/.test(joined), "не сказано про предоплаченный пакет: " + joined);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "удаление началось до согласия");

    const ok = await cdn.deleteResource("oauth-1", { folderId: "folder-1", resource: "cdn.example.com", confirm: true });
    assert.strictEqual(ok.deleted, true, "ресурс не удалён по согласию");
    assert.strictEqual(await cdn.findResource("oauth-1", "folder-1", "cdn.example.com"), null, "ресурс остался в каталоге");
    stub.quiet.cdnDeleteNoop = true;
    await assert.rejects(() => cdn.deleteResource("oauth-1", { folderId: "folder-1", resource: "plain.example.com", confirm: true }), /не удалился/, "молчаливое «удалено» не поймано");
    stub.quiet.cdnDeleteNoop = false;
  });

  await test("ycCdn: обзор каталога называет, сколько стоит базово, и что не отдаёт https", async () => {
    stub.reset();
    const ov = await cdn.cdnOverview("oauth-1", "folder-1");
    assert.strictEqual(ov.resources.length, 3, "в обзор попали не все ресурсы");
    assert.strictEqual(ov.monthly, 3 * CDN_RESOURCE_MONTH, "базовая цена посчитана неверно: " + ov.monthly);
    assert.strictEqual(ov.withoutSsl.length, 1, "ресурс без сертификата не найден: " + JSON.stringify(ov.withoutSsl.map((r) => r.cname)));
    assert.strictEqual(ov.withoutSsl[0].cname, "plain.example.com", "назван не тот ресурс без сертификата");
    assert.strictEqual(ov.off.length, 1, "выключенный ресурс не найден");
    const joined = ov.lines.join(" ");
    assert.ok(/150 ₽\/мес|3 ресурс/.test(joined), "в обзоре нет денег: " + joined);
    assert.ok(/CNAME/.test(joined), "в обзоре нет записей DNS: " + joined);
    const certs = await cdn.certOverview("oauth-1", "folder-1");
    assert.strictEqual(certs.awaiting.length, 1, "ожидающий подтверждения сертификат не найден");
    assert.ok(/Ждут подтверждения домена/.test(certs.lines.join(" ")), "в обзоре сертификатов нет строки про ожидание");
    assert.ok(/бесплатн/i.test(certs.lines.join(" ")), "в обзоре не сказано, что сертификаты бесплатны");
  });

  console.log("\n[5] Инструмент агента ycCdn: права, согласие и чтение");

  await test("ycCdn: права проверяются ДО запроса — без разрешений в облако ничего не уходит", async () => {
    stub.reset();
    const { tools } = buildTools();
    const create = await tools.ycCdn({ action: "cdncreate", cname: "perm.example.com", bucket: "example.com", confirm: true }, {});
    assert.ok(/ЗАПРЕЧЕНО/.test(create) && /создавать ресурсы/.test(create), "создание не отбито правами: " + create);
    const update = await tools.ycCdn({ action: "cdnpurge", resource: "cdn.example.com", all: true }, {});
    assert.ok(/ЗАПРЕЧЕНО/.test(update) && /менять контейнеры/.test(update), "очистка кэша не отбита правами: " + update);
    const del = await tools.ycCdn({ action: "cdndel", resource: "cdn.example.com", confirm: true }, {});
    assert.ok(/ЗАПРЕЧЕНО/.test(del) && /удалять ресурсы/.test(del), "удаление не отбито правами: " + del);
    const certs = await tools.ycCdn({ action: "certdel", certificate: "site-cert", confirm: true }, {});
    assert.ok(/ЗАПРЕЧЕНО/.test(certs), "удаление сертификата не отбито правами: " + certs);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "изменяющие запросы ушли без разрешений: " + JSON.stringify(writeCalls(stub.calls).map(urlOf)));
  });

  await test("ycCdn: чтение (overview, certs, cert, cdn) не делает ни одной изменяющей операции", async () => {
    stub.reset();
    const { tools } = buildTools();
    const ov = await tools.ycCdn({ action: "overview" }, {});
    assert.ok(/Сертификаты \(4\)/.test(ov), "в обзоре нет сертификатов: " + ov.slice(0, 200));
    assert.ok(/CDN-ресурсы \(3\)/.test(ov), "в обзоре нет ресурсов: " + ov.slice(0, 200));
    assert.ok(/Порядок важен/.test(ov), "в обзоре нет порядка шагов: " + ov.slice(0, 400));
    const certs = await tools.ycCdn({ action: "certs" }, {});
    assert.ok(/site-cert/.test(certs), "список сертификатов пуст: " + certs);
    const cert = await tools.ycCdn({ action: "cert", certificate: "blog-cert" }, {});
    assert.ok(/_acme-challenge\.blog\.example\.com/.test(cert), "в карточке нет записи подтверждения: " + cert);
    const info = await tools.ycCdn({ action: "cdninfo", resource: "cdn.example.com" }, {});
    assert.ok(/https/.test(info) && /CNAME/.test(info), "в карточке ресурса нет https и DNS: " + info);
    const origins = await tools.ycCdn({ action: "origins" }, {});
    assert.ok(/bucket-origin/.test(origins), "группы источников не показаны: " + origins);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение сделало изменяющий запрос: " + JSON.stringify(writeCalls(stub.calls).map(urlOf)));
  });

  await test("ycCdn: платное создание требует согласия и печатает цену, а без него — ничего не создаёт", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true });
    const no = await tools.ycCdn({ action: "cdncreate", cname: "agent.example.com", bucket: "example.com", certificate: "site-cert" }, {});
    assert.ok(/Пока ничего не создаю/.test(no), "создание началось без согласия: " + no);
    assert.ok(/150/.test(no) && /₽/.test(no), "в отказе нет цены: " + no);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "ресурс создан без подтверждения");

    const yes = await tools.ycCdn({ action: "cdncreate", cname: "agent.example.com", bucket: "example.com", certificate: "site-cert", confirm: true }, {});
    assert.ok(/✅/.test(yes), "ресурс не создан по согласию: " + yes);
    assert.ok(/CNAME/.test(yes), "в ответе нет записи DNS: " + yes);
    assert.ok(stub.state.resources.some((r) => r.cname === "agent.example.com"), "ресурс не появился в каталоге");
  });

  await test("ycCdn: выпуск сертификата агентом и отказ без доменов", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true });
    const bad = await tools.ycCdn({ action: "certnew", name: "no-domains" }, {});
    assert.ok(/укажи domains/i.test(bad), "выпуск без доменов прошёл: " + bad);
    const ok = await tools.ycCdn({ action: "certnew", name: "agent-cert", domains: ["agent.example.com"] }, {});
    assert.ok(/✅/.test(ok), "сертификат не выпущен: " + ok);
    assert.ok(/_acme-challenge\.agent\.example\.com/.test(ok), "в ответе нет записи подтверждения: " + ok);
    assert.ok(/ОДНА/.test(ok), "не сказано, что запись подтверждения одна: " + ok);
  });

  await test("ycCdn: удаление агентом без согласия перечисляет последствия", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentDelete: true });
    const r = await tools.ycCdn({ action: "cdndel", resource: "cdn.example.com" }, {});
    assert.ok(/Пока ничего не удаляю/.test(r), "удаление началось без согласия: " + r);
    assert.ok(/перестанут открываться/.test(r), "не сказано, что домены перестанут открываться: " + r);
    assert.ok(/confirm: true/.test(r), "в отказе нет подсказки про confirm: " + r);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "удаление ушло без согласия");
    const cert = await tools.ycCdn({ action: "certdel", certificate: "site-cert" }, {});
    assert.ok(/Пока ничего не удаляю/.test(cert) && /cdn\.example\.com/.test(cert), "удаление сертификата без предупреждения о сайте: " + cert);
  });

  await test("ycCdn: без подключённого облака инструмент не падает, а объясняет", async () => {
    const { tools } = buildTools({ yandexOauthToken: "" });
    const r = await tools.ycCdn({ action: "overview" }, {});
    assert.ok(/не подключён/i.test(r), "нет отказа про подключение: " + r);
    const off = buildTools({ ycAllowAgentCreate: false });
    const perm = await off.tools.ycCdn({ action: "cdncreate", cname: "a.example.com", bucket: "example.com", confirm: true }, {});
    assert.ok(/ЗАПРЕЧЕНО/.test(perm), "права не проверяются без каталога: " + perm);
  });

  console.log("\n[6] Проводка и стоимость");

  await test("ycCdn: канал, мост, схема, группа, промпт, политика и справочник согласованы", () => {
    assert.ok(IPC_SRC.indexOf('ipcMain.handle("yc:cdn"') >= 0, "нет канала yc:cdn");
    assert.ok(!MAIN_SRC.includes('ipcMain.handle("yc:cdn"'), "канал остался в main.js");
    // Соседей по списку не сверяем: у каждого нового модуля свой порядок, и копия
    // всего перечня ломала бы страж от чужой части. Важно, что ycCdn идёт в мост
    // каналов и что мост по-прежнему получает svc (служебный слой).
    assert.ok(/ycCdn,[\s\S]{0,200}?saveSettings, svc: ycService/.test(MAIN_SRC), "модуль не передан в мост каналов");
    assert.ok(MAIN_SRC.indexOf("createYcCdn({") >= 0, "модуль не собран в main.js");
    assert.ok(PRELOAD_SRC.indexOf('yc:cdn') >= 0 && /ycCdn: \(args\)/.test(PRELOAD_SRC), "нет моста окна для ycCdn");
    assert.ok(SCHEMAS_SRC.indexOf('name: "ycCdn"') >= 0, "нет схемы ycCdn");
    for (const a of ["cdncreate", "certnew", "cdnpurge", "origindel"]) assert.ok(SCHEMAS_SRC.indexOf(a) >= 0, "в схеме нет действия " + a);
    assert.ok(/confirm: true/.test(SCHEMAS_SRC.slice(SCHEMAS_SRC.indexOf('name: "ycCdn"'), SCHEMAS_SRC.indexOf('name: "ycCdn"') + 9000)), "схема не требует согласия на платное");
    assert.ok(/ycCdn/.test(CORE_SRC), "инструмент не попал в группу «облако»");
    assert.ok(/ycCdn/.test(PROMPTS_SRC), "инструмент не попал в промпт");
    assert.ok(/"ycBilling", "ycCdn", "ycDb"/.test(POLICY_SRC), "нет политики прав для ycCdn");
    for (const word of ["certnew", "cdncreate", "cdnpurge", "_acme-challenge", "150 ₽", "website.yandexcloud.net"]) {
      assert.ok(GUIDE_SRC.indexOf(word) >= 0, "в справочнике yc.md нет «" + word + "»");
    }
    assert.ok(/HTTPS-сайт из бакета/.test(GUIDE_SRC), "в справочнике нет раздела про HTTPS-сайт");
    // Сторож smoke: канал в списке, счёт каналов, инструмент и место набора в цепочке.
    assert.ok(SMOKE_SRC.indexOf('"yc:billing", "yc:cdn"') >= 0, "сторож не знает канал yc:cdn");
    assert.ok(/каналов в мосте должно быть 31/.test(SMOKE_SRC), "сторож не пересчитал каналы");
    assert.ok(/["']ycCdn["']/.test(SMOKE_SRC), "сторож не знает инструмент ycCdn");
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-cdn.test.js") >= 0, "набора нет в цепочке npm test");
  });

  await test("ycCdn: тариф CDN посчитан по документации, а сертификат — бесплатный", () => {
    const cdnEst = ycCosts.estimate("cdn", {});
    assert.strictEqual(cdnEst.approxMonth, CDN_RESOURCE_MONTH, "базовая цена CDN не совпадает с модулем: " + cdnEst.approxMonth);
    assert.strictEqual(cdnEst.needsConfirm, true, "платный CDN разрешён без согласия");
    const big = ycCosts.estimate("cdn", { resources: 2, gb: 400, requests: 150000000 });
    assert.strictEqual(big.approxMonth, 405.4, "сверх пакета посчитано неверно: " + big.approxMonth);
    const text = ycCosts.formatText(cdnEst);
    assert.ok(/150/.test(text) && /ГБ/.test(text), "в тексте оценки нет пакета: " + text);
    const certEst = ycCosts.estimate("certificateManager", {});
    assert.strictEqual(certEst.level, "free", "сертификат стал платным: " + certEst.level);
    assert.strictEqual(certEst.needsConfirm, false, "бесплатный сертификат требует согласия");
  });

  const failCount = failed;
  console.log("");
  console.log("Итог: " + passed + " прошло, " + failed + " упало");
  stub.server.close();
  process.exit(failCount ? 1 : 0);
})();

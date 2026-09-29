"use strict";

/* ── IAM: сервисные аккаунты, ключи и роли ───────────────────────────────────
   Запуск: node test/yc-iam.test.js   (входит в общий `npm test`)

   Зачем набор. Облако умело завести сервисный аккаунт только «внутри выкатки» —
   посмотреть, какие аккаунты есть, что им выдано, чем они входят и что сломается
   при удалении, было нечем, и человек шёл в чужую консоль. Теперь это делают
   модуль src/yc-iam.js и инструмент ycIam.

   Что проверяется и почему именно это:

     • имена и роли проверяются ДО запроса (подчёркивание в имени сервисного
       аккаунта облако не принимает, как у машины, — проверка своя), а каталог
       ролей отвечает словами и честно говорит «не знаю» про незнакомую роль;
     • «каких ролей хватает для задачи» — узкая роль вместо editor;
     • ключ-хвост (создан давно и ни разу не использовался, или не использовался
       давно) обязан быть назван: это доступ, который ничего не делает, но утечёт;
     • тело создания аккаунта и привязки роли сверяются целиком, потому что
       привязки меняются ДЕЛЬТАМИ: ошибка в теле отняла бы чужие права;
     • результат, а не факт отправки: после правки аккаунт перечитывается, после
       выдачи роли привязки перечитываются — и оба случая проверены НЕГАТИВНЫМИ
       контролями («облако ответило сделано, а на деле ничего не изменилось»);
     • «роль уже есть» не пишет в облако, лишняя выдача и снятие несуществующей
       ловятся ДО записи;
     • секрет ключа облако отдаёт ОДИН раз: после создания он не возвращается ни
       в списке, ни в карточке (там маска), и это проверяется по ответам сервиса;
     • удаление аккаунта называет, что перестанет работать (ключи и роли), а не
       просто «готово»;
     • инструмент агента ycIam: права (создание / роли / удаление) проверяются ДО
       запроса, каталог ролей работает даже без подключённого облака, а создание
       ключа требует подтверждения и отдаёт секрет ровно один раз;
     • проводка: канал yc:iam, мост окна, схема, группа «облако» в ядре, промпт,
       политика прав, справочник агента и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает НАСТОЯЩИЙ модуль IAM. */

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
const ycIamLib = require(path.join(ROOT, "src", "yc-iam.js"));
const { createYcIam, checkName, checkRole, roleHuman, roleDanger, minimalRoles, keyTrouble, humanDays } = ycIamLib;
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const MAIN_SRC = read("src", "main.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённый Yandex Cloud IAM ────────────────────────────────────────────
// Настоящая машина состояний: создание, правка, выдача роли и удаление меняют то,
// что отдаёт чтение. Поэтому проверяется не форма запроса, а то, что после вызова
// в каталоге действительно стало иначе.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function initialState() {
  return {
    accounts: [
      { id: "sa-1", folderId: "folder-1", name: "sa-site", description: "выкатка сайта", createdAt: daysAgo(200), status: "ACTIVE", lastAuthenticatedAt: daysAgo(3) },
      // Аккаунт без ролей: он ничего не может. Такие надо называть прямо.
      { id: "sa-2", folderId: "folder-1", name: "sa-empty", description: "", createdAt: daysAgo(30), status: "ACTIVE" },
      // Ключ, которым давно не пользовались — «мёртвый» доступ.
      { id: "sa-3", folderId: "folder-1", name: "sa-old", description: "старый бот", createdAt: daysAgo(400), status: "ACTIVE", lastAuthenticatedAt: daysAgo(200) },
    ],
    accessKeys: [
      { id: "ak-1", serviceAccountId: "sa-1", keyId: "YCAJEtest0001", description: "бэкап бакета", createdAt: daysAgo(300), lastUsedAt: daysAgo(2) },
    ],
    apiKeys: [
      // Секрет в списке не приходит — только маска. Так отвечает настоящее облако.
      { id: "ap-1", serviceAccountId: "sa-1", description: "API шлюза", createdAt: daysAgo(400), maskedSecret: "****Ab12cd" },
      { id: "ap-2", serviceAccountId: "sa-3", description: "старый ключ", createdAt: daysAgo(400), lastUsedAt: daysAgo(300), maskedSecret: "****Zz99" },
    ],
    authorizedKeys: [
      { id: "pub-1", serviceAccountId: "sa-1", description: "ssh к машине", keyAlgorithm: "RSA_2048", publicKey: "ssh-rsa AAAAB3NzaC1yc2E-test", createdAt: daysAgo(10), lastUsedAt: daysAgo(1) },
    ],
    bindings: [
      { roleId: "storage.editor", subject: { id: "sa-1", type: "serviceAccount" } },
      { roleId: "lockbox.payloadViewer", subject: { id: "sa-1", type: "serviceAccount" } },
      { roleId: "viewer", subject: { id: "user-1", type: "userAccount" } },
      { roleId: "api-gateway.editor", subject: { id: "sa-3", type: "serviceAccount" } },
    ],
    roles: [
      { id: "viewer", description: "Просмотр ресурсов" },
      { id: "storage.editor", description: "Управление Object Storage" },
      { id: "compute.editor", description: "Управление виртуальными машинами" },
      { id: "lockbox.payloadViewer", description: "Доступ к содержимому секретов" },
      // Роль, которой нет в каталоге приложения: про неё нельзя говорить «узкая».
      { id: "enterprise.foo.bar", description: "Роль из другого каталога" },
    ],
  };
}

function startIamStub() {
  const calls = [];
  const state = initialState();
  // «Облако молча ничего не сделало» — так проверяются негативные контроли:
  // ответ 200 с завершённой операцией, а состояние не меняется.
  const quiet = { patchNoop: false, bindingNoop: false, deleteNoop: false, keyFail: "" };
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

      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }

      if (url.indexOf("/operations/") >= 0) {
        const id = url.slice(url.indexOf("/operations/") + "/operations/".length);
        return json(res, 200, { id, done: true, response: ops.get(id) || {} });
      }

      const op = (createdId) => {
        const id = "op-" + ++seq;
        if (createdId) ops.set(id, { id: createdId });
        return { id, done: false };
      };

      // ── сервисные аккаунты ──────────────────────────────────────────────
      if (q === "/iam/v1/serviceAccounts" && method === "GET") {
        return json(res, 200, { serviceAccounts: plain(state.accounts) });
      }
      if (q === "/iam/v1/serviceAccounts" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.folderId || !b.name) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет каталога или имени" });
        if (!/^[a-z][-a-z0-9]*[a-z0-9]$/.test(b.name)) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: name must match ^[a-z][-a-z0-9]{0,61}[a-z0-9]$" });
        if (state.accounts.some((a) => a.name === b.name)) return json(res, 409, { code: 6, message: "ALREADY_EXISTS: сервисный аккаунт с таким именем уже есть" });
        const id = "sa-" + ++seq;
        state.accounts.push({
          id,
          folderId: b.folderId,
          name: b.name,
          description: b.description || "",
          labels: b.labels || {},
          createdAt: new Date().toISOString(),
          expiresAt: b.expiresAt || "",
          status: "ACTIVE",
        });
        return json(res, 200, op(id));
      }
      if (q.indexOf("/iam/v1/serviceAccounts/") === 0) {
        const id = q.slice("/iam/v1/serviceAccounts/".length);
        const acc = state.accounts.find((a) => a.id === id);
        if (method === "GET") {
          if (!acc) return json(res, 404, { code: 5, message: "NOT_FOUND: сервисный аккаунт не найден" });
          return json(res, 200, plain(acc));
        }
        if (method === "PATCH") {
          const b = JSON.parse(body || "{}");
          if (!acc) return json(res, 404, { code: 5, message: "NOT_FOUND: сервисный аккаунт не найден" });
          if (!b.updateMask) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: update_mask обязателен" });
          if (quiet.patchNoop) return json(res, 200, op());
          // Настоящее облако БЕЗ маски сбрасывает всё, чего нет в теле, — здесь
          // маска есть, поэтому меняются только названные поля.
          const fields = String(b.updateMask).split(",").map((s) => s.trim());
          if (fields.indexOf("name") >= 0 && b.name) acc.name = b.name;
          if (fields.indexOf("description") >= 0) acc.description = b.description == null ? "" : b.description;
          return json(res, 200, op());
        }
        if (method === "DELETE") {
          if (!acc) return json(res, 404, { code: 5, message: "NOT_FOUND: сервисный аккаунт не найден" });
          if (quiet.deleteNoop) return json(res, 200, op());
          state.accounts = state.accounts.filter((a) => a.id !== id);
          // Удаление аккаунта забирает его ключи и роли — как в облаке.
          state.accessKeys = state.accessKeys.filter((k) => k.serviceAccountId !== id);
          state.apiKeys = state.apiKeys.filter((k) => k.serviceAccountId !== id);
          state.authorizedKeys = state.authorizedKeys.filter((k) => k.serviceAccountId !== id);
          state.bindings = state.bindings.filter((b2) => b2.subject.id !== id);
          return json(res, 200, op());
        }
      }

      // ── ключи доступа (S3-совместимые) ──────────────────────────────────
      if (q === "/iam/aws-compatibility/v1/accessKeys" && method === "GET") {
        const sa = (url.split("serviceAccountId=")[1] || "").split("&")[0];
        return json(res, 200, { accessKeys: plain(state.accessKeys.filter((k) => !sa || k.serviceAccountId === decodeURIComponent(sa))) });
      }
      if (q === "/iam/aws-compatibility/v1/accessKeys" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!b.serviceAccountId) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет сервисного аккаунта" });
        const id = "ak-" + ++seq;
        const key = { id, serviceAccountId: b.serviceAccountId, keyId: "YCAJEtest" + seq, description: b.description || "", createdAt: new Date().toISOString() };
        state.accessKeys.push(key);
        // Секрет приходит РОВНО здесь и никогда в чтении.
        return json(res, 200, { accessKey: plain(key), secret: "SECRET-ACCESS-" + seq });
      }
      if (q.indexOf("/iam/aws-compatibility/v1/accessKeys/") === 0 && method === "DELETE") {
        const id = q.slice("/iam/aws-compatibility/v1/accessKeys/".length);
        if (!state.accessKeys.some((k) => k.id === id)) return json(res, 404, { code: 5, message: "NOT_FOUND: ключ не найден" });
        state.accessKeys = state.accessKeys.filter((k) => k.id !== id);
        return json(res, 200, op());
      }

      // ── API-ключи ───────────────────────────────────────────────────────
      if (q === "/iam/v1/apiKeys" && method === "GET") {
        // Сбой одного вида ключей: остальные обязаны вернуться всё равно.
        if (quiet.keyFail === "api") return json(res, 500, { code: 13, message: "внутренняя ошибка" });
        const sa = (url.split("serviceAccountId=")[1] || "").split("&")[0];
        return json(res, 200, { apiKeys: plain(state.apiKeys.filter((k) => !sa || k.serviceAccountId === decodeURIComponent(sa))) });
      }
      if (q === "/iam/v1/apiKeys" && method === "POST") {
        const b = JSON.parse(body || "{}");
        const id = "ap-" + ++seq;
        const key = {
          id,
          serviceAccountId: b.serviceAccountId,
          description: b.description || "",
          createdAt: new Date().toISOString(),
          expiresAt: b.expiresAt || "",
          scopes: b.scopes || [],
          maskedSecret: "****" + seq,
        };
        state.apiKeys.push(key);
        return json(res, 200, { apiKey: plain(key), secret: "SECRET-API-" + seq });
      }
      if (q.indexOf("/iam/v1/apiKeys/") === 0 && method === "DELETE") {
        const id = q.slice("/iam/v1/apiKeys/".length);
        if (!state.apiKeys.some((k) => k.id === id)) return json(res, 404, { code: 5, message: "NOT_FOUND: ключ не найден" });
        state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
        return json(res, 200, op());
      }

      // ── ключи подписи (authorized) ──────────────────────────────────────
      if (q === "/iam/v1/keys" && method === "GET") {
        const sa = (url.split("serviceAccountId=")[1] || "").split("&")[0];
        return json(res, 200, { keys: plain(state.authorizedKeys.filter((k) => !sa || k.serviceAccountId === decodeURIComponent(sa))) });
      }
      if (q === "/iam/v1/keys" && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (["RSA_2048", "RSA_4096"].indexOf(String(b.keyAlgorithm)) < 0) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: неверный алгоритм" });
        const id = "pub-" + ++seq;
        const key = { id, serviceAccountId: b.serviceAccountId, description: b.description || "", keyAlgorithm: b.keyAlgorithm, publicKey: "ssh-rsa AAAA-new-" + seq, createdAt: new Date().toISOString() };
        state.authorizedKeys.push(key);
        return json(res, 200, { key: plain(key), privateKey: "-----BEGIN PRIVATE KEY-----\nNEW" + seq + "\n-----END PRIVATE KEY-----" });
      }
      if (q.indexOf("/iam/v1/keys/") === 0 && method === "DELETE") {
        const id = q.slice("/iam/v1/keys/".length);
        if (!state.authorizedKeys.some((k) => k.id === id)) return json(res, 404, { code: 5, message: "NOT_FOUND: ключ не найден" });
        state.authorizedKeys = state.authorizedKeys.filter((k) => k.id !== id);
        // Этот метод отвечает БЕЗ операции (пустым телом) — модуль обязан это
        // пережить: ждать операцию, которой сервис не дал, нечего.
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end("");
      }

      // ── роли ────────────────────────────────────────────────────────────
      if (q === "/iam/v1/roles" && method === "GET") {
        const filter = decodeURIComponent((url.split("filter=")[1] || "").split("&")[0] || "");
        const list = filter ? state.roles.filter((r) => r.id.indexOf(filter) >= 0) : state.roles;
        return json(res, 200, { roles: plain(list) });
      }

      // ── привязки ролей каталога ─────────────────────────────────────────
      if (/:listAccessBindings$/.test(q) && method === "GET") {
        return json(res, 200, { accessBindings: plain(state.bindings) });
      }
      if (/:updateAccessBindings$/.test(q) && method === "POST") {
        const b = JSON.parse(body || "{}");
        if (!Array.isArray(b.accessBindingDeltas) || !b.accessBindingDeltas.length) {
          return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нужны дельты привязок" });
        }
        if (quiet.bindingNoop) return json(res, 200, op());
        for (const d of b.accessBindingDeltas) {
          const bd = d.accessBinding || {};
          if (d.action === "ADD") {
            if (!state.bindings.some((x) => x.roleId === bd.roleId && x.subject.id === bd.subject.id && x.subject.type === bd.subject.type)) {
              state.bindings.push(plain(bd));
            }
          } else if (d.action === "REMOVE") {
            // Дельты, а не список целиком: снимается ровно названная пара.
            state.bindings = state.bindings.filter((x) => !(x.roleId === bd.roleId && x.subject.id === bd.subject.id));
          }
        }
        return json(res, 200, op());
      }

      return json(res, 404, { code: 5, message: "NOT_FOUND: " + method + " " + q });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.patchNoop = false;
    quiet.bindingNoop = false;
    quiet.deleteNoop = false;
    quiet.keyFail = "";
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function mkIam() {
  return createYcIam({
    fetchJson: yandex._fetchJson,
    endpoint: yandex.endpoint,
    getIamToken: yandex.getIamToken,
    waitOperation: yandex.waitOperation,
    serviceError: yandex.serviceError,
    isNetworkError: yandex.isNetworkError,
  });
}

function buildTools(settingsOver) {
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
    ycIam: mkIam(),
    ycCosts: {},
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
  const stub = await startIamStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Имена, роли, задачи и ключи-хвосты — до всякой сети");

  await test("ycIam: имя сервисного аккаунта проверяется по правилам облака, с подсказкой", () => {
    assert.strictEqual(checkName("sa-site"), "sa-site", "годное имя не принято");
    assert.strictEqual(checkName(" sa-site "), "sa-site", "лишние пробелы не срезаны");
    // Подчёркивание облако в имени сервисного аккаунта НЕ принимает (в отличие
    // от имени машины): проверка должна быть своя, а не «общая для всех».
    assert.throws(() => checkName("sa_site"), /не подойдёт|дефис/, "подчёркивание прошло проверку");
    assert.throws(() => checkName("My-Site"), /буквы/, "заглавные буквы прошли проверку");
    let hint = "";
    try {
      checkName("My-Site");
    } catch (e) {
      hint = e.message;
    }
    assert.ok(/my-site/.test(hint), "в отказе нет готового имени: " + hint);
    assert.throws(() => checkName(""), /Укажи имя/, "пустое имя прошло проверку");
  });

  await test("ycIam: роль проверяется по форме, а незнакомая не выдаётся за безопасную", () => {
    assert.strictEqual(checkRole("storage.editor"), "storage.editor", "узкая роль не принята");
    assert.strictEqual(checkRole(" viewer "), "viewer", "примитивная роль не принята");
    assert.throws(() => checkRole("Storage.Editor"), /строчн/, "заглавная буква в начале роли прошла");
    assert.throws(() => checkRole(""), /Не указана роль/, "пустая роль прошла");
    assert.ok(/storage\.editor/.test((() => {
      try {
        checkRole("");
      } catch (e) {
        return e.message;
      }
      return "";
    })()), "в отказе нет примера узкой роли");
    assert.strictEqual(roleHuman("compute.editor"), "compute.editor — машины и снимки", "человеческая строка роли изменилась");
    assert.strictEqual(roleDanger("editor"), "wide", "editor не считается широкой ролью");
    assert.strictEqual(roleDanger("lockbox.payloadViewer"), "secret", "доступ к секретам не помечен");
    // Роль из чужого каталога: «не знаю» честнее выдуманного «узкая».
    assert.strictEqual(roleDanger("enterprise.foo.bar"), "", "незнакомая роль названа безопасной");
  });

  await test("ycIam: для задачи предлагаются узкие роли, а не editor", () => {
    const site = minimalRoles("site");
    assert.deepStrictEqual(plain(site.roles), ["storage.editor"], "для сайта предложены не те роли: " + JSON.stringify(site));
    assert.ok(!site.roles.includes("editor"), "для сайта предложена широкая роль");
    assert.ok(/бакет/.test(site.note), "не сказано, что публичному сайту роль может быть не нужна вовсе");
    const cont = minimalRoles("containers");
    assert.ok(cont.roles.includes("container-registry.images.puller"), "для выкатки не хватает роли на образы: " + cont.roles.join(", "));
    assert.ok(/lockbox/.test(cont.note), "для выкатки не сказано про секреты");
    assert.ok(/ЗНАЧЕНИЯ/.test(minimalRoles("secrets").note), "про доступ к значениям секретов не предупреждается");
    assert.strictEqual(minimalRoles("чего-то такого"), null, "неизвестная задача дала набор ролей");
    assert.strictEqual(minimalRoles(""), null, "пустая задача дала набор ролей");
    assert.ok(ycIamLib.TASK_KEYS.includes("readonly"), "нет задачи «только смотреть»");
  });

  await test("ycIam: мёртвый ключ называется прямо, а живой — нет", () => {
    assert.ok(/НИ РАЗУ/.test(keyTrouble({ lastUsedAt: "", ageDays: 30, ageHuman: "30 дн. назад" })), "ключ без использования не назван мёртвым");
    assert.ok(/не использовался 200 дн/.test(keyTrouble({ lastUsedAt: daysAgo(200), usedDays: 200, usedHuman: humanDays(200) })), "давно не использованный ключ не назван");
    assert.strictEqual(keyTrouble({ lastUsedAt: daysAgo(2), usedDays: 2, usedHuman: humanDays(2) }), "", "рабочий ключ назван проблемным");
    assert.strictEqual(keyTrouble({ lastUsedAt: "", ageDays: 2, ageHuman: "вчера" }), "пока ни разу не использовался", "свежий ключ без использования назван мёртвым");
  });

  console.log("\n[2] Модуль против подменённого облака: чтение, правка, ключи и роли");

  await test("ycIam: обзор показывает аккаунты с ролями и ключами и называет хвосты", async () => {
    stub.reset();
    const iam = mkIam();
    const ov = await iam.overview("oauth-1", "folder-1");
    assert.strictEqual(ov.accounts.length, 3, "прочитались не все аккаунты: " + ov.accounts.length);
    const site = ov.rows.find((r) => r.account.name === "sa-site");
    assert.ok(site.roleIds.includes("storage.editor"), "роли аккаунта не собраны: " + site.roleIds.join(", "));
    assert.strictEqual(site.keyCount, 3, "ключи всех трёх видов не собраны: " + site.keyCount);
    assert.ok(!site.useless, "рабочий аккаунт назван бесполезным");
    // Аккаунт без ролей — это «недоделанный робот»: о нём надо сказать прямо.
    assert.deepStrictEqual(plain(ov.useless.map((r) => r.account.name)), ["sa-empty"], "аккаунт без ролей не назван");
    assert.ok(ov.stale.map((r) => r.account.name).includes("sa-old"), "аккаунт с неиспользуемым ключом не назван");
    assert.ok(ov.hasOwnProperty("neverUsed"), "в обзоре нет раздела «ни разу не входили»");
    assert.ok(ov.lines.join(" ").indexOf("без ролей") >= 0 || /НЕТ — аккаунт/.test(ov.lines.join(" ")), "в строках обзора не сказано про аккаунт без ролей");
    // Читающий вызов ничего не меняет: в облако уходят только GET.
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение обзора что-то изменило в облаке");
  });

  await test("ycIam: ключ доступа создаётся телом, которое ждёт API, и секрет приходит один раз", async () => {
    stub.reset();
    const iam = mkIam();
    const made = await iam.createAccessKey("oauth-1", { folderId: "folder-1", account: "sa-site", description: "новый бэкап" });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/iam/aws-compatibility/v1/accessKeys");
    assert.ok(call, "запроса на создание ключа доступа нет");
    assert.deepStrictEqual(plain(JSON.parse(call.body)), { serviceAccountId: "sa-1", description: "новый бэкап" }, "тело создания ключа доступа изменилось");
    assert.ok(/^SECRET-ACCESS-/.test(made.secret), "секрет не вернулся из создания: " + made.secret);
    assert.ok(made.key.keyId, "keyId не прочитан из ответа");
    assert.ok(made.warnings.some((w) => /ОДИН раз|сохрани/i.test(w)), "не сказано, что секрет показывается один раз");

    // Второй раз секрет не показывают нигде: перечитываем всё, что можно.
    const keys = await iam.allKeys("oauth-1", "sa-1");
    const dump = JSON.stringify(keys);
    assert.ok(dump.indexOf(made.secret) < 0, "секрет вернулся в чтении списка ключей");
    assert.ok(!Object.prototype.hasOwnProperty.call(keys.accessKeys[0], "secret"), "в карточке ключа есть поле с секретом");
    // У API-ключа вместо секрета маска — так отвечает само облако.
    const apiKey = keys.apiKeys.find((k) => k.id === "ap-1");
    assert.strictEqual(apiKey.maskedSecret, "****Ab12cd", "маска секрета потерялась");
  });

  await test("ycIam: ключи трёх видов собираются вместе, и мёртвые называются", async () => {
    stub.reset();
    const iam = mkIam();
    const keys = await iam.allKeys("oauth-1", "sa-1");
    assert.strictEqual(keys.total, 3, "ключи трёх видов не собраны: " + keys.total);
    assert.strictEqual(keys.accessKeys.length, 1, "нет ключа доступа");
    assert.strictEqual(keys.apiKeys.length, 1, "нет API-ключа");
    assert.strictEqual(keys.authorizedKeys.length, 1, "нет ключа подписи");
    assert.ok(keys.keys.every((k) => k.kind), "у ключа не назван вид");
    const old = await iam.allKeys("oauth-1", "sa-3");
    assert.ok(old.troubles.length, "мёртвый ключ не назван в предупреждениях");
  });

  await test("ycIam: если один вид ключей не прочитался, остальные всё равно возвращаются", async () => {
    stub.reset();
    // «Ключей нет вовсе» и «ключи не показались» — разные вещи: второе нельзя
    // выдавать за первое, иначе агент скажет «аккаунт без доступа» на сбое прав.
    stub.quiet.keyFail = "api";
    const iam = mkIam();
    const keys = await iam.allKeys("oauth-1", "sa-1");
    assert.strictEqual(keys.apiKeys.length, 0, "сломанный вид ключей что-то вернул");
    assert.ok(keys.accessKeys.length >= 1 && keys.authorizedKeys.length >= 1, "рабочие виды ключей потерялись вместе со сломанным");
    assert.ok(keys.errors.length, "сбой чтения не назван");
    assert.ok(/внутренняя ошибка|500/.test(keys.errors.join(" ")), "причина сбоя не названа: " + keys.errors.join(" | "));
    stub.quiet.keyFail = "";
  });

  await test("ycIam: аккаунт создаётся с телом {folderId, name, description} и перечитывается", async () => {
    stub.reset();
    const iam = mkIam();
    const r = await iam.createServiceAccount("oauth-1", { folderId: "folder-1", name: "sa-new", description: "новый робот" });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/iam/v1/serviceAccounts");
    assert.ok(call, "запроса на создание аккаунта нет");
    assert.deepStrictEqual(plain(JSON.parse(call.body)), { folderId: "folder-1", name: "sa-new", description: "новый робот" }, "тело создания аккаунта изменилось");
    assert.strictEqual(r.account.name, "sa-new", "созданный аккаунт не перечитался");
    assert.strictEqual(r.account.statusHuman, "работает", "статус не переведён по-русски");
    assert.ok(r.warnings.some((w) => /без роли/i.test(w)), "не сказано, что аккаунт без роли ничего не может");
    // Первое, что должен предложить агент после создания — УЗКУЮ роль.
    assert.ok(r.warnings.some((w) => /узкую роль/i.test(w)), "не сказано про узкую роль");
    assert.strictEqual(stub.state.accounts.filter((a) => a.name === "sa-new").length, 1, "аккаунт не появился в каталоге");
  });

  await test("ycIam: правка аккаунта ставит маску и проверяется перечитыванием", async () => {
    stub.reset();
    const iam = mkIam();
    const r = await iam.updateServiceAccount("oauth-1", { folderId: "folder-1", account: "sa-empty", newName: "sa-renamed", description: "теперь с делом" });
    const call = writeCalls(stub.calls).find((c) => urlOf(c) === "/iam/v1/serviceAccounts/sa-2" && c.method === "PATCH");
    assert.ok(call, "запроса на правку аккаунта нет");
    const body = plain(JSON.parse(call.body));
    assert.strictEqual(body.updateMask, "name,description", "нет маски обновления — сервис сбросит то, чего нет в теле");
    assert.ok(r.changed, "правка не отмечена применённой");
    assert.strictEqual(stub.state.accounts.find((a) => a.id === "sa-2").name, "sa-renamed", "имя не изменилось в каталоге");
    const noop = await iam.updateServiceAccount("oauth-1", { folderId: "folder-1", account: "sa-renamed", newName: "sa-renamed", description: "теперь с делом" });
    assert.strictEqual(noop.changed, false, "правка «в никуда» отмечена применённой");
  });

  await test("ycIam: молча не применённая правка ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.patchNoop = true;
    const iam = mkIam();
    await assert.rejects(
      () => iam.updateServiceAccount("oauth-1", { folderId: "folder-1", account: "sa-empty", description: "не пройдёт" }),
      /не применилась/,
      "«облако ответило сделано, а правки нет» принято за успех"
    );
    stub.quiet.patchNoop = false;
  });

  await test("ycIam: роль выдаётся дельтой ADD и подтверждается перечитыванием привязок", async () => {
    stub.reset();
    const iam = mkIam();
    const r = await iam.grantRole("oauth-1", { folderId: "folder-1", account: "sa-empty", role: "compute.editor" });
    const call = writeCalls(stub.calls).find((c) => /:updateAccessBindings$/.test(urlOf(c)));
    assert.ok(call, "запроса на выдачу роли нет");
    assert.deepStrictEqual(
      plain(JSON.parse(call.body)),
      { accessBindingDeltas: [{ action: "ADD", accessBinding: { roleId: "compute.editor", subject: { id: "sa-2", type: "serviceAccount" } } }] },
      "тело выдачи роли изменилось — привязки меняются дельтами, а не списком"
    );
    assert.ok(stub.state.bindings.some((b) => b.roleId === "compute.editor" && b.subject.id === "sa-2"), "роль не появилась в каталоге");
    assert.deepStrictEqual(plain(r.roles), ["compute.editor"], "список ролей аккаунта не перечитался: " + r.roles.join(", "));
    // Чужие роли не тронуты: дельта задевает только названную пару.
    assert.ok(stub.state.bindings.some((b) => b.roleId === "viewer" && b.subject.id === "user-1"), "права человека снялись вместе с выдачей роли");
    assert.ok(r.warnings.some((w) => /ВЕСЬ каталог/.test(w)), "не сказано, что роль действует на весь каталог");
  });

  await test("ycIam: широкая роль предупреждается, а лишняя выдача не пишет в облако", async () => {
    stub.reset();
    const iam = mkIam();
    const wide = await iam.grantRole("oauth-1", { folderId: "folder-1", account: "sa-empty", role: "editor" });
    assert.ok(wide.warnings.some((w) => /ШИРОКАЯ/.test(w)), "editor выдан без предупреждения: " + wide.warnings.join(" | "));
    const secretRole = await iam.grantRole("oauth-1", { folderId: "folder-1", account: "sa-2", role: "lockbox.payloadViewer" });
    assert.ok(secretRole.warnings.some((w) => /ДАННЫЕ/.test(w)), "роль на секреты выдана без предупреждения");

    const before = writeCalls(stub.calls).length;
    const again = await iam.grantRole("oauth-1", { folderId: "folder-1", account: "sa-1", role: "storage.editor" });
    assert.strictEqual(again.changed, false, "повторная выдача роли отмечена изменением");
    assert.ok(/уже есть/.test(again.message), "повторная выдача объяснена плохо: " + again.message);
    assert.strictEqual(writeCalls(stub.calls).length, before, "повторная выдача всё-таки ушла в облако");
  });

  await test("ycIam: роль снимается дельтой REMOVE и снятие несуществующей ловится до записи", async () => {
    stub.reset();
    const iam = mkIam();
    const r = await iam.revokeRole("oauth-1", { folderId: "folder-1", account: "sa-site", role: "lockbox.payloadViewer" });
    const call = writeCalls(stub.calls).find((c) => /:updateAccessBindings$/.test(urlOf(c)));
    assert.deepStrictEqual(plain(JSON.parse(call.body)).accessBindingDeltas[0].action, "REMOVE", "снятие роли не дельтой REMOVE");
    assert.ok(!stub.state.bindings.some((b) => b.roleId === "lockbox.payloadViewer" && b.subject.id === "sa-1"), "роль осталась в каталоге");
    assert.ok(stub.state.bindings.some((b) => b.roleId === "storage.editor" && b.subject.id === "sa-1"), "вместе с одной ролью снялась другая");
    const before = writeCalls(stub.calls).length;
    await assert.rejects(() => iam.revokeRole("oauth-1", { folderId: "folder-1", account: "sa-site", role: "compute.editor" }), /и так нет/, "снятие несуществующей роли прошло молча");
    assert.strictEqual(writeCalls(stub.calls).length, before, "снятие несуществующей роли ушло в облако");
  });

  await test("ycIam: молча не выданная роль ловится перечитыванием привязок", async () => {
    stub.reset();
    stub.quiet.bindingNoop = true;
    const iam = mkIam();
    await assert.rejects(
      () => iam.grantRole("oauth-1", { folderId: "folder-1", account: "sa-empty", role: "compute.editor" }),
      /не появилась/,
      "«права выданы», которых нет, приняты за успех"
    );
    stub.quiet.bindingNoop = false;
  });

  await test("ycIam: API-ключ и ключ подписи создаются своими телами, удаляются своим видом", async () => {
    stub.reset();
    const iam = mkIam();
    const api = await iam.createApiKey("oauth-1", { folderId: "folder-1", account: "sa-site", description: "шлюз", expiresAt: "2026-12-31T00:00:00Z", scopes: ["yc.serverless.functions.invoke"] });
    const apiCall = writeCalls(stub.calls).find((c) => urlOf(c) === "/iam/v1/apiKeys");
    assert.deepStrictEqual(
      plain(JSON.parse(apiCall.body)),
      { serviceAccountId: "sa-1", description: "шлюз", scopes: ["yc.serverless.functions.invoke"], expiresAt: "2026-12-31T00:00:00Z" },
      "тело создания API-ключа изменилось"
    );
    assert.ok(/^SECRET-API-/.test(api.secret), "секрет API-ключа не вернулся");
    assert.ok(api.warnings.some((w) => /срок|Срок/.test(w)), "про срок ключа не сказано: " + api.warnings.join(" | "));

    const pub = await iam.createAuthorizedKey("oauth-1", { folderId: "folder-1", account: "sa-site", description: "ssh", algorithm: "rsa_4096" });
    const pubCall = writeCalls(stub.calls).find((c) => urlOf(c) === "/iam/v1/keys");
    assert.deepStrictEqual(plain(JSON.parse(pubCall.body)), { serviceAccountId: "sa-1", keyAlgorithm: "RSA_4096", description: "ssh" }, "тело создания ключа подписи изменилось");
    assert.ok(/BEGIN PRIVATE KEY/.test(pub.privateKey), "приватный ключ не вернулся из создания");
    assert.ok(pub.warnings.some((w) => /ОДИН раз/.test(w)), "не сказано, что приватная часть показывается один раз");

    await assert.rejects(() => iam.createAuthorizedKey("oauth-1", { folderId: "folder-1", account: "sa-site", algorithm: "RSA_1024" }), /не бывает/, "несуществующий алгоритм прошёл");

    // Удаление ключа любого вида — одним действием, вид назван словами.
    assert.ok(/удалён/.test((await iam.deleteKeyByKind("oauth-1", "access", "ak-1")).message), "ключ доступа не удалился");
    assert.ok(!stub.state.accessKeys.some((k) => k.id === "ak-1"), "ключ доступа остался в каталоге");
    assert.ok(/удалён/.test((await iam.deleteKeyByKind("oauth-1", "api", "ap-1")).message), "API-ключ не удалился");
    // Ключ подписи сервис удаляет БЕЗ операции (пустым телом) — модуль обязан это пережить.
    assert.ok(/удалён/.test((await iam.deleteKeyByKind("oauth-1", "authorized", "pub-1")).message), "ключ подписи не удалился");
    assert.ok(!stub.state.authorizedKeys.some((k) => k.id === "pub-1"), "ключ подписи остался в каталоге");
    await assert.rejects(() => iam.deleteKeyByKind("oauth-1", "невесть-что", "ak-2"), /Не понял вид ключа/, "неизвестный вид ключа прошёл");
    await assert.rejects(() => iam.deleteAccessKey("oauth-1", ""), /Не указан id ключа/, "удаление без id прошло");
  });

  await test("ycIam: удаление аккаунта называет, что перестанет работать, и проверяется перечитыванием", async () => {
    stub.reset();
    const iam = mkIam();
    const r = await iam.deleteServiceAccount("oauth-1", { folderId: "folder-1", account: "sa-old" });
    assert.ok(r.deleted, "аккаунт не отмечен удалённым");
    assert.ok(r.keys.length, "не названы ключи, которые перестанут работать");
    assert.ok(r.warnings.some((w) => /перестали работать|сломаются/.test(w)), "не сказано, что сломается вместе с аккаунтом: " + r.warnings.join(" | "));
    assert.ok(r.warnings.some((w) => /Сняты роли/.test(w)), "не сказано про снятые роли");
    assert.ok(!stub.state.accounts.some((a) => a.id === "sa-3"), "аккаунт остался в каталоге");
    assert.ok(!stub.state.apiKeys.some((k) => k.serviceAccountId === "sa-3"), "ключи удалённого аккаунта остались");
    assert.ok(!stub.state.bindings.some((b) => b.subject.id === "sa-3"), "роли удалённого аккаунта остались");
  });

  await test("ycIam: молча не удалённый аккаунт ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.deleteNoop = true;
    const iam = mkIam();
    await assert.rejects(() => iam.deleteServiceAccount("oauth-1", { folderId: "folder-1", account: "sa-empty" }), /не удалился/, "удаление без результата принято за успех");
    stub.quiet.deleteNoop = false;
  });

  await test("ycIam: роли берутся из облака живым списком, с фильтром", async () => {
    stub.reset();
    const iam = mkIam();
    const all = await iam.roles("oauth-1");
    assert.strictEqual(all.length, stub.state.roles.length, "прочитались не все роли: " + all.length);
    const known = all.find((r) => r.id === "storage.editor");
    assert.ok(known.known && known.kind === "write", "знакомая роль не помечена: " + JSON.stringify(known));
    const strange = all.find((r) => r.id === "enterprise.foo.bar");
    assert.strictEqual(strange.known, false, "незнакомая роль помечена как известная");
    const filtered = await iam.roles("oauth-1", "lockbox");
    assert.deepStrictEqual(plain(filtered.map((r) => r.id)), ["lockbox.payloadViewer"], "фильтр ролей не сработал");
  });

  await test("ycIam: карточка аккаунта читается словами — что может, чем входит и что сломается", async () => {
    stub.reset();
    const iam = mkIam();
    const acc = await iam.findServiceAccount("oauth-1", "folder-1", "sa-empty");
    const keys = await iam.allKeys("oauth-1", acc.id);
    const roles = await iam.bindingsFor("oauth-1", "folder-1", acc.id);
    const lines = iam.cardLines(acc, { keys, roles }).join("\n");
    assert.ok(/sa-empty/.test(lines), "в карточке нет имени аккаунта");
    assert.ok(/НЕТ — аккаунт ничего не может/.test(lines), "карточка не говорит, что аккаунт без ролей ничего не может: " + lines);
    assert.ok(/ни одного/.test(lines), "карточка не говорит, что ключей нет");
    assert.ok(/ничего не сломается/.test(lines), "карточка не объясняет, что удаление такого аккаунта безопасно: " + lines);

    const site = await iam.findServiceAccount("oauth-1", "folder-1", "sa-1");
    const siteKeys = await iam.allKeys("oauth-1", site.id);
    const siteRoles = await iam.bindingsFor("oauth-1", "folder-1", site.id);
    const siteLines = iam.cardLines(site, { keys: siteKeys, roles: siteRoles }).join("\n");
    assert.ok(/storage\.editor/.test(siteLines), "в карточке нет ролей аккаунта");
    assert.ok(/перестанут работать ключи \(3\)/.test(siteLines), "карточка не считает, что сломается при удалении: " + siteLines);
    assert.ok(/доступ: бэкап бакета/.test(siteLines), "в карточке нет ключа доступа с описанием");
    assert.ok(/маска \*\*\*\*Ab12cd/.test(siteLines), "в карточке нет маски секрета вместо самого секрета");
  });

  console.log("\n[3] Инструмент агента ycIam: права и ответы");

  await test("ycIam: каталог ролей отвечает даже без подключённого облака", async () => {
    const noAuth = buildTools({ yandexOauthToken: "" });
    const map = await noAuth.tools.ycIam({ action: "rolemap" }, {});
    assert.ok(/storage\.editor/.test(map) && /lockbox\.payloadViewer/.test(map), "в каталоге ролей нет узких ролей: " + map);
    assert.ok(/viewer, editor, admin, auditor/.test(map), "не названы примитивные роли");
    assert.ok(/suggest/.test(map), "нет подсказки, где спросить «чего хватит»");
    const sug = await noAuth.tools.ycIam({ action: "suggest", task: "vm" }, {});
    assert.ok(/compute\.editor/.test(sug), "для машины предложена не та роль: " + sug);
    assert.ok(/grant/.test(sug), "не сказано, как выдать роль");
    const all = await noAuth.tools.ycIam({ action: "suggest" }, {});
    assert.ok(/site/.test(all) && /readonly/.test(all), "не перечислены доступные задачи: " + all);
    // А вот всё остальное без подключения — честный отказ.
    assert.ok(/не подключён/.test(await noAuth.tools.ycIam({ action: "list" }, {})), "нет ответа про подключение");
  });

  await test("ycIam: без каталога и с непонятным действием отвечает честно", async () => {
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycIam({ action: "list" }, {})), "нет ответа про каталог");
    const { tools } = buildTools();
    const bad = await tools.ycIam({ action: "выдай всё" }, {});
    assert.ok(/неизвестное действие/.test(bad) && /rolemap/.test(bad), "неизвестное действие не объяснено: " + bad);
  });

  await test("ycIam: запреты (аккаунты и ключи / роли / удаление) звучат ДО запроса", async () => {
    stub.reset();
    const { tools } = buildTools();
    const create = await tools.ycIam({ action: "create", name: "sa-x" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(create) && /создавать ресурсы/.test(create), "нет запрета на создание: " + create);
    const key = await tools.ycIam({ action: "newkey", account: "sa-site", kind: "access", confirm: true }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(key) && /создавать ресурсы/.test(key), "нет запрета на создание ключа: " + key);
    const grant = await tools.ycIam({ action: "grant", account: "sa-empty", role: "viewer" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(grant) && /роли/.test(grant), "нет запрета на выдачу роли: " + grant);
    const del = await tools.ycIam({ action: "delete", account: "sa-empty" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(del) && /удалять ресурсы/.test(del), "нет запрета на удаление: " + del);
    const delKey = await tools.ycIam({ action: "delkey", kind: "access", keyId: "ak-1" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(delKey), "нет запрета на удаление ключа: " + delKey);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "запрет не помешал запросу в облако");
    // Чтение при выключенных правах доступно — иначе агент не увидит даже списка.
    const list = await tools.ycIam({ action: "list" }, {});
    assert.ok(/Сервисные аккаунты/.test(list), "чтение запрещено вместе с изменениями: " + list);
  });

  await test("ycIam: list показывает роли, ключи и предупреждения словами", async () => {
    stub.reset();
    const { tools } = buildTools();
    const out = await tools.ycIam({ action: "list" }, {});
    assert.ok(/sa-site/.test(out) && /storage\.editor/.test(out), "нет аккаунта с ролями: " + out);
    assert.ok(/ключей: 3/.test(out), "не показано число ключей");
    assert.ok(/НЕТ — аккаунт не может ничего/.test(out), "аккаунт без ролей не назван: " + out);
    assert.ok(/Без ролей: sa-empty/.test(out), "нет строки про аккаунты без ролей");
    assert.ok(/создан .* НИ РАЗУ не использовался|не использовался 300 дн/.test(out), "мёртвый ключ не назван: " + out);
    assert.ok(/suggest|узкую роль/.test(out), "нет подсказки про узкую роль");

    const card = await tools.ycIam({ action: "card", account: "sa-site" }, {});
    assert.ok(/sa-site/.test(card) && /доступ: бэкап бакета/.test(card), "карточка аккаунта пуста: " + card);
    const keys = await tools.ycIam({ action: "keys", account: "sa-site" }, {});
    assert.ok(/Ключи аккаунта/.test(keys) && /id из списка/.test(keys), "список ключей не объясняет, что секрета тут нет: " + keys);
    assert.ok(!/SECRET-/.test(keys), "в списке ключей появился секрет");
  });

  await test("ycIam: выдача роли предупреждает про широкую роль, а suggest подсказывает узкую", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentUpdate: true });
    const wide = await tools.ycIam({ action: "grant", account: "sa-empty", role: "editor" }, {});
    assert.ok(/✅/.test(wide), "роль не выдана: " + wide);
    assert.ok(/ШИРОКАЯ/.test(wide), "выдача editor без предупреждения: " + wide);
    assert.ok(/storage\.editor/.test(wide), "не предложена узкая замена: " + wide);
    const narrow = await tools.ycIam({ action: "grant", account: "sa-empty", role: "compute.editor" }, {});
    assert.ok(/✅/.test(narrow) && /действует на ВЕСЬ каталог/.test(narrow), "про область действия роли не сказано: " + narrow);
    const again = await tools.ycIam({ action: "grant", account: "sa-empty", role: "compute.editor" }, {});
    assert.ok(/уже есть/.test(again), "повторная выдача не распознана: " + again);
    await tools.ycIam({ action: "revoke", account: "sa-empty", role: "compute.editor" }, {});
    // Последняя роль: после неё аккаунт не может НИЧЕГО, и это надо сказать прямо.
    const revoke = await tools.ycIam({ action: "revoke", account: "sa-empty", role: "editor" }, {});
    assert.ok(/НЕТ — аккаунт больше ничего не может/.test(revoke), "последняя снятая роль не названа опасной: " + revoke);
  });

  await test("ycIam: создание ключа требует согласия и отдаёт секрет ровно один раз", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true, ycAllowAgentDelete: true });
    const ask = await tools.ycIam({ action: "newkey", account: "sa-site", kind: "access" }, {});
    assert.ok(/ОДИН раз/.test(ask), "не сказано, что секрет показывается один раз: " + ask);
    assert.ok(/confirm: true/.test(ask), "не сказано, как подтвердить: " + ask);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "без согласия ключ всё-таки создан");

    const made = await tools.ycIam({ action: "newkey", account: "sa-site", kind: "access", description: "бэкап", confirm: true }, {});
    assert.ok(/✅/.test(made), "ключ не создан: " + made);
    assert.ok(/SECRET-ACCESS-/.test(made), "секрет не показан: " + made);
    assert.ok(/Lockbox|хранилищ/.test(made), "не сказано, куда положить секрет: " + made);
    const keyId = (/keyId: "([^"]+)"/.exec(made) || [])[1] || "";
    assert.ok(keyId, "в ответе нет id созданного ключа: " + made);

    const del = await tools.ycIam({ action: "delkey", kind: "access", keyId, account: "sa-site" }, {});
    assert.ok(/удалён/.test(del), "ключ не удалился по id из ответа: " + del);
  });

  await test("ycIam: удаление аккаунта называет цену ошибки, а неизвестный ключ — объясняет", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentDelete: true });
    const r = await tools.ycIam({ action: "delete", account: "sa-old" }, {});
    assert.ok(/🗑/.test(r) && /перестали работать/.test(r), "удаление не называет, что сломается: " + r);
    assert.ok(/необратимо/.test(r), "не сказано, что вернуть аккаунт нельзя: " + r);
    const noKey = await tools.ycIam({ action: "delkey", kind: "api" }, {});
    assert.ok(/keyId/.test(noKey), "удаление без id не объяснено: " + noKey);
    const wrongKind = await tools.ycIam({ action: "delkey", kind: "что-то", keyId: "ap-1" }, {});
    assert.ok(/Не понял вид ключа/.test(wrongKind), "неизвестный вид ключа не объяснён: " + wrongKind);
  });

  await test("ycIam: создание аккаунта через инструмент оставляет его без прав и советует узкую роль", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true });
    const made = await tools.ycIam({ action: "create", name: "sa-bot", description: "для бота" }, {});
    assert.ok(/✅/.test(made) && /sa-bot/.test(made), "аккаунт не создан: " + made);
    assert.ok(/без роли/i.test(made), "не сказано, что аккаунт без роли ничего не может");
    assert.ok(/grant/.test(made) && /suggest/.test(made), "не сказано, что делать дальше: " + made);
    assert.ok(stub.state.accounts.some((a) => a.name === "sa-bot"), "аккаунт не появился в каталоге");
    assert.ok(!stub.state.bindings.some((b) => b.subject.id === stub.state.accounts.find((a) => a.name === "sa-bot").id), "новому аккаунту выдали права сами");
  });

  console.log("\n[4] Проводка: канал, мост окна, схема и справочник");

  await test("ycIam: канал yc:iam есть в мосте, окно его видит, оболочка собирает модуль", () => {
    assert.ok(/ipcMain\.handle\("yc:iam"/.test(IPC_SRC), "нет канала yc:iam");
    assert.ok(/ycIam: \(args\) => ipcRenderer\.invoke\("yc:iam"/.test(PRELOAD_SRC), "окно не видит канал yc:iam");
    assert.ok(/const \{ createYcIam \} = require\("\.\/yc-iam\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль IAM");
    assert.ok(/const ycIam = createYcIam\(\{/.test(MAIN_SRC), "модуль IAM не собран в оболочке");
    // Имя в списке аргументов registerYcIpc, а не соседство строк.
    const reg = /registerYcIpc\(\{([\s\S]{0,400}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /\bycIam\b/.test(reg[1]), "канал IPC не получает модуль IAM");
    assert.ok(reg && /\bloadSettings\b/.test(reg[1]), "канал IPC не получает настройки");
    assert.ok(/handle\("yc:iam"[\s\S]{0,4000}?folderId: cfg\.folderId/.test(IPC_SRC), "канал не передаёт каталог в модуль");
    // Помощники облака передаются настоящие — иначе модуль молча ничего не сделает.
    for (const dep of ["fetchJson: yandexCloud._fetchJson", "endpoint: yandexCloud.endpoint", "getIamToken: yandexCloud.getIamToken", "waitOperation: yandexCloud.waitOperation"]) {
      assert.ok(MAIN_SRC.indexOf(dep) >= 0, "в сборку модуля не передан " + dep);
    }
    // Инструмент агента получает тот же модуль (иначе он скажет «не подключён»).
    assert.ok(/^  ycIam,$/m.test(MAIN_SRC), "модуль IAM не передан инструментам агента");
  });

  await test("ycIam: схема, группа «облако», промпт, права и справочник знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycIam"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 6000);
    for (const part of ["action", "account", "role", "task", "kind", "keyId", "confirm", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/РОВНО ОДИН РАЗ/i.test(schema), "схема не предупреждает, что секрет показывается один раз");
    assert.ok(/viewer, editor, admin, auditor/.test(schema), "схема не называет широкие роли");
    assert.ok(/создавать ресурсы/.test(schema) && /менять контейнеры/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");

    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 900);
    assert.ok(/ycIam/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycIam/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycIam \(IAM:/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycIam");

    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 400).includes('"ycIam"'), "нет назначения cloud.read для ycIam");

    assert.ok(/ycIam/.test(GUIDE_SRC), "в yc.md нет ycIam");
    assert.ok(/РОВНО ОДИН раз/i.test(GUIDE_SRC), "справочник не предупреждает, что секрет показывается один раз");
    assert.ok(/lockbox\.payloadViewer/.test(GUIDE_SRC), "справочник не называет роль на секреты");
    assert.ok(/примитивные/i.test(GUIDE_SRC), "справочник не объясняет, чем опасны широкие роли");
    assert.ok(/suggest/.test(GUIDE_SRC), "справочник не говорит про подбор роли по задаче");
  });

  await test("ycIam: набор стоит в цепочке npm test, а разведчик API — отдельной командой", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-iam.test.js") >= 0, "набора нет в цепочке npm test");
    assert.ok(PKG.scripts["recon:yc"], "нет команды разведки API");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

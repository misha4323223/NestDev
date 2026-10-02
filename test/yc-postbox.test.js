"use strict";

/* ── Адреса Cloud Postbox в окне и у агента ──────────────────────────────────
   Запуск: node test/yc-postbox.test.js   (входит в общий `npm test`)

   Зачем набор. Postbox на полке был только СЧЁТЧИКОМ адресов: ни создать адрес,
   ни посмотреть подпись DKIM с записями для DNS, ни удалить — всё жило в консоли
   облака. Заход 15 части 91 закрыл это в четырёх слоях.

   Главные тонкости, которые и стерегутся:
     • Postbox — SES-совместимый сервис: пользовательский OAuth-токен он НЕ
       принимает. Ключ сервисного аккаунта меняется на IAM-токен (JWT PS256,
       src/yc-sa.js), а тот уходит в заголовке X-YaCloud-SubjectToken;
     • адрес здесь — ДОМЕН, а не ящик: «mail@example.ru» — ошибка, а не адрес;
     • список отдаёт поля SES (EmailIdentities → IdentityName, VerificationStatus,
       SendingEnabled), а окну и агенту нужны имя и id: приведение — в
       src/yandex-cloud.js (normalizeItem);
     • значения DKIM (селекторы) есть, а ЦЕЛЕВОГО ХОСТА CNAME API не отдаёт:
       говорим об этом словами, а не выдумываем запись;
     • создание — СОЗДАНИЕ, подпись DKIM — ПРАВКА, удаление — УДАЛЕНИЕ: у
       каждого своё разрешение агента, а окно спрашивает человека на удаление и
       на выключение подписи.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE уводит туда и сервисы, и обмен токена сервисного аккаунта). */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

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
const ycPostbox = require(path.join(ROOT, "src", "yc-postbox.js"));
const ycSa = require(path.join(ROOT, "src", "yc-sa.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));
const { registerYcIpc } = require(path.join(ROOT, "src", "yc-ipc.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const MAIN_SRC = read("src", "main.js");
const ACTIONS_SRC = read("src", "renderer", "yc-actions.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const SECRETS_SRC = read("src", "secrets.js");
const SETTINGS_STORE_SRC = read("src", "settings-store.js");
const PANEL_SRC = read("src", "renderer", "settings-panel.js");
const HTML_SRC = read("src", "renderer", "index.html");
const SMOKE_SRC = require(path.join(__dirname, "smoke", "source.js"));
const PKG = JSON.parse(read("package.json"));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "yc-postbox-work-"));

// Ключ сервисного аккаунта делаем НАСТОЯЩИЙ: подпись PS256 проверяется тем же
// node:crypto, что и в модуле, — значит, тест стережёт и алгоритм, и кодировку.
const RSA = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const SA_KEY_OBJ = { id: "aje1keyid00000000000", service_account_id: "aje1serviceaccount00", private_key: RSA.privateKey, key_algorithm: "RSA_2048" };
const SA_KEY_JSON = JSON.stringify(SA_KEY_OBJ);

// ── Подменённое облако: Postbox (SES v2) + обмен токена сервисного аккаунта ──
function startStub() {
  const calls = [];
  let identities = [];
  const reset = () => {
    identities = [
      {
        IdentityType: "DOMAIN",
        IdentityName: "mail.example.ru",
        VerificationStatus: "SUCCESS",
        SendingEnabled: true,
        FeedbackForwardingStatus: false,
        DkimAttributes: {
          SigningEnabled: true,
          Status: "SUCCESS",
          Tokens: ["sel1", "sel2"],
          SigningAttributesOrigin: "AWS_SES",
          CurrentSigningKeyLength: "RSA_2048_BIT",
        },
        Tags: [{ Key: "env", Value: "prod" }],
      },
      { IdentityType: "DOMAIN", IdentityName: "shop.example.ru", VerificationStatus: "PENDING", SendingEnabled: false, FeedbackForwardingStatus: false, DkimAttributes: { SigningEnabled: true, Status: "PENDING", Tokens: ["only"], SigningAttributesOrigin: "AWS_SES" } },
    ];
  };
  reset();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const raw = req.url || "";
      const p = raw.split("?")[0];
      calls.push({ method: req.method, url: raw, body: body, headers: req.headers });
      const json = (o, s) => {
        res.writeHead(s || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      // Обмен ключа сервисного аккаунта на IAM-токен.
      if (p === "/iam/v1/tokens") return json({ iamToken: "sa-iam-1", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      let m;
      if (p === "/v2/email/identities") {
        if (req.method === "POST") {
          let b = {};
          try { b = JSON.parse(body || "{}"); } catch {}
          const made = {
            IdentityType: "DOMAIN",
            IdentityName: b.EmailIdentity,
            VerificationStatus: "PENDING",
            SendingEnabled: false,
            FeedbackForwardingStatus: false,
            DkimAttributes: { SigningEnabled: true, Status: "PENDING", Tokens: ["newsel"], SigningAttributesOrigin: "AWS_SES" },
          };
          identities = identities.concat([made]);
          return json(made);
        }
        return json({ EmailIdentities: identities.map((i) => ({ IdentityType: i.IdentityType, IdentityName: i.IdentityName, SendingEnabled: i.SendingEnabled, VerificationStatus: i.VerificationStatus })), NextToken: "" });
      }
      if ((m = /^\/v2\/email\/identities\/([^/]+)\/dkim$/.exec(p))) {
        const addr = decodeURIComponent(m[1]);
        let b = {};
        try { b = JSON.parse(body || "{}"); } catch {}
        const it = identities.find((i) => i.IdentityName === addr);
        if (!it) return json({ Code: "NotFoundException", message: "no" }, 404);
        it.DkimAttributes = Object.assign({}, it.DkimAttributes, { SigningEnabled: b.SigningEnabled === true });
        return json({});
      }
      if ((m = /^\/v2\/email\/identities\/([^/]+)$/.exec(p))) {
        const addr = decodeURIComponent(m[1]);
        const it = identities.find((i) => i.IdentityName === addr);
        if (req.method === "DELETE") {
          if (!it) return json({ Code: "NotFoundException", message: "no" }, 404);
          identities = identities.filter((i) => i.IdentityName !== addr);
          return json({});
        }
        return it ? json(it) : json({ Code: "NotFoundException", message: "no" }, 404);
      }
      return json({});
    });
  });
  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () =>
      r({ server: server, calls: calls, reset: reset, identities: () => identities, base: "http://127.0.0.1:" + server.address().port })
    );
  });
}

// ── Инструменты агента на подменённом облаке ────────────────────────────────
function buildTool(settingsOver) {
  const settings = Object.assign(
    { yandexOauthToken: "oauth-1", ycFolderId: "f1", ycFolderName: "prod", ycAllowAgentCreate: false, ycAllowAgentDelete: false, ycAllowAgentUpdate: false },
    settingsOver || {}
  );
  const tools = createCloudTools({
    ycDb: {},
    path: path,
    fs: fs,
    yandexCloud: yandex,
    ycJsonArg: (v) => (v && typeof v === "object" ? v : undefined),
    readYcLogsText: async () => "",
    resolvePath: (p) => (path.isAbsolute(String(p)) ? String(p) : path.join(work, String(p))),
    agentWorkDir: () => work,
    ycConfig: (s) => {
      const st = s || settings;
      return {
        oauth: String(st.yandexOauthToken || ""),
        saKey: String(st.yandexServiceAccount || ""),
        folderId: st.ycFolderId || "",
        folderName: st.ycFolderName || "",
        allowCreate: !!st.ycAllowAgentCreate,
        allowDelete: !!st.ycAllowAgentDelete,
        allowUpdate: !!st.ycAllowAgentUpdate,
      };
    },
    loadSettings: () => settings,
  });
  return { tools: tools, settings: settings };
}

let stub = null;

(async function main() {
  stub = await startStub();

  console.log("\n[1] Модули yc-postbox.js и yc-sa.js: проверки, слова и подпись");
  const b64 = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

  await test("yc-postbox: адрес — это ДОМЕН, а не ящик", () => {
    assert.strictEqual(ycPostbox.checkAddress(" Mail.Example.ru "), "mail.example.ru", "адрес не приведён к нижнему регистру");
    assert.strictEqual(ycPostbox.checkAddress("example.ru"), "example.ru");
    assert.throws(() => ycPostbox.checkAddress("mail@example.ru"), /ящик/, "ящик принят за адрес");
    assert.throws(() => ycPostbox.checkAddress(""), /Укажи адрес/, "пустой адрес принят");
    assert.throws(() => ycPostbox.checkAddress("-bad.example.ru"), /не подойдёт/, "метка с дефисом впереди принята");
    assert.throws(() => ycPostbox.checkAddress("example"), /не подойдёт/, "имя без точки принято за домен");
  });

  await test("yc-postbox: статусы, строка адреса и поиск", () => {
    assert.strictEqual(ycPostbox.statusHuman("SUCCESS"), "подтверждён");
    assert.strictEqual(ycPostbox.statusHuman("PENDING"), "проверяется");
    assert.strictEqual(ycPostbox.dkimHuman("PENDING"), "ищется в DNS");
    const line = ycPostbox.identityLine({ IdentityName: "mail.example.ru", VerificationStatus: "SUCCESS", SendingEnabled: true, DkimAttributes: { SigningEnabled: true, Status: "SUCCESS" } });
    assert.ok(/mail\.example\.ru/.test(line) && /подтверждён/.test(line) && /письма разрешены/.test(line) && /DKIM: включена/.test(line), "строка адреса потеряла смысл: " + line);
    const list = [{ IdentityName: "a.ru" }, { IdentityName: "b.ru" }];
    assert.strictEqual(ycPostbox.matchIdentity(list, "b.ru").IdentityName, "b.ru", "поиск по имени не сработал");
    assert.strictEqual(ycPostbox.matchIdentity(list, "нет"), null, "чужой адрес нашёлся");
    assert.strictEqual(ycPostbox.matchIdentity([list[0]], "").IdentityName, "a.ru", "единственный адрес не выбран без имени");
  });

  await test("yc-postbox: карточка адреса и записи DNS (без выдуманного хоста)", () => {
    const full = {
      IdentityType: "DOMAIN",
      IdentityName: "mail.example.ru",
      VerificationStatus: "PENDING",
      SendingEnabled: false,
      FeedbackForwardingStatus: true,
      DkimAttributes: { SigningEnabled: true, Status: "PENDING", Tokens: ["sel1", "sel2"], SigningAttributesOrigin: "AWS_SES", CurrentSigningKeyLength: "RSA_2048_BIT" },
      Tags: [{ Key: "env", Value: "prod" }],
    };
    const lines = ycPostbox.cardLines(full).join("\n");
    assert.ok(/Проверка владения доменом: проверяется/.test(lines), "статус проверки потерялся: " + lines);
    assert.ok(/Письма: пока нельзя/.test(lines), "состояние отправки потерялось");
    assert.ok(/Селекторы: sel1, sel2/.test(lines), "селекторы DKIM потерялись");
    assert.ok(/CNAME sel1\._domainkey\.mail\.example\.ru/.test(lines), "имя CNAME не выведено из селектора");
    assert.ok(/облако показывает/.test(lines), "не сказано, что хост записи отдаёт консоль");
    assert.ok(!/postbox\.yandexcloud\.net/.test(lines), "тест поймал выдуманный целевой хост CNAME");
    assert.ok(/Метки: env=prod/.test(lines), "метки потерялись");
  });

  await test("yc-sa: ключ сервисного аккаунта разбирается, мусор — нет", () => {
    const key = ycSa.parseServiceAccount(SA_KEY_JSON);
    assert.ok(key && key.serviceAccountId === SA_KEY_OBJ.service_account_id, "ключ не разобран");
    assert.strictEqual(key.keyId, SA_KEY_OBJ.id);
    assert.strictEqual(ycSa.parseServiceAccount(""), null, "пустая строка принята");
    assert.strictEqual(ycSa.parseServiceAccount("не json"), null, "мусор принят");
    assert.strictEqual(ycSa.parseServiceAccount({ service_account_id: "нет", private_key: RSA.privateKey }), null, "чужой id аккаунта принят");
    assert.strictEqual(ycSa.parseServiceAccount({ service_account_id: SA_KEY_OBJ.service_account_id, private_key: "нет ключа" }), null, "не-PEM ключ принят");
  });

  await test("yc-sa: JWT подписан PS256 и несёт iss/aud сервисного аккаунта", () => {
    const key = ycSa.parseServiceAccount(SA_KEY_JSON);
    const jwt = ycSa.buildJwt(key, 1770000000000);
    const parts = jwt.split(".");
    assert.strictEqual(parts.length, 3, "JWT не из трёх частей");
    const head = JSON.parse(b64(parts[0]).toString("utf8"));
    const claims = JSON.parse(b64(parts[1]).toString("utf8"));
    assert.strictEqual(head.alg, "PS256", "алгоритм не PS256: " + head.alg);
    assert.strictEqual(claims.iss, SA_KEY_OBJ.service_account_id);
    assert.strictEqual(claims.aud, ycSa.IAM_TOKEN_URL);
    assert.ok(claims.exp - claims.iat <= 3600, "срок жизни JWT больше часа");
    const ok = crypto.verify(
      "sha256",
      Buffer.from(parts[0] + "." + parts[1]),
      { key: RSA.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: ycSa.SALT_LEN },
      b64(parts[2])
    );
    assert.ok(ok, "подпись JWT не проверяется открытым ключом");
  });

  await test("yc-sa: JWT меняется на IAM-токен, токен кэшируется, отказ объясняется", async () => {
    const key = ycSa.parseServiceAccount(SA_KEY_JSON);
    ycSa.clearTokenCache();
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push({ url: String(url), body: JSON.parse((opts && opts.body) || "{}") });
      return { ok: true, status: 200, text: async () => JSON.stringify({ iamToken: "tok-1", expiresAt: new Date(Date.now() + 3600e3).toISOString() }) };
    };
    const t1 = await ycSa.getIamToken(key, { fetchImpl: fetchImpl });
    assert.strictEqual(t1, "tok-1");
    assert.strictEqual(seen.length, 1, "обмен токена не ушёл");
    assert.strictEqual(seen[0].url, ycSa.tokenUrl(), "обмен ушёл не на точку токена");
    const parts = String(seen[0].body.jwt || "").split(".");
    assert.strictEqual(parts.length, 3, "в теле не JWT");
    assert.strictEqual(JSON.parse(b64(parts[1]).toString("utf8")).iss, SA_KEY_OBJ.service_account_id, "iss не тот");
    const t2 = await ycSa.getIamToken(key, { fetchImpl: () => { throw new Error("сеть не должна зваться"); } });
    assert.strictEqual(t2, "tok-1", "токен не закэширован");
    ycSa.clearTokenCache();
    const bad = await ycSa
      .getIamToken(key, { fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: "Forbidden" }) }) })
      .then(() => null, (e) => e);
    assert.ok(bad && /не выдал IAM-токен/.test(bad.message) && /Forbidden/.test(bad.message), "отказ не объяснён: " + (bad && bad.message));
  });

  await test("yc-sa: адрес обмена уважает стенд (AI_AGENT_YC_BASE)", () => {
    process.env.AI_AGENT_YC_BASE = stub.base;
    assert.strictEqual(ycSa.tokenUrl(), stub.base + "/iam/v1/tokens", "стенд не подхватился: " + ycSa.tokenUrl());
    delete process.env.AI_AGENT_YC_BASE;
    assert.strictEqual(ycSa.tokenUrl(), ycSa.IAM_TOKEN_URL, "без стенда адрес не вернулся");
  });
  console.log("\n[2] Инструмент агента ycPostbox: разрешения, ключ и облако");

  process.env.AI_AGENT_YC_BASE = stub.base;

  await test("ycPostbox: без ключа сервисного аккаунта объясняет, что вставить", async () => {
    stub.reset();
    const { tools } = buildTool({});
    const noKey = await tools.ycPostbox({ action: "list" }, {});
    assert.ok(/СЕРВИСНЫМ аккаунтом/.test(noKey) && /postbox\.viewer/.test(noKey), "нет объяснения про сервисный аккаунт: " + noKey.slice(0, 220));
    const bad = await tools.ycPostbox({ action: "стереть" }, {});
    assert.ok(/неизвестное действие ycPostbox/.test(bad) && /dkimoff/.test(bad), "чужое действие не объяснено: " + bad.slice(0, 160));
  });

  await test("ycPostbox: create, подпись и удаление заперты разрешениями ДО сети", async () => {
    stub.reset();
    const before = stub.calls.length;
    const { tools } = buildTool({});
    const cr = await tools.ycPostbox({ action: "create", name: "win.example.ru" }, {});
    assert.ok(/⛔/.test(cr) && /создавать/.test(cr), "create не заперт: " + cr.slice(0, 140));
    const on = await tools.ycPostbox({ action: "dkimon", address: "mail.example.ru" }, {});
    assert.ok(/⛔/.test(on) && /менять/.test(on), "dkimon не заперт: " + on.slice(0, 140));
    const del = await tools.ycPostbox({ action: "delete", address: "mail.example.ru" }, {});
    assert.ok(/⛔/.test(del) && /удалять/.test(del), "delete не заперт: " + del.slice(0, 140));
    assert.strictEqual(stub.calls.length, before, "отказ ушёл в сеть: " + (stub.calls[before] || {}).url);
  });

  await test("ycPostbox: list, card, dkim и create — по-настоящему", async () => {
    stub.reset();
    ycSa.clearTokenCache();
    const { tools } = buildTool({ yandexServiceAccount: SA_KEY_JSON, ycAllowAgentCreate: true });
    const list = await tools.ycPostbox({ action: "list" }, {});
    assert.ok(/Адреса Cloud Postbox \(2\)/.test(list) && /mail\.example\.ru/.test(list) && /подтверждён/.test(list), "список не показан: " + list.slice(0, 240));
    const card = await tools.ycPostbox({ action: "card", address: "mail.example.ru" }, {});
    assert.ok(/Проверка владения доменом: подтверждён/.test(card) && /Селекторы: sel1, sel2/.test(card) && /CNAME sel1\._domainkey\.mail\.example\.ru/.test(card), "карточка не показана: " + card.slice(0, 240));
    const dkim = await tools.ycPostbox({ action: "dkim", address: "mail.example.ru" }, {});
    assert.ok(/Подпись DKIM адреса «mail\.example\.ru»: включена/.test(dkim) && /CNAME sel1\._domainkey\.mail\.example\.ru/.test(dkim), "подпись не показана: " + dkim.slice(0, 240));
    const made = await tools.ycPostbox({ action: "create", name: "win.example.ru" }, {});
    assert.ok(/✅ Адрес Postbox создан/.test(made) && /win\.example\.ru/.test(made), "адрес не создан: " + made.slice(0, 240));
    const noAddr = await tools.ycPostbox({ action: "card", address: "нет.example.ru" }, {});
    assert.ok(/Не нашёл адрес/.test(noAddr), "чужой адрес не отвергнут: " + noAddr.slice(0, 160));
  });

  await test("ycPostbox: dkimoff и delete с разрешениями меняют облако", async () => {
    stub.reset();
    ycSa.clearTokenCache();
    const { tools } = buildTool({ yandexServiceAccount: SA_KEY_JSON, ycAllowAgentUpdate: true, ycAllowAgentDelete: true });
    const off = await tools.ycPostbox({ action: "dkimoff", address: "mail.example.ru" }, {});
    assert.ok(/🔒 Подпись DKIM выключена: mail\.example\.ru/.test(off) && /спам/.test(off), "подпись не выключена: " + off.slice(0, 240));
    assert.strictEqual(stub.identities().find((i) => i.IdentityName === "mail.example.ru").DkimAttributes.SigningEnabled, false, "в облаке подпись осталась включена");
    const del = await tools.ycPostbox({ action: "delete", address: "shop.example.ru" }, {});
    assert.ok(/🗑 Адрес Postbox удалён/.test(del) && /Вернуть адрес/.test(del), "адрес не удалён: " + del.slice(0, 240));
    assert.ok(!stub.identities().some((i) => i.IdentityName === "shop.example.ru"), "адрес остался после удаления");
  });

  console.log("\n[3] Канал окна yc:postbox: то же облако, что и у агента");

  function makeChannel(settingsOver) {
    const handlers = new Map();
    const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
    const settings = Object.assign(
      { workingDir: work, yandexOauthToken: "oauth-1", ycCloudId: "cloud-1", ycFolderId: "f1", ycFolderName: "prod", yandexServiceAccount: SA_KEY_JSON },
      settingsOver || {}
    );
    const svc = createYcService({ app: { getPath: () => work }, path: path, net: {}, secrets: {}, yandexCloud: yandex, ycCli: {}, ycLogs: {}, ycEnsurePath: () => {}, loadSettings: () => settings });
    registerYcIpc({ ipcMain: ipcMain, yandexCloud: yandex, ycPostbox: ycPostbox, ycSa: ycSa, loadSettings: () => settings, saveSettings: () => {}, svc: svc });
    assert.ok(handlers.has("yc:postbox"), "канал yc:postbox не зарегистрирован");
    return handlers;
  }

  await test("yc:postbox: список, карточка и записи DNS", async () => {
    stub.reset();
    ycSa.clearTokenCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:postbox")(null, args);

    const list = await call({ op: "list" });
    assert.ok(list.ok && list.count === 2 && /mail\.example\.ru/.test(list.lines.join(" ")) && /подтверждён/.test(list.lines.join(" ")), "список не показан: " + JSON.stringify(list).slice(0, 240));

    const card = await call({ op: "card", address: "mail.example.ru" });
    assert.ok(card.ok && /Проверка владения доменом: подтверждён/.test(card.lines.join("\n")) && /CNAME sel1\._domainkey\.mail\.example\.ru/.test(card.lines.join("\n")), "карточка без записей: " + JSON.stringify(card).slice(0, 240));

    const dkim = await call({ op: "dkim", address: "mail.example.ru" });
    assert.ok(dkim.ok && dkim.dkim && dkim.dkim.enabled === true && /CNAME sel2\._domainkey\.mail\.example\.ru/.test(dkim.lines.join("\n")), "подпись без записей: " + JSON.stringify(dkim).slice(0, 240));

    const bad = await call({ op: "стереть" });
    assert.ok(bad.ok === false && /Доступно: list, card, create, dkim, dkimon, dkimoff, delete\./.test(bad.error), "чужое действие не назвало список: " + bad.error);

    const addrBad = await call({ op: "create", name: "mail@example.ru" });
    assert.ok(addrBad.ok === false && /ящик/.test(addrBad.error), "ящик принят за адрес: " + addrBad.error);
  });

  await test("yc:postbox: создание и переключатель подписи — по-настоящему", async () => {
    stub.reset();
    ycSa.clearTokenCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:postbox")(null, args);

    const made = await call({ op: "create", name: "win.example.ru" });
    assert.ok(made.ok && made.changed && /✅ Адрес создан: win\.example\.ru/.test(made.lines.join("\n")) && /подтвердить владение доменом/.test(made.lines.join("\n")), "адрес не создан: " + JSON.stringify(made).slice(0, 240));

    const on = await call({ op: "dkimon", address: "shop.example.ru" });
    assert.ok(on.ok && on.changed && /✍ Подпись DKIM включена/.test(on.lines.join("\n")), "подпись не включена: " + JSON.stringify(on).slice(0, 240));

    const offNo = await call({ op: "dkimoff", address: "shop.example.ru" });
    assert.ok(offNo.ok === false && offNo.needsConfirm === true, "подпись выключена без согласия");
    const off = await call({ op: "dkimoff", address: "shop.example.ru", confirmed: true });
    assert.ok(off.ok && off.changed && /🔒 Подпись DKIM выключена/.test(off.lines.join("\n")), "подпись не выключена: " + JSON.stringify(off).slice(0, 240));
    assert.strictEqual(stub.identities().find((i) => i.IdentityName === "shop.example.ru").DkimAttributes.SigningEnabled, false, "в облаке подпись осталась включена");
  });

  await test("yc:postbox: удаление ДВУХШАГОВОЕ и честные отказы", async () => {
    stub.reset();
    ycSa.clearTokenCache();
    const h = makeChannel();
    const call = (args) => h.get("yc:postbox")(null, args);

    const delNo = await call({ op: "delete", address: "shop.example.ru" });
    assert.ok(delNo.ok === false && delNo.needsConfirm === true, "адрес удалён без согласия");
    assert.ok(stub.identities().some((i) => i.IdentityName === "shop.example.ru"), "адрес исчез без согласия");
    const del = await call({ op: "delete", address: "shop.example.ru", confirmed: true });
    assert.ok(del.ok && del.deleted && /🗑 Адрес удалён/.test(del.lines.join("\n")), "адрес не удалён: " + JSON.stringify(del).slice(0, 240));
    assert.ok(!stub.identities().some((i) => i.IdentityName === "shop.example.ru"), "адрес остался после удаления");

    const noAddr = await call({ op: "card", address: "нет.example.ru" });
    assert.ok(noAddr.ok === false && /Не нашёл адрес/.test(noAddr.error), "чужой адрес не отвергнут: " + noAddr.error);

    const noAuth = await makeChannel({ yandexOauthToken: "" }).get("yc:postbox")(null, { op: "list" });
    assert.ok(noAuth.ok === false && /не подключён/.test(noAuth.error), "нет ответа про подключение: " + noAuth.error);
    const noKey = await makeChannel({ yandexServiceAccount: "" }).get("yc:postbox")(null, { op: "list" });
    assert.ok(noKey.ok === false && /СЕРВИСНЫМ аккаунтом/.test(noKey.error) && /postbox\.viewer/.test(noKey.error), "нет ответа про ключ: " + noKey.error);
  });

  delete process.env.AI_AGENT_YC_BASE;

  console.log("\n[4] Согласованность: канал, мост, окно, схема, справочник и цепочка");

  await test("канал yc:postbox, мост окна и оболочка на месте", () => {
    assert.ok(/ipcMain\.handle\("yc:postbox"/.test(IPC_SRC), "канала yc:postbox нет в yc-ipc.js");
    const found = [...IPC_SRC.matchAll(/ipcMain\.handle\("(yc:[^"]+)"/g)].map((m) => m[1]);
    assert.strictEqual(found.length, 41, "каналов в мосте должно быть 41: " + found.length);
    assert.ok(/ycPostbox: \(args\) => ipcRenderer\.invoke\("yc:postbox"/.test(PRELOAD_SRC), "нет моста ycPostbox");
    assert.ok(/require\("\.\/yc-postbox\.js"\)/.test(MAIN_SRC) && /\bycPostbox\b/.test(MAIN_SRC), "оболочка не подключает модуль почты");
    assert.ok(/require\("\.\/yc-sa\.js"\)/.test(MAIN_SRC) && /\bycSa\b/.test(MAIN_SRC), "оболочка не подключает модуль сервисного аккаунта");
    assert.ok(/postbox: "ycPostbox"/.test(ACTIONS_SRC), "семейство postbox не знает свой канал");
    assert.ok(/postbox: \["list", "card", "create", "dkim", "dkimon", "dkimoff", "delete"\]/.test(ACTIONS_SRC), "OPS семейства postbox не совпадают");
    assert.ok(/postbox: postboxActions\(\)/.test(ACTIONS_SRC), "семейство postbox не собрано");
  });

  await test("ключ сервисного аккаунта, схема, справочник и цепочка npm test про Postbox", () => {
    const TOOLS_SRC = read("src", "agent-tools-cloud.js");
    assert.ok(/Доступно: list, card, create, dkim, dkimon, dkimoff, delete\./.test(TOOLS_SRC), "ycPostbox не назвал действия");
    assert.ok(/name: "ycPostbox"/.test(SCHEMAS_SRC) && /list \| card \| create \| dkim \| dkimon \| dkimoff \| delete/.test(SCHEMAS_SRC), "схема ycPostbox не обновлена");
    assert.ok(/ycPostbox \{ action/.test(GUIDE_SRC), "справочник yc.md не знает про Postbox");
    assert.ok(/s-yc-sa-key/.test(HTML_SRC), "в окне настроек нет поля ключа сервисного аккаунта");
    assert.ok(/yandexServiceAccount/.test(SECRETS_SRC), "ключ сервисного аккаунта не помечен секретом");
    assert.ok(/yandexServiceAccount: ""/.test(SETTINGS_STORE_SRC), "в умолчаниях нет ключа сервисного аккаунта");
    assert.ok(/s-yc-sa-key/.test(PANEL_SRC), "окно настроек не читает поле ключа");
    assert.ok(/каналов в мосте должно быть 41/.test(SMOKE_SRC), "сторож каналов не пересчитан");
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-postbox.test.js") >= 0, "набора нет в цепочке npm test");
    assert.ok(/src\/yc-postbox\.js/.test(read("docs", "ARCHITECTURE.md")) && /src\/yc-sa\.js/.test(read("docs", "ARCHITECTURE.md")), "модулей нет в карте ARCHITECTURE.md");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  stub.server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Стенд упал: " + ((e && e.stack) || e));
  process.exit(1);
});

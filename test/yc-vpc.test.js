"use strict";

/* ── Сеть VPC: подсети, группы безопасности, статические адреса ──────────────
   Запуск: node test/yc-vpc.test.js   (входит в общий `npm test`)

   Зачем набор. Сеть в каталоге создавать было чем (ycCreate service vpc), а всё,
   ради чего сеть существует, — нечем: подсеть, группа безопасности и статический
   адрес делались только в консоли облака. Без подсети не поднимается машина, без
   группы безопасности она открыта всему интернету, без статического адреса её
   публичный IP меняется после перезагрузки.

   Что проверяется и почему именно это:

     • форма правила: перевод «вход/выход» в ingress/egress, порт из числа,
       строки и диапазона, разделение адресов на IPv4 и IPv6, ОТСУТСТВИЕ портов
       у icmp/any (сервис на них отказывает) и запрет правила входа без источника —
       иначе «правило входа отовсюду» появлялось бы по умолчанию;
     • правка группы: API принимает СПИСОК ПРАВИЛ ЦЕЛИКОМ, поэтому проверяем, что
       предопределённые правила группы не теряются, поле id правила не уходит
       обратно (подменённый сервис на это отвечает отказом, как настоящий),
       удаление несуществующего правила ловится ДО записи, а дубль не добавляется;
     • результат, а не факт отправки: после удаления объект перечитывается, после
       добавления правила группа перечитывается и правило обязано быть на месте;
     • подсказка свободного диапазона — чтобы агент не занял уже занятое;
     • инструмент агента ycVpc: права (создание / правка правил / удаление)
       проверяются ДО запроса, ответы человеческие, «простаивающий адрес» и
       «0.0.0.0/0» проговариваются прямо;
     • проводка: канал yc:vpc, мост окна, схема, группа «облако» в ядре, промпт,
       политика прав, справочник агента и цепочка npm test.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а инструмент агента получает НАСТОЯЩИЙ модуль сети. */

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
const { createYcVpc, normalizeRule, ruleKey, ruleHuman, suggestCidr, parsePorts } = require(path.join(ROOT, "src", "yc-vpc.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const MAIN_SRC = read("src", "main.js");
const TOOLS_SRC = read("src", "agent-tools-cloud.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённый Yandex Cloud VPC ────────────────────────────────────────────
// Настоящая машина состояний: создание и удаление меняют то, что отдаёт чтение,
// поэтому проверяется не форма запроса, а то, что после вызова в каталоге
// действительно стало иначе.
function initialState() {
  return {
    networks: [{ id: "net-1", name: "my-net", defaultSecurityGroupId: "sg-default" }],
    subnets: [
      { id: "sub-1", name: "app-subnet-a", networkId: "net-1", zoneId: "ru-central1-a", v4CidrBlocks: ["10.10.0.0/24"] },
      { id: "sub-2", name: "app-subnet-b", networkId: "net-1", zoneId: "ru-central1-b", v4CidrBlocks: ["10.11.0.0/24"] },
    ],
    groups: [
      {
        id: "sg-1",
        name: "app-sg",
        networkId: "net-1",
        ruleSpecs: [
          // Предопределённое правило группы: его нельзя потерять при правке, а id
          // правил сервис считает сам — пришедший id это ошибка.
          { id: "rule-def-1", direction: "egress", protocolName: "any", predefinedTarget: "all", description: "по умолчанию" },
          { id: "rule-ssh", direction: "ingress", protocolName: "tcp", portRange: { fromPort: 22, toPort: 22 }, cidrBlocks: { v4CidrBlocks: ["203.0.113.10/32"], v6CidrBlocks: [] } },
        ],
      },
    ],
    addresses: [
      { id: "ip-1", name: "web-ip", reserved: true, used: true, externalIpv4Address: { address: "203.0.113.10", zoneId: "ru-central1-a" } },
      { id: "ip-2", name: "idle-ip", reserved: true, used: false, externalIpv4Address: { address: "203.0.113.99", zoneId: "ru-central1-a" } },
    ],
  };
}

function startVpcStub() {
  const calls = [];
  const state = initialState();
  const quiet = { putNoop: false, deleteNoop: false };
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

      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }

      // Ожидание операции: подтверждаем сразу и отдаём id созданного объекта.
      if (url.indexOf("/operations/") >= 0) {
        const id = url.slice(url.indexOf("/operations/") + "/operations/".length);
        return json(res, 200, { id, done: true, response: ops.get(id) || {} });
      }

      const op = (createdId) => {
        const id = "op-" + ++seq;
        if (createdId) ops.set(id, { id: createdId });
        return { id, done: false };
      };

      if (url.indexOf("/vpc/v1/networks") >= 0) return json(res, 200, { networks: plain(state.networks) });

      if (url.indexOf("/vpc/v1/subnets") >= 0) {
        if (method === "GET" && url.indexOf("folderId=") >= 0) return json(res, 200, { subnets: plain(state.subnets) });
        if (method === "POST") {
          const b = JSON.parse(body || "{}");
          if (!b.networkId || !b.zoneId || !b.v4CidrBlocks || !b.v4CidrBlocks.length) {
            return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: подсеть без сети, зоны или диапазона" });
          }
          if (state.subnets.some((s) => (s.v4CidrBlocks || []).some((c) => b.v4CidrBlocks.indexOf(c) >= 0))) {
            return json(res, 400, { code: 6, message: "CIDR intersects with existing subnet" });
          }
          const id = "sub-" + ++seq;
          state.subnets.push({
            id,
            name: b.name,
            networkId: b.networkId,
            zoneId: b.zoneId,
            v4CidrBlocks: b.v4CidrBlocks,
            description: b.description || "",
            routeTableId: "",
          });
          return json(res, 200, op(id));
        }
        const id = url.split("/vpc/v1/subnets/")[1].split("?")[0];
        if (method === "GET") {
          const s = state.subnets.find((x) => x.id === id);
          return s ? json(res, 200, plain(s)) : json(res, 404, { code: 5, message: "Subnet not found" });
        }
        if (method === "DELETE") {
          // quiet.deleteNoop — облако делает ВИД, что удалило (для проверки
          // «результат, а не факт отправки»).
          if (!quiet.deleteNoop) state.subnets = state.subnets.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
      }

      if (url.indexOf("/vpc/v1/securityGroups") >= 0) {
        if (method === "GET" && url.indexOf("folderId=") >= 0) return json(res, 200, { securityGroups: plain(state.groups) });
        if (method === "POST") {
          const b = JSON.parse(body || "{}");
          const id = "sg-" + ++seq;
          state.groups.push({ id, name: b.name, networkId: b.networkId, description: b.description || "", ruleSpecs: plain(b.ruleSpecs || []) });
          return json(res, 200, op(id));
        }
        const id = url.split("/vpc/v1/securityGroups/")[1].split("?")[0];
        if (method === "GET") {
          const g = state.groups.find((x) => x.id === id);
          return g ? json(res, 200, plain(g)) : json(res, 404, { code: 5, message: "Security group not found" });
        }
        if (method === "PUT") {
          const b = JSON.parse(body || "{}");
          if (String(b.updateMask || "") !== "rule_specs") return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: updateMask" });
          for (const r of b.ruleSpecs || []) {
            if (r && r.id) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: field id is output only" });
          }
          const g = state.groups.find((x) => x.id === (b.securityGroupId || id));
          if (!g) return json(res, 404, { code: 5, message: "Security group not found" });
          // quiet.putNoop — запись «прошла», а правила не изменились.
          if (!quiet.putNoop) {
            let n = 0;
            g.ruleSpecs = (b.ruleSpecs || []).map((r) => (r.predefinedTarget ? plain(r) : Object.assign({ id: "rule-" + ++n + "-" + ++seq }, plain(r))));
          }
          return json(res, 200, op());
        }
        if (method === "DELETE") {
          state.groups = state.groups.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
      }

      if (url.indexOf("/vpc/v1/addresses") >= 0) {
        if (method === "GET" && url.indexOf("folderId=") >= 0) return json(res, 200, { addresses: plain(state.addresses) });
        if (method === "POST") {
          const b = JSON.parse(body || "{}");
          const zone = b.externalIpv4Address && b.externalIpv4Address.zoneId;
          if (!zone) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: externalIpv4Address.zoneId is required" });
          const id = "ip-" + ++seq;
          state.addresses.push({
            id,
            name: b.name,
            reserved: true,
            used: false,
            deletionProtection: !!b.deletionProtection,
            externalIpv4Address: { address: b.externalIpv4Address.address || "198.51.100." + (state.addresses.length + 7), zoneId: zone },
          });
          return json(res, 200, op(id));
        }
        const id = url.split("/vpc/v1/addresses/")[1].split("?")[0];
        if (method === "GET") {
          const a = state.addresses.find((x) => x.id === id);
          return a ? json(res, 200, plain(a)) : json(res, 404, { code: 5, message: "Address not found" });
        }
        if (method === "DELETE") {
          state.addresses = state.addresses.filter((x) => x.id !== id);
          return json(res, 200, op());
        }
      }

      return json(res, 404, { code: 5, message: "not found: " + method + " " + url });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.putNoop = false;
    quiet.deleteNoop = false;
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

function mkVpc() {
  return createYcVpc({
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
    ycVpc: mkVpc(),
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

// Изменяющие запросы: POST/PUT/DELETE, кроме служебных (токен и операции).
const writeCalls = (calls) =>
  calls.filter(
    (c) => (c.method === "POST" || c.method === "PUT" || c.method === "DELETE") && c.url.indexOf("/operations/") < 0 && c.url.indexOf("/tokens") < 0
  );

(async () => {
  const stub = await startVpcStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Правило приводится к тому виду, который ждёт API");

  await test("ycVpc: направление понимается и по-русски, и по-английски, порты — из числа, строки и диапазона", () => {
    assert.strictEqual(normalizeRule({ protocol: "tcp", cidr: "0.0.0.0/0" }).direction, "ingress", "по умолчанию не вход");
    assert.strictEqual(normalizeRule({ direction: "выход", cidr: "0.0.0.0/0" }).direction, "egress", "«выход» не понят");
    assert.strictEqual(normalizeRule({ direction: "in", cidr: "10.0.0.0/8" }).direction, "ingress", "«in» не понят");
    assert.deepStrictEqual(plain(parsePorts("8000-8010")), { fromPort: 8000, toPort: 8010 }, "диапазон из строки не разобран");
    assert.deepStrictEqual(plain(parsePorts(22)), { fromPort: 22, toPort: 22 }, "одиночный порт не разобран");
    assert.deepStrictEqual(plain(parsePorts({ from: 443, to: 443 })), { fromPort: 443, toPort: 443 }, "порт объектом не разобран");
    assert.strictEqual(parsePorts(""), null, "пустой порт дал диапазон");
    assert.throws(() => parsePorts("не число"), /Порты/, "мусор в портах не пойман");
    assert.throws(() => parsePorts(70000), /диапазона/, "порт вне 65535 не пойман");
  });

  await test("ycVpc: адреса делятся на IPv4 и IPv6, а ICMP остаётся без портов", () => {
    const r = normalizeRule({ direction: "ingress", protocol: "tcp", port: 443, cidr: ["0.0.0.0/0", "2001:db8::/32"] });
    assert.deepStrictEqual(plain(r.cidrBlocks), { v4CidrBlocks: ["0.0.0.0/0"], v6CidrBlocks: ["2001:db8::/32"] }, "IPv4 и IPv6 не разделены");
    assert.deepStrictEqual(plain(r.portRange), { fromPort: 443, toPort: 443 }, "порт потерялся");
    const icmp = normalizeRule({ direction: "ingress", protocol: "icmp", port: 22, cidr: "10.0.0.0/8" });
    assert.ok(!icmp.portRange, "ICMP получил диапазон портов — сервис на это отвечает отказом");
    assert.deepStrictEqual(plain(icmp.cidrBlocks.v4CidrBlocks), ["10.0.0.0/8"], "источник ICMP потерялся");
    assert.throws(() => normalizeRule({ direction: "ingress", protocol: "tcp", port: 22 }), /источник/, "правило входа без источника прошло");
    const eg = normalizeRule({ direction: "egress" });
    assert.deepStrictEqual(plain(eg.cidrBlocks.v4CidrBlocks), ["0.0.0.0/0"], "выход без источника не получил весь интернет");
    assert.throws(() => normalizeRule({ protocol: "gre", cidr: "0.0.0.0/0" }), /Протокол/, "неизвестный протокол прошёл");
    assert.throws(() => normalizeRule({ protocol: "tcp", cidr: "не-адрес" }), /не понял/, "мусор в адресе прошёл");
  });

  await test("ycVpc: ключ правила различает адреса, а человеческая строка читается словами", () => {
    const a = normalizeRule({ direction: "ingress", protocol: "tcp", port: 22, cidr: "203.0.113.10/32" });
    const b = normalizeRule({ direction: "ingress", protocol: "tcp", port: 22, cidr: "0.0.0.0/0" });
    assert.notStrictEqual(ruleKey(a), ruleKey(b), "правила с разными источниками считаются одним");
    assert.strictEqual(ruleKey(a), ruleKey(normalizeRule({ direction: "in", protocol: "tcp", port: 22, cidr: "203.0.113.10/32" })), "одинаковые правила дали разные ключи");
    assert.strictEqual(ruleHuman(a), "вход TCP 22 ← 203.0.113.10/32", "человеческая строка правила изменилась: " + ruleHuman(a));
    assert.strictEqual(ruleHuman(normalizeRule({ direction: "egress" })), "выход TCP ← 0.0.0.0/0", "строка правила выхода изменилась: " + ruleHuman(normalizeRule({ direction: "egress" })));
  });

  await test("ycVpc: имя и диапазон проверяются до запроса, с понятным текстом", () => {
    const vpc = mkVpc();
    assert.throws(() => vpc.checkName("My-Subnet"), /строчные/, "заглавные буквы прошли проверку");
    assert.throws(() => vpc.checkName("под-сеть"), /не подойдёт/, "кириллица прошла проверку");
    assert.throws(() => vpc.checkName("a"), /не подойдёт/, "слишком короткое имя прошло");
    assert.strictEqual(vpc.checkName("app-subnet-a"), "app-subnet-a", "нормальное имя не принято");
    assert.deepStrictEqual(plain(vpc.checkCidr("10.10.0.0/24", "Диапазон")), ["10.10.0.0/24"], "диапазон не принят");
    assert.throws(() => vpc.checkCidr("10.10.0.0/33", "Диапазон"), /не похоже/, "маска больше 32 прошла");
    assert.throws(() => vpc.checkCidr("300.1.1.1/24", "Диапазон"), /не похоже/, "октет больше 255 прошёл");
    assert.throws(() => vpc.checkCidr("", "Диапазон"), /укажи диапазон/, "пустой диапазон прошёл");
  });

  await test("ycVpc: свободный диапазон предлагается рядом с занятыми, а не наугад", () => {
    assert.strictEqual(suggestCidr([{ v4CidrBlocks: ["10.10.0.0/24"] }, { v4CidrBlocks: ["10.11.0.0/24"] }]), "10.12.0.0/24", "предложен занятый диапазон");
    assert.strictEqual(suggestCidr([]), "10.10.0.0/24", "для пустого каталога подсказка изменилась");
    const many = [];
    for (let n = 10; n < 250; n++) many.push({ v4CidrBlocks: ["10." + n + ".0.0/24"] });
    assert.strictEqual(suggestCidr(many), "192.168.1.0/24", "запасная серия 192.168 не использована");
  });

  console.log("\n[2] Настоящие запросы к подменённому облаку");

  await test("ycVpc: списки читаются и приводятся к стабильным полям", async () => {
    stub.reset();
    const vpc = mkVpc();
    const nets = await vpc.networks("oauth-1", "folder-1");
    const subs = await vpc.subnets("oauth-1", "folder-1");
    const groups = await vpc.securityGroups("oauth-1", "folder-1");
    const addrs = await vpc.addresses("oauth-1", "folder-1");
    assert.strictEqual(nets[0].name, "my-net", "сеть не прочитана");
    assert.deepStrictEqual(plain(subs[0].v4CidrBlocks), ["10.10.0.0/24"], "подсеть не прочитана");
    assert.strictEqual(groups[0].ingress, 1, "число правил входа посчитано неверно: " + groups[0].ingress);
    assert.strictEqual(groups[0].egress, 1, "число правил выхода посчитано неверно");
    assert.ok(groups[0].rules.some((r) => r.predefinedTarget === "all"), "предопределённое правило потерялось при чтении");
    assert.strictEqual(addrs.find((a) => a.name === "idle-ip").used, false, "простаивающий адрес помечен занятым");
    assert.strictEqual(addrs.find((a) => a.name === "web-ip").address, "203.0.113.10", "адрес не прочитан");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение что-то изменило в облаке");
  });

  await test("ycVpc: подсеть создаётся в зоне и с диапазоном, операция дожидается, объект перечитывается", async () => {
    stub.reset();
    const vpc = mkVpc();
    const made = await vpc.createSubnet("oauth-1", { folderId: "folder-1", name: "web-subnet", network: "my-net", zoneId: "ru-central1-a", cidr: "10.12.0.0/24" });
    const post = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/vpc/v1/subnets") >= 0);
    assert.ok(post, "запрос создания не ушёл");
    const body = JSON.parse(post.body);
    assert.deepStrictEqual(
      plain(body),
      { folderId: "folder-1", networkId: "net-1", name: "web-subnet", zoneId: "ru-central1-a", v4CidrBlocks: ["10.12.0.0/24"] },
      "тело создания подсети собрано неверно: " + post.body
    );
    assert.strictEqual(made.name, "web-subnet", "созданная подсеть не перечитана");
    assert.deepStrictEqual(plain(made.v4CidrBlocks), ["10.12.0.0/24"], "диапазон созданной подсети не тот");
    assert.ok(stub.calls.some((c) => c.url.indexOf("/operations/") >= 0), "операция не дождалась завершения");
    assert.strictEqual(stub.state.subnets.filter((s) => s.name === "web-subnet").length, 1, "подсети нет в каталоге после создания");
  });

  await test("ycVpc: подсеть без сети и без зоны — понятный отказ и НИ одного запроса на создание", async () => {
    stub.reset();
    const vpc = mkVpc();
    await assert.rejects(() => vpc.createSubnet("oauth-1", { folderId: "folder-1", name: "x-subnet", zoneId: "ru-central1-a", cidr: "10.20.0.0/24" }), /Не нашёл сеть|network/, "сеть не проверена");
    await assert.rejects(() => vpc.createSubnet("oauth-1", { folderId: "folder-1", name: "x-subnet", network: "my-net", cidr: "10.20.0.0/24" }), /зону/, "зона не проверена");
    await assert.rejects(() => vpc.createSubnet("oauth-1", { folderId: "folder-1", name: "x-subnet", network: "my-net", zoneId: "ru-central1-a", cidr: "мусор" }), /не похоже/, "диапазон не проверен");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "несмотря на отказ, что-то создавалось");
  });

  await test("ycVpc: удаление подсети проверяет, что она действительно ушла", async () => {
    stub.reset();
    const vpc = mkVpc();
    const r = await vpc.deleteSubnet("oauth-1", "sub-2");
    assert.strictEqual(r.deleted, true, "удаление не подтверждено");
    assert.ok(!stub.state.subnets.some((s) => s.id === "sub-2"), "подсеть осталась в каталоге");
    const del = stub.calls.find((c) => c.method === "DELETE");
    assert.strictEqual(del.url, "/vpc/v1/subnets/sub-2", "удаление ушло не по адресу: " + del.url);
    assert.ok(stub.calls.some((c) => c.method === "GET" && c.url.indexOf("/vpc/v1/subnets/sub-2") >= 0), "результат удаления не перепроверен");
  });

  await test("ycVpc: правило добавляется целиком списком — предопределённые правила остаются, id правила не уходит", async () => {
    stub.reset();
    const vpc = mkVpc();
    const r = await vpc.updateSecurityGroupRules("oauth-1", {
      sgId: "sg-1",
      add: { direction: "ingress", protocol: "tcp", port: 443, cidr: "0.0.0.0/0" },
    });
    assert.strictEqual(r.changed, true, "правка не засчитана");
    const put = stub.calls.find((c) => c.method === "PUT");
    assert.ok(put, "запрос обновления группы не ушёл");
    const body = JSON.parse(put.body);
    assert.strictEqual(body.updateMask, "rule_specs", "updateMask не тот: " + body.updateMask);
    assert.ok(!JSON.stringify(body).includes('"id"'), "обратно ушло поле id правила — настоящий сервис на это отвечает отказом");
    const sent = body.ruleSpecs || [];
    assert.strictEqual(sent.length, 3, "в списке не три правила: " + sent.length);
    assert.ok(sent.some((x) => x.predefinedTarget === "all" && x.direction === "egress"), "предопределённое правило потерялось при правке");
    assert.ok(sent.some((x) => x.portRange && x.portRange.fromPort === 22), "прежнее правило SSH потерялось");
    assert.ok(sent.some((x) => x.portRange && x.portRange.fromPort === 443 && x.cidrBlocks.v4CidrBlocks[0] === "0.0.0.0/0"), "новое правило не ушло");
    const g = stub.state.groups.find((x) => x.id === "sg-1");
    assert.strictEqual(g.ruleSpecs.length, 3, "в группе не три правила после правки");
    assert.ok(g.ruleSpecs.some((x) => x.portRange && x.portRange.fromPort === 443), "нового правила нет в группе");
  });

  await test("ycVpc: удаление несуществующего правила ловится ДО записи, группа не меняется", async () => {
    stub.reset();
    const vpc = mkVpc();
    await assert.rejects(
      () => vpc.updateSecurityGroupRules("oauth-1", { sgId: "sg-1", remove: { direction: "ingress", protocol: "tcp", port: 8080, cidr: "0.0.0.0/0" } }),
      /нет такого правила/,
      "отсутствующее правило не поймано"
    );
    assert.strictEqual(stub.calls.filter((c) => c.method === "PUT").length, 0, "группа была перезаписана несмотря на отказ");
    assert.strictEqual(stub.state.groups.find((x) => x.id === "sg-1").ruleSpecs.length, 2, "правила группы изменились при отказе");
  });

  await test("ycVpc: повторное правило не добавляется, удаление существующего работает", async () => {
    stub.reset();
    const vpc = mkVpc();
    const dup = await vpc.updateSecurityGroupRules("oauth-1", {
      sgId: "sg-1",
      add: { direction: "ingress", protocol: "tcp", port: 22, cidr: "203.0.113.10/32" },
    });
    assert.strictEqual(dup.changed, false, "дубль правила добавлен как новое");
    assert.strictEqual(stub.calls.filter((c) => c.method === "PUT").length, 0, "лишняя запись в облако при дубле");

    const del = await vpc.updateSecurityGroupRules("oauth-1", {
      sgId: "sg-1",
      remove: { direction: "ingress", protocol: "tcp", port: 22, cidr: "203.0.113.10/32" },
    });
    assert.strictEqual(del.changed, true, "правило не удалено");
    const g = stub.state.groups.find((x) => x.id === "sg-1");
    assert.ok(!g.ruleSpecs.some((x) => x.portRange && x.portRange.fromPort === 22), "правило SSH осталось в группе");
    assert.ok(g.ruleSpecs.some((x) => x.predefinedTarget === "all"), "предопределённое правило потерялось при удалении");
  });

  await test("ycVpc: группа создаётся, правила сверяются после записи, адрес закрепляется и освобождается", async () => {
    stub.reset();
    const vpc = mkVpc();
    const sg = await vpc.createSecurityGroup("oauth-1", {
      folderId: "folder-1",
      name: "web-sg",
      network: "my-net",
      rules: [{ direction: "ingress", protocol: "tcp", port: 22, cidr: "203.0.113.10/32" }],
    });
    assert.strictEqual(sg.name, "web-sg", "группа не перечитана после создания");
    assert.strictEqual(sg.ingress, 1, "правило созданной группы не прочитано: " + JSON.stringify(sg.rules));

    const ip = await vpc.reserveAddress("oauth-1", { folderId: "folder-1", name: "api-ip", zoneId: "ru-central1-a" });
    assert.ok(/^198\.51\.100\./.test(ip.address), "адрес не прочитан после закрепления: " + ip.address);
    const post = stub.calls.find((c) => c.method === "POST" && c.url.indexOf("/vpc/v1/addresses") >= 0);
    assert.deepStrictEqual(plain(JSON.parse(post.body).externalIpv4Address), { zoneId: "ru-central1-a" }, "тело закрепления адреса собрано неверно");
    assert.strictEqual(ip.used, false, "новый адрес помечен занятым");

    await vpc.releaseAddress("oauth-1", "ip-2");
    assert.ok(!stub.state.addresses.some((a) => a.id === "ip-2"), "адрес не освобождён");
    await assert.rejects(() => vpc.reserveAddress("oauth-1", { folderId: "folder-1", name: "no-zone-ip" }), /зону/, "закрепление без зоны прошло");
  });

  // Облако может ответить «сделано» и ничего не сделать (права, чужая зона,
  // молча отброшенное поле). Проверяем именно это: обещание «правило добавлено»
  // обязано подтверждаться ПЕРЕЧТЕНИЕМ, иначе агент отчитается о несуществующем
  // правиле, а человек будет искать, почему порт не открылся.
  await test("ycVpc: молча не применённая правка правил ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.putNoop = true;
    const vpc = mkVpc();
    await assert.rejects(
      () => vpc.updateSecurityGroupRules("oauth-1", { sgId: "sg-1", add: { direction: "ingress", protocol: "tcp", port: 443, cidr: "0.0.0.0/0" } }),
      /Правило не появилось/,
      "запись без результата принята за успех"
    );
    stub.quiet.putNoop = false;
  });

  await test("ycVpc: молча не удалённая подсеть ловится перечитыванием", async () => {
    stub.reset();
    stub.quiet.deleteNoop = true;
    const vpc = mkVpc();
    await assert.rejects(() => vpc.deleteSubnet("oauth-1", "sub-2"), /не удалилась/, "удаление без результата принято за успех");
    stub.quiet.deleteNoop = false;
  });

  console.log("\n[3] Инструмент агента ycVpc: права и ответы");

  await test("ycVpc: без подключения, без каталога и с непонятным действием отвечает честно", async () => {
    const noAuth = buildTools({ yandexOauthToken: "" });
    assert.ok(/не подключён/.test(await noAuth.tools.ycVpc({ action: "list" }, {})), "нет ответа про подключение");
    const noFolder = buildTools({ ycFolderId: "" });
    assert.ok(/каталог/.test(await noFolder.tools.ycVpc({ action: "list" }, {})), "нет ответа про каталог");
    const { tools } = buildTools();
    const bad = await tools.ycVpc({ action: "удали всё" }, {});
    assert.ok(/неизвестное действие/.test(bad) && /addsubnet/.test(bad), "неизвестное действие не объяснено: " + bad);
  });

  await test("ycVpc: запреты (создание, правила, удаление) звучат ДО запроса и не трогают облако", async () => {
    stub.reset();
    const { tools } = buildTools();
    const create = await tools.ycVpc({ action: "addsubnet", name: "x-subnet", zone: "ru-central1-a", cidr: "10.30.0.0/24" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(create) && /создавать ресурсы/.test(create), "нет запрета на создание: " + create);
    const rule = await tools.ycVpc({ action: "addrule", group: "app-sg", port: 22, cidr: "203.0.113.10/32" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(rule) && /правила сети/.test(rule), "нет запрета на правку правил: " + rule);
    const del = await tools.ycVpc({ action: "release", address: "idle-ip" }, {});
    assert.ok(/ЗАПРЕЩЕНО/.test(del) && /удалять ресурсы/.test(del), "нет запрета на удаление: " + del);
    assert.strictEqual(writeCalls(stub.calls).length, 0, "запрет не помешал запросу в облако");
    // Чтение при выключенных правах доступно — иначе агент не увидит даже списка.
    const list = await tools.ycVpc({ action: "list" }, {});
    assert.ok(/Сеть VPC/.test(list), "чтение запрещено вместе с изменениями: " + list);
  });

  await test("ycVpc: list показывает сеть, подсети, группы и предупреждает о простаивающем адресе", async () => {
    stub.reset();
    const { tools } = buildTools();
    const out = await tools.ycVpc({ action: "list" }, {});
    assert.ok(/my-net/.test(out), "нет сети в ответе");
    assert.ok(/app-subnet-a/.test(out) && /ru-central1-a/.test(out), "нет подсети с зоной");
    assert.ok(/app-sg/.test(out) && /правил: вход 1, выход 1/.test(out), "нет группы с числом правил: " + out);
    assert.ok(/203\.0\.113\.99/.test(out) && /Простаивают/.test(out), "простаивающий адрес не назван: " + out);
    assert.ok(/release/.test(out), "нет подсказки, как освободить адрес");
  });

  await test("ycVpc: addrule отвечает словами и предупреждает про 0.0.0.0/0", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentUpdate: true });
    const out = await tools.ycVpc({ action: "addrule", group: "app-sg", direction: "ingress", protocol: "tcp", port: 443, cidr: "0.0.0.0/0" }, {});
    assert.ok(/✅ Правило добавлено/.test(out), "нет подтверждения добавления: " + out);
    assert.ok(/вход TCP 443 ← 0\.0\.0\.0\/0/.test(out), "правило не описано словами: " + out);
    assert.ok(/ВСЕМУ интернету/.test(out), "нет предупреждения про 0.0.0.0/0: " + out);
    assert.ok(/app-sg/.test(out), "нет группы в ответе");
    const dup = await tools.ycVpc({ action: "addrule", group: "app-sg", direction: "ingress", protocol: "tcp", port: 443, cidr: "0.0.0.0/0" }, {});
    assert.ok(/уже есть/.test(dup), "повтор правила не распознан: " + dup);
    const gone = await tools.ycVpc({ action: "delrule", group: "app-sg", direction: "ingress", protocol: "tcp", port: 9999, cidr: "0.0.0.0/0" }, {});
    assert.ok(/нет такого правила/.test(gone), "удаление несуществующего правила не объяснено: " + gone);
  });

  await test("ycVpc: подсеть создаётся с подсказанным диапазоном, адрес закрепляется с ценой, занятый адрес не освобождается", async () => {
    stub.reset();
    const { tools } = buildTools({ ycAllowAgentCreate: true, ycAllowAgentDelete: true });
    const sub = await tools.ycVpc({ action: "addsubnet", name: "auto-subnet", network: "my-net", zone: "ru-central1-a" }, {});
    assert.ok(/✅ Подсеть создана/.test(sub), "подсеть не создана: " + sub);
    assert.ok(/10\.12\.0\.0\/24/.test(sub), "подсказанный диапазон не назван: " + sub);
    assert.ok(/предложен как свободный/.test(sub), "не сказано, что диапазон подобран");

    const ip = await tools.ycVpc({ action: "reserve", name: "site-ip", zone: "ru-central1-b" }, {});
    assert.ok(/✅ Статический адрес закреплён/.test(ip), "адрес не закреплён: " + ip);
    assert.ok(/простаивающий/.test(ip), "не сказано, что простаивающий адрес платный: " + ip);

    const busy = await tools.ycVpc({ action: "release", address: "web-ip" }, {});
    assert.ok(/привязан к работающему ресурсу/.test(busy), "занятый адрес попытались освободить: " + busy);
    assert.ok(stub.state.addresses.some((a) => a.id === "ip-1"), "занятый адрес всё-таки пропал");
    const idle = await tools.ycVpc({ action: "release", address: "idle-ip" }, {});
    assert.ok(/освобождён/.test(idle) && /вернуть именно его нельзя/.test(idle), "освобождение адреса объяснено плохо: " + idle);
  });

  await test("ycVpc: цена статического адреса считается из опубликованного тарифа, а не выдумана", () => {
    const est = ycCosts.estimate("vpcAddress", {});
    assert.ok(est, "для статического адреса нет оценки стоимости");
    assert.strictEqual(est.needsConfirm, true, "платный адрес не требует согласия");
    // Цифра обязана собираться из ПОДТВЕРЖДЁННОГО тарифа (₽ за адрес×час × 720 ч),
    // а не браться из воздуха: меняется тариф — меняется и она.
    assert.strictEqual(
      est.approxMonth,
      ycCosts.rub(ycCosts.PUBLIC_IP_HOUR * ycCosts.HOURS_MONTH),
      "цена адреса разошлась с тарифом: " + est.approxMonth
    );
    const idle = ycCosts.estimate("vpcAddress", { idle: true });
    assert.ok(idle.approxMonth > est.approxMonth, "простаивающий адрес не дороже работающего");
    const text = ycCosts.formatLines(est).join(" ");
    assert.ok(/тарифы на/.test(text), "в оценке не сказано, по каким тарифам она посчитана");
    assert.ok(/калькулятор/.test(text), "в оценке нет ссылки на калькулятор");
    assert.ok(/price/.test(String(est.priceList || "")), "у оценки нет ссылки на прайс-лист: " + est.priceList);
    assert.ok(/vpc/.test(est.source), "нет ссылки на тарифы VPC: " + est.source);
  });

  console.log("\n[4] Проводка: канал, мост окна, оболочка");

  await test("ycVpc: канал yc:vpc есть в мосте, окно его видит, оболочка собирает модуль и передаёт его дальше", () => {
    assert.ok(/ipcMain\.handle\("yc:vpc"/.test(IPC_SRC), "нет канала yc:vpc");
    assert.ok(/ycVpc: \(args\) => ipcRenderer\.invoke\("yc:vpc"/.test(PRELOAD_SRC), "окно не видит канал yc:vpc");
    assert.ok(/const \{ createYcVpc \} = require\("\.\/yc-vpc\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль сети");
    assert.ok(/const ycVpc = createYcVpc\(\{/.test(MAIN_SRC), "модуль сети не собран в оболочке");
    // Имя в списке аргументов registerYcIpc, а не соседство строк: точная
    // последовательность ломается от появления любого соседнего модуля
    // (так и вышло, когда рядом встали машины Compute).
    const reg = /registerYcIpc\(\{([\s\S]{0,400}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /\bycVpc\b/.test(reg[1]), "канал IPC не получает модуль сети");
    assert.ok(reg && /\bloadSettings\b/.test(reg[1]), "канал IPC не получает настройки");
    assert.ok(/handle\("yc:vpc"[\s\S]{0,4000}?folderId: cfg\.folderId/.test(IPC_SRC), "канал не передаёт каталог в модуль");
    // Помощники облака передаются настоящие — иначе модуль молча ничего не сделает.
    for (const dep of ["fetchJson: yandexCloud._fetchJson", "endpoint: yandexCloud.endpoint", "getIamToken: yandexCloud.getIamToken", "waitOperation: yandexCloud.waitOperation"]) {
      assert.ok(MAIN_SRC.indexOf(dep) >= 0, "в сборку модуля не передан " + dep);
    }
  });

  await test("ycVpc: схема, группа «облако», промпт, права и справочник знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycVpc"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 4600);
    for (const part of ["action", "network", "zone", "cidr", "group", "direction", "protocol", "port", "sourceGroup", "address", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/создавать ресурсы/.test(schema) && /правила сети/.test(schema) && /удалять ресурсы/.test(schema), "схема не называет разрешения");
    assert.ok(/0\.0\.0\.0\/0/.test(schema), "схема не предупреждает про открытое правило");
    assert.ok(/статические адреса/.test(schema), "схема не объясняет, что такое статический адрес");

    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 900);
    assert.ok(/ycVpc/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycVpc/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycVpc \(сеть VPC/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycVpc");

    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 320).includes('"ycVpc"'), "нет назначения cloud.read для ycVpc");

    assert.ok(/ycVpc/.test(GUIDE_SRC), "в yc.md нет ycVpc");
    assert.ok(/203\.0\.113\.10\/32/.test(GUIDE_SRC), "справочник не показывает правило с одним адресом");
    assert.ok(/не закрепляй адрес «про запас»/.test(GUIDE_SRC), "справочник не предупреждает про простаивающий адрес");
    assert.ok(/группы безопасности/.test(GUIDE_SRC), "справочник не говорит про группы безопасности");
  });

  await test("ycVpc: набор стоит в цепочке npm test, а разведчик API — отдельной командой", () => {
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-vpc.test.js") >= 0, "набора нет в цепочке npm test");
    assert.strictEqual(PKG.scripts["recon:yc"], "node scripts/recon-yc.js", "нет команды разведки API");
    assert.ok(fs.existsSync(path.join(ROOT, "scripts", "recon-yc.js")), "нет самого скрипта разведки");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

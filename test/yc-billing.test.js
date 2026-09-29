"use strict";

/* ── Биллинг: платёжный аккаунт, пороги и «за что мы платим» ──────────────────
   Запуск: node test/yc-billing.test.js   (входит в общий `npm test`)

   Зачем набор. Про деньги приложение умело только считать цену ДО создания
   (yc-costs.js). На «сколько уже ушло» и «за что я плачу, хотя мне не нужно»
   отвечала чужая консоль. Теперь отвечают модуль src/yc-billing.js и инструмент
   ycBilling — и у этого ответа есть границы, которые легко потерять при правке.

   Что проверяется и почему именно это:

     • РАСХОДА в REST API нет, и модуль не имеет права его выдумать: в Billing
       API живут только платёжные аккаунты, бюджеты, каталог услуг и каталог цен
       (SKU). Поэтому в обзоре обязана стоять честная строка «сумму счёта облако
       по API не отдаёт», а рядом — баланс, пороги и то, за что платят по факту;
     • 403 у биллинга — это не «сломалось», а «нет роли billing.viewer», и отказ
       обязан объяснять это словами: без этого человек ищет ошибку в приложении;
     • биллинг привязан к ПЛАТЁЖНОМУ аккаунту, а не к каталогу: баланс и пороги
       читаются без каталога, а несколько аккаунтов без ссылки не угадываются —
       показать чужие деньги хуже, чем спросить;
     • баланс — это НЕ расход: минус и ноль на балансе названы прямо, потому что
       это единственный честный сигнал «скоро остановят»;
     • цены берутся из ЖИВОГО каталога SKU: действующая версия цены выбирается по
       времени вступления в силу, ступенчатая цена помечается (одной цифрой её
       показывать нельзя), а рядом говорится, что наши ориентиры в yc-costs.js
       посчитаны по документации и могут отстать;
     • платные хвосты считаются В ДЕНЬГАХ и по одному правилу: «что такое хвост»
       решает Compute (paidLeftovers), а биллинг складывает цену за месяц и
       дополняет тем, чего Compute не видит (остановленные машины, чьи диски
       платят всегда; снимки старше 90 дней; работающие машины — текущий счёт);
     • хвосты остаются видны, даже когда биллинг недоступен: они живут в каталоге
       и читаются другими правами, поэтому падение биллинга не имеет права
       прятать отчёт о деньгах;
     • инструмент агента ycBilling ничего не меняет и разрешений не требует (в
       Billing API изменяющих методов нет вовсе), но обязан отказать внятно:
       нет подключения, нет каталога, нет запроса цены;
     • проводка: канал yc:billing, мост окна, схема, группа «облако», промпт,
       политика прав, справочник и сторож smoke.

   Сеть не нужна: облако подменено локальным HTTP-сервером (штатный хук
   AI_AGENT_YC_BASE), а модуль биллинга получает НАСТОЯЩИЕ модули машины и сети —
   ровно те, что собираются в main.js. */

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
const costs = require(path.join(ROOT, "src", "yc-costs.js"));
const billingLib = require(path.join(ROOT, "src", "yc-billing.js"));
const { createYcCompute } = require(path.join(ROOT, "src", "yc-compute.js"));
const { createYcVpc } = require(path.join(ROOT, "src", "yc-vpc.js"));
const { createCloudTools } = require(path.join(ROOT, "src", "agent-tools-cloud.js"));
const {
  createYcBilling,
  currencyOf,
  currencySign,
  formatMoney,
  formatRate,
  balanceHuman,
  billingAccountInfo,
  accountTrouble,
  accountLines,
  pickAccount,
  budgetSpec,
  budgetKind,
  periodHuman,
  budgetFilterHuman,
  budgetInfo,
  budgetTrouble,
  budgetLines,
  pricingUnitHuman,
  rateOf,
  skuInfo,
  matchSkus,
  BILLING_FALLBACK,
  OLD_SNAPSHOT_DAYS,
} = billingLib;

const IPC_SRC = read("src", "yc-ipc.js");
const PRELOAD_SRC = read("src", "preload.js");
const SCHEMAS_SRC = read("src", "renderer", "tool-schemas.js");
const POLICY_SRC = read("src", "tool-policy.js");
const CORE_SRC = read("src", "renderer", "agent-core.js");
const PROMPTS_SRC = read("src", "renderer", "prompts.js");
const GUIDE_SRC = read("src", "agent-guides", "yc.md");
const MAIN_SRC = read("src", "main.js");
const BILLING_SRC = read("src", "yc-billing.js");
const TOOLS_SRC = read("src", "agent-tools-cloud.js");
const PKG = JSON.parse(read("package.json"));

// ── Подменённое облако: биллинг + каталог машин и сети ──────────────────────
const GB = 1073741824;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function initialState() {
  return {
    accounts: [
      { id: "dn2aaaa", name: "Основной счёт", createdAt: daysAgo(400), countryCode: "RU", currency: "RUB", active: true, balance: "1234.56" },
    ],
    // Второй аккаунт появляется только в отдельной проверке: «несколько
    // аккаунтов без ссылки» — это отказ, а не догадка.
    extraAccounts: [],
    budgets: [
      {
        id: "bud-1",
        name: "месячный лимит",
        createdAt: daysAgo(60),
        billingAccountId: "dn2aaaa",
        status: "ACTIVE",
        costBudget: {
          resetPeriod: "MONTHLY",
          amount: "1000",
          notificationUserAccountIds: ["acc-1"],
          thresholdRules: [
            { type: "PERCENT", amount: "50", notificationUserAccountIds: ["acc-1"] },
            { type: "PERCENT", amount: "80", notificationUserAccountIds: ["acc-1"] },
          ],
          filter: { cloudFoldersFilters: [{ cloudId: "cloud-1", folderIds: ["folder-1"] }] },
          endDate: "2026-12-31",
        },
      },
    ],
    services: [
      { id: "dn28hpu6268356q0j8mk", name: "Compute Cloud", description: "виртуальные машины и диски" },
      { id: "dn2func00000000000", name: "Cloud Functions", description: "функции" },
    ],
    skus: [
      {
        id: "sku-ssd",
        name: "Быстрый диск (network-ssd), хранение",
        description: "Быстрый сетевой диск: цена за гигабайт в час",
        serviceId: "dn28hpu6268356q0j8mk",
        pricingUnit: "gbyte*hour",
        pricingVersions: [
          // Старая цена уже не действует: её не должно быть видно.
          { type: "STREET_PRICE", effectiveTime: daysAgo(400), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "0.01", currency: "RUB" }] }] },
          { type: "STREET_PRICE", effectiveTime: daysAgo(10), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "0.0192", currency: "RUB" }] }] },
        ],
      },
      {
        id: "sku-core",
        name: "Процессор, 100% ядра",
        description: "Цена за ядро в час",
        serviceId: "dn28hpu6268356q0j8mk",
        pricingUnit: "core*hour",
        pricingVersions: [
          // Ступенчатая цена: первые 100 часов дешевле.
          {
            type: "STREET_PRICE",
            effectiveTime: daysAgo(30),
            pricingExpressions: [
              { rates: [{ startPricingQuantity: "0", unitPrice: "3.2", currency: "RUB" }, { startPricingQuantity: "100", unitPrice: "2.8", currency: "RUB" }] },
            ],
          },
        ],
      },
      {
        id: "sku-func",
        name: "Вызовы функций, миллион",
        description: "Функции: цена за миллион вызовов",
        serviceId: "dn2func00000000000",
        pricingUnit: "million*request",
        pricingVersions: [
          { type: "CONTRACT_PRICE", effectiveTime: daysAgo(5), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "18.97", currency: "RUB" }] }] },
        ],
      },
    ],
    // Вторая страница каталога цен: проверяем, что модуль читает дальше, а не
    // останавливается на первой.
    skusPage2: [
      {
        id: "sku-hdd",
        name: "Стандартный диск (network-hdd), хранение",
        description: "Стандартный сетевой диск: цена за гигабайт в час",
        serviceId: "dn28hpu6268356q0j8mk",
        pricingUnit: "gbyte*hour",
        pricingVersions: [{ type: "STREET_PRICE", effectiveTime: daysAgo(20), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "0.0048", currency: "RUB" }] }] }],
      },
    ],
    instances: [
      // Работает круглосуточно: это текущий счёт, а не хвост.
      {
        id: "epd-1",
        name: "site",
        folderId: "folder-1",
        zoneId: "ru-central1-a",
        status: "RUNNING",
        createdAt: daysAgo(40),
        resources: { cores: 2, coreFraction: 20, memory: String(2 * GB) },
        bootDisk: { diskId: "disk-1", autoDelete: true },
        networkInterfaces: [{ index: 0, subnetId: "sub-1", primaryV4Address: { address: "10.0.0.5", oneToOneNat: { address: "84.201.1.1" } } }],
      },
      // Остановлена, но её диск платит.
      {
        id: "epd-2",
        name: "старый-сервер",
        folderId: "folder-1",
        zoneId: "ru-central1-a",
        status: "STOPPED",
        createdAt: daysAgo(200),
        resources: { cores: 2, coreFraction: 100, memory: String(4 * GB) },
        bootDisk: { diskId: "disk-2", autoDelete: true },
        networkInterfaces: [{ index: 0, subnetId: "sub-1", primaryV4Address: { address: "10.0.0.6" } }],
      },
    ],
    disks: [
      { id: "disk-1", name: "site-root", zoneId: "ru-central1-a", typeId: "network-ssd", size: String(20 * GB), status: "READY", instanceIds: ["epd-1"] },
      { id: "disk-2", name: "старый-root", zoneId: "ru-central1-a", typeId: "network-ssd", size: String(50 * GB), status: "READY", instanceIds: ["epd-2"] },
      // Диск без машины — платный хвост на 100 ГБ HDD.
      { id: "disk-3", name: "забытый-диск", zoneId: "ru-central1-a", typeId: "network-hdd", size: String(100 * GB), status: "READY", instanceIds: [] },
    ],
    snapshots: [
      // Снимок диска, которого больше нет: чистая плата за хранение.
      { id: "snap-1", name: "снимок-старого", diskSize: String(50 * GB), storageSize: String(20 * GB), status: "READY", sourceDiskId: "disk-нет", createdAt: daysAgo(120) },
      // Снимок живого диска, но ему больше 90 дней.
      { id: "snap-2", name: "снимок-до-обновления", diskSize: String(20 * GB), storageSize: String(10 * GB), status: "READY", sourceDiskId: "disk-1", createdAt: daysAgo(120) },
      // Свежий снимок: трогать не надо.
      { id: "snap-3", name: "снимок-вчера", diskSize: String(20 * GB), storageSize: String(10 * GB), status: "READY", sourceDiskId: "disk-1", createdAt: daysAgo(1) },
    ],
    addresses: [
      { id: "e9b-1", name: "сайт", externalIpv4Address: { address: "84.201.1.1", zoneId: "ru-central1-a" }, used: true, reserved: true, createdAt: daysAgo(30) },
      // Простаивающий статический адрес: платится как занятый, но никем не занят.
      { id: "e9b-2", name: "запас", externalIpv4Address: { address: "84.201.9.9", zoneId: "ru-central1-a" }, used: false, reserved: true, createdAt: daysAgo(50) },
    ],
  };
}

function startBillingStub() {
  const calls = [];
  const state = initialState();
  const quiet = { skuPageOnce: false, billing403: false, billing404: false, balance: null };
  const SKU_PAGE = 2; // первая страница из двух записей — проверка nextPageToken

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
      const param = (k) => {
        const m = new RegExp("(?:^|&)" + k + "=([^&]*)").exec(query);
        return m ? decodeURIComponent(m[1]) : "";
      };

      if (url.indexOf("/iam/v1/tokens") >= 0) {
        return json(res, 200, { iamToken: "iam-test", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      }

      // ── Биллинг ───────────────────────────────────────────────────────────
      if (q.indexOf("/billing/") === 0) {
        if (quiet.billing403) return json(res, 403, { code: 7, message: "Permission denied: no billing.viewer role" });
        if (quiet.billing404) return json(res, 404, { code: 5, message: "NOT_FOUND" });
      }

      if (q === "/billing/v1/billingAccounts" && method === "GET") {
        const list = plain(state.accounts.concat(state.extraAccounts));
        if (quiet.balance != null) for (const a of list) a.balance = String(quiet.balance);
        return json(res, 200, { billingAccounts: list });
      }
      if (q.indexOf("/billing/v1/billingAccounts/") === 0 && q.indexOf("/budgets") < 0) {
        const id = q.slice("/billing/v1/billingAccounts/".length);
        const a = state.accounts.concat(state.extraAccounts).find((x) => x.id === id);
        if (!a) return json(res, 404, { code: 5, message: "NOT_FOUND: нет такого платёжного аккаунта" });
        return json(res, 200, plain(a));
      }
      if (/\/billing\/v1\/billingAccounts\/[^/]+\/budgets$/.test(q) && method === "GET") {
        const id = q.slice("/billing/v1/billingAccounts/".length, q.length - "/budgets".length);
        return json(res, 200, { budgets: plain(state.budgets.filter((b) => b.billingAccountId === id)) });
      }
      if (q === "/billing/v1/services" && method === "GET") {
        return json(res, 200, { services: plain(state.services) });
      }
      if (q === "/billing/v1/skus" && method === "GET") {
        const serviceId = param("filter").replace(/^serviceId="|"$/g, "");
        const all = state.skus.concat(state.skusPage2).filter((s) => !serviceId || s.serviceId === serviceId);
        const token = param("pageToken");
        const size = Number(param("pageSize")) || SKU_PAGE;
        const window = quiet.skuPageOnce ? 1 : SKU_PAGE;
        const from = token ? Number(token) : 0;
        const page = all.slice(from, from + window);
        const next = from + window < all.length ? String(from + window) : "";
        return json(res, 200, { skus: plain(page), nextPageToken: next, pageSize: size });
      }

      // ── Машины и сеть: ими живо правило «что такое платный хвост» ─────────
      const listOf = (key, items, extraFilter) => {
        const folder = param("folderId");
        if (!folder) return json(res, 400, { code: 3, message: "INVALID_ARGUMENT: нет folderId" });
        return json(res, 200, { [key]: plain(extraFilter ? items.filter(extraFilter) : items) });
      };
      if (q === "/compute/v1/instances" && method === "GET") return listOf("instances", state.instances);
      if (q === "/compute/v1/disks" && method === "GET") return listOf("disks", state.disks);
      if (q === "/compute/v1/snapshots" && method === "GET") return listOf("snapshots", state.snapshots);
      if (q === "/vpc/v1/addresses" && method === "GET") return listOf("addresses", state.addresses);

      return json(res, 404, { code: 5, message: "NOT_FOUND: " + method + " " + q });
    });
  });

  const reset = () => {
    const fresh = initialState();
    for (const k of Object.keys(fresh)) state[k] = fresh[k];
    quiet.skuPageOnce = false;
    quiet.billing403 = false;
    quiet.billing404 = false;
    quiet.balance = null;
    calls.length = 0;
  };

  return new Promise((r) => {
    server.listen(0, "127.0.0.1", () => r({ server, calls, state, quiet, reset, base: "http://127.0.0.1:" + server.address().port }));
  });
}

// Настоящие модули машины и сети — те же, что собирает main.js: иначе «что такое
// платный хвост» проверялось бы на выдуманной копии правила.
function mkBilling() {
  const deps = {
    fetchJson: yandex._fetchJson,
    endpoint: yandex.endpoint,
    getIamToken: yandex.getIamToken,
    waitOperation: yandex.waitOperation,
    serviceError: yandex.serviceError,
    isNetworkError: yandex.isNetworkError,
  };
  const ycCompute = createYcCompute(deps);
  const ycVpc = createYcVpc(deps);
  return { billing: createYcBilling(Object.assign({}, deps, { ycCompute, ycVpc })), ycCompute, ycVpc };
}

function buildTools(settingsOver) {
  const settings = Object.assign(
    {
      yandexOauthToken: "oauth-1",
      ycCloudId: "cloud-1",
      ycFolderId: "folder-1",
      ycFolderName: "prod",
    },
    settingsOver || {}
  );
  const { billing, ycCompute, ycVpc } = mkBilling();
  const tools = createCloudTools({
    yandexCloud: yandex,
    ycBilling: billing,
    ycCompute,
    ycVpc,
    ycCosts: costs,
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

const writeCalls = (calls) => calls.filter((c) => c.method !== "GET" && c.url.indexOf("/tokens") < 0);

(async () => {
  const stub = await startBillingStub();
  process.env.AI_AGENT_YC_BASE = stub.base;

  console.log("\n[1] Деньги, пороги и цены — до всякой сети");

  await test("ycBilling: деньги печатаются по-человечески, валюта берётся из аккаунта", () => {
    assert.strictEqual(formatMoney(1234567.891, "RUB"), "1 234 567,89 ₽", "сумма напечатана неверно: " + formatMoney(1234567.891, "RUB"));
    assert.strictEqual(formatMoney(-120, "RUB"), "−120,00 ₽", "минус потерялся: " + formatMoney(-120, "RUB"));
    assert.strictEqual(currencySign("USD"), "$", "валюта USD не распознана");
    assert.strictEqual(currencySign("kzt"), "₸", "валюта KZT не распознана");
    assert.strictEqual(currencyOf("что-то"), "RUB", "неизвестная валюта не сведена к рублю");
    // Копеечная цена не округляется в ноль: иначе «0,01 ₽» и «0,0005 ₽» выглядели бы одинаково.
    assert.notStrictEqual(formatRate(0.0048, "RUB"), "0,00 ₽", "мелкая цена округлена в ноль");
    assert.ok(/0,0048/.test(formatRate(0.0048, "RUB")), "мелкая цена потеряла знаки: " + formatRate(0.0048, "RUB"));
    assert.ok(/в минусе/.test(balanceHuman("-5", "RUB")), "минус на балансе не назван");
    assert.ok(/счёт пуст/.test(balanceHuman(0, "RUB")), "нулевой баланс не назван");
  });

  await test("ycBilling: платёжный аккаунт читается словами, и о минусе сказано прямо", () => {
    const a = billingAccountInfo({ id: "dn2aaaa", name: "Основной", createdAt: daysAgo(10), currency: "RUB", active: true, balance: "1234.56" });
    assert.strictEqual(a.currency, "RUB", "валюта потерялась");
    assert.strictEqual(a.balance, 1234.56, "баланс не разобран в число: " + a.balance);
    assert.strictEqual(a.ageDays, 10, "возраст аккаунта посчитан неверно: " + a.ageDays);
    assert.deepStrictEqual(plain(accountTrouble(a)), [], "исправному аккаунту приписана беда: " + JSON.stringify(accountTrouble(a)));
    const bad = billingAccountInfo({ id: "dn2", currency: "RUB", active: false, balance: "-1500.5" });
    const troubles = accountTrouble(bad);
    assert.strictEqual(troubles.length, 2, "про выключенный аккаунт и минус сказано не всё: " + troubles.join(" | "));
    assert.ok(/ВЫКЛЮЧЕН/.test(troubles[0]) && /остановит/.test(troubles[0]), "выключенный аккаунт не объяснён: " + troubles[0]);
    assert.ok(/в минусе/.test(troubles[1]) && !/\(в минусе\)/.test(troubles[1]), "предупреждение о минусе задвоило слово: " + troubles[1]);
    const lines = accountLines(bad).join("\n");
    assert.ok(/ВЫКЛЮЧЕН/.test(lines) && /−1 500,50 ₽/.test(lines), "строки аккаунта не назвали состояние и баланс: " + lines);
    // Несколько аккаунтов без ссылки не угадываются: чужие деньги хуже вопроса.
    const many = [billingAccountInfo({ id: "a" }), billingAccountInfo({ id: "b" })];
    assert.strictEqual(pickAccount(many, ""), null, "аккаунт угадан при двух доступных");
    assert.strictEqual(pickAccount(many, "b").id, "b", "аккаунт не найден по id");
    assert.strictEqual(pickAccount([many[1]], "").id, "b", "единственный аккаунт не выбран автоматически");
  });

  await test("ycBilling: у порога-бюджета называются вид, период и фильтр", () => {
    const cost = budgetInfo(stub.state.budgets[0]);
    assert.strictEqual(cost.kind, "cost", "вид бюджета «расход» не распознан: " + cost.kind);
    assert.strictEqual(cost.amountHuman, "1 000,00 ₽", "порог напечатан неверно: " + cost.amountHuman);
    assert.strictEqual(cost.period, "каждый месяц", "период не назван: " + cost.period);
    assert.strictEqual(cost.statusHuman, "действует", "состояние бюджета не названо: " + cost.statusHuman);
    assert.strictEqual(cost.rules.length, 2, "пороги предупреждения потерялись: " + cost.rules.length);
    assert.ok(/50% порога/.test(cost.rules[0].human), "процентный порог назван неверно: " + cost.rules[0].human);
    assert.ok(/каталоги: folder-1/.test(cost.filter), "фильтр по каталогу не назван: " + cost.filter);
    assert.deepStrictEqual(plain(budgetTrouble(cost)), [], "исправному бюджету приписана беда");

    const bare = budgetInfo({ id: "b", name: "без всего", balanceBudget: { amount: "500", startDate: "2026-01-01" }, status: "FINISHED" });
    assert.strictEqual(bare.kind, "balance", "вид бюджета «остаток» не распознан: " + bare.kind);
    const troubles = budgetTrouble(bare).join(" | ");
    assert.ok(/нет промежуточных порогов/.test(troubles), "бюджет без порогов не назван: " + troubles);
    assert.ok(/ВСЁ облако/.test(troubles), "бюджет без фильтра не назван: " + troubles);
    assert.ok(/закончился/.test(troubles), "закончившийся бюджет не назван: " + troubles);
    assert.strictEqual(budgetKind({}), "", "пустой бюджет получил вид");
    assert.strictEqual(periodHuman({ resetPeriod: "QUARTER" }), "каждый квартал", "квартальный период не назван");
    assert.strictEqual(budgetFilterHuman({}), "без фильтра — считает всё облако", "пустой фильтр назван неверно");
    assert.ok(/расход за период/.test(budgetLines(cost)[0]), "строки бюджета потеряли вид: " + budgetLines(cost)[0]);
  });

  await test("ycBilling: цена SKU берётся из ДЕЙСТВУЮЩЕЙ версии и ступени помечаются", () => {
    const ssd = skuInfo(stub.state.skus[0]);
    assert.strictEqual(ssd.unitPrice, 0.0192, "взята не действующая цена: " + ssd.unitPrice);
    assert.strictEqual(ssd.currency, "RUB", "валюта цены потерялась");
    assert.ok(/0,0192 ₽ за ГБ × час/.test(ssd.priceHuman), "цена не напечатана словами: " + ssd.priceHuman);
    assert.strictEqual(ssd.tiered, false, "одноступенчатая цена помечена ступенчатой");

    const core = skuInfo(stub.state.skus[1]);
    assert.strictEqual(core.tiered, true, "ступенчатая цена не помечена — человек решит, что так стоит всё");
    assert.strictEqual(core.steps, 2, "ступени не собраны: " + core.steps);
    const func = skuInfo(stub.state.skus[2]);
    assert.strictEqual(func.contract, true, "цена по договору не помечена");
    assert.ok(/миллион запросов/.test(func.pricingUnitHuman), "единица цены не названа словами: " + func.pricingUnitHuman);
    assert.strictEqual(pricingUnitHuman("core*hour"), "ядро × час", "единица «ядро×час» названа неверно");
    // Версия цены из будущего не должна перебивать действующую.
    const future = rateOf([
      { type: "STREET_PRICE", effectiveTime: daysAgo(1), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "1", currency: "RUB" }] }] },
      { type: "STREET_PRICE", effectiveTime: new Date(Date.now() + 86400000).toISOString(), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "9", currency: "RUB" }] }] },
    ]);
    assert.strictEqual(future.rates[0].unitPrice, 1, "цена из будущего принята за действующую: " + future.rates[0].unitPrice);
    // Если объявлены только будущие цены — показываем их, но не выдумываем ноль.
    const onlyFuture = rateOf([{ type: "STREET_PRICE", effectiveTime: new Date(Date.now() + 86400000).toISOString(), pricingExpressions: [{ rates: [{ startPricingQuantity: "0", unitPrice: "5", currency: "RUB" }] }] }]);
    assert.strictEqual(onlyFuture.rates[0].unitPrice, 5, "будущая цена не показана вовсе");
  });

  await test("ycBilling: поиск цены идёт по словам и не подсовывает всё подряд", () => {
    const all = stub.state.skus.concat(stub.state.skusPage2).map(skuInfo);
    // Совпадение по ДВУМ словам («быстрый диск») должно стоять выше совпадения по
    // одному («…диск»), но второе попадание — не ошибка: поиск ранжирует, а не режет.
    const quick = plain(matchSkus(all, "быстрый диск").map((s) => s.id));
    assert.strictEqual(quick[0], "sku-ssd", "по «быстрый диск» первой нашлась не та запись: " + quick.join(", "));
    assert.ok(quick.indexOf("sku-ssd") < quick.indexOf("sku-hdd"), "два слова не важнее одного: " + quick.join(", "));
    assert.deepStrictEqual(plain(matchSkus(all, "стандартный").map((s) => s.id)), ["sku-hdd"], "по «стандартный» найдено не то");
    assert.ok(matchSkus(all, "диск").length >= 2, "по «диск» нашлось меньше двух записей");
    assert.deepStrictEqual(plain(matchSkus(all, "хостинг-сайтов")), [], "на пустой запрос что-то нашлось");
    assert.deepStrictEqual(plain(matchSkus(all, "а")), [], "однобуквенный запрос что-то нашёл");
    // Название весит больше описания: «функции» должны идти перед тем, где слово
    // встретилось только в описании.
    const found = matchSkus(all, "функции");
    assert.strictEqual(found[0].id, "sku-func", "совпадение в названии не важнее описания");
  });

  console.log("\n[2] Модуль против подменённого облака: аккаунты, пороги, цены и хвосты");

  await test("ycBilling: аккаунты, услуги и пороги читаются из облака", async () => {
    stub.reset();
    const { billing } = mkBilling();
    const acc = await billing.accounts("oauth-1");
    assert.strictEqual(acc.length, 1, "аккаунт не прочитан: " + acc.length);
    assert.strictEqual(acc[0].balance, 1234.56, "баланс не разобран");
    const got = await billing.findAccount("oauth-1", "Основной счёт");
    assert.strictEqual(got.id, "dn2aaaa", "аккаунт не найден по имени");
    const one = await billing.account("oauth-1", "dn2aaaa");
    assert.strictEqual(one.id, "dn2aaaa", "аккаунт не прочитан по id");
    const svc = await billing.services("oauth-1");
    assert.ok(svc.some((s) => s.name === "Compute Cloud"), "услуги не прочитаны: " + JSON.stringify(svc));
    const buds = await billing.budgets("oauth-1", "dn2aaaa");
    assert.strictEqual(buds.length, 1, "пороги не прочитаны: " + buds.length);
    assert.strictEqual(buds[0].kind, "cost", "вид порога потерялся");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "чтение биллинга что-то изменило в облаке");
    // Биллинг не требует каталога: folderId в запросы не попадает вовсе.
    assert.ok(stub.calls.every((c) => c.url.indexOf("folderId") < 0 || c.url.indexOf("/compute/") >= 0 || c.url.indexOf("/vpc/") >= 0), "в запросы биллинга уехал каталог");
  });

  await test("ycBilling: несколько аккаунтов без ссылки — вопрос, а не угадывание", async () => {
    stub.reset();
    stub.state.extraAccounts.push({ id: "dn2bbbb", name: "Второй счёт", currency: "RUB", active: true, balance: "10" });
    const { billing } = mkBilling();
    await assert.rejects(() => billing.findAccount("oauth-1", ""), /несколько платёжных аккаунтов/i, "аккаунт угадан при двух доступных");
    const chosen = await billing.findAccount("oauth-1", "dn2bbbb");
    assert.strictEqual(chosen.id, "dn2bbbb", "названный аккаунт не найден");
    await assert.rejects(() => billing.findAccount("oauth-1", "нет-такого"), /Не нашёл платёжный аккаунт/, "несуществующий аккаунт прошёл");
  });

  await test("ycBilling: права объясняются словами, а не сырым отказом", async () => {
    stub.reset();
    stub.quiet.billing403 = true;
    const { billing } = mkBilling();
    const err = await billing.accounts("oauth-1").then(() => null, (e) => e);
    assert.ok(err, "403 не привёл к отказу");
    assert.ok(/billing\.viewer/.test(err.message), "в отказе нет роли, которая нужна: " + err.message);
    assert.ok(/ПЛАТЁЖНОМУ аккаунту/.test(err.message), "не сказано, что биллинг привязан к платёжному аккаунту: " + err.message);
    stub.quiet.billing403 = false;
    stub.quiet.billing404 = true;
    const e404 = await billing.accounts("oauth-1").then(() => null, (e) => e);
    assert.ok(/расхода?\b|расход/i.test(e404.message), "404 не объяснён тем, что расхода в API нет: " + e404.message);
    assert.ok(/консоли|Биллинг → Расходы/.test(e404.message), "404 не отправил в консоль: " + e404.message);
    stub.quiet.billing404 = false;
  });

  await test("ycBilling: цена ищется по живому каталогу, страницы читаются дальше первой", async () => {
    stub.reset();
    const { billing } = mkBilling();
    const r = await billing.priceSearch("oauth-1", { query: "стандартный диск" });
    assert.ok(r.total >= 1, "цена не найдена: " + r.total);
    // Совпадение в названии весит больше описания, поэтому первой идёт та запись,
    // у которой слова запроса есть в НАЗВАНИИ.
    assert.strictEqual(r.skus[0].id, "sku-hdd", "первой нашлась не та цена: " + r.skus[0].id);
    // Вторая страница каталога прочитана — иначе «стандартный диск» не нашёлся бы.
    const calls = stub.calls.filter((c) => c.url.indexOf("/billing/v1/skus") >= 0);
    assert.ok(calls.length >= 2, "каталог цен прочитан одной страницей: " + calls.length);
    assert.ok(calls.some((c) => c.url.indexOf("pageToken=") >= 0), "pageToken не передан во вторую страницу");
    assert.ok(/облако говорит СЕЙЧАС/i.test(r.lines.join(" ")), "нет оговорки про живые цены: " + r.lines.join(" | "));
    assert.ok(r.lines.join(" ").indexOf(String(costs.PRICED_AT)) >= 0, "не названа дата наших ориентиров: " + costs.PRICED_AT);
    // Размер диска из API приходит в БАЙТАХ, а тариф считается за гигабайт: одна
    // ошибка здесь превращает «диск 100 ГБ» в 371 миллиард рублей в месяц (такая
    // ошибка уже была — в инструменте машин, и её поймал этот набор).
    const bytePrice = /diskMonth\(([A-Za-z_][A-Za-z0-9_.]*\.)?size\s*,\s*[A-Za-z_][A-Za-z0-9_]*\)/;
    assert.ok(!bytePrice.test(TOOLS_SRC), "цена диска в инструменте машин считается по БАЙТАМ: счёт раздуется в миллиард раз");
    assert.ok(!bytePrice.test(BILLING_SRC), "цена диска в биллинге считается по БАЙТАМ: счёт раздуется в миллиард раз");
    assert.ok(/diskMonth\(d\.size \/ GB/.test(BILLING_SRC), "биллинг больше не переводит байты в гигабайты");
    const empty = await billing.priceSearch("oauth-1", { query: "телепорт" });
    assert.strictEqual(empty.total, 0, "по несуществующему слову что-то нашлось");
    assert.ok(/ничего не нашлось/.test(empty.lines.join(" ")), "пустой поиск не объяснён: " + empty.lines.join(" | "));
    await assert.rejects(() => billing.priceSearch("oauth-1", { query: "" }), /чью цену искать/, "пустой запрос цены ушёл в облако");
    assert.ok(BILLING_FALLBACK.indexOf("billing.api.cloud.yandex.net") > 0, "адрес биллинга потерян");
  });

  await test("ycBilling: хвосты считаются в деньгах по одному правилу", async () => {
    stub.reset();
    const { billing } = mkBilling();
    const l = await billing.leaks("oauth-1", "folder-1");
    const kinds = l.tails.map((t) => t.kind);
    for (const need of ["disk", "snapshot", "address", "oldSnapshot", "stoppedVm"]) {
      assert.ok(kinds.indexOf(need) >= 0, "в хвостах нет «" + need + "»: " + kinds.join(", "));
    }
    // Диск без машины: 100 ГБ HDD считается по тарифу диска, а не «на глаз».
    const disk = l.tails.find((t) => t.kind === "disk");
    assert.strictEqual(disk.name, "забытый-диск", "найден не тот диск: " + disk.name);
    assert.strictEqual(disk.month, costs.diskMonth(100, "network-hdd"), "цена диска разошлась с тарифом: " + disk.month);
    // Простаивающий адрес дороже работающего — цена берётся у простаивающего.
    const addr = l.tails.find((t) => t.kind === "address");
    assert.strictEqual(addr.month, costs.ipMonth({ publicIp: true }).idle, "цена простаивающего адреса разошлась с тарифом: " + addr.month);
    assert.ok(/84\.201\.9\.9/.test(addr.why), "в хвосте не назван сам адрес: " + addr.why);
    // Снимок удалённого диска и старый снимок живого — разные хвосты.
    assert.ok(l.tails.some((t) => t.kind === "snapshot" && /снимок-старого/.test(t.why)), "снимок удалённого диска не назван");
    assert.ok(l.tails.some((t) => t.kind === "oldSnapshot" && /снимок-до-обновления/.test(t.why)), "старый снимок живого диска не назван");
    assert.ok(!l.tails.some((t) => /снимок-вчера/.test(t.why)), "свежий снимок попал в хвосты — трогать его нельзя");
    assert.strictEqual(OLD_SNAPSHOT_DAYS, 90, "порог «старый снимок» изменился без причины: " + OLD_SNAPSHOT_DAYS);
    // Остановленная машина: платят её диски, и это сказано словами.
    const stopped = l.tails.find((t) => t.kind === "stoppedVm");
    assert.ok(/старый-сервер/.test(stopped.why), "остановленная машина не названа: " + stopped.why);
    assert.strictEqual(stopped.month, costs.diskMonth(50, "network-ssd"), "цена дисков остановленной машины посчитана неверно: " + stopped.month);
    // Работающая машина — не хвост, а текущий счёт, и она посчитана круглосуточно.
    assert.strictEqual(l.running.length, 1, "работающая машина не найдена: " + l.running.length);
    assert.strictEqual(l.running[0].month, costs.vmEstimate({ cores: 2, coreFraction: 20, memoryGb: 2, diskSizeGb: 20, diskTypeId: "network-ssd", publicIp: true }).scenarios[0].total, "цена работающей машины разошлась с тарифом: " + l.running[0].month);
    assert.ok(l.count === l.tails.length && l.total > 0, "итог по хвостам не посчитан: " + l.total);
    assert.strictEqual(l.total, costs.rub(l.tails.reduce((a, t) => a + t.month, 0)), "сумма хвостов не сходится с их ценами");
    const text = l.lines.join("\n");
    assert.ok(/Платные хвосты \(\d+\)/.test(text), "в отчёте нет заголовка про хвосты: " + text);
    assert.ok(/≈ .* ₽ в месяц/.test(text), "в отчёте нет цены за месяц");
    assert.ok(/Что делать:/.test(text), "в отчёте нет ответа «что делать» — тогда он бесполезен");
    assert.ok(/ycRegistry|ycStorage/.test(text), "не сказано, что образы реестра и бакеты считает свой инструмент");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "поиск хвостов что-то изменил в облаке");
  });

  await test("ycBilling: пустой каталог — это «хвостов нет», а не пустая строка", async () => {
    stub.reset();
    stub.state.disks = [{ id: "disk-1", name: "site-root", zoneId: "ru-central1-a", typeId: "network-ssd", size: String(20 * GB), instanceIds: ["epd-1"] }];
    stub.state.snapshots = [{ id: "snap-3", name: "снимок-вчера", diskSize: String(20 * GB), storageSize: String(10 * GB), sourceDiskId: "disk-1", createdAt: daysAgo(1) }];
    stub.state.addresses = [stub.state.addresses[0]];
    stub.state.instances = [stub.state.instances[0]];
    const { billing } = mkBilling();
    const l = await billing.leaks("oauth-1", "folder-1");
    assert.strictEqual(l.count, 0, "в чистом каталоге нашлись хвосты: " + l.count);
    assert.strictEqual(l.total, 0, "в чистом каталоге появились деньги: " + l.total);
    assert.ok(/Платных хвостов нет/.test(l.lines.join(" ")), "чистый каталог не назван словами: " + l.lines.join(" | "));
    assert.strictEqual(l.running.length, 1, "текущий счёт пропал: " + l.running.length);
    assert.ok(/Работает прямо сейчас/.test(l.lines.join(" ")), "не сказано, что машина платит прямо сейчас");
  });

  await test("ycBilling: обзор говорит про баланс, пороги и честно — про расход", async () => {
    stub.reset();
    const { billing } = mkBilling();
    const ov = await billing.overview("oauth-1", "folder-1");
    const text = ov.lines.join("\n");
    assert.ok(/Платёжных аккаунтов: 1/.test(text), "обзор не посчитал аккаунты: " + text);
    assert.ok(/баланс: 1 234,56 ₽/.test(text), "в обзоре нет баланса: " + text);
    assert.ok(/Порогов-бюджетов: 1/.test(text), "в обзоре нет порогов: " + text);
    assert.ok(/месячный лимит/.test(text), "в обзоре не назван бюджет");
    assert.ok(/Расход \(сумму счёта\) облако по API не отдаёт/.test(text), "обзор не сказал, что расхода в API нет: " + text);
    assert.ok(/Платные хвосты/.test(text), "в обзоре нет хвостов: " + text);
    assert.deepStrictEqual(plain(ov.troubles), [], "исправному состоянию приписаны беды: " + JSON.stringify(ov.troubles));
    assert.strictEqual(ov.billingError, "", "обзор сообщил об ошибке там, где её нет: " + ov.billingError);

    // Минус на балансе и отсутствие бюджетов — то, ради чего обзор и нужен.
    stub.reset();
    stub.quiet.balance = -500;
    const { billing: b2 } = mkBilling();
    const bad = await b2.overview("oauth-1", "folder-1");
    assert.ok(bad.troubles.some((t) => /в минусе/.test(t)), "минус на балансе не попал в беды: " + JSON.stringify(bad.troubles));
    assert.ok(/в минусе/.test(bad.lines.join("\n")), "минус не виден в строках");
  });

  await test("ycBilling: без бюджетов прямо сказано, что о перерасходе узнаешь по факту", async () => {
    stub.reset();
    stub.state.budgets = [];
    const { billing } = mkBilling();
    const ov = await billing.overview("oauth-1", "folder-1");
    const text = ov.lines.join("\n");
    assert.ok(/Порогов-бюджетов нет/.test(text), "отсутствие порогов не названо: " + text);
    assert.ok(/узнаешь по факту/.test(text), "не сказано, чем это грозит: " + text);
    assert.ok(/консоли/.test(text), "не сказано, где задать порог");
  });

  await test("ycBilling: недоступный биллинг не прячет хвосты", async () => {
    stub.reset();
    stub.quiet.billing403 = true;
    const { billing } = mkBilling();
    const ov = await billing.overview("oauth-1", "folder-1");
    assert.ok(/billing\.viewer/.test(ov.billingError), "отказ биллинга не объяснён: " + ov.billingError);
    assert.ok(/Биллинг недоступен/.test(ov.lines.join("\n")), "в обзоре нет честной строки про недоступный биллинг");
    // Главное: деньги, которые видно по каталогу, никуда не пропали.
    assert.ok(ov.leaks && ov.leaks.count > 0, "вместе с биллингом пропали и хвосты: " + JSON.stringify(ov.leaks && ov.leaks.count));
    assert.ok(/Платные хвосты/.test(ov.lines.join("\n")), "в обзоре пропал отчёт по хвостам");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "попытка обойти отказ что-то записала в облако");
    stub.quiet.billing403 = false;
  });

  await test("ycBilling: каталог и помощники проверяются ДО запроса", async () => {
    stub.reset();
    const { billing } = mkBilling();
    await assert.rejects(() => billing.leaks("oauth-1", ""), /каталог/, "поиск хвостов без каталога ушёл в облако");
    await assert.rejects(() => billing.budgets("oauth-1", ""), /платёжный аккаунт/, "список порогов без аккаунта ушёл в облако");
    assert.strictEqual(writeCalls(stub.calls).length, 0, "проверки не помешали запросам");
    // Модуль без собранного Compute честно отказывает, а не считает половину.
    const naked = createYcBilling({ fetchJson: yandex._fetchJson, endpoint: yandex.endpoint, getIamToken: yandex.getIamToken });
    await assert.rejects(() => naked.leaks("oauth-1", "folder-1"), /модуль Compute/, "биллинг без модуля машин посчитал хвосты");
    const empty = createYcBilling({});
    await assert.rejects(() => empty.accounts("oauth-1"), /помощники облака/, "модуль без помощников не сказал об этом");
  });

  console.log("\n[3] Инструмент агента ycBilling: только чтение и внятные отказы");

  await test("ycBilling: без подключения и без каталога отвечает честно", async () => {
    const noAuth = buildTools({ yandexOauthToken: "" });
    const out = await noAuth.tools.ycBilling({ action: "overview" }, {});
    assert.ok(/не подключён/.test(out) && /ycCosts/.test(out), "без подключения нет отказа с подсказкой про цены: " + out);
    const noFolder = buildTools({ ycFolderId: "" });
    const leaks = await noFolder.tools.ycBilling({ action: "leaks" }, {});
    assert.ok(/каталог/.test(leaks), "поиск хвостов без каталога не объяснён: " + leaks);
    const accounts = await noFolder.tools.ycBilling({ action: "accounts" }, {});
    assert.ok(/Платёжные аккаунты/.test(accounts), "баланс без каталога не читается, хотя каталог ему не нужен: " + accounts);
    const { tools } = buildTools();
    const bad = await tools.ycBilling({ action: "заплати" }, {});
    assert.ok(/неизвестное действие/.test(bad) && /price/.test(bad), "неизвестное действие не объяснено: " + bad);
    assert.ok(/только ЧИТАЕТ/.test(bad), "не сказано, что инструмент ничего не меняет: " + bad);
    const noQuery = await tools.ycBilling({ action: "price" }, {});
    assert.ok(/чью цену искать/.test(noQuery), "пустой поиск цены не объяснён: " + noQuery);
  });

  await test("ycBilling: обзор отвечает деньгами и хвостами, ничего не меняя", async () => {
    stub.reset();
    const { tools } = buildTools();
    const out = await tools.ycBilling({ action: "overview" }, {});
    assert.ok(/Деньги в Yandex Cloud/.test(out), "нет заголовка обзора: " + out);
    assert.ok(/баланс: 1 234,56 ₽/.test(out), "в обзоре нет баланса: " + out);
    assert.ok(/Расход \(сумму счёта\) облако по API не отдаёт/.test(out), "обзор не сказал про расход: " + out);
    assert.ok(/Платные хвосты/.test(out), "в обзоре нет хвостов: " + out);
    assert.ok(/Что дальше: цены/.test(out), "обзор не подсказал следующий шаг: " + out);

    const price = await tools.ycBilling({ action: "price", query: "быстрый диск" }, {});
    assert.ok(/0,0192 ₽ за ГБ × час/.test(price), "цена не показана: " + price);
    assert.ok(/ycCosts/.test(price), "не сказано, чем сверить цену с нашим ориентиром: " + price);

    const leaks = await tools.ycBilling({ action: "leaks" }, {});
    assert.ok(/забытый-диск/.test(leaks), "хвост не назван: " + leaks);
    assert.ok(/предложи пользователю снимок/.test(leaks), "не сказано, что перед удалением нужен снимок и согласие: " + leaks);
    assert.ok(/не удаляй/.test(leaks), "инструмент не запретил удалять самому: " + leaks);

    const budgets = await tools.ycBilling({ action: "budgets" }, {});
    assert.ok(/месячный лимит/.test(budgets), "пороги не показаны: " + budgets);
    const services = await tools.ycBilling({ action: "services" }, {});
    assert.ok(/Compute Cloud/.test(services), "услуги не показаны: " + services);
    // Ни одной изменяющей операции — и это проверяется по факту, а не по обещанию.
    assert.strictEqual(writeCalls(stub.calls).length, 0, "инструмент биллинга что-то изменил в облаке");
  });

  await test("ycBilling: порогов нет — сказано, что делать человеку", async () => {
    stub.reset();
    stub.state.budgets = [];
    const { tools } = buildTools();
    const out = await tools.ycBilling({ action: "budgets" }, {});
    assert.ok(/Порогов-бюджетов .* нет/.test(out), "отсутствие порогов не названо: " + out);
    assert.ok(/узнает по факту/.test(out), "не сказано, чем это грозит: " + out);
    assert.ok(/консоли/.test(out) && /id пользователя/.test(out), "не объяснено, почему бюджет нельзя создать по API: " + out);
  });

  console.log("\n[4] Проводка: канал, мост, схема, права и сторож");

  await test("ycBilling: канал yc:billing есть в мосте, окно его видит, оболочка собирает модуль", () => {
    assert.ok(/ipcMain\.handle\("yc:billing"/.test(IPC_SRC), "нет канала yc:billing");
    assert.ok(/ycBilling: \(args\) => ipcRenderer\.invoke\("yc:billing"/.test(PRELOAD_SRC), "окно не видит канал yc:billing");
    assert.ok(/const \{ createYcBilling \} = require\("\.\/yc-billing\.js"\)/.test(MAIN_SRC), "оболочка не подключает модуль биллинга");
    assert.ok(/const ycBilling = createYcBilling\(\{/.test(MAIN_SRC), "модуль биллинга не собран в оболочке");
    const reg = /registerYcIpc\(\{([\s\S]{0,400}?)\}\)/.exec(MAIN_SRC);
    assert.ok(reg && /\bycBilling\b/.test(reg[1]), "канал IPC не получает модуль биллинга");
    // «Что такое платный хвост» живёт в Compute: модулю обязаны передать машины и сеть.
    assert.ok(/const ycBilling = createYcBilling\(\{[\s\S]{0,400}?ycCompute,\n  ycVpc,/.test(MAIN_SRC), "биллинг собран без модулей машины и сети");
    assert.ok(/^  ycBilling,$/m.test(MAIN_SRC), "модуль биллинга не передан инструментам агента");
    assert.ok(/handle\("yc:billing"[\s\S]{0,3000}?ycBilling\.overview\(cfg\.oauth, cfg\.folderId/.test(IPC_SRC), "канал не зовёт обзор с каталогом");
    // Только чтение: в модуле нет ни одной изменяющей операции, и это проверяемо.
    assert.ok(BILLING_SRC.indexOf('"POST"') < 0 && BILLING_SRC.indexOf('"DELETE"') < 0 && BILLING_SRC.indexOf('"PATCH"') < 0, "в модуле биллинга появилась изменяющая операция");
    assert.ok(/"GET"/.test(BILLING_SRC), "модуль биллинга не ходит в облако вовсе");
  });

  await test("ycBilling: схема, группа «облако», промпт, права и справочник знают инструмент", () => {
    const at = SCHEMAS_SRC.indexOf('name: "ycBilling"');
    assert.ok(at > 0, "нет схемы инструмента в tool-schemas");
    const schema = SCHEMAS_SRC.slice(at, at + 6000);
    for (const part of ["action", "account", "query", "serviceId", "currency", "limit", 'required: ["action"]']) {
      assert.ok(schema.includes(part), "в схеме нет " + part);
    }
    assert.ok(/расход \(сумму счёта\) облако по API НЕ ОТДАЁТ/i.test(schema), "схема не предупреждает, что расхода в API нет");
    assert.ok(/billing\.viewer/.test(schema), "схема не называет роль для биллинга");
    assert.ok(/ТОЛЬКО читает/.test(schema), "схема не говорит, что инструмент ничего не меняет");

    const group = CORE_SRC.slice(CORE_SRC.indexOf('id: "cloud"'), CORE_SRC.indexOf('id: "cloud"') + 900);
    assert.ok(/ycBilling/.test(group), "инструмента нет в группе «облако» — модель его не увидит");
    const line = PROMPTS_SRC.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/ycBilling/.test(line), "инструмента нет в списке для модели");
    assert.ok(/ycBilling \(ДЕНЬГИ в облаке/.test(PROMPTS_SRC), "промпт не объясняет, зачем ycBilling");

    const capAt = POLICY_SRC.indexOf('cap: "cloud.read"');
    assert.ok(capAt > 0 && POLICY_SRC.slice(capAt, capAt + 460).includes('"ycBilling"'), "нет назначения cloud.read для ycBilling");
    assert.ok(/ycBilling/.test(GUIDE_SRC), "в yc.md нет ycBilling");
    assert.ok(/Расход облако по API не отдаёт/.test(GUIDE_SRC), "справочник не предупреждает про расход");
    assert.ok(/billing\.viewer/.test(GUIDE_SRC), "справочник не называет роль для биллинга");
    assert.ok(/порог.*не счёт|Порог-бюджет/.test(GUIDE_SRC), "справочник не объясняет, что порог — это предупреждение");
  });

  await test("ycBilling: сторож smoke знает канал, а набор стоит в цепочке npm test", () => {
    const smoke = read("test", "smoke.test.js");
    assert.ok(smoke.includes('"yc:functions", "yc:billing"'), "сторож не знает канал yc:billing");
    assert.ok(/каналов в мосте должно быть 27/.test(smoke), "сторож не пересчитал каналы");
    assert.ok(/["']ycBilling["']/.test(smoke), "сторож не знает инструмент ycBilling");
    assert.ok(String(PKG.scripts.test || "").indexOf("test/yc-billing.test.js") >= 0, "набора нет в цепочке npm test");
  });

  stub.server.close();
  process.env.AI_AGENT_YC_BASE = "";
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

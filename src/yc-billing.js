"use strict";

/* ── Биллинг: платёжный аккаунт, пороги и «за что мы платим» ──────────────────
   Зачем модуль. Приложение умело СОЗДАВАТЬ платные ресурсы и называть их цену
   ДО создания (yc-costs.js). Но на два вопроса человека оно не отвечало вовсе:
   «что с моими деньгами в облаке» и «за что я плачу, хотя мне это не нужно».
   Человек шёл за этим в чужую консоль — при том что половина ответа лежит в
   том же облаке, куда у приложения уже есть доступ.

   Что важно знать и не потерять при правке:

     • РАСХОДА (суммы счёта) в REST API НЕТ. В Billing API есть только четыре
       вещи: платёжный аккаунт (активность, валюта, БАЛАНС), БЮДЖЕТЫ (пороги,
       после которых приходит письмо), каталог УСЛУГ и каталог SKU с настоящими
       ценами. Детализация расходов живёт в консоли (Биллинг → Расходы) и в
       выгрузке в бакет; по API облако её не отдаёт. Поэтому обещать «покажу
       счёт» нельзя — модуль говорит это прямо и показывает то, что видно;
     • биллинг привязан к ПЛАТЁЖНОМУ АККАУНТУ, а не к каталогу: folderId тут не
       нужен вовсе, зато нужна роль billing.viewer. Без неё облако отвечает 403 —
       это самая частая причина «биллинг не работает», и отказ обязан объяснять
       это словами, а не показывать сырой JSON;
     • баланс — это НЕ расход: отрицательный баланс означает, что облако скоро
       остановит ресурсы. Это единственная цифра про деньги, которую сервис
       отдаёт честно, поэтому она выводится первой и с предупреждением;
     • цены из живого каталога SKU — проверка НАШИХ ориентиров. В yc-costs.js
       числа взяты из документации и помечены датой; если облако сейчас говорит
       другое, ориентиры устарели, и об этом надо сказать человеку, а не
       переписывать числа молча;
     • «платные хвосты» уже умеет искать Compute (paidLeftovers) — здесь они НЕ
       переписываются заново, а считаются в деньгах за месяц и дополняются тем,
       чего Compute не видит: остановленные машины (их диски всё равно платят),
       работающие круглосуточно (сколько это стоит в месяц) и снимки, которые
       никто не чистит;
     • ресурсы, за которые платят и о которых модуль знает по другим частям
       приложения (образы реестра, версии объектов в бакете), здесь только
       упоминаются со ссылкой на свой инструмент — своя копия чужого правила
       разошлась бы с оригиналом.

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcCompute и createYcFunctions).
   Тарифы берутся из yc-costs.js — одни на всех: иначе цифра в отчёте и цифра
   в оценке стоимости разъехались бы, и обе выглядели бы правдой. */

const costs = require("./yc-costs.js");

const BILLING_FALLBACK = "https://billing.api.cloud.yandex.net";

// Каталог SKU — это десятки тысяч записей. «Прочитать весь» значит минуты и
// мегабайты, поэтому поиск идёт страницами с честным потолком, а не «пока не
// кончится».
const SKU_PAGE_SIZE = 1000;
const SKU_MAX_PAGES = 12;

// Публичный адрес, который никто не занял, и снимки, которые никто не трогал:
// это две самые частые утечки, поэтому у них есть свои пороги «пора сказать».
const OLD_SNAPSHOT_DAYS = 90;

// Размеры из API приходят в БАЙТАХ, а тарифы считаются за гигабайт: одно место,
// где это переводится, чтобы «диск 100 ГБ» не стоил 371 миллиард рублей в месяц.
const GB = 1073741824;

const CURRENCIES = {
  RUB: { sign: "₽", name: "рубли" },
  USD: { sign: "$", name: "доллары" },
  KZT: { sign: "₸", name: "тенге" },
};

// ── Деньги ──────────────────────────────────────────────────────────────────

function currencyOf(code) {
  const c = String(code || "RUB").trim().toUpperCase();
  return CURRENCIES[c] ? c : "RUB";
}

function currencySign(code) {
  return CURRENCIES[currencyOf(code)].sign;
}

// «1234567.891» → «1 234 567,89 ₽». Разряды разделяем пробелом: в счёте на
// миллион глаз должен цепляться за цифру, а не считать нули.
function formatMoney(value, currency) {
  const n = Math.round((Number(value) || 0) * 100) / 100;
  const sign = currencySign(currency);
  const abs = Math.abs(n);
  const int = Math.floor(abs);
  const frac = Math.round((abs - int) * 100);
  const text = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "," + (frac < 10 ? "0" : "") + frac;
  return (n < 0 ? "−" : "") + text + " " + sign;
}

// Цена из каталога приходит строкой («0.01234567») и с копеечной точностью
// теряет смысл при округлении до копеек: показываем больше знаков, если они есть.
function formatRate(value, currency) {
  const n = Number(value) || 0;
  const sign = currencySign(currency);
  const text = Math.abs(n) >= 1 ? String(Math.round(n * 1000) / 1000).replace(".", ",") : String(Math.round(n * 1000000) / 1000000).replace(".", ",");
  return (n < 0 ? "−" : "") + text + " " + sign;
}

function balanceHuman(value, currency) {
  const n = Number(value) || 0;
  return formatMoney(n, currency) + (n < 0 ? " (в минусе)" : n === 0 ? " (счёт пуст)" : "");
}

// ── Платёжный аккаунт ───────────────────────────────────────────────────────

function billingAccountInfo(a) {
  const o = a || {};
  const created = String(o.createdAt || "");
  const ts = Date.parse(created);
  return {
    id: o.id || "",
    name: o.name || "",
    createdAt: created,
    ageDays: isFinite(ts) ? Math.floor((Date.now() - ts) / 86400000) : null,
    countryCode: o.countryCode || "",
    currency: currencyOf(o.currency),
    balance: Number(o.balance) || 0,
    balanceHuman: balanceHuman(o.balance, o.currency),
    active: o.active !== false,
  };
}

// Что не так с платёжным аккаунтом. Про деньги и про доступ — двумя разными
// строками: «аккаунт выключен» и «денег не хватает» чинятся по-разному.
function accountTrouble(a) {
  const out = [];
  if (!a) return out;
  if (!a.active) {
    out.push(
      "Платёжный аккаунт ВЫКЛЮЧЕН: облако остановит платные ресурсы (машины, базы, бакеты перестанут отвечать). Включить — в консоли: Биллинг → платёжный аккаунт."
    );
  }
  if (a.balance < 0) {
    out.push(
      "Баланс в минусе (" + formatMoney(a.balance, a.currency) + "): пока он не станет положительным, новые ресурсы не создадутся, а существующие могут остановить. Пополни счёт."
    );
  } else if (a.balance === 0) {
    out.push("Баланс нулевой (" + formatMoney(a.balance, a.currency) + "): хватит только на ресурсы внутри гранта. Проверь, не отключён ли платёжный порог.");
  }
  return out;
}

function accountLines(a) {
  if (!a) return ["Платёжных аккаунтов нет: облако не привязано к счёту."];
  const lines = [
    "Платёжный аккаунт" + (a.name ? " «" + a.name + "»" : "") + " · id " + a.id + " · " + a.currency,
    "  баланс: " + a.balanceHuman + " · состояние: " + (a.active ? "активен" : "ВЫКЛЮЧЕН") + (a.ageDays != null ? " · создан " + a.ageDays + " дн. назад" : ""),
  ];
  for (const t of accountTrouble(a)) lines.push("  ⚠ " + t);
  return lines;
}

// Выбор аккаунта: пустая ссылка + ровно один аккаунт = он; иначе — по id или
// имени. Больше одного без ссылки не угадываем: угадать чужой счёт дороже,
// чем спросить.
function pickAccount(list, ref) {
  const arr = list || [];
  const q = String(ref == null ? "" : ref).trim();
  if (!q) return arr.length === 1 ? arr[0] : null;
  return arr.find((a) => a.id === q) || arr.find((a) => a.name === q) || null;
}

// ── Бюджеты (пороги) ────────────────────────────────────────────────────────

// У бюджета ровно один из трёх видов: расход (деньги за период), потребление
// (количество) и баланс (остаток). Вид надо назвать словами: «порог 1000» без
// вида не значит ничего.
const BUDGET_KINDS = {
  costBudget: { kind: "cost", title: "расход за период", amountHuman: "порог расхода" },
  expenseBudget: { kind: "expense", title: "потребление", amountHuman: "порог потребления" },
  balanceBudget: { kind: "balance", title: "остаток на счёте", amountHuman: "минимальный остаток" },
};

function budgetSpec(b) {
  const o = b || {};
  for (const key of Object.keys(BUDGET_KINDS)) if (o[key]) return { key, spec: o[key] };
  return { key: "", spec: {} };
}

function budgetKind(b) {
  const found = budgetSpec(b);
  return found.key ? BUDGET_KINDS[found.key].kind : "";
}

function periodHuman(spec) {
  const s = spec || {};
  const reset = String(s.resetPeriod || "").toUpperCase();
  if (reset === "MONTHLY") return "каждый месяц";
  if (reset === "QUARTER") return "каждый квартал";
  if (reset === "ANNUALLY") return "каждый год";
  if (s.startDate) return "с " + s.startDate;
  return "период не задан";
}

function budgetFilterHuman(spec) {
  const f = (spec || {}).filter || {};
  const parts = [];
  if (Array.isArray(f.serviceIds) && f.serviceIds.length) parts.push("услуги: " + f.serviceIds.join(", "));
  for (const cf of f.cloudFoldersFilters || []) {
    parts.push("облако " + (cf.cloudId || "?") + (cf.folderIds && cf.folderIds.length ? " · каталоги: " + cf.folderIds.join(", ") : " · все каталоги"));
  }
  return parts.length ? parts.join("; ") : "без фильтра — считает всё облако";
}

function budgetInfo(b) {
  const o = b || {};
  const found = budgetSpec(o);
  const meta = found.key ? BUDGET_KINDS[found.key] : { kind: "", title: "вид не указан", amountHuman: "порог" };
  const amount = Number(found.spec.amount) || 0;
  const rules = (found.spec.thresholdRules || []).map((r) => ({
    type: String(r.type || "").toUpperCase(),
    amount: Number(r.amount) || 0,
    human: String(r.type || "").toUpperCase() === "PERCENT" ? r.amount + "% порога" : formatMoney(Number(r.amount) || 0, o.currency),
    users: (r.notificationUserAccountIds || []).length,
  }));
  return {
    id: o.id || "",
    name: o.name || "",
    createdAt: o.createdAt || "",
    billingAccountId: o.billingAccountId || "",
    kind: meta.kind,
    kindTitle: meta.title,
    amount,
    amountHuman: formatMoney(amount, o.currency),
    amountLabel: meta.amountHuman,
    period: periodHuman(found.spec),
    filter: budgetFilterHuman(found.spec),
    filtered: !!(found.spec.filter && ((found.spec.filter.serviceIds || []).length || (found.spec.filter.cloudFoldersFilters || []).length)),
    endDate: found.spec.endDate || "",
    status: String(o.status || "").toUpperCase(),
    statusHuman: String(o.status || "").toUpperCase() === "ACTIVE" ? "действует" : String(o.status || "").toUpperCase() === "FINISHED" ? "закончился" : String(o.status || "").toUpperCase() === "CREATING" ? "создаётся" : "состояние неизвестно",
    rules,
    notified: (found.spec.notificationUserAccountIds || []).length,
  };
}

// Что не так с порогом. Главное: бюджет без правил предупреждения — это цифра
// в панели, о которой узнаёшь, когда уже потратил.
function budgetTrouble(b) {
  const out = [];
  if (!b) return out;
  if (!b.rules.length) out.push("у бюджета нет промежуточных порогов: письмо придёт, только когда порог уже перейдён. Добавь предупреждение на 50% и 80%.");
  if (!b.filtered) out.push("бюджет считает ВСЁ облако: порог сработает от чужих ресурсов тоже. Если он про один каталог — задай фильтр.");
  if (b.status === "FINISHED") out.push("бюджет закончился: он больше ничего не стережёт.");
  return out;
}

function budgetLines(b) {
  if (!b) return ["Порогов-бюджетов нет."];
  const lines = [
    "Бюджет" + (b.name ? " «" + b.name + "»" : "") + " · " + b.kindTitle + " · " + b.amountLabel + " " + b.amountHuman,
    "  " + b.period + " · " + b.filter + " · " + b.statusHuman + (b.rules.length ? " · порогов предупреждения: " + b.rules.length : " · порогов предупреждения НЕТ"),
  ];
  for (const t of budgetTrouble(b)) lines.push("  ⚠ " + t);
  return lines;
}

// ── Каталог SKU: настоящие цены ─────────────────────────────────────────────

function pricingUnitHuman(unit) {
  const u = String(unit || "").trim();
  if (!u) return "единица не указана";
  const map = {
    "core*hour": "ядро × час",
    "gbyte*hour": "ГБ × час",
    "gbyte*month": "ГБ × месяц",
    "request": "запрос",
    "million*request": "миллион запросов",
    "instance*hour": "машина × час",
    "byte*month": "байт × месяц",
    "unit": "штука",
    "second": "секунда",
  };
  return map[u] || u.replace(/\*/g, " × ");
}

// Действующая версия цены: та, что уже вступила в силу и самая свежая из таких.
// Если все версии в будущем — берём самую раннюю: так отчёт не останется без
// цифры там, где цена объявлена заранее.
function rateOf(pricingVersions, atMs) {
  const list = (pricingVersions || []).filter(Boolean);
  if (!list.length) return null;
  const at = Number(atMs) || Date.now();
  const started = list
    .map((v) => ({ v, t: Date.parse(String(v.effectiveTime || "")) }))
    .filter((x) => isFinite(x.t) && x.t <= at)
    .sort((a, b) => b.t - a.t);
  const chosen = started.length ? started[0] : list.map((v) => ({ v, t: Date.parse(String(v.effectiveTime || "")) })).sort((a, b) => (isFinite(a.t) ? a.t : 0) - (isFinite(b.t) ? b.t : 0))[0];
  const version = chosen && chosen.v ? chosen.v : list[0];
  const exprs = version.pricingExpressions || [];
  const rates = (exprs[0] && exprs[0].rates) || [];
  return {
    type: String(version.type || "").toUpperCase(),
    contract: String(version.type || "").toUpperCase() === "CONTRACT_PRICE",
    effectiveTime: version.effectiveTime || "",
    rates: rates.map((r) => ({
      from: Number(r.startPricingQuantity) || 0,
      unitPrice: Number(r.unitPrice) || 0,
      currency: currencyOf(r.currency),
    })),
  };
}

function skuInfo(s) {
  const o = s || {};
  const rate = rateOf(o.pricingVersions);
  const first = rate && rate.rates.length ? rate.rates[0] : null;
  return {
    id: o.id || "",
    name: o.name || "",
    description: o.description || "",
    serviceId: o.serviceId || "",
    pricingUnit: o.pricingUnit || "",
    pricingUnitHuman: pricingUnitHuman(o.pricingUnit),
    rates: (rate && rate.rates) || [],
    steps: (rate && rate.rates.length) || 0,
    unitPrice: first ? first.unitPrice : null,
    currency: first ? first.currency : "RUB",
    priceHuman: first ? formatRate(first.unitPrice, first.currency) + " за " + pricingUnitHuman(o.pricingUnit) : "цена не объявлена",
    contract: !!(rate && rate.contract),
    effectiveTime: (rate && rate.effectiveTime) || "",
    // Ступенчатая цена (первые N единиц дешевле) — её нельзя показывать одной
    // цифрой: человек решит, что так стоит всё.
    tiered: !!rate && rate.rates.length > 1,
  };
}

function words(query) {
  return String(query == null ? "" : query)
    .toLowerCase()
    .replace(/[^a-zа-яё0-9+\u00a0-\u00ff]+/gi, " ")
    .split(" ")
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

// Поиск по каталогу: слова запроса ищутся в названии и описании. Чем больше
// слов совпало и чем короче название — тем ближе находка (иначе «диск» найдётся
// в описании половины каталога).
function matchSkus(skus, query, limit) {
  const ws = words(query);
  if (!ws.length) return [];
  const scored = [];
  for (const s of skus || []) {
    const name = String(s.name || "").toLowerCase();
    const desc = String(s.description || "").toLowerCase();
    let score = 0;
    for (const w of ws) {
      if (name.indexOf(w) >= 0) score += 3;
      else if (desc.indexOf(w) >= 0) score += 1;
    }
    if (!score) continue;
    scored.push({ sku: s, score: score * 100 - Math.min(name.length, 99) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 8).map((x) => x.sku);
}

// ── Платные хвосты в деньгах ────────────────────────────────────────────────

function diskOf(disks, id) {
  return (disks || []).find((d) => d.id === id) || null;
}

// Один хвост = одна строка отчёта: что это, сколько стоит в месяц и что с ним
// делать. Без третьего пункта отчёт бесполезен — человек и так знает, что диск
// без машины лишний, ему нужен ответ «что нажать».
function tail(kind, item, monthRb, why, todo) {
  return {
    kind,
    id: (item && item.id) || "",
    name: (item && (item.name || item.address)) || "",
    month: costs.rub(monthRb || 0),
    monthHuman: costs.money(monthRb || 0),
    why,
    todo,
  };
}

// ── Модуль ─────────────────────────────────────────────────────────────────

function createYcBilling(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError = typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);
  // Модули машины и сети: «что такое платный хвост» считается в ОДНОМ месте
  // (ycCompute.paidLeftovers), иначе две копии правила разойдутся.
  const compute = api.ycCompute || null;
  const vpc = api.ycVpc || null;

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("Биллинг: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function base(serviceId, fallback) {
    const b = typeof api.endpoint === "function" ? await api.endpoint(serviceId) : "";
    return b || fallback;
  }

  // Отказы биллинга переводим на человеческий: 403 здесь означает не «сломалось»,
  // а «нет роли», и это ровно то, что надо сказать человеку.
  function explain(e) {
    const status = Number(e && e.status) || 0;
    if (status === 403) {
      return (
        "У доступа нет прав на биллинг. Биллинг привязан к ПЛАТЁЖНОМУ аккаунту, а не к каталогу, и требует роль billing.viewer: " +
        "попроси владельца облака выдать её (или посмотри баланс и расходы в консоли: Биллинг → платёжный аккаунт)."
      );
    }
    if (status === 404) {
      return (
        "Billing API по этому пути ничего не знает. У него нет методов про расход: он умеет только платёжные аккаунты, бюджеты, " +
        "услуги и каталог SKU с ценами. Сумма счёта — в консоли (Биллинг → Расходы) или в выгрузке детализации в бакет."
      );
    }
    return serviceError(e);
  }

  async function call(oauthToken, method, path, body, timeoutMs) {
    requireApi();
    const b = await base("billing", BILLING_FALLBACK);
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
      const err = new Error(explain(e));
      err.status = e && e.status;
      err.raw = (e && e.message) || "";
      throw err;
    }
  }

  // ── чтение ────────────────────────────────────────────────────────────────

  async function accounts(oauthToken) {
    const j = await call(oauthToken, "GET", "/billing/v1/billingAccounts?pageSize=1000");
    const list = (j && j.billingAccounts) || [];
    return list.map(billingAccountInfo);
  }

  async function account(oauthToken, id) {
    const q = String(id || "").trim();
    if (!q) throw new Error("Не указан платёжный аккаунт (список: ycBilling { action: \"accounts\" }).");
    return billingAccountInfo(await call(oauthToken, "GET", "/billing/v1/billingAccounts/" + encodeURIComponent(q)));
  }

  async function findAccount(oauthToken, ref) {
    const list = await accounts(oauthToken);
    const got = pickAccount(list, ref);
    if (got) return got;
    if (String(ref || "").trim()) {
      throw new Error("Не нашёл платёжный аккаунт «" + ref + "» среди доступных: " + list.map((a) => a.id).join(", "));
    }
    throw new Error(
      "Доступно несколько платёжных аккаунтов (" + list.length + "): назови нужный — ycBilling { action: \"account\", account: \"" +
        (list[0] && list[0].id) + "\" }."
    );
  }

  async function services(oauthToken) {
    const j = await call(oauthToken, "GET", "/billing/v1/services?pageSize=1000");
    return ((j && j.services) || []).map((s) => ({ id: s.id || "", name: s.name || "", description: s.description || "" }));
  }

  // Страницы каталога SKU идут одна за другой: цена «сейчас» объявлена у каждого
  // SKU, но чтобы найти нужный по названию, надо прочитать несколько страниц.
  async function skus(oauthToken, o) {
    const opt = o || {};
    const currency = currencyOf(opt.currency);
    const params = ["currency=" + currency, "pageSize=" + SKU_PAGE_SIZE];
    if (opt.billingAccountId) params.push("billingAccountId=" + encodeURIComponent(opt.billingAccountId));
    if (opt.serviceId) params.push("filter=" + encodeURIComponent('serviceId="' + opt.serviceId + '"'));
    const maxPages = Math.max(1, Math.min(Number(opt.maxPages) || SKU_MAX_PAGES, 40));
    const out = [];
    let pageToken = "";
    for (let i = 0; i < maxPages; i++) {
      const path = "/billing/v1/skus?" + params.concat(pageToken ? ["pageToken=" + encodeURIComponent(pageToken)] : []).join("&");
      const j = await call(oauthToken, "GET", path, undefined, 40000);
      for (const s of (j && j.skus) || []) out.push(skuInfo(s));
      pageToken = (j && j.nextPageToken) || "";
      if (!pageToken) break;
    }
    return out;
  }

  async function budgets(oauthToken, accountId) {
    const q = String(accountId || "").trim();
    if (!q) throw new Error("Не указан платёжный аккаунт для списка бюджетов.");
    const j = await call(oauthToken, "GET", "/billing/v1/billingAccounts/" + encodeURIComponent(q) + "/budgets?pageSize=1000");
    return ((j && j.budgets) || []).map(budgetInfo);
  }

  // ── цена по названию ──────────────────────────────────────────────────────
  // «Сколько сейчас стоит ГБ×час быстрого диска» — вопрос, на который до сих пор
  // отвечала только страница документации. Здесь отвечает сам облако.
  async function priceSearch(oauthToken, o) {
    const opt = o || {};
    const query = String(opt.query || opt.q || opt.what || "").trim();
    if (!query) throw new Error("Не сказано, чью цену искать: ycBilling { action: \"price\", query: \"быстрый диск\" }.");
    const currency = currencyOf(opt.currency);
    const all = await skus(oauthToken, { currency, billingAccountId: opt.billingAccountId, serviceId: opt.serviceId, maxPages: opt.maxPages });
    // Внимание: skus() уже отдаёт РАЗОБРАННЫЕ SKU (с ценой). Повторный разбор
    // здесь означал бы «цена не объявлена» — версий цены в готовой записи нет.
    const found = matchSkus(all, query, opt.limit || 8);
    const lines = [];
    if (!found.length) {
      lines.push("В прочитанной части каталога цен ничего не нашлось по «" + query + "» (прочитано " + all.length + " SKU). Попробуй другое слово: «диск», «ядро», «память», «функция».");
    }
    for (const s of found) {
      lines.push("• " + (s.name || s.id) + " — " + s.priceHuman + (s.tiered ? " (цена ступенчатая: первая ступень)" : ""));
      if (s.description) lines.push("    " + s.description.slice(0, 200));
      lines.push("    услуга " + s.serviceId + (s.contract ? " · цена по договору" : " · обычная цена") + (s.effectiveTime ? " · действует с " + s.effectiveTime.slice(0, 10) : ""));
    }
    lines.push(
      "Наши ориентиры в оценке стоимости посчитаны по документации от " +
        costs.PRICED_AT +
        ". Здесь — то, что облако говорит СЕЙЧАС" +
        (currency === "RUB" ? "" : " (валюта " + currency + ")") +
        ": расхождение означает, что ориентиры устарели, и человеку надо сказать об этом прямо."
    );
    return { query, currency, total: found.length, read: all.length, skus: found, lines, message: "Найдено цен: " + found.length + "." };
  }

  // ── хвосты ────────────────────────────────────────────────────────────────

  async function leaks(oauthToken, folderId) {
    const folder = String(folderId || "").trim();
    if (!folder) throw new Error("Не указан каталог для поиска платных хвостов.");
    if (!compute) throw new Error("Биллингу не передан модуль Compute: без него не из чего собрать платные хвосты.");
    const instances = await compute.instances(oauthToken, folder);
    const disks = await compute.disks(oauthToken, folder);
    const snapshots = await compute.snapshots(oauthToken, folder);
    const addresses = vpc ? await vpc.addresses(oauthToken, folder).catch(() => []) : [];
    // Правило «что такое хвост» живёт в Compute — берём его готовым.
    const orphan = compute.paidLeftovers({ instances, disks, snapshots, addresses });

    const tails = [];
    for (const d of orphan.disks) {
      tails.push(
        tail(
          "disk",
          d,
          // Размер из API — БАЙТЫ, а тариф считается за гигабайт.
          costs.diskMonth(d.size / GB, d.typeId),
          "диск " + (d.name || d.id) + " (" + d.sizeHuman + ", " + d.typeId + ") не привязан ни к одной машине, а диск тарифицируется каждый час — и после удаления машины тоже",
          "сделай снимок, если данные нужны (ycCompute: snapshot), и удали диск (ycCompute: deletedisk)"
        )
      );
    }
    for (const s of orphan.snapshots) {
      tails.push(
        tail(
          "snapshot",
          s,
          costs.rub((Number(s.storageSize) / GB || 0) * costs.SNAPSHOT_GB_HOUR * costs.HOURS_MONTH),
          "снимок " + (s.name || s.id) + " сделан с диска, которого в каталоге больше нет" + (s.ageDays != null ? " (возраст " + s.ageDays + " дн.)" : ""),
          "удали, если данные не нужны: ycCompute: cleansnapshots (сначала покажет, что удалит)"
        )
      );
    }
    for (const a of orphan.addresses) {
      const ip = costs.ipMonth({ publicIp: true });
      tails.push(
        tail(
          "address",
          a,
          ip.idle,
          "статический адрес " + (a.address || a.name) + " никто не занял, а простаивающий адрес дороже работающего",
          "привяжи его к машине или освободи (ycVpc: release) — иначе платишь за пустоту"
        )
      );
    }

    // Снимки, которые никто не чистит: источник ещё есть, но снимку месяцы.
    const orphanIds = new Set(orphan.snapshots.map((s) => s.id));
    for (const s of snapshots) {
      if (orphanIds.has(s.id)) continue;
      if (s.ageDays == null || s.ageDays < OLD_SNAPSHOT_DAYS) continue;
      tails.push(
        tail(
          "oldSnapshot",
          s,
          costs.rub((Number(s.storageSize) / GB || 0) * costs.SNAPSHOT_GB_HOUR * costs.HOURS_MONTH),
          "снимок " + (s.name || s.id) + " живёт " + s.ageDays + " дней и всё это время хранится",
          "проверь, нужен ли он ещё: хранение снимков — " + costs.money(costs.rub(costs.SNAPSHOT_GB_HOUR * costs.HOURS_MONTH)) + " за ГБ в месяц (ycCompute: cleansnapshots, keep: 2)"
        )
      );
    }

    // Остановленные машины: времени работы нет, а диски идут. Это не «хвост»
    // в смысле мусора — это объяснение, почему счёт не упал до нуля.
    for (const i of instances) {
      if (i.running) continue;
      let month = 0;
      const parts = [];
      const boot = diskOf(disks, i.bootDisk && i.bootDisk.diskId);
      if (boot) {
        month += costs.diskMonth(boot.size / GB, boot.typeId);
        parts.push("диск " + (boot.name || boot.sizeHuman) + " " + boot.sizeHuman);
      }
      for (const ref of i.secondaryDisks || []) {
        const d = diskOf(disks, ref.diskId);
        if (!d) continue;
        month += costs.diskMonth(d.size / GB, d.typeId);
        parts.push("диск " + (d.name || d.sizeHuman) + " " + d.sizeHuman);
      }
      if (!parts.length) continue;
      tails.push(
        tail(
          "stoppedVm",
          i,
          month,
          "машина «" + i.name + "» остановлена, но её диски (" + parts.join(", ") + ") тарифицируются всегда",
          "если машина больше не нужна — сделай снимок и удали её вместе с дисками (ycCompute: delete)"
        )
      );
    }

    // Работающие машины: это не хвост, а текущий счёт. Но «сколько уходит в
    // месяц» человек обычно не считал ни разу.
    const running = [];
    for (const i of instances) {
      if (!i.running) continue;
      const boot = diskOf(disks, i.bootDisk && i.bootDisk.diskId);
      const est = costs.vmEstimate({
        cores: i.cores,
        coreFraction: i.coreFraction,
        memoryGb: i.memory ? i.memory / GB : undefined,
        diskSizeGb: boot ? boot.size / GB : undefined,
        diskTypeId: boot ? boot.typeId : undefined,
        publicIp: i.hasExternalIp,
      });
      const full = (est.scenarios || []).find((s) => s.hours === costs.HOURS_MONTH) || { total: est.approxMonth };
      running.push({ instance: i, month: full.total, monthHuman: costs.money(full.total), hours: full.hours || costs.HOURS_MONTH });
    }
    running.sort((a, b) => b.month - a.month);

    const total = costs.rub(tails.reduce((a, t) => a + t.month, 0));
    const live = costs.rub(running.reduce((a, r) => a + r.month, 0));
    const lines = [];
    if (!tails.length) {
      lines.push("Платных хвостов нет: каждый диск привязан к машине, снимков удалённых дисков и простаивающих адресов нет.");
    } else {
      lines.push("Платные хвосты (" + tails.length + ") — это то, за что платят, хотя уже не нужно, ≈ " + costs.money(total) + " в месяц:");
      for (const t of tails.slice().sort((a, b) => b.month - a.month)) {
        lines.push("• " + t.why + " — ≈ " + t.monthHuman + " в месяц. Что делать: " + t.todo + ".");
      }
    }
    if (running.length) {
      lines.push("Работает прямо сейчас (это текущий счёт, а не мусор), круглосуточно ≈ " + costs.money(live) + " в месяц:");
      for (const r of running) lines.push("• машина «" + r.instance.name + "» — ≈ " + r.monthHuman + " в месяц, если не останавливать.");
    }
    if (!running.length && !tails.length) lines.push("Платных ресурсов в каталоге не видно.");
    lines.push(
      "Образы реестра и версии объектов в бакете тоже платят за хранение, но считает их свой инструмент: ycRegistry { action: \"images\" } и ycStorage { action: \"list\" }."
    );
    return { folderId: folder, tails, running, total, live, count: tails.length, lines, message: "Хвостов: " + tails.length + " на " + costs.money(total) + " в месяц." };
  }

  // ── обзор ─────────────────────────────────────────────────────────────────

  async function overview(oauthToken, folderId, o) {
    const opt = o || {};
    const out = { accounts: [], account: null, budgets: [], troubles: [], lines: [], leaks: null, billingError: "" };

    // Биллинг может быть недоступен (нет роли) — это НЕ повод не показывать
    // хвосты: они живут в каталоге и читаются другими правами.
    try {
      out.accounts = await accounts(oauthToken);
      out.account = pickAccount(out.accounts, opt.account);
      if (out.account && !opt.account && out.accounts.length > 1) {
        out.troubles.push(
          "Платёжных аккаунтов несколько (" + out.accounts.length + "): баланс показан по «" + out.account.name + "», а расходы и пороги надо смотреть у каждого отдельно."
        );
      }
      if (out.account) out.budgets = await budgets(oauthToken, out.account.id).catch((e) => {
        out.troubles.push("Пороги-бюджеты не прочитались: " + ((e && e.message) || e));
        return [];
      });
    } catch (e) {
      out.billingError = (e && e.message) || String(e);
    }

    if (folderId) out.leaks = await leaks(oauthToken, folderId);

    const lines = [];
    if (out.billingError) {
      lines.push("Биллинг недоступен: " + out.billingError);
    } else if (!out.accounts.length) {
      lines.push("Платёжных аккаунтов нет: облако не привязано к счёту, платные ресурсы создавать некуда.");
    } else {
      lines.push("Платёжных аккаунтов: " + out.accounts.length + ".");
      if (out.account) lines.push.apply(lines, accountLines(out.account));
      for (const a of accountTrouble(out.account)) out.troubles.push(a);
      if (!out.budgets.length) {
        lines.push(
          "Порогов-бюджетов нет: письмо о превышении не придёт, о перерасходе узнаешь по факту. Пороги задаются в консоли (Биллинг → Бюджеты) — по API их создать нельзя без id пользователя для уведомлений."
        );
      } else {
        lines.push("Порогов-бюджетов: " + out.budgets.length + ".");
        for (const b of out.budgets) {
          lines.push.apply(lines, budgetLines(b));
          for (const t of budgetTrouble(b)) out.troubles.push("бюджет «" + (b.name || b.id) + "»: " + t);
        }
      }
      lines.push(
        "Расход (сумму счёта) облако по API не отдаёт: точные цифры — в консоли (Биллинг → Расходы) или в выгрузке детализации в бакет. Здесь видно баланс, пороги и то, за что платят по факту."
      );
    }
    if (out.leaks) lines.push.apply(lines, out.leaks.lines);

    out.lines = lines;
    out.message = out.billingError
      ? "Биллинг недоступен, хвосты посчитаны по каталогу."
      : "Платёжных аккаунтов: " + out.accounts.length + " · порогов: " + out.budgets.length + (out.leaks ? " · хвостов: " + out.leaks.count : "") + ".";
    return out;
  }

  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 90000);
    return op || {};
  }

  return {
    // чтение
    accounts,
    account,
    findAccount,
    services,
    skus,
    budgets,
    priceSearch,
    leaks,
    overview,
    // Помощники наружу: их читают инструмент агента, канал панели и набор
    // тестов — значения держим рядом с методами, которые их используют.
    run,
    explain,
    accountLines,
    accountTrouble,
    budgetLines,
    budgetTrouble,
    budgetInfo,
    skuInfo,
    matchSkus,
    pricingUnitHuman,
    formatMoney,
    BILLING_FALLBACK,
    SKU_PAGE_SIZE,
    SKU_MAX_PAGES,
    OLD_SNAPSHOT_DAYS,
    CURRENCIES,
    BUDGET_KINDS,
  };
}

module.exports = {
  createYcBilling,
  // деньги
  currencyOf,
  currencySign,
  formatMoney,
  formatRate,
  balanceHuman,
  // платёжный аккаунт
  billingAccountInfo,
  accountTrouble,
  accountLines,
  pickAccount,
  // бюджеты
  budgetSpec,
  budgetKind,
  periodHuman,
  budgetFilterHuman,
  budgetInfo,
  budgetTrouble,
  budgetLines,
  // каталог цен
  pricingUnitHuman,
  rateOf,
  skuInfo,
  matchSkus,
  // хвосты и константы
  tail,
  BILLING_FALLBACK,
  SKU_PAGE_SIZE,
  SKU_MAX_PAGES,
  OLD_SNAPSHOT_DAYS,
  CURRENCIES,
  BUDGET_KINDS,
};

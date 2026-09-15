"use strict";

/* ── Стоимость ресурсов Yandex Cloud: ориентир ДО создания ─────────────────────
   Зачем модуль. Агент умеет создавать облачные ресурсы и выкатывать контейнеры,
   но до сих пор не знал, сколько это стоит. Пользователь узнавал цену из счёта.
   Здесь собраны ТОЛЬКО проверенные тарифы: каждое число взято из официальной
   документации (источник указан рядом) и помечено датой. Придуманных цен нет —
   если тариф не подтверждён, числа не будет вообще, будет ссылка на прайс.

   Что даёт:
   - estimate(key, params) — оценка по ресурсу до создания (сколько и за что);
   - estimateContainer({...}) — честная арифметика по формуле из документации,
     включая бесплатный пакет и «сколько будет при постоянной работе»;
   - needsConfirm(est) — платное нельзя создавать агентом без явного согласия.

   Важно: это ОРИЕНТИР, а не счёт. Регион, валюта и договор у всех разные,
   поэтому рядом всегда ссылка на калькулятор и прайс-лист.

   Модуль не требует electron и тестируется в plain-node.
*/

// В документации Yandex Cloud месяц считается как 720 часов — берём ту же
// константу, чтобы наши оценки сходились с их примерами расчёта.
const HOURS_MONTH = 720;
// Параметры ревизии по умолчанию — из движка деплоя (одна правда на двоих).
const revisionDefaults = (() => {
  try {
    return require("./deploy-engine.js").REVISION_DEFAULTS;
  } catch (e) {
    return { memoryMb: 256, cores: 1 };
  }
})();
const PRICED_AT = "сентябрь 2026";

const PRICE_LIST = "https://yandex.cloud/ru/price-list";
const CALCULATOR = "https://yandex.cloud/ru/prices";

const SOURCES = {
  containers: "https://yandex.cloud/ru/docs/serverless-containers/pricing",
  registry: "https://yandex.cloud/ru/docs/container-registry/pricing",
  storage: "https://yandex.cloud/ru/docs/storage/pricing",
  dns: "https://yandex.cloud/ru/docs/dns/pricing",
  lockbox: "https://yandex.cloud/ru/docs/lockbox/pricing",
  ydb: "https://yandex.cloud/ru/docs/ydb/pricing/serverless",
  vpc: "https://yandex.cloud/ru/docs/vpc/pricing",
};

// Тарифы региона Россия, с НДС (₽). Меняются — при обновлении править только тут.
const UNIT = {
  // Serverless Containers: 3,79 ₽ за ГБ×час RAM, 5,69 ₽ за vCPU×час, 18,97 ₽ за млн вызовов
  containerRamGbHour: 3.79,
  containerVcpuHour: 5.69,
  containerPerMillionCalls: 18.97,
  containerFreeRamGbHour: 10,
  containerFreeVcpuHour: 5,
  containerFreeCalls: 1_000_000,
  // Container Registry: 0,004575 ₽ за ГБ×час хранения
  registryGbHour: 0.004575,
  // Object Storage, стандартное хранилище: 0,0033 ₽ за ГБ×час, 1 ГБ/мес бесплатно
  storageGbHour: 0.0033,
  storageFreeGbHour: 720,
  // Cloud DNS: 0,0592 ₽ за зону×час, 37,94 ₽ за млн авторитетных запросов
  dnsZoneHour: 0.0592,
  dnsAuthPerMillion: 37.94,
  // Lockbox: 0,0274 ₽ за версию секрета×час
  lockboxVersionHour: 0.0274,
  // Исходящий трафик: первые 100 ГБ в месяц бесплатно
  egressFreeGb: 100,
  egressPerGb: 1.42,
};

const LEVELS = {
  free: { label: "бесплатно", order: 0 },
  low: { label: "копейки", order: 1 },
  medium: { label: "заметно", order: 2 },
  high: { label: "дорого", order: 3 },
};

// ── Деньги ────────────────────────────────────────────────────────────────────
function rub(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function money(n) {
  return rub(n).toFixed(2).replace(".", ",") + " ₽";
}

// ГБ×час → рубли за месяц с учётом бесплатного пакета.
function gbMonth(gb, perGbHour, freeGbHour) {
  const hours = Number(gb) || 0;
  return rub(Math.max(0, hours * HOURS_MONTH - (freeGbHour || 0)) * perGbHour);
}

// ── Контейнеры: по формуле из документации ────────────────────────────────────
// Стоимость = 3,79 × RAM(ГБ) × время(ч) + 5,69 × ядра × время(ч) + 18,97 × млн вызовов,
// минус бесплатный пакет (10 ГБ×час RAM, 5 vCPU×час, 1 млн вызовов).
// Считаем ровно так, как считает сам Yandex Cloud: только время выполнения вызовов.
function containerCost(o) {
  const opt = o || {};
  const memoryMb = Number(opt.memoryMb) > 0 ? Number(opt.memoryMb) : revisionDefaults.memoryMb;
  const cores = Number(opt.cores) > 0 ? Number(opt.cores) : revisionDefaults.cores;
  const calls = Number(opt.calls) >= 0 ? Number(opt.calls) : 100000;
  const msPerCall = Number(opt.msPerCall) > 0 ? Number(opt.msPerCall) : 150;
  const hours = (calls * msPerCall) / 3600000;
  const ramGbHours = (memoryMb / 1024) * hours;
  const vcpuHours = cores * hours;
  const ram = rub(Math.max(0, ramGbHours - UNIT.containerFreeRamGbHour) * UNIT.containerRamGbHour);
  const cpu = rub(Math.max(0, vcpuHours - UNIT.containerFreeVcpuHour) * UNIT.containerVcpuHour);
  const request = rub(Math.max(0, calls / 1000000 - 1) * UNIT.containerPerMillionCalls);
  return {
    memoryMb, cores, calls, msPerCall, hours: Math.round(hours * 100) / 100,
    ram, cpu, request, total: rub(ram + cpu + request),
    rows: [
      { label: "память " + memoryMb + " МБ × " + fmtHours(hours) + " работы", value: ram, unit: "ГБ×час" },
      { label: "vCPU " + cores + " × " + fmtHours(hours) + " работы", value: cpu, unit: "vCPU×час" },
      { label: "вызовы " + fmtCalls(calls), value: request, unit: "млн вызовов" },
    ],
  };
}

function fmtHours(h) {
  if (h < 1) return (Math.round(h * 1000) / 1000).toString().replace(".", ",") + " ч";
  return (Math.round(h * 10) / 10).toString().replace(".", ",") + " ч";
}

function fmtCalls(c) {
  if (c >= 1000000) return (Math.round((c / 1000000) * 10) / 10).toString().replace(".", ",") + " млн";
  if (c >= 1000) return Math.round(c / 1000) + " тыс";
  return String(c);
}

// Постоянная работа контейнера: 720 часов без остановки — так выглядит
// «подготовленный экземпляр» и любая попытка держать сервис включённым всегда.
function idleMonth(o) {
  const opt = o || {};
  const memoryMb = Number(opt.memoryMb) > 0 ? Number(opt.memoryMb) : revisionDefaults.memoryMb;
  const cores = Number(opt.cores) > 0 ? Number(opt.cores) : revisionDefaults.cores;
  const ramGbHours = (memoryMb / 1024) * HOURS_MONTH;
  const vcpuHours = cores * HOURS_MONTH;
  const ram = rub(Math.max(0, ramGbHours - UNIT.containerFreeRamGbHour) * UNIT.containerRamGbHour);
  const cpu = rub(Math.max(0, vcpuHours - UNIT.containerFreeVcpuHour) * UNIT.containerVcpuHour);
  return { memoryMb, cores, ram, cpu, total: rub(ram + cpu), hours: HOURS_MONTH };
}

// ── Ресурсы, которые приложение умеет создавать ───────────────────────────────
// level — насколько больно по деньгам; needsConfirm считается по нему, а не тут.
// calc(params) — оценка в рублях за месяц, если её можно посчитать честно.
const SERVICES = {
  vpc: {
    title: "Виртуальная сеть (VPC)",
    level: "free",
    billed: ["сеть и подсети не тарифицируются"],
    free: ["сама сеть и подсети — бесплатно"],
    notes: [
      "Платными в VPC были бы публичный IP-адрес и NAT-шлюз — приложение их не создаёт.",
      "Исходящий трафик в интернет: первые 100 ГБ в месяц бесплатно, дальше 1,42 ₽ за ГБ.",
    ],
    source: SOURCES.vpc,
  },
  dns: {
    title: "Cloud DNS (публичная зона)",
    level: "low",
    billed: ["существование зоны, за каждый час", "запросы DNS-записей из интернета"],
    free: ["запросы между сервисами внутри облака не тарифицируются"],
    calc: (p) => {
      const zones = Number(p && p.zones) > 0 ? Number(p.zones) : 1;
      const queriesMln = Number(p && p.queriesMln) > 0 ? Number(p && p.queriesMln) : 0;
      const zone = rub(zones * UNIT.dnsZoneHour * HOURS_MONTH);
      const q = rub(queriesMln * UNIT.dnsAuthPerMillion);
      return {
        total: rub(zone + q),
        rows: [
          { label: "зоны: " + zones + " × " + HOURS_MONTH + " ч", value: zone },
          { label: "запросы: " + queriesMln + " млн × 37,94 ₽", value: q },
        ],
        what: zones + " зона(ы) на весь месяц",
      };
    },
    source: SOURCES.dns,
  },
  lockbox: {
    title: "Lockbox (секреты)",
    level: "low",
    billed: ["хранение каждой версии секрета, за каждый час"],
    free: [],
    calc: (p) => {
      const versions = Number(p && p.versions) > 0 ? Number(p && p.versions) : 1;
      const total = rub(versions * UNIT.lockboxVersionHour * HOURS_MONTH);
      return {
        total,
        rows: [{ label: "версий секретов: " + versions + " × " + HOURS_MONTH + " ч", value: total }],
        what: versions + " версия(и) секрета на весь месяц",
      };
    },
    source: SOURCES.lockbox,
  },
  containerRegistry: {
    title: "Container Registry (реестр образов)",
    level: "low",
    billed: ["объём хранимых образов, за каждый час", "исходящий трафик при скачивании образа"],
    free: ["первые 6 сканирований образа на уязвимости в месяц"],
    calc: (p) => {
      const gb = Number(p && p.gb) > 0 ? Number(p && p.gb) : 5;
      const total = gbMonth(gb, UNIT.registryGbHour, 0);
      return {
        total,
        rows: [{ label: "образы: " + gb + " ГБ × месяц", value: total }],
        what: gb + " ГБ образов",
      };
    },
    notes: [
      "Общие слои образов не тарифицируются повторно — каждая новая версия дешевле первой.",
      "Старый образ из реестра лучше удалять: он продолжает занимать место и стоит денег.",
    ],
    source: SOURCES.registry,
  },
  storage: {
    title: "Object Storage (бакет)",
    level: "low",
    billed: ["объём данных, за каждый час", "операции GET/PUT/LIST сверх бесплатных", "исходящий трафик свыше 100 ГБ"],
    free: [
      "первый 1 ГБ данных в месяц",
      "первые 10 000 операций PUT/POST/PATCH/LIST",
      "первые 100 000 операций GET/HEAD/OPTIONS",
    ],
    calc: (p) => {
      const gb = Number(p && p.gb) > 0 ? Number(p && p.gb) : 10;
      const put = Number(p && p.put) > 0 ? Number(p && p.put) : 0;
      const get = Number(p && p.get) > 0 ? Number(p && p.get) : 0;
      const store = gbMonth(gb, UNIT.storageGbHour, UNIT.storageFreeGbHour);
      const putCost = rub(Math.max(0, Math.ceil(Math.max(0, put - 10000) / 1000)) * UNIT.storagePutPer1k);
      const getCost = rub(Math.max(0, Math.ceil(Math.max(0, get - 100000) / 10000)) * UNIT.storageGetPer10k);
      return {
        total: rub(store + putCost + getCost),
        rows: [
          { label: "данные: " + gb + " ГБ × месяц", value: store },
          { label: "запросы PUT: " + fmtCalls(put), value: putCost },
          { label: "запросы GET: " + fmtCalls(get), value: getCost },
        ],
        what: gb + " ГБ данных",
      };
    },
    source: SOURCES.storage,
  },
  ydb: {
    title: "Managed YDB (serverless)",
    level: "medium",
    billed: [
      "каждый выполненный запрос — в единицах запроса (RU)",
      "объём хранимых данных, включая индексы, за каждый час",
      "дополнительно: резервные копии, исходящий трафик",
    ],
    free: ["ежемесячный бесплатный пакет Request Units (см. прайс)"],
    // Единичную цену RU на дату сбора тарифов подтвердить не удалось —
    // поэтому числа здесь НЕТ, только ссылка. Придумывать цену нельзя.
    notes: [
      "База платит за каждый запрос, поэтому счёт растёт незаметно вместе с нагрузкой.",
      "Точную цифру смотри в калькуляторе: она зависит от числа и сложности запросов.",
    ],
    source: SOURCES.ydb,
  },
  serverlessContainers: {
    title: "Serverless Containers (контейнер)",
    level: "medium",
    billed: [
      "память × время работы приложения при вызовах",
      "vCPU × время работы приложения",
      "вызовы сверх 1 млн в месяц",
    ],
    free: ["1 млн вызовов", "10 ГБ×час памяти", "5 vCPU×час CPU"],
    calc: () => null, // стоимость задаётся ревизией, а не самим контейнером — см. ниже
    notes: [
      "Сам объект «контейнер» бесплатный: платишь только за работу ревизии при вызовах.",
      "Долгие деплои и постоянный прогрев экземпляров быстро съедают бесплатный пакет.",
    ],
    source: SOURCES.containers,
  },
};

// Контейнер: три сценария вместо одной цифры — «простой», «живой сайт» и «работает всегда».
// Считается по конфигурации ревизии (по умолчанию 256 МБ и 1 vCPU — как в deploy-engine).
function containerEstimate(o) {
  const opt = o || {};
  const memoryMb = Number(opt.memoryMb) > 0 ? Number(opt.memoryMb) : revisionDefaults.memoryMb;
  const cores = Number(opt.cores) > 0 ? Number(opt.cores) : revisionDefaults.cores;
  const quiet = containerCost({ memoryMb, cores, calls: 100000, msPerCall: 150 });
  const busy = containerCost({ memoryMb, cores, calls: 1000000, msPerCall: 150 });
  const idle = idleMonth({ memoryMb, cores });
  // Уровень — по реальной нагрузке (живой сайт), круглосуточная работа не норма,
  // а предупреждение: она показана отдельным сценарием ниже.
  const level = busy.total >= 1000 ? "high" : busy.total >= 50 ? "medium" : "low";
  return {
    key: "serverlessContainers",
    title: "Serverless Containers",
    kind: "container",
    level,
    levelLabel: LEVELS[level].label,
    needsConfirm: level !== "free",
    approxMonth: busy.total,
    what: "ревизия " + memoryMb + " МБ и " + cores + " vCPU — как в деплое по умолчанию",
    memoryMb,
    cores,
    scenarios: [
      { title: "тихий сайт — 100 тыс. вызовов × 150 мс", cost: quiet },
      { title: "живой сайт — 1 млн вызовов × 150 мс", cost: busy },
      { title: "работает круглосуточно — " + HOURS_MONTH + " ч", cost: { total: idle.total, rows: [
        { label: "память " + memoryMb + " МБ × " + HOURS_MONTH + " ч", value: idle.ram },
        { label: "vCPU " + cores + " × " + HOURS_MONTH + " ч", value: idle.cpu },
      ] } },
    ],
    rows: busy.rows,
    free: ["1 млн вызовов", "10 ГБ×час памяти", "5 vCPU×час CPU — в месяц, остаток не переносится"],
    save: [
      "ядер меньше: 0,2 vCPU (20%) вместо 1 снижает счёт по CPU примерно в пять раз",
      "память 256 МБ вместо 512 — вдвое меньше плата за RAM",
      "круглосуточная работа стоит тысячи рублей в месяц: для сайта лучше вызовы по запросу",
    ],
    source: SOURCES.containers,
    priceList: PRICE_LIST,
    calculator: CALCULATOR,
    pricedAt: PRICED_AT,
  };
}

// Ресурсы, которые приложение НЕ создаёт, но о которых агент должен предупредить.
// Цен нет: они зависят от конфигурации, а точная цифра — в калькуляторе.
const EXPENSIVE = [
  { title: "Виртуальная машина 24/7", why: "плата идёт за каждый час работы независимо от нагрузки" },
  { title: "Managed PostgreSQL / Managed Kubernetes", why: "минимальный класс уже стоит заметно — это тысячи рублей в месяц" },
  { title: "Публичный IP-адрес и NAT-шлюз", why: "тарифицируются за время существования" },
  { title: "Исходящий трафик сверх 100 ГБ", why: "1,42 ₽ за ГБ в месяц в интернет" },
];

// ── Публичные функции ─────────────────────────────────────────────────────────

function has(key) {
  return Object.prototype.hasOwnProperty.call(SERVICES, key);
}

function keys() {
  return Object.keys(SERVICES);
}

function levelOf(key) {
  if (key === "serverlessContainers") return "medium";
  const s = SERVICES[key];
  return s ? s.level : "medium";
}

function levelInfo(key) {
  const lvl = levelOf(key);
  return { level: lvl, label: LEVELS[lvl].label };
}

// Оценка по ключу сервиса. Параметры необязательны: без них берём типичные.
function estimate(key, params) {
  const k = String(key || "").trim();
  if (k === "serverlessContainers" || k === "container") return containerEstimate(params);
  const s = SERVICES[k];
  if (!s) return null;
  let calc = null;
  if (typeof s.calc === "function") {
    try {
      calc = s.calc(params || {});
    } catch (e) {
      calc = null;
    }
  }
  return {
    key: k,
    title: s.title,
    kind: "resource",
    level: s.level,
    levelLabel: LEVELS[s.level].label,
    // Платное агентом — только по явному согласию. Бесплатное спрашивать незачем.
    needsConfirm: s.level !== "free",
    approxMonth: calc ? calc.total : null,
    what: calc ? calc.what : "",
    rows: calc ? calc.rows : [],
    billed: s.billed || [],
    free: s.free || [],
    notes: (s.notes || []).concat(calc ? [] : ["Точной цены за единицу нет — смотри калькулятор и прайс-лист."]),
    save: s.save || [],
    source: s.source,
    priceList: PRICE_LIST,
    calculator: CALCULATOR,
    pricedAt: PRICED_AT,
  };
}

// Оценка ревизии контейнера — используется панелью деплоя.
function estimateContainerConfig(o) {
  return containerEstimate(o);
}

function money0(est) {
  if (!est || est.approxMonth == null) return "цена зависит от нагрузки";
  return "≈ " + money(est.approxMonth) + " в месяц";
}

// Текст для интерфейса и для агента. Строки, а не одно полотно: UI сам решает.
function formatLines(est) {
  if (!est) return ["Нет данных о стоимости этого ресурса."];
  const out = [];
  out.push(est.title + ": " + money0(est) + " (" + est.levelLabel + ")" + (est.what ? " — " + est.what : ""));
  for (const r of est.rows || []) {
    if (!r.value) continue;
    out.push("  • " + r.label + ": " + money(r.value));
  }
  for (const s of est.scenarios || []) {
    out.push("  • " + s.title + ": " + money((s.cost && s.cost.total) || 0));
  }
  if (!(est.rows || []).length && !(est.scenarios || []).length) {
    for (const b of est.billed || []) out.push("  • платно: " + b);
  }
  if ((est.free || []).length) out.push("  бесплатно: " + est.free.join("; "));
  for (const n of est.notes || []) out.push("  " + n);
  for (const s of est.save || []) out.push("  как дешевле: " + s);
  out.push("  тарифы на " + PRICED_AT + " (₽, с НДС) · проверь в калькуляторе: " + est.calculator);
  return out;
}

function formatText(est) {
  if (!est) return "Нет данных о стоимости этого ресурса.";
  return formatLines(est).join("\n");
}

// Платное создание агентом требует явного согласия пользователя.
function needsConfirm(keyOrEst) {
  const est = typeof keyOrEst === "string" ? estimate(keyOrEst, {}) : keyOrEst;
  return !!(est && est.needsConfirm);
}

// Короткая подсказка для карточки сервиса в интерфейсе.
function hint(key) {
  const est = estimate(key, {});
  if (!est) return "";
  return est.levelLabel + (est.approxMonth != null ? " · " + money(est.approxMonth) + "/мес" : "");
}

module.exports = {
  PRICED_AT,
  HOURS_MONTH,
  UNIT,
  LEVELS,
  SERVICES,
  EXPENSIVE,
  PRICE_LIST,
  CALCULATOR,
  has,
  keys,
  levelOf,
  levelInfo,
  estimate,
  estimateContainerConfig,
  containerCost,
  idleMonth,
  needsConfirm,
  hint,
  formatLines,
  formatText,
  money,
  rub,
};

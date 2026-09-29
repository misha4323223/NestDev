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
  compute: "https://yandex.cloud/ru/docs/compute/pricing",
  functions: "https://yandex.cloud/ru/docs/functions/pricing",
  cdn: "https://yandex.cloud/ru/docs/cdn/pricing",
  certificateManager: "https://yandex.cloud/ru/docs/certificate-manager/pricing",
};

// ── Compute Cloud: тарифы вычислительных ресурсов ──────────────────────────
// Числа взяты из таблицы цен Compute Cloud (платформа Intel Ice Lake,
// это и есть standard-v3) и VPC, действуют с 30 апреля 2026. Складываются:
//   цена часа ядра ЗАВИСИТ от уровня производительности: 20%, 50% или 100%.
// Именно поэтому «2 ядра» в облаке — не одна цена, а три разных.
const VM_VCPU_HOUR = { 20: 0.52, 50: 0.75, 100: 1.24 };
const VM_RAM_GB_HOUR = 0.33;
// Прерываемая машина: та же конфигурация, но облако вправе её выключить в любой
// момент — поэтому дешевле втрое-вчетверо.
const VM_PREEMPT_VCPU_HOUR = { 20: 0.166, 50: 0.2371, 100: 0.34 };
const VM_PREEMPT_RAM_GB_HOUR = 0.083;

// Тип диска → цена за ГБ×час. Имена те же, что в API (typeId).
const DISK_PRICES = {
  "network-hdd": { perGbHour: 0.0048, title: "стандартный диск (HDD)" },
  "network-ssd": { perGbHour: 0.0199, title: "быстрый диск (SSD)" },
  "network-ssd-nonreplicated": { perGbHour: 0.0147, title: "нереплицируемый диск (SSD)" },
  "network-ssd-io-m3": { perGbHour: 0.0332, title: "сверхбыстрое сетевое хранилище (SSD)" },
};
// Хранение снимка и образа — одна цена, 0,0051 ₽ за ГБ×час. Считается не по
// размеру диска, а по ФАКТИЧЕСКОМУ объёму снимка: он обычно меньше.
const SNAPSHOT_GB_HOUR = 0.0051;
// Публичный адрес: 0,26352 ₽ за час, пока он есть. Если статический адрес
// НЕ привязан к работающему ресурсу, добавляется резервирование 0,34038 ₽/час.
const PUBLIC_IP_HOUR = 0.26352;
const IDLE_STATIC_IP_HOUR = 0.34038;

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
  // Compute Cloud (см. таблицы выше) — вынесено отдельными именами, чтобы
  // карточка машины могла показать «сколько уже накопилось».
  vmRamGbHour: VM_RAM_GB_HOUR,
  publicIpHour: PUBLIC_IP_HOUR,
  idleStaticIpHour: IDLE_STATIC_IP_HOUR,
  // Object Storage, стандартное хранилище: 0,0033 ₽ за ГБ×час, 1 ГБ/мес бесплатно
  storageGbHour: 0.0033,
  storageFreeGbHour: 720,
  // Cloud DNS: 0,0592 ₽ за зону×час, 37,94 ₽ за млн авторитетных запросов
  dnsZoneHour: 0.0592,
  dnsAuthPerMillion: 37.94,
  // Lockbox: 0,0274 ₽ за версию секрета×час
  lockboxVersionHour: 0.0274,
  // Cloud CDN: 150 ₽ за ресурс в месяц пакетом (150 ГБ исходящего трафика и
  // 100 млн запросов включены), дальше 1,054 ₽ за ГБ и 1 ₽ за 100 тыс. запросов.
  cdnResourceMonth: 150,
  cdnIncludedGb: 150,
  cdnIncludedRequests: 100000000,
  cdnEgressPerGb: 1.054,
  cdnPer100kRequests: 1,
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

// ── Cloud Functions: по формуле из документации ───────────────────────────────
// Стоимость = 6,48 ₽ × Память(ГБ) × время(ч) + 18,97 ₽ × млн вызовов, минус
// бесплатный пакет (10 ГБ×час и 1 млн вызовов в месяц). Отличий от контейнеров
// два: у функций НЕТ платы за vCPU (только память) и свой ножной, зато самый
// щедрый для «редко зовут» бесплатный пакет — 1 млн вызовов против 1 млн у всех.
// Работа в подготовленном экземпляре (provisioned) тарифицируется отдельно, и
// приложение её не включает.
const FUNCTIONS_GB_HOUR = 6.48;
const FUNCTIONS_PER_MILLION_CALLS = 18.97;
const FUNCTIONS_FREE_GB_HOUR = 10;
const FUNCTIONS_FREE_CALLS = 1000000;
const FUNCTIONS_PROVISIONED_GB_HOUR = 2.72;
const FUNCTIONS_PROVISIONED_IDLE_GB_HOUR = 1.42;

function functionsCost(o) {
  const opt = o || {};
  const memoryMb = Number(opt.memoryMb) > 0 ? Number(opt.memoryMb) : 128;
  const calls = Number(opt.calls) >= 0 ? Number(opt.calls) : 10000;
  const msPerCall = Number(opt.msPerCall) > 0 ? Number(opt.msPerCall) : 100;
  const hours = (calls * msPerCall) / 3600000;
  const gbHours = (memoryMb / 1024) * hours;
  const ram = rub(Math.max(0, gbHours - FUNCTIONS_FREE_GB_HOUR) * FUNCTIONS_GB_HOUR);
  const request = rub(Math.max(0, calls - FUNCTIONS_FREE_CALLS) / 1000000 * FUNCTIONS_PER_MILLION_CALLS);
  return {
    memoryMb, calls, msPerCall,
    hours: Math.round(hours * 1000) / 1000,
    gbHours: Math.round(gbHours * 1000) / 1000,
    ram, request, total: rub(ram + request),
    rows: [
      { label: "память " + memoryMb + " МБ × " + fmtHours(hours) + " работы (" + (Math.round(gbHours * 1000) / 1000).toString().replace(".", ",") + " ГБ×час)", value: ram, unit: "ГБ×час" },
      { label: "вызовы " + fmtCalls(calls), value: request, unit: "млн вызовов" },
    ],
  };
}

function functionsEstimate(o) {
  const opt = o || {};
  const memoryMb = Number(opt.memoryMb) > 0 ? Number(opt.memoryMb) : 128;
  const msPerCall = Number(opt.msPerCall) > 0 ? Number(opt.msPerCall) : 100;
  // Три честных сценария вместо одной цифры: у функций ответ зависит не от
  // «времени существования», а только от того, сколько её зовут.
  const rare = functionsCost({ memoryMb, msPerCall, calls: 10000 });
  const alive = functionsCost({ memoryMb, msPerCall, calls: 1000000 });
  const hot = functionsCost({ memoryMb, msPerCall, calls: 10000000 });
  const level = hot.total >= 1000 ? "high" : hot.total >= 50 ? "medium" : "low";
  return {
    key: "cloudFunctions",
    title: "Cloud Functions",
    kind: "function",
    level,
    levelLabel: LEVELS[level].label,
    needsConfirm: level !== "free",
    approxMonth: hot.total,
    what: "функция " + memoryMb + " МБ и " + msPerCall + " мс на вызов",
    memoryMb,
    scenarios: [
      { title: "редко зовут — 10 тыс. вызовов", cost: rare },
      { title: "живая — 1 млн вызовов", cost: alive },
      { title: "нагруженная — 10 млн вызовов", cost: hot },
    ],
    rows: alive.rows,
    free: [
      "1 млн вызовов в месяц",
      "10 ГБ×час выполнения — в месяц, остаток не переносится",
      "сама функция и её версии не тарифицируются вовсе: пока её не зовут, она бесплатна",
    ],
    save: [
      "память 128 МБ вместо 512 — вчетверо меньше плата за ГБ×час",
      "код быстрее — дешевле: платят за время выполнения, а не за факт вызова",
      "триггеры и вызовы по расписанию не тарифицируются: платят только сами запуски кода",
    ],
    notes: [
      "Подготовленные экземпляры (provisioned) тарифицируются отдельно: 2,72 ₽ за ГБ×час работы и 1,42 ₽ за ГБ×час простоя. Приложение их не включает.",
      "Навыки Алисы через платформу Яндекс Диалоги не тарифицируются вовсе.",
    ],
    source: SOURCES.functions,
    priceList: PRICE_LIST,
    calculator: CALCULATOR,
    pricedAt: PRICED_AT,
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

// ── Машина: почасовые ресурсы + диски + адрес ────────────────────────────────
// Одна правда о том, сколько стоит машина, для панели, агента и карточки.
// Платят за время РАБОТЫ: остановленная машина не тарифицируется, но её диски
// и закреплённый адрес — тарифицируются ВСЕГДА. Именно эта разница чаще всего
// и удивляет в счёте, поэтому в оценке она видна отдельными строками.
const VM_CORES_DEFAULT = 2;
const VM_MEMORY_GB_DEFAULT = 2;
const VM_DISK_GB_DEFAULT = 20;
const VM_HOURS_MONTH_WORKDAY = 8 * 22; // 8 часов в день, 22 рабочих дня

function diskPriceOf(typeId) {
  return DISK_PRICES[String(typeId || "")] || DISK_PRICES["network-ssd"];
}

// Цена часа работы машины без дисков и адреса.
function vmResourcesHour(o) {
  const opt = o || {};
  const cores = Number(opt.cores) > 0 ? Number(opt.cores) : VM_CORES_DEFAULT;
  const fraction = VM_VCPU_HOUR[Number(opt.coreFraction)] ? Number(opt.coreFraction) : 20;
  const memoryGb = Number(opt.memoryGb) > 0 ? Number(opt.memoryGb) : VM_MEMORY_GB_DEFAULT;
  const preemptible = opt.preemptible === true;
  const vcpuRate = (preemptible ? VM_PREEMPT_VCPU_HOUR : VM_VCPU_HOUR)[fraction];
  const ramRate = preemptible ? VM_PREEMPT_RAM_GB_HOUR : VM_RAM_GB_HOUR;
  return {
    cores,
    fraction,
    memoryGb,
    preemptible,
    vcpu: rub(cores * vcpuRate),
    ram: rub(memoryGb * ramRate),
    get total() {
      return rub(this.vcpu + this.ram);
    },
  };
}

// Внимание: gb — ГИГАБАЙТЫ. Размер из API приходит в БАЙТАХ (disk.size), а поле
// из настроек — в гигабайтах: перед вызовом делите байты на 1073741824.
function diskMonth(gb, typeId) {
  const p = diskPriceOf(typeId);
  return rub(Number(gb) * p.perGbHour * HOURS_MONTH);
}

function ipMonth(o) {
  const opt = o || {};
  if (!opt.publicIp) return { total: 0, idle: 0, rows: [] };
  const active = rub(PUBLIC_IP_HOUR * HOURS_MONTH);
  // Простаивающий статический адрес дороже работающего: к плате за адрес
  // добавляется плата за резервирование.
  const idle = rub((PUBLIC_IP_HOUR + IDLE_STATIC_IP_HOUR) * HOURS_MONTH);
  return {
    total: active,
    idle,
    rows: [
      { label: "публичный адрес × " + HOURS_MONTH + " ч", value: active },
      { label: "…если адрес простаивает", value: idle },
    ],
  };
}

// Оценка машины: три сценария вместо одной цифры — так же, как у контейнера.
// «Круглосуточно» — норма для сайта, «рабочий день» — для машины разработчика,
// «остановлена» — то, что человек часто не учитывает: диски всё равно платные.
function vmEstimate(o) {
  const opt = o || {};
  const res = vmResourcesHour(opt);
  const diskGb = Number(opt.diskSizeGb) > 0 ? Number(opt.diskSizeGb) : VM_DISK_GB_DEFAULT;
  const diskType = String(opt.diskTypeId || opt.diskType || "network-ssd");
  const disk = diskMonth(diskGb, diskType);
  const snapGb = Number(opt.snapshotGb) >= 0 ? Number(opt.snapshotGb) : 0;
  const snapshot = rub(snapGb * SNAPSHOT_GB_HOUR * HOURS_MONTH);
  const ip = ipMonth(opt);
  const diskInfo = diskPriceOf(diskType);

  const rowsFor = (hours, title) => {
    const rows = [
      { label: "процессор " + res.cores + " × " + res.fraction + "% × " + hours + " ч", value: rub(res.vcpu * hours) },
      { label: "память " + res.memoryGb + " ГБ × " + hours + " ч", value: rub(res.ram * hours) },
      { label: "диск " + diskGb + " ГБ — платный всегда", value: disk },
    ];
    if (snapGb) rows.push({ label: "снимки " + snapGb + " ГБ", value: snapshot });
    if (ip.total) rows.push({ label: "публичный адрес", value: ip.total });
    const total = rub(rows.reduce((a, r) => a + r.value, 0));
    // cost — та же форма, что у сценариев контейнера: её печатает formatLines
    // и её читает панель, поэтому у сценария машины не своя форма.
    return { title, hours, rows, total, cost: { total, rows } };
  };

  const full = rowsFor(HOURS_MONTH, "работает круглосуточно");
  const workday = rowsFor(VM_HOURS_MONTH_WORKDAY, "работает по 8 часов в рабочие дни");
  // Когда машина остановлена, остаются только диски, снимки и адрес.
  const stoppedRows = [
    { label: "диск " + diskGb + " ГБ — платный и у остановленной машины", value: disk },
  ];
  if (snapGb) stoppedRows.push({ label: "снимки " + snapGb + " ГБ", value: snapshot });
  if (ip.total) stoppedRows.push({ label: "публичный адрес", value: ip.total });
  const stoppedTotal = rub(stoppedRows.reduce((a, r) => a + r.value, 0));
  const stopped = { title: "остановлена (платят только диски и адрес)", hours: 0, rows: stoppedRows, total: stoppedTotal, cost: { total: stoppedTotal, rows: stoppedRows } };

  const level = full.total >= 2000 ? "high" : full.total >= 200 ? "medium" : "low";
  const notes = [
    "Время с выключенной машиной не тарифицируется: `stop` реально экономит деньги.",
    "Но диски тарифицируются независимо от того, запущена машина или нет — и после её удаления тоже.",
    "Прерываемая машина дешевле втрое, но облако может выключить её в любой момент: только для тестов.",
  ];
  if (opt.publicIp) {
    notes.push("Публичный адрес берут отдельно, и простаивающий статический дороже работающего: " + money(ip.idle) + " в месяц против " + money(ip.total) + ".");
  }
  const save = [
    "уровень 20% вместо 100% снижает плату за процессор почти в два с половиной раза при том же числе ядер",
    "стандартный диск (HDD) вместо быстрого (SSD) вчетверо дешевле — подходит для данных и бэкапов",
    "останавливай машину, когда она не нужна: за выключенное время счёт не идёт",
  ];
  if (diskType === "network-ssd") save.push("быстрый диск нужен для системы; большой диск с данными дешевле держать стандартным");

  return {
    key: "compute",
    title: "Виртуальная машина (Compute Cloud)",
    kind: "vm",
    level,
    levelLabel: LEVELS[level].label,
    needsConfirm: true,
    approxMonth: full.total,
    what:
      res.cores + " × " + res.fraction + "% vCPU, " + res.memoryGb + " ГБ памяти, " +
      diskGb + " ГБ (" + diskInfo.title + "), " + (res.preemptible ? "прерываемая" : "обычная") +
      (opt.publicIp ? ", с публичным адресом" : ", без публичного адреса"),
    cores: res.cores,
    coreFraction: res.fraction,
    memoryGb: res.memoryGb,
    diskGb,
    diskTypeId: diskType,
    scenarios: [full, workday, stopped],
    rows: full.rows,
    billed: [
      "каждый час в статусе «работает» — с посекундной точностью",
      "диски — всегда, включая время с выключенной машиной и после её удаления",
      "снимки дисков — пока их не удалят",
      "публичный адрес — пока он есть (простаивающий статический дороже)",
    ],
    free: [],
    notes,
    save,
    source: SOURCES.compute,
    priceList: PRICE_LIST,
    calculator: CALCULATOR,
    pricedAt: PRICED_AT,
  };
}

// Снимок диска отдельной строкой: он не входит в цену машины, но переживает её.
function snapshotEstimate(o) {
  const opt = o || {};
  const gb = Number(opt.gb) > 0 ? Number(opt.gb) : 20;
  const total = rub(gb * SNAPSHOT_GB_HOUR * HOURS_MONTH);
  return {
    key: "computeSnapshot",
    title: "Снимок диска",
    kind: "resource",
    level: total >= 500 ? "medium" : "low",
    levelLabel: LEVELS[total >= 500 ? "medium" : "low"].label,
    needsConfirm: true,
    approxMonth: total,
    what: gb + " ГБ снимка",
    rows: [{ label: "хранение " + gb + " ГБ × " + HOURS_MONTH + " ч", value: total }],
    billed: ["хранение каждого гигабайта снимка, за каждый час"],
    free: [],
    notes: [
      "Снимок тарифицируется по СВОЕМУ объёму, а не по размеру диска: он обычно меньше.",
      "Снимок переживает машину и диск — это его плюс и его цена. Ненужные снимки стоит удалять.",
    ],
    save: ["чисти старые снимки: " + money(rub(SNAPSHOT_GB_HOUR * HOURS_MONTH)) + " за ГБ в месяц"],
    source: SOURCES.compute,
    priceList: PRICE_LIST,
    calculator: CALCULATOR,
    pricedAt: PRICED_AT,
  };
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
  // Статический адрес закрепляется и освобождается из карточки сети (ycVpc) — не
  // через ycCreate, потому что адрес живёт в конкретной зоне. Платный, и особенно
  // платный простаивающим. Точной цены за час на дату сбора тарифов подтвердить не
  // удалось, поэтому числа здесь НЕТ — только факт тарификации и ссылка на прайс.
  // Придумывать цену нельзя: пусть лучше будет ссылка, чем выдуманная цифра.
  vpcAddress: {
    title: "Статический IP-адрес (VPC)",
    level: "low",
    billed: [
      "каждый час существования адреса — с момента закрепления и до освобождения",
      "отдельно — резервирование, пока статический адрес ни к чему не привязан (0,34038 ₽/час)",
    ],
    free: [],
    // Цена подтверждена таблицей цен VPC: 0,26352 ₽ за адрес×час, а неактивный
    // статический дороже ровно на стоимость резервирования (0,34038 ₽/час).
    calc: (p) => {
      const count = Number(p && p.count) > 0 ? Number(p.count) : 1;
      const idle = p && p.idle === true;
      const rate = idle ? PUBLIC_IP_HOUR + IDLE_STATIC_IP_HOUR : PUBLIC_IP_HOUR;
      const total = rub(count * rate * HOURS_MONTH);
      return {
        total,
        rows: [
          { label: (idle ? "простаивающий адрес × " : "адрес × ") + count + " × " + HOURS_MONTH + " ч", value: total },
        ],
        what: count + (idle ? " простаивающий статический адрес" : " публичный адрес") + " на весь месяц",
      };
    },
    notes: [
      "Простаивающий адрес тарифицируется так же, как привязанный: «закрепить про запас» — это платить ни за что.",
      "Адрес выдаётся в конкретной зоне и в другую зону не переносится.",
      "Освобождённый адрес уходит в облако: вернуть именно его уже нельзя, а всё, что на него указывало (DNS, белые списки), перестанет работать.",
    ],
    source: SOURCES.vpc,
  },
  cloudFunctions: {
    title: "Cloud Functions (функции)",
    level: "low",
    billed: [
      "каждый вызов функции (сверх 1 млн в месяц)",
      "время выполнения: 6,48 ₽ за ГБ×час памяти (сверх 10 ГБ×час в месяц)",
    ],
    free: ["1 млн вызовов в месяц", "10 ГБ×час выполнения в месяц", "сама функция, версии и триггеры — бесплатно"],
    calc: (p) => functionsCost(p || {}),
    notes: [
      "Функция не тарифицируется за простой: пока её не зовут, она не стоит ничего. Это дешевле машины, которую надо держать.",
      "Плата идёт за ПАМЯТЬ × время выполнения: быстрый код дешевле медленного при том же числе вызовов.",
    ],
    source: SOURCES.functions,
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
  // Cloud CDN: платит РЕСУРС, а не трафик: 150 ₽ в месяц за каждый ресурс пакетом
  // (в пакет входят 150 ГБ исходящего трафика и 100 млн запросов). Деньги уходят
  // и при нулевом трафике — поэтому создание ресурса требует согласия, а
  // остановить счёт можно только удалением ресурса.
  cdn: {
    title: "Cloud CDN (HTTPS-сайт)",
    level: "medium",
    billed: [
      "каждый CDN-ресурс — 150 ₽ в месяц пакетом, независимо от трафика",
      "исходящий трафик сверх 150 ГБ на ресурс — 1,054 ₽ за ГБ",
      "запросы сверх 100 млн на ресурс — 1 ₽ за 100 тыс. запросов",
      "отдельно: экранирование источников, выгрузка логов, выделенная IP-адресация",
    ],
    free: ["150 ГБ исходящего трафика и 100 млн запросов на каждый ресурс — уже в пакете", "сам сертификат от Let's Encrypt — бесплатно"],
    calc: (p) => {
      const resources = Number(p && p.resources) > 0 ? Number(p && p.resources) : 1;
      const gb = Number(p && p.gb) > 0 ? Number(p && p.gb) : 0;
      const requests = Number(p && p.requests) > 0 ? Number(p && p.requests) : 0;
      const base = rub(resources * 150);
      const extraGb = Math.max(0, gb - resources * 150);
      const extraReq = Math.max(0, requests - resources * 100000000);
      const traffic = rub(extraGb * 1.054);
      const calls = rub(Math.ceil(extraReq / 100000) * 1);
      return {
        total: rub(base + traffic + calls),
        rows: [
          { label: "ресурсы: " + resources + " × 150 ₽ (пакет)", value: base },
          { label: "трафик сверх пакета: " + extraGb + " ГБ", value: traffic },
          { label: "запросы сверх пакета: " + fmtCalls(extraReq), value: calls },
        ],
        what: resources + " CDN-ресурс(ов) на весь месяц",
      };
    },
    notes: [
      "Ресурс стоит денег ВСЕГДА: пакет списывается вперёд, поэтому «сделал и забыл» — это 150 ₽ в месяц за каждый сайт.",
      "Удалить ресурс = перестать платить: остаток пакета при удалении обнуляется и на другой ресурс не переносится.",
      "Трафик между бакетом Object Storage и CDN-серверами не тарифицируется: платишь за то, что уходит клиентам.",
    ],
    source: SOURCES.cdn,
  },
  certificateManager: {
    title: "Certificate Manager (сертификат)",
    level: "free",
    billed: [],
    free: [
      "выпуск сертификата Let's Encrypt",
      "автоматическое продление выпущенного сертификата",
      "хранение загруженных сертификатов (но продлевать их придётся самому)",
    ],
    notes: [
      "Certificate Manager не тарифицируется вовсе — это самый дешёвый способ получить https на своём домене.",
      "Платит сервис, который сертификат носит: статический сайт — это CDN-ресурс (см. оценку cdn).",
    ],
    source: SOURCES.certificateManager,
  },
  // Машина: оценку считает vmEstimate (ниже) — по формуле из документации, как
  // у контейнера. Здесь только описание и тариф-ссылка, чтобы costs.has("compute")
  // был правдой и подсказка в интерфейсе работала.
  compute: {
    title: "Виртуальная машина (Compute Cloud)",
    level: "high",
    billed: [
      "каждый час в статусе «работает» — тарификация посекундная",
      "диски — всегда, включая время с выключенной машиной и после её удаления",
      "снимки дисков и публичный адрес — отдельно",
    ],
    free: [],
    notes: [
      "Машина не тарифицируется, пока остановлена, — но её диски и адрес тарифицируются всегда.",
      "Именно поэтому «просто оставить» дороже, чем удалить: остаются платные хвосты.",
    ],
    source: SOURCES.compute,
  },
  computeSnapshot: {
    title: "Снимок диска (Compute Cloud)",
    level: "low",
    billed: ["хранение каждого гигабайта снимка, за каждый час"],
    free: [],
    notes: [
      "Снимок считается по своему объёму, а не по размеру диска, — он обычно меньше.",
      "Снимок переживает и машину, и диск: это его смысл и его цена.",
    ],
    source: SOURCES.compute,
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
  if (key === "cloudFunctions") return "low";
  if (key === "compute" || key === "vm") return "high";
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
  if (k === "compute" || k === "vm") return vmEstimate(params);
  if (k === "computeSnapshot" || k === "snapshot") return snapshotEstimate(params);
  if (k === "cloudFunctions" || k === "functions" || k === "function") return functionsEstimate(params);
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
  // Cloud Functions: тарифы из документации и одна арифметика на всех.
  functionsEstimate,
  functionsCost,
  FUNCTIONS_GB_HOUR,
  FUNCTIONS_PER_MILLION_CALLS,
  FUNCTIONS_FREE_GB_HOUR,
  FUNCTIONS_FREE_CALLS,
  FUNCTIONS_PROVISIONED_GB_HOUR,
  FUNCTIONS_PROVISIONED_IDLE_GB_HOUR,
  idleMonth,
  // Compute: одна правда о цене машины — её читает и панель, и агент.
  vmEstimate,
  vmResourcesHour,
  diskMonth,
  diskPriceOf,
  ipMonth,
  snapshotEstimate,
  VM_VCPU_HOUR,
  VM_PREEMPT_VCPU_HOUR,
  DISK_PRICES,
  PUBLIC_IP_HOUR,
  IDLE_STATIC_IP_HOUR,
  SNAPSHOT_GB_HOUR,
  needsConfirm,
  hint,
  formatLines,
  formatText,
  money,
  rub,
};

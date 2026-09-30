"use strict";
/* ─── Живой прогон панели Yandex Cloud (настоящий браузер) ───────────────────
   Запуск: bun run test:live:cloud-panel   (node scripts/live-cloud-panel.js)

   Зачем этот прогон. Наборы проверяют ЛОГИКУ панели в игрушечной заглушке окна,
   а ЗАГЛУШКА НИЧЕГО НЕ ЗНАЕТ О РАСКЛАДКЕ: иконка из официальной библиотеки может
   оказаться растянутой, полка — в одну колонку на всю ширину, чип со хвостами —
   обрезанным, а «тень», которой в этом приложении нет (monochrome.css гасит
   box-shadow), — просто невидимой. Всё это видно только в настоящем браузере с
   настоящими стилями окна.

   Что поднимается НАСТОЯЩЕЕ:
     • разметка панели берётся ИЗ src/renderer/index.html (копии нет — иначе
       прогон проверял бы свой же выдуманный HTML);
     • все стили окна по порядку, как в index.html: styles → monochrome →
       yc-console → deploy-panel → panels → replit-theme → yc-panel (последним);
     • настоящие src/renderer/yc-logos.js, src/renderer/yc-panel.js и
       src/renderer/yc-actions.js (действия служб: формы, цена, секрет);
     • Chromium из playwright, панель шириной 460px — как в окне.

   Что проверяется:
     [1] страница без ошибок: панель собралась и нарисовала полку;
     [2] геометрия: иконка сервиса ровно 32×32, знак платформы ~19×19, плитки в
         две колонки, ничего не вылезает по горизонтали;
     [3] ступень фона: плитка светлее фона (глубина делается светом, а не тенью);
     [4] строка здоровья: баланс и хвосты в рублях на месте, в подвале сказано,
         что приложение не является продуктом Яндекс.Облака;
     [5] фильтр и поиск работают В БРАУЗЕРЕ (клик и событие input), причём поиск
         ищет по русскому имени, которое написано на плитке;
     [6] хвосты раскрываются списком с ценой и ответом «что делать»;
     [7] раскрытая плитка занимает всю строку полки и показывает ресурсы;
     [8] ДЕЙСТВИЯ СЛУЖБ В ПАНЕЛИ: кнопка «⚙ Действия» открывает список действий,
         действие без полей сразу отвечает полкой машин с хвостами, платное
         сначала показывает ЦЕНУ и только потом отправляет согласие (второе
         нажатие), необратимое спрашивает человека ДО запроса, а секрет ключа
         показывается один раз отдельной рамкой и не попадает в строки ответа;
     [9] Яндекс AI чипом в строке здоровья: перевод и голоса живьём;
     [10] MANAGED-БАЗЫ: три плитки (PostgreSQL, MySQL, ClickHouse) зовут один
         канал, но каждая подставляет СВОЙ engine; создание показывает цену,
         спрашивает согласие и отдаёт пароль один раз отдельной рамкой, а
         удаление необратимо и потому спрашивает дважды — человека и облако;
     [11] DNS-ЗОНЫ: плитка действий зовёт yc:dns, запись собирается из формы
         (зона, имя, тип, TTL, значения), а удаление сначала называет саму
         запись и спрашивает человека, и только потом уходит с confirm;
     [12] AI STUDIO: у семейства Яндекс AI теперь одиннадцать действий —
         модели каталога, бесплатные токены, ответ модели с ценой по настоящим
         токенам и вектор текста; каждое собирает свои аргументы из формы, а
         ответ показывает строки канала;
     [13] ГРУППЫ МАШИН: у плитки «Группы машин» свои восемь действий — список,
         карточка с шаблоном и машинами, создание (сначала цена и размер,
         потом согласие) и удаление, которое забирает машины вместе с дисками.
     [14] БАЛАНСИРОВЩИКИ: у плитки «Балансировщики» двадцать одно действие —
         карточка проходит путь слушатель → роутер → группа бэкендов → группа
         целей, создание сначала показывает цену и порт, а удаление называет
         адреса слушателей и спрашивает человека; группа бэкендов собирается из
         формы (вид, порт целей, путь проверки), здоровье спрашивают у пары
         «бэкенды + цели» и показывают ПО ЗОНАМ, а удаление группы сначала
         спрашивает человека; состав слушателей меняется ТОЧЕЧНО (добавить,
         ПОПРАВИТЬ и убрать — с согласием на закрытие входа), правка слушателя
         называет только то, что меняем (пустое остаётся прежним), несколько
         доменов на одном слушателе живут в SNI со своими сертификатами, а
         правка балансировщика уходит МАСКОЙ полей — группы безопасности
         заменяются целиком.

   Этот прогон уже нашёл настоящую ошибку: поиск по «функц» не находил плитку
   «Функции» — строка поиска не включала русское имя, а человек ищет по тому, что
   видит. */

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(cond, name, info) {
  if (cond) {
    pass++;
    console.log("  ✅ " + name);
  } else {
    fail++;
    console.error("  ❌ " + name + (info ? " — " + info : ""));
  }
}
function section(title) {
  console.log("\n" + title);
}

let chromium;
try {
  chromium = require(path.join(ROOT, "node_modules", "playwright")).chromium;
} catch (e) {
  console.error("✗ Нет playwright. Установи: bun install && npx playwright install --with-deps chromium");
  process.exit(1);
}

const HTML = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
const PANEL_SRC = fs.readFileSync(path.join(ROOT, "src", "renderer", "yc-panel.js"), "utf8");

// Панель берём из настоящей разметки: от #sp-cloud до панели проекта.
const START = HTML.indexOf('<div id="sp-cloud"');
const END = HTML.indexOf("<!-- Панель проекта: файлы + коммиты -->");
if (START < 0 || END < 0) {
  console.error("✗ В src/renderer/index.html не нашёл блок панели облака (#sp-cloud)");
  process.exit(1);
}
const BLOCK = HTML.slice(START, END).trim();

// Панель навешивает обработчики и на элементы НАСТРОЕК — они живут в другой части
// разметки. В стенде их нет, поэтому подставляем пустые заглушки: прогон про
// панель, а не про вкладку настроек.
const PANEL_IDS = [...new Set([...PANEL_SRC.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]))];
const STUBS = PANEL_IDS.map((id) => '<div id="' + id + '"></div>').join("\n");

// Абсолютная база: страница стенда живёт во временной папке, а стили и модули — в репозитории.
const BASE = "file://" + ROOT.split(path.sep).join("/") + "/";

const PAGE = `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8" /><title>Панель Yandex Cloud</title>
<link rel="stylesheet" href="${BASE}src/renderer/styles.css" />
<link rel="stylesheet" href="${BASE}src/renderer/monochrome.css" />
<link rel="stylesheet" href="${BASE}src/renderer/yc-console.css" />
<link rel="stylesheet" href="${BASE}src/renderer/deploy-panel.css" />
<link rel="stylesheet" href="${BASE}src/renderer/panels.css" />
<link rel="stylesheet" href="${BASE}src/renderer/replit-theme.css" />
<link rel="stylesheet" href="${BASE}src/renderer/yc-panel.css" />
<link rel="stylesheet" href="${BASE}src/renderer/yc-actions.css" />
<style>
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); }
  #stage { display: flex; justify-content: flex-end; height: 100vh; }
  .side-panel { height: 100%; }
</style>
</head><body>
<div id="stage"><aside id="side-panel" class="side-panel">
${BLOCK}
</aside></div>
<div id="stubs" style="display:none">
${STUBS}
</div>
<script src="${BASE}src/renderer/yc-logos.js"></script>
<script src="${BASE}src/renderer/yc-panel.js"></script>
<script src="${BASE}src/renderer/yc-actions.js"></script>
<script>
  // Данные стенда: тринадцать сервисов (три managed-базы, группа машин и балансировщики), один
  // отказал, есть ресурсы, деньги и хвосты.
  const services = [
    { key: "storage", ru: "Объектное хранилище", title: "Object Storage", ok: true, count: 3, items: [{ id: "b1", name: "site-bucket" }, { id: "b2", name: "logs-archive" }, { id: "b3", name: "backups" }] },
    { key: "cloudFunctions", ru: "Функции", title: "Cloud Functions", ok: true, count: 2, items: [{ id: "f1", name: "tg-webhook" }, { id: "f2", name: "hourly-report" }] },
    { key: "dns", ru: "DNS-зоны", title: "Cloud DNS", ok: true, count: 1, items: [{ id: "z1", name: "example.com." }] },
    { key: "cdn", ru: "CDN и сайты", title: "Cloud CDN", ok: true, count: 1, items: [{ id: "c1", name: "cdn.example.com" }] },
    { key: "vpc", ru: "Сети VPC", title: "Virtual Private Cloud", ok: true, count: 0, items: [] },
    { key: "iam", ru: "Сервисные аккаунты", title: "Identity and Access Management", ok: true, count: 4, items: [{ id: "s1", name: "deploy-bot" }] },
    { key: "lockbox", ru: "Секреты", title: "Lockbox", ok: false, count: 0, error: "403: нет роли lockbox.viewer — попроси владельца каталога" },
    { key: "compute", ru: "Виртуальные машины", title: "Compute Cloud", ok: true, count: 1, items: [{ id: "vm1", name: "web-1" }] },
    // Группы машин (Instance Groups): тот же хост, что у Compute, но ресурс
    // другой — группа сама создаёт машины по шаблону. Своя плитка и своё
    // семейство действий (канал yc:ig).
    { key: "instanceGroups", ru: "Группы машин", title: "Instance Groups", ok: true, count: 1, items: [{ id: "ig1", name: "web" }] },    // Балансировщики: вход в приложение — слушатели, группы целей, HTTP-роутеры
    // и группы бэкендов. У плитки своё семейство из двадцати одного действия (канал
    // ycAlb): создание балансировщика платное — цена спрашивается до согласия, — а
    // состав слушателей меняют ТОЧЕЧНО (listeneradd/listenerdel) и правят маской
    // полей (lbupdate).
    { key: "alb", ru: "Балансировщики", title: "Application Load Balancer", ok: true, count: 1, items: [{ id: "lb1", name: "web-lb" }] },

    // Managed-базы: три плитки у одного канала (yc:mdb). Какая это база, видно
    // только по полю engine, которое подставляет само семейство, — в этом весь
    // смысл проверки [10].
    { key: "postgresql", ru: "База PostgreSQL", title: "Managed Service for PostgreSQL", ok: true, count: 2, items: [{ id: "pg1", name: "pg-1" }, { id: "pg2", name: "pg-prot" }] },
    { key: "mysql", ru: "База MySQL", title: "Managed Service for MySQL", ok: true, count: 1, items: [{ id: "my1", name: "my-1" }] },
    { key: "clickhouse", ru: "База ClickHouse", title: "Managed Service for ClickHouse", ok: true, count: 1, items: [{ id: "ch1", name: "ch-1" }] }
  ];
  // Журнал вызовов каналов: по нему видно, ЧТО именно ушло в облако.
  window.__calls = [];
  // Подтверждение — обычное окно приложения; в прогоне оно молча соглашается, но
  // считает вызовы: необратимое обязано спросить человека ДО запроса.
  window.__confirmCalls = 0;
  window.uiConfirm = (title, text, go) => { window.__confirmCalls++; go(); };
  window.uiToast = () => {};
  const api = {
    ycStatus: async () => ({ loggedIn: true, iamOk: true, folderId: "b1g", folderName: "prod-web" }),
    ycResources: async () => ({ ok: true, services, total: 18, activeServices: 10 }),
    ycBilling: async () => ({
      ok: true,
      account: { id: "acc", name: "Облако", currency: "RUB", balance: 1234.56, balanceHuman: "1 234,56 ₽", active: true },
      leaks: { count: 2, total: 461.5, live: 1440, running: [{}, {}], tails: [
        { why: "диск data-old не привязан ни к одной машине", todo: "удали диск", month: 310.5, monthHuman: "310,50 ₽" },
        { why: "статический адрес 84.201.1.2 никто не занял", todo: "освободи адрес", month: 151, monthHuman: "151,00 ₽" }
      ] }
    }),
    openExternal() {},
    ycLogs: async () => ({ ok: false, error: "нет" }),
    // ── Каналы действий: отвечают как настоящее облако (тот же контракт) ──
    ycCompute: async (a) => {
      window.__calls.push(["ycCompute", a]);
      if (a.op === "list") return { ok: true, presetKeys: ["micro", "small"], zones: ["ru-central1-a"], subnets: [{ name: "app-subnet" }],
        instances: [{ name: "web-1", statusHuman: "работает", running: true, zoneId: "ru-central1-a", cores: 2, coreFraction: 20, guaranteedVcpu: 0.4, memoryHuman: "2 ГБ", hasExternalIp: true, externalIp: "1.2.3.4", uptime: "3 часа" }],
        disks: [{}], snapshots: [{}], leftovers: { total: 1, lines: ["диски без машины: data-old 93 ГБ"] } };
      if (a.op === "create" && a.confirmed !== true) return { ok: false, needsConfirm: true, lines: ["Машина: ≈ 1 200 ₽/мес"], error: "Машина создаётся платно" };
      if (a.op === "create") return { ok: true, message: "Машина «" + a.name + "» создана", instance: { name: a.name }, warnings: ["Публичный адрес оплачивается отдельно."] };
      if (a.op === "delete") return { ok: true, deleted: true, message: "Машина «" + a.name + "» удалена" };
      return { ok: true, message: "готово: " + a.op };
    },
    ycIam: async (a) => {
      window.__calls.push(["ycIam", a]);
      if (a.op === "newkey") return { ok: true, message: "Ключ создан", secret: "SECRET-42", kind: a.kind };
      if (a.op === "list") return { ok: true, lines: ["deploy-bot — активен · роли: storage.viewer · ключей: 1"], accounts: [], rows: [] };
      return { ok: true, message: "готово: " + a.op };
    },
    ycVpc: async (a) => { window.__calls.push(["ycVpc", a]); return { ok: true, message: "готово: " + a.op, networks: [], subnets: [], securityGroups: [], addresses: [] }; },
    ycFunctions: async (a) => { window.__calls.push(["ycFunctions", a]); return { ok: true, message: "готово: " + a.op, functions: [], rows: [] }; },
    ycCdn: async (a) => { window.__calls.push(["ycCdn", a]); return { ok: true, message: "готово: " + a.op, certificates: [], resources: [] }; },
    // Яндекс AI: у него нет ресурсов каталога — только запросы, поэтому и ответы
    // у него «строки», а не списки объектов.
    ycAi: async (a) => {
      window.__calls.push(["ycAi", a]);
      if (a.op === "voices") return { ok: true, voices: [{ id: "alena", lang: "ru-RU" }, { id: "filipp", lang: "ru-RU" }], lines: ["alena — ru-RU", "filipp — ru-RU"], message: "Голоса из облака: 2.", warnings: ["Синтез речи платный: тарифицируется по длине звука."] };
      if (a.op === "translate") return { ok: true, lines: ["→ EN", "   [EN] " + a.text, "→ DE", "   [DE] " + a.text], message: "Переведено на 2 языка — это 2 запроса.", warnings: ["Перевод платный: каждый целевой язык — отдельный запрос."] };
      // AI Studio: список моделей и токены — бесплатны, ответ и вектор — платные;
      // отвечаем теми же формами, что настоящий канал (src/yc-ipc.js).
      if (a.op === "models") return { ok: true, models: [{ id: "yandexgpt-5-lite", kind: "текст" }, { id: "text-search-doc", kind: "векторы" }], lines: ["yandexgpt-5-lite — текст", "text-search-doc — векторы"], message: "Моделей: 2 (список облака).", warnings: ["Ответ модели тарифицируется по токенам — тариф называет действие «Спросить модель» до отправки; токенизация бесплатна."] };
      if (a.op === "tokens") return { ok: true, tokens: 3, lines: ["Токенов: 3 (модель yandexgpt-5-lite)", "Первые токены: Счёт · на"], message: "Токенов: 3.", warnings: ["Токенизация бесплатна. Ориентир цены ответа: YandexGPT Lite 5: 0.2 ₽ за 1000 входящих и 0.2 ₽ за 1000 исходящих токенов; токенизация бесплатна."] };
      if (a.op === "complete") {
        const said = "Модель услышала: " + (a.system ? a.system + " | " : "") + a.prompt;
        return { ok: true, answer: said, usage: { input: 1200, output: 400, total: 1600 }, lines: [said, "—", "Токенов: вход 1200, ответ 400 · версия модели v5.1 · ≈ 0.32 ₽"], message: "Ответ модели yandexgpt-5-lite готов.", warnings: ["Ответ тарифицируется по токенам: YandexGPT Lite 5: 0.2 ₽ за 1000 входящих и 0.2 ₽ за 1000 исходящих токенов; токенизация бесплатна."] };
      }
      if (a.op === "embed") return { ok: true, dims: 256, lines: ["Вектор: 256 чисел (модель text-search-doc)", "Первые числа: 0.001, 0.002, 0.003, …"], message: "Вектор готов: 256 чисел.", warnings: ["Векторизация платная: Векторы: 0.0101 ₽ за 1000 входящих и 0.0101 ₽ за 1000 исходящих токенов; токенизация бесплатна."] };
      return { ok: true, lines: ["готово: " + a.op], message: "готово: " + a.op };
    },
    // Группы машин: тот же контракт, что у остальных каналов действий — строки,
    // предупреждения и needsConfirm на платное. Отвечаем как настоящий канал
    // (src/yc-ipc.js), включая размер группы в вопросе о создании.
    ycIg: async (a) => {
      window.__calls.push(["ycIg", a]);
      if (a.op === "list") {
        return { ok: true, groups: [{ id: "ig1", name: "web" }],
          // Две строки, а не одна с символом перевода строки: страница стенда
          // собирается шаблонной строкой, и обратный слэш-n внутри неё стал бы
          // настоящим переводом строки прямо посреди строкового литерала.
          lines: ["● web — работает · 3 машин(ы) · машин 1/3 (устаревших 1) · 2 vCPU, 2 ГБ · зоны: ru-central1-a", "    id ig1"],
          message: "Групп: 1.",
          warnings: ["У части групп есть машины с устаревшей конфигурацией: группа пересоздаст их сама — это нормальный ход обновления."] };
      }
      if (a.op === "card") {
        return { ok: true, group: { id: "ig1", name: a.group },
          lines: ["● web — работает · 3 машин(ы) · машин 1/3", "Шаблон: standard-v3 · 2 vCPU · 2 ГБ · диск 20 ГБ network-ssd · с публичным адресом",
            "Отдаёт трафик Network Load Balancer: target group tg-nlb-1", "Машины (2):", "  • web-1 — работает, ru-central1-a, внутренний 10.10.0.5, публичный 203.0.113.5", "  • web-2 — работает, конфигурация устарела — будет пересоздана"],
          message: "Группа «web»: работает." };
      }
      if (a.op === "create" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Создание группы машин — решение с ценой: каждая машина группы платит за час работы, как обычная машина Compute Cloud, а группа сама создаёт и пересоздаёт машины. Проверь имя, размер и подсеть, затем подтверди.",
          lines: ["Будет создана группа «" + a.name + "» в каталоге «prod-web».", "Машин: " + a.size + " · на машину: 2 vCPU, 2 ГБ · подсеть: " + a.subnet + "."] };
      }
      if (a.op === "create") {
        return { ok: true, changed: true, groupId: "ig-new",
          lines: ["Группа «" + a.name + "» создаётся: машин " + a.size + ", 2 vCPU и 2 ГБ на машину, зона ru-central1-a."],
          warnings: ["Группа НЕ бесплатна: каждая её машина платит как обычная машина Compute Cloud — за каждый час работы (ориентир: ycCosts)."],
          message: "Группа создаётся." };
      }
      if (a.op === "delete" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Удаление группы «web» необратимо: она будет удалена ВМЕСТЕ с машинами (3 шт.) и их дисками. Снимки нужно сделать заранее. Подтверди удаление.",
          lines: ["● web — работает · 3 машин(ы)"] };
      }
      if (a.op === "delete") {
        return { ok: true, changed: true, deleted: true, groupId: "ig1",
          lines: ["Группа «web» удаляется вместе с машинами (3 шт.) и их дисками — отменить нельзя."],
          warnings: ["Диски машин удаляются вместе с группой: если данные нужны — сними снимки заранее."],
          message: "Группа удаляется." };
      }
      return { ok: true, lines: ["готово: " + a.op], message: "готово: " + a.op };
    },
    // Балансировщик: вход в приложение — и канал у него свой (ycAlb). Отвечаем
    // как настоящий src/yc-ipc.js: строки, needsConfirm на платное, а согласие
    // спрашивает панель — первый запрос уходит БЕЗ confirm.
    ycAlb: async (a) => {
      window.__calls.push(["ycAlb", a]);
      if (a.op === "list") {
        return { ok: true, loadBalancers: [{ id: "lb1", name: "web-lb" }],
          lines: ["● web-lb — работает · HTTP 80 203.0.113.10 · зоны: ru-central1-a", "    id lb1"],
          message: "Балансировщиков: 1." };
      }
      if (a.op === "card") {
        // HTTPS-карточка отдаёт сертификат отдельной строкой (заход 4): срок
        // сертификата — первое, что объясняет «сайт не открывается».
        if (a.lb === "https-lb") {
          return { ok: true, lb: { id: "lb2", name: "https-lb" },
            lines: ["● https-lb — работает · HTTPS/TLS 443 203.0.113.11", "Слушатели (1):", "  • secure — HTTPS/TLS 203.0.113.11:443 → роутер rt-web · сертификатов: 1",
              "Сертификаты HTTPS-слушателей:",
              "  🔒 Слушатель «secure» — site-cert (cert-1) · выпущен · домены: site.example.com · действует до 2027-04-18 (осталось 199 дн.)",
              "  🔒 Слушатель «shop (SNI: shop.example.com)» — shop-cert (cert-4) · выпущен · домены: shop.example.com · действует до 2027-02-27 (осталось 149 дн.)"],
            certificates: [{ listenerName: "secure", certId: "cert-1", cert: { name: "site-cert", statusHuman: "выпущен", domains: ["site.example.com"], daysLeft: 199 } },
              { listenerName: "shop (SNI: shop.example.com)", certId: "cert-4", cert: { name: "shop-cert", statusHuman: "выпущен", domains: ["shop.example.com"], daysLeft: 149 } }],
            message: "Балансировщик «https-lb»: работает." };
        }
        return { ok: true, lb: { id: "lb1", name: a.lb },
          lines: ["● web-lb — работает · HTTP 80 203.0.113.10", "Слушатели (1):", "  • web — HTTP 203.0.113.10:80 → роутер rt-web",
            "Роутер «web-router»:", "  домены: site.example.com · путь /* → группа бэкендов bg-web",
            "Группы целей (1):", "  • web-targets · целей: 2", "    10.10.0.5 (подсеть sub-a)"],
          message: "Балансировщик «web-lb»: работает." };
      }
      if (a.op === "lbnew" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Балансировщик ПЛАТНЫЙ: ресурсные единицы и сам ресурс тарифицируются за час, даже когда трафика нет. Подтверди создание.",
          lines: ["Будет создан балансировщик «" + a.name + "» в каталоге «prod-web».",
            "Слушатель: " + a.listener + " · порт " + a.port + " · зона: по подсети " + a.subnet] };
      }
      if (a.op === "lbnew") {
        return { ok: true, changed: true, lbId: "lb-new",
          lines: ["Балансировщик «" + a.name + "» создаётся: слушатель HTTP, порт " + a.port + ", зона ru-central1-a."],
          warnings: ["Балансировщик платный: он тарифицируется за час, даже когда трафика нет."], message: "Балансировщик создаётся." };
      }
      if (a.op === "lbdel" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Удаление балансировщика «web-lb» необратимо: он уйдёт вместе со слушателями и адресами (203.0.113.10). Подтверди удаление.",
          lines: ["● web-lb — работает · HTTP 80 203.0.113.10"] };
      }
      if (a.op === "lbdel") {
        return { ok: true, changed: true, lbId: "lb1",
          lines: ["Балансировщик «web-lb» удаляется вместе со слушателями и адресами (203.0.113.10) — отменить нельзя."],
          warnings: ["Домен, который смотрел на этот адрес, перестанет открываться."], message: "Балансировщик удаляется." };
      }
      // Состав слушателей и правка самого балансировщика (часть 91, заход 4):
      // добавление уходит ОДНИМ listenerSpec, удаление — именем и только после
      // согласия (канал отвечает needsConfirm), а lbupdate — маской полей.
      if (a.op === "listeneradd") {
        return { ok: true, changed: true, listenerName: a.listenerName, lb: { id: "lb1", name: a.lb },
          lines: ["Балансировщик «" + a.lb + "» получает слушателя «" + a.listenerName + "»: " + (a.listener === "https" ? "HTTPS/TLS" : a.listener === "stream" ? "поток TCP" : "HTTP") + ", порт " + a.port + "."],
          warnings: ["Адрес слушателя выдаёт облако и он же адрес других слушателей: домен вешай на адрес ТОЛЬКО после того, как он появился в карточке (ycDns)."],
          message: "Слушатель добавлен." };
      }
      // Правка слушателя (заход 5): одно действие :updateListener — что не
      // назвали, то осталось прежним, а домены живут в SNI со своими
      // сертификатами.
      if (a.op === "listenerupd") {
        const what = [];
        if (a.port) what.push("порт " + a.port);
        if (a.certificate) what.push("сертификат cert-3");
        if (a.sni === "нет") what.push("домены SNI: убраны");
        else if (a.sni) what.push("домены SNI: shop.example.com");
        return { ok: true, changed: true, listenerName: a.listenerName, fields: ["name", "endpoint_specs", "tls"],
          sni: a.sni && a.sni !== "нет" ? [{ name: "sni-shop-example-com", serverNames: ["shop.example.com"], certificateId: "cert-4" }] : [],
          lines: ["Слушатель «" + a.listenerName + "» балансировщика «" + a.lb + "» обновляется" + (what.length ? ": " + what.join(", ") : " (настройки применены заново)") + "."],
          warnings: ["Сертификат должен оставаться выпущенным: когда он истечёт, HTTPS перестанет отвечать — карточка показывает срок.",
            "SNI-обработчики заменяются ЦЕЛИКОМ: домены, которых нет в списке, убираются вместе со своими сертификатами."],
          message: "Слушатель обновляется." };
      }
      if (a.op === "listenerdel" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Слушатель «" + a.listenerName + "» убирается с балансировщика «" + a.lb + "»: вход по нему закроется, а домен, который на него смотрел, перестанет открываться. Подтверди удаление.",
          lines: ["  • " + a.listenerName + " — HTTP 203.0.113.10:80 → роутер rt-web"] };
      }
      if (a.op === "listenerdel") {
        return { ok: true, changed: true, listenerName: a.listenerName,
          lines: ["Слушатель «" + a.listenerName + "» (HTTP 203.0.113.10:80) убирается у балансировщика «" + a.lb + "» — вход по нему закроется."],
          warnings: ["Адрес 203.0.113.10 освободится, если его не слушает другой слушатель: домен, который на него смотрел, перестанет открываться — сначала поставь запись на новый адрес."],
          message: "Слушатель убран." };
      }
      if (a.op === "lbupdate") {
        return { ok: true, changed: true, lb: { id: "lb1", name: a.newName || a.lb }, fields: ["name", "description", "security_group_ids"],
          lines: ["Балансировщик «" + a.lb + "» обновляется: имя, описание, группы безопасности."],
          warnings: ["Список групп безопасности ЗАМЕНЁН целиком, а не дополнен: правила приёма трафика на порты слушателей должны быть открыты в НОВЫХ группах — иначе вход закроется снаружи."],
          message: "Балансировщик обновляется." };
      }
      // Группа бэкендов (часть 91, заход 3): порт целей и проверки здоровья
      // живут ЗДЕСЬ, здоровье приходит ПО ЗОНАМ, а удаление необратимо.
      if (a.op === "backends" || a.op === "targets") {
        if (a.op === "targets") {
          return { ok: true, targetGroups: [{ id: "tg1", name: "web-targets" }],
            lines: ["• web-targets · целей: 2", "    id tg1"], message: "Групп целей: 1." };
        }
        return { ok: true, backendGroups: [{ id: "bg1", name: "web-backends" }, { id: "bg2", name: "free-backends" }],
          lines: ["• web-backends · HTTP · бэкендов: 1 · группы целей: tg-web · проверок здоровья: 1", "    id bg1",
            "• free-backends · поток TCP · бэкендов: 1 · группы целей: tg-web"],
          warnings: ["Порт целей и проверки здоровья задаются в ГРУППЕ БЭКЕНДОВ, а не в группе целей: создание — backnew, а здоровье целей показывает действие health."],
          message: "Групп бэкендов: 2." };
      }
      if (a.op === "health") {
        return { ok: true, lb: { id: "lb1", name: a.lb }, backendGroup: { id: "bg1", name: "web-backends" }, targetGroup: { id: "tg1", name: a.targetGroup },
          states: [
            { ipAddress: "10.10.0.5", zones: [{ zoneId: "ru-central1-a", status: "HEALTHY", statusHuman: "здорова" }], healthy: true },
            { ipAddress: "10.10.0.6", zones: [{ zoneId: "ru-central1-a", status: "HEALTHY", statusHuman: "здорова" }, { zoneId: "ru-central1-b", status: "UNHEALTHY", statusHuman: "не отвечает", failedActiveHc: true }], healthy: false },
          ],
          healthy: 1,
          lines: ["Здоровье целей группы «" + a.targetGroup + "» (группа бэкендов «web-backends», балансировщик «" + a.lb + "»):",
            "  • 10.10.0.5 (подсеть sub-a) — ru-central1-a: здорова",
            "  • 10.10.0.6 (подсеть sub-a) — ru-central1-a: здорова · ru-central1-b: не отвечает (не проходит активную проверку)",
            "Целей: 2 · здоровых: 1."],
          warnings: ["В маршрут попадут только здоровые цели: проверь машины, порт целей и путь проверки в группе бэкендов."],
          message: "Здоровье целей «" + a.targetGroup + "»: целей 2, здоровых 1." };
      }
      if (a.op === "backnew") {
        return { ok: true, changed: true, backendGroup: { id: "bg-new", name: a.name }, groupId: "bg-new",
          lines: ["Группа бэкендов «" + a.name + "» создаётся: " + (a.kind === "stream" ? "поток TCP" : a.kind === "grpc" ? "gRPC" : "HTTP") + ", бэкенд «main» — порт " + a.port + ", группа целей «" + a.targetGroup + "»" + (a.healthPath ? ", проверка здоровья " + a.healthPath : "") + "."],
          warnings: a.healthPath
            ? ["Дальше: маршрут роутера (routernew, backendGroup) или потоковый слушатель балансировщика (lbnew, listener «stream»)."]
            : ["Проверки здоровья не заданы: облако будет считать цель здоровой всегда — упавшая машина останется в ротации. Путь проверки задаётся полем healthPath (например, «/»)."],
          message: "Группа бэкендов создаётся." };
      }
      if (a.op === "backdel" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Удаление группы бэкендов «web-backends» необратимо: проверки здоровья и настройки балансировки будут потеряны, а роутер или потоковый слушатель, который на неё смотрит, перестанет отвечать. Подтверди удаление.",
          lines: ["• web-backends · HTTP · бэкендов: 1 · группы целей: tg-web"] };
      }
      if (a.op === "backdel") {
        return { ok: true, changed: true, groupId: "bg1",
          lines: ["Группа бэкендов «" + (a.group || "web-backends") + "» удаляется: проверки здоровья и настройки балансировки будут потеряны."],
          warnings: ["Группы целей, машины и роутеры не трогаются: удаляется только связка «какие цели и как проверять»."],
          message: "Группа бэкендов удаляется." };
      }
      return { ok: true, lines: ["готово: " + a.op], message: "готово: " + a.op };
    },
    // Managed-базы: один канал на три базы — какая именно, видно по полю engine,
    // которое семейство подставляет само. Отвечаем как настоящий канал
    // (src/yc-ipc.js): create и delete без согласия отвечают needsConfirm, а
    // create с согласием отдаёт пароль ровно один раз.
    ycMdb: async (a) => {
      window.__calls.push(["ycMdb", a]);
      if (a.op === "presets") return { ok: true, presets: [{ id: "s2.micro", cores: 2 }], lines: ["s2.micro — 2 vCPU, 4 ГБ"] };
      if (a.op === "list") {
        const lines = {
          postgresql: ["● pg-1 — работает · PostgreSQL 16 · ru-central1-a", "○ pg-prot — остановлен · PostgreSQL 15 · защита от удаления"],
          mysql: ["● my-1 — работает · MySQL 8.0 · ru-central1-a"],
          clickhouse: ["● ch-1 — работает · ClickHouse 24.8 · ru-central1-a"]
        }[a.engine] || [];
        return { ok: true, engine: a.engine, clusters: [], lines: lines, message: "Кластеров: " + lines.length + ".",
          warnings: a.engine === "postgresql" ? ["Остановленный кластер дешевле, но не бесплатен: диск и резервные копии тарифицируются и у него."] : [] };
      }
      if (a.op === "create" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Создание кластера PostgreSQL — платное и необратимое решение: класс " + a.preset + " и диск " + a.diskGb + " ГБ тарифицируются почасово.",
          lines: ["Будет создан кластер: " + a.name + " — каталог prod-web.", "Версия: " + a.version + " · класс: " + a.preset + " · зона: " + a.zone + "."] };
      }
      if (a.op === "create") {
        return { ok: true, changed: true, secret: "PG-PASS-77", secretLabel: "Пароль пользователя базы — показывается один раз",
          lines: ["Кластер " + a.name + " создаётся — операция пошла, состояние видно в карточке."],
          warnings: ["Кластер тарифицируется почасово, пока существует."], message: "Кластер создаётся." };
      }
      if (a.op === "delete" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Удаление кластера pg-1 НЕОБРАТИМО: вместе с кластером уйдут его базы и резервные копии.",
          lines: ["Кластер: pg-1 · PostgreSQL 16 · состояние: работает"] };
      }
      if (a.op === "delete") {
        return { ok: true, deleted: true, message: "Кластер удаляется.",
          lines: ["Кластер pg-1 удаляется — операция пошла. Резервные копии уйдут вместе с ним."] };
      }
      return { ok: true, lines: ["готово: " + a.op], message: "готово: " + a.op };
    },
    // DNS-зоны и записи: тот же канал, что у карточки зоны, но с полным набором
    // действий. Отвечаем как настоящий (src/yc-ipc.js): удаление без согласия —
    // needsConfirm и с показом самой записи, а запись отвечает словами облака.
    ycDns: async (a) => {
      window.__calls.push(["ycDns", a]);
      if (a.op === "zones") return { ok: true, zones: [{ id: "dns-z1", name: "example.com." }], lines: ["example.com. — id dns-z1"], message: "Зон: 1." };
      if (a.op === "records") return { ok: true, lines: ["Зона «example.com.» (dns-z1)", "A www.example.com. (TTL 300) → 1.1.1.1"], message: "Записей: 1." };
      if (a.op === "add") {
        return { ok: true,
          lines: ["✅ Запись добавлена: A " + a.name + " (TTL " + a.ttl + ") → " + a.values, "Зона «example.com.» (dns-z1)"],
          warnings: ["Обновление DNS в интернете занимает от минуты до часов — сразу после добавления запись может ещё не отвечать."],
          message: "Запись добавлена." };
      }
      if (a.op === "delete" && a.confirm !== true) {
        return { ok: false, needsConfirm: true,
          error: "Удаление остановит всё, что на эту запись смотрит: домен или сайт может перестать открываться, а почта — приходить.",
          lines: ["Запись: A www.example.com. (TTL 300) → 1.1.1.1", "Зона «example.com.» (dns-z1)"] };
      }
      if (a.op === "delete") {
        return { ok: true, deleted: true, message: "Запись удалена.",
          lines: ["🗑 Запись удалена: A www.example.com. (значений было 1)", "Зона «example.com.» (dns-z1)"] };
      }
      return { ok: true, lines: ["готово: " + a.op], message: "готово: " + a.op };
    }
  };
  // Модуль действий (как yc-console) берёт каналы из window.api — в приложении их
  // выставляет preload.js. В стенде ставим сами.
  window.api = api;
  window.__ready = false;
  const built = window.YcPanel({
    $: (id) => document.getElementById(id),
    api, isElectron: true,
    toast() {}, termAppend() {}, confirmModal() {}, inputDialog() {},
    openSettings() {}, openSidePanel() {},
    getSettings: () => ({ ycFolderId: "b1g" })
  });
  document.getElementById("sp-cloud").classList.remove("hidden");
  built.loadDashboard(true).then(() => setTimeout(() => { window.__ready = true; }, 40));
</script>
</body></html>`;

const SHOT = path.join(os.tmpdir(), "yc-panel-" + process.pid + ".html");
fs.writeFileSync(SHOT, PAGE, "utf8");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  try {
    await page.goto("file://" + SHOT.split(path.sep).join("/"));

    section("[1] Панель собралась");
    await page.waitForFunction("window.__ready === true", null, { timeout: 10000 });
    ok(errors.length === 0, "страница без ошибок", errors.join(" | "));

    section("[2] Геометрия: иконки, колонки, никаких вылезаний");
    const info = await page.evaluate(() => {
      const panel = document.getElementById("sp-cloud");
      const tiles = [...document.querySelectorAll("#yc-dash .yc-tile")];
      const grid = document.querySelector("#yc-dash .yc-grid");
      const logo = document.querySelector("#yc-dash .yc-tile-logo svg");
      const brand = document.querySelector("#yc-brand-mark svg");
      return {
        tiles: tiles.length,
        icons: document.querySelectorAll("#yc-dash .yc-tile-logo svg").length,
        columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
        logo: logo ? logo.getBoundingClientRect() : null,
        brand: brand ? brand.getBoundingClientRect() : null,
        tileWidth: Math.round(tiles[0].getBoundingClientRect().width),
        gridWidth: Math.round(grid.getBoundingClientRect().width),
        tileBg: getComputedStyle(tiles[0]).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        summaryText: document.getElementById("yc-summary").textContent,
        credit: document.getElementById("yc-credit").textContent,
        overflow: [...panel.querySelectorAll("*")]
          .filter((el) => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible")
          .map((el) => el.className + ":" + el.scrollWidth + ">" + el.clientWidth)
          .slice(0, 6),
      };
    });
    ok(info.tiles === 13, "плиток столько же, сколько сервисов (тринадцать)", String(info.tiles));
    ok(info.icons === 13, "у каждой плитки своя официальная иконка", String(info.icons));
    ok(info.columns === 2, "полка в две колонки при ширине панели 460px", "колонок: " + info.columns);
    ok(
      info.logo && Math.round(info.logo.width) === 32 && Math.round(info.logo.height) === 32,
      "иконка сервиса ровно 32×32 и не растянута",
      info.logo ? Math.round(info.logo.width) + "×" + Math.round(info.logo.height) : "нет иконки"
    );
    ok(
      info.brand && Math.round(info.brand.width) === 19 && Math.round(info.brand.height) === 19,
      "знак платформы отрисован (~19×19)",
      info.brand ? Math.round(info.brand.width) + "×" + Math.round(info.brand.height) : "нет знака"
    );
    ok(info.tileWidth < info.gridWidth, "плитка не вылезает из полки", info.tileWidth + " / " + info.gridWidth);
    ok(info.overflow.length === 0, "по горизонтали ничего не вылезает", info.overflow.join(", "));

    section("[3] Глубина сделана светом, а не тенью");
    ok(info.tileBg !== info.bodyBg, "плитка светлее фона окна", info.tileBg + " vs " + info.bodyBg);

    section("[4] Строка здоровья и честный подвал");
    ok(
      /Баланс 1 234,56 ₽/.test(info.summaryText) && /Хвосты 2 · 461,50 ₽\/мес/.test(info.summaryText),
      "баланс и хвосты в рублях на месте",
      info.summaryText
    );
    ok(/не является продуктом Яндекс\.Облака/.test(info.credit), "в подвале сказано, что это не продукт Яндекс.Облака", info.credit);

    section("[5] Фильтр и поиск живьём");
    const errOnly = await page.evaluate(() => {
      document.querySelector('.yc-filter-btn[data-flt="err"]').click();
      return [...document.querySelectorAll("#yc-dash .yc-tile-name")].map((n) => n.textContent);
    });
    ok(errOnly.length === 1 && /Секреты/.test(errOnly[0]), "фильтр «Ошибки» оставляет только упавший сервис", errOnly.join(", "));

    const searched = await page.evaluate(() => {
      document.querySelector('.yc-filter-btn[data-flt="all"]').click();
      const s = document.getElementById("yc-search");
      s.value = "функц"; // ищем по тому, что НАПИСАНО на плитке
      s.dispatchEvent(new Event("input"));
      const one = [...document.querySelectorAll("#yc-dash .yc-tile-name")].map((n) => n.textContent);
      s.value = "cloud functions"; // и по официальному имени тоже
      s.dispatchEvent(new Event("input"));
      const two = [...document.querySelectorAll("#yc-dash .yc-tile-name")].map((n) => n.textContent);
      s.value = "";
      s.dispatchEvent(new Event("input"));
      return { ru: one, en: two };
    });
    ok(searched.ru.length === 1 && /Функции/.test(searched.ru[0]), "поиск находит плитку по русскому имени", searched.ru.join(", "));
    ok(searched.en.length === 1 && /Функции/.test(searched.en[0]), "поиск находит её же по официальному имени", searched.en.join(", "));

    section("[6] Хвосты раскрываются списком");
    const leaks = await page.evaluate(async () => {
      const chip = [...document.querySelectorAll("#yc-summary .yc-chip")].find((c) => /Хвосты/.test(c.textContent));
      chip.click();
      await new Promise((r) => setTimeout(r, 30));
      const box = document.querySelector("#yc-summary .yc-leaks");
      return box ? box.textContent : "";
    });
    ok(
      /диск data-old/.test(leaks) && /≈ 310,50 ₽/.test(leaks) && /удали диск/.test(leaks),
      "в каждом хвосте есть цена и ответ «что делать»",
      leaks.slice(0, 140)
    );

    section("[7] Раскрытая плитка занимает строку полки");
    const expanded = await page.evaluate(async () => {
      document.querySelector("#yc-dash .yc-tile").click();
      await new Promise((r) => setTimeout(r, 30));
      const open = document.querySelector("#yc-dash .yc-tile.open");
      const grid = document.querySelector("#yc-dash .yc-grid");
      return open && grid
        ? {
            width: Math.round(open.getBoundingClientRect().width),
            grid: Math.round(grid.getBoundingClientRect().width),
            rows: document.querySelectorAll("#yc-dash .yc-item").length,
          }
        : null;
    });
    ok(
      expanded && expanded.rows === 3 && Math.abs(expanded.width - expanded.grid) < 2,
      "плитка раскрылась на всю строку и показала ресурсы",
      JSON.stringify(expanded)
    );

    section("[8] Действия служб прямо в панели");
    const actBar = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /Виртуальные машины/.test(t.textContent));
      const btn = tile && [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      return {
        opens: !!btn,
        visible: !!box && !box.classList.contains("hidden"),
        listed: box ? [...box.querySelectorAll(".yc-act-btn")].map((b) => b.textContent) : [],
        shelfHidden: document.getElementById("yc-dash").classList.contains("hidden"),
      };
    });
    ok(actBar.opens, "у плитки «Виртуальные машины» есть кнопка действий");
    ok(actBar.visible && actBar.shelfHidden, "действия заняли панель вместо полки", JSON.stringify(actBar));
    ok(
      actBar.listed.some((t) => /Создать машину/.test(t)) && actBar.listed.some((t) => /Удалить машину/.test(t)),
      "в списке есть и создание, и удаление машины",
      actBar.listed.join(", ")
    );

    const listed = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Машины, диски и хвосты/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 60));
      return document.getElementById("yc-act-out").textContent;
    });
    ok(/web-1/.test(listed) && /1\.2\.3\.4/.test(listed), "список машин ответил словами облака", listed.slice(0, 120));
    ok(/диски без машины/.test(listed) && /платят каждый час/i.test(listed), "в ответе есть платный хвост и предупреждение", listed.slice(0, 200));

    // Платное: цена показывается ДО согласия, а согласие уходит только вторым нажатием.
    const paid = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать машину/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = row.querySelector(".yc-act-label").textContent;
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/Имя машины/.test(label)) input.value = "web-2";
        if (/Набор конфигурации/.test(label)) input.value = "small";
        if (/Подсеть/.test(label)) input.value = "app-subnet";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 60));
      const first = document.getElementById("yc-act-out").textContent;
      const sent = window.__calls.filter((c) => c[0] === "ycCompute" && c[1].op === "create").slice(-1)[0];
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      const fieldsForm = { name: sent ? sent[1].name : "", preset: sent ? sent[1].preset : "", subnet: sent ? sent[1].subnet : "", confirmed: sent ? sent[1].confirmed : null };
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const after = window.__calls.filter((c) => c[0] === "ycCompute" && c[1].op === "create")[0] || null;
      const last = window.__calls.filter((c) => c[0] === "ycCompute" && c[1].op === "create").slice(-1)[0];
      return {
        fieldsForm,
        asked: /Нужно согласие/.test(first) && /1 200/.test(first),
        afterText: document.getElementById("yc-act-out").textContent,
        confirmedSent: last ? last[1].confirmed === true : false,
        firstWasUnconfirmed: after ? after[1].confirmed === undefined : false,
      };
    });
    ok(paid.fieldsForm.name === "web-2" && paid.fieldsForm.preset === "small" && paid.fieldsForm.confirmed === undefined, "форма собрала запрос без согласия", JSON.stringify(paid.fieldsForm));
    ok(paid.asked, "платное сначала показало цену и спросило согласие");
    ok(paid.firstWasUnconfirmed && paid.confirmedSent, "согласие ушло только вторым нажатием", JSON.stringify(paid));
    ok(/Машина «web-2» создана/.test(paid.afterText), "после согласия показан ответ облака", paid.afterText.slice(0, 120));

    // Необратимое спрашивается у человека ДО запроса.
    const danger = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      // После ответа панель остаётся на форме — возвращаемся к списку действий.
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить машину/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = row.querySelector(".yc-act-label").textContent;
        const input = row.querySelector("input, select, textarea");
        if (input && /Машина/.test(label)) input.value = "web-1";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycCompute" && c[1].op === "delete").slice(-1)[0];
      return { asked: window.__confirmCalls > before, name: sent ? sent[1].name : "", text: document.getElementById("yc-act-out").textContent };
    });
    ok(danger.asked && danger.name === "web-1", "удаление спросило подтверждение и назвало машину", JSON.stringify(danger));
    ok(/удалена/.test(danger.text), "ответ об удалении показан", danger.text.slice(0, 120));

    // Секрет: только в отдельной рамке и только один раз.
    const secret = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /Сервисные аккаунты/.test(t.textContent));
      // Панель занята действиями — возвращаемся к полке и заново открываем.
      document.querySelector("#yc-actions .yc-act-back").click();
      await new Promise((r) => setTimeout(r, 40));
      const t2 = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /Сервисные аккаунты/.test(t.textContent));
      [...t2.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать ключ/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = row.querySelector(".yc-act-label").textContent;
        const input = row.querySelector("input, select, textarea");
        if (input && /аккаунт/i.test(label)) input.value = "deploy-bot";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const out = document.getElementById("yc-act-out");
      const valueBox = out.querySelector(".yc-act-secret-value");
      const linesText = [...out.querySelectorAll(".yc-act-line, .yc-act-log-line")].map((l) => l.textContent).join(" | ");
      return {
        shown: valueBox ? valueBox.textContent : "",
        warnOnce: /показывается один раз/.test(out.textContent),
        inLines: linesText.indexOf("SECRET-42") >= 0,
        kind: (window.__calls.filter((c) => c[0] === "ycIam" && c[1].op === "newkey").slice(-1)[0] || [{}, {}])[1].kind || "",
      };
    });
    ok(secret.shown === "SECRET-42", "секрет ключа показан в отдельной рамке", JSON.stringify(secret));
    ok(secret.warnOnce, "рядом сказано, что он показывается один раз");
    ok(!secret.inLines, "секрета нет в строках ответа и в журнале");
    ok(secret.kind === "access", "вид ключа ушёл в облако", secret.kind);

    // ── Яндекс AI: у него нет плитки (списка ресурсов у перевода не бывает),
    // поэтому вход — чип в строке здоровья, и он обязан работать ЖИВЬЁМ.
    section("[9] Яндекс AI в панели: чип, форма и ответ");
    const aiChip = await page.evaluate(() => {
      const chip = [...document.querySelectorAll("#yc-summary .yc-chip")].find((c) => /Яндекс AI/.test(c.textContent));
      return { exists: !!chip, link: !!chip && chip.classList.contains("yc-chip-link") };
    });
    ok(aiChip.exists && aiChip.link, "в строке здоровья есть чип «Яндекс AI» и он кликабелен", JSON.stringify(aiChip));

    const aiOpen = await page.evaluate(async () => {
      const chip = [...document.querySelectorAll("#yc-summary .yc-chip")].find((c) => /Яндекс AI/.test(c.textContent));
      chip.click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      return {
        visible: !!box && !box.classList.contains("hidden"),
        title: box ? (box.querySelector(".yc-act-title") || {}).textContent : "",
        listed: box ? [...box.querySelectorAll(".yc-act-btn")].map((b) => b.textContent) : [],
      };
    });
    ok(aiOpen.visible && /Яндекс AI/.test(aiOpen.title || ""), "чип открыл действия Яндекс AI", JSON.stringify(aiOpen));
    ok(
      aiOpen.listed.some((t) => /Перевести/.test(t)) && aiOpen.listed.some((t) => /Снимок или PDF/.test(t)) && aiOpen.listed.some((t) => /Озвучить/.test(t)),
      "в списке есть перевод, снимок и озвучка",
      aiOpen.listed.join(", ")
    );

    const aiRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Перевести/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = row.querySelector(".yc-act-label").textContent;
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Текст/.test(label)) input.value = "Привет";
        if (/Языки перевода/.test(label)) input.value = "en, de";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "translate").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiRun.args && aiRun.args.text === "Привет" && aiRun.args.targets === "en, de", "форма перевода ушла с текстом и языками", JSON.stringify(aiRun.args));
    ok(/\[EN\] Привет/.test(aiRun.text) && /\[DE\] Привет/.test(aiRun.text) && /платный/.test(aiRun.text), "ответ панели показал оба языка и назвал тариф", aiRun.text.slice(0, 140));

    const aiVoices = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Голоса SpeechKit/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "voices").slice(-1)[0];
      return { called: !!sent, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiVoices.called && /alena/.test(aiVoices.text) && /filipp/.test(aiVoices.text), "голоса спрашиваются без формы и показываются списком", aiVoices.text.slice(0, 140));

    // ── Managed-базы: три плитки, один канал (src/yc-mdb.js + yc:mdb) ────────
    // У трёх баз один API, а значит и один канал: какая это база, видно только
    // по полю engine, которое подставляет семейство (FAMILIES[...].fixed).
    // Проверяем живьём: плитки и иконки, свой engine у каждой, цену до согласия
    // и пароль одной рамкой, дважды спрошенное удаление.
    section("[10] Managed-базы: PostgreSQL, MySQL и ClickHouse");
    const dbTiles = await page.evaluate(() => {
      const names = ["База PostgreSQL", "База MySQL", "База ClickHouse"];
      return names.map((n) => {
        const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => t.textContent.indexOf(n) >= 0);
        const btn = tile && [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent));
        return { n: n, tile: !!tile, icon: !!(tile && tile.querySelector(".yc-tile-logo svg")), btn: !!btn };
      });
    });
    ok(dbTiles.every((t) => t.tile && t.icon && t.btn), "три плитки баз на месте, со своими иконками и кнопкой действий", JSON.stringify(dbTiles));

    const dbLists = await page.evaluate(async () => {
      const pairs = [["База PostgreSQL", "postgresql"], ["База MySQL", "mysql"], ["База ClickHouse", "clickhouse"]];
      const out = [];
      for (const pair of pairs) {
        const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => t.textContent.indexOf(pair[0]) >= 0);
        [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent)).click();
        await new Promise((r) => setTimeout(r, 40));
        const box = document.getElementById("yc-actions");
        const title = (box.querySelector(".yc-act-title") || {}).textContent || "";
        [...box.querySelectorAll(".yc-act-btn")].find((b) => /^Кластеры/.test(b.textContent)).click();
        await new Promise((r) => setTimeout(r, 60));
        const sent = window.__calls.filter((c) => c[0] === "ycMdb" && c[1].op === "list").slice(-1)[0];
        out.push({ engine: pair[1], title: title, sentEngine: sent ? sent[1].engine : "", text: document.getElementById("yc-act-out").textContent });
        box.querySelector(".yc-act-back").click();
        await new Promise((r) => setTimeout(r, 40));
      }
      return out;
    });
    ok(dbLists.every((x) => new RegExp(x.engine === "clickhouse" ? "ClickHouse" : x.engine === "mysql" ? "MySQL" : "PostgreSQL").test(x.title) && x.sentEngine === x.engine),
      "каждая плитка зовёт свой engine, а не общий", JSON.stringify(dbLists.map((x) => x.title + " → " + x.sentEngine)));
    ok(/pg-1/.test(dbLists[0].text) && /pg-prot/.test(dbLists[0].text) && /тарифицируются и у него/.test(dbLists[0].text),
      "список PostgreSQL отвечает словами облака и предупреждает про остановленный кластер", dbLists[0].text.slice(0, 160));
    ok(/my-1/.test(dbLists[1].text) && /ch-1/.test(dbLists[2].text), "списки MySQL и ClickHouse называли свои кластеры");

    const dbCreate = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => t.textContent.indexOf("База PostgreSQL") >= 0);
      [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать кластер/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 60));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/Имя кластера/.test(label)) input.value = "pg-2";
        if (/Класс хоста/.test(label)) input.value = "s2.micro";
        if (/Подсеть/.test(label)) input.value = "app-subnet";
      }
      const presetOptions = [...form.querySelectorAll("#yc-act-dl-preset option")].map((o) => o.value);
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const first = window.__calls.filter((c) => c[0] === "ycMdb" && c[1].op === "create").slice(-1)[0] || null;
      const askedText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const last = window.__calls.filter((c) => c[0] === "ycMdb" && c[1].op === "create").slice(-1)[0] || null;
      const out = document.getElementById("yc-act-out");
      const valueBox = out.querySelector(".yc-act-secret-value");
      const linesText = [...out.querySelectorAll(".yc-act-line, .yc-act-log-line")].map((l) => l.textContent).join(" | ");
      return {
        presetOptions: presetOptions,
        firstEngine: first ? first[1].engine : "",
        firstName: first ? first[1].name : "",
        firstConfirmed: first ? first[1].confirm : null,
        asked: /Нужно согласие/.test(askedText) && /тарифицируются почасово/.test(askedText),
        confirmSent: last ? last[1].confirm === true : false,
        secret: valueBox ? valueBox.textContent : "",
        warnOnce: /показывается один раз/.test(out.textContent),
        inLines: linesText.indexOf("PG-PASS-77") >= 0,
        text: out.textContent,
      };
    });
    ok(dbCreate.presetOptions.indexOf("s2.micro") >= 0, "подсказки классов хостов пришли из облака (engine работает и в подсказках)", JSON.stringify(dbCreate.presetOptions.slice(0, 5)));
    ok(dbCreate.firstEngine === "postgresql" && dbCreate.firstName === "pg-2" && dbCreate.firstConfirmed === undefined,
      "форма собрала создание без согласия и со своим engine", JSON.stringify({ engine: dbCreate.firstEngine, name: dbCreate.firstName, confirmed: dbCreate.firstConfirmed }));
    ok(dbCreate.asked, "создание сначала показало цену и спросило согласие", dbCreate.text.slice(0, 160));
    ok(dbCreate.confirmSent && /pg-2/.test(dbCreate.text) && /создаётся/.test(dbCreate.text), "согласие ушло вторым нажатием, и облако ответило", dbCreate.text.slice(0, 160));
    ok(dbCreate.secret === "PG-PASS-77" && dbCreate.warnOnce && !dbCreate.inLines,
      "пароль показан один раз отдельной рамкой и не попал в строки ответа", JSON.stringify({ secret: dbCreate.secret, warnOnce: dbCreate.warnOnce, inLines: dbCreate.inLines }));

    const dbDelete = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить кластер/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Кластер/.test(label)) input.value = "pg-1";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycMdb" && c[1].op === "delete").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const last = window.__calls.filter((c) => c[0] === "ycMdb" && c[1].op === "delete").slice(-1)[0] || null;
      return {
        askedHuman: askedHuman,
        askedCloud: /НЕОБРАТИМО/.test(warnText) && /pg-1/.test(warnText),
        firstConfirmed: first ? first[1].confirm : null,
        confirmSent: last ? last[1].confirm === true : false,
        text: document.getElementById("yc-act-out").textContent,
      };
    });
    ok(dbDelete.askedHuman && dbDelete.askedCloud, "удаление спросило человека до запроса, а облако — до выполнения", JSON.stringify({ human: dbDelete.askedHuman, cloud: dbDelete.askedCloud }));
    ok(dbDelete.firstConfirmed === undefined && dbDelete.confirmSent, "согласие облаку ушло только вторым нажатием", JSON.stringify({ first: dbDelete.firstConfirmed, last: dbDelete.confirmSent }));
    ok(/pg-1/.test(dbDelete.text) && /Резервные копии/.test(dbDelete.text), "ответ об удалении показан словами облака", dbDelete.text.slice(0, 160));

    // ── DNS-зоны и записи (часть 89) ────────────────────────────────────────
    // У сервиса были агент и форма в карточке зоны, а у плитки действий не
    // было вовсе. Проверяем живьём: действия у плитки появились, «Зоны и
    // записи» зовёт канал, форма собирает запись (зона, тип, TTL, значения),
    // а удаление спрашивает человека И облако — и показывает саму запись.
    section("[11] DNS-зоны: плитка действий, запись и подтверждение удаления");
    const dnsTile = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /DNS-зоны/.test(t.textContent));
      const btn = tile && [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      const title = box ? (box.querySelector(".yc-act-title") || {}).textContent : "";
      const listed = box ? [...box.querySelectorAll(".yc-act-btn")].map((b) => b.textContent) : [];
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /^Зоны и записи/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 60));
      const sent = window.__calls.filter((c) => c[0] === "ycDns" && c[1].op === "zones").slice(-1)[0];
      return { btn: !!btn, title: title, listed: listed, called: !!sent, text: document.getElementById("yc-act-out").textContent };
    });
    ok(dnsTile.btn && /DNS-зоны/.test(dnsTile.title || ""), "у плитки «DNS-зоны» есть кнопка действий", JSON.stringify({ btn: dnsTile.btn, title: dnsTile.title }));
    ok(
      dnsTile.listed.some((t) => /Добавить или заменить запись/.test(t)) && dnsTile.listed.some((t) => /Удалить запись/.test(t)),
      "в списке есть и постановка, и удаление записи",
      dnsTile.listed.join(", ")
    );
    ok(dnsTile.called && /example\.com\. — id dns-z1/.test(dnsTile.text), "действие «Зоны и записи» позвало канал и показало зону", dnsTile.text.slice(0, 160));

    const dnsAdd = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Добавить или заменить запись/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/Зона/.test(label)) input.value = "example.com.";
        if (/Имя записи/.test(label)) input.value = "new.example.com.";
        if (/Тип/.test(label)) input.value = "A";
        if (/TTL/.test(label)) input.value = "300";
        if (/Значения/.test(label)) input.value = "203.0.113.9, 203.0.113.10";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycDns" && c[1].op === "add").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(
      dnsAdd.args && dnsAdd.args.zone === "example.com." && dnsAdd.args.name === "new.example.com." && dnsAdd.args.type === "A" && Number(dnsAdd.args.ttl) === 300 && /203\.0\.113\.9/.test(String(dnsAdd.args.values)),
      "форма собрала запись с зоной, именем, типом, TTL и значениями",
      JSON.stringify(dnsAdd.args)
    );
    ok(/203\.0\.113\.9/.test(dnsAdd.text) && /от минуты до часов/.test(dnsAdd.text), "ответ показал запись и предупредил про распространение", dnsAdd.text.slice(0, 180));

    const dnsDel = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить запись/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/Зона/.test(label)) input.value = "example.com.";
        if (/Имя записи/.test(label)) input.value = "www.example.com.";
        if (/Тип/.test(label)) input.value = "A";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycDns" && c[1].op === "delete").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 80));
      const last = window.__calls.filter((c) => c[0] === "ycDns" && c[1].op === "delete").slice(-1)[0] || null;
      return {
        askedHuman: askedHuman,
        firstConfirm: first ? first[1].confirm : null,
        name: first ? first[1].name : "",
        confirmSent: last ? last[1].confirm === true : false,
        warnText: warnText,
        text: document.getElementById("yc-act-out").textContent,
      };
    });
    ok(dnsDel.askedHuman && dnsDel.name === "www.example.com." && /перестать открываться|приходить/.test(dnsDel.warnText), "удаление спросило человека и объяснило последствия", JSON.stringify({ human: dnsDel.askedHuman, name: dnsDel.name }).slice(0, 160));
    ok(/A www\.example\.com\./.test(dnsDel.warnText), "перед удалением панель назвала саму запись");
    ok(dnsDel.firstConfirm === undefined && dnsDel.confirmSent, "согласие облаку ушло только вторым нажатием", JSON.stringify({ first: dnsDel.firstConfirm, last: dnsDel.confirmSent }));
    ok(/удалена/.test(dnsDel.text), "ответ об удалении показан словами облака", dnsDel.text.slice(0, 160));

    // ── AI Studio в панели (часть 90) ──────────────────────────────────────
    // Модели AI Studio жили в окне только провайдером чата; у ОБЛАЧНОЙ панели их
    // не было. Проверяем живьём: список действий вырос до одиннадцати, у AI
    // Studio четыре своих кнопки, форма собирает аргументы, а ответ показывает
    // бесплатные токены, цену ответа и размерность вектора.
    section("[12] AI Studio в панели: модели, токены, ответ и вектор");
    const aiList = await page.evaluate(async () => {
      const chip = [...document.querySelectorAll("#yc-summary .yc-chip")].find((c) => /Яндекс AI/.test(c.textContent));
      chip.click();
      await new Promise((r) => setTimeout(r, 40));
      return [...document.querySelectorAll("#yc-actions .yc-act-btn")].map((b) => b.textContent.trim());
    });
    ok(aiList.length === 11, "в семействе Яндекс AI одиннадцать действий: " + aiList.length);
    ok(
      aiList.some((t) => /Модели AI Studio/.test(t)) && aiList.some((t) => /Токены текста/.test(t)) && aiList.some((t) => /Спросить модель/.test(t)) && aiList.some((t) => /Вектор текста/.test(t)),
      "четыре действия AI Studio на месте: " + aiList.join(", ")
    );

    const aiModelsRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Модели AI Studio/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "models").slice(-1)[0];
      return { called: !!sent, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiModelsRun.called && /yandexgpt-5-lite/.test(aiModelsRun.text) && /text-search-doc/.test(aiModelsRun.text), "список моделей спрашивается без формы и показывается строками", aiModelsRun.text.slice(0, 160));

    const aiTokensRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Токены текста/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Текст/.test(label)) input.value = "Счёт на четыре тысячи рублей";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "tokens").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiTokensRun.args && /четыре тысячи/.test(String(aiTokensRun.args.text)) && aiTokensRun.args.model === "yandexgpt-5-lite", "форма токенов ушла с текстом и моделью по умолчанию", JSON.stringify(aiTokensRun.args));
    ok(/Токенов: 3/.test(aiTokensRun.text) && /бесплатн/.test(aiTokensRun.text), "ответ показал токены и назвал бесплатность", aiTokensRun.text.slice(0, 160));

    const aiCompleteRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Спросить модель/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/Роль/.test(label)) input.value = "Отвечай коротко";
        if (/^Запрос/.test(label)) input.value = "Сколько будет 2+2?";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "complete").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiCompleteRun.args && aiCompleteRun.args.system === "Отвечай коротко" && aiCompleteRun.args.prompt === "Сколько будет 2+2?", "форма ответа собрала роль и запрос", JSON.stringify(aiCompleteRun.args));
    ok(/Модель услышала/.test(aiCompleteRun.text) && /≈ 0\.32 ₽/.test(aiCompleteRun.text), "ответ панели показал текст модели и цену", aiCompleteRun.text.slice(0, 200));

    const aiEmbedRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Вектор текста/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Текст/.test(label)) input.value = "договор поставки";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 80));
      const sent = window.__calls.filter((c) => c[0] === "ycAi" && c[1].op === "embed").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(aiEmbedRun.args && aiEmbedRun.args.text === "договор поставки" && aiEmbedRun.args.model === "text-search-doc", "форма вектора ушла с текстом и моделью документов", JSON.stringify(aiEmbedRun.args));
    ok(/256 чисел/.test(aiEmbedRun.text), "ответ показал размерность вектора", aiEmbedRun.text.slice(0, 160));

    // ── Группы машин в панели (часть 91) ──────────────────────────────────
    // Группа — не «несколько машин»: у неё своё семейство действий, и панель
    // обязана показать и счёт машин (в том числе устаревших, которые группа
    // пересоздаст), и цену создания ДО согласия, и необратимость удаления.
    section("[13] Группы машин: плитка действий, создание с ценой и удаление");
    const igTile = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /Группы машин/.test(t.textContent));
      const btn = tile && [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      const title = box ? (box.querySelector(".yc-act-title") || {}).textContent : "";
      const listed = box ? [...box.querySelectorAll(".yc-act-btn")].map((b) => b.textContent.trim()) : [];
      const listBtn = [...box.querySelectorAll(".yc-act-btn")].find((b) => /Группы машин/.test(b.textContent));
      if (listBtn) listBtn.click();
      await new Promise((r) => setTimeout(r, 70));
      const sent = window.__calls.filter((c) => c[0] === "ycIg" && c[1].op === "list").slice(-1)[0];
      return { btn: !!btn, title: title, listed: listed, called: !!sent, text: document.getElementById("yc-act-out").textContent };
    });
    ok(igTile.btn && /Группы машин/.test(igTile.title || ""), "у плитки «Группы машин» есть кнопка действий", JSON.stringify({ btn: igTile.btn, title: igTile.title }));
    ok(igTile.listed.length === 8, "в семействе восемь действий: " + igTile.listed.length);
    ok(
      igTile.listed.some((t) => /Создать группу/.test(t)) && igTile.listed.some((t) => /Машины группы/.test(t)) && igTile.listed.some((t) => /Удалить группу/.test(t)),
      "список называет создание, машины группы и удаление: " + igTile.listed.join(", ")
    );
    ok(igTile.called && /машин 1\/3/.test(igTile.text), "действие «Группы машин» позвало канал и показало счёт машин", igTile.text.slice(0, 200));

    const igCardRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Карточка: шаблон/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Группа/.test(label)) input.value = "web";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 70));
      const sent = window.__calls.filter((c) => c[0] === "ycIg" && c[1].op === "card").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(igCardRun.args && igCardRun.args.group === "web", "форма карточки ушла с именем группы", JSON.stringify(igCardRun.args));
    ok(/Шаблон: standard-v3/.test(igCardRun.text) && /203\.0\.113\.5/.test(igCardRun.text), "карточка показала шаблон и машину с адресом", igCardRun.text.slice(0, 220));

    const igCreateRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать группу/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Имя группы/.test(label)) input.value = "web-2";
        if (/^Подсеть/.test(label)) input.value = "app-subnet";
        if (/Машин в группе/.test(label)) input.value = "2";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycIg" && c[1].op === "create").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 90));
      const last = window.__calls.filter((c) => c[0] === "ycIg" && c[1].op === "create").slice(-1)[0] || null;
      return {
        askedHuman: askedHuman,
        hadConfirmBtn: !!confirmBtn,
        firstConfirm: first ? first[1].confirm : null,
        size: first ? first[1].size : null,
        subnet: first ? first[1].subnet : null,
        confirmSent: last ? last[1].confirm === true : false,
        warnText: warnText,
        text: document.getElementById("yc-act-out").textContent,
      };
    });
    // Платное в панели спрашивает ДВА раза и по-разному: сперва показывает цену и
    // размер, а согласие уходит только вторым нажатием кнопки «Подтвердить».
    ok(igCreateRun.size === 2 && igCreateRun.subnet === "app-subnet", "форма собрала размер группы и подсеть", JSON.stringify({ size: igCreateRun.size, subnet: igCreateRun.subnet }));
    ok(/ценой/.test(igCreateRun.warnText) && /Машин: 2/.test(igCreateRun.warnText), "перед согласием панель назвала цену и размер", igCreateRun.warnText.slice(0, 220));
    ok(igCreateRun.firstConfirm !== true && igCreateRun.confirmSent, "согласие облаку ушло только вторым нажатием", JSON.stringify({ first: igCreateRun.firstConfirm, last: igCreateRun.confirmSent }));
    ok(/создаётся/.test(igCreateRun.text) && /платит/.test(igCreateRun.text), "ответ показал создание и предупредил про деньги", igCreateRun.text.slice(0, 200));

    const igDelRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить группу/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Группа/.test(label)) input.value = "web";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycIg" && c[1].op === "delete").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      return { askedHuman: askedHuman, firstConfirm: first ? first[1].confirm : null, group: first ? first[1].group : "", warnText: warnText };
    });
    ok(igDelRun.askedHuman && /ВМЕСТЕ с машинами/.test(igDelRun.warnText) && /дисками/.test(igDelRun.warnText), "удаление объяснило последствия до запроса", igDelRun.warnText.slice(0, 220));
    ok(igDelRun.group === "web" && igDelRun.firstConfirm !== true, "первый запрос ушёл без согласия, но с именем группы", JSON.stringify(igDelRun));
    // ── Балансировщики в панели (часть 91, заходы 2–4) ─────────────────────
    // Балансировщик — вход в приложение: у плитки своё семейство из двадцати
    // одного действия, карточка проходит путь слушатель → роутер → группа
    // бэкендов → группа целей, платное создание сначала показывает цену и порт и
    // только потом уходит облаку с согласием, а группа бэкендов собирается из
    // формы и её здоровье панель спрашивает у пары «бэкенды + цели». Состав
    // слушателей меняется ТОЧЕЧНО (добавление — одним слушателем, удаление —
    // именем и после согласия), а правка уходит маской полей.
    section("[14] Балансировщики: плитка действий, карточка с цепочкой, группа бэкендов и здоровье");
    const albTile = await page.evaluate(async () => {
      const tile = [...document.querySelectorAll("#yc-dash .yc-tile")].find((t) => /Балансировщики/.test(t.textContent));
      const btn = tile && [...tile.querySelectorAll("button")].find((b) => /Действия/.test(b.textContent));
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 40));
      const box = document.getElementById("yc-actions");
      const title = box ? (box.querySelector(".yc-act-title") || {}).textContent : "";
      const listed = box ? [...box.querySelectorAll(".yc-act-btn")].map((b) => b.textContent.trim()) : [];
      const listBtn = [...box.querySelectorAll(".yc-act-btn")].find((b) => b.textContent.trim() === "Балансировщики");
      if (listBtn) listBtn.click();
      await new Promise((r) => setTimeout(r, 70));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "list").slice(-1)[0];
      return { btn: !!btn, title: title, listed: listed, called: !!sent, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albTile.btn && /Application Load Balancer/.test(albTile.title || ""), "у плитки «Балансировщики» есть кнопка действий", JSON.stringify({ btn: albTile.btn, title: albTile.title }));
    ok(albTile.listed.length === 22, "в семействе двадцать два действия: " + albTile.listed.length);
    ok(
      albTile.listed.some((t) => /Добавить слушателя/.test(t)) && albTile.listed.some((t) => /Править слушателя/.test(t)) && albTile.listed.some((t) => /Убрать слушателя/.test(t)) && albTile.listed.some((t) => /Правка балансировщика/.test(t)),
      "список называет правку слушателей и балансировщика: " + albTile.listed.join(", ")
    );
    ok(
      albTile.listed.some((t) => /Создать группу бэкендов/.test(t)) && albTile.listed.some((t) => /Здоровье целей/.test(t)) && albTile.listed.some((t) => /Удалить группу бэкендов/.test(t)),
      "список называет группу бэкендов и здоровье: " + albTile.listed.join(", ")
    );
    ok(
      albTile.listed.some((t) => /Создать балансировщик/.test(t)) && albTile.listed.some((t) => /Карточка: слушатели/.test(t)) && albTile.listed.some((t) => /Удалить балансировщик/.test(t)),
      "список называет карточку, создание и удаление: " + albTile.listed.join(", ")
    );
    ok(albTile.called && /203\.0\.113\.10/.test(albTile.text), "действие «Балансировщики» позвало канал и показало адрес слушателя", albTile.text.slice(0, 200));

    const albCardRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Карточка: слушатели/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Балансировщик/.test(label)) input.value = "web-lb";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 70));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "card").slice(-1)[0];
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albCardRun.args && albCardRun.args.lb === "web-lb", "форма карточки ушла с именем балансировщика", JSON.stringify(albCardRun.args));
    ok(/роутер rt-web/.test(albCardRun.text) && /группа бэкендов bg-web/.test(albCardRun.text), "карточка показала цепочку слушатель → роутер → бэкенды", albCardRun.text.slice(0, 240));

    const albCreateRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать балансировщик/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Имя балансировщика/.test(label)) input.value = "web-lb-2";
        if (/^Подсеть узла/.test(label)) input.value = "app-subnet";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "lbnew").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 90));
      const last = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "lbnew").slice(-1)[0] || null;
      return {
        askedHuman: askedHuman,
        subnet: first ? first[1].subnet : null,
        firstConfirm: first ? first[1].confirm : null,
        confirmSent: last ? last[1].confirm === true : false,
        warnText: warnText,
        text: document.getElementById("yc-act-out").textContent,
      };
    });
    // Платное в панели спрашивает ДВА раза и по-разному: сперва цена и порт без
    // согласия, а согласие уходит только вторым нажатием кнопки «Подтвердить».
    ok(albCreateRun.subnet === "app-subnet", "форма собрала подсеть узла", JSON.stringify({ subnet: albCreateRun.subnet }));
    ok(/ПЛАТНЫЙ/.test(albCreateRun.warnText) && /порт 80/.test(albCreateRun.warnText), "перед согласием панель назвала цену и порт", albCreateRun.warnText.slice(0, 220));
    ok(albCreateRun.firstConfirm !== true && albCreateRun.confirmSent, "согласие облаку ушло только вторым нажатием", JSON.stringify({ first: albCreateRun.firstConfirm, last: albCreateRun.confirmSent }));
    ok(/создаётся/.test(albCreateRun.text) && /платный/.test(albCreateRun.text), "ответ показал создание и предупредил про деньги", albCreateRun.text.slice(0, 200));

    const albDelRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить балансировщик/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Балансировщик/.test(label)) input.value = "web-lb";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "lbdel").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      return { askedHuman: askedHuman, firstConfirm: first ? first[1].confirm : null, lb: first ? first[1].lb : "", warnText: warnText };
    });
    ok(albDelRun.askedHuman && /203\.0\.113\.10/.test(albDelRun.warnText) && /необратимо/.test(albDelRun.warnText), "удаление назвало адреса и спросило человека до запроса", albDelRun.warnText.slice(0, 220));
    ok(albDelRun.lb === "web-lb" && albDelRun.firstConfirm !== true, "первый запрос ушёл без согласия, но с именем балансировщика", JSON.stringify(albDelRun));

    // Группа бэкендов и здоровье — из панели (часть 91, заход 3): форма собирает
    // вид, порт ЦЕЛЕЙ и путь проверки, здоровье показывается по зонам, а удаление
    // группы сначала спрашивает человека.
    const albBackNewRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Создать группу бэкендов/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Имя группы бэкендов/.test(label)) input.value = "api-backends";
        if (/^Группа целей/.test(label)) input.value = "web-targets";
        if (/^Порт целей/.test(label)) input.value = "8080";
        if (/^Путь проверки здоровья/.test(label)) input.value = "/health";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "backnew").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albBackNewRun.args && albBackNewRun.args.kind === "http" && albBackNewRun.args.port === 8080 && albBackNewRun.args.healthPath === "/health", "форма группы бэкендов собрала вид, порт целей и путь проверки", JSON.stringify(albBackNewRun.args));
    ok(/порт 8080/.test(albBackNewRun.text) && /проверка здоровья \/health/.test(albBackNewRun.text), "ответ назвал порт ЦЕЛЕЙ и проверку здоровья", albBackNewRun.text.slice(0, 220));

    const albHealthRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Здоровье целей/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Балансировщик/.test(label)) input.value = "web-lb";
        if (/^Группа целей/.test(label)) input.value = "web-targets";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "health").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albHealthRun.args && albHealthRun.args.lb === "web-lb" && albHealthRun.args.targetGroup === "web-targets", "форма здоровья ушла с балансировщиком и группой целей", JSON.stringify(albHealthRun.args));
    ok(/здоровых: 1/.test(albHealthRun.text) && /ru-central1-b: не отвечает/.test(albHealthRun.text), "панель показала здоровье ПО ЗОНАМ", albHealthRun.text.slice(0, 260));

    const albBackDelRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Удалить группу бэкендов/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Группа бэкендов/.test(label)) input.value = "free-backends";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "backdel").slice(-1)[0] || null;
      return { askedHuman: askedHuman, args: first ? first[1] : null, warnText: document.getElementById("yc-act-out").textContent };
    });
    ok(albBackDelRun.askedHuman && /необратимо/.test(albBackDelRun.warnText) && /настройки балансировки/.test(albBackDelRun.warnText), "удаление группы объяснило последствия до запроса", albBackDelRun.warnText.slice(0, 260));
    ok(albBackDelRun.args && albBackDelRun.args.group === "free-backends" && albBackDelRun.args.confirm !== true, "первый запрос ушёл без согласия, но с именем группы", JSON.stringify(albBackDelRun.args));

    // Правка состава слушателей и самого балансировщика — из панели (заход 4):
    // добавление собирается формой и уходит точечно, удаление спрашивает
    // человека (и только второе нажатие уносит согласие в облако), а HTTPS-
    // карточка показывает сертификат и его срок.
    const albListenerAddRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Добавить слушателя/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Балансировщик/.test(label)) input.value = "web-lb";
        if (/^Имя слушателя/.test(label)) input.value = "api";
        if (/^Порт/.test(label)) input.value = "8080";
        if (/^HTTP-роутер/.test(label)) input.value = "web-router";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "listeneradd").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albListenerAddRun.args && albListenerAddRun.args.listenerName === "api" && albListenerAddRun.args.port === 8080, "форма добавления слушателя собрала имя и порт", JSON.stringify(albListenerAddRun.args));
    ok(/получает слушателя «api»/.test(albListenerAddRun.text) && /Адрес слушателя/.test(albListenerAddRun.text), "ответ назвал слушателя и предупредил про адрес", albListenerAddRun.text.slice(0, 220));

    const albListenerDelRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Убрать слушателя/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const before = window.__confirmCalls;
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Балансировщик/.test(label)) input.value = "web-lb";
        if (/^Имя слушателя/.test(label)) input.value = "web";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const askedHuman = window.__confirmCalls > before;
      const first = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "listenerdel").slice(-1)[0] || null;
      const warnText = document.getElementById("yc-act-out").textContent;
      const confirmBtn = [...document.querySelectorAll("#yc-act-out button")].find((b) => /Подтвердить/.test(b.textContent));
      if (confirmBtn) confirmBtn.click();
      await new Promise((r) => setTimeout(r, 90));
      const last = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "listenerdel").slice(-1)[0] || null;
      return { askedHuman: askedHuman, firstConfirm: first ? first[1].confirm : null, confirmSent: last ? last[1].confirm === true : false, name: first ? first[1].listenerName : "", warnText: warnText, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albListenerDelRun.askedHuman && /вход по нему закроется/.test(albListenerDelRun.warnText), "удаление слушателя спросило человека и объяснило последствия", albListenerDelRun.warnText.slice(0, 220));
    ok(albListenerDelRun.name === "web" && albListenerDelRun.firstConfirm !== true && albListenerDelRun.confirmSent, "первый запрос удаления ушёл без согласия, а согласие — только вторым нажатием", JSON.stringify(albListenerDelRun));
    ok(/убирается у балансировщика/.test(albListenerDelRun.text), "ответ показал удаление слушателя словами", albListenerDelRun.text.slice(0, 200));

    const albUpdateRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Правка балансировщика/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Балансировщик/.test(label)) input.value = "web-lb";
        if (/^Новое имя/.test(label)) input.value = "web-lb-edge";
        if (/^Группы безопасности/.test(label)) input.value = "web, ssh";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "lbupdate").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albUpdateRun.args && albUpdateRun.args.newName === "web-lb-edge" && albUpdateRun.args.securityGroups === "web, ssh", "форма правки собрала имя и группы безопасности", JSON.stringify(albUpdateRun.args));
    ok(/обновляется: имя, описание, группы безопасности/.test(albUpdateRun.text) && /ЗАМЕНЁН целиком/.test(albUpdateRun.text), "правка объяснила, что группы безопасности ЗАМЕНЯЮТСЯ целиком", albUpdateRun.text.slice(0, 260));

    const albTlsCardRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Карточка: слушатели/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (input && /Балансировщик/.test(label)) input.value = "https-lb";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      return { text: document.getElementById("yc-act-out").textContent };
    });
    ok(/🔒 Слушатель «secure» — site-cert/.test(albTlsCardRun.text) && /осталось \d+ дн\./.test(albTlsCardRun.text), "HTTPS-карточка показала сертификат и его срок", albTlsCardRun.text.slice(0, 260));
    ok(/SNI: shop\.example\.com/.test(albTlsCardRun.text) && /shop-cert/.test(albTlsCardRun.text), "карточка показала СВОЙ сертификат домена SNI", albTlsCardRun.text.slice(0, 320));

    // Правка слушателя (заход 5): форма называет только то, что меняем, а
    // пустые поля не уходят вовсе — иначе модуль счёл бы это сменой настройки.
    const albListenerUpdRun = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Править слушателя/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      for (const row of form.querySelectorAll(".yc-act-field")) {
        const label = (row.querySelector(".yc-act-label") || {}).textContent || "";
        const input = row.querySelector("input, select, textarea");
        if (!input) continue;
        if (/^Балансировщик/.test(label)) input.value = "web-lb";
        if (/^Какой слушатель/.test(label)) input.value = "shop";
        if (/^Порт/.test(label)) input.value = "8443";
        if (/^Домены SNI/.test(label)) input.value = "shop.example.com=shop-cert";
      }
      form.querySelector(".yc-act-actionsrow button").click();
      await new Promise((r) => setTimeout(r, 90));
      const sent = window.__calls.filter((c) => c[0] === "ycAlb" && c[1].op === "listenerupd").slice(-1)[0] || null;
      return { args: sent ? sent[1] : null, text: document.getElementById("yc-act-out").textContent };
    });
    ok(albListenerUpdRun.args && albListenerUpdRun.args.listenerName === "shop" && albListenerUpdRun.args.port === 8443, "форма правки слушателя собрала имя и порт", JSON.stringify(albListenerUpdRun.args));
    ok(albListenerUpdRun.args && albListenerUpdRun.args.certificate === undefined && albListenerUpdRun.args.listener === undefined, "пустые поля правки в запрос не ушли", JSON.stringify(albListenerUpdRun.args));
    ok(albListenerUpdRun.args && albListenerUpdRun.args.sni === "shop.example.com=shop-cert", "домены SNI ушли строкой", JSON.stringify(albListenerUpdRun.args));
    ok(/обновляется: порт 8443, домены SNI/.test(albListenerUpdRun.text) && /SNI-обработчики заменяются ЦЕЛИКОМ/.test(albListenerUpdRun.text), "ответ назвал правку и предупредил про замену доменов", albListenerUpdRun.text.slice(0, 300));
    // Имя слушателя — обязательное поле: без него модуль не знает, кого править
    // (переименовать слушателя нельзя), и форма говорит об этом звёздочкой.
    const albListenerUpdLabels = await page.evaluate(async () => {
      const box = document.getElementById("yc-actions");
      const cancel = [...box.querySelectorAll(".yc-act-actionsrow button")].find((b) => /Отмена/.test(b.textContent));
      if (cancel) cancel.click();
      await new Promise((r) => setTimeout(r, 30));
      [...box.querySelectorAll(".yc-act-btn")].find((b) => /Править слушателя/.test(b.textContent)).click();
      await new Promise((r) => setTimeout(r, 40));
      const form = box.querySelector(".yc-act-form");
      return { labels: [...form.querySelectorAll(".yc-act-label")].map((x) => x.textContent) };
    });
    ok(albListenerUpdLabels.labels.some((l) => /^Какой слушатель правим \*/.test(l)), "имя слушателя в форме правки помечено обязательным: " + albListenerUpdLabels.labels.join(" | "));
    ok(albListenerUpdLabels.labels.some((l) => /оставить прежний/.test(l)) && albListenerUpdLabels.labels.some((l) => /пусто — прежний/.test(l)), "форма правки говорит, что пустое значит «оставить прежнее»: " + albListenerUpdLabels.labels.join(" | "));

  } finally {
    await browser.close();
    try {
      fs.unlinkSync(SHOT);
    } catch (e) {
      /* стенд во временной папке — если уже удалён, это не ошибка */
    }
  }

  console.log("\n" + (fail ? "❌ Провалено" : "✅ Живая панель облака проверена") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

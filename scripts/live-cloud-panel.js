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
         показывается один раз отдельной рамкой и не попадает в строки ответа.

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
  // Данные стенда: семь сервисов, один отказал, есть ресурсы, деньги и хвосты.
  const services = [
    { key: "storage", ru: "Объектное хранилище", title: "Object Storage", ok: true, count: 3, items: [{ id: "b1", name: "site-bucket" }, { id: "b2", name: "logs-archive" }, { id: "b3", name: "backups" }] },
    { key: "cloudFunctions", ru: "Функции", title: "Cloud Functions", ok: true, count: 2, items: [{ id: "f1", name: "tg-webhook" }, { id: "f2", name: "hourly-report" }] },
    { key: "dns", ru: "DNS-зоны", title: "Cloud DNS", ok: false, count: 0, error: "403: нет роли dns.viewer — попроси владельца каталога" },
    { key: "cdn", ru: "CDN и сайты", title: "Cloud CDN", ok: true, count: 1, items: [{ id: "c1", name: "cdn.example.com" }] },
    { key: "vpc", ru: "Сети VPC", title: "Virtual Private Cloud", ok: true, count: 0, items: [] },
    { key: "iam", ru: "Сервисные аккаунты", title: "Identity and Access Management", ok: true, count: 4, items: [{ id: "s1", name: "deploy-bot" }] },
    { key: "lockbox", ru: "Секреты", title: "Lockbox", ok: true, count: 1, items: [{ id: "l1", name: "app-secrets" }] },
    { key: "compute", ru: "Виртуальные машины", title: "Compute Cloud", ok: true, count: 1, items: [{ id: "vm1", name: "web-1" }] }
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
    ycResources: async () => ({ ok: true, services, total: 11, activeServices: 5 }),
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
    ycCdn: async (a) => { window.__calls.push(["ycCdn", a]); return { ok: true, message: "готово: " + a.op, certificates: [], resources: [] }; }
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
    ok(info.tiles === 8, "плиток столько же, сколько сервисов", String(info.tiles));
    ok(info.icons === 8, "у каждой плитки своя официальная иконка", String(info.icons));
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
    ok(errOnly.length === 1 && /DNS/.test(errOnly[0]), "фильтр «Ошибки» оставляет только упавший сервис", errOnly.join(", "));

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

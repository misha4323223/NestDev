"use strict";
/* ЖИВОЙ тест консоли Yandex Cloud (настоящее окно Electron + подменённый YC API).
   Запуск: bun run test:live:yc

   Что проверяем: карточка ресурса открывается из списка сервиса и показывает
   поля ресурса и связанные объекты — именно то, ради чего в консоль и заходят.
   Yandex Cloud отвечает подменённый сервер, поэтому проверка честная от начала
   до конца: интерфейс → IPC → src/yc-console.js → HTTP → разбор → отрисовка.

   Отдельно проверяется, что таблицы базы YDB панель спрашивает у Document API
   САМОЙ базы (операцией в заголовке) — в консольном API их просто нет.

   Отдельно проверяются три вещи, которые легко сделать «на вид работает»:
     • связь, которой нет в API, показывает причину, а не пустой список;
     • форма пути подбирается (DNS принимает только вторую форму);
     • отказ по правам на «по родителю» откатывается на список по каталогу (IAM).

   Linux: нужен Xvfb (ставится вместе с playwright: npx playwright install --with-deps chromium). */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CDP = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, ok, extra) => (ok ? (pass++, console.log("  ✅ " + n + (extra ? " — " + extra : ""))) : (fail++, console.log("  ❌ " + n + (extra ? " — " + extra : ""))));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

// ── Подменённый Yandex Cloud API ────────────────────────────────────────────
const seen = [];
const calls = { rollback: 0 };
// Запросы Document API базы YDB: операция — в заголовке, не в пути.
const docCalls = [];
const created = []; // что реально ушло на создание (по имени сервиса)

function startFakeYc() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(req.method + " " + u.pathname + (u.search || ""));
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // Создание ресурса: операция и её завершение (приложение опрашивает статус).
      // Проверяем метод ДО обработчиков списков — иначе POST получал бы список.
      if (u.pathname === "/operations/op-create") return json(200, { id: "op-create", done: true });
      if (req.method === "POST" && (u.pathname === "/dns/v1/zones" || u.pathname === "/vpc/v1/networks")) {
        created.push(u.pathname.indexOf("/dns/") !== -1 ? "dns" : "vpc");
        return json(200, { id: "op-create" });
      }
      const p = u.pathname;

      if (p === "/iam/v1/tokens") return json(200, { iamToken: "fake-iam", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p === "/resource-manager/v1/clouds") return json(200, { clouds: [{ id: "cloud1", name: "mycloud" }] });
      if (p === "/resource-manager/v1/folders") return json(200, { folders: [{ id: "f1", name: "default" }] });

      // VPC: сеть, подсети (одна своя, одна чужая), группы безопасности.
      // Таблиц маршрутизации «нет в API» — специально, чтобы проверить честную ошибку.
      if (p === "/vpc/v1/networks") {
        return json(200, { networks: [{ id: "net1", name: "default", folderId: "f1", createdAt: "2026-08-01T10:00:00Z", description: "сеть по умолчанию", labels: { env: "prod" } }] });
      }
      if (p === "/vpc/v1/networks/net1") {
        return json(200, { id: "net1", name: "default", folderId: "f1", createdAt: "2026-08-01T10:00:00Z", description: "сеть по умолчанию", labels: { env: "prod" }, defaultSecurityGroupId: "sg0" });
      }
      if (p === "/vpc/v1/subnets") {
        return json(200, { subnets: [
          { id: "sub1", name: "app-subnet", networkId: "net1", zoneId: "ru-central1-a", v4CidrBlocks: ["10.0.0.0/24"], status: "READY" },
          { id: "sub2", name: "чужая-сеть", networkId: "net2", zoneId: "ru-central1-b", v4CidrBlocks: ["10.9.0.0/24"], status: "READY" },
        ] });
      }
      if (p === "/vpc/v1/securityGroups") {
        return json(200, { securityGroups: [{ id: "sg1", name: "web-sg", networkId: "net1", description: "80/443" }] });
      }
      if (p === "/vpc/v1/routeTables") return json(404, { message: "route table api is not available" });

      // DNS: зона и записи. Первую форму (GET) сервер не принимает — как настоящий.
      if (p === "/dns/v1/zones") {
        return json(200, { zones: [{ id: "zone1", name: "example.com.", zoneId: "example.com.", status: "ACTIVE", createdAt: "2026-07-01T10:00:00Z" }] });
      }
      if (p === "/dns/v1/zones/zone1:getRecordSets") {
        if (req.method === "GET") return json(405, { message: "method not allowed, use POST" });
        return json(200, { recordSets: [{ name: "www.example.com.", type: "A", ttl: 600, data: ["1.2.3.4"] }] });
      }

      // IAM: сервисный аккаунт и ключи. По serviceAccountId — отказ, по каталогу — работает.
      if (p === "/iam/v1/serviceAccounts") {
        return json(200, { serviceAccounts: [{ id: "sa1", name: "deployer", folderId: "f1", createdAt: "2026-08-20T10:00:00Z" }] });
      }
      if (p === "/iam/v1/serviceAccounts/sa1") {
        return json(200, { id: "sa1", name: "deployer", folderId: "f1", createdAt: "2026-08-20T10:00:00Z", description: "для деплоя" });
      }
      if (p === "/iam/v1/accessKeys") {
        if (u.searchParams.get("serviceAccountId")) return json(403, { message: "not allowed for this subject" });
        return json(200, { accessKeys: [{ id: "ak1", serviceAccountId: "sa1", keyId: "KEY-1", createdAt: "2026-08-21T10:00:00Z" }] });
      }
      if (p === "/iam/v1/apiKeys") return json(200, { apiKeys: [] });

      // Serverless Containers: контейнер и две ревизии + откат.
      if (p === "/containers/v1/containers") {
        return json(200, { containers: [{ id: "c1", name: "api", status: "ACTIVE", createdAt: "2026-09-10T12:00:00Z", url: "https://api.example.yandexcloud.net" }] });
      }
      if (p === "/containers/v1/containers/c1") {
        return json(200, { id: "c1", name: "api", folderId: "f1", status: "ACTIVE", createdAt: "2026-09-10T12:00:00Z", url: "https://api.example.yandexcloud.net",
          image: { imageUrl: "cr.yandex/cr1/api:2" }, resources: { memory: "134217728", cores: "1", coreFraction: "100" }, concurrency: 1, executionTimeout: "5s" });
      }
      if (p === "/containers/v1/revisions") {
        return json(200, { revisions: [
          { id: "rev2", status: "ACTIVE", createdAt: "2026-09-12T12:00:00Z", image: { imageUrl: "cr.yandex/cr1/api:2" } },
          { id: "rev1", status: "OBSOLETE", createdAt: "2026-09-10T12:00:00Z", image: { imageUrl: "cr.yandex/cr1/api:1" } },
        ] });
      }
      if (p === "/containers/v1/containers/c1:rollback" && req.method === "POST") {
        calls.rollback++;
        return json(200, { id: "op1", done: true, metadata: { "@type": "yandex.cloud.serverless.containers.v1.RollbackContainerRevisionMetadata" } });
      }

      // YDB: база и её таблицы. Таблиц в КОНСОЛЬНОМ API нет — их отдаёт
      // Document API самой базы (адрес лежит в её же documentApiEndpoint).
      // Операция идёт заголовком X-Amz-Target: если панель пойдёт REST-путём,
      // проверка это поймает.
      if (p === "/ydb/v1/databases") {
        return json(200, { databases: [{
          id: "etn1", name: "app-db", folderId: "f1", status: "RUNNING",
          endpoint: "grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1g/etn1",
          documentApiEndpoint: "http://" + (req.headers.host || "127.0.0.1") + "/ru-central1/b1g/etn1",
        }] });
      }
      if (p === "/ydb/v1/databases/etn1") {
        return json(200, { id: "etn1", name: "app-db", folderId: "f1", status: "RUNNING" });
      }
      if (p === "/ru-central1/b1g/etn1") {
        const target = String(req.headers["x-amz-target"] || "");
        docCalls.push({ target: target, auth: req.headers.authorization || "", path: p });
        if (target === "DynamoDB_20120810.ListTables") return json(200, { TableNames: ["pets", "orders"] });
        return json(200, {});
      }
      // Остальные сервисы дашборда: пустые списки (карточки без ошибок).
      if (req.method === "GET") return json(200, {});
      json(200, {});
    });
  });
}

function hasXvfb() {
  return spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).status === 0;
}

(async () => {
  let chromium;
  try {
    chromium = require(path.join(ROOT, "node_modules", "playwright")).chromium;
  } catch (e) {
    console.error("✗ Нет playwright. Установи: bun install && npx playwright install --with-deps chromium");
    process.exit(2);
  }
  const electronBin = path.join(ROOT, "node_modules", "electron", "dist", "electron");
  const electronExe = process.platform === "win32" ? electronBin + ".exe" : electronBin;
  if (!fs.existsSync(electronExe)) {
    console.error("✗ Нет Electron. Установи зависимости: bun install");
    process.exit(2);
  }

  const ycPort = await freePort();
  const srv = startFakeYc();
  await new Promise((r) => srv.listen(ycPort, "127.0.0.1", r));
  const ycBase = "http://127.0.0.1:" + ycPort;
  console.log("\n[1] Подменённый Yandex Cloud API: " + ycBase);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-yc-"));
  const useXvfb = process.platform === "linux" && hasXvfb();
  if (process.platform === "linux" && !useXvfb) {
    console.error("✗ Нет xvfb-run — на Linux без дисплея окно не поднять.");
    srv.close();
    process.exit(2);
  }
  const args = [
    electronExe, ".", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=" + path.join(workDir, "userdata"),
    "--remote-debugging-port=" + CDP,
  ];
  const cmd = useXvfb ? "xvfb-run" : electronExe;
  const cmdArgs = useXvfb ? ["-a", "-s", "-screen 0 1440x900x24", ...args] : args.slice(1);
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    // Свой OTA-корень (иначе приложение подхватит ota/ и перезапустится)
    // и подмена базы Yandex Cloud.
    env: Object.assign({}, process.env, {
      AI_AGENT_OTA_ROOT: path.join(workDir, "ota"),
      AI_AGENT_YC_BASE: ycBase,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let elog = "";
  child.stdout.on("data", (d) => (elog += d));
  child.stderr.on("data", (d) => (elog += d));
  const killApp = () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch("http://127.0.0.1:" + CDP + "/json/version");
      if (r.ok) { up = true; break; }
    } catch (e) {}
    await sleep(500);
  }
  check("приложение поднялось", up, up ? "" : elog.slice(-300));
  if (!up) {
    killApp();
    srv.close();
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /index\.html/.test(p.url()));
  const pageErrs = [];
  if (page) {
    page.on("pageerror", (e) => pageErrs.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") pageErrs.push("console: " + m.text().slice(0, 200)); });
  }
  check("окно приложения найдено", !!page);
  if (!page) {
    await browser.close().catch(() => {});
    killApp();
    srv.close();
    process.exit(1);
  }

  try {
    console.log("\n[2] Подключение Yandex Cloud (токен и каталог — через приложение)");
    const conn = await page.evaluate(async () => {
      const t = await window.api.ycSetToken("fake-oauth");
      if (!t || !t.ok) return { ok: false, error: (t && t.error) || "токен не принят" };
      await window.api.ycSetFolder(t.folderId, t.folderName, t.cloudId);
      return { ok: true, folder: t.folderName, cloud: t.cloudId };
    });
    check("токен и каталог приняты", conn.ok && conn.folder === "default", conn.error || (conn.cloud + " · " + conn.folder));

    console.log("\n[3] Дашборд: клик по имени ресурса открывает карточку");
    const dash = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Ждём карточки по состоянию, а не по паузе: окно поднимается не мгновенно.
      // Плюс переоткрываем панель, если первый кадр вышел пустым: сразу после
      // сохранения токена главный процесс может ещё не успеть его подхватить, и
      // дашборд рисуется без карточек. Так сделал бы и человек — но тест сообщает,
      // что понадобилась вторая попытка: молчаливое повторение скрыло бы причину.
      let cards = [];
      let attempts = 0;
      for (let a = 0; a < 3 && !cards.length; a++) {
        attempts++;
        const rail = document.getElementById("rail-cloud");
        if (!rail) return { ok: false, error: "нет рельсы облака" };
        rail.click();
        for (let i = 0; i < 40 && !cards.length; i++) {
          await wait(250);
          cards = [...document.querySelectorAll("#yc-dash .yc-card")];
        }
      }
      const vpc = cards.find((c) => c.textContent.includes("Virtual Private Cloud"));
      if (!vpc) return { ok: false, error: "нет карточки VPC", attempts, cards: cards.map((c) => c.textContent.slice(0, 40)) };
      vpc.click();
      await wait(600);
      const names = [...document.querySelectorAll("#yc-dash .yc-item-name")];
      const target = names.find((n) => n.textContent.includes("default"));
      if (!target) return { ok: false, error: "нет ресурса в списке", names: names.map((n) => n.textContent) };
      target.click();
      await wait(2500);
      const box = document.getElementById("yc-console");
      return {
        ok: !!box && !box.classList.contains("hidden"),
        dashHidden: document.getElementById("yc-dash").classList.contains("hidden"),
        title: (document.querySelector("#yc-console .ykc-title") || {}).textContent || "",
        sub: (document.querySelector("#yc-console .ykc-sub") || {}).textContent || "",
        attempts,
      };
    });
    check(
      "карточка ресурса открылась",
      dash.ok,
      (dash.error || "") + (dash.attempts > 1 ? " (дашборд открылся с попытки " + dash.attempts + ")" : "")
    );
    check("дашборд уступил место карточке", dash.dashHidden);
    check("в шапке — сервис и имя ресурса", dash.sub === "Virtual Private Cloud" && dash.title === "default", dash.sub + " · " + dash.title);

    console.log("\n[4] Обзор ресурса: поля и связанные объекты");
    const card = await page.evaluate(() => {
      const fields = [...document.querySelectorAll("#yc-console .ykc-field")].map((f) => ({
        label: f.querySelector(".ykc-flabel").textContent,
        value: f.querySelector(".ykc-fvalue").textContent,
      }));
      const rels = [...document.querySelectorAll("#yc-console .ykc-rel")].map((r) => ({
        text: r.textContent.replace(/\s+/g, " ").trim(),
        bad: r.classList.contains("bad"),
        title: r.title,
      }));
      return { fields, rels };
    });
    const byLabel = (l) => (card.fields.find((f) => f.label === l) || {}).value || "";
    check("показаны Название и Идентификатор", byLabel("Название") === "default" && byLabel("Идентификатор") === "net1", "«" + byLabel("Название") + "» / «" + byLabel("Идентификатор") + "»");
    check("дата создания по-человечески", /\d{2}\.\d{2}\.\d{4}/.test(byLabel("Создано")) && /назад|вчера/.test(byLabel("Создано")), byLabel("Создано"));
    check("метки читаются («ключ: значение»)", byLabel("Метки") === "env: prod", byLabel("Метки"));
    check("подтянуто уточнение из карточки ресурса (GET по id)", byLabel("Группа безопасности по умолчанию") === "sg0", byLabel("Группа безопасности по умолчанию"));
    check("три связи со счётчиками", card.rels.length === 3, card.rels.map((r) => r.text).join(" · "));
    check("подсети посчитаны (1, чужая сеть отфильтрована)", /Подсети\s*1/.test(card.rels[0].text), card.rels[0].text);
    check("недоступная связь помечена, а не «0»", card.rels[2].bad && /!$/.test(card.rels[2].text), card.rels[2].text);

    console.log("\n[5] Связанные объекты: таблица и честная ошибка");
    const rel = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const chip = (i) => document.querySelectorAll("#yc-console .ykc-rel")[i];
      chip(0).click();
      await wait(1200);
      const rows = [...document.querySelectorAll("#yc-console .ykc-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
      const heads = [...document.querySelectorAll("#yc-console .ykc-table th")].map((th) => th.textContent);
      chip(2).click();
      await wait(1200);
      const err = (document.querySelector("#yc-console .ykc-err") || {}).textContent || "";
      chip(2).click();
      await wait(400);
      return { rows, heads, err };
    });
    check("таблица подсетей: одна строка (чужая сеть не попала)", rel.rows.length === 1 && rel.rows[0].some((c) => c.includes("app-subnet")), JSON.stringify(rel.rows));
    check("колонки таблицы осмысленные", rel.heads.join("|") === "Название|Зона|Диапазоны IPv4|Статус", rel.heads.join(" | "));
    check("ошибка связи объясняет причину, а не показывает пусто", /route table api is not available/.test(rel.err) && /не пустой список/.test(rel.err), rel.err.split("\n")[0].slice(0, 90));

    console.log("\n[6] DNS: подбор формы пути; IAM: отказ по правам → список по каталогу");
    const dns = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.YcConsole.open({ serviceKey: "dns", title: "Cloud DNS", item: { id: "zone1", name: "example.com." }, folderId: "f1" });
      await wait(1500);
      const chip = [...document.querySelectorAll("#yc-console .ykc-rel")].find((c) => c.textContent.includes("Записи"));
      chip.click();
      await wait(1200);
      return {
        title: (document.querySelector("#yc-console .ykc-title") || {}).textContent,
        rows: [...document.querySelectorAll("#yc-console .ykc-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join(" | ")),
      };
    });
    check("DNS-зона открылась", dns.title === "example.com.", dns.title);
    check("записи зоны прочитаны (вторая форма пути)", dns.rows.length === 1 && /www\.example\.com\./.test(dns.rows[0]), dns.rows.join(" / "));

    const iam = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.YcConsole.open({ serviceKey: "iam", title: "Identity and Access Management", item: { id: "sa1", name: "deployer" }, folderId: "f1" });
      await wait(1500);
      const chip = [...document.querySelectorAll("#yc-console .ykc-rel")].find((c) => c.textContent.includes("Статические"));
      chip.click();
      await wait(1200);
      return {
        rows: [...document.querySelectorAll("#yc-console .ykc-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join(" | ")),
        err: (document.querySelector("#yc-console .ykc-err") || {}).textContent || "",
      };
    });
    check("ключи сервисного аккаунта найдены через список по каталогу (403 → добор)", iam.rows.length === 1 && /KEY-1/.test(iam.rows[0]), iam.rows.join(" / ") || iam.err.slice(0, 90));

    console.log("\n[7] Контейнер: ревизии и откат («сделать активной»)");
    const cont = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.YcConsole.open({ serviceKey: "serverlessContainers", title: "Serverless Containers", item: { id: "c1", name: "api" }, folderId: "f1" });
      await wait(1800);
      const fields = [...document.querySelectorAll("#yc-console .ykc-field")].map((f) => f.querySelector(".ykc-flabel").textContent + "=" + f.querySelector(".ykc-fvalue").textContent);
      const chip = [...document.querySelectorAll("#yc-console .ykc-rel")].find((c) => c.textContent.includes("Ревизии"));
      chip.click();
      await wait(1200);
      const rows = [...document.querySelectorAll("#yc-console .ykc-table tbody tr")];
      const buttons = [...document.querySelectorAll("#yc-console .ykc-actions button")];
      return { fields, rows: rows.length, buttons: buttons.length, firstRow: rows[0] ? rows[0].textContent.replace(/\s+/g, " ").trim() : "" };
    });
    check("поля контейнера разобраны (память и образ)", cont.fields.some((f) => /Память: 128 МБ/.test(f)) && cont.fields.some((f) => /^Образ=cr\.yandex\/cr1\/api:2$/.test(f)), cont.fields.filter((f) => /Память|Образ/.test(f)).join(" · "));
    check("ревизии в таблице", cont.rows === 2, "строк: " + cont.rows);
    check("кнопка отката только у неактивной ревизии", cont.buttons === 1, "кнопок: " + cont.buttons);

    // Тост приложение создаёт функцией window.uiToast (плавающий div без id),
    // поэтому перехватываем вызовы, а не ищем узел в разметке.
    const rollbackBlocked = await page.evaluate(async () => {
      window.__toasts = [];
      window.uiToast = (t) => window.__toasts.push(String(t));
      const btn = document.querySelector("#yc-console .ykc-actions button");
      btn.click();
      await new Promise((r) => setTimeout(r, 1200));
      return (window.__toasts || []).join(" | ");
    });
    check("без разрешения откат запрещён с понятным текстом", /Разрешить агенту менять контейнеры/.test(rollbackBlocked), rollbackBlocked.slice(-90));

    const rollbackOk = await page.evaluate(async () => {
      await window.api.ycSetPermissions(false, false, true);
      window.__toasts = [];
      window.uiToast = (t) => window.__toasts.push(String(t));
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.YcConsole.open({ serviceKey: "serverlessContainers", title: "Serverless Containers", item: { id: "c1", name: "api" }, folderId: "f1" });
      await wait(1600);
      const chip = [...document.querySelectorAll("#yc-console .ykc-rel")].find((c) => c.textContent.includes("Ревизии"));
      chip.click();
      await wait(1200);
      const btn = document.querySelector("#yc-console .ykc-actions button");
      btn.click();
      await wait(1800);
      return (window.__toasts || []).join(" | ");
    });
    check("с разрешением откат выполняется", calls.rollback === 1 && /переведён на ревизию/.test(rollbackOk), "POST rollback: " + calls.rollback + " · " + rollbackOk.slice(-80));
    check("откат ушёл на нужный путь", seen.some((s) => s === "POST /containers/v1/containers/c1:rollback"), seen.filter((s) => /rollback/.test(s)).join(" "));

    console.log("\n[8] Возврат к дашборду");
    const back = await page.evaluate(async () => {
      document.querySelector("#yc-console .ykc-back").click();
      await new Promise((r) => setTimeout(r, 400));
      return {
        consoleHidden: document.getElementById("yc-console").classList.contains("hidden"),
        dashVisible: !document.getElementById("yc-dash").classList.contains("hidden"),
      };
    });
    check("«Назад» возвращает список сервисов", back.consoleHidden && back.dashVisible);

    console.log("\n[9] Стоимость: цена ДО создания и согласие на платное");
    const price = await page.evaluate(async () => {
      const r = await window.api.ycCosts("dns", {});
      return { ok: r.ok, text: (r.lines || []).join("\n"), hint: r.hint, level: r.estimate && r.estimate.levelLabel, month: r.estimate && r.estimate.approxMonth };
    });
    check("цена ресурса считается заранее", price.ok && /₽/.test(price.text), price.hint);
    check("в цене есть ссылка на калькулятор", /prices/.test(price.text), price.text.split("\n").pop().slice(-60));
    check("подсказка для карточки — уровень и цифра", /копейки/.test(price.hint || "") && /₽/.test(price.hint || ""), price.hint);

    // Диалог создания обязан показать цену: создание платного без цифры — счёт вслепую.
    const dialog = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Обработчики рельсы появляются только после загрузки модулей окна. Один
      // клик мог уйти в пустоту — тогда панель не открывалась и карточек не было.
      const sp = document.getElementById("sp-cloud");
      for (let i = 0; i < 60 && sp.classList.contains("hidden"); i++) {
        document.getElementById("rail-cloud").click();
        await wait(250);
      }
      let dns = null;
      let add = null;
      for (let i = 0; i < 40 && !add; i++) {
        await wait(250);
        const cards = [...document.querySelectorAll("#yc-dash .yc-card")];
        dns = cards.find((c) => c.textContent.includes("Cloud DNS"));
        add = dns ? dns.querySelector(".yc-add") : null;
      }
      if (!dns) return { ok: false, error: "нет карточки Cloud DNS" };
      if (!add) return { ok: false, error: "нет кнопки создания" };
      add.click();
      await wait(1500);
      const hint = document.getElementById("input-hint").textContent;
      const cancel = document.getElementById("btn-input-cancel");
      cancel.click();
      await wait(300);
      return { ok: true, hint };
    });
    check("диалог создания показывает цену", dialog.ok && /₽/.test(dialog.hint || ""), dialog.error || (dialog.hint || "").split("\n")[0]);
    check("в диалоге видно, что ресурс платный", /Платный ресурс/.test(dialog.hint || ""), (dialog.hint || "").split("\n").slice(0, 2).join(" · "));

    // Без согласия платное не создаётся — и запроса к API нет вообще.
    const refused = await page.evaluate(async () => {
      const r = await window.api.ycCreate("dns", "test-zone");
      return { ok: r.ok, needsConfirm: r.needsConfirm, error: r.error || "" };
    });
    check("без согласия платное отклонено", refused.ok === false && refused.needsConfirm === true, refused.error.slice(0, 90));
    check("запрос на создание при отказе не ушёл", created.length === 0, "создано: " + (created.join(", ") || "ничего"));

    const agreed = await page.evaluate(async () => {
      const r = await window.api.ycCreate("dns", "test-zone", { confirmed: true });
      return { ok: r.ok, message: r.message || "", cost: r.cost || "", error: r.error || "" };
    });
    check("с согласием ресурс создаётся", agreed.ok === true, agreed.error || agreed.message.slice(0, 70));
    check("в ответе о создании есть ориентир цены", /₽/.test(agreed.cost || ""), agreed.cost);

    // Бесплатный ресурс не должен требовать согласия — гейт не должен пере-блокировать.
    const free = await page.evaluate(async () => {
      const r = await window.api.ycCreate("vpc", "test-net");
      return { ok: r.ok, error: r.error || "" };
    });
    check("бесплатный ресурс создаётся без лишнего вопроса", free.ok === true, free.error.slice(0, 90));
    check("оба запроса на создание дошли до API", created.join(",") === "dns,vpc", "создано: " + created.join(", "));

    console.log("\n[10] База YDB: таблицы видны в консоли (через Document API базы)");
    const ydb = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.YcConsole.open({ serviceKey: "ydb", title: "Managed Service for YDB", item: { id: "etn1", name: "app-db" }, folderId: "f1" });
      await wait(1500);
      const chip = [...document.querySelectorAll("#yc-console .ykc-rel")].find((c) => c.textContent.includes("Таблицы"));
      if (!chip) {
        return { chip: "", rows: [], heads: [], path: "", err: "" };
      }
      const chipText = chip.textContent.replace(/\s+/g, " ").trim();
      chip.click();
      await wait(1500);
      return {
        chip: chipText,
        rows: [...document.querySelectorAll("#yc-console .ykc-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent).join(" | ")),
        heads: [...document.querySelectorAll("#yc-console .ykc-table th")].map((th) => th.textContent),
        path: (document.querySelector("#yc-console .ykc-path") || {}).textContent || "",
        err: (document.querySelector("#yc-console .ykc-err") || {}).textContent || "",
      };
    });
    check("в карточке базы есть связь «Таблицы» со счётчиком", /Таблицы\s*2/.test(ydb.chip), ydb.chip || ydb.err.split("\n")[0]);
    check("таблицы базы показаны человеку", ydb.rows.length === 2 && /pets/.test(ydb.rows.join(" ")) && /orders/.test(ydb.rows.join(" ")), ydb.rows.join(" / ") || ydb.err.slice(0, 90));
    check("колонка таблиц осмысленная", ydb.heads.join("|") === "Название", ydb.heads.join(" | "));

    // Отдельно проверяем ПРОТОКОЛ: таблиц нет в консольном API, значит панель
    // обязана сходить в Document API базы операцией в заголовке. Иначе список
    // был бы пустым у настоящей базы.
    const docList = docCalls.filter((c) => c.target === "DynamoDB_20120810.ListTables");
    check("панель спросила таблицы у Document API базы (операция в заголовке)", docList.length > 0, docList.length ? docList[0].path + " · " + docList[0].target : "запросов: " + docCalls.length);
    check("запрос ушёл с IAM-токеном, а не с подписью AWS", docList.every((c) => /^Bearer /.test(c.auth)), ((docList[0] || {}).auth || "").slice(0, 12));
    check("в панели назван путь запроса", /Document API/.test(ydb.path) && /ListTables/.test(ydb.path), ydb.path.slice(0, 80));
    check("в консольный API за таблицами не ходили", !seen.some((s) => /\/ydb\/v1\/databases\/etn1\/tables/.test(s)), "запросов: " + seen.filter((s) => /ydb/.test(s)).join(", ") || "нет");

    console.log("\n[11] Ошибки страницы");
    const real = pageErrs.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
    check("нет ошибок JS и консоли", real.length === 0, real.slice(0, 3).join(" | ") || "чисто");
  } catch (e) {
    // Причина обрыва без ошибок страницы не видна: печатаем их вместе с сообщением.
    const tail = pageErrs.length ? " · ошибки страницы: " + pageErrs.slice(0, 2).join(" | ") : "";
    check("живой прогон без исключений", false, e.message + tail);
  } finally {
    await browser.close().catch(() => {});
    killApp();
    srv.close();
  }

  console.log("\n=== ЖИВОЙ ТЕСТ КОНСОЛИ YC: " + pass + " ✅ / " + fail + " ❌ ===");
  if (fail) {
    console.log("\nзапросов к подменённому API: " + seen.length);
    console.log(seen.join("\n"));
    if (pageErrs.length) {
      console.log("\nошибки страницы:");
      console.log(pageErrs.slice(0, 8).join("\n"));
    }
  }
  process.exit(fail ? 1 : 0);
})();

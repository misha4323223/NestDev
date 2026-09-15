"use strict";
/* ── Живой тест деплоя ───────────────────────────────────────────────────────
   Запуск: bun run test:live:deploy

   Поднимает настоящее окно приложения и проверяет весь цикл выката:
   рецепт проекта → сборка в контейнер → реестр → деплой ревизии → проверка
   адреса → история → откат. Вместо облака и Docker — подменённые: свой
   Yandex Cloud API (переменная AI_AGENT_YC_BASE), фальшивый `docker` в PATH и
   локальный адрес проверки. Тот же код пути, что и у кнопки в интерфейсе.
*/

const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CDP = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, ok, extra) => (ok ? (pass++, console.log("  ✅ " + n + (extra ? " — " + extra : ""))) : (fail++, console.log("  ❌ " + n + (extra ? " — " + extra : ""))));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

// ── Подменённый Yandex Cloud API + сайт для проверки после деплоя ───────────
const seen = [];
const calls = { rollback: 0, deploys: 0, images: [] };
const revisions = [];
// Что отдаёт выкаченный сайт: ok — рабочая страница, http500 — приложение падает,
// blank — отвечает 200, но страница пустая (такое видит только браузер).
let mode = "ok";

const GOOD_HTML = [
  "<!doctype html><html lang=\"ru\"><head><meta charset=\"utf-8\"><title>Витрина магазина</title></head>",
  '<body><div id="root"><h1>Витрина магазина</h1>',
  "<p>Товары загружены: 12 позиций. Скидки действуют до конца недели.</p></div>",
  "<script>console.error('Uncaught TypeError: cart is not a function');</script>",
  "</body></html>",
].join("");
const BLANK_HTML = '<!doctype html><html><head><title></title></head><body><div id="root"></div></body></html>';

function startFake() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const p = u.pathname;

      // Сайт проекта: сюда попадают проверка адреса и аудит страницы браузером.
      if (p.startsWith("/app")) {
        if (mode === "http500") {
          res.writeHead(500, { "Content-Type": "text/plain" });
          return res.end("internal error");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(mode === "blank" ? BLANK_HTML : GOOD_HTML);
      }
      // Смена режима сайта из теста.
      if (p === "/__mode") {
        mode = String(u.searchParams.get("set") || "ok");
        return json(200, { mode });
      }
      if (p === "/__seen") return json(200, { seen, calls });

      seen.push(req.method + " " + p + (u.search || ""));

      if (p === "/iam/v1/tokens") return json(200, { iamToken: "fake-iam", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p === "/resource-manager/v1/clouds") return json(200, { clouds: [{ id: "cloud1", name: "mycloud" }] });
      if (p === "/resource-manager/v1/folders") return json(200, { folders: [{ id: "f1", name: "default" }] });
      if (p.startsWith("/resource-manager/v1/folders/f1:updateAccessBindings")) return json(200, { id: "op-sa", done: true });

      // Реестр образов: сначала пусто, после создания — он есть.
      if (p === "/container-registry/v1/registries") {
        if (req.method === "POST") {
          calls.registryCreated = (calls.registryCreated || 0) + 1;
          return json(200, { id: "op-reg", done: true });
        }
        return json(200, { registries: calls.registryCreated ? [{ id: "crp1", name: "shop-registry", folderId: "f1" }] : [] });
      }

      // Serverless Containers
      if (p === "/containers/v1/containers") {
        if (req.method === "POST") {
          calls.containerCreated = (calls.containerCreated || 0) + 1;
          return json(200, { id: "op-cont", done: true });
        }
        return json(200, { containers: calls.containerCreated ? [{ id: "cont1", name: "shop", status: "ACTIVE" }] : [] });
      }
      if (p === "/containers/v1/containers/cont1") {
        // Адрес контейнера: после «сломанного» выката сайт отдаёт 500 — движок
        // должен заметить это и откатиться.
        return json(200, { id: "cont1", name: "shop", folderId: "f1", status: "ACTIVE", url: "http://127.0.0.1:" + sitePort + "/app" });
      }
      if (p === "/containers/v1/revisions:deploy" && req.method === "POST") {
        calls.deploys++;
        let imageUrl = "";
        try {
          const parsed = JSON.parse(body || "{}");
          imageUrl = ((parsed.imageSpec || {}).imageUrl) || "";
          calls.lastEnv = (parsed.imageSpec || {}).environment || {};
        } catch {}
        calls.images.push(imageUrl);
        // Ревизия появляется в списке — от неё зависит откат на прошлую версию.
        revisions.unshift({ id: "rev" + calls.deploys, status: "ACTIVE", createdAt: new Date(Date.now() + calls.deploys).toISOString(), image: { imageUrl } });
        return json(200, { id: "op-rev", done: true });
      }
      if (p === "/containers/v1/containers/cont1:rollback" && req.method === "POST") {
        calls.rollback++;
        mode = "ok"; // откат возвращает живую версию
        return json(200, { id: "op-rb", done: true });
      }
      if (p === "/containers/v1/revisions") return json(200, { revisions });

      // Сервисный аккаунт
      if (p === "/iam/v1/serviceAccounts") {
        if (req.method === "POST") {
          calls.saCreated = (calls.saCreated || 0) + 1;
          return json(200, { id: "op-sa", done: true });
        }
        return json(200, { serviceAccounts: calls.saCreated ? [{ id: "sa1", name: "sa-shop", folderId: "f1" }] : [] });
      }

      // Операции: приложение опрашивает их до готовности. Без этого ответа
      // деплой честно ждёт полный срок ожидания (минуты) — и тест «висит».
      if (p.startsWith("/operations/")) return json(200, { id: p.split("/").pop(), done: true });

      // Прочее — считаем выполненным.
      if (req.method === "GET") return json(200, {});
      json(200, { id: "op", done: true });
    });
  });
}
let sitePort = 0;

function hasXvfb() {
  return spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).status === 0;
}

// ── Фальшивый docker в PATH ─────────────────────────────────────────────────
function makeFakeDocker(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "docker");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "Docker version 25.0.3, build fake"; exit 0;;',
      "  login) cat > /dev/null; echo 'Login Succeeded'; exit 0;;",
      "  build) echo 'Step 1/1 : fake build'; echo \"Successfully tagged $4\"; exit 0;;",
      "  push) echo 'The push refers to repository'; echo 'latest: digest: sha256:deadbeef size: 1234'; exit 0;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const win = path.join(dir, "docker.cmd");
  fs.writeFileSync(win, "@echo off\r\necho Docker version 25.0.3, build fake\r\nexit /b 0\r\n");
  return dir;
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

  const port = await freePort();
  sitePort = port;
  const srv = startFake();
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + port;
  console.log("\n[1] Подменённые Yandex Cloud и сайт проекта: " + base);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deploy-"));
  const fakeDockerDir = makeFakeDocker(path.join(workDir, "bin"));

  // Проект: Vite-сборка, но скрипты не требуют зависимостей — проверяем, что
  // локальная сборка и тесты действительно выполняются до сборки образа.
  const proj = path.join(workDir, "shop");
  fs.mkdirSync(path.join(proj, "node_modules"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify(
      {
        name: "shop",
        devDependencies: { vite: "5" },
        scripts: {
          build: "node -e \"require('fs').writeFileSync('dist-built.txt','ok')\"",
          test: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(proj, "index.html"), "<h1>shop</h1>");
  fs.writeFileSync(path.join(proj, ".env"), "DATABASE_URL=postgres://user:secret-pw@host/db\n");

  const killApp = { fn: () => {} };
  const args = [
    electronExe, ".", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=" + path.join(workDir, "userdata"),
    "--remote-debugging-port=" + CDP,
  ];
  const useXvfb = process.platform === "linux" && hasXvfb();
  if (process.platform === "linux" && !useXvfb) {
    console.error("✗ Нет xvfb-run — на Linux без дисплея окно не поднять.");
    srv.close();
    process.exit(2);
  }
  const child = spawn(useXvfb ? "xvfb-run" : electronExe, useXvfb ? ["-a", "-s", "-screen 0 1440x900x24", ...args] : args.slice(1), {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      AI_AGENT_OTA_ROOT: path.join(workDir, "ota"),
      AI_AGENT_YC_BASE: base,
      // Проверка после деплоя не должна ждать холодного старта по-настоящему.
      AI_AGENT_DEPLOY_HEALTH_TRIES: "2",
      AI_AGENT_DEPLOY_HEALTH_MS: "300",
      PATH: fakeDockerDir + path.delimiter + (process.env.PATH || ""),
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let elog = "";
  child.stdout.on("data", (d) => (elog += d));
  child.stderr.on("data", (d) => (elog += d));
  killApp.fn = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch("http://127.0.0.1:" + CDP + "/json/version");
      if (r.ok) {
        up = true;
        break;
      }
    } catch (e) {}
    await sleep(500);
  }
  check("приложение поднялось", up, up ? "" : elog.slice(-300));
  if (!up) {
    killApp.fn();
    srv.close();
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /index\.html/.test(p.url()));
  const pageErrs = [];
  if (page) {
    page.on("pageerror", (e) => pageErrs.push("pageerror: " + e.message));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrs.push("console: " + m.text().slice(0, 200));
    });
  }
  check("окно приложения найдено", !!page);
  if (!page) {
    await browser.close().catch(() => {});
    killApp.fn();
    srv.close();
    process.exit(1);
  }

  try {
    console.log("\n[2] Подключение облака и рабочая папка проекта");
    const conn = await page.evaluate(async (dir) => {
      const t = await window.api.ycSetToken("fake-oauth");
      if (!t || !t.ok) return { ok: false, error: (t && t.error) || "токен не принят" };
      await window.api.ycSetFolder(t.folderId, t.folderName, t.cloudId);
      await window.api.ycSetPermissions(true, false, true); // создание ресурсов разрешено
      const s = await window.api.getSettings();
      await window.api.setSettings(Object.assign({}, s, { workingDir: dir }));
      return { ok: true, folder: t.folderName };
    }, proj);
    check("токен, каталог и рабочая папка приняты", conn.ok && conn.folder === "default", conn.error || "");

    console.log("\n[3] Панель «Деплой»: рецепт проекта виден до запуска");
    const panel = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Окно навешивает обработчики рельсы не мгновенно: пока грузятся модули,
      // первый клик уходит в пустоту. Жмём, пока панель не откроется: иначе тест
      // падал бы из-за скорости загрузки, а не из-за дефекта в приложении.
      const sp = document.getElementById("sp-deploy");
      let clicks = 0;
      for (let i = 0; i < 60 && sp.classList.contains("hidden"); i++) {
        document.getElementById("rail-deploy").click();
        clicks++;
        await wait(250);
      }
      await wait(1200);
      const body = document.getElementById("dp-body");
      return {
        open: !document.getElementById("sp-deploy").classList.contains("hidden"),
        recipe: (document.querySelector("#sp-deploy .dp-recipe-kind") || {}).textContent || "",
        meta: (document.querySelector("#sp-deploy .dp-recipe-meta") || {}).textContent || "",
        name: (document.getElementById("dp-name") || {}).value || "",
        status: (document.getElementById("dp-status") || {}).textContent || "",
        cost: (document.querySelector("#sp-deploy .dp-cost") || {}).textContent || "",
        costTop: (document.querySelector("#sp-deploy .dp-cost-top") || {}).textContent || "",
        text: body ? body.textContent.slice(0, 200) : "",
        clicks,
      };
    });
    check(
      "вкладка деплоя открылась из рельсы",
      panel.open,
      panel.open ? "" : "кликов: " + panel.clicks + " · ошибки страницы: " + (pageErrs.slice(0, 2).join(" | ") || "нет")
    );
    check("тип проекта распознан заранее", panel.recipe === "Vite / React", panel.recipe + " · " + panel.meta);
    check("имя приложения подставлено из папки", panel.name === "shop", panel.name);
    check("стоимость выката видна ДО запуска", /Стоимость ревизии/.test(panel.costTop) && /₽/.test(panel.cost), panel.costTop);
    check("в стоимости названа круглосуточная работа как дорогая", /круглосуточно/.test(panel.cost) && /не стоит/.test(panel.cost), (panel.cost.match(/круглосуточно[^·]*/) || [""])[0].slice(0, 110));

    console.log("\n[4] Деплой кнопкой: стадии, проверка адреса, история");
    const first = await page.evaluate(async (proj) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("btn-dp-deploy").click();
      // Ждём по состоянию деплоя в приложении, а не по тексту в шапке:
      // интерфейс рисует его производным от тех же данных, и так тест не зависит
      // от порядка отрисовки.
      for (let i = 0; i < 120; i++) {
        await wait(700);
        const st = await window.api.deployState(proj);
        const cur = st && st.current;
        if (cur && cur.status && cur.status !== "running") break;
      }
      await wait(400);
      const stages = [...document.querySelectorAll("#sp-deploy .dp-stage")].map((r) => ({
        name: (r.querySelector(".dp-stage-name") || {}).textContent || "",
        status: r.className.replace("dp-stage ", ""),
        detail: (r.querySelector(".dp-stage-detail") || {}).textContent || "",
      }));
      return {
        status: document.getElementById("dp-status").textContent,
        url: (document.querySelector("#sp-deploy .dp-url") || {}).textContent || "",
        stages,
        history: [...document.querySelectorAll("#sp-deploy .dp-hist")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
        message: (document.querySelector("#sp-deploy .dp-msg") || {}).textContent || "",
        meta: (document.querySelector("#sp-deploy .dp-current-meta") || {}).textContent || "",
      };
    });
    check("прогон дошёл до Production", /Production/.test(first.status), first.status);
    check("адрес сайта показан", /^http:\/\/127\.0\.0\.1:\d+\/app$/.test(first.url), first.url);
    check("стадий ровно 13 и все успешны", first.stages.length === 13 && first.stages.every((s) => s.status === "ok"), first.stages.map((s) => s.status).join(","));
    const browseStage = first.stages.find((s) => s.name === "Проверка в браузере") || {};
    check("страница проверена браузером (адрес, текст, заголовок)", /HTTP 200/.test(browseStage.detail || "") && /текста \d+/.test(browseStage.detail || "") && /Витрина магазина/.test(browseStage.detail || ""), browseStage.detail || "нет стадии");
    check("локальная сборка и тесты прошли до образа", first.stages.some((s) => s.name === "Проверки проекта" && /сборка/.test(s.detail)), (first.stages.find((s) => s.name === "Проверки проекта") || {}).detail || "");
    check("проверка после деплоя показала HTTP 200", first.stages.some((s) => s.name === "Проверка после деплоя" && /HTTP 200/.test(s.detail)), (first.stages.find((s) => s.name === "Проверка после деплоя") || {}).detail || "");
    check("в истории появился деплой #1", first.history.length === 1 && /#1/.test(first.history[0]), first.history.join(" / "));
    check("образ с версионным тегом (не только latest)", /d1/.test(first.meta), first.meta);

    console.log("\n[5] Что осталось на диске: состояние .cloud");
    const stateFiles = ["project.json", "infrastructure.json", "deployments.json"].filter((f) => fs.existsSync(path.join(proj, ".cloud", f)));
    check("состояние проекта записано", stateFiles.length === 3, stateFiles.join(", "));
    const dstate = JSON.parse(fs.readFileSync(path.join(proj, ".cloud", "deployments.json"), "utf8"));
    const infra = JSON.parse(fs.readFileSync(path.join(proj, ".cloud", "infrastructure.json"), "utf8"));
    const allState = JSON.stringify(dstate) + JSON.stringify(infra);
    check("в истории стадии с отметками", (dstate.items[0].stages || []).every((s) => s.status === "ok"));
    check("реестр и контейнер сохранены", infra.registry.id === "crp1" && infra.container.id === "cont1", JSON.stringify({ reg: infra.registry.id, cont: infra.container.id }));
    check("значение секрета из .env в состояние не попало", !allState.includes("secret-pw"), allState.includes("secret-pw") ? "УТЕЧКА" : "чисто");
    check("в образ секрет тоже не уехал", !JSON.stringify(calls.lastEnv || {}).includes("secret-pw"), JSON.stringify(calls.lastEnv || {}));
    check("Dockerfile и .dockerignore созданы, .env исключён", fs.existsSync(path.join(proj, "Dockerfile.yandexcloud")) && fs.readFileSync(path.join(proj, ".dockerignore"), "utf8").includes(".env"));
    const shots = fs.existsSync(path.join(proj, ".cloud", "screenshots")) ? fs.readdirSync(path.join(proj, ".cloud", "screenshots")) : [];
    check("скриншот выкаченной страницы сохранён", shots.includes("d1.png") && fs.statSync(path.join(proj, ".cloud", "screenshots", "d1.png")).size > 1000, shots.join(", ") || "нет файлов");

    console.log("\n[5b] Панель показывает, что увидел браузер");
    const panelSeen = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await window.DeployPanel.refresh();
      await wait(500);
      const line = document.querySelector("#sp-deploy .dp-browser");
      const warns = [...document.querySelectorAll("#sp-deploy .dp-block")]
        .filter((b) => /Страница в браузере/.test(b.textContent))
        .flatMap((b) => [...b.querySelectorAll(".dp-warn")].map((w) => w.textContent));
      return { line: line ? line.textContent : "", kind: line ? line.className : "", warns };
    });
    check("строка проверки страницы в панели", /HTTP 200/.test(panelSeen.line) && /текста \d+/.test(panelSeen.line) && /Витрина/.test(panelSeen.line), panelSeen.line);
    check("ошибка консоли видна как замечание, а не спрятана", panelSeen.warns.some((w) => /консоли/.test(w) && /cart is not a function/.test(w)), panelSeen.warns.join(" | "));
    check("проверка помечена как «с замечаниями», а не как успех", /warn/.test(panelSeen.kind), panelSeen.kind);

    const shot = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = [...document.querySelectorAll("#sp-deploy .dp-row button")].find((b) => /Скриншот/.test(b.textContent));
      if (!btn) return { ok: false, error: "нет кнопки скриншота" };
      btn.click();
      await wait(1200);
      const img = document.querySelector("#sp-deploy img.dp-shot");
      return { ok: !!img, src: img ? String(img.src).slice(0, 30) : "", bytes: img ? img.src.length : 0 };
    });
    check("скриншот открывается по кнопке прямо в панели", shot.ok && /^data:image\/png;base64,/.test(shot.src) && shot.bytes > 2000, shot.error || shot.bytes + " символов data-URL");

    console.log("\n[6] Сломанный выкат: движок сам откатывается на прошлую версию");
    mode = "http500";
    const second = await page.evaluate(async (proj) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("btn-dp-deploy").click();
      for (let i = 0; i < 120; i++) {
        await wait(700);
        const st = await window.api.deployState(proj);
        const cur = st && st.current;
        if (cur && cur.status && cur.status !== "running") break;
      }
      await wait(400);
      const stages = [...document.querySelectorAll("#sp-deploy .dp-stage")].map((r) => ({
        name: (r.querySelector(".dp-stage-name") || {}).textContent || "",
        status: r.className.replace("dp-stage ", ""),
      }));
      return {
        status: document.getElementById("dp-status").textContent,
        message: (document.querySelector("#sp-deploy .dp-msg") || {}).textContent || "",
        stages,
        history: [...document.querySelectorAll("#sp-deploy .dp-hist")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
      };
    }, proj);
    check("панель говорит «Откатили», а не «Провал»", /Откатили/.test(second.status), second.status);
    check("в сообщении сказано, что сайт работает", /откатил|работает/i.test(second.message), second.message.slice(0, 120));
    check("стадия проверки помечена ✗, а откат ✓", second.stages.some((s) => s.name === "Проверка после деплоя" && s.status === "fail") && second.stages.some((s) => s.name === "Откат на прошлую рабочую версию" && s.status === "ok"), second.stages.map((s) => s.name + ":" + s.status).join(" "));
    check("в истории два деплоя, последний — откат", second.history.length === 2 && /откат|Откат/i.test(second.history[0]), second.history.join(" / "));
    check("откат ушёл в облако настоящим запросом", calls.rollback === 1, "POST rollback: " + calls.rollback);
    const alive = await page.evaluate(async (url) => window.api.deployHealth(url, ["/"]), "http://127.0.0.1:" + sitePort + "/app");
    check("после отката сайт снова отвечает", !!(alive && alive.ok) && alive.status === 200, JSON.stringify(alive && { ok: alive.ok, status: alive.status, reason: alive.reason }));

    console.log("\n[6b] Белый экран: HTTP 200 есть, страницы нет — это видит только браузер");
    mode = "blank";
    const blank = await page.evaluate(async (proj) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById("btn-dp-deploy").click();
      for (let i = 0; i < 120; i++) {
        await wait(700);
        const st = await window.api.deployState(proj);
        const cur = st && st.current;
        if (cur && cur.status && cur.status !== "running") break;
      }
      await wait(600);
      const stages = [...document.querySelectorAll("#sp-deploy .dp-stage")].map((r) => ({
        name: (r.querySelector(".dp-stage-name") || {}).textContent || "",
        status: r.className.replace("dp-stage ", ""),
      }));
      return {
        status: document.getElementById("dp-status").textContent,
        message: (document.querySelector("#sp-deploy .dp-msg") || {}).textContent || "",
        stages,
      };
    }, proj);
    const browseBad = blank.stages.find((s) => s.name === "Проверка в браузере") || {};
    check("проверка адреса прошла, а браузер увидел пустую страницу", blank.stages.some((s) => s.name === "Проверка после деплоя" && s.status === "ok") && browseBad.status === "fail", JSON.stringify(browseBad));
    check("движок откатил выкат из-за белого экрана", /Откатили/.test(blank.status) && /белый экран/i.test(blank.message), blank.status + " · " + blank.message.slice(0, 80));
    const after = await page.evaluate(async (url) => window.api.deployHealth(url, ["/"]), "http://127.0.0.1:" + sitePort + "/app");
    check("сайт отвечает после самолечения", !!(after && after.ok), JSON.stringify(after && { ok: after.ok, status: after.status }));

    console.log("\n[7] Ручной откат и честные ошибки");
    const manual = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.confirm = () => true;
      document.getElementById("btn-dp-rollback").click();
      for (let i = 0; i < 40; i++) {
        await wait(500);
        const t = (document.querySelector("#sp-deploy .dp-msg") || {}).textContent || "";
        if (/Откатили на|Откат не прошёл/.test(t)) return t;
      }
      return (document.querySelector("#sp-deploy .dp-msg") || {}).textContent || "";
    });
    check("кнопка «Откатить» работает и объясняет результат", /Откатили на #\d+/.test(manual), manual.slice(0, 120));
    const guarded = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const before = await window.api.deployState("");
      // Пустая папка: движок должен сказать словами, а не падать.
      const empty = await window.api.deployRun("/nope/совсем-нет", { name: "x" });
      await wait(200);
      return { okBefore: before.ok, emptyError: (empty && empty.error) || "", emptyOk: !!(empty && empty.ok) };
    });
    check("состояние читается через IPC", guarded.okBefore);
    check("несуществующая папка — понятная ошибка", !guarded.emptyOk && /не найдена/i.test(guarded.emptyError), guarded.emptyError.slice(0, 90));

    console.log("\n[8] Ошибки страницы");
    const real = pageErrs.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND|ERR_NAME_NOT_RESOLVED/i.test(e));
    check("нет ошибок JS и консоли", real.length === 0, real.slice(0, 3).join(" | ") || "чисто");
  } catch (e) {
    check("живой прогон без исключений", false, e.message);
  } finally {
    await browser.close().catch(() => {});
    killApp.fn();
    srv.close();
  }

  console.log("\n=== ЖИВОЙ ТЕСТ ДЕПЛОЯ: " + pass + " ✅ / " + fail + " ❌ ===");
  if (fail) {
    console.log("\nзапросов к подменённому API: " + seen.length + ", выкатов: " + calls.deploys + ", откатов: " + calls.rollback);
    console.log(seen.slice(-25).join("\n"));
  }
  process.exit(fail ? 1 : 0);
})();

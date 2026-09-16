"use strict";
/* ЖИВОЙ тест интерфейса (не структурный, как test/smoke.test.js).
   Запуск: bun run test:live   (нужен браузер: npx playwright install chromium)

   Что делает: поднимает server.js на свободном порту, открывает настоящий Chromium,
   подменяет поток провайдера и проверяет то, что структурный тест поймать не может:
     • интерфейс грузится без ошибок, рельса/панели/настройки реально работают;
     • план ТЕКСТОМ от модели → появляется панель-чеклист над полем ввода;
     • план через инструмент todoWrite → появляется та же панель;
     • функции ядра в живой странице: роутер инструментов и разбор 503 cache_only_cold;
     • мобильная ширина: рельса скрыта, поле ввода доступно.

   Повод: «голый» normalizePlanTasks в app.js (без AgentCore.) ронял разбор плана
   ReferenceError-ом, а тот молча гас в потоке ответа — панель плана не появлялась ни
   разу ни в одном сценарии. Структурный тест этого не видел, потому что сам
   подставлял нормализатор в область видимости. */
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Список адресов, для которых 4xx/5xx — норма (раньше тут был /bootstrap.js: файла не
// было ни в Electron, ни в веб-превью, и браузер писал ошибку в консоль на каждом
// запуске; теперь по этому пути лежит пустая заглушка src/renderer/bootstrap.js).
const INTENTIONAL_404 = [];

// Сценарии генерации картинок намеренно воспроизводят отказ провайдера (404 пустым телом,
// несуществующий путь), чтобы проверить наш разбор ошибок. Такие ответы — часть проверки,
// а не сбой страницы, поэтому считаем их ожидаемыми (гасим и HTTP, и сообщение консоли).
function isFakeProviderFailure(u) {
  if (!u.pathname.startsWith("/api/llm/")) return false;
  const rest = u.pathname.slice("/api/llm/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return false;
  try {
    const base = decodeURIComponent(rest.slice(0, slash));
    return /(^|\.)live\.test$/.test(new URL(base).host);
  } catch (e) {
    return false;
  }
}

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log("  ✅ " + name + (extra ? " — " + extra : ""));
  } else {
    fail++;
    console.log("  ❌ " + name + (extra ? " — " + extra : ""));
  }
}

const PLAN_TEXT =
  "План работы:\n1. Прочитать карту окна приложения\n2. Найти кнопку сохранения\n3. Нажать её и проверить результат";
const sseText = (t) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] }) + "\n\n" + "data: [DONE]\n\n";
const sseTool = (name, args) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_live_1", type: "function", function: { name: name, arguments: args } }] } }] }) + "\n\n" +
  "data: " + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "\n\n" +
  "data: [DONE]\n\n";

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

async function startServer(port) {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), HOST: "127.0.0.1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  const t0 = Date.now();
  while (!/preview:/.test(log)) {
    if (Date.now() - t0 > 20000) throw new Error("сервер не поднялся за 20 с: " + log);
    await sleep(150);
  }
  return { srv, log: log.trim().split("\n").pop() };
}

(async () => {
  let chromium;
  try {
    chromium = require(path.join(ROOT, "node_modules", "playwright")).chromium;
  } catch (e) {
    console.error("✗ Нет playwright. Установи: bun install && npx playwright install chromium");
    process.exit(2);
  }

  const PORT = await freePort();
  const BASE = "http://127.0.0.1:" + PORT;

  console.log("\n[1] Сервер приложения");
  let srv = null;
  try {
    const started = await startServer(PORT);
    srv = started.srv;
    check("сервер поднялся", true, started.log);
    const r0 = await fetch(BASE + "/");
    const html = await r0.text();
    check(
      "GET / → 200, есть рельса и панель плана",
      r0.status === 200 && html.includes('id="rail"') && html.includes('id="plan-panel"'),
      r0.status + ", " + html.length + " байт"
    );
    // prompts.js и tool-schemas.js — данные ядра (текст правил и таблица инструментов):
    // 404 по ним означает, что в окне агент стартует без правил и без инструментов.
    // yc-panel.js — панель Yandex Cloud (этап 2 разбора app.js): без неё app.js не
    // соберёт панель, и раздел «облако» в окне молча перестанет работать.
    for (const f of ["app.js", "provider-config.js", "provider-transport.js", "context-window.js", "web-tools.js", "image-tools.js", "prompts.js", "tool-schemas.js", "agent-core.js", "yc-panel.js", "chat-actions.js", "styles.css", "monochrome.css"]) {
      const rr = await fetch(BASE + "/" + f);
      check("GET /" + f + " → 200", rr.status === 200);
    }
  } catch (e) {
    check("сервер поднялся", false, e.message);
  }

  let browser = null;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (e) {
    console.error("\n✗ Браузер не запустился: " + e.message);
    console.error("  Установи его: npx playwright install --with-deps chromium");
    if (srv) srv.kill("SIGKILL");
    process.exit(2);
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem(
        "settings",
        JSON.stringify({
          provider: "openai",
          openaiUrl: "https://api.groq.com/openai/v1",
          openaiApiKey: "live-test-key",
          openaiModel: "live-test-model",
          model: "live-test-model",
          agentEnv: { LIVE_SCOPE_KEY: "секрет-для-выдачи" },
        })
      );
      localStorage.setItem("chats", JSON.stringify({ chats: [], activeId: null }));
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  const badHttp = [];
  const explained = [];
  // Браузер печатает «Failed to load resource» без адреса, поэтому ожидаемые 404
  // (файл моста телефона) считаем по ответам и гасим ровно столько же сообщений.
  let expected404 = 0;
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource/.test(t) && expected404 > 0) {
      expected404--;
      explained.push(t);
      return;
    }
    errs.push("console.error: " + t);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const u = new URL(r.url());
    if (INTENTIONAL_404.includes(u.pathname) || isFakeProviderFailure(u)) expected404++;
    else badHttp.push(r.status() + " " + u.pathname);
  });

  // Подмена провайдера: чат — SSE-потоком, генерация картинок — JSON-ответами.
  // Так весь путь (провайдер определяется по адресу → путь запроса → разбор ответа)
  // проверяется на настоящем коде в настоящем браузере.
  let scenario = "text";
  let calls = 0;
  const imgCalls = []; // { path, body } — что и куда просила генерация картинок
  const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gG8uwAAAABJRU5ErkJggg==";
  await page.route("**/api/llm/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const rest = u.pathname.slice("/api/llm/".length);
    const slash = rest.indexOf("/");
    let base = "";
    try {
      base = decodeURIComponent(rest.slice(0, slash));
    } catch (e) {}
    const pathOnly = rest.slice(slash);
    if (/images|sdapi/.test(pathOnly)) {
      imgCalls.push({ path: base + pathOnly, body: req.postData() || "" });
      let host = "";
      try {
        host = new URL(base).host;
      } catch (e) {}
      const json = (status, payload) =>
        route.fulfill({ status: status, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const isGen = /\/images\/generations$/.test(pathOnly);
      if (host === "broken.live.test") {
        // Полный отказ: пустое тело и 404 — раньше это давало пустую ошибку.
        await route.fulfill({ status: 404, headers: { "content-type": "application/json" }, body: "" });
        return;
      }
      if (host === "gw.live.test" && !isGen) await json(200, { data: [{ b64_json: TINY_PNG }] });
      else if (host === "gw.live.test") await json(404, { error: { message: "Not Found" } });
      else if (host === "openrouter.ai" && !isGen) await json(200, { data: [{ b64_json: TINY_PNG }] });
      else if (host === "generativelanguage.googleapis.com" && isGen) await json(200, { data: [{ b64_json: TINY_PNG, media_type: "image/png" }] });
      else await json(404, { error: { message: "No such endpoint: " + pathOnly } });
      return;
    }
    calls++;
    let body;
    if (scenario === "tool" && calls === 1) {
      body = sseTool(
        "todoWrite",
        JSON.stringify({ title: "План работ", tasks: ["Прочитать карту окна приложения", "Найти кнопку сохранения", "Нажать её"] })
      );
    } else if (scenario === "text") {
      body = sseText(PLAN_TEXT);
    } else {
      body = sseText("Готово: план показан, дальше по пунктам.");
    }
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" }, body: body });
  });

  async function waitPlan(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (await page.locator("#plan-panel").isVisible()) return true;
      await sleep(200);
    }
    return false;
  }

  try {
    console.log("\n[2] Живой интерфейс");
    await page.goto(BASE, { waitUntil: "load" });
    await page.waitForSelector("#rail", { state: "visible", timeout: 10000 });
    await sleep(600);
    check("рельса: 9 иконок (добавился «Деплой»)", (await page.locator("#rail .rail-btn").count()) === 9);
    check("на рельсе есть кнопка «Дела»", await page.locator("#rail-tasks").isVisible());
    check("на рельсе есть кнопка «Деплой»", await page.locator("#rail-deploy").isVisible());
    check("список чатов виден", await page.locator("#sidebar").isVisible());
    check("на рельсе подсвечены «Чаты»", ((await page.locator("#rail-chats").getAttribute("class")) || "").includes("active"));

    await page.click("#rail-settings");
    await sleep(300);
    check("настройки открываются с рельсы", await page.locator("#settings-overlay").isVisible());
    await page.fill("#settings-search", "zzzqqq");
    await sleep(250);
    check("поиск настроек отвечает «ничего не найдено»", await page.locator("#settings-empty").isVisible());
    await page.click("#settings-search-clear");
    await sleep(250);
    check("очистка поиска возвращает вкладки", !(await page.locator("#settings-empty").isVisible()));
    await page.click("#btn-close-settings");
    await sleep(250);
    check("настройки закрываются", !(await page.locator("#settings-overlay").isVisible()));

    // Выдача секретов (1.5.84): у каждой переменной агента видно, кому она подставляется.
    await page.click("#rail-settings");
    await sleep(250);
    await page.click('.stab[data-tab="secrets"]');
    await sleep(300);
    const scopeSel = page.locator("#env-list .env-scope");
    check("у переменной агента есть выбор выдачи", (await scopeSel.count()) === 1);
    const scopeOpts = await scopeSel.locator("option").allTextContents();
    check(
      "выдача предлагает «всем командам» и «ни одному инструменту»",
      scopeOpts.some((t) => /Всем командам/.test(t)) && scopeOpts.some((t) => /Ни одному/.test(t))
    );
    check("по умолчанию переменная выдана всем", (await scopeSel.inputValue()) === "*");
    await scopeSel.selectOption("none");
    await sleep(250);
    const savedScopes = await page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "{}").agentEnvScopes || {});
    check("выбранная выдача сохраняется настройками", Array.isArray(savedScopes.LIVE_SCOPE_KEY) && savedScopes.LIVE_SCOPE_KEY.length === 0);
    check("ограничение видно прямо в строке", ((await scopeSel.getAttribute("class")) || "").includes("limited"));
    await scopeSel.selectOption("*"); // возвращаем как было — дальше проверки не должны зависеть от этого
    await sleep(200);
    const backToAll = await page.evaluate(() => JSON.parse(localStorage.getItem("settings") || "{}").agentEnvScopes || {});
    check("«всем» убирает ограничение из настроек", !("LIVE_SCOPE_KEY" in backToAll));
    await page.click("#btn-close-settings");
    await sleep(250);

    await page.click("#rail-chats");
    await sleep(400);
    check(
      "«Чаты» сворачивают список, рельса остаётся",
      (await page.locator("#sidebar").evaluate((e) => e.classList.contains("collapsed"))) && (await page.locator("#rail").isVisible())
    );
    await page.click("#rail-chats");
    await sleep(400);
    check("повторное нажатие разворачивает список", !(await page.locator("#sidebar").evaluate((e) => e.classList.contains("collapsed"))));

    console.log("\n[3] План текстом от модели → панель плана");
    calls = 0;
    scenario = "text";
    await page.fill("#input", "Проверь окно приложения и нажми кнопку сохранения");
    await page.click("#btn-send");
    const shownText = await waitPlan(20000);
    check("панель плана появилась", shownText);
    const itemsText = await page.locator("#plan-panel .plan-item").count();
    check("в панели 3 пункта", itemsText === 3, "пунктов: " + itemsText);
    const panelText = shownText ? (await page.locator("#plan-panel").innerText()).trim() : "";
    check("пункты совпадают с планом модели", /Прочитать|кнопку сохранения|проверить результат/i.test(panelText), JSON.stringify(panelText.slice(0, 90)));
    check(
      "пользователю сказали, что план появился",
      await page.evaluate(() => Array.from(document.querySelectorAll("div")).some((d) => /чеклист/i.test(d.textContent || "")))
    );

    console.log("\n[4] План через инструмент todoWrite → панель плана");
    await page.click("#rail-new");
    await sleep(500);
    calls = 0;
    scenario = "tool";
    await page.fill("#input", "Составь план работ");
    await page.click("#btn-send");
    const shownTool = await waitPlan(25000);
    check("панель плана появилась от инструмента", shownTool);
    const toolPanel = shownTool ? (await page.locator("#plan-panel").innerText()).trim() : "";
    check("видны пункты от инструмента", /Прочитать|кнопку|Нажать/i.test(toolPanel), JSON.stringify(toolPanel.slice(0, 90)));
    check("было ≥2 раунда (инструмент + ответ)", calls >= 2, "запросов к модели: " + calls);

    console.log("\n[5] Генерация картинок: провайдер по адресу (живьём в браузере)");
    const gen = await page.evaluate(async () => {
      const A = window.AgentCore;
      const run = async (cfg, model, ratio) => {
        try {
          const r = await A.generateImageRemote(cfg, "кот в шляпе", model, ratio ? { aspectRatio: ratio } : {});
          return { ok: true, kind: r.kind, label: r.label, mediaType: r.mediaType, ext: r.ext, len: (r.b64 || "").length };
        } catch (e) {
          return { ok: false, message: String((e && e.message) || e) };
        }
      };
      return {
        gemini: await run({ url: "https://generativelanguage.googleapis.com/v1beta/openai", key: "g" }, "gemini-2.5-flash-image", "16:9"),
        openrouter: await run({ url: "https://openrouter.ai/api/v1", key: "o" }, "openai/dall-e-3", "1:1"),
        gateway: await run({ url: "https://gw.live.test/v1", key: "k" }, "model-x", ""),
        gatewayAgain: await run({ url: "https://gw.live.test/v1", key: "k" }, "model-x", ""),
        broken: await run({ url: "https://broken.live.test/v1", key: "k" }, "model-x", ""),
        labelUnknown: A.imageProviderLabel("https://gw.live.test/v1"),
      };
    });
    check("Gemini: OpenAI-совместимый путь /images/generations", gen.gemini.ok && gen.gemini.kind === "openai_images", JSON.stringify(gen.gemini).slice(0, 120));
    check("Gemini: провайдер назван правильно", /Gemini/.test(gen.gemini.label || ""), gen.gemini.label);
    check("OpenRouter: свой путь /images", gen.openrouter.ok && gen.openrouter.kind === "openrouter", JSON.stringify(gen.openrouter).slice(0, 120));
    check("незнакомый шлюз: путь найден перебором", gen.gateway.ok && gen.gateway.kind === "openrouter", JSON.stringify(gen.gateway).slice(0, 120));
    check("незнакомый адрес честно назван незнакомым", /незнаком/.test(gen.labelUnknown || ""), gen.labelUnknown);
    const geminiCall = imgCalls.find((c) => /generativelanguage/.test(c.path)) || { path: "нет" };
    check("запрос Gemini ушёл на /v1beta/openai/images/generations", /\/v1beta\/openai\/images\/generations$/.test(geminiCall.path), geminiCall.path.replace(/^https:\/\//, ""));
    const orCall = imgCalls.find((c) => /openrouter\.ai\/api\/v1\/images$/.test(c.path)) || { path: "нет", body: "" };
    check("в OpenRouter ушёл aspect_ratio", /"aspect_ratio":"1:1"/.test(orCall.body), orCall.body.slice(0, 90));
    const gw = imgCalls.filter((c) => /gw\.live\.test/.test(c.path)).map((c) => c.path.replace(/^https:\/\/gw\.live\.test/, ""));
    check("шлюз: сначала /images/generations, потом /images", /\/v1\/images\/generations$/.test(gw[0] || "") && /\/v1\/images$/.test(gw[1] || ""), gw.join(" → "));
    check("второй вызов помнит удачный путь (без лишнего 404)", gw.length === 3 && /\/v1\/images$/.test(gw[2]), "запросов к шлюзу: " + gw.length + " (" + gw.join(" → ") + ")");
    check("полный отказ: подробная ошибка, а не пустая", !gen.broken.ok && /Не удалось сгенерировать/.test(gen.broken.message) && /HTTP 404/.test(gen.broken.message) && /broken\.live\.test/.test(gen.broken.message) && /images/.test(gen.broken.message), (gen.broken.message || "").split("\n")[0] + " | " + ((gen.broken.message || "").match(/HTTP 404/g) || []).length + " попыток 404");

    console.log("\n[6] Живой AgentCore в браузере");
    const live = await page.evaluate((badJson) => {
      const A = window.AgentCore;
      const hist = [
        { role: "assistant", content: "Открыл окно приложения и прочитал карту через appRead." },
        { role: "user", content: "Дальше нажми кнопку." },
        { role: "assistant", content: "Нажал кнопку в окне приложения." },
        { role: "user", content: "продолжай" },
      ];
      const withHist = A.routeTools({ text: A.routerTaskText(hist) });
      const oneWord = A.routeTools({ text: "продолжай" });
      const has = (r, n) => r.tools.some((t) => (t.function ? t.function.name : t.name) === n);
      const cold = A.coldCacheInfo(503, badJson, 1);
      const cold3 = A.coldCacheInfo(503, badJson, 3);
      return {
        core: typeof A.routerTaskText === "function" && typeof A.coldCacheInfo === "function",
        groups: withHist.groups,
        tools: withHist.tools.length,
        appRead: has(withHist, "appRead"),
        oneGroups: oneWord.groups,
        oneTools: oneWord.tools.length,
        oneAppRead: has(oneWord, "appRead"),
        coldCold: !!(cold && cold.cold),
        coldWait: cold ? cold.waitMs : null,
        cold3: cold3 ? cold3.waitMs : null,
        coldText: cold ? cold.text : "",
        rate: A.coldCacheInfo(429, "Please retry in 12.3s", 1),
        plain: A.coldCacheInfo(500, "internal error", 1),
      };
    }, JSON.stringify({ message: "cache-only admission rejected a cold, unavailable, or overloaded request", type: "Service Unavailable", param: "", code: "cache_only_cold" }));

    check("AgentCore доступен в живой странице", live.core, "routerTaskText + coldCacheInfo");
    check(
      "роутер по истории: группа app и appRead на «продолжай» после UI-задачи",
      live.groups.includes("app") && live.appRead,
      "группы: [" + live.groups.join(",") + "] · схем " + live.tools
    );
    check(
      "роутер по одной фразе: «продолжай» без appRead (видно, что было раньше)",
      !live.oneAppRead,
      "схем " + live.oneTools + ", группы: [" + live.oneGroups.join(",") + "]"
    );
    check("503 cache_only_cold распознан с паузой", live.coldCold && live.coldWait >= 4000, live.coldWait + " мс");
    check("пауза растёт с попыткой", live.cold3 > live.coldWait, live.coldWait + " → " + live.cold3);
    check("429 и обычный 500 в эту ветку не попадают", live.rate === null && live.plain === null);
    console.log("     текст пользователю: " + live.coldText.slice(0, 105));

    console.log("\n[7] Мобильная ширина 390×844");
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(500);
    check("рельса скрыта на телефоне", (await page.locator("#rail").evaluate((e) => getComputedStyle(e).display)) === "none");
    check("поле ввода доступно", await page.locator("#input").isVisible());

    console.log("\n[8] Ошибки страницы");
    check("нет ошибочных ответов сервера", badHttp.length === 0, badHttp.slice(0, 4).join(", ") || "чисто");
    check("нет ошибок JS и консоли", errs.length === 0, errs.slice(0, 4).join(" | ") || "чисто" + (explained.length ? " (объяснено ожидаемых: " + explained.length + ")" : ""));
  } catch (e) {
    check("живой прогон без исключений", false, e.message);
  } finally {
    await browser.close().catch(() => {});
    if (srv) srv.kill("SIGKILL");
  }

  console.log("\n=== ЖИВОЙ ТЕСТ: " + pass + " ✅ / " + fail + " ❌ ===");
  process.exit(fail ? 1 : 0);
})();

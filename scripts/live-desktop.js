"use strict";
/* ЖИВОЙ СКВОЗНОЙ тест десктопного приложения (настоящее окно Electron, не превью).
   Запуск: bun run test:live:desktop        (нужны playwright и electron)

   Что делает: поднимает локальный фейковый OpenAI-совместимый провайдер, запускает
   приложение, кладёт настройки на этот провайдер и просит модель нарисовать картинку.
   Дальше весь путь идёт как в жизни: главный процесс получает вызов инструмента
   generateImage → определяет протокол по адресу → сохраняет файл на диск.
   Проверяем появление файла-картинки, путь запроса и отчёт агенту.

   Зачем: структурные тесты не видят ни записи файла главным процессом, ни того,
   что реально уходит в сеть. Здесь проверяется всё это в настоящем приложении.

   Linux: нужен Xvfb (ставится вместе с playwright: npx playwright install --with-deps chromium).
   Windows/macOS: окно запускается напрямую, Xvfb не нужен. */
const { spawn, spawnSync } = require("child_process");
const http = require("http");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CDP = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (n, ok, extra) => (ok ? (pass++, console.log("  ✅ " + n + (extra ? " — " + extra : ""))) : (fail++, console.log("  ❌ " + n + (extra ? " — " + extra : ""))));

// Крошечный настоящий PNG (1×1) — им подменяем ответ провайдера.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gG8uwAAAABJRU5ErkJggg==";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

function hasXvfb() {
  return spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" }).status === 0;
}

// Провайдер: первый раунд просит нарисовать картинку, второй — просто отвечает.
function startFakeProvider(seen, rounds, rate, script) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(req.method + " " + req.url);
      // Лимит провайдера: отдаём ровно тот текст, что приходит от бесплатного пула,
      // и Retry-After — приложение должно подождать и повторить САМО.
      if (rate && rate.fail429 > 0 && /\/chat\/completions$/.test(req.url)) {
        rate.fail429--;
        rate.hits++;
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(
          JSON.stringify({
            code: "",
            message:
              "You have reached the request limit[z-ai/glm-5.3-free]: Maximum 8 requests within 1 minutes. (request id: live-test)",
            type: "api_error",
          })
        );
        return;
      }
      if (/chat\/completions$/.test(req.url)) rounds.bodies.push(body);
      const json = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (/\/chat\/completions$/.test(req.url)) {
        rounds.n++;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        // Заранее заказанный вызов инструмента: тесту нужно проверить конкретное
        // действие (подтверждение опасного инструмента, команду с секретами).
        if (script && script.call) {
          const want = script.call;
          script.call = null;
          const ev = {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_script_" + Date.now(),
                  type: "function",
                  function: { name: want.name, arguments: JSON.stringify(want.args || {}) },
                }],
              },
            }],
          };
          res.write("data: " + JSON.stringify(ev) + "\n\n");
          res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (rounds.n === 1) {
          const call = {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "generateImage", arguments: JSON.stringify({ prompt: "кот в шляпе", filename: "kot.png", aspect_ratio: "16:9" }) },
                }],
              },
            }],
          };
          res.write("data: " + JSON.stringify(call) + "\n\n");
          res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"index":0,"delta":{"content":"Готово."}}]}\n\n');
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (/\/images\/generations$/.test(req.url)) return json(200, { data: [{ b64_json: TINY_PNG, media_type: "image/png" }] });
      if (/\/images$/.test(req.url)) return json(200, { data: [{ b64_json: TINY_PNG }] });
      if (/\/models$/.test(req.url)) return json(200, { data: [{ id: "fake-model" }, { id: "fake-image" }] });
      json(404, { error: { message: "нет такого пути: " + req.url } });
    });
  });
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
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-live-"));
  const seen = [];
  const rounds = { n: 0, bodies: [] };
  const rate = { fail429: 0, hits: 0 }; // сколько раз провайдер ещё ответит лимитом
  const script = { call: null }; // заранее заданный вызов инструмента для проверок
  const srv = startFakeProvider(seen, rounds, rate, script);
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  console.log("\n[1] Фейковый провайдер: http://127.0.0.1:" + port + "/v1");

  const useXvfb = process.platform === "linux" && hasXvfb();
  const args = [
    electronExe,
    ".",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--user-data-dir=" + path.join(workDir, "userdata"),
    "--remote-debugging-port=" + CDP,
  ];
  const cmd = useXvfb ? "xvfb-run" : electronExe;
  const cmdArgs = useXvfb ? ["-a", "-s", "-screen 0 1440x900x24", ...args] : args.slice(1);
  if (process.platform === "linux" && !useXvfb) {
    console.error("✗ Нет xvfb-run — на Linux без дисплея окно не поднять: npx playwright install --with-deps chromium");
    srv.close();
    process.exit(2);
  }
  const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    // Свой OTA-корень: иначе приложение подхватит локальный ota/ и начнёт самообновляться.
    env: Object.assign({}, process.env, { AI_AGENT_OTA_ROOT: path.join(workDir, "ota"), AI_AGENT_TASK_REMINDER_MS: "3000" }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // чтобы убить всё дерево процессов, а не только обёртку xvfb-run
  });
  let elog = "";
  const pageErrs = []; // ошибки страницы: печатаем при падении
  child.stdout.on("data", (d) => (elog += d));
  child.stderr.on("data", (d) => (elog += d));
  const killApp = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {
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
    killApp();
    srv.close();
    process.exit(1);
  }

  let browser = await chromium.connectOverCDP("http://127.0.0.1:" + CDP);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => /index\.html/.test(p.url()));
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
    // Проверка свежести: если порт отладки занял старый экземпляр (прошлый прогон
    // не убил процессы), тест молча проверял бы старый код — это уже случалось.
    // Сначала ждём, пока окно поднимет ядро: на «холодном» профиле страница ещё
    // разбирает скрипты, и window.AgentCore появляется не сразу. Без этого ожидания
    // проверка давала ложное падение «к отладке подключился старый экземпляр».
    const tCore = Date.now();
    let coreUp = false;
    while (Date.now() - tCore < 15000) {
      coreUp = await page.evaluate(() => typeof window.AgentCore === "object" && window.AgentCore !== null).catch(() => false);
      if (coreUp) break;
      await sleep(250);
    }
    const fresh = coreUp && (await page.evaluate(() => typeof window.AgentCore.imageAttempts === "function"));
    check("запущен свежий код (imageAttempts на месте)", fresh, fresh ? "" : "окно не подняло ядро за 15 с (или порт занят старым экземпляром)");
    if (!fresh) throw new Error("к отладке подключился старый экземпляр приложения");

    console.log("\n[2] Настройки: вспомогательная модель смотрит на фейковый провайдер");
    const applied = await page.evaluate(async ({ p, dir }) => {
      const s = await window.api.setSettings({
        provider: "openai",
        openaiUrl: "http://127.0.0.1:" + p + "/v1",
        openaiApiKey: "fake-key",
        openaiModel: "fake-model",
        model: "fake-model",
        workingDir: dir,
        visionEnabled: true,
        visionUrl: "http://127.0.0.1:" + p + "/v1",
        visionKey: "",
        visionModel: "fake-model",
        imageModel: "fake-image",
        otaEnabled: false, // тест не должен прерываться самообновлением приложения
      });
      return { url: s && s.visionUrl, model: s && s.imageModel, dir: s && s.workingDir };
    }, { p: port, dir: workDir });
    check("настройки применились", applied.url === "http://127.0.0.1:" + port + "/v1" && applied.model === "fake-image", JSON.stringify(applied));

    // Окно держит собственную копию настроек: после записи через IPC её надо перечитать,
    // иначе роли/чипы видят старые (пустые) настройки. Перезагрузка = запуск уже
    // настроенного приложения, как в жизни.
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(900);
    const reloaded = await page.evaluate(() => typeof window.AgentCore.imageAttempts === "function");
    check("после перезагрузки окно живо и свежо", reloaded && !page.isClosed(), "closed=" + page.isClosed());
    // Один слушатель на всё: события прогона и напоминания о делах. Ставим сразу —
    // срок «через 2 минуты» попадает в окно напоминания (за 15 минут), и событие
    // может прийти раньше шага 8.
    await page.evaluate(() => {
      window.__ev = [];
      window.__rem = [];
      window.api.onAiEvent((ev) => {
        window.__ev.push(ev);
        if (ev && ev.type === "task-reminder") window.__rem.push(ev.tasks || []);
      });
    });

    console.log("\n[3] Прогон: модель просит generateImage — главный процесс выполняет инструмент");
    const events = await page.evaluate(async () => {
      try {
        await window.api.sendMessage([{ role: "user", content: "нарисуй кота в шляпе и сохрани как kot.png" }], {});
      } catch (e) {
        window.__ev.push({ type: "throw", message: String((e && e.message) || e) });
      }
      return (window.__ev || []).map((e) => JSON.stringify(e));
    });
    // События читаем ПОСЛЕ прогона и ждём нужное: sendMessage может вернуться
    // раньше, чем придёт результат инструмента. Раньше тест снимал снимок
    // сразу — и, если результат опаздывал, «инструмент не отработал» появлялось
    // на живом приложении, хотя файл уже лежал на диске.
    let blob = "";
    for (let i = 0; i < 20; i++) {
      const list = await page.evaluate(() => (window.__ev || []).map((e) => JSON.stringify(e)));
      blob = list.join(" | ");
      if (/изображение сгенерировано и сохранено/.test(blob)) break;
      await sleep(300);
    }
    if (!blob) blob = events.join(" | ");
    const okText = (blob.match(/OK — изображение[^"\\]{0,200}/) || [""])[0];
    check("инструмент отработал", /изображение сгенерировано и сохранено/.test(blob), okText);
    check("протокол определён по ответу", /провайдер: OpenAI-совместимо \(определено по ответу\)/.test(blob), (blob.match(/провайдер: [^)]+/) || [""])[0]);
    check("запрос ушёл на OpenAI-совместимый путь", seen.some((s) => /POST \/v1\/images\/generations$/.test(s)), seen.filter((s) => /images/.test(s)).join(", "));
    check("лишних попыток не было", !seen.some((s) => /POST \/v1\/images$/.test(s)), seen.filter((s) => /images/.test(s)).join(", "));

    console.log("\n[4] Файл на диске");
    const m = blob.match(/сохранено: ([^"\\]+?\.png)/);
    const file = m ? m[1] : path.join(workDir, "kot.png");
    const exists = fs.existsSync(file);
    check("файл создан", exists, file);
    if (exists) {
      const buf = fs.readFileSync(file);
      check("это настоящий PNG", buf.slice(0, 8).equals(PNG_MAGIC), buf.length + " байт");
      check("размер совпадает с ответом провайдера", buf.length === Buffer.from(TINY_PNG, "base64").length);
    }
    console.log("\n[4b] Панель «Дела»: пустое состояние и фильтры");
    const emptyPanel = await page.evaluate(async () => {
      document.getElementById("rail-tasks").click();
      await new Promise((r) => setTimeout(r, 600));
      const e = document.getElementById("tasks-empty");
      const res = {
        panel: !document.getElementById("sp-tasks").classList.contains("hidden"),
        emptyVisible: !!e && !e.classList.contains("hidden"),
        emptyIcon: !!e && !!e.querySelector(".tk-empty-ic"),
        emptyText: e ? e.textContent : "",
        chips: [...document.querySelectorAll("#tasks-filters .tk-chip")].map((c) => c.textContent),
        quick: [...document.querySelectorAll("#tasks-quick-due button")].length,
        overflow: document.getElementById("sp-tasks").scrollWidth - document.getElementById("sp-tasks").clientWidth,
        inner: [
          "tk-composer",
          "tk-filters",
          "tasks-groups",
        ].map((cls) => {
          const el = document.querySelector("#sp-tasks ." + cls);
          if (!el) return cls + ":нет";
          const r = el.getBoundingClientRect();
          const p = document.getElementById("sp-tasks").getBoundingClientRect();
          return cls + ":" + Math.round(p.right - r.right);
        }),
      };
      document.getElementById("btn-sp-close").click();
      await new Promise((r) => setTimeout(r, 200));
      return res;
    });
    check("панель «Дела» открывается из рельсы", emptyPanel.panel);
    check("пустой список объясняет, что делать", emptyPanel.emptyVisible && emptyPanel.emptyIcon && /Дел пока нет/.test(emptyPanel.emptyText), emptyPanel.emptyText.slice(0, 90));
    check("фильтры по срокам на месте", emptyPanel.chips.length === 6, emptyPanel.chips.join(" · "));
    check("быстрые сроки есть", emptyPanel.quick >= 4, "кнопок: " + emptyPanel.quick);
    check("панель не переполняется по ширине", emptyPanel.overflow <= 1, "лишних пикселей: " + emptyPanel.overflow);
    check("блоки панели влезают в свои края", emptyPanel.inner.every((x) => /:\d+$/.test(x) && Number(x.split(":")[1]) >= 0), emptyPanel.inner.join(" · "));

    console.log("\n[5] Дела: добавление, панель и счётчик на рельсе");
    const userData = path.join(workDir, "userdata");
    const taskAdd = await page.evaluate(async () => {
      const r = await window.api.tasksAdd({
        title: "Позвонить в банк",
        due: "через 2 минуты",
        priority: "high",
        project: "Личное",
      });
      return { ok: !!r.ok, message: r.message || r.error || "", id: r.task && r.task.id };
    });
    check("дело добавлено через приложение", taskAdd.ok && taskAdd.id, taskAdd.message.slice(0, 90));

    const board = await page.evaluate(async () => {
      const b = await window.api.tasksBoard();
      return {
        groups: b.groups.map((g) => g.id + ":" + g.tasks.length).join(" "),
        summary: b.summary,
      };
    });
    check("срок понят: дело в «сегодня»", /today:1/.test(board.groups) || /overdue:1/.test(board.groups), board.groups);
    check("сводка считает ближайшие", board.summary.today + board.summary.overdue >= 1, JSON.stringify(board.summary));

    const ui = await page.evaluate(async () => {
      document.getElementById("rail-tasks").click();
      await new Promise((r) => setTimeout(r, 700));
      const rowEl = document.querySelector("#tasks-groups .task-row");
      return {
        panel: !document.getElementById("sp-tasks").classList.contains("hidden"),
        rows: [...document.querySelectorAll("#tasks-groups .task-row")].map((r) => r.textContent),
        badge: document.getElementById("rail-tasks-badge").textContent,
        badgeHidden: document.getElementById("rail-tasks-badge").classList.contains("hidden"),
        counts: document.getElementById("tasks-counts").textContent,
        tagText: rowEl ? [...rowEl.querySelectorAll(".task-tag")].map((t) => t.textContent).join(", ") : "",
        hasActions: !!document.querySelector("#tasks-groups .task-row .task-actions"),
      };
    });
    check("панель дел открывается из рельсы", ui.panel);
    check("дело видно в панели", ui.rows.some((r) => r.includes("Позвонить в банк")), (ui.rows[0] || "").slice(0, 80));
    check("счётчик на рельсе показывает срок", !ui.badgeHidden && Number(ui.badge) >= 1, ui.badge + " · " + ui.counts.slice(0, 60));
    check("в строке дела видны теги", ui.tagText.includes("важное"), ui.tagText || "тегов нет");
    check("действия в строке есть (показываются по наведению)", ui.hasActions, "");

    console.log("\n[5b] Панель «Дела»: фильтр по сроку и быстрый срок");
    const filt = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // Напоминания на время проверки выключаем: просроченное дело иначе дёрнуло бы
      // тост и сломало бы проверку «напоминание приходит ровно один раз» на шаге 8.
      await window.api.setSettings({ taskReminders: false });
      // Второе дело — заведомо просроченное (час назад), чтобы фильтр было на чём проверить.
      await window.api.tasksAdd({ title: "Просроченное дело", due: new Date(Date.now() - 3600000).toISOString(), priority: "high", project: "Работа" });
      document.getElementById("btn-tasks-refresh").click();
      await wait(700);
      const chip = (id) => document.querySelector('#tasks-filters .tk-chip[data-filter="' + id + '"]');
      const chipCounts = [...document.querySelectorAll("#tasks-filters .tk-chip")].map((c) => c.textContent);
      chip("overdue").click();
      await wait(600);
      const overdueRows = [...document.querySelectorAll("#tasks-groups .task-row")].map((r) => r.textContent);
      const overdueHead = (document.querySelector("#tasks-groups .tasks-group-head") || {}).textContent;
      const activeChip = [...document.querySelectorAll("#tasks-filters .tk-chip.active")].map((c) => c.textContent);
      chip("all").click();
      await wait(600);
      const allRows = document.querySelectorAll("#tasks-groups .task-row").length;
      const tags = [...document.querySelectorAll("#tasks-groups .task-row .task-tag")].map((t) => t.textContent);
      document.getElementById("task-new-due").value = "";
      document.querySelectorAll("#tasks-quick-due button")[1].click();
      const quickFilled = document.getElementById("task-new-due").value;
      return { chipCounts, overdueRows, overdueHead, activeChip, allRows, tags, quickFilled };
    });
    check("в фильтрах видны счётчики", filt.chipCounts.some((c) => /Просрочено1/.test(c.replace(/\s+/g, ""))), filt.chipCounts.join(" · "));
    check("фильтр «Просрочено» показывает только просроченные", filt.overdueRows.length === 1 && filt.overdueRows[0].includes("Просроченное дело"), "строк: " + filt.overdueRows.length + ", заголовок: " + filt.overdueHead);
    check("активный фильтр подсвечен", filt.activeChip.length === 1 && filt.activeChip[0].includes("Просрочено"), filt.activeChip.join(""));
    check("возврат к «Все» показывает все дела", filt.allRows === 2, "строк: " + filt.allRows);
    check("видны проекты и приоритеты", filt.tags.includes("Работа") && filt.tags.includes("важное"), filt.tags.join(", "));
    check("быстрый срок подставляет срок в поле", filt.quickFilled === "сегодня вечером", "«" + filt.quickFilled + "»");
    await page.evaluate(async () => {
      const b = await window.api.tasksBoard();
      const bad = (b.groups || []).flatMap((g) => g.tasks).find((t) => t.title === "Просроченное дело");
      if (bad) await window.api.tasksDelete(bad.id);
      await window.api.setSettings({ taskReminders: true });
    });

    console.log("\n[6] Роли: попап, выбор Менеджера, чипы");
    const roles = await page.evaluate(async () => {
      document.getElementById("btn-role").click();
      await new Promise((r) => setTimeout(r, 200));
      const cards = [...document.querySelectorAll("#role-popover .role-card")];
      const titles = cards.map((c) => c.textContent.trim());
      const mgr = cards.find((c) => c.textContent.includes("Менеджер"));
      if (mgr) mgr.click();
      await new Promise((r) => setTimeout(r, 800));
      const chats = await window.api.loadChats();
      return {
        count: titles.length,
        titles,
        btn: document.getElementById("btn-role").textContent,
        chips: [...document.querySelectorAll("#role-chips .role-chip")].map((c) => c.textContent),
        saved: (chats.chats || []).some((c) => c.role === "manager"),
        rolesInChats: (chats.chats || []).map((c) => String(c.role || "—")).join(","),
        panelOpen: !document.getElementById("sp-tasks").classList.contains("hidden"),
      };
    });
    check("в панели ролей четыре роли", roles.count === 4, roles.titles.join(" / ").slice(0, 120));
    check("кнопка показывает выбранную роль", /Менеджер/.test(roles.btn), roles.btn);
    check("роль сохранилась в чате", roles.saved, "роли в чатах: " + roles.rolesInChats);
    check("появились чипы роли", roles.chips.length >= 3, roles.chips.join(" · ").slice(0, 120));
    check("у Менеджера сразу открыта панель дел", roles.panelOpen);

    console.log("\n[7] Роль доходит до модели: чип «Что у меня на сегодня?»");
    const before = rounds.bodies.length;
    await page.evaluate(async () => {
      const chip = [...document.querySelectorAll("#role-chips .role-chip")].find((c) => c.textContent.includes("сегодня"));
      if (chip) chip.click();
    });
    await sleep(4000);
    const sent = rounds.bodies.slice(before).join("\n");
    check("роль ушла в системный промпт", sent.includes("РЕЖИМ «МЕНЕДЖЕР»"), sent ? "тело запроса " + sent.length + " символов" : "запроса не было");
    check("в промпте есть сводка дел", sent.includes("МОИ ДЕЛА") && sent.includes("Позвонить в банк"), "");
    check("схемы дел переданы модели", sent.includes("taskList") && sent.includes("taskAdd"), "");

    console.log("\n[7b] Состояние окна перед напоминанием");
    check("окно живо перед проверкой напоминания", !page.isClosed() && child.exitCode === null, "closed=" + page.isClosed() + " exit=" + child.exitCode);

    console.log("\n[8] Напоминание о сроке");
    await sleep(6000);
    const rem = await page.evaluate(() => (window.__rem || []).map((list) => list.map((t) => t.title).join(", ")));
    check("пришло напоминание о деле", rem.length > 0, rem.join(" | ").slice(0, 120));
    check("напоминание не повторяется", rem.length === 1, "событий: " + rem.length);
    const tfile = path.join(userData, "tasks.json");
    let stored = null;
    try { stored = JSON.parse(fs.readFileSync(tfile, "utf8")); } catch {}
    check("дела хранятся вне проекта (userData)", !!stored, tfile);
    check("отмечено, что напомнили", !!(stored && stored.tasks[0] && stored.tasks[0].remindedAt > 0), stored ? String(stored.tasks[0].remindedAt) : "нет файла");

    console.log("\n[9] Лимит провайдера (429): прогон ждёт и продолжает сам");
    const before429 = seen.filter((s) => /chat\/completions/.test(s)).length;
    rate.fail429 = 2;
    const r429 = await page.evaluate(async () => {
      window.__ev.length = 0;
      let err = "";
      try {
        await window.api.sendMessage([{ role: "user", content: "ответь одним словом: ок" }], {});
      } catch (e) {
        err = String((e && e.message) || e);
      }
      return {
        err,
        notices: window.__ev.filter((e) => e.type === "notice").map((e) => e.text),
        errors: window.__ev.filter((e) => e.type === "error").map((e) => e.message),
      };
    });
    const after429 = seen.filter((s) => /chat\/completions/.test(s)).length;
    check("провайдер действительно ответил лимитом", rate.hits === 2, "ответов 429: " + rate.hits);
    check("прогон не упал на 429", !/429/.test(r429.err) && r429.errors.length === 0, (r429.err || r429.errors.join(" | ")).slice(0, 140));
    check("запрос повторён автоматически", after429 - before429 >= 3, "запросов за шаг: " + (after429 - before429));
    check(
      "пользователю сказали, что ждём сами",
      r429.notices.some((t) => /жду/.test(t) && /повторю сам/.test(t)),
      r429.notices.join(" | ").slice(0, 150)
    );
    console.log("\n[10] Политика инструментов: подтверждение опасного действия и отказ");
    const auditUi = await page.evaluate(async () => {
      document.getElementById("btn-settings").click();
      await new Promise((r) => setTimeout(r, 700));
      const box = document.getElementById("s-audit-log");
      const res = {
        exists: !!box,
        checked: box ? box.checked : null,
        label: box ? String((box.closest("label") || {}).textContent || "") : "",
      };
      document.getElementById("btn-close-settings").click();
      await new Promise((r) => setTimeout(r, 250));
      return res;
    });
    check("в настройках есть переключатель журнала действий", auditUi.exists, auditUi.label.trim().slice(0, 70));
    check("журнал включён по умолчанию", auditUi.checked === true, "checked=" + auditUi.checked);

    // Инструмент с высоким риском и без своей защиты: приложение обязано спросить.
    // Группа «система» включается по слову «процесс» — только тогда схема инструмента
    // уходит модели, и вызов вообще доходит до главного процесса.
    script.call = { name: "killProcess", args: { name: "some-tool-force", force: true } };
    const denyRun = page.evaluate(async () => {
      window.__ev.length = 0;
      try {
        await window.api.sendMessage([{ role: "user", content: "заверши процесс some-tool-force" }], {});
      } catch (e) {
        window.__ev.push({ type: "throw", message: String((e && e.message) || e) });
      }
      return (window.__ev || []).map((e) => JSON.stringify(e));
    });
    // Прогон асинхронный: ждём вопрос, а не фиксированные секунды.
    let asked = [];
    let seenEvents = "";
    for (let i = 0; i < 40; i++) {
      const snap = await page.evaluate(() => ({
        asks: window.__ev.filter((e) => e.type === "ask").map((e) => e.question),
        all: window.__ev.map((e) => String(e.type || "")).join(","),
      }));
      asked = snap.asks;
      seenEvents = snap.all;
      if (asked.length) break;
      await sleep(500);
    }
    check("приложение спросило про опасное действие", asked.some((q) => /потенциально опасно/.test(q)), (asked.join(" | ") || "вопроса не было; события: " + seenEvents).slice(0, 180));
    await page.evaluate(() => window.api.answerQuestion("нет"));
    const denyOut = (await denyRun).join(" | ");
    check("отказ — действие не выполнено", /НЕ выполнено/.test(denyOut), denyOut.slice(-180));

    console.log("\n[10b] Секреты агента и команда-дамп");
    await page.evaluate(async () => {
      await window.api.setSettings({ agentEnv: { LIVE_LIVE_SECRET: "live-secret-value-42" } });
    });
    script.call = { name: "runCommand", args: { command: "printenv" } };
    const dumpRun = page.evaluate(async () => {
      window.__ev.length = 0;
      try { await window.api.sendMessage([{ role: "user", content: "выведи всё окружение" }], {}); } catch (e) { window.__ev.push({ type: "throw", message: String((e && e.message) || e) }); }
      return (window.__ev || []).map((e) => JSON.stringify(e));
    });
    const dumpOut = (await dumpRun).join(" | ");
    check("дамп окружения не показывает секрет агента", !dumpOut.includes("live-secret-value-42"), "длина вывода: " + dumpOut.length);

    script.call = { name: "runCommand", args: { command: "printenv LIVE_LIVE_SECRET" } };
    const explicitRun = page.evaluate(async () => {
      window.__ev.length = 0;
      try { await window.api.sendMessage([{ role: "user", content: "покажи значение переменной LIVE_LIVE_SECRET" }], {}); } catch (e) { window.__ev.push({ type: "throw", message: String((e && e.message) || e) }); }
      return (window.__ev || []).map((e) => JSON.stringify(e));
    });
    const explicitOut = (await explicitRun).join(" | ");
    check("явный запрос переменной работает как раньше", explicitOut.includes("live-secret-value-42"), "переменная дошла до команды");

    console.log("\n[11] Журнал действий на диске");
    const auditFile = path.join(userData, "audit.log");
    let auditText = "";
    try { auditText = fs.readFileSync(auditFile, "utf8"); } catch {}
    const rows = auditText.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    });
    check("журнал создан и заполняется", rows.length > 0, auditFile + " — событий: " + rows.length);
    check("каждая строка журнала — корректный JSON", rows.every((r) => r && r.tool && r.ts && r.time && r.risk), "битых строк: " + rows.filter((r) => !r).length);
    const deniedRow = rows.find((r) => r.tool === "killProcess");
    check(
      "отказ попал в журнал с риском и capability",
      !!deniedRow && deniedRow.decision === "denied" && deniedRow.risk === "high" && deniedRow.capability === "system.process.kill",
      deniedRow ? JSON.stringify(deniedRow).slice(0, 170) : "записи нет"
    );
    check("действия средней опасности тоже в журнале", rows.some((r) => r.tool === "generateImage") && rows.some((r) => r.tool === "runCommand"), "инструменты: " + Array.from(new Set(rows.map((r) => r.tool))).join(", ").slice(0, 140));
    check("в журнале нет значения секрета агента", auditText.indexOf("live-secret-value-42") === -1, "проверено по файлу журнала");
    check("в журнале нет аргументов-секретов целиком", auditText.indexOf("agentEnv") === -1, "");
    console.log("\n[12] Миссия: повтор отчёта больше не заводит петлю");
    const missionStore = require(path.join(ROOT, "src", "mission-store.js"));
    // Рабочая папка агента та же, что у приложения: её показывает панель «Миссия».
    const mState = await page.evaluate(async () => await window.api.missionState());
    const mDir = mState.dir;
    for (const m of mState.list || []) {
      if (m.status === "active" || m.status === "paused") {
        missionStore.missionFinish(mDir, m.id, { status: "stopped", reason: "подготовка живой проверки" });
      }
    }
    const mChat = await page.evaluate(async () => (await window.api.loadChats()).activeId);
    const mNew = missionStore.missionCreate(mDir, {
      goal: "Разбор входящих писем",
      title: "Разбор входящих писем",
      steps: ["Прочитать письма", "Разложить по делам"],
      chatId: mChat,
    });
    check("миссия заведена для живой проверки", !!(mNew && mNew.ok), (mNew && mNew.error) || mDir);
    // Модель отвечает текстом и миссию не закрывает — на всех раундах одно «Готово.».
    const missionRun = await page.evaluate(async () => {
      window.__ev.length = 0;
      try { await window.api.sendMessage([{ role: "user", content: "разбери входящие" }], {}); } catch (e) { window.__ev.push({ type: "throw", message: String((e && e.message) || e) }); }
      const st = await window.api.missionState();
      return {
        notices: window.__ev.filter((e) => e.type === "notice").map((e) => String(e.text)),
        active: st.active ? st.active.id : "",
        status: st.active ? st.active.status : "",
      };
    });
    const scold = missionRun.notices.filter((t) => /не закрыта/.test(t));
    const pausedNotices = missionRun.notices.filter((t) => /на паузе/.test(t));
    check("призыв прозвучал один раз, а не трижды", scold.length === 1, "призывов: " + scold.length + " — " + scold.join(" | ").slice(0, 170));
    check("повтор того же отчёта остановил призывы", pausedNotices.length === 1 && /повторила/.test(pausedNotices[0] || ""), pausedNotices.join(" | ").slice(0, 170));
    check("миссия ждёт человека (пауза), а не крутится", missionRun.status === "paused", "состояние: " + missionRun.status + ", миссия: " + missionRun.active);
    // Главное: следующий прогон паузу НЕ подхватывает. Это и было «миссия снова дёргает».
    const afterPause = await page.evaluate(async () => {
      window.__ev.length = 0;
      try { await window.api.sendMessage([{ role: "user", content: "ответь одним словом: ок" }], {}); } catch (e) {}
      const st = await window.api.missionState();
      return { notices: window.__ev.filter((e) => e.type === "notice").map((e) => String(e.text)), status: st.active ? st.active.status : "нет", resumed: window.__ev.some((e) => e.type === "mission" && e.phase === "resume") };
    });
    check("пауза не подхватилась следующим прогоном", afterPause.notices.every((t) => !/не закрыта/.test(t)), afterPause.notices.join(" | ").slice(0, 170));
    check("прогон не «продолжил» паузу сам", afterPause.resumed === false && afterPause.status === "paused", "состояние: " + afterPause.status + ", продолжал: " + afterPause.resumed);
    // И миссия закрывается человеком/агентом как раньше: закрытая больше не всплывает.
    const closed = missionStore.missionFinish(mDir, missionRun.active, { status: "done", report: "Разобрал 10 писем." });
    check("миссию можно закрыть после паузы", !!(closed && closed.ok), (closed && closed.error) || "");
    check("закрытая миссия больше не подхватывается", !missionStore.missionActive(mDir), "в панели снова висит незакрытая миссия");

    // Удаление миссии: от кнопки в окне до папки на диске (канал mission:delete).
    const doomed = missionStore.missionCreate(mDir, { goal: "Черновик на удаление", steps: ["Шаг"], chatId: mChat });
    const doomedDir = missionStore.missionDirOf(mDir, doomed.mission.id);
    await page.evaluate(async (id) => {
      window.confirm = () => true; // подтверждение спрашивается в окне — здесь соглашаемся
      await window.api.missionDelete(id);
    }, doomed.mission.id);
    await sleep(400);
    const left = (await page.evaluate(async () => (await window.api.missionState()).list.map((m) => m.id)));
    const doomedLeft = fs.existsSync(doomedDir);
    check("миссия удалена каналом окна", !doomedLeft, doomedLeft ? "папка осталась: " + doomedDir : "папки миссии нет");
    check("удалённой миссии нет в списке панели", left.indexOf(doomed.mission.id) === -1, "миссий в панели: " + left.length);
    const badId = missionStore.missionDelete(mDir, "..");
    check("склад отказывает на мусорном идентификаторе", !badId.ok, badId.ok ? "«..» прошёл в удаление" : "отказ: " + badId.error);

    console.log("\n[13] Непустая история: окно открывается, кнопка «↓» жива, события доходят");
    // Ровно тот случай, который ломал приложение: при загрузке с непустой историей
    // перерисовка ленты падала на кнопке «↓» («Cannot read properties of null»),
    // падение обрывало запуск окна — и события агента вообще не доходили до экрана
    // (человек видел ответ только уведомлением).
    const errsBefore = pageErrs.length;
    await page.evaluate(async () => {
      const now = Date.now();
      await window.api.saveChats({ activeId: "hist", chats: [{ id: "hist", title: "История", createdAt: now, messages: [
        { id: "h1", role: "user", content: "посмотри файлы", createdAt: now },
        { id: "h2", role: "tool", toolName: "listFiles", toolArgs: { path: "." }, toolResult: "файлы", pending: false, toolOk: true, createdAt: now + 1 },
        { id: "h3", role: "assistant", content: "Посмотрел файлы, всё на месте.", createdAt: now + 2 },
      ] }] });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(1500);
    await page.waitForFunction(() => typeof window.AgentCore === "object" && window.AgentCore !== null, null, { timeout: 20000 });
    const hist = await page.evaluate(() => {
      const box = document.getElementById("messages");
      const btn = document.getElementById("btn-scroll-bottom");
      return {
        bubbles: box.querySelectorAll(".msg").length,
        text: box.textContent.replace(/\s+/g, " ").trim().slice(0, 120),
        hasBtn: !!btn,
        btnOutside: !!btn && !box.contains(btn),
      };
    });
    check("непустая история показана целиком", hist.bubbles >= 3, "пузырей " + hist.bubbles + " — " + hist.text);
    check("кнопка «↓» пережила перерисовку", hist.hasBtn && hist.btnOutside, "есть: " + hist.hasBtn + ", снаружи ленты: " + hist.btnOutside);
    check("ошибок страницы при загрузке с историей нет", pageErrs.length === errsBefore, pageErrs.slice(errsBefore).join(" | ").slice(0, 200));
    // Главное: события агента доходят до ОКНА. Отправляем через окно, как человек.
    await page.fill("#input", "ответь одним словом: ок");
    await page.click("#btn-send");
    let answered = "";
    for (let i = 0; i < 30 && !answered; i++) {
      await sleep(1000);
      answered = await page.evaluate(() => {
        const els = Array.from(document.getElementById("messages").querySelectorAll(".msg.assistant"));
        const last = els[els.length - 1];
        const t = last ? last.textContent.replace(/\s+/g, " ").trim() : "";
        return /Готово/i.test(t) ? t.slice(0, 80) : "";
      });
    }
    check("ответ агента дошёл до окна", !!answered, answered || "за 30 с в ленте не появилось ответа");
    check("ошибок страницы после прогона нет", pageErrs.length === errsBefore, pageErrs.slice(errsBefore).join(" | ").slice(0, 200));

    console.log("\n[14] Дозор запуска: поломка окна показывает себя сама");
    // Ровно то, из-за чего человек видел «в чате пусто»: падение при загрузке уходило
    // в консоль, которой в собранном приложении никто не видит. Теперь окно само
    // называет причину, файл, строку и версию исполняемого кода — и этот разбор
    // можно скопировать одной кнопкой.
    const guard = await page.evaluate(() => ({
      есть: typeof window.BootGuard === "object" && window.BootGuard !== null,
      // Подписку ставит сам модуль при загрузке: ждать инициализацию окна не нужно.
      подписался: window.__bootGuardInstalled === true,
      разбор: typeof window.bootReport === "function" ? window.bootReport() : "",
      плашка: !!document.getElementById("boot-banner"),
    }));
    check("дозор запуска стоит в окне", guard.есть, "");
    check("дозор подписался сам при загрузке", guard.подписался, "");
    check("на здоровом окне дозор молчит", !guard.плашка && /поломок не записано/.test(guard.разбор), guard.разбор.slice(0, 120));
    // 1. Файл не доехал (неполный набор обновления) — человек должен увидеть ИМЯ файла.
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.src = "net-takogo-fajla-iz-nabora.js";
      document.body.appendChild(s);
    });
    await sleep(600);
    const byFile = await page.evaluate(() => {
      const b = document.getElementById("boot-banner");
      return { плашка: !!b, текст: b ? b.textContent.replace(/\s+/g, " ").trim() : "" };
    });
    check("пропавший файл назван в окне", byFile.плашка && /net-takogo-fajla-iz-nabora\.js/.test(byFile.текст), byFile.текст.slice(0, 170));
    // 2. Падение при загрузке: причина, место и версия кода.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("живая проверка дозора: лента чата сломана");
      }, 0);
    });
    await sleep(600);
    const byCrash = await page.evaluate(() => {
      const b = document.getElementById("boot-banner");
      return {
        текст: b ? b.textContent.replace(/\s+/g, " ").trim() : "",
        разбор: typeof window.bootReport === "function" ? window.bootReport() : "",
      };
    });
    check("падение показано человеку словами", /лента чата сломана/.test(byCrash.текст), byCrash.текст.slice(0, 170));
    check("в плашке есть место падения", /Где:/.test(byCrash.текст), byCrash.текст.slice(0, 200));
    check("в плашке есть версия кода", /Версия кода:/.test(byCrash.текст), byCrash.текст.slice(0, 200));
    check("разбор отдаётся целиком для пересылки", /лента чата сломана/.test(byCrash.разбор), byCrash.разбор.slice(0, 170));
    // 3. «Закрыть» убирает плашку — и она не возвращается на следующую поломку:
    //    человек уже прочитал причину, мешать ему нечем.
    const closedBanner = await page.evaluate(async () => {
      const b = document.getElementById("boot-banner");
      const btns = Array.from(b.querySelectorAll("button"));
      const close = btns.filter((x) => /Закрыть/.test(x.textContent))[0];
      close.click();
      await new Promise((r) => setTimeout(r, 100));
      setTimeout(() => {
        throw new Error("после закрытия дозор не должен мешать");
      }, 0);
      await new Promise((r) => setTimeout(r, 300));
      return { есть: !!document.getElementById("boot-banner"), кнопки: btns.map((x) => x.textContent) };
    });
    check("плашку можно закрыть", !closedBanner.есть, "кнопки: " + closedBanner.кнопки.join(" / "));


    console.log("\n[15] Обновления: панель говорит, какой код работает");
    // Человек сверяет с репозиторием ВЕРСИЮ КОДА. Раньше панель показывала номер набора,
    // и это выглядело как «код старый» даже после обновления папки проекта.
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const otaStatus = await page.evaluate(async () => await window.api.otaStatus());
    check(
      "статус обновлений отдаёт версию кода отдельно от номера набора",
      otaStatus.codeVersion === pkgVersion && typeof otaStatus.bundle === "string",
      JSON.stringify({ codeVersion: otaStatus.codeVersion, bundle: otaStatus.bundle, appVersion: otaStatus.appVersion })
    );
    check(
      "статус обновлений перечисляет найденные папки-источники",
      Array.isArray(otaStatus.sourceList),
      "источников: " + ((otaStatus.sourceList || []).length)
    );
    const panelText = await page.evaluate(async () => {
      document.getElementById("btn-settings").click();
      await new Promise((r) => setTimeout(r, 500));
      const el = document.getElementById("ota-status");
      return el ? el.textContent : "";
    });
    check(
      "панель называет версию кода (а не номер набора)",
      panelText.indexOf("Версия кода: " + pkgVersion) !== -1,
      panelText.slice(0, 220)
    );
    check(
      "панель объясняет, откуда берётся обновление",
      /Источников|Источников обновлений нет/.test(panelText) && /Доступно:|Ничего новее/.test(panelText),
      panelText.slice(0, 220)
    );
    await page.evaluate(async () => {
      const close = document.getElementById("btn-close-settings");
      if (close) close.click();
      await new Promise((r) => setTimeout(r, 200));
    });
    console.log("\n[16] Панель настроек: вкладка, пресет и сохранение живут своим модулем");
    // Этап 3.8, часть 3: вся панель настроек уехала в settings-panel.js. Проверяем её
    // в НАСТОЯЩЕМ окне и через форму, как человек: открыть, переключить вкладку, выбрать
    // пресет, вписать значения, сохранить, открыть снова — и посмотреть файл на диске.
    const panel = await page.evaluate(async () => {
      const $ = (id) => document.getElementById(id);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      $("btn-settings").click();
      await wait(400);
      const navMemory = document.querySelector('.stab[data-tab="memory"]');
      const bodyMemory = document.querySelector('.settings-tab-body[data-tab-body="memory"]');
      const bodyModel = document.querySelector('.settings-tab-body[data-tab-body="model"]');
      navMemory.click();
      await wait(250);
      const switched = {
        active: navMemory.classList.contains("active"),
        bodyVisible: !!bodyMemory && !bodyMemory.classList.contains("hidden"),
        modelHidden: !!bodyModel && bodyModel.classList.contains("hidden"),
      };
      // Пресет: клик по чипу подставляет адрес и модель в поля — это работа панели.
      const chip = document.querySelector('.chip[data-preset="deepseek"]');
      chip.click();
      await wait(250);
      const preset = {
        url: $("s-openai-url").value,
        model: $("s-openai-model").value,
        chipActive: chip.classList.contains("active"),
      };
      // Правки в полях + «Сохранить настройки»: форма обязана собрать их в настройки.
      $("s-openai-url").value = "https://live-panel.example/v1";
      $("s-openai-model").value = "живая-модель-панели";
      $("btn-save-settings").click();
      await wait(800);
      // Открываем снова: вкладка помнится, поля показывают сохранённое.
      $("btn-settings").click();
      await wait(500);
      return {
        switched,
        preset,

        remembered: document.querySelector('.stab[data-tab="memory"]').classList.contains("active"),
        urlBack: $("s-openai-url").value,
        modelBack: $("s-openai-model").value,
        memStatus: ($("memory-status") || {}).textContent || "",
        toast: Array.from(document.body.children)
          .map((e) => e.textContent || "")
          .filter((x) => /Настройки сохранены/.test(x))[0] || "",
      };
    });
    check(
      "панель настроек: вкладка переключается и прячет чужое тело",
      panel.switched.active && panel.switched.bodyVisible && panel.switched.modelHidden,
      JSON.stringify(panel.switched)
    );
    check(
      "пресет подставляет адрес и модель в поля",
      panel.preset.chipActive && /deepseek\.com/.test(panel.preset.url) && panel.preset.model.length > 0,
      JSON.stringify(panel.preset)
    );
    check(
      "сохранение прочитало модель из поля и вернуло её при открытии",
      panel.modelBack === "живая-модель-панели",
      "в поле: " + panel.modelBack
    );
    check("повторное открытие вернулось на запомненную вкладку", panel.remembered, "вкладка «Память» активна: " + panel.remembered);
    check("человек увидел подтверждение сохранения", /Настройки сохранены/.test(panel.toast), panel.toast || "подтверждения не было");
    check("вкладка «Память» получила текст от панели", panel.memStatus.length > 0, panel.memStatus.slice(0, 110));
    // Диск: приложение должно было записать правку в свой settings.json.
    const settingsFile = path.join(userData, "settings.json");
    const settingsOnDisk = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
    check(
      "правка поля доехала до файла настроек",
      settingsOnDisk.openaiUrl === "https://live-panel.example/v1",
      "в файле: " + (settingsOnDisk.openaiUrl || "нет")
    );

    console.log("\n[17] Панель проекта: дерево, вкладки и правка файла живут своим модулем");
    // Этап 7: панель проекта уехала в project-panel.js. Структурные наборы такую поломку
    // не видят (проводка есть, а окно её не выполнило) — проверяем в НАСТОЯЩЕМ окне:
    // файл на диске, дерево, вкладки, открытие файла, правка и сохранение.
    const livePanelFile = path.join(workDir, "live-panel.txt");
    fs.writeFileSync(livePanelFile, "первый вариант\n");
    fs.mkdirSync(path.join(workDir, "live-folder"), { recursive: true });
    const livePanel = await page.evaluate(async () => {
      const $ = (id) => document.getElementById(id);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const tab = (name) => Array.from(document.querySelectorAll(".panel-tab")).filter((b) => b.dataset.tab === name)[0];
      const rows = () => Array.from(document.querySelectorAll("#tree .tree-row"));
      const nameOf = (r) => ((r.querySelector(".tree-name") || {}).textContent || "");
      if ($("project-panel").classList.contains("hidden")) $("btn-toggle-panel").click();
      await wait(400);
      const open = !$("project-panel").classList.contains("hidden");

      tab("changes").click();
      await wait(500);
      const changesTab = {
        files: $("panel-files").classList.contains("hidden"),
        changes: $("panel-changes").classList.contains("hidden"),
        summary: ($("changes-summary") || {}).textContent || "",
      };
      tab("commits").click();
      await wait(600);
      const commitsTab = {
        commits: $("panel-commits").classList.contains("hidden"),
        text: ($("commit-summary") || {}).textContent || "",
      };
      tab("files").click();
      await wait(700);
      let names = rows().map(nameOf);
      let row = rows().filter((r) => nameOf(r) === "live-panel.txt")[0];
      if (!row) {
        $("btn-panel-refresh").click();
        await wait(700);
        names = rows().map(nameOf);
        row = rows().filter((r) => nameOf(r) === "live-panel.txt")[0];
      }
      if (row) row.click();
      await wait(800);
      const opened = {
        overlay: !$("file-overlay").classList.contains("hidden"),
        path: $("file-path").textContent,
        body: ($("file-content") || {}).textContent || "",
        canEdit: !$("btn-file-edit").classList.contains("hidden"),
        tabs: Array.from(document.querySelectorAll("#file-tabs > *")).map((t) => t.textContent),
      };
      // Правка: панель обязана открыть редактор и сохранить текст на диск.
      $("btn-file-edit").click();
      await wait(500);
      const editor = $("file-editor");
      if (editor) {
        editor.value = "второй вариант — правка из окна\n";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const saveVisible = !$("btn-file-save").classList.contains("hidden");
      if (saveVisible) $("btn-file-save").click();
      await wait(800);
      const afterSave = { editorWas: !!editor, saveVisible: saveVisible, toolbar: ($("file-path") || {}).textContent || "" };
      $("btn-file-close").click();
      await wait(300);
      return {
        open: open, names: names, changesTab: changesTab, commitsTab: commitsTab,
        opened: opened, afterSave: afterSave,
        closed: $("file-overlay").classList.contains("hidden"),
      };
    });
    check("панель проекта открывается и показывает дерево рабочей папки", livePanel.open && livePanel.names.includes("live-panel.txt"), "в дереве: " + livePanel.names.join(", "));
    check(
      "вкладки панели переключают тела (изменения и коммиты)",
      livePanel.changesTab.files && !livePanel.changesTab.changes && !livePanel.commitsTab.commits,
      JSON.stringify({ changes: livePanel.changesTab, commits: livePanel.commitsTab })
    );
    check(
      "файл открывается в окне своим путём и содержимым",
      livePanel.opened.overlay && /live-panel\.txt$/.test(livePanel.opened.path) && /первый вариант/.test(livePanel.opened.body) && livePanel.opened.canEdit,
      JSON.stringify({ path: livePanel.opened.path, body: livePanel.opened.body.slice(0, 40), edit: livePanel.opened.canEdit })
    );
    check("вкладка открытого файла показывает имя", livePanel.opened.tabs.some((t) => /live-panel\.txt/.test(t)), livePanel.opened.tabs.join(" / "));
    check("кнопка правки открывает редактор файла", livePanel.afterSave.editorWas && livePanel.afterSave.saveVisible, JSON.stringify(livePanel.afterSave));
    const savedOnDisk = fs.existsSync(livePanelFile) ? fs.readFileSync(livePanelFile, "utf8") : "";
    check("правка из окна доехала до файла на диске", /второй вариант/.test(savedOnDisk), JSON.stringify(savedOnDisk.slice(0, 60)));
    check("окно просмотра файла закрывается", livePanel.closed, "overlay hidden: " + livePanel.closed);
  } catch (e) {
    check("сквозной прогон без исключений", false, e.message);
  } finally {
    await browser.close().catch(() => {});
    killApp();
    srv.close();
  }

  if (fail) {
    console.log("\n── Диагностика ──");
    console.log("ошибки страницы: " + (pageErrs.length ? pageErrs.slice(0, 6).join(" | ") : "нет"));
    console.log("лог приложения: " + elog.slice(-1500));
  }

  console.log("\n=== ЖИВОЙ ТЕСТ ДЕСКТОПА: " + pass + " ✅ / " + fail + " ❌ ===");
  process.exit(fail ? 1 : 0);
})();

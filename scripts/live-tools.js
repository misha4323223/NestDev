"use strict";
/* ─── Живой прогон роутера инструментов (main.js без окна Electron) ───────────
   Запуск: bun run test:live:tools   (node scripts/live-tools.js)

   Зачем. С этапа B, части 15 роутер инструментов (какие схемы уходят в запрос,
   какие справочники едут с ними) живёт в src/run-tools.js, а ядро чата runAi
   зовёт его. Модульный набор водит модуль напрямую; здесь проверяется ПРОВОДКА
   и поведение НАСТОЯЩЕГО прогона: main.js грузится в Node с поддельным electron,
   канал ai:send запускает runAi, а провайдера изображает локальный HTTP-сервер с
   SSE-потоком. Тела запросов сохраняются — по ним и видно, что реально ушло.

   Что проверяется по-настоящему:
     • диета: в запрос уходит база + группы задачи, а не все 159 схем;
     • предохранитель A: модель позвала инструмент вне набора — его группа
       доехала до СЛЕДУЮЩЕГО запроса, и человеку сказано, что включено;
     • мост findTools: группа, включённая инструментом, тоже доезжает;
     • набор схем только растёт и в каноническом порядке — иначе ломается кэш
       префикса промпта и провайдер отвечает 503 cache_only_cold;
     • справочник группы подключается сам, ровно один раз, настоящим текстом из
       src/agent-guides и стоит сразу после системного промпта;
     • План-режим отправляет ровно todoWrite.

   Негативные контроли: --break=<имя> ломает одну проводку, и прогон обязан упасть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-tools-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tools-work-"));
const BREAK = (() => {
  const a = process.argv.find((s) => s.startsWith("--break="));
  return a ? a.slice("--break=".length) : "";
})();

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Негативный контроль ломает ОДНУ проводку до загрузки main.js и обязан провалить
   прогон. Файл восстанавливается байт в байт. */
const BREAKS = {
  safeguard: ["src/main.js", "    tools.ensureGroupsFor(calls);\n", ""],
  router: ["src/main.js", "  activeToolRouter = tools.router;\n", "  activeToolRouter = null;\n"],
  sticky: ["src/run-tools.js", "sticky: [...state.sticky]", "sticky: []"],
  guides: ["src/run-tools.js", "        state.injected.add(gname);\n", "        void gname;\n"],
  plan: ["src/run-tools.js", "      state.active = PLAN_MODE_TOOL_DEFINITIONS;\n", "      state.active = [];\n"],
};
let brokenFile = null;
if (BREAK) {
  const spec = BREAKS[BREAK];
  if (!spec) {
    console.error("✗ Неизвестный контроль: " + BREAK + ". Есть: " + Object.keys(BREAKS).join(", "));
    process.exit(2);
  }
  brokenFile = path.join(ROOT, spec[0]);
  const src = fs.readFileSync(brokenFile, "utf8");
  if (src.split(spec[1]).length - 1 !== 1) {
    console.error("✗ Якорь контроля не найден в " + spec[0] + ": " + JSON.stringify(spec[1]));
    process.exit(2);
  }
  const before = crypto.createHash("sha256").update(src).digest("hex");
  fs.writeFileSync(brokenFile, src.replace(spec[1], spec[2]));
  process.on("exit", () => {
    try {
      fs.writeFileSync(brokenFile, src);
      const back = crypto.createHash("sha256").update(fs.readFileSync(brokenFile, "utf8")).digest("hex");
      console.log(back === before ? "  ✓ " + spec[0] + " восстановлен байт в байт" : "  ✗ " + spec[0] + " НЕ восстановлен!");
    } catch (e) {
      console.error("  ✗ Файл не восстановлен: " + e.message);
    }
  });
}

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const events = [];
function FakeWindow() {
  this.webContents = { send: (ch, ev) => events.push({ ch: ch, ev: ev }), setWindowOpenHandler: () => {}, on: () => {}, id: 1 };
  this.on = () => {};
  this.isDestroyed = () => false;
  this.isFocused = () => true;
  this.loadFile = () => {};
  this.setTitle = () => {};
}

// ── Подменённый провайдер: SSE-поток, тела запросов сохраняем ───────────────
const requests = []; // { tools, messages, at }
let served = 0;
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const call = (index, id, name, args) => ({ index: index, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } });

/* Сценарий прогона — по раундам:
   1) инструмент ЧУЖОЙ группы (mail): его схемы в наборе не было —
      срабатывает предохранитель A;
   2) findTools: мост включает группу браузера, с ней должен приехать справочник;
   3) финальный текст — прогон заканчивается сам;
   4) План-режим: план закрывается штатно через todoWrite;
   5) финальный текст План-режима. */
const SCRIPT = [
  { text: "Раунд 1: пишу письмо.\n", call: { name: "mailSend", args: { to: "agent@example.com", subject: "проверка", text: "текст письма" } } },
  { text: "Раунд 2: ищу инструменты.\n", call: { name: "findTools", args: { query: "открыть страницу в браузере и снять скриншот" } } },
  { text: "Проверка закончена." },
  { call: { name: "todoWrite", args: { title: "Проверка", tasks: [{ text: "посмотреть файлы", status: "in_progress" }, { text: "сделать правку", status: "pending" }] } } },
  { text: "План: 1) посмотреть файлы, 2) сделать правку." },
];

function answerFor(n) {
  const step = SCRIPT[n - 1] || { text: "Ход " + n + ": продолжаю." };
  const chunks = [];
  if (step.text) chunks.push({ choices: [{ index: 0, delta: { role: "assistant", content: step.text } }] });
  if (step.call) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [call(0, "call_" + n, step.call.name, step.call.args)] } }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 40 } });
  return sse(chunks);
}

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model", context_length: 128000 }] }));
    }
    if (u.pathname.endsWith("/chat/completions")) {
      let parsed = null;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      requests.push({ tools: (parsed && parsed.tools) || [], messages: (parsed && parsed.messages) || [] });
      served++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(answerFor(served));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
  });
});

// ── main.js с поддельным electron: подменяем только то, чего в Node нет ────
const handlers = new Map();
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.165",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: FakeWindow,
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
      Notification: function () { this.show = () => {}; },
    };
  }
  return origin.apply(this, arguments);
};

process.on("unhandledRejection", () => {});

const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  return Promise.resolve(fn({ sender: { id: 1 } }, ...args));
};

const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const ALL_TOOLS = core.routeTools({ forceAll: true }).tools.length;
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "run-tools.js"), "utf8");

(async () => {
  console.log("Живой прогон роутера инструментов (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 120 с — это уже поломка.");
    process.exit(1);
  }, 120000);
  guard.unref?.();

  let providerBase = "";
  try {
    await new Promise((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    });
    providerBase = "http://127.0.0.1:" + provider.address().port + "/v1";
  } catch (e) {
    console.error("✗ Не удалось поднять подменённый провайдер: " + e.message);
    process.exit(2);
  }
  require(path.join(ROOT, "src", "main.js"));
  await sleep(400);

  console.log("\n[1] Настройки: подменённый провайдер, временная рабочая папка");
  const saved = await callIpc("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));

  console.log("\n[2] Прогон 1: тихая задача, модель зовёт инструмент вне набора схем");
  // Задача намеренно «тихая»: ключевых слов нет, поэтому группа письма не могла
  // попасть в набор по тексту — только предохранителем A по факту вызова.
  const run1 = await callIpc("ai:send", [{ role: "user", content: "Сделай проверку" }], { chatId: "chat-live-tools", role: "developer" });
  ok(run1 && run1.ok === true, "прогон 1 завершился без ошибки: " + JSON.stringify(run1 && run1.error));
  ok(served === 3, "провайдер отдал ровно 3 ответа чата: " + served);
  const r1 = requests[0];
  const r2 = requests[1];
  const r3 = requests[2];
  ok(!!r1 && !!r2 && !!r3, "тела всех трёх запросов сохранены");

  const names = (req) => (req.tools || []).map((t) => t.function && t.function.name);
  console.log("\n[3] Диета: уходит база + группы задачи, а не все " + ALL_TOOLS + " схем");
  ok(r1.tools.length < ALL_TOOLS, "в первый запрос ушло " + r1.tools.length + " схем из " + ALL_TOOLS + " — диета работает");
  ok(r1.tools.length > 20, "база в запросе осталась: " + r1.tools.length + " схем");
  ok(names(r1).includes("readFile") && names(r1).includes("runCommand"), "в наборе есть база: readFile и runCommand");
  ok(!names(r1).includes("ycDeploy") && !names(r1).includes("mailSend"), "чужих групп в наборе нет: ни cloud, ни mail");

  console.log("\n[4] Предохранитель A: вызов вне набора дотянул свою группу до следующего запроса");
  ok(!names(r1).includes("mailSend"), "до вызова схемы письма в наборе не было");
  ok(names(r2).includes("mailSend"), "после вызова схема письма доехала до следующего запроса (схем стало " + r2.tools.length + ")");
  const consoleText = () => events.filter((e) => e.ch === "term:event" && e.ev && e.ev.type === "metrics").map((e) => e.ev.text).join("\n");
  ok(/вне набора схем — включаю группу «mail»/.test(consoleText()), "в «Консоль» сказано, какая группа включена на ходу");
  ok(/mailSend/.test(JSON.stringify(events)), "вызов mailSend выполнился (политика писем его честно запретила)");

  console.log("\n[5] Мост findTools: группа, включённая инструментом, тоже доехала");
  ok(names(r3).includes("browserOpen"), "группа браузера доехала до запроса после findTools (схем " + r3.tools.length + ")");
  ok(!names(r1).includes("browserOpen"), "до findTools группы браузера в наборе не было");

  console.log("\n[6] Кэш префикса: набор схем только растёт и идёт в каноническом порядке");
  const growth = [r1, r2, r3].map((req) => names(req));
  for (let i = 1; i < growth.length; i++) {
    const prev = growth[i - 1];
    const cur = growth[i];
    const lost = prev.filter((n) => cur.indexOf(n) < 0);
    ok(lost.length === 0, "в запросе " + (i + 1) + " все схемы прошлого запроса на месте");
    const kept = prev.filter((n) => cur.indexOf(n) >= 0);
    ok(
      JSON.stringify(cur.filter((n) => kept.indexOf(n) >= 0)) === JSON.stringify(kept),
      "порядок схем в запросе " + (i + 1) + " канонический — кэш префикса не промахнётся"
    );
  }

  console.log("\n[7] Справочник группы: подключается сам, один раз и настоящим текстом");
  // Ведущие system-сообщения отправляются ОДНИМ сообщением (склейка в
  // provider-transport: у облака иначе несколько системных — лишний шум и сдвиг
  // кэша), поэтому справочник ищем в тексте системного префикса, а не отдельным
  // элементом массива. Это и есть стабильный префикс промпта.
  const systemText = (req) => (req.messages || []).filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
  const guideHits = (req) => {
    const text = systemText(req);
    return text.split("СПРАВОЧНИК АГЕНТА").length - 1;
  };
  ok(guideHits(r1) === 0, "в первом запросе справочника нет — группы ещё не было");
  ok(guideHits(r3) === 1, "в третьем запросе справочник ровно один: " + guideHits(r3));
  ok(/СПРАВОЧНИК АГЕНТА: "browser"/.test(systemText(r3)), "подключён справочник группы browser");
  const realBrowser = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "browser.md"), "utf8");
  ok(systemText(r3).includes(realBrowser.trim().slice(0, 60)), "текст справочника — настоящий, из src/agent-guides/browser.md");
  ok(systemText(r3).indexOf(realBrowser.trim().slice(0, 60)) > systemText(r3).indexOf("Ассистент"), "справочник лежит в системном префиксе, впереди истории — кэш не сдвинется");
  ok(r3.messages.filter((m) => m.role === "system").length === 1, "системное сообщение в запросе одно: " + r3.messages.filter((m) => m.role === "system").length);
  ok(/Подключён справочник «browser»/.test(consoleText()), "в «Консоль» сказано про подключённый справочник");

  console.log("\n[8] Конец прогона 1: ответ дошёл, ошибок нет");
  const evOf = (t) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === t);
  const text = evOf("chunk").map((e) => e.ev.text).join("");
  ok(/Проверка закончена/.test(text), "итоговый текст дошёл до чата");
  ok(evOf("done").length === 1, "«готово» пришло один раз");
  ok(evOf("error").length === 0, "ошибок в чат не пришло: " + JSON.stringify(evOf("error").map((e) => e.ev.message)));
  ok(global.__agentRunning === false, "признак прогона снят");

  console.log("\n[9] План-режим: в запрос уходит ровно todoWrite");
  const beforePlan = requests.length;
  const planRun = await callIpc("ai:send", [{ role: "user", content: "Спланируй проверку" }], { chatId: "chat-plan-tools", role: "developer", plan: true });
  ok(planRun && planRun.ok === true, "прогон План-режима завершился без ошибки: " + JSON.stringify(planRun && planRun.error));
  const planRequests = requests.slice(beforePlan);
  ok(planRequests.length >= 1, "запросов в План-режиме: " + planRequests.length);
  const badPlan = planRequests.filter((req) => req.tools.length !== 1 || (req.tools[0].function && req.tools[0].function.name) !== "todoWrite");
  ok(badPlan.length === 0, "в каждом запросе План-режима ровно один инструмент — todoWrite");
  const planText = evOf("chunk").map((e) => e.ev.text).join("");
  ok(/посмотреть файлы/.test(planText), "план из todoWrite дошёл до панели");

  console.log("\n[10] План-режим без справочников, и ничего не осталось висеть");
  ok(planRequests.every((req) => guideHits(req) === 0), "в План-режим справочники не приезжают");
  ok(global.__agentRunning === false, "признак прогона снят после План-режима");
  ok(global.__agentStopRequested === false && global.__agentPauseRequested === false, "флаги остановки сняты");
  ok(
    /createRunTools/.test(MODULE_SRC) && /tools\.ensureGroupsFor/.test(fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8")),
    "модуль роутера и предохранитель A подключены в оболочке"
  );

  try {
    provider.close();
  } catch {}
  console.log("\nИтог: " + (failures ? failures + " проверок упало" : "все проверки прошли") + " (запросов чата: " + served + ")");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("✗ Прогон упал: " + ((e && e.stack) || e));
  try { provider.close(); } catch {}
  process.exit(1);
});

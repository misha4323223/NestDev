"use strict";
/* ─── Живой прогон каналов моделей и G4F (src/model-ipc.js) ───────────────────
   Запуск: bun run test:live:model     (node scripts/live-model-ipc.js)

   Зачем отдельный прогон. Обычный набор (test/model-ipc.test.js) проверяет каналы
   на подставном fetch: он ловит логику, но не то, что ходит ПО СЕТИ и что реальные
   помощники ядра получают те же числа, что и чат. Здесь сети-заглушек нет:

     [1] g4f:probe и g4f:test — против НАСТОЯЩИХ HTTP-серверов на 127.0.0.1
         (живой «g4f», мёртвый порт, подсказка про живой инстанс на 1337).
     [2] ai:probeLocal — против настоящего сервера, говорящего протоколом Ollama,
         с НАСТОЯЩИМИ помощниками ядра (modelWindow, contextBudget, windowBudget,
         ollamaNumCtx, probeLocalModel). Проверяется главное: канал замера просит у
         модели РОВНО тот размер контекста, с которым работает чат. Иначе замер сам
         заставил бы Ollama перезагрузить модель перед следующим ответом.
     [3] ai:models — наложение настроек из окна на сохранённые (сеть отдаёт список
         моделей в main.js, он остался там: это разбор настроек, а не каналы моделей).

   Рабочее дерево не трогается, ничего не пишется на диск. */

const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const { registerModelIpc } = require(path.join(ROOT, "src", "model-ipc.js"));
const netGuard = require(path.join(ROOT, "src", "net-guard.js")); // проверка адреса перед запросом

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

/* Модуль собирается как в main.js. Настоящие помощники ядра берём из agent-core.js;
   подставными остаются только точки, которых в Node нет или которые живут в main.js:
   настройки (loadSettings) и разбор настроек с получением списка моделей. */
function build(saved, models) {
  const handlers = new Map();
  const seen = { normalized: null, modelsAsked: null };
  registerModelIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    netGuard,
    loadSettings: () => saved,
    normalizeSettings: (s) => {
      seen.normalized = s;
      return Object.assign({ provider: "ollama", model: "" }, s);
    },
    fetchModels: async (s) => {
      seen.modelsAsked = s;
      return models || ["qwen3:8b", "llama3:8b"];
    },
    SYSTEM_PROMPT: core.SYSTEM_PROMPT,
    ROUTER_MAX_TOKENS: core.ROUTER_MAX_TOKENS,
    estimateTokens: core.estimateTokens,
    contextBudget: core.contextBudget,
    windowBudget: core.windowBudget,
    modelWindow: core.modelWindow,
    ollamaNumCtx: core.ollamaNumCtx,
    isLocalEndpoint: core.isLocalEndpoint,
    probeLocalModel: core.probeLocalModel,
  });
  return { handlers, seen };
}

const listen = (srv, port) => new Promise((res, rej) => {
  srv.once("error", rej);
  srv.listen(port, "127.0.0.1", () => res(srv.address().port));
});

// ── 1. G4F по-настоящему: живой инстанс, мёртвый порт, подсказка ─────────────
async function liveG4f() {
  console.log("\n[1] G4F: настоящий HTTP-сервер вместо инстанса g4f");
  const asked = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(req.method + " " + req.url);
      const json = (o, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/v1/models") return json({ data: [{ id: "gpt-4o-mini" }, { id: "llama-3.1-8b" }] });
      if (req.url === "/v1/chat/completions") {
        const sent = JSON.parse(body || "{}");
        asked.push("provider=" + sent.provider);
        return json({ choices: [{ message: { content: "понг" } }] });
      }
      json({}, 404);
    });
  });
  const port = await listen(srv, 0);
  const base = "http://127.0.0.1:" + port + "/v1";
  const { handlers } = build({ provider: "openai" });
  try {
    const probe = await handlers.get("g4f:probe")(null, { url: base });
    ok(probe.ok === true, "g4f:probe нашёл живой инстанс" + (probe.ok ? "" : ": " + JSON.stringify(probe)));
    ok(probe.base === base, "адрес найденного инстанса: " + probe.base);
    ok(probe.count === 2, "число моделей из живого ответа: " + probe.count);

    const t = await handlers.get("g4f:test")(null, { url: base, provider: "HuggingChat", model: "gpt-4o-mini" });
    const text = (t.log || []).map((e) => e.text).join("\n");
    ok(t.ok === true, "g4f:test прошёл по сети");
    ok(/Моделей отдаёт: 2/.test(text), "в логе списка моделей: " + /Моделей отдаёт: 2/.test(text));
    ok(/понг/.test(text), "в логе ответ провайдера");
    ok(asked.indexOf("POST /v1/chat/completions") >= 0, "чат-запрос ушёл на сервер: " + asked.join(", "));
    ok(asked.indexOf("provider=HuggingChat") >= 0, "провайдер ушёл отдельным полем запроса");
    ok(t.log[t.log.length - 1].level === "info", "лог заканчивается итогом");

    const dead = await handlers.get("g4f:probe")(null, { url: "http://127.0.0.1:9/v1" });
    ok(dead.ok === false, "мёртвый порт честно не найден: " + JSON.stringify(dead));
  } finally {
    srv.close();
  }

  // Подсказка «живой g4f на другом порту»: мёртвый указанный + живой на 1337.
  let srv1337 = null;
  try {
    srv1337 = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "x" }] } : {}));
    });
    await listen(srv1337, 1337);
  } catch (e) {
    srv1337 = null;
    console.log("  ⚠️  порт 1337 занят — подсказку про живой порт проверить не удалось (" + (e && e.code) + ")");
  }
  if (srv1337) {
    try {
      const { handlers } = build({ provider: "g4f" });
      const r = await handlers.get("g4f:test")(null, { url: "http://127.0.0.1:9/v1", provider: "A", model: "m" });
      const text = (r.log || []).map((e) => e.text).join("\n");
      ok(/Живой g4f найден на/.test(text), "подсказка о живом порту появилась");
      ok(/Поправь URL/.test(text), "подсказка говорит, что делать");
    } finally {
      srv1337.close();
    }
  }
}

// ── 2. Замер локальной модели: настоящий сервер + настоящие помощники ядра ──
async function liveProbe() {
  console.log("\n[2] ai:probeLocal: настоящий сервер вместо Ollama");
  const asked = [];
  let sawNumCtx = null;
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(req.url);
      const json = (o) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (req.url === "/api/tags") return json({ models: [{ name: "qwen3:8b" }] });
      if (req.url === "/api/chat") {
        try {
          const sent = JSON.parse(body || "{}");
          if (sent.options && sent.options.num_ctx) sawNumCtx = sent.options.num_ctx;
        } catch {}
        return json({
          message: { content: "готов" },
          total_duration: 30e9,
          load_duration: 0,
          prompt_eval_count: 600,
          prompt_eval_duration: 20e9,
          eval_count: 24,
          eval_duration: 4e9,
        });
      }
      if (req.url === "/api/ps") return json({ models: [{ name: "qwen3:8b", size: 5368709120, size_vram: 4294967296 }] });
      if (req.url === "/api/show") {
        return json({
          capabilities: ["completion", "tools"],
          model_info: {
            "general.architecture": "qwen3",
            "qwen3.context_length": 40960,
            "qwen3.block_count": 36,
            "qwen3.attention.head_count": 32,
            "qwen3.attention.head_count_kv": 8,
            "qwen3.embedding_length": 4096,
          },
        });
      }
      json({});
    });
  });
  const port = await listen(srv, 0);
  const base = "http://127.0.0.1:" + port;
  const saved = { provider: "ollama", ollamaUrl: base, model: "qwen3:8b" };
  const { handlers } = build(saved);
  try {
    const r = await handlers.get("ai:probeLocal")(null, {});
    ok(r.ok === true, "замер прошёл по сети" + (r.ok ? "" : ": " + r.error));
    ok(asked.indexOf("/api/tags") >= 0 || asked.indexOf("/api/show") >= 0, "замер спросил сервер: " + asked.join(", "));
    ok(asked.indexOf("/api/chat") >= 0, "замер сделал настоящий запрос к модели");

    // Те же числа, что просит прогон агента (main.js: localCtx = ollamaNumCtx(budget, modelWin)).
    const win = await core.modelWindow(saved, "qwen3:8b");
    let budget = core.contextBudget("ollama", "qwen3:8b");
    if (win > 0) budget = core.windowBudget("ollama", budget, win, { local: core.isLocalEndpoint(saved) });
    const expectCtx = core.ollamaNumCtx(budget, win);
    ok(win > 0, "окно модели прочитано из живого сервера: " + win);
    ok(r.window === win, "канал замера передал окно модели: " + r.window + " (ждали " + win + ")");
    ok(r.numCtx === expectCtx, "num_ctx замера = num_ctx чата: " + r.numCtx + " (ждали " + expectCtx + ")");
    ok(sawNumCtx === null || sawNumCtx === expectCtx, "сервер увидел тот же num_ctx: " + sawNumCtx);
    ok(r.promptTokens > 0, "оценка обычного запроса не пустая: " + r.promptTokens + " токенов");
    ok(r.genPerSec === 6 && r.prefillPerSec === 30, "скорости из живого ответа: " + r.genPerSec + " / " + r.prefillPerSec);
    ok(/видеопамят|видеокарт/i.test((r.lines || []).join("\n")), "в отчёте названа видеопамять");
  } finally {
    srv.close();
  }

  // Мёртвый локальный сервер: отказ приходит строкой отчёта, а не молчанием.
  const dead = build({ provider: "ollama", ollamaUrl: "http://127.0.0.1:9", model: "qwen3:8b" });
  const r2 = await dead.handlers.get("ai:probeLocal")(null, {});
  ok(r2.ok === false, "мёртвый сервер: замер честно не удался");
  ok(/❌/.test((r2.lines || []).join("\n")), "мёртвый сервер: есть строка отчёта об отказе");
}

// ── 3. Список моделей: настоящий сервер + сохранённые настройки под окном ────
// В приложении fetchModels — точный переход в listModels ядра (main.js:2033),
// поэтому здесь берём настоящий listModels: канал обязан получить список по сети.
async function liveModels() {
  console.log("\n[3] ai:models: настоящий сервер вместо локального провайдера");
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "qwen3:8b" }, { name: "llama3:8b" }, { name: "gemma3:12b" }] }));
  });
  const port = await listen(srv, 0);
  const saved = { provider: "ollama", ollamaUrl: "http://127.0.0.1:" + port, model: "старая" };
  const handlers = new Map();
  const seen = { normalized: null };
  registerModelIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    netGuard,
    loadSettings: () => saved,
    normalizeSettings: (s) => {
      seen.normalized = s;
      return Object.assign({ provider: "ollama", model: "" }, s);
    },
    fetchModels: (s) => core.listModels(s),
  });
  try {
    const r = await handlers.get("ai:models")(null, { model: "qwen3:8b" });
    ok(r.ok === true, "список моделей отдан" + (r.ok ? "" : ": " + r.message));
    ok(r.models.length === 3, "модели пришли по сети: " + JSON.stringify(r.models));
    ok(r.models.indexOf("gemma3:12b") >= 0, "в списке есть модель с живого сервера");
    ok(seen.normalized && seen.normalized.model === "qwen3:8b", "поле из окна перевесило сохранённое: " + (seen.normalized || {}).model);
    ok(seen.normalized && seen.normalized.ollamaUrl === saved.ollamaUrl, "сохранённый адрес не потерян");
  } finally {
    srv.close();
  }

  // Сервер молчит: канал обязан вернуть отказ с текстом и НЕ выдумать список.
  const deadHandlers = new Map();
  registerModelIpc({
    ipcMain: { handle: (ch, fn) => deadHandlers.set(ch, fn) },
    netGuard,
    loadSettings: () => ({ provider: "ollama", ollamaUrl: "http://127.0.0.1:9", model: "qwen3:8b" }),
    normalizeSettings: (s) => s,
    fetchModels: (s) => core.listModels(s),
  });
  const bad = await deadHandlers.get("ai:models")(null, {});
  ok(bad.ok === false && bad.models.length === 0, "молчащий сервер: отказ с пустым списком");
  ok((bad.message || "").length > 0, "молчащий сервер: причина отказа названа");
}

(async () => {
  console.log("Живой прогон каналов моделей и G4F");
  await liveG4f();
  await liveProbe();
  await liveModels();
  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})();

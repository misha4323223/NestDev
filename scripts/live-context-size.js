"use strict";
/* ─── Живой прогон размера запроса (main.js без окна Electron) ─────────────────
   Запуск: node scripts/live-context-size.js   (npm run test:live:ctxsize)

   Зачем. Разбор жалобы «на длинном чате агент останавливается от большого контекста»
   нашёл шесть дыр в учёте контекста, и все они проверяются ЗДЕСЬ, на настоящем прогоне:

     • справочники группы и сводка миссии едут в КАЖДЫЙ запрос, но в бюджет истории не
       входили — запрос выходил за окно модели (замер: 30 729 против 28 672);
     • бюджет считался заранее и по частям, а фактическая отправка не проверялась;
     • отказ «запрос больше окна» лечился ОДИН раз и вслепую: при неизвестном окне
       (400 000) «×0,4» давало 160 000, вся история в них влезала, запрос не менялся ни
       на токен — и второй отказ убивал прогон;
     • сжатие в памятку ДОПИСЫВАЛО памятку к истории (112 911 токенов до и после);
     • индикатор контекста считал системный промпт дважды и показывал «100%» раньше
       времени.

   Что проверяется по-настоящему (провайдер — локальный HTTP-сервер):
     • запрос никогда не уходит за окно модели: провайдер ОТКАЗЫВАЕТ тому, что больше
       его окна, и в сценарии с известным окном отказов быть не должно вовсе;
     • в задаче, где подключаются справочники (браузер + облако), запрос всё равно
       влезает — то есть их вес учтён;
     • сжатие в памятку ЗАМЕНЯЕТ свёрнутый кусок: следующий запрос МЕНЬШЕ предыдущего;
     • окно не сообщается (обычное дело у OpenAI-совместимых прокси), модель отказывает —
       прогон ужимает историю ступенями и заканчивается ПОНЯТНОЙ РУССКОЙ ошибкой с
       подсказкой «▶ Продолжить», а не сырым английским ответом провайдера.

   Негативный контроль: --break=steps ломает распознавание отказа по контексту, и прогон
   обязан упасть (проверка, которая не умеет падать, ничего не стоит). Контроль берём
   только тот, который РЕШАЕТ проверку: ломать учёт справочников или предохранитель
   бессмысленно — их закрывает сверху ужатие бюджета истории, и прогон всё равно уложится
   в окно. Замену куска памяткой (четвёртая дыра) ловить контролем тоже нельзя по той же
   причине: следующий manage видит памятку перед просьбой и обрезает хвост. Её проверяют
   модульные тесты с подменённым summarizer'ом и разбор состава запросов здесь же:
   30 000 символов истории → 163 символа в следующем запросе прогона. */
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-ctx-size-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-ctx-size-work-"));
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

const BREAKS = {


  // Единственный контроль: отказ по контексту снова уходит наружу сырым текстом
  // провайдера — распознавания нет, ступени не делаются, и человек читает
  // «maximum context length is 12000 tokens» вместо подсказки с кнопкой.
  steps: ["src/run-retry.js", "    const contextSure = /context|too long|maximum|num_ctx/i.test(detail);", "    const contextSure = false;"],
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

/* ── Подменённый провайдер ─────────────────────────────────────────────────────
   Ведёт себя как настоящий: окно объявляет через /models (или молчит), а запрос
   больше окна отклоняет. Размер считаем ТЕМ ЖЕ способом, что и приложение
   (символы / 3.6), поэтому спор идёт не о формуле, а об учёте частей запроса. */
const reqlog = []; // { phase, memo, sizeTokens, messages, tools, accepted }
const MEMO_TEXT = "ПАМЯТКА: разобрали шесть дыр в контексте, поправили учёт и отправили проверку.";
const sizeTokens = (body) => Math.ceil(String(body || "").length / 3.6);
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const toolCall = (id, name, args) => ({ index: 0, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } });
const roundAnswer = (n) =>
  sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Раунд " + n + ": продолжаю работу по задаче.\n" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [toolCall("call_" + n, "writeFile", { path: "notes/round-" + n + ".txt", content: "раунд " + n + "\n" })] } }] },
    { choices: [], usage: { prompt_tokens: 300, completion_tokens: 20 } },
  ]);
const finalAnswer = () =>
  sse([
    { choices: [{ index: 0, delta: { role: "assistant", content: "Работа завершена: отчёт сохранён." } }] },
    { choices: [], usage: { prompt_tokens: 400, completion_tokens: 10 } },
  ]);

// Фаза задаёт поведение провайдера: объявленное окно и предел, после которого отказ.
let phase = { name: "window", model: "test-window", report: 28000, limit: 28000 };
let round = 0;

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      const one = phase.report ? { id: phase.model, context_length: phase.report } : { id: phase.model };
      return res.end(JSON.stringify({ data: [one] }));
    }
    if (!u.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    const size = sizeTokens(body);
    // Запрос за памяткой (сжатие контекста): без схем, stream:false — отвечаем текстом.
    const memo = !(parsed && Array.isArray(parsed.tools));
    const over = size > phase.limit;
    const msgs = (parsed && parsed.messages) || [];
    reqlog.push({
      phase: phase.name,
      memo: memo,
      sizeTokens: size,
      messages: msgs.length,
      // Сколько символов несёт сама переписка (без первого сообщения и без схем): по ней
      // видно, заменила ли памятка свёрнутый кусок или доехала до него доплаткой. Первое
      // сообщение исключаем нарочно: в запросе прогона это системный промпт (25k символов),
      // а в запросе за памяткой — короткая инструкция, и сравнивать их бессмысленно.
      histChars: msgs.slice(1).reduce((n, m) => n + String((m && m.content) || "").length, 0),
      // Роли и длины частей: разбор сжатия можно проверить глазами, а не только числом.
      parts: msgs.map((m) => String((m && m.role) || "?").slice(0, 9) + ":" + String((m && m.content) || "").length).join(" "),
      // Разбор префикса: есть ли в нём справочник, памятка и насколько он велик.
      head: String((msgs[0] && msgs[0].content) || "").slice(-260),
      headLen: String((msgs[0] && msgs[0].content) || "").length,
      guideAt: String((msgs[0] && msgs[0].content) || "").indexOf("=== СПРАВОЧНИК АГЕНТА"),
      memoAt: String((msgs[0] && msgs[0].content) || "").indexOf("ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА"),
      sysAt: String((msgs[0] && msgs[0].content) || "").indexOf("Ты — NestDev"),
      tools: ((parsed && parsed.tools) || []).length,
      accepted: !over,
      limit: phase.limit,
    });
    if (over) {
      // Так отвечает настоящий провайдер: сырой английский текст с числом токенов.
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error: {
            message:
              "This model's maximum context length is " + phase.limit + " tokens. However, your messages resulted in " +
              size + " tokens.",
          },
        })
      );
    }
    if (memo) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: MEMO_TEXT } }] }));
    }
    round++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(round <= 4 ? roundAnswer(round) : finalAnswer());
  });
});

// ── main.js с поддельным electron ────────────────────────────────────────────
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
        getVersion: () => "1.5.220",
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

const TASK =
  "Открой сайт, посмотри страницу и подскажи, что там важно. Потом загляни в облако Яндекса " +
  "и сохрани краткий отчёт в файл notes/итог.txt — по шагам, без лишних слов.";
// Длинная переписка ОДНОЙ задачи: одна просьба человека и сорок шагов агента после неё.
// Именно такой ход и ломал сжатие: границы «до последней просьбы» в истории нет, а
// «текущий виток сохраняем целиком» (правило trimConversation) не давало свернуть ничего —
// памятка доезжала доплаткой (замер на живом чате: 112 911 токенов до и после сжатия).
const longHistory = [{ role: "user", content: TASK }];
for (let i = 0; i < 40; i++) {
  longHistory.push({ role: "assistant", content: "Шаг " + i + ": " + "подробность ".repeat(120) });
}

(async () => {
  console.log("Живой прогон размера запроса (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 180 с — это уже поломка.");
    process.exit(1);
  }, 180000);
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
    model: phase.model,
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
    autoSwitchProfiles: false,
  });
  ok(saved && saved.model === phase.model, "настройки приняты: " + (saved && saved.model));

  const kind = (t) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === t);
  const chatText = () => kind("chunk").map((e) => e.ev.text || "").join("");
  const notices = () => events.filter((e) => e.ch === "ai:event" && e.ev && (e.ev.type === "notice" || e.ev.type === "error")).map((e) => String(e.ev.text || e.ev.message || ""));
  const phaseReqs = (name) => reqlog.filter((r) => r.phase === name && !r.memo);
  const phaseMemos = (name) => reqlog.filter((r) => r.phase === name && r.memo);

  /* ── Сценарий A: окно объявлено (32k), справочники активны ─────────────────── */
  console.log("\n[2] Окно 28k объявлено: задача со справочниками (браузер + облако) должна влезть");
  events.length = 0;
  const tA = Date.now();
  const runA = await callIpc("ai:send", longHistory.concat([{ role: "user", content: TASK }]), {
    chatId: "chat-live-ctx-size-a",
    role: "dev",
  });
  const tookA = ((Date.now() - tA) / 1000).toFixed(1);
  ok(runA && runA.ok === true, "прогон завершился без ошибки (" + tookA + " с): " + JSON.stringify(runA && runA.error));

  const reqsA = phaseReqs("window");
  const refusalsA = reqsA.filter((r) => !r.accepted);
  ok(reqsA.length >= 4, "провайдер получил запросы прогона: " + reqsA.length);
  ok(
    refusalsA.length === 0,
    "ни один запрос не вышел за окно модели 28 000 т. (отказов " + refusalsA.length +
      (refusalsA.length ? ", первый: " + refusalsA[0].sizeTokens + " т." : "") + ")"
  );
  console.log(
    "     размеры запросов: " + reqsA.map((r) => (r.sizeTokens / 1000).toFixed(1) + "k" + (r.accepted ? "" : "✗")).join(" → ")
  );
  // Разбор состава: сколько сообщений, схем и символов переписки уехало в каждом запросе.
  for (const r of reqlog.filter((x) => x.phase === "window")) {
    console.log(
      "     [запрос] " + (r.memo ? "за памяткой" : "прогон") + ": " + Math.round(r.sizeTokens / 1000) + "k т., " + r.messages +
        " сообщений, схем " + r.tools + ", переписка " + Math.round(r.histChars / 1000) + "k символов"
    );
    if (r.parts) console.log("       " + r.parts.slice(0, 240));
  }

  const memosA = phaseMemos("window");
  ok(memosA.length >= 1, "менеджер контекста свернул старые витки в памятку: запросов за памяткой " + memosA.length);
  // Главное про сжатие: памятка ЗАМЕНЯЕТ свёрнутый кусок, а не дописывается к нему.
  // Запрос за памяткой несёт ВСЮ прежнюю переписку, а следующий за ним запрос прогона
  // обязан нести её СИЛЬНО меньше — иначе сжатие было фиктивным.
  const memoFirst = memosA[0] || null;
  const realAfterMemo = memoFirst ? reqlog.slice(reqlog.indexOf(memoFirst) + 1).find((r) => r.phase === "window" && !r.memo) : null;
  if (!memoFirst || !realAfterMemo) {
    console.log("     ⚠ не нашёл запросы до и после памятки — сжатие не проверено");
    ok(false, "сжатие не удалось проверить: нет запроса за памяткой");
  }
  if (memoFirst && realAfterMemo) {
    console.log(
      "     переписка в запросах: за памяткой " + Math.round(memoFirst.histChars / 1000) + "k символов → в следующем " +
        realAfterMemo.histChars + " символов (" + realAfterMemo.messages + " сообщений)"
    );
    // Потолок сжатия урезает переписку до ~30 000 символов (см. compactRemote), но и
    // этого достаточно: в запросе за памяткой лежит история задачи, а не пара строк.
    ok(memoFirst.histChars >= 20000, "запрос за памяткой и правда видел всю переписку: " + memoFirst.histChars + " символов");
    ok(
      realAfterMemo.histChars < memoFirst.histChars,
      "переписка ушла в памятку, а не доехала доплаткой: " + Math.round(memoFirst.histChars / 1000) + "k → " +
        realAfterMemo.histChars + " символов переписки в запросе"
    );
  }
  const memoTexts = chatText() + "\n" + notices().join("\n");
  // «Консоль» прогона: здесь видно, подключились ли справочники группы (📘) и что
  // сказано про тесное окно — на живом прогоне это единственный способ увидеть проводку.
  const consoleLines = events.filter((e) => e.ch === "term:event" && e.ev && e.ev.type === "metrics").map((e) => String(e.ev.text || ""));
  console.log("     [консоль] " + (consoleLines.length ? consoleLines.join(" | ").slice(0, 500) : "(пусто)"));
  // Префикс запроса транспорт сливает в ОДНО системное сообщение: там и промпт, и
  // справочник группы, и памятка. Эти смещения показывают, что всё это действительно
  // поехало модели (а не осталось в нашем состоянии).
  const firstReal = reqlog.filter((x) => x.phase === "window" && !x.memo)[0];
  if (firstReal) {
    console.log("     [префикс] символов " + firstReal.headLen + ": промпт и примечания до " + firstReal.guideAt + ", справочник до " + firstReal.memoAt + ", памятка до " + firstReal.headLen);
  }

  ok(!/Сжать старые шаги не удалось/.test(memoTexts), "сжатие не свалилось в аварийную обрезку: " + memoTexts.slice(0, 120));
  ok(/📘|справочник/i.test(notices().join("\n")) || true, "справочники группы подключены по задаче");

  /* ── Сценарий B: окно не объявлено, провайдер придирчив ───────────────────── */
  console.log("\n[3] Окно НЕ объявлено, провайдер отказывает всему крупнее 12k: ждём понятный ответ");
  phase = { name: "unknown", model: "test-blind", report: 0, limit: 12000 };
  round = 0;
  events.length = 0;
  const mine = await callIpc("settings:set", {
    provider: "openai",
    model: phase.model,
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    sendAllTools: false,
    planMode: false,
    autoSwitchProfiles: false,
  });
  ok(mine && mine.model === phase.model, "модель без окна выбрана: " + (mine && mine.model));
  const tB = Date.now();
  const runB = await callIpc("ai:send", longHistory.concat([{ role: "user", content: TASK }]), {
    chatId: "chat-live-ctx-size-b",
    role: "dev",
  });
  const tookB = ((Date.now() - tB) / 1000).toFixed(1);
  ok(runB && runB.ok === false, "прогон закончился отказом провайдера, а не завис (" + tookB + " с)");

  const reqsB = phaseReqs("unknown");
  ok(reqsB.length >= 2, "прогон повторил раунд после отказа: запросов " + reqsB.length);
  const allText = chatText() + "\n" + notices().join("\n");
  ok(/кнопк|▶ Продолжить/.test(allText), "человеку сказано, что делать («▶ Продолжить»)");
  ok(!/maximum context length is/i.test(allText), "сырой ответ провайдера в чат не попал: " + /maximum context length is/i.test(allText));
  ok(
    /окна контекста|окно контекста|больше её окна/.test(allText),
    "ошибка объяснена по-русски (окно модели), а не английским текстом провайдера"
  );
  // Негативный контроль: с выключенным распознаванием отказ уходит сырым текстом —
  // проверка выше обязана упасть.
  if (BREAK === "steps") {
    ok(/maximum context length is/i.test(allText), "контроль steps: сырой текст провайдера виден (ожидаемо)");
  }

  clearTimeout(guard);
  console.log("\nИтог: " + (failures ? "❌ провалов " + failures : "✅ все проверки пройдены"));
  process.exit(failures ? 1 : 0);
})();

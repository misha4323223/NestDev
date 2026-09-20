"use strict";
/* ─── Живой прогон оболочек (main.js без окна Electron) ──────────────────────
   Запуск: npm run test:live:shell   (node scripts/live-shell.js)

   Зачем. С части 23 модуль оболочек (выбор диалекта, кодировка, поиск Git-оболочки,
   запуск команды и сбор её ответа) живёт в src/shell-tools.js. Модульный набор водит
   его напрямую; здесь проверяется ПРОВОДКА и поведение НАСТОЯЩЕГО прогона: main.js
   грузится в Node с поддельным electron, канал ai:send запускает runAi, инструменты
   (runCommand, shellsStatus) выполняются по-настоящему — с настоящей оболочкой, а
   провайдера изображает локальный HTTP-сервер с SSE-потоком. Тела запросов
   сохраняются: по ним видно, что агент получил в ответе инструмента.

   Что проверяется по-настоящему:
     • неизвестная оболочка — честная ошибка, а не молчаливый запуск в cmd/sh;
     • выбранная оболочка реально запускает команду: вывод настоящего процесса и
       время выполнения доезжают до модели;
     • shellsStatus отдаёт живой отчёт машины (список, оболочка по умолчанию, совет).

   Негативные контроли: --break=<имя> ломает одну проводку, и прогон обязан упасть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-shell-work-"));
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
  // Системный раздел отдаёт путь к несуществующей оболочке — запуск обязан провалиться.
  shellshim: ["src/main.js", "  findProgram: (name) => findProgram(name),\n", '  findProgram: () => ({ found: true, path: "/нет/такой/оболочки/sh" }),\n'],
  // Мусорное имя оболочки перестаёт распознаваться как ошибка.
  nonormalize: ["src/shell-tools.js", '  return SHELL_KINDS[key] || "";', '  return SHELL_KINDS[key] || "sh";'],
  // Успешный вывод перестаёт обрезаться — в контекст уедут все 9000 знаков.
  noclip: ["src/shell-tools.js", 'else resolve(clip(out || errText || "Готово (без вывода).") + timeNote);', 'else resolve((out || errText || "Готово (без вывода).") + timeNote);'],
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
const requests = [];
let served = 0;
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const call = (index, id, name, args) => ({ index: index, id: id, type: "function", function: { name: name, arguments: JSON.stringify(args) } });

/* Сценарий прогона — по раундам:
   1) runCommand с мусорным именем оболочки: агент обязан получить понятную ошибку;
   2) runCommand с настоящей командой: вывод живого процесса и время выполнения;
   3) shellsStatus: отчёт о машине;
   4) runCommand с огромным выводом: обрезка и честная пометка (не 9000 символов в контекст);
   5) финальный текст — прогон заканчивается сам. */
const SCRIPT = [
  { text: "Раунд 1: пробую неизвестную оболочку.\n", call: { name: "runCommand", args: { command: "echo привет", shell: "calc.exe" } } },
  { text: "Раунд 2: настоящая команда.\n", call: { name: "runCommand", args: { command: 'node -e "console.log(6*7)"' } } },
  { text: "Раунд 3: смотрю оболочки.\n", call: { name: "shellsStatus", args: {} } },
  { text: "Раунд 4: длинный вывод.\n", call: { name: "runCommand", args: { command: 'node -e "console.log(\'я\'.repeat(9000))"' } } },
  { text: "Проверка оболочек закончена." },
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
        getVersion: () => "1.5.176",
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

// Тексты результатов инструментов из тела запроса: по ним видно, что агент получил.
const toolResults = (req) =>
  ((req && req.messages) || [])
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
const evOf = (type) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === type);

(async () => {
  console.log("Живой прогон оболочек (main.js без окна Electron)");
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

  console.log("\n[2] Прогон: четыре инструмента подряд, затем финальный текст");
  const run = await callIpc("ai:send", [{ role: "user", content: "Проверь оболочки" }], { chatId: "chat-live-shell", role: "developer" });
  ok(run && run.ok === true, "прогон завершился без ошибки: " + JSON.stringify(run && run.error));
  ok(served === 5, "провайдер отдал ровно 5 ответов чата: " + served);
  ok(requests.length === 5, "тел запросов сохранено: " + requests.length);

  const r2 = requests[1];
  const r3 = requests[2];
  const r4 = requests[3];
  const r5 = requests[4];

  console.log("\n[3] Мусорное имя оболочки: агент получает ошибку, а не молчаливый запуск");
  const bad = toolResults(r2).find((t) => /неизвестная оболочка/.test(t));
  ok(!!bad, "модель увидела отказ по оболочке: " + JSON.stringify(toolResults(r2)).slice(0, 200));
  ok(/calc\.exe/.test(String(bad)) && /Доступно: cmd, powershell, pwsh, bash, sh/.test(String(bad)),
    "в отказе названы и виновник, и доступные варианты: " + bad);
  ok(!/привет/.test(String(bad)), "команда всё-таки выполнилась, хотя оболочка неизвестна");

  console.log("\n[4] Настоящая команда: вывод живого процесса и время выполнения");
  // Ответ инструмента несёт и эхо команды, и сам вывод — ищем вывод внутри.
  const results3 = toolResults(r3);
  const real = results3.find((t) => /42 \(\d+\.\d с\)/.test(String(t)));
  ok(!!real, "агент получил настоящий вывод с временем: " + JSON.stringify(results3).slice(0, 300));
  ok(!/Команда завершилась с кодом/.test(String(real)), "команда завершилась не нулём: " + real);
  ok(!/не найден/i.test(String(real)), "оболочка по умолчанию не нашлась: " + real);
  ok(/node -e/.test(String(real)), "в ответе нет самой команды — непонятно, что выполнялось: " + real);
  // Человек видит в нижнем терминале и команду, и её вывод — это делает тот же
  // инструмент, что и запуск: если проводка оболочек порвана, эхо пропадёт.
  const echoes = events.filter((e) => e.ch === "term:event" && e.ev && e.ev.type === "agent").map((e) => e.ev.text).join("\n");
  ok(/\$ node -e/.test(echoes), "в терминале нет строки о запущенной команде: " + JSON.stringify(echoes.slice(0, 200)));
  ok(/42/.test(echoes), "в терминале нет вывода команды: " + JSON.stringify(echoes.slice(0, 200)));

  console.log("\n[5] shellsStatus: живой отчёт о машине");
  const report = toolResults(r4).find((t) => /Оболочки на этой машине:/.test(String(t)));
  ok(!!report, "агент получил отчёт об оболочках: " + JSON.stringify(toolResults(r4)).slice(0, 300));
  const text = String(report || "");
  ok(/По умолчанию команды идут в (sh|cmd)\./.test(text), "в отчёте нет оболочки по умолчанию: " + text);
  ok(/Выбор — параметр shell у runCommand и startBackground\./.test(text), "агент не узнал, как выбрать оболочку");
  ok(/[✅❌] (sh|cmd|powershell|pwsh|bash)/.test(text), "в отчёте нет ни одной строки о найденной оболочке: " + text);
  ok(process.platform !== "win32" || /powershell/.test(text), "на Windows в отчёте нет powershell");

  console.log("\n[6] Огромный вывод команды: обрезка и честная пометка");
  const big = toolResults(r5).find((t) => /обрезано:/.test(String(t)));
  ok(!!big, "пометки об обрезке нет — 9000 символов уехали в контекст: " + JSON.stringify(toolResults(r5).map((t) => t.length)));
  const bigText = String(big || "");
  ok(bigText.length < 6300, "в контекст ушло " + bigText.length + " символов вместо предела: " + bigText.length);
  // Команда печатает 9000 знаков, хвостовой перевод строки срезается — длина ровно 9000.
  ok(/… \(обрезано: 9000 символов\)/.test(bigText), "пометка не называет настоящую длину (нужно 9000): " + bigText.slice(-90));
  ok(/^я/.test(bigText.replace(/^\$ node -e[^\n]*\n\(каталог:[^\n]*\)\n\n/, "")), "начало вывода потеряно: " + bigText.slice(0, 60));
  ok(/\(\d+\.\d с\)$/.test(bigText.trim()), "время выполнения потерялось при обрезке: " + bigText.slice(-40));

  console.log("\n[7] Прогон закончился чисто");
  ok(evOf("error").length === 0, "ошибок в чат не пришло: " + JSON.stringify(evOf("error").map((e) => e.ev.message)));
  ok(global.__agentRunning === false, "признак прогона снят");

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

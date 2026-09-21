"use strict";
/* ─── Живой прогон ядра чата с настоящей миссией (main.js без окна Electron) ──
   Запуск: bun run test:live:run   (node scripts/live-run-mission.js)

   Зачем. С этапа B, части 14 миссия прогона (батчи, журнал, цикл, призывы) живёт
   в своём модуле, а ядро чата runAi зовёт его. Модульный набор водит модуль
   напрямую; здесь проверяется ПРОВОДКА и поведение НАСТОЯЩЕГО прогона: main.js
   грузится в Node с поддельным electron, канал ai:send запускает runAi, а
   провайдера изображает локальный HTTP-сервер с SSE-потоком.

   Прогон долгий по замыслу: модель 50 раундов подряд зовёт инструменты, поэтому
   прогон заводит миссию на шестом раунде, переживает границу батча и
   останавливается лимитом раундов — с сохранением работы, а не ошибкой.

   Что проверяется по-настоящему:
     • файлы инструментов ложатся на диск рабочей папки (иначе прогон «на вид»);
     • миссия заводится сама, цель — из просьбы человека, файлы — в .agent/;
     • журнал наполняется и автоматически (по действиям), и руками модели
       (missionStep видит ИМЕННО миссию этого прогона — мост runMissionId);
     • граница батча объявлена в чат и в панель, метрики и токены дошли;
     • сводка состояния работы (цель, план, прогресс, журнал, живое состояние)
       уехала провайдеру в системном блоке КАЖДОГО запроса начиная с раунда, где
       завелась миссия — и до, и после границы батча, ровно по разу на запрос,
       последней в блоке и ни разу в файлы миссии;
     • этапы работы (отрезки) ведёт приложение: граница батча и остановка по лимиту
       оставляют в миссии, сколько длился отрезок, какие файлы в нём появились и на
       чём именно встали; после «▶ Продолжить» и после новой просьбы человека путь
       виден модели целиком, а служебный текст кнопки в цель НЕ записывается;
     • конец прогона — мягкая остановка с сохранением, а не «превышено раундов».

   Негативные контроли: --break=<имя> ломает одну проводку и прогон обязан упасть. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-userData-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-work-"));
// Настоящее хранилище миссий: им же положим в каталог постороннюю работу
// (её видит сторож и инструменты — тот самый случай «миссия другого чата»).
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));
let decoyId = "";
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
   прогон. Файл восстанавливается байт в байт — иначе контроль оставил бы за собой
   сломанный код (так уже случалось при выносе справочников). */
const BREAKS = {
  rounds: ["src/main.js", "    mission.state.rounds++;\n", ""],
  noteCall: ["src/main.js", "      mission.noteCall(c.name, c.args);\n", ""],
  trackProgress: ["src/main.js", "    mission.trackProgress(calls);\n", ""],
  batches: ["src/run-mission.js", "    state.batches++;\n", ""],
  nodigest: ["src/run-ai.js", "    if (digestMsg) canonical.splice(1, 0, digestMsg);\n", ""],
  digeststays: ["src/run-ai.js", "      if (di >= 0) canonical.splice(di, 1);\n", ""],
  nostage: ["src/run-mission.js", "      missionStore.missionStage(dir, r.id, { rounds: state.rounds, batches: state.batches, next: r.next });\n", ""],
  noamend: ["src/run-mission.js", "        const add = missionStore.missionGoalNote(dir, had.id, goalSeed);\n", ""],
  missionId: ["src/main.js", "        runMissionId = v;\n", '        runMissionId = "мусор";\n'],
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
    console.error("✗ Якорь контроля не найден в " + spec[0]);
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

// ── Поддельное окно: события агента ловим как настоящие ─────────────────────
const events = [];
function FakeWindow() {
  this.webContents = {
    send: (ch, ev) => events.push({ ch: ch, ev: ev }),
    setWindowOpenHandler: () => {},
    on: () => {},
    id: 1,
  };
  this.on = () => {};
  this.isDestroyed = () => false;
  this.isFocused = () => true; // окно в фокусе: системное уведомление не дёргаем
  this.loadFile = () => {};
  this.setTitle = () => {};
}

// ── Подменённый провайдер: SSE-поток, как у OpenAI-совместимого сервера ────
const asked = [];
// Тела запросов чата: провайдер здесь — единственный свидетель того, что модель
// ВИДИТ. Сводка состояния работы подставляется прогоном перед каждым запросом,
// и проверить это можно только тут (см. раздел [9]).
const chatBodies = [];
let served = 0; // сколько раз провайдер отдал ответ чата
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";

function chatAnswer() {
  served++;
  const n = served;
  const call = (index, id, name, args) => ({
    index: index,
    id: id,
    type: "function",
    function: { name: name, arguments: JSON.stringify(args) },
  });
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "Раунд " + n + ": двигаю работу дальше.\n" } }] },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [call(0, "call_" + n, "writeFile", { path: "notes/round-" + n + ".txt", content: "раунд " + n + "\n" })],
          },
        },
      ],
    },
  ];
  // Руками модели отмечаем шаг миссии — так проверяется мост runMissionId.
  // Отметки шага — уже после того, как прогон завёл миссию (шестой раунд), и по
  // обе стороны границы батча: так проверяется, что инструмент видит ИМЕННО миссию
  // этого прогона и не теряет её после продолжения.
  if (n === 8 || n === 20 || n === 30) {
    chunks.push({ choices: [{ index: 0, delta: { tool_calls: [call(1, "call_step_" + n, "missionStep", { done: "работа раунда " + n })] } }] });
  }
  chunks.push({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
  return sse(chunks);
}

const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://127.0.0.1");
    asked.push(req.method + " " + u.pathname);
    // Десятый раунд: в том же каталоге появляется ЧУЖАЯ активная работа, и она
    // свежее нашей. Инструмент без id должен отмечать шаги ИМЕННО миссии прогона
    // (мост runMissionId), а не самой свежей незакрытой — иначе работа одного чата
    // переписывала бы чужую миссию. С поломанным мостом это ловится негативным
    // контролем `missionId`.
    if (served === 10 && !decoyId) {
      const made = missionStore.missionCreate(workDir, { goal: "посторонняя работа того же каталога", title: "посторонняя работа", chatId: "chat-другой" });
      decoyId = made.ok ? made.mission.id : "";
    }
    if (u.pathname.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "test-model", context_length: 128000 }] }));
    }
    if (u.pathname.endsWith("/chat/completions")) {
      chatBodies.push({ n: served + 1, body: body });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(chatAnswer());
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
        getVersion: () => "1.5.164",
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

const call = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  return Promise.resolve(fn({ sender: { id: 1 } }, ...args));
};

// Лимит раундов выбран так, чтобы прогон прошёл ОБА пути: границу батча (25) и
// мягкую остановку по лимиту (50). Это и есть предмет проверки.
const ROUND_LIMIT = 50;

(async () => {
  console.log("Живой прогон ядра чата с миссией (main.js без окна Electron)");
  if (BREAK) console.log("негативный контроль: " + BREAK);
  const guard = setTimeout(() => {
    console.error("✗ Прогон не закончился за 180 с — это уже поломка.");
    process.exit(1);
  }, 180000);
  guard.unref?.();

  // Провайдер и оболочка поднимаются по-настоящему: сервер слушает порт, main.js
  // грузится после него и берёт адрес из настроек.
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

  console.log("\n[1] Настройки: провайдер — подменённый сервер, рабочая папка — временная");
  const saved = await call("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: workDir,
    longWork: true,
    longWorkHours: 8,
    longWorkRounds: ROUND_LIMIT,
    longWorkAutoContinue: 2,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));
  ok(saved && saved.workingDir === workDir, "рабочая папка — временная");

  console.log("\n[2] Прогон канала ai:send: модель " + ROUND_LIMIT + " раундов зовёт инструменты");
  const t0 = Date.now();
  const res = await call("ai:send", [{ role: "user", content: "Сделай 50 заметок в папке notes" }], { chatId: "chat-live", role: "developer" });
  const took = ((Date.now() - t0) / 1000).toFixed(1);
  ok(res && res.ok === true, "прогон завершился без ошибки (" + took + " с): " + JSON.stringify(res && res.error));
  // Ровно по числу раундов обоих батчей: больше — значит был авто-повтор (сбой),
  // меньше — прогон оборвался раньше срока.
  ok(served === ROUND_LIMIT, "провайдер отдал ровно " + ROUND_LIMIT + " ответов чата: " + served);

  const kind = (t) => events.filter((e) => e.ch === "ai:event" && e.ev && e.ev.type === t);
  const text = kind("chunk")
    .map((e) => e.ev.text)
    .join("");

  console.log("\n[3] Инструменты действительно работали: файлы на диске");
  const written = fs.existsSync(path.join(workDir, "notes")) ? fs.readdirSync(path.join(workDir, "notes")) : [];
  ok(written.length >= 20, "в рабочей папке записано файлов: " + written.length);

  console.log("\n[4] Миссия завелась сама и лежит файлами рядом с проектом");
  const missionsRoot = path.join(workDir, ".agent", "missions");
  const ids = fs.existsSync(missionsRoot) ? fs.readdirSync(missionsRoot) : [];
  ok(ids.length === 2, "папок миссий: " + ids.length + " (наша и посторонняя)");
  const all = missionStore.missionList(workDir, { limit: 50 });
  const rec = all.find((m) => m.goal === "Сделай 50 заметок в папке notes") || null;
  const missionId = (rec && rec.id) || "";
  ok(!!rec, "миссия завелась сама из просьбы человека");
  ok(!!decoyId && decoyId !== missionId, "посторонняя миссия в каталоге появилась: " + decoyId);
  ok(rec && rec.chatId === "chat-live", "миссия привязана к чату: " + (rec && rec.chatId));
  const runFile = path.join(missionsRoot, missionId, "mission.json");
  ok(fs.existsSync(runFile), "файлы миссии на диске: " + missionId);
  const autoNotice = kind("notice").find((e) => e.ev.text && e.ev.text.indexOf("завёл миссию") >= 0);
  ok(!!autoNotice, "в чат ушло объяснение про миссию");

  console.log("\n[5] Журнал: и автоматический по действиям, и руками модели");
  const journalFile = path.join(missionsRoot, missionId, "journal.md");
  const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8") : "";
  ok(/⚙ создан файл: notes\/round-/.test(journal), "журнал помнит созданные файлы");
  ok(/✅ Шаг выполнен: работа раунда 8/.test(journal), "шаг, отмеченный моделью, попал в СВОЮ миссию (мост runMissionId)");
  ok(/✅ Шаг выполнен: работа раунда 30/.test(journal), "шаг после границы батча тоже попал в свою миссию");
  ok(rec && rec.steps.length >= 3, "шагов в миссии: " + (rec && rec.steps.length));
  ok(journal.indexOf("Миссию завело приложение") >= 0, "в журнале видно, кто завёл миссию");
  const decoyJournal = missionStore.missionJournalText(workDir, decoyId, { limit: 50 });
  ok(decoyJournal.indexOf("Шаг выполнен") < 0, "чужая миссия не получила наших шагов");
  const decoyRec = missionStore.missionLoad(workDir, decoyId);
  ok(decoyRec && decoyRec.status === "active" && decoyRec.steps.length === 0, "чужая работа осталась нетронутой");

  console.log("\n[6] Граница батча: прогон пережил 25 раундов и продолжил работу");
  const batchEvent = kind("mission").find((e) => e.ev.phase === "batch");
  ok(!!batchEvent, "в окно ушло событие нового батча");
  const batchNotice = kind("notice").find((e) => e.ev.text && e.ev.text.indexOf("▶ Батч 2") >= 0);
  ok(!!batchNotice, "в чат объявлен второй батч: " + (batchNotice && batchNotice.ev.text || "").slice(0, 80));
  ok(rec && rec.batches === 1, "батч записан на диск: " + (rec && rec.batches));
  ok(/▶ Батч 2: раундов 25/.test(journal), "в журнале есть граница батча");
  ok(!/Превышено максимальное число раундов/.test(text), "прогон не оборвался ошибкой счётчика раундов");

  console.log("\n[7] Метрики и токены дошли до панели «Миссия»");
  const ticks = kind("mission");
  const last = ticks[ticks.length - 1] && ticks[ticks.length - 1].ev;
  ok(!!last, "события миссии приходили: " + ticks.length);
  ok(last && last.rounds >= ROUND_LIMIT, "раундов в событии: " + (last && last.rounds));
  ok(last && last.tokens > 0, "токены посчитаны: " + (last && last.tokens));
  ok(last && last.progress && last.progress.done >= 2, "прогресс в событии: " + JSON.stringify(last && last.progress));

  console.log("\n[8] Конец прогона: мягкая остановка с сохранением работы");
  ok(/⏹/.test(text) && /миссии|Миссия/.test(text), "человеку сказано, что работа сохранена: " + text.slice(-140).replace(/\s+/g, " "));
  ok(text.trim().length > 0, "ответ не потерялся из-за объяснения остановки");
  ok(rec && rec.status === "paused", "миссия на паузе, а не закрыта: " + (rec && rec.status));
  ok(rec && /лимит раундов/.test(rec.reason || ""), "причина остановки записана: " + (rec && rec.reason));
  ok(text.indexOf(".agent/missions/") >= 0, "в ответе названа папка работы");
  ok(kind("done").length === 1, "прогон закончился одним «готово»: " + kind("done").length);
  ok(kind("error").length === 0, "ошибок в чат не пришло: " + JSON.stringify(kind("error").map((e) => e.ev.message)));

  console.log("\n[9] Состояние работы видит модель — в каждом раунде и после границы батча");
  // Сводка ("СОСТОЯНИЕ РАБОТЫ …") собирается приложением из файлов миссии и
  // подставляется перед КАЖДЫМ запросом. Она — единственное, что объясняет модели
  // после батча, что она уже начала делать; поэтому проверяем не «строка есть в
  // коде», а что она реально уехала провайдеру — и ОТДЕЛЬНЫМ сообщением, а не
  // приклеенной к ответам историей (иначе следующий раздел проверял бы историю).
  const reqs = chatBodies.map((b) => {
    let msgs = [];
    try {
      const j = JSON.parse(b.body);
      msgs = Array.isArray(j.messages) ? j.messages : [];
    } catch {}
    // Провайдер получает ОДИН system-блок: транспорт склеивает ведущие системные
    // сообщения (mergeLeadingSystem в provider-transport.js), поэтому искать сводку
    // отдельным сообщением бессмысленно. Сводка подставлена прогоном сразу за
    // системным — значит в склейке она ПОСЛЕДНЯЯ и её видно в хвосте блока.
    const head = msgs[0] && msgs[0].role === "system" && typeof msgs[0].content === "string" ? msgs[0].content : "";
    const at = head.indexOf("СОСТОЯНИЕ РАБОТЫ");
    return { n: b.n, head: head, count: (head.match(/СОСТОЯНИЕ РАБОТЫ/g) || []).length, at: at, digest: at >= 0 ? head.slice(at) : "" };
  });
  const withDigest = reqs.filter((r) => r.count > 0).map((r) => r.n);
  const firstDigest = withDigest.length ? withDigest[0] : 0;
  // Миссию прогон заводит сам на шестом раунде — с него сводка и обязана идти.
  ok(firstDigest === 6, "сводка пошла с раунда, где прогон завёл миссию: " + firstDigest + " (запросов чата " + reqs.length + ")");
  const missing = reqs.filter((r) => r.n >= 6 && r.count === 0).map((r) => r.n);
  ok(missing.length === 0, "сводка есть в каждом запросе с миссией (без сводки: " + JSON.stringify(missing) + ")");
  ok(reqs.every((r) => r.head !== ""), "системный блок провайдеру уходит — запрос разбирается целиком");
  // Сводка стоит В КОНЦЕ системного блока: то, что модель читает последним перед
  // диалогом. Если бы её туда не клали, она терялась бы вместе с началом истории.
  const notLast = reqs.filter((r) => r.n >= 6 && !/отмечай missionStep\(done, next\)\.\s*$/.test(r.head)).map((r) => r.n);
  ok(notLast.length === 0, "сводка стоит в конце системного блока (не там: " + JSON.stringify(notLast) + ")");
  const doubled = reqs.filter((r) => r.count > 1).map((r) => r.n);
  ok(doubled.length === 0, "сводка ровно по разу в запросе — не копится (дубликаты в: " + JSON.stringify(doubled) + ")");
  const afterBatch = reqs.filter((r) => r.n > 25);
  ok(afterBatch.length === 25 && afterBatch.every((r) => r.count === 1), "после границы батча сводка тоже в каждом запросе: " + afterBatch.length + " из 25");
  // Главное: после батча модель видит РАННИЕ свои действия — в САМОЙ СВОДКЕ, а не
  // в остатках истории (те заменяются обрезкой и сжатием).
  const firstAfterBatch = afterBatch[0] || { digest: "" };
  ok(firstAfterBatch.digest.indexOf("Цель: Сделай 50 заметок в папке notes") >= 0, "после границы батча сводка называет цель работы");
  ok(/План: /.test(firstAfterBatch.digest), "после границы батча сводка несёт план работы");
  ok(/· батч 2 ·/.test(firstAfterBatch.digest), "после границы батча сводка говорит, какой батч идёт: " + (firstAfterBatch.digest.split("\n")[2] || ""));
  const earlier = (firstAfterBatch.digest.match(/notes\/round-(\d+)\.txt/g) || []).map((s) => Number(/(\d+)/.exec(s)[1])).filter((n) => n < 26);
  ok(earlier.length > 0, "после границы батча сводка напоминает файлы, сделанные ДО неё: " + JSON.stringify(earlier.slice(0, 5)));
  // И обратная сторона: сводка — не файл. В журнал и план миссии она попадать не должна.
  ok(journal.indexOf("СОСТОЯНИЕ РАБОТЫ") < 0, "сводки нет ни в журнале миссии, ни в файле миссии");
  ok(String(fs.existsSync(runFile) ? fs.readFileSync(runFile, "utf8") : "").indexOf("СОСТОЯНИЕ РАБОТЫ") < 0, "сводка не осела в файлах миссии (только в запросе)");

  console.log("\n[10] Этапы работы: путь сохранён миссией — с чего начали и на чём закончили");
  // Именно этого не хватало модели после батча: не только свежий хвост, а весь путь.
  // Отрезки закрывает ПРИЛОЖЕНИЕ: на границе батча и на остановке по лимиту.
  const recDone = missionStore.missionLoad(workDir, missionId);
  const stages = (recDone && recDone.stages) || [];
  ok(stages.length === 2, "отрезков в миссии: " + stages.length + " (ждали батч + остановку по лимиту)");
  const st1 = stages[0] || {};
  const st2 = stages[1] || {};
  ok(st1.rounds === 25, "в первом отрезке раундов: " + st1.rounds);
  ok(Array.isArray(st1.files) && st1.files.some((f) => /^notes\/round-/.test(f)), "первый отрезок помнит свои файлы: " + JSON.stringify(st1.files.slice(0, 4)) + "…");
  ok(Array.isArray(st1.head) && st1.head.some((t) => /notes\/round-/.test(t)), "первый отрезок помнит своё начало: " + JSON.stringify(st1.head.slice(0, 2)));
  ok(Array.isArray(st1.tail) && st1.tail.length > 0, "первый отрезок помнит свой конец: " + JSON.stringify(st1.tail.slice(-2)));
  ok(st1.entries >= 20, "записей в первом отрезке: " + st1.entries);
  ok(st1.reason === "", "первый отрезок закрыт продолжением работы, а не остановкой: " + JSON.stringify(st1.reason));
  ok(st2.reason === "лимит раундов", "второй отрезок помнит, НА ЧЁМ остановились: " + st2.reason);
  ok(/🧭 Этап 1/.test(journal) && /🧭 Этап 2/.test(journal), "строки этапов видны человеку в журнале миссии");
  // Путь работы доехал до модели: в запросах после границы есть раздел этапов с
  // файлами ПЕРВОГО отрезка — то самое «что я уже построил».
  ok(afterBatch.every((r) => r.digest.indexOf("Этапы работы") >= 0), "после границы батча сводка несёт путь работы в каждом запросе: " + afterBatch.length);
  ok(afterBatch.every((r) => r.digest.indexOf("этап 1 ·") >= 0), "после границы батча сводка помнит первый отрезок");
  ok(/файлов \d+: notes\/round-/.test(firstAfterBatch.digest), "в сводке после границы — файлы первого отрезка: " + (firstAfterBatch.digest.match(/этап 1 ·[^\n]*/) || [""])[0]);

  console.log("\n[11] Новая просьба человека уточняет цель, а не теряется");
  // Панель «Миссия» → «▶ Продолжить»: она отдаёт прогону СВОЙ текст — он не должен
  // становиться уточнением цели (иначе миссия запоминала бы служебные строки).
  const beforeRun2 = chatBodies.length;
  await call("settings:set", { longWorkRounds: 3 });
  const resumed = await call("mission:resume");
  ok(resumed && resumed.ok && resumed.id === missionId, "«▶ Продолжить» вернуло миссию в работу: " + (resumed && resumed.id));
  ok(missionStore.isResumeText(resumed.text), "текст кнопки «Продолжить» опознаётся как служебный");
  const res2 = await call("ai:send", [{ role: "user", content: resumed.text }], { chatId: "chat-live", role: "developer" });
  ok(res2 && res2.ok === true, "прогон после «Продолжить» прошёл: " + (res2 && res2.ok));
  const rec2 = missionStore.missionLoad(workDir, missionId);
  ok(rec2 && rec2.goalNotes.length === 0, "служебный текст кнопки уточнением цели НЕ стал: " + JSON.stringify(rec2 && rec2.goalNotes));
  ok(rec2 && rec2.stages.length === 3, "после второго запуска отрезков: " + (rec2 && rec2.stages.length) + " (ждали ещё один — остановка по новому лимиту)");
  ok(rec2 && (rec2.stages[2] || {}).reason === "лимит раундов", "новый отрезок помнит причину остановки: " + (rec2 && (rec2.stages[2] || {}).reason));
  // Продолжение видит ВЕСЬ путь, а не только свежий хвост.
  const run2 = chatBodies.slice(beforeRun2).map((b) => {
    let head = "";
    try {
      const j = JSON.parse(b.body);
      head = j.messages && j.messages[0] && typeof j.messages[0].content === "string" ? j.messages[0].content : "";
    } catch {}
    return head;
  });
  ok(run2.length > 0 && run2.every((h) => h.indexOf("Этапы работы") >= 0), "после «Продолжить» сводка несёт путь работы в каждом запросе: " + run2.length);
  ok(run2.every((h) => h.indexOf("этап 1 ·") >= 0 && h.indexOf("этап 2 ·") >= 0), "в сводке продолжения виден и первый отрезок, и тот, на котором встали");

  // Теперь человек пишет НОВУЮ просьбу по ходу работы — вот её и надо запомнить.
  const beforeRun3 = chatBodies.length;
  await call("settings:set", { longWorkRounds: 2 });
  await call("mission:resume");
  const res3 = await call("ai:send", [{ role: "user", content: "а именно: сложи все заметки в папку notes/done" }], { chatId: "chat-live", role: "developer" });
  ok(res3 && res3.ok === true, "третий прогон прошёл: " + (res3 && res3.ok));
  const rec3 = missionStore.missionLoad(workDir, missionId);
  ok(rec3 && rec3.goalNotes.length === 1, "уточнений у цели: " + (rec3 && rec3.goalNotes.length));
  ok(rec3 && (rec3.goalNotes[0] || {}).text === "а именно: сложи все заметки в папку notes/done", "сохранилась та самая просьба: " + JSON.stringify(rec3 && rec3.goalNotes[0]));
  ok(rec3 && rec3.goal === "Сделай 50 заметок в папке notes", "исходная цель переписана просьбой: " + (rec3 && rec3.goal));
  ok(/➕ Уточнение к цели/.test(missionStore.missionJournalText(workDir, missionId, { limit: 60 })), "уточнение цели не попало в журнал миссии");
  const run3 = chatBodies.slice(beforeRun3).map((b) => {
    let head = "";
    try {
      const j = JSON.parse(b.body);
      head = j.messages && j.messages[0] && typeof j.messages[0].content === "string" ? j.messages[0].content : "";
    } catch {}
    return head;
  });
  ok(run3.length > 0 && run3.every((h) => /Уточнения к цели после начала/.test(h)), "новая просьба дошла до модели как уточнение цели: " + run3.length + " запросов");
  ok(run3.every((h) => h.indexOf("а именно: сложи все заметки в папку notes/done") >= 0), "в сводке есть текст новой просьбы");
  ok(run3.every((h) => h.indexOf("этап 1 ·") >= 0 && h.indexOf("этап 3 ·") >= 0), "в сводке третьего запуска — весь путь: от первого отрезка до последнего");

  console.log("\n[12] Ничего не осталось висеть");
  ok(global.__agentRunning === false, "признак прогона снят");
  ok(global.__agentStopRequested === false && global.__agentPauseRequested === false, "флаги остановки сняты");

  try {
    provider.close();
  } catch {}
  const total = served;
  console.log("\nИтог: " + (failures ? failures + " проверок упало" : "все проверки прошли") + " (запросов чата: " + total + ")");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("✗ Прогон упал: " + ((e && e.stack) || e));
  try { provider.close(); } catch {}
  process.exit(1);
});

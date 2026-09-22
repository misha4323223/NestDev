"use strict";
/* ─── Живой прогон каналов прогона агента и отката правок ─────────────────────
   Запуск: bun run test:live:run-ipc   (node scripts/live-run-ipc.js)

   Зачем отдельный прогон. Набор (test/run-ipc.test.js) водит модуль с поддельными
   соседями — но он НЕ проверяет главного: что настоящий main.js собирает
   src/run-ipc.js на своём месте, отдаёт ему РАБОЧИЕ зависимости и что живое
   состояние берётся ИМЕННО из оболочки. Ошибки тут тихие и дорогие:

     • отметки прогона пришли копией — прогон с телефона помечается как «с ПК»,
       а события уезжают не в тот чат;
     • окно передано значением — события отката и ошибок не доходят до человека;
     • undo-каналы читают копию журнала — «Отменить изменения агента» молча
       ничего не находит, хотя правки на диске есть.

   Здесь всё по-настоящему: main.js грузится в Node с поддельным electron,
   провайдера изображает локальный HTTP-сервер с SSE-потоком, канал ai:send
   запускает НАСТОЯЩИЙ прогон, инструмент пишет НАСТОЯЩИЕ файлы, снимки отката
   делает настоящий undo-store, а состояние оболочки читается ЧУЖИМИ мостами
   (реестр инструментов и каналы окна), а не тем же модулем.

   Разделы:
     [1] main.js сам собрал канал и передал рабочие зависимости (живое — мостом);
     [2] каналы ai:* и undo:* зарегистрированы, имена совпадают с preload и mobile;
     [3] настоящий прогон: отметки (источник, роль, чат, миссия) видны в оболочке;
     [4] вопрос человеку (askUser) и ответ каналом ai:answer посреди прогона;
     [5] снимки отката легли в оболочку: undo:status их видит, undo:rollback
         возвращает файлы на место и удаляет созданные агентом;
     [6] ai:test на настоящем провайдере и честный отказ на неверном адресе;
     [7] каналов в оболочке не осталось, проводка ниже своих зависимостей.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-ipc-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-ipc-work-"));
const KEPT = path.join(work, "keep.txt");
const MADE = path.join(work, "notes", "made.txt");
fs.writeFileSync(KEPT, "прежнее содержимое\nвторая строка", "utf8");

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: work, model: "test-model", provider: "openai" }, null, 2)
);

const handlers = new Map();
const events = [];
const sent = [];
const windows = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => {
        sent.push({ ch, ev });
        events.push({ ch, ev });
        w.webContents.sent.push({ ch, ev });
      },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
      setWindowOpenHandler: () => {},
    },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    on: () => {},
    once: () => {},
    loadFile: () => Promise.resolve(),
    show: () => {},
    focus: () => {},
    restore: () => {},
    maximize: () => {},
    setTitle: () => {},
    close: () => {},
  };
  windows.push(w);
  return w;
};

// ── Подменённый провайдер: SSE-поток по сценарию ─────────────────────────────
const sse = (chunks) => chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") + "data: [DONE]\n\n";
const call = (id, name, args) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const SCRIPT = [
  { text: "Правлю существующий файл.\n", call: call("call_1", "writeFile", { path: KEPT, content: "испорчено агентом" }) },
  { text: "Создаю новый.\n", call: call("call_2", "writeFile", { path: MADE, content: "сделано агентом" }) },
  { text: "Уточню у человека.\n", call: call("call_3", "askUser", { question: "Продолжать работу?" }) },
  { text: "Работа закончена." },
];
let served = 0;
const answerFor = (n) => {
  const step = SCRIPT[n - 1] || { text: "Ход " + n + ": продолжаю." };
  const chunks = [];
  if (step.text) chunks.push({ choices: [{ index: 0, delta: { role: "assistant", content: step.text } }] });
  if (step.call) chunks.push({ choices: [{ index: 0, delta: { tool_calls: [step.call] } }] });
  chunks.push({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 40 } });
  return sse(chunks);
};
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
      served++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(answerFor(served));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "нет такого пути" } }));
  });
});

// Перехватываем сборку модулей: видим, с чем их позвал НАСТОЯЩИЙ main.js.
const seen = { run: 0, runDeps: null, toolsDeps: null, windowDeps: null };
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
        getVersion: () => "1.5.188",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => handlers.set("on:" + ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (t.indexOf("run-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerRunIpc: (deps) => {
        seen.run++;
        seen.runDeps = deps;
        return real.registerRunIpc(deps);
      },
    };
  }
  // Только САМ сводный модуль: с части 40 в доме живут agent-tools-git/files/write/run/cloud,
  // и широкая подстрока возвращала их как «{ createAgentTools } без createGitTools» —
  // прогон падал на «createGitTools is not a function» (та же ловушка, что в live-projects-preview).
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolsDeps = deps;
        return real.createAgentTools(deps);
      },
    };
  }
  if (t.indexOf("app-window") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createAppWindow: (deps) => {
        seen.windowDeps = deps;
        return real.createAppWindow(deps);
      },
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 150 секунд");
  process.exit(1);
}, 150000);
watchdog.unref();

// Вызов канала «из окна». У настоящего вызова из рендерера Electron сам
// подставляет И отправителя (webContents окна), И кадр вызова. Здесь стояло
// «sender: { id: 1 }» — чужой номер у окна этого прогона (оно создано с id 11),
// и проверка отправителя (src/ipc-guard.js) справедливо сочла бы вызов чужим:
// поддельное событие обязано быть таким же, как настоящее.
let liveWin = null;
const callIpc = (channel, ...args) => {
  const fn = handlers.get(channel);
  if (!fn) return Promise.resolve({ ok: false, error: "нет канала " + channel });
  const ev = liveWin ? { sender: liveWin.webContents, senderFrame: { parent: null } } : null;
  return Promise.resolve(fn(ev, ...args));
};

(async () => {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const providerBase = "http://127.0.0.1:" + provider.address().port + "/v1";

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон каналов прогона и отката (настоящий main.js без окна)");
  await sleep(400);
  const win = windows[0];
  liveWin = win; // дальше каналы зовём от имени ЭТОГО окна

  console.log("\n[1] настоящий main.js сам собрал модуль — и с рабочими зависимостями");
  ok(seen.run === 1, "registerRunIpc вызван main.js " + seen.run + " раз(а)");
  const d = seen.runDeps || {};
  ok(d.fs === fs, "модулю передан настоящий fs");
  ok(typeof d.runAi === "function", "прогон (runAi) пришёл функцией");
  ok(typeof d.loadSettings === "function" && typeof d.normalizeSettings === "function", "настройки пришли функциями");
  ok(typeof d.fetchModels === "function", "список моделей пришёл функцией");
  ok(typeof d.persistUndo === "function" && typeof d.loadPersistedUndo === "function" && typeof d.undoFile === "function", "хранилище отката пришло целиком");
  ok(!!d.live && d.live.mainWindow === win, "окно пришло ЖИВЫМ (то самое окно, что создал main.js)");
  const ox = d.live && Object.getOwnPropertyDescriptor(d.live, "activeRunOrigin");
  ok(!!ox && typeof ox.get === "function" && typeof ox.set === "function", "отметка источника прогона — живой мост с чтением и записью");
  const ur = d.live && Object.getOwnPropertyDescriptor(d.live, "activeRunUndo");
  ok(!!ur && typeof ur.get === "function" && typeof ur.set === "function", "снимки запуска — живой мост с чтением и записью");
  const pa = d.live && Object.getOwnPropertyDescriptor(d.live, "pendingAsk");
  ok(!!pa && typeof pa.get === "function" && typeof pa.set === "function", "ожидание ответа — живой мост с чтением и записью");

  console.log("\n[2] каналы зарегистрированы, имена совпадают с окном и телефоном");
  const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const mobile = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
  for (const ch of ["ai:send", "ai:answer", "ai:stop", "ai:test", "undo:status", "undo:rollback"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
    ok(preload.indexOf('"' + ch + '"') >= 0 || mobile.indexOf('"' + ch + '"') >= 0, "канал " + ch + " объявлен в интерфейсе");
  }

  console.log("\n[3] настоящий прогон: отметки видны в оболочке чужими мостами");
  const saved = await callIpc("settings:set", {
    provider: "openai",
    model: "test-model",
    openaiUrl: providerBase,
    openaiApiKey: "test-key",
    workingDir: work,
    longWork: false,
    agentAutoCommit: false,
    contextMemory: false,
    agentWorkFiles: false,
    sendAllTools: false,
    planMode: false,
  });
  ok(saved && saved.model === "test-model", "настройки приняты: " + (saved && saved.model));

  // Отвечаем на вопрос модели, ПОКА прогон ждёт: askUser держит раунд открытым.
  let runDone = false;
  let answered = 0;
  const answerer = (async () => {
    while (!runDone) {
      await sleep(40);
      const asks = events.filter((e) => e.ev && e.ev.type === "ask");
      while (answered < asks.length) {
        const r = await callIpc("ai:answer", "да, продолжай");
        if (r !== true) console.log("    (ответ на вопрос не принят: " + JSON.stringify(r) + ")");
        answered++;
      }
    }
  })();

  const run = await callIpc("ai:send", [{ role: "user", content: "Поправь файлы" }], { chatId: "chat-live-run-ipc", role: "developer" });
  runDone = true;
  await answerer;
  ok(run && run.ok === true, "настоящий прогон завершился без ошибки: " + JSON.stringify(run && run.error));
  ok(served >= 4, "провайдер получил " + served + " запроса (правка, создание, вопрос, финал)");

  ok(!!seen.toolsDeps && !!seen.toolsDeps.live, "реестр инструментов собрался (чужие мосты доступны)");
  ok(seen.toolsDeps.live.activeRunRole() === "developer", "роль прогона видна в оболочке: " + seen.toolsDeps.live.activeRunRole());
  ok(seen.toolsDeps.live.activeRunChatId() === "chat-live-run-ipc", "чат прогона виден в оболочке: " + seen.toolsDeps.live.activeRunChatId());
  ok(seen.windowDeps.getRunOrigin() === "desktop", "источник прогона помечен как «с ПК»: " + seen.windowDeps.getRunOrigin());
  ok(global.__agentRunning === false, "после прогона агент не считается работающим");

  console.log("\n[4] вопрос человеку и ответ каналом ai:answer посреди прогона");
  const asks = events.filter((e) => e.ev && e.ev.type === "ask").map((e) => e.ev.question);
  ok(asks.length === 1 && asks[0] === "Продолжать работу?", "вопрос модели дошёл до человека дословно: " + JSON.stringify(asks));
  ok(answered === 1, "ответ отправлен каналом ровно один раз: " + answered);
  const idle = await callIpc("ai:answer", "никому");
  ok(idle === false, "после прогона ответ не выдуман: " + JSON.stringify(idle));

  console.log("\n[5] снимки отката: undo:status видит правки, undo:rollback возвращает файлы");
  ok(fs.readFileSync(KEPT, "utf8") === "испорчено агентом", "агент действительно испортил существующий файл");
  ok(fs.existsSync(MADE), "агент действительно создал новый файл");
  const st = await callIpc("undo:status");
  ok(st && st.ok === true, "статус отката отдан окну");
  ok(st.count === 2, "журнал отката из ОБОЛОЧКИ видит обе правки: " + st.count);
  const names = (st.files || []).map((p) => path.basename(p)).sort();
  ok(names.join(",") === "keep.txt,made.txt", "в журнале именно те файлы: " + JSON.stringify(names));

  const rb = await callIpc("undo:rollback");
  ok(rb && rb.ok === true && rb.count === 2, "откат выполнен по обеим правкам: " + JSON.stringify(rb && rb.count));
  ok(fs.readFileSync(KEPT, "utf8") === "прежнее содержимое\nвторая строка", "существующий файл возвращён к прежнему содержимому");
  ok(!fs.existsSync(MADE), "созданный агентом файл удалён");
  ok(!fs.existsSync(path.join(userData, "undo.json")), "израсходованный чекпоинт убран с диска");
  const st2 = await callIpc("undo:status");
  ok(st2.count === 0, "после отката журнал пуст (иначе «Отменить» предлагала бы откатить снова): " + st2.count);

  console.log("\n[6] ai:test: настоящий провайдер и честный отказ");
  const tested = await callIpc("ai:test", {});
  ok(tested && tested.ok === true, "проверка подключения прошла: " + JSON.stringify(tested && tested.message));
  ok(/Найдено моделей: 1/.test(tested.message), "число моделей посчитано: " + tested.message);
  const bad = await callIpc("ai:test", { openaiUrl: "http://127.0.0.1:1/v1" });
  ok(bad && bad.ok === false, "неверный адрес показан как отказ, а не как удача: " + JSON.stringify(bad));
  ok(typeof bad.message === "string" && bad.message.length > 0, "причина отказа видна человеку: " + JSON.stringify(bad.message).slice(0, 120));

  console.log("\n[7] каналов в оболочке не осталось, проводка ниже зависимостей");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(!/ipcMain\.(handle|on)\("ai:/.test(mainSrc), "в main.js не осталось каналов агента");
  ok(!/ipcMain\.(handle|on)\("undo:/.test(mainSrc), "в main.js не осталось каналов отката");
  ok(mainSrc.indexOf("const { runAi } = createRunAi({") < mainSrc.indexOf('require("./run-ipc.js")'), "прогон собран до проводки канала");
  ok(mainSrc.indexOf("const { snapshotFileForUndo, persistUndo, loadPersistedUndo, undoFile } = createUndoStore({") < mainSrc.indexOf('require("./run-ipc.js")'), "хранилище отката собрано до проводки канала");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")), "настройки не легли в папку приложения");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  provider.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

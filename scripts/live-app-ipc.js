"use strict";
/* ─── Живой прогон каналов приложения: история чатов и память диалогов ────────
   Запуск: bun run test:live:app    (node scripts/live-app-ipc.js)

   Зачем отдельный прогон. Наборы (test/chats-ipc.test.js, test/memory-ipc.test.js)
   собирают модули сами и работают с настоящими файлами — но они НЕ проверяют
   главного: что настоящий main.js действительно собирает эти модули на своём
   месте и с рабочими зависимостями. Именно там ошибка тихая: передай в проводку
   undefined или собери модуль раньше хранилища настроек — и история перестанет
   сохраняться, а панель памяти покажет пустоту, хотя окно выглядит живым.

   Здесь модули проверяются по-настоящему:
     [1] main.js грузится в Node с поддельным electron (окна в песочнице нет), и
         перехваченная сборка показывает, ЧТО именно в неё пришло;
     [2] каналы стоят на месте и работают НАСКВОЗЬ через настоящие хранилища:
         история пишется в настоящий chats.json и читается обратно тем же каналом;
     [3] сигнал «перечитай файл» адресован верно: телефон получает, окно на ПК —
         нет (иначе окно сбрасывало бы набранное);
     [4] панель памяти читает настоящий дневник памяток и настоящие настройки;
     [5] ни один канал не пишет в папку приложения: всё уходит в userData;
     [6] проводка стоит ниже своих зависимостей, и в main.js не осталось ни
         одного канала этих областей.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-app-ipc-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-app-ipc-work-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Настройки — на диске: их прочитает настоящий loadSettings() внутри main.js.
fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: work, contextMemory: true, contextMemoryDays: 5 }, null, 2)
);

const handlers = new Map();
const listeners = new Map();
const windows = [];
const sent = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
// Окно той же формы, что настоящее: id и send лежат в webContents, а send окно
// само оборачивает в прокси (события дублируются телефону) — здесь это видно.
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => {
        sent.push({ ch, ev });
        w.webContents.sent.push({ ch, ev });
      },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
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

// Перехватываем сборку обоих модулей: видим, с чем их позвал НАСТОЯЩИЙ main.js.
const seen = { chats: 0, chatsDeps: null, memory: 0, memoryDeps: null };
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
        getVersion: () => "1.5.184",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => listeners.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: stub("Notification"),
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
    };
  }
  const t = String(req);
  if (t.indexOf("chats-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerChatsIpc: (deps) => {
        seen.chats++;
        seen.chatsDeps = deps;
        return real.registerChatsIpc(deps);
      },
    };
  }
  if (t.indexOf("memory-ipc") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      registerMemoryIpc: (deps) => {
        seen.memory++;
        seen.memoryDeps = deps;
        return real.registerMemoryIpc(deps);
      },
    };
  }
  return origin.apply(this, arguments);
};
// Фоновые отказы main.js прогон не роняют. А вот падение САМОГО прогона обязано
// быть громким: иначе «молчаливый ноль» в цепочке тестов выглядел бы успехом.
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 90 секунд");
  process.exit(1);
}, 90000);
watchdog.unref();

(async () => {
  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон каналов приложения (настоящий main.js без окна)");
  await sleep(500);

  const win = windows[0];
  const agentStore = require(path.join(ROOT, "src", "agent-store.js"));
  const chatsFile = path.join(userData, "chats.json");

  console.log("\n[1] настоящий main.js сам собрал оба модуля — и с рабочими зависимостями");
  ok(seen.chats === 1, "registerChatsIpc вызван main.js " + seen.chats + " раз(а)");
  ok(seen.memory === 1, "registerMemoryIpc вызван main.js " + seen.memory + " раз(а)");
  ok(!!seen.chatsDeps && typeof seen.chatsDeps.loadChats === "function", "loadChats пришёл функцией");
  ok(!!seen.chatsDeps && typeof seen.chatsDeps.saveChats === "function", "saveChats пришёл функцией");
  ok(!!seen.chatsDeps && typeof seen.chatsDeps.getWindow === "function", "окно пришло мостом getWindow");
  ok(!!seen.memoryDeps && !!seen.memoryDeps.app && typeof seen.memoryDeps.app.getPath === "function", "app пришёл настоящим объектом");
  ok(!!seen.memoryDeps && typeof seen.memoryDeps.agentStore.contextMemorySave === "function", "agentStore пришёл настоящим модулем");
  ok(!!seen.memoryDeps && typeof seen.memoryDeps.shell.openPath === "function", "shell пришёл настоящим объектом");
  ok(!!seen.memoryDeps && typeof seen.memoryDeps.loadSettings === "function", "настройки пришли функцией чтения");

  console.log("\n[2] каналы на месте и работают насквозь через настоящие хранилища");
  ok(!!handlers.get("chats:load") && !!handlers.get("chats:save"), "каналы истории чатов зарегистрированы");
  ok(typeof listeners.get("chats:saveSync") === "function", "синхронное сохранение зарегистрировано");
  for (const ch of ["memory:stats", "memory:days", "memory:openDir", "memory:clear"]) {
    ok(typeof handlers.get(ch) === "function", "канал " + ch + " зарегистрирован");
  }
  const saved = { chats: [{ id: "live", messages: [{ role: "user", content: "живая запись" }] }] };
  const saveAnswer = await handlers.get("chats:save")({ sender: { id: 0 } }, saved);
  ok(saveAnswer === true, "сохранение ответило true");
  ok(fs.existsSync(chatsFile), "история записалась настоящим хранилищем в " + path.basename(chatsFile));
  const back = await handlers.get("chats:load")();
  ok(!!back && Array.isArray(back.chats) && back.chats.some((c) => c.id === "live"), "тот же канал прочитал запись обратно");
  const syncEvent = { returnValue: false };
  listeners.get("chats:saveSync")(syncEvent, saved);
  ok(syncEvent.returnValue === true, "синхронное сохранение подтвердило запись окну");
  ok(JSON.parse(fs.readFileSync(chatsFile, "utf8")).chats.some((c) => c.id === "live"), "синхронная запись на диске");

  console.log("\n[3] сигнал «перечитай файл» адресован верно");
  sent.length = 0;
  await handlers.get("chats:save")({ sender: { id: 0 } }, saved);
  ok(sent.filter((s) => s.ch === "chats:reload").length === 1, "сохранил телефон — окно получило сигнал");
  sent.length = 0;
  await handlers.get("chats:save")({ sender: { id: win.webContents.id } }, saved);
  ok(sent.filter((s) => s.ch === "chats:reload").length === 0, "сохранило окно — себе сигнал не шлёт");
  ok(!!win && seen.chatsDeps.getWindow() === win, "мост отдаёт то же самое окно, что создал запуск");

  console.log("\n[4] панель памяти читает настоящий дневник и настоящие настройки");
  const stats0 = await handlers.get("memory:stats")();
  ok(stats0.enabled === true, "выключатель памяти из настроек доехал");
  ok(stats0.keepDays === 5, "срок хранения из настроек доехал (было " + stats0.keepDays + ")");
  const put = agentStore.contextMemorySave(userData, { memo: "живая памятка", ts: Date.now(), provider: "live", model: "live", workDir: work });
  ok(put.ok === true, "стенд записал настоящую памятку");
  const stats1 = await handlers.get("memory:stats")();
  ok(stats1.memos >= 1, "сводка увидела памятку: " + stats1.memos);
  const days = await handlers.get("memory:days")();
  ok(days.ok === true && days.days.some((d) => d.date === put.day), "список дней отдал день памятки");
  const open = await handlers.get("memory:openDir")();
  ok(open.ok === true && fs.existsSync(open.dir), "показ папки дневника прошёл и папка существует");
  const cleared = await handlers.get("memory:clear")(null, put.day);
  ok(cleared.ok === true && cleared.removedDays === 1, "очистка дня прошла: " + cleared.message);
  ok(/Удалено дней: 1/.test(cleared.message), "человеку объяснено, что удалено: " + cleared.message);
  ok(!fs.existsSync(path.join(open.dir, put.day)), "день памятки исчез с диска");

  console.log("\n[5] ни один канал не пишет в папку приложения");
  const appFilesAfter = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  ok(appFilesBefore === appFilesAfter, "папка src не изменилась после работы каналов");
  ok(!fs.existsSync(path.join(ROOT, "chats.json")), "история чатов не легла в папку приложения");
  ok(!fs.existsSync(path.join(ROOT, "memory")), "дневник памяток не лег в папку приложения");

  console.log("\n[6] проводка стоит ниже зависимостей, а каналов в main.js не осталось");
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  ok(mainSrc.indexOf("createSettingsStore({") < mainSrc.indexOf("registerChatsIpc("), "модуль чатов собран после хранилища настроек");
  ok(mainSrc.indexOf('require("./agent-store.js")') < mainSrc.indexOf("registerMemoryIpc("), "модуль памяти собран после дневника памяток");
  ok(!/ipcMain\.(handle|on)\("chats:/.test(mainSrc), "в main.js не осталось каналов истории чатов");
  ok(!/ipcMain\.(handle|on)\("memory:/.test(mainSrc), "в main.js не осталось каналов памяти диалогов");
  ok(!/function notifyChatsSaved/.test(mainSrc), "в main.js не осталось тела сигнала «перечитай файл»");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

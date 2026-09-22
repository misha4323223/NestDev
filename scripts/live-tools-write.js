"use strict";
/* ─── Живой прогон инструментов записи и правок (без окна) ────────────────────
   Запуск: bun run test:live:tools-write   (node scripts/live-tools-write.js)

   Зачем этот прогон. Шесть обработчиков записи (createFolder, writeFile, editFile,
   applyPatch, undoEdit, refactorRename) и два их помощника (checkWrittenFile,
   envNoteFor) уехали своим модулем (часть 40, заход 3b). До этого у них был ровно
   один поведенческий сторож — «проверка записанного файла», и тот по тексту.

   Именно этот прогон нашёл настоящий баг: undoEdit БЕЗ path при непустом журнале
   падал с «activeRunUndo is not defined» в строгом режиме (голые имена вместо
   живого моста). Пустой журнал уходил в честный отказ раньше, поэтому баг не
   всплывал ни в наборе, ни у пользователя — пока агент не просил список правок.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно не нужно);
     • настоящий src/tool-registry.js: вызов идёт тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-write.js;
     • настоящий журнал отката (src/undo-store.js) и живые значения main.js;
     • настоящие файлы в temp-папке: их читают writeFile/editFile/applyPatch,
       а undoEdit действительно возвращает прежнее содержимое (сверяется с диска).

   Проверки:
     [1] проводка и честный отказ при пустом журнале отката;
     [2] createFolder — вложенная папка;
     [3] writeFile: создание, перезапись, проверка синтаксиса/JSON, check:false,
         подсказка про окружение (.py), защита самообновления (файл НЕ тронут);
     [4] editFile: точная замена, повтор (occurrence/replaceAll), замена строк
         по номерам, отказы (файл не тронут), защита самообновления;
     [5] applyPatch: настоящий unified diff, снимок отката, битый патч, защита;
     [6] refactorRename: dryRun ничего не меняет, реальная замена считает вхождения;
     [7] undoEdit: список правок без path (ветка найденного бага), откат файла,
         удаление созданного агентом файла, откат на два шага назад.

   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-write-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-write-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const read = (p) => fs.readFileSync(p, "utf8");

function writeSettings(over) {
  const s = Object.assign({ workingDir: work, model: "test-model", provider: "openai" }, over || {});
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Поддельный electron: окно в прогоне не нужно ───────────────────────────
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: { id, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

// ── Перехват: видим, кто кого собрал и с чем ───────────────────────────────
const seenWiring = { write: 0, writeDeps: null, writeLive: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.195", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (/agent-tools-write\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createWriteTools: (deps, live) => {
        seenWiring.write++;
        seenWiring.writeDeps = deps;
        seenWiring.writeLive = live;
        return real.createWriteTools(deps, live);
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seenWiring.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seenWiring.tools = tools;
        return tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seenWiring.api = real.createToolRegistry(deps);
        return seenWiring.api;
      },
      describeToolArgs: real.describeToolArgs,
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 120 секунд");
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон инструментов записи и правок (настоящий main.js, настоящие файлы)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);
  const file = (name) => path.join(work, name);

  console.log("\n[1] проводка: модуль собран один раз, с тем же состоянием и живым мостом");
  ok(seenWiring.write === 1, "createWriteTools вызван " + seenWiring.write + " раз(а)");
  ok(seenWiring.writeDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
  const live = seenWiring.writeLive || {};
  ok(typeof live === "object" && live !== null, "живой мост передан вторым аргументом");
  const names = ["createFolder", "writeFile", "editFile", "applyPatch", "undoEdit", "refactorRename"];
  const missing = names.filter((n) => typeof seenWiring.tools[n] !== "function");
  ok(missing.length === 0, "все шесть инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
  // Журнал отката ещё пуст: честный отказ на пустом журнале (эта ветка была покрыта
  // и раньше — она-то и прятала баг в соседней).
  const emptyUndo = plain(await call("undoEdit", {}));
  ok(/Нет изменений для отката/.test(emptyUndo), "пустой журнал отката честно об этом говорит: " + emptyUndo.slice(0, 60));

  console.log("\n[2] createFolder: вложенная папка");
  const mk = plain(await call("createFolder", { path: file("src/вложенная") }));
  ok(/папка создана/.test(mk), "папка создана: " + mk.slice(0, 80));
  ok(fs.existsSync(file("src/вложенная")), "папка действительно появилась на диске");

  console.log("\n[3] writeFile: создание, проверка, отказы");
  const created = plain(await call("writeFile", { path: file("src/app.js"), content: "const a = 1;\nfunction f() {\n  return a;\n}\n" }));
  ok(/файл создан/.test(created), "файл создан: " + created.split("\n")[0].slice(0, 90));
  // Числа берём с диска, а не зашиваем: проверяем согласованность, а не литерал.
  const appLines = read(file("src/app.js")).split("\n").length;
  ok(new RegExp("\\(" + appLines + " строк, \\d+ символов\\)").test(created), "названы строки и символы файла (" + appLines + "): " + created.split("\n")[0].slice(0, 90));
  ok(/Проверка после записи: ок\./.test(created), "целый JS назван целым");
  ok(/Node\.js|bun/.test(created), "сказано, чем запускать JS");
  ok(read(file("src/app.js")).indexOf("function f") >= 0, "содержимое на диске совпадает с записанным");

  const broken = plain(await call("writeFile", { path: file("src/broken.js"), content: "function f( {\n" }));
  ok(/⚠ Проверка после записи/.test(broken) && /синтаксис/i.test(broken), "сломанный JS назван сломанным: " + broken.split("\n").slice(1).join(" ").slice(0, 80));
  ok(/не запускай/.test(broken) || /почини/i.test(broken), "сказано, что делать со сломанным файлом");

  const badJson = plain(await call("writeFile", { path: file("data.json"), content: '{"a":}' }));
  ok(/JSON не разбирается/.test(badJson), "сломанный JSON пойман: " + badJson.split("\n").slice(1).join(" ").slice(0, 70));

  const unchecked = plain(await call("writeFile", { path: file("src/unchecked.js"), content: "function g( {\n", check: false }));
  ok(!/Проверка после записи/.test(unchecked), "check:false действительно выключает проверку");

  const py = plain(await call("writeFile", { path: file("run.py"), content: "print(1)\n" }));
  ok(/Python 3/.test(py), "для .py сказано про Python: " + py.split("\n").slice(1).join(" ").slice(0, 60));

  // Файл, которого раньше не было: снимок отката для него — null, и undoEdit обязан
  // именно УДАЛИТЬ его (проверяется в [7]). Создаётся тем же инструментом, что у агента.
  const brandNew = plain(await call("writeFile", { path: file("src/созданный.js"), content: "// создано агентом\n" }));
  ok(/файл создан/.test(brandNew) && fs.existsSync(file("src/созданный.js")), "новый файл создан записью: " + brandNew.split("\n")[0].slice(0, 70));

  const again = plain(await call("writeFile", { path: file("src/app.js"), content: "const a = 2;\n" }));
  ok(/файл перезаписан/.test(again), "повторная запись названа перезаписью");
  const noPath = plain(await call("writeFile", {}));
  ok(/укажи path/.test(noPath), "запись без path объяснена");

  // Защита самообновления: подменяем bootstrap.js? Нет — пробуем НАСТОЯЩИЙ путь
  // приложения и сверяем, что файл после отказа не изменился (то есть отказано ДО записи).
  const protectedFile = path.join(ROOT, "src", "bootstrap.js");
  const before = fs.existsSync(protectedFile) ? fs.statSync(protectedFile).mtimeMs : 0;
  const beforeBytes = fs.existsSync(protectedFile) ? fs.statSync(protectedFile).size : 0;
  const refused = plain(await call("writeFile", { path: protectedFile, content: "// подмена\n" }));
  ok(/заблокировано: путь под защитой самообновления/.test(refused), "защита самообновления отказала: " + refused.split("\n")[0].slice(0, 70));
  const after = fs.existsSync(protectedFile) ? fs.statSync(protectedFile).mtimeMs : 0;
  ok(before === after && (fs.existsSync(protectedFile) ? fs.statSync(protectedFile).size : 0) === beforeBytes, "защищённый файл НЕ тронут (отказ был до записи)");

  console.log("\n[4] editFile: замена и отказы");
  fs.writeFileSync(file("src/edit.js"), "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");
  const edit = plain(await call("editFile", { path: file("src/edit.js"), oldText: "const y = 2;", newText: "const y = 22;" }));
  ok(/OK — заменено \(строка 2\)/.test(edit), "точная замена названа строкой: " + edit.slice(0, 70));
  ok(read(file("src/edit.js")).indexOf("const y = 22;") >= 0, "замена дошла до диска");

  fs.writeFileSync(file("src/dup.js"), "нужно();\nещё();\nнужно();\n", "utf8");
  const dupBefore = read(file("src/dup.js"));
  const dup = plain(await call("editFile", { path: file("src/dup.js"), oldText: "нужно();", newText: "готово();" }));
  ok(/встречается 2 раз \(строки: 1, 3\)/.test(dup), "повтор назван строками: " + dup.slice(0, 80));
  ok(read(file("src/dup.js")) === dupBefore, "при неоднозначности файл НЕ тронут");
  const byOcc = plain(await call("editFile", { path: file("src/dup.js"), oldText: "нужно();", newText: "готово();", occurrence: 2 }));
  ok(/OK — заменено/.test(byOcc) && read(file("src/dup.js")).indexOf("ещё();\nготово();") >= 0, "occurrence: 2 заменил именно второе вхождение: " + byOcc.slice(0, 60));
  // replaceAll — на своём файле с ТРЕМЯ одинаковыми вхождениями (в src/dup.js после
  // проверки occurrence их осталось одно: проверка «ждала два» ничего не измеряла).
  fs.writeFileSync(file("src/all.js"), "dup();\ndup();\ndup();\n", "utf8");
  const all = plain(await call("editFile", { path: file("src/all.js"), oldText: "dup();", newText: "ok();", replaceAll: true }));
  ok(/вхождений: 3/.test(all) && read(file("src/all.js")).indexOf("dup();") < 0, "replaceAll заменил все три: " + all.slice(0, 60));

  fs.writeFileSync(file("src/lines.js"), "первая\nвторая\nтретья\nчетвёртая\n", "utf8");
  const range = plain(await call("editFile", { path: file("src/lines.js"), startLine: 2, endLine: 3, newText: "НОВАЯ" }));
  ok(/заменены строки 2–3/.test(range), "замена по номерам названа: " + range.slice(0, 70));
  ok(read(file("src/lines.js")) === "первая\nНОВАЯ\nчетвёртая\n", "файл стал ровно тем, что ожидалось: " + JSON.stringify(read(file("src/lines.js"))));
  const rangeOver = plain(await call("editFile", { path: file("src/lines.js"), startLine: 99, newText: "нет" }));
  ok(/больше числа строк файла/.test(rangeOver), "выход за конец файла объяснён: " + rangeOver.slice(0, 70));
  const noArgs = plain(await call("editFile", { path: file("src/lines.js") }));
  ok(/укажи oldText/.test(noArgs), "без oldText и startLine объяснено, что делать");
  const notFound = plain(await call("editFile", { path: file("src/lines.js"), oldText: "такого текста нет", newText: "x" }));
  ok(/фрагмент для замены не найден/.test(notFound), "ненайденный фрагмент объяснён: " + notFound.slice(0, 70));
  const noFileEdit = plain(await call("editFile", { path: file("нет-такого.js"), oldText: "a", newText: "b" }));
  ok(/файл не найден/.test(noFileEdit), "правка отсутствующего файла объяснена");
  const protectedEdit = plain(await call("editFile", { path: path.join(ROOT, "src", "ota.js"), oldText: "a", newText: "b" }));
  ok(/заблокировано: путь под защитой самообновления/.test(protectedEdit), "защита самообновления отказала и в editFile");

  console.log("\n[5] applyPatch: настоящий diff, снимок отката, отказы");
  fs.writeFileSync(file("src/patched.js"), "function one() {\n  return 1;\n}\n", "utf8");
  const patch = [
    "--- a/src/patched.js",
    "+++ b/src/patched.js",
    "@@ -1,3 +1,4 @@",
    " function one() {",
    "   return 1;",
    " }",
    "+// хвост патча",
    "",
  ].join("\n");
  const journalBefore = live.activeRunUndo.length;
  const patched = plain(await call("applyPatch", { patch, basePath: work }));
  ok(!/Ошибка/.test(patched), "патч применён: " + patched.split("\n")[0].slice(0, 80));
  ok(/хвост патча/.test(read(file("src/patched.js"))), "изменение патча на диске");
  ok(live.activeRunUndo.length > journalBefore, "снимок для отката снят ДО правки (журнал вырос: " + journalBefore + " → " + live.activeRunUndo.length + ")");

  const badPatch = ["--- a/src/patched.js", "+++ b/src/patched.js", "@@ -1,3 +1,4 @@", " НЕТ ТАКОЙ СТРОКИ", " ещё одна чужая", " третья", "+добавка", ""].join("\n");
  const badBytes = read(file("src/patched.js"));
  const badRes = plain(await call("applyPatch", { patch: badPatch, basePath: work }));
  ok(/Ошибка применения патча/.test(badRes) && /src\/patched\.js/.test(badRes),
    "битый патч объяснён по файлу: " + badRes.split("\n").slice(0, 2).join(" ").slice(0, 90));
  ok(read(file("src/patched.js")) === badBytes, "при несовпадении контекста файл НЕ тронут");
  const protectedPatch = ["--- a/src/ota.js", "+++ b/src/ota.js", "@@ -1,1 +1,2 @@", " const a = 1;", "+// подмена", ""].join("\n");
  const protRes = plain(await call("applyPatch", { patch: protectedPatch, basePath: ROOT }));
  ok(/защищённый файл самообновления/.test(protRes), "патч на защищённый файл отклонён: " + protRes.split("\n")[0].slice(0, 70));
  const noPatch = plain(await call("applyPatch", {}));
  ok(/укажи patch/.test(noPatch), "пустой патч объяснён");

  console.log("\n[6] refactorRename: dryRun и настоящая замена");
  fs.mkdirSync(file("проект"), { recursive: true });
  fs.writeFileSync(file("проект/a.js"), "function oldName() {}\noldName();\n", "utf8");
  fs.writeFileSync(file("проект/b.js"), "oldName();\n", "utf8");
  const dry = plain(await call("refactorRename", { path: file("проект"), oldName: "oldName", newName: "newName", dryRun: true }));
  ok(/dryRun — ничего не изменено/.test(dry), "dryRun честно говорит, что ничего не изменил");
  ok(/oldName/.test(read(file("проект/a.js"))), "при dryRun файлы действительно НЕ тронуты");
  const renamed = plain(await call("refactorRename", { path: file("проект"), oldName: "oldName", newName: "newName" }));
  ok(/заменено 3 вхожд\./.test(renamed), "замена посчитала вхождения: " + renamed.split("\n")[0].slice(0, 70));
  ok(read(file("проект/a.js")).indexOf("newName") >= 0 && read(file("проект/b.js")).indexOf("newName") >= 0, "замена дошла до обоих файлов");
  const none = plain(await call("refactorRename", { path: file("проект"), oldName: "noSuchName", newName: "x" }));
  ok(/Совпадений «noSuchName» не найдено/.test(none), "отсутствие совпадений названо прямо: " + none.slice(0, 70));
  // Имя-не-идентификатор (кириллица) — отдельная честная ветка, а не поиск.
  const badName = plain(await call("refactorRename", { path: file("проект"), oldName: "нетТакого", newName: "x" }));
  ok(/Ошибка:/.test(badName), "негодное имя объяснено, а не проглочено: " + badName.slice(0, 70));

  console.log("\n[7] undoEdit: список правок, откат, удаление созданного");
  // Ветка, в которой жил настоящий баг: журнал НЕПУСТОЙ (правки выше), path не указан.
  const listRes = plain(await call("undoEdit", {}));
  ok(/Можно откатить/.test(listRes), "список отката отдан, а не «activeRunUndo is not defined»: " + listRes.split("\n")[0].slice(0, 70));
  ok(listRes.indexOf(file("src/edit.js")) >= 0, "в списке назван правленый файл: " + (listRes.split("\n")[1] || "").slice(0, 80));
  ok(/шагов в истории: 2/.test(listRes), "повторы одного файла сведены с числом шагов");

  fs.writeFileSync(file("src/edit.js"), "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");
  const undo = plain(await call("undoEdit", { path: file("src/edit.js") }));
  ok(/OK — файл откачен/.test(undo), "правка откачена: " + undo.slice(0, 80));
  ok(read(file("src/edit.js")).indexOf("const y = 22;") < 0, "на диске прежнее содержимое");

  // Файл, созданный агентом: снимок для него — null, и обвязка прогона (run-strict)
  // снимает его ПЕРЕД вызовом writeFile — сам инструмент снимков не делает (это
  // проверено отдельным набором run-strict). Здесь берём журнал тем же живым сеттером,
  // которым это делает прогон, и смотрим, что undoEdit именно УДАЛЯЕТ такой файл.
  const createdByAgent = file("src/созданный.js");
  ok(fs.existsSync(createdByAgent), "файл, созданный агентом, есть на диске");
  const wasInJournal = live.activeRunUndo.some((u) => u.path === createdByAgent);
  ok(!wasInJournal, "инструмент writeFile снимков не делает — это делает обвязка прогона (run-strict)");
  live.activeRunUndo = live.activeRunUndo.concat([{ path: createdByAgent, content: null }]);
  const deleted = plain(await call("undoEdit", { path: createdByAgent }));
  ok(/файл удалён/.test(deleted) && !fs.existsSync(createdByAgent), "снимок null → откат удаляет файл: " + deleted.slice(0, 70));

  const noSnap = plain(await call("undoEdit", { path: file("никогда-не-правился.txt") }));
  ok(/Нет снимка для отката/.test(noSnap), "файл без снимка объяснён: " + noSnap.slice(0, 70));
  // Два шага подряд по одному файлу — чтобы у отката было ровно два снимка.
  fs.writeFileSync(file("src/twice.js"), "v0\n", "utf8");
  await call("editFile", { path: file("src/twice.js"), oldText: "v0", newText: "v1" });
  await call("editFile", { path: file("src/twice.js"), oldText: "v1", newText: "v2" });
  ok(read(file("src/twice.js")) === "v2\n", "файл дошёл до v2 (подготовка шагов)");
  const steps2 = plain(await call("undoEdit", { path: file("src/twice.js"), steps: 2 }));
  ok(/OK — файл откачен на 2 правки агента назад/.test(steps2), "откат на два шага назад: " + steps2.slice(0, 90));
  ok(read(file("src/twice.js")) === "v0\n", "после двух шагов на диске самое раннее состояние, а не промежуточное: " + JSON.stringify(read(file("src/twice.js"))));

  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки записи и правок пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

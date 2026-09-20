"use strict";

/* ── Снимки отката и чекпоинт правок агента (src/undo-store.js) ────────────────
   Запуск: node test/undo-store.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 8). Это память о правках агента:
   снимок файла ПЕРЕД правкой и журнал последнего запуска на диске (undo.json),
   чтобы «↩ Отменить изменения агента» пережило перезапуск приложения.

   Почему проверки поведенческие, а не «строка на месте»: ошибки тут тихие и
   обидные.
     • Если снимки не вытесняются, долгий прогон копит копии одного файла в памяти
       и в undo.json — приложение пухнет, а человек ничего не замечает.
     • Если снимок несуществующего файла записать пустой строкой вместо null,
       откат «восстановит» пустой файл вместо удаления созданного.
     • Если журнал писался бы копией состояния, откат после перезапуска не нашёл бы
       ничего — кнопка «Отменить» молча пропала бы.
   Поэтому модуль водится по-настоящему: настоящие файлы на диске, настоящий
   undo.json, живая коробка состояния вместо копии. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { createUndoStore } = require(path.join(ROOT, "src", "undo-store.js"));
let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "undo-store.js");
// Единственное прямое чтение main.js — «этого в оболочке больше нет» и мост.
const MAIN_SRC = read("src", "main.js");

let n = 0;
// Своя папка приложения на каждый случай: как отдельный запуск приложения.
function makeStore() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "undo-store-" + ++n + "-"));
  const box = { activeRunUndo: [], lastUndoLog: [] };
  const api = createUndoStore({
    fs,
    path,
    userDataDir: () => userData,
    live: {
      activeRunUndo: () => box.activeRunUndo,
      setActiveRunUndo: (v) => { box.activeRunUndo = v; },
      lastUndoLog: () => box.lastUndoLog,
      setLastUndoLog: (v) => { box.lastUndoLog = v; },
    },
  });
  return { api, box, userData, undoFile: path.join(userData, "undo.json") };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "undo-store-files-"));
const writeFile = (name, content) => {
  const p = path.join(work, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

(async () => {
  console.log("Снимки отката и чекпоинт (src/undo-store.js)");

  await test("снимок существующего файла: содержимое до правки записано", () => {
    const { api, box } = makeStore();
    const p = writeFile("a/one.js", "старое содержимое");
    api.snapshotFileForUndo(p);
    assert.strictEqual(box.activeRunUndo.length, 1, "снимок не попал в состояние запуска");
    assert.strictEqual(box.activeRunUndo[0].path, p, "путь снимка не тот");
    assert.strictEqual(box.activeRunUndo[0].content, "старое содержимое", "содержимое не сохранено");
    assert.ok(typeof box.activeRunUndo[0].ts === "number", "у снимка нет времени");
  });

  await test("снимок несуществующего файла: null — значит «создан агентом, откат = удалить»", () => {
    const { api, box } = makeStore();
    api.snapshotFileForUndo(path.join(work, "ещё-не-создан.js"));
    assert.strictEqual(box.activeRunUndo[0].content, null, "созданный агентом файл помечен не как null");
    // Папка — не файл: снимок делать нечего.
    api.snapshotFileForUndo(work);
    assert.strictEqual(box.activeRunUndo.length, 1, "папка попала в снимки");
    // Мусор на входе не роняет: снимки инструментов идут потоком.
    assert.doesNotThrow(() => api.snapshotFileForUndo(""), "пустой путь уронил снимок");
    assert.doesNotThrow(() => api.snapshotFileForUndo(null), "null уронил снимок");
  });

  await test("вытеснение: на файл остаётся пять последних снимков, старые уходят", () => {
    const { api, box } = makeStore();
    const p = writeFile("b/two.js", "0");
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(p, "версия-" + i);
      api.snapshotFileForUndo(p);
    }
    assert.strictEqual(box.activeRunUndo.length, 5, "снимков файла: " + box.activeRunUndo.length + ", ожидалось 5");
    assert.deepStrictEqual(box.activeRunUndo.map((u) => u.content), ["версия-2", "версия-3", "версия-4", "версия-5", "версия-6"]);
  });

  await test("вытеснение: снимки других файлов не страдают", () => {
    const { api, box } = makeStore();
    const p1 = writeFile("c/first.js", "1");
    const p2 = writeFile("c/second.js", "2");
    api.snapshotFileForUndo(p1);
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(p2, "версия-" + i);
      api.snapshotFileForUndo(p2);
    }
    const forFirst = box.activeRunUndo.filter((u) => u.path === p1);
    const forSecond = box.activeRunUndo.filter((u) => u.path === p2);
    assert.strictEqual(forFirst.length, 1, "снимок другого файла потерялся");
    assert.strictEqual(forSecond.length, 5, "снимков второго файла: " + forSecond.length);
  });

  await test("очень большой файл не копируется: снимка нет", () => {
    const { api, box } = makeStore();
    const p = path.join(work, "huge.bin");
    fs.writeFileSync(p, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    api.snapshotFileForUndo(p);
    assert.strictEqual(box.activeRunUndo.length, 0, "копия файла больше 10 МБ всё-таки сделана");
  });

  await test("журнал: пишется на диск, создаёт папку и читается обратно", () => {
    const { api, box, userData, undoFile } = makeStore();
    assert.strictEqual(fs.existsSync(userData), true);
    box.lastUndoLog = [{ path: "/x/y.js", content: "старое", ts: 1 }];
    api.persistUndo();
    assert.strictEqual(fs.existsSync(undoFile), true, "undo.json не создан");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(undoFile, "utf8")), box.lastUndoLog, "в undo.json не то, что в журнале");
    assert.strictEqual(api.undoFile(), undoFile, "undoFile указывает не туда");

    const second = makeStore();
    assert.strictEqual(second.box.lastUndoLog.length, 0, "новый запуск начал с чужого журнала");
    fs.mkdirSync(second.userData, { recursive: true });
    fs.writeFileSync(second.undoFile, fs.readFileSync(undoFile, "utf8"));
    second.api.loadPersistedUndo();
    assert.deepStrictEqual(second.box.lastUndoLog, box.lastUndoLog, "журнал не поднялся с диска");
  });

  await test("журнал: чужой чекпоинт не перетирает уже загруженный", () => {
    const { api, box, undoFile } = makeStore();
    fs.writeFileSync(undoFile, JSON.stringify([{ path: "/старое.js", content: "x", ts: 1 }]));
    box.lastUndoLog = [{ path: "/свежее.js", content: "y", ts: 2 }];
    api.loadPersistedUndo();
    assert.strictEqual(box.lastUndoLog.length, 1, "журнал размножился");
    assert.strictEqual(box.lastUndoLog[0].path, "/свежее.js", "уже загруженный журнал затёрт файлом");
  });

  await test("журнал: битый или отсутствующий файл чекпоинта не роняет окно", () => {
    const { api, box, undoFile } = makeStore();
    api.loadPersistedUndo(); // файла нет вовсе
    assert.deepStrictEqual(box.lastUndoLog, [], "отсутствие чекпоинта что-то испортило");
    fs.writeFileSync(undoFile, "{ это не json");
    assert.doesNotThrow(() => api.loadPersistedUndo(), "битый JSON уронил загрузку чекпоинта");
    assert.deepStrictEqual(box.lastUndoLog, [], "битый чекпоинт осел в журнале");
    fs.writeFileSync(undoFile, JSON.stringify({ not: "array" }));
    api.loadPersistedUndo();
    assert.deepStrictEqual(box.lastUndoLog, [], "чужой формат чекпоинта принят за журнал");
  });

  await test("мост живой: журнал и снимки меняются в оболочке, а не в копии", () => {
    const { api, box, undoFile } = makeStore();
    const p = writeFile("d/four.js", "текст");
    // Снимок, сделанный модулем, обязан лечь в СОСТОЯНИЕ ОБОЛОЧКИ.
    api.snapshotFileForUndo(p);
    assert.strictEqual(box.activeRunUndo.length, 1, "снимок ушёл в копию, а не в состояние окна");
    // И наоборот: то, что положила оболочка (пусть даже присвоив новый массив),
    // модуль обязан видеть.
    box.activeRunUndo = [{ path: "/положено-окном.js", content: "z", ts: 5 }];
    fs.writeFileSync(p, "другое");
    api.snapshotFileForUndo(p);
    assert.strictEqual(box.activeRunUndo.length, 2, "окно и модуль работают с разными массивами");
    box.lastUndoLog = [{ path: "/журнал-окна.js", content: "", ts: 1 }];
    api.persistUndo();
    assert.strictEqual(JSON.parse(fs.readFileSync(undoFile, "utf8")).length, 1, "журнал, положенный окном, не записан на диск");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте с мостом", () => {
    for (const gone of ["function snapshotFileForUndo(", "function persistUndo(", "function loadPersistedUndo(", "const UNDO_MAX_PER_FILE = 5;"]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createUndoStore \} = require\("\.\/undo-store\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(/activeRunUndo: \(\) => activeRunUndo/.test(MAIN_SRC), "снимки запуска переданы не мостом");
    assert.ok(/setActiveRunUndo: \(v\) => \{/.test(MAIN_SRC), "нет сеттера для снимков запуска (копия «застынет»)");
    assert.ok(/lastUndoLog: \(\) => lastUndoLog/.test(MAIN_SRC), "журнал отката передан не мостом");
    assert.ok(/setLastUndoLog: \(v\) => \{/.test(MAIN_SRC), "нет сеттера для журнала отката");
    assert.ok(/userDataDir: \(\) => app\.getPath\("userData"\)/.test(MAIN_SRC), "путь чекпоинта передан значением, а не функцией");
    for (const keep of ["let activeRunUndo = [];", "let lastUndoLog = [];"]) {
      assert.ok(MAIN_SRC.indexOf(keep) >= 0, "живое значение уехало из оболочки: " + keep);
    }
    // С части 34 каналы отката (undo:status, undo:rollback) и прогон агента (ai:*)
    // живут в src/run-ipc.js: чекпоинт израсходуется именно там, и сторож обязан
    // читать модуль, а не оболочку. В main.js остаётся только проводка.
    const RUN_SRC = read("src", "run-ipc.js");
    for (const goneCh of ['ipcMain.handle("undo:status"', 'ipcMain.handle("undo:rollback"', 'ipcMain.handle("ai:send"']) {
      assert.ok(MAIN_SRC.indexOf(goneCh) < 0, "канал остался в оболочке: " + goneCh);
    }
    assert.ok(RUN_SRC.includes("fs.unlinkSync(undoFile())"), "чекпоинт больше не удаляется после отката");
    assert.ok(/undoFile,/.test(MAIN_SRC), "оболочка перестала отдавать путь чекпоинта прогону");
    assert.ok(MODULE_SRC.includes("UNDO_MAX_PER_FILE"), "правило вытеснения пропало из модуля");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

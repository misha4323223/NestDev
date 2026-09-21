"use strict";

/* ── Память диалогов: каналы панели (src/memory-ipc.js) ──────────────────────
   Запуск: node test/memory-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 29). Каналы кажутся простыми, но у
   них есть места, которые ошибаются тихо:

     • папка дневника лежит в userData приложения — путь обязан считаться в
       бэкенде, иначе окно удалит или покажет не то место;
     • выключенная память обязана отвечать понятным отказом, а не пустым списком:
       иначе настройка «выключено» выглядит как «дневник потерян»;
     • очистка обязана честно считать, сколько дней и памяток удалено, и отличать
       неверную дату от пустой папки.

   Стенд берёт НАСТОЯЩИЙ agent-store (дневник памяток) и настоящие файлы во
   временной папке: подделка не поймала бы ни путь, ни формат дней. Подделан
   только ipcMain, показ папки в системе (shell) и хранилище настроек. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerMemoryIpc } = require(path.join(ROOT, "src", "memory-ipc.js"));
const agentStore = require(path.join(ROOT, "src", "agent-store.js"));

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

const DEFAULTS = { contextMemory: true, contextMemoryDays: 30 };
// Настоящие миссии и пути: зеркало памяток кладётся рядом с проектом (.agent/context),
// и путь рабочей папки обязан считаться тем же кодом, что и в приложении.
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));
const { createPathsGit } = require(path.join(ROOT, "src", "paths-git.js"));
const { agentWorkDir } = createPathsGit({
  fs,
  path,
  os,
  execFile: () => {},
  envFor: () => ({}),
  live: { lastAgentRepoDir: () => null, agentEnv: () => ({}), activeToolCapability: () => null },
});

// ── Стенд: модуль с настоящим дневником в временной userData ─────────────────
function mk(over) {
  const o = over || {};
  const userData = o.userData || fs.mkdtempSync(path.join(os.tmpdir(), "mem-ipc-"));
  const handlers = new Map();
  const opened = [];
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} };
  const settings = o.settings === undefined ? { ...DEFAULTS } : o.settings;
  const shell = {
    openPath: async (dir) => {
      opened.push(dir);
      return o.openError === undefined ? "" : o.openError;
    },
  };
  const memory = registerMemoryIpc({
    ipcMain,
    app: { getPath: (k) => (k === "userData" ? userData : "") },
    fs,
    shell,
    agentStore: o.agentStore || agentStore,
    loadSettings: () => (typeof o.loadSettings === "function" ? o.loadSettings() : settings),
    missionStore: o.missionStore || missionStore,
    agentWorkDir,
  });
  return { handlers, opened, userData, module: memory };
}

// Сколько памяток лежит в дневнике: считаем файлы, а не содержимое.
function countDiary(userData) {
  let n = 0;
  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (/\.json$/.test(e.name)) n++;
    }
  };
  walk(agentStore.contextMemoryDir(userData));
  return n;
}

// Настоящая памятка в дневник: без неё проверки видели бы только пустую папку.
function putMemo(userData, memo) {
  const r = agentStore.contextMemorySave(userData, {
    memo,
    ts: Date.now(),
    provider: "test",
    model: "test-model",
    workDir: userData,
  });
  assert.strictEqual(r.ok, true, "стенд не смог записать памятку: " + r.error);
  return r;
}

(async () => {
  console.log("Память диалогов (каналы панели)");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual(
      [...h.handlers.keys()].sort(),
      ["memory:clear", "memory:days", "memory:openDir", "memory:stats"]
    );
    const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    for (const ch of ["memory:stats", "memory:days", "memory:openDir", "memory:clear"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
  });

  await test("memory:stats на пустом дневнике: ноль дней, срок из настроек", () => {
    const h = mk({ settings: { contextMemory: true, contextMemoryDays: 7 } });
    const st = h.handlers.get("memory:stats")();
    assert.strictEqual(st.days, 0, "в пустом дневнике дни взялись из ниоткуда");
    assert.strictEqual(st.memos, 0);
    assert.strictEqual(st.enabled, true, "выключатель памяти из настроек не доехал");
    assert.strictEqual(st.keepDays, 7, "срок хранения из настроек не доехал");
    assert.strictEqual(st.dir, agentStore.contextMemoryDir(h.userData), "путь дневника не из userData");
  });

  await test("memory:stats видит настоящую памятку и выключенный выключатель", () => {
    const h = mk();
    putMemo(h.userData, "проверка сводки");
    const on = h.handlers.get("memory:stats")();
    assert.strictEqual(on.memos, 1, "записанная памятка не видна в сводке");
    assert.strictEqual(on.days, 1);
    assert.ok(on.bytes > 0, "размер дневника нулевой при непустом дне");

    const off = mk({ userData: h.userData, settings: { contextMemory: false, contextMemoryDays: 0 } });
    const s = off.handlers.get("memory:stats")();
    assert.strictEqual(s.enabled, false, "выключенная память показана включённой");
    assert.strictEqual(s.keepDays, agentStore.CTX_MEMO_DAY_KEEP, "срок по умолчанию не подставлен");
  });

  await test("memory:days при выключенной памяти отвечает понятным отказом", () => {
    const h = mk({ settings: { contextMemory: false } });
    const r = h.handlers.get("memory:days")();
    assert.strictEqual(r.ok, false);
    assert.ok(/выключен/i.test(r.error), "отказ не объясняет причину: " + r.error);
  });

  await test("memory:days при включённой памяти отдаёт дни и каталог", () => {
    const h = mk();
    const put = putMemo(h.userData, "день в списке");
    const r = h.handlers.get("memory:days")();
    assert.strictEqual(r.ok, true, "включённая память не отдала дни: " + r.error);
    assert.strictEqual(r.dir, agentStore.contextMemoryDir(h.userData));
    assert.deepStrictEqual(r.days.map((d) => d.date), [put.day], "день памятки не попал в список");
    assert.strictEqual(r.days[0].count, 1);
  });

  await test("memory:openDir создаёт папку дневника и показывает её системе", async () => {
    const h = mk();
    const r = await h.handlers.get("memory:openDir")();
    assert.strictEqual(r.ok, true, "показ папки не удался: " + r.error);
    assert.strictEqual(r.dir, agentStore.contextMemoryDir(h.userData));
    assert.ok(fs.existsSync(r.dir), "папка дневника не появилась на диске");
    assert.deepStrictEqual(h.opened, [r.dir], "в систему ушёл не тот путь");
  });

  await test("memory:openDir честно сообщает, если система не открыла папку", async () => {
    const h = mk({ openError: "нет обработчика" });
    const r = await h.handlers.get("memory:openDir")();
    assert.strictEqual(r.ok, false, "ошибка показа скрыта от человека");
    assert.strictEqual(r.error, "нет обработчика");
    assert.ok(fs.existsSync(r.dir), "папка обязана быть создана даже при отказе показа");
  });

  await test("memory:clear удаляет один день и считает удалённое", () => {
    const h = mk();
    const put = putMemo(h.userData, "удалить этот день");
    putMemo(h.userData, "и этот тоже");
    const r = h.handlers.get("memory:clear")(null, put.day);
    assert.strictEqual(r.ok, true, "очистка дня не удалась: " + r.error);
    assert.strictEqual(r.removedDays, 1);
    assert.ok(r.removedMemos >= 1, "не посчитаны удалённые памятки: " + r.removedMemos);
    assert.ok(/Удалено дней: 1/.test(r.message), "человеку не сказано, что удалено: " + r.message);
    assert.ok(!fs.existsSync(path.join(agentStore.contextMemoryDir(h.userData), put.day)), "день остался на диске");
  });

  await test("memory:clear без даты чистит весь дневник и объясняет итог", () => {
    const h = mk();
    putMemo(h.userData, "первый день");
    putMemo(h.userData, "второй день");
    const r = h.handlers.get("memory:clear")(null, "");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.removedDays, 1, "пустой вызов обязан пройти по всем дням (день у обеих памяток один)");
    assert.ok(/памяток: \d+/.test(r.message), "в итоге нет числа памяток: " + r.message);
    const after = h.handlers.get("memory:stats")();
    assert.strictEqual(after.memos, 0, "памятки остались после полной очистки");
  });

  await test("memory:clear на неверной дате отвечает отказом, а не «удалено 0»", () => {
    const h = mk();
    const r = h.handlers.get("memory:clear")(null, "31.12.2026");
    assert.strictEqual(r.ok, false, "неверная дата принята как верная");
    assert.ok(/Ошибка:/.test(r.message), "отказ не показан человеку: " + r.message);
    assert.ok(/ГГГГ-ММ-ДД/.test(r.message), "отказ не объясняет формат даты: " + r.message);
  });

  await test("памятка, не изменённая на диске, не трогается каналами чтения", () => {
    const h = mk();
    const put = putMemo(h.userData, "читать, а не менять");
    const file = path.join(agentStore.contextMemoryDir(h.userData), put.day, put.id + ".json");
    const before = fs.readFileSync(file, "utf8");
    h.handlers.get("memory:stats")();
    h.handlers.get("memory:days")();
    assert.strictEqual(fs.readFileSync(file, "utf8"), before, "каналы чтения изменили дневник");
  });

  // ── Памятка при сжатии контекста (saveContextMemo) ────────────────────────────
  // Функция вынесена из оболочки в этот же модуль (этап B, заход 3). У неё ДВА разных
  // условия в одной функции, и главный риск переноса — слить их в одно: зеркало рядом
  // с проектом нужно долгой работе даже при выключенной галочке «Память диалогов».
  await test("памятка при сжатии: дневник И зеркало проекта — каждое по своему условию", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk();
    const seen = [];
    const r = h.module.saveContextMemo(
      { workingDir: work, agentWorkFiles: true, contextMemory: true },
      { ts: Date.now(), text: "памятка живая", provider: "openai", model: "m" },
      (e) => seen.push(e)
    );
    assert.ok(r && r.ok === true, "дневник памяти не пополнился: " + JSON.stringify(r));
    assert.strictEqual(countDiary(h.userData), 1, "в дневнике не ровно одна памятка: " + countDiary(h.userData));
    assert.strictEqual(seen.length, 1, "в чат ушло не одно сообщение: " + JSON.stringify(seen));
    assert.ok(/🧠 Память диалогов: сохранена памятка за \d{4}-\d{2}-\d{2}/.test(seen[0].text || ""), "сообщение не то: " + seen[0].text);
    assert.ok(/памяток за день: 1/.test(seen[0].text || ""), "в сообщении нет числа памяток: " + seen[0].text);
    const mirrorDir = path.join(work, ".agent", "context");
    const files = fs.existsSync(mirrorDir) ? fs.readdirSync(mirrorDir) : [];
    assert.strictEqual(files.length, 1, "зеркало проекта не создано: " + JSON.stringify(files));
    assert.ok(fs.readFileSync(path.join(mirrorDir, files[0]), "utf8").indexOf("памятка живая") >= 0, "в зеркало легла не сама памятка");
  });

  await test("памятка: галочка памяти выключена — зеркало пишется, дневник и чат молчат", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk();
    const seen = [];
    const r = h.module.saveContextMemo(
      { workingDir: work, agentWorkFiles: true, contextMemory: false },
      { ts: Date.now(), text: "памятка без галочки" },
      (e) => seen.push(e)
    );
    assert.strictEqual(r, null, "памятка записана в дневник при выключенной памяти");
    assert.strictEqual(countDiary(h.userData), 0, "дневник пополнился при выключенной памяти");
    assert.strictEqual(seen.length, 0, "в чат ушло сообщение при выключенной памяти: " + JSON.stringify(seen));
    const files = fs.readdirSync(path.join(work, ".agent", "context"));
    assert.strictEqual(files.length, 1, "зеркало проекта не написано — а оно не зависит от галочки: " + JSON.stringify(files));
  });

  await test("памятка: «файлы работы агента» выключены — дневник пишется, зеркала нет", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk();
    const r = h.module.saveContextMemo(
      { workingDir: work, agentWorkFiles: false, contextMemory: true },
      { ts: Date.now(), text: "памятка в дневник" }
    );
    assert.ok(r && r.ok === true, "дневник не пополнился: " + JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(work, ".agent", "context")), "зеркало написано при выключенных файлах работы");
  });

  await test("памятка: пустой текст и пустые настройки — ничего не пишется", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk();
    for (const bad of [
      [{ workingDir: work, agentWorkFiles: true, contextMemory: true }, { ts: Date.now(), text: "   " }],
      [null, { ts: Date.now(), text: "текст" }],
      [{ workingDir: work, contextMemory: true }, null],
    ]) {
      assert.strictEqual(h.module.saveContextMemo(bad[0], bad[1], () => {}), null, "пустой вызов что-то записал: " + JSON.stringify(bad[1]));
    }
    assert.strictEqual(countDiary(h.userData), 0, "пустые вызовы пополнили дневник");
    assert.ok(!fs.existsSync(path.join(work, ".agent", "context")), "пустые вызовы создали зеркало");
  });

  await test("памятка: сломанное зеркало не мешает дневнику", () => {
    // Зеркало — вспомогательный след на диске: если оно не пишется, памятка всё равно
    // должна попасть в дневник, иначе длинная работа потеряет память целиком.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk({ missionStore: { contextMirror: () => { throw new Error("нет .agent"); } } });
    const seen = [];
    const r = h.module.saveContextMemo(
      { workingDir: work, agentWorkFiles: true, contextMemory: true },
      { ts: Date.now(), text: "памятка при сломанном зеркале" },
      (e) => seen.push(e)
    );
    assert.ok(r && r.ok === true, "падение зеркала сорвало запись в дневник: " + JSON.stringify(r));
    assert.strictEqual(seen.length, 1, "сообщение о памятке не ушло: " + JSON.stringify(seen));
  });

  await test("памятка: сломанный дневник — тихий отказ, а прогон продолжается", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mem-work-"));
    const h = mk({ agentStore: Object.assign({}, agentStore, { contextMemorySave: () => { throw new Error("диск занят"); } }) });
    const seen = [];
    const r = h.module.saveContextMemo(
      { workingDir: work, agentWorkFiles: true, contextMemory: true },
      { ts: Date.now(), text: "памятка при сломанном дневнике" },
      (e) => seen.push(e)
    );
    assert.strictEqual(r, null, "отказ дневника вышел наружу значением: " + JSON.stringify(r));
    assert.strictEqual(seen.length, 0, "о неудавшейся памятке сообщено как об успешной");
    // Зеркало пишется ПЕРВЫМ — оно про файлы работы, а не про дневник.
    assert.strictEqual(fs.readdirSync(path.join(work, ".agent", "context")).length, 1, "зеркало не записано до отказа дневника");
  });

  await test("проводка: функции в оболочке нет, прогон берёт её отложенной стрелкой", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const memSrc = fs.readFileSync(path.join(ROOT, "src", "memory-ipc.js"), "utf8");
    assert.ok(!/function saveContextMemo\(/.test(mainSrc), "в оболочке осталась сама функция");
    assert.ok(/function saveContextMemo\(settings, entry, emit\) \{/.test(memSrc), "в модуле памяти нет записи памятки");
    // Модуль памяти собирается НИЖЕ прогона: значение в момент сборки было бы undefined,
    // и длинная работа молча теряла бы память (сжатие случается только на ней).
    assert.ok(
      /saveContextMemo: \(\.\.\.memoArgs\) => memory\.saveContextMemo\(\.\.\.memoArgs\),/.test(mainSrc),
      "прогон получил памятку не отложенным чтением"
    );
    assert.ok(/const memory = registerMemoryIpc\(\{/.test(mainSrc), "модуль памяти не собран в оболочке");
    assert.ok(/const memory = registerMemoryIpc\(\{[^}]*missionStore/.test(mainSrc), "зеркалу не переданы миссии");
    assert.ok(/const memory = registerMemoryIpc\(\{[^}]*agentWorkDir/.test(mainSrc), "зеркалу не передана рабочая папка");
  });

  console.log("\nПамять диалогов: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

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
  registerMemoryIpc({
    ipcMain,
    app: { getPath: (k) => (k === "userData" ? userData : "") },
    fs,
    shell,
    agentStore,
    loadSettings: () => (typeof o.loadSettings === "function" ? o.loadSettings() : settings),
  });
  return { handlers, opened, userData };
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

  console.log("\nПамять диалогов: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

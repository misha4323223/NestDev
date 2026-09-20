"use strict";

/* ── История чатов: каналы окна и сигнал «перечитай файл» (src/chats-ipc.js) ──
   Запуск: node test/chats-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 29). Он держит одну тонкую вещь,
   которая ошибается тихо: сигнал chats:reload остальным клиентам. Если его
   рассылать всем подряд, окно перечитало бы файл прямо во время набора и
   потеряло набранное; если не рассылать — ответ, написанный с телефона,
   появится на ПК только после перезапуска окна. Поэтому проверяем все случаи:

     • сохранило окно на ПК        → сигнала нет;
     • сохранил телефон            → сигнал есть (у него фиктивный sender id = 0);
     • окна нет (телефон один)     → не падаем и сигнал никому не шлём;
     • окно пересоздано после сборки → сигнал идёт в НОВОЕ окно (мост живой).

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js:
   разъехавшееся имя кнопки ломает сохранение истории молча, на одном устройстве. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerChatsIpc } = require(path.join(ROOT, "src", "chats-ipc.js"));

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

// ── Стенд: модуль с поддельным ipcMain и поддельным хранилищем чатов ─────────
// Окно той же формы, что настоящее: id и send лежат в webContents.
function mkWin(id) {
  const sent = [];
  return { sent, webContents: { id, send: (ch, data) => sent.push({ ch, data }) } };
}

function mk(over) {
  const o = over || {};
  const handlers = new Map();
  const listeners = new Map();
  const saved = [];
  let win = o.window === undefined ? mkWin(5) : o.window;

  const ipcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => listeners.set(ch, fn),
  };
  const loadChats = () => (o.loadResult === undefined ? { chats: [{ id: "a", messages: [] }] } : o.loadResult);
  const saveChats = (d) => {
    if (o.saveThrows) throw new Error("диск недоступен");
    saved.push(d);
  };
  const getWindow = () => win;

  registerChatsIpc({ ipcMain, loadChats, saveChats, getWindow });
  return {
    handlers,
    listeners,
    saved,
    signal: () => (win ? win.sent : []),
    setWindow: (w) => {
      win = w;
    },
  };
}

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "chats-ipc.js"), "utf8");

(async () => {
  console.log("История чатов (каналы и сигнал «перечитай файл»)");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual([...h.handlers.keys()].sort(), ["chats:load", "chats:save"]);
    assert.deepStrictEqual([...h.listeners.keys()], ["chats:saveSync"]);
    for (const ch of ["chats:load", "chats:save", "chats:saveSync", "chats:reload"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      if (ch !== "chats:saveSync") assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
  });

  await test("chats:load отдаёт то, что прочитало хранилище", () => {
    const only = { chats: [{ id: "one", messages: [] }] };
    const h = mk({ loadResult: only });
    assert.strictEqual(h.handlers.get("chats:load")(), only);
  });

  await test("chats:save сохраняет данные и отвечает true", () => {
    const h = mk();
    const data = { chats: [{ id: "b", messages: [{ role: "user", content: "привет" }] }] };
    assert.strictEqual(h.handlers.get("chats:save")({ sender: { id: 5 } }, data), true);
    assert.deepStrictEqual(h.saved, [data], "данные не дошли до хранилища");
  });

  await test("сохранило окно на ПК — себе сигнал не шлём", () => {
    const h = mk();
    h.handlers.get("chats:save")({ sender: { id: 5 } }, { chats: [] });
    assert.deepStrictEqual(h.signal(), [], "окно получило сигнал на собственную запись");
  });

  await test("сохранил телефон — сигнал уходит окну", () => {
    const h = mk();
    h.handlers.get("chats:save")({ sender: { id: 0 } }, { chats: [] });
    const sent = h.signal();
    assert.strictEqual(sent.length, 1, "окно не получило сигнал перечитать файл");
    assert.strictEqual(sent[0].ch, "chats:reload");
    assert.ok(sent[0].data && typeof sent[0].data.at === "number", "в сигнале нет времени");
  });

  await test("фиктивный отправитель без id — считаем «не ПК»", () => {
    const h = mk();
    h.handlers.get("chats:save")({}, { chats: [] });
    assert.strictEqual(h.signal().length, 1, "сигнал потерялся на пустом отправителе");
  });

  await test("чужое окно (не наше) сигнал получает", () => {
    const h = mk();
    h.handlers.get("chats:save")({ sender: { id: 9 } }, { chats: [] });
    assert.strictEqual(h.signal().length, 1, "сигнал не ушёл при сохранении из другого окна");
  });

  await test("окна нет — не падаем и никому не шлём", () => {
    const h = mk({ window: null });
    assert.doesNotThrow(() => h.handlers.get("chats:save")({ sender: { id: 0 } }, { chats: [] }));
    assert.deepStrictEqual(h.signal(), []);
  });

  await test("окно пересоздано после сборки — сигнал идёт в новое (мост живой)", () => {
    const h = mk();
    const fresh = mkWin(77);
    h.setWindow(fresh);
    h.handlers.get("chats:save")({ sender: { id: 0 } }, { chats: [] });
    assert.strictEqual(fresh.sent.length, 1, "сигнал ушёл в старое окно (значение взято копией)");
  });

  await test("сохранил телефон с настоящим sender — сигнал уходит (сверка по id окна)", () => {
    const h = mk();
    h.handlers.get("chats:save")({ sender: { id: 0 } }, { chats: [] });
    const h2 = mk();
    h2.handlers.get("chats:save")({ sender: { id: 5 } }, { chats: [] });
    assert.strictEqual(h.signal().length + h2.signal().length, 1, "сигнал ушёл не тому клиенту");
  });

  await test("chats:saveSync сохраняет синхронно и отвечает окну", () => {
    const h = mk();
    const e = { returnValue: false };
    h.listeners.get("chats:saveSync")(e, { chats: [{ id: "c" }] });
    assert.deepStrictEqual(h.saved, [{ chats: [{ id: "c" }] }], "синхронная запись потерялась");
    assert.strictEqual(e.returnValue, true, "окно не получило подтверждение");
  });

  await test("chats:saveSync не падает, если диск отказал (окно закрывается)", () => {
    const h = mk({ saveThrows: true });
    const e = { returnValue: false };
    assert.doesNotThrow(() => h.listeners.get("chats:saveSync")(e, { chats: [] }));
    assert.strictEqual(e.returnValue, true, "закрытие окна не должно ждать диск бесконечно");
  });

  await test("модуль не держит окно копией: берёт его функцией", () => {
    assert.ok(/getWindow/.test(MODULE_SRC), "модуль не получает окно мостом");
    assert.ok(!/^let mainWindow/m.test(MODULE_SRC), "модуль завёл своё окно");
    const wiring = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(
      wiring.includes("registerChatsIpc({ ipcMain, loadChats, saveChats, getWindow: () => mainWindow })"),
      "проводка модуля в main.js не передаёт окно живым"
    );
  });

  console.log("\nИстория чатов: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

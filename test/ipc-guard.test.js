"use strict";

/* ── Кто имеет право звать разрушительный канал (src/ipc-guard.js) ────────────
   Запуск: node test/ipc-guard.test.js   (входит в общий `npm test`)

   Зачем свой набор. Ошибка здесь тихая в обе стороны: слишком строгая проверка
   отбирает у человека работающие кнопки (терминал, откат правок, отправка
   сообщения) и выглядит как «приложение сломалось», слишком мягкая — оставляет
   дыру, ради которой модуль и написан. Поэтому проверяются ВСЕ четыре вида
   отправителя по отдельности: окно, телефон, прямой вызов внутри приложения и
   чужой рендерер.

   Вторая часть — обратная проверка проводки: сами по себе правила бесполезны,
   если канал их не зовёт. Набор читает исходники каналов и требует, чтобы у
   каждого разрушительного канала (undo:rollback, fs:delete, term:*, ai:send)
   проверка стояла до работы. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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

const guard = require(path.join(ROOT, "src", "ipc-guard.js"));
const src = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

// Живое окно, как его видит модуль: объект с webContents. Второе окно — чужое:
// у него свой webContents и свой id (внутри приложения их может быть много).
const wc = { id: 11, send() {} };
const win = { isDestroyed: () => false, webContents: wc };

const kind = (event) => guard.senderKind(event, win);
const deny = (event, channel) => guard.denyReason(event, { window: win, channel });

// Консоль главного процесса: отказ обязан быть виден в логе, иначе «почему не
// работает» превращается в загадку. Ошибку подменяем — иначе набор шумит.
function captureConsole(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (s) => lines.push(String(s));
  try {
    const out = fn();
    return { out, lines };
  } finally {
    console.error = orig;
  }
}

(async () => {
  console.log("Кто имеет право звать разрушительный канал (ipc-guard)");

  await test("окно приложения: событие с живым webContents и кадром — можно", () => {
    assert.strictEqual(kind({ sender: wc, senderFrame: { parent: null } }), "desktop");
    assert.strictEqual(deny({ sender: wc, senderFrame: { parent: null } }, "term:input"), null);
  });

  await test("окно приложения по одному id: живые прогоны берут win.webContents.id", () => {
    // Так зовут живые прогоны: они знают только id рендерера. Подделать id из
    // страницы нельзя — событие собирает сам Electron.
    assert.strictEqual(kind({ sender: { id: 11 } }), "desktop");
    assert.strictEqual(kind({ sender: { id: 12 }, senderFrame: { parent: null } }), "foreign");
  });

  await test("телефон: событие с id 0 и вовсе без отправителя — можно", () => {
    // Ровно это событие собирает мобильный мост (src/mobile-bridge.js).
    assert.strictEqual(kind({ sender: { send() {}, id: 0 } }), "mobile");
    assert.strictEqual(deny({ sender: { send() {}, id: 0 } }, "ai:send"), null);
  });

  await test("внутренний вызов: события нет вовсе — можно, это не рендерер", () => {
    // Так зовут наборы, живые прогоны и сам main: события IPC тут не существует,
    // и подделать его отсутствие из страницы тоже нельзя.
    assert.strictEqual(kind(null), "direct");
    assert.strictEqual(kind(undefined), "direct");
    assert.strictEqual(deny(null, "fs:delete"), null);
  });

  await test("чужой рендерер: свой webContents или подрамник — отказ с внятным текстом", () => {
    const cases = [
      { sender: { id: 77, send() {} }, senderFrame: { parent: null } }, // второе окно внутри приложения
      { sender: wc, senderFrame: { parent: {} } }, // подрамник нашего же окна
      { sender: { id: 77, send() {} } }, // без кадра, но и не наше окно
    ];
    for (const ev of cases) {
      assert.strictEqual(kind(ev), "foreign", "чужой отправитель принят за своего: " + JSON.stringify(ev));
      const { out, lines } = captureConsole(() => deny(ev, "fs:delete"));
      assert.ok(out && out.indexOf("fs:delete") >= 0, "в отказе нет имени канала: " + out);
      assert.ok(/не из окна/.test(out), "отказ не объясняет причину: " + out);
      assert.ok(lines.some((l) => l.indexOf("fs:delete") >= 0), "отказ не попал в консоль главного процесса");
    }
  });

  await test("закрытое окно перестаёт быть своим — старый рендерер не проходит", () => {
    const dead = { isDestroyed: () => true, webContents: wc };
    assert.strictEqual(guard.senderKind({ sender: wc, senderFrame: { parent: null } }, dead), "foreign");
    assert.strictEqual(guard.senderKind({ sender: { id: 11 } }, { webContents: wc }), "desktop", "окно без isDestroyed");
    assert.strictEqual(guard.senderKind({ sender: wc }, null), "foreign", "окна нет — свой не находится");
  });

  await test("каналы действительно спрашивают проверку (обратная проводка)", () => {
    // Разрушительные каналы из разбора (§7 HANDOFF): откат правок, удаление файла,
    // терминал и запуск прогона. Каждый обязан звать проверку до работы, иначе
    // правила модуля никем не используются.
    const run = src("run-ipc.js");
    const files = src("fs-ipc.js");
    const term = src("terminal-panel.js");
    assert.ok(/ipcGuard\.denyReason\(e, \{[^}]*channel: "ai:send"/.test(run), "ai:send без проверки отправителя");
    assert.ok(/ipcGuard\.denyReason\(e, \{[^}]*channel: "undo:rollback"/.test(run), "undo:rollback без проверки отправителя");
    assert.ok(/ipcGuard\.denyReason\(e, \{[^}]*channel: "fs:delete"/.test(files), "fs:delete без проверки отправителя");
    assert.ok(/ipcGuard\.denyReason\(e, \{ window: getWindow\(\), channel \}\)/.test(term), "каналы терминала без проверки отправителя");
    // Проверка обязана стоять ДО разрушительной работы: у терминала — в начале
    // каждого обработчика (deny объявлен до регистрации каналов).
    assert.ok(
      term.indexOf("const deny = (e, channel) =>") < term.indexOf('ipcMain.handle("term:start"'),
      "проверка терминала объявлена после каналов"
    );
    // Имена каналов терминала перечислены ровно те, что объявлены в интерфейсе.
    for (const ch of ["term:start", "term:input", "term:stop", "term:status", "term:complete"]) {
      assert.ok(new RegExp('deny\\(e, "' + ch + '"\\)').test(term), "у канала " + ch + " нет проверки");
    }
  });

  await test("в main.js проводка настоящая: проверка передана модулям, а не создана на месте", () => {
    const main = src("main.js");
    assert.ok(/require\("\.\/ipc-guard\.js"\)/.test(main), "main.js не подключает модуль проверки");
    assert.ok(/^\s*ipcGuard,$/m.test(main), "проверка не передана модулям (нет ipcGuard в депсах)");
    assert.ok(main.indexOf("const ipcGuard = require") < main.indexOf("registerRunIpc({"), "проверка объявлена после сборки модулей");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

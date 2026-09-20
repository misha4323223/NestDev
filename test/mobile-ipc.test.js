"use strict";

/* ── Мобильный доступ: каналы статуса и PIN (src/mobile-ipc.js) ───────────────
   Запуск: node test/mobile-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 30). Ошибается он тихо, ровно в одном
   месте: смена PIN. Новый PIN надо не только сохранить, но и применить к ЖИВОМУ
   мосту (applySettings) — иначе окно показало бы новый PIN, а телефон остался бы
   подключён по старому, и кнопка «сменить PIN» молча ничего не меняла бы.
   Поэтому проверяем связку целиком: настройки прочитаны свежими → PIN записан →
   в мост ушёл ТОТ ЖЕ объект настроек → окну вернулся статус моста.

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerMobileIpc } = require(path.join(ROOT, "src", "mobile-ipc.js"));

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

/* Стенд: настоящий модуль, поддельные хранилище и мост. Настройки лежат в
   переменной стенда — так видно, что модуль читает их в момент вызова. */
function mk(over) {
  const o = over || {};
  const handlers = new Map();
  const listeners = new Map();
  let current = { ...(o.current || { mobileEnabled: false, mobilePin: "111111" }) };
  const saved = [];
  const applied = [];

  const deps = {
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => listeners.set(ch, fn),
    },
    mobileBridge: {
      applied,
      applySettings: (s) => {
        applied.push(s);
        current = { ...current, mobilePin: s.mobilePin };
      },
      status: () => ({ enabled: !!current.mobileEnabled, pin: current.mobilePin, port: 9090 }),
    },
    loadSettings: () => ({ ...current }),
    saveSettings: (s) => {
      saved.push(s);
      current = s;
    },
  };
  registerMobileIpc(deps);
  return {
    handlers,
    listeners,
    saved,
    applied,
    get current() {
      return current;
    },
  };
}

const PRELOAD = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
const MOBILE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "mobile-ipc.js"), "utf8");
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");

(async () => {
  console.log("Мобильный доступ: статус и смена PIN");

  await test("каналы объявлены ровно так, как их зовёт окно и телефон", () => {
    const h = mk();
    assert.deepStrictEqual([...h.handlers.keys()].sort(), ["mobile:pinRegen", "mobile:status"]);
    assert.deepStrictEqual([...h.listeners.keys()], [], "модуль завёл лишние слушатели");
    for (const ch of ["mobile:status", "mobile:pinRegen"]) {
      assert.ok(PRELOAD.includes(`"${ch}"`), "preload.js не знает канал " + ch);
      assert.ok(MOBILE.includes(`"${ch}"`), "mobile-api.js не знает канал " + ch);
    }
  });

  await test("mobile:status отдаёт статус живого моста, а не снимок", () => {
    const h = mk();
    assert.strictEqual(h.handlers.get("mobile:status")().pin, "111111");
    h.handlers.get("mobile:pinRegen")();
    assert.notStrictEqual(h.handlers.get("mobile:status")().pin, "111111", "статус берётся снимком");
  });

  await test("смена PIN: новый PIN записан, применён к мосту и возвращён окну", () => {
    const h = mk();
    const st = h.handlers.get("mobile:pinRegen")();
    assert.strictEqual(h.saved.length, 1, "новый PIN не сохранён");
    assert.ok(/^\d{6}$/.test(String(h.saved[0].mobilePin)), "PIN не шестизначный: " + h.saved[0].mobilePin);
    assert.strictEqual(h.applied.length, 1, "мост не получил новые настройки");
    assert.strictEqual(h.applied[0], h.saved[0], "в мост ушёл не тот объект, что сохранён");
    assert.strictEqual(st.pin, h.saved[0].mobilePin, "окну вернулся чужой PIN");
    assert.strictEqual(h.current.mobilePin, h.saved[0].mobilePin, "PIN не доехал до диска");
  });

  await test("PIN берётся из свежих настроек, а не из копии времени сборки", () => {
    const h = mk({ current: { mobileEnabled: true, mobilePin: "222222" } });
    h.handlers.get("mobile:pinRegen")();
    assert.strictEqual(h.saved[0].mobileEnabled, true, "остальные настройки потеряны при смене PIN");
    assert.strictEqual(h.saved[0].mobilePin, h.applied[0].mobilePin);
  });

  await test("смена PIN не трогает остальные поля настроек", () => {
    const h = mk({ current: { mobileEnabled: true, mobilePin: "333333", model: "qwen3:8b", workingDir: "/proj" } });
    h.handlers.get("mobile:pinRegen")();
    assert.strictEqual(h.saved[0].model, "qwen3:8b", "модель потеряна");
    assert.strictEqual(h.saved[0].workingDir, "/proj", "рабочая папка потеряна");
  });

  await test("модуль без состояния: ничего не подтягивает и не помнит", () => {
    assert.ok(MODULE_SRC.indexOf("require(") === -1, "модуль что-то подтягивает из оболочки");
    assert.ok(!/\blet\b/.test(MODULE_SRC), "модуль завёл собственное изменяемое состояние");
  });

  await test("проводка в main.js: зависимости на месте, каналов в оболочке нет", () => {
    assert.ok(MAIN_SRC.includes('require("./mobile-ipc.js")'), "main.js не собирает модуль мобильного доступа");
    const wiring = MAIN_SRC.slice(MAIN_SRC.indexOf('require("./mobile-ipc.js")'));
    assert.ok(
      wiring.includes("registerMobileIpc({ ipcMain, mobileBridge, loadSettings, saveSettings });"),
      "проводка модуля не передаёт мост и настройки"
    );
    assert.ok(!/ipcMain\.(handle|on)\("mobile:/.test(MAIN_SRC), "в main.js остались мобильные каналы");
  });

  console.log("\nМобильный доступ: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Браузер агента: применение настроек и каналы интерфейса (src/browser-ipc.js) ──
   Запуск: node test/browser-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 26). Он держит две вещи, которые
   ошибаются тихо:

     • единую точку применения браузерных настроек: выключенный профиль обязан
       снимать папку сессий (иначе входы в ВК остаются на диске вопреки настройке),
       а «свой Chrome» — получать порт и папку профиля из настроек;
     • четыре канала, которыми пользуются окно и телефон: имена обязаны совпадать
       с preload.js и mobile-api.js, иначе кнопка в настройках молча перестаёт
       работать на одном из устройств.

   Отдельно проверяется то, ради чего модуль собран выше хранилища настроек:
   настройки читаются В МОМЕНТ ВЫЗОВА (мост live), а не копией при сборке —
   иначе первый же сохранённый профиль остался бы прежним навсегда.

   ipcMain и browserTools подделываются: настоящий browserTools поднял бы Chromium. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerBrowserIpc } = require(path.join(ROOT, "src", "browser-ipc.js"));

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

const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "browser-ipc.js"), "utf8");

// ── Стенд: модуль с поддельным ipcMain, браузером и настройками ──────────────
function mk(over) {
  const o = over || {};
  const calls = { profileDir: [], connectMode: [], cleared: 0, connected: [] };
  const handlers = new Map();
  const settings = o.settings === undefined ? { browserProfile: true } : o.settings;
  const browserTools = {
    setProfileDir: (dir) => {
      if (o.profileThrows) throw new Error("профиль недоступен");
      calls.profileDir.push(dir);
    },
    setConnectMode: (mode) => calls.connectMode.push(mode),
    profilePath: () => (o.profilePath === undefined ? "/userData/browser-profile" : o.profilePath),
    clearProfile: async () => {
      calls.cleared++;
      return o.clearMessage === undefined ? "Профиль очищен." : o.clearMessage;
    },
    connect: async (opts) => {
      calls.connected.push(opts);
      return o.connectMessage === undefined ? "Подключено к Chrome." : o.connectMessage;
    },
    connectInfo: () => (o.connectInfo === undefined ? { connected: true, port: 9222 } : o.connectInfo),
  };
  const app = { getPath: () => o.userData === undefined ? "/userData" : o.userData };
  const live = { loadSettings: () => (typeof o.loadSettings === "function" ? o.loadSettings() : settings) };
  const { applyBrowserSettings } = registerBrowserIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    app,
    fs,
    path,
    browserTools,
    live,
  });
  return { applyBrowserSettings, handlers, calls, settings, browserTools };
}

(async () => {
  // ── Имена каналов ────────────────────────────────────────────────────────
  await test("каналы зарегистрированы ровно те, что зовут preload и телефон", () => {
    const m = mk();
    const names = [...m.handlers.keys()].sort();
    assert.deepStrictEqual(
      names,
      ["browser:clearProfile", "browser:connect", "browser:connectInfo", "browser:profileInfo"],
      "набор каналов модуля разошёлся с интерфейсом: " + names.join(", ")
    );
    // Интерфейс зовёт каналы поимённо: разошлись имена — молча отвалится кнопка.
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const mobile = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    for (const ch of names) {
      assert.ok(preload.includes('"' + ch + '"'), "preload не зовёт канал " + ch);
      assert.ok(mobile.includes('"' + ch + '"'), "телефон не зовёт канал " + ch);
    }
  });

  // ── Единая точка применения настроек ─────────────────────────────────────
  await test("настройки применяются целиком: папка профиля, режим CDP, порт", () => {
    // Порт берём НЕ совпадающий с умолчанием (9222): иначе зашитое в модуль число
    // выглядело бы рабочим, и проверка «порт приходит из настроек» ничего не ловила.
    const m = mk({ settings: { browserProfile: true, browserConnect: true, browserConnectPort: 9333 } });
    m.applyBrowserSettings(m.settings);
    const dir = path.join("/userData", "browser-profile");
    assert.deepStrictEqual(m.calls.profileDir, [dir], "папка профиля не отдана браузеру: " + m.calls.profileDir);
    assert.deepStrictEqual(
      m.calls.connectMode,
      [{ enabled: true, port: 9333, dataDir: dir }],
      "режим «свой Chrome» применён неверно: " + JSON.stringify(m.calls.connectMode)
    );
  });

  await test("выключенный профиль снимает папку сессий, а не оставляет её", () => {
    // Иначе входы в ВК и почту лежали бы на диске вопреки настройке.
    const off = mk({ settings: { browserProfile: false } });
    off.applyBrowserSettings(off.settings);
    assert.deepStrictEqual(off.calls.profileDir, [""], "папка сессий осталась при выключенном профиле: " + off.calls.profileDir);
    assert.strictEqual(off.calls.connectMode[0].enabled, false, "режим CDP включён при выключенном профиле");
    // Профиль включается по умолчанию: настройки может не быть вовсе.
    const fresh = mk({ settings: {} });
    fresh.applyBrowserSettings(fresh.settings);
    assert.deepStrictEqual(fresh.calls.profileDir, [path.join("/userData", "browser-profile")], "профиль не включён по умолчанию");
    // Пустой объект настроек (первый запуск) не должен ронять применение.
    const none = mk({ settings: undefined });
    none.applyBrowserSettings(undefined);
    assert.strictEqual(none.calls.profileDir.length, 1, "применение настроек упало на пустом объекте");
  });

  await test("сбой браузерного модуля не срывает сохранение настроек", () => {
    // applyBrowserSettings зовётся из хранилища настроек: его исключение убило бы
    // сохранение целиком (человек правит почту — а теряется и она).
    const m = mk({ profileThrows: true });
    m.applyBrowserSettings({ browserProfile: true });
    assert.strictEqual(m.calls.profileDir.length, 0, "падение не перехвачено — исключение уйдёт в хранилище");
  });

  // ── Каналы ───────────────────────────────────────────────────────────────
  await test("профиль: существование папки проверяется на диске, а не выдумывается", () => {
    const os2 = require("os");
    const root = fs.mkdtempSync(path.join(os2.tmpdir(), "browser-ipc-"));
    const dir = path.join(root, "browser-profile");
    fs.mkdirSync(dir);
    const here = mk({ profilePath: dir, settings: { browserProfile: true } });
    const found = here.handlers.get("browser:profileInfo")();
    assert.strictEqual(found.exists, true, "существующая папка профиля не найдена: " + JSON.stringify(found));
    assert.strictEqual(found.dir, dir, "канал отдал не ту папку: " + found.dir);
    assert.strictEqual(found.enabled, true, "включённый профиль показан выключенным");
    // Папки нет: путь видно (человеку понятно, где он), но exists честно false.
    const gone = mk({ profilePath: path.join(root, "нет-такой"), settings: { browserProfile: false } });
    const noDir = gone.handlers.get("browser:profileInfo")();
    assert.strictEqual(noDir.exists, false, "несуществующая папка показана существующей");
    assert.strictEqual(noDir.enabled, false, "выключенный профиль показан включённым");
    // Профиль выключен — браузерный модуль пути не знает: пустой путь так и уходит.
    const none = mk({ profilePath: "" });
    const empty = none.handlers.get("browser:profileInfo")();
    assert.strictEqual(empty.dir, "", "пустой путь ушёл выдуманным: " + JSON.stringify(empty));
    assert.strictEqual(empty.exists, false, "пустой путь показан существующей папкой");
  });

  await test("очистка профиля: отказ браузера видит человек, а не только консоль", async () => {
    const ok = mk();
    const okRes = await ok.handlers.get("browser:clearProfile")();
    assert.strictEqual(okRes.ok, true, "успешная очистка помечена отказом: " + JSON.stringify(okRes));
    assert.strictEqual(ok.calls.cleared, 1, "браузер не получил просьбу очистить профиль");
    const bad = mk({ clearMessage: "Не удалось удалить папку профиля: занята" });
    const r = await bad.handlers.get("browser:clearProfile")();
    assert.strictEqual(r.ok, false, "отказ очистки показан успехом: " + JSON.stringify(r));
    assert.ok(/занята/.test(r.message), "текст отказа потерялся: " + r.message);
  });

  await test("подключение к своему Chrome: порт из окна, отказ — с текстом и без вранья", () => {
    const m = mk();
    return m
      .handlers.get("browser:connect")(null, { port: 9333 })
      .then((r) => {
        assert.deepStrictEqual(m.calls.connected, [{ port: 9333 }], "опции подключения не доехали: " + JSON.stringify(m.calls.connected));
        assert.strictEqual(r.ok, true, "успешное подключение помечено отказом: " + JSON.stringify(r));
        assert.deepStrictEqual(r.info, { connected: true, port: 9222 }, "сведения о подключении потерялись: " + JSON.stringify(r.info));
        const bad = mk({ connectMessage: "Ошибка: Chrome не отвечает на порту 9222" });
        return bad.handlers.get("browser:connect")(null, undefined);
      })
      .then((r) => {
        assert.strictEqual(r.ok, false, "отказ подключения показан успехом: " + JSON.stringify(r));
        assert.ok(/не отвечает/.test(r.message), "текст отказа потерялся: " + r.message);
      });
  });

  await test("сведения о подключении отдаются как есть, без выдуманных полей", () => {
    const empty = mk({ connectInfo: null });
    assert.strictEqual(empty.handlers.get("browser:connectInfo")(), null, "канал выдумал сведения о подключении");
  });

  // ── Живое чтение настроек ────────────────────────────────────────────────
  await test("настройки читаются в момент вызова: копия не застывает на первых", () => {
    // Хранилище настроек собирается ниже модуля, поэтому внутрь идёт чтение, а не
    // значение: застывшая копия показывала бы прежний профиль после переключения.
    let current = { browserProfile: false };
    const m = mk({ loadSettings: () => current });
    const before = m.handlers.get("browser:profileInfo")();
    assert.strictEqual(before.enabled, false, "первое чтение настроек неверно");
    current = { browserProfile: true };
    const after = m.handlers.get("browser:profileInfo")();
    assert.strictEqual(after.enabled, true, "настройки взяты копией при сборке модуля");
  });

  // ── Границы модуля ───────────────────────────────────────────────────────
  await test("в оболочке этого больше нет, и сборка стоит выше хранилища настроек", () => {
    for (const gone of ["function applyBrowserSettings(s) {", 'ipcMain.handle("browser:profileInfo"', 'ipcMain.handle("browser:connectInfo"']) {
      assert.strictEqual(MAIN_SRC.indexOf(gone), -1, "код браузера остался в main.js: " + gone);
    }
    const wiringAt = MAIN_SRC.indexOf('const { registerBrowserIpc } = require("./browser-ipc.js");');
    const storeAt = MAIN_SRC.indexOf('const { createSettingsStore } = require("./settings-store.js");');
    assert.ok(wiringAt > 0, "main.js не собирает модуль браузера");
    assert.ok(storeAt > 0 && wiringAt < storeAt, "модуль собран ниже хранилища настроек — applyBrowserSettings не доедет");
    const wiring = MAIN_SRC.slice(wiringAt, MAIN_SRC.indexOf("});", wiringAt));
    for (const dep of ["ipcMain,", "app,", "fs,", "path,", "browserTools,", "loadSettings: () => loadSettings()"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep);
    }
    assert.ok(MAIN_SRC.includes("applyBrowserSettings,\n});"), "хранилище настроек больше не применяет профиль браузера");
    // Модуль ничего не достаёт сам: наружу только то, что дали.
    assert.ok(!/require\(|__dirname/.test(MODULE_SRC), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(/return \{ applyBrowserSettings \};/.test(MODULE_SRC), "модуль не отдаёт применение настроек наружу");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

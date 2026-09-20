"use strict";

/* ── Самообновление: каналы OTA и штатный апдейтер (src/ota-ipc.js) ───────────
   Запуск: node test/ota-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 32), поэтому проверки бьют по местам,
   где ошибка ТИХАЯ:

     • ota:check сообщает об отказе обычным значением. Если отказ не превратить в
       {status:"error"}, окно покажет «обновлений нет», человек решит, что код
       актуален, — а проверка упала;
     • ota:reset обязан получить флаг удаления исходников как булево: окно шлёт
       true/false, а телефон может не прислать ничего — и без !!() сброс либо не
       убрал бы папку, либо убрал бы её без просьбы;
     • настройки читаются в МОМЕНТ ВЫЗОВА: в них лежит выключатель self-update, и
       снимок времени сборки оставил бы обновление включённым после выключения;
     • подписка electron-updater не должна остаться без оконной ветки: прогресс
       загрузки виден ТОЛЬКО в заголовке окна, и молчаливое «окна нет» = человек
       не увидит ни обновления, ни ошибки.

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { registerOtaIpc, initAutoUpdater } = require(path.join(ROOT, "src", "ota-ipc.js"));

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
const MODULE_SRC = read("src", "ota-ipc.js");
const MAIN_SRC = read("src", "main.js");
const PRELOAD = read("src", "preload.js");
const MOBILE = read("src", "renderer", "mobile-api.js");

/* Стенд: настоящий модуль, поддельные только «соседи». Сам ota.* подделан нарочно —
   проверяем не его, а то, что каналы передают ему то, что нужно, и что отказ не
   исчезает по дороге. */
function mkOta(over) {
  const o = over || {};
  const handlers = new Map();
  const calls = [];
  let settings = o.settings || { selfUpdate: true, model: "qwen3:8b" };
  const ota = {
    status: (s) => {
      calls.push({ fn: "status", s });
      return { status: "idle", version: "1.0.0", selfUpdate: !!(s && s.selfUpdate) };
    },
    check: async (s) => {
      calls.push({ fn: "check", s });
      if (o.checkThrows) throw new Error("OTA-папка недоступна");
      return { status: "applied", version: "9.9.9" };
    },
    rollback: () => {
      calls.push({ fn: "rollback" });
      return { ok: true };
    },
    openDir: () => {
      calls.push({ fn: "openDir" });
      return { ok: true, dir: "/ota" };
    },
    reset: (removeSource, s) => {
      calls.push({ fn: "reset", removeSource, s });
      return { ok: true, removeSource };
    },
  };
  registerOtaIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    ota,
    loadSettings: () => settings,
  });
  return {
    handlers,
    calls,
    setSettings: (s) => {
      settings = s;
    },
    get settings() {
      return settings;
    },
  };
}

(async () => {
  console.log("Самообновление: каналы OTA и штатный апдейтер");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mkOta();
    assert.deepStrictEqual(
      [...h.handlers.keys()].sort(),
      ["ota:check", "ota:openDir", "ota:reset", "ota:rollback", "ota:status"],
      "состав каналов OTA не тот"
    );
    for (const ch of h.handlers.keys()) {
      assert.ok(PRELOAD.includes(`"${ch}"`) || MOBILE.includes(`"${ch}"`), "канал не объявлен ни в preload.js, ни в mobile-api.js: " + ch);
    }
  });

  await test("настройки читаются в момент вызова: выключатель self-update действует сразу", async () => {
    const h = mkOta({ settings: { selfUpdate: false } });
    await h.handlers.get("ota:status")();
    assert.strictEqual(h.calls[0].s.selfUpdate, false, "статус получил снимок настроек, а не текущие");
    h.setSettings({ selfUpdate: true });
    await h.handlers.get("ota:status")();
    assert.strictEqual(h.calls[1].s.selfUpdate, true, "модуль держит копию настроек времени сборки");
    await h.handlers.get("ota:check")();
    assert.strictEqual(h.calls[2].fn, "check", "ota:check не дошёл до ota.check");
    assert.strictEqual(h.calls[2].s.selfUpdate, true, "проверка обновления пошла без настроек");
  });

  await test("отказ применения — это {status:error} для окна, а не «обновлений нет»", async () => {
    const h = mkOta({ checkThrows: true });
    const r = await h.handlers.get("ota:check")();
    assert.strictEqual(r.status, "error", "падение выдано за успешную проверку: " + JSON.stringify(r));
    assert.ok(/OTA-папка недоступна/.test(r.message), "причина отказа потерялась: " + r.message);
    // Успешный ответ проходит как есть — обёртка ничего не портит.
    const good = mkOta();
    const okRes = await good.handlers.get("ota:check")();
    assert.strictEqual(okRes.status, "applied", "успешное применение испорчено: " + JSON.stringify(okRes));
  });

  await test("ota:reset: флаг удаления исходников — булево, даже если окно прислало мусор", async () => {
    const h = mkOta();
    await h.handlers.get("ota:reset")(null, true);
    assert.strictEqual(h.calls[0].removeSource, true, "просьба удалить папку не дошла");
    await h.handlers.get("ota:reset")(null);
    assert.strictEqual(h.calls[1].removeSource, false, "сброс без флага ушёл как «удалить папку»");
    await h.handlers.get("ota:reset")(null, "нет");
    assert.strictEqual(h.calls[2].removeSource, true, "непустое значение не превращено в булево");
    for (const c of h.calls) assert.strictEqual(typeof c.removeSource, "boolean", "в ota.reset ушёл не булев флаг");
    // Настройки уходят и в сброс: в них выключатель self-update.
    assert.ok(h.calls[0].s && h.calls[0].s.selfUpdate === true, "сброс прошёл без настроек");
  });

  await test("апдейтер: заголовок и события идут в ЖИВОЕ окно, а без окна — молча и без падения", () => {
    const seen = { titles: [], sent: [], downloads: 0, checks: 0, notifications: 0 };
    const listeners = new Map();
    const wins = [];
    const autoUpdater = {
      on: (ev, fn) => listeners.set(ev, fn),
      downloadUpdate: () => {
        seen.downloads++;
        return Promise.resolve();
      },
      checkForUpdates: () => {
        seen.checks++;
        return Promise.resolve();
      },
    };
    class FakeNotification {
      constructor(o) {
        seen.notifications++;
        this.opts = o;
      }
      show() {}
    }
    const win = {
      destroyed: false,
      isDestroyed() {
        return this.destroyed;
      },
      setTitle: (t) => seen.titles.push(t),
      webContents: { send: (ch, ev) => seen.sent.push({ ch, ev }) },
    };
    wins.push(win);
    initAutoUpdater({ autoUpdater, Notification: FakeNotification, getWindow: () => wins[0] });

    assert.strictEqual(autoUpdater.autoDownload, false, "автозагрузка включена без спроса");
    assert.strictEqual(autoUpdater.autoInstallOnAppQuit, true, "установка при закрытии не разрешена");
    for (const ev of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"]) {
      assert.ok(typeof listeners.get(ev) === "function", "нет подписки на " + ev);
    }

    listeners.get("update-available")({ version: "2.0.0" });
    assert.ok(seen.titles.some((t) => /доступно обновление/.test(t)), "заголовок не сообщил об обновлении: " + JSON.stringify(seen.titles));
    assert.ok(seen.sent.some((s) => s.ev && s.ev.type === "update:available" && s.ch === "ai:event"), "событие обновления не ушло окну: " + JSON.stringify(seen.sent));
    assert.strictEqual(seen.downloads, 1, "обновление не начало скачиваться");
    assert.strictEqual(seen.notifications, 1, "человеку не показали вопрос о загрузке");

    listeners.get("download-progress")({ percent: 41.6 });
    assert.ok(seen.titles.some((t) => /загрузка 42%/.test(t)), "процент загрузки не показан: " + JSON.stringify(seen.titles));

    listeners.get("update-downloaded")();
    assert.ok(seen.sent.some((s) => s.ev && s.ev.type === "update:downloaded"), "готовность обновления не ушла окну");
    // Ошибка обязана снять надпись с заголовка, иначе окно навсегда осталось бы
    // с «загрузка…», хотя ничего не грузится.
    listeners.get("download-progress")({ percent: 99 });
    listeners.get("error")(new Error("сеть недоступна"));
    assert.strictEqual(seen.titles[seen.titles.length - 1], "AI Developer Agent", "после ошибки заголовок не сброшен: " + JSON.stringify(seen.titles.slice(-2)));

    // Окно закрылось: события не летят в мёртвый объект, но и падения нет.
    win.destroyed = true;
    const before = seen.titles.length;
    listeners.get("checking-for-update")();
    listeners.get("download-progress")({ percent: 10 });
    listeners.get("update-available")({ version: "3.0.0" });
    assert.strictEqual(seen.titles.length, before, "заголовок закрытого окна всё ещё трогают");
    assert.strictEqual(seen.downloads, 2, "без окна обновление перестало скачиваться");
    assert.strictEqual(seen.notifications, 3, "без окна человек не получил уведомления");
    assert.ok(seen.sent.length >= 1, "события окна потерялись совсем");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["function initAutoUpdater(", "autoUpdater.on(\"checking-for-update\"", "autoUpdater.autoDownload = false", "autoUpdater.checkForUpdates().catch"]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(!/ipcMain\.(handle|on)\("ota:/.test(MAIN_SRC), "в main.js остались каналы OTA");
    assert.ok(MAIN_SRC.includes('require("./ota-ipc.js")'), "модуль не подключён");
    assert.ok(/registerOtaIpc\(\{ ipcMain, ota, loadSettings \}\)/.test(MAIN_SRC), "проводка каналов OTA не та");
    assert.ok(/initAutoUpdater\(\{ autoUpdater, Notification, getWindow: \(\) => mainWindow \}\)/.test(MAIN_SRC), "проводка апдейтера не та");
    // Модуль не держит живого состояния: окно и настройки приходят снаружи.
    assert.ok(/aliveWindow/.test(MODULE_SRC) && /getWindow/.test(MODULE_SRC), "окно больше не берётся функцией");
    assert.ok(!/^\s*(let|const|var)\s+mainWindow\s*=/m.test(MODULE_SRC), "модуль завёл свою копию окна");
  });

  console.log("\nСамообновление: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

"use strict";
/* ─── Живой прогон каналов браузера (src/browser-ipc.js) ──────────────────────
   Запуск: bun run test:live:browser    (node scripts/live-browser-ipc.js)

   Зачем отдельный прогон. Обычный набор (test/browser-ipc.test.js) проверяет
   каналы на подставном browserTools: он ловит логику, но не то, что модуль
   говорит с НАСТОЯЩИМ browser-tools.js и что настройки действительно доходят до
   него. Здесь браузерный модуль настоящий, Chromium не поднимается (профиль и
   режим CDP — это состояние, а не запуск), а диск трогается только во временной
   папке:

     [1] применение настроек: папка профиля и режим «свой Chrome» видны в
         НАСТОЯЩЕМ browserTools (profilePath/connectInfo) — если бы имена методов
         разошлись, канал молча перестал бы настраивать браузер;
     [2] выключенный профиль: сессии снимаются с браузерного модуля;
     [3] профиль на диске: канал видит настоящую папку, а очистка её УДАЛЯЕТ;
     [4] настройки читаются в момент вызова (мост live), а не копией при сборке.

   Рабочее дерево не трогается: всё живёт во временной папке и удаляется за собой. */

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const browserTools = require(path.join(ROOT, "src", "browser-tools.js"));
const { registerBrowserIpc } = require(path.join(ROOT, "src", "browser-ipc.js"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-ipc-live-"));

/* Модуль собирается как в main.js. Настоящие: browserTools, fs, path. Подставные:
   только окно Electron (app.getPath) и чтение настроек — их в Node нет. */
function build(saved) {
  const handlers = new Map();
  let current = saved;
  const state = { asked: 0 };
  const { applyBrowserSettings } = registerBrowserIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    app: { getPath: () => tmp },
    fs,
    path,
    browserTools,
    live: {
      loadSettings: () => {
        state.asked++;
        return current;
      },
    },
  });
  return {
    applyBrowserSettings,
    handlers,
    setSettings: (s) => {
      current = s;
    },
    asked: () => state.asked,
  };
}

(async () => {
  try {
    // ── [1] применение настроек доходит до настоящего browser-tools ─────────
    console.log("\n[1] настройки применяются к настоящему browserTools");
    const live = build({ browserProfile: true, browserConnect: false });
    live.applyBrowserSettings({ browserProfile: true, browserConnect: true, browserConnectPort: 9333 });
    const dir = path.join(tmp, "browser-profile");
    ok(browserTools.profilePath() === dir, "настоящий browser-tools получил папку профиля: " + browserTools.profilePath());
    const info = browserTools.connectInfo();
    ok(info.enabled === true, "режим «свой Chrome» дошёл до браузера: " + JSON.stringify(info));
    ok(info.port === 9333, "порт отладки взят из настроек: " + info.port);
    ok(info.dataDir === dir, "папка CDP-профиля дошла до браузера: " + info.dataDir);

    // ── [2] выключенный профиль снимает сессии ───────────────────────────────
    console.log("\n[2] выключенный профиль снимает папку сессий");
    live.applyBrowserSettings({ browserProfile: false, browserConnect: false });
    ok(browserTools.profilePath() === "", "папка сессий снята при выключенном профиле: " + JSON.stringify(browserTools.profilePath()));
    ok(browserTools.connectInfo().enabled === false, "режим CDP выключён вместе с профилем");

    // ── [3] канал видит настоящую папку и очищает её ────────────────────────
    console.log("\n[3] профиль на диске: канал видит папку и очистка её удаляет");
    live.applyBrowserSettings({ browserProfile: true, browserConnect: false });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Cookies"), "сессии сайтов");
    const before = live.handlers.get("browser:profileInfo")();
    ok(before.exists === true && before.dir === dir, "канал видит настоящую папку профиля: " + JSON.stringify(before));
    ok(before.enabled === true, "включённый профиль показан включённым");
    const cleared = await live.handlers.get("browser:clearProfile")();
    ok(cleared.ok === true, "очистка профиля отчиталась успехом: " + cleared.message);
    ok(!fs.existsSync(dir), "папка профиля удалена с диска");
    const after = live.handlers.get("browser:profileInfo")();
    ok(after.exists === false, "после очистки папка показана несуществующей: " + JSON.stringify(after));

    // ── [4] настройки читаются в момент вызова ───────────────────────────────
    console.log("\n[4] настройки читаются в момент вызова, а не копией при сборке");
    live.setSettings({ browserProfile: false });
    const off = live.handlers.get("browser:profileInfo")();
    live.setSettings({ browserProfile: true });
    const on = live.handlers.get("browser:profileInfo")();
    ok(off.enabled === false && on.enabled === true, "настройки перечитываются на каждом вызове: " + JSON.stringify([off.enabled, on.enabled]));

    // ── Сведения о подключении отдаются настоящим модулем ────────────────────
    console.log("\n[5] сведения о подключении — из настоящего browser-tools");
    const plain = live.handlers.get("browser:connectInfo")();
    ok(plain && plain.port === browserTools.connectInfo().port && plain.active === browserTools.connectInfo().active,
      "канал отдал настоящие сведения о подключении: " + JSON.stringify(plain));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})();

"use strict";
/* ─── Живой прогон окружения агента и OTA ────────────────────────────────────
   Запуск: npm run test:live:tools-env   (node scripts/live-tools-env.js)

   Зачем этот прогон. Шесть обработчиков (envSet, envList, envUnset, otaStatus,
   otaCheck, otaRollback) уехали своим модулем (часть 40, заход 12). Здесь
   проверяется ПРОВОДКА и поведение на живой сборке:

     • модуль собран ОДИН раз, получил тот же deps и ЖИВОЙ мост, а в реестре
       лежат ССЫЛКИ на него (а не копии);
     • выданные переменные действительно сохраняются (settings.json), а их
       ЗНАЧЕНИЯ никогда не попадают в ответ — ни в envList, ни в envSet;
     • выдача (scopes) ограничивает, кому переменная подставляется, и это видно
       в ответе;
     • переменная из настроек Yandex Cloud подставляется автоматически и вручную
       не убирается (иначе агент снял бы себе доступ к облаку);
     • OTA: статус, отказ при выключенной галочке, занятость во время прогона и
       честный отказ отката, когда предыдущей версии нет.

   Наружу ничего не уходит: OTA работает в своей временной папке, наборов там нет,
   поэтому «обновлений нет» — это ответ самого приложения, а не сети. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-env-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-env-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 1).join(" | ").slice(0, 140);

const SECRET = "секрет-значение-42";
const settingsPath = path.join(userData, "settings.json");
const writeSettings = (extra) => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(Object.assign({ workingDir: work, model: "test-model", provider: "openai" }, extra || {}), null, 2)
  );
};
writeSettings({ ycCloudId: "b1g-тест-каталог" });

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const handlers = new Map();
const seen = { env: 0, envDeps: null, envLive: null, envArgs: 0, envTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.206", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
      BrowserWindow: function () {
        return {
          webContents: { id: 22, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
          isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
          on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
          restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
        };
      },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  // Точный перехват по имени файла (ловушка захода 4.1: подстрока «agent-tools»
  // заглатывала соседей по дому и роняла прогоны).
  if (/agent-tools-env\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createEnvTools: function (deps, live) {
        seen.env++;
        seen.envDeps = deps;
        seen.envLive = live;
        seen.envArgs = arguments.length;
        seen.envTools = real.createEnvTools(deps, live);
        return seen.envTools;
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seen.toolDeps = deps;
        seen.tools = real.createAgentTools(deps);
        return seen.tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seen.api = real.createToolRegistry(deps);
        return seen.api;
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

const NAMES = ["envSet", "envList", "envUnset", "otaStatus", "otaCheck", "otaRollback"];

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон окружения агента и OTA (настоящий main.js)");
  await new Promise((r) => setTimeout(r, 400));

  const d = seen.toolDeps || {};
  const executeTool = seen.api && seen.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  const settings = d.loadSettings();
  const call = async (name, args) => {
    try { return plain(await executeTool(name, args || {}, settings)); }
    catch (e) { return "Ошибка вызова " + name + ": " + ((e && e.message) || String(e)); }
  };

  try {
    console.log("\n[1] проводка: модуль собран один раз, с тем же deps и живым мостом");
    ok(seen.env === 1, "createEnvTools вызван " + seen.env + " раз(а)");
    ok(seen.envDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.envArgs === 2, "модулю передан и живой мост (аргументов: " + seen.envArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.envTools || {})[n] !== "function");
    ok(missing.length === 0, "все шесть обработчиков на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.envTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"envSet": async') < 0 && shellSrc.indexOf('"otaCheck": async') < 0, "тела обработчиков не остались в файле-оболочке");
    ok(/const envTools = createEnvTools\(deps, live\);/.test(shellSrc), "сборка модуля на месте — с живым мостом");

    console.log("\n[2] envSet: запись через живой мост, значение не в ответе");
    const badKey = await call("envSet", { key: "2 ПЛОХОЕ", value: SECRET });
    ok(/имя переменной должно быть вида DATABASE_URL/.test(badKey), "плохое имя отвергнуто: " + oneLine(badKey));
    const set = await call("envSet", { key: "DEPLOY_KEY", value: SECRET, scopes: ["git", "terminal"] });
    ok(/OK — переменная DEPLOY_KEY задана/.test(set), "переменная задана: " + oneLine(set));
    ok(set.indexOf(SECRET) < 0, "ЗНАЧЕНИЕ не попало в ответ envSet");
    ok(/Значение получат только названные команды/.test(set), "про выдачу сказано человеку: " + oneLine(set, 3));
    // Записалось ли на самом деле: значения переменных — секреты, они живут НЕ в
    // settings.json, а в secrets.json (зашифрованы, а в plain-node — «plain:» + base64,
    // это описанный откат модуля секретов). Поэтому проверяем ЧТЕНИЕ настоящим
    // загрузчиком настроек: значение обязано пережить перечитывание.
    const reloaded = d.loadSettings();
    ok(!!reloaded.agentEnv && reloaded.agentEnv.DEPLOY_KEY === SECRET, "значение пережило перечитывание настроек");
    const secretsFile = path.join(userData, "secrets.json");
    const secretsText = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile, "utf8") : "";
    ok(!!secretsText && secretsText.indexOf(SECRET) < 0, "в secrets.json значение не лежит открытым текстом (зашифровано или base64)");
    ok(d.live.userAgentEnv() && d.live.userAgentEnv().DEPLOY_KEY === SECRET, "живой мост отдаёт заданное значение");

    console.log("\n[3] envList: имена, длины и выдача — без значений");
    const list = await call("envList", {});
    ok(/DEPLOY_KEY/.test(list), "заданная переменная названа: " + oneLine(list));
    ok(new RegExp("DEPLOY_KEY — установлена \\(" + SECRET.length + " симв\\.\\)").test(list), "названа ДЛИНА значения: " + oneLine(list, 3));
    ok(list.indexOf(SECRET) < 0, "ЗНАЧЕНИЕ не попало в envList");
    ok(/выдача: git, terminal/.test(list), "выдача показана: " + oneLine(list, 4));
    ok(/YC_CLOUD_ID/.test(list) && /\[авто: Yandex Cloud\]/.test(list), "переменная облака помечена как автоматическая: " + oneLine(list, 5));

    console.log("\n[4] envUnset: снятие, отказ для автоматической и честное «не задана»");
    const removeAuto = await call("envUnset", { key: "YC_CLOUD_ID" });
    ok(/подставляется автоматически из настроек Yandex Cloud/.test(removeAuto), "автоматическую переменную вручную не убрать: " + oneLine(removeAuto));
    const unknown = await call("envUnset", { key: "ТАКОЙ_НЕТ" });
    ok(/не задана/.test(unknown), "неизвестная переменная названа честно: " + oneLine(unknown));
    const removed = await call("envUnset", { key: "DEPLOY_KEY" });
    ok(/OK — переменная DEPLOY_KEY удалена/.test(removed), "переменная снята: " + oneLine(removed));
    const after = d.loadSettings();
    ok(!after.agentEnv || !("DEPLOY_KEY" in after.agentEnv), "снятие доехало до сохранённых настроек");
    const listAfter = await call("envList", {});
    ok(listAfter.indexOf("DEPLOY_KEY") < 0, "снятой переменной в списке нет: " + oneLine(listAfter));

    console.log("\n[5] OTA: статус, выключенная галочка, занятость и честный отказ");
    const st = await call("otaStatus", {});
    ok(/OTA-статус:/.test(st) && /Установленная версия кода: /.test(st), "статус собран: " + oneLine(st));
    ok(/Включено: да/.test(st), "галочка по умолчанию включена: " + oneLine(st));
    ok(st.indexOf(work) >= 0 || /Папка OTA: /.test(st), "папка OTA названа: " + oneLine(st, 4));
    writeSettings({ ycCloudId: "b1g-тест-каталог", otaEnabled: false });
    const off = await call("otaStatus", {});
    ok(/Включено: нет/.test(off), "выключенная галочка видна сразу (настройки читаются в момент вызова)");
    const offCheck = await call("otaCheck", {});
    ok(/OTA отключено в настройках/.test(offCheck), "проверка при выключенной галочке названа: " + oneLine(offCheck));
    writeSettings({ ycCloudId: "b1g-тест-каталог", otaEnabled: true });
    global.__agentRunning = true;
    const busy = await call("otaCheck", {});
    ok(/Сейчас идёт работа агента/.test(busy), "во время прогона обновление не применяется: " + oneLine(busy));
    global.__agentRunning = false;
    const ok2 = await call("otaCheck", {});
    ok(/Обновлений нет — код актуален/.test(ok2), "свежих наборов нет — так и сказано: " + oneLine(ok2));
    global.__agentRunning = true;
    const noRollback = await call("otaRollback", {});
    ok(/Нельзя откатываться во время работы агента/.test(noRollback), "откат во время прогона запрещён: " + oneLine(noRollback));
    global.__agentRunning = false;
    const rollback = await call("otaRollback", {});
    ok(/Ошибка отката: |↩ Откат выполнен/.test(rollback), "откат назвал исход: " + oneLine(rollback));

    console.log("\n[6] гигиена прогона");
    ok(fs.readdirSync(work).filter((f) => f !== ".agent").length === 0, "в рабочую папку ничего не написали: " + fs.readdirSync(work).join(", "));
  } finally {
    global.__agentRunning = false;
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки окружения и OTA пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон оборвался: " + ((e && e.stack) || e));
  process.exit(1);
});

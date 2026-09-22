"use strict";
/* ─── Живой прогон паролей сайтов и почты ────────────────────────────────────
   Запуск: npm run test:live:tools-vault   (node scripts/live-tools-vault.js)

   Зачем этот прогон. Пять обработчиков (vaultList, vaultFill, mailSend, mailList,
   mailCode) уехали своим модулем (часть 40, заход 11). Здесь проверяется ПРОВОДКА
   и поведение на живой сборке:

     • модуль собран ОДИН раз, получил тот же объект deps, а в реестре лежат
       ССЫЛКИ на него (а не копии);
     • настройки читаются В МОМЕНТ ВЫЗОВА: правка settings.json между вызовами
       видна инструменту (иначе галочка «Разрешить агенту отправлять письма»
       не действовала бы до перезапуска);
     • ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ: пароль НИКОГДА не попадает в текст ответа —
       проверяется на всех ветках vaultFill и vaultList;
     • отказ браузера («Браузер не запущен…», без слова «Ошибка») назван честно:
       подстановки в форму не было — и ответ не выдаёт её за успех.

   Наружу ничего не уходит: почта отвечает честным отказом (не настроена или
   отправка запрещена), браузер в этом прогоне не запускается. */

const Module = require("module");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-vault-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-vault-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const oneLine = (t, n) => plain(t).split("\n").slice(0, n || 1).join(" | ").slice(0, 140);
const info = (msg) => console.log("  · " + msg);

const PASSWORD = "секрет-пароль-777";
const settingsPath = path.join(userData, "settings.json");
const writeSettings = (extra) => {
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(Object.assign({ workingDir: work, model: "test-model", provider: "openai" }, extra || {}), null, 2)
  );
};
writeSettings({
  sitePasswords: [
    { id: "v1", name: "Спуник", url: "https://sputnik.example/login", login: "misha", password: PASSWORD, note: "домофон" },
    { id: "v2", name: "Госуслуги", url: "https://gosuslugi.ru", login: "79160000000", password: "второй-секрет" },
  ],
});

const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

const handlers = new Map();
const seen = { vault: 0, vaultDeps: null, vaultArgs: 0, vaultTools: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.205", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => String(b) },
      BrowserWindow: function () {
        return {
          webContents: { id: 21, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
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
  // Точный перехват по имени файла: подстрока «agent-tools» заглатывала бы соседей
  // по дому (эта ошибка уже стоила прогонов — см. заход 4.1).
  if (/agent-tools-vault\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createVaultTools: function (deps) {
        seen.vault++;
        seen.vaultDeps = deps;
        seen.vaultArgs = arguments.length;
        seen.vaultTools = real.createVaultTools(deps);
        return seen.vaultTools;
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

const NAMES = ["vaultList", "vaultFill", "mailSend", "mailList", "mailCode"];

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон паролей сайтов и почты (настоящий main.js)");
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
    console.log("\n[1] проводка: модуль собран один раз, с тем же deps, ссылками");
    ok(seen.vault === 1, "createVaultTools вызван " + seen.vault + " раз(а)");
    ok(seen.vaultDeps === d, "модуль получил ТОТ ЖЕ объект deps, что и agent-tools");
    ok(seen.vaultArgs === 1, "модулю не передан лишний мост (аргументов: " + seen.vaultArgs + ")");
    const missing = NAMES.filter((n) => typeof (seen.vaultTools || {})[n] !== "function");
    ok(missing.length === 0, "все пять обработчиков на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
    const copies = NAMES.filter((n) => seen.tools[n] !== seen.vaultTools[n]);
    ok(copies.length === 0, "в реестре именно ссылки на модуль, а не копии" + (copies.length ? ": расходятся " + copies.join(", ") : ""));
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    ok(shellSrc.indexOf('"vaultList": async') < 0 && shellSrc.indexOf('"mailSend": async') < 0 && shellSrc.indexOf('"mailCode": async') < 0,
      "тела обработчиков не остались в файле-оболочке");
    ok(/const vaultTools = createVaultTools\(deps\);/.test(shellSrc), "сборка модуля на месте");

    console.log("\n[2] vaultList: имена и логины есть, ПАРОЛЯ нет");
    const list = await call("vaultList", {});
    ok(/Спуник/.test(list) && /Госуслуги/.test(list), "оба сайта названы: " + oneLine(list));
    ok(/логин: misha/.test(list), "логин назван (он не секрет): " + oneLine(list, 3));
    ok(list.indexOf(PASSWORD) < 0, "ПАРОЛЬ не попал в список");

    console.log("\n[3] настройки читаются в МОМЕНТ ВЫЗОВА, а не при сборке модуля");
    writeSettings({});
    const empty = await call("vaultList", {});
    ok(/Сохранённых паролей нет/.test(empty), "пустой список назван честно: " + oneLine(empty));
    writeSettings({
      sitePasswords: [{ id: "v1", name: "Спуник", url: "https://sputnik.example/login", login: "misha", password: PASSWORD, note: "домофон" }],
    });
    const back = await call("vaultList", {});
    ok(/Спуник/.test(back), "запись вернулась без перезапуска приложения: " + oneLine(back));

    console.log("\n[4] vaultFill: чужой сайт назван, пароль не утекает");
    const unknown = await call("vaultFill", { site: "почта-которой-нет" });
    ok(/нет записи для/.test(unknown) && /Есть: Спуник/.test(unknown), "чужой сайт назван вместе со списком: " + oneLine(unknown, 2));
    ok(unknown.indexOf(PASSWORD) < 0, "ПАРОЛЬ не попал в ответ про чужой сайт");

    const filled = await call("vaultFill", { site: "Спуник" });
    ok(filled.indexOf(PASSWORD) < 0, "ПАРОЛЬ не попал в ответ vaultFill");
    // Браузер в прогоне не запущен: отказ набора («Браузер не запущен…», без слова
    // «Ошибка») обязан быть назван отказом, а не подстановкой (isBrowserFailure).
    ok(!/подставлены в форму|Форма отправлена/.test(filled), "отказ браузера выдан за успешную подстановку: " + oneLine(filled));
    ok(/Не удалось заполнить поле логина/.test(filled) && /Браузер не запущен/.test(filled), "отказ браузера назван как есть: " + oneLine(filled, 2));
    ok(filled.indexOf("misha") < 0, "логин назван в ответе об отказе");
    const half = await call("vaultFill", { site: "пусто" });
    ok(/нет записи для/.test(half), "пустой запрос назван отказом, а не падением: " + oneLine(half));

    console.log("\n[5] почта: сначала разрешение, потом настройки (наружу ничего не уходит)");
    writeSettings({ mailAllowAgentSend: false, mailAddress: "кто-то@пример.рф", mailPassword: "пароль-приложения" });
    const denied = await call("mailSend", { to: "к@пример.рф", subject: "тест", text: "текст" });
    ok(/Отправка писем агентом ЗАПРЕЩЕНА/.test(denied), "запрет отправки назван и объяснён: " + oneLine(denied));
    writeSettings({ mailAllowAgentSend: true });
    const unconfigured = await call("mailSend", { to: "к@пример.рф", subject: "тест", text: "текст" });
    ok(/Почта не настроена/.test(unconfigured), "ненастроенная почта названа: " + oneLine(unconfigured));
    ok(/Настройки/.test(unconfigured) && /Почта/.test(unconfigured), "пользователю сказано, куда идти: " + oneLine(unconfigured));
    const mailList = await call("mailList", { limit: 3 });
    ok(/Почта не настроена/.test(mailList), "mailList без почты не идёт в сеть: " + oneLine(mailList));
    const mailCode = await call("mailCode", {});
    ok(/Почта не настроена/.test(mailCode), "mailCode без почты не идёт в сеть: " + oneLine(mailCode));

    console.log("\n[6] гигиена прогона");
    ok(fs.readdirSync(work).filter((f) => f !== ".agent").length === 0, "в рабочую папку ничего не написали: " + fs.readdirSync(work).join(", "));
    const secrets = fs.existsSync(path.join(userData, "secrets.json"));
    ok(!secrets || fs.readFileSync(path.join(userData, "secrets.json"), "utf8").indexOf("пароль-приложения") < 0,
      "пароль почты не лёг открытым текстом в secrets.json");
  } finally {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }

  console.log(fail ? "\n❌ Провалено: " + pass + " ✅ / " + fail + " ❌" : "\n✅ Все живые проверки паролей и почты пройдены: " + pass + " ✅ / 0 ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон оборвался: " + ((e && e.stack) || e));
  process.exit(1);
});

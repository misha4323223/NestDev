"use strict";
/* ─── Живой прогон облачных инструментов агента (без окна) ───────────────────
   Запуск: bun run test:live:tools-cloud    (node scripts/live-tools-cloud.js)

   Зачем этот прогон. Облачные инструменты (ycStatus/ycList/ycCreate/ycCosts/
   ycDelete/ycDeploy/ycContainer/ycLogs/ycInstall) до сих пор проверялись ТОЛЬКО
   по тексту: наборы искали строки в исходнике, поведенческого прогона не было
   ни у одного из них. Пока код лежал в agent-tools.js, это выглядело терпимо;
   после того как девять обработчиков уехали своим модулем (часть 40, заход 1),
   «проверено по тексту» означает ровно одно: если перенос потеряет ветку, набор
   этого не увидит.

   Что здесь поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron` — окно в прогоне не нужно);
     • настоящий src/tool-registry.js, то есть вызов идёт тем же путём, что у агента:
       политика → назначение → обработчик → текст ответа;
     • настоящий src/agent-tools.js и его новый модуль src/agent-tools-cloud.js;
     • настоящий HTTP: облако отвечает подменённый сервер, а клиент к нему ведёт
       штатная переменная AI_AGENT_YC_BASE (тот же приём, что в test:live:yc).

   Что проверяется:
     [1] проводка: new-модуль собран один раз и получил ТОТ ЖЕ объект состояния,
         что и остальные инструменты (иначе «свежие настройки» перестали бы быть свежими);
     [2] девять инструментов отвечают через НАСТОЯЩИЙ реестр (а не «есть в тексте»);
     [3] ycCosts — тарифы и оценка контейнера без сети;
     [4] отказы без разрешений/согласия — и ни одного запроса в облако при отказе;
     [5] ycCreate с согласием доходит до облака и возвращает человеческий ответ;
     [6] ycList и ycContainer читают НАСТОЯЩИЕ списки по HTTP (зоны, контейнеры,
         ревизии) и показывают активную ревизию и URL;
     [7] настройки читаются в момент вызова: смена каталога видна сразу.

   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-cloud-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-cloud-work-"));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));

// ── Настройки приложения: облако подключено, каталог выбран ────────────────
function writeSettings(over) {
  const s = Object.assign(
    {
      workingDir: work,
      model: "test-model",
      provider: "openai",
      yandexOauthToken: "fake-oauth",
      ycCloudId: "cloud1",
      ycFolderId: "f1",
      ycFolderName: "default",
      ycAllowAgentCreate: false,
      ycAllowAgentDelete: false,
      ycAllowAgentUpdate: false,
    },
    over || {}
  );
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Подменённое облако ─────────────────────────────────────────────────────
const seen = [];
let containerCreated = 0;
function startFakeYc() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (obj, code) => {
        res.writeHead(code || 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const p = u.pathname;
      seen.push(req.method + " " + p + (u.search || ""));
      if (p === "/iam/v1/tokens") return json({ iamToken: "fake-iam", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p === "/dns/v1/zones") {
        return json({ zones: [
          { id: "z1", name: "test-zone", folderId: "f1", createdAt: "2026-09-01T10:00:00Z" },
          { id: "z2", name: "prod-zone", folderId: "f1", createdAt: "2026-09-02T10:00:00Z" },
        ] });
      }
      if (p === "/containers/v1/containers") {
        if (req.method === "POST") {
          containerCreated++;
          return json({ id: "op-cont", done: true });
        }
        return json({ containers: containerCreated
          ? [{ id: "cont1", name: "shop", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", url: "https://shop.example" }]
          : [] });
      }
      // Операции: создание/удаление ресурсов ждут её завершения, и без этого
      // ответа клиент честно ждёт до таймаута (в прогоне — до сторожа).
      if (p.startsWith("/operations/")) return json({ id: p.slice("/operations/".length), done: true, response: { id: "cont1" } });
      if (p === "/containers/v1/containers/cont1") {
        return json({ id: "cont1", name: "shop", status: "ACTIVE", createdAt: "2026-09-01T10:00:00Z", url: "https://shop.example" });
      }
      if (p === "/containers/v1/revisions") {
        return json({ revisions: [
          { id: "rev2", status: "ACTIVE", image: "cr.yandex/crp1/shop:2", createdAt: "2026-09-02T10:00:00Z" },
          { id: "rev1", status: "OBSOLETE", image: "cr.yandex/crp1/shop:1", createdAt: "2026-09-01T10:00:00Z" },
        ] });
      }
      // Прочие сервисы каталога: пустой список — этого достаточно для сводки.
      return json({});
    });
  });
}

// ── Поддельный electron: окно в прогоне не нужно ───────────────────────────
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: { id, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

// ── Перехват: видим, кто кого собрал и куда отдал вызов ────────────────────
const seenWiring = { cloud: 0, toolDeps: null, cloudDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.192", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (/agent-tools(-cloud)?\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    if (/agent-tools-cloud\.js$/.test(t)) {
      return {
        createCloudTools: (deps) => {
          seenWiring.cloud++;
          seenWiring.cloudDeps = deps;
          return real.createCloudTools(deps);
        },
      };
    }
    return {
      createAgentTools: (deps) => {
        seenWiring.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seenWiring.tools = tools;
        return tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seenWiring.api = real.createToolRegistry(deps);
        return seenWiring.api;
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

(async () => {
  const srv = startFakeYc();
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  const ycBase = "http://127.0.0.1:" + port;
  process.env.AI_AGENT_YC_BASE = ycBase;
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон облачных инструментов (настоящий main.js, подменённое облако)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  // Настройки прогона — СНИМОК, сделанный один раз, как в настоящем прогоне
  // (run-ai берёт их при старте). Именно поэтому проверка [7] что-то значит:
  // обработчик обязан читать свежие настройки сам, а не доверять своему аргументу.
  const runSettings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, runSettings);

  console.log("\n[1] проводка: новый модуль собран один раз и с тем же состоянием");
  ok(seenWiring.cloud === 1, "createCloudTools вызван " + seenWiring.cloud + " раз(а)");
  ok(seenWiring.cloudDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools (одна сборка)");
  const cloud = seenWiring.cloudDeps || {};
  for (const name of ["loadSettings", "ycConfig", "yandexCloud", "ycCosts", "applyAgentEnv", "runCloudDeploy"]) {
    ok(typeof cloud[name] !== "undefined", "в модуль пришло " + name);
  }

  console.log("\n[2] инструменты облака отвечают через настоящий реестр");
  const tools = seenWiring.tools || {};
  const cloudNames = ["ycStatus", "ycList", "ycCreate", "ycCosts", "ycDelete", "ycDeploy", "ycContainer", "ycLogs", "ycInstall"];
  const missing = cloudNames.filter((n) => typeof tools[n] !== "function");
  ok(missing.length === 0, "все девять на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));
  const unknown = await call("ycContainer", { action: "overview" });
  ok(!/неизвестный инструмент/.test(plain(unknown)), "реестр знает ycContainer: " + plain(unknown).slice(0, 60));

  console.log("\n[3] ycCosts: тарифы и оценка — без сети");
  const costList = plain(await call("ycCosts", {}));
  ok(/тарифы на/.test(costList) && /serverlessContainers/.test(costList), "список тарифов назван");
  const estimate = plain(await call("ycCosts", { service: "serverlessContainers", memoryMb: 512, cores: 1 }));
  ok(/Стоимость \(ориентир/.test(estimate) && /₽/.test(estimate), "оценка контейнера посчитана: " + estimate.split("\n")[1]);
  const unknownCost = plain(await call("ycCosts", { service: "такого-нет" }));
  ok(/Неизвестный ресурс/.test(unknownCost), "незнакомый ресурс объяснён, а не подставлен молча");

  console.log("\n[4] отказы: без разрешений и без согласия — и ни одного запроса в облако");
  const before = seen.length;
  const del = plain(await call("ycDelete", { service: "dns", id: "z1" }));
  ok(/⛔ Удаление ресурсов .* ЗАПРЕЩЕНО/.test(del), "удаление без чекбокса отклонено");
  const contDeploy = plain(await call("ycContainer", { action: "deploy", container: "shop" }));
  ok(/⛔ Менять контейнеры и деплоить ревизии агенту ЗАПРЕЩЕНО/.test(contDeploy), "ревизия без чекбокса отклонена");
  const deployNoCreate = plain(await call("ycDeploy", { name: "shop" }));
  ok(/⛔ Деплой создаёт ресурсы/.test(deployNoCreate), "деплой без чекбокса создания отклонён");
  ok(seen.length === before, "на отказы в облако не ушло ни одного запроса: " + (seen.length - before));
  writeSettings({ ycAllowAgentCreate: true });
  const pay = plain(await call("ycCreate", { service: "serverlessContainers", name: "shop" }));
  ok(/⛔ Не создаю без согласия/.test(pay), "платное создание ждёт согласия человека");
  ok(seen.length === before, "и на этом отказе в облако тоже ничего не ушло");

  console.log("\n[5] ycCreate с согласием доходит до облака");
  const created = plain(await call("ycCreate", { service: "serverlessContainers", name: "shop", confirm: true }));
  ok(/OK —/.test(created) && /serverlessContainers/.test(created), "создание вернуло человеческий ответ: " + created.slice(0, 80));
  ok(seen.some((s) => /POST \/containers\/v1\/containers/.test(s)), "запрос создания действительно ушёл");

  console.log("\n[6] ycList и ycContainer читают настоящие списки по HTTP");
  const zones = plain(await call("ycList", { service: "dns" }));
  ok(/Cloud DNS/.test(zones) && /всего 2/.test(zones), "зоны посчитаны: " + zones.replace(/\n/g, " | "));
  ok(/test-zone/.test(zones) && /prod-zone/.test(zones) && /\(z1\)/.test(zones), "имена и id зон показаны");
  ok(seen.some((s) => /GET \/dns\/v1\/zones/.test(s)), "список зон запрошен у облака");
  const overview = plain(await call("ycContainer", { action: "overview", container: "shop" }));
  ok(/Контейнер «shop» \(cont1\)/.test(overview), "контейнер найден по имени: " + overview.split("\n")[0]);
  ok(/ACTIVE/.test(overview), "статус и активная ревизия показаны");
  ok(/URL: https:\/\/shop\.example/.test(overview), "адрес контейнера показан");
  ok(/Логи: ycLogs/.test(overview), "подсказка про логи не потеряна");
  const revisions = plain(await call("ycContainer", { action: "revisions", container: "shop" }));
  ok(/rev2/.test(revisions) && /rev1/.test(revisions), "список ревизий показан");

  console.log("\n[7] настройки читаются в момент вызова");
  writeSettings({ ycFolderId: "f2", ycFolderName: "второй" });
  const fresh = plain(await call("ycList", { service: "dns" }));
  ok(/второй/.test(fresh), "в ответе сразу новый каталог: " + fresh.split("\n")[0]);
  // Название каталога в ответе — это ещё не доказательство: важно, что в ОБЛАКО
  // ушёл запрос по новому id, а не по тому, что читался при сборке приложения.
  const zonesRequest = seen.slice().reverse().find((s) => s.indexOf("/dns/v1/zones") >= 0) || "";
  ok(/folderId=f2/.test(zonesRequest), "запрос ушёл по новому каталогу: " + zonesRequest);
  writeSettings({ ycFolderId: "" });
  const noFolder = plain(await call("ycList", { service: "dns" }));
  ok(/Не выбран каталог/.test(noFolder), "без каталога инструмент честно говорит об этом");
  writeSettings({ yandexOauthToken: "" });
  const noAuth = plain(await call("ycStatus", {}));
  ok(/не подключён/.test(noAuth), "без токена инструмент говорит «не подключён»");

  srv.close();
  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки облачных инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

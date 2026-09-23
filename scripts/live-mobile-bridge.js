"use strict";
/* ─── Живой прогон мобильного доступа: настоящий мост и НАСТОЯЩИЙ телефон ─────
   Запуск: bun run test:live:mobile   (node scripts/live-mobile-bridge.js)

   Зачем отдельный прогон. Наборы собирают мост сами (`test/mobile-allow.test.js`,
   `test/mobile-auth.test.js`) или подставляют ему поддельную карту каналов
   (smoke), а интерфейс телефона проверяется в песочнице (`mobile-pair`). Ни один
   из них не проверяет связку целиком: НАСТОЯЩИЙ main.js держит настоящий мост
   поверх настоящей карты обработчиков, а «телефон» — это настоящий WebSocket,
   который входит по одноразовому токену и зовёт настоящие каналы.

   Именно здесь видно то, что в наборах выглядит зелёным по отдельности: что
   список разрешённого стоит перед НАСТОЯЩИМИ обработчиками, что заглушки
   секретов доезжают до телефона сквозь настоящее хранилище настроек, и что
   окно при этом получает настоящие значения.

   Разделы:
     [1] мост главного процесса поднялся на порту из настроек;
     [2] телефон входит одноразовым токеном пары и получает сеанс (без PIN в ответе);
     [3] настройки с телефона: заглушки вместо секретов, служебные поля на месте;
     [4] сохранение с телефона ничего не стирает, а окно видит настоящие значения;
     [5] токен пары одноразовый, сеанс работает при переподключении;
     [6] разрешённый канал доходит до настоящего обработчика, закрытый — нет;
     [7] «сменить PIN» с ПК гасит сеансы и старый код;
     [8] проверка отправителя стоит на настоящей проводке (чужой рендерер и телефон);
     [9] ничего не записано в папку приложения.

   Пишет только во временные папки. */

// Мост теперь поднимается по https с САМОПОДПИСАННЫМ сертификатом (src/bridge-tls.js),
// а телефон ходит по wss. Глобальный WebSocket (undici) не принимает опций TLS, поэтому
// проверку сертификата в этом прогоне отключаем: прогон — про протокол и права доступа,
// а сам сертификат (структура, SAN, подпись, рукопожатие с доверенным корнем)
// проверяется отдельно — test/bridge-tls.test.js. Здесь же важно, что канал идёт по TLS.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const net = require("net");
const tls = require("tls");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-mobile-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-mobile-work-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Свободный порт: мост поднимается на нём, и туда же стучится «телефон».
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const handlers = new Map();
const listeners = new Map();
const windows = [];
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => {
  const w = {
    webContents: {
      id,
      sent: [],
      send: (ch, ev) => { w.webContents.sent.push({ ch, ev }); },
      on: () => {},
      once: () => {},
      openDevTools: () => {},
    },
    isDestroyed: () => false,
    isFocused: () => true,
    isMinimized: () => false,
    on: () => {},
    once: () => {},
    loadFile: () => Promise.resolve(),
    show: () => {},
    focus: () => {},
    restore: () => {},
    maximize: () => {},
    setTitle: () => {},
    close: () => {},
  };
  windows.push(w);
  return w;
};

// Поддельный Electron: окна в песочнице нет, всё остальное — как у настоящего.
const origin = Module._load;
Module._load = function (req) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.190",
        setName: () => {},
        setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: {
        handle: (ch, fn) => handlers.set(ch, fn),
        on: (ch, fn) => listeners.set(ch, fn),
        removeHandler: (ch) => handlers.delete(ch),
      },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: stub("Notification"),
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"),
      globalShortcut: stub("globalShortcut"),
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

// ─── «Телефон»: настоящий WebSocket к настоящему мосту ──────────────────────
function phone(url) {
  const ws = new WebSocket(url);
  const seen = [];
  const waiters = [];
  ws.onmessage = (e) => {
    let m = null;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    seen.push(m);
    for (const w of waiters.slice()) {
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  const wait = (match, ms) =>
    new Promise((resolve, reject) => {
      const hit = seen.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("телефон не дождался ответа: " + JSON.stringify(seen.slice(-3))));
      }, ms || 4000);
    });
  const open = () =>
    new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("сокет к мосту не поднялся: " + url));
    });
  return {
    ws,
    seen,
    open,
    wait,
    send: (o) => ws.send(JSON.stringify(o)),
    // Вход и вызов канала так, как это делает интерфейс телефона.
    auth: (msg) => {
      ws.send(JSON.stringify(Object.assign({ t: "auth" }, msg)));
      return wait((m) => m.t === "auth_ok" || m.t === "auth_err");
    },
    call: async (ch, args) => {
      const id = seen.length + 1;
      ws.send(JSON.stringify({ t: "call", id, ch, args: args || [] }));
      const res = await wait((m) => m.t === "res" && m.id === id);
      if (!res.ok) throw new Error(res.e || "ошибка вызова");
      return res.v;
    },
    close: () => {
      try {
        ws.close();
      } catch {}
    },
  };
}

(async () => {
  const port = await freePort();
  const PIN = "482913";
  const settingsFile = path.join(userData, "settings.json");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ workingDir: work, provider: "ollama", model: "live-model" }, null, 2)
  );

  const appFilesBefore = fs.readdirSync(path.join(ROOT, "src")).sort().join(",");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон мобильного доступа (настоящий main.js и настоящий WebSocket)");
  await sleep(700);

  const win = windows[0];
  const fromWindow = { sender: win.webContents, senderFrame: { parent: null } };
  const fromPhone = { sender: { send() {}, id: 0 } };
  const fromAlien = { sender: { id: 999, send() {} }, senderFrame: { parent: null } };
  const call = (ev, ch, ...args) => handlers.get(ch)(ev, ...args);

  console.log("\n[1] мост главного процесса поднялся на порту из настроек");
  // Включаем мобильный доступ ТЕМ ЖЕ путём, каким это делает человек в настройках:
  // галочка → settings:set → мост получает настройки и поднимается (тот же код, что
  // и при запуске приложения; так прогон не зависит от порядка жизненного цикла).
  const enabled = await call(fromWindow, "settings:set", { mobileEnabled: true, mobilePort: port, mobilePin: PIN });
  ok(enabled.mobileEnabled === true && enabled.mobilePort === port, "настройки мобильного доступа приняты: " + JSON.stringify([enabled.mobileEnabled, enabled.mobilePort]));
  const st = await call(fromWindow, "mobile:status");
  ok(st && st.enabled === true, "мост включён настройками");
  ok(st.port === port, "мост слушает порт из настроек: " + st.port);
  ok(st.running === true, "мост действительно запущен (а не только включён галочкой)");
  ok(st.scheme === "https" && st.tls === true, "мост поднял TLS: " + JSON.stringify({ scheme: st.scheme, tls: st.tls, error: st.tlsError }));
  ok(/^https:\/\//.test(st.url || ""), "адрес для телефона без https: " + st.url);
  // Сертификат лежит рядом с настройками приложения, а не в папке проекта.
  const certFile = path.join(userData, "bridge-tls", "cert.pem");
  ok(fs.existsSync(certFile), "сертификат моста выпущен в userData: " + certFile);
  if (fs.existsSync(certFile)) {
    const peer = await new Promise((resolve, reject) => {
      const s = tls.connect({ host: "127.0.0.1", port: port, ca: [fs.readFileSync(certFile, "utf8")], servername: "localhost", rejectUnauthorized: true }, () => {
        const c = s.getPeerCertificate();
        s.end();
        resolve(c);
      });
      s.on("error", reject);
    });
    ok(!!peer && /NestDev/.test(String(peer.subject && peer.subject.CN)), "телефон получает от моста свой сертификат (рукопожатие с доверенным корнем): " + JSON.stringify(peer && peer.subject));
  }
  ok(typeof st.pair === "string" && st.pair.length >= 16, "ПК получил одноразовый токен пары для QR-кода");
  ok(st.pairUsed === false, "свежий токен пары ещё не использован");
  ok(st.pin === PIN, "статус для ПК содержит PIN (он печатается на экране)");

  console.log("\n[2] телефон входит одноразовым токеном пары и получает сеанс");
  const p1 = phone("wss://127.0.0.1:" + port + "/ws");
  await p1.open();
  const authOk = await p1.auth({ pair: st.pair });
  ok(authOk.t === "auth_ok", "телефон вошёл по токену пары: " + JSON.stringify(authOk.t));
  ok(typeof authOk.session === "string" && authOk.session.length >= 16, "мост выдал сеанс устройства");
  ok(authOk.v && authOk.v.pin === undefined && authOk.v.pair === undefined, "в ответе телефона нет ни PIN, ни токена пары");
  ok(authOk.v && authOk.v.running === true, "телефону отдан рабочий статус моста (адреса, порт)");

  console.log("\n[3] настройки с телефона: заглушки вместо секретов");
  // Секреты задаём из окна: так проверяется и путь «окно → хранилище секретов».
  await call(fromWindow, "settings:set", {
    openaiApiKey: "sk-live-секрет-1234567890",
    githubToken: "ghp-live-секрет",
    agentEnv: { LIVE_TOKEN: "значение-переменной" },
    sitePasswords: [{ id: "v1", name: "банк", login: "я", password: "пароль-сайта" }],
  });
  const phoneSettings = await p1.call("settings:get");
  const mask = require(path.join(ROOT, "src", "secret-mask.js")).MASK;
  ok(phoneSettings.openaiApiKey === mask, "ключ OpenAI уехал телефону заглушкой: " + JSON.stringify(phoneSettings.openaiApiKey));
  ok(phoneSettings.githubToken === mask, "токен GitHub уехал телефону заглушкой");
  ok(phoneSettings.agentEnv.LIVE_TOKEN === mask, "значение переменной агента заменено заглушкой");
  ok(phoneSettings.sitePasswords[0].password === mask, "пароль сайта заменён заглушкой");
  ok(JSON.stringify(phoneSettings).indexOf("sk-live-секрет") < 0, "настоящего ключа в ответе телефону нет");
  ok(phoneSettings.workingDir === work && phoneSettings.model === "live-model", "рабочие поля доехали (иначе на телефоне нечего рисовать)");
  ok(phoneSettings.agentEnv && typeof phoneSettings.agentEnv.LIVE_TOKEN === "string", "имена переменных агента остались");

  console.log("\n[4] сохранение с телефона ничего не стирает, окно видит настоящие значения");
  const fromPhoneSettings = Object.assign({}, phoneSettings, { model: "live-model-phone" });
  await p1.call("settings:set", [fromPhoneSettings]);
  const winSettings = await call(fromWindow, "settings:get");
  ok(winSettings.openaiApiKey === "sk-live-секрет-1234567890", "окно сохранило настоящий ключ");
  ok(winSettings.githubToken === "ghp-live-секрет", "окно сохранило токен GitHub");
  ok(winSettings.agentEnv.LIVE_TOKEN === "значение-переменной", "окно сохранило значение переменной агента");
  ok(winSettings.sitePasswords[0].password === "пароль-сайта", "окно сохранило пароль сайта");
  ok(winSettings.model === "live-model-phone", "правка с телефона сохранилась");
  ok(fs.readFileSync(settingsFile, "utf8").indexOf("sk-live-секрет") < 0, "в settings.json ключа нет (он в хранилище секретов)");
  // И ответ телефону на его же сохранение снова без секретов.
  const answer = await p1.call("settings:get");
  ok(answer.openaiApiKey === mask, "в ответе телефону — снова заглушка");

  console.log("\n[5] токен пары одноразовый, сеанс работает при переподключении");
  const p2 = phone("wss://127.0.0.1:" + port + "/ws");
  await p2.open();
  const stale = await p2.auth({ pair: st.pair });
  ok(stale.t === "auth_err" && stale.badPair === true, "погашенный токен второго устройства не пустил: " + JSON.stringify(stale));
  p2.close();
  const p3 = phone("wss://127.0.0.1:" + port + "/ws");
  await p3.open();
  const again = await p3.auth({ session: authOk.session });
  ok(again.t === "auth_ok", "переподключение по сеансу прошло: " + JSON.stringify(again.t));
  p3.close();

  console.log("\n[6] разрешённый канал доходит до настоящего обработчика, закрытый — нет");
  const repoInfo = await p1.call("git:repoInfo", [work]);
  ok(repoInfo && typeof repoInfo === "object", "разрешённый канал ответил настоящим обработчиком: " + JSON.stringify(repoInfo).slice(0, 80));
  const closed = await new Promise((resolve) => {
    const id = 9001;
    p1.ws.send(JSON.stringify({ t: "call", id, ch: "deploy:run", args: [] }));
    p1.wait((m) => m.t === "res" && m.id === id).then(resolve);
  });
  ok(closed.ok === false, "закрытый канал с телефона не выполнился: " + JSON.stringify(closed));
  ok(/недоступно с телефона/.test(closed.e) && /ПК/.test(closed.e), "отказ закрытого канала объяснён человеку: " + closed.e);
  const closedNative = await new Promise((resolve) => {
    const id = 9002;
    p1.ws.send(JSON.stringify({ t: "call", id, ch: "dialog:pickDir", args: [] }));
    p1.wait((m) => m.t === "res" && m.id === id).then(resolve);
  });
  ok(closedNative.ok === false && /системный диалог/.test(closedNative.e), "нативный диалог с телефона закрыт с объяснением: " + closedNative.e);

  console.log("\n[7] «сменить PIN» с ПК гасит сеансы и старый код");
  const beforePin = st.pin;
  const st2 = await call(fromWindow, "mobile:pinRegen");
  ok(/^\d{6}$/.test(String(st2.pin)) && st2.pin !== beforePin, "PIN сменился: " + st2.pin);
  ok(st2.pair !== st.pair, "токен пары сменился вместе с PIN");
  ok(st2.pairUsed === false, "новый токен ещё не использован");
  const oldSession = phone("wss://127.0.0.1:" + port + "/ws");
  await oldSession.open();
  const deadSession = await oldSession.auth({ session: authOk.session });
  ok(deadSession.t === "auth_err" && deadSession.staleSession === true, "старый сеанс закрыт сменой PIN: " + JSON.stringify(deadSession));
  oldSession.close();
  const oldPair = phone("wss://127.0.0.1:" + port + "/ws");
  await oldPair.open();
  const deadPair = await oldPair.auth({ pair: st.pair });
  ok(deadPair.t === "auth_err", "старый QR-код закрыт сменой PIN");
  oldPair.close();
  const fresh = phone("wss://127.0.0.1:" + port + "/ws");
  await fresh.open();
  const freshOk = await fresh.auth({ pair: st2.pair });
  ok(freshOk.t === "auth_ok", "новый токен пары пускает: " + JSON.stringify(freshOk.t));
  const phoneStatus = await call(fromPhone, "mobile:status");
  ok(phoneStatus.pin === undefined && phoneStatus.pair === undefined, "телефону по каналу не ушёл ни PIN, ни токен пары");
  p1.close();
  fresh.close();

  console.log("\n[8] проверка отправителя стоит на настоящей проводке");
  fs.writeFileSync(path.join(work, "чужое.txt"), "не трогать");
  const alienDelete = await call(fromAlien, "fs:delete", path.join(work, "чужое.txt"));
  ok(alienDelete && alienDelete.ok === false && /не из окна/.test(alienDelete.error), "чужой рендерер получил отказ: " + JSON.stringify(alienDelete.error));
  ok(fs.existsSync(path.join(work, "чужое.txt")), "файл остался на месте");
  const winDelete = await call(fromWindow, "fs:delete", path.join(work, "чужое.txt"));
  ok(winDelete && winDelete.ok === true, "окно удалило файл: " + JSON.stringify(winDelete));
  ok(!fs.existsSync(path.join(work, "чужое.txt")), "рабочий канал у окна работает");

  console.log("\n[9] ничего не записано в папку приложения");
  ok(fs.readdirSync(path.join(ROOT, "src")).sort().join(",") === appFilesBefore, "папка src не менялась во время прогона");
  ok(!fs.existsSync(path.join(ROOT, "settings.json")) && !fs.existsSync(path.join(ROOT, "secrets.json")), "в папке приложения ни настроек, ни секретов");
  // Приватный ключ моста — тем более не в проекте: он лежит в userData (проверено в [1]).
  ok(!fs.existsSync(path.join(ROOT, "bridge-tls")) && !fs.existsSync(path.join(ROOT, "key.pem")), "сертификат и ключ моста не пишутся в папку проекта");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

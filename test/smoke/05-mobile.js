"use strict";
/* ─── Группа «Телефон: панель, мост и страница входа» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 3.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  freePort,
  get,
  tmpdir,
  uiAll,
  uiFile,
} = H;

// ── Мобильный доступ: панель подключения телефона (этап 3.6) ────────────────
// Панель вынесена из app.js в src/renderer/mobile-panel.js. Проверяем ПОВЕДЕНИЕ,
// а не наличие функций: заполнение полей из настроек, запись обратно, QR-код,
// список адресов, два предупреждения (адрес недостижим, мост не запустился),
// отказ статуса, смена PIN и включение галочкой. Заглушка DOM строгая: id, которого
// нет в настоящей разметке, — ошибка теста (так находились опечатки в разметке).
async function testMobilePanel() {
  const vm = require("vm");
  const modPath = path.join(ROOT, "src", "renderer", "mobile-panel.js");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const appSrc = uiFile("app.js");

  await test("мобильный доступ: панель подключения телефона работает и живёт в своём модуле", async () => {
    // 1. Модуль на месте, подключён до app.js и отдаётся телефону.
    assert.ok(fs.existsSync(modPath), "нет файла src/renderer/mobile-panel.js");
    const src = fs.readFileSync(modPath, "utf8");
    const iTag = html.indexOf('src="mobile-panel.js"');
    assert.ok(iTag > 0, "разметка не грузит mobile-panel.js");
    assert.ok(iTag < html.indexOf('src="app.js"'), "mobile-panel.js подключён после app.js");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    assert.ok(/"mobile-panel\.js"/.test(bridge), "мобильный мост не отдаёт mobile-panel.js телефону");

    // 2. В app.js кода панели не осталось — только сборка модуля с зависимостями.
    for (const gone of ["renderMobileQr", "renderMobileStatus", "regenerateMobilePin"]) {
      assert.ok(appSrc.indexOf(gone) === -1, "код панели остался в app.js: " + gone);
    }
    const wiring = appSrc.slice(appSrc.indexOf("window.MobilePanel({"));
    const wiringCall = wiring.slice(0, wiring.indexOf("});"));
    for (const dep of ["$: $", "api: api", "isElectron: isElectron", "getSettings: () => settings", "setSettingsMsg: SettingsPanel.setSettingsMsg"]) {
      assert.ok(wiringCall.includes(dep), "в проводку панели не передан " + dep);
    }
    // Границы модуля: настройки только через getSettings(), в чужие глобалы не лезем.
    assert.ok(!/(^|[^\w.])settings\./.test(src), "модуль ходит в settings напрямую вместо getSettings()");
    assert.ok(!/AgentCore|window\.api\b|localStorage/.test(src), "модуль лезет в чужие глобалы");

    // 3. Настоящая сборка в песочнице на заглушках РЕАЛЬНОЙ разметки.
    const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    const el = (tag) => {
      const classes = new Set();
      let markup = "";
      const node = {
        tagName: String(tag || "div").toUpperCase(),
        value: "", textContent: "", checked: false, className: "", href: "", target: "", rel: "",
        children: [], listeners: {},
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        },
        addEventListener: (type, fn) => { node.listeners[type] = fn; },
        appendChild: (child) => { node.children.push(child); return child; },
      };
      // Как в браузере: запись innerHTML заменяет содержимое (иначе адреса копились бы).
      Object.defineProperty(node, "innerHTML", {
        get: () => markup,
        set: (v) => { markup = String(v); node.children.length = 0; },
      });
      return node;
    };
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    // Статус моста несёт схему и признак шифрования: мост поднимается по https с
    // самоподписанным сертификатом, и панель обязана сказать про предупреждение телефона.
    const status = {
      enabled: true, running: true, pin: "135790", host: "", hostActive: true,
      scheme: "https", tls: true, tlsError: "", tlsFingerprint: "AB:CD:EF",
      url: "https://192.168.1.72:9090", urls: [{ url: "https://192.168.1.72:9090" }],
    };
    const settings = { mobileEnabled: true, mobilePort: 9090, mobileHost: "" };
    const calls = { status: 0, regen: 0 };
    const messages = [];
    const qr = [];
    let statusFails = false;
    const api = {
      mobileStatus: async () => { calls.status++; if (statusFails) throw new Error("мост молчит"); return status; },
      mobilePinRegen: async () => { calls.regen++; return { pin: "246810" }; },
    };
    const build = (deps) => {
      const sandbox = {
        module: { exports: {} },
        window: { QR: { toSvg: (text, opts) => { qr.push([text, opts]); return "<svg>" + text + "</svg>"; } } },
        self: {},
        console: { log() {}, warn() {}, error() {} },
        document: { createElement: (tag) => el(tag) },
      };
      vm.runInNewContext(src, sandbox, { filename: "mobile-panel.js" });
      assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
      return sandbox.module.exports(deps);
    };
    const panel = build({
      $, api, isElectron: true,
      getSettings: () => settings,
      setSettingsMsg: (text, isErr) => messages.push([text, !!isErr]),
    });
    assert.deepStrictEqual(Object.keys(panel).sort(), ["applyMobileFields", "initMobilePanel", "readMobileFields"],
      "наружу торчит лишнее или чего-то не хватает");

    // 4. Заполнение полей из настроек: галочка, порт, адрес, PIN, QR и адрес для телефона.
    $("s-mobile-enabled").checked = false;
    await panel.applyMobileFields();
    assert.strictEqual($("s-mobile-enabled").checked, true, "галочка не поднялась из настроек");
    assert.strictEqual($("s-mobile-port").value, 9090, "порт моста не подставился");
    assert.strictEqual($("s-mobile-host").value, "", "поле «Адрес для телефона» не заполнено");
    assert.strictEqual($("s-mobile-pin").value, "135790", "PIN моста не показан");
    assert.strictEqual(calls.status, 1, "статус моста не запрошен");
    assert.strictEqual(qr.length, 1, "QR-код не построен");
    assert.ok(qr[0][0].indexOf("/#pin=135790") > 0, "в QR-код не попал адрес с PIN: " + qr[0][0]);
    assert.strictEqual(qr[0][1].ecc, "M", "у QR-кода не та коррекция ошибок");
    assert.ok(!$("mobile-qr-block").classList.contains("hidden"), "блок QR остался скрытым при работающем мосте");
    // Кроме адресов панель показывает пояснения (шифрование, предупреждение телефона),
    // поэтому адреса считаем по ссылкам, а не по всем строкам списка.
    const chips = () => $("mobile-urls").children.filter((c) => c.tagName === "A");
    assert.strictEqual(chips().length, 1, "адрес для телефона не показан");
    assert.strictEqual(chips()[0].textContent, "https://192.168.1.72:9090", "показан не тот адрес");
    assert.strictEqual(chips()[0].href, "https://192.168.1.72:9090", "адрес не открывается ссылкой");
    let notes = $("mobile-urls").children.filter((c) => c.tagName !== "A").map((c) => String(c.textContent));
    assert.ok(notes.some((t) => t.indexOf("Шифрование включено") >= 0), "панель молчит про шифрование: " + notes.join(" | "));
    assert.ok(notes.some((t) => t.indexOf("Дополнительно") >= 0), "панель не предупреждает про предупреждение браузера телефона");

    // 5. Предупреждение: адрес задан вручную, но такого IP на ПК нет.
    status.host = "192.168.99.99";
    status.hostActive = false;
    await panel.applyMobileFields();
    let texts = $("mobile-urls").children.map((c) => c.textContent);
    assert.ok(texts.some((t) => t.indexOf("192.168.99.99") >= 0 && t.indexOf("не найден") >= 0),
      "нет предупреждения о недостижимом адресе: " + texts.join(" | "));

    // 6. Предупреждение: мост включён, но не запустился (порт занят).
    status.host = "";
    status.hostActive = true;
    status.running = false;
    await panel.applyMobileFields();
    texts = $("mobile-urls").children.map((c) => c.textContent);
    assert.ok(texts.some((t) => String(t).indexOf("Мост не запустился") >= 0), "нет предупреждения о незапустившемся мосте");
    assert.ok($("mobile-qr-block").classList.contains("hidden"), "QR-код показан при неработающем мосте");

    // 6б. Мост без шифрования (сертификат не создался): доступ остаётся, но панель
    // обязана сказать об этом прямо — это открытая сеть и подмена страницы телефона.
    status.running = true;
    status.tls = false;
    status.tlsError = "ENOTDIR: не папка";
    await panel.applyMobileFields();
    notes = $("mobile-urls").children.filter((c) => c.tagName !== "A").map((c) => String(c.textContent));
    assert.ok(
      notes.some((t) => t.indexOf("без шифрования") >= 0 && t.indexOf("ENOTDIR") >= 0),
      "панель молчит про работу без шифрования: " + notes.join(" | ")
    );
    // Старый мост про TLS не сообщает: панель не должна выдумывать предупреждение.
    delete status.tls;
    delete status.tlsError;
    await panel.applyMobileFields();
    notes = $("mobile-urls").children.filter((c) => c.tagName !== "A").map((c) => String(c.textContent));
    assert.deepStrictEqual(notes, [], "панель выдумала предупреждение о шифровании без данных: " + notes.join(" | "));
    status.tls = true;
    status.tlsError = "";

    // 7. Статус недоступен: панель не молчит и ничего не роняет.
    statusFails = true;
    await panel.applyMobileFields();
    const failed = $("mobile-urls").children;
    assert.strictEqual(failed.length, 1, "отказ статуса оставил мусор в списке адресов");
    assert.ok(String(failed[0].textContent).indexOf("Статус недоступен") >= 0, "нет честного сообщения об отказе статуса");
    statusFails = false;
    status.running = true;

    // 8. Сохранение настроек: поля уходят в ЖИВЫЕ настройки.
    $("s-mobile-enabled").checked = false;
    $("s-mobile-port").value = "9191";
    $("s-mobile-host").value = " 192.168.1.72 ";
    panel.readMobileFields();
    assert.strictEqual(settings.mobileEnabled, false, "галочка не сохранилась");
    assert.strictEqual(settings.mobilePort, 9191, "порт не сохранился");
    assert.strictEqual(settings.mobileHost, "192.168.1.72", "адрес не сохранился без пробелов");
    $("s-mobile-port").value = "";
    panel.readMobileFields();
    assert.strictEqual(settings.mobilePort, 9090, "пустой порт не вернулся к 9090");

    // 9. Галочка включает поля и обновляет статус, кнопка меняет PIN.
    panel.initMobilePanel();
    assert.strictEqual(typeof $("s-mobile-enabled").listeners.change, "function", "галочка не получила обработчик");
    $("s-mobile-enabled").checked = false;
    $("mobile-fields").classList.remove("hidden");
    $("s-mobile-enabled").listeners.change();
    assert.ok($("mobile-fields").classList.contains("hidden"), "выключенная галочка не спрятала поля");
    $("s-mobile-enabled").checked = true;
    const before = calls.status;
    $("s-mobile-enabled").listeners.change();
    await Promise.resolve();
    assert.ok(!$("mobile-fields").classList.contains("hidden"), "включённая галочка не показала поля");
    assert.ok(calls.status > before, "при включении галочки статус не перечитан");
    assert.strictEqual(typeof $("btn-mobile-pin-regen").onclick, "function", "кнопка смены PIN без обработчика");
    await $("btn-mobile-pin-regen").onclick();
    assert.strictEqual(calls.regen, 1, "смена PIN не дошла до главного процесса");
    assert.strictEqual(settings.mobilePin, "246810", "новый PIN не сохранён");
    assert.strictEqual($("s-mobile-pin").value, "246810", "новый PIN не показан в поле");
    assert.ok(messages.some((m) => m[0].indexOf("246810") >= 0 && m[1] === false), "человеку не сказали новый PIN");

    // 10. Ошибка смены PIN называется вслух, а не глотается.
    const errs = [];
    const broken = build({
      $, isElectron: true, getSettings: () => settings,
      setSettingsMsg: (text, isErr) => errs.push([text, !!isErr]),
      api: { mobileStatus: api.mobileStatus, mobilePinRegen: async () => { throw new Error("мост занят"); } },
    });
    broken.initMobilePanel();
    await $("btn-mobile-pin-regen").onclick();
    assert.ok(errs.some((m) => m[0].indexOf("Не удалось сменить PIN") >= 0 && m[1] === true), "ошибка смены PIN не показана человеку");

    // 11. Веб-режим: панель прячется и в главный процесс не ходит вовсе.
    const webCalls = { status: 0, regen: 0 };
    const web = build({
      $, isElectron: false, getSettings: () => settings, setSettingsMsg: () => {},
      api: {
        mobileStatus: async () => { webCalls.status++; return status; },
        mobilePinRegen: async () => { webCalls.regen++; return { pin: "1" }; },
      },
    });
    $("mobile-fields").classList.remove("hidden");
    await web.applyMobileFields();
    assert.ok($("mobile-fields").classList.contains("hidden"), "в веб-режиме поля подключения телефона остались видны");
    assert.strictEqual(webCalls.status, 0, "в веб-режиме статус всё равно запрошен");
    web.initMobilePanel();
    await $("btn-mobile-pin-regen").onclick();
    assert.strictEqual(webCalls.regen, 0, "в веб-режиме смена PIN всё равно ушла в IPC");

    // 12. Негативный контроль зависимостей: без getSettings панель падает понятно.
    const noSettings = build({ $, api, isElectron: true, setSettingsMsg: () => {} });
    assert.throws(() => noSettings.readMobileFields(), /getSettings/, "забытая зависимость не привела к понятной ошибке");
  });
}

// ── 4b. mobile-bridge: rate-limit PIN ───────────────────────────────────────
async function testMobileBridge() {
  const MobileBridge = require(path.join(ROOT, "src", "mobile-bridge.js"));

  await test("mobile-bridge: 10 неудач подряд → глобальная блокировка", () => {
    const b = new MobileBridge({ handlerMap: new Map() });
    b.pin = "123456";
    const replies = [];
    const conn = { authed: false, authTries: 0, sendText: (s) => replies.push(JSON.parse(s)), destroy: () => {} };
    const auth = (pin) => b.onWsMessage(conn, JSON.stringify({ t: "auth", pin }));
    for (let i = 0; i < 10; i++) auth("000000");
    assert.ok(b.authLockedUntil > Date.now(), "не наступила блокировка");
    assert.ok(
      replies.some((r) => r.t === "auth_err" && r.lock === true),
      "нет auth_err с lock среди ответов: " + JSON.stringify(replies.slice(-3))
    );
    // Во время блокировки даже правильный PIN не принимается.
    auth("123456");
    const lastErr = [...replies].reverse().find((r) => r.t === "auth_err");
    assert.ok(lastErr && lastErr.lock === true, "правильный PIN принят во время блокировки");
    assert.ok(!conn.authed, "соединение авторизовано во время блокировки");
  });

  await test("mobile-bridge: успешный вход сбрасывает счётчик", () => {
    const b = new MobileBridge({ handlerMap: new Map() });
    b.pin = "123456";
    const replies = [];
    const conn = { authed: false, authTries: 0, sendText: (s) => replies.push(JSON.parse(s)), destroy: () => {} };
    const auth = (pin) => b.onWsMessage(conn, JSON.stringify({ t: "auth", pin }));
    for (let i = 0; i < 5; i++) auth("000000");
    assert.ok(b.authFailCount > 0, "счётчик не накопился");
    auth("123456");
    assert.ok(conn.authed, "не авторизовался правильным PIN");
    assert.strictEqual(b.authFailCount, 0, "счётчик не сброшен после успеха");
  });
  await test("mobile-bridge: «Адрес для телефона» из настроек идёт первым", () => {
    const realIfs = os.networkInterfaces;
    os.networkInterfaces = () => ({
      "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.72" }],
      "vEthernet (WSL)": [{ family: "IPv4", internal: false, address: "172.28.96.1" }],
      Loopback: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    });
    try {
      const b = new MobileBridge({ handlerMap: new Map() });
      b.applySettings({ mobileEnabled: false, mobilePort: 9090, mobileHost: "192.168.1.72" });
      const st = b.status();
      assert.strictEqual(st.host, "192.168.1.72", "адрес из настроек не сохранён");
      assert.strictEqual(st.hostActive, true, "адрес не найден на ПК");
      assert.strictEqual(st.url, "http://192.168.1.72:9090", "первый адрес: " + st.url);
      assert.strictEqual(st.urls[0].url, "http://192.168.1.72:9090", "QR-код покажет не тот адрес");
      // Виртуальные адаптеры уходят в конец: с телефона они не открываются.
      assert.strictEqual(st.urls[st.urls.length - 1].ip, "172.28.96.1", "виртуальный адаптер остался первым");
      assert.strictEqual(st.urls.length, 2, "внутренний адрес 127.0.0.1 не должен попадать в список");
    } finally {
      os.networkInterfaces = realIfs;
    }
  });

  await test("mobile-bridge: без настройки домашняя сеть впереди виртуальной, чужой адрес не подменяет реальный", () => {
    const realIfs = os.networkInterfaces;
    os.networkInterfaces = () => ({
      "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.20.144.1" }],
      Ethernet: [{ family: "IPv4", internal: false, address: "192.168.1.72" }],
    });
    try {
      const b = new MobileBridge({ handlerMap: new Map() });
      b.applySettings({ mobilePort: 9090, mobileHost: "" });
      assert.strictEqual(b.status().urls[0].ip, "192.168.1.72", "первым ушёл виртуальный адаптер");
      // Адрес, которого на ПК нет: телефон по нему не дойдёт — показываем реальные.
      b.applySettings({ mobilePort: 9090, mobileHost: "192.168.99.99" });
      const st = b.status();
      assert.strictEqual(st.hostActive, false, "чужой адрес сочли живым");
      assert.strictEqual(st.urls[0].ip, "192.168.1.72", "показан недостижимый адрес: " + st.urls[0].ip);
      assert.strictEqual(st.urls.length, 2, "реальные адреса потерялись");
    } finally {
      os.networkInterfaces = realIfs;
    }
  });

  await test("mobile-bridge: поле «Адрес для телефона» есть в настройках и сохраняется", () => {
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(/id="s-mobile-host"/.test(htmlSrc), "нет поля «Адрес для телефона»");
    // Панель подключения телефона вынесена в src/renderer/mobile-panel.js (этап 3.6):
    // спрашиваем интерфейс целиком, а не адрес кода, — вынос не должен ронять проверку.
    const uiSrc = uiAll();
    assert.ok(/getSettings\(\)\.mobileHost = \$\("s-mobile-host"\)\.value\.trim\(\)/.test(uiSrc), "поле не сохраняется");
    assert.ok(/st\.host && !st\.hostActive/.test(uiSrc), "нет предупреждения о недостижимом адресе");
    // Схема настроек вынесена в src/settings-store.js (этап B, часть 5).
    const storeS = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
    assert.ok(/mobileHost: "192\.168\.1\.72"/.test(storeS), "адрес по умолчанию не задан");
  });


  await test("mobile-bridge: отдаёт monochrome.css и highlight.js", async () => {
    const b = new MobileBridge({ handlerMap: new Map(), certDir: tmpdir("mobile-smoke-tls-") });
    b.port = await freePort();
    b.pin = "123456";
    b.start();
    try {
      const css = await get(b.port, "/monochrome.css", true);
      assert.strictEqual(css.status, 200, "monochrome.css не отдаётся (" + css.status + ")");
      assert.ok(/backdrop-filter/.test(css.body), "отдан не монохромный слой");
      const hl = await get(b.port, "/highlight.js", true);
      assert.strictEqual(hl.status, 200, "highlight.js не отдаётся (" + hl.status + ")");
      assert.ok(hl.body.length > 100, "highlight.js пустой");
      const gate = await get(b.port, "/mobile-api.js", true);
      assert.strictEqual(gate.status, 200, "mobile-api.js перестал отдаваться");
      const escaped = await get(b.port, "/../package.json", true);
      assert.strictEqual(escaped.status, 404, "мост отдал файл вне renderer");
      // Данные агента (промпт и таблица схем) телефон обязан получать так же, как ПК:
      // без них на телефоне ядро стартует без правил и без инструментов.
      const prm = await get(b.port, "/prompts.js", true);
      assert.strictEqual(prm.status, 200, "промпт не отдаётся телефону (" + prm.status + ")");
      assert.ok(prm.body.indexOf("SYSTEM_PROMPT") > 0, "отдан не файл промпта");
      const sch = await get(b.port, "/tool-schemas.js", true);
      assert.strictEqual(sch.status, 200, "таблица схем не отдаётся телефону (" + sch.status + ")");
      assert.ok(sch.body.indexOf("TOOL_DEFINITIONS") > 0, "отдан не файл схем");
      assert.ok(sch.body.indexOf("findTools") > 0, "в схемах нет инструментов");
    } finally {
      b.stop();
    }
  });

  await test("mobile-bridge: настройки и события реально доезжают до телефона (живой WebSocket)", async () => {
    assert.strictEqual(typeof WebSocket, "function", "нужен глобальный WebSocket (Node 22+)");
    // Мост отдаёт ровно то же, что IPC на ПК: телефон — не «отдельное приложение».
    const handlers = new Map([
      ["settings:get", () => ({ provider: "openai", agentEnv: { TOKEN: "секрет" }, yandexOauthToken: "y0-TOKEN" })],
      ["yc:status", () => ({ loggedIn: true, folderName: "prod", allowUpdate: true })],
    ]);
    const b = new MobileBridge({ handlerMap: handlers, certDir: tmpdir("mobile-smoke-ws-tls-") });
    b.port = await freePort();
    b.pin = "123456";
    b.start();
    let ws = null;
    try {
      const oldTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      ws = new WebSocket("wss://127.0.0.1:" + b.port + "/ws");
      if (oldTlsReject === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = oldTlsReject;
      const seen = [];
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("таймаут WebSocket")), 5000);
        ws.onopen = () => ws.send(JSON.stringify({ t: "auth", pin: "123456" }));
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          seen.push(m);
          if (m.t === "auth_ok") ws.send(JSON.stringify({ t: "call", id: 1, ch: "settings:get", args: [] }));
          if (m.t === "res" && m.id === 1) ws.send(JSON.stringify({ t: "call", id: 2, ch: "yc:status", args: [] }));
          if (m.t === "res" && m.id === 2) {
            clearTimeout(t);
            resolve();
          }
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error("WebSocket не поднялся"));
        };
      });
      const set = seen.find((m) => m.t === "res" && m.id === 1);
      assert.ok(set && set.ok, "вызов канала настроек не прошёл");
      assert.strictEqual(set.v.agentEnv.TOKEN, "секрет", "переменные агента не доехали до телефона");
      assert.strictEqual(set.v.yandexOauthToken, "y0-TOKEN", "токен Yandex Cloud не доехал до телефона");
      const st = seen.find((m) => m.t === "res" && m.id === 2);
      assert.ok(st && st.ok && st.v.loggedIn === true, "на телефоне Yandex Cloud не видит подключение с ПК");
      // Событие с ПК доходит до телефона без перезагрузки страницы.
      b.broadcast("ai:event", { type: "chunk", text: "привет", from: "desktop" });
      b.broadcast("chats:reload", { at: 1 });
      await new Promise((r) => setTimeout(r, 150));
      const ev = seen.find((m) => m.t === "ev" && m.ch === "ai:event");
      assert.ok(ev && ev.v.text === "привет" && ev.v.from === "desktop", "событие прогона не разослано: " + JSON.stringify(ev));
      assert.ok(seen.some((m) => m.t === "ev" && m.ch === "chats:reload"), "телефон не получает уведомление о новой истории");
    } finally {
      try {
        if (ws) ws.close();
      } catch {}
      b.stop();
    }
  });

  await test("mobile-bridge: service worker получает версию приложения (телефон не залипает на старом коде)", async () => {
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
    const b = new MobileBridge({ handlerMap: new Map(), certDir: tmpdir("mobile-smoke-sw-tls-") });
    b.port = await freePort();
    b.pin = "123456";
    b.start();
    try {
      const sw = await get(b.port, "/sw.js", true);
      assert.strictEqual(sw.status, 200, "sw.js не отдаётся");
      assert.ok(
        sw.body.includes("ai-agent-mobile-" + pkgVersion),
        "в имени кэша service worker нет версии приложения: " + (sw.body.match(/ai-agent-mobile-[^"]*/) || ["—"])[0]
      );
      assert.ok(sw.body.includes("caches.delete"), "старые кэши не удаляются");
      const boot = await get(b.port, "/bootstrap.js", true);
      assert.ok(/__mobileBridge = true/.test(boot.body), "без флага моста mobile-api не включится");
    } finally {
      b.stop();
    }
  });

  await test("mobile-api: покрывает все методы интерфейса и знает все каналы IPC", () => {
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const mob = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    const main = backendSrc();
    const keys = new Set([...mob.matchAll(/^\s{4}([a-zA-Z0-9_]+):/gm)].map((m) => m[1]));
    // Совпадения с адресами (api.deepseek.com и т.п.) и сознательно отсутствующий
    // синхронный канал сохранения чатов: sendSync по WebSocket невозможен, при
    // закрытии страницы история уходит асинхронным saveChats.
    // agentFilesOpen/agentFilesClear — только окно на ПК: открывают папку в проводнике
// и удаляют файлы на диске, с телефона такие кнопки не нужны (и опасны без диалога).
const skip = new Set(["anthropic", "cerebras", "cloud", "deepseek", "groq", "mistral", "nvidia", "openai", "saveChatsSync", "agentFilesOpen", "agentFilesClear"]);
    const used = [...new Set((app.match(/api\.[a-zA-Z0-9_]+/g) || []).map((s) => s.slice(4)))];
    const missing = used.filter((k) => !skip.has(k) && !keys.has(k));
    assert.deepStrictEqual(missing, [], "в мобильной копии API нет методов: " + missing.join(", "));
    // Каждый вызов из мобильной копии должен существовать в main.js — иначе кнопка
    // на телефоне молча ничего не делает, и причину не видно.
    const inv = [...new Set([...mob.matchAll(/invoke\("([^"]+)"\)/g)].map((m) => m[1]))];
    const bad = inv.filter((ch) => !main.includes('ipcMain.handle("' + ch + '"') && !main.includes('ipcMain.on("' + ch + '"'));
    assert.deepStrictEqual(bad, [], "нет обработчиков каналов: " + bad.join(", "));
    const ons = [...new Set([...mob.matchAll(/\bon\("([^"]+)"\)/g)].map((m) => m[1]))];
    for (const ch of ons) assert.ok(main.includes('"' + ch + '"'), "нет события " + ch + " в main.js");
  });

  await test("синхронизация: история чатов с другого устройства подхватывается сама", () => {
    const main = backendSrc();
    const pre = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const mob = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    assert.ok(
      /ipcMain\.handle\("chats:save", \(e, d\) => \{\n  saveChats\(d\);\n  notifyChatsSaved\(e\);/.test(main),
      "сохранение истории не уведомляет другие клиенты"
    );
    assert.ok(/function notifyChatsSaved\(e\)/.test(main) && /send\("chats:reload"/.test(main), "нет события chats:reload");
    assert.ok(/senderId === mainWindow\.webContents\.id\) return;/.test(main), "своё же окно получает лишнее уведомление");
    assert.ok(/onChatsReload/.test(pre), "в preload нет onChatsReload");
    assert.ok(/onChatsReload/.test(mob), "в mobile-api нет onChatsReload");
    assert.ok(/api\.onChatsReload\(\(\) => ChatStore\.reloadChatsFromDisk\(\)\)/.test(app), "интерфейс не подписан на chats:reload");
    // Сама перезагрузка истории вынесена в хранилище (этап A, часть 10): спрашиваем модуль.
    assert.ok(/if \(getSession\(\) \|\| getChatsSavePending\(\)\) return;/.test(uiFile("chat-store.js")), "перезагрузка может затереть свой прогон или несохранённые правки");
    assert.ok(/getChatsSavePending,/.test(uiFile("chat-store.js")), "хранилище не отвечает, есть ли несохранённые правки");
    // Прогон, запущенный телефоном, помечается в событиях и не подмешивается в чужой чат.
    assert.ok(/let activeRunOrigin = "desktop";/.test(main), "нет признака «кто запустил прогон»");
    // Источник прогона теперь берётся из проверки отправителя (src/ipc-guard.js):
    // своя копия правила (e.sender.id) расходилась с ней и путала журнал.
    assert.ok(/const kind = ipcGuard\.senderKind\(e, live\.mainWindow\);/.test(main), "источник прогона определяется не проверкой отправителя");
    assert.ok(/live\.activeRunOrigin = kind === "desktop" \? "desktop" : "mobile";/.test(main), "ai:send не отмечает источник прогона");
    assert.ok(/set activeRunOrigin\(v\)/.test(main), "метка источника прогона не связана с оболочкой");
    // Сама метка ставится в модуле окна (этап B, часть 13), а признак «кто запустил
    // прогон» остаётся в main.js — проверяем и то, и другое, и их связь.
    assert.ok(/from: getRunOrigin\(\)/.test(main), "события не помечаются источником");
    assert.ok(/getRunOrigin: \(\) => activeRunOrigin,/.test(main), "метка запуска не связана с признаком прогона");
    assert.ok(/if \(ev && ev\.from === "mobile" && !getSession\(\)\)/.test(uiFile("chat-events.js")), "чужой прогон подмешивается в текущий чат");
  });

  await test("мобильный интерфейс: сайдбар с настройками открывается на телефоне", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");
    const m720 = css.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/);
    assert.ok(m720, "нет блока max-width: 720px");
    assert.ok(
      !/#sidebar\s*\{\s*display:\s*none/.test(m720[1]),
      "на телефоне сайдбар по-прежнему скрыт display:none — гамбургер открывает пустоту"
    );
    assert.ok(!/#project-panel\s*\{\s*display:\s*none/.test(m720[1]), "панель проекта на телефоне скрыта");
    const m900 = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
    assert.ok(m900 && /#sidebar \{[\s\S]*?display: flex;/.test(m900[1]), "у выезжающего сайдбара нет display:flex");
  });
}

// ── 4c. mobile-api: страница входа с телефона ───────────────────────────────
async function testMobileGate() {
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");

  await test("мобильный вход: карточка не уезжает под клавиатуру", () => {
    assert.ok(/visualViewport/.test(src), "высота не привязана к видимой области");
    assert.ok(/gateEl\.style\.height\s*=/.test(src), "высота оверлея не выставляется");
    assert.ok(/mg-wrap\{display:flex;min-height:100%/.test(src), "нет скроллируемого контейнера");
    assert.ok(/mg-card\{margin:auto;/.test(src), "карточка не центрируется безопасно");
    assert.ok(/overflow:auto/.test(src) && /-webkit-overflow-scrolling:touch/.test(src), "нет прокрутки оверлея");
    assert.ok(/env\(safe-area-inset-bottom\)/.test(src), "нет отступа под системные панели");
  });

  await test("мобильный вход: PIN уходит сам после шестой цифры", () => {
    assert.ok(/digits\.length === 6/.test(src), "нет автоподключения после шести цифр");
    assert.ok(/replace\(\/\\D\+\/g, ""\)/.test(src), "PIN не чистится от нецифр");
    assert.ok(/enterkeyhint="go"/.test(src), "на клавиатуре нет кнопки «Готово»");
    assert.ok(/inputmode="numeric"/.test(src), "нет цифровой клавиатуры");
  });

  await test("мобильный вход: понятные состояния и повтор", () => {
    assert.ok(/function resetPinField/.test(src), "после ошибки поле не сбрасывается");
    assert.ok(/Вход заблокирован на 5 минут/.test(src), "нет сообщения о блокировке");
    assert.ok(/mobile-gate-retry/.test(src), "нет кнопки переподключения");
    assert.ok(/btn\.disabled = gateBusy/.test(src), "кнопка не блокируется во время проверки");
    assert.ok(/touch-action:manipulation/.test(src), "кнопка не помечена как тач-цель");
    assert.ok(/if \(gateBusy\) return/.test(src), "повторная отправка PIN не защищена");
  });
}

module.exports = {
  testMobilePanel,
  testMobileBridge,
  testMobileGate,
};

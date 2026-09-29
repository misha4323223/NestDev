"use strict";
/* ─── Группа «Приложение: превью, секреты, OTA, память диалогов, PowerShell» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 12.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFileSync } = require("child_process");
const { EventEmitter } = require("events");

const H = require("./harness.js");
const {
  test,
  OTA_TEST_KEYS,
  ROOT,
  backendSrc,
  coreData,
  get,
  hasTool,
  makeBundle,
  modelPrompt,
  tmpdir,
  toolsHomeSrc,
  uiAll,
  uiFile,
  uiFind,
} = H;

// ── Быстрый запуск превью (src/renderer/dev-run.js) ─────────────────────────
// Модуль вынесен из app.js, поэтому проверяем его поведение: состояние запуска,
// команды в главный процесс, лог превью, вывод сервера в консоль и Tab-дополнение.
// Заглушка DOM строгая: id, которого нет в настоящей разметке, — ошибка теста.
async function testDevRun() {
  await test("быстрый запуск превью: модуль ведёт состояние и шлёт команды", async () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "dev-run.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    const el = () => {
      const set = new Set();
      return {
        value: "", textContent: "", innerHTML: "", title: "", scrollTop: 0, scrollHeight: 40,
        classList: {
          add: (...c) => c.forEach((x) => set.add(x)),
          remove: (...c) => c.forEach((x) => set.delete(x)),
          contains: (c) => set.has(c),
          toggle: (c, on) => (on ? set.add(c) : set.delete(c)),
        },
        querySelector: () => null,
      };
    };
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    const calls = { started: [], stopped: 0, toasts: [], opened: [], term: [], statusBar: 0 };
    // Главный процесс держим «живым»: devStatus отвечает по текущему состоянию,
    // иначе проверка после остановки видела бы старый «запущен» и панель была бы ни при чём.
    let running = true;
    const api = {
      devStatus: async () => ({ ok: true, running: running, command: "npm run dev", detected: "vite" }),
      devStart: async (dir, cmd) => { calls.started.push([dir, cmd]); running = true; return { ok: true, command: cmd || "npm run dev" }; },
      devStop: async () => { calls.stopped++; running = false; return { ok: true }; },
      termComplete: async () => ({ base: "npm ", matches: ["run"] }),
    };
    const sandbox = { module: { exports: {} }, window: {}, self: {}, console: { log() {}, warn() {}, error() {} } };
    vm.runInNewContext(src, sandbox, { filename: "dev-run.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
    const run = sandbox.module.exports({
      $, api, isElectron: true,
      esc: (s) => String(s == null ? "" : s),
      previewOpen: (u) => calls.opened.push(u),
      projectDir: () => "/tmp/proj",
      termAppend: (h) => calls.term.push(h),
      toast: (t) => calls.toasts.push(t),
      updateStatusBar: () => calls.statusBar++,
      getSettings: () => ({ previewUrl: "http://localhost:5173" }),
    });
    assert.deepStrictEqual(Object.keys(run).sort(), ["devStartClick", "devStopClick", "onDevEvent", "previewRunning", "refreshDevControls", "termServerAppend", "termTabComplete"], "наружу торчит лишнее или чего-то не хватает");
    assert.strictEqual(run.previewRunning, false, "до запуска состояние «не запущен»");

    // 1. Проверка состояния: команда и «запущен» приходят из главного процесса.
    await run.refreshDevControls();
    assert.strictEqual(els.get("preview-cmd").value, "npm run dev", "команда проекта не подставилась в поле");
    assert.strictEqual(run.previewRunning, true, "главный процесс сообщил «запущен», а панель это не учла");
    assert.ok(calls.statusBar > 0, "строка состояния не обновляется");

    // 2. Остановка: команда уходит в главный процесс, состояние сбрасывается.
    await run.devStopClick();
    assert.strictEqual(calls.stopped, 1, "остановка не дошла до главного процесса");
    assert.strictEqual(run.previewRunning, false, "после остановки состояние не сброшено");

    // 3. Запуск: команда из поля и каталог активного проекта.
    await run.devStartClick();
    assert.deepStrictEqual(calls.started, [["/tmp/proj", "npm run dev"]], "старт ушёл без каталога проекта или команды");
    assert.strictEqual(run.previewRunning, true, "после старта состояние «запущен» (свойство живое, а не копия)");
    assert.ok(calls.toasts.some((t) => /Проект запущен/.test(t)), "нет сообщения о запуске");
    assert.deepStrictEqual(calls.opened, ["http://localhost:5173"], "превью открылось не на настроенном адресе");
    assert.ok(els.get("preview-log").innerHTML.includes("pl-cmd"), "в лог превью ничего не попало");
    assert.ok(els.get("btn-preview-stop").classList.contains("hidden") === false, "кнопка «стоп» осталась скрытой");

    run.onDevEvent({ type: "out", text: "готово" });
    assert.ok(els.get("preview-log").innerHTML.includes("готово"), "вывод сервера не попал в лог превью");
    assert.ok(calls.term.join("").includes("готово"), "вывод сервера не продублирован в консоль");
    run.onDevEvent({ type: "exit", code: 1 });
    assert.strictEqual(run.previewRunning, false, "аварийный выход сервера не сбросил состояние");

    // 4. Tab-дополнение команды в консоли (поле берём через тот же $, что и модуль).
    $("term-input").value = "npm r";
    await run.termTabComplete();
    assert.strictEqual($("term-input").value, "npm run", "Tab не дополнил команду");
  });
}

// ── 2. secrets ──────────────────────────────────────────────────────────────
async function testSecrets() {
  const secrets = require(path.join(ROOT, "src", "secrets.js"));

  await test("splitSecrets: вынимает только секреты", () => {
    const s = { provider: "openai", openaiApiKey: "k", mobilePin: "1234", agentEnv: { P: "v" }, model: "m" };
    const { rest, sec } = secrets.splitSecrets(s);
    assert.strictEqual(rest.provider, "openai");
    assert.strictEqual(rest.model, "m");
    assert.strictEqual(rest.openaiApiKey, undefined);
    assert.strictEqual(sec.openaiApiKey, "k");
    assert.strictEqual(sec.mobilePin, "1234");
    assert.deepStrictEqual(sec.agentEnv, { P: "v" });
  });

  await test("saveSecrets/loadSecrets: roundtrip (plain-откат без safeStorage)", () => {
    const dir = tmpdir("secrets-test-");
    const file = path.join(dir, "secrets.json");
    secrets.init(file);
    secrets.saveSecrets({ openaiApiKey: "k1", agentEnv: { A: "1", B: "2" }, githubToken: "t" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(typeof raw.openaiApiKey === "string" && raw.openaiApiKey.startsWith("plain:"), "ключ не в plain-формате: " + raw.openaiApiKey);
    const loaded = secrets.loadSecrets();
    assert.strictEqual(loaded.openaiApiKey, "k1");
    assert.deepStrictEqual(loaded.agentEnv, { A: "1", B: "2" });
    assert.strictEqual(loaded.githubToken, "t");
  });

  await test("saveSecrets: пустые значения не пишутся", () => {
    const dir = tmpdir("secrets-test2-");
    secrets.init(path.join(dir, "secrets.json"));
    secrets.saveSecrets({ openaiApiKey: "", agentEnv: {}, githubToken: null });
    assert.ok(!fs.existsSync(path.join(dir, "secrets.json")) || fs.readFileSync(path.join(dir, "secrets.json"), "utf8").trim() === "{}", "пустые секреты записались");
  });

  await test("loadSecrets: миграция открытого текста из legacy", () => {
    const dir = tmpdir("secrets-test3-");
    const file = path.join(dir, "secrets.json");
    fs.writeFileSync(file, JSON.stringify({ openaiApiKey: "legacy-key", mobilePin: "9999" }), "utf8");
    secrets.init(file);
    const loaded = secrets.loadSecrets();
    assert.strictEqual(loaded.openaiApiKey, "legacy-key");
    assert.strictEqual(loaded.mobilePin, "9999");
  });

  secrets.init(null); // сброс, чтобы не влиять на другие тесты
}

const OTA_OTHER_KEYS = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), pub: publicKey.export({ type: "spki", format: "pem" }).toString() };
})();

async function testOta() {
  const ota = require(path.join(ROOT, "src", "ota.js"));
  // Наборы ниже собираются подписанными, и приложение должно принимать их по
  // доверенному ключу, а не по послаблению «подпись не обязательна».
  const trustBefore = process.env.AI_AGENT_OTA_TRUST;
  process.env.AI_AGENT_OTA_TRUST = OTA_TEST_KEYS.pub;

  await test("versionGt: сравнение версий", () => {
    assert.ok(ota.versionGt("1.0.1", "1.0.0"));
    assert.ok(ota.versionGt("1.2.0", "1.1.9"));
    assert.ok(!ota.versionGt("1.0.0", "1.0.0"));
    assert.ok(!ota.versionGt("1.0.0", "1.0.1"));
  });

  await test("applyBundle: распаковка и проверка синтаксиса", async () => {
    const root = tmpdir("ota-test-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "renderer"), { recursive: true });
    makeBundle(srcDir, {
      "src/main.js": "console.log(1);",
      "src/renderer/index.html": "<html></html>",
    }, "9.9.9");
    process.env.AI_AGENT_OTA_ROOT = root;
    const r = await ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8")));
    assert.ok(r.ok && r.version === "9.9.9");
    const cur = ota.resolveCurrent();
    assert.ok(fs.existsSync(path.join(cur, "src", "main.js")), "main.js не распакован");
    assert.ok(fs.existsSync(path.join(cur, "version.json")), "нет version.json");
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  await test("applyBundle: повреждённый хеш отклоняется", async () => {
    const root = tmpdir("ota-test2-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "renderer"), { recursive: true });
    makeBundle(srcDir, {
      "src/main.js": "console.log(1);",
      "src/renderer/index.html": "<html></html>",
    }, "9.9.8", true);
    process.env.AI_AGENT_OTA_ROOT = root;
    await assert.rejects(() => ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"))), /Хеш/);
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  await test("applyBundle: без обязательных файлов отклоняется", async () => {
    const root = tmpdir("ota-test3-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    makeBundle(srcDir, { "src/renderer/index.html": "<html></html>" }, "9.9.7");
    process.env.AI_AGENT_OTA_ROOT = root;
    await assert.rejects(() => ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"))), /main\.js/);
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  await test("applyBundle: набор без подписи и с чужим ключом отклоняется", async () => {
    const mine = { "src/main.js": "console.log(1);", "src/renderer/index.html": "<html></html>" };
    // Ключи доверены — значит набор ОБЯЗАН быть подписан.
    const unsignedRoot = tmpdir("ota-test4-");
    const unsignedDir = path.join(unsignedRoot, "src");
    fs.mkdirSync(path.join(unsignedDir, "renderer"), { recursive: true });
    makeBundle(unsignedDir, mine, "9.9.6", false, null);
    process.env.AI_AGENT_OTA_ROOT = unsignedRoot;
    await assert.rejects(
      () => ota.applyBundle(unsignedDir, JSON.parse(fs.readFileSync(path.join(unsignedDir, "manifest.json"), "utf8"))),
      /не подписан/
    );
    delete process.env.AI_AGENT_OTA_ROOT;
    // Подпись есть, но сделана чужим ключом — доверия к ней нет.
    const alienRoot = tmpdir("ota-test5-");
    const alienDir = path.join(alienRoot, "src");
    fs.mkdirSync(path.join(alienDir, "renderer"), { recursive: true });
    makeBundle(alienDir, mine, "9.9.7", false, OTA_OTHER_KEYS);
    process.env.AI_AGENT_OTA_ROOT = alienRoot;
    await assert.rejects(
      () => ota.applyBundle(alienDir, JSON.parse(fs.readFileSync(path.join(alienDir, "manifest.json"), "utf8"))),
      /неизвестным ключом/
    );
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  if (trustBefore === undefined) delete process.env.AI_AGENT_OTA_TRUST;
  else process.env.AI_AGENT_OTA_TRUST = trustBefore;
}

// ── 4d. Менеджер паролей (vault) ───────────────────────────────────────────
async function testVault() {
  const vault = require(path.join(ROOT, "src", "vault.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("vault: нормализация записи (обрезка, переводы строк, id, мусор)", () => {
    const e = vault.normalizeEntry({
      name: "  ВК  ",
      url: " https://vk.com/im ",
      login: "  user  ",
      password: "p\nw\r\n",
      note: " 2FA ",
    });
    assert.strictEqual(e.name, "ВК");
    assert.strictEqual(e.url, "https://vk.com/im");
    assert.strictEqual(e.login, "user");
    assert.strictEqual(e.password, "pw"); // переводы строк убраны, символы пароля не портим
    assert.strictEqual(e.note, "2FA");
    assert.ok(/^v[a-z0-9]+$/.test(e.id), "плохой id: " + e.id);
    assert.strictEqual(vault.normalizeEntry(null), null);
    assert.strictEqual(vault.normalizeEntry("строка"), null);
    assert.strictEqual(vault.normalizeEntry({ login: "x" }), null, "запись без имени и адреса должна отбрасываться");
    assert.strictEqual(vault.normalizeEntry({ url: "vk.com" }).name, "vk.com");
    assert.strictEqual(vault.hostOf("https://WWW.Vk.com:443/im?x=1"), "vk.com");
  });

  await test("vault: список чистится, дубликаты по id отбрасываются", () => {
    const list = vault.sanitizeList([
      { id: "a", name: "ВК", password: "p" },
      { id: "a", name: "Дубль" },
      null,
      "мусор",
      { name: "" },
    ]);
    assert.strictEqual(list.length, 1, "осталось: " + list.length);
    assert.strictEqual(list[0].password, "p");
    assert.strictEqual(vault.sanitizeList(null).length, 0);
    assert.strictEqual(vault.sanitizeList("x").length, 0);
  });

  const site = vault.sanitizeList([
    { id: "a", name: "ВК", url: "https://vk.com/", login: "user1", password: "pass1" },
    { id: "b", name: "Авито", url: "avito.ru", login: "user2" },
    { id: "c", name: "Яндекс Почта", url: "mail.yandex.ru", login: "user3" },
  ]);

  await test("vault: поиск по имени, регистру, хосту и полному URL", () => {
    assert.strictEqual(vault.findEntry(site, "ВК").id, "a");
    assert.strictEqual(vault.findEntry(site, "вк").id, "a");
    assert.strictEqual(vault.findEntry(site, "https://vk.com/login").id, "a");
    assert.strictEqual(vault.findEntry(site, "avito.ru").id, "b");
    assert.strictEqual(vault.findEntry(site, "почта").id, "c");
    assert.strictEqual(vault.findEntry(site, "yandex").id, "c");
    assert.strictEqual(vault.findEntry(site, "ok.ru"), null);
    assert.strictEqual(vault.findEntry(site, ""), null);
  });

  await test("vault: текст для агента НИКОГДА не содержит паролей", () => {
    const text = vault.listText(site);
    assert.ok(!text.includes("pass1"), "пароль утёк в текст: " + text.slice(0, 120));
    assert.ok(text.includes("пароль: сохранён") && text.includes("пароль: не сохранён"));
    assert.ok(text.includes("user2"), "логин должен быть виден агенту");
    assert.ok(/Сохранённых паролей нет/.test(vault.listText([])));
    const nf = vault.notFoundText(site, "ok.ru");
    assert.ok(nf.includes("ok.ru") && nf.includes("ВК"));
  });

  await test("vault: fillLogin подставляет вход и не выводит пароль в ответ", async () => {
    const calls = [];
    const bt = {
      async fill(a) { calls.push({ op: "fill", ...a }); return "OK"; },
      async press(a) { calls.push({ op: "press", ...a }); return "OK"; },
    };
    const r = await vault.fillLogin(site[0], {}, bt);
    assert.strictEqual(calls[0].op, "fill");
    assert.strictEqual(calls[0].text, "user1");
    assert.strictEqual(calls[0].selector, vault.LOGIN_SELECTOR);
    assert.strictEqual(calls[1].op, "fill");
    assert.strictEqual(calls[1].text, "pass1");
    assert.strictEqual(calls[1].selector, vault.PASSWORD_SELECTOR);
    assert.ok(!r.includes("pass1"), "пароль попал в текст ответа");
    assert.ok(!r.includes("user1"), "логин не должен дублироваться в ответе");
    assert.ok(r.includes("НЕ отправлена"));
  });

  await test("vault: fillLogin — submit, частичный вход и понятные ошибки", async () => {
    const calls = [];
    const bt = {
      async fill(a) { calls.push({ op: "fill", ...a }); return "OK"; },
      async press(a) { calls.push({ op: "press", ...a }); return "OK"; },
    };
    const r1 = await vault.fillLogin(site[0], { submit: true }, bt);
    assert.strictEqual(calls[2].op, "press");
    assert.strictEqual(calls[2].key, "Enter");
    assert.ok(r1.includes("Форма отправлена"));

    calls.length = 0;
    const r2 = await vault.fillLogin(site[1], {}, bt); // запись без пароля
    assert.strictEqual(calls.length, 1, "заполняться должен только логин");
    assert.ok(r2.includes("Пароль не сохранён") && !r2.includes("pass"));

    const errBt = { async fill() { return "Ошибка browserFill: элемент не найден"; }, async press() { return "OK"; } };
    assert.ok((await vault.fillLogin(site[0], {}, errBt)).includes("Не удалось заполнить поле логина"));

    // Отказ набора без слова «Ошибка» («Браузер не запущен…») тоже обязан считаться
    // отказом: иначе vaultFill отчитывается об успехе, ничего не заполнив.
    const stoppedBt = {
      isBrowserFailure: require(path.join(ROOT, "src", "browser-tools.js")).isBrowserFailure,
      async fill() { return "Браузер не запущен. Сначала вызови browserOpen (url)."; },
      async press() { return "Браузер не запущен. Сначала вызови browserOpen (url)."; },
    };
    const stopped = await vault.fillLogin(site[0], {}, stoppedBt);
    assert.ok(stopped.includes("Не удалось заполнить поле логина"), "отказ браузера не назван: " + stopped);
    assert.ok(!stopped.includes("подставлены в форму"), "отказ браузера выдан за подстановку: " + stopped);
    assert.ok(stopped.indexOf("pass1") < 0, "пароль утёк в ответ об отказе: " + stopped);
    const stoppedSubmit = await vault.fillLogin(site[0], { submit: true }, stoppedBt);
    assert.ok(!stoppedSubmit.includes("Форма отправлена"), "на отказавшем браузере форма «отправлена»: " + stoppedSubmit);

    let n = 0;
    const halfBt = { async fill() { n++; return n === 1 ? "OK" : "Ошибка browserFill: нет поля"; }, async press() { return "OK"; } };
    const r4 = await vault.fillLogin(site[0], {}, halfBt);
    assert.ok(r4.includes("поле пароля не найдено") && !r4.includes("pass1"));

    assert.ok((await vault.fillLogin(site[0], {}, null)).includes("Браузер агента недоступен"));
    assert.ok((await vault.fillLogin({ name: "X", password: "p" }, {}, bt)).includes("только пароль без логина"));
    assert.ok((await vault.fillLogin(null, {}, bt)).includes("Нет записи"));
  });

  await test("secrets: sitePasswords шифруется и читается обратно", () => {
    const dir = tmpdir("agent-vault-");
    const file = path.join(dir, "secrets.json");
    const sec = require(path.join(ROOT, "src", "secrets.js"));
    sec.init(file);
    const entries = [{ id: "a", name: "ВК", url: "vk.com", login: "user1", password: "s3cret!" }];
    const split = sec.splitSecrets({ model: "m", sitePasswords: entries });
    assert.ok(!("sitePasswords" in split.rest), "sitePasswords остался в открытых настройках");
    assert.deepStrictEqual(split.sec.sitePasswords, entries);
    sec.saveSecrets(split.sec);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("vk.com") && !raw.includes("s3cret!"), "значения не зашифрованы:\n" + raw.slice(0, 300));
    sec.init(file); // читаем заново с диска
    assert.deepStrictEqual(sec.loadSecrets().sitePasswords, entries);
  });

  await test("vault: инструменты агента, тексты и интерфейс связаны", () => {
    const mainSrc = backendSrc();
    const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    // Код интерфейса ищем там, где он лежит СЕЙЧАС: блок паролей вынесен
    // в src/renderer/secrets-panel.js (этап 3.5 разбора app.js).
    const appSrc = uiAll();

    assert.ok(hasTool(mainSrc, "vaultList") && hasTool(mainSrc, "vaultFill"), "нет обработчиков vault-инструментов");
    assert.ok(mainSrc.includes("sitePasswords: []"), "нет настройки sitePasswords");
    assert.ok(mainSrc.includes("vault.sanitizeList(s.sitePasswords)"), "список не чистится при загрузке настроек");
    assert.ok(mainSrc.includes("merged.sitePasswords = prev.sitePasswords"), "нет защиты паролей от затирания при сохранении");

    const defs = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    assert.ok(defs.includes("vaultList") && defs.includes("vaultFill"), "нет описаний vault-инструментов");
    assert.ok(coreSrc.includes("НИКОГДА не проси пароль в чате"), "в промпте нет запрета просить пароль в чате");
    assert.ok(modelPrompt().includes("vaultFill подставляет логин и пароль прямо в форму"), "промпт не направляет агента в vaultFill");

    for (const id of ["vault-list", "s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note", "btn-vault-add", "btn-vault-clear", "btn-vault-eye"]) {
      assert.ok(htmlSrc.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(appSrc.includes('"' + id + '"'), "нет ссылки на " + id + " в интерфейсе");
    }
    assert.ok(htmlSrc.includes('id="s-vault-pass" type="password"'), "поле пароля должно быть скрытым");
    assert.ok(appSrc.includes("function renderVault") && appSrc.includes("function vaultAdd") && appSrc.includes("function vaultDelete"));
  });
}

// ── 4c. Сессия и контекст: индикатор, профиль браузера, «Дописать ответ» ───
async function testSessionExtras() {
  const mainSrc = backendSrc();
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const preSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");

  await test("контекст: main.js считает заполняемость и шлёт её в интерфейс", () => {
    assert.ok(/type: "context"/.test(mainSrc), "нет события context");
    assert.ok(/emitContext\(trimmedHistory\)/.test(mainSrc), "нет отправки после обрезки истории");
    assert.ok(/emitContext\(canonical\.slice\(1\)\)/.test(mainSrc), "нет обновления между раундами");
    // История отдаётся индикатору БЕЗ системного промпта: он лежит внутри неё, а вес
    // промпта emitContext прибавляет сам — иначе промпт считался бы дважды и индикатор
    // показывал «100%» задолго до настоящего заполнения (замер: 34 758 из 28 672).
    assert.ok(!/emitContext\(canonical\)/.test(mainSrc), "индикатору отдаётся история вместе с системным промптом");
  });

  // Отрисовку индикатора берём как реальный код из app.js и подставляем простой DOM.
  const ctxSlice = uiFind("  function fmtTokens(n) {", "  function fmtClock(ts) {");
  assert.ok(ctxSlice.start > 0, "не нашёл функции индикатора контекста в интерфейсе");
  const ctxMod = new Function(
    "$",
    ctxSlice.code + "\nreturn { renderContext: renderContext, fmtTokens: fmtTokens };"
  );
  const cls = new Set();
  const dom = {
    "ctx-indicator": { classList: { add: (c) => cls.add(c) }, title: "" },
    "ctx-text": { textContent: "", classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } },
  };
  const ctx = ctxMod((id) => dom[id] || null);

  await test("контекст: только слово и процент, как у Freebuff", () => {
    ctx.renderContext({ used: 12400, budget: 24000, percent: 52 });
    assert.strictEqual(dom["ctx-text"].textContent, "Контекст 52%");
    assert.ok(cls.has("visible"), "индикатор остался скрытым");
    assert.ok(!cls.has("warn") && !cls.has("danger"), "лишний цвет на 52%");
    ctx.renderContext({ used: 19000, budget: 24000, percent: 80 });
    assert.ok(cls.has("warn"), "нет жёлтого на 80%");
    ctx.renderContext({ used: 23000, budget: 24000, percent: 96 });
    assert.ok(cls.has("danger"), "нет красного на 96%");
    // Точные числа токенов остались только в подсказке: в подписи им места нет.
    assert.ok(/23k/.test(dom["ctx-indicator"].title), "в подсказке нет числа токенов");
    assert.ok(/24k/.test(dom["ctx-indicator"].title), "в подсказке нет бюджета");
    assert.strictEqual(ctx.fmtTokens(950), "950");
    assert.strictEqual(ctx.fmtTokens(20000), "20k");
  });

  await test("контекст: переполнение показывается честно (>100%), а не «100%»", () => {
    ctx.renderContext({ used: 62000, budget: 50000, percent: 100 });
    assert.strictEqual(dom["ctx-text"].textContent, "Контекст 124%");
    assert.ok(cls.has("danger"), "нет красного при переполнении");
    assert.ok(/БОЛЬШЕ бюджета/.test(dom["ctx-indicator"].title), "нет объяснения переполнения");
    assert.ok(/приблизительная/.test(dom["ctx-indicator"].title), "нет оговорки про оценку");
    assert.ok(/текущий шаг/.test(dom["ctx-indicator"].title), "не сказано, что текущий шаг не сжимается");
    // Без бюджета падаем на присланный процент
    ctx.renderContext({ used: 100, budget: 0, percent: 40 });
    assert.strictEqual(dom["ctx-text"].textContent, "Контекст 40%");
  });

  await test("контекст: индикатор скрыт по умолчанию (до первого ответа)", () => {
    assert.ok(/\.ctx-indicator \{[\s\S]{0,80}display: none;/.test(cssSrc), "нет скрытого состояния в styles.css");
    assert.ok(/\.ctx-indicator\.visible \{ display: flex; \}/.test(cssSrc), "нет класса visible");
  });

  await test("ход работ: заголовок панели липкий, размышления прокручиваются сами", () => {
    const headRule = (cssSrc.match(/\.work-group\.expanded \.work-head \{[\s\S]{0,300}?\}/) || [])[0] || "";
    assert.ok(/position: sticky/.test(headRule), "заголовок панели действий не липкий — свернуть можно только пролистав наверх");
    assert.ok(/top: 0/.test(headRule), "нет привязки к верху панели");
    assert.ok(/z-index/.test(headRule), "заголовок не поднят над строками действий");
    assert.ok(/background/.test(headRule), "нет плотного фона — строки будут просвечивать сквозь заголовок");
    // Блок размышлений вынесен из app.js в src/renderer/chat-thinking.js (этап 3.7):
    // сам код спрашиваем в модуле, а оболочку — на факт сборки модуля.
    const thinkSrc = uiFile("chat-thinking.js");
    assert.ok(thinkSrc.includes("function thinkAutoScroll(body, force)"), "нет автопрокрутки размышлений");
    assert.ok(/thinkAutoScroll\(body\); \/\/ текст вырос/.test(thinkSrc), "автопрокрутка не вызывается при стриминге");
    assert.ok(/thinkAutoScroll\(body, true\)/.test(thinkSrc), "разворот блока не показывает конец размышлений");
    assert.ok(thinkSrc.includes("body.dataset.pinned"), "нет учёта ручной прокрутки пользователя");
    assert.ok(appSrc.includes("window.ChatThinking()"), "оболочка не собирает модуль размышлений");

    // Поведенчески — на настоящем коде app.js: тянем вниз, но не выдёргиваем
    // пользователя, который сам читает выше.
    const thinkSlice = uiFind("function thinkAutoScroll(body, force) {", "\n  }\n");
    assert.ok(thinkSlice.start > 0, "не нашёл thinkAutoScroll в интерфейсе");
    const thinkAutoScroll = new Function(thinkSlice.code + "\n  }" + "\nreturn thinkAutoScroll;")();
    const mkBody = () => ({ dataset: {}, scrollTop: 0, scrollHeight: 900, clientHeight: 200 });
    const a = mkBody();
    thinkAutoScroll(a);
    assert.strictEqual(a.scrollTop, 900, "текст вырос, а блок не поехал вниз");
    assert.strictEqual(a.dataset.pinned, "1", "не запомнили, что пользователь у конца");
    const b = mkBody();
    b.dataset.pinned = "0"; // пользователь отлистал вверх и читает
    thinkAutoScroll(b);
    assert.strictEqual(b.scrollTop, 0, "выдёргнули пользователя из чтения");
    thinkAutoScroll(b, true);
    assert.strictEqual(b.scrollTop, 900, "принудительная прокрутка (разворот блока) не сработала");
  });

  await test("профиль браузера: разметка, preload и обработчики согласованы", () => {
    for (const id of [
      "s-browser-profile", "browser-profile-info", "btn-browser-profile-clear",
      "s-browser-connect", "s-browser-connect-port", "btn-browser-connect", "browser-connect-info",
    ]) {
      assert.ok(htmlSrc.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(uiAll().includes('"' + id + '"'), "нет ссылки на " + id + " в интерфейсе");
    }
    assert.ok(preSrc.includes('"browser:profileInfo"'), "нет канала browser:profileInfo");
    assert.ok(preSrc.includes('"browser:clearProfile"'), "нет канала browser:clearProfile");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:profileInfo"'), "нет обработчика browser:profileInfo");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:clearProfile"'), "нет обработчика browser:clearProfile");
    assert.ok(mainSrc.includes("browserProfile: true"), "профиль не включён по умолчанию");
    assert.ok(preSrc.includes('"browser:connect"'), "нет канала browser:connect");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:connect"'), "нет обработчика browser:connect");
    assert.ok(preSrc.includes('"browser:connectInfo"'), "нет канала browser:connectInfo");
    assert.ok(mainSrc.includes("browserConnectPort: 9222"), "нет настройки порта отладки");
  });

  await test("прерванный ответ: пометка и кнопка «Дописать ответ» на месте", () => {
    assert.ok(/interrupted: true/.test(uiAll()), "пометка прерванного ответа не ставится");
    // Функция продолжения вынесена своим модулем (этап A, часть 9): спрашиваем интерфейс целиком.
    assert.ok(/function continueInterruptedAnswer\(chatId, m\)/.test(uiAll()), "нет функции продолжения");
    // Кнопка живёт в модуле отрисовки сообщения (этап 3.7) — спрашиваем интерфейс целиком.
    assert.ok(/Дописать ответ/.test(uiAll()), "нет кнопки «Дописать ответ»");
    // Привязка живёт в модуле отрисовки сообщения (этап 3.7): там живые данные чатов
    // берутся через getChatsData(), а не копией объекта.
    assert.ok(/continueInterruptedAnswer\(m\.chatId \|\| getChatsData\(\)\.activeId, m\)/.test(uiAll()), "кнопка не привязана");
  });
}

async function testSelfDev() {
  const selfDev = require(path.join(ROOT, "src", "self-dev.js"));
  const appSrc = path.join(ROOT, "src");
  const otaRoot = path.join(os.tmpdir(), "ota-protect-test", "current");

  await test("self-dev: защищает bootstrap.js и ota.js приложения", () => {
    assert.ok(selfDev.protectedSelfPath(path.join(appSrc, "bootstrap.js"), { appSrcDir: appSrc }), "bootstrap.js не защищён");
    assert.ok(selfDev.protectedSelfPath(path.join(appSrc, "ota.js"), { appSrcDir: appSrc }), "ota.js не защищён");
  });

  await test("self-dev: защищает применённый OTA-бандл и его содержимое", () => {
    assert.ok(selfDev.protectedSelfPath(otaRoot, { appSrcDir: appSrc, otaRoot }), "корень OTA не защищён");
    assert.ok(selfDev.protectedSelfPath(path.join(otaRoot, "src", "main.js"), { appSrcDir: appSrc, otaRoot }), "файл внутри OTA не защищён");
  });

  await test("self-dev: обычные файлы проекта не блокируются", () => {
    const allowed = [
      path.join(appSrc, "main.js"),
      path.join(appSrc, "renderer", "app.js"),
      path.join(ROOT, "README.md"),
      // одноимённые файлы в ЧУЖОМ проекте не под защитой
      path.join(os.tmpdir(), "some-project", "src", "ota.js"),
    ];
    for (const p of allowed) {
      assert.ok(!selfDev.protectedSelfPath(p, { appSrcDir: appSrc, otaRoot }), "неожиданно заблокирован: " + p);
    }
  });

  await test("self-dev: сообщение об отказе содержит путь и подсказку", () => {
    const msg = selfDev.protectedSelfPathMessage(path.join(appSrc, "ota.js"), { appSrcDir: appSrc });
    assert.ok(msg.includes("заблокировано"), "нет слова «заблокировано»");
    assert.ok(msg.includes("make-ota.js"), "нет подсказки про make-ota.js");
  });
}

async function testHighlight() {
  // Модуль браузерный (window.Highlight) — подставляем минимальный шим.
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "highlight.js"), "utf8");
  const win = {};
  new Function("window", src + "\nreturn window.Highlight;")(win);
  const H = win.Highlight;

  const decode = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const strip = (html) => decode(html.replace(/<span class="tok-[\w-]+">/g, "").replace(/<\/span>/g, ""));

  const samples = [
    ["a.js", "const x = 1; // комм\nfunction f(a) { return `t ${a} < b & c`; }\n/* multi\nline */\nlet s = \"строка <тег> & амп\";\n"],
    ["a.ts", "export interface A<T> { x: T }\nclass B extends A<string> { async m() { await 1; } }\n"],
    ["a.json", '{ "key": "v", "n": 12.5e3, "b": true, "arr": [1, 2] }\n'],
    ["a.html", "<!DOCTYPE html>\n<div class=\"a\" data-x='1'>text & more</div>\n<!-- c <b> -->\n<br/>\n"],
    ["a.css", "/* c */\n.a, #b:hover { color: #fff; margin: 10px 2.5em 50%; content: \"x\"; }\n"],
    ["a.py", '#!/usr/bin/env python\n"""doc <html> & """\ndef f(x):\n    # c\n    return True if x is not None else False\n'],
    ["a.sh", '#!/bin/bash\necho "hi $USER ${HOME} <x>"\nif [ -f x ]; then cd /tmp && rm -rf y; fi\n'],
    ["a.sql", "-- c\nSELECT a, COUNT(*) FROM t WHERE x = 'a''b'; /* z */\n"],
    ["a.yml", '# c\nkey: value\nlist:\n  - a: "b"\n'],
    ["a.md", "# Заголовок\n\n```js\nconst a = 1;\n```\n\n- пункт\n> цитата [ссылка](https://x.y)\n"],
    ["a.txt", 'просто текст <b> & "строка"\n// не комментарий # тоже\n'],
    ["Dockerfile", 'FROM node:20\nRUN echo "hi" && npm i\n# c\n'],
  ];

  await test("highlight: текст после снятия тегов совпадает с исходным (12 файлов)", () => {
    for (const [name, code] of samples) {
      assert.strictEqual(strip(H.highlight(code, name)), code, "искажён текст: " + name);
    }
  });

  await test("highlight: язык определяется по расширению и имени файла", () => {
    assert.strictEqual(H.langOf("src/a/b.ts"), "js");
    assert.strictEqual(H.langOf("x.YML"), "yaml");
    assert.strictEqual(H.langOf("a.b.c.py"), "py");
    assert.strictEqual(H.langOf("Dockerfile"), "sh");
    assert.strictEqual(H.langOf(".env"), "sh");
    assert.strictEqual(H.langOf("noext"), "generic");
    assert.strictEqual(H.langOf(""), "generic");
  });

  await test("highlight: HTML в коде экранируется (живых тегов не появляется)", () => {
    const out = H.highlight('<script>alert(1)</script> & "x"', "x.js");
    assert.ok(out.indexOf("<script") === -1, "в выводе остался живой <script>");
    assert.ok(out.indexOf("&lt;script") !== -1, "нет экранирования <");
  });

  await test("highlight: ключевые слова, строки и комментарии подсвечиваются", () => {
    const js = H.highlight('const a = "s"; // c\n', "a.js");
    assert.ok(js.indexOf("tok-kw") !== -1, "нет ключевого слова");
    assert.ok(js.indexOf("tok-str") !== -1, "нет строки");
    assert.ok(js.indexOf("tok-com") !== -1, "нет комментария");
    assert.ok(H.highlight("def f():\n    return True\n", "a.py").indexOf("tok-kw") !== -1, "нет def в python");
    assert.ok(H.highlight('{ "k": 1 }', "a.json").indexOf("tok-key") !== -1, "нет ключа в json");
  });

  await test("highlight: countLines считает строки", () => {
    assert.strictEqual(H.countLines(""), 1);
    assert.strictEqual(H.countLines("a"), 1);
    assert.strictEqual(H.countLines("a\nb\n"), 3);
  });

  await test("highlight: очень большой текст не подсвечивается, но не теряется", () => {
    const big = "a".repeat(400 * 1024 + 10);
    assert.strictEqual(decode(H.highlight(big, "big.js")), big);
  });
}

// ── Запуск ──────────────────────────────────────────────────────────────────
// ── Память диалогов: сжатые памятки контекста по датам ─────────────────────
async function testContextMemory() {
  const store = require(path.join(ROOT, "src", "agent-store.js"));
  const mainSrc = backendSrc();
  const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
  const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  // Настройки памяти читаем в панели настроек, а не в оболочке (app.js: window.SettingsPanel).
  const panelSrc = uiFile("settings-panel.js");

  await test("память: выключено по умолчанию, инструменты, IPC и UI на месте", () => {
    assert.ok(/contextMemory: false,/.test(mainSrc), "нет contextMemory: false (должно быть выключено по умолчанию)");
    assert.ok(/contextMemoryDays: 30/.test(mainSrc), "нет contextMemoryDays");
    assert.ok(hasTool(mainSrc, "memoryList") && hasTool(mainSrc, "memorySearch"), "нет обработчиков memoryList/memorySearch");
    assert.ok(/onMemo: \(m\) => saveContextMemo\(settings, m, emit\)/.test(mainSrc), "runAi не подключает onMemo");
    assert.ok(/function saveContextMemo\(settings, entry, emit\)/.test(mainSrc), "нет saveContextMemo");
    for (const ch of ["memory:stats", "memory:days", "memory:openDir", "memory:clear"]) {
      assert.ok(mainSrc.includes('ipcMain.handle("' + ch + '"'), "нет IPC " + ch);
    }
    for (const fn of ["memoryStats", "memoryDays", "memoryOpenDir", "memoryClear"]) {
      assert.ok(preloadSrc.includes(fn + ":"), "нет preload." + fn);
    }
    assert.ok(/name: "memoryList"/.test(coreSrc) && /name: "memorySearch"/.test(coreSrc), "нет описаний инструментов");
    assert.ok(/noteDelete, (diaryWrite, diaryRead, )?memoryList, memorySearch, (todoWrite, )?checkpointSave/.test(coreSrc), "инструменты не в списке промпта");
    assert.ok(/"memoryList", "memorySearch",/.test(coreSrc), "память не в ядре инструментов (тесный контекст)");
    assert.ok(/memory_list: "memoryList"/.test(coreSrc), "нет алиасов инструментов");
    assert.ok(htmlSrc.includes('id="s-context-memory"'), "нет галочки в настройках");
    assert.ok(htmlSrc.includes('data-tab="memory"') && htmlSrc.includes('data-tab-body="memory"'), "нет вкладки настроек");
    assert.ok(panelSrc.includes('getSettings().contextMemory = !!$("s-context-memory").checked'), "галочка не сохраняется");
    assert.ok(panelSrc.includes("renderMemoryStatus"), "нет отображения статуса памяти");
  });

  await test("память: сохранение, список дней, чтение и поиск", () => {
    const ud = tmpdir("ctxmem-");
    const r1 = store.contextMemorySave(ud, {
      ts: new Date(2026, 8, 5, 14, 3, 0).getTime(),
      memo: "Мы делали деплой в Yandex Cloud и починили ycLogs.",
      messages: [
        { role: "user", content: "задеплой контейнер" },
        { role: "assistant", content: "готово, URL получен", tool_calls: [{ function: { name: "ycDeploy" } }] },
      ],
      provider: "openai",
      model: "gpt-4o",
      workDir: "C:/proj/domofon",
    });
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.day, "2026-09-05");
    assert.strictEqual(r1.count, 1);
    store.contextMemorySave(ud, { ts: new Date(2026, 8, 5, 18, 0, 0).getTime(), memo: "Починили Postbox.", messages: [], provider: "openai" });
    store.contextMemorySave(ud, { ts: new Date(2026, 8, 3, 10, 0, 0).getTime(), memo: "Обсуждали браузер и CDP.", messages: [], provider: "anthropic", model: "claude" });

    const days = store.contextMemoryDays(ud);
    assert.deepStrictEqual(days.map((d) => d.date), ["2026-09-05", "2026-09-03"], "дни неверны: " + JSON.stringify(days));
    assert.strictEqual(days[0].count, 2);

    const day = store.contextMemoryRead(ud, "2026-09-05");
    assert.strictEqual(day.ok, true, day.error);
    assert.strictEqual(day.count, 2);
    assert.strictEqual(day.memos[0].time, "18:00", "свежая памятка должна идти первой");
    assert.ok(day.memos[0].memo.includes("Postbox"));
    assert.strictEqual(day.memos[1].messages, 2, "число сжатых сообщений потеряно");
    assert.strictEqual(store.contextMemoryRead(ud, "не-дата").ok, false);

    const search = store.contextMemorySearch(ud, { query: "ycLogs" });
    assert.strictEqual(search.ok, true, search.error);
    assert.strictEqual(search.count, 1);
    assert.strictEqual(search.matches[0].date, "2026-09-05");
    assert.ok(/ycLogs/.test(search.matches[0].snippet), "фрагмент не найден: " + search.matches[0].snippet);
    assert.strictEqual(store.contextMemorySearch(ud, { query: "Починили", date: "2026-09-03" }).count, 0, "фильтр по дате не работает");
    assert.strictEqual(store.contextMemorySearch(ud, { query: "" }).ok, false);
    assert.strictEqual(store.contextMemorySearch(ud, { query: "задеплой" }).count, 1, "поиск не заглядывает в сжатые шаги");

    const md = fs.readFileSync(path.join(store.contextMemoryDir(ud), "2026-09-05", "day.md"), "utf8");
    assert.ok(/# Сжатые памятки контекста за 2026-09-05/.test(md), "нет заголовка day.md");
    assert.ok(md.includes("Мы делали деплой в Yandex Cloud"), "day.md не содержит памятку");
    assert.ok(md.includes("ycDeploy"), "day.md не содержит имён инструментов");
  });

  await test("память: секреты маскируются в памятке и в шагах", () => {
    const ud = tmpdir("ctxmem-sec-");
    const r = store.contextMemorySave(ud, {
      memo: "Ключ sk-proj-abcdefghijklmnopqrstuvwxyz0123 и AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      messages: [{ role: "user", content: "Bearer abcdefghijklmnopqrstuvwxyz123456" }],
      provider: "openai",
    });
    assert.strictEqual(r.ok, true, r.error);
    const text = JSON.stringify(store.contextMemoryRead(ud, r.day));
    assert.ok(!text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123"), "ключ OpenAI не замаскирован");
    assert.ok(!text.includes("AIzaSyA1234567890abcdefghijklmnopqrstuvw"), "ключ Google не замаскирован");
    assert.ok(!text.includes("abcdefghijklmnopqrstuvwxyz123456"), "Bearer-токен не замаскирован");
    assert.ok(text.includes("[секрет скрыт]"), "нет пометки о маскировке");
    // строки с NUL-байтами и приватные ключи не ломают запись
    const pk = store.redactSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----");
    assert.ok(!pk.includes("MIIabc"), "приватный ключ не скрыт");
  });

  await test("память: автоочистка старых дней, статистика и ручная очистка", () => {
    const ud = tmpdir("ctxmem-prune-");
    for (let i = 1; i <= 5; i++) {
      store.contextMemorySave(ud, { ts: new Date(2026, 7, i, 12, 0, 0).getTime(), memo: "день " + i, messages: [], provider: "openai" });
    }
    assert.strictEqual(store.contextMemoryDays(ud).length, 5);
    const pr = store.contextMemoryPrune(ud, 2);
    assert.strictEqual(pr.removed, 3, "удалено не то число дней: " + pr.removed);
    assert.deepStrictEqual(store.contextMemoryDays(ud).map((d) => d.date), ["2026-08-05", "2026-08-04"]);

    const st = store.contextMemoryStats(ud);
    assert.strictEqual(st.days, 2);
    assert.strictEqual(st.memos, 2);
    assert.ok(st.bytes > 0, "не посчитан размер");
    assert.strictEqual(st.newest, "2026-08-05");
    assert.strictEqual(st.oldest, "2026-08-04");
    assert.ok(st.dir.includes("context-memory"), "неверная папка: " + st.dir);

    const cl = store.contextMemoryClear(ud, "2026-08-05");
    assert.strictEqual(cl.removedDays, 1);
    assert.strictEqual(cl.removedMemos, 1);
    assert.strictEqual(store.contextMemoryClear(ud, "").removedDays, 1);
    assert.strictEqual(store.contextMemoryDays(ud).length, 0);
    assert.strictEqual(store.contextMemoryStats(ud).days, 0);
    assert.strictEqual(store.contextMemoryClear(ud, "плохо").ok, false);
  });

  await test("память: пустая памятка файлов не создаёт", () => {
    const ud = tmpdir("ctxmem-empty-");
    const r = store.contextMemorySave(ud, { memo: "   ", provider: "openai" });
    assert.strictEqual(r.ok, false);
    assert.ok(!fs.existsSync(store.contextMemoryDir(ud)), "создана пустая папка");
  });

  // ── Хук onMemo в реальном createContextManager ───────────────────────────
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ПАМЯТКА: починили ycLogs и деплой." } }] }),
    };
  };
  try {
    const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    await test("память: createContextManager зовёт onMemo при сжатии; ошибка хука не ломает сжатие", async () => {
      const big = "строчка контекста ".repeat(120);
      const messages = [{ role: "system", content: "sys" }];
      for (let i = 0; i < 10; i++) {
        messages.push({ role: "user", content: big + " u" + i });
        messages.push({ role: "assistant", content: big + " a" + i });
      }
      messages.push({ role: "user", content: "текущий вопрос" });
      const settings = { provider: "openai", model: "gpt-4o", openaiUrl: "https://example.invalid/v1", openaiApiKey: "k" };
      const got = [];
      const cm = core.createContextManager({ settings, planMode: false, onMemo: (m) => got.push(m) });
      const out = await cm.manage(messages, 4000);
      assert.strictEqual(got.length, 1, "onMemo не вызван (или вызван не раз): " + got.length);
      assert.ok(/ПАМЯТКА/.test(got[0].text), "текст памятки не передан");
      assert.strictEqual(got[0].provider, "openai");
      assert.strictEqual(got[0].model, "gpt-4o");
      assert.ok(Array.isArray(got[0].messages) && got[0].messages.length >= 10, "исходные сообщения не переданы");
      assert.ok(calls.length >= 1, "нет запроса на сжатие");
      assert.ok(Array.isArray(out) && out.length, "manage вернул пусто");
      assert.ok(out.some((m) => String(m.content || "").includes("ПАМЯТКА")), "памятка не попала в контекст");

      const cm2 = core.createContextManager({ settings, planMode: false });
      await cm2.manage(messages, 4000);
      assert.strictEqual(got.length, 1, "вызвался чужой хук");

      const cm3 = core.createContextManager({ settings, planMode: false, onMemo: () => { throw new Error("бум"); } });
      const out3 = await cm3.manage(messages, 4000);
      assert.ok(Array.isArray(out3) && out3.length, "ошибка хука сломала manage");
    });
  } finally {
    global.fetch = realFetch;
  }
}

// ── Строки действий агента и группа работ (этап 3.7, часть 5) ───────────────
// Модуль вынесен из app.js. Проверяем ПОВЕДЕНИЕ: как из tool-сообщения собирается
// компактная строка (значок, подпись, цель, состояние, подробности), когда путь
// становится ссылкой на файл, и как строки складываются в группу «Выполняю
// действия · N», которая закрывается по концу ответа и начинается заново.
// Дозор запуска окна (boot-guard.js): «пусто в чате» должно быть объяснено словами.
// Проверяем и решения (чистые), и подписку на игрушечном DOM: настоящая плашка в
// живом окне проверяется в сквозном прогоне десктопа (scripts/live-desktop.js).
// Обновление кода (OTA): приложение судит, какой код грузить, по ВЕРСИИ КОДА в наборе,
// а не по номеру набора. Жалоба, ради которой это заведено: человек обновил папку
// проекта из репозитория, а приложение продолжало запускать старый код из набора
// (номер набора 1.5.125 выглядел «новее» кода 1.5.121).
async function testOtaCodeVersion() {
  await test("обновление кода: решает версия кода, а не номер набора", () => {
    // 1. Набор несёт версию кода внутри себя — иначе судить не по чему.
    const makeOta = fs.readFileSync(path.join(ROOT, "scripts", "make-ota.js"), "utf8");
    assert.ok(/codeVersion: pkg\.version/.test(makeOta), "сборщик набора не пишет версию кода в манифест");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "ota", "manifest.json"), "utf8"));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.strictEqual(manifest.codeVersion, pkg.version, "версия кода в наборе не совпадает с package.json");

    // 2. Применённый набор помнит и номер, и версию кода; поиск обновления смотрит на код.
    const otaSrc = fs.readFileSync(path.join(ROOT, "src", "ota.js"), "utf8");
    assert.ok(/codeVersion: manifest\.codeVersion/.test(otaSrc), "применённый набор не запоминает версию кода");
    assert.ok(/m\.codeVersion \|\| m\.version/.test(otaSrc), "поиск обновления не смотрит на версию кода набора");
    assert.ok(/codeVersion: \(inst && inst\.codeVersion\)/.test(otaSrc), "статус обновлений не отдаёт версию кода");

    // 3. Панель показывает версию кода отдельно от номера набора и не молчит про пустые источники.
    const panel = uiFind("  async function renderOtaStatus() {");
    assert.ok(/setSbVersion\(code \|\| "базовая"\)/.test(panel.code), "строка состояния не получает версию кода");
    assert.ok(/применён набор/.test(panel.code), "панель не различает номер набора и версию кода");
    assert.ok(/Источников обновлений нет/.test(panel.code), "панель молчит, когда папок-источников нет");
    assert.ok(/st\.candidate/.test(panel.code), "панель не говорит, что за обновление доступно");

    // 4. Правило загрузки кода: собираем bootstrap.js в песочнице с поддельными
    //    electron и fs и спрашиваем его решение по четырём раскладам.
    const vm = require("vm");
    function bootDecision(files) {
      const norm = (p) => String(p).replace(/\\/g, "/");
      // fs подделываем ОДНИМ объектом и отдаём его же на require("fs"): bootstrap берёт
      // файловую систему через require, и подделка иначе не попала бы в него вовсе.
      const fakeFs = {
        readFileSync: (p) => {
          const key = norm(p);
          if (key === "/userData/ota/current/version.json") return JSON.stringify(files.applied);
          if (key === "/app/package.json") return JSON.stringify({ version: files.installed });
          throw new Error("нет файла " + key);
        },
        existsSync: (p) => {
          const key = norm(p);
          if (!files.applied) return false;
          return key.indexOf("/userData/ota/current") === 0;
        },
        rmSync() {},
        renameSync() {},
      };
      const sandbox = {
        module: { exports: {} },
        __dirname: "/app/src",
        console: { error() {}, warn() {}, log() {} },
        path: path,
        process: { env: {}, execPath: "/usr/bin/electron" },
        require: (id) => {
          if (id === "module") return { _resolveFilename: () => "", _nodeModulePaths: () => [] };
          if (id === "electron") return { app: { getPath: () => "/userData" } };
          if (id === "path") return require("path");
          if (id === "fs") return fakeFs;
          return {}; // src/main.js и прочее — заглушка: загрузку кода проверяет живой прогон
        },
        fs: fakeFs,
      };
      vm.runInNewContext(fs.readFileSync(path.join(ROOT, "src", "bootstrap.js"), "utf8"), sandbox, { filename: "bootstrap.js" });
      return sandbox.module.exports;
    }

    // Жалоба дословно: обновил папку проекта (код 1.5.121), а грузился набор 1.5.125 с кодом 1.5.114.
    const stuck = bootDecision({ installed: "1.5.121", applied: { version: "1.5.125", codeVersion: "1.5.114" } });
    assert.strictEqual(stuck.otaNewerThanInstalled(), false, "старый набор перекрывает свежий код из папки проекта");
    assert.strictEqual(bootDecision({ installed: "1.5.121", applied: { version: "1.5.133", codeVersion: "1.5.121" } }).otaNewerThanInstalled(), false, "набор из того же кода перекрывает код приложения");
    assert.strictEqual(bootDecision({ installed: "1.5.99", applied: { version: "1.5.133", codeVersion: "1.5.121" } }).otaNewerThanInstalled(), true, "свежий набор не грузится на старом приложении");
    // Старые наборы без версии кода ведут себя как раньше — по номеру набора.
    assert.strictEqual(bootDecision({ installed: "1.5.114", applied: { version: "1.5.125" } }).otaNewerThanInstalled(), true, "набор без версии кода перестал грузиться");
    assert.strictEqual(bootDecision({ installed: "1.5.125", applied: { version: "1.5.125" } }).otaNewerThanInstalled(), false, "набор той же версии перекрывает установленный код");
  });
}

// ── Живая сессия PowerShell: один процесс на все системные справки ──────────
async function testPowerShellSession() {
  const ps = require(path.join(ROOT, "src", "win-ps.js"));
  const markers = ps.__markers();
  const { EventEmitter } = require("events");
  const mainSrc = backendSrc();

  // Фальшивый powershell.exe: считает, сколько раз его запускали, и отвечает
  // так же, как настоящая обёртка (маркеры BEGIN/END + код).
  function harness() {
    const state = { spawns: 0, last: null, reply: () => {}, onWrite: () => {} };
    ps.__setPlatformForTests(() => "win32");
    ps.__setSpawnForTests((file, args) => {
      state.spawns++;
      state.lastArgs = args;
      const c = new EventEmitter();
      c.stdin = {
        writable: true,
        write(s) {
          state.onWrite(String(s));
        },
      };
      c.stdout = new EventEmitter();
      c.stdout.setEncoding = () => {};
      c.stderr = new EventEmitter();
      c.kill = () => {
        c.killed = true;
      };
      state.last = c;
      return c;
    });
    state.reply = (out, code) =>
      state.last.stdout.emit("data", markers.BEGIN + "\n" + out + "\n" + markers.END + code + "\n");
    return state;
  }

  await test("живая PowerShell: рукопожатие один раз, дальше все скрипты в одном процессе", async () => {
    const h = harness();
    const real = [];
    let handshakes = 0;
    h.onWrite = (line) => {
      const script = Buffer.from(line.trim(), "base64").toString("utf8");
      if (script.indexOf(markers.HANDSHAKE) !== -1) {
        handshakes++;
        setTimeout(() => h.reply(markers.HANDSHAKE, 0), 1);
        return;
      }
      real.push(script);
      setTimeout(() => h.reply("вывод " + real.length, 0), 1);
    };
    try {
      const a = await ps.exec("Get-Date");
      const b = await ps.exec("Get-Item 'C:\\temp'");
      assert.strictEqual(a.ok, true, "первый скрипт не выполнился: " + JSON.stringify(a));
      assert.strictEqual(a.out, "вывод 1", "вывод разобран неверно: " + JSON.stringify(a.out));
      assert.strictEqual(b.out, "вывод 2", "второй скрипт не прошёл через ту же сессию");
      assert.deepStrictEqual(real, ["Get-Date", "Get-Item 'C:\\temp'"], "скрипты потерялись при base64-передаче");
      assert.strictEqual(handshakes, 1, "рукопожатие делается не один раз");
      assert.strictEqual(h.spawns, 1, "процесс PowerShell поднят больше одного раза");
      assert.strictEqual(ps.isRunning(), true, "сессия не держится между вызовами");
      const args = h.lastArgs || [];
      assert.ok(args.indexOf("-EncodedCommand") !== -1, "обёртка не уходит через -EncodedCommand");
      assert.strictEqual(args[0], "-NoProfile", "сессия грузит профиль (это те самые секунды)");
      const decoded = Buffer.from(args[args.length - 1], "base64").toString("utf16le");
      assert.ok(/while \(\$true\)/.test(decoded), "обёртка не читает команды в цикле");
      assert.ok(decoded.indexOf(markers.EXIT) !== -1, "обёртка не понимает команду выхода");
      assert.ok(decoded.indexOf("FromBase64String") !== -1, "обёртка не декодирует скрипт из base64");

      // Таймаут: сессия умирает, вызывающий получает noSession — и откатывается.
      h.onWrite = () => {};
      const t = await ps.exec("Start-Sleep 100", { timeoutMs: 1000 });
      assert.strictEqual(t.noSession, true, "таймаут не помечен как noSession (откат не сработает)");
      assert.strictEqual(h.last.killed, true, "зависшая сессия не убита");
      assert.strictEqual(ps.isRunning(), false, "умершая сессия осталась в состоянии «жива»");

      // Следующий вызов поднимает новую сессию, а не молча ломается.
      h.onWrite = (line) => {
        const script = Buffer.from(line.trim(), "base64").toString("utf8");
        setTimeout(() => h.reply(script.indexOf(markers.HANDSHAKE) !== -1 ? markers.HANDSHAKE : "ok", 0), 1);
      };
      const c2 = await ps.exec("'ещё'");
      assert.strictEqual(c2.ok, true, "сессия не перезапустилась после сбоя");
      assert.strictEqual(h.spawns, 2, "новая сессия не поднята");
    } finally {
      ps.shutdown();
      ps.__setSpawnForTests(null);
      ps.__setPlatformForTests(null);
    }
  });

  await test("живая PowerShell: провал рукопожатия → мгновенный откат, без зависаний", async () => {
    const h = harness();
    h.onWrite = () => setTimeout(() => h.reply("мусор вместо ответа", 0), 1);
    try {
      const a = await ps.exec("Get-Date");
      assert.strictEqual(a.noSession, true, "неудавшееся рукопожатие не включило откат");
      assert.ok(/не подтвердилась/.test(a.err || ""), "нет понятной причины отказа: " + a.err);
      assert.strictEqual(h.last.killed, true, "нерабочая сессия не убита");
      // Вторая попытка не должна снова поднимать процесс (это были бы секунды впустую).
      const b = await ps.exec("Get-Date");
      assert.strictEqual(b.noSession, true, "вторая попытка не откатилась");
      assert.strictEqual(h.spawns, 1, "после провала рукопожатия процесс поднимается заново");
    } finally {
      ps.shutdown();
      ps.__setSpawnForTests(null);
      ps.__setPlatformForTests(null);
    }
  });

  await test("живая PowerShell: подключена к справкам, кэш и откат на месте", () => {
    assert.ok(/async function psScript\(script, timeoutMs\)/.test(mainSrc), "нет psScript в main.js");
    assert.ok(/await winPs\.exec\(script, \{ timeoutMs: ms \}\)/.test(mainSrc), "psScript не использует живую сессию");
    assert.ok(
      /return spawnRaw\(\["powershell\.exe", "-NoProfile", "-NonInteractive", "-Command", script\]/.test(mainSrc),
      "нет отката на разовый запуск PowerShell"
    );
    assert.ok(
      !/spawnRaw\(\["powershell\.exe", "-NoProfile", "-NonInteractive", "-Command", ps\], \{ cwd: os\.homedir\(\), timeoutMs: 30000 \}\)/.test(mainSrc),
      "getSystemInfo по-прежнему поднимает процесс на каждый вопрос"
    );
    assert.ok(/cachedPs\("sysinfo", 30000/.test(mainSrc), "нет кэша конфигурации ПК");
    assert.ok(/cachedPs\("proc:win", 2000/.test(mainSrc), "нет кэша списка процессов");
    assert.ok(/cachedPs\(\s*"reg:"/.test(mainSrc), "нет кэша чтения реестра");
    assert.ok(/invalidatePsCache\("proc:"\)/.test(mainSrc), "killProcess не сбрасывает кэш процессов");
    assert.ok(/invalidatePsCache\("reg:"\)/.test(mainSrc), "registryWrite не сбрасывает кэш реестра");
    assert.ok(
      /\(v\) => \/__ERR__\|Cannot find\|не найден\|отказано\/i\.test\(v\.out\)/.test(mainSrc),
      "ошибка чтения реестра попадёт в кэш"
    );
  });
}

// ── Выдача секретов по назначению (1.5.84) ───────────────────────────────────
// Переменные агента раньше получала ЛЮБАЯ команда: и сборка проекта, и git, и
// облако. Теперь переменную можно выдать конкретному инструменту (или группе).
// Проверяем три слоя: правило выдачи в политике (включая опечатку, которая
// обязана СУЖАТЬ доступ, а не открывать его), фактическую выдачу окружения в
// модулях — вызовом, а не по тексту, — и связку интерфейса: настройки, канал
// policy:groups, мост телефона.
async function testSecretScopes() {
  const policy = require(path.join(ROOT, "src", "tool-policy.js"));

  await test("секреты: без ограничения — всем, с ограничением — только назначению", () => {
    const vals = { DB: "pg", API: "sk-1", TOKEN: "ghp_x" };
    const scopes = { API: ["terminal"], TOKEN: ["git.push"], DB: ["*"] };
    const keysFor = (cap) => Object.keys(policy.envForCapability(vals, scopes, cap)).sort();
    assert.deepStrictEqual(keysFor("terminal.execute"), ["API", "DB"], "группа terminal не получила выданное ей");
    assert.deepStrictEqual(keysFor("terminal.admin"), ["API", "DB"], "вторая capability группы не получила выданное");
    assert.deepStrictEqual(keysFor("git.push"), ["DB", "TOKEN"], "точная capability не получила своё");
    assert.deepStrictEqual(keysFor("git.read"), ["DB"], "переменная ушла туда, где её не выдавали");
    assert.deepStrictEqual(keysFor(""), ["DB"], "действие без инструмента получило ограниченное");
    assert.deepStrictEqual(keysFor("выдуманный"), ["DB"], "инструмент без политики получил ограниченное");
    assert.deepStrictEqual(Object.keys(vals), ["DB", "API", "TOKEN"], "набор значений изменён на месте");
  });

  await test("секреты: опечатка сужает доступ, а не открывает его", () => {
    const vals = { A: "1" };
    assert.deepStrictEqual(Object.keys(policy.envForCapability(vals, { A: ["termianl"] }, "terminal.execute")), [], "опечатка выдала переменную всем");
    assert.deepStrictEqual(Object.keys(policy.envForCapability(vals, { A: [] }, "terminal.execute")), [], "пустое ограничение выдало переменную");
    assert.deepStrictEqual(Object.keys(policy.envForCapability(vals, {}, "terminal.execute")), ["A"], "отсутствие записи перестало значить «всем»");
    assert.strictEqual(policy.scopeAllows("*", ""), true, "«*» не работает без имени инструмента");
    assert.strictEqual(policy.scopeAllows("git", "unknown"), false, "инструмент без политики получил ограниченное");
    assert.strictEqual(policy.scopeAllows("git", ""), false, "действие без имени получило ограниченное");
    assert.strictEqual(policy.scopeSummary({}, "A"), "всем командам", "сводка для неограниченной переменной неверна");
    assert.strictEqual(policy.scopeSummary({ A: ["git", "terminal"] }, "A"), "git, terminal", "сводка выдачи неверна");
  });

  await test("секреты: группы собираются из таблицы прав, а не из отдельного списка", () => {
    const groups = policy.scopeGroups();
    assert.ok(groups.length >= 15, "групп подозрительно мало: " + groups.length);
    const seen = new Map();
    for (const g of groups) {
      assert.ok(g.caps.length, "пустая группа " + g.group);
      assert.ok(g.tools > 0, "в группе " + g.group + " нет инструментов");
      for (const cap of g.caps) {
        assert.ok(!seen.has(cap), "capability в двух группах: " + cap);
        seen.set(cap, g.group);
        assert.strictEqual(policy.capabilityGroup(cap), g.group, "группа не совпадает с именем capability: " + cap);
        assert.ok(policy.toolsForCapability(cap).length > 0, "capability без инструментов: " + cap);
      }
    }
    for (const cap of policy.allCapabilities()) assert.ok(seen.has(cap), "capability вне групп выдачи: " + cap);
    // Каждая группа обязана реально отдавать выданное своему инструменту.
    for (const g of groups) {
      const got = Object.keys(policy.envForCapability({ S: "1" }, { S: [g.group] }, g.caps[0]));
      assert.deepStrictEqual(got, ["S"], "группа " + g.group + " не отдала переменную своему инструменту");
    }
  });

  await test("секреты: git-панель объявляет назначение по вызовам, клон идёт под своим", async () => {
    const { registerGitIpc } = require(path.join(ROOT, "src", "git-ipc.js"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-scope-"));
    const handlers = new Map();
    const asked = [];
    const wrapped = [];
    registerGitIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      path,
      fs,
      loadSettings: () => ({}),
      runGit: async (dir, args, settings, capability) => {
        asked.push(args[0] + ":" + capability);
        return { ok: true, out: "" };
      },
      sanitizeDir: (d) => String(d || "") || root,
      cloneRepoTo: async () => ({ ok: true, dir: root }),
      withCapability: async (cap, fn) => {
        wrapped.push(cap);
        return await fn();
      },
      pickCloneBase: () => ({ ok: true, dir: root }),
      stageAllSafe: async () => ({ ok: true }),
      setLastAgentRepoDir: () => {},
      setClonedRepoPending: () => {},
    });
    const call = (ch, ...a) => handlers.get(ch)(null, ...a);
    await call("git:status", root);
    await call("git:pull", root);
    await call("git:push", root);
    await call("git:commit", root, "правка");
    await call("git:clone", root, "https://github.com/user/repo");
    assert.ok(asked.includes("status:git.read"), "статус не объявил git.read — " + asked.join(", "));
    assert.ok(asked.includes("pull:git.clone"), "pull не объявил git.clone — " + asked.join(", "));
    assert.ok(asked.includes("push:git.push"), "push не объявил git.push — " + asked.join(", "));
    assert.ok(asked.some((a) => a.endsWith(":git.commit")), "коммит не объявил git.commit — " + asked.join(", "));
    assert.deepStrictEqual(wrapped, ["git.clone"], "клон идёт без своего назначения — " + wrapped.join(", "));
  });

  await test("секреты: системный раздел спрашивает окружение у назначения, а не берёт весь набор", async () => {
    const { createSystemStack } = require(path.join(ROOT, "src", "system-stack.js"));
    const asked = [];
    let seenEnv = null;
    const stack = createSystemStack({
      fs,
      path,
      os,
      spawn: (file, args, opts) => {
        seenEnv = opts && opts.env;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit("close", 0, null), 0);
        return child;
      },
      winPs: { exec: async () => ({ noSession: true, ok: true, code: 0, out: "", err: "" }) },
      probeEnv: () => ({ ...process.env }),
      stripAnsi: (x) => String(x || ""),
      runTerminalCommand: async () => "",
      live: {
        get agentEnv() {
          return { СЛИШКОМ_МНОГО: "всё сразу" };
        },
        envFor: (capability) => {
          asked.push(capability);
          return { SCOPE: String(capability) };
        },
      },
    });
    await stack.spawnRaw(["node", "-e", "1"], { capability: "custom.cap" });
    assert.deepStrictEqual(asked, ["custom.cap"], "назначение не дошло до main.js — " + asked.join(", "));
    assert.strictEqual(seenEnv && seenEnv.SCOPE, "custom.cap", "процесс не получил выданное назначению");
    assert.ok(!(seenEnv && "СЛИШКОМ_МНОГО" in seenEnv), "процесс получил окружение агента напрямую");
    const src = fs.readFileSync(path.join(ROOT, "src", "system-stack.js"), "utf8");
    assert.ok(src.indexOf("live.agentEnv") === -1, "system-stack всё ещё берёт окружение копией");
  });

  await test("секреты: envSet записывает выдачу, envList её показывает (живой вызов)", async () => {
    const { createAgentTools } = require(path.join(ROOT, "src", "agent-tools.js"));
    const state = { userAgentEnv: {}, agentEnv: {}, saved: null };
    const base = new Proxy({}, { get: () => () => undefined });
    const tools = createAgentTools(
      Object.assign(Object.create(base), {
        path,
        loadSettings: () => ({ agentEnv: { ...state.userAgentEnv }, agentEnvScopes: state.saved ? { ...state.saved.agentEnvScopes } : {} }),
        saveSettings: (s) => {
          state.saved = JSON.parse(JSON.stringify(s));
        },
        applyAgentEnv: () => {},
        ycAutoEnv: () => ({}),
        live: {
          agentEnv: () => state.agentEnv,
          userAgentEnv: () => state.userAgentEnv,
          envFor: () => ({}),
          scopeSummary: (name) => policy.scopeSummary(state.saved ? state.saved.agentEnvScopes : {}, name),
        },
      })
    );
    // Проверка не по тексту, а вызовом: раньше здесь падало «userAgentEnv is not defined»
    // (имя из main.js, не переданное через мост) — инструмент отвечал ошибкой.
    const set = await tools.envSet({ key: "DEPLOY_KEY", value: "с-1", scopes: ["git", "terminal"] }, {});
    assert.match(set, /задана/, "envSet не ответил: " + set);
    assert.match(set, /Выдача: git, terminal/, "выдача не подтверждена: " + set);
    assert.match(set, /только названные команды/, "не сказано, что значение получат только выбранные: " + set);
    assert.deepStrictEqual(state.saved && state.saved.agentEnvScopes && state.saved.agentEnvScopes.DEPLOY_KEY, ["git", "terminal"], "выдача не сохранена: " + JSON.stringify(state.saved && state.saved.agentEnvScopes));
    assert.strictEqual(state.saved.agentEnv.DEPLOY_KEY, "с-1", "переменная не сохранена в настройках");

    state.agentEnv = { DEPLOY_KEY: "с-1" };
    const list = await tools.envList({}, {});
    assert.match(list, /\[выдача: git, terminal\]/, "envList не сообщает выдачу: " + list);

    const plain = await tools.envSet({ key: "PLAIN_KEY", value: "x" }, {});
    assert.ok(!/Выдача/.test(plain), "лишнее упоминание выдачи там, где ограничения нет: " + plain);
    assert.ok(!state.saved.agentEnvScopes.PLAIN_KEY, "переменная без выдачи получила запись ограничения");

    const unset = await tools.envUnset({ key: "PLAIN_KEY" }, {});
    assert.match(unset, /удалена/, "envUnset не ответил: " + unset);
  });

  await test("секреты: одна точка выдачи в модуле окружения и никаких прямых подстановок", () => {
    for (const f of ["src/main.js", "src/agent-tools.js", "src/system-stack.js", "src/git-ipc.js", "src/tool-registry.js"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(src.indexOf("...agentEnv") === -1, f + ": окружение агента всё ещё подставляется напрямую");
      assert.ok(src.indexOf("...live.agentEnv") === -1, f + ": модуль берёт окружение копией, а не по назначению");
    }
    // Точка выдачи окружения живёт в src/agent-env.js (часть 22): оболочка только
    // собирает модуль и держит состояние через геттеры — прямых подстановок нет.
    const env = fs.readFileSync(path.join(ROOT, "src", "agent-env.js"), "utf8");
    assert.ok(env.includes("function envFor(capability)"), "нет единой точки выдачи окружения");
    assert.ok(env.includes("toolPolicy.envForCapability(agentEnv, agentEnvScopes, cap)"), "выдача не ограничивается настройками");
    assert.ok(env.includes("agentEnvScopes"), "настройки выдачи не читаются");
    assert.ok(/commandDumpsEnv\(command\)/.test(env), "команда-дамп окружения получает секреты");
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    // Само объявление и возврат назначения уехали в src/tool-registry.js (этап B,
    // часть 35): спрашиваем реестр, а у оболочки — что живое назначение окружения
    // передано ему экземпляром (копия дала бы пустое назначение и голый env).
    const registry = fs.readFileSync(path.join(ROOT, "src", "tool-registry.js"), "utf8");
    assert.ok(registry.includes("setCapability(toolPolicy.capabilityOf(name))"), "реестр не объявляет назначение инструмента");
    assert.ok(registry.includes("setCapability(prevCapability);"), "реестр не возвращает прежнее назначение");
    assert.ok(registry.indexOf("} finally {") < registry.indexOf("setCapability(prevCapability);"), "возврат назначения стоит не в finally: после сбоя агент остался бы с чужим окружением");
    assert.ok(/^\s*getCapability,$/m.test(main) && /^\s*setCapability,$/m.test(main), "реестр не получил живое назначение окружения из оболочки");
    // Группы выдачи отдаёт свой модуль: канал policy:groups уехал в
    // src/settings-ipc.js (этап B, часть 30), поэтому ищем его там.
    const policyIpcSrc = fs.readFileSync(path.join(ROOT, "src", "settings-ipc.js"), "utf8");
    assert.ok(policyIpcSrc.includes('ipcMain.handle("policy:groups"'), "окно не может получить группы выдачи");
    // Чистка сохранённой выдачи уехала вместе со схемой настроек — в src/settings-store.js.
    const storeSrc = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
    assert.ok(/s\.agentEnvScopes = toolPolicy\.normalizeScopes/.test(storeSrc), "сохранённая выдача не чистится политикой");
  });

  await test("секреты: выдача видна в настройках и доступна с телефона", () => {
    // Список переменных и выдача живут в src/renderer/secrets-panel.js (этап 3.5).
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const ui = uiAll();
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const mobile = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    const coreSrc = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    assert.ok(ui.includes("agentEnvScopes"), "настройки в окне не знают про выдачу");
    assert.ok(ui.includes('sel.className = "env-scope"'), "в списке переменных нет выбора выдачи");
    assert.ok(ui.includes("setEnvScope(k, sel.value)"), "выбор выдачи ни к чему не привязан");
    assert.ok(ui.includes("api.policyGroups"), "окно не спрашивает группы выдачи");
    assert.ok(ui.includes("envScopeLabel"), "группы не переводятся на человеческий язык");
    // Живые настройки, а не копия: список берёт их через getSettings() каждый раз.
    assert.ok(ui.includes("getSettings().agentEnvScopes"), "список и настройки не связаны живыми настройками");
    assert.ok(preload.includes('"policy:groups"'), "мост не отдаёт группы выдачи");
    assert.ok(mobile.includes('"policy:groups"'), "с телефона выдача недоступна");
    assert.ok(html.includes("выдача"), "в интерфейсе не объяснено, что такое выдача");
    assert.ok(coreSrc.includes("scopes: {"), "у envSet нет параметра выдачи");
  });
}

async function testVkFieldFixes() {
  const bt = require(path.join(ROOT, "src", "browser-tools"));

  await test("browserEval: DOM-узел, объект с циклами и undefined объясняются", () => {
    // Значение проходит сериализатор В СТРАНИЦЕ: иначе Playwright отдаёт
    // undefined для DOM-узла и объекта с циклами — и агент читал пустоту.
    assert.strictEqual(bt.unwrapEvalValue({ __p: "undef" }), undefined, "undefined не развернулся");
    assert.strictEqual(bt.unwrapEvalValue({ __p: "json", v: 5 }), 5, "число не развернулось");
    assert.strictEqual(bt.unwrapEvalValue({ __p: "text", s: "<b>x</b>" }), "<b>x</b>", "текст не развернулся");
    assert.strictEqual(bt.unwrapEvalValue("строка"), "строка", "обычное значение испортилось");
    const node = bt.evalValueToPlain({ nodeType: 1, outerHTML: "<div>Привет</div>" });
    assert.strictEqual(node.__p, "text", "DOM-узел не превращён в текст");
    assert.ok(/Привет/.test(node.s), "разметка узла потерялась: " + JSON.stringify(node));
    const cyc = {};
    cyc.self = cyc;
    const cycPlain = bt.evalValueToPlain(cyc);
    assert.ok(/цикл/i.test(cycPlain.s), "объект с циклами не объяснён: " + JSON.stringify(cycPlain));
    const big = [];
    big.push({ self: big });
    const arrPlain = bt.evalValueToPlain(big);
    assert.ok(/цикл|примитив/i.test(arrPlain.s), "массив с циклами не объяснён: " + JSON.stringify(arrPlain));
    assert.strictEqual(bt.evalValueToPlain(new Set([1, 2])).__p, "text", "Set не приведён к тексту");
    assert.strictEqual(bt.evalValueToPlain(new Map([[1, 2]])).__p, "text", "Map не приведён к тексту");

    // Переменная, которую код записал сам: значение берётся оттуда, а не «пусто».
    global.window = { __rows: [1, 2, 3], __title: "Диалоги", __none: undefined };
    try {
      const rows = bt.varValueInPage({ name: "__rows" });
      assert.strictEqual(rows.found, true, "массив не найден");
      assert.strictEqual(rows.kind, "array", "массив назван «" + rows.kind + "»");
      assert.strictEqual(bt.describeVar(rows), "3 элементов", "описание значения: " + bt.describeVar(rows));
      assert.strictEqual(bt.varValueInPage({ name: "__title" }).text, "Диалоги", "строка отдана не как есть");
      assert.strictEqual(bt.varValueInPage({ name: "__none" }).found, false, "пустая переменная считается найденной");
    } finally {
      delete global.window;
    }
  });

  await test("browserEval: код-операторы объясняется, значение берётся из window.__x", async () => {
    const Module_ = require("module");
    const origRequire = Module_.prototype.require;
    const seen = [];
    const page = {
      url: () => "https://vk.com/im",
      async title() { return "ВК"; },
      on() {},
      async goto() {},
      locator: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {}, async evaluate() { return ""; } }),
      getByRole: () => ({ first() { return this; }, async count() { return 1; }, async isVisible() { return true; }, async click() {} }),
      async evaluate(fn, arg) {
        seen.push({ fn, arg });
        // Первый вызов это набор операторов — так же, как в живом окне, падает
        // обёртка «const __v = (…);», и срабатывает запасной путь.
        if (typeof fn === "string" && fn.indexOf("const __v = (") >= 0) throw new Error("Unexpected token");
        if (fn && fn.name === "varValueInPage") return { found: true, kind: "array", text: "[1,2,3]", length: 3 };
        return undefined;
      },
    };
    Module_.prototype.require = function (id) {
      if (id === "playwright") {
        return { chromium: { executablePath: () => "", async launch() { return { isConnected: () => true, on() {}, async newPage() { return page; }, async close() {} }; }, async launchPersistentContext() { return { pages: () => [page], on() {}, async newPage() { return page; }, async close() {} }; } } };
      }
      return origRequire.apply(this, arguments);
    };
    try {
      bt.setProfileDir("");
      bt.setPlaywright(null);
      await bt.stop().catch(() => {});
      await bt.open({ url: "https://vk.com/im" });
      const r = await bt.evalJs({ script: "window.__rows = []; for (const c of document.querySelectorAll('.convo-item')) window.__rows.push(c);" });
      assert.ok(/набор операторов/.test(r), "не сказано, что это набор операторов: " + r.slice(0, 200));
      assert.ok(/\[1,2,3\]/.test(r), "значение из window.__rows не подставлено: " + r.slice(0, 200));
      assert.ok(/window\.__rows/.test(r), "не сказано, откуда взято значение: " + r.slice(0, 200));
      assert.ok(seen.some((c) => c.fn && c.fn.name === "varValueInPage"), "переменная со страницы не прочитана");
      // Ответ про undefined без переменной: подсказка про return и DOM-узел.
      const empty = await bt.evalJs({ script: "const a = 1; a + 1;" });
      assert.ok(/return/.test(empty), "нет подсказки про return: " + empty.slice(0, 200));
    } finally {
      Module_.prototype.require = origRequire;
      await bt.stop().catch(() => {});
      bt.setPlaywright(null);
    }
  });

  await test("browserReplay: образец найден в ТЕЛЕ бандла, а не в адресе", () => {
    const rec = {
      entries: [
        { method: "POST", url: "https://api.vk.ru/method/messages.getItems", type: "xhr", post: "v=5.285&access_token=старый", ts: 100 },
        // Поллинг идёт ПОЗЖЕ — раньше последним POST-запросом оказывался именно он,
        // и replay повторял чужой запрос со старой версией API («invalid v»).
        { method: "POST", url: "https://queuev4.vk.com/im374?act=a_check", type: "xhr", post: "key=abc&ts=1", ts: 200 },
        { method: "POST", url: "https://api.vk.ru/method/batch.call", type: "other", post: "v=5.285&batch=%5B%7B%22method%22%3A%22messages.getItems%22%7D%5D&access_token=живой", ts: 300 },
      ],
    };
    const s = bt.replayFindSample(rec, { match: "messages.getitems" });
    assert.ok(s, "образец не найден");
    assert.ok(/batch\.call/.test(s.url), "выбран не бандл: " + (s && s.url));
    assert.ok(/access_token=живой/.test(s.post), "тело образца не то: " + (s && s.post));
    // Только свежее: образцы раньше указанного времени не берём.
    const fresh = bt.replayFindSample(rec, { match: "messages.getitems", afterTs: 200 });
    assert.ok(fresh && fresh.ts === 300, "фильтр по свежести не работает: " + JSON.stringify(fresh && fresh.ts));
    const none = bt.replayFindSample(rec, { match: "messages.getitems", afterTs: 300 });
    assert.strictEqual(none, null, "нашёлся образец старше указанного времени");
    // Тип «other» (свой транспорт сайта) больше не отбрасывается.
    assert.ok(bt.replayFindSample(rec, {}), "запрос с типом other не найден");
  });

  await test("виртуальный список: aria-setsize не даёт объявить конец раньше времени", async () => {
    const makePage = (setsize) => {
      const page = {
        viewportSize: () => ({ width: 1000, height: 800 }),
        mouse: { move: async () => {}, wheel: async () => {} },
        evaluate: async (fn) => {
          if (fn && fn.name === "scrollStateInPage") return { y: 300, max: 900, vh: 800, docH: 1700, inner: [] };
          if (fn && fn.name === "itemsKeyInPage") return { count: 18, uniq: 18, joined: "k1~k18", sample: ["Диалог"], setsize: setsize };
          if (fn && fn.name === "scrollItemIntoViewInPage") return { ok: true, count: 18 };
          return "";
        },
      };
      return page;
    };
    const short = await bt.loadAllScroll(makePage(110), { times: 6, item: ".ConvoListItem" });
    assert.ok(/НЕ кончился/.test(short), "не сказал, что список не кончился: " + short.slice(0, 220));
    assert.ok(/из ~110/.test(short), "не названо обещанное число строк: " + short.slice(0, 220));
    assert.ok(/browserReplay/.test(short), "не подсказал взять данные запросом: " + short.slice(0, 240));
    // Список собрал всё, что обещал, — тогда «дальше пусто» честно.
    const full = await bt.loadAllScroll(makePage(18), { times: 6, item: ".ConvoListItem" });
    assert.ok(/конец списка/.test(full), "не объявил конец собранного списка: " + full.slice(0, 220));
    assert.ok(!/НЕ кончился/.test(full), "собранный список назван неполным");
  });

  await test("строка списка: ключ диалога берётся из data-peer-id, число строк — из aria-setsize", () => {
    const mk = (attrs, href) => ({
      getAttribute: (n) => (attrs[n] == null ? null : attrs[n]),
      querySelector: () => (href ? { getAttribute: () => href } : null),
      innerText: attrs.text || "",
      id: attrs.id || "",
    });
    global.document = {
      querySelectorAll: () => [
        mk({ "data-peer-id": "143668553", "aria-setsize": "110", text: "Евгения" }),
        mk({ "data-peer-id": "273947588", "aria-setsize": "110", text: "Дмитрий" }),
      ],
    };
    try {
      const st = bt.itemsKeyInPage({ item: ".ConvoListItem" });
      assert.strictEqual(st.count, 2, "строки не посчитаны: " + JSON.stringify(st));
      assert.strictEqual(st.uniq, 2, "уникальные ключи не посчитаны: " + JSON.stringify(st));
      assert.strictEqual(st.setsize, 110, "aria-setsize не прочитан: " + JSON.stringify(st));
      // Разные диалоги не должны склеиваться в один ключ.
      assert.ok(st.joined.indexOf("143668553") >= 0 && st.joined.indexOf("273947588") >= 0, "ключи диалогов потерялись: " + st.joined);
    } finally {
      delete global.document;
    }
  });

  await test("заметка: кириллический ключ переводится, а не отвергается", () => {
    const store = require(path.join(ROOT, "src", "agent-store"));
    const os = require("os");
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), "note-ru-"));
    const wd = path.join(ud, "proj");
    fs.mkdirSync(wd, { recursive: true });
    try {
      const saved = store.noteSave(ud, wd, "Клиенты ВК", "разбор переписок");
      assert.strictEqual(saved.ok, true, "заметка с русским ключом не сохранилась: " + saved.error);
      assert.strictEqual(saved.key, "klienty-vk", "ключ переведён не так: " + saved.key);
      assert.strictEqual(saved.transliterated, true, "о переводе ключа не сказано");
      assert.ok(/klienty-vk/.test(saved.message), "в ответе нет ключа: " + saved.message);
      const read = store.noteRead(ud, wd, "Клиенты ВК");
      assert.strictEqual(read.ok, true, "заметку не нашли по русскому ключу: " + read.error);
      assert.strictEqual(read.content, "разбор переписок", "содержимое вернулось не то");
      assert.strictEqual(store.noteDelete(ud, wd, "Клиенты ВК").ok, true, "удаление по русскому ключу не сработало");
      // Мусорный ключ по-прежнему отказ, но с объяснением перевода.
      const bad = store.noteSave(ud, wd, "   ", "x");
      assert.strictEqual(bad.ok, false, "пустой ключ принят");
      assert.ok(/переводится|перевод/i.test(bad.error), "отказ не объясняет перевод: " + bad.error);
      // Латинский ключ работает как раньше.
      const latin = store.noteSave(ud, wd, "architecture", "ok");
      assert.strictEqual(latin.key, "architecture", "латинский ключ изменился: " + latin.key);
      assert.strictEqual(latin.transliterated, false, "латинский ключ назван переведённым");
    } finally {
      fs.rmSync(ud, { recursive: true, force: true });
    }
  });

  await test("writeFile: синтаксис и JSON проверяются, окружение названо", () => {
    // Помощники ищем ПО ИМЕНИ во всём доме инструментов: writeFile уехал вместе с ними
    // в agent-tools-write.js (часть 40, заход 3b), и сторож обязан читать любой файл дома,
    // а не тот, где код лежал раньше (эта ловушка ловилась уже трижды).
    const homeDir = path.join(ROOT, "src");
    const homeFiles = fs.readdirSync(homeDir).filter((f) => /^agent-tools.*\.js$/.test(f));
    let src = "";
    for (const f of homeFiles) {
      const text = fs.readFileSync(path.join(homeDir, f), "utf8");
      if (text.includes("const CHECK_CODE_EXT")) { src = text; break; }
    }
    const start = src.indexOf("const CHECK_CODE_EXT");
    assert.ok(start >= 0, "не нашёл хелперы проверки файла");
    // Хвост модуля берём целиком и отдаём ему поддельный module: так сторож не зависит
    // от того, какой файл дома сейчас держит помощники (ни одного end-индекса не нужно).
    const mod = new Function("require", "module", src.slice(start) + "\nreturn { checkWrittenFile, envNoteFor };")(require, { exports: {} });
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-"));
    try {
      const good = path.join(dir, "good.js");
      fs.writeFileSync(good, "const a = 1;\n");
      assert.strictEqual(mod.checkWrittenFile(good, "const a = 1;\n").problem, "", "целый файл назван сломанным");
      const bad = path.join(dir, "bad.js");
      fs.writeFileSync(bad, "function f( {\n");
      const badRes = mod.checkWrittenFile(bad, "function f( {\n");
      assert.strictEqual(badRes.checked, true, "сломанный JS не проверен");
      assert.ok(/синтаксис/i.test(badRes.problem), "поломка синтаксиса не названа: " + badRes.problem);
      const json = path.join(dir, "x.json");
      assert.strictEqual(mod.checkWrittenFile(json, '{"a":1}').problem, "", "целый JSON назван сломанным");
      assert.ok(/JSON/.test(mod.checkWrittenFile(json, '{"a":}').problem), "сломанный JSON не пойман");
      assert.strictEqual(mod.checkWrittenFile(path.join(dir, "t.txt"), "текст").checked, false, "текст проверяется зря");
      assert.ok(/Node\.js|bun/.test(mod.envNoteFor(good)), "не сказано, чем запускать JS: " + mod.envNoteFor(good));
      assert.ok(/Python/.test(mod.envNoteFor(path.join(dir, "a.py"))), "не сказано, чем запускать Python");
      assert.strictEqual(mod.envNoteFor(path.join(dir, "t.txt")), "", "для текста выдумано окружение");
      assert.ok(/installPackage/.test(mod.envNoteFor(good)), "про зависимости не сказано");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Сам инструмент обязан показывать результат проверки в ответе.
    const toolsSrc = src.replace(/\r/g, "");
    assert.ok(/checkWrittenFile\(p, content\)/.test(toolsSrc), "writeFile не проверяет записанный файл");
    assert.ok(/envNoteFor\(p\)/.test(toolsSrc), "writeFile не говорит про окружение");
  });

  await test("миссия: повторный missionFinish объясняет, что она уже закрыта", () => {
    const missionStore = require(path.join(ROOT, "src", "mission-store"));
    const os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-done-"));
    try {
      const created = missionStore.missionCreate(dir, { goal: "разобрать заявки", steps: ["прочитать", "свести"] });
      assert.strictEqual(created.ok, true, "миссия не создалась: " + created.error);
      const fin = missionStore.missionFinish(dir, created.mission.id, { report: "готово", status: "done" });
      assert.strictEqual(fin.ok, true, "миссия не закрылась: " + fin.error);
      assert.strictEqual(missionStore.missionActive(dir), null, "закрытая миссия считается активной");
      // Именно это и читает обработчик, когда миссию закрывают второй раз.
      const last = missionStore.missionList(dir, { limit: 1 })[0];
      assert.ok(last, "список миссий пуст");
      assert.strictEqual(last.status, "done", "состояние закрытой миссии: " + last.status);
      assert.ok(last.finishedAt > 0, "у закрытой миссии нет времени закрытия");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const toolsSrc = toolsHomeSrc(); // миссии и план — уже своим модулем (часть 40, заход 6c)
    assert.ok(/missionList\(msDir4, \{ limit: 1 \}\)/.test(toolsSrc), "повторный missionFinish не ищет последнюю миссию");
    assert.ok(/уже закрыта/.test(toolsSrc), "повторный missionFinish не говорит, что миссия закрыта");
    assert.ok(/missionStart\(goal, steps\)/.test(toolsSrc), "не подсказано, как начать новую миссию");
    // План обязателен с первого шага миссии — про это сказано в ответе missionStart.
    assert.ok(/ПЕРВЫМ ДЕЛОМ вызови todoWrite/.test(toolsSrc), "в missionStart нет требования плана");
  });

  await test("справочники и описания знают новые факты про ВК и инструменты", () => {
    const guide = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "vk.md"), "utf8");
    assert.ok(/ConvoTitle__author/.test(guide), "нет селектора имени собеседника");
    assert.ok(/data-peer-id/.test(guide), "нет ключа диалога");
    assert.ok(/ConvoListItem__name/.test(guide) && /не существует/.test(guide), "выдуманный класс не помечен как несуществующий");
    assert.ok(/aria-setsize/.test(guide), "нет объяснения про aria-setsize");
    assert.ok(/batch\.call/.test(guide), "нет объяснения про бандл методов");
    assert.ok(/sessionStorage/.test(guide), "нет подсказки про sessionStorage");
    const core = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    assert.ok(/И В ТЕЛЕ запроса/.test(core), "browserReplay не говорит про поиск в теле");
    assert.ok(/aria-setsize/.test(core), "browserScroll не знает про aria-setsize");
    assert.ok(/klienty-vk/.test(core), "noteSave не объясняет перевод ключа");
    assert.ok(/check: false/.test(core), "writeFile не рассказывает про проверку");
    // Роль «Менеджер»: прямая просьба про код — не самовольство, но и не молчаливая
    // работа: сначала предложи роль «Разработчик» (suggestRole), потом дело.
    assert.ok(/прямо просит код/.test(core), "правило роли «Менеджер» осталось запрещающим");
    assert.ok(/СНАЧАЛА предложи роль «Разработчик»/.test(core), "роль «Менеджер» не предлагает переключиться перед работой с кодом");
    assert.ok(/suggestRole/.test(core), "нет инструмента предложения роли в промпте");
  });
}

module.exports = {
  testDevRun,
  testSecrets,
  testOta,
  testOtaCodeVersion,
  testVault,
  testSelfDev,
  testHighlight,
  testPowerShellSession,
  testSessionExtras,
  testContextMemory,
  testSecretScopes,
  testVkFieldFixes,
};

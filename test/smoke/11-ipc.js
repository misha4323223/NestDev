"use strict";
/* ─── Группа «Мосты IPC, сервер и почта» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 4.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  freePort,
  get,
  hasTool,
  mainOnlySrc,
  tmpdir,
  uiAll,
  uiFile,
} = H;

// ── 10. self-dev: защита критичной инфраструктуры самообновления ────────────
async function testServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });

  await test("server.js: стартует и отдаёт index.html", async () => {
    let ok = false;
    for (let i = 0; i < 30; i++) {
      const r = await get(port, "/");
      if (r.status === 200) { ok = true; break; }
      await new Promise((r2) => setTimeout(r2, 150));
    }
    assert.ok(ok, "сервер не поднялся");
  });

  await test("server.js: /api/llm с внутренним хостом → 403", async () => {
    const enc = encodeURIComponent("https://127.0.0.1:1234");
    const r = await get(port, "/api/llm/" + enc + "/v1/chat/completions");
    assert.strictEqual(r.status, 403, "статус " + r.status + ": " + r.body.slice(0, 80));
  });

  await test("server.js: /api/llm с http → 403", async () => {
    const enc = encodeURIComponent("http://ollama.com");
    const r = await get(port, "/api/llm/" + enc + "/v1/chat/completions");
    assert.strictEqual(r.status, 403, "статус " + r.status + ": " + r.body.slice(0, 80));
  });

  await test("server.js: /api/fetch с не-http URL → ошибка", async () => {
    const r = await get(port, "/api/fetch?url=" + encodeURIComponent("ftp://x"));
    assert.strictEqual(r.status, 200);
    assert.ok(/https?:/.test(r.body), "нет валидации URL: " + r.body.slice(0, 80));
  });

  await test("server.js: неизвестный путь → 404", async () => {
    const r = await get(port, "/nope-xyz");
    assert.strictEqual(r.status, 404);
  });

  child.kill();
}

// ── Yandex Cloud: логи внутренним API + встроенный yc CLI ──────────────────
// ── 6.5 mail: почта (SMTP/IMAP) ─────────────────────────────────────────────
async function testMail() {
  const mail = require(path.join(ROOT, "src", "mail.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("mail: пресеты серверов по домену адреса", () => {
    const g = mail.guessServers("user@gmail.com");
    assert.strictEqual(g.imapHost, "imap.gmail.com");
    assert.strictEqual(g.smtpPort, 465);
    assert.ok(/пароль приложения/.test(g.note), "нет подсказки про пароль приложения");
    assert.strictEqual(mail.guessServers("user@yandex.ru").imapHost, "imap.yandex.ru");
    assert.strictEqual(mail.guessServers("user@mail.ru").smtpHost, "smtp.mail.ru");
    const o = mail.guessServers("user@outlook.com");
    assert.strictEqual(o.starttls, true);
    assert.strictEqual(o.smtpPort, 587);
    const u = mail.guessServers("user@my-firm.ru");
    assert.strictEqual(u.preset, false);
    assert.strictEqual(u.imapHost, "imap.my-firm.ru");
    assert.strictEqual(mail.guessServers("").smtpHost, "");
  });

  await test("mail: письмо — тема RFC 2047, получатели, base64-тело, защита от инъекции", () => {
    const msg = mail.buildMessage({
      from: "Михаил <me@yandex.ru>",
      to: ["client@example.com", "boss@example.com"],
      subject: "КП: предложение",
      text: "Здравствуйте!\n.точка в начале",
      date: new Date("2026-09-11T10:20:30Z"),
    });
    assert.ok(/Subject: =\?UTF-8\?B\?/.test(msg), "тема не закодирована RFC 2047");
    assert.ok(msg.includes("To: client@example.com, boss@example.com"), "получатели не в To");
    assert.ok(/Date: \w{3}, \d{2} \w{3} \d{4}/.test(msg), "нет корректной даты");
    const body = msg.split("\r\n\r\n")[1].replace(/\s+/g, "");
    assert.ok(Buffer.from(body, "base64").toString("utf8").includes("точка в начале"), "тело не декодируется обратно");
    const injected = mail.buildMessage({ from: "a@b.ru", to: "c@d.ru", subject: "Тема\r\nBcc: hacker@evil.com", text: "x" });
    assert.ok(!/\r\nBcc:/i.test(injected), "прошла инъекция заголовка");
    const multi = mail.buildMessage({ from: "a@b.ru", to: "c@d.ru", subject: "s", text: "t", html: "<p>t</p>" });
    assert.ok(/multipart\/alternative/.test(multi) && /text\/html/.test(multi), "нет multipart/alternative");
  });

  await test("mail: windows-1251 и UTF-8 декодируются без потерь", () => {
    const win = Buffer.from([0xCF, 0xE0, 0xF0, 0xEE, 0xEB, 0xFC, 0x3A, 0x20, 0x37, 0x37, 0x37, 0x38, 0x38, 0x38]);
    assert.strictEqual(mail.decodeBytes(win, "windows-1251"), "Пароль: 777888");
    assert.strictEqual(mail.decodeBytes(Buffer.from("Привет", "utf8"), "UTF-8"), "Привет");
    // Письмо объявлено UTF-8, а байты на самом деле cp1251 — спасаем (частая беда рассылок).
    assert.strictEqual(mail.decodeBytes(win, "utf-8"), "Пароль: 777888");
  });

  await test("mail: разбор письма (тема, отправитель, код) и эвристика кода", () => {
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const raw = [
      "From: =?UTF-8?B?" + b64("Сервис Госуслуги") + "?= <noreply@gosuslugi.ru>",
      "Subject: =?UTF-8?B?" + b64("Ваш код подтверждения") + "?=",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("Ваш код: 483920"),
      "",
    ].join("\r\n");
    const m = mail.parseMessage(raw, 7);
    assert.strictEqual(m.subject, "Ваш код подтверждения");
    assert.ok(m.from.includes("Сервис Госуслуги"), "отправитель не декодирован");
    assert.strictEqual(m.fromAddress, "noreply@gosuslugi.ru");
    assert.strictEqual(mail.extractCode(m.text), "483920");
    assert.strictEqual(mail.extractCode("Your verification code is 55221"), "55221");
    assert.strictEqual(mail.extractCode("Код 9876 (2026)"), "9876", "год не должен считаться кодом");
    assert.strictEqual(mail.extractCode(""), null);
    assert.strictEqual(mail.extractCode("просто текст без цифр"), null);
    assert.ok(mail.isEmail("a@b.ru"));
    assert.ok(!mail.isEmail("мусор") && !mail.isEmail("a@b") && !mail.isEmail(""));
  });

  await test("mail: интеграция — инструменты агента, промпт, мост и настройки", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    for (const n of ["mailSend", "mailList", "mailCode"]) assert.ok(names.includes(n), "нет инструмента " + n);
    const prompt = core.SYSTEM_PROMPT || "";
    assert.ok(/Почта \(SMTP\/IMAP/.test(prompt), "в промпте нет правила про почту");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    for (const s of ["mail:test", "mail:recent", "mail:testSend"]) assert.ok(preload.includes(s), "в preload нет " + s);
    const main = backendSrc();
    assert.ok(main.includes('require("./mail.js")'), "main.js не подключает mail.js");
    for (const tool of ["mailSend", "mailList", "mailCode"]) assert.ok(hasTool(main, tool), "в бэкенде нет инструмента " + tool);
    assert.ok(main.includes('ipcMain.handle("mail:test"'), "в бэкенде нет канала mail:test");
    const secrets = fs.readFileSync(path.join(ROOT, "src", "secrets.js"), "utf8");
    assert.ok(secrets.includes('"mailPassword"'), "пароль почты не в списке секретов");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    for (const id of ["s-mail-address", "s-mail-pass", "s-mail-imap-host", "s-mail-smtp-host", "s-mail-allow-send", "btn-mail-test"]) {
      assert.ok(html.includes('id="' + id + '"'), "в index.html нет " + id);
    }
    // Сбор полей настроек живёт в панели настроек (app.js: window.SettingsPanel).
    assert.ok(uiFile("settings-panel.js").includes('getSettings().mailAddress = $("s-mail-address")'), "настройки не сохраняют адрес почты");
    assert.ok(uiAll().includes("mailDoTest") && uiAll().includes("mailFillServers"), "в интерфейсе нет логики почты");
  });
}

// ── Реестр инструментов: обработчики получают окружение main.js ──────────────
// Модуль инструментов собран аргументами: имя, оставшееся в main.js и не переданное
// через deps, даёт у пользователя «X is not defined» ровно в этом инструменте.
// Текстовая проверка связи есть в backend-wiring.js, но она смотрит разбор — поэтому
// здесь проверяем ПО ФАКТУ: заглушки запоминают, кто их позвал, а живые значения —
// что запись идёт через сеттер. Так нашлись stripAnsi, spawnCollect и auxConfig.
// ── Вынесенный почтовый мост ────────────────────────────────────────────────
// Конфигурация подключения и каналы почты переехали из main.js в mail-ipc.js
// (1.5.75). Проверяем ровно то, что раньше жило вперемешку с остальным: пустые
// поля берутся из пресета провайдера, заполненные не перетираются, а без настроек
// в сеть не уходит НИ ОДИН запрос.
async function testMailIpc() {
  const { registerMailIpc } = require(path.join(ROOT, "src", "mail-ipc.js"));
  const mailMod = require(path.join(ROOT, "src", "mail.js"));
  const mainSrc = mainOnlySrc(); // проверяем: в main.js почты больше нет
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src", "mail-ipc.js"), "utf8");

  const build = (extra) => {
    const handlers = new Map();
    const api = registerMailIpc(Object.assign({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      mail: mailMod,
      loadSettings: () => ({}),
    }, extra || {}));
    return { api, handlers };
  };

  await test("почта: каналы уехали из main.js, конфигурация осталась доступной", () => {
    for (const ch of ["mail:test", "mail:recent", "mail:testSend"]) {
      assert.ok(!mainSrc.includes('ipcMain.handle("' + ch + '"'), "канал остался в main.js: " + ch);
      assert.ok(ipcSrc.includes('ipcMain.handle("' + ch + '"'), "канал не найден в mail-ipc.js: " + ch);
    }
    assert.ok(!/^function mailConfig\(/m.test(mainSrc), "mailConfig остался в main.js");
    assert.ok(mainSrc.includes('require("./mail-ipc.js")'), "main.js не подключает почтовый мост");
    assert.ok(/const \{ mailConfig \} = registerMailIpc/.test(mainSrc), "main.js не берёт конфигурацию из моста");
    assert.strictEqual(typeof build().api.mailConfig, "function", "мост отдаёт mailConfig");
  });

  await test("почта: пустое берётся из пресета, заполненное не перетирается", () => {
    const preset = build({ loadSettings: () => ({ mailAddress: "user@gmail.com" }) }).api.mailConfig();
    assert.strictEqual(preset.address, "user@gmail.com", "адрес на месте");
    assert.strictEqual(preset.user, "user@gmail.com", "логин по умолчанию — сам адрес");
    assert.ok(/gmail/.test(preset.imapHost) && /gmail/.test(preset.smtpHost), "серверы из пресета Gmail: " + preset.imapHost + " / " + preset.smtpHost);
    assert.strictEqual(preset.imapPort, 993, "IMAP по умолчанию — 993");
    assert.strictEqual(preset.smtpPort, 465, "SMTP по умолчанию — 465");
    assert.strictEqual(preset.allowSend, false, "отправка агентом выключена по умолчанию");

    const custom = build({
      loadSettings: () => ({
        mailAddress: "a@b.ru",
        mailUser: "логин",
        mailImapHost: "imap.example.ru",
        mailImapPort: "1143",
        mailSmtpPort: "2525",
        mailStarttls: true,
        mailAllowAgentSend: true,
      }),
    }).api.mailConfig();
    assert.strictEqual(custom.imapHost, "imap.example.ru", "заполненный хост не перетирается пресетом");
    assert.strictEqual(custom.imapPort, 1143, "порт приводится к числу");
    assert.strictEqual(custom.smtpPort, 2525, "порт SMTP приводится к числу");
    assert.strictEqual(custom.starttls, true, "STARTTLS читается из настроек");
    assert.strictEqual(custom.user, "логин", "свой логин важнее адреса");
    assert.strictEqual(custom.allowSend, true, "разрешение отправки доходит до конфигурации");
  });

  await test("почта: без настроек в сеть не уходит ни один запрос", async () => {
    let called = 0;
    const stub = {
      listRecent: async () => { called++; return { ok: true, total: 0, messages: [] }; },
      sendMail: async () => { called++; return { ok: true }; },
      extractCode: () => "",
      guessServers: () => ({}),
    };
    const { handlers } = build({ mail: stub, loadSettings: () => ({}) });
    const test = await handlers.get("mail:test")();
    assert.strictEqual(test.ok, false, "без адреса проверка связи не проходит");
    assert.ok(/адрес почты/i.test(test.error), "сказано, чего не хватает: " + test.error);
    assert.ok(test.servers && "imapHost" in test.servers, "серверы отдаются интерфейсу для подсказки");
    const recent = await handlers.get("mail:recent")(null, 5);
    assert.strictEqual(recent.ok, false, "без настроек письма не читаются");
    const send = await handlers.get("mail:testSend")();
    assert.strictEqual(send.ok, false, "без настроек письмо не отправляется");
    assert.strictEqual(called, 0, "в сеть не ушло ни одного запроса");
  });
}

// ── Вынесенные модули: стражи, файловая панель и git ────────────────────────
// Первый тест — страховка от самой дорогой ошибки при разрезании файла: модуль
// ссылается на имя, которое осталось в main.js, но не передано через deps.
// Такая ошибка не видна ни синтаксической проверке, ни тестам, которые не ходят
// в эту ветку кода, — она падает уже у пользователя. Именно так нашлись
// stageAllSafe, fs и path в git-мосте.
async function testFsGitIpc() {
  const { registerFsIpc } = require(path.join(ROOT, "src", "fs-ipc.js"));
  const { registerGitIpc } = require(path.join(ROOT, "src", "git-ipc.js"));

  await test("вынесенные модули: ни одного имени из main.js без внедрения", () => {
    // Разбор живёт отдельным модулем: он длинный, и та же проверка нужна, чтобы
    // находить пропуски при следующем разрезании файла.
    const { scanWiring } = require(path.join(ROOT, "test", "backend-wiring.js"));
    const modules = ["yc-service.js", "yc-ipc.js", "deploy-ipc.js", "mail-ipc.js", "fs-ipc.js", "git-ipc.js", "agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js", "agent-tools-devtools.js", "agent-tools-media.js", "agent-tools-vault.js", "agent-tools-env.js", "agent-tools-browser.js", "agent-tools-sheets.js", "system-stack.js", "mission-ipc.js", "model-ipc.js", "github-ipc.js", "settings-store.js", "paths-git.js", "project-search.js", "undo-store.js", "bg-processes.js", "screens.js", "rate-limiters.js", "tool-helpers.js", "project-analysis.js", "site-guides.js", "terminal-panel.js", "app-window.js", "lifecycle.js", "run-mission.js", "run-tools.js", "run-retry.js", "run-round.js", "run-calls.js", "run-strict.js", "run-batch.js", "run-nudge.js", "agent-env.js", "shell-tools.js", "tasks-reminders.js", "run-ai.js", "browser-ipc.js", "git-stage.js", "chats-ipc.js", "memory-ipc.js", "settings-ipc.js", "mobile-ipc.js", "projects-ipc.js", "preview-ipc.js", "ota-ipc.js", "project-brief.js", "run-ipc.js", "tool-registry.js", "run-context.js", "ask-wait.js", "agent-data.js", "role-folders.js", "net-proxy.js", "net-proxy-ipc.js"];
    const r = scanWiring(ROOT, modules, fs, path);
    assert.deepStrictEqual(r.missing, [], "модули ссылаются на состояние main.js без внедрения: " + r.missing.join(", "));
  });

  await test("порядок в main.js: значение не читается раньше объявления", () => {
    // Третья ошибка разреза — и самая дорогая: у `const` чтение до объявления это
    // не undefined, а падение всего окна при загрузке. Так упало приложение после
    // части 75: модуль денег начал получать машины и сеть, а постройка машин
    // осталась ниже по файлу («Cannot access 'ycCompute' before initialization»).
    const { scanMainOrder } = require(path.join(ROOT, "test", "backend-wiring.js"));
    const found = scanMainOrder(fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8"));
    assert.deepStrictEqual(found, [], "main.js читает объявленное ниже: " + found.join(", "));
  });

  await test("страж порядка: ловит чтение до объявления и не тревожит верную проводку", () => {
    // Страж без негативного контроля бесполезен: он либо молчит, либо ругается на
    // верную проводку. Отложенные стрелки и геттеры моста live законны — их тела
    // исполняются в момент вызова, а не в строке объявления.
    const { scanMainOrder } = require(path.join(ROOT, "test", "backend-wiring.js"));
    const broken = [
      "const ycBilling = createYcBilling({ ycCompute, ycVpc });",
      "const ycVpc = createYcVpc({ fetchJson });",
      "const ycCompute = createYcCompute({ fetchJson });",
    ].join("\n");
    assert.deepStrictEqual(
      scanMainOrder(broken),
      ["ycCompute (строка 1, объявлено в 3)", "ycVpc (строка 1, объявлено в 2)"],
      "чтение до объявления не поймано"
    );
    const fine = [
      "const ycVpc = createYcVpc({ fetchJson });",
      "const ycCompute = createYcCompute({ fetchJson });",
      "const ycBilling = createYcBilling({ ycCompute, ycVpc });",
      "const wiring = createWiring({ window: () => mainWindow, live: { get mainWindow() { return mainWindow; } } });",
      "let mainWindow = null;",
      "function later() { return ycCdn; }",
      "const ycCdn = createYcCdn({});",
    ].join("\n");
    assert.deepStrictEqual(scanMainOrder(fine), [], "верная проводка принята за ошибку");
    const props = [
      "const a = f({ ycCompute: 1, ycVpc() { return 2; } });",
      "const ycCompute = createYcCompute({});",
    ].join("\n");
    assert.deepStrictEqual(scanMainOrder(props), [], "ключ свойства принят за обращение к имени");
  });

  await test("вынесенные модули: изменяемое значение меняется через сеттер, а не копией", () => {
    // Обратная ошибка разреза: инструмент присваивает имени, которое ему передали
    // значением. Копия «застынет» на null, и особенность работы приложения (журнал
    // правок, сводка плана) молча перестанет обновляться.
    const { scanWiring } = require(path.join(ROOT, "test", "backend-wiring.js"));
    const modules = ["yc-service.js", "yc-ipc.js", "deploy-ipc.js", "mail-ipc.js", "fs-ipc.js", "git-ipc.js", "agent-tools.js", "agent-tools-cloud.js", "agent-tools-git.js", "agent-tools-files.js", "agent-tools-write.js", "agent-tools-run.js", "agent-tools-system.js", "agent-tools-net.js", "agent-tools-memory.js", "agent-tools-mission.js", "agent-tools-app.js", "agent-tools-devtools.js", "agent-tools-media.js", "agent-tools-vault.js", "agent-tools-env.js", "agent-tools-browser.js", "agent-tools-sheets.js", "system-stack.js", "mission-ipc.js", "model-ipc.js", "github-ipc.js", "settings-store.js", "paths-git.js", "project-search.js", "undo-store.js", "bg-processes.js", "screens.js", "rate-limiters.js", "tool-helpers.js", "project-analysis.js", "site-guides.js", "terminal-panel.js", "app-window.js", "lifecycle.js", "run-mission.js", "run-tools.js", "run-retry.js", "run-round.js", "run-calls.js", "run-strict.js", "run-batch.js", "run-nudge.js", "agent-env.js", "shell-tools.js", "tasks-reminders.js", "run-ai.js", "browser-ipc.js", "git-stage.js", "chats-ipc.js", "memory-ipc.js", "settings-ipc.js", "mobile-ipc.js", "projects-ipc.js", "preview-ipc.js", "ota-ipc.js", "project-brief.js", "run-ipc.js", "tool-registry.js", "run-context.js", "ask-wait.js", "agent-data.js", "role-folders.js", "net-proxy.js", "net-proxy-ipc.js"];
    const r = scanWiring(ROOT, modules, fs, path);
    assert.deepStrictEqual(r.assigns, [], "модуль присваивает чужому имени без сеттера: " + r.assigns.join(", "));
    assert.deepStrictEqual(r.bareLive, [], "живое значение берётся напрямую, мимо моста live: " + r.bareLive.join(", "));
  });

  await test("страж связи: ловит голое живое имя, но не строку и не сам мост", () => {
    // Сам страж тоже надо проверять: если он перестанет ловить, следующая правка
    // молча вернёт «activeRunUndo is not defined» в инструменте отката.
    const { bareLiveNames, bareCode } = require(path.join(ROOT, "test", "backend-wiring.js"));
    const scan = (text) => bareLiveNames(bareCode(text));
    const broken = [
      "const live = { get count() { return d.count(); }, set count(v) { d.count(v); } };",
      "function f() { count = count.filter((x) => x.ok); }",
    ].join("\n");
    assert.deepStrictEqual(scan(broken), ["count"], "голое имя вне моста найдено");
    const fine = [
      "const live = { get count() { return d.count(); }, set count(v) { d.count(v); } };",
      "function f() { live.count = live.count.filter((x) => x.ok); return \"count меняется через мост\"; }",
    ].join("\n");
    assert.deepStrictEqual(scan(fine), [], "мост и текст в строке за ошибку не считаются");
    const propertyOnly = [
      "const live = { get count() { return d.count(); } };",
      "function f(s) { s.count = 1; return obj.count; }",
    ].join("\n");
    assert.deepStrictEqual(scan(propertyOnly), [], "свойство чужого объекта — не наше имя");
    // Литералы после return/typeof/case и стрелки — тоже не текст для поиска имён.
    // Без этого страж ругался на `path` внутри /^(unix:path=…)/ и требовал
    // внедрить имя, которого в модуле нет (жизнь: tasks-reminders.js, часть 24).
    assert.ok(!/\bpath\b/.test(bareCode("function f(bus) { return /^(unix:path=|unix:abstract=)/.test(bus); }")),
      "литерал после return остался в тексте");
    assert.ok(!/\breal\b/.test(bareCode("const r = typeof x === 'string' ? /real-name/ : null;")),
      "литерал после typeof остался в тексте");
    assert.ok(!/\bswap\b/.test(bareCode("const f = (a) => /swap-me/.test(a);")),
      "литерал после стрелки остался в тексте");
    assert.ok(/\bcount\b/.test(bareCode("function f(n) { return count / n; }")),
      "деление после return принято за литерал — страж ослепнет");
    assert.ok(/\brealName\b/.test(bareCode("function f() { return realName + /x/.source; }")),
      "обычное имя рядом с литералом потерялось");
  });

  await test("файловая панель: бинарные файлы, имена и границы рабочей папки", () => {
    const os2 = require("os");
    const root = fs.mkdtempSync(path.join(os2.tmpdir(), "fs-ipc-"));
    fs.writeFileSync(path.join(root, "note.txt"), "привет");
    fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const outside = fs.mkdtempSync(path.join(os2.tmpdir(), "fs-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "чужое");
    const opened = [];
    const handlers = new Map();
    // Тот же контракт, что у sanitizeDir/sanitizePath в main.js: наружу нельзя.
    const inside = (p) => {
      const abs = path.resolve(String(p || ""));
      return abs === root || abs.startsWith(root + path.sep) ? abs : "";
    };
    const api = registerFsIpc({
      ipcMain: { handle: (c, f) => handlers.set(c, f) },
      shell: { showItemInFolder: (p) => opened.push(p), openExternal: (u) => opened.push(u) },
      path,
      fs,
      sanitizeDir: inside,
      sanitizePath: inside,
      // Проверка отправителя у разрушительных каналов — та же, что в main.js.
      ipcGuard: require(path.join(ROOT, "src", "ipc-guard.js")),
    });
    const call = (ch, ...args) => handlers.get(ch)(null, ...args);
    assert.strictEqual(api.BINARY_EXT.has("png"), true, "список бинарных расширений отдаётся наружу");
    assert.strictEqual(api.BINARY_EXT.has("txt"), false, "текстовые файлы читаются");
    const read = call("fs:readFile", path.join(root, "note.txt"));
    assert.ok(read.ok && read.content === "привет", "текстовый файл читается");
    const png = call("fs:readFile", path.join(root, "logo.png"));
    assert.strictEqual(png.binary, true, "картинка помечена бинарной, а не отдана как мусор");
    const out = call("fs:readFile", path.join(outside, "secret.txt"));
    assert.strictEqual(out.ok, false, "файл вне рабочей папки не читается");
    assert.strictEqual(call("fs:createFile", root, "..", "x").ok, false, "имя «..» отклонено");
    assert.strictEqual(call("fs:createFile", root, "a/b.txt", "x").ok, false, "имя со слэшем отклонено");
    assert.strictEqual(call("fs:createFile", root, "new.txt", "тело").ok, true, "нормальное имя принимается");
    assert.ok(fs.existsSync(path.join(root, "new.txt")), "файл создан");
    assert.strictEqual(call("fs:createFolder", root, "sub").ok, true, "папка создана");
    assert.strictEqual(call("fs:writeFile", path.join(root, "new.txt"), "обновлено").ok, true, "файл записан");
    assert.strictEqual(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "обновлено", "содержимое обновилось");
    assert.strictEqual(call("fs:delete", path.join(root, "new.txt")).ok, true, "файл удалён");
    assert.strictEqual(fs.existsSync(path.join(root, "new.txt")), false, "файла больше нет");
    // Удаление — разрушительный канал, и он обязан спросить, кто позвал
    // (src/ipc-guard.js). Чужой рендерер внутри приложения — не человек за окном.
    fs.writeFileSync(path.join(root, "не-трогать.txt"), "чужое");
    const alien = handlers.get("fs:delete")(
      { sender: { id: 999, send() {} }, senderFrame: { parent: null } },
      path.join(root, "не-трогать.txt")
    );
    assert.strictEqual(alien.ok, false, "чужой рендерер удалил файл: " + JSON.stringify(alien));
    assert.ok(/не из окна/.test(alien.error), "отказ не объяснён: " + alien.error);
    assert.ok(fs.existsSync(path.join(root, "не-трогать.txt")), "файл всё-таки удалён чужим вызовом");
    call("fs:openInExplorer", path.join(outside, "secret.txt"));
    assert.strictEqual(opened.length, 0, "проводник не открывается на путь вне рабочей папки");
    call("fs:openInExplorer", path.join(root, "note.txt"));
    assert.strictEqual(opened.length, 1, "внутри рабочей папки проводник открывается");
    call("shell:openExternal", "file:///etc/passwd");
    assert.strictEqual(opened.length, 1, "открытие локальных файлов через shell заблокировано");
    call("shell:openExternal", "https://example.com");
    assert.strictEqual(opened.length, 2, "обычные ссылки открываются");
  });

  await test("git-панель: путь проверяется, состояние агента пишется сеттерами", async () => {
    const os2 = require("os");
    const root = fs.mkdtempSync(path.join(os2.tmpdir(), "git-ipc-"));
    const outside = fs.mkdtempSync(path.join(os2.tmpdir(), "git-out-"));
    fs.writeFileSync(path.join(root, "a.txt"), "x");
    fs.writeFileSync(path.join(outside, "b.txt"), "y");
    const calls = [];
    const state = { dir: null, pending: false };
    let stageCalled = 0;
    const handlers = new Map();
    const inside = (p) => {
      const abs = path.resolve(String(p || ""));
      return abs === root || abs.startsWith(root + path.sep) ? abs : "";
    };
    registerGitIpc({
      ipcMain: { handle: (c, f) => handlers.set(c, f) },
      path,
      fs,
      loadSettings: () => ({}),
      runGit: async (dir, args) => { calls.push(args.join(" ")); return { ok: true, out: "ok" }; },
      sanitizeDir: inside,
      cloneRepoTo: async (u, d) => ({ ok: true, dir: path.join(d, "repo"), message: "Клонировано" }),
      pickCloneBase: () => ({ ok: true, dir: root }),
      withCapability: async (cap, fn) => await fn(), // назначение окружения для git-панели
      stageAllSafe: async () => { stageCalled++; return { ok: true }; },
      setLastAgentRepoDir: (v) => { state.dir = v; },
      setClonedRepoPending: (v) => { state.pending = v; },
    });
    const call = (ch, ...args) => handlers.get(ch)(null, ...args);
    const push = await call("git:push", root);
    assert.ok(push.ok && calls.includes("push"), "push уходит в git");
    calls.length = 0;
    const foreign = await call("git:push", outside);
    assert.strictEqual(foreign.ok, false, "папка вне рабочей не пускается");
    assert.strictEqual(calls.length, 0, "и в git ничего не уходит");
    const emptyMsg = await call("git:commit", root, "   ");
    assert.strictEqual(emptyMsg.ok, false, "пустое сообщение коммита отклонено");
    assert.strictEqual(stageCalled, 0, "и индекс не трогается");
    const commit = await call("git:commit", root, "правка");
    assert.strictEqual(commit.ok, true, "коммит проходит");
    assert.strictEqual(stageCalled, 1, "перед коммитом файлы добавляются в индекс");
    assert.ok(calls.some((c) => c.includes("commit")), "git получил команду коммита");
    calls.length = 0;
    const diffForeign = await call("git:diff", root, path.join(outside, "b.txt"));
    assert.strictEqual(diffForeign.ok, false, "diff по файлу вне папки запрещён");
    assert.strictEqual(calls.length, 0, "и в git такой diff не уходит");
    const cloneBad = await call("git:clone", root, "ftp://пример/репо");
    assert.strictEqual(cloneBad.ok, false, "неподдерживаемый протокол клона отклонён");
    const clone = await call("git:clone", root, "https://github.com/user/repo");
    assert.strictEqual(clone.ok, true, "клон проходит");
    assert.ok(state.dir && state.dir.endsWith("repo"), "папка агента обновлена через сеттер: " + state.dir);
    assert.strictEqual(state.pending, true, "флаг «после клона» выставлен — следующий ответ начнётся с анализа проекта");
  });
}

module.exports = {
  testServer,
  testMailIpc,
  testFsGitIpc,
  testMail,
};

"use strict";

/* ── Справочник ВК и роли, которые им пользуются ────────────────────────────
   Запуск: node test/vk-guide.test.js   (входит в общий `npm test`)

   Зачем отдельный файл: гайд по ВК — это не «текст на память», а проверенный маршрут,
   который агент читает перед работой. Дорогие ошибки в нём повторяются молча:

     • отправку делали через `submit: true` и `browserPress Enter` — в ВК это не отправка,
       а перенос строки или «текст залип в поле, агент отчитался об успехе»;
     • искали кнопку отправки по подписи в карте DOM, хотя есть стабильный селектор;
     • подтверждали отправку прокруткой истории, которая в ВК виртуальная («сообщения нет
       в DOM» ≠ «не отправлено»);
     • подставляли свою версию API (`v=5.95`) вместо версии клиента из перехвата — ошибка 100;
     • искали диалоги в `#im_dialogs`/`.nim-dialog`, которых в текущем DOM нет.

   Здесь проверяется, что гайд эти ошибки закрывает, что он подхватывается по адресу и что
   роли «Ассистент» и «Менеджер» про него знают (у менеджера для этого есть группа браузера). */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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

const guide = fs.readFileSync(path.join(ROOT, "src", "agent-guides", "vk.md"), "utf8");
const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
// Подсказка о справочнике при открытии адреса живёт в обёртке инструмента, а не
// в main.js — читаем все три места, где она может быть (smoke-тест читает дом так же).
// С части 40, захода 13 обёртка browserOpen уехала в свой модуль
// (agent-tools-browser.js) — поэтому он в списке.
// Сама логика справочников (guideForUrl/guideReadText) с этапа B, части 11
// живёт в своём модуле — проверяем её там, где она есть.
const mainSrc =
  fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8") +
  "\n" +
  fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8") +
  "\n" +
  fs.readFileSync(path.join(ROOT, "src", "agent-tools-browser.js"), "utf8") +
  "\n" +
  fs.readFileSync(path.join(ROOT, "src", "site-guides.js"), "utf8");
const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

const SEND_BUTTON = ".ConvoComposer__sendButton--submit";

(async () => {
  console.log("\nСправочник ВК");

  await test("ВК: справочник подхватывается по адресу vk.com/vk.ru", () => {
    const m = guide.match(/<!--\s*sites:\s*([^>]+?)-->/i);
    assert.ok(m, "в гайде нет строки sites — по адресу он не подхватится");
    const sites = m[1].split(",").map((s) => s.trim().toLowerCase());
    for (const host of ["vk.com", "vk.ru"]) {
      assert.ok(sites.indexOf(host) !== -1, "в sites нет " + host + ": " + sites.join(", "));
    }
    // Подсказка выдаётся при открытии адреса, а не после блужданий по DOM.
    assert.ok(/guideForUrl\(args && args\.url\)/.test(mainSrc), "browserOpen не подсказывает справочник по адресу");
    assert.ok(/function guideForUrl\(/.test(mainSrc) && /function guideReadText\(/.test(mainSrc), "нет логики справочников");
  });

  await test("ВК: отправка сообщения — четыре шага и никакого submit/Enter", () => {
    assert.ok(/\[role=textbox\]/.test(guide), "в гайде нет селектора поля сообщений [role=textbox]");
    assert.ok(guide.indexOf(SEND_BUTTON) !== -1, "в гайде нет селектора кнопки отправки " + SEND_BUTTON);
    // Расстояние проверяем позициями, а не «жадным» шаблоном: так тест читается
    // и не ломается о тонкости экранирования регулярных выражений.
    const iFill = guide.indexOf("browserFill");
    const iBez = guide.indexOf("БЕЗ submit");
    assert.ok(iFill >= 0 && iBez > iFill && iBez - iFill < 200, "гайд не запрещает submit: true");
    assert.ok(/contenteditable/.test(guide), "не сказано, что поле сообщений — contenteditable, а не <input>");
    const iClick = guide.indexOf("browserClick");
    const iBtn = guide.indexOf(SEND_BUTTON, iClick);
    assert.ok(iClick >= 0 && iBtn > iClick && iBtn - iClick < 160, "гайд не кликает кнопку отправки");
    // Запреты перечислены явно: на них уже спотыкались.
    for (const bad of ["submit: true", "browserPress", "browserAct"]) {
      assert.ok(guide.indexOf(bad) !== -1, "в гайде нет запрета «" + bad + "»");
    }
    assert.ok(/перенос строки|не отправляют|НЕ отправляют/.test(guide), "не сказано, почему Enter не работает");
  });

  await test("ВК: отправку подтверждают пустым полем, а не историей", () => {
    assert.ok(/\.ComposerInput__input/.test(guide), "в гайде нет поля для проверки отправки");
    assert.ok(/textContent\.length/.test(guide), "проверка отправки описана без длины текста поля");
    assert.ok(/0 = отправлено|== 0|=== 0/.test(guide), "не сказано, что пустое поле = отправлено");
    assert.ok(
      /не в DOM[^\n]*≠[^\n]*не отправлено/i.test(guide) || /≠\s*«не отправлено»/i.test(guide),
      "гайд не предупреждает: сообщения нет в DOM ≠ не отправлено"
    );
    assert.ok(/Виртуализация|виртуализ/.test(guide), "нет раздела про виртуализацию списка и истории");
  });

  await test("ВК: виртуализация и выгрузка данных запросом (replay)", () => {
    assert.ok(/ConvoList__itemsWrapper/.test(guide), "в гайде нет реального контейнера списка диалогов");
    assert.ok(/\.convo-item/.test(guide), "в гайде нет селектора строки списка");
    assert.ok(/#im_dialogs/.test(guide) && /\.nim-dialog/.test(guide), "не сказано, какие селекторы НЕ существуют");
    // Replay: проверенные факты, из-за которых раньше тратился час.
    assert.ok(/api\.vk\.ru\/method\/messages\.getItems/.test(guide), "нет проверенного эндпоинта списка");
    assert.ok(/v=5\.285/.test(guide), "нет версии клиента");
    assert.ok(/из перехвата/.test(guide), "не сказано, откуда брать версию и токен");
    assert.ok(/cursorParam/.test(guide) && /cursorPrefix/.test(guide), "нет настроек курсора для browserReplay");
    assert.ok(/messages\.getHistory/.test(guide), "нет схемы выгрузки истории диалога");
    assert.ok(/start_from=conversations_/.test(guide), "не описана курсорная пагинация списка диалогов");
    assert.ok(/save: true/.test(guide), "не сказано сохранять накопленное в файл, а не в window");
  });

  await test("ВК: сессия, вход через менеджер паролей и баги инструментов", () => {
    assert.ok(/Правило нуля|сначала проверить сессию/i.test(guide), "нет правила «сначала проверь сессию»");
    assert.ok(/browserText/.test(guide), "проверка сессии описана без browserText");
    assert.ok(/vaultList/.test(guide) && /vaultFill/.test(guide), "вход не описан через менеджер паролей");
    assert.ok(/попроси человека|ввести.{0,20}сам/i.test(guide), "не сказано, что пароль вне менеджера просит человек");
    // browserEval: код-операторы без return честно отвечает «ничего не вернул»,
    // значение берётся из window.__x, а DOM-узел надо просить как текст.
    assert.ok(/оператор/i.test(guide) && /ничего не вернул/.test(guide), "нет объяснения про код-операторы в browserEval");
    assert.ok(/window\.__x/.test(guide), "не сказано, что значение берётся из window.__x");
    assert.ok(/outerHTML/.test(guide), "нет подсказки про DOM-узел в ответе browserEval");
    assert.ok(/filter|clear/.test(guide) && /browserNetwork/.test(guide), "нет обхода поллинга в журнале сети");
    assert.ok(/перезагружается|перезагрузка вкладки/.test(guide), "не сказано, что вкладка перезагружается и window теряется");
  });

  await test("ВК: справочник читается и агентом, и через файл", () => {
    const body = guide.replace(/<!--[\s\S]*?-->/, "");
    assert.ok(/^#\s+\S/m.test(guide), "у гайда нет заголовка");
    assert.ok(body.length > 2500, "гайд подозрительно короткий: " + body.length + " символов");
    assert.ok(/agentGuide \{ name: "vk" \}/.test(guide), "гайд не говорит, как себя прочитать");
    assert.ok(/agent-guide:chat-analysis/.test(guide), "нет ссылки на методологию разбора переписок");
  });

  await test("роли: «Ассистент» и «Менеджер» знают справочник ВК", () => {
    const byId = (id) => AgentCore.AGENT_ROLES.find((r) => r.id === id);
    for (const id of ["assistant", "manager"]) {
      const r = byId(id);
      assert.ok(r, "нет роли " + id);
      assert.ok(/agentGuide \{ name: "vk" \}/.test(r.prompt), "в промпте роли «" + r.title + "» нет справочника ВК");
      assert.ok(r.prompt.indexOf(SEND_BUTTON) !== -1, "роль «" + r.title + "» не знает кнопку отправки");
      // Группа браузера — без неё роль дел физически не может открыть ВК.
      assert.ok(r.groups.indexOf("browser") !== -1, "у роли «" + r.title + "» нет группы browser");
    }
    // Пароль для входа берётся из менеджера паролей — эта группа тоже нужна.
    assert.ok(byId("manager").groups.indexOf("vault") !== -1, "у роли «Менеджер» нет группы vault");
    // Роли отдаются интерфейсу без текста промпта — форма ответа не менялась.
    const list = AgentCore.rolesList();
    assert.strictEqual(list.length, 4, "ролей должно быть четыре: " + list.map((r) => r.id).join(", "));
    assert.ok(list.every((r) => r.prompt === undefined), "rolesList отдаёт промпт наружу");
  });

  await test("роли: без просьбы человека агент в переписке не отвечает", () => {
    // Ключевой предохранитель: агент не отвечает людям сам, пока его не попросили.
    const manager = AgentCore.AGENT_ROLES.find((r) => r.id === "manager").prompt;
    assert.ok(/только по его просьбе|после показа адресата/.test(manager), "нет правила про отправку от имени человека");
    assert.ok(/дело со сроком|это дело/.test(manager), "непришедший ответ не превращается в дело");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

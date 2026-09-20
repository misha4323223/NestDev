"use strict";

/* ── Роутер инструментов прогона (src/run-tools.js) ───────────────────────────
   Запуск: node test/run-tools.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 15 — второй заход в ядро чата runAi).
   Здесь решается, какие схемы инструментов уйдут в запрос и какие справочники
   доедут до модели. Ошибки тут тихие и дорогие:

     • группа выпала на середине работы — инструмент исчез из схем, вызов уходит
       «вслепую» текстом, а кэш префикса промпта ломается (503 cache_only_cold);
     • справочник не подключился — агент работает по памяти там, где есть маршрут;
     • вес схем посчитан не по тому, что реально уйдёт — история сжимается раньше
       времени, и агент «тупеет» молча;
     • бюджет истории посчитан без живого бюджета — после переполнения контекста
       история снова не влезает.

   Ядро (routeTools, routerMaxTokens, estimateTokens, groupOfTool, каталог схем)
   берём настоящее — проверка модуля обязана видеть тот же роутер, что и прогон. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const { createSiteGuides } = require(path.join(ROOT, "src", "site-guides.js"));
const { createRunTools } = require(path.join(ROOT, "src", "run-tools.js"));

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

// Настоящие справочники: встроенные — из папки кода, выученные — во временной папке.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tools-"));
const guides = createSiteGuides({
  fs,
  path,
  userDataDir: () => tmpDir,
  builtinDir: path.join(ROOT, "src", "agent-guides"),
});

const CORE_DEPS = {
  routeTools: core.routeTools,
  routerMaxTokens: core.routerMaxTokens,
  routerTaskText: core.routerTaskText,
  estimateTokens: core.estimateTokens,
  toolsAsText: core.toolsAsText,
  guideReadText: guides.guideReadText,
  groupOfTool: core.groupOfTool,
  PLAN_MODE_TOOL_DEFINITIONS: core.PLAN_MODE_TOOL_DEFINITIONS,
};

const ALL_TOOLS = core.routeTools({ forceAll: true }).tools.length;
const BASE_TOKENS = core.routeTools({ text: "" }).tokens;
const SYS_WEIGHT = core.estimateTokens(core.SYSTEM_PROMPT);

function makeRun(opts) {
  const o = opts || {};
  const seen = { term: [], chat: [] };
  let budget = typeof o.budget === "number" ? o.budget : 60000;
  const run = createRunTools(
    Object.assign({}, CORE_DEPS, {
      settings: o.settings || {},
      planMode: !!o.planMode,
      messages: o.messages || [{ role: "user", content: o.text || "привет, как дела" }],
      role: o.role || { groups: [] },
      noTools: !!o.noTools,
      emit: (e) => seen.chat.push(e),
      termEmit: (e) => seen.term.push(e),
      getBudget: () => budget,
      systemPrompt: core.SYSTEM_PROMPT,
    })
  );
  run.refresh();
  return {
    run,
    state: run.state,
    seen,
    names: () => run.state.active.map((t) => t.function && t.function.name),
    setBudget: (b) => {
      budget = b;
    },
    getBudget: () => budget,
    termText: () => seen.term.map((e) => e.text).join("\n"),
    chatText: () => seen.chat.map((e) => e.text).join("\n"),
  };
}

(async () => {
  // ── Диета промпта ─────────────────────────────────────────────────────────
  await test("обычная задача: уходит база + группы задачи, а не все 159 схем", () => {
    const r = makeRun({ text: "открой браузер и зайди на vk.com" });
    assert.ok(r.state.route.groups.includes("browser"), "группа браузера не включена по задаче: " + r.state.route.groups);
    assert.ok(r.state.active.length < ALL_TOOLS, "роутер отдал полный набор: " + r.state.active.length + " из " + ALL_TOOLS);
    assert.ok(r.names().includes("readFile"), "база потеряла readFile");
    assert.ok(r.names().includes("browserOpen"), "в наборе нет инструмента задачи");
    assert.ok(!r.names().includes("ycDeploy"), "в набор попала чужая группа");
  });

  await test("вес схем считается по тому, что реально уйдёт в запрос", () => {
    const r = makeRun({ text: "открой браузер и зайди на vk.com" });
    assert.strictEqual(
      r.state.weight,
      core.estimateTokens(JSON.stringify(r.state.active)),
      "вес схем не совпадает с весом отправляемого набора"
    );
    assert.ok(r.state.weight > 0 && r.state.weight < core.routeTools({ forceAll: true }).tokens, "диета не даёт экономии веса");
    // Без поддержки инструментов отправляется текстовый каталог, и он вчетверо легче:
    // считать по JSON — значит сжимать историю раньше времени и зря пугать окном.
    const noTools = makeRun({ text: "открой браузер", noTools: true });
    assert.strictEqual(noTools.state.weight, core.estimateTokens(core.toolsAsText(noTools.state.active)), "вес каталога считается не по каталогу");
    assert.ok(noTools.state.weight < r.state.weight / 2, "текстовый каталог не легче JSON: " + noTools.state.weight + " против " + r.state.weight);
  });

  await test("бюджет истории: резерв 15% и минимум 1500", () => {
    const r = makeRun({ text: "привет", budget: 60000 });
    const expect = Math.max(1500, Math.floor((60000 - r.state.weight - SYS_WEIGHT) * 0.85));
    assert.strictEqual(r.state.histBudget, expect, "бюджет истории посчитан иначе: " + r.state.histBudget + " вместо " + expect);
    assert.ok(r.state.histBudget < 60000 - r.state.weight - SYS_WEIGHT, "в бюджете истории нет резерва 15%");
    // Тесное окно: минимум всё равно держится.
    const tiny = makeRun({ text: "привет", budget: SYS_WEIGHT + BASE_TOKENS + 10 });
    assert.strictEqual(tiny.state.histBudget, 1500, "на тесном окне бюджет истории провалился ниже 1500");
  });

  await test("после переполнения контекста бюджет истории считается без резерва 15%", () => {
    const r = makeRun({ text: "привет", budget: 60000 });
    assert.ok(r.run.histBudgetAfterOverflow() > r.state.histBudget, "ужатое окно не даёт истории больше места");
    assert.strictEqual(r.run.histBudgetAfterOverflow(), Math.max(1500, r.getBudget() - r.state.weight - SYS_WEIGHT), "формула ужатого окна другая");
    r.setBudget(1000);
    assert.strictEqual(r.run.histBudgetAfterOverflow(), 1500, "нижний предел не держится");
  });

  await test("бюджет приходит живым: пересчёт видит новый бюджет, а не копию", () => {
    const r = makeRun({ text: "привет", budget: 60000 });
    const wide = r.state.histBudget;
    r.setBudget(20000);
    r.run.refresh();
    assert.ok(r.state.histBudget < wide, "на новом бюджете история не ужалась — бюджет взят копией");
    r.setBudget(60000);
    r.run.refresh();
    assert.strictEqual(r.state.histBudget, wide, "возврат бюджета не вернул прежний бюджет истории");
  });

  // ── Липкость состава ──────────────────────────────────────────────────────
  await test("группа не гаснет: пересборка набора не выкидывает уже включённый инструмент", () => {
    // Тихая задача: браузера в наборе нет ни по фразе, ни по истории.
    const r = makeRun({ text: "продолжай" });
    assert.ok(!r.names().includes("browserOpen"), "группа браузера включилась сама — проверка не о том");
    // Группу включил предохранитель A (или findTools) — инструмент стал рабочим.
    r.run.ensureGroupsFor([{ name: "browserScreenshot" }]);
    assert.ok(r.names().includes("browserScreenshot"), "группа вызова не включилась");
    // Следующий раунд пересобирает набор. Если группа не липкая, инструмент, которым
    // агент только что пользовался, исчезает из схем — и вызов уходит «вслепую».
    r.run.refresh();
    r.run.refresh();
    assert.ok(r.names().includes("browserScreenshot"), "после пересборки включённый инструмент выпал из набора");
    assert.ok(r.state.sticky.has("browser"), "липкость группы потеряна");
    // И задача для роутера набирается из истории, а не из одной фразы: в «продолжай»
    // ключевых слов нет вовсе, и раньше группа прошлой задачи выпадала.
    const hist = core.routerTaskText([
      { role: "user", content: "открой браузер и зайди на vk.com" },
      { role: "assistant", content: "открываю" },
      { role: "user", content: "продолжай" },
    ]);
    assert.ok(/браузер/.test(hist) && /продолжай/.test(hist), "роутер не видит историю работы: " + hist);
  });

  await test("предохранитель C: «отправлять все инструменты» возвращает полный набор", () => {
    const r = makeRun({ text: "привет", settings: { sendAllTools: true } });
    assert.strictEqual(r.state.active.length, ALL_TOOLS, "предохранитель C не сработал: " + r.state.active.length);
    assert.strictEqual(r.state.route.all, true, "роутер не пометил полный набор");
  });

  await test("План-режим: только todoWrite, без роутера и справочников", () => {
    const r = makeRun({ text: "открой браузер", planMode: true });
    assert.strictEqual(r.state.active.length, 1, "в План-режиме больше одного инструмента");
    assert.strictEqual(r.state.active[0].function.name, "todoWrite", "в План-режиме не todoWrite");
    assert.strictEqual(r.state.route, null, "в План-режиме остался роутер групп");
    assert.deepStrictEqual(r.state.guideNotes, [], "в План-режиме приехал справочник");
  });

  // ── Справочники групп ─────────────────────────────────────────────────────
  await test("справочник группы подключается сам и только один раз", () => {
    const r = makeRun({ text: "открой браузер и зайди на vk.com" });
    assert.strictEqual(r.state.guideNotes.length, 1, "справочников подключено не столько: " + r.state.guideNotes.length);
    const note = r.state.guideNotes[0];
    assert.strictEqual(note.role, "system", "справочник уехал не системным сообщением");
    assert.ok(note.content.startsWith('=== СПРАВОЧНИК АГЕНТА'), "нет заголовка справочника: " + note.content.slice(0, 40));
    // Текст — настоящий, из src/agent-guides: сверяем с тем, что читает сам модуль.
    const real = guides.guideReadText("browser").trim();
    assert.ok(real.length > 100, "встроенный справочник браузера пуст");
    assert.ok(note.content.includes(real.slice(0, 60)), "в справочник попал не текст файла браузера");
    assert.ok(/browser/.test(r.termText()), "в «Консоль» не сказано, что справочник подключён");
    r.run.refresh();
    r.run.refresh();
    assert.strictEqual(r.state.guideNotes.length, 1, "справочник подключён повторно — промпт растёт зря");
    assert.strictEqual((r.termText().match(/Подключён справочник/g) || []).length, 1, "в «Консоль» дважды сказано об одном справочнике");
  });

  await test("справочник приходит только активным группам, и русское имя группы ведёт к своему файлу", () => {
    const r = makeRun({ text: "привет" });
    assert.deepStrictEqual(r.state.guideNotes, [], "тихая задача притащила справочник");
    r.run.router.addGroups(["cloud"]);
    assert.strictEqual(r.state.guideNotes.length, 1, "справочник группы cloud не подключился");
    assert.ok(/справочник «yc»/.test(r.termText()), "группа cloud подключила не свой справочник: " + r.termText());
    assert.ok(r.state.guideNotes[0].content.includes(guides.guideReadText("yc").trim().slice(0, 60)), "текст справочника yc не доехал");
    assert.ok(r.names().includes("ycStatus"), "после включения группы cloud нет её инструментов");
  });

  // ── Предохранитель A ──────────────────────────────────────────────────────
  await test("предохранитель A: вызов вне набора включает группу и говорит результат", () => {
    const r = makeRun({ text: "привет" });
    assert.ok(!r.names().includes("browserScreenshot"), "группа браузера была активна с самого начала — проверка не о том");
    r.run.ensureGroupsFor([{ name: "browserScreenshot" }]);
    assert.ok(r.state.sticky.has("browser"), "группа вызова не включена");
    assert.ok(r.names().includes("browserScreenshot"), "схема вызванного инструмента не попала в набор");
    assert.ok(/включаю группу «browser»/.test(r.termText()), "результат включения не назван: " + r.termText());
    const before = r.termText().length;
    r.run.ensureGroupsFor([{ name: "browserOpen" }]); // та же группа второй раз
    assert.strictEqual(r.termText().length, before, "о повторном вызове снова доложили — «Консоль» забьётся");
  });

  await test("предохранитель A: если группе не хватило окна, обещания «схем станет больше» нет", () => {
    // Потолок схем = база: группа включена, но её схемы в окно не влезают.
    const r = makeRun({ text: "привет", budget: SYS_WEIGHT + BASE_TOKENS + 100 });
    r.run.ensureGroupsFor([{ name: "browserScreenshot" }]);
    assert.ok(r.state.sticky.has("browser"), "группа не отмечена включённой");
    assert.ok(!r.names().includes("browserScreenshot"), "схема влезла туда, где места нет");
    assert.ok(/не влезают в окно модели/.test(r.termText()), "отчёт не сверяется с фактом: " + r.termText());
    assert.ok(/[Вв]ызов выполняю как обычно/.test(r.termText()), "человеку не сказано, что вызов всё равно пройдёт");
  });

  await test("тесное окно: предупреждаем один раз и в консоль, и в чат", () => {
    const r = makeRun({ text: "привет", budget: SYS_WEIGHT + BASE_TOKENS + 100 });
    const warns = (r.termText().match(/Окно модели мало/g) || []).length;
    assert.strictEqual(warns, 1, "предупреждений о тесном окне не одно: " + warns);
    assert.ok(/Окно модели мало/.test(r.chatText()), "предупреждение не дошло до чата — его увидит только «Консоль»");
    r.run.refresh();
    assert.strictEqual((r.termText().match(/Окно модели мало/g) || []).length, 1, "предупреждение повторяется каждый раунд");
    // Широкое окно: молчим, а не пугаем зря.
    const wide = makeRun({ text: "привет", budget: 200000 });
    assert.strictEqual((wide.termText().match(/Окно модели мало/g) || []).length, 0, "на широком окне пришло предупреждение");
  });

  // ── Мост для findTools ────────────────────────────────────────────────────
  await test("роутер для findTools: включает группу, знает состав и группы задачи", () => {
    const r = makeRun({ text: "привет" });
    assert.ok(!r.run.router.has("mail"), "группа писем активна без задачи");
    r.run.router.addGroups(["mail", "mail", "", null]);
    assert.ok(r.run.router.has("mail"), "группа писем не включена");
    assert.ok(r.run.router.names().includes("mailSend"), "names() не знает состав набора");
    assert.ok(r.run.router.groups().includes("mail"), "groups() не знает группы задачи");
    const again = r.run.router.names().length;
    r.run.router.addGroups(["mail"]);
    assert.strictEqual(r.run.router.names().length, again, "повторное включение пересобрало набор");
  });

  await test("модуль берёт только внедрённое состояние — в main.js роутера больше нет", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "run-tools.js"), "utf8");
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    // Цикл прогона с части 25 живёт в src/run-ai.js: спрашиваем его, а у оболочки —
    // только то, что осталось её (отсутствие кода, подключение модуля, живые значения).
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    for (const gone of ["stickyGroups", "budgetWarned", "injectedGuides", "let routeInfo", "let activeTools", "let toolsWeight"]) {
      assert.ok(mainSrc.indexOf(gone) < 0, "в main.js осталось состояние роутера: " + gone);
    }
    assert.ok(/const tools = createRunTools\(\{/.test(runSrc), "модуль не собран в прогоне");
    assert.ok(/live\.activeToolRouter = tools\.router;/.test(runSrc), "мост для findTools не подключён");
    assert.ok(!/app\.getPath|__dirname|require\(/.test(src), "модуль сам достаёт состояние вместо внедрения");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

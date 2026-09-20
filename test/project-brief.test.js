"use strict";

/* ── «Визитка» проекта для системного промпта (src/project-brief.js) ──────────
   Запуск: node test/project-brief.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 27). Визитка попадает в системный
   промпт на каждом прогоне, поэтому ошибается тихо и дорого:

     • мусор в структуре (node_modules, .git, dist) — визитка раздувается и
       вытесняет из промпта настоящую работу;
     • нет пределов по размеру — на большом проекте визитка съедает контекст;
     • битый package.json или недоступная папка роняют сборку промпта — прогон
       не начинается вовсе;
     • устаревшая строка Yandex Cloud («каталог не выбран», хотя он выбран) —
       настройки обязаны читаться в момент сбора визитки.

   Проверяем на НАСТОЯЩЕЙ папке в temp: поддельный fs не показал бы ни обхода
   дерева, ни срезов. Подставные — только оболочки, строка облака и настройки. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createProjectBrief } = require(path.join(ROOT, "src", "project-brief.js"));

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

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage"]);
const HEAD_SRC = require("child_process").execSync("git show HEAD:src/main.js", { encoding: "utf8", maxBuffer: 1 << 28 });
const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "project-brief.js"), "utf8");

function mk() {
  const calls = { shells: 0, ycArgs: [] };
  const state = { shells: "bash, cmd", yc: "Yandex Cloud: каталог «prod» (b1g)" };
  const { buildProjectBrief } = createProjectBrief({
    fs,
    path,
    SKIP_DIRS,
    shellsBrief: () => {
      calls.shells++;
      if (state.shellsThrows) throw new Error("оболочки недоступны");
      return state.shells;
    },
    loadSettings: () => ({ fresh: true }),
    ycBriefLine: (s) => {
      calls.ycArgs.push(s);
      if (state.ycThrows) throw new Error("облако недоступно");
      return state.yc;
    },
  });
  return { buildProjectBrief, calls, state };
}

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-"));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

(async () => {
  await test("визитка собирает имя, скрипты, структуру, README, оболочки и облако", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "мой-проект", scripts: { dev: "vite", test: "node t.js" } }),
      "README.md": "# Мой проект\n\nПервая строка\n\n```\nкод\n```\nЕщё строка",
      "src/index.js": "console.log(1)",
      "src/lib/util.js": "module.exports = 1",
    });
    try {
      const brief = mk().buildProjectBrief(dir);
      assert.ok(brief.indexOf("Проект: мой-проект (каталог: " + dir + ")") === 0, "имя проекта не первое: " + brief.slice(0, 80));
      assert.ok(/Скрипты package.json: dev: vite; test: node t\.js/.test(brief), "скрипты потерялись: " + brief);
      // Порядок записей — как их отдаёт readdirSync (по алфавиту), а не «сначала папки»:
      // это данные файловой системы, и выдумывать свой порядок визитка не имеет права.
      assert.ok(
        /Структура \(6 записей\):\n📄 README\.md\n📄 package\.json\n📁 src\/\n📄 src\/index\.js\n📁 src\/lib\/\n📄 src\/lib\/util\.js/.test(brief),
        "структура не двухуровневая: " + brief
      );
      // Строки из блоков ``` в README остаются: визитка берёт первые непустые строки,
      // а не разбирает разметку — поведение прежнее и намеренно примитивное.
      assert.ok(/README \(начало\): Мой проект · Первая строка · код · Ещё строка/.test(brief), "README собран неверно: " + brief);
      assert.ok(/Оболочки: bash, cmd/.test(brief), "доступные оболочки не названы");
      assert.ok(/Yandex Cloud: каталог «prod»/.test(brief), "строка облака потерялась");
      assert.ok(brief.indexOf("\n\n\n") < 0, "в визитке пустые абзацы");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("мусор в структуру не попадает: node_modules, .git, dist и скрытое", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "p" }),
      "src/a.js": "",
      "node_modules/pkg/index.js": "",
      "dist/bundle.js": "",
      ".git/config": "",
      ".vscode/settings.json": "",
    });
    try {
      const brief = mk().buildProjectBrief(dir);
      for (const junk of ["node_modules", "dist/", ".git", ".vscode", "bundle.js"]) {
        assert.strictEqual(brief.indexOf(junk), -1, "в структуру попал мусор: " + junk);
      }
      assert.ok(/📄 src\/a\.js/.test(brief), "настоящий файл потерялся вместе с мусором");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("глубже двух уровней не идём, а размер структуры ограничен", () => {
    const files = { "package.json": JSON.stringify({ name: "p" }), "a/1.js": "", "a/b/2.js": "", "a/b/c/3.js": "" };
    for (let i = 0; i < 120; i++) files["wide/f" + i + ".js"] = "";
    const dir = project(files);
    try {
      const brief = mk().buildProjectBrief(dir);
      assert.strictEqual(brief.indexOf("a/b/c/3.js"), -1, "визитка ушла на третий уровень");
      const tree = (brief.match(/Структура \((\d+) записей\)/) || [])[1];
      assert.ok(Number(tree) <= 80, "структура не ограничена: " + tree);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("пределы визитки: 12 скриптов, 50 знаков на скрипт, 10 строк README", () => {
    // Пределы — это и есть защита контекста: без них большой проект вытеснил бы
    // из промпта саму работу (визитка попадает в каждый запрос).
    // Длинная команда обязана попасть в первые 12 — иначе проверка обрезки была бы
    // пустой: до неё просто не дошло бы (это найденный контрольной проверкой дефект
    // самой проверки: ключ long стоял двадцать первым).
    const scripts = { aLong: "x".repeat(120) };
    for (let i = 0; i < 20; i++) scripts["s" + i] = "команда" + i;
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push("строка" + i);
    const dir = project({
      "package.json": JSON.stringify({ name: "p", scripts: scripts }),
      "README.md": lines.join("\n"),
    });
    try {
      const brief = mk().buildProjectBrief(dir);
      const scriptLine = (brief.match(/Скрипты package\.json: ([^\n]+)/) || [])[1] || "";
      const names = scriptLine.split("; ");
      assert.strictEqual(names.length, 12, "скриптов в визитке не 12, а " + names.length);
      assert.strictEqual(scriptLine.indexOf("x".repeat(51)), -1, "длинная команда не обрезана до 50 знаков");
      assert.ok(/aLong: x{50}[^x]/.test(scriptLine), "длинная команда обрезана не ровно до 50 знаков");
      // В срез попали ровно 12 первых: длинная команда и s0…s10.
      assert.ok(/s9: /.test(scriptLine) && /s10: /.test(scriptLine), "срез скриптов потерял разрешённые пункты");
      assert.strictEqual(scriptLine.indexOf("s11: "), -1, "в визитку попал лишний скрипт");
      assert.strictEqual(scriptLine.indexOf("s12: "), -1, "в визитку попал лишний скрипт");
      const readme = (brief.match(/README \(начало\): ([^\n]+)/) || [])[1] || "";
      const readmeLines = readme.split(" · ");
      assert.strictEqual(readmeLines.length, 10, "строк README в визитке не 10, а " + readmeLines.length);
      assert.strictEqual(brief.indexOf("строка10"), -1, "в README попала лишняя строка");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("битый package.json не роняет визитку: строчки о проекте просто нет", () => {
    const dir = project({ "package.json": "{ это не json", "README.md": "# ok", "a.js": "" });
    try {
      const brief = mk().buildProjectBrief(dir);
      // Разбор package.json целиком в try: битый файл — это «о проекте нечего сказать»,
      // а не выдуманное имя. Структура и README при этом остаются.
      assert.strictEqual(brief.indexOf("Проект: "), -1, "имя проекта выдумано на битом package.json");
      assert.ok(/Структура \(3 записей\)/.test(brief), "структура потерялась вместе с package.json: " + brief.slice(0, 60));
      assert.strictEqual(brief.indexOf("Скрипты package.json"), -1, "скрипты выдуманы на битом файле");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("пустая папка не выдумывает визитку, а несуществующая даёт пустую строку", () => {
    const empty = project({});
    const missing = path.join(empty, "нет-такой");
    try {
      const m = mk();
      assert.strictEqual(m.buildProjectBrief(missing), "", "визитка выдумана для несуществующей папки");
      const brief = m.buildProjectBrief(empty);
      assert.strictEqual(brief.indexOf("Проект: "), -1, "имя выдумано без package.json");
      assert.ok(/Оболочки: bash, cmd/.test(brief), "оболочки — не часть визитки?");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  await test("сбои оболочек и облака визитку не роняют, пустая строка облака не добавляется", () => {
    const dir = project({ "package.json": JSON.stringify({ name: "p" }), "a.js": "" });
    try {
      const m = mk();
      m.state.shellsThrows = true;
      m.state.ycThrows = true;
      const broken = m.buildProjectBrief(dir);
      assert.ok(/Проект: p/.test(broken), "визитка упала вместе с оболочками");
      assert.strictEqual(broken.indexOf("Оболочки:"), -1, "сбой оболочек показан текстом");
      m.state.shellsThrows = false;
      m.state.ycThrows = false;
      m.state.yc = "";
      const quiet = m.buildProjectBrief(dir);
      assert.ok(/Оболочки: bash, cmd/.test(quiet), "сбор оболочек сломался после сбоя облака");
      assert.strictEqual(quiet.indexOf("Yandex Cloud"), -1, "пустая строка облака добавлена абзацем");
      assert.ok(!/\n\n\n/.test(quiet), "пустая строка облака оставила пустой абзац");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("настройки читаются в момент сбора визитки, а не копией при сборке", () => {
    // Строка облака собирается из настроек: застывшая копия говорила бы «каталог не
    // выбран», когда он уже выбран — ровно жалоба «агент не видит каталог».
    const dir = project({ "a.js": "" });
    try {
      const m = mk();
      m.buildProjectBrief(dir);
      m.buildProjectBrief(dir);
      assert.strictEqual(m.calls.ycArgs.length, 2, "строка облака спрошена не на каждый сбор визитки");
      assert.deepStrictEqual(m.calls.ycArgs[0], { fresh: true }, "в строку облака ушли не свежие настройки");
      assert.strictEqual(m.calls.shells, 2, "оболочки спрошены не на каждый сбор визитки");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("в оболочке визитки больше нет, а сборка стоит выше проводки прогона", () => {
    assert.strictEqual(MAIN_SRC.indexOf("function buildProjectBrief(root)"), -1, "визитка осталась в main.js");
    const wiringAt = MAIN_SRC.indexOf('const { createProjectBrief } = require("./project-brief.js");');
    const runAt = MAIN_SRC.indexOf("const { createRunAi } = require(\"./run-ai.js\");");
    assert.ok(wiringAt > 0, "main.js не собирает модуль визитки");
    assert.ok(runAt > 0 && wiringAt < runAt, "модуль собран ниже прогона — прогон получит undefined");
    const wiring = MAIN_SRC.slice(wiringAt, MAIN_SRC.indexOf("});", wiringAt));
    for (const dep of ["  fs,", "  path,", "  SKIP_DIRS,", "  shellsBrief,", "  loadSettings,", "  ycBriefLine,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep.trim());
    }
    assert.ok(/buildProjectBrief,\n/.test(MAIN_SRC.slice(runAt)), "визитка не отдана прогону");
    assert.ok(!/require\(|__dirname/.test(MODULE_SRC), "модуль сам достаёт состояние вместо внедрения");
    // Тело визитки в модуле обязано совпадать с прежним текстом из HEAD байт в байт.
    const headAt = HEAD_SRC.indexOf("// Краткая «визитка» проекта");
    const headEnd = HEAD_SRC.indexOf("\n// ═══════════════════ Системные программы и окружение");
    const before = HEAD_SRC.slice(headAt, headEnd).replace(/\s+$/, "");
    assert.ok(MODULE_SRC.indexOf(before) >= 0, "текст визитки разошёлся с прежним main.js");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

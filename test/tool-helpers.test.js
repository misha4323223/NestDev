"use strict";

/* ── Помощники инструментов: пакетный менеджер, тесты, дифф (src/tool-helpers.js) ──
   Запуск: node test/tool-helpers.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 10). Это мелочи, на которых стоят
   инструменты агента — и каждая ошибается тихо:

     • пакетный менеджер определяется по lockfile: ошибка здесь означает, что агент
       поставит зависимости чужим менеджером и насыплет лишних lock-файлов;
     • итог тестов выжимается из вывода раннера: если разбор сломается, агент
       прочитает тысячи строк вместо «прошло 5, упало 2»;
     • unified-дифф берётся у настоящего git diff --no-index — поэтому проверяется
       на настоящих файлах и настоящем git. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { createToolHelpers } = require(path.join(ROOT, "src", "tool-helpers.js"));
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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "tool-helpers.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

// Настройки и рабочая папка — живые: как в приложении, их берут в момент вызова.
const state = { settings: { workingDir: "" } };
const helpers = createToolHelpers({
  fs,
  path,
  execFile,
  envFor: () => ({}),
  stripAnsi: (s) => String(s).replace(/\u001b\[[0-9;]*m/g, ""),
  agentWorkDir: (s) => s.workingDir || os.homedir(),
  loadSettings: () => state.settings,
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-helpers-"));
const touch = (rel) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{}");
  return p;
};

(async () => {
  console.log("Помощники инструментов (src/tool-helpers.js)");

  await test("пакетный менеджер: определяется по lockfile, bun важнее остальных", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));
    assert.strictEqual(helpers.detectPackageManager(dir).name, "npm", "без lockfile должен быть npm");
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    assert.strictEqual(helpers.detectPackageManager(dir).name, "npm");
    fs.writeFileSync(path.join(dir, "yarn.lock"), "");
    assert.strictEqual(helpers.detectPackageManager(dir).name, "yarn", "yarn.lock не распознан");
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    assert.strictEqual(helpers.detectPackageManager(dir).name, "pnpm", "pnpm-lock.yaml не распознан");
    fs.writeFileSync(path.join(dir, "bun.lockb"), "");
    const bun = helpers.detectPackageManager(dir);
    assert.strictEqual(bun.name, "bun", "bun.lockb не распознан");
    assert.strictEqual(bun.bin, "bun", "двоичная команда не bun");
    assert.strictEqual(bun.add, "add", "у bun другой способ установки");
    assert.strictEqual(bun.flagDev, "-d", "у bun другой флаг dev-зависимостей");
    // npm — умолчание, и у него свои «install» и «-D».
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-empty-"));
    const npm = helpers.detectPackageManager(empty);
    assert.strictEqual(npm.add + " " + npm.flagDev, "install -D", "флаги npm не те");
  });

  await test("hasLock: смотрит в рабочую папку агента из НАСТОЯЩИХ настроек", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haslock-"));
    fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
    state.settings = { workingDir: dir };
    assert.strictEqual(helpers.hasLock("npm"), true, "npm-lock не найден в рабочей папке");
    assert.strictEqual(helpers.hasLock("bun"), false, "чужая пачка принята за bun");
    fs.writeFileSync(path.join(dir, "bun.lock"), "");
    assert.strictEqual(helpers.hasLock("bun"), true, "bun.lock не найден");
    // Настройки читаются в момент вызова: смена проекта — смена ответа.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "haslock2-"));
    state.settings = { workingDir: other };
    assert.strictEqual(helpers.hasLock("bun"), false, "ответ пришёл из копии настроек, а не из живых");
    state.settings = { workingDir: dir };
  });

  await test("итог тестов: прошло/упало и список упавших, а не весь вывод", () => {
    const out = helpers.summarizeTestOutput([
      "> test",
      "✓ первый тест",
      "✗ второй тест",
      "Tests:       4 passed, 1 failed",
      "Time:        1.2 s",
    ].join("\n"));
    assert.ok(/прошло: 4/.test(out), "число пройденных не найдено: " + JSON.stringify(out));
    assert.ok(/упало: 1/.test(out), "число упавших не найдено: " + JSON.stringify(out));
    assert.ok(/второй тест/.test(out), "упавший тест не назван");
    assert.ok(!/Time:/.test(out), "в итог попал лишний вывод раннера");

    const rus = helpers.summarizeTestOutput("Итог: 12 прошло, 0 упало\n");
    assert.ok(/прошло: 12/.test(rus), "русский итог не разобран: " + JSON.stringify(rus));
    assert.ok(/упало: 0/.test(rus), "ноль упавших не показан: " + JSON.stringify(rus));

    assert.strictEqual(helpers.summarizeTestOutput(""), "", "пустой вывод дал непустой итог");
    assert.strictEqual(helpers.summarizeTestOutput(null), "", "null дал непустой итог");
    const broken = helpers.summarizeTestOutput("Cannot find module 'foo'\nError: boom");
    assert.ok(/ошибки/.test(broken), "ошибка без итога не объяснена агенту: " + JSON.stringify(broken));
  });

  await test("дифф: настоящий git diff --no-index по настоящим файлам", async () => {
    const a = path.join(root, "diff-a.txt");
    const b = path.join(root, "diff-b.txt");
    fs.writeFileSync(a, "первая строка\nвторая строка\n");
    fs.writeFileSync(b, "первая строка\nвторая строка ИЗМЕНЕНА\n");
    const r = await helpers.unifiedDiff(a, b);
    assert.ok(typeof r.patch === "string" && r.patch.length > 0, "патч пустой: " + JSON.stringify(r));
    assert.ok(/--- /.test(r.patch) && /\+\+\+ /.test(r.patch), "это не unified-дифф: " + r.patch.slice(0, 120));
    assert.ok(/-вторая строка/.test(r.patch), "удалённая строка не в патче");
    assert.ok(/\+вторая строка ИЗМЕНЕНА/.test(r.patch), "добавленная строка не в патче");
    // Одинаковые файлы — различий нет, но и падения быть не должно.
    const same = await helpers.unifiedDiff(a, a);
    assert.strictEqual(same.patch, "", "одинаковые файлы дали патч");
    // Несуществующий путь — не падение, а пустой ответ с текстом от git.
    const missing = await helpers.unifiedDiff(a, path.join(root, "нет-такого.txt"));
    assert.ok(typeof missing.patch === "string", "несуществующий файл уронил дифф");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["function detectPackageManager(", "function hasLock(", "function summarizeTestOutput(", "function unifiedDiff("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createToolHelpers \} = require\("\.\/tool-helpers\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    for (const dep of ["agentWorkDir,", "loadSettings,", "stripAnsi,", "envFor,"]) {
      assert.ok(MAIN_SRC.includes(dep), "в проводку не передано: " + dep);
    }
    for (const use of ["detectPackageManager,", "hasLock,", "summarizeTestOutput,", "unifiedDiff,"]) {
      assert.ok(MAIN_SRC.includes(use), "оболочка перестала отдавать инструментам: " + use);
    }
    assert.ok(MODULE_SRC.includes("loadSettings()"), "настройки читаются не в момент вызова");
    assert.ok(MODULE_SRC.includes("git"), "дифф больше не через git");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

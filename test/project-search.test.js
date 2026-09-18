"use strict";

/* ── Поиск по всему проекту и обзор файлов (src/project-search.js) ─────────────
   Запуск: node test/project-search.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 7): walkProject (общий обход проекта),
   listProjectFiles (список файлов для «осмотра») и searchProjectFiles (поиск по
   содержимому, как grep -r).

   Почему проверки поведенческие, а не «строка на месте»: ошибки здесь тихие и
   дорогие.
     • Если обход перестанет пропускать node_modules, поиск утонет в чужих файлах
       и вернёт сорок случайных совпадений вместо нужных — при этом «работает».
     • Если список расширений (BINARY_EXT) передать копией, поиск пойдёт по
       картинкам и архивам, а на реальном проекте это выглядит как зависание.
     • Если обход сломается по глубине/лимиту файлов, ответ будет неполным, но
       ни одной ошибки не появится.
   Поэтому модуль водится по-настоящему: настоящие файлы на диске, настоящие
   пропускаемые папки, реальные ограничения размера. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { createProjectSearch } = require(path.join(ROOT, "src", "project-search.js"));
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
const MODULE_SRC = read("src", "project-search.js");
// Единственное прямое чтение main.js здесь — проверка «этого в оболочке больше нет»
// и того, что живой список расширений передан обёрткой, а не копией.
const MAIN_SRC = read("src", "main.js");

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".venv", "vendor"]);
const MAX_FILE_SCAN = 2 * 1024 * 1024;

/* BINARY_EXT передаётся модулю живой обёрткой: список расширений создаётся позже
   (его отдаёт регистрация файловых каналов), поэтому проверяем именно живую связь. */
function makeSearch(binarySet) {
  const box = { ext: binarySet || new Set(["png", "jpg", "zip", "exe"]) };
  const api = createProjectSearch({
    fs,
    path,
    resolvePath: (p, settings) => (path.isAbsolute(p) ? p : path.resolve(settings.workingDir || os.tmpdir(), p)),
    agentWorkDir: (settings) => settings.workingDir || os.tmpdir(),
    SKIP_DIRS,
    MAX_FILE_SCAN,
    BINARY_EXT: { has: (ext) => box.ext.has(ext) },
  });
  return { api, box };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-search-"));
const write = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};

write("src/app.js", "const PORT = 3000;\n// test\n");
write("src/deep/nested/file.js", "module.exports = 1;\n");
write("README.md", "# Проект\nТут слово Test и ещё раз test\n");
write("node_modules/huge/index.js", "test test test\n");
write(".git/config", "test\n");
write("dist/bundle.js", "test\n");
write("logo.png", "test в картинке\n");
// Файл больше предела — и с искомым словом внутри: если предел потерять,
// поиск его найдёт, а на реальном проекте это минуты чтения вместо мгновенного ответа.
write("big.js", "x".repeat(MAX_FILE_SCAN + 10) + "\ntest внутри большого файла\n");

(async () => {
  console.log("Поиск по проекту и обзор файлов (src/project-search.js)");

  await test("обход проекта: заходит вглубь, но не смотрит в node_modules, .git и dist", () => {
    const { api } = makeSearch();
    const seen = [];
    api.walkProject(root, {}, (rel) => seen.push(rel.replace(/\\/g, "/")));
    assert.ok(seen.includes("src/app.js"), "обычный файл найден");
    assert.ok(seen.includes("src/deep/nested/file.js"), "вложенность пройдена");
    assert.ok(seen.includes("README.md"), "файл в корне найден");
    const bad = seen.filter((f) => /^(node_modules|\.git|dist)\//.test(f) || f.includes("/node_modules/"));
    assert.deepStrictEqual(bad, [], "чужие файлы в обход не попали: " + bad.join(", "));
  });

  await test("обход проекта: предел по глубине и по числу файлов останавливает работу", () => {
    const { api } = makeSearch();
    let deep = [];
    api.walkProject(root, { maxDepth: 1 }, (rel) => deep.push(rel.replace(/\\/g, "/")));
    assert.ok(deep.includes("src/app.js"), "на первом уровне файлы видны");
    assert.ok(!deep.includes("src/deep/nested/file.js"), "глубже предела не заходим");

    let limited = [];
    api.walkProject(root, { maxFiles: 2 }, (rel) => limited.push(rel));
    assert.ok(limited.length <= 2, "лимит файлов соблюдён: " + limited.length);

    const empty = [];
    api.walkProject(path.join(root, "нет-такой-папки"), {}, (rel) => empty.push(rel));
    assert.deepStrictEqual(empty, [], "несуществующая папка — пусто, без падения");
  });

  await test("список файлов: относительные пути, подпапка с префиксом, честные сообщения", () => {
    const { api } = makeSearch();
    const st = { workingDir: root };
    const list = api.listProjectFiles(st, "");
    assert.ok(/Файлы проекта \(/.test(list), "заголовок со счётом: " + list.split("\n")[0]);
    assert.ok(list.includes("src/app.js"), "пути через прямой слэш");
    assert.ok(!list.includes("node_modules"), "чужие папки не в списке");

    const sub = api.listProjectFiles(st, "src");
    assert.ok(sub.includes("src/app.js"), "подпапка отдаётся с префиксом: " + sub.split("\n").slice(0, 3).join(" | "));
    assert.ok(!sub.includes("README.md"), "файлы вне подпапки не подмешиваются");

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-search-empty-"));
    assert.ok(/нет файлов/.test(api.listProjectFiles({ workingDir: emptyDir }, "")), "пустая папка — понятный ответ");
    assert.ok(/папка не найдена/.test(api.listProjectFiles({ workingDir: path.join(root, "нет") }, "")), "несуществующая папка");
  });

  await test("поиск: файл, номер строки и текст; регистр не важен", () => {
    const { api } = makeSearch();
    const out = api.searchProjectFiles("test", { workingDir: root }, "");
    assert.ok(/README\.md:2/.test(out), "найдено в README с номером строки: " + out.split("\n")[1]);
    assert.ok(/src\/app\.js:2/.test(out), "найдено в src/app.js");
    assert.ok(/readFileLines/.test(out), "в ответе есть подсказка, как посмотреть строки вокруг");
    const upper = api.searchProjectFiles("ПРОЕКТ", { workingDir: root }, "");
    assert.ok(/README\.md/.test(upper), "поиск не зависит от регистра");
  });

  await test("поиск: пропускает картинки, архивы и файлы больше предела", () => {
    const { api } = makeSearch();
    const out = api.searchProjectFiles("test", { workingDir: root }, "");
    assert.ok(!/logo\.png/.test(out), "картинку не читаем");
    assert.ok(!/big\.js/.test(out), "файл больше предела не сканируем (внутри него есть слово)");
    const withPng = makeSearch(new Set([]));
    const out2 = withPng.api.searchProjectFiles("test", { workingDir: root }, "");
    assert.ok(/logo\.png/.test(out2), "расширения берутся из живого списка, а не из копии");
  });

  await test("поиск: сорок совпадений — предел, и совпадений нет — честный ответ", () => {
    const { api } = makeSearch();
    const many = fs.mkdtempSync(path.join(os.tmpdir(), "project-search-many-"));
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(many, "f" + i + ".txt"), "иголка\n");
    const out = api.searchProjectFiles("иголка", { workingDir: many }, "");
    const hits = out.split("\n").filter((l) => /^f\d+\.txt:\d+/.test(l));
    assert.strictEqual(hits.length, 40, "ровно сорок совпадений в ответе, а не шестьдесят");
    const none = api.searchProjectFiles("здесь-такого-нет", { workingDir: many }, "");
    assert.ok(/Совпадений по/.test(none) && /нет/.test(none), "честный ответ без совпадений: " + none);
  });

  await test("поиск: спецсимволы не роняют поиск — уходим на поиск подстрокой", () => {
    const { api } = makeSearch();
    write("src/odd.js", "function foo(bar) { return bar; }\n");
    const out = api.searchProjectFiles("foo(bar", { workingDir: root }, "");
    assert.ok(/src\/odd\.js:1/.test(out), "неправильное выражение — ищем как текст: " + out.split("\n")[1]);
    const re = api.searchProjectFiles("foo\\(ba.", { workingDir: root }, "");
    assert.ok(/src\/odd\.js:1/.test(re), "правильное выражение работает как выражение");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте с живым списком расширений", () => {
    for (const gone of ["function walkProject(", "function listProjectFiles(", "function searchProjectFiles("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createProjectSearch \} = require\("\.\/project-search\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(/BINARY_EXT: \{ has: \(ext\) => BINARY_EXT\.has\(ext\) \}/.test(MAIN_SRC), "список расширений передан копией, а не живой обёрткой");
    for (const keep of ["const SKIP_DIRS = new Set([", "const MAX_FILE_SCAN ="]) {
      assert.ok(MAIN_SRC.indexOf(keep) >= 0, "правило обхода уехало из оболочки: " + keep);
    }
    assert.ok(/listProjectFiles,\n/.test(MAIN_SRC) && /searchProjectFiles,\n/.test(MAIN_SRC), "оболочка перестала отдавать поиск инструментам");
    assert.ok(MODULE_SRC.indexOf("MAX_FILE_SCAN") >= 0 && MODULE_SRC.indexOf("SKIP_DIRS") >= 0, "правило обхода пропало из модуля");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

"use strict";

/* ── Анализ проекта: исходники, структура, переименование, ссылки ──────────────
   Запуск: node test/project-analysis.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 10). На этих четырёх помощниках стоят
   инструменты агента «осмотреть проект», «структура файла», «переименовать»
   и «найти все ссылки» — и каждый ошибается тихо и дорого:

     • если обход исходников перестанет пропускать node_modules/.git/dist, любой
       осмотр проекта утонет в чужих файлах и вернёт мусор вместо кода;
     • если переименование перестанет уважать границы слова, `user` превратит
       `username` в `newName` + «name» — и полпроекта развалится без единой ошибки;
     • если переименование начнёт писать при сухом прогоне, «прикидка» разнесёт
       правки по всему проекту;
     • если структура файла перестанет соблюдать пределы (400 записей, 110 знаков,
       25 совпадений на файл, 100 всего), ответ разрастётся так, что агент его
       не прочтёт.

   Поэтому модуль водится по-настоящему: настоящие файлы на диске, настоящие
   правки, настоящие повторные чтения. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { createProjectAnalysis } = require(path.join(ROOT, "src", "project-analysis.js"));
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
const MODULE_SRC = read("src", "project-analysis.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

// Живого состояния у модуля нет: приходят только fs и path.
const analysis = createProjectAnalysis({ fs, path });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-analysis-"));
const write = (rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
};
const rel = (abs) => path.relative(root, abs).split(path.sep).join("/");

write("src/app.js", "const util = require('./util');\nfunction doWork(x) {\n  return util(x);\n}\n");
write("src/util.js", "module.exports = (x) => x + 1;\n");
write("src/deep/nested/notes.md", "# Заметки\n");
write("node_modules/lib/index.js", "const doWork = 1;\n");
write(".git/config", "[core]\n");
write("dist/bundle.js", "const doWork = 1;\n");
write("logo.png", "не исходник\n");
write("binary.dat", "const doWork = 1;\n");
write(".env", "SECRET=1\n");
write(".env.local", "SECRET=2\n");

(async () => {
  console.log("Анализ проекта (src/project-analysis.js)");

  await test("исходники проекта: заходит вглубь, но не в node_modules, .git и dist", () => {
    const files = analysis.projectSourceFiles(root).map(rel);
    assert.ok(files.includes("src/app.js"), "обычный исходник не найден: " + files.join(", "));
    assert.ok(files.includes("src/deep/nested/notes.md"), "вложенность не пройдена");
    const bad = files.filter((f) => /^(node_modules|\.git|dist)\//.test(f));
    assert.deepStrictEqual(bad, [], "чужие файлы попали в список: " + bad.join(", "));
    assert.ok(!files.includes("logo.png"), "картинка принята за исходник");
    assert.ok(!files.includes("binary.dat"), "файл без известного расширения принят за исходник");
    // Скрытые файлы и служебные папки не трогаем: переименование и «осмотр» не должны
    // заходить ни в .git, ни в чужие настройки (.env проходит исключение по имени,
    // но отсекается списком расширений — это исходники, а не настройки).
    const hidden = files.filter((f) => /(^|\/)\./.test(f));
    assert.deepStrictEqual(hidden, [], "скрытые файлы попали в список: " + hidden.join(", "));
    assert.ok(!files.includes(".env") && !files.includes(".env.local"), "настройки окружения приняты за исходники: " + files.join(", "));
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-empty-"));
    assert.deepStrictEqual(analysis.projectSourceFiles(path.join(empty, "нет-такой")), [], "несуществующая папка — пусто, без падения");
  });

  await test("структура файла: импорты, экспорты и объявления с номерами строк", () => {
    const abs = write("src/struct.ts", [
      "import { helper } from './helper';",
      "const loaded = require('./legacy');",
      "export function runTask(a: number) {",
      "  return a;",
      "}",
      "export default class Runner {",
      "}",
      "type Options = { fast?: boolean };",
      "export { runTask as run };",
      "const localOnly = 42;",
      "",
    ].join("\n"));
    const s = analysis.buildFileStructure(abs, null);
    assert.ok(!s.error, "структура не разобрана: " + s.error);
    assert.strictEqual(s.totalLines, 11, "число строк посчитано неверно: " + s.totalLines);
    const kinds = s.rows.map((r) => r.kind);
    assert.ok(kinds.includes("import"), "импорты не найдены: " + JSON.stringify(s.rows));
    assert.ok(kinds.includes("export"), "экспорты не найдены: " + JSON.stringify(s.rows));
    assert.ok(kinds.includes("decl"), "объявления не найдены: " + JSON.stringify(s.rows));
    const imports = s.rows.filter((r) => r.kind === "import").map((r) => r.text);
    assert.deepStrictEqual(imports, ["./helper", "./legacy"], "импорты разобраны неверно: " + JSON.stringify(imports));
    const lineOf = (text) => (s.rows.find((r) => r.text.indexOf(text) >= 0) || {}).line;
    assert.strictEqual(lineOf("./helper"), 1, "номер строки импорта неверен");
    assert.strictEqual(lineOf("runTask"), 3, "номер строки объявления неверен");
    assert.strictEqual(lineOf("localOnly"), 10, "номер строки const неверен");
    // Отступы: вложенные объявления в структуру не попадают.
    assert.strictEqual(s.rows.filter((r) => /return a/.test(r.text)).length, 0, "внутренности функции попали в структуру");

    // Фильтр — без учёта регистра и по виду записи тоже.
    const onlyImports = analysis.buildFileStructure(abs, "IMPORT");
    assert.ok(onlyImports.rows.length > 0 && onlyImports.rows.every((r) => r.kind === "import"), "фильтр по виду записи не работает");
    // Текст объявления обрезается до имени и подписи: значение агент и так прочтёт сам.
    const byName = analysis.buildFileStructure(abs, "localOnly");
    assert.deepStrictEqual(byName.rows.map((r) => r.text), ["const localOnly"], "фильтр по имени не работает");
    // Сломанное выражение фильтра — не падение, а работа без фильтра.
    assert.ok(analysis.buildFileStructure(abs, "(((").rows.length > 1, "сломанный фильтр уронил разбор");
  });

  await test("структура файла: бинарный и нечитаемый файл объясняются, а не молчат", () => {
    const bin = path.join(root, "some.bin");
    fs.writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
    const r = analysis.buildFileStructure(bin, null);
    assert.ok(r.error && /бинарный/.test(r.error), "бинарный файл не объяснён: " + JSON.stringify(r));
    assert.strictEqual(r.rows, undefined, "у ошибки не должно быть строк структуры");
    const dir = analysis.buildFileStructure(root, null);
    assert.ok(dir.error && /не удалось прочитать/.test(dir.error), "папка вместо файла не объяснена: " + JSON.stringify(dir));
  });

  await test("структура файла: пределы держат ответ читаемым (400 записей, 110 знаков)", () => {
    const many = write("src/many.js", Array.from({ length: 500 }, (_, i) => "const v" + i + " = " + i + ";").join("\n"));
    const s = analysis.buildFileStructure(many, null);
    assert.strictEqual(s.rows.length, 400, "предел записей не соблюдён: " + s.rows.length);
    assert.strictEqual(s.totalLines, 500, "файл целиком не прочитан");
    const long = write("src/long.js", "const veryLongName = " + JSON.stringify("я".repeat(300)) + ";\n");
    const l = analysis.buildFileStructure(long, null);
    assert.ok(l.rows.length === 1, "длинное объявление потерялось");
    assert.ok(l.rows[0].text.length <= 110, "строка не обрезана: " + l.rows[0].text.length);
  });

  await test("переименование: только по границам слова, во всех исходниках", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-rename-"));
    const put = (r, c) => {
      const abs = path.join(proj, r);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, c);
      return abs;
    };
    put("src/main.js", "const doWork = 1;\ndoWork();\nconst worker = doWork + 1;\n");
    put("src/other.js", "export function doWork() { return 2; }\n");
    // Похожие имена с тем же началом: их трогать нельзя — иначе `doWork` превратит
    // `doWorker` в `runTasker`, и проект развалится без единой ошибки.
    put("src/c.js", "const doWorker = 1;\n// myDoWork здесь нет\n");
    put("node_modules/x.js", "doWork\n");
    const r = analysis.refactorRenameFiles(proj, "doWork", "runTask", false);
    assert.ok(!r.error, "переименование упало: " + r.error);
    assert.strictEqual(r.total, 4, "переименовано не то число вхождений: " + r.total);
    assert.strictEqual(r.changed.length, 2, "правки ушли не в те файлы: " + JSON.stringify(r.changed.map((c) => c.rel)));
    assert.deepStrictEqual(r.changed.map((c) => c.rel).sort(), ["src/main.js", "src/other.js"]);
    assert.strictEqual(fs.readFileSync(path.join(proj, "src/c.js"), "utf8"), "const doWorker = 1;\n// myDoWork здесь нет\n", "переименование пошло по частям чужого имени");
    assert.strictEqual(fs.readFileSync(path.join(proj, "src/main.js"), "utf8"), "const runTask = 1;\nrunTask();\nconst worker = runTask + 1;\n", "подстановка пошла по частям слова");
    assert.strictEqual(fs.readFileSync(path.join(proj, "node_modules/x.js"), "utf8"), "doWork\n", "переименование зашло в node_modules");
    // Рассказ о правке: файл, сколько раз, образец строки.
    assert.ok(r.changed.every((c) => c.count > 0 && typeof c.sample === "string" && c.sample.length > 0), "нет образца строки для показа: " + JSON.stringify(r.changed));
  });

  await test("переименование: сухой прогон ничего не пишет, но всё показывает", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-dry-"));
    const file = path.join(proj, "only.js");
    fs.writeFileSync(file, "let oldName = 1;\noldName++;\n");
    const r = analysis.refactorRenameFiles(proj, "oldName", "newName", true);
    assert.strictEqual(r.dryRun, true, "прогон не помечен как сухой");
    assert.strictEqual(r.total, 2, "прикидка посчитала не то: " + r.total);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "let oldName = 1;\noldName++;\n", "сухой прогон изменил файл на диске");

    // Один конкретный файл вместо всего проекта: правка только в нём.
    const other = path.join(proj, "sibling.js");
    fs.writeFileSync(other, "oldName\n");
    const one = analysis.refactorRenameFiles(file, "oldName", "newName", false);
    assert.ok(!one.error, "переименование в одном файле упало: " + one.error);
    assert.strictEqual(one.changed.length, 1, "правка вышла за пределы указанного файла");
    assert.strictEqual(one.changed[0].rel, "only.js", "путь к файлу показан странно: " + one.changed[0].rel);
    assert.strictEqual(fs.readFileSync(other, "utf8"), "oldName\n", "правка задела соседний файл");
  });

  await test("переименование: мусор на входе объясняется, бинарный файл не портится", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-bad-"));
    fs.writeFileSync(path.join(proj, "data.bin"), Buffer.from([0x00, 0x6f, 0x6c, 0x64, 0x00]));
    const bad = [
      analysis.refactorRenameFiles(proj, "не идентификатор", "x", false),
      analysis.refactorRenameFiles(proj, "old", "тоже нет", false),
      analysis.refactorRenameFiles(proj, "same", "same", false),
    ];
    for (const r of bad) assert.ok(r.error, "не объяснено: " + JSON.stringify(r));
    assert.ok(/идентификатор/.test(bad[0].error) && /идентификатор/.test(bad[1].error), "ошибка в имени не названа");
    assert.ok(/совпадают/.test(bad[2].error), "одинаковые имена не отловлены");
    const binFile = path.join(proj, "old.bin");
    fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02]));
    const before = fs.readFileSync(binFile);
    const r = analysis.refactorRenameFiles(proj, "old", "new", false);
    assert.ok(!r.error, "прогон упал на бинарном файле: " + r.error);
    assert.deepStrictEqual(fs.readFileSync(binFile), before, "бинарный файл переписан");
    assert.strictEqual(r.changed.length, 0, "бинарный файл попал в правки: " + JSON.stringify(r.changed));
  });

  await test("ссылки: определение, импорт, вызов и упоминание различаются", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-refs-"));
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src/a.js"), [
      "import { doWork } from './b';",
      "const doWork = require('./b');",
      "function run() {",
      "  return doWork(1);",
      "}",
    ].join("\n"));
    fs.writeFileSync(path.join(proj, "src/b.js"), [
      "export function doWork() {",
      "  return 1;",
      "}",
      "// см. doWork",
    ].join("\n"));
    const r = analysis.findSymbolReferences(proj, "doWork");
    assert.strictEqual(r.error, null, "поиск ссылок упал: " + r.error);
    const kinds = (file) => r.hits.filter((h) => h.file === "src/" + file).map((h) => h.kind);
    assert.deepStrictEqual(kinds("b.js"), ["определение", "ссылка"], "классификация в b.js неверна: " + JSON.stringify(r.hits));
    // `const doWork = require(...)` — это определение символа, а не импорт: агент должен
    // видеть, где символ объявлен, даже если объявили его через require.
    assert.deepStrictEqual(kinds("a.js"), ["импорт", "определение", "вызов"], "классификация в a.js неверна: " + JSON.stringify(r.hits));
    const hit = r.hits.find((h) => h.kind === "вызов");
    assert.strictEqual(hit.n, 4, "номер строки вызова неверен");
    assert.strictEqual(hit.file, "src/a.js", "файл вызова неверен");
    assert.ok(hit.text.length <= 140, "строка не обрезана: " + hit.text.length);
    assert.strictEqual(r.truncated, false, "честно найденные ссылки помечены как обрезанные");
    assert.ok(!r.hits.some((h) => /node_modules/.test(h.file)), "поиск зашёл в node_modules");
    // Символ, которого нет, и мусор на входе.
    assert.deepStrictEqual(analysis.findSymbolReferences(proj, "nothingLikeThis").hits, [], "выдуманный символ что-то нашёл");
    assert.ok(analysis.findSymbolReferences(proj, "не символ").error, "мусор в имени символа не объяснён");
  });

  await test("ссылки: пределы — 25 на файл и 100 всего с честной пометкой", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-many-"));
    fs.writeFileSync(path.join(proj, "few.js"), Array.from({ length: 40 }, () => "target();").join("\n"));
    fs.writeFileSync(path.join(proj, "other.js"), "target();\n");
    const r = analysis.findSymbolReferences(proj, "target");
    assert.strictEqual(r.hits.filter((h) => h.file === "few.js").length, 25, "предел на файл не соблюдён");
    assert.strictEqual(r.hits.length, 26, "второй файл должен быть прочитан до общего предела: " + r.hits.length);
    const wide = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-wide-"));
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(wide, "f" + i + ".js"), Array.from({ length: 30 }, () => "target();").join("\n"));
    const big = analysis.findSymbolReferences(wide, "target");
    assert.strictEqual(big.hits.length, 100, "общий предел ссылок не соблюдён: " + big.hits.length);
    assert.strictEqual(big.truncated, true, "обрезанный ответ не помечен");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of [
      "function projectSourceFiles(",
      "function buildFileStructure(",
      "function refactorRenameFiles(",
      "function findSymbolReferences(",
      "const escRe = (s) => String(s).replace",
    ]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createProjectAnalysis \} = require\("\.\/project-analysis\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(/createProjectAnalysis\(\{ fs, path \}\)/.test(MAIN_SRC), "модуль собран не на своём месте или без fs/path");
    for (const use of ["projectSourceFiles,", "buildFileStructure,", "refactorRenameFiles,", "findSymbolReferences,", "argsPathIsFile,", "escRe }"]) {
      assert.ok(MAIN_SRC.includes(use), "оболочка перестала отдавать инструментам: " + use);
    }
    assert.ok(MODULE_SRC.includes("3000") && MODULE_SRC.includes("400") && MODULE_SRC.includes("100"), "пределы пропали из модуля");
    assert.ok(!/require\("(?!\.\/)/.test(MODULE_SRC), "модуль тянет зависимости со стороны");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

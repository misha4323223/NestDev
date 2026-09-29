"use strict";

/* ── Документы проекта: раскладка и целостность истории ───────────────────────
   Запуск: node test/docs.test.js   (входит в общий `npm test`)

   Зачем этот набор. Документы съехали из корня в `docs/`, а `HANDOFF.md`
   разгружен: 58 КБ истории одной строкой разложены по записям в `istoriya.md`
   (часть 77). У такой разгрузки одна опасность, и она тихая — ПОТЕРЯ ТЕКСТА:
   файл переписан, часть записей не доехала, а глазами не видно, потому что
   строку в 58 килобайт никто не вычитывает целиком.

   Поэтому проверяется не «файлы на месте», а целостность: записи истории идут
   подряд без пропусков и повторов, у каждой есть текст, в `HANDOFF.md` не
   осталось ни одной записи и ни одной строки-монстра, а номера его разделов не
   сдвинулись — на §4 и §7 ссылаются код и тесты.

   Разбор живёт отдельными функциями (historyEntries, longestLine,
   sectionNumbers): их же дёргают негативные контроли. Без них страж неотличим от
   «всегда молчит», а такой страж хуже отсутствующего. */

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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ── Разбор: чистые функции, чтобы их можно было проверить на подложных текстах ──
// Записи истории: по заголовку «## После части NN».
const historyEntries = (src) => [...src.matchAll(/^## После части (\d+)[ \t]*$/gm)].map((m) => Number(m[1]));
// Запись истории, оставшаяся строкой в HANDOFF («Ранее, после части NN …»).
const historyLeft = (src) => /Ранее, после части \d/.test(src);
// Самая длинная физическая строка: 58 КБ в одну строку — то, от чего уходили.
const longestLine = (src) => Math.max(...src.split("\n").map((l) => l.length));
// Номера разделов документа: «## 1. Что за проект», «## 6.1. …».
const sectionNumbers = (src) => [...src.matchAll(/^## (\d+(?:\.\d+)?)\./gm)].map((m) => m[1]);
// Файл docs/, о котором не знает docs/README.md: папка без указателя — тоже потеря.
const missingInReadme = (readme, names) => names.filter((n) => !readme.includes(n));

const HANDOFF = read("docs", "HANDOFF.md");
const ISTORIYA = read("docs", "istoriya.md");
const README = read("docs", "README.md");

// Части, которые обязаны быть в истории: свежие сверху, без пропусков.
const PARTS = Array.from({ length: 24 }, (_, i) => 74 - i);
// Разделы HANDOFF: на §4 и §7 ссылаются тесты и src/, остальные — адреса внутри текста.
const SECTIONS = ["1", "2", "3", "4", "5", "6", "6.1", "6.2", "6.3", "6.4", "7", "7.1", "8", "9", "10"];

(async function main() {
  console.log("\n[1] HANDOFF разгружен, а разделы на месте");

  await test("HANDOFF: истории в нём нет и строки-монстра тоже", () => {
    assert.strictEqual(historyLeft(HANDOFF), false, "в HANDOFF остались записи «Ранее, после части»");
    const max = longestLine(HANDOFF);
    assert.ok(max < 4000, "в HANDOFF строка в " + max + " символов — история вернулась одной строкой");
  });

  await test("HANDOFF: номера разделов не сдвинулись (на них ссылаются код и тесты)", () => {
    const got = sectionNumbers(HANDOFF);
    for (const n of SECTIONS) assert.ok(got.includes(n), "в HANDOFF нет раздела §" + n);
    assert.strictEqual(got.length, SECTIONS.length, "разделов стало больше или меньше: " + got.join(", "));
    assert.strictEqual(new Set(got).size, got.length, "в HANDOFF повторяются номера разделов: " + got.join(", "));
  });

  await test("HANDOFF: он говорит, где искать историю, а не молчит о ней", () => {
    assert.ok(/istoriya\.md/.test(HANDOFF), "HANDOFF не указывает на историю");
    assert.ok(/docs\/AGENT-NOTES\.md/.test(HANDOFF), "HANDOFF указывает на журнал по старому пути");
  });

  await test("docs/README.md знает каждый документ папки — о незнакомом не узнают", () => {
    const names = fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md") && f !== "README.md");
    assert.ok(names.length >= 4, "в docs/ подозрительно мало документов: " + names.join(", "));
    assert.deepStrictEqual(missingInReadme(README, names), [], "docs/README.md молчит о файлах");
  });

  console.log("\n[2] История: записи на месте, текст не потерян");

  await test("история: 24 записи, части 74…51 подряд, без пропусков и повторов", () => {
    const nums = historyEntries(ISTORIYA);
    assert.strictEqual(nums.length, PARTS.length, "записей не " + PARTS.length + ": " + nums.length);
    assert.deepStrictEqual(nums, PARTS, "номера записей идут не подряд: " + nums.join(", "));
  });

  await test("история: маркеры стали заголовками, а не остались в тексте", () => {
    assert.strictEqual(historyLeft(ISTORIYA), false, "в записях остался старый маркер «Ранее, после части»");
    const bodies = ISTORIYA.split(/^## После части \d+[ \t]*$/m).slice(1);
    assert.strictEqual(bodies.length, PARTS.length, "заголовков и записей разное число: " + bodies.length);
    for (const b of bodies) assert.ok(b.trim().length > 200, "запись почти пуста: " + b.trim().slice(0, 60));
  });

  await test("история: у известных частей текст на месте (сверка по опознавательным словам)", () => {
    // Точечная сверка вместо «на глаз»: если разбор потеряет кусок текста, он
    // уедет вместе со своими словами — по ним это и видно.
    const section = (n) => {
      const at = ISTORIYA.indexOf("## После части " + n + "\n");
      assert.ok(at >= 0, "нет записи о части " + n);
      const next = ISTORIYA.indexOf("\n## После части ", at + 1);
      return ISTORIYA.slice(at, next < 0 ? ISTORIYA.length : next);
    };
    for (const [n, needle] of [[74, "полку сервисов"], [73, "yc-cdn.js"], [66, "Playwright"], [51, "YDB"]]) {
      assert.ok(section(n).includes(needle), "в записи о части " + n + " потерян текст: нет «" + needle + "»");
    }
  });

  console.log("\n[3] Негативные контроли: страж обязан ловить, а не молчать");

  await test("подложный HANDOFF с историей обязан падать", () => {
    const fake = "Обновлено сегодня.\n\nРанее, после части 60 чекбоксы облака больше не сбрасываются.\n";
    assert.strictEqual(historyLeft(fake), true, "оставшаяся история не замечена");
  });

  await test("история с пропущенной частью обязана падать", () => {
    const fake = PARTS.filter((n) => n !== 60)
      .map((n) => "## После части " + n + "\n\nтекст записи\n")
      .join("\n");
    assert.notDeepStrictEqual(historyEntries(fake), PARTS, "пропуск части 60 не замечен");
  });

  await test("строка в 50 КБ обязана падать, а нормальные строки — нет", () => {
    assert.ok(longestLine("первая\n" + "x".repeat(50000) + "\nтретья") >= 4000, "строка-монстр не замечена");
    assert.ok(longestLine("## 1. Что за проект\nобычный абзац\n") < 4000, "обычный текст принят за монстра");
  });

  await test("README без строки об istoriya.md обязан падать", () => {
    const fake = "| `HANDOFF.md` | передача |\n| `ARCHITECTURE.md` | карта |\n| `AGENT-NOTES.md` | журнал |\n";
    const names = ["HANDOFF.md", "ARCHITECTURE.md", "AGENT-NOTES.md", "istoriya.md"];
    assert.deepStrictEqual(
      missingInReadme(fake, names),
      ["istoriya.md"],
      "пропажа документа в README не замечена"
    );
  });

  await test("пропавший раздел HANDOFF обязан падать", () => {
    const fake = SECTIONS.filter((n) => n !== "7").map((n) => "## " + n + ". Название\n").join("\n");
    for (const n of SECTIONS) {
      if (n === "7") {
        assert.ok(!sectionNumbers(fake).includes(n), "пропажа §7 не замечена");
      } else {
        assert.ok(sectionNumbers(fake).includes(n), "живой раздел §" + n + " потерялся при разборе");
      }
    }
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало\n");
  process.exit(failed ? 1 : 0);
})();

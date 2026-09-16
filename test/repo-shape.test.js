"use strict";

/* ── Форма репозитория: один продукт, без мёртвого прототипа ────────────────
   Запуск: node test/repo-shape.test.js   (входит в общий `npm test`)

   Зачем отдельный файл. В репозитории лежал второй, заброшенный прототип того же
   приложения на Flutter (pubspec.yaml + lib/*.dart + папки android/ios/macos/linux/
   windows, 133 файла, один коммит от 2026-09-07, ни разу не тронутый после).
   Он не попадал ни в сборку, ни в OTA-бандл, но выглядел как живое приложение:
   путал разбор проекта и включал ложные срабатывания (детектор dev-серверов ловил
   `flutter run`, поиск по проекту — `.dart_tool`).

   Здесь проверяется две вещи, и обе важны одинаково:

     1. Прототип не вернулся (в том числе случайным мержем ветки).
     2. Живое приложение при удалении не пострадало: точка входа Electron на месте,
        разметка на месте, OTA-бандл не ссылается на удалённое, и ни один живой
        файл не обращается к путям прототипа.

   Осознанно НЕ проверяются и НЕ должны удаляться: поддержка Dart в редакторе
   (`.dart` в подсветке), `flutter run` в детекторе dev-серверов и `.dart_tool`
   в списке игнора обхода — это общая работа с чужими проектами, а не наш прототип. */

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

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// Корневые файлы Flutter-проекта.
const FLUTTER_FILES = ["pubspec.yaml", "pubspec.lock", ".metadata", "analysis_options.yaml"];
// Платформенные папки Flutter (web/ и assets/ — не его: web/ в .gitignore, assets/ нужен Electron).
const FLUTTER_DIRS = ["android", "ios", "macos", "linux", "windows"];
// Пути-подписи прототипа: их в живом коде быть не должно. Умышленно узкие — чтобы
// не задеть чужое («linux/amd64/yc» в тестах Yandex Cloud CLI, «metadata.id» в картинках).
const FLUTTER_PATHS = /pubspec|analysis_options|windows\/runner|macos\/Runner|linux\/runner|ios\/Runner|android\/app|FlutterWindow|package:flutter/;

// Что обходим, проверяя живой код на ссылки в никуда.
const LIVE_ENTRIES = ["src", "scripts", "test", "server.js", "package.json", "electron-builder.yml"];

function walk(rel, out) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(path.join(rel, name), out);
    return out;
  }
  out.push(rel);
  return out;
}

(async () => {
  await test("прототип: корневых файлов Flutter нет", () => {
    const left = FLUTTER_FILES.filter(exists);
    assert.strictEqual(left.length, 0, "остались: " + left.join(", "));
  });

  await test("прототип: платформенных папок Flutter нет", () => {
    const left = FLUTTER_DIRS.filter(exists);
    assert.strictEqual(left.length, 0, "остались: " + left.join(", "));
  });

  await test("прототип: ни одного dart/swift/kotlin-исходника (в т.ч. test/widget_test.dart)", () => {
    const files = walk("src", []).concat(walk("test", []), walk("scripts", []));
    const left = files.filter((f) => /\.(dart|swift|kt|pbxproj)$/i.test(f));
    assert.strictEqual(left.length, 0, "остались: " + left.join(", "));
    assert.ok(!exists("test/widget_test.dart"), "вернулся Flutter-тест test/widget_test.dart");
  });

  await test("прототип: .gitignore без его правил (но IDE-правила на месте)", () => {
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.ok(!/\.dart_tool|\.flutter-plugins/.test(gi), "в .gitignore остались правила Flutter");
    assert.ok(/^\.idea\/$/m.test(gi) && /^\*\.iml$/m.test(gi), "потеряны общие правила IDE");
    assert.ok(/^node_modules\/$/m.test(gi) && /^dist\/$/m.test(gi), "потеряны правила сборки");
    // OTA-бандл по-прежнему коммитим — иначе обновления не доедут.
    assert.ok(/^!ota\/bundle\.json$/m.test(gi) && /^!ota\/manifest\.json$/m.test(gi), "OTA-бандл больше не коммитится");
  });

  await test("живое приложение: точка входа и разметка на месте", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.strictEqual(pkg.main, "src/bootstrap.js", "сменилась точка входа");
    assert.ok(exists(pkg.main), "нет " + pkg.main);
    for (const f of ["src/main.js", "src/preload.js", "src/renderer/index.html", "src/renderer/app.js", "server.js", "electron-builder.yml"]) {
      assert.ok(exists(f), "пропал " + f);
    }
    assert.ok(fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8").includes("app.js"), "разметка не грузит app.js");
  });

  await test("живое приложение: ни один живой файл не ссылается на удалённый прототип", () => {
    const files = LIVE_ENTRIES.flatMap((e) => walk(e, []));
    const hits = [];
    for (const rel of files) {
      if (/\.(png|jpg|ico|woff2?|ttf)$/i.test(rel)) continue;
      // Себя не проверяем: список запрещённых путей — это и есть текст этого файла.
      if (rel === path.join("test", "repo-shape.test.js")) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (FLUTTER_PATHS.test(text)) hits.push(rel);
    }
    assert.strictEqual(hits.length, 0, "ссылки на прототип в: " + hits.join(", "));
  });

  await test("живое приложение: OTA-бандл собран из живых файлов и без прототипа", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "ota", "manifest.json"), "utf8"));
    const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "ota", "bundle.json"), "utf8"));
    const names = Object.keys(bundle.files || {});
    assert.ok(names.length > 0, "бандл пуст");
    assert.ok(names.indexOf("src/main.js") !== -1, "в бандле нет src/main.js");
    const foreign = names.filter((n) => /^(lib|android|ios|macos|windows|linux)\/|^pubspec/.test(n));
    assert.strictEqual(foreign.length, 0, "в бандле файлы прототипа: " + foreign.join(", "));
    assert.ok(manifest.version && manifest.files > 0, "у манифеста нет версии/файлов");
  });

  await test("раскладка интерфейса: карта, разметка и список для телефона согласованы", () => {
    const doc = fs.readFileSync(path.join(ROOT, "ARCHITECTURE.md"), "utf8");
    assert.ok(doc.includes("<!-- UI-MAP:START -->"), "в ARCHITECTURE.md нет карты интерфейса");
    const rows = doc
      .split("<!-- UI-MAP:START -->")[1]
      .split("<!-- UI-MAP:END -->")[0]
      .split("\n")
      .filter((l) => l.trim().startsWith("|"))
      .filter((l) => !/^\|\s*(Файл|-)/.test(l.trim()))
      .map((l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()));
    const mapped = rows.map((r) => r[0]);
    assert.ok(mapped.length > 0, "карта интерфейса пуста");
    assert.strictEqual(new Set(mapped).size, mapped.length, "в карте повторяются файлы");

    // 1. Карта и диск совпадают: ни забытого файла, ни строки в никуда.
    const onDisk = fs.readdirSync(path.join(ROOT, "src", "renderer")).sort();
    const onDiskRel = onDisk.map((f) => "src/renderer/" + f).sort();
    assert.deepStrictEqual(mapped.slice().sort(), onDiskRel, "карта интерфейса и файлы рендерера разошлись");
    for (const rel of mapped) assert.ok(fs.existsSync(path.join(ROOT, rel)), "в карте путь в никуда: " + rel);

    // 2. Разметка грузит ровно те скрипты и стили, что лежат в рендерере.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const tags = [...html.matchAll(/(?:src|href)="([^"/][^"]*\.(?:js|css))"/g)]
      .map((m) => "src/renderer/" + m[1])
      .sort();
    const assets = onDisk.filter((f) => /\.(js|css)$/.test(f)).map((f) => "src/renderer/" + f).sort();
    assert.deepStrictEqual(tags, assets, "разметка и файлы рендерера разошлись (забытый тег или файл без тега)");

    // 3. Телефон получает те же файлы — иначе раздел молча не работает на телефоне.
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    const from = bridge.indexOf("const STATIC_FILES");
    const staticBlock = bridge.slice(from, bridge.indexOf("]);", from));
    for (const rel of mapped) {
      const name = path.basename(rel);
      assert.ok(staticBlock.includes('"' + name + '"'), "телефон не получит " + name + " (нет в STATIC_FILES моста)");
    }

    // 4. Столбец «где подключается»: файл существует, фрагмент в нём есть.
    for (const row of rows) {
      const where = row[2] || "";
      const m = where.match(/^([\w.-]+\.(?:js|css)):\s*(.+)$/);
      if (!m) continue;
      const target = path.join(ROOT, "src", "renderer", m[1]);
      assert.ok(fs.existsSync(target), row[0] + ": в карте указан несуществующий " + m[1]);
      assert.ok(fs.readFileSync(target, "utf8").includes(m[2]), row[0] + ": в " + m[1] + " нет " + JSON.stringify(m[2]));
    }
  });

  await test("бюджет прямых чтений app.js в тестах не растёт", () => {
    // Разбор app.js идёт этапами: код уезжает в модули, и проверки должны находить его
    // через uiFile/uiAll/uiFind (test/smoke.test.js). Прямое чтение app.js остаётся
    // только там, где проверяется «в app.js этого больше нет» — таких мест 33, и число
    // не должно расти: каждое новое чтение привязывает тесты к адресу кода.
    const files = walk("test", []).filter((f) => f.endsWith(".js"));
    let n = 0;
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      n += (text.match(/readFileSync\(path\.join\(ROOT, "src", "renderer", "app\.js"\)/g) || []).length;
    }
    assert.ok(n <= 33, "прямых чтений app.js стало " + n + " (потолок 33). Возьмите кусок через uiFile/uiAll/uiFind; если чтение действительно нужно — поднимите потолок здесь осознанно, с пояснением.");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

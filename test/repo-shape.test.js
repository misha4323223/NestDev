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

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

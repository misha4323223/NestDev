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

    // 5. Каждый вызов модуля существует в самом модуле: «Модуль.имя(» в окне обязан
    //    иметь «имя» среди того, что модуль отдаёт наружу. Это ловит опечатки и вызовы
    //    по памяти — ровно тот класс, из которого выросло падение ленты 1.5.118.
    const rendererFiles = onDisk.filter((f) => f.endsWith(".js")).map((f) => path.join(ROOT, "src", "renderer", f));
    const callersText = rendererFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    let checkedCalls = 0;
    for (const row of rows) {
      const where = row[2] || "";
      const wm = where.match(/window\.([\w$]+)\(/);
      if (!wm) continue;
      const modName = wm[1];
      const modSrc = fs.readFileSync(path.join(ROOT, row[0]), "utf8");
      const retIdx = modSrc.lastIndexOf("return {");
      assert.ok(retIdx > 0, row[0] + ": не нашёл, что модуль отдаёт наружу");
      const retBlock = modSrc.slice(retIdx + "return {".length, modSrc.indexOf("};", retIdx));
      const exported = new Set((retBlock.match(/^\s*([\w$]+)\s*[:,]/gm) || []).map((x) => x.trim().replace(/[:,]$/, "")));
      assert.ok(exported.size > 0, row[0] + ": наружу не отдаётся ничего");
      const calls = callersText.match(new RegExp(modName + "\\.([\\w$]+)\\(", "g")) || [];
      for (const call of calls) {
        const fn = call.slice(modName.length + 1, -1);
        checkedCalls++;
        assert.ok(
          exported.has(fn) || fn === "then" || fn === "catch",
          modName + "." + fn + " вызывается в окне, но " + row[0] + " его не отдаёт"
        );
      }
    }
    assert.ok(checkedCalls > 50, "вызовов модулей проверено подозрительно мало: " + checkedCalls);
  });

  await test("проводки модулей не читают модуль, объявленный ниже (окно падает на загрузке)", () => {
    // Почему: зависимости проводки вычисляются на загрузке окна. Если внутри блока
    // `const Panel = window.Panel({ ... })` прочитать модуль, объявленный НИЖЕ, окно
    // падает с «Cannot access before initialization» — и весь остаток загрузки (в том
    // числе подписка на события агента) не выполняется. Именно так дважды подряд падал
    // вынос панели настроек: сначала SettingsPanel, потом YcPanel.
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const lines = appSrc.split("\n");
    const decl = new Map(); // имя модуля → номер строки объявления
    lines.forEach((l, i) => {
      const m = /^  const ([A-Za-z_$][\w$]*) = window\.[A-Za-z_$][\w$]*\(\{/.exec(l);
      if (m) decl.set(m[1], i + 1);
    });
    assert.ok(decl.size > 10, "не нашёл объявления модулей в app.js: " + decl.size);

    let checked = 0;
    for (const [name, start] of decl) {
      let end = start;
      if (!/\}\);\s*$/.test(lines[start - 1])) {
        for (let i = start; i < lines.length; i++) {
          if (/^  \}\);/.test(lines[i])) { end = i + 1; break; }
        }
      }
      assert.ok(end >= start, name + ": не нашёл конец блока проводки");
      for (let i = start; i < end; i++) { // строка объявления не в счёт: в ней есть и "window." + имя
        const line = lines[i];
        if (/^\s*\//.test(line)) continue; // комментарий ничего не читает
        if (line.indexOf("=>") !== -1) continue; // отложенное чтение — безопасно
        // Ловим и \`Модуль.метод\`, и прямое чтение значения (\`YcPanel: YcPanel\`): на загрузке
        // окна оба берут биндинг const, а он ещё не инициализирован. Ключ объекта —
        // не чтение, поэтому \`Имя:\` пропускаем.
        for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const w = m[0];
          if (!decl.has(w)) continue;
          if (/^\s*:/.test(line.slice(m.index + w.length))) continue;
          if (decl.get(w) >= start) {
            assert.fail(
              "app.js:" + (i + 1) + " проводка " + name + " читает " + w +
                " (объявлен строкой " + decl.get(w) + ") — нужна отложенная стрелка"
            );
          }
        }
      }
      checked++;
    }
    assert.ok(checked > 10, "проводок проверено подозрительно мало: " + checked);
  });

  await test("живые прогоны: перехват модуля по подстроке не заглатывает соседей по дому", () => {
    // Почему: живые прогоны подменяют электрон и перехватывают require по ПОДСТРОКЕ
    // (`if (t.indexOf("agent-tools") >= 0)`). Пока в доме был один agent-tools.js, это
    // работало; после дробления (часть 40) та же подстрока стала матчить и
    // agent-tools-git.js — прогон получал «{ createAgentTools } без createGitTools» и падал
    // на «createGitTools is not a function». Два таких прогона (projects и run-ipc) молчали
    // до тех пор, пока живые прогоны не прогнали ЦЕЛИКОМ: ни набор, ни сторож дома в них
    // не смотрит.
    const srcFiles = fs.readdirSync(path.join(ROOT, "src"));
    const liveScripts = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^live-.*\.js$/.test(f));
    assert.ok(liveScripts.length > 20, "живых прогонов найдено подозрительно мало: " + liveScripts.length);
    const bad = [];
    let needles = 0;
    for (const f of liveScripts) {
      const src = fs.readFileSync(path.join(ROOT, "scripts", f), "utf8");
      for (const m of src.matchAll(/indexOf\("([^"]+)"\)\s*>=\s*0/g)) {
        const needle = m[1];
        const hits = srcFiles.filter((x) => x.indexOf(needle) >= 0);
        if (!hits.length) continue; // это не имя модуля, а поиск по тексту — не наше дело
        needles++;
        if (hits.length > 1) bad.push(f + ": «" + needle + "» → " + hits.join(", "));
      }
    }
    assert.ok(needles >= 5, "перехватов модулей найдено подозрительно мало: " + needles);
    assert.deepStrictEqual(bad, [], "перехват по подстроке заглатывает несколько модулей — прогон слепнет или падает: " + bad.join(" | "));
  });

  await test("живые прогоны знают настоящие имена депсов модулей, а не прежние", () => {
    // Почему: стенд живого прогона собирает модуль САМ и передаёт ему по имени то же
    // состояние, что main.js. Переименование депса (часть 44: userDataDir → tasksDataDir)
    // стенд при этом не ловит: модуль падает только в момент ВЫЗОВА канала
    // («tasksDataDir is not a function»), и так молчали два стенда — live-mission и
    // live-reminders — до тех пор, пока живые прогоны не прогнали целиком. Здесь
    // проверяется обратная сторона той же проводки и по имени: каждое имя, которое
    // прогон передаёт модулю, обязано быть либо его депсом, либо живым значением моста,
    // либо швом, который модуль читает сам (`deps.now`). Направление безопасное: не
    // требуем передать ВСЁ, а запрещаем передавать несуществующее.
    const { depsOf } = require(path.join(__dirname, "backend-wiring.js"));
    const srcFiles = fs.readdirSync(path.join(ROOT, "src"));
    const owner = new Map(); // имя сборщика → его модуль
    for (const f of srcFiles) {
      if (!/\.js$/.test(f)) continue;
      const src = fs.readFileSync(path.join(ROOT, "src", f), "utf8");
      for (const m of src.matchAll(/^(?:async )?function ((?:create|register)[A-Za-z0-9_]+)\s*\(/gm)) {
        owner.set(m[1], { file: f, src: src });
      }
    }
    // Блок аргументов от «{» до парной «}»: без этого ключи вложенных объектов
    // (shell: { … }, live: { … }) смешались бы с именами депсов.
    const callBlock = (text, at) => {
      let depth = 0;
      for (let i = at; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          i++;
          while (i < text.length && text[i] !== q) { if (text[i] === "\\") i++; i++; }
          continue;
        }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) return text.slice(at, i + 1); }
      }
      return "";
    };
    // Ключи ТОЛЬКО первого уровня: { fs: fs, shell: { … }, tasksDataDir: () => ud }.
    const topKeys = (block) => {
      const inner = block.slice(1, -1);
      const parts = [];
      let depth = 0;
      let cur = "";
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        // Комментарии внутри сборки — не код: в них есть и запятые, и скобки, и
        // двоеточия («Дела читаются в папке дел, а не в папке приложения (часть 44)»),
        // и от них разбор ключей ломался (та же ловушка, что у разбора deps в
        // test/backend-wiring.js — комментарии внутри блока убираются отдельно).
        if (c === "/" && inner[i + 1] === "/") {
          while (i < inner.length && inner[i] !== "\n") i++;
          continue;
        }
        if (c === "/" && inner[i + 1] === "*") {
          i += 2;
          while (i < inner.length && !(inner[i] === "*" && inner[i + 1] === "/")) i++;
          i++;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          cur += c;
          i++;
          while (i < inner.length && inner[i] !== q) { cur += inner[i]; if (inner[i] === "\\") { i++; cur += inner[i]; } i++; }
          cur += q;
          continue;
        }
        if (c === "{" || c === "(" || c === "[") depth++;
        if (c === "}" || c === ")" || c === "]") depth--;
        if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
        cur += c;
      }
      parts.push(cur);
      return parts
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const m = p.match(/^([A-Za-z0-9_$]+)\s*:/);
          if (m) return m[1];
          return /^[A-Za-z0-9_$]+$/.test(p) ? p : null; // сокращённая запись: { fs, path }
        })
        .filter(Boolean);
    };
    const liveScripts = fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => /^live-.*\.js$/.test(f));
    const bad = [];
    let checked = 0;
    for (const f of liveScripts) {
      const text = fs.readFileSync(path.join(ROOT, "scripts", f), "utf8");
      for (const m of text.matchAll(/(?:^|[^.\w$])((?:create|register)[A-Za-z0-9_]+)\s*\(/g)) {
        const own = owner.get(m[1]);
        if (!own) continue;
        const brace = text.indexOf("{", m.index + m[0].length - 1);
        if (brace < 0) continue;
        const block = callBlock(text, brace);
        // Разлёт (`...base`) делает ключи невидимыми — такую сборку сторож не судит.
        if (!block || block.indexOf("...") >= 0) continue;
        const keys = topKeys(block);
        const deps = depsOf(own.src);
        if (!keys.length || !deps.size) continue; // распаковки нет — судить нечем
        checked++;
        const liveKeys = new Set([...own.src.matchAll(/\b(?:get|set)\s+([A-Za-z0-9_$]+)\s*\(/g)].map((x) => x[1]));
        for (const k of keys) {
          if (deps.has(k) || liveKeys.has(k) || new RegExp("deps\\." + k + "\\b").test(own.src)) continue;
          bad.push(f + " → " + own.file + " («" + k + "»)");
        }
      }
    }
    assert.ok(checked >= 8, "сборок модулей в живых прогонах найдено подозрительно мало: " + checked);
    assert.deepStrictEqual(bad, [], "живой прогон передаёт модулю имя, которого в нём нет — прогон упадёт в момент вызова: " + bad.join(" | "));
  });

  await test("бюджет прямых чтений app.js в тестах не растёт", () => {
    // Разбор app.js идёт этапами: код уезжает в модули, и проверки должны находить его
    // через uiFile/uiAll/uiFind (test/smoke.test.js). Прямое чтение app.js остаётся
    // только там, где проверяется «в app.js этого больше нет» — таких мест 33, и число
    // не должно расти само по себе: каждое лишнее чтение привязывает тесты к адресу кода.
    // Потолок поднят с 33 до 34 С ОСОЗНАННЫМ ИСКЛЮЧЕНИЕМ (этап A, часть 8): у каждого
    // нового модуля окна есть свой набор, и в нём ровно одно прямое чтение — проверка
    // «этого кода в оболочке больше нет». Без неё вынос можно считать завершённым,
    // а код — остаться в app.js двумя копиями. Больше одного чтения на модуль быть
    // не должно: всё остальное берётся через uiAll()/uiFile().
    //
    // Потолок поднят с 34 до 35 (часть 44, папки работы агента) — тем же правилом и с
    // тем же смыслом: окно «Куда класть работу агента?» живёт в settings-panel.js, а
    // один его шов лежит в оболочке — вопрос задаётся ПОСЛЕ загрузки настроек
    // (afterLoad в chat-store + вызов сборки окна в app.js). Проверить этот шов можно
    // только чтением app.js; второе чтение на эту же часть не добавлялось.
    //
    // Потолок поднят с 35 до 36 (плашка Reasoning, test/reasoning.test.js) — тем же
    // правилом: модуль окна, и в его наборе ровно одно чтение app.js. Причина, по
    // которой набор вообще появился: UMD-хвост reasoning.js ВЫЗЫВАЛ фабрику, оболочка
    // зовёт её фабрикой — и окно целиком падало на «window.Reasoning is not a function»
    // при зелёном наборе. Первое, что проверяет новый набор, — та же сборка в оболочке
    // (`window.Reasoning({` + проводка), а без чтения app.js этой проверки не сделать.
    // Потолок поднят с 36 до 37 (вложения, test/attach.test.js) — тем же правилом и с
    // тем же смыслом: три пути к вложению (скрепка, перетаскивание, вставка) живут
    // в замыкании app.js, наружу они не выставлены, поэтому контракт проверяется по
    // её исходнику. Ровно одно чтение на набор; без него исчезновение любого из трёх
    // путей было бы невидимым — а исчезнуть они могут тихо, без ошибок в консоли.
    //
    // Потолок поднят с 37 до 38 (чистка реестра образов, test/yc-registry.test.js) — тем
    // же правилом и с тем же смыслом: удаление образа из карточки реестра необратимо,
    // поэтому оно обязано спрашивать подтверждение — и берёт его у панели через новую
    // проводку `confirmModal` в сборке SidePanel (app.js → side-panel.js → window.uiConfirm).
    // Если эту проводку уберут, удаление тихо свалится в системный window.confirm —
    // ни один другой набор этого не увидит, а окно расходится с остальным интерфейсом.
    // Ровно одно чтение app.js на набор — только эта проводка.
    //
    // Потолок поднят с 38 до 39 (файлы бакета, test/yc-storage.test.js) — тем же
    // правилом: удаление объекта из таблицы карточки бакета необратимо, и вопрос
    // задаётся той же проводкой `confirmModal` (app.js → side-panel.js → window.uiConfirm).
    // Набор читает app.js ровно один раз и только за это — без чтения исчезновение
    // проводки было бы невидимым, а объект удалялся бы с одного клика.
    //
    // Считаем обе формы: и длинную (readFileSync(path.join(...))) и короткий помощник
    // read("src", "renderer", "app.js") из отдельных наборов — иначе чтение через
    // помощник осталось бы для сторожа невидимым.
    const files = walk("test", []).filter((f) => f.endsWith(".js"));
    let n = 0;
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      n +=
        (text.match(/readFileSync\(path\.join\(ROOT, "src", "renderer", "app\.js"\)/g) || []).length +
        (text.match(/\bread\("src", "renderer", "app\.js"\)/g) || []).length;
    }
    assert.ok(n <= 39, "прямых чтений app.js стало " + n + " (потолок 39). Возьмите кусок через uiFile/uiAll/uiFind; если чтение действительно нужно — поднимите потолок здесь осознанно, с пояснением.");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

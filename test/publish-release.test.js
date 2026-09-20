"use strict";

/* ── Выкладка релиза на GitHub (scripts/publish-release.js) ──────────────────
   Запуск: node test/publish-release.test.js   (входит в общий `npm test`)

   Зачем отдельный файл. Релиз на GitHub — это ЕДИНСТВЕННЫЙ сетевой канал
   автообновления у установленных копий (electron-updater, releaseType: release).
   Ошибка здесь тихая и дорогая: релиз выглядит выложенным, а обновление к людям
   не приходит. Поэтому проверяются ровно те свойства, на которых это ломается:

     • версия берётся из собранного dist/latest.yml, а не из package.json —
       у выложенного релиза и тега версия обязана совпадать с установщиком;
     • без latest.yml релиз бессмысленен, а без установщика он вообще неполный;
     • занятый тег не даёт молча потерять прошлый релиз;
     • многострочный текст релиза уходит ФАЙЛОМ: аргументом он ломается в
       оболочке Windows, где скрипт и запускается;
     • про черновик/prerelease сказано прямо — их electron-updater не видит.

   Сеть в проверках не требуется: всё, что ходит в GitHub, остаётся в режиме
   «только показать» (--dry-run), а выкладка не выполняется. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "publish-release.js");
const SCRIPT_SRC = fs.readFileSync(SCRIPT, "utf8");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
// Репозиторий канала обновлений: он же цель выкладки (origin может указывать на старое имя).
const CFG = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
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

const run = (argv) =>
  spawnSync(process.execPath, [SCRIPT].concat(argv), { cwd: ROOT, encoding: "utf8", timeout: 60000 });

// Сборка как её оставляет electron-builder: latest.yml, установщик и его blockmap.
function fakeDist(version, opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-dist-"));
  const exe = "ai_agent-" + version + "-x64.exe";
  if (o.latest !== false) {
    fs.writeFileSync(
      path.join(dir, "latest.yml"),
      "version: " + (o.versionLine === undefined ? version : o.versionLine) + "\n" +
        "files:\n  - url: " + exe + "\n    sha512: abc\n    size: 100\n" +
        "path: " + (o.pathLine === undefined ? exe : o.pathLine) + "\n" +
        "sha512: abc\nreleaseDate: '2026-09-19T00:00:00.000Z'\n"
    );
  }
  if (o.installer !== false) fs.writeFileSync(path.join(dir, exe), "установщик");
  if (o.blockmap !== false) fs.writeFileSync(path.join(dir, exe + ".blockmap"), "blockmap");
  return { dir, exe };
}

(async () => {
  console.log("Выкладка релиза (scripts/publish-release.js)");

  await test("подсказка называет одну команду и сборку до неё", () => {
    const r = run(["--help"]);
    assert.strictEqual(r.status, 0, "подсказка не показывается: " + r.stderr);
    assert.ok(/npm run release:win/.test(r.stdout), "не названа команда выкладки");
    assert.ok(/npm run dist:win/.test(r.stdout), "не сказано, что сначала сборка");
  });

  await test("без сборки объясняет, что делать: нет dist/latest.yml", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "release-empty-"));
    const r = run(["--dry-run", "--dist", empty]);
    assert.notStrictEqual(r.status, 0, "пустая папка принята за готовую сборку");
    assert.ok(/Сначала собери установщик: npm run dist:win/.test(r.stdout + r.stderr), "нет объяснения: " + r.stdout);
  });

  await test("версия берётся из сборки, а не из package.json", () => {
    // Версия заведомо чужая: если скрипт возьмёт version из package.json, тег
    // окажется не тем, что внутри установщика, и обновление не найдётся.
    const d = fakeDist("9.9.9");
    const r = run(["--dry-run", "--dist", d.dir]);
    assert.strictEqual(r.status, 0, "проверки не прошли: " + r.stdout + r.stderr);
    assert.ok(/тег:\s*v9\.9\.9/.test(r.stdout), "тег взят не из сборки: " + r.stdout);
    assert.ok(!new RegExp("v" + PKG.version.replace(/\./g, "\\.") + "\\b").test(r.stdout),
      "тег взят из package.json, а не из latest.yml");
  });

  await test("в релиз идут ровно три файла: установщик, latest.yml и blockmap", () => {
    const d = fakeDist("9.9.9");
    const r = run(["--dry-run", "--dist", d.dir]);
    // Смотрим именно СПИСОК файлов, а не текст вокруг: имя latest.yml встречается
    // и в пояснении к тегу, поэтому поиск подстроки по всему выводу слишком слаб.
    const bullets = r.stdout
      .split("\n")
      .filter((l) => /^\s+• /.test(l))
      .map((l) => l.replace(/^\s+• /, "").replace(/\s+\(.*$/, "").trim());
    assert.deepStrictEqual(
      bullets,
      [d.exe, "latest.yml", d.exe + ".blockmap"],
      "в релиз идут не те файлы: " + JSON.stringify(bullets)
    );
    assert.ok(/тип:\s+release/.test(r.stdout), "не сказано, что релиз не черновик");
  });

  await test("испорченный latest.yml и отсутствие установщика объясняются", () => {
    const broken = fakeDist("9.9.9", { versionLine: "", installer: false });
    const r1 = run(["--dry-run", "--dist", broken.dir]);
    assert.notStrictEqual(r1.status, 0, "испорченный latest.yml принят за сборку");
    assert.ok(/не разобрать version/.test(r1.stdout + r1.stderr), "нет объяснения про версию: " + r1.stdout);
    const noExe = fakeDist("9.9.9", { installer: false });
    const r2 = run(["--dry-run", "--dist", noExe.dir]);
    assert.notStrictEqual(r2.status, 0, "сборка без установщика принята за готовую");
    assert.ok(/нет установщика/.test(r2.stdout + r2.stderr), "нет объяснения про установщик: " + r2.stdout);
  });

  await test("занятый тег не даёт выложить поверх прошлого релиза", () => {
    // v1.0.1 — единственный реально существующий тег. Если сети нет, проверка
    // честно пропускается: скрипт предупреждает, что теги спросить не удалось.
    const d = fakeDist("1.0.1");
    const r = run(["--dry-run", "--dist", d.dir]);
    if (/не удалось спросить теги/.test(r.stdout)) {
      console.log("    (пропущено: теги origin недоступны)");
      return;
    }
    assert.notStrictEqual(r.status, 0, "занятый тег не остановил выкладку");
    assert.ok(/уже занят/.test(r.stdout + r.stderr), "нет объяснения про занятый тег: " + r.stdout);
    assert.ok(
      new RegExp("gh release delete v1\\.0\\.1").test(r.stdout + r.stderr),
      "не подсказано, как удалить неудачный релиз: " + r.stdout + r.stderr
    );
  });

  await test("текст релиза уходит файлом, а не аргументом", () => {
    const d = fakeDist("9.9.9");
    const r = run(["--dry-run", "--dist", d.dir]);
    assert.ok(/Текст релиза:/.test(r.stdout), "человеку не показан текст релиза");
    assert.ok(/--notes-file/.test(r.stdout), "текст релиза не уходит файлом: в оболочке Windows многострочный аргумент ломается");
    assert.ok(!/--notes "/.test(r.stdout), "текст релиза всё ещё передаётся аргументом");
  });

  await test("текст релиза из файла: есть — берётся, нет — сказано прямо", () => {
    const d = fakeDist("9.9.9");
    const notes = path.join(d.dir, "notes.md");
    fs.writeFileSync(notes, "# Что нового\n\n- правка раундов миссии\n");
    const r1 = run(["--dry-run", "--dist", d.dir, "--notes-file", notes]);
    assert.strictEqual(r1.status, 0, "свои заметки не принялись: " + r1.stdout + r1.stderr);
    assert.ok(/правка раундов миссии/.test(r1.stdout), "текст из файла не попал в релиз");
    const r2 = run(["--dry-run", "--dist", d.dir, "--notes-file", path.join(d.dir, "нет-такого.md")]);
    assert.notStrictEqual(r2.status, 0, "отсутствующий файл заметок принят молча");
    assert.ok(/нет файла заметок/.test(r2.stdout + r2.stderr), "нет объяснения про файл заметок");
  });

  await test("выкладка без терминала не выполняется молча", () => {
    // Без --yes и без терминала скрипт обязан ОТКАЗАТЬСЯ, а не выложить наугад.
    const d = fakeDist("9.9.9");
    const r = spawnSync(process.execPath, [SCRIPT, "--dist", d.dir], {
      cwd: ROOT,
      encoding: "utf8",
      input: "",
      timeout: 60000,
    });
    assert.ok(/Нет терминала|Отменено/.test(r.stdout + r.stderr), "не сказано, что выкладка не сделана: " + r.stdout);
    assert.ok(/--yes/.test(r.stdout + r.stderr), "не подсказано, как подтвердить выкладку");
    // Прямая проверка безопасности: после запуска БЕЗ подтверждения релиза быть
    // не должно. gh может быть не установлен — тогда проверка честно пропускается.
    const slug = /^\s*owner:\s*(\S+)/m.exec(CFG)[1] + "/" + /^\s*repo:\s*(\S+)/m.exec(CFG)[1];
    const gh = spawnSync("gh", ["release", "view", "v9.9.9", "--repo", slug], { encoding: "utf8" });
    if (gh.error) console.log("    (пропущено: gh недоступен)");
    else assert.notStrictEqual(gh.status, 0, "без подтверждения релиз всё-таки выложился!");
  });

  await test("в скрипте прямо сказано про черновик и prerelease, и откуда берётся репозиторий", () => {
    assert.ok(/releaseType !== "release"/.test(SCRIPT_SRC), "не проверяется тип релиза из electron-builder.yml");
    assert.ok(/не черновик/.test(SCRIPT_SRC), "нет предупреждения про черновик/prerelease");
    assert.ok(/electron-updater/.test(SCRIPT_SRC), "не сказано, кому именно нужен этот релиз");
    assert.ok(/из electron-builder.yml/.test(SCRIPT_SRC),
      "не сказано, откуда берётся репозиторий (origin может указывать на старое имя)");
  });

  await test("временный файл с текстом релиза убирается, а не остаётся в проекте", () => {
    assert.ok(/os\.tmpdir\(\)/.test(SCRIPT_SRC), "текст релиза пишется не во временную папку");
    assert.ok(/process\.on\("exit", cleanNotes\)/.test(SCRIPT_SRC), "временный файл не убирается при любом исходе");
  });

  await test("в package.json выкладка есть одной командой, а сборка не выкладывает", () => {
    assert.strictEqual(PKG.scripts["release:win"], "node scripts/publish-release.js", "нет команды release:win");
    assert.ok(/--publish never/.test(PKG.scripts["dist:win"] || ""),
      "сборка снова пытается выкладывать сама — выкладка должна идти отдельной командой");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

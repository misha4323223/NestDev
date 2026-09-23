"use strict";
/* ─── Выкладка релиза на GitHub: одна команда вместо набора файлов руками ─────
   Запуск: npm run release:win            (node scripts/publish-release.js)
           node scripts/publish-release.js --dry-run        только показать план
           node scripts/publish-release.js --yes            без вопроса «выкладывать?»
           node scripts/publish-release.js --notes-file RELEASE-NOTES.md
           node scripts/publish-release.js --dist <папка>    другая папка сборки

   Зачем. Канал автообновления у установленных копий — это релиз на GitHub с
   файлами latest.yml и установщиком (electron-updater, releaseType: release).
   Сборка (`npm run dist:win`) выкладывать не умеет: она с `--publish never`.
   Поэтому выкладка делается здесь — и делает за человека ровно то, на чём легко
   ошибиться:

     • версию берёт ИЗ dist/latest.yml, а не из package.json: у выложенного релиза
       и тега версия обязана совпадать с той, что внутри собранного установщика;
     • требует latest.yml в релизе — без него обновление не найдётся вообще;
     • не даёт выложить поверх занятого тега (человек теряет старый релиз молча);
     • пишет релиз НЕ черновиком и не prerelease: их electron-updater не видит;
     • берёт owner/repo из electron-builder.yml, а не из origin: репозиторий
       переименовывали, и origin может указывать на старое имя (редирект).

   Требуется установленный gh и вход в него (`gh auth status`). Токен нигде не
   хранит и не читает — работает через твой же gh. */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? String(args[i + 1]).trim() : "";
};

const DRY = hasFlag("--dry-run");
const YES = hasFlag("--yes");
const DIST = path.resolve(ROOT, flagValue("--dist") || "dist");
const NOTES_FILE = flagValue("--notes-file");

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(
    [
      "Выкладка релиза на GitHub (канал автообновления).",
      "",
      "  npm run release:win                       выложить релиз из dist/",
      "  node scripts/publish-release.js --dry-run  только показать, что будет сделано",
      "  node scripts/publish-release.js --yes      без вопроса подтверждения",
      "  --notes-file <файл>   текст релиза из файла",
      "  --dist <папка>        другая папка сборки (по умолчанию dist)",
      "",
      "Перед выкладкой установщик должен быть собран: npm run dist:win",
    ].join("\n")
  );
  process.exit(0);
}

const fail = (msg) => {
  console.error("✗ " + msg);
  process.exit(1);
};
const warn = (msg) => console.warn("⚠ " + msg);

/* ── 1. Что выкладывать: версия и установщик берутся из самой сборки ───────── */
function readLatest(dir) {
  const file = path.join(dir, "latest.yml");
  if (!fs.existsSync(file)) {
    fail("нет файла " + file + "\n  Сначала собери установщик: npm run dist:win");
  }
  const text = fs.readFileSync(file, "utf8");
  const unquote = (s) => String(s || "").trim().replace(/^["']|["']$/g, "");
  const version = unquote((text.match(/^version:\s*(.+)$/m) || [])[1]);
  // Имя установщика electron-builder пишет в path (и первым в files[].url).
  let installer = unquote((text.match(/^path:\s*(.+)$/m) || [])[1]);
  if (!installer) installer = unquote((text.match(/^\s*-\s*url:\s*(.+)$/m) || [])[1]);
  return { file, version, installer };
}

/* ── 2. Куда выкладывать: правда о репозитории лежит в electron-builder.yml ── */
function publishTarget() {
  const cfg = path.join(ROOT, "electron-builder.yml");
  if (!fs.existsSync(cfg)) fail("нет " + cfg);
  const text = fs.readFileSync(cfg, "utf8");
  const owner = (text.match(/^\s*owner:\s*(\S+)/m) || [])[1] || "";
  const repo = (text.match(/^\s*repo:\s*(\S+)/m) || [])[1] || "";
  const releaseType = (text.match(/^\s*releaseType:\s*(\S+)/m) || [])[1] || "release";
  if (!owner || !repo) fail("в electron-builder.yml не найдены owner/repo для GitHub-канала");
  return { owner, repo, releaseType, slug: owner + "/" + repo };
}

const run = (cmd, argv) => spawnSync(cmd, argv, { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });

const latest = readLatest(DIST);
if (!/^\d+\.\d+\.\d+/.test(latest.version)) {
  fail("в " + latest.file + " не разобрать version (получилось «" + latest.version + "»)\n  Похоже, сборка неполная или latest.yml испорчен");
}
if (!latest.installer) fail("в " + latest.file + " не указан установщик (path / files.url)");

const installerPath = path.join(DIST, latest.installer);
if (!fs.existsSync(installerPath)) {
  fail("нет установщика " + installerPath + "\n  latest.yml говорит «" + latest.installer + "» — проверь, что сборка закончилась полностью");
}
const blockmapName = latest.installer + ".blockmap";
const blockmapPath = path.join(DIST, blockmapName);
const hasBlockmap = fs.existsSync(blockmapPath);

const target = publishTarget();
if (target.releaseType !== "release") {
  warn("в electron-builder.yml releaseType: " + target.releaseType + " — не «release».\n  Черновик и prerelease electron-updater у установленных копий НЕ видит.");
}

const tag = "v" + latest.version;

/* ── 3. Занят ли тег/релиз: молча перезаписать чужой релиз нельзя ──────────── */
function tagTaken() {
  const r = run("git", ["ls-remote", "--tags", "origin", "refs/tags/" + tag]);
  if (r.error || r.status !== 0) {
    warn("не удалось спросить теги у origin (" + (r.stderr || r.error || "").toString().trim().split("\n")[0] + ") — продолжаю без этой проверки");
    return false;
  }
  return String(r.stdout || "").trim().length > 0;
}
function releaseExists() {
  const r = run("gh", ["release", "view", tag, "--repo", target.slug]);
  if (r.error) fail("не найден gh. Установи GitHub CLI и войди: gh auth login\n  Либо выложи релиз через веб: https://github.com/" + target.slug + "/releases/new");
  if (r.status === 0) return true;
  return false;
}

const ghCheck = run("gh", ["auth", "status"]);
if (!DRY && ghCheck.error) {
  fail("не найден gh. Установи GitHub CLI и войди: gh auth login\n  Либо выложи релиз через веб: https://github.com/" + target.slug + "/releases/new");
}

const taken = tagTaken();
const exists = DRY ? false : releaseExists();
if (taken || exists) {
  fail(
    "тег " + tag + " уже занят" + (exists ? " (и релиз существует)" : "") + ".\n" +
      "  Если это тот же неудачный релиз — удали его: gh release delete " + tag + " --repo " + target.slug + " --cleanup-tag\n" +
      "  Если это прошлая версия — сверь версию в dist/latest.yml: выкладывается именно она"
  );
}

const assets = [installerPath, latest.file].concat(hasBlockmap ? [blockmapPath] : []);
if (!hasBlockmap) warn("нет " + blockmapName + " — обновление будет качаться целиком, а не по частям (не критично)");

const notesText = NOTES_FILE
  ? (() => {
      const p = path.resolve(ROOT, NOTES_FILE);
      if (!fs.existsSync(p)) fail("нет файла заметок " + p);
      return fs.readFileSync(p, "utf8");
    })()
  : "Сборка " + latest.version + ".\n\nОбновление у установленных копий придёт по GitHub-каналу (проверка раз в час). Что вошло в версию — см. AGENT-NOTES.md.";

// Текст релиза уходит ФАЙЛОМ, а не аргументом: многострочный текст с кавычками
// и амперсандами ломается при передаче через оболочку Windows (в ней скрипт
// и запускается). Файл временный и удаляется в конце.
const notesPath = path.join(os.tmpdir(), "ai-agent-release-notes-" + process.pid + ".md");
fs.writeFileSync(notesPath, notesText, "utf8");
const cleanNotes = () => {
  try {
    fs.unlinkSync(notesPath);
  } catch {}
};
process.on("exit", cleanNotes);

const argv = [
  "release", "create", tag,
  "--repo", target.slug,
  "--target", "main",
  "--title", "NestDev " + latest.version,
  "--notes-file", notesPath,
].concat(assets);

/* ── 4. План на экран: человек видит ровно то, что уйдёт в GitHub ─────────── */
console.log("Релиз для канала автообновления");
console.log("  репозиторий: " + target.slug + "  (из electron-builder.yml)");
console.log("  тег:         " + tag + "  (версия взята из dist/latest.yml)");
console.log("  тип:         release (не черновик, не prerelease — иначе обновление не найдётся)");
console.log("  файлы:");
for (const a of assets) {
  const kb = (fs.statSync(a).size / 1024).toFixed(0);
  console.log("    • " + path.basename(a) + "  (" + kb + " КБ)");
}
console.log("\nТекст релиза:");
console.log(notesText.split("\n").map((l) => "  | " + l).join("\n"));
console.log("\nКоманда (текст релиза уходит файлом, поэтому её можно повторить руками):");
console.log("  gh " + argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" "));

if (DRY) {
  console.log("\n✓ Проверки пройдены. Ничего не выложено (--dry-run).");
  if (target.releaseType !== "release") process.exitCode = 1;
  process.exit();
}

const confirm = () =>
  new Promise((resolve) => {
    if (YES) return resolve(true);
    if (!process.stdin.isTTY) {
      console.log("\n✗ Нет терминала для вопроса. Повтори с --yes, если план верный.");
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nВыложить релиз " + tag + " в " + target.slug + "? (да/нет) ", (a) => {
      rl.close();
      resolve(/^\s*(да|д|y|yes)\s*$/i.test(a));
    });
  });

confirm().then((ok) => {
  if (!ok) {
    console.log("Отменено: ничего не выложено.");
    process.exit(0);
  }
  console.log("\nВыкладываю…");
  const r = spawnSync("gh", argv, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    fail("gh release create вернул ошибку. Релиз не выложен (или выложен частично — проверь: gh release view " + tag + " --repo " + target.slug + ")");
  }
  console.log("\n✓ Релиз " + tag + " выложен: https://github.com/" + target.slug + "/releases/tag/" + tag);
  console.log("  Установленные копии увидят обновление в течение часа (или сразу после перезапуска).");
  console.log("  Проверить ассеты: gh release view " + tag + " --repo " + target.slug);
});

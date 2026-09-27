#!/usr/bin/env node
"use strict";

/*
 * restore.js — возврат Playwright в проект (фолбэк удаления).
 *
 * ВАЖНО: каталог backup-playwright/ ЛЕЖИТ В РЕПОЗИТОРИИ (в .gitignore его нет).
 * Он версионируется вместе с кодом, поэтому restore.js больше НЕ перезаписывает
 * файлы снимками «как есть» — иначе он затирал бы все изменения package.json,
 * накопившиеся после удаления playwright. Вместо этого он ДОБАВЛЯЕТ недостающее:
 *
 *   1) package.json        — вставляет "playwright": "<версия>" в "dependencies"
 *      (версия берётся из снимка package.json.bak, остальное остаётся как есть);
 *   2) electron-builder.yml — возвращает из снимка ТОЛЬКО если в нём пропали
 *      исключения asarUnpack для playwright (обычно они на месте — шаг пропускается);
 *   3) package-lock.json + node_modules — ставит пакет: `npm install --ignore-scripts`
 *      (лок пересобирается сам, снимок лока для этого не нужен).
 *
 * Запуск (из корня проекта):
 *   node backup-playwright/restore.js             # всё: файлы + установка
 *   node backup-playwright/restore.js --no-install # только файлы, без npm install
 *   node backup-playwright/restore.js --dry-run    # показать план, ничего не менять
 *
 * Полное описание — backup-playwright/README.md.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const here = __dirname;                       // .../backup-playwright
const root = path.resolve(here, "..");        // корень проекта

const argv = process.argv.slice(2);
const doInstall = !argv.includes("--no-install");
const dryRun = argv.includes("--dry-run");

if (argv.includes("--help") || argv.includes("-h")) {
  console.log("node backup-playwright/restore.js [--no-install] [--dry-run]");
  console.log("  --no-install  только файлы, установку пропустить");
  console.log("  --dry-run     показать план, ничего не менять");
  process.exit(0);
}

const PKG = path.join(root, "package.json");
const BUILDER = path.join(root, "electron-builder.yml");
const PKG_BAK = path.join(here, "package.json.bak");
const BUILDER_BAK = path.join(here, "electron-builder.yml.bak");

const FALLBACK_VERSION = "^1.49.1";                 // если снимок не читается
const ASAR_MARK = "node_modules/playwright/**";     // признак, что конфиг уже готов

const changes = [];   // { file, abs, text, note }
const skips = [];

function log(msg) { process.stdout.write(msg + "\n"); }

// Версия playwright — из снимка (единый источник правды), с запасным значением.
function snapshotVersion() {
  try {
    const bak = JSON.parse(fs.readFileSync(PKG_BAK, "utf8"));
    const v = bak && bak.dependencies && bak.dependencies.playwright;
    if (typeof v === "string" && v) return v;
  } catch (_) { /* снимка нет или он битый — берём запасное значение */ }
  return FALLBACK_VERSION;
}

// 1) package.json — ДОБАВЛЯЕМ строку зависимости, не трогая остальное.
(function planPackageJson() {
  if (!fs.existsSync(PKG)) return skips.push("нет package.json — пропускаю");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
  } catch (e) {
    return skips.push("package.json не разбирается (" + e.message + ") — пропускаю");
  }
  if (pkg.dependencies && pkg.dependencies.playwright) {
    return skips.push('playwright уже в dependencies — не трогаю package.json');
  }
  const version = snapshotVersion();
  const next = Object.assign({}, pkg, {
    dependencies: Object.assign({}, pkg.dependencies || {}, { playwright: version }),
  });
  changes.push({
    file: "package.json",
    abs: PKG,
    text: JSON.stringify(next, null, 2) + "\n",
    note: 'добавлю "playwright": "' + version + '" в dependencies',
  });
})();

// 2) electron-builder.yml — возврат из снимка ТОЛЬКО если пропал asarUnpack.
(function planBuilder() {
  if (!fs.existsSync(BUILDER)) return skips.push("нет electron-builder.yml — пропускаю");
  const raw = fs.readFileSync(BUILDER, "utf8");
  if (raw.includes(ASAR_MARK)) {
    return skips.push("electron-builder.yml уже распаковывает playwright — не трогаю");
  }
  if (!fs.existsSync(BUILDER_BAK)) {
    return skips.push("нет снимка electron-builder.yml.bak — пропускаю");
  }
  changes.push({
    file: "electron-builder.yml",
    abs: BUILDER,
    text: fs.readFileSync(BUILDER_BAK, "utf8"),
    note: "верну из снимка (пропали исключения asarUnpack для playwright)",
  });
})();

log("Playwright — фолбэк-восстановление" + (dryRun ? "  [--dry-run]" : ""));
log("Корень проекта: " + root);
log("");

if (changes.length) {
  log(dryRun ? "План изменений файлов:" : "Изменяю файлы:");
  for (const c of changes) {
    if (dryRun) {
      log("  ·  " + c.file + " — " + c.note + " (не пишу)");
    } else {
      fs.writeFileSync(c.abs, c.text);
      log("  ✓  " + c.file + " — " + c.note);
    }
  }
} else {
  log("Файлы уже в порядке — менять нечего.");
}
for (const s of skips) log("  ⚠  " + s);

log("");

// 3) Установка пакета: лок и node_modules пересобирает сам npm.
if (!doInstall) {
  log("Установка пропущена (--no-install). Когда понадобится:");
  log("  npm install --ignore-scripts");
} else if (dryRun) {
  log("Установка: npm install --ignore-scripts (не запускаю, --dry-run)");
} else {
  log("Ставлю пакет playwright (npm install --ignore-scripts)…");
  try {
    execFileSync("npm", ["install", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
    log("  ✓  playwright в node_modules и в package-lock.json");
  } catch (err) {
    log("  ⚠  npm install не удался (вероятно, нет сети).");
    log("     Файлы уже готовы — повторите установку позже:");
    log("       npm install --ignore-scripts");
  }
}

log("");
log("Готово. Проверка: grep -n playwright package.json");

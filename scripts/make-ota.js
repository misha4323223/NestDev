"use strict";
// Сборка локального OTA-бандла (self-update агента).
// Использование: node scripts/make-ota.js [--out <папка>] [--version x.y.z]
//                [--key <закрытый ключ>] [--unsigned]
// По умолчанию пишет в ota/ рядом с репозиторием: manifest.json + bundle.json.
// Приложение проверяет эту папку при старте и каждые 60 секунд и применяет обновление.
//
// Набор ПОДПИСЫВАЕТСЯ ключом из ~/.ai-agent-ota-key.pem (или --key / OTA_SIGN_KEY_FILE /
// OTA_SIGN_KEY). Без ключа сборка останавливается: набор без подписи приложение примет
// только пока в src/ota-trust.js нет ни одного доверенного ключа, а молча выпустить
// неподписанный набор — это тихо понизить защиту. Для осознанного случая есть --unsigned.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const otaSign = require(path.join(__dirname, "..", "src", "ota-sign.js"));

const ROOT = path.join(__dirname, "..");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, "ota");
})();
const VER_ARG = (() => {
  const i = process.argv.indexOf("--version");
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]).trim() : "";
})();
const UNSIGNED = process.argv.includes("--unsigned");
const DEFAULT_KEY = path.join(os.homedir(), ".ai-agent-ota-key.pem");

// Где взять закрытый ключ: аргумент → переменная окружения → ключ по умолчанию.
// Сам ключ в репозиторий не попадает: он лежит у владельца (см. scripts/make-ota-key.js).
function signingKey() {
  if (process.env.OTA_SIGN_KEY) return { pem: process.env.OTA_SIGN_KEY, from: "OTA_SIGN_KEY" };
  const i = process.argv.indexOf("--key");
  const file = (i >= 0 && process.argv[i + 1]) || process.env.OTA_SIGN_KEY_FILE || DEFAULT_KEY;
  if (fs.existsSync(file)) return { pem: fs.readFileSync(file, "utf8"), from: file };
  return null;
}

// Зеркалит список файлов electron-builder (files: src/**, assets/**, package.json, server.js)
const INCLUDED = ["src", "assets", "package.json", "server.js"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "ota", "bin"]);
const SKIP_PREFIXES = [".tmp-"];

function collectFiles() {
  const files = {};
  const walk = (dir, base) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
      const abs = path.join(dir, name);
      const rel = path.join(base, name).split(path.sep).join("/");
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else files[rel] = abs;
    }
  };
  for (const item of INCLUDED) {
    const abs = path.join(ROOT, item);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs, item);
    else files[item] = abs;
  }
  return files;
}

function syntaxCheckAll(files) {
  let checked = 0;
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith(".js")) continue;
    const r = spawnSync(process.execPath, ["--check", files[rel]], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error("✗ Синтаксическая ошибка в " + rel + ":\n" + (r.stderr || r.stdout || "").slice(0, 1200));
      process.exit(1);
    }
    checked++;
  }
  return checked;
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function bumpPatch(v) {
  const m = String(v || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "0.0.1";
  return m[1] + "." + m[2] + "." + (parseInt(m[3], 10) + 1);
}

function versionGt(a, b) {
  const A = String(a || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  const B = String(b || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!A || !B) return false;
  for (let i = 1; i <= 3; i++) {
    const x = parseInt(A[i], 10);
    const y = parseInt(B[i], 10);
    if (x !== y) return x > y;
  }
  return false;
}

function main() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    pkg = { version: "1.0.0" };
  }
  const files = collectFiles();
  if (!files["src/main.js"] || !files["src/bootstrap.js"]) {
    console.error("✗ В бандле должны быть src/main.js и src/bootstrap.js");
    process.exit(1);
  }

  console.log("Проверка синтаксиса изменённых файлов…");
  const checked = syntaxCheckAll(files);

  const prev = readManifest(OUT);
  let version = VER_ARG || pkg.version || "1.0.0";
  if (!VER_ARG && prev) {
    // Гарантия: без --version новая версия ВСЕГДА строго выше предыдущего манифеста.
    // Раньше при pkg.version (1.0.0) ≠ prev.version (например 1.0.21) бандл собирался
    // с версией 1.0.0 — приложение видело версию ниже установленной и молча
    // игнорировало обновление (findCandidate требует versionGt).
    version = bumpPatch(versionGt(prev.version, version) ? prev.version : version);
  }

  const filesB64 = {};
  let bytes = 0;
  for (const rel of Object.keys(files)) {
    const buf = fs.readFileSync(files[rel]);
    filesB64[rel] = buf.toString("base64");
    bytes += buf.length;
  }

  const bundleJson = JSON.stringify({ version, files: filesB64 });

  // Подпись: считается по тем же байтам, что и sha256 (строка bundle.json).
  const key = signingKey();
  if (UNSIGNED && key) {
    console.error("✗ Указаны сразу --unsigned и ключ: так нельзя — набор либо подписан, либо нет.");
    process.exit(1);
  }
  if (!key && !UNSIGNED) {
    console.error(
      "✗ Нет ключа подписи — набор не собран.\n" +
        "  Создайте ключ один раз:  npm run ota:key\n" +
        "  Или укажите свой:        npm run ota:bundle -- --key <файл>\n" +
        "  Осознанно без подписи:   node scripts/make-ota.js --unsigned\n" +
        "  (набор без подписи приложение примет, только пока в src/ota-trust.js нет доверенных ключей)"
    );
    process.exit(1);
  }
  let sig = "";
  let keyId = "";
  if (key) {
    try {
      sig = otaSign.signBundle(bundleJson, key.pem);
      const pub = crypto.createPublicKey(key.pem);
      keyId = otaSign.keyId(pub.export({ type: "spki", format: "pem" }).toString());
    } catch (e) {
      console.error("✗ Ключ не подошёл для подписи (" + key.from + "): " + ((e && e.message) || e));
      process.exit(1);
    }
  }

  const manifest = {
    app: "ai-agent",
    version,
    // Версия КОДА внутри набора — из package.json репозитория. Номер набора и версия
    // кода живут своим счётом (набор 1.5.132 собран из кода 1.5.121), и приложение
    // судит, перекрывать ли свежий код старым бандлом, именно по этой строке.
    codeVersion: pkg.version || "1.0.0",
    builtAt: Date.now(),
    files: Object.keys(filesB64).length,
    sha256: crypto.createHash("sha256").update(bundleJson).digest("hex"),
    // Подпись набора и отпечаток открытого ключа, которым она сделана.
    // "" — набор собран с --unsigned и приложение примет его только без доверенных ключей.
    sig: sig,
    keyId: keyId,
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "bundle.json"), bundleJson, "utf8");
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log("✓ OTA-бандл собран: " + OUT);
  console.log("  версия: " + version + (VER_ARG ? " (задана --version)" : prev ? " (авто-бамп патча)" : ""));
  console.log("  файлов: " + Object.keys(filesB64).length + " (JS проверено: " + checked + ")");
  if (key) {
    const trusted = otaSign.trustedKeys().some((k) => k.id === keyId);
    console.log("  подпись: есть, ключ " + otaSign.shortId(keyId) + (trusted ? " (доверенный)" : ""));
    if (!trusted) {
      console.log(
        "  ⚠ этот ключ НЕ в списке доверенных (src/ota-trust.js): приложение отклонит набор. " +
          "Добавьте его: npm run ota:key -- --trust"
      );
    }
  } else {
    console.log("  подпись: НЕТ (--unsigned) — приложение примет набор только пока нет доверенных ключей");
  }
  console.log("  размер: " + (bytes / 1024).toFixed(1) + " КБ (base64: " + (bundleJson.length / 1024).toFixed(1) + " КБ)");
}

main();
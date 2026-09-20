"use strict";
/* ─── Ключ подписи OTA-наборов ────────────────────────────────────────────────
   Использование:
     npm run ota:key                  создать ключ (~/.ai-agent-ota-key.pem) и напечатать открытую часть
     npm run ota:key -- --trust       то же плюс внести открытую часть в src/ota-trust.js
     npm run ota:key -- --key <файл>  свой путь для закрытого ключа
     npm run ota:key -- --force       пересоздать, даже если ключ уже есть

   Расклад такой: закрытый ключ лежит ТОЛЬКО у вас (в домашней папке, права 600) и
   в репозиторий не попадает никогда. Открытая часть (её отпечаток — 16 hex) едет
   в src/ota-trust.js, и по ней приложение понимает, что набор собран вами.
   Подписывает набор scripts/make-ota.js, проверяет src/ota-sign.js.

   Сменить ключ без простоя: сначала сделать новый и добавить его --trust (в списке
   станут два ключа), выпустить набор, подписанный новым, и только потом убрать
   старый из src/ota-trust.js. Иначе уже выпущенный набор никто не примет.

   Ключ Ed25519: подпись короткая (64 байта), проверка быстрая, а crypto умеет его
   без сторонних библиотек. */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const otaSign = require(path.join(ROOT, "src", "ota-sign.js"));

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
};
const KEY_PATH = path.resolve(argValue("--key") || path.join(os.homedir(), ".ai-agent-ota-key.pem"));
const TRUST = process.argv.includes("--trust");
const FORCE = process.argv.includes("--force");
// Файл доверенных ключей: обычно src/ota-trust.js. Переменная окружения нужна
// проверкам (test/ota-sign.test.js вносит ключ в копию, а не в настоящий файл).
const TRUST_FILE = path.resolve(process.env.AI_AGENT_OTA_TRUST_FILE || path.join(ROOT, "src", "ota-trust.js"));

function publicPem(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
}

// Содержимое списка доверенных ключей. Ключи пишем шаблонными строками: внутри
// строки видны настоящие переводы строк, поэтому файл читается глазами и любым
// внешним поиском ("PRIVATE" там не появится — только открытые части).
function trustBlock(pems) {
  const body = pems.map((p) => "`" + String(p).replace(/\n+$/, "\n") + "`").join(",\n");
  return "module.exports = { OTA_TRUSTED_KEYS: [\n" + body + ",\n] };\n";
}

// Вписать открытый ключ в src/ota-trust.js, не потеряв уже доверенные.
function trustKey(pubPem) {
  let src;
  try {
    src = fs.readFileSync(TRUST_FILE, "utf8");
  } catch (e) {
    throw new Error("Не читается " + TRUST_FILE + ": " + ((e && e.message) || e));
  }
  const have = otaSign.parseKeys(src);
  const id = otaSign.keyId(pubPem);
  if (have.some((p) => otaSign.keyId(p) === id)) return { added: false, total: have.length, id: id };
  const next = have.concat(pubPem.trim() + "\n");
  const line = trustBlock(next);
  if (!/module\.exports\s*=\s*\{\s*OTA_TRUSTED_KEYS:[\s\S]*?\};/.test(src)) {
    throw new Error(
      "В src/ota-trust.js не нашлась строка экспорта OTA_TRUSTED_KEYS — впишите открытый ключ вручную"
    );
  }
  fs.writeFileSync(TRUST_FILE, src.replace(/module\.exports\s*=\s*\{\s*OTA_TRUSTED_KEYS:[\s\S]*?\};/, line), "utf8");
  return { added: true, total: next.length, id: id };
}

(function main() {
  let keyPem = "";
  let created = false;
  if (fs.existsSync(KEY_PATH) && !FORCE) {
    keyPem = fs.readFileSync(KEY_PATH, "utf8");
    console.log("Ключ уже есть: " + KEY_PATH + " (пересоздать — с флагом --force)");
  } else {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, keyPem, { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(KEY_PATH, 0o600);
    } catch {}
    created = true;
    console.log("✓ Ключ создан: " + KEY_PATH + " (только для владельца, в репозиторий не попадает)");
  }

  const pub = publicPem(keyPem);
  const id = otaSign.keyId(pub);
  console.log("  отпечаток: " + otaSign.shortId(id));
  if (created) {
    console.log("\nОткрытая часть (её и надо доверить приложению):\n" + pub.trim());
  }

  if (TRUST) {
    const r = trustKey(pub);
    console.log(
      r.added
        ? "✓ Открытый ключ внесён в src/ota-trust.js (доверенных ключей: " + r.total + ")"
        : "• Этот ключ уже в src/ota-trust.js (доверенных ключей: " + r.total + ")"
    );
    console.log("  Теперь приложение принимает только наборы, подписанные этим ключом.");
  } else {
    console.log(
      "\nЧтобы приложение доверяло подписи, внесите открытую часть в src/ota-trust.js:\n" +
        "  npm run ota:key -- --trust\n" +
        "Пока ключей там нет, наборы принимаются без подписи (панель обновления об этом предупреждает)."
    );
  }
  console.log("\nСборка подписанного набора: node scripts/make-ota.js --version <версия>");
})();

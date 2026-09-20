"use strict";
/* ─── Подпись OTA-набора: проверка перед распаковкой ──────────────────────────
   Набор кода исполняется в приложении. Порядок проверок в src/ota.js теперь такой:

     1. sha256 манифеста — набор не побился при копировании;
     2. подпись набора открытым ключом из src/ota-trust.js — набор положил тот,
        кому вы доверяете;
     3. только после этого — распаковка, проверка синтаксиса и своп папок.

   Почему одного sha256 мало. Манифест и набор лежат в одной папке; злоумышленник,
   который может положить в неё файл (сетевая папка, общий диск, чужой ноутбук),
   кладёт СВОЙ bundle.json и СВОЙ manifest.json с его хешем — и проверка сходится.
   Подпись это ломает: закрытый ключ есть только у владельца.

   Подпись считается по ТЕМ ЖЕ байтам, что и sha256 (строка bundle.json как она
   записана на диск), и лежит в манифесте полем sig; в keyId — отпечаток открытого
   ключа, чтобы человек видел, каким ключом подписан набор. Схема — Ed25519
   (ключ короче и проверка быстрее), но принимается любой ключ, который умеет
   crypto.verify: по алгоритму ключа.

   Переменные окружения (нужны живым прогонам и сборке, в обычной жизни не нужны):
     • AI_AGENT_OTA_TRUST — путь к файлу с открытыми ключами или сам PEM (через \n);
     • AI_AGENT_OTA_ALLOW_UNSIGNED=1 — принимать наборы без подписи, даже когда ключи
       уже есть. Это ослабление защиты; для разработки, а не для боевого применения.

   Проверки: test/ota-sign.test.js и test/smoke.test.js (applyBundle с подписью). */

const crypto = require("crypto");
const fs = require("fs");

const KEY_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g;

// Отпечаток открытого ключа: короткий и одинаковый у всех, кто видит ключ.
// Именно он попадает в манифест (keyId) и в подсказки человеку.
function keyId(publicKeyPem) {
  const key = crypto.createPublicKey(normalize(publicKeyPem));
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

function normalize(pem) {
  const s = String(pem || "").trim();
  return s ? s + "\n" : s;
}

// Разбор нескольких ключей из одной строки: так их удобно передавать переменной
// окружения и хранить в файле-списке.
function parseKeys(text) {
  const found = String(text || "").match(KEY_BLOCK) || [];
  return found.map(normalize);
}

function readEnvKeys() {
  const raw = String(process.env.AI_AGENT_OTA_TRUST || "").trim();
  if (!raw) return null;
  // Путь к файлу со списком ключей — если такой файл есть.
  try {
    if (raw.indexOf("-----BEGIN") < 0 && fs.existsSync(raw)) {
      return parseKeys(fs.readFileSync(raw, "utf8"));
    }
  } catch {}
  return parseKeys(raw);
}

// Доверенные ключи: переменная окружения (тесты, живые прогоны, нестандартный
// стенд) важнее встроенного списка. Ключи читаются в момент проверки — файл
// можно дополнить, не перезапуская приложение.
function trustedKeys() {
  const fromEnv = readEnvKeys();
  if (fromEnv && fromEnv.length) {
    return fromEnv.map((pem) => ({ pem: pem, id: keyId(pem), source: "env" }));
  }
  let list = [];
  try {
    list = require("./ota-trust.js").OTA_TRUSTED_KEYS || [];
  } catch {
    list = [];
  }
  return list
    .map((pem) => parseKeys(pem)[0])
    .filter(Boolean)
    .map((pem) => ({ pem: pem, id: keyId(pem), source: "trust-file" }));
}

// Разрешено ли принимать наборы без подписи. Да — только пока нет ни одного
// доверенного ключа (иначе приложение осталось бы без обновлений вовсе) или если
// разработчик явно попросил переменной окружения.
function unsignedAllowed() {
  if (String(process.env.AI_AGENT_OTA_ALLOW_UNSIGNED || "") === "1") return true;
  return trustedKeys().length === 0;
}

// Подписать строку набора закрытым ключом (используется сборкой набора).
function signBundle(bundleJson, privateKeyPem) {
  const sig = crypto.sign(null, Buffer.from(String(bundleJson), "utf8"), privateKeyPem);
  return sig.toString("base64");
}

function verifySignature(bundleJson, sigBase64, publicKeyPem) {
  try {
    return crypto.verify(
      null,
      Buffer.from(String(bundleJson), "utf8"),
      normalize(publicKeyPem),
      Buffer.from(String(sigBase64), "base64")
    );
  } catch {
    return false;
  }
}

// Короткая подпись сертификата для человека: 16 hex → «a1b2c3d4e5f60718»
function shortId(id) {
  return String(id || "").slice(0, 16);
}

// Главная проверка набора. Возвращает { signed, keyId } и БРОСАЕТ ошибку с
// объяснением, если набор принимать нельзя.
function checkBundle(bundleJson, manifest) {
  const keys = trustedKeys();
  const sig = manifest && manifest.sig ? String(manifest.sig) : "";
  const id = manifest && manifest.keyId ? String(manifest.keyId) : "";

  if (!sig) {
    if (!unsignedAllowed()) {
      throw new Error(
        "Набор не подписан — обновление отклонено. Подпишите набор своим ключом: " +
          "npm run ota:key (один раз) и node scripts/make-ota.js --version <версия>. " +
          "Ключей в доверенных: " + keys.length + "."
      );
    }
    return { signed: false, keyId: "", trusted: false };
  }

  const byId = id ? keys.filter((k) => k.id === id) : keys;
  if (!byId.length) {
    if (!keys.length) {
      // Ключи есть в манифесте, но доверенных ключей нет вовсе: доверять нечему.
      throw new Error(
        "Набор подписан ключом " + shortId(id) + ", но доверенных ключей в приложении нет — " +
          "обновление отклонено. Добавьте открытый ключ: npm run ota:key -- --trust."
      );
    }
    throw new Error(
      "Набор подписан неизвестным ключом " + shortId(id) + " — обновление отклонено. " +
        "Доверенные ключи: " + keys.map((k) => shortId(k.id)).join(", ") + ". " +
        "Если набор собран вами на другом ПК — перенесите туда ~/.ai-agent-ota-key.pem " +
        "или добавьте его открытую часть в src/ota-trust.js."
    );
  }

  const good = byId.find((k) => verifySignature(bundleJson, sig, k.pem));
  if (!good) {
    throw new Error(
      "Подпись набора не сходится (ключ " + shortId(id || byId[0].id) + ") — " +
        "файл изменён после сборки, обновление отклонено."
    );
  }
  return { signed: true, keyId: good.id, trusted: true };
}

// Что показать человеку про состояние подписи (идёт в статус OTA и в панель).
function trustStatus() {
  const keys = trustedKeys();
  if (!keys.length) {
    return {
      keys: 0,
      ids: [],
      source: "",
      warning:
        "Подпись набора не настроена: комплекты кода принимаются без проверки подписи. Создайте ключ — npm run ota:key -- --trust",
    };
  }
  return {
    keys: keys.length,
    ids: keys.map((k) => shortId(k.id)),
    source: keys[0].source,
    warning: "",
  };
}

module.exports = {
  keyId,
  parseKeys,
  trustedKeys,
  unsignedAllowed,
  signBundle,
  verifySignature,
  checkBundle,
  trustStatus,
  shortId,
};

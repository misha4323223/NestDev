"use strict";

/* ── Сервисный аккаунт Yandex Cloud: ключ → IAM-токен ───────────────────────
   Зачем. Почти весь Yandex Cloud принимает OAuth-токен пользователя, но Cloud
   Postbox — SES-совместимый API — устроен иначе: каталог он берёт ИЗ САМОГО
   СЕРВИСНОГО АККАУНТА, а в заголовке X-YaCloud-SubjectToken ждёт IAM-токен
   именно этого аккаунта (пользовательский токен получает 403 — проверено на
   живом облаке, объяснение живёт в src/yandex-cloud.js). Ключ сервисного
   аккаунта (JSON из консоли) подписывает JWT, облако меняет его на IAM-токен:
   ровно так же устроен доступ к Google Sheets (src/google-sheets.js), поэтому в
   поставку OTA ничего добавлять не нужно — только node:crypto и fetch.

   Что здесь. Разбор ключа, подпись JWT (PS256 — этого требует Yandex),
   обмен JWT на IAM-токен и кэш токена до истечения. Сети в тестах нет: адрес
   обмена уважает тот же хук AI_AGENT_YC_BASE, что и остальное облако
   (подменённый стенд отвечает на /iam/v1/tokens), а fetch и часы можно
   подставить аргументом.

   Модуль не знает ни про настройки, ни про окно: он получает уже разобранный
   ключ. Кто и откуда его читает — дело канала (src/yc-ipc.js) и инструмента. */

const crypto = require("crypto");

// Точка обмена JWT на IAM-токен (её же требует claim aud).
const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
// Подпись PS256: RSASSA-PSS + SHA-256, соль длиной 32 байта (длина хэша).
const SALT_LEN = 32;

// Кэш токенов: отпечаток ключа → { token, expMs }.
const tokenCache = new Map();

// Стенд подменяет всё облако одним адресом (AI_AGENT_YC_BASE) — обмен токена
// тоже уходит туда: у подмены есть /iam/v1/tokens. Так же читает базу
// src/yandex-cloud.js, чтобы у обоих модулей был один хук.
function testApiBase() {
  return String(process.env.AI_AGENT_YC_BASE || "").trim().replace(/\/+$/, "");
}

function tokenUrl() {
  const base = testApiBase();
  return base ? base + "/iam/v1/tokens" : IAM_TOKEN_URL;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Ключ сервисного аккаунта: JSON из консоли («Создать новый ключ» → «Создать
// JSON»). Нужны service_account_id (iss будущего JWT), private_key (PEM) и,
// если есть, id ключа. Принимает и строку, и уже разобранный объект.
// Не подходит — null: канал обязан сказать про настройку, а не падать.
function parseServiceAccount(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const saId = String(obj.service_account_id || obj.serviceAccountId || "").trim();
  const keyId = String(obj.id || obj.key_id || obj.keyId || "").trim();
  const privateKey = String(obj.private_key || obj.privateKey || "").trim();
  if (!/^aje[a-z0-9]+$/i.test(saId)) return null;
  if (!privateKey || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return null;
  return { serviceAccountId: saId, keyId: keyId, privateKey: privateKey };
}

function keyFingerprint(key) {
  return crypto.createHash("sha1").update(key.serviceAccountId + "\n" + (key.keyId || "") + "\n" + key.privateKey).digest("hex");
}

// JWT для обмена: iss — сервисный аккаунт, aud — точка обмена, срок — час.
// Время выпуска на минуту назад: небольшие расхождения часов иначе дают
// «Token must be in the future».
function buildJwt(key, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 3600;
  const header = { alg: "PS256", typ: "JWT" };
  const claims = { iss: key.serviceAccountId, aud: IAM_TOKEN_URL, iat: iat, exp: exp };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  const sig = crypto.sign("sha256", Buffer.from(input), {
    key: key.privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: SALT_LEN,
  });
  return input + "." + b64url(sig);
}

// IAM-токен сервисного аккаунта: из кэша или обменом JWT.
// opts: { fetchImpl, now, force } — сеть и часы подставляются в тестах.
async function getIamToken(key, opts) {
  const o = opts || {};
  const now = o.now ? o.now() : Date.now();
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("нет fetch (нужен Node 18+/Electron)");
  const fp = keyFingerprint(key);
  const hit = tokenCache.get(fp);
  if (!o.force && hit && hit.expMs - 60000 > now) return hit.token;
  const jwt = buildJwt(key, now);
  const res = await fetchImpl(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ jwt: jwt }),
  });
  const text = await res.text().catch(() => "");
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok || !data.iamToken) {
    const why = (data && (data.message || data.error)) || "HTTP " + res.status;
    throw new Error("Yandex Cloud не выдал IAM-токен сервисного аккаунта: " + String(why).slice(0, 200));
  }
  const expMs = Date.parse(data.expiresAt || "") || now + 3600e3;
  tokenCache.set(fp, { token: data.iamToken, expMs: expMs });
  return data.iamToken;
}

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  parseServiceAccount,
  keyFingerprint,
  buildJwt,
  getIamToken,
  clearTokenCache,
  tokenUrl,
  IAM_TOKEN_URL,
  SALT_LEN,
};

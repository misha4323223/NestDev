"use strict";

/* ── Google Sheets через service account (без библиотек) ──────────────────────
   Зачем service account, а не «войти как человек». Логин/пароль Google нельзя
   обменять на API-токен (у потребительских аккаунтов нет password-grant), а
   OAuth-экран согласия в настольном приложении — это свой Cloud-проект, редирект
   и refresh-токен. Service account снимает всё это: человек вставляет JSON-ключ
   (в Настройках→Таблицы, хранится зашифрованно), мы подписываем JWT сами и
   получаем токен. Нужны только `crypto` и `fetch` — оба есть и в Node, и в
   Electron, поэтому в поставку OTA ничего добавлять не надо.

   Браузерный путь (вход в таблицу живой сессией и vaultFill) остаётся ЗАПАСНЫМ и
   живёт не здесь, а в инструменте: без ключа инструмент честно говорит модели
   «открой браузером» — так «гибрид» и устроен.

   Здесь только чистая логика: парсинг ключа, подпись, HTTP. Токен кэшируется до
   истечения (Google выдаёт на час), повторов и молчаливых фолбэков нет — отказ
   возвращается текстом, чтобы агент увидел причину.

   fetch и часы передаются параметром — модуль тестируется в plain-node без сети. */

const crypto = require("crypto");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
// spreadsheets — чтение/запись листов; drive.file — создать/открыть свою книгу.
const SCOPE = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";

// Кэш токенов: ключ (по client_email + отпечатку ключа) → { token, expMs }.
const tokenCache = new Map();

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Разобрать JSON-ключ service account. Принимает строку или объект.
// Возвращает нормализованный ключ или null (с человеческой причиной в err).
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
  const email = String(obj.client_email || "").trim();
  const key = String(obj.private_key || "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/i.test(email)) return null;
  if (!key || !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) return null;
  return { client_email: email, private_key: key, project_id: String(obj.project_id || ""), client_id: String(obj.client_id || "") };
}

function keyFingerprint(key) {
  return crypto.createHash("sha1").update(key.client_email + "\n" + key.private_key).digest("hex");
}

// JWT с подписью RS256: header.claims подписываются приватным ключом сервисного
// аккаунта. Помещаем время выпуска на минуту назад — иначе редкие расхождения
// часов дают «Invalid JWT: Token must be in the future».
function buildJwt(key, nowMs) {
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 3600;
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp };
  const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(input), key.private_key);
  return input + "." + b64url(sig);
}

// Токен доступа: из кэша или обменом JWT. opts: { fetchImpl, now }
async function getAccessToken(key, opts) {
  const o = opts || {};
  const now = o.now ? o.now() : Date.now();
  const fetchImpl = o.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("нет fetch (нужен Node 18+/Electron)");
  const fp = keyFingerprint(key);
  const hit = tokenCache.get(fp);
  if (hit && hit.expMs - 60000 > now) return hit.token;
  const jwt = buildJwt(key, now);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok || !data.access_token) {
    // error у Google бывает и строкой, и объектом { code, message, status } —
    // иначе в тексте ошибки человек увидел бы «[object Object]».
    const why = data.error_description || (data.error && data.error.message) || data.error || ("HTTP " + res.status);
    throw new Error("Google не выдал токен: " + String(why).slice(0, 200));
  }
  const expMs = now + (parseInt(data.expires_in, 10) || 3600) * 1000;
  tokenCache.set(fp, { token: data.access_token, expMs });
  return data.access_token;
}

function clearTokenCache() {
  tokenCache.clear();
}

// id таблицы из ссылки или голого id. Ссылка: .../spreadsheets/d/<id>/edit...
function sheetIdFromArg(arg) {
  const s = String(arg == null ? "" : arg).trim();
  if (!s) return "";
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return "";
}

// Общий вызов Sheets API. opts: { token, method, path, query, body, fetchImpl }
async function apiCall(opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let url = API_BASE + opts.path;
  if (opts.query) {
    const qs = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
      .join("&");
    if (qs) url += "?" + qs;
  }
  const res = await fetchImpl(url, {
    method: opts.method || "GET",
    headers: {
      Authorization: "Bearer " + opts.token,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) {
    const msg = (data.error && data.error.message) || ("HTTP " + res.status);
    const err = new Error(String(msg).slice(0, 300));
    err.status = res.status;
    throw err;
  }
  return data;
}

// Высокоуровневые операции. key — разобранный service account.
async function readValues(opts) {
  const token = await getAccessToken(opts.key, opts);
  const data = await apiCall({
    token,
    method: "GET",
    path: "/" + opts.id + "/values/" + encodeURIComponent(opts.range || "A1"),
    query: { majorDimension: opts.majorDimension || "ROWS" },
    fetchImpl: opts.fetchImpl,
  });
  return { range: data.range || opts.range || "A1", values: Array.isArray(data.values) ? data.values : [] };
}

async function updateValues(opts) {
  const token = await getAccessToken(opts.key, opts);
  const data = await apiCall({
    token,
    method: "PUT",
    path: "/" + opts.id + "/values/" + encodeURIComponent(opts.range || "A1"),
    query: { valueInputOption: opts.valueInputOption || "USER_ENTERED" },
    body: { values: opts.values || [] },
    fetchImpl: opts.fetchImpl,
  });
  return { updatedRange: data.updatedRange || "", updatedRows: data.updatedRows || 0, updatedCells: data.updatedCells || 0 };
}

async function appendValues(opts) {
  const token = await getAccessToken(opts.key, opts);
  const data = await apiCall({
    token,
    method: "POST",
    path: "/" + opts.id + "/values/" + encodeURIComponent(opts.range || "A1") + ":append",
    query: { valueInputOption: opts.valueInputOption || "USER_ENTERED", insertDataOption: "INSERT_ROWS" },
    body: { values: opts.values || [] },
    fetchImpl: opts.fetchImpl,
  });
  return { updatedRange: (data.updates && data.updates.updatedRange) || "", updatedRows: (data.updates && data.updates.updatedRows) || 0 };
}

async function spreadsheetInfo(opts) {
  const token = await getAccessToken(opts.key, opts);
  const data = await apiCall({ token, method: "GET", path: "/" + opts.id, fetchImpl: opts.fetchImpl });
  const sheets = Array.isArray(data.sheets)
    ? data.sheets.map((s) => ({
        title: (s.properties && s.properties.title) || "",
        sheetId: (s.properties && s.properties.sheetId) || 0,
        rows: (s.properties && s.properties.gridProperties && s.properties.gridProperties.rowCount) || 0,
        cols: (s.properties && s.properties.gridProperties && s.properties.gridProperties.columnCount) || 0,
      }))
    : [];
  return { title: data.properties ? data.properties.title || "" : "", spreadsheetId: data.spreadsheetId || opts.id, sheets };
}

async function createSpreadsheet(opts) {
  const token = await getAccessToken(opts.key, opts);
  const body = { properties: { title: String(opts.title || "Таблица") } };
  const data = await apiCall({ token, method: "POST", path: "", body, fetchImpl: opts.fetchImpl });
  return { spreadsheetId: data.spreadsheetId || "", title: (data.properties && data.properties.title) || "", url: data.spreadsheetUrl || "" };
}

module.exports = {
  parseServiceAccount,
  buildJwt,
  getAccessToken,
  clearTokenCache,
  sheetIdFromArg,
  readValues,
  updateValues,
  appendValues,
  spreadsheetInfo,
  createSpreadsheet,
  TOKEN_URL,
  API_BASE,
  SCOPE,
};

"use strict";

/* ── Cloud Postbox (адреса) — проверки и слова, БЕЗ сети ─────────────────────
   Почему модуль. Postbox на полке был только СЧЁТЧИКОМ адресов: ни создать
   адрес, ни посмотреть его подпись, ни удалить — всё это жило только в консоли
   облака. Между тем без адреса письма отправлять нечем, а без подтверждения
   домена и подписи DKIM письма уезжают в спам. Появились канал, инструмент
   агента и окно — значит, проверки и человеческие слова должны жить здесь, а не
   расползаться по трём файлам.

   Что здесь. Разбор адреса (это ДОМЕН, а не ящик: Postbox шлёт «с домена»),
   перевод статусов проверки и подписи на русский, строка адреса для списка,
   карточка адреса с записями DNS для подтверждения владения, поиск адреса по
   имени. Сами запросы Postbox живут в src/yandex-cloud.js
   (listEmailIdentities/getEmailIdentity/createEmailIdentity/deleteEmailIdentity/
   setEmailDkimSigning) — дублировать их нельзя: у окна и агента один код.
   Токен сервисного аккаунта берётся в src/yc-sa.js.

   Честность про DKIM: SES-совместимый API отдаёт ТОЛЬКО селекторы (Tokens). Имя
   CNAME-записи из них выводится (<селектор>._domainkey.<адрес>), а ЗНАЧЕНИЕ
   записи (целевой хост) облако не отдаёт — оно показано на странице адреса в
   консоли. Врать «вставь dkim.postbox…» мы не будем: скажем как есть.

   Модуль чистый: ни Electron, ни окон, ни сети. Проверяется в обычном Node. */

// Адрес Postbox — домен (можно любого уровня), не ящик: строчная латиница, цифры,
// дефис и точки; метка не начинается и не заканчивается дефисом.
const ADDRESS_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$/;

function checkAddress(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) throw new Error("Укажи адрес: домен, с которого шлём письма (например mail.example.ru).");
  if (s.indexOf("@") >= 0) {
    throw new Error(
      "«" + s + "» — это ящик, а Postbox заводит ДОМЕН, с которого шлют письма. Подойдёт, например, «example.ru» или «mail.example.ru»."
    );
  }
  if (s.length > 253 || !ADDRESS_RE.test(s)) {
    throw new Error(
      "Адрес «" + s + "» не подойдёт: нужен домен из строчных латинских букв, цифр, дефиса и точек, где метка не начинается и не заканчивается дефисом (например mail.example.ru)."
    );
  }
  return s;
}

// Статус проверки владения доменом — словами: человеку PENDING ничего не говорит.
const VERIFY_RU = {
  PENDING: "проверяется",
  SUCCESS: "подтверждён",
  FAILED: "не подтверждён",
  TEMPORARY_FAILURE: "временная ошибка проверки",
  NOT_STARTED: "проверка не начата",
};

// Статус подписи DKIM: облако ищет записи в DNS домена.
const DKIM_RU = {
  PENDING: "ищется в DNS",
  SUCCESS: "найдена в DNS",
  FAILED: "не найдена в DNS",
  TEMPORARY_FAILURE: "временная ошибка проверки DNS",
  NOT_STARTED: "проверка не начата",
};

function statusHuman(status) {
  const s = String(status || "").toUpperCase();
  return VERIFY_RU[s] || (s ? s.toLowerCase() : "неизвестно");
}

function dkimHuman(status) {
  const s = String(status || "").toUpperCase();
  return DKIM_RU[s] || (s ? s.toLowerCase() : "неизвестно");
}

// Как заведена подпись: облако сгенерировало ключи (Easy DKIM) или пользователь
// принёс свой (BYODKIM).
const ORIGIN_RU = {
  AWS_SES: "простая (ключи создаёт облако)",
  EXTERNAL: "свой ключ (BYODKIM)",
};

function keyLengthHuman(v) {
  const s = String(v || "").toUpperCase();
  if (s === "RSA_2048_BIT") return "2048 бит";
  if (s === "RSA_1024_BIT") return "1024 бит";
  return "";
}

// Подпись адреса: включена ли, что в DNS и какими селекторами она задана.
function dkimInfo(attrs) {
  const x = attrs || {};
  const tokens = Array.isArray(x.Tokens) ? x.Tokens.filter(Boolean) : Array.isArray(x.tokens) ? x.tokens.filter(Boolean) : [];
  const status = x.Status || x.status || "";
  const origin = x.SigningAttributesOrigin || x.signingAttributesOrigin || "";
  return {
    present: !!(attrs && (Object.keys(attrs).length || tokens.length)),
    enabled: x.SigningEnabled === true || x.signingEnabled === true,
    status: status,
    statusHuman: dkimHuman(status),
    origin: origin,
    originHuman: ORIGIN_RU[origin] || "",
    tokens: tokens,
    nextKeyHuman: keyLengthHuman(x.NextSigningKeyLength || x.nextSigningKeyLength),
    currentKeyHuman: keyLengthHuman(x.CurrentSigningKeyLength || x.currentSigningKeyLength),
  };
}

// Адрес так, как его видно: имя (домен), статус проверки, можно ли слать и что с
// DKIM. Имена полей — как у SES (IdentityName, VerificationStatus…), потому что
// облако отвечает именно ими; терпим и «человеческие» name/status.
function identityInfo(it) {
  const x = it || {};
  const name = String(x.IdentityName || x.identityName || x.name || x.id || "").trim();
  const status = x.VerificationStatus || x.verificationStatus || "";
  const sending = x.SendingEnabled === true || x.sendingEnabled === true || x.VerifiedForSendingStatus === true;
  return {
    name: name,
    identityType: x.IdentityType || x.identityType || "",
    status: status,
    statusHuman: statusHuman(status),
    sendingEnabled: sending,
    dkim: dkimInfo(x.DkimAttributes || x.dkimAttributes),
  };
}

function dkimWord(info) {
  const d = info && info.dkim ? info.dkim : null;
  if (!d || !d.present) return "подписи нет";
  return (d.enabled ? "включена" : "выключена") + " · запись в DNS: " + d.statusHuman;
}

// Строка для списка адресов — одной строкой, как остальные ресурсы каталога.
function identityLine(it) {
  const x = identityInfo(it);
  return "• " + (x.name || "—") + " — " + x.statusHuman + (x.sendingEnabled ? " · письма разрешены" : " · письма пока нельзя") + " · DKIM: " + dkimWord(x);
}

// Имя CNAME-записи выводится из селектора и адреса: <селектор>._domainkey.<адрес>.
// Значение записи (целевой хост) API не отдаёт — об этом и говорим, а не выдумываем.
function dnsRecordLines(address, dkim) {
  const d = dkim || {};
  const tokens = Array.isArray(d.tokens) ? d.tokens : [];
  if (!d.present || !tokens.length) return [];
  const lines = ["Записи для подтверждения владения доменом (DNS):"];
  for (const t of tokens) lines.push("  CNAME " + t + "._domainkey." + address + " — значение (целевой хост) облако показывает в разделе «Настройка подписи писем (DKIM)» на странице адреса");
  if (tokens.length > 1) lines.push("  Обе CNAME-записи обязательны: они нужны и для автоматической смены ключей DKIM.");
  return lines;
}

// Карточка адреса: то, что человек ищет глазами в консоли.
function cardLines(full) {
  const x = identityInfo(full);
  const src = full || {};
  const out = [
    "Адрес «" + (x.name || "—") + "»" + (x.identityType ? " · тип: " + String(x.identityType).toLowerCase() : ""),
    "Проверка владения доменом: " + x.statusHuman,
    "Письма: " + (x.sendingEnabled ? "разрешены" : "пока нельзя — домен не подтверждён"),
  ];
  const fb = src.FeedbackForwardingStatus === true || src.feedbackForwardingStatus === true;
  out.push("Оповещения о доставке: " + (fb ? "включены" : "выключены"));
  const d = x.dkim;
  if (d.present) {
    out.push("Подпись DKIM: " + (d.enabled ? "включена" : "выключена") + " · запись в DNS: " + d.statusHuman + (d.originHuman ? " · настройка: " + d.originHuman : "") + (d.currentKeyHuman ? ", ключ " + d.currentKeyHuman : ""));
    if (d.tokens.length) out.push("Селекторы: " + d.tokens.join(", "));
  } else {
    out.push("Подпись DKIM: данных нет — их не отдали.");
  }
  const tags = Array.isArray(src.Tags) ? src.Tags : [];
  if (tags.length) out.push("Метки: " + tags.map((t) => (t && t.Key ? t.Key + "=" + (t.Value || "") : "")).filter(Boolean).join(", "));
  if (src.ConfigurationSetName) out.push("Набор конфигурации: " + src.ConfigurationSetName);
  const recs = dnsRecordLines(x.name, d);
  if (recs.length) out.push("", ...recs);
  return out;
}

// Поиск адреса по имени (домену) — как везде: сначала точное имя, потом id.
function matchIdentity(list, ref) {
  const arr = Array.isArray(list) ? list : [];
  const q = String(ref == null ? "" : ref).trim().toLowerCase();
  const nameOf = (it) => String((it && (it.name || it.IdentityName || it.id)) || "").toLowerCase();
  if (!q) return arr.length === 1 ? arr[0] : null;
  return arr.find((it) => nameOf(it) === q) || arr.find((it) => String((it && it.id) || "").toLowerCase() === q) || null;
}

module.exports = {
  ADDRESS_RE,
  VERIFY_RU,
  DKIM_RU,
  ORIGIN_RU,
  checkAddress,
  statusHuman,
  dkimHuman,
  dkimInfo,
  identityInfo,
  identityLine,
  dnsRecordLines,
  cardLines,
  matchIdentity,
};

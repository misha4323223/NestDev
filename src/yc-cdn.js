"use strict";

/* ── HTTPS-сайт на своём домене: сертификат и Cloud CDN ─────────────────────
   Зачем модуль. Бакет с сайтом приложение умело создать и наполнить, домен —
   завести в Cloud DNS. Но открыть это по HTTPS было нечем: сертификат и
   CDN-ресурс делались только в консоли облака. Между тем именно ради этого
   всё и затевается — «свой сайт по https://мой-домен», без «небезопасно» в
   браузере и без чужого хостинга. В задаче участвуют ДВА сервиса: Certificate
   Manager выпускает сертификат (бесплатно), Cloud CDN его носит и раздаёт
   файлы из бакета (платно).

   Модуль чистый: ни Electron, ни окна, ни настроек. Зависимости приходят
   аргументами (та же конвенция, что у createYcVpc и createYcFunctions): тот же
   IAM-токен, каталог эндпоинтов, разбор сетевых отказов и ожидание операции,
   что у остальных запросов облака. Поэтому он проверяется в plain-node.

   Что важно знать про API и не потерять при правке:

     • ДОМЕНЫ СЕРТИФИКАТА ИЗМЕНИТЬ НЕЛЬЗЯ. В Update есть только имя, описание,
       метки и защита от удаления. «Добавить домен» — это НОВЫЙ сертификат,
       и говорить надо именно так, а не «сейчас допишу»;
     • содержимое (сертификат, цепочка, ключ) можно менять ТОЛЬКО у загруженного
       сертификата (IMPORTED): у выпущенного облаком он продлевается сам, и
       подсунуть туда чужой PEM — ошибка;
     • wildcard (*.example.com) НЕЛЬЗЯ подтвердить файлом на сайте: HTTP-проверка
       для него не работает вовсе — только DNS. Проверяем это до запроса;
     • запись подтверждения — РОВНО ОДНА (CNAME или TXT). Если добавить обе, у
       кеширующих серверов начинаются конфликты. CNAME делегирует проверку
       облаку: подтверждается один раз и продления проходят сами. С TXT проверку
       придётся обновлять каждые 60 дней — поэтому по умолчанию советуем CNAME;
     • у CNAME-записи проверки значение — «<id сертификата>.cm.yandexcloud.net.»;
       имя — «_acme-challenge.<домен>», и никаких других записей на этом имени
       быть не должно;
     • сертификат и CDN-ресурс обязаны лежать в ОДНОМ каталоге — из другого
       каталога облако отказывает невнятно, поэтому это проверяется словами;
     • cname ресурса CDN ПОСЛЕ СОЗДАНИЯ НЕ МЕНЯЕТСЯ: поля cname в Update нет
       вовсе — основное доменное имя задаётся один раз и навсегда;
     • у бакета-источника обязательно своё значение заголовка Host
       (<бакет>.website.yandexcloud.net), иначе бакет-сайт не отвечает
       CDN-серверам: это и есть та самая «страница 404 по адресу CDN»;
     • группа источников обновляется запросом БЕЗ id в пути
       (PATCH /cdn/v1/originGroups, id — в теле), а новое имя поля называется
       groupName. С id в пути сервис отвечает 404 — на этом легко потерять день;
     • список источников в группе заменяется ЦЕЛИКОМ: «добавить источник» =
       прочитать, собрать новый список, записать (как правила у сети);
     • очистка кэша: ПУСТОЙ список путей означает «очистить всё», за один запрос
       можно не больше 10 путей, а запросов — один в минуту. Звёздочка работает
       только В КОНЦЕ пути: «/img/*» чистит папку, а звёздочка в середине — нет,
       причём молча;
     • изменения в CDN применяются до 15 минут, создание ресурса — тоже;
     • цена: ресурс CDN — 150 ₽/месяц за каждый ресурс пакетом (в пакет входит
       150 ГБ исходящего трафика и 100 млн запросов), дальше 1,054 ₽ за ГБ и 1 ₽
       за 100 тыс. запросов. Деньги уходят даже при нулевом трафике, поэтому
       создание требует явного подтверждения. Сертификаты бесплатны.

   Ничего не пишется и не удаляется по своей инициативе: функции делают ровно
   то, о чём их попросили, и возвращают данные. Права проверяет вызывающий. */

// Фолбэк адреса: обычно его отдаёт каталог эндпоинтов облака, но сертификат
// нужно уметь выпустить и тогда, когда каталог недоступен (как в KNOWN_ENDPOINTS).
const CERT_FALLBACK = "https://certificatemanager.api.cloud.yandex.net";
const CDN_FALLBACK = "https://cdn.api.cloud.yandex.net";

// Тарифы Cloud CDN (Россия, с НДС, по документации на сентябрь 2026). Те же
// числа живут в src/yc-costs.js — править вместе, чтобы оценка не разошлась с
// тем, что модуль говорит при подтверждении.
const CDN_RESOURCE_MONTH = 150;
const CDN_INCLUDED_GB = 150;
const CDN_INCLUDED_REQUESTS = 100000000;
const CDN_EGRESS_PER_GB = 1.054;
const CDN_PER_100K_REQUESTS = 1;
// Ограничения очистки кэша: не больше 10 путей за запрос и один запрос в минуту.
const CDN_MAX_PURGE_PATHS = 10;
const CDN_PURGE_PER_MINUTE = 1;

// ── Проверки ввода ──────────────────────────────────────────────────────────
// Имя в Yandex Cloud: строчные латинские буквы, цифры и дефис, до 63 символов.
// Сертификат «Мой-Сайт» облако не примет, а отвечает оно невнятно.
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function checkName(name) {
  const nm = String(name == null ? "" : name).trim();
  if (!nm) throw new Error("Укажи имя: строчные латинские буквы, цифры и дефис (например site-cert).");
  if (NAME_RE.test(nm)) return nm;
  const lower = nm.toLowerCase();
  if (NAME_RE.test(lower)) {
    throw new Error("Имя «" + nm + "» не подойдёт: облако принимает только строчные латинские буквы, цифры и дефис. Возьми «" + lower + "».");
  }
  throw new Error(
    "Имя «" + nm + "» не подойдёт: нужно до 63 символов, только строчные латинские буквы, цифры и дефис, " +
      "начинается с буквы и не заканчивается дефисом."
  );
}

function checkFolder(folderId) {
  const f = String(folderId || "").trim();
  if (!f) throw new Error("Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.");
  return f;
}

// ── Домены ──────────────────────────────────────────────────────────────────
// Домены приходят от человека и агента в любом виде: «https://сайт.ру/», «CDN.
// Example.com.», «example.com:443». Облако принимает только строчное имя без
// схемы, порта, пути и точки на конце — приводим сами, а не отказываем.
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_HINT = "cdn.example.com";
const MAX_DOMAINS = 100;

function normalizeDomain(v) {
  let s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // https://
  s = s.split("/")[0].split("?")[0].split("#")[0]; // путь, запрос, якорь
  s = s.replace(/:\d+$/, ""); // порт
  s = s.replace(/\.+$/, ""); // точка на конце (FQDN)
  return s;
}

function isWildcard(d) {
  return String(d || "").indexOf("*.") === 0;
}

// Домен в том виде, в каком его ждёт API. Маска «*.example.com» — допустима.
function checkDomain(v, what) {
  const label = what || "Домен";
  const d = normalizeDomain(v);
  if (!d) throw new Error(label + ": укажи домен, например " + DOMAIN_HINT + " (без https://, без пути и без порта).");
  if (d.indexOf("*") >= 0 && !isWildcard(d)) {
    throw new Error(label + ": звёздочка допустима только в начале и только как маска на все поддомены: «*.example.com». В «" + String(v) + "» она стоит не там.");
  }
  const body = isWildcard(d) ? d.slice(2) : d;
  if (!body) throw new Error(label + ": за звёздочкой нужен домен, например *.example.com.");
  if (d.length > 253) throw new Error(label + ": имя длиннее 253 символов — так не бывает.");
  const parts = body.split(".");
  if (parts.length < 2) {
    throw new Error(label + ": «" + body + "» — не полное доменное имя. Нужен домен второго уровня (example.com) или глубже (" + DOMAIN_HINT + ").");
  }
  for (const p of parts) {
    if (!DOMAIN_LABEL_RE.test(p)) {
      throw new Error(label + ": в «" + body + "» часть «" + p + "» не годится — в домене допустимы латинские буквы, цифры и дефис (дефис не в начале и не в конце).");
    }
  }
  return isWildcard(d) ? "*." + body : body;
}

function checkDomains(v, what) {
  const raw = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
  const out = [];
  for (const x of raw) {
    const d = checkDomain(x, what);
    if (out.indexOf(d) < 0) out.push(d);
  }
  if (!out.length) throw new Error((what || "Домены") + ": не указан ни один домен. Для сайта это, например, " + DOMAIN_HINT + ".");
  if (out.length > MAX_DOMAINS) throw new Error((what || "Домены") + ": больше " + MAX_DOMAINS + " доменов в один сертификат не помещается.");
  return out;
}

// Тип проверки прав на домен. Wildcard файлом подтвердить нельзя — это правило
// Let's Encrypt, а не наша придирка, поэтому отбиваем до запроса.
function challengeFor(domains, want) {
  const list = Array.isArray(domains) ? domains : [domains];
  const w = String(want == null ? "" : want).trim().toUpperCase();
  if (w && w !== "DNS" && w !== "HTTP") {
    throw new Error("Тип проверки «" + want + "» не понял. Доступно: DNS (запись в зоне — годится и для маски) или HTTP (файл на сайте).");
  }
  const type = w || "DNS";
  if (type === "HTTP" && list.some(isWildcard)) {
    throw new Error(
      "Маску (*.example.com) нельзя подтвердить файлом на сайте: HTTP-проверка для wildcard-сертификатов не работает вовсе. Возьми DNS — " +
        "имя «" + DNS_CHALLENGE_PREFIX + "example.com», CNAME на <id сертификата>" + CERT_CNAME_SUFFIX
    );
  }
  return type;
}

// ── Состояния сертификата ───────────────────────────────────────────────────
const CERT_STATUS = {
  VALIDATING: "ждёт подтверждения домена — сертификат ещё НЕ выпущен",
  INVALID: "не выпустился: домен не подтвердили за неделю — нужен НОВЫЙ запрос",
  ISSUED: "выпущен и работает",
  REVOKED: "отозван — браузеры его не примут",
  RENEWING: "продлевается облаком",
  RENEWAL_FAILED: "продление сорвалось",
};

const CHALLENGE_STATUS = {
  PENDING: "ждёт: облако ещё не видит записи",
  PROCESSING: "облако ждёт подтверждения от Let's Encrypt",
  VALID: "подтверждён",
  INVALID: "проверка не прошла",
};

function humanFrom(status, map, fallback) {
  const k = String(status == null ? "" : status).trim().toUpperCase();
  if (map[k]) return map[k];
  return fallback || ("состояние «" + String(status || "?") + "» незнакомо — смотри консоль");
}

function statusHuman(status) {
  return humanFrom(status, CERT_STATUS);
}

function challengeStatusHuman(s) {
  return humanFrom(s, CHALLENGE_STATUS);
}

// MANAGED — сертификат выпустило облако (Let's Encrypt) и продлевает сам;
// IMPORTED — загрузили файлом и продлевать придётся самому. Разница стоит денег
// и простоя, поэтому она всегда называется словами.
function typeHuman(type) {
  const t = String(type == null ? "" : type).trim().toUpperCase();
  if (t === "MANAGED") return "выпущен облаком (Let's Encrypt) — продлевается сам";
  if (t === "IMPORTED") return "загружен вручную — продлевать придётся самому";
  return "тип «" + (type || "?") + "»";
}

const DNS_CHALLENGE_PREFIX = "_acme-challenge.";
const CERT_CNAME_SUFFIX = ".cm.yandexcloud.net.";

// Значение CNAME-записи проверки. Облако отдаёт его в самом ответе, но у только
// что запрошенного сертификата записи может не быть — тогда собираем по
// документированному шаблону, чтобы человек не остался без адреса.
function dnsChallengeValue(certRaw) {
  const c = certRaw || {};
  const ch = (Array.isArray(c.challenges) ? c.challenges : []).find((x) => x && x.dnsChallenge);
  const given = ch && ch.dnsChallenge ? String(ch.dnsChallenge.value || "") : "";
  if (given) return given;
  return c.id ? String(c.id) + CERT_CNAME_SUFFIX : "";
}

function daysSince(iso, nowMs) {
  const t = Date.parse(String(iso || ""));
  if (!t) return null;
  return Math.floor(((nowMs || Date.now()) - t) / 86400000);
}

function daysLeft(iso, nowMs) {
  const t = Date.parse(String(iso || ""));
  if (!t) return null;
  return Math.floor((t - (nowMs || Date.now())) / 86400000);
}

function humanDaysLeft(n) {
  if (n == null) return "срок не указан";
  if (n < 0) return "срок истёк " + Math.abs(n) + " дн. назад";
  if (n === 0) return "истекает сегодня";
  if (n === 1) return "остался 1 день";
  return "осталось " + n + " дн.";
}

function humanAge(days) {
  if (days == null) return "возраст неизвестен";
  if (days <= 0) return "создан сегодня";
  if (days === 1) return "1 день";
  if (days < 30) return days + " дн.";
  const m = Math.round(days / 30);
  return m + " мес.";
}

// ── Проверка прав на домен ──────────────────────────────────────────────────
// Одна проверка = одна запись. Значения полей берём из ответа облака; если оно
// их не дало (только что созданный сертификат), подставляем документированные.
function challengeInfo(c, certId) {
  const ch = c || {};
  const domain = String(ch.domain || "").trim();
  const type = String(ch.type || "").trim().toUpperCase();
  const status = String(ch.status || "").trim().toUpperCase();
  const dns = ch.dnsChallenge || null;
  const http = ch.httpChallenge || null;
  const out = {
    domain: domain,
    type: type || (dns ? "DNS" : http ? "HTTP" : ""),
    status: status,
    statusHuman: challengeStatusHuman(status),
    message: String(ch.message || ""),
    error: String(ch.error || ""),
    done: status === "VALID",
    dns: null,
    http: null,
  };
  if (dns || out.type === "DNS") {
    const d = dns || {};
    out.dns = {
      name: String(d.name || (domain ? DNS_CHALLENGE_PREFIX + domain : "")),
      type: String(d.type || "CNAME").toUpperCase(),
      value: String(d.value || (certId ? String(certId) + CERT_CNAME_SUFFIX : "")),
    };
  }
  if (http) {
    out.http = { url: String(http.url || ""), content: String(http.content || "") };
  }
  return out;
}

function certInfo(certRaw) {
  const c = certRaw || {};
  const domains = Array.isArray(c.domains) ? c.domains.map(String) : [];
  const channels = (Array.isArray(c.challenges) ? c.challenges : []).map((x) => challengeInfo(x, c.id));
  const status = String(c.status || "").trim().toUpperCase();
  const type = String(c.type || "").trim().toUpperCase();
  const left = daysLeft(c.notAfter);
  const first = channels.find((x) => x.type) || null;
  return {
    id: String(c.id || ""),
    folderId: String(c.folderId || ""),
    name: String(c.name || ""),
    description: String(c.description || ""),
    labels: c.labels || {},
    type: type,
    typeHuman: typeHuman(type),
    managed: type === "MANAGED",
    imported: type === "IMPORTED",
    domains: domains,
    wildcard: domains.some(isWildcard),
    status: status,
    statusHuman: statusHuman(status),
    issued: status === "ISSUED",
    dead: status === "INVALID" || status === "REVOKED" || status === "RENEWAL_FAILED",
    notAfter: String(c.notAfter || ""),
    notBefore: String(c.notBefore || ""),
    issuedAt: String(c.issuedAt || ""),
    createdAt: String(c.createdAt || ""),
    updatedAt: String(c.updatedAt || ""),
    ageDays: daysSince(c.createdAt),
    daysLeft: left,
    expiresHuman: humanDaysLeft(left),
    issuer: String(c.issuer || ""),
    serial: String(c.serial || ""),
    incompleteChain: c.incompleteChain === true,
    deletionProtection: c.deletionProtection === true,
    challengeType: (first && first.type) || "",
    challenges: channels,
    pending: channels.filter((x) => !x.done),
  };
}

// Что не так с сертификатом — словами и с тем, что делать. Здесь те причины
// простоя сайта, которые видно только по этим полям.
function certTrouble(info, nowMs) {
  const c = info || {};
  const out = [];
  if (c.status === "INVALID") {
    out.push(
      "Домен не подтвердили за отведённую неделю — сертификат не выпустится никогда. Ждать бесполезно: нужен НОВЫЙ запрос на выпуск (certnew) с тем же доменом."
    );
  }
  if (c.status === "RENEWAL_FAILED") {
    out.push(
      "Продление сорвалось: домен не подтвердился при автоматическом обновлении. Пока срок не вышел, выпусти новый сертификат и привяжи его к CDN-ресурсу — иначе HTTPS отвалится ровно в день окончания (" + (c.notAfter || "дата неизвестна") + ")."
    );
  }
  if (c.status === "REVOKED") {
    out.push("Сертификат отозван: браузеры его не примут, сайт по HTTPS не откроется. Нужен новый сертификат и привязка к ресурсу.");
  }
  const pending = c.pending || [];
  if (!c.issued && pending.length) {
    for (const p of pending) {
      if (p.dns) {
        out.push(
          "Домен " + p.domain + " не подтверждён (" + p.statusHuman + "): добавь " + p.dns.type + "-запись «" + p.dns.name + "» → " + p.dns.value +
            ". Пока её нет, сертификат не выпустится, а сайт по HTTPS не откроется."
        );
      } else if (p.http) {
        out.push(
          "Домен " + p.domain + " не подтверждён (" + p.statusHuman + "): файл " + p.http.url + " с текстом " + p.http.content +
            " должен быть доступен по http до выпуска сертификата."
        );
      } else {
        out.push("Домен " + p.domain + " не подтверждён (" + p.statusHuman + ").");
      }
    }
  }
  const left = daysLeft(c.notAfter, nowMs);
  if (c.issued && left != null && left <= 30) {
    out.push(
      c.managed
        ? "Сертификат истекает (" + humanDaysLeft(left) + "): облако продлевает выпущенные сертификаты само, вмешиваться не нужно — но если продление сорвётся, HTTPS отвалится ровно в этот день, поэтому за датой стоит следить."
        : "Сертификат истекает (" + humanDaysLeft(left) + "), а загруженный сертификат сам НЕ продлевается: обнови его до срока (certupdate с новым сертификатом и ключом), иначе браузеры начнут ругаться."
    );
  }
  if (c.incompleteChain) {
    out.push("В цепочке сертификата не хватает звеньев: часть браузеров и устройств его не примет. Загрузи сертификат вместе с полной цепочкой (chain).");
  }
  if (c.deletionProtection) {
    out.push("Включена защита от удаления: облако не даст удалить сертификат, пока её не снимешь (certupdate, deletionProtection: false).");
  }
  return out;
}

// ── CDN: состояние ресурса ──────────────────────────────────────────────────
const SSL_TYPES = {
  CM: "сертификат из Certificate Manager",
  DONT_USE: "HTTPS ВЫКЛЮЧЕН — ресурс отвечает только по http",
  LETS_ENCRYPT_GCORE: "устаревший способ выпуска (в новых ресурсах не используется)",
};

function sslTypeHuman(type) {
  const t = String(type == null ? "" : type).trim().toUpperCase();
  if (SSL_TYPES[t]) return SSL_TYPES[t];
  return t ? "тип «" + t + "»" : "сертификат не указан";
}

function originProtocolHuman(p) {
  const v = String(p == null ? "" : p).trim().toUpperCase();
  if (v === "HTTP") return "CDN идёт к источнику по http";
  if (v === "HTTPS") return "CDN идёт к источнику по https";
  if (v === "MATCH") return "протокол выбирается автоматически";
  return v ? "протокол «" + v + "»" : "";
}

function cdnInfo(resRaw) {
  const r = resRaw || {};
  const ssl = r.sslCertificate || {};
  const cm = (ssl.data && ssl.data.cm) || {};
  const opts = r.options || {};
  const host = (opts.hostOptions && opts.hostOptions.host) || null;
  const secondary = Array.isArray(r.secondaryHostnames) ? r.secondaryHostnames.map(String) : [];
  const cname = String(r.cname || "");
  return {
    id: String(r.id || ""),
    folderId: String(r.folderId || ""),
    cname: cname,
    domains: [cname].concat(secondary).filter(Boolean),
    active: r.active !== false,
    createdAt: String(r.createdAt || ""),
    updatedAt: String(r.updatedAt || ""),
    ageDays: daysSince(r.createdAt),
    originGroupId: r.originGroupId == null ? "" : String(r.originGroupId),
    originGroupName: String(r.originGroupName || ""),
    originProtocol: String(r.originProtocol || ""),
    originProtocolHuman: originProtocolHuman(r.originProtocol),
    secondaryHostnames: secondary,
    providerCname: String(r.providerCname || ""),
    sslType: String(ssl.type || "").trim().toUpperCase(),
    sslTypeHuman: sslTypeHuman(ssl.type),
    sslCertId: String(cm.id || ""),
    sslStatus: String(ssl.status || "").trim().toUpperCase(),
    sslReady: String(ssl.status || "").trim().toUpperCase() === "READY",
    tlsProfile: String((r.tls && r.tls.profile) || ""),
    hostHeader: host && host.enabled ? String(host.value || "") : "",
    edgeCacheDefault: String((opts.edgeCacheSettings && opts.edgeCacheSettings.defaultValue) || ""),
    labels: r.labels || {},
  };
}

// Что не так с CDN-ресурсом. Главные беды сайта по https — выключенный ресурс,
// отсутствующий сертификат и сертификат, который облако ещё не подхватило.
function cdnTrouble(info) {
  const r = info || {};
  const out = [];
  if (!r.active) {
    out.push("Ресурс ВЫКЛЮЧЕН: содержимое не отдаётся вообще — по адресу приходит ошибка, а не сайт. Включить: cdnupdate с active: true.");
  }
  if (r.sslType === "DONT_USE" || !r.sslType) {
    out.push(
      "По https ресурс не отвечает: сертификат не привязан вовсе («HTTPS выключен»). Браузер покажет «небезопасно» или не откроет сайт. " +
        "Выпусти сертификат (certnew) и привяжи его: cdnupdate { certificate: \"имя или id\" }."
    );
  } else if (r.sslType === "CM" && !r.sslReady) {
    out.push("Сертификат привязан, но облако ещё не подхватило его (в ресурсе он не READY): https заработает в течение ~15 минут после выпуска сертификата.");
  }
  if (r.sslType === "CM" && !r.sslCertId) {
    out.push("Тип сертификата «из Certificate Manager», а самого сертификата в ресурсе нет — проверь привязку в консоли CDN.");
  }
  if (r.sslType === "LETS_ENCRYPT_GCORE") {
    out.push("Устаревший способ выпуска сертификата: он работает, только пока домен уже указывает на защищённый IP. Для нового сайта бери сертификат из Certificate Manager.");
  }
  if (!r.providerCname) {
    out.push("У ресурса нет адреса провайдера (providerCname): узнать его можно, только перечитав ресурс — без него непонятно, куда направлять домен.");
  }
  if (r.hostHeader && /\.website\.yandexcloud\.net$/i.test(r.hostHeader)) {
    // Это правильная настройка для бакета-сайта, но о ней стоит напомнить: без
    // неё бакет-сайт отвечает CDN-серверам 404.
  } else if (!r.hostHeader && r.originGroupName) {
    // Без источника не отличить бакет от своего сервера: молчим, а не пугаем.
  }
  return out;
}

// Адрес источника: бакет-сайт и «просто бакет» — разные доменные имена, и
// путать их нельзя. Сайт-адрес отдаёт index.html по «/», обычный — только файлы.
function bucketOriginSource(bucket, website) {
  const b = String(bucket == null ? "" : bucket).trim();
  if (!b) throw new Error("Укажи имя бакета-источника.");
  if (/\s|\//.test(b)) throw new Error("Имя бакета «" + b + "» не годится: пробелов и слешей в нём быть не может.");
  return b + (website === false ? ".storage.yandexcloud.net" : ".website.yandexcloud.net");
}

// Заголовок Host для бакета-сайта. Бакет отвечает по своему доменному имени, и
// если CDN просит файл с чужим Host, бакет отдаёт 404 — это самая частая
// причина «CDN настроен, а сайта нет».
function hostHeaderFor(bucket, website) {
  return bucketOriginSource(bucket, website);
}

function metaFor(host, name) {
  const h = String(host || "").trim().toLowerCase();
  const nm = String(name || "").trim();
  if (!nm) return null;
  if (/\.website\.yandexcloud\.net$/.test(h)) return { website: { name: nm } };
  if (/\.storage\.yandexcloud\.net$/.test(h)) return { bucket: { name: nm } };
  return null;
}

function bucketNameFromHost(host) {
  const h = String(host || "").trim().toLowerCase();
  const m = /^([a-z0-9.-]+)\.(website|storage)\.yandexcloud\.net$/.exec(h);
  return m ? m[1] : "";
}

// Источник в том виде, в каком его ждёт API. Принимаем и строку, и объект:
// человек называет источник по-разному, а API строг.
function normalizeOrigin(v) {
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) throw new Error("Источник пустой: укажи домен или имя бакета.");
    const meta = metaFor(s, bucketNameFromHost(s));
    if (meta) return { source: s, enabled: true, meta: meta };
    // Голое слово без точек — это имя бакета: CDN обратится к бакету-сайту.
    if (s.indexOf(".") < 0 && !/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
      return { source: bucketOriginSource(s, true), enabled: true, meta: { website: { name: s } } };
    }
    return { source: s, enabled: true };
  }
  const o = v || {};
  const source = String(o.source || o.host || o.url || "").trim();
  const explicit = o.meta && typeof o.meta === "object" ? o.meta : null;
  const src = source || "";
  const website = o.website !== false;
  const bucket = o.bucket || "";
  if (!source && !explicit && !bucket) throw new Error("Источник без адреса: укажи source (домен или имя бакета) или bucket.");
  let finalSource = src;
  let meta = explicit;
  const kind = String(o.type || o.metaType || "").trim().toLowerCase();
  if (bucket) {
    finalSource = bucketOriginSource(bucket, website);
    meta = meta || { website: { name: String(bucket) } };
    if (!website) meta = { bucket: { name: String(bucket) } };
  } else if (kind === "website" || kind === "bucket" || kind === "common" || kind === "balancer") {
    const nm = String(o.name || bucketNameFromHost(src) || src).trim();
    if (kind === "balancer") meta = { balancer: { id: nm } };
    else if (kind === "common") meta = { common: { name: nm } };
    else meta = { [kind]: { name: nm } };
    if ((kind === "website" || kind === "bucket") && src.indexOf(".") < 0) finalSource = bucketOriginSource(src, kind === "website");
  } else if (!meta) {
    meta = metaFor(finalSource, bucketNameFromHost(finalSource));
  }
  const out = { source: finalSource, enabled: o.enabled !== false };
  if (o.backup === true) out.backup = true;
  if (meta) out.meta = meta;
  return out;
}

function originInfo(o) {
  const x = o || {};
  const meta = x.meta || {};
  const kind = meta.website ? "website" : meta.bucket ? "bucket" : meta.balancer ? "balancer" : meta.common ? "common" : "";
  const kindHuman =
    kind === "website"
      ? "бакет-сайт (отдаёт index.html по «/»)"
      : kind === "bucket"
      ? "бакет (файлы, без главной страницы)"
      : kind === "balancer"
      ? "L7-балансировщик"
      : kind === "common"
      ? "свой сервер по доменному имени"
      : "источник";
  const name = kind === "balancer" ? (meta.balancer && meta.balancer.id) || "" : (meta[kind] && meta[kind].name) || "";
  return {
    id: x.id == null ? "" : String(x.id),
    source: String(x.source || ""),
    enabled: x.enabled !== false,
    backup: x.backup === true,
    kind: kind,
    kindHuman: kindHuman,
    name: String(name || ""),
    human: String(x.source || "") + " — " + kindHuman + (x.backup === true ? ", резервный" : "") + (x.enabled === false ? " (ВЫКЛЮЧЕН)" : ""),
  };
}

function originGroupInfo(g) {
  const x = g || {};
  const origins = (Array.isArray(x.origins) ? x.origins : []).map(originInfo);
  return {
    id: x.id == null ? "" : String(x.id),
    folderId: String(x.folderId || ""),
    name: String(x.name || ""),
    useNext: x.useNext !== false,
    providerType: String(x.providerType || ""),
    origins: origins,
    active: origins.filter((o) => o.enabled),
  };
}

// ── Очистка кэша: пути ──────────────────────────────────────────────────────
// Пустой список путей для API значит «очистить ВСЁ», поэтому он приходит только
// от явного all: true. Звёздочка допустима лишь в конце пути: в начале или
// середине она молча не почистит ничего — на этом легко обмануться.
function normalizePurgePaths(v) {
  const raw = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
  const out = [];
  for (const x of raw) {
    let p = String(x == null ? "" : x).trim();
    if (!p) continue;
    if (p.indexOf("://") >= 0) {
      try {
        p = new URL(p).pathname;
      } catch (e) {
        /* оставим как есть — ниже откажем понятнее */
      }
    }
    p = p.split("?")[0].split("#")[0];
    if (p.charAt(0) !== "/") p = "/" + p;
    const star = p.indexOf("*");
    if (star >= 0 && star !== p.length - 1) {
      throw new Error(
        "Путь «" + String(x) + "» не почистится: звёздочка работает только В КОНЦЕ пути («/img/*» — вся папка). В начале или середине она ничего не заменяет, и кэш молча останется прежним."
      );
    }
    if (p === "/" || p === "") {
      throw new Error("Путь «/» не чистят выборочно: чтобы убрать всё, нужен all: true (полная очистка кэша).");
    }
    if (out.indexOf(p) < 0) out.push(p);
  }
  if (!out.length) {
    throw new Error("Не указано, что чистить: paths — пути вида /index.html или /img/* (до " + CDN_MAX_PURGE_PATHS + " за раз), либо all: true для полной очистки.");
  }
  if (out.length > CDN_MAX_PURGE_PATHS) {
    throw new Error(
      "За один запрос облако чистит не больше " + CDN_MAX_PURGE_PATHS + " путей, а указано " + out.length + ". Раздели на несколько вызовов (и помни: очистка разрешена раз в минуту)."
    );
  }
  return out;
}

// PEM-текст или нет. Нужно и для проверки ввода, и чтобы не перепутать
// ССЫЛКУ на сертификат (имя, id, домен) с его содержимым: «certupdate» с одним
// лишь описанием обязан работать, а с содержимым — только у загруженного.
function isPemText(v) {
  return String(v == null ? "" : v).indexOf("-----BEGIN") >= 0;
}

function createYcCdn(deps) {
  const api = deps || {};
  const waitOp = typeof api.waitOperation === "function" ? api.waitOperation : async () => ({});
  const serviceError = typeof api.serviceError === "function" ? api.serviceError : (e) => String((e && e.message) || e);

  function requireApi() {
    if (typeof api.fetchJson !== "function" || typeof api.getIamToken !== "function") {
      throw new Error("CDN: модулю не переданы помощники облака (fetchJson, getIamToken).");
    }
  }

  async function base(serviceId, fallback) {
    const b = typeof api.endpoint === "function" ? await api.endpoint(serviceId) : "";
    return b || fallback;
  }

  async function call(oauthToken, serviceId, fallback, method, path, body, timeoutMs) {
    requireApi();
    const b = await base(serviceId, fallback);
    const token = await api.getIamToken(oauthToken);
    const headers = { Authorization: "Bearer " + token };
    const opts = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    try {
      return await api.fetchJson(b + path, opts, timeoutMs || 30000);
    } catch (e) {
      const err = new Error(serviceError(e, b, path));
      err.status = e && e.status;
      throw err;
    }
  }

  function certApi(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "certificate-manager", CERT_FALLBACK, method, path, body, timeoutMs);
  }

  function cdnApi(oauthToken, method, path, body, timeoutMs) {
    return call(oauthToken, "cdn", CDN_FALLBACK, method, path, body, timeoutMs);
  }

  async function run(oauthToken, j, timeoutMs) {
    const op = await waitOp(oauthToken, j && j.id, timeoutMs || 300000);
    return op || {};
  }

  // ── Сертификаты: чтение ───────────────────────────────────────────────────

  // view=FULL приносит вместе с сертификатом проверки прав на домены — без них
  // непонятно, что именно добавить в DNS и почему сертификат не выпускается.
  async function certificates(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await certApi(
      oauthToken,
      "GET",
      "/certificate-manager/v1/certificates?folderId=" + encodeURIComponent(folder) + "&view=FULL&pageSize=1000",
      undefined,
      25000
    );
    return (Array.isArray(j && j.certificates) ? j.certificates : []).map(certInfo);
  }

  async function certificate(oauthToken, certId) {
    const id = String(certId || "").trim();
    if (!id) throw new Error("Не указан id сертификата.");
    return certInfo(await certApi(oauthToken, "GET", "/certificate-manager/v1/certificates/" + encodeURIComponent(id) + "?view=FULL", undefined, 20000));
  }

  // Сертификат зовут по-разному: id, именем или доменом, для которого он выдан.
  async function findCertificate(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim().toLowerCase();
    const list = await certificates(oauthToken, folderId);
    if (!q) return list.length === 1 ? list[0] : null;
    return (
      list.find((c) => c.id === q) ||
      list.find((c) => String(c.name).toLowerCase() === q) ||
      list.find((c) => c.domains.some((d) => String(d).toLowerCase() === q)) ||
      null
    );
  }

  async function requireCertificate(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    if (!q) {
      throw new Error("Укажи сертификат: имя, id или домен (список: ycCdn { action: \"certs\" }). Выпустить новый: certnew.");
    }
    const found = await findCertificate(oauthToken, folderId, q);
    if (found) return found;
    const byId = await certificate(oauthToken, q).catch(() => null);
    if (byId && byId.id) return byId;
    throw new Error("Не нашёл сертификат «" + q + "» в каталоге. Список: ycCdn { action: \"certs\" }.");
  }

  // ── Сертификаты: выпуск ───────────────────────────────────────────────────

  // Ссылка на сертификат: имя, id или домен. НИКОГДА не содержимое — иначе
  // «certupdate с одним описанием» уходил бы искать сертификат с именем из
  // PEM-файла.
  function certRefOf(opt) {
    const o = opt || {};
    const direct = o.cert || o.name || o.id || o.certificateId;
    if (direct) return String(direct).trim();
    return isPemText(o.certificate) ? "" : String(o.certificate || "").trim();
  }

  // Содержимое загружаемого сертификата: отдельные поля, чтобы не путаться со
  // ссылкой на сертификат.
  function pemOf(opt) {
    const o = opt || {};
    return o.certificateText != null ? o.certificateText : o.pem != null ? o.pem : !isPemText(o.certificate) ? "" : o.certificate;
  }

  function assertPem(v, what) {
    const s = String(v == null ? "" : v);
    if (s.indexOf("-----BEGIN") < 0) {
      throw new Error(
        what + ": не похоже на PEM-текст. Нужен файл целиком — начиная со строки «-----BEGIN ...-----» и до «-----END ...-----», без лишних слов вокруг."
      );
    }
    return s;
  }

  // Панель проверок: что и куда добавить, чтобы домен подтвердился.
  function challengePlan(certRaw) {
    const cert = certRaw && Array.isArray(certRaw.challenges) ? certRaw : certInfo(certRaw);
    return (cert.challenges || []).map((c) => {
      const out = {
        domain: c.domain,
        type: c.type,
        status: c.status,
        statusHuman: c.statusHuman,
        done: c.done,
        record: c.dns ? { name: c.dns.name, type: c.dns.type, value: c.dns.value } : null,
        http: c.http ? { url: c.http.url, content: c.http.content } : null,
      };
      out.what = out.record ? "DNS-запись" : out.http ? "файл на сайте" : "непонятно, чем подтверждать";
      out.toolAdd = out.record
        ? 'ycDns { action: "add", zone: "example.com", name: "' + out.record.name + '", type: "' + out.record.type + '", value: "' + out.record.value + '" }'
        : "";
      return out;
    });
  }

  function planLines(plan) {
    const out = [];
    for (const p of plan || []) {
      if (p.done) {
        out.push("• " + p.domain + " — подтверждён");
        continue;
      }
      if (p.record) {
        out.push("• " + p.domain + ": " + p.record.type + "-запись «" + p.record.name + "» → " + p.record.value + " (" + p.statusHuman + ")");
      } else if (p.http) {
        out.push("• " + p.domain + ": файл " + p.http.url + " с текстом " + p.http.content + " (" + p.statusHuman + ")");
      } else {
        out.push("• " + p.domain + " — " + p.statusHuman);
      }
    }
    return out;
  }

  // Запрос сертификата от Let's Encrypt. Отдельно и подробно говорим про
  // подтверждение домена: без записи сертификат не выпустится вообще, и это
  // самая частая причина «запросил и ничего не работает».
  async function requestCertificate(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name || "site-cert");
    const domains = checkDomains(opt.domains != null ? opt.domains : opt.domain, "Сертификат");
    const challengeType = challengeFor(domains, opt.challengeType);
    const body = { folderId: folderId, name: name, domains: domains, challengeType: challengeType };
    if (opt.description) body.description = String(opt.description).slice(0, 1024);
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;
    if (opt.deletionProtection === true) body.deletionProtection = true;

    const j = await certApi(oauthToken, "POST", "/certificate-manager/v1/certificates/requestNew", body, 30000);
    const op = await run(oauthToken, j, 120000);
    // id готового сертификата приходит в ответе ОПЕРАЦИИ, а не в теле запроса.
    let createdId = (op.response && op.response.id) || "";
    if (!createdId) {
      const found = await findCertificate(oauthToken, folderId, name).catch(() => null);
      createdId = (found && found.id) || "";
    }
    const cert = createdId ? await certificate(oauthToken, createdId).catch(() => null) : null;
    const plan = cert ? challengePlan(cert) : [];

    const warns = [];
    warns.push(
      "Домен нужно подтвердить, иначе сертификат не выпустится: пока проверка не пройдена, сайт по HTTPS не откроется. Проверка идёт сама — облако смотрит зону периодически (от часа до суток)."
    );
    if (challengeType === "DNS") {
      warns.push(
        "Запись подтверждения — ТОЛЬКО ОДНА (CNAME или TXT): если добавить обе, кеширующие серверы начнут конфликтовать. CNAME делегирует проверку облаку — подтверждается один раз и продления проходят сами; с TXT запись придётся обновлять каждые 60 дней."
      );
      warns.push("На имени «" + DNS_CHALLENGE_PREFIX + "<домен>» не должно быть других записей, кроме этой CNAME, — иначе проверка не пройдёт.");
    } else {
      warns.push("Файл проверки должен быть доступен по адресу из списка ниже; после выпуска сертификата его лучше убрать с сайта.");
    }
    if (domains.some(isWildcard)) warns.push("В сертификате есть маска (*.домен): она подходит и на сам домен, и на любой его поддомен — отдельный сертификат на example.com не нужен.");
    warns.push("Сертификаты бесплатны (Certificate Manager не тарифицируется); платит только CDN-ресурс, который его носит.");

    return {
      changed: true,
      certificate: cert,
      challengeType: challengeType,
      plan: plan,
      lines: planLines(plan),
      warnings: warns,
      message:
        "Запрошен сертификат «" + name + "» для доменов: " + domains.join(", ") + " (проверка " + (challengeType === "DNS" ? "по DNS-записи" : "файлом на сайте") + ")." +
        (cert ? " Статус: " + cert.statusHuman + "." : ""),
    };
  }

  // Загруженный сертификат: файл + ключ. Живёт столько, сколько ему осталось, и
  // сам не продлевается — об этом обязательно предупреждаем, иначе сайт умрёт
  // ровно в день окончания, и никто не поймёт почему.
  async function importCertificate(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name || "site-cert");
    const cert = assertPem(opt.certificate || opt.cert, "Сертификат");
    const key = assertPem(opt.privateKey || opt.key, "Приватный ключ");
    const chain = opt.chain ? assertPem(opt.chain, "Цепочка сертификата") : "";
    const body = { folderId: folderId, name: name, certificate: cert, privateKey: key };
    if (chain) body.chain = chain;
    if (opt.description) body.description = String(opt.description).slice(0, 1024);
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;

    const j = await certApi(oauthToken, "POST", "/certificate-manager/v1/certificates", body, 30000);
    const op = await run(oauthToken, j, 120000);
    let createdId = (op.response && op.response.id) || "";
    if (!createdId) {
      const found = await findCertificate(oauthToken, folderId, name).catch(() => null);
      createdId = (found && found.id) || "";
    }
    const after = createdId ? await certificate(oauthToken, createdId).catch(() => null) : null;
    if (!after) throw new Error("Сертификат «" + name + "» загружен, но не перечитался — проверь его в консоли Certificate Manager.");
    const warns = [
      "Загруженный сертификат сам НЕ продлевается: обновлять его придётся вручную до срока окончания (" + after.expiresHuman + "), иначе браузеры начнут ругаться прямо в этот день.",
      "Бесплатный сертификат от Let's Encrypt облако выпускает и продлевает само — для сайта это обычно проще: certnew.",
    ];
    for (const t of certTrouble(after)) warns.push(t);
    return {
      changed: true,
      certificate: after,
      warnings: warns,
      lines: certLines(after),
      message: "Сертификат «" + after.name + "» загружен (" + after.domains.join(", ") + ", " + after.expiresHuman + ").",
    };
  }

  // Правка сертификата. Содержимое (сертификат, цепочка, ключ) можно менять
  // ТОЛЬКО у загруженного: у выпущенного облаком оно продлевается само.
  async function updateCertificate(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const cert = await requireCertificate(oauthToken, folderId, certRefOf(opt));
    const fields = [];
    const body = {};
    if (opt.newName != null && String(opt.newName).trim()) {
      const nm = checkName(opt.newName);
      if (nm !== cert.name) {
        body.name = nm;
        fields.push("name");
      }
    }
    if (opt.description != null) {
      const d = String(opt.description).trim();
      if (d !== String(cert.description || "")) {
        body.description = d;
        fields.push("description");
      }
    }
    if (opt.labels && typeof opt.labels === "object") {
      body.labels = opt.labels;
      fields.push("labels");
    }
    if (opt.deletionProtection != null) {
      const on = opt.deletionProtection === true || opt.deletionProtection === "true";
      if (on !== cert.deletionProtection) {
        body.deletionProtection = on;
        fields.push("deletionProtection");
      }
    }
    const wantsContent = String(pemOf(opt) || "") !== "" || opt.chain != null || opt.privateKey != null || opt.key != null;
    if (wantsContent) {
      if (cert.managed) {
        throw new Error(
          "У сертификата от Let's Encrypt содержимое менять нельзя: облако выпускает и продлевает его само. " +
            "Домены и содержимое меняются только через НОВЫЙ сертификат: certnew. Здесь можно поправить имя, описание, метки и защиту от удаления."
        );
      }
      const pem = assertPem(pemOf(opt), "Сертификат");
      const key = assertPem(opt.privateKey || opt.key, "Приватный ключ");
      body.certificate = pem;
      body.privateKey = key;
      fields.push("certificate");
      fields.push("privateKey");
      if (opt.chain != null) {
        body.chain = assertPem(opt.chain, "Цепочка сертификата");
        fields.push("chain");
      }
    }
    if (!fields.length) {
      return {
        changed: false,
        certificate: cert,
        message:
          "У сертификата «" + cert.name + "» нечего менять. Домены сертификата изменить НЕЛЬЗЯ (в API такого поля нет) — для другого набора доменов нужен новый сертификат: certnew.",
      };
    }
    // Маска обязательна: без неё сервис обновит все поля и обнулит те, которых
    // нет в теле (у загруженного сертификата это стёрло бы содержимое).
    body.updateMask = fields.join(",");
    const j = await certApi(oauthToken, "PATCH", "/certificate-manager/v1/certificates/" + encodeURIComponent(cert.id), body, 30000);
    await run(oauthToken, j, 120000);
    const after = await certificate(oauthToken, cert.id).catch(() => null);
    if (!after) throw new Error("Сертификат «" + cert.name + "» не перечитался после правки — проверь его в списке.");
    const nameOk = !body.name || after.name === body.name;
    const descOk = fields.indexOf("description") < 0 || after.description === body.description;
    if (!nameOk || !descOk) {
      throw new Error(
        "Правка сертификата не применилась: имя «" + after.name + "», описание «" + after.description + "». Нужна роль certificate-manager.editor (или admin)."
      );
    }
    const warns = [];
    if (wantsContent && after.daysLeft != null) warns.push("Сертификат заменён: " + after.expiresHuman + ". Не забудь про следующее обновление — загруженные сертификаты не продлеваются сами.");
    return { changed: true, certificate: after, warnings: warns, message: "Сертификат «" + after.name + "» обновлён (" + fields.join(", ") + ")." };
  }

  // Удаление сертификата. Сначала выясняем, кто им пользуется: CDN-ресурсы
  // начнут отдавать «сертификат недействителен», и об этом надо сказать ДО
  // удаления, а не после.
  async function deleteCertificate(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const cert = await requireCertificate(oauthToken, folderId, certRefOf(opt));
    const users = await resources(oauthToken, folderId).catch(() => []);
    const usedBy = users.filter((r) => r.sslCertId && r.sslCertId === cert.id);

    if (cert.deletionProtection) {
      throw new Error(
        "У сертификата «" + cert.name + "» включена защита от удаления — облако его не удалит. Сначала сними защиту: certupdate { certificate: \"" + cert.name + "\", deletionProtection: false }."
      );
    }
    if (opt.confirm !== true) {
      const warns = [];
      if (usedBy.length) {
        warns.push(
          "Сертификат привязан к CDN-ресурсу(ам): " + usedBy.map((r) => "«" + (r.cname || r.id) + "»").join(", ") + " — у них отвалится HTTPS, и браузер покажет «сертификат недействителен»."
        );
      }
      warns.push("Домены сертификата: " + (cert.domains.join(", ") || "—") + " — по ним сайт перестанет открываться через этот сертификат.");
      warns.push("Удаление необратимо: заново выпустить можно только НОВЫМ запросом (certnew), а он потребует заново подтвердить домен.");
      return {
        deleted: false,
        needsConfirm: true,
        certificate: cert,
        usedBy: usedBy,
        warnings: warns,
        message:
          "Удаление сертификата «" + cert.name + "» необратимо. Назови пользователю, что уйдёт" + (usedBy.length ? " и какие сайты сломаются" : "") + ", и повтори с confirm: true.",
      };
    }
    const j = await certApi(oauthToken, "DELETE", "/certificate-manager/v1/certificates/" + encodeURIComponent(cert.id), undefined, 30000);
    await run(oauthToken, j, 120000);
    const left = await certificate(oauthToken, cert.id).catch(() => null);
    if (left) throw new Error("Сертификат «" + cert.name + "» не удалился: он всё ещё существует. Нужна роль certificate-manager.editor (или admin).");
    const warns = [];
    if (usedBy.length) {
      warns.push("CDN-ресурсы " + usedBy.map((r) => "«" + (r.cname || r.id) + "»").join(", ") + " остались без сертификата: по https они больше не работают. Выпусти новый сертификат и привяжи его (cdnupdate).");
    }
    return { deleted: true, certificate: cert, usedBy: usedBy, warnings: warns, message: "Сертификат «" + cert.name + "» удалён." };
  }

  // Карточка сертификата словами: для кого, чем подтверждается, сколько осталось
  // и что делать прямо сейчас.
  function certLines(certRaw) {
    const c = certRaw && certRaw.challenges ? certRaw : certInfo(certRaw);
    const out = [];
    out.push(c.name + " — " + c.statusHuman + " · " + c.typeHuman);
    out.push("  домены: " + (c.domains.join(", ") || "—") + " · id " + (c.id || "—"));
    if (c.issued) {
      out.push("  действует до " + (c.notAfter || "—") + " (" + c.expiresHuman + ")" + (c.issuer ? " · выдал " + c.issuer : ""));
    } else {
      out.push("  выпущен ещё не был: срока окончания нет, HTTPS ещё не работает");
    }
    const pending = c.pending || [];
    if (pending.length) {
      out.push("  подтверждение домена — " + (c.challengeType === "DNS" ? "записью в DNS" : "файлом на сайте") + ":");
      for (const l of planLines(challengePlan(c))) out.push("    " + l);
    }
    const trouble = certTrouble(c);
    for (const t of trouble) out.push("  ⚠ " + t);
    return out;
  }

  // ── Сертификаты: обзор каталога ───────────────────────────────────────────
  async function certOverview(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const list = await certificates(oauthToken, folder);
    const rows = list.map((c) => ({
      certificate: c,
      trouble: certTrouble(c),
      planned: c.issued ? false : (c.challenges || []).length > 0,
    }));
    const issued = rows.filter((r) => r.certificate.issued);
    const awaiting = rows.filter((r) => !r.certificate.issued && r.planned);
    const broken = rows.filter((r) => r.certificate.dead);
    const expiring = rows.filter((r) => r.certificate.issued && r.certificate.daysLeft != null && r.certificate.daysLeft <= 30);

    const lines = [];
    if (!rows.length) {
      lines.push("Сертификатов в каталоге нет. Выпустить бесплатный сертификат: ycCdn { action: \"certnew\", name: \"site-cert\", domains: [\"cdn.example.com\"] }.");
    }
    for (const r of rows) {
      const c = r.certificate;
      lines.push(
        c.name + " — " + c.statusHuman + " · " + c.typeHuman + " · домены: " + (c.domains.join(", ") || "—") +
          (c.issued ? " · " + c.expiresHuman : "") + " · id " + c.id
      );
      for (const t of r.trouble) lines.push("    ⚠ " + t);
    }
    if (awaiting.length) {
      lines.push("Ждут подтверждения домена: " + awaiting.map((r) => r.certificate.name).join(", ") + " — пока их не подтвердят, HTTPS не заработает.");
    }
    if (broken.length) lines.push("Не выпустились: " + broken.map((r) => r.certificate.name).join(", ") + " — этим сертификатам нужен НОВЫЙ запрос (certnew), ждать бесполезно.");
    if (expiring.length) {
      lines.push("Скоро истекают: " + expiring.map((r) => r.certificate.name + " (" + r.certificate.expiresHuman + ")").join(", ") + ".");
    }
    if (issued.length) lines.push("Готовы к привязке к сайту: " + issued.map((r) => r.certificate.name).join(", ") + ".");
    lines.push("Сами сертификаты бесплатны: Certificate Manager не тарифицируется. Платит CDN-ресурс, который его носит.");

    return { certificates: list, rows: rows, issued: issued.map((r) => r.certificate), awaiting: awaiting.map((r) => r.certificate), broken: broken.map((r) => r.certificate), lines: lines, message: "Сертификатов: " + rows.length + "." };
  }

  // ── CDN: группы источников ────────────────────────────────────────────────

  async function originGroups(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await cdnApi(oauthToken, "GET", "/cdn/v1/originGroups?folderId=" + encodeURIComponent(folder) + "&pageSize=1000", undefined, 25000);
    return (Array.isArray(j && j.originGroups) ? j.originGroups : []).map(originGroupInfo);
  }

  async function originGroup(oauthToken, folderId, id) {
    const gid = String(id || "").trim();
    if (!gid) throw new Error("Не указан id группы источников.");
    return originGroupInfo(
      await cdnApi(oauthToken, "GET", "/cdn/v1/originGroups/" + encodeURIComponent(gid) + "?folderId=" + encodeURIComponent(checkFolder(folderId)), undefined, 20000)
    );
  }

  async function findOriginGroup(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    const list = await originGroups(oauthToken, folderId);
    if (!q) return list.length === 1 ? list[0] : null;
    return list.find((g) => g.id === q) || list.find((g) => g.name === q) || null;
  }

  async function requireOriginGroup(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    if (!q) throw new Error("Укажи группу источников: имя или id (список: ycCdn { action: \"origins\" }).");
    const found = await findOriginGroup(oauthToken, folderId, q);
    if (found) return found;
    throw new Error("Не нашёл группу источников «" + q + "» в каталоге. Список: ycCdn { action: \"origins\" }.");
  }

  async function createOriginGroup(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const name = checkName(opt.name);
    const origins = (Array.isArray(opt.origins) ? opt.origins : opt.origins == null ? [] : [opt.origins]).map(normalizeOrigin);
    if (!origins.length) {
      throw new Error("Укажи источник: origins — например [{ bucket: \"имя-бакета\" }] для бакета-сайта или [{ source: \"files.example.com\" }] для своего сервера.");
    }
    if (!origins.some((x) => x.enabled)) throw new Error("Все источники выключены: CDN некуда обращаться. Хотя бы один должен быть enabled.");
    const body = { folderId: folderId, name: name, useNext: opt.useNext !== false, origins: origins };
    const j = await cdnApi(oauthToken, "POST", "/cdn/v1/originGroups", body, 30000);
    await run(oauthToken, j, 300000);
    const after = await findOriginGroup(oauthToken, folderId, name).catch(() => null);
    if (!after) throw new Error("Группа источников «" + name + "» создана, но не перечиталась — проверь её в консоли CDN.");
    const warns = [];
    if (origins.some((x) => x.meta && x.meta.website)) {
      warns.push(
        "Для бакета-сайта в CDN-ресурсе обязательно своё значение заголовка Host (" + origins.map((x) => x.source).join(", ") + "): без него бакет отвечает CDN-серверам «404». Модуль ставит его сам, когда ресурс создаётся с bucket."
      );
    }
    return { changed: true, group: after, warnings: warns, message: "Группа источников «" + name + "» создана (источников: " + after.origins.length + ")." };
  }

  // Сравнение списков источников по содержанию: «столько же источников» не
  // значит «те же источники» — облако могло молча не применить правку.
  function sameOrigins(a, b) {
    const key = (x) => String((x && x.source) || "") + "|" + ((x && x.enabled === false) ? "off" : "on") + "|" + ((x && x.backup === true) ? "backup" : "main");
    const A = (a || []).map(key).sort();
    const B = (b || []).map(key).sort();
    return A.length === B.length && A.every((x, i) => x === B[i]);
  }

  // Обновление группы. ЛОВУШКА API: путь БЕЗ id (PATCH /cdn/v1/originGroups), а
  // id и новое имя идут в теле (originGroupId и groupName). Запрос с id в пути
  // возвращает 404 и выглядит как «нет прав».
  async function updateOriginGroup(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const g = await requireOriginGroup(oauthToken, folderId, opt.group || opt.originGroup || opt.id || opt.name);
    const body = { folderId: folderId, originGroupId: g.id };
    const fields = [];
    if (opt.newName != null && String(opt.newName).trim()) {
      const nm = checkName(opt.newName);
      if (nm !== g.name) {
        body.groupName = nm;
        fields.push("groupName");
      }
    }
    if (opt.useNext != null) {
      body.useNext = opt.useNext === true || opt.useNext === "true";
      fields.push("useNext");
    }
    if (opt.origins != null) {
      const origins = (Array.isArray(opt.origins) ? opt.origins : [opt.origins]).map(normalizeOrigin);
      if (!origins.length) throw new Error("Список источников заменяется ЦЕЛИКОМ — пустым он быть не может: включи хотя бы один источник.");
      if (!origins.some((x) => x.enabled)) throw new Error("Все источники выключены: CDN некуда обращаться. Хотя бы один должен быть enabled.");
      body.origins = origins;
      fields.push("origins");
    }
    if (!fields.length) {
      return { changed: false, group: g, message: "У группы «" + g.name + "» нечего менять: укажи origins (новый список целиком), newName или useNext." };
    }
    const j = await cdnApi(oauthToken, "PATCH", "/cdn/v1/originGroups", body, 30000);
    await run(oauthToken, j, 300000);
    const after = await originGroup(oauthToken, folderId, g.id).catch(() => null);
    if (!after) throw new Error("Группа «" + g.name + "» не перечиталась после правки — проверь её в консоли CDN.");
    const ok = (!body.groupName || after.name === body.groupName) && (fields.indexOf("origins") < 0 || sameOrigins(after.origins, body.origins));
    if (!ok) {
      throw new Error(
        "Правка группы источников не применилась (имя «" + after.name + "», источников: " + after.origins.length + "). Нужна роль cdn.editor (или admin)."
      );
    }
    const warns = ["Изменения в CDN применяются до 15 минут. После смены источника стоит очистить кэш ресурса (purge) — иначе посетители ещё увидят старые файлы."];
    return { changed: true, group: after, warnings: warns, message: "Группа источников «" + after.name + "» обновлена (" + fields.join(", ") + ")." };
  }

  // Удаление группы. Облако не даёт удалить группу, которую использует ресурс,
  // и отвечает на это невнятно — поэтому имена ресурсов называем сами.
  async function deleteOriginGroup(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const g = await requireOriginGroup(oauthToken, folderId, opt.group || opt.originGroup || opt.id || opt.name);
    const list = await resources(oauthToken, folderId).catch(() => []);
    const usedBy = list.filter((r) => r.originGroupId && r.originGroupId === g.id);
    if (usedBy.length && opt.force !== true) {
      throw new Error(
        "Группу «" + g.name + "» использует CDN-ресурс: " + usedBy.map((r) => "«" + (r.cname || r.id) + "»").join(", ") +
          ". Пока он на неё смотрит, облако группу не удалит (и правильно: сайт остался бы без источника). Сначала переведи ресурс на другую группу (cdnupdate с originGroupId)."
      );
    }
    if (opt.confirm !== true) {
      return {
        deleted: false,
        needsConfirm: true,
        group: g,
        usedBy: usedBy,
        warnings: ["Группу источников не вернуть: её придётся собирать заново. Источники: " + g.origins.map((x) => x.source).join(", ") + "."],
        message: "Удаление группы «" + g.name + "» необратимо. Повтори с confirm: true.",
      };
    }
    const j = await cdnApi(oauthToken, "DELETE", "/cdn/v1/originGroups/" + encodeURIComponent(g.id), undefined, 30000);
    await run(oauthToken, j, 300000);
    const left = await originGroup(oauthToken, folderId, g.id).catch(() => null);
    if (left) throw new Error("Группа «" + g.name + "» не удалилась: она всё ещё существует. Нужна роль cdn.editor (или admin).");
    return { deleted: true, group: g, usedBy: usedBy, warnings: [], message: "Группа источников «" + g.name + "» удалена." };
  }

  // ── CDN: ресурсы ──────────────────────────────────────────────────────────

  async function resources(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const j = await cdnApi(oauthToken, "GET", "/cdn/v1/resources?folderId=" + encodeURIComponent(folder) + "&pageSize=1000", undefined, 25000);
    return (Array.isArray(j && j.resources) ? j.resources : []).map(cdnInfo);
  }

  async function resource(oauthToken, resourceId) {
    const id = String(resourceId || "").trim();
    if (!id) throw new Error("Не указан id CDN-ресурса.");
    return cdnInfo(await cdnApi(oauthToken, "GET", "/cdn/v1/resources/" + encodeURIComponent(id), undefined, 20000));
  }

  async function findResource(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim().toLowerCase();
    const list = await resources(oauthToken, folderId);
    if (!q) return list.length === 1 ? list[0] : null;
    return (
      list.find((r) => String(r.id).toLowerCase() === q) ||
      list.find((r) => String(r.cname).toLowerCase() === q) ||
      list.find((r) => r.secondaryHostnames.some((h) => String(h).toLowerCase() === q)) ||
      null
    );
  }

  async function requireResource(oauthToken, folderId, ref) {
    const q = String(ref == null ? "" : ref).trim();
    if (!q) throw new Error("Укажи CDN-ресурс: домен или id (список: ycCdn { action: \"cdn\" }).");
    const found = await findResource(oauthToken, folderId, q);
    if (found) return found;
    throw new Error("Не нашёл CDN-ресурс «" + q + "» в каталоге. Список: ycCdn { action: \"cdn\" }.");
  }

  // Настройки ресурса по умолчанию. Заголовок Host для бакета-сайта и перевод
  // http→https — это ровно то, ради чего ресурс и создаётся; всё остальное
  // оставляем облаку.
  function buildResourceOptions(opt, ctx) {
    const c = ctx || {};
    const out = Object.assign({}, opt.options || {});
    if (c.bucket && c.website !== false && !out.hostOptions) {
      out.hostOptions = { host: { enabled: true, value: hostHeaderFor(c.bucket, true) } };
    }
    if (c.cert && !out.redirectOptions) {
      out.redirectOptions = { redirectHttpToHttps: { enabled: true, value: true } };
    }
    return out;
  }

  function normalizeOriginProtocol(v, isBucket) {
    const p = String(v == null ? "" : v).trim().toUpperCase();
    if (!p) return isBucket ? "HTTP" : "MATCH";
    if (p === "HTTP" || p === "HTTPS" || p === "MATCH") return p;
    throw new Error("Протокол до источника «" + v + "» не понял. Доступно: HTTP, HTTPS или MATCH (автоматически).");
  }

  function secondaryHostnames(v) {
    const raw = Array.isArray(v) ? v : v == null || v === "" ? [] : [v];
    const out = [];
    for (const x of raw) {
      const d = checkDomain(x, "Дополнительный домен");
      if (out.indexOf(d) < 0) out.push(d);
    }
    return out;
  }

  async function createResource(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const cname = checkDomain(opt.cname || opt.domain, "Основной домен CDN-ресурса");

    const groupRef = opt.originGroupId != null && String(opt.originGroupId).trim() ? String(opt.originGroupId).trim() : String(opt.originGroup || "").trim();
    const bucket = String(opt.bucket || opt.bucketName || "").trim();
    if (!groupRef && !bucket) {
      throw new Error(
        "Укажи источник: bucket («имя бакета» — CDN сам обратится к бакету-сайту) или originGroupId (готовая группа источников). Без источника CDN неоткуда брать файлы."
      );
    }
    const website = opt.website !== false;
    let origin = null;
    let groupId = "";
    if (groupRef) {
      const g = await findOriginGroup(oauthToken, folderId, groupRef);
      if (!g) throw new Error("Не нашёл группу источников «" + groupRef + "» в каталоге. Проще всего создать ресурс сразу с bucket: \"имя-бакета\" — группу облако сделает само.");
      if (!g.active.length) throw new Error("В группе источников «" + g.name + "» нет ни одного включённого источника — CDN некуда обращаться. Включи источник (originupdate).");
      origin = { originGroupId: g.id };
      groupId = g.id;
    } else {
      origin = { originSourceParams: { source: bucketOriginSource(bucket, website), meta: website ? { website: { name: bucket } } : { bucket: { name: bucket } } } };
    }

    // Сертификат: он обязан быть в том же каталоге, иначе облако отказывает
    // невнятно. Проверяем словами и до запроса.
    let cert = null;
    const certRef = String(opt.certificate || opt.certificateId || opt.sslCertificateId || "").trim();
    if (certRef) {
      cert = await requireCertificate(oauthToken, folderId, certRef);
      if (cert.folderId && cert.folderId !== folderId) {
        throw new Error(
          "Сертификат «" + cert.name + "» лежит в другом каталоге (" + cert.folderId + "). Облако принимает только сертификаты из того же каталога, где создаётся CDN-ресурс: выпусти сертификат в этом каталоге (certnew)."
        );
      }
    }

    const extra = secondaryHostnames(opt.secondaryHostnames || opt.altDomains);
    const proto = normalizeOriginProtocol(opt.originProtocol, !!bucket);
    const options = buildResourceOptions(opt, { bucket: bucket, website: website, cert: cert });

    const warns = [];
    if (bucket && website) {
      warns.push(
        "Бакет должен отдавать сайт: включи в нём хостинг статики и главную страницу (index.html), иначе по «/» будет список файлов или 404. Публичное чтение: ycStorage { action: \"public\", bucket: \"" + bucket + "\" }."
      );
    }
    if (cert && !cert.issued) {
      warns.push(
        "Сертификат «" + cert.name + "» ещё не выпущен (" + cert.statusHuman + "): HTTPS заработает только после подтверждения домена и выпуска. Ресурс создаётся — но пока это сайт по http."
      );
    }
    if (!cert) {
      warns.push("Сертификат не указан: ресурс будет отвечать только по http, и браузер покажет «небезопасно». Бесплатный сертификат: certnew, потом привязать (cdnupdate).");
    }
    warns.push(
      "Ресурс CDN платный: " + CDN_RESOURCE_MONTH + " ₽ в месяц за каждый ресурс, пакет из " + CDN_INCLUDED_GB + " ГБ исходящего трафика и " +
        CDN_INCLUDED_REQUESTS / 1000000 + " млн запросов включён. Деньги уходят даже тогда, когда сайт никто не открывает."
    );
    warns.push("Изменения в CDN вступают в силу до 15 минут: сразу после создания домен может ещё не отвечать.");

    if (opt.confirm !== true) {
      return {
        created: false,
        needsConfirm: true,
        price: CDN_RESOURCE_MONTH,
        cname: cname,
        origin: bucket ? bucketOriginSource(bucket, website) : "группа источников " + groupId,
        warnings: warns,
        message:
          "CDN-ресурс «" + cname + "» — платный (" + CDN_RESOURCE_MONTH + " ₽/мес за ресурс, даже без трафика). Назови цену пользователю и переспроси: без confirm: true ничего не создаю.",
      };
    }

    const body = { folderId: folderId, cname: cname, origin: origin, active: opt.active !== false, originProtocol: proto };
    if (extra.length) body.secondaryHostnames = { values: extra };
    if (Object.keys(options).length) body.options = options;
    if (cert) body.sslCertificate = { type: "CM", data: { cm: { id: cert.id } } };
    if (opt.labels && typeof opt.labels === "object") body.labels = opt.labels;

    const j = await cdnApi(oauthToken, "POST", "/cdn/v1/resources", body, 30000);
    const op = await run(oauthToken, j, 300000);
    const createdId = (op.response && op.response.id) || "";
    const after = createdId ? await resource(oauthToken, createdId).catch(() => null) : await findResource(oauthToken, folderId, cname).catch(() => null);
    if (!after) throw new Error("Ресурс «" + cname + "» создан, но не перечитался — проверь его в консоли Cloud CDN.");
    if (cert && after.sslCertId !== cert.id) {
      throw new Error(
        "Ресурс создан, но сертификат к нему не привязался (в ресурсе " + (after.sslTypeHuman || "нет типа сертификата") +
          "). Привяжи его отдельно: cdnupdate { resource: \"" + cname + "\", certificate: \"" + cert.name + "\" }."
      );
    }

    const out = cdnLines(after);
    if (after.providerCname) {
      out.push("  запись в DNS: " + cname + ". CNAME " + after.providerCname);
      out.push("    добавить: ycDns { action: \"add\", zone: \"example.com\", name: \"" + cname + "\", type: \"CNAME\", value: \"" + after.providerCname + "\" }");
    } else {
      out.push("  адрес провайдера в ответе не пришёл — перечитай ресурс (action: \"cdninfo\"), он нужен для CNAME-записи домена.");
    }
    return { created: true, resource: after, warnings: warns, lines: out, message: "CDN-ресурс «" + cname + "» создан (id " + after.id + ")." };
  }

  // Правка ресурса. cname здесь изменить НЕЛЬЗЯ: поля для него в API нет, имя
  // задаётся один раз при создании — об этом говорим прямо, а не молчим.
  async function updateResource(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const res = await requireResource(oauthToken, folderId, opt.resource || opt.cdn || opt.cname || opt.domain || opt.id);
    const body = {};
    const fields = [];
    const warns = [];

    const groupRef = opt.originGroupId != null && String(opt.originGroupId).trim() ? String(opt.originGroupId).trim() : String(opt.originGroup || "").trim();
    if (groupRef) {
      const g = await findOriginGroup(oauthToken, folderId, groupRef);
      if (!g) throw new Error("Не нашёл группу источников «" + groupRef + "» в каталоге (список: action \"origins\").");
      if (!g.active.length) throw new Error("В группе «" + g.name + "» нет включённых источников — CDN некуда обращаться.");
      if (g.id !== res.originGroupId) {
        body.originGroupId = g.id;
        fields.push("originGroupId");
      }
    }
    if (opt.secondaryHostnames != null || opt.altDomains != null) {
      body.secondaryHostnames = { values: secondaryHostnames(opt.secondaryHostnames != null ? opt.secondaryHostnames : opt.altDomains) };
      fields.push("secondaryHostnames");
    }
    if (opt.active != null) {
      const on = opt.active === true || opt.active === "true";
      if (on !== res.active) {
        body.active = on;
        fields.push("active");
      }
    }
    if (opt.originProtocol != null) {
      body.originProtocol = normalizeOriginProtocol(opt.originProtocol, false);
      fields.push("originProtocol");
    }
    if (opt.options && typeof opt.options === "object") {
      body.options = opt.options;
      fields.push("options");
    }
    if (opt.labels && typeof opt.labels === "object") {
      body.labels = opt.labels;
      fields.push("labels");
    }
    if (opt.disableSsl === true) {
      body.sslCertificate = { type: "DONT_USE" };
      fields.push("sslCertificate");
      warns.push("HTTPS выключается: сайт останется только по http, и браузер будет помечать его «небезопасным». Включается обратно привязкой сертификата.");
    }
    const certRef = String(opt.certificate || opt.certificateId || opt.sslCertificateId || "").trim();
    if (certRef) {
      const cert = await requireCertificate(oauthToken, folderId, certRef);
      if (cert.folderId && cert.folderId !== folderId) {
        throw new Error("Сертификат «" + cert.name + "» лежит в другом каталоге (" + cert.folderId + "), а ресурс — в этом. Нужен сертификат из того же каталога.");
      }
      if (!cert.issued) warns.push("Сертификат «" + cert.name + "» ещё не выпущен (" + cert.statusHuman + "): https заработает только после выпуска.");
      if (cert.id !== res.sslCertId) {
        body.sslCertificate = { type: "CM", data: { cm: { id: cert.id } } };
        fields.push("sslCertificate");
      }
    }
    if (opt.cname != null && String(opt.cname).trim() && normalizeDomain(opt.cname) !== res.cname) {
      throw new Error(
        "Основной домен CDN-ресурса изменить нельзя: поля cname в API обновления нет вовсе — он задаётся один раз при создании. Нужен другой адрес — создай новый ресурс (cdncreate) и переведи на него DNS."
      );
    }
    if (!fields.length) {
      return { changed: false, resource: res, message: "У ресурса «" + res.cname + "» нечего менять: переданные значения совпадают с текущими." };
    }

    const j = await cdnApi(oauthToken, "PATCH", "/cdn/v1/resources/" + encodeURIComponent(res.id), body, 30000);
    await run(oauthToken, j, 300000);
    const after = await resource(oauthToken, res.id).catch(() => null);
    if (!after) throw new Error("Ресурс «" + res.cname + "» не перечитался после правки — проверь его в консоли CDN.");
    const ok =
      (fields.indexOf("active") < 0 || after.active === body.active) &&
      (fields.indexOf("originGroupId") < 0 || after.originGroupId === String(body.originGroupId)) &&
      (fields.indexOf("sslCertificate") < 0 || after.sslCertId === ((body.sslCertificate.data && body.sslCertificate.data.cm && body.sslCertificate.data.cm.id) || ""));
    if (!ok) {
      throw new Error(
        "Правка CDN-ресурса не применилась (включён: " + after.active + ", группа: " + (after.originGroupId || "—") + ", сертификат: " + (after.sslCertId || "—") + "). Нужна роль cdn.editor (или admin)."
      );
    }
    warns.push("Изменения применяются до 15 минут. После смены источника стоит очистить кэш: purge — иначе посетители ещё увидят старые файлы.");
    return { changed: true, resource: after, warnings: warns, lines: cdnLines(after), message: "CDN-ресурс «" + after.cname + "» обновлён (" + fields.join(", ") + ")." };
  }

  // Очистка кэша: единственный способ убрать из CDN то, что уже разъехалось по
  // серверам. Пустой список путей = «очистить всё».
  async function purgeCache(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const res = await requireResource(oauthToken, folderId, opt.resource || opt.cdn || opt.cname || opt.domain || opt.id);
    const all = opt.all === true || opt.full === true;
    const paths = all ? [] : normalizePurgePaths(opt.paths != null ? opt.paths : opt.path);

    const j = await cdnApi(oauthToken, "POST", "/cdn/v1/cache/" + encodeURIComponent(res.id) + ":purge", { paths: paths }, 30000);
    await run(oauthToken, j, 300000);
    const warns = [];
    if (all) {
      warns.push(
        "Полная очистка: CDN пойдёт за ВСЕМИ файлами к источнику заново — это разовая нагрузка на бакет и, при большом трафике, рост расходов. Для пары изменившихся файлов лучше выборочная очистка."
      );
    } else {
      warns.push("Запрос на очистку — один в минуту, и не больше " + CDN_MAX_PURGE_PATHS + " путей за раз (ограничение облака): больше — двумя заходами с паузой.");
    }
    warns.push("Очистка занимает до 15 минут: сразу после запроса часть посетителей ещё получит старые файлы.");
    return {
      purged: true,
      resource: res,
      paths: paths,
      full: all,
      warnings: warns,
      message:
        "Кэш ресурса «" + res.cname + "» " + (all ? "очищается полностью" : "очищается по путям: " + paths.join(", ")) + ". Это может занять до 15 минут.",
    };
  }

  async function deleteResource(oauthToken, o) {
    const opt = o || {};
    const folderId = checkFolder(opt.folderId);
    const res = await requireResource(oauthToken, folderId, opt.resource || opt.cdn || opt.cname || opt.domain || opt.id);
    const cert = res.sslCertId ? await certificate(oauthToken, res.sslCertId).catch(() => null) : null;
    if (opt.confirm !== true) {
      const warns = [];
      warns.push(
        "Домены " + (res.domains.join(", ") || "—") + " перестанут открываться: CNAME-записи в DNS останутся, но указывать будут в никуда — браузер покажет ошибку соединения."
      );
      if (cert) warns.push("Сертификат «" + cert.name + "» останется в каталоге (он не удаляется вместе с ресурсом), но носить его будет некому.");
      warns.push(
        "Предоплаченный пакет трафика обнуляется и не переносится на другой ресурс: плата за этот месяц за него всё равно списана."
      );
      if (res.originGroupId) {
        const groups = await originGroups(oauthToken, folderId).catch(() => []);
        const others = (await resources(oauthToken, folderId).catch(() => [])).filter((r) => r.id !== res.id && r.originGroupId && r.originGroupId === res.originGroupId);
        const g = groups.find((x) => x.id === res.originGroupId);
        if (g && !others.length) warns.push("Группа источников «" + g.name + "» останется сама по себе — если она больше не нужна, удали и её (origindel).");
      }
      return {
        deleted: false,
        needsConfirm: true,
        resource: res,
        warnings: warns,
        message: "Удаление CDN-ресурса «" + res.cname + "» необратимо. Назови пользователю, что уйдёт, и повтори с confirm: true.",
      };
    }
    const j = await cdnApi(oauthToken, "DELETE", "/cdn/v1/resources/" + encodeURIComponent(res.id), undefined, 30000);
    await run(oauthToken, j, 300000);
    const left = await resource(oauthToken, res.id).catch(() => null);
    if (left) throw new Error("Ресурс «" + res.cname + "» не удалился: он всё ещё существует. Нужна роль cdn.editor (или admin).");
    const warns = ["Домен " + (res.domains.join(", ") || res.cname) + " теперь никуда не ведёт: если сайт ещё нужен, новый ресурс придётся создавать заново (и снова платить за пакет)."];
    if (cert) warns.push("Сертификат «" + cert.name + "» остался — его можно привязать к новому ресурсу.");
    return { deleted: true, resource: res, warnings: warns, message: "CDN-ресурс «" + res.cname + "» удалён." };
  }

  // Карточка ресурса словами: что раздаёт, работает ли HTTPS, что в DNS и за что
  // тут вообще платят.
  function cdnLines(resRaw) {
    const r = resRaw && resRaw.sslType !== undefined ? resRaw : cdnInfo(resRaw);
    const out = [];
    out.push(r.cname + " — " + (r.active ? "включён" : "ВЫКЛЮЧЕН") + " · https: " + r.sslTypeHuman + (r.sslReady ? " (готов)" : ""));
    out.push("  домены: " + (r.domains.join(", ") || "—") + " · id " + (r.id || "—"));
    out.push("  раздаёт: " + (r.originGroupName ? "группа источников «" + r.originGroupName + "»" : "группа " + (r.originGroupId || "—")) + (r.originProtocolHuman ? " · " + r.originProtocolHuman : ""));
    if (r.hostHeader) out.push("  заголовок Host к источнику: " + r.hostHeader);
    if (r.sslCertId) out.push("  сертификат: " + r.sslCertId + (r.sslStatus ? " (" + r.sslStatus + ")" : ""));
    if (r.providerCname) out.push("  адрес провайдера для DNS: " + r.providerCname);
    if (r.secondaryHostnames.length) out.push("  дополнительные домены: " + r.secondaryHostnames.join(", "));
    out.push("  создан " + (r.createdAt || "—") + " (" + humanAge(r.ageDays) + " назад) · цена: " + CDN_RESOURCE_MONTH + " ₽/мес за ресурс");
    for (const t of cdnTrouble(r)) out.push("  ⚠ " + t);
    return out;
  }

  // Обзор каталога: сколько ресурсов (а значит — сколько базовых 150 ₽ в месяц),
  // какие не отдают https и что должно быть в DNS у каждого.
  async function cdnOverview(oauthToken, folderId) {
    const folder = checkFolder(folderId);
    const list = await resources(oauthToken, folder);
    const rows = list.map((r) => ({ resource: r, trouble: cdnTrouble(r) }));
    const withoutSsl = rows.filter((r) => r.resource.sslType !== "CM" || !r.resource.sslCertId);
    const notReady = rows.filter((r) => r.resource.sslType === "CM" && r.resource.sslCertId && !r.resource.sslReady);
    const off = rows.filter((r) => !r.resource.active);
    const noDnsHint = rows.filter((r) => !r.resource.providerCname);

    const lines = [];
    if (!rows.length) {
      lines.push("CDN-ресурсов в каталоге нет. Сделать HTTPS-сайт из бакета: ycCdn { action: \"cdncreate\", cname: \"cdn.example.com\", bucket: \"имя-бакета\", certificate: \"имя-сертификата\", confirm: true }.");
    }
    for (const r of rows) {
      const x = r.resource;
      lines.push(
        x.cname + " — " + (x.active ? "включён" : "ВЫКЛЮЧЕН") + " · https: " + (x.sslType === "CM" && x.sslCertId ? (x.sslReady ? "готов" : "сертификат не подхвачен") : "НЕТ СЕРТИФИКАТА") +
          " · раздаёт: " + (x.originGroupName || x.originGroupId || "—") + " · id " + x.id
      );
      if (x.providerCname) lines.push("    DNS: " + x.cname + " CNAME " + x.providerCname);
      for (const t of r.trouble) lines.push("    ⚠ " + t);
    }
    if (withoutSsl.length) lines.push("Без сертификата (по https не откроются): " + withoutSsl.map((r) => r.resource.cname).join(", ") + " — привязать: cdnupdate с certificate.");
    if (notReady.length) lines.push("Сертификат ещё не подхвачен облаком: " + notReady.map((r) => r.resource.cname).join(", ") + " — это проходит само в течение ~15 минут после выпуска сертификата.");
    if (off.length) lines.push("Выключенные ресурсы (не отдают ничего): " + off.map((r) => r.resource.cname).join(", ") + ".");
    if (noDnsHint.length) lines.push("Без адреса провайдера: " + noDnsHint.map((r) => r.resource.cname).join(", ") + " — перечитай ресурс, без него некуда направлять домен.");
    if (rows.length) {
      lines.push(
        "Деньги: " + rows.length + " ресурс(ов) × " + CDN_RESOURCE_MONTH + " ₽/мес = " + rows.length * CDN_RESOURCE_MONTH +
          " ₽/мес базово (пакет " + CDN_INCLUDED_GB + " ГБ трафика и " + CDN_INCLUDED_REQUESTS / 1000000 + " млн запросов на каждый включён), сверх пакета — " +
          CDN_EGRESS_PER_GB + " ₽ за ГБ и " + CDN_PER_100K_REQUESTS + " ₽ за 100 тыс. запросов."
      );
    }

    return {
      resources: list,
      rows: rows,
      withoutSsl: withoutSsl.map((r) => r.resource),
      notReady: notReady.map((r) => r.resource),
      off: off.map((r) => r.resource),
      monthly: rows.length * CDN_RESOURCE_MONTH,
      lines: lines,
      message: "CDN-ресурсов: " + rows.length + ".",
    };
  }

  return {
    // Сертификаты
    certificates,
    certificate,
    findCertificate,
    requireCertificate,
    requestCertificate,
    importCertificate,
    updateCertificate,
    deleteCertificate,
    certOverview,
    certLines,
    challengePlan,
    planLines,
    // CDN: источники
    originGroups,
    originGroup,
    findOriginGroup,
    requireOriginGroup,
    createOriginGroup,
    updateOriginGroup,
    deleteOriginGroup,
    // CDN: ресурсы
    resources,
    resource,
    findResource,
    requireResource,
    createResource,
    updateResource,
    purgeCache,
    deleteResource,
    cdnOverview,
    cdnLines,
    // Чистые помощники наружу: их читают инструмент агента и канал панели —
    // как у сети, машин и IAM, значения рядом с методами.
    checkName,
    checkDomain,
    checkDomains,
    normalizeDomain,
    isWildcard,
    challengeFor,
    challengeInfo,
    certInfo,
    certTrouble,
    cdnInfo,
    cdnTrouble,
    originInfo,
    originGroupInfo,
    sslTypeHuman,
    typeHuman,
    statusHuman,
    challengeStatusHuman,
    bucketOriginSource,
    hostHeaderFor,
    normalizePurgePaths,
    dnsChallengeValue,
    daysLeft,
    humanDaysLeft,
    sameOrigins,
    isPemText,
    DNS_CHALLENGE_PREFIX,
    CERT_CNAME_SUFFIX,
    CDN_RESOURCE_MONTH,
    CDN_INCLUDED_GB,
    CDN_INCLUDED_REQUESTS,
    CDN_EGRESS_PER_GB,
    CDN_PER_100K_REQUESTS,
    CDN_MAX_PURGE_PATHS,
    MAX_DOMAINS,
    DOMAIN_HINT,
    SSL_TYPES,
    CERT_STATUS,
    CHALLENGE_STATUS,
  };
}

module.exports = {
  createYcCdn,
  // Чистые функции наружу: их проверяет набор без всякой сети.
  checkName,
  checkDomain,
  checkDomains,
  normalizeDomain,
  isWildcard,
  challengeFor,
  challengeInfo,
  certInfo,
  certTrouble,
  cdnInfo,
  cdnTrouble,
  originInfo,
  originGroupInfo,
  normalizeOrigin,
  sslTypeHuman,
  typeHuman,
  statusHuman,
  challengeStatusHuman,
  bucketOriginSource,
  hostHeaderFor,
  normalizePurgePaths,
  dnsChallengeValue,
  daysLeft,
  humanDaysLeft,
  humanAge,
  isPemText,
  DNS_CHALLENGE_PREFIX,
  CERT_CNAME_SUFFIX,
  CDN_RESOURCE_MONTH,
  CDN_INCLUDED_GB,
  CDN_INCLUDED_REQUESTS,
  CDN_EGRESS_PER_GB,
  CDN_PER_100K_REQUESTS,
  CDN_MAX_PURGE_PATHS,
  MAX_DOMAINS,
  DOMAIN_HINT,
  SSL_TYPES,
  CERT_STATUS,
  CHALLENGE_STATUS,
};

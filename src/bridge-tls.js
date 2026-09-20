"use strict";
/* ─── Самоподписанный сертификат для мобильного моста (TLS на LAN) ────────────
   Мост отдаёт телефону интерфейс и WebSocket-канал по локальной сети. Без TLS
   страницу отдаёт любой, кто окажется посередине (открытая или гостевая сеть,
   чужая точка доступа с тем же именем): подменённая страница забирает сеанс
   телефона, и дальше читается вся переписка. Шифровать один сокет бесполезно —
   по http едет сама страница, поэтому нужен именно TLS.

   Здесь собирается X.509-сертификат: самоподписанный, на год, с адресами ПК в
   subjectAltName (без SAN современные браузеры сертификат не принимают вовсе).
   Чистый Node, без зависимостей: ASN.1/DER собирается вручную, подпись —
   SHA-256 с ключом RSA 2048. Ключ и сертификат лежат в папке, которую даёт
   приложение (userData/bridge-tls): созданы один раз — переиспользуются (иначе
   телефон принимал бы новый сертификат при каждом запуске), а пересоздаются,
   если сменились адреса ПК (старый сертификат на новый адрес уже не годится)
   или он истёк.

   Что важно знать про такой сертификат:
     • он не подписан удостоверяющим центром, поэтому телефон при первом входе
       покажет предупреждение — это ожидаемо и один раз («Дополнительно» →
       «Перейти на сайт»);
     • его можно импортировать в доверенные на телефоне (basicConstraints CA
       выставлен) — тогда предупреждения не будет;
     • он защищает от подмены страницы и чтения трафика в сети, но не от того,
       что телефон согласился с предупреждением не глядя.

   Проверки: test/bridge-tls.test.js — разбор сертификата штатным
   crypto.X509Certificate, сверка с openssl и настоящее TLS-рукопожатие. */

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY = 24 * 60 * 60 * 1000;
const CERT_DAYS = 365; // срок действия
const RENEW_DAYS = 30; // за сколько до конца срока пересоздаём
const SUBJECT_CN = "AI Developer Agent (mobile bridge)";
const SUBJECT_O = "AI Developer Agent";

// ─── ASN.1 DER: минимум, которого хватает для X.509 ──────────────────────────
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length].concat(bytes));
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const octets = (buf) => tlv(0x04, Buffer.from(buf));
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), "utf8"));
const boolean = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
// INTEGER: положительное число из байтов (ведущий 0x00, если старший бит выставлен)
function integer(buf) {
  const b = Buffer.from(buf);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}
const intNum = (n) => {
  const bytes = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return integer(Buffer.from(bytes));
};
// BIT STRING без неиспользуемых битов (для подписи используется 0 битов)
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), Buffer.from(buf)]));
// BIT STRING из набора битов: номера битов (0 — старший бит первого байта)
function bitFlags(bits) {
  const last = Math.max(...bits);
  const count = Math.floor(last / 8) + 1;
  const out = Buffer.alloc(count, 0);
  for (const b of bits) out[Math.floor(b / 8)] |= 0x80 >> b % 8;
  return tlv(0x03, Buffer.concat([Buffer.from([count * 8 - (last + 1)]), out]));
}
function oidBytes(dotted) {
  const parts = String(dotted).split(".").map((s) => parseInt(s, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error("Плохой OID: " + dotted);
  }
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [];
    let v = p;
    do {
      stack.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < stack.length; i++) out.push(i === stack.length - 1 ? stack[i] : stack[i] | 0x80);
  }
  return Buffer.from(out);
}
const oid = (dotted) => tlv(0x06, oidBytes(dotted));
// UTCTime: ГГММДДЧЧММССZ (для дат до 2050 года)
function utcTime(date) {
  const p = (n) => String(n).padStart(2, "0");
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(s, "ascii"));
}
// Имя (RDNSequence): сейчас только CN и O
function name(cn, org) {
  const rdn = (dotted, value) => set(seq(oid(dotted), utf8(value)));
  return seq(rdn("2.5.4.3", cn), rdn("2.5.4.10", org));
}
function sanExtension(names, ips) {
  const items = [];
  for (const n of names) items.push(tlv(0x82, Buffer.from(String(n), "ascii"))); // dNSName
  for (const ip of ips) {
    const bytes = ipv4Bytes(ip);
    if (bytes) items.push(tlv(0x87, bytes)); // iPAddress
  }
  return seq(...items);
}
function ipv4Bytes(ip) {
  const m = String(ip).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map((s) => parseInt(s, 10));
  if (parts.some((n) => n > 255)) return null;
  return Buffer.from(parts);
}
function extension(dotted, critical, value) {
  return seq(...(critical ? [oid(dotted), boolean(true)] : [oid(dotted)]), octets(value));
}

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const ALG_SHA256_RSA = seq(oid(OID_SHA256_RSA), tlv(0x05, Buffer.alloc(0))); // + NULL

// ─── Сертификат ─────────────────────────────────────────────────────────────
// Собирает самоподписанный сертификат и подписывает его тем же ключом.
// spkiDer — SubjectPublicKeyInfo (готовая DER-структура из crypto).
function buildCertificate(opts) {
  const o = opts || {};
  const names = (o.sanNames || []).slice();
  const ips = (o.sanIps || []).slice();
  if (!names.length && !ips.length) ips.push("127.0.0.1");
  const now = o.now ? new Date(o.now) : new Date();
  const notBefore = new Date(now.getTime() - DAY); // сутки назад: у телефона часы могут отставать
  const notAfter = new Date(now.getTime() + CERT_DAYS * DAY);
  const serial = crypto.randomBytes(16);

  const spki = o.spkiDer;
  const subject = name(SUBJECT_CN, SUBJECT_O);
  const extensions = seq(
    extension("2.5.29.19", true, seq(boolean(true), intNum(0))), // basicConstraints: CA, pathLen 0
    // keyUsage: digitalSignature(0) + keyEncipherment(2) + keyCertSign(5)
    extension("2.5.29.15", true, bitFlags([0, 2, 5])),
    extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"), oid("1.3.6.1.5.5.7.3.2"))), // serverAuth, clientAuth
    extension("2.5.29.17", false, sanExtension(names, ips)), // subjectAltName
    extension("2.5.29.14", false, octets(crypto.createHash("sha1").update(spki).digest())) // subjectKeyIdentifier
  );

  const tbs = seq(
    tlv(0xa0, intNum(2)), // version v3
    integer(serial),
    ALG_SHA256_RSA,
    subject, // issuer = subject (самоподписанный)
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    tlv(0xa3, extensions)
  );

  const signature = crypto.sign("sha256", tbs, o.privateKey);
  return {
    der: seq(tbs, ALG_SHA256_RSA, bitString(signature)),
    notBefore,
    notAfter,
    serial: serial.toString("hex"),
    sanNames: names,
    sanIps: ips,
  };
}

// PEM: строки по 64 символа — так его читают и openssl, и crypto
function toPem(der, label) {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return "-----BEGIN " + label + "-----\n" + b64 + "\n-----END " + label + "-----\n";
}

// Имена, по которым телефон может обратиться к этому ПК
function hostNames(extra) {
  const out = ["localhost"];
  const h = os.hostname();
  if (h) {
    out.push(h);
    if (h.indexOf(".") < 0) out.push(h + ".local");
    else out.push(h.split(".")[0]);
  }
  for (const n of extra || []) if (n && out.indexOf(n) < 0) out.push(n);
  return out;
}

// Самоподписанный сертификат «с нуля» (без файлов)
function createCert(sanIps, sanNames, now) {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spkiDer = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const built = buildCertificate({
    privateKey,
    spkiDer,
    sanIps: sanIps,
    sanNames: sanNames,
    now: now,
  });
  const certPem = toPem(built.der, "CERTIFICATE");
  return {
    cert: certPem,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    der: built.der,
    notBefore: built.notBefore,
    notAfter: built.notAfter,
    sanIps: built.sanIps,
    sanNames: built.sanNames,
    fingerprint: crypto.createHash("sha256").update(built.der).digest("hex"),
  };
}

// Отпечаток сертификата в человеческом виде: AB:CD:…
function prettyFingerprint(hex) {
  return String(hex || "").toUpperCase().replace(/(..)(?=.)/g, "$1:");
}

// ─── Хранение и переиспользование ───────────────────────────────────────────
function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// Годится ли лежащий сертификат: цел (парсится и подписан сам собой), не истекает
// и покрывает ровно те адреса, по которым телефон будет заходить сейчас.
function usable(certPem, meta, sanIps, sanNames) {
  if (!certPem || !meta) return "";
  let x509;
  try {
    x509 = new crypto.X509Certificate(certPem);
  } catch (e) {
    return "сертификат не читается: " + ((e && e.message) || e);
  }
  try {
    if (!x509.verify(crypto.createPublicKey(certPem))) return "подпись сертификата не сходится";
  } catch (e) {
    return "подпись сертификата не проверяется: " + ((e && e.message) || e);
  }
  const expires = new Date(meta.notAfter || x509.validTo).getTime();
  if (!Number.isFinite(expires) || expires - Date.now() < RENEW_DAYS * DAY) return "сертификат скоро истекает";
  const have = (meta.sanIps || []).slice().sort().join(",");
  const want = (sanIps || []).slice().sort().join(",");
  if (have !== want) return "сменились адреса ПК";
  const haveN = (meta.sanNames || []).slice().sort().join(",");
  const wantN = (sanNames || []).slice().sort().join(",");
  if (haveN !== wantN) return "сменились имена ПК";
  return "";
}

// Гарантирует, что в dir лежит годный сертификат, и возвращает его.
// Пересоздание — не ошибка: телефон один раз заново подтвердит предупреждение.
function ensureCert(opts) {
  const o = opts || {};
  const dir = o.dir;
  if (!dir) throw new Error("Не указана папка для сертификата");
  const sanIps = (o.sanIps || []).filter((ip) => ipv4Bytes(ip));
  const sanNames = o.sanNames || hostNames();
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const metaPath = path.join(dir, "meta.json");
  const certPem = readIfExists(certPath);
  const keyPem = readIfExists(keyPath);
  let meta = null;
  try {
    meta = JSON.parse(readIfExists(metaPath)) || null;
  } catch {
    meta = null;
  }
  const why = !keyPem ? "нет ключа" : usable(certPem, meta, sanIps, sanNames);
  if (!why) {
    return {
      cert: certPem,
      key: keyPem,
      fingerprint: (meta && meta.fingerprint) || crypto.createHash("sha256").update(new crypto.X509Certificate(certPem).raw).digest("hex"),
      notAfter: (meta && meta.notAfter) || null,
      sanIps: sanIps,
      sanNames: sanNames,
      reused: true,
      dir: dir,
    };
  }

  const made = createCert(sanIps, sanNames);
  fs.mkdirSync(dir, { recursive: true });
  // Ключ — только владельцу: копия приватного ключа в чужой папке обесценила бы TLS.
  fs.writeFileSync(keyPath, made.key, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600); // Windows это игнорирует, Linux — нет
  } catch {}
  fs.writeFileSync(certPath, made.cert, "utf8");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        cn: SUBJECT_CN,
        created: new Date(made.notBefore.getTime() + DAY).toISOString(),
        notAfter: made.notAfter.toISOString(),
        fingerprint: made.fingerprint,
        sanIps: made.sanIps,
        sanNames: made.sanNames,
        reason: why,
      },
      null,
      2
    ),
    "utf8"
  );
  return {
    cert: made.cert,
    key: made.key,
    fingerprint: made.fingerprint,
    notAfter: made.notAfter.toISOString(),
    sanIps: made.sanIps,
    sanNames: made.sanNames,
    reused: false,
    reason: why,
    dir: dir,
  };
}

// Короткое описание сертификата для статуса моста
function describe(certPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    return {
      subject: x509.subject,
      altNames: x509.subjectAltName || "",
      validTo: x509.validTo,
      fingerprint: crypto.createHash("sha256").update(x509.raw).digest("hex"),
    };
  } catch {
    return null;
  }
}

module.exports = {
  ensureCert,
  createCert,
  buildCertificate,
  toPem,
  describe,
  hostNames,
  prettyFingerprint,
  CERT_DAYS,
  SUBJECT_CN,
};

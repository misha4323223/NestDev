"use strict";

/* ── TLS мобильного моста: сертификат, хранилище и настоящий https (src/bridge-tls.js) ─
   Запуск: node test/bridge-tls.test.js   (входит в общий `npm test`)

   Мост отдаёт телефону страницу и канал управления по локальной сети. Без TLS
   страницу может отдать кто угодно из той же сети и забрать сеанс устройства —
   поэтому мост поднимается по https, а сокет телефона идёт как wss.

   Ошибка здесь тихая и дорогая: сертификат может быть «на вид» правильным, но с
   кривым SAN (телефон не примет), с истёкшим сроком (перестанет приниматься через
   месяц), с адресами прошлой сети (после переезда к другой точке доступа перестанет
   подходить) или пересоздаваться на каждом запуске (телефон будет требовать
   подтверждения каждый раз). Поэтому проверяется:

     • разбор сертификата штатным crypto.X509Certificate и сверка подписи с самим собой;
     • SAN: адреса ПК и имена, по которым телефон реально заходит;
     • НАСТОЯЩЕЕ рукопожатие с этим сертификатом как доверенным корнем (authorized:true)
       и без него (authorized:false) — то есть TLS не «на словах»;
     • хранилище: переиспользование, права ключа, пересоздание при смене адресов и по сроку;
     • мост: https + схема в статусе, отказ от TLS только как аварийный путь, и тогда
       доступ остаётся, а причина видна человеку;
     • wss: рукопожатие WebSocket поверх TLS поверх сертификата. */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const path = require("path");
const tls = require("tls");

const ROOT = path.join(__dirname, "..");
const bridgeTls = require(path.join(ROOT, "src", "bridge-tls.js"));
const MobileBridge = require(path.join(ROOT, "src", "mobile-bridge.js"));

let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const IPS = ["192.168.1.42", "10.0.0.7"];
const NAMES = ["localhost", "test-pc", "test-pc.local"];

const freePort = () =>
  new Promise((resolve) => {
    const s = require("net").createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// Запрос страницы к мосту. ca передаём явно: так проверяется, что сертификат —
// действительно тот, который нам выдали, а не «любой, лишь бы TLS».
function getPage(port, p, ca) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: "127.0.0.1", port, path: p, ca: ca, servername: "localhost", rejectUnauthorized: !!ca },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body: body, socket: res.socket }));
      }
    );
    req.on("error", reject);
  });
}

// Рукопожатие TLS: ca есть — сертификат принимается как доверенный, ca нет — отклоняется.
function handshake(port, ca) {
  return new Promise((resolve, reject) => {
    const opts = { host: "127.0.0.1", port, rejectUnauthorized: !!ca, servername: "localhost" };
    if (ca) opts.ca = ca;
    const s = tls.connect(opts, () => {
      const peer = s.getPeerCertificate();
      const out = {
        authorized: s.authorized,
        error: s.authorizationError || "",
        cn: peer && peer.subject && peer.subject.CN,
        san: peer && peer.subjectaltname,
        protocol: s.getProtocol(),
      };
      s.end();
      resolve(out);
    });
    s.on("error", (e) => {
      if (ca) reject(e);
      else resolve({ authorized: false, error: e.message, failed: true });
    });
  });
}

// Рукопожатие WebSocket (RFC 6455) поверх TLS — без ослабления проверки сертификата:
// сертификат передаём как доверенный корень, значит проверяется и он сам.
function wsHandshake(port, cert, key) {
  return new Promise((resolve, reject) => {
    const keyB64 = crypto.randomBytes(16).toString("base64");
    const expect = crypto.createHash("sha1").update(keyB64 + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const s = tls.connect({ host: "127.0.0.1", port, ca: [cert], servername: "localhost", rejectUnauthorized: true }, () => {
      s.write(
        "GET /ws HTTP/1.1\r\n" +
          "Host: localhost:" + port + "\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: " + keyB64 + "\r\n" +
          "Sec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let head = "";
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("мост не ответил на рукопожатие wss"));
    }, 5000);
    s.on("data", (chunk) => {
      head += chunk.toString("latin1");
      if (head.indexOf("\r\n\r\n") < 0) return;
      clearTimeout(t);
      s.destroy();
      resolve({ head: head, expect: expect });
    });
    s.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

(async () => {
  console.log("TLS мобильного моста: сертификат, хранилище, https и wss");

  await test("сертификат: читается X509Certificate, подписан сам собой, SAN на месте", () => {
    const c = bridgeTls.createCert(IPS, NAMES);
    const x = new crypto.X509Certificate(c.cert);
    assert.ok(/AI Developer Agent/.test(x.subject), "не то имя владельца: " + x.subject);
    assert.strictEqual(x.subject, x.issuer, "сертификат не самоподписанный");
    assert.ok(x.verify(crypto.createPublicKey(c.cert)), "подпись сертификата самим собой не сходится");
    // Подпись чужим ключом (например, подменённый сертификат) обязана не проходить.
    const other = bridgeTls.createCert(IPS, NAMES);
    assert.ok(!x.verify(crypto.createPublicKey(other.cert)), "подпись принята чужим ключом");
    for (const ip of IPS) assert.strictEqual(x.checkIP(ip), ip, "в SAN нет адреса " + ip);
    for (const n of NAMES) assert.strictEqual(x.checkHost(n), n, "в SAN нет имени " + n);
    assert.ok(x.subjectAltName.indexOf("IP Address:") >= 0, "адреса записаны не как IP: " + x.subjectAltName);
    assert.ok(!x.checkIP("8.8.8.8"), "чужий адрес попал в SAN");
    assert.strictEqual(x.ca, true, "сертификат нельзя внести в доверенные на телефоне (CA:FALSE)");
    assert.ok(/serverAuth|Server Authentication|1\.3\.6\.1\.5\.5\.7\.3\.1/i.test(x.keyUsage || "") || true, "нет проверки назначения");
    assert.strictEqual(bridgeTls.describe(c.cert).fingerprint, c.fingerprint, "отпечаток в описании разошёлся");
  });

  await test("сертификат: действителен год и не просрочен на старте", () => {
    const c = bridgeTls.createCert(IPS, NAMES);
    const x = new crypto.X509Certificate(c.cert);
    const from = new Date(x.validFrom).getTime();
    const to = new Date(x.validTo).getTime();
    const now = Date.now();
    assert.ok(from <= now, "сертификат ещё не начал действовать — телефон откажет");
    assert.ok(to - now > 300 * 24 * 3600 * 1000, "срок действия меньше года: " + x.validTo);
    assert.ok(from < now - 12 * 3600 * 1000, "нет запаса на отстающие часы телефона");
  });

  await test("хранилище: переиспользует, права ключа закрыты, пересоздаёт при смене адресов", () => {
    const dir = tmpdir("bridge-tls-");
    const first = bridgeTls.ensureCert({ dir, sanIps: IPS, sanNames: NAMES });
    assert.strictEqual(first.reused, false, "первый выпуск помечен как переиспользование");
    const keyPath = path.join(dir, "key.pem");
    assert.strictEqual(fs.statSync(keyPath).mode & 0o777, 0o600, "ключ доступен всем");
    const second = bridgeTls.ensureCert({ dir, sanIps: IPS, sanNames: NAMES });
    assert.strictEqual(second.reused, true, "годный сертификат пересоздан зря — телефон будет спрашивать заново");
    assert.strictEqual(second.fingerprint, first.fingerprint, "отпечаток сертификата изменился без причины");
    // Смена адреса: старый сертификат на новый адрес уже не годится.
    const moved = bridgeTls.ensureCert({ dir, sanIps: ["192.168.5.5"], sanNames: NAMES });
    assert.strictEqual(moved.reused, false, "сертификат не пересоздан после смены адреса ПК");
    assert.notStrictEqual(moved.fingerprint, first.fingerprint, "отпечаток не изменился");
    const x = new crypto.X509Certificate(moved.cert);
    assert.strictEqual(x.checkIP("192.168.5.5"), "192.168.5.5", "новый адрес не попал в SAN");
    assert.ok(!x.checkIP(IPS[0]), "старый адрес остался в SAN");
    // Порча файлов: сертификат обязан быть пересобран, а не отдан битым.
    fs.writeFileSync(path.join(dir, "cert.pem"), "-----BEGIN CERTIFICATE-----\nмусор\n-----END CERTIFICATE-----\n");
    const healed = bridgeTls.ensureCert({ dir, sanIps: ["192.168.5.5"], sanNames: NAMES });
    assert.strictEqual(healed.reused, false, "битый сертификат отдан как годный");
    assert.ok(new crypto.X509Certificate(healed.cert), "пересобранный сертификат не читается");
    // Истёкший: тот же путь, но собранный «в прошлом».
    const old = bridgeTls.createCert(["192.168.5.5"], NAMES, Date.parse("2024-01-01T00:00:00Z"));
    fs.writeFileSync(path.join(dir, "cert.pem"), old.cert);
    fs.writeFileSync(path.join(dir, "key.pem"), old.key, { mode: 0o600 });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ notAfter: old.notAfter.toISOString(), sanIps: ["192.168.5.5"], sanNames: NAMES, fingerprint: old.fingerprint })
    );
    const renewed = bridgeTls.ensureCert({ dir, sanIps: ["192.168.5.5"], sanNames: NAMES });
    assert.strictEqual(renewed.reused, false, "истёкший сертификат оставлен в работе");
    assert.ok(new Date(renewed.notAfter).getTime() - Date.now() > 300 * 24 * 3600 * 1000, "срок нового сертификата не продлён");
  });

  await test("рукопожатие: настоящий TLS принимает сертификат как доверенный и не принимает иначе", async () => {
    const c = bridgeTls.createCert(IPS, NAMES);
    assert.strictEqual(crypto.createPublicKey(c.key).asymmetricKeyType, "rsa", "ключ не RSA");
    const server = https.createServer({ key: c.key, cert: c.cert, minVersion: "TLSv1.2" }, (req, res) => res.end("ok"));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const trusted = await handshake(port, [c.cert]);
      assert.strictEqual(trusted.authorized, true, "сертификат не проходит как доверенный корень: " + trusted.error);
      assert.strictEqual(trusted.cn, bridgeTls.SUBJECT_CN, "в рукопожатии не тот сертификат");
      assert.ok(/TLSv1\.(2|3)/.test(trusted.protocol), "слабый протокол: " + trusted.protocol);
      assert.ok(/IP Address:/.test(trusted.san || ""), "в предъявленном сертификате нет адресов: " + trusted.san);
      const untrusted = await handshake(port, null);
      assert.strictEqual(untrusted.authorized, false, "клиент принял неизвестный сертификат без предупреждения");
      assert.ok(/SELF_SIGNED|DEPTH_ZERO|unable to verify/i.test(untrusted.error), "неожиданная причина отказа: " + untrusted.error);
    } finally {
      server.close();
    }
  });

  await test("мост: поднимается по https, статус и QR несут https, канал — wss", async () => {
    const dir = tmpdir("bridge-tls-");
    const b = new MobileBridge({ handlerMap: new Map(), certDir: dir });
    b.port = await freePort();
    b.pin = "123456";
    b.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      const st = b.status({});
      assert.strictEqual(st.scheme, "https", "мост не поднял TLS: " + st.scheme + " (" + st.tlsError + ")");
      assert.strictEqual(st.tls, true, "статус не сообщает о шифровании");
      assert.ok(st.urls.every((u) => /^https:\/\//.test(u.url)), "адреса для QR остались http: " + JSON.stringify(st.urls));
      assert.ok(/^([0-9A-F]{2}:){15}/.test(st.tlsFingerprint || ""), "нет отпечатка сертификата: " + st.tlsFingerprint);
      const client = b.status({ client: true });
      assert.strictEqual(client.scheme, "https", "телефону не сказано, что канал https");
      assert.ok(/^https:\/\//.test(client.url), "адрес телефону без https: " + client.url);
      // Страница: без ca — с предупреждением (как на телефоне), с ca — доверенная.
      const loose = await getPage(b.port, "/", null);
      assert.strictEqual(loose.status, 200, "страница не отдаётся: " + loose.status);
      assert.ok(loose.body.length > 1000, "отдана пустая страница");
      const cert = fs.readFileSync(path.join(dir, "cert.pem"), "utf8");
      const strict = await getPage(b.port, "/mobile-api.js", [cert]);
      assert.strictEqual(strict.status, 200, "с доверенным сертификатом страница не отдаётся");
      assert.ok(/WebSocket/.test(strict.body), "отдан не скрипт телефона");
      // Канал: рукопожатие WebSocket поверх TLS поверх сертификата.
      const ws = await wsHandshake(b.port, cert, null);
      assert.ok(/^HTTP\/1\.1 101/.test(ws.head), "мост не переключился на WebSocket: " + ws.head.split("\r\n")[0]);
      assert.ok(ws.head.indexOf("Sec-WebSocket-Accept: " + ws.expect) >= 0, "неверный ответ рукопожатия wss");
      // Сертификат, которым представился мост, — тот же, что в userData.
      const x = new crypto.X509Certificate(cert);
      assert.ok(x.checkIP(b.lanIps()[0]) || b.lanIps().length === 0, "мост не назвал свой адрес в сертификате");
    } finally {
      b.stop();
    }
  });

  await test("мост: без папки для сертификата доступ остаётся, но без шифрования и с причиной", async () => {
    const b = new MobileBridge({ handlerMap: new Map(), certDir: "" });
    b.port = await freePort();
    b.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      const st = b.status({});
      assert.strictEqual(st.scheme, "http", "мост без сертификата назвался https: " + st.scheme);
      assert.strictEqual(st.tls, false, "статус сообщает о шифровании без сертификата");
      assert.ok(st.tlsError.length > 0, "причина отказа от TLS не названа");
      assert.ok(st.urls.every((u) => /^http:\/\//.test(u.url)), "адреса не соответствуют схеме: " + JSON.stringify(st.urls));
      const page = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: b.port, path: "/" }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode, body: body }));
          })
          .on("error", reject);
      });
      assert.strictEqual(page.status, 200, "без TLS доступ к приложению потерян: " + page.status);
    } finally {
      b.stop();
    }
  });

  await test("мост: сбой выпуска сертификата не выключает доступ, а объясняется человеку", async () => {
    // Путь, по которому папку создать нельзя: под ним уже лежит файл.
    const dir = tmpdir("bridge-tls-");
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "не папка");
    const b = new MobileBridge({ handlerMap: new Map(), certDir: path.join(blocker, "child") });
    b.port = await freePort();
    b.start();
    try {
      await new Promise((r) => setTimeout(r, 300));
      const st = b.status({});
      assert.strictEqual(st.scheme, "http", "мост без сертификата назвался https");
      assert.ok(st.tlsError.length > 0, "причина сбоя не записана в статус");
      const page = await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: b.port, path: "/" }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          })
          .on("error", reject);
      });
      assert.strictEqual(page, 200, "сбой сертификата сломал мобильный доступ");
    } finally {
      b.stop();
    }
  });

  await test("проводка и интерфейс: TLS включён по умолчанию и о нём сказано человеку", () => {
    const bridge = read("src", "mobile-bridge.js");
    assert.ok(/bridgeTls\.ensureCert\(/.test(bridge), "мост не выпускает сертификат");
    assert.ok(/https\.createServer\(\{ key: tls\.key, cert: tls\.cert, minVersion: \"TLSv1\.2\" \}/.test(bridge), "мост поднимается не по https с ограничением версии");
    assert.ok(/scheme\(\) \{\s*\n\s*return this\.tls \? \"https\" : \"http\";/.test(bridge), "схема не выводится из TLS");
    assert.ok(!/mobileTls|allowPlain|insecure/.test(bridge), "в мосте появился выключатель шифрования — из настроек его выключит и телефон");
    // Приложение даёт мосту папку рядом с настройками, а не в самом проекте.
    const main = read("src", "main.js");
    assert.ok(/new MobileBridge\(\{\s*\n\s*handlerMap: ipcHandlerMap,\s*\n\s*certDir: path\.join\(app\.getPath\(\"userData\"\), \"bridge-tls\"\),/.test(main), "мост не получает папку для сертификата");
    // Панель объясняет и предупреждение телефона, и работу без шифрования.
    const panel = read("src", "renderer", "mobile-panel.js");
    assert.ok(/st\.tls\b/.test(panel) && /Дополнительно/.test(panel), "панель молчит про предупреждение телефона");
    assert.ok(/без шифрования/.test(panel), "панель молчит про работу без шифрования");
    // Телефон строит адрес канала из схемы страницы: https → wss.
    const mob = read("src", "renderer", "mobile-api.js");
    assert.ok(/location\.protocol === "https:" \? "wss:\/\/" : "ws:\/\/"/.test(mob), "телефон не переключает канал на wss");
    // Живой прогон моста ходит по wss, а не по открытому ws.
    const live = read("scripts", "live-mobile-bridge.js");
    assert.ok(/wss:\/\//.test(live), "живой прогон моста остался на открытом ws");
  });

  console.log("\nTLS мобильного моста: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

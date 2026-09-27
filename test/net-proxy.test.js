"use strict";

/* ── Прокси для внешних API (src/net-proxy.js) ───────────────────────────────
   Запуск: node test/net-proxy.test.js   (входит в общий `npm test`)

   Здесь проверяется ровно то, что молча ломает доступ к провайдеру:

     • адрес прокси разбирается по-человечески: «host:port» без схемы, логин и
       пароль прямо в адресе, спецзнаки в пароле не портятся;
     • выключенная галочка, пустой адрес и локальные цели (localhost, 127.0.0.1,
       домашние сети) означают ПРЕЖНИЙ fetch — свой Ollama проксировать нельзя;
     • http-прокси и SOCKS5 действительно поднимают соединение: запрос в
       абсолютной форме, тоннель CONNECT, рукопожатие SOCKS5 с логином и паролем;
     • ответ отдаётся в форме fetch (ok/status/headers.get/text/json) — иначе
       транспорт и прогон читали бы его другим кодом;
     • отказ прокси (407) превращается в понятный текст, а не в «вечное думание»;
     • проверка связи (testProxy) правда ходит наружу и приносит выходной IP.

   Прокси и цель поднимаются ЗДЕСЬ ЖЕ, на 127.0.0.1: набор не требует сети, но
   проверяет обе ветки по-настоящему — и http-прокси, и SOCKS5. TLS подменяется
   простым сокетом (createNetProxy({ tls })): проверяем свою логику тоннеля, а не
   сертификаты Node. */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createNetProxy } = require(path.join(ROOT, "src", "net-proxy.js"));

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

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Игрушечные серверы: цель и два вида прокси ──────────────────────────────

// Цель: обычный http-сервер. Отвечает тем, что просит обработчик.
function startTarget(handler) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv: srv, port: srv.address().port }));
  });
}

// http-прокси: для http-цели — запрос в абсолютной форме, для https-цели — CONNECT.
function startHttpProxy(opts) {
  const o = opts || {};
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ kind: "absolute", url: req.url, auth: req.headers["proxy-authorization"] || "" });
    let u = null;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end("bad absolute url");
      return;
    }
    const preq = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: req.method,
        headers: Object.assign({}, req.headers, { host: u.host }),
      },
      (pres) => {
        res.writeHead(pres.statusCode, pres.headers);
        pres.pipe(res);
      }
    );
    preq.on("error", () => {
      res.writeHead(502);
      res.end("proxy error");
    });
    req.pipe(preq);
  });
  srv.on("connect", (req, socket, head) => {
    seen.push({ kind: "connect", url: req.url, auth: req.headers["proxy-authorization"] || "" });
    if (o.refuseConnect) {
      socket.write("HTTP/1.1 " + (o.refuseConnect || 407) + " Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const parts = String(req.url).split(":");
    const port = parseInt(parts.pop(), 10) || 443;
    const host = parts.join(":");
    const up = net.connect({ host: host, port: port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv: srv, port: srv.address().port, seen: seen }));
  });
}

// SOCKS5-прокси: приветствие → (логин/пароль) → CONNECT домена → труба к цели.
function startSocks5(opts) {
  const o = opts || {};
  const seen = { user: "", pass: "", userLen: 0, passLen: 0, host: "", port: 0, atyp: 0 };
  const srv = net.createServer((sock) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    let up = null;
    const pending = [];
    // С третьей стадии байты цели идут мимо разбора: труба уже стоит.
    const onData = (chunk) => {
      if (stage === 3) {
        if (up) up.write(chunk);
        else pending.push(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      pump();
    };
    const pump = () => {
      for (;;) {
        if (stage === 0) {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = Array.prototype.slice.call(buf.slice(2, 2 + n));
          buf = buf.slice(2 + n);
          if (o.user && methods.indexOf(0x02) >= 0) {
            sock.write(Buffer.from([0x05, 0x02]));
            stage = 1;
            continue;
          }
          if (!o.user && methods.indexOf(0x00) >= 0) {
            sock.write(Buffer.from([0x05, 0x00]));
            stage = 2;
            continue;
          }
          sock.write(Buffer.from([0x05, 0xff]));
          sock.destroy();
          return;
        }
        if (stage === 1) {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 2 + ulen + 1 + plen) return;
          seen.userLen = ulen;
          seen.passLen = plen;
          seen.user = buf.slice(2, 2 + ulen).toString("utf8");
          seen.pass = buf.slice(2 + ulen + 1, 2 + ulen + 1 + plen).toString("utf8");
          buf = buf.slice(2 + ulen + 1 + plen);
          const ok = seen.user === o.user && seen.pass === o.pass;
          sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) {
            sock.destroy();
            return;
          }
          stage = 2;
          continue;
        }
        if (buf.length < 4) return;
        const atyp = buf[3];
        let total = 0;
        let host = "";
        if (atyp === 0x01) {
          total = 4 + 4 + 2;
        } else if (atyp === 0x04) {
          total = 4 + 16 + 2;
        } else if (atyp === 0x03) {
          if (buf.length < 5) return;
          const len = buf[4];
          total = 4 + 1 + len + 2;
        } else {
          sock.destroy();
          return;
        }
        if (buf.length < total) return;
        const port = buf.readUInt16BE(total - 2);
        if (atyp === 0x03) host = buf.slice(5, 5 + buf[4]).toString("utf8");
        else if (atyp === 0x01) host = Array.prototype.join.call(buf.slice(4, 8), ".");
        seen.atyp = atyp;
        seen.host = host;
        seen.port = port;
        const rest = buf.slice(total);
        buf = Buffer.alloc(0);
        stage = 3;
        sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        up = net.connect({ host: host, port: port }, () => {
          // Свою ветку чтения снимаем: дальше байты ведёт труба, иначе они
          // уходили бы наверх дважды.
          sock.removeListener("data", onData);
          up.pipe(sock);
          if (rest.length) up.write(rest);
          if (pending.length) {
            up.write(Buffer.concat(pending));
            pending.length = 0;
          }
          sock.pipe(up);
        });
        up.on("error", () => sock.destroy());
        sock.on("error", () => {
          if (up) up.destroy();
        });
        return;
      }
    };
    sock.on("data", onData);
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({ srv: srv, port: srv.address().port, seen: seen }));
  });
}

// tls-подмена: «шифрования» нет, сокет отдаётся как есть. Так проверяется своя
// логика тоннеля, а не сертификаты: свой сертификат для 127.0.0.1 в наборе не нужен.
const fakeTls = {
  connect: (opts, cb) => {
    const socket = opts.socket;
    process.nextTick(() => {
      if (cb) cb();
    });
    return socket;
  },
};

const closeAll = (list) =>
  Promise.all(list.map((s) => new Promise((r) => (s && s.close ? s.close(() => r()) : r()))));

// ── Набор ───────────────────────────────────────────────────────────────────

(async () => {
  const proxy = createNetProxy({});
  const proxyFakeTls = createNetProxy({ tls: fakeTls });

  // ── [1] Разбор адреса прокси ─────────────────────────────────────────────
  await test("адрес прокси: схемы, порт по умолчанию, логин и пароль", () => {
    const a = proxy.parseProxy("http://127.0.0.1:8080");
    assert.ok(a && a.kind === "http" && a.host === "127.0.0.1" && a.port === 8080, "http-прокси не разобран");
    assert.strictEqual(a.href, "http://127.0.0.1:8080", "адрес для человека собран неверно");

    const b = proxy.parseProxy("127.0.0.1:1080");
    assert.ok(b && b.kind === "http" && b.port === 1080, "адрес без схемы не читается как http");

    const c = proxy.parseProxy("socks5://user:p%40ss@10.0.0.1:1080");
    assert.ok(c && c.kind === "socks5", "socks5-прокси не разобран");
    assert.strictEqual(c.user, "user", "логин потерян");
    assert.strictEqual(c.pass, "p@ss", "пароль со спецзнаком испорчен: " + c.pass);
    assert.strictEqual(c.href, "socks5://10.0.0.1:1080", "секрет попал в адрес для человека");

    const d = proxy.parseProxy("socks5h://proxy.local");
    assert.ok(d && d.port === 1080, "socks5h: порт по умолчанию не 1080");

    const e = proxy.parseProxy("https://proxy.example:8443");
    assert.ok(e && e.kind === "http" && e.scheme === "https" && e.port === 8443, "https-прокси не разобран");

    assert.strictEqual(proxy.parseProxy(""), null, "пустой адрес принят за прокси");
    assert.strictEqual(proxy.parseProxy("   "), null, "пробелы приняты за прокси");
    assert.strictEqual(proxy.parseProxy("ftp://host:21"), null, "чужая схема принята за прокси");
    assert.strictEqual(proxy.parseProxy("http://:8080"), null, "адрес без узла принят за прокси");
  });

  // ── [2] Через прокси идём не всегда ──────────────────────────────────────
  await test("локальные адреса и выключенная галочка — прежний fetch", () => {
    assert.strictEqual(proxy.isLocalUrl("http://localhost:11434/api/tags"), true, "localhost не признан локальным");
    assert.strictEqual(proxy.isLocalUrl("http://127.0.0.1:8080/x"), true, "127.0.0.1 не признан локальным");
    assert.strictEqual(proxy.isLocalUrl("http://192.168.1.5:1234"), true, "домашняя сеть не признана локальной");
    assert.strictEqual(proxy.isLocalUrl("http://10.0.0.7/x"), true, "10.x не признан локальным");
    assert.strictEqual(proxy.isLocalUrl("http://172.20.0.1/x"), true, "172.16-31 не признан локальным");
    assert.strictEqual(proxy.isLocalUrl("http://[::1]:1/x"), true, "IPv6 localhost не признан локальным");
    assert.strictEqual(proxy.isLocalUrl("https://api.groq.com/openai/v1"), false, "внешний адрес признан локальным");
    assert.strictEqual(proxy.isLocalUrl("https://api.openai.com"), false, "внешний адрес признан локальным");

    const on = { proxyEnabled: true, proxyUrl: "socks5://127.0.0.1:1080", proxyBypassLocal: true };
    assert.ok(proxy.proxyFor(on, "https://api.openai.com/v1/chat"), "внешняя цель не ушла на прокси");
    assert.strictEqual(proxy.proxyFor(on, "http://localhost:11434/api/tags"), null, "локальная цель ушла на прокси");
    assert.ok(
      proxy.proxyFor({ proxyEnabled: true, proxyUrl: "socks5://127.0.0.1:1080", proxyBypassLocal: false }, "http://localhost:11434/x"),
      "снятая галочка «мимо прокси» не работает"
    );
    assert.strictEqual(proxy.proxyFor({ proxyEnabled: false, proxyUrl: "socks5://127.0.0.1:1080" }, "https://api.openai.com"), null, "выключенная галочка не работает");
    assert.strictEqual(proxy.proxyFor({ proxyEnabled: true, proxyUrl: "" }, "https://api.openai.com"), null, "пустой адрес не проксирует");
    assert.strictEqual(proxy.proxyFor({ proxyEnabled: true, proxyUrl: "мусор-без-порта-и-схемы" }, "ftp://x/y"), null, "не-http цель ушла на прокси");
    assert.strictEqual(proxy.redactProxy("socks5://user:secret@host:1080"), "socks5://host:1080", "пароль прокси утёк в адрес");
  });

  // ── [3] Без прокси — обычный fetch ───────────────────────────────────────
  await test("без настройки запрос идёт обычным fetch, без правок", async () => {
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push([url, opts]);
      return { ok: true, status: 200 };
    };
    try {
      const r = await proxy.fetchFor({ proxyEnabled: false }, "https://api.openai.com/v1/models", { method: "GET" });
      assert.strictEqual(r.status, 200, "ответ не проброшен");
      assert.strictEqual(calls.length, 1, "обычный fetch не позвали");
      assert.strictEqual(calls[0][0], "https://api.openai.com/v1/models", "адрес подменён");
    } finally {
      global.fetch = realFetch;
    }
  });

  // ── [4] http-прокси: запрос в абсолютной форме ───────────────────────────
  await test("http-прокси: http-цель идёт запросом в абсолютной форме", async () => {
    const target = await startTarget((req, res, body) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-test": "yes" });
      res.end(req.method === "POST" ? "тело:" + body : "привет");
    });
    const px = await startHttpProxy();
    try {
      const settings = { proxyEnabled: true, proxyUrl: "http://127.0.0.1:" + px.port, proxyBypassLocal: false };
      const url = "http://127.0.0.1:" + target.port + "/x?q=1";
      const res = await proxy.fetchFor(settings, url, { method: "GET" });
      assert.strictEqual(res.status, 200, "статус не проброшен");
      assert.strictEqual(res.ok, true, "ok не выставлен");
      assert.strictEqual(res.headers.get("x-test"), "yes", "заголовки не читаются через get()");
      assert.strictEqual(await res.text(), "привет", "тело ответа не прочитано");
      assert.ok(px.seen.length === 1 && px.seen[0].kind === "absolute", "прокси не увидел запрос в абсолютной форме");
      assert.strictEqual(px.seen[0].url, url, "прокси увидел не тот адрес: " + px.seen[0].url);

      const post = await proxy.fetchFor(settings, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      assert.strictEqual(await post.text(), 'тело:{"a":1}', "тело POST не доехало");
    } finally {
      await closeAll([target.srv, px.srv]);
    }
  });

  // ── [5] Тоннель CONNECT для https-цели ───────────────────────────────────
  await test("http-прокси: https-цель идёт через тоннель CONNECT", async () => {
    const target = await startTarget((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, ip: "203.0.113.9" }));
    });
    const px = await startHttpProxy();
    try {
      const settings = { proxyEnabled: true, proxyUrl: "http://127.0.0.1:" + px.port, proxyBypassLocal: false };
      const url = "https://127.0.0.1:" + target.port + "/v1/models";
      const res = await proxyFakeTls.fetchFor(settings, url, { method: "GET" });
      assert.strictEqual(res.status, 200, "статус из тоннеля не проброшен");
      const data = await res.json();
      assert.strictEqual(data.path, "/v1/models", "в тоннеле ушёл неверный путь: " + data.path);
      assert.ok(px.seen.length === 1 && px.seen[0].kind === "connect", "CONNECT не дошёл до прокси");
      assert.strictEqual(px.seen[0].url, "127.0.0.1:" + target.port, "CONNECT ушёл не на тот адрес: " + px.seen[0].url);
    } finally {
      await closeAll([target.srv, px.srv]);
    }
  });

  // ── [6] SOCKS5: рукопожатие с логином и паролем ──────────────────────────
  await test("socks5: цель поднимается рукопожатием, логин и пароль доехали", async () => {
    const target = await startTarget((req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("через socks5:" + req.url);
    });
    const sx = await startSocks5({ user: "user", pass: "сек р ет" });
    try {
      const settings = {
        proxyEnabled: true,
        proxyUrl: "socks5://user:%D1%81%D0%B5%D0%BA%20%D1%80%20%D0%B5%D1%82@127.0.0.1:" + sx.port,
        proxyBypassLocal: false,
      };
      const url = "http://127.0.0.1:" + target.port + "/api/tags";
      const res = await proxy.fetchFor(settings, url, { method: "GET" });
      assert.strictEqual(await res.text(), "через socks5:/api/tags", "ответ через SOCKS5 не прочитан");
      assert.strictEqual(sx.seen.user, "user", "логин SOCKS5 не доехал");
      assert.strictEqual(sx.seen.pass, "сек р ет", "пароль SOCKS5 испорчен: " + sx.seen.pass);
      assert.strictEqual(sx.seen.host, "127.0.0.1", "имя узла не ушло прокси доменом");
      assert.strictEqual(sx.seen.port, target.port, "порт цели неверен");
      assert.strictEqual(sx.seen.atyp, 0x03, "адрес не передан именем узла (DNS решает прокси)");
    } finally {
      await closeAll([target.srv, sx.srv]);
    }
  });

  await test("socks5: без логина работает рукопожатие без пароля", async () => {
    const target = await startTarget((req, res) => {
      res.writeHead(200);
      res.end("ок");
    });
    const sx = await startSocks5();
    try {
      const settings = { proxyEnabled: true, proxyUrl: "socks5://127.0.0.1:" + sx.port, proxyBypassLocal: false };
      const res = await proxy.fetchFor(settings, "http://127.0.0.1:" + target.port + "/", { method: "GET" });
      assert.strictEqual(await res.text(), "ок", "ответ без авторизации не прочитан");
      assert.strictEqual(sx.seen.userLen, 0, "логин отправлен, хотя не задан");
    } finally {
      await closeAll([target.srv, sx.srv]);
    }
  });

  // ── [7] Отказ прокси — понятный текст ────────────────────────────────────
  await test("отказ прокси на CONNECT объясняется словами, а не молчанием", async () => {
    const px = await startHttpProxy({ refuseConnect: 407 });
    try {
      const settings = { proxyEnabled: true, proxyUrl: "http://127.0.0.1:" + px.port, proxyBypassLocal: false };
      let err = null;
      try {
        await proxyFakeTls.fetchFor(settings, "https://127.0.0.1:443/x", { method: "GET" });
      } catch (e) {
        err = e;
      }
      assert.ok(err, "отказ прокси не стал ошибкой");
      assert.ok(/407/.test(err.message), "в ошибке нет кода прокси: " + err.message);
      assert.ok(/логин и пароль/.test(err.message), "не сказано, чего не хватает: " + err.message);
    } finally {
      await closeAll([px.srv]);
    }
  });

  // ── [8] Проверка связи ───────────────────────────────────────────────────
  await test("проверка прокси: живая связь, выходной IP и понятные отказы", async () => {
    const target = await startTarget((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ip: "198.51.100.7" }));
    });
    const px = await startHttpProxy();
    try {
      const ok = await proxy.testProxy({
        proxyUrl: "http://127.0.0.1:" + px.port,
        testUrl: "http://127.0.0.1:" + target.port + "/",
      });
      assert.strictEqual(ok.ok, true, "рабочий прокси не признан рабочим: " + (ok.error || ""));
      assert.strictEqual(ok.ip, "198.51.100.7", "выходной IP не разобран: " + ok.ip);
      assert.ok(ok.ms >= 0 && ok.proxy === "http://127.0.0.1:" + px.port, "нет времени ответа или адреса прокси");
    } finally {
      await closeAll([target.srv, px.srv]);
    }

    const broken = await proxy.testProxy({ proxyUrl: "http://127.0.0.1:1", testUrl: "http://127.0.0.1:9/" });
    assert.strictEqual(broken.ok, false, "нерабочий прокси признан рабочим");
    assert.ok(/прокси|подключ/i.test(broken.error || ""), "отказ прокси без понятного текста: " + broken.error);

    const bad = await proxy.testProxy({ proxyUrl: "не адрес" });
    assert.strictEqual(bad.ok, false, "мусор на месте адреса принят");
    assert.ok(/не разобран/i.test(bad.error || ""), "про мусор не сказано словами: " + bad.error);
  });

  // ── [9] Настройки: схема и форма ─────────────────────────────────────────
  await test("настройки: прокси в схеме, мусор не проходит", () => {
    const { createSettingsStore } = require(path.join(ROOT, "src", "settings-store.js"));
    const store = createSettingsStore({
      fs: fs,
      path: path,
      os: os,
      app: { getPath: () => path.join(os.tmpdir(), "net-proxy-test-" + process.pid) },
      secrets: { loadSecrets: () => ({}), saveSecrets: () => {}, splitSecrets: (s) => ({ rest: s, sec: {} }), SECRET_KEYS: [] },
      audit: { setEnabled: () => {} },
      toolPolicy: { normalizeScopes: (v) => (v && typeof v === "object" ? v : {}) },
      vault: { sanitizeList: (v) => (Array.isArray(v) ? v : []) },
      applyAgentEnv: () => {},
      applyBrowserSettings: () => {},
    });

    const d = store.DEFAULT_SETTINGS;
    assert.strictEqual(d.proxyEnabled, false, "прокси включён по умолчанию");
    assert.strictEqual(d.proxyUrl, "", "адрес прокси не пуст по умолчанию");
    assert.strictEqual(d.proxyBypassLocal, true, "локальные адреса по умолчанию идут через прокси");

    const clean = store.normalizeSettings({});
    assert.strictEqual(clean.proxyEnabled, false, "мусор включил прокси");
    assert.strictEqual(clean.proxyUrl, "", "пустой адрес не строка");
    assert.strictEqual(clean.proxyBypassLocal, true, "галочка «мимо прокси» потерялась");

    const dirty = store.normalizeSettings({ proxyEnabled: "да", proxyUrl: 42, proxyBypassLocal: "нет" });
    assert.strictEqual(dirty.proxyEnabled, false, "строка включила прокси");
    assert.strictEqual(dirty.proxyUrl, "", "число попало в адрес прокси");
    assert.strictEqual(dirty.proxyBypassLocal, true, "строка выключила «мимо прокси»");

    const real = store.normalizeSettings({ proxyEnabled: true, proxyUrl: "  socks5://h:1080  ", proxyBypassLocal: false });
    assert.strictEqual(real.proxyEnabled, true, "включённый прокси не сохранён");
    assert.strictEqual(real.proxyUrl, "socks5://h:1080", "адрес не обрезан: «" + real.proxyUrl + "»");
    assert.strictEqual(real.proxyBypassLocal, false, "осознанно снятая галочка вернулась");
  });

  // ── [10] Проводка: где модуль собран и что им пользуется ─────────────────
  await test("проводка: настройки, окно, гнездо провайдера и прогон", () => {
    const mainSrc = readSrc("src/main.js");
    assert.ok(/const \{ createNetProxy \} = require\("\.\/net-proxy\.js"\)/.test(mainSrc), "модуль не подключён в main.js");
    assert.ok(/const netProxy = createNetProxy\(\{\}\)/.test(mainSrc), "модуль не собран");
    assert.ok(mainSrc.includes("ProviderConfig.setFetchImpl((url, opts) => netProxy.fetchFor(loadSettings(), url, opts))"), "запросы к API не подхватывают прокси");
    assert.ok(/const \{ registerNetProxyIpc \} = require\("\.\/net-proxy-ipc\.js"\)/.test(mainSrc), "канал проверки не подключён");
    const wiring = /const \{ createRunAi \} = require\("\.\/run-ai\.js"\)[\s\S]*?\n\}\);/.exec(mainSrc);
    assert.ok(wiring, "не нашёл проводку прогона");
    assert.ok(/\n  netProxy,/.test(wiring[0]), "прокси не передан прогону");

    const runSrc = readSrc("src/run-ai.js");
    const round = /const roundRunner = createRunRound\(\{[\s\S]*?\n  \}\);/.exec(runSrc);
    assert.ok(round, "не нашёл сборку раунда");
    assert.ok(/\n    netProxy,/.test(round[0]), "прокси не передан раунду");

    const roundSrc = readSrc("src/run-round.js");
    assert.ok(/const providerFetch =/.test(roundSrc), "запрос раунда не вынесен в providerFetch");
    assert.ok(/netProxy\.fetchFor\(settings, url, opts\)/.test(roundSrc), "раунд не ходит через прокси");
    assert.ok(/res = await providerFetch\(req\.url, \{/.test(roundSrc), "запрос раунда остался на голом fetch");

    const ipcSrc = readSrc("src/net-proxy-ipc.js");
    assert.ok(/ipcMain\.handle\("settings:testProxy"/.test(ipcSrc), "канала проверки прокси нет");
    assert.ok(/netProxy\.testProxy\(/.test(ipcSrc), "канал не зовёт проверку");

    const configSrc = readSrc("src/renderer/provider-config.js");
    assert.ok(/setFetchImpl/.test(configSrc) && /function netFetch/.test(configSrc), "нет гнезда для прокси в подключении к провайдеру");
    for (const rel of ["src/renderer/provider-transport.js", "src/renderer/context-window.js", "src/renderer/image-tools.js"]) {
      const src = readSrc(rel);
      assert.ok(/netFetch/.test(src) && /const callApi =/.test(src), "модуль ходит в API мимо прокси: " + rel);
      assert.ok(!/await fetch\(/.test(src), "в модуле остался голый fetch: " + rel);
    }

    const preloadSrc = readSrc("src/preload.js");
    assert.ok(preloadSrc.includes('testProxy: (ui) => ipcRenderer.invoke("settings:testProxy", ui || {})'), "окно не может проверить прокси");

    const html = readSrc("src/renderer/index.html");
    for (const need of ['data-tab="proxy"', 'data-tab-body="proxy"', 'id="s-proxy-enabled"', 'id="s-proxy-url"', 'id="btn-proxy-test"', 'id="s-proxy-bypass-local"']) {
      assert.ok(html.includes(need), "в разметке нет " + need);
    }

    const panelSrc = readSrc("src/renderer/settings-panel.js");
    assert.ok(panelSrc.includes("$(\"s-proxy-enabled\").checked = getSettings().proxyEnabled === true;"), "панель не восстанавливает галочку прокси");
    assert.ok(panelSrc.includes("getSettings().proxyUrl = $(\"s-proxy-url\").value.trim();"), "панель не сохраняет адрес прокси");
    assert.ok(panelSrc.includes("testProxyUI: testProxyUI"), "панель не отдаёт проверку прокси");
    assert.ok(!/(^|[^\w.])settings\./.test(panelSrc), "панель ходит в settings напрямую вместо getSettings()");

    const pkg = readSrc("package.json");
    assert.ok(pkg.indexOf("node test/net-proxy.test.js") >= 0, "набора нет в цепочке npm test");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

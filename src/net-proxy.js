"use strict";

/* ─── Прокси для запросов к провайдеру (работа без VPN) ───────────────────────
   Зачем отдельный модуль. Часть AI-API (OpenAI, Anthropic, Google, Groq) из
   России без VPN недоступна, а весь остальной работе приложения прокси не нужен
   и вреден: файлы, git, терминал, браузер агента и свой Ollama/LM Studio живут
   на этом же ПК. Поэтому через прокси идут ТОЛЬКО запросы к провайдеру, и
   решение «идти ли через прокси» принимается на каждый запрос отдельно
   (proxyFor) — по адресу цели, а не глобально.

   Почему своими руками, а не готовой библиотекой. Прокси должен работать без
   новых зависимостей: пакет тянет за собой установку и сборку, а приложение
   собирается в установщик. Здесь ровно две вещи, которые нужны на практике:

     • http:// и https:// прокси — тоннель через CONNECT (для https-целей) либо
       запрос в абсолютной форме (для http-целей, там тоннель обычно не дают);
     • socks5:// и socks5h:// — рукопожатие SOCKS5 (RFC 1928) с необязательным
       логином/паролем (RFC 1929). Имя узла разбирает САМ ПРОКСИ, и это главное:
       часть API недоступна именно по DNS и SNI, а не по IP.

   Ответ отдаётся в форме, совместимой с fetch (ok/status/headers/body/text), —
   значит транспорт провайдера (src/renderer/provider-transport.js) и прогон
   (src/run-round.js) читают его тем же кодом, что и обычный ответ.

   Ничего не бросается наружу: на любой сбой возвращается понятная ошибка с
   адресом прокси, а при выключенной настройке запрос идёт прежним путём. */

function createNetProxy(deps) {
  // Модули Node берём внутри: main.js передаёт только необязательные подмены
  // (тесты подставляют поддельный tls, чтобы проверить тоннель без сертификата).
  const net = (deps && deps.net) || require("net");
  const tls = (deps && deps.tls) || require("tls");
  const http = (deps && deps.http) || require("http");
  const streamMod = (deps && deps.stream) || require("stream");
  const Readable = streamMod.Readable;

  // Сколько ждём «дозвон» до прокси. Это НЕ таймаут ответа модели: молчание
  // провайдера считает прогон (src/run-round.js) своими таймаутами стрима.
  const CONNECT_TIMEOUT_MS = 20000;
  const TEST_TIMEOUT_MS = 8000;
  const MAX_REDIRECTS = 4;

  // Какая схема адреса прокси — из тех двух семейств, что мы умеем.
  const SCHEME_KIND = { http: "http", https: "http", socks5: "socks5", socks5h: "socks5", socks: "socks5" };
  const DEFAULT_PORT = { http: 80, https: 443, socks5: 1080, socks5h: 1080, socks: 1080 };

  function decodePart(v) {
    try {
      return decodeURIComponent(String(v));
    } catch {
      return String(v);
    }
  }

  // ── Разбор адреса прокси ──────────────────────────────────────────────────
  // Человек чаще всего копирует «host:port» или «user:pass@host:port» без схемы —
  // такую запись читаем как http. Возвращаем null, если адрес не годен: лучше
  // честно сказать «не разобрал», чем молча пойти напрямую и свалить вину на
  // провайдера. Логин и пароль раскодируются (%40 → @), иначе пароль со спецзнаком
  // уезжал бы на прокси искажённым.
  function parseProxy(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    let u = null;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "http://" + s);
    } catch {
      return null;
    }
    const scheme = String(u.protocol || "").replace(/:$/, "").toLowerCase();
    if (!SCHEME_KIND[scheme]) return null;
    const host = String(u.hostname || "").replace(/^\[|\]$/g, "");
    if (!host) return null;
    const port = parseInt(u.port, 10) || DEFAULT_PORT[scheme];
    if (!(port > 0 && port < 65536)) return null;
    return {
      scheme: scheme,
      kind: SCHEME_KIND[scheme],
      host: host,
      port: port,
      user: u.username ? decodePart(u.username) : "",
      pass: u.password ? decodePart(u.password) : "",
      // Адрес для сообщений и настроек: без логина и пароля (в них секрет).
      href: scheme + "://" + host + ":" + port,
    };
  }

  // Адрес прокси в виде для человека: пароль наружу не отдаём.
  function redactProxy(raw) {
    const p = parseProxy(raw);
    return p ? p.href : "";
  }

  // ── Локальные адреса: их проксировать нельзя ──────────────────────────────
  // Свой Ollama, LM Studio, llama.cpp и внутренние сервисы живут на этом же ПК или
  // в домашней сети — идти за ними через внешний прокси бессмысленно и вредно
  // (имя узла уедет в чужую сеть, а скорость упадёт в разы).
  function isLocalUrl(url) {
    try {
      const u = new URL(String(url));
      const h = String(u.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
      if (!h) return true;
      if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1") return true;
      if (h.endsWith(".local")) return true;
      if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
      return false;
    } catch {
      return true; // не разобрали адрес — считаем локальным и не проксируем
    }
  }

  // ── Решение «идти ли через прокси» для конкретного адреса ─────────────────
  // Выключенная галочка, пустой/битый адрес, не-http схемы и локальные цели
  // означают ровно прежнее поведение — обычный fetch.
  function proxyFor(settings, url) {
    const s = settings || {};
    if (s.proxyEnabled !== true) return null;
    const p = parseProxy(s.proxyUrl);
    if (!p) return null;
    const raw = String(url || "");
    if (!/^https?:\/\//i.test(raw)) return null;
    if (s.proxyBypassLocal !== false && isLocalUrl(raw)) return null;
    return p;
  }

  function abortError() {
    const e = new Error("Запрос отменён");
    e.name = "AbortError";
    return e;
  }

  function onAbort(signal, fn) {
    if (!signal) return () => {};
    if (signal.aborted) {
      fn();
      return () => {};
    }
    const handler = () => fn();
    signal.addEventListener("abort", handler, { once: true });
    return () => {
      try {
        signal.removeEventListener("abort", handler);
      } catch {}
    };
  }

  // ── Соединение с самим прокси ────────────────────────────────────────────
  function connect(host, port, signal, timeoutMs) {
    const ms = timeoutMs || CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: host, port: port });
      let done = false;
      const off = onAbort(signal, () => finish(abortError()));
      const timer = setTimeout(() => finish(new Error("прокси " + host + ":" + port + " не отвечает (" + Math.round(ms / 1000) + " с)")), ms);
      function finish(err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        socket.removeListener("connect", onOk);
        socket.removeListener("error", onErr);
        if (err) {
          try {
            socket.destroy();
          } catch {}
          reject(err);
          return;
        }
        resolve(socket);
      }
      function onOk() {
        finish();
      }
      function onErr(e) {
        finish(new Error("не удалось подключиться к прокси " + host + ":" + port + ": " + ((e && e.message) || e)));
      }
      socket.once("connect", onOk);
      socket.once("error", onErr);
    });
  }

  // HTTPS-проверку сертификата НЕ отключаем: подмена сертификата — это именно то,
  // от чего прокси и защищает. Для IP-адреса имя узла в SNI не ставим (так нельзя).
  function tlsOptionsFor(socket, host) {
    const o = { socket: socket, ALPNProtocols: ["http/1.1"] };
    if (!/^[\d.]+$/.test(host) && host.indexOf(":") < 0) o.servername = host;
    return o;
  }

  function wrapTls(socket, host, port, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      const off = onAbort(signal, () => finish(abortError()));
      let tlsSocket = null;
      function finish(err) {
        if (done) return;
        done = true;
        off();
        if (err) {
          try {
            (tlsSocket || socket).destroy();
          } catch {}
          reject(err);
          return;
        }
        resolve(tlsSocket);
      }
      tlsSocket = tls.connect(tlsOptionsFor(socket, host), () => finish());
      tlsSocket.once("error", (e) => finish(new Error("TLS до " + host + ":" + port + " не поднялось: " + ((e && e.message) || e))));
    });
  }

  // ── Готовое соединение отдаём Node ────────────────────────────────────────
  // Своё уже установленное соединение возвращаем через свой на каждый запрос
  // агент. Почему НЕ через agent:false + createConnection: при agent:false Node
  // создаёт свой агент и createConnection не зовёт вовсе — запрос уходил бы
  // напрямую к цели, мимо прокси (проверено стендом test/net-proxy.test.js).
  // Агент одноразовый: keepAlive выключен, и глобальный пул сокетов не сможет
  // подсунуть запросу чужое соединение.
  function oneShotAgent(socket) {
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => socket;
    return agent;
  }

  // ── Тоннель через http(s)-прокси (метод CONNECT) ──────────────────────────
  // Сам разбор ответа прокси отдаём Node: он поднимает событие "connect" и
  // возвращает готовый сокет вместе с «хвостом» уже прочитанных байт. Свой
  // разбор ответа пришлось бы писать руками, и он же ошибался бы на границе
  // заголовков и тела.
  function connectHttp(socket, host, port, proxy, signal) {
    return new Promise((resolve, reject) => {
      const headers = { host: host + ":" + port };
      if (proxy.user) {
        headers["proxy-authorization"] = "Basic " + Buffer.from(proxy.user + ":" + proxy.pass, "utf8").toString("base64");
      }
      const req = http.request({
        method: "CONNECT",
        host: proxy.host,
        port: proxy.port,
        path: host + ":" + port,
        headers: headers,
        agent: oneShotAgent(socket),
      });
      let done = false;
      const off = onAbort(signal, () => finish(abortError()));
      function finish(err, okSocket, head) {
        if (done) return;
        done = true;
        off();
        if (err) {
          try {
            req.destroy();
          } catch {}
          try {
            socket.destroy();
          } catch {}
          reject(err);
          return;
        }
        if (head && head.length) {
          try {
            okSocket.unshift(head);
          } catch {}
        }
        resolve(okSocket);
      }
      req.once("connect", (res, s, head) => {
        if (res.statusCode !== 200) {
          finish(
            new Error(
              "прокси " + proxy.href + " не поднял тоннель (HTTP " + res.statusCode + ")" +
                (res.statusCode === 407 ? ": прокси требует логин и пароль" : "")
            )
          );
          return;
        }
        finish(null, s, head);
      });
      // Страховка на случай, если сборка Node ответит на CONNECT обычным ответом
      // (неровная поддержка метода у прокси): тогда тоннеля нет — так и говорим.
      req.once("response", (res) => {
        const status = res.statusCode;
        try {
          res.resume();
        } catch {}
        finish(
          new Error(
            "прокси " + proxy.href + " не поднял тоннель (HTTP " + status + ")" +
              (status === 407 ? ": прокси требует логин и пароль" : "")
          )
        );
      });
      req.on("error", (e) =>
        finish(new Error("тоннель через прокси " + proxy.href + " не поднялся: " + ((e && e.message) || e)))
      );
      req.end();
    });
  }

  // ── Рукопожатие SOCKS5 (RFC 1928 + RFC 1929) ──────────────────────────────
  function socksMessage(code) {
    const table = {
      1: "общий сбой прокси",
      2: "правило прокси запрещает соединение",
      3: "сеть недоступна",
      4: "узел недоступен",
      5: "прокси отказал в соединении",
      6: "TTL истёк",
      7: "команда не поддержана",
      8: "тип адреса не поддержан",
    };
    return "SOCKS5: " + (table[code] || "код " + code);
  }

  function connectSocks(socket, host, port, proxy, signal) {
    return new Promise((resolve, reject) => {
      let stage = 0; // 0 — приветствие, 1 — логин/пароль, 2 — ответ на CONNECT
      let buf = Buffer.alloc(0);
      let done = false;
      const off = onAbort(signal, () => finish(abortError()));
      function finish(err) {
        if (done) return;
        done = true;
        off();
        socket.removeListener("data", onData);
        socket.removeListener("error", onErr);
        if (err) {
          try {
            socket.destroy();
          } catch {}
          reject(err);
          return;
        }
        resolve(socket);
      }
      function onErr(e) {
        finish(new Error("соединение с SOCKS5-прокси " + proxy.href + " оборвалось: " + ((e && e.message) || e)));
      }
      function sendAuth() {
        const u = Buffer.from(proxy.user, "utf8");
        const p = Buffer.from(proxy.pass, "utf8");
        socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      }
      // Имя узла отдаём прокси доменом (ATYP 0x03) — разбор DNS остаётся у него.
      // Так работает и «глупый» IP-адрес: 0x03 его тоже принимает.
      function sendConnect() {
        const name = Buffer.from(host, "utf8");
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(port, 0);
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]));
      }
      function pump() {
        for (;;) {
          if (stage === 0) {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05) throw new Error("прокси " + proxy.href + " не говорит по SOCKS5");
            const method = buf[1];
            buf = buf.slice(2);
            if (method === 0x02) {
              sendAuth();
              stage = 1;
              continue;
            }
            if (method !== 0x00) throw new Error("SOCKS5-прокси требует способ входа, который не поддержан");
            sendConnect();
            stage = 2;
            continue;
          }
          if (stage === 1) {
            if (buf.length < 2) return;
            const okAuth = buf[1] === 0x00;
            buf = buf.slice(2);
            if (!okAuth) throw new Error("SOCKS5-прокси отклонил логин или пароль");
            sendConnect();
            stage = 2;
            continue;
          }
          if (buf.length < 4) return;
          const code = buf[1];
          const atyp = buf[3];
          let addrLen = 0;
          if (atyp === 0x01) addrLen = 4;
          else if (atyp === 0x04) addrLen = 16;
          else if (atyp === 0x03) {
            if (buf.length < 5) return;
            addrLen = 1 + buf[4];
          } else throw new Error("SOCKS5: неизвестный тип адреса в ответе прокси");
          if (buf.length < 4 + addrLen + 2) return;
          if (code !== 0x00) throw new Error(socksMessage(code));
          finish();
          return;
        }
      }
      function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);
        try {
          pump();
        } catch (e) {
          finish(e);
        }
      }
      socket.on("data", onData);
      socket.on("error", onErr);
      const methods = proxy.user ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]));
    });
  }

  // ── Ответ в форме, совместимой с fetch ───────────────────────────────────
  // Транспорт читает ответ как обычный fetch-ответ (body.getReader(), text()), и
  // нам важны ровно эти поля. Заголовки отдаём объектом с get() — так же, как
  // Headers у fetch (run-round.js берёт оттуда Retry-After).
  async function readAll(webStream) {
    const reader = webStream.getReader();
    const parts = [];
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      parts.push(Buffer.from(step.value));
    }
    return Buffer.concat(parts);
  }

  function toResponse(nodeRes) {
    const status = nodeRes.statusCode || 0;
    const raw = nodeRes.headers || {};
    const web = Readable.toWeb(nodeRes);
    return {
      ok: status >= 200 && status < 300,
      status: status,
      statusText: nodeRes.statusMessage || "",
      headers: {
        get: (name) => {
          const v = raw[String(name).toLowerCase()];
          if (v === undefined) return null;
          return Array.isArray(v) ? v.join(", ") : String(v);
        },
      },
      body: web,
      text: () => readAll(web).then((b) => b.toString("utf8")),
      json: () => readAll(web).then((b) => JSON.parse(b.toString("utf8"))),
      arrayBuffer: async () => {
        const b = await readAll(web);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  }

  // ── Один запрос по уже готовому соединению ───────────────────────────────
  function httpOver(socket, cfg) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, cfg.headers || {});
      let body = cfg.body == null ? null : cfg.body;
      if (body != null && typeof body !== "string" && !Buffer.isBuffer(body)) body = String(body);
      const has = (n) => Object.keys(headers).some((k) => String(k).toLowerCase() === n);
      // Длину тела ставим сами: без неё Node уйдёт на chunked, а часть прокси и
      // строгих шлюзов его не принимает. Заголовок цели берём из options.host —
      // в тоннеле прокси имени узла не знает, и Host обязан быть верным.
      if (body != null && !has("content-length") && !has("transfer-encoding")) {
        headers["content-length"] = Buffer.byteLength(body);
      }
      if (!has("connection")) headers.connection = "close";
      let done = false;
      let off = () => {};
      function finish() {
        if (done) return;
        done = true;
        off();
      }
      function fail(err) {
        finish();
        try {
          req.destroy();
        } catch {}
        try {
          socket.destroy();
        } catch {}
        reject(err);
      }
      const req = http.request(
        {
          host: cfg.host,
          port: cfg.port,
          method: cfg.method,
          path: cfg.path,
          headers: headers,
          agent: oneShotAgent(socket),
        },
        (res) => {
          finish();
          resolve(toResponse(res));
        }
      );
      req.on("error", (e) => fail(new Error("запрос через прокси не удался: " + ((e && e.message) || e))));
      // Подписку на отмену ставим ПОСЛЕ сборки запроса: если сигнал уже отменён,
      // обработчик вызовет fail() сразу, и ему нужен готовый req.
      off = onAbort(cfg.signal, () => fail(abortError()));
      if (body != null) req.write(body);
      req.end();
    });
  }

  // ── Один HTTP-запрос по цепочке «мы → прокси → цель» ─────────────────────
  async function oneRequest(proxy, rawUrl, o) {
    const target = new URL(rawUrl);
    const scheme = String(target.protocol || "").toLowerCase();
    if (scheme !== "http:" && scheme !== "https:") throw new Error("прокси работает только с http и https");
    const secure = scheme === "https:";
    const host = String(target.hostname || "").replace(/^\[|\]$/g, "");
    const port = parseInt(target.port, 10) || (secure ? 443 : 80);
    const method = String(o.method || "GET").toUpperCase();

    let proxySocket = await connect(proxy.host, proxy.port, o.signal, o.timeoutMs);
    // https-прокси: сам канал до прокси тоже под TLS.
    if (proxy.scheme === "https") proxySocket = await wrapTls(proxySocket, proxy.host, proxy.port, o.signal);
    try {
      // Тоннель нужен для https-цели (иначе прокси увидел бы открытый текст) и для
      // SOCKS5 (там соединение с целью уже установлено рукопожатием).
      const tunnel = proxy.kind === "socks5" || secure;
      if (proxy.kind === "socks5") await connectSocks(proxySocket, host, port, proxy, o.signal);
      else if (secure) await connectHttp(proxySocket, host, port, proxy, o.signal);
      // http-цель через http-прокси: запрос идёт в абсолютной форме прямо в прокси.
      const path = tunnel ? (target.pathname || "/") + (target.search || "") : String(rawUrl);
      const wire = secure ? await wrapTls(proxySocket, host, port, o.signal) : proxySocket;
      return await httpOver(wire, {
        host: host,
        port: port,
        path: path,
        method: method,
        headers: o.headers,
        body: o.body,
        signal: o.signal,
      });
    } catch (e) {
      try {
        proxySocket.destroy();
      } catch {}
      throw e;
    }
  }

  // ── Запрос с перенаправлениями ───────────────────────────────────────────
  // fetch сам ходит по 3xx, а наш запрос — нет: адрес перенаправления снова
  // прогоняем через прокси, иначе API со сменой хоста молча отдавал бы 302.
  async function request(proxy, url, o) {
    let current = String(url);
    let method = String(o.method || "GET").toUpperCase();
    let body = o.body;
    for (let hop = 0; ; hop++) {
      const res = await oneRequest(proxy, current, { method: method, body: body, headers: o.headers, signal: o.signal, timeoutMs: o.timeoutMs });
      const loc = res.headers.get("location");
      const code = res.status;
      const redirect = code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
      if (!loc || !redirect || hop >= MAX_REDIRECTS) return res;
      try {
        res.body.cancel();
      } catch {}
      let next = "";
      try {
        next = new URL(loc, current).toString();
      } catch {
        return res;
      }
      if (!/^https?:\/\//i.test(next)) return res;
      // 303 и (по факту браузеров) 301/302 на POST превращают запрос в GET.
      if (code === 303 || ((code === 301 || code === 302) && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
      current = next;
    }
  }

  // ── Точка входа для запросов приложения ──────────────────────────────────
  // Подменяет обычный fetch ТОЛЬКО когда человек включил прокси и цель внешняя.
  // Во всех остальных случаях поведение прежнее — байт в байт.
  function fetchFor(settings, url, opts) {
    const p = proxyFor(settings, url);
    if (!p) return fetch(url, opts);
    return request(p, url, opts || {});
  }

  // Первый в ответе IP: api.ipify.org отдаёт {"ip":"…"}, ifconfig.me — просто строку.
  function ipIn(text) {
    const t = String(text || "").trim();
    const m = /"ip"\s*:\s*"([^"]+)"/i.exec(t);
    if (m) return m[1];
    const line = (t.split("\n")[0] || "").trim();
    const plain = /^([0-9a-f:.]{3,45})$/i.exec(line);
    return plain ? plain[1] : "";
  }

  // ── Проверка прокси ──────────────────────────────────────────────────────
  // Проверяем настоящим запросом наружу: «настроено» и «работает» — разные вещи,
  // а человеку важно увидеть, каким IP его видит провайдер. Адрес берём ровно
  // тот, что человек видит в поле (он мог ещё не сохранить настройки), и
  // проверяем ЗДЕСЬ, в главном процессе: своя проверка из окна ничего не сказала
  // бы о том, как пойдёт настоящий запрос агента.
  async function testProxy(settings) {
    const s = settings || {};
    const p = parseProxy(s.proxyUrl);
    if (!p) {
      return { ok: false, error: "Адрес прокси не разобран. Пример: http://127.0.0.1:8080 или socks5://127.0.0.1:1080" };
    }
    const own = String(s.testUrl || "").trim();
    const urls = own ? [own] : ["https://api.ipify.org/?format=json", "https://ifconfig.me/ip"];
    const started = Date.now();
    let last = "";
    for (const url of urls) {
      try {
        const res = await oneRequest(p, url, {
          method: "GET",
          headers: { "user-agent": "NestDev", accept: "application/json, text/plain" },
          timeoutMs: TEST_TIMEOUT_MS,
        });
        const text = (await res.text()).trim();
        if (!res.ok) {
          last = "HTTP " + res.status + (text ? ": " + text.slice(0, 200) : "");
          continue;
        }
        return { ok: true, ms: Date.now() - started, ip: ipIn(text), proxy: p.href, url: url };
      } catch (e) {
        last = (e && e.message) || String(e);
      }
    }
    return { ok: false, error: last || "прокси не ответил", proxy: p.href };
  }

  return {
    parseProxy: parseProxy,
    redactProxy: redactProxy,
    isLocalUrl: isLocalUrl,
    proxyFor: proxyFor,
    fetchFor: fetchFor,
    testProxy: testProxy,
  };
}

module.exports = { createNetProxy: createNetProxy };

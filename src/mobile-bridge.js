"use strict";
/* Мобильный мост: доступ к ядру приложения с телефона/планшета по LAN.
   - HTTPS-сервер отдаёт интерфейс (src/renderer) + PWA (manifest, service worker, иконка).
     Сертификат самоподписанный (src/bridge-tls.js): без TLS страницу телефона мог бы
     отдать кто угодно из той же сети и забрать сеанс. Если сертификат не создался,
     мост работает по http, а статус и панель настроек говорят об этом прямо.
   - WebSocket-сервер (/ws) дублирует IPC: те же каналы, что у ipcMain, но только
     те, что перечислены в списке разрешённого (ALLOW ниже), и с защитой входом.
   - Вход: одноразовый токен пары из QR-кода → свой сеанс устройства, либо PIN,
     который человек вводит руками (запасной путь).
   - События (ai:event, term:event, dev:event, github:event) транслируются всем клиентам.
   Без зависимостей: серверная часть WebSocket (RFC 6455) реализована вручную. */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const bridgeTls = require("./bridge-tls.js"); // самоподписанный сертификат для https

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Защита PIN от перебора: максимум неудачных попыток за окно времени,
// после чего вход блокируется на AUTH_LOCK_MS (глобально, а не на соединение).
const AUTH_MAX_FAILS = 10;
const AUTH_FAIL_WINDOW_MS = 60000;
const AUTH_LOCK_MS = 5 * 60 * 1000;
const RENDERER_DIR = path.join(__dirname, "renderer");

// ─── Что телефону МОЖНО ──────────────────────────────────────────────────────
// Раньше здесь был список ровно из одного запрещённого канала (dialog:pickDir):
// телефону было доступно всё остальное — включая каналы, которых в его
// интерфейсе нет вовсе (деплой, консоль Yandex Cloud, удаление миссий).
// Достаточно было назвать канал в ws-сообщении, и он выполнялся.
//
// Теперь наоборот: перечислено то, что можно, а всё прочее закрыто по умолчанию.
// Состав списка — ровно то, что объявляет мобильный интерфейс
// (src/renderer/mobile-api.js); разъезжаться им не даёт проверка
// test/mobile-allow.test.js (она же ловит опечатки в именах каналов).
// Новый канал поэтому надо открыть сознательно — «само появится у телефона»
// больше не работает.
const ALLOW = new Set([
  // Прогон агента и откат правок
  "ai:answer", "ai:models", "ai:probeLocal", "ai:send", "ai:stop", "ai:test",
  "undo:rollback", "undo:status",
  // Настройки (значения секретов телефону не отдаются — см. src/secret-mask.js)
  "settings:get", "settings:set", "policy:groups",
  // История чатов и дела
  "chats:load", "chats:save",
  "tasks:add", "tasks:auto-ack", "tasks:auto-rearm", "tasks:board", "tasks:delete", "tasks:done", "tasks:list", "tasks:update",
  "agentfiles:status",
  // Проекты и миссии
  "projects:activate", "projects:create", "projects:list", "projects:remove",
  "mission:finish", "mission:open", "mission:pause", "mission:resume", "mission:state", "mission:stop",
  // Файлы рабочей папки
  "fs:createFile", "fs:createFolder", "fs:delete", "fs:importDropped", "fs:listTree", "fs:openInExplorer",
  "fs:readFile", "fs:readImage", "fs:writeFile",
  // Git и GitHub
  "git:clone", "git:commit", "git:commitDetail", "git:diff", "git:log", "git:pull", "git:push", "git:repoInfo",
  "git:resetHard", "git:restore", "git:revert", "git:rm", "git:status", "git:undoLastCommit", "git:unstage",
  "github:deviceCancel", "github:deviceStart", "github:disconnect", "github:pickRepo", "github:publish", "github:repos",
  "github:selectRepo", "github:selectedRepo", "github:unselectRepo", "github:user",
  // Терминал, запуск проекта, ссылки
  "term:complete", "term:input", "term:start", "term:status", "term:stop",
  "dev:start", "dev:status", "dev:stop", "shell:openExternal",
  // Локальные шлюзы, почта, память, браузер агента
  "g4f:probe", "g4f:test",
  "mail:recent", "mail:test", "mail:testSend",
  "memory:clear", "memory:days", "memory:openDir", "memory:stats",
  "browser:clearProfile", "browser:connect", "browser:connectInfo", "browser:profileInfo",
  // Yandex Cloud (дашборд и работа с ресурсами)
  "yc:cliStatus", "yc:costs", "yc:create", "yc:delete", "yc:deploy", "yc:folders", "yc:installCli",
  "yc:logout", "yc:logs", "yc:resources", "yc:setFolder", "yc:setPermissions", "yc:setToken", "yc:status",
  // Сам мост и обновление кода
  "mobile:status", "mobile:pinRegen",
  "ota:check", "ota:openDir", "ota:reset", "ota:rollback", "ota:status",
]);

// Каналы, закрытые сознательно, — с причиной: отказ должен объяснять себя
// (в интерфейсе телефона он показывается как есть). Всё, чего нет ни здесь,
// ни в ALLOW, закрыто по умолчанию — такие каналы просто перечислять нельзя.
const NOT_FOR_PHONE = new Map([
  ["dialog:pickDir", "системный диалог выбора папки открывается на ПК"],
  ["chats:saveSync", "синхронная запись истории — только окно на ПК"],
  ["mission:delete", "удаление миссии вместе с папкой — только с ПК"],
  ["agentfiles:openDir", "папку работы агента открывает ПК"],
  ["agentfiles:clear", "чистка файлов работы агента — только с ПК"],
  ["deploy:state", "выкат проекта идёт с ПК (на телефоне этой панели нет)"],
  ["deploy:run", "выкат проекта идёт с ПК (на телефоне этой панели нет)"],
  ["deploy:rollback", "откат выката делается с ПК"],
  ["deploy:health", "проверка адреса выката делается с ПК"],
  ["yc:console:overview", "консоль Yandex Cloud есть только в окне на ПК"],
  ["yc:console:list", "консоль Yandex Cloud есть только в окне на ПК"],
  ["yc:console:rollback", "откат через консоль Yandex Cloud делается с ПК"],
]);

// Одноразовый токен пары и сеансы устройств. Токен пары живёт в QR-коде на
// экране ПК и гаснет после первого использования: пересланный скриншот кода
// больше никого не пустит. Телефон после обмена получает свой сеанс и
// переподключается по нему, не спрашивая человека.
function randomToken() {
  return crypto.randomBytes(16).toString("hex");
}

// Сравнение секретов, не зависящее от времени ответа (PIN — шесть цифр, но
// правило одно для PIN, токена пары и сеанса).
function sameSecret(a, b) {
  const x = Buffer.from(String(a === undefined || a === null ? "" : a), "utf8");
  const y = Buffer.from(String(b === undefined || b === null ? "" : b), "utf8");
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Версия приложения попадает в имя кэша service worker. Раньше имя было неизменным
// ("ai-agent-mobile-v1"), и телефон мог неделями работать на СТАРОМ app.js из кэша:
// исправления не появлялись, поведение расходилось с ПК — «мобильная версия как будто
// отдельная». Теперь новая версия приложения = новое имя кэша, старый удаляется.
const APP_VERSION = (() => {
  try {
    return String(require(path.join(__dirname, "..", "package.json")).version || "0");
  } catch {
    return "0";
  }
})();

// Что мост отдаёт из src/renderer. Раньше список был захардкожен в handleHttp и в нём
// не было monochrome.css и highlight.js: телефон получал «неоновую» тему вместо
// монохромной, а подсветка кода молча отключалась.
const STATIC_FILES = new Set([
  "index.html",
  "boot-guard.js",
  "styles.css",
  "monochrome.css",
  "app.js",
  "provider-config.js",
  "provider-transport.js",
  "context-window.js",
  "web-tools.js",
  "image-tools.js",
  // Текст промпта и таблица схем инструментов: ядро берёт их из window — без этих
  // двух файлов на телефоне агент стартовал бы без правил и без инструментов.
  "prompts.js",
  "tool-schemas.js",
  "agent-core.js",
  "markdown.js",
  "highlight.js",
  "mobile-api.js",
  "bootstrap.js",
  // Эти два файла телефон получает так же, как ПК. Без них на телефоне молча
  // пропадало нужное: qr.js — построение кода подключения, field-guard.js —
  // возврат фокуса в поле, когда клик по нему съел чужой слой.
  "qr.js",
  "field-guard.js",
  // Панели Yandex Cloud и деплоя: они подключены в разметке, но телефон за ними
  // получал 404 — на телефоне эти разделы просто не работали.
  "yc-console.js",
  "yc-panel.js",
  "yc-console.css",
  "deploy-panel.js",
  "dev-run.js",
  "chat-actions.js",
  "web-chat.js",
  "tasks-mission.js",
  "secrets-panel.js",
  "mobile-panel.js",
  "chat-thinking.js",
  "chat-segments.js",
  "plan-panel.js",
  "chat-render.js",
  "chat-feed.js",
  "chat-work.js",
  "chat-events.js",
  "openai-profiles.js",
  "settings-search.js",
  "settings-panel.js",
  "project-panel.js",
  "command-palette.js",
  "g4f-panel.js",
  "auto-tasks.js",
  "model-popup.js",
  "ask-modal.js",
  "chat-rename.js",
  "chat-store.js",
  "chat-run.js",
  "chat-send.js",
  "chat-continue.js",
  "side-panel.js",
  "deploy-panel.css",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const MANIFEST = JSON.stringify(
  {
    name: "AI Developer Agent — мобильный доступ",
    short_name: "AI Agent",
    description: "Управляй своим AI-агентом с телефона: чат, консоль, превью, файлы и git.",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0f1a",
    theme_color: "#0b0f1a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  },
  null,
  2
);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0ea5e9"/><stop offset="0.5" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="#0b0f1a"/>
  <rect x="22" y="22" width="468" height="468" rx="92" fill="url(#g)" opacity="0.14"/>
  <rect x="96" y="96" width="320" height="320" rx="64" fill="url(#g)" opacity="0.92"/>
  <path d="M196 206l74 50-74 50" stroke="#0b0f1a" stroke-width="30" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M282 306h40" stroke="#0b0f1a" stroke-width="30" stroke-linecap="round"/>
  <circle cx="330" cy="212" r="16" fill="#34d399"/>
</svg>`;

const SW_JS = `"use strict";
/* Service Worker мобильного доступа: офлайн-кэш интерфейса.
   Документ — network-first (всегда свежий), остальное — stale-while-revalidate. */
const CACHE = "ai-agent-mobile-${APP_VERSION}";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/")))
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
`;

// ─── WebSocket-соединение (клиентская сторона, приём/отправка кадров) ───
class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.authed = false;
    this.authTries = 0;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.onClose) this.onClose(this);
    });
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buf = this.buf.slice(off + maskLen + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0x8a, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.onMessage(payload);
        else {
          this.fragOp = opcode;
          this.frag = [payload];
        }
      } else if (opcode === 0x0 && this.fragOp) {
        this.frag.push(payload);
        if (fin) {
          const all = Buffer.concat(this.frag);
          this.frag = [];
          this.fragOp = 0;
          this.onMessage(all);
        }
      }
    }
  }

  sendFrame(opcode, payload) {
    try {
      if (this.socket.destroyed) return;
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      this.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  sendText(str) {
    this.sendFrame(0x1, Buffer.from(String(str), "utf8"));
  }

  close() {
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {}
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {}
  }
}

class MobileBridge {
  constructor(opts) {
    this.handlerMap = opts && opts.handlerMap; // Map<channel, fn>
    // Папка для ключа и сертификата (userData/bridge-tls). Пусто — мост поднимется
    // без TLS: лучше доступ без шифрования с честным предупреждением, чем ничего.
    this.certDir = (opts && opts.certDir) || "";
    this.tls = null; // { cert, key, fingerprint, notAfter }
    this.tlsError = ""; // почему сертификата нет (показывается человеку)
    this.port = 9090;
    this.pin = "";
    this.host = ""; // предпочитаемый адрес для телефона ("" — автоопределение)
    this.enabled = false;
    this.server = null;
    this.clients = new Set();
    this.pingTimer = null;
    this.allow = ALLOW; // что телефону можно (см. список выше)
    this.notForPhone = NOT_FOR_PHONE; // что закрыто сознательно — и почему
    // Вход: одноразовый токен пары (в QR-коде) + сеансы подключённых устройств.
    this.pair = "";
    this.pairUsed = false;
    this.sessions = new Set();
    // Глобальный rate-limit аутентификации (перебор PIN):
    this.authFailCount = 0;
    this.authFailWindowStart = 0;
    this.authLockedUntil = 0;
  }

  // ─── Жизненный цикл ───
  applySettings(s) {
    const enabled = !!(s && s.mobileEnabled);
    const port = (s && s.mobilePort) || 9090;
    const pin = (s && s.mobilePin) || "";
    this.host = String((s && s.mobileHost) || "").trim();
    const portChanged = this.server && port !== this.port;
    if (portChanged) this.stop();
    this.enabled = enabled;
    this.port = port;
    this.pin = pin;
    // Токен пары НЕ меняется на каждое сохранение настроек: иначе QR-код на
    // экране гас бы от любой галочки. Его выдают один раз и меняют только
    // кнопкой «сменить PIN» (mobile:pinRegen → rotate).
    this.ensurePair();
    if (enabled && !this.server) this.start();
    if (!enabled && this.server) this.stop();
  }

  // Токен пары есть? (создаётся при первом обращении и при включении моста)
  ensurePair() {
    if (!this.pair) {
      this.pair = randomToken();
      this.pairUsed = false;
    }
    return this.pair;
  }

  // Новый токен пары и сброс сеансов: так с ПК можно «выкинуть» все телефоны
  // разом — старые подключения потребуют нового кода.
  rotate() {
    this.pair = randomToken();
    this.pairUsed = false;
    this.sessions.clear();
    for (const c of this.clients) {
      try {
        c.sendText(JSON.stringify({ t: "auth_err", needPin: true }));
        c.authed = false;
        c.session = "";
      } catch {}
    }
    this.clients.clear();
    return this.pair;
  }

  // Схема, по которой сейчас отвечает мост: её же получает QR-код и телефон
  // (страница по https открывает сокет как wss — см. src/renderer/mobile-api.js).
  scheme() {
    return this.tls ? "https" : "http";
  }

  // Сертификат для https. Ошибка здесь НЕ должна выключать мобильный доступ:
  // любой сбой (нет прав на папку, не хватает crypto) возвращает мост к http,
  // а причина остаётся в статусе — её видно в настройках, а не только в логе.
  prepareTls() {
    if (!this.certDir) {
      this.tls = null;
      this.tlsError = "Не задана папка для сертификата";
      return null;
    }
    try {
      const c = bridgeTls.ensureCert({
        dir: this.certDir,
        sanIps: this.lanIps(),
        sanNames: bridgeTls.hostNames(),
      });
      this.tls = c;
      this.tlsError = "";
      console.log(
        "[mobile] сертификат " + (c.reused ? "переиспользован" : "создан") +
          " (" + bridgeTls.prettyFingerprint(c.fingerprint).slice(0, 23) + "…), адреса: " + (c.sanIps || []).join(", ")
      );
      return c;
    } catch (e) {
      this.tls = null;
      this.tlsError = (e && e.message) || String(e);
      console.error("[mobile] сертификат не создан — мост работает без шифрования:", this.tlsError);
      return null;
    }
  }

  start() {
    if (this.server) return;
    const tls = this.prepareTls();
    const handler = (req, res) => this.handleHttp(req, res);
    const server = tls
      ? https.createServer({ key: tls.key, cert: tls.cert, minVersion: "TLSv1.2" }, handler)
      : http.createServer(handler);
    server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
    server.on("error", (err) => {
      // Порт занят/недоступен — мост просто не поднимется; приложение продолжает работать.
      console.error("[mobile] мост не запустился:", err.message);
    });
    server.listen(this.port, "0.0.0.0");
    this.server = server;
    this.pingTimer = setInterval(() => this.pingAll(), 25000);
    console.log("[mobile] мост запущен на :" + this.port + " (" + this.scheme() + ")");
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }

  // ─── Статус для настроек ───
  lanIps() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (ni.family === "IPv4" && !ni.internal) out.push({ ip: ni.address, name });
      }
    }
    // Порядок важен: телефону показывают ПЕРВЫЙ адрес из списка (он же уходит в
    // QR-код). У ПК почти всегда есть виртуальные адаптеры (Hyper-V, WSL, Docker) со
    // своими 172.17–31.x — с телефона они не открываются, поэтому отодвигаем их назад
    // и ставим домашнюю сеть 192.168.x.x вперёд.
    const score = (it) => {
      if (/vethernet|hyper-v|wsl|docker|vmware|virtualbox|loopback|tailscale|zerotier/i.test(it.name)) return 3;
      if (/^192\.168\./.test(it.ip)) return 0;
      if (/^10\./.test(it.ip)) return 1;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(it.ip)) return 2;
      return 1;
    };
    const seen = new Set();
    return out
      .filter((it) => (seen.has(it.ip) ? false : (seen.add(it.ip), true)))
      .sort((a, b) => score(a) - score(b))
      .map((it) => it.ip);
  }

  // Статус моста. opts.client === true — это ответ ТЕЛЕФОНУ: PIN и токен пары
  // ему не нужны, а знать их (и тем более показывать) он не должен. На ПК, где
  // рисуется QR-код, значения нужны — там opts пустой.
  status(opts) {
    const forClient = !!(opts && opts.client);
    const ips = this.lanIps();
    // Предпочитаемый адрес из настроек («Адрес для телефона»). Если такого адреса на
    // этой машине нет (сменилась сеть) — показывать его нельзя: телефон уйдёт в
    // пустоту. Тогда работаем по автоопределению и сообщаем об этом флагом hostActive.
    const want = String(this.host || "").trim();
    const active = !!want && ips.indexOf(want) >= 0;
    const order = active ? [want].concat(ips.filter((ip) => ip !== want)) : ips;
    const scheme = this.scheme();
    const link = (ip) => scheme + "://" + ip + ":" + this.port;
    const tlsInfo = { scheme: scheme, tls: !!this.tls, tlsError: this.tlsError };
    if (forClient) {
      return Object.assign({ enabled: this.enabled, running: !!this.server, port: this.port, ips, url: order.length ? link(order[0]) : "", urls: order.map((ip) => ({ ip, url: link(ip) })) }, tlsInfo);
    }
    return {
      enabled: this.enabled,
      running: !!this.server,
      port: this.port,
      pin: this.pin || "",
      // Токен пары — для QR-кода на экране ПК (одноразовый, см. rotate).
      pair: this.ensurePair(),
      pairUsed: this.pairUsed,
      sessions: this.sessions.size, // сколько устройств подключено по своим сеансам
      ips,
      host: want,
      hostActive: active,
      url: order.length ? link(order[0]) : "",
      urls: order.map((ip) => ({ ip, url: link(ip) })),
      // Шифрование: телефон при первом входе покажет предупреждение о
      // самоподписанном сертификате — панель настроек говорит об этом словами.
      scheme: scheme,
      tls: !!this.tls,
      tlsError: this.tlsError,
      tlsFingerprint: this.tls ? bridgeTls.prettyFingerprint(this.tls.fingerprint) : "",
    };
  }

  // ─── HTTP: статика + PWA ───
  handleHttp(req, res) {
    try {
      let p = req.url.split("?")[0];
      if (p === "/") p = "/index.html";
      if (p === "/manifest.webmanifest") {
        res.writeHead(200, { "Content-Type": MIME[".webmanifest"], "Cache-Control": "no-cache" });
        res.end(MANIFEST);
        return;
      }
      if (p === "/sw.js") {
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end(SW_JS);
        return;
      }
      if (p === "/icon.svg") {
        res.writeHead(200, { "Content-Type": MIME[".svg"], "Cache-Control": "public, max-age=86400" });
        res.end(ICON_SVG);
        return;
      }
      if (p === "/bootstrap.js") {
        // Маркер моста: mobile-api.js активируется только на страницах, отданных мостом
        // (в веб-превью server.js и Electron этого файла нет — там работает мок/preload).
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end("window.__mobileBridge = true;\n");
        return;
      }
      const safe = path.basename(p); // только файлы из renderer, без подкаталогов
      if (STATIC_FILES.has(safe)) {
        const file = path.join(RENDERER_DIR, safe);
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(safe).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (e) {
      res.writeHead(500);
      res.end("Internal error");
    }
  }

  // ─── WebSocket: рукопожатие ───
  handleUpgrade(req, socket) {
    if (req.url.split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    );
    socket.setNoDelay(true);
    const conn = new WsConn(
      socket,
      (payload) => this.onWsMessage(conn, payload),
      (c) => this.clients.delete(c)
    );
    socket.on("data", (chunk) => conn.feed(chunk));
  }

  // ─── WebSocket: протокол (auth → call → res; события → ev) ───
  onWsMessage(conn, payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!conn.authed) {
      if (msg && msg.t === "auth") this.authAttempt(conn, msg);
      return;
    }
    if (!msg || msg.t !== "call" || !msg.ch) return;
    const { id, ch, args } = msg;
    if (!this.allow.has(ch)) {
      const why = this.notForPhone.get(ch);
      conn.sendText(
        JSON.stringify({
          t: "res",
          id,
          ok: false,
          e: "Действие недоступно с телефона: " + ch + (why ? " — " + why + "." : ". Оно есть только в окне на ПК."),
        })
      );
      return;
    }
    const fn = this.handlerMap ? this.handlerMap.get(ch) : null;
    if (!fn) {
      conn.sendText(JSON.stringify({ t: "res", id, ok: false, e: "Неизвестный канал: " + ch }));
      return;
    }
    const fakeEvent = { sender: { send() {}, id: 0 } };
    const callArgs = Array.isArray(args) ? args : [];
    Promise.resolve()
      .then(() => fn(fakeEvent, ...callArgs))
      .then(
        (v) => conn.sendText(JSON.stringify({ t: "res", id, ok: true, v })),
        (err) =>
          conn.sendText(
            JSON.stringify({ t: "res", id, ok: false, e: (err && err.message) || String(err) })
          )
      );
  }

  // ─── Вход телефона ───
  /* Три способа, по порядку от «не спрашивает человека» к «спрашивает»:

       1. ТОКЕН ПАРЫ из QR-кода. Одноразовый: обменяли — гаснет, а телефон
          получает свой СЕАНС. Именно это заменяет PIN в адресной строке: код
          на экране нельзя переслать другу и нельзя подсмотреть в истории
          браузера телефона — он уже погашен.
       2. СЕАНС устройства: переподключение после смены Wi-Fi или перезагрузки
          страницы. Ничего вводить не надо, и PIN по сети не ходит.
       3. PIN, который человек ввёл руками: запасной путь, если код с ПК
          потерян или сеансы сброшены («сменить PIN» на ПК).

     Неудачная попытка считается так же, как раньше неудачный PIN: глобальное
     окно AUTH_FAIL_WINDOW_MS, после AUTH_MAX_FAILS — блокировка на AUTH_LOCK_MS,
     после пяти попыток на соединении — разрыв. */
  authAttempt(conn, msg) {
    const now = Date.now();
    // Глобальная блокировка после серии неудач: не считаем попытки, просто отказываем.
    if (now < this.authLockedUntil) {
      conn.sendText(JSON.stringify({ t: "auth_err", lock: true }));
      return;
    }
    if (msg.pair !== undefined) {
      if (!this.pairUsed && sameSecret(msg.pair, this.ensurePair())) {
        this.pairUsed = true; // одноразовый: этим кодом больше не войти
        const session = randomToken();
        this.sessions.add(session);
        conn.session = session;
        this.welcome(conn, { session });
        return;
      }
      // Код не подошёл или уже погашен: телефон должен показать вход по PIN,
      // а не пустой экран (auth_err с признаком needPin).
      this.failAuth(conn, { needPin: true, badPair: true });
      return;
    }
    if (msg.session !== undefined) {
      const s = String(msg.session || "");
      if (s && this.sessions.has(s)) {
        conn.session = s;
        this.welcome(conn, {});
        return;
      }
      // Сеанс устарел (на ПК нажали «сменить PIN»): просим PIN, но панику не
      // устраиваем — это штатная ситуация, а не подбор.
      conn.sendText(JSON.stringify({ t: "auth_err", lock: false, needPin: true, staleSession: true }));
      return;
    }
    if (msg.pin !== undefined && this.pin && sameSecret(msg.pin, this.pin)) {
      this.welcome(conn, {});
      return;
    }
    this.failAuth(conn, {});
  }

  // Успешный вход: снимаем счётчик перебора и отдаём статус БЕЗ своих секретов
  // (телефону PIN и токен пары знать незачем — см. status).
  welcome(conn, opts) {
    conn.authed = true;
    this.authFailCount = 0;
    this.authFailWindowStart = 0;
    this.clients.add(conn);
    const payload = { t: "auth_ok", v: this.status({ client: true }) };
    if (opts && opts.session) payload.session = opts.session;
    conn.sendText(JSON.stringify(payload));
  }

  failAuth(conn, extra) {
    const now = Date.now();
    conn.authTries++;
    // Неудача считается в глобальном окне (переподключение не обнуляет счётчик).
    if (now - this.authFailWindowStart > AUTH_FAIL_WINDOW_MS) {
      this.authFailWindowStart = now;
      this.authFailCount = 0;
    }
    this.authFailCount++;
    let locked = false;
    if (this.authFailCount >= AUTH_MAX_FAILS) {
      this.authLockedUntil = now + AUTH_LOCK_MS;
      this.authFailCount = 0;
      locked = true;
    }
    const err = { t: "auth_err", lock: locked };
    if (extra) {
      for (const k of Object.keys(extra)) {
        if (extra[k] !== undefined) err[k] = extra[k];
      }
    }
    conn.sendText(JSON.stringify(err));
    if (conn.authTries >= 5) {
      conn.sendText(JSON.stringify({ t: "auth_lock" }));
      conn.destroy();
    }
  }

  broadcast(channel, ev) {
    if (!this.clients.size) return;
    const payload = JSON.stringify({ t: "ev", ch: channel, v: ev });
    for (const c of this.clients) {
      try {
        c.sendText(payload);
      } catch {}
    }
  }

  pingAll() {
    for (const c of this.clients) {
      try {
        c.sendFrame(0x9, Buffer.alloc(0));
      } catch {}
    }
  }
}

module.exports = MobileBridge;
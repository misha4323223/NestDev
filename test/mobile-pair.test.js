"use strict";

/* ── Подключение телефона по QR-коду (src/renderer/mobile-api.js) ─────────────
   Запуск: node test/mobile-pair.test.js   (входит в общий `npm test`)

   Что здесь проверяется и почему именно так: на экране ПК в Настройках есть QR-код
   со ссылкой вида `http://192.168.1.42:9090/#pin=482913`. Камера телефона открывает
   эту ссылку, и приложение на телефоне должно подключиться САМО — без ручного ввода
   адреса и шести цифр. Сломаться это может тихо: код на экране выглядит правильно,
   а на телефоне человек снова видит поле «введи PIN».

   Поэтому скрипт телефона загружается в песочнице (`vm`) с игрушечным окном и
   игрушечным WebSocket, и проверяется настоящий маршрут:

     • PIN из адреса уходит на ПК сам, окно ввода не появляется;
     • PIN из адреса вырезается из адресной строки (чтобы не остался в истории);
     • без PIN — как раньше: появляется окно ввода, ничего не отправляется;
     • устаревший PIN (на ПК сменили) — видно окно и понятную ошибку, а не пустой экран;
     • ссылка с ПК (`/#pin=` + PIN) в том же формате, который читает телефон. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
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

const SOURCE = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");

// ── Игрушечное окно ────────────────────────────────────────────────────────
// Нужен ровно тот минимум, который трогает скрипт телефона: сборка окна ввода PIN
// (именно её отсутствие/наличие и есть предмет проверки).
function makeEnv(hash) {
  const byId = {};
  const stripped = [];
  const sent = [];

  function makeElement(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      id: "",
      textContent: "",
      innerHTML: "",
      value: "",
      disabled: false,
      style: {},
      children: [],
      focusCount: 0,
      classList: {
        _s: new Set(),
        add(c) {
          this._s.add(c);
        },
        remove(c) {
          this._s.delete(c);
        },
        toggle(c, on) {
          on ? this._s.add(c) : this._s.delete(c);
        },
        contains(c) {
          return this._s.has(c);
        },
      },
      _sel: {},
      appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        if (child.id) byId[child.id] = child;
        return child;
      },
      querySelector(sel) {
        if (!this._sel[sel]) {
          const child = makeElement(sel.indexOf("btn") >= 0 || sel.indexOf("retry") >= 0 ? "button" : "input");
          this._sel[sel] = child;
        }
        return this._sel[sel];
      },
      querySelectorAll() {
        return [];
      },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(k, v) {
        this[k] = v;
      },
      getAttribute() {
        return null;
      },
      remove() {},
      focus() {
        this.focusCount++;
      },
    };
    return el;
  }

  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      env.sockets.push(this);
    }
    send(payload) {
      this.sent.push(payload);
      sent.push(payload);
    }
    close() {
      this.readyState = 3;
    }
  }

  const document = {
    head: makeElement("head"),
    body: makeElement("body"),
    documentElement: { clientHeight: 800 },
    createElement: (tag) => makeElement(tag),
    getElementById: (id) => byId[id] || null,
    addEventListener() {},
    removeEventListener() {},
  };

  const windowObj = {
    __mobileBridge: true, // флаг моста: только с ним скрипт вообще работает
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };

  const env = {
    sockets: [],
    sent,
    stripped,
    byId,
    document,
    window: windowObj,
  };

  const sandbox = {
    window: windowObj,
    document,
    location: {
      protocol: "http:",
      host: "192.168.1.42:9090",
      hostname: "192.168.1.42",
      pathname: "/",
      search: "",
      hash: hash || "",
    },
    navigator: {},
    history: {
      replaceState: (a, b, url) => stripped.push(String(url)),
    },
    WebSocket: FakeSocket,
    setTimeout,
    clearTimeout,
    console,
    JSON,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "mobile-api.js" });
  env.sandbox = sandbox;
  env.socket = env.sockets[env.sockets.length - 1] || null;
  return env;
}

function authPayloads(env) {
  return env.sent
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    })
    .filter((m) => m && m.t === "auth");
}

(async () => {
  await test("PIN из QR-кода: телефон подключается сам, окна ввода нет", () => {
    const env = makeEnv("#pin=482913");
    assert.ok(env.socket, "скрипт не поднял соединение с ПК");
    assert.strictEqual(authPayloads(env).length, 0, "до открытия сокета ничего отправлять нельзя");
    assert.ok(!env.byId["mobile-gate"], "окно ввода PIN не должно появляться, когда PIN есть в адресе");

    env.socket.onopen();
    const auth = authPayloads(env);
    assert.strictEqual(auth.length, 1, "PIN из адреса должен уйти на ПК сразу после соединения");
    assert.strictEqual(auth[0].pin, "482913", "уехал не тот PIN");
    assert.ok(!env.byId["mobile-gate"], "окно ввода всё-таки появилось");
    assert.strictEqual(env.socket.url, "ws://192.168.1.42:9090/ws", "адрес моста");
  });

  await test("PIN из адреса вырезается из адресной строки (не остался в истории)", () => {
    const env = makeEnv("#pin=482913");
    assert.strictEqual(env.stripped.length, 1, "адресную строку надо почистить ровно один раз");
    assert.strictEqual(env.stripped[0].indexOf("pin"), -1, "PIN остался в адресе: " + env.stripped[0]);
    assert.strictEqual(env.stripped[0], "/", "почищенный адрес: " + env.stripped[0]);
  });

  await test("форматы ссылки: #pin=, #p=, ?pin= — и мусор игнорируется", () => {
    const ok = ["#pin=482913", "#p=482913", "?pin=482913"];
    for (const hash of ok) {
      const env = makeEnv(hash);
      env.socket.onopen();
      assert.strictEqual(authPayloads(env)[0] && authPayloads(env)[0].pin, "482913", "не разобран адрес " + hash);
      assert.ok(!env.byId["mobile-gate"], "лишнее окно ввода для " + hash);
    }
    // Мусор (не цифры) PIN не подменяет: должен открыться обычный ввод.
    for (const hash of ["#pin=", "#pin=abc", "#other=1", "#pin=12345x"]) {
      const env = makeEnv(hash);
      env.socket.onopen();
      assert.strictEqual(authPayloads(env).length, 0, "из мусора не должен собираться PIN: " + hash);
      assert.ok(env.byId["mobile-gate"], "без PIN должно открыться окно ввода: " + hash);
    }
  });

  await test("без PIN — как раньше: окно ввода, ничего не отправляется", () => {
    const env = makeEnv("");
    env.socket.onopen();
    assert.strictEqual(authPayloads(env).length, 0, "без PIN отправлять нечего");
    assert.ok(env.byId["mobile-gate"], "окно ввода PIN не появилось");
    assert.strictEqual(env.stripped.length, 0, "без PIN адресную строку трогать не нужно");
    // В поле подставлен адрес ПК — человеку понятно, к кому он подключается.
    const host = env.byId["mobile-gate"].querySelector(".mg-host");
    assert.ok(String(host.textContent).indexOf("192.168.1.42") >= 0, "не показан адрес ПК: " + host.textContent);
  });

  await test("устаревший PIN (сменили на ПК): видно окно и понятную ошибку", () => {
    const env = makeEnv("#pin=111111");
    env.socket.onopen();
    assert.strictEqual(authPayloads(env)[0].pin, "111111", "PIN из адреса не отправлен");
    assert.ok(!env.byId["mobile-gate"], "окно не нужно, пока PIN ещё не отклонён");
    env.socket.onmessage({ data: JSON.stringify({ t: "auth_err" }) });
    const gate = env.byId["mobile-gate"];
    assert.ok(gate, "после неверного PIN окно ввода обязательно — иначе пустой экран");
    const err = gate.querySelector("#mobile-gate-err");
    assert.ok(/Неверный PIN/.test(String(err.textContent)), "ошибка не объяснена: " + err.textContent);
    const pin = gate.querySelector("#mobile-pin");
    assert.strictEqual(pin.value, "", "поле должно быть очищено для нового ввода");
  });

  await test("ссылка с ПК и разбор на телефоне — один формат", () => {
    // Что строит ПК в Настройках: адрес моста + «/#pin=» + PIN. Панель подключения
    // телефона вынесена из app.js в src/renderer/mobile-panel.js (этап 3.6) —
    // спрашиваем модуль, а не адрес кода: формат ссылки от переезда не меняется.
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-panel.js"), "utf8");
    assert.ok(
      /urls\[0\]\.url\s*\+\s*"\/#pin="\s*\+\s*pin/.test(app),
      "ПК должен строить ссылку вида <адрес>/#pin=<PIN>"
    );
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.indexOf('id="mobile-qr"') > 0, "в настройках нет места под QR-код");
    assert.ok(/<script src="qr\.js"><\/script>/.test(html), "qr.js не подключён");

    // Собранная ПК ссылка обязана быть принята телефоном (проверяем тем же путём).
    const link = "http://192.168.1.42:9090" + "/#pin=" + "482913";
    const env = makeEnv("#" + link.split("#")[1]);
    env.socket.onopen();
    assert.strictEqual(authPayloads(env)[0].pin, "482913", "ссылка с ПК не подключает телефон");
  });

  await test("мост отдаёт телефону все скрипты страницы (иначе часть работает молча)", () => {
    // Класс ошибки, который уже случался дважды: файл есть в разметке, но не в
    // списке выдачи моста — на телефоне он не загружается, и это выглядит как
    // «на телефоне почему-то не работает». Проверяем связь списка с index.html.
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
    const allow = /const STATIC_FILES = new Set\(\[([\s\S]*?)\]\);/.exec(bridge);
    assert.ok(allow, "не найден список файлов, которые мост отдаёт телефону");
    const served = new Set((allow[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1)));
    const scripts = (html.match(/<script src="([^"]+)"/g) || []).map((s) => /src="([^"]+)"/.exec(s)[1]);
    const styles = (html.match(/<link[^>]+href="([^"]+\.css)"/g) || []).map((s) => /href="([^"]+)"/.exec(s)[1]);
    for (const name of scripts.concat(styles)) {
      assert.ok(!/^https?:/.test(name), "внешний ресурс в странице: " + name);
      assert.ok(served.has(name), "телефон получит 404 за " + name + " — файла нет в списке моста");
      assert.ok(fs.existsSync(path.join(ROOT, "src", "renderer", name)), "нет файла " + name);
    }
    assert.ok(served.has("qr.js") && served.has("field-guard.js"), "мост не отдаёт qr.js/field-guard.js");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

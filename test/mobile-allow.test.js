"use strict";

/* ── Что телефону можно (список разрешённого в src/mobile-bridge.js) ───────────
   Запуск: node test/mobile-allow.test.js   (входит в общий `npm test`)

   До этой проверки у моста был список ровно из ОДНОГО запрещённого канала
   (dialog:pickDir), то есть телефону было доступно всё остальное — включая
   каналы, которых в его интерфейсе нет вовсе: выкат проекта, консоль Yandex
   Cloud, удаление миссий вместе с папкой. Хватало назвать канал в ws-сообщении.

   Теперь наоборот: список ЯВНЫЙ, всё прочее закрыто. Ошибка тут не видна ни в
   окне, ни в логе: просто на телефоне «кнопка не работает» (закрыли лишнее) или
   «работает то, чего быть не должно» (забыли закрыть). Поэтому проверяется:

     • состав списка против мобильного интерфейса — тот же набор каналов, что
       объявляет src/renderer/mobile-api.js, и ни одного лишнего/опечатанного
       имени (каждое обязано быть настоящим обработчиком в src);
     • закрытые каналы закрыты ПО ФАКТУ, с объяснением причины, а не только
       отсутствием в списке;
     • живые вызовы: разрешённый канал доходит до обработчика, закрытый — нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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

const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");
const MOBILE_API = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");

// Список разрешённого и список закрытых читаем из самого модуля: набор должен
// проверять то, что работает, а не свою копию.
function listFrom(name) {
  const m = new RegExp("const " + name + " = new Set\\(\\[([\\s\\S]*?)\\]\\);").exec(BRIDGE_SRC);
  assert.ok(m, "в мосте не найден список " + name);
  return [...new Set((m[1].match(/"[^"]+"/g) || []).map((s) => s.slice(1, -1)))];
}
function mapFrom(name) {
  const m = new RegExp("const " + name + " = new Map\\(\\[([\\s\\S]*?)\\]\\);").exec(BRIDGE_SRC);
  assert.ok(m, "в мосте не найден список " + name);
  const out = new Map();
  for (const row of m[1].matchAll(/\["([^"]+)",\s*"([^"]*)"\]/g)) out.set(row[1], row[2]);
  return out;
}

// Все каналы, которые вообще существуют в приложении (регистрируют модули src).
function registeredChannels() {
  const names = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, "src"))) {
    if (!f.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(ROOT, "src", f), "utf8");
    for (const m of src.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)) names.add(m[1]);
  }
  return names;
}

function phoneChannels() {
  return [...new Set([...MOBILE_API.matchAll(/invoke\("([^"]+)"\)/g)].map((m) => m[1]))];
}

// Соединение, как его видит мост (без сокета): всё, что нужно протоколу.
function conn() {
  const c = {
    authed: false,
    session: "",
    authTries: 0,
    sent: [],
    destroyed: false,
    sendText(t) {
      c.sent.push(JSON.parse(String(t)));
    },
    destroy() {
      c.destroyed = true;
    },
  };
  return c;
}

// Позвать канал так, как это делает телефон: аутентификация → call.
// Ответ приходит асинхронно (мост зовёт обработчик через промис), поэтому
// дожидаемся очереди микротасок: иначе разрешённый канал выглядел бы «не дошёл».
async function callPhone(bridge, ch, args) {
  const c = conn();
  bridge.authAttempt(c, { pin: bridge.pin });
  c.sent.length = 0;
  bridge.onWsMessage(c, Buffer.from(JSON.stringify({ t: "call", id: 1, ch, args: args || [] })));
  await new Promise((r) => setImmediate(r));
  return c.sent.find((m) => m.t === "res") || null;
}

(async () => {
  console.log("Что телефону можно: список разрешённого у мобильного моста");

  await test("состав списка — ровно мобильный интерфейс, без лишних и без опечаток", () => {
    const allow = listFrom("ALLOW");
    const closed = mapFrom("NOT_FOR_PHONE");
    const phone = phoneChannels();
    const registered = registeredChannels();

    assert.ok(allow.length > 50, "список разрешённого подозрительно мал: " + allow.length);
    // 1. Всё, что объявляет телефон, обязано быть либо открыто, либо закрыто
    //    сознательно с причиной. Иначе канал просто исчезнет из виду.
    for (const ch of phone) {
      assert.ok(
        allow.indexOf(ch) >= 0 || closed.has(ch),
        "канал " + ch + " объявлен в мобильном интерфейсе, но не открыт и не закрыт сознательно"
      );
    }
    // 2. Каждое имя в списках — настоящий канал: опечатка = мёртвая запись,
    //    которая ничего не закрывает (и не открывает).
    for (const ch of allow) {
      assert.ok(registered.has(ch), "в списке разрешённого нет такого канала в приложении: " + ch);
      assert.ok(phone.indexOf(ch) >= 0, "канал открыт телефону, но мобильный интерфейс его не объявляет: " + ch);
    }
    for (const ch of closed.keys()) {
      assert.ok(registered.has(ch), "в списке закрытых нет такого канала: " + ch);
    }
    // 3. У каждой закрытой записи есть причина для человека, а не пустая строка.
    for (const [ch, why] of closed) {
      assert.ok(why && why.length > 10, "у закрытого канала нет причины: " + ch);
    }
  });

  await test("каналы, которых нет в интерфейсе телефона, закрыты по умолчанию", () => {
    const allow = listFrom("ALLOW");
    // Раньше эти выполнялись с телефона, хотя кнопок для них на телефоне нет.
    const mustBeClosed = [
      "deploy:run",
      "deploy:rollback",
      "yc:console:overview",
      "yc:console:rollback",
      "yc:console:secretVersion",
      "yc:console:dnsRecord",
      "yc:console:registryImage",
      "mission:delete",
      "agentfiles:openDir",
      "agentfiles:clear",
      "dialog:pickDir",
      "chats:saveSync",
    ];
    for (const ch of mustBeClosed) {
      assert.ok(allow.indexOf(ch) < 0, "канал открыт телефону: " + ch);
    }
  });

  await test("живой вызов: разрешённый канал доходит до обработчика", async () => {
    const seen = [];
    const bridge = new MobileBridge({ handlerMap: new Map([["git:status", (e, dir) => (seen.push(dir), { ok: true })]] )});
    bridge.pin = "123456";
    const res = await callPhone(bridge, "git:status", ["/proj"]);
    assert.ok(res && res.ok === true, "разрешённый канал не дошёл до обработчика: " + JSON.stringify(res));
    assert.deepStrictEqual(seen, ["/proj"], "обработчик получил не те аргументы");
  });

  await test("живой вызов: закрытый канал не доходит до обработчика, и отказ объяснён", async () => {
    const ran = [];
    const bridge = new MobileBridge({
      handlerMap: new Map([
        ["deploy:run", () => ran.push("deploy:run")],
        ["dialog:pickDir", () => ran.push("dialog:pickDir")],
        ["some:unknown", () => ran.push("some:unknown")],
      ]),
    });
    bridge.pin = "123456";

    const deploy = await callPhone(bridge, "deploy:run", []);
    assert.ok(deploy && deploy.ok === false, "закрытый канал выполнился: " + JSON.stringify(deploy));
    assert.ok(/недоступно с телефона/.test(deploy.e), "отказ не объяснён: " + deploy.e);
    assert.ok(/ПК/.test(deploy.e), "в отказе нет причины: " + deploy.e);

    const pick = await callPhone(bridge, "dialog:pickDir", []);
    assert.ok(pick && pick.ok === false && /системный диалог/.test(pick.e), "выбор папки с телефона не объяснён: " + JSON.stringify(pick));

    const unknown = await callPhone(bridge, "some:unknown", []);
    assert.ok(unknown && unknown.ok === false, "неизвестный канал не отклонён");
    assert.deepStrictEqual(ran, [], "что-то из закрытых каналов всё-таки выполнилось: " + JSON.stringify(ran));
  });

  await test("до входа каналы недоступны вовсе, и событий телефону не шлём", () => {
    const ran = [];
    const bridge = new MobileBridge({ handlerMap: new Map([["git:status", () => ran.push("x")]]) });
    bridge.pin = "123456";
    const c = conn();
    bridge.onWsMessage(c, Buffer.from(JSON.stringify({ t: "call", id: 1, ch: "git:status", args: [] })));
    assert.deepStrictEqual(c.sent, [], "неавторизованному ушёл ответ: " + JSON.stringify(c.sent));
    assert.deepStrictEqual(ran, [], "неавторизованный вызов дошёл до обработчика");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

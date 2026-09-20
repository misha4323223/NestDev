"use strict";

/* ── Вход телефона: одноразовый токен пары, сеанс и PIN (src/mobile-bridge.js) ─
   Запуск: node test/mobile-auth.test.js   (входит в общий `npm test`)

   Было: PIN ехал в адресной строке QR-кода (`/#pin=482913`) и уходил на ПК
   открытым текстом поверх ws://. Код на экране можно было переснять и переслать
   — он работал бесконечно, пока PIN не сменят руками.

   Стало: QR-код несёт одноразовый токен пары. Обменяли — токен погас, телефон
   получил свой СЕАНС и дальше переподключается по нему, а PIN остался запасным
   путём (человек вводит его руками, если код потерян).

   Проверяется по отдельности каждый шаг — ошибка здесь либо пускает чужого, либо
   запирает своего:

     • токен пары работает ровно один раз, второй раз — отказ с признаком «нужен PIN»;
     • сеанс работает после переподключения и перестаёт после «сменить PIN»;
     • PIN по-прежнему пускает (запасной путь) и по-прежнему защищён от перебора;
     • телефону в ответе не уходит ни PIN, ни токен пары. */

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

function mk(pin) {
  const bridge = new MobileBridge({ handlerMap: new Map() });
  bridge.pin = pin || "123456";
  bridge.ensurePair();
  return bridge;
}

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

const last = (c) => c.sent[c.sent.length - 1] || null;
const kinds = (c) => c.sent.map((m) => m.t).join(",");

(async () => {
  console.log("Вход телефона: одноразовый токен пары, сеанс и PIN");

  await test("токен пары из QR-кода пускает один раз и выдаёт сеанс устройства", () => {
    const b = mk();
    const first = conn();
    b.authAttempt(first, { pair: b.pair });
    const ok = last(first);
    assert.strictEqual(ok.t, "auth_ok", "вход по токену пары не прошёл: " + JSON.stringify(ok));
    assert.ok(/^[0-9a-f]{32}$/.test(String(ok.session || "")), "мост не выдал сеанс устройства: " + ok.session);
    assert.strictEqual(first.authed, true, "соединение не помечено вошедшим");
    assert.ok(b.sessions.has(ok.session), "сеанс не запомнен мостом");
    assert.strictEqual(b.pairUsed, true, "токен пары не помечен использованным");
    // Телефону в ответе не должно быть ни PIN, ни токена пары.
    assert.strictEqual(ok.v.pin, undefined, "телефону ушёл PIN");
    assert.strictEqual(ok.v.pair, undefined, "телефону ушёл токен пары");
  });

  await test("тот же токен второй раз не работает: код одноразовый", () => {
    const b = mk();
    const a = conn();
    b.authAttempt(a, { pair: b.pair });
    const second = conn();
    b.authAttempt(second, { pair: b.pair });
    const err = last(second);
    assert.strictEqual(err.t, "auth_err", "погашенный токен пустил ещё раз: " + JSON.stringify(err));
    assert.strictEqual(second.authed, false, "второе устройство вошло по тому же коду");
    // Признак нужен телефону: по нему он показывает вход по PIN, а не пустой экран.
    assert.strictEqual(err.badPair, true, "телефону не сказано, что код не подошёл");
    assert.strictEqual(err.needPin, true, "телефону не сказано, что нужен PIN");
  });

  await test("чужой токен пары не пускает (и не роняет проверку по длине)", () => {
    const b = mk();
    const cases = ["", "короткий", "0".repeat(32), (b.pair || "a").slice(0, 31), "z".repeat(40)];
    for (const pair of cases) {
      const c = conn();
      b.authAttempt(c, { pair });
      assert.strictEqual(last(c).t, "auth_err", "чужой токен пустил: " + JSON.stringify(pair).slice(0, 40));
      assert.strictEqual(c.authed, false, "чужой токен открыл доступ");
    }
    assert.strictEqual(b.pairUsed, false, "попытки пометили токен использованным");
  });

  await test("сеанс устройства работает при переподключении", () => {
    const b = mk();
    const first = conn();
    b.authAttempt(first, { pair: b.pair });
    const session = last(first).session;

    // Телефон переподключился (сменилась сеть, обновилась страница): новый сокет,
    // тот же сеанс. Человека не спрашиваем и секретов заново не шлём.
    const again = conn();
    b.authAttempt(again, { session });
    const ok = last(again);
    assert.strictEqual(ok.t, "auth_ok", "переподключение по сеансу не прошло: " + JSON.stringify(ok));
    assert.strictEqual(again.authed, true, "соединение не вошло по сеансу");
    assert.strictEqual(again.session, session, "мост не запомнил сеанс соединения");
  });

  await test("незнакомый или устаревший сеанс: просим PIN, но без блокировки", () => {
    const b = mk();
    const c = conn();
    b.authAttempt(c, { session: "не-наш-сеанс" });
    const err = last(c);
    assert.strictEqual(err.t, "auth_err", "чужой сеанс принят: " + JSON.stringify(err));
    assert.strictEqual(err.staleSession, true, "телефону не сказано, что сеанс устарел");
    assert.strictEqual(err.needPin, true, "телефону не сказано, что нужен PIN");
    assert.strictEqual(err.lock, false, "штатное устаревание сеанса сочтено подбором");
    assert.strictEqual(b.authFailCount, 0, "устаревший сеанс попал в счётчик подбора");
  });

  await test("«сменить PIN» гасит сеансы и выдаёт новый токен пары", () => {
    const b = mk();
    const c = conn();
    b.authAttempt(c, { pair: b.pair });
    const session = last(c).session;
    const oldPair = b.pair;

    const fresh = b.rotate();
    assert.notStrictEqual(fresh, oldPair, "токен пары не сменился");
    assert.strictEqual(b.pairUsed, false, "новый токен сразу помечен использованным");
    assert.strictEqual(b.sessions.size, 0, "сеансы подключённых устройств не сброшены");
    assert.strictEqual(c.authed, false, "прежнее соединение осталось вошедшим");
    assert.strictEqual(last(c).needPin, true, "подключённому телефону не сказано, что вход сменился");

    const old = conn();
    b.authAttempt(old, { session });
    assert.strictEqual(last(old).t, "auth_err", "старый сеанс продолжает работать после смены PIN");
    const closed = conn();
    b.authAttempt(closed, { pair: oldPair });
    assert.strictEqual(last(closed).t, "auth_err", "старый QR-код продолжает работать после смены PIN");
  });

  await test("PIN остаётся запасным путём и по-прежнему защищён от перебора", () => {
    const b = mk("482913");
    const c = conn();
    b.authAttempt(c, { pin: "482913" });
    assert.strictEqual(last(c).t, "auth_ok", "PIN перестал пускать — запасного пути не осталось");
    assert.strictEqual(last(c).session, undefined, "PIN выдал сеанс: телефону не нужен второй вход");

    // Перебор PIN: десять неудач в окне — блокировка, а не тишина.
    const bad = mk("482913");
    const tries = conn();
    for (let i = 0; i < 9; i++) bad.authAttempt(tries, { pin: "000000" });
    const denials = tries.sent.filter((m) => m.t === "auth_err");
    assert.strictEqual(denials.length, 9, "отказы не доехали до телефона: " + kinds(tries));
    assert.ok(denials.every((m) => m.lock === false), "блокировка включилась раньше времени");
    bad.authAttempt(tries, { pin: "000000" });
    const allDenials = tries.sent.filter((m) => m.t === "auth_err");
    assert.strictEqual(allDenials[allDenials.length - 1].lock, true, "перебор не заблокирован");
    const locked = conn();
    bad.authAttempt(locked, { pin: "482913" });
    assert.strictEqual(last(locked).lock, true, "правильный PIN прошёл во время блокировки");
    assert.strictEqual(locked.authed, false, "вход состоялся, несмотря на блокировку");
  });

  await test("пустой PIN в настройках не пускает никого", () => {
    // Мост без PIN (настройки ещё не заполнены) не должен становиться «открытым».
    const b = mk("");
    b.pin = "";
    for (const msg of [{ pin: "" }, { pin: "000000" }, { pair: "" }, { session: "" }]) {
      const c = conn();
      b.authAttempt(c, msg);
      assert.strictEqual(c.authed, false, "пустой вход открыл доступ: " + JSON.stringify(msg));
    }
  });

  await test("соединение после пяти попыток рвётся, а не висит для подбора", () => {
    const b = mk("482913");
    const c = conn();
    for (let i = 0; i < 5; i++) b.authAttempt(c, { pin: "000000" });
    assert.strictEqual(c.destroyed, true, "подбирающее соединение не разорвано");
    assert.ok(kinds(c).indexOf("auth_lock") >= 0, "телефону не сказано о разрыве: " + kinds(c));
  });

  await test("статус для ПК и для телефона — разный состав", () => {
    const b = mk();
    const forPc = b.status();
    assert.ok(forPc.pin && forPc.pair, "ПК не получил данные для QR-кода");
    assert.strictEqual(forPc.pairUsed, false);
    const forPhone = b.status({ client: true });
    assert.strictEqual(forPhone.pin, undefined, "телефону ушёл PIN");
    assert.strictEqual(forPhone.pair, undefined, "телефону ушёл токен пары");
  });

  await test("токен пары не переписывается на каждое сохранение настроек", () => {
    // Иначе QR-код на экране гас бы от любой галочки в настройках.
    const b = mk();
    const before = b.pair;
    b.applySettings({ mobileEnabled: true, mobilePin: "111111" });
    assert.strictEqual(b.pair, before, "сохранение настроек сменило токен пары");
    assert.strictEqual(b.ensurePair(), before, "токен пары меняется при чтении");
  });

  await test("телефонная сторона знает новые поля (контракт не разъехался)", () => {
    const api = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    assert.ok(/pairFromLocation/.test(api), "телефон не разбирает токен пары из адреса");
    assert.ok(/"#pair="|#pair=/.test(api) || /pair=\\w/.test(api), "телефон не ищет #pair= в ссылке");
    assert.ok(/\{ t: "auth", pair: authSecret\.value \}/.test(api), "телефон не отправляет токен пары");
    assert.ok(/\{ t: "auth", session: authSecret\.value \}/.test(api), "телефон не переподключается по сеансу");
    assert.ok(/storeSession\(m\.session\)/.test(api), "телефон не сохраняет выданный сеанс");
    assert.ok(/staleSession/.test(api) && /badPair/.test(api), "телефон не понимает причину отказа");
    const panel = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-panel.js"), "utf8");
    assert.ok(/\/#pair=" \+ pair/.test(panel), "ПК строит QR-код не с токеном пары");
    assert.ok(/pair \? urls\[0\]\.url \+ "\/#pair=" \+ pair : urls\[0\]\.url \+ "\/#pin=" \+ pin/.test(panel), "нет запаса на случай старого моста без токена");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

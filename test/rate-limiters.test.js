"use strict";

/* ── Держатели темпа провайдера (src/rate-limiters.js) ────────────────────────
   Запуск: node test/rate-limiters.test.js   (входит в общий `npm test`)

   Модуль вынесен из оболочки (этап B, заход 3). Здесь проверяется то, ради чего он
   существует, а не «функция на месте»:

   • лимитер ОДИН на пару «провайдер+модель» и ОБЩИЙ для всех прогонов: свой лимитер
     на прогон означал бы, что «Стоп» и новый запуск шлют запросы сразу и снова
     ловят 429 (это и была жалоба «после Стоп не работает»);
   • разные модели/провайдеры не мешают друг другу: у бесплатных тарифов лимит
     привязан к модели, и общий счётчик на все модели только вредил бы;
   • секрет не попадает в ключ карты (карту видно в отладке), хотя поведение то же;
   • вместо тихой поломки — честная ошибка, если ядро не передано.

   Лимитер берётся НАСТОЯЩИЙ (ядро агента): подделка не показала бы, что пауза после
   429 действительно запоминается и что она одна на все прогоны. */

const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRateLimiters } = require(path.join(ROOT, "src", "rate-limiters.js"));
const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
const MAIN_SRC = require("fs").readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = require("fs").readFileSync(path.join(ROOT, "src", "rate-limiters.js"), "utf8");

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

const mk = () => createRateLimiters({ createRateLimiter: () => core.createRateLimiter() });

(async () => {
  await test("1. один лимитер на «провайдер+модель» и общий для всех прогонов", () => {
    const { rateLimiterFor } = mk();
    const settings = { provider: "openai", model: "gpt-4o-mini" };
    const first = rateLimiterFor(settings);
    // Другой прогон — те же настройки: это ТОТ ЖЕ лимитер, иначе «Стоп» + новый
    // запуск рвут темп и провайдер отвечает 429.
    const second = rateLimiterFor({ provider: "openai", model: "gpt-4o-mini" });
    assert.strictEqual(first, second, "второй прогон получил свой лимитер вместо общего");
    assert.ok(first && typeof first.take === "function", "лимитер без take()");
  });

  await test("2. пауза после 429, запомненная одним прогоном, действует и для следующего", async () => {
    const { rateLimiterFor } = mk();
    const settings = { provider: "openai", model: "gpt-4o-mini" };
    rateLimiterFor(settings).note({ retryMs: 5000 });
    const fromAnotherRun = rateLimiterFor(settings);
    assert.ok(fromAnotherRun.pendingMs() > 0, "пауза после 429 не дошла до следующего прогона");
    // И темп реально выдерживается: первый запрос ждёт, второй — нет.
    const other = rateLimiterFor({ provider: "openai", model: "другая-модель" });
    assert.strictEqual(other.pendingMs(), 0, "пауза одного провайдера перенеслась на другой");
  });

  await test("3. разные модели и провайдеры не мешают друг другу", () => {
    const { rateLimiterFor, rateLimiterKeys } = mk();
    const a = rateLimiterFor({ provider: "openai", model: "a" });
    const b = rateLimiterFor({ provider: "openai", model: "b" });
    const c = rateLimiterFor({ provider: "anthropic", model: "a" });
    assert.notStrictEqual(a, b, "две модели одного провайдера получили один лимитер");
    assert.notStrictEqual(a, c, "два провайдера с одной моделью получили один лимитер");
    assert.deepStrictEqual(rateLimiterKeys(), ["openai|a", "openai|b", "anthropic|a"], "ключи карты: " + rateLimiterKeys());
  });

  await test("4. ключ карты — провайдер и модель, без секрета и с разумным значением по умолчанию", () => {
    const { rateLimiterFor, rateLimiterKeys } = mk();
    rateLimiterFor({ provider: "openai", model: "m", openaiApiKey: "sk-ЭТОТ-СЕКРЕТ-НЕ-ДОЛЖЕН-ПОПАСТЬ" });
    rateLimiterFor({});
    assert.ok(rateLimiterKeys().indexOf("openai|m") >= 0, "нет ключа провайдер+модель: " + rateLimiterKeys());
    assert.ok(rateLimiterKeys().indexOf("openai|") >= 0, "пустые настройки не дали значения по умолчанию: " + rateLimiterKeys());
    for (const key of rateLimiterKeys()) {
      assert.strictEqual(key.indexOf("sk-"), -1, "в ключ карты попал ключ доступа: " + key);
    }
    // Те же настройки, но с другим ключом доступа, — ТОТ ЖЕ держатель темпа:
    // иначе смена ключа в настройках обнуляла бы паузу после 429.
    const before = rateLimiterFor({ provider: "openai", model: "m" });
    const after = rateLimiterFor({ provider: "openai", model: "m", openaiApiKey: "sk-другой" });
    assert.strictEqual(before, after, "смена ключа доступа создала второй лимитер");
  });

  await test("5. без ядра модуль честно отказывает, а не работает без темпа", () => {
    assert.throws(() => createRateLimiters({}), /createRateLimiter/, "модуль собрался без ядра");
    assert.throws(() => createRateLimiters(), /createRateLimiter/, "модуль собрался вообще без зависимостей");
  });

  await test("6. в оболочке осталась только сборка: карта живёт в модуле, а не в main.js", () => {
    assert.ok(!/function rateLimiterFor\(/.test(MAIN_SRC), "в main.js осталась сама функция держателя темпа");
    assert.ok(!/rateLimiters = new Map\(\)/.test(MAIN_SRC), "в main.js осталась карта лимитеров");
    assert.ok(/const \{ rateLimiterFor \} = createRateLimiters\(\{ createRateLimiter \}\);/.test(MAIN_SRC),
      "оболочка не собирает держатели темпа из модуля");
    // Держатель уходит в прогон значением: прогон не собирает свой (иначе «Стоп»
    // и новый запуск рвут темп).
    assert.ok(/^\s*rateLimiterFor,\s*$/m.test(MAIN_SRC), "держатель темпа не передан в прогон");
    // Карта — в замыкании фабрики: иначе её не переживёт ни один перезапуск сборки.
    assert.ok(/const byKey = new Map\(\);/.test(MODULE_SRC), "карта лимитеров не в модуле");
    assert.ok(!/^let |^var /m.test(MODULE_SRC), "в модуле завелось состояние уровня файла");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

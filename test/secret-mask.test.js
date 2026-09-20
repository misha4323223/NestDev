"use strict";

/* ── Секреты в настройках: заглушки для чужого клиента (src/secret-mask.js) ────
   Запуск: node test/secret-mask.test.js   (входит в общий `npm test`)

   Ошибка здесь тихая сразу в двух направлениях:

     • мало замаскировать — телефон, сохранив любую галочку, отправит обратно
       заглушки, и они запишутся ВМЕСТО настоящих ключей. Приложение продолжит
       работать, а провайдер однажды ответит «неверный ключ» — и искать будут
       где угодно, кроме сохранения настроек;
     • можно замаскировать лишнее — интерфейсу станет нечего показывать, и
       человек увидит пустые поля там, где значение есть.

   Поэтому проверяются обе стороны по отдельности: что уходит телефону, что
   остаётся окну, и что сохранение с телефона ничего не стирает. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

const mask = require(path.join(ROOT, "src", "secret-mask.js"));
const secrets = require(path.join(ROOT, "src", "secrets.js"));

// Настройки со всеми видами секретов сразу: строки, объект переменных агента,
// список паролей сайтов и сохранённые подключения с ключом внутри.
const SETTINGS = () => ({
  workingDir: "/proj",
  model: "qwen3:8b",
  provider: "openai",
  openaiUrl: "https://api.groq.com/openai/v1",
  openaiApiKey: "sk-живой-ключ",
  anthropicApiKey: "sk-ant-ключ",
  visionKey: "v-ключ",
  serperApiKey: "s-ключ",
  githubToken: "ghp-токен",
  yandexOauthToken: "y0-токен",
  mailPassword: "пароль-почты",
  mobilePin: "482913",
  agentEnv: { TOKEN: "значение-переменной", CITY: "Москва" },
  agentEnvScopes: { TOKEN: ["terminal"] },
  sitePasswords: [
    { id: "v1", name: "банк", url: "https://bank", login: "я", password: "пароль-сайта", note: "заметка" },
    { id: "v2", name: "почта", login: "я", password: "" }, // пустой пароль: не выдумываем значение
  ],
  openaiProfiles: [
    { id: "p1", name: "своё", url: "http://localhost:1/v1", apiKey: "ключ-профиля", model: "m" },
    { id: "p2", name: "без ключа", url: "http://localhost:2/v1", apiKey: "" },
  ],
  projects: [{ id: "p1", name: "проект", dir: "/proj" }],
});

(async () => {
  console.log("Секреты в настройках: заглушки вместо значений (secret-mask)");

  await test("маска накрывает все секреты из хранилища, а не только ключи OpenAI", () => {
    const m = mask.maskSecrets(SETTINGS());
    for (const k of secrets.SECRET_KEYS) {
      if (k === "agentEnv" || k === "sitePasswords" || k === "openaiProfiles") continue;
      assert.strictEqual(m[k], mask.MASK, "секрет уехал без маски: " + k);
    }
    assert.strictEqual(m.agentEnv.TOKEN, mask.MASK, "значение переменной агента уехало");
    assert.strictEqual(m.sitePasswords[0].password, mask.MASK, "пароль сайта уехал");
    assert.strictEqual(m.openaiProfiles[0].apiKey, mask.MASK, "ключ подключения уехал");
  });

  await test("после маски видно, что поле заполнено, но не видно чем", () => {
    const m = mask.maskSecrets(SETTINGS());
    assert.ok(m.openaiApiKey, "маска ложная — интерфейс покажет «ключа нет»");
    assert.strictEqual(m.openaiApiKey.indexOf("sk-"), -1, "в маске остался кусок ключа");
    assert.strictEqual(m.agentEnv.TOKEN.indexOf("значение"), -1, "в маске осталось значение");
    assert.strictEqual(m.sitePasswords[0].password.indexOf("пароль"), -1, "в маске остался пароль");
    assert.strictEqual(JSON.stringify(m).indexOf("живой-ключ"), -1, "ключ нашёлся в сериализованных настройках");
  });

  await test("то, чем живёт интерфейс, остаётся нетронутым", () => {
    const m = mask.maskSecrets(SETTINGS());
    assert.strictEqual(m.workingDir, "/proj");
    assert.strictEqual(m.model, "qwen3:8b");
    assert.strictEqual(m.openaiUrl, "https://api.groq.com/openai/v1");
    assert.deepStrictEqual(Object.keys(m.agentEnv).sort(), ["CITY", "TOKEN"], "пропали имена переменных");
    assert.deepStrictEqual(m.agentEnvScopes, { TOKEN: ["terminal"] }, "пропали правила выдачи переменных");
    assert.strictEqual(m.sitePasswords[0].name, "банк", "пропала подпись записи паролей");
    assert.strictEqual(m.sitePasswords[0].note, "заметка", "пропала заметка записи паролей");
    assert.strictEqual(m.sitePasswords[1].password, "", "пустое значение заменено маской — человек увидит «заполнено»");
    assert.strictEqual(m.openaiProfiles[1].apiKey, "", "пустой ключ подключения заменён маской");
    assert.strictEqual(m.openaiProfiles[0].url, "http://localhost:1/v1", "пропал адрес подключения");
    assert.deepStrictEqual(m.projects, SETTINGS().projects, "пропали проекты");
  });

  await test("маска не портит исходник: настройки в оболочке остаются с ключами", () => {
    const before = SETTINGS();
    const copy = JSON.parse(JSON.stringify(before));
    mask.maskSecrets(before);
    assert.deepStrictEqual(before, copy, "маскирование изменило сами настройки — окно потеряло бы ключи");
  });

  await test("сохранение с телефона: заглушки разворачиваются в прежние значения", () => {
    const prev = SETTINGS();
    // Телефон присылает то, что получил, плюс свои правки: модель, одну
    // переменную агента и новую запись пароля с настоящим паролем.
    const incoming = mask.maskSecrets(SETTINGS());
    incoming.model = "llama3";
    incoming.agentEnv.CITY = "Казань";
    incoming.sitePasswords.push({ id: "v3", name: "новый сайт", login: "я", password: "новый-пароль" });
    const out = mask.restoreMasked(incoming, prev);

    assert.strictEqual(out.openaiApiKey, "sk-живой-ключ", "ключ не вернулся — сохранение стёрло бы его");
    assert.strictEqual(out.githubToken, "ghp-токен", "токен не вернулся");
    assert.strictEqual(out.mobilePin, "482913", "PIN не вернулся");
    assert.strictEqual(out.agentEnv.TOKEN, "значение-переменной", "значение нетронутой переменной не вернулось");
    assert.strictEqual(out.agentEnv.CITY, "Казань", "правка телефона потерялась");
    assert.strictEqual(out.model, "llama3", "обычное поле потерялось");
    assert.strictEqual(out.sitePasswords[0].password, "пароль-сайта", "пароль прежней записи не вернулся");
    assert.strictEqual(out.sitePasswords[2].password, "новый-пароль", "новый пароль с телефона потерялся");
    assert.strictEqual(out.openaiProfiles[0].apiKey, "ключ-профиля", "ключ подключения не вернулся");
  });

  await test("заглушка на поле, которого раньше не было, не превращается в значение", () => {
    // Клиент мог прислать маску для поля, которого в настройках нет (старая
    // версия, чужой объект): сохранять строку из точек нельзя.
    const out = mask.restoreMasked({ model: "x", openaiApiKey: mask.MASK, agentEnv: { NEW: mask.MASK } }, { model: "y" });
    assert.strictEqual("openaiApiKey" in out, false, "заглушка сохранена как значение");
    assert.deepStrictEqual(out.agentEnv, {}, "пустая переменная агента сохранена заглушкой");
  });

  await test("настоящее значение, случайно состоящее из точек, не считается заглушкой", () => {
    // Проверка нужна, чтобы «восстановить прежнее» не сработало на реальном
    // ключе, который просто похож на заглушку по виду.
    const real = "•••••••••"; // девять точек — не наша заглушка (их восемь)
    const out = mask.restoreMasked({ openaiApiKey: real }, { openaiApiKey: "старый" });
    assert.strictEqual(out.openaiApiKey, real, "настоящее значение подменено прежним");
    assert.strictEqual(mask.MASK.length, 8, "формат заглушки изменился");
  });

  await test("пустой и сломанный вход не роняет проверку", () => {
    assert.strictEqual(mask.maskSecrets(null), null);
    assert.deepStrictEqual(mask.maskSecrets({}), {});
    assert.strictEqual(mask.restoreMasked(null, {}), null);
    assert.deepStrictEqual(mask.restoreMasked({}, null), {});
    // Записи без id (испорченный файл настроек) не должны ломать восстановление.
    const out = mask.restoreMasked({ sitePasswords: [{ password: mask.MASK }] }, { sitePasswords: [{ password: "x" }] });
    assert.strictEqual(out.sitePasswords[0].password, "", "запись без id получила чужой пароль");
  });

  await test("проводка: каналы настроек действительно пользуются маской", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "settings-ipc.js"), "utf8");
    assert.ok(/maskSecrets\(s\)/.test(src), "settings:get не маскирует секреты");
    assert.ok(/maskSecrets\(merged\)/.test(src), "ответ settings:set уходит без маски — ключи вернулись бы тем же путём");
    assert.ok(/restoreMasked\(s0, prev\)/.test(src), "settings:set не разворачивает заглушки перед слиянием");
    // Маска должна быть применена ДО слияния с прежними настройками: иначе
    // заглушки уже попали бы в merged и сохранение стёрло бы ключи.
    assert.ok(src.indexOf("restoreMasked(s0, prev)") < src.indexOf("normalizeSettings({ ...prev"), "заглушки разворачиваются после слияния");
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(/const secretMask = require\("\.\/secret-mask\.js"\)/.test(main), "main.js не подключает модуль маски");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

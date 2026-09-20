"use strict";

/* ── Куда главному процессу можно ходить (src/net-guard.js) ───────────────────
   Запуск: node test/net-guard.test.js   (входит в общий `npm test`)

   Зачем свой набор. Проверка адреса — это место, где ошибка НЕ видна снаружи:
   если правило слишком узкое, человек получает «адрес провайдера не годится» на
   живой Ollama (и уходит искать поломку в модели); если слишком широкое — через
   канал ai:test главный процесс сходит на метаданные облака и вернёт ответ окну.
   Поэтому проверяются обе стороны: что законные адреса проходят и что обходные
   формы одного и того же запрещённого адреса не проходят.

   Отдельная часть — ОБРАТНАЯ проверка проводки: сами по себе правила бесполезны,
   если канал их не зовёт. Набор читает исходники каналов и требует, чтобы каждый
   путь «адрес от интерфейса → fetch из главного процесса» шёл через проверку. */

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

const guard = require(path.join(ROOT, "src", "net-guard.js"));
const src = (f) => fs.readFileSync(path.join(ROOT, "src", f), "utf8");

const ok = (url, why) => {
  const r = guard.checkUrl(url);
  assert.strictEqual(r.ok, true, (why || "должен быть разрешён") + ": " + url + " → " + (r.error || ""));
};

const bad = (url, why) => {
  const r = guard.checkUrl(url);
  assert.strictEqual(r.ok, false, (why || "должен быть запрещён") + ": " + url);
  assert.ok(r.error && r.error.length > 10, "у отказа нет внятного текста: " + JSON.stringify(r));
};

(async () => {
  console.log("Куда главному процессу можно ходить (net-guard)");

  await test("законные адреса провайдеров проходят: облако, localhost, домашняя сеть", () => {
    ok("https://api.groq.com/openai/v1");
    ok("https://openrouter.ai/api/v1");
    ok("http://localhost:11434");
    ok("http://127.0.0.1:8080/v1");
    ok("http://192.168.1.5:1337/v1");
    ok("http://10.0.0.7:1234/v1");
    ok("http://[::1]:11434", "локальная петля по IPv6");
    ok("http://my-nas.local:1234/v1", "имя в домашней сети");
  });

  await test("чужие схемы отсекаются: file, ftp, data, javascript", () => {
    bad("file:///etc/passwd");
    bad("ftp://example.com/x");
    bad("data:text/plain;base64,QQ==");
    bad("javascript:fetch('http://x')");
    bad("", "пустая строка");
    bad("   ", "одни пробелы");
    bad("не адрес вовсе");
  });

  await test("учётные данные в адресе не допускаются (утекли бы в логи и ошибки)", () => {
    bad("http://user:secret@api.example.com/v1");
    bad("https://token@api.example.com/v1");
  });

  await test("облачные метаданные запрещены и по имени, и по адресу", () => {
    bad("http://169.254.169.254/latest/meta-data/");
    bad("http://169.254.169.254./latest/meta-data/", "хвостовая точка — тот же узел");
    bad("http://169.254.0.1/");
    bad("http://metadata.google.internal/computeMetadata/v1/");
    bad("http://metadata/");
    bad("http://instance-data/");
  });

  await test("числовые формы одного и того же адреса не обходят правило", () => {
    // 2852039166 = 0xA9FEA9FE = 169.254.169.254 — именно так это и обходится.
    bad("http://2852039166/latest/meta-data/", "одно число вместо точек");
    bad("http://0xA9FEA9FE/latest/meta-data/", "шестнадцатеричная запись");
    bad("http://0251.0376.0251.0376/latest/meta-data/", "восьмеричные части");
    assert.strictEqual(guard.ipv4FromNumeric("2852039166"), "169.254.169.254", "разбор числа сломан");
    assert.strictEqual(guard.ipv4FromNumeric("0xA9FEA9FE"), "169.254.169.254", "разбор 0x сломан");
    // Ловушка, которую проверили отдельно: «две части» (http://169.254/) — это НЕ
    // 169.254.0.0. Разборщик адресов дочитывает такое как 169.0.0.254, и запрещать
    // его не за что. Записано, чтобы ужесточение правила однажды не сломало живой адрес.
    const two = guard.checkUrl("http://169.254/");
    assert.strictEqual(two.ok, true, "169.254 — это 169.0.0.254, а не link-local");
    assert.ok(/\.254\b|169\.0\.0\.254/.test(two.url), "разбор двух частей изменился: " + two.url);
  });

  await test("IPv6: link-local и mapped-адреса запрещены, петля разрешена", () => {
    bad("http://[fe80::1]:8080/");
    bad("http://[::ffff:169.254.169.254]/latest/meta-data/", "тот же 169.254 в IPv6-обёртке");
    // Разборщик приводит вложенный IPv4 к двум группам по два байта — проверка
    // обязана знать и эту запись, иначе обход делается одной строкой.
    assert.strictEqual(new URL("http://[::ffff:169.254.169.254]/x").hostname, "[::ffff:a9fe:a9fe]",
      "узел перестал приводить mapped-адрес к шестнадцатеричному виду — проверь правило");
    bad("http://[::ffff:a9fe:a9fe]/latest/meta-data/", "шестнадцатеричная запись того же адреса");
    bad("http://[::]/");
    ok("http://[::1]:9090/", "петля — это localhost");
    assert.strictEqual(guard.ipv4FromMappedIpv6("::ffff:a9fe:a9fe"), "169.254.169.254", "разбор mapped-адреса сломан");
  });

  await test("служебные «никакие» адреса запрещены", () => {
    bad("http://0.0.0.0:1234/v1");
    bad("http://255.255.255.255/");
    assert.strictEqual(guard.isBlockedHost("169.254.169.254"), true, "169.254 не опознан");
    assert.strictEqual(guard.isBlockedHost("api.groq.com"), false, "обычный домен опознан как служебный");
  });

  await test("проверка настроек: ловит подменённое поле и не мешает обычным", () => {
    const good = {
      provider: "openai",
      openaiUrl: "https://api.groq.com/openai/v1",
      ollamaUrl: "http://localhost:11434",
      visionUrl: "",
    };
    assert.strictEqual(guard.checkSettingsUrls(good).ok, true, "обычные настройки не проходят проверку");
    assert.strictEqual(guard.checkSettingsUrls({}).ok, true, "пустые настройки не проходят проверку");

    // Ровно та подмена, против которой стоит проверка: окно присылает свой URL.
    const evil = { ...good, visionUrl: "http://169.254.169.254/latest/meta-data/" };
    const r = guard.checkSettingsUrls(evil);
    assert.strictEqual(r.ok, false, "подмена visionUrl не поймана");
    assert.ok(/visionUrl/.test(r.error), "в отказе не названо поле: " + r.error);
    assert.ok(!/169\.254\.169\.254/.test(r.error) || /служебный/.test(r.error), "отказ не объясняет причину");
  });

  await test("проводка: каждый канал с адресом от интерфейса идёт через проверку", () => {
    const runIpc = src("run-ipc.js");
    const modelIpc = src("model-ipc.js");
    const mainSrc = src("main.js");

    // ai:test — настройки из интерфейса → fetchModels в главном процессе.
    const aiTest = runIpc.slice(runIpc.indexOf('ipcMain.handle("ai:test"'));
    assert.ok(/netGuard\.checkSettingsUrls\(s\)/.test(aiTest), "ai:test не проверяет адрес");
    assert.ok(
      aiTest.indexOf("netGuard.checkSettingsUrls") < aiTest.indexOf("await fetchModels(s)"),
      "проверка в ai:test стоит ПОСЛЕ запроса — толку от неё нет"
    );

    // ai:models и ai:probeLocal — тот же путь с тем же присланным объектом.
    for (const ch of ["ai:models", "ai:probeLocal"]) {
      const at = modelIpc.indexOf('ipcMain.handle("' + ch + '"');
      assert.ok(at > 0, "не найден канал " + ch);
      const body = modelIpc.slice(at, at + 700);
      assert.ok(/netGuard\.checkSettingsUrls\(s\)/.test(body), ch + " не проверяет адрес настроек");
    }

    // g4f:probe и g4f:test — адрес приходит прямо аргументом.
    for (const ch of ["g4f:probe", "g4f:test"]) {
      const at = modelIpc.indexOf('ipcMain.handle("' + ch + '"');
      assert.ok(at > 0, "не найден канал " + ch);
      const body = modelIpc.slice(at, at + 1600);
      assert.ok(/netGuard\.checkUrl\(/.test(body), ch + " не проверяет присланный адрес");
    }

    // Модуль обязан прийти в каналы от сборки: без этого проверка молча не работает.
    for (const reg of ["registerRunIpc({", "registerModelIpc({"]) {
      const at = mainSrc.indexOf(reg);
      assert.ok(at > 0, "не найдена сборка " + reg);
      const body = mainSrc.slice(at, at + 900);
      assert.ok(/\bnetGuard,/.test(body), "в " + reg + " не передан netGuard");
    }
    assert.ok(/require\("\.\/net-guard\.js"\)/.test(mainSrc), "main.js не подключает net-guard");
  });

  await test("правило узкое нарочно: локальные модели не задеты", () => {
    // Регрессия, которую легко внести «ужесточением ради безопасности»: запретить
    // приватные сети. Тогда Ollama, G4F и LM Studio перестанут работать совсем.
    for (const local of [
      "http://localhost:11434",
      "http://127.0.0.1:1337/v1",
      "http://192.168.0.10:5000/v1",
      "http://172.16.5.4:11434",
      "http://100.64.0.1:11434", // CGNAT/Tailscale-подобный адрес — тоже законный провайдер
    ]) {
      ok(local, "локальный адрес не должен запрещаться");
    }
  });

  console.log("");
  if (failed) {
    console.error("Итог: " + passed + " прошло, " + failed + " упало");
    process.exit(1);
  }
  console.log("Итог: " + passed + " прошло, 0 упало");
})();

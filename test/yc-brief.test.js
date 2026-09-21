"use strict";

/* ─── Строка Yandex Cloud для визитки проекта (src/yc-service.js) ─────────────
   Запуск: node test/yc-brief.test.js   (входит в общий `npm test`)

   До переноса (этап B, заход 3) эта функция жила в src/main.js и своих проверок
   не имела вовсе: её видели только косвенно — через «каталог не выбран» в чужой
   проверке настроек. Между тем именно эта строка решает, что агент знает про
   облако: подставленный устаревший снимок настроек или пустая строка — и агент
   идёт «выбирать каталог», который уже выбран (та самая жалоба).

   Проверяем СМЫСЛ, а не расположение:
   • ветка «каталог НЕ выбран» — дословно, потому что её читает модель;
   • разрешения создания/удаления — словами «разрешено» / «ЗАПРЕЩЕНО»;
   • любая поломка внутри (настройки не читаются) — пустая строка, а не падение
     визитки: строка необязательная, и падать из-за неё сборка проекта не должна. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.log("  ✗ " + name + "\n    " + ((e && e.message) || e));
  }
}

const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));

// Сервис собирается без настоящих зависимостей: строка облака ничего, кроме
// настроек, не трогает — в этом и смысл переноса рядом с ycConfig.
function mk(settings) {
  const svc = createYcService({
    app: {}, path, net: {}, secrets: {}, yandexCloud: {}, ycCli: {}, ycLogs: {}, ycEnsurePath: () => "",
    loadSettings: () => settings,
  });
  return svc;
}

(async () => {
  await test("1. без токена строки нет вовсе (агент не читает про облако, которого нет)", () => {
    const svc = mk({});
    assert.strictEqual(svc.ycBriefLine({}), "", "строка появилась без авторизации");
    assert.strictEqual(svc.ycBriefLine({ yandexOauthToken: "   " }), "", "пробелы сошли за токен");
  });

  await test("2. каталог НЕ выбран — дословная строка с путём в настройки", () => {
    const svc = mk({});
    const line = svc.ycBriefLine({ yandexOauthToken: "t" });
    assert.strictEqual(
      line,
      "Yandex Cloud: подключён, каталог НЕ выбран — попроси пользователя выбрать каталог в Настройках → «☁️ Yandex Cloud».",
      "формулировка ветки «каталог не выбран» разошлась — модель читает её дословно"
    );
  });

  await test("3. каталог выбран: имя, id, облако и оба разрешения словами", () => {
    const svc = mk({});
    const line = svc.ycBriefLine({
      yandexOauthToken: "t", ycFolderId: "b1gfolder", ycFolderName: "prod", ycCloudId: "b1gcloud",
      ycAllowAgentCreate: true, ycAllowAgentDelete: false,
    });
    assert.ok(line.includes("каталог «prod» (b1gfolder)"), "нет имени и id каталога: " + line);
    assert.ok(line.includes(", облако b1gcloud"), "нет облака: " + line);
    assert.ok(line.includes("создание ресурсов агентом разрешено"), "создание не разрешено словом: " + line);
    assert.ok(line.includes("удаление ЗАПРЕЩЕНО"), "удаление не запрещено словом: " + line);
  });

  await test("4. без имени каталога в строку идёт id, а не пустые кавычки", () => {
    const svc = mk({});
    const line = svc.ycBriefLine({ yandexOauthToken: "t", ycFolderId: "b1gfolder" });
    assert.ok(line.includes("каталог «b1gfolder» (b1gfolder)"), "нет подстановки id вместо имени: " + line);
    assert.ok(!line.includes("облако"), "облака нет — а строка про него есть: " + line);
  });

  await test("5. без аргумента настройки читаются через loadSettings (свежие, не снимок)", () => {
    // Именно так зовёт визитка: ycBriefLine(loadSettings()). Копия, застывшая при
    // сборке модуля, снова говорила бы «каталог не выбран» после выбора каталога.
    let calls = 0;
    let current = { yandexOauthToken: "t" };
    const svc = createYcService({
      app: {}, path, net: {}, secrets: {}, yandexCloud: {}, ycCli: {}, ycLogs: {}, ycEnsurePath: () => "",
      loadSettings: () => { calls++; return current; },
    });
    assert.ok(svc.ycBriefLine().includes("каталог НЕ выбран"), "первый вызов не увидел настройки");
    current = { yandexOauthToken: "t", ycFolderId: "b1gfolder", ycFolderName: "prod" };
    assert.ok(svc.ycBriefLine().includes("каталог «prod»"), "строка осталась на старом снимке настроек");
    assert.strictEqual(calls, 2, "настройки спрошены не на каждый вызов");
  });

  await test("6. поломка чтения настроек — пустая строка, а не падение визитки", () => {
    const svc = createYcService({
      app: {}, path, net: {}, secrets: {}, yandexCloud: {}, ycCli: {}, ycLogs: {}, ycEnsurePath: () => "",
      loadSettings: () => { throw new Error("нет файла настроек"); },
    });
    assert.strictEqual(svc.ycBriefLine(), "", "падение чтения настроек вышло наружу");
    assert.strictEqual(svc.ycBriefLine(null), "", "падает на пустом аргументе");
  });

  await test("7. проводка: функция в сервисе, а не в оболочке; визитка берёт её отложенно", () => {
    const mainSrc = read("src", "main.js");
    const svcSrc = read("src", "yc-service.js");
    assert.ok(!/function ycBriefLine\(s\)/.test(mainSrc), "в оболочке осталась сама функция");
    assert.ok(/function ycBriefLine\(s\)/.test(svcSrc), "в сервисе нет строки облака");
    assert.ok(
      /ycBriefLine: \(\.\.\.args\) => ycService\.ycBriefLine\(\.\.\.args\)/.test(mainSrc),
      "визитка получает строку не из сервиса"
    );
    // Сервис собирается НИЖЕ визитки — значит, значение в момент сборки подставить
    // нельзя, иначе в визитку уйдёт undefined и строка облака исчезнет молча.
    assert.ok(
      mainSrc.indexOf("const { createProjectBrief } = require(\"./project-brief.js\");") <
        mainSrc.indexOf("const ycService = createYcService("),
      "сервис поднялся ВЫШЕ визитки — отложенная стрелка больше не нужна, проверку пора переписать"
    );
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

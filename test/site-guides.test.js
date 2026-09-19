"use strict";

/* ── Справочники по сайтам (src/site-guides.js) ───────────────────────────────
   Запуск: node test/site-guides.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 11). Здесь всё, что агент знает о
   сайтах и темах, и то, чем он пополняет это знание сам. Ошибки тут тихие:

     • справочник не находится — агент заходит на сайт «с нуля» и теряет время;
     • выученный маршрут сохраняется не туда (или поверх встроенного) — знание
       пропадает при обновлении кода;
     • гайд не подхватывается по адресу — агент не узнаёт, что маршрут уже есть.

   Проверяем на настоящих файлах и настоящих папках: встроенный набор берём
   прямо из `src/agent-guides`, выученный — во временной папке приложения. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { createSiteGuides } = require(path.join(ROOT, "src", "site-guides.js"));
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

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "site-guides.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");
// Автоподключение справочника группы (guideReadText(gname)) уехало вместе с роутером
// инструментов в src/run-tools.js (этап B, часть 15) — ищем там, где оно живёт.
const TOOLS_SRC = read("src", "run-tools.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-guides-"));
const learnedDir = path.join(root, "agent-guides");
const builtinDir = path.join(root, "builtin");
fs.mkdirSync(learnedDir, { recursive: true });
fs.mkdirSync(builtinDir, { recursive: true });

// Выученный справочник с тем же именем, что и встроенный: он обязан победить.
fs.writeFileSync(path.join(learnedDir, "vk.md"), "# ВК (мой маршрут)\n\n<!-- sites: vk.com -->\n---\n## 2026-09-01 — пройдено успешно\nсвои селекторы\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "vk.md"), "# ВК (встроенный)\n\n<!-- sites: vk.com, m.vk.com -->\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "google-cloud.md"), "# Google Cloud Console: как пройти типовые задачи\n\n<!-- sites: console.cloud.google.com, cloud.google.com -->\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "github.md"), "# GitHub\n\n<!-- sites: github.com, gist.github.com, github.dev -->\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "portal.md"), "# Портал\n\n<!-- sites: portal.example.com -->\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "no-head.md"), "без заголовка и без сайтов\n", "utf8");
fs.writeFileSync(path.join(builtinDir, "note.txt"), "не справочник\n", "utf8");
fs.mkdirSync(path.join(builtinDir, "subdir.md"), { recursive: true }); // папка с «именем справочника»

// Папка приложения — как у Electron: справочники лежат в её подпапке agent-guides.
const guides = createSiteGuides({
  fs,
  path,
  userDataDir: () => root,
  builtinDir,
});

// Настоящий встроенный набор — тот, что едет в сборку.
const real = createSiteGuides({
  fs,
  path,
  userDataDir: () => path.join(root, "пусто-приложения"),
  builtinDir: path.join(ROOT, "src", "agent-guides"),
});

(async () => {
  await test("индекс: выученные и встроенные вместе, выученный важнее встроенного", () => {
    const list = guides.guideIndex();
    const names = list.map((g) => g.name);
    assert.deepStrictEqual(names.filter((n) => n === "vk").length, 1, "справочник «vk» показан дважды: " + JSON.stringify(names));
    const vk = list.find((g) => g.name === "vk");
    assert.strictEqual(vk.title, "ВК (мой маршрут)", "выученный маршрут не перекрыл встроенный: " + vk.title);
    assert.strictEqual(vk.learned, true, "выученный маршрут не помечен своим");
    const gcloud = list.find((g) => g.name === "google-cloud");
    assert.strictEqual(gcloud.learned, false, "встроенный справочник помечен выученным");
    assert.deepStrictEqual(gcloud.sites, ["console.cloud.google.com", "cloud.google.com"], "сайты разобраны неверно: " + JSON.stringify(gcloud.sites));
    assert.ok(!names.includes("note"), "в индекс попал не-markdown файл");
    assert.ok(!names.includes("subdir.md"), "в индекс попала папка с «именем справочника»");
  });

  await test("индекс: файл без заголовка и без сайтов не роняет разбор", () => {
    const g = guides.guideIndex().find((x) => x.name === "no-head");
    assert.ok(g, "файл без заголовка потерялся");
    assert.strictEqual(g.title, "", "заголовок выдуман: " + JSON.stringify(g.title));
    assert.deepStrictEqual(g.sites, [], "сайты выдуманы: " + JSON.stringify(g.sites));
  });

  await test("индекс: папок нет — пусто, а не падение", () => {
    const empty = createSiteGuides({
      fs,
      path,
      userDataDir: () => path.join(root, "нет-такой"),
      builtinDir: path.join(root, "тоже-нет"),
    });
    assert.deepStrictEqual(empty.guideIndex(), [], "несуществующие папки дали записи");
    assert.strictEqual(empty.guideReadText("vk"), "", "текст нашёлся в несуществующей папке");
    assert.strictEqual(empty.guideForUrl("https://vk.com"), null, "гайд по адресу нашёлся без файлов");
  });

  await test("имя справочника: снимаем «agent-guide:», приводим к нижнему, выкидываем мусор", () => {
    assert.strictEqual(guides.guideSafeName("agent-guide:Google-Cloud"), "google-cloud", "префикс или регистр не снят");
    assert.strictEqual(guides.guideSafeName("  VK_2  "), "vk_2", "пробелы и подчёркивание потерялись");
    assert.strictEqual(guides.guideSafeName("../../etc/passwd"), "etcpasswd", "путь вылез наружу: " + guides.guideSafeName("../../etc/passwd"));
    assert.strictEqual(guides.guideSafeName("ВК"), "", "кириллическое имя не отброшено");
    assert.strictEqual(guides.guideSafeName(null), "", "null дал имя");
  });

  await test("путь к файлу: чтение ищет в двух папках, запись — только в папке приложения", () => {
    assert.strictEqual(guides.guideFilePath("vk", false), path.join(learnedDir, "vk.md"), "чтение не взяло выученный маршрут");
    assert.strictEqual(guides.guideFilePath("google-cloud", false), path.join(builtinDir, "google-cloud.md"), "чтение не нашло встроенный маршрут");
    assert.strictEqual(guides.guideFilePath("такого-нет", false), "", "найден несуществующий справочник");
    assert.strictEqual(guides.guideFilePath("New Site!", true), path.join(learnedDir, "newsite.md"), "запись ушла не в папку приложения");
    assert.ok(!guides.guideFilePath("New Site!", true).startsWith(builtinDir), "запись правит встроенный набор");
    assert.strictEqual(guides.guideFilePath("ВК", true), "", "кириллическое имя дало путь для записи");
  });

  await test("чтение текста: живой файл отдаётся, молчаливого «ничего» не бывает", () => {
    assert.ok(/мой маршрут/.test(guides.guideReadText("vk")), "выученный текст не прочитан");
    assert.ok(/Google Cloud/.test(guides.guideReadText("agent-guide:google-cloud")), "встроенный текст не прочитан с префиксом");
    assert.strictEqual(guides.guideReadText("нет-такого"), "", "выдуманный справочник дал текст");
  });

  await test("гайд по адресу: точный домен, поддомен, www и мусор", () => {
    assert.strictEqual(guides.guideForUrl("https://vk.com/im?sel=3").name, "vk", "точный домен не найден");
    assert.strictEqual(guides.guideForUrl("https://www.github.com/user/repo").name, "github", "www не снят");
    assert.strictEqual(guides.guideForUrl("https://console.cloud.google.com/apis").name, "google-cloud", "поддомен не подхватил справочник");
    assert.strictEqual(guides.guideForUrl("https://github.dev/x").name, "github", "второй сайт справочника не работает");
    // Поддомен, которого нет в списке дословно, обязан подхватить свой справочник.
    assert.strictEqual(guides.guideForUrl("https://admin.portal.example.com/dash").name, "portal", "поддомен не подхватил справочник");
    assert.strictEqual(guides.guideForUrl("https://other.net/x"), null, "чужой домен выдал справочник");
    assert.strictEqual(guides.guideForUrl("просто текст"), null, "мусор выдал справочник");
    assert.strictEqual(guides.guideForUrl(""), null, "пустая строка выдала справочник");
  });

  await test("list: перечисляет со сайтами, помечает свои; пусто — честный ответ", () => {
    const out = guides.agentGuideCall({ action: "list" });
    assert.ok(/• vk — ВК \(мой маршрут\) \[vk\.com\] \(мой, сохранён\)/.test(out), "своя строка показана неверно:\n" + out);
    assert.ok(/• google-cloud — .* \[console\.cloud\.google\.com, cloud\.google\.com\]/.test(out), "встроенная строка показана неверно:\n" + out);
    assert.ok(/agent-guide:google-cloud/.test(out) && /agentGuide \{ save:/.test(out), "в ответе нет подсказок, как читать и сохранять:\n" + out);
    const none = real.agentGuideCall({ action: "list", name: "" });
    assert.ok(typeof none === "string" && none.length > 0, "пустой список не ответил");
    const emptyGuides = createSiteGuides({ fs, path, userDataDir: () => path.join(root, "нет"), builtinDir: path.join(root, "нет") });
    assert.strictEqual(emptyGuides.agentGuideCall({ action: "list" }), "Справочников пока нет.", "пустой набор не признан пустым");
  });

  await test("read: находит свой маршрут, а без него называет, что есть", () => {
    const vk = guides.agentGuideCall({ name: "vk" });
    assert.ok(/^СПРАВОЧНИК АГЕНТА: «vk»/.test(vk), "заголовок ответа другой:\n" + vk.slice(0, 120));
    assert.ok(/мой маршрут/.test(vk), "текст справочника не отдан");
    const miss = guides.agentGuideCall({ name: "нет-такого" });
    assert.ok(/не найден/.test(miss), "отсутствие справочника не названо: " + miss);
    assert.ok(/vk/.test(miss) && /google-cloud/.test(miss), "в отказе нет списка доступных: " + miss);
    const bad = guides.agentGuideCall({ name: "ВК" });
    assert.ok(/не найден/.test(bad), "кириллическое имя не дало честного отказа: " + bad);
  });

  await test("match: подсказывает справочник по адресу, иначе — как искать самому", () => {
    const hit = guides.agentGuideCall({ url: "https://console.cloud.google.com/home" });
    assert.ok(/есть справочник «google-cloud»/.test(hit), "справочник по адресу не подсказан: " + hit);
    assert.ok(/agentGuide \{ name: "google-cloud" \}/.test(hit), "не сказано, как его прочитать: " + hit);
    // Адрес, к которому не подходит ни один справочник (сравнение идёт по вхождению
    // домена, поэтому берём чужой сайт, а не поддомен известного).
    const miss = guides.agentGuideCall({ url: "https://unknown-service.io/path" });
    assert.ok(/справочника нет/.test(miss) && /browserSnapshot/.test(miss), "нет честного ответа с планом: " + miss);
    assert.ok(/save/.test(miss), "не предложено сохранить маршрут: " + miss);
  });

  await test("save: создаёт папку, пишет маршрут и дописывает прошлый проход", () => {
    const first = guides.agentGuideCall({ save: "shop", title: "Магазин", sites: "shop.example.com", steps: "1) вход 2) корзина" });
    assert.ok(/^OK — маршрут сохранён/.test(first), "сохранение не подтверждено: " + first);
    const file = path.join(learnedDir, "shop.md");
    assert.ok(fs.existsSync(file), "файл маршрута не появился");
    const text = fs.readFileSync(file, "utf8");
    assert.ok(/^# Магазин$/m.test(text), "заголовок не записан:\n" + text);
    assert.ok(/<!-- sites: shop\.example\.com -->/.test(text), "сайты не записаны:\n" + text);
    assert.ok(/---\n## \d{4}-\d{2}-\d{2} — пройдено успешно\n1\) вход 2\) корзина/.test(text), "проход не записан:\n" + text);

    // Второй проход: старая запись обязана остаться, шапка — не задвоиться.
    guides.agentGuideCall({ save: "shop", steps: "3) оплата" });
    const again = fs.readFileSync(file, "utf8");
    assert.ok(/1\) вход 2\) корзина/.test(again), "прошлый проход потерян:\n" + again);
    assert.ok(/3\) оплата/.test(again), "новый проход не записан:\n" + again);
    assert.strictEqual((again.match(/^# /gm) || []).length, 1, "шапка задвоилась:\n" + again);
    assert.strictEqual((again.match(/пройдено успешно/g) || []).length, 2, "проходы не накопились:\n" + again);

    // Файл, которого нет, но имя годное — создаётся заново (папки может не быть).
    const deep = createSiteGuides({ fs, path, userDataDir: () => path.join(root, "новая-папка"), builtinDir });
    assert.ok(/^OK/.test(deep.agentGuideCall({ save: "deep", steps: "шаг" })), "новая папка не создана");
    assert.ok(fs.existsSync(path.join(root, "новая-папка", "agent-guides", "deep.md")), "файл в новой папке не появился");
  });

  await test("save: мусор на входе и сломанный диск объясняются, а не молчат", () => {
    const noSteps = guides.agentGuideCall({ save: "shop" });
    assert.ok(/нужны name .* и steps/.test(noSteps), "сохранение без шагов не объяснено: " + noSteps);
    const badName = guides.agentGuideCall({ save: "ВК", steps: "шаг" });
    assert.ok(/нужны name/.test(badName), "кириллическое имя принято: " + badName);
    const broken = createSiteGuides({
      fs: Object.assign({}, fs, { writeFileSync: () => { throw new Error("диск полон"); }, mkdirSync: () => {} }),
      path,
      userDataDir: () => root,
      builtinDir,
    });
    const err = broken.agentGuideCall({ save: "shop", steps: "шаг" });
    assert.ok(/не удалось сохранить справочник: диск полон/.test(err), "сбой записи не назван: " + err);
    const unknown = guides.agentGuideCall({ action: "телепорт" });
    assert.ok(/неизвестное действие/.test(unknown) && /list, read/.test(unknown), "неизвестное действие не объяснено: " + unknown);
  });

  await test("встроенный набор на месте: настоящие справочники читаются и подхватываются по адресу", () => {
    const list = real.guideIndex();
    assert.ok(list.length >= 8, "встроенных справочников стало меньше: " + list.length);
    for (const need of ["vk", "google-cloud", "github", "chat-analysis", "system", "browser", "yc", "app"]) {
      assert.ok(list.some((g) => g.name === need), "пропал встроенный справочник: " + need);
    }
    assert.ok(list.every((g) => g.learned === false), "встроенные справочники помечены выученными");
    assert.ok(/ВК-мессенджер/.test(real.guideReadText("vk")), "текст встроенного справочника не читается");
    assert.strictEqual(real.guideForUrl("https://www.vk.com/im").name, "vk", "настоящий адрес ВК не подхватил справочник");
    assert.strictEqual(real.guideForUrl("https://console.cloud.google.com/").name, "google-cloud", "настоящий адрес Google Cloud не подхвачен");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте", () => {
    for (const gone of ["function guideDirs(", "function guideSafeName(", "function guideFilePath(", "function guideSitesOf(", "function guideTitleOf(", "function guideIndex(", "function guideReadText(", "function guideForUrl(", "function agentGuideCall("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createSiteGuides \} = require\("\.\/site-guides\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    // Состав проводки сверяем целиком: пропажа любого имени — падение окна на вызове.
    assert.ok(
      /const \{ guideSafeName, guideFilePath, guideIndex, guideForUrl, guideReadText, agentGuideCall \} = createSiteGuides\(\{/.test(MAIN_SRC),
      "состав имён в проводке модуля изменился"
    );
    for (const dep of ["fs,", "path,", "userDataDir: userDataDir,", 'builtinDir: path.join(__dirname, "agent-guides"),']) {
      assert.ok(MAIN_SRC.includes(dep), "в проводку не передано: " + dep);
    }
    assert.ok(
      /guideSafeName,\n  guideFilePath,\n  guideIndex,\n  guideForUrl,\n  agentGuideCall,/.test(MAIN_SRC),
      "инструменты больше не получают справочники"
    );
    assert.ok(
      MAIN_SRC.includes("guideReadText") && TOOLS_SRC.includes("guideReadText(gname)"),
      "readFile(\"agent-guide:…\") потерял чтение справочника"
    );
    // Папка приложения и встроенный набор приходят снаружи — модуль их не вычисляет сам.
    assert.ok(!/app\.getPath|__dirname/.test(MODULE_SRC), "модуль сам догадывается о путях приложения");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

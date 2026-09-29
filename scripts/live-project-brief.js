"use strict";
/* ─── Живой прогон «визитки проекта» (src/project-brief.js) ───────────────────
   Запуск: bun run test:live:brief    (node scripts/live-project-brief.js)

   Зачем отдельный прогон. Набор (test/project-brief.test.js) собирает визитку в
   синтетической папке. Здесь папка НАСТОЯЩАЯ — сам репозиторий приложения:
   node_modules на диске, сотни файлов, десятки папок, живой README. Только на
   таком дереве видно то, ради чего визитка ограничена:

     [1] мусор (node_modules, .git, dist) не попадает в структуру;
     [2] обход не уходит глубже двух уровней;
     [3] визитка не растёт бесконечно — она уходит в КАЖДЫЙ запрос прогона;
     [4] настоящие оболочки машины и настоящий README на месте;
     [5] НАСТОЯЩАЯ строка Yandex Cloud (src/yc-service.js) — все три её состояния:
         нет авторизации, «каталог НЕ выбран» и выбранный каталог с разрешениями.
         Подставные здесь только настройки: функция берётся из самого сервиса.

   Ничего не пишется: визитка только читает. */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createProjectBrief } = require(path.join(ROOT, "src", "project-brief.js"));
const { createShellTools } = require(path.join(ROOT, "src", "shell-tools.js"));
const { SKIP_DIRS } = require(path.join(ROOT, "src", "code-index.js"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

// Оболочки считаются в оболочке приложения; здесь берём настоящие оболочки машины,
// а настройки подставляем — окна Electron в Node нет. Строку облака берём из
// НАСТОЯЩЕГО сервиса: заглушка вместо неё проверяла бы саму себя и не поймала бы
// ни переехавшую формулировку «каталог НЕ выбран», ни застывший снимок настроек.
// `execFile` здесь не передаётся: оболочки запускают команду через spawn со своей
// группой процессов (часть 40, заход 4.1), а имя прежнего запуска осталось бы в
// стенде мёртвым — за таким стендом и следит сторож имён в test/repo-shape.test.js.
const { shellsBrief } = createShellTools({
  fs,
  path,
  commandEnv: () => ({}),
  truncateText: (s) => s,
  // Настоящий поиск программы в файловой системе, без запуска процессов.
  findProgram: (name) => {
    const found = ["/bin/" + name, "/usr/bin/" + name, "/usr/local/bin/" + name].find((f) => fs.existsSync(f));
    return { found: !!found, path: found || "" };
  },
});
const { createYcService } = require(path.join(ROOT, "src", "yc-service.js"));

// Настройки — настоящей формы (ключи как в приложении), иначе сервис честно решит,
// что авторизации нет, и живые проверки станут проверять пустоту.
const settings = {
  yandexOauthToken: "живой-токен",
  ycFolderId: "b1g-live",
  ycFolderName: "живой",
  ycCloudId: "b1g-live-cloud",
  ycAllowAgentCreate: true,
  ycAllowAgentDelete: false,
};
const ycService = createYcService({
  app: {}, path, net: {}, secrets: {}, yandexCloud: {}, ycCli: {}, ycLogs: {}, ycEnsurePath: () => "",
  loadSettings: () => settings,
});
const { buildProjectBrief, BRIEF_LIMITS: LIMITS } = createProjectBrief({
  fs,
  path,
  SKIP_DIRS,
  shellsBrief,
  loadSettings: () => settings,
  ycBriefLine: ycService.ycBriefLine,
});

const brief = buildProjectBrief(ROOT);

console.log("\n[1] мусор в структуру не попадает");
// Проверяем ИМЕНА ЗАПИСЕЙ структуры, а не подстроку во всём тексте. В проекте есть
// своя папка `backup-playwright/` (фолбэк удалённого playwright — теперь в
// репозитории, см. её README), и подстрочный поиск краснел бы на упоминании
// `node_modules` в её снимках (.bak), ничего не говоря о самом проекте.
const briefEntryHas = (name) =>
  (brief.match(/\n(?:📁|📄) [^\n]+/g) || [])
    .some((l) => l.replace(/^\s*(?:📁|📄)\s*/, "").split("/").includes(name));
ok(!briefEntryHas("node_modules"), "node_modules попал в визитку");
ok(!briefEntryHas(".git"), "служебные папки попали в визитку");
ok(!briefEntryHas("dist"), "сборка попала в визитку");

console.log("\n[2] обход не глубже двух уровней");
ok(/📁 src\//.test(brief) || /📁 assets\//.test(brief), "верхний уровень проекта в визитке есть");
// Эмодзи — суррогатная пара: в квадратных скобках она матчится только половинкой,
// поэтому здесь (?:📁|📄), а не класс символов.
const second = (brief.match(/\n(?:📁|📄) (?:assets|scripts|src)\/[^\n]+/g) || []).length;
ok(second > 0, "второй уровень проекта в визитке есть: " + second);
const deep = (brief.match(/\n(?:📁|📄) [^\n]*\/[^/\n]*\/[^/\n]*\/[^/\n]*/g) || []).length;
ok(deep === 0, "в визитке есть записи глубже двух уровней: " + deep);

console.log("\n[3] визитка ограничена по размеру и не теряет код проекта");
// Пределы берём у самого модуля, а не своей копией числа: копия расходится с кодом
// МОЛЧА — ровно это и случилось здесь до части 82 (предел считался записями, и 80
// длинных имён журнала весили больше всей визитки, а src/ в неё не попадал).
const treeCount = Number((brief.match(/Структура \((\d+) записей\)/) || [])[1] || 0);
ok(treeCount > 0 && treeCount <= LIMITS.treeMax, "записей в структуре: " + treeCount + " (предел " + LIMITS.treeMax + ")");
ok(brief.length < 6000, "визитка на настоящем проекте: " + brief.length + " знаков");
// Главное свойство визитки: код проекта обязан быть виден. Проверяем ИМЕНА записей,
// а не подстроку — «src/» встречается и в строках скриптов.
const entries = (brief.match(/\n(?:📁|📄) [^\n]+/g) || []);
const entryName = (l) => l.replace(/^\s*(?:📁|📄)\s*/, "");
ok(entries.some((l) => entryName(l).startsWith("src/")), "в визитке нет src/ — длинная полка вытеснила код проекта");
ok(entries.some((l) => /… ещё \d+ файлов/.test(l)), "длинная полка не свёрнута в строку со счётчиком");
console.log("  ℹ визитка: " + entries.length + " записей структуры, " + brief.length + " знаков (бюджет структуры " + LIMITS.treeChars + ", файлов из папки " + LIMITS.dirFiles + ")");

console.log("\n[4] настоящие данные проекта на месте");
ok(/^Проект: ai-agent \(каталог: /.test(brief), "имя и папка проекта: " + brief.slice(0, 60));
ok(/Скрипты package\.json: /.test(brief), "скрипты package.json собраны");
ok(/README \(начало\): /.test(brief), "README проекта прочитан");
ok(/Оболочки: \S/.test(brief), "доступные оболочки названы: " + (brief.match(/Оболочки:[^\n]*/) || ["нет строки"])[0]);

console.log("\n[5] настоящая строка облака — все три состояния");
// (а) авторизации нет — про облако в визитке нет ни слова: иначе агент пошёл бы
// «выбирать каталог» там, где облако вообще не подключено.
settings.yandexOauthToken = "";
const noCloud = buildProjectBrief(ROOT);
ok(noCloud.indexOf("Yandex Cloud") < 0, "строка облака появилась без авторизации");

// (б) авторизация есть, каталог не выбран — ДОСЛОВНАЯ подсказка человеку.
settings.yandexOauthToken = "живой-токен";
settings.ycFolderId = "";
settings.ycFolderName = "";
const noFolder = buildProjectBrief(ROOT);
const noFolderLine = (noFolder.match(/Yandex Cloud[^\n]*/) || [""])[0];
ok(
  noFolderLine === "Yandex Cloud: подключён, каталог НЕ выбран — попроси пользователя выбрать каталог в Настройках → «☁️ Yandex Cloud».",
  "ветка «каталог НЕ выбран» разошлась: " + noFolderLine
);

// (в) каталог выбран — свежие настройки, имя, облако и разрешения словами.
settings.ycFolderId = "b1g-live";
settings.ycFolderName = "живой";
const again = buildProjectBrief(ROOT);
const againLine = (again.match(/Yandex Cloud[^\n]*/) || [""])[0];
ok(/Yandex Cloud: каталог «живой» \(b1g-live\)/.test(again), "строка облака не перечиталась: " + againLine);
ok(/, облако b1g-live-cloud/.test(againLine), "облако не попало в строку: " + againLine);
ok(/создание ресурсов агентом разрешено/.test(againLine), "разрешение на создание не названо: " + againLine);
ok(/удаление ЗАПРЕЩЕНО/.test(againLine), "запрет удаления не назван: " + againLine);

console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
process.exit(failures ? 1 : 0);

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
const { shellsBrief } = createShellTools({
  fs,
  path,
  execFile: () => {},
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
const { buildProjectBrief } = createProjectBrief({
  fs,
  path,
  SKIP_DIRS,
  shellsBrief,
  loadSettings: () => settings,
  ycBriefLine: ycService.ycBriefLine,
});

const brief = buildProjectBrief(ROOT);

console.log("\n[1] мусор в структуру не попадает");
ok(brief.indexOf("node_modules") < 0, "node_modules попал в визитку");
ok(brief.indexOf(".git/") < 0 && brief.indexOf("📄 .git") < 0, "служебные папки попали в визитку");
ok(brief.indexOf("dist/") < 0, "сборка попала в визитку");

console.log("\n[2] обход не глубже двух уровней");
ok(/📁 src\//.test(brief) || /📁 assets\//.test(brief), "верхний уровень проекта в визитке есть");
// Эмодзи — суррогатная пара: в квадратных скобках она матчится только половинкой,
// поэтому здесь (?:📁|📄), а не класс символов.
const second = (brief.match(/\n(?:📁|📄) (?:assets|scripts|src)\/[^\n]+/g) || []).length;
ok(second > 0, "второй уровень проекта в визитке есть: " + second);
const deep = (brief.match(/\n(?:📁|📄) [^\n]*\/[^/\n]*\/[^/\n]*\/[^/\n]*/g) || []).length;
ok(deep === 0, "в визитке есть записи глубже двух уровней: " + deep);

console.log("\n[3] визитка ограничена по размеру (уходит в каждый запрос)");
const treeCount = Number((brief.match(/Структура \((\d+) записей\)/) || [])[1] || 0);
ok(treeCount > 0 && treeCount <= 80, "записей в структуре: " + treeCount + " (предел 80)");
ok(brief.length < 6000, "визитка на настоящем проекте: " + brief.length + " знаков");
// Известное свойство (не поломка этой части): предел 80 набирается по алфавиту, и
// на большом проекте бюджет структуры съедают первые папки — src/ в визитку может
// не попасть вовсе. Здесь это только фиксируется, чтобы свойство не поменялось
// молча: правка распределения бюджета — отдельное решение, а не ход выноса.
const hasSrc = /\n(?:📁|📄) src\//.test(brief);
if (treeCount >= 80) {
  console.log("  ℹ структура упёрлась в предел 80; src/ в визитке: " + (hasSrc ? "есть" : "НЕ ПОПАЛА — бюджет съели первые папки по алфавиту"));
}

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

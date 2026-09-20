"use strict";
/* ─── Живой прогон гит-операций агента (src/git-stage.js) ─────────────────────
   Запуск: bun run test:live:stage    (node scripts/live-git-stage.js)

   Зачем отдельный прогон. Набор (test/git-stage.test.js) собирает модуль сам и
   работает с настоящим git — но он НЕ проверяет главного: что настоящий main.js
   действительно собирает этот модуль, на своём месте и с рабочими зависимостями.
   Именно там ошибка тихая и дорогая: передай в проводку undefined или собери
   модуль ниже потребителей — и «Изменения»/публикация/авто-чекпоинт молча
   перестанут работать, потому что в окне всё выглядит живым.

   Здесь модуль проверяется по-настоящему:
     [1] main.js грузится в Node с поддельным electron (окна в песочнице нет),
         и перехваченная сборка показывает, ЧТО именно в неё пришло;
     [2] сборка стоит выше потребителей: каналы и проводки, берущие имена
         значением, собираются позже — и настоящий канал git:commit работает;
     [3] коммит идёт через НАСТОЯЩИЙ канал git:commit на настоящем репозитории;
     [4] авто-чекпоинт берётся из ТОЙ ЖЕ проводки (не из своей копии) и делает
         ровно один локальный коммит с заголовком из вопроса человека;
     [5] секреты не попадают ни в коммит канала, ни в авто-чекпоинт, и остаются
         файлами в папке;
     [6] ни канал, ни авто-чекпоинт НЕ пушат: удалённый репозиторий не меняется.

   Ничего в репозитории приложения не пишется: работа идёт в temp-папках. */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-stage-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-stage-work-"));

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
};
const git = (cwd, args) => String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
const gitTry = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
const subjects = (dir) => git(dir, ["log", "--format=%s"]).split("\n").filter(Boolean);
const committedFiles = (dir, rev) => git(dir, ["show", "--name-only", "--format=", rev || "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean).sort();
const indexFiles = (dir) => git(dir, ["ls-files"]).split("\n").map((s) => s.trim()).filter(Boolean).sort();

// ─── Настоящий проект и настоящий удалённый репозиторий ───
const repo = path.join(work, "проект");
const bare = path.join(work, "выгрузка.git");
fs.mkdirSync(repo, { recursive: true });
write(repo, { "a.txt": "первый\n", "readme.md": "# проект\n" });
git(repo, ["init", "-q"]);
git(repo, ["config", "user.name", "Человек"]);
git(repo, ["config", "user.email", "human@local"]);
git(repo, ["config", "commit.gpgsign", "false"]);
git(repo, ["add", "-A"]);
git(repo, ["commit", "-qm", "начальный коммит"]);
git(work, ["init", "-q", "--bare", bare]);
git(repo, ["remote", "add", "origin", bare]);
git(repo, ["push", "-q", "origin", "HEAD"]);
const remoteBefore = git(bare, ["rev-list", "--all", "--count"]);

// Работа «агента»: правка, новый файл и секреты, которые не должны уехать никуда.
write(repo, {
  "a.txt": "правка агента\n",
  "b.txt": "новый файл агента\n",
  ".env": "TOKEN=секрет\n",
  "secrets.env": "KEY=секрет\n",
  "sub/.env": "TOKEN=секрет\n",
});

// Настройки — на диске: их прочитает настоящий loadSettings() внутри main.js.
fs.writeFileSync(
  path.join(userData, "settings.json"),
  JSON.stringify({ workingDir: repo, agentAutoCommit: true, agentEnv: {} }, null, 2)
);

// ─── Подделываем только то, чего в Node нет (окна в песочнице нет) ───
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};

// Перехватываем сборку модуля: видим, с чем её позвал НАСТОЯЩИЙ main.js,
// и в каком порядке он подключал модули (сборка обязана быть выше потребителей).
const seen = { factory: 0, deps: null, api: null };
const wiringSeen = {};
// Четыре настоящие проводки, которые берут функции модуля ЗНАЧЕНИЕМ: именно тут
// ошибка выноса становится тихой (undefined вместо функции — и всё «как будто живо»).
const WRAPPED = {
  "run-ai.js": ["createRunAi", "runAi"],
  "git-ipc.js": ["registerGitIpc", "gitIpc"],
  "github-ipc.js": ["registerGithubIpc", "githubIpc"],
  "agent-tools.js": ["createAgentTools", "agentTools"],
};
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(),
        on: () => {},
        requestSingleInstanceLock: () => true,
        quit: () => {},
        getVersion: () => "1.5.183",
        setName: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: (ch) => handlers.delete(ch) },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return stub("BrowserWindow"); },
      Menu: stub("Menu"),
      screen: stub("screen"),
      Tray: stub("Tray"),
      nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"),
      powerMonitor: stub("powerMonitor"),
    };
  }
  const reqText = String(req);
  if (reqText.indexOf("git-stage") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createGitStage: (deps) => {
        seen.factory++;
        seen.deps = deps;
        const api = real.createGitStage(deps);
        seen.api = api;
        return api;
      },
    };
  }
  for (const file of Object.keys(WRAPPED)) {
    if (reqText.indexOf(file) < 0) continue;
    const factory = WRAPPED[file][0];
    const key = WRAPPED[file][1];
    const real = origin.apply(this, arguments);
    if (!real || typeof real[factory] !== "function") return real;
    return Object.assign({}, real, {
      [factory]: (deps) => {
        wiringSeen[key] = deps;
        return real[factory](deps);
      },
    });
  }
  return origin.apply(this, arguments);
};
// Фоновые отказы main.js (обновление, каналы) прогон не роняют — как и в других
// живых скриптах. А вот падение САМОГО прогона обязано быть громким: иначе
// «молчаливый ноль» в цепочке тестов выглядел бы успехом.
process.on("unhandledRejection", () => {});

// Сторож: зависший прогон не должен держать цепочку тестов вечно.
const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 90 секунд");
  process.exit(1);
}, 90000);
watchdog.unref();

(async () => {
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон гит-операций агента (настоящий main.js без окна, настоящий git)");
  await sleep(400);

  console.log("\n[1] настоящий main.js сам собрал модуль — и с рабочими зависимостями");
  ok(seen.factory === 1, "createGitStage вызван main.js " + seen.factory + " раз(а)");
  ok(!!seen.deps && typeof seen.deps.runGit === "function", "runGit пришёл функцией");
  ok(!!seen.deps && typeof seen.deps.agentWorkDir === "function", "agentWorkDir пришёл функцией");
  ok(!!seen.deps && !!seen.deps.fs && typeof seen.deps.fs.existsSync === "function", "fs пришёл настоящим объектом");
  ok(!!seen.api && typeof seen.api.stageAllSafe === "function" && typeof seen.api.autoCheckpointCommit === "function", "модуль отдал обе функции");

  // Зависимости рабочие, а не заглушки: runGit запускает настоящий git, а
  // agentWorkDir возвращает рабочую папку из настоящих настроек.
  const probe = await seen.deps.runGit(repo, ["rev-parse", "--is-inside-work-tree"], { workingDir: repo, agentEnv: {} }, "git");
  ok(probe.ok === true && probe.out === "true", "runGit из проводки запускает настоящий git: " + JSON.stringify(probe).slice(0, 120));
  ok(seen.deps.agentWorkDir({ workingDir: repo }) === repo, "agentWorkDir из проводки возвращает рабочую папку настроек");

  console.log("\n[2] все, кто берёт функции ЗНАЧЕНИЕМ, получили ТЕ ЖЕ функции (а не undefined)");
  ok(handlers.has("git:commit"), "канал git:commit зарегистрирован настоящим main.js");
  ok(!!wiringSeen.runAi && wiringSeen.runAi.autoCheckpointCommit === seen.api.autoCheckpointCommit, "прогон (run-ai) получил тот же авто-чекпоинт");
  ok(!!wiringSeen.gitIpc && wiringSeen.gitIpc.stageAllSafe === seen.api.stageAllSafe, "git-каналы получили ту же индексацию");
  ok(!!wiringSeen.githubIpc && wiringSeen.githubIpc.stageAllSafe === seen.api.stageAllSafe, "GitHub-каналы получили ту же индексацию");
  ok(!!wiringSeen.agentTools && wiringSeen.agentTools.stageAllSafe === seen.api.stageAllSafe, "инструменты получили ту же индексацию");

  console.log("\n[3] коммит через НАСТОЯЩИЙ канал git:commit");
  const viaChannel = await handlers.get("git:commit")(null, repo, "живой прогон: коммит через канал");
  ok(viaChannel && viaChannel.ok === true, "канал вернул успех: " + JSON.stringify(viaChannel).slice(0, 160));
  ok(subjects(repo)[0] === "живой прогон: коммит через канал", "сообщение коммита: " + subjects(repo)[0]);
  ok(JSON.stringify(committedFiles(repo)) === JSON.stringify(["a.txt", "b.txt"]), "в коммите только работа агента: " + JSON.stringify(committedFiles(repo)));

  console.log("\n[4] авто-чекпоинт из ТОЙ ЖЕ проводки (одна точка возврата после задания)");
  fs.writeFileSync(path.join(repo, "readme.md"), "# проект (правка агента)\n");
  const commitsBefore = git(repo, ["rev-list", "--count", "HEAD"]);
  const cp = await seen.api.autoCheckpointCommit(
    { workingDir: repo, agentAutoCommit: true, agentEnv: {} },
    [{ role: "user", content: "```\nкод\n```\n\n   поправь readme   " }]
  );
  ok(cp && cp.committed === true, "чекпоинт сработал: " + JSON.stringify(cp));
  ok(String(git(repo, ["rev-list", "--count", "HEAD"])) === String(Number(commitsBefore) + 1), "коммитов ровно на один больше");
  ok(subjects(repo)[0] === "Авто-коммит агента: поправь readme", "заголовок из вопроса человека: " + subjects(repo)[0]);
  ok(git(repo, ["log", "-1", "--format=%an <%ae>"]) === "AI Agent <ai-agent@local>", "автор коммита: " + git(repo, ["log", "-1", "--format=%an <%ae>"]));

  console.log("\n[5] секреты не попали никуда и остались файлами в папке");
  const inHistory = git(repo, ["log", "--all", "--name-only", "--format="]).split("\n").map((s) => s.trim()).filter(Boolean);
  for (const secret of [".env", "secrets.env", "sub/.env"]) {
    ok(inHistory.indexOf(secret) === -1, "секрет не попал в историю коммитов: " + secret);
    ok(indexFiles(repo).indexOf(secret) === -1, "секрет не в индексе: " + secret);
    ok(fs.existsSync(path.join(repo, secret)), "секрет остался файлом в папке: " + secret);
  }
  ok(committedFiles(repo).indexOf("readme.md") !== -1, "работа агента закоммичена: " + JSON.stringify(committedFiles(repo)));

  console.log("\n[6] если менялись ТОЛЬКО секреты — коммита нет, и канал говорит об этом честно");
  const commitsBeforeSecrets = git(repo, ["rev-list", "--count", "HEAD"]);
  write(repo, { "only-secrets.env": "KEY=секрет\n" });
  const secretOnly = await handlers.get("git:commit")(null, repo, "попытка закоммитить только секрет");
  ok(secretOnly && secretOnly.ok === false, "канал отказался коммитить один секрет: " + JSON.stringify(secretOnly).slice(0, 120));
  // Было сырое английское «Command failed» (найдено прогоном в 1.5.183), вылечено
  // в 1.5.184: причина разбирается и объясняется по-русски, а запасной понятный
  // текст в канале больше не недостижим.
  ok(/Коммитить нечего/.test(String(secretOnly && secretOnly.error)), "отказ объяснён по-русски: " + String(secretOnly && secretOnly.error).slice(0, 120));
  ok(!/Command failed/.test(String(secretOnly && secretOnly.error)), "английский текст команды до человека не доходит");
  ok(git(repo, ["rev-list", "--count", "HEAD"]) === commitsBeforeSecrets, "коммита с секретом не появилось");
  ok(fs.existsSync(path.join(repo, "only-secrets.env")), "файл секрета остался в папке");

  console.log("\n[7] свежий репозиторий без истории: секреты не уезжают и в первый коммит");
  // Раньше здесь была дыра: в репозитории без HEAD страховка молча не работала
  // («could not resolve HEAD»), и имя вида secrets.env могло уехать в коммит.
  const fresh = path.join(work, "новый-проект");
  fs.mkdirSync(fresh, { recursive: true });
  git(fresh, ["init", "-q"]);
  git(fresh, ["config", "user.name", "Человек"]);
  git(fresh, ["config", "user.email", "human@local"]);
  write(fresh, { "code.js": "console.log(1);\n", ".env": "TOKEN=секрет\n", "secrets.env": "KEY=секрет\n" });
  const firstCommit = await handlers.get("git:commit")(null, fresh, "первый коммит нового проекта");
  ok(firstCommit && firstCommit.ok === true, "первый коммит в новом репозитории прошёл: " + JSON.stringify(firstCommit).slice(0, 140));
  const freshFiles = git(fresh, ["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean).sort();
  ok(JSON.stringify(freshFiles) === JSON.stringify(["code.js"]), "в первом коммите только код, без секретов: " + JSON.stringify(freshFiles));
  ok(fs.existsSync(path.join(fresh, "secrets.env")) && fs.existsSync(path.join(fresh, ".env")), "файлы секретов остались в папке");

  console.log("\n[8] разбор отказов git: объясняет знакомое и НЕ выдумывает незнакомое");
  const { gitFailReason } = require(path.join(ROOT, "src", "git-ipc.js"));
  ok(/Коммитить нечего/.test(gitFailReason({ err: "Command failed: git commit", out: "nothing to commit, working tree clean" }, "запасной")), "«nothing to commit» объяснён");
  ok(/Конфликт/.test(gitFailReason({ err: "Command failed: git merge\nCONFLICT (content): Merge conflict in a.txt", out: "" }, "запасной")), "конфликт объяснён");
  ok(/сохрани свои правки/.test(gitFailReason({ err: "Your local changes to the following files would be overwritten by merge", out: "" }, "запасной")), "отказ из-за незакоммиченных правок объяснён");
  ok(gitFailReason({ err: "Command failed: git что-то-новое", out: "" }, "запасной") === "Command failed: git что-то-новое", "незнакомый отказ отдан как есть, а не выдуман");
  ok(gitFailReason({}, "запасной") === "запасной", "пустой отказ даёт запасной текст");

  console.log("\n[9] ни канал, ни авто-чекпоинт не пушат");
  ok(git(bare, ["rev-list", "--all", "--count"]) === remoteBefore, "удалённый репозиторий не изменился (было " + remoteBefore + ", стало " + git(bare, ["rev-list", "--all", "--count"]) + ")");

  console.log(failures ? "\n❌ Провалов: " + failures : "\n✅ Все живые проверки пройдены");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  // Сбой самого прогона (а не проверки) — тоже провал, и громкий.
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

"use strict";

/* ── Гит-операции агента (src/git-stage.js) ──────────────────────────────────
   Запуск: node test/git-stage.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 28). Обе функции работают с git
   САМИ, в фоне, и обе ошибаются тихо:

     • stageAllSafe — ключ не должен попасть в коммит ни через авто-чекпоинт, ни
       через инструмент gitCommit, ни при публикации: закоммиченный секрет живёт
       в истории навсегда. Рубежей два — исключение в самой команде (`.env*` на
       любой глубине) и страховка на всё, что проскочило (имена вида `*.env`);
     • autoCheckpointCommit — точка возврата после задания: один ЛОКАЛЬНЫЙ коммит,
       заголовок из последнего вопроса человека, НИКОГДА не пушит и молчит, когда
       коммитить нечего.

   Проверяем на НАСТОЯЩЕМ git в temp и через НАСТОЯЩИЙ runGit из paths-git.js
   (тот же, что в приложении: с окружением по назначению и без токена) —
   поддельный git не показал бы ни путей-исключений, ни индекса, ни HEAD.
   Поддельным остаётся только `agentWorkDir`-место: рабочая папка приходит в
   настройках напрямую. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { createPathsGit } = require(path.join(ROOT, "src", "paths-git.js"));
const { createGitStage } = require(path.join(ROOT, "src", "git-stage.js"));

const MAIN_SRC = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
const MODULE_SRC = fs.readFileSync(path.join(ROOT, "src", "git-stage.js"), "utf8");

// Настоящий runGit и настоящий agentWorkDir — как в main.js, только окружение
// подставное (envFor): в тестах нет ни Yandex Cloud, ни ключей человека.
const pathsGit = createPathsGit({
  fs,
  path,
  os,
  execFile,
  envFor: () => process.env,
  live: {
    lastAgentRepoDir: () => null,
    agentEnv: () => ({}),
    activeToolCapability: () => "git",
  },
});
const { stageAllSafe, autoCheckpointCommit } = createGitStage({
  fs,
  runGit: pathsGit.runGit,
  agentWorkDir: pathsGit.agentWorkDir,
});

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

// ─── настоящий git для подготовки и проверки ───
function git(dir, ...args) {
  const r = require("child_process").spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + (r.stderr || r.stdout || "").trim());
  return (r.stdout || "").trim();
}
const gitTry = (dir, ...args) => require("child_process").spawnSync("git", args, { cwd: dir, encoding: "utf8" });

function repo(files, opts) {
  const options = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstage-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Тестовый человек");
  git(dir, "config", "user.email", "human@local");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, { "a.txt": "первый\n", ...(options.tracked || {}) });
  if (options.commit !== false) {
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "начальный коммит");
  }
  write(dir, files || {});
  return dir;
}

function write(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// «Что в индексе» — это ls-files: diff против HEAD не показывает неизменённые
// отслеживаемые файлы, и путать эти две вещи нельзя (на этом уже спотыкались).
const inIndex = (dir) => git(dir, "ls-files").split("\n").map((s) => s.trim()).filter(Boolean).sort();
// А это — то, что уйдёт в коммит: изменения против HEAD.
const staged = (dir) => git(dir, "diff", "--cached", "--name-only").split("\n").map((s) => s.trim()).filter(Boolean).sort();
const commits = (dir) => git(dir, "log", "--format=%H").split("\n").filter(Boolean);
const subjects = (dir) => git(dir, "log", "--format=%s").split("\n").filter(Boolean);
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const settingsFor = (dir, extra) => ({ workingDir: dir, agentEnv: {}, ...(extra || {}) });

(async () => {
  // ═════════════ 1. Индексация без секретов ═════════════

  await test("индексация: .env в корне и на любой глубине в индекс не попадают", async () => {
    const dir = repo({
      ".env": "TOKEN=1\n",
      ".env.local": "TOKEN=2\n",
      "sub/.env": "TOKEN=3\n",
      "sub/.env.production": "TOKEN=4\n",
      "sub/deep/.env": "TOKEN=5\n",
      "sub/b.txt": "обычный\n",
    });
    try {
      const r = await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(r.ok, true, "индексация не прошла: " + (r.err || ""));
      const index = inIndex(dir);
      for (const secret of [".env", ".env.local", "sub/.env", "sub/.env.production", "sub/deep/.env"]) {
        assert.strictEqual(index.indexOf(secret), -1, "секрет попал в индекс: " + secret);
      }
      assert.deepStrictEqual(index, ["a.txt", "sub/b.txt"], "обычные файлы потерялись: " + JSON.stringify(index));
      assert.deepStrictEqual(staged(dir), ["sub/b.txt"], "к коммиту подготовлено не то: " + JSON.stringify(staged(dir)));
    } finally {
      rm(dir);
    }
  });

  await test("страховка: проскочившие имена вида *.env снимаются с индекса, но остаются в папке", async () => {
    // Исключение в команде берёт только `.env*`. Имена `secrets.env`/`prod.env`
    // проходят `git add` и обязаны быть сняты вторым рубежом — иначе ключ уедет
    // в коммит. Файлы при этом не удаляются: они просто не индексируются.
    const dir = repo({ "secrets.env": "KEY=1\n", "prod.env": "KEY=2\n", "sub/other.env": "KEY=3\n", "new.txt": "обычный новый\n" });
    try {
      const r = await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(r.ok, true, "индексация не прошла: " + (r.err || ""));
      const index = inIndex(dir);
      for (const secret of ["secrets.env", "prod.env", "sub/other.env"]) {
        assert.strictEqual(index.indexOf(secret), -1, "секрет остался в индексе: " + secret);
      }
      assert.deepStrictEqual(staged(dir), ["new.txt"], "к коммиту подготовлено не то: " + JSON.stringify(staged(dir)));
      for (const f of ["secrets.env", "prod.env", "sub/other.env"]) {
        assert.ok(fs.existsSync(path.join(dir, f)), "страховка удалила файл вместо снятия с индекса: " + f);
      }
    } finally {
      rm(dir);
    }
  });

  await test("индексация: свежий репозиторий без истории — .env всё равно не индексируется", async () => {
    const dir = repo({ ".env": "TOKEN=1\n", "b.txt": "текст\n" }, { commit: false });
    try {
      const r = await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(r.ok, true, "индексация в новом репозитории не прошла: " + (r.err || ""));
      const inIndex = staged(dir);
      assert.strictEqual(inIndex.indexOf(".env"), -1, "в новом репозитории .env попал в индекс");
      assert.deepStrictEqual(inIndex, ["a.txt", "b.txt"], "файлы потерялись: " + JSON.stringify(inIndex));
    } finally {
      rm(dir);
    }
  });

  await test("без первого коммита: имена вида *.env тоже не остаются в индексе (лечение 1.5.184)", async () => {
    // До 1.5.184 здесь была дыра: страховка снимает файлы через `git restore
    // --staged`, а ей нужен HEAD — в свежем репозитории она молча падала с
    // «could not resolve HEAD», и секрет уезжал в авто-коммит. Теперь команда
    // выбирается по наличию HEAD; проверка — та же «оговорка», вывернутая в правило.
    const dir = repo({ "secrets.env": "KEY=1\n", "sub/other.env": "KEY=2\n", "new.txt": "обычный\n" }, { commit: false });
    try {
      const r = await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(r.ok, true, "индексация не прошла: " + (r.err || ""));
      const index = inIndex(dir);
      assert.strictEqual(index.indexOf("secrets.env"), -1, "секрет остался в индексе без истории");
      assert.strictEqual(index.indexOf("sub/other.env"), -1, "секрет в подпапке остался в индексе без истории");
      // В репозитории без коммита `diff --cached` сравнивает с ПУСТЫМ деревом и потому
      // показывает все файлы — поэтому действия проверяем смыслом, а не равенством списка.
      const changes = staged(dir);
      assert.ok(changes.indexOf("new.txt") !== -1, "обычный новый файл не подготовлен: " + JSON.stringify(changes));
      assert.strictEqual(changes.indexOf("secrets.env"), -1, "секрет подготовлен к коммиту без истории");
      assert.ok(fs.existsSync(path.join(dir, "secrets.env")), "файл секрета исчез с диска");
    } finally {
      rm(dir);
    }
  });

  await test("отслеживаемый секрет НЕ удаляется из репозитория: правка снимается, файл остаётся в истории", async () => {
    // Обратная сторона лечения и главный сторож: безусловный `git rm --cached`
    // проиндексировал бы УДАЛЕНИЕ, и коммит стёр бы файл из репозитория. Там, где
    // HEAD есть, команда обязана быть `restore --staged`.
    const dir = repo({}, { tracked: { "secrets.env": "KEY=1\n" } });
    try {
      fs.writeFileSync(path.join(dir, "secrets.env"), "KEY=2\n");
      await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(staged(dir).indexOf("secrets.env"), -1, "правка секрета осталась в индексе");
      assert.ok(inIndex(dir).indexOf("secrets.env") !== -1, "секрет выпал из индекса — коммит удалил бы его из репозитория");
      assert.strictEqual(git(dir, "show", "HEAD:secrets.env").trim(), "KEY=1", "версия файла в истории пострадала");
    } finally {
      rm(dir);
    }
  });

  await test("секрет, уже закоммиченный и не изменённый, из индекса не выпадает", async () => {
    // Страховка трогает только ПОДГОТОВЛЕННОЕ к коммиту. Уже закоммиченный секрет —
    // чужая история: выкидывать его из индекса самим нельзя, иначе коммит его стёр бы.
    const dir = repo({ "new.txt": "новый\n" }, { tracked: { "secrets.env": "KEY=1\n" } });
    try {
      await stageAllSafe(dir, settingsFor(dir));
      assert.ok(inIndex(dir).indexOf("secrets.env") !== -1, "закоммиченный секрет выпал из индекса");
      assert.strictEqual(staged(dir).indexOf("secrets.env"), -1, "закоммиченный секрет попал в подготовленные изменения");
      assert.deepStrictEqual(staged(dir), ["new.txt"], "к коммиту подготовлено не то: " + JSON.stringify(staged(dir)));
    } finally {
      rm(dir);
    }
  });

  await test("индексация -A: правка и удаление отслеживаемых файлов тоже попадают в индекс", async () => {
    const dir = repo({}, { tracked: { "gone.txt": "был\n", "keep.txt": "был\n" } });
    try {
      // Человек (или агент) удалил файл и поправил другой — оба изменения обязаны
      // попасть в коммит: ключ -A в команде именно для этого.
      fs.rmSync(path.join(dir, "gone.txt"));
      fs.writeFileSync(path.join(dir, "keep.txt"), "изменён\n");
      await stageAllSafe(dir, settingsFor(dir));
      const changes = staged(dir);
      assert.ok(changes.indexOf("keep.txt") !== -1, "правка не попала в индекс: " + JSON.stringify(changes));
      assert.ok(changes.indexOf("gone.txt") !== -1, "удаление не попало в индекс: " + JSON.stringify(changes));
      assert.strictEqual(inIndex(dir).indexOf("gone.txt"), -1, "удалённый файл остался в индексе");
    } finally {
      rm(dir);
    }
  });

  await test("индексация: папка не git-репозиторий — мягкий отказ, без исключения", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstage-"));
    try {
      write(dir, { "a.txt": "текст\n" });
      const r = await stageAllSafe(dir, settingsFor(dir));
      assert.strictEqual(r.ok, false, "индексация вне репозитория объявила успех");
      assert.ok(String(r.err || "").length > 0, "отказ без объяснения");
    } finally {
      rm(dir);
    }
  });

  // ═════════════ 2. Авто-чекпоинт ═════════════

  await test("авто-чекпоинт: выключен галочкой — коммита нет", async () => {
    const dir = repo({ "b.txt": "работа\n" });
    try {
      const before = commits(dir).length;
      const r = await autoCheckpointCommit(settingsFor(dir, { agentAutoCommit: false }), [{ role: "user", content: "сделай" }]);
      assert.deepStrictEqual(r, { committed: false }, "чекпоинт сработал при выключенной галочке");
      assert.strictEqual(commits(dir).length, before, "коммит появился при выключенной галочке");
    } finally {
      rm(dir);
    }
  });

  await test("авто-чекпоинт: нет изменений — молчит, коммитов не прибавляется", async () => {
    const dir = repo({});
    try {
      const before = commits(dir).length;
      const r = await autoCheckpointCommit(settingsFor(dir), [{ role: "user", content: "ничего не менял" }]);
      assert.deepStrictEqual(r, { committed: false }, "чекпоинт выдумал работу");
      assert.strictEqual(commits(dir).length, before, "пустой коммит всё же создан");
    } finally {
      rm(dir);
    }
  });

  await test("авто-чекпоинт: есть изменения — один коммит с заголовком из последнего вопроса человека", async () => {
    const dir = repo({ "b.txt": "работа агента\n" });
    try {
      const before = commits(dir).length;
      const r = await autoCheckpointCommit(settingsFor(dir), [
        { role: "user", content: "первый вопрос" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "почини заголовок окна" },
      ]);
      assert.strictEqual(r.committed, true, "чекпоинт не сработал: " + JSON.stringify(r));
      assert.strictEqual(r.message, "💾 Авто-коммит агента: почини заголовок окна", "сообщение человеку не то: " + r.message);
      assert.strictEqual(commits(dir).length, before + 1, "коммитов должно быть ровно на один больше");
      assert.strictEqual(subjects(dir)[0], "Авто-коммит агента: почини заголовок окна", "заголовок коммита не тот: " + subjects(dir)[0]);
      assert.strictEqual(git(dir, "log", "-1", "--format=%an <%ae>"), "AI Agent <ai-agent@local>", "автор коммита не тот");
      // В коммит попала именно работа агента, а не мусор из папки.
      assert.deepStrictEqual(git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["b.txt"]);
    } finally {
      rm(dir);
    }
  });

  await test("заголовок: код-фенсы вырезаны, первая непустая строка, пробелы схлопнуты, обрезка до 70 знаков", async () => {
    const dir = repo({ "b.txt": "работа\n" });
    try {
      const long = "а".repeat(100);
      await autoCheckpointCommit(settingsFor(dir), [
        { role: "user", content: "```js\nconst x = 1;\n```\n\n   Настоящий    заголовок   с   лишними пробелами\nвторая строка" },
      ]);
      assert.strictEqual(subjects(dir)[0], "Авто-коммит агента: Настоящий заголовок с лишними пробелами", "заголовок разобран неверно: " + subjects(dir)[0]);
      const dir2 = repo({ "b.txt": "работа\n" });
      try {
        await autoCheckpointCommit(settingsFor(dir2), [{ role: "user", content: long }]);
        assert.strictEqual(subjects(dir2)[0], "Авто-коммит агента: " + long.slice(0, 70), "обрезка до 70 знаков не работает");
      } finally {
        rm(dir2);
      }
    } finally {
      rm(dir);
    }
  });

  await test("заголовок: вопроса человека нет — «Работа агента»", async () => {
    const dir = repo({ "b.txt": "работа\n" });
    try {
      await autoCheckpointCommit(settingsFor(dir), [{ role: "assistant", content: "только мой ответ" }]);
      assert.strictEqual(subjects(dir)[0], "Авто-коммит агента: Работа агента", "заголовок по умолчанию не тот: " + subjects(dir)[0]);
      const dir2 = repo({ "b.txt": "работа\n" });
      try {
        await autoCheckpointCommit(settingsFor(dir2), []);
        assert.strictEqual(subjects(dir2)[0], "Авто-коммит агента: Работа агента", "пустая история дала не тот заголовок");
      } finally {
        rm(dir2);
      }
    } finally {
      rm(dir);
    }
  });

  await test("секреты не попадают в авто-коммит", async () => {
    // Главная проверка модуля целиком: агент поработал, авто-чекпоинт закоммитил —
    // в коммите нет ни .env, ни *.env.
    const dir = repo({ ".env": "TOKEN=1\n", "secrets.env": "KEY=2\n", "b.txt": "работа\n" });
    try {
      const r = await autoCheckpointCommit(settingsFor(dir), [{ role: "user", content: "добавь файл" }]);
      assert.strictEqual(r.committed, true, "чекпоинт не сработал: " + JSON.stringify(r));
      const files = git(dir, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort();
      assert.deepStrictEqual(files, ["b.txt"], "в коммит попали лишние файлы: " + JSON.stringify(files));
    } finally {
      rm(dir);
    }
  });

  await test("авто-чекпоинт никогда не пушит: удалённый репозиторий остаётся прежним", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gitstage-bare-"));
    const dir = repo({ "b.txt": "работа\n" });
    try {
      git(bare, "init", "-q", "--bare");
      git(dir, "remote", "add", "origin", bare);
      git(dir, "push", "-q", "origin", "HEAD");
      const remoteBefore = git(bare, "rev-list", "--all", "--count");
      const r = await autoCheckpointCommit(settingsFor(dir), [{ role: "user", content: "правка" }]);
      assert.strictEqual(r.committed, true, "чекпоинт не сработал: " + JSON.stringify(r));
      assert.strictEqual(git(bare, "rev-list", "--all", "--count"), remoteBefore, "авто-чекпоинт запушил в удалённый репозиторий");
    } finally {
      rm(dir);
      rm(bare);
    }
  });

  await test("авто-чекпоинт: не-git папка и несуществующая папка — молчит, без исключения", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitstage-"));
    try {
      write(dir, { "a.txt": "текст\n" });
      assert.deepStrictEqual(await autoCheckpointCommit(settingsFor(dir), [{ role: "user", content: "x" }]), { committed: false }, "чекпоинт сработал вне репозитория");
      const missing = path.join(dir, "нет-такой-папки");
      assert.deepStrictEqual(await autoCheckpointCommit(settingsFor(missing), [{ role: "user", content: "x" }]), { committed: false }, "чекпоинт сработал в несуществующей папке");
    } finally {
      rm(dir);
    }
  });

  // ═════════════ 3. Проводка и страж ═════════════

  await test("в оболочке этих функций больше нет, а модуль собран выше всех потребителей", async () => {
    assert.strictEqual(MAIN_SRC.indexOf("function stageAllSafe(dir, settings)"), -1, "индексация осталась в main.js");
    assert.strictEqual(MAIN_SRC.indexOf("function autoCheckpointCommit(settings, messages)"), -1, "авто-чекпоинт остался в main.js");
    // Ищем именно РАСПАКОВКУ имён: если проводка зовёт фабрику, а имена не
    // распакованы (или распаковка уехала ниже потребителей), у них будет undefined
    // или TDZ — «Изменения» и авто-чекпоинт молча перестанут работать.
    const wiringAt = MAIN_SRC.indexOf("const { stageAllSafe, autoCheckpointCommit } = createGitStage({");
    assert.ok(wiringAt > 0, "main.js не собирает модуль гит-операций (нет распаковки имён из createGitStage)");
    assert.ok(MAIN_SRC.indexOf('const { createGitStage } = require("./git-stage.js");') > 0, "main.js не требует модуль гит-операций");
    const wiring = MAIN_SRC.slice(wiringAt, MAIN_SRC.indexOf("});", wiringAt));
    for (const dep of ["  fs,", "  runGit,", "  agentWorkDir,"]) {
      assert.ok(wiring.includes(dep), "в проводку не передано: " + dep.trim());
    }
    // Все, кто берёт имена значением, обязаны стоять НИЖЕ сборки: иначе проводка
    // получила бы undefined и публикация/авто-чекпоинт молча перестали бы работать.
    const lines = MAIN_SRC.split("\n");
    const wiringLine = lines.findIndex((l) => /createGitStage\(\{/.test(l));
    const consumers = lines.map((l, i) => (/^\s*(stageAllSafe|autoCheckpointCommit),\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(consumers.length >= 4, "потребителей искали не там: " + consumers.length);
    for (const line of consumers) {
      assert.ok(line > wiringLine, "потребитель на строке " + (line + 1) + " стоит выше сборки модуля (" + (wiringLine + 1) + ")");
    }
    assert.ok(!/require\(|__dirname|process\.env/.test(MODULE_SRC), "модуль сам достаёт состояние вместо внедрения");
  });

  await test("текст перенесён без правок: команда индексации, страховка и коммит — прежние", async () => {
    // Перенос был байт в байт; здесь закреплено то, что обязано не поплыть:
    // сама команда исключения, оба правила страховки и команда коммита с автором.
    assert.ok(MODULE_SRC.indexOf('["add", "-A", "--", ".", ":(exclude,glob)**/" + ".env" + "*"]') >= 0, "команда индексации изменилась");
    assert.ok(MODULE_SRC.indexOf("/^\\.env(\\..*)?$/i.test(base) || /\\.env$/i.test(base)") >= 0, "правило страховки изменилось");
    assert.ok(MODULE_SRC.indexOf('["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", "Авто-коммит агента: " + title]') >= 0, "команда коммита изменилась");
    assert.ok(MODULE_SRC.indexOf('.trim().slice(0, 70)') >= 0, "предел заголовка изменился");
    assert.ok(MODULE_SRC.indexOf('if (!title) title = "Работа агента";') >= 0, "заголовок по умолчанию изменился");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

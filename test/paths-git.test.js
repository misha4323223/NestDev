"use strict";

/* ── Пути и git: общие помощники главного процесса (src/paths-git.js) ──────────
   Запуск: node test/paths-git.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 6). Здесь то, чем пользуется весь
   бэкенд: приведение путей от окна и агента к настоящим путям на диске, выбор
   рабочей папки и запуск git — единственная точка, где git получает окружение по
   назначению и Basic-авторизацию из сохранённого токена.

   Почему проверки поведенческие, а не «строка на месте»: ошибки здесь тихие.
     • Если рабочую папку взять копией, а не мостом, то после клона репозитория
       агент «не увидит» его и будет работать в старой папке — без единой ошибки.
     • Если в runGit потерять GIT_TERMINAL_PROMPT=0, то в приватном репозитории
       команда молча повиснет на вопросе пароля и прогон агента замрёт.
     • Если не подставить Basic-авторизацию, приватные операции будут отвечать
       «invalid credentials» — а внешне это выглядит как «git не работает».
   Поэтому модуль водится по-настоящему: настоящие файлы и папки, настоящий git,
   и в одном месте — настоящий HTTP-сервер, который смотрит заголовок запроса. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { execFile } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { createPathsGit } = require(path.join(ROOT, "src", "paths-git.js"));
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
const MODULE_SRC = read("src", "paths-git.js");
// Единственное прямое чтение main.js здесь — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

/* Живые значения, как их видит модуль: getter поверх изменяемой коробки. */
function makeLive(init) {
  const box = Object.assign({ lastAgentRepoDir: null, agentEnv: {}, activeToolCapability: "" }, init);
  return {
    box,
    live: {
      lastAgentRepoDir: () => box.lastAgentRepoDir,
      agentEnv: () => box.agentEnv,
      activeToolCapability: () => box.activeToolCapability,
    },
  };
}

/* Подставной execFile: записывает, с чем его позвали, и отвечает по сценарию. */
function fakeExecFile(reply) {
  const calls = [];
  const fn = (file, args, opts, cb) => {
    calls.push({ file, args, opts });
    const r = typeof reply === "function" ? reply(file, args, opts) : reply;
    process.nextTick(() => cb(r.err || null, r.stdout || "", r.stderr || ""));
  };
  return { calls, fn };
}

function makePaths(over) {
  const { box, live } = makeLive(over && over.live);
  const caps = [];
  const envFor = over && over.envFor
    ? over.envFor
    : (capability) => {
        caps.push(capability);
        return { PATH: process.env.PATH || "", GIT_AGENT_TEST: "1" };
      };
  const api = createPathsGit({
    fs,
    path,
    os,
    execFile: over && over.execFile ? over.execFile : execFile,
    envFor,
    live,
  });
  return { api, box, caps, envFor };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paths-git-"));
const dirA = path.join(tmpRoot, "repo-a");
const dirB = path.join(tmpRoot, "clone-b");
const plainFile = path.join(tmpRoot, "file.txt");
fs.mkdirSync(dirA);
fs.mkdirSync(dirB);
fs.writeFileSync(plainFile, "x");

(async () => {
  console.log("Пути и git (src/paths-git.js)");

  await test("рабочая папка: выбранный репозиторий важнее папки последнего клона", () => {
    const { api, box } = makePaths();
    box.lastAgentRepoDir = dirB;
    assert.strictEqual(
      api.agentWorkDir({ githubRepoSlug: "u/r", githubRepoDir: dirA, workingDir: tmpRoot }),
      dirA,
      "при выбранном репозитории работа идёт в его папке"
    );
    // Выбран репозиторий, но его папку удалили — тогда годится папка клона.
    assert.strictEqual(api.agentWorkDir({ githubRepoSlug: "u/r", githubRepoDir: path.join(tmpRoot, "нет"), workingDir: tmpRoot }), dirB);
  });

  await test("свежий клон подхватывается без пересборки модуля (мост живой, а не копия)", () => {
    const { api, box } = makePaths();
    assert.strictEqual(api.agentWorkDir({ workingDir: tmpRoot }), tmpRoot, "пока клона нет — рабочая директория");
    box.lastAgentRepoDir = dirB;
    assert.strictEqual(api.agentWorkDir({ workingDir: tmpRoot }), dirB, "после клона работа переезжает в его папку");
    box.lastAgentRepoDir = dirA;
    assert.strictEqual(api.agentWorkDir({ workingDir: tmpRoot }), dirA, "смена клона видна сразу");
  });

  await test("рабочей директории нет или она пропала — домашняя папка", () => {
    const { api } = makePaths();
    assert.strictEqual(api.gitDirOrHome({}), os.homedir(), "без рабочей директории — домашняя");
    assert.strictEqual(api.gitDirOrHome({ workingDir: path.join(tmpRoot, "нет") }), os.homedir(), "несуществующая — тоже домашняя");
    assert.strictEqual(api.gitDirOrHome({ workingDir: dirA }), dirA, "существующая — она сама");
  });

  await test("resolvePath: относительный — от рабочей папки, абсолютный — как есть, пустой — сама папка", () => {
    const { api } = makePaths();
    const st = { workingDir: dirA };
    assert.strictEqual(api.resolvePath("src/app.js", st), path.join(dirA, "src", "app.js"));
    assert.strictEqual(api.resolvePath(path.join(tmpRoot, "x.js"), st), path.join(tmpRoot, "x.js"));
    assert.strictEqual(api.resolvePath("", st), dirA);
    assert.strictEqual(api.resolvePath(null, st), dirA);
  });

  await test("sanitize: наружу только существующее, папка — это только папка", () => {
    const { api } = makePaths();
    assert.strictEqual(api.sanitizeDir(dirA), dirA, "существующая папка проходит");
    assert.strictEqual(api.sanitizeDir(plainFile), null, "файл папкой не считается");
    assert.strictEqual(api.sanitizeDir(path.join(tmpRoot, "нет")), null, "несуществующее не проходит");
    assert.strictEqual(api.sanitizeDir(""), null);
    assert.strictEqual(api.sanitizeDir(42), null);
    assert.strictEqual(api.sanitizePath(plainFile), plainFile, "файл по пути — да");
    assert.strictEqual(api.sanitizePath(path.join(tmpRoot, "нет")), null);
  });

  await test("repoNameFromUrl: имя папки из любого вида git-адреса (и служебное имя Windows)", () => {
    const { api } = makePaths();
    assert.strictEqual(api.repoNameFromUrl("https://github.com/u/repo.git"), "repo");
    assert.strictEqual(api.repoNameFromUrl("https://github.com/u/repo/"), "repo");
    assert.strictEqual(api.repoNameFromUrl("git@github.com:u/repo.git"), "repo");
    assert.strictEqual(api.repoNameFromUrl("https://github.com/u/my.app.git"), "my.app");
    assert.strictEqual(api.repoNameFromUrl("https://github.com/u/trailing..."), "trailing", "точки в конце Windows не разрешает");
    assert.strictEqual(api.repoNameFromUrl("https://github.com/u/CON.git"), "repo", "служебное имя CON");
    assert.strictEqual(api.repoNameFromUrl(""), "repo");
    assert.strictEqual(api.repoNameFromUrl(null), "repo");
  });

  await test("stripUrlCreds: токен не остаётся в адресе, обычная ссылка не портится", () => {
    const { api } = makePaths();
    assert.strictEqual(api.stripUrlCreds("https://user:TOKEN@github.com/u/r.git"), "https://github.com/u/r.git");
    assert.strictEqual(api.stripUrlCreds("https://ghp_abc@github.com/u/r.git"), "https://github.com/u/r.git");
    assert.strictEqual(api.stripUrlCreds("https://github.com/u/r.git"), "https://github.com/u/r.git");
    assert.strictEqual(api.stripUrlCreds("http://u:p@example.com/x"), "http://example.com/x");
    assert.strictEqual(api.stripUrlCreds("git@github.com:u/r.git"), "git@github.com:u/r.git", "ssh-адрес не трогаем");
    assert.strictEqual(api.stripUrlCreds(null), "");
  });

  await test("runGit: настоящий git в настоящей папке отвечает ok и читаемым выводом", async () => {
    const { api } = makePaths();
    const repo = path.join(tmpRoot, "real-repo");
    fs.mkdirSync(repo, { recursive: true });
    const init = await api.runGit(repo, ["init", "-q"], {}, "git.read");
    assert.strictEqual(init.ok, true, "git init прошёл: " + init.err);
    assert.ok(fs.existsSync(path.join(repo, ".git")), "папка .git появилась");
    const status = await api.runGit(repo, ["status", "--porcelain"], {}, "git.read");
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.out, "", "в пустом репозитории вывод пустой");

    const bad = await api.runGit(repo, ["rev-parse", "--verify", "HEAD"], {}, "git.read");
    assert.strictEqual(bad.ok, false, "несуществующая ревизия — это ошибка, а не пустой успех");
    assert.ok(String(bad.err).length > 0, "ошибка git доходит текстом");
  });

  await test("runGit: объявляет назначение операции (инструмент — своё, канал панели явное, внутренние — группа git)", async () => {
    const { api, caps } = makePaths();
    await api.runGit(tmpRoot, ["status"], {}, "git.push");
    await api.runGit(tmpRoot, ["status"], {});
    assert.deepStrictEqual(caps, ["git.push", "git"], "назначение доходит до выдачи переменных, а без него — группа git");
  });

  await test("runGit: переменные агента выдаются только когда их есть, и команда не виснет на вопросе пароля", async () => {
    // Ни токена, ни переменных агента — окружение процесса не подменяем вовсе:
    // иначе git получил бы урезанный набор и, например, потерял бы PATH.
    async function call(liveInit, settings) {
      const f = fakeExecFile({ stdout: "ok", stderr: "" });
      const { box, live } = makeLive(liveInit);
      const api = createPathsGit({
        fs, path, os, execFile: f.fn, live,
        envFor: () => ({ ...box.agentEnv }), // как в жизни: выдача по назначению
      });
      await api.runGit(tmpRoot, ["status"], settings, "git.read");
      return f.calls[0];
    }

    const r1 = await call({ agentEnv: {} }, {});
    assert.strictEqual(r1.opts.env, undefined, "пустое окружение не подставляем");

    const r2 = await call({ agentEnv: { FOO: "1" } }, {});
    assert.ok(r2.opts.env && r2.opts.env.GIT_TERMINAL_PROMPT === "0", "GIT_TERMINAL_PROMPT=0 — команда не спрашивает пароль");
    assert.strictEqual(r2.opts.env.FOO, "1", "переменные агента доходят");

    const r3 = await call({ agentEnv: {} }, { githubToken: "T" });
    assert.ok(r3.opts.env && r3.opts.env.GIT_TERMINAL_PROMPT === "0", "при авторизации окружение тоже не пустое");
  });

  await test("runGit: git не найден — понятная подсказка, а не «ENOENT»", async () => {
    const err = new Error("spawn git ENOENT");
    err.code = "ENOENT";
    const f = fakeExecFile({ err });
    const { live } = makeLive();
    const api = createPathsGit({ fs, path, os, execFile: f.fn, envFor: () => ({}), live });
    const r = await api.runGit(tmpRoot, ["status"], {}, "git.read");
    assert.strictEqual(r.ok, false);
    assert.ok(/git-scm\.com/.test(r.err), "подсказка, где взять git: " + r.err);
    assert.strictEqual(f.calls[0].file, "git", "зовём именно git");
  });

  await test("runGit: токен уходит Basic-авторизацией на настоящий сервер, адрес без учётных данных", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization || "", ua: req.headers["user-agent"] || "" });
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("no");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const { api } = makePaths();
      await api.runGit(
        tmpRoot,
        ["ls-remote", "http://127.0.0.1:" + port + "/repo.git"],
        { githubToken: "SECRET1", githubLogin: "octo" },
        "git.read"
      );
      assert.ok(seen.length > 0, "git действительно сходил на сервер");
      const expected = "Basic " + Buffer.from("octo:SECRET1").toString("base64");
      assert.ok(
        seen.some((s) => s.auth === expected),
        "на сервер ушла Basic-авторизация (по схеме GitHub Actions): " + JSON.stringify(seen.map((s) => s.auth))
      );
      assert.ok(seen.every((s) => !/TOKEN|SECRET1/.test(s.url)), "секрета в адресе запроса нет: " + JSON.stringify(seen.map((s) => s.url)));
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test("проверка записи: папка создаётся, а пробная подпапка НЕ остаётся на диске", () => {
    // Самый неприятный вид поломки здесь — мусор в папке пользователя: если пробную
    // подпапку не убрать, она останется в проекте навсегда и попадёт в его git.
    const { api } = makePaths();
    const target = path.join(tmpRoot, "новая", "вложенная");
    const r = api.ensureWritableDir(target);
    assert.strictEqual(r.ok, true, "годная папка не прошла проверку: " + r.error);
    assert.strictEqual(r.dir, target, "возвращён не абсолютный путь: " + r.dir);
    assert.ok(fs.existsSync(target), "папка не создана — клон и запись файлов упадут");
    assert.deepStrictEqual(fs.readdirSync(target), [], "пробная подпапка осталась в папке проекта");
  });

  await test("проверка записи: пустое значение — отказ с подсказкой, где выбрать папку", () => {
    const { api } = makePaths();
    for (const bad of ["", "   ", null, undefined, 42]) {
      const r = api.ensureWritableDir(bad);
      assert.strictEqual(r.ok, false, "пустое значение принято за рабочую папку: " + JSON.stringify(bad));
      assert.ok(/Настройках → Проект/.test(r.error || ""), "в отказе нет пути к выбору папки: " + r.error);
    }
  });

  await test("проверка записи: отказал accessSync — сказано «нет прав» и что делать", () => {
    const broke = Object.assign(Object.create(fs), {
      accessSync: () => {
        const e = new Error("EACCES: permission denied, access '" + dirA + "'");
        e.code = "EACCES";
        throw e;
      },
    });
    const api = createPathsGit({ fs: broke, path, os, execFile, envFor: () => ({}), live: makeLive().live });
    const r = api.ensureWritableDir(dirA);
    assert.strictEqual(r.ok, false, "отказ прав пропущен: " + JSON.stringify(r));
    assert.ok(/Нет прав на запись/.test(r.error) && /Permission denied/.test(r.error), "причина отказа потеряна: " + r.error);
    assert.ok(/выбери другую рабочую директорию/.test(r.error), "в отказе нет совета, что делать: " + r.error);
  });

  await test("проверка записи: пробная подпапка не создалась — это ОТКАЗ, хотя accessSync прошёл", () => {
    // Ровно та ошибка, из-за которой проверка вообще появилась: OneDrive Files
    // On-Demand, сетевая и защищённая папка проходят accessSync(W_OK), а git падает
    // с «could not create work tree dir ... Permission denied». Без пробы отказ
    // виден только много шагов позже и выглядит как «git не работает».
    const broke = Object.assign(Object.create(fs), {
      mkdirSync: (p, o) => {
        if (/\.ai-agent-write-test$/.test(String(p))) {
          const e = new Error("EACCES: permission denied, mkdir '" + p + "'");
          e.code = "EACCES";
          throw e;
        }
        return fs.mkdirSync(p, o);
      },
    });
    const api = createPathsGit({ fs: broke, path, os, execFile, envFor: () => ({}), live: makeLive().live });
    const r = api.ensureWritableDir(dirA);
    assert.strictEqual(r.ok, false, "провал пробы записи прошёл за успех — git упадёт у пользователя");
    assert.ok(/git не сможет создать тут репозиторий/.test(r.error), "в отказе нет главного: git тут не сможет работать: " + r.error);
    assert.ok(/OneDrive/.test(r.error), "в отказе нет примера, чего избегать: " + r.error);
  });

  await test("проверка записи: остаток прошлой пробы (EEXIST) не считается отказом", () => {
    // Прошлый запуск мог упасть, не убрав за собой пробную папку: из-за чужого
    // остатка папка пользователя не должна становиться «недоступной для записи».
    const { api } = makePaths();
    const target = path.join(tmpRoot, "с-остатком");
    fs.mkdirSync(path.join(target, ".ai-agent-write-test"), { recursive: true });
    const r = api.ensureWritableDir(target);
    assert.strictEqual(r.ok, true, "остаток прошлой пробы сломал проверку: " + r.error);
    assert.ok(!fs.existsSync(path.join(target, ".ai-agent-write-test")), "остаток прошлой пробы остался в папке проекта");
  });

  await test("в оболочке этих функций больше нет, а модуль собран на своём месте с живым мостом", () => {
    for (const gone of ["function runGit(", "function resolvePath(", "function agentWorkDir(", "function sanitizeDir(", "function stripUrlCreds(", "function ensureWritableDir("]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(/const \{ createPathsGit \} = require\("\.\/paths-git\.js"\)/.test(MAIN_SRC), "модуль не подключён");
    assert.ok(/lastAgentRepoDir: \(\) => lastAgentRepoDir/.test(MAIN_SRC), "папка клона передана не мостом");
    // Живые значения читаются, а не копируются: окружение и назначение живут теперь
    // в модуле окружения (часть 22), поэтому мост берёт геттеры оттуда. Папка
    // последнего клона остаётся в оболочке — её мост отдаёт как раньше.
    // Смотрим ИМЕННО свой мост: у agent-tools свой такой же блок, и проверка
    // «где-нибудь в main.js» пропускала бы подмену одного из двух.
    const bridgeAt = MAIN_SRC.indexOf('const { createPathsGit } = require("./paths-git.js")');
    assert.ok(bridgeAt > 0, "модуль не подключён");
    const bridge = MAIN_SRC.slice(bridgeAt, MAIN_SRC.indexOf("\n});", bridgeAt));
    assert.ok(/agentEnv: getAgentEnv,/.test(bridge), "окружение передано не живым чтением");
    assert.ok(/activeToolCapability: getCapability,/.test(bridge), "назначение инструмента передано не живым чтением");
    assert.ok(MAIN_SRC.indexOf("let lastAgentRepoDir = null;") >= 0, "папка клона уехала из оболочки");
    for (const moved of ["let agentEnv = {},", 'let activeToolCapability = "";']) {
      assert.ok(MAIN_SRC.indexOf(moved) < 0, "состояние окружения осталось в оболочке: " + moved);
    }
    assert.ok(MODULE_SRC.indexOf("envFor") >= 0 && MODULE_SRC.indexOf("GIT_TERMINAL_PROMPT") >= 0, "окружение git пропало из модуля");
    // Проверка «можно ли писать» — та же семья: она про путь на диске, а не про
    // настройки, поэтому живёт в этом модуле. Имя взято из распаковки модуля (не
    // объявлено в оболочке), и потребители получают его прежним именем.
    assert.ok(MODULE_SRC.indexOf("function ensureWritableDir(dir)") >= 0, "проверки записи нет в модуле путей");
    assert.ok(/\n  ensureWritableDir,\n/.test(bridge), "проверка записи не взята из модуля путей");
    assert.ok(/\n  ensureWritableDir,\n/.test(MAIN_SRC), "проверка записи не передана потребителям (каналы GitHub и проектов)");
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

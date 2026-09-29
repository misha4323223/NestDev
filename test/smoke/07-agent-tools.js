"use strict";
/* ─── Группа «Дом инструментов агента и разрезы ядра» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 5.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  codeOnly,
  finish,
  get,
  tmpdir,
} = H;

async function testAgentTools() {
  const { createAgentTools } = require(path.join(ROOT, "src", "agent-tools.js"));
  const called = [];
  const spy = (name) => (...args) => {
    called.push(name);
    return undefined;
  };
  // Любая незаданная зависимость — заглушка со своим именем: обращение видно в called.
  const base = new Proxy({}, { get: (_t, key) => spy(String(key)) });
  const state = {
    agentEnv: { MY_VAR: "1" },
    userAgentEnv: { MY_VAR: "1" },
    lastAgentRepoDir: "",
    clonedRepoPending: false,
    activeEmit: null,
    activeToolRouter: null,
    mainWindow: null,
    activeRunUndo: [],
    lastUndoLog: [],
    activePlanSummary: null,
  };
  const live = new Proxy({}, {
    get: (_t, key) => {
      const name = String(key);
      if (name.startsWith("set")) {
        const field = name.slice(3, 4).toLowerCase() + name.slice(4);
        return (v) => {
          called.push("live." + name);
          state[field] = v;
        };
      }
      return () => {
        called.push("live." + name);
        return state[name];
      };
    },
  });
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "agent-tools-"));
  const deps = Object.assign(Object.create(base), {
    path,
    fs,
    os: require("os"),
    live,
    resolvePath: (p) => path.resolve(String(p == null ? "" : p)),
    agentWorkDir: () => {
      called.push("agentWorkDir");
      return tmp;
    },
    truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
    // Контракт приложения: настройки — объект, авто-переменные облака — словарь.
    loadSettings: () => ({}),
    ycAutoEnv: () => ({}),
    app: {
      getPath: () => {
        called.push("app.getPath");
        return tmp;
      },
    },
    clipboard: {
      writeText: (t) => called.push("clipboard.writeText:" + t),
      readText: () => "из буфера",
    },
    agentStore: {
      noteSave: () => ({ ok: true, message: "заметка сохранена" }),
      tasksAdd: () => {
        called.push("agentStore.tasksAdd");
        return { ok: true, message: "дело добавлено" };
      },
      tasksList: () => ({ summary: { summary: { active: 1, overdue: 0, today: 0, tomorrow: 0, week: 0, noDue: 1, done: 0 } }, tasks: [] }),
    },
  });
  const tools = createAgentTools(deps);

  await test("реестр инструментов: собран целиком и отдаёт обработчики", () => {
    assert.ok(Object.keys(tools).length >= 150, "обработчиков собралось: " + Object.keys(tools).length);
    for (const name of ["clipboardWrite", "clipboardRead", "taskAdd", "taskList", "noteSave", "envList", "undoEdit"]) {
      assert.strictEqual(typeof tools[name], "function", "обработчик «" + name + "» есть в реестре");
    }
  });

  await test("контекст прогона: работа возвращается в следующий прогон, а не ищется заново", () => {
    // Жалоба человека: после паузы агент заново выясняет, чем занимался. Модуль
    // (src/run-context.js) сохраняет рабочую историю рядом с проектом, но прогон
    // обязан СПРОСИТЬ его о ней — и спросить ДО сборки запроса.
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    assert.ok(main.indexOf('require("./run-context.js")') >= 0, "модуль контекста прогона не подключён в оболочке");
    assert.ok(main.indexOf("createRunContext,") >= 0, "модуль не передан прогону");
    const from = runSrc.indexOf("const runCtx = createRunContext(");
    assert.ok(from >= 0, "прогон не собирает контекст прогона");
    const wiring = runSrc.slice(from, runSrc.indexOf("});", from));
    for (const dep of ["dir:", "id:", "sanitizeToolPairs"]) {
      assert.ok(wiring.indexOf(dep) >= 0, "в проводку контекста прогона не передан " + dep);
    }
    assert.ok(wiring.indexOf("dir: () => workDir") >= 0, "рабочая папка передана копией: чекпоинт лёг бы в прежний проект");
    assert.ok(wiring.indexOf("id: live.activeRunChatId") >= 0, "чат прогона не взят из живого значения");
    assert.ok(
      runSrc.indexOf("runCtx.plan(runHistory)") < runSrc.indexOf("let canonical = ["),
      "работа возвращается ПОСЛЕ сборки запроса — контекст до модели не доедет"
    );
    assert.ok(runSrc.indexOf("if (resumePlan.resumed)") >= 0, "решение о продолжении не проверяется");
    assert.ok(runSrc.indexOf("runCtx.save(canonical);") >= 0, "рабочая история не фиксируется по ходу прогона");
    // Чекпоинт закрывается только на ЯСНОМ финале: если последний шаг упал или ответ
    // оборван, работа остаётся на диске — ради этого кнопка «▶ Продолжить» и живёт.
    assert.ok(
      runSrc.indexOf("if (!stopNote && !failedStep && !cutOff) {") >= 0,
      "ясный финал не закрывает чекпоинт: сданная работа вернулась бы в контекст"
    );
    assert.ok(
      runSrc.indexOf("const failedStep = !stopNote && !abort.signal.aborted ? lastFailedTool(canonical) : null;") >= 0 &&
        runSrc.indexOf("if (showResume) resumeReady(\"последний инструмент вернул ошибку\");") >= 0,
      "прогон не замечает, что последний шаг не удался — человек опять ищет «продолжай» руками"
    );
    // Вызовы и их результаты обязаны дожить до запроса: без tool_call_id разбор пар
    // выбрасывает результат как осиротевший, и продолжение снова пустое.
    assert.ok(runSrc.indexOf("if (m.tool_calls) one.tool_calls = m.tool_calls;") >= 0, "вызовы инструментов теряются при сборке истории");
    assert.ok(runSrc.indexOf("if (m.tool_call_id) one.tool_call_id = m.tool_call_id;") >= 0, "результат теряет свой tool_call_id");
  });

  await test("ожидание ответа: вопрос ждёт человека, а не «отвечается» старым таймером", () => {
    // Жалоба человека: агент открыл окно с вопросом, а сам не остановился и продолжил
    // работать. Причина — забытый таймер: он не снимался при ответе и через пять минут
    // «отвечал» пустой строкой на СЛЕДУЮЩИЙ вопрос. Модуль ask-wait.js отвечает за это
    // одним местом, и прогон обязан им пользоваться.
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const runSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    const strictSrc = fs.readFileSync(path.join(ROOT, "src", "run-strict.js"), "utf8");
    const moduleSrc = fs.readFileSync(path.join(ROOT, "src", "ask-wait.js"), "utf8");
    assert.ok(main.indexOf('require("./ask-wait.js")') >= 0, "модуль ожидания ответа не подключён в оболочке");
    assert.ok(/const \{ runAi \} = createRunAi\(\{[\s\S]{0,500}?createAskWait,/.test(main), "модуль не передан прогону");
    assert.ok(/const askWait = createAskWait\(\{ emit, live \}\)/.test(runSrc), "прогон не собирает ожидание ответа");
    assert.ok(runSrc.indexOf("300000") < 0, "в прогоне остался старый таймер на пять минут");
    assert.ok(/askWait\.cancel\(\)/.test(runSrc), "конец прогона не снимает ожидание ответа");
    // Варианты ответа доезжают от модели до окна: без этого человек снова печатает руками.
    assert.ok(/await askUserWait\(question, c\.args && c\.args\.options\)/.test(strictSrc), "варианты не доходят до вопроса");
    assert.ok(/clearT\(timer\)/.test(moduleSrc), "ответ больше не снимает таймер");
    assert.ok(/live\.pendingAsk !== finish/.test(moduleSrc), "просроченный таймер может ответить за чужой вопрос");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(/id="ask-options"/.test(html), "в разметке нет полосы вариантов ответа");
  });

  await test("реестр инструментов: буфер обмена и дела берут окружение из main.js", async () => {
    called.length = 0;
    const w = await tools.clipboardWrite({ text: "привет" }, {});
    assert.match(w, /буфер обмена/, "инструмент ответил, а не упал: " + w);
    assert.ok(called.includes("clipboard.writeText:привет"), "текст дошёл до буфера: " + called.join(", "));
    const r = await tools.clipboardRead({}, {});
    assert.match(r, /из буфера/, "чтение буфера отдало содержимое (для этого нужен truncateText): " + r);

    called.length = 0;
    const add = await tools.taskAdd({ title: "проверка" }, {});
    assert.match(add, /дело добавлено/, "дело занесено: " + add);
    for (const need of ["tasksDataDir", "agentStore.tasksAdd", "emitTasksChanged"]) {
      assert.ok(called.includes(need), "дело проходит через " + need + " (званы: " + called.join(", ") + ")");
    }
    const list = await tools.taskList({}, {});
    assert.match(list, /Дела: активных 1/, "список дел собран: " + list);

    called.length = 0;
    const note = await tools.noteSave({ key: "к", content: "тело" }, {});
    assert.match(note, /заметка сохранена/, "заметка сохранена: " + note);
    assert.ok(called.includes("app.getPath"), "заметки пишутся в папку приложения");
    assert.ok(called.includes("agentWorkDir"), "заметки привязаны к папке проекта");

    called.length = 0;
    const env = await tools.envList({}, {});
    assert.match(env, /MY_VAR — установлена \(1 симв\.\)/, "переменные агента читаются живыми: " + env);
    assert.ok(called.includes("live.agentEnv"), "значение берётся в момент вызова, а не копией");
  });

  // Вложения и разработка — из модуля разработки (часть 40, заход 9). Проверяем ПО ФАКТУ
  // на настоящей папке проекта: какие команды собираются и куда уходят, что агент видит
  // про установку зависимостей и каким окружением пользуется клиент БД (выданным ему,
  // а не всем набором переменных агента).
  await test("разработка: команды собираются по проекту, а не наугад", async () => {
    const { createDevTools } = require(path.join(ROOT, "src", "agent-tools-devtools.js"));
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "devtools-"));
    const ran = [];
    const dev = createDevTools({
      fs,
      path,
      agentWorkDir: () => dir,
      resolvePath: (p) => path.resolve(String(p == null ? "" : p)),
      detectPackageManager: () => ({ name: "bun", bin: "bun", add: "add", flagDev: "-d" }),
      envFor: (cap) => {
        ran.push("env:" + cap);
        return { DB_TOKEN: "выданный" };
      },
      execFile: (bin, argv, opts, cb) => {
        ran.push("execFile:" + bin);
        ran.push("env-клиента:" + JSON.stringify(opts.env));
        if (bin === "psql") return cb(Object.assign(new Error("нет клиента"), { code: "ENOENT" }), "", "");
        return cb(null, "1 row", "");
      },
      explainExit: (code, cmd) => "код выхода " + code + " у «" + cmd + "»",
      findProgram: (p) => (p === "git" ? { found: true, path: "/usr/bin/git", reason: "" } : { found: false, reason: "не найден в PATH" }),
      hasLock: () => true,
      runProgVersion: async () => "git version 2.4",
      runTerminalCommand: async (cmd, cwd, timeoutMs) => {
        ran.push(cmd + " @" + cwd + " " + timeoutMs);
        return "вывод: " + cmd;
      },
      stripAnsi: (s) => String(s),
      summarizeTestOutput: (out) => "итог по " + String(out).length + " симв.",
      truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
    });

    ran.length = 0;
    const built = await dev.dockerBuild({}, {});
    assert.deepStrictEqual(ran, ["docker build . @" + dir + " 300000"], "сборка образа ушла не тем: " + ran.join(" | "));
    assert.match(built, /вывод: docker build/, "вывод не отдан агенту: " + built);
    const noDir = await dev.dockerBuild({ directory: path.join(dir, "нет-такой") }, {});
    assert.match(noDir, /папка не найдена/, "несуществующая папка не названа: " + noDir);

    ran.length = 0;
    await dev.dockerRun({ image: "мой-образ", args: "-p 3000:3000" }, {});
    assert.strictEqual(ran[0], "docker run -d -p 3000:3000 мой-образ @" + dir + " 120000", "запуск образа собран неверно: " + ran[0]);
    ran.length = 0;
    await dev.dockerExec({ container: "c1", command: "ls -la" }, {});
    assert.strictEqual(ran[0], "docker exec c1 ls -la @" + dir + " 60000", "команда в контейнере собрана неверно: " + ran[0]);

    ran.length = 0;
    const installed = await dev.installPackage({ packageName: "express", dev: true }, {});
    assert.strictEqual(ran[0], "bun add -d express @" + dir + " 300000", "пакет ставится не менеджером проекта: " + ran[0]);
    assert.match(installed, /менеджер пакетов: bun/, "каким менеджером поставлено — не сказано: " + installed);

    // Тесты: берём из package.json, а если его нет — по замку проекта.
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }), "utf8");
    ran.length = 0;
    const withPkg = await dev.runTests({}, {});
    assert.ok(ran[0].startsWith("npm test @"), "тесты запущены не скриптом проекта: " + ran[0]);
    assert.match(withPkg, /итог по/, "итог тестов не сведён: " + withPkg);
    fs.rmSync(path.join(dir, "package.json"));
    ran.length = 0;
    await dev.runTests({}, {});
    assert.ok(ran[0].startsWith("bun test @"), "без package.json тесты идут не по замку проекта: " + ran[0]);

    const nothing = await dev.lintProject({}, {});
    assert.match(nothing, /Не нашёл конфигов проверки/, "пустая проверка не объяснена: " + nothing);
    const nothingValid = await dev.validateProject({}, {});
    assert.match(nothingValid, /Не нашёл, что проверять/, "проверка проекта не объяснена: " + nothingValid);

    // Зависимости: видно, что объявлено и что реально лежит в node_modules.
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "^4.0.0" }, devDependencies: { prettier: "^3.0.0" } }), "utf8");
    fs.mkdirSync(path.join(dir, "node_modules", "lodash"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "lodash", "package.json"), JSON.stringify({ version: "4.17.21" }), "utf8");
    const deps = await dev.getDependencies({}, {});
    assert.match(deps, /lodash@\^4\.0\.0 → установлено 4\.17\.21/, "установленная зависимость названа неверно: " + deps);
    assert.match(deps, /prettier@\^3\.0\.0 → НЕ установлено/, "неустановленная зависимость не названа: " + deps);

    const fmt = await dev.formatCode({ path: path.join(dir, "package.json") }, {});
    assert.match(fmt, /Prettier не установлен в проекте/, "отсутствие prettier не объяснено: " + fmt);

    const bad = await dev.dbQuery({ connectionString: "sqlite://файл", sql: "select 1" }, {});
    assert.match(bad, /postgres:\/\/\.\.\. и mysql:\/\/\.\.\./, "неподдерживаемое подключение не отклонено: " + bad);
    ran.length = 0;
    const db = await dev.dbQuery({ connectionString: "postgres://u:p@хост:5432/бд", sql: "select 1" }, {});
    assert.ok(ran.includes("env:db.query"), "клиент БД не получил своё окружение: " + ran.join(" | "));
    assert.ok(ran.some((r) => r.indexOf('env-клиента:{"DB_TOKEN":"выданный"}') === 0), "клиенту БД ушёл не выданный набор: " + ran.join(" | "));
    assert.match(db, /Клиент psql не найден/, "отсутствие psql не объяснено: " + db);

    const prog = await dev.checkInstalledProgram({ programName: "git" }, {});
    assert.match(prog, /Версия: git version 2\.4/, "версия программы не проверена: " + prog);
    const none = await dev.checkInstalledProgram({ programName: "docker" }, {});
    assert.match(none, /installSystemPackage\("docker"\)/, "путь установки не подсказан: " + none);
    const builtin = await dev.canExecute({ command: "cd /tmp" }, {});
    assert.match(builtin, /встроенная команда оболочки/, "встроенная команда не распознана: " + builtin);
    const explain = await dev.explainError({ exitCode: "127", command: "git push" }, {});
    assert.match(explain, /код выхода 127 у «git push»/, "разбор кода выхода не дошёл до помощника: " + explain);
  });

  await test("разработка: модуль собран на своём месте и на живых зависимостях", () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const devtools = createDevTools\(deps\);/.test(shellSrc), "модуль разработки собран не на deps — команды уйдут пустыми");
    assert.ok(/const devtools = createDevTools/.test(shellSrc.slice(0, shellSrc.indexOf("return {"))), "модуль собран после реестра — ссылки будут пустыми");
    for (const name of ["dockerBuild", "installPackage", "runTests", "lintProject", "formatCode", "dbQuery", "explainError", "checkInstalledProgram", "canExecute", "validateProject", "getDependencies", "dockerRun", "dockerExec"]) {
      assert.ok(shellSrc.includes('"' + name + '": devtools.' + name + ","), "инструмент «" + name + "» не сослался на модуль");
    }
  });
  // Медиа, просмотр и справка — из своего модуля (часть 40, заход 10). Проверяем ПО ФАКТУ:
  // что уходит человеку событием, что отвечает модель при выключенной вспомогательной
  // модели и куда ложится сгенерированная картинка (имя из ответа модели — не доверяем).
  await test("медиа и просмотр: картинки уходят человеку, а отказы названы", async () => {
    const { createMediaTools } = require(path.join(ROOT, "src", "agent-tools-media.js"));
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "media-tools-"));
    const events = [];
    const saw = [];
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    const img = path.join(dir, "кадр.png");
    fs.writeFileSync(img, Buffer.from(png, "base64"));
    fs.writeFileSync(path.join(dir, "текст.txt"), "не картинка\n", "utf8");
    fs.writeFileSync(path.join(dir, "второй.png"), Buffer.from("89504e470d0a1a0b", "hex").toString("base64"));
    const groups = [];
    const live = {
      activeEmit: (ev) => events.push(ev),
      activeToolRouter: { addGroups: (g) => groups.push.apply(groups, g), names: () => ["sendMail"] },
    };
    const media = createMediaTools({
      fs,
      path,
      agentWorkDir: () => dir,
      resolvePath: (p) => path.resolve(dir, String(p == null ? "" : p)),
      truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
      fmtError: (e) => (e && e.message) || String(e),
      searchTools: (q) => (q === "почта" ? [{ name: "sendMail", group: "mail", description: "отправить письмо" }, { name: "mailCode", group: "mail", description: "код из письма" }] : []),
      shell: { openExternal: async (u) => saw.push("open:" + u) },
      auxConfig: (s) => s.aux || { enabled: false },
      describeImageRemote: async (cfg, dataUrl, question, model) => {
        saw.push("vision:" + model + ":" + String(question).slice(0, 12) + ":" + (dataUrl.indexOf("data:image/png;base64,") === 0));
        return "на картинке жёлтый круг";
      },
      generateImageRemote: async (cfg, prompt, model) => {
        saw.push("gen:" + model + ":" + prompt);
        return { b64: png, mediaType: "image/png", label: "провайдер-1" };
      },
      unifiedDiff: async () => ({ patch: "--- a\n+++ b\n@@ -1 +1 @@\n-старое\n+новое\n" }),
      screenshotUrl: async (u) => { saw.push("shot:" + u); return { ok: true, dataUrl: "data:image/png;base64," + png, mime: "image/png" }; },
      saveScreenshotPng: (buf, kind) => { saw.push("saved:" + kind + ":" + buf.length); return path.join(dir, "снимок.png"); },
      browserTools: { waitForIdle: async (a) => { saw.push("idle:" + JSON.stringify(a)); return "покой наступил"; } },
      agentGuideCall: (a) => { saw.push("guide:" + a.topic); return "справка по теме"; },
    }, live);

    // Поиск инструмента: группа включается, а о том, что не поместилось в схемы, сказано честно.
    const empty = await media.findTools({}, {});
    assert.match(empty, /Укажи query/, "пустой запрос не объяснён: " + empty);
    const none = await media.findTools({ query: "такого-нет" }, {});
    assert.match(none, /Ничего не нашлось/, "пустой поиск не назван: " + none);
    const found = await media.findTools({ query: "почта" }, {});
    assert.deepStrictEqual(groups, ["mail"], "группы найденных инструментов не включены: " + groups.join(", "));
    assert.match(found, /Включены группы: mail/, "включённые группы не названы: " + found);
    assert.match(found, /не поместились \(узкое окно модели\): mailCode/, "модель не предупреждена о схемах, которых нет в запросе: " + found);
    assert.match(found, /Сейчас в запросе 1 инструментов/, "не сказано, что реально в запросе: " + found);

    assert.match(await media.openUrl({ url: "не-ссылка" }, {}), /укажи полный URL/, "плохой URL не отклонён");
    await media.openUrl({ url: "https://пример.рф" }, {});
    assert.deepStrictEqual(saw.filter((s) => s.indexOf("open:") === 0), ["open:https://пример.рф"], "ссылка не ушла в браузер: " + saw.join(" | "));

    // Картинки: чужая папка и не-картинка не показываются, настоящая — уходит событием.
    assert.match(await media.showImage({ path: "нет-файла.png" }, {}), /файл не найден/, "несуществующий файл не назван");
    assert.match(await media.showImage({ path: "текст.txt" }, {}), /это не изображение/, "не-картинка не отклонена: " + (await media.showImage({ path: "текст.txt" }, {})));
    events.length = 0;
    const shown = await media.showImage({ path: "кадр.png" }, {});
    assert.match(shown, /OK — изображение показано пользователю/, "картинка не показана: " + shown);
    assert.strictEqual(events.length, 1, "событий о картинке: " + events.length);
    assert.strictEqual(events[0].type, "image", "тип события не тот: " + events[0].type);
    assert.ok(String(events[0].dataUrl).indexOf("data:image/png;base64,") === 0, "картинка ушла не как data-URL: " + String(events[0].dataUrl).slice(0, 40));

    // Вспомогательная модель: выключена — сказано, что включить; без модели-зрения — что указать.
    const off = await media.analyzeImage({ path: "кадр.png" }, {});
    assert.match(off, /вспомогательная модель выключена/, "выключенная модель не объяснена: " + off);
    const noModel = await media.analyzeImage({ path: "кадр.png" }, { aux: { enabled: true } });
    assert.match(noModel, /не указана модель для чтения изображений/, "модель-зрение не спрошена: " + noModel);
    saw.length = 0;
    const described = await media.analyzeImage({ path: "кадр.png", question: "что тут? подробнее" }, { aux: { enabled: true, visionModel: "в-1" } });
    assert.match(described, /на картинке жёлтый круг/, "описание не доехало до агента: " + described);
    assert.ok(saw.some((s) => s.indexOf("vision:в-1:что тут? под:true") === 0), "картинка ушла модели не тем: " + saw.join(" | "));

    // Генерация: имя из ответа модели не управляет папкой — файл ложится в рабочую.
    assert.match(await media.generateImage({}, {}), /укажи prompt/, "пустой prompt не отклонён");
    assert.match(await media.generateImage({ prompt: "кот" }, {}), /вспомогательная модель выключена/, "выключенная модель не объяснена");
    const gen = await media.generateImage({ prompt: "кот в шапке", filename: "../../злой.png", aspect_ratio: "16:9" }, { aux: { enabled: true, imageModel: "г-1" } });
    const made = (gen.match(/сохранено: ([^ ]+)/) || [])[1] || "";
    assert.ok(made.indexOf(dir) === 0 && made.indexOf("..") < 0, "картинка легла вне рабочей папки: " + made);
    assert.ok(fs.existsSync(made), "файла картинки нет на диске: " + made);
    assert.strictEqual(fs.readFileSync(made).toString("base64"), png, "на диск легли не те байты");
    assert.ok(gen.indexOf("провайдер: провайдер-1") > 0, "каким провайдером сделана картинка — не сказано: " + gen);
    assert.ok(events.some((e) => e.type === "image" && e.path === made), "сгенерированная картинка не показана событием");

    // Просмотр: дифф и предпросмотр открываются событием, скриншот страницы сохраняется файлом.
    events.length = 0;
    const diff = await media.diffView({ path1: "кадр.png", path2: "второй.png" }, {});
    assert.match(diff, /Дифф /, "дифф не открыт: " + diff);
    assert.strictEqual(events[0] && events[0].type, "diff", "событие диффа не ушло: " + JSON.stringify(events[0] || {}).slice(0, 60));
    assert.ok(/@@/.test(events[0].patch), "в событие не попал патч: " + events[0].patch);
    assert.match(await media.previewUI({ url: "ftp://пример" }, {}), /укажи полный URL/, "плохой адрес предпросмотра не отклонён");
    events.length = 0;
    await media.previewUI({ url: "http://localhost:3000" }, {});
    assert.strictEqual(events[0] && events[0].type, "preview", "предпросмотр не открыт событием");
    saw.length = 0;
    const shot = await media.screenshotCapture({ url: "http://localhost:3000" }, {});
    assert.match(shot, /скриншот http:\/\/localhost:3000 снят/, "скриншот не снят: " + shot);
    assert.ok(saw.some((s) => s.indexOf("saved:page:") === 0), "скриншот не сохранён файлом: " + saw.join(" | "));
    assert.ok(shot.indexOf("снимок.png") > 0, "путь сохранённого скриншота не назван: " + shot);

    assert.strictEqual(await media.waitForIdle({ tab: 1 }, {}), "покой наступил", "покой спрошен не у браузера");
    assert.strictEqual(await media.agentGuide({ topic: "деплой" }, {}), "справка по теме", "справка не взята из данных приложения");
    const missing = ["findTools", "openUrl", "showImage", "analyzeImage", "generateImage", "diffView", "previewUI", "screenshotCapture", "waitForIdle", "agentGuide"]
      .filter((n) => typeof media[n] !== "function");
    assert.deepStrictEqual(missing, [], "в модуле нет обработчиков: " + missing.join(", "));
  });

  await test("медиа: модуль собран на своём месте и с живым мостом", () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const media = createMediaTools\(deps, live\);/.test(shellSrc), "модуль собран без живого моста — лента и роутер будут пустыми");
    assert.ok(/const media = createMediaTools/.test(shellSrc.slice(0, shellSrc.indexOf("return {"))), "модуль собран после реестра — ссылки будут пустыми");
    for (const name of ["findTools", "openUrl", "showImage", "analyzeImage", "generateImage", "diffView", "previewUI", "screenshotCapture", "waitForIdle", "agentGuide"]) {
      assert.ok(shellSrc.includes('"' + name + '": media.' + name + ","), "инструмент «" + name + "» не сослался на модуль");
    }
  });
  await test("окружение и OTA: модуль собран на своём месте и с живым мостом", () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const envTools = createEnvTools\(deps, live\);/.test(shellSrc), "модуль не собран или собран без живого моста");
    assert.ok(/const envTools = createEnvTools/.test(shellSrc.slice(0, shellSrc.indexOf("return {"))), "модуль собран после реестра — ссылки будут пустыми");
    for (const name of ["envSet", "envList", "envUnset", "otaStatus", "otaCheck", "otaRollback"]) {
      assert.ok(shellSrc.includes('"' + name + '": envTools.' + name + ","), "инструмент «" + name + "» не сослался на модуль");
      assert.ok(shellSrc.indexOf('"' + name + '": async (args, settings) => {') < 0, "тело «" + name + "» осталось в оболочке");
    }
    const mod = fs.readFileSync(path.join(ROOT, "src", "agent-tools-env.js"), "utf8");
    for (const name of ["envSet", "envList", "envUnset", "otaStatus", "otaCheck", "otaRollback"]) {
      assert.ok(mod.includes('"' + name + '": async (args, settings) => {'), "в модуле нет тела «" + name + "»");
    }
    assert.ok(!/app\.getPath|__dirname|require\("\.\/agent-tools/.test(mod), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(!/^let |^var /m.test(mod), "в модуле завелось состояние уровня файла");
  });
  await test("браузер агента: снимок уходит событием, а справочник — к месту", async () => {
    const { createBrowserTools } = require(path.join(ROOT, "src", "agent-tools-browser.js"));
    const saw = [];
    const events = [];
    const png = "iVBORw0KGgoABC";
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "browser-tools-"));
    const shotPath = path.join(dir, "кадр.png");
    const browserTools = {};
    let visionFails = false;
    for (const name of ["connect", "open", "snapshot", "fill", "click", "act", "select", "press", "text", "evalJs", "domHtml", "overlays", "wait", "scroll", "hover", "network", "replay", "close", "status", "clearProfile"]) {
      browserTools[name] = async (a) => { saw.push(name + ":" + JSON.stringify(a === undefined ? null : a)); return "ответ " + name; };
    }
    browserTools.screenshotFile = async (a) => { saw.push("screenshotFile:" + JSON.stringify(a)); return { buf: Buffer.from(png, "base64"), path: shotPath, url: "https://пример.рф", title: "Страница" }; };
    const mod = createBrowserTools({
      browserTools,
      guideForUrl: (u) => (/vk\.com/.test(String(u)) ? { name: "vk", title: "ВКонтакте" } : null),
      path,
      os: require("os"),
      auxConfig: (s) => s.aux || { enabled: false },
      describeImageRemote: async (cfg, dataUrl, q, model) => { if (visionFails) throw new Error("нет страницы"); saw.push("vision:" + model + ":" + (dataUrl.indexOf("data:image/png;base64,") === 0) + ":" + String(q).length); return "видно кнопку «Войти»"; },
    }, { activeEmit: (e) => events.push(e) });

    // Действия: каждое доходит до своего метода настоящего браузерного набора — с теми же доводами.
    const MAP = { browserConnect: "connect", browserSnapshot: "snapshot", browserFill: "fill", browserClick: "click", browserAct: "act", browserSelect: "select", browserPress: "press", browserText: "text", browserEval: "evalJs", browserDOM: "domHtml", browserOverlays: "overlays", browserWait: "wait", browserScroll: "scroll", browserHover: "hover", browserNetwork: "network", browserReplay: "replay", browserClose: "close", browserStatus: "status", browserClearProfile: "clearProfile" };
    for (const [tool, method] of Object.entries(MAP)) {
      const args = method === "status" || method === "clearProfile" ? {} : { probe: tool };
      assert.strictEqual(await mod[tool](args, {}), "ответ " + method, "инструмент «" + tool + "» не дошёл до браузера");
      const want = method + ":" + (method === "status" || method === "clearProfile" ? "null" : JSON.stringify({ probe: tool }));
      assert.ok(saw.includes(want), "доводы «" + tool + "» не дошли как есть: " + saw[saw.length - 1]);
    }

    // Открытие адреса: справочник подставляется к месту, а к отказу — нет.
    const plain = await mod.browserOpen({ url: "https://пример.рф" }, {});
    assert.strictEqual(plain, "ответ open", "у адреса без справочника ответ изменён: " + plain);
    const guided = await mod.browserOpen({ url: "https://vk.com/лента" }, {});
    assert.match(guided, /📘 По этому сайту есть справочник агента «vk» \(ВКонтакте\)/, "справочник не подсказан: " + guided);
    assert.match(guided, /agentGuide \{ name: "vk" \}/, "в подсказке нет вызова справочника: " + guided);
    browserTools.open = async () => "Ошибка: браузер не запущен";
    const failed = await mod.browserOpen({ url: "https://vk.com/лента" }, {});
    assert.strictEqual(failed, "Ошибка: браузер не запущен", "отказ украшен справочником: " + failed);

    // Отказ набора — не только «Ошибка …»: без запущенного браузера набор отвечает
    // «Браузер не запущен…», и такой отказ раньше выглядел успехом — подсказка
    // справочника приклеивалась к отказу. Список отказов живёт в browser-tools.js.
    const realBrowserTools = require(path.join(ROOT, "src", "browser-tools.js"));
    assert.strictEqual(typeof realBrowserTools.isBrowserFailure, "function", "browser-tools не отдаёт список отказов наружу");
    for (const refusedText of [
      "Ошибка browserFill: элемент не найден",
      "Браузер не запущен. Сначала вызови browserOpen (url).",
      "Вкладка не найдена: tab1. Открой страницу через browserOpen (url).",
      "Не нашёл поле с подписью «Вход»",
      "browserDOM: элемента нет",
    ]) {
      assert.ok(realBrowserTools.isBrowserFailure(refusedText), "отказ не признан отказом: " + refusedText);
    }
    assert.ok(!realBrowserTools.isBrowserFailure("Вкладка tab1 открыта (движок: Chromium)"), "успех признан отказом");
    assert.ok(!realBrowserTools.isBrowserFailure("OK — логин и пароль подставлены в форму"), "успех признан отказом");
    browserTools.isBrowserFailure = realBrowserTools.isBrowserFailure;
    browserTools.open = async () => "Браузер не запущен. Сначала вызови browserOpen (url).";
    const realRefused = await mod.browserOpen({ url: "https://vk.com/лента" }, {});
    assert.strictEqual(realRefused, "Браузер не запущен. Сначала вызови browserOpen (url).", "к настоящему отказу набора приклеена подсказка: " + realRefused);

    // Снимок: файл в системной временной папке, событие человеку, зрение — по настройкам.
    events.length = 0;
    saw.length = 0;
    const noVision = await mod.browserScreenshot({ analyze: false }, {});
    assert.ok(noVision.indexOf(shotPath) > 0, "путь снимка не назван: " + noVision);
    assert.match(noVision, /analyzeImage \{ path: /, "не сказано, как разобрать снимок: " + noVision);
    const asked = saw.find((s) => s.indexOf("screenshotFile:") === 0) || "";
    assert.ok(asked.indexOf(JSON.stringify(path.join(require("os").tmpdir(), "ai-agent-shots"))) > 0, "снимок просят не во временную папку системы: " + asked.slice(0, 200));
    assert.strictEqual(events.length, 1, "событие снимка не ушло или ушло не одно: " + events.length);
    assert.strictEqual(events[0].type, "image", "событие снимка не картинка: " + JSON.stringify(events[0]).slice(0, 80));
    assert.strictEqual(events[0].path, shotPath, "в событии не путь файла: " + events[0].path);
    assert.strictEqual(events[0].dataUrl, "data:image/png;base64," + Buffer.from(png, "base64").toString("base64"), "в событии не та картинка");

    saw.length = 0;
    const vision = await mod.browserScreenshot({}, { aux: { visionModel: "м-1", key: "к" } });
    assert.match(vision, /Что видно \(vision-модель\):\nвидно кнопку «Войти»/, "разбор зрения не попал в ответ: " + vision);
    assert.ok(saw.some((x) => /^vision:м-1:true:[1-9][0-9]*$/.test(x)), "зрение спрошено не так (модель, картинка, вопрос): " + saw.join(" | ").slice(0, 200));

    visionFails = true;
    const broke = await mod.browserScreenshot({}, { aux: { visionModel: "м-1", key: "к" } });
    visionFails = false;
    assert.match(broke, /Vision-модель не ответила \(нет страницы\) — это не блокер/, "сбой зрения не объяснён: " + broke);
    assert.match(broke, /работай по DOM/, "не сказано, что делать вместо зрения: " + broke);

    const blind = await mod.browserScreenshot({}, {});
    assert.match(blind, /Зрение не настроено — работай по DOM: browserSnapshot, browserDOM, browserEval, browserOverlays\./, "не сказано, где включить зрение: " + blind);

    events.length = 0;
    browserTools.screenshotFile = async () => ({ error: "Браузер не запущен. Сначала вызови browserOpen (url)." });
    const refused = await mod.browserScreenshot({}, {});
    assert.strictEqual(refused, "Браузер не запущен. Сначала вызови browserOpen (url).", "отказ браузера не отдан как есть: " + refused);
    assert.strictEqual(events.length, 0, "на отказе ушло событие картинки");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  await test("браузер агента: модуль собран до реестра, с живым мостом и ссылками", () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const agentBrowser = createBrowserTools\(deps, live\);/.test(shellSrc), "модуль не собран или собран без живого моста — снимок не покажется в ленте");
    assert.ok(/const agentBrowser = createBrowserTools/.test(shellSrc.slice(0, shellSrc.indexOf("return {"))), "модуль собран после реестра — ссылки будут пустыми");
    assert.ok(shellSrc.indexOf("const browserTools = createBrowserTools") < 0, "модуль назван browserTools — это имя занято настоящим браузерным набором из deps");
    const names = ["browserConnect", "browserOpen", "browserSnapshot", "browserFill", "browserClick", "browserAct", "browserSelect", "browserPress", "browserText", "browserScreenshot", "browserEval", "browserDOM", "browserOverlays", "browserWait", "browserScroll", "browserHover", "browserNetwork", "browserReplay", "browserClose", "browserStatus", "browserClearProfile"];
    for (const name of names) {
      assert.ok(shellSrc.includes('"' + name + '": agentBrowser.' + name + ","), "инструмент «" + name + "» не сослался на модуль");
      assert.ok(shellSrc.indexOf('"' + name + '": async (args, settings) => {') < 0, "тело «" + name + "» осталось в оболочке");
    }
    const mod = fs.readFileSync(path.join(ROOT, "src", "agent-tools-browser.js"), "utf8");
    for (const name of names) {
      assert.ok(mod.includes('"' + name + '": async (args, settings) => {'), "в модуле нет тела «" + name + "»");
    }
    assert.ok(!/app\.getPath|__dirname|require\("\.\/agent-tools/.test(mod), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(!/^let |^var /m.test(mod), "в модуле завелось состояние уровня файла");
  });

  await test("пароли и почта: модуль собран на своём месте и с тем же deps", () => {
    const shellSrc = fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8");
    assert.ok(/const vaultTools = createVaultTools\(deps\);/.test(shellSrc), "модуль не собран или собран не тем аргументом");
    assert.ok(/const vaultTools = createVaultTools/.test(shellSrc.slice(0, shellSrc.indexOf("return {"))), "модуль собран после реестра — ссылки будут пустыми");
    for (const name of ["vaultList", "vaultFill", "mailSend", "mailList", "mailCode"]) {
      assert.ok(shellSrc.includes('"' + name + '": vaultTools.' + name + ","), "инструмент «" + name + "» не сослался на модуль");
      assert.ok(shellSrc.indexOf('"' + name + '": async (args, settings) => {') < 0, "тело «" + name + "» осталось в оболочке");
    }
    const mod = fs.readFileSync(path.join(ROOT, "src", "agent-tools-vault.js"), "utf8");
    for (const name of ["vaultList", "vaultFill", "mailSend", "mailList", "mailCode"]) {
      assert.ok(mod.includes('"' + name + '": async (args, settings) => {'), "в модуле нет тела «" + name + "»");
    }
    assert.ok(!/app\.getPath|__dirname|require\("\.\/agent-tools/.test(mod), "модуль сам достаёт состояние вместо внедрения");
    assert.ok(!/^let |^var /m.test(mod), "в модуле завелось состояние уровня файла");
  });
  await test("реестр инструментов: откат меняет журнал через сеттер, а не копию", async () => {
    const file = path.join(tmp, "note.txt");
    fs.writeFileSync(file, "новое", "utf8");
    state.activeRunUndo = [{ path: file, content: "старое" }];
    state.lastUndoLog = [];
    called.length = 0;
    const res = await tools.undoEdit({ path: file }, {});
    assert.match(res, /OK — файл откачен/, "откат выполнен: " + res);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "старое", "файл вернулся к прежнему содержимому");
    assert.ok(called.includes("loadPersistedUndo"), "журнал прошлых запусков читается");
    assert.ok(called.includes("persistUndo"), "журнал сохраняется после отката");
    assert.ok(called.includes("live.setActiveRunUndo"), "журнал текущего запуска записан сеттером: " + called.join(", "));
    assert.strictEqual(state.activeRunUndo.length, 0, "снимок снят из живого журнала");

    state.activeRunUndo = [];
    const empty = await tools.undoEdit({}, {});
    assert.match(empty, /Нет изменений для отката/, "пустой журнал честно об этом говорит: " + empty);

    // Ветка «что можно откатить»: журнал НЕПУСТОЙ, path не указан. Ровно здесь жил
    // настоящий баг (часть 40, заход 3b): вместо живого моста стояли голые
    // activeRunUndo / lastUndoLog — в строгом режиме это ReferenceError, и агент
    // получал «Ошибка: activeRunUndo is not defined» именно тогда, когда просил
    // список своих правок. Пустой журнал уходил в честный отказ выше и баг прятал.
    const second = path.join(tmp, "second.txt");
    state.activeRunUndo = [{ path: file, content: "старое" }, { path: file, content: "старое-2" }];
    state.lastUndoLog = [{ path: second, content: "из журнала" }];
    const list = await tools.undoEdit({}, {});
    assert.match(list, /Можно откатить/, "список отката не отдан: " + list);
    assert.ok(list.includes(file) && list.includes(second), "файлы живого и сохранённого журнала не названы: " + list);
    assert.ok(/шагов в истории: 2/.test(list), "повторы одного файла не сведены: " + list);
    state.activeRunUndo = [];
    state.lastUndoLog = [];
  });
  // Правки файла — из модуля записи (часть 40, заход 3b). Проверяем ПО ФАКТУ: обработчик
  // зовётся живьём с настоящим fs, а предохранители читаются по результату, а не по тексту.
  // Зависимости названы явно (так видно, чего обработчику на самом деле нужно).
  await test("правки файла: неоднозначность не правит файл молча", async () => {
    const { createWriteTools } = require(path.join(ROOT, "src", "agent-tools-write.js"));
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "write-tools-"));
    const target = path.join(dir, "правки.js");
    const writeTools = createWriteTools({
      fs,
      path,
      resolvePath: (p) => path.resolve(String(p == null ? "" : p)),
      agentWorkDir: () => dir,
      selfDev: { protectedSelfPath: () => false, protectedSelfPathMessage: () => "" },
      ota: { resolveCurrent: () => path.join(dir, "ota-нет") },
      snapshotFileForUndo: () => {},
      truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
    });
    fs.writeFileSync(target, "нужно();\nещё();\nнужно();\n", "utf8");
    const before = fs.readFileSync(target, "utf8");

    // 1. Фрагмент встречается дважды и не сказано, какой брать: правки быть НЕ должно
    // (снятие этого предохранителя не видел ни один текстовый сторож).
    const ambiguous = await writeTools.editFile({ path: target, oldText: "нужно();", newText: "готово();" }, {});
    assert.match(ambiguous, /встречается 2 раз \(строки: 1, 3\)/, "неоднозначность не названа: " + ambiguous);
    assert.strictEqual(fs.readFileSync(target, "utf8"), before, "файл изменён, хотя выбор был неоднозначен");

    // 2. occurrence выбирает вхождение по номеру — и правит именно его.
    const second = await writeTools.editFile({ path: target, oldText: "нужно();", newText: "готово();", occurrence: 2 }, {});
    assert.match(second, /OK — заменено/, "замена по номеру не прошла: " + second);
    assert.strictEqual(fs.readFileSync(target, "utf8"), "нужно();\nещё();\nготово();\n", "заменено не то вхождение");

    // 3. Замена строк по номерам: файл обязан стать ровно тем, что просили.
    fs.writeFileSync(target, "первая\nвторая\nтретья\nчетвёртая\n", "utf8");
    const range = await writeTools.editFile({ path: target, startLine: 2, endLine: 3, newText: "НОВАЯ" }, {});
    assert.match(range, /заменены строки 2–3/, "замена по номерам не названа: " + range);
    assert.strictEqual(fs.readFileSync(target, "utf8"), "первая\nНОВАЯ\nчетвёртая\n", "диапазон строк заменён не так");
    const over = await writeTools.editFile({ path: target, startLine: 99, newText: "нет" }, {});
    assert.match(over, /больше числа строк файла/, "выход за конец файла не объяснён: " + over);
  });
  // Файловые инструменты — своим модулем (часть 40, заход 3a). Проверяем ПО ФАКТУ,
  // а не по тексту: обработчики зовутся живьём, помощники разбора (numberedLines,
  // buildFileOutline, buildBlockRanges, langFromExt) берутся из настоящего модуля,
  // а не из заглушек. Текстового сторожа на ветку «большой файл» не было вовсе —
  // негативный контроль показал это: набор молчал, пока файл выгружался целиком.
  await test("файловые инструменты: большой файл — обзор вместо выгрузки целиком", async () => {
    const { createFileTools } = require(path.join(ROOT, "src", "agent-tools-files.js"));
    const { createProjectAnalysis } = require(path.join(ROOT, "src", "project-analysis.js"));
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "files-real-"));
    const bigFile = path.join(dir, "big.js");
    fs.writeFileSync(
      bigFile,
      Array.from({ length: 900 }, (_, i) => (i === 0 ? "function big() {" : "  // строка " + (i + 1))).join("\n") + "\n  return 1;\n}\n",
      "utf8"
    );
    const smallFile = path.join(dir, "small.js");
    fs.writeFileSync(smallFile, "function greet() {\n  return 1;\n}\n", "utf8");
    const bigLines = fs.readFileSync(bigFile, "utf8").split("\n").length;

    // Заглушки — только для того, что этот вызов не трогает; всё нужное настоящему
    // readFile приходит из настоящего модуля разбора файлов.
    const realDeps = Object.assign(Object.create(base), {
      fs,
      path,
      resolvePath: (p) => path.resolve(String(p == null ? "" : p)),
      agentWorkDir: () => dir,
      truncateText: (t, n) => String(t == null ? "" : t).slice(0, n || 4000),
      ...createProjectAnalysis({ fs, path }),
    });
    const real = createFileTools(realDeps);

    const big = await real.readFile({ path: bigFile }, {});
    assert.match(big, new RegExp("Файл большой: " + bigLines + " строк"), "большой файл не назван числами строк: " + String(big).slice(0, 80));
    assert.ok(/─ СТРУКТУРА/.test(big) && /─ НАЧАЛО ФАЙЛА:/.test(big) && /─ КОНЕЦ ФАЙЛА:/.test(big), "обзор большого файла неполный");
    assert.ok(!/строка 450/.test(big), "середина большого файла выгружена целиком — экономия токенов потеряна");

    const small = await real.readFile({ path: smallFile }, {});
    assert.ok(/function greet/.test(small) && /\(4 строк\)/.test(small), "маленький файл прочитан не целиком: " + String(small).slice(0, 60));
    const missing = await real.readFile({ path: path.join(dir, "нет.js") }, {});
    assert.match(missing, /файл не найден/, "отсутствующий файл не объяснён: " + missing);
  });

  // Пояс проекта — своим модулем (часть 40, заход 6b). Проверяем ПО ФАКТУ, а не по
  // тексту: заметки, дела, чекпоинты и поиск по смыслу зовутся живьём, хранилище
  // настоящее (src/agent-store.js), индекс настоящий (src/code-index.js), диск
  // настоящий. Тела уехали целиком, поэтому текстовый сторож не стоил бы здесь ничего.
  await test("пояс проекта: заметки, дела, чекпоинты и поиск по смыслу — на настоящем диске", async () => {
    const { createMemoryTools } = require(path.join(ROOT, "src", "agent-tools-memory.js"));
    const agentStore = require(path.join(ROOT, "src", "agent-store.js"));
    const codeIndex = require(path.join(ROOT, "src", "code-index.js"));
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "memory-userData-"));
    // Папка дел — своя, выбранная человеком: список дел не оседает в папке приложения.
    const tasksHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-tasks-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "memory-work-"));
    const target = path.join(work, "сервер.js");
    fs.writeFileSync(target, "function validateLogin(user) { return !!user; }\n", "utf8");
    let tasksPinged = 0;
    const tools = createMemoryTools({
      fs,
      path,
      agentStore,
      codeIndex,
      app: { getPath: () => userData },
      agentWorkDir: () => work,
      userDataDir: () => userData,
      tasksDataDir: () => tasksHome,
      emitTasksChanged: () => { tasksPinged++; },
      loadSettings: () => ({ contextMemory: true }),
      resolvePath: (p) => path.resolve(String(p == null ? "" : p)),
    });

    // 1. Заметки: круг «сохранить → прочитать → список → удалить». Кириллический ключ
    // обязан перевестись сам, а память проекта — лежать ВНЕ проекта (иначе уедет в git).
    const saved = await tools.noteSave({ key: "Клиенты ВК", content: "Адрес: app.local" }, {});
    assert.match(saved, /^OK — /, "заметка не сохранилась: " + saved);
    assert.ok(saved.includes("klienty-vk"), "кириллический ключ не переведён в латиницу: " + saved);
    const one = await tools.noteRead({ key: "klienty-vk" }, {});
    assert.ok(one.includes("Заметка «klienty-vk»") && one.includes("app.local"), "заметка не читается: " + one);
    assert.ok(/Заметки проекта \(1\)/.test(await tools.noteList({}, {})), "список заметок пуст");
    assert.ok(!fs.readdirSync(work).some((f) => f.indexOf("project-memory") >= 0), "память проекта легла внутрь проекта");
    assert.match(await tools.noteDelete({ key: "klienty-vk" }, {}), /удалена/, "заметка не удалилась");

    // 2. Дела: повтор обязан дойти до хранилища (именно это сторожит проверка выше),
    // а каждая правка — сразу отозваться панели дел.
    assert.match(await tools.taskAdd({ title: "Полить цветы", due: "завтра 10:00", repeat: "каждый день" }, {}), /^OK — /, "дело не создалось");
    const tasks = await tools.taskList({}, {});
    assert.ok(tasks.includes("Полить цветы") && tasks.includes("🔁 каждый день"), "повтор не дошёл до хранилища: " + tasks);
    assert.ok(tasksPinged > 0, "панель дел не получила событие об изменении");
    assert.match(await tools.taskDone({ key: "Полить" }, {}), /^OK — /, "дело не отметилось выполненным");
    assert.match(await tools.taskDelete({ key: "Полить" }, {}), /удалено/, "дело не удалилось");
    assert.ok(fs.existsSync(path.join(tasksHome, "tasks.json")), "список дел лёг не в выбранную папку дел");
    assert.ok(!fs.existsSync(path.join(userData, "tasks.json")), "список дел осел в папке приложения");

    // 3. Чекпоинты: снимок → правка → откат. Проверяем РЕЗУЛЬТАТ на диске, иначе
    // предохранители отката не видит никто.
    const shot = await tools.checkpointSave({ label: "перед правками" }, {});
    assert.match(shot, /^OK — /, "чекпоинт не создался: " + shot);
    const id = (/checkpointRollback\(id: ([a-z0-9-]+)\)/.exec(shot) || [])[1];
    assert.ok(id, "в ответе нет id чекпоинта: " + shot);
    fs.writeFileSync(target, "сломано\n", "utf8");
    assert.match(await tools.checkpointRollback({ id }, {}), /^OK — /, "откат не прошёл");
    assert.strictEqual(fs.readFileSync(target, "utf8"), "function validateLogin(user) { return !!user; }\n", "файл не вернулся к прежнему содержимому");
    assert.ok(/перед правками/.test(await tools.checkpointList({}, {})), "созданный чекпоинт не виден в списке");

    // 4. Поиск по смыслу: настоящий индекс по настоящей папке. Пустой запрос обязан
    // отказать ДО всякого поиска (и не трогать диск).
    assert.match(await tools.semanticSearch({ query: "validateLogin" }, {}), /validateLogin\.js|сервер\.js/, "поиск по смыслу не нашёл файл");
    assert.match(await tools.semanticSearch({}, {}), /укажи query/, "пустой запрос не отвергнут");

    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(tasksHome, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  // Миссии и план — своим модулем (часть 40, заход 6c). Проверяем ПО ФАКТУ на
  // настоящем хранилище миссий: файлы на диске, «своя» миссия прогона и события
  // панели. Текстовый сторож здесь не стоил бы ничего: тела уехали целиком.
  await test("миссии и план: своя миссия прогона, журнал на диске и события панели", async () => {
    const { createMissionTools } = require(path.join(ROOT, "src", "agent-tools-mission.js"));
    const missionStore = require(path.join(ROOT, "src", "mission-store.js"));
    const AgentCore = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "mission-work-"));
    const emitted = [];
    let planSummaryValue = null;
    let runMissionId = "";
    // ЛОВУШКА ПЕРЕНОСА: у двух «живых» объектов РАЗНАЯ форма, и это не описка.
    // deps.live (мост main.js) держит activeEmit методом-доступором — его зовут
    // БЕЗ аргументов, и он возвращает отправителя событий (или null): так делает
    // notifyMission. А live-мост модуля отдаёт самого отправителя геттером:
    // обработчики зовут live.activeEmit({...}) напрямую. Перепутать — значит
    // отправить событие никуда: промах прячет try/catch внутри notifyMission.
    const liveBridge = { activeEmit: () => (ev) => { emitted.push(ev); } }; // форма main.js
    const live = {
      get activeRunRole() { return "manager"; },
      get activeRunChatId() { return "chat-42"; },
      get activeRunMissionId() { return runMissionId; },
      get activeEmit() { return liveBridge.activeEmit(); },
      get activePlanSummary() { return planSummaryValue; },
      set activePlanSummary(v) { planSummaryValue = v; },
    };
    const tools = createMissionTools({
      missionStore,
      agentWorkDir: () => work,
      normalizePlanTasks: AgentCore.normalizePlanTasks,
      planSummary: AgentCore.planSummary,
      live: liveBridge,
    }, live);

    // 1. План: событие панели, сводка для предохранителя «план не закрыт» и полный
    // ответ человеку. Пустой план обязан отказать, а не показать пустую панель.
    const plan = await tools.todoWrite({ tasks: [{ text: "прочитать", status: "done" }, { text: "свести" }], title: "Разбор" }, {});
    assert.match(plan, /^OK — план показан пользователю: 1 из 2 готово/, "план подан не так: " + plan.slice(0, 80));
    const planEvent = emitted.find((e) => e && e.type === "plan");
    assert.ok(planEvent && planEvent.tasks.length === 2 && planEvent.title === "Разбор", "панель не получила план: " + JSON.stringify(planEvent));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(planSummaryValue)), { total: 2, done: 1, failed: 0 }, "сводка плана для предохранителя неверна: " + JSON.stringify(planSummaryValue));
    assert.match(await tools.todoWrite({ tasks: [] }, {}), /план пуст/, "пустой план не отвергнут");

    // 2. Миссия: файлы ложатся в рабочую папку, а роль и чат ПРОГОНА записаны внутрь —
    // панель показывает работу в том чате, где она начата.
    const started = await tools.missionStart({ goal: "разобрать заявки", steps: ["прочитать", "свести"], minutes: 30 }, {});
    const id = (/миссия создана: ([^\s]+)/.exec(started) || [])[1];
    assert.ok(id, "в ответе нет id миссии: " + started.slice(0, 80));
    const rec = missionStore.missionLoad(work, id);
    assert.ok(rec && rec.role === "manager" && rec.chatId === "chat-42", "миссия не помнит, кто её ведёт: " + JSON.stringify(rec && { role: rec.role, chatId: rec.chatId }));
    assert.ok(fs.existsSync(path.join(work, ".agent", "missions", id)), "папки миссии нет на диске");
    assert.ok(emitted.some((e) => e && e.type === "mission"), "панель не получила событие о миссии");

    // 3. «Своя» миссия прогона важнее свежей: инструмент без id работает с миссией
    // прогона, а не с самой свежей незакрытой — иначе агент закрывал чужую работу.
    // Вторая миссия — как её заводит само приложение: БЕЗ steps (план не передан).
    const second = await tools.missionStart({ goal: "чужая работа" }, {});
    const secondId = (/миссия создана: ([^\s]+)/.exec(second) || [])[1];
    runMissionId = id;
    const status = await tools.missionStatus({}, {});
    assert.ok(status.includes(id) && !status.includes(secondId), "инструмент без id взял не свою миссию: " + status.slice(0, 120));

    // 4. Шаг: заметка и «дальше» доезжают до журнала на диске.
    const step = await tools.missionStep({ next: "свести заявки", note: "прочитано 12 писем" }, {});
    assert.ok(step.includes(id) && /OK — миссия/.test(step), "шаг миссии не назван: " + step.slice(0, 80));
    const journal = fs.readFileSync(path.join(work, ".agent", "missions", id, "journal.md"), "utf8");
    assert.ok(journal.includes("прочитано 12 писем"), "заметка шага не дошла до журнала");

    // 4б. План панели становится планом МИССИИ. Живая беда: миссию заводит само
    // приложение (без steps), агент пишет план через todoWrite — и карточка миссии
    // навсегда оставалась «План не составлен», хотя план есть и работа идёт по нему.
    assert.strictEqual(missionStore.missionLoad(work, secondId).steps.length, 0, "проверка не о том: у второй миссии уже был план");
    runMissionId = secondId;
    const mirrored = await tools.todoWrite(
      { tasks: [{ text: "разобрать письма", status: "done" }, { text: "свести заявки", status: "in_progress" }, { text: "отчитаться" }] },
      {}
    );
    assert.ok(mirrored.includes("План миссии «" + secondId + "» обновлён: 1/3"), "план не перенесён в миссию: " + mirrored.slice(-160));
    const msRec = missionStore.missionLoad(work, secondId);
    assert.deepStrictEqual(msRec.steps.map((s) => s.state), ["done", "doing", "todo"], "шаги миссии не совпали с планом: " + JSON.stringify(msRec.steps));
    assert.strictEqual(msRec.next, "свести заявки", "«дальше» миссии не следует за планом: " + msRec.next);
    assert.deepStrictEqual(missionStore.missionProgress(msRec), { total: 3, done: 1, failed: 0, left: 2, current: "свести заявки", percent: 33 }, "прогресс миссии не сходится с планом");
    const msJournal = () => fs.readFileSync(path.join(work, ".agent", "missions", secondId, "journal.md"), "utf8");
    assert.ok(/План \(3\): разобрать письма · свести заявки · отчитаться/.test(msJournal()), "план не записан в журнал миссии");
    assert.ok(/✅ Шаг выполнен: разобрать письма/.test(msJournal()), "закрытый пункт плана не отмечен в журнале");
    assert.ok(emitted.filter((e) => e && e.type === "mission").length >= 2, "панель миссии не обновилась после переноса плана");
    // Дальше по тому же плану: переход пункта в «готово» пишет строку журнала ровно
    // один раз — повторный вызов с тем же списком её не дублирует.
    const donePlan = { tasks: [{ text: "разобрать письма", status: "done" }, { text: "свести заявки", status: "done" }, { text: "отчитаться", status: "in_progress" }] };
    await tools.todoWrite(donePlan, {});
    assert.strictEqual(msJournal().split("✅ Шаг выполнен: свести заявки").length - 1, 1, "переход пункта в «готово» не записан в журнал");
    await tools.todoWrite(donePlan, {});
    assert.strictEqual(msJournal().split("✅ Шаг выполнен: свести заявки").length - 1, 1, "повторный вызов плана продублировал журнал миссии");
    const lastProgress = missionStore.missionProgress(missionStore.missionLoad(work, secondId));
    assert.strictEqual(lastProgress.done, 2, "готовых пунктов после второго плана: " + lastProgress.done);
    assert.strictEqual(lastProgress.current, "отчитаться", "текущий пункт миссии не следует за планом: " + lastProgress.current);
    assert.strictEqual(lastProgress.percent, 67, "прогресс миссии не сходится с планом: " + lastProgress.percent);
    runMissionId = id;

    // 5. Закрытие: отчёт ложится файлом, а оставшаяся миссия снова находится.
    const fin = await tools.missionFinish({ report: "всё сделано", status: "done" }, {});
    assert.match(fin, /^OK — миссия /, "закрытие не названо: " + fin.slice(0, 80));
    assert.ok(fs.readFileSync(path.join(work, ".agent", "missions", id, "report.md"), "utf8").includes("всё сделано"), "отчёт не лёг на диск");
    runMissionId = "";
    const nextStatus = await tools.missionStatus({}, {});
    assert.ok(nextStatus.includes(secondId), "после закрытия своей миссии не нашлась оставшаяся: " + nextStatus.slice(0, 120));

    // 6. Незакрытых больше нет: повторное закрытие обязано сказать «уже закрыта» и
    // назвать прежний итог — иначе агент считает, что закрывать нечего, и повторяет.
    await tools.missionFinish({ report: "и это тоже сделано", status: "done" }, {});
    const again = await tools.missionFinish({ report: "ещё раз" }, {});
    assert.ok(again.includes("уже закрыта") && again.includes("Отчёт: .agent/missions/"), "повторное закрытие не назвало прежнюю работу: " + again.slice(0, 140));
    fs.rmSync(work, { recursive: true, force: true });
  });
}

// ── Разрез ядра: контекст и компакция ───────────────────────────────────────
// Модуль получает подключение к провайдеру (кому отправить запрос за памяткой) и
// транспорт (разбор частей сообщения). Настройки видит только те, что передали.
async function testContextWindow() {
  const makeContext = require(path.join(ROOT, "src", "renderer", "context-window.js"));
  const config = require(path.join(ROOT, "src", "renderer", "provider-config.js"));
  const partsText = (parts) => (parts || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  const ctx = makeContext({ config, transport: { partsText } });

  await test("контекст: бюджет, обрезка и пары инструментов — без ядра", () => {
    for (const n of ["estimateTokens", "estimateMessageTokens", "contextBudget", "windowBudget", "sanitizeToolPairs", "trimConversation", "truncateText", "compactRemote", "createContextManager"]) {
      assert.strictEqual(typeof ctx[n], "function", "модуль не собрал " + n);
    }
    // Токены: текст считается по длине, картинка — как фиксированный вес.
    assert.strictEqual(ctx.estimateTokens("привет мир"), 3, "оценка текста сломана");
    const withImage = ctx.estimateTokens([{ type: "text", text: "привет" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }]);
    assert.ok(withImage >= 800, "изображение не учтено в токенах: " + withImage);
    assert.ok(ctx.estimateMessageTokens({ role: "user", content: "привет мир" }) >= 3, "токены сообщения не считаются");

    // Бюджет: у локальных моделей свой потолок, у облака — 400k (как у Freebuff),
    // а настоящий предел задаёт окно модели (windowBudget выше по коду).
    assert.strictEqual(ctx.contextBudget("ollama", "qwen3:4b"), 14000, "потолок Ollama изменился");
    assert.strictEqual(ctx.CLOUD_CTX_BUDGET, 400000, "потолок облака вернулся к прежнему");
    assert.strictEqual(ctx.contextBudget("openai", "deepseek-chat"), ctx.CLOUD_CTX_BUDGET, "потолок для больших моделей изменился");
    assert.strictEqual(ctx.contextBudget("anthropic", "claude-sonnet-4"), 180000, "потолок Anthropic вышел за его окно 200k");
    assert.ok(ctx.contextBudget("openai", "gpt-4o") > 0, "бюджет обычной модели не посчитан");

    // Обрезка текста: короткий не трогаем, у длинного видно, сколько было.
    assert.strictEqual(ctx.truncateText("коротко", 100), "коротко", "короткий текст обрезан");
    const long = ctx.truncateText("x".repeat(500), 100);
    // Обрезка держит ОБА конца (начало и конец): у команд и запросов важное — в конце
    // (ошибка сборки, код возврата), поэтому хвост больше не теряется молча.
    assert.ok(long.startsWith("x".repeat(50)) && long.includes("обрезано: 500") && long.endsWith("x".repeat(50)), "обрезанный текст не объясняет размер: " + long.slice(40, 160));

    // Пары tool: осиротевший результат инструмента роняет запрос (400 wrong_api_format).
    const orphan = ctx.sanitizeToolPairs([{ role: "user", content: "привет" }, { role: "tool", tool_call_id: "a", content: "результат" }]);
    assert.deepStrictEqual(orphan.map((m) => m.role), ["user"], "осиротевший tool не убран");
    const paired = ctx.sanitizeToolPairs([
      { role: "user", content: "привет" },
      { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "readFile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "результат" },
    ]);
    assert.deepStrictEqual(paired.map((m) => m.role), ["user", "assistant", "tool"], "правильная пара выброшена");

    // Обрезка истории: цель задачи (последний вопрос) остаётся.
    const msgs = [{ role: "system", content: "СИСТЕМА" }];
    for (let i = 0; i < 12; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: "шум ".repeat(400) });
    msgs.push({ role: "user", content: "ЦЕЛЬ ЗАДАЧИ" });
    const kept = ctx.trimConversation(msgs, 900);
    assert.ok(kept.some((m) => m.content === "ЦЕЛЬ ЗАДАЧИ"), "последний вопрос потерян при обрезке");
    assert.ok(kept.every((m) => m.role !== "tool" || kept.some((x) => x.role === "assistant")), "в истории остался осиротевший tool");
  });

  await test("контекст: памятка запрашивается через подключение, а не напрямую", async () => {
    const real = global.fetch;
    const calls = [];
    try {
      global.fetch = async (url, opts) => {
        calls.push({ url: String(url), headers: opts && opts.headers, body: opts && opts.body });
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ПАМЯТКА: сделано то-то" } }] }) };
      };
      const big = (role, text) => ({ role, content: text.repeat(1200) });
      const messages = [
        { role: "system", content: "СИСТЕМА" },
        big("user", "пользователь просил "),
        big("assistant", "агент сделал "),
        big("user", "потом попросил "),
        big("assistant", "агент сделал "),
        { role: "user", content: "текущая задача" },
      ];
      const settings = { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k", model: "gpt-4o-mini" };

      // Голова маленькая — вызов модели не нужен, дешевле обычная обрезка.
      const small = await ctx.compactRemote(settings, [{ role: "user", content: "привет" }, { role: "user", content: "ещё" }]);
      assert.strictEqual(small, null, "памятка запрошена для крошечной истории");
      assert.strictEqual(calls.length, 0, "лишний запрос к провайдеру: " + calls.length);
      // Без модели сжимать нечем.
      assert.strictEqual(await ctx.compactRemote({ provider: "openai" }, messages), null, "без модели запрос всё равно ушёл");

      const memo = await ctx.compactRemote(settings, messages);
      assert.strictEqual(memo, "ПАМЯТКА: сделано то-то", "текст памятки не вернулся: " + memo);
      assert.strictEqual(calls.length, 1, "памятка запрошена не одним вызовом: " + calls.length);
      assert.strictEqual(calls[0].url, "https://api.openai.com/v1/chat/completions", "адрес запроса взят не из подключения: " + calls[0].url);
      assert.strictEqual(calls[0].headers.Authorization, "Bearer k", "ключ не доехал до запроса памятки");
      const sent = JSON.parse(calls[0].body);
      assert.strictEqual(sent.stream, false, "запрос памятки ушёл потоком");
      assert.ok(/Пользователь:|Агент:/.test(sent.messages[1].content), "в памятку не попала переписка с ролями");
      assert.ok(!sent.messages[1].content.includes("текущая задача"), "в памятку попал текущий вопрос — он должен остаться в истории");

      // Anthropic: ответ приходит блоками, а путь свой.
      calls.length = 0;
      global.fetch = async (url, opts) => {
        calls.push({ url: String(url), headers: opts && opts.headers, body: opts && opts.body });
        return { ok: true, json: async () => ({ content: [{ type: "text", text: "ПАМЯТКА ANTHROPIC" }] }) };
      };
      const ant = await ctx.compactRemote({ provider: "anthropic", anthropicUrl: "https://api.anthropic.com", anthropicApiKey: "k", model: "claude" }, messages);
      assert.strictEqual(ant, "ПАМЯТКА ANTHROPIC", "блоки ответа Anthropic не собраны: " + ant);
      assert.strictEqual(calls[0].url, "https://api.anthropic.com/v1/messages", "путь Anthropic неверен: " + calls[0].url);
      assert.strictEqual(calls[0].headers["x-api-key"], "k", "ключ Anthropic не доехал");

      // Отказ провайдера — не исключение: агент просто продолжит с обрезкой.
      global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      assert.strictEqual(await ctx.compactRemote(settings, messages), null, "ошибка провайдера не обработана как «памятки нет»");
    } finally {
      global.fetch = real;
    }
  });

  await test("контекст: менеджер сжимает переполнение и не теряет цель задачи", async () => {
    const real = global.fetch;
    const fetches = [];
    const events = [];
    const memos = [];
    try {
      global.fetch = async () => {
        fetches.push(1);
        return { ok: true, json: async () => ({ choices: [{ message: { content: "ПАМЯТКА " + fetches.length } }] }) };
      };
      const settings = { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k", model: "gpt-4o-mini" };
      const mgr = ctx.createContextManager({ settings, emit: (e) => events.push(e), onMemo: (m) => memos.push(m) });
      const big = (role, text) => ({ role, content: text.repeat(1200) });
      const messages = [
        { role: "system", content: "СИСТЕМА" },
        big("user", "просил "),
        big("assistant", "сделал "),
        big("user", "потом "),
        big("assistant", "сделал "),
        { role: "user", content: "ЦЕЛЬ ЗАДАЧИ" },
      ];

      // Контекст влезает: только страховка от осиротевших tool, вызова модели нет.
      const fits = await mgr.manage([{ role: "user", content: "привет" }], 100000);
      assert.deepStrictEqual(fits, [{ role: "user", content: "привет" }], "короткая история испорчена");
      assert.strictEqual(fetches.length, 0, "сжатие запустилось без переполнения");

      const squeezed = await mgr.manage(messages, 200);
      assert.strictEqual(squeezed[0].role, "system", "первым сообщением идёт не памятка");
      assert.ok(squeezed[0].content.includes("ПАМЯТКА ПРЕДЫДУЩЕГО КОНТЕКСТА"), "памятка не поставлена в начало: " + squeezed[0].content.slice(0, 60));
      assert.ok(squeezed.some((m) => m.content === "ЦЕЛЬ ЗАДАЧИ"), "цель задачи потеряна при сжатии");
      assert.ok(events.some((e) => e.type === "compact"), "пользователю не сказали, что контекст сжат");
      assert.strictEqual(memos.length, 1, "дневник памяток не получил запись: " + memos.length);
      assert.strictEqual(memos[0].text, "ПАМЯТКА 1", "в дневник ушёл не тот текст");
      assert.strictEqual(memos[0].model, "gpt-4o-mini", "в дневнике нет модели");
      assert.strictEqual(mgr.memo().content.includes("ПАМЯТКА 1"), true, "менеджер не помнит памятку");

      // Сжатий за прогон не больше трёх: иначе модель тратится на бесконечные пересказы.
      for (let i = 0; i < 6; i++) await mgr.manage(messages, 200);
      assert.ok(fetches.length <= 3, "сжатий больше предела: " + fetches.length);
      // В режиме плана сжатие выключено: план не должен теряться.
      const planMgr = ctx.createContextManager({ settings, planMode: true });
      const before = fetches.length;
      await planMgr.manage(messages, 200);
      assert.strictEqual(fetches.length, before, "в режиме плана контекст всё равно сжимался");
    } finally {
      global.fetch = real;
    }
  });

  await test("контекст: сжатие локальной модели несёт num_ctx и keep_alive, провал слышен", async () => {
    const real = global.fetch;
    const calls = [];
    try {
      global.fetch = async (url, opts) => {
        calls.push({ url: String(url), body: opts && opts.body });
        return { ok: true, status: 200, json: async () => ({ message: { content: "ПАМЯТКА ЛОКАЛЬНАЯ" } }), text: async () => "" };
      };
      const local = { provider: "ollama", ollamaUrl: "http://localhost:11434", model: "qwen3:4b" };
      const big = (role, text) => ({ role, content: text.repeat(1200) });
      const messages = [
        { role: "system", content: "СИСТЕМА" },
        big("user", "просил "),
        big("assistant", "сделал "),
        { role: "user", content: "ЦЕЛЬ ЗАДАЧИ" },
      ];
      const memo = await ctx.compactRemote(local, messages, { numCtx: 18096 });
      assert.strictEqual(memo, "ПАМЯТКА ЛОКАЛЬНАЯ", "памятка локальной модели не вернулась");
      assert.strictEqual(calls[0].url, "http://localhost:11434/api/chat", "не нативный путь Ollama: " + calls[0].url);
      const sent = JSON.parse(calls[0].body);
      // Без num_ctx Ollama берёт дефолт 2048: памятка собиралась из обрезанного текста,
      // а смена num_ctx заставляла её ещё и перезагрузить модель перед основным раундом.
      assert.deepStrictEqual(sent.options, { num_ctx: 18096 }, "num_ctx не ушёл в запрос за памяткой");
      assert.ok(sent.keep_alive, "keep_alive не ушёл: модель выгружалась бы между раундами");
      assert.strictEqual(sent.stream, false, "запрос памятки ушёл потоком");

      // Отказ сервера — не тишина: причина уходит наверх, иначе сжатие «молча не срабатывает».
      const failed = [];
      global.fetch = async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) });
      const none = await ctx.compactRemote(local, messages, { numCtx: 18096, onFail: (why) => failed.push(why) });
      assert.strictEqual(none, null, "при отказе сервера вернулась памятка");
      assert.strictEqual(failed.length, 1, "о провале сжатия никто не узнал");
      assert.ok(/500/.test(failed[0]), "причина провала не названа: " + failed[0]);

      // Менеджер сообщает о провале ОДИН раз за прогон, а не на каждом витке.
      const events = [];
      const mgr = ctx.createContextManager({ settings: local, emit: (e) => events.push(e), localCtx: 18096 });
      await mgr.manage(messages, 200);
      await mgr.manage(messages, 200);
      const notes = events.filter((e) => e.type === "notice" && /Сжать старые шаги/.test(e.text || ""));
      assert.strictEqual(notes.length, 1, "о провале сжатия сказано " + notes.length + " раз");
    } finally {
      global.fetch = real;
    }
  });
}

// ── Разрез ядра: веб-модуль ─────────────────────────────────────────────────
// Вынесенный модуль обязан работать БЕЗ агента: если он хоть раз дёрнет что-то из
// ядра, «самостоятельность» окажется мнимой, и правка модуля уронит приложение.
async function testWebTools() {
  const web = require(path.join(ROOT, "src", "renderer", "web-tools.js"));

  await test("веб-модуль: ссылки, сниппеты и текст разбираются без агента", () => {
    assert.strictEqual(
      web.ddgUrlToHttps("//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.ru%2Fb%3Fx%3D1"),
      "https://one.ru/b?x=1",
      "распакованная ссылка DuckDuckGo потерялась"
    );
    assert.strictEqual(web.ddgUrlToHttps("https://прямой.ру/x"), "https://прямой.ру/x", "прямая ссылка изменена");
    assert.strictEqual(web.stripHtml("<b>a</b>&nbsp;b&amp;c"), "a b&c", "раскрытие сущностей сломано");

    const html =
      '<a class="result__a" href="//d/l/?uddg=https%3A%2F%2Fone.ru">Первый &amp; второй</a>' +
      '<a class="result__snippet">сниппет один</a>' +
      '<a class="result__a" href="mailto:x@y.ru">почта</a>';
    const r = web.parseDdgHtml(html);
    assert.deepStrictEqual(
      r,
      [{ title: "Первый & второй", url: "https://one.ru", snippet: "сниппет один" }],
      "разбор html-выдачи DuckDuckGo: " + JSON.stringify(r)
    );
    // Нессылочные адреса (mailto) в результаты не попадают — иначе агент ходит в никуда.
    assert.strictEqual(r.length, 1, "в результаты попал не-http адрес");

    const lite = web.parseDdgLite(
      '<a class="result-link" href="https://two.ru">Второй</a><td class="result-snippet">сниппет два</td>'
    );
    assert.deepStrictEqual(lite, [{ title: "Второй", url: "https://two.ru", snippet: "сниппет два" }], "lite-выдача не разобрана");

    const text = web.htmlToText("<script>var secret=1</script><style>p{color:red}</style><p>Привет &mdash; мир</p>");
    assert.ok(text.includes("Привет — мир"), "текст страницы не извлёкся: " + JSON.stringify(text));
    assert.ok(!text.includes("var secret") && !text.includes("color:red"), "в текст попали скрипт или стиль");
  });

  await test("веб-модуль: таймаут, HTTP-ошибка и лимит размера", async () => {
    const real = global.fetch;
    try {
      global.fetch = async () => ({ ok: false, status: 404 });
      const notFound = await web.downloadHtml("https://x.example/нет");
      assert.strictEqual(notFound.ok, false, "404 отдан как успех");
      assert.strictEqual(notFound.error, "HTTP 404", "код ответа не назван: " + notFound.error);

      global.fetch = async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      };
      const aborted = await web.downloadHtml("https://x.example/долго");
      assert.strictEqual(aborted.error, "таймаут", "обрыв по времени назван непонятно: " + aborted.error);

      // Огромная страница не должна уходить в контекст целиком.
      global.fetch = async () => ({ ok: true, text: async () => "x".repeat(3 * 1024 * 1024) });
      const big = await web.downloadHtml("https://x.example/большая");
      assert.strictEqual(big.ok, true, "большая страница отброшена целиком");
      assert.strictEqual(big.text.length, 2 * 1024 * 1024, "страница не обрезана до 2 МБ: " + big.text.length);
    } finally {
      global.fetch = real;
    }
  });

  await test("веб-модуль: поиск переходит с html на lite, а не молчит", async () => {
    const real = global.fetch;
    const seen = [];
    try {
      // Первый адрес отвечает 200, но без результатов (капча/новая разметка) — тогда
      // модуль обязан попробовать lite-версию, иначе человек видит «ничего не нашлось».
      global.fetch = async (url) => {
        seen.push(String(url));
        if (String(url).includes("lite.duckduckgo.com")) {
          return { ok: true, text: async () => '<a class="result-link" href="https://lite.ru">Из lite</a>' };
        }
        return { ok: true, text: async () => "<html><body>ничего</body></html>" };
      };
      const res = await web.webSearchDDG("проверка");
      assert.strictEqual(seen.length, 2, "вторая (lite) попытка не сделана: " + seen.join(" → "));
      assert.ok(res.includes("https://lite.ru"), "результат lite не попал в ответ: " + res.slice(0, 120));

      // Serper: ключ отклонён — говорим про ключ, а не «ошибка поиска».
      global.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden" });
      const bad = await web.webSearchSerper("проверка", "плохой-ключ");
      assert.ok(/отклонил ключ/.test(bad), "отказ ключа Serper не объяснён: " + bad);
      assert.ok(/HTTP 403/.test(bad), "код ответа Serper потерян: " + bad);

      // webSearch без ключа идёт в DuckDuckGo, с ключом — в Serper.
      global.fetch = async (url) => {
        seen.push(String(url));
        return { ok: true, text: async () => "<html></html>" };
      };
      seen.length = 0;
      await web.webSearch("запрос", "");
      assert.ok(seen.some((u) => u.includes("duckduckgo.com")), "без ключа поиск ушёл не в DuckDuckGo: " + seen.join(" → "));
      seen.length = 0;
      global.fetch = async (url, opts) => {
        seen.push(String(url));
        assert.ok(opts && opts.headers && opts.headers["X-API-KEY"] === "ключ", "запрос Serper ушёл без ключа");
        return { ok: true, json: async () => ({ organic: [{ title: "T", link: "https://s.ru", snippet: "S" }] }) };
      };
      const serp = await web.webSearch("запрос", "ключ");
      assert.ok(seen[0].includes("serper.dev"), "с ключом поиск ушёл не в Serper: " + seen[0]);
      assert.ok(serp.includes("https://s.ru"), "результат Serper не попал в ответ");
    } finally {
      global.fetch = real;
    }
  });
}

// ── Разрез ядра: вспомогательная модель (зрение + генерация изображений) ─────
async function testImageTools() {
  const makeImageTools = require(path.join(ROOT, "src", "renderer", "image-tools.js"));

  await test("модуль изображений: собирается на трёх помощниках ядра", () => {
    const used = [];
    const tools = makeImageTools({
      apiHeaders: (provider, key, stream, extra) => {
        used.push("apiHeaders:" + provider + ":" + (key || "—") + ":" + (extra ? "extra" : "нет"));
        return { "X-Проверка": "1" };
      },
      proxiedBase: (u) => {
        used.push("proxiedBase");
        return String(u || "");
      },
      readApiError: async () => {
        used.push("readApiError");
        return "тело ошибки от провайдера";
      },
    });
    for (const n of ["auxConfig", "normalizeAuxBase", "imageAttempts", "imageProviderLabel", "describeImageRemote", "generateImageRemote", "proxiedUrl"]) {
      assert.strictEqual(typeof tools[n], "function", "модуль не собрал " + n);
    }
    assert.strictEqual(tools.imageProviderLabel("https://openrouter.ai/api/v1"), "OpenRouter", "провайдер не распознан");
    assert.strictEqual(tools.normalizeAuxBase("https://api.openai.com"), "https://api.openai.com/v1", "база не достроена");
    assert.ok(tools.proxiedUrl, "нет сборщика прокси-адреса");
  });

  await test("модуль изображений: подставленные помощники действительно работают", async () => {
    const calls = [];
    const tools = makeImageTools({
      apiHeaders: (provider, key, stream) => {
        calls.push("headers:" + provider);
        return { Authorization: "Bearer " + String(key || "") };
      },
      proxiedBase: (u) => {
        calls.push("proxy");
        return String(u || "");
      },
      readApiError: async () => {
        calls.push("readApiError");
        return "QUOTA_EXCEEDED: кончилась квота";
      },
    });
    const real = global.fetch;
    try {
      // Зрение: запрос идёт на /chat/completions, заголовки — от ядра, текст ошибки — тоже.
      global.fetch = async (url, opts) => {
        calls.push("fetch:" + String(url));
        assert.strictEqual(opts.headers.Authorization, "Bearer k", "заголовки ядра не дошли до запроса");
        return { ok: false, status: 429, text: async () => "{}" };
      };
      const cfg = tools.auxConfig({ visionEnabled: true, visionUrl: "https://api.openai.com/v1", visionKey: "k", visionModel: "m" });
      await assert.rejects(
        () => tools.describeImageRemote(cfg, "data:image/png;base64,AA==", "что тут?", "m"),
        /QUOTA_EXCEEDED/,
        "ошибка провайдера не показана человеку"
      );
      assert.ok(calls.includes("proxy"), "адрес не прошёл через прокси браузерного режима");
      assert.ok(calls.includes("headers:openai"), "заголовки собраны не для openai-диалекта");
      assert.ok(calls.includes("fetch:" + cfg.url + "/chat/completions"), "запрос ушёл не на /chat/completions: " + calls.join(" | "));
      // Текст ошибки берётся у ядра: без этого человек снова увидел бы пустое сообщение.
      assert.ok(calls.includes("readApiError"), "тело ответа не прочитано: " + calls.join(" | "));

      // Адрес берётся из переданной конфигурации, а не из настроек приложения:
      // это и делает модуль самостоятельным.
      calls.length = 0;
      const other = tools.auxConfig({ visionEnabled: true, visionUrl: "https://свой.прокси/v1", visionKey: "k2", visionModel: "m" });
      global.fetch = async (url) => {
        calls.push("fetch:" + String(url));
        return { ok: false, status: 500, text: async () => "{}" };
      };
      await assert.rejects(() => tools.describeImageRemote(other, "data:image/png;base64,AA==", "что тут?", "m"));
      assert.ok(calls.includes("fetch:https://свой.прокси/v1/chat/completions"), "чужой базовый адрес изменён: " + calls.join(" | "));

      // Явная ошибка вместо пустого ответа: без адреса модуль обязан отказать громко.
      let loud = false;
      global.fetch = async (url) => {
        if (!/^https?:/i.test(String(url))) throw new TypeError("Failed to parse URL from " + url);
        return { ok: true, json: async () => ({}) };
      };
      try {
        await tools.describeImageRemote(tools.auxConfig({ visionEnabled: true, visionKey: "k" }), "data:image/png;base64,AA==", "что тут?", "m");
      } catch (e) {
        loud = e instanceof Error;
      }
      assert.ok(loud, "без адреса разбор картинки прошёл молча");
    } finally {
      global.fetch = real;
    }
  });
}

// ── Разрез ядра: связность ──────────────────────────────────────────────────
// Модуль, который никто не подключил, в Electron main работает (require), а в окне
// молча падает: window.WebTools нет, и приложение остаётся пустым. Поэтому проверяем
// все пути загрузки сразу — тег в index.html, список preview-сервера и require в ядре.
async function testCoreSplit() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const bridge = fs.readFileSync(path.join(ROOT, "src", "mobile-bridge.js"), "utf8");

  await test("разрез ядра: модули подключены в окне, мосту и ядре", () => {
    const posWeb = html.indexOf('src="web-tools.js"');
    const posImg = html.indexOf('src="image-tools.js"');
    const posCore = html.indexOf('src="agent-core.js"');
    assert.ok(posWeb > 0 && posImg > 0 && posCore > 0, "в index.html нет тегов модулей");
    assert.ok(posWeb < posCore && posImg < posCore, "модули подключены ПОСЛЕ ядра — window.WebTools будет пустым");
    assert.ok(/require\("\.\/web-tools\.js"\)/.test(coreSrc), "ядро не требует web-tools в CommonJS");
    assert.ok(/require\("\.\/image-tools\.js"\)/.test(coreSrc), "ядро не требует image-tools в CommonJS");
    assert.ok(
      /factory\(root\.ProviderConfig, root\.ProviderTransport, root\.ContextWindow, root\.WebTools, root\.ImageTools, root\.Prompts, root\.ToolSchemas\)/.test(coreSrc),
      "браузерная ветка ядра не получает модули"
    );
    // Данные агента вынесены в свои модули: промпт — текст правил, схемы — таблица
    // инструментов. Проверяем все три пути загрузки, иначе в окне агент стартует
    // без правил и без инструментов (в Electron main require бы сработал).
    assert.ok(/require\("\.\/prompts\.js"\)/.test(coreSrc), "ядро не требует prompts.js в CommonJS");
    assert.ok(/require\("\.\/tool-schemas\.js"\)/.test(coreSrc), "ядро не требует tool-schemas.js в CommonJS");
    const posPrompt = html.indexOf('src="prompts.js"');
    const posSchemas = html.indexOf('src="tool-schemas.js"');
    assert.ok(posPrompt > 0 && posSchemas > 0, "в index.html нет тегов данных агента");
    assert.ok(posPrompt < posCore && posSchemas < posCore, "данные подключены ПОСЛЕ ядра — window.Prompts будет пустым");
    assert.ok(/"prompts\.js"/.test(bridge) && /"tool-schemas\.js"/.test(bridge), "preview-мост не отдаёт данные агента телефону");
    // Само ядро больше не хранит ни текста правил, ни таблицы схем: иначе правки
    // уходили бы в две копии и расходились.
    assert.ok(!/const SYSTEM_PROMPT = `/.test(coreSrc), "текст промпта остался в ядре");
    assert.ok(!/const TOOL_DEFINITIONS = \[/.test(coreSrc), "таблица схем осталась в ядре");
    // А через общий объект они доступны по-прежнему — main.js и тесты не менялись.
    assert.ok(typeof core.SYSTEM_PROMPT === "string" && core.SYSTEM_PROMPT.length > 20000, "ядро перестало отдавать SYSTEM_PROMPT");
    assert.ok(Array.isArray(core.TOOL_DEFINITIONS) && core.TOOL_DEFINITIONS.length >= 90, "ядро перестало отдавать TOOL_DEFINITIONS");
    // Модули данных самостоятельны: ни require, ни обращений к window внутри.
    const promptSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "prompts.js"), "utf8");
    const schemaSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "tool-schemas.js"), "utf8");
    // Смотрим КОД, а не текст данных: в описании инструмента законно встречается
    // «window.__x» — это строка для модели, а не обращение к объекту окна.
    for (const pair of [["prompts.js", promptSrc], ["tool-schemas.js", schemaSrc]]) {
      const code = codeOnly(pair[1]);
      assert.ok(!/require\(/.test(code), pair[0] + " тянет за собой модули — данные должны быть самодостаточны");
      assert.ok(!/window\./.test(code), pair[0] + " лезет в window");
      assert.ok(!/AgentCore/.test(code), pair[0] + " ссылается на ядро");
    }
    assert.ok(/require\("\.\/provider-config\.js"\)/.test(coreSrc), "ядро не требует provider-config в CommonJS");
    const posCfg = html.indexOf('src="provider-config.js"');
    assert.ok(posCfg > 0 && posCfg < posCore, "подключение к провайдеру подключено ПОСЛЕ ядра — window.ProviderConfig будет пустым");
    assert.ok(/"provider-config\.js"/.test(bridge), "preview-мост не отдаёт модуль подключения телефону");
    assert.ok(/require\("\.\/provider-transport\.js"\)/.test(coreSrc), "ядро не требует provider-transport в CommonJS");
    const posTr = html.indexOf('src="provider-transport.js"');
    assert.ok(posTr > 0 && posTr < posCore, "транспорт подключён ПОСЛЕ ядра — window.ProviderTransport будет пустым");
    assert.ok(posCfg < posTr, "транспорт подключён раньше подключения к провайдеру");
    assert.ok(/"provider-transport\.js"/.test(bridge), "preview-мост не отдаёт транспорт телефону");
    assert.ok(/require\("\.\/context-window\.js"\)/.test(coreSrc), "ядро не требует context-window в CommonJS");
    const posCtx = html.indexOf('src="context-window.js"');
    assert.ok(posCtx > 0 && posCtx < posCore, "контекст подключён ПОСЛЕ ядра — window.ContextWindow будет пустым");
    assert.ok(posTr < posCtx, "контекст подключён раньше транспорта, а он им пользуется");
    assert.ok(/"context-window\.js"/.test(bridge), "preview-мост не отдаёт контекст телефону");
    assert.ok(!/function trimConversation\(/.test(coreSrc), "trimConversation остался в ядре");
    assert.ok(!/function compactRemote\(/.test(coreSrc), "compactRemote остался в ядре");
    // Само ядро больше не содержит перенесённого транспорта.
    assert.ok(!/function buildChatRequest\(/.test(coreSrc), "buildChatRequest остался в ядре");
    assert.ok(!/function consumeProviderStream\(/.test(coreSrc), "consumeProviderStream остался в ядре");
    assert.ok(!/function messagesForProvider\(/.test(coreSrc), "messagesForProvider остался в ядре");
    assert.ok(/"web-tools\.js"/.test(bridge) && /"image-tools\.js"/.test(bridge), "preview-мост не отдаёт модули телефону");
    // Само ядро больше не содержит перенесённого кода: иначе правки шли бы в две копии.
    assert.ok(!/function stripHtml\(/.test(coreSrc), "stripHtml остался в ядре");
    assert.ok(!/function generateImageRemote\(/.test(coreSrc), "generateImageRemote остался в ядре");
    assert.ok(!/function parseDdgHtml\(/.test(coreSrc), "parseDdgHtml остался в ядре");
    // А через общий объект имена доступны по-прежнему — main.js и инструменты не менялись.
    for (const n of ["webSearch", "webFetchPage", "htmlToText", "downloadHtml", "webSearchDDG", "classifyKeyError", "auxConfig", "imageAttempts", "describeImageRemote", "generateImageRemote", "proxiedUrl"]) {
      assert.strictEqual(typeof core[n], "function", "ядро перестало отдавать " + n);
    }
    // Ядро отдаёт наружу именно модульные функции (фабрика каждый раз создаёт новые
    // обёртки, поэтому сверяем поведение и имя, а не ссылки): правка модуля меняет
    // поведение агента, а не оседает во второй копии.
    const web = require(path.join(ROOT, "src", "renderer", "web-tools.js"));
    const img = require(path.join(ROOT, "src", "renderer", "image-tools.js"))({ apiHeaders: () => ({}), proxiedBase: (u) => u, readApiError: async () => "" });
    assert.strictEqual(core.webSearch.name, web.webSearch.name, "ядро отдаёт не модульный веб-поиск");
    assert.strictEqual(core.htmlToText("<p>a &amp; b</p>"), web.htmlToText("<p>a &amp; b</p>"), "поведение веб-модуля и ядра разошлось");
    assert.strictEqual(core.imageProviderLabel("https://openrouter.ai/api/v1"), img.imageProviderLabel("https://openrouter.ai/api/v1"), "поведение модуля изображений и ядра разошлось");
    assert.strictEqual(core.generateImageRemote.name, img.generateImageRemote.name, "ядро отдаёт не модульную генерацию изображений");
  });

  await test("разрез ядра: в окне (теги из index.html по порядку) ядро поднимается и данные на месте", () => {
    const vm = require("vm");
    // Порядок берём ИЗ РАЗМЕТКИ, а не из головы: если тег забудут или переставят,
    // это и есть тот случай, когда в приложении агент стартует без правил.
    const tags = (html.match(/<script src="[^"]+"><\/script>/g) || []).map((t) => /src="([^"]+)"/.exec(t)[1]);
    const needed = tags.filter((f) => /^(provider-config|provider-transport|context-window|web-tools|image-tools|prompts|tool-schemas|agent-core)\.js$/.test(f));
    assert.strictEqual(needed.length, 8, "в разметке не все модули ядра: " + needed.join(", "));
    const sandbox = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    sandbox.self = sandbox;
    sandbox.window = sandbox;
    sandbox.fetch = () => {
      throw new Error("в этом тесте сеть не нужна");
    };
    vm.createContext(sandbox);
    for (const f of needed) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "renderer", f), "utf8"), sandbox, { filename: f });
    }
    const win = sandbox.window.AgentCore;
    assert.ok(win, "в окне не появилось ядро — модули не подключены или идут после ядра");
    const electron = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
    // Одни и те же данные: в окне и в главном процессе не может быть двух промптов.
    assert.strictEqual(win.SYSTEM_PROMPT, electron.SYSTEM_PROMPT, "промпт в окне и в main разошлись");
    assert.strictEqual(JSON.stringify(win.TOOL_DEFINITIONS), JSON.stringify(electron.TOOL_DEFINITIONS), "таблица схем в окне и в main разошлась");
    assert.strictEqual(win.PLAN_MODE_TOOL_DEFINITIONS.length, 1, "режим плана потерял todoWrite");
    // И главный путь ядра работает в живой странице: запрос к Ollama собирается.
    const req = win.buildChatRequest(
      { provider: "ollama", ollamaUrl: "http://127.0.0.1:11434" },
      { model: "qwen3:8b", messages: [{ role: "user", content: "привет" }], tools: win.TOOL_DEFINITIONS, numCtxBudget: 14000 }
    );
    const body = JSON.parse(req.body);
    assert.strictEqual(body.tools.length, win.TOOL_DEFINITIONS.length, "в окне инструменты не доехали до запроса");
    // Контекст считается в живом окне по той же формуле: бюджет + запас на ответ.
    assert.ok(body.options && body.options.num_ctx === 14000 + 4096, "в окне неверно посчитан num_ctx: " + JSON.stringify(body.options));
  });
  await test("разрез ядра: вынесенные модули не тянут за собой ядро", () => {
    // Обратная ошибка: модуль «самостоятелен» только на бумаге и на деле берёт
    // помощники из ядра. Тогда его нельзя ни проверить, ни переиспользовать.
    const stubDeps = { apiHeaders: () => ({}), proxiedBase: (u) => u, readApiError: async () => "" };
    const allowed = {
      "provider-config.js": { src: require(path.join(ROOT, "src", "renderer", "provider-config.js")), deps: [] },
      "provider-transport.js": {
        src: require(path.join(ROOT, "src", "renderer", "provider-transport.js"))({ config: {}, toolDefinitions: [] }),
        deps: [],
      },
      "context-window.js": {
        src: require(path.join(ROOT, "src", "renderer", "context-window.js"))({ config: {}, transport: {} }),
        deps: [],
      },
      "web-tools.js": { src: require(path.join(ROOT, "src", "renderer", "web-tools.js")), deps: [] },
      "image-tools.js": { src: require(path.join(ROOT, "src", "renderer", "image-tools.js"))(stubDeps), deps: ["apiHeaders", "proxiedBase", "readApiError"] },
      "prompts.js": { src: require(path.join(ROOT, "src", "renderer", "prompts.js")), deps: [] },
      "tool-schemas.js": { src: require(path.join(ROOT, "src", "renderer", "tool-schemas.js")), deps: [] },
    };
    for (const [file, info] of Object.entries(allowed)) {
      const src = codeOnly(fs.readFileSync(path.join(ROOT, "src", "renderer", file), "utf8"));
      // Свои имена модуля (в том числе экспортируемые) — не утечка: ядро раздаёт их же.
      const own = new Set(Object.keys(info.src));
      // Имена, ОБЪЯВЛЕННЫЕ внутри модуля (в том числе полученные из deps), — это и есть
      // внедрение. Утечка — имя, которого модуль ниоткуда не получил: тогда у человека
      // упадёт «X is not defined» ровно в этом месте.
      const declared = new Set();
      for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
      for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
        for (const m2 of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(m2[1]);
      }
      for (const m of src.matchAll(/function\s*[A-Za-z_$]*\s*\(([^)]*)\)/g)) {
        for (const m2 of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(m2[1]);
      }
      for (const m of src.matchAll(/\(([^)]*)\)\s*=>/g)) {
        for (const m2 of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(m2[1]);
      }
      for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]);
      const leaked = [];
      for (const name of Object.keys(core)) {
        if (info.deps.includes(name) || own.has(name) || declared.has(name)) continue;
        if (new RegExp("(^|[^\\w$.'\"])\\b" + name + "\\b").test(src)) leaked.push(name);
      }
      assert.deepStrictEqual(leaked, [], file + " ссылается на ядро без внедрения: " + leaked.join(", "));
    }
  });
}

module.exports = {
  testAgentTools,
  testWebTools,
  testImageTools,
  testCoreSplit,
  testContextWindow,
};

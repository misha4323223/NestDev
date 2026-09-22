"use strict";
/* ─── Живой прогон git-инструментов агента (без окна) ────────────────────────
   Запуск: bun run test:live:tools-git    (node scripts/live-tools-git.js)

   Зачем этот прогон. Шестнадцать git-обработчиков (gitClone, gitStatus,
   gitCommit, gitPush, gitPublish, gitInit, gitPull, gitLog, gitRevert,
   gitBranch, gitCheckout, gitDiff, gitUndoLastCommit, gitStash, gitCherryPick,
   gitBlame) проверялись только по тексту, а после того как они уехали своим
   модулем (часть 40, заход 2), «проверено по тексту» означает: потерянная ветка
   или сломанный живой мост не видны никому.

   Что поднимается НАСТОЯЩЕЕ:
     • src/main.js целиком (поддельный только `electron`);
     • настоящий src/tool-registry.js — вызов идёт тем же путём, что у агента;
     • настоящий src/agent-tools.js и его модуль src/agent-tools-git.js;
     • настоящий git: репозиторий создаётся, файлы коммитятся, ветки
       переключаются, stash прячет и возвращает, push уходит в локальный
       bare-репозиторий. Ничего не выдумано и в сеть не ходим.

   Проверки:
     [1] проводка: модуль собран один раз, с тем же объектом состояния и живым мостом;
     [2] gitInit создаёт настоящий репозиторий и не делает этого дважды;
     [3] gitStatus → gitCommit → gitLog на настоящей истории;
     [4] gitBranch / gitCheckout / gitDiff между ветками;
     [5] gitStash: push / list / pop возвращают изменения;
     [6] gitBlame и gitUndoLastCommit на настоящих коммитах;
     [7] gitPush: отказ без разрешения (в bare-репозиторий ничего не ушло) и
         настоящий push, когда пользователь разрешил;
     [8] gitClone: клон настоящего репозитория и живой мост (папка последнего
         клона и флаг «после клона» — то, что копией значения не работает);
     [9] gitPublish: отказ без разрешения и проверка формата адреса — без сети.

   Ничего в репозитории приложения не пишется: всё в temp-папках. */

const Module = require("module");
const { execFileSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-git-userData-"));
const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-git-work-"));
const work = path.join(sandboxDir, "work");
const source = path.join(sandboxDir, "source");
const bare = path.join(sandboxDir, "bare.git");
const cloneDir = path.join(sandboxDir, "clones", "copy");
fs.mkdirSync(work, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  cond ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (v) => (typeof v === "string" ? v : JSON.stringify(v));
// Настоящий git в прогоне: только для ПОДГОТОВКИ (bare-репозиторий, upstream,
// исходный репозиторий для клона). Инструменты агента ходят в git сами.
const git = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function writeSettings(over) {
  const s = Object.assign(
    { workingDir: work, model: "test-model", provider: "openai", allowAgentPush: false },
    over || {}
  );
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(s, null, 2));
}
writeSettings();

// ── Поддельный electron: окно в прогоне не нужно ───────────────────────────
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
};
const mkWin = (id) => ({
  webContents: { id, send: () => {}, on: () => {}, once: () => {}, openDevTools: () => {}, setWindowOpenHandler: () => {} },
  isDestroyed: () => false, isFocused: () => true, isMinimized: () => false,
  on: () => {}, once: () => {}, loadFile: () => Promise.resolve(), show: () => {}, focus: () => {},
  restore: () => {}, maximize: () => {}, setTitle: () => {}, close: () => {},
});

// ── Перехват: видим, кто кого собрал и с чем ───────────────────────────────
const seenWiring = { git: 0, gitDeps: null, gitLive: null, toolDeps: null, api: null, tools: null };
const origin = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === "electron") {
    return {
      app: {
        getPath: (what) => (String(what) === "userData" ? userData : path.join(userData, String(what || "userData"))),
        whenReady: () => Promise.resolve(), on: () => {}, requestSingleInstanceLock: () => true,
        quit: () => {}, getVersion: () => "1.5.193", setName: () => {}, setAppUserModelId: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, removeHandler: () => {} },
      shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => "" },
      dialog: stub("dialog"),
      safeStorage: { isEncryptionAvailable: () => false },
      BrowserWindow: function () { return mkWin(11); },
      Notification: function () { this.show = () => {}; },
      Menu: stub("Menu"), screen: stub("screen"), Tray: stub("Tray"), nativeImage: stub("nativeImage"),
      clipboard: stub("clipboard"), powerMonitor: stub("powerMonitor"),
      desktopCapturer: stub("desktopCapturer"), globalShortcut: stub("globalShortcut"),
    };
  }
  const t = String(req);
  if (/agent-tools-git\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createGitTools: (deps, live) => {
        seenWiring.git++;
        seenWiring.gitDeps = deps;
        seenWiring.gitLive = live;
        return real.createGitTools(deps, live);
      },
    };
  }
  if (/agent-tools\.js$/.test(t)) {
    const real = origin.apply(this, arguments);
    return {
      createAgentTools: (deps) => {
        seenWiring.toolDeps = deps;
        const tools = real.createAgentTools(deps);
        seenWiring.tools = tools;
        return tools;
      },
    };
  }
  if (t.indexOf("tool-registry") >= 0) {
    const real = origin.apply(this, arguments);
    return {
      createToolRegistry: (deps) => {
        seenWiring.api = real.createToolRegistry(deps);
        return seenWiring.api;
      },
      describeToolArgs: real.describeToolArgs,
    };
  }
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

const watchdog = setTimeout(() => {
  console.error("❌ Живой прогон не завершился за 120 секунд");
  process.exit(1);
}, 120000);
watchdog.unref();

(async () => {
  process.env.AI_AGENT_OTA_ROOT = path.join(userData, "ota");
  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон git-инструментов агента (настоящий main.js и настоящий git)");
  await sleep(400);

  const d = seenWiring.toolDeps || {};
  const executeTool = seenWiring.api && seenWiring.api.executeTool;
  ok(typeof executeTool === "function", "реестр отдал вызов инструмента");
  // Настройки прогона — СНИМОК, как в настоящем прогоне (run-ai берёт их при старте).
  // Разрешения (push/публикация) в приложении читаются ИМЕННО из этого снимка, поэтому
  // там, где мы их меняем, берём свежие настройки ЯВНО — иначе проверка ничего не измеряет.
  const settings = d.loadSettings();
  const call = (name, args) => executeTool(name, args || {}, settings);
  const callFresh = (name, args) => executeTool(name, args || {}, d.loadSettings());

  console.log("\n[1] проводка: модуль собран один раз, с тем же состоянием и живым мостом");
  ok(seenWiring.git === 1, "createGitTools вызван " + seenWiring.git + " раз(а)");
  ok(seenWiring.gitDeps === d, "модуль получил ТОТ ЖЕ объект, что и agent-tools");
  const live = seenWiring.gitLive || {};
  ok(typeof live === "object", "живой мост передан вторым аргументом");
  // Мост — это геттеры/сеттеры main.js: проверяем, что он РАБОТАЕТ (копией значения
  // «папка последнего клона» застыла бы и инструменты ушли бы в чужой проект).
  live.clonedRepoPending = true;
  ok(live.clonedRepoPending === true, "запись через мост доходит до состояния приложения");
  live.clonedRepoPending = false;
  const gitNames = ["gitClone", "gitStatus", "gitCommit", "gitPush", "gitPublish", "gitInit", "gitPull", "gitLog",
    "gitRevert", "gitBranch", "gitCheckout", "gitDiff", "gitUndoLastCommit", "gitStash", "gitCherryPick", "gitBlame"];
  const missing = gitNames.filter((n) => typeof seenWiring.tools[n] !== "function");
  ok(missing.length === 0, "все шестнадцать инструментов на месте" + (missing.length ? ": нет " + missing.join(", ") : ""));

  console.log("\n[2] gitInit: настоящий репозиторий");
  fs.writeFileSync(path.join(work, "README.md"), "# прогон\n");
  const init = plain(await call("gitInit", { message: "первый коммит" }));
  ok(/Создан локальный git-репозиторий/.test(init), "репозиторий создан: " + init.split("\n")[0]);
  let inside = "";
  try { inside = git("rev-parse", "--is-inside-work-tree").trim(); } catch (e) { inside = "ошибка: " + e.message; }
  ok(inside === "true", "git подтверждает рабочее дерево: " + inside);
  ok(git("log", "--oneline").trim().length > 0, "первый коммит действительно сделан");
  const again = plain(await call("gitInit", {}));
  ok(/уже git-репозиторий/.test(again), "повторный gitInit не ломает репозиторий");

  console.log("\n[3] gitStatus → gitCommit → gitLog");
  fs.writeFileSync(path.join(work, "note.txt"), "первая версия\n");
  const status = plain(await call("gitStatus", {}));
  ok(/note\.txt/.test(status), "неотслеживаемый файл виден в статусе");
  const commit = plain(await call("gitCommit", { message: "заметка" }));
  ok(/git add -A/.test(commit) && !/Ошибка git:/.test(commit), "коммит прошёл: " + commit.split("\n")[0]);
  const log = plain(await call("gitLog", {}));
  ok(/заметка/.test(log), "сообщение коммита видно в логе");
  const noMsg = plain(await call("gitCommit", {}));
  ok(/укажи message/.test(noMsg), "коммит без message объяснён, а не сделан молча");

  console.log("\n[4] ветки: gitBranch, gitCheckout, gitDiff");
  const branch = plain(await call("gitBranch", {}));
  ok(/main/.test(branch), "текущая ветка названа: " + branch.split("\n")[0]);
  const created = plain(await call("gitCheckout", { branch: "feature", create: true }));
  ok(/создана и активирована ветка «feature»/.test(created), "ветка создана и активна");
  fs.writeFileSync(path.join(work, "note.txt"), "версия во второй ветке\n");
  await call("gitCommit", { message: "правка в ветке" });
  const diff = plain(await call("gitDiff", { branch1: "main", branch2: "feature" }));
  ok(/note\.txt/.test(diff) && /изменено файлов: 1/.test(diff), "различие ветвей названо файлом: " + diff.split("\n")[0]);
  const back = plain(await call("gitCheckout", { branch: "main" }));
  ok(/переключение на ветку «main»/.test(back), "возврат на main");
  const noBranch = plain(await call("gitCheckout", {}));
  ok(/укажи branch/.test(noBranch), "переключение без имени ветки объяснено");

  console.log("\n[5] gitStash: спрятать и вернуть");
  fs.writeFileSync(path.join(work, "note.txt"), "незакоммиченная правка\n");
  const stashed = plain(await call("gitStash", { action: "push", message: "прогон" }));
  ok(/изменения спрятаны в stash/.test(stashed), "изменения спрятаны: " + stashed.split("\n")[0]);
  ok(fs.readFileSync(path.join(work, "note.txt"), "utf8") === "первая версия\n", "рабочее дерево действительно чистое");
  const list = plain(await call("gitStash", { action: "list" }));
  ok(/прогон/.test(list), "стек stash показывает запись");
  const popped = plain(await call("gitStash", { action: "pop" }));
  ok(/изменения возвращены из stash/.test(popped), "изменения возвращены");
  ok(fs.readFileSync(path.join(work, "note.txt"), "utf8") === "незакоммиченная правка\n", "правка вернулась в файл");
  const badAction = plain(await call("gitStash", { action: "нетТакого" }));
  ok(/action может быть push/.test(badAction), "незнакомое действие объяснено");

  console.log("\n[6] gitBlame и gitUndoLastCommit");
  // Файл сейчас с незакоммиченной правкой (её вернул stash): blame обязан честно
  // сказать, что строка ещё не в коммите, а не приписать её кому-то.
  const dirtyBlame = plain(await call("gitBlame", { path: path.join(work, "note.txt"), lines: 1 }));
  ok(/Not Committed Yet/.test(dirtyBlame), "незакоммиченная строка названа честно: " + dirtyBlame.replace(/\n/g, " | ").slice(0, 120));
  await call("gitCommit", { message: "вернул из stash" });
  const blame = plain(await call("gitBlame", { path: path.join(work, "note.txt"), lines: 1 }));
  ok(/git blame/.test(blame) && /AI Agent/.test(blame), "у закоммиченной строки назван автор: " + blame.replace(/\n/g, " | ").slice(0, 160));
  const blameMissing = plain(await call("gitBlame", { path: path.join(work, "нет-файла.txt") }));
  ok(/файл не найден/.test(blameMissing), "отсутствующий файл объяснён, а не брошен исключением");
  const before = git("log", "--oneline").trim().split("\n").length;
  const undone = plain(await call("gitUndoLastCommit", {}));
  ok(/последний коммит отменён/.test(undone), "коммит отменён мягко");
  ok(git("log", "--oneline").trim().split("\n").length === before - 1, "история стала короче ровно на один коммит");
  ok(git("status", "--porcelain").trim().length > 0, "изменения вернулись в рабочее дерево, а не потерялись");

  console.log("\n[7] gitPush: отказ без разрешения и настоящий push с ним");
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
  git("remote", "add", "origin", bare);
  git("add", "-A");
  git("-c", "user.name=Прогон", "-c", "user.email=run@local", "commit", "-m", "перед push");
  git("push", "-u", "origin", "main");
  const blocked = plain(await call("gitPush", {}));
  ok(/⛔ git push заблокирован/.test(blocked), "без разрешения push отклонён");
  fs.writeFileSync(path.join(work, "note.txt"), "новая версия для push\n");
  await call("gitCommit", { message: "правка для push" });
  const bareBefore = execFileSync("git", ["-C", bare, "log", "--oneline"], { encoding: "utf8" }).trim();
  ok(!/правка для push/.test(bareBefore), "пока запрещено — в удалённом репозитории ничего нового");
  writeSettings({ allowAgentPush: true });
  const pushed = plain(await callFresh("gitPush", {}));
  ok(!/Ошибка git:/.test(pushed), "с разрешением push прошёл: " + pushed.split("\n")[0].slice(0, 60));
  const bareAfter = execFileSync("git", ["-C", bare, "log", "--oneline"], { encoding: "utf8" }).trim();
  ok(/правка для push/.test(bareAfter), "коммит действительно ушёл в удалённый репозиторий");

  console.log("\n[8] gitClone: настоящий клон и живой мост");
  // Исходный репозиторий — отдельный, чтобы клон был честным.
  fs.mkdirSync(source, { recursive: true });
  const inSource = (args) => execFileSync("git", args, { cwd: source, encoding: "utf8" });
  inSource(["init", "-b", "main"]);
  fs.writeFileSync(path.join(source, "app.js"), "console.log(1);\n");
  inSource(["add", "-A"]);
  inSource(["-c", "user.name=Источник", "-c", "user.email=src@local", "commit", "-m", "исходный"]);
  const clone = plain(await call("gitClone", { url: source, directory: cloneDir }));
  ok(/репозиторий клонирован/.test(clone), "клон создан: " + clone.split("\n")[0].slice(0, 70));
  ok(fs.existsSync(path.join(cloneDir, "app.js")), "файлы исходного репозитория на месте");
  ok(fs.existsSync(path.join(cloneDir, ".git")), "клон — настоящий git-репозиторий");
  ok(live.lastAgentRepoDir === cloneDir, "живой мост запомнил папку клона: " + live.lastAgentRepoDir);
  ok(live.clonedRepoPending === true, "поднят флаг «последний ответ — после клона» (копией он бы застыл)");
  const statusInClone = plain(await call("gitStatus", {}));
  ok(!/fatal: not a git repository/.test(statusInClone), "gitStatus после клона работает в САМОМ клоне");
  live.lastAgentRepoDir = "";
  live.clonedRepoPending = false;
  const noUrl = plain(await call("gitClone", {}));
  ok(/укажи url/.test(noUrl), "клон без адреса объяснён");

  console.log("\n[9] gitPublish: отказ без разрешения и проверка адреса — без сети");
  writeSettings({ allowAgentPush: false });
  const pubBlocked = plain(await call("gitPublish", {}));
  ok(/⛔ gitPublish заблокирован/.test(pubBlocked), "без разрешения публикация отклонена");
  writeSettings({ allowAgentPush: true });
  const badUrl = plain(await callFresh("gitPublish", { remoteUrl: "ftp://чужой-хостинг/repo" }));
  ok(/должен быть git-адресом/.test(badUrl), "негодный адрес отклонён до любых запросов");

  clearTimeout(watchdog);
  console.log("\n" + (fail ? "❌ Провалено" : "✅ Все живые проверки git-инструментов пройдены") + ": " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("❌ Живой прогон упал: " + ((e && e.stack) || e));
  process.exit(1);
});

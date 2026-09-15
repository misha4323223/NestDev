"use strict";

/* ─── Деплой: мост между интерфейсом, агентом и конвейером ────────────────────
   Сам конвейер (порядок стадий, проверка после выката, откат) живёт в
   src/deploy-engine.js и остаётся чистым модулем. Здесь — обвязка вокруг него,
   которая раньше лежала в main.js вперемешку с почтой, памятью диалогов и
   работой с файлами: файл дорос до 7,7 тысяч строк, и найти в нём нужный
   обработчик можно было только поиском.

   Что внутри:
   - runCapture()        — команда с НАСТОЯЩИМ кодом выхода (судить по словам в
                           выводе нельзя: «error» встречается и в удачных сборках),
                           при необходимости — ввод через stdin (токен уходит в
                           docker login именно так, а не в аргументах процесса);
   - deployEmitter()     — события стадий и итога для панели деплоя;
   - cloudDeployBrief()  — что приложение уже знает про облако проекта (.cloud/*);
   - deployBrowserAudit()— проверка выкаченной страницы настоящим браузером;
   - runCloudDeploy()    — общий запуск: кнопка, IPC и агентский инструмент идут сюда;
   - 5 каналов: yc:deploy, deploy:state, deploy:run, deploy:rollback, deploy:health.

   Две вещи читаются ЖИВЫМИ, а не копией на момент создания модуля: активный
   отправитель событий (getEmit) и окно (getWindow). Оба меняются по ходу работы
   приложения, поэтому переданы функциями. */

function registerDeployIpc(deps) {
  const {
    ipcMain,
    path,
    fs,
    execFile,
    browserTools,
    cloudState,
    deployRecipes,
    createDeployEngine,
    yandexCloud,
    ycCosts,
    audit,
    commandEnv,
    loadSettings,
    agentWorkDir,
    stripAnsi,
    resolveShell,
    findProgram,
    ycConfig,
    ycRequireAuth,
    getEmit,
    getWindow,
  } = deps;

// ───────────────────── Деплой: рецепты, состояние, конвейер ─────────────────────
// Порядок стадий, проверка после выката и откат живут в src/deploy-engine.js.
// Здесь — только мост: терминал с кодом выхода, YC API и события для интерфейса.

// Запуск команды с настоящим кодом выхода и, при необходимости, через stdin.
// Деплою нельзя судить по словам в выводе: «error» встречается и в удачных сборках.
function runCapture(command, cwd, timeoutMs, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const finish = (code, out) => resolve({ code, out: String(out || "").trim() });
    const sh = resolveShell(command, o.shellName);
    let child = null;
    try {
      child = execFile(sh.shell, sh.args, {
        cwd,
        timeout: timeoutMs || 120000,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: commandEnv(command),
      }, (err, stdout, stderr) => {
        const out = stripAnsi(String(stdout || "")) + (stderr ? "\n" + stripAnsi(String(stderr)) : "");
        if (!err) return finish(0, out);
        const code = err.killed ? 124 : Number.isFinite(err.code) ? err.code : 1;
        finish(code, out + "\n" + String(err.message || ""));
      });
    } catch (e) {
      return finish(1, (e && e.message) || String(e));
    }
    if (o.input != null && child && child.stdin) {
      try {
        child.stdin.write(String(o.input) + "\n");
        child.stdin.end();
      } catch {}
    }
  });
}

// События деплоя: yc_step — как раньше (панель деплоя), deploy_* — для истории.
function deployEmitter() {
  const send = (ev) => {
    // Отправитель и окно читаются в момент события: и то и другое меняется по
    // ходу работы приложения, и копия значения «застыла» бы на null.
    const emitNow = getEmit ? getEmit() : null;
    if (emitNow) return emitNow(ev);
    const win = getWindow ? getWindow() : null;
    try {
      if (win && !win.isDestroyed()) win.webContents.send("ai:event", ev);
    } catch {}
  };
  return (ev) => {
    if (ev.type === "stage") {
      const mark = ev.status === "fail" ? "✗ " : ev.status === "ok" ? "✓ " : "⏳ ";
      send({ type: "yc_step", text: mark + ev.label + (ev.detail ? " — " + ev.detail : "") });
      send({ type: "deploy_stage", stage: { id: ev.id, label: ev.label, status: ev.status, detail: ev.detail || "", ms: ev.ms || 0 } });
    } else if (ev.type === "done") {
      send({
        type: "deploy_done",
        ok: !!ev.ok,
        url: ev.url || "",
        number: ev.number || 0,
        error: ev.error || "",
        rolledBack: !!ev.rolledBack,
        rolledBackTo: ev.rolledBackTo || 0,
      });
    }
  };
}

// Что приложение уже знает про облако этого проекта (из .cloud/*.json).
function cloudDeployBrief(dir) {
  try {
    const st = cloudState.readState(dir);
    if (!st.deployments.length) return "";
    const cur = st.current || {};
    const out = ["", "", "Облако этого проекта (состояние .cloud):"];
    out.push("• последний деплой: #" + cur.number + " — " + (cur.status === "ok" ? "работает" : cur.status) + (cur.url ? ", " + cur.url : ""));
    if (st.lastHealthy && st.lastHealthy.id !== cur.id) {
      out.push("• прошлая рабочая версия: #" + st.lastHealthy.number + (st.lastHealthy.revisionId ? " (ревизия " + st.lastHealthy.revisionId + ")" : ""));
    }
    const inf = st.infrastructure || {};
    if (inf.container) out.push("• контейнер: " + inf.container.id + (inf.registry ? ", реестр " + inf.registry.id : ""));
    if (cur.error) out.push("• ошибка последнего деплоя: " + String(cur.error).split("\n")[0].slice(0, 160));
    out.push("• история и откат доступны без yc CLI: задеплоить — ycDeploy, откатить ревизию — ycContainer(action: \"rollback\").");
    return out.join("\n");
  } catch {
    return "";
  }
}

// Проверка выкаченной страницы настоящим браузером. Движок просит — модуль
// браузера открывает адрес, слушает консоль и снимает скриншот. Ошибка здесь не
// должна ломать деплой: вернём причину, а решение примет src/deploy-check.js.
async function deployBrowserAudit(url, opts) {
  try {
    return await browserTools.auditPage(url, opts || {});
  } catch (e) {
    return { ok: false, error: "браузерная проверка не запустилась: " + ((e && e.message) || String(e)) };
  }
}

// Общий запуск деплоя: кнопка, IPC и агентский инструмент идут сюда.
async function runCloudDeploy(dir, appName, opts) {
  const o = opts || {};
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message, stages: [] };
  }
  if (!cfg.folderId) {
    return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог.", stages: [] };
  }
  const workDir = String(dir || "").trim() || agentWorkDir(loadSettings());
  if (!workDir || !fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    return { ok: false, error: "Папка проекта не найдена: " + workDir, stages: [] };
  }
  const name = String(appName || "").trim() || path.basename(workDir);
  const engine = createDeployEngine({ run: runCapture, yandex: yandexCloud, findProgram, emit: deployEmitter(), browserAudit: deployBrowserAudit });
  const res = await engine.deploy(workDir, {
    cloud: cfg,
    name,
    env: o.env || {},
    public: o.public,
    memoryMb: o.memoryMb,
    cores: o.cores,
    timeoutSec: o.timeoutSec,
    runTests: o.runTests,
    skipChecks: o.skipChecks,
    skipBuild: o.skipBuild,
    autoRollback: o.autoRollback,
    healthTries: o.healthTries,
    healthDelayMs: o.healthDelayMs,
    triggeredBy: o.triggeredBy || "user",
  });
  try {
    audit.record({
      tool: "ycDeploy",
      args: { dir: workDir, name, image: res.image || "" },
      decision: o.triggeredBy === "agent" ? "confirmed" : "auto",
      result: res.ok ? "ok" : "fail",
      source: o.triggeredBy || "user",
    });
  } catch {}
  const steps = (res.stages || []).map(
    (s) => (s.status === "fail" ? "✗ " : s.status === "ok" ? "✓ " : "⏳ ") + s.label + (s.detail ? " — " + s.detail : "")
  );
  return {
    ok: res.ok,
    status: res.status,
    error: res.error,
    url: res.url,
    image: res.image,
    revisionId: res.revisionId,
    containerId: res.containerId,
    deploymentId: res.deploymentId,
    number: res.number,
    name: yandexCloud.slugify(name) || name,
    health: res.health,
    browserCheck: res.browserCheck || null,
    browserShot: res.browserShot || "",
    warnings: res.warnings || [],
    rolledBack: !!res.rolledBack,
    rolledBackTo: res.rolledBackTo || 0,
    steps,
    stages: res.stages || [],
  };
}

// Кнопка «🚀 Задеплоить» — тот же контракт, что и раньше: { ok, url, steps, ... }.
ipcMain.handle("yc:deploy", async (_e, folderDir, appName, opts) => runCloudDeploy(folderDir, appName, opts));

// Состояние облака проекта: .cloud/project.json, infrastructure.json, deployments.json.
ipcMain.handle("deploy:state", (_e, dir) => {
  const workDir = String(dir || "").trim() || agentWorkDir(loadSettings());
  try {
    // Рецепт считаем на месте: панель сразу показывает, что за проект и как его собирать.
    let recipe = null;
    try {
      const r = deployRecipes.detectProject(workDir);
      recipe = { kind: r.kind, label: r.label, port: r.port, healthPaths: r.healthPaths, warnings: r.warnings, hasDockerfile: r.hasDockerfile };
    } catch {}
    // Ориентир стоимости выката — по параметрам ревизии по умолчанию, чтобы панель
    // показывала цену ДО запуска, а не после счёта.
    let cost = null;
    try {
      cost = ycCosts.estimateContainerConfig({});
    } catch {}
    return Object.assign({ ok: true, recipe, cost, dir: workDir }, cloudState.readState(workDir));
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), deployments: [], infrastructure: {}, project: {}, dir: workDir };
  }
});

ipcMain.handle("deploy:run", async (_e, dir, opts) =>
  runCloudDeploy(dir, (opts && opts.name) || "", Object.assign({}, opts || {}, { triggeredBy: "user" }))
);

// Откат вручную: на прошлую рабочую ревизию, с проверкой после отката.
ipcMain.handle("deploy:rollback", async (_e, dir, opts) => {
  const o = opts || {};
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const workDir = String(dir || "").trim() || agentWorkDir(loadSettings());
  const engine = createDeployEngine({ run: runCapture, yandex: yandexCloud, findProgram, emit: deployEmitter(), browserAudit: deployBrowserAudit });
  const res = await engine.rollback(workDir, { cloud: cfg, healthTries: o.healthTries, healthDelayMs: o.healthDelayMs });
  try {
    audit.record({ tool: "ycContainer", args: { dir: workDir, action: "rollback" }, decision: "auto", result: res.ok ? "ok" : "fail" });
  } catch {}
  return res;
});

// Разовая проверка адреса (кнопка «Проверить» в панели деплоя).
ipcMain.handle("deploy:health", async (_e, url, paths) => {
  const engine = createDeployEngine({ run: runCapture, yandex: yandexCloud, findProgram });
  return engine.healthCheck(String(url || ""), {
    paths: paths && paths.length ? paths : ["/", "/health"],
    tries: 3,
    delayMs: 2000,
    timeoutMs: 12000,
  });
});

  // Возвращаем то, что нужно main.js: агентский инструмент ycDeploy и сводка
  // состояния облака для системного промпта.
  return { runCapture, deployEmitter, cloudDeployBrief, deployBrowserAudit, runCloudDeploy };
}

module.exports = { registerDeployIpc };

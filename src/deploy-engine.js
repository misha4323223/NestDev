"use strict";
// Движок деплоя: детерминированный конвейер вместо «пусть модель придумает порядок».
//
//   check → detect → verify → package → registry → login → build → push
//   → container → revision → health → record
//
// Особенности, которых не было, когда деплой жил одной функцией в main.js:
//   • у каждой стадии есть запись в истории (.cloud/deployments.json) — если
//     приложение закрыли посреди деплоя, видно, на чём остановились;
//   • образ получает тег с номером деплоя, а не только :latest — иначе откат
//     на предыдущую ревизию указывал бы на тот же образ;
//   • после деплоя идёт настоящая проверка URL, а не «раз ревизия создана —
//     значит успех»;
//   • при провале проверки движок сам откатывается на последнюю живую ревизию.
//
// Зависимости внедряются (run, yandex, fetch) — поэтому движок проверяется
// живьём на подменённых Docker и API, без реального облака.

const fs = require("fs");
const path = require("path");
const recipes = require("./deploy-recipes.js");
const deployCheck = require("./deploy-check.js");
const state = require("./cloud-state.js");

const STAGE_LABELS = {
  check: "Проверка окружения",
  detect: "Определение проекта",
  verify: "Проверки проекта",
  package: "Dockerfile и .dockerignore",
  registry: "Реестр образов",
  login: "Вход в cr.yandex",
  build: "Сборка образа",
  push: "Загрузка образа",
  container: "Контейнер и доступ",
  revision: "Деплой ревизии",
  health: "Проверка после деплоя",
  browse: "Проверка в браузере",
  record: "История и состояние",
  rollback: "Откат на прошлую рабочую версию",
  "health-after-rollback": "Проверка после отката",
};

const STAGE_ORDER = [
  "check",
  "detect",
  "verify",
  "package",
  "registry",
  "login",
  "build",
  "push",
  "container",
  "revision",
  "health",
  "browse",
  "record",
];

// Параметры ревизии по умолчанию. Меняешь здесь — меняется и деплой, и оценка
// стоимости в src/yc-costs.js (она берёт значения отсюда, а не из копии).
const REVISION_DEFAULTS = { memoryMb: 256, cores: 1, timeoutSec: 30 };

const TIMEOUTS = {
  install: 600000,
  build: 900000,
  test: 600000,
  dockerBuild: 900000,
  dockerPush: 900000,
  login: 90000,
};

// ─────────────────────────────── помощники ───────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Тестовый хук: живой тест укорачивает ожидание проверки, чтобы не ждать
// холодный старт по-настоящему. В обычной жизни переменные не заданы.
function envInt(name, fallback) {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function tail(text, limit) {
  const s = String(text || "");
  const n = limit || 3000;
  return s.length > n ? "…" + s.slice(-n) : s;
}

// Приводит ответ запуска команды к {code, out}. Поддерживает и текст, и объект.
function normalizeRun(res) {
  if (res && typeof res === "object" && (res.code !== undefined || res.out !== undefined)) {
    return { code: res.code == null ? 0 : Number(res.code), out: String(res.out == null ? "" : res.out) };
  }
  const text = String(res == null ? "" : res);
  const m = text.match(/Команда завершилась с кодом (таймаут|\d+)/);
  if (m) return { code: m[1] === "таймаут" ? 124 : parseInt(m[1], 10), out: text };
  return { code: 0, out: text };
}

function defaultFetch(url, opts) {
  if (typeof fetch === "function") return fetch(url, opts);
  throw new Error("fetch недоступен в этой среде");
}

// ─────────────────────────────── движок ───────────────────────────────

function createDeployEngine(deps) {
  const d = deps || {};
  const yandex = d.yandex;
  const run = d.run; // (command, cwd, timeoutMs, opts) -> {code, out} | string
  const emit = d.emit || (() => {});
  const fetchImpl = d.fetch || defaultFetch;
  const findProgram = d.findProgram || (() => ({ found: true }));
  // Проверка страницы настоящим браузером. Без неё стадия честно пропускается:
  // движок должен работать и там, где браузера нет (например, в структурных тестах).
  const browserAudit = typeof d.browserAudit === "function" ? d.browserAudit : null;
  const log = d.log || (() => {});

  if (typeof run !== "function") throw new Error("deploy-engine: нужен run(command, cwd, timeoutMs)");
  if (!yandex) throw new Error("deploy-engine: нужен модуль yandex-cloud");

  async function cmd(command, cwd, timeoutMs, opts) {
    const res = await run(command, cwd, timeoutMs, opts || {});
    return normalizeRun(res);
  }

  // ── проверка после деплоя ──
  // Пробуем несколько путей с повторами: у Serverless Containers холодный старт.
  async function healthCheck(url, opts) {
    const o = opts || {};
    const paths = o.paths && o.paths.length ? o.paths : ["/", "/health"];
    const tries = o.tries || 8;
    const delayMs = o.delayMs == null ? 5000 : o.delayMs;
    const started = Date.now();
    let last = { ok: false, status: 0, reason: "нет ответа" };
    if (!url) return { ok: false, status: 0, reason: "у контейнера нет URL — публичный доступ не настроен", ms: 0 };
    for (let attempt = 1; attempt <= tries; attempt++) {
      for (const p of paths) {
        const target = url.replace(/\/+$/, "") + p;
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), (o.timeoutMs || 15000));
          const r = await fetchImpl(target, { method: "GET", redirect: "follow", signal: ctl.signal });
          clearTimeout(timer);
          const status = r && r.status ? r.status : 0;
          if (status >= 200 && status < 400) {
            return { ok: true, status, path: p, url: target, attempt, ms: Date.now() - started };
          }
          if (status === 401 || status === 403) {
            last = {
              ok: false,
              status,
              path: p,
              url: target,
              reason: "контейнер отвечает " + status + " — публичный доступ не настроен (деплой без public или не хватило прав на роль invoker)",
              ms: Date.now() - started,
            };
          } else {
            last = { ok: false, status, path: p, url: target, reason: "контейнер отвечает " + status, ms: Date.now() - started };
          }
        } catch (e) {
          last = { ok: false, status: 0, path: p, url: target, reason: "запрос не прошёл: " + ((e && e.message) || String(e)), ms: Date.now() - started };
        }
      }
      if (attempt < tries) await sleep(delayMs);
    }
    return last;
  }

  // Id последней живой ревизии контейнера. Операция деплоя возвращает id
  // операции, а откат требует id ревизии: без этого «откат» уходит в никуда.
  async function latestRevisionId(oauth, containerId) {
    if (typeof yandex.listRevisions !== "function") return "";
    const list = (await yandex.listRevisions(oauth, { containerId })) || [];
    const items = list.slice().sort((a, b) => String((b && b.createdAt) || "").localeCompare(String((a && a.createdAt) || "")));
    const top = items.find((r) => r && r.id && String(r.status || "").toUpperCase() !== "OBSOLETE");
    return (top && top.id) || "";
  }

  // Скриншот выкаченной страницы рядом с состоянием. Старые чистим: это
  // диагностика последних выкатов, а не архив.
  const SHOTS_KEEP = 20;
  function saveScreenshot(projectDir, number, buf) {
    if (!buf || !buf.length) return "";
    try {
      const dir = path.join(projectDir, ".cloud", "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "d" + number + ".png");
      fs.writeFileSync(file, buf);
      const old = fs
        .readdirSync(dir)
        .filter((f) => /\.png$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(SHOTS_KEEP);
      for (const o of old) {
        try {
          fs.unlinkSync(path.join(dir, o.f));
        } catch {}
      }
      return file;
    } catch {
      return "";
    }
  }

  // ── сам деплой ──
  async function deploy(projectDir, opts) {
    const o = opts || {};
    const cfg = o.cloud || {};
    const oauth = cfg.oauth;
    const folderId = cfg.folderId;
    const dir = path.resolve(String(projectDir || ""));
    const appName = String(o.name || path.basename(dir)).trim();
    const stages = [];
    const warnings = [];
    const writeState = o.saveState !== false;

    if (!oauth) return { ok: false, error: "Yandex Cloud не подключён — Настройки → «☁️ Yandex Cloud».", stages };
    if (!folderId) return { ok: false, error: "Не выбран каталог (folder) — Настройки → «☁️ Yandex Cloud».", stages };
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return { ok: false, error: "Папка проекта не найдена: " + dir, stages };
    }

    let rec = null;
    if (writeState) {
      rec = state.recordDeployment(dir, {
        app: appName,
        environment: o.environment || "production",
        envKeys: Object.keys(o.env || {}),
        triggeredBy: o.triggeredBy || "user",
        folderId,
        stages: [],
      });
      if (o.commit) state.updateDeployment(dir, rec.id, { commit: o.commit });
    }

    let dockerfile = "";
    let recipe = null;
    let image = "";
    let containerId = "";
    let revisionId = "";
    let url = "";
    let health = null;
    let browserCheck = null;
    let rollbackCheck = null;
    let screenshotPath = "";
    let fatal = "";

    // Каждая стадия: отметка в истории до работы, затем результат.
    const stage = async (id, fn) => {
      const started = Date.now();
      const entry = { id, label: STAGE_LABELS[id] || id, status: "run", ms: 0 };
      stages.push(entry);
      emit({ type: "stage", id, label: entry.label, status: "run" });
      if (writeState && rec) state.updateDeployment(dir, rec.id, { stages: stages.map((s) => Object.assign({}, s)), stage: id });
      try {
        const detail = await fn();
        entry.status = "ok";
        entry.ms = Date.now() - started;
        if (detail) entry.detail = String(detail).slice(0, 400);
        emit({ type: "stage", id, label: entry.label, status: "ok", detail: entry.detail || "", ms: entry.ms });
        if (writeState && rec) state.updateDeployment(dir, rec.id, { stages: stages.map((s) => Object.assign({}, s)), stage: id });
        return { ok: true, detail: detail || "" };
      } catch (e) {
        const msg = (e && e.message) || String(e);
        entry.status = "fail";
        entry.ms = Date.now() - started;
        entry.detail = msg.slice(0, 1200);
        emit({ type: "stage", id, label: entry.label, status: "fail", detail: entry.detail, ms: entry.ms });
        if (writeState && rec) state.updateDeployment(dir, rec.id, { stages: stages.map((s) => Object.assign({}, s)), stage: id });
        return { ok: false, error: msg };
      }
    };

    try {
      // 1. Окружение: каталог проекта, docker, домен реестра
      const env = await stage("check", async () => {
        const docker = findProgram("docker");
        if (!docker || !docker.found) {
          throw new Error("Docker не найден. Установи Docker Desktop (https://www.docker.com/products/docker-desktop/) и перезапусти приложение.");
        }
        const v = await cmd("docker --version", dir, 30000);
        if (v.code !== 0) throw new Error("Docker установлен, но не отвечает: " + tail(v.out, 300) + "\nПроверь, что Docker Desktop запущен.");
        return String(v.out).trim().split("\n")[0];
      });
      if (!env.ok) fatal = env.error;

      // 2. Тип проекта
      if (!fatal) {
        const det = await stage("detect", async () => {
          recipe = recipes.detectProject(dir);
          for (const w of recipe.warnings || []) warnings.push(w);
          const bits = [recipe.label + " (" + recipe.kind + ")", "порт " + recipe.port];
          if (recipe.packageManager) bits.push(recipe.packageManager);
          if (recipe.warnings && recipe.warnings.length) bits.push("есть замечания — см. предупреждения");
          return bits.join(" · ");
        });
        // Замечания рецепта деплой не отменяют: пользователь должен увидеть результат.
        if (!det.ok) warnings.push(det.error);
      }

      // 3. Локальные проверки: зависимости, сборка, тесты
      if (!fatal && o.skipChecks !== true && recipe) {
        const ver = await stage("verify", async () => {
          const done = [];
          const hasNodeModules = fs.existsSync(path.join(dir, "node_modules"));
          if (recipe.installCmd && !hasNodeModules) {
            const r = await cmd(recipe.installCmd, dir, TIMEOUTS.install);
            if (r.code !== 0) throw new Error("Установка зависимостей не прошла:\n" + tail(r.out, 2500));
            done.push("зависимости");
          } else if (recipe.installCmd) {
            done.push("зависимости уже стоят");
          }
          if (recipe.buildCmd && o.skipBuild !== true) {
            const r = await cmd(recipe.buildCmd, dir, TIMEOUTS.build);
            if (r.code !== 0) throw new Error("Сборка проекта не прошла — в образ попало бы заведомо сломанное состояние:\n" + tail(r.out, 2500));
            done.push("сборка");
          }
          if (recipe.testCmd && o.runTests !== false) {
            const r = await cmd(recipe.testCmd, dir, TIMEOUTS.test);
            // Тесты не блокируют деплой, но о падении докладываем честно.
            if (r.code !== 0) warnings.push("Тесты проекта упали (" + recipe.testCmd + ") — деплой продолжен, проверь:\n" + tail(r.out, 800));
            else done.push("тесты");
          }
          return done.join(", ") || "проверок не требовалось";
        });
        if (!ver.ok) fatal = ver.error;
      }

      // 4. Dockerfile и .dockerignore
      if (!fatal) {
        const pack = await stage("package", async () => {
          const ctx = recipes.prepareDockerContext(dir);
          recipe = ctx.recipe;
          dockerfile = ctx.dockerfile;
          if (recipe.hasEnvFile) {
            warnings.push("В проекте есть .env — в образ он не попадает. Переменные задай в деплое, иначе контейнер их не увидит.");
          }
          return path.basename(dockerfile) + (ctx.generated ? " (сгенерирован)" : " (свой)") + (ctx.ignoreWritten ? " + .dockerignore" : "");
        });
        if (!pack.ok) fatal = pack.error;
      }

      // 5. Реестр: имя с номером деплоя, чтобы откат указывал на свой образ
      const slug = yandex.slugify(appName) || "app";
      const number = (rec && rec.number) || 1;
      let registryId = "";
      if (!fatal) {
        const reg = await stage("registry", async () => {
          const r = await yandex.ensureRegistry(oauth, folderId, slug + "-registry");
          registryId = r.id;
          image = "cr.yandex/" + r.id + "/" + slug + ":d" + number;
          if (writeState && rec) state.updateDeployment(dir, rec.id, { image, registryId: r.id });
          if (writeState) state.writeInfrastructure(dir, { registry: { id: r.id, name: slug + "-registry" } });
          return "реестр " + r.id + ", образ " + image;
        });
        if (!reg.ok) fatal = reg.error;
      }

      // 6. Вход в реестр: IAM-токен через stdin, чтобы он не попал ни в argv, ни в журнал
      if (!fatal) {
        const login = await stage("login", async () => {
          const iamTok = await yandex.getIamToken(oauth);
          const r = await cmd("docker login cr.yandex -u iam --password-stdin", dir, TIMEOUTS.login, { input: iamTok });
          if (r.code !== 0) throw new Error("docker login к cr.yandex не прошёл:\n" + tail(r.out, 800));
          return "вход выполнен";
        });
        if (!login.ok) fatal = login.error;
      }

      // 7. Сборка образа
      if (!fatal) {
        const build = await stage("build", async () => {
          const r = await cmd('docker build -f "' + dockerfile + '" -t ' + image + " .", dir, TIMEOUTS.dockerBuild);
          if (r.code !== 0) throw new Error("docker build упал:\n" + tail(r.out, 3000));
          return "образ " + image;
        });
        if (!build.ok) fatal = build.error;
      }

      // 8. Загрузка образа
      if (!fatal) {
        const push = await stage("push", async () => {
          const r = await cmd("docker push " + image, dir, TIMEOUTS.dockerPush);
          if (r.code !== 0) throw new Error("docker push упал:\n" + tail(r.out, 2000));
          const digest = (String(r.out).match(/digest:\s*sha256:[a-f0-9]+/i) || [])[0] || "";
          return digest || "образ загружен";
        });
        if (!push.ok) fatal = push.error;
      }

      // 9. Контейнер и публичный доступ
      let serviceAccountId = "";
      if (!fatal) {
        const cont = await stage("container", async () => {
          const c = await yandex.ensureContainer(oauth, folderId, slug);
          containerId = c.id;
          const done = ["контейнер " + c.id];
          if (o.public !== false) {
            const sa = await yandex.ensureServiceAccount(oauth, folderId, "sa-" + slug);
            serviceAccountId = sa.id;
            await yandex.addRoleOnFolder(oauth, folderId, sa.id, "serverless.containers.invoker");
            done.push("публичный доступ (SA " + sa.id + " + роль invoker)");
          }
          if (writeState) {
            state.writeInfrastructure(dir, {
              container: { id: c.id, name: slug },
              serviceAccount: serviceAccountId ? { id: serviceAccountId, name: "sa-" + slug } : null,
              envKeys: Object.keys(o.env || {}),
            });
          }
          return done.join(", ");
        });
        if (!cont.ok) {
          fatal =
            cont.error +
            (o.public !== false
              ? " Проверь, что у аккаунта есть роль editor на каталог, или задеплой без публичного доступа."
              : "");
        }
      }

      // 10. Ревизия
      if (!fatal) {
        const rev = await stage("revision", async () => {
          const r = await yandex.deployContainerRevision(oauth, {
            containerId,
            folderId,
            imageUrl: image,
            serviceAccountId: serviceAccountId || undefined,
            memoryMb: o.memoryMb || REVISION_DEFAULTS.memoryMb,
            cores: o.cores || REVISION_DEFAULTS.cores,
            timeoutSec: o.timeoutSec || REVISION_DEFAULTS.timeoutSec,
            env: o.env || {},
          });
          revisionId = (r && r.revisionId) || (await latestRevisionId(oauth, containerId)) || (r && r.id) || "";
          const info = await yandex.containerInfo(oauth, containerId);
          url = (info && info.url) || "";
          if (writeState && rec) state.updateDeployment(dir, rec.id, { revisionId, containerId, url });
          return "ревизия " + (revisionId || "создана") + (url ? ", " + url : "");
        });
        if (!rev.ok) fatal = rev.error;
      }

      // 11. Проверка после деплоя: ревизия создана не значит «работает»
      if (!fatal) {
        const h = await stage("health", async () => {
          health = await healthCheck(url, {
            paths: (recipe && recipe.healthPaths) || ["/"],
            tries: o.healthTries || envInt("AI_AGENT_DEPLOY_HEALTH_TRIES", 8),
            delayMs: o.healthDelayMs == null ? envInt("AI_AGENT_DEPLOY_HEALTH_MS", 5000) : o.healthDelayMs,
            timeoutMs: o.healthTimeoutMs || 15000,
          });
          if (writeState && rec) state.updateDeployment(dir, rec.id, { health });
          if (!health.ok) throw new Error("Приложение не отвечает: " + (health.reason || "нет ответа") + (health.url ? " (" + health.url + ")" : ""));
          return "HTTP " + health.status + " по " + health.path + " за " + (health.ms / 1000).toFixed(1) + " с";
        });
        if (!h.ok) fatal = h.error;
      }

      // 12. Проверка страницы браузером: HTTP 200 ещё не значит, что всё нарисовалось
      if (!fatal) {
        if (!browserAudit) {
          warnings.push("Проверка страницы браузером пропущена: браузер недоступен — посмотри адрес глазами.");
        } else {
          const b = await stage("browse", async () => {
            const audit = await browserAudit(url, { settleMs: o.browserSettleMs });
            // Не поднялся сам браузер — это ограничение проверки, а не поломка
            // выката: откатывать работающий сайт из-за этого нельзя.
            if (!audit || !audit.ok) {
              warnings.push("браузер: проверка страницы не состоялась — " + ((audit && audit.error) || "нет данных"));
              return "пропущено: " + ((audit && audit.error) || "браузер недоступен");
            }
            browserCheck = deployCheck.evaluate(audit);
            if (audit && audit.screenshot) screenshotPath = saveScreenshot(dir, number, audit.screenshot);
            for (const w of browserCheck.warnings) warnings.push("браузер: " + w);
            if (writeState && rec) {
              state.updateDeployment(dir, rec.id, { browserCheck, browserShot: screenshotPath });
            }
            if (!browserCheck.ok) throw new Error("Страница выкатилась, но не работает: " + browserCheck.reason);
            return deployCheck.summarize(browserCheck);
          });
          if (!b.ok) fatal = b.error;
        }
      }

      // 13. История и состояние
      if (!fatal) {
        await stage("record", async () => {
          if (writeState) state.writeProject(dir, { folderId, folderName: cfg.folderName || "", cloudId: cfg.cloudId || "", name: appName });
          if (writeState && rec) {
            state.updateDeployment(dir, rec.id, {
              status: "ok",
              finishedAt: Date.now(),
              url,
              image,
              revisionId,
              containerId,
              warnings,
              health,
              browserCheck,
              browserShot: screenshotPath,
            });
          }
          return "деплой #" + number + " в истории";
        });
      }
    } catch (e) {
      fatal = fatal || "Деплой прерван: " + ((e && e.message) || String(e));
    }

    // ── Провал: сам откатываемся, если есть на что ──
    if (fatal) {
      let rolledBack = false;
      const target = writeState ? state.rollbackTarget(dir, rec && rec.id) : null;
      if (o.autoRollback !== false && target && containerId) {
        const rb = await stage("rollback", async () => {
          await yandex.rollbackContainer(oauth, containerId, target.revisionId);
          const info = await yandex.containerInfo(oauth, containerId);
          url = (info && info.url) || url;
          return "вернул ревизию " + target.revisionId + " (деплой #" + target.number + ")";
        });
        if (rb.ok) {
          const h2 = await stage("health-after-rollback", async () => {
            const check = await healthCheck(url, {
              paths: (recipe && recipe.healthPaths) || ["/"],
              tries: o.healthTries || envInt("AI_AGENT_DEPLOY_HEALTH_TRIES", 6),
              delayMs: o.healthDelayMs == null ? envInt("AI_AGENT_DEPLOY_HEALTH_MS", 5000) : o.healthDelayMs,
            });
            if (!check.ok) throw new Error("после отката приложение тоже не отвечает: " + (check.reason || "нет ответа"));
            return "HTTP " + check.status + " — прошлая версия снова работает";
          });
          rolledBack = h2.ok;
          // После отката смотрим страницу ещё раз. Провал этой проверки откат не
          // отменяет (он уже сделан и проверен по HTTP), но результат должен быть
          // виден и в истории, и пользователю.
          if (rolledBack && browserAudit) {
            try {
              const audit = await browserAudit(url, { settleMs: o.browserSettleMs });
              rollbackCheck = deployCheck.evaluate(audit);
            } catch {}
          }
          if (rolledBack && writeState && rec) {
            state.updateDeployment(dir, rec.id, { rolledBackTo: target.number, url, browserCheckAfterRollback: rollbackCheck });
          }
        } else {
          warnings.push("Откат не удался: " + rb.error);
        }
      }
      if (writeState && rec) {
        state.updateDeployment(dir, rec.id, {
          status: rolledBack ? "rolled-back" : "failed",
          finishedAt: Date.now(),
          error: fatal,
          warnings,
          url,
          image,
          revisionId,
          containerId,
          health,
          browserCheck,
          browserCheckAfterRollback: rollbackCheck,
          browserShot: screenshotPath,
        });
      }
      emit({ type: "done", ok: false, error: fatal, rolledBack });
      return {
        ok: false,
        status: rolledBack ? "rolled-back" : "failed",
        error: fatal,
        rolledBack,
        rolledBackTo: rolledBack && target ? target.number : 0,
        url,
        image,
        revisionId,
        health,
        browserCheck,
        browserCheckAfterRollback: rollbackCheck,
        browserShot: screenshotPath,
        deploymentId: rec && rec.id,
        number: rec && rec.number,
        stages,
        warnings,
      };
    }

    emit({ type: "done", ok: true, url, number: rec && rec.number });
    return {
      ok: true,
      status: "ok",
      url,
      image,
      revisionId,
      containerId,
      deploymentId: rec && rec.id,
      number: rec && rec.number,
      health,
      browserCheck,
      browserShot: screenshotPath,
      stages,
      warnings,
      recipe: recipe ? { kind: recipe.kind, label: recipe.label, port: recipe.port } : null,
    };
  }

  // Откат по требованию: на прошлую живую версию, с проверкой.
  async function rollback(projectDir, opts) {
    const o = opts || {};
    const cfg = o.cloud || {};
    const dir = path.resolve(String(projectDir || ""));
    const stages = [];
    const emitStage = (s) => {
      stages.push(s);
      emit({ type: "stage", id: s.id, label: STAGE_LABELS[s.id] || s.id, status: s.status, detail: s.detail || "" });
    };
    if (!cfg.oauth) return { ok: false, error: "Yandex Cloud не подключён." };
    const st = state.readState(dir);
    const containerId = (st.infrastructure.container && st.infrastructure.container.id) || o.containerId || "";
    if (!containerId) return { ok: false, error: "Не знаю контейнер этого проекта — сначала задеплой (.cloud/infrastructure.json пуст)." };
    const target = o.toRevision
      ? { revisionId: o.toRevision, number: o.toNumber || 0 }
      : state.rollbackTarget(dir, o.fromId || (st.current && st.current.id));
    if (!target || !target.revisionId) return { ok: false, error: "Нет прошлой успешной ревизии для отката в истории деплоев." };

    const rec = state.recordDeployment(dir, {
      app: st.project.name,
      status: "running",
      kind: "rollback",
      rolledBackTo: target.number,
      envKeys: [],
      triggeredBy: o.triggeredBy || "user",
      stages: [],
    });
    try {
      let url = "";
      emitStage({ id: "rollback", status: "run" });
      await yandex.rollbackContainer(cfg.oauth, containerId, target.revisionId);
      const info = await yandex.containerInfo(cfg.oauth, containerId);
      url = (info && info.url) || "";
      emitStage({ id: "rollback", status: "ok", detail: "ревизия " + target.revisionId + (target.number ? " (деплой #" + target.number + ")" : "") });
      let health = null;
      emitStage({ id: "health-after-rollback", status: "run" });
      health = await healthCheck(url, {
        paths: o.healthPaths || ["/"],
        tries: o.healthTries || envInt("AI_AGENT_DEPLOY_HEALTH_TRIES", 6),
        delayMs: o.healthDelayMs == null ? envInt("AI_AGENT_DEPLOY_HEALTH_MS", 5000) : o.healthDelayMs,
      });
      if (!health.ok) {
        emitStage({ id: "health-after-rollback", status: "fail", detail: health.reason });
        state.updateDeployment(dir, rec.id, { status: "failed", finishedAt: Date.now(), error: "после отката: " + health.reason, revisionId: target.revisionId, url, health });
        return { ok: false, error: "Откат выполнен, но приложение не отвечает: " + health.reason, url, revisionId: target.revisionId, stages };
      }
      emitStage({ id: "health-after-rollback", status: "ok", detail: "HTTP " + health.status + " — прошлая версия работает" });
      // После отката полезно убедиться, что страница действительно отрисовалась,
      // но провал этой проверки не должен отменять сам факт успешного отката.
      let check = null;
      if (browserAudit) {
        try {
          const audit = await browserAudit(url, { settleMs: o.browserSettleMs });
          check = deployCheck.evaluate(audit);
        } catch {}
      }
      state.updateDeployment(dir, rec.id, { status: "ok", finishedAt: Date.now(), revisionId: target.revisionId, url, health, browserCheck: check });
      return { ok: true, url, revisionId: target.revisionId, rolledBackTo: target.number, browserCheck: check, stages };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      emitStage({ id: "rollback", status: "fail", detail: msg });
      state.updateDeployment(dir, rec.id, { status: "failed", finishedAt: Date.now(), error: msg });
      return { ok: false, error: "Откат не прошёл: " + msg, stages };
    }
  }

  return { deploy, rollback, healthCheck, STAGE_ORDER, STAGE_LABELS, _normalizeRun: normalizeRun };
}

module.exports = { createDeployEngine, STAGE_ORDER, STAGE_LABELS, REVISION_DEFAULTS };

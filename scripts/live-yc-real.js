"use strict";
/* E2E ПРОТИВ НАСТОЯЩЕГО Yandex Cloud (а не против подмены).
   Запуск: bun run test:live:yc:real   — нужны YC_OAUTH_TOKEN и согласие на траты.

   Зачем отдельный скрипт. Подменённое облако в scripts/live-deploy.js проверяет
   ЛОГИКУ движка (порядок стадий, откаты, разбор ответов). Оно не проверяет
   РЕАЛЬНОСТЬ: настоящий API ломается на том, чего подмена не повторяет — права
   IAM, статус операции, схема ответа, формат параметра ревизии. Поэтому здесь всё
   по-настоящему и по цепочке из плана «от запроса до прода»:

     контейнер → настоящая ревизия → настоящий URL → HTTP-здоровье
     → браузер → вторая ревизия → откат → здоровье снова → удаление ресурсов

   Ресурсы создаются в ТВОЁМ каталоге и удаляются в конце прогона. Всё, что
   создаётся, начинается с e2e-<метка времени> — это видно глазами и легко
   удалить руками, если уборка не пройдёт (неудалённое печатается в конце).

   Безопасность:
     • без YC_OAUTH_TOKEN прогон не начинается вовсе;
     • без AI_AGENT_YC_REAL=1 (или --yes) скрипт только показывает план и выходит:
       молча тратить деньги пользователя он не должен;
     • уборка идёт в finally — даже если прогон упал на середине;
     • значения секретов не попадают ни в отчёт, ни в вывод: только ключи и id.

   Переменные окружения:
     YC_OAUTH_TOKEN   — OAuth-токен Yandex (тот же, что у yc CLI) — обязателен
     YC_FOLDER_ID     — каталог; иначе берётся первый доступный
     AI_AGENT_YC_REAL — 1, чтобы разрешить реальные траты
     YC_REAL_KEEP     — 1, чтобы НЕ удалять ресурсы после прогона (для разбора)
     YC_REAL_NO_BROWSER — 1, чтобы не поднимать браузер на этом шаге
     YC_REAL_HEALTH_TRIES / YC_REAL_HEALTH_MS — терпение к холодному старту
*/

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log("  ✅ " + name + (extra ? " — " + extra : ""));
  } else {
    fail++;
    console.log("  ❌ " + name + (extra ? " — " + extra : ""));
  }
}

// ─────────────────────────── имена и метка прогона ───────────────────────────

// Метка времени делает ресурсы узнаваемыми: e2e-20260916-101530.
function stampNow(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

// Имена выводятся из одного slug — ровно так их называет движок деплоя
// (src/deploy-engine.js: реестр = slug + "-registry", секрет = "app-" + slug + "-env",
// сервисный аккаунт = "sa-" + slug). Расходиться с движком нельзя: иначе уборка
// будет искать не то имя и оставит ресурсы в каталоге пользователя.
function namesFor(appName) {
  const slug = String(appName || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
  return {
    slug,
    container: slug,
    registry: slug + "-registry",
    secret: "app-" + slug + "-env",
    serviceAccount: "sa-" + slug,
  };
}

// ───────────────────────────── права на запуск ─────────────────────────────

function wantsRealRun(argv, env) {
  const args = argv || [];
  const e = env || {};
  return String(e.AI_AGENT_YC_REAL || "") === "1" || args.includes("--yes") || args.includes("-y");
}

function keepResources(env) {
  return String((env || {}).YC_REAL_KEEP || "") === "1";
}

function planText(appName, folderId) {
  const n = namesFor(appName);
  return [
    "Что БУДЕТ создано в каталоге " + (folderId || "(первый доступный)") + ":",
    "  • контейнер         " + n.container,
    "  • реестр образов    " + n.registry + " (образ в нём — деньги за хранение)",
    "  • секрет Lockbox    " + n.secret + " (одна версия, значения тестовые)",
    "  • сервисный аккаунт " + n.serviceAccount + " (только если нужен секрет)",
    "  • ревизии контейнера — их считает тариф Serverless Containers",
    "",
    "Всё перечисленное скрипт удаляет в конце прогона (кроме случая YC_REAL_KEEP=1).",
    "Чтобы действительно запустить: YC_OAUTH_TOKEN=... AI_AGENT_YC_REAL=1 bun run test:live:yc:real",
  ].join("\n");
}

// ─────────────────────────── настоящие команды ───────────────────────────

// Тот же контракт, что у движка деплоя: run(command, cwd, timeoutMs, {input}).
// spawnSync с shell — потому что команды Docker приходят строкой, а пароль в
// docker login идёт через stdin (в argv ему нельзя).
function makeRun(spawn) {
  const sp = spawn || spawnSync;
  return function run(command, cwd, timeoutMs, opts) {
    const o = opts || {};
    const res = sp(command, {
      cwd: cwd || process.cwd(),
      shell: true,
      encoding: "utf8",
      timeout: timeoutMs || 600000,
      input: o.input == null ? undefined : String(o.input) + "\n",
      env: Object.assign({}, process.env, o.env || {}),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const out = String(res.stdout || "") + String(res.stderr || "");
    const code = res.error && res.status == null ? (res.error.code === "ETIMEDOUT" ? 124 : 1) : Number(res.status == null ? 0 : res.status);
    return { code, out };
  };
}

function makeFindProgram(spawn) {
  const sp = spawn || spawnSync;
  return function findProgram(name) {
    const win = process.platform === "win32";
    const r = sp(win ? "where" : "sh", win ? [name] : ["-c", "command -v " + name], { encoding: "utf8" });
    const first = String(r.stdout || "").trim().split("\n")[0] || "";
    return { found: r.status === 0, path: first };
  };
}

// Проверка страницы браузером — тем же кодом, что и в приложении
// (src/browser-tools.js: консоль, ошибки, скриншот). Нет браузера — не беда:
// движок на это отвечает замечанием, а не провалом выката.
function makeBrowserAudit(opts) {
  const o = opts || {};
  if (o.off) return null;
  return async (url, popts) => {
    let browserTools = null;
    try {
      browserTools = require(path.join(ROOT, "src", "browser-tools.js"));
    } catch (e) {
      return { ok: false, error: "модуль браузера недоступен: " + ((e && e.message) || String(e)) };
    }
    try {
      return await browserTools.auditPage(url, popts || {});
    } catch (e) {
      return { ok: false, error: "браузерная проверка не запустилась: " + ((e && e.message) || String(e)) };
    }
  };
}

// ─────────────────────────── независимая проверка URL ───────────────────────────

// Своя проверка адреса, а не результат движка: «ревизия создана» и «страница
// отвечает» — разные вещи, и подтверждать вторую данными первого нельзя.
async function httpCheck(url, marker, opts) {
  const o = opts || {};
  const f = o.fetch || fetch;
  const tries = Math.max(1, o.tries || 6);
  const delayMs = o.delayMs == null ? 4000 : o.delayMs;
  let last = { ok: false, status: 0, marker: false, ms: 0, error: "не проверялось" };
  for (let i = 0; i < tries; i++) {
    const started = Date.now();
    try {
      const r = await f(url, { redirect: "follow", headers: { "Cache-Control": "no-cache" } });
      const text = await r.text();
      last = {
        ok: r.status === 200,
        status: r.status,
        marker: marker ? text.includes(marker) : true,
        bytes: text.length,
        ms: Date.now() - started,
        error: "",
        text: text.slice(0, 300),
      };
      // Маркер обязателен: у одной и той же ревизии адрес не меняется, поэтому
      // «200» сам по себе не доказывает, что откат действительно переключил версию.
      if (last.ok && last.marker) return last;
    } catch (e) {
      last = { ok: false, status: 0, marker: false, ms: Date.now() - started, error: (e && e.message) || String(e) };
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return last;
}

// ─────────────────────────── уборка за собой ───────────────────────────

// Порядок здесь не косметика: контейнер занимает имя и держит ревизии, а реестр
// не удаляется, пока в нём лежат образы. Провал одной уборки не должен мешать
// остальным, поэтому всё собирается в список «осталось удалить руками».
async function cleanup(Y, oauth, r) {
  const res = r || {};
  const left = [];
  const attempt = async (what, fn) => {
    try {
      await fn();
      return true;
    } catch (e) {
      left.push(what + " — " + String((e && e.message) || e).slice(0, 200));
      return false;
    }
  };

  if (res.containerId) {
    await attempt("контейнер " + res.containerId, () => Y.deleteResource(oauth, "serverlessContainers", res.containerId));
  }
  if (res.registryId) {
    await attempt("образы реестра " + res.registryId, async () => {
      const images = await Y.listRegistryImages(oauth, res.registryId);
      for (const img of images || []) {
        try {
          await Y.deleteRegistryImage(oauth, img && img.id);
        } catch (e) {
          left.push("образ " + ((img && img.id) || "?") + " — " + String((e && e.message) || e).slice(0, 200));
        }
      }
    });
    await attempt("реестр " + res.registryId, () => Y.deleteResource(oauth, "containerRegistry", res.registryId));
  }
  if (res.secretId) {
    await attempt("секрет Lockbox " + res.secretId, () => Y.deleteResource(oauth, "lockbox", res.secretId));
  }
  if (res.serviceAccountId) {
    await attempt("сервисный аккаунт " + res.serviceAccountId, () => Y.deleteResource(oauth, "iam", res.serviceAccountId));
  }
  return left;
}

// ─────────────────────────── сам прогон ───────────────────────────

// Тестовый проект: статический сайт. Тип определяется по index.html, Dockerfile
// движок генерирует сам (nginx на $PORT) — то есть проверяется и наша сборка.
function writeTestProject(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    [
      "<!doctype html>",
      '<html lang="ru"><head><meta charset="utf-8"><title>E2E ' + marker + "</title></head>",
      "<body><h1>" + marker + "</h1><p>Проверка настоящего деплоя: страница отвечает и содержит маркер.</p></body></html>",
      "",
    ].join("\n")
  );
  return dir;
}

// Прогон целиком. Ничего не печатает: возвращает данные, а решение «прошло/упало»
// принимает вызывающий (main в скрипте, тест — в smoke-наборе). Так одна и та же
// логика проверяется и на настоящем облаке, и на подставном движке.
async function runFlow(d) {
  const deps = d || {};
  const engine = deps.engine;
  const Y = deps.yandex;
  const oauth = deps.oauth;
  const folderId = deps.folderId;
  const dir = deps.dir;
  const appName = deps.appName;
  const stamp = deps.stamp;
  const log = deps.log || (() => {});
  const fetchImpl = deps.fetch || fetch;
  const cloud = { oauth, folderId };
  const healthTries = deps.healthTries || 20;
  const healthDelayMs = deps.healthDelayMs == null ? 5000 : deps.healthDelayMs;

  const names = namesFor(appName);
  const out = {
    appName,
    names,
    marker1: "E2E-MARK-" + stamp + "-1",
    marker2: "E2E-MARK-" + stamp + "-2",
    deploy1: null,
    deploy2: null,
    rollback: null,
    http1: null,
    http2: null,
    httpAfterRollback: null,
    resources: { containerId: "", registryId: "", secretId: "", secretVersionId: "", serviceAccountId: "" },
    stageIds: [],
    warnings: [],
  };

  // #1: настоящий выкат. Секреты включены намеренно — так проверяются и Lockbox,
  // и сервисный аккаунт, которому выдаются права только на этот секрет.
  log("деплой #1 (настоящий): " + dir);
  const d1 = await engine.deploy(dir, {
    cloud,
    name: appName,
    environment: "production",
    env: { E2E_RUN: stamp },
    secrets: { E2E_SECRET: "e2e-" + stamp },
    healthTries,
    healthDelayMs,
  });
  out.deploy1 = {
    ok: !!(d1 && d1.ok),
    url: (d1 && d1.url) || "",
    revisionId: (d1 && d1.revisionId) || "",
    containerId: (d1 && d1.containerId) || "",
    secretId: (d1 && d1.secretId) || "",
    secretVersionId: (d1 && d1.secretVersionId) || "",
    secretKeys: (d1 && d1.secretKeys) || [],
    error: (d1 && d1.error) || "",
    warnings: (d1 && d1.warnings) || [],
    stages: (d1 && d1.stages) || [],
  };
  out.stageIds = out.deploy1.stages.map((s) => s.id);
  out.warnings = out.warnings.concat(out.deploy1.warnings.map((w) => "#1: " + w));
  out.resources.containerId = out.deploy1.containerId;
  out.resources.secretId = out.deploy1.secretId;
  out.resources.secretVersionId = out.deploy1.secretVersionId;

  if (!out.deploy1.ok) return out;

  out.http1 = await httpCheck(out.deploy1.url, out.marker1, { fetch: fetchImpl, tries: 6, delayMs: 4000 });

  // #2: вторая ревизия. Без неё откатывать некуда, а «откат» без второй версии
  // ничего не проверяет.
  log("деплой #2 (вторая ревизия): " + dir);
  writeTestProject(dir, out.marker2);
  const d2 = await engine.deploy(dir, {
    cloud,
    name: appName,
    environment: "production",
    env: { E2E_RUN: stamp },
    secrets: { E2E_SECRET: "e2e-" + stamp },
    healthTries,
    healthDelayMs,
  });
  out.deploy2 = {
    ok: !!(d2 && d2.ok),
    url: (d2 && d2.url) || "",
    revisionId: (d2 && d2.revisionId) || "",
    error: (d2 && d2.error) || "",
    warnings: (d2 && d2.warnings) || [],
  };
  out.warnings = out.warnings.concat(out.deploy2.warnings.map((w) => "#2: " + w));
  if (!out.deploy2.ok) return out;

  out.http2 = await httpCheck(out.deploy2.url, out.marker2, { fetch: fetchImpl, tries: 6, delayMs: 4000 });

  // Откат на первую ревизию — настоящим вызовом облака, с проверкой адреса.
  log("откат на ревизию #1: " + out.deploy1.revisionId);
  const rb = await engine.rollback(dir, {
    cloud,
    containerId: out.deploy1.containerId,
    toRevision: out.deploy1.revisionId,
    toNumber: 1,
    healthPaths: ["/"],
    healthTries: Math.min(healthTries, 10),
    healthDelayMs,
  });
  out.rollback = {
    ok: !!(rb && rb.ok),
    revisionId: (rb && rb.revisionId) || "",
    url: (rb && rb.url) || "",
    error: (rb && rb.error) || "",
    stages: (rb && rb.stages) || [],
  };
  if (out.rollback.ok) {
    // Маркер #1 обязан вернуться: это и есть доказательство, что версия
    // действительно переключилась, а не «страница просто ответила 200».
    out.httpAfterRollback = await httpCheck(out.rollback.url || out.deploy1.url, out.marker1, {
      fetch: fetchImpl,
      tries: 6,
      delayMs: 4000,
    });
  }

  // Ресурсы, созданные прогоном: уборка ищет их по имени движка, а не по догадке.
  if (Y && typeof Y.findRegistry === "function" && !out.resources.registryId) {
    try {
      const reg = await Y.findRegistry(oauth, folderId, names.registry);
      out.resources.registryId = (reg && reg.id) || "";
    } catch {}
  }
  if (Y && typeof Y.findServiceAccount === "function" && !out.resources.serviceAccountId) {
    try {
      const sa = await Y.findServiceAccount(oauth, folderId, names.serviceAccount);
      out.resources.serviceAccountId = (sa && sa.id) || "";
    } catch {}
  }
  return out;
}

// ─────────────────────────── сборка настоящего движка ───────────────────────────

function makeEngine(deps) {
  const d = deps || {};
  const { createDeployEngine } = require(path.join(ROOT, "src", "deploy-engine.js"));
  return createDeployEngine({
    yandex: d.yandex,
    run: d.run,
    findProgram: d.findProgram,
    browserAudit: d.browserAudit || null,
    emit: d.emit || (() => {}),
    log: d.log || (() => {}),
  });
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const env = process.env;
  const argv = process.argv.slice(2);
  const token = String(env.YC_OAUTH_TOKEN || "").trim();
  const stamp = stampNow();
  const appName = "e2e-" + stamp;

  if (argv.includes("--plan")) {
    console.log(planText(appName, env.YC_FOLDER_ID));
    return 0;
  }

  console.log("\n[0] Права и окружение");
  // Причина отказа — короткая строка, а план печатается отдельным блоком ниже:
  // склеенный в одну строку чек не читается (и это ровно тот вывод, который
  // человек видит, когда запускает скрипт впервые).
  check(
    "YC_OAUTH_TOKEN задан",
    !!token,
    token ? "токен есть (не печатаю)" : "нет — возьмите OAuth-токен на oauth.yandex.ru и задайте YC_OAUTH_TOKEN"
  );
  if (!token) {
    console.log("\n" + planText(appName, env.YC_FOLDER_ID));
    return 2;
  }
  const allowed = wantsRealRun(argv, env);
  check(
    "разрешение на реальные траты (AI_AGENT_YC_REAL=1 или --yes)",
    allowed,
    allowed ? "есть" : "нет — без него ничего не создаётся"
  );
  if (!allowed) {
    console.log("\n" + planText(appName, env.YC_FOLDER_ID));
    return 2;
  }

  const findProgram = makeFindProgram();
  const docker = findProgram("docker");
  check("Docker CLI доступен", !!docker.found, docker.found ? docker.path : "не найден в PATH — нужен для сборки и загрузки образа");
  if (!docker.found) return 2;

  const yandex = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const run = makeRun();
  const browserAudit = makeBrowserAudit({ off: String(env.YC_REAL_NO_BROWSER || "") === "1" });
  check("браузер для проверки страницы", !!browserAudit, browserAudit ? "есть" : "отключён (YC_REAL_NO_BROWSER=1)");

  console.log("\n[1] Каталог");
  let folderId = String(env.YC_FOLDER_ID || "").trim();
  try {
    if (!folderId) {
      const clouds = await yandex.listClouds(token);
      const cloudId = (clouds[0] && clouds[0].id) || "";
      const folders = await yandex.listFolders(token, cloudId);
      folderId = (folders[0] && folders[0].id) || "";
    }
    check("каталог получен", !!folderId, folderId || "нет доступных каталогов у этого токена");
  } catch (e) {
    check("каталог получен", false, (e && e.message) || String(e));
  }
  if (!folderId) return 2;

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-yc-real-"));
  const dir = path.join(workDir, appName);
  writeTestProject(dir, "E2E-MARK-" + stamp + "-1");
  console.log("  проект: " + dir);

  const engine = makeEngine({ yandex, run, findProgram, browserAudit, log: (t) => console.log("  · " + t) });
  const names = namesFor(appName);
  const resources = { containerId: "", registryId: "", secretId: "", secretVersionId: "", serviceAccountId: "" };
  let leftovers = [];

  try {
    console.log("\n[2] Настоящий выкат → вторая ревизия → откат");
    const r = await runFlow({
      engine,
      yandex,
      oauth: token,
      folderId,
      dir,
      appName,
      stamp,
      fetch: fetch,
      healthTries: parseInt(env.YC_REAL_HEALTH_TRIES || "", 10) || 20,
      healthDelayMs: parseInt(env.YC_REAL_HEALTH_MS || "", 10) || 5000,
    });

    Object.assign(resources, r.resources);

    check("деплой #1 прошёл", !!(r.deploy1 && r.deploy1.ok), (r.deploy1 && r.deploy1.error) || (r.deploy1 && r.deploy1.url));
    check(
      "все стадии #1 успешны",
      !!r.deploy1 && r.deploy1.stages.length > 0 && r.deploy1.stages.every((s) => s.status === "ok"),
      (r.deploy1 && r.deploy1.stages.map((s) => s.id + ":" + s.status).join(" ")) || "нет стадий"
    );
    check(
      "секреты уехали в Lockbox (id и ключ есть, значения — нет)",
      !!r.deploy1 && !!r.deploy1.secretId && (r.deploy1.secretKeys || []).includes("E2E_SECRET"),
      (r.deploy1 && r.deploy1.secretId + " · ключи: " + (r.deploy1.secretKeys || []).join(",")) || ""
    );
    check(
      "адрес отвечает 200 и отдаёт маркер #1",
      !!(r.http1 && r.http1.ok && r.http1.marker),
      r.http1 ? "HTTP " + r.http1.status + ", маркер " + (r.http1.marker ? "есть" : "НЕТ") + (r.http1.error ? " (" + r.http1.error + ")" : "") : "не проверялся"
    );

    check("деплой #2 (вторая ревизия) прошёл", !!(r.deploy2 && r.deploy2.ok), (r.deploy2 && r.deploy2.error) || (r.deploy2 && r.deploy2.revisionId));
    check(
      "ревизия #2 отличается от #1",
      !!(r.deploy1 && r.deploy2 && r.deploy1.revisionId && r.deploy2.revisionId && r.deploy1.revisionId !== r.deploy2.revisionId),
      (r.deploy1 && r.deploy1.revisionId) + " → " + (r.deploy2 && r.deploy2.revisionId)
    );
    check(
      "адрес отдаёт маркер #2 (новую версию)",
      !!(r.http2 && r.http2.ok && r.http2.marker),
      r.http2 ? "HTTP " + r.http2.status + ", маркер " + (r.http2.marker ? "есть" : "НЕТ") : "не проверялся"
    );

    check("откат прошёл", !!(r.rollback && r.rollback.ok), (r.rollback && r.rollback.error) || (r.rollback && r.rollback.revisionId));
    check(
      "после отката вернулся маркер #1 — версия действительно переключилась",
      !!(r.httpAfterRollback && r.httpAfterRollback.ok && r.httpAfterRollback.marker),
      r.httpAfterRollback ? "HTTP " + r.httpAfterRollback.status + ", маркер " + (r.httpAfterRollback.marker ? "есть" : "НЕТ") : "не проверялся"
    );

    const warns = r.warnings || [];
    console.log("\n  замечаний движка: " + warns.length + (warns.length ? " — " + warns.slice(0, 3).join(" | ") : ""));
  } catch (e) {
    check("прогон без исключений", false, (e && e.message) || String(e));
  } finally {
    if (keepResources(process.env)) {
      console.log("\n[3] Уборка ВЫКЛЮЧЕНА (YC_REAL_KEEP=1) — ресурсы остались в каталоге:");
      console.log("  контейнер: " + (resources.containerId || names.container));
      console.log("  реестр:    " + (resources.registryId || names.registry));
      console.log("  секрет:    " + (resources.secretId || names.secret));
    } else {
      console.log("\n[3] Уборка: удаляю всё, что создал прогон");
      // Реестр и секрет ищем по имени, если движок не успел вернуть их id —
      // иначе уборка «забыла» бы ровно те ресурсы, которые создала до провала.
      try {
        if (!resources.registryId) {
          const reg = await yandex.findRegistry(token, folderId, names.registry);
          resources.registryId = (reg && reg.id) || "";
        }
        if (!resources.containerId) {
          const cont = await yandex.findContainer(token, folderId, names.container);
          resources.containerId = (cont && cont.id) || "";
        }
        if (!resources.secretId) {
          const sec = await yandex.findSecret(token, folderId, names.secret);
          resources.secretId = (sec && sec.id) || "";
        }
        const sa = await yandex.findServiceAccount(token, folderId, names.serviceAccount);
        resources.serviceAccountId = (sa && sa.id) || "";
      } catch (e) {
        console.log("  (поиск ресурсов по имени не удался: " + ((e && e.message) || e) + ")");
      }
      leftovers = await cleanup(yandex, token, resources);
      check("ресурсы удалены", leftovers.length === 0, leftovers.length ? "осталось: " + leftovers.join(" | ") : "каталог чист");
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }

  console.log("\n=== НАСТОЯЩИЙ E2E (Yandex Cloud): " + pass + " ✅ / " + fail + " ❌ ===");
  if (leftovers.length) {
    console.log("Удалить руками (консоль Yandex Cloud):");
    for (const l of leftovers) console.log("  • " + l);
  }
  return fail ? 1 : 0;
}

module.exports = {
  cleanup,
  httpCheck,
  makeBrowserAudit,
  makeEngine,
  makeFindProgram,
  makeRun,
  namesFor,
  planText,
  runFlow,
  stampNow,
  wantsRealRun,
  keepResources,
  writeTestProject,
  _counters: () => ({ pass, fail }),
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      console.error("✗ Прогон не состоялся: " + ((e && e.message) || e));
      process.exit(1);
    });
}

"use strict";
/* ─── Группа «Выкат: движок, мост, приёмка production и настоящий E2E» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 4.

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
  backendSrc,
  get,
  mainOnlySrc,
  tmpdir,
  toolBody,
  uiFile,
} = H;

// ── Деплой: рецепты, состояние, движок ──
// Проверяем то, что раньше выводилось моделью заново и потому ломалось молча:
// какой образ собирать, что писать в историю и что делать, если после выката
// приложение не отвечает.
async function testDeploy() {
  const recipes = require(path.join(ROOT, "src", "deploy-recipes.js"));
  const cloudState = require(path.join(ROOT, "src", "cloud-state.js"));
  const { createDeployEngine } = require(path.join(ROOT, "src", "deploy-engine.js"));

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-deploy-"));
  const mkproj = (name, files) => {
    const d = path.join(tmpRoot, name);
    fs.mkdirSync(d, { recursive: true });
    for (const [f, c] of Object.entries(files)) {
      const p = path.join(d, f);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, c);
    }
    return d;
  };

  // ── рецепты ──
  await test("деплой-рецепты: тип проекта распознаётся по файлам, а не по догадке", () => {
    const vite = recipes.detectProject(
      mkproj("r-vite", {
        "package.json": JSON.stringify({ devDependencies: { vite: "5" }, scripts: { build: "vite build" } }),
        "package-lock.json": "{}",
      })
    );
    assert.strictEqual(vite.kind, "vite");
    assert.strictEqual(vite.buildCmd, "npm run build");
    assert.strictEqual(vite.outputDir, "dist");

    const next = recipes.detectProject(
      mkproj("r-next", { "package.json": JSON.stringify({ dependencies: { next: "14" }, scripts: { build: "next build" } }) })
    );
    assert.strictEqual(next.kind, "next");
    assert.strictEqual(next.label, "Next.js");

    const express = recipes.detectProject(
      mkproj("r-express", { "package.json": JSON.stringify({ dependencies: { express: "4" } }), "server.js": "" })
    );
    assert.strictEqual(express.kind, "node-server");
    assert.strictEqual(express.startCmd, "node server.js");

    const py = recipes.detectProject(mkproj("r-py", { "requirements.txt": "fastapi\nuvicorn\n", "main.py": "" }));
    assert.strictEqual(py.kind, "python");
    assert.strictEqual(py.startCmd, "uvicorn main:app --host 0.0.0.0 --port $PORT");

    const flask = recipes.detectProject(mkproj("r-flask", { "requirements.txt": "flask\n", "app.py": "" }));
    assert.ok(flask.startCmd.includes("gunicorn"), "flask должен запускаться через gunicorn, а не голым скриптом");

    const go = recipes.detectProject(mkproj("r-go", { "go.mod": "module x\n" }));
    assert.strictEqual(go.kind, "go");

    const staticSite = recipes.detectProject(mkproj("r-static", { "index.html": "<h1>x</h1>" }));
    assert.strictEqual(staticSite.kind, "static");

    const empty = recipes.detectProject(mkproj("r-empty", { "README.md": "ничего" }));
    assert.strictEqual(empty.kind, "unknown");
    assert.ok(empty.warnings.length > 0, "непонятный проект должен предупредить, а не молчать");
  });

  await test("деплой-рецепты: сборка многоэтапная, контейнер слушает порт из окружения", () => {
    const vite = { kind: "vite", packageManager: "npm", installCmd: "npm ci", buildCmd: "npm run build", outputDir: "dist", port: 8080, healthPaths: ["/"] };
    const df = recipes.dockerfileFor(vite);
    assert.ok(df.includes("FROM node:20-alpine AS builder"), "сборка статики идёт в отдельном этапе");
    assert.ok(df.includes("FROM nginx:alpine"), "раздавать статику должен nginx, а не dev-сервер");
    assert.ok(df.includes("COPY --from=builder /app/dist/ /usr/share/nginx/html/"), "в образ попадает собранная папка");
    assert.ok(df.includes("listen ${PORT}"), "Serverless Containers передаёт порт переменной — nginx обязан её слушать");
    assert.ok(!df.includes("npm run dev"), "dev-сервер в контейнере — заведомо сломанный выкат");

    // Статический сайт без сборки: один этап и всё же слушатель на $PORT.
    const st = recipes.dockerfileFor({ kind: "static", port: 8080 });
    assert.ok(st.includes("FROM nginx:alpine") && st.includes("listen ${PORT}"));
    assert.ok(!st.includes("AS builder"));

    // Next.js: сборка в builder, запуск в runtime.
    const next = recipes.dockerfileFor({ kind: "next", packageManager: "npm", installCmd: "npm ci", buildCmd: "npm run build", port: 3000, nodeVersion: 22 });
    assert.ok(next.includes("node:22-alpine"), "версия Node берётся из engines проекта");
    assert.ok(next.includes("next start"), "Next запускается своим сервером");

    // Go: статический бинарь в минимальный образ.
    const go = recipes.dockerfileFor({ kind: "go", port: 8080 });
    assert.ok(go.includes("golang:1.22-alpine") && go.includes("CGO_ENABLED=0"));
    assert.ok(go.includes("FROM alpine:3.19"));

    // Пакетные менеджеры, которых нет в node:alpine, ставятся явно.
    assert.ok(recipes.dockerfileFor({ kind: "vite", packageManager: "pnpm", installCmd: "pnpm install --frozen-lockfile", buildCmd: "pnpm run build", outputDir: "dist" }).includes("corepack enable"));
    assert.ok(recipes.dockerfileFor({ kind: "vite", packageManager: "bun", installCmd: "bun install", buildCmd: "bun run build", outputDir: "dist" }).includes("install -g bun"));

    // Python: копируем только файлы зависимостей, которых у проекта нет — не копируем.
    const pyWith = recipes.dockerfileFor({ kind: "python", pythonVersion: "3.12", hasRequirements: true, installCmd: "pip install -r requirements.txt", startCmd: "uvicorn main:app" });
    assert.ok(pyWith.includes("COPY requirements.txt ./"));
    const pyWithout = recipes.dockerfileFor({ kind: "python", pythonVersion: "3.12", installCmd: "pip install .", startCmd: "python app.py" });
    assert.ok(!pyWithout.includes("COPY requirements.txt"), "копирование несуществующего файла ломает сборку");

    // Непонятный проект: честная ошибка вместо выдуманного Dockerfile.
    assert.throws(() => recipes.dockerfileFor({ kind: "unknown" }), /Dockerfile/);
  });

  await test("деплой-рецепты: секреты и мусор в образ не попадают, свой Dockerfile не трогаем", () => {
    const ignore = recipes.dockerignoreFor({ kind: "vite" });
    assert.ok(ignore.includes(".env"), ".env не должен уезжать в образ");
    assert.ok(ignore.includes(".env.*"));
    assert.ok(ignore.includes("node_modules"));
    assert.ok(ignore.includes(".cloud"), "состояние деплоя — не часть приложения");
    assert.ok(ignore.includes("Dockerfile*"), "две копии Dockerfile внутри образа не нужны");

    const proj = mkproj("r-own", { "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } }) });
    const first = recipes.prepareDockerContext(proj);
    assert.ok(first.generated, "своего Dockerfile нет — значит генерируем");
    assert.strictEqual(path.basename(first.dockerfile), "Dockerfile.yandexcloud", "генерированный файл не подменяет имя Dockerfile");
    assert.ok(fs.existsSync(path.join(proj, ".dockerignore")));

    fs.writeFileSync(path.join(proj, "Dockerfile"), "FROM scratch\n");
    const second = recipes.prepareDockerContext(proj);
    assert.strictEqual(second.generated, false);
    assert.strictEqual(path.basename(second.dockerfile), "Dockerfile", "свой Dockerfile всегда в приоритете");
    assert.strictEqual(second.ignoreWritten, false, "существующий .dockerignore не перезаписываем");
    assert.strictEqual(fs.readFileSync(path.join(proj, "Dockerfile"), "utf8"), "FROM scratch\n");
  });

  // ── состояние ──
  await test("состояние облака: деплои нумеруются, откат находит прошлую рабочую версию", () => {
    const d = mkproj("s-num", {});
    assert.strictEqual(cloudState.readState(d).deployments.length, 0);
    const a = cloudState.recordDeployment(d, { status: "ok", revisionId: "rev-a" });
    const b = cloudState.recordDeployment(d, { status: "failed" });
    assert.strictEqual(a.number, 1);
    assert.strictEqual(b.number, 2, "нумерация как в консоли: #1, #2, #3");
    cloudState.updateDeployment(d, b.id, { status: "failed", error: "health упал" });

    const target = cloudState.rollbackTarget(d, b.id);
    assert.strictEqual(target.revisionId, "rev-a", "откатываться нужно на рабочую ревизию, а не на провалившуюся");

    // Секреты в состояние не пишем — только ключи.
    cloudState.writeInfrastructure(d, { envKeys: ["DATABASE_URL"], container: { id: "c1" } });
    const text = fs.readFileSync(path.join(d, ".cloud", "deployments.json"), "utf8") + fs.readFileSync(path.join(d, ".cloud", "infrastructure.json"), "utf8");
    assert.ok(!/password|secret-token/i.test(text));
    const cfg = cloudState.toCloudConfig(d);
    assert.strictEqual(cfg.resources.container, "c1");
    assert.deepStrictEqual(cfg.envKeys, ["DATABASE_URL"]);
    assert.strictEqual(cfg.deployment.number, 2);
  });

  await test("состояние облака: битый файл откладывается, деплой не падает", () => {
    const d = mkproj("s-broken", {});
    cloudState.recordDeployment(d, { status: "ok" });
    fs.writeFileSync(path.join(d, ".cloud", "deployments.json"), "{ это не json");
    const st = cloudState.readState(d);
    assert.strictEqual(st.deployments.length, 0, "битый файл не роняет приложение");
    assert.ok(st.issues.length === 1 && /Повреждён/.test(st.issues[0]), "о потере надо сказать вслух, а не молча начать заново");
    const files = fs.readdirSync(path.join(d, ".cloud"));
    assert.ok(files.some((f) => f.startsWith("deployments.json.bak-")), "испорченный файл сохраняется рядом");
    assert.ok(!files.some((f) => f.endsWith(".tmp")), "временных файлов после записи не остаётся");
  });

  // ── движок ──
  const makeEngine = (opts) => {
    const o = opts || {};
    const calls = { run: [], yandex: [], health: 0, audit: 0 };
    const run = (command, cwd, timeoutMs, runOpts) => {
      calls.run.push({ command, input: runOpts && runOpts.input });
      if (command === "docker --version") return { code: 0, out: "Docker version 25.0.3" };
      if (command.includes("docker build")) return { code: o.buildCode == null ? 0 : o.buildCode, out: o.buildCode ? "error: COPY failed" : "Successfully built" };
      if (command.includes("docker push")) return { code: 0, out: "digest: sha256:deadbeef size: 1" };
      if (command.includes("docker login")) return { code: 0, out: "Login Succeeded" };
      return { code: 0, out: "ok" };
    };
    const yandex = {
      slugify: (s) => String(s).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      getIamToken: async () => "t1.IAMTOKEN",
      ensureRegistry: async () => ({ id: "crp1" }),
      ensureContainer: async () => ({ id: "cont1" }),
      ensureServiceAccount: async () => {
        calls.yandex.push("sa");
        return { id: "sa1" };
      },
      addRoleOnFolder: async () => ({}),
      // Публичный доступ — отдельный вызов на контейнер (привязка allUsers → invoker).
      setContainerPublicAccess: async (_a, containerId) => {
        if (o.publicAccessFails) {
          throw new Error("Права контейнера не изменились: привязка «все пользователи → serverless.containers.invoker» не появилась.");
        }
        calls.yandex.push("public:" + containerId + (o.publicAccessAlready ? ":already" : ""));
        return { ok: true, already: !!o.publicAccessAlready, bindings: [] };
      },
      deployContainerRevision: async (_a, args) => {
        calls.yandex.push("revision:" + args.imageUrl);
        calls.revisionArgs = args;
        return { revisionId: "rev-" + calls.yandex.length };
      },
      // Lockbox: секрет, его версия (значения), чтение по ссылке и права на секрет.
      ensureLockboxSecret: async (_a, _folderId, name) => {
        calls.yandex.push("secret:" + name);
        return { id: "sec1", name };
      },
      putSecretVersion: async (_a, id, entries) => {
        calls.secretValues = entries.slice();
        calls.yandex.push("secretVersion:" + id + ":" + entries.map((e) => e.key).join("+"));
        return { versionId: "ver1", keys: entries.map((e) => e.key) };
      },
      getSecret: async (_a, id) => {
        calls.yandex.push("getSecret:" + id);
        return { id, name: "готовый" };
      },
      grantSecretAccess: async (_a, id, saId) => {
        calls.yandex.push("grant:" + id + ":" + saId);
        return true;
      },
      containerInfo: async () => ({ url: "https://app.test" }),
      rollbackContainer: async (_a, cid, rev) => {
        calls.yandex.push("rollback:" + cid + ":" + rev);
        return {};
      },
    };
    const plan = (o.health || [200]).slice();
    // Раньше при исчерпании плана подставлялся 200, и тест незаметно превращался
    // в успешный прогон. Теперь держится последнее значение: план задаёт всё.
    const nextStatus = () => (plan.length > 1 ? plan.shift() : plan[0]);
    const engine = createDeployEngine({
      run,
      yandex,
      fetch: async () => {
        calls.health++;
        return { status: nextStatus() };
      },
      emit: () => {},
      findProgram: () => ({ found: true }),
      browserAudit: o.browserAudit
        ? async (u) => {
            calls.audit++;
            return typeof o.browserAudit === "function" ? o.browserAudit(u) : o.browserAudit;
          }
        : undefined,
    });
    return { engine, calls };
  };

  const projFiles = {
    "package.json": JSON.stringify({ dependencies: { react: "18", vite: "5" }, scripts: { build: "vite build" } }),
    "package-lock.json": "{}",
    ".env": "SECRET=1\n",
  };

  await test("движок деплоя: стадии идут по порядку, образ получает тег с номером деплоя", async () => {
    const d = mkproj("e-ok", projFiles);
    const { engine, calls } = makeEngine({});
    const r = await engine.deploy(d, {
      cloud: { oauth: "o", folderId: "b1g", folderName: "default" },
      name: "My Shop",
      env: { DATABASE_URL: "postgres://user:pw@host/db" },
      runTests: false,
      healthTries: 2,
      healthDelayMs: 1,
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(
      r.stages.map((s) => s.id),
      ["check", "detect", "verify", "package", "registry", "login", "build", "push", "container", "revision", "health", "record"],
      "порядок стадий фиксированный — модель его не придумывает"
    );
    assert.ok(r.stages.every((s) => s.status === "ok"));
    assert.strictEqual(r.image, "cr.yandex/crp1/my-shop:d1", "тег с номером деплоя: иначе откат указывает на тот же образ");
    // Секрет уходит в контейнер, но в состоянии проекта его нет.
    const stateText = fs.readFileSync(path.join(d, ".cloud", "deployments.json"), "utf8") + fs.readFileSync(path.join(d, ".cloud", "infrastructure.json"), "utf8");
    assert.ok(!stateText.includes("postgres://user:pw@host/db"), "значения секретов не пишем в состояние");
    assert.ok(stateText.includes("DATABASE_URL"), "но ключи храним — иначе не восстановить конфигурацию");
    // IAM-токен не должен светиться в аргументах команды.
    const login = calls.run.find((c) => c.command.includes("docker login"));
    assert.ok(login.command.includes("--password-stdin") && login.input === "t1.IAMTOKEN");
    assert.ok(!calls.run.some((c) => c.command.includes("t1.IAMTOKEN")), "токен в argv виден в списке процессов — нельзя");
  });

  await test("движок деплоя: провалившийся выкат сам откатывается на прошлую рабочую версию", async () => {
    const d = mkproj("e-rollback", projFiles);
    const first = makeEngine({});
    const r1 = await first.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 2, healthDelayMs: 1 });
    assert.strictEqual(r1.ok, true);

    // Новая ревизия отдаёт 500, а прошлая после отката отвечает 200.
    // 4 ответа на проверку до выката, 4 — после отката: последние живые.
    const second = makeEngine({ health: [500, 500, 500, 500, 200, 200, 200, 200] });
    const r2 = await second.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 2, healthDelayMs: 1 });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.status, "rolled-back", "если откат удался, это не просто «провал»");
    assert.strictEqual(r2.rolledBackTo, 1);
    assert.ok(second.calls.yandex.some((c) => c.startsWith("rollback:cont1:rev-")), "движок обязан вернуть прошлую ревизию");
    const hist = cloudState.deploymentHistory(d);
    assert.strictEqual(hist[0].status, "rolled-back");
    assert.strictEqual(hist[0].rolledBackTo, 1);
    assert.ok(hist[0].stages.some((s) => s.id === "rollback" && s.status === "ok"));
  });

  await test("движок деплоя: если и прошлая версия мертва — честный провал без вранья про успех", async () => {
    const d = mkproj("e-dead", projFiles);
    const first = makeEngine({});
    await first.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 2, healthDelayMs: 1 });
    const second = makeEngine({ health: [500, 500, 500, 500, 500, 500, 500, 500] });
    const r = await second.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 2, healthDelayMs: 1 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, "failed");
    assert.strictEqual(r.rolledBack, false);
    assert.ok(/не отвечает/i.test(r.error), "в ошибке должно быть сказано, что приложение не отвечает");
  });

  await test("движок деплоя: упавшая сборка останавливает конвейер и не выдаёт успех", async () => {
    const d = mkproj("e-build-fail", projFiles);
    const { engine, calls } = makeEngine({ buildCode: 1 });
    const r = await engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 2, healthDelayMs: 1 });
    assert.strictEqual(r.ok, false);
    const ids = r.stages.map((s) => s.id);
    assert.strictEqual(ids[ids.length - 1], "build", "после упавшей сборки дальше идти некуда");
    assert.ok(ids.includes("build") && !ids.includes("push"), "в реестр ничего не отправляем");
    assert.ok(!calls.yandex.some((c) => c.startsWith("revision:")), "ревизию не создаём");
    assert.ok(/docker build упал/.test(r.error));
  });

  await test("движок деплоя: локальная сборка идёт до упаковки, а приватный контейнер объясняется", async () => {
    const d = mkproj("e-verify", projFiles);
    const { engine, calls } = makeEngine({});
    const r = await engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    const order = calls.run.map((c) => c.command);
    const iBuild = order.indexOf("npm run build");
    const iDocker = order.findIndex((c) => c.includes("docker build"));
    assert.ok(iBuild >= 0 && iDocker > iBuild, "сначала локальная сборка проекта, потом образ: иначе в образ уедет сломанное состояние");

    // 403 значит «контейнер не публичный» — это надо назвать причиной, а не «ошибкой».
    const priv = makeEngine({ health: [403, 403, 403, 403] });
    const r2 = await priv.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1, autoRollback: false });
    assert.strictEqual(r2.ok, false);
    assert.ok(/публичн/i.test(r2.error), "403 нужно объяснять словами про публичный доступ");
    assert.ok(/все пользователи/.test(r2.error), "в объяснении 403 должно быть сказано, чем именно открывается контейнер");

  });

  await test("секреты деплоя: значения уезжают в Lockbox, а в ревизию — только ссылка", async () => {
    const d = mkproj("e-secrets", projFiles);
    const { engine, calls } = makeEngine({});
    const r = await engine.deploy(d, {
      cloud: { oauth: "o", folderId: "b1g" },
      name: "app",
      runTests: false,
      healthTries: 1,
      healthDelayMs: 1,
      env: { NODE_ENV: "production", DATABASE_URL: "postgres://secret" },
      secrets: { DATABASE_URL: "postgres://user:pw@host/db", API_KEY: "s3cret" },
    });
    assert.strictEqual(r.ok, true, r.error);
    const ids = r.stages.map((s) => s.id);
    assert.ok(
      ids.indexOf("secrets") > ids.indexOf("container") && ids.indexOf("secrets") < ids.indexOf("revision"),
      "стадия секретов идёт между контейнером и ревизией: " + ids.join(",")
    );
    // Значения ушли в версию секрета, а не в образ.
    assert.deepStrictEqual(calls.secretValues, [
      { key: "DATABASE_URL", value: "postgres://user:pw@host/db" },
      { key: "API_KEY", value: "s3cret" },
    ]);
    const args = calls.revisionArgs;
    assert.ok(
      !JSON.stringify(args.env).includes("s3cret") && !JSON.stringify(args.env).includes("postgres://user:pw"),
      "значения секретов не дублируются в открытом окружении: " + JSON.stringify(args.env)
    );
    assert.strictEqual(args.env.NODE_ENV, "production", "обычные переменные остаются открытыми");
    // Проверять надо ИМЕНА переменных: значение обычной переменной может совпасть
    // случайно, а вот дубль «одно и то же в двух полях» — это утечка открытым текстом.
    assert.deepStrictEqual(Object.keys(args.env).sort(), ["NODE_ENV"], "переменные, ставшие секретами, не дублируются открытым текстом");
    assert.ok(
      r.warnings.some((w) => /заданы дважды/.test(w)),
      "про одну и ту же переменную в двух полях человек должен узнать: " + JSON.stringify(r.warnings)
    );
    assert.ok(
      r.stages.find((s) => s.id === "secrets").detail.includes("lockbox.payloadViewer"),
      "стадия секретов говорит, какие права выданы"
    );
    assert.deepStrictEqual(args.secrets.map((s) => s.environmentVariable), ["DATABASE_URL", "API_KEY"]);
    assert.ok(args.secrets.every((s) => s.id === "sec1" && s.key === s.environmentVariable), "ревизия ссылается на секрет, а не на значение");
    assert.ok(args.secrets.every((s) => s.versionId === "ver1"), "версия секрета указана явно: иначе подставится другая");
    assert.ok(calls.yandex.includes("grant:sec1:sa1"), "права выдаются НА СЕКРЕТ и сервисному аккаунту ревизии");
    assert.ok(calls.yandex.includes("sa"), "для секретов сервисный аккаунт создаётся сам");
    // В состоянии — только id секрета и имена ключей.
    const stateText =
      fs.readFileSync(path.join(d, ".cloud", "deployments.json"), "utf8") + fs.readFileSync(path.join(d, ".cloud", "infrastructure.json"), "utf8");
    assert.ok(!stateText.includes("s3cret") && !stateText.includes("postgres://user:pw"), "значения секретов не пишем в состояние");
    assert.ok(stateText.includes("API_KEY") && stateText.includes("sec1"), "id секрета и имена ключей храним");

    // Готовый секрет по ссылке: значения не нужны и не читаются.
    const d2 = mkproj("e-secrets-ref", projFiles);
    const ref = makeEngine({});
    const r2 = await ref.engine.deploy(d2, {
      cloud: { oauth: "o", folderId: "b1g" },
      name: "app",
      runTests: false,
      healthTries: 1,
      healthDelayMs: 1,
      secretId: "sec9",
      secretKeys: ["DATABASE_URL"],
    });
    assert.strictEqual(r2.ok, true, r2.error);
    assert.ok(ref.calls.yandex.includes("getSecret:sec9"), "готовый секрет читается по ссылке");
    assert.ok(!ref.calls.secretValues, "значения секрета не запрашиваются и не пишутся");
    assert.deepStrictEqual(ref.calls.revisionArgs.secrets, [{ id: "sec9", key: "DATABASE_URL", environmentVariable: "DATABASE_URL" }]);

    // Готовый секрет без ключей — понятная ошибка, а не молчаливый выкат.
    const d3 = mkproj("e-secrets-nokeys", projFiles);
    const bad = makeEngine({});
    const r3 = await bad.engine.deploy(d3, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1, secretId: "sec9" });
    assert.strictEqual(r3.ok, false);
    assert.ok(/secretKeys/.test(r3.error), "в ошибке сказано, чего не хватает: " + r3.error);
  });

  await test("Lockbox: версия секрета кладётся нужным запросом, права — на секрет, значения наружу не идут", async () => {
    const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
    const realFetch = global.fetch;
    const reqs = [];
    let returnVersion = true;
    const mkJson = (obj) => ({ ok: true, status: 200, async text() { return JSON.stringify(obj); }, async json() { return obj; } });
    global.fetch = async (url, init) => {
      const p = String(url).split("?")[0];
      reqs.push({ method: (init && init.method) || "GET", path: p, body: init && init.body ? JSON.parse(init.body) : null });
      if (p.endsWith("/iam/v1/tokens")) return mkJson({ iamToken: "t1.T", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      // Опрос операции: id готовой версии приходит именно здесь, а не в ответе
      // на :addVersion (тот отдаёт операцию, а не результат).
      if (p.includes("/operations/")) return mkJson({ id: "op", done: true, response: returnVersion ? { id: "ver7" } : undefined });
      if (p.endsWith(":addVersion")) return mkJson({ id: "opi", done: true });
      if (p.endsWith("/versions")) return mkJson({ versions: [{ id: "ver8", createdAt: "2026-09-16T10:00:00Z" }, { id: "ver7", createdAt: "2026-09-15T10:00:00Z" }] });
      if (p.endsWith(":updateAccessBindings")) return mkJson({ id: "opb", done: true });
      return mkJson({});
    };
    try {
      const v = await yc.putSecretVersion("oauth", "sec1", [{ key: "DATABASE_URL", value: "postgres://user:pw@host/db" }]);
      const add = reqs.find((r) => r.path.endsWith(":addVersion"));
      assert.ok(add && add.method === "POST", "версия добавляется запросом :addVersion");
      assert.deepStrictEqual(add.body.payloadEntries, [{ key: "DATABASE_URL", textValue: "postgres://user:pw@host/db" }]);
      assert.strictEqual(v.versionId, "ver7", "id версии берётся из ответа операции");
      assert.deepStrictEqual(v.keys, ["DATABASE_URL"]);
      assert.ok(!JSON.stringify(v).includes("postgres://user:pw"), "значения не возвращаются наружу");
      assert.ok(!JSON.stringify(v).includes("host/db"), "значения не возвращаются наружу");

      // Операция без response: id версии добираем списком, а не выдумываем.
      returnVersion = false;
      const v2 = await yc.putSecretVersion("oauth", "sec1", [{ key: "API_KEY", value: "x" }]);
      assert.strictEqual(v2.versionId, "ver8");

      await assert.rejects(
        () => yc.putSecretVersion("oauth", "sec1", [{ key: "плохой ключ", value: "x" }]),
        /не годится/,
        "ключ, который Lockbox не примет, отсекаем сами — с понятным текстом"
      );
      await assert.rejects(() => yc.putSecretVersion("oauth", "sec1", []), /ключ → значение/);

      await yc.grantSecretAccess("oauth", "sec1", "sa1", "lockbox.payloadViewer");
      const grant = reqs.filter((r) => r.path.endsWith(":updateAccessBindings")).pop();
      assert.strictEqual(grant.path, "https://lockbox.api.cloud.yandex.net/lockbox/v1/secrets/sec1:updateAccessBindings");
      assert.deepStrictEqual(grant.body.accessBindingDeltas[0].accessBinding, {
        roleId: "lockbox.payloadViewer",
        subject: { id: "sa1", type: "serviceAccount" },
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("движок деплоя: контейнер открывается привязкой «все пользователи» на контейнер", async () => {
    const d = mkproj("e-public", projFiles);
    const first = makeEngine({});
    const r = await first.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r.ok, true);
    const cont = r.stages.find((s) => s.id === "container") || {};
    assert.ok(/все пользователи/.test(cont.detail || ""), "публичность выдаётся привязкой на контейнер: " + cont.detail);
    assert.ok(first.calls.yandex.includes("public:cont1"), "движок обязан выдать публичный доступ");
    assert.ok(!first.calls.yandex.includes("sa"), "сервисный аккаунт для публичности не нужен: лишнее право и лишний ресурс в каталоге");

    const second = makeEngine({ publicAccessAlready: true });
    const r2 = await second.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r2.ok, true);
    const again = r2.stages.find((s) => s.id === "container") || {};
    assert.ok(/уже был/.test(again.detail || ""), "повторную выдачу прав надо назвать словами, а не молчать: " + again.detail);

    const d3 = mkproj("e-public-fail", projFiles);
    const third = makeEngine({ publicAccessFails: true });
    const r3 = await third.engine.deploy(d3, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r3.ok, false);
    assert.ok(/setAccessBindings/.test(r3.error), "в ошибке должно быть названо право, которого не хватило: " + r3.error);
    assert.ok(!third.calls.yandex.some((c) => c.startsWith("revision:")), "ревизию без публичного доступа не создаём");

    const d4 = mkproj("e-private", projFiles);
    const fourth = makeEngine({});
    const r4 = await fourth.engine.deploy(d4, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", public: false, runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r4.ok, true);
    assert.ok(!fourth.calls.yandex.some((c) => c.startsWith("public:")), "при public: false права не трогаем");
  });

  await test("публичный доступ: привязка allUsers → invoker, повтор и отказ распознаются", async () => {
    const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
    const realFetch = global.fetch;
    const mkJson = (obj, status) => ({
      ok: (status || 200) < 400,
      status: status || 200,
      async text() { return JSON.stringify(obj); },
      async json() { return obj; },
    });
    let bindings = [];
    let updates = 0;
    let failUpdate = false;
    global.fetch = async (url, init) => {
      const p = String(url).split("?")[0];
      const method = (init && init.method) || "GET";
      if (p.endsWith("/iam/v1/tokens")) return mkJson({ iamToken: "t1.TEST", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p.endsWith(":listAccessBindings")) return mkJson({ accessBindings: bindings.slice() });
      if (p.endsWith(":updateAccessBindings") && method === "POST") {
        updates++;
        const delta = JSON.parse(init.body).accessBindingDeltas[0];
        if (failUpdate) return mkJson({ id: "op1", done: true });
        // В ответе облако отдаёт id роли в другой форме: готовая привязка всё
        // равно должна распознаваться, иначе мы добавим её второй раз.
        bindings.push({ roleId: "serverless-containers.containerInvoker", subject: delta.accessBinding.subject });
        return mkJson({ id: "op1", done: true });
      }
      if (p.includes("/operations/")) return mkJson({ id: "op1", done: true });
      return mkJson({});
    };
    try {
      const first = await yc.setContainerPublicAccess("oauth", "cont1");
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.already, false);
      assert.strictEqual(updates, 1, "привязка добавляется одним запросом");

      const second = await yc.setContainerPublicAccess("oauth", "cont1");
      assert.strictEqual(second.already, true, "готовую привязку надо распознать, а не добавлять второй раз");
      assert.strictEqual(updates, 1, "повторный вызов не должен слать второй запрос");

      const list = await yc.listContainerAccessBindings("oauth", "cont1");
      assert.deepStrictEqual(list[0], { roleId: "serverless-containers.containerInvoker", subjectId: "allUsers", subjectType: "system" });

      failUpdate = true;
      bindings = [];
      await assert.rejects(
        () => yc.setContainerPublicAccess("oauth", "cont2"),
        /setAccessBindings/,
        "если права не изменились — это ошибка с названным правом, а не тихий успех"
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("публичный доступ сквозь настоящий модуль облака: закрытый контейнер отвечает 403, права открывают", async () => {
    const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
    const realFetch = global.fetch;
    // Облако как в жизни: адрес контейнера отвечает 403, пока нет привязки
    // «все пользователи → invoker». Прежняя подмена этого не воспроизводила —
    // и ошибка выдачи прав жила незамеченной: все стадии проходили, а выкат
    // умирал на проверке адреса (403), потому что роль выдали сервисному
    // аккаунту на каталог, а не всеобщей привязкой на контейнер.
    let bindings = [];
    let updates = 0;
    let ignoreUpdate = false;
    let revisions = 0;
    const projDir = mkproj("e-real-yc", projFiles);
    const PAGE = '<!doctype html><html><head><title>Магазин</title></head><body><div id=root><h1>Магазин работает</h1><p>Товары загружены: 12 позиций</p></div></body></html>';
    const resp = (status, body, type) => ({
      ok: status < 400,
      status,
      async text() { return typeof body === "string" ? body : JSON.stringify(body); },
      async json() { return typeof body === "string" ? {} : body; },
      headers: { get: () => type || "application/json" },
    });
    global.fetch = async (url, init) => {
      const p = String(url).split("?")[0];
      const method = (init && init.method) || "GET";
      // Адрес контейнера: закрыт, пока прав нет.
      if (p.startsWith("http://app.test")) {
        if (!bindings.length) return resp(403, "forbidden: container is not public", "text/plain");
        return resp(200, PAGE, "text/html");
      }
      if (p.endsWith("/iam/v1/tokens")) return resp(200, { iamToken: "t1.REAL", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
      if (p.endsWith("/container-registry/v1/registries")) {
        return method === "POST" ? resp(200, { id: "op", done: true }) : resp(200, { registries: [{ id: "crp9", name: "app-registry" }] });
      }
      if (p.endsWith("/containers/v1/containers")) {
        return method === "POST" ? resp(200, { id: "op", done: true }) : resp(200, { containers: [{ id: "cont9", name: "app" }] });
      }
      if (p.endsWith("/containers/v1/containers/cont9")) {
        return resp(200, { id: "cont9", name: "app", folderId: "f1", status: "ACTIVE", url: "http://app.test" });
      }
      if (p.endsWith("/containers/v1/containers/cont9:listAccessBindings")) return resp(200, { accessBindings: bindings });
      if (p.endsWith("/containers/v1/containers/cont9:updateAccessBindings") && method === "POST") {
        updates++;
        if (!ignoreUpdate) {
          try {
            for (const d of JSON.parse(init.body || "{}").accessBindingDeltas || []) {
              bindings.push({ roleId: d.accessBinding.roleId, subject: d.accessBinding.subject });
            }
          } catch {}
        }
        return resp(200, { id: "op", done: true });
      }
      if (p.endsWith("/containers/v1/revisions:deploy") && method === "POST") {
        revisions++;
        return resp(200, { id: "op", done: true });
      }
      if (p.endsWith("/containers/v1/revisions")) return resp(200, { revisions: [] });
      if (p.includes("/operations/")) return resp(200, { id: "op", done: true });
      return resp(200, {});
    };
    const mkEngine = () =>
      createDeployEngine({
        run: (command) => {
          if (command === "docker --version") return { code: 0, out: "Docker version 25.0.3" };
          if (command.includes("docker push")) return { code: 0, out: "digest: sha256:abcd" };
          return { code: 0, out: "ok" };
        },
        yandex: yc,
        emit: () => {},
        findProgram: () => ({ found: true }),
      });
    try {
      const ok = await mkEngine().deploy(projDir, {
        cloud: { oauth: "oauth-token", folderId: "f1" },
        name: "app",
        runTests: false,
        healthTries: 1,
        healthDelayMs: 1,
      });
      assert.strictEqual(ok.ok, true, "сквозной выкат через настоящий модуль облака: " + ok.error);
      assert.ok(updates >= 1, "права на контейнер выдаются запросом к облаку");
      assert.ok(
        bindings.some((b) => b.subject && b.subject.id === "allUsers" && b.subject.type === "system"),
        "публичность — это привязка «все пользователи», а не роль сервисному аккаунту"
      );
      assert.strictEqual(ok.health.status, 200, "адрес открылся только после выдачи прав");

      const updBefore = updates;
      const again = await mkEngine().deploy(projDir, {
        cloud: { oauth: "oauth-token", folderId: "f1" },
        name: "app",
        runTests: false,
        healthTries: 1,
        healthDelayMs: 1,
      });
      assert.strictEqual(again.ok, true);
      assert.strictEqual(updates, updBefore, "готовые права не добавляем повторно");

      const dFail = mkproj("e-real-yc-fail", projFiles);
      ignoreUpdate = true;
      bindings = [];
      const revBefore = revisions;
      const bad = await mkEngine().deploy(dFail, {
        cloud: { oauth: "oauth-token", folderId: "f1" },
        name: "app",
        runTests: false,
        healthTries: 1,
        healthDelayMs: 1,
      });
      assert.strictEqual(bad.ok, false, "без публичного доступа выкат не должен считаться успешным");
      assert.ok(/setAccessBindings/.test(bad.error), "в ошибке названо право, которого не хватило: " + bad.error);
      assert.strictEqual(revisions, revBefore, "ревизию без публичного доступа не создаём");
    } finally {
      global.fetch = realFetch;
    }
  });

  await test("движок деплоя: ручной откат проверяет результат, а не только команду", async () => {
    const d = mkproj("e-manual", projFiles);
    const first = makeEngine({});
    await first.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    const good = makeEngine({ health: [200] });
    const ok = await good.engine.rollback(d, { cloud: { oauth: "o" }, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(ok.ok, true);
    assert.ok(ok.revisionId);

    const bad = makeEngine({ health: [500, 500] });
    const fail = await bad.engine.rollback(d, { cloud: { oauth: "o" }, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(fail.ok, false, "откат без проверки — это вера, а не факт");
    assert.ok(/не отвечает/i.test(fail.error));
  });

  await test("проверка страницы: белый экран отличается от здоровой страницы", () => {
    const deployCheck = require(path.join(ROOT, "src", "deploy-check.js"));
    const good = {
      ok: true,
      status: 200,
      info: { title: "Магазин", textLen: 400, rootChildren: 5, h1: ["Магазин"] },
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
    };
    assert.strictEqual(deployCheck.evaluate(good).level, "ok");

    const blank = deployCheck.evaluate(Object.assign({}, good, { info: { title: "", textLen: 0, rootChildren: 0, h1: [] } }));
    assert.strictEqual(blank.ok, false, "пустая страница — это провал, а не успех с оговоркой");
    assert.ok(/белый экран/.test(blank.reason), blank.reason);

    // Ошибки в консоли — замечание: страница работает, но о проблемах надо сказать.
    const noisy = deployCheck.evaluate(Object.assign({}, good, { consoleErrors: ["Uncaught TypeError: x is not a function"] }));
    assert.strictEqual(noisy.ok, true);
    assert.strictEqual(noisy.level, "warn");
    assert.ok(/консоли/.test(noisy.warnings.join(" ")), noisy.warnings.join(" "));

    for (const pair of [[500, /падает/], [404, /404/], [401, /публичн|авторизац/]]) {
      const r = deployCheck.evaluate(Object.assign({}, good, { status: pair[0] }));
      assert.strictEqual(r.ok, false, "код " + pair[0] + " — провал выката");
      assert.ok(pair[1].test(r.reason), r.reason);
    }

    // Текст есть, но контейнер приложения пуст — скрипты, скорее всего, не загрузились.
    const emptyRoot = deployCheck.evaluate(Object.assign({}, good, { info: { title: "t", textLen: 300, rootChildren: 0, h1: [] } }));
    assert.strictEqual(emptyRoot.level, "warn");
    assert.ok(/контейнер приложения пуст/.test(emptyRoot.warnings.join(" ")), emptyRoot.warnings.join(" "));

    // Браузера нет вовсе — проверка честно не проходит, но и не врёт «всё хорошо».
    assert.strictEqual(deployCheck.evaluate({ ok: false, error: "браузер не запустился" }).ok, false);
    assert.ok(/не запустился/.test(deployCheck.summarize(deployCheck.evaluate({ ok: false, error: "браузер не запустился" }))));
  });

  await test("движок деплоя: страница в браузере проверяется, сломанная — откат и скриншот", async () => {
    const page = (extra) =>
      Object.assign(
        {
          ok: true,
          status: 200,
          info: { title: "Магазин", textLen: 500, rootChildren: 4, h1: ["Магазин"] },
          consoleErrors: [],
          pageErrors: [],
          failedRequests: [],
          screenshot: Buffer.from("fake-png"),
        },
        extra || {}
      );

    const d = mkproj("e-browse", projFiles);
    const good = makeEngine({ browserAudit: page() });
    const r1 = await good.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r1.ok, true);
    assert.deepStrictEqual(r1.stages.map((s) => s.id).slice(-3), ["health", "browse", "record"], "браузер проверяется после адреса");
    assert.strictEqual(r1.browserCheck.metrics.title, "Магазин");
    assert.ok(r1.browserShot && fs.existsSync(r1.browserShot), "скриншот выкаченной страницы сохраняется рядом с состоянием");
    assert.ok(/Проверка в браузере/.test(r1.stages[r1.stages.length - 2].label));

    // Шумная консоль деплой не отменяет, но замечание попадает и в историю, и в предупреждения.
    const noisyEngine = makeEngine({ browserAudit: page({ consoleErrors: ["Uncaught TypeError: boom"] }) });
    const r2 = await noisyEngine.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r2.ok, true);
    assert.ok(r2.warnings.some((w) => /браузер:/.test(w)), r2.warnings.join(" | "));
    const rec2 = cloudState.deploymentHistory(d)[0];
    assert.strictEqual(rec2.browserCheck.level, "warn");

    // Белый экран — провал: движок откатывается и проверяет страницу после отката.
    const blankEngine = makeEngine({ browserAudit: page({ info: { title: "", textLen: 0, rootChildren: 0, h1: [] }, screenshot: null }) });
    const r3 = await blankEngine.engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.status, "rolled-back");
    assert.ok(/белый экран/.test(r3.error), r3.error);
    assert.ok(blankEngine.calls.yandex.some((c) => c.startsWith("rollback:")), "белый экран обязан приводить к откату");
    assert.strictEqual(r3.browserCheck.ok, false, "проверка страницы после отката тоже видит пустую страницу");
    assert.ok(blankEngine.calls.audit >= 2, "после отката страницу смотрим ещё раз: " + blankEngine.calls.audit);
  });

  await test("движок деплоя: без браузера стадия проверки страницы честно пропускается", async () => {
    const d = mkproj("e-nobrowser", projFiles);
    const { engine, calls } = makeEngine({});
    const r = await engine.deploy(d, { cloud: { oauth: "o", folderId: "b1g" }, name: "app", runTests: false, healthTries: 1, healthDelayMs: 1 });
    assert.strictEqual(r.ok, true);
    assert.ok(!r.stages.some((s) => s.id === "browse"), "стадии нет — значит и врать нечему");
    assert.strictEqual(calls.audit, 0);
    assert.ok(r.warnings.some((w) => /браузер недоступен|браузером пропущена/i.test(w)), r.warnings.join(" | "));
  });

  // ── связка с приложением ──
  await test("деплой: приложение и агент идут одним конвейером, дублирующей логики нет", () => {
    const mainSrc = backendSrc();
    assert.ok(mainSrc.includes('require("./deploy-engine.js")'));
    assert.ok(mainSrc.includes("async function runCloudDeploy("));
    assert.ok(mainSrc.includes('ipcMain.handle("yc:deploy"'), "кнопка деплоя на месте");
    assert.ok(mainSrc.includes('ipcMain.handle("deploy:state"') && mainSrc.includes('ipcMain.handle("deploy:rollback"'));
    assert.ok(!mainSrc.includes("function ycGenerateDockerfile"), "своя копия генератора Dockerfile должна была исчезнуть");
    // Агентский инструмент больше не собирает деплой сам.
    const body = toolBody(mainSrc, "ycDeploy", "ycContainer");
    assert.ok(body.length > 0, "тело инструмента ycDeploy не найдено");
    assert.ok(body.includes("runCloudDeploy("), "инструмент агента вызывает движок");
    assert.ok(!body.includes("docker build"), "инструмент агента не собирает образ сам");
    // Состояние проекта подмешивается в ответ про облако.
    assert.ok(mainSrc.includes("function cloudDeployBrief("));
    assert.ok(mainSrc.includes("async function deployBrowserAudit("), "движок проверяет выкаченную страницу браузером");
    assert.ok(mainSrc.includes("browserAudit: deployBrowserAudit"), "проверка передаётся движку");

    const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    for (const m of ["deployState", "deployRun", "deployRollback", "deployHealth"]) {
      assert.ok(preloadSrc.includes(m + ":"), "preload должен отдавать " + m);
    }

    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes('id="sp-deploy"') && html.includes('data-sp="deploy"'), "вкладка панели деплоя");
    assert.ok(html.includes('src="deploy-panel.js"') && html.includes('href="deploy-panel.css"'));
    assert.ok(html.includes('id="rail-deploy"') && html.includes('id="btn-toggle-deploy"'));

    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    assert.ok(uiFile("side-panel.js").includes("DeployPanel.open("), "панель подключается при открытии вкладки");
    assert.ok(uiFile("chat-events.js").includes('case "deploy_stage"') && uiFile("chat-events.js").includes('case "deploy_done"'), "стадии деплоя доходят до панели");
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ── Вынесенный мост деплоя ──────────────────────────────────────────────────
// Мост переехал из main.js в deploy-ipc.js (1.5.75). Проверяем главное, ради чего
// он вообще существует: код выхода берётся у ПРОЦЕССА, а не угадывается по словам
// в выводе, ввод уходит через stdin (токен не виден в списке процессов), а окно и
// отправитель событий читаются живыми, а не копией.
async function testDeployIpc() {
  const { registerDeployIpc } = require(path.join(ROOT, "src", "deploy-ipc.js"));
  const { execFile } = require("child_process");
  const mainSrc = mainOnlySrc(); // проверяем: в main.js каналов больше нет
  const ipcSrc = fs.readFileSync(path.join(ROOT, "src", "deploy-ipc.js"), "utf8");

  const build = (extra) => {
    const handlers = new Map();
    const api = registerDeployIpc(Object.assign({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      path,
      fs,
      execFile,
      browserTools: { auditPage: async () => ({ ok: true, status: 200 }) },
      cloudState: { readState: () => ({ deployments: [], current: {}, infrastructure: {}, project: {} }) },
      deployRecipes: { detectProject: () => ({ kind: "vite", label: "Vite", port: 3000, healthPaths: ["/"], warnings: [], hasDockerfile: false }) },
      createDeployEngine: () => ({ deploy: async () => ({ ok: true, stages: [] }), rollback: async () => ({ ok: true }), healthCheck: async () => ({ ok: true }) }),
      yandexCloud: { slugify: (s) => s },
      ycCosts: require(path.join(ROOT, "src", "yc-costs.js")),
      audit: { record() {} },
      // Оболочка-заглушка: команда исполняется настоящим Node — важен ЕЁ код выхода.
      commandEnv: () => process.env,
      loadSettings: () => ({ workDir: ROOT }),
      agentWorkDir: () => ROOT,
      stripAnsi: (s) => s,
      resolveShell: (cmd) => ({ shell: process.execPath, args: ["-e", cmd] }),
      findProgram: () => process.execPath,
      ycConfig: () => ({ oauth: "t", folderId: "f" }),
      ycRequireAuth: () => {},
      getEmit: () => null,
      getWindow: () => null,
    }, extra || {}));
    return { api, handlers };
  };

  await test("деплой-мост: в main.js каналов больше нет, модуль отдаёт запуск и сводку", () => {
    for (const ch of ["deploy:state", "deploy:run", "deploy:rollback", "deploy:health", "yc:deploy"]) {
      assert.ok(!mainSrc.includes('ipcMain.handle("' + ch + '"'), "канал остался в main.js: " + ch);
      assert.ok(ipcSrc.includes('ipcMain.handle("' + ch + '"'), "канал не найден в deploy-ipc.js: " + ch);
    }
    assert.ok(/\(\{ runCloudDeploy, cloudDeployBrief \}\) = registerDeployIpc/, "main.js не берёт функции из моста");
    assert.ok(!/^async function runCloudDeploy\(/m.test(mainSrc), "runCloudDeploy остался в main.js");
    assert.ok(mainSrc.includes('require("./deploy-ipc.js")'), "main.js не подключает модуль");
    const { api } = build();
    assert.strictEqual(typeof api.runCloudDeploy, "function", "мост отдаёт запуск деплоя");
    assert.strictEqual(typeof api.cloudDeployBrief, "function", "мост отдаёт сводку состояния");
    assert.strictEqual(typeof api.runCapture, "function", "мост отдаёт запуск команды");
  });

  await test("деплой-мост: код выхода берётся у процесса, а не из текста вывода", async () => {
    const { api } = build();
    const ok = await api.runCapture("process.stdout.write('Successfully built'); process.exit(0)", ROOT, 8000);
    assert.strictEqual(ok.code, 0, "успешная команда: код 0");
    assert.ok(ok.out.includes("Successfully built"), "вывод сохранён");
    // Главное: «error» в выводе при коде 0 — это НЕ провал.
    const lyingOk = await api.runCapture("process.stdout.write('error: не ошибка'); process.exit(0)", ROOT, 8000);
    assert.strictEqual(lyingOk.code, 0, "слово error в выводе не делает команду упавшей");
    const bad = await api.runCapture("process.exit(3)", ROOT, 8000);
    assert.strictEqual(bad.code, 3, "настоящий код выхода пробрасывается");
    const killed = await api.runCapture("setTimeout(() => {}, 5000)", ROOT, 400);
    assert.strictEqual(killed.code, 124, "таймаут — код 124, как у timeout(1)");
  });

  await test("деплой-мост: секрет уходит через stdin, а не в аргументах", async () => {
    const { api } = build();
    const r = await api.runCapture(
      'process.stdin.resume(); process.stdin.on("data", (d) => { process.stdout.write("получено:" + d.toString().trim()); process.exit(0); });',
      ROOT,
      8000,
      { input: "iam-token-value" }
    );
    assert.strictEqual(r.code, 0, "команда с вводом завершилась");
    assert.ok(r.out.includes("получено:iam-token-value"), "ввод дошёл до процесса: " + r.out);
  });

  await test("деплой-мост: события и окно читаются живыми, сводка не выдумывает", async () => {
    const events = [];
    const { api, handlers } = build({ getEmit: () => (ev) => events.push(ev) });
    const emit = api.deployEmitter();
    emit({ type: "stage", id: "build", label: "Сборка", status: "ok", detail: "", ms: 5 });
    emit({ type: "done", ok: true, url: "https://x", number: 3, rolledBack: true, rolledBackTo: 2 });
    assert.ok(events.some((e) => e.type === "deploy_stage" && e.stage.label === "Сборка"), "стадия ушла в панель");
    const done = events.find((e) => e.type === "deploy_done");
    assert.ok(done && done.rolledBack === true && done.rolledBackTo === 2, "итог сообщает об откате");
    assert.ok(events.some((e) => e.type === "yc_step"), "текстовая строка стадии тоже уходит");
    // Проверка страницы не роняет деплой, если браузер не запустился.
    const { api: api2 } = build({ browserTools: { auditPage: async () => { throw new Error("нет браузера"); } } });
    const audit = await api2.deployBrowserAudit("https://x");
    assert.strictEqual(audit.ok, false, "ошибка браузера — не провал деплоя, а причина");
    assert.ok(/нет браузера/.test(audit.error), "причина названа: " + audit.error);
    // Пустое состояние — пустая сводка, без выдуманных строк.
    assert.strictEqual(api.cloudDeployBrief(ROOT), "", "нет деплоев — нет сводки");
    const { api: api3 } = build({
      cloudState: { readState: () => ({ deployments: [{ id: "d1" }], current: { number: 2, status: "ok", url: "https://x" }, lastHealthy: { id: "d0", number: 1 }, infrastructure: { container: { id: "c1" } } }) },
    });
    const brief = api3.cloudDeployBrief(ROOT);
    assert.ok(brief.includes("#2") && brief.includes("https://x"), "сводка называет текущий выкат: " + brief.split("\n").join(" | "));
    assert.ok(brief.includes("#1"), "сводка называет прошлую рабочую версию");
  });
}

// ── E2E настоящего облака (scripts/live-yc-real.js, 1.5.97) ──────────────────
// Подменённое облако проверяет ЛОГИКУ движка, но не реальность: права IAM,
// статус операции, схема ответа и формат параметра ревизии ломаются только на
// настоящем API. Прогон против настоящего каталога в песочнице не сделать (нужен
// токен и деньги), поэтому проверяется ровно то, что проверяется кодом: права на
// запуск, совпадение имён с движком, уборка и то, что «страница отвечает»
// подтверждается МАРКЕРОМ версии, а не просто кодом 200.
async function testRealE2E() {
  const live = require(path.join(ROOT, "scripts", "live-yc-real.js"));

  await test("E2E облака: запуск только по явному разрешению, план называет ресурсы", () => {
    assert.strictEqual(live.wantsRealRun([], {}), false, "без флага прогон начинается — это трата денег без спроса");
    assert.strictEqual(live.wantsRealRun([], { AI_AGENT_YC_REAL: "0" }), false, "«0» принято за согласие");
    assert.strictEqual(live.wantsRealRun(["--yes"], {}), true, "--yes не считается согласием");
    assert.strictEqual(live.wantsRealRun([], { AI_AGENT_YC_REAL: "1" }), true, "AI_AGENT_YC_REAL=1 не считается согласием");
    assert.strictEqual(live.keepResources({ YC_REAL_KEEP: "1" }), true, "YC_REAL_KEEP не читается — уборку не отключить");
    const plan = live.planText("e2e-20260916-101530", "b1g2");
    for (const what of ["контейнер", "реестр", "Lockbox", "сервисный аккаунт", "удаляет"]) {
      assert.ok(plan.includes(what), "в плане не сказано про «" + what + "»:\n" + plan);
    }
    assert.ok(plan.includes("b1g2"), "в плане не назван каталог");
  });

  await test("E2E облака: имена ресурсов совпадают с именами движка деплоя", () => {
    const engineSrc = fs.readFileSync(path.join(ROOT, "src", "deploy-engine.js"), "utf8");
    const n = live.namesFor("E2E-20260916-101530");
    assert.strictEqual(n.slug, "e2e-20260916-101530", "slug приводится не так, как движок: " + n.slug);
    assert.strictEqual(n.container, n.slug, "контейнер назван иначе, чем slug: " + n.container);
    assert.strictEqual(n.registry, n.slug + "-registry", "реестр назван не так: " + n.registry);
    assert.strictEqual(n.secret, "app-" + n.slug + "-env", "секрет назван не так: " + n.secret);
    assert.strictEqual(n.serviceAccount, "sa-" + n.slug, "сервисный аккаунт назван не так: " + n.serviceAccount);
    // Сверка с движком по тексту кода: если он переименует ресурсы, уборка E2E
    // искала бы не то имя и оставила бы ресурсы в каталоге пользователя.
    assert.ok(engineSrc.includes('ensureRegistry(oauth, folderId, slug + "-registry")'), "движок называет реестр иначе — поправь namesFor в live-yc-real.js");
    assert.ok(engineSrc.includes('"app-" + slug + "-env"'), "движок называет секрет иначе — поправь namesFor в live-yc-real.js");
    assert.ok(engineSrc.includes('"sa-" + slug'), "движок называет сервисный аккаунт иначе — поправь namesFor в live-yc-real.js");
    assert.ok(engineSrc.includes("ensureContainer(oauth, folderId, slug)"), "движок называет контейнер иначе — поправь namesFor в live-yc-real.js");
  });

  await test("E2E облака: уборка удаляет всё, образы раньше реестра, провал не мешает остальным", async () => {
    const calls = [];
    const yc = {
      deleteResource: async (_t, key, id) => {
        calls.push("delete:" + key + ":" + id);
        if (key === "lockbox") throw new Error("нет прав на удаление секрета");
      },
      listRegistryImages: async () => {
        calls.push("listImages");
        return [{ id: "img1" }, { id: "img2" }];
      },
      deleteRegistryImage: async (_t, id) => calls.push("deleteImage:" + id),
    };
    const left = await live.cleanup(yc, "tok", { containerId: "cont1", registryId: "cr1", secretId: "sec1", serviceAccountId: "sa1" });
    const at = (s) => calls.findIndex((c) => c.startsWith(s));
    assert.ok(at("delete:serverlessContainers") >= 0, "контейнер не удалён: " + calls.join(" "));
    assert.ok(at("deleteImage:img1") >= 0 && at("deleteImage:img2") >= 0, "образы не удалены: " + calls.join(" "));
    assert.ok(at("delete:containerRegistry") > at("deleteImage:img2"), "реестр удалён раньше образов — облако так не даст: " + calls.join(" "));
    assert.ok(at("delete:iam") >= 0, "сервисный аккаунт не удалён: " + calls.join(" "));
    assert.strictEqual(left.length, 1, "провал одного шага уборки посчитан неверно: " + JSON.stringify(left));
    assert.ok(/секрет|lockbox/i.test(left[0]), "в остатках не назван неудалённый секрет: " + left[0]);
    // Ничего не создано — убирать нечего: ни вызовов, ни жалоб.
    const empty = [];
    const yc2 = { deleteResource: async () => empty.push("x"), listRegistryImages: async () => [], deleteRegistryImage: async () => {} };
    const left2 = await live.cleanup(yc2, "tok", {});
    assert.deepStrictEqual(left2, [], "пустая уборка пожаловалась: " + JSON.stringify(left2));
    assert.deepStrictEqual(empty, [], "пустая уборка что-то удаляла");
  });

  await test("E2E облака: адрес подтверждается маркером версии, а не просто «200»", async () => {
    let n = 0;
    const late = async () => {
      n++;
      return { status: 200, text: async () => (n >= 3 ? "наша страница E2E-MARK-1-1" : "страница без маркера") };
    };
    const r1 = await live.httpCheck("http://x/", "E2E-MARK-1-1", { fetch: late, tries: 5, delayMs: 0 });
    assert.ok(r1.ok && r1.marker, "маркер не найден: " + JSON.stringify(r1));
    assert.strictEqual(n, 3, "проверка не подождала готовности страницы: попыток " + n);

    let m = 0;
    const noMarker = async () => {
      m++;
      return { status: 200, text: async () => "чужая версия" };
    };
    const r2 = await live.httpCheck("http://x/", "E2E-MARK-1-1", { fetch: noMarker, tries: 4, delayMs: 0 });
    assert.strictEqual(r2.ok, true, "200 должен считаться ответом");
    assert.strictEqual(r2.marker, false, "чужой маркер принят за свой — откат выглядел бы успешным");
    assert.strictEqual(m, 4, "попытки исчерпаны не полностью: " + m);

    let k = 0;
    const err = async () => {
      k++;
      return { status: 500, text: async () => "boom" };
    };
    const r3 = await live.httpCheck("http://x/", "E2E-MARK-1-1", { fetch: err, tries: 2, delayMs: 0 });
    assert.strictEqual(r3.ok, false, "500 принят за живую страницу");
    assert.strictEqual(k, 2, "проверка не повторилась: " + k);
  });

  await test("E2E облака: прогон контейнер → ревизия → откат и требует настоящей смены версии", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-flow-"));
    const calls = [];
    let current = 0; // какая версия сейчас отвечает по адресу
    const engine = {
      deploy: async (_dir, opts) => {
        calls.push({ m: "deploy", secrets: opts.secrets });
        current = calls.filter((c) => c.m === "deploy").length;
        return {
          ok: true,
          url: "https://e2e.test/app",
          revisionId: "rev" + current,
          containerId: "cont1",
          secretId: "sec1",
          secretVersionId: "ver" + current,
          secretKeys: ["E2E_SECRET"],
          warnings: current === 1 ? ["первое замечание"] : [],
          stages: [{ id: "check", status: "ok" }, { id: "revision", status: "ok" }],
        };
      },
      rollback: async (_dir, opts) => {
        calls.push({ m: "rollback", toRevision: opts.toRevision });
        current = 1;
        return { ok: true, revisionId: opts.toRevision, url: "https://e2e.test/app", stages: [] };
      },
    };
    const fetchImpl = async () => ({
      status: 200,
      text: async () => (current === 1 ? "страница E2E-MARK-1-1" : "страница E2E-MARK-1-2"),
    });
    const yc = { findRegistry: async () => ({ id: "cr1" }), findServiceAccount: async () => ({ id: "sa1" }) };
    const r = await live.runFlow({ engine, yandex: yc, oauth: "tok", folderId: "f1", dir, appName: "e2e-1", stamp: "1", fetch: fetchImpl });

    assert.strictEqual(calls.filter((c) => c.m === "deploy").length, 2, "должно быть два выката — иначе откатывать некуда");
    assert.strictEqual(calls[2] && calls[2].m, "rollback", "откат не идёт последним шагом: " + calls.map((c) => c.m).join(","));
    assert.strictEqual(calls[2].toRevision, "rev1", "откат не на первую ревизию, а на " + calls[2].toRevision);
    assert.ok(r.deploy1.ok && r.deploy2.ok, "выкаты не прошли: " + JSON.stringify([r.deploy1 && r.deploy1.error, r.deploy2 && r.deploy2.error]));
    assert.ok(r.http1.marker && r.http2.marker, "адрес не подтвердил версии: " + JSON.stringify([r.http1, r.http2]));
    assert.ok(r.rollback.ok && r.httpAfterRollback && r.httpAfterRollback.marker, "после отката версия не вернулась: " + JSON.stringify(r.httpAfterRollback));
    assert.strictEqual(r.resources.containerId, "cont1", "контейнер не запомнен для уборки");
    assert.strictEqual(r.resources.registryId, "cr1", "реестр не найден по имени движка — уборка его пропустит");
    assert.strictEqual(r.resources.serviceAccountId, "sa1", "сервисный аккаунт не найден — уборка его пропустит");
    assert.ok(r.warnings.some((w) => /первое замечание/.test(w)), "замечания движка потеряны: " + r.warnings.join(" | "));
    assert.ok(calls[0].secrets && calls[0].secrets.E2E_SECRET, "секрет не уехал в выкат — стадия Lockbox не проверяется");

    // Провал первого выката: вторую ревизию не выкатываем и не притворяемся, что всё хорошо.
    const bad = [];
    const engine2 = {
      deploy: async () => {
        bad.push("deploy");
        return { ok: false, error: "нет прав на каталог", stages: [] };
      },
      rollback: async () => {
        bad.push("rollback");
        return { ok: true };
      },
    };
    const r2 = await live.runFlow({ engine: engine2, yandex: yc, oauth: "tok", folderId: "f1", dir, appName: "e2e-1", stamp: "1", fetch: fetchImpl });
    assert.strictEqual(bad.length, 1, "после провала выката прогон продолжился: " + bad.join(","));
    assert.strictEqual(r2.deploy2, null, "вторая ревизия выкатывалась после провала первой");
    assert.ok(!r2.deploy1.ok && /нет прав/.test(r2.deploy1.error), "ошибка первого выката потеряна");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
}

// ── Приёмка production: сломанное не уезжает в прод (1.5.97) ─────────────────
// Раньше падение тестов проекта было замечанием, а проверка страницы браузером —
// необязательной. Для прода это неверно: туда уезжало заведомо сломанное
// состояние. Теперь решение принимает движок — и оно проверяется здесь ЖИВЫМ
// прогоном конвейера на подставных Docker и облаке: до настоящего облака дело не
// доходит, потому что проверяем именно решение остановиться.
async function testProductionGate() {
  const engineMod = require(path.join(ROOT, "src", "deploy-engine.js"));

  function makeProject() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prod-gate-"));
    fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true }); // зависимости «уже стоят»
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "gate", scripts: { test: "node -e \"process.exit(1)\"" } }, null, 2)
    );
    fs.writeFileSync(path.join(dir, "server.js"), "require('http').createServer().listen(8080);\n");
    return dir;
  }

  // Подставной Docker: команды записываются, тесты «падают» (если просили).
  function makeRun(log, failTests) {
    return async (command) => {
      log.push(command);
      if (failTests !== false && /^\s*(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/.test(command)) {
        return { code: 1, out: "тест упал: ожидалось 2, получено 1" };
      }
      if (/docker --version/.test(command)) return { code: 0, out: "Docker version 27.0.0" };
      if (/^\s*docker login/.test(command)) return { code: 0, out: "Login Succeeded" };
      if (/^\s*docker build/.test(command)) return { code: 0, out: "Successfully built abc123" };
      if (/^\s*docker push/.test(command)) return { code: 0, out: "digest: sha256:deadbeef" };
      return { code: 0, out: "ok" };
    };
  }

  function makeYc() {
    return {
      slugify: (s) => String(s || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app",
      ensureRegistry: async () => ({ id: "cr1" }),
      ensureContainer: async () => ({ id: "cont1" }),
      setContainerPublicAccess: async () => ({ already: false }),
      deployContainerRevision: async () => ({ revisionId: "rev1" }),
      containerInfo: async () => ({ id: "cont1", url: "https://app.test", status: "ACTIVE" }),
      getIamToken: async () => "iam",
    };
  }

  function makeEngine(opts) {
    const o = opts || {};
    return engineMod.createDeployEngine({
      yandex: makeYc(),
      run: o.run,
      findProgram: () => ({ found: true }),
      fetch: async () => ({ status: 200 }),
      browserAudit: o.browserAudit || null,
      emit: () => {},
    });
  }

  const cloud = { oauth: "t", folderId: "f" };

  await test("приёмка production: правила остановки — чистые решения, а не догадки", () => {
    const { testsAreFatal, browserModeOf } = engineMod;
    const recipe = { testCmd: "npm test" };
    assert.strictEqual(testsAreFatal({}, recipe), true, "production по умолчанию обязан останавливать выкат");
    assert.strictEqual(testsAreFatal({ environment: "production" }, recipe), true, "production не останавливает");
    assert.strictEqual(testsAreFatal({ environment: "development" }, recipe), false, "development обязан продолжать");
    assert.strictEqual(testsAreFatal({ allowFailingTests: true }, recipe), false, "явное разрешение не действует — обхода нет");
    assert.strictEqual(testsAreFatal({ testsGate: "warn" }, recipe), false, "testsGate: warn не действует");
    assert.strictEqual(testsAreFatal({ testsGate: "block", environment: "development" }, recipe), true, "testsGate: block не действует");
    assert.strictEqual(testsAreFatal({}, { testCmd: "" }), false, "без тестов останавливать нечего");
    assert.strictEqual(browserModeOf(), "auto", "по умолчанию должен быть auto");
    assert.strictEqual(browserModeOf({ browserCheck: "OFF" }), "off", "регистр в browserCheck не учитывается");
    assert.strictEqual(browserModeOf({ browserCheck: "required" }), "required", "required не распознан");
    assert.strictEqual(browserModeOf({ browserCheck: "что-то" }), "auto", "мусор в browserCheck принят за режим");
  });

  await test("приёмка production: выкат встаёт ДО сборки образа, обход работает явно", async () => {
    const dir = makeProject();
    const log = [];
    const r = await makeEngine({ run: makeRun(log, true) }).deploy(dir, { cloud, name: "gate", saveState: false });
    assert.strictEqual(r.ok, false, "сломанные тесты не остановили выкат в production");
    assert.strictEqual(r.testsFailed, true, "остановка на тестах не помечена — панель не предложит выбор");
    assert.ok(!log.some((c) => /^\s*docker build/.test(c)), "образ всё-таки собирался: " + log.join(" | "));
    const verify = (r.stages || []).find((s) => s.id === "verify") || {};
    assert.strictEqual(verify.status, "fail", "стадия проверок не помечена провалом: " + JSON.stringify(verify));
    assert.ok(/production остановлен/.test(verify.detail || ""), "в объяснении нет причины: " + verify.detail);

    // Тот же сломанный проект, но с явным «да, я понимаю»: выкат идёт дальше сборки.
    const log2 = [];
    const r2 = await makeEngine({ run: makeRun(log2, true) }).deploy(dir, {
      cloud,
      name: "gate",
      saveState: false,
      allowFailingTests: true,
    });
    assert.ok(log2.some((c) => /^\s*docker build/.test(c)), "явное разрешение не пропустило выкат к сборке: " + log2.join(" | "));
    assert.strictEqual(r2.testsFailed, false, "testsFailed выставлен, хотя остановки не было");
    assert.ok((r2.warnings || []).some((w) => /упали/.test(w)), "правда о тестах потерялась: " + JSON.stringify(r2.warnings));

    // Разработка: то же падение — только замечание, выкат продолжается.
    const log3 = [];
    const r3 = await makeEngine({ run: makeRun(log3, true) }).deploy(dir, {
      cloud,
      name: "gate",
      saveState: false,
      environment: "development",
    });
    assert.ok(log3.some((c) => /^\s*docker build/.test(c)), "в development выкат остановился: " + log3.join(" | "));
    assert.strictEqual(r3.testsFailed, false, "в development выставлен признак остановки");
    assert.ok((r3.warnings || []).some((w) => /упали/.test(w)), "в development не сказано про упавшие тесты");
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  await test("проверка страницы: auto / off / required ведут себя по-разному", async () => {
    const dir = makeProject();
    const run = makeRun([], false);
    const okAudit = async () => ({
      ok: true,
      status: 200,
      info: { textLen: 120, title: "Гейт", rootChildren: 3, h1: ["Гейт"] },
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      url: "https://app.test",
    });
    const brokenAudit = async () => ({
      ok: true,
      status: 200,
      info: { textLen: 0, title: "", rootChildren: 0, h1: [] },
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      url: "https://app.test",
    });
    const deadBrowser = async () => ({ ok: false, error: "браузер не запустился" });

    // auto, браузера нет: выкат проходит, но с замечанием.
    const auto = await makeEngine({ run }).deploy(dir, { cloud, name: "gate", saveState: false });
    assert.strictEqual(auto.ok, true, "auto без браузера не должен валить выкат: " + auto.error);
    assert.ok((auto.warnings || []).some((w) => /браузер/.test(w)), "о непроверенной странице не сказано: " + JSON.stringify(auto.warnings));

    // off: проверки нет — и замечания нет (не делаем вид, что проверили).
    const off = await makeEngine({ run }).deploy(dir, { cloud, name: "gate", saveState: false, browserCheck: "off" });
    assert.strictEqual(off.ok, true, "off сломал выкат: " + off.error);
    assert.strictEqual(off.browserCheck && off.browserCheck.level, "off", "режим off не отмечен в результате: " + JSON.stringify(off.browserCheck));
    assert.ok(!(off.warnings || []).some((w) => /браузер/i.test(w)), "off всё равно ругается на браузер: " + JSON.stringify(off.warnings));

    // required, браузера нет: выкат не принимается.
    const req = await makeEngine({ run }).deploy(dir, { cloud, name: "gate", saveState: false, browserCheck: "required" });
    assert.strictEqual(req.ok, false, "required пропустил выкат без проверки страницы");
    assert.ok(/обязательн/i.test(req.error || ""), "причина отказа не названа: " + req.error);

    // auto + браузер не поднялся: замечание, а не провал — это ограничение машины.
    const soft = await makeEngine({ run, browserAudit: deadBrowser }).deploy(dir, { cloud, name: "gate", saveState: false });
    assert.strictEqual(soft.ok, true, "недоступный браузер в auto сломал выкат: " + soft.error);
    assert.ok((soft.warnings || []).some((w) => /не состоялась/.test(w)), "о несостоявшейся проверке не сказано: " + JSON.stringify(soft.warnings));

    // Белый экран останавливает выкат в любом режиме, кроме off — это и есть цель.
    const bad = await makeEngine({ run, browserAudit: brokenAudit }).deploy(dir, { cloud, name: "gate", saveState: false });
    assert.strictEqual(bad.ok, false, "белый экран не остановил выкат");
    assert.ok(/пуст|белый экран/i.test(bad.error || ""), "про белый экран не сказано: " + bad.error);

    // Здоровая страница: проверка проходит и её результат сохранён.
    const good = await makeEngine({ run, browserAudit: okAudit }).deploy(dir, { cloud, name: "gate", saveState: false });
    assert.strictEqual(good.ok, true, "здоровая страница не прошла: " + good.error);
    assert.strictEqual(good.browserCheck && good.browserCheck.ok, true, "результат проверки не сохранён: " + JSON.stringify(good.browserCheck));
    assert.strictEqual(good.browserMode, "auto", "режим проверки не отдан наружу: " + good.browserMode);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  await test("приёмка production: панель предлагает выбор, а мост его пропускает", () => {
    const panel = fs.readFileSync(path.join(ROOT, "src", "renderer", "deploy-panel.js"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "src", "renderer", "deploy-panel.css"), "utf8");
    const ipc = fs.readFileSync(path.join(ROOT, "src", "deploy-ipc.js"), "utf8");
    assert.ok(panel.includes("canOverrideTests"), "панель не знает про остановку на тестах");
    assert.ok(panel.includes("allowFailingTests: true"), "нет явного продолжения после упавших тестов");
    assert.ok(/тесты упали/i.test(panel), "в кнопке не сказано, почему спрашивают");
    assert.ok(/dp-override/.test(css), "кнопка выбора не оформлена");
    assert.ok(ipc.includes("testsFailed: !!res.testsFailed"), "мост не передаёт признак остановки в окно");
    assert.ok(ipc.includes("allowFailingTests: o.allowFailingTests"), "мост не пропускает явное разрешение");
    assert.ok(ipc.includes("browserCheck: o.browserCheck"), "мост не пропускает режим проверки страницы");
    assert.ok(ipc.includes("environment: o.environment"), "мост не пропускает окружение выката");
  });
}

module.exports = {
  testDeploy,
  testDeployIpc,
  testProductionGate,
  testRealE2E,
};

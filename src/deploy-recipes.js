"use strict";
// Рецепты сборки и упаковки проекта в контейнер.
//
// Зачем модуль: агент раньше каждый раз выводил Dockerfile заново, и результат
// зависел от настроения модели. Здесь распознаётся тип проекта и для него
// берётся заранее выверенный рецепт: команды установки, сборки и запуска, порт,
// пути проверки здоровья, многоэтапный Dockerfile и .dockerignore.
//
// Модуль читает файлы проекта и считает, но ничего не пишет: запись Dockerfile
// и .dockerignore — на стороне движка деплоя.

const fs = require("fs");
const path = require("path");

const NODE_KINDS = {
  next: { label: "Next.js", port: 3000, health: ["/", "/api/health", "/health"] },
  nuxt: { label: "Nuxt", port: 3000, health: ["/", "/health"] },
  vite: { label: "Vite / React", port: 8080, health: ["/", "/health"] },
  cra: { label: "Create React App", port: 8080, health: ["/", "/health"] },
  "node-server": { label: "Node-сервер", port: 8080, health: ["/health", "/healthz", "/api/health", "/"] },
  node: { label: "Node.js", port: 8080, health: ["/health", "/"] },
  python: { label: "Python", port: 8080, health: ["/health", "/healthz", "/api/health", "/"] },
  go: { label: "Go", port: 8080, health: ["/health", "/healthz", "/"] },
  static: { label: "Статический сайт", port: 8080, health: ["/"] },
  unknown: { label: "Не определён", port: 8080, health: ["/"] },
};

// Версии рантаймов фиксируем: «latest» ломает сборки через месяц.
const GO_IMAGE = "golang:1.22-alpine";

function has(dir, name) {
  try {
    return fs.existsSync(path.join(dir, name));
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file, limit) {
  try {
    return fs.readFileSync(file, "utf8").slice(0, limit || 200000);
  } catch {
    return "";
  }
}

// Пакетный менеджер по lock-файлу: от него зависят и локальные проверки, и образ.
function detectPackageManager(dir) {
  if (has(dir, "bun.lockb") || has(dir, "bun.lock")) return "bun";
  if (has(dir, "pnpm-lock.yaml")) return "pnpm";
  if (has(dir, "yarn.lock")) return "yarn";
  return "npm";
}

function installCommandFor(pm) {
  if (pm === "pnpm") return "pnpm install --frozen-lockfile";
  if (pm === "yarn") return "yarn install --frozen-lockfile";
  if (pm === "bun") return "bun install --frozen-lockfile";
  // npm ci требует package-lock.json — без него падает, поэтому с запасным вариантом.
  return "npm ci --no-audit --no-fund || npm install --no-audit --no-fund";
}

function runCommandFor(pm, script) {
  if (pm === "pnpm") return "pnpm run " + script;
  if (pm === "yarn") return "yarn run " + script;
  if (pm === "bun") return "bun run " + script;
  return "npm run " + script;
}

// Пакетные менеджеры, кроме npm, надо поставить внутрь образа.
function pmSetupLines(pm) {
  if (pm === "pnpm") return ["RUN corepack enable && (corepack prepare --activate || true)"];
  if (pm === "yarn") return ["RUN corepack enable && (corepack prepare --activate || true)"];
  if (pm === "bun") return ["RUN npm install -g bun"];
  return [];
}

function nodeVersionOf(pkg) {
  const m = String(((pkg && pkg.engines) || {}).node || "").match(/(\d+)/);
  if (m) {
    const major = parseInt(m[1], 10);
    if (major >= 18 && major <= 24) return major;
  }
  return 20;
}

function pythonVersionOf(dir) {
  const txt = readText(path.join(dir, "runtime.txt"), 200) + "\n" + readText(path.join(dir, "pyproject.toml"), 20000);
  const m = txt.match(/python[-\s]?(3\.\d+)/i);
  return m ? m[1] : "3.12";
}

function pythonModule(dir) {
  for (const name of ["main", "app", "server", "manage", "run"]) {
    if (has(dir, name + ".py")) return name;
  }
  return "main";
}

function pythonEntry(dir) {
  for (const c of ["main.py", "app.py", "server.py", "run.py", "manage.py"]) {
    if (has(dir, c)) return c;
  }
  return "main.py";
}

function pythonStack(reqText) {
  const t = String(reqText || "").toLowerCase();
  return {
    fastapi: /\bfastapi\b/.test(t),
    flask: /\bflask\b/.test(t),
    django: /\bdjango\b/.test(t),
    uvicorn: /\buvicorn\b/.test(t),
    gunicorn: /\bgunicorn\b/.test(t),
    streamlit: /\bstreamlit\b/.test(t),
  };
}

// Папка сборки Vite: по умолчанию dist, но её переопределяют в конфиге.
function viteOutDir(dir) {
  const conf = ["vite.config.js", "vite.config.mjs", "vite.config.ts", "vite.config.cjs"]
    .map((f) => readText(path.join(dir, f), 20000))
    .join("\n");
  const m = conf.match(/outDir\s*:\s*["'`]([^"'`]+)["'`]/);
  return m ? m[1].replace(/^\.\//, "").replace(/\/+$/, "") : "dist";
}

function guessNodeEntry(dir) {
  for (const name of ["server.js", "index.js", "app.js", "src/server.js", "src/index.js"]) {
    if (has(dir, name)) return name;
  }
  return "";
}

// Определяет тип проекта по файлам. Ничего не пишет на диск.
function detectProject(dir) {
  const warnings = [];
  const abs = path.resolve(dir);
  const pkg = readJson(path.join(abs, "package.json"));
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  const scripts = (pkg && pkg.scripts) || {};

  let kind = "unknown";
  if (pkg) {
    if (deps.next) kind = "next";
    else if (deps.nuxt) kind = "nuxt";
    else if (deps.vite || deps["@vitejs/plugin-react"] || deps["@vitejs/plugin-vue"]) kind = "vite";
    else if (deps["react-scripts"]) kind = "cra";
    else if (deps.express || deps.fastify || deps.koa || deps.hono || deps["@nestjs/core"]) kind = "node-server";
    else kind = scripts.start || has(abs, "server.js") ? "node-server" : "node";
  } else if (has(abs, "go.mod")) {
    kind = "go";
  } else if (has(abs, "requirements.txt") || has(abs, "pyproject.toml") || has(abs, "Pipfile") || has(abs, "app.py") || has(abs, "main.py")) {
    kind = "python";
  } else if (has(abs, "index.html")) {
    kind = "static";
  }

  const meta = NODE_KINDS[kind] || NODE_KINDS.unknown;
  const recipe = {
    kind,
    label: meta.label,
    dir: abs,
    port: meta.port,
    healthPaths: meta.health.slice(),
    packageManager: pkg ? detectPackageManager(abs) : "",
    installCmd: "",
    buildCmd: "",
    testCmd: "",
    startCmd: "",
    outputDir: "",
    entry: "",
    hasDockerfile: has(abs, "Dockerfile"),
    hasEnvFile: has(abs, ".env"),
    warnings,
  };

  if (pkg) {
    const pm = recipe.packageManager;
    recipe.nodeVersion = nodeVersionOf(pkg);
    recipe.installCmd = installCommandFor(pm);
    recipe.buildCmd = scripts.build ? runCommandFor(pm, "build") : "";
    recipe.testCmd = scripts.test ? runCommandFor(pm, "test") : "";
    recipe.startCmd = scripts.start ? runCommandFor(pm, "start") : "";
    recipe.scripts = Object.keys(scripts);

    if (kind === "next") {
      recipe.outputDir = ".next";
      if (!scripts.build) warnings.push("В package.json нет скрипта build — Next.js не соберётся.");
    } else if (kind === "nuxt") {
      recipe.outputDir = ".output";
      if (!scripts.build) warnings.push("В package.json нет скрипта build — Nuxt не соберётся.");
    } else if (kind === "vite" || kind === "cra") {
      recipe.outputDir = kind === "vite" ? viteOutDir(abs) : "build";
      recipe.startCmd = ""; // статику раздаёт nginx внутри образа
      if (!scripts.build) warnings.push("Нет скрипта build — собранной статики для раздачи не будет.");
    } else if (!recipe.startCmd) {
      recipe.entry = guessNodeEntry(abs);
      recipe.startCmd = recipe.entry ? "node " + recipe.entry : "";
      if (!recipe.startCmd) warnings.push("Не нашёл точку входа: нет скрипта start и файлов server.js / index.js — нужен свой Dockerfile.");
    }
  } else if (kind === "python") {
    const req = readText(path.join(abs, "requirements.txt"), 20000) || readText(path.join(abs, "pyproject.toml"), 20000);
    const stack = pythonStack(req);
    recipe.pythonVersion = pythonVersionOf(abs);
    recipe.stack = stack;
    recipe.hasRequirements = has(abs, "requirements.txt");
    recipe.hasPyproject = has(abs, "pyproject.toml");
    recipe.hasPipfile = has(abs, "Pipfile");
    recipe.installCmd = recipe.hasRequirements
      ? "pip install --no-cache-dir -r requirements.txt"
      : "pip install --no-cache-dir .";
    recipe.testCmd = has(abs, "tests") ? "python -m pytest -q" : "";
    const mod = pythonModule(abs);
    if (stack.django) recipe.startCmd = "gunicorn --bind 0.0.0.0:$PORT " + mod + ".wsgi:application";
    else if (stack.fastapi || stack.uvicorn) recipe.startCmd = "uvicorn " + mod + ":app --host 0.0.0.0 --port $PORT";
    else if (stack.flask) recipe.startCmd = "gunicorn --bind 0.0.0.0:$PORT " + mod + ":app";
    else if (stack.streamlit) recipe.startCmd = "streamlit run " + pythonEntry(abs) + " --server.port $PORT --server.address 0.0.0.0";
    else {
      recipe.entry = pythonEntry(abs);
      recipe.startCmd = "python " + recipe.entry;
      warnings.push("В зависимостях нет веб-сервера (fastapi/flask/django) — скрипт должен сам слушать порт из $PORT.");
    }
  } else if (kind === "go") {
    recipe.installCmd = "go mod download";
    recipe.buildCmd = "go build -o /out/app .";
    recipe.startCmd = "/app/app";
  } else if (kind === "static") {
    recipe.outputDir = ".";
    recipe.startCmd = "";
  } else {
    warnings.push("Не смог определить тип проекта. Создай в папке проекта свой Dockerfile — деплой возьмёт его.");
  }

  if (recipe.hasEnvFile) {
    warnings.push("В проекте есть .env — он НЕ попадает в образ. Переменные окружения задай в деплое (env), иначе контейнер их не увидит.");
  }
  if (recipe.kind !== "unknown" && !recipe.installCmd && !pkg && kind !== "static") {
    warnings.push("Не понял, как ставить зависимости — проверь Dockerfile.");
  }
  return recipe;
}

// Многоэтапный Dockerfile под тип проекта. Статику раздаёт nginx со слушателем
// на $PORT: Serverless Containers передаёт порт переменной окружения.
function dockerfileFor(recipe) {
  const r = recipe || {};
  const kind = r.kind || "unknown";
  const pm = r.packageManager || "npm";
  const nodeImg = "node:" + (r.nodeVersion || 20) + "-alpine";
  const install = r.installCmd || installCommandFor(pm);
  const start = r.startCmd || "node server.js";
  const nginxConf =
    "RUN printf 'server {\\n  listen ${PORT};\\n  root /usr/share/nginx/html;\\n  index index.html;\\n  location / { try_files $uri $uri/ /index.html; }\\n}\\n' > /etc/nginx/templates/default.conf.template";

  if (kind === "next" || kind === "nuxt") {
    const run =
      kind === "nuxt"
        ? "node .output/server/index.mjs"
        : "npx next start -p ${PORT:-8080} -H 0.0.0.0";
    return [
      "FROM " + nodeImg + " AS builder",
      "WORKDIR /app",
      ...pmSetupLines(pm),
      "COPY package*.json *lock* .npmrc* ./",
      "RUN " + install,
      "COPY . .",
      "ENV NEXT_TELEMETRY_DISABLED=1",
      "RUN " + (r.buildCmd || "npm run build"),
      "",
      "FROM " + nodeImg + " AS runtime",
      "WORKDIR /app",
      "ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0",
      "COPY --from=builder /app ./",
      'CMD ["sh", "-c", "' + run + '"]',
      "",
    ].join("\n");
  }

  if (kind === "vite" || kind === "cra") {
    const out = r.outputDir || "dist";
    return [
      "FROM " + nodeImg + " AS builder",
      "WORKDIR /app",
      ...pmSetupLines(pm),
      "COPY package*.json *lock* .npmrc* ./",
      "RUN " + install,
      "COPY . .",
      "RUN " + (r.buildCmd || "npm run build"),
      "",
      "FROM nginx:alpine",
      "ENV PORT=8080",
      "COPY --from=builder /app/" + out + "/ /usr/share/nginx/html/",
      nginxConf,
      'CMD ["nginx", "-g", "daemon off;"]',
      "",
    ].join("\n");
  }

  if (kind === "static") {
    return [
      "FROM nginx:alpine",
      "ENV PORT=8080",
      "COPY . /usr/share/nginx/html/",
      nginxConf,
      'CMD ["nginx", "-g", "daemon off;"]',
      "",
    ].join("\n");
  }

  if (kind === "go") {
    return [
      "FROM " + GO_IMAGE + " AS builder",
      "WORKDIR /app",
      "COPY . .",
      "RUN go mod download && CGO_ENABLED=0 go build -o /out/app .",
      "",
      "FROM alpine:3.19",
      "ENV PORT=8080",
      "COPY --from=builder /out/app /app/app",
      'CMD ["/app/app"]',
      "",
    ].join("\n");
  }

  if (kind === "python") {
    const deps = [];
    if (r.hasRequirements) deps.push("requirements.txt");
    if (r.hasPyproject) deps.push("pyproject.toml");
    if (r.hasPipfile) deps.push("Pipfile");
    const lines = [
      "FROM python:" + (r.pythonVersion || "3.12") + "-slim",
      "WORKDIR /app",
      "ENV PYTHONUNBUFFERED=1 PORT=8080",
    ];
    if (deps.length) {
      lines.push("COPY " + deps.join(" ") + " ./", "RUN " + install);
    }
    lines.push("COPY . .", 'CMD ["sh", "-c", "' + start + '"]', "");
    return lines.join("\n");
  }

  if (kind === "node" || kind === "node-server") {
    return [
      "FROM " + nodeImg,
      "WORKDIR /app",
      ...pmSetupLines(pm),
      "ENV NODE_ENV=production PORT=8080",
      "COPY package*.json *lock* .npmrc* ./",
      "RUN " + install,
      "COPY . .",
      'CMD ["sh", "-c", "' + start + '"]',
      "",
    ].join("\n");
  }

  throw new Error("Не смог определить тип проекта для Dockerfile. Создай в папке проекта свой Dockerfile — деплой использует его.");
}

// Файлы, которые не нужны внутри образа. .env исключаем всегда: секреты
// передаются контейнеру переменными окружения, а не припекаются в образ.
const DOCKERIGNORE_ALWAYS = [
  ".git",
  ".gitignore",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".cloud",
  "ota",
  "coverage",
  ".turbo",
  "*.log",
  ".env",
  ".env.*",
  "Dockerfile*",
  ".dockerignore",
];

function dockerignoreFor(recipe) {
  const list = DOCKERIGNORE_ALWAYS.slice();
  const kind = (recipe && recipe.kind) || "";
  if (kind === "vite" || kind === "cra") list.push("dist", "build");
  if (kind === "python") list.push(".pytest_cache", "*.pyc");
  if (kind === "go") list.push("bin", "tmp");
  return list.join("\n") + "\n";
}

// Куда писать сгенерированный Dockerfile: свои файлы пользователя не трогаем.
function dockerfilePath(dir) {
  const own = path.join(dir, "Dockerfile");
  if (fs.existsSync(own)) return { path: own, own: true };
  return { path: path.join(dir, "Dockerfile.yandexcloud"), own: false };
}

// Готовит файлы для сборки: рецепт, путь к Dockerfile, признак генерации.
function prepareDockerContext(dir) {
  const recipe = detectProject(dir);
  const pick = dockerfilePath(dir);
  if (!pick.own) fs.writeFileSync(pick.path, dockerfileFor(recipe), "utf8");
  const ignore = path.join(dir, ".dockerignore");
  const ignoreWritten = !fs.existsSync(ignore);
  if (ignoreWritten) fs.writeFileSync(ignore, dockerignoreFor(recipe), "utf8");
  return { recipe, dockerfile: pick.path, generated: !pick.own, ignoreWritten };
}

module.exports = {
  detectProject,
  dockerfileFor,
  dockerignoreFor,
  dockerfilePath,
  prepareDockerContext,
  detectPackageManager,
  installCommandFor,
  pmSetupLines,
  viteOutDir,
  pythonStack,
  NODE_KINDS,
  DOCKERIGNORE_ALWAYS,
};

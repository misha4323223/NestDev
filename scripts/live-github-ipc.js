"use strict";
/* ─── Живой прогон GitHub-каналов (без окна, но с настоящей сетью и git) ──────
   Запуск: bun run test:live:github     (node scripts/live-github-ipc.js)

   Зачем. Каналы GitHub вынесены из main.js в src/github-ipc.js (этап B, часть 4).
   Ошибки здесь тихие и дорогие: список репозиториев без флага «есть ещё» тихо
   обрывается на первых ста, поиск без scope-квалификатора не видит приватные
   репозитории организаций, а вход по коду без живого события оставляет окно
   висеть на «ждём подтверждения». Логическая проверка такие вещи не ловит.

   Здесь тот же путь проверяется по-настоящему:
     • main.js грузится в Node с поддельным electron (окна в песочнице нет) —
       значит, каналы регистрирует НАСТОЯЩИЙ модуль, с живыми настройками;
     • запросы к api.github.com и github.com идут по-настоящему — на локальный
       HTTP-сервер (подмена хоста), поэтому проверяются и заголовки авторизации,
       и параметры пагинации, и разбор настоящих ответов;
     • клонирование и публикация работают с НАСТОЯЩИМ git: репозиторий клонируется
       на диск, публикация делает настоящий push в настоящий bare-репозиторий,
       после чего ветка и файлы проверяются через git ls-tree;
     • вход по коду проходит настоящие паузы опроса (interval из ответа сервера). */

const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "live-gh-userData-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "live-gh-work-"));
const TOKEN = "live-token-1";
const TOKEN_2 = "live-token-2";

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✅ " : "  ❌ ") + msg);
  if (!cond) failures++;
};

const git = (cwd, args) => String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// ── Настоящие репозитории: откуда клонируем и куда выгружаем ────────────────
const srcRepo = path.join(work, "источник");
fs.mkdirSync(srcRepo, { recursive: true });
fs.writeFileSync(path.join(srcRepo, "readme.md"), "# проект\n");
git(srcRepo, ["init", "-b", "main"]);
git(srcRepo, ["-c", "user.name=Тест", "-c", "user.email=t@t.local", "add", "-A"]);
git(srcRepo, ["-c", "user.name=Тест", "-c", "user.email=t@t.local", "commit", "-m", "первый"]);
const bareName = "выгрузка.git";
git(work, ["init", "--bare", bareName]);
const bareRepo = path.join(work, bareName);

// ── Локальный сервер вместо GitHub: те же пути, настоящие заголовки ─────────
const seen = [];
let deviceStage = 0;
const ghRepo = (name, owner) => ({
  name: name,
  owner: { login: owner },
  full_name: owner + "/" + name,
  clone_url: owner === "me" && name === "proj" ? srcRepo : bareRepo,
  private: false,
  default_branch: "main",
  language: "JavaScript",
  updated_at: "2026-05-01T00:00:00Z",
});

function route(method, url) {
  const p = url.split("?")[0];
  if (method === "POST" && p === "/gh/login/device/code") {
    return { status: 200, body: JSON.stringify({ device_code: "dev-live", user_code: "LIVE-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }) };
  }
  if (method === "POST" && p === "/gh/login/oauth/access_token") {
    deviceStage++;
    return deviceStage === 1
      ? { status: 200, body: JSON.stringify({ error: "authorization_pending" }) }
      : { status: 200, body: JSON.stringify({ access_token: TOKEN_2 }) };
  }
  if (method === "GET" && p === "/api/user") {
    return { status: 200, body: JSON.stringify({ login: "live-user", avatar_url: "https://avatar/live.png" }) };
  }
  if (method === "GET" && p === "/api/user/orgs") {
    return { status: 200, body: JSON.stringify([{ login: "acme" }]) };
  }
  if (method === "GET" && p === "/api/user/repos") {
    const page = Number(new URL(url, "http://x").searchParams.get("page") || 1);
    const list = page === 1 ? Array.from({ length: 100 }, (_, i) => ghRepo("repo" + i, "me")) : [ghRepo("последний", "me")];
    return { status: 200, body: JSON.stringify(list) };
  }
  if (method === "GET" && p === "/api/search/repositories") {
    const q = String(new URL(url, "http://x").searchParams.get("q") || "");
    if (q.indexOf("user:live-user") >= 0) return { status: 200, body: JSON.stringify({ items: [ghRepo("proj", "me")] }) };
    if (q.indexOf("org:acme") >= 0) return { status: 200, body: JSON.stringify({ items: [ghRepo("lib", "acme")] }) };
    return { status: 200, body: JSON.stringify({ items: [] }) };
  }
  if (method === "GET" && p === "/api/repos/me/proj") {
    return { status: 200, body: JSON.stringify(ghRepo("proj", "me")) };
  }
  if (method === "POST" && p === "/api/user/repos") {
    return { status: 201, body: JSON.stringify({ html_url: "https://github.com/live-user/live-publish", clone_url: bareRepo }) };
  }
  if (method === "PATCH" && p.indexOf("/api/repos/") === 0) {
    return { status: 200, body: JSON.stringify({}) };
  }
  return { status: 404, body: JSON.stringify({ message: "Not Found: " + p }) };
}

const startServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const r = route(req.method, req.url);
        res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8" });
        res.end(r.body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

let net = null;

// main.js берём как есть, подделываем только то, чего в Node нет.
const handlers = new Map();
const stub = (name) => {
  const f = function () { return stub(name + "()"); };
  return new Proxy(f, {
    get(t, k) { if (k === "then") return undefined; return stub(name + "." + String(k)); },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
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
        getVersion: () => "1.5.153",
        setName: () => {},
        commandLine: { appendSwitch: () => {} },
      },
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: () => {} },
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
  return origin.apply(this, arguments);
};
process.on("unhandledRejection", () => {});

(async () => {
  net = await startServer();
  // Настоящий fetch, но к GitHub — на локальный сервер: заголовки, тела, методы
  // и ответы проходят по-настоящему, виртуально только имя хоста.
  const realFetch = global.fetch;
  global.fetch = (url, init) =>
    realFetch(
      String(url)
        .replace(/^https:\/\/api\.github\.com/, "http://127.0.0.1:" + net.port + "/api")
        .replace(/^https:\/\/github\.com/, "http://127.0.0.1:" + net.port + "/gh"),
      init
    );

  require(path.join(ROOT, "src", "main.js"));
  console.log("Живой прогон GitHub-каналов (main.js без окна, локальный сервер вместо api.github.com)");
  await new Promise((r) => setTimeout(r, 300));

  const CHANNELS = ["github:user", "github:repos", "github:selectRepo", "github:pickRepo", "github:selectedRepo",
    "github:unselectRepo", "github:disconnect", "github:deviceStart", "github:deviceCancel", "github:publish"];
  const missing = CHANNELS.filter((c) => !handlers.has(c));
  ok(missing.length === 0, "все 10 каналов GitHub зарегистрированы настоящим main.js" + (missing.length ? ": нет " + missing.join(", ") : ""));
  if (missing.length) {
    console.log("\nИтог: прогон невозможен без каналов");
    process.exit(1);
  }

  const settingsGet = handlers.get("settings:get");
  const settingsSet = handlers.get("settings:set");
  await settingsSet(null, { workingDir: work, githubToken: TOKEN, githubLogin: "live-user", githubClientId: "live-client-id" });

  console.log("\n[1] Список репозиториев и пагинация (настоящий HTTP)");
  const list = await handlers.get("github:repos")(null, { page: 1 });
  ok(list.ok === true && list.repos.length === 100, "первая страница пришла целиком: " + (list.ok ? list.repos.length + " шт." : JSON.stringify(list)));
  ok(list.hasMore === true, "на 100 репозиториях окно узнало, что есть ещё страница (иначе список обрывается молча)");
  const firstReq = seen.find((s) => s.url.indexOf("/api/user/repos") === 0);
  ok(!!firstReq, "запрос списка дошёл до сервера");
  if (firstReq) {
    ok(firstReq.headers.authorization === "Bearer " + TOKEN, "пришёл настоящий заголовок авторизации: " + firstReq.headers.authorization);
    ok(/AI-Developer-Agent/.test(firstReq.headers["user-agent"] || ""), "пришёл User-Agent (GitHub без него отвечает 403): " + firstReq.headers["user-agent"]);
    ok(/per_page=100/.test(firstReq.url), "в запросе есть per_page=100 (иначе список обрезан на 30): " + firstReq.url);
    ok(/affiliation=owner,collaborator,organization_member/.test(firstReq.url), "в запросе есть свои, коллаборации и организации: " + firstReq.url);
  }
  const second = await handlers.get("github:repos")(null, { page: 2 });
  const pageReq = seen.filter((s) => s.url.indexOf("/api/user/repos") === 0).pop();
  ok(/page=2/.test(pageReq.url), "номер страницы доехал до GitHub: " + pageReq.url);
  ok(second.hasMore === false && second.repos.length === 1, "неполная страница закрывает список: " + JSON.stringify({ hasMore: second.hasMore, n: second.repos.length }));
  const mapped = second.repos[0];
  ok(mapped.slug === "me/последний" && mapped.name === "последний" && mapped.owner === "me" && mapped.default_branch === "main" && !!mapped.url,
    "страница размечена в поля окна (slug/name/owner/ветка/адрес): " + JSON.stringify({ slug: mapped.slug, owner: mapped.owner, branch: mapped.default_branch }));
  ok(mapped.own === false, "«свой» репозиторий — тот, чей владелец совпадает с логином, а здесь владелец me: " + mapped.own);

  console.log("\n[2] Поиск по имени: аккаунт + организации, без повторов");
  const before = seen.filter((s) => s.url.indexOf("/api/search/repositories") === 0).length;
  const found = await handlers.get("github:repos")(null, { query: "pro", page: 5 });
  const searchReqs = seen.filter((s) => s.url.indexOf("/api/search/repositories") === 0).slice(before);
  ok(found.ok === true && found.page === 1, "поиск вернул одну страницу, а не пятую: " + JSON.stringify({ ok: found.ok, page: found.page }));
  ok(searchReqs.length === 2, "поиск ушёл и по аккаунту, и по организации: запросов " + searchReqs.length);
  ok(searchReqs.some((s) => decodeURIComponent(s.url).indexOf("user:live-user") >= 0) && searchReqs.some((s) => decodeURIComponent(s.url).indexOf("org:acme") >= 0),
    "поиск ушёл со scope-квалификаторами (без них приватные репозитории организации не находятся): " + searchReqs.map((s) => decodeURIComponent(s.url).slice(0, 70)).join(" | "));
  ok(found.repos.length === 2 && found.repos.some((r) => r.slug === "acme/lib") && found.repos.some((r) => r.slug === "me/proj"),
    "результаты аккаунта и организации слиты в один список без повторов: " + JSON.stringify(found.repos.map((r) => r.slug)));
  const beforeCached = seen.filter((s) => s.url.indexOf("/api/search/repositories") === 0).length;
  const again = await handlers.get("github:repos")(null, { query: "pro" });
  const afterCached = seen.filter((s) => s.url.indexOf("/api/search/repositories") === 0).length;
  ok(afterCached === beforeCached, "повторный тот же поиск в сеть не пошёл (кэш 45 с работает): +" + (afterCached - beforeCached));
  ok(JSON.stringify(again.repos.map((r) => r.slug)) === JSON.stringify(found.repos.map((r) => r.slug)), "из кэша вернулся тот же список");

  console.log("\n[3] Профиль: логин и аватар ложатся в настоящие настройки");
  await settingsSet(null, { githubLogin: "" });
  const me = await handlers.get("github:user")();
  ok(me.ok === true && me.login === "live-user", "профиль получен: " + JSON.stringify(me));
  const afterProfile = await settingsGet(null);
  ok(afterProfile.githubLogin === "live-user", "логин записался в настройки: " + afterProfile.githubLogin);
  ok(afterProfile.githubAvatarUrl === "https://avatar/live.png", "аватар записался в настройки: " + afterProfile.githubAvatarUrl);

  console.log("\n[4] Выбор репозитория: настоящий git clone на диск");
  const cloneInto = fs.mkdtempSync(path.join(os.tmpdir(), "live-gh-clone-"));
  const picked = await handlers.get("github:selectRepo")(null, "me/proj", cloneInto);
  ok(picked.ok === true, "клонирование прошло: " + JSON.stringify(picked));
  if (picked.ok) {
    ok(picked.cloned === true, "первый клон помечен новым клоном");
    ok(fs.existsSync(path.join(picked.dir, "readme.md")), "файлы проекта лежат на диске: " + picked.dir);
    const branch = git(picked.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    ok(branch === "main", "клонирована ветка main: " + branch);
    const s = await settingsGet(null);
    ok(s.githubRepoSlug === "me/proj" && s.githubRepoDir === picked.dir, "активный репозиторий сохранён: " + JSON.stringify({ slug: s.githubRepoSlug, dir: s.githubRepoDir }));
    const active = await handlers.get("github:selectedRepo")();
    ok(active.dir === picked.dir && active.slug === "me/proj", "окно увидит активный репозиторий той же папкой: " + JSON.stringify(active));
    const reClone = await handlers.get("github:selectRepo")(null, "me/proj", cloneInto);
    ok(reClone.ok === true && reClone.cloned === false, "повторная выгрузка в ту же папку берёт готовый клон: " + JSON.stringify(reClone));
  }

  console.log("\n[5] Публикация: настоящий git init + commit + push");
  const projectDir = path.join(work, "новый-проект");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "index.html"), "<h1>привет</h1>\n");
  const pub = await handlers.get("github:publish")(null, { dir: projectDir, name: "live-publish", message: "Первый" });
  ok(pub.ok === true, "публикация прошла: " + JSON.stringify(pub));
  if (pub.ok) {
    ok(pub.slug === "live-user/live-publish", "slug не тот: " + pub.slug);
    const tree = git(work, ["--git-dir", bareRepo, "ls-tree", "-r", "--name-only", "main"]);
    ok(/index.html/.test(tree), "на GitHub (bare-репозиторий) лежит выгруженный файл: " + tree.trim());
    const log = git(work, ["--git-dir", bareRepo, "log", "--oneline", "main"]);
    ok(/Первый/.test(log), "коммит с сообщением доехал до удалённого репозитория: " + log.trim());
    const patch = seen.find((s) => s.method === "PATCH" && s.url.indexOf("/api/repos/") === 0);
    ok(!!patch && /"default_branch":"main"/.test(patch.body), "ветка по умолчанию переключена на выгруженную (иначе репозиторий откроется пустым): " + (patch ? patch.body : "PATCH не отправлен"));
    const s = await settingsGet(null);
    ok(s.githubRepoSlug === "live-user/live-publish" && s.githubRepoDir === projectDir, "панель проекта переключена на опубликованный репозиторий: " + JSON.stringify({ slug: s.githubRepoSlug, dir: s.githubRepoDir }));
    const empty = await handlers.get("github:publish")(null, { dir: projectDir, name: "live-publish" });
    ok(empty.ok === false && /Push/.test(empty.error || ""), "повторная публикация существующей папки отклонена с подсказкой про Push: " + String(empty.error).slice(0, 90));
  }

  console.log("\n[6] Вход по коду: настоящие паузы опроса");
  await settingsSet(null, { githubToken: "", githubLogin: "" });
  const started = await handlers.get("github:deviceStart")();
  ok(started.ok === true && started.user_code === "LIVE-1234", "код устройства получен и отдан окну: " + JSON.stringify(started));
  const twice = await handlers.get("github:deviceStart")();
  ok(twice.ok === false, "второй вход отклонён, пока идёт первый (иначе два окна кода путаются): " + JSON.stringify(twice));
  // Первый опрос через 1 с, он вернёт authorization_pending, следующий — через interval=1 с.
  await new Promise((r) => setTimeout(r, 3000));
  const afterDevice = await settingsGet(null);
  ok(afterDevice.githubToken === TOKEN_2, "токен доехал до настроек за время ожидания (повторный опрос после authorization_pending): " + (afterDevice.githubToken ? "есть" : "пусто"));
  ok(afterDevice.githubLogin === "live-user", "логин после входа записан в настройки: " + afterDevice.githubLogin);
  const polls = seen.filter((s) => s.url.indexOf("/gh/login/oauth/access_token") === 0).length;
  ok(polls === 2, "опрос повторился после authorization_pending: запросов " + polls);
  const cancelled = handlers.get("github:deviceCancel")();
  ok(cancelled === true, "отмена входа отвечает окну");
  const pollsAfterCancel = seen.filter((s) => s.url.indexOf("/gh/login/oauth/access_token") === 0).length;
  await new Promise((r) => setTimeout(r, 1500));
  const pollsIdle = seen.filter((s) => s.url.indexOf("/gh/login/oauth/access_token") === 0).length;
  ok(pollsIdle === pollsAfterCancel, "после отмены опрос остановлен: +" + (pollsIdle - pollsAfterCancel));

  console.log("\n[7] Отключение и снятие выбора");
  await handlers.get("github:unselectRepo")();
  const unsel = await settingsGet(null);
  ok(unsel.githubRepoSlug === "" && unsel.githubRepoDir === "", "выбор репозитория снят: " + JSON.stringify({ slug: unsel.githubRepoSlug, dir: unsel.githubRepoDir }));
  await handlers.get("github:disconnect")();
  const off = await settingsGet(null);
  ok(off.githubToken === "" && off.githubLogin === "" && off.githubAvatarUrl === "", "подключение снято (токен, логин, аватар): " + JSON.stringify({ t: !!off.githubToken, l: off.githubLogin }));
  ok(off.workingDir === work, "отключение сбросило рабочую папку: " + off.workingDir);

  net.server.close();
  console.log("\nИтог: " + (failures ? failures + " провал(ов)" : "все проверки прошли"));
  process.exit(failures ? 1 : 0);
})();

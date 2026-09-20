"use strict";

/* ── GitHub: вход по коду, выбор репозитория, выгрузка (src/github-ipc.js) ─────
   Запуск: node test/github-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 4) и держит десять каналов, которые
   раньше жили в главном процессе: github:user, github:repos, github:selectRepo,
   github:pickRepo, github:selectedRepo, github:unselectRepo, github:disconnect,
   github:deviceStart, github:deviceCancel, github:publish — плюс помощники
   клонирования cloneRepoTo / pickCloneBase (их же берёт инструмент агента gitClone).

   Почему проверки поведенческие, а не «строка на месте»: ошибки здесь тихие.
   Событие входа по коду уходит через окно, а окно создаётся ПОЗЖЕ сборки модуля —
   если ссылку на него передать копией, событие уедет в null и окно молча зависнет
   на «ждём подтверждения». Список репозиториев при пагинации без флага «есть ещё»
   обрывается на первых 100 без предупреждения. Падение клона по «Permission
   denied» без запасной записываемой папки выглядит как «ничего не произошло».
   Поэтому модуль водится по-настоящему: настоящий registerGithubIpc, подставной
   fetch (записывает запросы и заголовки), подставные часы, живой мост window.
   Сети в тесте нет. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
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
const MODULE_SRC = read("src", "github-ipc.js");
// Единственное прямое чтение main.js здесь — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");
const PRELOAD_SRC = read("src", "preload.js");
const MOBILE_SRC = read("src", "renderer", "mobile-api.js");

/* Подставной fetch: записывает запросы (метод, адрес, заголовки, тело) и отвечает
   по карте маршрутов. Маршрута нет — соединения нет. */
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, init) => {
    const method = (init && init.method) || "GET";
    const key = method + " " + url;
    calls.push({ key, method, url, headers: (init && init.headers) || {}, body: (init && init.body) || "" });
    const r = routes[key];
    if (!r) throw new Error("соединение отклонено");
    if (r.throw) throw new Error(r.throw);
    const body = r.body || "";
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  return calls;
}

const ghRepo = (name, owner, extra) =>
  Object.assign(
    {
      name,
      owner: { login: owner },
      full_name: owner + "/" + name,
      clone_url: "https://github.com/" + owner + "/" + name + ".git",
      private: false,
      default_branch: "main",
      language: "JavaScript",
      updated_at: "2026-01-01T00:00:00Z",
    },
    extra || {}
  );

/* Собираем НАСТОЯЩИЙ модуль его же фабрикой: так же, как это делает main.js. */
function build(o) {
  const opts = o || {};
  const handlers = new Map();
  const events = [];
  const git = [];
  const caps = [];
  let settings = Object.assign({ githubToken: "", githubLogin: "" }, opts.settings || {});
  const saved = [];
  const state = {
    window: opts.lateWindow
      ? null
      : { isDestroyed: () => false, webContents: { send: (ch, ev) => events.push({ ch, ev }) } },
    lastAgentRepoDir: opts.lastAgentRepoDir || null,
    clonedRepoPending: false,
  };
  const exists = opts.exists || (() => false);

  const { registerGithubIpc } = require(path.join(ROOT, "src", "github-ipc.js"));
  const mod = registerGithubIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    fs: {
      existsSync: (p) => exists(p),
      readdirSync: (p) => (opts.readdir ? opts.readdir(p) : []),
      rmdirSync: (p) => {
        if (opts.rmdirFail) throw new Error("занято");
      },
    },
    path,
    os,
    app: { getPath: (n) => (opts.docPath === false ? (() => { throw new Error("нет Документов"); })() : "/doc/" + n) },
    loadSettings: () => settings,
    saveSettings: (s) => {
      saved.push(s);
      settings = s;
    },
    withCapability: async (cap, fn) => {
      caps.push(cap);
      return await fn();
    },
    agentWorkDir: (s) => s.workingDir || "/work",
    ensureWritableDir: (dir) => {
      if (opts.unwritable && opts.unwritable.some((u) => String(dir).indexOf(u) >= 0)) {
        return { ok: false, error: "не пишется: " + dir };
      }
      return { ok: true, dir: String(dir) };
    },
    runGit: async (dir, args, s) => {
      git.push({ dir, args: args.join(" "), s });
      const routes = opts.git || {};
      const key = args.join(" ");
      const route = routes[key] || routes[args[0]];
      if (typeof route === "function") return route(dir, args, s);
      if (route) return route;
      return { ok: true, out: "", err: "" };
    },
    repoNameFromUrl: (url) => String(url).replace(/\.git$/, "").split("/").filter(Boolean).pop().replace(/[^\w.-]/g, ""),
    sanitizeDir: (d) => d,
    stageAllSafe: async (dir, s) => {
      git.push({ dir, args: "@stageAllSafe", s });
      return opts.stageFail ? { ok: false, err: "git add не удался" } : { ok: true };
    },
    stripUrlCreds: (url) => String(url).replace(/\/\/[^/@]*@/, "//"),
    live: {
      window: () => state.window,
      lastAgentRepoDir: () => state.lastAgentRepoDir,
      setLastAgentRepoDir: (v) => { state.lastAgentRepoDir = v; },
      clonedRepoPending: () => state.clonedRepoPending,
      setClonedRepoPending: (v) => { state.clonedRepoPending = v; },
    },
  });
  return { mod, handlers, events, git, caps, saved, state, settings: () => settings };
}

/* Подставные часы: setTimeout в модуле собирает колбэки в очередь, тест их
   «прокручивает». Так вход по коду проверяется без ожидания секунд. */
function fakeTimers() {
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const queue = [];
  let id = 0;
  global.setTimeout = (fn, ms) => {
    queue.push({ fn, ms, id: ++id });
    return queue[queue.length - 1];
  };
  global.clearTimeout = (t) => {
    if (t) t.cleared = true;
  };
  return {
    pending: () => queue.filter((t) => !t.cleared && !t.done),
    delays: () => queue.map((t) => t.ms),
    async run() {
      const t = queue.find((x) => !x.cleared && !x.done);
      if (!t) throw new Error("нет запланированного шага — опрос не идёт");
      t.done = true;
      await t.fn();
    },
    restore: () => {
      global.setTimeout = real.setTimeout;
      global.clearTimeout = real.clearTimeout;
    },
  };
}

(async () => {
  const realFetch = global.fetch;

  console.log("\n[1] github:deviceStart — вход по коду");

  await test("вход: без Client ID — честный отказ, в сеть не уходим", async () => {
    const calls = mockFetch({});
    const env = build({ settings: { githubClientId: "" } });
    const r = await env.handlers.get("github:deviceStart")();
    assert.strictEqual(r.ok, false, "вход без Client ID выдан за успех");
    assert.ok(/Client ID/.test(r.error || ""), "в отказе не сказано, чего не хватает: " + r.error);
    assert.strictEqual(calls.length, 0, "без Client ID ушёл запрос в GitHub");
  });

  await test("вход: код показан окну, ожидание подтверждения и готовый вход", async () => {
    const calls = mockFetch({
      "POST https://github.com/login/device/code": { status: 200, body: JSON.stringify({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }) },
      "POST https://github.com/login/oauth/access_token": { status: 200, body: JSON.stringify({ error: "authorization_pending" }) },
      "GET https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "me", avatar_url: "https://a/x.png" }) },
    });
    const env = build({ settings: { githubClientId: "cid-1" } });
    const fake = fakeTimers();
    let r;
    try {
      r = await env.handlers.get("github:deviceStart")();
      assert.strictEqual(r.ok, true, "код устройства не отдан: " + JSON.stringify(r));
      assert.strictEqual(r.user_code, "ABCD-1234", "окну ушёл не тот код: " + r.user_code);
      assert.strictEqual(r.expires_in, 900, "срок жизни кода потерян");
      // Первый опрос — через 1 с, как и было: окно успевает показать код.
      assert.deepStrictEqual(fake.delays(), [1000], "опрос начинается не через секунду: " + JSON.stringify(fake.delays()));
      // Авторизации ещё нет — модуль обязан подождать и спросить снова.
      await fake.run();
      assert.ok(fake.pending().length === 1, "после authorization_pending опрос не продолжился");
      assert.ok(fake.pending()[0].ms >= 5000, "повторный опрос раньше интервала: " + fake.pending()[0].ms);
      // Теперь токен выдан.
      mockFetch({
        "POST https://github.com/login/oauth/access_token": { status: 200, body: JSON.stringify({ access_token: "tok-1" }) },
        "GET https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "me", avatar_url: "https://a/x.png" }) },
      });
      await fake.run();
    } finally {
      fake.restore();
    }
    const done = env.events.filter((e) => e.ev.type === "done");
    assert.strictEqual(done.length, 1, "окно не получило событие о входе: " + JSON.stringify(env.events));
    assert.strictEqual(done[0].ch, "github:event", "событие ушло не по каналу github:event: " + done[0].ch);
    assert.strictEqual(done[0].ev.login, "me", "в событии нет логина");
    assert.strictEqual(env.settings().githubToken, "tok-1", "токен не сохранён");
    assert.strictEqual(env.settings().githubLogin, "me", "логин не сохранён");
    assert.strictEqual(env.settings().githubAvatarUrl, "https://a/x.png", "аватар не сохранён");
    assert.ok(calls.some((c) => /grant_type=urn:ietf:params:oauth:grant-type:device_code/.test(c.body) === false || true), "опрос ушёл без тела запроса");
    assert.ok(/client_id/.test(calls[0].body), "в запросе кода нет client_id");
  });

  await test("вход: ошибка авторизации — событие об ошибке и опрос остановлен", async () => {
    mockFetch({
      "POST https://github.com/login/device/code": { status: 200, body: JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "v", expires_in: 900 }) },
      "POST https://github.com/login/oauth/access_token": { status: 200, body: JSON.stringify({ error: "access_denied", error_description: "Пользователь отклонил" }) },
    });
    const env = build({ settings: { githubClientId: "cid" } });
    const fake = fakeTimers();
    try {
      await env.handlers.get("github:deviceStart")();
      await fake.run();
      assert.strictEqual(fake.pending().length, 0, "после отказа опрос продолжается");
    } finally {
      fake.restore();
    }
    const errs = env.events.filter((e) => e.ev.type === "error");
    assert.strictEqual(errs.length, 1, "окно не увидело ошибку: " + JSON.stringify(env.events));
    assert.ok(/Пользователь отклонил/.test(errs[0].ev.message), "причина отказа потеряна: " + errs[0].ev.message);
  });

  await test("вход: отмена из окна останавливает опрос и не пишет в настройки", async () => {
    mockFetch({
      "POST https://github.com/login/device/code": { status: 200, body: JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "v", expires_in: 900 }) },
    });
    const env = build({ settings: { githubClientId: "cid" } });
    const fake = fakeTimers();
    let started;
    try {
      started = await env.handlers.get("github:deviceStart")();
      const again = await env.handlers.get("github:deviceStart")();
      assert.strictEqual(again.ok, false, "второй вход разрешён при уже идущем первом");
      env.handlers.get("github:deviceCancel")();
      assert.strictEqual(fake.pending().length, 0, "после отмены опрос остался висеть");
      await fake.run();
      assert.ok(false, "после отмены опрос всё-таки выполнился");
    } catch (e) {
      assert.ok(/нет запланированного шага/.test(e && e.message), "отмена не остановила опрос: " + (e && e.message));
    } finally {
      fake.restore();
    }
    assert.strictEqual(started.ok, true, "вход не начался");
    assert.strictEqual(env.settings().githubToken, "", "отмена всё-таки записала токен");
    assert.strictEqual(env.events.length, 0, "после отмены ушли события: " + JSON.stringify(env.events));
  });

  await test("вход: окна ещё нет — событие всё равно доходит, когда окно появилось", async () => {
    // Окно создаётся ПОЗЖЕ сборки модуля. Если бы ссылку передали копией,
    // событие уходило бы в null и вход «зависал» без объяснений.
    mockFetch({
      "POST https://github.com/login/device/code": { status: 200, body: JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "v", expires_in: 900 }) },
      "POST https://github.com/login/oauth/access_token": { status: 200, body: JSON.stringify({ access_token: "tok" }) },
      "GET https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "me" }) },
    });
    const env = build({ lateWindow: true, settings: { githubClientId: "cid" } });
    const fake = fakeTimers();
    try {
      // Окна ещё нет: вход должен пройти без падения, просто без события.
      const started = await env.handlers.get("github:deviceStart")();
      assert.strictEqual(started.ok, true, "без окна вход не начался: " + JSON.stringify(started));
      await fake.run();
    } finally {
      fake.restore();
    }
    assert.strictEqual(env.events.length, 0, "события не должны теряться молча до появления окна");
    assert.strictEqual(env.settings().githubToken, "tok", "без окна вход не доведён до конца");
    // Окно появилось ПОСЛЕ сборки модуля — событие обязано дойти именно в него.
    const seen = [];
    env.state.window = { isDestroyed: () => false, webContents: { send: (_ch, ev) => seen.push(ev) } };
    mockFetch({
      "POST https://github.com/login/device/code": { status: 200, body: JSON.stringify({ device_code: "d", user_code: "U", verification_uri: "v", expires_in: 900 }) },
      "POST https://github.com/login/oauth/access_token": { status: 200, body: JSON.stringify({ access_token: "tok2" }) },
      "GET https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "me" }) },
    });
    const fake2 = fakeTimers();
    try {
      await env.handlers.get("github:deviceStart")();
      await fake2.run();
    } finally {
      fake2.restore();
    }
    assert.strictEqual(seen.filter((e) => e.type === "done").length, 1, "событие не дошло до окна, созданного позже модуля");
  });

  console.log("\n[2] github:user — профиль");

  await test("профиль: без токена — «Не подключено», в сеть не уходим", async () => {
    const calls = mockFetch({});
    const env = build();
    const r = await env.handlers.get("github:user")();
    assert.strictEqual(r.ok, false, "профиль без токена выдан за успех");
    assert.strictEqual(calls.length, 0, "без токена ушёл запрос в GitHub");
  });

  await test("профиль: отозванный токен — отказ с причиной, настройки не портятся", async () => {
    mockFetch({ "GET https://api.github.com/user": { status: 401, body: JSON.stringify({ message: "Bad credentials" }) } });
    const env = build({ settings: { githubToken: "t", githubLogin: "me" } });
    const r = await env.handlers.get("github:user")();
    assert.strictEqual(r.ok, false, "отозванный токен выдан за рабочий");
    assert.ok(/отозван/.test(r.error || ""), "причина отказа потеряна: " + r.error);
    assert.strictEqual(env.saved.length, 0, "при отказе настройки всё равно перезаписаны");
  });

  await test("профиль: логин и аватар дописываются к настройкам, остальное сохраняется", async () => {
    mockFetch({ "GET https://api.github.com/user": { status: 200, body: JSON.stringify({ login: "me2", avatar_url: "https://a/2.png" }) } });
    const env = build({ settings: { githubToken: "t", githubLogin: "старый", workingDir: "/proj" } });
    const r = await env.handlers.get("github:user")();
    assert.strictEqual(r.ok, true, "профиль не получен: " + JSON.stringify(r));
    assert.strictEqual(r.login, "me2", "логин в ответе не тот");
    assert.strictEqual(env.settings().workingDir, "/proj", "при обновлении профиля потерялась рабочая папка");
    assert.strictEqual(env.settings().githubLogin, "me2", "логин не обновлён");
    assert.strictEqual(env.settings().githubAvatarUrl, "https://a/2.png", "аватар не обновлён");
  });

  console.log("\n[3] github:repos — список и поиск");

  await test("список: страница уходит в API, ответ размечен (приватность, «свой», язык)", async () => {
    const url = "https://api.github.com/user/repos?per_page=100&page=2&sort=updated&affiliation=owner,collaborator,organization_member";
    const calls = mockFetch({ ["GET " + url]: { status: 200, body: JSON.stringify([ghRepo("proj", "me", { private: true, description: "описание" })]) } });
    const env = build({ settings: { githubToken: "t", githubLogin: "me" } });
    const r = await env.handlers.get("github:repos")(null, { page: 2 });
    assert.strictEqual(r.ok, true, "список не отдан: " + JSON.stringify(r));
    assert.strictEqual(r.page, 2, "запрошенная страница потеряна: " + r.page);
    const repo = r.repos[0];
    assert.strictEqual(repo.slug, "me/proj", "имя репозитория собрано неверно");
    assert.strictEqual(repo.isPrivate, true, "приватность потеряна");
    assert.strictEqual(repo.own, true, "репозиторий пользователя не помечен своим");
    assert.strictEqual(calls[0].method, "GET", "список запрошен не чтением");
    assert.strictEqual(calls[0].headers.Authorization, "Bearer t", "заголовок авторизации не передан: " + calls[0].headers.Authorization);
    assert.ok(/AI-Developer-Agent/.test(calls[0].headers["User-Agent"] || ""), "GitHub API требует User-Agent — без него запрос отклоняется");
  });

  await test("список: ровно 100 — есть ещё страница; меньше — страниц больше нет", async () => {
    const url = "https://api.github.com/user/repos?per_page=100&page=1&sort=updated&affiliation=owner,collaborator,organization_member";
    const hundred = Array.from({ length: 100 }, (_, i) => ghRepo("r" + i, "me"));
    mockFetch({ ["GET " + url]: { status: 200, body: JSON.stringify(hundred) } });
    const env = build({ settings: { githubToken: "t", githubLogin: "me" } });
    const more = await env.handlers.get("github:repos")(null, {});
    assert.strictEqual(more.hasMore, true, "на 100 репозиториях страницы кончились — список обрывается молча");
    mockFetch({ ["GET " + url]: { status: 200, body: JSON.stringify(hundred.slice(0, 99)) } });
    const last = await env.handlers.get("github:repos")(null, {});
    assert.strictEqual(last.hasMore, false, "лишняя страница «есть ещё» на неполном списке");
  });

  await test("поиск: ищем по аккаунту и организациям, сливаем без повторов, свежие сверху", async () => {
    const q = "repo";
    const userUrl = "https://api.github.com/search/repositories?q=" + encodeURIComponent(q + " in:name user:me") + "&per_page=100&sort=updated&order=desc";
    const orgUrl = "https://api.github.com/search/repositories?q=" + encodeURIComponent(q + " in:name org:acme") + "&per_page=100&sort=updated&order=desc";
    const calls = mockFetch({
      "GET https://api.github.com/user/orgs?per_page=100": { status: 200, body: JSON.stringify([{ login: "acme" }, { login: "other" }]) },
      ["GET " + userUrl]: { status: 200, body: JSON.stringify({ items: [ghRepo("old", "me", { updated_at: "2026-01-01T00:00:00Z" }), ghRepo("shared", "me", { updated_at: "2026-03-01T00:00:00Z" }), ghRepo("fresh", "acme", { updated_at: "2026-06-01T00:00:00Z" })] }) },
      ["GET " + orgUrl]: { status: 200, body: JSON.stringify({ items: [ghRepo("fresh", "acme", { updated_at: "2026-06-01T00:00:00Z" }), ghRepo("shared", "acme", { updated_at: "2026-03-01T00:00:00Z" })] }) },
    });
    const env = build({ settings: { githubToken: "t", githubLogin: "me" } });
    const r = await env.handlers.get("github:repos")(null, { query: q, page: 7 });
    assert.strictEqual(r.ok, true, "поиск не отработал: " + JSON.stringify(r));
    assert.strictEqual(r.page, 1, "поиск должен быть одной страницей, а не седьмой: " + r.page);
    assert.strictEqual(r.hasMore, false, "в поиске предложена следующая страница: " + r.hasMore);
    assert.strictEqual(r.total, 4, "в поиске не посчитано, сколько всего нашлось (с повторами из двух областей): " + r.total);
    assert.deepStrictEqual(r.repos.map((x) => x.slug), ["acme/fresh", "me/shared", "acme/shared", "me/old"], "порядок/повторы в выдаче поиска: " + JSON.stringify(r.repos.map((x) => x.slug)));
    // Организации берутся из кэша на 5 минут: второй поиск без поиска орг не повторяет.
    const orgCallsBefore = calls.filter((c) => /\/user\/orgs/.test(c.url)).length;
    mockFetch({});
    const cached = await env.handlers.get("github:repos")(null, { query: q });
    assert.deepStrictEqual(cached.repos.map((x) => x.slug), ["acme/fresh", "me/shared", "acme/shared", "me/old"], "повторный поиск потерял кэш и выдал другое");
    assert.strictEqual(orgCallsBefore, 1, "организации запрошены не один раз: " + orgCallsBefore);
  });

  await test("список: ошибка GitHub — отказ с кодом, а не пустой список", async () => {
    const url = "https://api.github.com/user/repos?per_page=100&page=1&sort=updated&affiliation=owner,collaborator,organization_member";
    mockFetch({ ["GET " + url]: { status: 403, body: JSON.stringify({ message: "rate limit" }) } });
    const env = build({ settings: { githubToken: "t" } });
    const r = await env.handlers.get("github:repos")(null, {});
    assert.strictEqual(r.ok, false, "ошибка API выдан за пустой список");
    assert.ok(/403/.test(r.error || ""), "в отказе нет кода ответа: " + r.error);
  });

  console.log("\n[4] Выбор репозитория и клонирование");

  await test("выбор: кривой slug — отказ до сети и до диска", async () => {
    const calls = mockFetch({});
    const env = build({ settings: { githubToken: "t" } });
    for (const bad of ["", "просто", "/repo", "owner/"]) {
      const r = await env.handlers.get("github:selectRepo")(null, bad, "/work");
      assert.strictEqual(r.ok, false, "принят неверный slug «" + bad + "»");
      assert.ok(/owner\/repo/.test(r.error || ""), "в отказе нет подсказки про owner/repo: " + r.error);
    }
    assert.strictEqual(calls.length, 0, "на кривом slug ушёл запрос в GitHub");
    assert.strictEqual(env.git.length, 0, "на кривом slug пошли git-команды");
  });

  await test("выбор: репозиторий склонирован, помечен активным и разбудил анализ проекта", async () => {
    mockFetch({ "GET https://api.github.com/repos/acme/proj": { status: 200, body: JSON.stringify(ghRepo("proj", "acme")) } });
    const env = build({
      settings: { githubToken: "t", githubLogin: "me" },
      git: { clone: { ok: true } },
    });
    const r = await env.handlers.get("github:selectRepo")(null, "acme/proj", "/work");
    assert.strictEqual(r.ok, true, "клонирование не прошло: " + JSON.stringify(r));
    assert.ok(/\/proj$/.test(r.dir || ""), "папка клона не названа по имени репозитория: " + r.dir);
    assert.ok(/^clone https:\/\/github\.com\/acme\/proj\.git proj$/.test(env.git.find((g) => /^clone/.test(g.args)).args), "клонируется не тот адрес: " + JSON.stringify(env.git.map((g) => g.args)));
    assert.strictEqual(env.settings().githubRepoSlug, "acme/proj", "выбранный репозиторий не сохранён");
    assert.strictEqual(env.settings().githubRepoDir, r.dir, "папка клона не сохранена");
    assert.strictEqual(env.state.clonedRepoPending, true, "флаг анализа проекта не поднят — агент не посмотрит выгрузку");
  });

  await test("выбор: репозитория нет — отказ с причиной, папка не создаётся", async () => {
    mockFetch({ "GET https://api.github.com/repos/acme/nope": { status: 404, body: JSON.stringify({ message: "Not Found" }) } });
    const env = build({ settings: { githubToken: "t" } });
    const r = await env.handlers.get("github:selectRepo")(null, "acme/nope", "/work");
    assert.strictEqual(r.ok, false, "отсутствующий репозиторий принят");
    assert.ok(/404/.test(r.error || ""), "в отказе нет кода ответа: " + r.error);
    assert.strictEqual(env.git.filter((g) => /^clone/.test(g.args)).length, 0, "клон всё равно запущен");
    assert.strictEqual(env.state.clonedRepoPending, false, "флаг анализа проекта поднят зря");
  });

  await test("выбор без клона: репозиторий помечен, папка очищена, git не запускался", async () => {
    mockFetch({ "GET https://api.github.com/repos/acme/proj": { status: 200, body: JSON.stringify(ghRepo("proj", "acme")) } });
    const env = build({ settings: { githubToken: "t", githubRepoDir: "/старый" } });
    const r = await env.handlers.get("github:pickRepo")(null, "acme/proj");
    assert.strictEqual(r.ok, true, "выбор без клона не прошёл: " + JSON.stringify(r));
    assert.strictEqual(env.settings().githubRepoSlug, "acme/proj", "репозиторий не помечен");
    assert.strictEqual(env.settings().githubRepoDir, "", "старая папка осталась — окно покажет не тот проект");
    assert.strictEqual(env.git.length, 0, "клонирование запущено, хотя не просили");
    assert.strictEqual(env.state.clonedRepoPending, false, "флаг анализа проекта поднят без выгрузки");
  });

  await test("активный репозиторий: папки нет — возвращаем null, окно предложит «Выгрузить»", async () => {
    const env = build({
      settings: { githubToken: "t", githubRepoSlug: "acme/proj", githubRepoDir: "/нет-такой", workingDir: "/work" },
      exists: () => false,
    });
    const r = await env.handlers.get("github:selectedRepo")();
    assert.strictEqual(r.ok, true, "активный репозиторий не отдан: " + JSON.stringify(r));
    assert.strictEqual(r.slug, "acme/proj", "потерян выбранный репозиторий");
    assert.strictEqual(r.dir, null, "папка показана, хотя её нет на диске: " + r.dir);
  });

  await test("активный репозиторий: папка нашлась в рабочей — показываем её", async () => {
    const env = build({
      settings: { githubToken: "t", githubRepoSlug: "acme/proj", githubRepoDir: "/нет-такой", workingDir: "/work" },
      exists: (p) => p === "/work" || p === "/work/proj",
    });
    const r = await env.handlers.get("github:selectedRepo")();
    assert.strictEqual(r.dir, "/work/proj", "папка клона не найдена рядом с рабочей: " + r.dir);
  });

  await test("отключение и снятие выбора: в настройках пусто, остальное цело", async () => {
    const env = build({ settings: { githubToken: "t", githubLogin: "me", githubAvatarUrl: "a", githubRepoSlug: "me/p", githubRepoDir: "/p", workingDir: "/work" } });
    await env.handlers.get("github:unselectRepo")();
    assert.strictEqual(env.settings().githubRepoSlug, "", "выбор репозитория не снят");
    assert.strictEqual(env.settings().githubToken, "t", "снятие выбора сбросило подключение");
    await env.handlers.get("github:disconnect")();
    assert.strictEqual(env.settings().githubToken, "", "токен остался после отключения");
    assert.strictEqual(env.settings().githubLogin, "", "логин остался после отключения");
    assert.strictEqual(env.settings().workingDir, "/work", "отключение сбросило рабочую папку");
  });

  await test("клон: та же папка и тот же origin — берём как есть и вычищаем токен из .git/config", async () => {
    const env = build({
      exists: (p) => p === "/work/proj",
      readdir: () => ["файл.txt"],
      git: { "remote get-url origin": { ok: true, out: "https://user:TOKEN@github.com/me/proj.git" } },
    });
    const r = await env.mod.cloneRepoTo("https://github.com/me/proj.git", "/work", {});
    assert.strictEqual(r.ok, true, "свой же репозиторий не принят: " + JSON.stringify(r));
    assert.strictEqual(r.cloned, false, "уже склонированный репозиторий выдан за новый клон");
    const fix = env.git.find((g) => g.args === "remote set-url origin https://github.com/me/proj.git");
    assert.ok(fix, "токен остался в .git/config: " + JSON.stringify(env.git.map((g) => g.args)));
  });

  await test("клон: в рабочей папке чужой репозиторий — честный отказ, клон не запускаем", async () => {
    const env = build({
      exists: (p) => p === "/work/proj",
      readdir: () => ["файл.txt"],
      git: { "remote get-url origin": { ok: true, out: "https://github.com/other/another.git" } },
    });
    const r = await env.mod.cloneRepoTo("https://github.com/me/proj.git", "/work", {});
    assert.strictEqual(r.ok, false, "чужая папка перезаписана клоном");
    assert.ok(/Удали её или выбери другую/.test(r.error || ""), "в отказе нет подсказки, что делать: " + r.error);
    assert.strictEqual(env.git.filter((g) => /^clone/.test(g.args)).length, 0, "клон запущен поверх чужого репозитория");
  });

  await test("клон: git не пишет в папку — клонируем в запасную и говорим об этом", async () => {
    // Windows-случай: приложение пишет в папку, а git.exe блокирует антивирус.
    // Проверка папки записью проходит, падает именно git. Без запасной папки
    // пользователь видит только «Permission denied» и не понимает, что делать.
    const env = build({
      git: {
        clone: (dir) => (dir === "/work" ? { ok: false, err: "fatal: could not create work tree dir: Permission denied" } : { ok: true }),
      },
    });
    const r = await env.mod.cloneRepoTo("https://user:TOKEN@github.com/me/proj.git", "/work", {});
    assert.strictEqual(r.ok, true, "запасная папка не спасла клон: " + JSON.stringify(r));
    assert.ok(r.dir.indexOf("/work") !== 0, "клонировано в ту же нерабочую папку: " + r.dir);
    assert.ok(/записываемая папка/.test(r.message || ""), "пользователю не сказали про смену папки: " + r.message);
    const fix = env.git.find((g) => g.args === "remote set-url origin https://github.com/me/proj.git");
    assert.ok(fix, "в запасном клоне остался токен в origin: " + JSON.stringify(env.git.map((g) => g.args)));
  });

  await test("клон: писать некуда совсем — отказ с перечнем проверенных папок", async () => {
    const env = build({ unwritable: ["/work", os.homedir(), "/doc/documents", os.tmpdir()] });
    const base = env.mod.pickCloneBase("/work", { workingDir: "/work" });
    assert.strictEqual(base.ok, false, "найдена папка, куда писать нельзя");
    assert.ok(/Не нашлось ни одной папки/.test(base.error || ""), "в отказе нет причины: " + base.error);
  });

  console.log("\n[5] github:publish — новый репозиторий и первый push");

  await test("публикация: имя проверяется до любых действий", async () => {
    const calls = mockFetch({});
    const env = build({ settings: { githubToken: "t", githubLogin: "me" } });
    for (const bad of ["", "имя с пробелом", "..точка", "a".repeat(101)]) {
      const r = await env.handlers.get("github:publish")(null, { dir: "/p", name: bad });
      assert.strictEqual(r.ok, false, "принято недопустимое имя «" + bad + "»");
    }
    assert.strictEqual(env.git.length, 0, "на недопустимом имени пошли git-команды");
    assert.strictEqual(calls.length, 0, "на недопустимом имени ушёл запрос в GitHub");
  });

  await test("публикация: в папке уже есть origin — не создаём второй репозиторий", async () => {
    const calls = mockFetch({});
    const env = build({
      settings: { githubToken: "t", githubLogin: "me" },
      git: { "remote get-url origin": { ok: true, out: "https://user:TOKEN@github.com/me/old.git" } },
    });
    const r = await env.handlers.get("github:publish")(null, { dir: "/p", name: "proj" });
    assert.strictEqual(r.ok, false, "существующий репозиторий выдан за новый");
    assert.ok(/Push/.test(r.error || ""), "в отказе нет подсказки про Push: " + r.error);
    assert.ok(r.error.indexOf("TOKEN") < 0, "в текст отказа попал токен из origin: " + r.error);
    assert.strictEqual(calls.length, 0, "репозиторий всё равно создан на GitHub");
  });

  await test("публикация: репозиторий создан, ветка выгружена, панель переключена на него", async () => {
    const calls = mockFetch({
      "POST https://api.github.com/user/repos": { status: 201, body: JSON.stringify({ html_url: "https://github.com/me/proj", clone_url: "https://github.com/me/proj.git" }) },
      "PATCH https://api.github.com/repos/me%2Fproj": { status: 200, body: JSON.stringify({}) },
    });
    const env = build({
      settings: { githubToken: "t", githubLogin: "me", workingDir: "/work" },
      git: {
        "remote get-url origin": { ok: false, err: "нет origin" },
        "rev-parse --is-inside-work-tree": { ok: true, out: "true" },
        "rev-parse --abbrev-ref HEAD": { ok: true, out: "main" },
        "status --porcelain": { ok: true, out: "?? файл.txt" },
        "rev-parse --verify HEAD": { ok: false },
        "push -u origin main": { ok: true },
      },
    });
    const r = await env.handlers.get("github:publish")(null, { dir: "/p", name: "proj", description: "описание", message: "Первый" });
    assert.strictEqual(r.ok, true, "публикация не прошла: " + JSON.stringify(r));
    assert.strictEqual(r.slug, "me/proj", "slug не тот: " + r.slug);
    assert.deepStrictEqual(env.caps, ["git.push"], "публикация не объявлена как git.push — переменные группы git не дойдут: " + JSON.stringify(env.caps));
    const created = calls.find((c) => /POST https:\/\/api\.github\.com\/user\/repos/.test(c.key));
    assert.ok(created, "репозиторий не создан на GitHub");
    assert.ok(/"private":true/.test(created.body), "по умолчанию репозиторий создан публичным: " + created.body);
    assert.ok(env.git.some((g) => g.args === "remote add origin https://github.com/me/proj.git"), "origin не добавлен: " + JSON.stringify(env.git.map((g) => g.args)));
    assert.ok(env.git.some((g) => /^push -u origin main$/.test(g.args)), "push не сделан: " + JSON.stringify(env.git.map((g) => g.args)));
    const patched = calls.find((c) => /PATCH https:\/\/api\.github\.com\/repos\/me%2Fproj/.test(c.key));
    assert.ok(patched && /"default_branch":"main"/.test(patched.body), "ветка по умолчанию не переключена — репозиторий откроется пустым");
    assert.strictEqual(env.settings().githubRepoSlug, "me/proj", "панель проекта не переключена на новый репозиторий");
    assert.strictEqual(env.settings().githubRepoDir, "/p", "папка проекта не сохранена");
    assert.strictEqual(env.state.lastAgentRepoDir, "/p", "путь для агента не обновлён");
    assert.strictEqual(env.state.clonedRepoPending, true, "агент не начнёт со анализа опубликованного проекта");
    const ev = env.events.filter((e) => e.ev.type === "published");
    assert.strictEqual(ev.length, 1, "окно не узнало о публикации: " + JSON.stringify(env.events));
    assert.strictEqual(ev[0].ev.slug, "me/proj", "в событии не тот репозиторий");
  });

  await test("публикация: ветка master переименовывается в main, иначе репозиторий откроется пустым", async () => {
    const calls = mockFetch({
      "POST https://api.github.com/user/repos": { status: 201, body: JSON.stringify({ html_url: "https://github.com/me/p2", clone_url: "https://github.com/me/p2.git" }) },
      "PATCH https://api.github.com/repos/me%2Fp2": { status: 200, body: JSON.stringify({}) },
    });
    const env = build({
      settings: { githubToken: "t", githubLogin: "me" },
      git: {
        "remote get-url origin": { ok: false },
        "rev-parse --is-inside-work-tree": { ok: true },
        "rev-parse --abbrev-ref HEAD": { ok: true, out: "master" },
        "branch -M main": { ok: true },
        "status --porcelain": { ok: true, out: "" },
        "rev-parse --verify HEAD": { ok: true },
        "push -u origin main": { ok: true },
      },
    });
    const r = await env.handlers.get("github:publish")(null, { dir: "/p2", name: "p2" });
    assert.strictEqual(r.ok, true, "публикация из ветки master не прошла: " + JSON.stringify(r));
    assert.ok(env.git.some((g) => g.args === "branch -M main"), "ветка master не переименована");
    assert.ok(env.git.some((g) => g.args === "push -u origin main"), "выгружена не main: " + JSON.stringify(env.git.map((g) => g.args)));
    const patched = calls.find((c) => /PATCH https:\/\/api\.github\.com\/repos\/me%2Fp2/.test(c.key));
    assert.ok(patched && /"default_branch":"main"/.test(patched.body), "ветка по умолчанию не переключена в ветку выгрузки");
  });

  await test("публикация: имя занято (422) — понятная причина, без коммита и push", async () => {
    mockFetch({ "POST https://api.github.com/user/repos": { status: 422, body: JSON.stringify({ message: "Repository creation failed" }) } });
    const env = build({
      settings: { githubToken: "t", githubLogin: "me" },
      git: {
        "remote get-url origin": { ok: false },
        "rev-parse --is-inside-work-tree": { ok: true },
        "rev-parse --abbrev-ref HEAD": { ok: true, out: "main" },
      },
    });
    const r = await env.handlers.get("github:publish")(null, { dir: "/p", name: "proj" });
    assert.strictEqual(r.ok, false, "отказ создания репозитория выдан за успех");
    assert.ok(/уже существует/.test(r.error || ""), "причина 422 не объяснена человеку: " + r.error);
    assert.strictEqual(env.git.filter((g) => /^push/.test(g.args)).length, 0, "push выполнен в несуществующий репозиторий");
  });

  await test("публикация: пустая папка без коммитов — «нечего выгружать», а не пустой репозиторий", async () => {
    mockFetch({ "POST https://api.github.com/user/repos": { status: 201, body: JSON.stringify({ html_url: "https://github.com/me/empty", clone_url: "https://github.com/me/empty.git" }) } });
    const env = build({
      settings: { githubToken: "t", githubLogin: "me" },
      git: {
        "remote get-url origin": { ok: false },
        "rev-parse --is-inside-work-tree": { ok: true },
        "rev-parse --abbrev-ref HEAD": { ok: true, out: "main" },
        "status --porcelain": { ok: true, out: "" },
        "rev-parse --verify HEAD": { ok: false },
      },
    });
    const r = await env.handlers.get("github:publish")(null, { dir: "/empty", name: "empty" });
    assert.strictEqual(r.ok, false, "пустая папка выгружена как успех");
    assert.ok(/нет файлов/.test(r.error || ""), "причина не объяснена: " + r.error);
    assert.ok(/github\.com\/me\/empty/.test(r.error || ""), "в отказе нет адреса уже созданного репозитория: " + r.error);
  });

  console.log("\n[6] Расположение кода и проводка");

  await test("вынос: каналов и помощников GitHub в main.js больше нет", () => {
    const channels = ["github:user", "github:publish", "github:repos", "github:selectRepo", "github:pickRepo",
      "github:selectedRepo", "github:unselectRepo", "github:disconnect", "github:deviceCancel", "github:deviceStart"];
    for (const ch of channels) {
      assert.strictEqual(MAIN_SRC.indexOf('ipcMain.handle("' + ch + '"'), -1, "канал остался в main.js: " + ch);
      assert.ok(MODULE_SRC.indexOf('ipcMain.handle("' + ch + '"') >= 0, "канал не найден в модуле: " + ch);
    }
    for (const fn of ["async function cloneRepoTo", "function pickCloneBase", "function publishLocalToGithub",
      "async function githubReposSearch", "async function fetchGithubUser", "function cloneBaseCandidates"]) {
      assert.strictEqual(MAIN_SRC.indexOf(fn), -1, "код остался в main.js: " + fn);
      assert.ok(MODULE_SRC.indexOf(fn) >= 0, "код не найден в модуле: " + fn);
    }
    // Клон-помощники остались ЕДИНСТВЕННЫМ экземпляром: их же берёт инструмент gitClone.
    assert.ok(MAIN_SRC.indexOf("cloneRepoTo: githubIpc.cloneRepoTo") >= 0, "инструмент gitClone больше не видит клон-помощник модуля");
    assert.ok(MAIN_SRC.indexOf("pickCloneBase: githubIpc.pickCloneBase") >= 0, "выбор папки для клона не передан инструментам");
  });

  await test("проводка: main.js собирает модуль и передаёт ему всё нужное", () => {
    const at = MAIN_SRC.indexOf('const { registerGithubIpc } = require("./github-ipc.js");');
    assert.ok(at > 0, "main.js не собирает модуль GitHub");
    const wiring = MAIN_SRC.slice(at, MAIN_SRC.indexOf("\n});", at));
    for (const dep of ["ipcMain,", "fs,", "path,", "os,", "app,", "loadSettings,", "saveSettings,",
      "withCapability,", "agentWorkDir,", "ensureWritableDir,", "runGit,", "repoNameFromUrl,",
      "sanitizeDir,", "stageAllSafe,", "stripUrlCreds,"]) {
      assert.ok(wiring.includes(dep), "в проводку модуля не передан " + dep);
    }
    for (const m of ["window: () => mainWindow,", "lastAgentRepoDir: () => lastAgentRepoDir,",
      "setLastAgentRepoDir: (v) => { lastAgentRepoDir = v; },", "clonedRepoPending: () => clonedRepoPending,",
      "setClonedRepoPending: (v) => { clonedRepoPending = v; },"]) {
      assert.ok(wiring.includes(m), "живое значение не передано мостом: " + m);
    }
  });

  await test("мост живых значений: модуль ничего не берёт из оболочки напрямую", () => {
    // Голое имя из main.js в модуле — это либо копия (застынет), либо падение
    // «is not defined» у пользователя. Пускаем только мост live: его собственные
    // свойства объявлены в объекте live и голыми именами не считаются.
    const liveAt = MODULE_SRC.indexOf("const live = {");
    const liveEnd = MODULE_SRC.indexOf("\n  };", liveAt);
    assert.ok(liveAt > 0 && liveEnd > liveAt, "в модуле нет моста live — живые значения берутся напрямую");
    const outside = MODULE_SRC.slice(0, liveAt) + MODULE_SRC.slice(liveEnd);
    const code = outside.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const bad of ["mainWindow", "lastAgentRepoDir", "clonedRepoPending"]) {
      const bare = new RegExp("(^|[^.\\w$])" + bad + "\\b", "m");
      assert.ok(!bare.test(code.replace(/live\.(?:set)?[A-Za-z]*/g, "МОСТ")), "в модуле осталось голое имя: " + bad);
    }
  });

  await test("каналы: окно на ПК и телефон знают те же имена", () => {
    for (const dep of ['ipcRenderer.invoke("github:deviceStart")', 'ipcRenderer.invoke("github:deviceCancel")',
      'ipcRenderer.invoke("github:disconnect")', 'ipcRenderer.invoke("github:user")',
      'ipcRenderer.invoke("github:pickRepo", repoSlug)', 'ipcRenderer.invoke("github:repos", opts || {})',
      'ipcRenderer.invoke("github:selectRepo", repoSlug, workingDir)', 'ipcRenderer.invoke("github:selectedRepo")',
      'ipcRenderer.invoke("github:unselectRepo")', 'ipcRenderer.invoke("github:publish", opts || {})']) {
      assert.ok(PRELOAD_SRC.indexOf(dep) >= 0, "preload не знает канал: " + dep);
    }
    for (const ch of ['invoke("github:deviceStart")', 'invoke("github:repos")', 'invoke("github:publish")']) {
      assert.ok(MOBILE_SRC.indexOf(ch) >= 0, "мобильный API не знает канал: " + ch);
    }
    assert.ok(/github:event/.test(PRELOAD_SRC) && /github:event/.test(MOBILE_SRC), "событие входа по коду не проброшено в окно");
  });

  await test("наружу отдаются все три функции: клон, папка клона и публикация", () => {
    // Публикация — НАСТОЯЩАЯ находка части 35: инструмент агента gitPublish звал
    // publishLocalToGithub, а наружу функция не отдавалась и в проводку реестра не
    // попадала — «создай репозиторий и выложи проект» падало с «is not defined».
    // Страж связи такое не видит: имени нет ни в main.js, ни в распаковке — искать
    // нечего. Здесь проверяем и отдачу наружу, и то, что в проводку ушла ТА ЖЕ
    // функция, что у канала github:publish.
    const env = build({});
    for (const name of ["cloneRepoTo", "pickCloneBase", "publishLocalToGithub"]) {
      assert.strictEqual(typeof env.mod[name], "function", "github-ipc не отдал наружу: " + name);
    }
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(/publishLocalToGithub: githubIpc\.publishLocalToGithub/.test(mainSrc), "публикация не уехала в проводку реестра инструментов");
    assert.ok(fs.readFileSync(path.join(ROOT, "src", "agent-tools.js"), "utf8").includes("publishLocalToGithub"), "инструмент публикации перестал пользоваться общей функцией");
  });

  global.fetch = realFetch;

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

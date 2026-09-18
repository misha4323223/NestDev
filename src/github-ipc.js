"use strict";

/* ─── GitHub: вход по коду, выбор репозитория, выгрузка и публикация ─────────
   Вынесено из main.js (этап B, часть 4). Здесь всё, что окно и телефон спрашивают
   про GitHub:
     • device flow (вход по коду): github:deviceStart / github:deviceCancel,
       событие github:event с кодом, адресом и итогом;
     • профиль и выбор репозитория: github:user, github:repos (с пагинацией и
       поиском), github:selectRepo / github:pickRepo / github:selectedRepo /
       github:unselectRepo, github:disconnect;
     • публикация локальной папки в новый репозиторий: github:publish.

   Клон-помощники (cloneRepoTo, pickCloneBase) отдаются наружу: их же использует
   инструмент агента gitClone, и это должны быть те же самые функции, а не копии.

   Живых значений три, поэтому они идут мостом live:
     • window — окно создаётся позже, копия «застыла» бы на null, и события
       github:event уходили бы в никуда;
     • lastAgentRepoDir и clonedRepoPending — их пишет этот модуль (после клона и
       выбора репозитория), а читают и пишут прогон агента и панель проектов. */

function registerGithubIpc(deps) {
  const {
    ipcMain,
    fs,
    path,
    os,
    app,
    loadSettings,
    saveSettings,
    withCapability,
    agentWorkDir,
    ensureWritableDir,
    runGit,
    repoNameFromUrl,
    sanitizeDir,
    stageAllSafe,
    stripUrlCreds,
  } = deps;

  // Мост живых значений: см. шапку модуля.
  const live = {
    get window() {
      return deps.live.window();
    },
    get lastAgentRepoDir() {
      return deps.live.lastAgentRepoDir();
    },
    set lastAgentRepoDir(v) {
      deps.live.setLastAgentRepoDir(v);
    },
    get clonedRepoPending() {
      return deps.live.clonedRepoPending();
    },
    set clonedRepoPending(v) {
      deps.live.setClonedRepoPending(v);
    },
  };

let githubPollTimer = null;
let githubPollActive = false;
const GITHUB_API = "https://api.github.com";

/** Клонирует URL в workersDir и возвращает путь к папке репозитория. */
async function cloneRepoTo(url, workersDir, settings) {
  const prep = ensureWritableDir(workersDir);
  if (!prep.ok) return prep;
  workersDir = prep.dir;
  const name = repoNameFromUrl(url);
  const target = path.join(workersDir, name);
  if (fs.existsSync(target)) {
    // Пустая папка (например, от прошлой неудачной попытки клонирования) — убираем и клонируем заново.
    let empty = false;
    try {
      empty = fs.readdirSync(target).length === 0;
    } catch {}
    if (empty) {
      try {
        fs.rmdirSync(target);
      } catch (e) {
        return { ok: false, error: "Папка " + target + " пустая, но не удалось её очистить: " + (e.message || String(e)) };
      }
    } else {
      const info = await runGit(target, ["remote", "get-url", "origin"], settings);
      if (info.ok) {
        const cleanOrigin = stripUrlCreds(info.out.trim());
        if (cleanOrigin === stripUrlCreds(url)) {
          // В origin мог застрять токен (клон вручную с https://user:TOKEN@...) — убираем его из .git/config.
          if (info.out.trim() !== cleanOrigin) {
            await runGit(target, ["remote", "set-url", "origin", cleanOrigin], settings);
          }
          return { ok: true, dir: target, cloned: false, message: "Репозиторий уже есть: " + target };
        }
      }
      return { ok: false, error: "В рабочей папке уже есть папка \"" + name + "\". Удали её или выбери другую рабочую папку." };
    }
  }
  const r = await runGit(workersDir, ["clone", url, name], settings);
  if (!r.ok) {
    const denied = /permission denied|отказано в доступе|could not create work tree dir|eacces/i.test(r.err);
    if (denied) {
      // Приложение пишет в папку, а git — нет (антивирус или «Контролируемый доступ к папкам»
      // Windows блокирует именно git.exe). Пробуем запасные записываемые папки.
      const mainKey = path.resolve(workersDir).toLowerCase();
      for (const cand of cloneBaseCandidates("", settings)) {
        const prep = ensureWritableDir(cand);
        if (!prep.ok) continue;
        if (path.resolve(prep.dir).toLowerCase() === mainKey) continue;
        const fbTarget = path.join(prep.dir, name);
        if (fs.existsSync(fbTarget)) continue;
        const r2 = await runGit(prep.dir, ["clone", url, name], settings);
        if (r2.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(fbTarget, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          return {
            ok: true,
            dir: fbTarget,
            cloned: true,
            message: "Клонировано: " + fbTarget + " (в рабочей папке «" + workersDir + "» git не смог создать файлы — использована записываемая папка)",
          };
        }
      }
    }
    return {
      ok: false,
      error: r.err + (denied
        ? "\n\nGit не смог создать папку репозитория в «" + workersDir + "». Папка защищена от записи " +
          "(или доступ блокирует антивирус/OneDrive). Выбери другую рабочую директорию (📁 в панели проекта) " +
          "— например C:\\Users\\<имя>\\projects — и нажми «Выгрузить» ещё раз."
        : ""),
    };
  }
  if (stripUrlCreds(url) !== url) {
    await runGit(target, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
  }
  return { ok: true, dir: target, cloned: true, message: "Клонировано: " + target };
}

function isGitHubRepoSlug(v) {
  const s = String(v || "").trim();
  return /^[\w.-]+\/[\w.-]+$/i.test(s) && !s.includes("/") === false && s.indexOf("/") > 0;
}

function githubEmit(ev) {
  if (live.window && !live.window.isDestroyed()) live.window.webContents.send("github:event", ev);
}

async function githubApiFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function fetchGithubUser(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "AI-Developer-Agent",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

ipcMain.handle("github:user", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const u = await fetchGithubUser(s.githubToken);
  if (!u) return { ok: false, error: "Не удалось получить профиль GitHub (токен мог быть отозван)" };
  const merged = { ...s, githubLogin: u.login || s.githubLogin, githubAvatarUrl: u.avatar_url || s.githubAvatarUrl };
  saveSettings(merged);
  return { ok: true, login: u.login, avatar: u.avatar_url };
});

// ── Репозитории GitHub: список >100 шт. через пагинацию, поиск — через search API ──
function mapGithubRepo(r) {
  if (!r || typeof r.name !== "string" || !r.owner || typeof r.owner.login !== "string") return null;
  const currentLogin = loadSettings().githubLogin || "";
  return {
    slug: r.owner.login + "/" + r.name,
    name: r.name,
    owner: r.owner.login,
    full_name: r.full_name || (r.owner.login + "/" + r.name),
    url: (r.clone_url || "https://github.com/" + r.owner.login + "/" + r.name + ".git"),
    description: r.description || "",
    isPrivate: r.private || false,
    default_branch: r.default_branch || "main",
    language: r.language || "",
    updated: r.updated_at || "",
    own: currentLogin === r.owner.login,
  };
}

function ghApiHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "AI-Developer-Agent",
  };
}

async function ghApiJson(url, token) {
  try {
    const res = await fetch(url, { headers: ghApiHeaders(token) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text: (text || "").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: (e && e.message) || String(e) };
  }
}

// Страница списка «мои репозитории» (аккаунт + коллаборации + организации).
async function githubReposPage(token, page) {
  const n = Math.max(1, parseInt(page, 10) || 1);
  const url = GITHUB_API + "/user/repos?per_page=100&page=" + n + "&sort=updated&affiliation=owner,collaborator,organization_member";
  const res = await ghApiJson(url, token);
  if (!res.ok) return { ok: false, error: "GitHub API " + res.status + ": " + (res.text || res.status) };
  const data = Array.isArray(res.json) ? res.json : [];
  const repos = data.map(mapGithubRepo).filter(Boolean);
  return { ok: true, repos, hasMore: repos.length === 100 };
}

let githubOrgsCache = { at: 0, list: [] };
async function githubUserOrgs(token) {
  if (Date.now() - githubOrgsCache.at < 5 * 60 * 1000) return githubOrgsCache.list;
  try {
    const res = await ghApiJson(GITHUB_API + "/user/orgs?per_page=100", token);
    if (res.ok && Array.isArray(res.json)) {
      githubOrgsCache = { at: Date.now(), list: res.json.map((o) => o && o.login).filter(Boolean) };
    }
  } catch {}
  return githubOrgsCache.list;
}

async function githubLoginFor(token) {
  const s = loadSettings();
  if (s.githubLogin) return s.githubLogin;
  const u = await fetchGithubUser(token);
  if (u && u.login) {
    try { saveSettings({ ...loadSettings(), githubLogin: u.login }); } catch {}
    return u.login;
  }
  return "";
}

// Поиск по имени: ищем параллельно по аккаунту и его организациям (приватные репозитории
// видны в поиске только со scope-квалификатором user:/org:), затем сливаем и сортируем.
const ghSearchCache = new Map(); // key: нормализованный запрос -> { at, res } (кэш 45 c)
async function githubReposSearch(token, q) {
  const key = String(q || "").trim().toLowerCase();
  const hit = ghSearchCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.res;
  const login = await githubLoginFor(token);
  const orgs = (await githubUserOrgs(token)).slice(0, 8);
  const scopes = [];
  if (login) scopes.push("user:" + login);
  for (const o of orgs) scopes.push("org:" + o);
  const collected = [];
  const jobs = scopes.map(async (scope) => {
    const url = GITHUB_API + "/search/repositories?q=" + encodeURIComponent(String(q).trim() + " in:name " + scope) +
      "&per_page=100&sort=updated&order=desc";
    const res = await ghApiJson(url, token);
    if (res.ok && res.json && Array.isArray(res.json.items)) {
      for (const it of res.json.items) collected.push(it);
    }
    return res.status;
  });
  await Promise.all(jobs);
  const seen = new Set();
  const repos = [];
  for (const it of collected) {
    const r = mapGithubRepo(it);
    if (!r || seen.has(r.slug)) continue;
    seen.add(r.slug);
    repos.push(r);
  }
  repos.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const capped = repos.slice(0, 150);
  const res = { ok: true, repos: capped, hasMore: false, total: repos.length, searched: true };
  ghSearchCache.set(key, { at: Date.now(), res });
  return res;
}

// Точный slug owner/repo — одним запросом (не зависит от списка из 100 и от принадлежности).
async function githubRepoBySlug(token, slug) {
  const res = await ghApiJson(GITHUB_API + "/repos/" + String(slug).trim(), token);
  if (!res.ok) return { ok: false, error: "Репозиторий не найден или нет к нему доступа: " + slug + " (GitHub API " + res.status + ")" };
  const r = mapGithubRepo(res.json);
  return r ? { ok: true, repo: r } : { ok: false, error: "Неожиданный ответ GitHub API" };
}

// База для клонирования: явно указанная папка (создаётся, если её ещё нет) → сохранённая
// рабочая директория → домашняя. Никогда не «теряем» клон в неожиданном месте.
// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
// Кандидаты папок для клонирования по порядку предпочтения (без повторов).
function cloneBaseCandidates(workingDir, s) {
  const candidates = [];
  const push = (d) => {
    const t = typeof d === "string" && d.trim() ? d.trim() : "";
    if (t) candidates.push(t);
  };
  push(workingDir);
  if (s) push(s.workingDir);
  push(os.homedir());
  try { push(app.getPath("documents")); } catch {}
  push(os.tmpdir());
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
function pickCloneBase(workingDir, s) {
  for (const c of cloneBaseCandidates(workingDir, s)) {
    const prep = ensureWritableDir(c);
    if (prep.ok) return prep; // { ok: true, dir }
  }
  return {
    ok: false,
    error: "Не нашлось ни одной папки, куда можно писать, для клонирования. Проверены: " + cloneBaseCandidates(workingDir, s).join(", "),
  };
}

// Публикация локальной папки как НОВОГО репозитория GitHub: создать репозиторий + первый push.
// dir — папка проекта (создаётся, если её ещё нет). opts: { name, description, private, message }.
async function publishLocalToGithub(dir, s, opts) {
  opts = opts || {};
  const name = String(opts.name || "").trim();
  const description = String(opts.description || "").trim().slice(0, 300);
  const isPrivate = opts.private !== false; // приватный по умолчанию — безопаснее
  if (!s || !s.githubToken) return { ok: false, error: "GitHub не подключён — подключи аккаунт в Настройках → GitHub." };
  if (!name) return { ok: false, error: "Укажи имя нового репозитория." };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.length > 100) {
    return { ok: false, error: "Недопустимое имя репозитория «" + name + "»: только буквы, цифры, точка, дефис и подчёркивание (без пробелов, не начинается с точки)." };
  }
  const prep = ensureWritableDir(dir);
  if (!prep.ok) return prep;
  dir = prep.dir;
  // Если в папке уже есть origin — это существующий репозиторий, а не «новый»: пусть используют Push.
  const originR = await runGit(dir, ["remote", "get-url", "origin"], s);
  if (originR.ok && String(originR.out || "").trim()) {
    return { ok: false, error: "В папке уже настроен удалённый репозиторий origin: " + stripUrlCreds(String(originR.out).trim()) + ". Используй Push во вкладке «Изменения», а не публикацию нового репозитория." };
  }
  // Владелец (аккаунт, куда создаём)
  let login = String(s.githubLogin || "").trim();
  if (!login) {
    const u = await fetchGithubUser(s.githubToken);
    if (u && u.login) login = String(u.login).trim();
  }
  if (!login) return { ok: false, error: "Не удалось определить GitHub-логин — токен мог быть отозван. Подключи GitHub заново в Настройках." };
  // git init, если папка ещё не репозиторий
  const inRepo = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
  if (!inRepo.ok) {
    let initR = await runGit(dir, ["init", "-b", "main"], s);
    if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые версии git без -b
    if (!initR.ok) return { ok: false, error: "git init не удался: " + initR.err };
  }
  // Ветка для публикации: текущая (если репозиторий с коммитами), иначе создаём main.
  let branch = "main";
  const brR = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], s);
  const curBranch = brR.ok ? String(brR.out || "").trim() : "";
  if (curBranch && curBranch !== "HEAD") {
    branch = curBranch;
    if (branch === "master") {
      const rn = await runGit(dir, ["branch", "-M", "main"], s); // переименовываем в main
      if (rn.ok) branch = "main";
    }
  } else {
    const co = await runGit(dir, ["checkout", "-b", "main"], s);
    if (!co.ok && !(await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok) {
      return { ok: false, error: "Не удалось создать ветку main: " + co.err };
    }
  }
  // Создаём репозиторий на GitHub (POST /user/repos)
  let createRes;
  try {
    createRes = await fetch(GITHUB_API + "/user/repos", {
      method: "POST",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ name, description, private: isPrivate, auto_init: false }),
    });
  } catch (e) {
    return { ok: false, error: "Ошибка запроса к GitHub API: " + (e && e.message ? e.message : String(e)) };
  }
  const createText = await createRes.text().catch(() => "");
  let createJson = null;
  try { createJson = JSON.parse(createText); } catch {}
  if (createRes.status !== 201) {
    let reason = "GitHub API " + createRes.status + ": " + String(createText || "").slice(0, 200);
    if (createJson && createJson.message) reason = String(createJson.message);
    if (createRes.status === 422) {
      reason = "Не удалось создать репозиторий «" + name + "»: он уже существует на этом аккаунте или имя недопустимо.";
    }
    return { ok: false, error: reason };
  }
  const repoUrl = (createJson && createJson.html_url) || ("https://github.com/" + login + "/" + name);
  const cloneUrl = (createJson && createJson.clone_url) || ("https://github.com/" + login + "/" + name + ".git");
  // remote origin (в URL нет токена — авторизация идёт заголовком Basic в runGit)
  const addR = await runGit(dir, ["remote", "add", "origin", cloneUrl], s);
  if (!addR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо не удалось добавить remote origin: " + addR.err };
  // Коммитим файлы, если есть что коммитить (первый коммит или незакоммиченные изменения)
  const stR = await runGit(dir, ["status", "--porcelain"], s);
  const headOk = (await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok;
  const changes = stR.ok && !!String(stR.out || "").trim();
  if (changes) {
    const addAll = await stageAllSafe(dir, s);
    if (!addAll.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\ngit add не удался: " + addAll.err };
    const msg = String(opts.message || "").trim() || "Initial commit";
    const cm = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
    if (!cm.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНе удалось создать коммит: " + cm.err };
  } else if (!headOk) {
    return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо в папке нет файлов — нечего коммитить. Добавь файлы и нажми «Опубликовать» снова." };
  }
  // Пуш (авторизация — заголовок Basic, который runGit подставляет из githubToken)
  const pushR = await runGit(dir, ["push", "-u", "origin", branch], s);
  if (!pushR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nPush не удался: " + pushR.err };
  // Новый пустой репозиторий GitHub по умолчанию может указывать на master —
  // переключаем ветку по умолчанию на опубликованную (иначе репозиторий откроется «пустым»).
  try {
    await fetch(GITHUB_API + "/repos/" + encodeURIComponent(login + "/" + name), {
      method: "PATCH",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ default_branch: branch }),
    });
  } catch {}
  // Запоминаем как активный репозиторий (панель проекта следует за ним)
  try { saveSettings({ ...loadSettings(), githubRepoSlug: login + "/" + name, githubRepoDir: dir }); } catch {}
  live.lastAgentRepoDir = dir;
  live.clonedRepoPending = true; // следующий ответ агента начнётся с анализа опубликованного проекта
  return {
    ok: true,
    slug: login + "/" + name,
    url: repoUrl,
    dir,
    message: "Создан репозиторий " + login + "/" + name + (isPrivate ? " (приватный)" : "") + " и выгружено на GitHub:\n" + repoUrl + "\nВетка: " + branch + ".",
  };
}

// Создать НОВЫЙ репозиторий на GitHub и выгрузить в него папку проекта (первый push).
ipcMain.handle("github:publish", async (_e, opts) => {
  const s = loadSettings();
  opts = opts || {};
  const reqDir = opts.dir && typeof opts.dir === "string" ? opts.dir.trim() : "";
  const dir = reqDir ? (sanitizeDir(reqDir) || reqDir) : agentWorkDir(s);
  // Публикация из панели — не инструмент: назначение объявляем сами, чтобы
  // переменные, выданные группе git, дошли до git init/commit/push.
  const res = await withCapability("git.push", () => publishLocalToGithub(dir, s, opts));
  if (res.ok) githubEmit({ type: "published", slug: res.slug, dir: res.dir, url: res.url });
  return res;
});

ipcMain.handle("github:repos", async (_e, opts) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  opts = opts || {};
  const query = String(opts.query || "").trim();
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const res = query ? await githubReposSearch(s.githubToken, query) : await githubReposPage(s.githubToken, page);
  if (!res.ok) return res;
  return { ok: true, repos: res.repos, query, page: query ? 1 : page, hasMore: !query && !!res.hasMore, total: res.total || res.repos.length };
});

ipcMain.handle("github:selectRepo", async (_e, repoSlug, workingDir) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  const base = pickCloneBase(workingDir, s);
  if (!base.ok) return base;
  const cloneResult = await cloneRepoTo(bySlug.repo.url, base.dir, s);
  if (!cloneResult.ok) return cloneResult;
  const merged = { ...s, githubRepoSlug: slug, githubRepoDir: cloneResult.dir };
  saveSettings(merged);
  live.clonedRepoPending = true; // следующий ответ агента начнётся с анализа выбранного репозитория
  return { ok: true, slug: slug, dir: cloneResult.dir, cloned: cloneResult.cloned, message: cloneResult.message };
});

// Выбор репозитория БЕЗ клонирования: строка помечается, а клонирует уже явная кнопка «⬇ Выгрузить»
// (github:selectRepo) в рабочую директорию.
ipcMain.handle("github:pickRepo", async (_e, repoSlug) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  saveSettings({ ...s, githubRepoSlug: slug, githubRepoDir: "" });
  return { ok: true, slug, repo: { name: bySlug.repo.name, owner: bySlug.repo.owner } };
});

ipcMain.handle("github:selectedRepo", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  if (!s.githubRepoSlug) return { ok: true, slug: null, dir: null };
  let dir = s.githubRepoDir && fs.existsSync(s.githubRepoDir) ? s.githubRepoDir : null;
  if (!dir) {
    // Репозиторий может быть только «выбран» (кнопка «⬇ Выгрузить» ещё не нажата) — папки нет,
    // тогда возвращаем null, и интерфейс покажет кнопку «⬇ Выгрузить».
    const base = s.workingDir && fs.existsSync(s.workingDir) ? s.workingDir : os.homedir();
    const name = repoNameFromUrl("https://github.com/" + s.githubRepoSlug + ".git");
    const cand = path.join(base, name);
    if (fs.existsSync(cand)) dir = cand;
  }
  return { ok: true, slug: s.githubRepoSlug, dir };
});

ipcMain.handle("github:unselectRepo", async () => {
  const merged = { ...loadSettings(), githubRepoSlug: "", githubRepoDir: "" };
  saveSettings(merged);
  return { ok: true };
});

async function readBody(res) { return (await res.text().catch(() => "")); }

ipcMain.handle("github:disconnect", () => {
  const merged = { ...loadSettings(), githubToken: "", githubLogin: "", githubAvatarUrl: "" };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("github:deviceCancel", () => {
  githubPollActive = false;
  if (githubPollTimer) { clearTimeout(githubPollTimer); githubPollTimer = null; }
  return true;
});

ipcMain.handle("github:deviceStart", async () => {
  const s = loadSettings();
  const clientId = (s.githubClientId || "").trim();
  if (!clientId) {
    return {
      ok: false,
      error:
        "Не указан Client ID OAuth-приложения. Создай приложение на github.com/settings/applications/new и вставь Client ID в настройки.",
    };
  }
  if (githubPollActive) return { ok: false, error: "Авторизация уже запущена. Сначала закрой текущее окно кода." };

  const { status, json } = await githubApiFetch("https://github.com/login/device/code", {
    client_id: clientId,
    scope: "repo",
  });
  if (status !== 200 || !json || !json.device_code) {
    return {
      ok: false,
      error: "GitHub не выдал код устройства: " + ((json && (json.error_description || json.error)) || "HTTP " + status),
    };
  }

  githubPollActive = true;
  const { device_code, user_code, verification_uri, expires_in, interval } = json;
  const deadline = Date.now() + (expires_in || 900) * 1000;

  const poll = async () => {
    if (!githubPollActive) return;
    if (Date.now() > deadline) {
      githubPollActive = false;
      githubEmit({ type: "expired", message: "Код истёк" });
      return;
    }
    const r = await githubApiFetch("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (!githubPollActive) return;
    if (r.json && r.json.access_token) {
      githubPollActive = false;
      const token = r.json.access_token;
      const u = await fetchGithubUser(token);
      const merged = {
        ...loadSettings(),
        githubToken: token,
        githubLogin: (u && u.login) || "",
        githubAvatarUrl: (u && u.avatar_url) || "",
      };
      saveSettings(merged);
      githubEmit({ type: "done", login: merged.githubLogin, avatar: merged.githubAvatarUrl });
      return;
    }
    const err = r.json && r.json.error;
    if (err === "authorization_pending" || err === "slow_down") {
      const wait = ((r.json && r.json.interval) || interval || 5) * 1000 + (err === "slow_down" ? 5000 : 0);
      githubPollTimer = setTimeout(poll, wait);
      return;
    }
    githubPollActive = false;
    githubEmit({
      type: "error",
      message: (r.json && (r.json.error_description || r.json.error)) || "Ошибка авторизации",
    });
  };

  githubPollTimer = setTimeout(poll, 1000);
  return { ok: true, user_code, verification_uri, expires_in: expires_in || 900 };
});

  // Клон-помощники нужны и агентским инструментам (gitClone): отдаём их наружу,
  // чтобы main.js передал дальше те же функции.
  return { cloneRepoTo, pickCloneBase };
}

module.exports = { registerGithubIpc };

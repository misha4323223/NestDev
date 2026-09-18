"use strict";

/* ─── Пути и git — общие помощники главного процесса ──────────────────────────
   Вынесено из main.js (этап B, часть 6). Здесь то, чем пользуется весь бэкенд:

     • resolvePath, sanitizeDir, sanitizePath — приведение путей от окна и агента
       к настоящим путям на диске (несуществующее не пропускаем);
     • gitDirOrHome, agentWorkDir — где выполняется работа: папка выбранного
       репозитория, папка последнего клона агента или рабочая директория;
     • repoNameFromUrl, stripUrlCreds — имя папки из git-URL и вычистка логина с
       токеном из адреса, чтобы он не застревал в .git/config;
     • runGit — единственная точка запуска git: она объявляет назначение операции
       (какие переменные агента выдать команде) и подставляет Basic-авторизацию
       из сохранённого токена. Именно эту функцию получают панели и инструменты.

   Живых значений три, поэтому они идут мостом live:
     • lastAgentRepoDir — его пишет клон репозитория (другой модуль), а читает
       здесь выбор рабочей папки;
     • agentEnv и activeToolCapability — пересобираются на ходу, копия «застыла» бы
       и runGit выдал бы команде не то окружение, что видит чат. */

function createPathsGit(deps) {
  const { fs, path, os, execFile, envFor } = deps;

  // Мост живых значений: см. шапку модуля.
  const live = {
    get lastAgentRepoDir() {
      return deps.live.lastAgentRepoDir();
    },
    get agentEnv() {
      return deps.live.agentEnv();
    },
    get activeToolCapability() {
      return deps.live.activeToolCapability();
    },
  };

function resolvePath(p, settings) {
  const base = agentWorkDir(settings);
  if (!p) return base;
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

// ─────────────────────────── Git ───────────────────────────
// cwd — директория, в которой выполняется git; settings — для токена авторизации (OAuth / PAT).
function runGit(cwd, args, settings, capability) {
  return new Promise((resolve) => {
    const opts = { cwd, timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    // Git-операции объявляют своё назначение: инструмент git* — своим именем, а
    // авто-коммит и кнопки (не от инструмента) — git.commit и git.read.
    // Назначение: инструмент git* — своим именем, каналы панели приходят с явной
    // операцией (git:push → git.push), а внутренние вызовы (авто-коммит, клон,
    // публикация) объявляют группу git — им выдаётся разрешённое всей группе.
    const gitEnv = { ...envFor(capability || live.activeToolCapability || "git"), GIT_TERMINAL_PROMPT: "0" };
    if (settings && settings.githubToken) {
      opts.env = gitEnv;
      // GitHub принимает на git-эндпоинте только Basic-авторизацию (Bearer отклоняет
      // с «remote: invalid credentials»). Схема как в GitHub Actions:
      // Authorization: Basic base64(<login или x-access-token>:<token>).
      const ghUser = ((settings.githubLogin || "").trim() || "x-access-token");
      const ghAuth = Buffer.from(ghUser + ":" + settings.githubToken).toString("base64");
      args = ["-c", "http.extraheader=Authorization: Basic " + ghAuth, ...args];
    } else if (Object.keys(live.agentEnv).length) {
      opts.env = gitEnv;
    }
    execFile("git", args, opts, (err, stdout, stderr) => {
      const out = (stdout || "").toString();
      const errText = (stderr || "").toString();
      if (err) {
        let msg = (errText || err.message).toString().trim().slice(0, 4000);
        if (err.code === "ENOENT" || /not found|не является внутренней или внешней командой/i.test(msg)) {
          msg = "Git не найден в PATH. Установи Git (git-scm.com/downloads), перезапусти приложение и обнови PATH через инструмент refreshEnv. Ошибка: " + msg;
        }
        resolve({ ok: false, out, err: msg });
      } else {
        resolve({ ok: true, out: out.trim(), err: errText.trim() });
      }
    });
  });
}

// Рабочая директория приложения (или домашняя, если её нет)
function gitDirOrHome(settings) {
  return settings.workingDir && fs.existsSync(settings.workingDir) ? settings.workingDir : os.homedir();
}
function agentWorkDir(settings) {
  const base = gitDirOrHome(settings);
  // Если выбран GitHub-репозиторий и его локальная папка ещё есть — работать в ней.
  if (settings.githubRepoSlug && settings.githubRepoDir && fs.existsSync(settings.githubRepoDir)) {
    return settings.githubRepoDir;
  }
  if (live.lastAgentRepoDir && fs.existsSync(live.lastAgentRepoDir)) return live.lastAgentRepoDir;
  return base;
}

// Вынимает имя репозитория из URL (https://github.com/user/repo.git, git@github.com:user/repo.git и т.п.)
// Имя используется как имя папки — чистим от того, что Windows не разрешает (точка/пробел в конце,
// служебные имена CON/PRN/AUX/NUL/COM1...), иначе git упадёт с «could not create work tree dir».
function repoNameFromUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (u.includes("git@") && u.includes(":")) u = "https://" + u.slice(u.indexOf(":") + 1);
  let name = (u.split("/").pop() || "repo").replace(/\.git$/i, "").replace(/[. ]+$/g, "").trim();
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "repo";
  return name;
}

// Убирает учётные данные из git-URL: https://user:TOKEN@github.com/... -> https://github.com/...
// Нужно, чтобы токен не хранился в .git/config и не мешал сравнению remote-URL.
function stripUrlCreds(u) {
  const s = String(u || "").trim();
  return s.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

function sanitizeDir(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  return abs;
}

function sanitizePath(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs)) return null;
  return abs;
}
  return {
    resolvePath,
    runGit,
    gitDirOrHome,
    agentWorkDir,
    repoNameFromUrl,
    stripUrlCreds,
    sanitizeDir,
    sanitizePath,
  };
}

module.exports = { createPathsGit };

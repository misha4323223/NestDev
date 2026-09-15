"use strict";

/* ─── Git: каналы панели проекта ──────────────────────────────────────────────
   Семнадцать каналов git-панели переехали из main.js в свой модуль. Сам запуск
   git (`runGit`) остаётся в main.js: им пользуются и агентские инструменты, и
   деплой — дублировать его нельзя.

   Состояние агента (папка последнего клона и флаг «после клона») живёт в main.js:
   сюда оно приходит сеттерами. Это принципиально: копия значения «застыла» бы на
   null, и следующий ответ агента не начался бы с анализа нового проекта.

   Что внутри: сведения о репозитории, статус, журнал и подробности коммита,
   pull/push, индексация и отмена, откат файла и всего коммита, diff, коммит и
   клон репозитория. Каждый путь проходит через sanitizeDir. */

function registerGitIpc(deps) {
  const {
    ipcMain,
    path,
    fs,
    loadSettings,
    runGit,
    sanitizeDir,
    cloneRepoTo,
    pickCloneBase,
    stageAllSafe,
    setLastAgentRepoDir,
    setClonedRepoPending,
  } = deps;

// ─────────────────────────── Git (панель проекта) ───────────────────────────
ipcMain.handle("git:repoInfo", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const s = loadSettings();
  const root = await runGit(d, ["rev-parse", "--show-toplevel"], s);
  if (!root.ok) return { ok: true, isRepo: false, message: "Не git-репозиторий" };
  const rootDir = (root.out || "").trim();
  const [branchR, remoteR] = await Promise.all([
    runGit(rootDir, ["branch", "--show-current"], s),
    runGit(rootDir, ["remote", "get-url", "origin"], s),
  ]);
  let remote = remoteR.ok ? remoteR.out.trim() : "";
  // Никогда не показываем токен, если он оказался зашит в URL
  remote = remote.replace(/^https?:\/\/[^@\/]+@/i, "https://");
  return { ok: true, isRepo: true, root: rootDir, branch: branchR.ok ? branchR.out.trim() : "", remote };
});

ipcMain.handle("git:status", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["status", "--porcelain=v1", "-b", "-uall"], loadSettings());
  if (!r.ok) return { ok: false, error: r.err };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let detached = false;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("## ")) {
      const m = line.match(/^## (\S+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/);
      branch = (m && m[1]) || "HEAD";
      if (branch === "HEAD") detached = true;
      if (m && m[2]) {
        const am = m[2].match(/ahead (\d+)/);
        if (am) ahead = parseInt(am[1], 10);
        const bm = m[2].match(/behind (\d+)/);
        if (bm) behind = parseInt(bm[1], 10);
      }
      continue;
    }
    const X = line[0] || " ";
    const Y = line[1] || " ";
    const name = line.slice(3).replace(/^"|"$/g, "");
    if (X === "?" && Y === "?") untracked.push(name);
    else {
      if (X !== " " && X !== "?") staged.push(name);
      if (Y !== " ") unstaged.push(name);
    }
  }
  return {
    ok: true,
    branch,
    ahead,
    behind,
    detached,
    staged: staged.slice(0, 200),
    unstaged: unstaged.slice(0, 200),
    untracked: untracked.slice(0, 200),
  };
});

ipcMain.handle("git:log", async (_e, dir, n) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const count = Math.max(1, Math.min(parseInt(n, 10) || 50, 200));
  const r = await runGit(d, ["log", "-n", String(count), "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s"], loadSettings());
  if (!r.ok) return { ok: false, error: r.err };
  const commits = r.out
    ? r.out.split("\n").map((line) => {
        const parts = line.split("\x1f");
        return {
          hash: parts[0] || "",
          short: parts[1] || "",
          author: parts[2] || "",
          email: parts[3] || "",
          date: parts[4] || "",
          message: parts[5] || "",
        };
      })
    : [];
  return { ok: true, commits };
});

ipcMain.handle("git:commitDetail", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(
    d,
    ["show", "--numstat", "--format=%H%x1f%s%x1f%an%x1f%aI", String(hash)],
    loadSettings()
  );
  if (!r.ok) return { ok: false, error: r.err };
  const lines = r.out.split("\n");
  const meta = lines[0] ? lines[0].split("\x1f") : [];
  const files = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 3) continue;
    const add = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    let p = parts.slice(2).join("\t");
    let status = "mod";
    if (p.includes("=>")) status = "renamed";
    else if (add > 0 && del === 0) status = "added";
    else if (del > 0 && add === 0) status = "deleted";
    files.push({ path: p, additions: add, deletions: del, status });
  }
  return { ok: true, hash: meta[0] || "", message: meta[1] || "", author: meta[2] || "", date: meta[3] || "", files };
});

// Путь файла внутри репозитория: принимаем абсолютный или относительный, но
// никогда не выходим за пределы рабочей папки — «удалить» не должно трогать чужое.
function gitRelFile(dir, file) {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const raw = String(file || "").trim();
  if (!raw) return { ok: false, error: "Файл не указан" };
  const abs = path.resolve(path.isAbsolute(raw) ? raw : path.join(d, raw));
  const rel = path.relative(d, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "Файл вне рабочей папки: " + raw };
  }
  return { ok: true, dir: d, rel: rel.split(path.sep).join("/") };
}

// Подтянуть изменения с GitHub (кнопка в панели проекта). Только fast-forward:
// конфликтный merge из интерфейса — это молча потерянная работа агента.
ipcMain.handle("git:pull", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["pull", "--ff-only"], loadSettings());
  return r.ok ? { ok: true, out: r.out || "Изменения подтянуты." } : { ok: false, error: r.err || "Не удалось подтянуть изменения" };
});

// Убрать файл из индекса (кнопка «Убрать из staged»): git reset HEAD -- <файл>.
ipcMain.handle("git:unstage", async (_e, dir, file) => {
  const prep = gitRelFile(dir, file);
  if (!prep.ok) return prep;
  const r = await runGit(prep.dir, ["reset", "HEAD", "--", prep.rel], loadSettings());
  return r.ok ? { ok: true, out: "Файл убран из индекса." } : { ok: false, error: r.err };
});

// Удалить выбранные файлы с диска и из git (кнопка «Удалить выбранные»).
ipcMain.handle("git:rm", async (_e, dir, file) => {
  const prep = gitRelFile(dir, file);
  if (!prep.ok) return prep;
  const r = await runGit(prep.dir, ["rm", "-f", "--", prep.rel], loadSettings());
  if (r.ok) return { ok: true, out: "Файл удалён." };
  const abs = path.join(prep.dir, prep.rel);
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      fs.unlinkSync(abs);
      return { ok: true, out: "Файл удалён с диска (в git его не было)." };
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: false, error: r.err };
});

ipcMain.handle("git:revert", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["revert", "--no-edit", String(hash)], loadSettings());
  return r.ok ? { ok: true, out: r.out || "Коммит отменён." } : { ok: false, error: r.err || "Не удалось откатить (возможен конфликт)" };
});

ipcMain.handle("git:resetHard", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["reset", "--hard", String(hash)], loadSettings());
  return r.ok ? { ok: true, out: "Сброшено к " + String(hash) } : { ok: false, error: r.err };
});

ipcMain.handle("git:restore", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["restore", "."], loadSettings());
  return r.ok ? { ok: true, out: "Изменения отменены." } : { ok: false, error: r.err };
});

// Мягкая отмена последнего коммита: reset --soft HEAD~1 — изменения коммита
// возвращаются в рабочее дерево как незакоммиченные, ничего не теряется.
ipcMain.handle("git:undoLastCommit", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const s = loadSettings();
  const log = await runGit(d, ["log", "-1", "--pretty=%h"], s);
  if (!log.ok || !String(log.out || "").trim()) {
    return { ok: false, error: "В истории нет коммитов для отмены" };
  }
  const r = await runGit(d, ["reset", "--soft", "HEAD~1"], s);
  if (!r.ok) return { ok: false, error: r.err || "Не удалось отменить коммит" };
  return { ok: true, out: "Последний коммит " + String(log.out).trim() + " отменён (reset --soft): его изменения вернулись как незакоммиченные, ничего не потеряно." };
});

// Дифф файла (или пометка, что файл новый и не отслеживается)
ipcMain.handle("git:diff", async (_e, dir, file) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  if (!file || typeof file !== "string" || !file.trim()) return { ok: false, error: "Файл не указан" };
  // Путь проверяем ТЕМ ЖЕ помощником, что и остальные git-каналы (git:rm,
  // git:revert и т.д.): раньше diff считал путь сам и на файл вне рабочей папки
  // отвечал «не в git» вместе с его размером. Правило должно быть одно.
  const prep = gitRelFile(d, file);
  if (!prep.ok) return prep;
  const r = await runGit(d, ["diff", "--", prep.rel], loadSettings());
  if (r.ok && r.out) return { ok: true, diff: r.out, untracked: false };
  const abs = path.join(d, prep.rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return { ok: true, untracked: true, size: fs.statSync(abs).size, path: abs };
  }
  return { ok: false, error: "Нет изменений или файл не найден" };
});

// Коммит всех изменений с указанным сообщением
ipcMain.handle("git:commit", async (_e, dir, message) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "Укажи сообщение коммита" };
  const s = loadSettings();
  const add = await stageAllSafe(d, s);
  if (!add.ok) return { ok: false, error: add.err };
  const commit = await runGit(
    d,
    ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg],
    s
  );
  if (!commit.ok) return { ok: false, error: commit.err || "Коммит не создан (нет изменений?)" };
  return { ok: true, out: commit.out || "Коммит создан." };
});

ipcMain.handle("git:push", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["push"], loadSettings());
  return r.ok ? { ok: true, out: r.out || "Отправлено на GitHub." } : { ok: false, error: r.err };
});

ipcMain.handle("git:clone", async (_e, base, url) => {
  const u = String(url || "").trim();
  if (!/^(https?:\/\/|git@)/i.test(u)) return { ok: false, error: "URL должен начинаться с https:// или git@" };
  const prep = pickCloneBase(base, loadSettings());
  if (!prep.ok) return prep;
  const r = await cloneRepoTo(u, prep.dir, loadSettings());
  if (r.ok) {
    // Состояние агента живёт в main.js: пишем через сеттеры, чтобы не держать
    // устаревшую копию значения у себя.
    setLastAgentRepoDir(r.dir); // агент тоже работает внутри склонированного репозитория
    setClonedRepoPending(true); // следующий ответ агента начнётся с анализа нового проекта
  }
  return r.ok ? { ok: true, out: r.message || "Клонировано", dir: r.dir, cloned: r.cloned } : r;
});

  return { gitRelFile };
}

module.exports = { registerGitIpc };

"use strict";

/* ─── Инструменты агента: git и GitHub ──────────────────────────────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 2): шестнадцать обработчиков — клон и публикация (gitClone,
   gitPublish), состояние и история (gitStatus, gitDiff, gitLog, gitBlame),
   коммит и ветки (gitCommit, gitPush, gitInit, gitBranch, gitCheckout,
   gitRevert, gitUndoLastCommit, gitStash, gitCherryPick).

   ПОЧЕМУ ССЫЛКИ, А НЕ СПРЕД. В реестре (agent-tools.js) на прежнем месте каждой
   записи осталась ссылка `"gitClone": git.gitClone,` — эти шестнадцать идут
   четырьмя НЕсмежными кусками, и спред в конец переставил бы инструменты в
   реестре. Тела перенесены ПОБАЙТОВО (сверка `fn.toString()` до/после): порядок
   ключей и поведение не менялись.

   Живой мост приходит готовым вторым аргументом (`createGitTools(deps, live)`):
   gitClone пишет папку последнего клона и снимает флаг «после клона» теми же
   геттерами/сеттерами, что и остальные инструменты, — своей копии состояния
   модуль не заводит.

   Модуль чистый: Electron не тянет, состояния уровня файла не держит — его можно
   проверить в обычном Node (та же конвенция, что у createYcService и
   createDeployEngine). */

function createGitTools(deps, live) {
  const {
    path,
    os,
    fs,
    resolvePath,
    runGit,
    repoNameFromUrl,
    stripUrlCreds,
    agentWorkDir,
    stageAllSafe,
    publishLocalToGithub,
    loadSettings,
    truncateText,
  } = deps;

  return {
    "gitClone": async (args, settings) => {
        const url = String(args.url || "").trim();
        if (!url) return "Ошибка: укажи url репозитория";
        const base = settings.workingDir || os.homedir();
        const dir = args.directory
          ? resolvePath(args.directory, settings)
          : path.join(base, repoNameFromUrl(url));
        const r = await runGit(base, ["clone", url, dir], settings);
        if (r.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(dir, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          live.lastAgentRepoDir = dir; // все следующие git/команды — внутри склонированного репозитория
          live.clonedRepoPending = true; // следующий ответ агента начнётся с анализа нового проекта
          return "OK — репозиторий клонирован: " + dir + "\nТеперь git-команды и терминал работают внутри этого репозитория.";
        }
        return "Ошибка git: " + r.err;
    },
    "gitStatus": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["status"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitCommit": async (args, settings) => {
        if (!args.message) return "Ошибка: укажи message для коммита";
        const cwd = agentWorkDir(settings);
        const add = await stageAllSafe(cwd, settings);
        if (!add.ok) return "Ошибка git add: " + add.err;
        const commit = await runGit(
          cwd,
          ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", String(args.message)],
          settings
        );
        return "git add -A:\n" + add.out + "\n\ngit commit:\n" + (commit.ok ? commit.out : "Ошибка git: " + commit.err);
    },
    "gitPush": async (args, settings) => {
        if (!settings.allowAgentPush) {
          return (
            "⛔ git push заблокирован: пользователь не разрешил агенту отправлять коммиты на GitHub.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push» — после этого инструмент заработает;\n" +
            "2. либо пользователь сам нажимает «Push» во вкладке «Изменения» панели проекта.\n" +
            "Сообщи пользователю, что пуш не выполнен и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const r = await runGit(agentWorkDir(settings), ["push"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitPublish": async (args, settings) => {
        // Создание репозитория + push — та же политика безопасности, что и у gitPush.
        if (!settings.allowAgentPush) {
          return (
            "⛔ gitPublish заблокирован: создание репозитория и отправка кода на GitHub запрещены, пока пользователь не разрешит.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push»;\n" +
            "2. либо пользователь сам нажимает «⬆ Опубликовать на GitHub» в панели проекта.\n" +
            "Сообщи пользователю, что публикация не выполнена и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const cwdP = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        // Не-GitHub хостинг (GitLab, Bitbucket, свой сервер): создание репозитория
        // делается на сайте хостинга, а мы сами прописываем remote и пушим ветку —
        // без GitHub API и без ручных команд в терминале.
        const remoteUrl = String(args.remoteUrl || "").trim();
        if (remoteUrl) {
          if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(remoteUrl)) {
            return "Ошибка: remoteUrl должен быть git-адресом — https://gitlab.com/you/repo.git или git@bitbucket.org:you/repo.git.";
          }
          const remoteName = String(args.remoteName || "origin").trim() || "origin";
          const existR = await runGit(cwdP, ["remote"], settings);
          const hasRemote = String(existR.out || "").split("\n").map((x) => x.trim()).includes(remoteName);
          const setR = await runGit(cwdP, hasRemote ? ["remote", "set-url", remoteName, remoteUrl] : ["remote", "add", remoteName, remoteUrl], settings);
          if (!setR.ok) return "Ошибка git remote: " + setR.err;
          const brR = await runGit(cwdP, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
          const branch = String(brR.out || "").trim() || "main";
          const pushR = await runGit(cwdP, ["push", "-u", remoteName, branch], settings);
          if (!pushR.ok) {
            return (
              "Remote «" + remoteName + "» → " + remoteUrl + " прописан, но push не прошёл:\n" + pushR.err +
              "\n\nЧастые причины: репозиторий ещё не создан на сайте хостинга; нужен токен (для GitLab/Bitbucket — personal access token в адресе вида https://oauth2:TOKEN@host/…) или у аккаунта нет прав на запись."
            );
          }
          return "✅ Отправлено на «" + remoteName + "» (" + remoteUrl + "), ветка " + branch + ".\n" + (pushR.out || "Готово (без вывода).");
        }
        const resP = await publishLocalToGithub(cwdP, settings, {
          name: args.name,
          description: args.description,
          private: args.private !== false,
          message: args.message,
        });
        return resP.ok
          ? "✅ " + resP.message
          : "Ошибка публикации: " + resP.error;
    },
    "gitInit": async (args, settings) => {
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка не найдена: " + dir;
        const s = loadSettings();
        const check = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
        if (check.ok && String(check.out || "").trim() === "true") {
          return "Эта папка уже git-репозиторий: " + dir + "\nСостояние смотри через gitStatus.";
        }
        let initR = await runGit(dir, ["init", "-b", "main"], s);
        if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые git без -b
        if (!initR.ok) return "Ошибка git init: " + initR.err;
        const msg = String(args.message || "").trim();
        if (msg) {
          const addR = await runGit(dir, ["add", "-A"], s);
          if (!addR.ok) return "Репозиторий создан, но первый коммит не удался: " + addR.err;
          const commitR = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
          if (!commitR.ok) return "Репозиторий создан, но первый коммит не удался: " + commitR.err;
          return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main), первый коммит «" + msg + "» сделан.\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit — новые коммиты, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
        }
        return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main).\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit(message) — сделать первый коммит, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
    },
    "gitPull": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["pull"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
    },
    "gitLog": async (args, settings) => {
        const r = await runGit(agentWorkDir(settings), ["log", "--oneline", "-n", "30", "--decorate"], settings);
        return r.ok ? (r.out || "Коммитов пока нет.") : "Ошибка git: " + r.err;
    },
    "gitRevert": async (args, settings) => {
        if (!args.commit) return "Ошибка: укажи commit (хэш, например HEAD~1)";
        const r = await runGit(agentWorkDir(settings), ["revert", "--no-edit", String(args.commit)], settings);
        return r.ok ? "OK — коммит отменён:\n" + (r.out || "") : "Ошибка git: " + r.err;
    },
    "gitBranch": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const cur = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
        const list = await runGit(cwd, ["branch", "-a", "--no-color"], settings);
        if (!cur.ok && !list.ok) return "Ошибка git: " + (cur.err || list.err);
        return "Текущая ветка: " + (cur.ok ? cur.out : "(не git-репозиторий)") + "\n\nВсе ветки:\n" + (list.ok ? list.out : "(веток нет)");
    },
    "gitCheckout": async (args, settings) => {
        const cwdCh = agentWorkDir(settings);
        const branch = String(args.branch || args.name || "").trim();
        if (!branch) return "Ошибка: укажи branch — имя ветки (create: true, чтобы создать новую)";
        const create = !!args.create;
        const r = await runGit(cwdCh, ["checkout", ...(create ? ["-b", branch] : [branch])], settings);
        if (!r.ok) {
          const hint = create
            ? ""
            : "\n(Если ветки ещё нет — повтори с create: true. Если есть незакоммиченные изменения, мешающие переключению, — сначала закоммить их или отложи через git stash.)";
          return "Ошибка git: " + r.err + hint;
        }
        return "OK — " + (create ? "создана и активирована ветка «" : "переключение на ветку «") + branch + "»:\n" + r.out;
    },
    "gitDiff": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const b1 = String(args.branch1 || "").trim();
        const b2 = String(args.branch2 || "").trim();
        const spec = b1 && b2 ? [b1, b2] : b1 ? [b1] : [];
        if (!spec.length) {
          const d = await runGit(cwd, ["diff", "--stat"], settings);
          return d.ok ? (d.out || "Рабочее дерево чистое — нет незакоммиченных изменений.") : "Ошибка git: " + d.err;
        }
        const st = await runGit(cwd, ["diff", "--stat", ...spec], settings);
        const ns = await runGit(cwd, ["diff", "--name-status", ...spec], settings);
        const stat = st.ok ? st.out : "";
        const names = ns.ok ? ns.out : "";
        if (!stat && !names) return "Различий нет: " + spec.join(" … ") + " — ветки идентичны (или ветка не найдена).";
        return "Сравнение " + spec.join(" … ") + " — изменено файлов: " + names.split("\n").filter(Boolean).length + "\n\n" + stat + "\n\n--- Файлы ---\n" + truncateText(names, 3000);
    },
    "gitUndoLastCommit": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const r = await runGit(cwd, ["reset", "--soft", "HEAD~1"], settings);
        if (!r.ok) return "Ошибка git: " + r.err + "\n(Частая причина — в истории нет коммитов для отмены.)";
        return "OK — последний коммит отменён (git reset --soft HEAD~1): его изменения вернулись в рабочее дерево как незакоммиченные, ничего не потеряно.\n" + r.out;
    },
    "gitStash": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const action = String(args.action || "push").toLowerCase();
        const isList = action === "list";
        const isPop = action === "pop";
        const isPush = action === "push";
        if (!isList && !isPop && !isPush) return "Ошибка: action может быть push (сохранить изменения), pop (вернуть) или list (показать).";
        if (isList) {
          const r = await runGit(cwd, ["stash", "list"], settings);
          return r.ok ? (r.out || "Стеков stash нет.") : "Ошибка git: " + r.err;
        }
        if (isPop) {
          const r = await runGit(cwd, ["stash", "pop"], settings);
          if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — проверь gitStatus и разбери изменения вручную).";
          return "OK — изменения возвращены из stash:\n" + r.out;
        }
        const msg = String(args.message || "").trim() || "Авто-stash агента";
        const r = await runGit(cwd, ["stash", "push", "-m", msg], settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "OK — изменения спрятаны в stash («" + msg + "»). Вернуть: gitStash(action: pop). Рабочее дерево теперь чистое.";
    },
    "gitCherryPick": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const commit = String(args.commit || "").trim();
        if (!commit) return "Ошибка: укажи commit — хэш или ссылку (например HEAD~1 или abc123).";
        const r = await runGit(cwd, ["cherry-pick", commit], settings);
        if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — разбери его, затем gitCherryPick не нужен, просто gitCommit после разрешения).";
        return "OK — коммит " + commit + " перенесён на текущую ветку:\n" + r.out;
    },
    "gitBlame": async (args, settings) => {
        const cwd = agentWorkDir(settings);
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const rel = path.relative(cwd, p) || path.basename(p);
        const lines = parseInt(args.lines, 10);
        const gitArgs = ["blame"];
        if (Number.isInteger(lines) && lines >= 1) gitArgs.push("-L", "1," + Math.min(lines, 500));
        gitArgs.push("--", rel);
        const r = await runGit(cwd, gitArgs, settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "История строк файла " + rel + " (git blame):\n" + truncateText(r.out, 9000);
    },
  };
}

module.exports = { createGitTools };

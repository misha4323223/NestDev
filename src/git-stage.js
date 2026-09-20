"use strict";

/* ─── Гит-операции агента: индексация без секретов и авто-чекпоинт ────────────
   Раньше жили в main.js (этап B, часть 28). Здесь два действия, которые агент
   делает с git сам, в фоне, не спрашивая — и оба ошибаются ТИХО:

     • stageAllSafe — `git add -A`, но БЕЗ файлов секретов. Ключ не должен
       попасть в коммит ни через авто-чекпоинт, ни через инструмент gitCommit,
       ни при публикации репозитория: закоммиченный секрет живёт в истории
       навсегда, даже если файл потом удалить. Рубежей два — исключение в самой
       команде (`.env*` на любой глубине) и страховка, которая снимает с индекса
       всё, что всё же проскочило (имена вида `*.env` тоже);
     • autoCheckpointCommit — точка возврата после завершённого задания: один
       ЛОКАЛЬНЫЙ коммит, если агент менял файлы в git-репозитории. Никогда не
       пушит и молчит, когда коммитить нечего, — поэтому «после работы агента
       всегда есть куда откатиться» верно и на чужом проекте, и в свежем
       репозитории без истории.

   Живые значения приходят аргументами: fs, runGit (единственная точка запуска
   git — она же объявляет назначение операции, от него зависит окружение) и
   agentWorkDir (папка работы агента). Сам settings приходит в обе функции
   ПАРАМЕТРОМ, поэтому копий состояния здесь нет и «застыть» на времени загрузки
   нечему.

   Найдено при выносе и вылечено в 1.5.184: страховка снимает файлы командой
   `git restore --staged`, а ей нужен первый коммит — в свежем репозитории без
   истории она молча падала с «could not resolve HEAD», и имена вида `secrets.env`
   (они не начинаются с точки, поэтому исключение в самой команде их не берёт)
   оставались в индексе. Теперь команда выбирается по наличию HEAD: `restore` там,
   где он есть, и `rm --cached` там, где его нет. Почему нельзя всегда `rm` —
   в комментарии к самой страховке (у отслеживаемого файла он индексирует
   удаление).

   Текст перенесён ПОБАЙТОВО (переотступа при выносе не было: так же сделано в
   src/mail-ipc.js и src/project-brief.js), поэтому поведение не менялось ни на
   строку. */

function createGitStage(deps) {
  const { fs, runGit, agentWorkDir } = deps;

// git add -A, но БЕЗ файлов секретов (env-файлы вида DOTENV*): агент
// (авто-чекпоинт, gitCommit, публикация) не должен закоммитить ключи в git.
async function stageAllSafe(dir, settings) {
  const r = await runGit(dir, ["add", "-A", "--", ".", ":(exclude,glob)**/" + ".env" + "*"], settings);
  if (!r.ok) return r;
  // Страховка: снимаем с индекса всё, что всё же проскочило (имя с DOTENV).
  try {
    const cached = await runGit(dir, ["diff", "--cached", "--name-only"], settings);
    if (cached.ok && cached.out) {
      const secret = cached.out.split("\n").map((l) => l.trim()).filter((l) => {
        const base = l.split("/").pop() || l;
        return /^\.env(\..*)?$/i.test(base) || /\.env$/i.test(base);
      });
      if (secret.length) {
        // Чем снимать — зависит от того, есть ли первый коммит, и это не придирка:
        //   • HEAD есть → `restore --staged` возвращает индекс к HEAD. Верно и для
        //     нового файла (уходит из индекса), и для правки УЖЕ отслеживаемого
        //     (правка снимается, а файл в репозитории остаётся);
        //   • HEAD нет → `restore --staged` падает с «could not resolve HEAD» и
        //     молча ничего не делает: секрет остался бы в индексе. Зато в таком
        //     репозитории файла в истории быть не может, поэтому `rm --cached`
        //     (снять из индекса, файл на диске цел) — ровно то, что нужно.
        // Безусловный `rm --cached` запрещён: у отслеживаемого файла он индексирует
        // УДАЛЕНИЕ, и коммит стёр бы файл из репозитория.
        const head = await runGit(dir, ["rev-parse", "--verify", "HEAD"], settings);
        await runGit(
          dir,
          head.ok
            ? ["restore", "--staged", "--", ...secret]
            : ["rm", "--cached", "-q", "-f", "--", ...secret],
          settings
        );
      }
    }
  } catch {}
  return r;
}

// Авто-чекпоинт (как в Replit): после завершённого задания агента, если он менял файлы
// в git-репозитории — создаём один локальный коммит-точку возврата. Никогда не пушит.
async function autoCheckpointCommit(settings, messages) {
  try {
    if (settings && settings.agentAutoCommit === false) return { committed: false };
    const dir = agentWorkDir(settings);
    if (!dir || !fs.existsSync(dir)) return { committed: false };
    // Не git-репозиторий или нет изменений — пропускаем тихо.
    const st = await runGit(dir, ["status", "--porcelain"], settings);
    if (!st.ok || !st.out.trim()) return { committed: false };
    // Заголовок коммита — из последнего сообщения пользователя (первая строка).
    let title = "";
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          const lines = m.content.replace(/```[\s\S]*?```/g, " ").split("\n");
          title = lines.find(function (l) { return l.trim(); }) || "";
          break;
        }
      }
    }
    title = String(title).replace(/\s+/g, " ").trim().slice(0, 70);
    if (!title) title = "Работа агента";
    const add = await stageAllSafe(dir, settings);
    if (!add.ok) return { committed: false };
    const commit = await runGit(
      dir,
      ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", "Авто-коммит агента: " + title],
      settings
    );
    if (!commit.ok) return { committed: false };
    return { committed: true, message: "💾 Авто-коммит агента: " + title };
  } catch (e) {
    return { committed: false };
  }
}

  return { stageAllSafe, autoCheckpointCommit };
}

module.exports = { createGitStage };

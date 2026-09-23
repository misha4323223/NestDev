"use strict";

/* ─── Инструменты «пояса проекта»: заметки, дела, память, чекпоинты ──────────
   Вынесено из agent-tools.js (часть 40, заход 6b). Здесь живут пятнадцать
   обработчиков, которые помнят работу МЕЖДУ сессиями — всё это ложится файлами
   в пользовательскую папку и рабочую папку проекта:

     • noteSave / noteRead / noteList / noteDelete — заметки проекта (переживают
       перезапуск и помогают продолжать работу в новых сессиях);
     • diaryWrite / diaryRead — дневник агента человекочитаемым файлом в самом
       проекте (.agent/AGENT.md): важные решения и «где остановились»;
     • taskAdd / taskList / taskUpdate / taskDone / taskDelete — дела со сроком,
       приоритетом и повтором (изменение сразу видно панели: emitTasksChanged);
     • memoryList / memorySearch — дневник памяток диалогов (включается галочкой
       «Память диалогов» в настройках);
     • checkpointSave / checkpointList / checkpointRollback — снимки файлов перед
       серией правок и откат к ним;
     • semanticSearch — поиск по смыслу по семантическому индексу проекта.

   Все помощники приходят в `deps` (agentStore, codeIndex, app, agentWorkDir,
   tasksDataDir, emitTasksChanged, loadSettings, resolvePath, fs): модуль сам
   ничего не достаёт и состояния не держит. Папка дел спрашивается в момент
   вызова (tasksDataDir): человек мог сменить её в открытых настройках. Тела перенесены ПОБАЙТОВО, порядок
   инструментов в реестре сохранён ссылками.

   `path` в deps НЕТ намеренно: разбор имени файла целиком на стороне *agentStore*
   и resolvePath. Это была бы мёртвая распаковка «на будущее», а такая строка
   выглядит работающей (первый прогон выноса притащил её из подсказки
   «readFileLines(path, start, count)» — слово, а не зависимость). */

function createMemoryTools(deps) {
  const {
    fs,
    loadSettings,
    resolvePath,
    agentWorkDir,
    app,
    agentStore,
    codeIndex,
    tasksDataDir,
    emitTasksChanged,
  } = deps;

  return {
    "noteSave": async (args, settings) => {
        const nKey = String(args.key || "").trim();
        const nContent = String(args.content ?? "");
        const nR = agentStore.noteSave(app.getPath("userData"), agentWorkDir(settings), nKey, nContent);
        return nR.ok ? "OK — " + nR.message : "Ошибка: " + nR.error;
    },
    "noteRead": async (args, settings) => {
        const nrKey = String(args.key || "").trim();
        const nrR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), nrKey);
        if (!nrR.ok) return "Ошибка: " + nrR.error;
        if (nrR.key) return "Заметка «" + nrR.key + "»:\n" + nrR.content;
        if (!nrR.notes.length) {
          return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content) — они переживают перезапуск и помогают продолжать работу в новых сессиях.";
        }
        const nrRows = nrR.notes.map((n) => "• " + n.key + " (" + new Date(n.ts).toLocaleString() + "):\n  " + n.content.replace(/\n/g, "\n  "));
        return "Заметки проекта (" + nrR.notes.length + "):\n" + nrRows.join("\n\n");
    },
    "noteList": async (args, settings) => {
        const nlR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), "");
        if (!nlR.ok) return "Ошибка: " + nlR.error;
        if (!nlR.notes.length) return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content).";
        return "Заметки проекта (" + nlR.notes.length + "):\n" + nlR.notes.map((n) => "• " + n.key).join("\n");
    },
    "noteDelete": async (args, settings) => {
        const ndKey = String(args.key || "").trim();
        const ndR = agentStore.noteDelete(app.getPath("userData"), agentWorkDir(settings), ndKey);
        return ndR.ok ? "OK — " + ndR.message : "Ошибка: " + ndR.error;
    },
    "diaryWrite": async (args, settings) => {
        const dwR = agentStore.diaryAppend(agentWorkDir(settings), args.title, args.text);
        return dwR.ok ? "OK — " + dwR.message : "Ошибка: " + dwR.error;
    },
    "diaryRead": async (args, settings) => {
        const drTail = parseInt(args.tail, 10) || 0;
        const drR = agentStore.diaryRead(agentWorkDir(settings), { tail: drTail });
        if (!drR.ok) return "Ошибка: " + drR.error;
        if (!drR.exists) {
          return "Дневник агента пока пуст: файла " + drR.file + " ещё нет. Появится при первой записи (diaryWrite).";
        }
        return (
          "Дневник агента (" + drR.file + ", " + drR.bytes + " симв.):\n\n" + drR.text +
          (drR.truncated ? "\n\n…(показан конец файла; целиком — diaryRead без tail)" : "")
        );
    },
    "taskAdd": async (args, settings) => {
        const taR = agentStore.tasksAdd(tasksDataDir(), {
          title: args.title, due: args.due, priority: args.priority, project: args.project, note: args.note,
          repeat: args.repeat, auto: args.auto, prompt: args.prompt,
        });
        if (!taR.ok) return "Ошибка: " + taR.error;
        emitTasksChanged();
        return "OK — " + taR.message + " Актуальный список — taskList.";
    },
    "taskList": async (args, settings) => {
        const tlR = agentStore.tasksList(tasksDataDir(), { status: args.status, due: args.due, project: args.project });
        const tlS = tlR.summary.summary;
        const tlHead = "Дела: активных " + tlS.active + " · просрочено " + tlS.overdue + " · сегодня " + tlS.today +
          " · завтра " + tlS.tomorrow + " · на неделе " + tlS.week + " · без срока " + tlS.noDue + " · выполнено " + tlS.done;
        if (!tlR.tasks.length) return tlHead + "\nСписок пуст — занеси первое дело через taskAdd.";
        return tlHead + "\n" + agentStore.tasksFormatText(tlR.tasks, Date.now());
    },
    "taskUpdate": async (args, settings) => {
        const tuR = agentStore.tasksUpdate(tasksDataDir(), args.key, {
          title: args.title, due: args.due, priority: args.priority, status: args.status, project: args.project, note: args.note,
          repeat: args.repeat, auto: args.auto, prompt: args.prompt, snooze: args.snooze,
        });
        if (!tuR.ok) return "Ошибка: " + tuR.error;
        emitTasksChanged();
        return "OK — " + tuR.message;
    },
    "taskDone": async (args, settings) => {
        const tdR = agentStore.tasksDone(tasksDataDir(), args.key, args.done !== false);
        if (!tdR.ok) return "Ошибка: " + tdR.error;
        emitTasksChanged();
        return "OK — " + (args.done === false ? "отметка снята: " : "выполнено: ") + agentStore.taskLine(tdR.task, Date.now());
    },
    "taskDelete": async (args, settings) => {
        const txR = agentStore.tasksDelete(tasksDataDir(), args.key);
        if (!txR.ok) return "Ошибка: " + txR.error;
        emitTasksChanged();
        return "OK — " + txR.message;
    },
    "memoryList": async (args, settings) => {
        // Настройки читаем в момент вызова: галочку могли включить только что.
        const ms = loadSettings();
        const memDir = agentStore.contextMemoryDir(app.getPath("userData"));
        if (!ms.contextMemory) {
          return (
            "Память диалогов выключена. Включи галочку «Память диалогов» в Настройках → 🧠 Память диалогов: тогда сжатые памятки будут сохраняться локально по датам, и я смогу вспоминать прошлые сессии.\n" +
            "Папка дневника: " + memDir
          );
        }
        const mmDate = String(args.date || "").trim();
        if (mmDate) {
          const mr = agentStore.contextMemoryRead(app.getPath("userData"), mmDate);
          if (!mr.ok) return "Ошибка: " + mr.error;
          const rows = mr.memos.map((m) =>
            "• " + m.time + " — " + (m.provider || "?") + (m.model ? "/" + m.model : "") +
            (m.workDir ? "\n  папка: " + m.workDir : "") + "\n" + String(m.memo || "").replace(/^/gm, "  ")
          );
          return "Памятки контекста за " + mmDate + " (" + mr.count + "):\n\n" + rows.join("\n\n");
        }
        const md = agentStore.contextMemoryDays(app.getPath("userData"));
        if (!md.length) {
          return "Память диалогов включена, но памяток пока нет: они появляются, когда контекст переполняется и старые шаги сворачиваются в памятку.";
        }
        const mrows = md.map((d) =>
          "• " + d.date + " — " + d.count + " памяток" + (d.last ? ", последняя в " + new Date(d.last).toLocaleTimeString() : "")
        );
        return (
          "Дни в памяти диалогов (" + md.length + "):\n" + mrows.join("\n") +
          '\n\nПамятки за конкретный день — memoryList(date: "ГГГГ-ММ-ДД"); поиск — memorySearch(query: "...").'
        );
    },
    "memorySearch": async (args, settings) => {
        const ms2 = loadSettings();
        if (!ms2.contextMemory) {
          return "Память диалогов выключена — включи галочку «Память диалогов» в настройках (Настройки → 🧠).";
        }
        const mq = String(args.query || "").trim();
        if (!mq) return "Ошибка: укажи query — что искать в памятках.";
        const msr = agentStore.contextMemorySearch(app.getPath("userData"), {
          query: mq,
          date: String(args.date || "").trim(),
          limit: Number(args.limit) || 20,
        });
        if (!msr.ok) return "Ошибка: " + msr.error;
        if (!msr.matches.length) {
          return "По запросу «" + mq + "» в памяти диалогов ничего не найдено. Список дней — memoryList.";
        }
        const srows = msr.matches.map((m) => "• " + m.date + " " + m.time + " (совпадений: " + m.hits + "): " + m.snippet);
        return "Найдено в памяти диалогов (" + msr.count + "):\n" + srows.join("\n");
    },
    "checkpointSave": async (args, settings) => {
        const csR = agentStore.checkpointSave(app.getPath("userData"), agentWorkDir(settings), args.label);
        return csR.ok ? "OK — " + csR.message : "Ошибка: " + csR.error;
    },
    "checkpointList": async (args, settings) => {
        const clR = agentStore.checkpointList(app.getPath("userData"));
        if (!clR.checkpoints.length) {
          return "Чекпоинтов пока нет. Создай первый через checkpointSave(label) перед серией правок — потом можно откатиться через checkpointRollback(id).";
        }
        const clRows = clR.checkpoints.map((c) => "• " + c.id + " — «" + c.label + "», " + c.files + " файлов, " + new Date(c.createdAt).toLocaleString());
        return "Чекпоинты (" + clR.checkpoints.length + "):\n" + clRows.join("\n");
    },
    "checkpointRollback": async (args, settings) => {
        const crId = String(args.id || "").trim();
        if (!crId) return "Ошибка: укажи id чекпоинта (смотри checkpointList).";
        const crR = agentStore.checkpointRollback(app.getPath("userData"), crId);
        if (!crR.ok) return "Ошибка: " + crR.error;
        return "OK — " + crR.message + (crR.errors && crR.errors.length ? "\nОшибки: " + crR.errors.join("; ") : "");
    },
    "semanticSearch": async (args, settings) => {
        const query = String(args.query || "").trim();
        if (!query) return "Ошибка: укажи query — что ищем по смыслу (например «валидация входа», «db подключение»).";
        const base = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: директория не найдена: " + base;
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 8, 20);
        const index = codeIndex.getIndex(app.getPath("userData"), base);
        if (!index.docsCount) return "Нечего искать в " + base + " — текстовых файлов не найдено.";
        const hits = codeIndex.searchIndex(index, query, maxResults);
        if (!hits.length) {
          return "По запросу «" + query + "» ничего не найдено в " + index.docsCount + " файлах (индекс: " + base + ").\nПопробуй другие слова (поиск работает по смыслу: auth → authenticate) или searchFile для точного регулярного поиска.";
        }
        const rows = hits.map((h, i) => {
          const sn = codeIndex.snippetForFile(base, h.rel, query, 3);
          return "#" + (i + 1) + " " + h.rel + " (релевантность " + h.score.toFixed(2) + ")\n" + sn.text;
        });
        return (
          "Семантический поиск «" + query + "» — индексировано файлов: " + index.docsCount + ", топ-" + hits.length + ":\n\n" +
          rows.join("\n\n") +
          "\n\nДальше: readFileLines(path, start, count) — читать найденное, searchFile — точный регулярный поиск."
        );
    },
  };
}

module.exports = { createMemoryTools };

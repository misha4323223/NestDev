"use strict";

/* ─── Инструменты агента: файлы — запись и правки ────────────────────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 3b): createFolder, editFile, writeFile, undoEdit,
   refactorRename и applyPatch. Здесь же два их помощника — checkWrittenFile с
   таблицей CHECK_CODE_EXT и envNoteFor: ими пользуется ТОЛЬКО writeFile (проверка
   синтаксиса/JSON сразу после записи и подсказка про окружение запуска), поэтому
   они переехали вместе с ним, а не остались общим хламом в реестре.

   ЖИВОЙ МОСТ НУЖЕН — и только undoEdit. Журнал отката живёт в main.js (снимки
   текущего прогона — отдельно от сохранённого на диске), поэтому модуль получает
   его вторым аргументом `live`: чтение `live.activeRunUndo` / `live.lastUndoLog`
   и запись через сеттеры (`live.activeRunUndo = …`), чтобы не завести копию
   состояния: копия здесь означала бы «откат не видит правок прогона».

   ПОЧЕМУ ССЫЛКИ, А НЕ СПРЕД. Записи этих инструментов идут в реестре тремя
   несмежными кусками (createFolder; editFile; writeFile; undoEdit/refactorRename;
   applyPatch), поэтому в реестре на прежнем месте каждой записи осталась ссылка
   `"writeFile": write.writeFile,` — порядок инструментов сохранён ровно.
   Тела перенесены ПОБАЙТОВО (сверка `fn.toString()` до/после).

   Модуль чистый: Electron не тянет, состояния уровня файла не держит — его можно
   проверить в обычном Node. */
// ── Проверка записанного файла ────────────────────────────────────────────
// Проверяем то, что действительно проверяется на этой машине: синтаксис JS (тем
// же Node, что запущен) и разбор JSON. Картинки и архивы проверять нечем —
// честно молчим, а не делаем вид, что проверили.
const CHECK_CODE_EXT = { ".js": 1, ".mjs": 1, ".cjs": 1, ".jsx": 1 };

function checkWrittenFile(file, content) {
  const pathMod = require("path");
  const ext = pathMod.extname(String(file || "")).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(String(content == null ? "" : content));
      return { checked: true, problem: "" };
    } catch (e) {
      return { checked: true, problem: "JSON не разбирается: " + String((e && e.message) || e).slice(0, 200) };
    }
  }
  if (!CHECK_CODE_EXT[ext]) return { checked: false, problem: "" };
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync(process.execPath, ["--check", file], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    if (r.status === 0) return { checked: true, problem: "" };
    const msg = String(r.stderr || r.stdout || "").trim().split("\n").slice(0, 4).join(" ");
    return { checked: true, problem: "синтаксис не проходит (node --check): " + msg.slice(0, 300) };
  } catch (e) {
    return { checked: false, problem: "" }; // проверка не запустилась — не выдумываем ошибку
  }
}

// Что нужно, чтобы файл вообще запустился: без этой строки агент считает работу
// законченной, а скрипт падает на машине без нужного окружения.
function envNoteFor(file) {
  const pathMod = require("path");
  const fsMod = require("fs");
  const ext = pathMod.extname(String(file || "")).toLowerCase();
  if (!CHECK_CODE_EXT[ext] && ext !== ".py" && ext !== ".sh") return "";
  if (ext === ".py") {
    return "\nДля запуска нужен Python 3; библиотеки ставить через pip, список — в requirements.txt. Секреты и ключи — в Настройки → Секреты (не в код). Запуск: runCommand.";
  }
  if (ext === ".sh") {
    return "\nДля запуска нужен bash/sh (на Windows — Git Bash или WSL). Запуск: runCommand.";
  }
  let hasDeps = false;
  try {
    hasDeps = fsMod.existsSync(pathMod.join(pathMod.dirname(file), "node_modules"));
  } catch (e) {}
  return (
    "\nДля запуска нужен Node.js (или bun)." +
    (hasDeps
      ? " Зависимости рядом есть (node_modules)."
      : " Зависимостей рядом нет (node_modules): если скрипту нужны библиотеки — сначала installPackage; ключи и токены — в Настройки → Секреты, а не в код.") +
    (/\.jsx$/.test(ext) ? " Файл .jsx без сборки Node не запустит — нужен инструмент сборки." : " Запуск: runCommand.")
  );
}

function createWriteTools(deps, live) {
  const {
    fs,
    path,
    resolvePath,
    agentWorkDir,
    selfDev,
    ota,
    snapshotFileForUndo,
    unifiedPatch,
    loadPersistedUndo,
    persistUndo,
    truncateText,
    refactorRenameFiles,
  } = deps;

  return {
    "createFolder": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        fs.mkdirSync(p, { recursive: true });
        return "OK — папка создана: " + p;
    },
    "editFile": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
        const newText = String(args.newText ?? "");
        const content = fs.readFileSync(p, "utf8");
        // Режим 2: замена диапазона строк по номерам (startLine..endLine) — для больших файлов
        const startLine = parseInt(args.startLine, 10);
        if (Number.isInteger(startLine) && startLine >= 1) {
          const endLine = Number.isInteger(parseInt(args.endLine, 10)) ? Math.max(startLine, parseInt(args.endLine, 10)) : startLine;
          const all = content.split("\n");
          if (startLine > all.length) return "Ошибка: startLine=" + startLine + " больше числа строк файла (" + all.length + ").";
          if (endLine > all.length) return "Ошибка: endLine=" + endLine + " больше числа строк файла (" + all.length + ").";
          snapshotFileForUndo(p);
          const before = all.slice(0, startLine - 1);
          const after = all.slice(endLine); // endLine включительно — берём всё после неё
          const updated = before.concat(newText === "" ? [] : newText.split("\n"), after).join("\n");
          fs.writeFileSync(p, updated, "utf8");
          const replaced = endLine === startLine ? "строку " + startLine : "строки " + startLine + "–" + endLine;
          return "OK — заменены " + replaced + " (" + (endLine - startLine + 1) + " стр." + (endLine === startLine ? "а" : "") + " → " + newText.split("\n").length + " стр.) в " + p;
        }
        const oldText = String(args.oldText ?? "");
        if (!oldText) return "Ошибка: укажи oldText (режим точной замены) или startLine (режим замены строк по номерам).";
        const lineOf = (idx) => content.slice(0, idx).split("\n").length;
        const positions = [];
        let from = 0;
        while (from <= content.length - oldText.length) {
          const idx = content.indexOf(oldText, from);
          if (idx === -1) break;
          positions.push(idx);
          from = idx + oldText.length;
        }
        if (!positions.length) {
          return "Ошибка: фрагмент для замены не найден в файле. Перечитай файл (readFile / readFileLines) и повтори с точным текстом, включая отступы.";
        }
        const occurrence = parseInt(args.occurrence, 10);
        if (positions.length > 1 && !args.replaceAll && !Number.isInteger(occurrence)) {
          const lines = positions.map(lineOf).join(", ");
          return "Ошибка: фрагмент встречается " + positions.length + " раз (строки: " + lines + "). Уточни контекст в oldText (добавь окружающие строки), укажи occurrence (номер вхождения, например 2) или replaceAll=true.";
        }
        snapshotFileForUndo(p);
        let updated, where;
        if (args.replaceAll) {
          updated = content.split(oldText).join(newText);
          where = "вхождений: " + positions.length;
        } else {
          const idx = Number.isInteger(occurrence) && occurrence >= 1
            ? positions[Math.min(occurrence, positions.length) - 1]
            : positions[0];
          updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
          where = "строка " + lineOf(idx) + (positions.length > 1 ? " (вхождение " + (positions.indexOf(idx) + 1) + " из " + positions.length + ")" : "");
        }
        fs.writeFileSync(p, updated, "utf8");
        return "OK — заменено (" + where + ") в " + p;
    },
    "writeFile": async (args, settings) => {
        if (!args.path) return "Ошибка: укажи path";
        const p = resolvePath(args.path, settings);
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
        const content = String(args.content ?? "");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const existed = fs.existsSync(p);
        fs.writeFileSync(p, content, "utf8");
        const lines = content ? content.split("\n").length : 0;
        const sizeNote = content ? ", " + content.length + " символов" : "";
        // Проверка сразу после записи: «успешно сохранённый» сломанный файл агент
        // находит через десять шагов, когда что-то не запускается.
        const check = args.check === false ? { checked: false, problem: "" } : checkWrittenFile(p, content);
        const checkNote =
          args.check === false
            ? ""
            : check.problem
              ? "\n⚠ Проверка после записи: " + check.problem + "\nФайл записан, но он сломан — почини его следующим writeFile и только потом запускай."
              : check.checked
                ? "\nПроверка после записи: ок."
                : "";
        return "OK — файл " + (existed ? "перезаписан" : "создан") + ": " + p + " (" + lines + " строк" + sizeNote + ")" + checkNote + envNoteFor(p);
    },
    "undoEdit": async (args, settings) => {
        loadPersistedUndo();
        const p = args.path ? resolvePath(args.path, settings) : null;
        if (!p) {
          if (!live.lastUndoLog.length && !live.activeRunUndo.length) return "Нет изменений для отката (undo-журнал пуст).";
          const counts = new Map();
          // НАЙДЕНО И ИСПРАВЛЕНО (часть 40, заход 3b): здесь стояли голые
          // activeRunUndo / lastUndoLog — в строгом режиме это ReferenceError, то есть
          // undoEdit БЕЗ path падал ровно тогда, когда журнал непустой (агент просил
          // «что можно откатить» после своих же правок). Теперь через живой мост.
          for (const u of [...live.activeRunUndo, ...live.lastUndoLog]) counts.set(u.path, (counts.get(u.path) || 0) + 1);
          return "Можно откатить (по одному — undoEdit(path), шагами — undoEdit(path, steps: N)):\n" +
            [...counts.entries()].map(([f, c]) => "• " + f + (c > 1 ? " — шагов в истории: " + c : "")).join("\n");
        }
        // Снимки файла: сначала свежие из текущего запуска, затем из сохранённого журнала.
        const snaps = [];
        for (let i = live.activeRunUndo.length - 1; i >= 0; i--) if (live.activeRunUndo[i].path === p) snaps.push(live.activeRunUndo[i]);
        for (let i = live.lastUndoLog.length - 1; i >= 0; i--) if (live.lastUndoLog[i].path === p) snaps.push(live.lastUndoLog[i]);
        if (!snaps.length) return "Нет снимка для отката: " + p + " (агент не менял этот файл в последних запусках).";
        const steps = Math.min(Math.max(parseInt(args.steps, 10) || 1, 1), snaps.length);
        const popped = snaps.slice(0, steps); // снимаем steps самых свежих
        const target = popped[popped.length - 1]; // возвращаемся к состоянию до самой ранней из откатываемых правок
        try {
          if (target.content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } else {
            fs.writeFileSync(p, target.content, "utf8");
          }
        } catch (e) {
          return "Ошибка отката: " + (e.message || String(e));
        }
        const gone = new Set(popped);
        live.activeRunUndo = live.activeRunUndo.filter((u) => !gone.has(u));
        live.lastUndoLog = live.lastUndoLog.filter((u) => !gone.has(u));
        persistUndo();
        const how = popped.length === 1 ? "последнюю правку агента" : popped.length + " правки агента";
        return target.content === null
          ? "OK — файл удалён (он был создан агентом): " + p
          : "OK — файл откачен на " + how + " назад: " + p + " (снимков осталось: " + Math.max(0, snaps.length - popped.length) + ")";
    },
    "refactorRename": async (args, settings) => {
        const oldName = String(args.oldName || "").trim();
        const newName = String(args.newName || "").trim();
        const dryRun = !!args.dryRun;
        const root = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(root)) return "Ошибка: не найден путь: " + root;
        const r = refactorRenameFiles(root, oldName, newName, dryRun);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.changed.length) return "Совпадений «" + oldName + "» не найдено" + (args.path ? " в " + args.path : " по проекту") + ".";
        const head = dryRun
          ? "🔍 dryRun — ничего не изменено. Будет заменено «" + oldName + "» → «" + newName + "» (" + r.total + " вхожд.):"
          : "OK — заменено " + r.total + " вхожд. «" + oldName + "» → «" + newName + "» в " + r.changed.length + " файлах:";
        const lines = r.changed.slice(0, 40).map((c) => "• " + c.rel + " — " + c.count + " вхожд." + (c.sample ? "\n    " + c.sample : ""));
        return truncateText(head + "\n" + lines.join("\n") + (r.changed.length > 40 ? "\n… и ещё " + (r.changed.length - 40) + " файлов" : ""), 9000);
    },
    "applyPatch": async (args, settings) => {
        const patch = String(args.patch ?? "");
        if (!patch.trim()) return "Ошибка: укажи patch — unified diff (формат git diff) с изменениями файлов.";
        const base = args.basePath ? resolvePath(args.basePath, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: базовой директории нет: " + base;
        // Снимаем undo-снимки для всех файлов, которые затронет патч.
        for (const f of unifiedPatch.parsePatch(patch)) {
          const rel = unifiedPatch.safeRel(base, f.b || f.a);
          if (!rel) continue;
          const abs = path.join(base, rel);
          if (selfDev.protectedSelfPath(abs, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
            return "⛔ Патч затрагивает защищённый файл самообновления: " + abs + "\nПравка src/bootstrap.js, src/ota.js или папки применённого OTA-бандла заблокирована — убери этот файл из патча.";
          }
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) snapshotFileForUndo(abs);
        }
        const r = unifiedPatch.applyUnifiedPatch(base, patch);
        if (!r.ok) {
          return "Ошибка применения патча:\n" + r.errors.map((e) => "• " + e.path + " — " + e.error).join("\n") +
            "\n\nПеречитай файлы (readFile) и сгенерируй патч заново с точным контекстом, либо правь файлы по одному через editFile.";
        }
        return "OK — патч применён, изменено файлов: " + r.changed.length + (r.changed.length ? "\n" + r.changed.map((f) => "• " + f).join("\n") : "");
    },
  };
}

module.exports = { createWriteTools };

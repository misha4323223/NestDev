"use strict";

/* ─── Инструменты агента: файлы — чтение и поиск ─────────────────────────────
   Вынесены из agent-tools.js своим модулем (этап «дробление крупных модулей»,
   часть 40, заход 3a): чтение и разбор файлов проекта — readFile, readFileLines,
   fileOutline, listFiles, listDirectory, searchProject, searchFile,
   readFileStructure, explainCode и findReferences. Запись и правки (writeFile,
   editFile, applyPatch, undoEdit…) остаются в реестре и уедут сюда же в
   подэтапе 3b: им нужны откат правок и облачный/свой код, то есть отдельный
   разбор.

   ПОЧЕМУ ССЫЛКИ, А НЕ СПРЕД. Записи этих инструментов идут в реестре тремя
   несмежными кусками (readFile/readFileLines; searchFile…explainCode;
   findReferences), поэтому в реестре на прежнем месте каждой записи осталась
   ссылка `"readFile": files.readFile,` — порядок инструментов сохранён ровно.
   Тела перенесены ПОБАЙТОВО (сверка `fn.toString()` до/после).

   Мост живых значений модулю не нужен вовсе: ни один из этих обработчиков не
   читает и не пишет состояние прогона. Всё нужное приходит в `deps` тем же
   плоским объектом, что и в agent-tools.js.

   Модуль чистый: Electron не тянет, состояния уровня файла не держит — его
   можно проверить в обычном Node. */

function createFileTools(deps) {
  const {
    fs,
    path,
    resolvePath,
    agentWorkDir,
    numberedLines,
    langFromExt,
    buildFileOutline,
    buildBlockRanges,
    buildFileStructure,
    findSymbolReferences,
    listProjectFiles,
    searchProjectFiles,
    guideSafeName,
    guideFilePath,
    guideIndex,
    truncateText,
  } = deps;

  return {
    "readFile": async (args, settings) => {
        // Специальный путь для встроенных справочников агента (не файлы проекта):
        // readFile(path: "agent-guide:vk") → полный гайд по работе с ВКонтакте.
        const guidePath = String(args.path || "").trim();
        if (guidePath.startsWith("agent-guide:")) {
          const guideName = guideSafeName(guidePath);
          const guideFile = guideFilePath(guideName, false);
          if (guideFile) {
            return "СПРАВОЧНИК АГЕНТА: «" + guideName + "» (прочитай перед работой и следуй ему):\n\n" + fs.readFileSync(guideFile, "utf8");
          }
          const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
          return "Ошибка: справочник «" + guideName + "» не найден. Есть: " + list + ". Список в любой момент: agentGuide {}.";
        }
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Используй fileOutline для структуры и readFileLines для чтения по частям.";
        let content = fs.readFileSync(p, "utf8");
        const lines = content.split("\n");
        // Большой файл — краткий обзор вместо выгрузки целиком (экономия токенов)
        if (lines.length > 800) {
          const head = numberedLines(lines, 1, Math.min(60, lines.length), lines.length);
          const tail = numberedLines(lines, Math.max(1, lines.length - 14), lines.length, lines.length);
          const outline = buildFileOutline(content, null, 200);
          return (
            "Файл большой: " + lines.length + " строк, " + st.size + " байт (" + langFromExt(p) + ").\n" +
            "Не читай его целиком: используй fileOutline (структура), searchFile (поиск с context) и readFileLines (диапазон).\n\n" +
            "─ СТРУКТУРА (первые " + outline.entries.length + " определений):\n" + outline.text + "\n\n" +
            "─ НАЧАЛО ФАЙЛА:\n" + head + "\n\n" +
            "─ КОНЕЦ ФАЙЛА:\n" + tail
          );
        }
        return "Содержимое " + p + " (" + lines.length + " строк):\n" + content;
    },
    "readFileLines": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const start = Math.max(1, parseInt(args.start, 10) || 1);
        const count = Math.min(500, Math.max(1, parseInt(args.count, 10) || 100));
        const from = start - 1;
        const chunk = all.slice(from, from + count);
        if (!chunk.length) return "Файл закончился раньше строки " + start + ". Всего строк: " + all.length;
        const numbered = chunk.map((line, i) => {
          const n = start + i;
          return String(n).padStart(String(all.length).length, " ") + " | " + line;
        });
        return "Строки " + start + "–" + (start + chunk.length - 1) + " из " + all.length + " файла " + p + ":\n" + numbered.join("\n");
    },
    "searchFile": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const pattern = String(args.pattern || args.regex || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 40, 100);
        const context = Math.min(Math.max(parseInt(args.context, 10) || 0, 0), 40);
        const blocks = args.blocks === true || args.blocks === "true" || args.blocks === "1" || args.blocks === 1;
        let re = null;
        try {
          re = new RegExp(pattern, args.caseSensitive ? "" : "i");
        } catch {}
        const all = fs.readFileSync(p, "utf8").split("\n");
        const hits = [];
        let total = 0;
        for (let i = 0; i < all.length; i++) {
          const line = all[i];
          if (re ? re.test(line) : line.includes(pattern)) {
            total++;
            if (hits.length < maxResults) hits.push({ n: i + 1, text: line.trim().slice(0, 300) });
          }
        }
        if (!total) return "Совпадений по «" + pattern + "» в " + p + " нет.";
        const pad = String(all.length).length;
        let shown;
        if (blocks) {
          // Режим «блоками»: вместо отдельных строк показываем целиком enclosing-определения
          // (функции/классы/методы и т.п. по OUTLINE_RULES) с диапазоном строк.
          const ranges = buildBlockRanges(all);
          const byBlock = new Map();
          for (const h of hits) {
            let owner = null;
            for (const r of ranges) {
              if (r.start > h.n) break;
              if (h.n <= r.end) owner = r; // последний подходящий = самый вложенный
            }
            if (!owner) owner = { start: h.n, end: h.n, kind: "строка", name: "строка " + h.n };
            const key = owner.start + "|" + owner.name;
            if (!byBlock.has(key)) byBlock.set(key, { owner, hits: [] });
            byBlock.get(key).hits.push(h);
          }
          const MAX_BLOCK_LINES = 120;
          const blockCap = Math.min(maxResults, 20); // блоки крупнее строк — лимит строже
          const lines = [];
          let blocksShown = 0;
          for (const { owner, hits: hh } of byBlock.values()) {
            if (blocksShown >= blockCap) break;
            blocksShown++;
            const from = owner.start;
            const to = Math.min(owner.end, from + MAX_BLOCK_LINES - 1);
            const hitSet = new Set(hh.map((x) => x.n));
            lines.push("── " + owner.kind + " " + owner.name + " (строки " + owner.start + "–" + to + (to < owner.end ? "+" : "") + ") ──");
            for (let i = from; i <= to; i++) {
              lines.push((hitSet.has(i) ? ">" : " ") + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            if (to < owner.end) lines.push("        … (блок обрезан: ещё " + (owner.end - to) + " строк)");
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано блоков: " + blocksShown + " (blocks: true):\n" + truncateText(lines.join("\n"), 9000) + more;
        }
        if (context > 0) {
          // Окна вокруг совпадений: строки context до и после, с отметкой > для самой строки
          shown = [];
          let prevEnd = 0;
          for (const h of hits) {
            const from = Math.max(1, h.n - context);
            const to = Math.min(all.length, h.n + context);
            if (from > prevEnd + 1) shown.push("        … (пропущено)");
            for (let i = from; i <= to; i++) {
              const mark = i === h.n ? ">" : " ";
              shown.push(mark + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            prevEnd = to;
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + " (контекст ±" + context + " строк):\n" + shown.join("\n") + more;
        }
        shown = hits.map((h) => String(h.n).padStart(pad, " ") + " | " + h.text);
        const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
        return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + ":\n" + shown.join("\n") + more;
    },
    "fileOutline": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const content = fs.readFileSync(p, "utf8");
        const filter = String(args.pattern || "").trim();
        const res = buildFileOutline(content, filter || null, 300);
        if (!res.entries.length) {
          return filter
            ? "В структуре " + p + " нет определений, совпадающих с «" + filter + "»."
            : "Определений (функции/классы/заголовки) в " + p + " не найдено. Файл: " + content.split("\n").length + " строк, " + st.size + " байт.";
        }
        return "Структура " + p + " (" + content.split("\n").length + " строк) — " + res.entries.length + " определений" + (filter ? " по фильтру «" + filter + "»" : "") + ":\n" + res.text;
    },
    "listFiles": async (args, settings) => {
        return listProjectFiles(settings, args.path);
    },
    "searchProject": async (args, settings) => {
        const pattern = String(args.pattern || args.regex || args.query || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        return searchProjectFiles(pattern, settings, args.path);
    },
    "listDirectory": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: папка не найдена: " + p;
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? "[папка] " : "[файл]  ") + e.name);
        return "Содержимое " + p + " (" + entries.length + "):\n" + lines.slice(0, 500).join("\n");
    },
    "readFileStructure": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const r = buildFileStructure(p, args.pattern);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.rows.length) return "В файле не найдено импортов/экспортов/объявлений" + (args.pattern ? " по фильтру «" + args.pattern + "»" : "") + ": " + p;
        const pad = String(r.totalLines).length;
        const text = r.rows.map((x) => String(x.line).padStart(pad, " ") + " | " + x.kind.padEnd(6, " ") + " | " + x.text).join("\n");
        return "Структура " + p + " (" + r.totalLines + " строк, показано " + r.rows.length + "):\n" + truncateText(text, 9000) + "\n\nФрагмент читай через readFileLines(path, start, count).";
    },
    "explainCode": async (args, settings) => {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Смотри структуру через fileOutline, фрагменты — readFileLines.";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const total = all.length;
        const blocks = buildBlockRanges(all);
        const pad = String(total).length;
        const capWindow = 220; // максимум строк в одном окне
        const focus = { how: "весь файл (по умолчанию — начало)", start: 1, end: Math.min(total, 120) };
        if (args.symbol) {
          const sym = String(args.symbol).trim();
          const hits = blocks.filter((b) => sym && b.name && b.name.toLowerCase().includes(sym.toLowerCase()));
          if (!hits.length) {
            const outline = buildFileOutline(all.join("\n"), null, 300);
            return "Не нашёл определение по имени «" + sym + "» в " + p + ". Структура файла:\n" + outline.text +
              "\n\nУкажи точное имя (fileOutline / searchFile blocks:true помогут найти) или строку через line.";
          }
          const b = hits[0];
          focus.how = "символ «" + sym + "» → блок «" + b.name + "» (" + b.kind + ", строки " + b.start + "–" + b.end + ")" +
            (hits.length > 1 ? "; есть ещё совпадения на строках " + hits.slice(1).map((x) => x.start).join(", ") : "");
          focus.start = b.start;
          focus.end = b.end;
        } else if (args.line != null || args.start != null) {
          const raw = parseInt(args.line != null ? args.line : args.start, 10);
          const want = Math.max(1, Math.min(raw || 1, total));
          if (args.endLine != null) {
            focus.how = "строки " + want + "–" + Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
            focus.start = want;
            focus.end = Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
          } else {
            // Без endLine расширяем до границ enclosing-блока (функция/класс/метод по OUTLINE_RULES)
            let enc = null;
            for (const b of blocks) if (b.start <= want) enc = b;
            if (enc) {
              focus.how = "строка " + want + " → внутри блока «" + enc.name + "» (" + enc.kind + ", строки " + enc.start + "–" + enc.end + ")";
              focus.start = enc.start;
              focus.end = enc.end;
            } else {
              focus.how = "строка " + want + " (вне определений — показано ±24 строки)";
              focus.start = want;
              focus.end = Math.min(total, want + 24);
            }
          }
        }
        if (focus.end - focus.start + 1 > capWindow) {
          focus.end = focus.start + capWindow - 1;
          focus.how += " (обрезано до " + capWindow + " строк — сузь диапазон endLine)";
        }
        // Импорты в шапке файла — до первой «рабочей» строки кода
        const imports = [];
        for (let i = 0; i < Math.min(total, 80); i++) {
          const t = all[i].trim();
          if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#") || t.startsWith("<!--")) continue;
          if (/^(import\b|from\s+["']|require\(|#include|use\s+[A-Za-z_:]+;|package\s+[A-Za-z_])/.test(t)) {
            imports.push(String(i + 1).padStart(pad, " ") + " | " + all[i].trim().slice(0, 110));
            if (imports.length >= 25) break;
          } else if (imports.length) {
            break; // импорты кончились
          }
        }
        const inside = buildFileOutline(all.join("\n"), null, 400).entries.filter((e) => e.line >= focus.start && e.line <= focus.end);
        const win = numberedLines(all, focus.start, focus.end, total);
        const out = [];
        out.push("Файл " + p + " (" + langFromExt(p) + ", " + total + " строк, " + st.size + " байт)");
        out.push("Запрос: " + focus.how);
        if (imports.length) out.push("\nИмпорты/зависимости (шапка файла, " + imports.length + "):\n" + imports.join("\n"));
        out.push("\nКод (строки " + focus.start + "–" + focus.end + "):\n" + win);
        if (inside.length) {
          out.push("\nВ этом окне определено:\n" + inside.map((e) => String(e.line).padStart(pad, " ") + " | " + e.kind.padEnd(8, " ") + " | " + e.name).join("\n"));
        }
        const markers = [];
        for (let i = focus.start - 1; i < focus.end && i < all.length; i++) {
          const t = all[i] || "";
          if (/TODO|FIXME|HACK|XXX/.test(t)) markers.push(String(i + 1).padStart(pad, " ") + " | " + t.trim().slice(0, 100));
        }
        if (markers.length) out.push("\nМаркеры TODO/FIXME в окне:\n" + markers.join("\n"));
        out.push("\nОбъясни пользователю этот код своими словами. Больше контекста: fileOutline (структура), readFileLines (другой диапазон), searchFile с blocks:true, findReferences (где используется).");
        return truncateText(out.join("\n"), 16000);
    },
    "findReferences": async (args, settings) => {
        const symbol = String(args.symbol || "").trim();
        if (!symbol) return "Ошибка: укажи symbol (имя функции/переменной/класса)";
        let root = agentWorkDir(settings);
        if (args.path) {
          const rp = resolvePath(args.path, settings);
          if (!fs.existsSync(rp)) return "Ошибка: путь не найден: " + rp;
          root = rp;
        }
        const r = findSymbolReferences(root, symbol);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.hits.length) return "Использований «" + symbol + "» не найдено в " + root + ".";
        const files = new Set(r.hits.map((h) => h.file));
        const defs = r.hits.filter((h) => h.kind === "определение").length;
        const calls = r.hits.filter((h) => h.kind === "вызов").length;
        const mark = { "определение": "◈", "импорт": "⤓", "вызов": "▸", "ссылка": "·" };
        const pad = String(Math.max(...r.hits.map((h) => h.n))).length;
        const text = r.hits.map((h) => (mark[h.kind] || "·") + " " + h.file + ":" + String(h.n).padStart(pad, " ") + "  [" + h.kind + "] " + h.text).join("\n");
        return "Символ «" + symbol + "» — " + r.hits.length + " вхожд. в " + files.size + " файл. (◈ определений: " + defs + ", ▸ вызовов: " + calls + ")\n\n" + truncateText(text, 9000);
    },
  };
}

module.exports = { createFileTools };

"use strict";

/* ─── Инструменты таблиц агента: файл Excel и Google Sheets ───────────────────
   Своим модулем (дом инструментов, как остальные `agent-tools-*.js`). Здесь семь
   обработчиков, которыми «Менеджер» делает то, чего ему не хватало: собрать отчёт
   в НАСТОЯЩИЙ .xlsx, прочитать таблицу и вести общую Google-таблицу.

     • sheetWrite — создать/перезаписать таблицу файлом (.xlsx своим писателем
       src/xlsx.js или .csv; строки, объекты или CSV-текст);
     • sheetRead — прочитать таблицу из файла (.xlsx/.csv) и показать её модели;
     • gSheetRead / gSheetWrite / gSheetAppend / gSheetInfo / gSheetCreate —
       Google Sheets через service account (src/google-sheets.js).

   ГИБРИД. Если ключа Google нет, gSheet*-инструменты НЕ падают молча: они
   возвращают модели точный рецепт браузерного пути — открыть таблицу браузером
   агента, войти по записи менеджера паролей (vaultFill) и править ячейки
   browserText/browserEval. Это тот самый «запасной путь живой сессией»: ноль
   настройки, работает на аккаунте человека.

   Почему тела такие короткие. Вся логика — в src/xlsx.js и src/google-sheets.js;
   здесь только разбор аргументов, отчёт модели и честные отказы. Живого моста не
   нужно: рабочая папка берётся в момент вызова (agentWorkDir/resolvePath), ключ
   читается из настроек (settings.googleServiceAccount) на каждый вызов.

   Тела обработчиков — обычные функции, поэтому модуль проверяется в plain-node. */

const { xlsxWrite, xlsxRead, findSheet } = require("./xlsx.js");
const gsheets = require("./google-sheets.js");

function createSheetsTools(deps) {
  const { fs, path, resolvePath, agentWorkDir, truncateText } = deps;

  const MAX_ROWS = 5000; // предел строк в файле/диапазоне
  const MAX_COLS = 60; // предел колонок
  const MAX_SHOWN_ROWS = 200; // сколько строк показываем модели
  const MAX_CELL = 2000; // предел длины одной ячейки

  const clip = (v) => String(v == null ? "" : v).slice(0, MAX_CELL);

  // ── Разбор данных ─────────────────────────────────────────────────────────
  // CSV-текст → строки. Терпимо к кавычкам, запятым в кавычках и CRLF.
  function csvParse(text) {
    const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; }
          else quoted = false;
        } else cell += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(cell); cell = "";
      } else if (ch === "\n") {
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function csvStringify(rows) {
    const one = (v) => {
      const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return (rows || []).map((r) => (Array.isArray(r) ? r : [r]).map(one).join(",")).join("\r\n");
  }

  // Любой вход → двумерный массив. Принимает: 2D-массив, массив объектов,
  // CSV/TSV-строку. У объектов шапка собирается из ключей ПЕРВОГО объекта.
  function toRows(input) {
    if (input == null) return [];
    if (typeof input === "string") {
      const t = input.trim();
      if (!t) return [];
      return /[\t]/.test(t) && !/,/.test(t.split("\n")[0])
        ? t.split(/\r?\n/).map((l) => l.split("\t"))
        : csvParse(t);
    }
    if (!Array.isArray(input)) return [];
    if (!input.length) return [];
    if (typeof input[0] === "object" && input[0] !== null && !Array.isArray(input[0])) {
      const keys = Object.keys(input[0]);
      const rows = [keys];
      for (const o of input) rows.push(keys.map((k) => (o && o[k] != null ? o[k] : "")));
      return rows;
    }
    // Числа и булевы НЕ превращаем в строки: иначе в Excel данные лежат текстом
    // и не считаются формулами. Строки режем, остальное пропускаем как есть.
    const cell = (c) => (typeof c === "number" || typeof c === "boolean" ? c : clip(c));
    return input.map((r) => (Array.isArray(r) ? r.map(cell) : [cell(r)]));
  }

  function normalizeSheetRows(rows) {
    const out = [];
    for (const r of (rows || []).slice(0, MAX_ROWS)) {
      const cells = (Array.isArray(r) ? r : [r]).slice(0, MAX_COLS).map((c) => (typeof c === "number" || typeof c === "boolean" ? c : clip(c)));
      out.push(cells);
    }
    return out;
  }

  // Таблица для модели: шапка, разделитель, строки. Колонки выравниваем.
  function formatTable(rows, limit) {
    const max = Math.min(limit || MAX_SHOWN_ROWS, MAX_SHOWN_ROWS);
    const shown = (rows || []).slice(0, max);
    if (!shown.length) return "(пусто)";
    const width = Math.min(MAX_COLS, Math.max(...shown.map((r) => (Array.isArray(r) ? r.length : 1))));
    const cells = shown.map((r) => {
      const a = Array.isArray(r) ? r : [r];
      const out = [];
      for (let i = 0; i < width; i++) out.push(String(a[i] == null ? "" : a[i]).replace(/[\r\n]+/g, " ").slice(0, 60));
      return out;
    });
    const widths = [];
    for (let i = 0; i < width; i++) widths[i] = Math.max(1, ...cells.map((r) => r[i].length));
    const line = (r) => r.map((c, i) => c.padEnd(widths[i])).join(" | ");
    const out = [line(cells[0])];
    if (cells.length > 1) out.push(widths.map((w) => "-".repeat(w)).join("-+-"));
    for (let i = 1; i < cells.length; i++) out.push(line(cells[i]));
    if (rows.length > shown.length) out.push("… (показано " + shown.length + " из " + rows.length + " строк)");
    return out.join("\n");
  }

  function rowsToObjects(rows) {
    if (!rows || !rows.length) return [];
    const head = (rows[0] || []).map((h, i) => String(h == null || h === "" ? "col" + (i + 1) : h));
    return rows.slice(1).map((r) => {
      const o = {};
      head.forEach((k, i) => { o[k] = r[i] == null ? "" : r[i]; });
      return o;
    });
  }

  // ── Google: ключ и запасной путь ──────────────────────────────────────────
  function googleKey(settings) {
    return gsheets.parseServiceAccount(settings && settings.googleServiceAccount);
  }

  // Без ключа инструмент не молчит: он отдаёт модели рабочий рецепт браузером.
  function googleFallback(what) {
    return (
      "Google-ключа нет (Настройки → Таблицы → «Ключ service account»). " + what + " можно сделать и БЕЗ ключа — браузером агента:\n" +
      "1) browserOpen с адресом таблицы;\n" +
      "2) если просит вход — vaultFill (site: \"Google\"/\"docs.google.com\") или войди руками один раз (профиль запомнит сессию);\n" +
      "3) читай содержимое browserText/browserDOM, правь ячейки browserClick/browserFill, пересчитай browserEval.\n" +
      "Надёжнее и быстрее — ключ: он открывает доступ к таблице по API без окна браузера (таблицу надо расшарить на e-mail сервис-аккаунта)."
    );
  }

  function needKey(settings, what) {
    const key = googleKey(settings);
    if (key) return { key };
    return { error: googleFallback(what) };
  }

  function sheetRef(args) {
    const id = gsheets.sheetIdFromArg(args.spreadsheet || args.url || args.id);
    if (!id) return { error: "Ошибка: укажи таблицу ссылкой или id (spreadsheet). Пример: https://docs.google.com/spreadsheets/d/<id>/edit" };
    return { id };
  }

  // Человеческий разбор отказа API (общий для всех gSheet*-инструментов).
  function explainGoogleError(e, id) {
    const msg = String((e && e.message) || e);
    if (/403|permission|PERMISSION_DENIED/i.test(msg)) {
      return "Ошибка доступа к таблице: " + msg + "\nПроверь, что таблица РАСШАРЕНА на e-mail сервис-аккаунта (роль «Редактор»). id: " + id;
    }
    if (/404|not found|NOT_FOUND/i.test(msg)) {
      return "Таблица не найдена: " + msg + "\nПроверь ссылку/id" + (id ? " (" + id + ")" : "") + ".";
    }
    return "Ошибка Google Sheets: " + msg;
  }

  return {
    // ── Файл: запись ────────────────────────────────────────────────────────
    sheetWrite: async (args, settings) => {
      const rawPath = String(args.path || "").trim();
      if (!rawPath) return "Ошибка: укажи path — куда сохранить таблицу (например report.xlsx).";
      const dest = resolvePath(rawPath, settings);
      let format = String(args.format || "").toLowerCase().trim();
      if (!format) format = /\.csv$/i.test(dest) ? "csv" : "xlsx";
      if (format !== "csv" && format !== "xlsx") return "Ошибка: format — только xlsx или csv.";
      // Данные: либо sheets:[{name, rows}], либо один лист (rows / objects / CSV-текст).
      let sheets = [];
      if (Array.isArray(args.sheets) && args.sheets.length) {
        sheets = args.sheets.map((s, i) => ({
          name: String((s && s.name) || (args.name || "Лист" + (i + 1))),
          rows: normalizeSheetRows(toRows(s && (s.rows || s.data || s.values))),
        }));
      } else {
        const src = args.rows != null ? args.rows : args.objects != null ? args.objects : args.data != null ? args.data : args.csv;
        const rows = normalizeSheetRows(toRows(src));
        if (!rows.length && !args.allowEmpty) return "Ошибка: нет данных. Передай rows (массив строк), objects (массив объектов) или csv (текст).";
        sheets = [{ name: String(args.name || "Лист1"), rows }];
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (format === "csv") {
          fs.writeFileSync(dest, csvStringify(sheets[0].rows), "utf8");
        } else {
          fs.writeFileSync(dest, xlsxWrite(sheets));
        }
      } catch (e) {
        return "Ошибка записи «" + dest + "»: " + String((e && e.message) || e);
      }
      const stat = (() => { try { return fs.statSync(dest).size; } catch { return 0; } })();
      const total = sheets.reduce((n, s) => n + s.rows.length, 0);
      return (
        "OK — таблица сохранена: " + dest + "\n" +
        "Формат: " + format + " (" + stat + " байт), листов: " + sheets.length + ", строк всего: " + total + "\n" +
        "Листы: " + sheets.map((s) => "«" + s.name + "» (" + s.rows.length + ")").join(", ") + "\n" +
        "Открыть: openPath(\"" + dest + "\")."
      );
    },

    // ── Файл: чтение ────────────────────────────────────────────────────────
    sheetRead: async (args, settings) => {
      const rawPath = String(args.path || "").trim();
      if (!rawPath) return "Ошибка: укажи path — файл таблицы (.xlsx/.csv).";
      const src = resolvePath(rawPath, settings);
      if (!fs.existsSync(src)) return "Ошибка: файла нет: " + src;
      let rows = [];
      let sheetName = "";
      try {
        if (/\.csv$/i.test(src)) {
          rows = csvParse(fs.readFileSync(src, "utf8"));
        } else {
          const book = xlsxRead(fs.readFileSync(src));
          const sheet = findSheet(book, args.sheet) || book.sheets[0];
          if (!sheet) return "Ошибка: в книге нет листов.";
          rows = sheet.rows || [];
          sheetName = sheet.name || "";
        }
      } catch (e) {
        return "Ошибка чтения «" + src + "»: " + String((e && e.message) || e);
      }
      const limit = Math.min(parseInt(args.limit, 10) || MAX_SHOWN_ROWS, MAX_SHOWN_ROWS);
      const head = sheetName ? "Лист «" + sheetName + "», " : "";
      const body = String(args.as || "").toLowerCase() === "json" ? JSON.stringify(rowsToObjects(rows), null, 1) : formatTable(rows, limit);
      return head + "строк: " + rows.length + "\n\n" + truncateText(body, 12000);
    },

    // ── Google: чтение ──────────────────────────────────────────────────────
    gSheetRead: async (args, settings) => {
      const ref = sheetRef(args);
      if (ref.error) return ref.error;
      const need = needKey(settings, "Чтение таблицы");
      if (need.error) return need.error;
      try {
        const r = await gsheets.readValues({ key: need.key, id: ref.id, range: String(args.range || "A1") });
        const limit = Math.min(parseInt(args.limit, 10) || MAX_SHOWN_ROWS, MAX_SHOWN_ROWS);
        const body = String(args.as || "").toLowerCase() === "json" ? JSON.stringify(rowsToObjects(r.values), null, 1) : formatTable(r.values, limit);
        return "Google-таблица " + ref.id + ", диапазон " + r.range + " (строк: " + r.values.length + ")\n\n" + truncateText(body, 12000);
      } catch (e) {
        return explainGoogleError(e, ref.id);
      }
    },

    // ── Google: перезапись диапазона ────────────────────────────────────────
    gSheetWrite: async (args, settings) => {
      const ref = sheetRef(args);
      if (ref.error) return ref.error;
      const need = needKey(settings, "Запись в таблицу");
      if (need.error) return need.error;
      const rows = normalizeSheetRows(toRows(args.values != null ? args.values : args.rows));
      if (!rows.length) return "Ошибка: нет данных (values — массив строк или массив объектов).";
      try {
        const r = await gsheets.updateValues({ key: need.key, id: ref.id, range: String(args.range || "A1"), values: rows });
        return "OK — записано в Google-таблицу " + ref.id + "\nДиапазон: " + (r.updatedRange || args.range || "A1") + ", ячеек: " + r.updatedCells + ".";
      } catch (e) {
        return explainGoogleError(e, ref.id);
      }
    },

    // ── Google: добавление строк ────────────────────────────────────────────
    gSheetAppend: async (args, settings) => {
      const ref = sheetRef(args);
      if (ref.error) return ref.error;
      const need = needKey(settings, "Добавление строк");
      if (need.error) return need.error;
      const rows = normalizeSheetRows(toRows(args.values != null ? args.values : args.rows));
      if (!rows.length) return "Ошибка: нет данных (values — массив строк или массив объектов).";
      try {
        const r = await gsheets.appendValues({ key: need.key, id: ref.id, range: String(args.range || "A1"), values: rows });
        return "OK — добавлено строк: " + (r.updatedRows || rows.length) + " (диапазон " + (r.updatedRange || args.range || "A1") + ").";
      } catch (e) {
        return explainGoogleError(e, ref.id);
      }
    },

    // ── Google: что за таблица ──────────────────────────────────────────────
    gSheetInfo: async (args, settings) => {
      const ref = sheetRef(args);
      if (ref.error) return ref.error;
      const need = needKey(settings, "Просмотр таблицы");
      if (need.error) return need.error;
      try {
        const info = await gsheets.spreadsheetInfo({ key: need.key, id: ref.id });
        const lines = info.sheets.map((s) => "• «" + s.title + "» — " + s.rows + "×" + s.cols);
        return "Таблица «" + (info.title || "?") + "»\nid: " + info.spreadsheetId + "\nЛисты:\n" + (lines.join("\n") || "(нет)") +
          "\n\nЧитать: gSheetRead { spreadsheet, range: \"Имя листа!A1:D20\" }.";
      } catch (e) {
        return explainGoogleError(e, ref.id);
      }
    },

    // ── Google: создать таблицу ─────────────────────────────────────────────
    gSheetCreate: async (args, settings) => {
      const title = String(args.title || "").trim();
      if (!title) return "Ошибка: укажи title — название новой таблицы.";
      const need = needKey(settings, "Создание таблицы");
      if (need.error) return need.error;
      try {
        const r = await gsheets.createSpreadsheet({ key: need.key, title });
        return "OK — создана Google-таблица «" + (r.title || title) + "»\nid: " + r.spreadsheetId + (r.url ? "\nСсылка: " + r.url : "") +
          "\n\nВажно: таблица принадлежит сервис-аккаунту. Чтобы её видел человек, открой ссылку и расшарь на свой аккаунт (или сразу пиши в неё через gSheetWrite).";
      } catch (e) {
        return explainGoogleError(e, "");
      }
    },
  };
}

module.exports = { createSheetsTools };

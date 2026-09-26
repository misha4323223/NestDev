"use strict";

/* ── Настоящий .xlsx без внешних библиотек ───────────────────────────────────
   Зачем свой писатель. `.xlsx` — это ZIP с несколькими XML-частями. Готовая
   библиотека (exceljs/xlsx) потребовала бы НОВОЙ зависимости, а её в поставку
   OTA не положить: `scripts/make-ota.js` кладёт в набор только `src/**`,
   `assets/**`, `package.json` и `server.js`, а `node_modules` пропускает —
   значит инструмент, которому нужна библиотека, работал бы у одних и падал у
   других до полного обновления. Здесь нужны только ЧИСТЫЙ `zlib` и строки, то
   есть весь код уезжает вместе с остальным `src`.

   Что умеем: записать книгу (несколько листов, строки/числа/булевы/пустые
   ячейки, строки встроенные — inlineStr, без sharedStrings) и прочитать книгу
   (свою и чужую: inlineStr, sharedStrings, числа, булевы). Формулы и стили
   осознанно не пишем — «создать таблицу под отчёт» их не требует, а тянуть
   styles.xml/sharedStrings ради галочки дороже, чем польза.

   Ошибки тихие и дорогие, поэтому:
     • CRC32 и ZIP-заголовки считаем сами — иначе Excel молча скажет «файл
       повреждён» и человек решит, что агент врёт;
     • XML экранируется (& < > ") — иначе & превратил бы книгу в мусор;
     • имя листа чистится (31 символ, без []:*?/\) — Excel не открывает книгу
       с недопустимым именем листа;
     • чтение терпимо к чужим книгам: чего не узнали — пропускаем, а не падаем.

   Модуль не требует electron и не пишет на диск — только Buffer→Buffer. */

const zlib = require("zlib");

// ── CRC32 (нужен каждой записи ZIP) ─────────────────────────────────────────
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── ZIP: упаковка/распаковка (только то, что нужно xlsx) ─────────────────────
// Даты DOS-формата: без них Excel ругается на «неизвестный» архив в части
// сборок. Берём дату по умолчанию (1980-01-01), она валидна всегда.
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

function dosDateTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time || DOS_TIME, date: date || DOS_DATE };
}

// Собрать ZIP из списка { name, data(Buffer) }. Метод — deflate (8).
function zipWrite(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(raw);
    const comp = zlib.deflateRawSync(raw);
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8); // flags
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30); // extra
    cen.writeUInt16LE(0, 32); // comment
    cen.writeUInt16LE(0, 34); // disk
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function zipRead(buf) {
  // Ищем EOCD от конца: комментарий ZIP бывает, поэтому не только последние 22 байта.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("не ZIP-архив (нет записи конца)");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    // Локальный заголовок: у него свои длины имени/extra.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
  }
  return out;
}

// ── XML ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Управляющие символы ломают XML — вырезаем (кроме таба/перевода строки).
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
function unesc(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

function colLetters(n) {
  let s = "";
  n = Math.max(0, parseInt(n, 10) || 0);
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
function nameToIndex(a1) {
  const m = /^([A-Za-z]+)(\d*)$/.exec(String(a1 || ""));
  if (!m) return { col: 0, row: 0 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: m[2] ? parseInt(m[2], 10) - 1 : 0 };
}

// Имя листа: Excel не открывает книгу с []:*?/\ в имени и длиннее 31 символа.
function safeSheetName(name, index) {
  let s = String(name == null ? "" : name).replace(/[\[\]:*?\/\\]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = "Лист" + (index + 1);
  return s.slice(0, 31);
}

// ── Запись книги ────────────────────────────────────────────────────────────
// sheets: [{ name, rows: [[cell, ...], ...] }]. Значение ячейки: строка | число |
// булево | Date | null/undefined (пустая).
function xlsxWrite(sheets) {
  const list = (Array.isArray(sheets) ? sheets : []).filter(Boolean);
  const book = list.length ? list : [{ name: "Лист1", rows: [] }];
  const parts = [];

  const sheetXml = (rows) => {
    const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
    (Array.isArray(rows) ? rows : []).forEach((row, r) => {
      const cells = Array.isArray(row) ? row : [row];
      if (!cells.some((c) => c !== null && c !== undefined && c !== "")) return; // пустая строка — не пишем
      const rowParts = [];
      cells.forEach((c, i) => {
        if (c === null || c === undefined || c === "") return;
        const ref = colLetters(i) + (r + 1);
        if (typeof c === "number" && Number.isFinite(c)) {
          rowParts.push('<c r="' + ref + '"><v>' + c + "</v></c>");
        } else if (typeof c === "boolean") {
          rowParts.push('<c r="' + ref + '" t="b"><v>' + (c ? 1 : 0) + "</v></c>");
        } else {
          const text = c instanceof Date ? c.toISOString() : String(c);
          rowParts.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(text) + "</t></is></c>");
        }
      });
      lines.push('<row r="' + (r + 1) + '">' + rowParts.join("") + "</row>");
    });
    lines.push("</sheetData></worksheet>");
    return lines.join("");
  };

  parts.push(["[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    book.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") +
    "</Types>"]);

  parts.push(["_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>"]);

  parts.push(["xl/workbook.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    book.map((s, i) => '<sheet name="' + esc(safeSheetName(s && s.name, i)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") +
    "</sheets></workbook>"]);

  parts.push(["xl/_rels/workbook.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    book.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") +
    "</Relationships>"]);

  book.forEach((s, i) => parts.push(["xl/worksheets/sheet" + (i + 1) + ".xml", sheetXml(s && s.rows)]));

  return zipWrite(parts.map((p) => ({ name: p[0], data: Buffer.from(p[1], "utf8") })));
}

// ── Чтение книги ────────────────────────────────────────────────────────────
// Терпимо к чужим книгам: возвращаем { sheets: [{ name, rows }] }.
function parseSharedStrings(files) {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  const xml = raw.toString("utf8");
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = "";
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += unesc(t[1]);
    out.push(text);
  }
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNum = parseInt((/\br="(\d+)"/.exec(rm[1]) || [])[1], 10);
    const rIdx = Number.isFinite(rowNum) ? rowNum - 1 : rows.length;
    const cells = [];
    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let colCursor = 0;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] || "";
      const inner = cm[3] || "";
      const refM = /\br="([A-Za-z]+\d+)"/.exec(attrs);
      const at = refM ? nameToIndex(refM[1]).col : colCursor;
      colCursor = at + 1;
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : "";
      let value = "";
      if (type === "inlineStr") {
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) value += unesc(t[1]);
      } else if (type === "s") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = shared[parseInt(vM ? vM[1] : "", 10)] || "";
      } else if (type === "b") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = (vM ? vM[1] : "0").trim() === "1";
      } else if (type === "str") {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        value = unesc(vM ? vM[1] : "");
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vM) {
          const num = Number(vM[1]);
          value = Number.isFinite(num) ? num : unesc(vM[1]);
        }
      }
      cells[at] = value;
    }
    // Дыры заменяем пустой строкой — так строки одинаковой ширины.
    const width = cells.length;
    for (let i = 0; i < width; i++) if (cells[i] === undefined) cells[i] = "";
    rows[rIdx] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function xlsxRead(buf) {
  const files = zipRead(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const shared = parseSharedStrings(files);
  const wbXml = files["xl/workbook.xml"] ? files["xl/workbook.xml"].toString("utf8") : "";
  const relXml = files["xl/_rels/workbook.xml.rels"] ? files["xl/_rels/workbook.xml.rels"].toString("utf8") : "";
  const relTarget = {};
  const relRe = /<Relationship\b[^>]*>/g;
  let rel;
  while ((rel = relRe.exec(relXml))) {
    const id = (/\bId="([^"]+)"/.exec(rel[0]) || [])[1];
    const target = (/\bTarget="([^"]+)"/.exec(rel[0]) || [])[1];
    if (id && target) relTarget[id] = target.replace(/^\/?xl\//, "").replace(/^\//, "");
  }

  const sheets = [];
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(wbXml))) {
    const name = unesc((/\bname="([^"]*)"/.exec(sm[0]) || [])[1] || "");
    const rid = (/\br:id="([^"]+)"/.exec(sm[0]) || [])[1];
    const target = relTarget[rid] || "";
    sheets.push({ name, target: target ? "xl/" + target : "" });
  }

  // Нет workbook (странная книга) — берём листы по порядку.
  if (!sheets.length) {
    Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort()
      .forEach((k, i) => sheets.push({ name: "Лист" + (i + 1), target: k }));
  }

  return {
    sheets: sheets.map((s) => {
      const raw = s.target ? files[s.target] : null;
      return { name: s.name, rows: raw ? parseSheet(raw.toString("utf8"), shared) : [] };
    }),
  };
}

// Локальное имя для сохранения листа по имени (регистр/пробелы не важны).
function findSheet(book, name) {
  if (!book || !Array.isArray(book.sheets)) return null;
  if (!name) return book.sheets[0] || null;
  const want = String(name).trim().toLowerCase();
  return book.sheets.find((s) => String(s.name).trim().toLowerCase() === want) || null;
}

module.exports = { xlsxWrite, xlsxRead, findSheet, colLetters, safeSheetName, crc32 };

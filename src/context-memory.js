"use strict";

/* ─── Память диалогов: сжатые памятки контекста, по датам ─────────────────────
   Вынесено из agent-store.js (часть 38) — раздел целиком, дословно.
   День и время по часам пользователя, маскировка секретов и атомарная запись —
   в src/store-files.js. */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { localDayKey, localTimeKey, localTimeHuman, dayKeyValid, redactSecrets, atomicWriteText } = require("./store-files.js");

// ── Память диалогов: сжатые памятки контекста, по датам ─────────────────────
/*  Когда контекст переполняется, агент сворачивает старые шаги в «памятку»
    (см. createContextManager в agent-core.js). Здесь каждая памятка сохраняется
    вместе с сообщениями, из которых она была сделана, в
      <userData>/context-memory/<ГГГГ-ММ-ДД>/<ЧЧ-ММ-СС>-<rand>.json
    плюс собранный человекочитаемый <ГГГГ-ММ-ДД>/day.md.

    Зачем: пользователь может позже спросить «посмотри, что мы делали 5-го числа» —
    агент читает это через memoryList / memorySearch.

    Папка лежит ВНЕ проекта (не попадает в git и не уезжает в OTA-бандл).
    Пишется только при включённой галочке «Память диалогов» (в настройках
    по умолчанию выключена) — без явного согласия на диск ничего не сохраняется. */
const CTX_MEMO_MAX_CHARS = 8000; // символов на одну памятку
const CTX_MEMO_MAX_MESSAGES = 80; // сколько сообщений-источников храним
const CTX_MEMO_MSG_CHARS = 4000; // обрезка одного сообщения
const CTX_MEMO_DAY_KEEP = 30; // сколько дней хранить по умолчанию
const CTX_MEMO_SEARCH_LIMIT = 20; // максимум совпадений в поиске

function contextMemoryDir(userData) {
  return path.join(userData, "context-memory");
}

// Содержимое сообщения → строка (многомодальные части сворачиваем в текст).
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (p == null) continue;
      if (typeof p === "string") parts.push(p);
      else if (p.type === "text" && p.text) parts.push(String(p.text));
      else if (p.type === "image_url") parts.push("[изображение]");
      else if (p.text) parts.push(String(p.text));
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// Сообщения для дневника: только role+content, с обрезкой и маскировкой секретов.
function sanitizeMemoMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const tail = messages.slice(-CTX_MEMO_MAX_MESSAGES);
  const out = [];
  for (const m of tail) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").trim();
    if (!role) continue;
    let text = redactSecrets(flattenContent(m.content));
    if (text.length > CTX_MEMO_MSG_CHARS) text = text.slice(0, CTX_MEMO_MSG_CHARS) + "\n… (обрезано)";
    const rec = { role, content: text };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      rec.tools = m.tool_calls.map((t) => String((t && t.function && t.function.name) || "?")).slice(0, 20);
    }
    out.push(rec);
  }
  return out;
}

function ctxMemoFiles(userData, day) {
  const dir = path.join(contextMemoryDir(userData), day);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { dir, files: [] };
  }
  return { dir, files: names.sort().map((f) => path.join(dir, f)) };
}

function ctxMemoReadDay(userData, day) {
  const { files } = ctxMemoFiles(userData, day);
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (d && typeof d === "object") out.push(d);
    } catch {}
  }
  return out;
}

// Пересобирает <day>/day.md — человекочитаемый дневник за день.
function rebuildDayMarkdown(userData, day) {
  const memos = ctxMemoReadDay(userData, day);
  const lines = ["# Сжатые памятки контекста за " + day, ""];
  for (const m of memos) {
    const head = localTimeHuman(m.ts) + " — " + (m.provider || "?") + (m.model ? "/" + m.model : "");
    lines.push("## " + head);
    if (m.workDir) lines.push("Рабочая папка: `" + m.workDir + "`");
    lines.push("");
    lines.push(String(m.memo || "(пусто)"));
    const msgs = Array.isArray(m.messages) ? m.messages : [];
    if (msgs.length) {
      lines.push("", "<details>Сжатые шаги (" + msgs.length + "):", "");
      for (const s of msgs) {
        const one = String(s.content || "").replace(/\s*\n\s*/g, " ");
        const tools = Array.isArray(s.tools) && s.tools.length ? " → " + s.tools.join(", ") : "";
        lines.push("- **" + s.role + "**" + tools + ": " + (one.length > 300 ? one.slice(0, 300) + "…" : one));
      }
      lines.push("", "</details>");
    }
    lines.push("", "---", "");
  }
  atomicWriteText(path.join(contextMemoryDir(userData), day, "day.md"), lines.join("\n"));
}

// Сохранить одну памятку. entry: { ts, memo, messages, provider, model, workDir, keepDays }
function contextMemorySave(userData, entry) {
  if (!userData) return { ok: false, error: "Не задана папка данных приложения." };
  const e = entry || {};
  const memo = redactSecrets(String(e.memo || "")).trim().slice(0, CTX_MEMO_MAX_CHARS);
  if (!memo) return { ok: false, error: "Пустая памятка — сохранять нечего." };
  const ts = Number(e.ts) || Date.now();
  const day = localDayKey(ts);
  const dir = path.join(contextMemoryDir(userData), day);
  fs.mkdirSync(dir, { recursive: true });
  const id = localTimeKey(ts) + "-" + crypto.randomBytes(3).toString("hex");
  const messages = sanitizeMemoMessages(e.messages);
  const rec = {
    id,
    ts,
    day,
    provider: String(e.provider || "").slice(0, 40),
    model: String(e.model || "").slice(0, 80),
    workDir: String(e.workDir || "").slice(0, 400),
    memoChars: memo.length,
    memo,
    messages,
  };
  try {
    atomicWriteText(path.join(dir, id + ".json"), JSON.stringify(rec, null, 2));
    rebuildDayMarkdown(userData, day);
  } catch (err) {
    return { ok: false, error: "Не удалось записать памятку: " + (err.message || String(err)) };
  }
  contextMemoryPrune(userData, e.keepDays);
  const count = ctxMemoReadDay(userData, day).length;
  return { ok: true, id, day, dir, messages: messages.length, chars: rec.memoChars, count };
}

// Список дней: [{ date, count, first, last }] — свежие первыми.
function contextMemoryDays(userData) {
  const base = contextMemoryDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const days = [];
  for (const ent of names) {
    if (!ent.isDirectory() || !dayKeyValid(ent.name)) continue;
    const memos = ctxMemoReadDay(userData, ent.name);
    if (!memos.length) continue;
    const ts = memos.map((m) => Number(m.ts) || 0).filter(Boolean);
    days.push({
      date: ent.name,
      count: memos.length,
      first: ts.length ? Math.min(...ts) : 0,
      last: ts.length ? Math.max(...ts) : 0,
    });
  }
  return days.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function contextMemoryRead(userData, date) {
  if (!dayKeyValid(date)) return { ok: false, error: "Укажи дату в формате ГГГГ-ММ-ДД." };
  const memos = ctxMemoReadDay(userData, date);
  if (!memos.length) return { ok: false, error: "За " + date + " памяток нет. Смотри memoryList (без даты) — там список дней." };
  const list = memos
    .map((m) => ({
      id: m.id,
      time: localTimeHuman(m.ts),
      ts: m.ts,
      provider: m.provider,
      model: m.model,
      workDir: m.workDir,
      chars: m.memoChars || String(m.memo || "").length,
      memo: String(m.memo || ""),
      messages: Array.isArray(m.messages) ? m.messages.length : 0,
    }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, date, count: list.length, memos: list };
}

// Поиск по памяткам. opts: { query, date (необязательно), limit }
function contextMemorySearch(userData, opts) {
  const o = opts || {};
  const q = String(o.query || "").trim().toLowerCase();
  if (!q) return { ok: false, error: "Укажи query — что искать в памятках." };
  const day = dayKeyValid(o.date) ? o.date : "";
  const limit = Math.max(1, Math.min(100, Number(o.limit) || CTX_MEMO_SEARCH_LIMIT));
  const days = day ? [day] : contextMemoryDays(userData).map((d) => d.date);
  const matches = [];
  for (const d of days) {
    for (const m of ctxMemoReadDay(userData, d)) {
      const hay = (String(m.memo || "") + "\n" + String(m.workDir || "") + "\n" +
        (Array.isArray(m.messages) ? m.messages.map((s) => s.content || "").join("\n") : "")).toLowerCase();
      const at = hay.indexOf(q);
      if (at < 0) continue;
      let count = 0;
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) count++;
      const memoText = String(m.memo || "");
      const memoLower = memoText.toLowerCase();
      const pos = memoLower.indexOf(q);
      let snippet;
      if (pos >= 0) {
        const from = Math.max(0, pos - 160);
        snippet = (from > 0 ? "…" : "") + memoText.slice(from, pos + 340) + (pos + 340 < memoText.length ? "…" : "");
      } else {
        snippet = "(совпадение в сжатых шагах, не в самой памятке)";
      }
      matches.push({ date: d, id: m.id, time: localTimeHuman(m.ts), ts: m.ts, hits: count, snippet: snippet.replace(/\n/g, " ") });
    }
  }
  matches.sort((a, b) => (b.hits - a.hits) || (b.ts - a.ts));
  return { ok: true, query: String(o.query).trim(), count: matches.length, matches: matches.slice(0, limit) };
}

// Автоочистка: держим только keepDays самых свежих дней (по умолчанию 30).
function contextMemoryPrune(userData, keepDays) {
  const keep = Math.max(1, Math.min(3650, Number(keepDays) || CTX_MEMO_DAY_KEEP));
  const base = contextMemoryDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { ok: true, removed: 0, kept: 0 };
  }
  const days = names.filter((e) => e.isDirectory() && dayKeyValid(e.name)).map((e) => e.name).sort().reverse();
  let removed = 0;
  for (const d of days.slice(keep)) {
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return { ok: true, removed, kept: Math.min(days.length, keep) };
}

// Очистка: одна дата или вообще всё. Возвращает { ok, removedDays, removedMemos }.
function contextMemoryClear(userData, date) {
  const base = contextMemoryDir(userData);
  if (date && !dayKeyValid(date)) return { ok: false, error: "Дата должна быть в формате ГГГГ-ММ-ДД." };
  const days = date
    ? [date]
    : (() => {
        try {
          return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && dayKeyValid(e.name)).map((e) => e.name);
        } catch {
          return [];
        }
      })();
  let removedDays = 0;
  let removedMemos = 0;
  for (const d of days) {
    removedMemos += ctxMemoReadDay(userData, d).length;
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
      removedDays++;
    } catch {}
  }
  return { ok: true, removedDays, removedMemos };
}

// Сводка для настроек: сколько дней, памяток и места занимает дневник.
function contextMemoryStats(userData) {
  const base = contextMemoryDir(userData);
  const days = contextMemoryDays(userData);
  let memos = 0;
  let bytes = 0;
  for (const d of days) memos += d.count;
  const walk = (dir) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) walk(abs);
      else {
        try { bytes += fs.statSync(abs).size; } catch {}
      }
    }
  };
  walk(base);
  return {
    ok: true,
    dir: base,
    days: days.length,
    memos,
    bytes,
    newest: days.length ? days[0].date : "",
    oldest: days.length ? days[days.length - 1].date : "",
  };
}

module.exports = {
  CTX_MEMO_MAX_CHARS,
  CTX_MEMO_DAY_KEEP,
  contextMemoryDir,
  sanitizeMemoMessages,
  contextMemorySave,
  contextMemoryDays,
  contextMemoryRead,
  contextMemorySearch,
  contextMemoryPrune,
  contextMemoryClear,
  contextMemoryStats,
};

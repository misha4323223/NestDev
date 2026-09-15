"use strict";

/* ── Журнал действий агента (audit log) ────────────────────────────────────────
   Каждое опасное или требующее подтверждения действие агента попадает в файл
   JSONL (одна строка — одно событие) рядом с остальными данными приложения:

     {"ts":1757847123456,"time":"11:42:03","tool":"runCommand","capability":"terminal.execute",
      "risk":"medium","decision":"approved","summary":"$ rm -rf dist","result":"Готово"}

   Правила:
   - пишем только то, что действительно важно: риск medium/high, любые отказы и
     подтверждения, и незнакомые инструменты (capability "unknown");
   - СЕКРЕТОВ В ЖУРНАЛЕ НЕТ: аргументы проходят через tool-policy.redact, строки
     результата — через scrub (ключи, токены, «TOKEN=…» вырезаются);
   - файл не растёт бесконечно: при 2 МБ он сдвигается в audit.log.1;
   - запись никогда не бросает: журнал не должен ломать прогон агента.

   Модуль не требует electron (путь передаётся) — тестируется в plain-node.
*/

const fs = require("fs");
const path = require("path");
const toolPolicy = require("./tool-policy.js");

const MAX_BYTES = 2 * 1024 * 1024; // порог сдвига файла
const MAX_RESULT = 400; // сколько символов результата храним
const MAX_TAIL = 500; // сколько строк отдаёт tail()

let filePath = "";
let enabled = true;
// Значения секретов агента (переменные окружения и т.п.): вырезаем их из любой
// строки журнала — по подстроке, потому что по виду они ничем не выделяются.
let secretValues = [];

// Путь к журналу + включён ли он (значение из настроек приложения).
function init(p, on) {
  filePath = p ? String(p) : "";
  if (typeof on === "boolean") enabled = on;
  return filePath;
}

function setEnabled(on) {
  enabled = on !== false;
}

function isEnabled() {
  return !!enabled;
}

// Передать значения, которые нельзя показывать в журнале ни при каких условиях.
function setSecrets(list) {
  secretValues = (Array.isArray(list) ? list : [])
    .map((v) => String(v == null ? "" : v))
    .filter((v) => v.length >= 6);
  return secretValues.length;
}

// Короткий исход действия: журнал отвечает на вопрос «что случилось», а не хранит
// вывод команд (в выводе может быть что угодно, включая чужие секреты).
function outcomeOf(result) {
  const s = String(result == null ? "" : result).trim();
  if (!s) return "ok";
  if (s.startsWith("⛔")) return "error";
  // Смотрим первые строки: инструменты начинают сообщение об ошибке с «Ошибка:»,
  // «Ошибка Yandex Cloud:» или «⛔». Границы слов (\b) тут не работают — для JS
  // кириллица не буква, поэтому сравниваем начало строки вручную.
  const lines = s.slice(0, 500).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4);
  for (const line of lines) {
    if (line.startsWith("⛔")) return "error";
    const low = line.toLowerCase();
    if (/^(ошибка|error)\s*[:!]/.test(low)) return "error";
    if (/^не вып[оa]лнен/.test(low)) return "error";
  }
  return "ok";
}

function errorHead(result) {
  const s = String(result == null ? "" : result).replace(/\r/g, "").trim();
  const line = s.split("\n").filter((l) => l.trim())[0] || s;
  return line.slice(0, 120);
}

function file() {
  return filePath;
}

function localTime(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, "0");
  return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
}

// Сдвиг файла: свежая история остаётся в audit.log, предыдущая — в audit.log.1.
function rotateIfNeeded() {
  try {
    const st = fs.statSync(filePath);
    if (st.size < MAX_BYTES) return false;
    fs.renameSync(filePath, filePath + ".1");
    return true;
  } catch {
    return false;
  }
}

// Нужно ли вообще писать это событие (иначе журнал превратится в лог каждого чиха).
function shouldWrite(risk, capability, decision) {
  if (decision && decision !== "auto") return true; // подтверждения и отказы — всегда
  if (capability === "unknown") return true; // незнакомый инструмент — повод посмотреть
  return (toolPolicy.RISK_WEIGHT[risk] || 2) >= toolPolicy.RISK_WEIGHT.medium;
}

// Записать событие. entry: { tool, args, decision, result, error, summary, source }
function record(entry) {
  try {
    if (!enabled || !filePath) return null;
    const e = entry || {};
    const pol = toolPolicy.policy(e.tool);
    const decision = e.decision || "auto";
    if (!shouldWrite(pol.risk, pol.capability, decision)) return null;

    const ts = Date.now();
    const args = toolPolicy.redact(e.args, 0, secretValues);
    const summary = e.summary
      ? toolPolicy.scrub(e.summary, 200, secretValues)
      : toolPolicy.scrub(JSON.stringify(args || {}), 200, secretValues);
    const outcome = decision === "denied" ? "denied" : outcomeOf(e.result);
    // Текст результата в журнал не пишем: только исход и, при ошибке, её первая строка.
    const note = outcome === "error" ? toolPolicy.scrub(errorHead(e.result), 120, secretValues) : "";
    const error = e.error ? toolPolicy.scrub(String(e.error), 200, secretValues) : "";

    const row = {
      ts,
      time: localTime(ts),
      tool: String(e.tool || ""),
      capability: pol.capability,
      risk: pol.risk,
      decision,
      outcome,
      source: e.source || "",
      args,
      summary,
      note,
      error,
    };

    rotateIfNeeded();
    fs.appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");

    try {
      if (typeof e.emit === "function") {
        e.emit({ type: "audit", row });
      }
    } catch {
      /* подписчик события упал — на журнал это не влияет */
    }
    return row;
  } catch {
    return null; // журнал не имеет права ломать работу агента
  }
}

// Последние n событий (для панели/отладки). Битые строки пропускаем.
function tail(n) {
  try {
    if (!filePath) return [];
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split("\n").filter((l) => l.trim());
    const take = lines.slice(Math.max(0, lines.length - (n || 50)));
    const out = [];
    for (const l of take) {
      try {
        out.push(JSON.parse(l));
      } catch {
        /* обрезанная строка — пропускаем */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Очистить журнал (пользовательское действие, не агент).
function clear() {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (filePath && fs.existsSync(filePath + ".1")) fs.unlinkSync(filePath + ".1");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  init,
  setEnabled,
  isEnabled,
  setSecrets,
  outcomeOf,
  file,
  record,
  tail,
  clear,
  rotateIfNeeded,
  MAX_BYTES,
  MAX_TAIL,
  pathFor: (dir) => (dir ? path.join(String(dir), "audit.log") : ""),
};

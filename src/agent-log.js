"use strict";

/* ── Полный журнал действий агента (agent log) ─────────────────────────────────
   Отдельно от audit.log (src/audit-log.js): тот пишет ТОЛЬКО рискованные и
   подтверждённые действия и отвечает на вопрос «что опасного случилось». Этот
   пишет КАЖДУЮ пару «вызов инструмента → его результат» и отвечает на вопрос
   «что агент вообще делал и что он получил».

   Зачем отдельный файл. В собранном (упакованном) приложении нет терминала, и
   `console.log` главного процесса никуда не виден. Человек видит вывод агента в
   панели «Консоль», но панель живёт, пока открыто окно; после перезапуска и на
   чужой машине от неё ничего не остаётся. Файл рядом с остальными данными — это
   то, что можно попросить прислать при разборе «агент сделал не то».

   Правила (те же, что у журнала действий, и так же жёсткие):
   - одна строка — одно событие (JSONL), поля: время, инструмент, назначение,
     риск, откуда (ПК/телефон), исход, сколько шёл, сколько символов вывода,
     обрезанные аргументы и обрезанный результат;
   - СЕКРЕТОВ В ЖУРНАЛЕ НЕТ: аргументы проходят через tool-policy.redact,
     результат — через scrub; значения переменных агента вырезаются по подстроке.
     Сами значения берутся из audit-log.js (одна точка правды, setSecrets);
   - результат обрезается с ОБОИХ концов: у команд и запросов самое важное — в
     конце (ошибка сборки, код возврата), и head-only срез прятал бы именно её;
   - файл не растёт бесконечно: при 4 МБ он сдвигается в agent.log.1;
   - запись НИКОГДА не бросает и не мешает прогону агента.

   Модуль не требует electron (путь передаётся) — тестируется в plain-node. */

const fs = require("fs");
const path = require("path");
const toolPolicy = require("./tool-policy.js");
const audit = require("./audit-log.js"); // значения секретов агента: одна точка правды

const MAX_BYTES = 4 * 1024 * 1024; // порог сдвига файла
const MAX_RESULT = 700; // сколько символов результата храним (с обоих концов)
const MAX_TAIL = 500; // сколько строк отдаёт tail()

let filePath = "";
let enabled = true;

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

function file() {
  return filePath;
}

function localTime(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, "0");
  return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
}

// Сдвиг файла: свежая история остаётся в agent.log, предыдущая — в agent.log.1.
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

// Понятный отказ по тексту результата («Ошибка:/⛔/⏱» и ненулевой код команды)
// живёт теперь в src/audit-log.js (outcomeOf + looksFailed) — у окна, журнала
// действий и этого журнала один ответ на вопрос «вызов удался?». Раньше копия
// правила была здесь и отставала: строка начинается с «$ имя-команды», а не со
// слова «Ошибка», и провал выглядел зелёным в обоих журналах.

// Обрезка с обоих концов: начало (что вообще пришло) и конец (ошибка/код/итог).
function headTail(text, cap) {
  const s = String(text == null ? "" : text);
  if (s.length <= cap) return s;
  const head = Math.floor(cap / 2);
  const tail = cap - head;
  return s.slice(0, head) + " …(обрезано: " + s.length + " симв.) … " + s.slice(s.length - tail);
}

// Записать событие. entry: { tool, args, result, source, ms, error }
// Возвращает строку журнала или null, если писать нечего/нельзя.
function record(entry) {
  try {
    if (!enabled || !filePath) return null;
    const e = entry || {};
    const secrets = audit.secrets();
    const pol = toolPolicy.policy(e.tool);
    const ts = Date.now();
    const text = e.result == null ? "" : String(e.result);

    const row = {
      ts,
      time: localTime(ts),
      tool: String(e.tool || ""),
      capability: pol.capability,
      risk: pol.risk,
      source: e.source || "",
      ok: audit.toolOk(text),
      ms: e.ms == null ? null : Number(e.ms),
      chars: text.length,
      args: toolPolicy.redact(e.args, 0, secrets),
      // Результат: сначала держим оба конца, потом чистим секреты и жмём пробелы —
      // одна строка журнала не должна занимать экран.
      result: toolPolicy.scrub(headTail(text, MAX_RESULT), MAX_RESULT + 40, secrets),
      error: e.error ? toolPolicy.scrub(String(e.error), 200, secrets) : "",
    };

    rotateIfNeeded();
    fs.appendFileSync(filePath, JSON.stringify(row) + "\n", "utf8");

    try {
      if (typeof e.emit === "function") e.emit({ type: "agentlog", row });
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
  file,
  record,
  tail,
  clear,
  rotateIfNeeded,
  headTail,
  // Наружу остаётся тем же именем, но правило теперь ОДНО для всех — из
  // src/audit-log.js: иначе панель журнала и строка действий судили вызов по-разному.
  looksFailed: audit.looksFailed,
  MAX_BYTES,
  MAX_RESULT,
  MAX_TAIL,
  pathFor: (dir) => (dir ? path.join(String(dir), "agent.log") : ""),
};

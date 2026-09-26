"use strict";
/* Миссии агента — то, что делает долгую работу видимой и переживающей перезапуск.

   Зачем файлы, а не память процесса: агент, который работает часами, не имеет права
   терять задачу из-за перезапуска, обновления или обрыва связи. Поэтому цель, план,
   шаги и журнал шагов лежат на диске — по умолчанию рядом с проектом, в папке
   `.agent/`, а если человек выбрал свою папку (настройка «миссии и прогоны»),
   в её подпапке проекта:

     <корень>/
       README.md              — что это за папка (только у `.agent/`, один раз, для человека)
       .gitignore             — `*`: журнал не должен попадать в коммиты (только у `.agent/`)
       tasks.md               — зеркало списка дел (читаемо, если включено в настройках)
       context/<ГГГГ-ММ-ДД>.md — зеркало памяток контекста за день
       missions/<id>/
         mission.json         — цель, шаги, состояние, метрики, лимиты
         journal.md           — журнал человеческим языком (время · шаг · что сделано)
         journal.jsonl        — то же машинно: панель «Миссия» читает хвост
         report.md            — итог работы (когда миссия закрыта)
       runs/<чат>.json        — рабочая история незавершённого прогона (src/run-context.js)

   Где именно корень, решает src/agent-data.js: только он знает про выбранную
   человеком папку и про ключ проекта, и все пути здесь считаются через него
   (agentRoot). Пусто в настройке — прежнее место: `.agent/` рядом с проектом.

   Никаких зависимостей от Electron: рабочая папка приходит аргументом, поэтому модуль
   проверяется обычными тестами. Секреты маскируются тем же кодом, что и дневник
   контекста (agent-store), — чтобы случайный ключ из переписки не осел на диске. */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { redactSecrets, localDayKey } = require("./agent-store.js");
const { AGENT_DIR, layoutOf } = require("./agent-data.js"); // раскладка: своя папка или .agent/

const MISSIONS_DIR = "missions";
const MISSION_MAX_KEEP = 40; // сколько миссий храним (старые закрытые удаляются)
const MISSION_MAX_STEPS = 200; // шагов в одной миссии
// Этапы работы (отрезки) — их ведёт ПРИЛОЖЕНИЕ, в отличие от шагов плана, которые
// ставит модель. Смысл: длинная история обрезается с конца, и модель помнит только
// свежий хвост; сохранённые этапы дают ей весь путь (с чего началось, что было в
// каждом отрезке, чем закончилось) и растут медленно — одна запись на отрезок.
const MISSION_MAX_STAGES = 30; // этапов храним (старые отрезаются)
const MISSION_STAGE_FILES = 12; // файлов в записи этапа
const MISSION_STAGE_KEEP = 4; // записей журнала из начала и из конца этапа
const MISSION_GOAL_NOTES_MAX = 20; // уточнений к цели храним
const MISSION_TEXT_MAX = 2000; // символов в поле/строке журнала
const JOURNAL_MAX_BYTES = 1500 * 1024; // после этого журнал подрезается до хвоста
const JOURNAL_KEEP_LINES = 400;
const JOURNAL_TAIL_LINES = 20; // хвост для панели и для агента
const MISSION_STATUSES = ["active", "paused", "done", "failed", "stopped"];
const STEP_STATES = ["todo", "doing", "done", "failed"];

function pad2(n) {
  return String(n).padStart(2, "0");
}

function stamp(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function humanTs(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Заголовок → часть имени папки: «Разбери входящие за неделю» → «razberi-vhodyashchie».
// Транслит не делаем: кириллица в именах папок Windows и Linux работает нормально,
// а читаемость для человека важнее. Служебные символы пути вырезаем всегда.
function slugify(text, max) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max || 28);
  return s || "missiya";
}

function clip(text, max) {
  const s = redactSecrets(String(text == null ? "" : text)).trim();
  const m = max || MISSION_TEXT_MAX;
  return s.length > m ? s.slice(0, m) + " …" : s;
}

function atomicWriteText(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, String(text), "utf8");
  fs.renameSync(tmp, file);
}

// ── Пути ──────────────────────────────────────────────────────────────────────
// Место по умолчанию: `.agent/` рядом с проектом. Оно же — место зеркал контекста
// и защитных файлов, поэтому живёт отдельным именем: выбранная человеком папка его
// НЕ заменяет.
function defaultRoot(workDir) {
  return path.join(String(workDir || ""), AGENT_DIR);
}

// Корень миссий и прогонов. Считается раскладкой (src/agent-data.js): пусто в
// настройке — `.agent/` рядом с проектом, выбрана папка — её подпапка проекта.
function agentRoot(workDir) {
  return layoutOf(workDir).missionsRoot;
}

// Как назвать папку миссий в текстах (человеку и модели). По умолчанию — прежняя
// относительная запись `.agent/missions/<id>/`: она читается от рабочей папки.
// Когда папка выбрана человеком, `.agent/` рядом с проектом уже нет — называем
// полный путь, иначе и человек, и модель искали бы файлы не там.
function missionsPathText(workDir, id) {
  const tail = MISSIONS_DIR + "/" + (id ? String(id) + "/" : "");
  if (!layoutOf(workDir).missionsCustom) return AGENT_DIR + "/" + tail;
  return path.join(agentRoot(workDir), tail.slice(0, -1)) + path.sep;
}

function missionsDir(workDir) {
  return path.join(agentRoot(workDir), MISSIONS_DIR);
}

function missionDirOf(workDir, id) {
  return path.join(missionsDir(workDir), String(id || ""));
}

function missionFile(workDir, id) {
  return path.join(missionDirOf(workDir, id), "mission.json");
}

// README и `.gitignore` ставятся ТОЛЬКО у `.agent/` рядом с проектом: первый
// объясняет папку человеку, второй закрывает её от коммитов (авто-коммит агента
// делает git add -A). В папке, выбранной человеком, приложение ничего лишнего не
// создаёт: она может быть чем угодно, и мусорить там нельзя.
const AGENT_README = [
  "# .agent — рабочая папка агента",
  "",
  "Здесь агент хранит свою работу, чтобы не терять её при перезапуске:",
  "",
  "- `missions/<id>/mission.json` — цель, план, шаги, этапы работы, состояние, метрики;",
  "- `missions/<id>/journal.md` — журнал шагов человеческим языком (в нём же строки «🧭 Этап …»);",
  "- `missions/<id>/report.md` — итог по завершении;",
  "- `runs/<чат>.json` — рабочая история незавершённого прогона (продолжение с места остановки);",
  "- `tasks.md` — зеркало списка дел приложения (если включено в настройках);",
  "- `context/<дата>.md` — зеркало памяток контекста (если включена «Память диалогов»).",
  "",
  "Папку можно удалять целиком — приложение создаст её заново. Она исключена из git",
  "файлом `.gitignore` внутри (строка `*`), поэтому журнал не попадает в коммиты.",
  "",
].join("\n");

function ensureDefaultRoot(workDir) {
  const root = defaultRoot(workDir);
  fs.mkdirSync(root, { recursive: true });
  const readme = path.join(root, "README.md");
  if (!fs.existsSync(readme)) atomicWriteText(readme, AGENT_README);
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) {
    // `*` в .gitignore внутри каталога исключает и сам файл — папка целиком вне git.
    atomicWriteText(gi, "*\n");
  }
  return root;
}

// Папка миссий создаётся перед первой записью: и миссия, и прогон, и зеркало кладут
// файлы через неё.
function ensureAgentRoot(workDir) {
  const root = agentRoot(workDir);
  if (root === defaultRoot(workDir)) ensureDefaultRoot(workDir);
  else fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(missionsDir(workDir), { recursive: true });
  return root;
}

// ── Журнал ────────────────────────────────────────────────────────────────────
function journalMdFile(workDir, id) {
  return path.join(missionDirOf(workDir, id), "journal.md");
}

function journalJsonFile(workDir, id) {
  return path.join(missionDirOf(workDir, id), "journal.jsonl");
}

function journalTrimIfBig(file) {
  try {
    const st = fs.statSync(file);
    if (st.size <= JOURNAL_MAX_BYTES) return;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const tail = lines.slice(Math.max(0, lines.length - JOURNAL_KEEP_LINES));
    atomicWriteText(file, "… (старые строки журнала свёрнуты)\n" + tail.join("\n"));
  } catch {}
}

// Одна строка журнала: пишем и человеку (markdown), и панели (jsonl).
function journalAppend(workDir, id, entry) {
  const e = entry || {};
  const ts = Number(e.ts) || Date.now();
  const text = clip(e.text, MISSION_TEXT_MAX);
  if (!text) return;
  const rec = { ts, kind: String(e.kind || "note").slice(0, 20), text, step: e.step == null ? null : Number(e.step) };
  try {
    fs.appendFileSync(journalMdFile(workDir, id), "- `" + stamp(ts) + "` " + text.replace(/\n+/g, " ") + "\n", "utf8");
    fs.appendFileSync(journalJsonFile(workDir, id), JSON.stringify(rec) + "\n", "utf8");
    journalTrimIfBig(journalJsonFile(workDir, id));
    journalTrimIfBig(journalMdFile(workDir, id));
  } catch {}
}

// Хвост файла: у длинной миссии читать целиком нельзя (журнал растёт часами).
function readTailLines(file, limit) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const bytes = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(bytes);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, bytes, st.size - bytes);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // Первая строка может быть обрезана посередине — её выбрасываем, если читали не с начала.
    const clean = st.size > bytes ? lines.slice(1) : lines;
    return clean.slice(Math.max(0, clean.length - (limit || JOURNAL_TAIL_LINES)));
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function missionJournal(workDir, id, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(200, Number(o.limit) || JOURNAL_TAIL_LINES));
  const out = [];
  for (const line of readTailLines(journalJsonFile(workDir, id), limit)) {
    try {
      const rec = JSON.parse(line);
      if (rec && rec.text) out.push(rec);
    } catch {}
  }
  return out;
}

function missionJournalText(workDir, id, opts) {
  const rows = missionJournal(workDir, id, opts);
  if (!rows.length) return "Журнал пуст — работа ещё не начиналась.";
  return rows.map((r) => "- " + humanTs(r.ts) + " " + r.text).join("\n");
}

// ── Миссия ────────────────────────────────────────────────────────────────────
function newId(goal, ts) {
  const d = new Date(Number(ts) || Date.now());
  const day = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  const time = pad2(d.getHours()) + pad2(d.getMinutes());
  return day + "-" + time + "-" + slugify(goal, 28);
}

function stepsFrom(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list.slice(0, MISSION_MAX_STEPS) : []) {
    const title = typeof raw === "string" ? raw : raw && raw.title;
    const t = clip(title, 200);
    if (!t) continue;
    out.push({
      title: t,
      state: (raw && STEP_STATES.indexOf(raw.state) >= 0 && raw.state) || "todo",
      note: raw && raw.note ? clip(raw.note, 400) : "",
      doneAt: 0,
    });
  }
  return out;
}

function missionCreate(workDir, opts) {
  const dir = String(workDir || "").trim();
  if (!dir) return { ok: false, error: "Не задана рабочая папка — миссию некуда положить." };
  const o = opts || {};
  const goal = clip(o.goal || o.title, 4000);
  if (!goal) return { ok: false, error: "Пустая цель: миссии нужна хотя бы одна строка, что делать." };
  const ts = Number(o.ts) || Date.now();
  let id = newId(o.title || goal, ts);
  let n = 2;
  while (fs.existsSync(missionDirOf(dir, id)) && n < 50) id = newId(o.title || goal, ts) + "-" + n++;
  const rec = {
    id,
    title: clip(o.title || goal.split("\n")[0], 160),
    goal,
    role: String(o.role || "").slice(0, 40),
    chatId: String(o.chatId || "").slice(0, 80),
    workDir: dir,
    status: "active",
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    finishedAt: 0,
    rounds: 0,
    batches: 0,
    steps: stepsFrom(o.steps),
    // Этапы работы и уточнения к цели: у миссий, заведённых до их появления, этих
    // полей нет — весь код обязан обходиться пустым списком (см. missionStage).
    stages: [],
    goalNotes: [],
    next: o.next ? clip(o.next, 400) : "",
    limits: {
      minutes: Math.max(1, Math.min(24 * 60, Number(o.limits && o.limits.minutes) || 480)),
      rounds: Math.max(1, Math.min(10000, Number(o.limits && o.limits.rounds) || 600)),
    },
    metrics: { tokens: 0, compactions: 0, autoContinuations: 0, errors: 0 },
    reason: "",
  };
  try {
    ensureAgentRoot(dir);
    fs.mkdirSync(missionDirOf(dir, id), { recursive: true });
    atomicWriteText(missionFile(dir, id), JSON.stringify(rec, null, 2));
  } catch (err) {
    return { ok: false, error: "Не удалось создать миссию: " + (err.message || String(err)) };
  }
  journalAppend(dir, id, { kind: "start", text: "🎯 Миссия начата: " + rec.title, ts });
  if (rec.steps.length) {
    journalAppend(dir, id, { kind: "plan", text: "План (" + rec.steps.length + "): " + rec.steps.map((s) => s.title).join(" · "), ts });
  }
  missionPrune(dir);
  return { ok: true, mission: rec, dir: missionDirOf(dir, id) };
}

function missionLoad(workDir, id) {
  try {
    const rec = JSON.parse(fs.readFileSync(missionFile(workDir, id), "utf8"));
    if (!rec || !rec.id) return null;
    return rec;
  } catch {
    return null;
  }
}

function missionSave(workDir, rec) {
  if (!rec || !rec.id) return { ok: false, error: "Миссия без id." };
  try {
    rec.updatedAt = Date.now();
    atomicWriteText(missionFile(workDir, rec.id), JSON.stringify(rec, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: "Не удалось сохранить миссию: " + (err.message || String(err)) };
  }
}

function missionProgress(rec) {
  const steps = (rec && rec.steps) || [];
  let done = 0;
  let failed = 0;
  let current = "";
  for (const s of steps) {
    if (s.state === "done") done++;
    else if (s.state === "failed") failed++;
    else if (!current && s.state === "doing") current = s.title;
  }
  return {
    total: steps.length,
    done,
    failed,
    left: Math.max(0, steps.length - done - failed),
    current: current || (rec && rec.next) || "",
    percent: steps.length ? Math.round(((done + failed) / steps.length) * 100) : 0,
  };
}

// Один шаг работы: что сделано, что дальше, что попутно замечено.
function missionStep(workDir, id, opts) {
  const o = opts || {};
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const ts = Date.now();
  const lines = [];
  const findStep = (title) => {
    const t = clip(title, 200).toLowerCase();
    if (!t) return -1;
    let idx = rec.steps.findIndex((s) => s.title.toLowerCase() === t);
    if (idx < 0) idx = rec.steps.findIndex((s) => s.state !== "done" && s.state !== "failed" && (s.title.toLowerCase().indexOf(t) >= 0 || t.indexOf(s.title.toLowerCase()) >= 0));
    return idx;
  };

  if (o.done) {
    let idx = findStep(o.done);
    if (idx < 0) {
      // Сделано то, чего не было в плане, — не теряем это, добавляем шагом.
      if (rec.steps.length < MISSION_MAX_STEPS) {
        rec.steps.push({ title: clip(o.done, 200), state: "done", note: "", doneAt: ts });
        idx = rec.steps.length - 1;
      }
    } else {
      rec.steps[idx].state = "done";
      rec.steps[idx].doneAt = ts;
    }
    lines.push("✅ Шаг выполнен: " + clip(o.done, 200));
  }
  if (o.fail) {
    const idx = findStep(o.fail);
    if (idx >= 0) {
      rec.steps[idx].state = "failed";
      rec.steps[idx].note = clip(o.note || "", 400);
      rec.steps[idx].doneAt = ts;
    } else if (rec.steps.length < MISSION_MAX_STEPS) {
      rec.steps.push({ title: clip(o.fail, 200), state: "failed", note: clip(o.note || "", 400), doneAt: ts });
    }
    lines.push("⚠ Не удалось: " + clip(o.fail, 200) + (o.note ? " — " + clip(o.note, 300) : ""));
  }
  if (o.next) {
    const idx = findStep(o.next);
    if (idx >= 0) {
      rec.steps[idx].state = "doing";
      rec.next = rec.steps[idx].title;
    } else if (rec.steps.length < MISSION_MAX_STEPS) {
      rec.steps.push({ title: clip(o.next, 200), state: "doing", note: "", doneAt: 0 });
      rec.next = clip(o.next, 200);
    } else {
      rec.next = clip(o.next, 200);
    }
    lines.push("▸ Дальше: " + clip(o.next, 200));
  }
  if (o.note) lines.push("· " + clip(o.note, 600));
  for (const t of lines) journalAppend(workDir, id, { kind: o.fail ? "fail" : "step", text: t, ts });
  const saved = missionSave(workDir, rec);
  if (!saved.ok) return saved;
  return { ok: true, mission: rec, progress: missionProgress(rec) };
}

// План панели (todoWrite) становится планом миссии. План у агента ОДИН, а мест показа
// два: панель «План» (её ведёт интерфейс по событию todoWrite) и список шагов в панели
// «Миссия» (его ведут файлы миссии). Раньше todoWrite наполнял только первую, поэтому
// миссия, заведённая приложением без steps, навсегда оставалась «без плана» — хотя
// план есть и агент работает именно по нему. Здесь план ложится в шаги, а переходы
// (сделано / не вышло) — в журнал теми же строками, что пишет missionStep.
const PLAN_STATES = { done: "done", failed: "failed", in_progress: "doing", doing: "doing" };
function missionSetPlan(workDir, id, tasks) {
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const ts = Date.now();
  const want = [];
  for (const raw of (Array.isArray(tasks) ? tasks : []).slice(0, MISSION_MAX_STEPS)) {
    const title = clip(typeof raw === "string" ? raw : raw && raw.text, 200);
    if (!title) continue;
    const key = title.toLowerCase();
    const state = PLAN_STATES[String((raw && raw.status) || "")] || "todo";
    const prev = rec.steps.find((s) => String(s.title || "").toLowerCase() === key);
    want.push({
      title: title,
      state: state,
      // Заметку ведёт не план, а missionStep (ею объясняется сбой): у знакомого шага
      // она сохраняется, у нового пустая.
      note: clip((raw && raw.note) || (prev && prev.note) || "", 400),
      doneAt: state === "done" || state === "failed" ? (prev && prev.doneAt) || ts : 0,
    });
  }
  if (!want.length) return { ok: false, error: "Пустой план: миссии нечего записывать." };
  // История не выбрасывается: шаги, закрытые раньше (их нет в новом плане), остаются
  // внизу списка — иначе прогресс миссии «улучшался» бы от смены плана.
  const kept = rec.steps.filter(
    (s) =>
      (s.state === "done" || s.state === "failed") &&
      !want.some((w) => w.title.toLowerCase() === String(s.title || "").toLowerCase())
  );
  const lines = [];
  const prevState = (title) => {
    const p = rec.steps.find((x) => String(x.title || "").toLowerCase() === String(title).toLowerCase());
    return p ? p.state : "";
  };
  if (rec.steps.map((s) => String(s.title || "").toLowerCase()).join("|") !== want.map((w) => w.title.toLowerCase()).join("|")) {
    lines.push({ kind: "plan", text: "План (" + want.length + "): " + want.map((w) => w.title).join(" · ") });
  }
  for (const s of want) {
    const was = prevState(s.title);
    if (s.state === "done" && was !== "done" && was !== "failed") {
      lines.push({ kind: "step", text: "✅ Шаг выполнен: " + s.title });
      s.doneAt = s.doneAt || ts;
    } else if (s.state === "failed" && was !== "failed") {
      lines.push({ kind: "fail", text: "⚠ Не удалось: " + s.title + (s.note ? " — " + s.note : "") });
      s.doneAt = s.doneAt || ts;
    }
  }
  rec.steps = want.concat(kept).slice(0, MISSION_MAX_STEPS);
  const nextStep = want.find((s) => s.state !== "done" && s.state !== "failed");
  rec.next = nextStep ? nextStep.title : "";
  for (const l of lines) journalAppend(workDir, id, { kind: l.kind, text: l.text, ts });
  const saved = missionSave(workDir, rec);
  if (!saved.ok) return saved;
  return { ok: true, mission: rec, progress: missionProgress(rec), changed: lines.length > 0 };
}

// Служебная запись в журнал (батч начался, пауза, ошибка, авто-продолжение).
// ── Этапы работы (отрезки) ────────────────────────────────────────────────────
// Этап закрывается в конце отрезка: граница батча, остановка по лимиту, пауза,
// «Стоп» человека. Внутрь едет ИМЕННО этот отрезок: сколько длился, сколько в нём
// было раундов, какие файлы появились, чем он начался и на чём закончился.
// Ничего не выдумываем: записи берём из журнала по времени — начала отрезка.
function missionStage(workDir, id, opts) {
  const o = opts || {};
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const at = Number(o.at) || Date.now();
  const stages = Array.isArray(rec.stages) ? rec.stages : [];
  const from = stages.length ? Number(stages[stages.length - 1].at) || Number(rec.startedAt) || at : Number(rec.startedAt) || at;
  let rows = [];
  try {
    rows = missionJournal(workDir, id, { limit: 200 }) || [];
  } catch {
    rows = [];
  }
  // Граница отрезка — «не раньше начала»: запись, сделанная в ту же миллисекунду
  // (а первая запись миссии именно такая), обязана попасть в свой отрезок.
  const mine = rows.filter((e) => Number(e.ts) >= from && e.kind !== "stage");
  const files = [];
  for (const e of mine) {
    const m = /(?:создан файл|правка файла|применён патч):\s*(.+)$/.exec(String(e.text || ""));
    const f = m ? m[1].trim() : "";
    if (f && files.indexOf(f) < 0 && files.length < MISSION_STAGE_FILES) files.push(f);
  }
  // «Как началось» и «чем закончилось» — про РАБОТУ отрезка. Служебные строки
  // (начало миссии, план, граница батча, строки этапов) в сводке и так есть выше,
  // и без них видно, с какого действия путь начался.
  const work = mine.filter((e) => ["tool", "step", "fail", "goal", "note"].indexOf(e.kind) >= 0);
  const texts = (work.length ? work : mine).map((e) => clip(e.text, 200));
  const pr = missionProgress(rec);
  const stage = {
    n: stages.length + 1,
    at,
    from,
    minutes: Math.max(0, Math.round((at - from) / 60000)),
    rounds: Math.max(0, Number(o.rounds) || 0),
    batches: Math.max(0, Number(rec.batches) || 0),
    entries: mine.length,
    done: pr.done,
    total: pr.total,
    current: clip(pr.current || "", 200),
    next: clip(o.next || rec.next || "", 200),
    reason: clip(o.reason || "", 200),
    files,
    head: texts.slice(0, MISSION_STAGE_KEEP),
    tail: texts.slice(-MISSION_STAGE_KEEP),
  };
  rec.stages = stages.concat([stage]).slice(-MISSION_MAX_STAGES);
  const saved = missionSave(workDir, rec);
  if (!saved.ok) return saved;
  const human =
    "🧭 Этап " + stage.n + (stage.reason ? " закрыт: " + stage.reason : "") + " · " + humanTs(from) + "→" + humanTs(at) +
    (stage.minutes ? " (" + stage.minutes + " мин)" : "") + " · раундов " + stage.rounds + " · записей " + stage.entries +
    " · файлов " + files.length + " · шагов " + stage.done + "/" + stage.total +
    (!stage.reason && stage.next ? " · далее: " + stage.next : "");
  journalAppend(workDir, id, { kind: "stage", text: human, ts: at });
  return { ok: true, mission: rec, stage };
}

// Уточнение цели: человек написал новую просьбу по ходу работы. Раньше она просто
// уходила в историю и вытеснялась обрезкой — модель возвращалась к первой фразе
// («сделай всё сам») и не знала, что именно от неё теперь хотят.
function missionGoalNote(workDir, id, text) {
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const t = clip(text, 600);
  if (!t) return { ok: false, error: "Пустое уточнение цели." };
  const notes = Array.isArray(rec.goalNotes) ? rec.goalNotes : [];
  // Тот же текст дважды не пишем и цель не дублируем значением записи.
  if (notes.some((n) => n.text === t) || String(rec.goal || "").indexOf(t) >= 0) {
    return { ok: true, mission: rec, added: false };
  }
  notes.push({ at: Date.now(), text: t });
  rec.goalNotes = notes.slice(-MISSION_GOAL_NOTES_MAX);
  const saved = missionSave(workDir, rec);
  if (!saved.ok) return saved;
  journalAppend(workDir, id, { kind: "goal", text: "➕ Уточнение к цели: " + t });
  return { ok: true, mission: rec, added: true };
}

// Служебные строки кнопок продолжения: «▶ Продолжить» в панели миссии
// (missionResumeText) и кнопка «▶ Продолжить» в окне после остановки прогона
// (текст — в src/renderer/chat-run.js). Это текст ПРИЛОЖЕНИЯ, а не просьба
// человека, — уточнением к цели он быть не должен. Обе проверки живут рядом с
// самими текстами, чтобы менялись вместе.
function isResumeText(text) {
  const t = String(text || "").trim();
  return /^Продолжи миссию «/.test(t) || /^Продолжи работу с того места, где остановился/.test(t);
}

function missionNote(workDir, id, kind, text) {
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  journalAppend(workDir, id, { kind, text });
  return { ok: true };
}

function missionCounters(workDir, id, patch) {
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const p = patch || {};
  rec.rounds += Math.max(0, Number(p.rounds) || 0);
  rec.batches += Math.max(0, Number(p.batches) || 0);
  rec.metrics.tokens += Math.max(0, Number(p.tokens) || 0);
  rec.metrics.compactions += Math.max(0, Number(p.compactions) || 0);
  rec.metrics.autoContinuations += Math.max(0, Number(p.autoContinuations) || 0);
  rec.metrics.errors += Math.max(0, Number(p.errors) || 0);
  if (p.next) rec.next = clip(p.next, 400);
  const saved = missionSave(workDir, rec);
  return saved.ok ? { ok: true, mission: rec } : saved;
}

// Закрытие миссии: итог уходит в report.md, состояние — в mission.json.
function missionFinish(workDir, id, opts) {
  const o = opts || {};
  const rec = missionLoad(workDir, id);
  if (!rec) return { ok: false, error: "Миссия не найдена: " + id };
  const status = MISSION_STATUSES.indexOf(o.status) >= 0 ? o.status : "done";
  const report = clip(o.report, 20000);
  rec.status = status;
  rec.finishedAt = Date.now();
  rec.reason = clip(o.reason || "", 400);
  if (o.next) rec.next = clip(o.next, 400);
  for (const s of rec.steps) {
    if (s.state === "doing") s.state = status === "done" ? "done" : "todo";
  }
  const icons = { done: "🏁 Миссия завершена", failed: "❌ Миссия завершилась ошибкой", stopped: "⏹ Миссия остановлена", paused: "⏸ Миссия на паузе", active: "▶ Миссия продолжается" };
  journalAppend(workDir, id, { kind: "finish", text: icons[status] + (rec.reason ? ": " + rec.reason : "") + (report ? " — итог в report.md" : "") });
  if (report) {
    try {
      const pr = missionProgress(rec);
      const lines = [
        "# " + rec.title,
        "",
        "**Цель.** " + rec.goal,
        "",
        "**Итог (" + status + ", " + new Date(rec.finishedAt).toLocaleString() + ").**",
        "",
        report,
        "",
        "**План:** " + pr.done + " из " + pr.total + " выполнено" + (pr.failed ? ", не удалось: " + pr.failed : "") + ".",
        rec.steps.length ? rec.steps.map((s, i) => "- " + (s.state === "done" ? "[x]" : s.state === "failed" ? "[!]" : "[ ]") + " " + (i + 1) + ". " + s.title + (s.note ? " — " + s.note : "")).join("\n") : "",
        "",
        "**Метрики:** раундов " + rec.rounds + ", батчей " + rec.batches + ", токенов " + rec.metrics.tokens + ", сжатий " + rec.metrics.compactions + ".",
        "",
      ];
      atomicWriteText(path.join(missionDirOf(workDir, id), "report.md"), lines.join("\n"));
    } catch {}
  }
  const saved = missionSave(workDir, rec);
  return saved.ok ? { ok: true, mission: rec } : saved;
}

function missionList(workDir, opts) {
  const o = opts || {};
  const dir = missionsDir(workDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const rec = missionLoad(workDir, name);
    if (!rec) continue;
    if (o.status && o.status !== "all" && rec.status !== o.status) continue;
    out.push(rec);
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, Math.max(1, Math.min(100, Number(o.limit) || MISSION_MAX_KEEP)));
}

// Незакрытая миссия (свежая): её и продолжает кнопка «▶ Продолжить».
function missionActive(workDir) {
  const list = missionList(workDir, { limit: 20 });
  return list.find((m) => m.status === "active" || m.status === "paused") || null;
}

// Удаление миссии вместе с папкой: цель, план, журнал и отчёт уходят целиком.
// Идентификатор обязательно проверяем: он приходит из интерфейса и попадает в путь,
// а «../» в нём означал бы удаление чужой папки.
function missionDelete(workDir, id) {
  const mid = String(id || "").trim();
  if (!mid) return { ok: false, error: "Не понял, какую миссию удалять" };
  // Идентификатор — ровно ОДИН сегмент пути, и в нём бывают русские буквы
  // (слаги миссий вида «20260915-1030-черновик-на-удаление»). Поэтому проверяем
  // не алфавит, а путь: разделители, «.», «..» и выход наружу недопустимы.
  if (mid === "." || mid === ".." || mid !== path.basename(mid) || /[\/\\]/.test(mid)) {
    return { ok: false, error: "Неверный идентификатор миссии: " + mid };
  }
  const dir = missionDirOf(workDir, mid);
  if (!fs.existsSync(dir)) return { ok: false, error: "Миссия не найдена: " + mid };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, id: mid };
}

function missionPrune(workDir) {
  const all = missionList(workDir, { limit: 100 });
  const keep = all.slice(0, MISSION_MAX_KEEP);
  const keepIds = new Set(keep.map((m) => m.id));
  for (const m of all) {
    if (keepIds.has(m.id)) continue;
    try {
      fs.rmSync(missionDirOf(workDir, m.id), { recursive: true, force: true });
    } catch {}
  }
  return { kept: keep.length, removed: all.length - keep.length };
}

// Текст для «продолжи миссию»: цель, план, где остановились, хвост журнала.
function missionResumeText(rec, journalText) {
  if (!rec) return "";
  const pr = missionProgress(rec);
  const lines = [
    "Продолжи миссию «" + rec.title + "» (файлы: " + missionsPathText(rec.workDir || "", rec.id) + ").",
    "Цель: " + rec.goal,
    "План: " + (rec.steps.length ? rec.steps.map((s, i) => (i + 1) + ") " + (s.state === "done" ? "✓ " : s.state === "failed" ? "⚠ " : "") + s.title).join("; ") : "не составлен"),
    "Прогресс: " + pr.done + " из " + pr.total + " готово" + (pr.failed ? ", не удалось: " + pr.failed : "") + ".",
    pr.current ? "Остановились на: " + pr.current : "",
    "Хвост журнала:\n" + (journalText || ""),
    "Работай дальше: вызывай инструменты и после каждого шага отмечай его через missionStep(done, next). Файлы миссии обновляй сам — в них должна быть видна твоя работа.",
  ];
  return lines.filter(Boolean).join("\n");
}

// ── Зеркала: дела и контекст ──────────────────────────────────────────────────
// Дела живут в данных приложения (userData) или в своей папке, но человек просил
// видеть их файлом на ПК: зеркало кладётся в папку дел (свою) или рядом с проектом
// (в `.agent/` — как было). Памятки контекста остаются у `.agent/` рядом с проектом:
// это зеркало разговора о проекте, и уезжать вместе с делами оно не просилось.
function tasksMirror(workDir, text) {
  const dir = String(workDir || "").trim();
  const L = layoutOf(dir);
  // Пустая рабочая папка без своей папки дел — писать некуда (как было). Своя папка
  // дел делает зеркало независимым от проекта: пишем даже без рабочей папки.
  if (!dir && !L.tasksCustom) return { ok: false, error: "Не задана рабочая папка." };
  const root = L.tasksMirrorRoot || defaultRoot(dir);
  try {
    if (root === defaultRoot(dir)) ensureDefaultRoot(dir);
    else fs.mkdirSync(root, { recursive: true });
    atomicWriteText(path.join(root, "tasks.md"), clip(text, 200000) + "\n");
    return { ok: true, file: path.join(root, "tasks.md") };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

function contextMirror(workDir, ts, text) {
  const dir = String(workDir || "").trim();
  if (!dir) return { ok: false, error: "Не задана рабочая папка." };
  const body = clip(text, 20000);
  if (!body) return { ok: false, error: "Пустая памятка." };
  const t = Number(ts) || Date.now();
  try {
    ensureDefaultRoot(dir);
    const cdir = path.join(defaultRoot(dir), "context");
    fs.mkdirSync(cdir, { recursive: true });
    const file = path.join(cdir, localDayKey(t) + ".md");
    const head = "# Памятки контекста за " + localDayKey(t) + "\n";
    const chunk = "\n## " + humanTs(t) + "\n\n" + body + "\n";
    if (!fs.existsSync(file)) atomicWriteText(file, head + chunk);
    else fs.appendFileSync(file, chunk, "utf8");
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Суммарный размер папки (для настроек: видно, сколько работа агента занимает).
// Глубина ограничена: в missions/ лежат только файлы, рекурсия не уйдёт вглубь проекта.
function dirBytes(dir, depth) {
  const d = depth == null ? 3 : depth;
  if (d < 0) return 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) total += dirBytes(p, d - 1);
      else total += st.size;
    } catch {}
  }
  return total;
}

// Что уже лежит в папках работы: для настроек («папка работы агента»). Пустая
// настройка — прежние места, поэтому по умолчанию всё считается как считалось.
function mirrorStatus(workDir) {
  const dir = String(workDir || "").trim();
  const L = layoutOf(dir);
  const droot = defaultRoot(dir);
  const mroot = L.missionsRoot || droot;
  const troot = L.tasksMirrorRoot || droot;
  const out = {
    dir: dir,
    root: mroot,
    defaultRoot: droot,
    missionsRoot: mroot,
    tasksRoot: L.tasksRoot || "",
    tasksMirrorRoot: troot,
    missionsCustom: !!L.missionsCustom,
    tasksCustom: !!L.tasksCustom,
    insideProject: !!(L.missionsCustom && L.missionsInsideProject) || !!(L.tasksCustom && L.tasksInsideProject),
    exists: false,
    tasks: null,
    contextDays: [],
    missions: 0,
    bytes: 0,
  };
  if (!dir && !L.missionsCustom && !L.tasksCustom) return out;
  const fileBytes = (f) => {
    try {
      const st = fs.statSync(f);
      return st.isFile() ? st.size : 0;
    } catch {
      return 0;
    }
  };
  try {
    out.exists =
      (!!dir && fs.existsSync(droot)) ||
      (mroot !== droot && fs.existsSync(mroot)) ||
      (troot !== droot && fs.existsSync(troot));
    const tf = path.join(troot, "tasks.md");
    if (fs.existsSync(tf)) {
      const st = fs.statSync(tf);
      out.tasks = { file: tf, bytes: st.size, mtime: st.mtimeMs };
    }
    if (dir) {
      const cdir = path.join(droot, "context");
      if (fs.existsSync(cdir)) {
        out.contextDays = fs
          .readdirSync(cdir)
          .filter((f) => /\.md$/.test(f))
          .sort()
          .reverse()
          .slice(0, 30);
      }
      out.missions = missionList(dir, { limit: 100 }).length;
    }
    let bytes = dir ? dirBytes(droot) : 0;
    if (mroot !== droot) bytes += dirBytes(mroot);
    // В своей папке дел могут лежать и другие файлы человека: считаем только файлы
    // дела (tasks.json и зеркало), иначе цифра «сколько занимает работа агента»
    // врала бы в разы.
    if (troot !== droot) bytes += fileBytes(tf) + fileBytes(path.join(troot, "tasks.json"));
    out.bytes = bytes;
  } catch {}
  return out;
}

// Очистка зеркал: убираем только tasks.md и context/ — миссии не трогаем,
// это работа агента, её удаляет человек сам в проводнике.
function mirrorClear(workDir) {
  const dir = String(workDir || "").trim();
  const L = layoutOf(dir);
  if (!dir && !L.tasksCustom) return { ok: false, error: "Не задана рабочая папка." };
  const removed = [];
  try {
    const tf = path.join(L.tasksMirrorRoot || defaultRoot(dir), "tasks.md");
    if (fs.existsSync(tf)) {
      fs.rmSync(tf, { force: true });
      removed.push("tasks.md");
    }
    if (dir) {
      const cdir = path.join(defaultRoot(dir), "context");
      if (fs.existsSync(cdir)) {
        fs.rmSync(cdir, { recursive: true, force: true });
        removed.push("context/");
      }
    }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  return { ok: true, removed };
}

module.exports = {
  AGENT_DIR,
  MISSIONS_DIR,
  MISSION_MAX_KEEP,
  MISSION_MAX_STEPS,
  JOURNAL_KEEP_LINES,
  MISSION_STATUSES,
  STEP_STATES,
  defaultRoot,
  agentRoot,
  missionsDir,
  missionDirOf,
  missionFile,
  ensureAgentRoot,
  ensureDefaultRoot,
  missionsPathText,
  slugify,
  missionCreate,
  missionLoad,
  missionSave,
  missionProgress,
  missionStep,
  missionSetPlan,
  missionStage,
  missionGoalNote,
  isResumeText,
  missionNote,
  missionCounters,
  missionFinish,
  missionList,
  missionActive,
  missionDelete,
  missionPrune,
  missionJournal,
  missionJournalText,
  missionResumeText,
  tasksMirror,
  contextMirror,
  mirrorStatus,
  mirrorClear,
};

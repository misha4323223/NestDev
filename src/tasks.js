"use strict";

/* ─── Дела со сроками и их повторы ───────────────────────────────────────────
   Вынесено из agent-store.js (часть 38). Разбор срока человеческий: «завтра 14:00»,
   «15.09», «через 2 часа», «в пятницу», «10 октября». Хранятся одним файлом
   <userData>/tasks.json — вне рабочей папки.

   pad2 берётся из src/store-files.js: в agent-store.js он был объявлен дважды,
   и здесь лежало ВТОРОЕ объявление — то самое, что исполнялось. */

const path = require("path");
const fs = require("fs");
const { pad2 } = require("./store-files.js");

// ── Дела (задачи со сроками) ────────────────────────────────────────────────
// Личные задачи пользователя: срок, приоритет, статус, проект. Лежат ОДНИМ файлом
// <userData>/tasks.json — вне рабочей папки, чтобы дела не попадали в git и не
// мусорили в чужом репозитории. Разбор сроков человеческий: «завтра 14:00»,
// «15.09», «через 2 часа», «в пятницу», «10 октября».
const TASK_MAX = 500; // активных дел
const TASK_TITLE_MAX = 300;
const TASK_NOTE_MAX = 2000;
const TASK_STATUSES = ["todo", "doing", "done", "canceled"];
const TASK_PRIORITIES = ["low", "normal", "high"];
const TASK_REMIND_BEFORE_MS = 15 * 60 * 1000; // напоминаем за 15 минут до срока
// Автозапуск агентом идёт двумя шагами: приложение выдаёт дело на прогон (autoPending),
// клиент подтверждает, что прогон действительно начался (tasksAutoAck). Пока подтверждения
// нет дольше TASK_AUTO_PENDING_MS — выдаём снова, но не больше TASK_AUTO_TRIES_MAX раз.
// Так дело не «сгорает» молча, если прогон не состоялся (нет модели, окно закрыто, сбой).
const TASK_AUTO_PENDING_MS = 3 * 60 * 1000; // сколько ждём подтверждения запуска
const TASK_AUTO_RETRY_MS = 2 * 60 * 1000; // пауза перед повторной попыткой
const TASK_AUTO_TRIES_MAX = 3; // после этого сообщаем человеку и больше не пристаём
const TASK_REPEAT_MAX_MIN = 60 * 24 * 31; // «каждые N минут» — не реже раза в месяц
const TASK_ALLDAY_HOUR = 9; // срок «в этот день» без времени = 09:00
const WEEKDAY_NAMES = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WEEKDAY_INDEX = [
  ["воскресень", 0], ["понедельник", 1], ["вторник", 2], ["сред", 3],
  ["четверг", 4], ["пятниц", 5], ["суббот", 6],
];
const MONTH_NAMES = [
  ["январ", 1], ["феврал", 2], ["март", 3], ["апрел", 4], ["май", 5], ["мая", 5],
  ["июн", 6], ["июл", 7], ["август", 8], ["сентябр", 9], ["октябр", 10],
  ["ноябр", 11], ["декабр", 12],
];
// Падеж для показа срока: «15 сентября».
const MONTH_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

function tasksFile(userData) {
  return path.join(userData, "tasks.json");
}

function tasksLoad(userData) {
  try {
    const d = JSON.parse(fs.readFileSync(tasksFile(userData), "utf8"));
    if (d && Array.isArray(d.tasks)) {
      if (!Number.isFinite(d.seq)) d.seq = d.tasks.length;
      return d;
    }
  } catch {}
  return { version: 1, seq: 0, tasks: [] };
}

function tasksSave(userData, data) {
  const file = tasksFile(userData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// Срок в формате «ГГГГ-ММ-ДДTЧЧ:ММ» — ЛОКАЛЬНОЕ время пользователя, без таймзон.
function fmtDue(d) {
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes())
  );
}

function startOfDay(d) {
  const x = new Date(d.getTime());
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Срок, записанный в тексте, → дата+время. null — не нашли.
function parseDue(input, nowMs) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { ok: true, due: "", allDay: false };
  // Полная метка времени (ISO 8601: «2026-09-21T15:18:19.656Z», «2026-09-21T15:18:19»,
  // «2026-09-21 15:18») — время в ней ЧАСТЬ срока, а не украшение. Раньше оно
  // отбрасывалось (часы искались шаблоном без секунд и таймзоны), и дело «час назад»
  // превращалось в «сегодня 09:00»: просроченное уезжало в группу «Сегодня»,
  // а счётчик «Просрочено» оставался нулевым.
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[Tt ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const d = new Date(
      iso[1] + "-" + pad2(parseInt(iso[2], 10)) + "-" + pad2(parseInt(iso[3], 10)) +
      "T" + pad2(parseInt(iso[4], 10)) + ":" + iso[5] + ":" + (iso[6] || "00") +
      (iso[7] ? iso[7].toUpperCase() : "")
    );
    // Негодный час («25:00») не роняем: пусть решает старый разбор — он прочтёт
    // хотя бы дату, как читал раньше.
    if (!isNaN(d.getTime())) return { ok: true, due: fmtDue(d), allDay: false };
  }
  const base = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  let s = " " + raw.toLowerCase().replace(/[«»"',]/g, " ").replace(/\s+/g, " ").trim() + " ";

  const num = (re) => {
    const m = s.match(re);
    return m ? parseInt(m[1], 10) : null;
  };

  // 1) «через 2 часа», «через 3 дня», «через неделю»
  const rel = s.match(/через\s+(\d+)?\s*(минут|мин|час|час[аов]|день|дн[яей]|дней|недел[юиь]|месяц|год)/);
  if (rel) {
    const n = rel[1] ? parseInt(rel[1], 10) : 1;
    const unit = rel[2];
    const d = new Date(base.getTime());
    if (/^мин/.test(unit)) d.setMinutes(d.getMinutes() + n);
    else if (/^час/.test(unit)) d.setHours(d.getHours() + n);
    else if (/^недел/.test(unit)) d.setDate(d.getDate() + 7 * n);
    else if (/^месяц/.test(unit)) d.setMonth(d.getMonth() + n);
    else if (/^год/.test(unit)) d.setFullYear(d.getFullYear() + n);
    else d.setDate(d.getDate() + n); // день/дня/дней
    const t = clockFromText(s);
    if (t) d.setHours(t.h, t.m, 0, 0);
    else if (/^день|^дн[яей]$/.test(unit) || /^недел|^месяц|^год/.test(unit)) d.setHours(TASK_ALLDAY_HOUR, 0, 0, 0);
    return { ok: true, due: fmtDue(d), allDay: false };
  }

  // Часы вынимаем из строки ПЕРВЫМИ, чтобы «14:30» не спутать с датой.
  const clock = clockFromText(s);
  if (clock) s = s.replace(clock.src, " ");

  // 2) ISO: 2026-09-15
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return finishDue(d, clock);
  }

  // 3) Дата без года: 15.09, 15.09.2026, 15/09
  m = s.match(/(?:^|[Tt\s])(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s|$)/);
  if (m) {
    const day = parseInt(m[1], 10);
    let mon = parseInt(m[2], 10);
    let year = m[3] ? parseInt(m[3], 10) : 0;
    if (year && year < 100) year += 2000;
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      const d = new Date(year || base.getFullYear(), mon - 1, day);
      // Без года и дата уже прошла — речь о следующем годе (15.09 наступит ещё раз).
      if (!year && d.getTime() < startOfDay(base).getTime()) d.setFullYear(d.getFullYear() + 1);
      return finishDue(d, clock, !year);
    }
  }

  // 4) «15 сентября», «10 октября 2027»
  m = s.match(/(\d{1,2})\s+([а-яё]+)\s*(\d{4})?/);
  if (m) {
    const word = m[2];
    const mon = MONTH_NAMES.find((x) => word.startsWith(x[0]));
    if (mon) {
      const d = new Date(m[3] ? parseInt(m[3], 10) : base.getFullYear(), mon[1] - 1, parseInt(m[1], 10));
      if (!m[3] && d.getTime() < startOfDay(base).getTime()) d.setFullYear(d.getFullYear() + 1);
      return finishDue(d, clock, !m[3]);
    }
  }

  // 5) Слова: сегодня / завтра / послезавтра (+ «утром», «вечером», «днём»)
  const words = [
    [/послезавтра/, 2],
    [/завтра/, 1],
    [/сегодня|сейчас/, 0],
  ];
  for (const [re, shift] of words) {
    if (re.test(s)) {
      const d = addDays(base, shift);
      if (shift === 0 && /сейчас/.test(s) && !clock) return { ok: true, due: fmtDue(base), allDay: false };
      return finishDue(d, clock || dayPartClock(s));
    }
  }

  // 6) День недели: «в пятницу», «понедельник»
  const wd = WEEKDAY_INDEX.find((x) => s.includes(x[0]));
  if (wd) {
    const today = startOfDay(base);
    let diff = (wd[1] - today.getDay() + 7) % 7;
    const d = addDays(base, diff);
    if (diff === 0 && clock && endOfDue(d, clock).getTime() < base.getTime()) diff = 7;
    return finishDue(addDays(base, diff), clock || dayPartClock(s));
  }

  // 6b) Только часть дня: «утром», «вечером», «днём», «ночью».
  const part = dayPartClock(s);
  if (part) {
    let d = new Date(base.getTime());
    d.setHours(part.h, part.m, 0, 0);
    if (d.getTime() <= base.getTime()) d = addDays(d, 1);
    d.setHours(part.h, part.m, 0, 0);
    return { ok: true, due: fmtDue(d), allDay: false };
  }

  // 7) Только время («в 14:30») — сегодня, а если прошло, то завтра.
  if (clock) {
    let d = new Date(base.getTime());
    d.setHours(clock.h, clock.m, 0, 0);
    if (d.getTime() <= base.getTime()) d = addDays(d, 1);
    d.setHours(clock.h, clock.m, 0, 0);
    return { ok: true, due: fmtDue(d), allDay: false };
  }

  return { ok: false, error: "Не понял срок «" + raw + "». Примеры: 2026-09-15, 15.09, 15.09.2026 14:30, завтра 14:00, в пятницу, через 2 часа." };
}

// Время из текста: «14:30», «14.30» (только если минут > 12 — иначе это дата), «в 14».
function clockFromText(s) {
  let m = s.match(/(?:^|[Tt\s]|в\s)(\d{1,2}):(\d{2})(?=\s|$)/);
  if (m) {
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h <= 23 && mi <= 59) return { h: h, m: mi, src: m[0] };
  }
  m = s.match(/(?:^|[Tt\s])в\s(\d{1,2})[.](\d{2})(?=\s|$)/);
  if (m) {
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h <= 23 && mi <= 59) return { h: h, m: mi, src: m[0] };
  }
  m = s.match(/(?:^|[Tt\s])(\d{1,2})[.](\d{2})(?=\s|$)/);
  if (m) {
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h <= 23 && mi > 12) return { h: h, m: mi, src: m[0] }; // 14.30 = время, 15.09 = дата
  }
  m = s.match(/(?:^|[Tt\s])в\s(\d{1,2})(?=\s|$)/);
  if (m) {
    const h = parseInt(m[1], 10);
    if (h <= 23) return { h: h, m: 0, src: m[0] };
  }
  return null;
}

// «утром» / «днём» / «вечером» → привычное время.
function dayPartClock(s) {
  if (/утр/.test(s)) return { h: 9, m: 0 };
  if (/дн[её]м|обед/.test(s)) return { h: 13, m: 0 };
  if (/вечер|к вечеру/.test(s)) return { h: 19, m: 0 };
  if (/ноч/.test(s)) return { h: 23, m: 0 };
  return null;
}

function endOfDue(d, clock) {
  const x = new Date(d.getTime());
  x.setHours(clock.h, clock.m, 0, 0);
  return x;
}

function finishDue(d, clock, rollYear) {
  if (isNaN(d.getTime())) return { ok: false, error: "Такой даты не существует." };
  if (clock) {
    d.setHours(clock.h, clock.m, 0, 0);
    return { ok: true, due: fmtDue(d), allDay: false };
  }
  d.setHours(TASK_ALLDAY_HOUR, 0, 0, 0);
  return { ok: true, due: fmtDue(d), allDay: true, rolledYear: !!rollYear };
}

// Локальный ключ дня для группировки: 2026-09-15
function dayKey(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

// ── Повторы дел ─────────────────────────────────────────────────────────────
// Дело может повторяться. Хранится одной строкой: "" (без повтора), "daily",
// "weekdays", "weekly", "weekly:<день недели>", "monthly", "every:<минут>".
// Разбор человеческий: «каждый день», «по будням», «каждую пятницу»,
// «каждый месяц», «каждые 2 часа», «раз в неделю».
const WEEKDAY_ACC = ["воскресенье", "понедельник", "вторник", "среду", "четверг", "пятницу", "субботу"];

function parseRepeat(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase().replace(/ё/g, "е");
  if (!raw) return { ok: true, repeat: "" };
  if (/^(нет|без повтор[а-я]*|однократ[а-я]*|один раз|once|none|-|0)$/.test(raw)) return { ok: true, repeat: "" };
  // «каждые N минут/часов»
  let m = raw.match(/кажд[а-я]*\s*(\d+)?\s*(минут|мин|час|часа|часов)/);
  if (m) {
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const mins = /^мин/.test(m[2]) ? n : n * 60;
    if (!(mins >= 1) || mins > TASK_REPEAT_MAX_MIN) return repeatError(raw);
    return { ok: true, repeat: "every:" + mins };
  }
  if (/(кажд[а-я]*\s*(день|дня|дней)|ежедневн|daily)/.test(raw)) return { ok: true, repeat: "daily" };
  if (/будн|по рабочим|weekday/.test(raw)) return { ok: true, repeat: "weekdays" };
  // Конкретный день недели: «каждую пятницу» (до общего «каждую неделю»).
  const wd = WEEKDAY_INDEX.find((x) => raw.includes(x[0]));
  if (wd && /кажд|по /.test(raw)) return { ok: true, repeat: "weekly:" + wd[1] };
  if (/(кажд[а-я]*\s*недел|раз в неделю|weekly)/.test(raw)) return { ok: true, repeat: "weekly" };
  if (/(кажд[а-я]*\s*месяц|раз в месяц|monthly)/.test(raw)) return { ok: true, repeat: "monthly" };
  return repeatError(raw);
}

function repeatError(raw) {
  return {
    ok: false,
    error: "Не понял повтор «" + raw + "». Примеры: каждый день, по будням, каждую пятницу, каждый месяц, каждые 2 часа, без повтора.",
  };
}

function repeatLabel(repeat) {
  const r = String(repeat || "");
  if (!r) return "";
  if (r === "daily") return "каждый день";
  if (r === "weekdays") return "по будням";
  if (r === "weekly") return "каждую неделю";
  if (r === "monthly") return "каждый месяц";
  if (r.startsWith("weekly:")) {
    const d = parseInt(r.slice(7), 10);
    return d >= 0 && d <= 6 ? "каждую " + WEEKDAY_ACC[d] : "каждую неделю";
  }
  if (r.startsWith("every:")) {
    const mins = parseInt(r.slice(6), 10) || 60;
    return mins % 60 === 0 && mins >= 60 ? "каждые " + mins / 60 + " ч" : "каждые " + mins + " мин";
  }
  return r;
}

// Следующий срок после указанного — по повторам. Всегда СТРОГО позже now,
// чтобы дело не «крутилось» на одном моменте.
function nextDueDate(from, repeat, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const r = String(repeat || "");
  const d = new Date(from.getTime());
  if (!r) return d;
  const bump = () => {
    if (r === "daily") d.setDate(d.getDate() + 1);
    else if (r === "weekdays") { do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); }
    else if (r === "weekly") d.setDate(d.getDate() + 7);
    else if (r.startsWith("weekly:")) {
      const want = parseInt(r.slice(7), 10);
      do { d.setDate(d.getDate() + 1); } while (d.getDay() !== want);
    } else if (r === "monthly") {
      const day = d.getDate();
      d.setMonth(d.getMonth() + 1);
      if (d.getDate() !== day) d.setDate(0); // 31-е в коротком месяце → последний день
    } else if (r.startsWith("every:")) {
      d.setMinutes(d.getMinutes() + (parseInt(r.slice(6), 10) || 60));
    }
  };
  let guard = 0;
  do { bump(); guard++; } while (d.getTime() <= now && guard < 400);
  return d;
}

// Сдвинуть повторяющееся дело на следующий срок (после того как оно сработало).
function advanceRepeat(t, nowMs) {
  if (!t || !t.repeat || !t.due) return false;
  const at = dueDate(t);
  if (!at) return false;
  t.due = fmtDue(nextDueDate(at, t.repeat, nowMs));
  t.firedAt = 0;
  t.remindedAt = 0;
  t.updatedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
  return true;
}

// Сброс состояния автозапуска: новый срок, повтор или отметка — попытки начинаются заново.
function resetAutoState(t) {
  t.autoPending = 0;
  t.autoTries = 0;
  t.autoNextAt = 0;
  t.autoGaveUp = false;
  t.autoLastError = "";
}

// Поиск дела по id («t7») или по куску названия. Возвращает { task } либо { error }.
function tasksFind(data, key) {
  const k = String(key == null ? "" : key).trim();
  if (!k) return { error: "Укажи id или название дела (taskList покажет список)." };
  const byId = data.tasks.find((t) => t.id === k);
  if (byId) return { task: byId };
  const low = k.toLowerCase();
  const hits = data.tasks.filter((t) => String(t.title || "").toLowerCase().includes(low));
  if (hits.length === 1) return { task: hits[0] };
  if (!hits.length) return { error: "Дело «" + k + "» не найдено." };
  return {
    error: "Под «" + k + "» подходит несколько дел: " + hits.slice(0, 6).map((t) => t.id + " " + t.title).join("; ") + ". Уточни id.",
  };
}

// nowMs — необязательный момент расчёта (тесты и сценарии с опорным временем):
// без него берётся текущее время, как и раньше.
function tasksAdd(userData, input, nowMs) {
  const inp = input || {};
  const title = String(inp.title || "").trim().slice(0, TASK_TITLE_MAX);
  if (!title) return { ok: false, error: "Укажи title — что нужно сделать." };
  const data = tasksLoad(userData);
  const active = data.tasks.filter((t) => t.status !== "done" && t.status !== "canceled").length;
  if (active >= TASK_MAX) {
    return { ok: false, error: "Достигнут лимит активных дел (" + TASK_MAX + "). Закрой или удали лишние." };
  }
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const dueR = parseDue(inp.due, now);
  if (!dueR.ok) return { ok: false, error: dueR.error };
  const priority = TASK_PRIORITIES.includes(inp.priority) ? inp.priority : "normal";
  const repR = parseRepeat(inp.repeat);
  if (!repR.ok) return { ok: false, error: repR.error };
  const task = {
    id: "t" + (++data.seq),
    title: title,
    note: String(inp.note || "").trim().slice(0, TASK_NOTE_MAX),
    due: dueR.due || "",
    allDay: !!dueR.allDay,
    priority: priority,
    status: "todo",
    project: String(inp.project || "").trim().slice(0, 120),
    repeat: repR.repeat,
    auto: !!inp.auto,
    prompt: String(inp.prompt || "").trim().slice(0, TASK_NOTE_MAX),
    chatId: String(inp.chatId || "").trim().slice(0, 80),
    snoozeUntil: 0,
    firedAt: 0,
    runs: 0,
    // Состояние автозапуска агентом (см. tasksTakeAuto / tasksAutoAck).
    autoPending: 0, // выдали на прогон, ждём подтверждения
    autoTries: 0, // попыток для текущего срока
    autoNextAt: 0, // пауза перед следующей попыткой
    autoGaveUp: false, // попытки кончились — сказали человеку
    autoLastError: "", // почему не вышло (для человека)
    autoAckedAt: 0, // когда прогон подтвердили
    createdAt: now,
    updatedAt: now,
    doneAt: 0,
    remindedAt: 0,
  };
  data.tasks.push(task);
  tasksSave(userData, data);
  return {
    ok: true,
    task: task,
    message: "Дело «" + task.title + "» добавлено (" + task.id + (task.due ? ", срок: " + humanDue(task, now) : ", без срока") +
      (task.repeat ? ", повтор: " + repeatLabel(task.repeat) : "") + (task.auto ? ", выполняет агент" : "") + ").",
  };
}

function tasksUpdate(userData, key, patch) {
  const data = tasksLoad(userData);
  const found = tasksFind(data, key);
  if (!found.task) return { ok: false, error: found.error };
  const t = found.task;
  const p = patch || {};
  if (p.title !== undefined) {
    const title = String(p.title || "").trim().slice(0, TASK_TITLE_MAX);
    if (!title) return { ok: false, error: "Название не может быть пустым." };
    t.title = title;
  }
  if (p.note !== undefined) t.note = String(p.note || "").trim().slice(0, TASK_NOTE_MAX);
  if (p.project !== undefined) t.project = String(p.project || "").trim().slice(0, 120);
  if (p.priority !== undefined) {
    if (!TASK_PRIORITIES.includes(p.priority)) {
      return { ok: false, error: "Приоритет может быть low, normal или high." };
    }
    t.priority = p.priority;
  }
  if (p.due !== undefined) {
    const dueR = parseDue(p.due, Date.now());
    if (!dueR.ok) return { ok: false, error: dueR.error };
    t.due = dueR.due || "";
    t.allDay = !!dueR.allDay;
    t.remindedAt = 0; // новый срок — напомнить заново
    t.firedAt = 0; // новый срок — автозадача может сработать снова
    resetAutoState(t);
  }
  if (p.repeat !== undefined) {
    const repR2 = parseRepeat(p.repeat);
    if (!repR2.ok) return { ok: false, error: repR2.error };
    t.repeat = repR2.repeat;
    t.firedAt = 0;
    resetAutoState(t);
  }
  if (p.auto !== undefined) {
    t.auto = !!p.auto;
    t.firedAt = 0;
    resetAutoState(t);
  }
  if (p.prompt !== undefined) t.prompt = String(p.prompt || "").trim().slice(0, TASK_NOTE_MAX);
  // Отсрочка: «напомни через час» — срок не меняем, но приставать перестаём до этого момента.
  if (p.snooze !== undefined) {
    const snR = parseDue(p.snooze, Date.now());
    if (!snR.ok) return { ok: false, error: snR.error };
    t.snoozeUntil = snR.due ? new Date(snR.due).getTime() : 0;
    t.remindedAt = 0;
    resetAutoState(t);
  }
  if (p.status !== undefined) {
    if (!TASK_STATUSES.includes(p.status)) {
      return { ok: false, error: "Статус может быть todo, doing, done или canceled." };
    }
    t.status = p.status;
    t.doneAt = p.status === "done" ? Date.now() : 0;
  }
  t.updatedAt = Date.now();
  tasksSave(userData, data);
  return { ok: true, task: t, message: "Дело «" + t.title + "» обновлено (" + t.id + "): " + taskLine(t, Date.now()) };
}

// Отметить выполненным (или снять отметку) — отдельный короткий путь для агента.
function tasksDone(userData, key, done) {
  return tasksUpdate(userData, key, { status: done === false ? "todo" : "done" });
}

function tasksDelete(userData, key) {
  const data = tasksLoad(userData);
  const found = tasksFind(data, key);
  if (!found.task) return { ok: false, error: found.error };
  const t = found.task;
  data.tasks = data.tasks.filter((x) => x.id !== t.id);
  tasksSave(userData, data);
  return { ok: true, message: "Дело «" + t.title + "» (" + t.id + ") удалено." };
}

// Отбор списка: { status: "active"|"done"|"all", project, due: "today"|"week"|"overdue" }.
function tasksList(userData, opts) {
  const o = opts || {};
  // nowMs — только для повторного расчёта на фиксированный момент (тесты,
  // разбор «что было на 9:00»); в работе всегда настоящее время.
  const now = Number.isFinite(o.nowMs) ? o.nowMs : Date.now();
  const data = tasksLoad(userData);
  const project = String(o.project || "").trim().toLowerCase();
  const status = o.status || "active";
  let list = data.tasks.filter((t) => {
    if (project && String(t.project || "").toLowerCase() !== project) return false;
    if (status === "active") return t.status === "todo" || t.status === "doing";
    if (status === "done") return t.status === "done";
    return true;
  });
  if (o.due) {
    const today = startOfDay(new Date(now));
    list = list.filter((t) => {
      if (!t.due) return o.due === "none";
      const at = dueDate(t);
      if (!at) return false;
      if (o.due === "overdue") return at.getTime() < now;
      if (o.due === "today") return dayKey(at) === dayKey(today);
      if (o.due === "tomorrow") return dayKey(at) === dayKey(addDays(today, 1));
      if (o.due === "week") return at.getTime() <= addDays(today, 7).getTime();
      return true;
    });
  }
  list = list.slice().sort(taskCompare(now));
  return { ok: true, tasks: list, summary: tasksSummary(data.tasks, now), total: data.tasks.length };
}

function dueDate(t) {
  if (!t || !t.due) return null;
  const d = new Date(String(t.due));
  return isNaN(d.getTime()) ? null : d;
}

function taskCompare(now) {
  return (a, b) => {
    const rank = (t) => (t.status === "done" || t.status === "canceled" ? 2 : t.due && dueDate(t) && dueDate(t).getTime() < now ? 0 : 1);
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const da = dueDate(a);
    const db = dueDate(b);
    if (da && db && da.getTime() !== db.getTime()) return da.getTime() - db.getTime();
    if (da && !db) return -1;
    if (!da && db) return 1;
    const pr = { high: 0, normal: 1, low: 2 };
    if (pr[a.priority] !== pr[b.priority]) return pr[a.priority] - pr[b.priority];
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  };
}

function tasksSummary(tasks, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const today = startOfDay(new Date(now));
  const s = { overdue: 0, today: 0, tomorrow: 0, week: 0, noDue: 0, done: 0, active: 0, total: 0 };
  let next = null;
  for (const t of Array.isArray(tasks) ? tasks : []) {
    s.total++;
    if (t.status === "done") {
      s.done++;
      continue;
    }
    if (t.status === "canceled") continue;
    s.active++;
    const at = dueDate(t);
    if (!at) {
      s.noDue++;
      continue;
    }
    if (at.getTime() < now) s.overdue++;
    else if (dayKey(at) === dayKey(today)) s.today++;
    else if (dayKey(at) === dayKey(addDays(today, 1))) s.tomorrow++;
    else if (at.getTime() <= addDays(today, 7).getTime()) s.week++;
    if (at.getTime() >= now && (!next || at.getTime() < next.getTime())) next = at;
  }
  return { summary: s, nextAt: next ? fmtDue(next) : "" };
}

// Что показать в панели «Дела»: группы по срокам, как в таск-менеджере.
function tasksBoard(userData, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const data = tasksLoad(userData);
  const sorted = data.tasks.filter((t) => t.status === "todo" || t.status === "doing").sort(taskCompare(now));
  const today = startOfDay(new Date(now));
  const groups = [
    { id: "overdue", title: "Просрочено", tasks: [] },
    { id: "today", title: "Сегодня", tasks: [] },
    { id: "tomorrow", title: "Завтра", tasks: [] },
    { id: "week", title: "На этой неделе", tasks: [] },
    { id: "later", title: "Позже", tasks: [] },
    { id: "none", title: "Без срока", tasks: [] },
  ];
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const t of sorted) {
    const at = dueDate(t);
    if (!at) {
      byId.get("none").tasks.push(t);
      continue;
    }
    if (at.getTime() < now) byId.get("overdue").tasks.push(t);
    else if (dayKey(at) === dayKey(today)) byId.get("today").tasks.push(t);
    else if (dayKey(at) === dayKey(addDays(today, 1))) byId.get("tomorrow").tasks.push(t);
    else if (at.getTime() <= addDays(today, 7).getTime()) byId.get("week").tasks.push(t);
    else byId.get("later").tasks.push(t);
  }
  const done = data.tasks.filter((t) => t.status === "done").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 30);
  return { ok: true, groups: groups, done: done, summary: tasksSummary(data.tasks, now).summary };
}

// Напоминания: дела, до срока которых осталось меньше 15 минут (и просроченные,
// о которых ещё не напоминали). Сразу помечаем remindedAt — повторно не пристаём.
// opts.includeAuto — напоминать и о делах «▶ агент»: это нужно, когда автозадачи
// в настройках выключены, иначе такое дело молчит насовсем (ни агента, ни тоста).
function tasksTakeReminders(userData, nowMs, opts) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const includeAuto = !!(opts && opts.includeAuto);
  const data = tasksLoad(userData);
  const out = [];
  let changed = false;
  for (const t of data.tasks) {
    if (t.status === "done" || t.status === "canceled") continue;
    if (t.auto && !includeAuto) continue; // автозадачу будит агент, а не тост
    if (t.snoozeUntil && t.snoozeUntil > now) continue; // отсрочено — молчим
    const at = dueDate(t);
    if (!at) continue;
    if (t.remindedAt) continue;
    if (at.getTime() - now > TASK_REMIND_BEFORE_MS) continue;
    t.remindedAt = now;
    out.push(Object.assign({}, t)); // снимок ДО сдвига повтора — в тосте старый срок
    if (t.repeat) advanceRepeat(t, now);
    changed = true;
  }
  if (changed) tasksSave(userData, data);
  return { ok: true, tasks: out };
}

// Автозадачи: срок пришёл — пора будить агента. Выдаём двумя шагами: выдача
// (autoPending) и подтверждение окна (tasksAutoAck). Пока подтверждения нет —
// повторяем попытку, а повтор сдвигаем ТОЛЬКО по подтверждённому прогону:
// сорвавшийся запуск не должен увозить расписание. Разовые остаются активными
// (закрыть их — дело человека или агента). firedAt не даёт запустить одно и то же
// дважды. Возвращает { tasks, failed }: tasks — что отдать на прогон, failed —
// о чём сказать человеку.
function tasksTakeAuto(userData, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const data = tasksLoad(userData);
  const out = [];
  const failed = [];
  let changed = false;
  for (const t of data.tasks) {
    if (t.status === "done" || t.status === "canceled") continue;
    if (!t.auto) continue;
    if (t.snoozeUntil && t.snoozeUntil > now) continue;
    const at = dueDate(t);
    if (!at) continue;
    if (now < at.getTime()) continue; // срок ещё не пришёл
    if (t.firedAt && t.firedAt >= at.getTime()) {
      // Уже выдали на этот срок. Ждём подтверждения от клиента; не дождались —
      // повторяем попытку: иначе сорвавшийся прогон съедал срабатывание навсегда.
      if (!t.autoPending) continue;
      if (now - t.autoPending < TASK_AUTO_PENDING_MS) continue;
      if ((t.autoTries || 0) >= TASK_AUTO_TRIES_MAX) {
        t.autoPending = 0;
        t.autoGaveUp = true;
        t.updatedAt = now;
        failed.push({ id: t.id, title: t.title, due: t.due, tries: t.autoTries || 0, error: t.autoLastError || "" });
        changed = true;
        continue;
      }
    }
    if (t.autoNextAt && now < t.autoNextAt) continue; // пауза после неудачной попытки
    t.firedAt = at.getTime();
    t.autoPending = now;
    t.autoTries = (t.autoTries || 0) + 1;
    t.autoNextAt = 0;
    t.autoGaveUp = false;
    t.runs = (t.runs || 0) + 1;
    t.updatedAt = now;
    out.push({ id: t.id, title: t.title, prompt: t.prompt || "", note: t.note || "", repeat: t.repeat || "", due: t.due, runs: t.runs, tries: t.autoTries });
    // Повтор двигаем НЕ здесь, а по подтверждению прогона (tasksAutoAck):
    // сорвавшийся запуск не должен увозить расписание.
    changed = true;
  }
  if (changed) tasksSave(userData, data);
  return { ok: true, tasks: out, failed: failed };
}

// Подтверждение от клиента: прогон начался (ok) либо не смог начаться.
// Срабатывание фиксируем и повтор сдвигаем ТОЛЬКО здесь. При отказе освобождаем срок
// и пробуем снова через паузу — вместо прежнего молчаливого «сгорания» дела.
function tasksAutoAck(userData, key, ok, error) {
  const data = tasksLoad(userData);
  const found = tasksFind(data, key);
  if (!found.task) return { ok: false, error: found.error };
  const t = found.task;
  const now = Date.now();
  if (ok === false) {
    t.firedAt = 0;
    t.autoPending = 0;
    t.autoNextAt = now + TASK_AUTO_RETRY_MS;
    t.autoLastError = String(error || "").slice(0, 200);
  } else {
    t.autoPending = 0;
    t.autoNextAt = 0;
    t.autoAckedAt = now;
    t.autoLastError = "";
    t.autoGaveUp = false;
    if (t.repeat) advanceRepeat(t, now);
  }
  t.updatedAt = now;
  tasksSave(userData, data);
  return { ok: true, task: t };
}

// Ручной прогон («▶ сейчас») удался: снимаем «сдался», чтобы планировщик снова брал дело.
function tasksAutoRearm(userData, key) {
  const data = tasksLoad(userData);
  const found = tasksFind(data, key);
  if (!found.task) return { ok: false, error: found.error };
  const t = found.task;
  const now = Date.now();
  resetAutoState(t);
  if (t.repeat) advanceRepeat(t, now);
  t.updatedAt = now;
  tasksSave(userData, data);
  return { ok: true, task: t };
}

// Через сколько миллисекунд наступит ближайший срок — чтобы будильник сработал
// минута в минуту, а не «при следующем опросе». 0 — ждать нечего.
function tasksNextDue(userData, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const data = tasksLoad(userData);
  let best = 0;
  for (const t of data.tasks) {
    if (t.status === "done" || t.status === "canceled") continue;
    const at = dueDate(t);
    if (!at) continue;
    let when = at.getTime();
    if (t.snoozeUntil && t.snoozeUntil > now) when = Math.max(when, t.snoozeUntil);
    if (when <= now) continue; // уже пора — разберётся текущая проверка
    if (!best || when < best) best = when;
  }
  return best ? best - now : 0;
}

// «сегодня 14:30», «завтра (без времени)», «просрочено на 2 ч» — для агента и UI.
function humanDue(t, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const at = dueDate(t);
  if (!at) return "без срока";
  const today = startOfDay(new Date(now));
  const dk = dayKey(at);
  let day = "";
  if (dk === dayKey(today)) day = "сегодня";
  else if (dk === dayKey(addDays(today, 1))) day = "завтра";
  else if (dk === dayKey(addDays(today, -1))) day = "вчера";
  else day = at.getDate() + " " + MONTH_GEN[at.getMonth()];
  const time = t.allDay ? "" : " " + pad2(at.getHours()) + ":" + pad2(at.getMinutes());
  const late = at.getTime() < now;
  const mins = Math.round(Math.abs(now - at.getTime()) / 60000);
  const ago = mins < 60 ? mins + " мин" : Math.round(mins / 60) + " ч";
  return (late ? "⚠ просрочено (" + day + time + ", " + ago + " назад)" : day + time + (t.allDay ? " (без времени)" : ""));
}

function taskLine(t, nowMs) {
  const pr = t.priority === "high" ? "❗" : t.priority === "low" ? "·" : "";
  const st = t.status === "doing" ? "в работе" : t.status === "done" ? "выполнено" : t.status === "canceled" ? "отменено" : "к выполнению";
  return pr + t.id + " · " + t.title + " — " + humanDue(t, nowMs) + " · " + st +
    (t.repeat ? " · 🔁 " + repeatLabel(t.repeat) : "") +
    (t.auto ? " · ▶ выполняет агент" : "") +
    (t.project ? " · проект: " + t.project : "") + (t.note ? " · заметка: " + t.note.slice(0, 160) : "");
}

// Текст для агента: список дел строками.
function tasksFormatText(tasks, nowMs) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return "Дел нет.";
  return list.map((t) => taskLine(t, nowMs)).join("\n");
}

// Короткая сводка для системного промпта роли «Менеджер» (топ ближайших дел).
function tasksBrief(userData, limit, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const res = tasksList(userData, { status: "active", nowMs: now });
  const list = res.tasks.slice(0, Math.max(1, limit || 8));
  if (!list.length) return "Активных дел нет.";
  const s = res.summary.summary;
  const head = "Просрочено: " + s.overdue + " · сегодня: " + s.today + " · завтра: " + s.tomorrow +
    " · на неделе: " + s.week + " · без срока: " + s.noDue + (res.summary.nextAt ? " · ближайшее: " + res.summary.nextAt.replace("T", " ") : "");
  return head + "\n" + tasksFormatText(list, now);
}

module.exports = {
  TASK_MAX,
  TASK_STATUSES,
  TASK_PRIORITIES,
  TASK_REMIND_BEFORE_MS,
  TASK_REPEAT_MAX_MIN,
  TASK_AUTO_TRIES_MAX,
  tasksFile,
  parseDue,
  parseRepeat,
  repeatLabel,
  nextDueDate,
  advanceRepeat,
  tasksAdd,
  tasksList,
  tasksUpdate,
  tasksDone,
  tasksDelete,
  tasksBoard,
  tasksSummary,
  tasksTakeReminders,
  tasksTakeAuto,
  tasksAutoAck,
  tasksAutoRearm,
  tasksNextDue,
  tasksFormatText,
  tasksBrief,
  humanDue,
  taskLine,
};

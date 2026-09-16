"use strict";

/* ─── Сторож миссий: кого продолжать и когда перестать приставать ─────────────
   Почему он появился. Прогон агента заканчивался текстом, не закрывая миссию, и
   приложение подталкивало его дальше: «миссия не закрыта, продолжай делом».
   Дальше получалась петля:

     ответ текстом → призыв «продолжай» → снова ответ текстом (тот же отчёт)
       → ещё призыв → … → приложение ставит миссию на ПАУЗУ
       → следующий прогон снова подхватывает эту паузу (она «незакрытая»)
       → всё повторяется, а человек видит три-четыре одинаковых «Готово».

   Здесь две вещи, которых не хватало: понятие «какую миссию продолжать самому»
   и решение «призывать или остановиться». Обе — чистые функции без диска и без
   глобального состояния, поэтому проверяются поведением, а не чтением кода.

   Правила подхвата (adoptable): только работающая миссия (active) и только из
   своего чата. Пауза — это знак «жду человека»: её продолжает кнопка «▶ Продолжить»,
   а не следующий прогон. Раньше подхватывались и паузы, и чужие миссии — отсюда
   «миссия снова меня дёргает» после того, как работа давно сдана.

   Правила призыва (nudgeStep): один призыв на первый текстовый ответ; если модель
   повторила тот же ответ или после призыва не сдвинулась ни на шаг — призывы
   прекращаются, миссия уходит в паузу (жду человека), а не крутится дальше. */

const NUDGE_MAX = 3;
const REPORT_CLIP = 400;

// Текст ответа для сравнения «то же самое или нет»: пробелы и переводы строк —
// не разница, а вот другое содержание — разница.
function normalizeReport(text) {
  return String(text == null ? "" : text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPORT_CLIP);
}

function sameReport(a, b) {
  const x = normalizeReport(a);
  const y = normalizeReport(b);
  return !!x && !!y && x === y;
}

// Можно ли продолжать эту миссию самому, без просьбы человека.
function adoptable(rec, opts) {
  const o = opts || {};
  if (!rec || !rec.id) return false;
  if (String(rec.status || "") !== "active") return false;
  const chatId = String(o.chatId || "");
  const own = String(rec.chatId || "");
  // Миссия другого чата — это чужая работа: подхватывать её в этом разговоре нельзя.
  if (chatId && own && own !== chatId) return false;
  return true;
}

// Из списка (он уже отсортирован по свежести) — первая подходящая.
function pickAdopted(list, opts) {
  const arr = Array.isArray(list) ? list : [];
  for (const rec of arr) {
    if (adoptable(rec, opts)) return rec;
  }
  return null;
}

/* Решение «призывать дальше или остановиться».
   state: {
     status       — состояние миссии с диска,
     nudges       — сколько раз уже призвали в этом прогоне,
     max          — потолок призывов (по умолчанию 3),
     progress     — готовых шагов сейчас (done + failed),
     lastProgress — сколько было в момент прошлого призыва (null — призывов не было),
     text         — финальный ответ модели сейчас,
     lastText     — её же ответ в момент прошлого призыва,
   }
   Ответ: { action: "nudge" | "pause" | "stop", nudge, reason }.
   nudge — призвать (продолжаем прогон), pause — призывы прекращены и миссия уходит
   в паузу, stop — не делать ничего (миссия и так не в работе). */
function nudgeStep(state) {
  const s = state || {};
  const status = String(s.status || "");
  const nudges = Math.max(0, Math.floor(Number(s.nudges) || 0));
  const max = Math.max(1, Math.floor(Number(s.max) || NUDGE_MAX));
  const progress = Math.max(0, Math.floor(Number(s.progress) || 0));
  const lastProgress = s.lastProgress == null ? null : Math.max(0, Math.floor(Number(s.lastProgress) || 0));

  if (status !== "active") {
    return { action: "stop", reason: "миссия не в работе (" + (status || "состояние пусто") + ")" };
  }
  if (nudges === 0) {
    return { action: "nudge", nudge: 1, reason: "модель ответила текстом, не закрыв миссию" };
  }
  if (sameReport(s.text, s.lastText)) {
    return { action: "pause", reason: "модель повторила тот же ответ — останавливаю повторы" };
  }
  if (lastProgress != null && progress <= lastProgress) {
    return { action: "pause", reason: "после призыва не было движения — жду человека" };
  }
  if (nudges >= max) {
    return { action: "pause", reason: "призывы исчерпаны (" + max + ")" };
  }
  return { action: "nudge", nudge: nudges + 1, reason: "после призыва работа сдвинулась" };
}

/* Текст призыва к модели. В нём есть id миссии (по нему видно, о чём речь),
   прямое указание «не пересказывай отчёт» и честное предупреждение, что дальше
   напоминаний не будет. Без этого модель считала каждый призыв просьбой заново
   рассказать о сделанном — отсюда три одинаковых «Готово». */
function nudgeText(args) {
  const a = args || {};
  const pr = a.progress || {};
  const done = Math.max(0, Math.floor(Number(pr.done) || 0));
  const total = Math.max(0, Math.floor(Number(pr.total) || 0));
  const nudge = Math.max(1, Math.floor(Number(a.nudge) || 1));
  const max = Math.max(1, Math.floor(Number(a.max) || NUDGE_MAX));
  return (
    "Ты ответил текстом, но миссия «" + String(a.title || "") + "» (id: " + String(a.id || "") + ") не закрыта: готово " + done + " из " + total + ".\n" +
    "Не описывай, что осталось, а ВЫПОЛНЯЙ: вызови следующий инструмент.\n" +
    "Если работа уже сделана и отчёт отправлен — НЕ пересказывай отчёт: вызови missionFinish(report, done) одной строкой итога.\n" +
    "Если пункт сделать нельзя — отметь его fail через missionStep(fail, note) и переходи к следующему.\n" +
    "Это призыв " + nudge + " из " + max + ": дальше приложение напоминать не будет — миссия уйдёт в паузу, и продолжит её человек."
  );
}

module.exports = {
  NUDGE_MAX,
  normalizeReport,
  sameReport,
  adoptable,
  pickAdopted,
  nudgeStep,
  nudgeText,
};

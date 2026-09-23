"use strict";

/* ─── Ожидание ответа человека на вопрос агента (инструмент askUser) ──────────
   Новый модуль (часть 42). Отвечает ровно за одно: агент задал вопрос — прогон
   СТОИТ и ждёт, пока человек ответит (или вариант выберет кнопкой).

   Почему отдельным модулем. Здесь два тихих и дорогих места, и оба нашлись
   жалобой «агент открыл окно с вопросом, а сам не остановился и продолжил»:

     • Забытый таймер. Был `setTimeout` на 5 минут, который НЕ снимался при
       ответе. Человек отвечал, прогон шёл дальше и задавал ВТОРОЙ вопрос, а
       старый таймер просыпался и «отвечал» пустой строкой уже на новый вопрос —
       прогон получал «(пользователь не дал ответ)» и продолжал работу, пока на
       экране висело окно с неотвеченным вопросом. Теперь таймер снимается при
       любом ответе, а просроченный таймер отвечает ТОЛЬКО за свой вопрос
       (`live.pendingAsk === finish`) и вслух говорит человеку, что вопрос снят.

     • Ответ после конца прогона. Человек отвечал в окно уже закончившегося
       прогона — ответ уходил в никуда (или подменял вопрос следующего прогона).
       У прогона есть `cancel()`: он зовёт его, когда работа завершилась.

   Предложение роли (заход про suggestRole). Тот же механизм ждёт ответа и на
   предложение сменить роль чата: окно показывает кнопку переключения, а вызов
   roleSuggestWait отдаёт id роли, если человек согласился (пусто — отказался).

   Варианты ответа (features). Модель может передать `options` — тогда человек
   выбирает кнопкой, а своё пишет в поле. Список чистится: пустые выбрасываются,
   дубли убираются, длинные обрезаются, максимум шесть — окно не должно
   превращаться в простыню, а ответ - в нечитаемый кусок текста.

   Модуль чистый: время (`setTimeout`/`clearTimeout`), вывод события и живое
   значение ожидания приходят снаружи — поэтому таймеры проверяются поведением,
   без ожидания настоящих минут. */

const ASK_WAIT_MS = 30 * 60 * 1000; // сколько ждём, если человек отошёл (видно в чате)
const ASK_MAX_OPTIONS = 6; // больше шести кнопок — уже не «быстрый выбор»
const ASK_OPTION_MAX = 120; // длинная «кнопка» не читается
const ASK_QUESTION_MAX = 1200;

// Список вариантов из аргументов модели: строки, без повторов, обрезанные.
function normalizeAskOptions(options) {
  const list = Array.isArray(options) ? options : [];
  const out = [];
  for (const item of list) {
    const s = String(item == null ? "" : item).replace(/\s+/g, " ").trim();
    if (!s) continue;
    const short = s.length > ASK_OPTION_MAX ? s.slice(0, ASK_OPTION_MAX - 1) + "…" : s;
    if (out.indexOf(short) >= 0) continue;
    out.push(short);
    if (out.length >= ASK_MAX_OPTIONS) break;
  }
  return out;
}

function createAskWait(deps) {
  const d = deps || {};
  const emit = typeof d.emit === "function" ? d.emit : () => {};
  const live = d.live || {};
  const timeoutMs = Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : ASK_WAIT_MS;
  // Время подменяемо: в проверках таймер обязан срабатывать мгновенно, а не через полчаса.
  const setT = typeof d.setTimeout === "function" ? d.setTimeout : setTimeout;
  const clearT = typeof d.clearTimeout === "function" ? d.clearTimeout : clearTimeout;

  // Ожидание с ОДНИМ событием в окно. И вопрос (askUser), и предложение сменить
  // роль (suggestRole) устроены одинаково: окну уходит событие, прогон ждёт
  // ответа, ожидание живёт в live.pendingAsk и снимается любым из трёх способов —
  // ответом, просрочкой или концом прогона. Разными остаются только текст события
  // и слово в сообщении о просрочке, поэтому вся опасная механика — здесь одна.
  const waitWith = (emitEvent, what) => {
    emitEvent();
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      // Одна точка ответа: и человек (через живое значение), и таймер, и отмена
      // прогона приходят сюда. Второй ответ невозможен — `done`.
      const finish = (answer) => {
        if (done) return false;
        done = true;
        clearT(timer); // забытый таймер отвечал бы на СЛЕДУЮЩИЙ вопрос — снимаем
        if (live.pendingAsk === finish) live.pendingAsk = null;
        resolve(String(answer == null ? "" : answer));
        return true;
      };
      timer = setT(() => {
        // Просроченный таймер отвечает только за своё ожидание. Если ждёт уже
        // другое (человек ответил, прогон пошёл дальше и спросил снова) — молчим и
        // ничего не подменяем: иначе окно висит, а агент работает без ответа.
        if (live.pendingAsk !== finish) return;
        const mins = Math.max(1, Math.round(timeoutMs / 60000));
        finish("");
        emit({
          type: "notice",
          text: "⏳ " + what + " ждал ответа " + mins + " мин и снят — агент продолжает без него. Если ответ ещё нужен, напиши его в чат.",
        });
      }, timeoutMs);
      live.pendingAsk = finish;
    });
  };

  const askUserWait = (question, options) => {
    const text = String(question == null ? "" : question).trim().slice(0, ASK_QUESTION_MAX) || "Уточни, пожалуйста";
    const opts = normalizeAskOptions(options);
    return waitWith(() => emit({ type: "ask", question: text, options: opts }), "Вопрос");
  };

  // Предложение сменить роль: ответ — id роли, если человек согласился, иначе
  // пустая строка. Роль меняет ОКНО (человек жмёт кнопку), прогон только ждёт.
  const roleSuggestWait = (roleId, reason) => {
    const role = String(roleId == null ? "" : roleId).trim().slice(0, 40);
    const why = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim().slice(0, ASK_QUESTION_MAX);
    return waitWith(() => emit({ type: "role_suggest", role: role, reason: why }), "Предложение роли");
  };

  // Прогон закончился (финал, «Стоп», ошибка) — ждать больше нечего и некому.
  const cancel = () => {
    const r = live.pendingAsk;
    if (typeof r !== "function") return false;
    live.pendingAsk = null;
    r("");
    return true;
  };

  return { askUserWait, roleSuggestWait, cancel, options: normalizeAskOptions };
}

module.exports = { createAskWait, normalizeAskOptions, ASK_WAIT_MS, ASK_MAX_OPTIONS, ASK_OPTION_MAX };

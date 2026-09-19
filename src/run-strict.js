"use strict";

/* ─── Строгая очередь вызовов: подтверждения, чекпоинты, аудит ────────────────
   Вынесено из main.js (этап B, часть 19а — шестой заход в ядро чата runAi).

   Сюда раунд приходит, когда вызовы НЕЛЬЗЯ гнать пачкой: есть запись файла,
   вопрос человеку или что-то потенциально опасное. Здесь каждый вызов идёт
   по очереди и решается, спрашивать ли человека.

   Ошибки на этом шаге тихие и дорогие:

     • **выполнили без спроса** — `runCommand` вроде `rm -rf` уходит в работу
       без подтверждения человека; политика опасного — в `src/tool-policy.js`,
       и спрашивать надо ровно её;
     • **спросили не то** — инструмент с высоким риском и без своей защиты
       выполняется молча либо, наоборот, спрашивает дважды за одно действие;
     • **отказ человека не записан** — в журнале действий не видно, что действие
       отклонено, и потом невозможно объяснить, почему файла нет;
     • **чекпоинт не снят** — правка файла ушла на диск без снимка, и откат
       изменений агента перестал работать (откатывать нечего);
     • **в режиме плана выполнили инструмент** — план «составился», сделав дело;
     • **журнал попал в контекст модели** — секреты из вывода инструмента ушли
       бы провайдеру.

   Живые значения — аргументами и объектами: история приходит массивом (модуль в
   неё пишет), подтверждение и выполнение инструмента — функциями, журнал и миссия
   — объектами, а источник действия (`desktop`/`mobile`) меняется на каждый прогон,
   поэтому приходит функцией `getRunOrigin`. Остановка по «Стоп» остаётся у прогона. */

function createRunStrict(deps) {
  const {
    settings,
    emit,
    // Вопрос человеку и ожидание ответа (askUser) — ведёт прогон.
    askUserWait,
    // Что считать опасным — решает только политика (src/tool-policy.js).
    toolPolicy,
    describeToolArgs,
    executeTool,
    truncateText,
    // Журнал действий: подтверждения, отказы, риск и незнакомые инструменты.
    audit,
    // Миссия: журнал значимых действий и счётчик повторов одного вызова.
    mission,
    // Чекпоинт до правки файла — в undo-store.
    snapshotFileForUndo,
    resolvePath,
    // Источник действия меняется на каждый прогон, поэтому не значением, а функцией.
    getRunOrigin,
  } = deps;

  const runStrict = async (calls, opts) => {
    const planMode = opts.planMode;
    const history = opts.history;

    for (const c of calls) {
      // План-режим: выполняем только todoWrite. Если модель по привычке вызвала
      // другой инструмент — не выполняем его и говорим об этом прямо.
      if (planMode && c.name !== "todoWrite") {
        const blocked =
          "Режим плана: инструменты не выполняются. Составь план через todoWrite и дождись команды пользователя.";
        history.push({ role: "tool", tool_call_id: c.id, content: blocked });
        continue;
      }
      emit({ type: "tool_start", name: c.name, args: c.args });
      let result;
      // Как обошлось действие: auto — без вопросов, approved/denied — решал пользователь.
      // Нужно журналу действий: подтверждения и отказы пишутся всегда.
      let decision = "auto";
      const confirmYes = (answer) =>
        /^(да|yes|y|ok|го|ага|точно|конечно|давай|выполн)/i.test(String(answer || "").trim());
      if (c.name === "askUser") {
        const question = (c.args && c.args.question) || "Уточни, пожалуйста";
        const answer = await askUserWait(question);
        result = answer && String(answer).trim() ? String(answer).trim() : "(пользователь не дал ответ)";
      } else if (c.name === "runCommand" && toolPolicy.isDangerousCommand((c.args && c.args.command) || "")) {
        // Потенциально опасные команды выполняем только после явного подтверждения
        // (что считать опасным — решает политика: src/tool-policy.js).
        const cmd = String((c.args && c.args.command) || "");
        const answer = await askUserWait(
          "⚠️ Команда потенциально опасна: «" + cmd.slice(0, 160) + "»\nВыполнить? (да / нет)"
        );
        if (confirmYes(answer)) {
          decision = "approved";
          result = await executeTool(c.name, c.args, settings);
        } else {
          decision = "denied";
          result =
            "Команда НЕ выполнена: пользователь не подтвердил опасную операцию. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
        }
      } else if (toolPolicy.needsConfirm(c.name)) {
        // Инструмент с высоким риском и без своей защиты — спрашиваем пользователя.
        const desc = describeToolArgs(c.name, c.args);
        const answer = await askUserWait("⚠️ Действие потенциально опасно: " + desc + "\nВыполнить? (да / нет)");
        if (confirmYes(answer)) {
          decision = "approved";
          result = await executeTool(c.name, c.args, settings);
        } else {
          decision = "denied";
          result = "Действие НЕ выполнено: пользователь не подтвердил. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
        }
      } else {
        // Чекпоинт: до правки файла запоминаем его состояние (для отката изменений агента)
        if (c.name === "writeFile" || c.name === "editFile") {
          try { snapshotFileForUndo(resolvePath(c.args && c.args.path, settings)); } catch {}
        }
        result = await executeTool(c.name, c.args, settings);
      }
      // Журнал действий: подтверждения, отказы, риск medium/high и незнакомые
      // инструменты. Секреты в журнал не попадают (редакция в tool-policy.js).
      audit.record({ tool: c.name, args: c.args, decision, result, source: getRunOrigin() });
      // Миссия: журнал по значимым действиям (в журнале видно, чем агент занят) и
      // счётчик повторов одного и того же вызова — по нему ловится цикл.
      mission.noteCall(c.name, c.args);
      // Держим контекст в рамках бюджета: длинный вывод инструмента ужимаем
      const capped = truncateText(result, 8000);
      emit({ type: "tool_result", name: c.name, result: capped });
      history.push({ role: "tool", tool_call_id: c.id, content: capped });
    }
  };

  return { runStrict: runStrict };
}

module.exports = { createRunStrict };

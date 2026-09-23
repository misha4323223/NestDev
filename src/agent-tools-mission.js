"use strict";

/* ─── Инструменты миссий и плана ──────────────────────────────────────────────
   Вынесено из agent-tools.js (часть 40, заход 6c). Здесь живут четыре
   обработчика длинной работы и один — плана:

     • missionStart — цель, план и лимиты ложатся файлами в рабочую папку
       (по умолчанию .agent/missions/<id>/ рядом с проектом, а при выбранной
       человеком папке — в её подпапке проекта; путь считает src/agent-data.js);
       прогон после этого идёт батчами и переживает
       перезапуск: состояние читается с диска, а не из памяти окна;
     • missionStep / missionStatus / missionFinish — журнал шагов, прогресс,
       отчёт; повторный missionFinish честно говорит, что миссия уже закрыта;
     • todoWrite — план работ: приложение показывает его панелью-чеклистом,
       помнит сводку (total/done/failed) для предохранителя «план не закрыт» и —
       если прогон ведёт миссию — переносит тот же план в её шаги (иначе карточка
       миссии навсегда оставалась «без плана», хотя план есть).

   Живой мост нужен: роль и чат текущего прогона (миссия запоминает, кто её
   ведёт), лента событий (панель обновляется сразу) и сводка плана. Вместе с
   обработчиками сюда уехали два помощника замыкания — notifyMission и
   missionOfRun: их зовут только миссии, и в оболочке они стали бы мёртвыми.
   missionOfRun выбирает миссию ПРОГОНА по live.activeRunMissionId — иначе
   агент без id закрывал бы чужую работу, а его настоящая снова его «дёргала».
   Тела перенесены ПОБАЙТОВО, порядок инструментов в реестре сохранён ссылками. */

function createMissionTools(deps, live) {
  const {
    agentWorkDir,
    missionStore,
    normalizePlanTasks,
    planSummary,
  } = deps;

  // Панель «Миссия» обновляется сразу: шаг агента видно без ожидания опроса.
  const notifyMission = () => {
    try {
      const em = deps.live && deps.live.activeEmit ? deps.live.activeEmit() : null;
      if (em) em({ type: "mission", phase: "changed" });
    } catch {}
  };
  // «Своя» миссия прогона: если прогон ведёт миссию, инструмент без id работает
  // с ней, а не с самой свежей незакрытой (их могло остаться несколько — тогда
  // агент закрывал чужую работу, а его настоящая миссия снова его «дёргала»).
  const missionOfRun = (dir) => {
    const id = String((live && live.activeRunMissionId) || "");
    if (id) {
      const rec = missionStore.missionLoad(dir, id);
      if (rec && rec.status !== "done" && rec.status !== "failed" && rec.status !== "stopped") return rec;
    }
    return missionStore.missionActive(dir);
  };

  return {
    "missionStart": async (args, settings) => {
        // Долгая работа: цель, план и журнал ложатся файлами в рабочую папку
        // (.agent/missions/<id>/). Прогон после этого идёт батчами и переживает
        // перезапуск — состояние миссии читается с диска, а не из памяти окна.
        const msDir = agentWorkDir(settings);
        const msMinutes = Number(args.minutes) || 0;
        const msRole = live.activeRunRole || "";
        const msChat = live.activeRunChatId || "";
        const msR = missionStore.missionCreate(msDir, {
          goal: args.goal, title: args.title, steps: args.steps,
          role: msRole, chatId: msChat,
          limits: msMinutes ? { minutes: msMinutes } : null,
        });
        if (!msR.ok) return "Ошибка: " + msR.error;
        notifyMission();
        const msP = missionStore.missionProgress(msR.mission);
        const msPlanText = msR.mission.steps.length
          ? msR.mission.steps.map((s, i) => (i + 1) + ") " + s.title).join("; ")
          : "не задан";
        return "OK — миссия создана: " + msR.mission.id +
          "\nПапка: " + msR.dir +
          "\nЦель: " + msR.mission.goal +
          "\nПлан (" + msP.total + "): " + msPlanText +
          "\nЛимит: " + msR.mission.limits.rounds + " раундов, " + Math.round(msR.mission.limits.minutes / 60) + " ч" +
          "\nПЕРВЫМ ДЕЛОМ вызови todoWrite с планом миссии (3–7 пунктов): план видно человеку в панели, этот же план становится шагами миссии и не теряется при перезапуске." +
          "\nДальше работай по шагам и после КАЖДОГО шага вызывай missionStep(done, next, note) — журнал читает человек." +
          " Когда закончишь — missionFinish(report).";
    },
    "missionStep": async (args, settings) => {
        const msDir2 = agentWorkDir(settings);
        const msCur = missionOfRun(msDir2);
        if (!msCur) return "Ошибка: незакрытой миссии нет. Для длинной работы сначала missionStart(goal, steps).";
        const msR2 = missionStore.missionStep(msDir2, msCur.id, {
          done: args.done, fail: args.fail, next: args.next, note: args.note,
        });
        if (!msR2.ok) return "Ошибка: " + msR2.error;
        notifyMission();
        const msP2 = msR2.progress;
        return "OK — миссия " + msCur.id + ": " + msP2.done + "/" + msP2.total + " готово" +
          (msP2.failed ? ", сбоев " + msP2.failed : "") +
          (msP2.current ? ". Сейчас: " + msP2.current : "") +
          "\nЖурнал: " + missionStore.missionsPathText(msDir2, msCur.id) + "journal.md";
    },
    "missionStatus": async (args, settings) => {
        const msDir3 = agentWorkDir(settings);
        const msWanted = String(args.id || "").trim();
        const msRec = msWanted ? missionStore.missionLoad(msDir3, msWanted) : missionOfRun(msDir3);
        if (!msRec) return msWanted ? "Ошибка: миссия " + msWanted + " не найдена." : "Незакрытых миссий нет.";
        const msP3 = missionStore.missionProgress(msRec);
        const msElapsed = Math.round((Date.now() - (msRec.startedAt || msRec.createdAt || Date.now())) / 60000);
        const msHead = "Миссия «" + msRec.title + "» (" + msRec.id + ", состояние: " + msRec.status + ")\n" +
          "Цель: " + msRec.goal + "\n" +
          "Прогресс: " + msP3.done + "/" + msP3.total + (msP3.failed ? " (сбоев " + msP3.failed + ")" : "") +
          (msP3.current ? ", сейчас: " + msP3.current : "") + "\n" +
          "В работе " + msElapsed + " мин, раундов " + msRec.rounds + ", батчей " + msRec.batches +
          ", токенов " + msRec.metrics.tokens + (msRec.next ? "\nДальше: " + msRec.next : "");
        const msPlan = msRec.steps.length
          ? "\nПлан:\n" + msRec.steps.map((s, i) => (s.state === "done" ? "  [x] " : s.state === "failed" ? "  [!] " : s.state === "doing" ? "  [→] " : "  [ ] ") + (i + 1) + ". " + s.title + (s.note ? " — " + s.note : "")).join("\n")
          : "";
        const msJ = missionStore.missionJournalText(msDir3, msRec.id, { limit: Number(args.journal) || 20 });
        return msHead + msPlan + "\nЖурнал (хвост):\n" + msJ + "\nФайлы: " + missionStore.missionsPathText(msDir3, msRec.id);
    },
    "missionFinish": async (args, settings) => {
        const msDir4 = agentWorkDir(settings);
        const msRec4 = missionOfRun(msDir4);
        if (!msRec4) {
          // Это не ошибка: чаще всего миссию закрыли в прошлом раунде. Ответ
          // должен сказать, что закрыто, когда и с каким итогом, — иначе агент
          // считает, что «закрывать нечего», и повторяет вызов.
          const msDone = missionStore.missionList(msDir4, { limit: 1 })[0];
          if (!msDone) {
            return "Незакрытой миссии нет и закрытых тоже: эта работа не начиналась. Для длинной работы сначала missionStart(goal, steps).";
          }
          const msDP = missionStore.missionProgress(msDone);
          return (
            "Миссия «" + msDone.title + "» (" + msDone.id + ") уже закрыта" +
            (msDone.finishedAt ? " " + new Date(msDone.finishedAt).toLocaleString() : "") +
            " — состояние: " + msDone.status + ", шагов: " + msDP.done + "/" + msDP.total + "." +
            "\nОтчёт: " + missionStore.missionsPathText(msDir4, msDone.id) + "report.md" +
            (msDone.reason ? "\nИтог: " + String(msDone.reason).slice(0, 300) : "") +
            "\nЕсли нужна новая работа — missionStart(goal, steps)."
          );
        }
        const msR4 = missionStore.missionFinish(msDir4, msRec4.id, {
          report: args.report, status: args.status, next: args.next,
        });
        if (!msR4.ok) return "Ошибка: " + msR4.error;
        notifyMission();
        const msP4 = missionStore.missionProgress(msR4.mission);
        return "OK — миссия " + msRec4.id + " закрыта (" + msR4.mission.status + "): " + msP4.done + "/" + msP4.total +
          " шагов. Итог записан в " + missionStore.missionsPathText(msDir4, msRec4.id) + "report.md";
    },
    "todoWrite": async (args, settings) => {
        // План работ: приложение только нормализует и показывает его панелью-
        // чеклистом — состояние (статусы, переживание перезапуска) хранит интерфейс.
        const planTasks = normalizePlanTasks(args.tasks != null ? args.tasks : args.items != null ? args.items : args);
        if (!planTasks.length) {
          return "Ошибка: план пуст. Пришли непустой tasks — массив до 7 пунктов (строка или { text, status }).";
        }
        const planTitle = String(args.title || "").trim().slice(0, 80);
        if (live.activeEmit) live.activeEmit({ type: "plan", tasks: planTasks, title: planTitle });
        const ps = planSummary(planTasks);
        live.activePlanSummary = { total: ps.total, done: ps.done, failed: ps.failed };
        // План у агента ОДИН: если прогон ведёт миссию, тот же план становится её
        // шагами, а переходы (сделано / не вышло) — строками её журнала. Так карточка
        // миссии перестаёт говорить «план не составлен», когда план есть.
        const planDir = agentWorkDir(settings);
        const planMission = missionOfRun(planDir);
        let planMirror = "";
        if (planMission) {
          const planRes = missionStore.missionSetPlan(planDir, planMission.id, planTasks);
          if (planRes && planRes.ok) {
            notifyMission();
            planMirror =
              "\nПлан миссии «" + planMission.id + "» обновлён: " + planRes.progress.done + "/" + planRes.progress.total +
              (planRes.progress.failed ? ", сбоев " + planRes.progress.failed : "") + ".";
          }
        }
        const planRows = planTasks.map((t) =>
          (t.status === "done" ? "✅ " : t.status === "failed" ? "⚠️ " : t.status === "in_progress" ? "🔄 " : "⬜ ") +
          t.text + (t.note ? " — " + t.note : "")
        );
        return (
          "OK — план показан пользователю: " + ps.done + " из " + ps.total + " готово" +
          (ps.failed ? ", сбоев: " + ps.failed : "") + ".\n" +
          planRows.join("\n") + planMirror + "\n" +
          (ps.done === ps.total
            ? "Все пункты готовы — подведи короткий итог без пересказа плана."
            : "Продолжай со следующего пункта; после каждого шага вызывай todoWrite заново с ПОЛНЫМ списком.")
        );
    },
  };
}

module.exports = { createMissionTools };

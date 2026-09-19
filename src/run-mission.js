"use strict";

/* ─── Миссия прогона агента: долгая работа, которая переживает перезапуск ─────
   Вынесено из main.js (этап B, часть 14 — первый заход в ядро чата runAi).

   Агент «на 8 часов» не имеет права терять задачу. Здесь живёт всё, что делает
   такую работу выживающей:

     • миссия заводится сама, когда модель долго работает инструментами (файлы,
       цель, план — в .agent/missions/<id>/ рядом с проектом);
     • прогон идёт БАТЧАМИ: 25 раундов, затем проверка «миссия жива? лимиты?
       был ли прогресс?» и новый батч с тем же контекстом. Раньше работа умирала
       на 26-м раунде и начиналась заново руками;
     • журнал пишется по значимым действиям, даже если модель не зовёт
       missionStep: это и есть отчёт о работе;
     • ловится цикл (один и тот же вызов по кругу) и стояние на месте;
     • «призывы» к продолжению решает сторож (src/mission-guard.js), а не сам
       прогон: три одинаковых отчёта подряд человек уже видел.

   Ошибки здесь тихие и дорогие. Не завели миссию — работа умрёт вместе с
   приложением. Не записали журнал — вместо отчёта пустота. Не поймали цикл —
   токены горят впустую. Неверная граница батча — работа кончается грозным
   «превышено число раундов» вместо аккуратной паузы.

   Состояние прогона — один объект `state` (счётчики, миссия с диска, журнал,
   подписи вызовов): и модуль, и оболочка читают и пишут одно и то же место,
   копий нет. Меняет его оболочка всего в одном месте — `state.rounds++` на
   каждом раунде.

   Живые значения приходят мостами, а не копиями:

     • emit — событие в окно; окна может не быть вовсе (прогон с телефона);
     • live.missionClaim — id миссии, которую человек вернул кнопкой
       «▶ Продолжить»; читается И ОЧИЩАЕТСЯ: одна просьба — один прогон;
     • live.missionId — id миссии прогона для инструментов агента (runMissionId).

   Всё, что касается показа (текст в чат, откат, «готово») и времени (пауза между
   батчами), остаётся у оболочки: модуль отдаёт тексты и решение, а не рисует.
   Порядок событий в окне поэтому сохраняется ровно прежним. */

const MISSION_AUTO_ROUND = 6; // после скольких раундов работа считается длинной
const MISSION_AUTO_JOURNAL = new Map([
  ["writeFile", "создан файл"],
  ["editFile", "правка файла"],
  ["applyPatch", "применён патч"],
  ["taskAdd", "заведено дело"],
  ["taskDone", "дело закрыто"],
  ["mailSend", "отправлено письмо"],
  ["generateImage", "сгенерировано изображение"],
]);
const MISSION_JOURNAL_PER_BATCH = 30; // журнал не должен превращаться в поток

function createRunMission(deps) {
  const { settings, planMode, messages, roleId, dir, chatId, emit, missionStore, missionGuard, live } = deps;
  // Часы — шов для проверки: ветка «время миссии вышло» иначе проверяется
  // только ожиданием пяти минут. Оболочка значение не передаёт.
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();

  const state = {
    longWork: !!settings.longWork && !planMode,
    limits: {
      minutes: Math.max(5, Math.min(24 * 60, Math.round((Number(settings.longWorkHours) || 8) * 60))),
      rounds: Math.max(25, Math.min(2000, Number(settings.longWorkRounds) || 600)),
      autoContinues: Math.max(0, Math.min(20, settings.longWorkAutoContinue == null ? 6 : Number(settings.longWorkAutoContinue))),
    },
    rec: null, // запись миссии с диска
    autoCreated: false, // миссию завело приложение, а не агент
    rounds: 0, // раундов за всю миссию (счётчик, переживает батчи)
    batches: 0,
    tokens: 0,
    compactions: 0,
    nudges: 0, // «миссия не закрыта, а модель замолчала»
    errorContinues: 0, // авто-продолжений после сбоя (лимит из настроек)
    stopReason: "", // почему прогон остановился: идёт в панель «Миссия»
    startedAt: now(), // когда миссия началась (для лимита времени)
    nudgeProgress: null, // сколько шагов было готово в момент прошлого призыва
    nudgeText: "", // ответ модели в момент прошлого призыва (ловит повторы)
    journalLeft: MISSION_JOURNAL_PER_BATCH, // сколько записей журнала осталось на батч
    lastProgressRound: 0, // на каком раунде работа последний раз двигалась
    lastProgressSteps: 0, // сколько шагов миссии было готово тогда
    signatures: new Map(), // подпись вызова → сколько раз за прогон
  };
  const goalSeed = (() => {
    // Цель авто-миссии — последняя просьба пользователя: она уже есть в истории.
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
        return m.content.trim().slice(0, 4000);
      }
    }
    return "";
  })();

  // Миссия прогона живёт и на диске, и здесь: агентские инструменты без id должны
  // отмечать шаги и закрывать ИМЕННО её, а не самую свежую незакрытую миссию.
  const setRec = (r) => {
    state.rec = r || null;
    live.missionId = (state.rec && state.rec.id) || "";
    return state.rec;
  };
  // Какую миссию продолжает этот прогон. Подхватываем только ЖИВУЮ миссию этого чата:
  // пауза означает «жду человека» (её продолжает кнопка «▶ Продолжить»), а миссия
  // другого чата к этой работе не относится. Раньше сюда попадали и паузы, и чужие
  // миссии — прогон «продолжал» давно сданную работу, подталкивал модель и получал
  // один и тот же отчёт по кругу (три «Готово» подряд — отсюда).
  const read = () => {
    if (!state.longWork) return null;
    try {
      // Просьба человека (кнопка «Продолжить») сильнее любых правил: он вернул
      // миссию в работу своими руками.
      if (live.missionClaim) {
        const claimed = missionStore.missionLoad(dir, live.missionClaim);
        live.missionClaim = "";
        if (claimed && claimed.status === "active") return claimed;
      }
      return missionGuard.pickAdopted(missionStore.missionList(dir, { limit: 20 }), { chatId: chatId });
    } catch {
      return null;
    }
  };
  const refresh = () => {
    if (state.longWork) setRec(read());
    return state.rec;
  };
  // Состояние в интерфейс и на телефон: панель «Миссия» рисует по этому событию.
  const emitState = (phase) => {
    if (!state.rec) return;
    try {
      const pr = missionStore.missionProgress(state.rec);
      emit({
        type: "mission",
        phase: phase || "tick",
        id: state.rec.id,
        title: state.rec.title,
        goal: state.rec.goal,
        status: state.rec.status,
        steps: state.rec.steps.map((s) => ({ title: s.title, state: s.state, note: s.note })),
        progress: pr,
        rounds: state.rounds,
        batches: state.batches,
        tokens: state.tokens,
        compactions: state.compactions,
        startedAt: state.startedAt,
        limits: { minutes: state.limits.minutes, rounds: state.limits.rounds },
        reason: state.stopReason || state.rec.reason || "",
      });
    } catch {}
  };
  // Миссия «сама собой»: длинную работу видно по делу (шестой раунд с инструментами),
  // а не по обещаниям модели. Файлы появляются ровно тогда, когда они нужны.
  const ensure = (why) => {
    if (!state.longWork || state.rec || !goalSeed) return state.rec;
    try {
      const r = missionStore.missionCreate(dir, {
        goal: goalSeed,
        title: goalSeed.split("\n")[0].slice(0, 120),
        role: roleId,
        chatId: chatId,
        limits: { minutes: state.limits.minutes, rounds: state.limits.rounds },
      });
      if (!r.ok) return null;
      setRec(r.mission);
      state.autoCreated = true;
      missionStore.missionNote(dir, state.rec.id, "note", "📄 Миссию завело приложение (" + why + "): цель взята из последней просьбы.");
      emit({
        type: "notice",
        text:
          "📄 Длинная работа: завёл миссию «" + state.rec.title + "». Цель, план и журнал — в папке .agent/missions/" +
          state.rec.id + "/ (рядом с проектом). Работа продолжится сама, если прогон оборвётся.",
      });
    } catch {}
    return state.rec;
  };
  // Журнал по значимым действиям: даже если модель не зовёт missionStep, в журнале
  // видно, чем она занята (файлы, дела, письма) — это и есть «отчёт о работе».
  const noteCall = (name, args) => {
    if (!state.longWork || !state.rec) return;
    if (state.journalLeft <= 0) return;
    const label = MISSION_AUTO_JOURNAL.get(name);
    if (!label) return;
    const a = args || {};
    const what = String(a.path || a.title || a.key || a.prompt || "").slice(0, 100);
    state.journalLeft--;
    try {
      missionStore.missionNote(dir, state.rec.id, "tool", "⚙ " + label + (what ? ": " + what : ""));
    } catch {}
    // Счётчик повторов одного и того же вызова — по нему ловится цикл.
    const sig = name + "|" + JSON.stringify(a);
    state.signatures.set(sig, (state.signatures.get(sig) || 0) + 1);
  };
  // Прогресс — это новый шаг миссии ИЛИ новая работа инструментом. Повтор одного и
  // того же вызова прогрессом не считается: так ловится цикл, в котором агент «крутится».
  const trackProgress = (calls) => {
    if (!state.longWork) return;
    const r = read();
    let moved = false;
    if (r) {
      const pr = missionStore.missionProgress(r);
      if (pr.done + pr.failed > state.lastProgressSteps) {
        state.lastProgressSteps = pr.done + pr.failed;
        moved = true;
      }
    }
    for (const c of calls || []) {
      const sig = c.name + "|" + JSON.stringify(c.args || {});
      const n = state.signatures.get(sig) || 0;
      if (n <= 2) moved = true;
    }
    if (moved) {
      state.lastProgressRound = state.rounds;
      state.nudges = 0;
    }
  };
  const stuckRounds = () => Math.max(0, state.rounds - state.lastProgressRound);
  const flood = () => {
    for (const [sig, n] of state.signatures) {
      if (n >= 6) return { sig, n };
    }
    return null;
  };
  // Первый раунд прогона: незакрытую миссию (в том числе с прошлого запуска
  // приложения) продолжаем, а не начинаем работу заново — файлы и журнал на диске.
  // Текст отдаётся наружу: событие в чат идёт ДО события миссии, как и раньше.
  const resume = () => {
    if (!state.longWork || state.rounds !== 1) return null;
    const had = refresh();
    if (!had) return null;
    try {
      missionStore.missionNote(dir, had.id, "note", "▶ Продолжаю миссию: " + had.title);
    } catch {}
    return {
      phase: "resume",
      id: had.id,
      title: had.title,
      notice: "▶ Миссия «" + had.title + "»: продолжаю с места остановки (готово шагов: " + missionStore.missionProgress(had).done + ").",
    };
  };
  // Длинная работа видна по делу: модель много раундов работает инструментами —
  // заводим миссию, чтобы файлы, журнал и защита от обрыва появились вовремя.
  const autoStart = () => {
    if (state.longWork && !state.rec && state.rounds >= MISSION_AUTO_ROUND) ensure("работа идёт много раундов");
  };
  // Пауза по кнопке из панели «Миссия»: работа не теряется, миссия остаётся
  // незакрытой и продолжается из панели — ровно как человек, который встал и
  // вернулся к делу. Показ, откат и «готово» — дело оболочки.
  const pause = () => {
    try {
      if (state.rec) {
        missionStore.missionFinish(dir, state.rec.id, { status: "paused", reason: "пауза по кнопке", next: state.rec.next });
        missionStore.missionNote(dir, state.rec.id, "note", "⏸ Пауза по кнопке — работа сохранена.");
      }
    } catch {}
    state.stopReason = "пауза";
    return { text: "⏸ Пауза. Работа сохранена: цель, план и журнал — в .agent/missions/. Продолжить — панель «Миссия» → «▶ Продолжить»." };
  };
  // Граница батча: продолжать долгую работу или остановиться. Жёсткий потолок
  // раундов больше не убивает работу: миссия живёт на диске, поэтому каждый батч —
  // отдельный отрезок, а между ними видно прогресс, время и повторы.
  const afterBatch = async () => {
    if (!state.longWork) return { continue: false };
    const r = refresh();
    if (!r) return { continue: false };
    // Прогон ведёт только живую миссию (паузы сторож не подхватывает): «не active»
    // здесь означает, что миссия закрыта или её продолжает человек.
    if (r.status !== "active") return { continue: false, closed: true };
    const title = "«" + r.title + "»";
    const elapsedMin = (now() - state.startedAt) / 60000;
    const hardStop = (reason, message) => {
      state.stopReason = reason;
      try {
        missionStore.missionFinish(dir, r.id, { status: "paused", reason: reason, next: r.next });
        missionStore.missionNote(dir, r.id, "note", message);
      } catch {}
      return { finish: true, phase: "paused", message: message };
    };
    const where = " Файлы: .agent/missions/" + r.id + "/ — цель, план и журнал на месте.";
    if (state.rounds >= state.limits.rounds) {
      return hardStop("лимит раундов", "⏹ Миссия " + title + " отработала лимит раундов (" + state.limits.rounds + ")." + where + " Продолжить — панель «Миссия» → «▶ Продолжить».");
    }
    if (elapsedMin >= state.limits.minutes) {
      return hardStop(
        "время миссии вышло",
        "⏹ Миссия " + title + " работала " + Math.round(elapsedMin) + " мин — отведённое время вышло (в настройках это «часов на миссию»)." +
          where + " Продолжить — кнопка «▶ Продолжить» в панели «Миссия»."
      );
    }
    const floodSig = flood();
    if (floodSig) {
      return hardStop(
        "повтор одного вызова",
        "⏹ Остановился: вызов «" + String(floodSig.sig).split("|")[0] + "» повторился " + floodSig.n + " раз — похоже на цикл." + where + " Продолжить можно вручную."
      );
    }
    const stuck = stuckRounds();
    if (stuck >= 12) {
      return hardStop(
        "нет прогресса",
        "⏹ Остановился: " + stuck + " раундов без нового шага — чтобы не жечь токены впустую." + where + " Продолжить — кнопкой «▶ Продолжить»."
      );
    }
    // Продолжаем: новый батч с тем же контекстом и коротким напоминанием о миссии.
    state.batches++;
    state.nudges = 0;
    state.journalLeft = MISSION_JOURNAL_PER_BATCH;
    const pr = missionStore.missionProgress(r);
    try {
      missionStore.missionCounters(dir, r.id, { batches: 1 });
      missionStore.missionNote(dir, r.id, "batch", "▶ Батч " + (state.batches + 1) + ": раундов " + state.rounds + ", шагов " + pr.done + "/" + pr.total);
    } catch {}
    return {
      continue: true,
      phase: "batch",
      notice:
        "▶ Батч " + (state.batches + 1) + ": продолжаю миссию " + title + " — раундов " + state.rounds +
        ", шагов " + pr.done + "/" + pr.total + ", в работе " + Math.round(elapsedMin) + " мин.",
      historyMessage:
        "Работа продолжается (миссия " + title + ", файлы .agent/missions/" + r.id + "/). Пройдено шагов: " +
        pr.done + " из " + pr.total + (pr.current ? ", сейчас: " + pr.current : "") +
        ". Не пересказывай сделанное — вызови следующий инструмент и двигай работу дальше. " +
        "После каждого шага отмечай его через missionStep(done, next). Когда работа будет закончена — missionFinish(report).",
    };
  };
  // Миссия не закрыта, а модель ответила текстом: призывать ли дальше — решает
  // сторож (src/mission-guard.js): один призыв на первый текстовый ответ, дальше —
  // только если работа сдвинулась. Повтор того же ответа или стояние на месте
  // прекращает призывы и уводит миссию в паузу: раньше приложение подталкивало
  // модель трижды подряд, и человек получал три одинаковых отчёта по кругу.
  const canNudge = () => state.longWork && !!state.rec;
  const nudge = (text) => {
    const prN = missionStore.missionProgress(state.rec);
    const step = missionGuard.nudgeStep({
      status: state.rec.status,
      nudges: state.nudges,
      max: missionGuard.NUDGE_MAX,
      progress: prN.done + prN.failed,
      lastProgress: state.nudgeProgress,
      text: text,
      lastText: state.nudgeText,
    });
    if (step.action === "nudge") {
      state.nudges++;
      state.nudgeProgress = prN.done + prN.failed;
      state.nudgeText = text;
      return {
        action: "nudge",
        notice: "📋 Миссия «" + state.rec.title + "» (" + state.rec.id + ") не закрыта (" + prN.done + "/" + prN.total + ") — прошу продолжить делом (попытка " + state.nudges + "/" + missionGuard.NUDGE_MAX + ").",
        historyMessage: missionGuard.nudgeText({
          title: state.rec.title,
          id: state.rec.id,
          progress: prN,
          nudge: state.nudges,
          max: missionGuard.NUDGE_MAX,
        }),
      };
    }
    if (step.action === "pause") {
      // Призывы прекращены: миссия встаёт на паузу и ждёт человека. Пауза сама
      // не подхватывается следующим прогоном — на этом петля и кончается.
      try {
        const r = missionStore.missionFinish(dir, state.rec.id, {
          status: "paused",
          reason: step.reason,
          next: state.rec.next,
        });
        if (r && r.ok) setRec(r.mission);
        missionStore.missionNote(dir, state.rec.id, "note", "⏸ Призывы к продолжению остановлены: " + step.reason + ".");
      } catch {}
      return {
        action: "pause",
        phase: "paused",
        notice: "⏸ Миссия «" + state.rec.title + "» (" + state.rec.id + ") на паузе: " + step.reason + ". Продолжить — панель «Миссия» → «▶ Продолжить».",
      };
    }
    return { action: "none" };
  };
  // Миссия и сбой: обычные ошибки (сеть, 5xx, обрыв) не повод бросать долгую
  // работу. Ждём и продолжаем, пока миссия жива и не исчерпан запас авто-продолжений.
  const alive = () => state.longWork && !!refresh() && !!state.rec && state.rec.status === "active";
  const canAutoContinue = () => state.errorContinues < state.limits.autoContinues;
  const recordError = (e) => {
    state.errorContinues++;
    try {
      missionStore.missionNote(
        dir,
        state.rec.id,
        "error",
        "⚠ Сбой: " + String((e && e.message) || e).slice(0, 160) + " — жду и продолжаю (авто-продолжение " + state.errorContinues + "/" + state.limits.autoContinues + ")"
      );
    } catch {}
    emitState("error");
    return state.errorContinues;
  };
  // Цена работы: панель показывает токены и сжатия, чтобы «работает часами» не
  // превращалось в невидимый расход.
  const cost = (roundUsage, compactionCount) => {
    if (!state.longWork) return;
    if (roundUsage && roundUsage.prompt) state.tokens += (roundUsage.prompt || 0) + (roundUsage.completion || 0);
    state.compactions = compactionCount || 0;
  };

  return {
    state: state,
    setRec: setRec,
    read: read,
    refresh: refresh,
    emitState: emitState,
    ensure: ensure,
    noteCall: noteCall,
    trackProgress: trackProgress,
    resume: resume,
    autoStart: autoStart,
    pause: pause,
    afterBatch: afterBatch,
    canNudge: canNudge,
    nudge: nudge,
    alive: alive,
    canAutoContinue: canAutoContinue,
    recordError: recordError,
    cost: cost,
  };
}

module.exports = { createRunMission, MISSION_AUTO_ROUND, MISSION_JOURNAL_PER_BATCH };

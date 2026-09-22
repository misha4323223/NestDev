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
// Сколько состояния работы видит модель в каждом раунде (см. digestMessage).
const DIGEST_JOURNAL = 12; // последних записей журнала
const DIGEST_STAGES = 8; // этапов работы в сводке (первый — всегда)
const DIGEST_STAGE_MAX = 170; // длина строки одного этапа
const DIGEST_STAGE_FILES = 4; // имён файлов в строке этапа
const DIGEST_GOAL_NOTES = 4; // уточнений к цели
const DIGEST_ENTRY_MAX = 160; // длина одной записи
const DIGEST_GOAL_MAX = 600; // цель — длинная просьба человека
const DIGEST_STEPS = 12; // пунктов плана
const DIGEST_FILES = 10; // файлов в списке «к чему уже прикасались»
const DIGEST_PROCS = 6; // фоновых процессов
// Предел сводки: она уходит в каждый запрос, поэтому у неё есть потолок. Если не
// влезла — показываем меньше этапов и записей журнала (см. DIGEST_SHRINK).
const DIGEST_MAX = 8000;
const DIGEST_SHRINK = [
  [6, 8],
  [4, 6],
  [2, 3],
];

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
  // Свежее состояние ИМЕННО этой миссии — с диска по id, без перебора папки.
  // Это нужно сводке: этапы, уточнения цели и отметки шагов пишут и прогон, и
  // инструменты агента (через тот же mission-store). Копия в памяти отстала бы на
  // целый батч — а именно она и рассказывает модели, что уже сделано.
  const fresh = () => {
    if (!state.rec) return refresh();
    try {
      const now2 = missionStore.missionLoad(dir, state.rec.id);
      if (now2) return setRec(now2);
    } catch {}
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
    let had = refresh();
    if (!had) return null;
    try {
      missionStore.missionNote(dir, had.id, "note", "▶ Продолжаю миссию: " + had.title);
    } catch {}
    // Новая просьба человека по ходу миссии уточняет цель — и остаётся в файлах
    // миссии. Без этого работа, начатая фразой «сделай всё сам», так и помнила бы
    // только её: просьба вытесняется обрезкой истории, а цель не меняется.
    if (goalSeed && !missionStore.isResumeText(goalSeed) && goalSeed !== had.goal) {
      try {
        const add = missionStore.missionGoalNote(dir, had.id, goalSeed);
        if (add && add.added) {
          had = add.mission;
          setRec(had);
          emit({ type: "notice", text: "➕ К цели миссии добавлено уточнение из твоей последней просьбы." });
        }
      } catch {}
    }
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
        missionStore.missionStage(dir, state.rec.id, { rounds: state.rounds, batches: state.batches, reason: "пауза по кнопке", next: state.rec.next });
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
        // Отрезок закрывается причиной: в пути работы останется, НА ЧЁМ именно
        // остановились — иначе следующий запуск увидел бы только «работа шла».
        missionStore.missionStage(dir, r.id, { rounds: state.rounds, batches: state.batches, reason: reason, next: r.next });
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
      // Отрезок закрылся — и остаётся в миссии: сколько длился, что в нём сделано
      // (файлы из журнала), на чём остановились и что дальше. Это и есть память о
      // пути, которой не хватало модели после границы батча.
      missionStore.missionStage(dir, r.id, { rounds: state.rounds, batches: state.batches, next: r.next });
    } catch {}
    // Хвост журнала едет в сам переход между батчами: это USER-сообщение, оно
    // переживает обрезку истории, поэтому именно здесь модели важно видеть, что уже
    // сделано, а не только числа прогресса.
    let tail = [];
    try {
      tail = missionStore.missionJournal(dir, r.id, { limit: 8 }) || [];
    } catch {
      tail = [];
    }
    const tailText = tail.length ? "\nУже сделано (хвост журнала):\n" + tail.map((e) => "  · " + oneLine(e.text, DIGEST_ENTRY_MAX)).join("\n") : "";
    return {
      continue: true,
      phase: "batch",
      notice:
        "▶ Батч " + (state.batches + 1) + ": продолжаю миссию " + title + " — раундов " + state.rounds +
        ", шагов " + pr.done + "/" + pr.total + ", в работе " + Math.round(elapsedMin) + " мин.",
      historyMessage:
        "Работа продолжается (миссия " + title + ", файлы .agent/missions/" + r.id + "/). Пройдено шагов: " +
        pr.done + " из " + pr.total + (pr.current ? ", сейчас: " + pr.current : "") + tailText +
        "\nНе пересказывай сделанное — вызови следующий инструмент и двигай работу дальше. " +
        "Состояние работы каждый раунд подставляется приложением (цель, план, прогресс, журнал). " +
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

  // ── «Состояние работы»: сводка миссии для модели ──────────────────────────
  // Начало долгой работы вытесняется из окна (обрезка истории идёт С КОНЦА), а
  // журнал миссии лежит на диске и в запрос не попадал вообще: после батча или
  // сжатия модель видела только свежий хвост и заново искала, что уже делала.
  // Поэтому каждый раунд прогон подставляет короткую сводку, собранную ИЗ ФАЙЛОВ
  // миссии и живого состояния, а не из памяти модели. Собирается заново к каждому
  // запросу, поэтому не устаревает и не копится в истории.
  const oneLine = (t, n) => {
    const s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s;
  };
  const clockOf = (ts) => {
    try {
      return new Date(Number(ts) || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };
  // Что переживёт следующие команды (в новой команде этого НЕ будет): имена
  // переменных агента и живые фоновые процессы с портами — по ним агент находит
  // свой запущенный сервер, а не поднимает второй.
  const envNames = () => {
    try {
      const e = live.agentEnv;
      return e && typeof e === "object" ? Object.keys(e).sort() : [];
    } catch {
      return [];
    }
  };
  const backgrounds = () => {
    const out = [];
    try {
      const map = live.backgrounds;
      if (!map || typeof map.values !== "function") return out;
      for (const rec of map.values()) {
        if (!rec) continue;
        if (out.length >= DIGEST_PROCS) break;
        const tail = Array.isArray(rec.output) ? rec.output.slice(-20).join("\n") : "";
        const port = (/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/.exec(tail) || /:(\d{4,5})\b/.exec(String(rec.command || "")) || [])[1] || "";
        out.push({
          id: rec.id,
          command: rec.command,
          pid: (rec.child && rec.child.pid) || 0,
          port: port,
          exited: !!rec.exited,
          exitCode: rec.exitCode,
        });
      }
    } catch {}
    return out;
  };
  // Одна строка этапа: «этап 2 · 12:47→13:05 (18 мин) · раундов 25 · файлов 3 (…) · далее: …».
  const stageLine = (st) => {
    const parts = [
      "этап " + st.n,
      clockOf(st.from) + "→" + clockOf(st.at) + (st.minutes ? " (" + st.minutes + " мин)" : ""),
      "раундов " + st.rounds,
      "шагов " + st.done + "/" + st.total,
    ];
    if (Array.isArray(st.files) && st.files.length) {
      parts.push("файлов " + st.files.length + ": " + st.files.slice(0, DIGEST_STAGE_FILES).map((f) => oneLine(f, 60)).join(", "));
    }
    if (st.reason) parts.push("⏹ " + oneLine(st.reason, 80));
    else if (st.next) parts.push("далее: " + oneLine(st.next, 80));
    return oneLine(parts.join(" · "), DIGEST_STAGE_MAX);
  };
  // Какие этапы показываем: начало работы обязательно, дальше — свежие. Середина
  // пути не теряется насовсем: её можно прочитать через missionStatus.
  const pickStages = (stages, count) => {
    const last = stages.slice(-count);
    return last.indexOf(stages[0]) >= 0 ? last : [stages[0]].concat(last);
  };
  const buildDigest = (r, stageCount, journalCount) => {
    const pr = missionStore.missionProgress(r);
    const elapsed = Math.max(0, Math.round((now() - (r.startedAt || r.createdAt || state.startedAt)) / 60000));
    const lines = [
      "СОСТОЯНИЕ РАБОТЫ (миссия идёт; блок собран приложением из файлов миссии и повторяется каждый раунд — это не пересказ диалога)",
      "Цель: " + oneLine(r.goal, DIGEST_GOAL_MAX),
      "Миссия «" + oneLine(r.title, 120) + "» (" + r.id + ") · батч " + (state.batches + 1) + " · раундов " + state.rounds +
        " · в работе " + elapsed + " мин · шагов " + pr.done + " из " + pr.total + (pr.failed ? " (сбоев " + pr.failed + ")" : ""),
      "План: " + (r.steps.length
        ? r.steps.slice(0, DIGEST_STEPS).map((s, i) => (i + 1) + ") " + (s.state === "done" ? "✓ " : s.state === "failed" ? "⚠ " : s.state === "doing" ? "→ сейчас " : "• ") + oneLine(s.title, 90)).join("; ")
        : "не составлен — вызови todoWrite с планом (3–7 пунктов): он ляжет и в панель, и в шаги этой миссии"),
    ];
    // Уточнения к цели: человек писал по ходу работы. Без этого миссия, заведённая
    // на «сделай всё сам», так и помнила бы только эту фразу.
    const goalNotes = Array.isArray(r.goalNotes) ? r.goalNotes : [];
    if (goalNotes.length) {
      lines.push("Уточнения к цели после начала (свежие внизу — они и важнее):");
      for (const g of goalNotes.slice(-DIGEST_GOAL_NOTES)) lines.push("  · " + clockOf(g.at) + " " + oneLine(g.text, DIGEST_ENTRY_MAX));
    }
    if (pr.current) lines.push("Сейчас: " + oneLine(pr.current, 200));
    if (r.next) lines.push("Дальше (с прошлого шага): " + oneLine(r.next, 200));
    // Этапы работы: сохранённый путь от начала к концу. Именно они переживают
    // границу батча и ужатие контекста — историю обрезает с конца, а эти записи
    // лежат в файлах миссии.
    const stages = Array.isArray(r.stages) ? r.stages : [];
    if (stages.length) {
      const shown = pickStages(stages, stageCount);
      lines.push("Этапы работы (вело приложение; «минут» — сколько длился отрезок, «файлов» — что в нём появилось):");
      for (const st of shown) lines.push("  · " + stageLine(st));
      if (shown.length < stages.length) lines.push("  · …ещё " + (stages.length - shown.length) + " этапов — missionStatus(journal: 40)");
      const first = stages[0];
      if (Array.isArray(first.head) && first.head.length) lines.push("  · с чего начали: " + oneLine(first.head.join(" | "), 300));
      // «Чем закончили» имеет смысл только когда это ДРУГОЙ отрезок: на одном
      // этапе это была бы та же самая строка дважды.
      const last = stages[stages.length - 1];
      if (last !== first && Array.isArray(last.tail) && last.tail.length) {
        lines.push("  · чем закончился прошлый отрезок: " + oneLine(last.tail.join(" | "), 300));
      }
    }
    let journal = [];
    try {
      // Берём с запасом: строки этапов отсеиваются ниже, и без запаса в сводке
      // оказалось бы меньше записей, чем просили.
      journal = missionStore.missionJournal(dir, r.id, { limit: journalCount + 10 }) || [];
    } catch {
      journal = [];
    }
    // Строки «🧭 Этап …» в журнале — те же этапы, что уже показаны выше: дважды
    // они съедали бы места в сводке больше всего.
    journal = journal.filter((e) => e.kind !== "stage").slice(-journalCount);
    if (journal.length) {
      lines.push("Последние записи журнала (свежие внизу):");
      for (const e of journal) lines.push("  · " + clockOf(e.ts) + " " + oneLine(e.text, DIGEST_ENTRY_MAX));
      const touched = [];
      for (const e of journal) {
        const m = /(?:создан файл|правка файла|применён патч):\s*(.+)$/.exec(String(e.text || ""));
        if (m) touched.push(m[1].trim());
      }
      const uniq = [...new Set(touched)].slice(-DIGEST_FILES);
      if (uniq.length) lines.push("Файлы, которых касались: " + uniq.join(", "));
    } else {
      lines.push("Журнал пуст — работа ещё не начиналась.");
    }
    const names = envNames();
    const procs = backgrounds();
    if (names.length || procs.length) {
      lines.push("Переживает отдельные команды (в новой команде этого НЕ будет — состояние живёт здесь):");
      if (names.length) lines.push("  · переменные агента: " + names.slice(0, 12).join(", ") + " (значения скрыты: envList — все, envSet — задать)");
      for (const p of procs) {
        lines.push(
          "  · фон " + p.id + " «" + oneLine(p.command, 60) + "»" + (p.pid ? " PID " + p.pid : "") + (p.port ? ", порт " + p.port : "") +
            (p.exited ? " (уже завершился, код " + p.exitCode + ")" : " (идёт)") + " — backgroundOutput(id), stopBackground(id)"
        );
      }
    }
    lines.push("Папка миссии: .agent/missions/" + r.id + "/ (цель, план, journal.md). Полный журнал и план: missionStatus(journal: 40).");
    lines.push("Правило: то, что должно пережить следующий вызов, клади в дело, а не в память — файлы на диске, envSet(...), startBackground(...); после каждого шага отмечай missionStep(done, next).");
    return lines;
  };    // Сводка уходит в КАЖДЫЙ запрос, поэтому у неё есть предел. Если она в него не
  // влезла, показываем меньше этапов и записей журнала (цель, план и живое состояние
  // не режем никогда), а не отдаём модели простыню.
  const digestMessage = () => {
    if (!state.longWork) return null;
    const r = fresh();
    if (!r) return null;
    // Миссия закрыта (модель сдала работу или человек её закрыл) — сводка больше
    // не нужна: «состояние работы» по сданной работе только путает модель.
    if (r.status && r.status !== "active") return null;
    const full = buildDigest(r, DIGEST_STAGES, DIGEST_JOURNAL).join("\n");
    if (full.length <= DIGEST_MAX) return { role: "system", content: full };
    for (const [stagesN, journalN] of DIGEST_SHRINK) {
      const short = buildDigest(r, stagesN, journalN).join("\n");
      if (short.length <= DIGEST_MAX) return { role: "system", content: short };
    }
    // Совсем крайний случай: даже самое короткое не влезло (гигантская цель или
    // план). Отдаём его же — терять цель нельзя, а предел здесь про размер запроса.
    return { role: "system", content: buildDigest(r, 2, 3).join("\n") };
  };

  // Внешний повод закрыть отрезок (например, человек нажал «Стоп»): работа если и
  // продолжится, то новым отрезком, а в пути останется, на чём именно встали.
  const stage = (reason) => {
    if (!state.longWork || !state.rec) return;
    try {
      missionStore.missionStage(dir, state.rec.id, { rounds: state.rounds, batches: state.batches, reason: reason });
    } catch {}
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
    stage: stage,
    cost: cost,
    digestMessage: digestMessage,
  };
}

module.exports = { createRunMission, MISSION_AUTO_ROUND, MISSION_JOURNAL_PER_BATCH };

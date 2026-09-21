"use strict";

/* ── Миссия прогона агента (src/run-mission.js) ───────────────────────────────
   Запуск: node test/run-mission.test.js   (входит в общий `npm test`)

   Модуль вынесен из ядра чата runAi (этап B, часть 14) и держит долгую работу
   живoй: заводит миссию сама, пишет журнал, ловит цикл и стояние на месте,
   продолжает работу батчами, призывает к продолжению и умеет честно встать на
   паузу. Ошибки здесь тихие и дорогие — не завели миссию: работа умрёт вместе с
   приложением; не поймали цикл: токены горят впустую.

   Набор водит модуль на НАСТОЯЩИХ хранилищах (mission-store.js, mission-guard.js)
   и настоящем диске во временной папке: цель, план, журнал и состояние миссии —
   файлы, а не заглушки. Проверяется поведение (что записано, что ушло в окно),
   а не «строка на месте». */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { createRunMission, MISSION_AUTO_ROUND } = require(path.join(ROOT, "src", "run-mission.js"));
const missionStore = require(path.join(ROOT, "src", "mission-store.js"));

let passed = 0;
let failed = 0;

function selected(name) {
  const only = String(process.argv[2] || "").split("|").map((s) => s.trim()).filter(Boolean);
  if (!only.length) return true;
  return only.some((s) => name.indexOf(s) >= 0);
}

function test(name, fn) {
  if (!selected(name)) return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const MODULE_SRC = read("src", "run-mission.js");
// Единственное прямое чтение main.js — проверка «этого в оболочке больше нет».
const MAIN_SRC = read("src", "main.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "run-mission-"));
let seq = 0;
function workspace() {
  const dir = path.join(tmp, "project-" + ++seq);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Прогон как его собирает runAi: настоящие хранилища, события — в массив,
// живые значения (миссия по кнопке и id для инструментов) — мостами.
function makeRun(over) {
  const o = over || {};
  const dir = o.dir || workspace();
  const events = [];
  const live = { claim: "", missionId: "" };
  const settings = Object.assign(
    { longWork: true, longWorkHours: 8, longWorkRounds: 600, longWorkAutoContinue: 6 },
    o.settings || {}
  );
  const messages = o.messages || [{ role: "user", content: "Сделай отчёт по продажам\nвторой строкой" }, { role: "assistant", content: "ок" }];
  const mission = createRunMission({
    settings: settings,
    planMode: !!o.planMode,
    messages: messages,
    roleId: o.roleId || "developer",
    dir: dir,
    chatId: o.chatId === undefined ? "chat-1" : o.chatId,
    emit: (ev) => events.push(ev),
    missionStore: missionStore,
    missionGuard: require(path.join(ROOT, "src", "mission-guard.js")),
    live: {
      get missionClaim() {
        return live.claim;
      },
      set missionClaim(v) {
        live.claim = v;
      },
      set missionId(v) {
        live.missionId = v;
      },
      // Живое состояние для сводки «СОСТОЯНИЕ РАБОТЫ» (имена переменных агента и
      // фоновые процессы) — мостами, как в оболочке: значения меняются по ходу работы.
      get agentEnv() {
        return o.agentEnv || null;
      },
      get backgrounds() {
        return o.backgrounds || null;
      },
    },
    now: o.now,
  });
  if (o.rounds) mission.state.rounds = o.rounds;
  return { mission: mission, dir: dir, events: events, live: live, settings: settings };
}

const notes = (dir, id) => missionStore.missionJournal(dir, id, { limit: 200 }).map((r) => r.text);
const kinds = (dir, id) => missionStore.missionJournal(dir, id, { limit: 200 }).map((r) => r.kind);
const listOf = (dir) => missionStore.missionList(dir, { limit: 50 });
const onlyMission = (dir) => {
  const all = listOf(dir);
  assert.strictEqual(all.length, 1, "миссий на диске: " + all.length + ", а ждали одну");
  return all[0];
};

(async () => {
  await test("1. без долгой работы модуль молчит: ни миссии, ни файлов", () => {
    const r = makeRun({ settings: { longWork: false } });
    assert.strictEqual(r.mission.state.longWork, false);
    r.mission.state.rounds = MISSION_AUTO_ROUND + 4;
    r.mission.autoStart();
    r.mission.ensure("проверка");
    assert.strictEqual(r.mission.state.rec, null, "миссия завелась без галочки «долгая работа»");
    assert.strictEqual(r.mission.refresh(), null);
    assert.strictEqual(r.mission.resume(), null);
    assert.strictEqual(r.mission.alive(), false);
    assert.strictEqual(r.mission.canNudge(), false);
    r.mission.noteCall("writeFile", { path: "a.js" });
    r.mission.trackProgress([{ name: "writeFile", args: { path: "a.js" } }]);
    r.mission.cost({ prompt: 100, completion: 5 }, 2);
    assert.strictEqual(r.mission.state.tokens, 0, "токены считаются без долгой работы");
    assert.strictEqual(fs.existsSync(path.join(r.dir, ".agent")), false, "папка .agent создана без миссии");
    assert.strictEqual(r.events.length, 0, "в окно ушло событие без миссии");
  });

  await test("2. режим плана выключает миссию, даже если галочка включена", () => {
    const r = makeRun({ planMode: true });
    assert.strictEqual(r.mission.state.longWork, false);
    r.mission.state.rounds = MISSION_AUTO_ROUND;
    r.mission.autoStart();
    assert.strictEqual(listOf(r.dir).length, 0, "в режиме плана завелась миссия");
    assert.strictEqual(fs.existsSync(path.join(r.dir, ".agent")), false);
  });

  await test("3. на шестом раунде миссия заводится сама — цель из последней просьбы", () => {
    const r = makeRun();
    assert.strictEqual(MISSION_AUTO_ROUND, 6, "порог авто-миссии изменился");
    for (let i = 1; i <= MISSION_AUTO_ROUND - 1; i++) {
      r.mission.state.rounds = i;
      r.mission.autoStart();
      assert.strictEqual(r.mission.state.rec, null, "миссия завелась на раунде " + i);
    }
    r.mission.state.rounds = MISSION_AUTO_ROUND;
    r.mission.autoStart();
    const rec = r.mission.state.rec;
    assert.ok(rec && rec.id, "миссия не завелась на шестом раунде");
    assert.strictEqual(rec.goal, "Сделай отчёт по продажам\nвторой строкой", "цель взята не из последней просьбы");
    assert.strictEqual(rec.title, "Сделай отчёт по продажам", "в заголовок попала не первая строка");
    assert.strictEqual(rec.chatId, "chat-1", "миссия не привязана к чату");
    assert.strictEqual(rec.role, "developer", "роль не записана");
    assert.strictEqual(rec.status, "active");
    assert.strictEqual(rec.limits.rounds, 600);
    assert.strictEqual(rec.limits.minutes, 480);
    assert.strictEqual(r.mission.state.autoCreated, true, "миссию завёл не модуль");
    assert.strictEqual(r.live.missionId, rec.id, "инструменты агента не видят свою миссию");
    assert.deepStrictEqual(r.mission.state.rec, missionStore.missionLoad(r.dir, rec.id), "миссия не лежит на диске");
    assert.ok(
      notes(r.dir, rec.id).some((t) => t.indexOf("Миссию завело приложение") >= 0),
      "в журнале нет записи о том, кто завёл миссию"
    );
    const notice = r.events.find((e) => e.type === "notice");
    assert.ok(notice && notice.text.indexOf(rec.id) >= 0 && notice.text.indexOf(".agent/missions/") >= 0, "в окно не ушло объяснение про миссию");
  });

  await test("4. миссию заводит приложение один раз: второй авто-старт ничего не плодит", () => {
    const r = makeRun();
    r.mission.state.rounds = MISSION_AUTO_ROUND;
    r.mission.autoStart();
    const first = r.mission.state.rec.id;
    r.mission.autoStart();
    r.mission.state.rounds = MISSION_AUTO_ROUND + 3;
    r.mission.autoStart();
    assert.strictEqual(listOf(r.dir).length, 1, "появилась вторая миссия");
    assert.strictEqual(r.mission.state.rec.id, first);
  });

  await test("5. свою активную миссию прогон продолжает, а чужую и паузу — нет", () => {
    const dir = workspace();
    const foreign = missionStore.missionCreate(dir, { goal: "чужая работа", chatId: "chat-2" }).mission;
    const r = makeRun({ dir: dir, chatId: "chat-1" });
    assert.strictEqual(r.mission.refresh(), null, "прогон подхватил миссию чужого чата");
    missionStore.missionFinish(dir, foreign.id, { status: "paused", reason: "жду человека" });
    const own = missionStore.missionCreate(dir, { goal: "своя работа", chatId: "chat-1" }).mission;
    missionStore.missionFinish(dir, own.id, { status: "paused", reason: "жду человека" });
    assert.strictEqual(r.mission.refresh(), null, "прогон подхватил паузу — её продолжает кнопка");
    const active = missionStore.missionCreate(dir, { goal: "работа идёт", chatId: "chat-1" }).mission;
    const got = r.mission.refresh();
    assert.ok(got && got.id === active.id, "своя активная миссия не подхвачена");
    assert.strictEqual(r.live.missionId, active.id, "id для инструментов не обновился");
  });

  await test("6. кнопка «▶ Продолжить» сильнее правил, и просьба расходуется один раз", () => {
    const dir = workspace();
    // Кнопка «▶ Продолжить» сначала возвращает миссию в работу (это делает
    // mission-ipc.js) и только потом оставляет просьбу — поэтому здесь миссия уже
    // активна, но чужая для этого прогона: обычный подхват её бы не взял.
    const claimed = missionStore.missionCreate(dir, { goal: "работа по кнопке", chatId: "chat-2" }).mission;
    const r = makeRun({ dir: dir, chatId: "chat-1" });
    r.live.claim = claimed.id;
    const got = r.mission.refresh();
    assert.ok(got && got.id === claimed.id, "миссия, возвращённая кнопкой, не подхвачена");
    assert.strictEqual(r.live.claim, "", "просьба человека не израсходована");
    assert.strictEqual(r.mission.refresh(), null, "чужая миссия подхватилась второй раз, уже без просьбы");
    // Просьба про паузу без возврата в работу силы не имеет: пауза ждёт человека.
    const paused = missionStore.missionCreate(dir, { goal: "ещё работа", chatId: "chat-3" }).mission;
    missionStore.missionFinish(dir, paused.id, { status: "paused", reason: "жду человека" });
    r.live.claim = paused.id;
    assert.strictEqual(r.mission.refresh(), null, "пауза подхватилась одной просьбой, без возврата в работу");
  });

  await test("7. первый раунд: продолжаю миссию с места остановки", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "отчёт", chatId: "chat-1", steps: ["собрать данные"] }).mission;
    missionStore.missionStep(dir, rec.id, { done: "собрать данные" });
    const r = makeRun({ dir: dir, rounds: 1 });
    const res = r.mission.resume();
    assert.ok(res, "незакрытая миссия не продолжена");
    assert.strictEqual(res.phase, "resume");
    assert.strictEqual(res.id, rec.id);
    assert.ok(res.notice.indexOf("продолжаю с места остановки") >= 0, "нет текста о продолжении: " + res.notice);
    assert.ok(res.notice.indexOf("готово шагов: 1") >= 0, "не названо, сколько уже готово: " + res.notice);
    assert.ok(notes(dir, rec.id).some((t) => t.indexOf("Продолжаю миссию") >= 0), "в журнал не записано продолжение");
    // Событие миссии в окно отправляет оболочка — и после текста (порядок прежний).
    assert.strictEqual(r.events.filter((e) => e.type === "mission").length, 0, "модуль сам рисует событие миссии");
    const missionEv = r.events.filter((e) => e.type === "mission");
    // Но про уточнение цели он сообщает сам: человек написал новую просьбу, и она
    // сохранена в миссии — это видно в чате, а не в файлах на диске.
    assert.ok(r.events.some((e) => e.type === "notice" && /уточнение/.test(e.text)), "нет сообщения об уточнении цели");
    assert.strictEqual(missionStore.missionLoad(dir, rec.id).goalNotes.length, 1, "просьба не сохранена уточнением цели");
    r.mission.emitState(res.phase);
    const ev = r.events.filter((e) => e.type === "mission")[0];
    assert.ok(missionEv.length === 0 && !!ev, "событие миссии не отправлено оболочкой");
    assert.ok(ev && ev.type === "mission" && ev.phase === "resume", "событие «продолжаю» не собрано");
    assert.strictEqual(ev.progress.done, 1, "в событии неверный прогресс");
    assert.strictEqual(ev.steps.length, 1, "шаги не ушли в окно");
    // Не первый раунд — приветствия-продолжения нет.
    r.mission.state.rounds = 2;
    assert.strictEqual(r.mission.resume(), null, "продолжение объявлено не на первом раунде");
  });

  await test("8. журнал значимых действий: файлы, дела, письма — и тишина на пустяках", () => {
    const r = makeRun({ rounds: MISSION_AUTO_ROUND });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    r.mission.noteCall("writeFile", { path: "src/a.js" });
    r.mission.noteCall("editFile", { path: "src/b.js" });
    r.mission.noteCall("taskAdd", { title: "позвонить" });
    r.mission.noteCall("readFile", { path: "src/c.js" });
    r.mission.noteCall("listFiles", {});
    const all = notes(r.dir, id).join("\n");
    assert.ok(all.indexOf("⚙ создан файл: src/a.js") >= 0, "в журнале нет записи о созданном файле");
    assert.ok(all.indexOf("⚙ правка файла: src/b.js") >= 0, "в журнале нет записи о правке");
    assert.ok(all.indexOf("⚙ заведено дело: позвонить") >= 0, "в журнале нет записи о деле");
    assert.ok(all.indexOf("src/c.js") < 0, "чтение файла попало в журнал");
    assert.strictEqual(kinds(r.dir, id).filter((k) => k === "tool").length, 3, "в журнале не три значимых действия");
  });

  await test("9. журнал не превращается в поток: не больше 30 записей на батч", () => {
    const r = makeRun({ rounds: MISSION_AUTO_ROUND });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    for (let i = 0; i < 45; i++) r.mission.noteCall("writeFile", { path: "file-" + i + ".js" });
    const tools = kinds(r.dir, id).filter((k) => k === "tool");
    assert.strictEqual(tools.length, 30, "записей журнала: " + tools.length + ", а предел — 30");
  });

  await test("10. повтор одного и того же вызова ловится как цикл", async () => {
    const r = makeRun({ rounds: MISSION_AUTO_ROUND });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    for (let i = 0; i < 6; i++) r.mission.noteCall("writeFile", { path: "same.js" });
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.finish, true, "цикл не остановил работу");
    assert.ok(res.message.indexOf("повторился 6 раз") >= 0, "не сказано, сколько раз повторился вызов: " + res.message);
    assert.ok(res.message.indexOf("похоже на цикл") >= 0, "нет объяснения про цикл");
    const rec = missionStore.missionLoad(r.dir, id);
    assert.strictEqual(rec.status, "paused", "миссия не поставлена на паузу");
    assert.strictEqual(rec.reason, "повтор одного вызова", "причина остановки не записана: " + rec.reason);
    assert.ok(notes(r.dir, id).some((t) => t.indexOf("похоже на цикл") >= 0), "в журнале нет объяснения цикла");
  });

  await test("11. прогресс — это новый шаг или новая работа, а не повтор", async () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "работа", chatId: "chat-1", steps: ["шаг 1", "шаг 2"] }).mission;
    const r = makeRun({ dir: dir, rounds: 3 });
    r.mission.refresh();
    const call = { name: "writeFile", args: { path: "same.js" } };
    // Первые два вызова — новая работа: прогон двигается, отсчёт обнуляется на раунде 3.
    for (let i = 0; i < 2; i++) {
      r.mission.noteCall(call.name, call.args);
      r.mission.trackProgress([call]);
    }
    // С третьего раза тот же самый вызов прогрессом не считается: стояние на месте.
    r.mission.state.rounds = 9;
    r.mission.noteCall(call.name, call.args);
    r.mission.trackProgress([call]);
    r.mission.state.rounds = 12;
    r.mission.noteCall(call.name, call.args);
    r.mission.trackProgress([call]);
    // Последний прогресс — на 3-м раунде: к 12-му набралось 9 раундов стояния.
    // Предел сторожа — 12, поэтому прогон ещё продолжается. Если бы повтор считался
    // прогрессом, отсчёт обнулялся бы и остановки не случилось (проверка ниже).
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.continue, true, "работа прервалась раньше предела стояния на месте");
    // Новый шаг миссии — прогресс: отсчёт обнуляется с 41-го раунда.
    missionStore.missionStep(dir, rec.id, { done: "шаг 1" });
    r.mission.state.rounds = 41;
    r.mission.noteCall(call.name, call.args);
    r.mission.trackProgress([call]);
    r.mission.state.rounds = 52;
    const res2 = await r.mission.afterBatch();
    assert.strictEqual(res2.continue, true, "новый шаг миссии не сбросил отсчёт стояния на месте");
    // Новый вызов — тоже прогресс, даже без нового шага миссии.
    const fresh = { name: "applyPatch", args: { path: "fresh.js" } };
    r.mission.state.rounds = 60;
    r.mission.noteCall(fresh.name, fresh.args);
    r.mission.trackProgress([fresh]);
    r.mission.state.rounds = 71;
    const res3 = await r.mission.afterBatch();
    assert.strictEqual(res3.continue, true, "новая работа инструментом не считается прогрессом");
  });

  await test("12. нет прогресса 12 раундов — мягкая остановка, а не сжигание токенов", async () => {
    const r = makeRun({ rounds: 3 });
    const rec = missionStore.missionCreate(r.dir, { goal: "работа", chatId: "chat-1", steps: ["шаг 1"] }).mission;
    r.mission.refresh();
    const call = { name: "writeFile", args: { path: "same.js" } };
    for (let i = 0; i < 4; i++) {
      r.mission.noteCall(call.name, call.args);
      r.mission.trackProgress([call]);
    }
    r.mission.state.rounds = 15; // 12 раундов без нового шага и без новых вызовов
    r.mission.noteCall(call.name, call.args);
    r.mission.trackProgress([call]);
    r.mission.state.rounds = 27;
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.finish, true, "стояние на месте не остановило работу");
    assert.ok(res.message.indexOf("раундов без нового шага") >= 0, "нет объяснения про стояние на месте: " + res.message);
    assert.strictEqual(res.phase, "paused", "событие миссии не помечено паузой");
    assert.strictEqual(missionStore.missionLoad(r.dir, rec.id).reason, "нет прогресса");
  });

  await test("13. лимит раундов и время миссии останавливают работу с сохранением", async () => {
    const r = makeRun({ rounds: 25, settings: { longWorkRounds: 25 } });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    assert.strictEqual(r.mission.state.limits.rounds, 25, "лимит раундов взят не из настроек");
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.finish, true, "лимит раундов не остановил работу");
    assert.ok(res.message.indexOf("отработала лимит раундов (25)") >= 0, "лимит не назван: " + res.message);
    assert.ok(res.message.indexOf(".agent/missions/" + id + "/") >= 0, "не сказано, где лежит работа");
    const rec = missionStore.missionLoad(r.dir, id);
    assert.strictEqual(rec.status, "paused", "работа не сохранена паузой");
    assert.strictEqual(rec.reason, "лимит раундов");
  });

  await test("14. время миссии вышло — остановка по часам из настроек", async () => {
    let clock = 1000000;
    const r = makeRun({ rounds: 6, now: () => clock, settings: { longWorkHours: 5 } });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    assert.strictEqual(r.mission.state.limits.minutes, 300, "лимит времени взят не из настроек");
    clock += 301 * 60000;
    r.mission.state.rounds = 9;
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.finish, true, "время миссии не остановило работу");
    assert.ok(res.message.indexOf("работала 301 мин") >= 0, "не сказано, сколько работали: " + res.message);
    assert.strictEqual(missionStore.missionLoad(r.dir, id).reason, "время миссии вышло");
  });

  await test("15. батч: продолжаем работу с тем же контекстом, живые счётчики — на диске", async () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "большая работа", chatId: "chat-1", steps: ["шаг 1", "шаг 2"] }).mission;
    missionStore.missionStep(dir, rec.id, { done: "шаг 1" });
    const r = makeRun({ dir: dir, rounds: 25 });
    r.mission.refresh();
    // Работа в этом батче двигалась — иначе сторож справедливо остановит её.
    r.mission.noteCall("writeFile", { path: "src/a.js" });
    r.mission.trackProgress([{ name: "writeFile", args: { path: "src/a.js" } }]);
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.continue, true, "работа не продолжилась батчом");
    assert.strictEqual(res.phase, "batch", "событие миссии не помечено новым батчем");
    assert.ok(res.notice.indexOf("▶ Батч 2") >= 0, "нет объявления батча: " + res.notice);
    assert.ok(res.notice.indexOf("шагов 1/2") >= 0, "в объявлении нет прогресса: " + res.notice);
    assert.ok(res.historyMessage.indexOf(".agent/missions/" + rec.id + "/") >= 0, "в напоминании нет папки миссии");
    assert.ok(res.historyMessage.indexOf("Пройдено шагов: 1 из 2") >= 0, "в напоминании нет пройденных шагов");
    assert.ok(res.historyMessage.indexOf("missionFinish(report)") >= 0, "агент не знает, как закрыть миссию");
    // Переход между батчами — USER-сообщение: оно переживает обрезку истории, поэтому
    // в нём теперь едет хвост журнала (что УЖЕ сделано), а не только числа прогресса.
    assert.ok(res.historyMessage.indexOf("Уже сделано (хвост журнала)") >= 0, "в переходе батча нет хвоста журнала: " + res.historyMessage);
    assert.ok(res.historyMessage.indexOf("создан файл: src/a.js") >= 0, "в переходе батча нет последних действий: " + res.historyMessage);
    assert.strictEqual(r.mission.state.batches, 1, "счётчик батчей прогона не сдвинулся");
    const onDisk = missionStore.missionLoad(dir, rec.id);
    assert.strictEqual(onDisk.batches, 1, "батч не записан на диск");
    assert.ok(notes(dir, rec.id).some((t) => t.indexOf("▶ Батч 2: раундов 25, шагов 1/2") >= 0), "в журнал не записан батч");
    // Новый батч — новый запас записей журнала (до батча запись уже была одна).
    const before = kinds(dir, rec.id).filter((k) => k === "tool").length;
    assert.strictEqual(before, 1, "журнал до батча: " + before + " записей вместо одной");
    for (let i = 0; i < 35; i++) r.mission.noteCall("writeFile", { path: "batch-" + i + ".js" });
    assert.strictEqual(
      kinds(dir, rec.id).filter((k) => k === "tool").length,
      before + 30,
      "запас журнала на батч не восстановлен"
    );
  });

  await test("16. закрытая миссия больше не ведёт прогон", async () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "работа", chatId: "chat-1" }).mission;
    const r = makeRun({ dir: dir, rounds: 3 });
    r.mission.refresh();
    assert.strictEqual(r.mission.alive(), true, "активная миссия не считается живой");
    missionStore.missionFinish(dir, rec.id, { status: "done", report: "сделано" });
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.continue, false, "закрытая миссия продолжила батчи");
    assert.strictEqual(res.finish, false || res.finish === undefined || res.finish === false ? res.finish : res.finish, "закрытие миссии нельзя путать с ошибкой");
    assert.ok(!res.finish, "закрытие миссии выдано за мягкую остановку");
    assert.strictEqual(r.mission.refresh(), null, "закрытая миссия осталась в прогоне");
    // Флаг closed — запасная ветка: подхват и так отдаёт только активные миссии,
    // поэтому до неё дело не доходит. Проверяем честно, что он не сработал.
    assert.strictEqual(res.closed, undefined, "флаг closed сработал на пути, который до него не доходит");
  });

  await test("17. призыв к продолжению: один раз на первый текстовый ответ, повтор — пауза", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "работа", chatId: "chat-1", steps: ["шаг 1", "шаг 2"] }).mission;
    const r = makeRun({ dir: dir, rounds: 4 });
    r.mission.refresh();
    const first = r.mission.nudge("Готово. Осталось доделать вторую часть.");
    assert.strictEqual(first.action, "nudge", "первый текстовый ответ не призвал к продолжению");
    assert.ok(first.notice.indexOf("не закрыта (0/2)") >= 0, "в призыве нет прогресса: " + first.notice);
    assert.ok(first.notice.indexOf("попытка 1/") >= 0, "в призыве нет номера попытки: " + first.notice);
    assert.ok(first.historyMessage.indexOf(rec.id) >= 0, "в напоминании агенту нет id миссии");
    assert.ok(first.historyMessage.indexOf("готово 0 из 2") >= 0, "в напоминании нет прогресса");
    assert.ok(first.historyMessage.indexOf("missionFinish") >= 0, "агент не знает, как закрыть миссию");
    assert.strictEqual(r.mission.state.nudges, 1);
    // Модель повторила тот же ответ — призывы прекращаются, миссия уходит в паузу.
    const again = r.mission.nudge("Готово. Осталось доделать вторую часть.");
    assert.strictEqual(again.action, "pause", "повтор того же ответа не остановил призывы");
    assert.strictEqual(again.phase, "paused");
    assert.ok(again.notice.indexOf("на паузе") >= 0, "нет текста о паузе: " + again.notice);
    const onDisk = missionStore.missionLoad(dir, rec.id);
    assert.strictEqual(onDisk.status, "paused", "миссия не поставлена на паузу на диске");
    assert.ok(notes(dir, rec.id).some((t) => t.indexOf("Призывы к продолжению остановлены") >= 0), "в журнале нет объяснения паузы");
    assert.strictEqual(r.mission.refresh(), null, "пауза подхватывается сама — петля вернётся");
  });

  await test("18. сбой не бросает долгую работу: авто-продолжения по счёту из настроек", () => {
    const r = makeRun({ rounds: 6, settings: { longWorkAutoContinue: 2 } });
    r.mission.autoStart();
    const id = r.mission.state.rec.id;
    assert.strictEqual(r.mission.state.limits.autoContinues, 2, "запас авто-продолжений взят не из настроек");
    assert.strictEqual(r.mission.alive(), true);
    assert.strictEqual(r.mission.canAutoContinue(), true);
    assert.strictEqual(r.mission.recordError(new Error("сеть недоступна")), 1, "счётчик сбоев не сдвинулся");
    assert.strictEqual(r.mission.recordError(new Error("сеть недоступна")), 2);
    assert.strictEqual(r.mission.canAutoContinue(), false, "запас авто-продолжений не исчерпался");
    assert.ok(
      notes(r.dir, id).some((t) => t.indexOf("⚠ Сбой: сеть недоступна") >= 0 && t.indexOf("авто-продолжение 1/2") >= 0),
      "в журнале нет записи о сбое с номером продолжения"
    );
    const err = r.events.filter((e) => e.type === "mission" && e.phase === "error");
    assert.strictEqual(err.length, 2, "в окно не ушли события о сбоях: " + err.length);
    // Пауза — уже не живая работа: авто-продолжений после неё быть не должно.
    missionStore.missionFinish(r.dir, id, { status: "paused", reason: "пауза" });
    assert.strictEqual(r.mission.alive(), false, "пауза считается живой работой");
  });

  await test("19. цена работы считается, но не выдумывается", () => {
    const r = makeRun({ rounds: 6 });
    r.mission.autoStart();
    assert.ok(r.mission.state.rec, "дело идёт: миссия должна быть заведена");
    r.mission.cost({ prompt: 100, completion: 20 }, 3);
    assert.strictEqual(r.mission.state.tokens, 120, "токены раунда не посчитаны");
    assert.strictEqual(r.mission.state.compactions, 3, "сжатия не записаны");
    r.mission.cost(null, 5);
    assert.strictEqual(r.mission.state.tokens, 120, "токены выдуманы без данных провайдера");
    assert.strictEqual(r.mission.state.compactions, 5);
    r.mission.cost({ prompt: 0, completion: 0 }, 6);
    assert.strictEqual(r.mission.state.tokens, 120, "нулевой ответ провайдера добавлен в счёт");
  });

  await test("20. пауза по кнопке гасит миссию на диске, показ остаётся оболочке", () => {
    const r = makeRun({ rounds: 6 });
    r.mission.autoStart();
    assert.ok(r.mission.state.rec, "дело идёт: миссия должна быть заведена");
    const id = r.mission.state.rec.id;
    const paused = r.mission.pause();
    assert.ok(paused.text.indexOf("⏸ Пауза") >= 0 && paused.text.indexOf("▶ Продолжить") >= 0, "нет текста паузы: " + paused.text);
    const onDisk = missionStore.missionLoad(r.dir, id);
    assert.strictEqual(onDisk.status, "paused", "миссия не на паузе");
    assert.strictEqual(onDisk.reason, "пауза по кнопке");
    assert.ok(notes(r.dir, id).some((t) => t.indexOf("⏸ Пауза по кнопке — работа сохранена.") >= 0), "в журнале нет записи о паузе");
    assert.strictEqual(r.mission.state.stopReason, "пауза");
    r.mission.emitState("paused");
    const ev = r.events[r.events.length - 1];
    assert.strictEqual(ev.reason, "пауза", "в окно не ушла причина остановки");
    // Пауза без миссии (обычный чат) не имеет права падать.
    const empty = makeRun({ rounds: 6 });
    assert.ok(empty.mission.pause().text.indexOf("⏸ Пауза") >= 0, "пауза без миссии сломалась");
  });

  await test("21. состояние миссии уходит в окно целиком", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "цель работы", chatId: "chat-1", steps: ["шаг 1"] }).mission;
    const r = makeRun({ dir: dir, rounds: 7 });
    r.mission.refresh();
    r.mission.cost({ prompt: 50, completion: 10 }, 2);
    r.mission.emitState("tick");
    const ev = r.events[0];
    assert.strictEqual(ev.type, "mission");
    assert.strictEqual(ev.id, rec.id);
    assert.strictEqual(ev.title, rec.title);
    assert.strictEqual(ev.goal, "цель работы");
    assert.strictEqual(ev.status, "active");
    assert.strictEqual(ev.steps.length, 1);
    assert.strictEqual(ev.progress.total, 1);
    assert.strictEqual(ev.rounds, 7);
    assert.strictEqual(ev.tokens, 60);
    assert.strictEqual(ev.compactions, 2);
    assert.ok(ev.startedAt > 0, "в событии нет времени начала");
    assert.strictEqual(ev.limits.rounds, 600);
    assert.strictEqual(ev.limits.minutes, 480);
    // Без миссии событие не отправляется вовсе.
    const empty = makeRun();
    empty.mission.emitState("tick");
    assert.strictEqual(empty.events.length, 0, "событие миссии ушло без миссии");
  });

  await test("22. модуль не трогает окно, диск и оболочку сам", () => {
    assert.ok(!/require\(["']electron["']\)/.test(MODULE_SRC), "модуль подключает Electron");
    assert.ok(!/app\.getPath|__dirname|\bprocess\.env\b/.test(MODULE_SRC), "модуль сам догадывается о путях и окружении");
    assert.ok(!/\bfs\./.test(MODULE_SRC), "модуль пишет на диск в обход хранилища миссий");
    assert.ok(MODULE_SRC.indexOf("createRunMission") >= 0 && MODULE_SRC.indexOf("module.exports") >= 0, "модуль не экспортирован");
  });

  await test("23. в оболочке этого больше нет, а модуль собран на своём месте", () => {
    // Цикл прогона с части 25 живёт в src/run-ai.js: собирает и зовёт модули он.
    const runAiSrc = read("src", "run-ai.js");
    for (const gone of [
      "MISSION_AUTO_ROUND",
      "MISSION_AUTO_JOURNAL",
      "missionStore.missionFinish",
      "missionStore.missionCreate",
      "missionStore.missionNote",
      "missionGuard.nudgeStep",
      "missionRefresh",
      "missionEnsure",
      "missionEmit",
      "missionAfterBatch",
      "missionRounds",
      "missionLimits",
    ]) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "в main.js осталось: " + gone);
    }
    assert.ok(MAIN_SRC.includes('const { createRunMission } = require("./run-mission.js")'), "модуль не подключён");
    assert.ok(/const mission = createRunMission\(\{/.test(runAiSrc), "миссия прогона больше не берётся из модуля");
    for (const dep of ["    settings,", "    planMode,", "    messages,", "    roleId: role.id,", "    dir: agentWorkDir(settings),", "    chatId: live.activeRunChatId,", "    emit,", "    missionStore,", "    missionGuard,"]) {
      assert.ok(runAiSrc.includes(dep), "в проводку не передано: " + dep);
    }
    // Мост для живого состояния держит оболочка (часть 25), а прогон отдаёт миссии
    // ТОТ ЖЕ мост: отдельный объект разошёлся бы с ним на первом же значении.
    assert.ok(MAIN_SRC.includes("get missionClaim()"), "модуль не видит просьбу «▶ Продолжить»");
    assert.ok(/set missionId\(v\) \{ runMissionId = v; \}/.test(MAIN_SRC), "модуль не отдаёт миссию прогона инструментам");
    assert.ok(/live: live,/.test(runAiSrc), "миссия получает не тот мост, что прогон");
    for (const used of [
      "mission.state.rounds++",
      "mission.autoStart()",
      "mission.resume()",
      "mission.trackProgress(calls)",
      'mission.emitState("end")',
      "mission.recordError(e)",
    ]) {
      assert.ok(runAiSrc.includes(used), "в ядре чата не используется: " + used);
    }
    // Запись вызова в журнал миссии живёт в модуле строгой очереди (часть 19а):
    // туда попадает каждый выполненный вызов, а не только прошедший пачку.
    const strictSrc = read("src", "run-strict.js");
    assert.ok(strictSrc.includes("mission.noteCall(c.name, c.args)"), "миссия не видит вызовы очереди");
    // Граница батча живёт в модуле решений после раунда (часть 19б).
    const batchSrc = read("src", "run-batch.js");
    assert.ok(batchSrc.includes("mission.afterBatch()"), "миссия не спрашивает границу батча");
    assert.ok(/const after = await batchCtl\.afterRound\(canonical\)/.test(runAiSrc), "прогон не спрашивает границу батча");
    // Призывы по текстовому ответу живут в модуле призывов (часть 20) —
    // сторож миссии спрашивают там.
    // Правка 1.5.173: повтор раунда (лимит/сбой) — та же попытка, а не новый раунд.
    assert.ok(
      /if \(!repeatAttempt\) mission\.state\.rounds\+\+;/.test(runAiSrc),
      "повтор раунда тратит второй раунд миссии — её пределы срабатывают раньше времени"
    );
    assert.ok(/repeatAttempt = true;/.test(runAiSrc), "повтор не помечается как та же попытка");
    assert.ok(/if \(!firstRoundHandled\) \{/.test(runAiSrc), "«продолжаю миссию» может объявляться дважды за прогон");
    assert.ok(/mission\.resume\(\)/.test(runAiSrc), "продолжение миссии потерялось");
    const nudgeSrc = read("src", "run-nudge.js");
    assert.ok(nudgeSrc.includes("mission.canNudge()"), "сторож миссии не спрашивают при текстовом ответе");
    assert.ok(nudgeSrc.includes("mission.nudge(o.text)"), "призыв не получает ответ модели");
    assert.ok(/const stopForPause = \(\) => \{\n    const paused = mission\.pause\(\);/.test(runAiSrc), "пауза по кнопке потеряла свою часть работы");
    // Цена работы в миссии считается в теле раунда: с части 17 оно живёт в
    // src/run-round.js, куда расход и сжатия приходят живыми значениями.
    const roundSrc = read("src", "run-round.js");
    assert.ok(roundSrc.includes("mission.cost(usage, getCompactions())"), "миссия не получает цену работы");
    assert.ok(runAiSrc.includes("getCompactions: () => ctxManager.compactions()"), "сжатия не переданы модулю раунда");
  });

  // ── Сводка «СОСТОЯНИЕ РАБОТЫ» (часть 36, заход 3) ──────────────────────────
  // Жалоба из жизни: после первого батча агент «забывал» , что уже сделал, и
  // заново искал свою работу. Причина видна в коде: обрезка истории идёт С КОНЦА,
  // поэтому начало работы (и сама цель) вытесняется из окна, а журнал миссии
  // лежит файлами на диске и в запрос не попадал вообще. Сводка собирается ИЗ
  // ФАЙЛОВ и живого состояния и повторяется каждый раунд — она и есть память.
  await test("24. сводка состояния: цель, план, прогресс и журнал — из файлов", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, {
      goal: "Довести интеграцию Freebuff до рабочего состояния: поднять сервер, проверить порт",
      chatId: "chat-1",
      steps: ["поднять сервер", "проверить порт", "написать отчёт"],
    }).mission;
    missionStore.missionStep(dir, rec.id, { done: "поднять сервер", next: "проверить порт" });
    const r = makeRun({ dir: dir, rounds: 7 });
    r.mission.refresh();
    r.mission.noteCall("writeFile", { path: "src/server.js" });
    const d = r.mission.digestMessage();
    assert.ok(d && d.role === "system", "сводка не собрана как системное сообщение: " + JSON.stringify(d));
    const t = d.content;
    assert.ok(t.indexOf("СОСТОЯНИЕ РАБОТЫ") === 0, "сводка не начинается с заголовка: " + t.slice(0, 80));
    assert.strictEqual(t.split("СОСТОЯНИЕ РАБОТЫ").length - 1, 1, "заголовок сводки повторяется");
    assert.ok(t.indexOf("Довести интеграцию Freebuff") >= 0, "в сводке нет цели работы");
    assert.ok(t.indexOf("Миссия «") >= 0 && t.indexOf(rec.id) >= 0, "в сводке нет миссии и её id");
    assert.ok(/батч 1 · раундов 7 ·/.test(t), "в сводке нет счётчиков батча и раундов: " + t.split("\n")[2]);
    assert.ok(t.indexOf("1) ✓ поднять сервер") >= 0, "в сводке нет выполненного пункта плана: " + t.split("\n")[3]);
    assert.ok(t.indexOf("3) • написать отчёт") >= 0, "в сводке нет невыполненного пункта плана");
    assert.ok(t.indexOf("Последние записи журнала") >= 0, "в сводке нет журнала");
    assert.ok(t.indexOf("создан файл: src/server.js") >= 0, "в сводке нет последнего действия с файлом: " + t);
    assert.ok(t.indexOf("Файлы, которых касались: src/server.js") >= 0, "в сводке нет списка файлов работы");
    assert.ok(t.indexOf(".agent/missions/" + rec.id + "/") >= 0, "в сводке нет папки миссии");
    assert.ok(t.indexOf("missionStatus(journal: 40)") >= 0, "агент не знает, как прочитать полный журнал");
    assert.ok(t.indexOf("envSet(") >= 0 && t.indexOf("startBackground(") >= 0, "в сводке нет правила про долговечное состояние");
    assert.ok(t.indexOf("missionStep(done, next)") >= 0, "в сводке нет правила отмечать шаги");
  });

  await test("25. сводка состояния: что переживёт следующую команду — переменные и фоновые процессы", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "поднять dev-сервер", chatId: "chat-1" }).mission;
    const backgrounds = new Map([
      ["bg1", { id: "bg1", command: "npm run dev", child: { pid: 4242 }, output: ["", "  ➜  Local: http://localhost:5173/"], exited: false, exitCode: null }],
      ["bg2", { id: "bg2", command: "node old.js", child: { pid: 4343 }, output: [], exited: true, exitCode: 0 }],
    ]);
    const r = makeRun({
      dir: dir,
      rounds: 9,
      agentEnv: { API_KEY: "секретное-значение", PORT: "3000" },
      backgrounds: backgrounds,
    });
    r.mission.refresh();
    const t = r.mission.digestMessage().content;
    assert.ok(t.indexOf("Переживает отдельные команды") >= 0, "в сводке нет раздела про долговечное состояние: " + t);
    assert.ok(t.indexOf("переменные агента: API_KEY, PORT") >= 0, "в сводке нет имён переменных агента: " + t);
    assert.ok(t.indexOf("секретное-значение") < 0, "в сводку утекло ЗНАЧЕНИЕ переменной");
    assert.ok(t.indexOf("фон bg1 «npm run dev» PID 4242, порт 5173 (идёт)") >= 0, "в сводке нет живого сервера с портом: " + t);
    assert.ok(t.indexOf("фон bg2 «node old.js»") >= 0 && t.indexOf("(уже завершился, код 0)") >= 0, "в сводке нет ни завершившегося процесса, ни его кода");
    assert.ok(t.indexOf("backgroundOutput(id), stopBackground(id)") >= 0, "агент не знает, чем смотреть вывод фонового процесса");
  });

  await test("26. сводка состояния: без миссии и без долгой работы — ничего не подставляем", () => {
    const quiet = makeRun({ settings: { longWork: false }, rounds: 9 });
    assert.strictEqual(quiet.mission.digestMessage(), null, "сводка собирается без долгой работы");
    const noMission = makeRun({ rounds: MISSION_AUTO_ROUND - 1 });
    assert.strictEqual(noMission.mission.digestMessage(), null, "сводка собирается, хотя миссии ещё нет");
    // Миссию заводит сам прогон на шестом раунде (autoStart) — сводка идёт сразу за ней,
    // иначе перед запросом она читала бы пустоту.
    noMission.mission.state.rounds = MISSION_AUTO_ROUND;
    noMission.mission.autoStart();
    assert.ok(noMission.mission.state.rec, "авто-миссия не завелась");
    assert.ok(noMission.mission.digestMessage(), "сводка не появилась вместе с авто-миссией");
  });

  await test("27. сводка состояния: длинная работа не превращается в простыню", () => {
    const dir = workspace();
    const longGoal = "довести работу до конца ".repeat(200);
    const rec = missionStore.missionCreate(dir, { goal: longGoal, chatId: "chat-1" }).mission;
    for (let i = 0; i < 40; i++) {
      missionStore.missionNote(dir, rec.id, "tool", "⚙ создан файл: src/очень-длинное-имя-файла-" + i + "-" + "x".repeat(120) + ".js");
    }
    const r = makeRun({ dir: dir, rounds: 60 });
    r.mission.refresh();
    const t = r.mission.digestMessage().content;
    assert.ok(t.length < 7000, "сводка разрослась до " + t.length + " символов — она уходит в каждый запрос");
    assert.ok(t.indexOf("…") >= 0, "длинные строки не обрезаются многоточием");
    const goalLine = t.split("\n")[1] || "";
    assert.ok(goalLine.indexOf("Цель: ") === 0 && goalLine.length < 700, "цель не обрезана: " + goalLine.length + " символов");
    // Считаем САМИ записи («  · время текст»), а не строки до следующего якоря:
    // так проверка не зависит от того, есть ли после журнала список файлов.
    const journalBlock = (t.split("Последние записи журнала")[1] || "").split("\n").slice(1);
    const journalLines = journalBlock.filter((l) => l.indexOf("  · ") === 0).length;
    assert.ok(journalLines <= 12, "в сводке " + journalLines + " записей журнала вместо 12");
    assert.ok(t.indexOf("Файлы, которых касались") >= 0, "в сводке нет списка файлов, хотя создано 40");
  });

  await test("28. сводка состояния: без плана и без живой обвязки — сказано словами, а не пробелом", () => {
    const dir = workspace();
    missionStore.missionCreate(dir, { goal: "мелкая работа без шагов", chatId: "chat-1" });
    const r = makeRun({ dir: dir, rounds: 4 });
    r.mission.refresh();
    const t = r.mission.digestMessage().content;
    assert.ok(t.indexOf("План: не составлен") >= 0, "отсутствие плана не объяснено: " + t.split("\n")[3]);
    assert.ok(t.indexOf("Переживает отдельные команды") < 0, "раздел про живую обвязку есть, хотя переменных и процессов нет");
    assert.ok(t.indexOf("Файлы, которых касались") < 0, "список файлов есть, хотя за работу ничего не создано");
  });

  await test("30. этапы: приложение само сохраняет отрезок работы — с файлами, началом и концом", async () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "долгая работа", chatId: "chat-1", steps: ["шаг 1", "шаг 2"] }).mission;
    const r = makeRun({ dir: dir, rounds: 25 });
    r.mission.refresh();
    r.mission.noteCall("writeFile", { path: "src/a.js" });
    r.mission.noteCall("writeFile", { path: "src/b.js" });
    r.mission.trackProgress([{ name: "writeFile", args: { path: "src/a.js" } }]);
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.continue, true, "батч не продолжился — этапа не будет");
    const stages = missionStore.missionLoad(dir, rec.id).stages;
    assert.strictEqual(stages.length, 1, "этапов на диске: " + stages.length);
    assert.strictEqual(stages[0].n, 1, "номер этапа не с первого");
    assert.strictEqual(stages[0].rounds, 25, "в этапе нет числа раундов отрезка: " + stages[0].rounds);
    assert.deepStrictEqual(stages[0].files, ["src/a.js", "src/b.js"], "в этапе не файлы отрезка: " + JSON.stringify(stages[0].files));
    assert.ok(stages[0].head.length > 0 && stages[0].tail.length > 0, "в этапе нет ни начала, ни конца отрезка");
    assert.ok(stages[0].head[0].indexOf("создан файл: src/a.js") >= 0, "начало отрезка не то: " + stages[0].head[0]);
    assert.ok(notes(dir, rec.id).some((t) => t.indexOf("🧭 Этап 1") >= 0), "в журнале нет строки этапа");
  });

  await test("31. этапы: конец отрезка по лимиту раундов виден в пути работы", async () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "работа с лимитом", chatId: "chat-1", limits: { rounds: 25, minutes: 600 } }).mission;
    const r = makeRun({ dir: dir, rounds: 25, settings: { longWorkRounds: 25 } });
    r.mission.refresh();
    r.mission.noteCall("writeFile", { path: "src/a.js" });
    const res = await r.mission.afterBatch();
    assert.strictEqual(res.finish, true, "лимит раундов не остановил работу");
    const stages = missionStore.missionLoad(dir, rec.id).stages;
    assert.strictEqual(stages.length, 1, "этап при остановке не записан: " + stages.length);
    assert.strictEqual(stages[0].reason, "лимит раундов", "в этапе нет причины остановки: " + stages[0].reason);
    // Остановка человека — тоже конец отрезка: место остановки не теряется.
    // Отдельная миссия, потому что отработавшая лимит уже на паузе (её продолжает человек).
    const dir2 = workspace();
    const rec2 = missionStore.missionCreate(dir2, { goal: "работа по кнопке Стоп", chatId: "chat-1" }).mission;
    const r2 = makeRun({ dir: dir2, rounds: 26 });
    r2.mission.refresh();
    r2.mission.noteCall("writeFile", { path: "src/b.js" });
    r2.mission.stage("остановка человеком");
    const stages2 = missionStore.missionLoad(dir2, rec2.id).stages;
    assert.strictEqual(stages2.length, 1, "«Стоп» не закрыл отрезок: " + stages2.length);
    assert.strictEqual(stages2[0].reason, "остановка человеком", "в отрезке нет причины «Стоп»");
    assert.deepStrictEqual(stages2[0].files, ["src/b.js"], "в отрезке «Стоп» нет его файлов");
  });

  await test("32. уточнение цели: новая просьба сохраняется, текст кнопки «Продолжить» — нет", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "сделай всё сам", chatId: "chat-1" }).mission;
    const r = makeRun({ dir: dir, rounds: 1, messages: [{ role: "user", content: "а именно: собери отчёт в reports/" }] });
    const view = r.mission.resume();
    assert.ok(view && view.id === rec.id, "миссия не продолжилась — уточнения не будет");
    const onDisk = missionStore.missionLoad(dir, rec.id);
    assert.strictEqual(onDisk.goalNotes.length, 1, "уточнение цели не сохранилось: " + JSON.stringify(onDisk.goalNotes));
    assert.strictEqual(onDisk.goalNotes[0].text, "а именно: собери отчёт в reports/", "сохранился не тот текст");
    assert.strictEqual(onDisk.goal, "сделай всё сам", "исходная цель переписана уточнением");
    assert.ok(notes(dir, rec.id).some((t) => t.indexOf("➕ Уточнение к цели") >= 0), "уточнение не попало в журнал");
    assert.ok(r.events.some((e) => e.type === "notice" && /уточнение/.test(e.text)), "человеку не сказано про уточнение");
    // «▶ Продолжить» кладёт в поле ввода текст ПРИЛОЖЕНИЯ — это не просьба человека.
    const service = missionStore.missionResumeText(onDisk, "Хвост журнала:\n- 10:00 создан файл: a.js");
    const r2 = makeRun({ dir: dir, rounds: 1, messages: [{ role: "user", content: service }] });
    r2.mission.resume();
    const after = missionStore.missionLoad(dir, rec.id);
    assert.strictEqual(after.goalNotes.length, 1, "служебный текст кнопки записан уточнением цели: " + JSON.stringify(after.goalNotes));
    // Та же просьба дважды в миссию не пишется.
    const r3 = makeRun({ dir: dir, rounds: 1, messages: [{ role: "user", content: "а именно: собери отчёт в reports/" }] });
    r3.mission.resume();
    assert.strictEqual(missionStore.missionLoad(dir, rec.id).goalNotes.length, 1, "одна просьба записана дважды");
  });

  await test("33. сводка: путь работы и уточнения цели; у старой миссии без этих полей ничего не ломается", () => {
    const dir = workspace();
    const old = missionStore.missionCreate(dir, { goal: "старая работа", chatId: "chat-1" }).mission;
    // Миссия, заведённая ДО появления этапов: в файле нет ни stages, ни goalNotes.
    const file = missionStore.missionFile(dir, old.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.stages;
    delete raw.goalNotes;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const r = makeRun({ dir: dir, rounds: 7 });
    r.mission.refresh();
    const t = r.mission.digestMessage().content;
    assert.ok(t.indexOf("старая работа") >= 0, "цель старой миссии потерялась");
    assert.ok(t.indexOf("Этапы работы") < 0, "у миссии без этапов появился раздел пути работы");
    assert.ok(t.indexOf("Уточнения к цели") < 0, "у миссии без уточнений появился их список");
    // Путь работы и уточнения появляются в сводке, когда они есть в файлах миссии.
    missionStore.missionGoalNote(dir, old.id, "и положи отчёт в reports/");
    missionStore.missionNote(dir, old.id, "tool", "⚙ создан файл: reports/итог.md");
    missionStore.missionStage(dir, old.id, { rounds: 25, next: "проверка" });
    r.mission.refresh();
    const t2 = r.mission.digestMessage().content;
    assert.ok(/Уточнения к цели после начала/.test(t2) && t2.indexOf("и положи отчёт в reports/") >= 0, "уточнение цели не дошло до сводки");
    assert.ok(/Этапы работы/.test(t2) && /этап 1 ·/.test(t2), "путь работы не дошёл до сводки");
    assert.ok(t2.indexOf("далее: проверка") >= 0, "в этапе не видно, чем отрезок закончился");
  });

  await test("34. сводка: путь работы идёт от начала к концу и укладывается в предел", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, {
      goal: "довести работу до конца ".repeat(80),
      chatId: "chat-1",
      steps: ["разведка", "правка", "проверка"],
    }).mission;
    for (let i = 1; i <= 14; i++) {
      missionStore.missionNote(dir, rec.id, "tool", "⚙ создан файл: src/модуль-" + i + "-" + "x".repeat(80) + ".js");
      missionStore.missionStage(dir, rec.id, { rounds: i * 25, next: "шаг " + (i + 1) });
    }
    const r = makeRun({ dir: dir, rounds: 60 });
    r.mission.refresh();
    const t = r.mission.digestMessage().content;
    assert.ok(t.indexOf("Этапы работы") >= 0, "в сводке нет пути работы");
    assert.ok(t.indexOf("этап 1 ·") >= 0, "в сводке нет НАЧАЛА пути");
    assert.ok(t.indexOf("этап 14 ·") >= 0, "в сводке нет КОНЦА пути");
    assert.ok(t.indexOf("…ещё") >= 0, "середина пути не помечена как сокращённая");
    assert.ok(t.length <= 8000, "сводка разрослась до " + t.length + " символов — она уходит в каждый запрос");
    assert.ok(t.indexOf("Цель: довести работу до конца") >= 0, "цель потерялась при сокращении сводки");
  });

  await test("35. сводка берёт миссию с диска: этапы и отметки шагов из инструментов видны сразу", () => {
    const dir = workspace();
    const rec = missionStore.missionCreate(dir, { goal: "долгая работа", chatId: "chat-1", steps: ["разведка", "правка"] }).mission;
    const r = makeRun({ dir: dir, rounds: 9 });
    r.mission.refresh();
    // Так это делает инструмент агента: пишет в хранилище, о копии в памяти не зная.
    // Копия отстала бы на целый батч — до 25 раундов модель видела бы старый прогресс.
    missionStore.missionStep(dir, rec.id, { done: "разведка", next: "правка" });
    missionStore.missionNote(dir, rec.id, "tool", "⚙ создан файл: src/a.js");
    missionStore.missionStage(dir, rec.id, { rounds: 25, next: "правка" });
    const t = r.mission.digestMessage().content;
    assert.ok(t.indexOf("✓ разведка") >= 0, "отметка шага не дошла до сводки без перезагрузки: " + (t.split("\n")[3] || ""));
    assert.ok(t.indexOf("этап 1 ·") >= 0, "этап не дошёл до сводки без перезагрузки");
    assert.ok(t.indexOf("⚙ создан файл: src/a.js") >= 0, "работа из журнала не дошла до сводки");
    // И обратная сторона: по ЗАКРЫТОЙ миссии сводка не подставляется вовсе.
    missionStore.missionFinish(dir, rec.id, { status: "done", report: "готово" });
    assert.strictEqual(r.mission.digestMessage(), null, "сводка подставляется по закрытой миссии");
  });

  await test("29. сводка состояния: прогон подставляет её в каждый раунд и снимает после", () => {
    const runAiSrc = read("src", "run-ai.js");
    assert.ok(runAiSrc.includes("mission.digestMessage()"), "прогон не берёт сводку у миссии");
    assert.ok(runAiSrc.includes("canonical.splice(1, 0, digestMsg)"), "сводка не подставляется перед запросом");
    assert.ok(/const digestMsg = mission\.digestMessage\(\);/.test(runAiSrc), "сводка собирается не один раз за раунд");
    assert.ok(/const di = digestMsg \? canonical\.indexOf\(digestMsg\) : -1;/.test(runAiSrc), "сводка ищется не по ссылке — снимет не ту строку");
    assert.ok(/\} finally \{[\s\S]{0,300}canonical\.splice\(di, 1\);/.test(runAiSrc), "сводка не снимается после раунда: она копилась бы в истории");
    // Индикатор контекста обязан считать УЖЕ подставленную сводку, иначе он врёт
    // про занятое место. Смотрим именно тот вызов, что стоит после подстановки.
    const spliceAt = runAiSrc.indexOf("canonical.splice(1, 0, digestMsg)");
    const emitAfter = runAiSrc.indexOf("emitContext(canonical)", spliceAt);
    assert.ok(spliceAt > 0 && emitAfter > spliceAt && emitAfter - spliceAt < 400, "индикатор контекста считается до подстановки сводки");
    // Сводка уходит модели: раунд получает ту самую историю, куда её подставили.
    assert.ok(/roundRunner\.run\(\{[^}]*messages: canonical/.test(runAiSrc), "раунд получает не ту историю, куда подставлена сводка");
    // Живые мосты для сводки держит оболочка: значения меняются по ходу работы.
    assert.ok(/get agentEnv\(\) \{ return getAgentEnv\(\); \}/.test(MAIN_SRC), "сводка не видит имена переменных агента");
    assert.ok(/get backgrounds\(\) \{ return bgProcesses; \}/.test(MAIN_SRC), "сводка не видит фоновые процессы");
  });


  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

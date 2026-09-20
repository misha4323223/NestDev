"use strict";

/* ── Прогон агента и откат правок: каналы окна и телефона (src/run-ipc.js) ─────
   Запуск: node test/run-ipc.test.js   (входит в общий `npm test`)

   Модуль вынесен из main.js (этап B, часть 34). Проверки бьют по местам, где
   ошибка ТИХАЯ и дорогая:

     • ai:send отвечает окну ЗНАЧЕНИЕМ { ok:false }. Если эта ветка потеряется,
       прогон падал бы молча: окно считало бы, что работа идёт, а правки, уже
       сделанные до сбоя, никто бы не откатил;
     • отметки прогона (источник, роль, чат, миссия) — ЖИВОЕ состояние оболочки.
       Передай их копией — прогон с телефона пометился бы как «с ПК», события
       уехали бы не в тот чат, а инструменты отмечали бы шаги в чужой миссии;
     • снимки и журнал отката пишет не только этот модуль: копия «застыла» бы на
       пустом массиве, и кнопка «Отменить изменения агента» молча ничего не нашла;
     • undo:rollback обязан вернуть файлы и удалить созданные агентом, а сбой на
       одном файле — не сорвать остальные: иначе откат «наполовину» и молчание.

   Имена каналов сверяются с src/preload.js и src/renderer/mobile-api.js; стенды
   работают с настоящими файлами во временных папках, снимки — настоящие. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.join(__dirname, "..");
const { registerRunIpc } = require(path.join(ROOT, "src", "run-ipc.js"));

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
const MODULE_SRC = read("src", "run-ipc.js");
const MAIN_SRC = read("src", "main.js");
const PRELOAD = read("src", "preload.js");
const MOBILE = read("src", "renderer", "mobile-api.js");

let tmpN = 0;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "run-ipc-" + ++tmpN + "-"));

/* Стенд: настоящий модуль, поддельные только «соседи». Коробка live — это состояние
   оболочки: проверяем, что модуль пишет и читает ИМЕННО его, а не свою копию. */
function mkRun(over) {
  const o = over || {};
  const handlers = new Map();
  const box = {
    // У настоящего webContents всегда есть id (им же зовут живые прогоны) —
    // поддельное окно обязано иметь всё, что имеет настоящее (см. HANDOFF §4).
    mainWindow: o.noWindow ? null : { destroyed: false, isDestroyed() { return this.destroyed; }, webContents: { id: 11, sent: [], send(ch, ev) { this.sent.push({ ch, ev }); } } },
    activeAbort: null,
    activeRunOrigin: "desktop",
    activeRunRole: "",
    activeRunChatId: "",
    runMissionId: "",
    activeRunUndo: o.activeRunUndo || [],
    lastUndoLog: o.lastUndoLog || [],
    pendingAsk: o.pendingAsk || null,
  };
  const calls = { runAi: [], persistUndo: 0, loadPersistedUndo: 0, normalized: [], fetched: [] };
  let settings = o.settings || { provider: "openai", model: "test-model" };
  const undoFile = o.undoFile || path.join(tmpDir(), "undo.json");
  const deps = {
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    fs,
    loadSettings: () => settings,
    normalizeSettings: (s) => {
      calls.normalized.push(s);
      return s;
    },
    fetchModels: async (s) => {
      calls.fetched.push(s);
      if (o.fetchThrows) throw new Error("сервер не ответил");
      return [{ id: "a" }, { id: "b" }];
    },
    runAi: async (s, messages, win, opts) => {
      calls.runAi.push({ settings: s, messages, win, opts });
      if (o.runThrows) throw o.runThrows;
      if (o.runAborts) {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }
      if (o.onRun) o.onRun(box);
    },
    persistUndo: () => {
      calls.persistUndo++;
    },
    loadPersistedUndo: () => {
      calls.loadPersistedUndo++;
      if (o.loadedLog) box.lastUndoLog = o.loadedLog;
    },
    undoFile: () => undoFile,
    // Проверка адреса перед запросом — та же, что в main.js (src/net-guard.js).
    netGuard: require(path.join(ROOT, "src", "net-guard.js")),
    // Проверка отправителя у разрушительных каналов (src/ipc-guard.js).
    ipcGuard: require(path.join(ROOT, "src", "ipc-guard.js")),
    live: {
      get mainWindow() { return box.mainWindow; },
      get activeAbort() { return box.activeAbort; },
      get activeRunOrigin() { return box.activeRunOrigin; },
      set activeRunOrigin(v) { box.activeRunOrigin = v; },
      get activeRunRole() { return box.activeRunRole; },
      set activeRunRole(v) { box.activeRunRole = v; },
      set activeRunChatId(v) { box.activeRunChatId = v; },
      set runMissionId(v) { box.runMissionId = v; },
      get activeRunUndo() { return box.activeRunUndo; },
      set activeRunUndo(v) { box.activeRunUndo = v; },
      get lastUndoLog() { return box.lastUndoLog; },
      set lastUndoLog(v) { box.lastUndoLog = v; },
      get pendingAsk() { return box.pendingAsk; },
      set pendingAsk(v) { box.pendingAsk = v; },
    },
  };
  registerRunIpc(deps);
  return {
    handlers,
    box,
    calls,
    undoFile,
    deps,
    setSettings: (s) => {
      settings = s;
    },
  };
}

/* Событие НАСТОЯЩЕГО окна: у вызова из рендерера Electron сам подставляет и
   отправителя (webContents живого окна), и кадр вызова. Наборы раньше писали
   «sender: { id: 1 }» — по такому событию своего окна не видно, и проверка
   отправителя (src/ipc-guard.js) справедливо отказывает: это признак чужого
   рендерера. Поддельные события обязаны быть такими же, как настоящие. */
const fromWindow = (h) => ({ sender: h.box.mainWindow.webContents, senderFrame: { parent: null } });
// Чужой рендерер внутри приложения (второе окно, встроенный просмотр): свой
// webContents, свой id, и он НЕ окно приложения.
const fromAlien = () => ({ sender: { id: 999, send() {} }, senderFrame: { parent: null } });

(async () => {
  console.log("Прогон агента и откат правок: каналы ai:* и undo:*");

  await test("каналы объявлены ровно так, как их зовут окно и телефон", () => {
    const h = mkRun();
    assert.deepStrictEqual(
      [...h.handlers.keys()].sort(),
      ["ai:answer", "ai:send", "ai:stop", "ai:test", "undo:rollback", "undo:status"],
      "состав каналов прогона не тот"
    );
    for (const ch of h.handlers.keys()) {
      assert.ok(PRELOAD.includes(`"${ch}"`) || MOBILE.includes(`"${ch}"`), "канал не объявлен ни в preload.js, ни в mobile-api.js: " + ch);
    }
  });

  await test("ai:send: отметки прогона уходят в ЖИВОЕ состояние оболочки", async () => {
    const h = mkRun();
    await h.handlers.get("ai:send")(fromWindow(h), [{ role: "user", content: "привет" }], { role: "developer", chatId: "chat-1" });
    assert.strictEqual(h.box.activeRunOrigin, "desktop", "прогон с окна помечен не как «с ПК»");
    assert.strictEqual(h.box.activeRunRole, "developer", "роль прогона не записана в оболочку");
    assert.strictEqual(h.box.activeRunChatId, "chat-1", "чат прогона не записан в оболочку");
    assert.strictEqual(h.box.runMissionId, "", "миссия не сброшена в начале прогона");
    assert.strictEqual(h.calls.runAi.length, 1, "прогон не доехал до runAi");
    assert.strictEqual(h.calls.runAi[0].win, h.box.mainWindow, "прогону отдано не живое окно");

    // Прогон с телефона: у события нет sender — это и есть мобильный клиент.
    await h.handlers.get("ai:send")(null, [], { chatId: "chat-2" });
    assert.strictEqual(h.box.activeRunOrigin, "mobile", "прогон с телефона помечен как «с ПК»");
    assert.strictEqual(h.box.activeRunChatId, "chat-2", "чат второго прогона не записан");
    // Роль не пришла — прежняя обязана остаться: иначе журнал миссии потерял бы её.
    assert.strictEqual(h.box.activeRunRole, "developer", "пустая роль стёрла прежнюю");

    // Окно закрыто: единственный законный клиент в этот момент — телефон, и он
    // зовёт канал без отправителя. Прогон обязан пройти и никому не слать событий.
    const h2 = mkRun({ noWindow: true });
    const r = await h2.handlers.get("ai:send")({ sender: { send() {}, id: 0 } }, [], {});
    assert.strictEqual(r.ok, true, "прогон с телефона без окна сломался: " + JSON.stringify(r));
    assert.strictEqual(h2.box.activeRunOrigin, "mobile", "прогон без окна помечен как «с ПК»");

    // Чужой рендерер внутри приложения — не человек за окном: отказать и НЕ
    // запускать прогон. До проверки отправителя такой вызов проходил молча.
    const h3 = mkRun();
    const alien = await h3.handlers.get("ai:send")(fromAlien(), [], {});
    assert.strictEqual(alien.ok, false, "чужой рендерер запустил прогон агента");
    assert.ok(/не из окна/.test(alien.error), "отказ не объяснён: " + alien.error);
    assert.strictEqual(h3.calls.runAi.length, 0, "чужой вызов всё-таки доехал до runAi");
    assert.strictEqual(h3.box.mainWindow.webContents.sent.length, 0, "чужому рендереру ушли события прогона");
  });

  await test("ai:send: сбой прогона — это {ok:false}, событие окну и откат сделанных правок", async () => {
    const h = mkRun({ runThrows: new Error("провайдер отвалился"), activeRunUndo: [{ path: "/a.js", content: "старое", ts: 1 }, { path: "/b.js", content: null, ts: 2 }] });
    const r = await h.handlers.get("ai:send")(fromWindow(h), [], {});
    assert.strictEqual(r.ok, false, "сбой прогона выдан за успех");
    assert.ok(/провайдер отвалился/.test(r.error), "причина сбоя потерялась: " + r.error);
    assert.strictEqual(h.box.lastUndoLog.length, 2, "снимки правок не попали в журнал отката");
    assert.notStrictEqual(h.box.lastUndoLog, h.box.activeRunUndo, "журнал отдан ссылкой — показ отката поедет следом за прогоном");
    assert.strictEqual(h.calls.persistUndo, 1, "чекпоинт не записан на диск — откат не переживёт перезапуск");
    const sent = h.box.mainWindow.webContents.sent;
    assert.ok(sent.some((s) => s.ch === "ai:event" && s.ev.type === "undo_available" && s.ev.count === 2), "окну не сказано, что есть что откатывать: " + JSON.stringify(sent));
    assert.ok(sent.some((s) => s.ch === "ai:event" && s.ev.type === "error" && /провайдер отвалился/.test(s.ev.message)), "окно не получило ошибку: " + JSON.stringify(sent));

    // Остановка человеком — понятный текст, а не «aborted».
    const h2 = mkRun({ runAborts: true, activeRunUndo: [{ path: "/c.js", content: "x", ts: 1 }] });
    const r2 = await h2.handlers.get("ai:send")(fromWindow(h2), [], {});
    assert.strictEqual(r2.ok, false, "остановка выданa за успех");
    assert.ok(/Генерация остановлена/.test(r2.error), "остановка показана сырым текстом: " + r2.error);
    assert.strictEqual(h2.box.lastUndoLog.length, 1, "правки до остановки не откатываются");

    // Правок не было — журнал не трогаем и чекпоинт не пишем.
    const h3 = mkRun({ runThrows: new Error("нет") });
    await h3.handlers.get("ai:send")(fromWindow(h3), [], {});
    assert.strictEqual(h3.calls.persistUndo, 0, "пустой журнал записан на диск");
  });

  await test("ai:send: флаги работы агента снимаются и после успеха, и после сбоя", async () => {
    const h = mkRun({ onRun: () => {
      assert.strictEqual(global.__agentRunning, true, "во время прогона агент не помечен работающим");
      assert.strictEqual(global.__agentStopRequested, false, "флаг остановки стоит на старте прогона");
    } });
    await h.handlers.get("ai:send")(fromWindow(h), [], {});
    assert.strictEqual(global.__agentRunning, false, "успешный прогон оставил агента «работающим»");
    assert.strictEqual(global.__agentStopRequested, false, "после успеха остался флаг остановки");
    assert.strictEqual(global.__agentPauseRequested, false, "после успеха осталась пауза");

    const h2 = mkRun({ runThrows: new Error("сбой") });
    await h2.handlers.get("ai:send")(fromWindow(h2), [], {});
    assert.strictEqual(global.__agentRunning, false, "сбой оставил агента «работающим»");
    assert.strictEqual(global.__agentStopRequested, false, "сбой оставил флаг остановки");

    // К началу следующего прогона старые флаги не должны мешать: иначе кнопка
    // «Стоп», нажатая в прошлой работе, глушила бы новую на первом же шаге.
    global.__agentStopRequested = true;
    const h3 = mkRun({ onRun: () => {
      assert.strictEqual(global.__agentStopRequested, false, "новый прогон начался с чужого флага остановки");
    } });
    await h3.handlers.get("ai:send")(fromWindow(h3), [], {});
  });

  await test("ai:answer: отдаёт ответ прогону и не выдумывает ответ без вопроса", async () => {
    const asked = [];
    const h = mkRun({ pendingAsk: (text) => asked.push(text) });
    assert.strictEqual(h.handlers.get("ai:answer")(null, "делай так"), true, "ответ не принят");
    assert.deepStrictEqual(asked, ["делай так"], "ответ не дошёл до прогона: " + JSON.stringify(asked));
    assert.strictEqual(h.box.pendingAsk, null, "ожидание ответа не снято — прогон завис бы навсегда");
    assert.strictEqual(h.handlers.get("ai:answer")(null, "ещё раз"), false, "ответ принят, когда прогон ничего не спрашивал");

    // Без моста (пустой ответ) — тоже честное false, а не падение.
    const h2 = mkRun();
    assert.strictEqual(h2.handlers.get("ai:answer")(null, "x"), false, "прогон без вопроса принял ответ");
  });

  await test("ai:stop: останавливает прогон, прерывает запрос и отпускает ожидание ответа", async () => {
    const stopped = { aborts: 0 };
    const asked = [];
    const h = mkRun({ pendingAsk: (t) => asked.push(t) });
    h.box.activeAbort = { abort: () => stopped.aborts++ };
    assert.strictEqual(h.handlers.get("ai:stop")(), true, "кнопка «Стоп» не ответила окну");
    assert.strictEqual(global.__agentStopRequested, true, "прогон не увидит просьбу остановиться");
    assert.strictEqual(stopped.aborts, 1, "запрос к провайдеру не прерван");
    assert.deepStrictEqual(asked, [""], "ожидание ответа не отпущено — остановка зависла бы на вопросe: " + JSON.stringify(asked));
    assert.strictEqual(h.box.pendingAsk, null, "ожидание ответа осталось висеть");

    // Без запроса и без вопроса — просто флаг, никаких падений.
    const h2 = mkRun();
    global.__agentStopRequested = false;
    assert.strictEqual(h2.handlers.get("ai:stop")(), true, "остановка без активного запроса сломалась");
    assert.strictEqual(global.__agentStopRequested, true, "остановка без активного запроса не выставлена");
    global.__agentStopRequested = false;
  });

  await test("ai:test: проверяет подключение по ТЕКУЩИМ настройкам и честно сообщает отказ", async () => {
    const h = mkRun({ settings: { provider: "openai", model: "test-model", openaiUrl: "http://localhost:1/v1" } });
    const r = await h.handlers.get("ai:test")(null, { model: "другая-модель" });
    assert.strictEqual(r.ok, true, "успешная проверка выдана за отказ: " + JSON.stringify(r));
    assert.ok(/Найдено моделей: 2/.test(r.message), "число моделей потерялось: " + r.message);
    assert.strictEqual(r.models.length, 2, "список моделей не отдан окну");
    assert.strictEqual(h.calls.fetched[0].model, "другая-модель", "поле из окна не наложено сверху");
    assert.strictEqual(h.calls.fetched[0].openaiUrl, "http://localhost:1/v1", "текущие настройки не дошли до проверки");
    assert.strictEqual(h.calls.normalized.length, 1, "настройки ушли в проверку без нормализации");

    const bad = mkRun({ fetchThrows: true });
    const r2 = await bad.handlers.get("ai:test")(null, {});
    assert.strictEqual(r2.ok, false, "отказ выдан за успешную проверку: " + JSON.stringify(r2));
    assert.ok(/сервер не ответил/.test(r2.message), "причина отказа потерялась: " + r2.message);
    assert.deepStrictEqual(r2.models, [], "при отказе отдан непустой список моделей");
    assert.strictEqual(typeof (await bad.handlers.get("ai:test")(null, {})).message, "string", "окно получило не сообщение");
  });

  await test("undo:status: читает чекпоинт с диска и показывает журнал оболочки", () => {
    const h = mkRun({ loadedLog: [{ path: "/w/a.js", content: "x", ts: 1 }, { path: "/w/b.js", content: null, ts: 2 }] });
    const r = h.handlers.get("undo:status")();
    assert.strictEqual(h.calls.loadPersistedUndo, 1, "чекпоинт прошлых запусков не прочитан — «Отменить» пропала бы после перезапуска");
    assert.strictEqual(r.ok, true, "статус отката не отдан");
    assert.strictEqual(r.count, 2, "число файлов к откату не то: " + r.count);
    assert.deepStrictEqual(r.files, ["/w/a.js", "/w/b.js"], "список файлов к откату не тот: " + JSON.stringify(r.files));

    const empty = mkRun();
    const r2 = empty.handlers.get("undo:status")();
    assert.deepStrictEqual([r2.count, r2.files], [0, []], "пустой чекпоинт показан как непустой: " + JSON.stringify(r2));
  });

  await test("undo:rollback: настоящие файлы возвращаются на место, созданные — удаляются", () => {
    const dir = tmpDir();
    const kept = path.join(dir, "keep.txt");
    fs.writeFileSync(kept, "испорчено агентом", "utf8");
    const made = path.join(dir, "made.txt");
    fs.writeFileSync(made, "создано агентом", "utf8");
    const undoFile = path.join(dir, "undo.json");
    fs.writeFileSync(undoFile, JSON.stringify([{ path: kept, content: "прежнее содержимое", ts: 1 }, { path: made, content: null, ts: 2 }]), "utf8");
    const h = mkRun({
      undoFile,
      lastUndoLog: [{ path: kept, content: "прежнее содержимое", ts: 1 }, { path: made, content: null, ts: 2 }],
      activeRunUndo: [{ path: kept, content: "прежнее содержимое", ts: 1 }],
    });
    const r = h.handlers.get("undo:rollback")();
    assert.strictEqual(r.ok, true, "откат не выполнен");
    assert.strictEqual(r.count, 2, "откат заявил не то число файлов: " + r.count);
    assert.strictEqual(fs.readFileSync(kept, "utf8"), "прежнее содержимое", "файл не возвращён к прежнему содержимому");
    assert.strictEqual(fs.existsSync(made), false, "созданный агентом файл остался на диске");
    assert.strictEqual(fs.existsSync(undoFile), false, "израсходованный чекпоинт остался на диске");
    assert.deepStrictEqual(h.box.lastUndoLog, [], "журнал отката не очищен — «Отменить» предлагала бы откатить снова");
    assert.deepStrictEqual(h.box.activeRunUndo, [], "снимки запуска не очищены");
    assert.strictEqual(h.calls.persistUndo, 0, "откат пишет чекпоинт вместо его удаления");
  });

  await test("undo:rollback: сбой на одном файле не срывает остальные и виден человеку", () => {
    const dir = tmpDir();
    const good = path.join(dir, "good.txt");
    fs.writeFileSync(good, "испорчено", "utf8");
    const badDir = path.join(dir, "нет-такой-папки");
    const bad = path.join(badDir, "bad.txt");
    const undoFile = path.join(dir, "undo.json");
    const h = mkRun({ undoFile, lastUndoLog: [{ path: bad, content: "x", ts: 1 }, { path: good, content: "прежнее", ts: 2 }] });
    const r = h.handlers.get("undo:rollback")();
    assert.strictEqual(r.ok, true, "откат сорвался на одном файле");
    assert.strictEqual(r.count, 2, "сбойный файл не попал в отчёт: " + r.count);
    assert.strictEqual(fs.readFileSync(good, "utf8"), "прежнее", "сбой на одном файле сорвал откат остальных");
    assert.ok(r.restored.some((p) => /ошибка:/.test(p)), "в отчёте нет причины сбоя: " + JSON.stringify(r.restored));
    assert.ok(r.restored.some((p) => p === good), "успешный файл потерялся в отчёте: " + JSON.stringify(r.restored));
  });

  await test("undo:rollback: чужой рендерер не трогает файлы проекта", () => {
    // Откат возвращает файлы к прежнему содержимому и удаляет созданное агентом.
    // Из чужого рендерера это способ стереть чужую работу — до проверки
    // отправителя вызов проходил молча (см. src/ipc-guard.js).
    const dir = tmpDir();
    const kept = path.join(dir, "keep.txt");
    fs.writeFileSync(kept, "испорчено", "utf8");
    const undoFile = path.join(dir, "undo.json");
    fs.writeFileSync(undoFile, JSON.stringify([{ path: kept, content: "прежнее", ts: 1 }]), "utf8");
    const h = mkRun({ undoFile, lastUndoLog: [{ path: kept, content: "прежнее", ts: 1 }] });
    const r = h.handlers.get("undo:rollback")(fromAlien());
    assert.strictEqual(r.ok, false, "чужой рендерер откатил правки: " + JSON.stringify(r));
    assert.ok(/не из окна/.test(r.error), "отказ не объяснён: " + r.error);
    assert.strictEqual(fs.readFileSync(kept, "utf8"), "испорчено", "файл всё-таки вернулся к прежнему содержимому");
    assert.ok(fs.existsSync(undoFile), "чекпоинт отката израсходован чужим вызовом");
    assert.strictEqual(h.calls.loadPersistedUndo, 0, "чужой вызов дошёл до чтения чекпоинта");
  });

  await test("в оболочке этого больше нет, а модуль собран на своём месте с мостом", () => {
    for (const gone of ['ipcMain.handle("ai:send"', 'ipcMain.handle("ai:answer"', 'ipcMain.handle("ai:stop"', 'ipcMain.handle("ai:test"', 'ipcMain.handle("undo:status"', 'ipcMain.handle("undo:rollback"']) {
      assert.ok(MAIN_SRC.indexOf(gone) < 0, "канал остался в оболочке: " + gone);
    }
    assert.ok(/ipcMain\.(handle|on)\("ai:/.test(MAIN_SRC) === false, "в main.js остались каналы агента");
    assert.ok(/ipcMain\.(handle|on)\("undo:/.test(MAIN_SRC) === false, "в main.js остались каналы отката");
    assert.ok(MAIN_SRC.includes('require("./run-ipc.js")'), "модуль не подключён");
    assert.ok(/registerRunIpc\(\{/.test(MAIN_SRC), "проводка каналов прогона не найдена");
    // Живое состояние приходит мостом с обеими сторонами: чтением и записью.
    for (const pair of [
      ["get mainWindow()", "окно не берётся живым"],
      ["get activeAbort()", "прерывание запроса не взято живым"],
      ["set activeRunOrigin(v)", "метка «кто запустил прогон» пришла копией"],
      ["get activeRunRole()", "роль прогона не читается живой"],
      ["set activeRunRole(v)", "роль прогона не записывается в оболочку"],
      ["set activeRunChatId(v)", "чат прогона пришёл копией"],
      ["set runMissionId(v)", "миссия прогона пришла копией"],
      ["get activeRunUndo()", "снимки запуска не читаются живыми"],
      ["set activeRunUndo(v)", "снимки запуска не пишутся в оболочку"],
      ["get lastUndoLog()", "журнал отката не читается живым"],
      ["set lastUndoLog(v)", "журнал отката не пишется в оболочку"],
      ["get pendingAsk()", "ожидание ответа не читается живым"],
      ["set pendingAsk(v)", "ожидание ответа не снимается в оболочке"],
    ]) {
      assert.ok(MAIN_SRC.includes(pair[0]), pair[1]);
    }
    // Помощники переданы значениями, а не потеряны по дороге.
    for (const dep of ["runAi,", "persistUndo,", "loadPersistedUndo,", "undoFile,", "fetchModels,", "normalizeSettings,", "netGuard,", "ipcGuard,"]) {
      assert.ok(MAIN_SRC.includes(dep), "в проводке нет зависимости: " + dep);
    }
    // Разрушительные каналы модуля спрашивают проверку отправителя.
    for (const ch of ["ai:send", "undo:rollback"]) {
      assert.ok(MODULE_SRC.indexOf('channel: "' + ch + '"') >= 0, "канал " + ch + " не проверяет отправителя");
    }
    // А адрес провайдера из интерфейса проходит проверку адреса (src/net-guard.js).
    assert.ok(/netGuard\.checkSettingsUrls\(s\)/.test(MODULE_SRC), "адрес провайдера не проверяется перед запросом");
    // Модуль не заводит своих копий живого состояния.
    for (const own of ["let activeRunOrigin", "let lastUndoLog", "let pendingAsk", "let mainWindow", "let activeAbort"]) {
      assert.ok(MODULE_SRC.indexOf(own) < 0, "модуль завёл свою копию состояния: " + own);
    }
    assert.ok(MAIN_SRC.includes("let mainWindow = null;"), "окно уехало из оболочки");
    assert.ok(MAIN_SRC.includes("let lastUndoLog = [];"), "журнал отката уехал из оболочки");
  });

  console.log("\nПрогон агента и откат правок: " + passed + " ✅ / " + failed + " ❌");
  process.exit(failed ? 1 : 0);
})();

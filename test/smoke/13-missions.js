"use strict";
/* ─── Группа «Дела и миссии: сторож, прогресс, журнал» ─────────────────────────────────
   Часть 81: наборы smoke разъехались по файлам — точка входа держит карту и
   бегунок, а сами наборы лежат по темам. Здесь наборов: 4.

   Порядок вызовов здесь ни при чём: его задаёт бегунок в test/smoke.test.js, и
   он прежний — наборы делят подмену require, временные папки и счётчики,
   поэтому порядок проверок часть логики, а не украшение.

   Основа (проверка, счётчики и помощники) — в ./harness.js; что где лежит —
   в карте в шапке test/smoke.test.js. */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const H = require("./harness.js");
const {
  test,
  ROOT,
  backendSrc,
  coreData,
  finish,
  get,
  hasTool,
  mainOnlySrc,
  tmpdir,
  toolsHomeSrc,
  uiAll,
  uiFile,
} = H;

// ── Роли, дела и миссия (src/renderer/tasks-mission.js) ────────────────────
// Модуль вынесен из app.js: проверяется ПОВЕДЕНИЕ панелей на заглушках настоящей
// разметки и живом обработчике событий — список дел, фильтры, добавление, роли и
// карточка миссии (включая паузу, зависящую от идущей генерации).
async function testTasksMission() {
  await test("роли, дела и миссия: панели рисуются, фильтры и кнопки работают", async () => {
    const vm = require("vm");
    const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "tasks-mission.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const known = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const els = new Map();
    // Заглушка ведёт className и classList ОДНОЙ коллекцией: в браузере это одно и то же,
    // а модуль местами ставит класс строкой, местами через classList.
    const el = () => {
      let set = new Set();
      let html = "";
      return {
        children: [], value: "", textContent: "", title: "", type: "",
        style: {}, dataset: {}, disabled: false, checked: false, onclick: null, onchange: null,
        onkeydown: null, onblur: null,
        // В браузере запись innerHTML заменяет содержимое: пустая строка убирает узлы.
        // Панель чистит список именно так — заглушка обязана это повторять, иначе
        // строки дел копятся и проверка «фильтр сузил список» ничего не видит.
        get innerHTML() { return html; },
        set innerHTML(v) { html = String(v == null ? "" : v); if (!html) this.children.length = 0; },
        get className() { return [...set].join(" "); },
        set className(v) { set = new Set(String(v || "").split(/\s+/).filter(Boolean)); },
        get childElementCount() { return this.children.length; },
        classList: {
          add: (...c) => c.forEach((x) => set.add(x)),
          remove: (...c) => c.forEach((x) => set.delete(x)),
          contains: (c) => set.has(c),
          toggle: (c, on) => (on === undefined ? (set.has(c) ? set.delete(c) : set.add(c)) : on ? set.add(c) : set.delete(c)),
        },
        appendChild(c) { this.children.push(c); return c; },
        append(...cs) { cs.forEach((c) => this.children.push(c)); },
        contains: () => false, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, focus() {}, scrollIntoView() {},
      };
    };
    const $ = (id) => {
      assert.ok(known.has(id), "модуль ищет элемент, которого нет в разметке: " + id);
      if (!els.has(id)) els.set(id, el());
      return els.get(id);
    };
    const hour = 3600e3;
    const board = {
      summary: { active: 2, overdue: 1, today: 1, tomorrow: 0 },
      groups: [
        { id: "overdue", title: "Просрочено", tasks: [{ id: "t1", title: "Позвонить в банк", due: Date.now() - hour, priority: "high", auto: true }] },
        { id: "today", title: "Сегодня", tasks: [{ id: "t2", title: "Сдать отчёт", due: Date.now() + hour, repeat: "weekly:5" }] },
      ],
      done: [{ id: "t3", title: "Старое дело" }],
    };
    const mission = {
      enabled: true,
      active: {
        id: "m1", title: "Разбор заявок", goal: "свести заявки в таблицу", status: "active",
        steps: [{ title: "Прочитать заявки", state: "done" }, { title: "Свести таблицу", state: "todo" }],
        createdAt: Date.now() - hour, startedAt: Date.now() - hour, metrics: { tokens: 10, compactions: 0 },
      },
      progress: { total: 2, done: 1, failed: 0, percent: 50, current: "Свести таблицу" },
      running: true, rounds: 3, batches: 1, tokens: 42, compactions: 1, startedAt: Date.now() - hour,
      journal: [{ ts: Date.now(), kind: "step", text: "Прочитал заявки" }],
    };
    const calls = { board: 0, add: [], update: [], done: [], toasts: [], opened: [], closed: 0, sent: 0, sidebar: 0, persisted: 0, subscribed: 0, resumed: 0, finished: null };
    const api = {
      tasksBoard: async () => { calls.board++; return board; },
      tasksAdd: async (t) => { calls.add.push(t); return { ok: true }; },
      tasksUpdate: async (id, patch) => { calls.update.push([id, patch]); return { ok: true }; },
      tasksDone: async (id, done) => { calls.done.push([id, done]); return { ok: true }; },
      tasksDelete: async () => ({ ok: true }),
      onTasksChanged: (fn) => { calls.subscribed++; calls.changed = fn; },
      setSettings: async () => ({ ok: true }),
      missionState: async () => mission,
      missionOpen: () => {},
      missionPause: async () => ({ ok: true }),
      missionStop: async () => ({ ok: true }),
      missionResume: async () => { calls.resumed++; return { ok: true, text: "продолжай работу" }; },
      missionFinish: async (id) => { calls.finished = id; return { ok: true, status: "stopped" }; },
    };
    const settings = { tasksEnabled: true, defaultRole: "dev" };
    const chat = { id: "c1", role: "manager", messages: [] };
    let streaming = false;
    let sideTab = "tasks";
    // Общие встроенные объекты отдаём в песочницу: тогда объект, собранный ВНУТРИ
    // модуля, получает обычный прототип, и deepStrictEqual сравнивает значения,
    // а не то, в каком контексте создан объект.
    const common = () => ({ Object, Array, JSON, Date, Math, Promise, Error });
    const sandbox = {
      module: { exports: {} }, window: {}, self: {},
      console: { log() {}, warn() {}, error() {} },
      setInterval: () => 0, clearInterval: () => {},
      document: { createElement: () => el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
      ...common(),
    };
    vm.runInNewContext(src, sandbox, { filename: "tasks-mission.js" });
    assert.strictEqual(typeof sandbox.module.exports, "function", "модуль не отдал фабрику");
    const build = (over) => {      const box = {
        module: { exports: {} }, window: {}, self: {},
        console: { log() {}, warn() {}, error() {} },
        setInterval: () => 0, clearInterval: () => {},
        document: { createElement: () => el(), addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
        ...common(),
      };
      vm.runInNewContext(src, box, { filename: "tasks-mission.js" });
      return box.module.exports(
        Object.assign(
          {
            $, api, isElectron: true,
            AgentCore: {
              roleById: (id) => ({ id, icon: id === "dev" ? "🛠" : "🧭", title: id === "dev" ? "Разработчик" : "Менеджер", hint: "подсказка роли" }),
              rolesList: () => [
                { id: "dev", icon: "🛠", title: "Разработчик", hint: "код" },
                { id: "manager", icon: "🧭", title: "Менеджер", hint: "дела" },
              ],
            },
            toast: (t) => calls.toasts.push(t),
            getActiveChat: () => chat,
            selectChat: () => {},
            sendMessage: () => calls.sent++,
            autoResize: () => {},
            persistChatsNow: () => calls.persisted++,
            renderSidebar: () => calls.sidebar++,
            openSidePanel: (tab) => calls.opened.push(tab),
            closeSidePanel: () => calls.closed++,
            sidePanelVisible: () => false,
            startAutoRunNow: () => {},
            getSettings: () => settings,
            isStreaming: () => streaming,
            getSideTab: () => sideTab,
          },
          over || {}
        )
      );
    };
    const M = build();
    assert.deepStrictEqual(Object.keys(M).sort(), ["initRolesAndTasks", "missionFromEvent", "refreshMission", "renderTasks", "setChatRole"], "наружу торчит лишнее или чего-то не хватает");

    // 1. Навешивание: кнопки панелей и лентяи подписки.
    M.initRolesAndTasks();
    // Панель миссии спрашивает состояние у главного процесса асинхронно — даём ей такт.
    await new Promise((r) => setTimeout(r, 0));
    for (const id of ["btn-role", "task-new-auto", "rail-tasks", "rail-mission", "btn-task-add", "btn-tasks-refresh", "btn-tasks-done-toggle"]) {
      assert.strictEqual(typeof $(id).onclick, "function", "нет обработчика на " + id);
    }
    for (const id of ["btn-mission-pause", "btn-mission-stop", "btn-mission-resume", "btn-mission-refresh", "btn-mission-folder"]) {
      assert.strictEqual(typeof $(id).onclick, "function", "нет обработчика на " + id);
    }
    assert.strictEqual(calls.subscribed, 1, "модуль не подписан на изменения дел");
    assert.strictEqual($("tasks-quick-due").children.length, 5, "быстрые сроки не построены");
    assert.strictEqual($("task-new-auto").textContent, "▷ агент", "строка добавления не в режиме «не агенту»");
    // Роль берётся из самого чата: у нас в чате «менеджер».
    assert.ok(/Менеджер/.test($("role-label").textContent), "роль чата не показана на кнопке: " + $("role-label").textContent);
    assert.ok($("btn-role").classList.contains("active"), "нестандартная роль не подсвечена");
    // Миссия пришла из главного процесса и нарисовалась сразу.
    assert.strictEqual($("ms-title").textContent, "Разбор заявок", "карточка миссии не заполнена");
    assert.ok(/работает/.test($("ms-status").textContent) && /1\/2/.test($("ms-status").textContent), "ход миссии не показан: " + $("ms-status").textContent);
    assert.strictEqual($("ms-fill").style.width, "50%", "полоса хода миссии не выставлена");

    // 2. Список дел: счётчики, группы, строки и метки.
    await M.renderTasks();
    assert.ok(/Активных: 2/.test($("tasks-counts").innerHTML) && /просрочено 1/.test($("tasks-counts").innerHTML), "счётчики дел не собраны: " + $("tasks-counts").innerHTML);
    assert.strictEqual($("rail-tasks-badge").textContent, "2", "значок дел на рельсе не обновлён");
    assert.ok(!$("rail-tasks-badge").classList.contains("hidden"), "значок дел спрятан при активных делах");
    assert.strictEqual($("tasks-groups").children.length, 4, "в списке дел не две группы по строке: " + $("tasks-groups").children.length);
    const head = $("tasks-groups").children[0];
    assert.ok(/Просрочено/.test(head.textContent), "заголовок группы потерян: " + head.textContent);
    assert.ok(/overdue/.test(head.className), "просроченная группа не помечена");
    const row = $("tasks-groups").children[1];
    assert.ok(/task-row/.test(row.className) && /high/.test(row.className) && /late/.test(row.className), "строка дела потеряла метки: " + row.className);
    // Строка дела: [флажок, тело, действия]; в теле [название, сроки и метки].
    const metaOf = (r) => (r.children[1] && r.children[1].children[1]) || null;
    const dueText = metaOf(row).children[0].textContent;
    assert.ok(/просрочено/.test(dueText), "срок просроченного дела не показан: " + dueText);
    // Значок «⚠» ровно один: он уже внутри текста срока. Раньше панель показывала
    // «⚠ ⚠ просрочено» — проверка держит это исправленным.
    assert.strictEqual((dueText.match(/⚠/g) || []).length, 1, "значок просрочки удвоен: " + dueText);
    const autoTag = metaOf(row).children[1];
    assert.ok(autoTag && autoTag.textContent === "▶ агент", "у дела с агентом нет метки автозапуска: " + (autoTag && autoTag.textContent));
    const todayRow = $("tasks-groups").children[3];
    const rep = metaOf(todayRow).children[1];
    assert.ok(rep && /🔁 каждую пятницу/.test(rep.textContent), "повтор не расшифрован: " + (rep && rep.textContent));
    // Фильтры: шесть плиток, «Все» активна.
    assert.strictEqual($("tasks-filters").children.length, 6, "фильтры дел не построены");
    assert.strictEqual($("tasks-filters").children[0].dataset.filter, "all", "нет фильтра «Все»");

    // 3. Клик по фильтру «Просрочено»: список перечитывается и сужается.
    const before = calls.board;
    $("tasks-filters").children[1].onclick();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(calls.board, before + 1, "фильтр не перечитал список дел");
    assert.strictEqual($("tasks-groups").children.length, 2, "фильтр не сузил список: " + $("tasks-groups").children.length);

    // 4. Добавление дела: пустое — подсказка и ни одного вызова; с названием — уходит агенту.
    $("task-new-title").value = "  ";
    await $("btn-task-add").onclick();
    assert.strictEqual(calls.add.length, 0, "пустое дело всё равно ушло в главный процесс");
    assert.ok(calls.toasts.some((t) => /напиши/.test(t)), "нет подсказки про пустое название: " + calls.toasts.join(" | "));
    $("task-new-auto").onclick(); // «▶ агент» для нового дела
    assert.strictEqual($("task-new-auto").textContent, "▶ агент", "переключатель «агенту» не сработал");
    $("task-new-title").value = "Проверить отчёт";
    $("task-new-due").value = "завтра 10:00";
    $("task-new-priority").value = "high";
    await $("btn-task-add").onclick();
    // Модуль считает в своём контексте (vm), поэтому его объекты живут в другом
    // наборе прототипов, а deepStrictEqual сверяет и их тоже. Сверяем значения.
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(calls.add)),
      [{ title: "Проверить отчёт", due: "завтра 10:00", priority: "high", auto: true }],
      "дело ушло не тем: " + JSON.stringify(calls.add)
    );
    assert.strictEqual($("task-new-title").value, "", "поле названия не очищено");

    // 5. Миссия: «продолжить» не срабатывает во время генерации, потом работает.
    streaming = true;
    await $("btn-mission-resume").onclick();
    assert.strictEqual(calls.resumed, 0, "миссия продолжилась поверх идущей генерации");
    streaming = false;
    await $("btn-mission-resume").onclick();
    assert.strictEqual(calls.resumed, 1, "миссия не продолжилась, когда генерации нет");
    assert.strictEqual($("input").value, "продолжай работу", "текст продолжения не попал в поле ввода");
    assert.strictEqual(calls.sent, 1, "продолжение миссии не отправлено агенту");
    // Закрытие руками: раньше незакрытую миссию можно было только продолжить или
    // увести в паузу — работа висела в панели, и агент «продолжал» её кругами.
    calls.toasts.length = 0;
    await $("btn-mission-finish").onclick();
    assert.strictEqual(calls.finished, "m1", "закрылась не та миссия: " + calls.finished);
    assert.ok(calls.toasts.some((t) => /закрыта/.test(t)), "человеку не сказали, что миссия закрыта: " + calls.toasts.join(" | "));
    streaming = true;
    calls.finished = null;
    calls.toasts.length = 0;
    await $("btn-mission-finish").onclick();
    assert.strictEqual(calls.finished, null, "миссия закрылась во время идущего прогона");
    assert.ok(calls.toasts.some((t) => /Дождись/.test(t)), "отказ закрыть миссию прозвучал молча: " + calls.toasts.join(" | "));
    streaming = false;
    await M.refreshMission();
    assert.strictEqual($("btn-mission-finish").disabled, false, "кнопка закрытия осталась недоступной без прогона");

    // 6. Событие прогона: карточка обновляется из него, НЕ дожидаясь опроса.
    M.missionFromEvent({ id: "m2", title: "Свести заявки", status: "active", steps: [{ title: "Шаг из события", state: "doing" }], tokens: 7 });
    assert.strictEqual($("ms-title").textContent, "Свести заявки", "событие не обновило заголовок миссии сразу");
    assert.ok(/Шаг из события/.test($("ms-steps").innerHTML), "шаги из события не нарисованы: " + $("ms-steps").innerHTML);
    assert.ok(/✦ 7/.test($("ms-meta").innerHTML), "токены из события не показаны: " + $("ms-meta").innerHTML);
    // А следом идёт опрос: слово главного процесса — последнее.
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual($("ms-title").textContent, "Разбор заявок", "после опроса панель не взяла состояние главного процесса");

    // 7. Негативный контроль: забытая зависимость падает громко, а не молча.
    //    Навешивание ролей сразу зовёт getActiveChat — без неё будет ясная ошибка.
    const broken = build({ getActiveChat: undefined });
    assert.throws(() => broken.initRolesAndTasks(), /getActiveChat/, "забытая зависимость не привела к понятной ошибке");

    // 8. Событие прогона без подробностей (старый движок/обрыв): панель не должна
    //    падать на отсутствующих числах — только показать то, что есть.
    M.missionFromEvent({ id: "m3", title: "Событие без чисел", status: "active" });
    assert.strictEqual($("ms-title").textContent, "Событие без чисел", "событие без чисел не отрисовалось");
    assert.ok(/⏱ 0:00/.test($("ms-meta").innerHTML) && /✦ \d+/.test($("ms-meta").innerHTML), "время и токены не собраны: " + $("ms-meta").innerHTML);
    await new Promise((r) => setTimeout(r, 0));

    // 9. Гонка на старте: событие приходит раньше, чем панель получила состояние.
    //    Раньше панель прятала карточку и советовала «включи галочку в настройках»,
    //    хотя миссия в этот момент идёт, и падала на отсутствующих metrics.
    let slowState = null;
    const race = build({ missionState: () => new Promise((r) => { slowState = r; }) });
    race.missionFromEvent({ id: "m4", title: "Миссия из события", status: "active", steps: [] });
    assert.strictEqual($("ms-title").textContent, "Миссия из события", "событие без опроса не нарисовало миссию");
    assert.strictEqual($("ms-empty").classList.contains("hidden"), true, "пустое состояние не спрятано");
    assert.strictEqual($("ms-card").classList.contains("hidden"), false, "карточка миссии осталась скрытой");
    assert.ok(/включи галочку/.test(String($("ms-empty").textContent)) === false, "панель предлагает включить миссии при идущей миссии");
    // У миссии из одного события нет metrics — панель обязана считать нули, а не падать.
    assert.ok(/✦ 0/.test($("ms-meta").innerHTML), "миссия без metrics не показала нулевые токены: " + $("ms-meta").innerHTML);;
    if (slowState) slowState({ enabled: true, active: null });
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ── 1.65 дела: сроки, CRUD, панель по срокам, напоминания ─────────────────────
async function testTasks() {
  const store = require(path.join(ROOT, "src", "agent-store.js"));
  // Фиксированное «сейчас»: воскресенье, 13 сентября 2026, 12:00 — тесты не зависят от дня запуска.
  const NOW = new Date(2026, 8, 13, 12, 0, 0).getTime();

  await test("tasks: разбор сроков — ISO, dd.mm, слова, «через», день недели, время", () => {
    const due = (v) => {
      const r = store.parseDue(v, NOW);
      assert.ok(r.ok, "не понял срок «" + v + "»: " + (r.error || ""));
      return r.due;
    };
    assert.strictEqual(due(""), "");
    assert.strictEqual(due("2026-09-15"), "2026-09-15T09:00");
    assert.strictEqual(due("15.09"), "2026-09-15T09:00");
    assert.strictEqual(due("15.09.2026 14:30"), "2026-09-15T14:30");
    assert.strictEqual(due("завтра 14:00"), "2026-09-14T14:00");
    assert.strictEqual(due("сегодня 20:00"), "2026-09-13T20:00");
    assert.strictEqual(due("послезавтра"), "2026-09-15T09:00");
    assert.strictEqual(due("через 2 часа"), "2026-09-13T14:00");
    assert.strictEqual(due("через 3 дня"), "2026-09-16T09:00");
    assert.strictEqual(due("в пятницу"), "2026-09-18T09:00");
    assert.strictEqual(due("10 октября"), "2026-10-10T09:00");
    assert.strictEqual(due("14:30"), "2026-09-13T14:30");
    assert.strictEqual(due("вечером"), "2026-09-13T19:00");
    // 15.08 уже прошло — значит речь о следующем годе; 14.30 — это время, а не дата.
    assert.strictEqual(due("15.08"), "2027-08-15T09:00");
    assert.strictEqual(due("14.30"), "2026-09-13T14:30");
    assert.ok(!store.parseDue("мусор", NOW).ok, "мусор принят за срок");
    assert.strictEqual(store.parseDue("15.09", NOW).allDay, true, "дата без времени — «весь день»");
    assert.strictEqual(store.parseDue("15.09 14:00", NOW).allDay, false, "со временем — не весь день");
    // Полная метка времени: время — ЧАСТЬ срока. Секунды и таймзона его не съедают,
    // иначе дело «час назад» становилось «сегодня 09:00» — просроченное уезжало
    // в группу «Сегодня», а счётчик «Просрочено» оставался нулевым.
    const stamp = new Date(NOW - 3600000);
    const isoR = store.parseDue(stamp.toISOString(), NOW);
    assert.ok(isoR.ok, "метка времени не разобрана: " + (isoR.error || ""));
    assert.strictEqual(isoR.allDay, false, "метка времени стала «весь день»");
    assert.ok(Math.abs(new Date(isoR.due).getTime() - stamp.getTime()) < 60000, "время метки потеряно: " + isoR.due);
    assert.strictEqual(due("2026-09-15T14:30:45"), "2026-09-15T14:30");
    assert.strictEqual(due("2026-09-15T14:30"), "2026-09-15T14:30");
    assert.strictEqual(due("2026-09-15 14:30"), "2026-09-15T14:30");
    assert.strictEqual(store.parseDue("2026-09-15T09:00", NOW).allDay, false, "время метки не прочитано");
    // Негодное время не роняет разбор: метка читается хотя бы как дата (как и раньше).
    assert.strictEqual(due("2026-09-21T25:00"), "2026-09-21T09:00");
    // А дата без времени — по-прежнему «весь день» в 09:00.
    assert.strictEqual(due("2026-09-15"), "2026-09-15T09:00");
  });

  await test("tasks: добавление, поиск по названию, правка, выполнение, удаление", () => {
    const ud = tmpdir("tasks-crud-");
    const add = (o) => {
      const r = store.tasksAdd(ud, o, NOW);
      assert.ok(r.ok, "tasksAdd: " + (r.error || ""));
      return r.task;
    };
    const t1 = add({ title: "Позвонить в банк", due: "завтра 14:00", priority: "high", project: "Личное" });
    assert.strictEqual(t1.id, "t1");
    assert.strictEqual(t1.status, "todo");
    assert.strictEqual(t1.due, "2026-09-14T14:00");
    assert.ok(store.tasksAdd(ud, { title: "   " }).ok === false, "пустое название принято");
    assert.ok(store.tasksAdd(ud, { title: "Плохой срок", due: "когда-нибудь" }).ok === false, "непонятный срок принят");

    // Дело ищется по куску названия, а не только по id — так удобнее человеку и модели.
    const byName = store.tasksUpdate(ud, "банк", { priority: "low" });
    assert.ok(byName.ok && byName.task.id === "t1", "поиск по названию: " + (byName.error || ""));
    assert.strictEqual(byName.task.priority, "low");
    assert.strictEqual(byName.task.due, "2026-09-14T14:00");

    add({ title: "Отчёт за неделю", due: "15.09" });
    add({ title: "Разобрать почту" });
    assert.ok(store.tasksAdd(ud, { title: "Дело", project: "Личное" }).ok, "проект в деле");

    const active = store.tasksList(ud, { status: "active", nowMs: NOW });
    assert.strictEqual(active.tasks.length, 4, "активных дел должно быть 4");
    assert.strictEqual(active.summary.summary.tomorrow, 1);
    assert.strictEqual(active.summary.summary.week, 1);
    assert.strictEqual(active.summary.summary.noDue, 2, "без срока — два дела");

    const done = store.tasksDone(ud, "Позвонить в банк");
    assert.ok(done.ok && done.task.status === "done", "отметка «выполнено»: " + (done.error || ""));
    assert.strictEqual(store.tasksList(ud, { status: "active", nowMs: NOW }).tasks.length, 3);
    assert.strictEqual(store.tasksList(ud, { status: "done", nowMs: NOW }).tasks.length, 1);
    assert.ok(store.tasksDone(ud, "банк", false).task.status === "todo", "снятие отметки");

    assert.ok(store.tasksDelete(ud, "почту").ok, "удаление по названию");
    assert.strictEqual(store.tasksList(ud, { status: "all", nowMs: NOW }).tasks.length, 3);
    assert.ok(!store.tasksDelete(ud, "нет такого дела").ok, "удаление несуществующего прошло молча");
    // Дела лежат ОДНИМ файлом в userData, вне рабочей папки — в git не попадут.
    assert.ok(fs.existsSync(path.join(ud, "tasks.json")), "нет tasks.json в userData");
  });

  await test("tasks: панель по срокам, сводка, напоминания (однократные), текст для модели", () => {
    const ud = tmpdir("tasks-board-");
    const at = (shiftDays, clock) => {
      const d = new Date(NOW);
      d.setDate(d.getDate() + shiftDays);
      d.setHours(clock, 0, 0, 0);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + "T" + String(clock).padStart(2, "0") + ":00";
    };
    store.tasksAdd(ud, { title: "Просроченное", due: at(-1, 10) });
    store.tasksAdd(ud, { title: "Сегодняшнее", due: at(0, 23) });
    store.tasksAdd(ud, { title: "Завтрашнее", due: at(1, 10) });
    store.tasksAdd(ud, { title: "На неделе", due: at(4, 10) });
    store.tasksAdd(ud, { title: "Позже", due: at(20, 10) });
    store.tasksAdd(ud, { title: "Без срока" });

    const board = store.tasksBoard(ud, NOW);
    const count = (id) => (board.groups.find((g) => g.id === id) || { tasks: [] }).tasks.length;
    assert.strictEqual(count("overdue"), 1, "просрочено");
    assert.strictEqual(count("today"), 1, "сегодня");
    assert.strictEqual(count("tomorrow"), 1, "завтра");
    assert.strictEqual(count("week"), 1, "на неделе");
    assert.strictEqual(count("later"), 1, "позже");
    assert.strictEqual(count("none"), 1, "без срока");
    // Просроченное — всегда первым: о нём нельзя забыть.
    assert.strictEqual(board.groups[0].tasks[0].title, "Просроченное");
    assert.strictEqual(board.summary.overdue, 1);
    assert.strictEqual(board.summary.active, 6);

    assert.ok(store.tasksFormatText(store.tasksList(ud, { status: "active" }).tasks, NOW).includes("Просроченное"));
    assert.strictEqual(store.tasksFormatText([], NOW), "Дел нет.");
    assert.ok(store.tasksBrief(ud, 3, NOW).includes("Просрочено: 1"), "сводка для промпта: " + store.tasksBrief(ud, 3, NOW));

    // Просроченное напоминаем сразу и ровно один раз; далёкие дела — не трогаем.
    const first = store.tasksTakeReminders(ud, NOW).tasks.map((t) => t.title);
    assert.deepStrictEqual(first, ["Просроченное"], "напоминание о просроченном: " + JSON.stringify(first));
    assert.strictEqual(store.tasksTakeReminders(ud, NOW).tasks.length, 0, "напоминание повторилось");

    // 22:50 — за 10 минут до срока «Сегодняшнее» (23:00): напоминание приходит.
    const soon = NOW + (10 * 60 + 50) * 60 * 1000;
    const later = store.tasksTakeReminders(ud, soon).tasks.map((t) => t.title);
    assert.deepStrictEqual(later, ["Сегодняшнее"], "напоминание за 15 минут до срока: " + JSON.stringify(later));
    assert.ok(!later.includes("Позже"), "напомнили о деле через 20 дней");

    // Новый срок — напоминаем заново (remindedAt сбрасывается вместе со сроком).
    store.tasksUpdate(ud, "Без срока", { due: at(0, 23) });
    assert.ok(store.tasksTakeReminders(ud, soon).tasks.map((t) => t.title).includes("Без срока"), "после смены срока напоминания нет");
  });

  // Срок, отданный меткой времени (так его присылают живой прогон, мобильный мост и
  // правка срока в панели), обязан её сохранить: иначе счётчик «Просрочено» врёт.
  await test("tasks: срок из полной метки времени не теряет время", () => {
    const ud = tmpdir("tasks-stamp-");
    const stamp = new Date(NOW - 3600000);
    const added = store.tasksAdd(ud, { title: "Час назад меткой", due: stamp.toISOString() }, NOW);
    assert.ok(added.ok, "дело с меткой времени не добавлено: " + (added.error || ""));
    assert.strictEqual(added.task.allDay, false, "метка времени стала «весь день»");
    const kept = new Date(added.task.due).getTime();
    assert.ok(Math.abs(kept - stamp.getTime()) < 60000, "время метки потеряно: " + added.task.due);
    assert.ok(kept < NOW, "«час назад» оказалось в будущем: " + added.task.due);

    const board = store.tasksBoard(ud, NOW);
    const count = (id) => (board.groups.find((g) => g.id === id) || { tasks: [] }).tasks.length;
    assert.strictEqual(count("overdue"), 1, "группы панели: " + board.groups.map((g) => g.id + ":" + g.tasks.length).join(" "));
    assert.strictEqual(count("today"), 0, "просроченное уехало в «сегодня»");
    assert.strictEqual(board.summary.overdue, 1, "счётчик панели: " + JSON.stringify(board.summary));
    // Правка срока в панели отдаёт назад ту же строку — время не должно «отъехать».
    const again = store.tasksUpdate(ud, "Час назад", { due: added.task.due });
    assert.strictEqual(again.task.due, added.task.due, "срок не пережил повторную запись: " + again.task.due);
  });
  await test("tasks: человеческий срок и строка дела (для панели и отчёта модели)", () => {
    const ud = tmpdir("tasks-human-");
    const t = store.tasksAdd(ud, { title: "Отчёт", due: "завтра 14:00", priority: "high", project: "Работа", note: "сверить цифры" }, NOW).task;
    const human = store.humanDue(t, NOW);
    assert.ok(human.includes("завтра") && human.includes("14:00"), "человеческий срок: " + human);
    const line = store.taskLine(t, NOW);
    assert.ok(line.includes("t1") && line.includes("Отчёт") && line.includes("Работа"), "строка дела: " + line);
    assert.ok(line.includes("сверить цифры"), "заметка дела не попала в строку");
    // Просроченное помечается явно — иначе в списке его легко не заметить.
    const late = store.tasksAdd(ud, { title: "Старое", due: "2026-09-10" }).task;
    assert.ok(store.humanDue(late, NOW).includes("просрочено"), "просрочка не помечена: " + store.humanDue(late, NOW));
    assert.strictEqual(store.humanDue(store.tasksAdd(ud, { title: "Без срока" }).task, NOW), "без срока");
  });

  // Срок в формате дела — та же форма, что у панели («2026-09-14T10:00»).
  const at2 = (base, shiftDays, clock) => {
    const d = new Date(base);
    d.setDate(d.getDate() + shiftDays);
    d.setHours(clock, 0, 0, 0);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + "T" + String(clock).padStart(2, "0") + ":00";
  };

  await test("tasks: повторы — разбор, подпись, следующий срок", () => {
    assert.deepStrictEqual(store.parseRepeat("каждый день"), { ok: true, repeat: "daily" });
    assert.strictEqual(store.parseRepeat("ежедневно").repeat, "daily");
    assert.strictEqual(store.parseRepeat("по будням").repeat, "weekdays");
    assert.strictEqual(store.parseRepeat("каждую пятницу").repeat, "weekly:5");
    assert.strictEqual(store.parseRepeat("каждый месяц").repeat, "monthly");
    assert.strictEqual(store.parseRepeat("каждые 2 часа").repeat, "every:120");
    assert.strictEqual(store.parseRepeat("раз в неделю").repeat, "weekly");
    assert.strictEqual(store.parseRepeat("без повтора").repeat, "");
    assert.strictEqual(store.parseRepeat("").repeat, "");
    assert.ok(!store.parseRepeat("как-нибудь").ok, "мусор принят за повтор");
    assert.strictEqual(store.repeatLabel("daily"), "каждый день");
    assert.strictEqual(store.repeatLabel("weekdays"), "по будням");
    assert.strictEqual(store.repeatLabel("weekly:5"), "каждую пятницу");
    assert.strictEqual(store.repeatLabel("monthly"), "каждый месяц");
    assert.strictEqual(store.repeatLabel("every:120"), "каждые 2 ч");
    assert.strictEqual(store.repeatLabel(""), "", "у дела без повтора не должно быть подписи");
    const nx = (date, repeat) => store.nextDueDate(date, repeat, date.getTime());
    const d = (y, m, day, h) => new Date(y, m - 1, day, h, 0, 0);
    // daily — тот же час следующего дня.
    const daily = nx(d(2026, 9, 13, 11), "daily");
    assert.strictEqual(daily.getDate(), 14);
    assert.strictEqual(daily.getHours(), 11);
    // weekdays — выходные пропускаются (с воскресенья → на понедельник, с пятницы → на понедельник).
    assert.strictEqual(nx(d(2026, 9, 13, 10), "weekdays").getDay(), 1);
    assert.strictEqual(nx(d(2026, 9, 18, 10), "weekdays").getDay(), 1);
    // weekly и конкретный день недели.
    assert.strictEqual(nx(d(2026, 9, 13, 10), "weekly").getDate(), 20);
    assert.strictEqual(nx(d(2026, 9, 13, 10), "weekly:5").getDay(), 5);
    // monthly — следующий месяц, 31-е в коротком месяце = последний день.
    const mon = nx(d(2026, 9, 15, 10), "monthly");
    assert.strictEqual(mon.getMonth(), 9);
    assert.strictEqual(mon.getDate(), 15);
    assert.strictEqual(nx(d(2026, 1, 31, 10), "monthly").getDate(), 28);
    // every:N — сдвиг по минутам.
    assert.strictEqual(nx(d(2026, 9, 13, 12), "every:120").getHours(), 14);
  });

  await test("tasks: автозадача срабатывает по сроку, повтор сдвигается, тостов нет", () => {
    const ud = tmpdir("tasks-auto-");
    store.tasksAdd(ud, { title: "План дня", due: at2(NOW, 0, 11), repeat: "каждый день", auto: true, prompt: "собери план" }, NOW);
    store.tasksAdd(ud, { title: "Оплатить", due: at2(NOW, 0, 11), auto: true }, NOW);
    store.tasksAdd(ud, { title: "Позвонить", due: at2(NOW, 0, 11) }, NOW);
    const fired = store.tasksTakeAuto(ud, NOW).tasks;
    assert.deepStrictEqual(fired.map((t) => t.title).sort(), ["Оплатить", "План дня"], "автозадачи по сроку: " + JSON.stringify(fired.map((t) => t.title)));
    assert.strictEqual(fired.find((t) => t.title === "План дня").prompt, "собери план", "задание агента потерялось");
    assert.strictEqual(fired.find((t) => t.title === "План дня").repeat, "daily", "повтор не дошёл до события");
    // По тому же сроку второй раз не запускаем — иначе агент сработает дважды.
    assert.strictEqual(store.tasksTakeAuto(ud, NOW + 1000).tasks.length, 0, "автозадача запустилась дважды");
    // Повтор уехал на завтра, разовое осталось активным (его закроет агент или человек).
    const list = store.tasksList(ud, { status: "active", nowMs: NOW }).tasks;
    // Расписание увозит только ПОДТВЕРЖДЁННЫЙ прогон: пока клиент не ответил, срок на
    // месте. Раньше повтор двигался прямо при запуске — и сорвавшийся прогон съедал
    // срабатывание навсегда (этот тест такую поломку и закреплял).
    const plan = () => store.tasksList(ud, { status: "active", nowMs: NOW }).tasks.find((t) => t.title === "План дня");
    assert.ok(plan().due.startsWith("2026-09-13"), "срок повтора уехал до подтверждения прогона: " + plan().due);
    assert.ok(store.tasksAutoAck(ud, plan().id, false, "провайдер не ответил").ok, "отказ клиента не принят");
    assert.ok(plan().due.startsWith("2026-09-13"), "отказ прогона увёз расписание: " + plan().due);
    assert.ok(plan().autoNextAt > NOW, "после отказа не назначена повторная попытка");
    const beforeDue = plan().due;
    assert.ok(store.tasksAutoAck(ud, plan().id, true).ok, "подтверждение прогона не принято");
    const afterDue = plan().due;
    assert.ok(afterDue > beforeDue, "подтверждённый прогон не сдвинул повтор: " + beforeDue + " → " + afterDue);
    assert.strictEqual(afterDue.slice(-5), beforeDue.slice(-5), "сдвиг повтора изменил время суток");
    // Автозадачи — работа агента, а не тост: напоминание приходит только обычному делу.
    assert.deepStrictEqual(store.tasksTakeReminders(ud, NOW).tasks.map((t) => t.title), ["Позвонить"], "автозадача или её повтор дали лишнее напоминание");
    // Вырожденный повтор не принимается.
    assert.ok(store.tasksAdd(ud, { title: "Слишком часто", due: at2(NOW, 0, 11), repeat: "каждые 0 минут" }, NOW).ok === false, "нулевой повтор принят");
  });

  await test("tasks: отсрочка глушит и напоминание, и автозапуск", () => {
    // Отсрочка считается от настоящих часов — тест берёт то же «сейчас». Просроченные
    // дела делаем вчерашними, иначе автозапуск не о чем проверять.
    const R = Date.now();
    const past = at2(new Date(R), -1, 10);
    const ud = tmpdir("tasks-snooze-");
    const t = store.tasksAdd(ud, { title: "Авто", due: past, auto: true }, R).task;
    const t2 = store.tasksAdd(ud, { title: "Тост", due: past }, R).task;
    store.tasksUpdate(ud, t.id, { snooze: "через 2 часа" });
    store.tasksUpdate(ud, t2.id, { snooze: "через 2 часа" });
    assert.strictEqual(store.tasksTakeAuto(ud, R).tasks.length, 0, "отсроченная автозадача сработала");
    assert.strictEqual(store.tasksTakeReminders(ud, R).tasks.length, 0, "отсроченное дело напомнило");
    const later = R + 3 * 60 * 60 * 1000;
    assert.strictEqual(store.tasksTakeAuto(ud, later).tasks.length, 1, "после отсрочки автозадача не сработала");
    assert.deepStrictEqual(store.tasksTakeReminders(ud, later).tasks.map((x) => x.title), ["Тост"], "после отсрочки напоминание не вернулось");
  });

  await test("tasks: будильник знает ближайший срок", () => {
    const ud = tmpdir("tasks-wake-");
    assert.strictEqual(store.tasksNextDue(ud, NOW), 0, "пустой список что-то ждёт");
    store.tasksAdd(ud, { title: "Скоро", due: at2(NOW, 0, 13) }, NOW);
    store.tasksAdd(ud, { title: "Позже", due: at2(NOW, 0, 18) }, NOW);
    assert.strictEqual(store.tasksNextDue(ud, NOW), 60 * 60 * 1000, "ближайший срок посчитан неверно: " + store.tasksNextDue(ud, NOW));
    // Просроченное будильник не ждёт: его поднимает текущая проверка.
    const ud2 = tmpdir("tasks-wake2-");
    store.tasksAdd(ud2, { title: "Прошло", due: at2(NOW, -1, 10) }, NOW);
    assert.strictEqual(store.tasksNextDue(ud2, NOW), 0, "будильник ждёт уже прошедший срок");
  });

  await test("задачи по сроку: приложение будит агента и пишет в чат «Автозадачи»", () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const send = uiFile("chat-send.js"); // прогон агента живёт своим модулем (этап A, часть 9)
    // Раздел «дела и напоминания» вынесен в src/tasks-reminders.js (часть 24):
    // о поведении спрашиваем модуль, у main.js — только проводку.
    const reminders = fs.readFileSync(path.join(ROOT, "src", "tasks-reminders.js"), "utf8");
    // Схема настроек вынесена в src/settings-store.js (этап B, часть 5).
    const store = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const core = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    const tools = toolsHomeSrc(); // дела и заметки — уже своим модулем (часть 40, заход 6b)
    // Автозадачи вынесены своим модулем (этап A, часть 4): ищем код там, где он живёт,
    // а у app.js спрашиваем только то, что он и должен теперь делать — звать модуль.
    const auto = uiFile("auto-tasks.js");
    assert.ok(reminders.includes("tasksTakeAuto"), "планировщик не берёт автозадачи");
    assert.ok(reminders.includes('type: "task-due"'), "событие срока автозадачи не отправляется");
    assert.ok(store.includes("taskAuto: true"), "нет настройки «автозадачи выполняет агент»");
    assert.ok(reminders.includes("armTaskWake") && reminders.includes("tasksNextDue"), "нет точного будильника на срок");
    assert.ok(reminders.includes('{ type: "task-due", from: "desktop", tasks: auto }'), "автозадача уйдёт и на телефон — прогон удвоится");
    assert.ok(/createTasksReminders\(\{/.test(main) && /getWindow: \(\) => mainWindow/.test(main), "модуль напоминаний не подключён к оболочке");
    assert.ok(send.includes("async function runTurn("), "обычная отправка и автозадача не идут общим путём");
    assert.ok(send.includes("await runTurn(chat, content"), "отправка не пользуется общим прогоном");
    assert.ok(auto.includes('AUTO_CHAT_TITLE = "Автозадачи"'), "нет отдельного чата автозадач");
    assert.ok(auto.includes("ensureAutoChat"), "чат автозадач не создаётся");
    const raPos = auto.indexOf("async function runAutoTask");
    assert.ok(raPos > 0, "окно не умеет запускать автозадачу");
    const guardPos = auto.indexOf("if (!isElectron) return;", raPos);
    assert.ok(guardPos > raPos && guardPos - raPos < 600, "автозадачу не ограничили ПК-клиентом");
    assert.ok(uiFile("chat-events.js").includes('ev.type === "task-due"'), "окно не слушает срок автозадачи");
    assert.ok(auto.includes("function flushAutoQueue"), "автозадача не ждёт конца текущего прогона");
    assert.ok(send.includes("getAutoTasks().flushAutoQueue();"), "прогон не разбирает очередь автозадач после себя");
    assert.ok(uiFile("settings-panel.js").includes("getSettings().taskAuto"), "галочка автозадач не читается настройками");
    assert.ok(html.includes("s-task-auto"), "в настройках нет галочки автозадач");
    assert.ok(core.includes("repeat: { type:") && core.includes("auto: { type:"), "инструменты дел не знают о повторах и автозапуске");
    assert.ok(core.includes("Автозадачи"), "роль «Менеджер» не знает про чат автозадач");
    assert.ok(tools.includes("repeat: args.repeat"), "повтор не доходит до хранилища");
    assert.ok(tools.includes("snooze: args.snooze"), "отсрочка не доходит до хранилища");
  });
}

// ── 1.67 миссии: долгая работа, файлы рядом с проектом и панель ──────────────
// ── Сторож миссий: петля «продолжай — нет, ты продолжай» (1.5.114) ──────────
// Миссия, которую прогон «продолжал» сам, заводила круг: модель отвечает текстом,
// приложение призывает «продолжай делом», модель повторяет тот же отчёт — и так
// трижды, а потом миссия встаёт на ПАУЗУ, которую следующий прогон снова
// подхватывает. Человек видел три-четыре одинаковых «Готово». Проверяем правила
// сторожа и то, что main.js действительно их спрашивает, а не решает по-своему.
async function testMissionGuard() {
  const mg = require(path.join(ROOT, "src", "mission-guard.js"));
  const ms = require(path.join(ROOT, "src", "mission-store.js"));
  const mainSrc = backendSrc();

  await test("сторож миссий: сам продолжается только ЖИВАЯ миссия своего чата", () => {
    const live = { id: "m1", status: "active", chatId: "c1" };
    assert.strictEqual(mg.adoptable(live, { chatId: "c1" }), true, "живая миссия своего чата не подхвачена");
    assert.strictEqual(mg.adoptable(live, { chatId: "c2" }), false, "миссия чужого чата подхвачена");
    assert.strictEqual(
      mg.adoptable({ id: "m1", status: "active", chatId: "" }, { chatId: "c2" }),
      true,
      "старая миссия без чата перестала подхватываться"
    );
    for (const status of ["paused", "done", "failed", "stopped", ""]) {
      assert.strictEqual(
        mg.adoptable({ id: "m1", status: status, chatId: "c1" }, { chatId: "c1" }),
        false,
        "подхватилась миссия в состоянии «" + status + "»"
      );
    }
    assert.strictEqual(mg.adoptable({ status: "active" }, {}), false, "миссия без id подхвачена");
    // Свежая пауза лежит выше живой миссии — берём именно живую.
    const list = [{ id: "p", status: "paused", chatId: "c1" }, live];
    assert.strictEqual(mg.pickAdopted(list, { chatId: "c1" }), live, "выбрана пауза вместо живой миссии");
    assert.strictEqual(mg.pickAdopted([{ id: "p", status: "paused", chatId: "c1" }], { chatId: "c1" }), null, "пауза подхватилась сама");
    assert.strictEqual(mg.pickAdopted(null, {}), null, "пустой список сломал выбор");
  });

  await test("сторож миссий: повтор ответа и стояние на месте прекращают призывы", () => {
    assert.deepStrictEqual(
      mg.nudgeStep({ status: "active", max: 3, progress: 1 }),
      { action: "nudge", nudge: 1, reason: "модель ответила текстом, не закрыв миссию" },
      "первый текстовый ответ не получил призыва"
    );
    // Случай человека: работа сдана, модель повторяет тот же отчёт (пробелы не в счёт).
    const repeat = mg.nudgeStep({
      status: "active",
      max: 3,
      nudges: 1,
      progress: 2,
      lastProgress: 2,
      text: "Готово —   отчёт по 10 клиентам",
      lastText: "Готово — отчёт по 10 клиентам\n",
    });
    assert.strictEqual(repeat.action, "pause", "повтор того же отчёта снова получил призыв");
    assert.ok(/повторила/.test(repeat.reason), "причина паузы не объясняет повтор: " + repeat.reason);
    // Отчёт переписан другими словами, но работа не сдвинулась — тоже стоп.
    const idle = mg.nudgeStep({
      status: "active",
      max: 3,
      nudges: 1,
      progress: 2,
      lastProgress: 2,
      text: "Работа завершена, всё на месте",
      lastText: "Готово — отчёт по 10 клиентам",
    });
    assert.strictEqual(idle.action, "pause", "стояние на месте снова получило призыв");
    // Работа сдвинулась — призываем дальше, пока не исчерпали потолок.
    const moved = mg.nudgeStep({ status: "active", max: 3, nudges: 1, progress: 4, lastProgress: 2, text: "Сделал шаг", lastText: "начал" });
    assert.strictEqual(moved.action, "nudge", "после сдвига работа не получила призыва");
    assert.strictEqual(moved.nudge, 2, "номер призыва не вырос");
    assert.strictEqual(
      mg.nudgeStep({ status: "active", max: 3, nudges: 3, progress: 9, lastProgress: 8 }).action,
      "pause",
      "призывы не ограничены потолком"
    );
    for (const status of ["paused", "done", ""]) {
      assert.strictEqual(mg.nudgeStep({ status: status, nudges: 0, progress: 0 }).action, "stop", "призыв к миссии в состоянии «" + status + "»");
    }
    // Петля целиком: сколько бы раз модель ни повторяла отчёт, призывов больше потолка
    // не будет — второй ход уже уводит миссию на паузу.
    const REPORT = "Готово — отчёт по 10 клиентам";
    let nudges = 0;
    let lastText = "";
    let lastProgress = null;
    const actions = [];
    for (let i = 0; i < 8; i++) {
      const st = mg.nudgeStep({ status: "active", max: 3, nudges: nudges, progress: 0, lastProgress: lastProgress, text: REPORT, lastText: lastText });
      actions.push(st.action);
      if (st.action !== "nudge") break;
      nudges = st.nudge;
      lastText = REPORT;
      lastProgress = 0;
    }
    assert.deepStrictEqual(actions, ["nudge", "pause"], "повтор отчёта не остановил петлю: " + actions.join(", "));
  });

  await test("сторож миссий: призыв называет миссию и запрещает пересказ отчёта", () => {
    const t = mg.nudgeText({ title: "Разбор входящих", id: "20260916-1431", progress: { done: 0, total: 0 }, nudge: 2, max: 3 });
    assert.ok(t.indexOf("20260916-1431") >= 0, "в призыве нет id миссии — непонятно, какую работу закрывать");
    assert.ok(/не пересказывай отчёт/i.test(t), "в призыве нет запрета пересказывать отчёт");
    assert.ok(t.indexOf("missionFinish(report") >= 0, "в призыве не сказано, чем закрывать работу");
    assert.ok(t.indexOf("призыв 2 из 3") >= 0, "в призыве не видно, сколько напоминаний осталось");
    assert.ok(t.indexOf("готово 0 из 0") >= 0, "в призыве нет прогресса миссии (в том числе «0 из 0»)");
    assert.strictEqual(
      mg.normalizeReport("Готово — отчёт\nпо клиентам"),
      mg.normalizeReport("  Готово — отчёт   по клиентам "),
      "различия в пробелах считаются другим ответом"
    );
    assert.strictEqual(mg.sameReport("", ""), false, "пустые ответы считаются повтором одного и того же");
    assert.strictEqual(mg.sameReport("одно", "другое"), false, "разные ответы считаются повтором");
  });

  await test("сторож миссий: пауза на диске больше не подхватывается сама", () => {
    const wd = tmpdir("mission-guard-");
    const c = ms.missionCreate(wd, { goal: "Разбор входящих", title: "Разбор входящих", chatId: "c1" });
    assert.ok(c.ok, "missionCreate: " + (c.error || ""));
    // Живую миссию своего чата прогон продолжает сам...
    assert.ok(mg.pickAdopted(ms.missionList(wd, { limit: 20 }), { chatId: "c1" }), "живая миссия своего чата не подхвачена с диска");
    assert.strictEqual(mg.pickAdopted(ms.missionList(wd, { limit: 20 }), { chatId: "другой" }), null, "миссия чужого чата подхвачена с диска");
    // ...а поставленную на паузу — нет: её продолжает человек кнопкой «▶ Продолжить».
    ms.missionFinish(wd, c.mission.id, { status: "paused", reason: "агент остановился, не закрыв миссию" });
    assert.strictEqual(
      mg.pickAdopted(ms.missionList(wd, { limit: 20 }), { chatId: "c1" }),
      null,
      "пауза подхватилась следующим прогоном — петля вернулась"
    );
    assert.ok(ms.missionActive(wd), "пауза пропала из панели «Миссия» — человек не сможет её продолжить");
    // Закрытая миссия не подхватывается ни в каком виде.
    ms.missionFinish(wd, c.mission.id, { status: "done", report: "Итог готов." });
    assert.strictEqual(mg.pickAdopted(ms.missionList(wd, { limit: 20 }), { chatId: "c1" }), null, "закрытая миссия подхватилась");
  });

  await test("сторож миссий: оболочка спрашивает сторожа, а не решает сама", () => {
    assert.ok(/require\("\.\/mission-guard\.js"\)/.test(mainSrc), "main.js не подключил сторожа миссий");
    // Миссия прогона вынесена в src/run-mission.js (этап B, часть 14): сторожа
    // спрашиваем у модуля, а у оболочки — только то, что она его не забыла.
    const missionRunSrc = fs.readFileSync(path.join(ROOT, "src", "run-mission.js"), "utf8");
    const readStart = missionRunSrc.indexOf("const read = () => {");
    assert.ok(readStart > 0, "не нашёл выбор миссии прогона в src/run-mission.js");
    const readBody = missionRunSrc.slice(readStart, missionRunSrc.indexOf("\n  };", readStart));
    assert.ok(readBody.indexOf("missionGuard.pickAdopted") > 0, "выбор миссии идёт мимо сторожа");
    assert.ok(readBody.indexOf("missionStore.missionActive") === -1, "прогон по-прежнему подхватывает любую незакрытую миссию (включая паузы)");
    assert.ok(readBody.indexOf("missionClaim") > 0, "просьба человека «Продолжить» не учитывается при выборе миссии");
    assert.ok(missionRunSrc.indexOf("missionGuard.nudgeStep(") > 0, "решение о призыве принимается мимо сторожа");
    assert.ok(missionRunSrc.indexOf("missionGuard.nudgeText(") > 0, "текст призыва собирается мимо сторожа");
    assert.ok(/missionGuard,\n/.test(mainSrc), "оболочка не передала сторожа в миссию прогона");
    assert.ok(
      mainSrc.indexOf('(mission.status === "active" || mission.status === "paused")') === -1,
      "призывы по-прежнему бьют по миссии на паузе"
    );
    assert.ok(/activeRunMissionId: \(\) => runMissionId/.test(mainSrc), "миссия прогона не отдана агентским инструментам");
    const toolsSrc = toolsHomeSrc(); // миссии и план — уже своим модулем (часть 40, заход 6c)
    assert.ok(toolsSrc.indexOf("const missionOfRun = (dir)") > 0, "нет помощника «миссия прогона» в реестре инструментов");
    for (const call of ["missionOfRun(msDir2)", "missionOfRun(msDir3)", "missionOfRun(msDir4)"]) {
      assert.ok(toolsSrc.indexOf(call) > 0, "инструмент без id работает не со своей миссией: " + call);
    }
    // План панели обязан доехать до файлов миссии: без этой проводки миссия, заведённая
    // приложением без steps, так и остаётся «без плана» — хоть агент план и пишет.
    assert.ok(/const planMission = missionOfRun\(planDir\);/.test(toolsSrc), "todoWrite не ищет миссию прогона");
    assert.ok(/missionStore\.missionSetPlan\(planDir, planMission\.id, planTasks\)/.test(toolsSrc), "todoWrite не переносит план в миссию");
    assert.ok(/План миссии «/.test(toolsSrc), "агент не видит, что план лёг в миссию");
    assert.ok(/missionSetPlan,/.test(fs.readFileSync(path.join(ROOT, "src", "mission-store.js"), "utf8")), "missionSetPlan не вынесен наружу из хранилища");
    assert.ok(/Отчёт по ОДНОЙ И ТОЙ ЖЕ работе/.test(coreData()), "в промпте нет правила «отчёт присылается один раз»");
    // Человеческий путь «▶ Продолжить»: миссия возвращается в работу, запоминается
    // как просьба человека (пауза сама не подхватывается) и продолжается в СВОЁМ чате.
    // Каналы миссий вынесены в src/mission-ipc.js (этап B, часть 1) — спрашиваем модуль.
    const missionIpc = fs.readFileSync(path.join(ROOT, "src", "mission-ipc.js"), "utf8");
    const resumeAt = missionIpc.indexOf('ipcMain.handle("mission:resume"');
    assert.ok(resumeAt > 0, "модуль не умеет продолжать миссию по кнопке");
    const resumeBlock = missionIpc.slice(resumeAt, missionIpc.indexOf("mission:open", resumeAt));
    assert.ok(resumeBlock.indexOf('rec.status = "active"') > 0, "кнопка «Продолжить» не возвращает миссию в работу");
    assert.ok(/missionClaim = rec\.id/.test(resumeBlock), "просьба человека не запоминается для следующего прогона");
    const missionUi = fs.readFileSync(path.join(ROOT, "src", "renderer", "tasks-mission.js"), "utf8");
    assert.ok(/c\.id === r\.chatId/.test(missionUi), "продолжение уходит не в тот чат, где живёт миссия");
    assert.ok(/getChatsData: \(\) => chatsData/.test(uiFile("app.js")), "панели миссии не отданы живые данные чатов");
    // Человек может закрыть миссию руками — и закрытая больше не подхватывается.
    assert.ok(uiFile("index.html").indexOf('id="btn-mission-finish"') > 0, "в панели миссии нет кнопки закрытия");
    assert.ok(/missionFinish: \(id\) => ipcRenderer\.invoke\("mission:finish"/.test(fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8")), "закрытие миссии не отдано окну");
    const finishAt = mainSrc.indexOf('ipcMain.handle("mission:finish"');
    assert.ok(finishAt > 0, "в главном процессе нет закрытия миссии");
    const finishBlock = mainSrc.slice(finishAt, mainSrc.indexOf("ipcMain.handle(\"mission:open\"", finishAt));
    assert.ok(/status: "stopped"/.test(finishBlock) && /закрыто человеком/.test(finishBlock), "человеческое закрытие не отличается от провала работы");
    const closedWd = tmpdir("mission-human-close-");
    const closedRec = ms.missionCreate(closedWd, { goal: "Закрыть руками", chatId: "c1" });
    ms.missionFinish(closedWd, closedRec.mission.id, { status: "stopped", reason: "закрыто человеком" });
    assert.strictEqual(ms.missionActive(closedWd), null, "закрытая человеком миссия снова считается незакрытой");
    assert.strictEqual(mg.pickAdopted(ms.missionList(closedWd, { limit: 20 }), { chatId: "c1" }), null, "закрытая человеком миссия подхватилась прогоном");
  });
}

async function testMissions() {
  const ms = require(path.join(ROOT, "src", "mission-store.js"));
  // Фиксированное «сейчас»: 15 сентября 2026, 10:30 — тесты не зависят от дня запуска.
  const DAY = new Date(2026, 8, 15, 10, 30, 0).getTime();

  await test("миссии: цель, план и журнал ложатся файлами рядом с проектом", () => {
    const wd = tmpdir("mission-create-");
    const r = ms.missionCreate(wd, {
      goal: "Разобрать входящие и разложить по делам",
      title: "Разбор входящих",
      steps: ["Прочитать письма", "Разложить по делам"],
      ts: DAY,
    });
    assert.ok(r.ok, "missionCreate: " + (r.error || ""));
    const id = r.mission.id;
    const adir = path.join(wd, ".agent");
    assert.ok(fs.existsSync(path.join(adir, "README.md")), "нет README в .agent");
    assert.strictEqual(fs.readFileSync(path.join(adir, ".gitignore"), "utf8").trim(), "*", "журнал работы не исключён из git");
    assert.ok(fs.existsSync(path.join(adir, "missions", id, "mission.json")), "нет mission.json");
    assert.ok(fs.existsSync(path.join(adir, "missions", id, "journal.md")), "нет journal.md");
    assert.ok(fs.existsSync(path.join(adir, "missions", id, "journal.jsonl")), "нет journal.jsonl");
    const p = ms.missionProgress(r.mission);
    assert.strictEqual(p.total, 2);
    assert.strictEqual(p.done, 0);
    assert.strictEqual(p.percent, 0);
    assert.strictEqual(p.left, 2);
    const active = ms.missionActive(wd);
    assert.ok(active && active.id === id, "миссия не видна как незакрытая");
    assert.ok(!ms.missionCreate(wd, { goal: "   " }).ok, "пустая цель принята");
    assert.ok(!ms.missionCreate("", { goal: "цель" }).ok, "миссия создана без рабочей папки");
    assert.ok(ms.missionJournalText(wd, id).indexOf("Миссия начата") >= 0, "старт миссии не попал в журнал");
  });

  await test("миссии: удаление подключено от панели до склада, но не во время прогона", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const preloadSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const panelSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "tasks-mission.js"), "utf8");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    assert.ok(html.includes('id="btn-mission-delete"'), "нет кнопки удаления в карточке миссии");
    const missionIpcSrc = fs.readFileSync(path.join(ROOT, "src", "mission-ipc.js"), "utf8");
    assert.ok(/ipcMain\.handle\("mission:delete"/.test(missionIpcSrc), "нет канала mission:delete");
    assert.ok(/missionDelete: \(id\) => ipcRenderer\.invoke\("mission:delete"/.test(preloadSrc), "мост не отдаёт удаление в окно");
    // Во время прогона удалять нельзя: агент держит миссию в памяти и продолжит писать.
    assert.ok(/global\.__agentRunning/.test(missionIpcSrc.split('ipcMain.handle("mission:delete"')[1].split("ipcMain.handle(")[0]), "канал не отказывает во время прогона");
    assert.ok(/btn-mission-delete"\)\.onclick/.test(panelSrc), "кнопка в карточке ни к чему не подключена");
    assert.ok(/isStreaming\(\)/.test(panelSrc.split('$("btn-mission-delete").onclick')[1].split("};")[0]), "кнопка удаления работает и во время прогона");
    assert.ok(/ms-past-del/.test(panelSrc), "у прошлых миссий нет кнопки удаления");
    assert.ok(/confirm\(/.test(panelSrc.split('querySelectorAll(".ms-past-del")')[1].slice(0, 800)), "удаление прошлой миссии идёт без подтверждения");
    assert.ok(/confirm\(/.test(panelSrc.split('$("btn-mission-delete").onclick')[1].slice(0, 900)), "удаление из карточки идёт без подтверждения");
  });

  await test("миссии: удаление уносит папку целиком, а мусорный идентификатор — отказ", () => {
    const wd = tmpdir("mission-delete-");
    const r = ms.missionCreate(wd, { goal: "Черновик на удаление", steps: ["Шаг"], ts: DAY });
    const id = r.mission.id;
    const dir = path.join(wd, ".agent", "missions", id);
    assert.ok(fs.existsSync(dir), "миссия не создалась");
    // Идентификатор идёт в путь, поэтому проверяется до удаления: «..» увёл бы наружу.
    assert.ok(!ms.missionDelete(wd, "..").ok, "идентификатор «..» принят");
    assert.ok(!ms.missionDelete(wd, "../сосед").ok, "идентификатор с путём принят");
    assert.ok(!ms.missionDelete(wd, "").ok, "пустой идентификатор принят");
    assert.ok(!ms.missionDelete(wd, "20990101-0000-no-such").ok, "несуществующая миссия «удалена»");
    const d = ms.missionDelete(wd, id);
    assert.ok(d.ok, "missionDelete: " + (d.error || ""));
    assert.ok(!fs.existsSync(dir), "папка миссии осталась на диске");
    assert.ok(!ms.missionActive(wd), "удалённая миссия всё ещё считается незакрытой");
    // Удаляем ровно миссию: рабочая папка агента остаётся на месте.
    assert.ok(fs.existsSync(path.join(wd, ".agent")), "удаление миссии снесло всю папку .agent");
  });

  await test("миссии: шаг отмечает план, незапланированное не теряется, журнал растёт", () => {
    const wd = tmpdir("mission-step-");
    const r = ms.missionCreate(wd, { goal: "Порядок в файлах", steps: ["Найти дубли", "Удалить дубли"], ts: DAY });
    const id = r.mission.id;
    const s1 = ms.missionStep(wd, id, { done: "Найти дубли", next: "Удалить дубли" });
    assert.ok(s1.ok, "missionStep: " + (s1.error || ""));
    assert.strictEqual(s1.progress.done, 1);
    assert.strictEqual(s1.mission.next, "Удалить дубли");
    assert.strictEqual(s1.mission.steps[1].state, "doing", "следующий шаг не переведён в работу");
    const s2 = ms.missionStep(wd, id, { done: "Прибрал папку загрузок" });
    assert.ok(s2.mission.steps.some((s) => s.title === "Прибрал папку загрузок" && s.state === "done"), "незапланированный шаг потерян");
    const s3 = ms.missionStep(wd, id, { fail: "Удалить дубли", note: "нет прав" });
    assert.strictEqual(s3.progress.failed, 1, "провал шага не отмечен");
    assert.strictEqual(s3.mission.steps[1].note, "нет прав");
    assert.ok(!ms.missionStep(wd, "нет-такой", { done: "x" }).ok, "шаг у несуществующей миссии прошёл молча");
    const j = ms.missionJournal(wd, id, { limit: 20 });
    assert.ok(j.length >= 4, "журнал пуст или короток: " + j.length);
    assert.ok(j.every((e) => e.ts > 0 && e.text), "в журнале есть строки без времени или текста");
    assert.ok(ms.missionJournalText(wd, id).indexOf("Дальше: Удалить дубли") >= 0, "в журнал не попал следующий шаг");
    assert.ok(ms.missionCounters(wd, id, { rounds: 25, batches: 1, tokens: 100 }).ok, "счётчики миссии не пишутся");
    assert.ok(!ms.missionCounters(wd, "нет-такой", { rounds: 1 }).ok, "счётчики у несуществующей миссии");
  });

  await test("миссии: секреты из переписки не оседают в файлах миссии", () => {
    const wd = tmpdir("mission-secret-");
    const KEY = "sk-" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    const r = ms.missionCreate(wd, { goal: "Починить интеграцию, ключ " + KEY, steps: ["Проверить ключ " + KEY], ts: DAY });
    const id = r.mission.id;
    ms.missionNote(wd, id, "note", "в логах светится " + KEY);
    const files = ["mission.json", "journal.md", "journal.jsonl"].map((f) => path.join(wd, ".agent", "missions", id, f));
    for (const f of files) {
      const body = fs.readFileSync(f, "utf8");
      assert.ok(body.indexOf(KEY) === -1, "ключ осел в " + path.basename(f));
    }
    assert.ok(fs.readFileSync(files[0], "utf8").indexOf("[секрет скрыт]") >= 0, "секрет не замаскирован, а просто потерян");
  });

  await test("миссии: закрытие пишет отчёт, шаги в работе закрываются вместе с миссией", () => {
    const wd = tmpdir("mission-finish-");
    const r = ms.missionCreate(wd, { goal: "Собрать отчёт за месяц", steps: ["Собрать данные", "Свести таблицу"], ts: DAY });
    const id = r.mission.id;
    ms.missionStep(wd, id, { done: "Собрать данные", next: "Свести таблицу" });
    const fin = ms.missionFinish(wd, id, { status: "done", report: "Отчёт готов: 12 страниц." });
    assert.ok(fin.ok, "missionFinish: " + (fin.error || ""));
    assert.strictEqual(fin.mission.status, "done");
    assert.strictEqual(fin.mission.steps[1].state, "done", "шаг «в работе» не закрылся вместе с миссией");
    const rep = fs.readFileSync(path.join(wd, ".agent", "missions", id, "report.md"), "utf8");
    assert.ok(rep.indexOf("Отчёт готов") >= 0, "в отчёте нет итога");
    assert.ok(rep.indexOf("**План:** 2 из 2") >= 0, "в отчёте нет прогресса по плану");
    assert.strictEqual(ms.missionActive(wd), null, "закрытая миссия считается незакрытой");
    assert.ok(ms.missionNote(wd, id, "note", "после закрытия").ok, "в закрытую миссию нельзя дописать журнал");
    // Приборка: свежие миссии остаются на месте.
    assert.deepStrictEqual(ms.missionPrune(wd), { kept: 1, removed: 0 });
  });

  await test("миссии: текст продолжения несёт цель, план и хвост журнала", () => {
    const wd = tmpdir("mission-resume-");
    const r = ms.missionCreate(wd, { goal: "Привести в порядок смету", steps: ["Собрать цифры", "Свести смету"], ts: DAY });
    const id = r.mission.id;
    ms.missionStep(wd, id, { done: "Собрать цифры", next: "Свести смету" });
    const txt = ms.missionResumeText(ms.missionLoad(wd, id), ms.missionJournalText(wd, id, { limit: 6 }));
    assert.ok(txt.indexOf("Привести в порядок смету") >= 0, "в тексте продолжения нет цели");
    assert.ok(txt.indexOf("Свести смету") >= 0, "в тексте продолжения нет плана");
    assert.ok(txt.indexOf("Хвост журнала") >= 0, "в тексте продолжения нет журнала");
    assert.ok(txt.indexOf(id) >= 0, "в тексте продолжения нет пути к файлам миссии");
    assert.strictEqual(ms.missionResumeText(null, ""), "", "продолжение пустой миссии не пусто");
  });

  await test("миссии: задачи и контекст лежат рядом с проектом и чистятся отдельно", () => {
    const wd = tmpdir("mission-mirror-");
    const r = ms.missionCreate(wd, { goal: "Работа", ts: DAY });
    const id = r.mission.id;
    assert.ok(ms.tasksMirror(wd, "# Дела\n\n- Позвонить в банк").ok, "зеркало дел не записалось");
    assert.ok(ms.contextMirror(wd, DAY, "Памятка: разобрали почту").ok, "зеркало контекста не записалось");
    assert.ok(ms.contextMirror(wd, DAY, "Памятка вторая").ok, "вторая памятка за день не дописалась");
    const day = path.join(wd, ".agent", "context", "2026-09-15.md");
    const body = fs.readFileSync(day, "utf8");
    assert.ok(body.indexOf("разобрали почту") >= 0 && body.indexOf("Памятка вторая") >= 0, "памятки за день не собраны в один файл");
    const st = ms.mirrorStatus(wd);
    assert.ok(st.exists, "статус папки не видит созданную папку");
    assert.ok(st.tasks && st.tasks.bytes > 0, "статус папки не видит список дел");
    assert.deepStrictEqual(st.contextDays, ["2026-09-15.md"]);
    assert.strictEqual(st.missions, 1, "статус папки не считает миссии");
    assert.ok(st.bytes > 0, "размер папки работы не считается");
    assert.ok(!ms.tasksMirror("", "x").ok, "зеркало записалось без рабочей папки");
    assert.ok(!ms.contextMirror(wd, DAY, "   ").ok, "пустая памятка записалась");
    const cl = ms.mirrorClear(wd);
    assert.ok(cl.ok && cl.removed.length === 2, "очистка зеркал: " + JSON.stringify(cl));
    assert.ok(!fs.existsSync(path.join(wd, ".agent", "tasks.md")), "tasks.md остался после очистки");
    assert.ok(!fs.existsSync(path.join(wd, ".agent", "context")), "context/ остался после очистки");
    assert.ok(fs.existsSync(path.join(wd, ".agent", "missions", id, "mission.json")), "очистка зеркал снесла работу агента");
    assert.deepStrictEqual(ms.mirrorClear(""), { ok: false, error: "Не задана рабочая папка." });
  });

  await test("миссии: файлы работы пишутся по своей галочке, а не по памяти диалогов", () => {
    const main = mainOnlySrc();
    // Схема настроек вынесена в src/settings-store.js (этап B, часть 5).
    const store = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
    // Каналы файлов работы вынесены в src/mission-ipc.js (этап B, часть 1).
    const missionIpc = fs.readFileSync(path.join(ROOT, "src", "mission-ipc.js"), "utf8");
    // Зеркала решают своё условие: иначе контекст и задачи не попадали на диск,
    // пока пользователь не включит «Память диалогов» (это про другое — про поиск по дням).
    // Запись памятки при сжатии контекста вынесена из оболочки в модуль памяти
    // диалогов (заход 3): условия — и их ПОРЯДОК — спрашиваем у тела функции, где она
    // теперь живёт. Проверка стала строже: раньше она видела только наличие строк.
    const memSrc = fs.readFileSync(path.join(ROOT, "src", "memory-ipc.js"), "utf8");
    const memoAt = memSrc.indexOf("function saveContextMemo(");
    assert.ok(memoAt > 0, "запись памятки пропала из модуля памяти диалогов");
    const memoBody = memSrc.slice(memoAt, memSrc.indexOf("\n}\n", memoAt));
    assert.ok(/if \(settings\.agentWorkFiles !== false\) \{\n\s+try \{\n\s+missionStore\.contextMirror/.test(memoBody), "зеркало контекста зависит не от своей галочки");
    assert.ok(/if \(!settings\.contextMemory\) return null;/.test(memoBody), "дневник памяти больше не спрашивает свою галочку");
    assert.ok(
      memoBody.indexOf("agentWorkFiles") < memoBody.indexOf("contextMemory"),
      "условия в записи памятки слиты или переставлены: зеркало решается до дневника"
    );

    // Зеркало дел живёт в src/tasks-reminders.js (часть 24): у main.js спрашиваем
    // только проводку, а условие галочки — у модуля.
    const remindersSrc = fs.readFileSync(path.join(ROOT, "src", "tasks-reminders.js"), "utf8");
    assert.ok(/if \(s\.agentWorkFiles === false\) return;/.test(remindersSrc), "зеркало дел не слушает галочку файлов работы");
    assert.ok(!/if \(!s\.longWork\) return;/.test(main), "зеркало дел всё ещё привязано к «долгой работе»");
    assert.ok(/agentWorkFiles: true/.test(store), "файлы работы выключены по умолчанию");
    for (const ch of ["agentfiles:status", "agentfiles:openDir", "agentfiles:clear"]) {
      assert.ok(missionIpc.indexOf('ipcMain.handle("' + ch + '"') >= 0, "нет канала " + ch);
    }
    assert.ok(missionIpc.indexOf("missionStore.mirrorStatus") >= 0, "состояние папки не считается модулем миссий");
  });

  await test("дела и миссии: модуль собирается, каналы на месте, missionClaim ходит мостом live", async () => {
    // Блок дел, миссий и файлов работы агента вынесен из main.js в src/mission-ipc.js
    // (этап B, часть 1). Собираем НАСТОЯЩИЙ модуль его же фабрикой и водим по каналам.
    const { registerMissionIpc } = require(path.join(ROOT, "src", "mission-ipc.js"));
    const handlers = new Map();
    const calls = { emitted: 0, armed: 0, saved: [], notes: [], finished: [], deleted: [], shown: "", opened: "" };
    let claim = "";
    const dir = path.join(os.tmpdir(), "mission-ipc-test");
    const active = {
      id: "m1", title: "Разобрать 10 писем", status: "paused", createdAt: 1, updatedAt: 2,
      steps: ["a", "b"], rounds: 3, metrics: { tokens: 100 }, role: "manager", chatId: "c1",
    };
    const missionStore = {
      agentRoot: (d) => path.join(d, ".agent"),
      missionActive: () => active,
      missionList: () => [active],
      missionProgress: (m) => ({ done: 1, total: m.steps.length, percent: 50, finished: false }),
      missionJournal: () => [{ ts: 1, text: "шаг" }],
      missionLoad: (d, id) => (id === "m1" ? active : null),
      missionSave: (d, rec) => { calls.saved.push(rec.status); return { ok: true }; },
      missionNote: (d, id, kind, text) => { calls.notes.push(text); return { ok: true }; },
      missionFinish: (d, id, opts) => { calls.finished.push({ id: id, opts: opts }); return { ok: true, mission: { id: id, status: "stopped" } }; },
      missionDelete: (d, id) => { calls.deleted.push(id); return { ok: true, id: id }; },
      missionDirOf: (d, id) => path.join(d, ".agent", "missions", String(id)),
      missionResumeText: (rec, journal) => "ПРОДОЛЖИ " + rec.id + " (" + journal + ")",
      missionJournalText: () => "журнал",
      mirrorStatus: (d) => ({ dir: d, root: path.join(d, ".agent"), exists: true, tasks: { bytes: 10, mtime: 1 }, contextDays: ["2026-09-17.md"], missions: 2, bytes: 34 }),
      mirrorClear: () => ({ ok: true, removed: ["tasks.md", "context"] }),
    };
    const agentStore = {
      tasksBoard: () => ({ ok: true, groups: [{ id: "today", title: "Сегодня", tasks: [] }], done: [], summary: { active: 0, total: 0 } }),
      tasksList: () => ({ ok: true, tasks: [] }),
      tasksAdd: () => ({ ok: true, key: "t1" }),
      tasksUpdate: () => ({ ok: true }),
      tasksDone: () => ({ ok: true }),
      tasksDelete: () => ({ ok: true }),
      tasksAutoAck: () => ({ ok: true }),
      tasksAutoRearm: () => ({ ok: true }),
    };
    const mod = registerMissionIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      fs: { mkdirSync: () => {} },
      shell: { showItemInFolder: (p) => { calls.shown = p; }, openPath: async (p) => { calls.opened = p; return ""; } },
      agentStore: agentStore,
      missionStore: missionStore,
      loadSettings: () => ({ longWork: true, workingDir: dir, agentWorkFiles: true }),
      agentWorkDir: (s) => (s && s.workingDir) || dir,
      // Дела читаются в папке дел, а не в папке приложения (часть 44).
      tasksDataDir: () => path.join(dir, "tasks"),
      emitTasksChanged: () => { calls.emitted++; },
      armTaskWake: () => { calls.armed++; },
      live: { missionClaim: () => claim, setMissionClaim: (v) => { claim = v; } },
    });

    // 1. Каналы: ровно те, за которыми ходит окно и телефон.
    const channels = [...handlers.keys()].sort();
    assert.deepStrictEqual(channels, [
      "agentfiles:clear", "agentfiles:openDir", "agentfiles:status",
      "mission:delete", "mission:finish", "mission:list", "mission:open",
      "mission:pause", "mission:resume", "mission:state", "mission:stop",
      "tasks:add", "tasks:auto-ack", "tasks:auto-rearm", "tasks:board",
      "tasks:delete", "tasks:done", "tasks:list", "tasks:update",
    ], "набор каналов модуля изменился: " + channels.join(", "));
    assert.strictEqual(typeof mod.missionStateForUi, "function", "модуль не отдаёт состояние миссий");
    assert.strictEqual(typeof mod.agentFilesStatus, "function", "модуль не отдаёт состояние папки работы");

    // 2. Состояние для панели: активная миссия, прогресс, журнал, список, прогон.
    const st = await handlers.get("mission:state")();
    assert.strictEqual(st.enabled, true, "долгая работа не видна панели");
    assert.strictEqual(st.active.id, "m1", "активная миссия не отдана панели");
    assert.strictEqual(st.journal.length, 1, "журнал миссии не отдан");
    assert.strictEqual(st.list.length, 1, "список миссий пуст");
    assert.strictEqual(st.list[0].steps, 2, "число шагов не посчитано");
    assert.strictEqual(st.list[0].tokens, 100, "метрики миссии потеряны");
    assert.strictEqual(st.running, !!global.__agentRunning, "признак прогона не отдан");
    assert.strictEqual(st.paused, !!global.__agentPauseRequested, "признак паузы не отдан");

    // 3. «▶ Продолжить»: миссия возвращается в работу, а id уходит в живое значение main.js.
    const resumed = await handlers.get("mission:resume")();
    assert.strictEqual(resumed.ok, true, "миссию не удалось продолжить");
    assert.strictEqual(claim, "m1", "просьба человека не запомнена для следующего прогона");
    assert.deepStrictEqual(calls.saved, ["active"], "миссия не вернулась в работу на диске");
    assert.ok(/Человек вернул миссию/.test(calls.notes[0] || ""), "в журнал не записано, кто продолжил: " + calls.notes[0]);
    assert.ok(resumed.text.indexOf("ПРОДОЛЖИ m1") === 0, "текст продолжения потерян: " + resumed.text);

    // 4. Удаление: во время прогона по этой же миссии — отказ, иначе — удаляем.
    global.__agentRunning = true;
    const refused = await handlers.get("mission:delete")(null, "m1");
    assert.strictEqual(refused.ok, false, "миссия удалена во время прогона по ней");
    assert.ok(/Стоп|Закрыть/.test(refused.error || ""), "отказ не объясняет, что делать: " + refused.error);
    global.__agentRunning = false;
    const del = await handlers.get("mission:delete")(null, "m1");
    assert.strictEqual(del.ok, true, "миссию не удалось удалить");
    assert.deepStrictEqual(calls.deleted, ["m1"], "удаление ушло не с тем id");
    assert.strictEqual(claim, "", "после удаления просьба человека осталась висеть");

    // 5. Дела: изменение подтягивает будильник и сообщает окну.
    const added = await handlers.get("tasks:add")(null, { title: "Позвонить" });
    assert.strictEqual(added.ok, true, "дело не добавилось");
    assert.strictEqual(calls.emitted, 1, "окно не извещено об изменении дел");
    assert.strictEqual(calls.armed, 1, "будильник на срок не перезаряжен");
    await handlers.get("tasks:list")(null, {});
    assert.strictEqual(calls.emitted, 1, "чтение дел дёргает окно");

    // 6. Файлы работы: состояние, открытие папки и очистка зеркал с понятным текстом.
    const files = await handlers.get("agentfiles:status")();
    assert.strictEqual(files.exists, true, "состояние папки работы не посчитано");
    assert.deepStrictEqual(files.contextDays, ["2026-09-17.md"], "дни контекста потеряны");
    const opened = await handlers.get("agentfiles:openDir")(null, "m2");
    assert.ok(/missions[\\/]m2$/.test(calls.opened), "открылась не папка миссии: " + calls.opened);
    assert.strictEqual(opened.ok, true, "папка миссии не открылась");
    const cleared = await handlers.get("agentfiles:clear")();
    assert.strictEqual(cleared.ok, true, "зеркала не очистились");
    assert.ok(/Зеркала очищены: tasks\.md, context/.test(cleared.message || ""), "текст очистки невнятный: " + cleared.message);
    assert.ok(/Миссии не затронуты/.test(cleared.message || ""), "текст очистки не успокаивает про миссии");

    // 7. Проводка в main.js: живое значение обязано идти мостом — и чтением, и записью.
    // Копия «застыла» бы на пустой строке, и продолженная миссия снова не подхватилась бы.
    const mainSrc = mainOnlySrc();
    const wiringAt = mainSrc.indexOf('const { registerMissionIpc } = require("./mission-ipc.js");');
    assert.ok(wiringAt > 0, "main.js не собирает модуль дел и миссий");
    const wiring = mainSrc.slice(wiringAt, mainSrc.indexOf("\n});", wiringAt));
    for (const dep of ["ipcMain,", "fs,", "shell,", "agentStore,", "missionStore,", "loadSettings,",
      "agentWorkDir,", "tasksDataDir,", "emitTasksChanged,", "armTaskWake,",
      "missionClaim: () => missionClaim,", "setMissionClaim: (v) => { missionClaim = v; },"]) {
      assert.ok(wiring.includes(dep), "в проводку модуля не передан " + dep);
    }
    // И самого кода дел и миссий в main.js больше нет — только проводка.
    for (const gone of ['ipcMain.handle("tasks:board"', 'ipcMain.handle("mission:state"', "function missionStateForUi"]) {
      assert.strictEqual(mainSrc.indexOf(gone), -1, "код дел и миссий остался в main.js: " + gone);
    }
  });

  await test("долгая работа: батчи, авто-продолжение и мягкие стопы вместо обрыва на 26-м раунде", () => {
    const main = mainOnlySrc();
    // Схема настроек вынесена в src/settings-store.js (этап B, часть 5).
    const store = fs.readFileSync(path.join(ROOT, "src", "settings-store.js"), "utf8");
    // Часть долгой работы (каналы дел и миссий) вынесена в src/mission-ipc.js.
    const missionIpc = fs.readFileSync(path.join(ROOT, "src", "mission-ipc.js"), "utf8");
    // Правила батчей, журнала и предохранителей живут в src/run-mission.js
    // (этап B, часть 14): спрашиваем модуль, а у оболочки — границу батча.
    const missionRun = fs.readFileSync(path.join(ROOT, "src", "run-mission.js"), "utf8");
    // Граница батча и закрытие миссии с части 19б живут в src/run-batch.js.
    const batchRun = fs.readFileSync(path.join(ROOT, "src", "run-batch.js"), "utf8");
    // Сам цикл прогона (батчи, раунды, пауза) с части 25 живёт в src/run-ai.js.
    const chatSrc = fs.readFileSync(path.join(ROOT, "src", "run-ai.js"), "utf8");
    assert.ok(chatSrc.indexOf("for (let batch = 1; ; batch++)") >= 0, "нет внешнего цикла батчей");
    assert.ok(/const afterBatch = await mission\.afterBatch\(\);/.test(batchRun), "граница батча не считается");
    assert.ok(/if \(!afterBatch\.continue\) \{/.test(batchRun), "конец батча не продолжает и не завершает работу");
    assert.ok(batchRun.indexOf("if (afterBatch.closed)") >= 0, "закрытая миссия рвётся ошибкой счётчика раундов");
    assert.ok(/const after = await batchCtl\.afterRound\(canonical\);/.test(chatSrc), "прогон не спрашивает границу батча");
    assert.ok(chatSrc.indexOf("if (after.kind === \"break\") break;") >= 0, "выход из цикла батчей потерялся");
    assert.ok(missionRun.indexOf('if (r.status !== "active") return { continue: false, closed: true };') >= 0, "модуль не различает закрытую миссию");
    assert.ok(/state\.errorContinues < state\.limits\.autoContinues/.test(missionRun), "сбой провайдера обрывает долгую работу");
    assert.ok(missionRun.indexOf("longWorkAutoContinue") >= 0, "нет запаса авто-продолжений");
    assert.ok(missionRun.indexOf("MISSION_AUTO_ROUND") >= 0, "миссия не заводится сама на длинной работе");
    assert.ok(missionRun.indexOf("signatures") >= 0, "нет защиты от зацикливания на одном вызове");
    assert.ok(missionRun.indexOf("MISSION_JOURNAL_PER_BATCH") >= 0, "журнал может превратиться в поток");
    assert.ok(/longWork: true/.test(store), "долгая работа выключена по умолчанию");
    assert.ok(/longWorkHours: 8/.test(store), "рабочий день по умолчанию не 8 часов");
    // Текст продолжения собирает канал mission:resume, а он живёт в src/mission-ipc.js.
    assert.ok(missionIpc.indexOf("missionResumeText") >= 0, "нет продолжения миссии с места остановки");
    assert.ok(chatSrc.indexOf("global.__agentPauseRequested") >= 0, "нет паузы у долгой работы");
    // Жёсткий лимит раундов остался только для короткой работы и режима плана.
    assert.ok(/const maxRounds = planMode \? 3 : 25;/.test(chatSrc), "лимит раундов отрезка изменился");
    // Оболочка цикл раундов больше не держит: он переехал целиком.
    assert.strictEqual(main.indexOf("for (let round = 0; round < maxRounds; round++)"), -1, "цикл раундов остался в оболочке");
  });

  await test("миссии: инструменты, панель, настройки и мост на месте", () => {
    const main = mainOnlySrc();
    const tools = toolsHomeSrc(); // миссии и план — уже своим модулем (часть 40, заход 6c)
    const policy = fs.readFileSync(path.join(ROOT, "src", "tool-policy.js"), "utf8");
    const core = coreData(); // ядро + его данные: prompts.js, tool-schemas.js
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    const pre = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    const mob = fs.readFileSync(path.join(ROOT, "src", "renderer", "mobile-api.js"), "utf8");
    for (const t of ["missionStart", "missionStep", "missionStatus", "missionFinish"]) {
      assert.ok(hasTool(tools, t), "нет инструмента агента " + t);
    }
    assert.ok(policy.indexOf('"mission.write"') >= 0 && policy.indexOf('"mission.read"') >= 0, "миссии вне политики прав");
    assert.ok(core.indexOf('"missionStart"') >= 0, "миссий нет в группах инструментов");
    assert.ok(/мисси/.test(core), "в промпте нет правил про миссии");
    for (const id of [
      "sp-mission", "ms-steps", "ms-journal", "ms-list", "ms-card", "ms-meta",
      "btn-mission-pause", "btn-mission-resume", "btn-mission-stop", "btn-mission-finish", "btn-mission-folder", "btn-mission-refresh",
      "rail-mission", "sp-mission-dot", "s-long-work", "s-long-hours", "s-long-rounds", "s-long-continue",
      "s-agent-files", "btn-agent-files-open", "btn-agent-files-clear", "agent-files-status",
    ]) {
      assert.ok(html.indexOf('id="' + id + '"') >= 0, "в интерфейсе нет " + id);
    }
    assert.ok(app.indexOf("renderAgentFilesStatus") >= 0, "настройки окна не показывают папку работы");
    assert.ok(uiAll().indexOf("agentWorkFiles") >= 0, "интерфейс не сохраняет галочку файлов работы");
    assert.ok(app.indexOf("agentFilesClear") >= 0 && app.indexOf("agentFilesOpen") >= 0, "кнопки папки работы ни к чему не привязаны");
    for (const k of ["missionState", "missionPause", "missionStop", "missionResume", "missionOpen", "agentFilesStatus"]) {
      assert.ok(pre.indexOf(k) >= 0, "мост не отдаёт " + k);
    }
    assert.ok(mob.indexOf('"mission:state"') >= 0 && mob.indexOf('"agentfiles:status"') >= 0, "с телефона не видно работу агента");
    assert.ok(/mission:|agentfiles:/.test(pre), "мост не знает каналов миссий");
    // Список дел тоже виден файлом: иначе «файлы работы» — только про миссии.
    const taskReminderSrc = fs.readFileSync(path.join(ROOT, "src", "tasks-reminders.js"), "utf8");
    assert.ok((main + taskReminderSrc).indexOf("missionStore.tasksMirror") >= 0, "список дел не зеркалится файлом");
  });
}

module.exports = {
  testTasksMission,
  testMissionGuard,
  testMissions,
  testTasks,
};

"use strict";

/* ── Охрана живого интерфейса (field-guard.js) ───────────────────────────────
   Запуск: node test/field-guard.test.js   (входит и в общий `npm test`)

   Жалоба, ради которой это сделано: «кликаю по полю — курсор не встаёт, текст не
   печатается, через какое-то время само отпускает». Первая версия охраны умела
   только одно — вернуть фокус, если клик съел слой поверх поля. Но клик может не
   дать фокуса и иначе, и тогда охрана молчит. Здесь проверяются все механизмы:

     • слой поверх поля перехватил клик (тост, обёртка);
     • `pointer-events: none` у поля или предка;
     • фокус у поля забрал кто-то другой — с именем виновника и стеком вызова;
     • окно приложения потеряло фокус (Electron) — DOM тут ни при чём;
     • плашка-декор поверх интерфейса больше не ест клики;
     • залипший режим перетаскивания снимается.

   И обратная сторона: живой клик по интерфейсу (кнопка, окно, само поле) охрана
   не трогает — иначе она сама стала бы поломкой. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
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

const FieldGuard = require(path.join(ROOT, "src", "renderer", "field-guard.js"));

// ── Игрушечный DOM ──────────────────────────────────────────────────────────
// Матчер задаётся вручную: в тесте важно не повторить CSS движка, а проверить
// решение модуля — какие селекторы он спрашивает и что делает с ответом.
function fakeEl(tag, opts) {
  opts = opts || {};
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeName: String(tag).toUpperCase(),
    nodeType: 1,
    id: opts.id || "",
    className: opts.className || "",
    value: "",
    focused: 0,
    disabled: !!opts.disabled,
    isConnected: opts.isConnected === undefined ? true : opts.isConnected,
    parentElement: null,
    style: opts.style || {},
    _match: opts.match || function () { return false; },
    _inside: opts.inside || function () { return false; },
    _rect: opts.rect || { width: 320, height: 40 },
  };
  el.classList = { length: 0 };
  for (const c of el.className.split(/\s+/).filter(Boolean).slice(0, 2)) {
    el.classList[el.classList.length++] = c;
  }
  el.matches = (sel) => !!(el._match && el._match(sel));
  el.querySelector = (sel) => (el._inside(sel) ? { tagName: "SPAN" } : null);
  el.getBoundingClientRect = () => el._rect;
  el.closest = (sel) => {
    let cur = el;
    while (cur) {
      if (cur._match && cur._match(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  el.focus = () => {
    el.focused++;
    if (el.ownerDocument) el.ownerDocument.activeElement = el;
  };
  return el;
}

// Слой, который ничего не берёт на себя (тост, прозрачная обёртка, пустой оверлей).
const layerEl = (tag, opts) => fakeEl(tag || "div", Object.assign({ match: () => false }, opts || {}));
// Настоящее поле ввода.
const fieldEl = (tag) => fakeEl(tag || "textarea", { match: (sel) => sel === FieldGuard.FIELD_SEL });
// Кнопка/ссылка — её клик охрана не перехватывает. Матчер точный: FIELD_SEL тоже
// содержит слово "button" (в :not(...)), и подстрока склеила бы кнопку с полем.
const actionEl = () => fakeEl("button", { match: (sel) => sel === FieldGuard.ACTION_SEL });
// Окно или меню поверх страницы.
const overlayEl = () => fakeEl("div", { match: (sel) => sel === FieldGuard.OVER_SEL });

function fakeEvent(target, opts) {
  opts = opts || {};
  return {
    target,
    button: opts.button === undefined ? 0 : opts.button,
    clientX: opts.clientX || 10,
    clientY: opts.clientY || 20,
    defaultPrevented: !!opts.defaultPrevented,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

function harness(stack, styleOf, docOpts, installOpts) {
  const handlers = {};
  const timers = [];
  const doc = Object.assign(
    {
      activeElement: null,
      hasFocus: () => true,
      defaultView: {
        getComputedStyle: (el) => ({ pointerEvents: styleOf ? styleOf(el) : "auto" }),
        // Проверка после клика отложенная (браузер ставит фокус уже после
        // обработчиков mousedown), поэтому в тесте нужен управляемый таймер.
        setTimeout: (fn) => timers.push(fn),
      },
      addEventListener: (name, fn) => {
        handlers[name] = fn;
      },
      removeEventListener: () => {},
      elementsFromPoint: () => stack || [],
    },
    docOpts || {}
  );
  // Связь узла с документом: поле, получив фокус, должно оказаться в activeElement.
  for (const el of stack || []) if (el && !el.ownerDocument) el.ownerDocument = doc;
  const reports = [];
  const off = FieldGuard.install(doc, Object.assign({ report: (info) => reports.push(info) }, installOpts || {}));
  return {
    doc,
    handlers,
    reports,
    off,
    flush() {
      while (timers.length) timers.shift()();
    },
  };
}

// Список классов для поддельного body: снимаем/ставим как настоящий classList.
function fakeClassList(names) {
  const list = names.slice();
  return {
    length: list.length,
    contains: (n) => list.indexOf(n) !== -1,
    add: (n) => {
      if (list.indexOf(n) === -1) list.push(n);
    },
    remove: (n) => {
      const i = list.indexOf(n);
      if (i !== -1) list.splice(i, 1);
    },
    has: (n) => list.indexOf(n) !== -1,
  };
}

(async () => {
  console.log("\nОхрана живого интерфейса");

  await test("охрана полей: модуль подключён перед app.js и умеет свои решения", () => {
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const boot = fs.readFileSync(path.join(ROOT, "src", "renderer", "bootstrap.js"), "utf8");
    // Тег в разметке — основное место; загрузчик в bootstrap.js — страховка для
    // сборок, где тег не доехал (крупный index.html правится инструментами не всегда).
    assert.ok(html.indexOf('src="field-guard.js"') !== -1, "в index.html нет тега field-guard.js");
    assert.ok(
      html.lastIndexOf('src="field-guard.js"') < html.lastIndexOf('src="app.js"'),
      "field-guard.js подключён после app.js — охрана встанет позже первого клика"
    );
    assert.ok(/field-guard\.js/.test(boot), "в bootstrap.js нет загрузчика охраны полей");
    for (const fn of ["install", "stolenFieldClick", "deadField", "stolenFocus", "isDecoration", "describe"]) {
      assert.strictEqual(typeof FieldGuard[fn], "function", "в модуле нет " + fn);
    }
    const el = fakeEl("div", { id: "sp-tasks", className: "tk-list extra" });
    // В отчёт идут тег, id и до двух классов: имена короче экрана, а виновника
    // по ним видно однозначно (div#sp-tasks.tk-list.extra).
    assert.strictEqual(FieldGuard.describe(el), "div#sp-tasks.tk-list.extra", "имя элемента для отчёта собирается неверно");
    assert.strictEqual(FieldGuard.describe(null), "?", "пустой элемент должен называться ?");
  });

  await test("охрана полей: тост или прозрачный слой поверх поля не съедает клик", () => {
    const field = fieldEl("textarea");
    const toast = layerEl("div", { className: "toast" });
    const stack = [toast, field];
    const found = FieldGuard.stolenFieldClick(toast, stack);
    assert.ok(found, "клик поверх поля не распознан");
    assert.strictEqual(found.field, field, "вернулось не то поле");
    assert.strictEqual(found.who, toast, "виновник назван неверно");

    const h = harness(stack);
    const e = fakeEvent(toast);
    h.handlers.mousedown(e);
    assert.strictEqual(field.focused, 1, "фокус не вернулся в поле");
    assert.ok(e.prevented, "клик не погашен — под полем могло сработать чужое действие");
    assert.ok(e.stopped, "клик не остановлен");
    assert.strictEqual(h.reports.length, 1, "о перехвате не рассказали ровно один раз");
    assert.ok(/toast/.test(FieldGuard.describe(h.reports[0].who)), "в отчёте нет имени виновника");
    assert.ok(h.reports[0].why.indexOf("перехватил") !== -1, "в отчёте нет причины");
  });

  await test("охрана полей: живой клик по интерфейсу не трогаем", () => {
    const button = actionEl();
    const fieldUnder = fieldEl("input");
    assert.strictEqual(FieldGuard.stolenFieldClick(button, [button]), null, "клик по кнопке перехвачен");
    // Кнопка ПОВЕРХ поля (попап ролей, панель плана над композером): клик за кнопкой,
    // а не за полем под ней — иначе охрана сама ломала бы кнопки.
    assert.strictEqual(
      FieldGuard.stolenFieldClick(button, [button, fieldUnder]),
      null,
      "клик по кнопке поверх поля перехвачен"
    );
    const overlay = overlayEl();
    assert.strictEqual(
      FieldGuard.stolenFieldClick(overlay, [overlay, fieldUnder]),
      null,
      "клик по окну поверх поля перехвачен"
    );
    const field = fieldEl("textarea");
    assert.strictEqual(FieldGuard.stolenFieldClick(field, [field]), null, "клик по самому полю перехвачен");
    assert.strictEqual(FieldGuard.stolenFieldClick(null, []), null, "пустая цель не должна ломать охрану");

    // Тот же случай целиком, через подписку: кнопка поверх поля остаётся кнопкой.
    const hBtn = harness([button, fieldUnder]);
    const eBtn = fakeEvent(button);
    assert.strictEqual(hBtn.handlers.mousedown(eBtn), null, "нажатие кнопки поверх поля перехвачено охраной");
    assert.strictEqual(fieldUnder.focused, 0, "охрана увела фокус из-под кнопки в поле");
    assert.ok(!eBtn.prevented, "охрана погасила нажатие кнопки");

    const h = harness([button]);
    const e = fakeEvent(button);
    assert.strictEqual(h.handlers.mousedown(e), null, "обычный клик не прошёл как обычный");
    assert.ok(!e.prevented && !e.stopped, "обычный клик погашен охраной");
    assert.strictEqual(h.reports.length, 0, "охрана рассказала о несуществующем перехвате");

    // Правая кнопка и клик, который уже кто-то обработал, — не наше дело.
    assert.strictEqual(h.handlers.mousedown(fakeEvent(field, { button: 2 })), null, "правая кнопка перехвачена");
    assert.strictEqual(
      h.handlers.mousedown(fakeEvent(field, { defaultPrevented: true })),
      null,
      "повторная обработка уже погашенного клика"
    );
  });

  await test("охрана полей: поле с pointer-events: none оживает и называет виновника", () => {
    const outer = layerEl("div", { id: "welcome", className: "welcome" });
    const middle = layerEl("div");
    const field = fieldEl("textarea");
    middle.parentElement = outer;
    field.parentElement = middle;
    const none = (el) => (el === outer || el === middle || el === field ? "none" : "auto");
    const dead = FieldGuard.deadField(field, (el) => ({ pointerEvents: none(el) }));
    assert.ok(dead, "поле с pointer-events: none не распознано");
    assert.strictEqual(dead.field, field, "вернулось не то поле");
    assert.strictEqual(dead.who, outer, "виновник — не самый верхний слой с pointer-events: none");
    assert.ok(dead.why.indexOf("pointer-events: none") === 0, "в причине нет pointer-events: none");

    const h = harness([field], none);
    const e = fakeEvent(field);
    h.handlers.mousedown(e);
    assert.strictEqual(field.focused, 1, "фокус не отдан полю с pointer-events: none");
    assert.ok(e.prevented && e.stopped, "клик по «мёртвому» полю не погашен");
    assert.strictEqual(h.reports.length, 1, "о мёртвом поле не рассказали");

    // Здоровое поле под живым контейнером охрана не трогает.
    const alive = harness([field], () => "auto");
    assert.strictEqual(alive.handlers.mousedown(fakeEvent(field)), null, "здоровое поле признано мёртвым");
    assert.strictEqual(FieldGuard.deadField(field, null), null, "без геттера стилей решения быть не может");
  });

  await test("охрана полей: рассказ не спамит, а клики продолжают работать", () => {
    const field = fieldEl("textarea");
    const toast = layerEl("div");
    const h = harness([toast, field]);
    h.handlers.mousedown(fakeEvent(toast));
    h.handlers.mousedown(fakeEvent(toast));
    h.handlers.mousedown(fakeEvent(toast));
    assert.strictEqual(field.focused, 3, "повторные клики перестали возвращать фокус");
    assert.strictEqual(h.reports.length, 1, "охрана спамит отчётами");
    h.off();
  });

  await test("свидетель фокуса: клик по полю, у которого фокус забрали, называет вора и возвращает фокус", () => {
    const field = fieldEl("textarea");
    const thief = layerEl("div", { id: "sp-tasks", className: "tk-list" });
    const timers = [];
    // Окно с настоящим прототипом HTMLElement: только так работает свидетель
    // фокуса (он перехватывает .focus() на прототипе).
    const proto = { focus() {}, blur() {} };
    const h = harness([field], null, {
      body: { tagName: "BODY", nodeType: 1, children: [], classList: fakeClassList([]) },
      hasFocus: () => true,
      defaultView: {
        getComputedStyle: () => ({ pointerEvents: "auto" }),
        setTimeout: (fn) => timers.push(fn),
        HTMLElement: { prototype: proto },
      },
    });
    const e = fakeEvent(field);
    assert.strictEqual(h.handlers.mousedown(e), null, "клик по самому полю не должен гаситься");
    // Вор забрал фокус ПОСЛЕ клика — так выглядит перерисовка панели по таймеру:
    // узел зовёт focus(), и без свидетеля виновника не найти. Порядок тут не
    // формальность: клик берёт у свидетеля метку, а виновник — тот, кто звал
    // фокус после неё. Раньше тест делал наоборот (фокус до клика) и держался на
    // совпадении миллисекунд: на загруженной машине миллисекунда переключалась,
    // и стек виновника оказывался пустым — тест падал примерно раз из четырёх
    // полных прогонов.
    proto.focus.call(thief);
    h.doc.activeElement = thief;
    while (timers.length) timers.shift()(); // отложенная проверка фокуса, как в браузере
    assert.strictEqual(field.focused, 1, "фокус не вернулся в поле");
    assert.strictEqual(h.doc.activeElement, field, "activeElement не переехал в поле");
    assert.strictEqual(h.reports.length, 1, "о краже фокуса не рассказали");
    assert.ok(h.reports[0].why.indexOf("фокус забрал") === 0, "в причине нет имени вора: " + h.reports[0].why);
    assert.strictEqual(FieldGuard.describe(h.reports[0].who), "div#sp-tasks.tk-list", "виновник назван неверно");
    // Свидетель даёт главное: какая строка кода забрала фокус.
    assert.ok(h.reports[0].stack.length >= 1, "в отчёте нет стека вызова — виновника не найти по коду");
    assert.ok(
      h.reports[0].stack.some((f) => /field-guard\.test\.js/.test(f)),
      "в стеке нет строки, которая забрала фокус"
    );
    assert.ok(!e.prevented, "клик по своему полю охрана погасила — так ломается выделение мышью");
  });

  await test("свидетель фокуса: решения разбирают все случаи, а не только вора", () => {
    const field = fieldEl("textarea");
    const body = { tagName: "BODY", nodeType: 1 };
    // Фокус на месте — вмешиваться нельзя.
    assert.strictEqual(FieldGuard.stolenFocus(field, field, {}), null, "здоровое поле признано раненым");
    // Поле выключено: фокуса у него и не может быть, это не вор.
    const off = fieldEl("input");
    off.disabled = true;
    assert.strictEqual(FieldGuard.stolenFocus(off, body, { bodyEl: body }), null, "disabled поле считается кражей фокуса");
    // Поле перерисовали прямо под рукой — лечить нечего, узла уже нет.
    const gone = fieldEl("textarea");
    gone.isConnected = false;
    assert.strictEqual(FieldGuard.stolenFocus(gone, body, { bodyEl: body }), null, "исчезнувшее поле считается кражей");
    // Фокус ушёл в никуда: клик погасили или узел перерисовали.
    const nothing = FieldGuard.stolenFocus(field, body, { bodyEl: body });
    assert.ok(nothing && nothing.why.indexOf("в никуда") !== -1, "уход фокуса в пустоту не распознан");
    // Окно приложения не в фокусе: это Electron, DOM не виноват, лечится фокусом окна.
    const win = FieldGuard.stolenFocus(field, null, { windowFocused: false });
    assert.ok(win && win.windowFocused === false && /окно/.test(win.why), "потеря фокуса окна не распознана");
    // Обычный вор в DOM.
    const thief = layerEl("div", { id: "ms-journal" });
    const stole = FieldGuard.stolenFocus(field, thief, { bodyEl: body });
    assert.strictEqual(stole.who, thief, "вор в DOM не назван");
  });

  await test("свидетель фокуса: окно без фокуса лечится фокусом окна, а не полем", () => {
    const field = fieldEl("textarea");
    let windowFocused = 0;
    const timers = [];
    const h = harness([field], null, {
      body: { tagName: "BODY", nodeType: 1, children: [], classList: fakeClassList([]) },
      hasFocus: () => false,
      defaultView: {
        getComputedStyle: () => ({ pointerEvents: "auto" }),
        setTimeout: (fn) => timers.push(fn),
        focus: () => {
          windowFocused++;
        },
      },
    });
    h.handlers.mousedown(fakeEvent(field));
    while (timers.length) timers.shift()();
    assert.strictEqual(windowFocused, 1, "окно не попытались вернуть в фокус");
    assert.strictEqual(field.focused, 0, "вместо окна дёрнули фокус поля");
    assert.strictEqual(h.reports.length, 1, "о потере фокуса окна не рассказали");
    assert.ok(/окно приложения потеряло фокус/.test(h.reports[0].why), "причина названа неверно: " + h.reports[0].why);
  });

  await test("свидетель фокуса: печать с клавиатуры отменяет проверку и не тянет фокус назад", () => {
    const field = fieldEl("textarea");
    const other = fieldEl("input");
    const h = harness([field], null, { hasFocus: () => true });
    h.handlers.mousedown(fakeEvent(field));
    // Пользователь передумал и ушёл в другое поле: проверка отменяется.
    h.handlers.keydown({ key: "a" });
    h.doc.activeElement = other;
    h.flush();
    assert.strictEqual(field.focused, 0, "охрана вернула фокус после того, как человек начал печатать");
    assert.strictEqual(h.reports.length, 0, "охрана рассказала о краже, которой не было");
  });

  await test("свидетель фокуса: стек вызова показывает, какая строка забрала фокус", () => {
    const trace = FieldGuard.makeTrace(3);
    const proto = { focus() {} };
    const win = { HTMLElement: { prototype: proto } };
    assert.strictEqual(FieldGuard.hookFocus(win, trace), true, "перехват focus не встал");
    assert.strictEqual(FieldGuard.hookFocus(win, trace), false, "повторный перехват focus не должен дублироваться");
    const el = fakeEl("div", { id: "sp-tasks" });
    const mark = trace.mark(); // метка «человек кликнул здесь»
    proto.focus.call(el);
    assert.strictEqual(trace.items.length, 1, "вызов focus не записан");
    assert.strictEqual(trace.items[0].el, el, "записан не тот узел");
    assert.ok(Array.isArray(trace.items[0].stack), "у записи нет стека вызова");
    assert.ok(trace.items[0].stack.length >= 1, "стек вызова пуст — виновника по коду не найти");
    assert.ok(trace.items[0].stack.some((f) => /field-guard\.test\.js/.test(f)), "в стеке нет вызывающей строки");
    // Ищем вора только после метки клика и только не своё поле.
    assert.ok(trace.lastAfter(mark, el) === null, "своё же поле записано вором");
    assert.ok(trace.lastAfter(mark, fakeEl("div")) !== null, "вор после клика не найден");
    assert.ok(trace.lastAfter(trace.mark() + 1, null) === null, "вор найден там, где фокуса никто не трогал");
    // Кольцо не растёт бесконечно: держим только последние записи.
    for (let i = 0; i < 10; i++) trace.push("focus", el, []);
    assert.strictEqual(trace.items.length, 3, "свидетель копит записи без предела");
  });

  await test("свидетель фокуса: виновника выбирает порядок вызовов, а не часы", () => {
    // Часы идут назад — так бывает при переводе времени и коррекции NTP. Сравнивать
    // вызовы по времени нельзя: тот, кто звал фокус ДО клика, оказался бы «после»,
    // и охрана обвинила бы не того (в бою — тост с чужим именем и чужим стеком).
    const times = [5000, 4000, 3000, 2000];
    let i = 0;
    const trace = FieldGuard.makeTrace(5, () => times[Math.min(i++, times.length - 1)]);
    const beforeEl = layerEl("div", { id: "sp-plan" });
    const afterEl = layerEl("div", { id: "sp-tasks" });
    trace.push("focus", beforeEl, ["до клика"]);
    const mark = trace.mark(); // здесь человек кликнул по полю
    trace.push("focus", afterEl, ["после клика"]);
    // Часы действительно подменены: без этой сверки тест молча проверял бы не
    // порядок вызовов, а удачное совпадение времени (мутация «часы игнорируются»
    // ровно так и проходила незамеченной).
    assert.deepStrictEqual(
      trace.items.map((it) => it.at),
      [5000, 4000],
      "свидетель не берёт переданные часы — сверка порядка вызовов ничего не проверяет"
    );

    const hit = trace.lastAfter(mark, null);
    assert.ok(hit && hit.el === afterEl, "виновник выбран не по порядку вызовов: " + (hit && FieldGuard.describe(hit.el)));
    assert.deepStrictEqual(hit.stack, ["после клика"], "у виновника не тот стек вызова");
    // Обратная сторона: всё, что было до клика, виновником не считается.
    assert.ok(trace.lastAfter(trace.mark(), null) === null, "вызов до клика попал в виновники");
    // Кольцо свидетеля ограничено и с чужими часами.
    for (let k = 0; k < 9; k++) trace.push("focus", afterEl, []);
    assert.strictEqual(trace.items.length, 5, "свидетель копит записи без предела");
  });

  await test("свидетель фокуса: фокус, взятый ДО клика, виновником не считается", () => {
    const field = fieldEl();
    const earlier = layerEl("div", { id: "sp-plan" });
    const timers = [];
    const proto = { focus() {}, blur() {} };
    // Часы стоят: оба вызова попадают в одну «миллисекунду». Раньше охрана на
    // таком раскладе называла виновником того, кто звал фокус до клика — с чужим
    // стеком вызова, то есть указывала не на ту строку кода.
    const trace = FieldGuard.makeTrace(10, () => 1000);
    const h = harness([field], null, {
      body: { tagName: "BODY", nodeType: 1, children: [], classList: fakeClassList([]) },
      hasFocus: () => true,
      defaultView: {
        getComputedStyle: () => ({ pointerEvents: "auto" }),
        setTimeout: (fn) => timers.push(fn),
        HTMLElement: { prototype: proto },
      },
    }, { trace });

    proto.focus.call(earlier); // чужой обработчик трогал фокус до клика
    h.doc.activeElement = earlier;
    h.handlers.mousedown(fakeEvent(field));
    while (timers.length) timers.shift()();

    assert.strictEqual(h.reports.length, 1, "о пропавшем фокусе не рассказали");
    assert.strictEqual(h.reports[0].stack.length, 0, "в виновниках вызов, который был до клика: " + h.reports[0].why);
    assert.strictEqual(h.reports[0].who, earlier, "владелец фокуса назван неверно");
    assert.strictEqual(field.focused, 1, "фокус не вернулся в поле");
  });

  await test("декор: плашка поверх интерфейса становится прозрачной для мыши", () => {
    const view = { innerWidth: 1440, innerHeight: 900 };
    const fixed = () => ({ position: "fixed" });
    const toast = layerEl("div", { rect: { width: 520, height: 44 } });
    assert.strictEqual(FieldGuard.isDecoration(toast, fixed, view), true, "плашка-уведомление не распознана");
    // Окно, меню и всё живое клики обязаны получать.
    const overlay = layerEl("div", { className: "overlay", rect: { width: 1440, height: 900 } });
    assert.strictEqual(FieldGuard.isDecoration(overlay, fixed, view), false, "окно признано декором");
    const withBtn = layerEl("div", {
      className: "model-popup",
      rect: { width: 320, height: 120 },
      inside: (sel) => sel.indexOf("button") >= 0,
    });
    assert.strictEqual(FieldGuard.isDecoration(withBtn, fixed, view), false, "меню с кнопками признано декором");
    const gate = layerEl("div", { id: "mobile-gate", rect: { width: 1440, height: 900 } });
    assert.strictEqual(FieldGuard.isDecoration(gate, fixed, view), false, "подложка на весь экран признана декором");
    const pinned = layerEl("div", { className: "ask-panel", rect: { width: 400, height: 90 } });
    assert.strictEqual(FieldGuard.isDecoration(pinned, fixed, view), false, "панель с живым содержимым признана декором");
    const staticEl = layerEl("div", { rect: { width: 300, height: 30 } });
    assert.strictEqual(FieldGuard.isDecoration(staticEl, () => ({ position: "static" }), view), false, "обычный блок признан декором");
    const tall = layerEl("div", { rect: { width: 400, height: 700 } });
    assert.strictEqual(FieldGuard.isDecoration(tall, fixed, view), false, "высокая панель признана плашкой");
    assert.strictEqual(FieldGuard.isDecoration(null, fixed, view), false, "пустой узел признан декором");
  });

  await test("декор: подписка делает прозрачными и то, что добавят позже", () => {
    const view = { innerWidth: 1440, innerHeight: 900 };
    const makeWin = () => {
      let cb = null;
      const observed = [];
      function MObs(fn) {
        cb = fn;
        this.observe = (target, opts) => observed.push({ target, opts });
        this.disconnect = () => {
          cb = null;
        };
      }
      return {
        win: { innerWidth: view.innerWidth, innerHeight: view.innerHeight, getComputedStyle: () => ({ position: "fixed" }), MutationObserver: MObs },
        observed,
        fire: (nodes) => cb && cb([{ addedNodes: nodes }]),
        watched: () => !!cb,
      };
    };
    const env = makeWin();
    const existing = layerEl("div", { rect: { width: 400, height: 40 } });
    const body = { tagName: "BODY", nodeType: 1, children: [existing], classList: fakeClassList([]) };
    const doc = {
      body,
      defaultView: env.win,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const seen = [];
    const stop = FieldGuard.applyClickThrough(doc, { onDecoration: (el) => seen.push(el) });
    assert.strictEqual(existing.style.pointerEvents, "none", "плашка, лежавшая в body ко времени установки, осталась перехватчиком");
    assert.strictEqual(env.observed.length, 1, "наблюдение за новыми узлами не встало");
    const added = layerEl("div", { rect: { width: 500, height: 40 } });
    env.fire([added]);
    assert.strictEqual(added.style.pointerEvents, "none", "новая плашка осталась перехватчиком");
    assert.ok(added.style.maxWidth, "у плашки не ограничена ширина");
    assert.strictEqual(seen.length, 2, "о найденных плашках не рассказали");
    // Окно, добавленное позже, охрана не трогает.
    const popup = layerEl("div", { className: "model-popup", rect: { width: 300, height: 120 }, inside: (sel) => sel.indexOf("button") >= 0 });
    env.fire([popup]);
    assert.strictEqual(popup.style.pointerEvents, undefined, "живому меню выключили клики");
    stop();
    assert.strictEqual(env.watched(), false, "наблюдение не снято при отключении охраны");
  });

  await test("залипший режим перетаскивания снимается по окончанию жеста", () => {
    const classes = fakeClassList(["resizing-x", "dark"]);
    const doc = {
      body: { tagName: "BODY", nodeType: 1, classList: classes },
      addEventListener: () => {},
      removeEventListener: () => {},
      defaultView: { getComputedStyle: () => ({ pointerEvents: "auto" }) },
    };
    assert.deepStrictEqual(FieldGuard.clearStuckDrag(doc), ["resizing-x"], "залипший режим не снят");
    assert.ok(!classes.contains("resizing-x"), "класс остался на body");
    assert.ok(classes.contains("dark"), "охрана сняла чужой класс");
    assert.deepStrictEqual(FieldGuard.clearStuckDrag(doc), [], "снимать больше нечего, а ответ не пуст");
    assert.deepStrictEqual(FieldGuard.clearStuckDrag(null), [], "пустой документ должен ломать снятие режима");

    // И целиком через подписку: mouseup документа снимает залипший режим.
    const handlers = {};
    const live = {
      body: { tagName: "BODY", nodeType: 1, classList: fakeClassList(["resizing"]) },
      addEventListener: (n, fn) => {
        handlers[n] = fn;
      },
      removeEventListener: () => {},
      defaultView: { getComputedStyle: () => ({ pointerEvents: "auto" }) },
    };
    const off = FieldGuard.install(live, { report: () => {} });
    handlers.mouseup();
    assert.ok(!live.body.classList.contains("resizing"), "mouseup не снял залипший режим перетаскивания");
    off();
  });

  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();

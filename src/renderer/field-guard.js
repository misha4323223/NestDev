"use strict";

/* ─── Охрана живого интерфейса (field-guard) ─────────────────────────────────
   Жалоба: «нажимаю на поле — курсор не встаёт, текст не печатается; через какое-то
   время само отпускает». Первая версия ловила только один механизм — слой поверх
   поля, съевший клик. Но клик по полю может не дать фокуса и совсем иначе, и тогда
   охрана молчит. Разобранные механизмы:

     1) слой поверх поля — клик уходит в него (ловится сразу, elementsFromPoint);
     2) `pointer-events: none` у поля или предка — клик проходит сквозь;
     3) фокус у поля забрал кто-то ещё — обработчик клика или перерисовка по
        таймеру (список дел, план, журнал миссии перерисовываются целиком);
     4) поле перерисовали сразу после клика — узел исчез вместе с фокусом;
     5) окно приложения потеряло фокус (Electron) — в DOM всё «правильно», но
        каретка не мигает и клавиши уходят в другое окно;
     6) плашка-уведомление (тост) лежит над полем и ест клик ровно 2.6 с своей жизни.

   Отсюда три правила охраны:

   А. **Клик по полю обязан дать фокус.** Охрана ведёт свидетеля: перехватывает
      `HTMLElement.prototype.focus`, помнит, кто и откуда звал фокус, и после
      каждого клика по полю проверяет — фокус там? Если нет, называет виновника
      вместе со стеком вызова (видно строку кода), возвращает фокус и, если
      виновато окно, зовёт `window.focus()`.
   Б. **Декор не ест клики.** Плашка, добавленная поверх интерфейса и не
      содержащая ни одного живого элемента, становится «прозрачной» для мыши
      (`pointer-events: none`). Полноэкранные подложки, окна, меню и всё, внутри
      чего есть кнопка или поле, не трогаем — они клики обязаны получать.
   В. **Залипший режим перетаскивания снимается.** Если отпустить кнопку за
      пределами окна, `mouseup` не приходит и класс `resizing` остаётся на body
      навсегда (курсор col-resize и `user-select: none` во всём приложении).

   Правило А нарочно устроено так, чтобы охрана сама не стала поломкой: пока
   пользователь кликает по кнопкам, окнам и другим полям, она молчит; если после
   клика по полю нажали клавишу или кликнули ещё раз — проверка отменяется.
   Модуль разведён на чистые решения (stolenFieldClick / deadField / stolenFocus /
   isDecoration / describe) и подписку (install): решения проверяются тестами на
   игрушечном DOM, без окна. */

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.FieldGuard = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  // Поля, в которые человек печатает. Галочки/радио/слайдеры/файлы — не поля:
  // их нажатие работает без курсора ввода.
  const FIELD_SEL =
    'textarea, input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]), [contenteditable="true"]';

  // Элементы, которые сами берут фокус или нажатие: их клики не наши.
  const ACTION_SEL =
    'a[href], button, input, textarea, select, option, label, summary, [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], ' +
    '[role="switch"], [role="radio"], [role="combobox"], [role="textbox"], [role="searchbox"]';

  // Окна и меню поверх страницы: клик по ним — их клик, даже если под ними поле.
  const OVER_SEL =
    '.overlay, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], ' +
    ".role-popover, .model-popup, [data-field-guard]";

  // Имена, по которым сразу видно, что элемент обязан получать клики (окно,
  // подложка, меню). Это вторая страховка к OVER_SEL — на случай элемента без
  // класса .overlay, но с говорящим именем.
  const KEEP_NAMES = /overlay|backdrop|scrim|gate|modal|dialog|popup|menu|palette|panel|popover/i;

  // Сколько кликов и фокусов держим в памяти для разбора и сколько кадров стека
  // показываем. Стек нужен, чтобы виновника было видно строкой кода, а не «где-то».
  const TRACE_LIMIT = 40;
  const STACK_FRAMES = 4;
  // Декор — это узкая плашка, а не подложка на пол-экрана. Плашка выше/больше
  // этого предела считается подложкой: её клики трогать нельзя.
  const DECOR_MAX_H = 160;
  const DECOR_MAX_AREA = 0.3;

  function tagOf(el) {
    return String((el && (el.tagName || el.nodeName)) || "").toUpperCase();
  }

  // Короткое имя элемента: div#sp-tasks.tk-list — по нему видно, кто виноват.
  function describe(el) {
    if (!el) return "?";
    if (typeof el === "string") return el;
    const tag = tagOf(el).toLowerCase() || "?";
    const id = el.id ? "#" + el.id : "";
    let names = [];
    try {
      if (el.classList && typeof el.classList.length === "number" && el.classList.length) {
        names = Array.prototype.slice.call(el.classList, 0, 2);
      } else if (typeof el.className === "string") {
        names = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      }
    } catch {}
    return tag + id + (names.length ? "." + names.join(".") : "");
  }

  function canFocus(el) {
    return !!el && typeof el.focus === "function";
  }

  function matches(el, sel) {
    return !!(el && typeof el.matches === "function" && el.matches(sel));
  }

  function findIn(el, sel) {
    return !!(el && typeof el.querySelector === "function" && el.querySelector(sel));
  }

  // Стек вызова — короткими строками, без служебных кадров самого модуля.
  function stackOf(skip) {
    let out = "";
    try {
      out = String((new Error()).stack || "");
    } catch {}
    if (!out) return [];
    const lines = out.split("\n").slice(1 + (skip || 0));
    const frames = [];
    for (const raw of lines) {
      const line = raw.trim().replace(/^at\s+/, "");
      if (!line) continue;
      if (line.indexOf("field-guard.js") !== -1) continue; // свои кадры не показываем
      frames.push(line);
      if (frames.length >= STACK_FRAMES) break;
    }
    return frames;
  }

  // ── Свидетель: кто и откуда звал focus()/blur() ────────────────────────────
  // Протокол короткий: клик по полю берёт у свидетеля метку (`trace.mark()` в
  // pending.mark), а охранник, проверяя фокус, спрашивает: кто звал фокус ПОСЛЕ
  // этой метки? Это и есть вор.
  //
  // Сравнение идёт по ПОРЯДКУ вызовов (seq), а не по миллисекундам. На времени
  // это было решающей ошибкой сразу в двух местах: два вызова в одну
  // миллисекунду сравнивались случайно — то есть виновником мог оказаться тот,
  // кто звал фокус ДО клика (например, прошлый клик или чужой обработчик), а
  // настоящий вор — не назван. Проба на 3000 прогонов это подтвердила: вызов
  // «до клика» попадал в отчёт как вор в 2996 случаях из 3000, а тест был
  // зелёным лишь потому, что его собственные вызовы укладывались в одну
  // миллисекунду (на загруженной машине миллисекунда переключалась — и он падал).
  // Часы подменяемы (второй аргумент) — тестам это нужно, чтобы показать, что
  // порядок берётся из вызовов, а не из времени: с настоящими часами два вызова
  // подряд почти всегда в одну миллисекунду, и проверка была бы случайной.
  function makeTrace(limit, now) {
    const items = [];
    let seq = 0;
    const clock = typeof now === "function" ? now : Date.now;
    return {
      items,
      // Метка «сейчас»: сколько вызовов фокуса свидетель уже видел.
      mark() {
        return seq;
      },
      push(kind, el, stack) {
        seq += 1;
        items.push({ kind, el, stack: stack || [], seq, at: clock() });
        if (items.length > (limit || TRACE_LIMIT)) items.splice(0, items.length - (limit || TRACE_LIMIT));
      },
      // Последний вызов фокуса после метки — не считая самого поля, в которое
      // человек и кликнул.
      lastAfter(mark, notEl) {
        const m = Number(mark) || 0;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.seq <= m || it.el === notEl) continue;
          return it;
        }
        return null;
      },
    };
  }

  // Перехват focus/blur: без него «фокус забрал кто-то другой» остаётся загадкой.
  // Ставится ровно один раз на прототип (повторная загрузка модуля безопасна).
  function hookFocus(win, trace) {
    const proto = win && win.HTMLElement && win.HTMLElement.prototype;
    if (!proto || proto.__fieldGuardHooked) return false;
    try {
      const origFocus = proto.focus;
      const origBlur = proto.blur;
      proto.focus = function () {
        trace.push("focus", this, stackOf(1));
        return origFocus.apply(this, arguments);
      };
      if (typeof origBlur === "function") {
        proto.blur = function () {
          trace.push("blur", this, stackOf(1));
          return origBlur.apply(this, arguments);
        };
      }
      proto.__fieldGuardHooked = true;
      return true;
    } catch {
      return false;
    }
  }

  // Клик ушёл в слой поверх поля: он не по элементу, который сам берёт фокус, он
  // не по окну/меню, но под точкой клика лежит настоящее поле — его и ждал человек.
  function stolenFieldClick(target, stack) {
    if (!target || typeof target.closest !== "function") return null;
    if (target.closest(ACTION_SEL)) return null;
    if (target.closest(OVER_SEL)) return null;
    const list = Array.isArray(stack) ? stack : [];
    for (const el of list) {
      if (!el || el === target) continue;
      if (!matches(el, FIELD_SEL) || !canFocus(el)) continue;
      return { field: el, who: target, why: "слой поверх поля перехватил клик" };
    }
    return null;
  }

  // Поле не может принять клик само: у него или у предка pointer-events: none.
  // Свойство наследуется, поэтому у поля и у всех потомков виновника оно тоже
  // none: идём вверх до последнего «none» — это и есть настоящая причина.
  function deadField(target, styleOf) {
    if (!target || typeof target.closest !== "function") return null;
    const field = target.closest(FIELD_SEL);
    if (!field || !canFocus(field) || field.disabled) return null;
    if (typeof styleOf !== "function") return null;
    let guard = null;
    for (let el = field; el && el.nodeType === 1; el = el.parentElement) {
      let pe = "";
      try {
        const st = styleOf(el) || {};
        pe = String(st.pointerEvents || "");
      } catch {
        break;
      }
      if (pe !== "none") break;
      guard = el; // чем выше поднялись, тем точнее причина
    }
    if (!guard) return null;
    return { field: field, who: guard, why: "pointer-events: none у " + describe(guard) };
  }

  // ── Решение охранника: клик по полю остался без фокуса? ────────────────────
  // Именно этого не хватало первой версии. Здесь разбираются ВСЕ случаи, кроме
  // слоя поверх клика: вор в DOM, поле перерисовали, окно не в фокусе.
  function stolenFocus(clicked, active, opts) {
    opts = opts || {};
    if (!clicked || !canFocus(clicked)) return null;
    if (clicked.disabled) return null;              // у disabled фокуса и не может быть
    if (clicked.isConnected === false) return null; // поле исчезло — это перерисовка, не вор
    if (active === clicked) return null;            // фокус там, где и должен быть

    const doc = clicked.ownerDocument || {};
    const nowhere = !active || active === opts.bodyEl || active === doc.documentElement;
    if (opts.windowFocused === false) {
      // DOM тут ни при чём: клавиши уходят в другое окно. Лечится только фокусом окна.
      return { field: clicked, who: active || null, why: "окно приложения потеряло фокус", windowFocused: false, stack: [] };
    }
    if (nowhere) {
      return { field: clicked, who: null, why: "фокус ушёл в никуда (клик погасили или поле перерисовали)", windowFocused: true, stack: [] };
    }
    return { field: clicked, who: active, why: "фокус забрал " + describe(active), windowFocused: true, stack: [] };
  }

  // ── Декор поверх интерфейса не имеет права съесть клик ─────────────────────
  // Плашка-уведомление (тост) — обычный div поверх чата: у неё нет ни кнопок, ни
  // полей, живёт она 2.6 с, но клик в её полосе забирает себе, и человек видит
  // «нажимаю на поле, а курсор не встаёт». Такой элемент переводим в
  // pointer-events: none. Окна, меню, подложки и всё, внутри чего есть живой
  // элемент, остаются как были: они клики обязаны получать.
  function isDecoration(el, styleOf, view) {
    if (!el || el.nodeType !== 1) return false;
    if (matches(el, OVER_SEL) || findIn(el, OVER_SEL)) return false;
    if (matches(el, ACTION_SEL) || findIn(el, ACTION_SEL)) return false;
    const name = String(el.id || "") + " " + String(el.className || "");
    if (KEEP_NAMES.test(name)) return false;
    let pos = "";
    try {
      pos = String(((styleOf ? styleOf(el) : null) || {}).position || "");
    } catch {
      return false;
    }
    if (pos !== "fixed" && pos !== "absolute") return false;
    let h = 0;
    let area = 0;
    try {
      const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      if (r) {
        h = Math.round(r.height || 0);
        const vw = (view && view.innerWidth) || 0;
        const vh = (view && view.innerHeight) || 0;
        if (vw && vh) area = ((r.width || 0) * h) / (vw * vh);
      }
    } catch {}
    if (h > DECOR_MAX_H || area > DECOR_MAX_AREA) return false; // это подложка, не плашка
    return true;
  }

  // Применение: и то, что уже лежит в body, и то, что добавят позже.
  function applyClickThrough(doc, opts) {
    opts = opts || {};
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    if (!doc.body) return function () {};
    const styleOf = (el) =>
      win && typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : { position: "" };
    // WeakSet, а не Set: плашки живут по пару секунд и убираются из body, а охрана
    // работает часами — держать ссылки на удалённые узлы ей незачем.
    const done = new WeakSet();
    const fix = (el) => {
      if (!el || done.has(el)) return null;
      if (!isDecoration(el, styleOf, win)) return null;
      done.add(el);
      try {
        el.style.pointerEvents = "none";
        el.style.userSelect = "none";
        if (!el.style.maxWidth) el.style.maxWidth = "min(520px, 86vw)";
        if (!el.style.textAlign) el.style.textAlign = "center";
      } catch {
        return null;
      }
      if (typeof opts.onDecoration === "function") {
        try {
          opts.onDecoration(el);
        } catch {}
      }
      return el;
    };
    for (const child of Array.prototype.slice.call(doc.body.children || [])) fix(child);
    let obs = null;
    const MObs = win && win.MutationObserver;
    if (typeof MObs === "function") {
      obs = new MObs((records) => {
        for (const rec of records || []) {
          for (const node of Array.prototype.slice.call(rec.addedNodes || [])) fix(node);
        }
      });
      try {
        obs.observe(doc.body, { childList: true });
      } catch {}
    }
    return function stop() {
      if (obs && typeof obs.disconnect === "function") obs.disconnect();
    };
  }

  // ── Залипший режим перетаскивания ──────────────────────────────────────────
  // Ресайзеры панелей включают body.resizing / body.resizing-x на mousedown, а
  // снимают на mouseup документа. Отпустили кнопку за окном — mouseup не пришёл,
  // и класс остаётся на body навсегда: во всём приложении курсор col-resize и
  // `user-select: none`. Снимаем эти классы по любому окончанию жеста.
  const STUCK_MODES = ["resizing", "resizing-x"];
  function clearStuckDrag(doc) {
    if (!doc || !doc.body || !doc.body.classList) return [];
    const cleared = [];
    for (const name of STUCK_MODES) {
      if (doc.body.classList.contains(name)) {
        doc.body.classList.remove(name);
        cleared.push(name);
      }
    }
    return cleared;
  }

  function focusField(field) {
    if (!canFocus(field)) return false;
    try {
      field.focus();
      return true;
    } catch {
      return false;
    }
  }

  // Текст для человека: что случилось, кто виноват и какой строкой кода.
  function reportText(info) {
    if (!info) return "";
    let out = "⚠ Клик по полю " + describe(info.field) + " не дал фокуса: " + info.why;
    if (info.who) out += " → " + describe(info.who);
    if (info.stack && info.stack.length) out += "\n   " + info.stack.join("\n   ");
    return out;
  }

  // Рассказ о перехвате: в консоль (для разбора) и тостом, если интерфейс его дал
  // (app.js выставляет window.uiToast). Частота ограничена — один рассказ на случай.
  function report(info) {
    if (!info) return;
    const text = reportText(info);
    try {
      console.warn("[field-guard] " + text);
    } catch {}
    try {
      if (!Array.isArray(root.__focusLog)) root.__focusLog = [];
      const log = root.__focusLog;
      log.push({ at: Date.now(), why: info.why, field: describe(info.field), who: describe(info.who), stack: info.stack || [] });
      if (log.length > 50) log.splice(0, log.length - 50);
    } catch {}
    try {
      const toast = root && root.uiToast;
      if (typeof toast === "function") toast(text.split("\n")[0]);
    } catch {}
  }

  // Подписка. Возвращает функцию отключения (нужна тестам и перезапуску окна).
  function install(doc, opts) {
    opts = opts || {};
    const tell = typeof opts.report === "function" ? opts.report : report;
    if (!doc || typeof doc.addEventListener !== "function") return function () {};
    const win = doc.defaultView || (typeof window !== "undefined" ? window : null);
    const styleOf = (el) =>
      win && typeof win.getComputedStyle === "function" ? win.getComputedStyle(el) : { pointerEvents: "" };

    // Свидетель фокуса: живёт на прототипе окна, поэтому заводится один раз, а
    // конкретная подписка только берёт его в работу.
    const trace = opts.trace || makeTrace(TRACE_LIMIT);
    if (win) {
      hookFocus(win, trace);
      try {
        root.__focusTrace = trace;
        if (!Array.isArray(root.__focusLog)) root.__focusLog = [];
        if (typeof root.focusReport !== "function") {
          root.focusReport = function () {
            const log = root.__focusLog || [];
            return log.length ? log.map((r) => reportText(r)).join("\n") : "Перехватов фокуса не записано.";
          };
        }
      } catch {}
    }

    let lastReport = 0;
    const say = (info) => {
      const now = Date.now();
      if (now - lastReport < 5000) return; // не заваливаем тостами
      lastReport = now;
      try {
        tell(info);
      } catch {}
    };

    // Лечение: фокус возвращаем полю. Для окна — зовём фокус окна (внутри клика
    // это разрешено браузером и в Electron действительно поднимает окно).
    const heal = (info) => {
      if (info.windowFocused === false) {
        try {
          if (win && typeof win.focus === "function") win.focus();
        } catch {}
        return;
      }
      focusField(info.field);
    };

    const solve = (info, e) => {
      heal(info);
      // Клик был не по тому слою, который его получил: гасим его, иначе под полем
      // сработала бы кнопка, на которую человек не нажимал.
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      if (e && typeof e.stopPropagation === "function") e.stopPropagation();
      say(info);
      return info;
    };

    // Проверка после клика по полю: фокус доехал? Ждём две попытки — сразу (клик
    // уже обработан) и через 150 мс (перерисовка по таймеру крадёт фокус позже).
    let pending = null;
    const verify = () => {
      const p = pending;
      if (!p || p.done) return null;
      const active = doc.activeElement || null;
      const windowFocused = typeof doc.hasFocus === "function" ? doc.hasFocus() : true;
      const info = stolenFocus(p.field, active, { windowFocused: windowFocused, bodyEl: doc.body });
      if (!info) {
        p.done = true;
        return null;
      }
      // Кто звал фокус после нашего клика — это и есть вор (со стеком вызова).
      const traceHit = trace.lastAfter(p.mark, p.field);
      if (traceHit && traceHit.el) {
        info.who = traceHit.el;
        info.stack = traceHit.stack || [];
        if (info.windowFocused) info.why = "фокус забрал " + describe(info.who);
      }
      heal(info);
      say(info);
      p.done = true;
      return info;
    };

    const onDown = (e) => {
      if (!e || e.button !== 0 || e.defaultPrevented) return null;
      clearStuckDrag(doc); // жест начался заново — старый режим перетаскивания не наш
      const target = e.target;
      if (!target || typeof target.closest !== "function") return null;
      const dead = deadField(target, styleOf);
      if (dead) return solve(dead, e);
      const stack =
        typeof doc.elementsFromPoint === "function" ? doc.elementsFromPoint(e.clientX, e.clientY) : [];
      const stolen = stolenFieldClick(target, stack);
      if (stolen) return solve(stolen, e);
      // Клик по самому полю — самый частый случай. Ничего не гасим (иначе сломали
      // бы выделение текста мышью), но проверяем, что фокус реально доехал.
      const field = target.closest(FIELD_SEL);
      if (field && !field.disabled) {
        pending = { field, mark: trace.mark(), done: false };
        const token = pending;
        // Браузер отдаёт фокус полю ПОСЛЕ обработчиков mousedown, поэтому проверка
        // имеет смысл только отложенная — из самого обработчика она всегда была бы
        // ложной тревогой. Без таймеров (их нет только в игрушечном окружении)
        // охрана молчит, а не дёргает фокус зря.
        if (win && typeof win.setTimeout === "function") {
          win.setTimeout(() => {
            if (pending === token) verify();
          }, 0);
          win.setTimeout(() => {
            if (pending === token) verify();
          }, 150);
        }
      }
      return null;
    };

    // Пользователь передумал: кликнул по другому месту или начал печатать с
    // клавиатуры — проверка отменяется, чтобы охрана не тянула фокус назад.
    const cancel = () => {
      if (pending) pending.done = true;
      pending = null;
    };
    const onGestureEnd = () => {
      clearStuckDrag(doc);
    };

    doc.addEventListener("mousedown", onDown, true);
    doc.addEventListener("keydown", cancel, true);
    doc.addEventListener("mouseup", onGestureEnd, true);
    doc.addEventListener("pointerup", onGestureEnd, true);
    if (win && typeof win.addEventListener === "function") win.addEventListener("blur", onGestureEnd);
    const stopDecor = applyClickThrough(doc, opts);

    return function uninstall() {
      if (typeof doc.removeEventListener === "function") {
        doc.removeEventListener("mousedown", onDown, true);
        doc.removeEventListener("keydown", cancel, true);
        doc.removeEventListener("mouseup", onGestureEnd, true);
        doc.removeEventListener("pointerup", onGestureEnd, true);
      }
      if (win && typeof win.removeEventListener === "function") win.removeEventListener("blur", onGestureEnd);
      stopDecor();
    };
  }

  // Самоподключение: защита встаёт сразу при загрузке модуля — страницу об этом
  // просить не надо, а порядок загрузки скриптов перестаёт быть хрупким. Повторная
  // загрузка (OTA-бандл, двойной тег) ставит защиту ровно один раз.
  function autoInstall() {
    if (typeof document === "undefined" || !document) return null;
    if (root.__fieldGuardInstalled) return null;
    root.__fieldGuardInstalled = true;
    return install(document);
  }

  const api = {
    install,
    autoInstall,
    report,
    reportText,
    describe,
    stackOf,
    makeTrace,
    hookFocus,
    applyClickThrough,
    clearStuckDrag,
    stolenFieldClick,
    deadField,
    stolenFocus,
    isDecoration,
    FIELD_SEL,
    ACTION_SEL,
    OVER_SEL,
  };

  if (typeof document !== "undefined" && document) {
    if (document.readyState === "loading" && typeof document.addEventListener === "function") {
      document.addEventListener("DOMContentLoaded", autoInstall);
    } else {
      autoInstall();
    }
  }

  return api;
});

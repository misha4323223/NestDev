"use strict";

/* ─── Функции, выполняющиеся ВНУТРИ страницы ─────────────────────────────────
   Вынесено из browser-tools.js (часть 39). Здесь только функции, которые
   Playwright исполняет в самой странице: их передают в page.evaluate по ссылке
   (page.evaluate(scrollStateInPage, …)) или вклеивают по .toString()
   (evalValueToPlain). Поэтому они НЕ берут ничего из замыкания модуля —
   только window/document и свои аргументы. Обычный Node-модуль, зависимостей нет.

   varValueInPage зовёт evalValueToPlain — они обязаны жить вместе (обе уезжают
   в страницу), поэтому и лежат в одном файле.
*/

// Идея: агент НЕ должен угадывать селекторы. Страница сама отдаёт карту —
// нумерованные ссылки (ref) с ролью и видимым именем; дальше агент действует
// по ref. Функция выполняется ВНУТРИ страницы, поэтому не ссылается ни на что
// снаружи — только DOM (её же использует тест с мини-DOM).
function collectInPage() {
  const SEL =
    "a[href],button,input,select,textarea,summary,[role],[contenteditable],[onclick],[tabindex]";
  // Слои ПОВЕРХ страницы: диалоги Angular Material (консоль Google Cloud, банки),
  // модальные окна, окно перевода Google. Раньше карта их не видела (диалог
  // дописывается в конец <body> и отрезался лимитом строк), а клик падал на
  // проверке «элемент под курсором». Теперь такие элементы идут ПЕРВЫМИ и
  // помечены — с ними и надо работать, они перекрывают всю страницу.
  const OVERLAY_SEL =
    ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true]," +
    "dialog[open],mat-dialog-container,.mat-mdc-dialog-container,.modal,.modal-dialog," +
    ".goog-te-banner-frame,#goog-gt-tt,.skiptranslate";
  const w = window;
  if (!w.__aiAgentRefSeq) w.__aiAgentRefSeq = 0;

  // Дерево обходим с заходом в shadow DOM: сайты на веб-компонентах держат кнопки
  // внутри shadow-root, и обычный querySelectorAll их не находит.
  const roots = [{ root: document, depth: 0 }];
  const nodes = [];
  for (let ri = 0; ri < roots.length && roots.length < 40; ri++) {
    const entry = roots[ri];
    let found = [];
    try { found = entry.root.querySelectorAll(SEL); } catch (e) { found = []; }
    for (let k = 0; k < found.length; k++) {
      const el = found[k];
      nodes.push(el);
      try {
        if (entry.depth < 3 && el.shadowRoot) roots.push({ root: el.shadowRoot, depth: entry.depth + 1 });
      } catch (e) {}
    }
  }
  const items = [];
  const overlayHosts = [];

  // Ближайший overlay-контейнер элемента + его человеческое имя («Welcome …»).
  const overlayOf = (el) => {
    let host = null;
    try { host = el.closest ? el.closest(OVERLAY_SEL) : null; } catch (e) { host = null; }
    if (!host) {
      // Shadow DOM: closest не выходит за границу корня — идём по хостам вверх.
      try {
        let r = el.getRootNode ? el.getRootNode() : null;
        let guard = 0;
        while (r && r.host && !host && guard++ < 10) {
          host = r.host.closest ? r.host.closest(OVERLAY_SEL) : null;
          r = r.host.getRootNode ? r.host.getRootNode() : null;
        }
      } catch (e) {}
    }
    if (!host) return null;
    let name = "";
    try { name = host.getAttribute("aria-label") || ""; } catch (e) {}
    if (!name) {
      try {
        const h = host.querySelector("[role=heading],h1,h2,h3,h4,h5,h6");
        if (h) name = h.innerText || h.textContent || "";
      } catch (e) {}
    }
    if (!name) {
      try {
        name = String(host.innerText || host.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      } catch (e) {}
    }
    if (overlayHosts.indexOf(host) < 0 && overlayHosts.length < 8) {
      overlayHosts.push(host);
      overlayHosts[host] = String(name).replace(/\s+/g, " ").trim().slice(0, 80);
    }
    return { host: host, name: String(name).replace(/\s+/g, " ").trim().slice(0, 80) };
  };

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const tag = (el.tagName || "").toLowerCase();
    const elAttr = (x) => { try { return el.getAttribute(x) || ""; } catch (e) { return ""; } };
    const type = (elAttr("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
    const tiny = !rect || rect.width < 1 || rect.height < 1;
    let style = null;
    try { style = w.getComputedStyle(el); } catch (e) {}
    const overlay = overlayOf(el);
    const roleAttr0 = (elAttr("role") || "").toLowerCase();
    // Галочка — это не «мусорный» элемент: у Angular Material настоящий <input
    // type=checkbox> прозрачный (opacity: 0), а видно стилизованный квадратик.
    // Такой ввод берём в карту, но помечаем: по нему нужен force-клик.
    const isCheck =
      (tag === "input" && (type === "checkbox" || type === "radio")) ||
      roleAttr0 === "checkbox" || roleAttr0 === "radio" || roleAttr0 === "switch";
    if (style && (style.visibility === "hidden" || style.display === "none")) continue;
    if (tiny && !isCheck) continue;
    if (style && style.opacity === "0" && !isCheck) continue;
    const peNone = !!(style && style.pointerEvents === "none");
    if (peNone && !(overlay && (isCheck || tag === "button" || tag === "a" || roleAttr0))) continue;
    const hiddenInput = isCheck && !!style && (style.opacity === "0" || tiny);
    let ref = el.getAttribute("data-agent-ref");
    if (!ref) {
      w.__aiAgentRefSeq += 1;
      ref = "e" + w.__aiAgentRefSeq;
      el.setAttribute("data-agent-ref", ref);
    }
    const attr = (n) => el.getAttribute(n) || "";
    let labelledby = "";
    const lb = attr("aria-labelledby");
    if (lb) {
      labelledby = lb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? (n.innerText || n.textContent || "") : "";
        })
        .join(" ")
        .trim();
    }
    let labelText = "";
    try {
      if (el.labels && el.labels.length) {
        for (let j = 0; j < el.labels.length; j++) {
          labelText += " " + (el.labels[j].innerText || el.labels[j].textContent || "");
        }
      } else if (el.closest) {
        const p = el.closest("label");
        if (p) labelText = p.innerText || p.textContent || "";
      }
    } catch (e) {}
    let text = "";
    try { text = el.innerText || el.textContent || ""; } catch (e) {}
    const cls = typeof el.className === "string" ? el.className : "";
    items.push({
      inDialog: !!overlay,
      dialogName: overlay ? overlay.name : "",
      hiddenInput: hiddenInput,
      peNone: peNone,
      ref,
      tag,
      type,
      roleAttr: attr("role").toLowerCase(),
      contenteditable:
        el.isContentEditable === true || attr("contenteditable") === "true" || attr("contenteditable") === "",
      onclick: !!el.onclick || !!attr("onclick"),
      tabindex: el.getAttribute("tabindex"),
      href: tag === "a" ? attr("href") : "",
      disabled: el.disabled === true || attr("aria-disabled") === "true",
      checked: el.checked === true,
      ariaLabel: attr("aria-label"),
      labelledby,
      labelText,
      text: String(text).replace(/\s+/g, " ").trim().slice(0, 160),
      // Значения полей НЕ собираем: там бывают пароли, коды 2FA и личные данные.
      // Исключение — подписи кнопок-<input>: value и есть видимое имя кнопки.
      value:
        tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image")
          ? attr("value")
          : "",
      placeholder: attr("placeholder"),
      title: attr("title"),
      alt: attr("alt"),
      nameAttr: tag === "input" || tag === "select" || tag === "textarea" ? attr("name") : "",
      id: attr("id"),
      cls: String(cls).replace(/\s+/g, " ").trim().slice(0, 80),
      inViewport:
        rect.bottom > 0 && rect.top < (w.innerHeight || 0) && rect.right > 0 && rect.left < (w.innerWidth || 0),
    });
    if (items.length >= 400) break;
  }
  // Сводка по слоям: имя, класс и текст (по тексту классифицируем — согласие,
  // cookie, окно перевода). Текст обрезаем: он уходит агенту в контекст.
  const overlays = [];
  for (let i = 0; i < overlayHosts.length; i++) {
    const h = overlayHosts[i];
    let text = "";
    try { text = String(h.innerText || h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500); } catch (e) {}
    let hcls = "";
    try { hcls = typeof h.className === "string" ? h.className : ""; } catch (e) {}
    overlays.push({
      name: overlayHosts[h] || "",
      text: text,
      cls: hcls.replace(/\s+/g, " ").trim().slice(0, 120),
      tag: (h.tagName || "").toLowerCase(),
    });
  }
  return { url: location.href, title: document.title || "", items, overlays };
}

// Выполняется В СТРАНИЦЕ (исходник вклеивается в запрос): привести значение к
// тому, что реально проходит через мост. Playwright отдаёт undefined для
// несериализуемых значений — DOM-узел, Map, объект с циклами, bigint — и агент
// читал «ничего не вернуло» там, где код отработал и значение было.
function evalValueToPlain(v) {
  try {
    if (v === undefined) return { __p: "undef" };
    const ty = typeof v;
    if (v === null || ty === "string" || ty === "number" || ty === "boolean") return { __p: "json", v: v };
    if (ty === "bigint" || ty === "symbol" || ty === "function") return { __p: "text", s: String(v) };
    if (ty === "object" && v.nodeType === 1) return { __p: "text", s: String(v.outerHTML || "") };
    if (ty === "object" && (v.nodeType === 3 || v.nodeType === 8)) return { __p: "text", s: String(v.textContent || v.nodeValue || "") };
    if (Array.isArray(v)) {
      try {
        return { __p: "text", s: JSON.stringify(v) };
      } catch (e) {
        return { __p: "text", s: "[массив " + v.length + " элементов, но внутри есть объекты с циклами — верни примитивы: .length, Array.from(…).map(x => x.id)]" };
      }
    }
    if (v instanceof Map) return { __p: "text", s: JSON.stringify(Array.from(v.entries())) };
    if (v instanceof Set) return { __p: "text", s: JSON.stringify(Array.from(v)) };
    try {
      return { __p: "text", s: JSON.stringify(v) };
    } catch (e) {
      return { __p: "text", s: "[объект с циклами — верни примитивы: Object.keys(…), v.id, v.length]" };
    }
  } catch (e) {
    return { __p: "text", s: "[значение не удалось привести к тексту: " + String((e && e.message) || e) + "]" };
  }
}

// Разворачивает ответ сериализатора: {__p:"undef"} → undefined, {__p:"json", v}
// → значение, {__p:"text", s} → текст. Остальное — как есть (код со своим return
// возвращает значение напрямую).
function unwrapEvalValue(value) {
  if (!value || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (value.__p === "undef" && keys.length === 1) return undefined;
  if (value.__p === "json" && keys.length === 2 && "v" in value) return value.v;
  if (value.__p === "text" && keys.length === 2 && "s" in value) return value.s;
  return value;
}

// Выполняется В СТРАНИЦЕ: значение переменной, которую код записал сам (обычно
// window.__rows). Нужно, когда скрипт — набор операторов: он выполнился, ничего
// не вернул, а результат лежит в переменной. Без этого агент видел «ничего не
// вернуло» и считал, что код не сработал.
function varValueInPage(a) {
  a = a || {};
  const max = Math.max(200, Math.min(Number(a.max) || 4000, 40000));
  let v;
  try {
    v = (typeof window !== "undefined" ? window : globalThis)[String(a.name || "")];
  } catch (e) {
    return { found: false, error: String((e && e.message) || e) };
  }
  if (v === undefined) return { found: false };
  const plain = evalValueToPlain(v);
  const base = plain.s != null ? plain.s : typeof plain.v === "string" ? plain.v : plain.v === null ? "null" : JSON.stringify(plain.v);
  const text = String(base == null ? "" : base).slice(0, max);
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : v.nodeType === 1 ? "element" : typeof v;
  const length = Array.isArray(v) || typeof v === "string" || kind === "element" ? Number(v.length != null ? v.length : text.length) : text.length;
  return { found: true, kind: kind, text: text, length: length };
}

// Короткое описание значения для ответа агента: «42 элемента», «1200 символов».
function describeVar(v) {
  if (!v || !v.found) return "пусто";
  if (v.kind === "array") return v.length + " элементов";
  if (v.kind === "string") return v.length + " символов";
  if (v.kind === "element") return v.length + " символов разметки";
  return String(v.kind);
}

// Закрыть помехи: окно перевода Google, cookie-баннеры, «Понятно/Dismiss/позже».
// Юридические формулировки («Принять все», «Я согласен») НЕ нажимаются никогда —
// чтобы агент не подписывал за пользователя то, что не просили.
function cleanupInPage() {
  const report = [];
  const hide = (el, why) => {
    try {
      el.style.display = "none";
      el.setAttribute("data-agent-dismissed", "1");
      report.push(why);
    } catch (e) {}
  };
  const tr = document.querySelectorAll(
    "iframe.goog-te-banner-frame,.goog-te-banner-frame,#goog-gt-tt,.goog-te-balloon-frame"
  );
  for (let i = 0; i < tr.length; i++) hide(tr[i], "скрыто: " + (tr[i].tagName || "элемент").toLowerCase() + " перевода");
  try { document.body.style.top = "0"; } catch (e) {}
  const SAFE = [
    "не сейчас", "позже", "закрыть", "понятно", "хорошо", "ок", "пропустить", "больше не показывать",
    "dismiss", "close", "not now", "no thanks", "maybe later", "got it", "ok", "skip",
  ];
  const LAYER =
    ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true]," +
    ".modal,.modal-dialog,.goog-te-banner-frame,#goog-gt-tt,[class*=banner],[class*=cookie],[class*=consent],[class*=notice],[style*=fixed]";
  const nodes = document.querySelectorAll("button,[role=button],a[href],span,div");
  let seen = 0;
  for (let i = 0; i < nodes.length && seen < 500; i++) {
    const el = nodes[i];
    const txt = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!txt || txt.length > 24) continue;
    seen++;
    if (SAFE.indexOf(txt) < 0) continue;
    let host = null;
    try { host = el.closest ? el.closest(LAYER) : null; } catch (e) {}
    if (!host) continue;
    try {
      el.click();
      report.push("нажато «" + txt + "»");
    } catch (e) {}
  }
  const crosses = document.querySelectorAll("[data-dismiss],[aria-label*=закрыть],[class*=close]");
  for (let i = 0; i < crosses.length && i < 6; i++) {
    const el = crosses[i];
    let host = null;
    try { host = el.closest ? el.closest(LAYER) : null; } catch (e) {}
    if (!host) continue;
    try {
      el.click();
      report.push("нажат крестик закрытия");
    } catch (e) {}
  }
  return report;
}

// Подтвердить юридическое согласие: отметить галочки в слое и нажать кнопку
// согласия. Вызывается только осознанно (acceptTerms), сообщение попадает в чат.
function acceptTermsInPage() {
  const report = [];
  const LAYER = ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true],.modal,.modal-dialog";
  const inLayer = (el) => {
    try { return !!(el.closest && el.closest(LAYER)); } catch (e) { return false; }
  };
  const boxes = document.querySelectorAll("input[type=checkbox],[role=checkbox],[role=switch]");
  for (let i = 0; i < boxes.length; i++) {
    const el = boxes[i];
    if (!inLayer(el)) continue;
    const on = el.checked === true || (el.getAttribute && el.getAttribute("aria-checked") === "true");
    if (on) continue;
    try {
      el.click();
      report.push("отмечена галочка");
    } catch (e) {}
  }
  const btns = document.querySelectorAll("button,[role=button],input[type=submit],a[href]");
  for (let i = 0; i < btns.length; i++) {
    const el = btns[i];
    if (!inLayer(el)) continue;
    const txt = String(el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!txt) continue;
    if (txt.indexOf("не соглас") === 0 || txt.indexOf("disagree") === 0) continue;
    const yes =
      txt.indexOf("agree") >= 0 || txt.indexOf("соглас") >= 0 || txt.indexOf("принять") >= 0 ||
      txt.indexOf("продолжить") >= 0 || txt.indexOf("accept") >= 0 || txt.indexOf("continue") >= 0;
    if (!yes) continue;
    try {
      el.click();
      report.push("нажата кнопка «" + txt.slice(0, 40) + "»");
      break;
    } catch (e) {}
  }
  return report;
}

// Состояние прокрутки страницы и её внутренних контейнеров: SPA часто скроллят
// не body, а собственный блок — без этого «прокрутил, а ничего не сдвинулось».
function scrollStateInPage() {
  const de = document.scrollingElement || document.documentElement;
  const inner = [];
  const nodes = document.querySelectorAll("div,ul,ol,section,main,article,table,tbody,aside,nav");
  for (let i = 0; i < nodes.length && inner.length < 3; i++) {
    const el = nodes[i];
    const st = getComputedStyle(el);
    if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40) {
      inner.push({
        cls: String(el.className || "").replace(/\s+/g, ".").slice(0, 40),
        top: Math.round(el.scrollTop),
        max: Math.round(el.scrollHeight - el.clientHeight),
      });
    }
  }
  const vh = window.innerHeight || 800;
  return {
    y: Math.round(window.scrollY || de.scrollTop || 0),
    max: Math.round(Math.max(0, de.scrollHeight - vh)),
    vh: vh,
    docH: Math.round(de.scrollHeight),
    inner: inner,
  };
}

// Прокрутить страницу (или самый большой внутренний контейнер, если body не скроллится).
function scrollPageInPage(a) {
  a = a || {};
  const dy = Math.round(Number(a.dy) || 0);
  const dx = Math.round(Number(a.dx) || 0);
  const how = String(a.how || "down");
  const de = document.scrollingElement || document.documentElement;
  const vh = window.innerHeight || 800;
  const pickBiggest = () => {
    let best = null;
    let bestRoom = 0;
    const nodes = document.querySelectorAll("div,ul,ol,section,main,article,table,tbody,aside");
    for (const el of nodes) {
      const st = getComputedStyle(el);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40) {
        const room = el.scrollHeight - el.clientHeight;
        if (room > bestRoom) { bestRoom = room; best = el; }
      }
    }
    return best;
  };
  const useWindow = !!de && de.scrollHeight > vh + 4;
  const box = useWindow ? de : pickBiggest();
  if (!box) return { moved: 0, mode: "прокрутки нет", y: 0, max: 0 };
  const isWin = box === de;
  const before = isWin ? window.scrollY || de.scrollTop : box.scrollTop;
  if (how === "top") {
    if (isWin) window.scrollTo(window.scrollX || 0, 0);
    else box.scrollTop = 0;
  } else if (how === "bottom") {
    if (isWin) window.scrollTo(window.scrollX || 0, de.scrollHeight);
    else box.scrollTop = box.scrollHeight;
  } else if (isWin) {
    window.scrollBy(dx, dy);
  } else {
    box.scrollTop = Math.max(0, box.scrollTop + dy);
    if (dx) box.scrollLeft = Math.max(0, box.scrollLeft + dx);
  }
  const after = isWin ? window.scrollY || de.scrollTop : box.scrollTop;
  return {
    moved: Math.round(after - before),
    mode: isWin ? "страница" : "внутренний контейнер",
    y: Math.round(after),
    max: Math.round(isWin ? Math.max(0, de.scrollHeight - vh) : box.scrollHeight - box.clientHeight),
  };
}

// Прокрутить сам элемент (или ближайший прокручиваемый родитель) — списки,
// выпадающие меню и таблицы со своим скроллом.
function scrollInnerInPage(a) {
  a = a || {};
  const el = a.self;
  if (!el) return { moved: 0, mode: "элемент не найден", y: 0, max: 0 };
  const dy = Math.round(Number(a.dy) || 0);
  const how = String(a.how || "down");
  const scrollable = (n) => {
    const st = getComputedStyle(n);
    return (st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 4;
  };
  let box = el;
  while (box && box !== document.body && box !== document.documentElement && !scrollable(box)) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) box = el;
  const before = box.scrollTop;
  if (how === "top") box.scrollTop = 0;
  else if (how === "bottom") box.scrollTop = box.scrollHeight;
  else box.scrollTop = Math.max(0, box.scrollTop + dy);
  return {
    moved: Math.round(box.scrollTop - before),
    mode: "контейнер",
    y: Math.round(box.scrollTop),
    max: Math.round(Math.max(0, box.scrollHeight - box.clientHeight)),
  };
}

// Наведение «по-настоящему»: hover ломается на перекрытых элементах, тогда
// события мыши шлём прямо в DOM (меню и тултипы раскрываются и так).
function hoverInPage(el) {
  if (!el) return false;
  for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }
  return true;
}

// Счётчики покоя: мутации DOM + запросы в полёте (ждут waitForIdle).
function idleStartInPage() {
  window.__aiIdle = window.__aiIdle || { mut: 0 };
  window.__aiIdle.mut = 0;
  try { if (window.__aiIdleObs) window.__aiIdleObs.disconnect(); } catch (e) {}
  const root = document.documentElement || document.body;
  window.__aiIdleObs = new MutationObserver(() => { window.__aiIdle.mut++; });
  if (root) {
    window.__aiIdleObs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  return true;
}

function idleTakeInPage() {
  const s = window.__aiIdle || { mut: 0 };
  const m = s.mut;
  s.mut = 0;
  return m;
}

function idleStopInPage() {
  try { if (window.__aiIdleObs) window.__aiIdleObs.disconnect(); } catch (e) {}
  window.__aiIdleObs = null;
  return true;
}

// Выполняется В СТРАНИЦЕ: повторяет запрос клиента его же куками и CORS.
async function fetchJsonInPage(a) {
  a = a || {};
  const method = String(a.method || "POST").toUpperCase();
  const opt = { method: method, credentials: "include", headers: a.headers || {} };
  let url = String(a.url || "");
  const body = a.body == null ? "" : String(a.body);
  if (method === "GET" || method === "HEAD") {
    if (body) url += (url.indexOf("?") < 0 ? "?" : "&") + body;
  } else if (body) {
    opt.body = body;
  }
  let res = null;
  let text = "";
  try {
    res = await fetch(url, opt);
  } catch (e) {
    return { error: "сеть или CORS: " + String((e && e.message) || e || "").slice(0, 200), url: url };
  }
  try { text = await res.text(); } catch (e) { text = ""; }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { ok: res.ok, status: res.status, url: url, json: json, text: String(text || "").slice(0, 1200) };
}

// Выполняется В СТРАНИЦЕ: сколько строк списка и их стабильные ключи.
// Ключ — href или id, а не текст: превью сообщения меняется от времени, и по нему
// один и тот же диалог считался бы новым (дубли при прокрутке туда-обратно).
function itemsKeyInPage(a) {
  a = a || {};
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll(String(a.item || ""))); } catch (e) { nodes = []; }
  const keys = [];
  const sample = [];
  for (const el of nodes) {
    let href = "";
    try {
      const link = el.querySelector ? el.querySelector("a[href]") : null;
      href = link ? String(link.getAttribute("href") || "") : "";
    } catch (e) {}
    let id = "";
    try {
      id = String(
        (el.getAttribute &&
          (el.getAttribute("data-peer-id") ||
            el.getAttribute("data-peer") ||
            el.getAttribute("data-id") ||
            el.getAttribute("data-uid"))) ||
          el.id ||
          ""
      );
    } catch (e) {}
    let first = "";
    try {
      first = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    } catch (e) {}
    const key = href || id || first;
    if (key) keys.push(key);
    if (sample.length < 8 && first) sample.push(first.slice(0, 40));
  }
  // Сколько строк ВСЕГО обещает сам список (aria-setsize): при виртуализации в DOM
  // живут только видимые ~16 узлов, и без этой цифры «остановился» выглядит как
  // «список кончился» — агент собирал 16 диалогов из 110 и считал работу готовой.
  let setsize = 0;
  for (const el of nodes) {
    try {
      const n = parseInt(el.getAttribute && el.getAttribute("aria-setsize"), 10) || 0;
      if (n > setsize) setsize = n;
    } catch (e) {}
  }

  const uniq = {};
  for (const k of keys) uniq[k] = 1;
  return { count: nodes.length, uniq: Object.keys(uniq).length, joined: keys.join("~"), sample: sample, setsize: setsize };
}

// Выполняется В СТРАНИЦЕ: прокрутить последнюю (или первую — при чтении вверх)
// строку списка в кадр. Подгрузку запускает именно это движение.
function scrollItemIntoViewInPage(a) {
  a = a || {};
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll(String(a.item || ""))); } catch (e) { nodes = []; }
  if (!nodes.length) return { ok: false, count: 0 };
  const el = a.up ? nodes[0] : nodes[nodes.length - 1];
  try {
    el.scrollIntoView({ block: a.up ? "start" : "end", inline: "nearest" });
  } catch (e) {
    try { el.scrollIntoView(); } catch (e2) { return { ok: false, count: nodes.length }; }
  }
  return { ok: true, count: nodes.length };
}

module.exports = {
  collectInPage,
  evalValueToPlain,
  unwrapEvalValue,
  varValueInPage,
  describeVar,
  cleanupInPage,
  acceptTermsInPage,
  scrollStateInPage,
  scrollPageInPage,
  scrollInnerInPage,
  hoverInPage,
  idleStartInPage,
  idleTakeInPage,
  idleStopInPage,
  fetchJsonInPage,
  itemsKeyInPage,
  scrollItemIntoViewInPage,
};
